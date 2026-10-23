import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { AppError } from "./errors.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Largest inbound message the relay reassembles; phone screenshots travel base64'd. */
const MAX_MESSAGE = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;

/** Minimal server-side socket over an accepted upgrade. Text frames carry JSON. */
export interface RelaySocket {
  send(text: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  readonly open: boolean;
}

function frameControl(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

function frameText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  if (payload.length > 0xffff) {
    const big = Buffer.alloc(10);
    big[0] = 0x81;
    big[1] = 127;
    big.writeUInt32BE(0, 2);
    big.writeUInt32BE(payload.length, 6);
    return Buffer.concat([big, payload]);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Complete the opening handshake and return a framed socket. The caller routes
 * inbound text to onMessage and detaches on onClose. No dependency on `ws`.
 */
export function acceptRelaySocket(
  socket: Duplex,
  key: string,
  onMessage: (text: string) => void,
  onClose: () => void,
  head: Buffer = Buffer.alloc(0),
): RelaySocket {
  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let closed = false;
  const api: RelaySocket = {
    send: (text) => {
      if (!closed) socket.write(frameText(text));
    },
    ping: () => {
      if (!closed) socket.write(frameControl(0x9));
    },
    close: (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      try {
        const payload = Buffer.concat([
          Buffer.from([(code >> 8) & 0xff, code & 0xff]),
          Buffer.from(reason, "utf8"),
        ]);
        socket.write(frameControl(0x8, payload));
      } catch {
        /* closing anyway */
      }
      socket.destroy();
    },
    get open() {
      return !closed && !socket.destroyed;
    },
  };
  const fail = (code: number, reason: string) => {
    console.log(`[device-relay] frame error code=${code} reason=${reason}`);
    try {
      api.close(code, reason);
    } finally {
      onClose();
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE + 16)
      return fail(
        1009,
        `message too large (buffered ${buffer.length} bytes before a full frame parsed)`,
      );
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const high = buffer.readUInt32BE(2);
        const low = buffer.readUInt32BE(6);
        if (high !== 0 || low > MAX_MESSAGE)
          return fail(
            1009,
            `message too large (high=${high} low=${low} head=${buffer.subarray(0, 24).toString("hex")})`,
          );
        length = low;
        offset = 10;
      }
      if (!masked) return fail(1002, "client frames must be masked");
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = buffer.subarray(offset + 4, offset + 4 + length);
      buffer = buffer.subarray(offset + 4 + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) {
        closed = true;
        try {
          socket.destroy();
        } finally {
          onClose();
        }
        return;
      }
      if (opcode === 0x9) {
        if (api.open) socket.write(frameControl(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        fragments.push(payload);
        if (!fin) continue;
        const message = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        if (message.length > MAX_MESSAGE) return fail(1009, "message too large");
        try {
          onMessage(message);
        } catch {
          return fail(1011, "handler failed");
        }
        continue;
      }
      return fail(1003, "unsupported opcode");
    }
  });
  socket.on("error", (error: unknown) => {
    console.log(
      `[device-relay] socket error: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  socket.on("close", () => {
    console.log("[device-relay] socket closed by peer");
    if (!closed) {
      closed = true;
      onClose();
    }
  });
  return api;
}

interface PendingRequest {
  owner: string;
  resolve: (value: { status: number; bytes: Uint8Array }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Adopt a WS upgrade for /api/devices/register. Resolves the owner from
 * `?code=ot-pair-*` (consumed once, exchanged for a persistent token sent back
 * over the socket) or `?token=ot-dev-*` (reconnect). Returns true when the
 * socket was adopted; the caller destroys anything else.
 */
export async function acceptDeviceUpgrade(
  req: { url?: string; headers: Record<string, string | string[] | undefined> },
  socket: Duplex,
  head: Buffer,
  device: {
    consumePairCode(code: string): string | null;
    register(code: string, owner: string): Promise<{ token: string; prefix: string }>;
    ownerForDeviceToken(token: string): string | null;
  },
  relay: DeviceRelay,
  enabled: boolean,
): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://localhost");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/api/devices/register" || !enabled || typeof key !== "string") {
    return false;
  }
  const params = url.searchParams;
  const code = params.get("code");
  const token = params.get("token");
  let owner: string | null = null;
  let issued: { token: string; prefix: string } | null = null;
  try {
    if (code) {
      // Consume first so a second dial cannot reuse the code; register() marks
      // the stored record used and issues the persistent token.
      owner = device.consumePairCode(code);
      if (owner) issued = await device.register(code, owner);
    } else if (token) {
      owner = device.ownerForDeviceToken(token);
    }
  } catch {
    owner = null;
  }
  if (!owner) return false;
  const resolved = owner;
  const api = acceptRelaySocket(
    socket,
    key,
    (text) => relay.receive(resolved, api, text),
    () => relay.detach(resolved, api, "socket-close"),
    head,
  );
  relay.attach(resolved, api);
  api.send(
    JSON.stringify(
      issued
        ? { type: "registered", token: issued.token, prefix: issued.prefix }
        : { type: "hello", resumed: true },
    ),
  );
  return true;
}

/**
 * Paired-phone relay. The APK dials outbound `wss://<host>/api/devices/register`
 * so no inbound port reaches the phone; the server multiplexes
 * `{type:"request"|"response"|"ping"|"pong"}` frames over each socket.
 * Pairing codes and device tokens stay SHA-256 hashed; code→owner and
 * token→owner bindings live in memory (a restart requires re-pairing).
 */
export class DeviceRelay {
  private readonly pairs = new Map<string, { owner: string; expiresAt: number }>();
  private readonly tokens = new Map<string, string>();
  private readonly sockets = new Map<string, Set<RelaySocket>>();
  private readonly alive = new Map<RelaySocket, number>();
  private readonly pending = new Map<string, PendingRequest>();
  private sweep?: ReturnType<typeof setInterval>;
  constructor(private readonly now: () => number = Date.now) {}

  /** Track a pairing code so the WS upgrade can resolve its owner. */
  trackPair(codeHash: string, owner: string, expiresAt: number) {
    this.pairs.set(codeHash, { owner, expiresAt });
  }

  /** Resolve and consume a pairing code presented on the WS upgrade. */
  consumePair(codeHash: string): string | null {
    const entry = this.pairs.get(codeHash);
    if (!entry) return null;
    this.pairs.delete(codeHash);
    if (entry.expiresAt < this.now()) return null;
    return entry.owner;
  }

  /** Track an issued device token so reconnects resolve their owner. */
  trackToken(tokenHash: string, owner: string) {
    this.tokens.set(tokenHash, owner);
  }

  ownerForToken(tokenHash: string): string | null {
    return this.tokens.get(tokenHash) ?? null;
  }

  attach(owner: string, socket: RelaySocket) {
    let set = this.sockets.get(owner);
    if (!set) {
      set = new Set();
      this.sockets.set(owner, set);
    }
    // Prune dead sockets so a half-open predecessor never shadows the live one.
    for (const existing of [...set]) {
      if (existing === socket || !existing.open) {
        if (existing !== socket) this.alive.delete(existing);
        set.delete(existing);
      }
    }
    set.add(socket);
    this.alive.set(socket, this.now());
    this.startSweep();
    console.log(`[device-relay] attach owner=${owner} sockets=${set.size}`);
  }

  detach(owner: string, socket: RelaySocket, reason = "close") {
    this.sockets.get(owner)?.delete(socket);
    if (this.sockets.get(owner)?.size === 0) this.sockets.delete(owner);
    this.alive.delete(socket);
    console.log(`[device-relay] detach owner=${owner} reason=${reason}`);
    for (const [id, request] of this.pending) {
      if (request.owner !== owner) continue;
      this.pending.delete(id);
      clearTimeout(request.timer);
      request.reject(new AppError("Phone disconnected while the request was in flight", 503));
    }
    if (this.sockets.size === 0) this.stopSweep();
  }

  connected(owner: string): boolean {
    return [...(this.sockets.get(owner) ?? [])].some((socket) => socket.open);
  }

  /** Route an inbound text frame from an attached socket. */
  receive(owner: string, socket: RelaySocket, raw: string) {
    this.alive.set(socket, this.now());
    let message: {
      type?: string;
      id?: string;
      status?: number;
      bodyB64?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", id: message.id ?? randomUUID() }));
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const request = this.pending.get(message.id);
    if (!request || request.owner !== owner) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    const bytes =
      typeof message.bodyB64 === "string"
        ? new Uint8Array(Buffer.from(message.bodyB64, "base64"))
        : new Uint8Array();
    request.resolve({ status: typeof message.status === "number" ? message.status : 200, bytes });
  }

  /**
   * Send a request over the owner's relay. Returns null when no socket is
   * attached so the caller falls back to HTTP. Responses carry raw bytes;
   * the caller parses JSON or wraps PNG exactly like the HTTP path.
   */
  relayed(
    owner: string,
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; bytes: Uint8Array } | null> {
    signal?.throwIfAborted();
    // Prefer the most recently attached socket: after an app reinstall the old
    // socket can look open until the sweep proves it dead.
    const candidates = [...(this.sockets.get(owner) ?? [])].reverse();
    const socket = candidates.find((candidate) => candidate.open);
    if (!socket) {
      return Promise.resolve(null);
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError("Phone worker did not answer in time", 503));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { owner, resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
        },
        { once: true },
      );
      try {
        socket.send(
          JSON.stringify({
            type: "request",
            id,
            method,
            path,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Phone relay send failed"));
      }
    });
  }

  private startSweep() {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      const cutoff = this.now() - 75_000;
      for (const [owner, set] of this.sockets) {
        for (const socket of set) {
          if ((this.alive.get(socket) ?? 0) < cutoff || !socket.open) {
            try {
              socket.close(4004, "no pong");
            } catch {
              /* detached below */
            }
            this.detach(owner, socket, "idle-timeout");
          } else {
            try {
              socket.ping();
            } catch {
              this.detach(owner, socket, "ping-failed");
            }
          }
        }
      }
    }, 30_000);
    this.sweep.unref?.();
  }

  private stopSweep() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
  }
}
