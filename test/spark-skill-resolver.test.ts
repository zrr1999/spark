import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkSkillResolver,
  formatSparkSkillsForPrompt,
  loadMatchingSparkSkillsForPrompt,
  parseSkillFrontmatter,
} from "../packages/spark-cli/src/host/index.ts";
import {
  loadBuiltinSkills,
  renderBuiltinSkillsForPrompt,
} from "../packages/spark/src/extension/spark-builtin-skills.ts";

async function writeSkill(
  root: string,
  rel: string,
  frontmatter: string,
  body = "# Skill body\n",
): Promise<void> {
  const path = join(root, rel);
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, `---\n${frontmatter}---\n\n${body}`, "utf8");
}

void test("parseSkillFrontmatter reads skill metadata booleans and body", () => {
  const parsed = parseSkillFrontmatter(
    "---\nname: demo-skill\ndescription: Demo description\ndisabled: true\ndisable-model-invocation: false\n---\n\n# Demo\n",
  );
  assert.deepEqual(parsed.frontmatter, {
    name: "demo-skill",
    description: "Demo description",
    disabled: true,
    "disable-model-invocation": false,
  });
  assert.equal(parsed.body, "# Demo\n");
});

void test("loadBuiltinSkills and renderBuiltinSkillsForPrompt expose full builtin bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-builtin-skills-fulltext-"));
  try {
    await writeSkill(
      dir,
      "spark/SKILL.md",
      "name: spark\ndescription: Builtin Spark skill\ndisable-model-invocation: true\n",
      "# Spark\nAlways follow builtin instructions.\n",
    );

    const skills = await loadBuiltinSkills(dir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "spark");
    assert.equal(skills[0]!.disableModelInvocation, true);
    assert.match(skills[0]!.body, /Always follow builtin instructions/);

    const prompt = renderBuiltinSkillsForPrompt(skills);
    assert.match(prompt, /<builtin_skills>/);
    assert.match(prompt, /Do not use the read tool/);
    assert.match(prompt, /Always follow builtin instructions/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkSkillResolver discovers builtin, workspace, and user skills with user override precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-precedence-"));
  try {
    const builtin = join(dir, "builtin");
    const workspace = join(dir, "repo", ".spark", "skills");
    const user = join(dir, "home", "skills");
    await writeSkill(
      builtin,
      "shared/SKILL.md",
      "name: shared\ndescription: Builtin shared skill\n",
      "# Builtin shared\n",
    );
    await writeSkill(
      workspace,
      "shared/SKILL.md",
      "name: shared\ndescription: Workspace shared skill\n",
      "# Workspace shared\n",
    );
    await writeSkill(
      user,
      "shared/SKILL.md",
      "name: shared\ndescription: User shared skill\n",
      "# User shared\n",
    );
    await writeSkill(
      builtin,
      "builtin-only/SKILL.md",
      "name: builtin-only\ndescription: Builtin only skill\n",
    );

    const resolver = new SparkSkillResolver({
      cwd: join(dir, "repo"),
      builtinDirs: [builtin],
      userDir: user,
    });
    const result = await resolver.resolve();

    assert.deepEqual(result.skills.map((skill) => `${skill.name}:${skill.layer}`).sort(), [
      "builtin-only:builtin",
      "shared:user",
    ]);
    assert.equal(
      result.skills.find((skill) => skill.name === "shared")!.description,
      "User shared skill",
    );
    assert.equal(
      result.diagnostics.filter((diagnostic) => diagnostic.type === "collision").length,
      2,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkSkillResolver skips disabled skills and hides disable-model-invocation from prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-visibility-"));
  try {
    const builtin = join(dir, "builtin");
    await writeSkill(builtin, "visible/SKILL.md", "name: visible\ndescription: Visible skill\n");
    await writeSkill(
      builtin,
      "disabled/SKILL.md",
      "name: disabled\ndescription: Disabled skill\ndisabled: true\n",
    );
    await writeSkill(
      builtin,
      "command-only/SKILL.md",
      "name: command-only\ndescription: Command only skill\ndisable-model-invocation: true\n",
    );

    const resolver = new SparkSkillResolver({
      cwd: dir,
      builtinDirs: [builtin],
      userDir: join(dir, "none"),
    });
    const result = await resolver.resolve();
    assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ["command-only", "visible"]);

    const prompt = formatSparkSkillsForPrompt(result.skills);
    assert.match(prompt, /<name>visible<\/name>/);
    assert.doesNotMatch(prompt, /command-only/);
    assert.doesNotMatch(prompt, /disabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkSkillResolver follows Pi-style discovery roots and does not recurse below SKILL.md roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-discovery-"));
  try {
    const skillsDir = join(dir, "skills");
    await writeSkill(skillsDir, "root-md.md", "name: root-md\ndescription: Root markdown skill\n");
    await writeSkill(skillsDir, "nested/SKILL.md", "name: nested\ndescription: Nested skill\n");
    await writeSkill(
      skillsDir,
      "nested/ignored/SKILL.md",
      "name: ignored\ndescription: Ignored nested skill\n",
    );

    const resolver = new SparkSkillResolver({
      cwd: dir,
      builtinDirs: [skillsDir],
      userDir: join(dir, "none"),
    });
    const result = await resolver.resolve();

    assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ["nested", "root-md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("loadMatchingSparkSkillsForPrompt loads full SKILL.md content by description match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-match-"));
  try {
    const builtin = join(dir, "builtin");
    await writeSkill(
      builtin,
      "svg/SKILL.md",
      "name: svg-design\ndescription: Create and optimize SVG icons and logos\n",
      "# SVG\nUse paths.\n",
    );
    await writeSkill(
      builtin,
      "python/SKILL.md",
      "name: python\ndescription: Python packaging with uv and ruff\n",
      "# Python\nUse uv.\n",
    );

    const resolver = new SparkSkillResolver({
      cwd: dir,
      builtinDirs: [builtin],
      userDir: join(dir, "none"),
    });
    const { skills } = await resolver.resolve();
    const matches = await loadMatchingSparkSkillsForPrompt(skills, "please design an svg logo", 1);

    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.skill.name, "svg-design");
    assert.match(matches[0]!.content, /# SVG/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
