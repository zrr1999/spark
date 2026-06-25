import type {
  WorkflowRunEvent,
  WorkflowRunEventStatus,
  WorkflowRunNode,
  WorkflowRunNodeKind,
  WorkflowRunSnapshot,
} from "./types.ts";

export function projectWorkflowRunEvents(
  events: WorkflowRunEvent[],
  options: { eventTailLimit?: number } = {},
): WorkflowRunSnapshot {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const nodesById: Record<string, WorkflowRunNode> = {};
  const nodeOrder: string[] = [];
  const snapshot: WorkflowRunSnapshot = {
    status: "queued",
    nodes: [],
    nodesById,
    stages: [],
    phases: [],
    eventTail: sorted.slice(-(options.eventTailLimit ?? 50)),
  };

  for (const event of sorted) {
    snapshot.updatedAt = event.timestamp;
    switch (event.type) {
      case "run_started": {
        snapshot.status = "running";
        snapshot.meta = event.meta;
        snapshot.startedAt = event.timestamp;
        if (event.nodeId) {
          upsertNode(nodesById, nodeOrder, {
            id: event.nodeId,
            kind: event.nodeKind ?? "run",
            label: event.label ?? event.meta?.name ?? "workflow run",
            status: "running",
            startedAt: event.timestamp,
            updatedAt: event.timestamp,
          });
        }
        break;
      }
      case "run_succeeded":
        snapshot.status = "succeeded";
        snapshot.finishedAt = event.timestamp;
        snapshot.result = event.result;
        if (event.nodeId) finishNode(nodesById, nodeOrder, event.nodeId, "succeeded", event);
        break;
      case "run_failed":
        snapshot.status = "failed";
        snapshot.finishedAt = event.timestamp;
        snapshot.errorMessage = event.errorMessage;
        if (event.nodeId) finishNode(nodesById, nodeOrder, event.nodeId, "failed", event);
        break;
      case "run_paused":
        snapshot.status = "paused";
        snapshot.finishedAt = event.timestamp;
        if (event.nodeId) finishNode(nodesById, nodeOrder, event.nodeId, "paused", event);
        break;
      case "run_stopped":
        snapshot.status = "stopped";
        snapshot.finishedAt = event.timestamp;
        if (event.nodeId) finishNode(nodesById, nodeOrder, event.nodeId, "stopped", event);
        break;
      case "run_stale":
        snapshot.status = "stale";
        snapshot.finishedAt = event.timestamp;
        if (event.nodeId) finishNode(nodesById, nodeOrder, event.nodeId, "stale", event);
        break;
      case "stage_started":
      case "phase_started":
      case "parallel_group_started":
      case "parallel_item_started":
      case "agent_started":
      case "tool_started":
      case "nested_workflow_started":
        if (event.nodeId) {
          upsertNode(nodesById, nodeOrder, {
            id: event.nodeId,
            kind: event.nodeKind ?? nodeKindFromEvent(event.type),
            label:
              event.label ?? event.title ?? event.toolName ?? event.workflowName ?? event.nodeId,
            status: "running",
            parentId: event.parentId,
            stage: event.stage ?? event.phase,
            phase: event.stage ?? event.phase,
            startedAt: event.timestamp,
            updatedAt: event.timestamp,
            data: event.data,
          });
          linkParent(nodesById, event.parentId, event.nodeId);
        }
        break;
      case "stage_finished":
      case "phase_finished":
        if (event.nodeId)
          finishNode(nodesById, nodeOrder, event.nodeId, event.status ?? "succeeded", event);
        break;
      case "parallel_group_succeeded":
      case "parallel_item_succeeded":
      case "agent_succeeded":
      case "tool_succeeded":
      case "nested_workflow_succeeded":
        if (event.nodeId) finishNode(nodesById, nodeOrder, event.nodeId, "succeeded", event);
        break;
      case "agent_cached":
        if (event.nodeId) finishNode(nodesById, nodeOrder, event.nodeId, "cached", event);
        break;
      case "parallel_group_failed":
      case "parallel_item_failed":
      case "agent_failed":
      case "tool_failed":
      case "nested_workflow_failed":
        if (event.nodeId) finishNode(nodesById, nodeOrder, event.nodeId, "failed", event);
        break;
      case "artifact_recorded":
        if (event.nodeId) {
          upsertNode(nodesById, nodeOrder, {
            id: event.nodeId,
            kind: "artifact",
            label: event.label ?? "artifact",
            status: "succeeded",
            parentId: event.parentId,
            stage: event.stage ?? event.phase,
            phase: event.stage ?? event.phase,
            startedAt: event.timestamp,
            updatedAt: event.timestamp,
            finishedAt: event.timestamp,
            result: event.result,
            data: event.data,
          });
          linkParent(nodesById, event.parentId, event.nodeId);
        }
        break;
      case "log":
        break;
    }
  }

  snapshot.nodes = nodeOrder.map((id) => nodesById[id]!).filter(Boolean);
  snapshot.stages = snapshot.nodes.filter((node) => node.kind === "stage" || node.kind === "phase");
  snapshot.phases = snapshot.stages;
  return snapshot;
}

