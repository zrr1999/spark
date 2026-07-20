import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkSkillResolver,
  formatSelectedSparkSkillsForPrompt,
  formatSparkSkillsForPrompt,
  loadMatchingSparkSkillsForPrompt,
  parseSkillFrontmatter,
} from "../apps/spark-tui/src/host/index.ts";
import { splitSparkSystemPrompt } from "../packages/spark-turn/src/agent-loop.ts";
import {
  loadBuiltinSkills,
  renderBuiltinSkillsForPrompt,
} from "../packages/pi-extension/src/extension/spark-builtin-skills.ts";

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

void test("parseSkillFrontmatter reads multiline block descriptions", () => {
  const parsed = parseSkillFrontmatter(
    "---\nname: cue\ndescription: |\n  First line.\n  第二行。\ndisabled: false\n---\n\n# Cue\n",
  );
  assert.equal(parsed.frontmatter.description, "First line.\n第二行。");
  assert.equal(parsed.frontmatter.disabled, false);
});

void test("loadBuiltinSkills and renderBuiltinSkillsForPrompt expose full base prompt bodies", async () => {
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
    assert.match(prompt, /<base_system_prompts>/);
    assert.match(prompt, /Follow these instructions directly/);
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
    const user = join(dir, "home", ".agents", "skills");
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
      userAgentsDir: user,
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
      userAgentsDir: join(dir, "none-user-agents"),
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
      userAgentsDir: join(dir, "none-user-agents"),
    });
    const result = await resolver.resolve();

    assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ["nested", "root-md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkSkillResolver discovers cross-harness .agents/skills and ignores their root .md files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-agents-"));
  try {
    const repo = join(dir, "repo");
    // Mark the repo root so project .agents/skills discovery stops here.
    await mkdir(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "nested", "pkg");
    await mkdir(cwd, { recursive: true });

    // Project .agents/skills: SKILL.md dir is a skill, root .md is ignored.
    await writeSkill(
      join(repo, ".agents", "skills"),
      "project-agent/SKILL.md",
      "name: project-agent\ndescription: Project agents skill\n",
    );
    await writeSkill(
      join(repo, ".agents", "skills"),
      "loose.md",
      "name: loose\ndescription: Root markdown skill that must be ignored\n",
    );

    // User ~/.agents/skills equivalent.
    const userAgents = join(dir, "home", ".agents", "skills");
    await writeSkill(
      userAgents,
      "user-agent/SKILL.md",
      "name: user-agent\ndescription: User agents skill\n",
    );

    const resolver = new SparkSkillResolver({
      cwd,
      builtinDirs: [join(dir, "none-builtin")],
      userDir: join(dir, "none-user"),
      userAgentsDir: userAgents,
    });
    const result = await resolver.resolve();

    assert.deepEqual(result.skills.map((skill) => skill.name).sort(), [
      "project-agent",
      "user-agent",
    ]);
    assert.doesNotMatch(formatSparkSkillsForPrompt(result.skills), /loose/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkSkillResolver lets the .agents/skills dir closest to cwd win a name collision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-agents-precedence-"));
  try {
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "nested");
    await mkdir(cwd, { recursive: true });

    await writeSkill(
      join(repo, ".agents", "skills"),
      "shared/SKILL.md",
      "name: shared\ndescription: Repo-root agents skill\n",
    );
    await writeSkill(
      join(cwd, ".agents", "skills"),
      "shared/SKILL.md",
      "name: shared\ndescription: Nearest agents skill\n",
    );

    const resolver = new SparkSkillResolver({
      cwd,
      builtinDirs: [join(dir, "none-builtin")],
      userDir: join(dir, "none-user"),
      userAgentsDir: join(dir, "none-user-agents"),
    });
    const result = await resolver.resolve();

    const shared = result.skills.find((skill) => skill.name === "shared");
    assert.equal(shared?.description, "Nearest agents skill");
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
      userAgentsDir: join(dir, "none-user-agents"),
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

void test("SparkSkillResolver includes spark-cue in the default native skill catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-default-cue-"));
  try {
    const resolver = new SparkSkillResolver({
      cwd: dir,
      userDir: join(dir, "none-user"),
      userAgentsDir: join(dir, "none-user-agents"),
      workspaceAgentsDirs: [],
    });
    const { skills } = await resolver.resolve();
    const cue = skills.find((skill) => skill.name === "spark-cue");

    assert.ok(cue);
    assert.match(cue.description, /cue-shell as the only execution backend/);
    const catalog = formatSparkSkillsForPrompt(skills);
    assert.match(catalog, /<name>spark-cue<\/name>/);
    assert.doesNotMatch(catalog, /# spark-cue/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("skill matching supports CJK request keywords", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-cjk-match-"));
  try {
    const builtin = join(dir, "builtin");
    await writeSkill(
      builtin,
      "architecture/SKILL.md",
      "name: architecture\ndescription: 用于优化代码架构和清理技术债\n",
      "# 架构优化\n保持边界清晰。\n",
    );
    await writeSkill(builtin, "mail/SKILL.md", "name: mail\ndescription: 用于发送和搜索电子邮件\n");

    const resolver = new SparkSkillResolver({
      cwd: dir,
      builtinDirs: [builtin],
      userDir: join(dir, "none"),
      userAgentsDir: join(dir, "none-user-agents"),
      workspaceAgentsDirs: [],
    });
    const matches = await resolver.loadMatchingSkillsForPrompt("帮我优化一下架构", 3);

    assert.deepEqual(
      matches.map((match) => match.skill.name),
      ["architecture"],
    );
    assert.match(matches[0]!.content, /# 架构优化/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("skill matching ignores one common CJK bigram shared by unrelated skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-cjk-common-term-"));
  try {
    const builtin = join(dir, "builtin");
    await writeSkill(
      builtin,
      "mail/SKILL.md",
      "name: agently-mail\ndescription: 通过命令行工具发送、搜索和读取电子邮件\n",
    );
    await writeSkill(
      builtin,
      "python/SKILL.md",
      "name: modern-python\ndescription: 用现代 Python 工具链初始化或改造项目\n",
    );
    await writeSkill(
      builtin,
      "preferences/SKILL.md",
      "name: tech-preferences\ndescription: 适用于技术选型和工具推荐\n",
    );

    const resolver = new SparkSkillResolver({
      cwd: dir,
      builtinDirs: [builtin],
      userDir: join(dir, "none"),
      userAgentsDir: join(dir, "none-user-agents"),
      workspaceAgentsDirs: [],
    });
    const matches = await resolver.loadMatchingSkillsForPrompt(
      "graft 之前对graft_read/write 做的特色功能现在考虑内化到 read/write工具上. 1-3 一起做吧",
      3,
    );

    assert.deepEqual(matches, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("selected skill bodies stay entirely in the dynamic prompt section", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-skills-dynamic-prompt-"));
  try {
    const skillPath = join(dir, "skill", "SKILL.md");
    await writeSkill(
      dir,
      "skill/SKILL.md",
      "name: selected\ndescription: Selected skill\n",
      "# Selected\n\nFirst paragraph.\n\nSecond paragraph.\n",
    );
    const selected = formatSelectedSparkSkillsForPrompt([
      {
        skill: {
          name: "selected",
          description: "Selected skill",
          filePath: skillPath,
          baseDir: join(dir, "skill"),
          layer: "workspace",
          disabled: false,
          disableModelInvocation: false,
          frontmatter: {},
        },
        content: await readFile(skillPath, "utf8"),
        score: 1,
      },
    ]);
    const split = splitSparkSystemPrompt(`Stable rules.\n\n${selected}`);

    assert.equal(split.stablePrompt, "Stable rules.");
    assert.match(split.dynamicPrompt, /# Selected/);
    assert.match(split.dynamicPrompt, /Second paragraph/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
