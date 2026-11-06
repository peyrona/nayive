/* Ayni library 0.2.0, installed apps: the install offer, the browser warning, the update bar, the session bar, push keys, the low
   battery dialog. Plain JavaScript, no build step, evergreen browsers 2024+. Optional: load it after ayni-base.js, with ayni-pwa.css,
   and call Ayni.pwa.config({ app, logo, keys: { install, browser, batt }, apkRef, apkKey, held(), page(), signIn() }) as the page starts.
   app: its name, for the texts. held(): true while the page wants nothing to open over it. page(): true on a page that may warn.
   signIn(): goes to the sign-in page. Rules: chapter 18.9 of the guidelines. */
( function ()
{
    "use strict";

    var cfg = { app: "", logo: "", keys: { install: "ayni-install", browser: "ayni-browser-warn", batt: "ayni-batt-warned" },
                apkKey: "", held: null, page: function () { return ! Ayni.frame.embedded; }, signIn: function () {} };
    var i18nApp = function ( v ) { return Object.assign( { app: cfg.app }, v ); };
    function t( k, v )  { return Ayni.tf( k, i18nApp( v ) ); }
    var tf = t;
    function held()     { return !! ( cfg.held && cfg.held() ); }

    // A × button of class `cls`, titled `title` ("Cerrar" when none), that runs `onClick`.
    function xButton( cls, onClick, title )
    {
        var b = document.createElement( "button" );
        b.type      = "button";
        b.className = cls;
        Ayni.setTip( b, title || t( "ayni.close" ) );
        b.setAttribute( "aria-label", b.dataset.tip );
        b.innerHTML = Ayni.icon( "close" );
        if( onClick ) b.addEventListener( "click", onClick );
        return b;
    }

    //------------------------------------------------------------------------//
    // "INSTALL THIS APP" DIALOG
    //
    // Installing an app is the single most useful thing a new user can
    // do (own icon, full screen, faster start, offline apps, share-to-Photos) and
    // the one almost nobody knows about - so this is a proper dialog that says
    // what you get, not a one-line bar.
    //
    // Chrome / Edge / Android fire `beforeinstallprompt`: we stash it and call
    // .prompt() when the user taps "Instalar". iOS never fires it, so there we
    // show the three real steps (Compartir -> Añadir a pantalla de inicio ->
    // Añadir). Two ways in:
    //
    //   Ayni.pwa.offerInstall()                  // automatic nudge (the launcher)
    //   Ayni.pwa.offerInstall( { manual: true } ) // the launcher's "Instalar app" button
    //
    // The automatic one only speaks when the install is really possible. It comes
    // back on EVERY visit (so on every login) until the app is installed or the
    // user clicks "No mostrar más"; "Ahora no" only hides it for the rest of this
    // visit. It waits for the launcher's welcome dialog to close first (two modals
    // at once is one too many). The manual one always opens and always explains
    // something - including "your browser can't".

    var deferredInstall = null;   // the saved beforeinstallprompt event (Chromium)
    var installPending  = false;  // a retry is already queued (both launcher calls share it)
    var installTries    = 0;      // give up after a while instead of retrying forever
    var installLater    = false;  // "Ahora no" this visit: quiet until the next page load

    window.addEventListener( "beforeinstallprompt", function ( e )
    {
        e.preventDefault();               // keep Chrome's own mini-infobar away
        deferredInstall = e;
        // Chromium never fires this while the app IS installed, so the event
        // itself proves an old "installed" flag is stale (they uninstalled it).
        try { if( localStorage.getItem( cfg.keys.install ) === "installed" )
                  localStorage.removeItem( cfg.keys.install ); } catch ( _ ) {}
    } );
    window.addEventListener( "appinstalled", function ()
    {
        deferredInstall = null;
        try { localStorage.setItem( cfg.keys.install, "installed" ); } catch ( _ ) {}
        var back = document.getElementById( "ayni-install" );
        if( back ) { if( back._finish ) back._finish(); else back.remove(); }
        Ayni.toast( "ok", t( "ayni.install.done" ) );
    } );

    function isStandalone()
    {
        return ( window.matchMedia && matchMedia( "(display-mode: standalone)" ).matches ) ||
               window.navigator.standalone === true;
    }
    // PUSH KEYS (the launcher, a Chat link). base64url (the server's VAPID key)
    // -> the bytes pushManager.subscribe() wants: it will not take the string.
    // (chat/guest-sw.js keeps its own copy: a worker cannot load this file.)
    function b64ToU8( s )
    {
        var pad = "=".repeat( ( 4 - s.length % 4 ) % 4 );
        var raw = atob( ( s + pad ).replace( /-/g, "+" ).replace( /_/g, "/" ) );
        var out = new Uint8Array( raw.length );
        for( var i = 0; i < raw.length; i++ ) out[ i ] = raw.charCodeAt( i );
        return out;
    }

    // Does this subscription still match the server's VAPID key? If the key
    // was regenerated, the push service rejects every message for it forever -
    // and nothing would ever say so. Can't tell -> true (don't nag the user).
    function samePushKey( sub, b64 )
    {
        try
        {
            var a = new Uint8Array( sub.options.applicationServerKey ), b = b64ToU8( b64 );
            if( a.length !== b.length ) return false;
            for( var i = 0; i < a.length; i++ ) if( a[ i ] !== b[ i ] ) return false;
            return true;
        }
        catch ( e ) { return true; }
    }
    // A browser embedded in another app (Instagram, Facebook, WhatsApp...): it can
    // never install anything, the user has to open the app in a real browser first.
    function isInAppBrowser()
    {
        return /FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Twitter/i.test( navigator.userAgent );
    }
    // Inside the the app Android app (a Trusted Web Activity): Chrome gives the
    // first page the app opens the referrer "android-app://the.app/";
    // the later pages of that tab find it in sessionStorage. device.html (only
    // the app opens it) sets the same flag.
    function inAndroidApp()
    {
        try { return !! cfg.apkKey && sessionStorage.getItem( cfg.apkKey ) === "1"; } catch ( _ ) { return false; }
    }

    // What can this device actually do right now?
    //   installed | prompt (Chromium) | ios (manual steps) | inapp |
    //   android (manual steps) | unsupported
    //
    // "android": Chrome on Android does not always fire beforeinstallprompt
    // (its own rules on when to offer it), yet its ⋮ menu always has "Instalar
    // app". Saying "this browser can't" there was simply wrong (2026-09-19).
    function installMode()
    {
        var v;
        try { v = localStorage.getItem( cfg.keys.install ); } catch ( _ ) {}
        if( isStandalone() || v === "installed" ) return "installed";
        if( deferredInstall )                     return "prompt";
        if( Ayni.isIOS() )                             return "ios";
        if( isInAppBrowser() )                    return "inapp";
        if( /android/i.test( navigator.userAgent ) ) return "android";
        return "unsupported";
    }

    function installSnoozed()
    {
        if( installLater ) return true;
        var v;
        try { v = localStorage.getItem( cfg.keys.install ); } catch ( _ ) { return false; }
        // "never" = "No mostrar más". Anything else (an old timestamp from the
        // days when "Ahora no" snoozed for a week) is ignored: it asks again.
        return v === "installed" || v === "never";
    }
    // "Ahora no": quiet for the rest of this visit, back on the next page load
    // (that is, on the next login). Deliberately NOT persisted anywhere.
    function snoozeInstall()
    {
        installLater = true;
    }
    // Permanent opt-out: the nudge never appears again on this device (the
    // launcher's "Instalar app" button still opens it by hand).
    function neverShowInstall()
    {
        try { localStorage.setItem( cfg.keys.install, "never" ); } catch ( _ ) {}
    }

    // One "icon + bold claim + sentence" row, same shape as the help dialog's list.
    function installRow( iconName, name, text )
    {
        var li = document.createElement( "li" );

        var ic = document.createElement( "span" );
        ic.className = "install-ico";
        ic.innerHTML = Ayni.icon( iconName );
        li.appendChild( ic );

        var box = document.createElement( "div" );
        box.className = "help-t";
        var b  = document.createElement( "b" );
        b.textContent = name;
        var sp = document.createElement( "span" );
        sp.textContent = text;
        box.appendChild( b );
        box.appendChild( sp );
        li.appendChild( box );
        return li;
    }

    // One numbered iOS step: the real glyph, then the sentence (its <b> part is
    // the label the user has to look for on screen).
    function installStep( iconName, before, strong, after )
    {
        var li = document.createElement( "li" );

        var ic = document.createElement( "span" );
        ic.className = "install-ico";
        ic.innerHTML = Ayni.icon( iconName );
        li.appendChild( ic );

        var sp = document.createElement( "span" );
        sp.appendChild( document.createTextNode( before ) );
        var b = document.createElement( "b" );
        b.textContent = strong;
        sp.appendChild( b );
        if( after ) sp.appendChild( document.createTextNode( after ) );
        li.appendChild( sp );
        return li;
    }

    function buildInstall( mode, manual )
    {
        var d     = Ayni.dialog( { id: "ayni-install", cls: "install-sheet" } );
        var back  = d.dialog;
        var sheet = d.body;

        function finish() { d.close(); }
        back._finish = finish;

        // The x in the title row, like every other dialog.
        var xb = d.header.appendChild( xButton( "btn install-close", finish ) );
        xb.setAttribute( "data-close", "" );

        var logo = document.createElement( "img" );
        logo.className = "install-logo";
        logo.src       = cfg.logo;
        logo.alt       = "";
        sheet.appendChild( logo );

        var h = document.createElement( "h2" );
        h.className   = "install-title";
        h.textContent = mode === "installed"
            ? t( "ayni.install.titleDone" )
            : t( "ayni.install.title" );
        sheet.appendChild( h );

        var lead = document.createElement( "p" );
        lead.className   = "text install-lead";
        lead.textContent = mode === "installed"
            ? t( "ayni.install.leadDone" )
            : t( "ayni.install.lead" );
        sheet.appendChild( lead );

        if( mode !== "installed" )
        {
            var ul = document.createElement( "ul" );
            ul.className = "help-list";
            ul.appendChild( installRow( "grid", t( "ayni.install.b1n" ),
                t( "ayni.install.b1" ) ) );
            ul.appendChild( installRow( "fullscreen", t( "ayni.install.b2n" ),
                t( "ayni.install.b2" ) ) );
            ul.appendChild( installRow( "bolt", t( "ayni.install.b3n" ),
                t( "ayni.install.b3" ) ) );
            sheet.appendChild( ul );
        }

        if( mode === "ios" )
        {
            var sub = document.createElement( "p" );
            sub.className   = "acct-h install-h";
            sub.textContent = t( "ayni.install.stepsH" );
            sheet.appendChild( sub );

            var ol = document.createElement( "ol" );
            ol.className = "install-steps";
            ol.appendChild( installStep( "ios-share", t( "ayni.install.s1a" ),
                                                    t( "ayni.install.s1b" ),
                                                    t( "ayni.install.s1c" ) ) );
            ol.appendChild( installStep( "add-home", t( "ayni.install.s2a" ),
                                                    t( "ayni.install.s2b" ),
                                                    t( "ayni.install.s2c" ) ) );
            ol.appendChild( installStep( "check",   t( "ayni.install.s3a" ),
                                                    t( "ayni.install.s3b" ),
                                                    t( "ayni.install.s3c" ) ) );
            sheet.appendChild( ol );
        }

        if( mode === "android" )
        {
            var subA = document.createElement( "p" );
            subA.className   = "acct-h install-h";
            subA.textContent = t( "ayni.install.stepsH" );
            sheet.appendChild( subA );

            var olA = document.createElement( "ol" );
            olA.className = "install-steps";
            olA.appendChild( installStep( "more", t( "ayni.install.a1a" ),
                                                      t( "ayni.install.a1b" ),
                                                      t( "ayni.install.a1c" ) ) );
            olA.appendChild( installStep( "add-home",  t( "ayni.install.a2a" ),
                                                      t( "ayni.install.a2b" ),
                                                      t( "ayni.install.a2c" ) ) );
            olA.appendChild( installStep( "check",    t( "ayni.install.a3a" ),
                                                      t( "ayni.install.a3b" ),
                                                      t( "ayni.install.a3c" ) ) );
            sheet.appendChild( olA );
        }

        if( mode === "inapp" || mode === "unsupported" )
        {
            var note = document.createElement( "p" );
            note.className   = "text install-note";
            note.textContent = mode === "inapp"
                ? t( "ayni.install.inapp" )
                : t( "ayni.install.unsupported" );
            sheet.appendChild( note );
        }

        var acts = document.createElement( "div" );
        acts.className = "install-actions";

        if( mode === "prompt" )
        {
            var go = document.createElement( "button" );
            go.type        = "button";
            go.className   = "install-btn primary";
            go.textContent = t( "ayni.install.cta" );
            go.addEventListener( "click", async function ()
            {
                var evt = deferredInstall;
                finish();
                if( ! evt ) return;
                deferredInstall = null;
                try
                {
                    evt.prompt();
                    await evt.userChoice;      // {outcome:'accepted'|'dismissed'}
                }
                catch ( _ ) {}
            } );
            acts.appendChild( go );
        }

        // Only the automatic nudge offers to go away: if they opened it themselves
        // there is nothing to snooze.
        if( ! manual && mode !== "installed" )
        {
            var later = document.createElement( "button" );
            later.type        = "button";
            later.className   = "install-btn";
            later.textContent = t( "ayni.notNow" );
            later.addEventListener( "click", function () { snoozeInstall(); finish(); } );
            acts.appendChild( later );

            var never = document.createElement( "button" );
            never.type        = "button";
            never.className   = "install-btn install-never";
            never.textContent = t( "ayni.install.dismiss" );
            never.addEventListener( "click", function () { neverShowInstall(); finish(); } );
            acts.appendChild( never );
        }

        if( acts.children.length ) sheet.appendChild( acts );

        d.show();
        return back;
    }

    // opts.manual: opened by the user (the launcher's "Instalar app" button) -
    // always shows, and always has something to say.
    function offerInstall( opts )
    {
        opts = opts || {};
        var manual = !! opts.manual;
        var mode   = installMode();

        if( manual ) installTries = 0;      // asked on purpose: it gets its own patience

        if( ! manual )
        {
            if( mode !== "prompt" && mode !== "ios" ) return;   // nothing real to offer
            if( installSnoozed() ) return;
        }

        if( document.getElementById( "ayni-install" ) ) return;   // already up

        // Never on top of another sheet (welcome card, mandatory password...).
        // installPending keeps the launcher's two calls (300 ms + 1500 ms) from
        // both waiting here and then opening two dialogs. While a sheet is
        // visibly open we wait as long as it takes (the user is reading it);
        // the give-up only guards the "held but nothing on screen" case.
        if( held() || document.querySelector( "dialog.panel[open]" ) )
        {
            if( installPending ) return;
            if( ! document.querySelector( "dialog.panel[open]" ) && ++installTries > 15 )
                return;                            // ~12 s held with nothing visible: next visit
            installPending = true;
            setTimeout( function ()
            {
                installPending = false;
                offerInstall( opts );
            }, 800 );
            return;
        }

        return buildInstall( mode, manual );
    }

    //------------------------------------------------------------------------//
    // "YOUR BROWSER" WARNING
    //
    // Two cases, each on every launch until "Don't show again":
    //  - big-tech: the Android app runs inside the user's default browser;
    //    when that is Google Chrome or Microsoft Edge, say so (Brave keeps
    //    the app working without them). Told apart by their UA-CH brands
    //    (Brave, Samsung Internet carry their own); no brands -> say nothing.
    //  - limited: Firefox Focus / Klar, DuckDuckGo - on any OS, in the app or
    //    not. They forget logins and storage, so much of the app falls short.
    //    Tor and private windows hide what they are: not detectable.
    //  - old: a browser older than the floor (Chrome/Edge 111, Safari 16.4,
    //    Firefox 113 - spring 2023), found by asking for what the code uses
    //    (tooOld), never by name. A warning, not a wall: a wrong guess must not
    //    lock anyone out. Its own "Don't show again", apart from the others.

    // What the apps use from spring 2023 on: color-mix() paints every colour
    // in app.css, structuredClone and Object.hasOwn are called bare.
    function tooOld()
    {
        try
        {
            return ! ( window.CSS && CSS.supports( "color", "color-mix(in srgb, red, blue)" ) &&
                       CSS.supports( "container-type", "inline-size" ) &&
                       typeof structuredClone === "function" && typeof Object.hasOwn === "function" );
        }
        catch ( _ ) { return true; }
    }

    function browserWarnCase()
    {
        var ua = navigator.userAgent;
        if( tooOld() )                    return { kind: "old" };
        if( /\bFocus\//.test( ua ) )      return { kind: "limited", name: "Firefox Focus" };
        if( /\bKlar\//.test( ua ) )       return { kind: "limited", name: "Firefox Klar" };
        if( /\bDuckDuckGo\//.test( ua ) ) return { kind: "limited", name: "DuckDuckGo" };
        if( ! inAndroidApp() ) return null;
        var b = ( navigator.userAgentData && navigator.userAgentData.brands ) || [];
        function has( n ) { return b.some( function ( x ) { return x.brand === n; } ); }
        if( has( "Microsoft Edge" ) ) return { kind: "bigtech", name: "Microsoft Edge", company: "Microsoft" };
        if( has( "Google Chrome" ) )  return { kind: "bigtech", name: "Google Chrome", company: "Google" };
        return null;
    }

    function warnChrome()
    {
        var wc = browserWarnCase();
        if( ! wc ) return;
        var key = cfg.keys.browser + ( wc.kind === "old" ? "-old" : "" );
        try { if( localStorage.getItem( key ) === "never" ) return; } catch ( _ ) {}
        if( document.getElementById( "ayni-browser-warn" ) ) return;
        if( held() || document.querySelector( "dialog.panel[open]" ) )
            return void setTimeout( warnChrome, 800 );     // never on top of another dialog

        var d     = Ayni.dialog( { id: "ayni-browser-warn", cls: "install-sheet" } );
        var sheet = d.body;
        function finish() { d.close(); }
        d.dialog._finish = finish;

        var xb = d.header.appendChild( xButton( "btn install-close", finish ) );
        xb.setAttribute( "data-close", "" );

        var h = document.createElement( "h2" );
        h.className   = "install-title";
        h.textContent = t( "ayni.chromeWarn.title" );
        sheet.appendChild( h );

        [ wc.kind === "old"     ? t( "ayni.chromeWarn.p1old" )
                                 : tf( inAndroidApp() ? "ayni.chromeWarn.p1" : "ayni.chromeWarn.p1using", { name: wc.name } ),
          wc.kind === "old"     ? t( "ayni.chromeWarn.p2old" )
        : wc.kind === "limited" ? t( "ayni.chromeWarn.p2limited" )
                                 : tf( "ayni.chromeWarn.p2", { company: wc.company } ),
          t( "ayni.chromeWarn.p3" ) ].forEach( function ( s )
        {
            var p = document.createElement( "p" );
            p.className   = "text";
            p.textContent = s;
            sheet.appendChild( p );
        } );

        var acts  = document.createElement( "div" );
        acts.className = "install-actions";
        var never = document.createElement( "button" );
        never.type        = "button";
        never.className   = "install-btn install-never";
        never.textContent = t( "ayni.install.dismiss" );
        never.addEventListener( "click", function ()
        {
            try { localStorage.setItem( key, "never" ); } catch ( _ ) {}
            finish();
        } );
        acts.appendChild( never );
        sheet.appendChild( acts );

        d.show();
    }

    //------------------------------------------------------------------------//
    // SERVICE-WORKER UPDATE CHECK
    //
    // The service worker controls the whole site, and its install
    // calls skipWaiting() - so a newer worker takes over on the NEXT launch.
    // The catch: the browser only checks for a newer sw.js on its own schedule,
    // which iOS stretches to ~a day. So after a deploy the phone can sit on the
    // old version until then. This nudges that check on every load and every
    // time the app comes back to the foreground (throttled), so a deploy is
    // picked up within one open instead of one day. No cost to this launch -
    // the check and any download happen in the background.

    var lastSwPing = 0;

    function pingSwUpdate()
    {
        if( ! ( "serviceWorker" in navigator ) ) return;

        var now = Date.now();
        if( now - lastSwPing < 20 * 60 * 1000 ) return;   // at most once / 20 min per page
        lastSwPing = now;

        try
        {
            navigator.serviceWorker.getRegistration().then( function ( reg )
            {
                if( reg ) reg.update().catch( function () {} );
            } ).catch( function () {} );
        }
        catch ( _ ) {}
    }

    //------------------------------------------------------------------------//
    // "NEW VERSION" BAR
    //
    // pingSwUpdate() above gets the NEW worker installed; sw.js then calls
    // skipWaiting() + clients.claim(), so it takes over this page's fetches at
    // once. But THIS document keeps running the HTML and the JS it was loaded
    // with - only a navigation picks the new build up, and tapping a PWA's icon
    // usually RESUMES the page rather than reloading it. Without this the phone
    // can sit on the old version until its storage is cleared by hand.
    //
    // clients.claim() fires "controllerchange" here; we offer a reload rather
    // than forcing one - the page may hold unsaved work, or be
    // mid-upload.

    var updateBar = null, sessionBar = null;

    function showUpdateBar()
    {
        // Deferred until there is a <body> to append to: the listener is armed
        // at load, so the worker can win the race against DOMContentLoaded.
        if( ! document.body )
            return document.addEventListener( "DOMContentLoaded", showUpdateBar );

        if( updateBar && document.body.contains( updateBar ) ) return;   // one bar per page

        // A 401 bar means a reload would only bounce to the sign-in page; the
        // new build arrives with that navigation anyway.
        if( sessionBar && document.body.contains( sessionBar ) ) return;

        var bar = document.createElement( "div" );
        bar.className = "session-bar";                  // same one bar style (theme.css)
        bar.id        = "ayni-update-bar";
        bar.setAttribute( "role", "status" );

        var msg = document.createElement( "span" );
        msg.textContent = t( "ayni.update.available" );

        var btn = document.createElement( "button" );
        btn.type        = "button";
        btn.className   = "session-bar-btn";
        btn.textContent = t( "ayni.update.reload" );
        btn.addEventListener( "click", function ()
        {
            // A navigation: htmlStrategy answers it from the NEW worker's cache.
            window.location.reload();
        } );

        bar.appendChild( msg );
        bar.appendChild( btn );
        document.body.appendChild( bar );
        updateBar = bar;
    }

    // Armed at load, NOT in uiInit(): a warm update is mostly cache-to-cache and
    // can activate before DOMContentLoaded fires on these big inline-HTML pages.
    ( function watchForNewWorker()
    {
        if( ! ( "serviceWorker" in navigator ) ) return;

        // No controller yet = this is the FIRST install. clients.claim() fires
        // controllerchange for that too, and there is nothing new to reload to.
        var hadController = !! navigator.serviceWorker.controller;

        try
        {
            navigator.serviceWorker.addEventListener( "controllerchange", function ()
            {
                if( ! hadController ) return;

                // The planner embeds the other apps in iframes; each one would
                // raise its own bar, and reloading a frame alone fixes nothing.
                // The top-level page gets this same event and handles it.
                if( Ayni.frame.embedded ) return;

                showUpdateBar();
            } );
        }
        catch ( _ ) {}
    } )();

    function sessionExpired()
    {
        if( ! document.body ) return;
        if( sessionBar && document.body.contains( sessionBar ) ) return;   // one bar per page, however many 401s

        // Both bars are fixed to the top at z-index 400; a 401 outranks a
        // pending update (the reload would only bounce to the sign-in page).
        if( updateBar ) { updateBar.remove(); updateBar = null; }

        var bar = document.createElement( "div" );
        bar.className = "session-bar";
        bar.id        = "ayni-session-bar";
        bar.setAttribute( "role", "alert" );

        var msg = document.createElement( "span" );
        msg.textContent = t( "ayni.session.expired" );

        var btn = document.createElement( "button" );
        btn.type        = "button";
        btn.className   = "session-bar-btn";
        btn.textContent = t( "ayni.session.login" );
        btn.addEventListener( "click", function () { cfg.signIn(); } );

        bar.appendChild( msg );
        bar.appendChild( btn );
        document.body.appendChild( bar );
        sessionBar = bar;
    }


    // LOW BATTERY (2026-10-04) - where the browser tells the battery level
    // (navigator.getBattery: Chrome, Edge, Android; not Firefox, Safari or the
    // iPhone), a dialog in the middle of the screen, in front of all, says it
    // is low: 15% or less and not charging. Whatever the desktop's "Show
    // battery" switch says. The top page only, the pages quotaPage() allows
    // (the desktop, or the app on a phone; never a desktop window's frame).
    // Once per drop: keys.batt is set when shown and cleared when
    // charging starts or the level climbs back, so going from app to app on
    // a phone does not ask again. Plugging in closes it. Reads only.

    var BATT_LOW = 0.15;
    var battDlg = null, battWarned = false;

    function battFlag( on )                 // no `on`: shown already in this drop?
    {
        if( on === undefined )
        {
            try { return battWarned || !! localStorage.getItem( cfg.keys.batt ); } catch ( _ ) { return battWarned; }
        }
        battWarned = on;
        try { if( on ) localStorage.setItem( cfg.keys.batt, "1" ); else localStorage.removeItem( cfg.keys.batt ); } catch ( _ ) {}
    }

    function battShow( level )
    {
        var d = Ayni.dialog( { title: t( "ayni.battLowTitle" ) } );   // a modal dialog: in front of everything
        var p = document.createElement( "p" );
        p.className = "text";
        p.textContent = tf( "ayni.battLowBody", { n: Math.round( level * 100 ) } );
        d.body.appendChild( p );
        var ok = Ayni.dialogButton( "close", t( "ayni.close" ) );
        d.place( [ ok ] );                                     // a lone × goes in the title row
        ok.addEventListener( "click", function () { d.close(); } );
        d.show();
        return d;
    }

    function battWatch()
    {
        if( ! cfg.page() || ! navigator.getBattery ) return;
        navigator.getBattery().then( function ( b )
        {
            function check()
            {
                if( b.charging || b.level > BATT_LOW )
                {
                    battFlag( false );
                    if( battDlg ) { battDlg.close(); battDlg = null; }
                    return;
                }
                if( battFlag() ) return;
                battFlag( true );
                Ayni.i18n.ready.then( function () { battDlg = battShow( b.level ); } );
            }
            b.addEventListener( "chargingchange", check );
            b.addEventListener( "levelchange", check );
            check();
        }, function () {} );
    }

    Ayni.pwa = {
        config: function ( o )
        {
            if( o.keys ) o.keys = Object.assign( {}, cfg.keys, o.keys );
            Object.assign( cfg, o );
            try { if( cfg.apkRef && cfg.apkRef.test( document.referrer ) ) sessionStorage.setItem( cfg.apkKey, "1" ); } catch ( _ ) {}
        },
        offerInstall: offerInstall, installMode: installMode, isStandalone: isStandalone, warnBrowser: warnChrome,
        b64ToU8: b64ToU8, samePushKey: samePushKey, inAndroidApp: inAndroidApp, sessionExpired: sessionExpired,
        pingUpdate: pingSwUpdate, watchBattery: battWatch, signIn: function () { return cfg.signIn(); }
    };
} )();
