# RFC: Navia server-Spark daemon communication protocol

Status: draft
Date: 2026-05-21

## Summary

Navia's Spark daemon should be treated as a larger Spark daemon/capability concept, not only as a thin task executor. In the merged Spark monorepo the v0.1 Spark daemon lives under `apps/spark-daemon` and is controlled through `spark daemon`: a separate process that may manage multiple workspaces, owns local registration/protocol safety, and routes task execution through Spark runtime primitives while reporting projections back to the web cockpit.

In v0.1, each server-visible workspace is created under exactly one owning Spark daemon workspace binding. A Spark daemon can own/manage many workspaces, but a workspace is managed by one Spark daemon binding at a time. Other Spark daemons cannot route commands into or manage that workspace unless an explicit future rebinding/migration flow changes ownership.

The Navia server should be a **communication plane** for this boundary. It owns authentication, Spark daemon sessions, message routing, delivery state, human-inbox delivery records, frontend fanout/projections, and communication audit. It should not be the component that owns Spark/runtime execution strategy, provider capabilities, workspace internals, or detailed workdir/resource locking.

The frontend should be **workspace/project first**. Spark daemon identity is secondary and should mostly appear as connection health or diagnostics, not as a primary product concept.

Recommended v0.1 protocol:

```text
Spark daemon -> Server: outbound HTTP setup + required WebSocket control session
Server -> Spark daemon: routed commands over the Spark daemon's established WebSocket session
Spark daemon -> Server: workspace snapshots, lifecycle events, human requests, logs, artifact refs/content through protocol messages/uploads
Frontend -> Server: workspace/project UI consumes server projections, human inbox items, and routed command results
```

Key pivot from the earlier draft:

- Server no longer "assigns work to eligible Spark daemons" as the core model.
- Spark daemon owns workspace state and decides whether/how commands execute.
- Server routes commands to the owning Spark daemon workspace binding and mirrors enough state for UI.
- Spark daemon tokens are not inherently single-workspace tokens; a Spark daemon can advertise/manage multiple workspace bindings, but each server-visible workspace has one owning binding in v0.1.
- Ask/review items originate in the Spark daemon when an agent tool call such as `ask_user` blocks; the server/frontend handle human interaction and return the answer to the Spark daemon.
- Artifact and workspace internals are Spark/runtime-owned first; the server may cache/project them for web UX.

## Goals

- Define a communication contract between Navia server and Spark daemon process that remains reusable by future external Spark daemon repos.
- Keep core workspace/Spark daemon capabilities in the Spark daemon.
- Allow one Spark daemon installation to manage multiple Navia workspaces while keeping each workspace bound to one owning Spark daemon binding in v0.1.
- Keep the browser UI focused on workspaces/projects rather than Spark daemon inventory.
- Support outbound-only Spark daemon connectivity for NAT/firewall friendliness.
- Make commands, human requests, events, logs, artifacts, and reconnect reconciliation explicit and auditable.
- Provide enough structure for Zod schemas, OpenAPI endpoints, and JSON fixtures before implementation.

## Non-goals

- Implement additional Spark daemon backends beyond the Spark runtime bridge.
- Choose additional Spark daemon implementation languages.
- Define provider-specific prompt/session formats for Claude Code, Codex, Cursor, etc.
- Define the Spark daemon's local workspace layout or cleanup internals.
- Make the server a full scheduler/orchestrator for Spark execution.
- Expose Spark daemon as a first-class primary navigation object in the frontend.
- Provide broad multi-version compatibility before protocol v1.

## Product boundary

The selected Spark daemon shape for the Spark merge is **same-monorepo daemon CLI with a Spark runtime bridge**. The daemon owns the server WebSocket/session, workspace registry, bridge invocation, artifact/log/checkpoint projection, ask/review blocking bridge, and safety policy. Spark task graph/run/artifact stores remain the execution source of truth behind that bridge.

| Concern             | Server communication plane                                                                                                                      | Spark daemon capability plane                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth/session        | Issues enrollment/Spark daemon tokens, authenticates HTTP/WS, tracks sessions.                                                                        | Daemon stores local credentials/config and uses Spark daemon token to connect; plugins do not store server tokens.                                          |
| Workspace ownership | Creates server-visible workspace records bound to one owning Spark daemon workspace binding; stores/mirrors projections needed by web UI and routing. | Discovers/manages one or more local/workspace Spark daemons and reports snapshots; only the owning binding may manage its server-visible workspace in v0.1. |
| Project/task state  | May cache/project state for frontend queries and audit.                                                                                         | Bridges commands into Spark task/run orchestration and reports projection/recovery details. Spark stores own execution truth.                          |
| Scheduling          | Routes user/server commands to the workspace's owning binding.                                                                                  | Decides whether/how a command can run based on local policy/capabilities, then invokes Spark runtime primitives.                                      |
| Capabilities        | Validates capability schema and displays summary/health.                                                                                        | Detects Spark/runtime/tool availability, repos, local resources, and actual availability.                                                             |
| Workdirs/checkouts  | Stores policy/provenance refs; does not manage local paths.                                                                                     | Creates/locks/cleans workdirs and rejects unsafe nested/dirty/overlapping paths.                                                                      |
| Logs/events         | Receives, persists/fans out, and renders append-only streams.                                                                                   | Produces logs/events with sequence/idempotency metadata.                                                                                              |
| Artifacts           | Stores metadata projections and optional web cache/proxy pointers.                                                                              | Produces artifacts and owns canonical local artifact content/checkpoints.                                                                             |
| Human asks/reviews  | Stores/delivers Spark-daemon-originated human requests to frontend and returns human responses to Spark daemon.                                             | Daemon converts thin plugin/agent ask or review calls into server human requests, blocks waiting for responses, and returns tool results to agents.   |
| Recovery            | Requests reconciliation after reconnect and marks communication status.                                                                         | Daemon reports actual local state and decides resume/complete/fail/lost from local evidence.                                                          |

## Frontend stance

Frontend UX should not lead with Spark daemon management.

Primary concepts:

- workspace;
- project;
- tasks/runs;
- asks/reviews/inbox;
- artifacts/evidence;
- connection health.

Spark daemon identity appears only where useful:

- workspace connection status;
- diagnostics/settings;
- provenance details for an invocation/artifact;
- troubleshooting disconnected or degraded workspaces.

Possible labels:

| Avoid as primary UI | Prefer                            |
| ------------------- | --------------------------------- |
| Spark daemons             | Connections                       |
| Spark daemon registry     | Workspace connections             |
| Assign to Spark daemon    | Start in workspace                |
| Spark daemon artifacts    | Workspace artifacts / run outputs |
| Spark daemon logs         | Run logs / connection diagnostics |

