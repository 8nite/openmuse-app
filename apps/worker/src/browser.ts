import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  capturePdfDownload,
  MAX_DOWNLOAD_BYTES,
  type PdfDownload,
  readDownloadFailures,
} from "./downloads.ts";
import { WorkerError } from "./errors.ts";
import { validatePublicUrl } from "./network.ts";
import { startEgressProxy } from "./proxy.ts";

export interface Session {
  id: string;
  title: string;
  url: string;
  status: "active" | "closed" | "error";
  updatedAt: string;
}
type Running = {
  context: BrowserContext;
  page: Page;
  touched: number;
  pending: Set<Promise<void>>;
  downloadError?: boolean;
};
/** One live screencast per session, fanned out to every stream viewer. */
type StreamHub = {
  clients: Set<(frame: Buffer) => void>;
  aborts: Set<() => void>;
  cdp: ScreencastSession | null;
  starting: Promise<void> | null;
};
/** Minimal CDP surface for screencasts (Playwright types no unlisted CDP events). */
interface ScreencastSession {
  on(event: "Page.screencastFrame", listener: (payload: { data: string; sessionId: string }) => void): unknown;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  removeAllListeners(event?: string): unknown;
  detach(): Promise<unknown>;
}
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id))
    throw new WorkerError("INVALID_SESSION", "A valid UUID session ID is required.");
  return id.toLowerCase();
}

/** Viewport coordinates shared by every pointer input (1280x800 session viewport). */
function validPoint(input: Record<string, unknown>): { x: number; y: number } | null {
  const { x, y } = input;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= 1280 ||
    y >= 800
  )
    return null;
  return { x, y };
}

