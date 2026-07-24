import {
  SPARK_TURN_ATTACHMENT_MAX_BYTES,
  SPARK_TURN_ATTACHMENT_MAX_COUNT,
  SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES,
  sparkTurnAttachmentsSchema,
  type SparkTurnAttachment,
} from "@zendev-lab/spark-protocol";

const MODEL_IMAGE_MEDIA_TYPES = new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type TurnAttachmentValidationCode = "count" | "file_size" | "total_size";

export class TurnAttachmentValidationError extends Error {
  constructor(
    readonly code: TurnAttachmentValidationCode,
    readonly fileName?: string,
  ) {
    super(`Invalid turn attachment: ${code}${fileName ? ` (${fileName})` : ""}`);
    this.name = "TurnAttachmentValidationError";
  }
}

export async function turnAttachmentsFromFormData(
  formData: FormData,
): Promise<SparkTurnAttachment[]> {
  const files = formData
    .getAll("attachments")
    .filter(
      (value): value is File =>
        typeof value !== "string" && (value.size > 0 || value.name.trim().length > 0),
    );
  if (files.length > SPARK_TURN_ATTACHMENT_MAX_COUNT) {
    throw new TurnAttachmentValidationError("count");
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > SPARK_TURN_ATTACHMENT_MAX_BYTES) {
      throw new TurnAttachmentValidationError("file_size", safeAttachmentName(file.name));
    }
    totalBytes += file.size;
    if (totalBytes > SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new TurnAttachmentValidationError("total_size");
    }
  }

  const attachments = await Promise.all(
    files.map(async (file): Promise<SparkTurnAttachment> => {
      const mediaType = normalizedMediaType(file.type);
      return {
        kind: MODEL_IMAGE_MEDIA_TYPES.has(mediaType) ? "image" : "file",
        name: safeAttachmentName(file.name),
        mediaType,
        size: file.size,
        data: Buffer.from(await file.arrayBuffer()).toString("base64"),
      };
    }),
  );
  return sparkTurnAttachmentsSchema.parse(attachments);
}

export function attachmentPrompt(
  message: string,
  attachments: readonly SparkTurnAttachment[],
  labels: { image: string; file: string },
): string {
  const facts = attachments.map(
    (attachment) =>
      `[${attachment.kind === "image" ? labels.image : labels.file}: ${attachment.name}]`,
  );
  return [message.trim(), ...facts].filter(Boolean).join("\n\n");
}

function normalizedMediaType(value: string): string {
  return value.trim().toLowerCase().split(";", 1)[0] || "application/octet-stream";
}

function safeAttachmentName(value: string): string {
  const name = value
    .normalize("NFKC")
    .replace(/[\p{Cc}/\\:]/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 240);
  return name || "attachment";
}
