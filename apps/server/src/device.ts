import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { type DeviceSession, deviceInputSchema } from "../../../packages/domain/src/index.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { deviceConsole } from "./device-console.ts";
import type { DeviceRelay } from "./device-relay.ts";
import { AppError } from "./errors.ts";

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  packageOrUrl: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
});
const uidumpSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  nodes: z.unknown().optional(),
  text: z.string().max(100_000).optional(),
  mediaState: z.string().max(200).optional(),
  truncated: z.boolean().optional(),
});

const DEVICE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSessionId(id: string): void {
  if (!DEVICE_SESSION_ID.test(id)) throw new AppError("Phone session not found", 404);
}

const inputSchema = deviceInputSchema;

function assertIntentUri(intentUri: string): string {
  const input = intentUri.trim();
  if (!input || /\s/.test(input)) throw new AppError("Enter a link or app address to open", 422);
  const lower = input.toLowerCase();
  if (lower.startsWith("vnd.youtube:")) {
    if (!/^vnd\.youtube:[A-Za-z0-9_-]{1,64}$/.test(input))
      throw new AppError("Enter a YouTube link or video id, like vnd.youtube:dQw4w9WgXcQ", 422);
    return input;
  }
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Invalid address");
    return url.href;
  } catch {
    throw new AppError("Enter a link like https://example.com or vnd.youtube:<id>", 422);
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type ChatDevice = { id: string; sessionId: string };

export class DeviceService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private health?: { checkedAt: number; reachable: Promise<boolean> };
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly now: () => number = Date.now,
    private readonly relay?: DeviceRelay,
  ) {}

  ensureEnabled() {
    if (!this.config.deviceEnabled)
      throw new AppError(
        "Phone worker is not enabled. Set DEVICE_ENABLED=true to connect a phone.",
        404,
      );
  }

  relayConnected(owner: string) {
    return this.relay?.connected(owner) ?? false;
  }

  reachable(): Promise<boolean> {
    if (!this.config.deviceEnabled) return Promise.resolve(false);
    const now = this.now();
    if (this.health && now - this.health.checkedAt < 15_000) return this.health.reachable;
    // A paired relay counts as reachable without probing HTTP.
    // The check below resolves synchronously per owner; the cached probe covers HTTP fallback.
    const reachable = (async () => {
      if (!this.config.deviceWorkerUrl || !this.config.workerToken) return false;
      try {
        const response = await fetch(`${this.config.deviceWorkerUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.ok;
      } catch {
        return false;
      }
    })();
    this.health = { checkedAt: now, reachable };
    return reachable;
  }

  reachableFor(owner: string): Promise<boolean> {
    if (!this.config.deviceEnabled) return Promise.resolve(false);
    if (this.relayConnected(owner)) return Promise.resolve(true);
    return this.reachable();
  }

  /**
   * Dual transport: the paired WS relay is primary; the HTTP worker URL is the
   * local-ADB fallback when no relay is attached for the owner.
   */
  private async transport(
    owner: string,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; bytes: Uint8Array }> {
    signal?.throwIfAborted();
    if (!this.config.deviceEnabled)
      throw new AppError(
        "Phone worker is not enabled. Set DEVICE_ENABLED=true to connect a phone.",
        404,
      );
    const relayed = await this.relay?.relayed(owner, method, path, body, signal);
    if (relayed) return relayed;
    if (!this.config.deviceWorkerUrl || !this.config.workerToken)
      throw new AppError(
        "Phone worker is not connected. Pair a phone or set DEVICE_WORKER_URL for local development.",
        503,
      );
    let response: Response;
    try {
      response = await fetch(`${this.config.deviceWorkerUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.workerToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(
        "Phone worker is unavailable. Check that the paired phone or DEVICE_WORKER_URL is reachable.",
        503,
      );
    }
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  private async requestJson(owner: string, path: string, body?: unknown, signal?: AbortSignal) {
    const { status, bytes } = await this.transport(
      owner,
      body === undefined ? "GET" : "POST",
      path,
      body,
      signal,
    );
    if (status < 200 || status >= 300) {
      let message = "Phone request failed";
      try {
        const payload = JSON.parse(Buffer.from(bytes).toString("utf8"));
        if (typeof payload?.error?.message === "string") message = payload.error.message;
      } catch {
        /* keep the default */
      }
      throw new AppError(message, 502);
    }
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new AppError("Phone worker returned an unreadable response", 502);
    }
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return next as Promise<T>;
    } finally {
      // cleanup after settle without awaiting here
      void (next as Promise<unknown>)
        .catch(() => {})
        .then(() => {
          if (this.queues.get(id) === next) this.queues.delete(id);
        });
    }
  }

  /** Issue a single-use pairing code. The full code shows once; only its hash is stored. */
  async pair(owner: string) {
    this.ensureEnabled();
    const code = `ot-pair-${randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + 10 * 60 * 1000;
    await this.db.put(owner, "device-pairs", {
      id: hash(code),
      prefix: `${code.slice(0, 12)}…`,
      expiresAt,
      used: false,
      createdAt: new Date(this.now()).toISOString(),
    });
    this.relay?.trackPair(hash(code), owner, expiresAt);
    return { code, prefix: `${code.slice(0, 12)}…`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Exchange a single-use pairing code for a persistent device token (APK register path). */
  async register(code: string, owner: string) {
    this.ensureEnabled();
    const trimmed = code.trim();
    if (!trimmed.startsWith("ot-pair-")) throw new AppError("Pairing code is invalid", 401);
    const record = await this.db.get<{ expiresAt: number; used: boolean }>(
      owner,
      "device-pairs",
      hash(trimmed),
    );
    if (!record || record.used || record.expiresAt < this.now())
      throw new AppError("Pairing code expired. Create a new one in OpenMuse.", 401);
    await this.db.put(owner, "device-pairs", { id: hash(trimmed), ...record, used: true });
    const token = `ot-dev-${randomBytes(24).toString("hex")}`;
    await this.db.put(owner, "device-tokens", {
      id: hash(token),
      prefix: `${token.slice(0, 12)}…`,
      createdAt: new Date(this.now()).toISOString(),
    });
    this.relay?.trackToken(hash(token), owner);
    this.health = undefined;
    return { token, prefix: `${token.slice(0, 12)}…` };
  }

  /**
   * Resolve the owner of a pairing code presented on the WS upgrade. The code
   * is consumed here so a second dial cannot reuse it; register() then marks
   * the stored record used and issues the persistent token.
   */
  consumePairCode(code: string): string | null {
    const trimmed = code.trim();
    if (!trimmed.startsWith("ot-pair-")) return null;
    return this.relay?.consumePair(hash(trimmed)) ?? null;
  }

  ownerForDeviceToken(token: string): string | null {
    const trimmed = token.trim();
    if (!trimmed.startsWith("ot-dev-")) return null;
    return this.relay?.ownerForToken(hash(trimmed)) ?? null;
  }

  async get(owner: string, id: string) {
    assertSessionId(id);
    const value = await this.db.get<DeviceSession>(owner, "devices", id);
    if (!value) throw new AppError("Phone session not found", 404);
    return value;
  }

  decorate(owner: string, session: DeviceSession) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/devices/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/devices/${session.id}/preview`),
    };
  }

  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Phone worker returned a different session", 502);
    await this.db.put(owner, "devices", session);
    return this.decorate(owner, session);
  }

  async create(owner: string, packageOrUrl: string, signal?: AbortSignal) {
    this.ensureEnabled();
    const target = assertIntentUri(packageOrUrl);
    const id = randomUUID();
    await this.db.put(owner, "devices", {
      id,
      title: "New phone session",
      packageOrUrl: target,
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.serial(id, () => this.openOwned(owner, id, target, signal));
  }

  private async openOwned(owner: string, id: string, packageOrUrl?: string, signal?: AbortSignal) {
    const value = await this.get(owner, id);
    const target = packageOrUrl ?? value.packageOrUrl;
    try {
      const payload = await this.requestJson(owner, "/sessions", { id, intentUri: target }, signal);
      return await this.save(owner, payload, id);
    } catch (error) {
      signal?.throwIfAborted();
      await this.save(
        owner,
        { ...value, packageOrUrl: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }

  launch(owner: string, id: string, intentUri: string) {
    this.ensureEnabled();
    const target = assertIntentUri(intentUri);
    return this.serial(id, () => this.launchOwned(owner, id, target));
  }

  private async launchOwned(owner: string, id: string, intentUri: string) {
    await this.get(owner, id);
    const payload = await this.requestJson(owner, `/sessions/${encodeURIComponent(id)}/launch`, {
      intentUri,
    });
    return this.save(owner, payload, id);
  }

  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = uidumpSchema.parse(
      await this.requestJson(
        owner,
        `/sessions/${encodeURIComponent(id)}/uidump`,
        undefined,
        signal,
      ),
    );
    await this.save(
      owner,
      { ...session, status: "active", updatedAt: new Date().toISOString() },
      id,
    );
    return result;
  }

  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }

  /**
   * Read-only observation for agent and chat tools. Resolves the session from
   * an explicit id, or launches the given link/app, and returns the screen
   * state with a bounded uidump excerpt plus the media state.
   */
  async observe(
    owner: string,
    options: { sessionId?: string; intentUri?: string },
    signal?: AbortSignal,
  ) {
    this.ensureEnabled();
    let id = options.sessionId;
    if (id) {
      await this.get(owner, id);
    } else if (options.intentUri) {
      id = (await this.create(owner, options.intentUri, signal)).id;
    } else {
      throw new AppError("Open the phone on a link or app first, or pass its sessionId", 422);
    }
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      const session = await this.get(owner, id);
      const seen = uidumpSchema.parse(
        await this.requestJson(
          owner,
          `/sessions/${encodeURIComponent(id)}/uidump`,
          undefined,
          signal,
        ),
      );
      await this.save(
        owner,
        { ...session, status: "active", updatedAt: new Date().toISOString() },
        id,
      );
      const text = seen.text ?? "";
      return {
        sessionId: id,
        title: session.title,
        packageOrUrl: session.packageOrUrl,
        text: text.slice(0, 30_000),
        mediaState: seen.mediaState,
        truncated: seen.truncated || text.length > 30_000,
      };
    });
  }

  /**
   * Per-chat-thread phone session, mirroring the browser chat association:
   * the first observe with a link opens the thread's session, later turns
   * reuse it until the user opens something else.
   */
  async observeForThread(
    owner: string,
    threadId: string,
    intentUri?: string,
    signal?: AbortSignal,
  ) {
    this.ensureEnabled();
    signal?.throwIfAborted();
    const association =
      (await this.db.get<ChatDevice>(owner, "chat-devices", threadId)) ??
      (await this.db.insertIfAbsent(owner, "chat-devices", {
        id: threadId,
        sessionId: randomUUID(),
      })) ??
      (await this.db.get<ChatDevice>(owner, "chat-devices", threadId));
    if (!association) throw new AppError("Could not reserve the chat phone session", 500);
    const id = association.sessionId;
    await this.db.insertIfAbsent(owner, "devices", {
      id,
      title: "New phone session",
      packageOrUrl: intentUri ?? "",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      if (intentUri) await this.openOwned(owner, id, assertIntentUri(intentUri), signal);
      else {
        const current = await this.get(owner, id);
        if (current.status === "idle")
          throw new AppError("Say which app or link to open on the phone first", 422);
      }
      signal?.throwIfAborted();
      const session = await this.get(owner, id);
      const seen = uidumpSchema.parse(
        await this.requestJson(
          owner,
          `/sessions/${encodeURIComponent(id)}/uidump`,
          undefined,
          signal,
        ),
      );
      await this.save(
        owner,
        { ...session, status: "active", updatedAt: new Date().toISOString() },
        id,
      );
      const text = seen.text ?? "";
      return {
        sessionId: id,
        title: session.title,
        packageOrUrl: session.packageOrUrl,
        text: text.slice(0, 30_000),
        mediaState: seen.mediaState,
        truncated: seen.truncated || text.length > 30_000,
      };
    });
  }

  async close(owner: string, id: string) {
    this.ensureEnabled();
    return this.serial(id, async () => {
      await this.get(owner, id);
      const payload = await this.requestJson(
        owner,
        `/sessions/${encodeURIComponent(id)}/close`,
        {},
      );
      return this.save(owner, payload, id);
    });
  }

  async preview(owner: string, id: string) {
    await this.get(owner, id);
    const { status, bytes } = await this.transport(
      owner,
      "GET",
      `/sessions/${encodeURIComponent(id)}/screenshot`,
      undefined,
    );
    if (status < 200 || status >= 300) throw new AppError("Phone screenshot is unavailable", 502);
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "image/png" } });
  }

  async input(owner: string, id: string, value: unknown) {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) throw new AppError("A valid phone input object is required", 422);
    return this.serial(id, async () => {
      await this.get(owner, id);
      const payload = await this.requestJson(
        owner,
        `/sessions/${encodeURIComponent(id)}/input`,
        parsed.data,
      );
      return this.save(owner, payload, id);
    });
  }

  console(owner: string, id: string) {
    return deviceConsole(this.auth.sign(owner, `/api/devices/${id}/preview`));
  }
}
