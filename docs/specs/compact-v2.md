# Compact V2

Compact V2 has two context-reduction passes with one persisted full-compaction format. It preserves tool-call/result pairing and exact tool-result content that is marked for preservation; compaction must not turn untrusted runtime data into control instructions.

## Configuration

The `compact` object in Spark `config.json` accepts these fields:

| Field | Default | Contract |
| --- | ---: | --- |
| `enabled` | `true` | Enables automatic micro/full scheduling. Explicit recovery may still request a full pass. |
| `microThreshold` | `0.75` | Context-window utilization ratio at which one stateless micro pass is eligible. |
| `fullThreshold` | `0.9` | Utilization ratio requiring a persisted full pass after micro reduction. It must be greater than `microThreshold`. |
| `targetReduction` | `0.4` | Fraction of compactable context a micro pass attempts to remove. Repeated full compaction also uses it to reduce the previous summary budget. |
| `minUsefulReduction` | `0.05` | Minimum measured reduction accepted from micro or repeated full compaction. A lower-yield candidate is discarded. |
| `compactModel` | `"current"` | Selects the active session model for Smart summarization; another string selects that explicit model ID. Hosts without a model-backed compact runner use the deterministic fallback and record why. |
| `reserveTokens` | `16384` | Legacy full-compaction safety reserve while V2 scheduling adoption is completed. |
| `keepRecentTokens` | `20000` | Approximate recent-context budget protected from a full pass. |

Invalid values fall back to defaults. Ratios must be finite numbers in `[0, 1]`; the normalized full threshold remains above the micro threshold. Token budgets are nonnegative integers.

Example:

```json
{
  "compact": {
    "enabled": true,
    "microThreshold": 0.75,
    "fullThreshold": 0.9,
    "targetReduction": 0.4,
    "minUsefulReduction": 0.05,
    "compactModel": "current",
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

## Passes

A micro pass is stateless and model-free. It compacts eligible old tool output and other bounded message content until `targetReduction` is reached, while preserving recent and exact content. If its measured reduction is below `minUsefulReduction`, the original replay is retained. If replay remains above `fullThreshold`, scheduling requests one full pass.

A full pass writes a versioned compaction entry to the session JSONL. The entry contains the summary, cut point, token count before compaction, structured details when Smart summarization succeeded, and outcome metadata. Context-overflow recovery may compact a previous compaction leaf; each accepted retry must reduce the same replay meter by at least `minUsefulReduction`. A low-yield candidate entry is removed and provider retry stops, bounding repeated overflow recovery.

`/compact` and automatic/recovery compaction emit `session_before_compact` before persistence and `session_compact` after the attempt. A successful full event carries `compactType: "full"`, `succeeded: true`, and the persisted compaction entry. Projection listeners cannot change an already durable compact outcome.

## Token Source

Every full-compaction outcome reports one `tokenSource` label:

- `reported`: nonzero usage reported by the provider for the current replay.
- `tokenizer`: a configured model tokenizer measured the replay.
- `estimated`: neither source was available, so Spark used the deterministic character-based estimate.

Reduction compares the same replay meter before and after compaction. Provider usage from the pre-compaction request is not compared directly with a locally estimated post-compaction replay.

## Memory Handoff

The Memory extension keeps its `session_before_compact` checkpoint behavior. The hidden checkpoint is delivered as `nextTurn` with `triggerTurn: false`, so it joins the next real user request and never starts a post-compact model call.

After a successful full compaction with a structured Smart summary, Memory asynchronously derives `stable_fact` and `open_item` recall candidates. Candidate review and persistence do not block the compact caller. Open items are never promoted automatically. A stable fact reaches durable Memory only when it has a directly associated `artifact:` or `evidence:` reference and that reference resolves in the local evidence store; missing, malformed, or unreadable evidence fails closed. Candidate review, evidence lookup, and Memory write errors remain background failures and do not alter the completed compaction.