## Protocol principles

0. **Daemon owns the server protocol.** The daemon is the single owner of the Navia server session/WS, reconnect reconciliation, workspace registry, and Spark daemon-side policy. Future plugins/adapters, if added, must not each implement the server protocol.
1. **Spark daemon owns capability truth.** The Spark daemon reports what it can do and enforces local policy.
2. **Server owns communication truth.** The server knows sessions, delivery, routing, auth, and UI projections.
3. **Workspace-first routing.** Commands target the owning workspace binding, not just a Spark daemon process.
4. **Single owning Spark daemon per workspace in v0.1.** A Spark daemon can manage many workspaces, but each workspace is fixed to one Spark daemon binding when created.
5. **Spark daemon-originated human requests.** Agent code only sees tools like `ask_user`; Spark daemon forwards ask/review requests to the server and blocks until a human response arrives.
6. **Outbound-only connectivity.** Spark daemons open HTTP/WS connections to the server; server does not require inbound access to Spark daemon hosts.
7. **Control and content are separate.** Commands/events/human requests are JSON envelopes; large artifact bytes use upload/proxy/cache flows.
8. **Everything public is schema-validated.** HTTP payloads, WS envelopes, events, and fixtures have Zod schemas and JSON examples.
9. **Idempotency is mandatory.** Command ack/reject, human request creation/response delivery, lifecycle events, terminal reports, and artifact registration must converge on retries.
10.   **Fail loudly on protocol mismatch.** Before v1, prefer explicit unsupported-version errors over broad fallback shims.
11.   **No hidden automatic human decisions.** Spark daemon liveness may affect execution status, but must not answer/cancel human asks or reviews.

## Transport split

### Required v0.1 transports

| Flow                           | Transport                    | Notes                                                                                          |
| ------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Spark daemon enrollment/registration | HTTP JSON                    | Works before a WebSocket session exists.                                                       |
| WebSocket session bootstrap    | WebSocket                    | Required for v0.1 Spark daemons.                                                                     |
| Workspace inventory/snapshots  | WebSocket message            | Spark daemon reports all managed workspace bindings.                                                 |
| Commands                       | WebSocket message            | Server routes workspace/project commands to the owning Spark daemon binding.                         |
| Command ack/reject             | WebSocket message            | Spark daemon explicitly accepts/rejects command delivery/execution.                                  |
| Human ask/review requests      | WebSocket message            | Spark daemon sends agent-originated requests to server; server/front-end collect answers.            |
| Human ask/review responses     | WebSocket message            | Server returns human answers to Spark daemon so blocked tool calls can resume.                       |
| Lifecycle events/logs          | WebSocket message            | Append-only payloads with sequence/idempotency metadata.                                       |
| Artifact metadata              | WebSocket or HTTP JSON       | Spark daemon announces produced artifacts and content availability.                                  |
| Artifact content               | HTTP upload/proxy/cache flow | Canonical content stays in Spark/local artifact stores; server lazily caches/proxies on first frontend view/export. |
| Diagnostics/token rotation     | HTTP JSON                    | Scriptable and easy to test.                                                                   |

HTTP polling-only Spark daemons are deferred until after v0.1. Direct browser-to-Spark daemon diagnostic/pairing is also deferred: keep only a design placeholder for a future explicit, privileged, time-limited, audited setup/troubleshooting flow outside normal product traffic.

### Primary connection model

```text
1. Spark daemon enrolls/registers with HTTP.
2. Server returns the Spark daemon's runtime wire id/token, negotiated protocol version, and WS URL.
3. Spark daemon opens WS to server with the returned wire token.
4. Spark daemon sends hello + managed workspace inventory + capability summary.
5. Server acknowledges session and may request reconciliation.
6. Workspace creation binds the server-visible workspace to one owning Spark daemon workspace binding.
7. Frontend/user actions create workspace/project commands on the server.
8. Server routes commands to the owning Spark daemon workspace binding over WS.
9. Spark daemon acks/rejects commands, then owns execution details.
10. When an agent calls `ask_user` or starts a review gate, the Spark daemon sends a human request to the server and blocks the tool call.
11. Server/frontend collect the human response and send it back to the Spark daemon.
12. Spark daemon returns the tool result to the agent and execution continues.
13. Spark daemon streams snapshots/events/logs/artifact refs/results.
14. Server persists communication audit and frontend projections.
15. Frontend renders workspace/project state without making Spark daemon the primary concept.
```

## Versioning

Protocol version literal:

```text
navia.runtime.v1alpha1
```

