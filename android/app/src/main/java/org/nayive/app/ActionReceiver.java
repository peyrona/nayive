package org.nayive.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The notification buttons that do not open anything: Rechazar, Parar. */
public class ActionReceiver extends BroadcastReceiver {

    static final String DECLINE = "org.nayive.app.DECLINE";
    static final String STOP_FIND = "org.nayive.app.STOP_FIND";

    static Intent intent(Context c, String action, String id) {
        return new Intent(action).setClass(c, ActionReceiver.class).putExtra("id", id);
    }

    @Override
    public void onReceive(Context c, Intent i) {
        String id = i.getStringExtra("id");
        if (DECLINE.equals(i.getAction())) {
            Actions.decline(c, id);
        } else if (STOP_FIND.equals(i.getAction())) {
            Actions.stopFind(c, id);
        }
    }
}
