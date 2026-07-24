import { render } from "vitest-browser-svelte";
import { describe, expect, it } from "vitest";
import Response from "./Response.svelte";

describe("Response browser contract", () => {
  it("renders the rich Markdown surface without exposing raw or unsafe HTML", async () => {
    const screen = await render(Response, {
      content: [
        "# 标题",
        "",
        "中文~~删除~~文本",
        "",
        "[安全](https://example.com) [危险](javascript:alert(1))",
        "",
        "![relative image](/icons/spark.svg)",
        "",
        "<script>globalThis.markdownScriptExecuted = true</script>",
        "",
        "```ts",
        "const answer = 42;",
        "```",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "$E = mc^2$",
      ].join("\n"),
      renderHtml: false,
      static: true,
    });

    expect(screen.container.querySelector("h1")?.textContent).toBe("标题");
    expect(screen.container.querySelector("del")?.textContent).toBe("删除");
    expect(screen.container.querySelector('a[href="https://example.com/"]')).not.toBeNull();
    expect(screen.container.querySelector("[data-streamdown-link-blocked]")?.textContent).toContain(
      "危险",
    );
    expect(screen.container.querySelector("[data-streamdown-link-blocked]")?.textContent).toContain(
      "[blocked]",
    );
    expect(screen.container.querySelector('img[src="/icons/spark.svg"]')?.getAttribute("alt")).toBe(
      "relative image",
    );
    expect(screen.container.querySelector("script")).toBeNull();
    expect(screen.container.querySelector("[data-streamdown-code]")).not.toBeNull();
    expect(screen.container.querySelector("[data-streamdown-table]")).not.toBeNull();
    expect(screen.container.querySelector("[data-streamdown-inline-math]")).not.toBeNull();
  });

  it("repairs incomplete streaming Markdown and exposes a local caret", async () => {
    const screen = await render(Response, {
      content: "**未完成",
      parseIncompleteMarkdown: true,
      static: false,
    });

    expect(screen.container.querySelector("strong")?.textContent).toBe("未完成");
    expect(screen.container.querySelector('.ai-response[data-streaming="true"]')).not.toBeNull();
  });
});
