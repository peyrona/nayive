package org.nayive.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Back after a restart, or after an update of the app itself. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            LinkService.start(c);
        }
    }
}
