<script lang="ts">
  import { page } from "$app/state";
  import { INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE } from "$lib/error-codes";
  import Icon from "$lib/Icon.svelte";
  import { Button } from "$lib/ui";

  let copy = $derived(page.data.messages.errorPage);
  let currentError = $derived(page.error as App.Error | null);
  let invocationOwnedElsewhere = $derived(
    currentError?.code === INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE,
  );
  let notFound = $derived(page.status === 404);
  let eyebrow = $derived(
    invocationOwnedElsewhere
      ? copy.routeEyebrow
      : notFound
        ? copy.notFoundEyebrow
        : copy.serverEyebrow,
  );
  let title = $derived(
    invocationOwnedElsewhere
      ? copy.routeTitle
      : notFound
        ? copy.notFoundTitle
        : copy.serverTitle,
  );
  let body = $derived(
    invocationOwnedElsewhere
      ? copy.routeBody
      : notFound
        ? copy.notFoundBody
        : copy.serverBody,
  );
  let reportedDetail = $derived(
    !invocationOwnedElsewhere && page.status < 500 && currentError?.message
      ? currentError.message
      : undefined,
  );
</script>

<svelte:head><title>{title} · Spark</title></svelte:head>

<main class="error-shell">
  <a class="brand" href="/" aria-label={copy.home}>
    <span class="brand-mark"><Icon name="spark" size={20} /></span>
    <span>{copy.brandLabel}</span>
  </a>

  <article class="error-card" aria-labelledby="error-title">
    <div class="error-icon" class:route={invocationOwnedElsewhere}>
      <Icon name={invocationOwnedElsewhere ? "repos" : "warning"} size={26} stroke={1.8} />
    </div>
    <div class="error-copy">
      <p class="eyebrow">{eyebrow}</p>
      <h1 id="error-title">{title}</h1>
      <p class="lede">{body}</p>
    </div>

    <dl class="error-meta">
      <div>
        <dt>{copy.statusLabel}</dt>
        <dd><code>{page.status}</code></dd>
      </div>
      {#if currentError?.requestId}
        <div>
          <dt>{copy.requestIdLabel}</dt>
          <dd><code>{currentError.requestId}</code></dd>
        </div>
      {/if}
    </dl>

    {#if reportedDetail}
      <details class="reported-detail">
        <summary>{copy.technicalDetail}</summary>
        <p>{reportedDetail}</p>
      </details>
    {/if}

    <div class="actions">
      {#if !invocationOwnedElsewhere && !notFound}
        <Button onclick={() => window.location.reload()}>{copy.retry}</Button>
      {/if}
      <Button href="/" variant="secondary">{copy.home}</Button>
    </div>
  </article>
</main>

<style>
  :global(body) {
    background:
      radial-gradient(circle at 50% -20%, var(--color-primary-weak), transparent 46%),
      var(--color-canvas);
    color: var(--color-ink);
    font-family: var(--font-sans);
    margin: 0;
  }

  .error-shell {
    align-content: center;
    display: grid;
    gap: var(--spacing-xl);
    justify-items: center;
    min-height: 100dvh;
    padding: var(--spacing-xl);
  }

  .brand {
    align-items: center;
    color: var(--color-ink);
    display: inline-flex;
    font-size: var(--text-card-title);
    font-weight: 650;
    gap: var(--spacing-sm);
    text-decoration: none;
  }

  .brand-mark {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: var(--rounded-md);
    color: var(--color-primary);
    display: inline-flex;
    height: 36px;
    justify-content: center;
    width: 36px;
  }

  .error-card {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-card);
    display: grid;
    gap: var(--spacing-lg);
    max-width: 660px;
    padding: clamp(24px, 5vw, 44px);
    width: min(100%, 660px);
  }

  .error-icon {
    align-items: center;
    background: var(--color-danger-weak);
    border: 1px solid var(--color-danger-soft);
    border-radius: 999px;
    color: var(--color-danger-strong);
    display: flex;
    height: 52px;
    justify-content: center;
    width: 52px;
  }

  .error-icon.route {
    background: var(--color-info-soft);
    border-color: var(--color-primary-soft);
    color: var(--color-info-strong);
  }

  .error-copy { display: grid; gap: var(--spacing-sm); }
  .eyebrow {
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: 650;
    letter-spacing: 0.04em;
    margin: 0;
    text-transform: uppercase;
  }
  h1 {
    font-size: clamp(24px, 5vw, 34px);
    letter-spacing: -0.025em;
    line-height: 1.16;
    margin: 0;
  }
  .lede {
    color: var(--color-ink-muted);
    font-size: var(--text-body);
    line-height: 1.7;
    margin: 0;
    max-width: 62ch;
  }

  .error-meta {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    display: grid;
    gap: 1px;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    margin: 0;
    overflow: hidden;
  }
  .error-meta > div {
    display: grid;
    gap: var(--spacing-xxs);
    padding: var(--spacing-md);
  }
  .error-meta dt {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 600;
  }
  .error-meta dd { margin: 0; min-width: 0; }
  .error-meta code {
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    overflow-wrap: anywhere;
  }

  .reported-detail {
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    padding: var(--spacing-sm) var(--spacing-md);
  }
  .reported-detail summary { cursor: pointer; font-weight: 600; }
  .reported-detail p { margin: var(--spacing-sm) 0 0; overflow-wrap: anywhere; }

  .actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }

  @media (max-width: 560px) {
    .error-shell { align-content: start; padding: var(--spacing-lg) var(--spacing-md); }
    .error-card { padding: var(--spacing-xl) var(--spacing-lg); }
    .actions :global(.ui-button) { width: 100%; }
  }
</style>
