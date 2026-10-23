import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createBrowserManager } from "../apps/worker/src/browser.ts";
import { createWorkerServer } from "../apps/worker/src/server.ts";
import { createBrowserFixture, fixtureOrigin } from "../apps/worker/tests/fixtures.ts";
import { browserFixture } from "./helpers/browser.ts";

const workerToken = () =>
  // createWorkerServer requires at least 32 characters.
  randomBytes(32).toString("hex");

/** Boot the real stack: fixture site, real worker (real Chromium), real API. */
async function onlineStack(t: TestContext) {
  const fixture = await createBrowserFixture();
  const workerDir = await mkdtemp(join(tmpdir(), "openmuse-e2e-worker-"));
  const token = workerToken();
  const worker = await createWorkerServer({ token, dataDir: workerDir }, (options) =>
    createBrowserManager(options, fixture.createProxy),
  );
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  const address = worker.server.address();
  assert(address && typeof address !== "string");
  // Reuse the proven sample config, pointed at the real worker.
  const { db, config } = await browserFixture(t, () => {
    throw new Error("mock worker must not receive traffic in the e2e test");
  });
  config.workerUrl = `http://127.0.0.1:${address.port}`;
  config.workerToken = token;
  // Production-like: one pre-warmed standby, handed out by the first create.
  config.standbySessions = 1;
  const { app, auth, agent, browser } = await createApp(db, config);
  t.after(() => agent.stop());
  t.after(() => worker.close());
  t.after(() => fixture.close());
  t.after(() => rm(workerDir, { recursive: true, force: true }));
  const { token: apiToken } = await auth.session();
  const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
  return { app, headers, fixture, browser };
}

