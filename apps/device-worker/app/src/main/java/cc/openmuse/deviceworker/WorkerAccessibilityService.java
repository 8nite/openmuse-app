package cc.openmuse.deviceworker;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Input shapes mirrored from the server's deviceInputSchema (0..4000 device space). */
public class WorkerAccessibilityService extends AccessibilityService {

    private static volatile WorkerAccessibilityService instance;

    static WorkerAccessibilityService getInstance() {
        return instance;
    }

    @Override
    public void onServiceConnected() {
        AccessibilityServiceInfo info = getServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        setServiceInfo(info);
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    /** Screen size in pixels; input coordinates scale from the 0..4000 device space. */
    int[] screenSize() {
        android.graphics.Rect bounds = getSystemService(WindowManager.class)
                .getMaximumWindowMetrics().getBounds();
        return new int[]{bounds.width(), bounds.height()};
    }

    byte[] screenshotPng() throws InterruptedException {
        final byte[][] result = new byte[1][];
        final CountDownLatch done = new CountDownLatch(1);
        android.hardware.display.DisplayManager displays =
                getSystemService(android.hardware.display.DisplayManager.class);
        android.view.Display[] candidates =
                displays != null ? displays.getDisplays() : new android.view.Display[0];
        // Prefer the default display, then fall back to any attached display.
        final java.util.List<android.view.Display> order = new java.util.ArrayList<>();
        order.add(getSystemService(android.view.WindowManager.class).getDefaultDisplay());
        for (android.view.Display display : candidates) {
            if (display.getDisplayId() != android.view.Display.DEFAULT_DISPLAY) {
                order.add(display);
            }
        }
        final java.util.Iterator<android.view.Display> remaining = order.iterator();
        final int[] lastError = new int[] {-1};
        final int[] lastDisplay = new int[] {-1};
        Runnable attempt =
                new Runnable() {
                    @Override
                    public void run() {
                        if (!remaining.hasNext()) {
                            done.countDown();
                            return;
                        }
                        android.view.Display display = remaining.next();
                        lastDisplay[0] = display.getDisplayId();
                        takeScreenshot(
                                display.getDisplayId(),
                                getMainExecutor(),
                                new TakeScreenshotCallback() {
                                    @Override
                                    public void onSuccess(ScreenshotResult screenshot) {
                                        try {
                                            Bitmap bitmap = Bitmap.wrapHardwareBuffer(
                                                    screenshot.getHardwareBuffer(),
                                                    screenshot.getColorSpace());
                                            if (bitmap == null) {
                                                run();
                                                return;
                                            }
                                            Bitmap copy =
                                                    bitmap.copy(Bitmap.Config.ARGB_8888, false);
                                            bitmap.recycle();
                                            // Cap the width: full-res phone screenshots blow past
                                            // relay frame budgets; 1080 wide stays sharp enough.
                                            Bitmap scaled = copy;
                                            if (copy.getWidth() > 1080) {
                                                int width = 1080;
                                                int height =
                                                        (int)
                                                                (copy.getHeight()
                                                                        * (1080f
                                                                                / copy.getWidth()));
                                                scaled =
                                                        Bitmap.createScaledBitmap(
                                                                copy, width, height, true);
                                                copy.recycle();
                                            }
                                            ByteArrayOutputStream out =
                                                    new ByteArrayOutputStream();
                                            scaled.compress(
                                                    Bitmap.CompressFormat.PNG, 100, out);
                                            scaled.recycle();
                                            result[0] = out.toByteArray();
                                        } finally {
                                            done.countDown();
                                        }
                                    }

                                    @Override
                                    public void onFailure(int errorCode) {
                                        lastError[0] = errorCode;
                                        run();
                                    }
                                });
                    }
                };
        attempt.run();
        if (!done.await(30, TimeUnit.SECONDS)) {
            throw new IllegalStateException("screenshot timed out");
        }
        if (result[0] == null) {
            throw new IllegalStateException(
                    "takeScreenshot failed, last error="
                            + lastError[0]
                            + " display="
                            + lastDisplay[0]);
        }
        return result[0];
    }

    /** Compact interactive/labeled node tree, capped like the server's 30k budget. */
    JSONObject uiDump(int maxChars) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        JSONArray nodes = new JSONArray();
        int[] used = new int[]{2};
        visit(root, 0, nodes, used, maxChars);
        int[] size = screenSize();
        JSONObject dump = new JSONObject();
        try {
            dump.put("width", size[0]);
            dump.put("height", size[1]);
            dump.put("nodes", nodes);
            dump.put("truncated", used[0] >= maxChars);
        } catch (org.json.JSONException e) {
            throw new IllegalStateException(e);
        }
        return dump;
    }

