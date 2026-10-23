// Walmart acceptance probe: the browser must actually load walmart.ca,
// not just refuse it cleanly.
//
// Manual part (needs a human passkey ceremony, so it cannot run in CI):
//   1. Log in at https://openmuse.nexvision.cc/ (approve your own passkey).
//   2. Open the agent computer, reconnect or open the browser session.
//   3. Browse to https://www.walmart.ca/ and confirm the store loads.
// Automated part below (runs via `pnpm test:live`): the same worker stack
// the app serves — real API + real worker + real Chromium — must return the
// real homepage. A BLOCKED_BY_SITE refusal fails this test on purpose: Akamai
// verdicts vary run to run, and this test stays red until loads are reliable.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../../server/src/app.ts";
import { createStore } from "../../server/src/db.ts";
import { botBlockError, createBrowserManager } from "../src/browser.ts";
import { createWorkerServer } from "../src/server.ts";

test("walmart acceptance: the cloud browser loads the real store page", {
  timeout: 180_000,
}, async (t) => {
  try {
    await fetch("https://example.com", { signal: AbortSignal.timeout(10_000) });
  } catch {
    t.skip("no internet access; cannot probe the live site");
    return;
  }
  const workerDir = await mkdtemp(join(tmpdir(), "openmuse-wm-accept-worker-"));
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  let worker: Awaited<ReturnType<typeof createWorkerServer>> | undefined;
  try {
    worker = await createWorkerServer({ token, dataDir: workerDir }, (options) =>
      createBrowserManager(options),
    );
  } catch (error) {
    if (/Executable doesn't exist/i.test(String(error))) {
      t.skip("Chromium is not installed; cannot probe the live site");
      return;
    }
    throw error;
  }
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  const address = worker.server.address();
  assert(address && typeof address !== "string");
  const db = await createStore();
  const { app, auth, agent } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: await mkdtemp(join(tmpdir(), "openmuse-wm-accept-api-")),
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    workerUrl: `http://127.0.0.1:${address.port}`,
    workerToken: token,
  });
  t.after(() => agent.stop());
  t.after(() => worker?.close());
  t.after(() => db.close());
  t.after(() => rm(workerDir, { recursive: true, force: true }));
  const { token: apiToken } = await auth.session();
  const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };

  let sessionId: string;
  try {
    const created = await app.request("/api/browsers", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://www.walmart.ca/en" }),
    });
    if (created.status !== 201) assert.fail(`browser create failed: ${await created.text()}`);
    sessionId = ((await created.json()) as { id: string }).id;
  } catch (error) {
    assert.fail(`walmart did not load: ${error instanceof Error ? error.message : String(error)}`);
  }
  const read = await app.request(`/api/browsers/${sessionId}/read`, { headers });
  assert.equal(read.status, 200);
  const page = (await read.json()) as { url: string; title: string; text: string };
  assert.match(page.title, /walmart|online shopping/i);
  assert.ok(page.text.length > 1000, "the real store page carries substantial text");
  assert.equal(
    botBlockError(new URL(page.url).hostname, null, page.title, page.text.slice(0, 4000)),
    null,
    "loaded content must not carry block markers",
  );
});
