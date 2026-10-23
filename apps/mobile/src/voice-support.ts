// Pure Web Speech API support check (no react-native imports so node tests
// can cover it; the component in voice-input.tsx passes Platform.OS).
export type SpeechRecognitionClass = new () => unknown;

export function getSpeechRecognitionClass(
  platformOs: string,
  w: unknown,
): SpeechRecognitionClass | null {
  if (platformOs !== "web" || typeof w !== "object" || w === null) return null;
  const rec =
    (w as Record<string, unknown>).SpeechRecognition ??
    (w as Record<string, unknown>).webkitSpeechRecognition;
  return (typeof rec === "function" ? rec : null) as SpeechRecognitionClass | null;
}

/** File extension of a recording URI, without query or fragment. */
export function recordingExtension(uri: string): string {
  const match = uri.split("?")[0]?.split("#")[0]?.match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1]?.toLowerCase() ?? "";
}

/** Backend accepts audio/*; map the common recording containers explicitly. */
export function mimeForExtension(ext: string, fallback: string): string {
  switch (ext) {
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "webm":
      return "audio/webm";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "3gp":
      return "audio/3gpp";
    default:
      return fallback;
  }
}

/** Append recognized speech to the draft, keeping a space between segments. */
export function appendTranscript(current: string, text: string): string {
  const clean = text.trim();
  if (!clean) return current;
  return current.trim() ? `${current.trim()} ${clean}` : clean;
}
