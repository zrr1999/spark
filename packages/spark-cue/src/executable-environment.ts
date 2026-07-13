import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Build the process environment used to launch cue-shell companion binaries.
 *
 * GUI and service managers commonly start Spark with a system-only PATH, while
 * cue-shell's supported installers place commands in ~/.local/bin (uv) or
 * ~/.cargo/bin (Cargo). Keep the caller's PATH authoritative, then add those
 * user-owned install locations without mutating the host process environment.
 */
export function cueShellProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const home = source.HOME?.trim() || homedir();
  const cargoHome = source.CARGO_HOME?.trim() || join(home, ".cargo");
  const pathEntries = [
    ...(source.PATH ?? "").split(delimiter),
    source.UV_TOOL_BIN_DIR,
    join(home, ".local", "bin"),
    join(cargoHome, "bin"),
  ];
  const seen = new Set<string>();
  const path = pathEntries
    .map((entry) => entry?.trim())
    .filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0 && !seen.has(entry),
    )
    .filter((entry) => {
      seen.add(entry);
      return true;
    })
    .join(delimiter);

  return { ...source, PATH: path };
}
