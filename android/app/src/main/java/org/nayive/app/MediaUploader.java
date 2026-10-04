package org.nayive.app;

import android.content.Context;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Sends the queue ({@link Media}) to /api/device/media/* (server/go/api_device_media.go):
 *
 *   start {id, name, size, taken, mime, lat?, lon?} -> {upload, offset} | {done}
 *   PUT <upload>?offset=N, CHUNK bytes at a time   -> {offset}
 *   end                                             -> {path}
 *
 * The server keeps the bytes it got, so a file cut halfway (Wi-Fi gone, the
 * job's time up, the app killed) goes on from there the next time.
 */
final class MediaUploader {

    private MediaUploader() {}

    private static final String TAG = "Nayive";
    private static final int CHUNK = 4 << 20;

    interface Stop { boolean now(); }

    /** What one run did. */
    static final class Result {
        int photos, videos;
        final Set<String> folders = new LinkedHashSet<>();
        boolean finished;   // the queue is empty (or nothing more can be done today)
    }

    /** Sends while there is time: `deadline` in elapsed ms (System.currentTimeMillis). */
    static Result run(Context c, long deadline, Stop stop) {
        Result res = new Result();
        Media.scan(c);
        Set<Long> again = new HashSet<>();   // changed on the phone during this run
        while (true) {
            if (stop.now() || System.currentTimeMillis() > deadline) return res;
            Media.Item it = Media.peek(c);
            if (it == null) {
                res.finished = true;
                return res;
            }
            if (again.contains(it.mid)) return res;   // round again: still changing, the next run
            int outcome;
            try {
                outcome = send(c, it, deadline, stop, res);
            } catch (IOException e) {
                Log.i(TAG, "media upload stopped: " + e);
                return res;   // the network: the next chance goes on
            }
            switch (outcome) {
                case SENT:
                case SKIP:
                    Media.drop(c);
                    break;
                case STOP_TODAY:   // quota full, switched off, not enrolled: no point going on now
                    res.finished = true;
                    return res;
                case CHANGED:      // queued again, after the others
                    again.add(it.mid);
                    break;
                default:           // LATER: out of time
                    return res;
            }
        }
    }

    private static final int SENT = 0, SKIP = 1, LATER = 2, STOP_TODAY = 3, CHANGED = 4;

    /**
     * Read again right before each send: a file edited in place since it was
     * queued (same row, new bytes) goes to the end of the queue as it is now,
     * with a new id - never a cut or mixed copy. A file MediaStore calls empty
     * (0 bytes, no size) leaves the queue; the look back finds it once whole.
     * -1 = the same, send it.
     */
    private static int recheck(Context c, Media.Item it) {
        Media.Item now = Media.changed(c, it);
        if (now == null) return -1;
        if (now.size <= 0) return incomplete(c, it);
        Log.i(TAG, "media: " + it.name + " changed on the phone, queued again");
        Media.requeue(c, now);
        return CHANGED;
    }

    /** Not whole now: dropped from the queue, but not as done - a later look queues it again. */
    private static int incomplete(Context c, Media.Item it) {
        Media.unsee(c, it);
        return SKIP;
    }

