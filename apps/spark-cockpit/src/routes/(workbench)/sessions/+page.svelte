<script lang="ts">
  import { page } from "$app/state";
  import SessionsWorkspace from "$lib/SessionsWorkspace.svelte";

  let { data, form } = $props();
  let t = $derived(data.messages.sessions);
  let startScope = $derived(
    page.url.searchParams.get("new") === "daemon" ? ("daemon" as const) : ("workspace" as const),
  );
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<SessionsWorkspace
  sessions={data.sessions}
  workspaces={data.workspaces ?? []}
  selectedSessionId={data.selectedSessionId}
  activeWorkspaceId={data.activeWorkspace?.id ?? null}
  {startScope}
  messages={t}
  common={data.messages.common}
  locale={data.locale}
  activity={data.sessionActivity}
  formMessage={form?.message ?? null}
  formIntent={form?.intent ?? null}
  formValues={form?.values ?? null}
  modelControl={data.modelControl}
/>
