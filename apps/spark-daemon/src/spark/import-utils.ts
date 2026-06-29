import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

async function dynamicImport<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

/**
 * Import a package specifier through its real file path when possible.
 *
 * Node's --experimental-strip-types refuses to load TypeScript files whose
 * resolved URL contains node_modules. Workspace packages are symlinked through
 * node_modules during local development, so importing the package specifier
 * directly can fail even though the real source file lives outside node_modules.
 */
export async function importWorkspaceAware<T>(specifier: string): Promise<T> {
  const resolved = import.meta.resolve(specifier);
  if (!resolved.startsWith("file:")) return await dynamicImport<T>(specifier);

  const resolvedPath = fileURLToPath(resolved);
  const realPath = await realpath(resolvedPath).catch(() => resolvedPath);
  return await dynamicImport<T>(pathToFileURL(realPath).href);
}
