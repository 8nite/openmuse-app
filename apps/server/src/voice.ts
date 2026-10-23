// Server-side speech-to-text for chat voice messages. The app records audio
// and POSTs it to /api/voice/transcribe; the transcript is returned as text
// for the user to review and send, at which point it reaches the LLM like
// any typed message. OpenAI-compatible transcription is preferred; Google
// Gemini transcription covers installs with only a Google key.
import { AppError } from "./errors.ts";

/** Recordings larger than this are rejected before any provider call. */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

/** Transcripts are bounded so one message cannot flood the thread. */
export const MAX_TRANSCRIPT_CHARS = 4000;

// ponytail: audio/* covers m4a/mp4/aac/wav/ogg from expo-audio and MediaRecorder;
// video/webm covers Chrome's MediaRecorder default container.
const ALLOWED_MIME_PREFIXES = ["audio/", "video/webm"];
const OCTET_FALLBACK_EXTENSIONS = [
  ".webm",
  ".ogg",
  ".oga",
  ".opus",
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4",
  ".aac",
  ".flac",
];

export function voiceConfigured(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY?.trim() ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GOOGLE_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim(),
  );
}

function googleKey(): string {
  return (
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    ""
  );
}

export function voiceTranscribeModel(provider: "openai" | "gemini"): string {
  const override = process.env.VOICE_TRANSCRIBE_MODEL?.trim();
  if (override) return override;
  return provider === "openai" ? "whisper-1" : "gemini-2.0-flash";
}

function openaiBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function geminiBaseUrl(): string {
  return (
    process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.trim() ||
    "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");
}

/** Provider-agnostic validation shared by the route and unit tests. */
export function validateVoiceInput(bytes: Uint8Array, mimeType: string, filename: string): void {
  if (!bytes.length) throw new AppError("The recording is empty. Try recording again.", 422);
  if (bytes.length > MAX_VOICE_BYTES)
    throw new AppError("Voice messages must be 10 MB or smaller.", 413);
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return;
  const lower = filename.toLowerCase();
  if (
    (mime === "" || mime === "application/octet-stream") &&
    OCTET_FALLBACK_EXTENSIONS.some((ext) => lower.endsWith(ext))
  )
    return;
  throw new AppError(
    `Voice format ${mime || "unknown"} is not supported. ` +
      "Record again as m4a, mp3, wav, ogg or webm.",
    415,
  );
}

export async function transcribeAudio(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  filename: string,
): Promise<string> {
  validateVoiceInput(bytes, mimeType, filename);
  if (process.env.OPENAI_API_KEY?.trim())
    return transcribeViaOpenAI(bytes, mimeType || "audio/webm", filename || "recording.m4a");
  const key = googleKey();
  if (key) return transcribeViaGemini(bytes, mimeType || "audio/webm", key);
  throw new AppError(
    "Voice transcription is not configured on the server. " +
      "Set OPENAI_API_KEY or a Google API key, or type your message instead.",
    503,
  );
}

async function transcribeViaOpenAI(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: mimeType }), filename);
  form.append("model", voiceTranscribeModel("openai"));
  form.append("response_format", "json");
  let response: Response;
  try {
    response = await fetch(`${openaiBaseUrl()}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY?.trim() ?? ""}` },
      body: form,
    });
  } catch {
    throw new AppError("Voice transcription could not reach the provider. Try again.", 502);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const payload = (await response.json()) as { error?: { message?: unknown } };
      if (typeof payload.error?.message === "string") detail = payload.error.message;
    } catch {
      /* provider error body is optional */
    }
    if (response.status === 401 || response.status === 403)
      throw new AppError(
        "Voice transcription was rejected. Check the server API key and try again.",
        502,
      );
    throw new AppError(
      `Voice transcription failed${detail ? `: ${detail.slice(0, 200)}` : ""}. ` +
        "Try again or type your message.",
      502,
    );
  }
  const payload = (await response.json()) as { text?: unknown };
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text)
    throw new AppError("No speech could be heard in that recording. Try again.", 502);
  return text.slice(0, MAX_TRANSCRIPT_CHARS);
}

async function transcribeViaGemini(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  key: string,
): Promise<string> {
  const model = voiceTranscribeModel("gemini");
  let response: Response;
  try {
    response = await fetch(
      `${geminiBaseUrl()}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: "Transcribe this audio verbatim. Reply with only the transcribed words." },
                {
                  inlineData: {
                    mimeType,
                    data: Buffer.from(bytes).toString("base64"),
                  },
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 2000 },
        }),
      },
    );
  } catch {
    throw new AppError("Voice transcription could not reach the provider. Try again.", 502);
  }
  if (!response.ok) {
    if (response.status === 400)
      throw new AppError(
        "The recording could not be read. Record again as m4a, mp3, wav, ogg or webm.",
        502,
      );
    if (response.status === 401 || response.status === 403)
      throw new AppError(
        "Voice transcription was rejected. Check the server API key and try again.",
        502,
      );
    throw new AppError("Voice transcription failed. Try again or type your message.", 502);
  }
  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: unknown }[] } }[];
  };
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
  if (!text)
    throw new AppError("No speech could be heard in that recording. Try again.", 502);
  return text.slice(0, MAX_TRANSCRIPT_CHARS);
}
