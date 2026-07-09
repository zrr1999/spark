<script lang="ts">
  let { data, form } = $props();
</script>

<svelte:head>
  <title>Remote access · Spark Cockpit</title>
</svelte:head>

<section class="login-shell">
  <article class="login-card">
    <p class="eyebrow">Remote access</p>
    <h1>Unlock Spark Cockpit</h1>
    <p class="lede">
      Non-localhost Cockpit sessions require the single-user token configured on the server. Localhost access remains passwordless for local development.
    </p>

    {#if !data.remoteAccessConfigured}
      <div class="notice" role="alert">
        Set <code>SPARK_COCKPIT_REMOTE_TOKEN</code> before exposing Cockpit on a Tailscale or private network address.
      </div>
    {/if}

    {#if form?.message}
      <div class="error" role="alert">{form.message}</div>
    {/if}

    <form method="POST">
      <input type="hidden" name="next" value={data.next} />
      <label>
        <span>Access token</span>
        <input name="token" type="password" autocomplete="current-password" placeholder="spark remote token" required />
      </label>
      <button type="submit" disabled={!data.remoteAccessConfigured}>Continue</button>
    </form>
  </article>
</section>

<style>
  .login-shell {
    align-items: center;
    background:
      radial-gradient(circle at top left, rgba(37, 99, 235, 0.14), transparent 34rem),
      var(--color-canvas);
    color: var(--color-ink);
    display: grid;
    min-height: 100vh;
    padding: clamp(18px, 5vw, 64px);
  }

  .login-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 24px;
    box-shadow: var(--shadow-panel);
    display: grid;
    gap: 18px;
    margin: 0 auto;
    max-width: 520px;
    padding: clamp(24px, 5vw, 42px);
    width: min(100%, 520px);
  }

  .eyebrow {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 850;
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  h1 {
    font-size: clamp(30px, 8vw, 44px);
    letter-spacing: -0.04em;
    line-height: 1;
    margin: 0;
  }

  .lede {
    color: var(--color-ink-subtle);
    line-height: 1.6;
    margin: 0;
  }

  form,
  label {
    display: grid;
    gap: 10px;
  }

  label span {
    font-size: 13px;
    font-weight: 800;
  }

  input {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-strong);
    border-radius: 12px;
    color: var(--color-ink);
    font: inherit;
    min-height: 46px;
    padding: 0 14px;
  }

  button {
    background: var(--color-primary);
    border: 0;
    border-radius: 12px;
    color: white;
    cursor: pointer;
    font: inherit;
    font-weight: 850;
    min-height: 46px;
    padding: 0 16px;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .notice,
  .error {
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.5;
    padding: 12px 14px;
  }

  .notice {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .error {
    background: var(--color-danger-weak);
    color: var(--color-danger-strong);
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
  }
</style>
