export type CommandDeliveryDisplayCommand = {
  deliveryStatus: string | null;
  attemptCount: number | null;
  lastAttemptAt: string | null;
  ackedAt: string | null;
  rejectCode: string | null;
  rejectMessage: string | null;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  runtimeStatus: string | null;
};

export type CommandDeliveryDisplayMessages = {
  pendingAwaitingHeartbeat: string;
  pendingOnline: string;
  pendingOffline: string;
  sent: string;
  acked: string;
  rejected: string;
  failed: string;
  cancelled: string;
  none: string;
  notAttempted: string;
  awaitingHeartbeat: string;
  attemptSingular: string;
  attemptPlural: string;
  ackedPrefix: string;
  sentPrefix: string;
};

export function commandDeliveryHeadline(
  command: CommandDeliveryDisplayCommand,
  messages: CommandDeliveryDisplayMessages,
) {
  switch (command.deliveryStatus) {
    case "pending":
      return (command.attemptCount ?? 0) > 0
        ? command.runtimeStatus === "online"
          ? messages.pendingOnline
          : messages.pendingOffline
        : messages.pendingAwaitingHeartbeat;
    case "sent":
      return messages.sent;
    case "acked":
      return messages.acked;
    case "rejected":
      return messages.rejected;
    case "failed":
      return messages.failed;
    case "cancelled":
      return messages.cancelled;
    default:
      return messages.none;
  }
}

export function commandDeliveryDetail(
  command: CommandDeliveryDisplayCommand,
  messages: CommandDeliveryDisplayMessages,
  formatRelative: (value: string | null) => string,
) {
  const target = [command.runtimeWorkspaceName, command.runtimeName].filter(Boolean).join(" · ");
  const attempts = deliveryAttemptText(command, messages);

  if (command.deliveryStatus === "rejected") {
    return [target, command.rejectCode, command.rejectMessage].filter(Boolean).join(" · ");
  }
  if (command.deliveryStatus === "acked") {
    return [
      target,
      command.ackedAt ? `${messages.ackedPrefix} ${formatRelative(command.ackedAt)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (command.deliveryStatus === "sent") {
    return [
      target,
      attempts,
      command.lastAttemptAt
        ? `${messages.sentPrefix} ${formatRelative(command.lastAttemptAt)}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return [target, attempts].filter(Boolean).join(" · ");
}

function deliveryAttemptText(
  command: CommandDeliveryDisplayCommand,
  messages: CommandDeliveryDisplayMessages,
) {
  const attemptCount = command.attemptCount ?? 0;
  if (attemptCount > 0) {
    return `${attemptCount} ${
      attemptCount === 1 ? messages.attemptSingular : messages.attemptPlural
    }`;
  }
  return command.deliveryStatus === "pending" ? messages.awaitingHeartbeat : messages.notAttempted;
}
