import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { DeviceService } from "../apps/server/src/device.ts";
import { deviceConsole } from "../apps/server/src/device-console.ts";
import { acceptDeviceUpgrade, DeviceRelay } from "../apps/server/src/device-relay.ts";
import type { DeviceSession } from "../packages/domain/src/index.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const savedSession: DeviceSession = {
  id: sessionId,
  title: "Saved phone",
  packageOrUrl: "https://example.com/",
  status: "active",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

async function deviceFixture(
  t: TestContext,
  handle: (path: string, body: Record<string, unknown>) => { status?: number; data: unknown },
  overrides: Partial<Config> = {},
) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const result = handle(request.url ?? "", body);
    // Screenshot endpoints return binary in production; tests return JSON session payloads.
    if ((request.url ?? "").endsWith("/screenshot")) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.data));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-device-service-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    deviceEnabled: true,
    deviceWorkerUrl: `http://127.0.0.1:${address.port}`,
    workerToken: "test-worker-token-at-least-32-characters",
    ...overrides,
  };
  const auth = new Auth(db, config, "test-signing-key");
  const relay = new DeviceRelay();
  const service = new DeviceService(db, config, auth, Date.now, relay);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, service, relay, config, auth };
}

test("device is disabled by default: routes reject and workspace shows unconfigured", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-device-disabled-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  assert.equal(config.deviceEnabled, undefined);
  const { app, auth } = await createApp(db, config);
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const workspace = await (await app.request("/api/workspace", { headers })).json();
  assert.deepEqual(
    workspace.connections.find((c: { id: string }) => c.id === "device"),
    {
      id: "device",
      name: "Phone",
      status: "unconfigured",
      capabilities: ["Screenshot", "Tap and swipe", "YouTube launch"],
    },
  );
  assert.deepEqual(workspace.devices, []);
  assert.equal((await app.request("/api/devices/pair", { method: "POST", headers })).status, 404);
  assert.equal(
    (
      await app.request("/api/devices", {
        method: "POST",
        headers,
        body: JSON.stringify({ packageOrUrl: "https://example.com/" }),
      })
    ).status,
    404,
  );
});

test("device pairing issues a single-use code and registers a persistent token", async (t) => {
  const { db, service } = await deviceFixture(t, () => ({ data: {} }));
  const { code, prefix, expiresAt } = await service.pair("owner");
  assert.match(code, /^ot-pair-[0-9a-f]{32}$/);
  assert.ok(prefix.endsWith("…"));
  assert.ok(Date.parse(expiresAt) > Date.now());
  const registered = await service.register(code, "owner");
  assert.match(registered.token, /^ot-dev-[0-9a-f]{48}$/);
  assert.equal(
    service.ownerForDeviceToken(registered.token),
    "owner",
    "the issued token resolves its owner for WS reconnects",
  );
  assert.equal(service.relayConnected("owner"), false, "no socket attached yet");
  await assert.rejects(service.register(code, "owner"), { status: 401 });
  assert.ok(
    await db.get(
      "owner",
      "device-tokens",
      createHash("sha256").update(registered.token).digest("hex"),
    ),
  );
});

