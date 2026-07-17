<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { Button } from "$lib/ui";

  type Props = {
    label: string;
    submittingLabel: string;
    unavailableLabel: string;
    submitting?: boolean;
    disabled?: boolean;
    onRetry: () => void;
  };

  let {
    label,
    submittingLabel,
    unavailableLabel,
    submitting = false,
    disabled = false,
    onRetry,
  }: Props = $props();
</script>

<div class="session-retry-action" data-session-retry-action>
  <Button
    type="button"
    size="compact"
    variant="secondary"
    disabled={disabled || submitting}
    title={disabled ? unavailableLabel : label}
    onclick={onRetry}
  >
    <Icon name="retry" size={13} />
    {submitting ? submittingLabel : label}
  </Button>
</div>

<style>
  .session-retry-action {
    display: flex;
    justify-content: flex-end;
  }
</style>
