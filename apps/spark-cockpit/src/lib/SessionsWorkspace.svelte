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
  import ThinkingLevelSlider, {
    THINKING_LEVELS,
  } from "$lib/components/ThinkingLevelSlider.svelte";
  import { visibleSessionStatus } from "$lib/conversation-status";
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import SessionInspector from "$lib/SessionInspector.svelte";
  import { cancelledTurnIdFromActionResult } from "$lib/session-action-result";
  import {
    applySessionLiveEvent,
    beginSessionActivityRefresh,
    canStartSessionActivityRefresh,
    createSessionActivityRefreshState,
    createSessionLiveEventState,
    finishSessionActivityRefresh,
    parseSessionSerializedEvent,
    requestSessionActivityRefresh,
    sessionEventCursorStorageKey,
    sessionViewRevisionKey,
    type SessionLiveEventState,
  } from "$lib/session-live-events";
  import { buildSessionTimeline } from "$lib/session-timeline";
  import { buildSessionWorkbenchView, type SessionInspectorLabels } from "$lib/session-workbench";
  import { formatChannelSessionTitle, sessionHasChannelBinding } from "$lib/channel-session-title";
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
    SparkMessageView,
    SparkSessionView,
  } from "@zendev-lab/spark-protocol";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { onMount, tick, untrack } from "svelte";

  type SessionRecord = {
    sessionId: string;
    workspaceId?: string;
    scope?:
      | { kind: "workspace"; workspaceId: string }
      | { kind: "daemon"; daemonId?: string; daemonLabel?: string };
    title?: string;
    status: string;
    role?: string;
    bindings?: Array<{
      kind: string;
      adapter?: string;
      externalKey?: string;
      boundAt?: string;
    }>;
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
    message?: SparkMessageView;
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
    thinkingLevel?: string;
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
    channelSessionBadge: string;
    channelSessionKicker: string;
    channelBindingLabel: string;
    openChannelSettings: string;
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
  let liveSessionView = $state<SparkSessionView | null>(untrack(() => sessionView));
  let liveEventState = $state<SessionLiveEventState | null>(null);
  let liveSessionId = $state("");
  let lastServerViewKey = $state("");
  let liveConnection = $state<"connecting" | "live" | "reconnecting" | "offline">(
    "connecting",
  );
  let selectedWorkspaceId = $derived(
    selected ? workspaceIdForWorkbenchSession(selected) : null,
  );
  let selectedWorkspaceHref = $derived(workspaceHref(selectedWorkspaceId));
  let selectedIsChannelSession = $derived(selected ? sessionHasChannelBinding(selected) : false);
  let selectedChannelBindings = $derived(
    (selected?.bindings ?? []).filter((binding) => binding.kind === "channel"),
  );
  let selectedChannelsSettingsHref = $derived(channelsSettingsHref(selectedWorkspaceId));
  let activityCommands = $derived(activity?.commands ?? []);
  let activityReports = $derived(activity?.reports ?? []);
  let sessionMessages = $derived(liveSessionView?.messages ?? []);
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
  let effectiveThinkingLevel = $derived(
    modelControl.snapshot.session?.thinkingLevel ?? "medium",
  );
  let thinkingLevels = THINKING_LEVELS;
  let effectiveModelAvailable = $derived(
    Boolean(
      effectiveModelValue &&
        availableModels.some((entry) => modelValue(entry.model) === effectiveModelValue),
    ),
  );
  let modelReady = $derived(modelControl.available && effectiveModelAvailable);
  let startModel = $state("");
  let sessionModel = $state("");
  let startThinkingLevel = $state("medium");
  let sessionThinkingLevel = $state("medium");
  let startMessage = $state("");
  let message = $state("");
  let initialFormValuesApplied = $state(false);
  let startState = $state<SubmissionState>("idle");
  let sendState = $state<SubmissionState>("idle");
  let modelState = $state<SubmissionState>("idle");
  let thinkingState = $state<SubmissionState>("idle");
  let startFeedback = $state<string | null>(null);
  let sendFeedback = $state<string | null>(null);
  let modelFeedback = $state<string | null>(null);
  let thinkingFeedback = $state<string | null>(null);
  let modelFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkingFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let activityRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const activityRefreshState = createSessionActivityRefreshState();
  let sessionModelForm = $state<HTMLFormElement | null>(null);
  let sessionThinkingForm = $state<HTMLFormElement | null>(null);
  let startModelReady = $derived(
    modelControl.available &&
      availableModels.some((entry) => modelValue(entry.model) === startModel),
  );
  let conversationBusy = $derived(
    selected?.status === "running" || liveSessionView?.status === "running",
  );
  let activeTurnId = $derived(liveEventState?.activeTurnId ?? null);
  let cancelState = $state<SubmissionState>("idle");
  let cancelFeedback = $state<string | null>(null);
  let cancelledTurnId = $state<string | null>(null);

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
          queuePlaceholder: "补充说明将排在当前执行之后……",
          startSubmit: "开始对话",
          sendSubmit: "发送",
          queueSubmit: "排队",
          sending: "发送中…",
          sent: "",
          sendFailed: "消息发送失败，请重试。",
          startFailed: "无法开始对话，请重试。",
          timelineTitle: "对话",
          timelineEmpty: "发送第一条消息后，Spark 的回复和执行进度会出现在这里。",
          you: "你",
          spark: "Spark",
          conversationContext: "会话上下文",
          conversationWorkbench: "编码工作台",
          collapseDetails: "会话与运行详情",
          modelLabel: "模型",
          thinkingLabel: "推理",
          chooseModel: "选择模型",
          chooseModelHint: "搜索模型或服务商；选择后会保留 Spark 的会话与执行状态。",
          searchModels: "搜索模型或服务商…",
          noModelsFound: "没有匹配的模型",
          closeModelPicker: "关闭模型选择器",
          clearModelSearch: "清除搜索",
          modelUnavailable: "没有已登录且可用的模型",
          currentModelUnavailable: "当前模型不可用，请先切换模型",
          configureModels: "配置模型服务商",
          providerLoginRequired: "登录后可用",
          modelUpdated: "模型已切换，将用于之后发送的消息。",
          modelFailed: "无法切换模型。",
          thinkingUpdated: "推理强度已更新，将用于之后发送的消息。",
          thinkingFailed: "无法更新推理强度。",
          stop: "停止",
          stopping: "正在停止…",
          stopped: "已请求取消当前执行。",
          stopFailed: "无法停止当前执行，请重试。",
          live: "实时",
          connecting: "连接中",
          reconnecting: "正在重连",
          offline: "离线",
          inspectorAria: "Coding agent 工作台",
          runsTab: "运行",
          changesTab: "变更",
          evidenceTab: "证据",
          mailboxTab: "邮箱",
          contextTab: "上下文",
          runsHeading: "运行",
          tasksHeading: "内部任务",
          changesHeading: "结构化变更",
          evidenceHeading: "证据与产物",
          mailboxHeading: "会话邮箱",
          contextHeading: "执行上下文",
          noRunsTitle: "尚无运行",
          noRunsBody: "发送消息后，Spark 自动创建的运行和内部任务会出现在这里。",
          noChangesTitle: "尚无结构化变更",
          noChangesBody: "当前 runtime 没有提供 canonical diff；这里不会从回复文本推断 Git 变更。",
          noEvidenceTitle: "尚无证据",
          noEvidenceBody: "运行生成报告、产物或验证结果后，会自动归集到这里。",
          noMailboxTitle: "邮箱为空",
          noMailboxBody: "其他会话发送给当前会话的请求和通知会出现在这里。",
          latestOutput: "最近输出",
          progress: "进度",
          mailFrom: "来自",
          mailRequest: "请求",
          mailNotification: "通知",
          mailUnread: "未读",
          mailRead: "已读",
          mailAcknowledged: "已确认",
          sessionId: "会话 ID",
          sessionStatus: "会话状态",
          workingDirectory: "工作目录",
          contextModel: "模型",
          createdAt: "创建时间",
          updatedAt: "更新时间",
          unavailable: "不可用",
          copyMessage: "复制消息",
          copiedMessage: "已复制",
          jumpToLatest: "回到最新消息",
          multilineHint: "Enter 发送 · Shift+Enter 换行",
          reasoning: "思考过程",
          reasoningStreaming: "正在思考…",
          chain: "执行过程",
          chainStreaming: "执行中…",
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
          queuePlaceholder: "This follow-up will run after the current turn…",
          startSubmit: "Start conversation",
          sendSubmit: "Send",
          queueSubmit: "Queue",
          sending: "Sending…",
          sent: "",
          sendFailed: "Could not send the message. Try again.",
          startFailed: "Could not start the conversation. Try again.",
          timelineTitle: "Conversation",
          timelineEmpty: "Spark replies and execution progress will appear here after you send a message.",
          you: "You",
          spark: "Spark",
          conversationContext: "Conversation context",
          conversationWorkbench: "Coding workbench",
          collapseDetails: "Conversation and run details",
          modelLabel: "Model",
          thinkingLabel: "Thinking",
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
          thinkingUpdated: "Thinking level updated. It will be used for future messages.",
          thinkingFailed: "Could not update the thinking level.",
          stop: "Stop",
          stopping: "Stopping…",
          stopped: "Cancellation requested for the active turn.",
          stopFailed: "Could not stop the active turn. Try again.",
          live: "Live",
          connecting: "Connecting",
          reconnecting: "Reconnecting",
          offline: "Offline",
          inspectorAria: "Coding agent workbench",
          runsTab: "Runs",
          changesTab: "Changes",
          evidenceTab: "Evidence",
          mailboxTab: "Mailbox",
          contextTab: "Context",
          runsHeading: "Runs",
          tasksHeading: "Internal tasks",
          changesHeading: "Structured changes",
          evidenceHeading: "Evidence and artifacts",
          mailboxHeading: "Session mailbox",
          contextHeading: "Execution context",
          noRunsTitle: "No runs yet",
          noRunsBody: "Runs and internal tasks created by Spark appear here after you send a message.",
          noChangesTitle: "No structured changes yet",
          noChangesBody:
            "The runtime has not provided a canonical diff. This view never infers Git changes from prose.",
          noEvidenceTitle: "No evidence yet",
          noEvidenceBody: "Reports, artifacts, and verification results are collected here as runs produce them.",
          noMailboxTitle: "Mailbox is empty",
          noMailboxBody: "Requests and notifications sent to this conversation by other sessions appear here.",
          latestOutput: "Latest output",
          progress: "Progress",
          mailFrom: "From",
          mailRequest: "Request",
          mailNotification: "Notification",
          mailUnread: "Unread",
          mailRead: "Read",
          mailAcknowledged: "Acknowledged",
          sessionId: "Session ID",
          sessionStatus: "Session status",
          workingDirectory: "Working directory",
          contextModel: "Model",
          createdAt: "Created",
          updatedAt: "Updated",
          unavailable: "Unavailable",
          copyMessage: "Copy message",
          copiedMessage: "Copied",
          jumpToLatest: "Jump to latest",
          multilineHint: "Enter to send · Shift+Enter for newline",
          reasoning: "Reasoning",
          reasoningStreaming: "Reasoning…",
          chain: "Execution",
          chainStreaming: "Working…",
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
    chain: copy.chain,
    chainStreaming: copy.chainStreaming,
    tool: copy.tool,
    task: copy.task,
    approval: copy.approval,
    unknown: copy.unknownPart,
    collapse: copy.collapse,
    expand: copy.expand,
  });
  let inspectorLabels = $derived<SessionInspectorLabels>({
    ariaLabel: copy.inspectorAria,
    tabs: {
      runs: copy.runsTab,
      changes: copy.changesTab,
      evidence: copy.evidenceTab,
      mailbox: copy.mailboxTab,
      context: copy.contextTab,
    },
    runsHeading: copy.runsHeading,
    tasksHeading: copy.tasksHeading,
    changesHeading: copy.changesHeading,
    evidenceHeading: copy.evidenceHeading,
    mailboxHeading: copy.mailboxHeading,
    contextHeading: copy.contextHeading,
    noRunsTitle: copy.noRunsTitle,
    noRunsBody: copy.noRunsBody,
    noChangesTitle: copy.noChangesTitle,
    noChangesBody: copy.noChangesBody,
    noEvidenceTitle: copy.noEvidenceTitle,
    noEvidenceBody: copy.noEvidenceBody,
    noMailboxTitle: copy.noMailboxTitle,
    noMailboxBody: copy.noMailboxBody,
    latestOutput: copy.latestOutput,
    progress: copy.progress,
    mailFrom: copy.mailFrom,
    mailRequest: copy.mailRequest,
    mailNotification: copy.mailNotification,
    mailUnread: copy.mailUnread,
    mailRead: copy.mailRead,
    mailAcknowledged: copy.mailAcknowledged,
    sessionId: copy.sessionId,
    sessionStatus: copy.sessionStatus,
    workingDirectory: copy.workingDirectory,
    model: copy.contextModel,
    createdAt: copy.createdAt,
    updatedAt: copy.updatedAt,
    unavailable: copy.unavailable,
  });
  let workbenchView = $derived(
    liveSessionView
      ? buildSessionWorkbenchView({ session: liveSessionView, activity })
      : null,
  );
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
    const sessionId = selected?.sessionId ?? "";
    if (!sessionId) {
      liveSessionId = "";
      liveEventState = null;
      liveSessionView = null;
      lastServerViewKey = "";
      return;
    }

    const nextServerViewKey = sessionViewRevisionKey(sessionView);
    if (sessionId !== liveSessionId || nextServerViewKey !== lastServerViewKey) {
      const cursor = sessionId === liveSessionId ? liveEventState?.cursor : null;
      liveSessionId = sessionId;
      lastServerViewKey = nextServerViewKey;
      liveEventState = createSessionLiveEventState({
        sessionId,
        workspaceId: selectedWorkspaceId,
        view: sessionView,
        commandIds: activityCommands.map((command) => command.id),
        invocationIds: activityCommands.flatMap((command) =>
          command.invocationId ? [command.invocationId] : [],
        ),
        cursor,
      });
      liveSessionView = liveEventState.view;
      return;
    }

    for (const command of activityCommands) {
      liveEventState?.commandIds.add(command.id);
      if (command.invocationId) liveEventState?.invocationIds.add(command.invocationId);
    }
  });

  $effect(() => {
    if (activeTurnId && activeTurnId !== cancelledTurnId && cancelState !== "submitting") {
      cancelState = "idle";
      cancelFeedback = null;
    }
  });

  $effect(() => {
    if (!initialFormValuesApplied) {
      startMessage =
        formIntent === "startConversation" ? (formValues?.message ?? "") : startMessage;
      startModel = formValues?.model ?? startModel;
      startThinkingLevel = formValues?.thinkingLevel ?? startThinkingLevel;
      message = formIntent === "sendMessage" ? (formValues?.message ?? "") : message;
      initialFormValuesApplied = true;
    }

    const defaultModelValue = effectiveModelValue;
    if (!startModel || !availableModels.some((entry) => modelValue(entry.model) === startModel)) {
      startModel = effectiveModelAvailable
        ? defaultModelValue
        : modelValue(availableModels[0]?.model);
    }
    if (!(thinkingLevels as readonly string[]).includes(startThinkingLevel)) {
      startThinkingLevel = effectiveThinkingLevel;
    }
  });

  // Follow daemon truth when the effective model changes. Keep this separate from
  // the form-initialization effect so choosing an option does not immediately reset
  // the bound value before the enhanced form can submit it.
  $effect(() => {
    sessionModel = effectiveModelValue;
  });

  $effect(() => {
    sessionThinkingLevel = effectiveThinkingLevel;
  });

  $effect(() => {
    if (formIntent === "startConversation" && formMessage && startState === "idle") {
      startFeedback = formMessage;
    }
    if (formIntent === "sendMessage" && formMessage && sendState === "idle") {
      sendFeedback = formMessage;
    }
    if (formIntent === "cancelTurn" && formMessage && cancelState === "idle") {
      cancelFeedback = formMessage;
    }
  });

  $effect(() => {
    const streamSessionId = liveSessionId;
    const streamState = liveEventState;
    if (!streamSessionId || !streamState || streamState.sessionId !== streamSessionId) {
      liveConnection = "offline";
      return;
    }

    let closed = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    const storageKey = sessionEventCursorStorageKey(streamSessionId);

    if (storageKey && !untrack(() => streamState.cursor)) {
      streamState.cursor = window.sessionStorage.getItem(storageKey);
    }

    const connect = () => {
      if (closed) return;
      if (!navigator.onLine) {
        liveConnection = "offline";
        return;
      }
      const state = untrack(() => liveEventState);
      if (!state || state.sessionId !== streamSessionId) return;
      liveConnection = "connecting";
      const url = new URL("/api/v1/events", window.location.origin);
      if (state.cursor) url.searchParams.set("cursor", state.cursor);
      eventSource = new EventSource(url);
      eventSource.onopen = () => {
        reconnectAttempt = 0;
        liveConnection = "live";
      };
      eventSource.addEventListener("spark-cockpit.event", (message) => {
        const event = parseSessionSerializedEvent(message.data);
        const state = untrack(() => liveEventState);
        if (!event || !state || state.sessionId !== streamSessionId) return;
        const result = applySessionLiveEvent(state, event);
        if (storageKey && state.cursor) {
          window.sessionStorage.setItem(storageKey, state.cursor);
        }
        if (result.changed) liveSessionView = state.view;
        if (result.refreshActivity) scheduleActivityRefresh();
      });
      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        liveConnection = navigator.onLine ? "reconnecting" : "offline";
        if (!closed && navigator.onLine && !reconnectTimer) {
          const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
        }
      };
    };

    const handleOnline = () => {
      if (closed || eventSource) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connect();
    };
    const handleOffline = () => {
      liveConnection = "offline";
      eventSource?.close();
      eventSource = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    connect();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      closed = true;
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  });

  // SSE is the immediate path. While a turn is active, also probe the daemon's
  // lightweight registry status so a dropped terminal projection cannot leave
  // the transcript, stop button, or composer permanently stuck in "running".
  $effect(() => {
    const sessionId = liveSessionId;
    const watchTerminalState = conversationBusy;
    if (!sessionId || !watchTerminalState) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;

    const schedule = (delay = 3_000) => {
      if (stopped || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void probeStatus();
      }, delay);
    };

    const probeStatus = async () => {
      if (stopped || refreshing) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      refreshing = true;
      try {
        const response = await fetch(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const result = (await response.json()) as { sessionId?: unknown; status?: unknown };
        if (
          result.sessionId === sessionId &&
          typeof result.status === "string" &&
          result.status !== "running"
        ) {
          await invalidateAll();
        }
      } finally {
        refreshing = false;
        schedule();
      }
    };

    schedule(1_500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  });

  onMount(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") armActivityRefresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (modelFeedbackTimer) clearTimeout(modelFeedbackTimer);
      if (thinkingFeedbackTimer) clearTimeout(thinkingFeedbackTimer);
      if (activityRefreshTimer) clearTimeout(activityRefreshTimer);
    };
  });

  function scheduleActivityRefresh() {
    requestSessionActivityRefresh(activityRefreshState);
    armActivityRefresh();
  }

  function armActivityRefresh() {
    const canRefresh = Boolean(selected && document.visibilityState !== "hidden");
    if (
      activityRefreshTimer ||
      !canStartSessionActivityRefresh(activityRefreshState, canRefresh)
    ) {
      return;
    }
    activityRefreshTimer = setTimeout(() => {
      activityRefreshTimer = null;
      void refreshActivity();
    }, 180);
  }

  async function refreshActivity() {
    const canRefresh = Boolean(selected && document.visibilityState !== "hidden");
    if (!beginSessionActivityRefresh(activityRefreshState, canRefresh)) return;
    try {
      await invalidateAll();
    } finally {
      finishSessionActivityRefresh(activityRefreshState);
      armActivityRefresh();
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
    return formatChannelSessionTitle(title, {
      locale,
      fallback: copy.newConversation,
    });
  }

  function workspaceHref(workspaceId: string | null) {
    if (!workspaceId) return null;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    return workspace ? workspacePath(workspace) : null;
  }

  function channelsSettingsHref(workspaceId: string | null) {
    if (!workspaceId) return null;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    return workspace ? workspacePath(workspace, "/settings/channels") : null;
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function relative(value: string | null) {
    return formatRelativeTime(value, locale as "en" | "zh-CN", common);
  }

  function connectionLabel() {
    if (liveConnection === "live") return copy.live;
    if (liveConnection === "connecting") return copy.connecting;
    if (liveConnection === "reconnecting") return copy.reconnecting;
    return copy.offline;
  }

  function compactWorkingDirectory(value: string | undefined) {
    const parts = value?.split("/").filter(Boolean) ?? [];
    if (parts.length === 0) return value ?? "";
    return parts.slice(-2).join("/");
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

  const enhanceCancelTurn: SubmitFunction = () => {
    cancelState = "submitting";
    cancelFeedback = copy.stopping;

    return async ({ result, update }) => {
      const confirmedCancelledTurnId = cancelledTurnIdFromActionResult(result);
      await update({ reset: false });

      if (result.type === "success") {
        cancelState = "success";
        cancelledTurnId = confirmedCancelledTurnId;
        cancelFeedback = resultMessage(result, copy.stopped);
        await invalidateAll();
        return;
      }

      if (result.type === "redirect") return;
      cancelState = "error";
      cancelFeedback = resultMessage(result, copy.stopFailed);
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

  const enhanceSelectThinking: SubmitFunction = () => {
    if (thinkingFeedbackTimer) clearTimeout(thinkingFeedbackTimer);
    thinkingState = "submitting";
    thinkingFeedback = copy.sending;
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        thinkingState = "success";
        const next =
          result.data && typeof result.data === "object" && "thinkingLevel" in result.data
            ? String((result.data as { thinkingLevel?: unknown }).thinkingLevel ?? "")
            : "";
        sessionThinkingLevel = next || sessionThinkingLevel;
        thinkingFeedback = copy.thinkingUpdated;
        thinkingFeedbackTimer = setTimeout(() => {
          thinkingFeedback = null;
          thinkingFeedbackTimer = null;
        }, 3_500);
        await invalidateAll();
        return;
      }
      thinkingState = "error";
      sessionThinkingLevel = effectiveThinkingLevel;
      thinkingFeedback = resultMessage(result, copy.thinkingFailed);
    };
  };

  async function submitThinkingSelection() {
    await tick();
    sessionThinkingForm?.requestSubmit();
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
        {#if selectedIsChannelSession}
          <div>
            <dt>{messages.channelSessionBadge}</dt>
            <dd>
              <span class="channel-badge">{messages.channelSessionKicker}</span>
            </dd>
          </div>
          {#if selectedChannelBindings.length > 0}
            <div>
              <dt>{messages.channelBindingLabel}</dt>
              <dd class="channel-bindings">
                {#each selectedChannelBindings as binding (binding.externalKey ?? binding.adapter)}
                  <code>{binding.externalKey ?? binding.adapter}</code>
                {/each}
              </dd>
            </div>
          {/if}
          {#if selectedChannelsSettingsHref}
            <div class="channel-settings-row">
              <a class="channel-settings-link" href={selectedChannelsSettingsHref}>
                <Icon name="settings" size={14} />
                {messages.openChannelSettings}
              </a>
              <p class="muted">{messages.channelRoutingBody}</p>
            </div>
          {/if}
        {/if}
      </dl>

      {#if workbenchView}
        <SessionInspector
          view={workbenchView}
          labels={inspectorLabels}
          instanceId={compact ? "session-inspector-mobile" : "session-inspector-desktop"}
          {statusLabel}
        />
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
                        settingsHref="/settings/models"
                        settingsLabel={copy.configureModels}
                      />
                    </div>
                    <ThinkingLevelSlider
                      bind:value={startThinkingLevel}
                      name="thinkingLevel"
                      label={copy.thinkingLabel}
                    />
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
          <p class="kicker">
            {selectedIsChannelSession ? messages.channelSessionKicker : copy.timelineTitle}
          </p>
          <h1>
            <span class="session-heading-title">{sessionTitle(selected.title)}</span>
            {#if selectedIsChannelSession}
              <span class="channel-badge">{messages.channelSessionBadge}</span>
            {/if}
          </h1>
          <p>{sessionScopeLabel(selected)}</p>
        </div>
        <div class="stage-actions">
          {#if liveSessionView?.cwd}
            <span class="context-chip" title={liveSessionView.cwd}>
              <Icon name="folder" size={13} />
              {compactWorkingDirectory(liveSessionView.cwd)}
            </span>
          {/if}
          {#if selected.role}<span class="context-chip">{selected.role}</span>{/if}
          <span class="connection-state {liveConnection}" title={connectionLabel()}>
            <span aria-hidden="true"></span>
            {connectionLabel()}
          </span>
          {#if conversationBusy && activeTurnId}
            <form method="POST" action="?/cancelTurn" use:enhance={enhanceCancelTurn}>
              <input type="hidden" name="sessionId" value={selected.sessionId} />
              <input type="hidden" name="turnId" value={activeTurnId} />
              <Button
                variant="danger"
                size="compact"
                type="submit"
                disabled={cancelState === "submitting" || cancelState === "success"}
              >
                <Icon name="close" size={14} stroke={2.2} />
                <span>{cancelState === "submitting" ? copy.stopping : copy.stop}</span>
              </Button>
            </form>
          {/if}
          {#if displayedSessionStatus}
            <span class="status-pill {displayedSessionStatus}">{statusLabel(displayedSessionStatus)}</span>
          {/if}
        </div>
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
        id="session-thinking-form"
        bind:this={sessionThinkingForm}
        method="POST"
        action="?/selectThinking"
        use:enhance={enhanceSelectThinking}
      ></form>
      <input
        form="session-thinking-form"
        type="hidden"
        name="sessionId"
        value={selected.sessionId}
      />

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
          placeholder={conversationBusy ? copy.queuePlaceholder : copy.messagePlaceholder}
          bind:value={message}
          disabled={!canAssign || sendState === "submitting"}
          submitDisabled={!canAssign || !modelReady || modelState === "submitting" || thinkingState === "submitting" || sendState === "submitting" || !message.trim()}
          submitting={sendState === "submitting"}
          submitLabel={conversationBusy ? copy.queueSubmit : copy.sendSubmit}
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
                settingsHref="/settings/models"
                settingsLabel={copy.configureModels}
                onValueChange={submitModelSelection}
              />
              <ThinkingLevelSlider
                bind:value={sessionThinkingLevel}
                name="thinkingLevel"
                form="session-thinking-form"
                label={copy.thinkingLabel}
                compact
                disabled={thinkingState === "submitting"}
                onValueCommit={() => void submitThinkingSelection()}
              />
            {:else}
              <a class="model-settings-link compact" href="/settings/models">
                <Icon name="warning" size={13} />{copy.modelUnavailable}
              </a>
            {/if}
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
            {#if cancelFeedback}
              <p
                class="form-feedback {cancelState}"
                role={cancelState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {cancelFeedback}
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
        <h2>{copy.conversationWorkbench}</h2>
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
    grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
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

  .stage-actions {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .connection-state {
    align-items: center;
    color: var(--color-ink-subtle);
    display: inline-flex;
    font-size: 10px;
    font-weight: 650;
    gap: 6px;
    min-height: 32px;
    white-space: nowrap;
  }

  .connection-state > span {
    background: var(--color-ink-disabled);
    border-radius: 999px;
    height: 7px;
    width: 7px;
  }

  .connection-state.live > span {
    background: var(--color-success);
  }

  .connection-state.connecting > span,
  .connection-state.reconnecting > span {
    background: var(--color-warning);
  }

  .connection-state.offline > span {
    background: var(--color-danger);
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
    align-items: center;
    display: inline-flex;
    gap: 8px;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
  }

  .session-heading-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .channel-badge {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    border-radius: 999px;
    color: var(--color-primary);
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
    padding: 5px 8px;
    text-transform: none;
    white-space: nowrap;
  }

  .channel-settings-link {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md, 8px);
    color: var(--color-ink);
    display: inline-flex;
    font-size: 12px;
    font-weight: 650;
    gap: 5px;
    padding: 6px 10px;
    text-decoration: none;
    white-space: nowrap;
  }

  .channel-settings-link:hover {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .channel-bindings {
    display: grid;
    gap: 4px;
  }

  .channel-bindings code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
  }

  .channel-settings-row {
    display: grid;
    gap: 6px;
    grid-column: 1 / -1;
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
    min-width: 0;
    width: 100%;
  }

  .context-chip {
    align-items: center;
    color: var(--color-ink-subtle);
    display: inline-flex;
    flex: 0 1 auto;
    font-size: 11px;
    gap: 5px;
    max-width: min(220px, 100%);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stage-actions .context-chip {
    max-width: min(260px, 36vw);
  }

  .conversation-composer :global([data-model-picker-trigger]) {
    flex: 1 1 10rem;
    max-width: min(320px, 100%);
    min-width: 0;
  }

  .composer-selects {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    width: 100%;
  }

  .model-select {
    align-items: center;
    display: flex;
    flex: 1 1 auto;
    gap: 10px;
    min-width: 0;
  }

  .model-select > span {
    color: var(--color-ink-subtle);
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .model-select :global([data-model-picker-trigger]) {
    flex: 1 1 auto;
    max-width: 360px;
    min-width: min(220px, 100%);
  }

  .sr-only {
    border: 0;
    clip: rect(0, 0, 0, 0);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .model-settings-link {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
    min-height: 40px;
    padding: 0 10px;
    text-decoration: none;
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

  .mobile-details summary::-webkit-details-marker {
    display: none;
  }

  .mobile-details summary > span {
    align-items: center;
    display: inline-flex;
    gap: 7px;
  }

  .muted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.5;
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
      flex: 1 1 100%;
      gap: 6px;
      width: 100%;
    }

    .model-select :global([data-model-picker-trigger]) {
      max-width: none;
      min-width: 0;
      width: 100%;
    }

  }
</style>
