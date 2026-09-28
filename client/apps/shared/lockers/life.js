/*
 * lockers/life.js - Conway's Game of Life (shared/locker.js). A random board
 * of cells on a wrap-around grid: a live cell with 2 or 3 live neighbours
 * lives on, a dead one with exactly 3 is born, every other cell dies. New
 * cells are bright, old ones cool down to blue. A board that has settled
 * (the same, or blinking between two states, for a while) starts again,
 * and so does one that has run for about five minutes (a lone glider).
 */
NayiveLock.define( "life", function ( host )
{
    "use strict";

    var CELL  = 8;                                   // css px per cell
    var STEP  = 110;                                 // ms per generation
    var STILL = 30;                                  // settled generations before a new board
    var LONG  = 2700;                                // generations before a new board anyway
    var COLORS = [ "#FFFFFF", "#FFFF55", "#55FF55", "#55FFFF", "#5599FF", "#3355CC" ];   // by age

    var cv = document.createElement( "canvas" );
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    host.appendChild( cv );
    var g = cv.getContext( "2d" );

    var W = 0, H = 0, cols = 0, rows = 0;
    var age = null, next = null;                     // 0 = dead, else generations alive
    var seen = [], still = 0, gen = 0;

    function size()
    {
        var dpr = window.devicePixelRatio || 1;
        W = host.clientWidth; H = host.clientHeight;
        cv.width = Math.round( W * dpr ); cv.height = Math.round( H * dpr );
        g.setTransform( dpr, 0, 0, dpr, 0, 0 );
        cols = Math.max( 10, Math.floor( W / CELL ) );
        rows = Math.max( 10, Math.floor( H / CELL ) );
        seed();
    }

    function seed()
    {
        age  = new Uint16Array( cols * rows );
        next = new Uint16Array( cols * rows );
        for( var i = 0; i < age.length; i++ ) age[ i ] = Math.random() < 0.28 ? 1 : 0;
        seen = []; still = 0; gen = 0;
    }

    // A cheap fingerprint of the board, to notice when it stops changing.
    function hash()
    {
        var h = 0;
        for( var i = 0; i < age.length; i++ ) if( age[ i ] ) h = ( h * 31 + i ) | 0;
        return h;
    }

    function step()
    {
        for( var y = 0; y < rows; y++ )
        {
            var up = ( ( y + rows - 1 ) % rows ) * cols, me = y * cols, dn = ( ( y + 1 ) % rows ) * cols;
            for( var x = 0; x < cols; x++ )
            {
                var l = ( x + cols - 1 ) % cols, r = ( x + 1 ) % cols;
                var n = ( age[ up + l ] > 0 ) + ( age[ up + x ] > 0 ) + ( age[ up + r ] > 0 ) +
                        ( age[ me + l ] > 0 ) +                         ( age[ me + r ] > 0 ) +
                        ( age[ dn + l ] > 0 ) + ( age[ dn + x ] > 0 ) + ( age[ dn + r ] > 0 );
                var a = age[ me + x ];
                next[ me + x ] = a ? ( n === 2 || n === 3 ? Math.min( a + 1, 999 ) : 0 ) : ( n === 3 ? 1 : 0 );
            }
        }
        var t = age; age = next; next = t;

        // The same board as 1 or 2 generations ago (still life, blinkers).
        var h = hash();
        still = seen.indexOf( h ) >= 0 ? still + 1 : 0;
        seen.push( h ); if( seen.length > 2 ) seen.shift();
        if( still >= STILL || ++gen >= LONG ) seed();
    }

    function draw()
    {
        g.fillStyle = "#000"; g.fillRect( 0, 0, W, H );
        for( var i = 0; i < age.length; i++ )
        {
            var a = age[ i ];
            if( ! a ) continue;
            g.fillStyle = COLORS[ Math.min( COLORS.length - 1, Math.floor( Math.log2( a ) ) ) ];
            g.fillRect( ( i % cols ) * CELL, Math.floor( i / cols ) * CELL, CELL - 1, CELL - 1 );
        }
    }

    function frame() { step(); draw(); }

    size();
    draw();
    window.addEventListener( "resize", size );
    var timer = setInterval( frame, STEP );

    return function ()
    {
        clearInterval( timer );
        window.removeEventListener( "resize", size );
        cv.remove();
    };
} );
