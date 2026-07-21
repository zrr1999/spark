import { normalizeChannelMessageReference } from "./message-reference.ts";
import type { ChannelMessageReference } from "./message-reference.ts";

export type InfoflowAttachmentKind = "image" | "file" | "voice";

/** Display-safe attachment facts. Raw bytes and signed download URLs are never retained here. */
export interface InfoflowAttachment {
  kind: InfoflowAttachmentKind;
  name?: string;
  mediaType?: string;
  size?: number;
  /** Stable platform reference when supplied (for example fid/fileId), never a download URL. */
  reference?: string;
}

export interface InfoflowNormalizedContent {
  /** Human-readable prompt/transcript text with attachment placeholders. */
  text: string;
  contentType: string;
  mentions: string[];
  attachments: InfoflowAttachment[];
  /** Structured quote/reply extracted from body parts; not inlined into text. */
  messageReference?: ChannelMessageReference;
}

export interface NormalizeInfoflowContentInput {
  messageType?: string;
  content?: unknown;
  body?: unknown;
}

/**
 * Normalize Infoflow text, Markdown, rich text, and mixed media without copying
 * binary/base64 payloads or signed download URLs into the model prompt.
 */
export function normalizeInfoflowContent(
  input: NormalizeInfoflowContentInput,
): InfoflowNormalizedContent {
  const contentType = normalizeContentType(input.messageType);
  if (Array.isArray(input.body)) {
    return normalizeBody(input.body, contentType);
  }

  const content = parseStructuredContent(input.content);
  const attachments: InfoflowAttachment[] = [];
  let text = "";
  switch (contentType) {
    case "image":
      attachments.push(attachmentFromContent("image", content));
      text = "[图片]";
      break;
    case "file": {
      const attachment = attachmentFromContent("file", content);
      attachments.push(attachment);
      text = attachment.name ? `[文件: ${safeInline(attachment.name)}]` : "[文件]";
      break;
    }
    case "voice": {
      const attachment = attachmentFromContent("voice", content);
      attachments.push(attachment);
      const transcript = firstStringField(record(content) ?? {}, "voiceText", "transcript", "text");
      text = transcript ? `[语音] ${safeText(transcript)}` : "[语音]";
      break;
    }
    case "markdown":
    case "md":
    case "richtext":
    case "text":
      text = displayText(content);
      break;
    default:
      text = displayText(content);
      if (!text) text = `[如流消息: ${safeInline(contentType || "unknown")}]`;
      break;
  }

  return {
    text: text.trim(),
    contentType,
    mentions: [],
    attachments: attachments.map(compactAttachment),
  };
}

function normalizeBody(body: unknown[], contentType: string): InfoflowNormalizedContent {
  const parts: string[] = [];
  const mentions: string[] = [];
  const attachments: InfoflowAttachment[] = [];
  let messageReference: ChannelMessageReference | undefined;

  for (const item of body) {
    const entry = record(item);
    if (!entry) continue;
    const type = normalizeContentType(scalar(entry.type));
    switch (type) {
      case "at": {
        const label = firstStringField(
          entry,
          "name",
          "display",
          "displayname",
          "userid",
          "userId",
          "robotid",
          "robotId",
        )
          .replace(/^@+/u, "")
          .trim();
        if (label) {
          mentions.push(label);
          parts.push(`@${safeInline(label)}`);
        }
        break;
      }
      case "image":
        attachments.push(attachmentFromContent("image", entry));
        parts.push("[图片]");
        break;
      case "file": {
        const attachment = attachmentFromContent("file", entry);
        attachments.push(attachment);
        parts.push(attachment.name ? `[文件: ${safeInline(attachment.name)}]` : "[文件]");
        break;
      }
      case "voice": {
        const attachment = attachmentFromContent("voice", entry);
        attachments.push(attachment);
        const transcript = firstStringField(entry, "voiceText", "transcript", "text");
        parts.push(transcript ? `[语音] ${safeText(transcript)}` : "[语音]");
        break;
      }
      case "link":
      case "url": {
        const label = firstStringField(entry, "label", "title", "content", "text") || "链接";
        const href = firstStringField(entry, "href", "url");
        parts.push(href ? `[${safeInline(label)}](${safeInline(href)})` : safeText(label));
        break;
      }
      case "reply":
      case "quote": {
        const extracted = extractInfoflowQuoteReference(entry);
        if (extracted) messageReference = extracted;
        break;
      }
      case "text":
      case "md":
      case "markdown":
      case "richtext":
      case "": {
        const value = displayText(entry.content ?? entry.text ?? entry);
        if (value) parts.push(value);
        break;
      }
      default: {
        const value = displayText(entry.content ?? entry.text);
        parts.push(value || `[如流消息片段: ${safeInline(type)}]`);
      }
    }
  }

  return {
    text: joinBodyParts(parts),
    contentType,
    mentions: [...new Set(mentions)],
    attachments: attachments.map(compactAttachment),
    ...(messageReference ? { messageReference } : {}),
  };
}

