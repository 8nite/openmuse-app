import { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { usePwaInstall } from "./pwa";
import { Button, colors } from "./ui";
import { type NotifyPermission, notifyPermission, requestNotifyPermission } from "./web-notify";
import { disablePush, enablePush, type PushState, pushState } from "./web-push";
import { useWorkspace } from "./workspace";

// Web-only row: notification permission + PWA install. Native renders nothing.
export function WebNotificationSettings() {
  const [perm, setPerm] = useState<NotifyPermission>("default");
  const { canInstall, installed, install } = usePwaInstall();
  useEffect(() => {
    if (Platform.OS === "web") setPerm(notifyPermission());
  }, []);
  if (Platform.OS !== "web") return null;
  if (perm === "unsupported") return null;
  return (
    <View style={{ gap: 8, marginBottom: 14 }}>
      {perm !== "granted" ? (
        <View
          style={{
            gap: 6,
            backgroundColor: colors.sky,
            borderRadius: 14,
            paddingHorizontal: 14,
            paddingVertical: 12,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: "600" }}>
            Get notified about replies
          </Text>
          <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>
            {perm === "denied"
              ? "Notifications are blocked. Allow them in your browser's site settings to get alerts."
              : "Allow browser notifications to hear about new messages when this tab is in the background."}
          </Text>
          {perm !== "denied" && (
            <Button small onPress={() => void requestNotifyPermission().then(setPerm)}>
              Enable notifications
            </Button>
          )}
        </View>
      ) : null}
      <PushSettings onPermissionChange={setPerm} />
      {canInstall && !installed && (
        <Button small onPress={() => void install()}>
          Install OpenMuse app
        </Button>
      )}
    </View>
  );
}

// Closed-app push via the server + vendor push service. Needs HTTPS + VAPID on the server.
function PushSettings({
  onPermissionChange,
}: {
  onPermissionChange: (p: NotifyPermission) => void;
}) {
  const { api } = useWorkspace();
  const [state, setState] = useState<PushState>("off");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (Platform.OS === "web") void pushState().then(setState);
  }, []);
  if (Platform.OS !== "web" || state === "unsupported") return null;
  async function toggle() {
    setBusy(true);
    try {
      if (state === "on") {
        await disablePush(api);
        setState("off");
      } else {
        const ok = await enablePush(api);
        setState(ok ? "on" : await pushState());
        onPermissionChange(notifyPermission());
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <View
      style={{
        gap: 6,
        backgroundColor: state === "on" ? colors.green : colors.sky,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: "600" }}>
        {state === "on"
          ? "Push is on — alerts arrive even with the app closed"
          : "Push when the app is closed"}
      </Text>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>
        {state === "blocked"
          ? "Notifications are blocked in this browser. Allow them in site settings, then try again."
          : state === "on"
            ? "This device is registered. New results, approvals and replies push to it."
            : "Register this device so new results and approvals reach you when OpenMuse isn't open."}
      </Text>
      {state !== "blocked" && (
        <Button small busy={busy} onPress={() => void toggle()}>
          {state === "on" ? "Turn push off" : "Enable push"}
        </Button>
      )}
    </View>
  );
}

// Slim install banner for the chat shell (shows only when the browser offers install).
export function PwaInstallBanner() {
  const { canInstall, install } = usePwaInstall();
  const [dismissed, setDismissed] = useState(false);
  if (Platform.OS !== "web" || !canInstall || dismissed) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        backgroundColor: colors.text,
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 10,
        marginBottom: 10,
      }}
    >
      <Text style={{ flex: 1, color: "#FFF", fontSize: 13 }}>
        Install OpenMuse for quick access and notifications.
      </Text>
      <Button small onPress={() => void install()}>
        Install
      </Button>
      <Button small onPress={() => setDismissed(true)}>
        Later
      </Button>
    </View>
  );
}
