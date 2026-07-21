import { randomUUID } from "node:crypto";

export const LEASE_TRANSFER_TIMEOUT_MS = 30_000;

export type LeaseTransferDecision = "accept" | "reject" | "auto-authorize";
export type LeaseTransferResponseSource = "cockpit" | "tui" | "cli" | "timeout" | "unknown";

export interface LeaseTransferRequest {
  transferId: string;
  workspaceId: string;
  workspaceDisplayName: string;
  previousServerUrl: string;
  targetServerUrl: string;
  humanRequestId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface LeaseTransferSettlement {
  transferId: string;
  decision: LeaseTransferDecision;
  source: LeaseTransferResponseSource;
  settledAt: string;
}

interface PendingTransfer {
  request: LeaseTransferRequest;
  resolve: (settlement: LeaseTransferSettlement) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Daemon-brokered origin-lease transfer consent.
 * One wait per transfer; any occupying surface may accept/reject; silence auto-authorizes.
 */
export class SparkDaemonLeaseTransferBroker {
  private readonly pending = new Map<string, PendingTransfer>();
  private readonly byWorkspace = new Map<string, string>();

  request(input: {
    workspaceId: string;
    workspaceDisplayName: string;
    previousServerUrl: string;
    targetServerUrl: string;
    humanRequestId?: string;
    timeoutMs?: number;
    now?: string;
  }): { request: LeaseTransferRequest; settlement: Promise<LeaseTransferSettlement> } {
    const existingId = this.byWorkspace.get(input.workspaceId);
    if (existingId) {
      const existing = this.pending.get(existingId);
      if (existing) {
        return {
          request: existing.request,
          settlement: new Promise((resolve) => {
            const previous = existing.resolve;
            existing.resolve = (settlement) => {
              previous(settlement);
              resolve(settlement);
            };
          }),
        };
      }
    }

    const now = input.now ?? new Date().toISOString();
    const timeoutMs = input.timeoutMs ?? LEASE_TRANSFER_TIMEOUT_MS;
    const transferId = `xfer_${randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(Date.parse(now) + timeoutMs).toISOString();
    const request: LeaseTransferRequest = {
      transferId,
      workspaceId: input.workspaceId,
      workspaceDisplayName: input.workspaceDisplayName,
      previousServerUrl: input.previousServerUrl,
      targetServerUrl: input.targetServerUrl,
      ...(input.humanRequestId ? { humanRequestId: input.humanRequestId } : {}),
      createdAt: now,
      expiresAt,
    };

    let resolve!: (settlement: LeaseTransferSettlement) => void;
    const settlement = new Promise<LeaseTransferSettlement>((done) => {
      resolve = done;
    });

    const pending: PendingTransfer = { request, resolve };
    this.pending.set(transferId, pending);
    this.byWorkspace.set(input.workspaceId, transferId);

    pending.timer = setTimeout(() => {
      this.settle(transferId, "auto-authorize", "timeout");
    }, timeoutMs);
    if (typeof pending.timer.unref === "function") {
      pending.timer.unref();
    }

    return { request, settlement };
  }

  respond(
    transferId: string,
    decision: "accept" | "reject",
    source: LeaseTransferResponseSource = "unknown",
  ): LeaseTransferSettlement | null {
    return this.settle(transferId, decision, source);
  }

  respondByHumanRequest(
    humanRequestId: string,
    decision: "accept" | "reject",
    source: LeaseTransferResponseSource = "cockpit",
  ): LeaseTransferSettlement | null {
    for (const pending of this.pending.values()) {
      if (pending.request.humanRequestId === humanRequestId) {
        return this.settle(pending.request.transferId, decision, source);
      }
    }
    return null;
  }

  get(transferId: string): LeaseTransferRequest | null {
    return this.pending.get(transferId)?.request ?? null;
  }

  pendingForWorkspace(workspaceId: string): LeaseTransferRequest | null {
    const transferId = this.byWorkspace.get(workspaceId);
    return transferId ? (this.pending.get(transferId)?.request ?? null) : null;
  }

  listPending(): LeaseTransferRequest[] {
    return [...this.pending.values()].map((item) => item.request);
  }

  private settle(
    transferId: string,
    decision: LeaseTransferDecision,
    source: LeaseTransferResponseSource,
  ): LeaseTransferSettlement | null {
    const pending = this.pending.get(transferId);
    if (!pending) return null;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(transferId);
    if (this.byWorkspace.get(pending.request.workspaceId) === transferId) {
      this.byWorkspace.delete(pending.request.workspaceId);
    }
    const settlement: LeaseTransferSettlement = {
      transferId,
      decision,
      source,
      settledAt: new Date().toISOString(),
    };
    pending.resolve(settlement);
    return settlement;
  }
}

export function leaseTransferDecisionFromAnswers(
  status: "answered" | "cancelled",
  answers: Record<string, unknown>,
): "accept" | "reject" {
  if (status === "cancelled") return "reject";
  const decision = answers.decision ?? answers.value ?? answers.choice;
  if (typeof decision === "string") {
    const normalized = decision.trim().toLowerCase();
    if (normalized === "accept" || normalized === "transfer" || normalized === "yes") {
      return "accept";
    }
    if (normalized === "reject" || normalized === "deny" || normalized === "no") {
      return "reject";
    }
  }
  if (Array.isArray(decision) && typeof decision[0] === "string") {
    return leaseTransferDecisionFromAnswers("answered", { decision: decision[0] });
  }
  return "reject";
}
