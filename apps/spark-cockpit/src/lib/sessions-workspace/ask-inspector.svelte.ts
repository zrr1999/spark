import type { SparkActionBarView } from "@zendev-lab/spark-protocol";
import type { SessionInspectorLabels } from "$lib/session-workbench";
import type { SessionsWorkbenchCopy } from "./types";

/** Build inspector copy labels from workbench i18n. */
export function buildInspectorLabels(copy: SessionsWorkbenchCopy): SessionInspectorLabels {
  return {
    ariaLabel: copy.inspectorAria,
    tabs: {
      summary: copy.summaryTab,
      artifacts: copy.artifactsTab,
      changes: copy.changesTab,
      tasks: copy.tasksTab,
      messages: copy.messagesTab,
    },
    summaryHeading: copy.summaryHeading,
    artifactsHeading: copy.artifactsHeading,
    tasksHeading: copy.tasksHeading,
    changesHeading: copy.changesHeading,
    messagesHeading: copy.messagesHeading,
    noTasksTitle: copy.noTasksTitle,
    noTasksBody: copy.noTasksBody,
    noArtifactsTitle: copy.noArtifactsTitle,
    noArtifactsBody: copy.noArtifactsBody,
    noChangesTitle: copy.noChangesTitle,
    noChangesBody: copy.noChangesBody,
    noMessagesTitle: copy.noMessagesTitle,
    noMessagesBody: copy.noMessagesBody,
    noSessionTodoTitle: copy.noSessionTodoTitle,
    noSessionTodoBody: copy.noSessionTodoBody,
    noActiveSessionTodo: copy.noActiveSessionTodo,
    unassignedProject: copy.unassignedProject,
    progress: copy.progress,
    todoList: copy.todoList,
    sessionTodoHeading: copy.sessionTodoHeading,
    openSessionTodo: copy.openSessionTodo,
    sessionTodoPending: copy.sessionTodoPending,
    sessionTodoInProgress: copy.sessionTodoInProgress,
    messageFrom: copy.messageFrom,
    messageRequest: copy.messageRequest,
    messageQuestion: copy.messageQuestion,
    messageNotification: copy.messageNotification,
    messageUnread: copy.messageUnread,
    messageRead: copy.messageRead,
    messageAcknowledged: copy.messageAcknowledged,
    messageDeliveryPending: copy.messageDeliveryPending,
    messageDeliveryDelivered: copy.messageDeliveryDelivered,
    messageDeliveryFailed: copy.messageDeliveryFailed,
    messageDeliveryUncertain: copy.messageDeliveryUncertain,
    sessionId: copy.sessionId,
    sessionStatus: copy.sessionStatus,
    workingDirectory: copy.workingDirectory,
    model: copy.contextModel,
    createdAt: copy.createdAt,
    updatedAt: copy.updatedAt,
    unavailable: copy.unavailable,
  };
}

/** Normalize slash action bar view typing for start/session composers. */
export type ComposerSlashActionBar = SparkActionBarView | undefined;
