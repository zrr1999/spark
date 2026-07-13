# Assignment and channels

The user-facing unit is a **conversation turn**. Cockpit and IM channels
(Feishu, Infoflow, QQ Bot, ...) are entry surfaces for the same daemon-owned session;
projects, tasks, and assignments are internal execution projections created by
Spark rather than separate objects the user must create first.

One-line rule: *the daemon owns the conversation; every surface submits a turn
to it, and Spark derives any internal work records it needs.*

## Product equivalence

| Entry | Shape | User |
| --- | --- | --- |
| Cockpit Sessions (`/sessions`) | Current-workspace + daemon-global conversations | Browser operator |
| Channels (Feishu / Infoflow / QQ Bot) | Inbound chat -> bind/reuse workspace session -> turn | Chat operator |
| Legacy project chat `task.start.request` | Compatibility only | Must converge onto Assign |

Cockpit primary Assign surface is **Sessions** (not the project page). Cockpit
uses a dual-track shell:

- **Workbench** — Sessions, Overview, Inbox, Artifacts (assignment / ops).
- **Console** — Global settings, workspace settings (including Channels),
  registration, and create workspace (`/workspaces/new`).

Channel setup lives under **Console → Workspace settings → Channels**
(`/{workspace}/settings/channels`): list existing channel-bound sessions, or create
a new one by picking Feishu/Infoflow/QQ Bot, entering credentials when that
adapter is not yet configured, and providing a chat/user/group id. Cockpit merges
adapter credentials into
`$SPARK_HOME/workspaces/<workspaceId>/channels/config.json` via `channel.configure`,
creates a workspace session (`session.create`), binds
`externalKey` (`session.bind`), and redirects to `/sessions/{sessionId}`.
Cockpit and TUI read listener liveness through `channel.status`; they never
reconstruct it from the config file. Message I/O is daemon↔IM only (no
server/cockpit relay). Legacy `$SPARK_HOME/channels/config.json` is migrated into
a workspace on first load/configure.

Do **not** maintain a second state machine for channels. Channel ingress and
Cockpit both submit through the daemon session/turn control plane. The
`SparkAssignment` carried on a queued run is internal context, not a second
conversation or a user-managed task.

## Session management (foundation)

Daemon owns session lifecycle and the channel binding table. TUI, Cockpit, and
channel adapters are clients.

Every new record has an explicit durable scope:

- `{ kind: "workspace", workspaceId }` belongs to one workspace. Cockpit shows
  it only while that workspace is active.
- `{ kind: "daemon", daemonId }` is a daemon-global conversation. The receiving
  daemon injects its stable installation id; clients cannot choose or spoof it.

The Cockpit rail shows only the active workspace scope plus explicit
daemon-global scopes. Legacy records that only carry `workspaceId` remain
workspace-scoped; they are never guessed to be global. This is why an old
`workspaceId="spark"` session does not appear as an "unknown workspace" while
the `spore` workspace is active, while its registry data remains intact.

| Capability | Command surface | Notes |
| --- | --- | --- |
| create | `spark daemon session create` | workspace, title, optional role → stable `sessionId` |
| list / show | `spark daemon session list\|show` | status, bindings, active run |
| bind / unbind | `spark daemon session bind\|unbind` | `externalKey` → `sessionId` |
| resolve | internal API | reuse binding or create/reject per policy |
| fork | `spark daemon session fork` | writes the same registry |
| archive | `spark daemon session archive` | stop ingress; keep transcript |

Binding keys (v1): `feishu:chat:<id>`, `infoflow:user:<id>`,
`infoflow:group:<id>`, `qqbot:c2c:<openid>`, `qqbot:group:<group_openid>`,
`qqbot:channel:<channel_id>`, or `conv:<adapter>:<id>` → Spark `sessionId`.
Cross-platform identity merge and `bridge_*` peers are out of scope for v1.

Infoflow and QQ Bot ingress policy (on the adapter config):

| Field | Meaning |
| --- | --- |
| `allowed_user_ids` | Private allowlist (sender id / openid). Empty = allow all private. |
| `group_policy` | `disabled` (default) \| `allowlist` \| `open` |
| `group_trigger` | `mention` (default) \| `command` \| `all` |
| `allowed_group_ids` | Used when `group_policy` is `allowlist` |
| `system_prompt` | Optional custom system-prompt overlay (operator copy only) |

Prompt layers for Infoflow channel runs: shared Spark identity + internal
surface/policy summary + optional `system_prompt`; per-message sender/group
facts live in a dynamic system-prompt section. The canonical user message is
only the human's text, so Cockpit does not render transport plumbing in the
transcript.

