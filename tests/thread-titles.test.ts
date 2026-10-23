import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import {
  deriveThreadTitle,
  isThreadTitleRequest,
  THREAD_TITLE_SYSTEM_MARKER,
  THREAD_TITLE_USER_MARKER,
} from "../apps/server/src/engine/conversation.ts";

function titleMessages(firstUser: string) {
  const sys = {
    id: randomUUID(),
    role: "system" as const,
    content: `${THREAD_TITLE_SYSTEM_MARKER}\nReturn JSON`,
  };
  const transcript = [
    "Conversation:",
    `user: ${firstUser}`,
    `${THREAD_TITLE_USER_MARKER} Return JSON`,
  ].join("\n\n");
  const user = { id: randomUUID(), role: "user" as const, content: transcript };
  return { sys, user, transcript };
}

test("deriveThreadTitle truncates to five words with sentence case", () => {
  assert.equal(
    deriveThreadTitle(
      [
        "Conversation:",
        "user: Check out Hacker News for cool stuff",
        "Generate a short title for the conversation above.",
      ].join("\n\n"),
    ),
    "Check out Hacker News for",
  );
  assert.equal(
    deriveThreadTitle(
      [
        "Conversation:",
        "user: Summarize copilotkit.ai",
        "Generate a short title for the conversation above.",
      ].join("\n\n"),
    ),
    "Summarize copilotkit.ai",
  );
  assert.equal(
    deriveThreadTitle(
      ["Conversation:", "user: Hi", "Generate a short title for the conversation above."].join(
        "\n\n",
      ),
    ),
    "Hi",
  );
});

test("isThreadTitleRequest matches CopilotKit prompt and ignores normal chat", () => {
  const { sys, user } = titleMessages("hello world test message here");
  assert.equal(isThreadTitleRequest([sys, user]), true);
  assert.equal(isThreadTitleRequest([{ id: "1", role: "user", content: "hello" }]), false);
});

test("title runs return JSON without creating tasks or calling the model", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createStore } = await import("../apps/server/src/db.ts");
  const { createApp } = await import("../apps/server/src/app.ts");
  const { ConversationAgent } = await import("../apps/server/src/engine/conversation.ts");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-thread-title-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const result = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    intelligenceApiKey: "test-project-key-never-sent",
  });
  t.after(() => result.agent.stop());
  const config = {
    mode: "sample" as const,
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample" as const,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [] as string[],
    intelligenceApiKey: "test-project-key-never-sent",
  };
  const agent = new ConversationAgent(config, result.agent, "local-user");
  const { sys, user } = titleMessages("Check out Hacker News for cool stuff");
  const events = await lastValueFrom(
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [sys, user],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const text = events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as { delta?: string }).delta ?? "")
    .join("");
  assert.deepEqual(JSON.parse(text), { title: "Check out Hacker News for" });
  assert.equal((await db.list("local-user", "tasks")).length, 0);
});
