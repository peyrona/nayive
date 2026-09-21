package org.nayive.app;

import android.content.Context;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Positions not yet taken by the server, kept on disk: without coverage they
 * wait here and go in the next batch (GPSLogger does the same, so this must).
 * The server's own rules decide what it keeps (positions.go); this only makes
 * sure nothing is lost on the way.
 */
final class PositionQueue {

    private PositionQueue() {}

    private static final int MAX = 2000;   // the oldest go first, like positionsMax
    static final int BATCH = 200;          // Overland's default batch, which the server takes

    private static File file(Context c) {
        return new File(c.getFilesDir(), "positions.json");
    }

    static JSONObject point(Location l) {
        JSONObject p = new JSONObject();
        try {
            p.put("lat", l.getLatitude());
            p.put("lon", l.getLongitude());
            if (l.hasAccuracy()) p.put("acc", Math.round(l.getAccuracy()));
            p.put("at", l.getTime() / 1000);
        } catch (JSONException ignored) {
        }
        return p;
    }

    static synchronized void add(Context c, Location l) {
        JSONArray all = load(c);
        all.put(point(l));
        while (all.length() > MAX) all.remove(0);
        save(c, all);
    }

    /** Up to BATCH of the oldest, not removed yet. */
    static synchronized JSONArray peek(Context c) {
        JSONArray all = load(c), out = new JSONArray();
        for (int i = 0; i < all.length() && i < BATCH; i++) out.put(all.opt(i));
        return out;
    }

    /** The server took the first n. */
    static synchronized void drop(Context c, int n) {
        JSONArray all = load(c), rest = new JSONArray();
        for (int i = n; i < all.length(); i++) rest.put(all.opt(i));
        save(c, rest);
    }

    static synchronized boolean isEmpty(Context c) {
        return load(c).length() == 0;
    }

    private static JSONArray load(Context c) {
        File f = file(c);
        if (!f.exists()) return new JSONArray();
        try {
            return new JSONArray(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return new JSONArray();
        }
    }

    private static void save(Context c, JSONArray a) {
        File f = file(c), tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(a.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException e) {
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        tmp.renameTo(f);
    }
}
