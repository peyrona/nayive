package org.nayive.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.security.SecureRandom;

/** The little the app keeps: its device token, and where the setup stands. */
final class Prefs {

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences("nayive", Context.MODE_PRIVATE);
    }

    /**
     * This phone's credential for /api/device/*. Made here, never shown, and
     * handed to the server once, by the web page the user signs in on
     * (device.html). 32 random bytes, like the server's own tokens.
     */
    static synchronized String token(Context c) {
        String t = sp(c).getString("token", null);
        if (t == null) {
            t = freshToken();
            sp(c).edit().putString("token", t).apply();
        }
        return t;
    }

    /** Revoked on the server: forget the old token, the next one is enrolled anew. */
    static synchronized void newToken(Context c) {
        sp(c).edit().putString("token", freshToken()).putBoolean("enrolled", false).apply();
    }

    private static String freshToken() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    /** The server has answered this token at least once. */
    static boolean enrolled(Context c) { return sp(c).getBoolean("enrolled", false); }

    static void setEnrolled(Context c, boolean on) { sp(c).edit().putBoolean("enrolled", on).apply(); }

    /** The permissions screen has been through once. */
    static boolean setupDone(Context c) { return sp(c).getBoolean("setup", false); }

    static void setSetupDone(Context c) { sp(c).edit().putBoolean("setup", true).apply(); }

    /** When the app last asked whether there is a newer APK (ms). */
    static long updateChecked(Context c) { return sp(c).getLong("updateChecked", 0); }

    static void setUpdateChecked(Context c, long at) { sp(c).edit().putLong("updateChecked", at).apply(); }
}
