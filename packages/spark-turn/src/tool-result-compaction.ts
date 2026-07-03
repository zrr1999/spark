/**
 * Central tool-result compaction policy.
 *
 * Compaction is profile-based and fail-safe: exact/verbatim tools pass
 * through unchanged; known status/log/diagnostic tools may normalize noisy
 * whitespace; unknown tools pass through until explicitly classified; and
 * compacted text is used only when it is shorter and non-empty.
 */

type ToolResultTextPart = { type: string; text?: string; [key: string]: unknown };

export type SparkToolOutputProfile = "exact" | "log" | "status" | "diagnostic";
export type SparkToolOutputCompactionLevel = "off" | "lite" | "full" | "ultra";

type CompactableProfile = Exclude<SparkToolOutputProfile, "exact">;

export interface SparkToolResultCompactionInput {
  toolName: string;
  args?: Record<string, unknown>;
  content: ToolResultTextPart[];
  level?: SparkToolOutputCompactionLevel;
}

export interface SparkToolResultCompactionDetails {
  profile: CompactableProfile;
  level: SparkToolOutputCompactionLevel;
  originalChars: number;
  compactedChars: number;
  trimmedLeadingBlankLines: number;
  trimmedTrailingBlankLines: number;
  collapsedBlankLines: number;
  collapsedBlankRuns: number;
  collapsedRepeatedLines: number;
  collapsedRepeatedRuns: number;
}

export interface SparkToolResultRawRecoveryDecisionInput {
  toolName: string;
  isError?: boolean;
  compaction: SparkToolResultCompactionDetails | undefined;
}

export interface SparkToolResultRawRecoveryDecision {
  record: boolean;
  reason?: "lossy_compaction" | "error_compaction";
  omittedChars?: number;
}

export interface SparkToolResultCompactionResult {
  content: ToolResultTextPart[];
  details?: SparkToolResultCompactionDetails;
}

interface ToolOutputProfileRule {
  profile: SparkToolOutputProfile;
  tools: readonly string[];
}

const TOOL_OUTPUT_PROFILE_RULES: readonly ToolOutputProfileRule[] = [
  {
    profile: "exact",
    tools: ["read", "graft_read", "memory_read", "fetch_content", "get_search_content"],
  },
  {
    profile: "log",
    tools: [
      "cue_exec",
      "cue_run",
      "cue_script",
      "script_run",
      "script_eval",
      "cue_jobs",
      "cue_scope",
      "cue_history",
      "graft_cli_exec",
    ],
  },
  { profile: "diagnostic", tools: ["spark_diagnostic"] },
  {
    profile: "status",
    tools: [
      "ask",
      "assign",
      "drive",
      "edit",
      "find",
      "goal",
      "graft_admit",
      "graft_candidate_from_scratch",
      "graft_candidates",
      "graft_delete",
      "graft_doctor",
      "graft_edit",
      "graft_evidence",
      "graft_init",
      "graft_materialize",
      "graft_ps",
      "graft_repo",
      "graft_scratch_diff",
      "graft_scratch_drop",
      "graft_scratch_open",
      "graft_scratch_pin",
      "graft_scratch_unpin",
      "graft_search",
      "graft_show",
      "graft_status",
      "graft_validate",
      "graft_write",
      "grep",
      "learning",
      "loop",
      "ls",
      "models",
      "phase",
      "recall",
      "role",
      "task_read",
      "task_write",
      "workflow",
      "workflow_run",
      "write",
    ],
  },
];

const TOOL_OUTPUT_PROFILE_BY_NAME = new Map(
  TOOL_OUTPUT_PROFILE_RULES.flatMap((rule) => rule.tools.map((tool) => [tool, rule.profile])),
);

export const TOOL_RESULT_RAW_RECOVERY_MIN_ORIGINAL_CHARS = 4_000;
export const TOOL_RESULT_RAW_RECOVERY_MIN_OMITTED_CHARS = 1_000;
export const TOOL_RESULT_RAW_RECOVERY_ERROR_MIN_ORIGINAL_CHARS = 1_000;

const STRUCTURED_EXACT_ACTIONS = new Set(["read", "preview"]);
const STRUCTURED_ACTION_TOOLS = new Set(["artifact", "learning", "context"]);
const VALID_COMPACTION_LEVELS = new Set<SparkToolOutputCompactionLevel>([
  "off",
  "lite",
  "full",
  "ultra",
]);

