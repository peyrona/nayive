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
    // up to 1 min) and "online" -> maybeRefresh( true, "online" ); with opts.watch
    // (a file path), a re-read as soon as that file changes on the server
    // ("push", see watchFile below).
    //
    // `guard( force, why )` returns true while a re-read must NOT happen (a sheet is
    // open, text is being typed); the default is "any dialog is open".
    // `why` is "visible" / "focus" / "plug" / "retry" / "online" / "push", so an app can tell a DELIBERATE refresh
    // from an automatic one - Trips lets the plug re-read from any screen but keeps
    // the automatic paths on the trip list, where re-rendering costs nothing.
    function wireRefresh( opts )
    {
        opts = opts || {};
        var lastRefresh = 0;
        var throttle    = opts.throttleMs || 20000;
        var guard       = opts.guard || function () { return !! document.querySelector( "dialog.panel[open]" ); };

        // True when the read ran; false when the throttle or the guard said no.
        async function maybeRefresh( force, why )
        {
            if( ! force && Date.now() - lastRefresh < throttle ) return false;
            if( guard( force, why || "plug" ) ) return false;
            lastRefresh = Date.now();          // stamped only when a read really happens
            await opts.read( force );
            return true;
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

        // While a button is held, no push read either (the click would be lost):
        // watchFile tries again 2 s later.
        if( opts.watch ) watchFile( opts.watch, opts.store, function ( force, why )
        {
            return held ? Promise.resolve( false ) : maybeRefresh( force, why );
        } );

        var dot = document.getElementById( opts.indicatorId || "syncIndicator" );
        if( dot && dot.tagName === "BUTTON" ) dot.addEventListener( "click", refreshNow );

        return { maybeRefresh: maybeRefresh, refreshNow: refreshNow };
    }

    //------------------------------------------------------------------------//
    // LIVE RE-READ (2026-11-17)  -  wireRefresh( { ..., watch: "data/calendar.ics" } )
    //
    // One request stays open on <api>watch?file=&etag= and the server answers
    // as soon as the file's version moves (Nayive: server/go/api_watch.go). The
    // page then re-reads as on a focus: maybeRefresh( true, "push" ). So an
    // event added on the phone shows in a PC window nobody touches.
    //   - The first answer only brings the version: one read then, for a change
    //     between the page's own load and that answer.
    //   - The guard said no (a sheet open, an Undo held): the version stays
    //     what the screen shows and the read is tried again every 2 s until it
    //     runs. Asking the server again at once would answer at once, for ever.
    //   - Hidden: no wait open; the version is kept, so a change made meanwhile
    //     answers at once on return.
    //   - Any failure (offline, signed out, 429, 5xx), or a wait answered at
    //     once with the version it was given: wait 1 s, doubling up to 1 min.
    //     A sign-in in another tab then picks it up again.
    //   - The read itself failed (the store says "error" or "needs-auth"):
    //     read again by itself, 2 s doubling up to 1 min, until one works.
    //   - Plain HTTP (a dev box) is HTTP/1.1: 6 sockets per server for ALL
    //     tabs and frames, so five watching windows and Chat would hold every
    //     one and the rest would wait. There no wait is held: the page asks
    //     every 10 s and compares the version itself. Over HTTPS (HTTP/2) the
    //     waits share one connection.
    //   - A version the page already shows - its own save coming back, its
    //     first look after its own load - is not read again (store.heldTag).
    function watchFile( file, store, maybeRefresh )
    {
        var API = ( window.AyniNames || {} ).api || "/api/";
        var url = API + "watch?file=" + encodeURIComponent( file );
        var tag = null, readFirst = true, delay = 1000;
        var busy = false, more = false, again = 0, failWait = 2000;
        var nav  = performance.getEntriesByType ? performance.getEntriesByType( "navigation" )[ 0 ] : null;
        var hold = location.protocol === "https:" && ! ( nav && nav.nextHopProtocol === "http/1.1" );
        var pause = function ( ms ) { return new Promise( function ( ok ) { setTimeout( ok, ms ); } ); };

        // The page's model came from version `t` already.
        function onScreen( t ) { return !! ( t && store && store.heldTag && store.heldTag( file ) === t ); }

        function changed()
        {
            if( again ) return;                 // a retry is due: it reads the newest anyway
            if( busy ) { more = true; return; }
            reread();
        }

        async function reread()
        {
            again = 0;
            if( onScreen( tag ) ) { more = false; return; }   // a read meanwhile showed it
            busy  = true;
            var ran = true;
            try { ran = await maybeRefresh( true, "push" ); }
            catch ( e ) {}                      // a read that throws: wireRefresh's own retry takes over
            busy = false;
            // The read ran but failed (a server error, signed out): store.read()
            // then answers from the cache without throwing, and the next wait
            // holds on the NEW version - nothing would read it again until a
            // focus or a click. So again by itself: 2 s, doubling up to 1 min.
            // ("offline" has wireRefresh's own retry.)
            var failed = ran && store && ( store.state === "error" || store.state === "needs-auth" );
            if( ! ran )        { more = false; again = setTimeout( reread, 2000 ); }
            else if( failed )  { more = false; again = setTimeout( reread, failWait ); failWait = Math.min( failWait * 2, 60000 ); }
            else
            {
                failWait = 2000;
                if( more ) { more = false; reread(); }
            }
        }

        function shown()
        {
            return new Promise( function ( ok )
            {
                document.addEventListener( "visibilitychange", function on()
                {
                    if( document.hidden ) return;
                    document.removeEventListener( "visibilitychange", on );
                    ok();
                } );
            } );
        }

        ( async function loop()
        {
            for( ;; )
            {
                // Hidden: no wait open. The tag is kept: a change made meanwhile
                // answers at once on return (the "visible" read may have been
                // refused by the guard).
                if( document.hidden ) await shown();
                var r = null, got = null, sent = tag === null || ! hold ? null : tag, asked = Date.now();
                try
                {
                    r = await fetch( url + ( sent === null ? "" : "&etag=" + encodeURIComponent( sent ) ),
                                     { cache: "no-store", credentials: "same-origin" } );
                    if( r.ok ) got = ( await r.json() ).etag;
                }
                catch ( e ) {}
                // A wait that came back at once with the very version it was
                // given never waited (a server shutting down, a proxy that does
                // not hold): as a failure, or the loop asks without a pause for
                // ever. A wait that held (up to 25 s) and found nothing new is
                // normal: asked again at once.
                if( typeof got !== "string" || ( sent !== null && got === sent && Date.now() - asked < 1000 ) )
                {
                    await pause( delay );
                    delay = Math.min( delay * 2, 60000 );
                    continue;
                }
                delay = 1000;
                var was = tag;
                tag = got;                      // first: reread() checks the newest
                if( ( was === null ? readFirst : got !== was ) && ! onScreen( got ) ) changed();
                readFirst = false;
                if( ! hold ) await pause( 10000 );
            }
        } )();
    }

    window.AyniBoot = { boot: bootWithStore, wireRefresh: wireRefresh };
} )();
