package org.nayive.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.util.Log;

import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * A newer APK. Every few hours <origin>/app/version.json is read; when it
 * names a higher versionCode the APK is downloaded HERE, into the app's cache,
 * and only then the notification shows. Its tap opens Android's own installer
 * on that file ("Do you want to update this app?" - one button).
 *
 * Before 0.10 the tap only opened the browser: the APK landed in Downloads and
 * most people never opened it, so their phone stayed on the old version.
 */
final class Updater {

    private Updater() {}

    private static final String TAG = "NayiveUpdate";
    private static final long EVERY = 6 * 3600_000L, RETRY = 3600_000L;

    /** Runs the check on a thread of its own when it is due (never blocks the caller). */
    static void maybeCheck(Context c) {
        long now = System.currentTimeMillis();
        if (now - Prefs.updateChecked(c) < EVERY) return;
        Prefs.setUpdateChecked(c, now);
        Context app = c.getApplicationContext();
        new Thread(() -> {
            if (!check(app)) Prefs.setUpdateChecked(app, now - EVERY + RETRY);   // again in an hour
        }, "nayive-update").start();
    }

    /** False when it could not tell (offline, server error, broken download). */
    private static boolean check(Context c) {
        File apk = file(c);
        try {
            JSONObject v = new JSONObject(new String(fetch(BuildConfig.ORIGIN + "/app/version.json", 65536), "UTF-8"));
            int code = v.optInt("code", 0);
            if (code <= BuildConfig.VERSION_CODE) {
                installed(c);
                return true;
            }
            if (codeOf(c, apk) != code) {
                String url = v.optString("apk", "/app/nayive.apk");
                download(url.startsWith("http") ? url : BuildConfig.ORIGIN + url, apk);
                if (codeOf(c, apk) != code) {
                    Log.i(TAG, "downloaded APK is not version " + code);
                    apk.delete();
                    return false;
                }
            }
            Notes.update(c, installIntent(c, apk));
            return true;
        } catch (IOException | JSONException e) {
            Log.i(TAG, "update check failed: " + e);
            return false;
        }
    }

    /** The update is in (or not needed): no file, no notification. */
    static void installed(Context c) {
        file(c).delete();
        Notes.updateDone(c);
    }

    /** Android's installer on the downloaded APK. */
    private static Intent installIntent(Context c, File apk) {
        Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", apk);
        return new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    private static File file(Context c) {
        return new File(new File(c.getCacheDir(), "update"), "nayive.apk");
    }

    /** The versionCode inside an APK of this same app; 0 when absent or not ours. */
    private static long codeOf(Context c, File apk) {
        if (!apk.isFile()) return 0;
        PackageInfo p = c.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
        return p != null && c.getPackageName().equals(p.packageName) ? PackageInfoCompat.getLongVersionCode(p) : 0;
    }

    private static byte[] fetch(String url, int max) throws IOException {
        HttpURLConnection h = open(url);
        try (InputStream in = h.getInputStream()) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0 && buf.size() < max) buf.write(b, 0, n);
            return buf.toByteArray();
        } finally {
            h.disconnect();
        }
    }

    /** Into a .part first: a cut download never looks like an APK. */
    private static void download(String url, File apk) throws IOException {
        File dir = apk.getParentFile(), part = new File(dir, apk.getName() + ".part");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no " + dir);
        HttpURLConnection h = open(url);
        try (InputStream in = h.getInputStream(); OutputStream out = new FileOutputStream(part)) {
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
        } finally {
            h.disconnect();
        }
        if (!part.renameTo(apk)) throw new IOException("rename " + part);
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setConnectTimeout(20_000);
        h.setReadTimeout(60_000);
        h.setUseCaches(false);
        int status = h.getResponseCode();
        if (status != 200) {
            h.disconnect();
            throw new IOException("HTTP " + status + " " + url);
        }
        return h;
    }
}