Handshake fields:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "runtimeVersion": "0.1.0",
   "supportedFeatures": [
      "ws-control-v1",
      "multi-workspace-runtime-v1",
      "workspace-snapshot-v1",
      "command-routing-v1",
      "human-request-v1",
      "logs-v1",
      "artifact-ref-v1",
      "artifact-cache-upload-v1",
      "cancellation-v1",
      "reconcile-v1"
   ]
}
```

Rules:

- Before protocol v1, the server may reject old Spark daemons with `UNSUPPORTED_PROTOCOL_VERSION`.
- Spark daemons include protocol version and feature flags in registration and WS hello.
- Server hello acknowledgement includes accepted features.
- Additive optional fields are allowed.
- Removing/renaming required fields requires a protocol version bump and fixture update.
- Spark daemon compatibility tests should validate JSON fixtures and package boundary rules; future external Spark daemon CI can reuse those fixtures without importing server internals.

## Confirmed v0.1 decisions

| Decision                | Selected default                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spark daemon concept          | Spark daemon is a larger workspace/capability hub, implemented under `apps/spark-daemon` and controlled by `spark daemon` with a Spark runtime bridge, not a thin executor or extension.      |
| Server role             | Server is primarily the communication plane: auth, sessions, routing, delivery, projections, audit.                                                                |
| Workspace scope         | One Spark daemon can manage multiple workspace bindings; each server-visible workspace is fixed to one owning Spark daemon binding at creation in v0.1.                        |
| Frontend emphasis       | Frontend is workspace/project first and should downplay Spark daemon as a primary concept.                                                                               |
| Control transport       | WebSocket is required for v0.1 Spark daemon; HTTP polling-only Spark daemons are deferred.                                                                                    |
| Spark daemon auth             | Enrollment token during setup, then the runtime wire token for HTTP/WS operations.                                                                                 |
| Scheduling              | Server routes commands to the workspace's owning Spark daemon binding; Spark daemon decides execution feasibility and owns orchestration.                                      |
| Resource/workdir leases | v0.1 keeps detailed locking, dirty checks, nested-path checks, and cleanup safety in Spark daemon.                                                                       |
| Invocation run limits   | No default or required `maxRunMs` in v0.1; liveness, explicit cancellation, and Spark daemon reconciliation decide stale/lost execution.                                 |
| Diagnostics             | Spark daemon local paths and host details default to redacted labels/resource refs/hashes.                                                                               |
| Artifacts               | Spark daemon owns canonical artifact content; server stores projections and may cache/proxy content for web UX.                                                          |
| Ask/review flow         | Spark daemon creates ask/review requests from agent tool calls, server/frontend handle human interaction, and Spark daemon blocks until the response returns to the tool call. |

## Identity and authentication

### Spark daemon installation id

Each Spark daemon installation stores a stable local `installationId` generated on first setup:

```text
rin_<ulid>
```

The installation id is not a secret. It helps re-registration converge instead of creating duplicate Spark daemon records.

### Enrollment token

A user or admin creates an enrollment token from the server/UI/CLI. Because Spark daemons can manage multiple workspaces, the token should not be modeled as inherently single-workspace. It may grant the Spark daemon permission to create or attach one or more server-visible workspaces, but each created workspace is bound to that Spark daemon's workspace binding in v0.1.

It may be scoped to:

- a user account;
- an organization/team;
- a set of workspace creation/attachment grants;
- a local development server instance.

Enrollment token properties:

- can expire;
- can be revoked;
- may carry initial labels/default policy;
- used only for registration/bootstrap, not normal long-lived Spark daemon auth.

### Spark daemon token

Registration returns a runtime wire token or refreshable credential. The token is scoped to the Spark daemon installation and allowed workspace grants. A token may cover many workspace bindings for the same Spark daemon, but it must not let the Spark daemon manage a workspace owned by another Spark daemon binding.

Use `Authorization: Bearer <runtime-token>` for HTTP and WS upgrade requests.

### Spark daemon session id

Each WS connection receives a server-generated `runtimeSessionId`:

```text
rtsn_<ulid>
```

Spark daemon identity is stable across restarts; session identity is per connection.

## Core ids

Use opaque string ids in protocol payloads.

| Entity                    | Prefix  | Example       |
| ------------------------- | ------- | ------------- |
| Workspace                 | `ws_`   | `ws_01J...`   |
| Spark daemon                    | `rt_`   | `rt_01J...`   |
| Spark daemon session            | `rtsn_` | `rtsn_01J...` |
| Spark daemon workspace binding  | `rtwb_` | `rtwb_01J...` |
| Command                   | `cmd_`  | `cmd_01J...`  |
| Human request             | `hreq_` | `hreq_01J...` |
| Human response            | `hres_` | `hres_01J...` |
| Invocation/run            | `inv_`  | `inv_01J...`  |
| Artifact                  | `art_`  | `art_01J...`  |
| Artifact blob/cache entry | `blob_` | `blob_01J...` |
| Protocol message          | `msg_`  | `msg_01J...`  |
| Idempotency key           | `idem_` | `idem_01J...` |

Do not encode tenant names, local paths, hostnames, or database table names into ids.

## Workspace bindings

A Spark daemon reports the workspaces it can manage. A workspace binding is the routing bridge between server-visible workspace/project UI and daemon-local state.

In v0.1, workspace creation fixes the server-visible workspace to one owning Spark daemon workspace binding. The Spark daemon may manage many workspaces, but a workspace has one owner binding for command routing, ask/review response delivery, artifact projection, and snapshot updates.

```ts
interface RuntimeWorkspaceBinding {
   bindingId: string;
   workspaceId?: string;
   ownerMode: "primary";
   localWorkspaceKey: string;
   displayName: string;
   status: "available" | "indexing" | "degraded" | "unavailable";
   capabilitiesSummary: WorkspaceCapabilitySummary;
   resourceRefs: ResourceRefSummary[];
   lastIndexedAt?: string;
   diagnostics?: RedactedRuntimeDiagnostics;
}

interface WorkspaceCapabilitySummary {
   providers: Array<{
      provider: "claude-code" | "codex" | "gemini" | "cursor" | "custom";
      status: "available" | "missing" | "degraded";
      version?: string;
   }>;
   maxConcurrentInvocations?: number;
   supportsMutation?: boolean;
   supportsArtifacts?: boolean;
   supportsResume?: boolean;
}

interface ResourceRefSummary {
   resourceRef?: string;
   kind: "repo" | "filesystem" | "artifact-store" | "custom";
   label: string;
   status: "available" | "missing" | "degraded";
}

interface RedactedRuntimeDiagnostics {
   hostnameHash?: string;
   platform?: "darwin" | "linux" | "windows" | "unknown";
   arch?: "arm64" | "x64" | "unknown";
   localPathHash?: string;
   localPathLabel?: string;
}
```

Rules:

- `localWorkspaceKey` is daemon-local and stable enough for routing on that Spark daemon.
- `workspaceId` is server-visible and assigned/linked when the workspace is created or attached.
- A Spark daemon can report many bindings.
- A server-visible workspace can have only one owning binding in v0.1.
- Commands and human responses for a workspace route only to its owning binding.
- Other Spark daemons cannot inspect/manage the workspace unless a future explicit rebinding/migration flow transfers ownership.
- Server should not require raw local paths to render normal workspace UI.
- Raw host/path diagnostics, if ever sent, must be marked sensitive and hidden by default.

## State machines

### Spark daemon connection status

This is server-owned communication state.

```text
registered -> online -> draining -> offline
      |          |          |
      +----------+----------+
                 |
              disabled
```

| Status       | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| `registered` | Spark daemon exists but has not established a fresh session.                        |
| `online`     | Spark daemon has a fresh WS session and can receive routed commands.                |
| `draining`   | Spark daemon asks server not to route new commands, but existing work may continue. |
| `offline`    | WS session/heartbeat expired or Spark daemon disconnected.                          |
| `disabled`   | Server/admin disabled the Spark daemon credential or routing.                       |

### Command lifecycle

This is server-owned communication/delivery state.

```text
created -> routed -> delivered -> acked -> running_hint -> terminal_hint
                    |          |
                    |          +-> rejected
                    +-> delivery_failed
