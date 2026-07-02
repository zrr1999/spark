<script lang="ts">
  import { parseSafeMarkdown } from "$lib/safe-markdown";

  let { source }: { source: string } = $props();
  let blocks = $derived(parseSafeMarkdown(source));
</script>

<div class="safe-markdown">
  {#each blocks as block}
    {#if block.type === "heading"}
      {#if block.depth === 1}
        <h1>{block.text}</h1>
      {:else if block.depth === 2}
        <h2>{block.text}</h2>
      {:else}
        <h3>{block.text}</h3>
      {/if}
    {:else if block.type === "paragraph"}
      <p>
        {#each block.lines as line, index}
          {line}{#if index < block.lines.length - 1}<br />{/if}
        {/each}
      </p>
    {:else if block.type === "list"}
      {#if block.ordered}
        <ol>
          {#each block.items as item}
            <li>{item}</li>
          {/each}
        </ol>
      {:else}
        <ul>
          {#each block.items as item}
            <li>{item}</li>
          {/each}
        </ul>
      {/if}
    {:else if block.type === "code"}
      <pre class="code-block"><code data-language={block.language ?? undefined}>{block.code}</code></pre>
    {:else if block.type === "quote"}
      <blockquote>
        {#each block.lines as line, index}
          {line}{#if index < block.lines.length - 1}<br />{/if}
        {/each}
      </blockquote>
    {/if}
  {/each}
</div>

<style>
  .safe-markdown {
    color: var(--color-ink);
    display: grid;
    gap: 0.7rem;
    line-height: 1.58;
  }

  .safe-markdown :where(h1, h2, h3, p, ul, ol, blockquote, pre) {
    margin: 0;
  }

  .safe-markdown h1,
  .safe-markdown h2,
  .safe-markdown h3 {
    color: var(--color-ink);
    font-weight: 850;
    line-height: 1.2;
  }

  .safe-markdown h1 {
    font-size: 1.35rem;
  }

  .safe-markdown h2 {
    font-size: 1.15rem;
  }

  .safe-markdown h3 {
    font-size: 1rem;
  }

  .safe-markdown ul,
  .safe-markdown ol {
    display: grid;
    gap: 0.25rem;
    padding-left: 1.25rem;
  }

  .safe-markdown blockquote {
    border-left: 3px solid var(--color-primary-soft);
    color: var(--color-ink-muted);
    padding-left: 0.85rem;
  }

  .code-block {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    color: var(--color-ink);
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    max-width: 100%;
    overflow: auto;
    padding: 10px;
    white-space: pre;
  }
</style>
