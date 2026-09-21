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

    static final int NONE = 0, CALL = 1, FIND = 2;

    private static MediaPlayer player;
    private static Vibrator vibrator;
    private static int kind = NONE;
    private static String id = "";
    private static int alarmVolumeBefore = -1;
    private static Runnable onStop;   // RingActivity closes itself through this

    static int kind() { return kind; }

    static String id() { return id; }

    static void setOnStop(Runnable r) { onStop = r; }

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
        try {
            am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
        } catch (SecurityException e) {
            Log.w("Nayive", "cannot raise the alarm volume", e);   // "No molestar" may forbid it
        }
        play(c, RingtoneManager.TYPE_ALARM, AudioAttributes.USAGE_ALARM);
        vibrate(c, new long[]{0, 600, 400}, true);
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
        }
        boolean was = kind != NONE;
        kind = NONE;
        id = "";
        if (was && onStop != null) onStop.run();
    }

    private static void play(Context c, int type, int usage) {
        Uri uri = RingtoneManager.getActualDefaultRingtoneUri(c, type);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
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
        } catch (Exception e) {
            Log.w("Nayive", "cannot play " + uri, e);
            p.release();
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