function extractInfoflowQuoteReference(
  entry: Record<string, unknown>,
): ChannelMessageReference | undefined {
  const preview = firstStringField(entry, "text", "content", "preview");
  const messageId = firstStringField(entry, "msgid", "messageId", "message_id", "msgId");
  const secondaryMessageId = firstStringField(entry, "msgid2", "secondaryMessageId", "msgid_2");
  const senderId = firstStringField(entry, "uid", "userid", "userId", "senderId", "fromuserid");
  const senderName = firstStringField(entry, "username", "userName", "senderName", "fromusername");
  return normalizeChannelMessageReference({
    ...(messageId ? { messageId } : {}),
    ...(secondaryMessageId ? { secondaryMessageId } : {}),
    ...(preview ? { preview: safeText(preview) } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    source: preview ? "embedded" : "unknown",
  });
}

function attachmentFromContent(kind: InfoflowAttachmentKind, value: unknown): InfoflowAttachment {
  const source = record(value) ?? {};
  const name = firstStringField(source, "fileName", "filename", "name", "title", "imageName");
  const mediaType = firstStringField(source, "mimeType", "mimetype", "fileType", "imageType");
  const sizeValue = source.size ?? source.fileSize;
  const size =
    typeof sizeValue === "number" && Number.isFinite(sizeValue) && sizeValue >= 0
      ? sizeValue
      : undefined;
  const reference = firstStringField(source, "fid", "fileId", "fileid", "mediaId", "mediaid");
  return {
    kind,
    ...(name ? { name: safeInline(name) } : {}),
    ...(mediaType ? { mediaType: safeInline(mediaType) } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(reference ? { reference: safeInline(reference) } : {}),
  };
}

function compactAttachment(value: InfoflowAttachment): InfoflowAttachment {
  return {
    kind: value.kind,
    ...(value.name ? { name: value.name } : {}),
    ...(value.mediaType ? { mediaType: value.mediaType } : {}),
    ...(value.size !== undefined ? { size: value.size } : {}),
    ...(value.reference ? { reference: value.reference } : {}),
  };
}

function displayText(value: unknown, depth = 0): string {
  if (typeof value === "string") {
    if (looksLikeBinary(value)) return "";
    const structured = parseStructuredContent(value);
    if (structured !== value) return displayText(structured, depth + 1);
    return safeText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 4) return "";
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((entry) => displayText(entry, depth + 1))
      .filter(Boolean)
      .join(" ");
  }
  const source = record(value);
  if (!source) return "";
  const direct = firstStringField(source, "text", "content", "label", "title", "desc");
  if (direct && !looksLikeBinary(direct)) return safeText(direct);
  const rich = source.items ?? source.blocks ?? source.children;
  return displayText(rich, depth + 1);
}

function parseStructuredContent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function joinBodyParts(parts: string[]): string {
  let text = "";
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const block = /^\[(?:图片|文件|语音|如流消息)/u.test(part);
    const previousIsBlock = /(?:^|\n)\[(?:图片|文件|语音|如流消息)[^\n]*\]$/u.test(text);
    if (text && (block || previousIsBlock)) {
      text += "\n";
    } else if (text && !/[\s\n]$/u.test(text) && !/^[，。！？、；：,.!?;:)]/u.test(part)) {
      text += " ";
    }
    text += part;
  }
  return text.replace(/\n{3,}/gu, "\n\n").trim();
}

function looksLikeBinary(value: string): boolean {
  const text = value.trim();
  if (/^data:[^;,]+;base64,/iu.test(text)) return true;
  return text.length > 512 && /^[A-Za-z0-9+/=_-]+$/u.test(text);
}

function safeText(value: string): string {
  return value.replaceAll("\u0000", "").trim().slice(0, 16_000);
}

function safeInline(value: string): string {
  return safeText(value)
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 512);
}

function firstStringField(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = scalar(source[key]).trim();
    if (value) return value;
  }
  return "";
}

function normalizeContentType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  const suffix = normalized.includes(".") ? normalized.split(".").at(-1) : normalized;
  return suffix === "mixed" ? "mixed" : (suffix ?? "");
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
