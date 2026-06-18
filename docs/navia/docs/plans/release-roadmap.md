# Navia local → usable MVP plan

## Current reality

Navia is currently a **Spark-cockpit development build with a Spark-runtime-backed runner slice**, not a complete usable MVP.

What works:

- SvelteKit + SQLite projection server scaffold.
- Runner/server protocol schemas, migration spine, and runner WebSocket ingestion paths.
- Browser surfaces for setup, workspace overview, settings/connections, inbox, projects, project cockpit, task graph projections, artifacts, repos/resources, and agent specs.
- Repo-local runner smoke fixture that can register a fake runner, send projection fixtures, and validate web/API paths.
- Full static validation and runner smoke pass under Node 26.
- Settings can create one-time workspace registration tokens, show the registration command once, list/revoke unused tokens, and require a bearer registration token during local daemon registration.
- Project cockpit can enqueue a `task.start.request`; `navia-runner` accepts it, routes execution through the Spark runtime bridge, and streams invocation logs/status plus task graph and artifact projections.
- Runner-originated human asks can be bridged into Inbox and resumed by answer delivery.
- Runner-produced task-summary artifacts have canonical content refs, a lazy server content/cache path, and artifact-detail rendering.
- Resource and agent selections are carried through task start into runner execution metadata.
- `pnpm run navia:e2e`, `pnpm run verify:navia`, and `pnpm run verify:merged` provide repeatable Spark-root gates for the cockpit and runner bridge. Historical standalone release gates remain documented for compatibility.

What does **not** yet work as a product:

- Runner install/start/reconnect handling is still basic CLI behavior rather than a polished local lifecycle.
- Browser UX for cancellation, retry, disconnected runners, and failure recovery remains shallow.
- The deterministic E2E gate is CI-capable; external provider/Pi-authenticated smoke remains manual/operator-run validation when needed.
- Public release readiness is still incomplete: no reviewed first commit/tag, no license, no public repository metadata, and no packaged server distribution.

## Usable MVP definition

A usable MVP is achieved when a local owner can complete this happy path on a clean machine/repo checkout:

1. Install dependencies and start Navia with one documented command path.
2. Create/enter the local owner session.
3. Generate a workspace registration command.
4. Copy and run `navia ws register` against a local directory.
5. See a real runner workspace binding appear online.
6. Create a server-visible workspace from that binding.
7. Create a project and start a real task.
8. See runner logs/status stream into the project cockpit.
9. Answer a runner-originated ask/review in Inbox and have the runner continue.
10.   Open at least one runner-produced artifact through the Artifacts UI.
11.   Cancel/retry/failures have understandable UI states and audit events.
12.   The path is covered by a repeatable smoke/E2E gate.

Non-goals for this MVP:

- Multi-user/team permission model beyond the local owner.
- Remote/cloud hosted runner fleet management.
- Direct browser-to-runner pairing.
- Full marketplace/plugin system for agents/tools.
- Rich prompt/agent design studio.
- Production-grade secret management beyond local-safe defaults and clear warnings.

## Milestone DAG

### P0 — Truth, bootstrap, and resetability

P0 is implemented. In the merged Spark repo, use `pnpm run navia:web`, `pnpm run navia:e2e`, `pnpm run verify:navia`, and `pnpm run verify:merged` from the Spark root. Historical standalone helpers (`pnpm local:start`, `pnpm local:reset`, release gates) remain compatibility references.

| ID   | Workstream                  | Depends on            | Outcome                                                                                                  | Acceptance evidence                           |
| ---- | --------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| P0.1 | Status truth reset          | Current release state | Docs and task plans say runner-backed build complete / usable MVP pending, not MVP complete.             | README/task plan updated.                     |
| P0.2 | One-command local bootstrap | P0.1                  | `pnpm local:start` starts the custom server with project-local `.navia/local` data/cache/state defaults. | Fresh project-local data smoke starts server. |
| P0.3 | Reset/seed tooling          | P0.2                  | `pnpm local:reset` safely removes only project-local data under `.navia/local`.                          | Reset then setup page works.                  |
| P0.4 | Validation gate script      | P0.2                  | `pnpm release:check` wraps check/test/build/fmt; `pnpm release:smoke` adds isolated runner smoke.        | Gate exits nonzero on failures.               |

### P1 — Real workspace registration and local lifecycle

| ID   | Workstream                          | Depends on | Outcome                                                                                   | Acceptance evidence                                            |
| ---- | ----------------------------------- | ---------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| P1.1 | Workspace registration token API/UI | P0.2       | UI can mint, display once, copy, revoke, and list one-time workspace registration tokens. | Browser creates token; DB stores hash only.                    |
| P1.2 | Local service config/doctor         | P0.2       | `navia daemon status/logs` and diagnostics are reliable and JSON/scriptable where needed. | CLI tests and manual doctor output.                            |
| P1.3 | Workspace register/start/stop       | P1.1, P1.2 | `navia ws register` exchanges the token, stores credentials, opens WS, and stops cleanly. | Local workspace directory appears online.                      |
| P1.4 | Workspace registry/reconcile        | P1.3       | Runner list/reconcile workspace commands report bindings and survive reconnect.           | Workspace binding can create server workspace after reconnect. |

### P1 — Real task execution happy path

| ID   | Workstream                      | Depends on | Outcome                                                                              | Acceptance evidence                                  |
| ---- | ------------------------------- | ---------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| P1.5 | Task request UI/server command  | P1.4       | Project cockpit can create/start a simple task and enqueue `task.start.request`.     | Command row and delivery audit visible.              |
| P1.6 | Spark runtime bridge adapter    | P1.5       | Runner executes a simple prompt in the bound local workspace through Spark runtime primitives. | Real invocation logs stream back.                    |
| P1.7 | Invocation lifecycle hardening  | P1.6       | Running/succeeded/failed/cancelled/retry states are persisted and rendered clearly.  | Forced failure and cancel smoke pass.                |
| P1.8 | Minimal task result projection  | P1.6       | Runner reports task completion and updates latest task graph snapshot/projection.    | Cockpit status changes without manual smoke fixture. |

