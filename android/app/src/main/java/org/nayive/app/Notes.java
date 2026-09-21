package org.nayive.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;

/** Every notification the app shows, in one place. */
final class Notes {

    private Notes() {}

    static final int LINK = 1, CALL = 2, FIND = 3, PENDING = 4, UPDATE = 5;

    /** What the permanent notification says. */
    enum Link { ON, TRACKING, ENROL, OFFLINE, FIX }

    private static final int IMMUTABLE = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;

    static Notification link(Context c, Link state) {
        int text;
        Intent open;
        switch (state) {
            case TRACKING: text = R.string.link_tracking; open = new Intent(c, MainActivity.class); break;
            case ENROL: text = R.string.link_enrol; open = new Intent(c, MainActivity.class); break;
            case OFFLINE: text = R.string.link_offline; open = new Intent(c, MainActivity.class); break;
            case FIX: text = R.string.link_fix; open = new Intent(MainActivity.ACTION_SETUP).setClass(c, MainActivity.class); break;
            default: text = R.string.link_on; open = new Intent(c, MainActivity.class);
        }
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return new NotificationCompat.Builder(c, NayiveApp.CH_LINK)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(c.getString(text))
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(PendingIntent.getActivity(c, 10, open, IMMUTABLE))
                .build();
    }

    /** An incoming call: the call screen over the lock screen, and the two buttons. */
    static void call(Context c, String id, String from, boolean video, String url) {
        PendingIntent full = PendingIntent.getActivity(c, 20,
                RingActivity.intent(c, RingActivity.CALL, id, from, video, url), IMMUTABLE);
        PendingIntent answer = PendingIntent.getActivity(c, 21, Launcher.answer(c, id, url), IMMUTABLE);
        PendingIntent decline = PendingIntent.getBroadcast(c, 22,
                ActionReceiver.intent(c, ActionReceiver.DECLINE, id), IMMUTABLE);
        Person caller = new Person.Builder().setName(from).setImportant(true).build();
        Notification n = new NotificationCompat.Builder(c, NayiveApp.CH_CALLS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(from)
                .setContentText(c.getString(video ? R.string.call_video : R.string.call_voice))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(true)
                // NOT setSilent(): NotificationCompat files a silent note in a
                // group that never alerts, and Android then drops the full
                // screen. The channel is the silent part; Ringer makes the sound.
                .setFullScreenIntent(full, true)
                .setContentIntent(full)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
                .build();
        c.getSystemService(NotificationManager.class).notify(CALL, n);
    }

    /** "Buscar mi móvil": over the lock screen, with Parar. */
    static void find(Context c, String id) {
        PendingIntent full = PendingIntent.getActivity(c, 30,
                RingActivity.intent(c, RingActivity.FIND, id, null, false, null), IMMUTABLE);
        PendingIntent stop = PendingIntent.getBroadcast(c, 31,
                ActionReceiver.intent(c, ActionReceiver.STOP_FIND, id), IMMUTABLE);
        Notification n = new NotificationCompat.Builder(c, NayiveApp.CH_FIND)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(c.getString(R.string.find_title))
                .setContentText(c.getString(R.string.find_text))
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(true)
                // Silent by its channel, not setSilent() - see call().
                .setFullScreenIntent(full, true)
                .setContentIntent(full)
                .addAction(0, c.getString(R.string.find_stop), stop)
                .build();
        c.getSystemService(NotificationManager.class).notify(FIND, n);
    }

    /**
     * The unread count. A launcher only puts a number (or a dot) on the icon
     * while a notification carries it, so this one stays while n > 0 - silent,
     * low, and gone at 0. Samsung and most launchers show the number; Pixel
     * shows a dot.
     */
    static void pending(Context c, int n) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (n <= 0) {
            nm.cancel(PENDING);
            return;
        }
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.ORIGIN + "/nayive/chat/"))
                .setClass(c, Launcher.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Notification note = new NotificationCompat.Builder(c, NayiveApp.CH_PENDING)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(c.getResources().getQuantityString(R.plurals.pending_chat, n, n))
                .setNumber(n)
                .setBadgeIconType(NotificationCompat.BADGE_ICON_SMALL)
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(c, 40, open, IMMUTABLE))
                .build();
        nm.notify(PENDING, note);
    }

    static void update(Context c, String url) {
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Notification n = new NotificationCompat.Builder(c, NayiveApp.CH_UPDATES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(c.getString(R.string.update_title))
                .setContentText(c.getString(R.string.update_text))
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(c, 50, open, IMMUTABLE))
                .build();
        c.getSystemService(NotificationManager.class).notify(UPDATE, n);
    }

    static void cancel(Context c, int id) {
        c.getSystemService(NotificationManager.class).cancel(id);
    }
}
