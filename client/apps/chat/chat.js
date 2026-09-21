/*
 * chat.js - start(): builds the two panes and opens the chat. Loaded LAST,
 * after core.js, list.js, conv.js, compose.js, media.js, info.js, call.js (and
 * guest.js on a person's page). See core.js for the map of the files.
 *
 *     NayiveChat.start( { mode: "owner", api: "/api/chat" } )                 chat/index.html
 *     NayiveChat.start( { mode: "guest", api: "/api/c/<token>", token } )     chat/guest.html
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h;

    // Drag the divider to set the list width (desktop only). Saved in this
    // browser, so each device keeps its own. Double-click: back to default.
    function initResizer( rz, side )
    {
        var KEY = "chat-side-width", MIN = 260, MAX = 600, DEF = 340;
        var root = document.documentElement.style;
        function set( w ) { root.setProperty( "--side-w", w + "px" ); }

        var saved = 0;
        try { saved = parseInt( localStorage.getItem( KEY ), 10 ); } catch( _ ) {}
        if( saved >= MIN && saved <= MAX ) set( saved );

        var dragging = false, startX = 0, startW = 0;

        rz.addEventListener( "pointerdown", function ( e )
        {
            dragging = true;
            startX   = e.clientX;
            startW   = side.getBoundingClientRect().width;
            rz.setPointerCapture( e.pointerId );
            rz.classList.add( "dragging" );
            document.body.style.userSelect = "none";
        } );
        rz.addEventListener( "pointermove", function ( e )
        {
            if( ! dragging ) return;
            set( Math.max( MIN, Math.min( MAX, Math.round( startW + e.clientX - startX ) ) ) );
        } );
        function end()
        {
            if( ! dragging ) return;
            dragging = false;
            rz.classList.remove( "dragging" );
            document.body.style.userSelect = "";
            try { localStorage.setItem( KEY, Math.round( side.getBoundingClientRect().width ) ); } catch( _ ) {}
        }
        rz.addEventListener( "pointerup", end );
        rz.addEventListener( "pointercancel", end );
        rz.addEventListener( "dblclick", function ()
        {
            set( DEF );
            try { localStorage.setItem( KEY, DEF ); } catch( _ ) {}
        } );
    }

    C.start = async function ( cfg )
    {
        S.mode  = cfg.mode;
        S.api   = cfg.api;
        S.token = cfg.token || "";

        var side = h( "section", { class: "side" } );
        var main = h( "section", { class: "main" } );
        var rz   = h( "div", { class: "pane-resizer", attrs: { title: C.T( "chat.dragWidth" ) } } );
        var root = h( "div", { class: "chat", attrs: { id: "chat" } }, side, rz, main );
        var host = document.getElementById( "app" );
        host.textContent = "";
        host.appendChild( root );
        host.appendChild( h( "div", { class: "toast", attrs: { id: "toast", role: "status" } } ) );

        initResizer( rz, side );
        C.buildList( side );
        C.buildMain( main );
        if( NayiveUI.applySyncDots ) NayiveUI.applySyncDots( root );
        if( S.mode === "owner" && NayiveUI.applyHomeLinks ) NayiveUI.applyHomeLinks( root );
        C.setConn( "loading" );

        try { await C.loadSummary(); }
        catch( e )
        {
            if( S.mode === "guest" && e.status === 404 ) { C.showGone(); return; }
            C.setConn( "offline" );
            C.fail( e );
        }

        if( S.mode === "guest" )
        {
            C.guestWorker();
            await C.guestWelcome();
        }

        // ?c=<conv>: a notification was tapped. A person with a single chat
        // (no groups) goes straight into it, as in the mockup.
        var want = new URLSearchParams( location.search ).get( "c" );
        if( want && C.convOf( want ) ) C.openConv( want );
        else if( S.mode === "guest" && S.convs.length === 1 && matchMedia( "(max-width: 640px)" ).matches )
            C.openConv( S.convs[ 0 ].id );
        else if( S.mode === "guest" && S.convs.length && ! matchMedia( "(max-width: 640px)" ).matches )
            C.openConv( C.sortedConvs()[ 0 ].id );
        if( want ) try { history.replaceState( history.state, "", location.pathname ); } catch( _ ) {}

        // A notification tapped while this page is open: the worker does not
        // reload it (that would cut a call) - it says which chat to show.
        if( navigator.serviceWorker ) navigator.serviceWorker.addEventListener( "message", function ( e )
        {
            var url = e.data && e.data.open;
            if( ! url ) return;
            var c = new URL( url, location.href ).searchParams.get( "c" );
            if( ! C.inCall() && c && C.convOf( c ) ) C.openConv( c );
        } );

        C.startLoop();
    };
} )();