function upsertNode(
  nodesById: Record<string, WorkflowRunNode>,
  nodeOrder: string[],
  next: Omit<WorkflowRunNode, "children"> & { children?: string[] },
): WorkflowRunNode {
  const existing = nodesById[next.id];
  if (!existing) {
    const created: WorkflowRunNode = { ...next, children: next.children ?? [] };
    nodesById[next.id] = created;
    nodeOrder.push(next.id);
    return created;
  }
  Object.assign(existing, {
    ...next,
    children: uniqueStrings([...(existing.children ?? []), ...(next.children ?? [])]),
  });
  return existing;
}

function finishNode(
  nodesById: Record<string, WorkflowRunNode>,
  nodeOrder: string[],
  nodeId: string,
  status: WorkflowRunEventStatus,
  event: WorkflowRunEvent,
): void {
  const node =
    nodesById[nodeId] ??
    upsertNode(nodesById, nodeOrder, {
      id: nodeId,
      kind: event.nodeKind ?? nodeKindFromEvent(event.type),
      label: event.label ?? event.title ?? event.toolName ?? event.workflowName ?? nodeId,
      status: "running",
      parentId: event.parentId,
      stage: event.stage ?? event.phase,
      phase: event.stage ?? event.phase,
      startedAt: event.stageRun?.startedAt ?? event.phaseRun?.startedAt ?? event.timestamp,
      updatedAt: event.timestamp,
      data: event.data,
    });
  linkParent(nodesById, event.parentId, nodeId);
  node.status = status;
  node.updatedAt = event.timestamp;
  node.finishedAt = event.timestamp;
  if (event.errorMessage) node.errorMessage = event.errorMessage;
  if (event.result !== undefined) node.result = event.result;
  if (event.telemetry) node.telemetry = event.telemetry;
  if (event.usage) node.usage = event.usage;
  if (event.data !== undefined) node.data = event.data;
}

function linkParent(
  nodesById: Record<string, WorkflowRunNode>,
  parentId: string | undefined,
  childId: string,
): void {
  if (!parentId) return;
  const parent = nodesById[parentId];
  if (!parent || parent.children.includes(childId)) return;
  parent.children.push(childId);
}

function nodeKindFromEvent(type: WorkflowRunEvent["type"]): WorkflowRunNodeKind {
  if (type.startsWith("stage_")) return "stage";
  if (type.startsWith("phase_")) return "phase";
  if (type.startsWith("parallel_group_")) return "parallel_group";
  if (type.startsWith("parallel_item_")) return "parallel_item";
  if (type.startsWith("agent_")) return "agent";
  if (type.startsWith("nested_workflow_")) return "nested_workflow";
  return "tool";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
