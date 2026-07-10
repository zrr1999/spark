<script lang="ts">
  import { parseSparkUiSource } from "@zendev-lab/spark-artifacts/generative-ui";
  import SparkUiRenderer from "$lib/SparkUiRenderer.svelte";

  let {
    source,
    streaming = false,
    showSource = false,
  }: {
    source: string;
    streaming?: boolean;
    showSource?: boolean;
  } = $props();

  let document = $derived(parseSparkUiSource(source));
</script>

<div class="agent-mdx-stream" class:streaming>
  <SparkUiRenderer {document} {source} {showSource} />
  {#if streaming}
    <span class="streaming-caret" aria-hidden="true"></span>
  {/if}
</div>

<style>
  .agent-mdx-stream {
    display: grid;
    gap: 0.55rem;
    min-width: 0;
  }

  .streaming-caret {
    animation: caret-blink 1s steps(2, start) infinite;
    background: var(--color-primary);
    border-radius: 999px;
    display: inline-block;
    height: 1em;
    margin-left: 2px;
    width: 7px;
  }

  @keyframes caret-blink {
    0%,
    45% {
      opacity: 1;
    }
    46%,
    100% {
      opacity: 0.15;
    }
  }
</style>
