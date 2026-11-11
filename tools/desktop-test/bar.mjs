/*
 * bar.mjs - the desktop's bar and its popups on Ayni (family 12), in the real
 * desktop page, in headless Chromium:
 *     node tools/desktop-test/bar.mjs [shots-dir]
 *
 *   1. RULES: Ayni's taskbar and its look only (no ayni-desktop.js), none of
 *      the old bar, light and dark.
 *   2. Chips: real buttons, the front one names its document, the marks on
 *      them, closing still asks the page.
 *   3. The bar on its 4 edges, its height, kept over a reload.
 *   4. The "⋮": opening, closing, the focus in a window's frame, what it saves.
 *   5. The Free / Tile switch.  6. The month.  7. The countdown chips.
 *   8. The weather.  9. Languages.
 *
 * Served as run.mjs serves it; nothing is written into client/apps. Real mouse
 * and keys, so a press in a frame is what a person does. ONLY=chips,month runs
 * those parts. DESK_PAGE=<file> serves that file as the desktop page (to try a
 * broken copy, without touching the real one).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, attach } from "../cdp.mjs";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const APPS = path.resolve( here, "../../client/apps" );
const SHOTS = process.argv[ 2 ] || "";
const ONLY = ( process.env.ONLY || "" ).split( "," ).filter( Boolean );
const want = part => ! ONLY.length || ONLY.includes( part );

const BOX = `<!doctype html><html><head><meta charset="utf-8"><title>Box</title>
<style>body{margin:0;font:14px sans-serif}</style></head>
<body><input id="field" style="margin:60px"><script>
document.title = 'Box ' + ( new URLSearchParams( location.search ).get( 'n' ) || '' );
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
        if( /(^|\/)box\.html$/.test( rel ) ) { res.writeHead( 200, { "Content-Type": "text/html" } ).end( BOX ); return; }
        const file = rel === "desktop/index.html" && process.env.DESK_PAGE ? process.env.DESK_PAGE : path.resolve( APPS, rel );
        fs.readFile( file, ( err, body ) =>
        {
            if( err ) { res.writeHead( 404 ).end(); return; }
            res.writeHead( 200, { "Content-Type": TYPES[ path.extname( file ) ] || "application/octet-stream", "Cache-Control": "no-store" } ).end( body );
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
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const srv = await serve();
const b = await browser();
const ORIGIN = `http://127.0.0.1:${srv.port}`, DESK = "/nayive/desktop/", W = 1366, H = 800;
try
{
    const tab = await b.newTab( "about:blank" );
    const c = await attach( tab.webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Page.bringToFront" );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false } );
    await c.send( "Emulation.setFocusEmulationEnabled", { enabled: true } );

    const ev = ( e, ms ) => c.evaluate( e, ms );
    async function until( expr, ms = 6000 )
    {
        const end = Date.now() + ms;
        for( ;; )
        {
            let v = null;
            try { v = await ev( expr ); } catch {}
            if( v ) return v;
            if( Date.now() > end ) return v;
            await sleep( 40 );
        }
    }
    const settle = () => ev( "new Promise( r => requestAnimationFrame( () => requestAnimationFrame( () => setTimeout( r, 60 ) ) ) )" );
    async function shot( name )
    {
        if( ! SHOTS ) return;
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, "bar-" + name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    }
    const mouse = ( type, x, y, button = "left", buttons = 0 ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : button, buttons, clickCount: 1 } );
    const clickAt = async ( x, y, button = "left" ) =>
    {
        await mouse( "mouseMoved", x, y );
        await mouse( "mousePressed", x, y, button, button === "right" ? 2 : 1 );
        await mouse( "mouseReleased", x, y, button );
        await settle();
    };
    const box = sel => ev( `( function () { var r = document.querySelector( ${JSON.stringify( sel )} ).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; } )()` );
    const press = async ( sel, button ) => { const r = await box( sel ); await clickAt( r.l + r.w / 2, r.t + r.h / 2, button ); };
    const key = async k =>
    {
        const code = { Escape: 27, Enter: 13 }[ k ];
        await c.send( "Input.dispatchKeyEvent", Object.assign( { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code }, k === "Enter" ? { text: "\r" } : {} ) );
        await c.send( "Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code } );
        await settle();
    };
    const open = id => ev( `document.getElementById( '${id}' ).matches( ':popover-open' )` );
    const shut = async () => { await ev( "( document.querySelectorAll( '[popover]' ).forEach( function ( p ) { if( p.matches( ':popover-open' ) ) p.hidePopover(); } ), true )" ); await settle(); };
    const FRONT = ".chip[aria-current=true]";
    const NAME = i => `#tasks > .chip:nth-child( ${i} )`;
    const frontName = () => ev( `document.querySelector( '${FRONT} .chip-main span:not(.icon)' ).textContent` );
    const off = ( e, p, r ) => ( e === "bottom" ? p.b <= r.t : e === "top" ? p.t >= r.b : e === "left" ? p.l >= r.r : p.r <= r.l );
    const frame = i => `document.querySelectorAll( '#desk > .win iframe' )[ ${i} ]`;
    const fieldIn = async i => { const f = await ev( `( function () { var r = ${frame( i )}.getBoundingClientRect(); return [ r.left, r.top ]; } )()` ); return [ f[ 0 ] + 90, f[ 1 ] + 72 ]; };
    const pick = async ( id, v ) => { await ev( `( Ayni.picker( document.getElementById( '${id}' ) ).choose( ${JSON.stringify( v )} ), true )` ); await settle(); };
    const flip = async id => { const r = await box( `#${id}` ); await clickAt( r.l + r.w / 2, r.t + r.h / 2 ); };

    async function desk( n = 0, settings = {}, url = i => `/nayive/fixture/box.html?n=${ "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[ i ] }` )
    {
        await c.send( "Page.navigate", { url: ORIGIN + "/nayive/fixture/box.html" } );
        await until( "document.readyState === 'complete'" );
        await ev( `( localStorage.clear(), localStorage.setItem( 'balata-coach-seen', '1' ), localStorage.setItem( 'nayive-install-snooze', 'never' ),
                     localStorage.setItem( 'balata-intro-dismiss:launcher', '1' ),
                     localStorage.setItem( 'balata-desktop', ${JSON.stringify( JSON.stringify( Object.assign( { mode: "always" }, settings ) ) )} ), true )` );
        await reload();
        for( let i = 0; i < n; i++ ) await openWin( url( i ) );
    }
    async function reload()
    {
        await c.send( "Page.navigate", { url: ORIGIN + DESK } );
        await until( "window.AyniDesk && window.Ayni && document.readyState === 'complete'" );
        await ev( "Ayni.ready" ); await settle();
    }
    const openWin = async u =>
    {
        const n = await ev( "AyniDesk.windows().length" );
        await ev( `AyniDesk.open( ${JSON.stringify( u )} )` );
        await until( `AyniDesk.windows().length === ${n + 1} && ${frame( n )}.contentDocument && ${frame( n )}.contentDocument.readyState === 'complete'` );
        await settle();
    };

    // ----- 1. RULES ----------------------------------------------------------
    if( want( "rules" ) )
    {
        for( const theme of [ "light", "dark" ] )
        {
            await c.send( "Emulation.setEmulatedMedia", { features: [ { name: "prefers-color-scheme", value: theme } ] } );
            await desk( 2 );
            await press( "#moreBtn" );
            const o = await ev( `( function () { var o = [], q = function ( s ) { return document.querySelector( s ); };
                if( ! [].some.call( document.styleSheets, function ( s ) { return /ayni-desktop\\.css$/.test( s.href || '' ); } ) ) o.push( 'no ayni-desktop.css' );
                if( [].some.call( document.scripts, function ( s ) { return /ayni-desktop\\.js$/.test( s.src ); } ) || Ayni.windows ) o.push( 'ayni-desktop.js loaded' );
                if( ! q( '.desktop[data-edge][data-mode="app"] > main.area#desk' ) || ! q( '.desktop > nav.taskbar#bar > .chips#tasks' ) || ! q( '#bar > .widgets' ) ) o.push( 'not Ayni\\'s bar' );
                [ '.top-menu', '.menu-item', '.menu-sep', '.menu-label', '.task', '.task-x', '.task-ctl', '.tile-word', '.tile-sw', '#calYear', '#calGrid', '.bar' ].forEach( function ( s ) { if( q( s ) ) o.push( 'old: ' + s ); } );
                if( NayiveUI.wireMenu ) o.push( 'NayiveUI.wireMenu is back' );
                if( q( '#bar button button, #bar button [role="button"], #bar [role="button"]' ) ) o.push( 'a button inside a button' );
                [].forEach.call( document.querySelectorAll( '#bar button:not([hidden])' ), function ( b )
                { if( ! b.closest( '[hidden]' ) && ! ( b.getAttribute( 'aria-label' ) || b.textContent.trim() || b.dataset.tip || b.querySelector( 'img' ) ) ) o.push( 'unnamed: ' + b.outerHTML.slice( 0, 60 ) ); } );
                var m = q( '#moreMenu' );
                if( m.getAttribute( 'role' ) === 'menu' ) o.push( 'inputs in a role=menu' );
                if( ! m.matches( '.panel.popup.controls.tall' ) || ! m.getAttribute( 'aria-label' ) ) o.push( 'the ⋮ is not Ayni\\'s popup' );
                if( m.scrollWidth > m.clientWidth ) o.push( 'the ⋮ scrolls sideways' );
                var raw = ( document.body.innerText + m.innerText ).match( /\\b(ayni|desktop|ui|acct)\\.[a-z][\\w.]*/ );
                if( raw ) o.push( 'raw key: ' + raw[ 0 ] );
                var p = document.createElement( 'i' ); p.style.background = 'var(--desk-bar)'; q( '.desktop' ).appendChild( p );
                if( getComputedStyle( q( '#bar' ) ).backgroundColor !== getComputedStyle( p ).backgroundColor ) o.push( 'the bar is not on the desk colours' ); p.remove();
                return o; } )()` );
            check( `rules, ${theme}`, o.length === 0, o );
            await shot( "more-" + theme );
        }
        await c.send( "Emulation.setEmulatedMedia", { features: [ { name: "prefers-color-scheme", value: "light" } ] } );
    }

    // ----- 2. CHIPS ----------------------------------------------------------
    if( want( "chips" ) )
    {
        await desk( 3 );
        check( "one chip per window, the last opened in front", await ev( "document.querySelectorAll( '#tasks > .chip' ).length" ) === 3 && await frontName() === "Box C", await frontName() );
        check( "only one chip is the front one", await ev( "document.querySelectorAll( '#tasks > .chip[aria-current]' ).length" ) === 1 );
        check( "the front chip shows the document's name", await ev( `getComputedStyle( document.querySelector( '${FRONT} .chip-main span:not(.icon)' ) ).display !== 'none'` ) );
        check( "...the others only their icon", await ev( `getComputedStyle( document.querySelector( '${NAME( 1 )} .chip-main span:not(.icon)' ) ).display === 'none'` ) );
        check( "...their name is in the tooltip and the group's label", await ev( `/Box A/.test( document.querySelector( '${NAME( 1 )} .chip-main' ).dataset.tip ) && document.querySelector( '${NAME( 1 )}' ).getAttribute( 'aria-label' ) === 'Box A'` ) );
        await press( `${NAME( 2 )} .chip-main` );
        check( "a click brings its window to the front", await frontName() === "Box B" );
        await press( `${NAME( 2 )} .chip-main` );
        check( "a click on the front chip minimises", await ev( "AyniDesk.windows()[ 1 ].min" ) === true && await ev( `document.querySelector( '${NAME( 2 )}' ).classList.contains( 'min' )` ) );
        await press( `${NAME( 2 )} .chip-main` );
        check( "...and another brings it back", await ev( "AyniDesk.windows()[ 1 ].min" ) === false );
        await ev( `document.querySelector( '${FRONT} [data-win="min"]' ).focus(), true` );
        check( "the window's buttons take the keyboard", await ev( "document.activeElement.getAttribute( 'data-win' )" ) === "min" );
        await key( "Enter" );
        check( "...Enter on minimise minimises", await ev( "AyniDesk.windows()[ 1 ].min" ) === true );
        await press( `${NAME( 2 )} .chip-main` );
        await press( `${FRONT} [data-win="max"]` );
        check( "maximise from the chip", await ev( "AyniDesk.windows()[ 1 ].max" ) === true );
        const maxBtn = `document.querySelector( '${FRONT} [data-win="max"]' )`;
        check( "...it then says Restore, with its icon", await ev( `${maxBtn}.dataset.tip === 'Restore' && ${maxBtn}.getAttribute( 'aria-label' ) === 'Restore' && ${maxBtn}.querySelector( '.icon' ).dataset.icon === 'restore'` ) );
        await press( `${FRONT} [data-win="max"]` );
        check( "...and Maximise again once restored", await ev( `${maxBtn}.dataset.tip === 'Maximise' && ! ${maxBtn}.querySelector( '.icon' )` ) );
        await press( `${FRONT} [data-win="scale"]` );
        check( "Scale from the chip", await ev( "AyniDesk.windows()[ 1 ].scale" ) === true );
        await press( `${FRONT} [data-win="scale"]` );

        // Closing still asks the page: this is what keeps unsaved work.
        await ev( `( ${frame( 1 )}.contentWindow.ayniBeforeClose = function () { window.parent.__asked = ( window.parent.__asked || 0 ) + 1; return false; }, true )` );
        await press( `${FRONT} [data-win="close"]` );
        check( "close asks the page, and a no keeps the window", await ev( "window.__asked" ) === 1 && await ev( "AyniDesk.windows().length" ) === 3 );
        await ev( `( ${frame( 1 )}.contentWindow.ayniBeforeClose = function () { return new Promise( function ( r ) { setTimeout( function () { r( true ); }, 120 ); } ); }, true )` );
        await press( `${FRONT} [data-win="close"]` );
        check( "...it may take its time", await ev( "AyniDesk.windows().length" ) === 3 );
        check( "...and a yes closes it, chip and all", await until( "AyniDesk.windows().length === 2 && document.querySelectorAll( '#tasks > .chip' ).length === 2" ) );

        // The marks.
        await desk( 2 );
        await ev( "( document.dispatchEvent( new CustomEvent( 'nayive:chatunread', { detail: 3 } ) ), true )" );
        check( "unread Chat with no Chat window: a plain dot on the menu button", await ev( "!! document.querySelector( '#menuBtn > .icon-badge:not(.has-count)' ) && ! document.querySelector( '#menuBtn > .icon-badge' ).textContent" ) );
        await openWin( "/nayive/chat/box.html?n=Chat" );
        await settle();
        check( "...with one: the count on its chip", await ev( "document.querySelector( '#tasks .chip-main > .icon-badge.has-count' ).textContent" ) === "3" );
        const dot = await box( "#tasks .chip-main > .icon-badge.has-count" ), icon = await box( `#tasks > .chip:nth-child( 3 ) .chip-main > svg` );
        check( "...over the app's icon", dot.l <= icon.r && dot.r >= icon.l && dot.t <= icon.b, { dot, icon } );
        await press( `${FRONT} [data-win="close"]` );
        await until( "AyniDesk.windows().length === 2" );
        check( "...and back on the menu button when it closes", await ev( "!! document.querySelector( '#menuBtn > .icon-badge' )" ) );
        await ev( `( ${frame( 0 )}.contentDocument.body.insertAdjacentHTML( 'beforeend', '<dialog class="panel" open>Q</dialog>' ), true )` );
        await settle();
        check( "a dialog open in a window behind: its chip is marked", await ev( `document.querySelector( '${NAME( 1 )}' ).classList.contains( 'has-dialog' ) && getComputedStyle( document.querySelector( '${NAME( 1 )} .chip-main' ), '::after' ).content !== 'none'` ) );
        await press( `${NAME( 1 )} .chip-main` );
        check( "...not once it is in front", ! await ev( `document.querySelector( '${NAME( 1 )}' ).classList.contains( 'has-dialog' )` ) );

        // Many.
        await c.send( "Emulation.setDeviceMetricsOverride", { width: 1024, height: H, deviceScaleFactor: 1, mobile: false } );
        await desk( 18 );
        await settle();
        check( "many windows: the row scrolls, the front chip in view", await ev( `( function () { var t = document.getElementById( 'tasks' ), r = t.getBoundingClientRect(), f = document.querySelector( '${FRONT}' ).getBoundingClientRect(); return getComputedStyle( t ).overflowX === 'auto' && t.scrollWidth > t.clientWidth && f.left >= r.left - 1 && f.right <= r.right + 1; } )()` ), await ev( "document.getElementById( 'tasks' ).scrollWidth" ) );
        const before = await ev( "document.getElementById( 'tasks' ).scrollLeft" ), t = await box( "#tasks" );
        await c.send( "Input.dispatchMouseEvent", { type: "mouseWheel", x: t.l + 40, y: t.t + t.h / 2, deltaX: 0, deltaY: -120 } );
        await sleep( 150 );
        check( "...the wheel moves it", await ev( "document.getElementById( 'tasks' ).scrollLeft" ) !== before );
        await shot( "many" );
        await c.send( "Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false } );
    }

    // ----- 3. EDGES ----------------------------------------------------------
    if( want( "edges" ) )
    {
        await desk( 2 );
        for( const e of [ "top", "left", "right", "bottom" ] )
        {
            await pick( "setBar", e );
            const bar = await box( "#bar" ), area = await box( "#desk" ), side = e === "left" || e === "right";
            check( `${e}: the bar on that edge, the desk beside it`, await ev( "document.getElementById( 'desktop' ).dataset.edge" ) === e && off( e === "top" ? "top" : e, area, bar ) && ( side ? bar.w === 48 : bar.h === 48 ), { bar, area } );
            check( `${e}: the page's own rules follow`, await ev( `document.body.classList.contains( 'bar-${e}' )` ) );
            await press( "#menuBtn" );
            const m = await box( "#menu" );
            check( `${e}: the launcher opens off the bar`, off( e, m, bar ), m );
            await press( "#menuBtn" );
            await press( "#moreBtn" );
            check( `${e}: the ⋮ opens off the bar, on the screen`, await until( "document.getElementById( 'moreMenu' ).matches( ':popover-open' )" ) && off( e, await box( "#moreMenu" ), bar ) && ( await box( "#moreMenu" ) ).t >= 0 && ( await box( "#moreMenu" ) ).b <= H, await box( "#moreMenu" ) );
            await shot( "edge-" + e );
            await shut();
        }
        await pick( "setBar", "left" );
        await ev( "( function () { var s = document.getElementById( 'setBarH' ); s.value = 60; s.dispatchEvent( new Event( 'input', { bubbles: true } ) ); return true; } )()" );
        await settle();
        check( "the height: a side bar's width", ( await box( "#bar" ) ).w === 60, await box( "#bar" ) );
        check( "...the logo button follows", ( await box( "#menuBtn" ) ).w === 52 );
        await sleep( 400 );
        await reload();
        check( "both come back after a reload", await ev( "document.getElementById( 'desktop' ).dataset.edge" ) === "left" && ( await box( "#bar" ) ).w === 60 );
        check( "...and the list says so", await ev( "Ayni.picker( document.getElementById( 'setBar' ) ).value" ) === "left" );
    }

    // ----- 4. THE ⋮ ----------------------------------------------------------
    if( want( "more" ) )
    {
        await desk( 1 );
        await press( "#moreBtn" );
        check( "a press opens it", await open( "moreMenu" ) );
        await press( "#moreBtn" );
        check( "a second press closes it", ! await open( "moreMenu" ) );
        await clickAt( W - 60, 60, "right" );
        await sleep( 100 );
        check( "right-click on an empty spot of the desk opens it", await open( "moreMenu" ) );
        await key( "Escape" );
        check( "Esc closes it", ! await open( "moreMenu" ) );
        check( "...and the focus goes back to its button", await ev( "document.activeElement.id" ) === "moreBtn" );

        await press( "#menuBtn" );
        check( "the launcher opens from its button", await ev( "! document.getElementById( 'menu' ).hidden" ) );
        await clickAt( W - 60, 60 );
        check( "...a press on the desk closes it", await ev( "document.getElementById( 'menu' ).hidden" ) );

        // The focus in a window's frame: a press on the bar and back again.
        let [ fx, fy ] = await fieldIn( 0 );
        await clickAt( fx, fy );
        check( "(a field in a window has the focus)", await ev( `document.activeElement === ${frame( 0 )} && ${frame( 0 )}.contentDocument.activeElement.id === 'field'` ) );
        await press( "#moreBtn" );
        check( "with the focus in a window: it opens", await open( "moreMenu" ) );
        await key( "Escape" );
        check( "...and Esc still closes it", ! await open( "moreMenu" ) );
        await press( "#moreBtn" );
        [ fx, fy ] = await fieldIn( 0 );
        await clickAt( fx, fy );
        check( "a press in a window closes it", ! await open( "moreMenu" ) );
        await settle(); await sleep( 100 );
        check( "...and the focus stays in that window's field", await ev( `document.activeElement === ${frame( 0 )} && ${frame( 0 )}.contentDocument.activeElement.id === 'field'` ), await ev( "document.activeElement.tagName + '#' + document.activeElement.id" ) );

        const saved = k => ev( `( JSON.parse( localStorage.getItem( 'balata-desktop' ) ) || {} ).${k}` );
        await press( "#moreBtn" );
        await flip( "stickyChk" );
        check( "a switch stays in the popup and saves", await open( "moreMenu" ) && await saved( "sticky" ) === false );
        await flip( "setDate" );
        check( "show the date", /\d{4}-\d{2}-\d{2}/.test( await ev( "document.querySelector( '#clock > span' ).textContent" ) ) && await saved( "date" ) === true );
        await flip( "setSecs" );
        check( "show the seconds", /^\d\d:\d\d:\d\d$/.test( await ev( "document.querySelector( '#clock > b' ).textContent" ) ) );
        check( "(no second clock yet)", await ev( "document.getElementById( 'tz2Wrap' ).hidden" ) );
        await flip( "setTz2On" );
        check( "the second clock shows its zone's row", ! await ev( "document.getElementById( 'tz2Wrap' ).hidden" ) );
        await pick( "setTz2", "Asia/Tokyo" );
        check( "...the zone goes to the bar", await ev( "! document.getElementById( 'clock2' ).hidden && /Tokyo/.test( document.getElementById( 'clock2' ).textContent )" ) && await saved( "tz2" ) === "Asia/Tokyo", await ev( "document.getElementById( 'clock2' ).textContent" ) );
        await press( "#setDow .picker-field, #setDow input.input, #setDow [role=combobox]" ).catch( () => {} );
        await ev( "( Ayni.picker( document.getElementById( 'setDow' ) ).close && Ayni.picker( document.getElementById( 'setDow' ) ).close(), true )" );
        await pick( "setDow", "long" );
        check( "the weekday list", await saved( "dow" ) === "long" && await open( "moreMenu" ) );
        const tip = await box( "#moreMenu .switch .info-tip" );
        await mouse( "mouseMoved", tip.l + tip.w / 2, tip.t + tip.h / 2 ); await settle();
        await clickAt( tip.l + tip.w / 2, tip.t + tip.h / 2 );
        check( "an (i) in a row leaves the popup open, and flips nothing", await open( "moreMenu" ) && await ev( "document.getElementById( 'battBarChk' ).checked" ) === false );
        await shut();

        await press( "#moreBtn" );
        await pick( "lockSel", "clock" );
        check( "the locker's list saves, and the clock's text row shows", await ev( "JSON.parse( localStorage.getItem( 'nayive-locker' ) ).id" ) === "clock" && ! await ev( "document.getElementById( 'lockTextWrap' ).hidden" ) );
        await ev( "( function () { var m = document.getElementById( 'lockMin' ); m.value = '7'; m.dispatchEvent( new Event( 'input', { bubbles: true } ) ); var t = document.getElementById( 'lockText' ); t.value = 'Hi'; t.dispatchEvent( new Event( 'input', { bubbles: true } ) ); return true; } )()" );
        check( "...its minutes and text at once", await ev( "( function () { var s = JSON.parse( localStorage.getItem( 'nayive-locker' ) ); return s.min === 7 && s.text === 'Hi'; } )()" ), await ev( "localStorage.getItem( 'nayive-locker' )" ) );
        await pick( "lockSel", "culture" );
        check( "Bellas artes: its settings cog after the minutes' (i), with its name as tip", await ev( "( function () { var b = document.getElementById( 'salonBtn' ); return ! b.hidden && !! b.querySelector( '.icon svg' ) && b.parentNode.classList.contains( 'lock-min' ) && ( b.getAttribute( 'aria-label' ) || '' ).trim().length > 3; } )()" ), await ev( "document.getElementById( 'salonBtn' ).innerHTML.slice( 0, 120 )" ) );
        await ev( "( window.__locked = 0, AyniLocker.lock = function () { window.__locked = 1; }, true )" );
        await pick( "lockSel", "clock" );
        await ev( "( document.getElementById( 'lockNowBtn' ).scrollIntoView( { block: 'nearest' } ), true )" );   // the menu grew (WEATHER section): it may scroll
        await press( "#lockNowBtn" );
        check( "Lock now closes the popup and locks", await ev( "window.__locked" ) === 1 && ! await open( "moreMenu" ) );
    }

    // ----- 5. FREE / TILE ----------------------------------------------------
    if( want( "tile" ) )
    {
        await desk( 0 );
        await press( "#moreBtn" );
        check( "no window: the switch is greyed", await ev( "document.getElementById( 'tileOn' ).disabled && document.getElementById( 'tileSw' ).classList.contains( 'idle' )" ) );
        await shut();
        await openWin( "/nayive/fixture/box.html?n=A" ); await openWin( "/nayive/fixture/box.html?n=B" );
        await press( "#moreBtn" );
        check( "windows: it says Free", ! await ev( "document.getElementById( 'tileOn' ).disabled" ) && await ev( "document.getElementById( 'tileOff' ).checked" ) );
        const opener = await ev( "JSON.stringify( AyniDesk.windows().map( function ( w ) { return w.box; } ) )" );
        await press( "#tileSw label:last-of-type" );
        check( "the word Tile tiles", await ev( "AyniDesk.isTiled()" ) && await ev( "document.getElementById( 'tileOn' ).checked" ) );
        check( "...and the popup stays", await open( "moreMenu" ) );
        await ev( "( document.querySelector( '#desk > .win' ).style.left = '300px', true )" );
        await ev( "AyniDesk.windows()[ 0 ].box" );
        await shut();
        await ev( "( function () { var w = AyniDesk.windows(); return w.length; } )()" );
        await press( "#moreBtn" );
        await press( "#tileSw label:last-of-type" );
        check( "the word Tile again deals the desk out again", await ev( "parseInt( document.querySelector( '#desk > .win' ).style.left )" ) === 0, await ev( "document.querySelector( '#desk > .win' ).style.left" ) );
        await press( "#tileSw .track" );
        check( "the track flips it back: every window as it was", ! await ev( "AyniDesk.isTiled()" ) && await ev( "JSON.stringify( AyniDesk.windows().map( function ( w ) { return w.box; } ) )" ) === opener );
        await press( "#tileSw .track" );
        check( "...and on", await ev( "AyniDesk.isTiled()" ) );
        await press( "#tileSw label:first-of-type" );
        check( "the word Free frees it", ! await ev( "AyniDesk.isTiled()" ) );
    }

    // ----- 6. THE MONTH ------------------------------------------------------
    if( want( "month" ) )
    {
        await desk( 1, { date: true } );
        await press( "#clock > span" );
        check( "the date opens the month", await until( "document.getElementById( 'calPop' ).matches( ':popover-open' )" ) );
        check( "...off the bar, by the clock", off( "bottom", await box( "#calPop" ), await box( "#bar" ) ) && Math.abs( ( await box( "#calPop" ) ).r - ( await box( "#clock" ) ).r ) < 2, await box( "#calPop" ) );
        check( "...Ayni's calendar, view only, with week numbers", await ev( "!! document.querySelector( '#calPop .cal[data-weeks] .cal-wk' ) && ! document.querySelector( '#calPop td button' ) && ! document.querySelector( '#calPop input' )" ) );
        check( "...today is marked, with no scrollbars", await ev( "document.querySelectorAll( '#calPop td span.today' ).length === 1 && document.getElementById( 'calPop' ).scrollHeight <= document.getElementById( 'calPop' ).clientHeight + 1" ) );
        await shot( "month" );
        const title = await ev( "document.querySelector( '#calPop .cal-title' ).textContent" );
        await press( '#calPop [data-nav="1"]' );
        check( "the arrow steps a month, and it stays open", await open( "calPop" ) && await ev( "document.querySelector( '#calPop .cal-title' ).textContent" ) !== title );
        await press( "#clock > span" );
        check( "a second press on the date closes it", ! await open( "calPop" ) );
        await press( "#clock > span" );
        check( "it always opens on today's month", await ev( "document.querySelector( '#calPop .cal-title' ).textContent" ) === title );
        await press( "#moreBtn" );
        check( "the ⋮ takes its place", ! await open( "calPop" ) && await open( "moreMenu" ) );
        await shut();
        await press( "#clock > span" );
        const [ fx, fy ] = await fieldIn( 0 );
        await clickAt( fx, fy );
        check( "a press in a window closes it", ! await open( "calPop" ) );
        await press( "#clock > b" );
        check( "the time opens a countdown, not the month", await ev( "document.getElementById( 'cdBackdrop' ).open" ) && ! await open( "calPop" ) );
        const d = await box( "#cdBackdrop" );
        check( "...beside the bar, by the clock", d.b <= ( await box( "#bar" ) ).t && Math.abs( d.r - ( await box( "#clock" ) ).r ) < 2, d );
        await ev( "( document.getElementById( 'cdBackdrop' ).close(), true )" );
    }

    // ----- 7. THE COUNTDOWN CHIPS --------------------------------------------
    if( want( "countdown" ) )
    {
        await desk( 1 );
        await press( "#clock > b" );
        await ev( "( document.getElementById( 'cdM' ).value = '5', document.getElementById( 'cdText' ).value = 'Tea', true )" );
        await press( "#cdPlay" );
        check( "Play puts a chip on the bar", await until( "!! document.querySelector( '#cds > .cd-chip' )" ) );
        check( "...of real buttons", await ev( "( function () { var c = document.querySelector( '.cd-chip' ); return c.getAttribute( 'role' ) === 'group' && c.querySelectorAll( 'button' ).length === 4 && ! c.querySelector( '[role=\"button\"], button button' ); } )()" ) );
        check( "...among the gadgets", await ev( "!! document.querySelector( '.widgets .widget.cd-chip' )" ) );
        await press( ".cd-pp" );
        check( "Pause", await ev( "document.querySelector( '.cd-chip' ).classList.contains( 'paused' )" ) && ! await ev( "document.getElementById( 'cdBackdrop' ).open" ) );
        await press( ".cd-pp" );
        check( "Play again", ! await ev( "document.querySelector( '.cd-chip' ).classList.contains( 'paused' )" ) );
        await press( ".cd-main" );
        check( "a press on its time opens it to change it", await ev( "document.getElementById( 'cdBackdrop' ).open" ) && await ev( "document.getElementById( 'cdText' ).value" ) === "Tea" );
        await ev( "( document.getElementById( 'cdBackdrop' ).close(), true )" );
        await press( ".cd-stop" );
        check( "Stop takes it away", await until( "! document.querySelector( '.cd-chip' )" ) );
        await ev( "( localStorage.setItem( 'balata-countdowns', JSON.stringify( { list: [ { id: 1, end: 0, left: 0, done: true, text: 'Tea', len: 60 } ], last: 60 } ) ), true )" );
        await reload();
        check( "time's up: the text and only the x", await ev( "( function () { var c = document.querySelector( '.cd-chip' ); return c.classList.contains( 'done' ) && c.querySelector( '.cd-text' ).textContent === 'Tea' && c.querySelector( '.cd-pp' ).hidden && c.querySelector( '.cd-stop' ).hidden && ! c.querySelector( '.cd-x' ).hidden; } )()" ) );
        await press( ".cd-x" );
        check( "...the x takes it away", await until( "! document.querySelector( '.cd-chip' )" ) );
    }

    // ----- 8. THE WEATHER ----------------------------------------------------
    if( want( "weather" ) )
    {
        await desk( 1 );
        await press( "#moreBtn" );
        await flip( "weatherBarChk" );
        check( "the switch shows the sky on the bar", await until( "! document.getElementById( 'wxBtn' ).hidden" ) );
        check( "...a gadget of the bar", await ev( "document.getElementById( 'wxBtn' ).matches( '.widgets button.widget' )" ) );
        await shut();
        await press( "#wxBtn" );
        check( "a press opens today's forecast", await open( "wxPop" ) );
        check( "...waiting, or saying it failed", await until( "!! document.querySelector( '#wxPop .wx-busy, #wxPop .wx-fail' )" ) );
        check( "...off the bar", off( "bottom", await box( "#wxPop" ), await box( "#bar" ) ), await box( "#wxPop" ) );
        await press( "#wxBtn" );
        check( "a second press closes it", ! await open( "wxPop" ) );
        await press( "#wxBtn" );
        await press( "#moreBtn" );
        check( "the ⋮ takes its place", ! await open( "wxPop" ) && await open( "moreMenu" ) );
        await flip( "weatherBarChk" );
        check( "switched off: gone from the bar", await ev( "document.getElementById( 'wxBtn' ).hidden" ) );
    }

    // ----- 9. LANGUAGES ------------------------------------------------------
    if( want( "lang" ) )
    {
        const es = JSON.parse( fs.readFileSync( path.join( APPS, "shared/ayni/i18n/es.json" ), "utf8" ) );
        await desk( 1 );
        await ev( "( localStorage.setItem( 'ayni-lang', 'es' ), true )" );
        await reload();
        await openWin( "/nayive/fixture/box.html?n=B" );
        check( "es: the window's buttons", await ev( `document.querySelector( '${FRONT} [data-win="min"]' ).dataset.tip` ) === es[ "ayni.win.minimise" ], await ev( `document.querySelector( '${FRONT} [data-win="min"]' ).dataset.tip` ) );
        await press( "#moreBtn" );
        check( "es: no raw key in the popup", ! /\b(ayni|desktop|ui|acct)\.[a-z]/.test( await ev( "document.getElementById( 'moreMenu' ).innerText" ) ) );
        await shut();
        await ev( "( localStorage.removeItem( 'ayni-lang' ), true )" );
    }

    const bad = c.logs.filter( l => /^EXCEPTION/.test( l ) );
    check( "no page errors", bad.length === 0, bad );
}
catch( e ) { fails++; console.log( "FAIL (stopped) " + e.message ); }
await b.kill();
srv.close();
console.log( `${ fails ? "FAILED" : "OK" } ${passes} passed, ${fails} failed` );
process.exit( fails ? 1 : 0 );
