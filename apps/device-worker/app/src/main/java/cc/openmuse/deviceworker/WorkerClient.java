package cc.openmuse.deviceworker;

import android.content.Intent;
import android.media.AudioManager;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Outbound WS client speaking the server relay protocol over a raw socket
 * (no third-party dependencies): `{type:"request"|"ping"|...}` in,
 * `{type:"response"|"pong"|...}` out. First connect carries
 * `?code=ot-pair-*` and receives `{type:"registered", token}`; later connects
 * carry `?token=ot-dev-*` and receive `{type:"hello"}`.
 */
public class WorkerClient {

    public interface PhoneActions {
        JSONObject handleRequest(String path, JSONObject body) throws Exception;

        byte[] handleBytes(String path, JSONObject body) throws Exception;
    }

    public interface TokenStore {
        String load();

        void save(String token);
    }

    public interface Events {
        void onState(String state, String detail);
    }

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private final String serverHost;
    private final PhoneActions actions;
    private final TokenStore tokens;
    private final Events events;
    private final ScheduledExecutorService bg = Executors.newSingleThreadScheduledExecutor();
    private volatile Socket socket;
    private final AtomicBoolean reconnectQueued = new AtomicBoolean(false);
    private volatile boolean shutdown;

    public WorkerClient(String serverHost, PhoneActions actions, TokenStore tokens,
            Events events) {
        this.serverHost = serverHost;
        this.actions = actions;
        this.tokens = tokens;
        this.events = events;
    }

    public void connect() {
        bg.execute(() -> {
            if (shutdown) {
                return;
            }
            String token = tokens.load();
            if (token == null) {
                events.onState("disconnected", "no token yet — pair first");
                return;
            }
            dial("token=" + Uri.encode(token));
        });
    }

    public void pairAndConnect(String code) {
        bg.execute(() -> {
            if (!shutdown) {
                dial("code=" + Uri.encode(code.trim()));
            }
        });
    }

    public void shutdown() {
        shutdown = true;
        stopPinger();
        closeSocket();
        bg.shutdownNow();
    }

