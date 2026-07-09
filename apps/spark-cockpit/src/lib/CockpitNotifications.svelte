<script lang="ts">
  import {
    notificationFromCockpitEvent,
    notificationPreferenceStorageKey,
    parseNotificationPreference,
    serializeNotificationPreference,
    type CockpitNotificationPayload,
  } from "$lib/cockpit-notifications";
  import type { SerializedEvent } from "@zendev-lab/spark-server/events";
  import { onMount } from "svelte";

  let supported = $state(false);
  let enabled = $state(false);
  let permission = $state<NotificationPermission>("default");
  let error = $state<string | null>(null);
  let eventSource: EventSource | null = null;
  let registration: ServiceWorkerRegistration | null = null;

  interface WebPushConfigResponse {
    configured: boolean;
    publicKey: string | null;
  }

  onMount(() => {
    supported = "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
    if (!supported) return;
    permission = Notification.permission;
    enabled = parseNotificationPreference(window.localStorage.getItem(notificationPreferenceStorageKey));
    if (enabled && permission === "granted") {
      void startNotifications().catch((caught) => {
        enabled = false;
        window.localStorage.setItem(notificationPreferenceStorageKey, serializeNotificationPreference(false));
        error = caught instanceof Error ? caught.message : "Could not enable Web Push notifications.";
      });
    }
    return () => stopEventSource();
  });

  async function toggleNotifications() {
    error = null;
    if (enabled) {
      enabled = false;
      window.localStorage.setItem(notificationPreferenceStorageKey, serializeNotificationPreference(false));
      stopEventSource();
      await unsubscribeWebPush();
      return;
    }

    if (!supported) {
      error = "Notifications are not supported in this browser.";
      return;
    }

    permission = await Notification.requestPermission();
    if (permission !== "granted") {
      error = "Browser notification permission was not granted.";
      return;
    }

    try {
      await startNotifications();
    } catch (caught) {
      enabled = false;
      window.localStorage.setItem(notificationPreferenceStorageKey, serializeNotificationPreference(false));
      error = caught instanceof Error ? caught.message : "Could not enable Web Push notifications.";
      return;
    }

    enabled = true;
    window.localStorage.setItem(notificationPreferenceStorageKey, serializeNotificationPreference(true));
  }

  async function startNotifications() {
    registration = await navigator.serviceWorker.register("/service-worker.js");
    const readyRegistration = await navigator.serviceWorker.ready;
    const config = await loadWebPushConfig();
    if (!config.configured || !config.publicKey) {
      throw new Error("Web Push is not configured on this Cockpit server.");
    }
    const existing = await readyRegistration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await readyRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      }));
    await saveWebPushSubscription(subscription);
    connectEvents();
  }

  async function loadWebPushConfig(): Promise<WebPushConfigResponse> {
    const response = await fetch("/api/v1/notifications/web-push");
    if (!response.ok) throw new Error("Could not load Web Push configuration.");
    return (await response.json()) as WebPushConfigResponse;
  }

  async function saveWebPushSubscription(subscription: PushSubscription) {
    const response = await fetch("/api/v1/notifications/web-push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    if (!response.ok) throw new Error("Could not save Web Push subscription.");
  }

  async function unsubscribeWebPush() {
    const readyRegistration = registration ?? (await navigator.serviceWorker.ready.catch(() => null));
    const subscription = await readyRegistration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
    await fetch("/api/v1/notifications/web-push", { method: "DELETE" }).catch(() => undefined);
  }

  function connectEvents() {
    stopEventSource();
    const cursorKey = "spark-cockpit:notifications:events-cursor";
    const url = new URL("/api/v1/events", window.location.origin);
    const cursor = window.sessionStorage.getItem(cursorKey);
    if (cursor) url.searchParams.set("cursor", cursor);
    eventSource = new EventSource(url);
    eventSource.addEventListener("spark-cockpit.event", (message) => {
      const event = parseEvent(message);
      if (!event) return;
      window.sessionStorage.setItem(cursorKey, `${event.createdAt}|${event.id}`);
      const notification = notificationFromCockpitEvent(event);
      if (notification) showNotification(notification);
    });
    eventSource.onerror = () => {
      stopEventSource();
      if (enabled) {
        window.setTimeout(() => {
          if (enabled) connectEvents();
        }, 2_000);
      }
    };
  }

  function showNotification(notification: CockpitNotificationPayload) {
    if (registration?.active) {
      registration.active.postMessage({ type: "spark.notification", notification });
      return;
    }
    void navigator.serviceWorker.ready.then((readyRegistration) => {
      readyRegistration.active?.postMessage({ type: "spark.notification", notification });
    });
  }

  function stopEventSource() {
    eventSource?.close();
    eventSource = null;
  }

  function parseEvent(message: MessageEvent<string>): SerializedEvent | null {
    try {
      const event = JSON.parse(message.data) as SerializedEvent;
      return event && typeof event.id === "string" && typeof event.kind === "string" ? event : null;
    } catch {
      return null;
    }
  }

  function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = `${value}${padding}`.replace(/-/gu, "+").replace(/_/gu, "/");
    const raw = window.atob(base64);
    const output = new Uint8Array(new ArrayBuffer(raw.length));
    for (let index = 0; index < raw.length; index += 1) {
      output[index] = raw.charCodeAt(index);
    }
    return output;
  }
</script>

<button class="notification-toggle" type="button" onclick={toggleNotifications} aria-pressed={enabled}>
  <span>{enabled ? "Disable notifications" : "Enable notifications"}</span>
  <small>{enabled ? "Completion and blockers" : "Completion and blockers"}</small>
</button>
{#if error}
  <p class="notification-error" role="alert">{error}</p>
{/if}

<style>
  .notification-toggle {
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: grid;
    gap: 2px;
    padding: 8px 10px;
    text-align: left;
    width: 100%;
  }

  .notification-toggle:hover {
    background: var(--color-canvas);
  }

  .notification-toggle span {
    font-size: 14px;
    font-weight: 750;
  }

  .notification-toggle small,
  .notification-error {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.35;
  }

  .notification-error {
    color: var(--color-danger-strong);
    margin: 0;
    padding: 0 10px 8px;
  }
</style>
