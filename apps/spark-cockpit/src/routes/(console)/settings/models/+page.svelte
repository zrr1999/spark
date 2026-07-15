<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  import { ModelPicker, type ModelPickerGroup } from "$lib/components/model-selector";
  import { Button, Field, Input, PageHeader, Select } from "$lib/ui";
  import type { SparkModelCatalogProvider } from "@zendev-lab/spark-protocol";

  let { data, form } = $props();
  let copy = $derived(data.messages.modelSettings);
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
  let selectedDefaultModel = $state("");
  let oauthPromptId = $state("");
  let oauthResponse = $state("");
  let defaultModelGroups = $derived(buildModelGroups(snapshot.providers));
  let selectedDefaultModelAvailable = $derived(
    availableModels.some((entry) => modelValue(entry.model) === selectedDefaultModel),
  );
  let oauthPromptOptions = $derived(
    flow?.prompt?.kind === "select"
      ? [
          {
            id: flow.prompt.id,
            options: flow.prompt.options.map((option) => ({ value: option.id, label: option.label })),
          },
        ]
      : [],
  );

  $effect(() => {
    const configured = snapshot.defaultModel ? modelValue(snapshot.defaultModel) : "";
    const selectable = availableModels.map((entry) => modelValue(entry.model));
    const known = defaultModelGroups.flatMap((group) => group.options).some((option) => option.value === selectedDefaultModel);
    if (!selectedDefaultModel || !known) {
      selectedDefaultModel = configured || selectable[0] || "";
    }
  });

  $effect(() => {
    const prompt = flow?.prompt;
    if (!prompt || prompt.kind !== "select" || prompt.id === oauthPromptId) return;
    oauthPromptId = prompt.id;
    oauthResponse = prompt.options[0]?.id ?? "";
  });

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

  function buildModelGroups(providers: SparkModelCatalogProvider[]): ModelPickerGroup[] {
    const groups: ModelPickerGroup[] = providers.map((provider) => ({
      id: provider.providerName,
      label: provider.label,
      options: provider.models
        .filter((entry) => entry.available)
        .map((entry) => ({
          value: modelValue(entry.model),
          label: entry.model.modelLabel ?? entry.model.modelId,
          description:
            entry.model.modelLabel && entry.model.modelLabel !== entry.model.modelId
              ? entry.model.modelId
              : undefined,
          keywords: [entry.model.modelId, provider.providerName],
        })),
    }));
    if (snapshot.defaultModel && !defaultModelAvailable) {
      groups.unshift({
        id: "unavailable-default",
        label: copy.currentModelUnavailable,
        options: [
          {
            value: modelValue(snapshot.defaultModel),
            label: snapshot.defaultModel.modelLabel ?? snapshot.defaultModel.modelId,
            description: snapshot.defaultModel.providerLabel ?? snapshot.defaultModel.providerName,
            disabled: true,
            keywords: [snapshot.defaultModel.modelId, snapshot.defaultModel.providerName],
          },
        ],
      });
    }
    return groups.filter((group) => group.options.length > 0);
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
  <PageHeader id="models-title" eyebrow={copy.eyebrow} title={copy.title} lede={copy.lede} />

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
          <Button href={flow.authorization.url} target="_blank" rel="noreferrer">
            <Icon name="play" size={15} />{copy.openAuthorization}
          </Button>
          {#if flow.authorization.instructions}<p class="muted">{flow.authorization.instructions}</p>{/if}
        {/if}
        {#if flow.deviceCode}
          <div class="device-code"><span>{copy.deviceCode}</span><strong>{flow.deviceCode.userCode}</strong><a href={flow.deviceCode.verificationUri} target="_blank" rel="noreferrer">{flow.deviceCode.verificationUri}</a></div>
        {/if}
        {#if flow.prompt}
          <form method="POST" action="?/respondOAuth" class="prompt-form">
            <input type="hidden" name="flowId" value={flow.id} />
            <input type="hidden" name="promptId" value={flow.prompt.id} />
            <Field
              id="oauth-response"
              label={flow.prompt.message}
              required={flow.prompt.kind === "select" || flow.prompt.allowEmpty !== true}
            >
              {#if flow.prompt.kind === "select"}
                <Select
                  id="oauth-response"
                  name="response"
                  label={flow.prompt.message}
                  groups={oauthPromptOptions}
                  bind:value={oauthResponse}
                  required
                />
              {:else}
                <Input
                  id="oauth-response"
                  name="response"
                  placeholder={flow.prompt.placeholder ?? ""}
                  required={flow.prompt.allowEmpty !== true}
                  autocomplete="off"
                />
              {/if}
            </Field>
            <Button type="submit">{copy.response}</Button>
          </form>
        {/if}
        {#if flow.progress.length > 0}<p class="muted">{flow.progress.at(-1)}</p>{/if}
        {#if flow.error}<p class="error-text">{flow.error}</p>{/if}
        {#if flow.status === "succeeded"}
          <Button variant="secondary" href="/settings/models">{copy.done} · {copy.close}</Button>
        {:else if !terminal(flow.status)}
          <form method="POST" action="?/cancelOAuth"><input type="hidden" name="flowId" value={flow.id} /><Button variant="secondary" type="submit">{copy.cancel}</Button></form>
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
        <div class="default-model-picker">
          <ModelPicker
          id="default-model"
          name="model"
          bind:value={selectedDefaultModel}
          groups={defaultModelGroups}
          label={copy.defaultTitle}
          title={copy.chooseModel}
          description={copy.chooseModelHint}
          placeholder={copy.currentModelUnavailable}
          searchPlaceholder={copy.searchModels}
          emptyLabel={copy.noModelsFound}
          closeLabel={copy.closeModelPicker}
          clearSearchLabel={copy.clearModelSearch}
          required
        />
        </div>
        <Button type="submit" disabled={!selectedDefaultModelAvailable}>{copy.saveDefault}</Button>
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
                  <Field id={`api-key-${provider.providerName}`} label={copy.apiKey} required>
                    <Input
                      id={`api-key-${provider.providerName}`}
                      name="apiKey"
                      type="password"
                      autocomplete="new-password"
                      placeholder={copy.apiKeyPlaceholder}
                      required
                    />
                  </Field>
                  <Button type="submit">{copy.saveKey}</Button>
                </form>
              </details>
              {#if provider.auth.source === "stored"}
                <form method="POST" action="?/logout" use:enhance>
                  <input type="hidden" name="providerName" value={provider.providerName} />
                  <Button variant="secondary" type="submit">{copy.logout}</Button>
                </form>
              {:else if provider.auth.configured}<p class="muted ambient-note">{copy.ambient}</p>{/if}
            </div>
          {:else if provider.auth.kind === "oauth"}
            <div class="provider-actions">
              {#if provider.auth.configured}
                <form method="POST" action="?/logout" use:enhance>
                  <input type="hidden" name="providerName" value={provider.providerName} />
                  <Button variant="secondary" type="submit">{copy.logout}</Button>
                </form>
              {:else}
                <form method="POST" action="?/startOAuth">
                  <input type="hidden" name="providerName" value={provider.providerName} />
                  <Button type="submit">{copy.login}</Button>
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
    gap: var(--spacing-xl);
    max-width: 1040px;
    min-width: 0;
    width: 100%;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  .card-heading p,
  .provider-heading p,
  .section-heading p,
  .muted {
    color: var(--color-ink-subtle);
    line-height: var(--leading-body);
  }

  .eyebrow {
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  .settings-card,
  .flow-card,
  .provider-card,
  .technical-details {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
  }

  .settings-card,
  .flow-card,
  .provider-card {
    display: grid;
    gap: var(--spacing-md);
    padding: var(--spacing-lg);
  }

  .card-heading,
  .inline-form,
  .provider-heading {
    align-items: center;
    display: flex;
    gap: var(--spacing-sm);
    justify-content: space-between;
  }

  .default-model-picker {
    display: grid;
    flex: 1 1 auto;
    min-width: 0;
  }

  .providers-section,
  .section-heading {
    display: grid;
    gap: var(--spacing-xs);
  }

  .provider-grid {
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    margin-top: var(--spacing-xs);
  }

  .provider-heading > div {
    display: grid;
    gap: var(--spacing-xxs);
    min-width: 0;
  }

  .status {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-full);
    color: var(--color-ink-subtle);
    flex: 0 0 auto;
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
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
    gap: var(--spacing-sm);
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
    font-size: var(--text-body);
    font-weight: 700;
    min-height: 40px;
    width: fit-content;
  }

  .credential-editor[open] > summary {
    margin-bottom: var(--spacing-sm);
  }

  form {
    margin: 0;
  }

  .credential-form,
  .prompt-form {
    display: grid;
    gap: var(--spacing-sm);
  }

  .ambient-note {
    flex-basis: 100%;
    font-size: var(--text-caption);
  }

  .notice,
  .form-message {
    border-radius: var(--rounded-md);
    padding: var(--spacing-sm);
  }

  .notice {
    align-items: center;
    background: var(--color-danger-weak);
    border: 1px solid var(--color-danger-soft);
    color: var(--color-danger);
    display: flex;
    gap: var(--spacing-xs);
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
    border-radius: var(--rounded-md);
    display: grid;
    gap: var(--spacing-xxs);
    padding: var(--spacing-sm);
  }

  .device-code strong {
    font-family: var(--font-mono);
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
    gap: var(--spacing-sm);
    justify-content: space-between;
    min-height: 48px;
    padding: 0 var(--spacing-lg);
  }

  .technical-details > summary span {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .technical-body {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: var(--spacing-lg);
    padding: var(--spacing-lg);
  }

  .technical-provider-grid {
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  }

  .technical-provider {
    background: var(--color-surface-soft);
    border-radius: var(--rounded-md);
    display: grid;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm);
  }

  dl {
    display: grid;
    gap: var(--spacing-xs);
    margin: 0;
  }

  dl > div {
    display: grid;
    gap: var(--spacing-xxs);
  }

  dt {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    font-weight: 700;
  }

  dd {
    font-size: var(--text-caption);
    margin: 0;
    overflow-wrap: anywhere;
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }

  .diagnostics {
    display: grid;
    gap: var(--spacing-xs);
  }

  .diagnostics ul {
    display: grid;
    gap: var(--spacing-xs);
    margin: 0;
    padding-left: var(--spacing-lg);
  }

  .diagnostics li {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    overflow-wrap: anywhere;
  }

  @media (max-width: 640px) {
    .models-settings {
      gap: var(--spacing-lg);
    }

    .settings-card,
    .flow-card,
    .provider-card {
      padding: var(--spacing-md);
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

    .default-model-picker,
    .provider-actions,
    .provider-actions > form,
    .credential-editor {
      width: 100%;
    }

    .provider-actions > form {
      display: grid;
    }

    .technical-details > summary {
      align-items: flex-start;
      flex-direction: column;
      gap: var(--spacing-xxs);
      justify-content: center;
      min-height: 64px;
      padding: var(--spacing-sm) var(--spacing-md);
    }

    .technical-body {
      padding: var(--spacing-md);
    }
  }
</style>
