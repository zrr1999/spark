# Human interaction

Canonical contract for structured human asks and approvals across daemon, Cockpit, channels, and in-turn TUI UI.

## Ownership

- **Daemon is truth** for durable waits (`daemon_human_waits`) and whether an interaction is still open.
- **Cockpit** owns a read model (`human_requests`, inbox items) plus an outbox for operator responses (`human_responses` delivery).
- **`spark-ask`** owns only the in-turn terminal UI state machine (tabs, drafts, focus). It must not become a second durable store.
- **Channels** (e.g. QQ buttons) project and settle the same daemon wait; they do not invent terminal statuses.

## Supported interaction kinds (daemon broker)

The durable daemon broker currently settles:

- `askFlow` — structured questions (primary Cockpit / channel path)
- `toolApproval` — approve/reject a tool call (projected as a single-choice ask wait, then mapped back to a `toolApproval` response)

Other protocol kinds (`confirmation`, `diffApproval`, `modelSelect`, `workflowPicker`) remain host/TUI-local until a broker path exists. Do not assume Cockpit inbox can settle them.

## Status vocabulary

Use the shared enums from `@zendev-lab/spark-protocol` (`human-interaction.ts`):

| Layer | Status set | Meaning |
|---|---|---|
| Daemon wait / human request | `pending` → `answered` \| `cancelled` \| `archived` | Interaction lifecycle |
| Response payload to daemon | `answered` \| `cancelled` \| `archived` | Operator / channel reply |
| Cockpit response delivery | `delivering` → `acked` \| `failed` | Outbox transport only |
| Inbox item projection | `pending` \| `resolved` \| `archived` | UI bucket; `resolved` covers answered/cancelled |

Do not add extra terminal states at any projection layer. Map with `projectInboxItemStatus` when deriving inbox rows.

## Correlation

Stable ids must travel together:

- `humanRequestId` — durable daemon wait id
- `interactionRequestId` — optional host/tool correlation
- `humanResponseId` — Cockpit / channel response id

## Answer semantics

Whether an answer “counts” (option selected or non-empty custom text) is defined once by `hasSparkAskAnswerContent` / `parseSparkAskChoice` in `spark-protocol` (`ask-semantics.ts`).

- TUI (`spark-ask`) re-exports those helpers for the flow controller and presents asks as an in-turn overlay.
- Cockpit shows pending asks inline in the owning session (timeline `ask` tool part + composer `SessionAskPanel`); the workspace Inbox page remains the list/detail fallback. There is no global ask dialog.
- Approval-center builds decision payloads with the shared response status enum; it does not re-derive answer content rules.

Cross-session agent-to-agent traffic is **messages** (session inspector tab), not Inbox. Inbox is only agent→user human asks.

## Related

- [`tools.md`](./tools.md) — `ask` is the only structured question surface; cancellation is not approval.
- [`turn.md`](./turn.md) — daemon is execution truth; transports are adapters.
- [`sessions-and-channels.md`](./sessions-and-channels.md) — session mail `question` is a different cross-session wait primitive from tool-level human waits.
