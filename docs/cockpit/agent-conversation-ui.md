# Spark Cockpit agent conversation UI

Status: active; Phase 1 shell and source-derived model selector implemented, structured parts in progress

Last reviewed: 2026-07-13

## Decision

Spark Cockpit will adopt selected Svelte AI Elements source components as presentation code without adopting AI SDK as its model, agent, chat-state, or transport runtime.

The target composition is:

```text
@earendil-works/pi-ai
        │ model stream
        ▼
@zendev-lab/spark-turn + Spark host tools
        │ Spark-owned turn/tool events
        ▼
Spark daemon and durable session/task/artifact stores
        │ native session JSONL + session.snapshot RPC
        ▼
spark-protocol SparkSessionView
        │ route load + session-timeline.ts adapter
        ▼
SessionsWorkspace shell and Cockpit-owned conversation view models
        │ presentation-only mapping
        ▼
Svelte AI Elements-derived components (incremental)
        + @humanspeak/svelte-virtual-chat (after the projection contract is stable)
```

This preserves Spark's current provider and execution model while gaining a richer Svelte conversation interface.

## Goals

- Deliver a polished agent conversation surface for messages, reasoning, tools, sources, tasks, approvals, attachments, and queued prompts.
- Keep `pi-ai` as the default model provider layer and retain its subscription OAuth support.
- Keep tool discovery, approval, execution, timeout, cancellation, result compaction, and audit behavior under Spark control.
- Keep the Spark daemon/session registry and Spark task/artifact stores as durable truth.
- Let Cockpit render reconnectable projections rather than own a second conversation.
- Adopt UI source incrementally so each component can be reviewed, restyled, and tested locally.
- Support long, streaming conversations without scroll jumps or an unbounded DOM.

## Non-goals

- Replacing `pi-ai` with AI SDK providers to obtain UI components.
- Replacing `spark-turn` with an AI SDK agent loop.
- Introducing `@ai-sdk/svelte`, `Chat`, `useChat`, `UIMessage`, or an AI SDK data-stream transport as Cockpit state owners.
- Treating autonomous coding agents such as Codex CLI as ordinary side-effect-free language models.
- Persisting Cockpit-local message history independently of Spark.
- Importing the complete Svelte AI Elements registry, examples, documentation site, or API routes.
- Replacing Spark's artifact-backed `spark.ui.v1` generative UI contract.

## Why the provider should not change for the UI

Provider selection and presentation are independent concerns.

Spark's current path gives the host explicit control over a model tool call before execution:

```text
model tool call
  -> Spark permission and policy
  -> Spark tool implementation
  -> Spark event and audit record
  -> tool result returned to model
```

A CLI-backed provider such as `ai-sdk-provider-codex-cli` delegates the internal agent loop to Codex CLI. It can use a ChatGPT Plus/Pro subscription by spawning an already authenticated `codex` process, but Codex owns its shell, patch, search, and MCP activity. That is useful as an external role executor, not as a reason to replace Spark's default model path.

AI SDK remains a valid future integration at explicit boundaries:

- an optional ordinary `AiSdkModelExecutor` for providers that lack a suitable `pi-ai` implementation;
- a `CodexCliRoleExecutor` or `HarnessRoleExecutor` for external coding agents;
- a one-way UI compatibility adapter for third-party AI SDK presentation plugins.

These integrations must not make AI SDK chat state or an external agent thread the authoritative Spark session.

## Authentication and execution matrix

This is the reviewed integration snapshot behind the decision. Product subscription OAuth and provider API-key support are different capabilities.

