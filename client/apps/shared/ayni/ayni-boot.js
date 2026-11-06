/* Ayni library 0.2.0, boot: the access probe an app with a store starts with, and the auto re-read ("the plug is the refresh button").
   AyniBoot.boot(store, load, options), AyniBoot.wireRefresh({ store, read, guard }). Plain JavaScript. Optional: load it after ayni-net.js. */
( function ()
{
    "use strict";

    //------------------------------------------------------------------------//
    // BOOT  -  the access probe every store-backed app starts with.
    //
    //   AyniBoot.boot( store, async function ( who ) { ...load + render... } );
    //
    // Probes /api/whoami. On success `start( who )` runs with { user, role } -
    // unless the probe brought back an account language this device does not
    // have yet, in which case it is stored and the page reloads instead.
    // On failure the page bounces to the sign-in screen ONLY when it is really
    // online and the store holds nothing - a genuine "you must authenticate";
    // otherwise it opens on the local cache (start( null )) and the store syncs
    // once the connection is back. #app (or opts.appId) is shown before start.
    //
    // An app can open without reading or writing a single file - Calc on a blank
    // sheet, Write on a new document. store.onState() only fires on real traffic,
    // so the header plug would still be on its "no state yet" resting class: RED,
    // with nothing whatever wrong. store.resting() recomputes the true resting
    // state from the outbox (synced / pending / offline) and emits it, so those
    // apps open green like every other one. Opts.resting: false turns it off.
    async function bootWithStore( store, start, opts )
    {
        opts = opts || {};
        var who = null;
        try { who = await AyniNet.probeAccess(); }
        catch ( _ )
        {
            var cached = false;
            try { cached = store ? await store.hasAnyCache() : false; } catch ( e ) {}
            if( navigator.onLine && ! cached ) { AyniNet.loginRedirect(); return null; }
        }
        // The language belongs to the ACCOUNT, and it outranks this device's:
        // pick Spanish on the phone and this PC follows on its next boot. The
        // probe above already carries it, so this costs no extra request. When
        // adopt() takes it, a reload is on its way - stop here rather than
        // render a frame that gets thrown away (and flashes the old language).
        if( who && window.Ayni && Ayni.i18n.setLang( who.lang ) )
            return null;
        var app = document.getElementById( opts.appId || "app" );
        if( app ) app.style.display = "";
        await start( who );

        var dot = document.getElementById( opts.indicatorId || "syncIndicator" );

        if( store && store.resting && store.state === "init" && opts.resting !== false
            && dot && ! dot.dataset.syncState )
            try { await store.resting(); } catch ( e ) {}

        return who;
    }

    //------------------------------------------------------------------------//
    // AUTO RE-READ  -  "the plug is the refresh button" (see docs/shared-modules.md)
    //
    //   var rf = AyniBoot.wireRefresh( { store: store, read: loadTasks, guard: isEditing } );
    //   rf.refreshNow()          the plug's click: flush the outbox, then re-read
    //   rf.maybeRefresh( force ) the single re-read path with this app's guards
    //
    // Installs: visibilitychange -> maybeRefresh( true, "visible" ) [then
    // opts.onVisible]; window focus -> maybeRefresh( false, "focus" ), throttled to
    // once per opts.throttleMs (20 s) - a window that never leaves the screen (a
    // second monitor, a Planner pane) never fires visibilitychange; the
    // #syncIndicator click -> refreshNow; window.ayniRefresh = refreshNow for
    // Planner's single plug; while the store is "offline", a retry ("retry", 5 s
    // up to 1 min) and "online" -> maybeRefresh( true, "online" ).
    //
    // `guard( force, why )` returns true while a re-read must NOT happen (a sheet is
    // open, text is being typed); the default is "any dialog is open".
    // `why` is "visible" / "focus" / "plug" / "retry" / "online", so an app can tell a DELIBERATE refresh
    // from an automatic one - Trips lets the plug re-read from any screen but keeps
    // the automatic paths on the trip list, where re-rendering costs nothing.
    function wireRefresh( opts )
    {
        opts = opts || {};
        var lastRefresh = 0;
        var throttle    = opts.throttleMs || 20000;
        var guard       = opts.guard || function () { return !! document.querySelector( "dialog.panel[open]" ); };

        async function maybeRefresh( force, why )
        {
            if( ! force && Date.now() - lastRefresh < throttle ) return;
            if( guard( force, why || "plug" ) ) return;
            lastRefresh = Date.now();          // stamped only when a read really happens
            await opts.read( force );
        }

        async function refreshNow()
        {
            if( opts.store ) opts.store.flush();
            await maybeRefresh( true, "plug" );
        }

        window.ayniRefresh = refreshNow;

        document.addEventListener( "visibilitychange", async function ()
        {
            if( document.visibilityState !== "visible" ) return;
            await maybeRefresh( true, "visible" );
            if( opts.onVisible ) opts.onVisible();
        } );
        // A click on a window without focus fires "focus" between its press and its
        // release. The re-read then redraws the list under the pointer, the release
        // lands on a NEW button and the click is lost (the second click works). So
        // while a button is held the re-read waits until the click is done.
        var held = false, waiting = false;

        window.addEventListener( "pointerdown",   function () { held = true;  }, true );
        window.addEventListener( "pointercancel", function () { held = false; }, true );
        window.addEventListener( "pointerup",     function ()
        {
            held = false;
            if( ! waiting ) return;
            waiting = false;
            setTimeout( function () { maybeRefresh( false, "focus" ); }, 0 );   // after the click
        }, true );
        window.addEventListener( "focus", function ()
        {
            if( held ) waiting = true;
            else       maybeRefresh( false, "focus" );
        } );

        // RETRY (2026-10-03) - a read that failed for want of the network leaves
        // the plug "offline" (gold), and nothing above tries again until a focus,
        // a tab switch or a tap. The PWA starts at sign-in, often before the
        // network is up: a window nobody clicks (a Planner pane, a desktop
        // window behind) stayed gold for hours. So while the store says
        // "offline" the read is tried again by itself: 5 s, doubling up to
        // 1 min. One at a time; a read's own "loading" does not reset the wait.
        // "online": the store only sends what is queued and turns green, so the
        // data on screen is re-read too.
        if( opts.store && opts.store.onState )
        {
            var retryT = 0, retryMs = 5000, retrying = false;

            var armRetry = function ()
            {
                if( retryT || retrying ) return;
                retryT = setTimeout( async function ()
                {
                    retryT   = 0;
                    retrying = true;
                    try { if( navigator.onLine ) await maybeRefresh( true, "retry" ); }
                    catch ( e ) {}
                    retrying = false;
                    retryMs  = Math.min( retryMs * 2, 60000 );
                    if( opts.store.state === "offline" ) armRetry();   // still out, or the guard said no
                }, retryMs );
            };

            var onStore = function ( s )
            {
                if( s === "offline" ) armRetry();
                else if( s !== "loading" && s !== "saving" )
                {
                    clearTimeout( retryT );
                    retryT  = 0;
                    retryMs = 5000;
                }
            };

            opts.store.onState( onStore );
            onStore( opts.store.state );       // a read that failed before this ran
            window.addEventListener( "online", function () { maybeRefresh( true, "online" ); } );
        }

        var dot = document.getElementById( opts.indicatorId || "syncIndicator" );
        if( dot && dot.tagName === "BUTTON" ) dot.addEventListener( "click", refreshNow );

        return { maybeRefresh: maybeRefresh, refreshNow: refreshNow };
    }

    window.AyniBoot = { boot: bootWithStore, wireRefresh: wireRefresh };
} )();
