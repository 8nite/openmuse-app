import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import { Files } from "../apps/server/src/files.ts";
import { botBlockError } from "../apps/worker/src/browser.ts";
import { capturePdfDownload, readDownloadFailures } from "../apps/worker/src/downloads.ts";
import { isPublicIp, validatePublicUrl } from "../apps/worker/src/network.ts";
import { startEgressProxy } from "../apps/worker/src/proxy.ts";
import { createWorkerServer } from "../apps/worker/src/server.ts";
import type { BrowserSession } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const savedSession: BrowserSession = {
  id: sessionId,
  title: "Saved page",
  url: "https://example.com/",
  status: "active",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

test("browser API reopens an owned profile at the edited address and renews console access", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { db, config } = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    return { data: { ...savedSession, url: body.url } };
  });
  const { app, auth, agent } = await createApp(db, config);
  t.after(() => agent.stop());
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await db.put("local-user", "browsers", { ...savedSession, status: "closed" });
  const path = `/api/browsers/${sessionId}`;
  const opened = await app.request(`${path}/reopen`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "https://example.org/" }),
  });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).url, "https://example.org/");
  assert.deepEqual(calls[0], {
    path: "/sessions",
    body: { id: sessionId, url: "https://example.org/" },
  });
  assert.equal((await app.request(`${path}/reopen`, { method: "POST", headers })).status, 200);
  assert.equal(
    calls[1]?.body.url,
    "https://example.org/",
    "bodyless reopen keeps the saved address",
  );

  const start = Date.now();
  const clock = t.mock.method(Date, "now", () => start);
  const previous: BrowserSession = await (await app.request(path, { headers })).json();
  assert.ok(previous.consoleUrl);
  clock.mock.mockImplementation(() => start + 16 * 60_000);
  assert.equal((await app.request(previous.consoleUrl)).status, 401);
  const renewed: BrowserSession = await (await app.request(path, { headers })).json();
  assert.ok(renewed.consoleUrl);
  assert.notEqual(renewed.consoleUrl, previous.consoleUrl);
  const console = await app.request(renewed.consoleUrl);
  assert.equal(console.status, 200);
  assert.match(await console.text(), /Browser keyboard/);
  assert.equal((await app.request(path)).status, 401);
  const hiddenId = "00000000-0000-4000-8000-000000000099";
  await db.put("someone-else", "browsers", { ...savedSession, id: hiddenId });
  assert.equal((await app.request(`/api/browsers/${hiddenId}`, { headers })).status, 404);
  assert.equal(
    (await app.request(`/api/browsers/${hiddenId}/reopen`, { method: "POST", headers, body: "{}" }))
      .status,
    404,
  );
  assert.equal(calls.length, 2, "renewal and rejected requests never navigate the browser");
});

test("server reopens the same worker UUID regardless of stale local session status", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { db, service } = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    return { data: { ...savedSession, url: body.url } };
  });
  for (const status of ["active", "closed", "idle", "error"] as const) {
    await db.put("owner", "browsers", { ...savedSession, status });
    const opened = await service.navigate("owner", sessionId, "https://example.org/");
    assert.equal(opened.id, sessionId);
    assert.deepEqual(calls.at(-1), {
      path: "/sessions",
      body: { id: sessionId, url: "https://example.org/" },
    });
    assert.equal((await service.get("owner", sessionId)).url, "https://example.org/");
  }
  await assert.rejects(service.navigate("stranger", sessionId, "https://example.org/"), {
    status: 404,
  });
  assert.equal(calls.length, 4);
});

test("console input persists the worker's current page title and URL", async (t) => {
  const updated = { ...savedSession, title: "New page", url: "https://example.org/" };
  const { db, service } = await browserFixture(t, () => ({ data: updated }));
  await db.put("owner", "browsers", savedSession);
  const result = await service.input("owner", sessionId, { type: "key", key: "Enter" });
  assert.equal(result.title, updated.title);
  assert.deepEqual(await service.get("owner", sessionId), updated);
});

