/*
 * lockers/stars.js - sparkling ASCII stars, like the old text-mode screen
 * saver of Norton Commander (shared/locker.js). The screen is a grid of
 * character cells, as on an 80x25 DOS screen; stars pop up in random cells,
 * grow through . + * and shrink away again, in the old CGA colours.
 */
NayiveLock.define( "stars", function ( host )
{
    "use strict";

    var SEQ    = [ ".", "+", "*", "☼", "*", "+", "." ];   // ☼ = ☼
    var COLORS = [ "#AAAAAA", "#FFFFFF", "#55FFFF", "#FFFF55", "#5555FF", "#FF55FF", "#55FF55" ];
    var STEP   = 90;                                 // ms per frame
    var MAX    = 70;                                 // stars at once

    var cv = document.createElement( "canvas" );
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    host.appendChild( cv );
    var g = cv.getContext( "2d" );

    var W = 0, H = 0, cw = 0, ch = 0, cols = 0, rows = 0, stars = [];

    // 80 columns across a wide screen, fewer (bigger letters) on a phone.
    function size()
    {
        var dpr = window.devicePixelRatio || 1;
        W = host.clientWidth; H = host.clientHeight;
        cv.width = Math.round( W * dpr ); cv.height = Math.round( H * dpr );
        g.setTransform( dpr, 0, 0, dpr, 0, 0 );
        cols = Math.max( 20, Math.min( 80, Math.floor( W / 12 ) ) );
        cw = W / cols;
        ch = cw * 2;                                 // a text cell is twice as tall as wide
        rows = Math.max( 1, Math.floor( H / ch ) );
        g.font = "bold " + Math.round( ch * 0.8 ) + "px monospace";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillStyle = "#000"; g.fillRect( 0, 0, W, H );
        stars = [];
    }

    function cell( s, text )
    {
        var x = s.c * cw, y = s.r * ch;
        g.fillStyle = "#000"; g.fillRect( x, y, cw, ch );
        if( text ) { g.fillStyle = s.col; g.fillText( text, x + cw / 2, y + ch / 2 ); }
    }

    function frame()
    {
        if( stars.length < MAX && Math.random() < 0.7 )
            for( var n = 1 + Math.floor( Math.random() * 3 ); n > 0; n-- )
                stars.push( { c: Math.floor( Math.random() * cols ), r: Math.floor( Math.random() * rows ),
                              i: 0, wait: 0, hold: 1 + Math.floor( Math.random() * 3 ),
                              col: COLORS[ Math.floor( Math.random() * COLORS.length ) ] } );

        for( var k = stars.length - 1; k >= 0; k-- )
        {
            var s = stars[ k ];
            if( s.wait-- > 0 ) continue;
            if( s.i >= SEQ.length ) { cell( s, "" ); stars.splice( k, 1 ); continue; }
            cell( s, SEQ[ s.i++ ] );
            s.wait = s.hold;
        }
    }

    size();
    window.addEventListener( "resize", size );
    var timer = setInterval( frame, STEP );

    return function ()
    {
        clearInterval( timer );
        window.removeEventListener( "resize", size );
        cv.remove();
    };
} );