export function compactToolResultContent(
  input: SparkToolResultCompactionInput,
): SparkToolResultCompactionResult {
  const level = input.level ?? resolveToolOutputCompactionLevel();
  if (level === "off") return { content: input.content };

  const profile = toolOutputProfile(input.toolName, input.args);
  if (profile === "exact") return { content: input.content };

  let originalChars = 0;
  let compactedChars = 0;
  let trimmedLeadingBlankLines = 0;
  let trimmedTrailingBlankLines = 0;
  let collapsedBlankLines = 0;
  let collapsedBlankRuns = 0;
  let collapsedRepeatedLines = 0;
  let collapsedRepeatedRuns = 0;
  let changed = false;

  const content = input.content.map((part) => {
    if (!part || part.type !== "text" || typeof part.text !== "string") return part;
    originalChars += part.text.length;
    const compacted = compactToolText(part.text, profile, level);
    compactedChars += compacted.text.length;
    trimmedLeadingBlankLines += compacted.trimmedLeadingBlankLines;
    trimmedTrailingBlankLines += compacted.trimmedTrailingBlankLines;
    collapsedBlankLines += compacted.collapsedBlankLines;
    collapsedBlankRuns += compacted.collapsedBlankRuns;
    collapsedRepeatedLines += compacted.collapsedRepeatedLines;
    collapsedRepeatedRuns += compacted.collapsedRepeatedRuns;
    if (compacted.text !== part.text) changed = true;
    return compacted.text === part.text ? part : { ...part, text: compacted.text };
  });

  // Fail safe: unknown/exact tools pass through via profile selection above,
  // and known tools still keep the original if compaction is empty or longer.
  if (!changed || compactedChars === 0 || compactedChars >= originalChars) {
    return { content: input.content };
  }

  return {
    content,
    details: {
      profile,
      level,
      originalChars,
      compactedChars,
      trimmedLeadingBlankLines,
      trimmedTrailingBlankLines,
      collapsedBlankLines,
      collapsedBlankRuns,
      collapsedRepeatedLines,
      collapsedRepeatedRuns,
    },
  };
}

export function shouldRecordRawToolResultArtifact(
  input: SparkToolResultRawRecoveryDecisionInput,
): SparkToolResultRawRecoveryDecision {
  if (!input.compaction) return { record: false };
  const omittedChars = input.compaction.originalChars - input.compaction.compactedChars;
  if (
    input.isError === true &&
    input.compaction.originalChars >= TOOL_RESULT_RAW_RECOVERY_ERROR_MIN_ORIGINAL_CHARS
  ) {
    return { record: true, reason: "error_compaction", omittedChars };
  }
  if (
    input.compaction.originalChars >= TOOL_RESULT_RAW_RECOVERY_MIN_ORIGINAL_CHARS &&
    omittedChars >= TOOL_RESULT_RAW_RECOVERY_MIN_OMITTED_CHARS
  ) {
    return { record: true, reason: "lossy_compaction", omittedChars };
  }
  return { record: false, omittedChars };
}

export function resolveToolOutputCompactionLevel(
  raw = process.env.SPARK_TOOL_OUTPUT_COMPACTION,
): SparkToolOutputCompactionLevel {
  if (typeof raw !== "string" || raw.trim() === "") return "full";
  const normalized = raw.trim().toLowerCase();
  return VALID_COMPACTION_LEVELS.has(normalized as SparkToolOutputCompactionLevel)
    ? (normalized as SparkToolOutputCompactionLevel)
    : "full";
}

function toolOutputProfile(
  toolName: string,
  args: Record<string, unknown> | undefined,
): SparkToolOutputProfile {
  const action = typeof args?.action === "string" ? args.action : undefined;
  if (STRUCTURED_ACTION_TOOLS.has(toolName) && action) {
    return STRUCTURED_EXACT_ACTIONS.has(action) ? "exact" : "status";
  }
  return TOOL_OUTPUT_PROFILE_BY_NAME.get(toolName) ?? "exact";
}

