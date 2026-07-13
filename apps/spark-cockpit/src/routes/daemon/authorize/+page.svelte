<script lang="ts">
  import { Button, Field, Input, Panel } from "$lib/ui";

  let { data, form } = $props();
  let t = $derived(data.messages.daemonAuthorization);
  let authorization = $derived(data.authorization);
  let decision = $derived(data.result);
  let displayedError = $derived(
    data.lookupError ?? (form?.intent === "deviceAuthorization" ? form.message : null),
  );

  function errorMessage(reason: string | null | undefined): string | null {
    if (!reason) return null;
    return t.errors[reason as keyof typeof t.errors] ?? t.errors.invalid_grant;
  }

  function formatExpiry(value: string): string {
    return new Intl.DateTimeFormat(data.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<main class="authorization-shell">
  <Panel class="authorization-card" ariaLabelledby="authorization-title">
    <div class="brand-mark" aria-hidden="true">S</div>
    <div class="intro">
      <p class="eyebrow">{t.eyebrow}</p>
      <h1 id="authorization-title">{t.title}</h1>
      <p class="lede">{t.lede}</p>
    </div>

    {#if decision === "approved"}
      <section class="result success" role="status">
        <span class="result-icon" aria-hidden="true">✓</span>
        <div>
          <h2>{t.approvedTitle}</h2>
          <p>{t.approvedBody}</p>
        </div>
      </section>
    {:else if decision === "denied"}
      <section class="result neutral" role="status">
        <span class="result-icon" aria-hidden="true">×</span>
        <div>
          <h2>{t.deniedTitle}</h2>
          <p>{t.deniedBody}</p>
        </div>
      </section>
    {:else if authorization?.status === "approved"}
      <section class="result success" role="status">
        <span class="result-icon" aria-hidden="true">✓</span>
        <div>
          <h2>{t.approvedTitle}</h2>
          <p>{t.approvedBody}</p>
        </div>
      </section>
    {:else if authorization?.status === "consumed"}
      <section class="result success" role="status">
        <span class="result-icon" aria-hidden="true">✓</span>
        <div>
          <h2>{t.consumedTitle}</h2>
          <p>{t.consumedBody}</p>
        </div>
      </section>
    {:else if authorization?.status === "denied"}
      <section class="result neutral" role="status">
        <span class="result-icon" aria-hidden="true">×</span>
        <div>
          <h2>{t.deniedTitle}</h2>
          <p>{t.deniedBody}</p>
        </div>
      </section>
    {:else if authorization?.status === "expired"}
      <section class="result warning" role="alert">
        <span class="result-icon" aria-hidden="true">!</span>
        <div>
          <h2>{t.expiredTitle}</h2>
          <p>{t.expiredBody}</p>
        </div>
      </section>
    {:else if authorization}
      <section class="request" aria-labelledby="request-title">
        <div class="request-heading">
          <div>
            <p class="request-kicker">{t.requestTitle}</p>
            <h2 id="request-title">{authorization.userCode}</h2>
          </div>
          <span class="request-status">{t.pendingStatus}</span>
        </div>

        <dl>
          <div>
            <dt>{t.daemonLabel}</dt>
            <dd>{authorization.displayName}</dd>
          </div>
          <div>
            <dt>{t.installationLabel}</dt>
            <dd class="mono">{authorization.installationId}</dd>
          </div>
          <div>
            <dt>{t.permissionLabel}</dt>
            <dd>{t.permissionValue}</dd>
          </div>
          <div>
            <dt>{t.expiresLabel}</dt>
            <dd>{formatExpiry(authorization.expiresAt)}</dd>
          </div>
        </dl>

        <p class="safety-note">{t.safetyNote}</p>

        {#if errorMessage(displayedError)}
          <div class="form-error" role="alert">{errorMessage(displayedError)}</div>
        {/if}

        <div class="actions">
          <form method="POST" action="?/deny">
            <input type="hidden" name="userCode" value={authorization.userCode} />
            <Button type="submit" variant="secondary">{t.deny}</Button>
          </form>
          <form method="POST" action="?/approve">
            <input type="hidden" name="userCode" value={authorization.userCode} />
            <Button type="submit">{t.approve}</Button>
          </form>
        </div>
      </section>
    {:else}
      <section class="code-entry" aria-labelledby="code-entry-title">
        <div>
          <h2 id="code-entry-title">{displayedError ? t.invalidTitle : t.enterTitle}</h2>
          <p>{displayedError ? t.invalidBody : t.enterBody}</p>
        </div>
        {#if errorMessage(displayedError)}
          <div class="form-error" role="alert">{errorMessage(displayedError)}</div>
        {/if}
        <form method="GET">
          <Field id="user-code" label={t.codeLabel} required>
            <Input
              id="user-code"
              name="user_code"
              value={data.userCode}
              autocomplete="one-time-code"
              autocapitalize="characters"
              spellcheck={false}
              placeholder={t.codePlaceholder}
              required
            />
          </Field>
          <Button type="submit">{t.findCode}</Button>
        </form>
      </section>
    {/if}
  </Panel>
</main>

<style>
  .authorization-shell {
    align-items: center;
    background:
      radial-gradient(circle at 20% 0%, rgba(37, 99, 235, 0.13), transparent 34rem),
      var(--color-canvas);
    color: var(--color-ink);
    display: grid;
    min-height: 100vh;
    padding: clamp(18px, 5vw, 64px);
  }

  :global(.authorization-card) {
    margin: 0 auto;
    max-width: 600px;
    width: min(100%, 600px);
  }

  .brand-mark {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: var(--rounded-md);
    color: var(--color-primary);
    display: inline-flex;
    font-size: 18px;
    font-weight: 850;
    height: 42px;
    justify-content: center;
    width: 42px;
  }

  .intro,
  .code-entry {
    display: grid;
    gap: var(--spacing-sm);
  }

  .eyebrow,
  .request-kicker {
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  h1 {
    font-size: clamp(30px, 7vw, 42px);
    letter-spacing: -0.04em;
    line-height: 1.05;
    margin: 0;
  }

  h2,
  p {
    margin: 0;
  }

  .lede,
  .code-entry p,
  .result p {
    color: var(--color-ink-subtle);
    line-height: 1.6;
  }

  .request {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: var(--spacing-lg);
    padding-top: var(--spacing-lg);
  }

  .request-heading {
    align-items: center;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
  }

  .request-heading > div {
    display: grid;
    gap: 4px;
  }

  .request-heading h2 {
    font-family: var(--font-mono);
    font-size: 28px;
    letter-spacing: 0.08em;
  }

  .request-status {
    background: var(--color-warning-soft);
    border-radius: var(--rounded-full);
    color: var(--color-warning);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    padding: 5px 9px;
  }

  dl {
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    display: grid;
    margin: 0;
  }

  dl > div {
    display: grid;
    gap: var(--spacing-xs);
    grid-template-columns: minmax(110px, 0.35fr) 1fr;
    padding: 11px 13px;
  }

  dl > div + div {
    border-top: 1px solid var(--color-border);
  }

  dt {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .safety-note,
  .form-error {
    border-radius: var(--rounded-md);
    font-size: var(--text-caption);
    line-height: 1.55;
    padding: 11px 13px;
  }

  .safety-note {
    background: var(--color-primary-weak);
    color: var(--color-ink-muted);
  }

  .form-error {
    background: var(--color-danger-weak);
    color: var(--color-danger-strong);
  }

  .actions {
    display: flex;
    gap: var(--spacing-sm);
    justify-content: flex-end;
  }

  .result {
    align-items: flex-start;
    border-radius: var(--rounded-md);
    display: flex;
    gap: var(--spacing-md);
    padding: var(--spacing-lg);
  }

  .result > div {
    display: grid;
    gap: var(--spacing-xs);
  }

  .result-icon {
    align-items: center;
    border-radius: var(--rounded-full);
    display: inline-flex;
    flex: 0 0 auto;
    font-weight: 800;
    height: 26px;
    justify-content: center;
    width: 26px;
  }

  .result.success {
    background: var(--color-success-soft);
  }

  .result.success .result-icon {
    background: var(--color-success);
    color: var(--color-on-primary);
  }

  .result.warning,
  .result.neutral {
    background: var(--color-surface-soft);
  }

  .result.warning .result-icon {
    background: var(--color-warning);
    color: var(--color-on-primary);
  }

  .result.neutral .result-icon {
    background: var(--color-ink-subtle);
    color: var(--color-surface);
  }

  .code-entry form {
    align-items: end;
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: 1fr auto;
    margin-top: var(--spacing-sm);
  }

  @media (max-width: 560px) {
    dl > div,
    .code-entry form {
      grid-template-columns: 1fr;
    }

    .actions {
      align-items: stretch;
      flex-direction: column-reverse;
    }

    .actions form,
    .actions :global(.ui-button) {
      width: 100%;
    }
  }
</style>
