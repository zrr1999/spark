<script lang="ts">
  import { Streamdown, type StreamdownProps } from "svelte-streamdown";
  import Code from "svelte-streamdown/code";
  import Math from "svelte-streamdown/math";
  import Mermaid from "svelte-streamdown/mermaid";

  type Props = StreamdownProps;

  const richMarkdownComponents = {
    code: Code,
    math: Math,
    mermaid: Mermaid,
  };

  let {
    content,
    class: className,
    components,
    defaultOrigin = "http://localhost",
    static: isStatic,
    ...restProps
  }: Props = $props();

  const resolvedComponents = $derived({
    ...richMarkdownComponents,
    ...components,
  });
</script>

<div
  class={`ai-response${className ? ` ${className}` : ""}`}
  data-streaming={isStatic === false || undefined}
>
  <Streamdown
    {content}
    class="streamdown-content"
    baseTheme="shadcn"
    {defaultOrigin}
    static={isStatic}
    components={resolvedComponents}
    {...restProps}
  />
</div>

<style>
  .ai-response {
    color: var(--color-ink);
    min-width: 0;
    width: 100%;
  }

  .ai-response :global(.streamdown-content) {
    line-height: 1.65;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ai-response :global(.streamdown-content > :first-child) {
    margin-top: 0;
  }

  .ai-response :global(.streamdown-content > :last-child) {
    margin-bottom: 0;
  }

  .ai-response :global(:where(h1, h2, h3, h4, h5, h6)) {
    color: var(--color-ink);
    font-weight: 750;
    letter-spacing: -0.012em;
    line-height: 1.3;
    margin: 1.35em 0 0.55em;
  }

  .ai-response :global(h1) {
    font-size: 1.45rem;
  }

  .ai-response :global(h2) {
    font-size: 1.25rem;
  }

  .ai-response :global(h3) {
    font-size: 1.08rem;
  }

  .ai-response :global(:where(h4, h5, h6)) {
    font-size: 1rem;
  }

  .ai-response :global(:where(p, ul, ol, blockquote, pre, table, hr, dl)) {
    margin: 0.8em 0;
  }

  .ai-response :global(:where(ul, ol)) {
    display: grid;
    gap: 0.28rem;
    padding-left: 1.45rem;
  }

  .ai-response :global(li > :where(ul, ol)) {
    margin: 0.35rem 0;
  }

  .ai-response :global(input[type="checkbox"]) {
    accent-color: var(--color-primary);
    margin: 0 0.45rem 0 0;
  }

  .ai-response :global(a) {
    color: var(--color-primary);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--color-primary) 38%, transparent);
    text-underline-offset: 0.16em;
  }

  .ai-response :global(a:hover) {
    text-decoration-color: currentColor;
  }

  .ai-response :global(blockquote) {
    border-left: 3px solid var(--color-primary-soft);
    color: var(--color-ink-muted);
    padding-left: 0.95rem;
  }

  .ai-response :global(:not(pre) > code) {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 5px;
    color: var(--color-ink);
    font-size: 0.88em;
    padding: 0.08em 0.35em;
  }

  .ai-response :global([data-streamdown-code]) {
    background: var(--color-code-surface);
    border: 1px solid var(--color-code-surface-soft);
    border-radius: 12px;
    color: var(--color-code-ink);
    margin: 0.9rem 0;
    overflow: hidden;
    position: relative;
  }

  .ai-response :global([data-streamdown-code] > :first-child) {
    align-items: center;
    color: var(--color-code-muted);
    display: flex;
    font-size: 11px;
    min-height: 34px;
    padding: 0 12px;
  }

  .ai-response :global([data-streamdown-code] > :first-child > :last-child) {
    display: flex;
    gap: 4px;
    position: absolute;
    right: 8px;
    top: 5px;
    z-index: 1;
  }

  .ai-response :global([data-streamdown-table-download]) {
    align-items: center;
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    margin-bottom: 5px;
  }

  .ai-response :global([data-streamdown-code] button),
  .ai-response :global([data-streamdown-table-download] button),
  .ai-response :global([data-streamdown-mermaid] button) {
    align-items: center;
    background: color-mix(in srgb, var(--color-code-surface-soft) 86%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-code-muted) 24%, transparent);
    border-radius: 6px;
    color: var(--color-code-ink);
    cursor: pointer;
    display: inline-flex;
    height: 26px;
    justify-content: center;
    padding: 0 7px;
  }

  .ai-response :global([data-streamdown-code] button:disabled),
  .ai-response :global([data-streamdown-table-download] button:disabled),
  .ai-response :global([data-streamdown-mermaid] button:disabled) {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .ai-response :global([data-streamdown-code] button svg),
  .ai-response :global([data-streamdown-table-download] button svg),
  .ai-response :global([data-streamdown-mermaid] button svg) {
    height: 14px;
    max-width: none;
    width: 14px;
  }

  .ai-response :global([data-streamdown-code] > :last-child) {
    overflow: auto;
  }

  .ai-response :global(pre) {
    color: var(--color-code-ink);
    font-size: 12px;
    line-height: 1.6;
    margin: 0;
    min-width: max-content;
    padding: 12px 14px 14px;
  }

  .ai-response :global(pre code) {
    font: inherit;
  }

  .ai-response :global([data-streamdown-table]) {
    margin: 0.9rem 0;
    max-width: 100%;
    overflow-x: auto;
  }

  .ai-response :global(#table-download-popover) {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 9px;
    box-shadow: var(--shadow-popover);
    padding: 4px;
    z-index: 60;
  }

  .ai-response :global(table) {
    border-collapse: collapse;
    font-size: 0.92em;
    width: 100%;
  }

  .ai-response :global(:where(th, td)) {
    border: 1px solid var(--color-border);
    padding: 0.5rem 0.65rem;
    text-align: left;
    vertical-align: top;
  }

  .ai-response :global(th) {
    background: var(--color-surface-soft);
    color: var(--color-ink);
    font-weight: 700;
  }

  .ai-response :global(tr:nth-child(even) td) {
    background: color-mix(in srgb, var(--color-surface-soft) 52%, transparent);
  }

  .ai-response :global(hr) {
    border: 0;
    border-top: 1px solid var(--color-border);
  }

  .ai-response :global(img),
  .ai-response :global([data-streamdown-mermaid] > svg) {
    height: auto;
    max-width: 100%;
  }

  .ai-response :global(.katex-display) {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .ai-response :global([data-streamdown-mermaid]) {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    margin: 0.9rem 0;
    max-width: 100%;
    overflow: auto;
    padding: 12px;
  }

  .ai-response[data-streaming="true"] :global(.streamdown-content)::after {
    animation: streamdown-caret 0.9s steps(1, end) infinite;
    background: currentColor;
    border-radius: 1px;
    content: "";
    display: inline-block;
    height: 1em;
    margin-left: 0.22em;
    vertical-align: -0.12em;
    width: 0.5em;
  }

  @keyframes streamdown-caret {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ai-response :global(*) {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
