<script lang="ts">
  import { Response } from "$lib/components/response";

  let { source, streaming = false }: { source: string; streaming?: boolean } = $props();
</script>

<Response
  content={source}
  mode={streaming ? "streaming" : "static"}
  isAnimating={streaming}
  animated={streaming}
  caret={streaming ? "block" : undefined}
  parseIncompleteMarkdown
  renderHtml={false}
/>
