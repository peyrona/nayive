// run.mjs - Ayni's menus family in Nayive (Ayni.menuAt, Ayni.fitBar, the
// menu bar, tool groups, popups, header toolbars), in a real (headless)
// browser: the rules on every page, then the behaviours.
//
//   node tools/menus-test/run.mjs            (SHOTS=/some/dir also saves screenshots)
//
// Same scratch server as tools/smoke-test (its own run-root in /tmp, a copy of
// client/apps, one user "test"); the real store/ is never touched.
//
// RULES, every app, phone and desktop width: no old menu API (NayiveUI.menuAt,
//   fitBar, longPress, keyLabel, menuOpen, wireMenu outside the desktop,
//   NayiveOffice.groupPopup); Ayni's family is loaded; no old menu markup
//   (.item-menu, .menu-panel; .top-menu only on the desktop and in Chat's hold
//   layer); every Ayni menu and popup is a popover; every popovertarget names
//   one; every header toolbar is an Ayni toolbar with one Tab stop; no error.
// BEHAVIOURS: Drive's item menu (right-click at the pointer, opened on the
//   release, keys beside the rows, the focus left alone, Esc); the header ⋮
//   by rank on a narrow window (a second press closes it); the header's
//   arrows; a long-press on a phone picks, it opens no menu; Calendar's
//   phone ⋮ (a view pick, its tick); the launcher's Office popup; Write's
//   phone File menu (real names) and its menu bar (F10, the arrows, a
//   submenu, Esc); Calc's tool group lit by the toggle inside it.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const APPS = fs.readdirSync( path.join( REPO, "client/apps" ) )
               .filter( d => fs.existsSync( path.join( REPO, "client/apps", d, "index.html" ) ) ).sort();

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "menus-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
for( const n of [ "a.txt", "b.txt", "c.txt" ] ) fs.writeFileSync( `${RUN}/homes/test/files/${n}`, n );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 500 ) ) );
};
const SHOTS = process.env.SHOTS || "";            // a folder: screenshots go there

