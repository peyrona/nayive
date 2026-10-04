/*
 * locker.js - the screen locker (2026-09-28).
 *
 * After N idle minutes the page is covered by an animation (a "locker") and
 * ONLY the account password takes it away (POST /api/unlock). Unlike a screen
 * saver, a key or a click does not end it: it only shows the password box
 * (a click on a locker's link opens that page in a new tab instead).
 *
 * Classic script, one global `NayiveLock`. Load it in <head>, WITHOUT defer,
 * right after theme.js, so a page that opens while locked is hidden from its
 * first paint (html.nv-locked, app.css):
 *
 *     <script src="../shared/locker.js"></script>
 *
 * STATE - all localStorage, so every tab and every desktop window share it:
 *   nayive-locker     {v, id, min, text}  the choice, PER DEVICE (desktop's
 *                     "⋮" menu). id "" = plain black; min 0 = never locks,
 *                     else 1-999;
 *                     text = the line the bouncing clock shows under the time.
 *   nayive-lock       "1" while locked: a reload or a new tab stays locked.
 *   nayive-lock-seen  ms of the last activity in ANY tab or window.
 *
 * Only desktop mode locks (see isDesk); phones never do.
 * Only the top window draws the locker; a page inside one of the desktop's
 * windows (an <iframe>) only reports its activity. A playing <video> (a
 * movie, a video call) counts as activity. Nothing happens while signed out.
 *
 * A LOCKER is shared/lockers/<id>.js, loaded the first time it is shown:
 *
 *     NayiveLock.define( "id", function ( host, opts ) { ...; return stop; } );
 *
 * host = an empty full-screen <div> on black; opts = the saved settings
 * (opts.text). stop() must end everything it started (timers, frames,
 * listeners). A locker that fails to load leaves the plain black screen.
 *
 * Honest limit: the lock lives in the browser; the session stays valid. It
 * covers the open pages, but an address typed by hand (an /api/ URL, a
 * download link) still answers while locked.
 */
