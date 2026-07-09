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

## Authentication behavior

- Requests from loopback client addresses (`127.0.0.1`, `::1`, including IPv4-mapped loopback) keep the existing local developer flow. Cockpit does not trust a spoofed `Host: localhost` header from a remote client for this exemption.
- Non-localhost protected UI/API routes require either:
  - a valid `spark_cockpit_session` cookie created by `/login`, or
  - `Authorization: Bearer $SPARK_COCKPIT_REMOTE_TOKEN` for direct API access.
- Runtime enrollment/WebSocket endpoints under `/api/v1/runtime/` keep their existing runtime bearer-token authentication and are not gated by the browser token.
- `/manifest.webmanifest`, `/icons/*`, `/_app/*`, `/login`, and `/logout` stay reachable before login so the browser can load the PWA shell and complete the session flow.

## Browser/PWA install flow

1. Visit `http://<tailscale-host>:5173/` from the remote device.
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