test("device API creates, launches, inputs, reads, previews and closes an owned session", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { db, config } = await deviceFixture(t, (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/uidump")) return { data: { text: "Home screen", truncated: false } };
    const match = path.match(/^\/sessions\/([^/]+)/);
    const id = (body.id as string | undefined) ?? match?.[1] ?? sessionId;
    const packageOrUrl =
      (body.intentUri as string | undefined) ??
      (body.packageOrUrl as string | undefined) ??
      savedSession.packageOrUrl;
    return { data: { ...savedSession, id, packageOrUrl } };
  });
  const { app, auth } = await createApp(db, config);
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const created = await (
    await app.request("/api/devices", {
      method: "POST",
      headers,
      body: JSON.stringify({ packageOrUrl: "vnd.youtube:dQw4w9WgXcQ" }),
    })
  ).json();
  assert.equal(created.packageOrUrl, "vnd.youtube:dQw4w9WgXcQ");
  const id = created.id;
  assert.deepEqual(calls[0], {
    path: "/sessions",
    body: { id, intentUri: "vnd.youtube:dQw4w9WgXcQ" },
  });

  const fetched: DeviceSession = await (
    await app.request(`/api/devices/${id}`, { headers })
  ).json();
  assert.ok(fetched.previewUrl?.includes(`/api/devices/${id}/preview`));
  assert.ok(fetched.consoleUrl?.includes(`/api/devices/${id}/console`));

  // Signed preview/console require the signature; bare bearer access is rejected.
  assert.equal((await app.request(`/api/devices/${id}/preview`, { headers })).status, 200);
  assert.equal((await app.request(`/api/devices/${id}/preview`)).status, 401);
  assert.ok(fetched.consoleUrl);
  const consoleResponse = await app.request(fetched.consoleUrl);
  assert.equal(consoleResponse.status, 200);
  assert.match(await consoleResponse.text(), /Back/);

  const launched = await (
    await app.request(`/api/devices/${id}/launch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ intentUri: "https://example.org/" }),
    })
  ).json();
  assert.equal(launched.packageOrUrl, "https://example.org/");

  // Intent allowlist rejects custom schemes.
  assert.equal(
    (
      await app.request(`/api/devices/${id}/launch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ intentUri: "myapp://open" }),
      })
    ).status,
    422,
  );

  for (const input of [
    { type: "tap", x: 540, y: 1200 },
    { type: "swipe", x1: 100, y1: 1000, x2: 100, y2: 300, durationMs: 250 },
    { type: "text", text: "hello" },
    { type: "key", key: "back" },
  ]) {
    assert.equal(
      (
        await app.request(`/api/devices/${id}/input`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        })
      ).status,
      200,
    );
  }
  assert.equal(
    (
      await app.request(`/api/devices/${id}/input`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "tap", x: -1, y: 0 }),
      })
    ).status,
    422,
  );

  const read = await (await app.request(`/api/devices/${id}/read`, { headers })).json();
  assert.equal(read.text, "Home screen");

  const closed = await (
    await app.request(`/api/devices/${id}/close`, { method: "POST", headers, body: "{}" })
  ).json();
  assert.equal(closed.id, id);

  // Ownership isolation: another owner cannot see this session.
  const { token: other } = await auth.session(undefined, "someone-else");
  const otherHeaders = { Authorization: `Bearer ${other}`, "Content-Type": "application/json" };
  assert.equal((await app.request(`/api/devices/${id}`, { headers: otherHeaders })).status, 404);
  assert.equal((await app.request(`/api/devices/not-a-uuid`, { headers })).status, 404);
});

test("device console scales taps, maps drags over 15px to swipe, and exposes phone keys", () => {
  const html = deviceConsole("http://localhost:8787/api/devices/abc/preview?signature=x");
  assert.match(html, /naturalWidth/);
  assert.match(html, /naturalHeight/);
  assert.match(html, /dist>15/);
  assert.match(html, /swipe/);
  assert.match(html, /data-key="back"/);
  assert.match(html, /data-key="home"/);
  assert.match(html, /data-key="recents"/);
  assert.match(html, /data-key="play_pause"/);
  assert.match(html, /Live phone screen/);
});

