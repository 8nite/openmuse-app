import {
  FileText,
  FolderOpen,
  Globe2,
  Monitor,
  Plus,
  RefreshCw,
  Smartphone,
  Terminal,
} from "lucide-react-native";
import { useCallback, useContext, useEffect, useState } from "react";
import { AppState, Image, Pressable, Text, View } from "react-native";
import type { BrowserSession, DeviceSession } from "../../../packages/domain/src";
import type { ComputerSnapshot } from "../../../packages/domain/src/computer";
import { browserAddress } from "./browser-address";
import { BrowserRunContext } from "./browser-tool-card";
import { useComputerDraft } from "./computer-drafts";
import { computerStatus } from "./computer-status";
import { LinuxWorkspace } from "./computer-workspace";
import { Button, Card, colors, describeFile, ErrorNotice, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ComputerEntry() {
  const { workspace, open } = useWorkspace();
  const available = workspace.connections.some(
    (c) => c.id === "browser" && c.status === "connected",
  );
  const active = workspace.browsers.filter((b) => b.status === "active").length;
  const status = computerStatus(available, active);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Agent computer — ${status}`}
      onPress={() => open({ type: "computer" })}
      style={[
        s.row,
        {
          alignSelf: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 20,
          backgroundColor: "#F1F3F4",
        },
      ]}
    >
      <Monitor size={13} color={colors.muted} />
      <Text style={{ fontSize: 12, color: colors.muted }}>Computer · {status}</Text>
      <View
        style={{
          width: 5,
          height: 5,
          borderRadius: 3,
          backgroundColor: available ? "#57AD85" : "#ACB0B5",
        }}
      />
    </Pressable>
  );
}
export function BrowserThreadCard({ browser }: { browser: BrowserSession }) {
  const { open } = useWorkspace();
  const { running, takeControl } = useContext(BrowserRunContext);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [browser.previewUrl, browser.updatedAt]);
  const takeOver = () => (takeControl ? takeControl(browser) : open({ type: "browser", browser }));
  return (
    <Card
      style={{ padding: 13, backgroundColor: "#EEEEF0", gap: 12, maxWidth: 440, width: "100%" }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 9 }]}>
          <Globe2 size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>Browser</Text>
          <Text numberOfLines={1} style={s.small}>
            {browser.status === "closed"
              ? "Session saved"
              : browser.status === "error"
                ? "Needs attention"
                : browser.title}
          </Text>
        </View>
      </View>
      {browser.previewUrl && browser.status === "active" && !failed ? (
        <Image
          accessibilityLabel={`Browser preview: ${browser.title}`}
          source={{ uri: browser.previewUrl }}
          style={{ width: "100%", aspectRatio: 1.6, borderRadius: 11, backgroundColor: "#FFF" }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <View
          style={{
            padding: 24,
            borderRadius: 12,
            backgroundColor: "#FFF",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Globe2 size={30} color={colors.muted} />
          <Text numberOfLines={2} style={[s.muted, { textAlign: "center" }]}>
            {failed ? "Preview unavailable. Open the browser to reconnect." : browser.url}
          </Text>
        </View>
      )}
      <Button onPress={takeOver}>
        {browser.status === "closed"
          ? "Reopen browser"
          : browser.status === "error"
            ? "Reconnect browser"
            : running
              ? "Take control · pauses the agent"
              : "Take control"}
      </Button>
    </Card>
  );
}
export function DeviceThreadCard({ device }: { device: DeviceSession }) {
  const { api, open } = useWorkspace();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [device.previewUrl, device.updatedAt]);
  const subtitle =
    device.status === "closed"
      ? "Session saved"
      : device.status === "error"
        ? "Needs attention"
        : device.status === "idle"
          ? "Ready"
          : device.title;
  return (
    <Card
      style={{ padding: 13, backgroundColor: "#EEEEF0", gap: 12, maxWidth: 440, width: "100%" }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 9 }]}>
          <Smartphone size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>Phone</Text>
          <Text numberOfLines={1} style={s.small}>
            {subtitle}
          </Text>
        </View>
      </View>
      {device.previewUrl && device.status === "active" && !failed ? (
        <Image
          accessibilityLabel={`Phone preview: ${device.title}`}
          source={{ uri: api.url(device.previewUrl) }}
          style={{
            width: "100%",
            aspectRatio: 9 / 16,
            maxHeight: 320,
            borderRadius: 11,
            backgroundColor: "#FFF",
          }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <View
          style={{
            padding: 24,
            borderRadius: 12,
            backgroundColor: "#FFF",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Smartphone size={30} color={colors.muted} />
          <Text numberOfLines={2} style={[s.muted, { textAlign: "center" }]}>
            {failed ? "Preview unavailable. Open the phone to reconnect." : device.packageOrUrl}
          </Text>
        </View>
      )}
      <Button onPress={() => open({ type: "device", device })}>
        {device.status === "closed"
          ? "Reopen phone"
          : device.status === "error"
            ? "Reconnect phone"
            : "Take control"}
      </Button>
    </Card>
  );
}
const tabIcons = {
  Browser: Globe2,
  Phone: Smartphone,
  Desktop: Monitor,
  Terminal,
  Files: FolderOpen,
} as const;
export function ComputerSheet() {
  const { workspace, api, refresh, close, open, navigate } = useWorkspace();
  const [url, setUrl] = useState("");
  const [intent, setIntent] = useState("");
  const [pair, setPair] = useState<{ code: string; prefix: string; expiresAt: string } | null>(
    null,
  );
  const [pairBusy, setPairBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useComputerDraft("tab");
  // Unknown until the first snapshot, so a remembered Desktop tab survives reopening.
  const [desktop, setDesktop] = useState<boolean>();
  const onSnapshot = useCallback((snapshot: ComputerSnapshot) => {
    // A transient provider error keeps the last known state instead of closing the tab.
    if (snapshot.status !== "error")
      setDesktop(snapshot.provider === "e2b-desktop" && snapshot.status === "running");
  }, []);
  const deviceEnabled = workspace.connections.some(
    (c) => c.id === "device" && c.status !== "unconfigured",
  );
  const deviceAvailable = workspace.connections.some(
    (c) => c.id === "device" && (c.status === "connected" || c.status === "unavailable"),
  );
  // A remembered Desktop tab falls back to Terminal while the desktop is off; the draft
  // keeps "Desktop", so the tab returns by itself once the computer runs again.
  // A remembered Phone tab falls back to Browser while the phone worker is disabled.
  const afterDesktop = desktop === false && tab === "Desktop" ? "Terminal" : tab;
  const shown = !deviceEnabled && afterDesktop === "Phone" ? "Browser" : afterDesktop;
  const baseTabs = desktop
    ? (["Browser", "Desktop", "Terminal", "Files"] as const)
    : (["Browser", "Terminal", "Files"] as const);
  const tabs = deviceEnabled ? (["Browser", "Phone", ...baseTabs.slice(1)] as const) : baseTabs;
  const available = workspace.connections.some(
    (c) => c.id === "browser" && c.status === "connected",
  );
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      void refresh().catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  async function create() {
    if (busy || !url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", {
        url: browserAddress(url),
      });
      await refresh();
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function createDevice() {
    if (busy || !intent.trim()) return;
    setBusy(true);
    setError("");
    try {
      const session = await api.request<DeviceSession>("/api/devices", {
        packageOrUrl: intent.trim(),
      });
      setIntent("");
      await refresh();
      open({ type: "device", device: session });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function createPairing() {
    if (pairBusy) return;
    setPairBusy(true);
    setError("");
    try {
      const result = await api.request<{ code: string; prefix: string; expiresAt: string }>(
        "/api/devices/pair",
        {},
      );
      setPair(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPairBusy(false);
    }
  }
  return (
    <Sheet
      title="Agent computer"
      subtitle="Your agent works here. Step in whenever you need."
      onClose={close}
    >
      <View style={{ gap: 20 }}>
        {shown === "Browser" && (
          <View
            style={[s.row, { gap: 12, padding: 18, borderRadius: 20, backgroundColor: colors.sky }]}
          >
            <Monitor size={28} color={colors.blueDark} />
            <View style={{ flex: 1 }}>
              <Text style={s.heading}>{available ? "Browser connected" : "Browser offline"}</Text>
              <Text style={s.muted}>
                {available
                  ? "Your agent’s browser and documents, in one place."
                  : "Start the browser worker to connect this computer."}
              </Text>
            </View>
          </View>
        )}
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {tabs.map((item) => (
            <Button
              key={item}
              primary={shown === item}
              icon={tabIcons[item]}
              onPress={() => setTab(item)}
            >
              {item}
            </Button>
          ))}
        </View>
        <View style={{ display: shown === "Browser" || shown === "Phone" ? "none" : "flex" }}>
          <LinuxWorkspace
            tab={shown === "Browser" || shown === "Phone" ? "Terminal" : shown}
            onSnapshot={onSnapshot}
          />
        </View>
        <ErrorNotice error={error} />
        {shown === "Phone" ? (
          <>
            {!deviceAvailable ? (
              <Card style={{ gap: 12 }}>
                <Text style={s.heading}>No device connected</Text>
                <Text style={s.muted}>
                  Pair your phone worker to take control from here. The code expires in 10 minutes
                  and only its prefix is shown after creation.
                </Text>
                {pair ? (
                  <View style={{ gap: 8 }}>
                    <Text selectable style={[s.text, { fontWeight: "600" }]}>
                      {pair.code}
                    </Text>
                    <Text style={s.small}>
                      Prefix {pair.prefix} · expires {pair.expiresAt}
                    </Text>
                    <Text style={s.small}>
                      Enter this code in the phone worker app to finish pairing.
                    </Text>
                  </View>
                ) : null}
                <Button
                  primary
                  icon={Smartphone}
                  busy={pairBusy}
                  disabled={pairBusy}
                  onPress={() => void createPairing()}
                >
                  Pair phone worker
                </Button>
              </Card>
            ) : (
              <>
                <View>
                  <Field
                    label="Link or app address"
                    value={intent}
                    onChangeText={setIntent}
                    placeholder="https://… or vnd.youtube:<id>"
                    autoCapitalize="none"
                    keyboardType="url"
                    onSubmitEditing={() => void createDevice()}
                  />
                  <Button
                    primary
                    icon={Plus}
                    busy={busy}
                    disabled={!intent.trim()}
                    onPress={() => void createDevice()}
                  >
                    Open on phone
                  </Button>
                </View>
                {(workspace.devices ?? [])
                  .slice()
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .map((item) => (
                    <DeviceThreadCard key={item.id} device={item} />
                  ))}
                {!(workspace.devices ?? []).length && (
                  <Text style={s.muted}>
                    No phone sessions yet. Open a link above and it will appear here.
                  </Text>
                )}
              </>
            )}
          </>
        ) : shown === "Browser" ? (
          <>
            <View>
              <Field
                label="Website address"
                value={url}
                onChangeText={setUrl}
                placeholder="https://example.com"
                autoCapitalize="none"
                keyboardType="url"
                onSubmitEditing={() => void create()}
              />
              <Button
                primary
                icon={Plus}
                busy={busy}
                disabled={!available || !url.trim()}
                onPress={() => void create()}
              >
                Open a browser session
              </Button>
            </View>
            {[...workspace.browsers]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((browser) => (
                <BrowserThreadCard key={browser.id} browser={browser} />
              ))}
            {!workspace.browsers.length && (
              <Text style={s.muted}>
                Open a page here or ask your agent to research something. Its browsing sessions will
                appear here.
              </Text>
            )}
            <Text style={s.small}>
              Browsing sessions keep their own logins and downloads. Open one to take over, then
              return to your conversation.
            </Text>
          </>
        ) : tab === "Files" ? (
          <>
            <Text style={s.heading}>Documents</Text>
            <Text style={s.small}>PDFs saved from mail, browser downloads, and your uploads.</Text>
            {workspace.files.map((file) => (
              <LinkRow
                key={file.id}
                icon={FileText}
                title={file.name}
                detail={describeFile(file)}
                onPress={() => open({ type: "file", file })}
              />
            ))}
            <Button
              icon={Plus}
              onPress={() => {
                close();
                navigate("files");
              }}
            >
              Import a document
            </Button>
          </>
        ) : null}
        <Button
          small
          icon={RefreshCw}
          onPress={() =>
            void refresh()
              .then(() => setError(""))
              .catch((e) => setError(String(e)))
          }
        >
          Refresh computer
        </Button>
      </View>
    </Sheet>
  );
}
