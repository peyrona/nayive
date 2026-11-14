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
            // commit(): Launcher hands it to device.html at once; a lost write would
            // leave the page enrolling a token the app no longer has.
            sp(c).edit().putString("token", t).commit();
        }
        return t;
    }

    /**
     * A token that worked was refused: revoked - or the server lost its phone
     * list for a while (a bad deploy, a restore). The token is kept: once the
     * list is back it works again by itself, and a revoked phone is enrolled
     * anew with it (the server takes a known token again). Only "enrolled" goes,
     * so the app opens device.html again.
     */
    static synchronized void refused(Context c) {
        sp(c).edit().putBoolean("enrolled", false).putBoolean("revoked", true).apply();
    }

    /** A token that worked was refused (revoked): asking again can wait long. Off once enrolled anew. */
    static boolean revoked(Context c) { return sp(c).getBoolean("revoked", false); }

    private static String freshToken() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    /** The server has answered this token at least once. */
    static boolean enrolled(Context c) { return sp(c).getBoolean("enrolled", false); }

    static void setEnrolled(Context c, boolean on) {
        sp(c).edit().putBoolean("enrolled", on).putBoolean("revoked", false).putBoolean("enrolPage", false).apply();
    }

    /** device.html was opened since the last enrolment: it may enrol this phone to another account. */
    static boolean enrolPage(Context c) { return sp(c).getBoolean("enrolPage", false); }

    static void setEnrolPage(Context c) { sp(c).edit().putBoolean("enrolPage", true).apply(); }

    /** The permissions screen has been through once. */
    static boolean setupDone(Context c) { return sp(c).getBoolean("setup", false); }

    static void setSetupDone(Context c) { sp(c).edit().putBoolean("setup", true).apply(); }

    /** When "Upload new photos and videos" was switched on (server's unix s); 0 = off. Media.java. */
    static long mediaSince(Context c) { return sp(c).getLong("mediaSince", 0); }

    static void setMediaSince(Context c, long s) { sp(c).edit().putLong("mediaSince", s).apply(); }

    /** The last MediaStore _ID already looked at. */
    static long mediaLastId(Context c) { return sp(c).getLong("mediaLastId", 0); }

    static void setMediaLastId(Context c, long id) { sp(c).edit().putLong("mediaLastId", id).commit(); }

    /** When the camera's files were last looked at (unix s): the look back reaches a day before it. */
    static long mediaScanned(Context c) { return sp(c).getLong("mediaScanned", 0); }

    static void setMediaScanned(Context c, long s) { sp(c).edit().putLong("mediaScanned", s).apply(); }

    /** Upload runs in a row that sent nothing: MediaJob waits longer each time. */
    static int mediaFails(Context c) { return sp(c).getInt("mediaFails", 0); }

    static void setMediaFails(Context c, int n) { sp(c).edit().putInt("mediaFails", n).apply(); }

    /** When the app last asked whether there is a newer APK (ms). */
    static long updateChecked(Context c) { return sp(c).getLong("updateChecked", 0); }

    static void setUpdateChecked(Context c, long at) { sp(c).edit().putLong("updateChecked", at).apply(); }

    /** Whether the update note for version `code` may show now; counts it if so (Updater). */
    static synchronized boolean updateNag(Context c, int code) {
        SharedPreferences s = sp(c);
        long now = System.currentTimeMillis();
        int shows = s.getInt("updateCode", 0) == code ? s.getInt("updateShows", 0) : 0;
        if (shows >= 4 && now - s.getLong("updateShownAt", 0) < 7 * 86400_000L) return false;
        s.edit().putInt("updateCode", code).putInt("updateShows", shows + 1).putLong("updateShownAt", now).apply();
        return true;
    }

    /** The newest server notification already shown here (its id). */
    static long lastNote(Context c) { return sp(c).getLong("lastNote", 0); }

    static void setLastNote(Context c, long id) { sp(c).edit().putLong("lastNote", id).apply(); }

    /** The alarm volume before a find or SOS turned it up; -1 = nothing to put back (Ringer). */
    static int alarmVolume(Context c) { return sp(c).getInt("alarmVolume", -1); }

    static void setAlarmVolume(Context c, int v) { sp(c).edit().putInt("alarmVolume", v).commit(); }
}
