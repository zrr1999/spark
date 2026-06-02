interface SparkToolOperationalNotes {
  atomic: string;
  idempotent: string;
  prerequisites: string[];
}

const DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES: SparkToolOperationalNotes = {
  atomic: "read-only",
  idempotent: "yes; repeated calls only re-read current Spark state",
  prerequisites: ["Spark state exists in the current workspace."],
};

const SPARK_TOOL_OPERATIONAL_NOTES: Record<string, SparkToolOperationalNotes> = {
  spark_status: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_state: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_list_projects: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_list_artifacts: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_get_artifact: {
    atomic: "read-only",
    idempotent: "yes; repeated calls re-read the same artifact ref",
    prerequisites: ["Spark state exists.", "The requested artifact ref exists."],
  },
  spark_learning_search: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_learning_list: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_learning_read: {
    atomic: "read-only",
    idempotent: "yes; repeated calls re-read the same learning ref",
    prerequisites: ["Spark learning store exists.", "The requested learning ref/id exists."],
  },
  spark_update_todos: {
    atomic: "yes; applies the submitted session TODO op batch in one store write",
    idempotent: "operation-dependent; done/delete ops are safe when targeting stable ids",
    prerequisites: ["Spark state exists in the current workspace."],
  },
  spark_update_task_todos: {
    atomic: "yes; applies the submitted task TODO op batch in one store write",
    idempotent: "operation-dependent; done/delete ops are safe when targeting stable ids",
    prerequisites: [
      "A current Spark project is selected.",
      "This session has one claimed unfinished task, or the task parameter resolves to one.",
    ],
  },
  spark_finish_task: {
    atomic: "yes; completes one claimed task and clears its claim in one graph update",
    idempotent: "no; a finished task cannot be finished again",
    prerequisites: [
      "A current Spark project is selected.",
      "This session has a claimed unfinished task, or task resolves to one.",
    ],
  },
  spark_claim_task: {
    atomic: "yes; creates/updates and claims one task in one graph update",
    idempotent: "no; repeated calls can refresh metadata, claims, and updatedAt",
    prerequisites: ["A current Spark project is selected."],
  },
  spark_rename_project: {
    atomic: "yes; updates one project metadata record",
    idempotent: "yes when repeated with the same metadata",
    prerequisites: [
      "Spark state exists.",
      "A target project exists, or a current project is selected.",
    ],
  },
  spark_use_project: {
    atomic:
      "no; selecting an existing project writes only session state, while creating a new project writes graph state then session state",
    idempotent:
      "yes for selecting an existing project; creating by title may create once then select on repeat",
    prerequisites: [
      "Spark state exists.",
      "Provide an existing project selector, or provide title to create a project.",
    ],
  },
  spark_plan_tasks: {
    atomic:
      "yes for project graph changes; roadmap ref attachment is a follow-up write after readiness passes",
    idempotent:
      "mostly yes for stable task names/titles, but repeated updates refresh task metadata",
    prerequisites: [
      "A current Spark project is selected.",
      "Each task is concrete and plan-bound, with no unresolved openQuestions.",
    ],
  },
  spark_run_ready_tasks: {
    atomic: "no; starts or previews workflow-run scheduling and real runs complete asynchronously",
    idempotent:
      "dryRun=true is safe; dryRun=false can launch role-runs and should not be repeated blindly",
    prerequisites: [
      "A current Spark project is selected.",
      "Ready tasks exist for the selected project.",
      "Required role model bindings exist before real dispatch.",
    ],
  },
  spark_background_runs: {
    atomic:
      "action-dependent; status/list/inspect are read-only except reconcile refresh, kill/ack/reconcile mutate runtime or workflow-run records",
    idempotent:
      "status/list/inspect/reconcile are safe to repeat; ack is safe for the same problem records; kill is state-changing",
    prerequisites: [
      "Spark state exists for this workspace.",
      "Use runRef/taskRef/all=true for kill; broad kills are never implicit.",
    ],
  },
  spark_dag_manager: {
    atomic:
      "action-dependent; status is read-only; reconcile/ack/clear/kill mutate run records or processes",
    idempotent: "status, reconcile, and repeat ack are safe; clear/kill actions are state-changing",
    prerequisites: ["Spark workflow-run store exists for this workspace."],
  },
  spark_ask: {
    atomic: "yes; creates one ask artifact and waits for one answer artifact",
    idempotent: "no; repeated calls create or replay user-facing asks depending on flow settings",
    prerequisites: ["A concrete, context-specific user decision or clarification is needed."],
  },
  spark_ask_replay: {
    atomic: "no; replays a user-facing ask interaction",
    idempotent: "no; repeated calls can create additional answer artifacts",
    prerequisites: ["A previous Spark ask artifact exists, or a specific artifactRef is provided."],
  },
  spark_learning_record: {
    atomic: "yes; writes one learning record",
    idempotent: "yes when repeated with the same stable id and content",
    prerequisites: ["Evidence-backed reusable learning content is available."],
  },
  spark_learning_mark_stale: {
    atomic: "yes; updates one learning record status",
    idempotent: "yes when repeated with the same reason",
    prerequisites: ["The target learning ref/id exists.", "A stale reason is provided."],
  },
  spark_learning_supersede: {
    atomic: "yes; updates one learning record with replacement refs",
    idempotent: "yes when repeated with the same replacement refs",
    prerequisites: ["The target learning ref/id exists.", "Replacement learning refs are known."],
  },
  spark_learning_reject: {
    atomic: "yes; updates one learning candidate status",
    idempotent: "yes when repeated with the same reason",
    prerequisites: [
      "The target learning candidate ref/id exists.",
      "A rejection reason is provided.",
    ],
  },
  spark_learning_export_markdown: {
    atomic: "yes for the export file/artifact write",
    idempotent:
      "yes for the same filters and outputPath, subject to current learning store contents",
    prerequisites: [
      "Spark learning store exists.",
      "An output path is provided when a file export is desired.",
    ],
  },
  spark_learning_import_markdown: {
    atomic:
      "no when apply=true; imports multiple learning records and may optionally delete verified legacy sources",
    idempotent: "dry-run is safe; apply=true depends on source ids and import contents",
    prerequisites: [
      "inputPath exists and points to a Spark learning export, legacy Markdown file, or .learnings directory.",
    ],
  },
};

export function withSparkToolOperationalNotes(toolName: string, description: string): string {
  const notes = SPARK_TOOL_OPERATIONAL_NOTES[toolName] ?? DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES;
  return [
    description.trimEnd(),
    "",
    `Atomic: ${notes.atomic}`,
    `Idempotent: ${notes.idempotent}`,
    "Prerequisites:",
    ...notes.prerequisites.map((item) => `- ${item}`),
  ].join("\n");
}
