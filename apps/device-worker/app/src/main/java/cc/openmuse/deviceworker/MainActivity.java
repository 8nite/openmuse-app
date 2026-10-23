package cc.openmuse.deviceworker;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Manual grants checklist + pairing screen. The server never touches the OS;
 * everything on this screen is explicit user consent on the device.
 */
public class MainActivity extends Activity {

    private TextView status;
    private TextView checklist;
    private EditText host;
    private EditText code;
    private Button pair;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final SharedPreferences prefs = getSharedPreferences("worker", Context.MODE_PRIVATE);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(48, 48, 48, 48);
        TextView title = new TextView(this);
        title.setText("OpenMuse phone worker");
        title.setTextSize(22);
        checklist = new TextView(this);
        status = new TextView(this);
        host = new EditText(this);
        host.setHint("Server host, e.g. https://openmuse.example.com");
        host.setText(prefs.getString("server_host", ""));
        code = new EditText(this);
        code.setHint("Pairing code ot-pair-…");
        pair = new Button(this);
        pair.setText("Pair phone worker");
        pair.setOnClickListener(v -> {
            String h = host.getText().toString().trim();
            String c = code.getText().toString().trim();
            if (h.isEmpty() || c.isEmpty()) {
                status.setText("Enter the server host and the pairing code from OpenMuse.");
                return;
            }
            startPairing(h, c);
        });
        Button accessibility = new Button(this);
        accessibility.setText("Open Accessibility settings");
        accessibility.setOnClickListener(
                v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        Button battery = new Button(this);
        battery.setText("Disable battery optimization");
        battery.setOnClickListener(v -> {
            PowerManager pm = getSystemService(PowerManager.class);
            if (!pm.isIgnoringBatteryOptimizations(getPackageName())) {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.fromParts("package", getPackageName(), null)));
            }
        });
        ScrollView scroll = new ScrollView(this);
        scroll.addView(layout);
        layout.addView(title);
        layout.addView(checklist);
        layout.addView(accessibility);
        layout.addView(battery);
        layout.addView(host);
        layout.addView(code);
        layout.addView(pair);
        layout.addView(status);
        setContentView(scroll);

        // Automation hook for ADB-driven tests: prefill from intent extras and pair at once.
        // am start -n cc.openmuse.deviceworker/.MainActivity --es host <url> --es code <ot-pair-*>
        Intent intent = getIntent();
        String extraHost = intent != null ? intent.getStringExtra("host") : null;
        String extraCode = intent != null ? intent.getStringExtra("code") : null;
        if (extraHost != null && !extraHost.isEmpty() && extraCode != null
                && !extraCode.isEmpty()) {
            final String autoHost = extraHost;
            final String autoCode = extraCode;
            host.setText(autoHost);
            code.setText(autoCode);
            layout.postDelayed(() -> startPairing(autoHost, autoCode), 800);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent == null) {
            return;
        }
        String extraHost = intent.getStringExtra("host");
        String extraCode = intent.getStringExtra("code");
        if (extraHost != null && !extraHost.isEmpty() && extraCode != null && !extraCode.isEmpty()) {
            host.setText(extraHost);
            code.setText(extraCode);
            host.postDelayed(() -> startPairing(extraHost, extraCode), 800);
        }
    }

    private void startPairing(String h, String c) {
        getSharedPreferences("worker", Context.MODE_PRIVATE).edit()
                .putString("server_host", h).apply();
        Intent service = new Intent(this, WorkerForegroundService.class);
        service.setAction(WorkerForegroundService.ACTION_PAIR);
        service.putExtra(WorkerForegroundService.EXTRA_HOST, h);
        service.putExtra(WorkerForegroundService.EXTRA_CODE, c);
        startForegroundService(service);
        status.setText("Pairing… watch for Connected.");
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean enabled = isAccessibilityEnabled();
        PowerManager pm = getSystemService(PowerManager.class);
        boolean batteryOk = pm.isIgnoringBatteryOptimizations(getPackageName());
        checklist.setText("1. Accessibility Service: "
                + (enabled ? "ON" : "OFF — required for gestures, screen capture and the app tree")
                + "\n2. Battery optimization: "
                + (batteryOk ? "disabled" : "enabled — disable it so pairing stays alive"));
        startForegroundService(new Intent(this, WorkerForegroundService.class)
                .setAction(WorkerForegroundService.ACTION_CONNECT));
    }

    private boolean isAccessibilityEnabled() {
        String expected = getPackageName() + "/"
                + WorkerAccessibilityService.class.getCanonicalName();
        String flat = Settings.Secure.getString(getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (flat == null) {
            return false;
        }
        for (String service : flat.split(":")) {
            if (service.equalsIgnoreCase(expected)) {
                return true;
            }
        }
        return false;
    }
}
