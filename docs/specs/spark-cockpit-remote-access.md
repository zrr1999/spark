# Spark Cockpit remote access

Cockpit is local-first and listens on loopback by default. Remote browser authority is progressive:

1. **Cockpit access** — one-time `spark_cockpit_auth_…` key exchanged at `/login` for a Cockpit owner session (control plane).
2. **Workspace access** — one-time `spark_workspace_auth_…` key exchanged at `/{slug}/login` for that workspace only.

Minting stays in `@zendev-lab/spark-coordination`. Operators use thin CLIs:

```sh
spark cockpit access create [--label <text>] [--json]
spark daemon workspace access create [--workspace <name>] [--json]
```

## Direct private-network access

```sh
pnpm --filter @zendev-lab/spark-cockpit run build
HOST=0.0.0.0 PORT=5173 spark cockpit
```

Prefer an encrypted private path such as Tailscale, WireGuard, or SSH forwarding. Protected non-loopback requests redirect to `/login` until the browser exchanges a Cockpit key. Workspace data routes then require `/{slug}/login`.

## Trusted reverse proxy

```sh
HOST=127.0.0.1 \
SPARK_COCKPIT_PUBLIC_URL=https://spark.example.com \
SPARK_COCKPIT_TRUST_PROXY=loopback \
spark cockpit
```

`SPARK_COCKPIT_PUBLIC_URL` must be an `http(s)` origin at `/`; path mounting is unsupported. `SPARK_COCKPIT_TRUST_PROXY=loopback` is valid only with a loopback listener. The proxy must:

- preserve the public host;
- replace or sanitize forwarding headers;
- send `X-Forwarded-For` and `X-Forwarded-Proto`;
- forward WebSocket upgrades and unbuffered streaming responses;
- reject unknown public hosts.

`SPARK_COCKPIT_PROXY_HOPS` accepts 1-10 trusted entries from the right of `X-Forwarded-For`. A changed public origin changes daemon server identity; re-register affected workspaces with fresh workspace tokens.

Use `SPARK_COCKPIT_PUBLIC_URL=auto` only behind the same trusted loopback proxy when the proxy supplies the hostname.

## Progressive authorization flow

1. On the Cockpit host, mint a Cockpit browser key: `spark cockpit access create`. Open `/login` and exchange it for Cockpit session cookies (`spark_cockpit_session` + rotating refresh).
2. Create or open a workspace in the control plane. In connection settings (or via daemon registration), obtain a workspace registration token and run `spark daemon workspace register ... --token ...` from the daemon-owned directory.
3. Successful registration binds that directory and prints a `spark_workspace_auth_...` browser key plus `/{slug}/login`. The key expires after 10 minutes and can be consumed once. Additional browsers use `spark daemon workspace access create`.
4. `/{slug}/login` exchanges the workspace key for workspace session cookies (`spark_workspace_session` + rotating refresh). Refresh rotates both credentials; replaying the previous refresh credential fails.
5. A Cockpit session alone does not open another workspace’s sessions, artifacts, or SSE. A workspace session for A cannot open workspace B or global Cockpit settings without a Cockpit session.

Loopback clients retain the local owner flow for the control plane. Runtime enrollment and runtime WebSocket endpoints under `/api/v1/runtime/` use separate runtime credentials. Static PWA assets plus `/login`, `/{slug}/login`, and `/logout` remain available before the matching browser login.

Use HTTPS or an encrypted overlay network. Revoking an unused browser key prevents its exchange; logout revokes current browser sessions.
