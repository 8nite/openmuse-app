import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import type { Auth } from "./auth.ts";
import { browserConsole } from "./browser-console.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

/** Neutral page standby browsers wait on: public, tiny, fast, cookie-free. */
export const STANDBY_URL = "https://example.com/";

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
});
const readSchema = z.object({
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
type ChatBrowser = { id: string; sessionId: string };

const BROWSER_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSessionId(id: string): void {
  if (!BROWSER_SESSION_ID.test(id)) throw new AppError("Browser session not found", 404);
}

export class BrowserService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private health?: { checkedAt: number; reachable: Promise<boolean> };
  /** Pre-warmed worker session ids with no owner yet, ready for instant handoff. */
  private readonly standby = new Set<string>();
  private fillTask: Promise<void> | null = null;
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly files: Files,
    private readonly now: () => number = Date.now,
  ) {}
  private standbyTarget(): number {
    return this.config.standbySessions ?? 1;
  }
  /**
   * Fill the standby pool: live browsers on a neutral page, handed out by the
   * next create() so opening skips the Chromium launch. Best-effort — any
   * worker failure just leaves the pool empty and create() launches normally.
   */
  async warmStandby(): Promise<void> {
    await this.fillStandby();
  }
  /** Pooled session ids (read-only copy, for tests and ops). */
  standbyIds(): string[] {
    return [...this.standby];
  }
  private fillStandby(): Promise<void> {
    // Concurrent callers share one fill: a second warmup while the boot
    // warmup is still launching waits for it instead of skipping the pool.
    if (!this.fillTask) {
      this.fillTask = this.fillOwned().finally(() => {
        this.fillTask = null;
      });
    }
    return this.fillTask;
  }
  private async fillOwned(): Promise<void> {
    while (this.standby.size < this.standbyTarget()) {
      if (!this.config.workerUrl || !this.config.workerToken) return;
      const id = randomUUID();
      try {
        await this.request("/sessions", { id, url: STANDBY_URL }, undefined, 120_000);
      } catch {
        return;
      }
      this.standby.add(id);
    }
  }
  /** Whether the configured worker answers its health check, cached briefly for snapshots. */
  reachable(): Promise<boolean> {
    if (!this.config.workerUrl || !this.config.workerToken) return Promise.resolve(false);
    const now = this.now();
    if (this.health && now - this.health.checkedAt < 15_000) return this.health.reachable;
    const reachable = fetch(`${this.config.workerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    this.health = { checkedAt: now, reachable };
    return reachable;
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 45_000) {
    signal?.throwIfAborted();
    if (!this.config.workerUrl || !this.config.workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    let response: Response;
    // timeoutMs 0 means no client-side timeout: long-lived streams end when
    // the caller's signal aborts (viewer disconnect).
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined =
      signal && timeout
        ? AbortSignal.any([signal, timeout])
        : (signal ?? timeout);
    try {
      response = await fetch(`${this.config.workerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.workerToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(
        "Browser worker is unavailable. Check that its container is running.",
        503,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new AppError(
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "Browser request failed",
        502,
      );
    }
    return response;
  }
  async get(owner: string, id: string) {
    assertSessionId(id);
    const value = await this.db.get<BrowserSession>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: BrowserSession) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
      streamUrl: this.auth.sign(owner, `/api/browsers/${session.id}/stream`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Browser worker returned a different session", 502);
    await this.db.put(owner, "browsers", session);
    return this.decorate(owner, session);
  }
  async create(owner: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Hand out a pre-warmed standby session when one is ready: its browser is
    // already running, so opening skips the Chromium launch entirely. Stale
    // ids (worker restart, idle sweep) fall through to a normal launch.
    for (const id of this.standby) {
      this.standby.delete(id);
      try {
        const session = await this.adopt(owner, id, url, signal);
        void this.fillStandby();
        return session;
      } catch {
        // Aborted turns still surface below via the fresh launch path.
        signal?.throwIfAborted();
      }
    }
    const session = await this.adopt(owner, randomUUID(), url, signal);
    void this.fillStandby();
    return session;
  }
  private async adopt(owner: string, id: string, url: string, signal?: AbortSignal) {
    // Record ownership before calling the worker, including when its response is lost.
    await this.db.put(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.reopen(owner, id, url, signal);
  }
  private async openOwned(owner: string, id: string, url?: string, signal?: AbortSignal) {
    const value = await this.get(owner, id);
    const target = url ?? value.url;
    try {
      // Opening a session launches Chromium (up to 25s) then navigates (up to
      // 45s), so this path gets a longer budget than quick reads and inputs.
      const response = await this.request("/sessions", { id, url: target }, signal, 120_000);
      return await this.save(owner, await response.json(), id);
    } catch (error) {
      signal?.throwIfAborted();
      await this.save(
        owner,
        { ...value, url: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }
  reopen(owner: string, id: string, url?: string, signal?: AbortSignal) {
    return this.serial(id, () => this.openOwned(owner, id, url, signal));
  }
  navigate(owner: string, id: string, url: string) {
    return this.reopen(owner, id, url);
  }
  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = readSchema.parse(
      await (
        await this.request(`/sessions/${encodeURIComponent(id)}/read`, undefined, signal)
      ).json(),
    );
    await this.save(
      owner,
      {
        ...session,
        url: result.url,
        title: result.title,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
      id,
    );
    return result;
  }
  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }
  async observe(owner: string, url: string, existingId?: string, signal?: AbortSignal) {
    const id = existingId ?? (await this.create(owner, url, signal)).id;
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      if (existingId) await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      return { sessionId: id, ...(await this.readOwned(owner, id, signal)) };
    });
  }
  async observeForThread(owner: string, threadId: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Fast path: a brand-new chat thread claims a pre-warmed standby session
    // so the first chat browse skips the Chromium launch, just like create().
    // Existing threads keep their pinned profile; stale ids fall through to a
    // normal launch inside openOwned.
    let association = await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId);
    if (!association) {
      for (const pooledId of [...this.standby]) {
        this.standby.delete(pooledId);
        const claimed =
          (await this.db.insertIfAbsent(owner, "chat-browsers", {
            id: threadId,
            sessionId: pooledId,
          })) ?? (await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId));
        if (!claimed) continue;
        if (claimed.sessionId !== pooledId) {
          // Lost the thread race after popping a pooled id: hand it back.
          this.standby.add(pooledId);
        }
        association = claimed;
        break;
      }
      association ??=
        (await this.db.insertIfAbsent(owner, "chat-browsers", {
          id: threadId,
          sessionId: randomUUID(),
        })) ?? (await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId));
      // Refill in the background whether we handed out a pooled browser or
      // launched fresh with an empty pool, mirroring create().
      if (association) void this.fillStandby();
    }
    if (!association) throw new AppError("Could not reserve the chat browser session", 500);
    const id = association.sessionId;
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      // A failed open leaves no live browser behind, so its error carries no
      // session id. A failed read does: the session is still alive on the
      // worker (e.g. sitting on an anti-bot challenge page). Carry its id so
      // the client can offer Take control instead of a dead-end error.
      await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      try {
        const page = await this.readOwned(owner, id, signal);
        signal?.throwIfAborted();
        return {
          sessionId: id,
          ...page,
          text: page.text.slice(0, 30_000),
          truncated: page.truncated || page.text.length > 30_000,
        };
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          browserSessionId: id,
        });
      }
    });
  }
  async close(owner: string, id: string) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(
        owner,
        await (await this.request(`/sessions/${encodeURIComponent(id)}/close`, {})).json(),
        id,
      );
    });
  }
  async preview(owner: string, id: string) {
    await this.get(owner, id);
    return this.request(`/sessions/${encodeURIComponent(id)}/screenshot`);
  }
  /** Long-lived MJPEG screencast; ends when signal aborts (viewer disconnect). */
  async stream(owner: string, id: string, signal?: AbortSignal) {
    await this.get(owner, id);
    return this.request(`/sessions/${encodeURIComponent(id)}/stream`, undefined, signal, 0);
  }
  /** Hover pointer fast path: no serial queue, no session save — cursor stays live. */
  async move(owner: string, id: string, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError("A JSON object is required for browser input", 422);
    await this.get(owner, id);
    return (await this.request(`/sessions/${encodeURIComponent(id)}/move`, value)).json();
  }
  async input(owner: string, id: string, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError("A JSON object is required for browser input", 422);
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(
        owner,
        await (await this.request(`/sessions/${encodeURIComponent(id)}/input`, value)).json(),
        id,
      );
    });
  }
  async imports(owner: string, id: string) {
    return this.serial(id, () => this.importsOwned(owner, id));
  }
  private async importsOwned(owner: string, id: string) {
    await this.get(owner, id);
    const { downloads, failures } = z
      .object({
        downloads: z.array(
          z.object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() }),
        ),
        failures: z.array(failureSchema),
      })
      .parse(await (await this.request(`/sessions/${encodeURIComponent(id)}/downloads`)).json());
    const saved = [];
    for (const download of downloads) {
      const existing = await this.db.get<{ fileId: string }>(
        owner,
        "browser-downloads",
        download.id,
      );
      if (existing) {
        saved.push(this.files.signed(owner, await this.files.get(owner, existing.fileId)));
        continue;
      }
      const response = await this.request(
        `/sessions/${encodeURIComponent(id)}/downloads/${encodeURIComponent(download.id)}`,
      );
      const file = await this.files.import(
        owner,
        download.name,
        new Uint8Array(await response.arrayBuffer()),
        `Browser · ${id}`,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/stream`));
  }
}
