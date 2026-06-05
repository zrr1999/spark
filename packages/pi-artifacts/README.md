# pi-artifacts

Reusable artifact/evidence storage for Pi extensions.

`pi-artifacts` owns content-addressed artifact metadata, blobs, provenance, links, and the canonical `artifact` tool. Spark uses this package for task/run/ask/learning evidence instead of owning a separate artifact tool namespace.

Current default project storage remains `.spark/artifacts/` to avoid migrating existing local evidence during the capability split.
