<script lang="ts">
  import SessionsWorkspace from "$lib/SessionsWorkspace.svelte";

  let { data, form } = $props();
  let t = $derived(data.messages.sessions);
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<SessionsWorkspace
  sessions={data.sessions}
  workspaces={data.workspaces ?? []}
  selectedSessionId={data.selectedSessionId}
  activeWorkspaceId={data.activeWorkspace?.id ?? null}
  messages={t}
  common={data.messages.common}
  locale={data.locale}
  activity={data.sessionActivity}
  formMessage={form?.message ?? null}
  formIntent={form?.intent ?? null}
  formValues={form?.values ?? null}
  modelControl={data.modelControl}
/>