| Path | ChatGPT Plus/Pro | Other subscription OAuth | Execution shape | Appropriate Spark boundary |
| --- | --- | --- | --- | --- |
| Pi CLI / Pi SDK with normal agent configuration | Built-in `openai-codex` OAuth | Claude Pro/Max and GitHub Copilot OAuth are built in | Pi model/agent runtime | Existing Pi compatibility host or explicitly configured Pi SDK use |
| `pi-ai` behind Spark's provider boundary | Bundled `openai-codex` adapter with Spark-owned OAuth storage | Same provider primitives can be added through the shared adapter | Ordinary model stream; Spark owns the tool loop | Default `ModelExecutor` path |
| `@ai-sdk/openai` | No; OpenAI API key only | No | Ordinary AI SDK language model | Optional isolated `AiSdkModelExecutor` |
| `@ai-sdk/harness-pi` | Not inherited from the user's normal Pi login by default; current adapter creates isolated per-session auth state and exposes gateway/API-key options | Not inherited by default | Pi runtime adapted to experimental `HarnessV1` | Optional external role executor |
| `@ai-sdk/harness-codex` | Not inherited from the host by default in its sandbox bridge design; current public auth options are OpenAI-compatible/OpenAI/Gateway API keys | No | Codex SDK/CLI bridge in a network sandbox | Optional external role executor |
| `ai-sdk-provider-codex-cli` | Yes, by delegating to an installed `codex` that reads `~/.codex/auth.json` after `codex login` | No | `codex exec` per call or persistent `codex app-server` | `CodexCliRoleExecutor`, preferably app-server mode |

`ai-sdk-provider-codex-cli` does not take ownership of the subscription protocol itself. The community provider starts the official CLI; the CLI owns OAuth refresh, subscription limits, model availability, and backend protocol. The process must run with the authenticated user's `HOME`. In a container, sandbox, daemon account, or remote worker with a different home directory, the login is not automatically present.

The same package implements AI SDK's language-model interface, but Codex remains an autonomous coding agent: its shell, patch, web, and MCP actions are provider-executed side effects. Spark must not present that path as behaviorally equivalent to `pi-ai` or `@ai-sdk/openai`.

## State ownership

The ownership rules in [`../architecture/cockpit-projection.md`](../architecture/cockpit-projection.md) remain authoritative.

| Concern | Owner | Cockpit responsibility |
| --- | --- | --- |
| Model/provider credentials | Spark/Pi auth and provider registry | Display configuration and availability only |
| Turn execution | `spark-turn` and Spark host | Submit turns and project events |
| Tool policy and execution | Spark host/capability packages | Render state and submit approval decisions |
| Session history | Spark session registry/daemon | Render a reconnectable projection |
| Tasks, plans, runs, TODOs | Spark task/runtime stores | Render linked projections and commands |
| Artifacts and evidence | Spark artifact store | Render previews and links |
| Human asks/reviews | Spark ask/review flows | Render inbox/inline decisions and submit answers |
| Draft text and local file previews | Cockpit component state | Ephemeral until submitted/uploaded |
| Scroll position and expanded panels | Cockpit component state | Ephemeral presentation preference |

Cockpit may use optimistic rows for a submitted prompt, but each row must reconcile to a stable daemon turn/message ID. It must not become durable history if the turn is rejected or lost. Display text, actor, timestamps, and array indexes are not identity.

## Conversation scope and navigation

Conversation scope is explicit daemon state, not a Cockpit grouping guess:

```ts
type SparkSessionScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "daemon"; daemonId: string };
```

The Sessions rail renders only conversations owned by the active workspace and
explicit daemon-global conversations. It never pulls in sessions from other
workspaces, and it never promotes a legacy or unmapped `workspaceId` to global.
Daemon-global records are grouped by daemon identity.

New conversation has two direct entry actions: **Workspace chat** and **Global
chat**. Workspace chat implicitly uses the active workspace; there is no
workspace selector in the composer. Global chat is valid even when the daemon
has no registered workspace. The daemon injects its own installation id and
freezes the execution directory when it creates either scope.

## Presentation contract

Cockpit should introduce a local presentation model. It is not a daemon protocol and must not be exported from `spark-protocol` until multiple hosts demonstrably need the same wire contract.

A representative shape is:

```ts
export type ConversationPart =
  | { type: "text"; text: string; streaming: boolean }
  | { type: "reasoning"; text: string; state: "streaming" | "complete"; durationMs?: number }
  | { type: "tool"; call: ToolCallView }
  | { type: "source"; source: SourceView }
  | { type: "task"; task: TaskRunView }
  | { type: "approval"; approval: ApprovalView }
  | { type: "artifact"; artifact: ArtifactPreviewView }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "raw"; label: string; value: unknown };

export interface ConversationMessageView {
  id: string;
  commandId?: string;
  invocationId?: string;
  role: "user" | "assistant" | "system";
  state: "pending" | "streaming" | "complete" | "error" | "cancelled";
  createdAt: string;
  parts: ConversationPart[];
}
```

