<script lang="ts">
  import { enhance } from "$app/forms";
  import { formatChannelSessionTitle } from "$lib/channel-session-title";
  import {
    createChannelScopes,
    defaultCreateChannelScope,
    parseChannelExternalKeyParts,
    type CreateChannelAdapter,
    type CreateChannelFormValues,
    type WorkspaceChannelListItem,
  } from "$lib/create-channel";
  import { formatRelativeTime, statusLabel } from "$lib/i18n";
  import { Button, Field, Input, PageHeader, Select } from "$lib/ui";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { untrack } from "svelte";

  let { data, form } = $props();
  let t = $derived(data.messages.channelsSettings);
  let common = $derived(data.messages.common);
  let status = $derived(data.channelStatus);
  let editor = $derived(data.editor);
  let channels = $derived(data.channels);
  let defaultEndpoint = $derived(data.defaults.infoflowEndpoint);

  let values = $state<CreateChannelFormValues>(
    structuredClone(
      untrack(() =>
        form?.values ?? {
          adapter: data.defaults.adapter,
          scope: data.defaults.scope,
          externalId: "",
          title: "",
          feishuAppId: data.editor.feishuAppId,
          feishuAppSecret: "",
          infoflowEndpoint: data.editor.infoflowEndpoint || data.defaults.infoflowEndpoint,
          infoflowAppKey: data.editor.infoflowAppKey,
          infoflowAppAgentId: data.editor.infoflowAppAgentId,
          infoflowAppSecret: "",
          qqbotAppId: data.editor.qqbotAppId,
          qqbotClientSecret: "",
          qqbotSandbox: data.editor.qqbotSandbox,
        },
      ),
    ),
  );
  let formMode = $state<"create" | "editCredentials">("create");
  let editingSessionId = $state<string | null>(null);
  let submitState = $state<"idle" | "creating" | "saving" | "saved" | "error">("idle");
  let errorMessage = $state<string | null>(null);
  let statusMessage = $state<string | null>(null);
  let editorSection: HTMLElement | null = $state(null);

  $effect(() => {
    if (form?.values) {
      values = structuredClone(form.values);
      if (form.intent === "saveCredentials" && form.message === t.saveCredentialsSuccess) {
        statusMessage = form.message;
        errorMessage = null;
        submitState = "saved";
        formMode = "editCredentials";
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

  let scopeOptions = $derived([
    {
      id: "channel-scope",
      options: createChannelScopes(values.adapter).map((scope) => ({
        value: scope,
        label: scopeLabel(values.adapter, scope),
      })),
    },
  ]);

  let credentialsReady = $derived(
    values.adapter === "feishu"
      ? editor.feishuEnabled && editor.feishuAppSecretSet
      : values.adapter === "infoflow"
        ? editor.infoflowEnabled && editor.infoflowAppSecretSet
        : editor.qqbotEnabled && editor.qqbotClientSecretSet,
  );

  function adapterLabel(adapter: CreateChannelAdapter): string {
    switch (adapter) {
      case "feishu":
        return t.feishuTitle;
      case "infoflow":
        return t.infoflowTitle;
      case "qqbot":
        return t.qqbotTitle;
      default: {
        const _exhaustive: never = adapter;
        throw new Error(`unsupported create-channel adapter: ${String(_exhaustive)}`);
      }
    }
  }

  function scopeLabel(adapter: CreateChannelAdapter, scope: string): string {
    switch (adapter) {
      case "feishu":
        return t.scopeFeishuChat;
      case "infoflow":
        return scope === "group" ? t.scopeInfoflowGroup : t.scopeInfoflowUser;
      case "qqbot":
        if (scope === "group") return t.scopeQqbotGroup;
        if (scope === "channel") return t.scopeQqbotChannel;
        return t.scopeQqbotC2c;
      default: {
        const _exhaustive: never = adapter;
        throw new Error(`unsupported create-channel adapter: ${String(_exhaustive)}`);
      }
    }
  }

  function onAdapterChange(next: string) {
    const adapter =
      next === "feishu" || next === "infoflow" || next === "qqbot" ? next : "infoflow";
    values.adapter = adapter;
    if (!createChannelScopes(adapter).includes(values.scope)) {
      values.scope = defaultCreateChannelScope(adapter);
    }
    if (adapter === "feishu") {
      values.feishuAppId = values.feishuAppId || editor.feishuAppId;
    } else if (adapter === "infoflow") {
      values.infoflowEndpoint =
        values.infoflowEndpoint || editor.infoflowEndpoint || defaultEndpoint;
      values.infoflowAppKey = values.infoflowAppKey || editor.infoflowAppKey;
      values.infoflowAppAgentId = values.infoflowAppAgentId || editor.infoflowAppAgentId;
    } else {
      values.qqbotAppId = values.qqbotAppId || editor.qqbotAppId;
      values.qqbotSandbox = editor.qqbotSandbox;
    }
  }

  function fillCredentialsFromEditor(adapter: CreateChannelAdapter) {
    if (adapter === "feishu") {
      values.feishuAppId = editor.feishuAppId;
      values.feishuAppSecret = "";
    } else if (adapter === "infoflow") {
      values.infoflowEndpoint = editor.infoflowEndpoint || defaultEndpoint;
      values.infoflowAppKey = editor.infoflowAppKey;
      values.infoflowAppAgentId = editor.infoflowAppAgentId;
      values.infoflowAppSecret = "";
    } else {
      values.qqbotAppId = editor.qqbotAppId;
      values.qqbotClientSecret = "";
      values.qqbotSandbox = editor.qqbotSandbox;
    }
  }

  function editChannelSettings(channel: WorkspaceChannelListItem) {
    const binding = channel.bindings[0];
    if (!binding) return;
    const parts = parseChannelExternalKeyParts(binding.externalKey);
    if (!parts) return;
    values.adapter = parts.adapter;
    values.scope = parts.scope;
    values.externalId = parts.id;
    values.title = channel.title.startsWith("channel ") ? "" : channel.title;
    fillCredentialsFromEditor(parts.adapter);
    editingSessionId = channel.sessionId;
    formMode = "editCredentials";
    errorMessage = null;
    statusMessage = null;
    submitState = "idle";
    queueMicrotask(() => {
      editorSection?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("credentials-title")?.focus({ preventScroll: true });
    });
  }

  function cancelEditCredentials() {
    formMode = "create";
    editingSessionId = null;
    statusMessage = null;
    errorMessage = null;
    submitState = "idle";
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
          payload?.message ??
          (savingCredentials ? t.saveCredentialsFailed : t.createFailed);
        return;
      }
      if (result.type === "success" && savingCredentials) {
        submitState = "saved";
        const payload = result.data as { message?: string } | undefined;
        statusMessage = payload?.message ?? t.saveCredentialsSuccess;
        return;
      }
      submitState = "error";
      errorMessage = savingCredentials ? t.saveCredentialsFailed : t.createFailed;
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
    {#if !data.sessionsAvailable}
      <p class="muted">{t.listUnavailable}</p>
    {:else if channels.length === 0}
      <p class="muted">{t.listEmpty}</p>
    {:else}
      <ul class="channel-rows">
        {#each channels as channel (channel.sessionId)}
          <li>
            <div class="channel-row-main">
              <strong>
                {formatChannelSessionTitle(channel.title, {
                  locale: data.locale,
                  fallback: channel.sessionId,
                })}
              </strong>
              <span class="meta-line">
                {#each channel.bindings as binding, index (binding.externalKey)}
                  {#if index > 0}<span aria-hidden="true"> · </span>{/if}
                  <span>{adapterLabel(binding.adapter)}</span>
                  <span class="mono">{binding.externalKey}</span>
                {/each}
              </span>
              <small>
                {statusLabel(channel.status, common)}
                · {formatRelativeTime(channel.updatedAt, data.locale, common)}
              </small>
            </div>
            <div class="channel-row-actions">
              <button
                type="button"
                class="row-action"
                class:active={formMode === "editCredentials" &&
                  editingSessionId === channel.sessionId}
                onclick={() => editChannelSettings(channel)}
              >
                {t.listSettings}
              </button>
              <a class="row-action" href={`/sessions/${channel.sessionId}`}>{t.listOpen}</a>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <form
    class="panel editor"
    method="POST"
    action={formMode === "editCredentials" ? "?/saveCredentials" : "?/createChannel"}
    use:enhance={handleEnhance}
    bind:this={editorSection}
  >
    <div class="credentials-heading">
      <h2 id="create-channel-title">
        {formMode === "editCredentials" ? t.editCredentialsTitle : t.createSectionTitle}
      </h2>
      {#if formMode === "editCredentials"}
        <p>{t.editCredentialsHint}</p>
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
        <Field id="channel-scope" label={t.scopeLabel} hint={t.scopeHint} required>
          <Select
            id="channel-scope"
            name="scope"
            bind:value={values.scope}
            groups={scopeOptions}
            label={t.scopeLabel}
          />
        </Field>
        <Field id="channel-external-id" label={t.externalIdLabel} hint={t.externalIdHint} required>
          <Input
            id="channel-external-id"
            name="externalId"
            type="text"
            autocomplete="off"
            bind:value={values.externalId}
            placeholder={t.externalIdPlaceholder}
            required
          />
        </Field>
        <Field id="channel-title" label={t.titleLabel} hint={t.titleHint}>
          <Input
            id="channel-title"
            name="title"
            type="text"
            autocomplete="off"
            bind:value={values.title}
            placeholder={t.titlePlaceholder}
          />
        </Field>
      </div>
    {:else}
      <input type="hidden" name="adapter" value={values.adapter} />
      <input type="hidden" name="scope" value={values.scope} />
      <input type="hidden" name="externalId" value={values.externalId} />
      <dl class="binding-summary">
        <div>
          <dt>{t.listAdapter}</dt>
          <dd>{adapterLabel(values.adapter)}</dd>
        </div>
        <div>
          <dt>{t.listBinding}</dt>
          <dd class="mono">{values.adapter}:{values.scope}:{values.externalId}</dd>
        </div>
      </dl>
    {/if}

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
        <Button type="button" variant="ghost" onclick={cancelEditCredentials}>
          {t.cancelEdit}
        </Button>
        <Button type="submit" disabled={submitState === "saving"}>
          {submitState === "saving" ? t.savingCredentials : t.saveCredentialsSubmit}
        </Button>
      {:else}
        <Button type="submit" disabled={submitState === "creating"}>
          {submitState === "creating" ? t.creating : t.createSubmit}
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
          <dt>{t.configPath}</dt>
          <dd class="mono">{status.configPath}</dd>
        </div>
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
    gap: 1rem;
    max-width: 52rem;
  }

  .form-status {
    padding: 0.65rem 0.85rem;
    border-radius: 0.55rem;
    border: 1px solid color-mix(in srgb, var(--danger, #b42318) 35%, transparent);
    background: color-mix(in srgb, var(--danger, #b42318) 8%, transparent);
    color: var(--danger, #b42318);
    font-size: 0.9rem;
  }

  .form-status[data-state="ok"] {
    border-color: color-mix(in srgb, var(--success, #067647) 35%, transparent);
    background: color-mix(in srgb, var(--success, #067647) 8%, transparent);
    color: var(--success, #067647);
  }

  .panel.editor,
  .panel.channel-list,
  .diagnostic-panel {
    display: grid;
    gap: 1rem;
    padding: 1rem 1.1rem;
    border: 1px solid color-mix(in srgb, var(--border, #d0d5dd) 90%, transparent);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--surface, #fff) 92%, transparent);
  }

  .channel-rows {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.65rem;
  }

  .channel-rows li {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.65rem 0;
    border-top: 1px solid color-mix(in srgb, var(--border, #d0d5dd) 70%, transparent);
  }

  .channel-rows li:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .channel-row-main {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .channel-row-main strong {
    font-size: 0.95rem;
  }

  .meta-line {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: baseline;
    color: var(--muted, #667085);
    font-size: 0.8rem;
  }

  .channel-row-main small {
    color: var(--muted, #667085);
  }

  .channel-row-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.65rem;
  }

  .row-action {
    appearance: none;
    border: 0;
    background: transparent;
    padding: 0;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  .row-action.active {
    color: var(--accent, #175cd3);
  }

  .field-grid {
    display: grid;
    gap: 0.85rem 1rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }

  .credentials-grid .field-span-all {
    grid-column: 1 / -1;
  }

  .binding-summary {
    display: grid;
    gap: 0.65rem;
    margin: 0;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .binding-summary div {
    display: grid;
    gap: 0.2rem;
  }

  .binding-summary dt {
    font-size: 0.75rem;
    color: var(--muted, #667085);
  }

  .binding-summary dd {
    margin: 0;
  }

  .credentials {
    display: grid;
    gap: 0.85rem;
  }

  .credentials-heading h2 {
    margin: 0;
    font-size: 1rem;
  }

  .credentials-heading p {
    margin: 0.25rem 0 0;
    color: var(--muted, #667085);
    font-size: 0.875rem;
  }

  .toggle-row {
    display: flex;
    gap: 0.65rem;
    align-items: flex-start;
    padding: 0.65rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--border, #d0d5dd) 80%, transparent);
    border-radius: 0.6rem;
  }

  .toggle-row strong {
    display: block;
  }

  .toggle-row small {
    display: block;
    margin-top: 0.15rem;
    color: var(--muted, #667085);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.65rem;
  }

  @media (max-width: 40rem) {
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
    gap: 0.15rem;
  }

  .diagnostics summary small {
    color: var(--muted, #667085);
  }

  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .panel-heading h2 {
    margin: 0;
    font-size: 1rem;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .status-pill.configured {
    background: color-mix(in srgb, var(--success, #067647) 12%, transparent);
    color: var(--success, #067647);
  }

  .status-pill.missing {
    background: color-mix(in srgb, var(--warning, #b54708) 12%, transparent);
    color: var(--warning, #b54708);
  }

  .meta {
    display: grid;
    gap: 0.65rem;
    margin: 0;
  }

  .meta div {
    display: grid;
    gap: 0.2rem;
  }

  .meta dt {
    font-size: 0.75rem;
    color: var(--muted, #667085);
  }

  .meta dd {
    margin: 0;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    word-break: break-all;
  }

  .columns {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }

  .columns h3 {
    margin: 0 0 0.4rem;
    font-size: 0.875rem;
  }

  .columns ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.45rem;
  }

  .columns li {
    display: grid;
    gap: 0.1rem;
  }

  .muted {
    color: var(--muted, #667085);
    font-size: 0.875rem;
  }

  .adapter-error {
    color: var(--danger, #b42318);
  }
</style>
