import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const MISSING_FILE_VERSION = "missing" as const;

export type FileContentVersion = `sha256:${string}`;
export type FileVersionState = FileContentVersion | typeof MISSING_FILE_VERSION;
export type FileLineEnding = "none" | "lf" | "crlf" | "cr" | "mixed";

export interface FileLineAnchor {
  line: number;
  hash: string;
  anchor: string;
  text: string;
}

export interface FileReadWindow {
  startLine: number;
  endLine?: number;
  nextOffset?: number;
  requestedLimit?: number;
  anchors: FileLineAnchor[];
}

export interface FileReadMetadata {
  version: FileContentVersion;
  sizeBytes: number;
  encoding: "utf-8";
  bom: "utf8" | "none";
  lineEnding: FileLineEnding;
  totalLines: number;
  window: FileReadWindow;
}

export interface AtomicReplaceResult {
  ok: true;
  version: FileContentVersion;
  previousVersion: FileVersionState;
  sizeBytes: number;
}

export interface AtomicReplaceConflict {
  ok: false;
  expectedVersion: FileVersionState;
  actualVersion: FileVersionState;
}

const CONTENT_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
// Serializes the snapshot/check/commit sequence for cooperative writers in this
// process. Filesystem actors outside Spark still require the version recheck.
const fileWriteQueues = new Map<string, Promise<void>>();

export function contentVersion(content: Uint8Array): FileContentVersion {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function isFileVersionPrecondition(value: string): value is FileVersionState {
  return value === MISSING_FILE_VERSION || CONTENT_VERSION_PATTERN.test(value);
}

export function createFileReadMetadata(input: {
  buffer: Buffer;
  lines: string[];
  startLineIndex: number;
  outputLineCount: number;
  requestedLimit?: number;
  nextOffset?: number;
}): FileReadMetadata {
  const hasBom = hasUtf8Bom(input.buffer);
  const visibleLines = input.lines.slice(
    input.startLineIndex,
    input.startLineIndex + input.outputLineCount,
  );
  const anchors = visibleLines.map((lineText, index) => {
    const line = input.startLineIndex + index + 1;
    const normalizedText = normalizeAnchorText(lineText, line === 1 && hasBom);
    const hash = createHash("sha256").update(normalizedText, "utf8").digest("hex").slice(0, 12);
    return {
      line,
      hash,
      anchor: `${line}#${hash}:${normalizedText}`,
      text: normalizedText,
    };
  });
  const window: FileReadWindow = {
    startLine: input.startLineIndex + 1,
    anchors,
  };
  if (anchors.length > 0) window.endLine = anchors.at(-1)?.line;
  if (input.nextOffset !== undefined) window.nextOffset = input.nextOffset;
  if (input.requestedLimit !== undefined) window.requestedLimit = input.requestedLimit;

  const decoded = input.buffer.toString("utf8");
  return {
    version: contentVersion(input.buffer),
    sizeBytes: input.buffer.byteLength,
    encoding: "utf-8",
    bom: hasBom ? "utf8" : "none",
    lineEnding: detectFileLineEnding(hasBom ? decoded.slice(1) : decoded),
    totalLines: input.lines.length,
    window,
  };
}

export async function atomicReplaceTextFile(
  filePath: string,
  content: string,
  options: { expectedVersion: FileVersionState; signal?: AbortSignal },
): Promise<AtomicReplaceResult | AtomicReplaceConflict> {
  return withFileWriteLock(filePath, options.signal, () =>
    atomicReplaceTextFileUnlocked(filePath, content, options),
  );
}

async function atomicReplaceTextFileUnlocked(
  filePath: string,
  content: string,
  options: { expectedVersion: FileVersionState; signal?: AbortSignal },
): Promise<AtomicReplaceResult | AtomicReplaceConflict> {
  throwIfAborted(options.signal);
  const before = await readFileSnapshot(filePath);
  if (before.version !== options.expectedVersion) {
    return {
      ok: false,
      expectedVersion: options.expectedVersion,
      actualVersion: before.version,
    };
  }

  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  throwIfAborted(options.signal);

  const bytes = Buffer.from(content, "utf8");
  const version = contentVersion(bytes);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;
  try {
    temporaryHandle = await open(temporaryPath, "wx", before.mode ?? 0o666);
    if (before.mode !== undefined) await temporaryHandle.chmod(before.mode);
    await temporaryHandle.writeFile(bytes);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    throwIfAborted(options.signal);

    const current = await readFileSnapshot(filePath);
    if (current.version !== before.version) {
      return {
        ok: false,
        expectedVersion: options.expectedVersion,
        actualVersion: current.version,
      };
    }

    throwIfAborted(options.signal);
    await assertTargetIsNotSymlink(filePath);
    throwIfAborted(options.signal);
    if (options.expectedVersion === MISSING_FILE_VERSION) {
      try {
        // link(2) gives create-only writes an atomic no-replace commit point;
        // rename(2) would silently overwrite a file created after the check.
        await link(temporaryPath, filePath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const current = await readFileSnapshot(filePath);
        return {
          ok: false,
          expectedVersion: options.expectedVersion,
          actualVersion: current.version,
        };
      }
      replaced = true;
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return {
        ok: true,
        version,
        previousVersion: before.version,
        sizeBytes: bytes.byteLength,
      };
    }
    await rename(temporaryPath, filePath);
    replaced = true;
    return {
      ok: true,
      version,
      previousVersion: before.version,
      sizeBytes: bytes.byteLength,
    };
  } finally {
    if (temporaryHandle !== undefined) {
      await temporaryHandle.close().catch(() => undefined);
    }
    if (!replaced) await rm(temporaryPath, { force: true });
  }
}

function hasUtf8Bom(content: Uint8Array): boolean {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
}

function normalizeAnchorText(text: string, stripBom: boolean): string {
  let normalized = stripBom && text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (normalized.endsWith("\r")) normalized = normalized.slice(0, -1);
  return normalized;
}

function detectFileLineEnding(content: string): FileLineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\r" && content[index + 1] === "\n") {
      crlf += 1;
      index += 1;
    } else if (character === "\r") {
      cr += 1;
    } else if (character === "\n") {
      lf += 1;
    }
  }
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "crlf";
  return cr > 0 ? "cr" : "lf";
}

