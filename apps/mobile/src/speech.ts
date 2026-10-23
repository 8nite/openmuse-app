// Client-side text-to-speech for assistant replies (Web Speech API, no deps).
// There is no server TTS backend (no provider key, no gateway endpoint), so
// speaking happens in the app. Renders nothing where unsupported.

/** Markdown-stripped speakable text (pure, unit-tested). */
export function toSpokenText(markdown: string): string {
  let text = markdown;
  text = text.replace(/```[\s\S]*?```/g, " "); // fenced code: never read aloud
  text = text.replace(/`([^`]*)`/g, "$1"); // inline code: keep the words
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images: keep alt
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links: keep label
  text = text.replace(/<[^>]+>/g, " "); // raw HTML
  text = text.replace(/^#{1,6}\s+/gm, ""); // headings
  text = text.replace(/^>\s?/gm, ""); // quotes
  text = text.replace(/^(\s*[-*+]|\s*\d+[.)])\s+/gm, ""); // list markers
  text = text.replace(/(\*\*|__|\*|_|~~)/g, ""); // emphasis
  text = text.replace(/^-{3,}\s*$/gm, " "); // rules
  return text.replace(/\s+/g, " ").trim();
}

/** Split into short chunks: long single utterances get cut off on some platforms. */
export function chunkSpokenText(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["”)]?\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (`${current} ${piece}`.trim().length <= max) {
      current = `${current} ${piece}`.trim();
    } else {
      if (current) chunks.push(current);
      current = piece.length <= max ? piece : piece.slice(0, max);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

interface SpeechEngine {
  cancel: () => void;
  speak: (utterance: unknown) => void;
}

function engine(): SpeechEngine | null {
  if (typeof window === "undefined") return null;
  const synth = (window as unknown as Record<string, unknown>).speechSynthesis;
  if (!synth || typeof synth !== "object") return null;
  const candidate = synth as Record<string, unknown>;
  if (typeof candidate.speak !== "function" || typeof candidate.cancel !== "function") return null;
  return synth as unknown as SpeechEngine;
}

export function isSpeechSupported(): boolean {
  return engine() !== null;
}

function utter(text: string, rate: number): Record<string, unknown> {
  const Ctor = (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
  const u: Record<string, unknown> =
    typeof Ctor === "function" ? new (Ctor as new () => Record<string, unknown>)() : {};
  u.text = text;
  u.rate = rate;
  return u;
}

/** Speak markdown content; calls onDone when the last chunk ends or is cancelled. */
export function speakMarkdown(markdown: string, onDone: () => void, rate = 1): () => void {
  const synth = engine();
  const chunks = chunkSpokenText(toSpokenText(markdown));
  if (!synth || chunks.length === 0) {
    onDone();
    return () => {};
  }
  synth.cancel();
  let cancelled = false;
  let index = 0;
  const next = () => {
    if (cancelled || index >= chunks.length) {
      if (!cancelled) onDone();
      return;
    }
    const u = utter(chunks[index++] ?? "", rate);
    u.text = chunks[index - 1] ?? "";
    u.rate = rate;
    u.onend = next;
    u.onerror = () => {
      if (!cancelled) onDone();
    };
    synth.speak(u);
  };
  next();
  return () => {
    cancelled = true;
    try {
      synth.cancel();
    } catch {
      /* already stopped */
    }
  };
}

export function stopSpeaking(): void {
  try {
    engine()?.cancel();
  } catch {
    /* unsupported */
  }
}