test("workspace decorates device sessions and marks unavailable relays", async (t) => {
  const { db, config } = await deviceFixture(t, () => ({ data: { ...savedSession } }), {
    deviceWorkerUrl: "http://127.0.0.1:1",
  });
  const { app, auth } = await createApp(db, config);
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await db.put("local-user", "devices", savedSession);
  const workspace = await (await app.request("/api/workspace", { headers })).json();
  assert.equal(workspace.devices.length, 1);
  assert.ok(workspace.devices[0].previewUrl?.includes("/api/devices/"));
  assert.ok(workspace.devices[0].consoleUrl?.includes("/api/devices/"));
  assert.equal(
    workspace.connections.find((c: { id: string }) => c.id === "device")?.status,
    "unavailable",
  );
  const { app: relayApp, device: relayDevice, relay } = await createApp(db, config);
  void relayApp;
  assert.equal(relayDevice.relayConnected("local-user"), false);
  const sent: string[] = [];
  let open = true;
  relay.attach("local-user", {
    send: (text: string) => {
      sent.push(text);
    },
    ping: () => {},
    close: () => {
      open = false;
    },
    get open() {
      return open;
    },
  });
  assert.ok(relayDevice.relayConnected("local-user"));
  assert.equal(await relayDevice.reachableFor("local-user"), true);
  assert.equal(sent.length, 0, "attach sends nothing until a request is routed");
});

function fakeSocket() {
  const sent: string[] = [];
  let open = true;
  const socket = {
    send: (text: string) => {
      sent.push(text);
    },
    ping: () => {},
    close: () => {
      open = false;
    },
    get open() {
      return open;
    },
  };
  return { socket, sent };
}

test("device relay routes requests over an attached socket before HTTP fallback", async (t) => {
  const { db, service, relay } = await deviceFixture(t, (path) => {
    if (path.endsWith("/uidump")) return { data: { text: "http fallback", truncated: false } };
    return { data: { ...savedSession } };
  });
  await db.put("owner", "devices", savedSession);
  const { socket, sent } = fakeSocket();
  relay.attach("owner", socket);
  // The harness answers relay frames the way the APK would.
  const answer = () => {
    const frame = JSON.parse(sent.at(-1) ?? "{}");
    assert.equal(frame.type, "request");
    relay.receive(
      "owner",
      socket,
      JSON.stringify({
        type: "response",
        id: frame.id,
        status: 200,
        bodyB64: Buffer.from(
          JSON.stringify({ text: "relay screen", mediaState: "idle", truncated: false }),
        ).toString("base64"),
      }),
    );
  };
  const pending = service.read("owner", sessionId);
  // Let the relayed() send land before answering.
  await new Promise((resolve) => setImmediate(resolve));
  answer();
  assert.equal((await pending).text, "relay screen");
  relay.detach("owner", socket);
  assert.equal((await service.read("owner", sessionId)).text, "http fallback");
});

test("device relay fails in-flight requests when the socket drops", async (t) => {
  const { service, relay } = await deviceFixture(t, () => ({ data: {} }));
  const { socket } = fakeSocket();
  relay.attach("owner", socket);
  const pending = relay.relayed("owner", "GET", "/sessions/x/uidump", undefined);
  assert.ok(pending);
  relay.detach("owner", socket);
  await assert.rejects(pending, /disconnected/);
  assert.equal(await relay.relayed("owner", "GET", "/sessions/x/uidump", undefined), null);
  assert.equal(service.relayConnected("owner"), false);
});

test("device pairing codes expire and cannot be reused across dials", async (t) => {
  let now = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "openmuse-device-expiry-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    deviceEnabled: true,
  };
  const auth = new Auth(db, config, "test-signing-key");
  const relay = new DeviceRelay(() => now);
  const service = new DeviceService(db, config, auth, () => now, relay);
  const first = await service.pair("owner");
  assert.equal(service.consumePairCode(first.code), "owner");
  assert.equal(service.consumePairCode(first.code), null, "single-use across dials");
  const second = await service.pair("owner");
  now += 11 * 60 * 1000;
  assert.equal(service.consumePairCode(second.code), null, "expired codes are rejected");
  await assert.rejects(service.register(second.code, "owner"), { status: 401 });
});

