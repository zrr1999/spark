/** Editor input expansion: @file, images, and bang shell commands. */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_NATIVE_IMAGE_BYTES = 256 * 1024;
const MAX_NATIVE_IMAGE_DIMENSION = 4096;
const AT_FILE_TOKEN = /(^|\s)@("[^"]+"|\S+)/gu;
const RAW_IMAGE_TOKEN =
  /(^|\s)((?:file:\/\/|~\/|\.\.?\/|\/)?\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/giu;

export async function prepareSparkNativeEditorInput(
  input: string,
  basePath: string,
): Promise<string> {
  const bang = parseBangCommand(input);
  if (bang) return await runSparkNativeBangCommand(bang.command, bang.hidden, basePath);

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const match of input.matchAll(AT_FILE_TOKEN)) {
    const leading = match[1] ?? "";
    const raw = match[2];
    if (!raw) continue;
    const tokenStart = (match.index ?? 0) + leading.length;
    const tokenEnd = tokenStart + raw.length + 1;
    const pathText = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    const expanded = await expandSparkNativeFileReference(pathText, basePath);
    replacements.push({ start: tokenStart, end: tokenEnd, text: expanded });
  }
  for (const match of input.matchAll(RAW_IMAGE_TOKEN)) {
    const leading = match[1] ?? "";
    const raw = match[2];
    if (!raw || raw.startsWith("@")) continue;
    const tokenStart = (match.index ?? 0) + leading.length;
    if (tokenStart > 0 && input[tokenStart - 1] === "@") continue;
    const tokenEnd = tokenStart + raw.length;
    if (replacements.some((replacement) => rangesOverlap(tokenStart, tokenEnd, replacement))) {
      continue;
    }
    const expanded = await expandSparkNativeImageReferenceIfExists(raw, basePath);
    if (expanded) replacements.push({ start: tokenStart, end: tokenEnd, text: expanded });
  }
  if (replacements.length === 0) return input;
  replacements.sort((left, right) => left.start - right.start);

  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    output += input.slice(cursor, replacement.start);
    output += replacement.text;
    cursor = replacement.end;
  }
  output += input.slice(cursor);
  return output;
}

export function displayNativeSubmittedInput(input: string): string {
  return input.replace(
    /<image\b([^>]*)>data:[^<]+<\/image>/gu,
    (_match, attrs: string) => `<image${attrs}>[inline image data omitted]</image>`,
  );
}

export function compactNativeQueuePreview(input: string): string {
  return displayNativeSubmittedInput(input).replace(/\s+/gu, " ").trim() || "(empty)";
}

export function parseBangCommand(input: string): { command: string; hidden: boolean } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("!")) return undefined;
  const hidden = trimmed.startsWith("!!");
  const command = trimmed.slice(hidden ? 2 : 1).trim();
  if (!command) throw new Error("Bang command requires a shell command after ! or !!");
  return { command, hidden };
}

export async function runSparkNativeBangCommand(
  command: string,
  hidden: boolean,
  cwd: string,
): Promise<string> {
  const result = await runShellCapture(command, cwd);
  if (hidden) {
    return `[hidden shell command completed]\ncommand: ${command}\nexit: ${result.code}`;
  }
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return [`$ ${command}`, `exit: ${result.code}`, output || "(no output)"].join("\n");
}

async function runShellCapture(
  command: string,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(process.env.SHELL ?? "/bin/sh", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 20_000) });
    });
  });
}

async function expandSparkNativeFileReference(pathText: string, basePath: string): Promise<string> {
  const absolutePath = resolveSparkNativeInputPath(pathText, basePath);
  const stats = await stat(absolutePath);
  if (stats.isDirectory()) return `<file name="${absolutePath}">[Directory reference]</file>`;
  const extension = extname(absolutePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return await expandSparkNativeImageReference(absolutePath);
  const content = await readFile(absolutePath, "utf8");
  return `<file name="${absolutePath}">\n${content}\n</file>`;
}

async function expandSparkNativeImageReferenceIfExists(
  pathText: string,
  basePath: string,
): Promise<string | undefined> {
  const absolutePath = resolveSparkNativeInputPath(pathText, basePath);
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const extension = extname(absolutePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return undefined;
  return await expandSparkNativeImageReference(absolutePath);
}

async function expandSparkNativeImageReference(absolutePath: string): Promise<string> {
  const stats = await stat(absolutePath);
  if (stats.size > MAX_NATIVE_IMAGE_BYTES) {
    throw new Error(
      `Image ${absolutePath} is ${stats.size} bytes; max inline image size is ${MAX_NATIVE_IMAGE_BYTES} bytes. Resize or compress it before submitting.`,
    );
  }
  const extension = extname(absolutePath).toLowerCase();
  const data = await readFile(absolutePath);
  const dimensions = detectImageDimensions(data, extension);
  if (
    dimensions &&
    (dimensions.width > MAX_NATIVE_IMAGE_DIMENSION ||
      dimensions.height > MAX_NATIVE_IMAGE_DIMENSION)
  ) {
    throw new Error(
      `Image ${absolutePath} is ${dimensions.width}x${dimensions.height}; max dimension is ${MAX_NATIVE_IMAGE_DIMENSION}px. Resize it before submitting.`,
    );
  }
  const mime = imageMimeType(extension);
  const dimensionAttrs = dimensions
    ? ` width="${dimensions.width}" height="${dimensions.height}"`
    : "";
  return `<image name="${escapeXmlAttribute(absolutePath)}" mime="${mime}" bytes="${stats.size}"${dimensionAttrs}>data:${mime};base64,${data.toString("base64")}</image>`;
}

function detectImageDimensions(
  data: Buffer,
  extension: string,
): { width: number; height: number } | undefined {
  if (extension === ".png" && data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (extension === ".gif" && data.length >= 10) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if ((extension === ".jpg" || extension === ".jpeg") && data.length >= 4) {
    return detectJpegDimensions(data);
  }
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function detectJpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    if (!length || offset + 2 + length > data.length) return undefined;
    if (
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf))
    ) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function imageMimeType(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function rangesOverlap(
  start: number,
  end: number,
  replacement: { start: number; end: number },
): boolean {
  return start < replacement.end && end > replacement.start;
}

function resolveSparkNativeInputPath(pathText: string, basePath: string): string {
  if (pathText.startsWith("file://")) return fileURLToPath(pathText);
  const expanded = pathText === "~" ? homedir() : pathText.replace(/^~(?=\/|$)/u, homedir());
  return isAbsolute(expanded) ? expanded : resolvePath(basePath, expanded);
}
