package org.nayive.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The full-screen page of a ring, over the lock screen: a call (Contestar /
 * Rechazar) or "Buscar mi móvil" (one big Parar). It closes itself when the
 * ringing stops, whoever stopped it.
 */
public class RingActivity extends Activity {

    static final String CALL = "call", FIND = "find";

    static Intent intent(Context c, String kind, String id, String from, boolean video, String url) {
        return new Intent(c, RingActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION)
                .putExtra("kind", kind).putExtra("id", id).putExtra("from", from)
                .putExtra("video", video).putExtra("url", url);
    }

    private String kind, id;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT < 27) {
            //noinspection deprecation
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        render(getIntent());
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        render(i);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Ringer.setOnStop(this::finish);
        if (Ringer.kind() == Ringer.NONE) finish();   // stopped while we were away
    }

    @Override
    protected void onPause() {
        Ringer.setOnStop(null);
        super.onPause();
    }

    private void render(Intent i) {
        kind = i.getStringExtra("kind");
        id = i.getStringExtra("id");
        boolean call = CALL.equals(kind);

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.CENTER);
        page.setBackgroundColor(getColor(R.color.nayive_bg));
        int pad = dp(28);
        page.setPadding(pad, pad, pad, pad);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.splash);
        page.addView(logo, new LinearLayout.LayoutParams(dp(120), dp(120)));

        TextView title = text(call ? i.getStringExtra("from") : getString(R.string.find_title), 28, R.color.nayive_text);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        page.addView(title, spaced(dp(28)));
        page.addView(text(call
                ? getString(i.getBooleanExtra("video", false) ? R.string.call_video : R.string.call_voice)
                : getString(R.string.find_text), 17, R.color.nayive_dim), spaced(dp(8)));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setGravity(Gravity.CENTER);
        if (call) {
            String url = i.getStringExtra("url");
            buttons.addView(button(R.string.call_decline, R.color.nayive_danger, v -> {
                Actions.decline(this, id);
                finish();
            }), weighted());
            buttons.addView(button(R.string.call_answer, R.color.nayive_accent, v -> {
                unlockThen(() -> {
                    startActivity(Launcher.answer(this, id, url));
                    finish();
                });
            }), weighted());
        } else {
            buttons.addView(button(R.string.find_stop, R.color.nayive_accent, v -> {
                Actions.stopFind(this, id);
                finish();
            }), weighted());
        }
        page.addView(buttons, spaced(dp(56)));
        setContentView(page);
    }

    /** Answering opens Nayive, which needs the phone unlocked: ask for it first. */
    private void unlockThen(Runnable then) {
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (km == null || !km.isKeyguardLocked()) {
            then.run();
            return;
        }
        km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
            @Override
            public void onDismissSucceeded() { then.run(); }
        });
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(getColor(color));
        t.setGravity(Gravity.CENTER);
        return t;
    }

    private Button button(int label, int color, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        b.setTextColor(getColor(R.color.nayive_on_accent));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(getColor(color));
        bg.setCornerRadius(dp(32));
        b.setBackground(bg);
        b.setMinHeight(dp(64));
        // The screen turns on by itself, not by a touch: without this the
        // first button wears the grey focus box around its pill.
        b.setDefaultFocusHighlightEnabled(false);
        b.setOnClickListener(l);
        return b;
    }

    private LinearLayout.LayoutParams spaced(int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.topMargin = top;
        return p;
    }

    private LinearLayout.LayoutParams weighted() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(64), 1f);
        p.setMargins(dp(10), 0, dp(10), 0);
        return p;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
