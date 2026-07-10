<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  import type { SparkModelCatalogProvider } from "@zendev-lab/spark-protocol";

  let { data, form } = $props();
  let isZh = $derived(data.locale?.toLowerCase().startsWith("zh"));
  let snapshot = $derived(data.control.snapshot);
  let flow = $derived(data.flow);
  let availableModels = $derived(
    snapshot.providers.flatMap((provider: SparkModelCatalogProvider) =>
      provider.models.filter((model) => model.available),
    ),
  );
  let defaultModelAvailable = $derived(
    Boolean(
      snapshot.defaultModel &&
        availableModels.some((entry) => modelValue(entry.model) === modelValue(snapshot.defaultModel!)),
    ),
  );
  let copy = $derived(
    isZh
      ? {
          headTitle: "模型与 Provider · Spark",
          eyebrow: "模型控制",
          title: "模型与 Provider",
          lede: "Daemon 统一保存凭据、默认模型与 OAuth 状态；浏览器不会读取密钥。",
          daemonUnavailable: "Spark daemon 不可用。启动或升级 daemon 后再配置模型。",
          noAvailableModels: "先为下方 Provider 配置登录凭据，随后即可选择默认模型。",
          currentModelUnavailable: "当前默认模型不可用，请选择新的默认模型",
          defaultTitle: "默认模型",
          defaultBody: "新对话继承此模型；对话页可以单独切换当前会话模型。",
          saveDefault: "设为默认",
          providersTitle: "Provider 登录",
          configured: "已配置",
          missing: "未配置",
          via: "来源",
          models: "模型",
          apiKey: "API Key",
          apiKeyPlaceholder: "粘贴 API Key",
          saveKey: "保存密钥",
          login: "登录",
          logout: "移除已保存凭据",
          ambient: "该凭据来自环境或外部配置，Spark 不会删除它。",
          noAuth: "此 Provider 不需要登录。",
          flowTitle: "登录进行中",
          openAuthorization: "打开授权页面",
          deviceCode: "设备码",
          response: "继续",
          cancel: "取消登录",
          done: "登录完成",
          close: "关闭",
          diagnostics: "Provider 诊断",
        }
      : {
          headTitle: "Models & providers · Spark",
          eyebrow: "Model control",
          title: "Models & providers",
          lede: "The daemon owns credentials, the default model, and OAuth state. Secrets never reach the browser read model.",
          daemonUnavailable: "The Spark daemon is unavailable. Start or upgrade it before configuring models.",
          noAvailableModels: "Configure a provider credential below, then choose the default model.",
          currentModelUnavailable: "Current default is unavailable — choose a new default",
          defaultTitle: "Default model",
          defaultBody: "New conversations inherit this model; each conversation can override it from chat.",
          saveDefault: "Set default",
          providersTitle: "Provider login",
          configured: "Configured",
          missing: "Not configured",
          via: "Source",
          models: "Models",
          apiKey: "API key",
          apiKeyPlaceholder: "Paste API key",
          saveKey: "Save credential",
          login: "Log in",
          logout: "Remove stored credential",
          ambient: "This credential comes from the environment or external config; Spark will not delete it.",
          noAuth: "This provider does not require login.",
          flowTitle: "Login in progress",
          openAuthorization: "Open authorization page",
          deviceCode: "Device code",
          response: "Continue",
          cancel: "Cancel login",
          done: "Login complete",
          close: "Close",
          diagnostics: "Provider diagnostics",
        },
  );

  $effect(() => {
    if (!flow || terminal(flow.status)) return;
    const timer = setInterval(() => void invalidateAll(), 1_000);
    return () => clearInterval(timer);
  });

  function terminal(status: string) {
    return status === "succeeded" || status === "failed" || status === "cancelled";
  }

  function modelValue(model: { providerName: string; modelId: string }) {
    return `${model.providerName}/${model.modelId}`;
  }

  function modelLabel(model: { providerName: string; modelId: string; providerLabel?: string; modelLabel?: string }) {
    return `${model.modelLabel ?? model.modelId} · ${model.providerLabel ?? model.providerName}`;
  }

  function sourceLabel(source: string | undefined) {
    if (!source) return copy.missing;
    if (source === "environment") return "Environment";
    if (source === "literal") return "Provider config";
    return "Spark auth store";
  }
</script>

<svelte:head><title>{copy.headTitle}</title></svelte:head>

