package cc.openmuse.deviceworker;

/** Input shapes mirrored from the server's deviceInputSchema (0..4000 device space). */
public abstract class PhoneInput {
    private PhoneInput() {
    }

    public static final class Tap extends PhoneInput {
        public final int x;
        public final int y;

        public Tap(int x, int y) {
            this.x = x;
            this.y = y;
        }
    }

    public static final class Swipe extends PhoneInput {
        public final int x1;
        public final int y1;
        public final int x2;
        public final int y2;
        public final int durationMs;

        public Swipe(int x1, int y1, int x2, int y2, int durationMs) {
            this.x1 = x1;
            this.y1 = y1;
            this.x2 = x2;
            this.y2 = y2;
            this.durationMs = durationMs;
        }
    }

    public static final class Text extends PhoneInput {
        public final String text;

        public Text(String text) {
            this.text = text;
        }
    }

    public static final class Key extends PhoneInput {
        public final String key;

        public Key(String key) {
            this.key = key;
        }
    }

    public static PhoneInput parse(org.json.JSONObject body) throws org.json.JSONException {
        String type = body.getString("type");
        switch (type) {
            case "tap":
                return new Tap(body.getInt("x"), body.getInt("y"));
            case "swipe":
                return new Swipe(body.getInt("x1"), body.getInt("y1"), body.getInt("x2"),
                        body.getInt("y2"), body.optInt("durationMs", 250));
            case "text":
                return new Text(body.getString("text"));
            case "key":
                return new Key(body.getString("key"));
            default:
                throw new IllegalArgumentException("unknown input type " + type);
        }
    }
}
