import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { Mic } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable } from "react-native";
import { API_URL, type MuseApi } from "./api";
import { colors } from "./ui";
import { useWorkspace } from "./workspace";
import {
  getSpeechRecognitionClass,
  mimeForExtension,
  recordingExtension,
} from "./voice-support";

// Minimal Web Speech API surface (Chrome/Edge; the TS DOM lib may not be
// included in this project, so the few members used are declared here).
interface SpeechRecognitionResultItem {
  transcript: string;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  0: SpeechRecognitionResultItem;
}
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult> & { length: number };
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
/** Support check bound to this platform (kept tiny for unit tests in voice-support). */
function getRecClass(w: unknown) {
  return getSpeechRecognitionClass(Platform.OS, w);
}

function canDictate(): boolean {
  return typeof window !== "undefined" && getRecClass(window) !== null;
}

function language(): string {
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

function extensionOf(uri: string): string {
  return recordingExtension(uri);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Web: the expo-audio recorder exposes a blob URI; upload it as multipart. */
async function transcribeWebRecording(api: MuseApi, uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  const ext = extensionOf(uri) || (blob.type.includes("ogg") ? "ogg" : "webm");
  const mime = blob.type || mimeForExtension(ext, "audio/webm");
  const file = new File([blob], `recording.${ext}`, { type: mime });
  const form = new FormData();
  form.append("audio", file, file.name);
  const { text } = await api.request<{ text: string }>("/api/voice/transcribe", form);
  if (!text.trim()) throw new Error("No speech was recognized. Try again.");
  return text.trim();
}

/** Native: file URIs upload directly, mirroring the chat attachment flow. */
async function transcribeNativeRecording(api: MuseApi, uri: string): Promise<string> {
  const ext = extensionOf(uri) || "m4a";
  const upload = await FileSystem.uploadAsync(`${API_URL}/api/voice/transcribe`, uri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: "audio",
    mimeType: mimeForExtension(ext, "audio/mp4"),
    headers: { Authorization: `Bearer ${api.token}` },
  });
  let payload: { text?: unknown; error?: unknown } = {};
  try {
    payload = JSON.parse(upload.body);
  } catch {
    payload = {};
  }
  if (upload.status < 200 || upload.status >= 300)
    throw new Error(
      typeof payload.error === "string" ? payload.error : "Voice transcription failed.",
    );
  if (typeof payload.text !== "string" || !payload.text.trim())
    throw new Error("No speech was recognized. Try again.");
  return payload.text.trim();
}

/**
 * Mic button for the chat composer. Tap to record, tap again to stop: the
 * recording is transcribed by the backend (/api/voice/transcribe) and the
 * text is appended to the draft for review before sending, so it reaches the
 * LLM through the normal send path. Where backend transcription is
 * unavailable and the browser offers dictation, it falls back to that.
 */
export function VoiceButton({
  onTranscript,
  onError,
  disabled,
}: {
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}) {
  const { api } = useWorkspace();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const [transcribing, setTranscribing] = useState(false);
  const [dictating, setDictating] = useState(false);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const stopDictationIntent = useRef(false);
  const callbackRef = useRef(onTranscript);
  callbackRef.current = onTranscript;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const apiRef = useRef(api);
  apiRef.current = api;

  const recording = recorderState.isRecording;
  const busy = recording || transcribing || dictating;

  // Discard an in-flight recording/dictation if the composer unmounts.
  useEffect(() => {
    const rec = recorder;
    return () => {
      try {
        if (rec.isRecording) void rec.stop().catch(() => {});
      } catch {
        /* already stopped */
      }
      try {
        recRef.current?.abort();
      } catch {
        /* already stopped */
      }
      recRef.current = null;
    };
  }, [recorder]);

  const fail = useCallback((error: unknown) => {
    errorRef.current?.(errorMessage(error));
  }, []);

  const stopDictation = useCallback(() => {
    stopDictationIntent.current = true;
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
    recRef.current = null;
    setDictating(false);
  }, []);

  const startDictation = useCallback(() => {
    if (typeof window === "undefined") return false;
    const Rec = getRecClass(window) as (new () => SpeechRecognitionInstance) | null;
    if (!Rec) return false;
    stopDictationIntent.current = false;
    const rec = new Rec();
    rec.lang = language();
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal) text += result[0]?.transcript ?? "";
      }
      text = text.trim();
      if (text) callbackRef.current(text);
    };
    rec.onerror = () => {
      stopDictationIntent.current = true;
      recRef.current = null;
      setDictating(false);
      errorRef.current?.("Voice input stopped. Try again or type your message.");
    };
    rec.onend = () => {
      // Chrome ends recognition after a pause: keep listening until the user
      // taps stop, unless stopDictation() already ran (recRef cleared).
      if (!stopDictationIntent.current && recRef.current) {
        try {
          rec.start();
          return;
        } catch {
          /* fall through to stop */
        }
      }
      recRef.current = null;
      setDictating(false);
    };
    recRef.current = rec;
    try {
      rec.start();
      setDictating(true);
      return true;
    } catch {
      recRef.current = null;
      return false;
    }
  }, []);

  const toggle = useCallback(() => {
    if (disabled || transcribing) return;
    if (dictating) {
      stopDictation();
      return;
    }
    if (recording) {
      void (async () => {
        try {
          await recorder.stop();
        } catch (error) {
          fail(error);
          return;
        }
        const uri = recorder.uri;
        if (!uri) {
          fail(new Error("The recording could not be saved. Try again."));
          return;
        }
        setTranscribing(true);
        try {
          const text =
            Platform.OS === "web"
              ? await transcribeWebRecording(apiRef.current, uri)
              : await transcribeNativeRecording(apiRef.current, uri);
          callbackRef.current(text);
        } catch (error) {
          // Sample mode and installs without a transcription key fall back to
          // on-device browser dictation; other failures surface as an error.
          if (/not configured/i.test(errorMessage(error)) && canDictate()) startDictation();
          else fail(error);
        } finally {
          setTranscribing(false);
        }
      })();
      return;
    }
    void (async () => {
      try {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted)
          throw new Error(
            "Microphone access was denied. Allow it in system settings to send voice messages.",
          );
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch (error) {
        if (!startDictation()) fail(error);
      }
    })();
  }, [disabled, transcribing, dictating, recording, recorder, stopDictation, startDictation, fail]);

  const active = recording || dictating;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        transcribing
          ? "Transcribing voice message"
          : recording
            ? "Stop recording and transcribe"
            : dictating
              ? "Stop voice input"
              : "Record a voice message"
      }
      accessibilityState={{ busy, disabled: disabled || transcribing }}
      disabled={disabled || transcribing}
      onPress={toggle}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 24,
        opacity: disabled ? 0.4 : 1,
        backgroundColor: active ? "#FDE8E8" : pressed ? colors.sky : "transparent",
      })}
    >
      {transcribing ? (
        <ActivityIndicator color={colors.blueDark} />
      ) : (
        <Mic size={22} strokeWidth={1.8} color={active ? "#C0392B" : colors.text} />
      )}
    </Pressable>
  );
}
