<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime } from "$lib/i18n";
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
  let registrationProfile = $derived(
    registrationCommand?.profileSetup ??
      form?.profileSetup ??
      data.pendingWorkspaceSetup ??
      fallbackRegistrationProfile,
  );
  let selectedProfileSource = $state<"git" | "builtin:fresh">("git");
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
  let targetRunnerBinding = $derived(data.targetRunnerBinding);
  let hasRegistrationCommand = $derived(
    Boolean(registrationCommand?.enrollCommand),
  );
  let hasTargetWorkspaceBinding = $derived(Boolean(targetRunnerBinding));
  let hasConfirmedWorkspaceSetup = $derived(
    Boolean(
      registrationCommand?.profileSetup ||
      form?.profileSetup ||
      (hasTargetWorkspaceBinding && data.pendingWorkspaceSetup),
    ),
  );
  let currentStepIndex = $derived(
    !hasConfirmedWorkspaceSetup ? 0 : hasTargetWorkspaceBinding ? 2 : 1,
  );

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

  function slugifyWorkspaceIdentifier(value: string) {
    const result: string[] = [];
    let pendingDash = false;

    for (const char of value.trim().toLowerCase()) {
      const code = char.charCodeAt(0);
      const isSlugChar =
        (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
      if (isSlugChar) {
        if (pendingDash && result.length > 0 && result.length < 48) {
          result.push("-");
        }
        pendingDash = false;
        if (result.length < 48) {
          result.push(char);
        }
      } else {
        pendingDash = result.length > 0;
      }
    }

    return result.join("");
  }

  $effect(() => {
    const source =
      registrationCommand?.profileSetup.profileSource ??
      form?.profileSetup?.profileSource ??
      data.pendingWorkspaceSetup?.profileSource;
    if (source) {
      selectedProfileSource = source;
    }
  });

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
    if (
      form?.intent !== "workspaceRegistration" ||
      !form.enrollCommand ||
      !form.profileSetup
    ) {
      return;
    }

    registrationCommand = {
      enrollCommand: form.enrollCommand,
      enrollmentExpiresAt: form.enrollmentExpiresAt ?? null,
      profileSetup: form.profileSetup,
    };
  });

  $effect(() => {
    if (!hasRegistrationCommand || hasTargetWorkspaceBinding) {
      return;
    }

    const interval = window.setInterval(() => {
      void invalidateAll();
    }, 2_000);

    return () => {
      window.clearInterval(interval);
    };
  });

  async function copyCommand(command: string) {
    const result = await writeClipboardText(command);
    commandCopyStatus = result.ok ? "copied" : "failed";
    commandCopyError = result.ok ? null : clipboardFailureMessage(result);
    if (!result.ok) {
      console.warn("Navia command copy failed", result);
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
    if (!window.isSecureContext) {
      return { ok: false, reason: "insecure-context" };
    }

    if (!navigator.clipboard?.writeText) {
      return { ok: false, reason: "api-unavailable" };
    }

    try {
      await navigator.clipboard.writeText(value);
      return { ok: true };
    } catch (error) {
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

<section class="setup-hero" aria-labelledby="home-title">
  <div>
    <p class="eyebrow">{t.noWorkspaceHero.eyebrow}</p>
    <h1 id="home-title">{t.noWorkspaceHero.title}</h1>
    <p class="lede">{t.noWorkspaceHero.lede}</p>
  </div>
</section>

<section
  class="setup-panel"
  id="workspace-title"
  aria-label={t.emptyWorkspace.stepsAria}
>
  <div class="steps" aria-label={t.emptyWorkspace.stepsAria}>
    {#each t.emptyWorkspace.steps as step, index}
      <article
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
                action="?create=workspace&/createEnrollmentToken"
                use:enhance={keepRegistrationCommandVisible}
              >
                {#if form?.intent === "workspaceRegistration" && form?.message && !form?.enrollCommand}
                  <p class="form-message" role="alert">{form.message}</p>
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
                          bind:group={selectedProfileSource}
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
                          bind:group={selectedProfileSource}
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
                      <label>
                        <span>{t.emptyWorkspace.form.profileUrl}</span>
                        <input
                          name="profileUrl"
                          placeholder={t.emptyWorkspace.form
                            .profileUrlPlaceholder}
                          type="url"
                          value={registrationProfile.profileUrl}
                          required
                        />
                      </label>
                    {:else}
                      <input type="hidden" name="profileUrl" value="" />
                    {/if}

                    <div class="field-pair">
                      <label>
                        <span>{t.emptyWorkspace.form.name}</span>
                        <input
                          name="name"
                          placeholder={t.emptyWorkspace.form.namePlaceholder}
                          value={currentWorkspaceName}
                          oninput={handleWorkspaceNameInput}
                          required
                        />
                      </label>

                      <label>
                        <span>{t.emptyWorkspace.form.slug}</span>
                        <input
                          name="slug"
                          placeholder={t.emptyWorkspace.form.slugPlaceholder}
                          value={currentWorkspaceSlug}
                          oninput={handleWorkspaceSlugInput}
                        />
                      </label>
                    </div>

                    <div class="profile-submit-row">
                      <label>
                        <span>{t.emptyWorkspace.form.description}</span>
                        <input
                          name="description"
                          placeholder={t.emptyWorkspace.form
                            .descriptionPlaceholder}
                          value={registrationProfile.description ?? ""}
                        />
                      </label>
                      <button class="primary-action" type="submit">
                        <Icon name="check" size={16} stroke={2.4} />
                        <span>{t.emptyWorkspace.stepActions.createToken}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </form>
            {:else if index === 1}
              {#if registrationCommand}
                {@const currentCommand = registrationCommand}
                <div
                  class="token-created workspace-command"
                  aria-label={t.emptyWorkspace.stepActions.commandCreatedAria}
                >
                  <div>
                    <strong
                      >{t.emptyWorkspace.stepActions
                        .commandCreatedTitle}</strong
                    >
                    <p>{t.emptyWorkspace.stepActions.commandCreatedHint}</p>
                  </div>
                  <div class="command-row">
                    <pre>{currentCommand.enrollCommand}</pre>
                    <button
                      class="secondary-action copy-action"
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
                    </button>
                  </div>
                  {#if commandCopyStatus === "failed" && commandCopyError}
                    <small class="copy-diagnostic" role="status"
                      >{commandCopyError}</small
                    >
                  {/if}
                  <small
                    >{t.emptyWorkspace.stepActions.expiresPrefix}
                    {formatRelative(currentCommand.enrollmentExpiresAt)}</small
                  >
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
                action="?create=workspace&/createWorkspace"
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
                <button class="primary-action" type="submit">
                  <Icon name="check" size={16} stroke={2.4} />
                  <span>{t.emptyWorkspace.form.submit}</span>
                </button>
              </form>
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

<style>
  .setup-hero {
    align-items: center;
    display: flex;
    gap: 24px;
    justify-content: space-between;
  }

  .setup-hero > div {
    flex: 1 1 auto;
    min-width: 0;
  }

  .eyebrow {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0;
    margin: 0 0 8px;
  }

  h1,
  h3,
  p {
    margin: 0;
  }

  h1 {
    color: var(--color-ink);
    font-size: 34px;
    line-height: 1.08;
  }

  h3 {
    color: var(--color-ink);
    font-size: 15px;
    line-height: 1.35;
  }

  .lede {
    color: var(--color-ink-subtle);
    line-height: 1.55;
    margin-top: 10px;
    max-width: none;
    width: 100%;
  }

  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: 8px;
    display: inline-flex;
    font-weight: 750;
    gap: 6px;
    height: 40px;
    justify-content: center;
    padding: 0 14px;
    text-decoration: none;
    white-space: nowrap;
  }

  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: var(--color-surface);
  }

  .secondary-action {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    color: var(--color-ink-muted);
  }

  .setup-panel {
    display: grid;
    margin-top: 28px;
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
    border-radius: 8px;
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
    border-radius: 999px;
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

  .token-created {
    display: grid;
    gap: 10px;
  }

  .workspace-command {
    margin-top: 0;
  }

  .command-row {
    align-items: stretch;
    background: var(--color-ink);
    border: 1px solid var(--color-code-surface-soft);
    border-radius: 8px;
    display: grid;
    gap: 0;
    grid-template-columns: minmax(0, 1fr) 84px;
    overflow: hidden;
  }

  .copy-action {
    align-self: stretch;
    background: var(--color-code-surface-soft);
    border: 0;
    border-left: 1px solid var(--color-ink-muted);
    border-radius: 0;
    color: var(--color-border);
    height: auto;
    min-height: 100%;
    padding: 0 14px;
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
    border-radius: 8px;
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
    border-radius: 8px;
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

  .profile-submit-row .primary-action {
    min-width: 96px;
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

  .profile-form label {
    display: grid;
    gap: 6px;
  }

  .workspace-directory-summary span,
  .profile-form label span {
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

  .workspace-create-form input,
  .profile-form input:not([type="radio"]) {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    color: var(--color-ink);
    font: inherit;
    min-height: 40px;
    padding: 0 11px;
  }

  .workspace-create-form input:focus-visible,
  .profile-form input:not([type="radio"]):focus-visible {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .form-message {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: 8px;
    color: var(--color-warning-strong);
    font-size: 13px;
    grid-column: 1 / -1;
    padding: 10px 12px;
  }

  .workspace-create-form button {
    cursor: pointer;
  }

  @media (max-width: 900px) {
    .setup-hero {
      align-items: stretch;
      display: grid;
    }

    .command-row,
    .field-pair,
    .profile-choice-options,
    .profile-submit-row,
    .workspace-create-form {
      grid-template-columns: 1fr;
    }

    .copy-action,
    .profile-submit-row .primary-action {
      justify-self: stretch;
      width: 100%;
    }

    .copy-action {
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
