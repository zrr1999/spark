<script lang="ts">
  type Props = {
    sessionId: string;
    messageId: string;
    contentIndex: number;
    mediaType: "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";
    name?: string;
  };

  let { sessionId, messageId, contentIndex, mediaType, name }: Props = $props();
  let src = $derived(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(messageId)}/${contentIndex}`,
  );
</script>

<figure class="message-image">
  <a href={src} target="_blank" rel="noreferrer" aria-label={name ?? "Image"}>
    <img src={src} alt={name ?? ""} loading="lazy" decoding="async" />
  </a>
  {#if name}<figcaption>{name}</figcaption>{/if}
</figure>

<style>
  .message-image {
    display: grid;
    gap: 5px;
    margin: 0;
    max-width: min(100%, 360px);
  }

  .message-image a {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 12px;
    display: block;
    line-height: 0;
    overflow: hidden;
  }

  .message-image a:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .message-image img {
    display: block;
    height: auto;
    max-height: 320px;
    max-width: 100%;
    object-fit: contain;
  }

  .message-image figcaption {
    color: var(--color-ink-subtle);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
