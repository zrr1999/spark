# pi-artifacts

Reusable artifact/evidence storage for Pi extensions.

`pi-artifacts` owns content-addressed artifact metadata, blobs, provenance, links, and the canonical `artifact` tool for Pi capability packages and host facades.

Prefer constructing `ArtifactStore` with an explicit `rootDir` owned by the host package. The exported `defaultArtifactStore(cwd)` still reads `.spark/artifacts/` as a compatibility default for existing local evidence.