test("device WS upgrade pairs a phone and multiplexes requests end to end", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-device-ws-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    deviceEnabled: true,
  };
  const auth = new Auth(db, config, "test-signing-key");
  const relay = new DeviceRelay();
  const service = new DeviceService(db, config, auth, Date.now, relay);
  const server = createServer((_, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    void acceptDeviceUpgrade(req, socket, head, service, relay, true).then((adopted) => {
      if (!adopted) socket.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `ws://127.0.0.1:${address.port}`;

  const { code } = await service.pair("owner");
  const phone = new WebSocket(`${origin}/api/devices/register?code=${code}`);
  const first = await new Promise<string>((resolve, reject) => {
    phone.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    phone.addEventListener("error", () => reject(new Error("pairing socket failed")), {
      once: true,
    });
  });
  const registered = JSON.parse(first);
  assert.equal(registered.type, "registered");
  assert.match(registered.token, /^ot-dev-[0-9a-f]{48}$/);
  const token: string = registered.token;
  assert.ok(service.relayConnected("owner"), "paired socket counts as connected");

  // Server-initiated request over the relay; the phone answers like the APK.
  const pending = relay.relayed("owner", "GET", "/sessions/abc/uidump", undefined);
  assert.ok(pending);
  const request = await new Promise<string>((resolve) => {
    phone.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
  });
  const frame = JSON.parse(request);
  assert.equal(frame.type, "request");
  assert.equal(frame.path, "/sessions/abc/uidump");
  phone.send(
    JSON.stringify({
      type: "response",
      id: frame.id,
      status: 200,
      bodyB64: Buffer.from(JSON.stringify({ text: "ws screen" })).toString("base64"),
    }),
  );
  const answered = await pending;
  assert.ok(answered);
  assert.equal(Buffer.from(answered.bytes).toString("utf8"), '{"text":"ws screen"}');

  // Client ping is answered so the APK can measure the link too.
  const pong = new Promise<string>((resolve) => {
    phone.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
  });
  phone.send(JSON.stringify({ type: "ping", id: "hello-ping" }));
  assert.deepEqual(JSON.parse(await pong), { type: "pong", id: "hello-ping" });

  // A second dial with the same code is rejected: the code is single-use.
  const reuse = new WebSocket(`${origin}/api/devices/register?code=${code}`);
  await new Promise<void>((resolve) => {
    reuse.addEventListener("close", () => resolve());
    reuse.addEventListener("error", () => resolve());
  });

  // Reconnect with the persistent token resumes without re-pairing.
  const resume = new WebSocket(`${origin}/api/devices/register?token=${token}`);
  const hello = await new Promise<string>((resolve, reject) => {
    resume.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    resume.addEventListener("error", () => reject(new Error("resume socket failed")), {
      once: true,
    });
  });
  assert.deepEqual(JSON.parse(hello), { type: "hello", resumed: true });

  phone.close();
  resume.close();
});

test("device observations resolve threads and bound excerpts for agent tools", async (t) => {
  const { service } = await deviceFixture(t, (path, body) => {
    if (path.endsWith("/uidump"))
      return {
        data: { text: `screen for ${(body as { x?: number }).x ?? "launch"}`, truncated: false },
      };
    const match = path.match(/^\/sessions\/([^/]+)/);
    const id = (body.id as string | undefined) ?? match?.[1] ?? sessionId;
    const packageOrUrl =
      (body.intentUri as string | undefined) ??
      (body.packageOrUrl as string | undefined) ??
      savedSession.packageOrUrl;
    return { data: { ...savedSession, id, packageOrUrl } };
  });
  await assert.rejects(service.observeForThread("owner", "thread-1"), {
    message: "Say which app or link to open on the phone first",
  });
  const first = await service.observeForThread("owner", "thread-1", "https://example.com/");
  assert.ok(first.sessionId);
  assert.equal(first.packageOrUrl, "https://example.com/");
  const second = await service.observeForThread("owner", "thread-1");
  assert.equal(second.sessionId, first.sessionId, "the thread reuses its phone");
  const direct = await service.observe("owner", { sessionId: first.sessionId });
  assert.equal(direct.sessionId, first.sessionId);
  await assert.rejects(service.observe("owner", {}), { status: 422 });
  await assert.rejects(
    service.observe("owner", { sessionId: "00000000-0000-4000-8000-000000000099" }),
    { status: 404 },
  );
});

test("device.action proposals approve with before/after screen receipts", async (t) => {
  const { db, config } = await deviceFixture(t, (path, body) => {
    if (path.endsWith("/uidump")) return { data: { text: "Home screen", truncated: false } };
    const match = path.match(/^\/sessions\/([^/]+)/);
    const id = (body.id as string | undefined) ?? match?.[1] ?? sessionId;
    const packageOrUrl =
      (body.intentUri as string | undefined) ??
      (body.packageOrUrl as string | undefined) ??
      savedSession.packageOrUrl;
    return { data: { ...savedSession, id, packageOrUrl } };
  });
  const { app, auth, actions } = await createApp(db, config);
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const now = new Date().toISOString();
  await db.put("local-user", "tasks", {
    id: "task-1",
    title: "Check the phone",
    prompt: "Look at the phone",
    kind: "agent",
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    artifactIds: [],
  });
  const proposed = await actions.propose(
    "local-user",
    {
      kind: "device.action",
      data: { intentUri: "vnd.youtube:dQw4w9WgXcQ", action: { type: "tap", x: 540, y: 1200 } },
    },
    undefined,
    "task-1",
  );
  assert.equal(proposed.status, "awaiting_review");
  assert.match(proposed.title, /Tap phone/);
  const decided = await actions.decide("local-user", proposed.id, proposed.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.match(decided.result ?? "", /Phone tap/);
  assert.match(decided.result ?? "", /session/);
  // The HTTP decide path approves the same way for taskless chat reviews.
  const viaHttp = await (
    await app.request("/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "device.action",
        data: { intentUri: "https://example.com/", action: { type: "key", key: "home" } },
      }),
    })
  ).json();
  assert.equal(viaHttp.status, "awaiting_review");
  const approvedHttp = await (
    await app.request(`/api/actions/${viaHttp.id}/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ hash: viaHttp.hash, decision: "approve" }),
    })
  ).json();
  assert.equal(approvedHttp.status, "succeeded");
  const task = await db.get<{
    evidence: { kind: string; title: string; excerpt: string }[];
    state: Record<string, unknown>;
  }>("local-user", "tasks", "task-1");
  const receipts = (task?.evidence ?? []).filter((entry) => entry.kind === "device");
  assert.equal(receipts.length, 2);
  assert.match(receipts[0]?.title ?? "", /before/);
  assert.match(receipts[1]?.title ?? "", /after/);
  assert.match(receipts[1]?.excerpt ?? "", /Screenshot confirmed/);
});

test("device.action proposals validate input and fail closed without a phone", async (t) => {
  const { db, config } = await deviceFixture(t, () => ({ data: { ...savedSession } }));
  const { app, auth } = await createApp(db, config);
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  assert.equal(
    (
      await app.request("/api/actions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "device.action",
          data: { action: { type: "tap", x: 1 } },
        }),
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await app.request("/api/actions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "device.action",
          data: {
            sessionId: "00000000-0000-4000-8000-000000000099",
            action: { type: "tap", x: 1, y: 1 },
          },
        }),
      })
    ).status,
    404,
  );
  const denied = await (
    await app.request("/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "device.action",
        data: { intentUri: "https://example.com/", action: { type: "key", key: "home" } },
      }),
    })
  ).json();
  const declined = await (
    await app.request(`/api/actions/${denied.id}/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ hash: denied.hash, decision: "deny" }),
    })
  ).json();
  assert.equal(declined.status, "denied");
  assert.equal(
    (await db.list("local-user", "devices")).length,
    0,
    "denied actions never touch the phone",
  );
});
