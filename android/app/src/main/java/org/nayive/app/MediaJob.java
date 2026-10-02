package org.nayive.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.util.Log;

/**
 * The photo upload's clock: once every 24 h, only on Wi-Fi (an unmetered
 * network), never with the battery low - JobScheduler, the platform's own, no
 * WorkManager. A job gets about ten minutes: when they run short, or the Wi-Fi
 * goes, it books a one-off job to go on at the next chance instead of waiting
 * a whole day.
 */
public class MediaJob extends JobService {

    private static final String TAG = "Nayive";
    static final int DAILY = 100, MORE = 101;

    /** Leaves room under the system's ~10 minutes to answer and book the next one. */
    private static final long BUDGET_MS = 8 * 60_000L;

    /** The daily job and the one-off may both be due: one sends, the other leaves. */
    private static final java.util.concurrent.atomic.AtomicBoolean busy = new java.util.concurrent.atomic.AtomicBoolean();

    private volatile boolean stopped;

    @Override
    public boolean onStartJob(JobParameters params) {
        if (!Media.on(this)) {
            cancel(this);
            return false;
        }
        if (!Media.allowed(this)) {
            Notes.mediaFix(this);   // at most once a day: the daily job's own pace
            return false;
        }
        if (!busy.compareAndSet(false, true)) return false;
        stopped = false;
        new Thread(() -> {
            try {
                MediaUploader.Result r = MediaUploader.run(this, System.currentTimeMillis() + BUDGET_MS, () -> stopped);
                Notes.mediaDone(this, r.photos, r.videos, r.folders);
                if (r.finished || r.photos + r.videos > 0) Prefs.setMediaFails(this, 0);
                if (!r.finished && !stopped) {
                    // Nothing went through (the server down, an error): wait longer each time.
                    if (r.photos + r.videos == 0) Prefs.setMediaFails(this, Prefs.mediaFails(this) + 1);
                    more(this);
                }
            } finally {
                busy.set(false);
                jobFinished(params, false);
            }
        }, "nayive-media").start();
        return true;
    }

    /** Wi-Fi gone, or the system wants its time back: go on at the next chance. */
    @Override
    public boolean onStopJob(JobParameters params) {
        stopped = true;
        more(this);
        return false;
    }

    private static JobScheduler js(Context c) { return c.getSystemService(JobScheduler.class); }

    /** The daily job, once: booking it again would move its next run. */
    static void schedule(Context c) {
        if (js(c).getPendingJob(DAILY) != null) return;
        JobInfo job = new JobInfo.Builder(DAILY, new ComponentName(c, MediaJob.class))
                .setPeriodic(24 * 3600_000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .setRequiresBatteryNotLow(true)
                .setPersisted(true)
                .build();
        if (js(c).schedule(job) != JobScheduler.RESULT_SUCCESS) Log.w(TAG, "media job refused");
    }

    /** One more go, on the next Wi-Fi: a minute later, doubled for each run that sent nothing, up to 6 h. */
    static void more(Context c) {
        long wait = Math.min(6 * 3600_000L, 60_000L << Math.min(Prefs.mediaFails(c), 9));
        JobInfo job = new JobInfo.Builder(MORE, new ComponentName(c, MediaJob.class))
                .setMinimumLatency(wait)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .setRequiresBatteryNotLow(true)
                .setPersisted(true)
                .build();
        js(c).schedule(job);
    }

    static void cancel(Context c) {
        js(c).cancel(DAILY);
        js(c).cancel(MORE);
    }
}
