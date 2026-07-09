import { describe, expect, it } from "vitest";
import {
  buildApprovalDecisionPayload,
  buildApprovalDeliveryCommandPayload,
  describeApprovalCenterItem,
  type ApprovalDecision,
} from "./approval-center";

describe("approval center helpers", () => {
  it("classifies ask blockers", () => {
    const approval = describeApprovalCenterItem({
      requestKind: "ask_user",
      title: "Choose database",
      prompt: "Which database should Spark use?",
      context: {},
    });

    expect(approval.kind).toBe("ask");
    expect(approval.approveLabel).toContain("Answer");
    expect(approval.actionable).toBe(true);
  });

  it("classifies workflow risk approvals and preserves risk summaries", () => {
    const approval = describeApprovalCenterItem({
      requestKind: "approval",
      title: "Approve generated workflow",
      prompt: "Approve fan-out?",
      context: {
        approvalKind: "workflow-risk",
        risks: ["fan-out=6", "write access requested"],
        tokenBudget: 120000,
        graftBase: "HEAD",
      },
    });

    expect(approval.kind).toBe("workflow_risk");
    expect(approval.riskSummary).toEqual([
      "fan-out=6",
      "write access requested",
      "budget: 120000",
      "base: HEAD",
    ]);
  });

  it("classifies goal reviewer gates", () => {
    const approval = describeApprovalCenterItem({
      requestKind: "review",
      title: "Goal completion reviewer gate",
      prompt: "Approve completion?",
      context: { reviewer: "goal", verdict: "pending" },
    });

    expect(approval.kind).toBe("goal_review");
  });

  it("builds auditable approve/reject delivery commands for all approval kinds", () => {
    const cases = [
      {
        name: "ask",
        input: {
          requestKind: "ask_user",
          title: "Choose database",
          prompt: "Which database should Spark use?",
          context: {},
        },
        kind: "ask",
      },
      {
        name: "workflow-risk",
        input: {
          requestKind: "approval",
          title: "Approve generated workflow",
          prompt: "Approve fan-out?",
          context: { approvalKind: "workflow-risk", risks: ["fan-out=6"] },
        },
        kind: "workflow_risk",
      },
      {
        name: "goal-review",
        input: {
          requestKind: "review",
          title: "Goal completion reviewer gate",
          prompt: "Approve completion?",
          context: { reviewer: "goal", verdict: "pending" },
        },
        kind: "goal_review",
      },
    ] as const;
    const decisions: ApprovalDecision[] = ["approve", "reject"];

    for (const testCase of cases) {
      const approval = describeApprovalCenterItem(testCase.input);
      expect(approval.kind).toBe(testCase.kind);
      for (const decision of decisions) {
        const response = buildApprovalDecisionPayload({
          approval,
          decision,
          operatorNote: decision === "reject" ? `${testCase.name} blocked` : undefined,
        });
        const command = buildApprovalDeliveryCommandPayload({
          approval,
          decision,
          humanRequestId: `hreq-${testCase.name}`,
          humanResponseId: `hres-${testCase.name}-${decision}`,
          runtimeRequestId: `runtime-${testCase.name}`,
          response,
        });

        expect(response).toMatchObject({
          status: "answered",
          answers: {
            decision,
            approved: decision === "approve",
            approvalKind: testCase.kind,
          },
        });
        expect(command).toMatchObject({
          kind: "human.response.deliver.request",
          title: `${approval.title}: ${decision}`,
          payload: {
            humanRequestId: `hreq-${testCase.name}`,
            humanResponseId: `hres-${testCase.name}-${decision}`,
            runtimeRequestId: `runtime-${testCase.name}`,
            approval: { kind: testCase.kind },
            response: { answers: { decision, approved: decision === "approve" } },
          },
        });
      }
    }
  });
});