function compactToolText(
  text: string,
  profile: CompactableProfile,
  level: SparkToolOutputCompactionLevel,
): {
  text: string;
  trimmedLeadingBlankLines: number;
  trimmedTrailingBlankLines: number;
  collapsedBlankLines: number;
  collapsedBlankRuns: number;
  collapsedRepeatedLines: number;
  collapsedRepeatedRuns: number;
} {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const trimmed = trimSurroundingBlankLines(normalized);
  const blankCollapsed = collapseBlankRuns(trimmed.text, blankRunOptions(profile, level));
  const repeatedCollapsed = shouldCollapseRepeatedLines(profile, level)
    ? collapseRepeatedLines(blankCollapsed.text)
    : { text: blankCollapsed.text, collapsedRepeatedLines: 0, collapsedRepeatedRuns: 0 };
  return {
    text: repeatedCollapsed.text,
    trimmedLeadingBlankLines: trimmed.leading,
    trimmedTrailingBlankLines: trimmed.trailing,
    collapsedBlankLines: blankCollapsed.collapsedBlankLines,
    collapsedBlankRuns: blankCollapsed.collapsedBlankRuns,
    collapsedRepeatedLines: repeatedCollapsed.collapsedRepeatedLines,
    collapsedRepeatedRuns: repeatedCollapsed.collapsedRepeatedRuns,
  };
}

function trimSurroundingBlankLines(text: string): {
  text: string;
  leading: number;
  trailing: number;
} {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === "") start += 1;
  let end = lines.length - 1;
  while (end >= start && lines[end]?.trim() === "") end -= 1;
  return {
    text: lines.slice(start, end + 1).join("\n"),
    leading: start,
    trailing: lines.length - 1 - end,
  };
}

function blankRunOptions(
  profile: CompactableProfile,
  level: SparkToolOutputCompactionLevel,
): { maxBlankLines: number; minRunToCollapse: number } {
  if (level === "lite") return { maxBlankLines: profile === "log" ? 3 : 2, minRunToCollapse: 8 };
  if (profile === "log") return { maxBlankLines: 2, minRunToCollapse: 4 };
  return { maxBlankLines: 1, minRunToCollapse: 2 };
}

function collapseBlankRuns(
  text: string,
  options: { maxBlankLines: number; minRunToCollapse: number },
): { text: string; collapsedBlankLines: number; collapsedBlankRuns: number } {
  if (text === "") return { text, collapsedBlankLines: 0, collapsedBlankRuns: 0 };
  const lines = text.split("\n");
  const output: string[] = [];
  let collapsedBlankLines = 0;
  let collapsedBlankRuns = 0;

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    if (line.trim() !== "") {
      output.push(line);
      index += 1;
      continue;
    }

    const start = index;
    while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
    const count = index - start;
    if (count < options.minRunToCollapse || count <= options.maxBlankLines) {
      output.push(...Array.from({ length: count }, () => ""));
      continue;
    }

    const before = Math.ceil(options.maxBlankLines / 2);
    const after = Math.floor(options.maxBlankLines / 2);
    const omitted = count - options.maxBlankLines;
    if (omitted < 3) {
      output.push(...Array.from({ length: options.maxBlankLines }, () => ""));
    } else {
      output.push(...Array.from({ length: before }, () => ""));
      output.push(`[${omitted} blank lines collapsed]`);
      output.push(...Array.from({ length: after }, () => ""));
    }
    collapsedBlankLines += omitted;
    collapsedBlankRuns += 1;
  }

  return { text: output.join("\n"), collapsedBlankLines, collapsedBlankRuns };
}

function shouldCollapseRepeatedLines(
  profile: CompactableProfile,
  level: SparkToolOutputCompactionLevel,
): boolean {
  return level !== "lite" && (profile === "log" || profile === "diagnostic");
}

function collapseRepeatedLines(text: string): {
  text: string;
  collapsedRepeatedLines: number;
  collapsedRepeatedRuns: number;
} {
  if (text === "") return { text, collapsedRepeatedLines: 0, collapsedRepeatedRuns: 0 };
  const lines = text.split("\n");
  const output: string[] = [];
  let collapsedRepeatedLines = 0;
  let collapsedRepeatedRuns = 0;

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const count = end - index;
    if (line.trim() !== "" && count >= 3) {
      output.push(line, `[previous line repeated ${count - 1}×]`);
      collapsedRepeatedLines += count - 1;
      collapsedRepeatedRuns += 1;
    } else {
      output.push(...lines.slice(index, end));
    }
    index = end;
  }

  return { text: output.join("\n"), collapsedRepeatedLines, collapsedRepeatedRuns };
}