```

Meanings:

| Status            | Owner            | Meaning                                                       |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `created`         | server           | Command was created from UI/API/system action.                |
| `routed`          | server           | Server selected the workspace's owning binding/session route. |
| `delivered`       | server           | Message was sent over WS.                                     |
| `acked`           | Spark daemon           | Spark daemon accepted command delivery/intent.                      |
| `rejected`        | Spark daemon           | Spark daemon refused command with reason.                           |
| `delivery_failed` | server           | Server could not deliver to an online session.                |
| `running_hint`    | runtime-reported | Spark daemon says command caused active work.                       |
| `terminal_hint`   | runtime-reported | Spark daemon says related work reached a terminal outcome.          |

The server may mirror Spark daemon hints for frontend UX, but Spark runtime stores remain the source of execution truth.

### Human request lifecycle

Human ask/review requests are Spark-daemon-originated and server-delivered. They exist because an agent running under the Spark daemon called a tool such as `ask_user` or reached a review gate. The agent layer only knows the tool; it does not know about server/frontend transport.

```text
created_by_runtime -> delivered_to_server -> pending_human -> answered -> delivered_to_runtime -> returned_to_tool
                                      |             |
                                      |             +-> cancelled/archived
                                      +-> delivery_failed
```

Meanings:

| Status                 | Owner           | Meaning                                                                                             |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `created_by_runtime`   | Spark daemon          | Spark daemon created the request from an agent tool call and is blocking that tool call.                  |
| `delivered_to_server`  | server          | Server persisted the request and can show it in the frontend inbox.                                 |
| `pending_human`        | server/frontend | A human has not answered yet; no automatic timeout.                                                 |
| `answered`             | server/frontend | A human submitted a response.                                                                       |
| `delivered_to_runtime` | server + Spark daemon | Server sent the response to the owning Spark daemon workspace binding and Spark daemon acknowledged it.         |
| `returned_to_tool`     | Spark daemon          | Spark daemon returned the response as the `ask_user`/review tool result and agent execution may continue. |
| `cancelled/archived`   | server/frontend | Human explicitly cancelled/archived; Spark daemon receives a terminal human-response status.              |

Rules:

- Spark daemon owns request creation because it is closest to the blocking agent/tool call.
- Server owns frontend delivery and human response collection.
- Human requests route back to the workspace's owning Spark daemon binding.
- Pending human requests wait indefinitely until explicitly answered/cancelled/archived.
- Spark daemon reconnect reconciliation must include blocked human requests so tool calls can resume or fail explicitly.

### Invocation/run lifecycle

This is Spark-owned execution state, mirrored by server events from the Spark daemon bridge.

```text
accepted -> preparing -> running -> succeeded | failed | cancelled | lost
                 |          |
                 +----------+-> cancelling
```

Rules:

- Spark daemon may create `invocationId` after accepting a command, or accept a server-suggested id.
- Retrying creates a new invocation/run record.
- Server connection loss alone does not prove an invocation failed.
- On reconnect, server requests reconciliation; Spark daemon reports local evidence and terminal state.
- If Spark daemon cannot prove state, Spark daemon may report `lost`; server should not unilaterally convert human asks/reviews into terminal states.

## Message envelope

All WS messages use a common envelope:

```ts
interface ProtocolEnvelope<TPayload> {
   protocolVersion: "navia.runtime.v1alpha1";
   messageId: string;
   type: string;
   sentAt: string;
   runtimeId?: string;
   runtimeSessionId?: string;
   workspaceId?: string;
   workspaceBindingId?: string;
   commandId?: string;
   humanRequestId?: string;
   humanResponseId?: string;
   invocationId?: string;
   idempotencyKey?: string;
   sequence?: number;
   ackOf?: string;
   payload: TPayload;
}
```

Rules:

- `messageId` is unique per sender.
- `idempotencyKey` is required for mutation-like commands, command acks/rejects, human request/response messages, terminal reports, and artifact registration.
- `sequence` is monotonic within streams where ordering matters, such as invocation logs.
- Receivers tolerate duplicate envelopes with the same `messageId`/`idempotencyKey`.
- Schema versioning handles required-field changes.

## Command model

Commands are routed requests from server/frontend/system to the workspace's owning Spark daemon workspace binding. They are not proof that execution has started.

```ts
interface RuntimeCommand {
   commandId: string;
   workspaceId: string;
   workspaceBindingId: string;
   kind:
      | "workspace.snapshot.request"
      | "project.create.request"
      | "task.start.request"
      | "invocation.cancel.request"
      | "artifact.content.request"
      | "diagnostics.request";
   title?: string;
   payloadRef?: PayloadRef;
   payload?: Record<string, unknown>;
   createdAt: string;
}

interface PayloadRef {
   url: string;
   sha256?: string;
   contentType?: string;
}
```

Guidelines:

- Small command payloads may be inline.
- Heavy prompts, artifact inputs, and large configs should use `payloadRef`.
- Spark daemon may fetch details before ack/reject if needed.
- Spark daemon may reject a command because local policy/capability/workspace state makes it unsafe or impossible.

## Human request model

Human requests are Spark-daemon-originated asks/reviews that need frontend interaction before an agent can continue. The canonical example is an agent calling `ask_user`: the agent tool call reaches the Spark daemon, the Spark daemon sends a human request to the server, the server/frontend collect a human answer, and the Spark daemon returns that answer to the tool call.

```ts
type HumanRequestKind = "ask_user" | "review_gate";

type HumanRequestStatus = "pending" | "answered" | "cancelled" | "archived";

interface HumanRequest {
   humanRequestId: string;
   workspaceId: string;
   workspaceBindingId: string;
   projectId?: string;
   invocationId?: string;
   toolCallId?: string;
   kind: HumanRequestKind;
   status: HumanRequestStatus;
   title: string;
   prompt: string;
   questions?: HumanQuestion[];
   contextArtifactRefs?: string[];
   createdAt: string;
}

interface HumanResponse {
   humanResponseId: string;
   humanRequestId: string;
   status: "answered" | "cancelled" | "archived";
   answers?: Record<string, unknown>;
   responseArtifactRefs?: string[];
   respondedAt: string;
}
```

Rules:

- The Spark daemon creates `HumanRequest` records and sends them to the server.
- The server stores/delivers them as web inbox items but does not reinterpret the agent-facing tool contract.
- The Spark daemon blocks the corresponding tool call until it receives a terminal `HumanResponse`.
- The response is delivered only to the owning Spark daemon workspace binding.
- Answers must be idempotent by `humanRequestId` + `humanResponseId` or response idempotency key.
- Human requests have no automatic timeout; explicit cancel/archive is a terminal response that Spark daemon maps to the tool's cancellation/error semantics.

## Core WebSocket messages

### Spark daemon hello

Spark daemon -> server:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01aabbccddeeff001122334455667788",
   "type": "runtime.hello",
   "sentAt": "2026-05-21T00:00:00.000Z",
   "payload": {
      "runtimeId": "rt_01aabbccddeeff001122334455667788",
      "runtimeVersion": "0.1.0",
      "supportedFeatures": [
         "ws-control-v1",
         "multi-workspace-runtime-v1",
         "workspace-snapshot-v1",
         "command-routing-v1",
         "human-request-v1",
         "logs-v1",
         "artifact-ref-v1"
      ],
      "workspaceBindings": [
         {
            "bindingId": "rtwb_01aabbccddeeff001122334455667788",
            "localWorkspaceKey": "local-main",
            "displayName": "Local development workspace",
            "status": "available",
            "capabilities": {
               "providers": [
                  { "provider": "claude-code", "status": "available", "version": "1.0.0" }
               ],
               "supportsMutation": true,
               "supportsArtifacts": true,
               "supportsResume": true
            },
            "diagnostics": {
               "hostnameHash": "sha256:...",
               "platform": "darwin",
               "arch": "arm64",
               "localPathLabel": "~/workspace/navia-dev"
            }
         }
      ]
   }
}
```

