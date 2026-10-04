package org.nayive.app;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The one connection to the server - what a web page cannot be: awake with the
 * screen off.
 *
 * It is a long poll, the shape chatWait already uses (server/go/api_chat.go):
 * GET /api/device/wait is held open by the server until something about this
 * phone changes, or for `hold` seconds, and answers the phone's whole state:
 *
 *   {"v", "hold", "track", "badge", "call": {...}|null, "find": {...}|null, "media"}
 *
 * No Google, no FCM, no second app. What the answer says is applied as it is:
 * track -> positions on/off, badge -> the unread notification, call -> ring,
 * find -> the alarm + one fresh position, media -> the daily photo upload (MediaJob).
 */
public class LinkService extends Service {

    private static final String TAG = "Nayive";

    /** Asks the service to run (it is harmless to ask twice). */
    static void start(Context c) {
        if (!Prefs.setupDone(c)) return;
        try {
            ContextCompat.startForegroundService(c, new Intent(c, LinkService.class));
        } catch (RuntimeException e) {   // background start refused (Android 12+)
            Log.w(TAG, "cannot start the service now", e);
        }
    }

    /** Ids the user already acted on here: a late answer must not ring them again. */
    static final Set<String> handled = Collections.synchronizedSet(new LinkedHashSet<>());

    static void markHandled(String id) {
        if (id == null || id.isEmpty()) return;
        synchronized (handled) {
            handled.add(id);
            while (handled.size() > 50) handled.remove(handled.iterator().next());
        }
    }

    private static LinkService running;

    /** Wakes the poll loop now (network back, the app opened, an ack sent). */
    static void kick() {
        LinkService s = running;
        if (s != null) {
            s.refused = 0;
            s.wakeUp();
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService sender = Executors.newSingleThreadExecutor();
    private final Object gate = new Object();
    private Thread loop;
    private volatile boolean alive;
    private boolean kicked;

    /** 401s in a row (not enrolled, or revoked): the wait between them grows. */
    private volatile int refused;

    private Tracker tracker;
    private PowerManager.WakeLock wake;
    private ConnectivityManager.NetworkCallback netCallback;

    private String version = "";
    private int holdSeconds = 180;
    private Notes.Link shown;
    private boolean trackWanted;

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        tracker = new Tracker(this, this::onPosition);
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nayive:link");
        wake.setReferenceCounted(false);
        foreground(Prefs.enrolled(this) ? Notes.Link.ON : Notes.Link.ENROL);

        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) { wakeUp(); }
        };
        try {
            getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(netCallback);
        } catch (RuntimeException e) {
            netCallback = null;
        }

        alive = true;
        loop = new Thread(this::pollLoop, "nayive-link");
        loop.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        refused = 0;   // the app opened (Launcher): ask often again, it may be enrolling now
        wakeUp();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        alive = false;
        running = null;
        wakeUp();
        if (loop != null) loop.interrupt();
        tracker.stop();
        if (netCallback != null) {
            try {
                getSystemService(ConnectivityManager.class).unregisterNetworkCallback(netCallback);
            } catch (RuntimeException ignored) {
            }
        }
        sender.shutdown();
        if (wake.isHeld()) wake.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ------------------------------------------------------------------
    // the permanent notification, and the service's type
    // ------------------------------------------------------------------

