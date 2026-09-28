/*
 * run.mjs - the desktop's Scale and Tile, in the real desktop page, in headless
 * Chromium: node tools/desktop-test/run.mjs [shots-dir]
 *
 * The page is served as it ships (client/apps at /nayive/, no server API: the
 * launcher only leaves for the sign-in page on a 401). The windows show
 * FIXTURE pages (/nayive/fixture/box.html?w=&h=&n=): one box of a known size,
 * so what "fits" means is exact. Sizes are changed the way a person does it -
 * mouse drags on the grips - and read back through window.NayiveDesktop.
 * Nothing is written into client/apps.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, attach } from "../locktest/cdp.mjs";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const APPS = path.resolve( here, "../../client/apps" );
const SHOTS = process.argv[ 2 ] || "";

const BOX = `<!doctype html><html><head><meta charset="utf-8"><title>Box</title>
<style>html{overflow-x:hidden;overflow-y:auto}body{margin:0;font:14px sans-serif}
#box{box-sizing:border-box;border:3px solid #335;background:linear-gradient(135deg,#8cf,#fc8);padding:8px}</style></head>
<body><div id="box"></div><script>
var q = new URLSearchParams( location.search ), b = document.getElementById( 'box' );
b.style.width = ( q.get( 'w' ) || 700 ) + 'px'; b.style.height = ( q.get( 'h' ) || 400 ) + 'px';
b.textContent = 'Box ' + ( q.get( 'n' ) || '' ); document.title = b.textContent;
window.clicks = []; document.addEventListener( 'click', function ( e ) { clicks.push( [ e.clientX, e.clientY ] ); } );
</script></body></html>`;

// A page that holds another page in a frame, set only after a moment - the way
// Planner holds Calendar / Tasks / Habits (their src comes from data-src).
const NEST = `<!doctype html><html><head><meta charset="utf-8"><title>Nest</title>
<style>body{margin:0}iframe{display:block;width:100%;height:340px;border:0}</style></head>
<body><iframe id="inner"></iframe><script>
setTimeout( function () { document.getElementById( 'inner' ).src = '/nayive/fixture/box.html?w=200&h=100&n=Inner'; }, 200 );
</script></body></html>`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
                ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

function serve()
{
    const server = http.createServer( ( req, res ) =>
    {
        const u = decodeURIComponent( req.url.split( "?" )[ 0 ] );
        if( ! u.startsWith( "/nayive/" ) ) { res.writeHead( 404 ).end(); return; }
        let rel = u.slice( 8 );
        if( rel === "" || rel.endsWith( "/" ) ) rel += "index.html";
        if( rel === "fixture/box.html" ) { res.writeHead( 200, { "Content-Type": "text/html" } ).end( BOX ); return; }
        if( rel === "fixture/nest.html" ) { res.writeHead( 200, { "Content-Type": "text/html" } ).end( NEST ); return; }
        const file = path.resolve( APPS, rel );
        if( ! file.startsWith( APPS + path.sep ) ) { res.writeHead( 403 ).end(); return; }
        fs.readFile( file, ( err, body ) =>
        {
            if( err ) { res.writeHead( 404 ).end(); return; }
            res.writeHead( 200, { "Content-Type": TYPES[ path.extname( file ) ] || "application/octet-stream" } ).end( body );
        } );
    } );
    return new Promise( r => server.listen( 0, "127.0.0.1", () => r( { port: server.address().port, close: () => server.close() } ) ) );
}

let fails = 0, passes = 0;
function check( name, ok, info )
{
    if( ok ) { passes++; console.log( "ok   " + name ); }
    else { fails++; console.log( "FAIL " + name + ( info !== undefined ? "  " + JSON.stringify( info ) : "" ) ); }
}
const near = ( a, b, tol = 1.5 ) => Math.abs( a - b ) <= tol;
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const srv = await serve();
const b = await browser();
const ORIGIN = `http://127.0.0.1:${srv.port}`;
try
{
    const tab = await b.newTab( "about:blank" );
    const c = await attach( tab.webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1900, height: 1100, deviceScaleFactor: 1, mobile: false } );
    await c.send( "Page.bringToFront" );

    const ev = ( e, ms ) => c.evaluate( e, ms );
    async function waitFor( expr, ms = 8000, what = expr )
    {
        const end = Date.now() + ms;
        for( ;; )
        {
            let v = null;
            try { v = await ev( expr ); } catch {}
            if( v ) return v;
            if( Date.now() > end ) throw new Error( "timed out waiting for: " + what );
            await sleep( 60 );
        }
    }
    async function go( p )
    {
        await c.send( "Page.navigate", { url: ORIGIN + p } );
        await waitFor( `location.pathname + '|' + document.readyState === ${JSON.stringify( p.split( "?" )[ 0 ] + "|complete" )}` );
    }
    const wins = () => ev( "JSON.stringify( NayiveDesktop.windows() )" ).then( JSON.parse );
    const win  = i => wins().then( l => l[ i ] );
    // Two frames for the measure, and a margin.
    const settle = () => ev( "new Promise( r => requestAnimationFrame( () => requestAnimationFrame( () => requestAnimationFrame( () => setTimeout( r, 30 ) ) ) ) )" );
    async function mouse( type, x, y, buttons = 0 )
    {
        // A move with the button held must NAME the button, or Chromium drops the pointer capture.
        await c.send( "Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && ! buttons ? "none" : "left", buttons, clickCount: 1 } );
    }
    async function dragMouse( x0, y0, x1, y1, steps = 10 )
    {
        await mouse( "mouseMoved", x0, y0 );
        await mouse( "mousePressed", x0, y0, 1 );
        for( let i = 1; i <= steps; i++ )
            await mouse( "mouseMoved", x0 + ( x1 - x0 ) * i / steps, y0 + ( y1 - y0 ) * i / steps, 1 );
        await mouse( "mouseReleased", x1, y1 );
        await settle();
    }
    async function click( x, y ) { await mouse( "mouseMoved", x, y ); await mouse( "mousePressed", x, y, 1 ); await mouse( "mouseReleased", x, y ); await settle(); }
    // The element drawn at a desk point, and its window's number on the bar.
    const hit = ( x, y ) => ev( `( function () { var e = document.elementFromPoint( ${x}, ${y} ); var w = e && e.closest( '.win' );
        return JSON.stringify( { cls: e ? e.className : '', win: w ? [].indexOf.call( document.querySelectorAll( '#desk > .win' ), w ) : -1 } ); } )()` ).then( JSON.parse );
    const winEl = i => `document.querySelectorAll( '#desk > .win' )[ ${i} ]`;
    const rectOf = expr => ev( `JSON.stringify( ${expr}.getBoundingClientRect() )` ).then( JSON.parse );
    const frameDoc = i => `${winEl( i )}.querySelector( 'iframe' ).contentDocument.documentElement`;
    async function shot( name )
    {
        if( ! SHOTS ) return;
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    }

    // ----- the desk, as a person left it: A plain, B and C with Scale on, D minimised
    await go( "/nayive/fixture/box.html" );
    const saved = [
        { url: "/nayive/fixture/box.html?w=600&h=300&n=A",   l: "20px",  t: "20px",  w: "700px",  h: "450px" },
        { url: "/nayive/fixture/box.html?w=1000&h=400&n=B",  l: "760px", t: "20px",  w: "1100px", h: "450px", scale: true },
        { url: "/nayive/fixture/box.html?w=300&h=3000&n=C",  l: "20px",  t: "500px", w: "500px",  h: "400px", scale: true },
        { url: "/nayive/fixture/box.html?w=400&h=300&n=D",   l: "600px", t: "520px", w: "600px",  h: "420px", min: true }
    ];
    await ev( `localStorage.setItem( 'balata-coach-seen', '1' ); localStorage.setItem( 'balata-intro-dismiss:desktop', '1' );
               localStorage.setItem( 'nayive-install-snooze', 'never' );
               localStorage.setItem( 'balata-desktop-wins', ${JSON.stringify( JSON.stringify( saved ) )} ); localStorage.removeItem( 'balata-desktop-tile' ); true` );
    await go( "/nayive/desktop/index.html" );
    await waitFor( "window.NayiveDesktop && NayiveDesktop.windows && NayiveDesktop.windows().length === 4", 10000, "4 windows restored" );
    await waitFor( "[].every.call( document.querySelectorAll( '#desk > .win iframe' ), function ( f ) { try { return /^Box /.test( f.contentDocument.title ); } catch( e ) { return false; } } )", 10000, "frames loaded" );
    await settle(); await settle();
    const desk = await rectOf( "document.getElementById( 'desk' )" );
    const D = { w: desk.width, h: desk.height };

    // ----- 1. Scale off: exactly as before
    let w = await wins();
    check( "restored: four windows, D minimised", w.length === 4 && w[ 3 ].min && ! w[ 0 ].min );
    check( "A (Scale off): 1:1, where it was saved", w[ 0 ].factor === 1 && w[ 0 ].box.w === 700 && w[ 0 ].box.h === 450 && ! w[ 0 ].scale, w[ 0 ] );
    check( "A: no transform", await ev( `getComputedStyle( ${winEl( 0 )} ).transform` ) === "none" );
    check( "B (Scale on, page fits): 1:1", w[ 1 ].factor === 1 && w[ 1 ].scale, w[ 1 ] );
    check( "C (Scale on, page longer than the desk): 1:1, it scrolls", w[ 2 ].factor === 1 &&
           await ev( `${frameDoc( 2 )}.scrollHeight > ${frameDoc( 2 )}.clientHeight` ), w[ 2 ] );

    // ----- 1b. The window's buttons: on the bar button of the window in front, not in title bars
    const frontBtn = what => `document.querySelector( '#tasks .task.front [data-win="${what}"]' )`;
    async function press( expr ) { const r = await rectOf( expr ); await click( r.left + r.width / 2, r.top + r.height / 2 ); }
    check( "no dots left in any title bar", await ev( `! document.querySelector( '.win-dots' ) && [].every.call( document.querySelectorAll( '#desk iframe' ),
           function ( f ) { return ! f.contentDocument.querySelector( '.win-dots' ); } )` ) === true );
    check( "only the bar button in front shows its buttons", await ev( `[].filter.call( document.querySelectorAll( '#tasks .task-ctl' ),
           function ( c ) { return c.offsetParent !== null; } ).length === 1 && !! document.querySelector( '#tasks .task.front .task-ctl' ).offsetParent` ) === true );
    check( "its buttons: Scale / Resize, minimise, maximise, close", await ev( `[].map.call( document.querySelectorAll( '#tasks .task.front .task-ctl > [data-win]' ),
           function ( b ) { return b.getAttribute( 'data-win' ); } ).join()` ) === "scale,min,max,close" );
    const colours = JSON.parse( await ev( `( function () { var cs = getComputedStyle( document.getElementById( 'desktop' ) ), c = function ( w ) { return getComputedStyle( document.querySelector( '#tasks .task.front [data-win="' + w + '"] svg' ) ).color; };
        var probe = document.createElement( 'i' ); document.body.appendChild( probe ); var tok = function ( v ) { probe.style.color = cs.getPropertyValue( v ).trim(); return getComputedStyle( probe ).color; };
        var out = { scale: [ c( 'scale' ), tok( '--win-scale' ) ], min: [ c( 'min' ), tok( '--warn' ) ], max: [ c( 'max' ), tok( '--ok' ) ], close: [ c( 'close' ), tok( '--danger' ) ] }; probe.remove(); return JSON.stringify( out ); } )()` ) );
    check( "colours: blue Scale / Resize, then the old dots' warn / ok / danger", Object.values( colours ).every( ( [ a, z ] ) => a === z ) && /rgb\(\s*(24, 115, 204|30, 144, 255)/.test( colours.scale[ 0 ] ), colours );
    const fi = await ev( "NayiveDesktop.windows().findIndex( function ( x ) { return x.name === document.querySelector( '#tasks .task.front span' ).textContent; } )" );
    const sc0 = JSON.parse( await ev( `JSON.stringify( [ NayiveDesktop.windows()[ ${fi} ].scale, ${frontBtn( "scale" )}.title, ${frontBtn( "scale" )}.innerHTML.length, ${frontBtn( "scale" )}.getAttribute( 'aria-pressed' ) ] )` ) );
    await press( frontBtn( "scale" ) );
    const sc1 = JSON.parse( await ev( `JSON.stringify( [ NayiveDesktop.windows()[ ${fi} ].scale, ${frontBtn( "scale" )}.title, ${frontBtn( "scale" )}.innerHTML.length, ${frontBtn( "scale" )}.getAttribute( 'aria-pressed' ) ] )` ) );
    check( "Scale / Resize button: flips the mode, its icon and its tooltip", sc0[ 0 ] !== sc1[ 0 ] && sc0[ 1 ] !== sc1[ 1 ] && sc0[ 2 ] !== sc1[ 2 ] && sc1[ 3 ] === String( sc1[ 0 ] ) && /^(Scale|Resize)/.test( sc1[ 1 ] ), { sc0, sc1 } );
    await press( frontBtn( "scale" ) );
    check( "Scale / Resize button: and back", await ev( `NayiveDesktop.windows()[ ${fi} ].scale` ) === sc0[ 0 ] );
    check( "Tile switch: off", await ev( "! document.getElementById( 'tileChk' ).checked && ! document.getElementById( 'tileSw' ).classList.contains( 'idle' )" ) === true );

    // A dragged far smaller: stops at the old smallest window, as today.
    await dragMouse( 20 + 700 - 3, 20 + 450 - 3, 20 + 100, 20 + 50 );
    w = await wins();
    check( "A (Scale off) dragged tiny: stops at 320 x 200, still 1:1", w[ 0 ].box.w === 320 && w[ 0 ].box.h === 200 && w[ 0 ].factor === 1, w[ 0 ].box );
    await dragMouse( 20 + 320 - 3, 20 + 200 - 3, 20 + 700 - 3, 20 + 450 - 3 );
    w = await wins();
    check( "A dragged back: 700 x 450", w[ 0 ].box.w === 700 && w[ 0 ].box.h === 450, w[ 0 ].box );

    // ----- 2. Scale on: shrinking below what the page needs shrinks the page
    await click( 760 + 600, 20 + 300 );                       // B to the front
    await dragMouse( 760 + 1100 - 3, 20 + 450 - 3, 760 + 500 - 3, 20 + 450 - 3 );
    await settle();
    w = await wins();
    // Made smaller from 1100 x 450 at 1:1: it shrinks from that size, a picture of itself
    check( "B at 500 wide: shrunk to 500/1100, from its 1:1 size", near( w[ 1 ].factor, 500 / 1100, 0.002 ) && w[ 1 ].nat && w[ 1 ].nat.w === 1100 && w[ 1 ].nat.h === 450, w[ 1 ] );
    let r = await rectOf( winEl( 1 ) );
    check( "B: drawn exactly 500 x 450", near( r.width, 500 ) && near( r.height, 450 ), r );
    check( "B: its whole page fits (no horizontal overflow)", await ev( `${frameDoc( 1 )}.scrollWidth <= ${frameDoc( 1 )}.clientWidth + 1` ) );
    check( "B: the loose side is laid out longer (no empty band)", await ev( `${frameDoc( 1 )}.clientHeight` ) > 402 );
    await shot( "1-scaled" );

    // A click inside the shrunk page lands where it was aimed (the transform maps it).
    const fr = await rectOf( `${winEl( 1 )}.querySelector( 'iframe' )` );
    await click( fr.left + 100, fr.top + 60 );
    const got = JSON.parse( await ev( `JSON.stringify( ${winEl( 1 )}.querySelector( 'iframe' ).contentWindow.clicks.slice( -1 )[ 0 ] )` ) );
    check( "B: a click through the shrink lands on the right page pixel", got && near( got[ 0 ], 100 / w[ 1 ].factor, 2.5 ) && near( got[ 1 ], 60 / w[ 1 ].factor, 2.5 ), { got, want: [ 100 / w[ 1 ].factor, 60 / w[ 1 ].factor ] } );

    // No smallest size.
    await dragMouse( 760 + 500 - 3, 20 + 450 - 3, 760 + 60 - 3, 20 + 40 - 3 );
    w = await wins();
    check( "B dragged to 60 x 40: no floor", near( w[ 1 ].box.w, 60 ) && near( w[ 1 ].box.h, 40 ) && w[ 1 ].factor < 0.07, w[ 1 ] );
    r = await rectOf( winEl( 1 ) );
    check( "B: drawn 60 x 40", near( r.width, 60 ) && near( r.height, 40 ), r );
    let h = await hit( 760 + 60 - 3, 20 + 40 - 3 );
    check( "B tiny: its corner grip is still there", h.win === 1 && /grip se/.test( h.cls ), h );
    const gr = await rectOf( `${winEl( 1 )}.querySelector( '.grip.se' )` );
    check( "B tiny: the grip is a full 14px on screen", near( gr.width, 14, 0.6 ) && near( gr.height, 14, 0.6 ), gr );
    await shot( "2-tiny" );

    // Pulled back out: 1:1 again.
    await dragMouse( 760 + 60 - 3, 20 + 40 - 3, 760 + 1100 - 3, 20 + 450 - 3 );
    await settle();
    w = await wins();
    check( "B pulled back to 1100 x 450: 1:1, natural size let go", w[ 1 ].factor === 1 && ! w[ 1 ].nat && near( w[ 1 ].box.w, 1100 ), w[ 1 ] );

    // Shrink by the LEFT edge: the right edge stays put.
    await dragMouse( 760 + 3, 20 + 200, 760 + 600 + 3, 20 + 200 );
    w = await wins();
    check( "B shrunk from its left edge: right edge still at 1860", near( w[ 1 ].box.l + w[ 1 ].box.w, 1860 ) && w[ 1 ].factor < 1, w[ 1 ].box );

    // ----- 3. Maximise is always 1:1; restored, it shrinks again
    const f0 = w[ 1 ].factor;
    check( "B is in front", await ev( "document.querySelector( '#tasks .task.front span' ).textContent" ) === "Box B" );
    await press( frontBtn( "max" ) );
    w = await wins();
    r = await rectOf( winEl( 1 ) );
    check( "B maximised: 1:1 over the whole desk", w[ 1 ].max && w[ 1 ].factor === 1 && near( r.width, D.w ) && near( r.height, D.h ), { f: w[ 1 ].factor, r } );
    check( "B maximised: no transform", await ev( `getComputedStyle( ${winEl( 1 )} ).transform` ) === "none" );
    await press( frontBtn( "max" ) );
    await settle();
    w = await wins();
    check( "B restored: shrinks again, same factor", ! w[ 1 ].max && near( w[ 1 ].factor, f0, 0.002 ), { f: w[ 1 ].factor, f0 } );

    // ----- 4. The switch, on and off
    await ev( "NayiveDesktop.scale( 0, true )" ); await settle();
    w = await wins();
    check( "A: Scale switched on, its page fits -> still 1:1", w[ 0 ].scale && w[ 0 ].factor === 1, w[ 0 ] );
    await dragMouse( 20 + 700 - 3, 20 + 450 - 3, 20 + 350 - 3, 20 + 450 - 3 );
    await settle();
    w = await wins();
    check( "A (Scale on) at 350 wide: shrunk", w[ 0 ].factor < 1 && near( w[ 0 ].box.w, 350 ), w[ 0 ] );
    await ev( "NayiveDesktop.scale( 0, false )" ); await settle();
    w = await wins();
    check( "A: Scale off again -> 1:1 at once", ! w[ 0 ].scale && w[ 0 ].factor === 1 && w[ 0 ].box.w === 350, w[ 0 ] );
    await ev( "NayiveDesktop.scale( 0, true )" ); await settle();
    w = await wins();
    check( "A: Scale on for a window already too small -> shrinks at once", w[ 0 ].factor < 1, w[ 0 ] );
    await ev( "NayiveDesktop.scale( 0, false )" ); await settle();

    // ----- 5. Tile
    // B maximised first, to see Untile give that back.
    await press( "document.querySelectorAll( '#tasks .task' )[ 1 ]" );          // B's bar button: B to the front
    await press( frontBtn( "max" ) );
    const before = await wins();
    await press( "document.querySelector( '#tileSw .track' )" );               // the switch: Free -> Tile
    check( "Tile switch: on, bold Tile", await ev( "document.getElementById( 'tileChk' ).checked && document.getElementById( 'tileSw' ).classList.contains( 'on' )" ) === true );
    await settle();
    w = await wins();
    const want = JSON.parse( await ev( `JSON.stringify( NayiveTiling.tile( 3, ${D.w}, ${D.h}, { minW: 320, minH: 200 } ) )` ) );
    check( "Tile: on", await ev( "NayiveDesktop.isTiled()" ) === true );
    check( "Tile: A, B, C in bar order get the grid's boxes", [ 0, 1, 2 ].every( i =>
        near( w[ i ].box.l, want[ i ].l, 0.01 ) && near( w[ i ].box.t, want[ i ].t, 0.01 ) && near( w[ i ].box.w, want[ i ].w, 0.01 ) && near( w[ i ].box.h, want[ i ].h, 0.01 ) ),
        { got: w.slice( 0, 3 ).map( x => x.box ), want } );
    check( "Tile: 3 windows = one tall left, two stacked right", want[ 0 ].h === D.h && want[ 1 ].l === want[ 2 ].l );
    check( "Tile: the minimised one stays minimised", w[ 3 ].min && w[ 3 ].tiled );
    check( "Tile: B is no longer maximised", ! w[ 1 ].max );
    check( "Tile: B (Scale on, box narrower than its page) shrinks to fit", w[ 1 ].factor < 1 &&
           await ev( `${frameDoc( 1 )}.scrollWidth <= ${frameDoc( 1 )}.clientWidth + 1` ), w[ 1 ] );
    check( "Tile: A (Scale off, box narrower than its page) keeps 1:1 and overflows", w[ 0 ].factor === 1 || want[ 0 ].w >= 704 );
    for( let i = 0; i < 3; i++ )
    {
        const rr = await rectOf( winEl( i ) );
        check( `Tile: window ${i} is drawn in its box`, near( rr.left - desk.left, want[ i ].l ) && near( rr.top - desk.top, want[ i ].t ) &&
               near( rr.width, want[ i ].w ) && near( rr.height, want[ i ].h ), { rr, box: want[ i ] } );
    }
    await shot( "3-tiled" );

    // A manual move while tiled; the word Tile tiles again.
    await dragMouse( want[ 0 ].l + 200, want[ 0 ].t + 22, want[ 0 ].l + 140, want[ 0 ].t + 62 );
    w = await wins();
    check( "Tiled: a window moved by hand stays moved", w[ 0 ].box.t === 40, w[ 0 ].box );
    await press( "document.querySelector( '#tileSw .tile-word[data-tile=\"on\"]' )" );
    w = await wins();
    check( "The word Tile, while tiled: tiles again", near( w[ 0 ].box.l, want[ 0 ].l, 0.01 ) && near( w[ 0 ].box.t, want[ 0 ].t, 0.01 ), w[ 0 ].box );
    // ...and a manual move again, to be dropped by Untile.
    await dragMouse( want[ 0 ].l + 200, want[ 0 ].t + 22, want[ 0 ].l + 140, want[ 0 ].t + 62 );

    // Minimise C while tiled: the desk is dealt out again, to A and B.
    await press( "document.querySelectorAll( '#tasks .task' )[ 2 ]" );          // C's bar button: C to the front
    await press( frontBtn( "min" ) );
    await settle();
    w = await wins();
    const two = JSON.parse( await ev( `JSON.stringify( NayiveTiling.tile( 2, ${D.w}, ${D.h}, { minW: 320, minH: 200 } ) )` ) );
    check( "Tiled + minimise C: A and B share the desk", w[ 2 ].min && near( w[ 0 ].box.w, two[ 0 ].w, 0.01 ) && near( w[ 1 ].box.l, two[ 1 ].l, 0.01 ) && near( w[ 0 ].box.l, 0, 0.01 ),
           w.map( x => x.box ) );

    // Open a window while tiled (from inside an app, as Drive does): it joins the grid.
    await ev( `${winEl( 0 )}.querySelector( 'iframe' ).contentWindow.open( '/nayive/fixture/box.html?w=300&h=200&n=E' ), true` );
    await waitFor( "NayiveDesktop.windows().length === 5" );
    await settle();
    w = await wins();
    check( "Tiled + a new window: A, B, E share the desk", [ 0, 1, 4 ].every( ( k, i ) => near( w[ k ].box.w, want[ i ].w, 0.01 ) && near( w[ k ].box.l, want[ i ].l, 0.01 ) ),
           w.map( x => x.box ) );

    // Reload while tiled: still tiled, and Untile still knows the way back.
    await sleep( 400 );                                     // saveWins waits 300ms
    await go( "/nayive/desktop/index.html" );
    await waitFor( "window.NayiveDesktop && NayiveDesktop.windows && NayiveDesktop.windows().length === 5", 10000, "5 windows after reload" );
    await settle();
    check( "Reload while tiled: still tiled", await ev( "NayiveDesktop.isTiled()" ) === true );

    // ----- 6. Untile: exactly as before. (A reload puts the bar in stacking
    // order - as it always has - so windows are matched by name from here on.)
    check( "Reload while tiled: the switch says Tile", await ev( "document.getElementById( 'tileChk' ).checked" ) === true );
    await press( "document.querySelector( '#tileSw .tile-word[data-tile=\"off\"]' )" );   // the word "Free"
    await settle(); await settle();
    w = await wins();
    const at = name => w.findIndex( x => x.name === name );
    check( "Untile: off", await ev( "NayiveDesktop.isTiled()" ) === false );
    for( let i = 0; i < 4; i++ )
    {
        const a = before[ i ], z = w[ at( a.name ) ];
        check( `Untile: window ${i} back exactly (box, maximised, minimised, Scale, factor)`,
               near( a.box.l, z.box.l, 0.01 ) && near( a.box.t, z.box.t, 0.01 ) && near( a.box.w, z.box.w, 0.02 ) && near( a.box.h, z.box.h, 0.02 ) &&
               a.max === z.max && a.min === z.min && a.scale === z.scale && near( a.factor, z.factor, 0.0005 ),
               { before: a, after: z } );
    }
    const r0 = await rectOf( winEl( at( "Box B" ) ) );
    check( "Untile: B maximised again, over the whole desk", near( r0.width, D.w ) && near( r0.height, D.h ), r0 );
    check( "Untile: C, minimised while tiled, is back on the desk (a hard revert)", ! w[ at( "Box C" ) ].min );
    const deflt = { w: Math.min( 1100, Math.round( D.w * 0.7 ) ), h: Math.min( 780, Math.round( D.h * 0.82 ) ) };
    const e = w[ at( "Box E" ) ];
    check( "Untile: E (opened while tiled) goes where a new window opens", near( e.box.w, deflt.w ) && near( e.box.h, deflt.h ) && ! e.tiled,
           { box: e.box, deflt } );
    await shot( "4-untiled" );

    // ----- 7. A new desk size while tiled deals the desk out again
    await ev( "NayiveDesktop.tile()" ); await settle();
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false } );
    await sleep( 200 ); await settle(); await settle();
    const d2 = await rectOf( "document.getElementById( 'desk' )" );
    w = await wins();
    const shown = w.filter( x => ! x.min );
    const right = Math.max( ...shown.map( x => x.box.l + x.box.w ) ), bottom = Math.max( ...shown.map( x => x.box.t + x.box.h ) );
    check( "Desk resized while tiled: the tiles fill the new desk", near( right, d2.width, 0.01 ) && near( bottom, d2.height, 0.01 ), { right, bottom, d2 } );
    await ev( "NayiveDesktop.untile()" ); await settle();
    check( "Untile after a resize: off again", await ev( "NayiveDesktop.isTiled()" ) === false );

    // ----- 8. Closing every window while tiled ends tiling; Tile on an empty desk does nothing
    await ev( "NayiveDesktop.tile()" ); await settle();
    await ev( "[].slice.call( document.querySelectorAll( '#tasks [data-win=\"close\"]' ) ).forEach( function ( x ) { x.click(); } ), true" );
    await settle();
    check( "Every window closed while tiled: tiling ends", await ev( "NayiveDesktop.windows().length === 0 && ! NayiveDesktop.isTiled()" ) === true );
    check( "Tile on an empty desk: false, stays off", await ev( "NayiveDesktop.tile()" ) === false && await ev( "NayiveDesktop.isTiled()" ) === false );
    check( "Empty desk: the switch is greyed and off", await ev( "document.getElementById( 'tileChk' ).disabled && document.getElementById( 'tileSw' ).classList.contains( 'idle' ) && ! document.getElementById( 'tileChk' ).checked" ) === true );

    // ----- 9. A press inside a frame INSIDE the window's page (Planner) brings it forward
    await go( "/nayive/fixture/box.html" );                 // off the desk first: it saves its windows on the way out
    await ev( `localStorage.setItem( 'balata-desktop-wins', ${JSON.stringify( JSON.stringify( [
        { url: "/nayive/fixture/nest.html",                l: "20px",  t: "20px", w: "600px", h: "420px" },
        { url: "/nayive/fixture/box.html?w=300&h=200&n=F", l: "700px", t: "20px", w: "500px", h: "400px" } ] ) )} ); true` );
    await go( "/nayive/desktop/index.html" );
    await waitFor( "window.NayiveDesktop && NayiveDesktop.windows && NayiveDesktop.windows().length === 2", 10000, "2 windows" );
    const nestAt = "[].filter.call( document.querySelectorAll( '#desk > .win' ), function ( w ) { return /nest\\.html/.test( w.querySelector( 'iframe' ).src ); } )[ 0 ]";
    const boxAt  = "[].filter.call( document.querySelectorAll( '#desk > .win' ), function ( w ) { return /n=F/.test( w.querySelector( 'iframe' ).src ); } )[ 0 ]";
    await waitFor( `( function () { try { return /^Box Inner/.test( ${nestAt}.querySelector( 'iframe' ).contentDocument.getElementById( 'inner' ).contentDocument.title ); } catch( e ) { return false; } } )()`, 10000, "inner frame loaded" );
    await settle();
    const frontName = () => ev( "document.querySelector( '#tasks .task.front span' ).textContent" );
    const fRect = await rectOf( boxAt ), nRect = await rectOf( nestAt );
    await click( fRect.left + fRect.width / 2, fRect.top + fRect.height - 30 );
    const f1 = await frontName();
    check( "Nested frames: a click on F puts F in front", /Box F/.test( f1 ), f1 );
    await click( nRect.left + nRect.width - 40, nRect.top + 200 );          // an empty spot of the INNER page
    const hitInner = await ev( `( function () { var d = ${nestAt}.querySelector( 'iframe' ).contentDocument.getElementById( 'inner' ).contentWindow; return d.clicks.length; } )()` );
    check( "Nested frames: the click landed in the inner page", hitInner > 0, hitInner );
    const f2 = await frontName();
    check( "Nested frames: a click in the inner page puts its window in front", /Nest/.test( f2 ), f2 );

    // ----- 10. My account's "New windows start with Scale on" (launcher, in the menu's frame)
    await ev( "NayiveDesktop.menu(); true" );
    await waitFor( "( function () { try { var d = document.querySelector( '.menu iframe' ).contentDocument; return d.documentElement.classList.contains( 'in-desktop' ) && !! d.getElementById( 'deskScaleChk' ); } catch( e ) { return false; } } )()", 10000, "launcher in the menu" );
    const md = "document.querySelector( '.menu iframe' ).contentDocument";
    check( "My account: the Scale default shows in desktop mode", await ev( `getComputedStyle( ${md}.getElementById( 'deskScaleWrap' ) ).display !== 'none'` ) === true );
    await ev( `( function () { var k = ${md}.getElementById( 'deskScaleChk' ); k.checked = true; k.dispatchEvent( new Event( 'change' ) ); return true; } )()` );
    check( "My account: ticked, it is stored for this device", await ev( "JSON.parse( localStorage.getItem( 'balata-desktop' ) ).scaleNew" ) === true );
    await ev( "NayiveDesktop.menu(); true" ); await settle();
    await ev( "NayiveDesktop.open( '/nayive/fixture/box.html?w=300&h=200&n=G' )" ); await settle();
    let nw = await ev( "NayiveDesktop.windows()" );
    check( "Scale default on: a new window starts with Scale on", nw[ nw.length - 1 ].scale === true, nw[ nw.length - 1 ] );
    check( "Scale default on: the windows restored keep their own", nw[ 0 ].scale === false && nw[ 1 ].scale === false );
    await ev( `( function () { var k = ${md}.getElementById( 'deskScaleChk' ); k.checked = false; k.dispatchEvent( new Event( 'change' ) ); return true; } )()` );
    await ev( "NayiveDesktop.open( '/nayive/fixture/box.html?w=300&h=200&n=H' )" ); await settle();
    nw = await ev( "NayiveDesktop.windows()" );
    check( "Scale default off: a new window starts with Resize", nw[ nw.length - 1 ].scale === false, nw[ nw.length - 1 ] );

    const bad = c.logs.filter( l => /^EXCEPTION/.test( l ) );
    check( "no page errors", bad.length === 0, bad );
}
catch( e ) { fails++; console.log( "FAIL (stopped) " + e.message ); }
finally { b.kill(); srv.close(); }

console.log( ( fails ? "FAILED " : "OK " ) + passes + " passed, " + fails + " failed" );
process.exit( fails ? 1 : 0 );
