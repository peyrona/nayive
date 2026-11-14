package org.nayive.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;

/**
 * The one sound the app makes, looping until someone acts. Two kinds:
 *
 *   CALL  the phone's ringtone, and it obeys the phone like a real call does:
 *         silenced -> nothing, vibrate-only -> it vibrates.
 *   FIND  "Buscar mi móvil": the ALARM stream, turned all the way up, so it is
 *         heard with the phone silenced (the volume is put back afterwards).
 *         Only the strictest "No molestar" can still mute it.
 *
 * One at a time; a new one replaces the old. Everything here runs on the main
 * thread.
 */
final class Ringer {

    private Ringer() {}

    static final int NONE = 0, CALL = 1, FIND = 2, SOS = 3;
    static final long SOS_RING_MS = 2 * 60_000L;   // an SOS alarm stops by itself after this
    private static final android.os.Handler later = new android.os.Handler(android.os.Looper.getMainLooper());

    private static MediaPlayer player;
    private static Vibrator vibrator;
    private static int kind = NONE;
    private static String id = "";
    private static int alarmVolumeBefore = -1;
    private static Runnable onStop;   // RingActivity closes itself through this

    static int kind() { return kind; }

    static String id() { return id; }

    static void setOnStop(Runnable r) { onStop = r; }

    /** At the app's start: a find or SOS that died while ringing left the alarm at full volume. */
    static void restoreVolume(Context c) {
        int before = Prefs.alarmVolume(c);
        if (before < 0 || kind != NONE) return;
        try {
            c.getSystemService(AudioManager.class).setStreamVolume(AudioManager.STREAM_ALARM, before, 0);
        } catch (SecurityException ignored) {
        }
        Prefs.setAlarmVolume(c, -1);
    }

    static void startCall(Context c, String callId) {
        if (kind == CALL && id.equals(callId)) return;
        stop(c);
        kind = CALL;
        id = callId;
        AudioManager am = c.getSystemService(AudioManager.class);
        int mode = am.getRingerMode();
        if (mode == AudioManager.RINGER_MODE_NORMAL) {
            play(c, RingtoneManager.TYPE_RINGTONE, AudioAttributes.USAGE_NOTIFICATION_RINGTONE);
        }
        if (mode != AudioManager.RINGER_MODE_SILENT) {
            vibrate(c, new long[]{0, 900, 700}, false);
        }
    }

    static void startFind(Context c, String findId) {
        if (kind == FIND && id.equals(findId)) return;
        stop(c);
        kind = FIND;
        id = findId;
        AudioManager am = c.getSystemService(AudioManager.class);
        alarmVolumeBefore = am.getStreamVolume(AudioManager.STREAM_ALARM);
        Prefs.setAlarmVolume(c, alarmVolumeBefore);   // put back at the next start if the app dies now
        try {
            am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
        } catch (SecurityException e) {
            Log.w("Nayive", "cannot raise the alarm volume", e);   // "No molestar" may forbid it
        }
        play(c, RingtoneManager.TYPE_ALARM, AudioAttributes.USAGE_ALARM);
        vibrate(c, new long[]{0, 600, 400}, true);
    }

    /** An SOS alert or "Are you OK?": the alarm, like a find, for SOS_RING_MS at most. */
    static void startSos(Context c, String tag) {
        if (kind == CALL) return;   // never over a call
        startFind(c, tag);
        kind = SOS;
        later.removeCallbacksAndMessages(null);
        later.postDelayed(() -> {
            if (kind == SOS && id.equals(tag)) {
                stop(c);
                LinkService.reapply();   // a find that was waiting under the SOS rings now
            }
        }, SOS_RING_MS);
    }

    static void stop(Context c) {
        if (player != null) {
            try {
                player.stop();
            } catch (IllegalStateException ignored) {
            }
            player.release();
            player = null;
        }
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
        if (alarmVolumeBefore >= 0) {
            try {
                c.getSystemService(AudioManager.class)
                        .setStreamVolume(AudioManager.STREAM_ALARM, alarmVolumeBefore, 0);
            } catch (SecurityException ignored) {
            }
            alarmVolumeBefore = -1;
            Prefs.setAlarmVolume(c, -1);
        }
        boolean was = kind != NONE;
        kind = NONE;
        id = "";
        if (was && onStop != null) onStop.run();
    }

    /**
     * Settings' own copy of the sound first (content://settings/...): any app
     * can read it, while the real file of a user's own tone may need a media
     * permission the app does not have. If one cannot play, the next one.
     */
    private static void play(Context c, int type, int usage) {
        int[] order = type == RingtoneManager.TYPE_ALARM
                ? new int[]{RingtoneManager.TYPE_ALARM, RingtoneManager.TYPE_RINGTONE, RingtoneManager.TYPE_NOTIFICATION}
                : new int[]{type, RingtoneManager.TYPE_NOTIFICATION};
        for (int t : order) {
            if (play(c, RingtoneManager.getDefaultUri(t), usage)) return;
            if (play(c, RingtoneManager.getActualDefaultRingtoneUri(c, t), usage)) return;
        }
    }

    private static boolean play(Context c, Uri uri, int usage) {
        if (uri == null) return false;
        MediaPlayer p = new MediaPlayer();
        try {
            p.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(usage)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            p.setDataSource(c, uri);
            p.setLooping(true);
            p.prepare();
            p.start();
            player = p;
            return true;
        } catch (Exception e) {
            Log.w("Nayive", "cannot play " + uri, e);
            p.release();
            return false;
        }
    }

    /** Tagged as a ringtone or an alarm: an untagged vibration may be muted. */
    @SuppressWarnings("deprecation")
    private static void vibrate(Context c, long[] pattern, boolean alarm) {
        Vibrator v;
        if (Build.VERSION.SDK_INT >= 31) {
            v = c.getSystemService(VibratorManager.class).getDefaultVibrator();
        } else {
            v = c.getSystemService(Vibrator.class);
        }
        if (v == null || !v.hasVibrator()) return;
        VibrationEffect effect = VibrationEffect.createWaveform(pattern, 1);
        if (Build.VERSION.SDK_INT >= 33) {
            v.vibrate(effect, VibrationAttributes.createForUsage(
                    alarm ? VibrationAttributes.USAGE_ALARM : VibrationAttributes.USAGE_RINGTONE));
        } else {
            v.vibrate(effect, new AudioAttributes.Builder()
                    .setUsage(alarm ? AudioAttributes.USAGE_ALARM : AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build());
        }
        vibrator = v;
    }
}
