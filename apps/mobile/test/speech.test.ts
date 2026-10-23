import assert from "node:assert/strict";
import test from "node:test";
import { chunkSpokenText, toSpokenText } from "../src/speech.ts";

test("assistant markdown is stripped to speakable text", () => {
  assert.equal(toSpokenText("## Heading\n\nHello **world**!"), "Heading Hello world!");
  assert.equal(toSpokenText("Try [this link](https://example.com) now."), "Try this link now.");
  assert.equal(toSpokenText("Before\n```js\nconst x = 1;\n```\nAfter"), "Before After");
  assert.equal(
    toSpokenText("Run `npm test` then:\n\n- first item\n- second item"),
    "Run npm test then: first item second item",
  );
  assert.equal(toSpokenText("> quoted\n\nplain"), "quoted plain");
});

test("long replies split into short speakable chunks", () => {
  const text =
    "First sentence is here. Second sentence follows it! Is there a third? Yes, there is.";
  const chunks = chunkSpokenText(text, 40);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 40));
  assert.equal(chunks.join(" "), text);
  assert.deepEqual(chunkSpokenText("Short."), ["Short."]);
  assert.deepEqual(chunkSpokenText("   "), []);
});
