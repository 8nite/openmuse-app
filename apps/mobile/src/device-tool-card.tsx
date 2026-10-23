import { Check, Hand, RotateCw, Smartphone } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, Image, Text, View } from "react-native";
import { z } from "zod";
import type { DeviceSession } from "../../../packages/domain/src";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

const observationSchema = z.object({
  sessionId: z.string(),
  title: z.string().optional(),
  packageOrUrl: z.string().optional(),
});

const waitingSchema = z.object({ status: z.literal("waiting_approval"), actionId: z.string() });

function resultValue(result: unknown) {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

/** A server tool result stays with the request that produced it, including on replay. */
export function DeviceToolCard({
  packageOrUrl,
  result,
  loading,
}: {
  packageOrUrl: unknown;
  result: unknown;
  loading: boolean;
}) {
  const { api, workspace, open } = useWorkspace();
  const value = resultValue(result);
  const observation = observationSchema.safeParse(value);
  const waiting = waitingSchema.safeParse(value);
  const toolError = z.object({ error: z.string() }).safeParse(value);
  const sessionId = observation.success ? observation.data.sessionId : undefined;
  const awaitingApproval = waiting.success;
  const current = workspace.devices?.find((device) => device.id === sessionId);
  const [device, setDevice] = useState<DeviceSession>();
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    async function connect() {
      setError("");
      setPreviewFailed(false);
      try {
        const session = await api.request<DeviceSession>(
          `/api/devices/${encodeURIComponent(sessionId || "")}`,
        );
        if (active) setDevice(session);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void connect();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void connect();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [api, sessionId, current?.updatedAt, retry]);

  const visited = observation.success ? observation.data : undefined;
  const preview = device?.status === "active" && !previewFailed ? device.previewUrl : undefined;
  const failure = awaitingApproval
    ? ""
    : toolError.success
      ? toolError.data.error
      : !loading && !visited
        ? "The phone did not return a screen. Try your request again."
        : "";
  const label = typeof packageOrUrl === "string" && packageOrUrl ? packageOrUrl : "Phone session";
  return (
    <Card
      style={{ padding: 13, backgroundColor: "#EEEEF0", gap: 12, width: "100%", maxWidth: 440 }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 10 }]}>
          <Smartphone size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>Phone</Text>
          <Text numberOfLines={1} style={[s.small, { fontSize: 12 }]}>
            {loading
              ? "Phone paused"
              : awaitingApproval
                ? "Waiting for your approval"
                : failure
                  ? "Couldn’t read the phone"
                  : label}
          </Text>
        </View>
        {loading ? (
          <ActivityIndicator size="small" color={colors.blueDark} />
        ) : visited ? (
          <Check size={17} accessibilityLabel="Phone observed" />
        ) : null}
      </View>
      {awaitingApproval && !loading ? (
        <View style={{ backgroundColor: "#FAFAFB", borderRadius: 12, padding: 21, gap: 12 }}>
          <Text numberOfLines={2} style={[s.text, { fontSize: 14 }]}>
            {label}
          </Text>
          <Text style={s.small}>
            The phone action is waiting for your approval in Reviews. Nothing has run on the phone
            yet.
          </Text>
        </View>
      ) : preview ? (
        <Image
          accessibilityLabel={`Phone preview: ${visited?.title ?? label}`}
          source={{ uri: api.url(preview) }}
          style={{
            width: "100%",
            aspectRatio: 9 / 16,
            maxHeight: 320,
            borderRadius: 12,
            backgroundColor: "#FFF",
          }}
          resizeMode="contain"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <View style={{ backgroundColor: "#FAFAFB", borderRadius: 12, padding: 21, gap: 12 }}>
          <Text numberOfLines={2} style={[s.text, { fontSize: 14 }]}>
            {visited?.title || label}
          </Text>
          {visited ? (
            <Text style={s.small}>
              {device?.status === "closed"
                ? "Session saved. Take control to reopen it."
                : device?.status === "error"
                  ? "Session needs attention. Take control to reconnect."
                  : previewFailed
                    ? "Preview unavailable. You can still take control."
                    : "Connecting to the saved session…"}
            </Text>
          ) : null}
        </View>
      )}
      <ErrorNotice error={failure || error} />
      {!loading && visited && (
        <Button
          icon={Hand}
          disabled={!device}
          onPress={() => device && open({ type: "device", device })}
          style={{ backgroundColor: "#F9F9FA", minHeight: 38, paddingVertical: 8 }}
        >
          Take control
        </Button>
      )}
      {!!error && (
        <Button small icon={RotateCw} onPress={() => setRetry((attempt) => attempt + 1)}>
          Reconnect preview
        </Button>
      )}
    </Card>
  );
}
