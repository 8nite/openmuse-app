import { Platform } from "react-native";

// ponytail: Notification API only; alerts fire while the app is open
// (foreground or background tab). Closed-app push goes through web-push.ts +
// the server VAPID sender and is handled by the service worker.
export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

export function notifyPermission(): NotifyPermission {
  if (Platform.OS !== "web" || typeof window === "undefined") return "unsupported";
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission as NotifyPermission;
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (Platform.OS !== "web" || typeof window === "undefined" || !("Notification" in window))
    return "unsupported";
  try {
    const result = await Notification.requestPermission();
    return result as NotifyPermission;
  } catch {
    return Notification.permission as NotifyPermission;
  }
}

function plain(text: string, max = 180) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export async function notifyUser(title: string, body: string, tag: string) {
  if (Platform.OS !== "web" || typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    // Prefer the service worker so the notification survives tab throttling
    // and click-to-focus works via the sw notificationclick handler.
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if ("showNotification" in reg) {
        await reg.showNotification(plain(title, 60) || "OpenMuse", {
          body: plain(body),
          icon: "./icons/icon-192.png",
          badge: "./icons/icon-72.png",
          tag,
          data: { url: "./" },
        } as NotificationOptions & { data?: unknown });
        return;
      }
    }
  } catch {
    // fall through to the page-context Notification
  }
  try {
    new Notification(plain(title, 60) || "OpenMuse", {
      body: plain(body),
      tag,
      icon: "./icons/icon-192.png",
    });
  } catch {
    // Notification construction can throw in some embedded webviews; in-app toast covers it.
  }
}
