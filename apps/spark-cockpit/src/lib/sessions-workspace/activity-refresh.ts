import {
  beginSessionActivityRefresh,
  canStartSessionActivityRefresh,
  createSessionActivityRefreshState,
  finishSessionActivityRefresh,
  requestSessionActivityRefresh,
} from "$lib/session-live-events";

export type ActivityRefreshController = {
  scheduleActivityRefresh: () => void;
  dispose: () => void;
  onVisibilityChange: () => void;
};

export function createActivityRefreshController(deps: {
  canRefresh: () => boolean;
  invalidateAll: () => Promise<void>;
}): ActivityRefreshController {
  let activityRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const activityRefreshState = createSessionActivityRefreshState();

  function armActivityRefresh() {
    if (
      activityRefreshTimer ||
      !canStartSessionActivityRefresh(activityRefreshState, deps.canRefresh())
    ) {
      return;
    }
    activityRefreshTimer = setTimeout(() => {
      activityRefreshTimer = null;
      void refreshActivity();
    }, 180);
  }

  async function refreshActivity() {
    if (!beginSessionActivityRefresh(activityRefreshState, deps.canRefresh())) return;
    try {
      await deps.invalidateAll();
    } finally {
      finishSessionActivityRefresh(activityRefreshState);
      armActivityRefresh();
    }
  }

  function scheduleActivityRefresh() {
    requestSessionActivityRefresh(activityRefreshState);
    armActivityRefresh();
  }

  function onVisibilityChange() {
    if (document.visibilityState !== "hidden") armActivityRefresh();
  }

  function dispose() {
    if (activityRefreshTimer) clearTimeout(activityRefreshTimer);
    activityRefreshTimer = null;
  }

  return {
    scheduleActivityRefresh,
    dispose,
    onVisibilityChange,
  };
}
