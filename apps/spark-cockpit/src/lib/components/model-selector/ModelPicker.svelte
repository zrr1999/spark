<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { Dialog as DialogShell } from "$lib/ui";
  import { Command, Dialog } from "bits-ui";
  import type { ModelPickerGroup } from "./types";

  let {
    id,
    name = "model",
    form,
    value = $bindable(""),
    open = $bindable(false),
    groups,
    disabled = false,
    required = false,
    label,
    title,
    description,
    placeholder,
    searchPlaceholder,
    emptyLabel,
    closeLabel,
    clearSearchLabel,
    selectedLabel,
    compact = false,
    settingsHref,
    settingsLabel,
    onValueChange,
    onCommit,
  }: {
    id: string;
    name?: string;
    form?: string;
    value?: string;
    open?: boolean;
    groups: ModelPickerGroup[];
    disabled?: boolean;
    required?: boolean;
    label: string;
    title: string;
    description: string;
    placeholder: string;
    searchPlaceholder: string;
    emptyLabel: string;
    closeLabel: string;
    clearSearchLabel: string;
    selectedLabel?: string;
    compact?: boolean;
    settingsHref?: string;
    settingsLabel?: string;
    onValueChange?: (value: string) => void;
    onCommit?: (model: string) => void;
  } = $props();

  let search = $state("");
  let commandValue = $state("");
  let selectedOption = $derived(
    groups.flatMap((group) => group.options).find((option) => option.value === value),
  );
  let selectedGroup = $derived(
    groups.find((group) => group.options.some((option) => option.value === value)),
  );
  let triggerLabel = $derived(selectedOption?.label ?? selectedLabel ?? placeholder);

  function select(nextValue: string) {
    const option = groups
      .flatMap((group) => group.options)
      .find((candidate) => candidate.value === nextValue);
    if (!option || option.disabled) return;
    const changed = nextValue !== value;
    value = nextValue;
    commandValue = nextValue;
    open = false;
    onValueChange?.(nextValue);
    if (changed) onCommit?.(nextValue);
  }

  function resetSearch(nextOpen: boolean) {
    if (nextOpen) {
      commandValue = value;
      return;
    }
    search = "";
  }

  function monogram(labelText: string) {
    return labelText.trim().slice(0, 1).toUpperCase() || "M";
  }
</script>

<input type="hidden" {name} {form} {disabled} {value} />

<DialogShell
  bind:open
  layout="grid"
  overflow="hidden"
  mobile="sheet"
  maxHeight="min(680px, calc(100dvh - 32px))"
  contentClass="model-picker-dialog"
  describedBy={`${id}-description`}
  onOpenChangeComplete={resetSearch}
