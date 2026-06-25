import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const REFLECTION_SCAN_CURSOR_VERSION = 1;

export interface ReflectionScanCursorFile {
  lineCount: number;
  sizeBytes: number;
  mtimeMs: number;
  scannedAt: string;
  lastEntryId?: string;
  sessionId?: string;
  cwd?: string;
}

export interface ReflectionScanCursor {
  version: typeof REFLECTION_SCAN_CURSOR_VERSION;
  files: Record<string, ReflectionScanCursorFile>;
}

export type ReflectionObservationKind = "user_prompt" | "custom_message" | "summary_hint";

export type ReflectionSignalKind = "todo_like" | "blocker" | "unfinished_intent" | "task_intent";

export interface ReflectionObservation {
  id: string;
  kind: ReflectionObservationKind;
  source: {
    file: string;
    line: number;
    entryId?: string;
    parentId?: string | null;
    timestamp?: string;
    sessionId?: string;
    cwd?: string;
    customType?: string;
  };
  text: string;
  excerpt: string;
  signals: ReflectionSignalKind[];
}

export interface ReflectionScanParseError {
  file: string;
  line: number;
  message: string;
}

export interface ReflectionScanStats {
  filesSeen: number;
  filesAdvanced: number;
  linesSeen: number;
  linesScanned: number;
  entriesScanned: number;
  userMessages: number;
  customMessages: number;
  summaryHints: number;
  parseErrors: number;
}

export interface ReflectionScanResult {
  observations: ReflectionObservation[];
  cursor: ReflectionScanCursor;
  parseErrors: ReflectionScanParseError[];
  stats: ReflectionScanStats;
}

export interface ReflectionScanOptions {
  sessionRoot: string;
  cursor?: ReflectionScanCursor;
  /** Re-read all lines even if a cursor exists. Use sparingly; normal scans are incremental. */
  forceRescan?: boolean;
  /** Maximum number of session files to consider after path sort. Undefined means all files. */
  maxFiles?: number;
  /** Maximum number of new lines to process per file for bounded incremental catch-up. */
  maxNewLinesPerFile?: number;
  /** Include compaction and branch summaries as low-authority hints. Default: true. */
  includeSummaryHints?: boolean;
  now?: string;
}

interface SessionHeaderLike {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
}

interface SessionEntryLike {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: unknown;
  customType?: unknown;
  content?: unknown;
  summary?: unknown;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

export function emptyReflectionScanCursor(_since?: string): ReflectionScanCursor {
  return { version: REFLECTION_SCAN_CURSOR_VERSION, files: {} };
}

export function reflectionScanCursorPath(cwd: string, name = "session-scan-cursor"): string {
  return join(cwd, ".spark", "reflections", `${name}.json`);
}

export async function loadReflectionScanCursor(path: string): Promise<ReflectionScanCursor> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return normalizeReflectionScanCursor(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyReflectionScanCursor();
    throw error;
  }
}

