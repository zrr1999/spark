<script lang="ts">
  import Icon from "$lib/Icon.svelte";

  type Props = {
    title: string;
    message: string;
    code?: string;
  };

  let { title, message, code }: Props = $props();
</script>

<article class="error-part">
  <span class="error-icon" aria-hidden="true"><Icon name="warning" size={15} /></span>
  <div class="error-content">
    <header>
      <strong>{title}</strong>
      {#if code}<code>{code}</code>{/if}
    </header>
    <p>{message}</p>
  </div>
</article>

<style>
  .error-part {
    background: var(--color-danger-weak, #fef2f2);
    border: 1px solid var(--color-danger-soft, #fecaca);
    border-radius: 10px;
    display: grid;
    gap: 9px;
    grid-template-columns: auto minmax(0, 1fr);
    padding: 11px 12px;
  }

  .error-icon {
    color: var(--color-danger-strong, #b91c1c);
    display: inline-flex;
    margin-top: 1px;
  }

  .error-content {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  header {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  strong {
    color: var(--color-danger-strong, #b91c1c);
    font-size: 12px;
    font-weight: 700;
  }

  code {
    background: color-mix(in srgb, var(--color-danger-strong, #b91c1c) 8%, transparent);
    border-radius: 4px;
    color: var(--color-danger-strong, #b91c1c);
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    padding: 2px 5px;
  }

  p {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
</style>
