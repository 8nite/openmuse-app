import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { botBlockError, createBrowserManager } from "../src/browser.ts";

// Live-site probe: needs real internet, so it stays out of `pnpm test` and
// runs via `pnpm test:live`. Akamai scores this sandbox's datacenter IP near
// its threshold, so walmart.ca sometimes loads and sometimes refuses — the
// contract asserted here holds in both cases: a real page load, or a clean
// actionable refusal. Raw block text as content, or any other error, fails.
test("live protected retail page loads or refuses cleanly, never leaks block text", {
  timeout: 180_000,
}, async (t) => {
  try {
    await fetch("https://example.com", { signal: AbortSignal.timeout(10_000) });
  } catch {
    t.skip("no internet access; cannot probe the live site");
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-live-site-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID();
  t.after(async () => {
    try {
      await browser.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(join("/tmp", `openmuse-downloads-${id}`), {
        recursive: true,
        force: true,
      });
    }
  });
  try {
    await browser.create(id, "https://www.walmart.ca/en");
  } catch (error) {
    assert.equal(
      (error as { code?: string }).code,
      "BLOCKED_BY_SITE",
      `live navigation must refuse cleanly, got: ${String(error).slice(0, 200)}`,
    );
    assert.match(String((error as Error).message), /Take control/);
    return;
  }
  const page = await browser.read(id);
  assert.match(page.title, /walmart|online shopping/i);
  // Store content streams in over ~30-60s: poll the live session instead of
  // asserting on a single immediate read (measured 807 chars at T+15s,
  // 1006 at T+45s on a real load, 2026-10-22).
  let text = page.text;
  for (let i = 0; i < 5 && text.length <= 1000; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    text = (await browser.read(id)).text;
  }
  assert.ok(text.length > 1000, "a real page load carries substantial text");
  assert.equal(
    botBlockError(new URL(page.url).hostname, null, page.title, text.slice(0, 4000)),
    null,
    "loaded content must not carry block markers",
  );
});
