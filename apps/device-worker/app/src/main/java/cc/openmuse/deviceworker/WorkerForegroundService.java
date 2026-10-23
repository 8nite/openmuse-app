package cc.openmuse.deviceworker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.media.session.MediaSessionManager;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground service holding the outbound relay socket (primary) and an
 * optional loopback HTTP server on 127.0.0.1:8791 for ADB dev mode
 * (`adb forward tcp:8791 tcp:8791`).
 */
public class WorkerForegroundService extends Service {

    public static final String ACTION_PAIR = "cc.openmuse.deviceworker.PAIR";
    public static final String ACTION_CONNECT = "cc.openmuse.deviceworker.CONNECT";
    public static final String EXTRA_HOST = "host";
    public static final String EXTRA_CODE = "code";

    private SharedPreferences prefs;
    private WorkerClient client;
    private LoopbackHttp http;

    /** Session store: id -> session object. */
    private final ConcurrentHashMap<String, JSONObject> sessions = new ConcurrentHashMap<>();

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("worker", Context.MODE_PRIVATE);
        ensureChannel();
        startForegroundCompat(notification("Starting…"));
        String host = prefs.getString("server_host", null);
        if (host != null) {
            startRelay(host);
        }
        http = new LoopbackHttp(this);
        http.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_PAIR.equals(intent.getAction())) {
            String host = intent.getStringExtra(EXTRA_HOST);
            String code = intent.getStringExtra(EXTRA_CODE);
            if (host == null || code == null) {
                return START_STICKY;
            }
            prefs.edit().putString("server_host", host).apply();
            startRelay(host);
            if (client != null) {
                client.pairAndConnect(code);
            }
            updateNotification("Pairing…");
        } else if (intent != null && ACTION_CONNECT.equals(intent.getAction())) {
            String host = prefs.getString("server_host", null);
            if (host == null) {
                return START_STICKY;
            }
            startRelay(host);
            if (client != null) {
                client.connect();
            }
        }
        return START_STICKY;
    }

    private void startRelay(String host) {
        if (client != null) {
            return;
        }
        final WorkerForegroundService service = this;
        client = new WorkerClient(host,
                new WorkerClient.PhoneActions() {
                    @Override
                    public JSONObject handleRequest(String path, JSONObject body)
                            throws Exception {
                        return service.dispatch(path, body);
                    }

                    @Override
                    public byte[] handleBytes(String path, JSONObject body) throws Exception {
                        if (!path.endsWith("/screenshot")) {
                            return null;
                        }
                        WorkerAccessibilityService accessibility =
                                WorkerAccessibilityService.getInstance();
                        if (accessibility == null) {
                            throw new IllegalStateException("Accessibility service is off");
                        }
                        return accessibility.screenshotPng();
                    }
                },
                new WorkerClient.TokenStore() {
                    @Override
                    public String load() {
                        return prefs.getString("device_token", null);
                    }

                    @Override
                    public void save(String token) {
                        prefs.edit().putString("device_token", token).apply();
                    }
                },
                new WorkerClient.Events() {
                    @Override
                    public void onState(String state, String detail) {
                        updateNotification(
                                detail == null || detail.isEmpty() ? state : state + " · " + detail);
                    }
                });
    }

    private JSONObject session(String id) {
        JSONObject existing = sessions.get(id);
        if (existing != null) {
            return existing;
        }
        JSONObject fresh = new JSONObject();
        try {
            fresh.put("id", id);
            fresh.put("title", "Phone session");
            fresh.put("packageOrUrl", "");
            fresh.put("status", "idle");
            fresh.put("updatedAt", Instant.now().toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        JSONObject raced = sessions.putIfAbsent(id, fresh);
        return raced != null ? raced : fresh;
    }

    /** Route one relay/HTTP request. Returns JSON, or null when it is binary. */
    JSONObject dispatch(String path, JSONObject body) throws Exception {
        WorkerAccessibilityService svc = WorkerAccessibilityService.getInstance();
        if (svc == null) {
            throw new IllegalStateException("Accessibility service is off");
        }
        if ("/health".equals(path)) {
            int[] size = svc.screenSize();
            return new JSONObject().put("status", "ok")
                    .put("screenWidth", size[0]).put("screenHeight", size[1]);
        }
        java.util.regex.Matcher create =
                java.util.regex.Pattern.compile("^/sessions$").matcher(path);
        if (create.matches() && body != null) {
            String id = body.getString("id");
            JSONObject session = session(id);
            String target = body.optString("intentUri", "");
            if (!target.isEmpty()) {
                openTarget(target);
            }
            session.put("packageOrUrl",
                    target.isEmpty() ? session.optString("packageOrUrl") : target);
            session.put("status", "active");
            session.put("updatedAt", Instant.now().toString());
            session.put("title", titleFor(session.optString("packageOrUrl")));
            return session;
        }
        java.util.regex.Matcher op =
                java.util.regex.Pattern.compile("^/sessions/([^/]+)/(launch|input|uidump|close|screenshot)$")
                        .matcher(path);
        if (!op.matches()) {
            throw new IllegalArgumentException("unknown path " + path);
        }
        String id = op.group(1);
        String action = op.group(2);
        JSONObject session = session(id);
        switch (action) {
            case "launch": {
                String target = body != null ? body.optString("intentUri", "") : "";
                if (target.isEmpty()) {
                    throw new IllegalArgumentException("intentUri is required");
                }
                openTarget(target);
                session.put("packageOrUrl", target);
                session.put("status", "active");
                session.put("updatedAt", Instant.now().toString());
                session.put("title", titleFor(target));
                return session;
            }
            case "input": {
                if (body == null) {
                    throw new IllegalArgumentException("input body is required");
                }
                if (!svc.perform(PhoneInput.parse(body))) {
                    throw new IllegalStateException("input was not applied");
                }
                session.put("status", "active");
                session.put("updatedAt", Instant.now().toString());
                return session;
            }
            case "uidump": {
                JSONObject dump = svc.uiDump(30000);
                AudioManager audio = getSystemService(AudioManager.class);
                MediaSessionManager sessions = getSystemService(MediaSessionManager.class);
                return new JSONObject()
                        .put("width", dump.optInt("width"))
                        .put("height", dump.optInt("height"))
                        .put("nodes", dump.optJSONArray("nodes") != null
                                ? dump.optJSONArray("nodes") : new JSONArray())
                        .put("text", dump.optJSONArray("nodes") != null
                                ? dump.optJSONArray("nodes").toString().substring(0,
                                        Math.min(30000, dump.optJSONArray("nodes").toString()
                                                .length()))
                                : "")
                        .put("mediaState", WorkerClient.playbackState(audio, sessions));
            }
            case "close": {
                session.put("status", "closed");
                session.put("updatedAt", Instant.now().toString());
                return session;
            }
            case "screenshot": {
                // Binary payload; served by handleBytes, not here.
                return null;
            }
            default:
                throw new IllegalArgumentException("unknown op " + action);
        }
    }

    private void openTarget(String target) {
        startActivity(WorkerClient.launchIntent(target));
    }

    private String titleFor(String target) {
        if (target.startsWith("vnd.youtube:")) {
            return "YouTube · " + target.substring("vnd.youtube:".length());
        }
        try {
            String host = android.net.Uri.parse(target).getHost();
            if (host == null) {
                return target;
            }
            return host.startsWith("www.") ? host.substring(4) : host;
        } catch (Exception e) {
            return target;
        }
    }

    private void updateNotification(String text) {
        ensureChannel();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(1, notification(text));
    }

    private void ensureChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("worker", "Phone worker",
                NotificationManager.IMPORTANCE_LOW));
    }

    private Notification notification(String text) {
        PendingIntent intent = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, "worker")
                .setContentTitle("OpenMuse phone worker")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentIntent(intent)
                .setOngoing(true);
        return builder.build();
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(1, notification);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (http != null) {
            http.stopServer();
        }
        if (client != null) {
            client.shutdown();
        }
        super.onDestroy();
    }

    /** Minimal loopback HTTP server for ADB dev mode. Bearer WORKER_TOKEN required. */
    static class LoopbackHttp extends Thread {
        private final WorkerForegroundService service;
        private ServerSocket server;
        private final AtomicBoolean running = new AtomicBoolean(false);

        LoopbackHttp(WorkerForegroundService service) {
            this.service = service;
        }

        @Override
        public void run() {
            try {
                server = new ServerSocket(8791, 0, InetAddress.getByName("127.0.0.1"));
            } catch (Exception e) {
                return;
            }
            running.set(true);
            while (running.get()) {
                try {
                    Socket socket = server.accept();
                    new Thread(() -> handle(socket)).start();
                } catch (Exception ignored) {
                }
            }
        }

        void stopServer() {
            running.set(false);
            try {
                if (server != null) {
                    server.close();
                }
            } catch (Exception ignored) {
            }
        }

        private void handle(Socket socket) {
            try {
                socket.setSoTimeout(15000);
                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                String requestLine = reader.readLine();
                if (requestLine == null) {
                    socket.close();
                    return;
                }
                String[] parts = requestLine.split(" ");
                if (parts.length < 2) {
                    socket.close();
                    return;
                }
                String rawPath = parts[1].split("\\?")[0];
                int contentLength = 0;
                String auth = "";
                for (;;) {
                    String line = reader.readLine();
                    if (line == null || line.isEmpty()) {
                        break;
                    }
                    String lower = line.toLowerCase(java.util.Locale.ROOT);
                    if (lower.startsWith("content-length:")) {
                        try {
                            contentLength = Integer.parseInt(line.substring(15).trim());
                        } catch (NumberFormatException ignored) {
                        }
                    } else if (lower.startsWith("authorization:")) {
                        auth = line.substring(14).trim();
                    }
                }
                String expected = service.prefs.getString("worker_token", null);
                if (expected == null || expected.isEmpty() || !auth.equals("Bearer " + expected)) {
                    reply(socket, 401, new JSONObject().put("error",
                            new JSONObject().put("message", "unauthorized")).toString()
                            .getBytes(StandardCharsets.UTF_8), "application/json");
                    socket.close();
                    return;
                }
                char[] bodyChars = new char[Math.max(0, contentLength)];
                int read = 0;
                while (read < bodyChars.length) {
                    int count = reader.read(bodyChars, read, bodyChars.length - read);
                    if (count <= 0) {
                        break;
                    }
                    read += count;
                }
                JSONObject body = null;
                if (read > 0) {
                    try {
                        body = new JSONObject(new String(bodyChars, 0, read));
                    } catch (JSONException e) {
                        body = null;
                    }
                }
                if (rawPath.endsWith("/screenshot")) {
                    WorkerAccessibilityService accessibility =
                            WorkerAccessibilityService.getInstance();
                    byte[] png = accessibility != null ? accessibility.screenshotPng() : null;
                    if (png == null) {
                        throw new IllegalStateException("screenshot unavailable");
                    }
                    reply(socket, 200, png, "image/png");
                    socket.close();
                    return;
                }
                JSONObject json = service.dispatch(rawPath, body);
                reply(socket, 200,
                        (json != null ? json : new JSONObject()).toString()
                                .getBytes(StandardCharsets.UTF_8),
                        "application/json");
                socket.close();
            } catch (Exception e) {
                try {
                    JSONObject err = new JSONObject().put("error",
                            new JSONObject().put("message",
                                    e.getMessage() != null ? e.getMessage() : "failed"));
                    reply(socket, 502,
                            err.toString().getBytes(StandardCharsets.UTF_8), "application/json");
                    socket.close();
                } catch (Exception ignored) {
                }
            }
        }

        private void reply(Socket socket, int status, byte[] bytes, String mime)
                throws Exception {
            String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Error") + "\r\n"
                    + "Content-Type: " + mime + "\r\n"
                    + "Content-Length: " + bytes.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream out = socket.getOutputStream();
            out.write(head.getBytes(StandardCharsets.US_ASCII));
            out.write(bytes);
            out.flush();
        }
    }
}
