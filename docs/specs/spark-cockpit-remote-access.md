# Spark Cockpit remote access

Spark Cockpit is local-first. By default it listens on `127.0.0.1` and localhost browser access remains passwordless for local development. To expose Cockpit to a phone or another machine, opt in deliberately and provide a single-user access token.

## Recommended network path

Use a private network path such as Tailscale, WireGuard, SSH forwarding, or a trusted reverse proxy. This slice does not implement multi-user tenancy, public internet hardening, or account management.

## Start Cockpit on all interfaces

Build Cockpit, choose a high-entropy token, then bind the server to `0.0.0.0`:

```sh
spark cockpit build
SPARK_COCKPIT_REMOTE_TOKEN="$(openssl rand -base64 32)" HOST=0.0.0.0 PORT=5173 spark cockpit
```

`HOST=0.0.0.0` makes the Node server listen on every interface. If the host is `0.0.0.0` but `SPARK_COCKPIT_REMOTE_TOKEN` is missing, non-localhost UI/API requests are blocked and the server prints a warning.

## Bind a custom domain

Keep Cockpit on loopback and put TLS, DNS, and internet exposure in a reverse proxy or tunnel:

```sh
HOST=127.0.0.1 \
SPARK_COCKPIT_PUBLIC_URL=https://spark.example.com \
SPARK_COCKPIT_TRUST_PROXY=loopback \
SPARK_COCKPIT_REMOTE_TOKEN="$(openssl rand -base64 32)" \
spark cockpit
```

`SPARK_COCKPIT_PUBLIC_URL` is the canonical public origin used by generated daemon commands, device authorization links, cookies, and runtime WebSocket endpoints. It accepts only an `http(s)` origin at `/`; mounting Cockpit below a path such as `https://example.com/spark` is not supported. The adapter-level `ORIGIN` variable remains compatible, but the Spark-owned variable is preferred.

`SPARK_COCKPIT_TRUST_PROXY=loopback` is deliberately narrow. It is accepted only while `HOST` is `localhost`, `127.0.0.1`, or `::1`, then configures `X-Forwarded-For` and `X-Forwarded-Proto` handling. The proxy must preserve the public `Host`, provide those headers, forward WebSocket upgrades, and keep streaming responses unbuffered. `SPARK_COCKPIT_PROXY_HOPS` accepts 1–10 and counts trusted entries from the right side of `X-Forwarded-For`.

All explicit remote domains, and every HTTPS public URL, require this loopback-listener/trusted-proxy combination. The proxy must reject unknown public `Host` values and replace, or otherwise safely sanitize, client-supplied forwarding headers. Direct `HOST=0.0.0.0` access remains available without a public-domain override for explicit HTTP/LAN deployments, with the normal remote-token safeguards.

Without trusted-proxy mode, a same-machine reverse proxy would make every browser appear to come from loopback and could bypass the remote-access token. Cockpit therefore refuses every remote public-domain override unless this trust boundary is explicit.

Changing the public domain changes the daemon's server identity. Run `spark daemon login --server-url https://new.example.com` again and re-register affected workspaces; endpoint migration is not implicit.

## Automatic public URL discovery

When a trusted proxy chooses the hostname, Cockpit can derive the public origin per request:

```sh
HOST=127.0.0.1 \
SPARK_COCKPIT_PUBLIC_URL=auto \
SPARK_COCKPIT_TRUST_PROXY=loopback \
SPARK_COCKPIT_REMOTE_TOKEN="$(openssl rand -base64 32)" \
spark cockpit
```

This mode discovers the URL forwarded by the proxy; it does not purchase a domain, modify DNS, or issue certificates. Those mechanisms stay outside Cockpit:

- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) is the recommended private default: it provides a stable `*.ts.net` name and HTTPS automatically.
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) can deliberately publish the same Tailscale name to the internet, but it cannot bind a custom domain.
- [Cloudflare Named Tunnels](https://developers.cloudflare.com/tunnel/routing/) are the preferred public custom-domain path when the zone is already in Cloudflare; DNS routing and edge certificates can be automated.
- [Caddy automatic HTTPS](https://caddyserver.com/docs/quick-starts/https) works with an existing DNS name and reachable ports, but does not allocate a domain or solve NAT.

Cloudflare Quick Tunnels are suitable only for short development previews. Their generated `trycloudflare.com` hostname is unstable and [Quick Tunnels do not support Server-Sent Events](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), which Cockpit uses for live updates.

For the zero-DNS private path, start Cockpit with the `auto` example above, then publish its loopback listener with `tailscale serve --bg 127.0.0.1:5173`. Read the allocated HTTPS endpoint with `tailscale serve status`; the proxy-derived mode uses that request hostname without persisting it. Reset the endpoint with `tailscale serve reset`.

## Authentication behavior

- Requests from loopback client addresses (`127.0.0.1`, `::1`, including IPv4-mapped loopback) keep the existing local developer flow. Cockpit does not trust a spoofed `Host: localhost` header from a remote client for this exemption.
- Non-localhost protected UI/API routes require either:
  - a valid `spark_cockpit_session` cookie created by `/login`, or
  - `Authorization: Bearer $SPARK_COCKPIT_REMOTE_TOKEN` for direct API access.
- Runtime enrollment/WebSocket endpoints under `/api/v1/runtime/` keep their existing runtime bearer-token authentication and are not gated by the browser token.
- `/manifest.webmanifest`, `/icons/*`, `/_app/*`, `/login`, and `/logout` stay reachable before login so the browser can load the PWA shell and complete the session flow.

## Browser/PWA install flow

1. Visit the configured HTTP(S) public URL from the remote device.
2. Cockpit redirects to `/login`.
3. Enter the token from `SPARK_COCKPIT_REMOTE_TOKEN`.
4. The browser receives an HTTP-only session cookie and can install Spark Cockpit from the PWA manifest.

The manifest uses standalone display mode, theme color `#2563EB`, and SVG any/maskable icons.

## Logout and token rotation

Use the account menu logout action or `POST /logout` to revoke the browser session cookie. To rotate access, restart Cockpit with a new `SPARK_COCKPIT_REMOTE_TOKEN`; existing session cookies remain valid until logout/expiry, so revoke sessions from the database or use a fresh Cockpit data directory if immediate global revocation is required.

## Security notes

- Use a long random token; do not commit it to project files.
- Prefer HTTPS or a private encrypted overlay network. The built-in cookie uses `Secure` only when the login URL is HTTPS, which keeps Tailscale/localhost HTTP setups usable.
- This is a single-user remote slice. Do not treat it as a multi-tenant admin surface.
