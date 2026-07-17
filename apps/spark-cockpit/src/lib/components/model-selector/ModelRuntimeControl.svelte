<script lang="ts">
  import {
    sparkThinkingLevelOptions,
    type SparkThinkingLevel,
  } from "@zendev-lab/spark-protocol";
  import { Select } from "$lib/ui";
  import ModelPicker from "./ModelPicker.svelte";
  import type { ModelPickerGroup, ModelRuntimeControlLabels } from "./types";

  type Props = {
    id: string;
    open?: boolean;
    modelValue?: string;
    thinkingValue?: string;
    groups: ModelPickerGroup[];
    labels: ModelRuntimeControlLabels;
    modelName?: string;
    modelForm?: string;
    thinkingName?: string;
    thinkingForm?: string;
    required?: boolean;
    disabled?: boolean;
    modelDisabled?: boolean;
    thinkingDisabled?: boolean;
    selectedLabel?: string;
    settingsHref?: string;
    onModelChange?: (value: string) => void;
    onThinkingCommit?: (value: SparkThinkingLevel) => void;
  };

  let {
    id,
    open = $bindable(false),
    modelValue = $bindable(""),
    thinkingValue = $bindable("medium"),
    groups,
    labels,
    modelName = "model",
    modelForm,
    thinkingName = "thinkingLevel",
    thinkingForm,
    required = false,
    disabled = false,
    modelDisabled = false,
    thinkingDisabled = false,
    selectedLabel,
    settingsHref,
    onModelChange,
    onThinkingCommit,
  }: Props = $props();

  let selectedOption = $derived(
    groups.flatMap((group) => group.options).find((option) => option.value === modelValue),
  );
  let reasoningSupported = $derived(selectedOption?.reasoning !== false);
  let thinkingGroups = $derived([
    {
      id: "thinking",
      label: labels.thinking,
      options: sparkThinkingLevelOptions.map((level) => ({
        value: level,
        label: labels.thinkingLevels?.[level] ?? level,
      })),
    },
  ]);

  function commitThinking(next: string) {
    const level = (sparkThinkingLevelOptions as readonly string[]).includes(next)
      ? (next as SparkThinkingLevel)
      : "medium";
    thinkingValue = level;
    onThinkingCommit?.(level);
  }
</script>

<div class="model-runtime-control" role="group" aria-label={labels.aria}>
  <ModelPicker
    id={`${id}-model`}
    bind:open
    name={modelName}
    form={modelForm}
    bind:value={modelValue}
    {groups}
    {required}
    disabled={disabled || modelDisabled}
    label={labels.model}
    title={labels.chooseModel}
    description={labels.chooseModelHint}
    placeholder={labels.modelUnavailable}
    {selectedLabel}
    searchPlaceholder={labels.searchModels}
    emptyLabel={labels.noModelsFound}
    closeLabel={labels.closeModelPicker}
    clearSearchLabel={labels.clearModelSearch}
    compact
    {settingsHref}
    settingsLabel={labels.configureModels}
    onCommit={(nextModel) => onModelChange?.(nextModel)}
  />

  {#if reasoningSupported}
    <div class="thinking-control">
      <input
        type="hidden"
        name={thinkingName}
        form={thinkingForm}
        disabled={disabled || thinkingDisabled}
        value={thinkingValue}
      />
      <Select
        id={`${id}-thinking`}
        bind:value={thinkingValue}
        groups={thinkingGroups}
        label={labels.thinking}
        disabled={disabled || thinkingDisabled}
        compact
        onValueChange={commitThinking}
      />
    </div>
  {:else}
    <input
      type="hidden"
      name={thinkingName}
      form={thinkingForm}
      disabled={disabled || thinkingDisabled}
      value={thinkingValue}
    />
  {/if}
</div>

<style>
  .model-runtime-control {
    align-items: stretch;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    display: flex;
    flex: 0 1 24rem;
    max-width: min(24rem, 100%);
    min-width: 0;
    overflow: hidden;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .model-runtime-control:focus-within {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
  }

  .model-runtime-control :global([data-model-picker-trigger]) {
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    flex: 1 1 auto;
    max-width: none;
    min-height: 38px;
    min-width: 0;
    width: auto;
  }

  .model-runtime-control :global([data-model-picker-trigger]:hover:not(:disabled)) {
    background: var(--color-surface-soft);
    border-color: transparent;
  }

  .model-runtime-control :global([data-model-picker-trigger]:focus-visible) {
    box-shadow: none;
  }

  .thinking-control {
    border-left: 1px solid var(--color-border);
    display: flex;
    flex: 0 0 auto;
    max-width: 7.5rem;
    min-width: 5.5rem;
  }

  .thinking-control :global(.ui-select-trigger) {
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    height: 100%;
    min-height: 38px;
    min-width: 0;
    padding-inline: 10px;
    width: 100%;
  }

  .thinking-control :global(.ui-select-trigger:hover:not(:disabled)) {
    background: var(--color-surface-soft);
  }

  .thinking-control :global(.ui-select-trigger:focus-visible) {
    box-shadow: none;
  }
</style>
