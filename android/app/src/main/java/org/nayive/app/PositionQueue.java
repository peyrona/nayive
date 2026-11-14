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
        if (all == null) return;   // could not read it: never write over it
        all.put(point(l));
        while (all.length() > MAX) all.remove(0);
        save(c, all);
    }

    /** Up to BATCH of the oldest, not removed yet. */
    static synchronized JSONArray peek(Context c) {
        JSONArray all = load(c), out = new JSONArray();
        if (all == null) return out;
        for (int i = 0; i < all.length() && i < BATCH; i++) out.put(all.opt(i));
        return out;
    }

    /**
     * The server took `sent` (a peek). Only those go: with the queue full, add()
     * may have trimmed the oldest of them meanwhile, and a plain "drop the first
     * n" would then drop one never sent.
     */
    static synchronized void drop(Context c, JSONArray sent) {
        java.util.Set<String> took = new java.util.HashSet<>();
        for (int i = 0; i < sent.length(); i++) took.add(String.valueOf(sent.opt(i)));
        JSONArray all = load(c), rest = new JSONArray();
        if (all == null) return;
        int i = 0;
        while (i < all.length() && i < sent.length() && took.contains(String.valueOf(all.opt(i)))) i++;
        for (; i < all.length(); i++) rest.put(all.opt(i));
        save(c, rest);
    }

    /** Sent under an account the phone is no longer in: they must not go to the next one. */
    static synchronized void clear(Context c) {
        //noinspection ResultOfMethodCallIgnored
        file(c).delete();
    }

    static synchronized boolean isEmpty(Context c) {
        JSONArray all = load(c);
        return all == null || all.length() == 0;
    }

    /** Null: it is there but could not be read now. */
    private static JSONArray load(Context c) {
        File f = file(c);
        if (!f.exists()) return new JSONArray();
        try {
            return new JSONArray(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        } catch (JSONException e) {
            // Kept aside, never written over by the next add.
            //noinspection ResultOfMethodCallIgnored
            f.renameTo(new File(f.getPath() + ".bad"));
            return new JSONArray();
        } catch (IOException e) {
            return null;
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
