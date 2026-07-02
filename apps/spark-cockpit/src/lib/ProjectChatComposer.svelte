<script lang="ts">
  import type { ComponentProps } from "svelte";
  import CockpitChatComposer from "$lib/CockpitChatComposer.svelte";

  type CockpitComposerProps = ComponentProps<typeof CockpitChatComposer>;
  type ProjectComposerProps = Omit<
    CockpitComposerProps,
    "contextName" | "contextChipLabel" | "contextIcon"
  > & {
    projectName: string;
    t: CockpitComposerProps["t"] & { projectContext: string };
  };

  let {
    t,
    projectName,
    form,
    canStartTask,
    hasActiveRun,
    startButtonLabel,
    latestActiveInvocationId,
    suggestions,
    contextCards,
    submitAction,
    cancelAction,
    composerId,
    cancelFormId,
  }: ProjectComposerProps = $props();
</script>

<CockpitChatComposer
  {t}
  contextName={projectName}
  contextChipLabel={t.projectContext}
  contextIcon="folder"
  {form}
  {canStartTask}
  {hasActiveRun}
  {startButtonLabel}
  {latestActiveInvocationId}
  {suggestions}
  {contextCards}
  {submitAction}
  {cancelAction}
  {composerId}
  {cancelFormId}
/>
