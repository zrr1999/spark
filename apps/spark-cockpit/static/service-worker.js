const defaultNotification = {
  title: "Spark update",
  body: "Open Cockpit to review.",
  tag: "spark-update",
  url: "/",
  kind: "task_terminal",
};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const notification = sanitizeNotification(readPushPayload(event));
  event.waitUntil(showSparkNotification(notification));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "spark.notification") return;
  const notification = sanitizeNotification(event.data.notification);
  event.waitUntil?.(showSparkNotification(notification));
  if (!event.waitUntil) void showSparkNotification(notification);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = sanitizeUrl(event.notification.data?.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate?.(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});

function readPushPayload(event) {
  try {
    return event.data?.json() ?? defaultNotification;
  } catch {
    return defaultNotification;
  }
}

function sanitizeNotification(value) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const kind = record.kind === "blocker" ? "blocker" : "task_terminal";
  return {
    title: safeText(
      record.title,
      kind === "blocker" ? "Spark is waiting for you" : defaultNotification.title,
    ),
    body: safeText(record.body, defaultNotification.body),
    tag: safeText(record.tag, `spark-${kind}`),
    url: sanitizeUrl(record.url),
    kind,
  };
}

function showSparkNotification(notification) {
  return self.registration.showNotification(notification.title, {
    body: notification.body,
    tag: notification.tag,
    renotify: true,
    icon: "/icons/spark.svg",
    badge: "/icons/spark-maskable.svg",
    data: { url: notification.url, kind: notification.kind },
  });
}

function safeText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  if (!trimmed) return fallback;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function sanitizeUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