test("takeover console streams live frames and routes hover moves off the serial queue", async (t) => {
  const calls: string[] = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url?.endsWith("/stream")) {
        res.writeHead(200, {
          "content-type": "multipart/x-mixed-replace; boundary=openmuse-frame",
        });
        res.end(
          Buffer.concat([
            Buffer.from(
              `--openmuse-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
            ),
            jpeg,
            Buffer.from("\r\n"),
          ]),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.endsWith("/move") ? { ok: true } : { ...savedSession }));
    });
  });
  worker.listen(0, "127.0.0.1");
  await once(worker, "listening");
  t.after(async () => {
    worker.closeAllConnections();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
  });
  const address = worker.address();
  assert(address && typeof address !== "string");
  const { db, config } = await browserFixture(t, () => ({ data: { ...savedSession } }));
  const { app, auth, agent } = await createApp(db, {
    ...config,
    workerUrl: `http://127.0.0.1:${address.port}`,
  });
  t.after(() => agent.stop());
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await db.put("local-user", "browsers", savedSession);

  const stream = await app.request(`/api/browsers/${sessionId}/stream`, { headers });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /multipart\/x-mixed-replace/);
  const payload = Buffer.from(await stream.arrayBuffer());
  assert.ok(payload.includes("openmuse-frame"), "stream sends multipart frames");
  assert.ok(payload.includes(jpeg), "stream sends JPEG frames");

  const hover = await app.request(`/api/browsers/${sessionId}/console`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "move", x: 100, y: 100 }),
  });
  assert.deepEqual(await hover.json(), { ok: true });
  const held = await app.request(`/api/browsers/${sessionId}/console`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "move", held: true, x: 100, y: 100 }),
  });
  assert.deepEqual(await held.json(), { ok: true });
  assert.ok(
    calls.some((call) => call.includes(`/sessions/${sessionId}/move`)),
    "hover uses the fast path",
  );
  assert.ok(
    calls.some((call) => call.includes(`/sessions/${sessionId}/input`)),
    "held drag stays ordered",
  );
});

test("failed creation remains app-visible and can be retried with its original UUID", async (t) => {
  let failing = true;
  let requestedId: unknown;
  const { db, service } = await browserFixture(t, (_path, body) => {
    requestedId = body.id;
    return failing
      ? { status: 502, data: { error: { code: "NAVIGATION_FAILED", message: "Page unavailable" } } }
      : { data: { ...savedSession, id: body.id, url: body.url } };
  });
  await assert.rejects(service.create("owner", "https://example.org/"), /Page unavailable/);
  const sessions = await db.list<BrowserSession>("owner", "browsers");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, requestedId);
  assert.equal(sessions[0]?.status, "error");
  assert.equal(sessions[0]?.url, "https://example.org/");
  failing = false;
  const result = await service.reopen("owner", sessions[0].id);
  assert.equal(result.id, sessions[0]?.id);
  assert.equal(result.status, "active");
});

