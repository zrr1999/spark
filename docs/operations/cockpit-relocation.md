# Cockpit instance relocation

This is a feature-only procedure for moving one logical Cockpit instance to a new HTTPS origin. It is not an independent Cockpit registration or a workspace owner handoff. It does not authorize an operator to upload, restore, deploy, or switch the current `marrow-paddle` instance.

## Stop conditions

Stop before mutation when any of these is true:

- either public origin is not HTTPS or runtime WebSocket upgrades are not WSS;
- source and snapshot `instanceId` differ;
- snapshot `integrityCheck` is not `ok`, `foreignKeyViolations` is not `0`, or its SHA-256 differs from the manifest;
- target cannot be stopped exclusively or its database lock cannot be acquired;
- target already has a connected runtime, contains an unrelated active route, or returns a different `runtimeId`;
- the source daemon has active work that the operator cannot observe through local daemon status;
- any secret appears in CLI JSON, Cockpit persistence/cache/log, generic outbox, or artifacts.

Do not retry a partially completed secret request. Do not use ordinary workspace registration to force a new owner.

## Variables

```sh
export SOURCE_URL=https://source-cockpit.example.com/
export TARGET_URL=https://target-cockpit.example.com/
export SOURCE_DB=/srv/spark/source/cockpit.sqlite
export TARGET_DB=/srv/spark/target/cockpit.sqlite
export SNAPSHOT=/srv/spark/transfer/source-before-relocation
export TARGET_PREBACKUP=/srv/spark/backups/target-before-relocation
export TARGET_ROLLBACK_ROOT=/srv/spark/backups/automatic
```

Keep snapshots and deployment environment files mode `0600`. Never print runtime, refresh, remote-access, API, OAuth, or channel credentials.

## 1. Preflight

```sh
spark cockpit instance status --database "$SOURCE_DB" --json
spark daemon status --json
curl --fail --silent --show-error "$SOURCE_URL/api/v1/runtime/relocation/metadata"
curl --fail --silent --show-error "$TARGET_URL/api/v1/runtime/relocation/metadata"
```

Record `instanceId`, `installationId`, `runtimeId`, every active `bindingId`, daemon `pid`, invocation counts, and source heartbeat time. Both metadata responses must use the same `instanceId`. A different instance means independent registration, not relocation: stop.

The target preflight endpoint consumes and rotates a refresh credential. Do not call it manually as a probe. `spark daemon workspace relocate` owns that one-time exchange after all backups and target restore checks pass.

## 2. Source backup and inspect

```sh
spark cockpit instance backup --database "$SOURCE_DB" --snapshot "$SNAPSHOT" --json
spark cockpit instance inspect --snapshot "$SNAPSHOT" --json
```

Required fields are `instanceId`, `database.sha256`, `database.sizeBytes`, `schemaMigrations`, `tableCounts`, `integrityCheck: "ok"`, and `foreignKeyViolations: 0`. Preserve the manifest and database together. Stop on any mismatch.

## 3. Stop, back up, and restore target

Stop the target Cockpit process **or** wait until its database lock is free. Cockpit opens SQLite on demand with a 30s idle release after the last consumer (HTTP request, SSE stream, runtime WebSocket, or web-push tick) unpins. HTTP may keep listening while the lock is idle; restore must still refuse while any consumer holds the lock (active browsers or runtime WSS). The service command is deployment-specific; for a user service:

```sh
systemctl --user stop spark-cockpit
spark cockpit instance backup --database "$TARGET_DB" --snapshot "$TARGET_PREBACKUP" --json
spark cockpit instance inspect --snapshot "$TARGET_PREBACKUP" --json
spark cockpit instance restore --snapshot "$SNAPSHOT" --database "$TARGET_DB" --rollback-root "$TARGET_ROLLBACK_ROOT" --yes --json
spark cockpit instance status --database "$TARGET_DB" --json
```

The explicit target backup is mandatory even though restore also returns `rollbackSnapshotPath`. Require `integrityCheck: "ok"` for both snapshots. After restore, target `instanceId`, `runtimeId`, active `bindingId` values, workspace/project table counts, and manifest digest must match the source snapshot. Browser sessions, connected runtime sessions, pending device authorizations, artifact cache rows, web push subscriptions, and online status are intentionally reset.

If restore fails, keep the target stopped. The restore operation rolls the database file back automatically; verify `TARGET_PREBACKUP` before any manual replacement.

## 4. Deploy HTTPS/WSS target

Use a loopback app listener behind a trusted TLS reverse proxy:

```sh
export HOST=127.0.0.1
export PORT=5173
export SPARK_COCKPIT_PUBLIC_URL="$TARGET_URL"
export SPARK_COCKPIT_TRUST_PROXY=loopback
spark cockpit
```

Remote browser authority is progressive. After restore, mint a fresh Cockpit key with `spark cockpit access create`, then workspace keys with `spark daemon workspace access create` (or registration). Cockpit and workspace rotating refresh sessions stay separate. The reverse proxy must replace forwarding headers, preserve the public host, forward WebSocket upgrades, and leave streaming responses unbuffered. Verify:

```sh
curl --fail --silent --show-error "$TARGET_URL/api/v1/runtime/relocation/metadata"
```