Server -> Spark daemon:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01aabbccddeeff001122334455667789",
   "type": "server.hello_ack",
   "sentAt": "2026-05-21T00:00:00.100Z",
   "payload": {
      "runtimeSessionId": "rtsn_01aabbccddeeff001122334455667788",
      "acceptedFeatures": [
         "ws-control-v1",
         "multi-workspace-runtime-v1",
         "workspace-snapshot-v1",
         "command-routing-v1",
         "human-request-v1",
         "logs-v1",
         "artifact-ref-v1"
      ],
      "heartbeatIntervalMs": 15000,
      "serverTime": "2026-05-21T00:00:00.100Z"
   }
}
```

### Heartbeat

Spark daemon -> server:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01aabbccddeeff001122334455667790",
   "type": "runtime.heartbeat",
   "sentAt": "2026-05-21T00:00:15.000Z",
   "payload": {
      "runtimeId": "rt_01aabbccddeeff001122334455667788",
      "runtimeSessionId": "rtsn_01aabbccddeeff001122334455667788",
      "sequence": 1,
      "observedAt": "2026-05-21T00:00:15.000Z"
   }
}
```

### Workspace snapshot

Spark daemon -> server:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01JWSNAP",
   "type": "workspace.snapshot",
   "sentAt": "2026-05-21T00:00:16.000Z",
   "runtimeId": "rt_01JZ6B",
   "workspaceBindingId": "rtwb_01JZ6D",
   "workspaceId": "ws_01JZ6W",
   "payload": {
      "displayName": "Local development workspace",
      "status": "available",
      "projects": [{ "projectId": "proj_01JZ6X", "title": "Spark daemon protocol", "status": "running" }],
      "unresolvedInboxCount": 1,
      "activeInvocationCount": 1,
      "latestArtifactIds": ["art_01JZ7I"]
   }
}
```

The snapshot is a projection for UI, not a full replacement for daemon-local state.

### Command routed to Spark daemon

Server -> Spark daemon:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01JCMD",
   "type": "server.command",
   "sentAt": "2026-05-21T00:01:00.000Z",
   "runtimeId": "rt_01JZ6B",
   "workspaceBindingId": "rtwb_01JZ6D",
   "workspaceId": "ws_01JZ6W",
   "commandId": "cmd_01JZ80",
   "idempotencyKey": "idem_01JZ81",
   "payload": {
      "kind": "task.start.request",
      "title": "Investigate TypeScript check failure",
      "payloadRef": {
         "url": "/api/v1/runtime/commands/cmd_01JZ80/payload",
         "contentType": "application/json"
      }
   }
}
```

Spark daemon ack:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01JCMDACK",
   "type": "runtime.command.ack",
   "sentAt": "2026-05-21T00:01:00.250Z",
   "runtimeId": "rt_01JZ6B",
   "workspaceBindingId": "rtwb_01JZ6D",
   "workspaceId": "ws_01JZ6W",
   "commandId": "cmd_01JZ80",
   "ackOf": "msg_01JCMD",
   "idempotencyKey": "idem_01JZ81",
   "payload": {
      "accepted": true,
      "invocationId": "inv_01JZ79"
   }
}
```

Spark daemon reject:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01JCMDREJ",
   "type": "runtime.command.reject",
   "sentAt": "2026-05-21T00:01:00.250Z",
   "runtimeId": "rt_01JZ6B",
   "workspaceBindingId": "rtwb_01JZ6D",
   "workspaceId": "ws_01JZ6W",
   "commandId": "cmd_01JZ80",
   "ackOf": "msg_01JCMD",
   "idempotencyKey": "idem_01JZ81",
   "payload": {
      "reasonCode": "CAPABILITY_UNAVAILABLE",
      "message": "claude-code CLI is not logged in for this workspace"
   }
}
```

### Human ask/review flow

Spark daemon -> server (`ask_user` example):

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01JASK",
   "type": "human.request.created",
   "sentAt": "2026-05-21T00:02:00.000Z",
   "runtimeId": "rt_01JZ6B",
   "workspaceBindingId": "rtwb_01JZ6D",
   "workspaceId": "ws_01JZ6W",
   "commandId": "cmd_01JZ80",
   "invocationId": "inv_01JZ79",
   "humanRequestId": "hreq_01JZ90",
   "idempotencyKey": "idem_01JZ91",
   "payload": {
      "kind": "ask_user",
      "toolCallId": "toolu_01JZ92",
      "title": "Choose implementation direction",
      "prompt": "Should I update the protocol docs only, or also adjust the implementation plan?",
      "questions": [
         {
            "id": "scope",
            "type": "single",
            "prompt": "What scope should I apply?",
            "options": [
               { "id": "protocol-only", "label": "Protocol only" },
               { "id": "all-docs", "label": "All docs" }
            ]
         }
      ],
      "contextArtifactRefs": []
   }
}
```

Server -> Spark daemon after frontend answer:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01JANSWER",
   "type": "human.response.deliver",
   "sentAt": "2026-05-21T00:05:00.000Z",
   "runtimeId": "rt_01JZ6B",
   "workspaceBindingId": "rtwb_01JZ6D",
   "workspaceId": "ws_01JZ6W",
   "commandId": "cmd_01JZ80",
   "invocationId": "inv_01JZ79",
   "humanRequestId": "hreq_01JZ90",
   "humanResponseId": "hres_01JZ93",
   "idempotencyKey": "idem_01JZ94",
   "payload": {
      "status": "answered",
      "answers": { "scope": "all-docs" },
      "responseArtifactRefs": []
   }
}
```

