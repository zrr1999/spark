import type { ChannelAskOption, ChannelAskRequest } from "./interaction.ts";

/** One selectable option when projecting a channel ask as plain text. */
export interface TextChannelAskOption {
  label: string;
  description?: string;
}

/** Inputs for the durable text fallback used by adapters without native controls. */
export interface TextChannelAskRenderInput {
  title?: string;
  prompt: string;
  options?: readonly TextChannelAskOption[];
}

/**
 * Render a channel ask as Markdown that works in private/group chat without
 * native buttons. Numbered options invite a digit reply; freeform asks invite
 * any non-empty reply.
 */
export function renderTextChannelAsk(input: TextChannelAskRenderInput): string {
  const title = input.title?.trim();
  const prompt = input.prompt.trim();
  if (!prompt && !title) {
    throw new Error("text channel ask prompt must not be empty");
  }
  const options = (input.options ?? [])
    .map((option) => ({
      label: option.label.trim(),
      ...(option.description?.trim() ? { description: option.description.trim() } : {}),
    }))
    .filter((option) => option.label.length > 0);
  const lines: string[] = [];
  if (title) lines.push(`## ${title}`, "");
  if (prompt) lines.push(prompt);
  if (options.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("请回复序号或直接输入：");
    for (const [index, option] of options.entries()) {
      const description = option.description ? ` — ${option.description}` : "";
      lines.push(`${index + 1}. ${option.label}${description}`);
    }
  } else {
    if (lines.length > 0) lines.push("");
    lines.push("请直接回复你的答案。");
  }
  return lines.join("\n").trim();
}

/** Build the Markdown body carried by a ChannelAskRequest for text-only adapters. */
export function renderTextChannelAskRequest(request: ChannelAskRequest): string {
  const fromPrompt = request.prompt.trim();
  if (fromPrompt) return fromPrompt;
  const fallback = request.unsupportedText?.trim();
  if (fallback) return fallback;
  return renderTextChannelAsk({
    prompt: request.prompt,
    options: request.options.map(optionToTextOption),
  });
}

function optionToTextOption(option: ChannelAskOption): TextChannelAskOption {
  return { label: option.label };
}
