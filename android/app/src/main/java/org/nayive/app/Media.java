package org.nayive.app;

import android.Manifest;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * "Upload new photos and videos" (docs/phone-media-upload-plan.md): what the
 * switch in Mi cuenta says, the permission it needs, and the list of what the
 * camera took since it was switched on. {@link MediaJob} runs the uploads, once
 * a day on Wi-Fi; {@link MediaUploader} sends one file. Nothing on the phone is
 * ever deleted.
 *
 * The queue lives in a file, like the positions: a killed app, a phone turned
 * off, goes on where it stopped. The server knows how far each file got.
 */
final class Media {

    private Media() {}

    private static final String TAG = "Nayive";

    // ------------------------------------------------------------------
    // the switch (sent by the server in every /api/device/wait answer)
    // ------------------------------------------------------------------

    /**
     * `since` = when the switch was turned on, in unix seconds; 0 = off. Off
     * forgets the queue and the job; on (anew) means only what is added from
     * that moment.
     */
    static void onServer(Context c, long since) {
        long had = Prefs.mediaSince(c);
        if (since <= 0) {
            if (had != 0) {
                Prefs.setMediaSince(c, 0);
                clear(c);
                MediaJob.cancel(c);
                Notes.cancel(c, Notes.MEDIA_FIX);
            }
            return;
        }
        MediaJob.schedule(c);
        if (allowed(c)) Notes.cancel(c, Notes.MEDIA_FIX);
        else if (since != had) Notes.mediaFix(c);   // once at the switch; then once a day (MediaJob)
        if (since != had) Prefs.setMediaSince(c, since);
    }

    static boolean on(Context c) { return Prefs.mediaSince(c) > 0; }

    // ------------------------------------------------------------------
    // the permission
    // ------------------------------------------------------------------

    private static boolean has(Context c, String p) {
        return c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
    }

    /** What to ask for. ACCESS_MEDIA_LOCATION: without it Android takes the GPS out of every photo. */
    static String[] wanted() {
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO,
                    Manifest.permission.ACCESS_MEDIA_LOCATION};
        }
        if (Build.VERSION.SDK_INT >= 29) {
            return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.ACCESS_MEDIA_LOCATION};
        }
        return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
    }

    /** Every photo and video, with their places. */
    static boolean allowed(Context c) {
        for (String p : wanted()) if (!has(c, p)) return false;
        return true;
    }

    /** Android 14's "Select photos": some, not all - not enough for new ones. */
    static boolean partial(Context c) {
        return Build.VERSION.SDK_INT >= 34 && !has(c, Manifest.permission.READ_MEDIA_IMAGES)
                && has(c, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED);
    }

    // ------------------------------------------------------------------
    // what is new: MediaStore, camera only (DCIM/)
    // ------------------------------------------------------------------

    /** One file to send. */
    static final class Item {
        final long mid;          // MediaStore's _ID
        final boolean video;
        final String name, mime;
        final long size, taken;  // bytes; ms
        final long added;        // DATE_ADDED, s

        Item(long mid, boolean video, String name, String mime, long size, long taken, long added) {
            this.mid = mid;
            this.video = video;
            this.name = name;
            this.mime = mime;
            this.size = size;
            this.taken = taken;
            this.added = added;
        }

        /** What the server knows it by: the same row of the same phone, never another. */
        String id() { return mid + "-" + added; }

        Uri uri() {
            return ContentUris.withAppendedId(video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, mid);
        }

        JSONObject json() throws JSONException {
            return new JSONObject().put("mid", mid).put("video", video).put("name", name).put("mime", mime)
                    .put("size", size).put("taken", taken).put("added", added);
        }

        static Item of(JSONObject o) {
            return new Item(o.optLong("mid"), o.optBoolean("video"), o.optString("name"), o.optString("mime"),
                    o.optLong("size"), o.optLong("taken"), o.optLong("added"));
        }
    }

    /**
     * Adds to the queue what the camera saved since the last look: _ID past the
     * last one seen (MediaStore numbers new rows upwards), added after the
     * switch. A file still being written (IS_PENDING) stops the look there, so
     * it is not skipped for good.
     */
    static synchronized void scan(Context c) {
        long since = Prefs.mediaSince(c);
        if (since <= 0 || !allowed(c)) return;
        long last = Prefs.mediaLastId(c);
        Uri files = MediaStore.Files.getContentUri("external");
        String camera = Build.VERSION.SDK_INT >= 29
                ? MediaStore.MediaColumns.RELATIVE_PATH + " LIKE 'DCIM/%'"
                : MediaStore.MediaColumns.DATA + " LIKE '%/DCIM/%'";
        String sel = MediaStore.Files.FileColumns.MEDIA_TYPE + " IN ("
                + MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE + "," + MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO + ")"
                + " AND " + MediaStore.MediaColumns.DATE_ADDED + " >= ?"
                + " AND " + MediaStore.MediaColumns._ID + " > ?"
                + " AND " + camera;
        String[] cols = Build.VERSION.SDK_INT >= 29
                ? new String[]{"_id", "media_type", "_display_name", "mime_type", "_size", "datetaken", "date_added", "is_pending"}
                : new String[]{"_id", "media_type", "_display_name", "mime_type", "_size", "datetaken", "date_added"};
        JSONArray q = load(c);
        int added = 0;
        try (Cursor cur = c.getContentResolver().query(files, cols, sel,
                new String[]{String.valueOf(since), String.valueOf(last)}, "_id ASC")) {
            if (cur == null) return;
            while (cur.moveToNext()) {
                if (cols.length > 7 && cur.getInt(7) != 0) break;   // still being written
                long mid = cur.getLong(0);
                long size = cur.getLong(4);
                long dateAdded = cur.getLong(6);
                long taken = cur.isNull(5) || cur.getLong(5) <= 0 ? dateAdded * 1000 : cur.getLong(5);
                last = mid;
                if (size <= 0) continue;
                Item it = new Item(mid, cur.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO,
                        cur.getString(2) == null ? "foto" : cur.getString(2),
                        cur.getString(3) == null ? "" : cur.getString(3), size, taken, dateAdded);
                q.put(it.json());
                added++;
            }
        } catch (RuntimeException | JSONException e) {
            Log.w(TAG, "media scan failed", e);
            return;
        }
        save(c, q);
        Prefs.setMediaLastId(c, last);
        if (added > 0) Log.i(TAG, "media: " + added + " new");
    }

    // ------------------------------------------------------------------
    // the queue, on disk
    // ------------------------------------------------------------------

    private static File file(Context c) {
        return new File(c.getFilesDir(), "media.json");
    }

    static synchronized Item peek(Context c) {
        JSONArray q = load(c);
        JSONObject o = q.optJSONObject(0);
        return o == null ? null : Item.of(o);
    }

    /** The first one is done with: sent, gone from the phone, or refused for good. */
    static synchronized void drop(Context c) {
        JSONArray q = load(c);
        if (q.length() > 0) {
            q.remove(0);
            save(c, q);
        }
    }

    static synchronized void clear(Context c) {
        file(c).delete();
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

    private static void save(Context c, JSONArray q) {
        File f = file(c), tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(q.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException e) {
            Log.w(TAG, "cannot save the media queue", e);
            return;
        }
        if (!tmp.renameTo(f)) tmp.delete();
    }
}
