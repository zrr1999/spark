<script lang="ts">
  import Icon from "$lib/Icon.svelte";

  type Props = {
    title: string;
    message: string;
  };

  let {
    title,
    message,
  }: Props = $props();
</script>

<article class="notice-part">
  <span aria-hidden="true"><Icon name="activity" size={15} /></span>
  <div>
    <strong>{title}</strong>
    <p>{message}</p>
  </div>
</article>

<style>
  .notice-part {
    background: var(--color-primary-weak);
    border: 1px solid color-mix(in srgb, var(--color-primary) 22%, var(--color-border));
    border-radius: 10px;
    color: var(--color-primary);
    display: grid;
    gap: 9px;
    grid-template-columns: auto minmax(0, 1fr);
    padding: 11px 12px;
  }

  .notice-part > span {
    display: inline-flex;
    margin-top: 1px;
  }

  .notice-part div {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  strong {
    color: var(--color-ink);
    font-size: 12px;
  }

  p {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
  }
</style>