export async function saveReflectionScanCursor(
  path: string,
  cursor: ReflectionScanCursor,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function renderReflectionScanReport(result: ReflectionScanResult): string {
  const lines = [
    "Reflection session scan report",
    `Files: seen=${result.stats.filesSeen} advanced=${result.stats.filesAdvanced}`,
    `Lines: seen=${result.stats.linesSeen} scanned=${result.stats.linesScanned}`,
    `Observations: ${result.observations.length}`,
    `Parse errors: ${result.stats.parseErrors}`,
  ];
  for (const observation of result.observations.slice(0, 10)) {
    lines.push(
      `- ${observation.kind} ${observation.source.file}:${observation.source.line} ${observation.excerpt}`,
    );
  }
  return lines.join("\n");
}

export async function scanPiSessionHistory(
  options: ReflectionScanOptions,
): Promise<ReflectionScanResult> {
  const cursor = normalizeReflectionScanCursor(options.cursor ?? emptyReflectionScanCursor());
  const nextCursor: ReflectionScanCursor = {
    version: REFLECTION_SCAN_CURSOR_VERSION,
    files: { ...cursor.files },
  };
  const now = options.now ?? new Date().toISOString();
  const includeSummaryHints = options.includeSummaryHints ?? true;
  const files = await listJsonlFiles(options.sessionRoot);
  const selectedFiles = options.maxFiles === undefined ? files : files.slice(0, options.maxFiles);
  const observations: ReflectionObservation[] = [];
  const parseErrors: ReflectionScanParseError[] = [];
  const stats: ReflectionScanStats = {
    filesSeen: selectedFiles.length,
    filesAdvanced: 0,
    linesSeen: 0,
    linesScanned: 0,
    entriesScanned: 0,
    userMessages: 0,
    customMessages: 0,
    summaryHints: 0,
    parseErrors: 0,
  };

  for (const file of selectedFiles) {
    const fileStat = await stat(file);
    const content = await readFile(file, "utf8");
    const lines = splitJsonlLines(content);
    stats.linesSeen += lines.length;

    const header = parseSessionHeader(file, lines[0], parseErrors);
    const previous = cursor.files[file];
    const startLine = options.forceRescan
      ? 0
      : nextStartLine(previous, lines.length, fileStat.size);
    const remainingLines = lines.length - startLine;
    if (remainingLines <= 0) {
      nextCursor.files[file] = {
        lineCount: lines.length,
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        scannedAt: previous?.scannedAt ?? now,
        lastEntryId: previous?.lastEntryId,
        sessionId: header.sessionId ?? previous?.sessionId,
        cwd: header.cwd ?? previous?.cwd,
      };
      continue;
    }

    const lineBudget = options.maxNewLinesPerFile ?? remainingLines;
    const endLineExclusive = startLine + Math.min(remainingLines, lineBudget);
    let lastEntryId = previous?.lastEntryId;
    let advanced = false;

    for (let index = startLine; index < endLineExclusive; index += 1) {
      const line = lines[index];
      if (!line?.trim()) continue;
      const entry = parseJsonLine<SessionEntryLike>(file, index + 1, line, parseErrors);
      if (!entry) continue;
      advanced = true;
      stats.linesScanned += 1;
      if (typeof entry.id === "string") lastEntryId = entry.id;
      if (entry.type !== "session") stats.entriesScanned += 1;

      const observed = observeSessionEntry({
        file,
        line: index + 1,
        entry,
        header,
        includeSummaryHints,
      });
      if (!observed) continue;
      observations.push(observed);
      if (observed.kind === "user_prompt") stats.userMessages += 1;
      if (observed.kind === "custom_message") stats.customMessages += 1;
      if (observed.kind === "summary_hint") stats.summaryHints += 1;
    }

    if (advanced) stats.filesAdvanced += 1;
    nextCursor.files[file] = {
      lineCount: endLineExclusive,
      sizeBytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      scannedAt: now,
      lastEntryId,
      sessionId: header.sessionId,
      cwd: header.cwd,
    };
  }

  stats.parseErrors = parseErrors.length;
  return { observations, cursor: nextCursor, parseErrors, stats };
}

export function unfinishedSignalsForText(text: string): ReflectionSignalKind[] {
  const signals = new Set<ReflectionSignalKind>();
  const normalized = text.toLowerCase();
  if (
    /\b(todo|fixme|follow[- ]?up|backlog|scratchpad)\b/u.test(normalized) ||
    /待办|后续|回头|补上|记得|未完成|清债|技术债|历史债|\[ \]/u.test(text)
  ) {
    signals.add("todo_like");
  }
  if (
    /\b(blocked|blocker|blocking|failed|failure|timeout|timed out|needs_changes|unavailable)\b/u.test(
      normalized,
    ) ||
    /阻塞|卡住|失败|超时|无法|不能继续|需要确认|缺少|缺失/u.test(text)
  ) {
    signals.add("blocker");
  }
  if (
    /\b(unfinished|incomplete|remaining|not done|left over|resume|continue|next step)\b/u.test(
      normalized,
    ) ||
    /还需要|继续|下一步|剩余|没做完|尚未|未验证|待验证|没完成/u.test(text)
  ) {
    signals.add("unfinished_intent");
  }
  if (
    /\b(implement|fix|refactor|validate|review|create task|plan concrete|task_write|claim|finish)\b/u.test(
      normalized,
    ) ||
    /实现|修复|重构|验证|审查|创建任务|规划任务|完成任务|优化|改造/u.test(text)
  ) {
    signals.add("task_intent");
  }
  return [...signals];
}

export function isLikelyReflectionHarnessText(text: string): boolean {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (!compact) return false;
  return (
    (/^Return ONLY /u.test(compact) &&
      /Review this Spark state transition request/u.test(compact)) ||
    (/^Return ONLY /u.test(compact) && /Review this Spark goal completion packet/u.test(compact)) ||
    /^Spark role-run ask policy:/u.test(compact) ||
    /^Spark role-run interaction policy:/u.test(compact) ||
    /## (Implementation|Planning|Research) (?:phase|mode) requirements/u.test(compact) ||
    /Selected Spark (?:phase|mode) for (goal|loop|workflow) driver:/u.test(compact)
  );
}

export function summarizeReflectionScan(
  result: ReflectionScanResult,
  maxObservations = 20,
): string {
  const nonHarnessActionable = result.observations.filter(
    (observation) =>
      observation.signals.length > 0 && !isLikelyReflectionHarnessText(observation.text),
  );
  const actionableSource =
    nonHarnessActionable.length > 0
      ? nonHarnessActionable
      : result.observations.filter((observation) => observation.signals.length > 0);
  const actionable = actionableSource.sort(compareObservationsForReview).slice(0, maxObservations);
  const lines: Array<string | undefined> = [
    "# Reflection session scan report",
    "",
    `Files seen: ${result.stats.filesSeen}`,
    `Files advanced: ${result.stats.filesAdvanced}`,
    `Lines scanned: ${result.stats.linesScanned} / ${result.stats.linesSeen}`,
    `Entries scanned: ${result.stats.entriesScanned}`,
    `User messages: ${result.stats.userMessages}`,
    `Custom messages: ${result.stats.customMessages}`,
    `Summary hints: ${result.stats.summaryHints}`,
    `Parse errors: ${result.stats.parseErrors}`,
    `Observations: ${result.observations.length}`,
    `Actionable observations: ${result.observations.filter((item) => item.signals.length > 0).length}`,
    "",
    "## Top unfinished-task candidates",
  ];
  if (actionable.length === 0) {
    lines.push("", "No unfinished-task candidates were detected in the scanned entries.");
  } else {
    for (const [index, observation] of actionable.entries()) {
      lines.push(
        "",
        `### ${index + 1}. ${observation.signals.join(", ")} (${observation.kind})`,
        `Source: ${observation.source.file}:${observation.source.line}`,
        observation.source.cwd ? `CWD: ${observation.source.cwd}` : undefined,
        observation.source.timestamp ? `Timestamp: ${observation.source.timestamp}` : undefined,
        observation.source.customType ? `Custom type: ${observation.source.customType}` : undefined,
        "",
        observation.excerpt,
      );
    }
  }
  if (result.parseErrors.length > 0) {
    lines.push("", "## Parse errors");
    for (const error of result.parseErrors.slice(0, 20)) {
      lines.push(`- ${error.file}:${error.line}: ${error.message}`);
    }
  }
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function normalizeReflectionScanCursor(input: unknown): ReflectionScanCursor {
  if (!input || typeof input !== "object") return emptyReflectionScanCursor();
  const record = input as { version?: unknown; files?: unknown };
  if (record.version !== REFLECTION_SCAN_CURSOR_VERSION || !isRecord(record.files)) {
    return emptyReflectionScanCursor();
  }
  const files: Record<string, ReflectionScanCursorFile> = {};
  for (const [file, value] of Object.entries(record.files)) {
    if (!isRecord(value)) continue;
    const lineCount = nonNegativeInteger(value.lineCount);
    const sizeBytes = nonNegativeNumber(value.sizeBytes);
    const mtimeMs = nonNegativeNumber(value.mtimeMs);
    const scannedAt = typeof value.scannedAt === "string" ? value.scannedAt : undefined;
    if (lineCount === undefined || sizeBytes === undefined || mtimeMs === undefined || !scannedAt) {
      continue;
    }
    files[file] = {
      lineCount,
      sizeBytes,
      mtimeMs,
      scannedAt,
      lastEntryId: typeof value.lastEntryId === "string" ? value.lastEntryId : undefined,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
      cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    };
  }
  return { version: REFLECTION_SCAN_CURSOR_VERSION, files };
}

function nextStartLine(
  previous: ReflectionScanCursorFile | undefined,
  totalLines: number,
  sizeBytes: number,
): number {
  if (!previous) return 0;
  if (previous.lineCount < 0 || previous.lineCount > totalLines) return 0;
  if (previous.sizeBytes > sizeBytes) return 0;
  return previous.lineCount;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  await collectJsonlFiles(root, found);
  return found.sort((a, b) => a.localeCompare(b));
}

async function collectJsonlFiles(path: string, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(child, found);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(child);
    }
  }
}

