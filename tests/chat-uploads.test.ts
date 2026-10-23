import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

// A 1x1 transparent PNG, small enough to inline as chat vision content.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const pngBase64 = png.toString("base64");

async function fixture(t: TestContext) {
  const browser = await browserFixture(t, () => {
    throw new Error("File reads must not use the browser");
  });
  const config = { ...browser.config, agentBackend: "model" as const, model: "openai/fixture" };
  const server = await createApp(browser.db, config);
  t.after(() => server.agent.stop());
  return {
    ...browser,
    ...server,
    conversation: new ConversationAgent(config, server.agent, "local-user"),
  };
}

test("chat uploads store images and text with their real types", async (t) => {
  const f = await fixture(t);
  const image = await f.agent.files.import(
    "local-user",
    "photo.png",
    new Uint8Array(png),
    "Uploaded by you",
    undefined,
    undefined,
    "image/png",
  );
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.pageCount, 0);
  assert.equal(image.fields, undefined);
  assert.deepEqual(
    new Uint8Array(await f.agent.files.bytes("local-user", image.id)),
    new Uint8Array(png),
  );
  const note = await f.agent.files.import(
    "local-user",
    "notes.txt",
    new TextEncoder().encode("Buy milk.\n"),
    "Uploaded by you",
    undefined,
    undefined,
    "text/plain",
  );
  assert.equal(note.mimeType, "text/plain");
  const stored = await readdir(join(f.config.dataDir, "files"));
  assert.ok(stored.includes(`${image.id}.png`));
  assert.ok(stored.includes(`${note.id}.txt`));
  const pdf = await f.agent.files.import(
    "local-user",
    "form.pdf",
    await createSamplePdf(),
    "Uploaded by you",
  );
  assert.equal(pdf.mimeType, "application/pdf");
  assert.ok(pdf.pageCount > 0);
  assert.ok((await readdir(join(f.config.dataDir, "files"))).includes(`${pdf.id}.pdf`));
});

test("unsupported uploads and filling non-PDFs are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.agent.files.import(
      "local-user",
      "archive.zip",
      new Uint8Array([1, 2, 3]),
      "Uploaded by you",
      undefined,
      undefined,
      "application/zip",
    ),
    /not supported/,
  );
  const image = await f.agent.files.import(
    "local-user",
    "photo.png",
    new Uint8Array(png),
    "Uploaded by you",
    undefined,
    undefined,
    "image/png",
  );
  await assert.rejects(f.agent.files.fill("local-user", image.id, {}), /Only PDFs/);
});

test("POST /api/files accepts an image and serves its content type", async (t) => {
  const f = await fixture(t);
  const { token } = await f.auth.session();
  const headers = { Authorization: `Bearer ${token}` };
  const form = new FormData();
  form.append("file", new File([png], "photo.png", { type: "image/png" }), "photo.png");
  const upload = await f.app.request("/api/files", { method: "POST", headers, body: form });
  assert.equal(upload.status, 201);
  const artifact = (await upload.json()) as { id: string; mimeType: string };
  assert.equal(artifact.mimeType, "image/png");
  const content = await f.app.request(`/api/files/${artifact.id}/content`, { headers });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await content.arrayBuffer()), new Uint8Array(png));
  const bad = new FormData();
  bad.append(
    "file",
    new File([new Uint8Array([1])], "archive.zip", { type: "application/zip" }),
    "archive.zip",
  );
  assert.equal(
    (await f.app.request("/api/files", { method: "POST", headers, body: bad })).status,
    415,
  );
});

test("chat read_file shows an attached image to the model but keeps history text-only", async (t) => {
  const f = await fixture(t);
  const image = await f.agent.files.import(
    "local-user",
    "photo.png",
    new Uint8Array(png),
    "Uploaded by you",
    undefined,
    undefined,
    "image/png",
  );
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "read_file", arguments: { fileId: image.id } } : undefined,
  );
  const input: RunAgentInput = {
    threadId: "upload-chat",
    runId: randomUUID(),
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: `What is in this photo?\n\nAttached documents: photo.png (artifact ID: ${image.id})`,
      },
    ],
    tools: [],
    context: [],
    state: {},
  };
  const events = (await lastValueFrom(f.conversation.run(input).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  if (result?.type !== EventType.TOOL_CALL_RESULT) throw new Error("Missing tool result");
  const stored = JSON.parse(result.content);
  assert.equal(stored.id, image.id);
  assert.ok(!result.content.includes(pngBase64));
  const output = JSON.parse(requests[1].body).input.find(
    (item: { type: string }) => item.type === "function_call_output",
  );
  assert.deepEqual(output.output, [
    { type: "input_text", text: result.content },
    { type: "input_image", image_url: `data:image/png;base64,${pngBase64}`, detail: "auto" },
  ]);
  assert.match(requests[0].body, /"name":"read_file"/);
});

test("chat read_file returns a bounded excerpt for uploaded text", async (t) => {
  const f = await fixture(t);
  const body = `Buy milk.\n${"x".repeat(40000)}`;
  const note = await f.agent.files.import(
    "local-user",
    "notes.txt",
    new TextEncoder().encode(body),
    "Uploaded by you",
    undefined,
    undefined,
    "text/plain",
  );
  const { requests } = await modelFixture(t, (index) =>
    index === 0 ? { name: "read_file", arguments: { fileId: note.id } } : undefined,
  );
  const input: RunAgentInput = {
    threadId: "upload-text-chat",
    runId: randomUUID(),
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: `Summarize this.\n\nAttached documents: notes.txt (artifact ID: ${note.id})`,
      },
    ],
    tools: [],
    context: [],
    state: {},
  };
  const events = (await lastValueFrom(f.conversation.run(input).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  if (result?.type !== EventType.TOOL_CALL_RESULT) throw new Error("Missing tool result");
  const stored = JSON.parse(result.content);
  assert.equal(stored.id, note.id);
  assert.match(stored.text, /Buy milk/);
  assert.equal(stored.text.length, 30000);
  assert.equal(stored.truncated, true);
  assert.equal(requests.length, 2);
});
