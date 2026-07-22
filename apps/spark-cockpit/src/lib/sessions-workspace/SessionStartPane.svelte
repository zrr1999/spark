<script lang="ts">
  import { enhance } from "$app/forms";
  import {
    Composer,
    SlashActionBar,
    SlashCommandMenu,
  } from "$lib/components/conversation";
  import type { SlashActionAvailability } from "$lib/components/conversation";
  import {
    ModelRuntimeControl,
    type ModelPickerGroup,
    type ModelRuntimeControlLabels,
  } from "$lib/components/model-selector";
  import Icon from "$lib/Icon.svelte";
  import type { SparkActionBarView, SparkActionView } from "@zendev-lab/spark-protocol";
  import type { SubmitFunction } from "@sveltejs/kit";
  import type { CockpitSlashCommandSuggestion } from "$lib/slash-actions";
  import type {
    ModelControlState,
    SessionsMessages,
    SessionsWorkbenchCopy,
    SubmissionState,
    WorkspaceOption,
  } from "./types";

  type Props = {
    messages: SessionsMessages;
    copy: SessionsWorkbenchCopy;
    activeWorkspace: WorkspaceOption | null;
    canAssign: boolean;
    startState: SubmissionState;
    startFeedback: string | null;
    startMessage: string;
    startSubmissionId: string;
    startModel: string;
    startThinkingLevel: string;
    startModelReady: boolean;
    startModelPickerOpen: boolean;
    startSlashSuggestions: readonly CockpitSlashCommandSuggestion[];
    startSlashActionBar: SparkActionBarView | undefined;
    startSlashActiveIndex: number;
    startSlashListboxId: string;
    startSlashActiveOptionId: string | undefined;
    modelProvidersLength: number;
    modelGroups: ModelPickerGroup[];
    modelRuntimeLabels: ModelRuntimeControlLabels;
    availableModelsLength: number;
    modelControl: ModelControlState;
    enhanceStartConversation: SubmitFunction;
    slashActionAvailability: (action: SparkActionView, surface: "start") => SlashActionAvailability;
    onStartMessageChange: (value: string) => void;
    onSlashKeydown: (event: KeyboardEvent) => void;
    onSlashActiveIndexChange: (index: number) => void;
    onSlashSelect: (suggestion: Readonly<{ id: string; command: string; title: string; description?: string }>) => void;
    onSlashAction: (action: SparkActionView) => void;
  };

  let {
    messages,
    copy,
    activeWorkspace,
    canAssign,
    startState,
    startFeedback,
    startMessage = $bindable(),
    startSubmissionId,
    startModel = $bindable(),
    startThinkingLevel = $bindable(),
    startModelReady,
    startModelPickerOpen = $bindable(),
    startSlashSuggestions,
    startSlashActionBar,
    startSlashActiveIndex,
    startSlashListboxId,
    startSlashActiveOptionId,
    modelProvidersLength,
    modelGroups,
    modelRuntimeLabels,
    availableModelsLength,
    modelControl,
    enhanceStartConversation,
    slashActionAvailability,
    onStartMessageChange,
    onSlashKeydown,
    onSlashActiveIndexChange,
    onSlashSelect,
    onSlashAction,
  }: Props = $props();
</script>

