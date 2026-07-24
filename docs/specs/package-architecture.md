# Package architecture

Spark package boundaries follow execution ownership, state ownership, and
adapter/runtime placement. They do not follow file count alone.

The machine-readable source of truth is
[`../../architecture/packages.json`](../../architecture/packages.json). Every
workspace declares a `layer`, `owner`, `stability`, and authoritative
`stateWriter`. `pnpm run check:architecture` rejects an unclassified workspace,
an undeclared production dependency, a stale export, a second public package,
or growth beyond the current 40/40-workspace budget.

## Dependency direction

```text
apps (CLI / TUI / daemon / Cockpit)
  ↓
composition + clients (spark-extension / spark-daemon-client)
  ↓
capabilities + runtimes (tasks / sessions / workflows / host / turn / ...)
  ↓
contracts + foundations (spark-protocol / spark-core / spark-system / ...)
```

Adapters point inward. Foundations never point at apps or product-private
adapters. Cockpit-private packages may be used by Cockpit, but not by the
daemon or shared Spark packages. The daemon is the authoritative writer for
invocation, session registry, session mail, channel delivery, and execution
state; Cockpit owns its coordination database and projections.

## Layer meanings

| Layer | Responsibility | Must not own |
| --- | --- | --- |
| `application` | executable bootstrap, lifecycle, UI, product wiring | reusable domain contracts |
| `composition` | cross-capability extension registration and host policy | generic mechanisms or app internals |
| `client` | protocol-aware transport to an owning service | durable state |
| `runtime` | host-neutral execution of turns, roles, or tasks | product UI and coordination storage |
| `capability` | one domain vocabulary plus its reusable policy/store mechanism | another domain's state |
| `adapter` | integration with a terminal, channel, shell, or external service | cross-domain orchestration |
| `contract` | JSON-friendly wire schemas and compatibility validation | workspace implementation dependencies |
| `foundation` | small dependency-light primitives and host contracts | product policy |
| `private-adapter` | Cockpit-only storage, projection, or localization | daemon/shared ownership |
| `compatibility` | legacy read or wire compatibility inside a current owner | a second implementation package |
| `experiment` | isolated, non-default spike with an explicit graduation decision | production startup |

## Deliberate boundaries

- `spark-protocol` is a pure wire-contract package. It has no production
  dependency on another Spark workspace.
- `spark-system` contains only local-system mechanisms: paths, permissions,
  commands, SQLite opening, strings, and the socket MessagePort adapter. It has
  no Spark workspace dependency.
- `spark-daemon-client` owns legacy local RPC and oRPC client transports. This
  keeps protocol-aware daemon calls out of the system-primitives package.
- `spark-extension` owns product extension composition and policy for native
  and structurally compatible hosts. Legacy `pi-extension` specifiers are
  rewritten while reading configuration; there is no facade workspace.
- `spark-cockpit-*` names are Cockpit-private. Shared code must move to a
  capability or foundation package before daemon/native reuse.
- `spark-acp-spike` and `spark-mcp-spike` remain experiments until they have a
  production owner, default lifecycle, and validation contract.
- `spark-context` was removed after all callers converged on
  `spark-host/context`; compatibility-only re-export packages are not permanent
  architecture.

## When to create or merge a package

Create a workspace only when at least one hard boundary exists:

1. a separately executed or placed runtime;
2. an independent state owner, permission boundary, or failure domain;
3. a protocol/client boundary with multiple surfaces;
4. a replaceable external adapter;
5. a separately validated experimental lifecycle.

Otherwise add a module to the existing owner. Compatibility reads must name
their native owner and remain behind a frozen decoder. Delete a package when it
only re-exports one owner and has no independent runtime boundary.

## Reference patterns

The design borrows three useful patterns without adopting their toolchains:

- [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)
  separates extension execution from UI placement and distinguishes local,
  web, and remote hosts. Spark similarly keeps TUI/Cockpit adapters outside the
  daemon-owned execution truth.
- [Backstage package roles](https://backstage.io/docs/tutorials/package-role-migration/)
  make package purpose machine-readable so repository tooling can select the
  right treatment. Spark records role-like layer, owner, stability, and writer
  metadata in one inventory.
- [Nx module boundaries](https://nx.dev/docs/features/enforce-module-boundaries)
  enforce dependency constraints from project tags, including multiple
  dimensions. Spark uses the same principle through the inventory,
  dependency-cruiser, and repository-specific ratchets.

Workspace symlinks can otherwise hide missing manifest edges; npm's
[workspace documentation](https://docs.npmjs.com/cli/using-npm/workspaces/)
explains that workspaces are linked into `node_modules`. Spark therefore checks
that every production import of another workspace is also a declared runtime
dependency.
