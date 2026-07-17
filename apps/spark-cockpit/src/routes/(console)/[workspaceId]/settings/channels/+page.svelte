<script lang="ts">
  import { enhance } from "$app/forms";
  import {
    freshMessagePlatformFormValues,
    type MessagePlatformAdapter,
    type MessagePlatformFormValues,
    type WorkspaceMessagePlatformConnection,
  } from "$lib/message-platform";
  import Icon from "$lib/Icon.svelte";
  import { statusLabel } from "$lib/i18n";
  import { Button, Field, Input, PageHeader, Select } from "$lib/ui";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { untrack } from "svelte";

  let { data, form } = $props();
  let t = $derived(data.messages.channelsSettings);
  let common = $derived(data.messages.common);
  let status = $derived(data.channelStatus);
  let editor = $derived(data.editor);
  let platforms = $derived(data.platforms);
  let defaultEndpoint = $derived(data.defaults.infoflowEndpoint);

  function freshPlatformValues(): MessagePlatformFormValues {
    return freshMessagePlatformFormValues({
      adapter: data.defaults.adapter,
      infoflowDefaultEndpoint: data.defaults.infoflowEndpoint,
      feishuAppId: data.editor.feishuAppId,
      infoflowEndpoint: data.editor.infoflowEndpoint,
      infoflowAppAgentId: data.editor.infoflowAppAgentId,
      qqbotAppId: data.editor.qqbotAppId,
      qqbotSandbox: data.editor.qqbotSandbox,
    });
  }

  let values = $state<MessagePlatformFormValues>(
    structuredClone(untrack(() => form?.values ?? freshPlatformValues())),
  );
  let formMode = $state<"create" | "editCredentials">("create");
  let editingAdapter = $state<MessagePlatformAdapter | null>(null);
  let submitState = $state<"idle" | "creating" | "saving" | "saved" | "error">("idle");
  let errorMessage = $state<string | null>(null);
  let statusMessage = $state<string | null>(null);
  let editorSection: HTMLElement | null = $state(null);

  $effect(() => {
    if (form?.values) {
      values = structuredClone(form.values);
      if (form.intent === "savePlatform" && form.message === t.savePlatformSuccess) {
        statusMessage = form.message;
        errorMessage = null;
        submitState = "saved";
        formMode = "editCredentials";
        editingAdapter = values.adapter;
        return;
      }
      if (form.message) {
        errorMessage = form.message;
        statusMessage = null;
        submitState = "error";
      }
    }
  });

  let adapterOptions = $derived([
    {
      id: "channel-adapter",
      options: [
        { value: "feishu", label: t.feishuTitle },
        { value: "infoflow", label: t.infoflowTitle },
        { value: "qqbot", label: t.qqbotTitle },
      ],
    },
  ]);

  let credentialsReady = $derived(
    values.adapter === "feishu"
      ? editor.feishuEnabled && editor.feishuAppSecretSet
      : values.adapter === "infoflow"
        ? editor.infoflowEnabled && editor.infoflowAppSecretSet
        : editor.qqbotEnabled && editor.qqbotClientSecretSet,
  );

  function adapterLabel(adapter: MessagePlatformAdapter): string {
    switch (adapter) {
      case "feishu":
        return t.feishuTitle;
      case "infoflow":
        return t.infoflowTitle;
      case "qqbot":
        return t.qqbotTitle;
      default: {
        const _exhaustive: never = adapter;
        throw new Error(`unsupported message platform adapter: ${String(_exhaustive)}`);
      }
    }
  }

  function onAdapterChange(next: string) {
    const adapter =
      next === "feishu" || next === "infoflow" || next === "qqbot" ? next : "infoflow";
    values.adapter = adapter;
    if (adapter === "feishu") {
      values.feishuAppId = values.feishuAppId || editor.feishuAppId;
    } else if (adapter === "infoflow") {
      values.infoflowEndpoint =
        values.infoflowEndpoint || editor.infoflowEndpoint || defaultEndpoint;
      values.infoflowAppAgentId = values.infoflowAppAgentId || editor.infoflowAppAgentId;
    } else {
      values.qqbotAppId = values.qqbotAppId || editor.qqbotAppId;
      values.qqbotSandbox = editor.qqbotSandbox;
    }
  }

  function fillCredentialsFromEditor(adapter: MessagePlatformAdapter) {
    if (adapter === "feishu") {
      values.feishuAppId = editor.feishuAppId;
      values.feishuAppSecret = "";
    } else if (adapter === "infoflow") {
      values.infoflowEndpoint = editor.infoflowEndpoint || defaultEndpoint;
      values.infoflowAppKey = "";
      values.infoflowAppAgentId = editor.infoflowAppAgentId;
      values.infoflowAppSecret = "";
    } else {
      values.qqbotAppId = editor.qqbotAppId;
      values.qqbotClientSecret = "";
      values.qqbotSandbox = editor.qqbotSandbox;
    }
  }

  function editPlatformSettings(platform: WorkspaceMessagePlatformConnection) {
    values.adapter = platform.adapter;
    fillCredentialsFromEditor(platform.adapter);
    editingAdapter = platform.adapter;
    formMode = "editCredentials";
    errorMessage = null;
    statusMessage = null;
    submitState = "idle";
    queueMicrotask(() => {
      editorSection?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("credentials-title")?.focus({ preventScroll: true });
    });
  }

  function startConnectPlatform() {
    values = freshPlatformValues();
    formMode = "create";
    editingAdapter = null;
    statusMessage = null;
    errorMessage = null;
    submitState = "idle";
    queueMicrotask(() => {
      editorSection?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("channel-adapter")?.focus({ preventScroll: true });
    });
  }

  const handleEnhance: SubmitFunction = () => {
    if (values.adapter === "infoflow" && !values.infoflowEndpoint.trim()) {
      values.infoflowEndpoint = defaultEndpoint;
    }
    const savingCredentials = formMode === "editCredentials";
    submitState = savingCredentials ? "saving" : "creating";
    errorMessage = null;
    statusMessage = null;
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "redirect") {
        return;
      }
      if (result.type === "failure") {
        submitState = "error";
        const payload = result.data as { message?: string } | undefined;
        errorMessage =
          payload?.message ?? t.savePlatformFailed;
        return;
      }
      if (result.type === "success") {
        submitState = "saved";
        const payload = result.data as { message?: string } | undefined;
        statusMessage = payload?.message ?? t.savePlatformSuccess;
        formMode = "editCredentials";
        editingAdapter = values.adapter;
        return;
      }
      submitState = "error";
      errorMessage = t.savePlatformFailed;
    };
  };
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="create-channel">
  <PageHeader
    title={t.title}
    lede={t.lede}
    statusLabel={status.available
      ? status.configured
        ? t.configured
        : t.notConfigured
      : t.runtimeUnavailable}
    statusClass={status.available && status.configured ? "ready" : "offline"}
  />

  {#if submitState === "error" && errorMessage}
    <div class="form-status" data-state="error" aria-live="polite">{errorMessage}</div>
  {:else if statusMessage}
    <div class="form-status" data-state="ok" aria-live="polite">{statusMessage}</div>
  {/if}

  <section class="panel channel-list" aria-labelledby="channel-list-title">
    <div class="panel-heading">
      <h2 id="channel-list-title">{t.listTitle}</h2>
    </div>
    {#if platforms.length === 0}
      <p class="muted">{t.listEmpty}</p>
    {:else}
      <ul class="channel-rows">
        {#each platforms as platform (platform.adapter)}
          <li>
            <div class="channel-row-main">
              <strong>{adapterLabel(platform.adapter)}</strong>
              <span class="meta-line">
                <span>{t.accountIdLabel}</span>
                <span class="mono">{platform.accountId || "—"}</span>
              </span>
              <small>
                {status.available
                  ? statusLabel(platform.runtimeState ?? "stopped", common)
                  : t.runtimeUnavailable}
              </small>
              {#if platform.runtimeError}<small class="adapter-error">{platform.runtimeError}</small>{/if}
            </div>
            <div class="channel-row-actions">
              <button
                type="button"
                class="row-action"
                class:active={formMode === "editCredentials" &&
                  editingAdapter === platform.adapter}
                onclick={() => editPlatformSettings(platform)}
              >
                {t.listSettings}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <form
    class="panel editor"
    method="POST"
    action="?/savePlatform"
    use:enhance={handleEnhance}
    bind:this={editorSection}
  >
    <div class="panel-heading">
      <div class="credentials-heading">
        <h2 id="platform-editor-title">
          {formMode === "editCredentials" ? t.editCredentialsTitle : t.createSectionTitle}
        </h2>
        {#if formMode === "editCredentials"}
          <p>{t.editCredentialsHint}</p>
        {/if}
      </div>
      {#if formMode === "editCredentials"}
        <Button type="button" variant="ghost" size="compact" onclick={startConnectPlatform}>
          <Icon name="plus" size={14} />
          {t.createSectionTitle}
        </Button>
      {/if}
    </div>

    {#if formMode === "create"}
      <div class="field-grid">
        <Field id="channel-adapter" label={t.adapterLabel} hint={t.adapterHint} required>
          <Select
            id="channel-adapter"
            name="adapter"
            bind:value={values.adapter}
            groups={adapterOptions}
            label={t.adapterLabel}
            onValueChange={onAdapterChange}
          />
        </Field>
      </div>
    {:else}
      <input type="hidden" name="adapter" value={values.adapter} />
      <dl class="binding-summary">
        <div>
          <dt>{t.listAdapter}</dt>
          <dd>{adapterLabel(values.adapter)}</dd>
        </div>
        <div>
          <dt>{t.accountIdLabel}</dt>
          <dd class="mono">
            {platforms.find((platform) => platform.adapter === values.adapter)?.accountId || "—"}
          </dd>
        </div>
      </dl>
    {/if}

    <div class="toggle-row">
      <Icon name="message" size={15} />
      <span>{t.sessionIdentityHint}</span>
    </div>

    <section class="credentials" aria-labelledby="credentials-title">
      <div class="credentials-heading">
        <h2 id="credentials-title" tabindex="-1">{t.credentialsTitle}</h2>
        <p>{credentialsReady ? t.credentialsReady : t.credentialsHint}</p>
      </div>

      {#if values.adapter === "feishu"}
        <div class="field-grid credentials-grid">
          <Field id="feishu-app-id" label={t.feishuAppId} required={!credentialsReady}>
            <Input
              id="feishu-app-id"
              name="feishuAppId"
              type="text"
              autocomplete="off"
              bind:value={values.feishuAppId}
              placeholder="cli_xxx"
            />
          </Field>
          <Field id="feishu-app-secret" label={t.feishuAppSecret} required={!credentialsReady}>
            <Input
              id="feishu-app-secret"
              name="feishuAppSecret"
              type="password"
              autocomplete="off"
              bind:value={values.feishuAppSecret}
              placeholder={editor.feishuAppSecretSet ? t.secretStored : "••••••••"}
            />
          </Field>
        </div>
      {:else if values.adapter === "infoflow"}
        <div class="field-grid credentials-grid">
          <div class="field-span-all">
            <Field id="infoflow-endpoint" label={t.infoflowEndpoint} hint={t.infoflowEndpointHint}>
              <Input
                id="infoflow-endpoint"
                name="infoflowEndpoint"
                type="text"
                autocomplete="off"
                bind:value={values.infoflowEndpoint}
                placeholder={defaultEndpoint}
              />
            </Field>
          </div>
          <Field id="infoflow-app-key" label={t.infoflowAppKey} required={!credentialsReady}>
            <Input
              id="infoflow-app-key"
              name="infoflowAppKey"
              type="text"
              autocomplete="off"
              bind:value={values.infoflowAppKey}
            />
          </Field>
          <Field id="infoflow-app-secret" label={t.infoflowAppSecret} required={!credentialsReady}>
            <Input
              id="infoflow-app-secret"
              name="infoflowAppSecret"
              type="password"
              autocomplete="off"
              bind:value={values.infoflowAppSecret}
              placeholder={editor.infoflowAppSecretSet ? t.secretStored : "••••••••"}
            />
          </Field>
          <div class="field-span-all">
            <Field
              id="infoflow-app-agent-id"
              label={t.infoflowAppAgentId}
              hint={t.infoflowAppAgentIdHint}
              required={!credentialsReady}
            >
              <Input
                id="infoflow-app-agent-id"
                name="infoflowAppAgentId"
                type="text"
                autocomplete="off"
                bind:value={values.infoflowAppAgentId}
              />
            </Field>
          </div>
        </div>
      {:else}
        <div class="field-grid credentials-grid">
          <Field id="qqbot-app-id" label={t.qqbotAppId} required={!credentialsReady}>
            <Input
              id="qqbot-app-id"
              name="qqbotAppId"
              type="text"
              autocomplete="off"
              bind:value={values.qqbotAppId}
            />
          </Field>
          <Field id="qqbot-client-secret" label={t.qqbotClientSecret} required={!credentialsReady}>
            <Input
              id="qqbot-client-secret"
              name="qqbotClientSecret"
              type="password"
              autocomplete="off"
              bind:value={values.qqbotClientSecret}
              placeholder={editor.qqbotClientSecretSet ? t.secretStored : "••••••••"}
            />
          </Field>
        </div>
        <label class="toggle-row">
          <input type="checkbox" name="qqbotSandbox" bind:checked={values.qqbotSandbox} />
          <span>
            <strong>{t.qqbotSandbox}</strong>
            <small>{t.qqbotSandboxHint}</small>
          </span>
        </label>
      {/if}
    </section>

    <div class="actions">
      {#if formMode === "editCredentials"}
        <Button type="button" variant="ghost" onclick={startConnectPlatform}>
          {t.cancelEdit}
        </Button>
        <Button type="submit" disabled={submitState === "saving"}>
          {submitState === "saving" ? t.savingPlatform : t.savePlatformSubmit}
        </Button>
      {:else}
        <Button type="submit" disabled={submitState === "creating"}>
          {submitState === "creating" ? t.connectingPlatform : t.connectPlatformSubmit}
        </Button>
      {/if}
    </div>
  </form>

  <details class="diagnostics">
    <summary
      ><span
        ><strong>{t.diagnosticsTitle}</strong><small>{t.diagnosticsHint}</small></span
      ></summary
    >
    <section class="diagnostic-panel" aria-labelledby="channels-status-title">
      <div class="panel-heading">
        <h2 id="channels-status-title">{t.statusTitle}</h2>
        <span class="status-pill {status.available && status.configured ? 'configured' : 'missing'}">
          {status.available
            ? status.configured
              ? t.configured
              : t.notConfigured
            : t.runtimeUnavailable}
        </span>
      </div>
      <dl class="meta">
        <div>
          <dt>{t.ingress}</dt>
          <dd>{status.available ? (status.ingressEnabled ? t.ingressOn : t.ingressOff) : "—"}</dd>
        </div>
      </dl>

      <div class="columns">
        <div>
          <h3>{t.adaptersTitle}</h3>
          {#if status.adapters.length === 0}
            <p class="muted">{t.emptyAdapters}</p>
          {:else}
            <ul>
              {#each status.adapters as adapter}
                <li>
                  <strong>{adapter.id}</strong>
                  <span>{adapter.type}</span>
                  <small>{statusLabel(adapter.state, common)}</small>
                  {#if adapter.error}<small class="adapter-error">{adapter.error}</small>{/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        <div>
          <h3>{t.routesTitle}</h3>
          {#if status.routes.length === 0}
            <p class="muted">{t.emptyRoutes}</p>
          {:else}
            <ul>
              {#each status.routes as route}
                <li>
                  <strong>{route.name}</strong>
                  <span>{route.adapter} → {route.recipient}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    </section>
  </details>
</section>

<style>
  .create-channel {
    display: grid;
    gap: var(--spacing-md);
    max-width: 832px;
  }

  .form-status {
    padding: var(--spacing-sm) var(--spacing-md);
    border-radius: var(--rounded-md);
    border: 1px solid var(--color-danger-soft);
    background: var(--color-danger-weak);
    color: var(--color-danger-strong);
    font-size: var(--text-body);
  }

  .form-status[data-state="ok"] {
    border-color: var(--color-success-soft);
    background: var(--color-success-weak);
    color: var(--color-success-strong);
  }

  .panel.editor,
  .panel.channel-list,
  .diagnostic-panel {
    display: grid;
    gap: var(--spacing-md);
    padding: var(--spacing-md);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    background: var(--color-surface);
  }

  .channel-rows {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--spacing-xs);
  }

  .channel-rows li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) 0;
    border-top: 1px solid var(--color-border-soft);
  }

  .channel-rows li:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .channel-row-main {
    display: grid;
    gap: var(--spacing-xxs);
    min-width: 0;
  }

  .channel-row-main strong {
    font-size: var(--text-card-title);
    font-weight: var(--weight-card-title);
  }

  .meta-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
    align-items: baseline;
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .channel-row-main small {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .channel-row-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .row-action {
    appearance: none;
    border: 0;
    background: transparent;
    padding: 0;
    font: inherit;
    font-size: var(--text-body);
    font-weight: var(--weight-body-medium);
    color: var(--color-ink-muted);
    text-decoration: none;
    cursor: pointer;
  }

  .row-action:hover {
    color: var(--color-primary);
  }

  .row-action.active {
    color: var(--color-primary);
  }

  .field-grid {
    display: grid;
    gap: var(--spacing-sm) var(--spacing-md);
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }

  .credentials-grid .field-span-all {
    grid-column: 1 / -1;
  }

  .binding-summary {
    display: grid;
    gap: var(--spacing-sm);
    margin: 0;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .binding-summary div {
    display: grid;
    gap: var(--spacing-xxs);
  }

  .binding-summary dt {
    font-size: var(--text-caption);
    color: var(--color-ink-subtle);
  }

  .binding-summary dd {
    margin: 0;
  }

  .credentials {
    display: grid;
    gap: var(--spacing-sm);
  }

  .credentials-heading h2 {
    margin: 0;
    font-size: var(--text-card-title);
  }

  .credentials-heading p {
    margin: var(--spacing-xxs) 0 0;
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .toggle-row {
    display: flex;
    gap: var(--spacing-sm);
    align-items: flex-start;
    padding: var(--spacing-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
  }

  .toggle-row strong {
    display: block;
  }

  .toggle-row small {
    display: block;
    margin-top: var(--spacing-xxs);
    color: var(--color-ink-subtle);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--spacing-sm);
  }

  @media (max-width: 640px) {
    .field-grid,
    .binding-summary {
      grid-template-columns: 1fr;
    }
  }

  .diagnostics summary {
    cursor: pointer;
    list-style: none;
  }

  .diagnostics summary span {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xxs);
  }

  .diagnostics summary small {
    color: var(--color-ink-subtle);
  }

  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
  }

  .panel-heading h2 {
    margin: 0;
    font-size: var(--text-card-title);
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    padding: var(--spacing-xxs) var(--spacing-xs);
    border-radius: var(--rounded-full);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
  }

  .status-pill.configured {
    background: var(--color-success-soft);
    color: var(--color-success-strong);
  }

  .status-pill.missing {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong);
  }

  .meta {
    display: grid;
    gap: var(--spacing-sm);
    margin: 0;
  }

  .meta div {
    display: grid;
    gap: var(--spacing-xxs);
  }

  .meta dt {
    font-size: var(--text-caption);
    color: var(--color-ink-subtle);
  }

  .meta dd {
    margin: 0;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--text-mono);
    word-break: break-all;
  }

  .columns {
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  }

  .columns h3 {
    margin: 0 0 var(--spacing-xs);
    font-size: var(--text-body);
    font-weight: 600;
  }

  .columns ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--spacing-xs);
  }

  .columns li {
    display: grid;
    gap: var(--spacing-xxs);
  }

  .muted {
    color: var(--color-ink-subtle);
    font-size: var(--text-body);
  }

  .adapter-error {
    color: var(--color-danger-strong);
  }
</style>
