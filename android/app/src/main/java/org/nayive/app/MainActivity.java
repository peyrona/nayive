package org.nayive.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * The icon's entry. The first time (or from the long-press shortcut
 * "Permisos"): the permissions, one row each, with why in one plain sentence.
 * Every other time: straight to Nayive, showing nothing of its own.
 *
 * The permissions are where this app is won or lost - it is for people who do
 * not like installing apps - so each row says what stops working without it,
 * and "Continuar" is never blocked.
 */
public class MainActivity extends Activity {

    static final String ACTION_SETUP = "org.nayive.app.SETUP";

    private static final int REQ_NOTIF = 1, REQ_LOC = 2, REQ_BG = 3;

    /** How many times each request was answered "no" - after that, Settings. */
    private final int[] refused = new int[4];

    private final List<Runnable> refreshers = new ArrayList<>();
    private TextView missing;

    @Override
    protected void onCreate(Bundle b) {
        boolean setup = ACTION_SETUP.equals(getIntent().getAction()) || !Prefs.setupDone(this);
        if (setup) setTheme(R.style.Theme_Nayive);
        super.onCreate(b);
        if (!setup) {
            openNayive();
            return;
        }
        build();
    }

    @Override
    protected void onResume() {
        super.onResume();
        for (Runnable r : refreshers) r.run();
    }