Spark daemon -> server ack:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01JANSWERACK",
   "type": "human.response.ack",
   "sentAt": "2026-05-21T00:05:00.100Z",
   "runtimeId": "rt_01JZ6B",
   "workspaceBindingId": "rtwb_01JZ6D",
   "workspaceId": "ws_01JZ6W",
   "humanRequestId": "hreq_01JZ90",
   "humanResponseId": "hres_01JZ93",
   "ackOf": "msg_01JANSWER",
   "payload": { "returnedToTool": true }
}
```

Rules:

- Spark daemon blocks the agent tool call between `human.request.created` and a terminal `human.response.deliver`.
- Server/frontend owns displaying the request and collecting a response.
- Server must not synthesize an answer from timeout; explicit cancel/archive is delivered as terminal status.
- If the Spark daemon disconnects while waiting, the server keeps the request pending and redelivers the response after reconnect/reconciliation.
- Review gates use the same flow with `kind: "review_gate"`.

### Invocation lifecycle events

Spark daemon -> server examples:

```json
{ "type": "invocation.started", "commandId": "cmd_01JZ80", "invocationId": "inv_01JZ79", "sequence": 1, "payload": {} }
{ "type": "invocation.status", "commandId": "cmd_01JZ80", "invocationId": "inv_01JZ79", "sequence": 2, "payload": { "status": "running", "message": "Preparing workspace" } }
{ "type": "invocation.log", "commandId": "cmd_01JZ80", "invocationId": "inv_01JZ79", "sequence": 3, "payload": { "stream": "stdout", "content": "pnpm check...\n" } }
{ "type": "invocation.artifact", "commandId": "cmd_01JZ80", "invocationId": "inv_01JZ79", "sequence": 40, "payload": { "artifactId": "art_01JZ7I" } }
{ "type": "invocation.completed", "commandId": "cmd_01JZ80", "invocationId": "inv_01JZ79", "sequence": 42, "payload": { "terminalStatus": "succeeded" } }
```

Rules:

- Spark daemon owns invocation lifecycle truth.
- Server stores/fans out lifecycle events and mirrors current status for UI.
- Duplicate lifecycle events converge by `messageId`, idempotency key, or `(invocationId, sequence, type)`.
- Dropped/truncated logs must be represented explicitly.

### Cancellation

Server -> Spark daemon:

```json
{
   "protocolVersion": "navia.runtime.v1alpha1",
   "messageId": "msg_01JCANCEL",
   "type": "server.command",
   "sentAt": "2026-05-21T00:03:00.000Z",
   "runtimeId": "rt_01JZ6B",
   "workspaceBindingId": "rtwb_01JZ6D",
   "workspaceId": "ws_01JZ6W",
   "commandId": "cmd_01JZ82",
   "invocationId": "inv_01JZ79",
   "payload": {
      "kind": "invocation.cancel.request",
      "reason": "user_requested",
      "message": "User cancelled from project cockpit.",
      "gracePeriodMs": 10000
   }
}
```

Spark daemon should ack/reject the cancellation command, then emit terminal `cancelled` or `failed` based on local process outcome.

## HTTP API surface

Base path:

```text
/api/v1/runtime
```

### Register Spark daemon

```text
POST /runtimes/register
Authorization: Bearer <enrollment-token>
```

Request:

```json
{
   "installationId": "runtime-dev-machine",
   "displayName": "zrr-macbook-pro",
   "runtimeVersion": "0.1.0",
   "supportedFeatures": [
      "ws-control-v1",
      "multi-workspace-runtime-v1",
      "workspace-snapshot-v1",
      "command-routing-v1",
      "human-request-v1"
   ],
   "labels": {}
}
```

Response:

```json
{
   "runtimeId": "rt_01JZ6B",
   "runtimeToken": "<secret>",
   "runtimeTokenExpiresAt": "2026-05-21T01:00:00.000Z",
   "refreshToken": "<single-use-secret>",
   "refreshTokenExpiresAt": "2026-06-20T00:00:00.000Z",
   "protocolVersion": "navia.runtime.v1alpha1",
   "webSocketUrl": "wss://navia.example.com/api/v1/runtime/runtimes/rt_01JZ6B/ws",
   "heartbeatIntervalMs": 15000,
   "staleAfterMs": 45000,
   "registeredAt": "2026-05-21T00:00:00.000Z"
}
```

Rules:

- Same `installationId` should converge to the existing Spark daemon when policy allows.
- Registration updates display name/version/feature metadata.
- Workspace bindings are reported during WS hello/snapshot, not fixed at registration time.
- Server-visible workspace creation binds the workspace to one reported Spark daemon workspace binding in v0.1.
- Spark daemon access tokens are short-lived. The refresh token is one-time-use: every refresh revokes the previous refresh token and returns a new access/refresh pair.
- OAuth/device-code login is deferred until after v0.1.

### Refresh Spark daemon token

```text
POST /api/v1/runtime/runtimes/{runtimeId}/token/refresh
```

Request:

```json
{
   "refreshToken": "<single-use-secret>"
}
```

Response:

```json
{
   "runtimeId": "rt_01JZ6B",
   "runtimeToken": "<secret>",
   "runtimeTokenExpiresAt": "2026-05-21T01:45:00.000Z",
   "refreshToken": "<new-single-use-secret>",
   "refreshTokenExpiresAt": "2026-06-20T00:45:00.000Z",
   "refreshedAt": "2026-05-21T00:45:00.000Z"
}
```

Rules:

- The Spark daemon stores both secrets in its private config file and refreshes before access-token expiry.
- A refresh token can be consumed exactly once. Reusing an old refresh token fails.
- Refresh tokens cannot authenticate the WebSocket; only unexpired `runtime:connect` access tokens can.

### Open WebSocket

```text
GET /api/v1/runtime/runtimes/{runtimeId}/ws
Authorization: Bearer <runtime-token>
Upgrade: websocket
```

The first Spark daemon message must be `runtime.hello`.

### Create workspace bound to Spark daemon

Workspace creation must choose one Spark daemon workspace binding as owner.

```text
POST /workspaces
Authorization: Bearer <user-token>
```

Request sketch:

```json
{
   "displayName": "Local development workspace",
   "ownerRuntimeId": "rt_01JZ6B",
   "ownerWorkspaceBindingId": "rtwb_01JZ6D"
}
```

Rules:

- The selected binding becomes the only v0.1 management route for that workspace.
- Server stores the owner binding on the workspace record or in a unique active binding table.
- Rebinding/migration is out of v0.1 unless a later RFC explicitly defines it.

### Fetch command payload

```text
GET /commands/{commandId}/payload
Authorization: Bearer <runtime-token>
```

Rules:

- The Spark daemon may fetch payload only for commands routed to one of its active workspace bindings.
- Heavy artifact content is fetched through artifact content endpoints, not embedded in command payload by default.

### Artifact content cache/upload

Canonical artifact content stays in Spark/local artifact stores. The server supports a lazy cache/upload path so the frontend can render artifacts while the Spark daemon bridge is offline or avoid repeatedly proxying large content. Cache fill is triggered by first frontend view/export, explicit prefetch, or share/export operation; artifact production itself records metadata/projections unless content is already server-local.

```text
POST /artifacts/{artifactId}/cache-uploads
PUT  /artifact-cache/{blobId}/content
GET  /artifacts/{artifactId}/content
```

Rules:

- `POST /cache-uploads` creates a server cache target for a Spark/local artifact.
- `PUT /artifact-cache/{blobId}/content` uploads bytes to server cache.
- `GET /artifacts/{artifactId}/content` can serve server cache or route/proxy to the Spark daemon if online, and is the normal lazy-fill trigger for frontend views/exports.
- Server cache lives under the XDG server artifact cache, normally `${XDG_CACHE_HOME:-~/.cache}/navia/server/artifacts`, and is not the canonical artifact store unless a later artifact RFC changes that.
- Server verifies `sizeBytes` and `sha256` when present.
- Cache eviction removes only server cached copies/previews, never canonical Spark daemon content. Evict previews first, then unpinned least-recently-used blobs past TTL/size caps.

## Artifact and provenance rules

Spark daemon-produced artifacts must include provenance:

```ts
interface RuntimeArtifactProvenance {
   workspaceId?: string;
   workspaceBindingId: string;
   projectId?: string;
   clusterId?: string;
   taskId?: string;
   commandId?: string;
   invocationId?: string;
   runtimeId: string;
   producer: string;
   producedAt: string;
   sourceRefs?: RuntimeLocalSourceRef[];
}

