import {
  sparkProtocolJsonObjectSchema,
  type HumanResponseDeliverPayload,
  type ServerCommandPayload,
} from "@zendev-lab/spark-protocol";

export type ApprovalCenterKind = "ask" | "workflow_risk" | "goal_review" | "approval";
export type ApprovalDecision = "approve" | "reject";

export interface ApprovalCenterInput {
  requestKind: string;
  title: string;
  prompt: string;
  context: Record<string, unknown>;
}

export interface ApprovalCenterDescriptor {
  kind: ApprovalCenterKind;
  title: string;
  summary: string;
  riskSummary: string[];
  approveLabel: string;
  rejectLabel: string;
  actionable: boolean;
}

export function describeApprovalCenterItem(input: ApprovalCenterInput): ApprovalCenterDescriptor {
  const kind = classifyApprovalCenterKind(input);
  const riskSummary = riskSummaryFromContext(input.context);
  return {
    kind,
    title: titleForKind(kind),
    summary: summaryForKind(kind, input),
    riskSummary,
    approveLabel: kind === "ask" ? "Answer / approve" : "Approve",
    rejectLabel: kind === "ask" ? "Cancel / reject" : "Reject",
    actionable: ["ask_user", "approval", "blocker", "review"].includes(input.requestKind),
  };
}

export function buildApprovalDecisionPayload(input: {
  approval: ApprovalCenterDescriptor;
  decision: ApprovalDecision;
  operatorNote?: string;
}): HumanResponseDeliverPayload {
  const approved = input.decision === "approve";
  return {
    status: "answered",
    answers: {
      decision: input.decision,
      approved,
      approvalKind: input.approval.kind,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    },
    responseArtifactRefs: [],
  };
}

export function buildApprovalDeliveryCommandPayload(input: {
  approval: ApprovalCenterDescriptor;
  decision: ApprovalDecision;
  humanRequestId: string;
  humanResponseId: string;
  runtimeRequestId: string;
  response: HumanResponseDeliverPayload;
}): ServerCommandPayload {
  return {
    kind: "human.response.deliver.request",
    title: `${input.approval.title}: ${input.decision}`,
    payload: sparkProtocolJsonObjectSchema.parse({
      humanRequestId: input.humanRequestId,
      humanResponseId: input.humanResponseId,
      runtimeRequestId: input.runtimeRequestId,
      approval: input.approval,
      response: input.response,
    }),
  };
}

function classifyApprovalCenterKind(input: ApprovalCenterInput): ApprovalCenterKind {
  const explicit = stringField(input.context, "approvalKind") ?? stringField(input.context, "kind");
  if (explicit && /workflow|risk|fan.?out|budget|write|tool/iu.test(explicit)) {
    return "workflow_risk";
  }
  if (explicit && /goal|review|gate|verdict/iu.test(explicit)) return "goal_review";
  if (input.requestKind === "ask_user") return "ask";
  const haystack = `${input.requestKind} ${input.title} ${input.prompt} ${JSON.stringify(input.context)}`;
  if (/workflow|fan.?out|token budget|write permission|graft base|risk/iu.test(haystack)) {
    return "workflow_risk";
  }
  if (/goal|reviewer|review gate|completion gate|verdict/iu.test(haystack)) {
    return "goal_review";
  }
  return "approval";
}

function riskSummaryFromContext(context: Record<string, unknown>): string[] {
  const summary = [
    stringField(context, "riskSummary"),
    stringField(context, "summary"),
    stringField(context, "approvalSummary"),
  ].filter((value): value is string => Boolean(value));
  const risks = arrayOfStrings(context.risks) ?? arrayOfStrings(context.riskSummaryItems);
  const budget = stringField(context, "tokenBudget") ?? stringField(context, "budget");
  const fanOut = stringField(context, "fanOut") ?? stringField(context, "maxAgents");
  const base = stringField(context, "base") ?? stringField(context, "graftBase");
  return [
    ...summary,
    ...(risks ?? []),
    ...(budget ? [`budget: ${budget}`] : []),
    ...(fanOut ? [`fan-out: ${fanOut}`] : []),
    ...(base ? [`base: ${base}`] : []),
  ];
}

function titleForKind(kind: ApprovalCenterKind): string {
  switch (kind) {
    case "ask":
      return "Ask blocker";
    case "workflow_risk":
      return "Workflow risk approval";
    case "goal_review":
      return "Goal reviewer gate";
    case "approval":
      return "Approval request";
  }
}

function summaryForKind(kind: ApprovalCenterKind, input: ApprovalCenterInput): string {
  switch (kind) {
    case "ask":
      return "Spark is blocked until an operator answers or cancels this ask.";
    case "workflow_risk":
      return "Review the workflow risk summary, then approve or reject delivery to the daemon.";
    case "goal_review":
      return "Review the goal completion gate before allowing Spark to continue.";
    case "approval":
      return input.prompt;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}
