# spark-artifacts

Typed durable artifact storage with provenance.

Artifact bodies are stored as content-addressed blobs. Small artifact metadata keeps
an inline body for ergonomic callers; large bodies are compacted to a bounded
preview in metadata and hydrated from the blob by `ArtifactStore.get()` /
`getBody()`.

Use `ArtifactStore.compactMetadata({ dryRun: true })` before rewriting legacy
metadata. Compaction never deletes blobs; it only replaces verified large inline
metadata bodies with previews.