Expected: HTTPS response, restored `instanceId`, and runtime endpoint upgrades to WSS. HTTP is rejection-only. The current `http://marrow-paddle.bcc-szzj.baidu.com:8080/` is not eligible for full cutover until an HTTPS/WSS endpoint and offline restore access exist.

## 5. Relocate the daemon uplink

Start a long-running test invocation before cutover and record its invocation ID. Then run locally on the daemon host:

```sh
spark daemon workspace relocate \
  --from-server-url "$SOURCE_URL" \
  --to-server-url "$TARGET_URL" \
  --yes --json
```

Expected JSON fields: `relocated: true`, unchanged `instanceId`, `installationId`, and `runtimeId`; exact `fromServerUrl`, `toServerUrl`, `webSocketUrl` under the target WSS origin; unchanged `workspaceBindingIds`; `workspaceCount`; and `relocatedAt`. It must not contain token, secret, credential hash, or deployment environment values.

On any nonzero exit, do not edit daemon SQLite or config manually. Confirm the old source uplink is still connected and compare config/DB digests. The seven stable rejection classes are instance mismatch, runtime missing, token rejected, runtime mismatch, target unreachable, target collision, and local transaction failure.

## 6. Functional and security acceptance

Wait for two observation windows and collect structured API output:

```sh
spark daemon status --json
curl --fail --silent --show-error "$TARGET_URL/sessions"
curl --fail --silent --show-error "$TARGET_URL/settings/models"
curl --fail --silent --show-error "$TARGET_URL/<workspace-id>/settings/channels"
```

Use an authenticated HTTPS browser session for protected pages. Verify:

- daemon PID is unchanged and the pre-cutover invocation is terminal `succeeded`;
- target receives hello, heartbeat, reconcile, and invocation events for only the relocated binding;
- target heartbeat count is positive in both windows and source count remains unchanged;
- session create/list/bind/unbind/archive and turn submit/cancel/result work over WSS;
- model catalog/default/session model/thinking and provider logout/OAuth lifecycle work;
- channel status/configure/reload work and credential flags are redacted;
- daemon-local and third-origin bindings do not appear on source or target projections.

Send one secret request to an HTTP test endpoint and require rejection with `daemonExecutionCount: 0`. Run a unique marker through HTTPS/WSS test credentials, then scan Cockpit SQLite, cache, logs, artifacts, events, audit payloads, durable commands, and generic outbox. Every target must report `matchCount: 0`; only daemon-owned provider/OAuth/channel credential targets may match.

Attempt ordinary registration from a second daemon against the already-owned workspace. Require `WORKSPACE_OWNER_CONFLICT`, then query `workspace_owner_bindings` and require active owner count `1` with the original `bindingId`.

## 7. Reverse relocation and rollback

Do not restore the target's old database while the daemon points at the target. First reverse-relocate the live logical Cockpit state so the old source can authenticate the daemon's current rotated credential:

```sh
export RETURN_SNAPSHOT=/srv/spark/transfer/target-before-return
export SOURCE_PREBACKUP=/srv/spark/backups/source-before-return
spark cockpit instance backup --database "$TARGET_DB" --snapshot "$RETURN_SNAPSHOT" --json
spark cockpit instance inspect --snapshot "$RETURN_SNAPSHOT" --json
systemctl --user stop spark-cockpit-source
spark cockpit instance backup --database "$SOURCE_DB" --snapshot "$SOURCE_PREBACKUP" --json
spark cockpit instance restore --snapshot "$RETURN_SNAPSHOT" --database "$SOURCE_DB" --rollback-root /srv/spark/backups/source-automatic --yes --json
systemctl --user start spark-cockpit-source
spark daemon workspace relocate --from-server-url "$TARGET_URL" --to-server-url "$SOURCE_URL" --yes --json
```

Validate old-source WSS heartbeats and invocation continuity. Only then stop the target and restore its original contents:

```sh
systemctl --user stop spark-cockpit
spark cockpit instance restore --snapshot "$TARGET_PREBACKUP" --database "$TARGET_DB" --rollback-root "$TARGET_ROLLBACK_ROOT" --yes --json
spark cockpit instance status --database "$TARGET_DB" --json
```

Require the target's pre-relocation `instanceId` and workspace/project/runtime table summary hashes to match the recorded preflight values. If the target database is unavailable before a return snapshot can be made, use the separately secured pre-cutover daemon config/SQLite backup as disaster recovery; this requires stopping the daemon and may interrupt work, so it is not the normal rollback path.

## Owner handoff is separate

Relocation preserves one logical Cockpit and one daemon owner. A future explicit `owner handoff` must not reuse ordinary registration. Before handoff it must check all five conditions: `draining`, `borrowed`, `active invocation`, `pending command`, and `one-time authorization`. Until that feature exists, any one of those conditions is a stop condition and `WORKSPACE_OWNER_CONFLICT` is final.

## Evidence record

Save secret-free command exit codes, JSON field summaries, snapshot SHA-256 values, source/target heartbeat counts, daemon PID, invocation terminal result, owner query, marker scan counts, and rollback summary hashes. Mark the operation complete only when every acceptance check passes. This document validates reusable capability only; it does not state that `marrow-paddle` was changed.