async function readFileSnapshot(
  filePath: string,
): Promise<{ version: FileVersionState; mode?: number }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW closes the final-component lstat/open race; O_NONBLOCK lets
    // us inspect and reject FIFOs/devices without waiting on another process.
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) {
      const error = new Error(
        `Refusing to replace non-regular file: ${filePath}`,
      ) as NodeJS.ErrnoException;
      error.code = info.isDirectory() ? "EISDIR" : "EINVAL";
      throw error;
    }
    const bytes = await handle.readFile();
    return { version: contentVersion(bytes), mode: info.mode & 0o777 };
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw symbolicLinkError(filePath);
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: MISSING_FILE_VERSION };
    }
    throw error;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function assertTargetIsNotSymlink(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      throw symbolicLinkError(filePath);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function symbolicLinkError(filePath: string): NodeJS.ErrnoException {
  const error = new Error(
    `Refusing to atomically replace symbolic link: ${filePath}`,
  ) as NodeJS.ErrnoException;
  error.code = "ELOOP";
  return error;
}

async function withFileWriteLock<T>(
  filePath: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await canonicalWriteKey(filePath);
  const previous = fileWriteQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  fileWriteQueues.set(key, tail);

  try {
    await waitForLock(previous, signal);
    throwIfAborted(signal);
    return await operation();
  } finally {
    release();
    void tail.then(() => {
      if (fileWriteQueues.get(key) === tail) fileWriteQueues.delete(key);
    });
  }
}

/** Coalesce lexical aliases, including symlinked parent directories. */
async function canonicalWriteKey(filePath: string): Promise<string> {
  const absolutePath = resolve(filePath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  const unresolvedParts: string[] = [basename(absolutePath)];
  let ancestor = dirname(absolutePath);
  while (true) {
    try {
      return join(await realpath(ancestor), ...unresolvedParts.reverse());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return absolutePath;
    unresolvedParts.push(basename(ancestor));
    ancestor = parent;
  }
}

async function waitForLock(lock: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await lock;
    return;
  }

  let rejectOnAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([lock, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  return new Error("Operation aborted");
}
