import { useCallback, useEffect, useState } from "react";

// ponytail: web-only PWA bootstrap; native platforms no-op. Push delivery itself
// lives in the service worker + server VAPID sender (apps/server/src/engine/push.ts).
export function ensurePwa() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // Manifest + theme/meta icons (expo export does not emit them).
  const head = document.head;
  const link = (rel: string, href: string, extra: Record<string, string> = {}) => {
    let el = head.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
    // manifest href may be relative to the served sub-path; keep the first one found.
    if (rel === "manifest" && el) return el;
    if (!el) {
      el = document.createElement("link");
      el.rel = rel;
      head.appendChild(el);
    }
    el.href = href;
    for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
    return el;
  };
  link("manifest", "/manifest.webmanifest");
  link("icon", "/favicon.png", { type: "image/png" });
  link("apple-touch-icon", "/apple-touch-icon.png");
  const meta = (name: string, content: string, attr = "name") => {
    let el = head.querySelector(`meta[${attr}="${name}"]`);
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, name);
      head.appendChild(el);
    }
    el.setAttribute("content", content);
  };
  meta("theme-color", "#11191C");
  meta("mobile-web-app-capable", "yes");
  meta("apple-mobile-web-app-capable", "yes");
  meta("apple-mobile-web-app-status-bar-style", "default");
  meta("apple-mobile-web-app-title", "OpenMuse");
  meta("description", "Chat with your agent, track tasks, mail, calendar, browser and files.");

  // Service worker for offline shell + notification clicks.
  if ("serviceWorker" in navigator && window.isSecureContext !== false) {
    // Avoid double-register churn in dev (HMR).
    if (!(window as unknown as { __openmuseSw?: boolean }).__openmuseSw) {
      (window as unknown as { __openmuseSw?: boolean }).__openmuseSw = true;
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function usePwaInstall() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia?.("(display-mode: standalone)").matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true),
  );
  useEffect(() => {
    ensurePwa();
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const install = useCallback(async () => {
    if (!deferred) return false;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setDeferred(null);
    return choice.outcome === "accepted";
  }, [deferred]);
  return { canInstall: !!deferred && !installed, installed, install };
}
