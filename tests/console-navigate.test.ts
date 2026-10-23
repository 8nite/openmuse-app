import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { browserFixture } from "./helpers/browser.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";

test("console takeover can navigate to a specific url via its address bar", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const { db, config } = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    return {
      data: {
        id: body.id ?? sessionId,
        title: "Navigated",
        url: body.url ?? "https://example.com/",
        status: "active",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  const { app, auth, agent } = await createApp(db, config);
  t.after(() => agent.stop());
  const { token } = await auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await db.put("local-user", "browsers", {
    id: sessionId,
    title: "Saved",
    url: "https://example.com/",
    status: "active",
    updatedAt: new Date().toISOString(),
  });
  const detail: { consoleUrl?: string } = await (
    await app.request(`/api/browsers/${sessionId}`, { headers })
  ).json();
  assert.ok(detail.consoleUrl);
  const html = await (await app.request(detail.consoleUrl)).text();
  assert.match(html, /Website address/);
  assert.match(html, /Text to type in browser/);
  assert.match(html, /press and hold/);
  assert.match(html, /onpointerdown/);
  assert.match(html, /onpointermove/);
  const navigated = await app.request(`/api/browsers/${sessionId}/console`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "https://example.org/specific-page" }),
  });
  assert.equal(navigated.status, 200);
  assert.equal(
    calls.some(
      (call) => call.path === "/sessions" && call.body.url === "https://example.org/specific-page",
    ),
    true,
  );
  const bad = await app.request(`/api/browsers/${sessionId}/console`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "not a url" }),
  });
  assert.equal(bad.status, 422);
});
