<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import AgentMdxStream from "$lib/AgentMdxStream.svelte";
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { workspacePath } from "$lib/workspace-routes";
  import type { SparkModelControlSnapshot, SparkModelRef } from "@zendev-lab/spark-protocol";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { onMount } from "svelte";

  type SessionRecord = {
    sessionId: string;
    workspaceId: string;
    title?: string;
    status: string;
    role?: string;
    createdAt: string;
    updatedAt: string;
  };

  type WorkspaceOption = {
    id: string;
    slug: string;
    name: string;
  };

  type SessionActivityCommand = {
    id: string;
    title: string | null;
    goal: string | null;
    status: string;
    deliveryStatus: string | null;
    runtimeName: string | null;
    runtimeStatus: string | null;
    invocationId: string | null;
    invocationStatus: string | null;
    latestLog: string | null;
    latestLogAt: string | null;
    createdAt: string;
    updatedAt: string;
  };

  type SessionActivityReport = {
    id: string;
    kind: string;
    title: string;
    text: string;
    role: string | null;
    status: string | null;
    createdAt: string;
  };

  type SessionActivity = {
    commands: SessionActivityCommand[];
    reports: SessionActivityReport[];
  };

  type FormValues = {
    workspaceId?: string;
    sessionId?: string;
    message?: string;
    model?: string;
  };

  type ModelControlState = {
    available: boolean;
    snapshot: SparkModelControlSnapshot;
    error?: string;
  };

  type SubmissionState = "idle" | "submitting" | "success" | "error";

  type TimelineItem = {
    id: string;
    actor: "user" | "spark";
    body: string;
    title: string | null;
    status: string | null;
    timestamp: string;
    meta: string | null;
    order: number;
  };

  type Messages = {
    aria: string;
    createWorkspaceLabel: string;
    createNoWorkspaceTitle: string;
    createNoWorkspaceBody: string;
    createWorkspaceAction: string;
    detailsTitle: string;
    statusLabel: string;
    workspaceLabel: string;
    roleLabel: string;
    channelRoutingTitle: string;
    channelRoutingBody: string;
    configureChannels: string;
    managementTitle: string;
    archiveBody: string;
    archiveSubmit: string;
    unknownWorkspace: string;
  };

  type Props = {
    sessions: SessionRecord[];
    workspaces: WorkspaceOption[];
    selectedSessionId: string | null;
    activeWorkspaceId?: string | null;
    showCreate?: boolean;
    messages: Messages;
    common: Parameters<typeof getStatusLabel>[1];
    locale: string;
    activity?: SessionActivity | null;
    formMessage?: string | null;
    formIntent?: string | null;
    formValues?: FormValues | null;
    canAssign?: boolean;
    modelControl?: ModelControlState;
  };

  let {
    sessions,
    workspaces,
    selectedSessionId,
    activeWorkspaceId = null,
    messages,
    common,
    locale,
    activity = null,
    formMessage = null,
    formIntent = null,
    formValues = null,
    canAssign = true,
    modelControl = { available: false, snapshot: { providers: [], diagnostics: [] } },
  }: Props = $props();

  let selected = $derived(
    sessions.find((session) => session.sessionId === selectedSessionId) ?? null,
  );
  let activityCommands = $derived(activity?.commands ?? []);
  let activityReports = $derived(activity?.reports ?? []);
  let defaultWorkspaceId = $derived(
    (activeWorkspaceId && workspaces.some((workspace) => workspace.id === activeWorkspaceId)
      ? activeWorkspaceId
      : workspaces[0]?.id) ?? "",
  );
  let availableModels = $derived(
    modelControl.snapshot.providers.flatMap((provider) =>
      provider.models.filter((entry) => entry.available),
    ),
  );
  let effectiveModel = $derived(
    modelControl.snapshot.session?.model ?? modelControl.snapshot.defaultModel ?? null,
  );
  let effectiveModelValue = $derived(effectiveModel ? modelValue(effectiveModel) : "");
  let effectiveModelAvailable = $derived(
    Boolean(
      effectiveModelValue &&
        availableModels.some((entry) => modelValue(entry.model) === effectiveModelValue),
    ),
  );
  let modelReady = $derived(modelControl.available && effectiveModelAvailable);
  let startWorkspaceId = $state("");
  let startModel = $state("");
  let sessionModel = $state("");
  let startMessage = $state("");
  let message = $state("");
  let initialFormValuesApplied = $state(false);
  let startState = $state<SubmissionState>("idle");
  let sendState = $state<SubmissionState>("idle");
  let modelState = $state<SubmissionState>("idle");
  let startFeedback = $state<string | null>(null);
  let sendFeedback = $state<string | null>(null);
  let modelFeedback = $state<string | null>(null);
  let refreshingActivity = $state(false);
  let startModelReady = $derived(
    modelControl.available &&
      availableModels.some((entry) => modelValue(entry.model) === startModel),
  );

  let isZh = $derived(locale.toLowerCase().startsWith("zh"));
  let copy = $derived(
    isZh
      ? {
          newConversation: "新对话",
          startHint: "选择工作空间，然后直接说要做什么。发送首条消息后，Spark 会自动建立会话和内部任务。",
          messageLabel: "消息",
          startPlaceholder: "告诉 Spark 你想完成什么……",
          messagePlaceholder: "继续说明、补充约束或调整方向……",
          startSubmit: "开始对话",
          sendSubmit: "发送",
          sending: "发送中…",
          sent: "消息已发送。",
          sendFailed: "消息发送失败，请重试。",
          startFailed: "无法开始对话，请重试。",
          timelineTitle: "对话",
          timelineEmpty: "发送第一条消息后，Spark 的回复和执行进度会出现在这里。",
          you: "你",
          spark: "Spark",
          internalDetails: "内部运行详情",
          internalHint: "Project、Task 和 Run 由 Spark 自动创建与管理。",
          noInternalRuns: "还没有内部运行。",
          conversationContext: "会话上下文",
          collapseDetails: "会话与运行详情",
          modelLabel: "模型",
          modelUnavailable: "没有已登录且可用的模型",
          currentModelUnavailable: "当前模型不可用，请先切换模型",
          configureModels: "配置 Provider",
          modelUpdated: "会话模型已更新。",
          modelFailed: "无法切换模型。",
        }
      : {
          newConversation: "New conversation",
          startHint:
            "Choose a workspace and say what you need. Spark creates the conversation and internal tasks when you send the first message.",
          messageLabel: "Message",
          startPlaceholder: "Tell Spark what you want to accomplish…",
          messagePlaceholder: "Add context, constraints, or steer the work…",
          startSubmit: "Start conversation",
          sendSubmit: "Send",
          sending: "Sending…",
          sent: "Message sent.",
          sendFailed: "Could not send the message. Try again.",
          startFailed: "Could not start the conversation. Try again.",
          timelineTitle: "Conversation",
          timelineEmpty: "Spark replies and execution progress will appear here after you send a message.",
          you: "You",
          spark: "Spark",
          internalDetails: "Internal run details",
          internalHint: "Spark creates and manages projects, tasks, and runs automatically.",
          noInternalRuns: "No internal runs yet.",
          conversationContext: "Conversation context",
          collapseDetails: "Conversation and run details",
          modelLabel: "Model",
          modelUnavailable: "No authenticated model is available",
          currentModelUnavailable: "Current model unavailable — choose another model",
          configureModels: "Configure providers",
          modelUpdated: "Conversation model updated.",
          modelFailed: "Could not switch models.",
        },
  );

  let timelineItems = $derived.by(() => {
    const items: TimelineItem[] = [];
    const submittedMessages = new Set<string>();

    for (const command of activityCommands) {
      const body = command.goal?.trim() || command.title?.trim() || command.id;
      submittedMessages.add(normalizeMessage(body));
      items.push({
        id: "command:" + command.id,
        actor: "user",
        body,
        title: null,
        status: commandStatus(command),
        timestamp: command.createdAt,
        meta: null,
        order: 0,
      });
    }

    for (const report of activityReports) {
      if (report.kind === "daemon.task.lifecycle" || report.role === "tool") continue;
      const actor = isUserRole(report.role) ? "user" : "spark";
      if (actor === "user" && submittedMessages.has(normalizeMessage(report.text))) continue;
      items.push({
        id: "report:" + report.id,
        actor,
        body: report.text,
        title: actor === "user" ? null : report.title,
        status: report.status,
        timestamp: report.createdAt,
        meta: report.role && !["assistant", "user"].includes(report.role) ? report.role : null,
        order: 1,
      });
    }

    return items.sort((left, right) => {
      const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
      if (Number.isFinite(time) && time !== 0) return time;
      const lexical = left.timestamp.localeCompare(right.timestamp);
      return lexical || left.order - right.order || left.id.localeCompare(right.id);
    });
  });

  $effect(() => {
    if (!initialFormValuesApplied) {
      startWorkspaceId = formValues?.workspaceId ?? "";
      startMessage =
        formIntent === "startConversation" ? (formValues?.message ?? "") : startMessage;
      startModel = formValues?.model ?? startModel;
      message = formIntent === "sendMessage" ? (formValues?.message ?? "") : message;
      initialFormValuesApplied = true;
    }

    if (!startWorkspaceId || !workspaces.some((workspace) => workspace.id === startWorkspaceId)) {
      startWorkspaceId = defaultWorkspaceId;
    }
    const defaultModelValue = effectiveModelValue;
    if (!startModel || !availableModels.some((entry) => modelValue(entry.model) === startModel)) {
      startModel = effectiveModelAvailable
        ? defaultModelValue
        : modelValue(availableModels[0]?.model);
    }
    if (sessionModel !== defaultModelValue) sessionModel = defaultModelValue;
  });

  $effect(() => {
    if (formIntent === "startConversation" && formMessage && startState === "idle") {
      startFeedback = formMessage;
    }
    if (formIntent === "sendMessage" && formMessage && sendState === "idle") {
      sendFeedback = formMessage;
    }
  });

  onMount(() => {
    let closed = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const fallbackInterval = setInterval(() => {
      void refreshActivity();
    }, 5_000);

    const connect = () => {
      if (closed) return;
      eventSource = new EventSource("/api/v1/events");
      eventSource.addEventListener("spark-cockpit.event", () => {
        void refreshActivity();
      });
      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        if (!closed && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 1_000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      clearInterval(fallbackInterval);
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  });

  async function refreshActivity() {
    if (!selected || refreshingActivity || document.visibilityState === "hidden") return;
    refreshingActivity = true;
    try {
      await invalidateAll();
    } finally {
      refreshingActivity = false;
    }
  }

  function workspaceLabel(workspaceId: string) {
    return (
      workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
      messages.unknownWorkspace
    );
  }

  function workspaceHref(workspaceId: string) {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    return workspace ? workspacePath(workspace) : null;
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function relative(value: string | null) {
    return formatRelativeTime(value, locale as "en" | "zh-CN", common);
  }

  function commandStatus(command: SessionActivityCommand) {
    return command.invocationStatus ?? command.deliveryStatus ?? command.status;
  }

  function normalizeMessage(value: string) {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  }

  function isUserRole(role: string | null) {
    return role === "user" || role === "human" || role === "operator";
  }

  function resultMessage(result: unknown, fallback: string) {
    if (!result || typeof result !== "object") return fallback;

    if ("data" in result && result.data && typeof result.data === "object") {
      const candidate = (result.data as { message?: unknown }).message;
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    if ("error" in result && result.error instanceof Error && result.error.message) {
      return result.error.message;
    }
    return fallback;
  }

  const enhanceStartConversation: SubmitFunction = () => {
    startState = "submitting";
    startFeedback = copy.sending;

    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "redirect") return;

      if (result.type === "success") {
        startState = "success";
        startFeedback = resultMessage(result, copy.sent);
        startMessage = "";
        await invalidateAll();
        return;
      }

      startState = "error";
      startFeedback = resultMessage(result, copy.startFailed);
    };
  };

  const enhanceSendMessage: SubmitFunction = () => {
    sendState = "submitting";
    sendFeedback = copy.sending;

    return async ({ result, update }) => {
      await update({ reset: false });

      if (result.type === "success") {
        sendState = "success";
        sendFeedback = resultMessage(result, copy.sent);
        message = "";
        await invalidateAll();
        return;
      }

      if (result.type === "redirect") return;
      sendState = "error";
      sendFeedback = resultMessage(result, copy.sendFailed);
    };
  };

  const enhanceSelectModel: SubmitFunction = () => {
    modelState = "submitting";
    modelFeedback = copy.sending;
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        modelState = "success";
        modelFeedback = resultMessage(result, copy.modelUpdated);
        await invalidateAll();
        return;
      }
      modelState = "error";
      modelFeedback = resultMessage(result, copy.modelFailed);
    };
  };

  function modelValue(model: SparkModelRef | undefined) {
    return model ? `${model.providerName}/${model.modelId}` : "";
  }

  function modelLabel(model: SparkModelRef) {
    return `${model.modelLabel ?? model.modelId} · ${model.providerLabel ?? model.providerName}`;
  }

  function submitModelSelection(event: Event) {
    (event.currentTarget as HTMLSelectElement).form?.requestSubmit();
  }