    /**
     * specialUse while it only waits; location added while a trip is on (and
     * only with "Permitir siempre" - Android 14 refuses the type otherwise).
     */
    private void foreground(Notes.Link state) {
        shown = state;
        int type = 0;
        if (Build.VERSION.SDK_INT >= 34) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            if (tracker.running() && Tracker.allowedAlways(this)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        } else if (Build.VERSION.SDK_INT >= 29 && tracker.running() && Tracker.allowedAlways(this)) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }
        try {
            ServiceCompat.startForeground(this, Notes.LINK, Notes.link(this, state), type);
        } catch (RuntimeException e) {
            Log.w(TAG, "startForeground with type " + type + " refused", e);
            int plain = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
            ServiceCompat.startForeground(this, Notes.LINK, Notes.link(this, Notes.Link.FIX), plain);
            shown = Notes.Link.FIX;
        }
    }

    private void show(Notes.Link state) {
        if (state != shown) foreground(state);
    }

    // ------------------------------------------------------------------
    // the poll loop (its own thread)
    // ------------------------------------------------------------------

    private void wakeUp() {
        synchronized (gate) {
            kicked = true;
            gate.notifyAll();
        }
    }

    /** Sleeps `ms`, or until kicked. */
    private void pause(long ms) {
        synchronized (gate) {
            long end = System.currentTimeMillis() + ms;
            while (alive && !kicked) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) break;
                try {
                    gate.wait(left);
                } catch (InterruptedException e) {
                    return;
                }
            }
            kicked = false;
        }
    }

    private boolean online() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        NetworkCapabilities caps = cm.getNetworkCapabilities(cm.getActiveNetwork());
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void pollLoop() {
        int failures = 0;
        while (alive) {
            if (!online()) {
                main.post(() -> show(Notes.Link.OFFLINE));
                pause(5 * 60_000L);
                continue;
            }
            maybeCheckUpdate();
            Api.Reply r;
            try {
                r = Api.get(this, "/api/device/wait?v=" + Uri.encode(version), (holdSeconds + 30) * 1000);
            } catch (IOException e) {
                failures++;
                Log.i(TAG, "wait failed (" + failures + "): " + e);
                if (failures >= 3) main.post(() -> show(Notes.Link.OFFLINE));
                pause(backoff(failures));
                continue;
            }
            // The answer may have woken the CPU from deep sleep: keep it up long
            // enough to act on it and ask again.
            wake.acquire(15_000);
            if (r.status == 200) {
                failures = 0;
                refused = 0;
                if (!Prefs.enrolled(this)) Prefs.setEnrolled(this, true);
                version = r.body.optString("v", "");
                holdSeconds = Math.max(20, Math.min(600, r.body.optInt("hold", 180)));
                JSONObject state = r.body;
                main.post(() -> apply(state));
                flushPositions();
            } else if (r.status == 401) {
                // Not enrolled yet - or revoked in "Mis dispositivos". A revoked
                // token is dead for good: the next one is enrolled anew.
                if (Prefs.enrolled(this)) Prefs.newToken(this);
                version = "";
                main.post(() -> {
                    apply(new JSONObject());
                    show(Notes.Link.ENROL);
                });
                pause(refusedPause(++refused));
            } else {
                failures++;
                Log.i(TAG, "wait answered " + r.status);
                pause(backoff(failures));
            }
        }
    }

    private static long backoff(int failures) {
        return Math.min(5 * 60_000L, 5_000L << Math.min(failures, 6));
    }

    /**
     * After a 401: every 15 s for the first 5 minutes (the user may be signing
     * in to enrol it), then doubling up to an hour - a revoked phone must not
     * keep the CPU awake. Opening the app (start, kick) asks often again.
     */
    private static long refusedPause(int refused) {
        if (refused <= 20) return 15_000L;
        return Math.min(3600_000L, 15_000L << Math.min(refused - 20, 8));
    }

    // ------------------------------------------------------------------
    // what the server said (main thread)
    // ------------------------------------------------------------------

    private void apply(JSONObject s) {
        // Positions: on while a trip covers today.
        trackWanted = s.optBoolean("track", false);
        if (trackWanted && !tracker.running()) {
            tracker.start();
            foreground(Tracker.allowedAlways(this) ? Notes.Link.TRACKING : Notes.Link.FIX);
        } else if (!trackWanted && tracker.running()) {
            tracker.stop();
            foreground(Notes.Link.ON);
        } else if (Prefs.enrolled(this)) {
            show(trackWanted ? (Tracker.allowedAlways(this) ? Notes.Link.TRACKING : Notes.Link.FIX) : Notes.Link.ON);
        }

        Notes.pending(this, s.optInt("badge", 0));

        // "Upload new photos and videos": when it was switched on, 0 = off.
        // An answer with no "media" at all (401, an older server) changes nothing.
        if (s.has("media")) Media.onServer(this, s.optLong("media", 0));

        JSONObject call = s.optJSONObject("call");
        if (call != null && !handled.contains(call.optString("id"))
                && call.optLong("until", Long.MAX_VALUE) > System.currentTimeMillis()) {
            String id = call.optString("id");
            if (!(Ringer.kind() == Ringer.CALL && Ringer.id().equals(id))) {
                Ringer.startCall(this, id);
                Notes.call(this, id, call.optString("from", "Nayive"), call.optBoolean("video"),
                        BuildConfig.ORIGIN + call.optString("url", "/nayive/chat/"));
            }
        } else if (Ringer.kind() == Ringer.CALL) {
            Ringer.stop(this);
            Notes.cancel(this, Notes.CALL);
        }

        JSONObject find = s.optJSONObject("find");
        if (find != null && !handled.contains(find.optString("id"))) {
            String id = find.optString("id");
            if (!(Ringer.kind() == Ringer.FIND && Ringer.id().equals(id))) {
                Ringer.startFind(this, id);
                Notes.find(this, id);
                Tracker.fresh(this, 45_000, l -> reportFound(id, l));
            }
        } else if (Ringer.kind() == Ringer.FIND) {
            Ringer.stop(this);
            Notes.cancel(this, Notes.FIND);
        }
    }

    // ------------------------------------------------------------------
    // what the phone sends
    // ------------------------------------------------------------------

    private void onPosition(Location l) {
        PositionQueue.add(this, l);
        flushPositions();
    }

    /** Sends what is queued, a batch at a time, while the server takes it. */
    private void flushPositions() {
        sender.execute(() -> {
            for (int round = 0; round < 20 && !PositionQueue.isEmpty(this); round++) {
                JSONArray batch = PositionQueue.peek(this);
                try {
                    Api.Reply r = Api.post(this, "/api/device/report", new JSONObject().put("positions", batch));
                    if (!r.ok()) return;
                    PositionQueue.drop(this, batch.length());
                } catch (IOException | JSONException e) {
                    return;   // the next position, or the next wait, tries again
                }
            }
        });
    }

    /** "Buscar mi móvil": where the phone is right now. */
    private void reportFound(String findId, Location l) {
        sender.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("find", findId);
                if (l != null) body.put("positions", new JSONArray().put(PositionQueue.point(l)));
                Api.post(this, "/api/device/report", body);
            } catch (IOException | JSONException e) {
                Log.i(TAG, "find report failed: " + e);
            }
        });
    }

    /** Tells the server what the user did here (decline a call, stop the alarm). */
    static void ack(Context c, JSONObject body) {
        try {
            Api.post(c, "/api/device/ack", body);
        } catch (IOException e) {
            Log.i(TAG, "ack failed: " + e);
        }
        kick();
    }

    // ------------------------------------------------------------------
    // a newer APK
    // ------------------------------------------------------------------

    /** Once a day: <origin>/app/version.json, {"code": N, "url": "..."}. */
    private void maybeCheckUpdate() {
        long now = System.currentTimeMillis();
        if (now - Prefs.updateChecked(this) < 24 * 3600_000L) return;
        Prefs.setUpdateChecked(this, now);
        sender.execute(() -> {
            HttpURLConnection h = null;
            try {
                h = (HttpURLConnection) new URL(BuildConfig.ORIGIN + "/app/version.json").openConnection();
                h.setConnectTimeout(20_000);
                h.setReadTimeout(20_000);
                if (h.getResponseCode() != 200) return;
                java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
                try (java.io.InputStream in = h.getInputStream()) {
                    byte[] b = new byte[4096];
                    int n;
                    while ((n = in.read(b)) > 0 && buf.size() < 65536) buf.write(b, 0, n);
                }
                JSONObject v = new JSONObject(buf.toString("UTF-8"));
                if (v.optInt("code", 0) > BuildConfig.VERSION_CODE) {
                    String url = v.optString("url", "/app/");
                    Notes.update(this, url.startsWith("http") ? url : BuildConfig.ORIGIN + url);
                }
            } catch (IOException | JSONException e) {
                Log.i(TAG, "update check failed: " + e);
            } finally {
                if (h != null) h.disconnect();
            }
        });
    }
}
