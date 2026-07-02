/**
 * Path resolution helpers for file tools.
 *
 * Mirrors the resolution behaviour pi-coding-agent uses (cwd-relative + `~`
 * expansion + macOS screenshot filename variants), but depends only on Node.
 */

import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

const NARROW_NO_BREAK_SPACE = "\u202F";

/** Expand a leading `~` / `~/...` to the user's home directory. */
function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolvePathSegments(homedir(), filePath.slice(2));
  return filePath;
}

/**
 * Resolve a path relative to the given cwd. Handles `~` expansion, an optional
 * leading `@` reference prefix (used by `@file` mentions), and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  let candidate = filePath.trim();
  if (candidate.startsWith("@")) candidate = candidate.slice(1);
  candidate = expandHome(candidate);
  if (isAbsolute(candidate)) return resolvePathSegments(candidate);
  return resolvePathSegments(cwd, candidate);
}

function fileExistsSync(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function tryMacOsScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNfdVariant(filePath: string): string {
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "\u2019");
}

/**
 * Resolve a read path, probing common macOS filename variants when the exact
 * path does not exist (narrow-no-break-space before AM/PM, NFD-normalised
 * names, curly apostrophes).
 */
export async function resolveReadPath(filePath: string, cwd: string): Promise<string> {
  const resolved = resolveToCwd(filePath, cwd);
  if (await pathExists(resolved)) return resolved;

  const amPm = tryMacOsScreenshotPath(resolved);
  if (amPm !== resolved && (await pathExists(amPm))) return amPm;

  const nfd = tryNfdVariant(resolved);
  if (nfd !== resolved && (await pathExists(nfd))) return nfd;

  const curly = tryCurlyQuoteVariant(resolved);
  if (curly !== resolved && (await pathExists(curly))) return curly;

  const nfdCurly = tryCurlyQuoteVariant(nfd);
  if (nfdCurly !== resolved && (await pathExists(nfdCurly))) return nfdCurly;

  return resolved;
}

export function resolveReadPathSync(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);
  if (fileExistsSync(resolved)) return resolved;

  const amPm = tryMacOsScreenshotPath(resolved);
  if (amPm !== resolved && fileExistsSync(amPm)) return amPm;

  const nfd = tryNfdVariant(resolved);
  if (nfd !== resolved && fileExistsSync(nfd)) return nfd;

  const curly = tryCurlyQuoteVariant(resolved);
  if (curly !== resolved && fileExistsSync(curly)) return curly;

  const nfdCurly = tryCurlyQuoteVariant(nfd);
  if (nfdCurly !== resolved && fileExistsSync(nfdCurly)) return nfdCurly;

  return resolved;
}
