import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createBrowserManager, validateSessionId } from "./browser.ts";
import { WorkerError } from "./errors.ts";

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new WorkerError("INVALID_BODY", "A JSON request body is required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1024)
      throw new WorkerError("BODY_TOO_LARGE", "Request body exceeds 64 KiB.", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid object");
    return result as Record<string, unknown>;
  } catch {
    throw new WorkerError("INVALID_BODY", "A JSON object is required.");
  }
}

function requiredUrl(body: Record<string, unknown>): string {
  if (typeof body.url !== "string" || body.url.length > 8192)
    throw new WorkerError("INVALID_URL", "A URL of at most 8192 characters is required.");
  return body.url;
}

export async function createWorkerServer(
  options: {
    token: string;
    dataDir: string;
    maxSessions?: number;
    idleTimeoutMs?: number;
  },
  createBrowser = createBrowserManager,
) {
  if (options.token.length < 32)
    throw new Error("WORKER_TOKEN must contain at least 32 characters.");
  const tokenHash = createHash("sha256").update(`Bearer ${options.token}`).digest();
  const browser = await createBrowser(options);
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    try {
      const pathname = new URL(request.url ?? "/", "http://worker").pathname;
      if (request.method === "GET" && pathname === "/health") {
        json(200, { status: "ok" });
        return;
      }
      const headerHash = createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest();
      if (!timingSafeEqual(headerHash, tokenHash))
        throw new WorkerError("UNAUTHORIZED", "Worker authentication is required.", 401);
      if (pathname === "/sessions" && request.method === "GET") {
        json(200, browser.list());
        return;
      }
      if (pathname === "/sessions" && request.method === "POST") {
        const body = await readBody(request);
        json(201, await browser.create(validateSessionId(body.id), requiredUrl(body)));
        return;
      }
      const match =
        /^\/sessions\/([^/]+)\/(navigate|close|screenshot|read|input|move|downloads|stream)(?:\/([^/]+))?$/.exec(
          pathname,
        );
      if (!match) throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
      const id = validateSessionId(match[1]);
      const action = match[2];
      const downloadId = match[3];
      if (action === "navigate" && !downloadId && request.method === "POST")
        json(200, await browser.navigate(id, requiredUrl(await readBody(request))));
      else if (action === "close" && !downloadId && request.method === "POST")
        json(200, await browser.closeSession(id));
      else if (action === "input" && !downloadId && request.method === "POST")
        json(200, await browser.input(id, await readBody(request)));
      else if (action === "move" && !downloadId && request.method === "POST") {
        await browser.move(id, await readBody(request));
        json(200, { ok: true });
      } else if (action === "stream" && !downloadId && request.method === "GET") {
        // Live MJPEG screencast. The subscription starts before headers so a
        // closed session still fails as JSON instead of a broken stream.
        let latest: Buffer | null = null;
        let ready = false;
        const send = (frame: Buffer) => {
          latest = frame;
          if (ready) writeFrame(frame);
        };
        const writeFrame = (frame: Buffer) => {
          try {
            response.write(
              `--openmuse-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
            );
            response.write(frame);
            response.write("\r\n");
          } catch {
            /* Client gone; the close handler below unsubscribes. */
          }
        };
        let unsubscribe: (() => void) | null = null;
        const onClose = () => {
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        };
        response.on("close", onClose);
        try {
          // A closed session aborts the stream so the viewer reconnects
          // instead of freezing on the last frame.
          unsubscribe = await browser.subscribe(id, send, () => response.destroy());
        } catch (error) {
          response.removeListener("close", onClose);
          throw error;
        }
        response.writeHead(200, {
          "content-type": "multipart/x-mixed-replace; boundary=openmuse-frame",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        ready = true;
        if (latest) writeFrame(latest);
        // Hold the request open until the viewer disconnects.
        await new Promise<void>((resolve) => response.on("close", resolve));
        onClose();
        return;
      } else if (action === "read" && !downloadId && request.method === "GET")
        json(200, await browser.read(id));
      else if (action === "screenshot" && !downloadId && request.method === "GET") {
        const bytes = await browser.screenshot(id);
        response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length });
        response.end(bytes);
      } else if (action === "downloads" && request.method === "GET") {
        if (!downloadId) json(200, await browser.downloads(id));
        else {
          const result = await browser.download(id, downloadId);
          response.writeHead(200, {
            "content-type": "application/pdf",
            "content-length": result.bytes.length,
            "content-disposition": `attachment; filename="${result.metadata.name}"`,
          });
          response.end(result.bytes);
        }
      } else throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
    } catch (error) {
      const safe =
        error instanceof WorkerError
          ? error
          : new WorkerError(
              "WORKER_FAILURE",
              "The browser operation failed. Check worker health and reopen the session.",
              500,
            );
      if (!response.headersSent && !response.destroyed)
        json(safe.status, { error: { code: safe.code, message: safe.message } });
      else response.end();
    }
  });
  // Navigations legitimately take 45s+ on heavy pages (plus Chromium launch
  // on first open), so the socket must outlive the API client's own abort
  // or real loads die as "worker unavailable". Failure detection stays on
  // the client side, which aborts first when the worker is truly stuck.
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return {
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await browser.close();
    },
  };
}