The model should preserve stable IDs and source refs. Rendering adapters must not infer durable identity from array indexes or display text.

Unknown event and content-part types must render as bounded raw fallback rather than disappear. This keeps protocol evolution observable.

Raw generative-UI source is not a normal conversation part. Assistant message
cards render the parsed result without a duplicated `Source` disclosure;
artifact/detail routes may expose the source for diagnostics. A future
`source` part means user-facing provenance or a citation, not the assistant's
raw Markdown repeated underneath its rendered output.

The Cockpit adapter now maps optional `SparkMessageView.parts` into local `ConversationPart` values while retaining `message.text` as the legacy fallback. It consumes only display-safe text, thinking summaries, tool names, tool states, tool summaries, and stable references. Tool call/result parts merge by `toolCallId` before rendering so reload shows one evolving card rather than duplicate call and result rows. Canonical native message IDs remain the row keys. `session.message` activity events reconcile only through their source message IDs; equal display text with a different ID remains a distinct turn. Legacy assignment commands are a fallback only when the native snapshot has no displayable messages, because those command records do not carry a canonical message ID.

## Event mapping

The canonical Sessions route must extend this path:

```text
session.snapshot
  -> SparkSessionView
  -> routes/(workbench)/sessions/[sessionId]/+page.server.ts
  -> session-timeline.ts (today) / conversation projection adapter (target)
  -> SessionsWorkspace and Cockpit-owned presentation components
```

`cockpit-chat-transcript-view.ts` belongs to the older Agents chat surface and is not the starting point for Sessions. Event JSON must still stay out of Svelte components: enrich the daemon snapshot/protocol projection where the information is durable, then map it in a Cockpit-local adapter.

| Spark input | Conversation part | UI behavior |
| --- | --- | --- |
| User turn/request | user text | Optimistic only with a daemon receipt ID; reconciled by canonical message ID |
| `text_delta` / assistant chunks | text | Incremental append with stable message ID |
| `thinking`/reasoning events | reasoning | Open while streaming; user-controlled after completion |
| Tool start/input | tool | Pending/running state with bounded input preview |
| Tool result | tool | Complete/error state with output preview and artifact link where available |
| Ask/review request | approval | Inline action surface backed by canonical Spark command/tool |
| Task/run projection | task | Status, progress, owner, timestamps, and task/run links |
| Web/fetch provenance | source | Safe external link with title and origin |
| Artifact event/ref | artifact | Preview metadata and link to artifact detail |
| Terminal failure/cancel | error | Explicit terminal state; no infinite streaming indicator |
| Unrecognized event | raw | Collapsed diagnostic fallback |

Do not collapse every log line into a tool call. Preserve raw invocation/log diagnostics in a secondary details surface until Spark exposes a canonical structured event for that activity.

## Component strategy

### Shell composition

The live Sessions UI is already one workbench composition and should be split along its existing ownership boundaries rather than rebuilt as a standalone chat page:

| Surface | Current owner | Near-term boundary |
| --- | --- | --- |
| Workbench navigation and conversation rail | `(workbench)/+layout.svelte` + `WorkbenchSessionRail.svelte` | Keep route/session selection and global search in the outer shell |
| Session header and effective status/model context | `SessionsWorkspace.svelte` | Extract a presentational header after model read-back is canonical |
| Conversation viewport | `components/conversation/ConversationViewport.svelte` + `session-timeline.ts` | Projection remains in TypeScript; the component owns scroll position and bounded announcements only |
| Prompt composer and model selector | `components/conversation/Composer.svelte` + `components/model-selector/ModelPicker.svelte` inside the Sessions form | Presentation is extracted while SvelteKit form actions and daemon turn submission remain authoritative |
| Run/session details | Desktop aside and mobile disclosure in `SessionsWorkspace.svelte` | Share one details component between responsive placements |

The intended desktop shell remains conversation rail, central conversation, and right-side details. On narrow screens the rail is owned by the existing workbench drawer and details remain a disclosure. The viewport library and vendored message primitives fit inside the central surface; they do not introduce another router, sidebar, or chat store.

### Source policy

Svelte AI Elements is a community shadcn-svelte source registry, not a stable runtime package contract. Selected files should be copied into a Cockpit-owned directory and treated as maintained application code.

