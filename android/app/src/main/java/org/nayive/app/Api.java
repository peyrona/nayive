package org.nayive.app;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The server's /api/device/* - plain HttpURLConnection and org.json, nothing to
 * add to the APK. The token rides in a header, never in the URL: URLs end up in
 * logs, headers do not.
 */
final class Api {

    private Api() {}

    static final String HEADER = "X-Nayive-Device";

    /** One answer: the HTTP status, and the JSON body (empty when there was none). */
    static final class Reply {
        final int status;
        final JSONObject body;

        Reply(int status, JSONObject body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() { return status >= 200 && status < 300; }
    }

    static Reply get(Context c, String path, int readTimeoutMs) throws IOException {
        return call(c, "GET", path, null, readTimeoutMs);
    }

    static Reply post(Context c, String path, JSONObject body) throws IOException {
        return call(c, "POST", path, body, 30_000);
    }

    private static Reply call(Context c, String method, String path, JSONObject body, int readTimeoutMs)
            throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(BuildConfig.ORIGIN + path).openConnection();
        try {
            h.setRequestMethod(method);
            h.setConnectTimeout(20_000);
            h.setReadTimeout(readTimeoutMs);
            h.setUseCaches(false);
            h.setRequestProperty(HEADER, Prefs.token(c));
            h.setRequestProperty("Accept", "application/json");
            h.setRequestProperty("X-Nayive-App", String.valueOf(BuildConfig.VERSION_CODE));
            if (body != null) {
                byte[] raw = body.toString().getBytes(StandardCharsets.UTF_8);
                h.setDoOutput(true);
                h.setFixedLengthStreamingMode(raw.length);   // never chunked: the server refuses it
                h.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream out = h.getOutputStream()) {
                    out.write(raw);
                }
            }
            int status = h.getResponseCode();
            InputStream in = status >= 400 ? h.getErrorStream() : h.getInputStream();
            return new Reply(status, parse(in));
        } finally {
            h.disconnect();
        }
    }

    private static JSONObject parse(InputStream in) throws IOException {
        if (in == null) return new JSONObject();
        try (InputStream s = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = s.read(b)) > 0) {
                buf.write(b, 0, n);
                if (buf.size() > 1 << 20) throw new IOException("answer too large");
            }
            String txt = buf.toString("UTF-8").trim();
            if (txt.isEmpty() || txt.charAt(0) != '{') return new JSONObject();
            return new JSONObject(txt);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }
}
