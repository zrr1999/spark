<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { statusLabel } from "$lib/i18n";
  import { Button, Field, Input, PageHeader, Select, Textarea } from "$lib/ui";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { untrack } from "svelte";

  type ChannelEditorValues = {
    feishuEnabled: boolean;
    feishuAppId: string;
    feishuAppSecret: string;
    feishuAppSecretSet: boolean;
    infoflowEnabled: boolean;
    infoflowEndpoint: string;
    infoflowAppKey: string;
    infoflowAppAgentId: string;
    infoflowAppSecret: string;
    infoflowAppSecretSet: boolean;
    infoflowAllowedUserIds: string;
    infoflowGroupPolicy: "disabled" | "allowlist" | "open";
    infoflowGroupTrigger: "mention" | "command" | "all";
    infoflowAllowedGroupIds: string;
    infoflowSystemPrompt: string;
    routeName: string;
    routeAdapter: "feishu" | "infoflow";
    routeRecipient: string;
    ingressEnabled: boolean;
    onUnbound: "reject" | "create";
  };

  let { data, form } = $props();
  let t = $derived(data.messages.channelsSettings);
  let common = $derived(data.messages.common);
  let status = $derived(data.channelStatus);
  let defaultEndpoint = $derived(data.defaults.infoflowEndpoint);
  let groupPolicyOptions = $derived([
    {
      id: "infoflow-group-policy",
      options: [
        { value: "disabled", label: t.infoflowGroupPolicyDisabled },
        { value: "allowlist", label: t.infoflowGroupPolicyAllowlist },
        { value: "open", label: t.infoflowGroupPolicyOpen },
      ],
    },
  ]);
  let groupTriggerOptions = $derived([
    {
      id: "infoflow-group-trigger",
      options: [
        { value: "mention", label: t.infoflowGroupTriggerMention },
        { value: "command", label: t.infoflowGroupTriggerCommand },
        { value: "all", label: t.infoflowGroupTriggerAll },
      ],
    },
  ]);
  let values = $state<ChannelEditorValues>(structuredClone(untrack(() => data.editor)));
  let saveState = $state<"idle" | "saving" | "saved" | "error">("idle");
  let saveMessage = $state<string | null>(null);

  $effect(() => {
    if (form?.values) {
      values = structuredClone(form.values);
      if (form.message && saveState !== "saving") {
        saveMessage = form.message;
        saveState = form.message === t.saveSuccess ? "saved" : "error";
      }
    }
  });

  const handleEnhance: SubmitFunction = () => {
    if (!values.infoflowEndpoint.trim()) {
      values.infoflowEndpoint = defaultEndpoint;
    }
    saveState = "saving";
    saveMessage = t.saving;
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        saveState = "saved";
        saveMessage = t.saveSuccess;
        await invalidateAll();
        return;
      }
      if (result.type === "failure") {
        saveState = "error";
        const payload = result.data as { message?: string } | undefined;
        saveMessage = payload?.message ?? t.saveFailed;
        return;
      }
      saveState = "error";
      saveMessage = t.saveFailed;
    };
  };
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="channels-settings">
  <PageHeader
    title={t.title}
    lede={t.lede}
    statusLabel={status.available ? (status.configured ? t.configured : t.notConfigured) : t.runtimeUnavailable}
    statusClass={status.available && status.configured ? "ready" : "offline"}
  />

  {#if saveState !== "idle"}
    <div class="save-status" data-state={saveState} aria-live="polite">
      {#if saveState === "saving"}
        {t.saving}
      {:else if saveState === "saved"}
        {t.saved}
      {:else if saveState === "error"}
        {saveMessage ?? t.saveFailed}
      {/if}
    </div>
  {/if}

  <details class="diagnostics">
    <summary><span><strong>{t.diagnosticsTitle}</strong><small>{t.diagnosticsHint}</small></span></summary>
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

  <form class="panel editor" method="POST" action="?/save" use:enhance={handleEnhance}>
    <input type="hidden" name="feishuAppSecretSet" value={values.feishuAppSecretSet ? "1" : "0"} />
    <input
      type="hidden"
      name="infoflowAppSecretSet"
      value={values.infoflowAppSecretSet ? "1" : "0"}
    />
    <section class="adapter-block" aria-labelledby="feishu-title">
      <label class="toggle-row">
        <input
          type="checkbox"
          name="feishuEnabled"
          checked={values.feishuEnabled}
          onchange={(event) => {
            values.feishuEnabled = event.currentTarget.checked;
            if (values.feishuEnabled && values.routeAdapter !== "infoflow") {
              values.routeAdapter = "feishu";
            }
          }}
        />
        <span>
          <strong id="feishu-title">{t.feishuTitle}</strong>
          <small>{t.feishuHint}</small>
        </span>
      </label>
      {#if values.feishuEnabled}
        <div class="field-grid">
          <Field id="feishu-app-id" label={t.feishuAppId}>
            <Input
              id="feishu-app-id"
              name="feishuAppId"
              type="text"
              autocomplete="off"
              bind:value={values.feishuAppId}
              placeholder="cli_xxx"
            />
          </Field>
          <Field id="feishu-app-secret" label={t.feishuAppSecret}>
            <Input
              id="feishu-app-secret"
              name="feishuAppSecret"
              type="password"
              autocomplete="off"
              bind:value={values.feishuAppSecret}
              placeholder={values.feishuAppSecretSet ? t.secretStored : "••••••••"}
            />
          </Field>
        </div>
      {/if}
    </section>

    <section class="adapter-block" aria-labelledby="infoflow-title">
      <label class="toggle-row">
        <input
          type="checkbox"
          name="infoflowEnabled"
          checked={values.infoflowEnabled}
          onchange={(event) => {
            values.infoflowEnabled = event.currentTarget.checked;
            if (values.infoflowEnabled) {
              values.routeAdapter = "infoflow";
              if (!values.infoflowEndpoint.trim()) {
                values.infoflowEndpoint = defaultEndpoint;
              }
            }
          }}
        />
        <span>
          <strong id="infoflow-title">{t.infoflowTitle}</strong>
          <small>{t.infoflowHint}</small>
        </span>
      </label>
      {#if values.infoflowEnabled}
        <div class="field-grid">
          <Field id="infoflow-app-agent-id" label={t.infoflowAppAgentId} hint={t.infoflowAppAgentIdHint}>
            <Input
              id="infoflow-app-agent-id"
              name="infoflowAppAgentId"
              type="text"
              autocomplete="off"
              bind:value={values.infoflowAppAgentId}
            />
          </Field>
          <Field id="infoflow-app-key" label={t.infoflowAppKey}>
            <Input
              id="infoflow-app-key"
              name="infoflowAppKey"
              type="text"
              autocomplete="off"
              bind:value={values.infoflowAppKey}
            />
          </Field>
          <Field id="infoflow-app-secret" label={t.infoflowAppSecret}>
            <Input
              id="infoflow-app-secret"
              name="infoflowAppSecret"
              type="password"
              autocomplete="off"
              bind:value={values.infoflowAppSecret}
              placeholder={values.infoflowAppSecretSet ? t.secretStored : "••••••••"}
            />
          </Field>
        </div>
        <details class="advanced">
          <summary>{t.infoflowAdvanced}</summary>
          <div class="field-grid">
            <Field id="infoflow-endpoint" label={t.infoflowEndpoint} hint={t.infoflowEndpointHint}>
              <Input
                id="infoflow-endpoint"
                name="infoflowEndpoint"
                type="url"
                autocomplete="off"
                bind:value={values.infoflowEndpoint}
                placeholder={defaultEndpoint}
              />
            </Field>
            <div class="span-2">
              <Field id="infoflow-allowed-users" label={t.infoflowAllowedUserIds} hint={t.infoflowAllowedUserIdsHint}>
                <Input
                  id="infoflow-allowed-users"
                  name="infoflowAllowedUserIds"
                  type="text"
                  autocomplete="off"
                  bind:value={values.infoflowAllowedUserIds}
                  placeholder={t.infoflowAllowedUserIdsPlaceholder}
                />
              </Field>
            </div>
            <Field id="infoflow-group-policy" label={t.infoflowGroupPolicy} hint={t.infoflowGroupPolicyHint}>
              <Select
                id="infoflow-group-policy"
                name="infoflowGroupPolicy"
                label={t.infoflowGroupPolicy}
                groups={groupPolicyOptions}
                value={values.infoflowGroupPolicy}
                onValueChange={(value) => (values.infoflowGroupPolicy = value as ChannelEditorValues["infoflowGroupPolicy"])}
              />
            </Field>
            <Field id="infoflow-allowed-groups" label={t.infoflowAllowedGroupIds} hint={t.infoflowAllowedGroupIdsHint}>
              <Input
                id="infoflow-allowed-groups"
                name="infoflowAllowedGroupIds"
                type="text"
                autocomplete="off"
                bind:value={values.infoflowAllowedGroupIds}
                placeholder={t.infoflowAllowedGroupIdsPlaceholder}
                disabled={values.infoflowGroupPolicy !== "allowlist"}
              />
            </Field>
            <Field id="infoflow-group-trigger" label={t.infoflowGroupTrigger} hint={t.infoflowGroupTriggerHint}>
              <Select
                id="infoflow-group-trigger"
                name="infoflowGroupTrigger"
                label={t.infoflowGroupTrigger}
                groups={groupTriggerOptions}
                value={values.infoflowGroupTrigger}
                onValueChange={(value) => (values.infoflowGroupTrigger = value as ChannelEditorValues["infoflowGroupTrigger"])}
              />
            </Field>
            <div class="span-2">
              <Field id="infoflow-system-prompt" label={t.infoflowSystemPrompt} hint={t.infoflowSystemPromptHint}>
                <Textarea
                  id="infoflow-system-prompt"
                  name="infoflowSystemPrompt"
                  rows={4}
                  autocomplete="off"
                  bind:value={values.infoflowSystemPrompt}
                  placeholder={t.infoflowSystemPromptPlaceholder}
                />
              </Field>
            </div>
          </div>
        </details>
      {/if}
    </section>

    <!-- Keep ingress defaults without exposing unused route/session-binding UI. -->
    <input type="hidden" name="ingressEnabled" value="on" />
    <input type="hidden" name="onUnbound" value="create" />
    <input type="hidden" name="routeName" value="" />
    <input type="hidden" name="routeAdapter" value="infoflow" />
    <input type="hidden" name="routeRecipient" value="" />

    {#if saveMessage && saveState === "error"}
      <p class="form-flash error" role="status">{saveMessage}</p>
    {/if}

    <div class="form-actions">
      <Button type="submit" disabled={saveState === "saving"}>
        {saveState === "saving" ? t.saving : t.saveManual}
      </Button>
    </div>
  </form>
</section>

<style>
  .channels-settings {
    display: grid;
    gap: 20px;
    max-width: 960px;
    min-width: 0;
    width: 100%;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    font-size: 16px;
    font-weight: 600;
  }

  h3 {
    font-size: 14px;
    font-weight: 600;
  }

  .muted {
    color: var(--color-ink-subtle);
    font-size: 14px;
    line-height: 1.5;
  }

  .save-status {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 600;
    padding: 6px 12px;
    white-space: nowrap;
    width: fit-content;
  }

  .save-status[data-state="saving"] {
    color: var(--color-ink-muted);
  }

  .save-status[data-state="saved"] {
    background: var(--color-success-soft);
    border-color: transparent;
    color: var(--color-success-strong, var(--color-success));
  }

  .save-status[data-state="error"] {
    background: var(--color-danger-soft);
    border-color: transparent;
    color: var(--color-danger-strong, var(--color-danger));
  }

  .panel,
  .diagnostic-panel {
    background: var(--color-surface);
    display: grid;
    gap: 14px;
    padding: 18px;
  }

  .panel {
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
  }

  .editor .adapter-block:first-of-type {
    border-top: 0;
    padding-top: 0;
  }

  .diagnostics {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    overflow: hidden;
  }

  .diagnostics summary {
    cursor: pointer;
    list-style: none;
    padding: 14px 18px;
  }

  .diagnostics summary::-webkit-details-marker { display: none; }
  .diagnostics summary span { display: grid; gap: 3px; }
  .diagnostics summary small { color: var(--color-ink-subtle); font-weight: 400; }
  .diagnostics[open] summary { border-bottom: 1px solid var(--color-border); }

  .panel-heading {
    align-items: center;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .meta {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .meta div {
    display: grid;
    gap: 4px;
  }

  .meta dt {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .meta dd {
    margin: 0;
  }

  .columns {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  ul {
    display: grid;
    gap: 8px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    display: grid;
    gap: 4px;
    padding: 10px 12px;
  }

  .adapter-error {
    color: var(--color-danger-strong, var(--color-danger));
    overflow-wrap: anywhere;
  }

  .editor {
    gap: 18px;
  }

  .adapter-block {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    gap: 12px;
    padding-top: 16px;
  }

  .toggle-row {
    align-items: start;
    display: grid;
    gap: 10px;
    grid-template-columns: auto 1fr;
  }

  .toggle-row strong {
    display: block;
    font-size: 14px;
    font-weight: 600;
  }

  .toggle-row small {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 12px;
    line-height: 1.4;
    margin-top: 2px;
  }

  .advanced {
    border: 1px solid var(--color-border-soft);
    border-radius: 8px;
    padding: 0 12px;
  }

  .advanced summary {
    align-items: center;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: flex;
    font-size: 13px;
    font-weight: 600;
    list-style: none;
    min-height: 40px;
    padding: 10px 0;
  }

  .advanced summary::-webkit-details-marker {
    display: none;
  }

  .advanced[open] summary {
    border-bottom: 1px solid var(--color-border-soft);
    margin-bottom: 12px;
  }

  .field-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .field-grid .span-2 {
    grid-column: 1 / -1;
  }

  .mono {
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .form-flash.error {
    color: var(--color-danger-strong, var(--color-danger));
    margin: 0;
  }

  .form-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 12px 16px;
  }

  .status-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
  }

  .status-pill.configured {
    background: var(--color-success-soft);
    color: var(--color-success-strong, var(--color-success));
  }

  .status-pill.missing {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong, var(--color-warning));
  }

  @media (max-width: 720px) {
    .field-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
