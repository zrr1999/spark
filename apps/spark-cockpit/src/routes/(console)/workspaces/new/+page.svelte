<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime } from "$lib/i18n";
  import { Button, Field, Input, PageHeader } from "$lib/ui";
  import { slugifyWorkspaceIdentifier } from "$lib/slugify";
  import { resolveWorkspaceCreationState } from "$lib/workspace-creation-state";
  import type { SubmitFunction } from "@sveltejs/kit";

  type ClipboardWriteResult =
    | { ok: true }
    | {
        ok: false;
        reason:
          | "api-unavailable"
          | "insecure-context"
          | "not-allowed"
          | "write-failed";
        detail?: string;
      };

  type RegistrationProfile = {
    profileSource: "git" | "builtin:fresh";
    profileUrl: string;
    name: string;
    slug: string;
    description: string | null;
    enrollmentTokenId?: string;
  };

  type RegistrationCommand = {
    registrationMode: "device" | "token";
    enrollCommand: string;
    enrollmentExpiresAt: string | null;
    profileSetup: RegistrationProfile;
  };

  let { data, form } = $props();

  const fallbackRegistrationProfile: RegistrationProfile = {
    profileSource: "git",
    profileUrl: "",
    name: "",
    slug: "",
    description: null,
  };

  let t = $derived(data.messages.home);
  let common = $derived(data.messages.common);
  let registrationCommand = $state<RegistrationCommand | null>(null);
  let actionRegistrationCommand = $derived.by(
    (): RegistrationCommand | null => {
      if (
        form?.intent !== "workspaceRegistration" ||
        form.registrationMode !== "token" ||
        !form.enrollCommand ||
        !form.profileSetup
      ) {
        return null;
      }

      return {
        registrationMode: "token",
        enrollCommand: form.enrollCommand,
        enrollmentExpiresAt: form.enrollmentExpiresAt ?? null,
        profileSetup: form.profileSetup,
      };
    },
  );
  let targetRunnerBinding = $derived(data.targetRunnerBinding);
  let pendingRuntimeConnection = $derived(data.pendingRuntimeConnection);
  let hasTargetWorkspaceBinding = $derived(Boolean(targetRunnerBinding));
  let workspaceCreationState = $derived(
    resolveWorkspaceCreationState<RegistrationCommand>({
      actionCommand: actionRegistrationCommand,
      retainedCommand: registrationCommand,
      hasPendingSetup: Boolean(data.pendingWorkspaceSetup),
      hasWorkspaceBinding: hasTargetWorkspaceBinding,
    }),
  );
  let visibleRegistrationCommand = $derived(
    workspaceCreationState.registrationCommand,
  );
  let registrationProfile = $derived(
    visibleRegistrationCommand?.profileSetup ??
      form?.profileSetup ??
      data.pendingWorkspaceSetup ??
      fallbackRegistrationProfile,
  );
  let selectedProfileSourceOverride = $state<
    "git" | "builtin:fresh" | null
  >(null);
  let selectedProfileSource = $derived(
    selectedProfileSourceOverride ??
      visibleRegistrationCommand?.profileSetup.profileSource ??
      form?.profileSetup?.profileSource ??
      data.pendingWorkspaceSetup?.profileSource ??
      "git",
  );
  let workspaceNameOverride = $state<string | null>(null);
  let workspaceSlugOverride = $state<string | null>(null);
  let workspaceSetupSeed = $state("");
  let currentWorkspaceName = $derived(
    workspaceNameOverride ?? registrationProfile.name,
  );
  let currentAutoWorkspaceSlug = $derived(
    slugifyWorkspaceIdentifier(currentWorkspaceName),
  );
  let currentWorkspaceSlug = $derived(
    workspaceSlugOverride ??
      (registrationProfile.slug || currentAutoWorkspaceSlug),
  );
  let lastAutoWorkspaceSlug = $state<string | null>(null);
  let workspaceSlugEdited = $state(false);
  let commandCopyStatus = $state<"idle" | "copied" | "failed">("idle");
  let commandCopyError = $state<string | null>(null);
  let shouldPollForWorkspaceBinding = $derived(
    workspaceCreationState.shouldPollForWorkspaceBinding,
  );
  let currentStepIndex = $derived(workspaceCreationState.currentStepIndex);
  let lastFocusedWorkspaceBindingId = $state<string | null>(null);

  const keepRegistrationCommandVisible: SubmitFunction = () => {
    return async ({ update }) => {
      await update({ reset: false, invalidateAll: false });
    };
  };

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function isStepCompleted(index: number) {
    return index < currentStepIndex;
  }

  function isStepActive(index: number) {
    return index === currentStepIndex;
  }

  function workspaceSetupKey(profile: typeof registrationProfile) {
    return JSON.stringify({
      profileSource: profile.profileSource,
      profileUrl: profile.profileUrl,
      name: profile.name,
      slug: profile.slug,
      description: profile.description,
    });
  }

  function handleWorkspaceNameInput(event: Event) {
    const nextName = readInputValue(event);
    const nextSlug = slugifyWorkspaceIdentifier(nextName);
    const previousAutoSlug = lastAutoWorkspaceSlug ?? currentAutoWorkspaceSlug;
    const previousSlug = currentWorkspaceSlug;
    workspaceNameOverride = nextName;

    if (!workspaceSlugEdited || previousSlug === previousAutoSlug) {
      workspaceSlugOverride = nextSlug;
      workspaceSlugEdited = false;
    }
    lastAutoWorkspaceSlug = nextSlug;
  }

  function handleWorkspaceSlugInput(event: Event) {
    const nextSlug = slugifyWorkspaceIdentifier(readInputValue(event));
    workspaceSlugOverride = nextSlug;
    workspaceSlugEdited = Boolean(
      nextSlug && nextSlug !== currentAutoWorkspaceSlug,
    );
  }

  function readInputValue(event: Event) {
    return event.currentTarget instanceof HTMLInputElement
      ? event.currentTarget.value
      : "";
  }

  $effect(() => {
    const nextSeed = workspaceSetupKey(registrationProfile);
    if (nextSeed === workspaceSetupSeed) {
      return;
    }

    const nextAutoSlug = slugifyWorkspaceIdentifier(registrationProfile.name);
    workspaceNameOverride = null;
    workspaceSlugOverride = null;
    lastAutoWorkspaceSlug = nextAutoSlug;
    workspaceSlugEdited = Boolean(
      registrationProfile.slug && registrationProfile.slug !== nextAutoSlug,
    );
    workspaceSetupSeed = nextSeed;
  });

  $effect(() => {
    if (actionRegistrationCommand) {
      registrationCommand = actionRegistrationCommand;
    }
  });

  $effect(() => {
    if (!shouldPollForWorkspaceBinding) {
      return;
    }

    const interval = window.setInterval(() => {
      void invalidateAll();
    }, 2_000);

    return () => {
      window.clearInterval(interval);
    };
  });

  $effect(() => {
    const bindingId = targetRunnerBinding?.id ?? null;
    if (!bindingId || bindingId === lastFocusedWorkspaceBindingId) {
      return;
    }

    lastFocusedWorkspaceBindingId = bindingId;
    window.requestAnimationFrame(() => {
      document
        .getElementById("workspace-setup-step-3")
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });

  async function copyCommand(command: string) {
    const result = await writeClipboardText(command);
    commandCopyStatus = result.ok ? "copied" : "failed";
    commandCopyError = result.ok ? null : clipboardFailureMessage(result);
    if (!result.ok) {
      console.warn("Spark Cockpit command copy failed", result);
    }
    window.setTimeout(
      () => {
        commandCopyStatus = "idle";
        commandCopyError = null;
      },
      result.ok ? 1600 : 6000,
    );
  }

  async function writeClipboardText(
    value: string,
  ): Promise<ClipboardWriteResult> {
    // Prefer the async Clipboard API, which is only exposed in secure contexts
    // (HTTPS or localhost). Cockpit is frequently reached over plain HTTP on an
    // internal host, where `navigator.clipboard` is undefined, so fall back to
    // the legacy `execCommand("copy")` selection path before giving up.
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return { ok: true };
      } catch (error) {
        const fallback = copyWithExecCommand(value);
        if (fallback.ok) return fallback;
        const detail = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : "";
        return {
          ok: false,
          reason:
            name === "NotAllowedError" || name === "SecurityError"
              ? "not-allowed"
              : "write-failed",
          detail,
        };
      }
    }

    return copyWithExecCommand(value);
  }

  function copyWithExecCommand(value: string): ClipboardWriteResult {
    if (typeof document === "undefined") {
      return { ok: false, reason: window.isSecureContext ? "api-unavailable" : "insecure-context" };
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    // Keep the node out of the layout/scroll flow and away from screen readers
    // while it is briefly selected for the copy command.
    textarea.setAttribute("readonly", "");
    textarea.setAttribute("aria-hidden", "true");
    textarea.tabIndex = -1;
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.padding = "0";
    textarea.style.opacity = "0";
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      const copied = document.execCommand("copy");
      if (copied) return { ok: true };
      return {
        ok: false,
        reason: window.isSecureContext ? "write-failed" : "insecure-context",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: window.isSecureContext ? "write-failed" : "insecure-context",
        detail,
      };
    } finally {
      textarea.remove();
      activeElement?.focus();
    }
  }

  function clipboardFailureMessage(
    result: Exclude<ClipboardWriteResult, { ok: true }>,
  ) {
    const message =
      result.reason === "api-unavailable"
        ? t.emptyWorkspace.stepActions.copyUnavailable
        : result.reason === "insecure-context"
          ? t.emptyWorkspace.stepActions.copyInsecureContext
          : result.reason === "not-allowed"
            ? t.emptyWorkspace.stepActions.copyNotAllowed
            : t.emptyWorkspace.stepActions.copyWriteFailed;
    return result.detail ? `${message} ${result.detail}` : message;
  }

  function copyButtonTitle() {
    if (commandCopyStatus === "failed" && commandCopyError) {
      return commandCopyError;
    }
    return t.emptyWorkspace.stepActions.copyCommand;
  }