test("standby sessions are handed out on create and refilled", async (t) => {
  const launched: unknown[] = [];
  const { config, service } = await browserFixture(t, (path, body) => {
    if (path === "/sessions") launched.push(body.id);
    return {
      data: {
        id: body.id,
        url: body.url,
        title: "New session",
        status: "active",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  async function waitForLaunches(count: number) {
    const start = Date.now();
    while (launched.length < count) {
      if (Date.now() - start > 10_000) throw new Error("standby refill timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  // The fixture disables the pool for deterministic call sequences; opt in here.
  config.standbySessions = 1;
  await service.warmStandby();
  assert.equal(launched.length, 1);
  const first = await service.create("owner", "https://example.org/one");
  assert.equal(first.id, launched[0], "first create hands out the pooled session");
  // The handoff refills the pool in the background before the next create.
  await waitForLaunches(3);
  const refilled = launched.find((id) => id !== first.id);
  assert.ok(refilled);
  const second = await service.create("owner", "https://example.org/two");
  assert.equal(second.id, refilled, "second create reuses the refilled standby");
  assert.notEqual(second.id, first.id);
});

test("chat browser first read reuses the standby pool instead of cold-launching", async (t) => {
  const launched: unknown[] = [];
  let currentUrl = "https://example.org/standby";
  const { config, service } = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      launched.push(body.id);
      currentUrl = String(body.url);
      return {
        data: {
          id: body.id,
          url: body.url,
          title: "New session",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return { data: { url: currentUrl, title: "Read", text: "chat page", truncated: false } };
  });
  config.standbySessions = 1;
  await service.warmStandby();
  assert.equal(launched.length, 1);
  const first = await service.observeForThread("owner", "chat-thread", "https://example.org/chat");
  assert.equal(first.sessionId, launched[0], "first chat browse hands out the pooled session");
  // Same thread reuses its pinned profile.
  const repeat = await service.observeForThread("owner", "chat-thread", "https://example.org/chat2");
  assert.equal(repeat.sessionId, first.sessionId);
  // The handoff refills the pool in the background for the next thread.
  const start = Date.now();
  let refilled: unknown;
  while (Date.now() - start < 10_000) {
    refilled = launched.find((id) => id !== first.sessionId);
    if (refilled) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(refilled, "standby pool refills after the chat handoff");
  const other = await service.observeForThread("owner", "other-thread", "https://example.org/other");
  assert.equal(other.sessionId, refilled, "next chat thread reuses the refilled standby");
});

test("browser observations reuse an owned profile and reject unowned reads", async (t) => {
  const calls: string[] = [];
  const read = {
    url: "https://example.org/",
    title: "Observed",
    text: "Public page text",
    truncated: false,
  };
  const { db, service } = await browserFixture(t, (path, body) => {
    calls.push(path);
    return {
      data: path.endsWith("/read") ? read : { ...savedSession, id: body.id, url: body.url },
    };
  });
  await db.put("owner", "browsers", savedSession);
  assert.deepEqual(await service.observe("owner", read.url, sessionId), { sessionId, ...read });
  assert.deepEqual(calls, ["/sessions", `/sessions/${sessionId}/read`]);
  assert.equal((await service.get("owner", sessionId)).title, read.title);
  await assert.rejects(service.read("stranger", sessionId), { status: 404 });
  await assert.rejects(service.observe("stranger", read.url, sessionId), { status: 404 });
  assert.equal(calls.length, 2);
  const fresh = await service.observe("owner", read.url);
  assert.notEqual(fresh.sessionId, sessionId);
  assert.equal(fresh.text, read.text);
});

test("cancelled task-style browser observations stop before a follow-up read", async (t) => {
  const controller = new AbortController();
  const calls: string[] = [];
  const { db, service } = await browserFixture(t, (path, body) => {
    calls.push(path);
    controller.abort();
    return { data: { ...savedSession, id: body.id, url: body.url } };
  });
  await assert.rejects(service.observe("owner", savedSession.url, undefined, controller.signal), {
    name: "AbortError",
  });
  assert.deepEqual(calls, ["/sessions"]);
  const [saved] = await db.list<BrowserSession>("owner", "browsers");
  assert.equal(saved?.status, "idle", "cancellation must not persist a browser failure");
});

test("chat browser reads reuse a persisted owned profile across turns and service restarts", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let currentUrl = savedSession.url;
  const { db, service, config } = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/read"))
      return {
        data: { url: currentUrl, title: "Read page", text: "x".repeat(30_001), truncated: false },
      };
    currentUrl = String(body.url);
    return { data: { ...savedSession, id: body.id, url: currentUrl } };
  });
  const first = await service.observeForThread("owner", "chat-thread", "https://example.org/first");
  assert.equal(first.text.length, 30_000);
  assert.equal(first.truncated, true);
  const auth = new Auth(db, config, "test-signing-key");
  const restarted = new BrowserService(db, config, auth, new Files(db, config, auth));
  for (const status of ["active", "closed", "error", "idle"] as const) {
    await db.put("owner", "browsers", { ...(await service.get("owner", first.sessionId)), status });
    const next = await restarted.observeForThread(
      "owner",
      "chat-thread",
      `https://example.org/${status}`,
    );
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(next.url, `https://example.org/${status}`);
  }
  assert.equal((await db.list("owner", "browsers")).length, 1);
  assert.equal(calls.filter((call) => call.path === "/sessions").length, 5);
  const otherOwner = await restarted.observeForThread("stranger", "chat-thread", savedSession.url);
  assert.notEqual(otherOwner.sessionId, first.sessionId);
  await assert.rejects(restarted.get("stranger", first.sessionId), { status: 404 });
});

test("chat browser retries failed navigation using the reserved profile", async (t) => {
  const ids: unknown[] = [];
  let failing = true;
  const { db, service } = await browserFixture(t, (path, body) => {
    if (path.endsWith("/read"))
      return {
        data: {
          url: savedSession.url,
          title: "Read page",
          text: "Actual contents",
          truncated: true,
        },
      };
    ids.push(body.id);
    return failing
      ? { status: 502, data: { error: { message: "Page unavailable" } } }
      : { data: { ...savedSession, id: body.id } };
  });
  await assert.rejects(
    service.observeForThread("owner", "chat-thread", savedSession.url),
    /Page unavailable/,
  );
  assert.equal((await db.list<BrowserSession>("owner", "browsers"))[0]?.status, "error");
  failing = false;
  const result = await service.observeForThread("owner", "chat-thread", savedSession.url);
  assert.deepEqual(ids, [result.sessionId, result.sessionId]);
  assert.equal(result.text, "Actual contents");
  assert.equal(result.truncated, true);
});

test("a blocked read still surfaces its live session id for Take control", async (t) => {
  const { db, service } = await browserFixture(t, (path, body) => {
    if (path.endsWith("/read"))
      return { status: 502, data: { error: { message: "Refused by example.org" } } };
    return { data: { ...savedSession, id: body.id, url: body.url } };
  });
  const failure = await service.observeForThread("owner", "chat-thread", savedSession.url).then(
    () => assert.fail("blocked read must reject"),
    (error: unknown) => error,
  );
  assert.match(String((failure as Error).message), /Refused by example\.org/);
  const sessionId = (failure as { browserSessionId?: unknown }).browserSessionId;
  assert.equal(typeof sessionId, "string");
  const [saved] = await db.list<BrowserSession>("owner", "browsers");
  assert.equal(saved?.id, sessionId, "the challenge page session must persist");
  assert.equal(saved?.status, "active", "worker open succeeded; only the read was refused");
});

test("concurrent chat reads keep each navigation paired with its page read", async (t) => {
  let currentUrl = savedSession.url;
  const { db, service } = await browserFixture(t, (path, body) => {
    if (path.endsWith("/read"))
      return { data: { url: currentUrl, title: currentUrl, text: currentUrl, truncated: false } };
    currentUrl = String(body.url);
    return { data: { ...savedSession, id: body.id, url: currentUrl } };
  });
  const urls = ["https://example.org/one", "https://example.org/two"];
  const results = await Promise.all(
    urls.map((url) => service.observeForThread("owner", "chat-thread", url)),
  );
  assert.deepEqual(
    results.map((result) => result.text),
    urls,
  );
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.equal((await db.list("owner", "browsers")).length, 1);
});

test("cancelled chat browser requests do not start navigation or a follow-up read", async (t) => {
  const controller = new AbortController();
  const calls: string[] = [];
  const { db, service } = await browserFixture(t, (path, body) => {
    calls.push(path);
    controller.abort();
    return { data: { ...savedSession, id: body.id } };
  });
  await assert.rejects(
    service.observeForThread("owner", "chat-thread", savedSession.url, controller.signal),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, ["/sessions"]);
  await assert.rejects(
    service.observeForThread("owner", "other-thread", savedSession.url, controller.signal),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, ["/sessions"]);
  assert.equal((await db.list("owner", "browsers")).length, 1);
});

test("browser read fails on missing page text instead of inventing observation content", async (t) => {
  const { db, service } = await browserFixture(t, () => ({
    data: { url: savedSession.url, title: savedSession.title },
  }));
  await db.put("owner", "browsers", savedSession);
  await assert.rejects(service.read("owner", sessionId));
});

test("browser imports return rejected downloads even when no PDF was accepted", async (t) => {
  const failure = {
    id: "00000000-0000-4000-8000-000000000005",
    name: "oversized.pdf",
    code: "DOWNLOAD_TOO_LARGE",
    message: "The download exceeds 10 MiB.",
    createdAt: "2026-09-15T00:00:00.000Z",
  };
  const { db, service } = await browserFixture(t, () => ({
    data: { downloads: [], failures: [failure] },
  }));
  await db.put("owner", "browsers", savedSession);
  assert.deepEqual(await service.imports("owner", sessionId), { files: [], failures: [failure] });
});

test("worker persists unsupported, oversized and interrupted download outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-outcomes-"));
  try {
    const cases = [
      { name: "notes.txt", contents: Buffer.from("not a PDF"), code: "UNSUPPORTED_DOWNLOAD" },
      {
        name: "large.pdf",
        contents: Buffer.alloc(10 * 1024 * 1024 + 1),
        code: "DOWNLOAD_TOO_LARGE",
      },
      { name: "cancelled.pdf", contents: null, code: "DOWNLOAD_INTERRUPTED" },
    ];
    for (const item of cases) {
      await capturePdfDownload({
        directory,
        tempDirectory: directory,
        limitReached: false,
        download: {
          suggestedFilename: () => item.name,
          createReadStream: async () => {
            if (!item.contents) throw new Error("Interrupted download");
            return Readable.from([item.contents]);
          },
          cancel: async () => {},
          delete: async () => {},
        },
      });
    }
    const failures = await readDownloadFailures(directory);
    assert.equal(failures.length, 3);
    for (const item of cases) {
      assert.equal(failures.find((failure) => failure.name === item.name)?.code, item.code);
    }
    assert(failures.every((failure) => failure.message && failure.createdAt));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker recovery cleans unpublished downloads and retains their interruption failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, "downloads");
  const outcomes = join(directory, "download-outcomes");
  await mkdir(folder);
  await mkdir(outcomes);
  const failure = {
    id: "00000000-0000-4000-8000-000000000006",
    name: "unfinished.pdf",
    code: "DOWNLOAD_INTERRUPTED",
    message: "The download was interrupted.",
    createdAt: "2026-09-15T00:00:00.000Z",
  };
  const pdf = join(folder, `${failure.id}.pdf`);
  const metadataTemp = join(folder, `${failure.id}.json.tmp`);
  const bytes = Buffer.from("%PDF-1.7\npartial download");
  await writeFile(pdf, bytes);
  await writeFile(metadataTemp, '{"id":');
  await writeFile(
    join(outcomes, `${failure.id}.json`),
    JSON.stringify({ ...failure, status: "pending" }),
  );

  assert.deepEqual(await readDownloadFailures(directory), []);
  assert.deepEqual(await readFile(pdf), bytes, "ordinary reads must not clean active downloads");
  assert.deepEqual(await readDownloadFailures(directory, true), [failure]);
  await assert.rejects(readFile(pdf), { code: "ENOENT" });
  await assert.rejects(readFile(metadataTemp), { code: "ENOENT" });
  assert.deepEqual(await readDownloadFailures(directory, true), [failure]);
});

test("worker recovery retries incomplete cleanup before recording failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, "downloads");
  const outcomes = join(directory, "download-outcomes");
  await mkdir(folder);
  await mkdir(outcomes);
  const failure = {
    id: "00000000-0000-4000-8000-000000000009",
    name: "unfinished.pdf",
    code: "DOWNLOAD_INTERRUPTED",
    message: "The download was interrupted.",
    createdAt: "2026-09-15T00:00:00.000Z",
  };
  const journal = join(outcomes, `${failure.id}.json`);
  await writeFile(journal, JSON.stringify({ ...failure, status: "pending" }));
  const pdf = join(folder, `${failure.id}.pdf`);
  await writeFile(pdf, "%PDF-1.7\npartial download");
  const metadataTemp = join(folder, `${failure.id}.json.tmp`);
  // A directory at the file path forces cleanup to fail without permission mocks.
  await mkdir(metadataTemp);

  await assert.rejects(readDownloadFailures(directory, true));
  assert.deepEqual(JSON.parse(await readFile(journal, "utf8")), { ...failure, status: "pending" });
  await assert.rejects(readFile(pdf), { code: "ENOENT" });
  await rm(metadataTemp, { recursive: true });
  assert.deepEqual(await readDownloadFailures(directory, true), [failure]);
  assert.deepEqual(await readDownloadFailures(directory, true), [failure]);
  assert.equal(JSON.parse(await readFile(journal, "utf8")).status, "failed");
});

test("worker recovery preserves downloads when metadata cannot be inspected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, "downloads");
  const outcomes = join(directory, "download-outcomes");
  await mkdir(folder);
  await mkdir(outcomes);
  const id = "00000000-0000-4000-8000-000000000007";
  const outcome = {
    id,
    name: "unreadable.pdf",
    status: "pending",
    code: "DOWNLOAD_INTERRUPTED",
    message: "The download was interrupted.",
    createdAt: "2026-09-15T00:00:00.000Z",
  };
  const pdf = join(folder, `${id}.pdf`);
  const metadata = join(folder, `${id}.json`);
  const bytes = Buffer.from("%PDF-1.7\npreserve me");
  await writeFile(pdf, bytes);
  await writeFile(`${metadata}.tmp`, '{"id":');
  const journal = join(outcomes, `${id}.json`);
  await writeFile(journal, JSON.stringify(outcome));
  // A symlink loop raises a real filesystem error even when tests run as root.
  await symlink(`${id}.json`, metadata);

  await assert.rejects(readDownloadFailures(directory, true), { code: "ELOOP" });
  assert.deepEqual(await readFile(pdf), bytes);
  assert.equal(await readFile(`${metadata}.tmp`, "utf8"), '{"id":');
  assert.deepEqual(JSON.parse(await readFile(journal, "utf8")), outcome);
});

