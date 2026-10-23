# OpenMuse phone worker (APK)

Android companion for the OpenMuse server. The PWA never touches the phone directly; the
server relays to this paired worker. Kotlin sources live in
`app/src/main/java/cc/openmuse/deviceworker/`; they need the Android SDK to build and are
not covered by the repo's `pnpm test`.

## Transports

1. **Paired WS relay (primary).** `POST /api/devices/pair` issues a single-use `ot-pair-<hex>`
   (10-min TTL, SHA-256 hashed in DB). The APK dials outbound
   `wss://<host>/api/devices/register?code=ot-pair-…`, the server consumes the code and answers
   `{ type: "registered", token }` over the socket. Later connects use `?token=ot-dev-…` and get
   `{ type: "hello", resumed: true }`. Requests multiplex as
   `{ type: "request", id, method, path, body }` with
   `{ type: "response", id, status, bodyB64 }` replies plus `ping`/`pong` keepalive — no inbound
   port to the phone. A server restart drops the in-memory code/token bindings, so the APK
   re-pairs (the stored `ot-dev-*` token is kept for the HTTP fallback only).
2. **HTTP fallback (dev/ADB).** When no WS relay is connected for the owner and
   `DEVICE_WORKER_URL` + `WORKER_TOKEN` are set, the server dispatches HTTP requests to
   `DEVICE_WORKER_URL`. Local ADB development reaches the phone's loopback server via
   `adb forward tcp:8791 tcp:8791` (host port forwards to the phone); the loopback server requires
   `Authorization: Bearer <WORKER_TOKEN>`.

## Minimal API v1

All endpoints except `GET /health` require `Authorization: Bearer <WORKER_TOKEN>` (HTTP
fallback) or the paired `ot-dev-*` token (WS relay).

| Method | Path | Input / response |
| --- | --- | --- |
| GET | `/health` | `{ status: "ok", screenWidth, screenHeight }` |
| GET | `/screenshot` | PNG bytes (device resolution) |
| GET | `/uidump` | Compact interactive/labeled node tree, capped at 30k chars |
| POST | `/input` | `{ type: "tap", x, y }` \| `{ type: "swipe", x1, y1, x2, y2, durationMs }` \| `{ type: "text", text }` \| `{ type: "key", key }` → `DeviceSession` |
| POST | `/launch` | `{ intentUri }` (`https`, `http`, `vnd.youtube` allowlist + `FLAG_ACTIVITY_NEW_TASK`) → `DeviceSession` |

Server session shape: `{ id, title, packageOrUrl, status: "idle" | "active" | "closed" | "error", updatedAt }`.
Per-session paths mirror the browser worker: `GET /sessions/:id/screenshot`,
`GET /sessions/:id/uidump`, `POST /sessions/:id/input`, `POST /sessions/:id/launch`,
`POST /sessions/:id/close`.

YouTube v1: `launch { intentUri: "vnd.youtube:<id>" }` + `tap` + `AudioManager` /
`MediaSessionManager` playback state. No OCR.

## Android implementation (new, separate from PWA)

- Standalone Gradle project (Kotlin, `minSdk 30`, not Expo): `build.gradle.kts`,
  `settings.gradle.kts`, `app/src/main/AndroidManifest.xml`.
- `WorkerAccessibilityService` — gestures, `takeScreenshot()` (API 30+, no per-session
  MediaProjection prompt), and the interactive/labeled node tree for uidump.
- `WorkerForegroundService` — holds the relay socket, serves loopback HTTP on
  `127.0.0.1:8791`, routes `/sessions/*` against an in-memory session store.
- `WorkerClient` — OkHttp WS client, pairing-code exchange, reconnect backoff, playback state
  via `AudioManager` / `MediaSessionManager` (no OCR).
- `MainActivity` — manual grants checklist (Accessibility Service enabled + battery
  optimization disabled), server host + pairing-code entry.
- Uses `AccessibilityService.takeScreenshot()` (Android 11+ / API 30) instead of
  `MediaProjection` in v1 — captures the screen using the same Accessibility grant required
  for gestures/`uidump` without per-session system projection prompts.

## Rollout

1. **Flag `DEVICE_ENABLED=false` (default).** Domain + server (`/api/devices/*`, `device.ts`,
   `device-console.ts`) + PWA UI shell with `No device connected` + `tests/device.test.ts`.
2. **Manual control E2E.** Pair (`ot-pair-*` QR or `DEVICE_WORKER_URL` ADB forward) → screenshot →
   tap/swipe → launch YouTube (`vnd.youtube:<id>`).
3. **Agent tools + receipts.** Phase 2 tools (`device_observe` read-only + approval-gated
   `device.action`), approval flow, and `DeviceToolCard` / task detail integration.
