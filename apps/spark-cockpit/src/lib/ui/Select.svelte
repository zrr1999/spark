<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { Select } from "bits-ui";
  import { getContext } from "svelte";
  import { fieldContextKey, type FieldContext } from "./field-context";
  import type { SelectGroup } from "./select-types";

  let {
    id,
    name,
    value = $bindable(""),
    groups,
    label,
    placeholder = label,
    disabled = false,
    required = false,
    compact = false,
    onValueChange,
  }: {
    id: string;
    name?: string;
    value?: string;
    groups: SelectGroup[];
    label: string;
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
    compact?: boolean;
    onValueChange?: (value: string) => void;
  } = $props();

  const field = getContext<FieldContext | undefined>(fieldContextKey);
  let options = $derived(groups.flatMap((group) => group.options));
  let selected = $derived(options.find((option) => option.value === value));
  let describedBy = $derived(field?.describedBy());
  let invalid = $derived(field?.invalid() ? true : undefined);
</script>

<Select.Root
  type="single"
  items={options}
  bind:value
  {name}
  {required}
  {disabled}
  allowDeselect={false}
  onValueChange={onValueChange}
>
  <Select.Trigger
    {id}
    class="ui-select-trigger {compact ? 'compact' : ''}"
    aria-label={label}
    aria-describedby={describedBy}
    aria-invalid={invalid}
    title={selected?.label ?? placeholder}
  >
    <span>{selected?.label ?? placeholder}</span>
    <Icon name="chevron-down" size={14} />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content class="ui-select-content" sideOffset={6}>
      <Select.ScrollUpButton class="ui-select-scroll"><Icon name="chevron-down" size={14} /></Select.ScrollUpButton>
      <Select.Viewport class="ui-select-viewport">
        {#each groups as group (group.id)}
          <Select.Group class="ui-select-group">
            {#if group.label}<Select.GroupHeading class="ui-select-heading">{group.label}</Select.GroupHeading>{/if}
            {#each group.options as option (option.value)}
              <Select.Item
                value={option.value}
                label={option.label}
                disabled={option.disabled}
                class="ui-select-item"
              >
                {#snippet children({ selected: itemSelected })}
                  <span>{option.label}</span>
                  {#if itemSelected}<Icon name="check" size={15} />{/if}
                {/snippet}
              </Select.Item>
            {/each}
          </Select.Group>
        {/each}
      </Select.Viewport>
      <Select.ScrollDownButton class="ui-select-scroll"><Icon name="chevron-down" size={14} /></Select.ScrollDownButton>
    </Select.Content>
  </Select.Portal>
</Select.Root>

<style>
  :global(.ui-select-trigger) {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    gap: var(--spacing-sm);
    justify-content: space-between;
    min-height: 40px;
    min-width: 180px;
    padding: 7px 11px;
    text-align: left;
    width: 100%;
  }

  :global(.ui-select-trigger.compact) {
    min-height: 32px;
    min-width: 140px;
    padding-block: 4px;
  }

  :global(.ui-select-trigger > span) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.ui-select-trigger:hover:not(:disabled)) {
    background: var(--color-surface-soft);
    border-color: var(--color-focus-ring);
  }

  :global(.ui-select-trigger:focus-visible) {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  :global(.ui-select-trigger:disabled) {
    background: var(--color-surface-soft);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }

  :global(.ui-select-content) {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-popover);
    max-height: min(360px, var(--bits-select-content-available-height));
    min-width: var(--bits-select-anchor-width);
    overflow: hidden;
    padding: var(--spacing-xxs);
    width: max(var(--bits-select-anchor-width), 220px);
    z-index: 120;
  }

  :global(.ui-select-viewport) {
    max-height: 320px;
    overflow-y: auto;
  }

  :global(.ui-select-group + .ui-select-group) {
    border-top: 1px solid var(--color-border-soft);
    margin-top: var(--spacing-xxs);
    padding-top: var(--spacing-xxs);
  }

  :global(.ui-select-heading) {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 7px 9px 4px;
    text-transform: uppercase;
  }

  :global(.ui-select-item) {
    align-items: center;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: flex;
    font-size: 13px;
    gap: var(--spacing-sm);
    justify-content: space-between;
    min-height: 40px;
    padding: 7px 9px;
    user-select: none;
  }

  :global(.ui-select-item[data-highlighted]) {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  :global(.ui-select-item[data-disabled]) {
    color: var(--color-ink-disabled);
    cursor: not-allowed;
    opacity: 0.7;
  }

  :global(.ui-select-scroll) {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    height: 26px;
    justify-content: center;
  }

  :global(.ui-select-scroll:first-child) {
    transform: rotate(180deg);
  }
</style>
