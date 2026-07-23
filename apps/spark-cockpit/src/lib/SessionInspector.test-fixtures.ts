import { getDictionary } from "./i18n";
import type { SessionWorkbenchView } from "./session-workbench";
import { buildInspectorLabels } from "./sessions-workspace/ask-inspector.svelte";

export const sessionInspectorLabels = buildInspectorLabels(getDictionary("en").sessions.workbench);

export function sessionWorkbenchView(
  overrides: Partial<SessionWorkbenchView> = {},
): SessionWorkbenchView {
  return {
    runs: [],
    tasks: [],
    artifacts: [],
    changes: [],
    evidence: [],
    messages: [],
    sessionTodo: null,
    context: {
      sessionId: "sess-inspector",
      title: "Inspector test",
      status: "idle",
      cwd: "/workspace/spark",
      model: null,
      createdAt: null,
      updatedAt: null,
    },
    ...overrides,
  };
}