Progress note, 2026-06-17: P1.1, P1.5, P1.6, and P1.8 have a merged Spark implementation. The runner bridge drives `task.start.request` through Spark runtime primitives and projects task graph, invocation, and artifact state back to Navia. `pnpm run navia:e2e` covers the stubbed happy path from the Spark root; see [../release/e2e-gate.md](../release/e2e-gate.md) for the historical standalone gate contract.

Progress note, 2026-05-25: P1.9 through P1.15 now have first usable implementations for Inbox answer delivery, artifact content/cache retrieval, and task-level resource/agent binding. Remaining work is primarily hardening, public-release readiness, and real-Pi operator validation.

### P1 — Human-in-the-loop bridge

| ID    | Workstream               | Depends on | Outcome                                                                                                     | Acceptance evidence                                  |
| ----- | ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P1.9  | Runner ask tool bridge   | P1.6       | Runner-side ask/review call blocks, creates `human.request.created`, receives browser answer, then resumes. | End-to-end ask smoke passes.                         |
| P1.10 | Ask redelivery/reconnect | P1.9       | Answered-but-undelivered human responses redeliver after runner reconnect.                                  | Kill/restart runner during ask; answer is delivered. |

### P1 — Artifact content bridge

| ID    | Workstream                            | Depends on | Outcome                                                                                   | Acceptance evidence                                |
| ----- | ------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| P1.11 | Runner artifact production            | P1.6       | Runner writes at least one canonical artifact with stable content ref/provenance.         | Artifact projection includes retrievable ref.      |
| P1.12 | Server artifact content request/cache | P1.11      | Artifact detail can request content from runner and cache preview under server cache dir. | Detail page displays real runner artifact content. |
| P1.13 | Artifact error/large-file states      | P1.12      | Missing, forbidden, too-large, and binary artifact states are explicit.                   | Fixture tests cover each state.                    |

### P1 — Resources and agent specs affect execution

| ID    | Workstream                             | Depends on | Outcome                                                                          | Acceptance evidence                                  |
| ----- | -------------------------------------- | ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P1.14 | Resource binding in project/task forms | P1.5       | Task/project start can select workspace resources, especially repo/path refs.    | Command payload includes selected resources.         |
| P1.15 | Agent spec dispatch binding            | P1.6       | Task start can choose an agent spec and runner uses role/instruction/tool hints. | Logs show selected spec; behavior changes minimally. |

### P2 — Product hardening and release quality

| ID   | Workstream                          | Depends on         | Outcome                                                                                                            | Acceptance evidence                                  |
| ---- | ----------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| P2.1 | E2E smoke suite                     | P1.8, P1.10, P1.12 | Repeatable browser/API/runner smoke covers the real happy path.                                                    | CI/local command passes on clean temp state.         |
| P2.2 | Error and empty-state pass          | P1 workstreams     | Startup, disconnected runner, token errors, command rejection, ask delivery, artifact failures are understandable. | Browser review checklist complete.                   |
| P2.3 | CI/prek release gate                | P2.1               | CI/pre-commit gate runs check/test/build/fmt plus selected smoke where practical.                                  | CI green on fresh repo.                              |
| P2.4 | Ops docs and examples               | P2.1               | README has clean setup, reset, workspace registration, smoke, and troubleshooting paths.                           | New operator can follow docs without hidden context. |
| P2.5 | First checkpoint commit/release tag | P2.3, P2.4         | Initial repo commit/tag after review.                                                                              | Git history has reviewed checkpoint.                 |

## Suggested execution order

1. P0.1–P0.4: correct truth and make the local loop boring.
2. P1.1–P1.4: make a real runner connect and report workspaces.
3. P1.5–P1.8: make one real task run and report status/logs.
4. P1.9–P1.10: prove human ask/review blocking continuation.
5. P1.11–P1.13: prove real artifact content retrieval.
6. P1.14–P1.15: make resources/agent specs affect execution.
7. P2.1–P2.5: harden, document, gate, and checkpoint.

## Readiness gates

### Gate A — Real runner online

- `navia ws register` succeeds with UI-generated token.
- The command opens WS, or `navia daemon start` reopens it later.
- Settings shows online workspace binding.
- Reconnect does not duplicate or lose binding state.

### Gate B — Real task happy path

- User creates project.
- User starts one real task.
- Runner executes through Spark runtime primitives in the selected workspace.
- Logs and status stream to cockpit.
- Completion updates task graph projection.

### Gate C — HITL and artifacts

- Task triggers a human ask/review.
- User answers in Inbox.
- Runner resumes and completes.
- Runner emits an artifact.
- Browser opens real artifact content from server cache/request path.

### Gate D — Release candidate

- `pnpm check`, `pnpm test`, `pnpm build`, `pnpm exec vp fmt --check .` pass.
- Real runner E2E smoke passes on clean temp state.
- README quickstart and troubleshooting are current.
- First checkpoint commit can be created after review.

## Key risks

- Spark runtime execution/session behavior may require deeper runner state than the current scaffold.
- Human ask bridge requires careful blocking/resume semantics to avoid lost answers.
- Artifact content transfer can accidentally become a large-file sync problem; keep preview/lazy semantics.
- Exact optional TypeScript + Zod defaults can still surface edge errors when protocol payloads expand.
- Vite+ / Vite 8 beta warnings are expected but should be watched during upgrades.
