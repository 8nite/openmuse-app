import { Platform } from "react-native";
import type { MuseApi } from "./api";

// Web Push subscription against the OpenMuse API. Works on installed PWAs and
// desktop browsers; the server relays through the vendor push service so alerts
// arrive with the app fully closed.
// ponytail: PushManager only, no extra deps. Native builds need expo-notifications instead.

export type PushState = "unsupported" | "denied" | "off" | "on" | "blocked";

function vapidKey(publicKey: string) {
  const padded = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function supported() {
  return (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const permission = Notification.permission;
  if (permission === "denied") return "blocked";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? "on" : "off";
  } catch {
    return "unsupported";
  }
}

/** Subscribe this browser and register it server-side. Returns false when refused. */
export async function enablePush(api: MuseApi): Promise<boolean> {
  if (!supported()) return false;
  try {
    if (Notification.permission === "default") {
      try {
        const result = await Notification.requestPermission();
        if (result !== "granted") return false;
      } catch {
        return false;
      }
    } else if (Notification.permission !== "granted") {
      return false;
    }
    const { publicKey } = await api.request<{ publicKey: string }>("/api/agent/push/public-key");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub)
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey(publicKey) as BufferSource,
      });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
    await api.request("/api/agent/push/subscribe", {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
    return true;
  } catch {
    return false;
  }
}

export async function disablePush(api: MuseApi): Promise<void> {
  if (!supported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      try {
        await api.request("/api/agent/push/unsubscribe", { endpoint: sub.endpoint });
      } catch {
        // server record may already be pruned; still unsubscribe locally.
      }
      await sub.unsubscribe();
    }
  } catch {
    // leaving a stale server record is harmless; sends to it get pruned on 410.
  }
}
