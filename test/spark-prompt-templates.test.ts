import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { createSparkPromptTemplateSlashCommands } from "../apps/spark-tui/src/cli/prompt-template-commands.ts";
import {
  SparkPromptTemplateResolver,
  parseSparkPromptTemplateArgs,
  substituteSparkPromptTemplateArgs,
  type SparkPromptTemplate,
} from "../apps/spark-tui/src/host/index.ts";
import { createSparkNativeTuiHarness } from "./support/spark-native-tui-harness.ts";

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

test("Spark prompt templates resolve user, workspace, and configured paths with deterministic precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-prompts-resolve-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, "spark-home");
    const configured = join(dir, "configured-prompts");
    await mkdir(join(sparkHome, "prompts", "nested"), { recursive: true });
    await mkdir(join(cwd, ".spark", "prompts"), { recursive: true });
    await mkdir(configured, { recursive: true });

    await writeFile(
      join(sparkHome, "prompts", "review.md"),
      "---\ndescription: User review\n---\nUser review $1\n",
      "utf8",
    );
    await writeFile(
      join(sparkHome, "prompts", "nested", "ignored.md"),
      "Nested prompt should not be discovered\n",
      "utf8",
    );
    await writeFile(
      join(cwd, ".spark", "prompts", "review.md"),
      "---\ndescription: Workspace review\n---\nWorkspace review $1\n",
      "utf8",
    );
    await writeFile(
      join(configured, "review.md"),
      '---\ndescription: Configured review\nargument-hint: "<topic>"\n---\nConfigured review ${1:-changes}\n',
      "utf8",
    );
    await writeFile(join(configured, "component.md"), "Create component $1\n", "utf8");
    await writeFile(
      join(configured, "disabled.md"),
      "---\ndescription: Disabled prompt\ndisabled: true\n---\nShould not load\n",
      "utf8",
    );
    await writeFile(
      join(configured, "malformed.md"),
      "---\ndescription: Missing closing delimiter\nStill safe as plain Markdown\n",
      "utf8",
    );

    const result = await new SparkPromptTemplateResolver({
      cwd,
      sparkHome,
      promptTemplatePaths: [configured],
    }).resolve();

    assert.deepEqual(
      result.templates.map((template) => template.name),
      ["component", "malformed", "review"],
    );
    const review = result.templates.find((template) => template.name === "review");
    assert.equal(review?.layer, "configured");
    assert.equal(review?.description, "Configured review");
    assert.equal(review?.argumentHint, "<topic>");
    assert.match(review?.content ?? "", /Configured review/);
    assert.equal(
      result.diagnostics.filter((diagnostic) => diagnostic.type === "collision").length,
      2,
    );
    assert.equal(
      result.templates.some((template) => template.name === "disabled"),
      false,
      "disabled prompt templates should not register",
    );
    assert.equal(
      result.templates.some((template) => template.name === "ignored"),
      false,
      "prompt discovery should be non-recursive",
    );
    assert.equal(
      result.diagnostics.some((diagnostic) => /disabled by frontmatter/u.test(diagnostic.message)),
      true,
    );
    assert.equal(
      result.diagnostics.some((diagnostic) =>
        /Malformed prompt template frontmatter/u.test(diagnostic.message),
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark prompt template argument substitution matches Pi positional, default, and slice semantics", () => {
  const args = parseSparkPromptTemplateArgs("Button \"click handler\" 'disabled state'");
  assert.deepEqual(args, ["Button", "click handler", "disabled state"]);
  assert.equal(
    substituteSparkPromptTemplateArgs(
      "name=$1 all=$@ alias=$ARGUMENTS tail=${@:2} one=${@:2:1} zero=${@:0} missing=${4:-none} literal=${5:-$1}",
      args,
    ),
    "name=Button all=Button click handler disabled state alias=Button click handler disabled state tail=click handler disabled state one=click handler zero=Button click handler disabled state missing=none literal=$1",
  );
});

test("Spark prompt templates register as slash commands without overriding builtins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-prompts-slash-"));
  try {
    await writeFile(join(dir, "note.txt"), "template file context", "utf8");
    const component = promptTemplate({
      name: "component",
      description: "Create component",
      argumentHint: "<name> [features]",
      content: "Create $1 with $@. Include @note.txt Default=${3:-none}",
      filePath: join(dir, "component.md"),
    });
    const help = promptTemplate({
      name: "help",
      description: "Should not replace native help",
      content: "bad",
      filePath: join(dir, "help.md"),
    });
    const commands = createSparkPromptTemplateSlashCommands(
      { cwd: dir, promptTemplates: { templates: [component, help], diagnostics: [] } },
      { reservedNames: ["help"] },
    );
    assert.equal(commands.help, undefined);
    assert.ok(commands.component);

    const submitted: string[] = [];
    const harness = createSparkNativeTuiHarness({
      slashCommands: commands,
      autocompleteBasePath: dir,
      responder: (input) => {
        submitted.push(input);
        return `ack:${input}`;
      },
    });

    await typeEditorText(harness, "/c");
    await harness.flush();
    assert.match(stripAnsi(harness.render()), /component\s+<name> \[features\] — Create component/);
    harness.app.setEditorText("");

    assert.equal(await harness.submit('/component Button "click handler"'), "command");
    await waitForNativeTimers();
    await harness.flush();

    assert.match(submitted.at(-1) ?? "", /Create Button with Button click handler/);
    assert.match(
      submitted.at(-1) ?? "",
      /<file name=".*note\.txt">\ntemplate file context\n<\/file>/s,
    );
    assert.match(submitted.at(-1) ?? "", /Default=none/);

    assert.equal(await harness.submit("/help"), "command");
    await harness.flush();
    assert.equal(submitted.length, 1, "built-in /help should not submit a template prompt");
    assert.match(stripAnsi(harness.render()), /Spark native TUI commands:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function promptTemplate(
  input: Omit<SparkPromptTemplate, "baseDir" | "layer">,
): SparkPromptTemplate {
  return {
    ...input,
    baseDir: join(input.filePath, ".."),
    layer: "configured",
  };
}

async function typeEditorText(
  harness: ReturnType<typeof createSparkNativeTuiHarness>,
  text: string,
): Promise<void> {
  for (const char of text) await harness.press(char);
}

async function waitForNativeTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}
