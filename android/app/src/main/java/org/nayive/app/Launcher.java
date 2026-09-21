package org.nayive.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/**
 * The screen: Nayive itself, in a Trusted Web Activity - Chrome's engine, full
 * screen, the same pages as the browser, nothing rewritten.
 *
 * Until the server knows this phone, it opens <origin>/nayive/device.html
 * instead, carrying the device token in the #fragment (never sent to the
 * server, never logged): that public page keeps it in the browser and goes on
 * to /nayive/ - through the login if needed - where the launcher enrols it.
 */
public class Launcher extends LauncherActivity {

    static final String EXTRA_ANSWER = "org.nayive.app.ANSWER";

    /** "Contestar": open the chat on that call. */
    static Intent answer(Context c, String callId, String url) {
        return new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .setClass(c, Launcher.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_ANSWER, callId);
    }

    @Override
    protected void onCreate(Bundle b) {
        String callId = getIntent().getStringExtra(EXTRA_ANSWER);
        if (callId != null) Actions.answered(this, callId);
        LinkService.start(this);
        LinkService.kick();
        super.onCreate(b);
    }

    @Override
    protected Uri getLaunchingUrl() {
        Uri data = getIntent().getData();
        if (data == null && !Prefs.enrolled(this)) {
            String name = (Build.MANUFACTURER + " " + Build.MODEL).trim();
            return Uri.parse(BuildConfig.ORIGIN + "/nayive/device.html#t=" + Prefs.token(this)
                    + "&n=" + Uri.encode(name));
        }
        return super.getLaunchingUrl();
    }
}
