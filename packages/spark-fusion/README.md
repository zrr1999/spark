# @zendev-lab/spark-fusion

Spark-native, bounded multi-model deliberation over the host-provided
`LeafCapabilityRunner`.

The capability runs two to four independent panel calls concurrently, asks a
separate judge for a strict comparison, and returns that comparison to the
calling model. The judge does not write the user-facing answer: the active
Spark model remains the writer and must verify the advisory result.

## Tool surface

The extension registers one canonical action tool:

```text
fusion action=deliberate question="..."
```

Panel and judge calls have no tools, sessions, or recursive Fusion access. The
tool requires approval because explicit model choices can cross provider
boundaries and every deliberation incurs additional model cost. Invalid model
output is never accepted as a successful panel or judge result.

## Host boundary

This package depends only on `spark-core` and receives model execution through
the injected leaf runner. It does not own provider selection, credentials,
workflow policy, role execution, persistence, or product-specific integration.
Its advisory result is neither runtime evidence nor a Product Artifact, and it
cannot satisfy a workflow proof or gate.

Import `@zendev-lab/spark-fusion/extension` from a Spark-native host to register
the tool explicitly. Keep it opt-in until the host has an appropriate cost and
data-egress policy for its configured providers.
