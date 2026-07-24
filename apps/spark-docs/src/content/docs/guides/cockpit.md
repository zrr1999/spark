---
title: Cockpit
description: Start the local web surface, understand its daemon relationship, and secure remote browser access.
---

## Start Cockpit

```bash
spark cockpit
```

Open the URL printed by the command. Cockpit is a web control and projection
surface; durable execution remains owned by Spark daemons.

If the page cannot load session data, check both processes separately:

```bash
spark daemon status --json
spark cockpit
```

## Local and remote access

Loopback use follows the local owner flow. For a non-loopback Cockpit, prefer an
encrypted private path such as Tailscale, WireGuard, or SSH forwarding.

Mint a one-time Cockpit browser key on the Cockpit host:

```bash
spark cockpit access create
```

Exchange it at `/login`. Workspace-scoped browser access uses a separate
one-time key:

```bash
spark cockpit workspace access create --workspace <id>
```

Exchange that key at `/{slug}/login`. Treat both keys as secrets. Non-loopback
access requires HTTPS unless you deliberately opt into insecure HTTP on a
trusted private network.

## Register a remote workspace

Authorize the daemon machine, then register each workspace with its own fresh
registration token:

```bash
spark daemon login --server-url https://cockpit.example
spark daemon workspace register . \
  --server-url https://cockpit.example \
  --token <workspace-token> \
  --name <workspace-name>
```

Machine connectivity credentials and one-time workspace registration tokens
have different scopes; do not reuse one as the other.
