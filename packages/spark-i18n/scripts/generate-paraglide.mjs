import { mkdir, readFile, writeFile } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);
const messagesRoot = new URL("messages/", packageRoot);
const outputRoot = new URL("src/paraglide/", packageRoot);
const outputMessagesRoot = new URL("messages/", outputRoot);

const locales = ["en", "zh-CN"];
const baseLocale = "en";

const catalogs = Object.fromEntries(
  await Promise.all(
    locales.map(async (locale) => [
      locale,
      JSON.parse(await readFile(new URL(`${locale}.json`, messagesRoot), "utf8")),
    ]),
  ),
);

const keys = Object.keys(catalogs[baseLocale]).filter((key) => !key.startsWith("$"));
for (const locale of locales) {
  for (const key of keys) {
    if (typeof catalogs[locale][key] !== "string") {
      throw new Error(`missing string message ${key} for locale ${locale}`);
    }
  }
}

for (const key of keys) {
  if (!/^[A-Za-z_$][\w$]*$/u.test(key)) {
    throw new Error(`message key ${key} is not a valid JavaScript export identifier`);
  }
}

await mkdir(outputMessagesRoot, { recursive: true });

const messageTable = Object.fromEntries(
  keys.map((key) => [
    key,
    Object.fromEntries(locales.map((locale) => [locale, catalogs[locale][key]])),
  ]),
);

const indexJs = `/* eslint-disable */
// @ts-nocheck
import { getLocale } from "../runtime.js";

/** @typedef {import("../runtime.js").LocalizedString} LocalizedString */

const messages = ${JSON.stringify(messageTable, null, 2)};

function resolveLocale(options) {
  return options?.locale ?? getLocale();
}

function formatMessage(template, params = {}) {
  return template.replace(/\\{([A-Za-z_$][\\w$]*)\\}/gu, (_match, name) =>
    params[name] === undefined || params[name] === null ? "" : String(params[name]),
  );
}

function readMessage(key, params, options) {
  const locale = resolveLocale(options);
  const messagesForKey = messages[key];
  return formatMessage(messagesForKey[locale] ?? messagesForKey.${baseLocale}, params);
}

${keys
  .map(
    (key) =>
      `export const ${key} = (params = {}, options = {}) => readMessage(${JSON.stringify(key)}, params, options);`,
  )
  .join("\n")}
`;

const indexDts = `type LocalizedString = import("../runtime.js").LocalizedString;
type Locale = import("../runtime.js").Locale;
type MessageParams = Record<string, unknown>;
type MessageOptions = { locale?: Locale };

${keys
  .map(
    (key) =>
      `export declare const ${key}: (params?: MessageParams, options?: MessageOptions) => LocalizedString;`,
  )
  .join("\n")}
`;

await writeFile(new URL("messages/_index.js", outputRoot), indexJs);
await writeFile(new URL("messages/_index.d.ts", outputRoot), indexDts);
await writeFile(
  new URL("messages/package.json", outputRoot),
  '{"type":"module","sideEffects":false}\n',
);
await writeFile(
  new URL("messages.js", outputRoot),
  `/* eslint-disable */
// @ts-nocheck
export * from "./messages/_index.js";
// enabling auto-import by exposing all messages as m
export * as m from "./messages/_index.js";
`,
);
await writeFile(
  new URL("messages.d.ts", outputRoot),
  `export * from "./messages/_index.js";
export * as m from "./messages/_index.js";
`,
);
