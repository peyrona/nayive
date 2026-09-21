package org.nayive.app;

import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;

/**
 * The notification channels, made once. The ring and the alarm are played by
 * {@link Ringer}, not by the channel: a channel's sound plays once, and both
 * have to keep ringing until someone acts.
 */
public class NayiveApp extends Application {

    static final String CH_LINK = "link";        // the service's own, permanent one
    static final String CH_CALLS = "calls";      // an incoming call
    static final String CH_FIND = "find";        // "Buscar mi móvil"
    static final String CH_PENDING = "pending";  // the unread count (the icon's badge)
    static final String CH_UPDATES = "updates";  // a new APK

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);

        NotificationChannel link = new NotificationChannel(CH_LINK, getString(R.string.chan_link),
                NotificationManager.IMPORTANCE_MIN);
        link.setShowBadge(false);

        NotificationChannel calls = new NotificationChannel(CH_CALLS, getString(R.string.chan_calls),
                NotificationManager.IMPORTANCE_HIGH);
        calls.setSound(null, null);
        calls.enableVibration(false);   // Ringer vibrates, in a loop

        NotificationChannel find = new NotificationChannel(CH_FIND, getString(R.string.chan_find),
                NotificationManager.IMPORTANCE_HIGH);
        find.setSound(null, null);
        find.enableVibration(false);
        find.setBypassDnd(true);        // only honoured if the user allows it

        NotificationChannel pending = new NotificationChannel(CH_PENDING, getString(R.string.chan_pending),
                NotificationManager.IMPORTANCE_LOW);
        pending.setShowBadge(true);

        NotificationChannel updates = new NotificationChannel(CH_UPDATES, getString(R.string.chan_updates),
                NotificationManager.IMPORTANCE_DEFAULT);
        updates.setSound(null, (AudioAttributes) null);

        nm.createNotificationChannel(link);
        nm.createNotificationChannel(calls);
        nm.createNotificationChannel(find);
        nm.createNotificationChannel(pending);
        nm.createNotificationChannel(updates);
    }
}
