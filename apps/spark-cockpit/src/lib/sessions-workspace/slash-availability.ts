import type { SlashActionAvailability } from "$lib/components/conversation/index";
import type { SparkActionView } from "@zendev-lab/spark-protocol";
import type { ComposerSurface, SessionsWorkbenchCopy, SubmissionState } from "./types";

export type SlashAvailabilityContext = {
  surface: ComposerSurface;
  hasSelectedSession: boolean;
  canAssign: boolean;
  sessionsCount: number;
  hasActiveWorkspace: boolean;
  modelProvidersCount: number;
  modelState: SubmissionState;
  thinkingState: SubmissionState;
  queueItemCount: number;
  conversationBusy: boolean;
  hasActiveTurn: boolean;
  cancelState: SubmissionState;
  hasRetryPrompt: boolean;
  modelReady: boolean;
  retryState: SubmissionState;
  reasons: SessionsWorkbenchCopy["slashActions"]["reasons"];
};

function unavailable(reason: string): SlashActionAvailability {
  return { enabled: false, reason };
}

export function slashActionAvailability(
  action: SparkActionView,
  ctx: SlashAvailabilityContext,
): SlashActionAvailability {
  const hasSelectedSession = ctx.surface === "session" && ctx.hasSelectedSession;

  switch (action.intent) {
    case "model.select":
      if (!ctx.canAssign) return unavailable(ctx.reasons.ownerOffline);
      if (ctx.modelProvidersCount === 0) return unavailable(ctx.reasons.noModel);
      if (ctx.surface === "session" && ctx.modelState === "submitting") {
        return unavailable(ctx.reasons.modelUpdating);
      }
      return { enabled: true };
    case "thinking.select":
      if (!ctx.canAssign) return unavailable(ctx.reasons.ownerOffline);
      if (ctx.modelProvidersCount === 0) return unavailable(ctx.reasons.noModel);
      if (ctx.surface === "session" && ctx.thinkingState === "submitting") {
        return unavailable(ctx.reasons.thinkingUpdating);
      }
      return { enabled: true };
    case "settings.inspect":
    case "settings.providers":
      return { enabled: true };
    case "status.inspect":
    case "session.inspect":
      return hasSelectedSession ? { enabled: true } : unavailable(ctx.reasons.sessionRequired);
    case "session.select":
      return ctx.sessionsCount > 0 ? { enabled: true } : unavailable(ctx.reasons.noSessions);
    case "session.create":
      if (!ctx.hasActiveWorkspace) return unavailable(ctx.reasons.workspaceRequired);
      return ctx.canAssign ? { enabled: true } : unavailable(ctx.reasons.ownerOffline);
    case "queue.inspect":
      if (!hasSelectedSession) return unavailable(ctx.reasons.sessionRequired);
      return ctx.queueItemCount > 0 ? { enabled: true } : unavailable(ctx.reasons.queueEmpty);
    case "turn.stop":
      if (!hasSelectedSession) return unavailable(ctx.reasons.sessionRequired);
      return ctx.conversationBusy && ctx.hasActiveTurn && ctx.cancelState !== "submitting"
        ? { enabled: true }
        : unavailable(ctx.reasons.noActiveTurn);
    case "turn.retry":
      if (!hasSelectedSession) return unavailable(ctx.reasons.sessionRequired);
      if (!ctx.canAssign) return unavailable(ctx.reasons.ownerOffline);
      if (!ctx.hasRetryPrompt) return unavailable(ctx.reasons.retryUnavailable);
      if (!ctx.modelReady) return unavailable(ctx.reasons.noModel);
      return ctx.retryState === "submitting"
        ? unavailable(ctx.reasons.retryInProgress)
        : { enabled: true };
    case "help.commands":
      return { enabled: true };
    case "help.hotkeys":
      return unavailable(ctx.reasons.hotkeysUnavailable);
    default:
      return unavailable(ctx.reasons.daemonExecutorUnavailable);
  }
}
