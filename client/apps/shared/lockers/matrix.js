/*
 * lockers/matrix.js - "Matrix" digital rain (shared/locker.js). Green
 * half-width katakana and digits fall in columns, each column its own speed,
 * the head bright and the trail fading into the black.
 */
NayiveLock.define( "matrix", function ( host )
{
    "use strict";

    var GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:=*+-<>|";
    var CELL  = 18;                                  // css px per character
    var STEP  = 55;                                  // ms per frame

    var cv  = document.createElement( "canvas" );
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    host.appendChild( cv );
    var g = cv.getContext( "2d" );

    var W = 0, H = 0, drops = [], speed = [];

    function size()
    {
        var dpr = window.devicePixelRatio || 1;
        W = host.clientWidth; H = host.clientHeight;
        cv.width = Math.round( W * dpr ); cv.height = Math.round( H * dpr );
        g.setTransform( dpr, 0, 0, dpr, 0, 0 );
        g.fillStyle = "#000"; g.fillRect( 0, 0, W, H );
        g.font = ( CELL - 2 ) + "px monospace";
        g.textBaseline = "top";
        var cols = Math.ceil( W / CELL );
        drops = []; speed = [];
        for( var i = 0; i < cols; i++ )
        {
            drops.push( -Math.floor( Math.random() * H / CELL ) );
            speed.push( Math.random() < 0.3 ? 2 : 1 );
        }
    }

    function pick() { return GLYPHS.charAt( Math.floor( Math.random() * GLYPHS.length ) ); }

    var tick = 0;
    function frame()
    {
        tick++;
        g.fillStyle = "rgba(0,0,0,0.09)";            // the trail fades
        g.fillRect( 0, 0, W, H );

        for( var i = 0; i < drops.length; i++ )
        {
            if( speed[ i ] === 1 && tick % 2 ) continue;   // the slow columns
            var y = drops[ i ] * CELL;
            if( y >= 0 )
            {
                g.fillStyle = "#3f3";                // the one just written
                g.fillText( pick(), i * CELL, y - CELL );
                g.fillStyle = "#dfd";                // the head, nearly white
                g.fillText( pick(), i * CELL, y );
            }
            drops[ i ]++;
            if( y > H && Math.random() > 0.975 ) drops[ i ] = 0;
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