    private void openNayive() {
        LinkService.start(this);
        // NEW_TASK, or LauncherActivity restarts itself in a new task, and that
        // second copy - born while this first one still lives - closes at once
        // (it counts two alive): nothing opens, the home screen shows.
        startActivity(new Intent(this, Launcher.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }

    // ------------------------------------------------------------------
    // the four permissions
    // ------------------------------------------------------------------

    private boolean notifOk() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return getSystemService(NotificationManager.class).areNotificationsEnabled();
    }

    private boolean locOk() { return Tracker.allowedAlways(this); }

    private boolean battOk() {
        return getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
    }

    private boolean fullOk() {
        return Build.VERSION.SDK_INT < 34 || getSystemService(NotificationManager.class).canUseFullScreenIntent();
    }

    private void askNotif() {
        if (Build.VERSION.SDK_INT >= 33 && refused[0] < 2
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
            return;
        }
        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
    }

    private void askLoc() {
        if (!Tracker.allowed(this)) {
            if (refused[1] < 2) {
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
            } else {
                appSettings();
            }
            return;
        }
        // "Permitir siempre" is a second request, on its own: Android 11+
        // answers it by opening the app's location page in Settings.
        if (Build.VERSION.SDK_INT >= 29 && refused[2] < 2) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, REQ_BG);
        } else {
            appSettings();
        }
    }

    private void askBatt() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (RuntimeException e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void askFull() {
        if (Build.VERSION.SDK_INT >= 34) {
            startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    Uri.parse("package:" + getPackageName())));
        }
    }

    private void appSettings() {
        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName())));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (!granted && code >= 1 && code <= 3) refused[code - 1]++;
        for (Runnable r : refreshers) r.run();
    }

    // ------------------------------------------------------------------
    // the page
    // ------------------------------------------------------------------
    //
    // It must fit ONE screen - no scrolling - on any phone, in any language,
    // at any font size. So every size below is a base size times `scale`,
    // and after each layout fit() shrinks the page a step while it is still
    // taller than the screen - before it is ever drawn: first the logo goes,
    // then everything gets a little smaller, down to MIN_SCALE. Only past that (landscape, huge
    // fonts) does the ScrollView scroll. "Continuar" sits at the bottom.

    private static final float MIN_SCALE = 0.62f;

    private LinearLayout page;
    private ScrollView scroll;
    private ImageView logo;
    private float scale = 1f;

    /** A text and its base size in sp; its top gap (dp) when it has one. */
    private final List<Object[]> sized = new ArrayList<>();
    /** Views whose top gap (dp) scales. */
    private final List<Object[]> gapped = new ArrayList<>();
    /** Cards, whose inner padding (dp) scales; pills, whose height (dp) does. */
    private final List<View> cards = new ArrayList<>();
    private final List<Object[]> pills = new ArrayList<>();

    private void build() {
        // Drawn under the status and navigation bars (Android 15+ does it
        // anyway); their height comes back as padding in insets().
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);

        logo = new ImageView(this);
        logo.setImageResource(R.drawable.splash);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(64), dp(64));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        page.addView(logo, lp);

        TextView title = text(getString(R.string.setup_title), 22, R.color.nayive_text);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        add(title, 10);
        TextView lead = text(getString(R.string.setup_lead), 15, R.color.nayive_dim);
        lead.setGravity(Gravity.CENTER);
        add(lead, 6);

        add(step(R.string.step_notif_title, R.string.step_notif_why, this::notifOk, this::askNotif), 18);
        add(step(R.string.step_loc_title, R.string.step_loc_why, this::locOk, this::askLoc), 10);
        add(step(R.string.step_batt_title, R.string.step_batt_why, this::battOk, this::askBatt), 10);
        if (Build.VERSION.SDK_INT >= 34) {
            add(step(R.string.step_full_title, R.string.step_full_why, this::fullOk, this::askFull), 10);
        }

        missing = text(getString(R.string.setup_missing), 13, R.color.nayive_dim);
        add(missing, 14);
        refreshers.add(() -> missing.setVisibility(
                notifOk() && locOk() && battOk() && fullOk() ? View.GONE : View.VISIBLE));

        // What is left of the screen goes here, so "Continuar" is at the bottom.
        page.addView(new View(this), new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        Button go = pill(getString(R.string.setup_continue), 17, 52);
        go.setOnClickListener(v -> {
            Prefs.setSetupDone(this);
            openNayive();
        });
        add(go, 14);

        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(getColor(R.color.nayive_bg));
        scroll.addView(page, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.MATCH_PARENT));
        scroll.setOnApplyWindowInsetsListener((v, in) -> {
            insets(in);
            return in;
        });
        scroll.getViewTreeObserver().addOnPreDrawListener(() -> !fit()); // shrunk: skip this frame
        setContentView(scroll);
        applyScale();
    }

    /** The system bars' and the camera cutout's room, plus the page's own margin. */
    private void insets(android.view.WindowInsets in) {
        int top = 0, bottom = 0, left = 0, right = 0;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets b = in.getInsets(android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout());
            top = b.top; bottom = b.bottom; left = b.left; right = b.right;
        } else {
            top = in.getSystemWindowInsetTop(); bottom = in.getSystemWindowInsetBottom();
            left = in.getSystemWindowInsetLeft(); right = in.getSystemWindowInsetRight();
        }
        scroll.setPadding(left, top, right, bottom);
    }

    /** Still taller than the screen: one step smaller. False when nothing changed. */
    private boolean fit() {
        int room = scroll.getHeight() - scroll.getPaddingTop() - scroll.getPaddingBottom();
        if (room <= 0 || page.getHeight() <= room) return false;
        if (logo.getVisibility() == View.VISIBLE) {
            logo.setVisibility(View.GONE);
        } else if (scale > MIN_SCALE) {
            scale = Math.max(MIN_SCALE, scale - 0.06f);
            applyScale();
        } else {
            return false;   // as small as it goes: the ScrollView scrolls
        }
        return true;
    }

    private void applyScale() {
        int side = sdp(20), end = sdp(16);
        page.setPadding(side, end, side, end);
        for (Object[] t : sized) ((TextView) t[0]).setTextSize(TypedValue.COMPLEX_UNIT_SP, (float) t[1] * scale);
        for (Object[] g : gapped) {
            View v = (View) g[0];
            LinearLayout.LayoutParams p = (LinearLayout.LayoutParams) v.getLayoutParams();
            p.topMargin = sdp((int) g[1]);
            v.setLayoutParams(p);
        }
        for (View c : cards) {
            int pad = sdp(14);
            c.setPadding(pad, sdp(12), pad, sdp(12));
        }
        for (Object[] b : pills) {
            Button p = (Button) b[0];
            int h = Math.max(dp(36), sdp((int) b[1]));
            p.setMinHeight(h);
            p.setMinimumHeight(h);
        }
    }

    private void add(View v, int topGap) {
        page.addView(v, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        gapped.add(new Object[]{v, topGap});
    }

    private interface Check { boolean ok(); }

    /** One permission: its name, why, and Permitir - or a quiet "Hecho". */
    private View step(int name, int why, Check check, Runnable ask) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(getColor(R.color.nayive_card));
        bg.setCornerRadius(dp(14));
        card.setBackground(bg);
        cards.add(card);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView t = text(getString(name), 17, R.color.nayive_text);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        row.addView(t, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        Button act = pill(getString(R.string.step_do), 15, 40);
        act.setMinWidth(dp(100));
        act.setOnClickListener(v -> ask.run());
        row.addView(act);
        card.addView(row);

        TextView w = text(getString(why), 14, R.color.nayive_dim);
        LinearLayout.LayoutParams wl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        card.addView(w, wl);
        gapped.add(new Object[]{w, 4});

        refreshers.add(() -> {
            boolean ok = check.ok();
            act.setText(ok ? R.string.step_ok : R.string.step_do);
            act.setEnabled(!ok);
            act.setAlpha(ok ? 0.6f : 1f);
            // Location granted "while in use" only: say what is still missing.
            if (name == R.string.step_loc_title && !ok && Tracker.allowed(this)) {
                w.setText(R.string.step_loc_bg);
            } else {
                w.setText(why);
            }
        });
        return card;
    }

    private TextView text(String s, float sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(getColor(color));
        sized.add(new Object[]{t, sp});
        return t;
    }

    private Button pill(String label, float sp, int height) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(getColor(R.color.nayive_on_accent));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(getColor(R.color.nayive_accent));
        bg.setCornerRadius(dp(26));
        b.setBackground(bg);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(14), 0, dp(14), 0);
        sized.add(new Object[]{b, sp});
        pills.add(new Object[]{b, height});
        return b;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** dp times the current scale. */
    private int sdp(int v) {
        return Math.round(v * scale * getResources().getDisplayMetrics().density);
    }
}