Recommended location:

```text
apps/spark-cockpit/src/lib/components/conversation/
  ConversationViewport.svelte
  Message.svelte
  MessageActions.svelte
  ReasoningPart.svelte
  ToolCallPart.svelte
  TaskRunPart.svelte
  ApprovalPart.svelte
  Composer.svelte
  conversation-view.ts
  types.ts
  VENDOR.md
  UPSTREAM-LICENSE.txt

apps/spark-cockpit/src/lib/components/model-selector/
  ModelPicker.svelte
  VENDOR.md
  UPSTREAM-LICENSE.txt
```

Names should describe Spark semantics rather than retain upstream `UIMessage` or `ToolUIPart` terminology.

Each imported source group must record:

- upstream repository and commit SHA;
- original file paths;
- license;
- import date;
- substantive local changes;
- last reviewed upstream commit.

Keep this in a small `VENDOR.md` beside the components. Upstream updates are reviewed and ported deliberately; no install-time overwrite or unpinned registry command belongs in CI.

### Component selection

| Capability | Starting source | Local treatment |
| --- | --- | --- |
| Long conversation viewport | `@humanspeak/svelte-virtual-chat` | Use as a dependency; generic messages and snippets keep it state-neutral |
| Message layout/actions | Svelte AI Elements Message | Vendor layout/actions; replace upstream part assumptions with `ConversationPart` |
| Reasoning | Svelte AI Elements Reasoning | Vendor collapsible behavior; consume Spark state and existing safe content rendering |
| Tool display | Svelte AI Elements Tool | Vendor visuals; replace copied AI SDK state vocabulary with Spark tool states |
| Sources | Svelte AI Elements Sources | Vendor with safe URL handling and provenance fields |
| Task/run | Svelte AI Elements Task | Vendor visuals; bind to Spark task/run refs and statuses |
| Approval/confirmation | Svelte AI Elements Confirmation | Bind actions to Spark ask/review/approval commands |
| Model selection | Svelte AI Elements Model Selector | Source-derived searchable dialog; adapt Spark provider groups and use Bits UI only for accessible Dialog/Command behavior |
| Prompt composer | Sessions form in `SessionsWorkspace.svelte` plus selected Prompt Input ideas | Extract and evolve locally; do not import `FileUIPart` or provider transport |
| Markdown/MDX | Existing `SafeMarkdown` / `AgentMdxStream` | Retain current security boundary initially |
| Generative UI | Existing `SparkUiRenderer` and `spark.ui.v1` | Keep separate and embed as an artifact/generative part |

### Why use `svelte-virtual-chat`

The Svelte AI Elements conversation component provides basic stick-to-bottom behavior, but Cockpit needs predictable long-session behavior:

- visible-message virtualization;
- stable bottom following while streamed content changes height;
- no forced snap when the user scrolls away;
- history prepend with anchor preservation;
- stable message-ID identity;
- explicit scrolling and debug APIs.

`@humanspeak/svelte-virtual-chat` is Svelte 5-native, accepts arbitrary generic messages through snippets, and has only `esm-env` as a runtime dependency. It does not know about providers, transports, tools, or message schemas.

Virtualization has an accessibility trade-off because off-screen messages are absent from the DOM. Cockpit must provide a separate bounded `aria-live="polite"` announcement for new assistant text and a visible jump-to-latest control.

## Tool-state mapping

Do not retain the AI SDK names `input-streaming`, `input-available`, `output-available`, and `output-error` as the Cockpit domain model.

Use Spark-oriented states and map to visual treatments locally:

| Spark state | Visual state | Notes |
| --- | --- | --- |
| `pending` | pending | Call announced but input/execution not ready |
| `awaiting-approval` | attention | Show canonical approval action |
| `running` | running | Input is inspectable; output may stream |
| `completed` | success | Result available |
| `failed` | danger | Error text and diagnostics available |
| `denied` | neutral terminal | Clearly distinguish user/policy denial from failure |
| `cancelled` | neutral terminal | Never leave a spinner active |

Tool input/output must be rendered as structured JSON when possible, with bounded depth/size and an explicit raw view. Large output belongs in an artifact or log detail rather than an unbounded message panel.