<div class="conversation-start">
  {#if !activeWorkspace}
    <div class="stage-empty">
      <Icon name="agents" size={28} />
      <div>
        <h1>{messages.createNoWorkspaceTitle}</h1>
        <p>{messages.createNoWorkspaceBody}</p>
        <a class="primary-action" href="/workspaces/new">{messages.createWorkspaceAction}</a>
      </div>
    </div>
  {:else}
    <div class="start-heading">
      <span class="spark-mark"><Icon name="spark" size={22} /></span>
      <div>
        <p class="kicker">Spark</p>
        <h1>{copy.newConversation}</h1>
        <p>{copy.workspaceStartHint}</p>
      </div>
    </div>

    <form
      method="POST"
      action="?/startConversation"
      class="start-composer"
      aria-busy={startState === "submitting"}
      use:enhance={enhanceStartConversation}
    >
      {#if activeWorkspace}
        <input type="hidden" name="workspaceId" value={activeWorkspace.id} />
      {/if}
      <input type="hidden" name="submissionId" value={startSubmissionId} />
      <Composer
        id="start-conversation-message"
        rows={2}
        placeholder={copy.startPlaceholder}
        bind:value={startMessage}
        disabled={!canAssign || startState === "submitting"}
        submitDisabled={!canAssign ||
          startState === "submitting" ||
          !startModelReady ||
          !startMessage.trim() ||
          Boolean(startSlashActionBar) ||
          startSlashSuggestions.length > 0}
        submitting={startState === "submitting"}
        submitLabel={copy.startSubmit}
        submittingLabel={copy.sending}
        ariaLabel={copy.messageLabel}
        multilineHint={copy.multilineHint}
        onValueChange={onStartMessageChange}
        onKeydown={onSlashKeydown}
        completion={{
          expanded: startSlashSuggestions.length > 0,
          listboxId: startSlashListboxId,
          activeOptionId: startSlashActiveOptionId,
        }}
      >
        {#snippet actions()}
          {#if startSlashSuggestions.length > 0}
            <SlashCommandMenu
              id={startSlashListboxId}
              suggestions={startSlashSuggestions}
              activeIndex={startSlashActiveIndex}
              ariaLabel={copy.slashActions.completionLabel}
              hint={copy.slashActions.completionHint}
              onActiveIndexChange={onSlashActiveIndexChange}
              onSelect={onSlashSelect}
            />
          {/if}
          {#if startSlashActionBar}
            <SlashActionBar
              view={startSlashActionBar}
              resolveAction={(action) => slashActionAvailability(action, "start")}
              onAction={onSlashAction}
            />
          {/if}
        {/snippet}
        {#snippet context()}
          {#if modelProvidersLength > 0}
            <ModelRuntimeControl
              id="start-conversation"
              required
              bind:open={startModelPickerOpen}
              bind:modelValue={startModel}
              bind:thinkingValue={startThinkingLevel}
              groups={modelGroups}
              labels={modelRuntimeLabels}
              modelDisabled={!canAssign || availableModelsLength === 0}
              thinkingDisabled={!canAssign}
              settingsHref="/settings/models"
            />
          {:else}
            <a class="model-settings-link" href="/settings/models">
              <Icon name={modelControl.available ? "settings" : "warning"} size={14} />
              {modelControl.available ? copy.configureModels : copy.modelControlUnavailable}
            </a>
          {/if}
        {/snippet}
        {#snippet feedback()}
          {#if startFeedback}
            <p
              class="form-feedback {startState}"
              role={startState === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {startFeedback}
            </p>
          {/if}
        {/snippet}
      </Composer>
    </form>
  {/if}
</div>

<style>
  .conversation-start {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 0;
  }

  .start-heading,
  .start-composer {
    max-width: 720px;
    width: 100%;
  }

  .start-heading {
    align-items: start;
    display: grid;
    gap: 14px;
    grid-template-columns: auto minmax(0, 1fr);
    margin-bottom: 14px;
  }

  .start-heading h1,
  .stage-empty h1 {
    color: var(--color-ink);
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.015em;
    line-height: 1.3;
    margin: 0;
  }

  .start-heading > div > p:last-child,
  .stage-empty p {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
    margin: 4px 0 0;
  }

  .kicker {
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    margin: 0 0 5px;
    text-transform: uppercase;
  }

  .spark-mark {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 10px;
    color: var(--color-primary);
    display: inline-flex;
    flex: 0 0 auto;
    height: 40px;
    justify-content: center;
    width: 40px;
  }

  .stage-empty {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    flex-direction: column;
    gap: 14px;
    justify-content: center;
    max-width: 460px;
    text-align: center;
  }

  .stage-empty > div {
    display: grid;
    gap: 12px;
    justify-items: center;
  }

  .model-settings-link {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
    min-height: 40px;
    padding: 0 10px;
    text-decoration: none;
  }

  .primary-action {
    align-items: center;
    background: var(--color-primary);
    border: 0;
    border-radius: var(--rounded-md);
    color: var(--color-on-primary, #fff);
    cursor: pointer;
    display: inline-flex;
    font-size: 13px;
    font-weight: 600;
    gap: 6px;
    justify-content: center;
    min-height: 40px;
    padding: 0 13px;
    text-decoration: none;
    width: fit-content;
  }

  .primary-action:hover {
    background: var(--color-primary-hover, #1d4ed8);
  }

  .form-feedback {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.4;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .form-feedback.success {
    color: var(--color-success-strong, var(--color-success));
  }

  .form-feedback.error {
    color: var(--color-danger-strong, var(--color-danger));
  }

  @media (max-width: 640px) {
    .conversation-start {
      align-items: stretch;
      justify-content: flex-start;
      padding: 10px 0;
    }

    .start-heading {
      margin-bottom: 14px;
    }
  }
</style>