// The rules, read off the page as it stands.
const RULES = `( () => { const o = [], desk = !! document.querySelector( '.desk, #desk, html.is-desktop' ) || location.pathname.includes( '/desktop/' );
    if( window.NayiveUI && [ 'menuAt', 'fitBar', 'longPress', 'keyLabel', 'menuOpen', 'closeMenu' ].some( k => NayiveUI[ k ] ) ) o.push( 'old NayiveUI menu API' );
    if( window.NayiveOffice && NayiveOffice.groupPopup ) o.push( 'old NayiveOffice.groupPopup' );
    if( typeof Ayni.menuAt !== 'function' || typeof Ayni.fitBar !== 'function' ) return [ 'no Ayni menus family' ];
    if( document.querySelector( '.item-menu, .menu-panel, #menuPanel, #menuSub' ) ) o.push( 'old menu markup' );
    if( ! desk && [ ...document.querySelectorAll( '.top-menu' ) ].some( m => ! m.closest( '.ctx' ) ) ) o.push( 'a .top-menu outside the desktop' );
    for( const m of document.querySelectorAll( '.panel.menu' ) )
        if( ! m.hasAttribute( 'popover' ) || m.getAttribute( 'role' ) !== 'menu' ) o.push( ( m.id || '?' ) + ': a menu that is not a popover with role menu' );
    for( const p of document.querySelectorAll( '.panel.popup' ) )
        if( ! p.hasAttribute( 'popover' ) ) o.push( ( p.id || '?' ) + ': a popup that is not a popover' );
    for( const b of document.querySelectorAll( '[popovertarget]' ) )
    {
        const t = document.getElementById( b.getAttribute( 'popovertarget' ) );
        if( ! t || ! t.hasAttribute( 'popover' ) ) o.push( ( b.id || b.className ) + ': popovertarget names no popover' );
    }
    for( const h of document.querySelectorAll( '.topbar-actions, .header-actions' ) )
    {
        if( h.getAttribute( 'role' ) !== 'toolbar' ) { o.push( 'a header toolbar without role=toolbar' ); continue; }
        const stops = [ ...h.querySelectorAll( 'button' ) ].filter( b => ! b.closest( '.input-group' ) && b.closest( '[role="toolbar"]' ) === h && b.getClientRects().length && b.tabIndex === 0 );
        if( stops.length > 1 ) o.push( 'a header toolbar with ' + stops.length + ' Tab stops' );
    }
    return o; } )()`;

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    const size = ( w, h = 800 ) => c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 } );
    const ev = ( s ) => c.evaluate( s );
    const until = async ( s, ms = 4000 ) => { for( let t = 0; t < ms; t += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const open = async ( app, w, h ) =>
    {
        await size( w, h );
        await c.send( "Page.navigate", { url: BASE + "/nayive/" + ( app ? app + "/" : "" ) } );
        await until( "window.Ayni && Ayni.ready && document.readyState === 'complete'", 8000 );
        await ev( "Ayni.ready.then( () => true )" );
        await sleep( app === "write" || app === "calc" ? 4000 : 1500 );
    };
    const mouse = async ( type, x, y, button = "left" ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : button,
        buttons: type === "mousePressed" ? ( button === "right" ? 2 : 1 ) : 0, clickCount: 1, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( r => JSON.stringify( [ r.left + r.width / 2, r.top + r.height / 2 ] ) )( document.querySelector( ${JSON.stringify( sel )} ).getBoundingClientRect() )` ) );
    const press = async ( sel, button = "left" ) => { const [ x, y ] = await centre( sel ); await mouse( "mouseMoved", x, y ); await mouse( "mousePressed", x, y, button ); await mouse( "mouseReleased", x, y, button ); await sleep( 120 ); };
    const key = async ( k, code, vk, modifiers = 0 ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers } ); await sleep( 80 ); };
    const isOpen = ( id ) => ev( `!! document.getElementById( '${id}' )?.matches( ':popover-open' )` );
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        await sleep( 300 );
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    };
    const errors = () => c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]/.test( l ) );

    await size( 390 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "RULES - every app, phone and desktop" );
    for( const w of [ 390, 1280 ] )
        for( const app of [ "", ...APPS ] )
        {
            if( app === "desktop" && w < 600 ) continue;     // a phone is sent back to the launcher
            c.logs.length = 0;
            await open( app, w );
            const found = await ev( RULES );
            const errs = errors();
            ok( ! found.length && ! errs.length, `${w}px ${app || "launcher"}`, found.concat( errs ) );
        }

    const ROW = p => `#listing .row[data-path="${p}"]`;

    console.log( "ITEM MENU - Drive" );
    await open( "drive", 1280 );
    ok( await until( `!! document.querySelector( '${ROW( "files/a.txt" )}' )`, 8000 ), "Drive lists a.txt" );
    await ev( "document.getElementById( 'searchInput' ) && true" );
    const [ rx, ry ] = await centre( ROW( "files/a.txt" ) );
    await mouse( "mouseMoved", rx, ry );
    await mouse( "mousePressed", rx, ry, "right" );
    await sleep( 150 );
    ok( ! await isOpen( "ayni-menu" ), "a right-click: nothing yet while the button is down" );
    await mouse( "mouseReleased", rx, ry, "right" );
    ok( await until( "!! document.getElementById( 'ayni-menu' )?.matches( ':popover-open' )" ), "…the item menu opens on the release, and stays" );
    ok( await ev( `( m => Math.abs( m.getBoundingClientRect().left - ${rx} ) < 2 || m.getBoundingClientRect().right <= innerWidth - 7 )( document.getElementById( 'ayni-menu' ) )` ), "…at the pointer, on screen" );
    ok( await ev( "[ ...document.querySelectorAll( '#ayni-menu kbd' ) ].some( k => k.textContent === 'F2' )" ), "…its rows show their keys (F2)" );
    ok( await ev( "! document.getElementById( 'ayni-menu' ).contains( document.activeElement )" ), "…and the mouse did not move the focus into it" );
    await shot( "drive-item-menu-light" );
    await key( "Escape", "Escape", 27 );
    ok( await until( "! document.getElementById( 'ayni-menu' ).matches( ':popover-open' )" ), "Esc closes it" );
    await press( ROW( "files/b.txt" ), "right" );
    await until( "document.getElementById( 'ayni-menu' ).matches( ':popover-open' )" );
    await press( "#ayni-menu [data-act=rename]" );
    ok( await until( "document.getElementById( 'renameBackdrop' ).open" ), "a pick runs its action (Rename opens)" );
    await key( "Escape", "Escape", 27 );
    await until( "! document.getElementById( 'renameBackdrop' ).open" );

    console.log( "HEADER - the toolbar that fits, its keys" );
    await open( "drive", 520 );
    // Drive's header fits even a phone now: squeeze it until tools must leave.
    await ev( "document.querySelector( '.topbar' ).style.paddingRight = '200px'; true" );
    await sleep( 400 );
    const outs = await ev( "[ ...document.querySelectorAll( '.topbar .fit-out' ) ].length" );
    ok( outs > 0 && await ev( "!! document.querySelector( '.topbar .fit-more' ) && document.querySelector( '.topbar .fit-more' ).getClientRects().length > 0" ), "a narrow window: tools leave into the ⋮", outs );
    ok( await ev( "! document.getElementById( 'searchToggleBtn' ).classList.contains( 'fit-out' )" ), "…search stays" );
    await press( ".topbar .fit-more" );
    ok( await until( "document.getElementById( 'ayni-menu' ).matches( ':popover-open' )" ), "the ⋮ opens its menu" );
    ok( await ev( "Math.abs( document.getElementById( 'ayni-menu' ).getBoundingClientRect().right - document.querySelector( '.topbar .fit-more' ).getBoundingClientRect().right ) < 2" ), "…ending where the ⋮ ends" );
    await shot( "drive-fit-more-light" );
    await press( ".topbar .fit-more" );
    await sleep( 150 );
    ok( ! await isOpen( "ayni-menu" ), "a second press on the ⋮ closes it" );
    await open( "drive", 1280 );
    const tools = await ev( "[ ...document.querySelectorAll( '.topbar [role=toolbar] button' ) ].filter( b => b.getClientRects().length && ! b.closest( '.input-group' ) ).map( b => b.id || b.dataset.tip )" );
    await ev( "[ ...document.querySelectorAll( '.topbar [role=toolbar] button' ) ].find( b => b.tabIndex === 0 && b.getClientRects().length ).focus(); true" );
    const a0 = await ev( "document.activeElement.id || document.activeElement.dataset.tip" );
    await key( "ArrowRight", "ArrowRight", 39 );
    const a1 = await ev( "document.activeElement.id || document.activeElement.dataset.tip" );
    ok( a0 !== a1 && tools.indexOf( a1 ) === tools.indexOf( a0 ) + 1, "the header is one Tab stop: Right moves to the next tool", [ a0, a1 ] );
    ok( await ev( "document.activeElement.tabIndex === 0 && [ ...document.querySelectorAll( '.topbar [role=toolbar] button' ) ].filter( b => b.tabIndex === 0 && ! b.closest( '.input-group' ) ).length === 1" ), "…which becomes the one Tab stop" );

    console.log( "LONG-PRESS - a phone picks" );
    await open( "drive", 390 );
    await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true } );
    await until( `!! document.querySelector( '${ROW( "files/a.txt" )}' )`, 8000 );
    const [ tx, ty ] = await centre( ROW( "files/a.txt" ) );
    await c.send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ { x: tx, y: ty } ] } );
    await sleep( 800 );
    await c.send( "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] } );
    await sleep( 300 );
    ok( await ev( `document.querySelector( '${ROW( "files/a.txt" )}' ).getAttribute( 'aria-selected' ) === 'true'` ), "a long-press picks the row" );
    ok( ! await isOpen( "ayni-menu" ), "…and opens no menu" );
    await c.send( "Emulation.setTouchEmulationEnabled", { enabled: false } );

    console.log( "CALENDAR - the phone ⋮ (Ayni.fitBar)" );
    await open( "calendar", 390 );
    await until( "! document.getElementById( 'moreBtn' ).hidden" );
    await press( "#moreBtn" );
    ok( await until( "document.getElementById( 'ayni-menu' ).matches( ':popover-open' ) && !! document.querySelector( '#ayni-menu [data-act=\"view:dayGridMonth\"]' )" ), "the ⋮ opens the views menu" );
    await press( '#ayni-menu [data-act="view:dayGridMonth"]' );
    ok( await until( "! document.getElementById( 'ayni-menu' ).matches( ':popover-open' )" ), "a pick closes it" );
    await press( "#moreBtn" );
    await until( "document.getElementById( 'ayni-menu' ).matches( ':popover-open' )" );
    ok( await ev( "document.querySelector( '#ayni-menu [data-act=\"view:dayGridMonth\"]' ).getAttribute( 'aria-checked' ) === 'true'" ), "…and Month is the ticked view now" );
    await shot( "calendar-views-phone" );
    await key( "Escape", "Escape", 27 );

    console.log( "LAUNCHER - the Office popup" );
    await open( "", 1280 );
    await press( "#officeBtn" );
    ok( await until( "document.getElementById( 'officeMenu' ).matches( ':popover-open' )" ), "the Office tile opens its popup" );
    ok( await ev( "!! document.querySelector( '#officeMenu a[href=\"write/index.html\"]' )" ), "…with Write in it" );
    await shot( "launcher-office" );
    await key( "Escape", "Escape", 27 );
    ok( await until( "! document.getElementById( 'officeMenu' ).matches( ':popover-open' )" ), "Esc closes it" );

    console.log( "WRITE - the phone File menu, the menu bar" );
    await open( "write", 390 );
    await press( "#moreBtn" );
    ok( await until( "document.getElementById( 'topMenu' ).matches( ':popover-open' )" ), "phone: the ⋮ opens the File menu" );
    const names = await ev( "[ ...document.querySelectorAll( '#topMenu [role=menuitem]' ) ].filter( b => b.getClientRects().length ).map( b => b.textContent.trim() )" );
    ok( names.length > 3 && ! names.some( n => /Btn$/.test( n ) ), "…its rows carry the buttons' names, not their ids", names );
    await shot( "write-file-phone" );
    await key( "Escape", "Escape", 27 );
    await open( "write", 1280 );
    await press( "#chromeMenusBtn" );
    ok( await until( "!! document.querySelector( '#menuBar[role=menubar] > button' )" ), "the menu bar is an Ayni menu bar" );
    await ev( "document.querySelector( '.docx-page, #editor' )?.focus?.(); true" );
    await key( "F10", "F10", 121 );
    ok( await until( "document.activeElement.parentElement.id === 'menuBar'" ), "F10 focuses it" );
    for( let i = 0; i < 4; i++ ) await key( "ArrowRight", "ArrowRight", 39 );
    await key( "ArrowDown", "ArrowDown", 40 );
    ok( await until( "!! document.querySelector( '#menuBar-4:popover-open' )" ), "Right x4 + Down opens Format" );
    await ev( "document.querySelector( '#menuBar-4 [data-act=\"write.tb.fontFamily\"]' ).focus(); true" );
    await key( "ArrowRight", "ArrowRight", 39 );
    ok( await until( "!! document.querySelector( '#menuBar-4-sub:popover-open' ) && document.getElementById( 'menuBar-4-sub' ).contains( document.activeElement )" ), "Right opens the Font submenu, the focus in it" );
    await shot( "write-menubar-sub" );
    await key( "Escape", "Escape", 27 );
    ok( await until( "! document.querySelector( '#menuBar-4-sub:popover-open' ) && !! document.querySelector( '#menuBar-4:popover-open' )" ), "Esc closes only the submenu" );
    await key( "Escape", "Escape", 27 );
    ok( await until( "! document.querySelector( '#menuBar-4:popover-open' )" ), "…a second Esc the menu" );
    await press( "#chromeToolbarBtn" );

    console.log( "DARK" );
    await open( "drive", 1280 );
    await ev( "Ayni.setTheme( 'dark' ); true" );
    await press( ROW( "files/a.txt" ), "right" );
    await until( "document.getElementById( 'ayni-menu' ).matches( ':popover-open' )" );
    await shot( "drive-item-menu-dark" );
    const bg = await ev( "getComputedStyle( document.getElementById( 'ayni-menu' ) ).backgroundColor" );
    ok( bg !== "rgba(0, 0, 0, 0)", "dark: the menu has its card colour", bg );
    await key( "Escape", "Escape", 27 );
    await ev( "Ayni.setTheme( null ); localStorage.removeItem( 'ayni-theme' ); true" );
    // Calc last: its tool changes a cell, and the page then asks before it is left.
    console.log( "CALC - a tool group lit by its toggle" );
    await open( "calc", 1280 );
    await ev( "document.getElementById( 'fmtWrapBtn' ).setAttribute( 'aria-pressed', 'true' ); true" );
    ok( await until( "document.getElementById( 'fmtAlignBtn' ).getAttribute( 'aria-pressed' ) === 'true'" ), "Wrap on lights the Align group's button" );
    await ev( "document.getElementById( 'fmtWrapBtn' ).setAttribute( 'aria-pressed', 'false' ); true" );
    await press( "#fmtAlignBtn" );
    ok( await until( "document.getElementById( 'alignPopup' ).matches( ':popover-open' )" ), "the button opens its group" );
    await shot( "calc-align-group" );
    await press( "#fmtAlignCenterBtn" );
    ok( await until( "! document.getElementById( 'alignPopup' ).matches( ':popover-open' )" ), "a tool in it runs and closes it" );

    ok( ! errors().length, "no page errors in the behaviours", errors() );
}
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "FAILED" : "ALL GREEN" );
process.exit( fail ? 1 : 0 );
