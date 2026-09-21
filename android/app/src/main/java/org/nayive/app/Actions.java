package org.nayive.app;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the user does about a ring, wherever the button was (the notification
 * or the full-screen page): stop the sound at once, remember the id so a late
 * answer from the server cannot ring it again, and tell the server.
 */
final class Actions {

    private Actions() {}

    static void decline(Context c, String callId) {
        silence(c, callId, Notes.CALL);
        send(c, "call", callId, "decline");
    }

    /** "Contestar": the web page answers the call itself; here it only stops ringing. */
    static void answered(Context c, String callId) {
        silence(c, callId, Notes.CALL);
    }

    static void stopFind(Context c, String findId) {
        silence(c, findId, Notes.FIND);
        send(c, "find", findId, "stop");
    }

    private static void silence(Context c, String id, int note) {
        LinkService.markHandled(id);
        Ringer.stop(c);
        Notes.cancel(c, note);
    }

    private static void send(Context c, String what, String id, String act) {
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                LinkService.ack(app, new JSONObject().put(what, id).put("act", act));
            } catch (JSONException ignored) {
            }
        }, "nayive-ack").start();
    }
}
