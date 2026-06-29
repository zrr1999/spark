export type ProjectChatPromptSuggestion = {
  id: string;
  label: string;
  prompt: string;
  meta?: string;
};

export type ProjectChatContextCard = {
  id: string;
  type: "task" | "artifact" | "inbox";
  kicker: string;
  title: string;
  description: string;
  prompt: string;
  primaryLabel: string;
  href?: string;
  secondaryLabel?: string;
};

export type ProjectChatContextTask = {
  runtimeTaskId: string;
  title: string;
  description: string | null;
  status: string;
  statusGroup: string;
};

export type ProjectChatContextArtifact = {
  id: string;
  kind: string;
  title: string;
  format: string;
  source: string;
};

export type ProjectChatContextInboxItem = {
  id: string;
  kind: string;
  title: string;
  status: string;
  urgency: string;
};

export type ProjectChatContextMessages = {
  suggestNoTasks: string;
  suggestBlockedTask: string;
  suggestRecentArtifact: string;
  suggestPendingInbox: string;
  taskContextKicker: string;
  artifactContextKicker: string;
  inboxContextKicker: string;
  askAboutThis: string;
  attachToChat: string;
  openArtifact: string;
  openInbox: string;
};

export function buildProjectChatContextActions({
  projectName,
  tasks,
  artifacts,
  inboxItems,
  baseSuggestions,
  workspaceUrl,
  messages,
}: {
  projectName: string;
  tasks: ProjectChatContextTask[];
  artifacts: ProjectChatContextArtifact[];
  inboxItems: ProjectChatContextInboxItem[];
  baseSuggestions: string[];
  workspaceUrl: string;
  messages: ProjectChatContextMessages;
}) {
  const pendingInbox = inboxItems.filter((item) => item.status === "pending");
  const blockedTask = tasks.find((task) => task.statusGroup === "blocked");
  const recentArtifact = artifacts[0] ?? null;

  const suggestions: ProjectChatPromptSuggestion[] = baseSuggestions.map((prompt, index) => ({
    id: `base-${index}`,
    label: prompt,
    prompt,
  }));

  if (tasks.length === 0) {
    suggestions.unshift({
      id: "no-tasks",
      label: fill(messages.suggestNoTasks, { projectName }),
      prompt: fill(messages.suggestNoTasks, { projectName }),
    });
  }

  if (blockedTask) {
    suggestions.unshift({
      id: `blocked-${blockedTask.runtimeTaskId}`,
      label: fill(messages.suggestBlockedTask, { title: blockedTask.title }),
      prompt: fill(messages.suggestBlockedTask, { title: blockedTask.title }),
      meta: blockedTask.status,
    });
  }

  if (recentArtifact) {
    suggestions.push({
      id: `artifact-${recentArtifact.id}`,
      label: fill(messages.suggestRecentArtifact, { title: recentArtifact.title }),
      prompt: fill(messages.suggestRecentArtifact, { title: recentArtifact.title }),
      meta: recentArtifact.kind,
    });
  }

  if (pendingInbox[0]) {
    suggestions.push({
      id: `inbox-${pendingInbox[0].id}`,
      label: fill(messages.suggestPendingInbox, { title: pendingInbox[0].title }),
      prompt: fill(messages.suggestPendingInbox, { title: pendingInbox[0].title }),
      meta: pendingInbox[0].urgency,
    });
  }

  const visibleTasks = tasks
    .slice()
    .sort((a, b) => taskPriority(a) - taskPriority(b) || a.title.localeCompare(b.title))
    .slice(0, 2)
    .map(
      (task): ProjectChatContextCard => ({
        id: `task-${task.runtimeTaskId}`,
        type: "task",
        kicker: messages.taskContextKicker,
        title: task.title,
        description: [task.runtimeTaskId, task.status].filter(Boolean).join(" · "),
        prompt: `Look at project task "${task.title}" (${task.runtimeTaskId}). ${
          task.description ?? "Explain its status and recommend the next useful action."
        }`,
        primaryLabel: messages.askAboutThis,
      }),
    );

  const artifactCards = artifacts.slice(0, 2).map(
    (artifact): ProjectChatContextCard => ({
      id: `artifact-${artifact.id}`,
      type: "artifact",
      kicker: messages.artifactContextKicker,
      title: artifact.title,
      description: [artifact.kind, artifact.format, artifact.source].filter(Boolean).join(" · "),
      prompt: `Review project artifact "${artifact.title}" (${artifact.id}) and summarize the important parts for this project.`,
      primaryLabel: messages.attachToChat,
      href: `${workspaceUrl}/artifacts/${artifact.id}`,
      secondaryLabel: messages.openArtifact,
    }),
  );

  const inboxCards = pendingInbox.slice(0, 2).map(
    (item): ProjectChatContextCard => ({
      id: `inbox-${item.id}`,
      type: "inbox",
      kicker: messages.inboxContextKicker,
      title: item.title,
      description: [item.kind, item.urgency].filter(Boolean).join(" · "),
      prompt: `Help me resolve pending inbox item "${item.title}" (${item.id}) for this project.`,
      primaryLabel: messages.askAboutThis,
      href: `${workspaceUrl}/inbox/${item.id}`,
      secondaryLabel: messages.openInbox,
    }),
  );

  return {
    suggestions: dedupeSuggestions(suggestions).slice(0, 8),
    cards: [...inboxCards, ...visibleTasks, ...artifactCards].slice(0, 5),
  };
}

function taskPriority(task: ProjectChatContextTask) {
  switch (task.statusGroup) {
    case "blocked":
      return 0;
    case "running":
      return 1;
    case "ready":
      return 2;
    default:
      return 3;
  }
}

function fill(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

function dedupeSuggestions(suggestions: ProjectChatPromptSuggestion[]) {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = suggestion.prompt.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
