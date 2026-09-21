package org.nayive.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;

import java.util.function.Consumer;

/**
 * The phone's position, with the platform's own LocationManager - no Google
 * Play Services, so the APK carries no Google library. On Android 12+ the
 * platform's "fused" provider mixes GPS, Wi-Fi and cell by itself; before
 * that, GPS and network are asked separately.
 *
 * Runs on the main looper.
 */
final class Tracker implements LocationListener {

    /** One position every this long while a trip is on. The server keeps one per 15 min. */
    static final long EVERY_MS = 5 * 60_000L;

    private final Context ctx;
    private final Consumer<Location> sink;
    private boolean running;

    Tracker(Context ctx, Consumer<Location> sink) {
        this.ctx = ctx.getApplicationContext();
        this.sink = sink;
    }

    static boolean allowed(Context c) {
        return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** "Permitir siempre" - what a service started from the background needs. */
    static boolean allowedAlways(Context c) {
        return allowed(c) && (Build.VERSION.SDK_INT < 29
                || c.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED);
    }

    boolean running() { return running; }

    @SuppressLint("MissingPermission")
    boolean start() {
        if (running) return true;
        if (!allowed(ctx)) return false;
        LocationManager lm = ctx.getSystemService(LocationManager.class);
        try {
            if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.FUSED_PROVIDER, EVERY_MS, 0, this, Looper.getMainLooper());
            } else {
                boolean any = false;
                for (String p : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                    if (lm.getAllProviders().contains(p)) {
                        lm.requestLocationUpdates(p, EVERY_MS, 0, this, Looper.getMainLooper());
                        any = true;
                    }
                }
                if (!any) return false;
            }
        } catch (SecurityException | IllegalArgumentException e) {
            return false;
        }
        running = true;
        return true;
    }

    void stop() {
        if (!running) return;
        ctx.getSystemService(LocationManager.class).removeUpdates(this);
        running = false;
    }

    @Override
    public void onLocationChanged(Location l) {
        sink.accept(l);
    }

    // Needed below API 30, where these are abstract.
    @Override
    public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    /**
     * One position NOW, for "Buscar mi móvil": the best the phone can get in
     * `timeoutMs`, or else the freshest one it already had, or null.
     */
    @SuppressLint("MissingPermission")
    static void fresh(Context c, long timeoutMs, Consumer<Location> done) {
        Handler main = new Handler(Looper.getMainLooper());
        if (!allowed(c)) {
            main.post(() -> done.accept(null));
            return;
        }
        LocationManager lm = c.getSystemService(LocationManager.class);
        boolean[] finished = {false};
        Consumer<Location> once = l -> {
            if (finished[0]) return;
            finished[0] = true;
            done.accept(l != null ? l : lastKnown(lm));
        };
        main.postDelayed(() -> once.accept(null), timeoutMs);
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                String p = Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER)
                        ? LocationManager.FUSED_PROVIDER : LocationManager.GPS_PROVIDER;
                CancellationSignal cancel = new CancellationSignal();
                main.postDelayed(cancel::cancel, timeoutMs);
                lm.getCurrentLocation(p, cancel, c.getMainExecutor(), l -> main.post(() -> once.accept(l)));
            } else {
                //noinspection deprecation
                lm.requestSingleUpdate(LocationManager.GPS_PROVIDER, l -> once.accept(l), Looper.getMainLooper());
            }
        } catch (SecurityException | IllegalArgumentException e) {
            main.post(() -> once.accept(null));
        }
    }

    @SuppressLint("MissingPermission")
    private static Location lastKnown(LocationManager lm) {
        Location best = null;
        try {
            for (String p : lm.getAllProviders()) {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            }
        } catch (SecurityException ignored) {
        }
        return best;
    }
}
