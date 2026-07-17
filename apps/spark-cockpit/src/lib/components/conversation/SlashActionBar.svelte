<script lang="ts">
  import type {
    SlashActionAvailability,
    SlashActionBarProps,
  } from "./index";

  let {
    view,
    disabled = false,
    disabledReason,
    resolveAction,
    onAction,
  }: SlashActionBarProps = $props();

  function availabilityFor(
    action: Parameters<NonNullable<SlashActionBarProps["resolveAction"]>>[0],
  ): SlashActionAvailability {
    if (disabled) {
      return { enabled: false, reason: disabledReason };
    }
    return resolveAction?.(action) ?? { enabled: true };
  }

  function invoke(
    action: Parameters<NonNullable<SlashActionBarProps["onAction"]>>[0],
    availability: SlashActionAvailability,
  ) {
    if (!availability.enabled) return;
    void onAction?.(action);
  }
</script>

<section class="slash-action-bar" aria-label={view.title} data-slash-action-bar={view.id}>
  <header>
    <code>/{view.id}</code>
    <span class="action-heading">
      <strong>{view.title}</strong>
      {#if view.description}<small>{view.description}</small>{/if}
    </span>
  </header>

  <div class="action-list" role="group" aria-label={view.title}>
    {#each view.actions as action (action.id)}
      {@const availability = availabilityFor(action)}
      <button
        type="button"
        class:primary={action.tone === "primary"}
        class:danger={action.tone === "danger"}
        disabled={!availability.enabled}
        title={availability.reason ?? action.description ?? action.label}
        data-action-id={action.id}
        data-action-intent={action.intent}
        onclick={() => invoke(action, availability)}
      >
        <span>{action.label}</span>
        {#if availability.reason}
          <small>{availability.reason}</small>
        {:else if action.description}
          <small>{action.description}</small>
        {/if}
      </button>
    {/each}
  </div>
</section>

<style>
  .slash-action-bar {
    background: color-mix(in srgb, var(--color-primary-weak) 48%, var(--color-surface));
    border: 1px solid color-mix(in srgb, var(--color-primary) 22%, var(--color-border));
    border-radius: var(--rounded-md);
    display: grid;
    gap: 9px;
    min-width: 0;
    padding: 9px;
  }

  header {
    align-items: center;
    display: flex;
    gap: 9px;
    min-width: 0;
  }

  header code {
    background: var(--color-surface);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-sm);
    color: var(--color-primary);
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 6px;
  }

  .action-heading {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .action-heading strong {
    color: var(--color-ink);
    font-size: 12px;
    line-height: 1.25;
  }

  .action-heading small {
    color: var(--color-ink-subtle);
    font-size: 10px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .action-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  button {
    align-items: flex-start;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    flex: 0 1 auto;
    flex-direction: column;
    font: inherit;
    font-size: 11px;
    font-weight: 650;
    gap: 2px;
    justify-content: center;
    min-height: 34px;
    min-width: 72px;
    padding: 5px 9px;
    text-align: left;
  }

  button small {
    color: var(--color-ink-subtle);
    font-size: 9px;
    font-weight: 500;
    line-height: 1.25;
    max-width: 17rem;
    overflow-wrap: anywhere;
  }

  button:hover:not(:disabled) {
    background: var(--color-surface-hover);
    border-color: var(--color-focus-ring);
    color: var(--color-ink);
  }

  button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  button.primary {
    border-color: color-mix(in srgb, var(--color-primary) 42%, var(--color-border));
    color: var(--color-primary);
  }

  button.danger {
    border-color: color-mix(in srgb, var(--color-danger) 38%, var(--color-border));
    color: var(--color-danger);
  }

  button:disabled {
    background: color-mix(in srgb, var(--color-surface-soft) 72%, transparent);
    cursor: not-allowed;
    opacity: 0.62;
  }

  @media (max-width: 520px) {
    .action-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    button {
      width: 100%;
    }
  }
</style>