    private static int send(Context c, Media.Item it, long deadline, Stop stop, Result res) throws IOException {
        int check = recheck(c, it);
        if (check >= 0) return check;
        Uri uri = original(c, it.uri());
        double[] ll = it.video ? videoPlace(c, uri) : photoPlace(c, uri);

        JSONObject body = new JSONObject();
        try {
            body.put("id", it.id()).put("name", it.name).put("size", it.size).put("taken", it.taken).put("mime", it.mime);
            if (ll != null) body.put("lat", ll[0]).put("lon", ll[1]);
        } catch (JSONException e) {
            return SKIP;
        }
        Api.Reply r = Api.post(c, "/api/device/media/start", body);
        if (r.status == 507 || r.status == 401 || r.status == 403) {
            if (r.status == 403) Media.clear(c);   // switched off meanwhile
            return STOP_TODAY;
        }
        if (r.status == 400) return SKIP;          // a file the server will never take
        if (!r.ok()) throw new IOException("start answered " + r.status);
        if (r.body.optBoolean("done")) return SKIP;
        String upload = r.body.optString("upload");
        long offset = r.body.optLong("offset");
        if (offset > 0) Log.i(TAG, "media: " + it.name + " goes on from byte " + offset);

        byte[] buf = new byte[(int) Math.min(CHUNK, Math.max(1, it.size))];
        while (offset < it.size) {
            if (stop.now() || System.currentTimeMillis() > deadline) return LATER;
            check = recheck(c, it);
            if (check >= 0) return check;
            int n;
            try (InputStream in = c.getContentResolver().openInputStream(uri)) {
                if (in == null) return SKIP;
                if (!skipFully(in, offset)) return incomplete(c, it);   // shorter than MediaStore said
                n = readFully(in, buf, (int) Math.min(buf.length, it.size - offset));
            } catch (FileNotFoundException | SecurityException e) {
                return SKIP;   // deleted on the phone meanwhile
            }
            if (n <= 0) return incomplete(c, it);   // shorter than MediaStore said: changed under us
            Api.Reply p = Api.put(c, "/api/device/media/" + upload + "?offset=" + offset, buf, n);
            if (p.status == 409) {
                offset = p.body.optLong("offset", offset);
                continue;
            }
            if (p.status == 507) return STOP_TODAY;
            if (p.status == 404) return LATER;    // swept; the next run starts it again
            if (!p.ok()) throw new IOException("PUT answered " + p.status);
            offset = p.body.optLong("offset", offset + n);
        }
        check = recheck(c, it);   // while the last bytes went
        if (check >= 0) return check;

        Api.Reply e = Api.post(c, "/api/device/media/" + upload + "/end", new JSONObject());
        if (e.status == 404) return LATER;        // "start" will say it is done
        if (e.status == 409) return LATER;
        if (!e.ok()) throw new IOException("end answered " + e.status);
        if (it.video) res.videos++; else res.photos++;
        String path = e.body.optString("path");
        String[] seg = path.split("/");
        if (seg.length >= 2) res.folders.add(seg[seg.length - 2].matches("\\d{4}") && seg.length >= 3
                ? seg[seg.length - 3] : seg[seg.length - 2]);
        return SENT;
    }

    /**
     * The file as the camera wrote it. Without this (Android 10+) the stream
     * comes with the photo's GPS taken out - and the server reads it to put the
     * owner on the trip's map.
     */
    private static Uri original(Context c, Uri uri) {
        if (Build.VERSION.SDK_INT >= 29
                && c.checkSelfPermission(android.Manifest.permission.ACCESS_MEDIA_LOCATION)
                == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return MediaStore.setRequireOriginal(uri);
        }
        return uri;
    }

    private static double[] photoPlace(Context c, Uri uri) {
        try (InputStream in = c.getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            float[] ll = new float[2];
            return new ExifInterface(in).getLatLong(ll) ? new double[]{ll[0], ll[1]} : null;
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private static final Pattern ISO6709 = Pattern.compile("([+-]\\d+(?:\\.\\d+)?)([+-]\\d+(?:\\.\\d+)?)");

    /** A video's place: "+40.7128-074.0060/" (ISO 6709), when the camera wrote one. */
    private static double[] videoPlace(Context c, Uri uri) {
        MediaMetadataRetriever m = new MediaMetadataRetriever();
        try {
            m.setDataSource(c, uri);
            String loc = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_LOCATION);
            if (loc == null) return null;
            Matcher x = ISO6709.matcher(loc);
            return x.find() ? new double[]{Double.parseDouble(x.group(1)), Double.parseDouble(x.group(2))} : null;
        } catch (RuntimeException e) {
            return null;
        } finally {
            try {
                m.release();
            } catch (IOException | RuntimeException ignored) {
            }
        }
    }

    /** False when the file ends first. */
    private static boolean skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long k = in.skip(n);
            if (k <= 0) {
                if (in.read() < 0) return false;
                k = 1;
            }
            n -= k;
        }
        return true;
    }

    private static int readFully(InputStream in, byte[] b, int len) throws IOException {
        int got = 0;
        while (got < len) {
            int k = in.read(b, got, len - got);
            if (k < 0) break;
            got += k;
        }
        return got;
    }
}