## Composer and attachments

The canonical Sessions page currently owns a SvelteKit-enhanced form in `SessionsWorkspace.svelte`. It submits through the Sessions route action and the daemon `turn.submit` control plane. `CockpitChatComposer.svelte` belongs to the older Agents chat surface; its queueing/steering behavior must not be assumed to exist on Sessions or imported as a second state owner.

First extract the Sessions form into Cockpit-owned presentational subcomponents while preserving its action and daemon submission path. Queueing, steering, cancellation, retry, and attachment submission require explicit Sessions/daemon contracts before their controls are exposed.

The local attachment type should be Spark-owned:

```ts
export interface AttachmentDraft {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  state: "local" | "uploading" | "ready" | "error";
  previewUrl?: string;
  contentRef?: string;
  error?: string;
}
```

Rules:

- Blob URLs are ephemeral and revoked when removed or unmounted.
- Submitted attachments use Spark content/artifact refs, not base64 copied into durable Cockpit message state.
- Upload size, type, and count limits are validated server-side as well as in the component.
- Queue and steering, when implemented for Sessions, remain daemon control-plane operations.
- Stop/cancel targets the active Spark invocation, not a browser fetch controller alone.
- Enter/Shift+Enter behavior, IME composition, paste, keyboard focus, and mobile layout require tests.

## Styling and dependencies

Cockpit's visual authority remains [`visual-design.md`](./visual-design.md), with executable tokens in `apps/spark-cockpit/src/lib/tokens.css`.

Svelte AI Elements source assumes Tailwind/shadcn-style semantic classes. There are two acceptable implementation paths:

1. Translate selected components to scoped CSS using existing Spark tokens.
2. Introduce Tailwind v4 only inside `apps/spark-cockpit`, then map shadcn semantic variables to Spark tokens.

Start with scoped token CSS for the first vertical slice. Introduce Tailwind only if repeated utility translation becomes a measured maintenance problem. This avoids making a broad styling-stack decision before the component set is proven.

If Tailwind is introduced:

- isolate it to Cockpit;
- do not change shared non-Svelte package checks;
- map `background`, `foreground`, `muted`, `border`, `destructive`, and ring variables to existing Spark tokens;
- do not copy upstream colors, large radii, or decorative styling;
- keep cards at the radii and density required by the Cockpit visual design;
- keep `tokens.css` and `visual-design.md` in sync.

Expected minimum dependencies should remain small:

- existing `@lucide/svelte` for icons;
- `@humanspeak/svelte-virtual-chat` for the viewport;
- selected Bits UI primitives only when accessible interaction is non-trivial;
- no `ai` or `@ai-sdk/svelte` dependency for this work.

Avoid importing `streamdown-svelte`, Shiki, KaTeX, or another Markdown stack in the first wave. Re-evaluate Markdown separately with security, bundle-size, streaming, code-block, and accessibility evidence.

## Security

- Continue to treat assistant Markdown, tool output, source metadata, and generated UI as untrusted input.
- Keep raw HTML disabled unless a separately reviewed sanitizer contract permits it.
- Validate source URLs and allow only expected external schemes; never render `javascript:` links.
- Do not render arbitrary Svelte components named by model output. `spark.ui.v1` remains catalog-driven.
- Escape tool names, arguments, logs, and error text by default.
- Bound JSON rendering by byte size, depth, array length, and string length.
- Keep approval actions explicit about command, scope, and target. A visual button must invoke the canonical Spark approval path.
- Never expose provider credentials or OAuth tokens in Cockpit projections, logs, component props, or client bundles.

## Accessibility and interaction

- Conversation messages use stable landmarks and labels without announcing every streamed token.
- A separate throttled live region announces meaningful new assistant text and terminal state changes.
- Icon-only actions have accessible names and tooltips.
- Tool, reasoning, source, and task disclosure controls are keyboard operable and expose expanded state.
- Focus returns predictably after approval, cancellation, retry, and attachment removal.
- Status is communicated with text/icon in addition to color.
- Respect `prefers-reduced-motion` for scrolling, shimmer, caret, and disclosure animations.
- Mobile controls maintain at least a 40px effective touch target.

## Internationalization

All visible labels, status names, empty states, errors, and action text continue through `spark-i18n`. Vendored upstream English strings must not remain embedded in components.

