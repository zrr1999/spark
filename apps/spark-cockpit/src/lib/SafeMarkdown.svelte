<script lang="ts">
  import { Response } from "$lib/components/response";

  let { source, streaming = false }: { source: string; streaming?: boolean } = $props();
</script>

<Response
  content={source}
  static={!streaming}
  animation={{
    enabled: streaming,
    animateOnMount: streaming,
    type: "fade",
    duration: 120,
    timingFunction: "ease-out",
    tokenize: "word",
  }}
  parseIncompleteMarkdown
  renderHtml={false}
/>
