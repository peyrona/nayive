/*
 * lockers/clock.js - the bouncing clock (shared/locker.js). The time, hh:mm,
 * with the user's line under it (My account), drifts across the screen and
 * bounces off the edges, changing colour at each bounce.
 */
NayiveLock.define( "clock", function ( host, opts )
{
    "use strict";

    var SPEED = 90;                                  // px per second, each axis

    var box  = document.createElement( "div" );
    var time = document.createElement( "div" );
    var line = document.createElement( "div" );
    box.style.cssText  = "position:absolute;left:0;top:0;text-align:center;white-space:nowrap;" +
                         "font-family:var(--font-sans);will-change:transform;";
    time.style.cssText = "font-size:clamp(56px,13vw,150px);font-weight:700;line-height:1;" +
                         "font-variant-numeric:tabular-nums;";
    line.style.cssText = "font-size:clamp(16px,3vw,30px);margin-top:10px;opacity:0.85;";
    line.textContent = opts.text || "";
    line.hidden = ! opts.text;
    box.appendChild( time );
    box.appendChild( line );
    host.appendChild( box );

    var hue = Math.floor( Math.random() * 360 );
    function paint() { box.style.color = "hsl(" + hue + ",90%,62%)"; }
    function recolour() { hue = ( hue + 60 + Math.floor( Math.random() * 180 ) ) % 360; paint(); }

    function pad( n ) { return n < 10 ? "0" + n : "" + n; }
    var shown = "";
    function setTime()
    {
        var d = new Date(), s = pad( d.getHours() ) + ":" + pad( d.getMinutes() );
        if( s !== shown ) { shown = s; time.textContent = s; }
    }

    setTime();
    paint();
    var x  = Math.random() * Math.max( 0, host.clientWidth  - box.offsetWidth  );
    var y  = Math.random() * Math.max( 0, host.clientHeight - box.offsetHeight );
    var vx = Math.random() < 0.5 ? -SPEED : SPEED;
    var vy = Math.random() < 0.5 ? -SPEED : SPEED;
    var last = 0, raf = 0;

    function frame( now )
    {
        var dt = last ? Math.min( 0.1, ( now - last ) / 1000 ) : 0;
        last = now;
        setTime();

        var maxX = Math.max( 0, host.clientWidth  - box.offsetWidth  );
        var maxY = Math.max( 0, host.clientHeight - box.offsetHeight );
        x += vx * dt;
        y += vy * dt;
        var hit = false;
        if( x <= 0 )    { x = 0;    vx =  SPEED; hit = true; }
        if( x >= maxX ) { x = maxX; vx = -SPEED; hit = true; }
        if( y <= 0 )    { y = 0;    vy =  SPEED; hit = true; }
        if( y >= maxY ) { y = maxY; vy = -SPEED; hit = true; }
        if( hit ) recolour();

        box.style.transform = "translate(" + Math.round( x ) + "px," + Math.round( y ) + "px)";
        raf = requestAnimationFrame( frame );
    }
    raf = requestAnimationFrame( frame );

    return function () { cancelAnimationFrame( raf ); box.remove(); };
} );
