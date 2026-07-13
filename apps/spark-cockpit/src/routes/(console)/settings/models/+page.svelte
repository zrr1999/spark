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
          headTitle: "模型设置 · Spark",
          eyebrow: "设置",
          title: "模型设置",
          lede: "选择新对话使用的默认模型，并管理模型服务的连接。密钥只保存在本机。",
          daemonUnavailable: "模型设置暂时不可用。请确认 Spark 正在运行后重试。",
          noAvailableModels: "请先连接至少一个模型服务，然后再选择默认模型。",
          currentModelUnavailable: "当前默认模型暂不可用",
          defaultTitle: "默认模型",
          defaultBody: "新对话会使用这个模型；你仍可以在对话中临时切换。",
          saveDefault: "保存默认模型",
          providersTitle: "模型服务",
          providersBody: "连接模型服务后，Spark 就可以使用其中的模型。",
          connected: "已连接",
          notConnected: "未连接",
          noLoginNeeded: "无需登录",
          readyHint: "已可用于对话",
          connectHint: "连接后即可使用",
          apiKey: "API 密钥",
          apiKeyPlaceholder: "粘贴 API 密钥",
          addKey: "添加 API 密钥",
          updateKey: "更新 API 密钥",
          saveKey: "保存并连接",
          login: "登录",
          logout: "断开连接",
          ambient: "此连接由系统环境提供，请在原配置位置修改。",
          flowTitle: "连接模型服务",
          openAuthorization: "前往登录",
          deviceCode: "登录代码",
          response: "继续",
          cancel: "取消",
          done: "连接成功",
          close: "关闭",
          technicalDetails: "技术详情",
          technicalDetailsBody: "供排查连接问题时使用。",
          providerId: "Provider ID",
          authMethod: "登录方式",
          authSource: "认证来源",
          authReference: "认证引用",
          modelCount: "模型数量",
          availableCount: "可用",
          diagnostics: "诊断信息",
          noDiagnostics: "暂无诊断信息。",
          sourceMissing: "未提供",
          sourceEnvironment: "环境变量",
          sourceLiteral: "Provider 配置",
          sourceStored: "Spark 本地凭据",
          authNone: "无需认证",
          authApiKey: "API 密钥",
          authOAuth: "网页登录",
          flowPending: "正在准备",
          flowWaiting: "等待你的操作",
          flowSucceeded: "已连接",
          flowFailed: "连接失败",
          flowCancelled: "已取消",
        }
      : {
          headTitle: "Model settings · Spark",
          eyebrow: "Settings",
          title: "Model settings",
          lede: "Choose the default model for new conversations and manage model provider connections. Keys stay on this device.",
          daemonUnavailable: "Model settings are temporarily unavailable. Make sure Spark is running, then try again.",
          noAvailableModels: "Connect at least one model provider before choosing a default model.",
          currentModelUnavailable: "Current default model is unavailable",
          defaultTitle: "Default model",
          defaultBody: "New conversations use this model. You can still switch models inside a conversation.",
          saveDefault: "Save default model",
          providersTitle: "Model providers",
          providersBody: "Connect a model provider to make its models available in Spark.",
          connected: "Connected",
          notConnected: "Not connected",
          noLoginNeeded: "No login needed",
          readyHint: "Ready for conversations",
          connectHint: "Connect to use this provider",
          apiKey: "API key",
          apiKeyPlaceholder: "Paste API key",
          addKey: "Add API key",
          updateKey: "Update API key",
          saveKey: "Save and connect",
          login: "Log in",
          logout: "Disconnect",
          ambient: "This connection comes from your system environment. Update it at the original source.",
          flowTitle: "Connect model provider",
          openAuthorization: "Continue to login",
          deviceCode: "Login code",
          response: "Continue",
          cancel: "Cancel",
          done: "Connected",
          close: "Close",
          technicalDetails: "Technical details",
          technicalDetailsBody: "Use these details when troubleshooting a connection.",
          providerId: "Provider ID",
          authMethod: "Login method",
          authSource: "Authentication source",
          authReference: "Authentication reference",
          modelCount: "Models",
          availableCount: "available",
          diagnostics: "Diagnostics",
          noDiagnostics: "No diagnostics reported.",
          sourceMissing: "Not provided",
          sourceEnvironment: "Environment variable",
          sourceLiteral: "Provider configuration",
          sourceStored: "Spark local credentials",
          authNone: "No authentication",
          authApiKey: "API key",
          authOAuth: "Web login",
          flowPending: "Preparing",
          flowWaiting: "Waiting for you",
          flowSucceeded: "Connected",
          flowFailed: "Connection failed",
          flowCancelled: "Cancelled",
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
    if (!source) return copy.sourceMissing;
    if (source === "environment") return copy.sourceEnvironment;
    if (source === "literal") return copy.sourceLiteral;
    return copy.sourceStored;
  }

  function authLabel(kind: SparkModelCatalogProvider["auth"]["kind"]) {
    if (kind === "api_key") return copy.authApiKey;
    if (kind === "oauth") return copy.authOAuth;
    return copy.authNone;
  }

  function providerStatus(provider: SparkModelCatalogProvider) {
    if (provider.auth.kind === "none") return copy.noLoginNeeded;
    return provider.auth.configured ? copy.connected : copy.notConnected;
  }

  function flowStatusLabel(status: string) {
    if (status === "waiting_for_user") return copy.flowWaiting;
    if (status === "succeeded") return copy.flowSucceeded;
    if (status === "failed") return copy.flowFailed;
    if (status === "cancelled") return copy.flowCancelled;
    return copy.flowPending;
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

  {#if form?.message}<p class:success={form.success} class="form-message" role="status">{form.message}</p>{/if}

  {#if flow || data.flowError}
    <section class="flow-card" aria-live="polite">
      <div class="card-heading">
        <div><p class="eyebrow">{copy.providersTitle}</p><h2>{copy.flowTitle}</h2></div>
        {#if flow}<span class="status {flow.status}">{flowStatusLabel(flow.status)}</span>{/if}
      </div>
      {#if data.flowError}<p class="error-text">{data.flowError}</p>{/if}
      {#if flow}
        <p class="flow-provider">{flow.providerLabel ?? flow.providerName}</p>
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
    <div class="card-heading">
      <div><h2>{copy.defaultTitle}</h2><p>{copy.defaultBody}</p></div>
    </div>
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
    <div class="section-heading"><h2>{copy.providersTitle}</h2><p>{copy.providersBody}</p></div>
    <div class="provider-grid">
      {#each snapshot.providers as provider}
        <article class="provider-card">
          <div class="provider-heading">
            <div>
              <h3>{provider.label}</h3>
              <p>{provider.auth.kind === "none" || provider.auth.configured ? copy.readyHint : copy.connectHint}</p>
            </div>
            <span
              class:configured={provider.auth.configured}
              class:neutral={provider.auth.kind === "none"}
              class="status"
            >{providerStatus(provider)}</span>
          </div>
          {#if provider.auth.kind === "api_key"}
            <div class="provider-actions">
              <details class="credential-editor" open={!provider.auth.configured}>
                <summary>{provider.auth.configured ? copy.updateKey : copy.addKey}</summary>
                <form method="POST" action="?/saveApiKey" class="credential-form" use:enhance>
                  <input type="hidden" name="providerName" value={provider.providerName} />
                  <label
                    ><span>{copy.apiKey}</span><input
                      name="apiKey"
                      type="password"
                      autocomplete="new-password"
                      placeholder={copy.apiKeyPlaceholder}
                      required
                    /></label
                  >
                  <button type="submit">{copy.saveKey}</button>
                </form>
              </details>
              {#if provider.auth.source === "stored"}
                <form method="POST" action="?/logout" use:enhance>
                  <input type="hidden" name="providerName" value={provider.providerName} />
                  <button class="link-action" type="submit">{copy.logout}</button>
                </form>
              {:else if provider.auth.configured}<p class="muted ambient-note">{copy.ambient}</p>{/if}
            </div>
          {:else if provider.auth.kind === "oauth"}
            <div class="provider-actions">
              {#if provider.auth.configured}
                <form method="POST" action="?/logout" use:enhance>
                  <input type="hidden" name="providerName" value={provider.providerName} />
                  <button class="link-action" type="submit">{copy.logout}</button>
                </form>
              {:else}
                <form method="POST" action="?/startOAuth">
                  <input type="hidden" name="providerName" value={provider.providerName} />
                  <button type="submit">{copy.login}</button>
                </form>
              {/if}
            </div>
          {/if}
        </article>
      {/each}
    </div>
  </section>

  <details class="technical-details">
    <summary><strong>{copy.technicalDetails}</strong><span>{copy.technicalDetailsBody}</span></summary>
    <div class="technical-body">
      <div class="technical-provider-grid">
        {#each snapshot.providers as provider}
          <section class="technical-provider">
            <h3>{provider.label}</h3>
            <dl>
              <div><dt>{copy.providerId}</dt><dd><code>{provider.providerName}</code></dd></div>
              <div><dt>{copy.authMethod}</dt><dd>{authLabel(provider.auth.kind)}</dd></div>
              <div><dt>{copy.authSource}</dt><dd>{sourceLabel(provider.auth.source)}</dd></div>
              {#if provider.auth.reference}
                <div><dt>{copy.authReference}</dt><dd><code>{provider.auth.reference}</code></dd></div>
              {/if}
              <div>
                <dt>{copy.modelCount}</dt>
                <dd>{provider.models.length} · {provider.models.filter((entry) => entry.available).length} {copy.availableCount}</dd>
              </div>
            </dl>
          </section>
        {/each}
      </div>
      <section class="diagnostics">
        <h3>{copy.diagnostics}</h3>
        {#if snapshot.diagnostics.length > 0}
          <ul>{#each snapshot.diagnostics as diagnostic}<li>{diagnostic}</li>{/each}</ul>
        {:else}<p class="muted">{copy.noDiagnostics}</p>{/if}
      </section>
    </div>
  </details>
</section>

<style>
  .models-settings {
    display: grid;
    gap: 24px;
    max-width: 1040px;
    min-width: 0;
    width: 100%;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  .page-heading {
    display: grid;
    gap: 7px;
    max-width: 720px;
  }

  .page-heading h1 {
    font-size: 25px;
    letter-spacing: -0.02em;
  }

  .page-heading > p:last-child,
  .card-heading p,
  .provider-heading p,
  .section-heading p,
  .muted {
    color: var(--color-ink-subtle);
    line-height: 1.5;
  }

  .eyebrow {
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  .settings-card,
  .flow-card,
  .provider-card,
  .technical-details {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 14px;
  }

  .settings-card,
  .flow-card,
  .provider-card {
    display: grid;
    gap: 16px;
    padding: 20px;
  }

  .card-heading,
  .inline-form,
  .provider-heading {
    align-items: center;
    display: flex;
    gap: 14px;
    justify-content: space-between;
  }

  .inline-form select {
    flex: 1 1 auto;
    min-width: 0;
  }

  .providers-section,
  .section-heading {
    display: grid;
    gap: 6px;
  }

  .provider-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    margin-top: 8px;
  }

  .provider-heading > div {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .status {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 750;
    padding: 5px 9px;
  }

  .status.configured,
  .status.succeeded {
    background: var(--color-success-weak);
    border-color: var(--color-success-soft);
    color: var(--color-success-strong);
  }

  .status.neutral {
    color: var(--color-ink-muted);
  }

  .status.failed {
    background: var(--color-danger-weak);
    border-color: var(--color-danger-soft);
    color: var(--color-danger);
  }

  .status.pending,
  .status.waiting_for_user {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .flow-provider {
    font-weight: 700;
  }

  .provider-actions {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .provider-actions > form {
    display: flex;
  }

  .credential-editor {
    flex: 1 1 240px;
    min-width: 0;
  }

  .credential-editor > summary {
    align-items: center;
    color: var(--color-primary);
    cursor: pointer;
    display: flex;
    font-size: 13px;
    font-weight: 700;
    min-height: 38px;
    width: fit-content;
  }

  .credential-editor[open] > summary {
    margin-bottom: 10px;
  }

  form {
    margin: 0;
  }

  .credential-form,
  .prompt-form {
    display: grid;
    gap: 10px;
  }

  label {
    display: grid;
    gap: 5px;
  }

  label span {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 650;
  }

  input,
  select {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-ink);
    font: inherit;
    min-height: 40px;
    padding: 7px 10px;
  }

  button,
  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: 8px;
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    gap: 6px;
    justify-content: center;
    min-height: 40px;
    padding: 0 13px;
    text-decoration: none;
    width: fit-content;
  }

  button,
  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: var(--color-on-primary);
  }

  .secondary-action {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  .link-action {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-danger);
  }

  .ambient-note {
    flex-basis: 100%;
    font-size: 12px;
  }

  .notice,
  .form-message {
    border-radius: 10px;
    padding: 12px;
  }

  .notice {
    align-items: center;
    background: var(--color-danger-weak);
    border: 1px solid var(--color-danger-soft);
    color: var(--color-danger);
    display: flex;
    gap: 8px;
  }

  .form-message {
    background: var(--color-danger-weak);
    border: 1px solid var(--color-danger-soft);
    color: var(--color-danger);
  }

  .form-message.success {
    background: var(--color-success-weak);
    border-color: var(--color-success-soft);
    color: var(--color-success-strong);
  }

  .device-code {
    background: var(--color-canvas);
    border-radius: 10px;
    display: grid;
    gap: 5px;
    padding: 12px;
  }

  .device-code strong {
    font-family: ui-monospace, monospace;
    font-size: 22px;
    letter-spacing: 0.12em;
  }

  .device-code a {
    overflow-wrap: anywhere;
  }

  .error-text {
    color: var(--color-danger);
  }

  .technical-details {
    overflow: hidden;
  }

  .technical-details > summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    min-height: 48px;
    padding: 0 18px;
  }

  .technical-details > summary span {
    color: var(--color-ink-subtle);
    font-size: 12px;
  }

  .technical-body {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: 20px;
    padding: 18px;
  }

  .technical-provider-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  }

  .technical-provider {
    background: var(--color-surface-soft);
    border-radius: 10px;
    display: grid;
    gap: 10px;
    padding: 14px;
  }

  dl {
    display: grid;
    gap: 8px;
    margin: 0;
  }

  dl > div {
    display: grid;
    gap: 2px;
  }

  dt {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 700;
  }

  dd {
    font-size: 12px;
    margin: 0;
    overflow-wrap: anywhere;
  }

  code {
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }

  .diagnostics {
    display: grid;
    gap: 8px;
  }

  .diagnostics ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding-left: 20px;
  }

  .diagnostics li {
    color: var(--color-ink-muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  @media (max-width: 640px) {
    .models-settings {
      gap: 20px;
    }

    .settings-card,
    .flow-card,
    .provider-card {
      padding: 16px;
    }

    .provider-grid,
    .technical-provider-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .card-heading,
    .inline-form,
    .provider-heading {
      align-items: stretch;
      flex-direction: column;
    }

    .provider-heading .status {
      align-self: flex-start;
    }

    .inline-form select,
    .inline-form button,
    .provider-actions,
    .provider-actions > form,
    .provider-actions button,
    .credential-editor,
    .credential-form button,
    .primary-action,
    .secondary-action {
      width: 100%;
    }

    .technical-details > summary {
      align-items: flex-start;
      flex-direction: column;
      gap: 3px;
      justify-content: center;
      min-height: 64px;
      padding: 10px 16px;
    }

    .technical-body {
      padding: 16px;
    }
  }
</style>
