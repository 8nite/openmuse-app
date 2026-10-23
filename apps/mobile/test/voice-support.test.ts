import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTranscript,
  getSpeechRecognitionClass,
  mimeForExtension,
  recordingExtension,
} from "../src/voice-support.ts";

test("voice input is offered only on web with a recognizer present", () => {
  function FakeRec(this: unknown) {}
  assert.equal(getSpeechRecognitionClass("web", { SpeechRecognition: FakeRec }) !== null, true);
  assert.equal(
    getSpeechRecognitionClass("web", { webkitSpeechRecognition: FakeRec }) !== null,
    true,
  );
  assert.equal(getSpeechRecognitionClass("web", {}), null);
  assert.equal(getSpeechRecognitionClass("web", null), null);
  assert.equal(getSpeechRecognitionClass("ios", { SpeechRecognition: FakeRec }), null);
  assert.equal(getSpeechRecognitionClass("android", { webkitSpeechRecognition: FakeRec }), null);
});

test("voice recording filenames map to transcribable mime types", () => {
  assert.equal(recordingExtension("file:///data/recording.m4a"), "m4a");
  assert.equal(recordingExtension("blob:https://app/uuid?x=1#y"), "");
  assert.equal(recordingExtension("recording.WEBM"), "webm");
  assert.equal(mimeForExtension("m4a", "audio/webm"), "audio/mp4");
  assert.equal(mimeForExtension("webm", "fallback"), "audio/webm");
  assert.equal(mimeForExtension("ogg", "fallback"), "audio/ogg");
  assert.equal(mimeForExtension("unknown", "audio/mp4"), "audio/mp4");
});

test("voice transcripts append to the draft with spacing", () => {
  assert.equal(appendTranscript("", "  hello  "), "hello");
  assert.equal(appendTranscript("buy milk", "tomorrow"), "buy milk tomorrow");
  assert.equal(appendTranscript("buy milk  ", "  tomorrow  "), "buy milk tomorrow");
  assert.equal(appendTranscript("draft", "   "), "draft");
});
