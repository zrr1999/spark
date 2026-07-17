/**
 * Host-owned prompt/message representation.
 *
 * Provider SDK message unions do not have roles for Spark runtime control or
 * runtime data. Keep those distinctions in this IR and lower them only when a
 * concrete provider context is assembled.
 */

export type SparkPromptAuthority =
  | "system"
  | "developer"
  | "runtime_control"
  | "runtime_data"
  | "user"
  | "assistant"
  | "tool";

export type SparkPromptTrust = "trusted" | "untrusted";
export type SparkPromptVisibility = "visible" | "hidden";
export type SparkPromptPersistence = "session" | "transient";

export type SparkPromptRuntimeContent = string | Array<{ type: string; [key: string]: unknown }>;

export interface SparkPromptProviderMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export type SparkPromptItemContent =
  | { kind: "provider_message"; message: SparkPromptProviderMessage }
  | { kind: "runtime"; value: SparkPromptRuntimeContent };

export interface SparkPromptItem {
  authority: SparkPromptAuthority;
  trust: SparkPromptTrust;
  visibility: SparkPromptVisibility;
  persistence: SparkPromptPersistence;
  content: SparkPromptItemContent;
  customType?: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

export interface SparkPromptItemMetadata {
  authority: SparkPromptAuthority;
  trust: SparkPromptTrust;
  visibility: SparkPromptVisibility;
  persistence: SparkPromptPersistence;
}

export const SPARK_PROMPT_ITEM_METADATA_KEY = "sparkPromptItem";

export function sparkPromptItemFromProviderMessage(
  message: SparkPromptProviderMessage,
): SparkPromptItem {
  return {
    authority: authorityForProviderRole(message.role),
    trust: trustForProviderRole(message.role),
    visibility: "visible",
    persistence: "session",
    content: { kind: "provider_message", message: { ...message } },
    timestamp: normalizeTimestamp(message.timestamp),
  };
}

export function sparkRuntimePromptItem(input: {
  authority: "system" | "developer" | "runtime_control" | "runtime_data";
  trust: SparkPromptTrust;
  visibility: SparkPromptVisibility;
  persistence: SparkPromptPersistence;
  content: SparkPromptRuntimeContent;
  customType?: string;
  details?: Record<string, unknown>;
  timestamp?: number;
}): SparkPromptItem {
  return {
    authority: input.authority,
    trust: input.trust,
    visibility: input.visibility,
    persistence: input.persistence,
    content: { kind: "runtime", value: cloneRuntimeContent(input.content) },
    ...(input.customType ? { customType: input.customType } : {}),
    ...(input.details ? { details: { ...input.details } } : {}),
    timestamp: normalizeTimestamp(input.timestamp),
  };
}

export function cloneSparkPromptItem(item: SparkPromptItem): SparkPromptItem {
  if (item.content.kind === "provider_message") {
    return {
      ...item,
      content: { kind: "provider_message", message: { ...item.content.message } },
      ...(item.details ? { details: { ...item.details } } : {}),
    };
  }
  return {
    ...item,
    content: { kind: "runtime", value: cloneRuntimeContent(item.content.value) },
    ...(item.details ? { details: { ...item.details } } : {}),
  };
}

/**
 * Compatibility lowering for providers whose message union has no runtime or
 * developer role. Runtime items become explicitly tagged user-role data only
 * at this boundary; internally they retain their authority and trust labels.
 */
export function lowerSparkPromptItem(item: SparkPromptItem): SparkPromptProviderMessage {
  if (item.content.kind === "provider_message" && item.authority !== "developer") {
    return { ...item.content.message };
  }
  const tag = tagForAuthority(item.authority);
  const customType = item.customType ? ` custom_type="${escapeXmlAttribute(item.customType)}"` : "";
  return {
    role: "user",
    content: `<${tag} trust="${item.trust}"${customType}>\n${escapeXmlText(
      sparkPromptItemText(item),
    )}\n</${tag}>`,
    timestamp: item.timestamp,
  };
}

export function lowerSparkPromptItems(
  items: readonly SparkPromptItem[],
): SparkPromptProviderMessage[] {
  return items.map(lowerSparkPromptItem);
}

export function sparkPromptItemText(item: SparkPromptItem): string {
  if (item.content.kind === "provider_message") {
    const content = item.content.message.content;
    return contentToText(content);
  }
  return contentToText(item.content.value);
}

export function sparkPromptItemMetadata(item: SparkPromptItem): SparkPromptItemMetadata {
  return {
    authority: item.authority,
    trust: item.trust,
    visibility: item.visibility,
    persistence: item.persistence,
  };
}

export function parseSparkPromptItemMetadata(value: unknown): SparkPromptItemMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const authority = value.authority;
  const trust = value.trust;
  const visibility = value.visibility;
  const persistence = value.persistence;
  if (!isSparkPromptAuthority(authority)) return undefined;
  if (trust !== "trusted" && trust !== "untrusted") return undefined;
  if (visibility !== "visible" && visibility !== "hidden") return undefined;
  if (persistence !== "session" && persistence !== "transient") return undefined;
  return { authority, trust, visibility, persistence };
}

function authorityForProviderRole(role: string): SparkPromptAuthority {
  if (role === "assistant") return "assistant";
  if (role === "toolResult" || role === "tool") return "tool";
  if (role === "system") return "system";
  if (role === "developer") return "developer";
  return "user";
}

function trustForProviderRole(role: string): SparkPromptTrust {
  return role === "system" || role === "developer" ? "trusted" : "untrusted";
}

function tagForAuthority(authority: SparkPromptAuthority): string {
  if (authority === "system") return "spark_system_context";
  if (authority === "developer") return "spark_developer_context";
  if (authority === "runtime_control") return "spark_runtime_control";
  if (authority === "runtime_data") return "spark_runtime_data";
  return "spark_prompt_data";
}

function cloneRuntimeContent(content: SparkPromptRuntimeContent): SparkPromptRuntimeContent {
  return Array.isArray(content) ? content.map((part) => ({ ...part })) : content;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : safeJson(content);
  return content
    .map((part) => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return safeJson(part);
    })
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function isSparkPromptAuthority(value: unknown): value is SparkPromptAuthority {
  return (
    value === "system" ||
    value === "developer" ||
    value === "runtime_control" ||
    value === "runtime_data" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  );
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