    private void dial(String query) {
        closeSocket();
        startPinger();
        try {
            String bare = serverHost.replaceFirst("^https?://", "").replaceAll("/+$", "");
            boolean tls = serverHost.startsWith("https://");
            String hostPort = bare.split("/")[0];
            String host = hostPort;
            int port = tls ? 443 : 80;
            int colon = hostPort.lastIndexOf(':');
            if (colon >= 0) {
                host = hostPort.substring(0, colon);
                port = Integer.parseInt(hostPort.substring(colon + 1));
            }
            String path = "/api/devices/register?" + query;
            events.onState("connecting", host);
            Socket raw = new Socket();
            raw.connect(new InetSocketAddress(host, port), 15000);
            final Socket connected;
            if (tls) {
                SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault())
                        .createSocket(raw, host, port, true);
                ssl.setSoTimeout(0);
                ssl.startHandshake();
                connected = ssl;
            } else {
                connected = raw;
            }
            // Opening handshake.
            byte[] keyBytes = new byte[16];
            new SecureRandom().nextBytes(keyBytes);
            String key = Base64.encodeToString(keyBytes, Base64.NO_WRAP);
            OutputStream out = connected.getOutputStream();
            String handshake = "GET " + path + " HTTP/1.1\r\n"
                    + "Host: " + host + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + key + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n\r\n";
            out.write(handshake.getBytes(StandardCharsets.US_ASCII));
            out.flush();
            InputStream in = connected.getInputStream();
            String status = readAsciiLine(in, 8192);
            if (status == null || !status.contains("101")) {
                throw new IllegalStateException("relay handshake failed: " + status);
            }
            String accept = null;
            for (;;) {
                String line = readAsciiLine(in, 8192);
                if (line == null || line.isEmpty()) {
                    break;
                }
                if (line.regionMatches(true, 0, "Sec-WebSocket-Accept:", 0, 21)) {
                    accept = line.substring(21).trim();
                }
            }
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((key + GUID).getBytes(StandardCharsets.US_ASCII));
            String expected = Base64.encodeToString(digest, Base64.NO_WRAP);
            if (!expected.equals(accept)) {
                throw new IllegalStateException("relay handshake accept mismatch");
            }
            socket = connected;
            events.onState("waiting for registration", "");
            readLoop(connected, in);
        } catch (Exception e) {
            closeSocket();
            events.onState("disconnected",
                    e.getMessage() != null ? e.getMessage() : "connection failed");
            scheduleReconnect();
        }
    }

    private void readLoop(Socket active, InputStream in) {
        try {
            for (;;) {
                Frame frame = readFrame(in);
                if (frame == null) {
                    break;
                }
                if (frame.opcode == 0x8) {
                    break;
                }
                if (frame.opcode == 0x9) {
                    sendFrame(0xA, frame.payload);
                    continue;
                }
                if (frame.opcode != 0x1 && frame.opcode != 0x2) {
                    continue;
                }
                handleMessage(new String(frame.payload, StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            // Falls through to reconnect.
        } finally {
            if (socket == active) {
                closeSocket();
                events.onState("disconnected", "relay closed");
                scheduleReconnect();
            }
        }
    }

    private void handleMessage(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type");
            if ("registered".equals(type)) {
                tokens.save(msg.getString("token"));
                events.onState("connected", "");
            } else if ("hello".equals(type)) {
                events.onState("connected", "");
            } else if ("ping".equals(type)) {
                sendText(new JSONObject().put("type", "pong")
                        .put("id", msg.optString("id")).toString());
            } else if ("request".equals(type)) {
                handleRemote(msg);
            }
        } catch (Exception ignored) {
        }
    }

    private void handleRemote(JSONObject msg) {
        String id = msg.optString("id");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString();
        }
        String path = msg.optString("path");
        JSONObject body = null;
        String raw = msg.optString("body");
        try {
            if (!raw.isEmpty()) {
                body = new JSONObject(raw);
            }
            JSONObject json = actions.handleRequest(path, body);
            byte[] bytes = json != null ? json.toString().getBytes(StandardCharsets.UTF_8)
                    : actions.handleBytes(path, body);
            JSONObject out = new JSONObject().put("type", "response").put("id", id)
                    .put("status", bytes != null ? 200 : 404);
            if (bytes != null) {
                out.put("bodyB64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            }
            sendText(out.toString());
        } catch (Exception e) {
            try {
                JSONObject err = new JSONObject().put("error",
                        new JSONObject().put("message",
                                e.getMessage() != null ? e.getMessage() : "failed"));
                sendText(new JSONObject().put("type", "response").put("id", id)
                        .put("status", 502)
                        .put("bodyB64", Base64.encodeToString(
                                err.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP))
                        .toString());
            } catch (Exception ignored) {
            }
        }
    }

    private void sendText(String text) {
        sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    private synchronized void sendFrame(int opcode, byte[] payload) {
        Socket active = socket;
        if (active == null || active.isClosed()) {
            return;
        }
        if (opcode == 0x1 && payload.length > 65535) {
            android.util.Log.d(
                    "WorkerClient",
                    "send text frame len=" + payload.length);
        }
        try {
            // Buffer the whole frame: per-byte writes would be thousands of syscalls.
            ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
            frame.write(0x80 | opcode);
            if (payload.length < 126) {
                frame.write(0x80 | payload.length);
            } else if (payload.length <= 0xFFFF) {
                frame.write(0x80 | 126);
                frame.write((payload.length >> 8) & 0xFF);
                frame.write(payload.length & 0xFF);
            } else {
                // 64-bit length, all-int shifts (never shift an int by >= 32:
                // D8 miscompiles (int)((x >> longShift) & 0xFF) into int-shift semantics).
                frame.write(0x80 | 127);
                frame.write(0);
                frame.write(0);
                frame.write(0);
                frame.write(0);
                frame.write((payload.length >> 24) & 0xFF);
                frame.write((payload.length >> 16) & 0xFF);
                frame.write((payload.length >> 8) & 0xFF);
                frame.write(payload.length & 0xFF);
            }
            byte[] mask = new byte[4];
            new SecureRandom().nextBytes(mask);
            frame.write(mask, 0, 4);
            for (int i = 0; i < payload.length; i++) {
                frame.write(payload[i] ^ mask[i % 4]);
            }
            OutputStream out = active.getOutputStream();
            byte[] raw = frame.toByteArray();
            if (opcode == 0x1 && payload.length > 65535) {
                StringBuilder head = new StringBuilder();
                for (int i = 0; i < Math.min(16, raw.length); i++) {
                    head.append(String.format("%02x", raw[i]));
                }
                android.util.Log.d(
                        "WorkerClient", "send big frame payload=" + payload.length + " head=" + head);
            }
            out.write(raw);
            out.flush();
        } catch (Exception e) {
            closeSocket();
        }
    }

    private static class Frame {
        int opcode;
        byte[] payload;
    }

    private static Frame readFrame(InputStream in) throws Exception {
        int first = in.read();
        if (first < 0) {
            return null;
        }
        int opcode = first & 0x0F;
        boolean fin = (first & 0x80) != 0;
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        int current = opcode;
        for (;;) {
            int second = in.read();
            if (second < 0) {
                throw new EOFException();
            }
            boolean masked = (second & 0x80) != 0;
            long length = second & 0x7F;
            if (length == 126) {
                length = (readByte(in) << 8) | readByte(in);
            } else if (length == 127) {
                length = 0;
                for (int i = 0; i < 8; i++) {
                    length = (length << 8) | readByte(in);
                }
            }
            if (length > 32 * 1024 * 1024) {
                throw new IllegalStateException("frame too large");
            }
            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(in, mask, 0, 4);
            }
            byte[] payload = new byte[(int) length];
            readFully(in, payload, 0, payload.length);
            if (masked) {
                for (int i = 0; i < payload.length; i++) {
                    payload[i] ^= mask[i % 4];
                }
            }
            if (current == 0x1 || current == 0x2 || current == 0x0) {
                message.write(payload, 0, payload.length);
            }
            if (fin) {
                Frame frame = new Frame();
                frame.opcode = current == 0x0 ? 0x1 : current;
                frame.payload = message.toByteArray();
                return frame;
            }
            int next = in.read();
            if (next < 0) {
                throw new EOFException();
            }
            fin = (next & 0x80) != 0;
            current = next & 0x0F;
        }
    }

    private static int readByte(InputStream in) throws Exception {
        int value = in.read();
        if (value < 0) {
            throw new EOFException();
        }
        return value;
    }

    private static void readFully(InputStream in, byte[] buffer, int offset, int length)
            throws Exception {
        while (length > 0) {
            int read = in.read(buffer, offset, length);
            if (read < 0) {
                throw new EOFException();
            }
            offset += read;
            length -= read;
        }
    }

    private static String readAsciiLine(InputStream in, int max) throws Exception {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int previous = -1;
        for (;;) {
            int next = in.read();
            if (next < 0) {
                return line.size() == 0 ? null : line.toString("US-ASCII");
            }
            if (next == '\n' && previous == '\r') {
                byte[] raw = line.toByteArray();
                return new String(raw, 0, raw.length - 1, StandardCharsets.US_ASCII);
            }
            line.write(next);
            previous = next;
            if (line.size() > max) {
                throw new IllegalStateException("line too long");
            }
        }
    }

    private void closeSocket() {
        Socket active = socket;
        socket = null;
        if (active != null) {
            try {
                active.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void scheduleReconnect() {
        if (shutdown || !reconnectQueued.compareAndSet(false, true)) {
            return;
        }
        bg.schedule(() -> {
            reconnectQueued.set(false);
            if (!shutdown) {
                connect();
            }
        }, 5, TimeUnit.SECONDS);
    }

    /** Client-initiated keepalive so middleboxes never see an idle relay socket. */
    private volatile ScheduledExecutorService pinger;

    private synchronized void startPinger() {
        stopPinger();
        ScheduledExecutorService ping = Executors.newSingleThreadScheduledExecutor();
        pinger = ping;
        ping.scheduleAtFixedRate(() -> {
            try {
                sendText(new JSONObject().put("type", "ping")
                        .put("id", UUID.randomUUID().toString()).toString());
            } catch (Exception ignored) {
            }
        }, 25, 25, TimeUnit.SECONDS);
    }

    private synchronized void stopPinger() {
        ScheduledExecutorService ping = pinger;
        pinger = null;
        if (ping != null) {
            ping.shutdownNow();
        }
    }

    /** Playback state for the observe receipt (no OCR). */
    static String playbackState(AudioManager audio, MediaSessionManager sessions) {
        try {
            for (android.media.session.MediaController controller : sessions
                    .getActiveSessions(null)) {
                PlaybackState state = controller.getPlaybackState();
                if (state == null) {
                    continue;
                }
                switch (state.getState()) {
                    case PlaybackState.STATE_PLAYING:
                        return "playing";
                    case PlaybackState.STATE_PAUSED:
                        return "paused";
                    case PlaybackState.STATE_STOPPED:
                        return "stopped";
                    default:
                        break;
                }
            }
        } catch (Exception ignored) {
            // getActiveSessions needs a notification listener; fall through.
        }
        try {
            return audio.isMusicActive() ? "playing" : "idle";
        } catch (Exception ignored) {
            return "idle";
        }
    }

    static Intent launchIntent(String intentUri) {
        Intent intent;
        if (intentUri.startsWith("vnd.youtube:")) {
            String id = intentUri.substring("vnd.youtube:".length());
            intent = new Intent(Intent.ACTION_VIEW, Uri.parse("vnd.youtube:" + id));
        } else {
            intent = new Intent(Intent.ACTION_VIEW, Uri.parse(intentUri));
        }
        return intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }
}
