/* Ayni library 0.2.0, screen locker: after N idle minutes the page is covered by an animation, and only the password takes it away. A key or
   a click only shows the password box. Plain JavaScript, no build step. Optional: load it in <head>, WITHOUT defer, so a page that opens
   while locked is hidden from its first paint, after setting window.AyniLockerConfig:
     { keys: { set, lock, seen }, lockers: [ids], isDesk(), signedIn(), unlock(password) -> status (200 ok, 401 signed out, 403 wrong),
       signIn(), lockerUrl(id, base), who }
   The choice, the lock and the last activity live in localStorage, so every tab and frame share them. Only the top window draws the locker; a
   page in a frame only reports its activity. A playing <video> counts as activity. A locker is lockers/<id>.js, loaded when first shown:
     AyniLocker.define("id", function (host, opts) { ...; return stop; });
   host = an empty full-screen <div> on black, opts = the saved settings. stop() ends everything it started.
   Honest limit: the lock lives in the browser; the session stays valid. */
( function ()
{
    "use strict";

    var cfg      = window.AyniLockerConfig || {};
    var keys     = cfg.keys || {};
    var SET_KEY  = keys.set  || "ayni-locker";
    var LOCK_KEY = keys.lock || "ayni-lock";
    var SEEN_KEY = keys.seen || "ayni-lock-seen";
    var LOCKERS  = cfg.lockers || [ "clock", "matrix", "life" ];
    var MIN_DEFAULT = 15;
    var TICK_MS  = 5000;       // how often the idle time is checked
    var WRITE_MS = 5000;       // activity is written at most this often
    var CARD_MS  = 30000;      // the password box hides again after this idle

    var html = document.documentElement;
    var base = ( ( document.currentScript && document.currentScript.src ) || "" ).replace( /[^\/]*$/, "" );

    var isTop = true;          // false = inside a frame of a page that has it
    try { isTop = window.top === window || ! window.top.AyniLocker; } catch ( e ) {}

    // cfg.isDesk() says which page counts the idle time and locks (default: any
    // top page). The other pages only follow a lock already set.
    var isDesk = isTop && ( ! cfg.isDesk || cfg.isDesk() );

    function get( k )    { try { return localStorage.getItem( k ); } catch ( e ) { return null; } }
    function put( k, v ) { try { if( v == null ) localStorage.removeItem( k ); else localStorage.setItem( k, v ); } catch ( e ) {} }
    function t( k )      { return window.Ayni ? Ayni.t( k ) : k; }

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
        if( ! s.v && ! s.id ) min = 0;     // a v1 "off"; an unknown id (the dropped "stars") is black, minutes kept
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

    function signedIn() { return ! cfg.signedIn || cfg.signedIn(); }
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

    var dlg = null, host = null, card = null, inp = null, btn = null, eye = null, msg = null;
    var stopFn = null, cardTimer = 0, busy = false, waitingDom = false;
    var defs = {};

    function show()
    {
        html.classList.add( "ayni-locked" );
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
        html.classList.remove( "ayni-locked" );
        if( ! dlg ) return;
        stopLocker();
        clearTimeout( cardTimer );
        var d = dlg;
        dlg = host = card = inp = btn = eye = msg = null;
        busy = false;
        if( d.open ) d.close();
        d.remove();
    }

    // A modal <dialog>: it sits above everything (other dialogs, the desktop's
    // windows) and makes the rest of the page inert, iframes included.
    function build()
    {
        dlg = document.createElement( "dialog" );
        dlg.className = "lock-dlg lock";        // Ayni keeps a dialog.lock above any dialog opened later
        dlg.tabIndex = -1;                       // hideCard gives it the focus back

        host = document.createElement( "div" );
        host.className = "lock-host";

        card = document.createElement( "div" );
        card.className = "lock-card";
        card.hidden = true;

        inp = document.createElement( "input" );
        inp.className = "input";
        inp.type = "password";
        // Not "current-password": the browser must not fill it in for whoever
        // is at the keyboard.
        inp.autocomplete = "off";
        inp.spellcheck = false;
        inp.setAttribute( "autocapitalize", "none" );

        // The eye inside the box, before the ✓: Ayni's [data-reveal] shows / hides what is typed.
        var group = document.createElement( "div" );
        group.className = "input-group";
        eye = document.createElement( "button" );
        eye.type = "button";
        eye.className = "btn";
        eye.setAttribute( "data-reveal", "" );
        group.appendChild( inp );
        group.appendChild( eye );

        btn = document.createElement( "button" );
        btn.type = "button";
        btn.className = "btn primary";
        btn.innerHTML = '<span class="icon" data-icon="check"></span>';   // drawn by Ayni (this may run before it loads)

        msg = document.createElement( "p" );
        msg.className = "lock-msg";
        msg.hidden = true;

        card.appendChild( group );
        card.appendChild( btn );
        card.appendChild( msg );
        dlg.appendChild( host );
        dlg.appendChild( card );
        document.body.appendChild( dlg );
        label();
        // A page that opens locked builds this before its dictionary is in;
        // the eye is wired by Ayni once it has started.
        if( window.Ayni ) Ayni.i18n.ready.then( label, function () {} );
        if( window.Ayni && Ayni.ready ) Ayni.ready.then( function () { if( card ) Ayni.init( card ); } );

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
        inp.placeholder = t( "ayni.lock.password" );
        inp.setAttribute( "aria-label", t( "ayni.lock.password" ) );
        btn.dataset.tip = t( "ayni.lock.unlock" );
        btn.setAttribute( "aria-label", t( "ayni.lock.unlock" ) );
        eyeShut();
    }

    // The text hidden again, the eye shut.
    function eyeShut()
    {
        inp.type = "password";
        eye.setAttribute( "aria-pressed", "false" );
        if( window.Ayni && Ayni.icon ) eye.innerHTML = Ayni.icon( "eye" );
        eye.dataset.tip = t( "ayni.password.show" );   // not Ayni.setTip: this may run before Ayni loads
        eye.setAttribute( "aria-label", eye.dataset.tip );
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
        card.hidden = true; inp.value = ""; eyeShut();
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
        busy = true; inp.disabled = true; btn.ariaDisabled = true;

        var status = 0;
        try
        {
            status = await cfg.unlock( inp.value );
        }
        catch ( e ) {}

        if( status === 200 ) { release(); return; }
        if( status === 401 )                     // signed out meanwhile: the
        {                                        // login screen asks anyway
            release();
            if( cfg.signIn ) cfg.signIn();
            return;
        }
        if( ! inp ) return;                      // unlocked from another tab
        busy = false; inp.disabled = false; btn.ariaDisabled = false;
        inp.value = "";
        say( status === 403 ? "ayni.lock.wrong" : "ayni.lock.offline" );
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
        sc.src = cfg.lockerUrl ? cfg.lockerUrl( id, base ) : base + "lockers/" + id + ".js";
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

    // Whose page this is, as it LOADED: the lockers' scripts load later, maybe
    // after another account signed in on this browser, and name this owner on
    // their saves.
    var WHO = cfg.who || "";

    window.AyniLocker = {
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
