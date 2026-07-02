import { parseSparkUiSource } from "@zendev-lab/spark-artifacts/generative-ui";
import { describe, expect, it } from "vitest";
import { parseSafeMarkdown } from "./safe-markdown";

describe("safe markdown renderer model", () => {
  it("parses common Markdown blocks without producing executable HTML", () => {
    const blocks = parseSafeMarkdown(`# Title

- one
- two

> quoted

\`\`\`ts
console.log('safe as text');
\`\`\``);

    expect(blocks).toEqual([
      { type: "heading", depth: 1, text: "Title" },
      { type: "list", ordered: false, items: ["one", "two"] },
      { type: "quote", lines: ["quoted"] },
      { type: "code", language: "ts", code: "console.log('safe as text');" },
    ]);
  });

  it("maps the streaming Spark UI smoke sample to renderable blocks with source fallback", () => {
    const source = `## Build report

<ArtifactCard artifactRef="artifact:1eac9821-4557-4b0b-a184-72e2a333f1ce" title="Rename evidence" />
<TaskStatus taskRef="task:d59a3df0-20e6-4d09-94bc-7d3684203fc5" />
<Callout tone="warning" title="Safe fallback">
<script>alert('not executed')</script>
</Callout>`;

    const document = parseSparkUiSource(source);

    expect(document.blocks.map((block) => block.type)).toEqual([
      "markdown",
      "artifact",
      "task",
      "callout",
    ]);
    expect(document.blocks[1]).toMatchObject({
      type: "artifact",
      artifactRef: "artifact:1eac9821-4557-4b0b-a184-72e2a333f1ce",
      title: "Rename evidence",
    });
    expect(document.blocks[2]).toMatchObject({
      type: "task",
      taskRef: "task:d59a3df0-20e6-4d09-94bc-7d3684203fc5",
    });
    expect(document.blocks[3]).toMatchObject({
      type: "callout",
      tone: "warning",
      title: "Safe fallback",
      body: "<script>alert('not executed')</script>",
    });
    expect(source).toContain("<ArtifactCard");
  });

  it("keeps raw HTML/script-looking Markdown as escaped paragraph text", () => {
    const blocks = parseSafeMarkdown(
      "Hello <script>alert('x')</script>\n<img src=x onerror=alert(1)>",
    );

    expect(blocks).toEqual([
      {
        type: "paragraph",
        lines: ["Hello <script>alert('x')</script>", "<img src=x onerror=alert(1)>"],
      },
    ]);
  });
});
