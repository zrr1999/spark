#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const baselinePath = join(repositoryRoot, "test", "test-quality-baseline.json");
const scanRoots = ["test", "packages", "apps"];
const ignoredDirectories = new Set([
  ".git",
  ".stryker-tmp",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "reports",
]);
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const productionSourcePattern = /\.(?:[cm]?[jt]sx?|svelte)(?:["'`)]|$)/u;
const fragmentMatcherNames = new Set(["toContain", "toMatch"]);
const nodeAssertMatcherNames = new Set(["match", "doesNotMatch"]);

function scriptKind(fileName) {
  switch (extname(fileName)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function expectArgument(call) {
  let expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return undefined;
  }
  if (!fragmentMatcherNames.has(propertyName(expression) ?? "")) return undefined;

  let receiver = expression.expression;
  if (
    (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) &&
    propertyName(receiver) === "not"
  ) {
    receiver = receiver.expression;
  }
  if (!ts.isCallExpression(receiver) || !ts.isIdentifier(receiver.expression)) return undefined;
  if (receiver.expression.text !== "expect") return undefined;
  return receiver.arguments[0];
}

function assertArgument(call, assertBindings) {
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return undefined;
  }
  if (!nodeAssertMatcherNames.has(propertyName(expression) ?? "")) return undefined;
  if (!ts.isIdentifier(expression.expression) || !assertBindings.has(expression.expression.text)) {
    return undefined;
  }
  return call.arguments[0];
}

function declarationText(name, declarations, sourceFile) {
  const initializer = declarations.get(name);
  return initializer?.getText(sourceFile) ?? "";
}

function readCallFrom(initializer) {
  const expression = unwrapExpression(initializer);
  return ts.isCallExpression(expression) ? expression : undefined;
}

export function findSourceMirrorAssertions(sourceText, fileName = "fixture.test.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const readBindings = new Set();
  const assertBindings = new Set();
  const declarations = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleName = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (
        (moduleName === "node:fs" ||
          moduleName === "fs" ||
          moduleName === "node:fs/promises" ||
          moduleName === "fs/promises") &&
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "readFile" || imported === "readFileSync") {
            readBindings.add(element.name.text);
          }
        }
      }
      if ((moduleName === "node:assert/strict" || moduleName === "assert/strict") && clause?.name) {
        assertBindings.add(clause.name.text);
      }
    }
  }

  function collectDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);

  const sourceVariables = new Set();
  for (const [name, initializer] of declarations) {
    const readCall = readCallFrom(initializer);
    if (!readCall || !ts.isIdentifier(readCall.expression)) continue;
    if (!readBindings.has(readCall.expression.text)) continue;

    const pathArgument = readCall.arguments[0];
    if (!pathArgument) continue;
    const pathText = ts.isIdentifier(pathArgument)
      ? declarationText(pathArgument.text, declarations, sourceFile)
      : pathArgument.getText(sourceFile);
    if (productionSourcePattern.test(pathText)) sourceVariables.add(name);
  }

  const findings = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const argument = expectArgument(node) ?? assertArgument(node, assertBindings);
      if (argument && ts.isIdentifier(unwrapExpression(argument))) {
        const name = unwrapExpression(argument).text;
        if (sourceVariables.has(name)) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          findings.push({
            file: fileName,
            line: position.line + 1,
            sourceVariable: name,
            assertion: node.expression.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTestFiles(path)));
    else if (entry.isFile() && testFilePattern.test(entry.name)) files.push(path);
  }
  return files;
}

function normalizedRelativePath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

async function scanRepository() {
  const paths = (
    await Promise.all(scanRoots.map((root) => collectTestFiles(join(repositoryRoot, root))))
  )
    .flat()
    .sort((left, right) => left.localeCompare(right));
  const findingsByFile = {};
  for (const path of paths) {
    const file = normalizedRelativePath(path);
    const sourceText = await readFile(path, "utf8");
    const findings = findSourceMirrorAssertions(sourceText, file);
    if (findings.length > 0) findingsByFile[file] = findings;
  }
  return findingsByFile;
}

function countsFor(findingsByFile) {
  return Object.fromEntries(
    Object.entries(findingsByFile)
      .map(([file, findings]) => [file, findings.length])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function readBaseline() {
  return JSON.parse(await readFile(baselinePath, "utf8"));
}

async function updateBaseline(counts) {
  const baseline = {
    $schema: "./test-quality-baseline.schema.json",
    sourceMirrorAssertions: counts,
  };
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

async function main() {
  const findingsByFile = await scanRepository();
  const actual = countsFor(findingsByFile);
  if (process.argv.includes("--update")) {
    await updateBaseline(actual);
    console.log(
      `Updated test-quality baseline: ${Object.keys(actual).length} files, ${Object.values(actual).reduce((sum, count) => sum + count, 0)} source-mirror assertions.`,
    );
    return;
  }

  const baseline = await readBaseline();
  const expected = baseline.sourceMirrorAssertions ?? {};
  const files = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(
    (left, right) => left.localeCompare(right),
  );
  const drift = files.filter((file) => expected[file] !== actual[file]);
  if (drift.length === 0) {
    console.log(
      `Test-quality ratchet passed: ${Object.keys(actual).length} legacy files, ${Object.values(actual).reduce((sum, count) => sum + count, 0)} source-mirror assertions.`,
    );
    return;
  }

  for (const file of drift) {
    const before = expected[file] ?? 0;
    const after = actual[file] ?? 0;
    console.error(`${file}: source-mirror assertions changed ${before} -> ${after}.`);
    if (after > before) {
      for (const finding of findingsByFile[file]?.slice(before) ?? []) {
        console.error(
          `  ${finding.file}:${finding.line} ${finding.assertion} asserts fragments of production source via ${finding.sourceVariable}.`,
        );
      }
    }
  }
  console.error(
    "Replace production-source fragment assertions with observable behavior, a schema/AST boundary, or an explicitly reviewed full golden. If reviewed debt was removed, run `pnpm run check:test-quality:update` and commit the lower baseline.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
