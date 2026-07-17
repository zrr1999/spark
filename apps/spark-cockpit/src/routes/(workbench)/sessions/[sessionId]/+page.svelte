<script lang="ts">
  import SessionsWorkspace from "$lib/SessionsWorkspace.svelte";

  let { data, form } = $props();
  let t = $derived(data.messages.sessions);
</script>

<svelte:head>
  <title>{data.selectedSession?.title ?? data.selectedSessionId} · {t.headTitle}</title>
</svelte:head>

<SessionsWorkspace
  sessions={data.sessions}
  workspaces={data.workspaces ?? []}
  selectedSessionId={data.selectedSessionId}
  sendSubmissionIdSeed={data.sendSubmissionIdSeed}
  activeWorkspaceId={data.activeWorkspace?.id ?? null}
  messages={t}
  common={data.messages.common}
  locale={data.locale}
  activity={data.sessionActivity}
  sessionView={data.sessionSnapshot}
  sessionHistory={data.sessionHistory}
  initialEventCursor={data.sessionEventCursor}
  formMessage={form?.message ?? null}
  formIntent={form?.intent ?? null}
  formValues={form?.values ?? null}
  canAssign={data.canAssign}
  modelControl={data.modelControl}
/>