</script>

{#snippet sessionDetails(compact = false)}
  {#if selected}
    <div class:compact-details={compact} class="details-content">
      <dl class="details-grid">
        <div>
          <dt>{messages.statusLabel}</dt>
          <dd><span class="status-pill {selected.status}">{statusLabel(selected.status)}</span></dd>
        </div>
        <div>
          <dt>{messages.workspaceLabel}</dt>
          <dd>
            {#if workspaceHref(selected.workspaceId)}
              <a href={workspaceHref(selected.workspaceId)}>{workspaceLabel(selected.workspaceId)}</a>
            {:else}
              {workspaceLabel(selected.workspaceId)}
            {/if}
          </dd>
        </div>
        {#if selected.role}
          <div>
            <dt>{messages.roleLabel}</dt>
            <dd>{selected.role}</dd>
          </div>
        {/if}
      </dl>

      <details class="run-details">
        <summary>
          <span><Icon name="activity" size={15} />{copy.internalDetails}</span>
          <small>{activityCommands.length}</small>
        </summary>
        <div class="run-details-body">
          <p>{copy.internalHint}</p>
          {#if activityCommands.length === 0}
            <p class="muted">{copy.noInternalRuns}</p>
          {:else}
            <ol class="run-list">
              {#each activityCommands as command}
                <li>
                  <div>
                    <strong>{command.goal || command.title || command.id}</strong>
                    <small>{relative(command.updatedAt)}</small>
                    {#if command.latestLog?.trim()}
                      <p class="run-log">{command.latestLog.trim()}</p>
                    {/if}
                  </div>
                  <span class="status-pill {commandStatus(command)}">
                    {statusLabel(commandStatus(command))}
                  </span>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      </details>

      {#if !compact}
        <section class="channel-routing">
          <h3>{messages.channelRoutingTitle}</h3>
          <p class="muted">{messages.channelRoutingBody}</p>
          <a
            class="secondary-action"
            href={(() => {
              const workspace =
                workspaces.find((entry) => entry.id === activeWorkspaceId) ?? workspaces[0];
              return workspace
                ? workspacePath(workspace, "/settings/channels")
                : "/settings/channels";
            })()}
          >
            {messages.configureChannels}
          </a>
        </section>
      {/if}

      {#if selected.status !== "archived"}
        <section class="session-management">
          <h3>{messages.managementTitle}</h3>
          {#if !compact}<p class="muted">{messages.archiveBody}</p>{/if}
          <form method="POST" action="?/archiveSession">
            <input type="hidden" name="sessionId" value={selected.sessionId} />
            <button class="danger-action" type="submit">
              <Icon name="archive" size={15} stroke={2.1} />
              <span>{messages.archiveSubmit}</span>
            </button>
          </form>
        </section>
      {/if}
    </div>
  {/if}
{/snippet}

<section class="sessions-stage" class:has-selection={Boolean(selected)} aria-label={messages.aria}>
  <main class="stage-pane">
    {#if !selected}
      <div class="conversation-start">
        {#if workspaces.length === 0}
          <div class="stage-empty">
            <Icon name="agents" size={28} />
            <div>
              <h1>{messages.createNoWorkspaceTitle}</h1>
              <p>{messages.createNoWorkspaceBody}</p>
              <a class="primary-action" href="/workspaces/new">{messages.createWorkspaceAction}</a>
            </div>
          </div>
        {:else}
          <div class="start-heading">
            <span class="spark-mark"><Icon name="spark" size={22} /></span>
            <div>
              <p class="kicker">Spark</p>
              <h1>{copy.newConversation}</h1>
              <p>{copy.startHint}</p>
            </div>
          </div>

          <form
            method="POST"
            action="?/startConversation"
            class="composer start-composer"
            aria-busy={startState === "submitting"}
            use:enhance={enhanceStartConversation}
          >
            <div class="composer-selects">
              <label class="workspace-select">
                <span>{messages.createWorkspaceLabel}</span>
                <select name="workspaceId" required bind:value={startWorkspaceId}>
                  {#each workspaces as workspace}
                    <option value={workspace.id}>{workspace.name}</option>
                  {/each}
                </select>
              </label>
              {#if availableModels.length > 0}
                <label class="workspace-select model-select">
                  <span>{copy.modelLabel}</span>
                  <select name="model" required bind:value={startModel}>
                    {#each modelControl.snapshot.providers as provider}
                      {#if provider.models.some((entry) => entry.available)}
                        <optgroup label={provider.label}>
                          {#each provider.models.filter((entry) => entry.available) as entry}
                            <option value={modelValue(entry.model)}>{entry.model.modelLabel ?? entry.model.modelId}</option>
                          {/each}
                        </optgroup>
                      {/if}
                    {/each}
                  </select>
                </label>
              {:else}
                <a class="model-settings-link" href="/settings/models">
                  <Icon name="settings" size={14} />{copy.configureModels}
                </a>
              {/if}
            </div>
            <label class="sr-only" for="start-conversation-message">{copy.messageLabel}</label>
            <textarea
              id="start-conversation-message"
              name="message"
              rows="5"
              required
              placeholder={copy.startPlaceholder}
              bind:value={startMessage}
              disabled={startState === "submitting"}
            ></textarea>
            <div class="composer-toolbar">
              <p
                class="form-feedback {startState}"
                role={startState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {startFeedback ?? ""}
              </p>
              <button
                class="composer-submit"
                type="submit"
                disabled={startState === "submitting" || !startModelReady || !startMessage.trim()}
              >
                <Icon name="play" size={15} />
                {startState === "submitting" ? copy.sending : copy.startSubmit}
              </button>
            </div>
          </form>
        {/if}
      </div>
    {:else}
      <header class="stage-header">
        <div class="stage-title">
          <p class="kicker">{copy.timelineTitle}</p>
          <h1>{selected.title || copy.newConversation}</h1>
          <p>{workspaceLabel(selected.workspaceId)}</p>
        </div>
        <span class="status-pill {selected.status}">{statusLabel(selected.status)}</span>
      </header>

      <details class="mobile-details">
        <summary>
          <span><Icon name="activity" size={15} />{copy.collapseDetails}</span>
          <Icon name="chevron-down" size={15} />
        </summary>
        {@render sessionDetails(true)}
      </details>

      <div class="timeline-scroll" aria-live="polite">
        {#if timelineItems.length === 0}
          <div class="conversation-empty">
            <span class="spark-mark"><Icon name="spark" size={20} /></span>
            <p>{copy.timelineEmpty}</p>
          </div>
        {:else}
          <div class="timeline">
            {#each timelineItems as item (item.id)}
              <article class="timeline-entry {item.actor}">
                <span class="actor-mark" aria-hidden="true">
                  {#if item.actor === "spark"}
                    <Icon name="spark" size={16} />
                  {:else}
                    {copy.you.slice(0, 1)}
                  {/if}
                </span>
                <div class="message-block">
                  <header>
                    <strong>{item.actor === "user" ? copy.you : copy.spark}</strong>
                    <time datetime={item.timestamp}>{relative(item.timestamp)}</time>
                    {#if item.status}
                      <span class="status-pill {item.status}">{statusLabel(item.status)}</span>
                    {/if}
                  </header>
                  {#if item.title && item.title !== item.body}
                    <h2>{item.title}</h2>
                  {/if}
                  {#if item.actor === "spark"}
                    <div class="assistant-content">
                      <AgentMdxStream source={item.body} streaming={item.status === "running"} />
                    </div>
                  {:else}
                    <p>{item.body}</p>
                  {/if}
                  {#if item.meta}<small>{item.meta}</small>{/if}
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </div>

      <form
        id="session-model-form"
        method="POST"
        action="?/selectModel"
        use:enhance={enhanceSelectModel}
      ></form>
      <input form="session-model-form" type="hidden" name="sessionId" value={selected.sessionId} />

      <form
        method="POST"
        action="?/sendMessage"
        class="composer conversation-composer"
        aria-busy={sendState === "submitting"}
        use:enhance={enhanceSendMessage}
      >
        <input type="hidden" name="sessionId" value={selected.sessionId} />
        <label class="sr-only" for="conversation-message">{copy.messageLabel}</label>
        <textarea
          id="conversation-message"
          name="message"
          rows="3"
          required
          placeholder={copy.messagePlaceholder}
          bind:value={message}
          disabled={!canAssign || sendState === "submitting"}
        ></textarea>
        <div class="composer-toolbar">
          <div class="composer-context">
            {#if availableModels.length > 0}
              <label class="conversation-model-select">
                <Icon name="spark" size={13} />
                <span class="sr-only">{copy.modelLabel}</span>
                <select
                  form="session-model-form"
                  name="model"
                  bind:value={sessionModel}
                  disabled={modelState === "submitting"}
                  onchange={submitModelSelection}
                  aria-label={copy.modelLabel}
                >
                  {#if effectiveModel && !effectiveModelAvailable}
                    <option value={effectiveModelValue} disabled>{copy.currentModelUnavailable}</option>
                  {/if}
                  {#each modelControl.snapshot.providers as provider}
                    {#if provider.models.some((entry) => entry.available)}
                      <optgroup label={provider.label}>
                        {#each provider.models.filter((entry) => entry.available) as entry}
                          <option value={modelValue(entry.model)}>{modelLabel(entry.model)}</option>
                        {/each}
                      </optgroup>
                    {/if}
                  {/each}
                </select>
              </label>
            {:else}
              <a class="model-settings-link compact" href="/settings/models">
                <Icon name="warning" size={13} />{copy.modelUnavailable}
              </a>
            {/if}
            <span>{workspaceLabel(selected.workspaceId)}</span>
            {#if selected.role}<span>{selected.role}</span>{/if}
            <p
              class="form-feedback {sendState}"
              role={sendState === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {sendFeedback ?? ""}
            </p>
            {#if modelFeedback}
              <p class="form-feedback {modelState}" role={modelState === "error" ? "alert" : "status"}>
                {modelFeedback}
              </p>
            {/if}
          </div>
          <button
            class="composer-submit"
            type="submit"
            disabled={!canAssign || !modelReady || modelState === "submitting" || sendState === "submitting" || !message.trim()}
          >
            <Icon name="play" size={15} />
            {sendState === "submitting" ? copy.sending : copy.sendSubmit}
          </button>
        </div>
      </form>
    {/if}
  </main>

  {#if selected}
    <aside class="details-pane" aria-label={messages.detailsTitle}>
      <div class="details-heading">
        <p class="kicker">{copy.conversationContext}</p>
        <h2>{messages.detailsTitle}</h2>
      </div>
      {@render sessionDetails()}
    </aside>
  {/if}
</section>

<style>
  .sessions-stage {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: calc(100dvh - 48px);
    min-height: 520px;
    overflow: hidden;
  }

  .sessions-stage.has-selection {
    grid-template-columns: minmax(0, 1fr) minmax(250px, 290px);
  }

  .stage-pane {
    background: var(--color-canvas);
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    overflow: hidden;
    padding: 20px clamp(16px, 3vw, 32px);
  }

  .details-pane {
    align-content: start;
    background: var(--color-surface);
    border-left: 1px solid var(--color-border);
    display: grid;
    gap: 18px;
    min-height: 0;
    overflow-y: auto;
    padding: 22px 20px;
  }

  .stage-header {
    align-items: start;
    display: flex;
    flex: 0 0 auto;
    gap: 16px;
    justify-content: space-between;
  }

  .stage-title {
    min-width: 0;
  }

  .stage-header h1,
  .start-heading h1,
  .stage-empty h1 {
    color: var(--color-ink);
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.015em;
    line-height: 1.3;
    margin: 0;
  }

  .stage-header h1 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stage-title > p:last-child,
  .start-heading > div > p:last-child,
  .stage-empty p {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
    margin: 4px 0 0;
  }

  .kicker {
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    margin: 0 0 5px;
    text-transform: uppercase;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  .conversation-start {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 0;
  }

  .start-heading,
  .start-composer {
    max-width: 720px;
    width: 100%;
  }

  .start-heading {
    align-items: start;
    display: grid;
    gap: 14px;
    grid-template-columns: auto minmax(0, 1fr);
    margin-bottom: 20px;
  }

  .spark-mark {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 10px;
    color: var(--color-primary);
    display: inline-flex;
    flex: 0 0 auto;
    height: 40px;
    justify-content: center;
    width: 40px;
  }

  .stage-empty {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    flex-direction: column;
    gap: 14px;
    justify-content: center;
    max-width: 460px;
    text-align: center;
  }

  .stage-empty > div {
    display: grid;
    gap: 12px;
    justify-items: center;
  }

  .timeline-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px max(0px, calc((100% - 800px) / 2)) 20px;
    scrollbar-gutter: stable;
  }

  .timeline {
    display: grid;
    gap: 20px;
  }

  .timeline-entry {
    align-items: start;
    display: grid;
    gap: 11px;
    grid-template-columns: 30px minmax(0, 1fr);
  }

  .actor-mark {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 11px;
    font-weight: 700;
    height: 30px;
    justify-content: center;
    width: 30px;
  }

  .timeline-entry.spark .actor-mark {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .message-block {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: var(--shadow-card, 0 1px 2px rgb(15 23 42 / 4%));
    display: grid;
    gap: 8px;
    min-width: 0;
    padding: 13px 14px;
  }

  .timeline-entry.user .message-block {
    background: var(--color-surface-soft);
  }

  .message-block header {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }

  .message-block header strong {
    color: var(--color-ink);
    font-size: 12px;
    font-weight: 700;
  }

  .message-block time,
  .message-block small {
    color: var(--color-ink-subtle);
    font-size: 11px;
  }

  .message-block h2 {
    color: var(--color-ink);
    font-size: 13px;
    font-weight: 650;
  }

  .message-block > p {
    color: var(--color-ink-muted);
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .assistant-content {
    color: var(--color-ink-muted);
    font-size: 14px;
    line-height: 1.6;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .conversation-empty {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    justify-content: center;
    min-height: 180px;
    text-align: center;
  }

  .conversation-empty p {
    font-size: 13px;
    line-height: 1.5;
    max-width: 380px;
  }

  .composer {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    box-shadow:
      0 1px 2px rgb(15 23 42 / 5%),
      0 12px 30px rgb(15 23 42 / 7%);
    display: grid;
    gap: 10px;
    padding: 12px;
  }

  .conversation-composer {
    align-self: center;
    flex: 0 0 auto;
    max-width: 800px;
    width: 100%;
  }

  .composer textarea {
    background: transparent;
    border: 0;
    color: var(--color-ink);
    font: inherit;
    line-height: 1.5;
    min-height: 70px;
    outline: none;
    padding: 3px;
    resize: vertical;
    width: 100%;
  }

  .start-composer textarea {
    min-height: 118px;
  }

  .composer textarea::placeholder {
    color: var(--color-ink-subtle);
  }

  .composer-toolbar {
    align-items: center;
    border-top: 1px solid var(--color-border-soft);
    display: flex;
    gap: 12px;
    justify-content: space-between;
    min-height: 38px;
    padding-top: 10px;
  }

  .composer-context {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    font-size: 11px;
    gap: 8px;
    min-width: 0;
  }

  .composer-selects {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .composer-context > span + span::before {
    content: "·";
    margin-right: 8px;
  }

  .workspace-select {
    align-items: center;
    display: flex;
    gap: 10px;
    width: fit-content;
  }

  .workspace-select > span {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
  }

  .workspace-select select {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-ink);
    font: inherit;
    font-size: 13px;
    max-width: 260px;
    min-height: 34px;
    outline: none;
    padding: 0 30px 0 10px;
  }

  .workspace-select select:focus {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
  }

  .conversation-model-select,
  .model-settings-link {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 11px;
    font-weight: 650;
    gap: 5px;
    min-height: 30px;
    padding: 0 8px;
    text-decoration: none;
  }

  .conversation-model-select select {
    appearance: none;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    max-width: 270px;
    outline: none;
    padding: 0;
  }

  .model-settings-link.compact {
    color: var(--color-danger);
  }

  .composer-submit,
  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: 8px;
    display: inline-flex;
    font-size: 13px;
    font-weight: 650;
    gap: 6px;
    justify-content: center;
    min-height: 36px;
    padding: 0 13px;
    text-decoration: none;
    width: fit-content;
  }

  .composer-submit,
  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: var(--color-on-primary, #fff);
    cursor: pointer;
  }

  .composer-submit:hover:not(:disabled),
  .primary-action:hover {
    background: var(--color-primary-hover, #1d4ed8);
  }

  .composer-submit:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .secondary-action {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  .form-feedback {
    color: var(--color-ink-subtle);
    flex: 1;
    font-size: 12px;
    min-height: 1.4em;
  }

  .form-feedback.success {
    color: var(--color-success-strong, var(--color-success));
  }

  .form-feedback.error {
    color: var(--color-danger-strong, var(--color-danger));
  }

  .details-heading h2 {
    color: var(--color-ink);
    font-size: 15px;
    font-weight: 650;
  }

  .details-content {
    display: grid;
    gap: 20px;
  }

  .details-grid {
    display: grid;
    gap: 14px;
    margin: 0;
  }

  .details-grid div {
    display: grid;
    gap: 5px;
  }

  .details-grid dt {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .details-grid dd {
    color: var(--color-ink-muted);
    font-size: 13px;
    margin: 0;
    min-width: 0;
  }

  .details-grid a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .run-details {
    border-bottom: 1px solid var(--color-border-soft);
    border-top: 1px solid var(--color-border-soft);
    padding: 12px 0;
  }

  .run-details summary,
  .mobile-details summary {
    align-items: center;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: flex;
    font-size: 12px;
    font-weight: 650;
    justify-content: space-between;
    list-style: none;
  }

  .run-details summary::-webkit-details-marker,
  .mobile-details summary::-webkit-details-marker {
    display: none;
  }

  .run-details summary > span,
  .mobile-details summary > span {
    align-items: center;
    display: inline-flex;
    gap: 7px;
  }

  .run-details summary small {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    min-width: 22px;
    padding: 3px 7px;
    text-align: center;
  }

  .run-details-body {
    display: grid;
    gap: 10px;
    padding-top: 12px;
  }

  .run-details-body > p {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.45;
  }

  .run-list {
    display: grid;
    gap: 8px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .run-list li {
    align-items: start;
    display: grid;
    gap: 8px;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .run-list li > div {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .run-list strong {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-list small,
  .muted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.5;
  }

  .run-log {
    color: var(--color-ink-subtle);
    display: -webkit-box;
    font-size: 11px;
    line-height: 1.45;
    margin-top: 4px;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .channel-routing,
  .session-management {
    display: grid;
    gap: 9px;
  }

  .channel-routing h3,
  .session-management h3 {
    color: var(--color-ink);
    font-size: 12px;
    font-weight: 650;
  }

  .danger-action {
    align-items: center;
    background: var(--color-danger-weak, #fef2f2);
    border: 1px solid var(--color-danger-soft, #fecaca);
    border-radius: 8px;
    color: var(--color-danger-strong, #b91c1c);
    cursor: pointer;
    display: inline-flex;
    font-size: 12px;
    font-weight: 650;
    gap: 7px;
    min-height: 34px;
    padding: 0 11px;
    width: fit-content;
  }

  .status-pill {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 650;
    padding: 4px 7px;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .status-pill.running,
  .status-pill.ready,
  .status-pill.queued,
  .status-pill.acked {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill.completed,
  .status-pill.success,
  .status-pill.delivered {
    background: var(--color-success-weak, #ecfdf5);
    color: var(--color-success-strong, #047857);
  }

  .status-pill.failed,
  .status-pill.error,
  .status-pill.rejected {
    background: var(--color-danger-weak, #fef2f2);
    color: var(--color-danger-strong, #b91c1c);
  }

  .status-pill.archived,
  .status-pill.cancelled {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong, var(--color-warning));
  }

  .mobile-details {
    display: none;
  }

  .sr-only {
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  @media (max-width: 960px) {
    .sessions-stage,
    .sessions-stage.has-selection {
      grid-template-columns: minmax(0, 1fr);
      height: calc(100dvh - 48px);
      min-height: 0;
    }

    .details-pane {
      display: none;
    }

    .mobile-details {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 10px;
      display: block;
      flex: 0 0 auto;
      padding: 10px 12px;
    }

    .mobile-details[open] {
      max-height: min(48dvh, 420px);
      overflow-y: auto;
    }

    .mobile-details .details-content {
      border-top: 1px solid var(--color-border-soft);
      gap: 14px;
      margin-top: 10px;
      padding-top: 12px;
    }

    .mobile-details .details-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .timeline-scroll {
      padding-inline: 0;
    }
  }

  @media (max-width: 640px) {
    .stage-pane {
      gap: 12px;
      padding: 14px 12px;
    }

    .conversation-start {
      align-items: stretch;
      justify-content: flex-start;
      padding: 10px 0;
    }

    .start-heading {
      margin-bottom: 14px;
    }

    .composer {
      border-radius: 12px;
      padding: 10px;
    }

    .composer-toolbar {
      align-items: flex-end;
    }

    .conversation-composer textarea {
      min-height: 60px;
    }

    .mobile-details .details-grid {
      grid-template-columns: 1fr 1fr;
    }

    .timeline-entry {
      gap: 8px;
      grid-template-columns: 26px minmax(0, 1fr);
    }

    .actor-mark {
      border-radius: 7px;
      height: 26px;
      width: 26px;
    }

    .message-block {
      padding: 11px 12px;
    }

    .workspace-select {
      align-items: stretch;
      display: grid;
      width: 100%;
    }

    .workspace-select select {
      max-width: none;
      width: 100%;
    }
  }
</style>
