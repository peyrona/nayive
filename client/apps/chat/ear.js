/*
 * ear.js - a voice call held to the ear. With the screen on, an ear or a
 * cheek presses whatever is under it: mute, hang up, the chat behind.
 *
 * A web page cannot read the proximity sensor, so two ways, never both:
 *
 * 1. The Android app. A browser enrolled as a phone ("nayive-device") asks
 *    the server to switch that phone's sensor on (server/go/devices_ear.go):
 *    the app turns the screen off near the ear, as a phone call does. Asked
 *    again every EAR_BEAT while the call goes on (the server forgets an "on"
 *    nobody repeats), switched off at the end. The server answers whether the
 *    app will do it ("app"): its link is up and the phone has the sensor.
 * 2. Anywhere else - an iPhone, a phone without the app, an old APK, no
 *    sensor - a padlock. LOCK_AFTER ms with no touch and it covers the page,
 *    swallowing every touch; only a slide of its knob, one finger, all the
 *    way, opens it. Touch screens only, the full call screen only: the small
 *    box means the chat is in use, not the ear.
 *
 * call.js says what it wants on every render: C.ear( ear, lock ).
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var h = C.h, T = C.T;

    var LOCK_AFTER = 3000;   // ms without a touch before the padlock comes
    var EAR_BEAT   = 30000;  // ms between two "still on" to the server (it keeps one 90 s)
    var WIDE       = 60;     // px: a contact this wide is a cheek, not a finger

    var touchOnly = !! ( window.matchMedia && matchMedia( "(hover: none) and (pointer: coarse)" ).matches );

    var ear = false, lock = false;   // what call.js wants now
    var app = false;                 // the phone's app turns the screen off
    var beat = null, timer = null, pad = null;

    // ---------------------------------------------------------------------
    // 1. the app
    // ---------------------------------------------------------------------

    function phoneId()
    {
        try { var d = JSON.parse( localStorage.getItem( "nayive-device" ) || "null" ); return d && d.id || ""; }
        catch( _ ) { return ""; }
    }

    // True when the app will do it. Any failure: false - the padlock.
    function tell( on )
    {
        var id = phoneId();
        if( ! id ) return Promise.resolve( false );
        return fetch( "/api/device/" + encodeURIComponent( id ) + "/ear",
                      { method: "POST", credentials: "same-origin", keepalive: ! on,
                        headers: { "Content-Type": "application/json" }, body: JSON.stringify( { on: on } ) } )
            .then( function ( r ) { return r.ok ? r.json() : null; } )
            .then( function ( j ) { return !! ( j && j.app ); } )
            .catch( function () { return false; } );
    }

    function ask()
    {
        tell( true ).then( function ( yes ) { if( ear && yes !== app ) { app = yes; arm(); } } );
    }

    // ---------------------------------------------------------------------
    // 2. the padlock
    // ---------------------------------------------------------------------

    function armed() { return lock && touchOnly && ! app; }

    // (Re)start the count to the padlock - or stop everything when not wanted.
    function arm()
    {
        clearTimeout( timer );
        timer = null;
        if( ! armed() ) { hide(); return; }
        if( ! pad || pad.hidden ) timer = setTimeout( showPad, LOCK_AFTER );
    }

    // A touch on the page (not on the padlock) starts the count again.
    document.addEventListener( "pointerdown", function ( e )
    {
        if( armed() && ! ( pad && pad.contains( e.target ) ) ) arm();
    }, true );

    function hide()
    {
        if( pad ) pad.hidden = true;
    }

    function showPad()
    {
        timer = null;
        if( ! armed() ) return;
        if( ! pad ) build();
        reset( false );
        pad.hidden = false;
        if( document.activeElement && document.activeElement.blur ) document.activeElement.blur();
    }

    var knob, track, drag = null, downs = {};

    function build()
    {
        knob  = h( "span", { class: "ear-knob" }, C.ic( "lock" ) );
        track = h( "div", { class: "ear-track" }, h( "span", { class: "ear-hint", text: T( "chat.slideUnlock" ) } ), knob );
        pad   = h( "div", { class: "ear-pad", attrs: { role: "dialog", "aria-modal": "true", "aria-label": T( "chat.screenLocked" ), hidden: true } }, track );
        document.body.appendChild( pad );

        // Nothing under the padlock ever sees a touch.
        [ "click", "dblclick", "contextmenu", "touchstart", "touchmove", "touchend", "wheel" ].forEach( function ( type )
        {
            pad.addEventListener( type, function ( e ) { if( e.cancelable ) e.preventDefault(); e.stopPropagation(); }, { passive: false } );
        } );
        pad.addEventListener( "pointerdown", function ( e )
        {
            e.preventDefault();
            e.stopPropagation();
            downs[ e.pointerId ] = true;
            // A second contact (a cheek, an ear) stops a slide halfway.
            if( Object.keys( downs ).length > 1 ) { reset( true ); return; }
            if( ! knob.contains( e.target ) || ! e.isPrimary || ( e.width || 0 ) > WIDE ) return;
            drag = { id: e.pointerId, x0: e.clientX, max: track.clientWidth - knob.offsetWidth - 2 * knob.offsetLeft, dx: 0 };
            knob.classList.remove( "back" );
            try { pad.setPointerCapture( e.pointerId ); } catch( _ ) {}
        } );
        pad.addEventListener( "pointermove", function ( e )
        {
            e.stopPropagation();
            if( ! drag || e.pointerId !== drag.id ) return;
            drag.dx = Math.max( 0, Math.min( drag.max, e.clientX - drag.x0 ) );
            knob.style.transform = "translateX(" + drag.dx + "px)";
        } );
        var up = function ( e )
        {
            e.stopPropagation();
            delete downs[ e.pointerId ];
            if( ! drag || e.pointerId !== drag.id ) return;
            var done = e.type === "pointerup" && drag.max > 0 && drag.dx >= drag.max * 0.9;
            reset( true );
            if( done ) { hide(); arm(); }
        };
        pad.addEventListener( "pointerup", up );
        pad.addEventListener( "pointercancel", up );
    }

    // The knob back at the start; `slide`: glide there (it was moved).
    function reset( slide )
    {
        drag = null;
        if( ! knob ) return;
        knob.classList.toggle( "back", !! slide );
        knob.style.transform = "";
        if( ! slide ) downs = {};
    }

    // ---------------------------------------------------------------------
    // what call.js wants
    // ---------------------------------------------------------------------

    // `on`: a voice call is on (calling, connecting, talking). `full`: and its
    // whole screen shows. Called on every render: only a change does anything,
    // or a busy call would keep pushing the padlock back.
    C.ear = function ( on, full )
    {
        on = !! on;
        full = on && !! full;
        if( on === ear && full === lock ) return;
        lock = full;
        if( on !== ear )
        {
            ear = on;
            clearInterval( beat );
            beat = null;
            app = false;
            if( on ) { ask(); beat = setInterval( ask, EAR_BEAT ); }
            else if( phoneId() ) tell( false );
        }
        arm();
    };
} )();
