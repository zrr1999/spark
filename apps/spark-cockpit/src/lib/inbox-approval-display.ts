export interface InboxApprovalDisplayState {
  status: string;
  requestStatus: string;
  questions: readonly unknown[];
  approval: {
    kind: string;
    actionable: boolean;
  };
}

export function canActOnInboxApproval(item: InboxApprovalDisplayState): boolean {
  return item.status === "pending" && item.requestStatus === "pending";
}

export function canQuickDecideInboxApproval(item: InboxApprovalDisplayState): boolean {
  return (
    canActOnInboxApproval(item) &&
    item.approval.actionable &&
    (item.approval.kind !== "ask" || item.questions.length === 0)
  );
}
