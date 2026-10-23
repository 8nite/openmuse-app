import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";

// Web Push delivery for the installed PWA. Browsers relay through the vendor's
// push service (Google/Mozilla/Apple); VAPID is the only credential needed.
// ponytail: no push provider account, no extra service — the API server sends.

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

const KIND = "push-subscriptions";
const idFor = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

export function pushConfigured(config: Config) {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey);
}

async function sender(config: Config) {
  // Imported lazily so servers without VAPID keys never load web-push.
  const { vapidPublicKey, vapidPrivateKey } = config;
  if (!vapidPublicKey || !vapidPrivateKey) throw new Error("Push is not configured.");
  const { default: webpush } = await import("web-push");
  webpush.setVapidDetails(
    config.vapidContact || "mailto:push@localhost",
    vapidPublicKey,
    vapidPrivateKey,
  );
  return webpush;
}

/** Best-effort push to every registered device. Never throws. Prunes dead endpoints. */
export async function sendPush(
  config: Config,
  db: Store,
  owner: string,
  title: string,
  body: string,
): Promise<void> {
  if (!pushConfigured(config)) return;
  let subs: PushSubscriptionRecord[];
  try {
    subs = await db.list<PushSubscriptionRecord>(owner, KIND);
  } catch {
    return;
  }
  if (!subs.length) return;
  let push: Awaited<ReturnType<typeof sender>>;
  try {
    push = await sender(config);
  } catch {
    return;
  }
  const text = body.replace(/\s+/g, " ").trim().slice(0, 180);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await push.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({ title: title.slice(0, 60), body: text }),
          { TTL: 24 * 3600, urgency: "normal" },
        );
      } catch (e) {
        // 404/410 = subscription gone (app uninstalled, permission revoked).
        if (e instanceof Error && /41[04]/.test(e.message)) {
          try {
            await db.take(owner, KIND, sub.id);
          } catch {
            // store already unreachable; nothing to prune.
          }
        }
      }
    }),
  );
}

export async function savePushSubscription(
  db: Store,
  owner: string,
  endpoint: string,
  keys: { p256dh: string; auth: string },
): Promise<PushSubscriptionRecord> {
  const record: PushSubscriptionRecord = {
    id: idFor(endpoint),
    endpoint,
    keys,
    createdAt: new Date().toISOString(),
  };
  return db.put(owner, KIND, record);
}

export async function removePushSubscription(
  db: Store,
  owner: string,
  endpoint: string,
): Promise<void> {
  await db.take(owner, KIND, idFor(endpoint));
}
