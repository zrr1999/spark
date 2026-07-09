# Spark Cockpit notifications

Spark Cockpit can show browser/PWA notifications for single-user long-task terminal states and human blockers. The feature is opt-in from the workspace/account popover and builds on the remote/PWA shell.

## Enable or disable

1. Open Spark Cockpit in a browser/PWA session.
2. Open the workspace/account popover in the left rail.
3. Choose **Enable notifications**.
4. Approve the browser permission prompt.

The preference is stored in browser local storage as `spark-cockpit:notifications:enabled`. When enabled, Cockpit registers `/service-worker.js`, calls `PushManager.subscribe(...)` with `SPARK_COCKPIT_VAPID_PUBLIC_KEY`, and stores the resulting single-user subscription server-side. Choose **Disable notifications** from the same popover to unsubscribe the browser, remove the server subscription, stop the Cockpit event listener, and persist `disabled`.

## What generates a notification

The Cockpit server polls the existing event log and dispatches Web Push payloads through the stored PushManager subscription for:

- `invocation.updated` with `succeeded`, `failed`, `cancelled`, `timed_out`, or `lost` status.
- `human.request.created` for asks, approvals, reviews, and blockers that need an operator response.

When the PWA/browser session is open, the opt-in component also listens to `/api/v1/events` and posts the same sanitized payloads to the service worker for immediate foreground delivery. The service worker handles both standard `push` events and foreground `message` events with the same renderer.

## Sanitized payloads

Notification bodies intentionally avoid task prompts, private stdout/stderr, terminal reasons, approval details, and artifact contents.

Task completion example:

```json
{
  "title": "Spark task finished",
  "body": "A long-running Spark task completed. Open Cockpit to review the result.",
  "tag": "spark-invocation-inv_...",
  "url": "/",
  "kind": "task_terminal"
}
```

Blocker example:

```json
{
  "title": "Spark is waiting for you",
  "body": "A blocker, approval, or review needs a response in Cockpit.",
  "tag": "spark-blocker-hreq_...",
  "url": "/",
  "kind": "blocker"
}
```

## Scope and limits

- This is single-user browser/PWA notification support, not multi-user routing.
- Set `SPARK_COCKPIT_VAPID_PUBLIC_KEY` and `SPARK_COCKPIT_VAPID_PRIVATE_KEY` before enabling Web Push. `SPARK_COCKPIT_VAPID_SUBJECT` defaults to `mailto:spark-cockpit@example.invalid` and should be set by operators.
- Notification payloads are generic and sanitized by `cockpit-notifications.ts`, `server/web-push.ts`, and the service worker.
