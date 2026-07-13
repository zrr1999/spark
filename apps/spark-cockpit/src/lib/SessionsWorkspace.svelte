<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import {
    Composer,
    ConversationViewport,
    Message as ConversationMessage,
  } from "$lib/components/conversation";
  import type { ConversationPartLabels } from "$lib/components/conversation/types";
  import { ModelPicker, type ModelPickerGroup } from "$lib/components/model-selector";
  import { visibleSessionStatus } from "$lib/conversation-status";
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { buildSessionTimeline } from "$lib/session-timeline";
  import { Button } from "$lib/ui";
  import {
    workbenchSessionScope,
    workspaceIdForWorkbenchSession,
  } from "$lib/workbench-session-scope";
  import { workspacePath } from "$lib/workspace-routes";
  import type {
    SparkModelCatalogProvider,
    SparkModelControlSnapshot,
    SparkModelRef,
    SparkSessionView,
  } from "@zendev-lab/spark-protocol";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { onMount, tick } from "svelte";

  type SessionRecord = {
    sessionId: string;
    workspaceId?: string;
    scope?:
      | { kind: "workspace"; workspaceId: string }
      | { kind: "daemon"; daemonId?: string; daemonLabel?: string };
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
    scopeKind?: string;
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

  type Messages = {
    aria: string;
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
    startScope?: "workspace" | "daemon";
    messages: Messages;
    common: Parameters<typeof getStatusLabel>[1];
    locale: string;
    activity?: SessionActivity | null;
    sessionView?: SparkSessionView | null;
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
    startScope = "workspace",
    messages,
    common,
    locale,
    activity = null,
    sessionView = null,
    formMessage = null,
    formIntent = null,
    formValues = null,
    canAssign = true,
    modelControl = { available: false, snapshot: { providers: [], diagnostics: [] } },
  }: Props = $props();

  let selected = $derived(
    sessions.find((session) => session.sessionId === selectedSessionId) ?? null,
  );
  let selectedWorkspaceId = $derived(
    selected ? workspaceIdForWorkbenchSession(selected) : null,
  );
  let selectedWorkspaceHref = $derived(workspaceHref(selectedWorkspaceId));
  let activityCommands = $derived(activity?.commands ?? []);
  let activityReports = $derived(activity?.reports ?? []);
  let sessionMessages = $derived(sessionView?.messages ?? []);
  let modelProviders = $derived(
    modelControl.snapshot.providers.filter((provider) => provider.models.length > 0),
  );
  let modelGroups = $derived(buildModelGroups(modelProviders));
  let activeWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
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
  let modelFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshingActivity = $state(false);
  let sessionModelForm = $state<HTMLFormElement | null>(null);
  let startModelReady = $derived(
    modelControl.available &&
      availableModels.some((entry) => modelValue(entry.model) === startModel),
  );

  let isZh = $derived(locale.toLowerCase().startsWith("zh"));
  let copy = $derived(
    isZh
      ? {
          newConversation: "新对话",
          workspaceConversation: "工作区对话",
          daemonConversation: "全局对话",
          scopeChoiceLabel: "对话范围",
          workspaceStartHint: "在当前工作空间中开始对话。",
          daemonStartHint: "直接与当前 Spark daemon 对话，不绑定任何工作区。",
          daemonScope: "当前 Spark daemon",
          scopeLabel: "范围",
          messageLabel: "消息",
          startPlaceholder: "告诉 Spark 你想完成什么……",
          messagePlaceholder: "继续说明、补充约束或调整方向……",
          startSubmit: "开始对话",
          sendSubmit: "发送",
          sending: "发送中…",
          sent: "",
          sendFailed: "消息发送失败，请重试。",
          startFailed: "无法开始对话，请重试。",
          timelineTitle: "对话",
          timelineEmpty: "发送第一条消息后，Spark 的回复和执行进度会出现在这里。",
          you: "你",
          spark: "Spark",
          internalDetails: "内部运行详情",
          internalHint: "Spark 自动管理这段对话的执行记录。",
          noInternalRuns: "还没有内部运行。",
          conversationContext: "会话上下文",
          collapseDetails: "会话与运行详情",
          modelLabel: "模型",
          chooseModel: "选择模型",
          chooseModelHint: "搜索模型或 Provider；选择后会保留 Spark 的会话与执行状态。",
          searchModels: "搜索模型或 Provider…",
          noModelsFound: "没有匹配的模型",
          closeModelPicker: "关闭模型选择器",
          clearModelSearch: "清除搜索",
          modelUnavailable: "没有已登录且可用的模型",
          currentModelUnavailable: "当前模型不可用，请先切换模型",
          configureModels: "配置 Provider",
          providerLoginRequired: "登录后可用",
          modelUpdated: "模型已切换，将用于之后发送的消息。",
          modelFailed: "无法切换模型。",
          copyMessage: "复制消息",
          copiedMessage: "已复制",
          jumpToLatest: "回到最新消息",
          multilineHint: "Enter 发送 · Shift+Enter 换行",
          reasoning: "思考过程",
          reasoningStreaming: "正在思考…",
          tool: "工具",
          task: "内部任务",
          approval: "需要确认",
          unknownPart: "暂不支持的会话事件",
          collapse: "收起",
          expand: "展开",
        }
      : {
          newConversation: "New conversation",
          workspaceConversation: "Workspace chat",
          daemonConversation: "Global chat",
          scopeChoiceLabel: "Conversation scope",
          workspaceStartHint: "Start a conversation in the current workspace.",
          daemonStartHint:
            "Talk directly to this Spark daemon without binding the conversation to a workspace.",
          daemonScope: "This Spark daemon",
          scopeLabel: "Scope",
          messageLabel: "Message",
          startPlaceholder: "Tell Spark what you want to accomplish…",
          messagePlaceholder: "Add context, constraints, or steer the work…",
          startSubmit: "Start conversation",
          sendSubmit: "Send",
          sending: "Sending…",
          sent: "",
          sendFailed: "Could not send the message. Try again.",
          startFailed: "Could not start the conversation. Try again.",
          timelineTitle: "Conversation",
          timelineEmpty: "Spark replies and execution progress will appear here after you send a message.",
          you: "You",
          spark: "Spark",
          internalDetails: "Internal run details",
          internalHint: "Spark manages the execution records for this conversation.",
          noInternalRuns: "No internal runs yet.",
          conversationContext: "Conversation context",
          collapseDetails: "Conversation and run details",
          modelLabel: "Model",
          chooseModel: "Choose a model",
          chooseModelHint: "Search models or providers. Spark keeps the current conversation and execution state.",
          searchModels: "Search models or providers…",
          noModelsFound: "No matching models",
          closeModelPicker: "Close model picker",
          clearModelSearch: "Clear search",
          modelUnavailable: "No authenticated model is available",
          currentModelUnavailable: "Current model unavailable — choose another model",
          configureModels: "Configure providers",
          providerLoginRequired: "Available after login",
          modelUpdated: "Model updated. It will be used for future messages.",
          modelFailed: "Could not switch models.",
          copyMessage: "Copy message",
          copiedMessage: "Copied",
          jumpToLatest: "Jump to latest",
          multilineHint: "Enter to send · Shift+Enter for newline",
          reasoning: "Reasoning",
          reasoningStreaming: "Reasoning…",
          tool: "Tool",
          task: "Internal task",
          approval: "Approval required",
          unknownPart: "Unsupported conversation event",
          collapse: "Collapse",
          expand: "Expand",
        },
  );

  let timelineItems = $derived(
    buildSessionTimeline({
      messages: sessionMessages,
      commands: activityCommands,
      reports: activityReports,
      fallbackTimestamp:
        sessionView?.updatedAt ?? selected?.updatedAt ?? new Date(0).toISOString(),
    }),
  );
  let conversationPartLabels = $derived<ConversationPartLabels>({
    reasoning: copy.reasoning,
    reasoningStreaming: copy.reasoningStreaming,
    tool: copy.tool,
    task: copy.task,
    approval: copy.approval,
    unknown: copy.unknownPart,
    collapse: copy.collapse,
    expand: copy.expand,
  });
  let timelineFollowKey = $derived.by(() => {
    const latest = timelineItems.at(-1);
    return latest ? `${latest.id}:${latest.status ?? "done"}:${latest.body.length}` : "empty";
  });
  let latestAnnouncement = $derived.by(() => {
    const latest = timelineItems.findLast((item) => item.actor === "spark");
    if (!latest || latest.status === "running" || latest.status === "streaming") return "";
    const compact = latest.body.trim().replace(/\s+/g, " ");
    return compact.length <= 200 ? compact : `${compact.slice(0, 199)}…`;
  });

  $effect(() => {
    if (!initialFormValuesApplied) {
      startMessage =
        formIntent === "startConversation" ? (formValues?.message ?? "") : startMessage;
      startModel = formValues?.model ?? startModel;
      message = formIntent === "sendMessage" ? (formValues?.message ?? "") : message;
      initialFormValuesApplied = true;
    }

    const defaultModelValue = effectiveModelValue;
    if (!startModel || !availableModels.some((entry) => modelValue(entry.model) === startModel)) {
      startModel = effectiveModelAvailable
        ? defaultModelValue
        : modelValue(availableModels[0]?.model);
    }
  });

  // Follow daemon truth when the effective model changes. Keep this separate from
  // the form-initialization effect so choosing an option does not immediately reset
  // the bound value before the enhanced form can submit it.
  $effect(() => {
    sessionModel = effectiveModelValue;
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
      if (modelFeedbackTimer) clearTimeout(modelFeedbackTimer);
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

  function sessionScopeLabel(session: SessionRecord) {
    const scope = workbenchSessionScope(session);
    if (scope.kind === "workspace") return workspaceLabel(scope.workspaceId);
    if (scope.kind === "daemon") {
      return scope.daemonLabel ? `${copy.daemonScope} · ${scope.daemonLabel}` : copy.daemonScope;
    }
    return messages.unknownWorkspace;
  }

  function sessionIsWorkspaceScoped(session: SessionRecord) {
    return workbenchSessionScope(session).kind === "workspace";
  }

  function sessionTitle(title: string | undefined) {
    const fallback = title || copy.newConversation;
    const infoflow = fallback.match(/^channel infoflow:(group|user):(.+)$/i);
    if (!infoflow) return fallback;
    const scope = infoflow[1] === "group"
      ? isZh ? "如流群聊" : "Infoflow group"
      : isZh ? "如流私聊" : "Infoflow chat";
    return `${scope} · ${infoflow[2]}`;
  }

  function workspaceHref(workspaceId: string | null) {
    if (!workspaceId) return null;
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

  function resultModel(result: unknown) {
    if (!result || typeof result !== "object" || !("data" in result)) return null;
    const data = result.data;
    if (!data || typeof data !== "object" || !("model" in data)) return null;
    return typeof data.model === "string" && data.model.trim() ? data.model : null;
  }

  function buildModelGroups(providers: SparkModelCatalogProvider[]): ModelPickerGroup[] {
    return providers.map((provider) => {
      const available = provider.models.filter((entry) => entry.available);
      return {
        id: provider.providerName,
        label: provider.label,
        description: provider.auth.configured ? undefined : copy.providerLoginRequired,
        options:
          available.length > 0
            ? available.map((entry) => ({
                value: modelValue(entry.model),
                label: entry.model.modelLabel ?? entry.model.modelId,
                description:
                  entry.model.modelLabel && entry.model.modelLabel !== entry.model.modelId
                    ? entry.model.modelId
                    : undefined,
                keywords: [entry.model.modelId, provider.providerName],
              }))
            : [
                {
                  value: `unavailable:${provider.providerName}`,
                  label: `${copy.providerLoginRequired} · ${provider.models.length}`,
                  disabled: true,
                },
              ],
      };
    });
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
        sendFeedback = null;
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
    if (modelFeedbackTimer) clearTimeout(modelFeedbackTimer);
    modelState = "submitting";
    modelFeedback = copy.sending;
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        modelState = "success";
        sessionModel = resultModel(result) ?? sessionModel;
        modelFeedback = copy.modelUpdated;
        modelFeedbackTimer = setTimeout(() => {
          modelFeedback = null;
          modelFeedbackTimer = null;
        }, 3_500);
        await invalidateAll();
        return;
      }
      modelState = "error";
      sessionModel = effectiveModelValue;
      modelFeedback = resultMessage(result, copy.modelFailed);
    };
  };

  function modelValue(model: SparkModelRef | undefined) {
    return model ? `${model.providerName}/${model.modelId}` : "";
  }

  async function submitModelSelection(nextValue: string) {
    sessionModel = nextValue;
    await tick();
    sessionModelForm?.requestSubmit();
  }
</script>

{#snippet sessionDetails(compact = false)}
  {#if selected}
    {@const displayedSessionStatus = visibleSessionStatus(selected.status)}
    <div class:compact-details={compact} class="details-content">
      <dl class="details-grid">
        {#if displayedSessionStatus}
          <div>
            <dt>{messages.statusLabel}</dt>
            <dd><span class="status-pill {displayedSessionStatus}">{statusLabel(displayedSessionStatus)}</span></dd>
          </div>
        {/if}
        <div>
          <dt>{sessionIsWorkspaceScoped(selected) ? messages.workspaceLabel : copy.scopeLabel}</dt>
          <dd>
            {#if selectedWorkspaceHref}
              <a href={selectedWorkspaceHref}>{sessionScopeLabel(selected)}</a>
            {:else}
              {sessionScopeLabel(selected)}
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

      {#if activityCommands.length > 0}
      <details class="run-details">
        <summary>
          <span><Icon name="activity" size={15} />{copy.internalDetails}</span>
          <small>{activityCommands.length}</small>
        </summary>
        <div class="run-details-body">
          <p>{copy.internalHint}</p>
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
        </div>
      </details>
      {/if}

      {#if selected.status !== "archived"}
        <section class="session-management">
          <h3>{messages.managementTitle}</h3>
          {#if !compact}<p class="muted">{messages.archiveBody}</p>{/if}
          <form method="POST" action="?/archiveSession">
            <input type="hidden" name="sessionId" value={selected.sessionId} />
            <Button variant="danger" type="submit">
              <Icon name="archive" size={15} stroke={2.1} />
              <span>{messages.archiveSubmit}</span>
            </Button>
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
        {#if startScope === "workspace" && !activeWorkspace}
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
              <p>{startScope === "daemon" ? copy.daemonStartHint : copy.workspaceStartHint}</p>
            </div>
          </div>

          <form
            method="POST"
            action="?/startConversation"
            class="start-composer"
            aria-busy={startState === "submitting"}
            use:enhance={enhanceStartConversation}
          >
            <input type="hidden" name="scopeKind" value={startScope} />
            {#if startScope === "workspace" && activeWorkspace}
              <input type="hidden" name="workspaceId" value={activeWorkspace.id} />
            {/if}
            <Composer
              id="start-conversation-message"
              rows={5}
              placeholder={copy.startPlaceholder}
              bind:value={startMessage}
              disabled={startState === "submitting"}
              submitDisabled={startState === "submitting" || !startModelReady || !startMessage.trim()}
              submitting={startState === "submitting"}
              submitLabel={copy.startSubmit}
              submittingLabel={copy.sending}
              ariaLabel={copy.messageLabel}
              multilineHint={copy.multilineHint}
              roomy
            >
              {#snippet header()}
                <div class="composer-selects">
                  {#if modelProviders.length > 0}
                    <div class="model-select">
                      <span>{copy.modelLabel}</span>
                      <ModelPicker
                        id="start-conversation-model"
                        name="model"
                        required
                        bind:value={startModel}
                        disabled={availableModels.length === 0}
                        groups={modelGroups}
                        label={copy.modelLabel}
                        title={copy.chooseModel}
                        description={copy.chooseModelHint}
                        placeholder={copy.modelUnavailable}
                        searchPlaceholder={copy.searchModels}
                        emptyLabel={copy.noModelsFound}
                        closeLabel={copy.closeModelPicker}
                        clearSearchLabel={copy.clearModelSearch}
                      />
                    </div>
                    <a class="model-settings-link" href="/settings/models">
                      <Icon name="settings" size={14} />{copy.configureModels}
                    </a>
                  {:else}
                    <a class="model-settings-link" href="/settings/models">
                      <Icon name="settings" size={14} />{copy.configureModels}
                    </a>
                  {/if}
                </div>
              {/snippet}
              {#snippet feedback()}
                {#if startFeedback}
                <p
                  class="form-feedback {startState}"
                  role={startState === "error" ? "alert" : "status"}
                  aria-live="polite"
                >
                  {startFeedback}
                </p>
                {/if}
              {/snippet}
            </Composer>
          </form>
        {/if}
      </div>
    {:else}
      {@const displayedSessionStatus = visibleSessionStatus(selected.status)}
      <header class="stage-header">
        <div class="stage-title">
          <p class="kicker">{copy.timelineTitle}</p>
          <h1>{sessionTitle(selected.title)}</h1>
          <p>{sessionScopeLabel(selected)}</p>
        </div>
        {#if displayedSessionStatus}
          <span class="status-pill {displayedSessionStatus}">{statusLabel(displayedSessionStatus)}</span>
        {/if}
      </header>

      <details class="mobile-details">
        <summary>
          <span><Icon name="activity" size={15} />{copy.collapseDetails}</span>
          <Icon name="chevron-down" size={15} />
        </summary>
        {@render sessionDetails(true)}
      </details>

      <ConversationViewport
        label={copy.timelineTitle}
        followKey={timelineFollowKey}
        announcement={latestAnnouncement}
        jumpToLatestLabel={copy.jumpToLatest}
      >
        {#if timelineItems.length === 0}
          <div class="conversation-empty">
            <span class="spark-mark"><Icon name="spark" size={20} /></span>
            <p>{copy.timelineEmpty}</p>
          </div>
        {:else}
          {#each timelineItems as item (item.id)}
            <ConversationMessage
              {item}
              userLabel={copy.you}
              assistantLabel={copy.spark}
              copyLabel={copy.copyMessage}
              copiedLabel={copy.copiedMessage}
              partLabels={conversationPartLabels}
              relativeTime={relative}
              {statusLabel}
            />
          {/each}
        {/if}
      </ConversationViewport>

      <form
        id="session-model-form"
        bind:this={sessionModelForm}
        method="POST"
        action="?/selectModel"
        use:enhance={enhanceSelectModel}
      ></form>
      <input form="session-model-form" type="hidden" name="sessionId" value={selected.sessionId} />

      <form
        method="POST"
        action="?/sendMessage"
        class="conversation-composer"
        aria-busy={sendState === "submitting"}
        use:enhance={enhanceSendMessage}
      >
        <input type="hidden" name="sessionId" value={selected.sessionId} />
        <Composer
          id="conversation-message"
          rows={3}
          placeholder={copy.messagePlaceholder}
          bind:value={message}
          disabled={!canAssign || sendState === "submitting"}
          submitDisabled={!canAssign || !modelReady || modelState === "submitting" || sendState === "submitting" || !message.trim()}
          submitting={sendState === "submitting"}
          submitLabel={copy.sendSubmit}
          submittingLabel={copy.sending}
          ariaLabel={copy.messageLabel}
          multilineHint={copy.multilineHint}
        >
          {#snippet context()}
            {#if modelProviders.length > 0}
              <ModelPicker
                id="conversation-model"
                form="session-model-form"
                name="model"
                bind:value={sessionModel}
                groups={modelGroups}
                disabled={modelState === "submitting" || availableModels.length === 0}
                label={copy.modelLabel}
                title={copy.chooseModel}
                description={copy.chooseModelHint}
                placeholder={copy.modelUnavailable}
                selectedLabel={!effectiveModelAvailable ? copy.currentModelUnavailable : undefined}
                searchPlaceholder={copy.searchModels}
                emptyLabel={copy.noModelsFound}
                closeLabel={copy.closeModelPicker}
                clearSearchLabel={copy.clearModelSearch}
                compact
                onValueChange={submitModelSelection}
              />
              <a
                class="model-settings-shortcut"
                href="/settings/models"
                aria-label={copy.configureModels}
                title={copy.configureModels}
              >
                <Icon name="settings" size={13} />
              </a>
            {:else}
              <a class="model-settings-link compact" href="/settings/models">
                <Icon name="warning" size={13} />{copy.modelUnavailable}
              </a>
            {/if}
            {#if selected.role}<span>{selected.role}</span>{/if}
          {/snippet}
          {#snippet feedback()}
            {#if sendFeedback}
              <p
                class="form-feedback {sendState}"
                role={sendState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {sendFeedback}
              </p>
            {/if}
            {#if modelFeedback}
              <p class="form-feedback {modelState}" role={modelState === "error" ? "alert" : "status"}>
                {modelFeedback}
              </p>
            {/if}
          {/snippet}
        </Composer>
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
    height: 100%;
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
    margin-bottom: 14px;
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

  .conversation-composer {
    align-self: center;
    flex: 0 0 auto;
    max-width: 800px;
    width: 100%;
  }

  .composer-selects {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .model-select {
    align-items: center;
    display: flex;
    gap: 10px;
    width: fit-content;
  }

  .model-select > span {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
  }

  .model-settings-link,
  .model-settings-shortcut {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
    min-height: 40px;
    padding: 0 8px;
    text-decoration: none;
  }

  .model-settings-shortcut {
    justify-content: center;
    padding: 0;
    width: 40px;
  }

  .model-settings-link.compact {
    color: var(--color-danger);
  }

  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: var(--rounded-md);
    display: inline-flex;
    font-size: 13px;
    font-weight: 600;
    gap: 6px;
    justify-content: center;
    min-height: 40px;
    padding: 0 13px;
    text-decoration: none;
    width: fit-content;
  }

  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: var(--color-on-primary, #fff);
    cursor: pointer;
  }

  .primary-action:hover {
    background: var(--color-primary-hover, #1d4ed8);
  }

  .secondary-action {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  .form-feedback {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.4;
    margin: 0;
    overflow-wrap: anywhere;
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
    min-height: 40px;
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

  .session-management {
    display: grid;
    gap: 9px;
  }

  .session-management h3 {
    color: var(--color-ink);
    font-size: 12px;
    font-weight: 650;
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
      height: 100%;
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

    .mobile-details .details-grid {
      grid-template-columns: 1fr 1fr;
    }

    .model-select {
      align-items: stretch;
      display: grid;
      width: 100%;
    }

  }
</style>
