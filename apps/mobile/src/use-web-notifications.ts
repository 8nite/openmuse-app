import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { notifyUser } from "./web-notify";

function tabHidden() {
  return typeof document !== "undefined" && document.hidden;
}

// Agent inbox + approval/input transitions -> OS notification (web only, tab hidden).
export function useAgentNotifications(
  notifications: { id: string; title: string; body: string; read: boolean }[] = [],
  tasks: { id: string; title: string; status: string }[] = [],
) {
  const seenNotifications = useRef<Set<string> | null>(null);
  const taskStatus = useRef(new Map<string, string>());
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (seenNotifications.current === null) {
      // Baseline on first load: don't notify for history.
      seenNotifications.current = new Set(notifications.map((n) => n.id));
      for (const t of tasks) taskStatus.current.set(t.id, t.status);
      return;
    }
    if (!tabHidden()) {
      for (const n of notifications) seenNotifications.current.add(n.id);
      for (const t of tasks) taskStatus.current.set(t.id, t.status);
      return;
    }
    for (const n of notifications) {
      if (!n.read && !seenNotifications.current.has(n.id)) {
        seenNotifications.current.add(n.id);
        void notifyUser(n.title, n.body, `openmuse-notif-${n.id}`);
      }
    }
    for (const t of tasks) {
      const prev = taskStatus.current.get(t.id);
      taskStatus.current.set(t.id, t.status);
      if (prev === t.status) continue;
      if (t.status === "waiting_approval")
        void notifyUser("Ready to review", t.title, `openmuse-task-${t.id}`);
      else if (t.status === "waiting_input")
        void notifyUser("Needs your input", t.title, `openmuse-task-${t.id}`);
      else if ((t.status === "succeeded" || t.status === "failed") && prev && prev !== t.status)
        void notifyUser(
          t.status === "succeeded" ? "Task finished" : "Task needs attention",
          t.title,
          `openmuse-task-${t.id}`,
        );
    }
  }, [notifications, tasks]);
}

type ChatMessage = { id: string; role: string; content?: unknown };

// New assistant text while the tab is hidden -> OS notification (web only).
export function useChatReplyNotifications(messages: ChatMessage[]) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (seen.current === null) {
      seen.current = new Set(messages.map((m) => m.id));
      return;
    }
    if (!tabHidden()) {
      for (const m of messages) seen.current.add(m.id);
      return;
    }
    for (const m of messages) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
        void notifyUser("OpenMuse", m.content.slice(0, 180), `openmuse-chat-${m.id}`);
      }
    }
  }, [messages]);
}
