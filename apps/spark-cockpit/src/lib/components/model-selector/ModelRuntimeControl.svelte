<script lang="ts">
  import ThinkingLevelSlider, {
    type ThinkingLevel,
  } from "$lib/components/ThinkingLevelSlider.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import type { ModelPickerGroup, ModelRuntimeControlLabels } from "./types";

  type Props = {
    id: string;
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
    onThinkingCommit?: (value: ThinkingLevel) => void;
  };

  let {
    id,
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
</script>

<div class="model-runtime-control" role="group" aria-label={labels.aria}>
  <ModelPicker
    id={`${id}-model`}
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
    onValueChange={onModelChange}
  />
  <ThinkingLevelSlider
    bind:value={thinkingValue}
    name={thinkingName}
    form={thinkingForm}
    label={labels.thinking}
    valueLabels={labels.thinkingLevels}
    compact
    disabled={disabled || thinkingDisabled}
    onValueCommit={onThinkingCommit}
  />
</div>

<style>
  .model-runtime-control {
    align-items: stretch;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    display: flex;
    flex: 1 1 22rem;
    max-width: 100%;
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
    flex: 1 1 58%;
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

  .model-runtime-control :global(.thinking-slider) {
    border-left: 1px solid var(--color-border-soft);
    flex: 1 1 42%;
    min-width: 120px;
  }

  .model-runtime-control :global(.thinking-trigger) {
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    min-height: 38px;
    justify-content: center;
    width: 100%;
  }

  .model-runtime-control :global(.thinking-trigger:focus-visible) {
    box-shadow: none;
  }

  @media (max-width: 520px) {
    .model-runtime-control {
      flex-basis: 100%;
      max-width: 100%;
    }
  }
</style>