test("deployed stack: computer browser is online end to end", { timeout: 180_000 }, async (t) => {
  const { app, headers, fixture, browser } = await onlineStack(t);
  const health = await (await app.request("/api/health", { headers })).json();
  assert.equal(health.browserConfigured, true);

  const workspace = await (await app.request("/api/workspace", { headers })).json();
  assert.equal(
    workspace.connections.find((connection: { id: string }) => connection.id === "browser")?.status,
    "connected",
    "the computer browser must report online, not unavailable",
  );

  let created: { id: string; status: string; consoleUrl?: string; previewUrl?: string };
  try {
    // Await the background warmup so the create below provably hands out a
    // pre-warmed browser instead of launching a fresh one.
    await browser.warmStandby();
    const [pooled] = browser.standbyIds();
    assert.ok(pooled, "standby pool warmed up");
    const response = await app.request("/api/browsers", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: `${fixtureOrigin}/page` }),
    });
    assert.equal(response.status, 201);
    created = await response.json();
    assert.equal(created.id, pooled, "first create hands out the standby session");
  } catch (error) {
    if (error instanceof Error && /Executable doesn't exist/i.test(error.message))
      return t.skip("Chromium is not installed; cannot run the browser e2e test.");
    throw error;
  }
  assert.equal(created.status, "active");
  assert.ok(created.consoleUrl && created.previewUrl);

  const session = await (await app.request(`/api/browsers/${created.id}`, { headers })).json();
  assert.equal(session.url, `${fixtureOrigin}/page`);

  const preview = await app.request(session.previewUrl);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type") ?? "", /image\/png/);

  const console = await app.request(session.consoleUrl);
  assert.equal(console.status, 200);
  const html = await console.text();
  assert.match(html, /Website address/);
  assert.match(html, /Text to type in browser/);
  assert.match(html, /onpointerdown/);

  // Takeover address bar: navigate from the console's own signed auth.
  const tookOver = await app.request(session.consoleUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: `${fixtureOrigin}/other` }),
  });
  assert.equal(tookOver.status, 200);
  assert.equal(
    (await (await app.request(`/api/browsers/${created.id}`, { headers })).json()).url,
    `${fixtureOrigin}/other`,
  );

  // Press-and-hold primitives behind takeover: down, drag repositioning,
  // then up — like a human hold or drag on the live preview.
  for (const input of [
    { type: "down", x: 640, y: 400 },
    { type: "move", x: 660, y: 420 },
    { type: "up" },
  ]) {
    const response = await app.request(session.consoleUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
  }

  // App-level Go button path.
  const navigated = await app.request(`/api/browsers/${created.id}/navigate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: `${fixtureOrigin}/page` }),
  });
  assert.equal(navigated.status, 200);

  assert.deepEqual(fixture.unexpected, []);
});

test("deployed stack: chat browser reuses the standby pool so the first browse skips the launch", {
  timeout: 180_000,
}, async (t) => {
  const { headers, fixture, browser } = await onlineStack(t);
  void headers;
  try {
    await browser.warmStandby();
    const [pooled] = browser.standbyIds();
    assert.ok(pooled, "standby pool warmed up");
    const first = await browser.observeForThread("owner", "chat-thread", `${fixtureOrigin}/page`);
    assert.equal(first.sessionId, pooled, "first chat browse hands out the standby session");
    assert.match(first.text, /Stable page text/);
    const repeat = await browser.observeForThread(
      "owner",
      "chat-thread",
      `${fixtureOrigin}/other`,
    );
    assert.equal(repeat.sessionId, pooled, "later chat turns keep the pinned profile");
  } catch (error) {
    if (error instanceof Error && /Executable doesn't exist/i.test(error.message))
      return t.skip("Chromium is not installed; cannot run the browser e2e test.");
    throw error;
  }
  assert.deepEqual(fixture.unexpected, []);
});

test("deployed stack: slow pages survive the worker round trip", {
  timeout: 180_000,
}, async (t) => {
  const { app, headers, fixture } = await onlineStack(t);
  // A 35s server delay outlasted the worker's old 30s socket kill, surfacing
  // as "worker unavailable". Slow-but-real loads must complete instead.
  const created = await app.request("/api/browsers", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: `${fixtureOrigin}/slow` }),
  });
  assert.equal(created.status, 201);
  const session = (await created.json()) as { id: string };
  const read = await app.request(`/api/browsers/${session.id}/read`, { headers });
  assert.equal(read.status, 200);
  assert.match(((await read.json()) as { text: string }).text, /Slow but real page/);
  assert.deepEqual(fixture.unexpected, []);
});

test("deployed stack: a page that flips to an anti-bot challenge keeps a take-over-able session", {
  timeout: 180_000,
}, async (t) => {
  const { app, headers, fixture } = await onlineStack(t);
  let id: string;
  try {
    const response = await app.request("/api/browsers", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: `${fixtureOrigin}/flip` }),
    });
    assert.equal(response.status, 201);
    id = ((await response.json()) as { id: string }).id;
  } catch (error) {
    if (error instanceof Error && /Executable doesn't exist/i.test(error.message))
      return t.skip("Chromium is not installed; cannot run the browser e2e test.");
    throw error;
  }
  // Pre-flip read proves the shape: real content first, challenge later. The
  // flip fires 15s after parse; the open probe lands ~2s after parse.
  const early = await app.request(`/api/browsers/${id}/read`, { headers });
  assert.equal(early.status, 200);
  assert.match(((await early.json()) as { title: string }).title, /OpenMuse fixture/);
  // Poll until the sensor flips the page: the read must refuse with the
  // actionable message, never raw block text.
  let blocked = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    const probed = await app.request(`/api/browsers/${id}/read`, { headers });
    const body = await probed.text();
    if (probed.status === 502 && /Take control/.test(body)) {
      blocked = true;
      break;
    }
    assert.equal(probed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.ok(blocked, "the flipped challenge page must refuse reads with Take control guidance");
  // The refused session stays live with takeover URLs: Take control works.
  const session = (await (
    await app.request(`/api/browsers/${id}`, { headers })
  ).json()) as { status: string; consoleUrl?: string; previewUrl?: string };
  assert.equal(session.status, "active");
  assert.ok(session.consoleUrl && session.previewUrl);
  const preview = await app.request(session.previewUrl);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type") ?? "", /image\/png/);
  const closed = await app.request(`/api/browsers/${id}/close`, { method: "POST", headers });
  assert.equal(closed.status, 200);
  assert.deepEqual(fixture.unexpected, []);
});

test("deployed stack: browser reports unavailable when the worker is down", async (t) => {
  const { db, config } = await browserFixture(t, () => {
    throw new Error("mock worker must not receive traffic in the offline test");
  });
  // Nothing listens on port 1, so every worker call fails fast.
  config.workerUrl = "http://127.0.0.1:1";
  config.workerToken = workerToken();
  const { app, auth, agent } = await createApp(db, config);
  t.after(() => agent.stop());
  const { token: apiToken } = await auth.session();
  const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };

  const workspace = await (await app.request("/api/workspace", { headers })).json();
  assert.equal(
    workspace.connections.find((connection: { id: string }) => connection.id === "browser")?.status,
    "unavailable",
    "a down worker must surface as unavailable, not connected",
  );

  const response = await app.request("/api/browsers", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: `${fixtureOrigin}/page` }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /unavailable/i);
});
