import { z } from "zod";

export type WorkspaceMode = "sample" | "live";
export type Section =
  | "today"
  | "chat"
  | "mail"
  | "calendar"
  | "browser"
  | "files"
  | "activity"
  | "connections"
  | "ideas"
  | "goals"
  | "apps";
export interface Mail {
  id: string;
  threadId: string;
  from: string;
  sender: string;
  to: string[];
  subject: string;
  body: string;
  date: string;
  unread: boolean;
  label: string;
  attachments: string[];
}
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  location: string;
  description: string;
  attendees: string[];
}
export const calendarRangeSchema = z
  .object({
    timeMin: z.iso.datetime({ offset: true }),
    timeMax: z.iso.datetime({ offset: true }),
  })
  .refine(({ timeMin, timeMax }) => {
    const duration = Date.parse(timeMax) - Date.parse(timeMin);
    return duration > 0 && duration <= 366 * 86400000;
  }, "Calendar range must end after it starts and span at most 366 days");
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount: number;
  url: string;
  createdAt: string;
  source: string;
  parentId?: string;
  fields?: { name: string; value: string; type: "text" | "checkbox" | "unsupported" }[];
}
export interface BrowserSession {
  id: string;
  title: string;
  url: string;
  status: "idle" | "active" | "closed" | "error";
  updatedAt: string;
  previewUrl?: string;
  consoleUrl?: string;
  streamUrl?: string;
}
export interface DeviceSession {
  id: string;
  title: string;
  packageOrUrl: string;
  status: "idle" | "active" | "closed" | "error";
  updatedAt: string;
  previewUrl?: string;
  consoleUrl?: string;
}
export const emailDraftSchema = z.object({
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).default([]),
  bcc: z.array(z.email()).max(50).default([]),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(998)
    .refine((s) => !/[\r\n]/.test(s), "Subject must be a single line"),
  body: z.string().min(1).max(100000),
  attachmentIds: z.array(z.string()).max(10).default([]),
  threadId: z.string().optional(),
  replyToMessageId: z.string().optional(),
});
export const eventDraftSchema = z
  .object({
    calendarId: z.string().default("primary"),
    title: z.string().trim().min(1).max(500),
    start: z.string().min(1),
    end: z.string().min(1),
    allDay: z.boolean().default(false),
    timeZone: z.string().default("America/Los_Angeles"),
    location: z.string().max(2000).default(""),
    description: z.string().max(10000).default(""),
    attendees: z.array(z.email()).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      !Number.isFinite(Date.parse(value.start)) ||
      !Number.isFinite(Date.parse(value.end)) ||
      Date.parse(value.end) <= Date.parse(value.start)
    ) {
      ctx.addIssue({ code: "custom", message: "End must be after a valid start", path: ["end"] });
    }
    const dateOnly = z.iso.date();
    const timed = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
    // Validate the calendar date separately so timed values can retain minute precision.
    const validTimestamp = (timestamp: string) =>
      value.allDay
        ? dateOnly.safeParse(timestamp).success
        : timed.test(timestamp) && dateOnly.safeParse(timestamp.slice(0, 10)).success;
    if (!validTimestamp(value.start) || !validTimestamp(value.end)) {
      ctx.addIssue({
        code: "custom",
        message: value.allDay
          ? "All-day events need valid date-only values"
          : "Timed events need valid date-times with an explicit offset",
        path: ["start"],
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid time zone", path: ["timeZone"] });
    }
  });
export const deviceTapSchema = z.object({
  type: z.literal("tap"),
  x: z.number().int().min(0).max(4000),
  y: z.number().int().min(0).max(4000),
});
export const deviceSwipeSchema = z.object({
  type: z.literal("swipe"),
  x1: z.number().int().min(0).max(4000),
  y1: z.number().int().min(0).max(4000),
  x2: z.number().int().min(0).max(4000),
  y2: z.number().int().min(0).max(4000),
  durationMs: z.number().int().min(50).max(5000).default(250),
});
export const deviceTextSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(10000),
});
export const deviceKeySchema = z.object({
  type: z.literal("key"),
  key: z.enum(["back", "home", "recents", "play_pause", "Enter", "Tab", "Backspace"]),
});
/** Phone input shapes shared by the worker API, the PWA console and agent proposals. */
export const deviceInputSchema = z.discriminatedUnion("type", [
  deviceTapSchema,
  deviceSwipeSchema,
  deviceTextSchema,
  deviceKeySchema,
]);
export type DeviceInput = z.infer<typeof deviceInputSchema>;
/** Read-only phone observation requested by the agent or chat. */
export const deviceObserveSchema = z.object({
  sessionId: z.string().min(1).max(200).optional(),
  intentUri: z.string().min(1).max(4096).optional(),
});
export type DeviceObserve = z.infer<typeof deviceObserveSchema>;
/** Approval-gated phone control. The session is resolved from sessionId,
 * the task's phone, or a fresh launch of intentUri. */
