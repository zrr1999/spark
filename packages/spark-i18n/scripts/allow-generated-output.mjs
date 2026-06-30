import { readdir, readFile, rm, writeFile } from "node:fs/promises";

for (const path of ["src/paraglide/.gitignore", "src/paraglide/.prettierignore"]) {
  await rm(new URL(`../${path}`, import.meta.url), { force: true });
}

await stripTrailingWhitespace(new URL("../src/paraglide/", import.meta.url));

async function stripTrailingWhitespace(rootUrl) {
  const entries = await readdir(rootUrl, { withFileTypes: true });
  for (const entry of entries) {
    const url = new URL(entry.name, rootUrl);
    if (entry.isDirectory()) {
      await stripTrailingWhitespace(new URL(`${entry.name}/`, rootUrl));
      continue;
    }
    if (!entry.isFile() || !/\.(?:js|ts|json|md)$/u.test(entry.name)) {
      continue;
    }

    const source = await readFile(url, "utf8");
    const withTsNoCheck =
      entry.name.endsWith(".js") && !source.includes("// @ts-nocheck")
        ? source.startsWith("/* eslint-disable */")
          ? source.replace("/* eslint-disable */", "/* eslint-disable */\n// @ts-nocheck")
          : `// @ts-nocheck\n${source}`
        : source;
    const normalized = withTsNoCheck.replace(/[ \t]+$/gmu, "");
    if (normalized !== source) {
      await writeFile(url, normalized);
    }
  }
}