>
  {#snippet trigger()}
    <Dialog.Trigger
      id={id}
      class="model-picker-trigger {compact ? 'compact' : ''}"
      {disabled}
      aria-label={label}
      aria-required={required}
      title={triggerLabel}
      data-model-picker-trigger
      onclick={() => resetSearch(true)}
    >
      <span class="trigger-icon"><Icon name="spark" size={compact ? 14 : 15} /></span>
      <span class="trigger-copy">
        <strong>{triggerLabel}</strong>
        {#if !compact && selectedGroup}<small>{selectedGroup.label}</small>{/if}
      </span>
      <Icon name="chevron-down" size={14} />
    </Dialog.Trigger>
  {/snippet}

  <header class="dialog-heading">
    <div>
      <Dialog.Title class="model-picker-title">{title}</Dialog.Title>
      <Dialog.Description id={`${id}-description`} class="model-picker-description">
        {description}
      </Dialog.Description>
      {#if settingsHref && settingsLabel}
        <a class="model-picker-settings" href={settingsHref}>
          <Icon name="settings" size={14} />
          {settingsLabel}
        </a>
      {/if}
    </div>
    <Dialog.Close class="model-picker-close" aria-label={closeLabel}>
      <Icon name="close" size={17} />
    </Dialog.Close>
  </header>

  <Command.Root class="model-picker-command" label={title} loop bind:value={commandValue}>
    <div class="command-search">
      <Icon name="search" size={17} />
      <Command.Input
        bind:value={search}
        placeholder={searchPlaceholder}
        autocomplete="off"
        autofocus
      />
      {#if search}
        <button
          type="button"
          class="clear-search"
          aria-label={clearSearchLabel}
          onclick={() => (search = "")}
        >
          <Icon name="close" size={14} />
        </button>
      {/if}
    </div>

    <Command.List class="model-picker-list">
      <Command.Empty class="model-picker-empty">{emptyLabel}</Command.Empty>
      {#each groups as group (group.id)}
        <Command.Group value={group.id} class="model-picker-group">
          <Command.GroupHeading class="model-picker-group-heading">
            <span class="provider-mark">{monogram(group.label)}</span>
            <span>
              <strong>{group.label}</strong>
              {#if group.description}<small>{group.description}</small>{/if}
            </span>
          </Command.GroupHeading>
          <Command.GroupItems class="model-picker-group-items">
            {#each group.options as option (option.value)}
              <Command.Item
                value={option.value}
                keywords={[
                  option.label,
                  group.label,
                  option.description ?? "",
                  ...(option.keywords ?? []),
                ]}
                disabled={option.disabled}
                class="model-picker-item"
                onSelect={() => select(option.value)}
              >
                <span class="item-copy">
                  <strong>{option.label}</strong>
                  {#if option.description}<small>{option.description}</small>{/if}
                </span>
                {#if option.value === value}<Icon name="check" size={16} />{/if}
              </Command.Item>
            {/each}
          </Command.GroupItems>
        </Command.Group>
      {/each}
    </Command.List>
  </Command.Root>
</DialogShell>

<style>
  :global(.model-picker-trigger) {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    cursor: pointer;
    display: inline-grid;
    font: inherit;
    gap: var(--spacing-xs);
    grid-template-columns: auto minmax(0, 1fr) auto;
    min-height: 40px;
    min-width: 220px;
    padding: 5px 10px;
    text-align: left;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  :global(.model-picker-trigger:hover:not(:disabled)) {
    background: var(--color-surface-soft);
    border-color: var(--color-focus-ring);
  }

  :global(.model-picker-trigger:focus-visible) {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  :global(.model-picker-trigger:disabled) {
    color: var(--color-ink-disabled);
    cursor: not-allowed;
    opacity: 0.7;
  }

  :global(.model-picker-trigger.compact) {
    flex: 1 1 10rem;
    max-width: min(320px, 100%);
    min-width: 0;
    width: auto;
  }

  .trigger-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-sm);
    color: var(--color-primary);
    display: inline-flex;
    height: 26px;
    justify-content: center;
    width: 26px;
  }

  .trigger-copy {
    display: grid;
    min-width: 0;
  }

  .trigger-copy strong,
  .trigger-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-copy strong {
    font-size: 13px;
    font-weight: var(--weight-body-medium);
    line-height: 1.25;
  }

  .trigger-copy small {
    color: var(--color-ink-subtle);
    font-size: 10px;
    line-height: 1.3;
  }

  :global(.model-picker-dialog) {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-popover);
    display: grid;
    left: 50%;
    max-height: min(680px, calc(100dvh - 32px));
    max-width: calc(100vw - 32px);
    overflow: hidden;
    position: fixed;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(600px, calc(100vw - 32px));
    z-index: 101;
  }

  :global(.model-picker-dialog:focus-visible) {
    outline: none;
  }

  .dialog-heading {
    align-items: start;
    border-bottom: 1px solid var(--color-border-soft);
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
    padding: var(--spacing-lg) var(--spacing-xl) var(--spacing-md);
  }

  :global(.model-picker-title) {
    color: var(--color-ink);
    font-size: var(--text-section-title);
    font-weight: var(--weight-section-title);
    line-height: var(--leading-section-title);
    margin: 0;
  }

  :global(.model-picker-description) {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
    margin: var(--spacing-xxs) 0 0;
  }

  :global(.model-picker-close),
  .clear-search {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 auto;
    justify-content: center;
  }

  :global(.model-picker-close) {
    height: 32px;
    width: 32px;
  }

  :global(.model-picker-close:hover),
  .clear-search:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  :global(.model-picker-command) {
    display: grid;
    min-height: 0;
  }

  .command-search {
    align-items: center;
    border-bottom: 1px solid var(--color-border-soft);
    color: var(--color-ink-subtle);
    display: grid;
    gap: var(--spacing-xs);
    grid-template-columns: auto minmax(0, 1fr) auto;
    min-height: 52px;
    padding: 0 var(--spacing-xl);
  }

  .command-search :global(input) {
    background: transparent;
    border: 0;
    color: var(--color-ink);
    font: inherit;
    min-height: 50px;
    outline: none;
    width: 100%;
  }

  .command-search :global(input)::placeholder {
    color: var(--color-ink-subtle);
  }

  .clear-search {
    height: 32px;
    width: 32px;
  }

  :global(.model-picker-list) {
    max-height: min(420px, calc(100dvh - 220px));
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--spacing-xs);
  }

  :global(.model-picker-group + .model-picker-group) {
    border-top: 1px solid var(--color-border-soft);
    margin-top: var(--spacing-xs);
    padding-top: var(--spacing-xs);
  }

  :global(.model-picker-group-heading) {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    gap: 10px;
    min-height: 40px;
    padding: 5px 8px;
  }

  .provider-mark {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-sm);
    color: var(--color-ink-muted);
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 600;
    height: 26px;
    justify-content: center;
    width: 26px;
  }

  :global(.model-picker-group-heading) > span:last-child {
    display: grid;
    min-width: 0;
  }

  :global(.model-picker-group-heading) strong {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 600;
  }

  :global(.model-picker-group-heading) small {
    font-size: 10px;
  }

  :global(.model-picker-group-items) {
    display: grid;
    gap: 2px;
  }

  :global(.model-picker-item) {
    align-items: center;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: flex;
    gap: var(--spacing-sm);
    justify-content: space-between;
    min-height: 42px;
    padding: 7px 10px 7px 44px;
    user-select: none;
  }

  :global(.model-picker-item[data-highlighted]) {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  :global(.model-picker-item[data-disabled]) {
    color: var(--color-ink-disabled);
    cursor: not-allowed;
    opacity: 0.72;
  }

  .item-copy {
    display: grid;
    min-width: 0;
  }

  .item-copy strong,
  .item-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-copy strong {
    font-size: 13px;
    font-weight: var(--weight-body-medium);
  }

  .item-copy small {
    color: var(--color-ink-subtle);
    font-size: 10px;
  }

  :global(.model-picker-empty) {
    color: var(--color-ink-subtle);
    font-size: 13px;
    padding: var(--spacing-xxl) var(--spacing-md);
    text-align: center;
  }

  .model-picker-settings {
    align-items: center;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 12px;
    font-weight: 600;
    gap: 6px;
    margin-top: var(--spacing-sm);
    min-height: 28px;
    padding: 0;
    text-decoration: none;
  }

  .model-picker-settings:hover {
    color: var(--color-ink);
  }

  @media (max-width: 640px) {
    :global(.model-picker-trigger),
    :global(.model-picker-trigger.compact) {
      min-width: 0;
      width: 100%;
    }

    .dialog-heading,
    .command-search {
      padding-left: var(--spacing-md);
      padding-right: var(--spacing-md);
    }

    :global(.model-picker-list) {
      max-height: min(55dvh, 480px);
    }
  }
</style>
