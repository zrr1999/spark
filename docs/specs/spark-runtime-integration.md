# Spark runtime integration

Use the root CLI for scheduler, CI, or local manager integration:

```text
spark run "fix the failing tests"
spark run --json "fix the failing tests"
spark run --resume <session-id> "continue"
spark bg --session <session-id> "continue"
spark doctor
```

Compatibility aliases are `spark --print`, `spark -p`, and `spark --mode json --print`. New integrations should use `spark run` and parse only JSON output.

## JSONL acceptance stream

`spark run --json` emits one UTF-8 JSON object per line in this order:

1. `session`
2. `agent_start`
3. `turn_start`
4. `queue_update`
5. `turn_end`
6. `agent_end`

`queue_update` reports steering or follow-up input. Consumers must ignore unknown fields and tolerate added event types.

The durable acknowledgement is `turn_end.result`:

```json
{
  "type": "turn_end",
  "result": {
    "action": "submit",
    "result": {
      "invocationId": "inv_0123456789abcdef",
      "status": "queued",
      "acceptedAt": "2026-07-13T00:00:00.000Z"
    }
  }
}
```

Persist the session ID from the `session` event and the invocation ID from this receipt. A non-zero process exit before `turn_end` means no accepted acknowledgement was returned.

## Invocation control

```text
spark daemon submit --session <session-id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
spark daemon session export --session <session-id> --format jsonl
spark daemon session replay --session <session-id>
```

`submit` returns `{ invocationId, status: "queued", acceptedAt }`. Status and stream are cursor-based and bounded. A stream client must retain `nextCursor`, retry transport disconnects with the same `after` value, and treat cursor-gap or unknown-invocation errors as terminal diagnostics rather than reconnect signals. Status never contains an event array. Automation must parse JSON output only.

Use `spark bg` for fire-and-return behavior. Pass a manager-owned session ID when correlation and continuity matter; otherwise Spark creates one. Project-bound integrations should retain later evidence and review refs in addition to the process receipt.
