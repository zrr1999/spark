export const locales = ["en", "zh-CN"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";
export const localeCookieName = "navia_locale";

const en = {
  common: {
    never: "never",
    justNow: "just now",
    comingSoon: "Coming soon",
    planned: "planned",
    activeWs: "active WS",
    online: "online",
    unknown: "unknown",
    unknownSize: "unknown size",
    boundToRunner: "bound to a local service",
    reportedByConnectedRunners: "Reported by connected local services.",
    reportedByRunnerHello: "Reported by local service hello snapshots.",
    fallback: {
      runner: "local service",
      server: "server",
      workspaceScope: "Workspace scope",
      workspaceEvidence: "Workspace evidence",
      noDescription: "No description recorded",
      noRoleHint: "no role hint",
      noUri: "No URI recorded",
    },
    resourceKind: {
      repo: "Repository",
      doc: "Document",
      url: "URL",
      file: "File",
      tool: "Tool",
      secret_ref: "Secret reference",
      other: "Other",
    },
    agentSource: {
      workspace: "Workspace",
      builtin: "Builtin",
      imported: "Imported",
    },
    scope: {
      workspace: "workspace",
      project: "project",
    },
    urgency: {
      low: "low",
      normal: "normal",
      medium: "medium",
      high: "high",
      critical: "critical",
    },
    status: {
      online: "online",
      registered: "registered",
      offline: "offline",
      draining: "draining",
      disabled: "disabled",
      available: "available",
      indexing: "indexing",
      degraded: "degraded",
      unavailable: "unavailable",
      archived: "archived",
      active: "active",
      blocked: "blocked",
      completed: "completed",
      done: "done",
      pending: "pending",
      queued: "queued",
      resolved: "resolved",
      running: "running",
      delivered: "delivered",
      sent: "sent",
      acked: "acked",
      rejected: "rejected",
      cancelled: "cancelled",
      failed: "failed",
      succeeded: "succeeded",
      ready: "ready",
      missing: "missing",
      fetching: "fetching",
      too_large: "too large",
      unsupported_binary: "binary content",
      evicted: "evicted",
      used: "used",
      revoked: "revoked",
      expired: "expired",
    },
  },
  layout: {
    brand: {
      name: "Navia",
    },
    aria: {
      workspaceNavigation: "Workspace navigation",
      breadcrumb: "Breadcrumb",
      globalSearch: "Global search",
      workspaceMenu: "Workspace menu",
      home: "Navia home",
    },
    nav: {
      home: "Home",
      overview: "Overview",
      projects: "Projects",
      inbox: "Inbox",
      repos: "Repos",
      agents: "Agents",
      artifacts: "Artifacts",
      settings: "Settings",
      soon: "Coming soon",
    },
    pages: {
      home: "Home",
      overview: "Overview",
      settings: "Settings",
      setupGuide: "Setup guide",
      comingSoon: "Coming soon",
    },
    breadcrumb: {
      noWorkspace: "No workspace",
    },
    search: {
      placeholder: "Search Navia",
      shortcut: "⌘K",
      title: "Search",
      scope: "Projects",
      inputPlaceholder: "Search projects",
      projectResults: "Projects",
      hintProjects: "Search project names, slugs, or descriptions.",
      noProjects: "No matching projects.",
      loading: "Searching projects...",
      failed: "Search failed.",
      close: "Close search",
    },
    user: {
      workspaceSection: "Workspace",
      noWorkspaces: "No workspace has been created yet.",
      createWorkspace: "Create workspace",
    },
  },
  home: {
    headTitle: "Navia · Workspace cockpit",
    emptyHeadTitle: "Navia · Create workspace",
    hero: {
      eyebrow: "Workspace cockpit",
      title: "Spark local cockpit",
      lede: "Workspace state, Spark runtime projections, and evidence appear here once a workspace directory comes online.",
      openSettings: "Open settings",
      setUpRunner: "Create workspace",
    },
    noWorkspaceHero: {
      eyebrow: "Workspace setup",
      title: "Create your first workspace",
      lede: "Pick a profile, fill in the workspace details, then run the generated command on your machine.",
    },
    workspaceHome: {
      headTitle: "Navia · Workspaces",
      eyebrow: "Workspace directory",
      title: "Workspaces",
      lede: "Pick a workspace to inspect its bound local directory, pending asks, projects, and artifacts.",
      summaryAria: "Workspace directory summary",
      catalogEyebrow: "Available workspaces",
      catalogTitle: "All workspaces",
      manageConnections: "Manage connections",
      projectsLabel: "projects",
      pendingLabel: "pending",
      artifactsLabel: "artifacts",
      noConnection: "No local directory binding",
    },
    metrics: {
      aria: "Navia status",
      pendingInbox: "Pending inbox",
      pendingInboxHint: "Awaiting operator responses",
      workspaces: "Workspaces",
      runnerConnections: "Local connections",
      workspaceBindings: "Workspace directories",
    },
    panels: {
      projectionState: "Local projection",
      workspaces: "Workspaces",
      sqliteBacked: "Projection cache",
      settingsConnections: "Settings · Connections",
      runnerHealth: "Local service health",
      runnerOwnedTruth: "Spark owns execution truth",
      workspaceBindings: "Workspace bindings",
      appendOnlyAudit: "Append-only audit log",
      recentEvents: "Recent events",
    },
    emptyWorkspace: {
      kicker: "Setup flow",
      title: "Profile and command",
      body: "Pick a profile, then run the generated command in your terminal.",
      stepsAria: "Workspace setup guide",
      steps: [
        {
          title: "Pick a profile",
          description: "Select a workspace profile and fill in the required details.",
        },
        {
          title: "Run the generated command",
          description:
            "Copy the command and run it in your terminal. Pass the directory inline, or leave it off and answer the prompt.",
        },
        {
          title: "Open the workspace",
          description:
            "Once the target directory comes online, confirm the registration here and open the workspace.",
        },
      ],
      stepActions: {
        createToken: "Confirm",
        localWorkspaceCommand: "Workspace registration command",
        commandCreatedAria: "Created workspace registration command",
        commandCreatedTitle: "Command ready",
        commandCreatedHint:
          "Copy and run this in your terminal. Pass a directory after register, or omit it and answer the prompt.",
        copyCommand: "Copy",
        copiedCommand: "Copied",
        copyFailed: "Copy failed",
        copyInsecureContext: "Clipboard requires a secure browser context.",
        copyNotAllowed: "The browser blocked clipboard writes.",
        copyUnavailable: "Clipboard API is unavailable in this browser.",
        copyWriteFailed: "Clipboard write failed.",
        expiresPrefix: "Expires",
        profileConfirmed: "Profile confirmed",
        startCommand: "Start sync",
        runnerStatus: "View diagnostics",
        setUpRunner: "Generate command",
        waitForCommand:
          "Confirm the profile details above. The registration command appears here as soon as it's ready.",
        waitForWorkspace:
          "Run the registration command first. This step unlocks once the target directory comes online.",
      },
      form: {
        name: "Workspace name",
        namePlaceholder: "My workspace",
        slug: "Slug",
        slugPlaceholder: "Optional; derived from name",
        description: "Description",
        descriptionPlaceholder: "Optional context for this workspace",
        runnerBinding: "Workspace directory",
        profileSource: "Profile",
        freshProfile: "Fresh workspace",
        freshProfileDescription: "Start with an empty workspace profile.",
        gitProfile: "GitHub profile",
        gitProfileDescription: "Import agents and resources from a GitHub profile repo.",
        profileUrl: "GitHub profile URL",
        profileUrlPlaceholder: "https://github.com/org/repo/tree/main/profile",
        submit: "Open workspace",
      },
      runnerRequired: {
        title: "Register a workspace directory first",
        body: "Generate a registration command, then run it in your terminal. The final step unlocks once the workspace directory is online.",
        action: "Generate command",
      },
      action: "Create workspace",
    },
    runners: {
      eyebrow: "Workspace registration",
      title: "Local registrations",
      createToken: "Create registration token",
      tokenCreatedAria: "Created workspace registration token",
      tokenCreatedTitle: "Registration token created",
      tokenCreatedHint:
        "Run the generated command in your terminal. The workspace directory appears here after the first heartbeat.",
      expiresPrefix: "Expires",
      summaryAria: "Workspace registration summary",
      metrics: {
        online: "Online connections",
        registered: "Registered services",
        registeredHint: "Known local installations",
        bindings: "Local workspace directories",
      },
      registeredTitle: "Registered local services",
      emptyTitle: "No local services registered yet",
      emptyBody:
        "Generate a registration command, then run navia ws register on the target machine.",
      installationMissing: "installation id not reported",
      tokensTitle: "Registration tokens",
      noTokensTitle: "No registration tokens yet",
      noTokensBody:
        "Create a one-time workspace registration token. The full command is shown once and cannot be recovered.",
      defaultTokenLabel: "Workspace registration",
      notUsed: "not used",
      revoke: "Revoke",
    },
    runnerEmpty: {
      title: "No local services registered yet",
      body: "Waiting for a local service to register through",
      code: "/api/v1/runtime/*",
    },
    bindingsEmpty: "No workspace directories reported yet.",
    eventsEmpty: "No communication events recorded yet.",
    protocolPending: "protocol pending",
    updatedPrefix: "Updated",
    formMessages: {
      profileInvalid: "The workspace profile fields are invalid.",
      registrationLabelPrefix: "Workspace registration",
      commandCreated: "Registration command created. It is shown once and cannot be recovered.",
      registerWorkspaceFirst:
        "Bring the target workspace directory online before opening the workspace.",
      githubProfileRequired: "Enter a GitHub profile URL.",
      unsupportedProfileSource: "This workspace profile source is not supported.",
      loadProfileFailed: "Could not load the workspace profile.",
      workspaceRequired: "Enter a workspace name and slug.",
      createWorkspaceFailed: "Could not open the workspace.",
    },
  },
  projects: {
    headTitle: "Projects · Navia",
    hero: {
      eyebrow: "Projects",
      title: "Workspace projects",
      lede: "Projects group cockpit routing with Spark task graph, ask, invocation, and artifact projections from the active workspace.",
    },
    emptyWorkspace: {
      title: "Create a workspace first",
      body: "Projects belong to a workspace. Register a local workspace directory, then create the workspace from Home.",
      action: "Open overview",
    },
    list: {
      title: "Projects",
      totalSuffix: "total",
      emptyTitle: "No projects yet",
      emptyBody:
        "Create the first project to collect inbox requests, task graph snapshots, and evidence.",
    },
    summary: {
      pendingInbox: "pending inbox",
      running: "running",
      artifacts: "artifacts",
    },
    create: {
      kicker: "New project",
      title: "Create project",
      name: "Name",
      namePlaceholder: "MVP implementation",
      slug: "Slug",
      slugPlaceholder: "mvp-implementation",
      description: "Description",
      descriptionPlaceholder: "What should this project coordinate?",
      submit: "Create project",
    },
    formMessages: {
      nameSlugRequired: "Enter a project name and slug.",
      createFailed: "Could not create the project.",
    },
  },
  project: {
    headTitleSuffix: "Project",
    hero: {
      projectLabel: "Project",
    },
    metrics: {
      aria: "Project cockpit summary",
      pendingInbox: "Pending inbox",
      tasks: "Tasks",
      dependencies: "Dependencies",
      linkedInvocations: "Linked invocations",
    },
    graph: {
      kicker: "Project cockpit",
      title: "Task graph",
      body: "Navia renders the latest Spark-owned execution snapshot from its projection cache. Statuses, dependencies, and invocation links remain owned by Spark runtime state.",
      statusSummaryAria: "Task status summary",
      ready: "Ready",
      blocked: "Blocked",
      running: "Running",
      done: "Done",
    },
    command: {
      noRunnerOwner: "No local service owner",
      workspaceUnavailable: "Workspace unavailable",
      queueTask: "Queue task",
      ownerPrefix: "Owner:",
      offlinePending:
        "offline commands stay pending until the local service reconnects to the Spark bridge",
      metaLabel: "Spark command",
      title: "Start a task",
      noOwner: "No owner",
      titleLabel: "Title",
      titleDefault: "Run project task",
      promptLabel: "Prompt",
      promptPlaceholder: "Describe what should run inside this workspace.",
      recentAria: "Recent local command deliveries",
      recentLabel: "Recent command delivery",
      shownSuffix: "shown",
      empty: "No task start command queued for this project yet.",
      delivery: {
        pendingOnline: "Pending — sending to local service",
        pendingOffline: "Pending — waiting for local service to reconnect",
        sent: "Delivered — waiting for ack or reject",
        acked: "Acknowledged by runner bridge",
        rejected: "Rejected by runner bridge",
        failed: "Delivery failed",
        cancelled: "Delivery cancelled",
        none: "No delivery record",
        notAttempted: "not attempted",
        attemptSingular: "delivery attempt",
        attemptPlural: "delivery attempts",
        ackedPrefix: "acked",
        sentPrefix: "sent",
      },
    },
    tasks: {
      kicker: "Spark-owned execution",
      title: "Task graph",
      snapshotPrefix: "Snapshot",
      receivedPrefix: "received",
      versionPrefix: "v",
      empty: "No task graph snapshot ingested for this project yet.",
      dependsOn: "Depends on",
      noUpstream: "No upstream blockers in this snapshot.",
      unblocks: "Unblocks",
      noDownstream: "No downstream tasks.",
      invocationLinks: "Invocation links",
      invocationLinksAria: "Invocation links for",
      noInvocation: "No mirrored invocation yet.",
      inputs: "inputs",
      outputs: "outputs",
    },
    inbox: {
      kicker: "Human in the loop",
      title: "Inbox",
      empty: "No asks or reviews yet.",
    },
    invocations: {
      kicker: "Mirrored from Spark runtime",
      title: "Invocations",
      empty: "No invocation updates yet.",
    },
    artifacts: {
      kicker: "Evidence",
      title: "Artifacts",
      empty: "No artifacts produced yet.",
    },
    logs: {
      kicker: "Run output",
      title: "Latest logs",
      empty: "No Spark execution logs yet.",
    },
    formMessages: {
      taskRequired: "Enter a task title and prompt.",
      queued: "Task queued for the owning local service.",
      queueFailed: "Could not queue the task.",
    },
  },
  inbox: {
    headTitle: "Inbox · Navia",
    hero: {
      eyebrow: "Human in the loop",
      title: "Inbox",
      lede: "Asks and reviews from Spark-backed runs wait here until an operator answers. Nothing times out automatically.",
    },
    metrics: {
      aria: "Inbox status",
      pending: "Pending",
      resolved: "Resolved",
      archived: "Archived",
    },
    emptyWorkspace: {
      title: "Create a workspace first",
      body: "Inbox items belong to the workspace reported by a local workspace binding.",
      action: "Open overview",
    },
    empty: {
      title: "No human requests yet",
      body: "When a Spark-backed run calls ask_user, review, approval, or blocker, the request shows up here.",
    },
    list: {
      title: "Requests",
      totalSuffix: "total",
      awaitingAnswer: "awaiting answer",
      acked: "acked",
    },
  },
  inboxDetail: {
    headTitleSuffix: "Inbox",
    meta: {
      aria: "Inbox request metadata",
      project: "Project",
      runnerWorkspace: "Local workspace",
      runnerRequest: "Local request",
      created: "Created",
    },
    response: {
      kicker: "Operator response",
      title: "Answer request",
      answer: "Answer",
      answerPlaceholder: "Reply to the local request",
      requiredMark: " *",
      previewOnly: "Preview-only context. No answer is required for this prompt.",
      operatorNote: "Operator note",
      operatorNotePlaceholder: "Optional delivery note recorded with the audit trail",
      send: "Send answer",
      cancel: "Cancel request",
      archive: "Archive",
      recordedTitle: "Response recorded",
      statusPrefix: "Status:",
      runnerAcked: "local service acked",
      waitingAck: "waiting for local service ack",
      closedTitle: "Request closed",
      closedBody: "This inbox item is no longer pending.",
    },
    audit: {
      kicker: "Local execution context",
      title: "Delivery audit",
      requestStatus: "Request status",
      inboxStatus: "Inbox status",
      responseStatus: "Response status",
      deliveryAttempts: "Delivery attempts",
      lastDelivery: "Last delivery",
      rawContext: "Raw context",
    },
    formMessages: {
      alreadyResolved: "This inbox item has already been resolved.",
      unsupportedStatus: "This response status is not supported.",
      answerRequired: "Enter an answer.",
      missingRequiredPrefix: "Missing required answer:",
      recordFailed: "Could not record the response.",
    },
  },
  repos: {
    headTitle: "Resources · Navia",
    hero: {
      eyebrow: "Workspace context",
      title: "Repos & resources",
      lede: "Register workspace-level resources that agents and projects can reference. Repos are first-class; docs, URLs, files, tools, and secret references sit alongside them.",
    },
    metrics: {
      aria: "Resource status",
      total: "Total",
      repos: "Repos",
      available: "Available",
      archived: "Archived",
    },
    emptyWorkspace: {
      title: "Create a workspace first",
      body: "Resources are scoped to a server-visible workspace.",
      action: "Open overview",
    },
    list: {
      title: "Resources",
      totalSuffix: "total",
      emptyTitle: "No resources yet",
      emptyBody: "Add a repository, doc, URL, file, tool, or secret reference for future projects.",
      linkedProjects: "linked projects",
      updatedPrefix: "updated",
      restore: "Restore",
      archive: "Archive",
    },
    create: {
      kicker: "New resource",
      title: "Add resource",
      kind: "Kind",
      name: "Name",
      namePlaceholder: "navia workspace repo",
      uri: "URI",
      uriPlaceholder: "file:///workspace/navia or https://...",
      notes: "Notes",
      notesPlaceholder: "What should agents know about this resource?",
      submit: "Add resource",
    },
    formMessages: {
      unsupportedKind: "This resource kind is not supported.",
      nameRequired: "Enter a resource name.",
      missingId: "Missing resource id.",
    },
  },
  agents: {
    headTitle: "Agents · Navia",
    hero: {
      eyebrow: "Agent specs",
      title: "Agents",
      lede: "Reusable workspace-level agent specs. Spark-backed execution uses these specs to describe preferred roles, instructions, and enabled state.",
    },
    metrics: {
      aria: "Agent spec status",
      total: "Total",
      active: "Active",
      disabled: "Disabled",
      archived: "Archived",
    },
    emptyWorkspace: {
      title: "Create a workspace first",
      body: "Agent specs are scoped to the active workspace.",
      action: "Open overview",
    },
    list: {
      title: "Agent specs",
      totalSuffix: "total",
      emptyTitle: "No agent specs yet",
      emptyBody: "Add a reusable worker, reviewer, planner, or imported spec for the workspace.",
      updatedPrefix: "updated",
      disable: "Disable",
      enable: "Enable",
      restore: "Restore",
      archive: "Archive",
    },
    create: {
      kicker: "New spec",
      title: "Add agent spec",
      name: "Name",
      namePlaceholder: "reviewer",
      source: "Source",
      roleHint: "Role hint",
      roleHintPlaceholder: "role:builtin-reviewer",
      description: "Description",
      descriptionPlaceholder: "Reviews project evidence and task results",
      instructions: "Instructions",
      instructionsPlaceholder: "What should this agent focus on?",
      submit: "Add agent spec",
    },
    formMessages: {
      nameRequired: "Enter an agent spec name.",
      unsupportedSource: "This agent source is not supported.",
      createFailed: "Could not create the agent spec.",
      invalidStatus: "Invalid agent status update.",
    },
  },
  artifacts: {
    headTitle: "Artifacts · Navia",
    hero: {
      eyebrow: "Evidence",
      title: "Artifacts",
      lede: "Evidence produced by Spark-backed runs and operators surfaces here as projection metadata. Canonical content stays in Spark/local artifact stores until you request a preview or export.",
    },
    metrics: {
      aria: "Artifact status",
      total: "Total",
      workspaceScope: "Workspace scope",
      projectScope: "Project scope",
      previewCached: "Preview cached",
    },
    emptyWorkspace: {
      title: "Create a workspace first",
      body: "Artifact projections are scoped to a locally owned workspace.",
      action: "Open overview",
    },
    empty: {
      title: "No artifacts yet",
      body: "Local execution artifacts and operator-response artifacts show up here with provenance and content pointers.",
    },
    list: {
      title: "Evidence board",
      projectedSuffix: "projected",
      links: "links",
      notCached: "not cached",
    },
  },
  artifactDetail: {
    headTitleSuffix: "Artifacts",
    evidenceLabel: "evidence",
    meta: {
      aria: "Artifact metadata",
      source: "Source",
      size: "Size",
      runner: "Local service",
      previewCache: "Preview cache",
    },
    provenance: {
      kicker: "Traceability",
      title: "Provenance",
      project: "Project",
      invocation: "Invocation",
      humanRequest: "Human request",
      links: "Links",
      json: "Provenance JSON",
    },
    cache: {
      kicker: "Lazy cache",
      title: "Preview and export pointer",
      registered: "Preview cache registered",
      notPrepared: "Preview cache not prepared",
      body: "Navia keeps preview and export files in the server artifact cache. Canonical content stays local and is not copied eagerly.",
      state: "State",
      path: "Path",
      mime: "MIME",
      lastAccessed: "Last accessed",
      prepare: "Prepare preview cache",
      openApi: "Open cache API",
    },
    preview: {
      kicker: "Lazy preview",
      title: "Cached content",
      statusHint: "Status hint",
      state: "State",
      mime: "MIME",
      size: "Size",
      fetched: "Fetched",
      openFull: "Open full content",
      openRaw: "Open raw content",
      nonTextPrefix: "Preview body is not text; download via",
      contentEndpoint: "the content endpoint",
      probe: "Probe content endpoint",
      truncatedPrefix: "Inline preview truncated at",
      statusLabels: {
        ready: "Preview ready",
        missing: "Preview not cached",
        fetching: "Preview fetching",
        too_large: "Preview too large",
        unsupported_binary: "Binary content",
        error: "Preview error",
        evicted: "Preview evicted",
      },
      statusHints: {
        ready: "Cached preview rendered below.",
        missing:
          "The server has not fetched preview content yet. Use Prepare preview cache to fetch one when the runtime offers it.",
        fetching: "The server is fetching the preview cache.",
        too_large:
          "The artifact body is larger than the inline preview budget. Open the canonical content via the runtime path.",
        unsupported_binary:
          "Binary artifacts are not previewed inline. Use the canonical pointer to download them.",
        error: "The server could not build the preview. Check the cache record for details.",
        evicted: "The cached preview was evicted. Re-prepare to fetch a fresh one.",
      },
    },
    content: {
      kicker: "Content pointer",
      title: "Canonical reference",
    },
    formMessages: {
      prepareFailed: "Could not prepare the artifact preview.",
    },
  },
  settings: {
    headTitle: "Settings · Navia",
    general: {
      eyebrow: "Settings",
      title: "Settings",
      lede: "Manage the current workspace, registration commands, and local connection health from a single console.",
      account: {
        kicker: "Account",
        title: "Local owner",
        body: "Owner profile, session preferences, and team access controls will live here.",
      },
      workspace: {
        kicker: "Workspace defaults",
        title: "Workspace preferences",
        body: "Default profiles, naming rules, and project templates will move into this section.",
      },
      profiles: {
        kicker: "Profiles",
        title: "Workspace profiles",
        body: "Profile import, save-as-profile, and Git sync controls will be managed here.",
      },
    },
    navigation: {
      aria: "Settings sections",
      title: "Settings",
      connections: "Connections",
      workspaceBindings: "Workspace directories",
      runnerSetup: "Registration setup",
    },
    hero: {
      eyebrow: "Settings",
      title: "Workspace settings",
      lede: "Manage the current workspace and its local connection.",
      ledeRest: "Workspace and project navigation continue to live in the main app.",
      copyCommand: "Copy registration command",
      createToken: "Create registration command",
    },
    workspace: {
      kicker: "Workspace",
      title: "Workspace settings",
      body: "Edit the server-visible name, route, and description for this workspace.",
      name: "Workspace name",
      slug: "Path identifier",
      description: "Description",
      descriptionPlaceholder: "Optional context for this workspace",
      created: "Created",
      updated: "Updated",
      save: "Save settings",
    },
    enrollment: {
      kicker: "Workspace registration",
      title: "Registration tokens",
      body: "Mint one-time workspace registration tokens. The plaintext token is shown only at creation time; afterwards Settings lists metadata only.",
      label: "Token label",
      labelPlaceholder: "Local workspace",
      createToken: "Generate command",
      tokenCreatedAria: "Created workspace registration token",
      tokenCreatedTitle: "Registration token created — shown once",
      tokenCreatedHint:
        "Copy the command now. Navia keeps only the token hash and cannot show this secret again. The workspace directory appears here once the command connects.",
      expiresPrefix: "Expires",
      commandLabel: "Workspace registration command",
      tokenLabel: "Registration token",
      tableTitle: "Registration token inventory",
      tableCount: "tokens",
      emptyTitle: "No registration tokens yet",
      emptyBody: "Generate a registration command to bring a local workspace directory online.",
      defaultTokenLabel: "Workspace registration",
      notUsed: "not used",
      revoke: "Revoke",
      created: "Created",
      expires: "Expires",
      runner: "Used by",
    },
    summary: {
      onlineRunners: "Online connections",
      workspaceBindings: "Workspace bindings",
      offlineRunners: "Offline connections",
    },
    metrics: {
      aria: "Connection status",
      runnerConnections: "Workspace connections",
      workspaceBindings: "Workspace directories",
      offlineRunners: "Offline connections",
      offlineHint: "Stale-connection sweep is not enabled yet",
    },
    table: {
      runner: "Local service",
      installation: "Installation",
      status: "Status",
      lastSeen: "Last seen",
      workspace: "Workspace",
      updated: "Updated",
    },
    runner: {
      kicker: "Local service protocol",
      title: "Registered local services",
      badge: "/api/v1/runtime/*",
      emptyTitle: "No local services registered yet",
      emptyBody:
        "Generate a registration command from this page, then run navia ws register against",
      installationMissing: "installation id not reported",
      protocolPending: "protocol pending",
      routesLabel: "Local service protocol routes",
    },
    setup: {
      kicker: "Registration setup",
      title: "Spark bridge CLI flow",
      steps: [
        {
          title: "Create a workspace registration token",
          description:
            "Mint a one-time workspace registration token from the local owner session and exchange it for local service credentials.",
          status: "ready",
        },
        {
          title: "Start the local Navia service",
          description:
            "The local service owns the server WebSocket and workspace registry, then invokes Spark runtime primitives for task, artifact, and ask/review projections.",
          status: "planned",
        },
        {
          title: "Connect thin agent plugins",
          description:
            "Pi, Codex, Claude Code, and future adapters talk to the local service over local IPC; they do not connect to Navia directly.",
          status: "planned",
        },
      ],
    },
    bindings: {
      kicker: "Workspace directory inventory",
      title: "Reported directories",
      emptyTitle: "No workspace directories reported yet",
      empty: "No workspace directories reported yet. After",
      emptyRest:
        "directories show up here first, then graduate into the main workspace navigation.",
    },
    formMessages: {
      workspaceRequired: "Enter a workspace name and path identifier.",
      slugUsed: "That workspace path identifier is already in use.",
      saved: "Workspace settings saved.",
      commandCreated: "Registration command created. It is shown once and cannot be viewed again.",
      tokenIdRequired: "Token id is required.",
      tokenRevoked: "Registration token revoked.",
      tokenNotActive: "That registration token was not active.",
    },
  },
  setup: {
    headTitle: "Set up Navia",
    introAria: "Navia setup intro",
    eyebrow: "Spark local cockpit",
    title: "Bring your local workspaces into a single precise cockpit.",
    lede: "The browser only talks to the local Navia server. Spark runtime state owns execution, artifacts, and task graphs; Navia renders projections.",
    features: {
      workspaceOverview: "Workspace-first overview",
      humanDecisions: "Human decisions without timeouts",
      artifactEvidence: "Local artifact evidence",
    },
    firstRun: "First run",
    createOwner: "Initialize Navia",
    panelCopy:
      "This local-first v0.1 server needs one owner before it can manage workspace connections.",
    fields: {
      displayName: "Display name",
      email: "Email (optional)",
    },
    action: "Continue",
    errors: {
      displayNameMin: "Display name must be at least 2 characters.",
      ownerExists: "The Navia owner is already set up.",
    },
  },
};

export type AppMessages = typeof en;

const zhCN: AppMessages = {
  common: {
    never: "从未",
    justNow: "刚刚",
    comingSoon: "即将推出",
    planned: "已规划",
    activeWs: "活跃 WS",
    online: "在线",
    unknown: "未知",
    unknownSize: "大小未知",
    boundToRunner: "已绑定到本地服务",
    reportedByConnectedRunners: "由已连接的本地服务上报。",
    reportedByRunnerHello: "由本地服务 hello 快照上报。",
    fallback: {
      runner: "本地服务",
      server: "服务端",
      workspaceScope: "工作空间范围",
      workspaceEvidence: "工作空间证据",
      noDescription: "未记录描述",
      noRoleHint: "无角色提示",
      noUri: "未记录 URI",
    },
    resourceKind: {
      repo: "仓库",
      doc: "文档",
      url: "URL",
      file: "文件",
      tool: "工具",
      secret_ref: "密钥引用",
      other: "其他",
    },
    agentSource: {
      workspace: "工作空间",
      builtin: "内置",
      imported: "导入",
    },
    scope: {
      workspace: "工作空间",
      project: "项目",
    },
    urgency: {
      low: "低",
      normal: "普通",
      medium: "中",
      high: "高",
      critical: "紧急",
    },
    status: {
      online: "在线",
      registered: "已注册",
      offline: "离线",
      draining: "排空中",
      disabled: "已禁用",
      available: "可用",
      indexing: "索引中",
      degraded: "降级",
      unavailable: "不可用",
      archived: "已归档",
      active: "活跃",
      blocked: "阻塞",
      completed: "已完成",
      done: "已完成",
      pending: "待发送",
      queued: "已排队",
      resolved: "已解决",
      running: "运行中",
      delivered: "已投递",
      sent: "已发送",
      acked: "已确认",
      rejected: "已拒绝",
      cancelled: "已取消",
      failed: "失败",
      succeeded: "成功",
      ready: "可用",
      missing: "缺失",
      fetching: "获取中",
      too_large: "过大",
      unsupported_binary: "二进制内容",
      evicted: "已淘汰",
      used: "已使用",
      revoked: "已撤销",
      expired: "已过期",
    },
  },
  layout: {
    brand: {
      name: "Navia",
    },
    aria: {
      workspaceNavigation: "工作空间导航",
      breadcrumb: "面包屑",
      globalSearch: "全局搜索",
      workspaceMenu: "工作空间菜单",
      home: "Navia 主页",
    },
    nav: {
      home: "首页",
      overview: "概览",
      projects: "项目",
      inbox: "收件箱",
      repos: "仓库",
      agents: "智能体",
      artifacts: "产物",
      settings: "设置",
      soon: "即将推出",
    },
    pages: {
      home: "首页",
      overview: "概览",
      settings: "设置",
      setupGuide: "创建引导",
      comingSoon: "即将推出",
    },
    breadcrumb: {
      noWorkspace: "无工作空间",
    },
    search: {
      placeholder: "搜索 Navia",
      shortcut: "⌘K",
      title: "搜索",
      scope: "项目",
      inputPlaceholder: "搜索项目",
      projectResults: "项目",
      hintProjects: "搜索项目名称、路径标识或描述。",
      noProjects: "没有匹配的项目。",
      loading: "正在搜索项目...",
      failed: "搜索失败。",
      close: "关闭搜索",
    },
    user: {
      workspaceSection: "工作空间",
      noWorkspaces: "还没有创建工作空间。",
      createWorkspace: "创建工作空间",
    },
  },
  home: {
    headTitle: "Navia · 工作空间控制台",
    emptyHeadTitle: "Navia · 创建工作空间",
    hero: {
      eyebrow: "工作空间驾驶舱",
      title: "Spark 本地驾驶舱",
      lede: "工作空间目录上线后，工作空间状态、Spark 运行时投影和证据会出现在这里。",
      openSettings: "打开设置",
      setUpRunner: "创建工作空间",
    },
    noWorkspaceHero: {
      eyebrow: "工作空间设置",
      title: "创建第一个工作空间",
      lede: "选择配置、填写工作空间信息，然后在本机执行生成的命令。",
    },
    workspaceHome: {
      headTitle: "Navia · 工作空间",
      eyebrow: "工作空间目录",
      title: "工作空间",
      lede: "选择一个工作空间，查看它绑定的本地目录、待处理询问、项目和证据产物。",
      summaryAria: "工作空间目录摘要",
      catalogEyebrow: "可用工作空间",
      catalogTitle: "全部工作空间",
      manageConnections: "管理连接",
      projectsLabel: "个项目",
      pendingLabel: "个待处理",
      artifactsLabel: "个产物",
      noConnection: "未绑定本地目录",
    },
    metrics: {
      aria: "Navia 状态",
      pendingInbox: "待处理收件箱",
      pendingInboxHint: "等待操作员响应",
      workspaces: "工作空间",
      runnerConnections: "本地连接",
      workspaceBindings: "工作空间目录",
    },
    panels: {
      projectionState: "本地投影",
      workspaces: "工作空间",
      sqliteBacked: "投影缓存",
      settingsConnections: "设置 · 连接",
      runnerHealth: "本地服务健康",
      runnerOwnedTruth: "执行真相由 Spark 拥有",
      workspaceBindings: "工作空间绑定",
      appendOnlyAudit: "追加式审计日志",
      recentEvents: "最近事件",
    },
    emptyWorkspace: {
      kicker: "创建流程",
      title: "配置和命令",
      body: "选择配置，然后在终端中执行生成的命令。",
      stepsAria: "工作空间设置引导",
      steps: [
        {
          title: "选择配置",
          description: "选择工作空间配置，并填写创建工作空间所需的信息。",
        },
        {
          title: "执行生成的命令",
          description: "复制命令并在终端中运行。可以在命令后直接传入目录，也可以省略后按提示输入。",
        },
        {
          title: "进入工作空间",
          description: "目标目录上线后，在这里确认注册并进入工作空间。",
        },
      ],
      stepActions: {
        createToken: "确认",
        localWorkspaceCommand: "工作空间注册命令",
        commandCreatedAria: "已生成工作空间注册命令",
        commandCreatedTitle: "命令已就绪",
        commandCreatedHint:
          "复制并在终端运行这条命令。可以在 register 后传目录，也可以省略后按提示输入。",
        copyCommand: "复制",
        copiedCommand: "已复制",
        copyFailed: "复制失败",
        copyInsecureContext: "剪贴板需要安全浏览器上下文。",
        copyNotAllowed: "浏览器拒绝写入剪贴板。",
        copyUnavailable: "当前浏览器没有开放 Clipboard API。",
        copyWriteFailed: "写入剪贴板失败。",
        expiresPrefix: "过期时间",
        profileConfirmed: "配置已确认",
        startCommand: "启动同步",
        runnerStatus: "查看诊断",
        setUpRunner: "生成命令",
        waitForCommand: "先确认上方的配置信息，注册命令准备好后会自动出现在这里。",
        waitForWorkspace: "先在终端运行注册命令；目标目录上线后，本步骤会解锁。",
      },
      form: {
        name: "工作空间名称",
        namePlaceholder: "我的工作空间",
        slug: "路径标识",
        slugPlaceholder: "可选；默认从名称生成",
        description: "描述",
        descriptionPlaceholder: "可选：这个工作空间的上下文",
        runnerBinding: "工作空间目录",
        profileSource: "配置来源",
        freshProfile: "空白配置",
        freshProfileDescription: "从空白配置开始。",
        gitProfile: "GitHub 配置",
        gitProfileDescription: "从 GitHub 配置仓库导入智能体和资源。",
        profileUrl: "GitHub 配置链接",
        profileUrlPlaceholder: "https://github.com/org/repo/tree/main/profile",
        submit: "进入工作空间",
      },
      runnerRequired: {
        title: "先让工作空间目录上线",
        body: "生成一条注册命令，并在终端中运行。工作空间目录上线后，最后一步会在这里解锁。",
        action: "生成命令",
      },
      action: "创建工作空间",
    },
    runners: {
      eyebrow: "工作空间注册",
      title: "本地注册",
      createToken: "创建注册 token",
      tokenCreatedAria: "已创建工作空间注册 token",
      tokenCreatedTitle: "注册 token 已创建",
      tokenCreatedHint: "在终端中运行生成的命令。第一次心跳到达后，工作空间目录会出现在这里。",
      expiresPrefix: "过期时间",
      summaryAria: "工作空间注册状态摘要",
      metrics: {
        online: "在线连接",
        registered: "已注册本地服务",
        registeredHint: "已知本地安装",
        bindings: "本地工作空间目录",
      },
      registeredTitle: "已注册的本地服务",
      emptyTitle: "还没有本地服务注册",
      emptyBody: "先生成一条注册命令，再在目标主机上运行 navia ws register。",
      installationMissing: "未上报 installation id",
      tokensTitle: "注册 token",
      noTokensTitle: "还没有注册 token",
      noTokensBody: "创建一次性工作空间注册 token。完整命令仅显示一次，丢失后无法找回。",
      defaultTokenLabel: "工作空间注册",
      notUsed: "未使用",
      revoke: "撤销",
    },
    runnerEmpty: {
      title: "还没有本地服务注册",
      body: "正在等待本地服务通过以下路径注册：",
      code: "/api/v1/runtime/*",
    },
    bindingsEmpty: "还没有上报工作空间目录。",
    eventsEmpty: "还没有记录通信事件。",
    protocolPending: "协议待上报",
    updatedPrefix: "更新于",
    formMessages: {
      profileInvalid: "工作空间配置内容不合法。",
      registrationLabelPrefix: "工作空间注册",
      commandCreated: "注册命令已创建，仅显示一次，丢失后无法找回。",
      registerWorkspaceFirst: "进入工作空间前，请先让目标工作空间目录上线。",
      githubProfileRequired: "请填写 GitHub 配置链接。",
      unsupportedProfileSource: "不支持这种工作空间配置来源。",
      loadProfileFailed: "无法加载工作空间配置。",
      workspaceRequired: "请填写工作空间名称和路径标识。",
      createWorkspaceFailed: "进入工作空间失败。",
    },
  },
  projects: {
    headTitle: "项目 · Navia",
    hero: {
      eyebrow: "项目",
      title: "工作空间项目",
      lede: "项目汇集驾驶舱路由，以及当前工作空间中的 Spark 任务图、询问、调用和产物投影。",
    },
    emptyWorkspace: {
      title: "先创建工作空间",
      body: "项目隶属于某个工作空间。请先注册本地工作空间目录，再从首页创建工作空间。",
      action: "打开概览",
    },
    list: {
      title: "项目",
      totalSuffix: "总计",
      emptyTitle: "还没有项目",
      emptyBody: "创建第一个项目，用来收集收件箱请求、任务图快照和证据。",
    },
    summary: {
      pendingInbox: "待处理收件箱",
      running: "运行中",
      artifacts: "产物",
    },
    create: {
      kicker: "新项目",
      title: "创建项目",
      name: "名称",
      namePlaceholder: "MVP implementation",
      slug: "路径标识",
      slugPlaceholder: "mvp-implementation",
      description: "描述",
      descriptionPlaceholder: "这个项目需要协调什么？",
      submit: "创建项目",
    },
    formMessages: {
      nameSlugRequired: "请填写项目名称和路径标识。",
      createFailed: "创建项目失败。",
    },
  },
  project: {
    headTitleSuffix: "项目",
    hero: {
      projectLabel: "项目",
    },
    metrics: {
      aria: "项目驾驶舱摘要",
      pendingInbox: "待处理收件箱",
      tasks: "任务",
      dependencies: "依赖",
      linkedInvocations: "关联调用",
    },
    graph: {
      kicker: "项目驾驶舱",
      title: "任务图",
      body: "Navia 从投影缓存中渲染最新的 Spark 执行快照。状态、依赖和调用链接仍由 Spark 运行时状态拥有。",
      statusSummaryAria: "任务状态摘要",
      ready: "可运行",
      blocked: "阻塞",
      running: "运行中",
      done: "完成",
    },
    command: {
      noRunnerOwner: "没有本地服务 owner",
      workspaceUnavailable: "工作空间不可用",
      queueTask: "排队任务",
      ownerPrefix: "Owner:",
      offlinePending: "离线命令会在本地服务重连到 Spark 桥接后继续投递",
      metaLabel: "Spark 命令",
      title: "启动任务",
      noOwner: "无 owner",
      titleLabel: "标题",
      titleDefault: "Run project task",
      promptLabel: "提示词",
      promptPlaceholder: "描述要在这个工作空间中执行什么工作。",
      recentAria: "最近本地命令投递",
      recentLabel: "最近命令投递",
      shownSuffix: "条",
      empty: "这个项目还没有排队过任务启动命令。",
      delivery: {
        pendingOnline: "待发送 — 正在发往本地服务",
        pendingOffline: "待发送 — 等待本地服务重连",
        sent: "已投递 — 等待确认或拒绝",
        acked: "运行桥接已确认",
        rejected: "运行桥接已拒绝",
        failed: "投递失败",
        cancelled: "投递已取消",
        none: "无投递记录",
        notAttempted: "尚未尝试",
        attemptSingular: "次投递尝试",
        attemptPlural: "次投递尝试",
        ackedPrefix: "确认于",
        sentPrefix: "发送于",
      },
    },
    tasks: {
      kicker: "Spark 拥有的执行状态",
      title: "任务图",
      snapshotPrefix: "快照",
      receivedPrefix: "接收于",
      versionPrefix: "v",
      empty: "这个项目还没有收到任务图快照。",
      dependsOn: "依赖",
      noUpstream: "当前快照中没有上游阻塞项。",
      unblocks: "解除阻塞",
      noDownstream: "没有下游任务。",
      invocationLinks: "调用链接",
      invocationLinksAria: "调用链接：",
      noInvocation: "还没有镜像调用。",
      inputs: "输入",
      outputs: "输出",
    },
    inbox: {
      kicker: "人在环中",
      title: "收件箱",
      empty: "还没有询问或评审。",
    },
    invocations: {
      kicker: "镜像自 Spark 运行时",
      title: "调用",
      empty: "还没有调用更新。",
    },
    artifacts: {
      kicker: "证据",
      title: "产物",
      empty: "还没有产物。",
    },
    logs: {
      kicker: "运行输出",
      title: "最新日志",
      empty: "还没有 Spark 执行日志。",
    },
    formMessages: {
      taskRequired: "请填写任务标题和提示词。",
      queued: "任务已加入本地服务队列。",
      queueFailed: "任务入队失败。",
    },
  },
  inbox: {
    headTitle: "收件箱 · Navia",
    hero: {
      eyebrow: "人在环中",
      title: "收件箱",
      lede: "来自 Spark 支撑运行的询问和评审会在这里等待操作员回答，不会自动超时。",
    },
    metrics: {
      aria: "收件箱状态",
      pending: "待处理",
      resolved: "已解决",
      archived: "已归档",
    },
    emptyWorkspace: {
      title: "先创建工作空间",
      body: "收件箱条目隶属于由本地目录绑定上报的活跃工作空间。",
      action: "打开概览",
    },
    empty: {
      title: "还没有人工请求",
      body: "当 Spark 支撑的运行调用 ask_user、review、approval 或 blocker 工具时，请求会出现在这里。",
    },
    list: {
      title: "请求",
      totalSuffix: "总计",
      awaitingAnswer: "等待回答",
      acked: "已确认",
    },
  },
  inboxDetail: {
    headTitleSuffix: "收件箱",
    meta: {
      aria: "收件箱请求元数据",
      project: "项目",
      runnerWorkspace: "本地工作空间",
      runnerRequest: "本地请求",
      created: "创建时间",
    },
    response: {
      kicker: "操作员响应",
      title: "回答请求",
      answer: "回答",
      answerPlaceholder: "回复本地请求",
      requiredMark: " *",
      previewOnly: "仅供预览的上下文。此提示不需要回答。",
      operatorNote: "操作员备注",
      operatorNotePlaceholder: "可选：随审计记录一起保存的投递备注",
      send: "发送回答",
      cancel: "取消请求",
      archive: "归档",
      recordedTitle: "响应已记录",
      statusPrefix: "状态：",
      runnerAcked: "Spark 桥接已确认",
      waitingAck: "等待 Spark 桥接确认",
      closedTitle: "请求已关闭",
      closedBody: "这个收件箱条目已不再待处理。",
    },
    audit: {
      kicker: "Spark 运行上下文",
      title: "投递审计",
      requestStatus: "请求状态",
      inboxStatus: "收件箱状态",
      responseStatus: "响应状态",
      deliveryAttempts: "投递次数",
      lastDelivery: "最近投递",
      rawContext: "原始上下文",
    },
    formMessages: {
      alreadyResolved: "这个收件箱条目已经解决。",
      unsupportedStatus: "不支持这种响应状态。",
      answerRequired: "请填写回答内容。",
      missingRequiredPrefix: "缺少必答项：",
      recordFailed: "记录响应失败。",
    },
  },
  repos: {
    headTitle: "资源 · Navia",
    hero: {
      eyebrow: "工作空间上下文",
      title: "仓库与资源",
      lede: "为工作空间登记可被智能体和项目引用的资源。仓库是一等资源，文档、URL、文件、工具和密钥引用与它并列。",
    },
    metrics: {
      aria: "资源状态",
      total: "总数",
      repos: "仓库",
      available: "可用",
      archived: "已归档",
    },
    emptyWorkspace: {
      title: "先创建工作空间",
      body: "资源隶属于服务端可见的工作空间。",
      action: "打开概览",
    },
    list: {
      title: "资源",
      totalSuffix: "总计",
      emptyTitle: "还没有资源",
      emptyBody: "添加仓库、文档、URL、文件、工具或密钥引用，供后续项目使用。",
      linkedProjects: "关联项目",
      updatedPrefix: "更新于",
      restore: "恢复",
      archive: "归档",
    },
    create: {
      kicker: "新资源",
      title: "添加资源",
      kind: "类型",
      name: "名称",
      namePlaceholder: "navia workspace repo",
      uri: "URI",
      uriPlaceholder: "file:///workspace/navia 或 https://...",
      notes: "备注",
      notesPlaceholder: "智能体需要了解这个资源的哪些信息？",
      submit: "添加资源",
    },
    formMessages: {
      unsupportedKind: "不支持这种资源类型。",
      nameRequired: "请填写资源名称。",
      missingId: "缺少资源 id。",
    },
  },
  agents: {
    headTitle: "智能体 · Navia",
    hero: {
      eyebrow: "智能体规格",
      title: "智能体",
      lede: "可复用的工作空间级智能体规格。执行仍发生在本地服务内；这些规格描述推荐角色、指令以及启用状态。",
    },
    metrics: {
      aria: "智能体规格状态",
      total: "总数",
      active: "活跃",
      disabled: "已禁用",
      archived: "已归档",
    },
    emptyWorkspace: {
      title: "先创建工作空间",
      body: "智能体规格隶属于活跃工作空间。",
      action: "打开概览",
    },
    list: {
      title: "智能体规格",
      totalSuffix: "总计",
      emptyTitle: "还没有智能体规格",
      emptyBody: "为这个工作空间添加可复用的执行者、评审者、规划者或导入规格。",
      updatedPrefix: "更新于",
      disable: "禁用",
      enable: "启用",
      restore: "恢复",
      archive: "归档",
    },
    create: {
      kicker: "新规格",
      title: "添加智能体规格",
      name: "名称",
      namePlaceholder: "reviewer",
      source: "来源",
      roleHint: "角色提示",
      roleHintPlaceholder: "role:builtin-reviewer",
      description: "描述",
      descriptionPlaceholder: "评审项目证据和任务结果",
      instructions: "指令",
      instructionsPlaceholder: "这个智能体应该关注什么？",
      submit: "添加智能体规格",
    },
    formMessages: {
      nameRequired: "请填写智能体规格名称。",
      unsupportedSource: "不支持这种智能体来源。",
      createFailed: "创建智能体规格失败。",
      invalidStatus: "无效的智能体状态更新。",
    },
  },
  artifacts: {
    headTitle: "产物 · Navia",
    hero: {
      eyebrow: "证据",
      title: "产物",
      lede: "Spark 支撑的运行和人工产出的证据会以投影元数据的形式出现在这里。规范内容仍保留在 Spark 产物存储和本地文件中，直到你请求预览或导出。",
    },
    metrics: {
      aria: "产物状态",
      total: "总数",
      workspaceScope: "工作空间范围",
      projectScope: "项目范围",
      previewCached: "已缓存预览",
    },
    emptyWorkspace: {
      title: "先创建工作空间",
      body: "产物隶属于 Spark 工作空间投影。",
      action: "打开概览",
    },
    empty: {
      title: "还没有产物",
      body: "Spark 运行产物和操作员回复产物会带着来源和内容指针出现在这里。",
    },
    list: {
      title: "证据板",
      projectedSuffix: "已接收",
      links: "链接",
      notCached: "未缓存",
    },
  },
  artifactDetail: {
    headTitleSuffix: "产物",
    evidenceLabel: "证据",
    meta: {
      aria: "产物元数据",
      source: "来源",
      size: "大小",
      runner: "本地服务",
      previewCache: "预览缓存",
    },
    provenance: {
      kicker: "可追溯性",
      title: "来源",
      project: "项目",
      invocation: "调用",
      humanRequest: "人工请求",
      links: "链接",
      json: "来源 JSON",
    },
    cache: {
      kicker: "延迟缓存",
      title: "预览与导出指针",
      registered: "预览缓存已登记",
      notPrepared: "预览缓存尚未准备",
      body: "Navia 在服务端产物缓存中保留预览与导出文件。规范内容仍保留在本地，不会提前复制。",
      state: "状态",
      path: "路径",
      mime: "MIME",
      lastAccessed: "最近访问",
      prepare: "准备预览缓存",
      openApi: "打开缓存 API",
    },
    preview: {
      kicker: "延迟预览",
      title: "缓存内容",
      statusHint: "状态说明",
      state: "状态",
      mime: "MIME",
      size: "大小",
      fetched: "获取时间",
      openFull: "打开完整内容",
      openRaw: "打开原始内容",
      nonTextPrefix: "预览内容不是文本；请通过以下入口下载：",
      contentEndpoint: "内容端点",
      probe: "探测内容端点",
      truncatedPrefix: "内联预览截断于",
      statusLabels: {
        ready: "预览已就绪",
        missing: "预览未缓存",
        fetching: "预览获取中",
        too_large: "预览过大",
        unsupported_binary: "二进制内容",
        error: "预览错误",
        evicted: "预览已淘汰",
      },
      statusHints: {
        ready: "缓存预览如下所示。",
        missing: "服务端还没有获取预览内容。当运行时提供预览时，可点击“准备预览缓存”拉取。",
        fetching: "服务端正在拉取预览缓存。",
        too_large: "产物正文超出内联预览的容量。请通过运行时路径打开规范内容。",
        unsupported_binary: "二进制产物不做内联预览。请使用规范指针下载。",
        error: "服务端构建预览失败。请查看缓存记录了解详情。",
        evicted: "缓存预览已被淘汰。重新准备可获取新的预览。",
      },
    },
    content: {
      kicker: "内容指针",
      title: "规范引用",
    },
    formMessages: {
      prepareFailed: "准备产物预览失败。",
    },
  },
  settings: {
    headTitle: "设置 · Navia",
    general: {
      eyebrow: "设置",
      title: "设置",
      lede: "在一个控制台里管理当前工作空间、注册命令和本地连接健康。",
      account: {
        kicker: "账号",
        title: "本地所有者",
        body: "后续在这里配置所有者资料、会话偏好和团队访问控制。",
      },
      workspace: {
        kicker: "工作空间默认值",
        title: "工作空间偏好",
        body: "后续把默认配置、命名规则和项目模板迁移到这里。",
      },
      profiles: {
        kicker: "配置",
        title: "工作空间配置",
        body: "后续在这里管理配置导入、保存为配置，以及 Git 同步控制。",
      },
    },
    navigation: {
      aria: "设置分组",
      title: "设置",
      connections: "连接",
      workspaceBindings: "工作空间目录",
      runnerSetup: "注册设置",
    },
    hero: {
      eyebrow: "设置",
      title: "工作空间设置",
      lede: "管理当前工作空间及其本地连接。",
      ledeRest: "工作空间与项目导航仍位于主应用中。",
      copyCommand: "复制注册命令",
      createToken: "创建注册命令",
    },
    workspace: {
      kicker: "工作空间",
      title: "工作空间设置",
      body: "编辑这个工作空间在服务端可见的名称、路径标识和描述。",
      name: "工作空间名称",
      slug: "路径标识",
      description: "描述",
      descriptionPlaceholder: "可选：这个工作空间的上下文",
      created: "创建于",
      updated: "更新于",
      save: "保存设置",
    },
    enrollment: {
      kicker: "工作空间注册",
      title: "注册 token",
      body: "为工作空间注册创建一次性 token。明文 token 仅在创建时显示一次；之后设置页只列出元数据。",
      label: "Token 标签",
      labelPlaceholder: "本地工作空间",
      createToken: "生成命令",
      tokenCreatedAria: "已创建工作空间注册 token",
      tokenCreatedTitle: "注册 token 已创建 — 仅显示一次",
      tokenCreatedHint:
        "请现在复制命令。Navia 只保留 token 哈希，之后无法再次显示这个密钥。命令连接后，工作空间目录会出现在这里。",
      expiresPrefix: "过期时间",
      commandLabel: "工作空间注册命令",
      tokenLabel: "注册 token",
      tableTitle: "注册 token 清单",
      tableCount: "个 token",
      emptyTitle: "还没有注册 token",
      emptyBody: "生成一条注册命令，让本地工作空间目录上线。",
      defaultTokenLabel: "工作空间注册",
      notUsed: "未使用",
      revoke: "撤销",
      created: "创建时间",
      expires: "过期时间",
      runner: "使用者",
    },
    summary: {
      onlineRunners: "在线连接",
      workspaceBindings: "工作空间绑定",
      offlineRunners: "离线连接",
    },
    metrics: {
      aria: "连接状态",
      runnerConnections: "工作空间连接",
      workspaceBindings: "工作空间目录",
      offlineRunners: "离线连接",
      offlineHint: "陈旧连接清理尚未启用",
    },
    table: {
      runner: "本地服务",
      installation: "安装标识",
      status: "状态",
      lastSeen: "最近上报",
      workspace: "工作空间",
      updated: "更新时间",
    },
    runner: {
      kicker: "本地服务协议",
      title: "已注册的本地服务",
      badge: "/api/v1/runtime/*",
      emptyTitle: "还没有本地服务注册",
      emptyBody: "在本页生成注册命令，然后运行 navia ws register 连接到",
      installationMissing: "未上报 installation id",
      protocolPending: "协议待上报",
      routesLabel: "本地服务协议路由",
    },
    setup: {
      kicker: "注册设置",
      title: "Spark 桥接 CLI 流程",
      steps: [
        {
          title: "创建工作空间注册 token",
          description: "由本地所有者会话生成一次性工作空间注册 token，并交换为本地服务凭证。",
          status: "ready",
        },
        {
          title: "启动本地 Navia 服务",
          description:
            "本地服务负责服务端 WebSocket 和工作空间注册表，并通过 Spark 运行时原语投影任务图、产物以及 ask/review。",
          status: "planned",
        },
        {
          title: "接入 Spark 运行桥接",
          description:
            "Pi、Codex、Claude Code 以及未来适配器通过本地 IPC 与本地服务通信，不直接连接 Navia 服务端。",
          status: "planned",
        },
      ],
    },
    bindings: {
      kicker: "工作空间目录清单",
      title: "已上报目录",
      emptyTitle: "还没有上报工作空间目录",
      empty: "还没有上报工作空间目录。在",
      emptyRest: "之后，目录会先出现在这里，再进入主导航。",
    },
    formMessages: {
      workspaceRequired: "请填写工作空间名称和路径标识。",
      slugUsed: "该工作空间路径标识已被使用。",
      saved: "工作空间设置已保存。",
      commandCreated: "注册命令已创建。它只显示一次，之后无法再次查看。",
      tokenIdRequired: "Token id 必填。",
      tokenRevoked: "注册 token 已撤销。",
      tokenNotActive: "该注册 token 不是活跃状态。",
    },
  },
  setup: {
    headTitle: "设置 Navia",
    introAria: "Navia 设置介绍",
    eyebrow: "Spark 本地驾驶舱",
    title: "把你的本地工作空间汇入一个精确的驾驶舱。",
    lede: "浏览器只与本地 Navia 服务端交互；Spark 运行时状态拥有执行、产物与任务图，Navia 负责渲染投影。",
    features: {
      workspaceOverview: "工作空间优先概览",
      humanDecisions: "等到回答为止的人工决策",
      artifactEvidence: "Spark 产物证据",
    },
    firstRun: "首次运行",
    createOwner: "初始化 Navia",
    panelCopy: "这个 Spark 本地驾驶舱需要先创建一个所有者，才能管理本地工作空间连接和运行时投影。",
    fields: {
      displayName: "显示名称",
      email: "邮箱（可选）",
    },
    action: "继续",
    errors: {
      displayNameMin: "显示名称至少需要 2 个字符。",
      ownerExists: "Navia 所有者已经设置完成。",
    },
  },
};

const dictionaries = {
  en,
  "zh-CN": zhCN,
} satisfies Record<Locale, AppMessages>;

export function getDictionary(locale: Locale): AppMessages {
  return dictionaries[locale];
}

export function resolveRequestLocale(input: {
  requestedLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  return matchLocale([
    input.requestedLocale,
    input.cookieLocale,
    ...parseAcceptLanguage(input.acceptLanguage ?? null),
  ]);
}

export function getRequestDictionary(input: {
  requestedLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): AppMessages {
  return getDictionary(resolveRequestLocale(input));
}

export function parseAcceptLanguage(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));

      return {
        tag: tag.trim(),
        weight: q ? Number(q.slice(2)) : 1,
      };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.tag);
}