function parseSessionHeader(
  file: string,
  line: string | undefined,
  parseErrors: ReflectionScanParseError[],
): { sessionId?: string; cwd?: string } {
  if (!line) return {};
  const parsed = parseJsonLine<SessionHeaderLike>(file, 1, line, parseErrors);
  if (!parsed || parsed.type !== "session") return {};
  return {
    sessionId: typeof parsed.id === "string" ? parsed.id : undefined,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
  };
}

function parseJsonLine<T>(
  file: string,
  line: number,
  text: string,
  parseErrors: ReflectionScanParseError[],
): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    parseErrors.push({
      file,
      line,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function observeSessionEntry(input: {
  file: string;
  line: number;
  entry: SessionEntryLike;
  header: { sessionId?: string; cwd?: string };
  includeSummaryHints: boolean;
}): ReflectionObservation | undefined {
  const entryType = typeof input.entry.type === "string" ? input.entry.type : undefined;
  let kind: ReflectionObservationKind | undefined;
  let text = "";
  let customType: string | undefined;

  if (entryType === "message") {
    const message = isRecord(input.entry.message)
      ? (input.entry.message as MessageLike)
      : undefined;
    if (message?.role !== "user") return undefined;
    kind = "user_prompt";
    text = contentToText(message.content);
  } else if (entryType === "custom_message") {
    kind = "custom_message";
    text = contentToText(input.entry.content);
    customType = typeof input.entry.customType === "string" ? input.entry.customType : undefined;
  } else if (
    input.includeSummaryHints &&
    (entryType === "compaction" || entryType === "branch_summary")
  ) {
    kind = "summary_hint";
    text = typeof input.entry.summary === "string" ? input.entry.summary : "";
    customType = entryType;
  }

  const trimmed = text.trim();
  if (!kind || !trimmed) return undefined;
  const source = {
    file: input.file,
    line: input.line,
    entryId: typeof input.entry.id === "string" ? input.entry.id : undefined,
    parentId:
      typeof input.entry.parentId === "string" || input.entry.parentId === null
        ? input.entry.parentId
        : undefined,
    timestamp: typeof input.entry.timestamp === "string" ? input.entry.timestamp : undefined,
    sessionId: input.header.sessionId,
    cwd: input.header.cwd,
    customType,
  };
  return {
    id: stableObservationId(kind, source.file, source.line, source.entryId, trimmed),
    kind,
    source,
    text: trimmed,
    excerpt: excerptText(trimmed),
    signals: unfinishedSignalsForText(trimmed),
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    if (block.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function splitJsonlLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function stableObservationId(
  kind: ReflectionObservationKind,
  file: string,
  line: number,
  entryId: string | undefined,
  text: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, file, line, entryId, text }))
    .digest("hex")
    .slice(0, 16);
}

function excerptText(text: string, maxChars = 700): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}

function compareObservationsForReview(
  left: ReflectionObservation,
  right: ReflectionObservation,
): number {
  return observationScore(right) - observationScore(left) || left.id.localeCompare(right.id);
}

function observationScore(observation: ReflectionObservation): number {
  let score = observation.signals.length;
  if (observation.signals.includes("blocker")) score += 3;
  if (observation.signals.includes("unfinished_intent")) score += 2;
  if (observation.signals.includes("todo_like")) score += 1;
  if (observation.kind === "custom_message") score -= 1;
  if (observation.kind === "summary_hint") score -= 2;
  if (isLikelyReflectionHarnessText(observation.text)) score -= 20;
  return score;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