/** Reference IDs anti-bot vendors print on block pages (e.g. Imperva's Request ID). */
const BLOCK_REF = /(?:request|incident|reference)\s*id\s*[:#]?\s*[\w-]{6,}/i;

function blockVendor(title: string, text: string): string | null {
  const haystack = `${title}\n${text}`;
  if (/incapsula|imperva/i.test(haystack) && (BLOCK_REF.test(haystack) || /forbidden/i.test(title)))
    return "Imperva";
  if (
    /cloudflare/i.test(haystack) &&
    /attention required|verify you are human|just a moment/i.test(haystack)
  )
    return "Cloudflare";
  if (/press\s*&\s*hold to confirm/i.test(haystack)) return "PerimeterX";
  if (/datadome/i.test(haystack)) return "DataDome";
  if (/pardon our interruption/i.test(haystack)) return "Akamai";
  if (
    /verify your identity/i.test(title) ||
    (/robot or human/i.test(haystack) && /hold/i.test(haystack))
  )
    return "Akamai";
  return null;
}

/**
 * Anti-bot vendors answer with a block page instead of failing the load, so a
 * refusal would otherwise surface as page content ("Forbidden 17925…").
 * Detect those pages and fail with an actionable error instead. Pure and
 * unit-tested; callers supply the main-document status when they have it.
 */
export function botBlockError(
  host: string,
  status: number | null,
  title: string,
  text: string,
): WorkerError | null {
  const vendor = blockVendor(title, text);
  const denied = status === 403 || status === 429 || (status === 503 && vendor !== null);
  // Bare vendor reference IDs with no label ("Forbidden\n1792600555-49182634-…").
  const bareRef = text.match(/\b\d{7,}(?:-\d+){2,}\b/)?.[0];
  const denialTitle = /forbidden|access denied|blocked/i.test(title);
  const forbiddenBody = /forbidden/i.test(text) && bareRef !== undefined;
  if (vendor === null && !(denied && denialTitle) && !forbiddenBody) return null;
  const detail =
    vendor === null
      ? `anti-bot block (HTTP ${status ?? "unknown"})`
      : `${vendor} anti-bot protection`;
  const ref = (text.match(BLOCK_REF)?.[0] ?? bareRef)?.slice(0, 60);
  return new WorkerError(
    "BLOCKED_BY_SITE",
    `${host} refused the cloud browser (${detail}${ref ? `, ${ref}` : ""}). ` +
      "Take control and finish any human check yourself (press and hold its button), or open it in your own browser.",
    502,
  );
}

export async function createBrowserManager(
  options: {
    dataDir: string;
    maxSessions?: number;
    idleTimeoutMs?: number;
  },
  createProxy = startEgressProxy,
) {
  const { dataDir, maxSessions = 3, idleTimeoutMs = 30 * 60_000 } = options;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  const running = new Map<string, Running>();
  const queues = new Map<string, Promise<unknown>>();
  const proxy = await createProxy();
  for (const id of await readdir(dataDir)) {
    if (!SESSION_ID.test(id)) continue;
    try {
      const stored = JSON.parse(
        await readFile(join(dataDir, id, "session.json"), "utf8"),
      ) as Session;
      sessions.set(id, { ...stored, id, status: "closed" });
    } catch {
      /* An incomplete first launch has no session metadata to restore. */
    }
    if (sessions.has(id)) await readDownloadFailures(join(dataDir, id), true);
  }
  const directory = (id: string) => join(dataDir, validateSessionId(id));
  async function persist(session: Session) {
    const path = join(directory(session.id), "session.json");
    await writeFile(`${path}.tmp`, JSON.stringify(session), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(id, next);
    try {
      return await next;
    } finally {
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  function active(id: string) {
    const value = running.get(id);
    if (!value || value.page.isClosed())
      throw new WorkerError(
        "SESSION_CLOSED",
        "Open this browser session before using its console.",
        409,
      );
    value.touched = Date.now();
    return value;
  }
  async function refresh(id: string) {
    const instance = active(id);
    if (instance.page.url() !== "about:blank") await validatePublicUrl(instance.page.url());
    const session: Session = {
      id,
      title: (await instance.page.title()).slice(0, 300),
      url: instance.page.url(),
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, session);
    await persist(session);
    return session;
  }
  async function downloads(id: string): Promise<PdfDownload[]> {
    if (!sessions.has(id))
      throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    const folder = join(directory(id), "downloads");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const list: PdfDownload[] = [];
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const item = JSON.parse(await readFile(join(folder, name), "utf8")) as PdfDownload;
      list.push(item);
    }
    return list;
  }
  async function navigate(id: string, url: string) {
    const target = await validatePublicUrl(url);
    const { page } = active(id);
    async function probe() {
      return page
        .evaluate(() => ({
          title: document.title.slice(0, 300),
          text: (document.body?.innerText ?? "").slice(0, 4000),
        }))
        .catch(() => ({ title: "", text: "" }));
    }
    try {
      // 45s (not 20s): domcontentloaded on a congested link can take >20s
      // for heavy pages (measured 21.8s for github.com); the agent run that
      // wraps this call has its own much larger budget.
      const response = await page.goto(target.url.href, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      // Chromium can follow redirects outside Playwright's initial route hook.
      // The proxy blocks those sockets, but its 403 is still an HTTP response:
      // validate the final location so the API does not report it as success.
      await validatePublicUrl(page.url());
      // Anti-bot vendors answer with a block/challenge page instead of failing
      // the load (often HTTP 200), so probe every navigation for refusal markers.
      const seen = await probe();
      const blocked = botBlockError(
        target.url.host,
        response?.status() ?? null,
        seen.title,
        seen.text,
      );
      if (blocked) throw blocked;
    } catch (error) {
      if (error instanceof WorkerError && error.code === "BLOCKED_BY_SITE") throw error;
      if (error instanceof WorkerError && error.code === "BLOCKED_URL") {
        await page.goto("about:blank", { timeout: 5000 });
      } else if (error instanceof Error && error.name === "TimeoutError") {
        // Heavy pages can outlast domcontentloaded while fully usable
        // (measured on a retail homepage). Continue when real content and no
        // refusal markers are already there.
        const slow = await probe();
        const usable = slow.title.trim().length > 0 && slow.text.trim().length > 200;
        if (usable && !botBlockError(target.url.host, null, slow.title, slow.text))
          return refresh(id);
      }
      // A successful attachment intentionally aborts page navigation.
      if (!(error instanceof Error && /Download is starting/.test(error.message))) {
        throw new WorkerError(
          "NAVIGATION_FAILED",
          "The page could not be loaded. It may be unreachable or contain a blocked destination.",
          502,
        );
      }
    }
    return refresh(id);
  }
  async function closeSession(id: string) {
    stopStream(id);
    const instance = running.get(id);
    const stored = sessions.get(id);
    if (!stored) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    if (instance) {
      try {
        await instance.context.storageState({ path: join(directory(id), "storage.json") });
      } catch {
        // Cookie persistence is best-effort during teardown. A crashed or
        // unreachable browser must still release its context and session slot.
      }
      await instance.context.close().catch(() => {});
      await Promise.allSettled(instance.pending);
      running.delete(id);
    }
    const result: Session = { ...stored, status: "closed", updatedAt: new Date().toISOString() };
    sessions.set(id, result);
    await persist(result);
    return result;
  }
  async function createSession(id: string, url: string) {
    await validatePublicUrl(url);
    if (running.has(id)) return navigate(id, url);
    if (running.size >= maxSessions)
      throw new WorkerError(
        "SESSION_LIMIT",
        `Close an active session before opening another (limit ${maxSessions}).`,
        409,
      );
    if (!sessions.has(id) && sessions.size >= 20)
      throw new WorkerError(
        "PROFILE_LIMIT",
        "The worker has reached its 20 saved-profile limit.",
        409,
      );
    const previous = sessions.get(id);
    const profileDir = join(directory(id), "profile");
    const tempDirectory = join("/tmp", `openmuse-downloads-${id}`);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      const { chromium } = await import("playwright");
      const common = {
        // Chromium does not need the worker API credential in its environment,
        // so only a minimal allowlist is passed through — plus the X display
        // handles, without which a headed browser cannot reach Xvfb.
        env: {
          HOME: process.env.HOME ?? "/tmp",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
          ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
          ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
        },
        // Headed under Xvfb (the Docker image runs via xvfb-run) so sites see
        // a real desktop browser — compositor, media, timers — instead of
        // headless shell. Without an X server (plain local dev) keep headless.
        headless: !process.env.DISPLAY,
        viewport: { width: 1280, height: 800 },
        // A normal Accept-Language instead of the container's bare locale.
        locale: process.env.BROWSER_LOCALE ?? "en-US",
        ...(process.env.BROWSER_TIMEZONE ? { timezoneId: process.env.BROWSER_TIMEZONE } : {}),
        proxy: { server: proxy.url, bypass: "<-loopback>" },
        // Hosts that disable unprivileged user namespaces (Ubuntu 23.10+
        // AppArmor default) cannot start Chromium's sandbox at all; without
        // this every launch fails with "No usable sandbox". The worker keeps
        // its other isolation (egress proxy, no credentials in env, download
        // caps, read-only root + dropped caps in the container image).
        chromiumSandbox: false,
        serviceWorkers: "block" as const,
        acceptDownloads: true,
        downloadsPath: tempDirectory,
        timeout: 25_000,
        args: [
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-extensions",
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        ],
      };

      // Stock Chromium, headed under Xvfb in the Docker image. Branded
      // Chrome was measured phoning home to Google on every launch
      // (variations seed fetch), which conflicts with the worker's
      // no-unexpected-egress posture, so it is deliberately not used; the
      // headed stock build keeps the realism that matters (compositor,
      // media, timers) without the telemetry.
      context = await chromium.launchPersistentContext(profileDir, common);
    } catch {
      if (!previous) await rm(directory(id), { recursive: true, force: true });
      await rm(tempDirectory, { recursive: true, force: true });
      throw new WorkerError(
        "BROWSER_UNAVAILABLE",
        "Chromium could not start. Rebuild the browser-worker image and check its resource limits.",
        503,
      );
    }
    try {
      const statePath = join(directory(id), "storage.json");
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as Awaited<
          ReturnType<BrowserContext["storageState"]>
        >;
        await context.addCookies(state.cookies);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await context.route("**/*", async (route) => {
        try {
          await validatePublicUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      // Reuse the launch page: opening a new tab right after closing the
      // only page fails unreliably, so keep the first and drop extras.
      const existing = context.pages();
      const page = existing[0] ?? (await context.newPage());
      for (const old of existing.slice(1)) await old.close();
      page.setDefaultTimeout(10_000);
      const instance: Running = { context, page, touched: Date.now(), pending: new Set() };
      running.set(id, instance);
      context.on("page", (popup) => {
        void popup.close();
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss();
      });
      page.on("download", (download) => {
        const pending = downloads(id).then((saved) =>
          capturePdfDownload({
            directory: directory(id),
            tempDirectory,
            download,
            limitReached: saved.length + instance.pending.size > 20,
          }),
        );
        instance.pending.add(pending);
        void pending.then(
          () => instance.pending.delete(pending),
          () => {
            instance.downloadError = true;
            instance.pending.delete(pending);
          },
        );
      });
      const initial: Session = {
        id,
        title: previous?.title ?? "New session",
        url,
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      sessions.set(id, initial);
      await persist(initial);
      return await navigate(id, url);
    } catch (error) {
      await context.close().catch(() => {});
      await Promise.allSettled(running.get(id)?.pending ?? []);
      running.delete(id);
      if (previous) {
        const failed: Session = {
          ...previous,
          url,
          status: "error",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, failed);
        await persist(failed);
      } else {
        sessions.delete(id);
        // Cleanup must never mask the original launch failure.
        await rm(directory(id), { recursive: true, force: true }).catch(() => {});
      }
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  const sweeper = setInterval(() => {
    for (const [id, instance] of running)
      if (Date.now() - instance.touched > idleTimeoutMs) {
        void serial(id, () => closeSession(id)).catch(() => {});
      }
  }, 60_000);
  sweeper.unref();
  /** Live screencasts, one hub per session fanning out to every viewer. */
  const streams = new Map<string, StreamHub>();
  function stopStream(id: string) {
    const hub = streams.get(id);
    if (!hub) return;
    streams.delete(id);
    hub.clients.clear();
    const cdp = hub.cdp;
    hub.cdp = null;
    if (cdp) {
      cdp.removeAllListeners("Page.screencastFrame");
      void cdp.send("Page.stopScreencast").catch(() => {});
    }
    // Viewers hanging on a dead screencast must reconnect, not freeze.
    for (const abort of hub.aborts) {
      try {
        abort();
      } catch {
        /* Client already gone. */
      }
    }
    hub.aborts.clear();
  }
  async function subscribe(
    id: string,
    onFrame: (frame: Buffer) => void,
    onAbort: () => void = () => {},
  ): Promise<() => void> {
    const instance = active(id);
    let hub = streams.get(id);
    if (!hub) {
      hub = { clients: new Set(), aborts: new Set(), cdp: null, starting: null };
      streams.set(id, hub);
    }
    hub.clients.add(onFrame);
    hub.aborts.add(onAbort);
    if (!hub.cdp && !hub.starting) {
      const current = hub;
      current.starting = (async () => {
        const cdp = (await instance.page
          .context()
          .newCDPSession(instance.page)) as unknown as ScreencastSession;
        cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
          void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
          const frame = Buffer.from(data, "base64");
          instance.touched = Date.now();
          for (const send of current.clients) {
            try {
              send(frame);
            } catch {
              /* A slow viewer must not break the stream for the rest. */
            }
          }
        });
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 65,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 1,
        });
        // The session may have closed while the screencast was starting.
        if (!streams.get(id) || !current.clients.size) {
          cdp.removeAllListeners("Page.screencastFrame");
          await cdp.send("Page.stopScreencast").catch(() => {});
          await cdp.detach().catch(() => {});
          throw new WorkerError("SESSION_CLOSED", "Browser session closed.", 409);
        }
        current.cdp = cdp;
      })();
      try {
        await current.starting;
      } catch (error) {
        if (streams.get(id) === current && !current.cdp) streams.delete(id);
        current.clients.delete(onFrame);
        current.aborts.delete(onAbort);
        throw error;
      } finally {
        current.starting = null;
      }
    } else if (hub.starting) {
      try {
        await hub.starting;
      } catch (error) {
        hub.clients.delete(onFrame);
        hub.aborts.delete(onAbort);
        throw error;
      }
      if (!hub.cdp) {
        hub.clients.delete(onFrame);
        hub.aborts.delete(onAbort);
        throw new WorkerError("SESSION_CLOSED", "Browser session closed.", 409);
      }
    }
    instance.touched = Date.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      hub?.clients.delete(onFrame);
      hub?.aborts.delete(onAbort);
      if (hub && hub.clients.size === 0 && !hub.starting) stopStream(id);
    };
  }
  return {
    list: () => [...sessions.values()],
    create: (id: string, url: string) =>
      serial("create", () => serial(id, () => createSession(id, url))),
    navigate: (id: string, url: string) => serial(id, () => navigate(id, url)),
    closeSession: (id: string) => serial(id, () => closeSession(id)),
    screenshot: (id: string) =>
      serial(id, () => active(id).page.screenshot({ type: "png", timeout: 10_000 })),
    subscribe,
    /**
     * Hover pointer fast path: outside the serial queue so cursor moves stay
     * live instead of lining up behind clicks and scrolls. Held-drag moves
     * keep using input() so down/move/up stay ordered.
     */
    move: (id: string, input: Record<string, unknown>) => {
      const point = validPoint(input);
      if (!point) throw new WorkerError("INVALID_INPUT", "Unsupported browser input or coordinates.");
      const { page } = active(id);
      return page.mouse.move(point.x, point.y);
    },
    read: (id: string) =>
      serial(id, async () => {
        const { page } = active(id);
        await validatePublicUrl(page.url());
        // Evaluation is fixed by the worker; callers cannot inject JavaScript.
        const result = await page.evaluate(() => {
          const text = document.body?.innerText ?? "";
          return {
            url: location.href,
            title: document.title.slice(0, 300),
            text: text.slice(0, 100_000),
            truncated: text.length > 100_000,
          };
        });
        await validatePublicUrl(result.url);
        // A block page reads as ordinary text; refuse it instead of reporting
        // vendor boilerplate ("Forbidden …") as page content.
        const refused = botBlockError(
          new URL(result.url).hostname,
          null,
          result.title,
          result.text.slice(0, 4000),
        );
        if (refused) throw refused;
        const session: Session = {
          id,
          url: result.url,
          title: result.title,
          status: "active",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, session);
        await persist(session);
        return result;
      }),
    input: (id: string, input: Record<string, unknown>) =>
      serial(id, async () => {
        const { page } = active(id);
        const { type, key, text, deltaY } = input;
        const point = validPoint(input);
        if (type === "click" && point) await page.mouse.click(point.x, point.y);
        // Press-and-hold primitives for human checks ("Robot or human?" hold
        // buttons). Only the takeover console sends these, with the user's
        // own timing between down and up — the agent never auto-holds.
        else if (type === "down" && point) {
          await page.mouse.move(point.x, point.y, { steps: 5 });
          await page.mouse.down();
        } else if (type === "move" && point) {
          // Drag repositioning while held, or hover positioning. Throttled
          // client-side; each step is a genuine user pointer event.
          await page.mouse.move(point.x, point.y, { steps: 3 });
        } else if (type === "up") await page.mouse.up();
        else if (type === "text" && typeof text === "string" && text.length <= 10_000)
          await page.keyboard.insertText(text);
        else if (
          type === "key" &&
          typeof key === "string" &&
          /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Control\+a|Meta\+a|Shift\+Tab)$/.test(
            key,
          )
        )
          await page.keyboard.press(key);
        else if (
          type === "scroll" &&
          typeof deltaY === "number" &&
          Number.isFinite(deltaY) &&
          Math.abs(deltaY) <= 5000
        )
          await page.mouse.wheel(0, deltaY);
        else throw new WorkerError("INVALID_INPUT", "Unsupported browser input or coordinates.");
        return refresh(id);
      }),
    downloads: async (id: string) => {
      const saved = await downloads(id);
      if (running.get(id)?.downloadError)
        throw new WorkerError(
          "DOWNLOAD_STORE_FAILED",
          "A download outcome could not be saved. Check worker storage and try again.",
          500,
        );
      return { downloads: saved, failures: await readDownloadFailures(directory(id)) };
    },
    download: async (id: string, downloadId: string) => {
      validateSessionId(downloadId);
      const metadata = (await downloads(id)).find((item) => item.id === downloadId);
      if (!metadata) throw new WorkerError("DOWNLOAD_NOT_FOUND", "PDF download not found.", 404);
      const path = join(directory(id), "downloads", `${downloadId}.pdf`);
      const info = await stat(path);
      if (info.size > MAX_DOWNLOAD_BYTES)
        throw new WorkerError("DOWNLOAD_TOO_LARGE", "The PDF exceeds 10 MiB.", 413);
      return { metadata, bytes: await readFile(path) };
    },
    close: async () => {
      clearInterval(sweeper);
      await Promise.allSettled([...queues.values()]);
      await Promise.allSettled([...running.keys()].map(closeSession));
      await proxy.close();
    },
  };
}