interface RuntimeLocalSourceRef {
   label: string;
   localPathHash?: string;
   localPathDisplay?: string;
}
```

Guidelines:

- Prefer labels/hashes over raw local paths.
- Use `localPathDisplay` only when explicitly useful and safe.
- Server metadata/projections should be enough for the evidence board without requiring raw daemon-local paths.
- Required artifact content should be available through Spark daemon or server cache before the UI presents it as fully viewable.

## Reconciliation

When a Spark daemon reconnects, the server and Spark daemon bridge converge communication projections with Spark-owned execution state.

Flow:

```text
1. Spark daemon opens WS and sends managed workspace inventory + activeInvocationIds + blockedHumanRequestIds.
2. Server sends runtime.reconcile.request with server-known open commands, mirrored active invocations, and pending human responses for that Spark daemon's owned workspace bindings.
3. Spark daemon replies runtime.reconcile.report with actual local state and blocked human waits.
4. Server updates delivery/projection status and requests any missing snapshots/events.
5. Spark daemon decides which local invocations can resume, complete, fail, cancel, or become lost.
6. Server redelivers any answered human responses that were not acknowledged before disconnect.
```

Server -> Spark daemon:

```json
{
   "type": "runtime.reconcile.request",
   "messageId": "msg_01JREC",
   "payload": {
      "openCommands": [{ "commandId": "cmd_01JZ80", "serverStatus": "acked" }],
      "mirroredActiveInvocations": [
         { "invocationId": "inv_01JZ79", "serverMirrorStatus": "running" }
      ],
      "pendingHumanResponses": [
         { "humanRequestId": "hreq_01JZ90", "humanResponseId": "hres_01JZ93" }
      ]
   }
}
```

Spark daemon -> server:

```json
{
   "type": "runtime.reconcile.report",
   "messageId": "msg_01JRECR",
   "payload": {
      "workspaceBindings": ["rtwb_01JZ6D"],
      "invocations": [
         {
            "invocationId": "inv_01JZ79",
            "localStatus": "running",
            "canResume": true,
            "lastLocalSequence": 31,
            "message": "Provider process still active"
         }
      ],
      "blockedHumanRequests": [
         {
            "humanRequestId": "hreq_01JZ90",
            "toolCallId": "toolu_01JZ92",
            "localStatus": "waiting_for_response"
         }
      ]
   }
}
```

Rules:

- Server should not duplicate execution solely because a WS connection dropped.
- Server marks connection/delivery state stale; the Spark daemon bridge reports Spark execution truth.
- Pending human requests remain pending while the Spark daemon is offline.
- Answered but unacknowledged human responses are redelivered after reconnect.
- If Spark daemon cannot prove local state, Spark daemon may emit `lost` and require explicit retry.

## Liveness defaults

Recommended v0.1 defaults:

```text
heartbeatIntervalMs = 15_000
staleAfterMs        = 45_000
commandAckTtlMs     = 30_000
staleReconnectGraceMs = 300_000
```

Rules:

- Heartbeats refresh Spark daemon connection liveness.
- Invocation events refresh mirrored UI status.
- If heartbeat expires, server marks the Spark daemon connection offline and workspace bindings degraded/unavailable.
- Server should not mark Spark-owned invocations failed solely from heartbeat expiry.
- Human asks/reviews remain pending regardless of Spark daemon liveness.
- If a human answers while the owning Spark daemon is offline, server stores the response and delivers it after reconnect.

## Security and trust

Minimum requirements:

- Spark daemon tokens are revocable and scoped to Spark daemon identity plus workspace grants.
- Enrollment tokens are not stored in plaintext after creation.
- Server validates every routed command against Spark daemon token grants and workspace binding ownership.
- Server must not rely only on Spark daemon self-reported capabilities for user authorization.
- Spark daemon enforces local allowlists/policy before mutating repos or invoking Spark/runtime tools.
- Spark daemon handles local workdir locks, nested/overlapping path checks, dirty checks, and destructive cleanup safety.
- Spark daemon redacts obvious secrets from logs/artifacts where possible.
- Server stores Spark daemon local path/host details only as redacted labels/hashes/resource refs by default; raw diagnostics must be explicitly marked sensitive.
- Artifact hashes should be verified when supplied.
- Cancellation and draining are authenticated control operations.

Explicitly out of v0.1 unless required later:

- mutual TLS;
- inbound server-to-Spark daemon connections;
- arbitrary server-initiated shell commands;
- interactive terminal relay;
- HTTP polling-only Spark daemon;
- OAuth/device-code login;
- object-storage-only artifact backend;
- broad multi-version compatibility.

## Server data-model implications

Because the server is a communication plane, its durable state should focus on routing, projections, and audit rather than owning Spark daemon internals.

Expected protocol-related records:

```text
runtime_enrollment_tokens
runtimes
runtime_tokens or runtime_credentials
runtime_sessions
runtime_workspace_bindings
runtime_workspace_snapshots
workspace_owner_bindings
commands
command_deliveries
human_requests
human_responses
protocol_messages or communication_events
mirrored_invocations
invocation_events
invocation_log_chunks
artifact_projections
artifact_cache_blobs
```

Important constraints:

- `runtimes.installation_id` should be unique when present.
- `runtime_workspace_bindings` are the routing bridge between server-visible workspaces and daemon-local workspace keys.
- `workspace_owner_bindings` or equivalent uniqueness constraints ensure one owning Spark daemon binding per workspace in v0.1.
- Command delivery state is server-owned communication state.
- Human request/response state is server-delivered but Spark-daemon-originated; responses route back only to the owning workspace binding.
- Invocation state is Spark-owned and mirrored for UI.
- Artifact projections are server-visible metadata; canonical content remains in Spark/local artifact stores unless explicitly cached/exported.
- Server projections should be rebuildable from Spark daemon snapshots/events where practical.

## Protocol fixtures

`packages/protocol` should include fixtures before implementation:

```text
packages/protocol/src/fixtures/runtime-v1/
├── register-runtime.request.json
├── register-runtime.response.json
├── runtime-hello.ws.json
├── server-hello-ack.ws.json
├── workspace-snapshot.ws.json
├── server-command.ws.json
├── runtime-command-ack.ws.json
├── runtime-command-reject.ws.json
├── human-request-created.ws.json
├── human-response-deliver.ws.json
├── human-response-ack.ws.json
├── invocation-started.event.json
├── invocation-log.event.json
├── invocation-completed.event.json
├── artifact-projection.event.json
├── artifact-cache-upload.request.json
├── cancellation-command.ws.json
├── reconcile.request.ws.json
└── reconcile.report.ws.json
```

Fixture rules:

- Every fixture validates against Zod schemas.
- OpenAPI generation includes all HTTP endpoints.
- WS message schemas are documented even if OpenAPI cannot represent them directly.
- Spark daemon/future compatibility CI can validate fixtures without importing server internals.

## Minimal implementation slice

Implement v0.1 in this order:

1. Protocol package schemas and fixtures.
2. Spark daemon enrollment/register endpoint.
3. Required WS hello/session establishment.
4. Spark daemon workspace binding inventory and snapshots.
5. Workspace creation with one owning Spark daemon binding.
6. WS heartbeat/liveness model.
7. Server command record + delivery model.
8. WS command route + Spark daemon ack/reject.
9. Command payload fetch endpoint.
10.   Spark daemon-originated human request + server/frontend response delivery.
11.   Spark daemon invocation event/log mirroring over WS.
12.   Artifact projection + optional server cache upload path.
13.   Cancellation command and Spark daemon terminal result events.
14.   Reconnect reconciliation including blocked human requests.
15.   Workspace/project UI projections that downplay Spark daemon identity.
16.   Diagnostics/settings surface for Spark daemon connection health.

Defer until after v0.1:

- HTTP polling-only Spark daemon;
- direct browser-to-Spark daemon diagnostic/pairing implementation;
- OAuth/device-code Spark daemon login;
- signed object-storage uploads;
- provider-specific session resume protocol;
- interactive terminal relay;
- server-side per-resource/workdir leases;
- server-side provider scheduling;
- multi-Spark daemon co-management of one workspace;
- workspace owner binding migration/rebinding;
- broad multi-version compatibility.

## Testing requirements

Minimum protocol tests:

- registration with same installation id converges;
- unsupported protocol version is rejected loudly;
- Spark daemon token cannot route commands outside its grants;
- Spark daemon can report multiple workspace bindings;
- workspace creation fixes exactly one owning Spark daemon binding;
- commands for a workspace route only to its owning binding;
- frontend projections are workspace-first and do not require a primary Spark daemon page;
- heartbeat marks Spark daemon connection online/offline without declaring Spark-owned invocations failed;
- workspace snapshot updates projections predictably;
- command delivery is idempotent;
- command ack/reject is idempotent;
- rejected command records reason and does not start mirrored invocation;
- Spark daemon-created human request appears in web inbox and blocks until answered;
- human response is delivered only to the owning Spark daemon binding and acknowledged before returning to tool;
- answered-but-unacknowledged human responses redeliver after reconnect;
- duplicate lifecycle events converge;
- log chunks preserve sequence/gap metadata;
- artifact projection validates provenance;
- artifact cache upload verifies hash/size when supplied;
- cancellation command is delivered and Spark daemon terminal `cancelled`/`failed` is mirrored;
- reconnect reconciliation can resume, complete, fail, cancel, or mark invocation lost based on Spark daemon report;
- Spark daemon liveness changes do not auto-resolve human asks/reviews.

## Remaining deferred questions

These are not blockers for v0.1 development:

1. Workspace owner binding migration/rebinding flow, if ever needed.
2. Authorization/audit UX for the diagnostic/pairing placeholder, if/when it becomes an implementation.

Selected for v0.1 development:

- Persist Spark daemon snapshots/events and normalized SQLite projections for normal UI queries.
- Do not fetch project/task state on demand from the Spark daemon for normal page loads.
- Keep workspace owner binding migration/rebinding out of v0.1.
- Keep direct browser-to-Spark daemon diagnostic/pairing out of v0.1.

## Decision summary

Current recommended defaults:

```text
Spark daemon role = multi-workspace capability hub
Server role = communication plane + projections + audit
Frontend stance = workspace/project first; Spark daemon downplayed to connection diagnostics
Connectivity = Spark daemon-initiated outbound HTTP setup/content + required WebSocket control
Registration = enrollment token -> runtime wire token
Workspace model = Spark daemon reports multiple bindings; each workspace is fixed to one owning binding at creation in v0.1
Command model = server routes commands to the workspace's owning binding; Spark daemon ack/rejects and owns execution
Ask/review model = Spark daemon creates human requests from agent tool calls; server/frontend collect response; Spark daemon blocks and returns tool result
Scheduling = Spark daemon-side capability/policy decision, not server-side provider scheduling
Resource/workdir safety = Spark daemon-side in v0.1
Run limit = no default or required maxRunMs in v0.1
Liveness = server connection status + Spark-runtime reconciliation for execution truth
Logs/events = append-only envelopes with sequence/idempotency metadata over WS
Artifacts = Spark/local canonical content + lazy server projection/cache/proxy under the XDG server artifact cache
Diagnostics = redacted labels/resource refs/hashes by default
Compatibility = fail loud on unsupported pre-v1 versions
Projection persistence = raw snapshots/events + normalized SQLite projection tables for normal UI reads
```
