/*
 * tablet.mjs - the desktop on a tablet (docs/desktop-tablet-plan.md), in the
 * real launcher and desktop pages, in headless Chromium:
 *     node tools/desktop-test/tablet.mjs [shots-dir]
 *
 *   1. "Open the desktop": Auto / Always / Never, in the launcher's <head>,
 *      the desktop's "⋮" and My account.
 *   2. The mouse chip: a mouse taken away / plugged in offers the other view.
 *   3. Upright: a touch screen under 1024px wide tiles by itself, and goes
 *      back to Free when wide again (only if it did the tiling).
 *   4. Touch: finger-sized buttons and bar, a long press opens the "⋮".
 *   5. The on-screen keyboard: the window in front gets shorter, then back.
 *
 * Headless Chromium cannot plug a mouse in or pop a keyboard up, so two stubs
 * go in before every page (Page.addScriptToEvaluateOnNewDocument), each only
 * when the test asks for it in localStorage: `__ptr` answers every
 * "(any-pointer: ...)" media query and __setPtr() flips it (firing "change",
 * as a real plug would); `__vv` puts in a visualViewport whose height __kb()
 * lowers by a keyboard's height. Served as run.mjs serves it; nothing is
 * written into client/apps.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, attach } from "../cdp.mjs";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const APPS = path.resolve( here, "../../client/apps" );
const SHOTS = process.argv[ 2 ] || "";

const BOX = `<!doctype html><html><head><meta charset="utf-8"><title>Box</title>
<style>body{margin:0;font:14px sans-serif}</style></head>
<body><input id="field" style="margin-top:500px"><script>
document.title = 'Box ' + ( new URLSearchParams( location.search ).get( 'n' ) || '' );
</script></body></html>`;
// A page with an app's top row (adoptHead takes it as the title bar).
const HEAD = `<!doctype html><html><head><meta charset="utf-8"><title>Head</title></head>
<body style="margin:0"><div class="topbar" style="height:44px"><span class="app-icon">A</span> Head</div></body></html>`;

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
        if( rel === "fixture/box.html" )  { res.writeHead( 200, { "Content-Type": "text/html" } ).end( BOX ); return; }
        if( rel === "fixture/head.html" ) { res.writeHead( 200, { "Content-Type": "text/html" } ).end( HEAD ); return; }
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

// The two stubs (see the top). Every frame gets them; the pointer state is
// shared through localStorage, so a frame made later agrees with the page.
const STUBS = `( function ()
{
    var P = null;
    try { P = JSON.parse( localStorage.getItem( '__ptr' ) || 'null' ); } catch( e ) {}
    if( P )
    {
        var real = window.matchMedia.bind( window ), list = [];
        var ask = function ( q )
        {
            var fine = /any-pointer:\\s*fine/.test( q ), coarse = /any-pointer:\\s*coarse/.test( q );
            var rest = q.replace( /\\s*and\\s*\\(any-pointer:[^)]*\\)/g, '' ).replace( /\\(any-pointer:[^)]*\\)\\s*(and\\s*)?/g, '' ).trim();
            return ( rest ? real( rest ).matches : true ) && ( ! fine || P.fine ) && ( ! coarse || P.coarse );
        };
        window.matchMedia = function ( q )
        {
            if( ! /any-pointer/.test( q ) ) return real( q );
            var m = new EventTarget();
            m.media = q;
            Object.defineProperty( m, 'matches', { get: function () { return ask( q ); } } );
            m.addListener = function ( f ) { m.addEventListener( 'change', f ); };
            m.removeListener = function ( f ) { m.removeEventListener( 'change', f ); };
            m._was = ask( q );
            list.push( m );
            return m;
        };
        window.__setPtr = function ( fine, coarse )
        {
            P = { fine: fine, coarse: coarse };
            localStorage.setItem( '__ptr', JSON.stringify( P ) );
            list.forEach( function ( m ) { var v = ask( m.media ); if( v !== m._was ) { m._was = v; m.dispatchEvent( new Event( 'change' ) ); } } );
        };
    }
    if( window.top === window && localStorage.getItem( '__vv' ) )
    {
        var v = new EventTarget();
        v.offsetTop = 0; v.offsetLeft = 0; v.scale = 1;
        Object.defineProperty( v, 'width', { get: function () { return window.innerWidth; } } );
        var kb = 0;
        Object.defineProperty( v, 'height', { get: function () { return window.innerHeight - kb; } } );
        Object.defineProperty( window, 'visualViewport', { value: v, configurable: true } );
        window.__kb = function ( h ) { kb = h; v.dispatchEvent( new Event( 'resize' ) ); };
    }
} )();`;

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
    await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: STUBS } );
    await c.send( "Page.bringToFront" );

    const ev = ( e, ms ) => c.evaluate( e, ms );
    const view = ( width, height ) => c.send( "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false } );
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
    const settle = () => ev( "new Promise( r => requestAnimationFrame( () => requestAnimationFrame( () => requestAnimationFrame( () => setTimeout( r, 60 ) ) ) ) )" );
    async function go( p )
    {
        await c.send( "Page.navigate", { url: ORIGIN + p } );
        await waitFor( `location.pathname + '|' + document.readyState === ${JSON.stringify( p.split( "?" )[ 0 ] + "|complete" )}` );
    }
    // Where a page ends up: given time to send itself on.
    async function landsOn( p )
    {
        await c.send( "Page.navigate", { url: ORIGIN + p } );
        await sleep( 1200 );
        await waitFor( "document.readyState === 'complete'" );
        return ev( "location.pathname" );
    }
    const path_ = () => ev( "location.pathname" );
    const LAUNCHER = "/nayive/index.html", DESKTOP = "/nayive/desktop/";
    const atDesk = p => p === DESKTOP || p === "/nayive/desktop/index.html";
    async function shot( name )
    {
        if( ! SHOTS ) return;
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    }
    // The device's state, set from a page of the origin before the next navigate.
    async function device( { fine, coarse, mode, vv = false, wins = null, tile = null } )
    {
        await ev( `( function () {
            localStorage.setItem( 'balata-coach-seen', '1' );
            localStorage.setItem( 'nayive-install-snooze', 'never' );
            localStorage.setItem( 'balata-intro-dismiss:launcher', '1' );
            localStorage.setItem( 'balata-intro-dismiss:desktop', '1' );
            localStorage.setItem( '__ptr', ${JSON.stringify( JSON.stringify( { fine, coarse } ) )} );
            if( ${vv} ) localStorage.setItem( '__vv', '1' ); else localStorage.removeItem( '__vv' );
            var s = JSON.parse( localStorage.getItem( 'balata-desktop' ) || '{}' );
            ${mode ? `s.mode = ${JSON.stringify( mode )};` : "delete s.mode;"}
            localStorage.setItem( 'balata-desktop', JSON.stringify( s ) );
            localStorage.setItem( 'balata-desktop-wins', ${JSON.stringify( JSON.stringify( wins || [] ) )} );
            ${tile ? `localStorage.setItem( 'balata-desktop-tile', ${JSON.stringify( JSON.stringify( tile ) )} );` : "localStorage.removeItem( 'balata-desktop-tile' );"}
            return true; } )()` );
    }
    const wins = () => ev( "JSON.stringify( NayiveDesktop.windows() )" ).then( JSON.parse );
    const winRect = i => ev( `JSON.stringify( document.querySelectorAll( '#desk > .win' )[ ${i} ].getBoundingClientRect() )` ).then( JSON.parse );
    const deskReady = n => waitFor( `window.NayiveDesktop && NayiveDesktop.windows && NayiveDesktop.windows().length === ${n}`, 10000, n + " windows" );

    await view( 1194, 834 );
    await go( "/nayive/fixture/box.html" );

    // ===== 1. OPEN THE DESKTOP =====
    await device( { fine: false, coarse: true } );
    check( "Auto, finger only (tablet, wide): the simple view", await landsOn( LAUNCHER ) === LAUNCHER );
    await device( { fine: false, coarse: true, mode: "always" } );
    check( "Always, finger only, wide: the desktop", atDesk( await landsOn( LAUNCHER ) ) );
    await view( 834, 1194 );
    check( "Always, finger only, upright: the desktop", atDesk( await landsOn( LAUNCHER ) ) );
    await view( 400, 800 );
    check( "Always on a phone: the simple view", await landsOn( LAUNCHER ) === LAUNCHER );
    await view( 1194, 834 );
    await device( { fine: true, coarse: true, mode: "never" } );
    check( "Never, with a mouse: the simple view", await landsOn( LAUNCHER ) === LAUNCHER );
    await device( { fine: true, coarse: true, mode: "auto" } );
    check( "Auto, with a mouse: the desktop (as before)", atDesk( await landsOn( LAUNCHER ) ) );
    await device( { fine: true, coarse: false } );
    check( "No mode saved, PC with a mouse: the desktop (as before)", atDesk( await landsOn( LAUNCHER ) ) );

    // The desktop's "⋮" no longer holds the choice (one knob: My account), and
    // the desktop follows a change made in My account inside one of its windows.
    await device( { fine: true, coarse: true, mode: "auto" } );
    await go( "/nayive/desktop/index.html" );
    await deskReady( 0 );
    check( "⋮ menu: no Open the desktop row", await ev( "! document.getElementById( 'setMode' )" ) === true );
    const myAccountSets = m => ev( "( function () { var c = JSON.parse( localStorage.getItem( 'balata-desktop' ) || '{}' ); c.mode = '" + m + "'; localStorage.setItem( 'balata-desktop', JSON.stringify( c ) ); window.dispatchEvent( new StorageEvent( 'storage', { key: 'balata-desktop' } ) ); return true; } )()" );
    await myAccountSets( "always" );
    await sleep( 400 );
    check( "Desktop: Always (from My account) keeps the desktop", atDesk( await path_() ) );
    await myAccountSets( "never" );
    await sleep( 1500 );
    check( "Desktop: Never (from My account) goes to the simple view, and stays", await path_() === LAUNCHER, await path_() );
    check( "Desktop: Never is stored for this device", await ev( "JSON.parse( localStorage.getItem( 'balata-desktop' ) ).mode" ) === "never" );

    // My account (the simple view): the same choice; Always goes to the desktop.
    await waitFor( "window.NayiveUI && document.documentElement.style.visibility !== 'hidden'", 8000, "launcher ready" );
    await ev( "document.getElementById( 'accountBtn' ).click(); true" );
    await waitFor( "document.getElementById( 'pwBackdrop' ).classList.contains( 'open' )", 5000, "My account open" );
    check( "My account: Open the desktop shows on a big screen", await ev( "! document.getElementById( 'deskModeWrap' ).hidden && document.getElementById( 'deskModeWrap' ).offsetHeight > 0" ) === true );
    check( "My account: it says Never", await ev( "document.getElementById( 'deskModeSel' ).value" ) === "never" );
    await shot( "account-mode" );
    await ev( "( function () { var s = document.getElementById( 'deskModeSel' ); s.value = 'always'; s.dispatchEvent( new Event( 'change' ) ); return true; } )()" );
    await sleep( 1500 );
    check( "My account: Always goes to the desktop", atDesk( await path_() ), await path_() );
    // In the desktop's own menu the row shows (the only place for it); a change
    // there is stored, and the menu's page does not turn into a desktop.
    await deskReady( 0 );
    await ev( "NayiveDesktop.menu(); true" );
    const md = "document.querySelector( '.menu iframe' ).contentDocument";
    await waitFor( `( function () { try { return ${md}.documentElement.classList.contains( 'in-desktop' ) && !! ${md}.defaultView.NayiveUI; } catch( e ) { return false; } } )()`, 10000, "launcher in the menu" );
    await ev( `${md}.getElementById( 'accountBtn' ).click(); true` );
    await waitFor( `${md}.getElementById( 'pwBackdrop' ).classList.contains( 'open' )`, 5000, "My account open in the menu" );
    check( "My account in the desktop's menu: Open the desktop shows", await ev( `${md}.getElementById( 'deskModeWrap' ).hidden` ) === false );
    await ev( `( function () { var s = ${md}.getElementById( 'deskModeSel' ); s.value = 'auto'; s.dispatchEvent( new Event( 'change' ) ); return true; } )()` );
    await sleep( 600 );
    check( "My account in the desktop's menu: Auto is stored, the desktop stays", atDesk( await path_() ) && await ev( "JSON.parse( localStorage.getItem( 'balata-desktop' ) ).mode" ) === "auto" );
    check( "My account in the desktop's menu: its page stays the launcher", await ev( `! /desktop\\//.test( ${md}.defaultView.location.pathname )` ) === true );
    await ev( `${md}.defaultView.NayiveUI.close( 'pwBackdrop' ); true` );
    await settle();

    // ===== 2. THE MOUSE CHIP =====
    await device( { fine: true, coarse: true, mode: "auto" } );
    await go( "/nayive/desktop/index.html" );
    await deskReady( 0 );
    await waitFor( "!! window.NayiveUI", 5000, "ui.js" );
    await ev( "__setPtr( false, true ); true" );
    await settle();
    check( "Mouse taken away (Auto): the chip asks to go back", await ev( "document.getElementById( 'toast' ).classList.contains( 'show' ) && !! document.querySelector( '#toast .toast-undo' )" ) === true,
           await ev( "document.getElementById( 'toast' ).textContent" ) );
    check( "...still on the desktop: nothing moves on its own", atDesk( await path_() ) );
    await shot( "chip-simple" );
    await ev( "document.querySelector( '#toast .toast-undo' ).click(); true" );
    await sleep( 1500 );
    check( "The chip's button: the simple view (and it stays)", await path_() === LAUNCHER, await path_() );
    await waitFor( "!! window.NayiveUI", 5000, "ui.js" );
    await ev( "__setPtr( true, true ); true" );
    await settle();
    check( "Mouse plugged in (Auto, simple view): the chip offers the desktop", await ev( "document.getElementById( 'toast' ).classList.contains( 'show' ) && !! document.querySelector( '#toast .toast-undo' )" ) === true );
    await ev( "document.querySelector( '#toast .toast-undo' ).click(); true" );
    await sleep( 1200 );
    check( "The chip's button: the desktop", atDesk( await path_() ), await path_() );
    // Always: no chip.
    await device( { fine: true, coarse: true, mode: "always" } );
    await go( "/nayive/desktop/index.html" );
    await deskReady( 0 );
    await waitFor( "!! window.NayiveUI", 5000, "ui.js" );
    await ev( "__setPtr( false, true ); true" );
    await settle();
    check( "Mouse taken away (Always): no chip", await ev( "document.getElementById( 'toast' ).classList.contains( 'show' )" ) === false );

    // ===== 3. UPRIGHT -> TILE =====
    const open2 = async () => { await ev( "NayiveDesktop.open( '/nayive/fixture/box.html?n=A' ); NayiveDesktop.open( '/nayive/fixture/box.html?n=B' ); true" ); await settle(); };
    await view( 834, 1194 );
    await device( { fine: false, coarse: true, mode: "always" } );
    await go( "/nayive/desktop/index.html" );
    await deskReady( 0 );
    await settle();
    check( "Upright, empty desk: nothing to tile yet", await ev( "NayiveDesktop.isTiled()" ) === false );
    await open2();
    let ws = await wins();
    check( "Upright: the windows are tiled by themselves", await ev( "NayiveDesktop.isTiled()" ) === true && ws.every( w => w.tiled ), ws );
    const r0 = await winRect( 0 ), r1 = await winRect( 1 );
    check( "Upright: side by side, not on top of each other", r0.bottom <= r1.top + 1 || r1.bottom <= r0.top + 1 || r0.right <= r1.left + 1 || r1.right <= r0.left + 1, [ r0, r1 ] );
    await shot( "upright-tiled" );
    await view( 1194, 834 ); await settle(); await settle();
    check( "Wide again: back to Free", await ev( "NayiveDesktop.isTiled()" ) === false );
    ws = await wins();
    check( "Wide again: the windows where a new window opens", ws.every( w => ! w.tiled && w.box.w > 500 ), ws );
    await view( 834, 1194 ); await settle(); await settle();
    check( "Upright again: tiled again", await ev( "NayiveDesktop.isTiled()" ) === true );
    await ev( "NayiveDesktop.untile(); true" ); await settle();
    await view( 834, 1100 ); await settle(); await settle();
    check( "Free picked by hand while upright: stays Free", await ev( "NayiveDesktop.isTiled()" ) === false );
    await view( 1194, 834 ); await settle(); await settle();
    await ev( "NayiveDesktop.tile(); true" ); await settle();
    await view( 834, 1194 ); await settle(); await settle();
    check( "Tiled by hand, then upright: tiled", await ev( "NayiveDesktop.isTiled()" ) === true );
    await view( 1194, 834 ); await settle(); await settle();
    check( "Tiled by hand: wide again, still tiled", await ev( "NayiveDesktop.isTiled()" ) === true );
    await ev( "NayiveDesktop.untile(); true" ); await settle();
    // Tiled upright, reloaded wide: Free.
    await view( 834, 1194 ); await settle(); await settle();
    check( "(upright: tiled)", await ev( "NayiveDesktop.isTiled()" ) === true );
    await sleep( 400 );                                          // the windows are saved a moment after a change
    check( "Tiled upright: saved as done by itself", await ev( "JSON.parse( localStorage.getItem( 'balata-desktop-tile' ) ).auto" ) === true );
    await go( "/nayive/fixture/box.html" );
    await view( 1194, 834 );
    await go( "/nayive/desktop/index.html" );
    await deskReady( 2 ); await settle();
    check( "Tiled upright, reloaded wide: Free", await ev( "NayiveDesktop.isTiled()" ) === false );
    // All closed while upright: the next window is tiled too.
    await view( 834, 1194 ); await settle(); await settle();
    await ev( "[].slice.call( document.querySelectorAll( '#tasks [data-win=\"close\"]' ) ).forEach( function ( x ) { x.click(); } ), true" ); await settle();
    await ev( "NayiveDesktop.open( '/nayive/fixture/box.html?n=C' ); true" ); await settle();
    check( "Upright, every window closed, a new one: tiled", await ev( "NayiveDesktop.isTiled()" ) === true );
    // A PC (no touch screen): never.
    await view( 1194, 834 ); await settle(); await settle();
    await ev( "__setPtr( true, false ); true" ); await settle();
    await view( 834, 1194 ); await settle(); await settle();
    check( "A PC narrower than 1024px: no tiling by itself", await ev( "NayiveDesktop.isTiled()" ) === false );

    // ===== 4. TOUCH =====
    await view( 1194, 834 );
    await device( { fine: true, coarse: true, mode: "auto", wins: [ { url: "/nayive/fixture/head.html", l: "100px", t: "60px", w: "600px", h: "400px" } ] } );
    await go( "/nayive/desktop/index.html" );
    await deskReady( 1 ); await settle();
    check( "Touch screen: body.touch", await ev( "document.body.classList.contains( 'touch' )" ) === true );
    check( "Touch screen: the bar is at least 56px", await ev( "document.getElementById( 'bar' ).offsetHeight" ) >= 56 );
    check( "Touch screen: the window's buttons are 36px", await ev( "document.querySelector( '.task.front .task-x' ).offsetWidth" ) === 36 );
    check( "Touch screen: the resize edge is 20px", await ev( "document.querySelector( '.grip.e' ).offsetWidth" ) === 20 );
    await waitFor( "document.querySelector( '#desk > .win' ).classList.contains( 'chromeless' )", 5000, "app row adopted" );
    check( "Touch: the app's own top row takes no scroll (a finger drags the window)",
           await ev( "document.querySelector( '#desk > .win iframe' ).contentDocument.querySelector( '.topbar' ).style.touchAction" ) === "none" );
    check( "Touch: our own title bar and edges take no scroll", await ev( "getComputedStyle( document.querySelector( '.win-bar' ) ).touchAction === 'none' && getComputedStyle( document.querySelector( '.grip' ) ).touchAction === 'none'" ) === true );
    await shot( "touch-bar" );
    // Long press on an empty spot of the desk = right-click.
    const press = ( type, kind ) => `document.getElementById( 'desk' ).dispatchEvent( new PointerEvent( '${type}', { bubbles: true, pointerType: '${kind}', pointerId: 7, clientX: 1000, clientY: 600, button: 0 } ) )`;
    await ev( press( "pointerdown", "touch" ) ); await sleep( 200 ); await ev( press( "pointerup", "touch" ) ); await sleep( 600 );
    check( "A short tap: no menu", await ev( "document.getElementById( 'moreMenu' ).hidden" ) === true );
    await ev( press( "pointerdown", "touch" ) ); await sleep( 750 );
    check( "A long press: the ⋮ menu opens", await ev( "document.getElementById( 'moreMenu' ).hidden" ) === false );
    await ev( press( "pointerup", "touch" ) + "; document.getElementById( 'desk' ).dispatchEvent( new MouseEvent( 'click', { bubbles: true } ) ); true" );
    check( "...and the lift's click does not close it again", await ev( "document.getElementById( 'moreMenu' ).hidden" ) === false );
    await sleep( 50 );
    await ev( "document.getElementById( 'desk' ).dispatchEvent( new MouseEvent( 'click', { bubbles: true } ) ); true" );
    check( "A later click closes it, as always", await ev( "document.getElementById( 'moreMenu' ).hidden" ) === true );
    await ev( press( "pointerdown", "mouse" ) ); await sleep( 750 ); await ev( press( "pointerup", "mouse" ) );
    check( "A mouse held down: no menu (it has its right button)", await ev( "document.getElementById( 'moreMenu' ).hidden" ) === true );
    await ev( "__setPtr( true, false ); true" ); await settle();
    check( "No touch screen (a PC): no body.touch, the bar as set", await ev( "! document.body.classList.contains( 'touch' ) && document.getElementById( 'bar' ).offsetHeight" ) === 48 );
    check( "No touch screen: the window's buttons as before (22px)", await ev( "document.querySelector( '.task.front .task-x' ).offsetWidth" ) === 22 );

    // ===== 5. THE ON-SCREEN KEYBOARD =====
    const W1 = { url: "/nayive/fixture/box.html?n=K", l: "100px", t: "100px", w: "600px", h: "600px" };
    const W2 = { url: "/nayive/fixture/box.html?n=L", l: "720px", t: "40px",  w: "400px", h: "300px" };
    await device( { fine: false, coarse: true, mode: "always", vv: true, wins: [ W2, W1 ] } );     // K last = in front
    await go( "/nayive/desktop/index.html" );
    await deskReady( 2 ); await settle();
    const deskTop = await ev( "document.getElementById( 'desk' ).getBoundingClientRect().top" );
    const before = await winRect( 1 );
    await ev( "__kb( 350 ); true" ); await settle();
    const edge = 834 - 350;
    let kr = await winRect( 1 );
    check( "Keyboard up: the window in front ends at its edge", near( kr.bottom, edge, 2 ) && near( kr.top, before.top, 1 ), { kr, edge } );
    ws = await wins();
    check( "Keyboard up: its real size is kept (saved, restored)", near( ws[ 1 ].box.h, 600 ) && near( ws[ 1 ].box.t, 100 - 0 ), ws[ 1 ].box );
    check( "Keyboard up: the window behind is left alone", near( ( await winRect( 0 ) ).height, 300 + 0, 1 ) );
    await shot( "keyboard" );
    await sleep( 400 );
    check( "Keyboard up: the saved size is the real one", await ev( "JSON.parse( localStorage.getItem( 'balata-desktop-wins' ) ).filter( r => /n=K/.test( r.url ) )[ 0 ].h" ) === "600px" );
    await ev( "__kb( 0 ); true" ); await settle();
    kr = await winRect( 1 );
    check( "Keyboard gone: the window gets its size back", near( kr.height, before.height, 1 ) && near( kr.top, before.top, 1 ), kr );
    // A window low on the desk moves up, so it keeps some height.
    await ev( "__kb( 500 ); true" ); await settle();
    kr = await winRect( 1 );
    check( "A tall keyboard: the window moves up to keep 240px", near( kr.bottom, 834 - 500, 2 ) && near( kr.height, 240, 2 ) && kr.top < before.top, kr );
    await ev( "__kb( 0 ); true" ); await settle();
    kr = await winRect( 1 );
    check( "...and goes back where it was", near( kr.top, before.top, 1 ) && near( kr.height, before.height, 1 ), kr );
    // Another window comes to the front while the keyboard is up.
    await ev( "__kb( 350 ); true" ); await settle();
    await ev( "document.querySelectorAll( '#tasks .task' )[ 0 ].click(); true" ); await settle();
    check( "Front changes: the old one gets its size back", near( ( await winRect( 1 ) ).height, 600, 1 ) );
    check( "Front changes: the new one is clear of the keyboard (it already was)", ( await winRect( 0 ) ).bottom <= edge + 1 );
    await ev( "__kb( 0 ); true" ); await settle();
    // Maximised.
    await ev( "document.querySelectorAll( '#tasks .task' )[ 1 ].click(); true" ); await settle();
    await ev( "document.querySelector( '.task.front [data-win=\"max\"]' ).click(); true" ); await settle();
    await ev( "__kb( 350 ); true" ); await settle();
    kr = await winRect( 1 );
    check( "Maximised, keyboard up: it ends at the keyboard's edge", near( kr.bottom, edge, 2 ) && near( kr.top, deskTop, 1 ), kr );
    await ev( "__kb( 0 ); true" ); await settle();
    const deskH = await ev( "document.getElementById( 'desk' ).clientHeight" );
    kr = await winRect( 1 );
    check( "Maximised, keyboard gone: the whole desk again", near( kr.height, deskH, 1 ), { kr, deskH } );
    await ev( "document.querySelector( '.task.front [data-win=\"max\"]' ).click(); true" ); await settle();
    // Scale on, shrunk: still ends at the edge.
    await ev( "NayiveDesktop.scale( 1, true ); true" ); await settle();
    const wsS = await wins();
    await ev( "__kb( 350 ); true" ); await settle();
    kr = await winRect( 1 );
    check( "Scale on, keyboard up: it ends at the keyboard's edge", near( kr.bottom, edge, 2 ), { kr, s: wsS[ 1 ].factor } );
    await ev( "__kb( 0 ); true" ); await settle();
    check( "Scale on, keyboard gone: its size back", near( ( await winRect( 1 ) ).height, 600, 1 ) );

    const bad = c.logs.filter( l => /^EXCEPTION/.test( l ) );
    check( "no page errors", bad.length === 0, bad );
}
catch( e ) { fails++; console.log( "FAIL (stopped) " + e.message ); }
finally { await b.kill(); srv.close(); }

console.log( ( fails ? "FAILED " : "OK " ) + passes + " passed, " + fails + " failed" );
process.exit( fails ? 1 : 0 );
