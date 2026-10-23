import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import {
  transcribeAudio,
  validateVoiceInput,
  voiceConfigured,
  voiceTranscribeModel,
} from "../apps/server/src/voice.ts";

const audio = new Uint8Array([1, 2, 3, 4]);

function clearVoiceEnv() {
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
    "VOICE_TRANSCRIBE_MODEL",
  ])
    delete process.env[key];
}

async function transcriptionMock(
  handler: (body: Buffer, url: string) => { status: number; payload: unknown },
): Promise<{ server: Server; url: string; seen: { url: string; body: Buffer }[] }> {
  const seen: { url: string; body: Buffer }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: request.url ?? "", body });
      const { status, payload } = handler(body, request.url ?? "");
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}`, seen };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

test("voice input validation rejects empty, oversize and unsupported recordings", () => {
  clearVoiceEnv();
  assert.throws(() => validateVoiceInput(new Uint8Array(), "audio/m4a", "recording.m4a"), AppError);
  try {
    validateVoiceInput(new Uint8Array(), "audio/m4a", "recording.m4a");
  } catch (error) {
    assert.equal((error as AppError).status, 422);
  }
  assert.throws(
    () => validateVoiceInput(new Uint8Array(10 * 1024 * 1024 + 1), "audio/m4a", "r.m4a"),
    (error: unknown) => (error as AppError).status === 413,
  );
  assert.throws(
    () => validateVoiceInput(audio, "application/zip", "archive.zip"),
    (error: unknown) => (error as AppError).status === 415,
  );
  // Chrome records audio/webm; Safari and expo-audio record mp4/m4a; octet
  // fallbacks carry the real extension when the client omits the type.
  validateVoiceInput(audio, "audio/webm", "recording.webm");
  validateVoiceInput(audio, "audio/mp4", "recording.m4a");
  validateVoiceInput(audio, "video/webm", "recording.webm");
  validateVoiceInput(audio, "application/octet-stream", "recording.m4a");
  assert.equal(voiceTranscribeModel("openai"), "whisper-1");
  assert.equal(voiceTranscribeModel("gemini"), "gemini-2.0-flash");
});

test("voice transcription needs a provider key", async () => {
  clearVoiceEnv();
  assert.equal(voiceConfigured(), false);
  await assert.rejects(transcribeAudio(audio, "audio/m4a", "recording.m4a"), /not configured/);
  try {
    await transcribeAudio(audio, "audio/m4a", "recording.m4a");
  } catch (error) {
    assert.equal((error as AppError).status, 503);
  }
});

test("voice transcription uses the OpenAI-compatible endpoint first", async () => {
  clearVoiceEnv();
  const { server, url, seen } = await transcriptionMock(() => ({
    status: 200,
    payload: { text: "  hello from voice  " },
  }));
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `${url}/v1`;
  process.env.OPENAI_API_KEY = "voice-test-key";
  try {
    assert.equal(voiceConfigured(), true);
    assert.equal(await transcribeAudio(audio, "audio/webm", "recording.webm"), "hello from voice");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, "/v1/audio/transcriptions");
    assert.match(seen[0]?.body.toString("latin1") ?? "", /whisper-1/);
  } finally {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await close(server);
  }
});

test("voice transcription surfaces provider failures without leaking keys", async () => {
  clearVoiceEnv();
  const unauthorized = await transcriptionMock(() => ({
    status: 401,
    payload: { error: { message: "bad key" } },
  }));
  process.env.OPENAI_BASE_URL = `${unauthorized.url}/v1`;
  process.env.OPENAI_API_KEY = "voice-test-key";
  try {
    await assert.rejects(transcribeAudio(audio, "audio/m4a", "r.m4a"), /rejected/);
    try {
      await transcribeAudio(audio, "audio/m4a", "r.m4a");
    } catch (error) {
      assert.equal((error as AppError).status, 502);
      assert.ok(!(error as Error).message.includes("voice-test-key"));
    }
  } finally {
    clearVoiceEnv();
    await close(unauthorized.server);
  }
  const empty = await transcriptionMock(() => ({ status: 200, payload: { text: "   " } }));
  process.env.OPENAI_BASE_URL = `${empty.url}/v1`;
  process.env.OPENAI_API_KEY = "voice-test-key";
  try {
    await assert.rejects(transcribeAudio(audio, "audio/m4a", "r.m4a"), /No speech/);
  } finally {
    clearVoiceEnv();
    await close(empty.server);
  }
});

test("voice transcription falls back to Gemini with only a Google key", async () => {
  clearVoiceEnv();
  const { server, url, seen } = await transcriptionMock(() => ({
    status: 200,
    payload: { candidates: [{ content: { parts: [{ text: "gemini heard this" }] } }] },
  }));
  process.env.GOOGLE_API_KEY = "google-voice-key";
  process.env.GOOGLE_GENERATIVE_AI_BASE_URL = url;
  try {
    assert.equal(voiceConfigured(), true);
    assert.equal(await transcribeAudio(audio, "audio/m4a", "r.m4a"), "gemini heard this");
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.url ?? "", /generateContent/);
    assert.ok(!(seen[0]?.body.toString("latin1") ?? "").includes("google-voice-key"));
  } finally {
    clearVoiceEnv();
    await close(server);
  }
});

let db: Store,
  app: Awaited<ReturnType<typeof createApp>>["app"],
  token: string,
  directory: string;
before(async () => {
  clearVoiceEnv();
  directory = await mkdtemp(join(tmpdir(), "openmuse-voice-"));
  db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app } = await createApp(db, config));
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
});
after(async () => {
  clearVoiceEnv();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("POST /api/voice/transcribe returns backend text for chat", async () => {
  const { server, url } = await transcriptionMock(() => ({
    status: 200,
    payload: { text: "buy milk tomorrow" },
  }));
  process.env.OPENAI_BASE_URL = `${url}/v1`;
  process.env.OPENAI_API_KEY = "voice-route-key";
  try {
    assert.equal(
      (await app.request("/api/voice/transcribe", { method: "POST" })).status,
      401,
    );
    const form = new FormData();
    form.append(
      "audio",
      new File([new Uint8Array([1, 2, 3])], "recording.m4a", { type: "audio/mp4" }),
      "recording.m4a",
    );
    const response = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "buy milk tomorrow" });
    const health = await app.request("/api/health");
    assert.equal(((await health.json()) as { voiceConfigured: boolean }).voiceConfigured, true);
    const missing = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missing.status, 422);
  } finally {
    clearVoiceEnv();
    await close(server);
  }
});
