import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { PushSubscriptionRecord } from "../apps/server/src/engine/push.ts";

const VAPID_PUBLIC =
  "BF7iSfz67Jdw25pcpEFAFFeaXtsp3AIPNCEQHuWp8xT3v3ZoPVX7NxC46FwpK_E2oDP03UlaS1gqNAANFkXZpu8";
const subscription = {
  endpoint: "https://push.example.com/test-endpoint",
  keys: { p256dh: "BNtestp256dhkeypaddingpaddingpaddingpadding12", auth: "testauthkey123456" },
};

let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let token: string;

function baseConfig(): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
}
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, body?: unknown) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(),
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-push-"));
  db = await createStore({ dataDir: join(directory, "db") });
  // VAPID keys absent: push endpoints report unconfigured, inbox still works.
  server = await createApp(db, baseConfig());
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("push endpoints 404 when VAPID is not configured", async () => {
  assert.equal((await request("/push/public-key")).status, 404);
  assert.equal((await request("/push/subscribe", subscription)).status, 404);
});

test("push subscribe/unsubscribe roundtrip with VAPID configured", async () => {
  await server.agent.stop();
  // Private key is never used here (no send happens); the public key is real format.
  server = await createApp(db, {
    ...baseConfig(),
    vapidPublicKey: VAPID_PUBLIC,
    vapidPrivateKey: "test-private-key-never-used-for-send",
  });
  const key = await request("/push/public-key");
  assert.equal(key.status, 200);
  assert.equal((await key.json()).publicKey, VAPID_PUBLIC);

  const created = await request("/push/subscribe", subscription);
  assert.equal(created.status, 201);
  const saved = (await created.json()) as PushSubscriptionRecord;
  assert.equal(saved.endpoint, subscription.endpoint);

  const stored = await db.list<PushSubscriptionRecord>("local-user", "push-subscriptions");
  assert.equal(stored.length, 1);

  // Invalid subscription is rejected, not stored.
  assert.equal((await request("/push/subscribe", { endpoint: "not-a-url" })).status, 422);
  assert.equal((await db.list("local-user", "push-subscriptions")).length, 1);

  const removed = await request("/push/unsubscribe", { endpoint: subscription.endpoint });
  assert.equal(removed.status, 200);
  assert.equal((await db.list("local-user", "push-subscriptions")).length, 0);
});