export function matchLocale(candidates: Iterable<string | null | undefined>): Locale {
  for (const candidate of candidates) {
    const tag = candidate?.trim().toLowerCase();
    if (!tag) {
      continue;
    }

    if (tag === "zh" || tag === "zh-cn" || tag === "zh-hans" || tag.startsWith("zh-")) {
      return "zh-CN";
    }

    if (tag === "en" || tag === "en-us" || tag.startsWith("en-")) {
      return "en";
    }
  }

  return defaultLocale;
}

export function formatRelativeTime(
  value: string | null,
  locale: Locale,
  messages: AppMessages["common"],
) {
  if (!value) {
    return messages.never;
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const deltaMs = timestamp - Date.now();
  const absMs = Math.abs(deltaMs);
  if (absMs < 60_000) {
    return messages.justNow;
  }

  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "short",
  });

  const minutes = Math.round(deltaMs / 60_000);
  if (Math.abs(minutes) < 60) {
    return formatter.format(minutes, "minute");
  }

  const hours = Math.round(deltaMs / 3_600_000);
  if (Math.abs(hours) < 24) {
    return formatter.format(hours, "hour");
  }

  const days = Math.round(deltaMs / 86_400_000);
  if (Math.abs(days) < 7) {
    return formatter.format(days, "day");
  }

  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function statusLabel(status: string, messages: AppMessages["common"]) {
  return (
    messages.status[status as keyof AppMessages["common"]["status"]] ?? status.replaceAll("_", " ")
  );
}

export function enumLabel(
  value: string | null | undefined,
  labels: Record<string, string>,
  fallback?: string,
) {
  if (!value) {
    return fallback ?? "";
  }

  return labels[value] ?? value.replaceAll("_", " ");
}

export function formatByteSize(
  value: number | null,
  locale: Locale,
  messages: AppMessages["common"],
) {
  if (value == null) {
    return messages.unknownSize;
  }

  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  });

  if (value < 1024) {
    return `${formatter.format(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${formatter.format(value / 1024)} KB`;
  }
  return `${formatter.format(value / 1024 / 1024)} MB`;
}
