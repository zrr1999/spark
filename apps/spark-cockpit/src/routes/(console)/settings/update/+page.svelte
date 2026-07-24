<script lang="ts">
  import { PageHeader } from "$lib/ui";

  let { data } = $props();
  let copy = $derived(data.messages.updateStatus);
  let update = $derived(data.update);
</script>

<svelte:head>
  <title>{copy.title} · Spark</title>
</svelte:head>

<section class="update-page">
  <PageHeader title={copy.title} lede={copy.lede} />

  <section class="status-grid" aria-label={copy.title}>
    <article>
      <span>{copy.current}</span>
      <strong>{update.current ?? copy.none}</strong>
    </article>
    <article>
      <span>{copy.available}</span>
      <strong>{update.available ?? copy.none}</strong>
    </article>
    <article>
      <span>{copy.pending}</span>
      <strong>{update.pending ?? copy.none}</strong>
    </article>
    <article>
      <span>{copy.policy}</span>
      <strong>{update.policy} · {update.channel}</strong>
    </article>
  </section>

  {#if !update.managed && update.repairCommand}
    <section class="notice">
      <h2>{copy.unmanaged}</h2>
      <p>{copy.unmanagedBody}</p>
      <code>{update.repairCommand}</code>
    </section>
  {/if}

  {#if update.quarantined.length > 0}
    <section class="notice danger">
      <h2>{copy.quarantined}</h2>
      {#each update.quarantined as candidate}
        <div class="candidate">
          <strong>{candidate.version}</strong>
          <span>{candidate.reason}</span>
          <code>spark update retry {candidate.version} --yes</code>
        </div>
      {/each}
    </section>
  {/if}

  <p class="ownership">{copy.readOnly}</p>
</section>

<style>
  .update-page {
    display: grid;
    gap: var(--spacing-lg);
    max-width: 880px;
    min-width: 0;
    width: 100%;
  }

  .status-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  article,
  .notice {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    padding: 16px;
  }

  article {
    display: grid;
    gap: 7px;
  }

  article span,
  .ownership,
  .candidate span {
    color: var(--color-ink-muted);
    font-size: 13px;
  }

  article strong {
    color: var(--color-ink);
    font-size: 18px;
  }

  .notice {
    display: grid;
    gap: 10px;
  }

  .notice.danger {
    border-color: var(--color-danger);
  }

  .notice h2,
  .notice p,
  .ownership {
    margin: 0;
  }

  .candidate {
    display: grid;
    gap: 6px;
  }

  code {
    background: var(--color-surface-soft);
    border-radius: var(--rounded-sm);
    overflow-wrap: anywhere;
    padding: 8px 10px;
  }

  @media (max-width: 620px) {
    .status-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