Private chats bind as `infoflow:user:<senderId>`; group chats bind as
`infoflow:group:<groupId>` (one session per group, not per sender).

QQ Bot private chats bind as `qqbot:c2c:<openid>`; groups as
`qqbot:group:<group_openid>`; guild channels as `qqbot:channel:<channel_id>`.
Outbound reply recipients use `c2c:…` / `group:…` / `channel:…`. C2C replies
may stream via the platform stream API; group/channel replies are one-shot text.

Rules:

1. Assign must target an existing `sessionId`, or explicitly create then assign.
2. Channel inbound only uses session resolve/bind; adapters never keep a private
   session table.
3. TUI attach/resume consumes the same `sessionId`.
4. Session mail remains explicit session↔session peer mail behind `role({ action: "send" })`; it does not replace bind and does not execute the target session.

## Assignment intent

```ts
type SparkAssignment = {
  goal: string;
  target: { sessionId: string; role?: string; workspaceId?: string };
  constraints?: string[];
  evidence?: string[];
  source: {
    kind: "cockpit" | "channel";
    channel?: "feishu" | "infoflow" | "qqbot";
    externalRef?: string;
  };
};
```

- Cockpit execution: daemon local RPC `turn.submit`
- Channel execution: binding resolve followed by the same daemon `session.run`
  queue primitive
- `SparkAssignment` remains an internal envelope for goal/source/target context
  and does not imply a user-created project or task

## Channel adapters

Product surface follows pi-channels (`adapters` / `routes` / `notify` / ingress).
Runtime semantics follow nyakore: adapters do I/O only; they do not run prompts;
Infoflow inbound uses the official `@core-workspace/infoflow-sdk-nodejs` WSClient
(same as nyakore; prefer a build with `autoRegister` so first connect switches the
app to WebSocket callback mode via `/imRobot/updateReCallUrl`), while Spark keeps
daemon-owned session bindings (`infoflow:user:<id>` / `infoflow:group:<id>`).
QQ Bot inbound uses the Open Platform WebSocket gateway plus HTTP message APIs
(no OpenClaw dependency), with bindings `qqbot:c2c:<openid>` /
`qqbot:group:<group_openid>` / `qqbot:channel:<channel_id>`.
Outbound replies are explicit (no transcript scraping).

Ownership:

| Layer | Owner |
| --- | --- |
| Protocol (session / assignment / channel events) | `spark-protocol` |
| Session registry + bind + queue delivery | `spark-daemon` |
| Platform adapters (Feishu WS, Infoflow, QQ Bot, …) | `spark-channels` |
| Assign UI + read-only projections | Cockpit / `spark-server` |
| Interactive attach | `spark tui` |

Config sketch (secrets stay out of the repo):

```toml
[channels.adapters.feishu]
type = "feishu"
event_mode = "websocket"

[channels.adapters.infoflow]
type = "infoflow"
# allowed_user_ids = ["zhanrongrui"]
# group_policy = "disabled" # disabled (default) | allowlist | open
# allowed_group_ids = ["10838226"]

[channels.adapters.qqbot]
type = "qqbot"
# app_id = "111111111"
# client_secret = "..."
# group_policy = "disabled"
# group_trigger = "mention"

[channels.routes.ops]
adapter = "feishu"
recipient = "oc_xxx"

[channels.ingress]
# enabled follows adapter presence (enable a channel adapter to listen)
# on_unbound = "create" | "reject"
on_unbound = "create"
```

## Plane ownership

| Resource | Plane | Notes |
| --- | --- | --- |
| `session` create/list/show/bind/archive/fork | `spark daemon` | execution truth |
| conversation turn | `spark daemon` | `turn.submit` -> `session.run`; execution truth |
| `channel` list/status/configure/reload | `spark daemon` | config + listener lifecycle |
| Cockpit conversation UI | `spark cockpit` host | submits daemon turns over local RPC |
| TUI attach | `spark tui` | not an ingress plane |

## Non-goals (v1)

- A public `spark gateway` name or second long-lived gateway service
- TUI or Cockpit holding Feishu/Infoflow/QQ Bot long-lived connections
- Full NNP, `bridge_*` sessions, cross-platform identity bindings
- WeCom / DingTalk / Telegram / generic webhook adapters
- QQ Bot HTTP webhook transport, rich media, STT/TTS, slash commands
- Feishu HTTP callback mode, progress cards, typing reactions
- Separate channel inbox state machine competing with Assign

## Relation to `task.start.request`

Project chat that enqueues `task.start.request` remains a compatibility path.
New UI and docs treat Assign + session selection as canonical. Implementations
should map Assign onto the same daemon execution primitives so both paths stay
observable under one assignment/source model.