( function ()
{
    "use strict";

    var SET_KEY  = "nayive-locker";
    var LOCK_KEY = "nayive-lock";
    var SEEN_KEY = "nayive-lock-seen";
    var LOCKERS  = [ "culture", "science", "clock", "matrix", "life" ];   // name = i18n "scrlock.<id>"
    var MIN_DEFAULT = 15;
    var TICK_MS  = 5000;       // how often the idle time is checked
    var WRITE_MS = 5000;       // activity is written at most this often
    var CARD_MS  = 30000;      // the password box hides again after this idle

    var html = document.documentElement;
    var base = ( ( document.currentScript && document.currentScript.src ) || "" ).replace( /[^\/]*$/, "" );

    var isTop = true;          // false = inside a Nayive page's <iframe>
    try { isTop = window.top === window || ! window.top.NayiveLock; } catch ( e ) {}

    // DESKTOP MODE ONLY (2026-09-28): only the desktop page (desktop/) counts the
    // idle time and locks. A phone never runs it, so a phone never locks; other
    // pages only follow a lock the desktop already set.
    var isDesk = isTop && /\/desktop\/(index\.html)?$/.test( location.pathname );

    function get( k )    { try { return localStorage.getItem( k ); } catch ( e ) { return null; } }
    function put( k, v ) { try { if( v == null ) localStorage.removeItem( k ); else localStorage.setItem( k, v ); } catch ( e ) {} }
    function t( k )      { return window.NayiveI18n ? NayiveI18n.t( k ) : k; }

    //------------------------------------------------------------------------//
    // SETTINGS

    // v2 (2026-09-30): id "" is the plain BLACK screen, and min 0 turns the
    // locking off. Before, id "" meant "off": such a setting (no v) - and no
    // setting at all - reads as min 0, so nobody starts locking unasked.
    function settings()
    {
        var s = null;
        try { s = JSON.parse( get( SET_KEY ) || "null" ); } catch ( e ) {}
        s = s || {};
        var id  = LOCKERS.indexOf( s.id ) >= 0 ? s.id : "";
        var min = Math.floor( Number( s.min ) );
        if( ! s.v && ! id ) min = 0;
        return { v:    2,
                 id:   id,
                 min:  min >= 0 ? Math.min( min, 999 ) : MIN_DEFAULT,
                 text: typeof s.text === "string" ? s.text : "" };
    }

    // Merges `part` into the saved settings; returns the clean result.
    // A locker this copy of the file does not know (a newer build's, chosen in
    // another tab or kept by an older cached copy) is KEPT, never turned into
    // black: with it, saving the minutes wiped the choice.
    function save( part )
    {
        var raw = null;
        try { raw = JSON.parse( get( SET_KEY ) || "null" ); } catch ( e ) {}
        var s = settings();
        if( raw && typeof raw.id === "string" && raw.id && LOCKERS.indexOf( raw.id ) < 0 &&
            ! Object.prototype.hasOwnProperty.call( part, "id" ) )
        {
            for( var j in part ) if( Object.prototype.hasOwnProperty.call( part, j ) ) s[ j ] = part[ j ];
            s.id = raw.id;
            put( SET_KEY, JSON.stringify( s ) );
            poke( true );
            return settings();
        }
        for( var k in part ) if( Object.prototype.hasOwnProperty.call( part, k ) ) s[ k ] = part[ k ];
        put( SET_KEY, JSON.stringify( s ) );
        s = settings();
        put( SET_KEY, JSON.stringify( s ) );
        poke( true );          // the new timeout counts from now
        return s;
    }

    // The who-cookie (server: store_owner.go) is readable by the page and
    // lives exactly as long as the session cookie.
    function signedIn() { return /(?:^|;\s*)nayive_who=[^;]/.test( document.cookie ); }
    function locked()   { return get( LOCK_KEY ) === "1"; }

    //------------------------------------------------------------------------//
    // IDLE TIME

    var lastWrite = 0;

    function poke( force )
    {
        var now = Date.now();
        if( ! force && now - lastWrite < WRITE_MS ) return;
        lastWrite = now;
        put( SEEN_KEY, String( now ) );
    }

    function videoPlaying()
    {
        var v = document.getElementsByTagName( "video" );
        for( var i = 0; i < v.length; i++ )
            if( ! v[ i ].paused && ! v[ i ].ended && v[ i ].readyState > 2 ) return true;
        return false;
    }

    function tick()
    {
        var s = settings();
        if( ! s.min || ! signedIn() || locked() ) return;
        if( videoPlaying() ) { poke(); return; }
        if( isDesk && Date.now() - ( Number( get( SEEN_KEY ) ) || 0 ) >= s.min * 60000 ) lock();
    }

    [ "pointerdown", "pointermove", "keydown", "wheel", "touchstart" ].forEach( function ( ev )
    {
        window.addEventListener( ev, function () { if( ! locked() ) poke(); }, { capture: true, passive: true } );
    } );

    //------------------------------------------------------------------------//
    // LOCK / UNLOCK

    function lock()
    {
        if( ! isDesk || ! signedIn() ) return;
        put( LOCK_KEY, "1" );
        show();
    }

    // Right password (or no session any more): every tab and window opens.
    function release()
    {
        put( LOCK_KEY, null );
        poke( true );
        hide();
    }

    // The other tabs and windows follow at once.
    window.addEventListener( "storage", function ( e )
    {
        if( e.key === LOCK_KEY || e.key === null ) { if( locked() ) show(); else hide(); }
    } );

    //------------------------------------------------------------------------//
    // THE SCREEN (top window only)

    var dlg = null, host = null, card = null, inp = null, btn = null, msg = null;
    var stopFn = null, cardTimer = 0, busy = false, waitingDom = false;
    var defs = {};

    function show()
    {
        html.classList.add( "nv-locked" );
        if( ! isTop )
        {
            try { if( document.activeElement ) document.activeElement.blur(); } catch ( e ) {}
            return;
        }
        if( ! document.body )
        {
            if( ! waitingDom )
            {
                waitingDom = true;
                document.addEventListener( "DOMContentLoaded", function () { waitingDom = false; if( locked() ) show(); } );
            }
            return;
        }
        if( dlg ) { if( ! dlg.open ) dlg.showModal(); return; }
        build();
    }

    function hide()
    {
        html.classList.remove( "nv-locked" );
        if( ! dlg ) return;
        stopLocker();
        clearTimeout( cardTimer );
        var d = dlg;
        dlg = host = card = inp = btn = msg = null;
        busy = false;
        if( d.open ) d.close();
        d.remove();
    }

    // A modal <dialog>: it sits above everything (other dialogs, the desktop's
    // windows) and makes the rest of the page inert, iframes included.
    function build()
    {
        dlg = document.createElement( "dialog" );
        dlg.className = "lock-dlg";
        dlg.tabIndex = -1;                       // hideCard gives it the focus back

        host = document.createElement( "div" );
        host.className = "lock-host";

        card = document.createElement( "div" );
        card.className = "sheet lock-card";
        card.hidden = true;

        inp = document.createElement( "input" );
        inp.type = "password";
        // Not "current-password": the browser must not fill it in for whoever
        // is at the keyboard.
        inp.autocomplete = "off";
        inp.spellcheck = false;
        inp.setAttribute( "autocapitalize", "none" );

        btn = document.createElement( "button" );
        btn.type = "button";
        btn.setAttribute( "data-act", "primary" );

        msg = document.createElement( "p" );
        msg.className = "lock-msg";
        msg.hidden = true;

        card.appendChild( inp );
        card.appendChild( btn );
        card.appendChild( msg );
        dlg.appendChild( host );
        dlg.appendChild( card );
        document.body.appendChild( dlg );
        if( window.NayiveUI && NayiveUI.applySheetButtons ) NayiveUI.applySheetButtons( card );
        label();
        // A page that opens locked builds this before its dictionary is in.
        if( window.NayiveI18n && NayiveI18n.ready ) NayiveI18n.ready.then( label, function () {} );

        btn.addEventListener( "click", tryUnlock );
        inp.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); tryUnlock(); } } );
        inp.addEventListener( "input", showCard );

        // Esc must not close it. Chrome lets a second Esc close a modal
        // dialog anyway, so a close while still locked opens it again.
        dlg.addEventListener( "cancel", function ( e ) { e.preventDefault(); } );
        dlg.addEventListener( "close",  function () { if( dlg && locked() ) dlg.showModal(); } );

        // Any key or press shows the password box. The key is not lost: the
        // focus moves before it is typed, so it lands in the box. Esc too
        // opens it (2026-09-30, his call); while it shows, Esc or a press
        // outside it hides it again; the locker runs on.
        dlg.addEventListener( "keydown", function ( e )
        {
            if( e.key !== "Escape" ) { showCard(); return; }
            e.preventDefault();
            if( card.hidden ) showCard(); else hideCard();
        } );
        dlg.addEventListener( "pointerdown", function ( e )
        {
            // A locker's link (a news story, a painting...) opens in a new
            // tab of the browser; the lock stays, the password box does not come up.
            if( e.target.closest && e.target.closest( ".lock-host a[href]" ) ) return;
            if( card.hidden || card.contains( e.target ) ) showCard();
            else { e.preventDefault(); hideCard(); }
        } );
        // The press's own default action then focuses the dialog (tabIndex -1)
        // and takes the caret out of the password box: only a press on the box
        // itself may move it (a button still gets its click).
        dlg.addEventListener( "mousedown", function ( e ) { if( e.target !== inp ) e.preventDefault(); } );

        dlg.showModal();
        startLocker();
    }

    function label()
    {
        if( ! card ) return;
        inp.placeholder = t( "scrlock.password" );
        inp.setAttribute( "aria-label", t( "scrlock.password" ) );
        btn.title = t( "scrlock.unlock" );
        btn.setAttribute( "aria-label", t( "scrlock.unlock" ) );
    }

    function showCard()
    {
        if( ! card ) return;
        if( card.hidden ) { card.hidden = false; msg.hidden = true; }
        if( document.activeElement !== inp && ! inp.disabled ) inp.focus();
        clearTimeout( cardTimer );
        cardTimer = setTimeout( function () { if( ! busy ) hideCard(); }, CARD_MS );
    }

    function hideCard()
    {
        if( ! card || busy ) return;
        clearTimeout( cardTimer );
        card.hidden = true; inp.value = "";
        dlg.focus();                             // not inp.blur(): the keys must still reach dlg
    }

    function say( key )
    {
        msg.textContent = t( key );
        msg.hidden = false;
    }

    async function tryUnlock()
    {
        // An empty box is sent too: an account with no password yet opens
        // with "", and the server says "wrong" to everyone else.
        if( busy || ! inp ) return;
        busy = true; inp.disabled = true; btn.disabled = true;

        var status = 0;
        try
        {
            var r = await fetch( "/api/unlock",
            {
                method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify( { password: inp.value } )
            } );
            status = r.status;
        }
        catch ( e ) {}

        if( status === 200 ) { release(); return; }
        if( status === 401 )                     // signed out meanwhile: the
        {                                        // login screen asks anyway
            release();
            location.href = new URL( "../login.html", base ).href;
            return;
        }
        if( ! inp ) return;                      // unlocked from another tab
        busy = false; inp.disabled = false; btn.disabled = false;
        inp.value = "";
        say( status === 403 ? "scrlock.wrong" : "scrlock.offline" );
        inp.focus();
        showCard();
    }

    //------------------------------------------------------------------------//
    // THE LOCKERS

    function startLocker()
    {
        var s  = settings();
        var id = s.id;
        var at = host;
        if( ! id ) return;                       // plain black
        if( defs[ id ] ) { run( id, at, s ); return; }

        var sc = document.createElement( "script" );
        sc.src = base + "lockers/" + id + ".js";
        sc.onload = function () { if( host === at && defs[ id ] ) run( id, at, s ); };
        document.head.appendChild( sc );
    }

    function run( id, at, s )
    {
        try { stopFn = defs[ id ]( at, s ) || null; }
        catch ( e ) { stopFn = null; }
    }

    function stopLocker()
    {
        var f = stopFn;
        stopFn = null;
        if( f ) try { f(); } catch ( e ) {}
    }

    //------------------------------------------------------------------------//
    // START

    // Whose page this is, as it LOADED (the "nayive_who" cookie; data-safety
    // L5): the lockers' scripts load later, maybe after another account
    // signed in on this browser, and name this owner on their saves.
    var WHO = "";
    try { var wm = document.cookie.match( /(?:^|;\s*)nayive_who=([^;]*)/ ); WHO = wm ? wm[ 1 ] : ""; } catch ( e ) {}

    window.NayiveLock = {
        LOCKERS:  LOCKERS,
        who:      WHO,
        settings: settings,
        save:     save,
        lock:     lock,
        define:   function ( id, fn ) { defs[ id ] = fn; }
    };

    if( locked() && ! signedIn() ) put( LOCK_KEY, null );   // the login asks anyway
    if( locked() ) show();
    else           poke( true );                             // opening a page is activity
    setInterval( tick, TICK_MS );
} )();
