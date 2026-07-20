# Spark Cockpit remote access

Cockpit is local-first and listens on loopback by default. Remote browser authority is always scoped to one workspace; there is no Cockpit-wide bearer token.

## Direct private-network access

```sh
pnpm --filter @zendev-lab/spark-cockpit run build
HOST=0.0.0.0 PORT=5173 spark cockpit
```

Prefer an encrypted private path such as Tailscale, WireGuard, or SSH forwarding. Protected non-loopback requests redirect to `/login` until the browser exchanges a one-time workspace key.

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

## Workspace authorization flow

1. In one workspace's connection settings, create a one-time workspace registration token.
2. Run the generated `spark daemon workspace register ... --token ...` command from the daemon-owned directory. Existing daemon access/refresh credentials provide connectivity only and cannot replace this token.
3. Successful registration binds that directory and prints a separate `spark_workspace_auth_...` browser key plus the workspace login URL. This key expires after 10 minutes and can be consumed once.
4. `/login` exchanges the browser key for a 15-minute workspace access cookie and a 30-day rotating refresh cookie. Refresh rotates both credentials; replaying the previous refresh credential fails.
5. Generate another one-time browser key from the workspace settings for every additional browser user. A key or session for workspace A cannot open workspace B, its sessions, artifacts, SSE events, or global Cockpit settings.

Loopback clients retain the local owner flow. Runtime enrollment and runtime WebSocket endpoints under `/api/v1/runtime/` use separate runtime credentials. Static PWA assets plus `/login` and `/logout` remain available before browser login.

Use HTTPS or an encrypted overlay network. Revoking an unused browser key prevents its exchange; logout revokes the current browser session. Workspace access is not a Cockpit-wide administrator grant.
