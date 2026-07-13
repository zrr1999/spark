# Tool approval methods design

Status: approved for implementation
Date: 2026-07-13

## Decision

Do **not** model tool policy as allow / deny / auto-review.

Instead:

1. **Tool visibility** — disable a tool so it is omitted from the agent tool list / context. That is how “refuse to allow use” works. Execution never sees disabled tools.
2. **`requiresApproval`** — tool registration declares whether a call needs an approval gate.
3. **`approvalMethod`** (session / host) — how to satisfy that gate when `requiresApproval` is true:
   - `skip` — treat as approved and execute
   - `human` — ask / existing `toolApproval` interaction
   - `auto` — reviewer channel shared with goal completion; default method

When `auto` does not approve, default action is escalate to ask (`human`); configurable to deny (tool error). Ask timeouts are owned by ask later.

## Defaults

| Surface | Cue (and later other) `requiresApproval` | `approvalMethod` |
| --- | --- | --- |
| Channel-created sessions | yes (cue exec family) | `auto` |
| Local TUI | yes on cue exec family | `skip` |
| Loop default when unset | — | `auto` (missing reviewer → escalate to ask) |

## Data flow

```text
enabled tool call
  → requiresApproval?
       no  → execute
       yes → approvalMethod
            skip  → execute
            human → ask / toolApproval
            auto  → ReviewerRunner tool_approval subject
                      approved → execute
                      else → ask (default) or deny
```

## Scope

- Interface is host/tool-wide; first concrete `requiresApproval` markings are cue exec family.
- Non-goals: Cursor SDK sandbox as this gate; ask timeout rewrite; execution-path handling of disabled tools.