Content supplied by the model, tools, or external sources is not translated. Structural labels around that content are translated.

## Alternatives considered

### Switch the model layer to AI SDK

Rejected for this goal. UI components do not justify replacing provider routing, subscription OAuth, usage accounting, and Spark's tool-control boundary.

### Use `@ai-sdk/svelte`

Rejected as the primary Cockpit state path. It would introduce a second message list, transport lifecycle, retry model, and tool state alongside Spark's daemon/session truth.

### Use Svelte AI Elements unchanged

Rejected. Prompt Input imports AI SDK's `FileUIPart`, tool components copy AI SDK state terms, and upstream styling/dependencies do not match Cockpit's established design authority.

### Use `sveltechatkit` or `@agentskit/svelte`

Rejected for the main conversation. They are provider-independent but own chat/store/transport or agent-memory behavior, recreating the same state-ownership conflict under a different API.

### Use `@kitn.ai/ui`

Not selected for the main Cockpit. Its Shadow DOM Web Components are useful for embeddable widgets, but they make token integration, deep tool/task customization, and native Svelte typing harder. Its dependency surface is also broader than needed.

### Use `@ljoukov/chat`

Keep as a reference/prototyping candidate. It has a useful provider-neutral part model and composer/task surfaces, but its current `0.1.x` maturity and small adoption base are not strong enough to make its public types a Spark boundary.

### Build every primitive from scratch

Rejected. Use a focused virtualization library and reviewed accessible primitives where they remove real complexity; own only the Spark-specific composition and projection mapping.

## Implementation boundary

### P0: implement on current contracts

- Treat `session.snapshot -> SparkSessionView` as the authoritative Sessions transcript.
- Reconcile canonical and live `session.message` projections by source ID, never by normalized text.
- Keep assignment/activity rows as internal detail or empty-snapshot compatibility, not a second transcript.
- Extract the existing header, text-message viewport, composer presentation, and responsive details shell without changing ownership.
- Display and read back the effective session model from the daemon after a switch.
- Add deterministic tests for repeated equal messages, snapshot/event reconciliation, form submission, reload, and responsive shell behavior.

P0 deliberately keeps the existing text timeline and scoped token CSS. The model selector uses the
small Bits UI Dialog/Command boundary for focus, keyboard, and accessibility behavior; it does not add
AI SDK, a new provider runtime, Tailwind, or a virtual viewport dependency.

The implemented scope slice also keeps the primary navigation, one settings-hub
entry, and the workspace switcher in one bottom sidebar region. The hub preserves
the active workspace context while its Console navigation keeps global and
workspace settings as separate ownership scopes. This is shell composition only;
it does not move settings or workspace ownership into the conversation component.

### P1: requires daemon/protocol support

- Populate stable structured reasoning, tool, approval, source, task, artifact, and error parts in a reconnectable projection.
- Add per-session event cursors, replay semantics, history pagination, and prepend anchors before virtualizing the transcript.
- Add durable queue, steer, cancel, retry, and edit semantics to the Sessions control plane.
- Add attachment upload/content refs, validation, and lifecycle cleanup.
- Return stable optimistic-turn/message reconciliation IDs in the submit receipt when optimistic rows are introduced.

These are not presentation-only changes. Controls must remain absent or explicitly unavailable until the owning daemon contract exists.

## Delivery plan

### Phase 0: fixtures and contract

- Keep the existing `SparkSessionView -> session-timeline.ts` adapter as the first vertical slice.
- Add deterministic fixtures for repeated text, canonical/event ID reconciliation, hidden/non-conversation messages, and empty-snapshot legacy fallback.
- Define richer local `ConversationMessageView` and `ConversationPart` types only as structured daemon inputs become available.
- Add projection tests proving stable IDs and that display text never acts as durable identity.

Exit criteria: the text transcript reloads from `session.snapshot`, repeated equal messages remain distinct, activity replay does not duplicate canonical IDs, and no AI SDK types enter the path.

### Phase 1: viewport and message shell — implemented

