# Spark Cockpit remote access

Cockpit is local-first and listens on loopback by default. Remote access is single-user and requires an explicit token.

## Direct private-network access

```sh
pnpm --filter @zendev-lab/spark-cockpit run build
SPARK_COCKPIT_REMOTE_TOKEN="$(openssl rand -base64 32)" \
HOST=0.0.0.0 PORT=5173 spark cockpit
```

Without `SPARK_COCKPIT_REMOTE_TOKEN`, non-local requests are blocked. Prefer an encrypted private path such as Tailscale, WireGuard, or SSH forwarding.

## Trusted reverse proxy

```sh
HOST=127.0.0.1 \
SPARK_COCKPIT_PUBLIC_URL=https://spark.example.com \
SPARK_COCKPIT_TRUST_PROXY=loopback \
SPARK_COCKPIT_REMOTE_TOKEN="$(openssl rand -base64 32)" \
spark cockpit
```

`SPARK_COCKPIT_PUBLIC_URL` must be an `http(s)` origin at `/`; path mounting is unsupported. `SPARK_COCKPIT_TRUST_PROXY=loopback` is valid only with a loopback listener. The proxy must:

- preserve the public host;
- replace or sanitize forwarding headers;
- send `X-Forwarded-For` and `X-Forwarded-Proto`;
- forward WebSocket upgrades and unbuffered streaming responses;
- reject unknown public hosts.

`SPARK_COCKPIT_PROXY_HOPS` accepts 1-10 trusted entries from the right of `X-Forwarded-For`. A changed public origin changes daemon server identity; run `spark daemon login --server-url <new-origin>` and re-register affected workspaces.

Use `SPARK_COCKPIT_PUBLIC_URL=auto` only behind the same trusted loopback proxy when the proxy supplies the hostname.

## Authentication

Loopback clients keep the local passwordless flow. Other protected UI/API routes require either a `spark_cockpit_session` cookie created by `/login` or `Authorization: Bearer $SPARK_COCKPIT_REMOTE_TOKEN`.

Runtime enrollment and runtime WebSocket endpoints under `/api/v1/runtime/` use their runtime credentials instead. Static PWA assets plus `/login` and `/logout` remain available before browser login.

Use HTTPS or an encrypted overlay network. Do not commit the remote token. Restart with a new token to rotate access; revoke stored sessions as well when immediate global logout is required. This surface is not multi-tenant or hardened as a public admin service.