test("worker recovery reconciles published downloads and transfers without files", async (t) => {
  for (const published of [false, true]) {
    await t.test(
      published ? "published PDF is retained" : "missing files are tolerated",
      async (t) => {
        const directory = await mkdtemp(join(tmpdir(), "openmuse-download-recovery-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const folder = join(directory, "downloads");
        const outcomes = join(directory, "download-outcomes");
        await mkdir(folder);
        await mkdir(outcomes);
        const failure = {
          id: "00000000-0000-4000-8000-000000000008",
          name: "report.pdf",
          code: "DOWNLOAD_INTERRUPTED",
          message: "The download was interrupted.",
          createdAt: "2026-09-15T00:00:00.000Z",
        };
        const journal = join(outcomes, `${failure.id}.json`);
        await writeFile(journal, JSON.stringify({ ...failure, status: "pending" }));
        const bytes = Buffer.from("%PDF-1.7\npublished download");
        const pdf = join(folder, `${failure.id}.pdf`);
        const metadata = join(folder, `${failure.id}.json`);
        const saved = {
          id: failure.id,
          name: failure.name,
          size: bytes.length,
          mimeType: "application/pdf",
        };
        if (published) {
          await writeFile(pdf, bytes);
          await writeFile(metadata, JSON.stringify(saved));
        }

        const expected = published ? [] : [failure];
        assert.deepEqual(await readDownloadFailures(directory, true), expected);
        assert.deepEqual(await readDownloadFailures(directory, true), expected);
        if (published) {
          assert.deepEqual(await readFile(pdf), bytes);
          assert.deepEqual(JSON.parse(await readFile(metadata, "utf8")), saved);
          await assert.rejects(readFile(journal), { code: "ENOENT" });
        } else {
          assert.equal(JSON.parse(await readFile(journal, "utf8")).status, "failed");
        }
      },
    );
  }
});

test("bot block pages are refused with an actionable error, not page text", async () => {
  const imperva = botBlockError(
    "www.walmart.ca",
    403,
    "Forbidden",
    "Forbidden\nRequest ID: 1792596004-027221726-30430400238-972211726\nIncapsula",
  );
  assert.ok(imperva);
  assert.equal(imperva.code, "BLOCKED_BY_SITE");
  assert.match(imperva.message, /www\.walmart\.ca refused the cloud browser/);
  assert.match(imperva.message, /Imperva/);
  assert.match(imperva.message, /own browser/);

  const cloudflare = botBlockError(
    "example.com",
    503,
    "Attention Required! | Cloudflare",
    "Verify you are human by completing the action below.\nCloudflare",
  );
  assert.ok(cloudflare);
  assert.equal(cloudflare.code, "BLOCKED_BY_SITE");

  // Akamai answers HTTP 200 with a challenge page, so markers must match
  // without an error status. Both the dead-end and the hold-modal variants.
  const akamaiDeadEnd = botBlockError(
    "www.walmart.ca",
    200,
    "Verify Your Identity",
    "We like real shoppers, not robots!\nPlease press and hold the button below to verify yourself",
  );
  assert.ok(akamaiDeadEnd);
  assert.equal(akamaiDeadEnd.code, "BLOCKED_BY_SITE");
  assert.match(akamaiDeadEnd.message, /Akamai/);
  assert.match(akamaiDeadEnd.message, /Take control/);

  const akamaiModal = botBlockError(
    "www.walmart.ca",
    200,
    "Online Shopping Canada: Everyday Low Prices at Walmart.ca!",
    "Robot or human?\nActivate and hold the button to confirm that you're human. Thank You!",
  );
  assert.ok(akamaiModal);
  assert.equal(akamaiModal.code, "BLOCKED_BY_SITE");

  // Bare "Forbidden <ref>" block page with an empty title, as served for
  // walmart.ca over HTTP 200 with no vendor wording on the page.
  const bare = botBlockError(
    "www.walmart.ca",
    200,
    "",
    "Forbidden\n1792600555-49182634-15394164442-49182634",
  );
  assert.ok(bare);
  assert.equal(bare.code, "BLOCKED_BY_SITE");
  assert.match(bare.message, /Take control/);

  // Same shape but denied with a non-standard status (observed HTTP 456):
  // the reference ID alone plus "Forbidden" is enough to refuse cleanly.
  const oddStatus = botBlockError(
    "www.walmart.ca",
    456,
    "",
    "Forbidden\n1792615509-90052962-28186577106-90052962",
  );
  assert.ok(oddStatus);
  assert.equal(oddStatus.code, "BLOCKED_BY_SITE");
  assert.match(oddStatus.message, /HTTP 456/);
  assert.match(oddStatus.message, /1792615509-90052962/);
  assert.match(oddStatus.message, /Take control/);

  // Ordinary pages never match, even on error statuses without denial markers.
  assert.equal(botBlockError("example.com", 200, "Example Domain", "Example text"), null);
  assert.equal(
    botBlockError("example.com", 403, "Example Domain", "Example text without markers"),
    null,
  );
  assert.equal(botBlockError("example.com", null, "Example Domain", "Example text"), null);
  assert.equal(
    botBlockError(
      "example.com",
      200,
      "Order confirmation",
      "Order 1792600555-49182634-1539 shipped",
    ),
    null,
  );
});

test("browser rejects private, special-use and encoded IP addresses", async () => {
  const blocked = [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.2",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "2002:7f00:1::1",
    "3fff::1",
  ];
  for (const address of blocked) assert.equal(isPublicIp(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicIp(address), true, address);
  }
  for (const url of [
    "http://2130706433",
    "http://0x7f000001",
    "http://0177.0.0.1",
    "http://127.1",
    "http://[::ffff:127.0.0.1]",
    "http://localhost.",
    "http://host.local",
    "file:///etc/passwd",
    "data:text/html,hello",
    "javascript:alert(1)",
    "https://user:password@example.com",
    "http://example.com:22",
  ])
    await assert.rejects(validatePublicUrl(url), { code: "BLOCKED_URL" }, url);
});

test("browser rejects DNS answers containing any private address and pins public resolution", async () => {
  await assert.rejects(
    validatePublicUrl("https://example.com", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    { code: "BLOCKED_URL" },
  );
  const result = await validatePublicUrl("https://example.com/a", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  assert.equal(result.address, "93.184.216.34");
  assert.equal(result.url.href, "https://example.com/a");
});

test("worker protects all controls, validates before launch, and health reveals no sessions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-worker-"));
  const savedId = "00000000-0000-4000-8000-000000000002";
  const downloadId = "00000000-0000-4000-8000-000000000003";
  const pendingId = "00000000-0000-4000-8000-000000000004";
  const downloadFolder = join(dataDir, savedId, "downloads");
  const outcomeFolder = join(dataDir, savedId, "download-outcomes");
  await mkdir(downloadFolder, { recursive: true });
  await mkdir(outcomeFolder, { recursive: true });
  await writeFile(join(downloadFolder, `${pendingId}.pdf`), "%PDF-1.7\npartial download");
  await writeFile(join(downloadFolder, `${pendingId}.json.tmp`), '{"id":');
  await writeFile(
    join(outcomeFolder, `${pendingId}.json`),
    JSON.stringify({
      id: pendingId,
      name: "unfinished.pdf",
      status: "pending",
      code: "DOWNLOAD_INTERRUPTED",
      message: "The download was interrupted.",
      createdAt: "2026-09-15T00:00:00.000Z",
    }),
  );
  await writeFile(
    join(dataDir, savedId, "session.json"),
    JSON.stringify({
      id: savedId,
      title: "Saved",
      url: "https://example.com",
      status: "active",
      updatedAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    join(downloadFolder, `${downloadId}.json`),
    JSON.stringify({
      id: downloadId,
      name: "large.pdf",
      size: 10 * 1024 * 1024 + 1,
      mimeType: "application/pdf",
    }),
  );
  await writeFile(join(downloadFolder, `${downloadId}.pdf`), "");
  await truncate(join(downloadFolder, `${downloadId}.pdf`), 10 * 1024 * 1024 + 1);
  const worker = await createWorkerServer({
    token: "test-worker-token-at-least-32-characters",
    dataDir,
  });
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  const address = worker.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { status: "ok" });
    for (const path of [
      "/sessions",
      "/sessions/invalid/screenshot",
      `/sessions/${savedId}/read`,
      "/anything",
    ]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401);
    }
    const headers = {
      authorization: "Bearer test-worker-token-at-least-32-characters",
      "content-type": "application/json",
    };
    assert.equal((await fetch(`${base}/sessions`, { headers })).status, 200);
    const restored = await (await fetch(`${base}/sessions`, { headers })).json();
    assert.equal(
      restored[0].status,
      "closed",
      "restart must not report a closed browser as active",
    );
    const closedRead = await fetch(`${base}/sessions/${savedId}/read`, { headers });
    assert.equal(closedRead.status, 409);
    assert.equal((await closedRead.json()).error.code, "SESSION_CLOSED");
    const outcomes = await (
      await fetch(`${base}/sessions/${savedId}/downloads`, { headers })
    ).json();
    assert.equal(outcomes.downloads.length, 1);
    assert.equal(outcomes.failures[0]?.code, "DOWNLOAD_INTERRUPTED");
    await assert.rejects(readFile(join(downloadFolder, `${pendingId}.pdf`)), { code: "ENOENT" });
    await assert.rejects(readFile(join(downloadFolder, `${pendingId}.json.tmp`)), {
      code: "ENOENT",
    });
    const oversized = await fetch(`${base}/sessions/${savedId}/downloads/${downloadId}`, {
      headers,
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "DOWNLOAD_TOO_LARGE");
    const invalidDownload = await fetch(`${base}/sessions/${savedId}/downloads/not-a-uuid`, {
      headers,
    });
    assert.equal(invalidDownload.status, 400);
    const blocked = await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", url: "http://127.0.0.1" }),
    });
    assert.equal(blocked.status, 400);
    assert.equal((await blocked.json()).error.code, "BLOCKED_URL");
    const invalid = await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "../../escape", url: "https://example.com" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await worker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("egress proxy blocks HTTP and CONNECT traffic to local network destinations", async () => {
  const proxy = await startEgressProxy();
  const address = new URL(proxy.url);
  try {
    for (const method of ["GET", "CONNECT"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = request({
          hostname: address.hostname,
          port: address.port,
          method,
          path: method === "CONNECT" ? "127.0.0.1:443" : "http://127.0.0.1/health",
        });
        outgoing.on("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        outgoing.on("connect", (response, socket) => {
          socket.destroy();
          resolve(response.statusCode ?? 0);
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      assert.equal(status, 403, method);
    }
  } finally {
    await proxy.close();
  }
});

test("the browser counts as connected only while its worker answers", async (t) => {
  let up = true;
  let clock = 0;
  const { db, config } = await browserFixture(t, (path) =>
    up && path === "/health" ? { data: { status: "ok" } } : { status: 503, data: {} },
  );
  const auth = new Auth(db, config, "test-signing-key");
  const service = new BrowserService(db, config, auth, new Files(db, config, auth), () => clock);
  assert.equal(await service.reachable(), true);
  up = false;
  assert.equal(await service.reachable(), true, "a recent answer is reused briefly");
  clock += 15_000;
  assert.equal(await service.reachable(), false);
  const unconfigured = new BrowserService(
    db,
    { ...config, workerUrl: undefined },
    auth,
    new Files(db, config, auth),
  );
  assert.equal(await unconfigured.reachable(), false);
});

test("the workspace reports the browser offline while its worker's health check fails", async (t) => {
  for (const up of [true, false]) {
    const { db, config } = await browserFixture(t, (path) =>
      up && path === "/health" ? { data: { status: "ok" } } : { status: 503, data: {} },
    );
    const { app, auth, agent } = await createApp(db, config);
    t.after(() => agent.stop());
    const { token } = await auth.session();
    const response = await app.request("/api/workspace", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const { connections } = (await response.json()) as {
      connections: { id: string; status: string }[];
    };
    assert.equal(
      connections.find((connection) => connection.id === "browser")?.status,
      up ? "connected" : "unavailable",
    );
  }
});
