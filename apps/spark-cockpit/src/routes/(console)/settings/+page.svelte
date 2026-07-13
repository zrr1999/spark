<script lang="ts">
  import Icon from "$lib/Icon.svelte";

  let { data } = $props();
  let t = $derived(data.messages.globalSettings);
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="global-settings" aria-labelledby="global-settings-title">
  <header>
    <p class="eyebrow">{t.eyebrow}</p>
    <h1 id="global-settings-title">{t.title}</h1>
    <p class="lede">{t.lede}</p>
  </header>

  <div class="cards">
    <article class="card">
      <div>
        <h2>{t.modelsCardTitle}</h2>
        <p>{t.modelsCardBody}</p>
      </div>
      <a class="primary-action" href="/settings/models">
        <Icon name="spark" size={16} />
        {t.modelsAction}
      </a>
    </article>

    <article class="card">
      <div>
        <h2>{t.workspaceCardTitle}</h2>
        <p>{t.workspaceCardBody}</p>
      </div>
      {#if data.workspaceSettingsPath}
        <a class="secondary-action" href={data.workspaceSettingsPath}>
          <Icon name="settings" size={16} />
          {t.workspaceAction}
        </a>
      {:else}
        <p class="muted">{t.workspaceUnavailable}</p>
      {/if}
    </article>
  </div>
</section>

<style>
  .global-settings {
    display: grid;
    gap: 24px;
    max-width: 920px;
    min-width: 0;
    width: 100%;
  }

  .eyebrow {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.06em;
    margin: 0 0 6px;
    text-transform: uppercase;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  .lede,
  .muted,
  .card p {
    color: var(--color-ink-subtle);
    line-height: 1.5;
  }

  .cards {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    display: grid;
    gap: 16px;
    padding: 18px;
  }

  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: 999px;
    display: inline-flex;
    font-weight: 700;
    gap: 6px;
    padding: 8px 12px;
    text-decoration: none;
    width: fit-content;
  }

  .primary-action {
    background: var(--color-primary);
    color: var(--color-on-primary, #fff);
  }

  .secondary-action {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  @media (max-width: 480px) {
    .cards {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