</script>

<svelte:head>
  <title>{t.emptyHeadTitle}</title>
</svelte:head>

<div class="workspace-create-page">
<PageHeader title={t.noWorkspaceHero.title} lede={t.noWorkspaceHero.lede} />

<section
  class="setup-panel"
  id="workspace-title"
  aria-label={t.emptyWorkspace.stepsAria}
>
  <div class="steps" aria-label={t.emptyWorkspace.stepsAria}>
    {#each t.emptyWorkspace.steps as step, index}
      <article
        id={`workspace-setup-step-${index + 1}`}
        class:primary-step={index === 0 && !isStepCompleted(index)}
        class:compact-step={index > 0}
        class:completed-step={isStepCompleted(index)}
        class:active-step={isStepActive(index)}
        class:pending-step={index > currentStepIndex}
      >
        <header class="step-header">
          <span>
            {#if isStepCompleted(index)}
              <Icon name="check" size={15} stroke={2.4} />
            {:else}
              {index + 1}
            {/if}
          </span>
          <div>
            <h3>{step.title}</h3>
            <p>
              {step.description}
            </p>
          </div>
        </header>
        {#if !isStepCompleted(index)}
          <div class="step-body">
            {#if index === 0}
              <form
                class="profile-form"
                method="POST"
                action="?/prepareRegistration"
                use:enhance={keepRegistrationCommandVisible}
              >
                {#if form?.intent === "workspaceRegistration" && form?.message && !form?.enrollCommand}
                  <p class="form-message" role="alert">{form.message}</p>
                {/if}
                {#if data.pendingWorkspaceSetup?.enrollmentTokenId && !visibleRegistrationCommand}
                  <p class="form-message" role="status">
                    {t.emptyWorkspace.stepActions.commandUnavailable}
                  </p>
                {/if}

                <div class="profile-form-layout">
                  <fieldset class="profile-choice">
                    <legend>{t.emptyWorkspace.form.profileSource}</legend>
                    <div class="profile-choice-options">
                      <label class="profile-choice-option">
                        <input
                          type="radio"
                          name="profileSource"
                          value="git"
                          checked={selectedProfileSource === "git"}
                          onchange={() => (selectedProfileSourceOverride = "git")}
                        />
                        <span>
                          <strong>{t.emptyWorkspace.form.gitProfile}</strong>
                          <small
                            >{t.emptyWorkspace.form
                              .gitProfileDescription}</small
                          >
                        </span>
                      </label>
                      <label class="profile-choice-option">
                        <input
                          type="radio"
                          name="profileSource"
                          value="builtin:fresh"
                          checked={selectedProfileSource === "builtin:fresh"}
                          onchange={() =>
                            (selectedProfileSourceOverride = "builtin:fresh")}
                        />
                        <span>
                          <strong>{t.emptyWorkspace.form.freshProfile}</strong>
                          <small
                            >{t.emptyWorkspace.form
                              .freshProfileDescription}</small
                          >
                        </span>
                      </label>
                    </div>
                  </fieldset>

                  <div class="profile-fields">
                    {#if selectedProfileSource === "git"}
                      <Field id="workspace-profile-url" label={t.emptyWorkspace.form.profileUrl} required>
                        <Input
                          id="workspace-profile-url"
                          name="profileUrl"
                          placeholder={t.emptyWorkspace.form
                            .profileUrlPlaceholder}
                          type="url"
                          value={registrationProfile.profileUrl}
                          required
                        />
                      </Field>
                    {:else}
                      <input type="hidden" name="profileUrl" value="" />
                    {/if}

                    <div class="field-pair">
                      <Field id="workspace-name" label={t.emptyWorkspace.form.name} required>
                        <Input
                          id="workspace-name"
                          name="name"
                          placeholder={t.emptyWorkspace.form.namePlaceholder}
                          value={currentWorkspaceName}
                          oninput={handleWorkspaceNameInput}
                          required
                        />
                      </Field>

                      <Field id="workspace-slug" label={t.emptyWorkspace.form.slug} hint={t.emptyWorkspace.form.slugHint}>
                        <Input
                          id="workspace-slug"
                          name="slug"
                          placeholder={t.emptyWorkspace.form.slugPlaceholder}
                          value={currentWorkspaceSlug}
                          oninput={handleWorkspaceSlugInput}
                        />
                      </Field>
                    </div>

                    <div class="profile-submit-row">
                      <Field id="workspace-description" label={t.emptyWorkspace.form.description}>
                        <Input
                          id="workspace-description"
                          name="description"
                          placeholder={t.emptyWorkspace.form
                            .descriptionPlaceholder}
                          value={registrationProfile.description ?? ""}
                        />
                      </Field>
                      <input type="hidden" name="registrationMethod" value="token" />
                      <div class="registration-actions">
                        <Button type="submit">
                          <Icon name="spark" size={16} stroke={2.4} />
                          <span>{t.emptyWorkspace.stepActions.createToken}</span>
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </form>
            {:else if index === 1}
              {#if visibleRegistrationCommand}
                {@const currentCommand = visibleRegistrationCommand}
                <div
                  class="token-created workspace-command"
                  aria-label={t.emptyWorkspace.stepActions.commandCreatedAria}
                >
                  <div>
                    <strong
                      >{t.emptyWorkspace.stepActions
                        .commandCreatedTitle}</strong
                    >
                    <p>
                      {currentCommand.registrationMode === "token"
                        ? t.emptyWorkspace.stepActions.tokenCommandCreatedHint
                        : t.emptyWorkspace.stepActions.commandCreatedHint}
                    </p>
                  </div>
                  {#if data.loopbackServerOrigin}
                    <p class="loopback-warning" role="note">
                      {t.emptyWorkspace.stepActions.loopbackWarning}
                    </p>
                  {:else if data.insecureRemoteServerOrigin}
                    <p class="loopback-warning" role="note">
                      {t.emptyWorkspace.stepActions.insecureHttpWarning}
                    </p>
                  {/if}
                  <div class="command-row">
                    <pre>{currentCommand.enrollCommand}</pre>
                    <div class="command-action">
                      <Button
                        variant="secondary"
                        type="button"
                        title={copyButtonTitle()}
                        onclick={() => copyCommand(currentCommand.enrollCommand)}
                      >
                        <Icon
                          name={commandCopyStatus === "copied" ? "check" : "copy"}
                          size={15}
                          stroke={2.2}
                        />
                        <span aria-live="polite">
                          {commandCopyStatus === "copied"
                            ? t.emptyWorkspace.stepActions.copiedCommand
                            : commandCopyStatus === "failed"
                              ? t.emptyWorkspace.stepActions.copyFailed
                              : t.emptyWorkspace.stepActions.copyCommand}
                        </span>
                      </Button>
                    </div>
                  </div>
                  {#if commandCopyStatus === "failed" && commandCopyError}
                    <small class="copy-diagnostic" role="status"
                      >{commandCopyError}</small
                    >
                  {/if}
                  {#if currentCommand.enrollmentExpiresAt}
                    <small
                      >{t.emptyWorkspace.stepActions.expiresPrefix}
                      {formatRelative(currentCommand.enrollmentExpiresAt)}</small
                    >
                  {/if}
                </div>
              {:else}
                <p class="step-note">
                  {t.emptyWorkspace.stepActions.waitForCommand}
                </p>
              {/if}
            {:else if targetRunnerBinding}
              {@const targetBinding = targetRunnerBinding}
              <form
                class="workspace-create-form"
                method="POST"
                action="?/createWorkspace"
                use:enhance
              >
                {#if form?.intent === "workspace" && form?.message}
                  <p class="form-message" role="alert">{form.message}</p>
                {/if}

                <input
                  type="hidden"
                  name="profileSource"
                  value={registrationProfile.profileSource}
                />
                <input
                  type="hidden"
                  name="profileUrl"
                  value={registrationProfile.profileUrl}
                />
                <input
                  type="hidden"
                  name="name"
                  value={registrationProfile.name || targetBinding.displayName}
                />
                <input
                  type="hidden"
                  name="slug"
                  value={registrationProfile.slug ||
                    targetBinding.localWorkspaceKey}
                />
                <input
                  type="hidden"
                  name="description"
                  value={registrationProfile.description ?? ""}
                />
                <input
                  type="hidden"
                  name="runtimeWorkspaceBindingId"
                  value={targetBinding.id}
                />

                <div class="workspace-directory-summary">
                  <span>{t.emptyWorkspace.form.runnerBinding}</span>
                  <strong>{targetBinding.displayName}</strong>
                  <small
                    >{targetBinding.runtimeName} · {targetBinding.localWorkspaceKey}</small
                  >
                </div>
                <Button type="submit">
                  <Icon name="check" size={16} stroke={2.4} />
                  <span>{t.emptyWorkspace.form.submit}</span>
                </Button>
              </form>
            {:else if pendingRuntimeConnection}
              {@const pending = pendingRuntimeConnection}
              <div class="runtime-pending" role="status">
                <p class="runtime-pending-title">
                  {t.emptyWorkspace.stepActions.runtimeRegisteredOfflineTitle}
                </p>
                <p>{t.emptyWorkspace.stepActions.runtimeRegisteredOfflineBody}</p>
                <dl class="runtime-pending-detail">
                  <div>
                    <dt>{t.emptyWorkspace.stepActions.runtimeRegisteredOfflineRuntimeLabel}</dt>
                    <dd>{pending.runtimeName ?? pending.bindingDisplayName}</dd>
                  </div>
                  <div>
                    <dt>{t.emptyWorkspace.stepActions.runtimeRegisteredOfflineStatusLabel}</dt>
                    <dd><code>{pending.runtimeStatus}</code></dd>
                  </div>
                </dl>
              </div>
            {:else}
              <p class="step-note">
                {t.emptyWorkspace.stepActions.waitForWorkspace}
              </p>
            {/if}
          </div>
        {/if}
      </article>
    {/each}
  </div>
</section>
</div>

<style>
  .workspace-create-page {
    display: grid;
    gap: 28px;
    max-width: 1040px;
    min-width: 0;
    width: 100%;
  }

  h3,
  p {
    margin: 0;
  }

  h3 {
    color: var(--color-ink);
    font-size: 15px;
    line-height: 1.35;
  }

  .setup-panel {
    display: grid;
  }

  .steps p {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
  }

  .steps {
    display: grid;
    gap: 12px;
  }

  .steps article {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    display: grid;
    gap: 14px;
    padding: 16px;
  }

  .steps article.pending-step {
    background: var(--color-canvas);
    border-color: var(--color-border);
  }

  .steps article.active-step.compact-step {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
  }

  .steps article.completed-step {
    background: var(--color-canvas);
    border-color: var(--color-border);
    gap: 8px;
    padding: 12px 16px;
  }

  .steps article.primary-step {
    padding: 18px 18px 16px;
  }

  .step-header {
    align-items: start;
    display: grid;
    gap: 12px;
    grid-template-columns: 28px minmax(0, 1fr);
  }

  .primary-step .step-header {
    border-bottom: 1px solid var(--color-border-soft);
    padding-bottom: 14px;
  }

  .step-header > span {
    background: var(--color-primary);
    border-radius: var(--rounded-full);
    color: var(--color-surface);
    display: grid;
    font-size: 12px;
    font-weight: 850;
    height: 28px;
    place-items: center;
    width: 28px;
  }

  .pending-step .step-header > span {
    background: var(--color-border);
    color: var(--color-ink-subtle);
  }

  .completed-step .step-header > span {
    background: var(--color-border);
    color: var(--color-ink-subtle);
    height: 24px;
    width: 24px;
  }

  .completed-step .step-header {
    align-items: center;
    grid-template-columns: 24px minmax(0, 1fr);
  }

  .completed-step .step-header p {
    display: none;
  }

  .completed-step h3 {
    color: var(--color-ink-muted);
  }

  .pending-step h3 {
    color: var(--color-ink-muted);
  }

  .pending-step .step-body,
  .pending-step .step-header p {
    color: var(--color-ink-subtle);
  }

  .step-body {
    display: grid;
    gap: 12px;
    min-width: 0;
  }

  .compact-step .step-body {
    padding-left: 40px;
  }

  .completed-step .step-body {
    padding-left: 36px;
  }

  .step-note {
    margin-top: 2px;
  }

  .runtime-pending {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: var(--rounded-md);
    display: grid;
    gap: 8px;
    padding: 12px 14px;
  }

  .runtime-pending p {
    color: var(--color-warning-strong);
    font-size: 12px;
    line-height: 1.5;
  }

  .runtime-pending-title {
    font-weight: 750;
  }

  .runtime-pending-detail {
    display: grid;
    gap: 6px;
    margin: 0;
  }

  .runtime-pending-detail > div {
    align-items: baseline;
    display: grid;
    gap: 8px;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .runtime-pending-detail dt {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 750;
    margin: 0;
  }

  .runtime-pending-detail dd {
    color: var(--color-ink);
    font-size: 12px;
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .runtime-pending-detail code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }

  .token-created {
    display: grid;
    gap: 10px;
  }

  .workspace-command {
    margin-top: 0;
  }

  .loopback-warning {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: var(--rounded-md);
    color: var(--color-warning-strong);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
    padding: 10px 12px;
  }

  .command-row {
    align-items: stretch;
    background: var(--color-ink);
    border: 1px solid var(--color-code-surface-soft);
    border-radius: var(--rounded-md);
    display: grid;
    gap: 0;
    grid-template-columns: minmax(0, 1fr) 84px;
    overflow: hidden;
  }

  .command-action {
    align-self: stretch;
    border-left: 1px solid var(--color-ink-muted);
    display: grid;
  }

  .token-created p,
  .token-created small {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.45;
  }

  .token-created .copy-diagnostic {
    color: var(--color-danger-strong);
  }

  .token-created pre {
    background: transparent;
    border-radius: 0;
    color: var(--color-border);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.55;
    margin: 0;
    overflow-x: auto;
    padding: 12px;
    white-space: pre-wrap;
  }

  .workspace-create-form {
    align-items: end;
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) auto;
    margin-top: 4px;
  }

  .workspace-directory-summary {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    display: grid;
    gap: 3px;
    min-width: 0;
    padding: 10px 12px;
  }

  .profile-form {
    display: grid;
    gap: 16px;
  }

  .profile-choice {
    border: 0;
    margin: 0;
    min-inline-size: 0;
    padding: 0;
  }

  .profile-form-layout {
    display: grid;
    gap: 16px;
    grid-template-columns: 1fr;
  }

  .profile-choice legend {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 12px;
    font-weight: 750;
    line-height: 1.45;
    margin: 0 0 8px;
    padding: 0;
  }

  .profile-choice-options {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .profile-choice-option {
    align-items: start;
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    cursor: pointer;
    display: grid;
    min-height: 68px;
    padding: 12px 14px;
    position: relative;
  }

  .profile-choice-option:has(input:checked) {
    background: var(--color-primary-weak);
    border-color: var(--color-primary);
  }

  .profile-choice-option:has(input:focus-visible) {
    box-shadow: var(--shadow-focus);
  }

  .profile-choice-option input {
    height: 1px;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    width: 1px;
  }

  .profile-choice-option span {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .profile-choice-option strong {
    color: var(--color-ink);
    font-size: 13px;
    line-height: 1.35;
  }

  .profile-choice-option small {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.4;
  }

  .profile-submit-row {
    align-items: end;
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .registration-actions {
    align-items: stretch;
    display: flex;
    gap: 8px;
  }

  .profile-fields {
    display: grid;
    gap: 12px;
    min-width: 0;
  }

  .field-pair {
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) minmax(180px, 0.72fr);
  }

  .workspace-directory-summary span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 750;
  }

  .workspace-directory-summary strong {
    color: var(--color-ink);
    font-size: 14px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-directory-summary small {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .form-message {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: var(--rounded-md);
    color: var(--color-warning-strong);
    font-size: 13px;
    grid-column: 1 / -1;
    padding: 10px 12px;
  }

  @media (max-width: 900px) {
    .command-row,
    .field-pair,
    .profile-choice-options,
    .profile-submit-row,
    .workspace-create-form {
      grid-template-columns: 1fr;
    }

    .registration-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .registration-actions :global(.ui-button) {
      width: 100%;
    }

    .command-action {
      justify-self: stretch;
      width: 100%;
    }

    .command-action {
      border-left: 0;
      border-top: 1px solid var(--color-ink-muted);
      min-height: 40px;
    }

    .compact-step .step-body {
      padding-left: 0;
    }

    .completed-step .step-body {
      padding-left: 0;
    }
  }
</style>