export const deviceActionSchema = z
  .object({
    sessionId: z.string().min(1).max(200).optional(),
    intentUri: z.string().min(1).max(4096).optional(),
    action: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("launch"),
        intentUri: z.string().min(1).max(4096).optional(),
      }),
      deviceTapSchema,
      deviceSwipeSchema,
      deviceTextSchema,
      deviceKeySchema,
    ]),
  })
  .superRefine((value, ctx) => {
    if (!value.sessionId && !value.intentUri && value.action.type !== "launch")
      ctx.addIssue({
        code: "custom",
        message: "Open the phone on a link or app first, or pass its sessionId",
      });
    if (value.action.type === "launch" && !value.action.intentUri && !value.intentUri)
      ctx.addIssue({ code: "custom", message: "A launch needs the link or app address to open" });
  });
export type DeviceAction = z.infer<typeof deviceActionSchema>;
export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email.send"), data: emailDraftSchema }),
  z.object({ kind: z.literal("calendar.create"), data: eventDraftSchema }),
  z.object({
    kind: z.literal("calendar.update"),
    data: eventDraftSchema.and(z.object({ eventId: z.string().min(1) })),
  }),
  z.object({
    kind: z.literal("calendar.delete"),
    data: z.object({ calendarId: z.string(), eventId: z.string().min(1), title: z.string() }),
  }),
  z.object({ kind: z.literal("device.action"), data: deviceActionSchema }),
]);
export type EmailDraft = z.infer<typeof emailDraftSchema>;
export type EventDraft = z.infer<typeof eventDraftSchema>;
export type ProposalInput = z.infer<typeof proposalSchema>;
export interface ActionProposal {
  target?: CalendarEvent;
  targetVersion?: string;
  taskId?: string;
  account?: string;
  connectionId?: string;
  id: string;
  title: string;
  kind: ProposalInput["kind"];
  data: Record<string, unknown>;
  status:
    | "awaiting_review"
    | "executing"
    | "succeeded"
    | "failed"
    | "outcome_unknown"
    | "denied"
    | "cancelled"
    | "expired";
  hash: string;
  createdAt: string;
  expiresAt: string;
  result?: string;
  error?: string;
}
export interface ActivityEntry {
  id: string;
  title: string;
  detail: string;
  date: string;
  status: string;
  actionId?: string;
}
export interface Connection {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "sample" | "unconfigured" | "unavailable";
  account?: string;
  capabilities: string[];
}
export interface Workspace {
  mode: WorkspaceMode;
  profile: { name: string; email: string };
  mail: Mail[];
  events: CalendarEvent[];
  files: Artifact[];
  browsers: BrowserSession[];
  devices: DeviceSession[];
  actions: ActionProposal[];
  activity: ActivityEntry[];
  connections: Connection[];
  runtime: {
    provider: "sample" | "model" | "openbot";
    configured: boolean;
    openbotConfigured: boolean;
    richThreads?: boolean;
  };
}

/** Provider-independent boundary: OpenBot/AG-UI runs never dictate presentation. */
export interface ExecutionBackend {
  readonly kind: "standalone" | "openbot";
  readonly capabilities: readonly string[];
  health(): Promise<{ available: boolean; detail: string }>;
}

export type { ComputerCommand, ComputerDirectory, ComputerSnapshot } from "./computer.ts";