    private void visit(AccessibilityNodeInfo node, int depth, JSONArray nodes, int[] used,
            int maxChars) {
        if (node == null || used[0] >= maxChars || depth > 24) {
            return;
        }
        String label = null;
        List<String> candidates = new ArrayList<>();
        if (node.getText() != null) {
            candidates.add(node.getText().toString());
        }
        if (node.getContentDescription() != null) {
            candidates.add(node.getContentDescription().toString());
        }
        if (node.getViewIdResourceName() != null) {
            String id = node.getViewIdResourceName();
            candidates.add(id.substring(id.lastIndexOf(":id/") + 4));
        }
        for (String candidate : candidates) {
            if (candidate != null && !candidate.trim().isEmpty()) {
                label = candidate.length() > 120 ? candidate.substring(0, 120) : candidate;
                break;
            }
        }
        if (node.isClickable() || node.isEditable() || label != null) {
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
            try {
                String entryLabel = label != null ? label
                        : String.valueOf(node.getClassName());
                if (entryLabel.contains(".")) {
                    entryLabel = entryLabel.substring(entryLabel.lastIndexOf('.') + 1);
                }
                JSONObject entry = new JSONObject()
                        .put("label", entryLabel)
                        .put("clickable", node.isClickable())
                        .put("editable", node.isEditable())
                        .put("bounds", new JSONArray()
                                .put(bounds.left).put(bounds.top)
                                .put(bounds.right).put(bounds.bottom));
                if (used[0] + entry.toString().length() <= maxChars) {
                    nodes.put(entry);
                    used[0] += entry.toString().length();
                }
            } catch (org.json.JSONException e) {
                throw new IllegalStateException(e);
            }
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            visit(node.getChild(i), depth + 1, nodes, used, maxChars);
        }
    }

    boolean perform(PhoneInput input) throws InterruptedException {
        int[] size = screenSize();
        int w = size[0];
        int h = size[1];
        if (input instanceof PhoneInput.Tap) {
            PhoneInput.Tap tap = (PhoneInput.Tap) input;
            int x = scale(tap.x, w);
            int y = scale(tap.y, h);
            return gesture(x, y, x, y, 60);
        } else if (input instanceof PhoneInput.Swipe) {
            PhoneInput.Swipe swipe = (PhoneInput.Swipe) input;
            return gesture(scale(swipe.x1, w), scale(swipe.y1, h),
                    scale(swipe.x2, w), scale(swipe.y2, h),
                    Math.min(5000, Math.max(50, swipe.durationMs)));
        } else if (input instanceof PhoneInput.Text) {
            AccessibilityNodeInfo focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focused != null && focused.isEditable()) {
                Bundle args = new Bundle();
                args.putCharSequence(
                        AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                        ((PhoneInput.Text) input).text);
                return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
            }
            return false;
        } else if (input instanceof PhoneInput.Key) {
            return performKey(((PhoneInput.Key) input).key);
        }
        return false;
    }

    private int scale(int value, int max) {
        return Math.min(max - 1, Math.max(0, (int) (value / 4000f * max)));
    }

    /**
     * No key-injection API exists on AccessibilityService; Enter/Backspace act on the
     * focused editable, play/pause taps the on-screen control, and the rest are global.
     */
    private boolean performKey(String key) {
        switch (key) {
            case "back":
                return performGlobalAction(GLOBAL_ACTION_BACK);
            case "home":
                return performGlobalAction(GLOBAL_ACTION_HOME);
            case "recents":
                return performGlobalAction(GLOBAL_ACTION_RECENTS);
            case "Enter": {
                // No IME-action API on AccessibilityService; appending a newline submits
                // single-line fields and breaks lines in multi-line ones.
                AccessibilityNodeInfo focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                CharSequence current = focused != null ? focused.getText() : null;
                if (focused != null && focused.isEditable() && current != null) {
                    Bundle args = new Bundle();
                    args.putCharSequence(
                            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                            current.toString() + "\n");
                    return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                }
                return false;
            }
            case "Backspace": {
                AccessibilityNodeInfo focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                CharSequence current = focused != null ? focused.getText() : null;
                if (focused != null && focused.isEditable() && current != null
                        && current.length() > 0) {
                    Bundle args = new Bundle();
                    args.putCharSequence(
                            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                            current.subSequence(0, current.length() - 1).toString());
                    return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                }
                return false;
            }
            case "play_pause":
                return clickMediaToggle(getRootInActiveWindow());
            case "Tab":
            default:
                return false;
        }
    }

    /** Best-effort media toggle: tap the on-screen play/pause control. */
    private boolean clickMediaToggle(AccessibilityNodeInfo node) {
        if (node == null) {
            return false;
        }
        StringBuilder label = new StringBuilder();
        if (node.getText() != null) {
            label.append(node.getText().toString()).append(' ');
        }
        if (node.getContentDescription() != null) {
            label.append(node.getContentDescription().toString());
        }
        String text = label.toString().toLowerCase();
        if (node.isClickable() && (text.contains("play") || text.contains("pause"))) {
            return node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            if (clickMediaToggle(node.getChild(i))) {
                return true;
            }
        }
        return false;
    }

    private boolean gesture(int x1, int y1, int x2, int y2, long durationMs)
            throws InterruptedException {
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, 0, durationMs);
        final boolean[] result = new boolean[1];
        final CountDownLatch done = new CountDownLatch(1);
        dispatchGesture(new GestureDescription.Builder().addStroke(stroke).build(),
                new GestureResultCallback() {
                    @Override
                    public void onCompleted(GestureDescription gestureDescription) {
                        result[0] = true;
                        done.countDown();
                    }

                    @Override
                    public void onCancelled(GestureDescription gestureDescription) {
                        done.countDown();
                    }
                }, new Handler(Looper.getMainLooper()));
        return done.await(10, TimeUnit.SECONDS) && result[0];
    }
}