- Extract the message shell and composer presentation while retaining the existing session header and shared desktop/mobile details content in `SessionsWorkspace.svelte`.
- Add local message layout/actions derived from selected Svelte AI Elements source, with pinned provenance and the complete upstream MIT notice.
- Preserve the existing empty state, status labels, and run details.
- Add bottom-following that does not pull a user who scrolled away, a jump-to-latest action, bounded terminal announcements, message copy, and IME-safe Enter submission.
- Add `@humanspeak/svelte-virtual-chat` only after cursor pagination/replay and stable structured message identity are available.
- Replace hand-rolled transcript scrolling with a generic virtual viewport at that point.

Exit criteria: the shell is componentized without moving state ownership; once virtualization is enabled, long history, streamed growth, scroll-away, jump-to-latest, and history prepend work on desktop and mobile.

### Phase 2: structured agent parts — first projection slice implemented

- Add Reasoning, ToolCall, TaskRun, and Approval shells. Sources, ArtifactPreview, and richer unknown-event diagnostics remain pending.
- Extend the projection builder to emit ordered text, thinking, and tool call/result parts, with legacy text fallback and tool call/result merging by stable call ID.
- Keep invocation/log detail available during the transition.
- Connect approvals and task/artifact links to canonical Spark actions/routes.

Exit criteria: no supported structured event is flattened into opaque prose unless its raw fallback is intentionally selected.

### Phase 3: composer

- Refactor the Sessions composer in `SessionsWorkspace.svelte` into presentational subcomponents while preserving its SvelteKit action and daemon `turn.submit` path.
- Add queue/steer/cancel/retry controls only after the Sessions control-plane contracts are durable and tested.
- Add local attachment drafts and server-backed content refs.
- Add stop, retry, editing, IME, paste, and mobile interaction tests.

Exit criteria: submitting, queueing, steering, stopping, and attachment handling survive reload/reconnect without a second chat store.

### Phase 4: polish and upstream discipline

- Add `VENDOR.md` provenance and a repeatable manual upstream review checklist.
- Complete i18n extraction.
- Measure bundle size and render performance.
- Add Playwright visual and interaction coverage for desktop/mobile, light/dark if dark mode is supported, long tool output, narrow text, and streaming.
- Decide with evidence whether Cockpit should adopt Tailwind v4 or keep scoped token CSS.

Exit criteria: focused package checks, accessibility checks, visual tests, and live daemon smoke all pass.

## Validation

Each implementation phase must include:

- `pnpm --filter @zendev-lab/spark-cockpit run check`;
- `pnpm --filter @zendev-lab/spark-cockpit run test`;
- focused projection/parser tests;
- desktop and mobile Playwright screenshots;
- keyboard-only composer, disclosure, approval, and jump-to-latest checks;
- a live run through a freshly restarted Spark daemon showing prompt, streaming output, at least one real tool call, terminal state, and reconnect/reload;
- no browser console errors or failed network requests;
- no `ai`, `@ai-sdk/svelte`, `UIMessage`, or `useChat` imports in the Cockpit conversation implementation;
- no duplicated durable message/session persistence in Cockpit.

For any later Cue protocol/client work encountered during implementation, follow the separate repository convention: test against a freshly built and restarted real `cued`, verify handshake capabilities, and execute at least one real job in addition to mocks.

## Success measures

- Spark remains the only durable conversation and execution owner.
- Users can inspect reasoning, tools, approvals, task progress, sources, and artifacts without opening raw logs for normal operation.
- A long streaming session does not jump unexpectedly or grow the DOM linearly.
- Reload/reconnect reconstructs the same conversation from Spark projections.
- Tool denial, cancellation, failure, daemon disconnect, and unknown event types are visibly distinct.
- Cockpit adds no AI SDK runtime dependency solely for presentation.
- Provider/runtime choices can evolve independently of the Cockpit component tree.

## Revisit triggers

Reconsider the decision only when one of these becomes true:

- Svelte AI Elements publishes a stable, presentation-only Svelte package with provider-neutral local types and acceptable dependencies.
- AI SDK offers a stateless rendering package that consumes externally owned projections without owning transport/session state.
- Spark standardizes a multi-host conversation projection in `spark-protocol`.
- Cockpit utility-class duplication demonstrates that scoped CSS costs more than an isolated Tailwind v4 setup.
- A provider exists only through AI SDK and its value justifies adding an isolated `AiSdkModelExecutor`.

None of these triggers alone transfers durable session ownership away from Spark.
