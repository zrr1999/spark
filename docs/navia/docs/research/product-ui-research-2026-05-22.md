# Navia Product and UI Reference Research

Date: 2026-05-22

This is the concrete follow-up to `reference-repos.md`. The goal is not to collect pretty dashboards. The goal is to decide what Navia should borrow for its workspace-first agent control plane, and what it should deliberately avoid.

## Scope

Primary repos inspected:

- [multica-ai/multica](https://github.com/multica-ai/multica)
- [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control)
- [stoneforge-ai/stoneforge](https://github.com/stoneforge-ai/stoneforge)
- [kcosr/agent-runner](https://github.com/kcosr/agent-runner)
- [dubinc/dub](https://github.com/dubinc/dub)
- [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- [langfuse/langfuse](https://github.com/langfuse/langfuse)
- [makeplane/plane](https://github.com/makeplane/plane)
- [zrr1999/bonehub](https://github.com/zrr1999/bonehub)
- local `/Users/zhanrongrui/workspace/zrr1999/sixbones.dev`

I read READMEs, route shells, settings pages, sidebar/account switchers, command palette code, runtime/daemon protocol code, and run metadata docs where available. I also checked current package metadata for command/search shortcut libraries.

## Executive Takeaways

1. Navia should keep a light shell: sidebar owns product navigation, search, and account/workspace switching; the topbar should stay a compact breadcrumb/status strip.
2. "No workspace" must be its own setup state, not a fake workspace. The UI should say "create the first workspace" and show a guided setup surface.
3. Settings should be a compact control console, not a hero page: left settings rail, status strip, runtime table, binding table, token/audit sections.
4. Runtime state needs first-class rows: daemon id, runtime id, provider, heartbeat, local workspace binding, capability flags, protocol version, and last error.
5. Command palette should be a real feature later, but the `⌘` glyph itself is just Unicode text in a `<kbd>`. For Svelte, use a small shortcut library plus a Svelte command primitive instead of copying React `cmdk`.
6. Navia should borrow "run metadata / heartbeat / replay" ideas from Trigger.dev and "trace/filter/saved view" ideas from Langfuse for future evidence projection views.
7. Avoid copying Mission Control's 30+ panel density or Multica's issue-first model wholesale. Navia's center should remain workspace projection, runtime connections, project state, asks, task graphs, and artifacts.

## Repo Findings

### Multica

Multica is the closest product neighbor. Its README frames agents as teammates and uses workspaces, runtimes, daemon setup, skills, issues, and squads as the main nouns.

Useful patterns:

- Workspace onboarding is explicit. `StepWorkspace` creates a workspace with name and slug, or lets the user continue with an existing workspace. This is the right mental model for Navia: `activeWorkspace === null` should route to setup, not be displayed as a workspace.
- Runtime onboarding has clear phases: scanning, found, empty. The UI polls briefly, then shows refresh/skip actions. Navia's runtime enrollment can use the same states instead of showing permanent empty cards.
- Settings are grouped into account tabs and workspace tabs with a vertical rail. This maps well to Navia's settings split: account/profile/language plus workspace/runtime/bindings/tokens.
- The daemon protocol exposes useful heartbeat concepts: runtime id, pending update, model list, skill inventory, local skill imports, and a `runtime_gone` ack. Navia should model "runtime no longer exists server-side" explicitly rather than only "offline".

Do not copy:

- Multica is strongly issue/chat centric. Navia should stay projection-first and make projects/task graphs/evidence central.
- Multica's onboarding is polished but fairly editorial. Navia should use only the operational skeleton.

### Mission Control

Mission Control is useful as an operations-density reference. It has grouped sidebar navigation, real-time search, panels for tasks/agents/logs/tokens/security/cron/webhooks/audit, and a bottom sidebar context switcher.

Useful patterns:

- The bottom context switcher is exactly the right interaction family for Navia's account/workspace menu: click to open, fixed backdrop to close, open upward, contains user header, settings shortcuts, org/workspace/project list, create action, and logout.
- Sidebar groups are persisted in localStorage. Navia probably does not need collapsible groups yet, but persisted sidebar/search/account state is a good pattern once the app becomes denser.
- The command search combines quick navigation commands and entity search. It supports `Cmd/Ctrl+K`, `/`, arrow navigation, Enter selection, Escape close, and outside click close.
- The header exposes live connection state, SSE, latency, and local/gateway mode. Navia should borrow the status semantics, but keep them smaller and not let the topbar become crowded.

Do not copy:

- The 32-panel surface is too broad for Navia now.
- The visual language is darker and more gamer/devops-heavy than Navia's current precise light console.

### Dub

Dub is the best reference for polished SaaS workspace/account affordances.

Useful patterns:

- Workspace switcher and user dropdown are separate, both in the sidebar column. The workspace dropdown shows current workspace, plan/member metadata, settings/invite shortcuts, workspace list, selected checkmark, and "Create workspace".
- User dropdown is short and account-focused: user identity, account settings, workspace settings when relevant, referrals/partner switch when relevant, logout.
- Popovers are controlled by click state, not hover. This avoids the "menu disappears before I can click Create workspace" bug.
- Sidebar has a narrow product rail plus area panel. Navia can stay simpler, but the main lesson is that workspace/user switching belongs near persistent navigation, not in the content topbar.

Do not copy:

- Dub separates workspace switcher and user dropdown because it has mature multi-product navigation. Navia can combine user and workspace for now, but the menu should be structured so it can split later.

### Stoneforge

Stoneforge is a good reference for agent-dashboard route vocabulary.

Useful patterns:

- Routes are domain-driven: activity, tasks, plans, agents, workspaces, workflows, metrics, settings, inbox, messages, documents, merge requests, editor.
- `Activity` answers "what is actively happening?" and "what has been accomplished?" with live/offline and daemon status chips. Navia's Overview should answer this same question for runtimes and projections.
- The command palette uses `cmdk` in React and groups commands into Navigation, Tasks, Agents, Workflows, Quick Actions, and Settings. Navia can copy the grouping idea, not the React library.
- Settings are compact and split into Preferences and Workspace. Runtime/daemon settings use polling and mutation hooks with start/stop/wake/config operations.

Do not copy:

- Stoneforge is built for highly parallel local agent operation and includes terminal-heavy workflows. Navia should expose runtime detail, but not become a terminal multiplexer by default.

### Agent Runner

Agent Runner is less polished visually, but strong on durable run semantics.

Useful patterns:

- A run is a persisted execution instance with a manifest as source of truth, append-only audit history, attempts, attachments, schedule, tasks, sessions, lineage, dependencies, and execution controller metadata.
- The daemon exposes HTTP and SSE surfaces for runs, audit, timeline, workspace files, diff, search, resume, queue resume messages, ready, scheduling, attachments.
- Dashboard rows expose status, schedule state, notes, pinned state, attachments, dependencies, and long-press/context action behavior.

How Navia should use this:

- Treat server projections as durable records, not transient UI cards.
- Add audit/timeline concepts early even if the first UI only shows "last heartbeat" and "last snapshot".
- Keep task graph snapshots and artifact/evidence rows append-friendly.

### Trigger.dev

Trigger.dev is the best reference for run lifecycle UX.

Useful patterns:

- Run metadata is structured, can be updated while a task runs, and is surfaced to realtime subscribers and the dashboard.
- Heartbeats have a product-level failure semantic: if no heartbeat arrives within the timeout, a run becomes stalled.
- Replay is a first-class action from both run detail and runs list, with a confirmation modal and editable payload/environment.
- Bulk cancel/replay uses selected rows or filter result sets.

How Navia should use this:

- Runtime heartbeat and projection heartbeat should be separate concepts.
- "Stalled" should be a visible state, not just "offline".
- Future project/task graph runs should have replay/retry semantics tied to the original input and projection version.

### Langfuse

Langfuse is the strongest reference for evidence, trace, filters, and saved views.

Useful patterns:

- `CommandMenuProvider` lives at the app root and the command menu groups main navigation, projects, dashboards, project settings, organization settings, and account settings.
- Settings pages are data-driven page arrays with `cmdKKeywords`, and `PagedSettingsContainer` handles desktop side nav and mobile select.
- Saved view default resolution is explicit: URL query param, session storage, personal default, project default, system default, no view.
- Tables are built around filters, row density, refresh, peek/detail, and persisted view state.

How Navia should use this:

- Evidence/projection pages should eventually support saved views and default view resolution.
- Settings sections should expose command keywords so command palette search works without hand-maintaining a second list.
- Project-level defaults matter more than global defaults for agent evidence.

### Plane

Plane is mainly useful as a mature project/task management reference.

Useful patterns:

- Keep work items, cycles/modules, views, pages, and analytics separate instead of blending everything into a single dashboard.
- Good reference for future project/task graph surfaces once Navia has real project projections.

Near-term relevance is lower than Multica, Dub, Mission Control, Trigger.dev, and Langfuse.

### BoneHub and Sixbones

These are useful local taste references, not main product architecture references.

Useful patterns:

- BoneHub uses `typesafe-i18n` with `baseLocale: "zh-CN"` and typed locale objects. This is relevant if Navia's current lightweight dictionary grows too large.
- Its translations are grouped by common/app/apps/settings/messages, which is a clean shape for Chinese-first Svelte apps.
- Sixbones has a simple `SITE` config with `lang: "cn"` and `timezone: "Asia/Shanghai"`, which matches the preference for explicit locale/timezone defaults.

Do not copy blindly:

- BoneHub's locale loader currently reads and resets a `currentLocale` value after inspecting the URL. If Navia adopts `typesafe-i18n`, implement URL/localStorage/server preference resolution deliberately.
- BoneHub is a personal toolbox. Navia is an operational dashboard and needs stronger table, state, and settings conventions.

## Command Palette and `⌘K`

Current Navia behavior:

- The `⌘` in `⌘K` is just the Unicode Command symbol `U+2318` rendered in a `<kbd>`.
- No library is needed to display it.
- For cross-platform display, show `⌘K` on Mac and `Ctrl K` elsewhere.

Reference repo evidence:

- Stoneforge uses React `cmdk` for its command palette.
- Langfuse uses its own command menu built on command primitives, with a root provider and command groups.
- Dub uses `cmdk` heavily in row menus, filters, and popovers, but not as a global Svelte solution.

Library research on 2026-05-22:

| Need                           | Candidate                | Current version checked | Fit for Navia                                                                  |
| ------------------------------ | ------------------------ | ----------------------: | ------------------------------------------------------------------------------ |
| Keyboard shortcut binding only | `tinykeys`               |                   4.0.0 | Best small choice. Use for global `Mod+K`, `/`, and route-specific shortcuts.  |
| Svelte action shortcut binding | `@svelte-put/shortcut`   |                   4.1.0 | Viable, but less attractive than `tinykeys` for a central shortcut registry.   |
| General shortcut binding       | `hotkeys-js`             |                   4.0.4 | Mature, but larger/more global than Navia needs.                               |
| React command palette          | `cmdk`                   |                   1.1.1 | Good for React repos, not appropriate for SvelteKit Navia.                     |
| Svelte command primitive       | `bits-ui` Command        |                  2.18.1 | Best Svelte primitive if Navia wants to build its own command palette UI.      |
| Drop-in Svelte palette         | `svelte-command-palette` |                   2.0.2 | Fastest path, but less control than composing `bits-ui` plus Navia components. |

Recommendation:

- Short term: keep the `<kbd>` label and implement only a clean helper:
   - Mac: `⌘K`
   - Windows/Linux: `Ctrl K`
- Medium term: use `tinykeys` for shortcut registration and `bits-ui` Command for the palette UI.
- Avoid adding `cmdk` because Navia is Svelte, and the React wrapper would pull the design away from the codebase.

## Proposed Navia Information Architecture

### App Shell

Sidebar:

- Transparent PaddlePaddle logo at top.
- Global search below logo. It can remain disabled until command palette exists, but it should use the same "soon" badge wording and color everywhere.
- Primary nav: Overview, Projects, Repos, Agents, Artifacts, Settings.
- Account/workspace menu at bottom-left.

Topbar:

- Height around 44-52px.
- Breadcrumb/current page only.
- Optional tiny status chip later, not full search or account controls.

Account/workspace menu:

- User block at top.
- Workspace section only lists real workspaces.
- If there are no workspaces, show an empty workspace section plus "Create workspace"; do not render "No workspace" as a selected workspace row.
- Create workspace should be clickable and should not disappear on hover/mouseout.
- Logout separated and styled as danger.

### No Workspace State

Route logic:

- `activeWorkspace === null` should mean setup guide.
- Breadcrumb should show only setup guide, not "No workspace > setup".
- Workspace list in menu should be empty, with a create action.

Setup page:

- Title: Create the first workspace.
- Explain that runtime registration and workspace binding create server-visible workspace projections.
- Primary action: Set up runtime.
- Secondary action: Open settings.
- Steps: register runtime, bind local workspace, create first project.

### Settings

Structure:

- Left settings rail or top segmented tabs depending viewport.
- Runtime Connections.
- Workspace Bindings.
- Runtime Tokens.
- Audit/Protocol.
- Preferences/Language later.

Content pattern:

- Compact page header with one sentence and actions.
- Status strip: online runtimes, workspace bindings, stalled/offline runtimes.
- Tables first, cards only for repeated items or empty states.
- Empty states should include concrete protocol endpoints or runner commands.

Runtime row fields:

- Runtime name.
- Provider/CLI type.
- Runtime id.
- Installation/daemon id.
- Status: online/offline/stalled/draining/disabled.
- Last heartbeat.
- Protocol version.
- Capabilities: batch import, model list, local skills.
- Last error or pending action.

Workspace binding row fields:

- Workspace display name.
- Local workspace key/path.
- Runtime.
- Snapshot status.
- Last snapshot.
- Project count once available.

### Overview

The Overview should answer four questions:

- Is the local/runtime fabric alive?
- Are there server-visible workspaces?
- Is there human attention pending?
- What projections/artifacts recently changed?

Recommended panels:

- Pending inbox.
- Workspaces.
- Runtime connections.
- Workspace bindings.
- Recent runtime events or projection events once data exists.

### Future Command Palette

Command groups:

- Go to: Overview, Settings, Projects, Repos, Agents, Artifacts.
- Create: Workspace, runtime token, project.
- Runtime: copy register command, refresh runtimes, open runtime row.
- Workspace: switch workspace, bind workspace.
- Search: projects, artifacts, asks, tasks, evidence.

Data source:

- Build command items from route/settings definitions instead of duplicating labels.
- Allow each settings page/section to define `cmdKKeywords`, like Langfuse.

### Future Evidence and Run Surfaces

Borrow from Trigger.dev and Langfuse:

- Structured metadata for progress and status.
- Heartbeat-derived stalled states.
- Replay/retry actions tied to original input.
- Saved table views with resolution order: URL, session, user default, workspace/project default, system default.
- Trace/detail layouts for ask/task/projection evidence.

## Implementation Slices

1. Shell correctness slice:
   - Remove no-workspace pseudo row from workspace switcher.
   - Keep topbar breadcrumb-only.
   - Normalize all "coming soon" labels through one i18n key and CSS class.
   - Add a platform shortcut label helper for `⌘K` / `Ctrl K`.

2. Settings console slice:
   - Convert settings into sections: connections, bindings, tokens, audit.
   - Add compact status strip and real runtime/binding table columns.
   - Keep page actions small and operational.

3. Workspace creation slice:
   - Add a real create workspace path or modal.
   - Make setup state create-first-workspace focused.
   - Ensure the account/workspace menu's create action routes there.

4. Runtime protocol slice:
   - Add explicit stalled/runtime-gone/pending-action states.
   - Surface protocol version, capabilities, daemon id, last heartbeat, and last snapshot.

5. Command palette slice:
   - Add `tinykeys`.
   - Add `bits-ui` Command-based palette.
   - Generate commands from route/settings definitions.

## Ranked Borrow List

1. Multica: workspace/runtime onboarding and account/workspace settings grouping.
2. Dub: polished sidebar workspace/user dropdown behavior.
3. Mission Control: bottom context switcher, live connection semantics, operational density.
4. Trigger.dev: run metadata, heartbeat/stalled semantics, replay actions.
5. Langfuse: command menu grouping, settings page arrays, saved views, evidence table ergonomics.
6. Agent Runner: durable run manifest, audit timeline, daemon API/SSE shape.
7. Stoneforge: route vocabulary and command grouping for agent dashboards.
8. Plane: later project/task views.
9. BoneHub/Sixbones: Chinese-first i18n shape and local aesthetic preferences.

## Sources

- [Multica repository](https://github.com/multica-ai/multica)
- [Mission Control repository](https://github.com/builderz-labs/mission-control)
- [Dub repository](https://github.com/dubinc/dub)
- [Stoneforge repository](https://github.com/stoneforge-ai/stoneforge)
- [Agent Runner repository](https://github.com/kcosr/agent-runner)
- [Trigger.dev repository](https://github.com/triggerdotdev/trigger.dev)
- [Langfuse repository](https://github.com/langfuse/langfuse)
- [Plane repository](https://github.com/makeplane/plane)
- [BoneHub repository](https://github.com/zrr1999/bonehub)
- [Bits UI Command docs](https://bits-ui.com/docs/components/command)
- [tinykeys npm package](https://www.npmjs.com/package/tinykeys)
- [cmdk repository](https://github.com/pacocoursey/cmdk)
- [GitHub Command Palette docs](https://docs.github.com/get-started/using-github/github-command-palette)