<section class="models-settings" aria-labelledby="models-title">
  <header class="page-heading">
    <p class="eyebrow">{copy.eyebrow}</p>
    <h1 id="models-title">{copy.title}</h1>
    <p>{copy.lede}</p>
  </header>

  {#if !data.control.available}
    <div class="notice error" role="alert"><Icon name="warning" size={18} />{copy.daemonUnavailable}</div>
  {/if}

  {#if flow || data.flowError}
    <section class="flow-card" aria-live="polite">
      <div class="card-heading">
        <div><p class="eyebrow">OAuth</p><h2>{copy.flowTitle}</h2></div>
        {#if flow}<span class="status {flow.status}">{flow.status}</span>{/if}
      </div>
      {#if data.flowError}<p class="error-text">{data.flowError}</p>{/if}
      {#if flow}
        <p>{flow.providerLabel ?? flow.providerName}</p>
        {#if flow.authorization}
          <a class="primary-action" href={flow.authorization.url} target="_blank" rel="noreferrer">
            <Icon name="play" size={15} />{copy.openAuthorization}
          </a>
          {#if flow.authorization.instructions}<p class="muted">{flow.authorization.instructions}</p>{/if}
        {/if}
        {#if flow.deviceCode}
          <div class="device-code"><span>{copy.deviceCode}</span><strong>{flow.deviceCode.userCode}</strong><a href={flow.deviceCode.verificationUri} target="_blank" rel="noreferrer">{flow.deviceCode.verificationUri}</a></div>
        {/if}
        {#if flow.prompt}
          <form method="POST" action="?/respondOAuth" class="prompt-form">
            <input type="hidden" name="flowId" value={flow.id} />
            <input type="hidden" name="promptId" value={flow.prompt.id} />
            <label>
              <span>{flow.prompt.message}</span>
              {#if flow.prompt.kind === "select"}
                <select name="response" required>
                  {#each flow.prompt.options as option}<option value={option.id}>{option.label}</option>{/each}
                </select>
              {:else}
                <input name="response" placeholder={flow.prompt.placeholder ?? ""} required={flow.prompt.allowEmpty !== true} autocomplete="off" />
              {/if}
            </label>
            <button type="submit">{copy.response}</button>
          </form>
        {/if}
        {#if flow.progress.length > 0}<p class="muted">{flow.progress.at(-1)}</p>{/if}
        {#if flow.error}<p class="error-text">{flow.error}</p>{/if}
        {#if flow.status === "succeeded"}
          <a class="secondary-action" href="/settings/models">{copy.done} · {copy.close}</a>
        {:else if !terminal(flow.status)}
          <form method="POST" action="?/cancelOAuth"><input type="hidden" name="flowId" value={flow.id} /><button class="secondary-action" type="submit">{copy.cancel}</button></form>
        {/if}
      {/if}
    </section>
  {/if}

  <section class="settings-card">
    <div class="card-heading"><div><h2>{copy.defaultTitle}</h2><p>{copy.defaultBody}</p></div></div>
    {#if availableModels.length > 0}
      <form method="POST" action="?/setDefaultModel" class="inline-form" use:enhance>
        <select
          name="model"
          aria-label={copy.defaultTitle}
          value={snapshot.defaultModel ? modelValue(snapshot.defaultModel) : undefined}
        >
          {#if snapshot.defaultModel && !defaultModelAvailable}
            <option value={modelValue(snapshot.defaultModel)} disabled>{copy.currentModelUnavailable}</option>
          {/if}
          {#each availableModels as entry}<option value={modelValue(entry.model)}>{modelLabel(entry.model)}</option>{/each}
        </select>
        <button type="submit">{copy.saveDefault}</button>
      </form>
    {:else}<p class="muted">{data.control.available ? copy.noAvailableModels : copy.daemonUnavailable}</p>{/if}
  </section>

  <section class="providers-section">
    <div class="section-heading"><h2>{copy.providersTitle}</h2><span>{snapshot.providers.length}</span></div>
    <div class="provider-grid">
      {#each snapshot.providers as provider}
        <article class="provider-card">
          <div class="card-heading">
            <div><h3>{provider.label}</h3><p>{provider.providerName}</p></div>
            <span class:configured={provider.auth.configured} class="status">{provider.auth.configured ? copy.configured : copy.missing}</span>
          </div>
          <p class="meta">{copy.models}: {provider.models.length} · {copy.via}: {sourceLabel(provider.auth.source)}</p>
          {#if provider.models.length > 0}
            <div class="model-tags">{#each provider.models.slice(0, 6) as entry}<span class:unavailable={!entry.available}>{entry.model.modelLabel ?? entry.model.modelId}</span>{/each}</div>
          {/if}
          {#if provider.auth.kind === "api_key"}
            <form method="POST" action="?/saveApiKey" class="credential-form" use:enhance>
              <input type="hidden" name="providerName" value={provider.providerName} />
              <label><span>{copy.apiKey}</span><input name="apiKey" type="password" autocomplete="new-password" placeholder={copy.apiKeyPlaceholder} required /></label>
              <button type="submit">{copy.saveKey}</button>
            </form>
            {#if provider.auth.source === "stored"}
              <form method="POST" action="?/logout" use:enhance><input type="hidden" name="providerName" value={provider.providerName} /><button class="link-action" type="submit">{copy.logout}</button></form>
            {:else if provider.auth.configured}<p class="muted">{copy.ambient}</p>{/if}
          {:else if provider.auth.kind === "oauth"}
            {#if provider.auth.configured}
              <form method="POST" action="?/logout" use:enhance><input type="hidden" name="providerName" value={provider.providerName} /><button class="link-action" type="submit">{copy.logout}</button></form>
            {:else}
              <form method="POST" action="?/startOAuth"><input type="hidden" name="providerName" value={provider.providerName} /><button type="submit">{copy.login}</button></form>
            {/if}
          {:else}<p class="muted">{copy.noAuth}</p>{/if}
        </article>
      {/each}
    </div>
  </section>

  {#if snapshot.diagnostics.length > 0}
    <details class="diagnostics"><summary>{copy.diagnostics}</summary><ul>{#each snapshot.diagnostics as diagnostic}<li>{diagnostic}</li>{/each}</ul></details>
  {/if}

  {#if form?.message}<p class:success={form.success} class="form-message">{form.message}</p>{/if}
</section>

<style>
  .models-settings { display: grid; gap: 22px; max-width: 1120px; padding: 28px 32px 48px; }
  h1, h2, h3, p { margin: 0; }
  .page-heading { display: grid; gap: 7px; max-width: 760px; }
  .page-heading h1 { font-size: 25px; letter-spacing: -.02em; }
  .page-heading > p:last-child, .card-heading p, .muted, .meta { color: var(--color-ink-subtle); line-height: 1.5; }
  .eyebrow { color: var(--color-primary); font-size: 11px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
  .settings-card, .flow-card, .provider-card, .diagnostics { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 14px; padding: 18px; }
  .settings-card, .flow-card, .provider-card { display: grid; gap: 14px; }
  .card-heading, .section-heading, .inline-form { align-items: center; display: flex; gap: 12px; justify-content: space-between; }
  .provider-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .providers-section { display: grid; gap: 12px; }
  .section-heading span, .status { background: var(--color-surface-soft); border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-ink-subtle); font-size: 11px; font-weight: 700; padding: 4px 8px; }
  .status.configured, .status.succeeded { background: var(--color-success-weak); border-color: var(--color-success-soft); color: var(--color-success-strong); }
  .model-tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .model-tags span { background: var(--color-primary-weak); border-radius: 6px; color: var(--color-primary); font-size: 11px; padding: 4px 7px; }
  .model-tags span.unavailable { background: var(--color-surface-soft); color: var(--color-ink-subtle); text-decoration: line-through; }
  form { margin: 0; }
  .credential-form, .prompt-form { display: grid; gap: 10px; }
  label { display: grid; gap: 5px; }
  label span { color: var(--color-ink-muted); font-size: 12px; font-weight: 650; }
  input, select { background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: 8px; color: var(--color-ink); font: inherit; min-height: 38px; padding: 7px 10px; }
  button, .primary-action, .secondary-action { align-items: center; border-radius: 8px; cursor: pointer; display: inline-flex; font: inherit; font-size: 13px; font-weight: 700; gap: 6px; justify-content: center; min-height: 36px; padding: 0 12px; text-decoration: none; width: fit-content; }
  button, .primary-action { background: var(--color-primary); border: 0; color: var(--color-on-primary); }
  .secondary-action { background: var(--color-surface-soft); border: 1px solid var(--color-border); color: var(--color-ink-muted); }
  .link-action { background: transparent; color: var(--color-danger); padding: 0; }
  .notice { align-items: center; background: var(--color-danger-weak); border: 1px solid var(--color-danger-soft); border-radius: 10px; color: var(--color-danger); display: flex; gap: 8px; padding: 12px; }
  .device-code { background: var(--color-canvas); border-radius: 10px; display: grid; gap: 5px; padding: 12px; }
  .device-code strong { font-family: ui-monospace, monospace; font-size: 22px; letter-spacing: .12em; }
  .error-text, .form-message { color: var(--color-danger); }
  .form-message.success { color: var(--color-success-strong); }
  @media (max-width: 640px) {
    .models-settings { padding: 20px 14px 36px; }
    .provider-grid { grid-template-columns: minmax(0, 1fr); }
    .card-heading, .inline-form { align-items: stretch; flex-direction: column; }
    .inline-form select, .inline-form button { width: 100%; }
  }
</style>
