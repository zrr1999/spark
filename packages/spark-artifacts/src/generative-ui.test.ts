import { describe, expect, it } from "vitest";
import {
  createSparkUiComponentCatalog,
  parseSparkUiSource,
  type SparkUiComponentBlock,
} from "./generative-ui";

describe("parseSparkUiSource", () => {
  it("parses markdown plus artifact, task, run, and callout blocks", () => {
    const result = parseSparkUiSource(`# Result

<ArtifactCard artifactRef="artifact:abc" title="Evidence" />
<TaskStatus taskRef="task:xyz" />
<RunTimeline runRef="run:123" variant="summary" />
<Callout type="warning" title="Careful">
Check the logs before merging.
</Callout>`);

    expect(result.diagnostics).toEqual([]);
    expect(result.blocks).toEqual([
      { type: "markdown", text: "# Result" },
      { type: "artifact", artifactRef: "artifact:abc", variant: "card", title: "Evidence" },
      { type: "task", taskRef: "task:xyz", variant: "status", title: undefined },
      { type: "run", runRef: "run:123", variant: "summary", title: undefined },
      {
        type: "callout",
        tone: "warning",
        title: "Careful",
        body: "Check the logs before merging.",
      },
    ]);
  });

  it("keeps allowed custom components as generic component blocks", () => {
    const catalog = createSparkUiComponentCatalog([
      { name: "MetricCard", kind: "component", allowedProps: ["label", "value"] },
    ]);
    const result = parseSparkUiSource('<MetricCard label="Coverage" value="98%" />', { catalog });

    expect(result.diagnostics).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      type: "component",
      name: "MetricCard",
      props: { label: "Coverage", value: "98%" },
    } satisfies Partial<SparkUiComponentBlock>);
  });

  it("downgrades unknown components to markdown with diagnostics", () => {
    const source = '<UnknownPanel answer="42" />';
    const result = parseSparkUiSource(source);

    expect(result.blocks).toEqual([{ type: "markdown", text: source }]);
    expect(result.diagnostics).toMatchObject([{ code: "unknown_component", severity: "warning" }]);
  });

  it("keeps JavaScript-like braces inert instead of surfacing expression errors", () => {
    const result = parseSparkUiSource(`## Score {notExecuted}
<Callout title={"Plan"}>
Use {literal} braces in prose.
</Callout>`);

    expect(result.diagnostics).toEqual([]);
    expect(result.blocks).toEqual([
      { type: "markdown", text: "## Score {notExecuted}" },
      {
        type: "callout",
        tone: "info",
        title: "Plan",
        body: "Use {literal} braces in prose.",
      },
    ]);
  });

  it("rejects unsafe statements, handlers, urls, and raw scripts", () => {
    const result = parseSparkUiSource(`import X from "./x"
<ArtifactCard artifactRef={artifactRef} />
<ArtifactCard artifactRef="artifact:abc" onclick="steal()" />
<MetricCard href="javascript:alert(1)" />
<script>alert(1)</script>`);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "unsupported_statement",
      "invalid_props",
      "invalid_props",
      "unknown_component",
      "dangerous_html",
    ]);
    expect(result.blocks).toEqual([
      {
        type: "markdown",
        text: `import X from "./x"
<ArtifactCard artifactRef={artifactRef} />
<ArtifactCard artifactRef="artifact:abc" onclick="steal()" />
<MetricCard href="javascript:alert(1)" />
<script>alert(1)</script>`,
      },
    ]);
  });

  it("reports invalid refs and props instead of emitting unsafe component blocks", () => {
    const result = parseSparkUiSource(`<ArtifactCard artifactRef="task:not-artifact" extra="nope" />
<TaskStatus taskRef="artifact:not-task" />
<RunTimeline runRef="task:not-run" />`);

    expect(result.blocks).toEqual([
      {
        type: "markdown",
        text: `<ArtifactCard artifactRef="task:not-artifact" extra="nope" />
<TaskStatus taskRef="artifact:not-task" />
<RunTimeline runRef="task:not-run" />`,
      },
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "invalid_props",
      "invalid_props",
      "invalid_props",
      "invalid_props",
    ]);
  });

  it("treats incomplete streaming tags as recoverable markdown", () => {
    const source = 'Before\n<ArtifactCard artifactRef="artifact:abc"';
    const result = parseSparkUiSource(source);

    expect(result.blocks).toEqual([{ type: "markdown", text: source }]);
    expect(result.diagnostics).toMatchObject([
      { code: "incomplete_component", severity: "warning" },
    ]);
  });

  it("keeps Spark UI-looking source inert inside fenced and indented Markdown code", () => {
    const source = [
      "```svelte",
      '<ArtifactCard artifactRef="artifact:abc" />',
      '<Callout type="warning">',
      "literal body",
      "</Callout>",
      "```",
      "",
      '    <TaskStatus taskRef="task:xyz" />',
      "",
      "~~~ts",
      'import X from "./x"',
      "<script>literal source</script>",
      "~~~~",
    ].join("\n");

    const result = parseSparkUiSource(source);

    expect(result.blocks).toEqual([{ type: "markdown", text: source }]);
    expect(result.diagnostics).toEqual([]);
  });
});
