// run.mjs - Ayni's buttons family in Nayive (buttons, switches, ticks), in a
// real (headless) browser: the rules on every page, then the behaviours.
//
//   node tools/buttons-test/run.mjs
//
// Same scratch server as tools/smoke-test (its own run-root in /tmp, a copy of
// client/apps, one user "test"); the real store/ is never touched.
//
// RULES, every app, phone and desktop width, light and dark:
//   no button carries the old disabled attribute or a native title; aria-disabled
//   only on .btn; every round .btn has a name and a drawn icon; no old switch
//   markup (.track, a switch without role="switch"); no old .is-active on a .btn;
//   a ⋮ is Ayni's "more" icon, so it gets no popup triangle.
// BEHAVIOURS: a dialog's ✓ is the filled default and its × closes (click and
//   Escape); a lone × moves to the title line; a disabled button is faded, stays
//   focusable and ignores clicks; a toggle that is on is tinted; the ⋮ has no
//   popup triangle; tooltips appear on hover; a switch is drawn by Ayni and flips;
//   on touch every button gets a 44 px hit area and dialog buttons are 44 px.
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "buttons-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 500 ) ) );
};

// The rules, read off the page as it stands.
const RULES = `( () => { const o = [];
    const q = ( s ) => [ ...document.querySelectorAll( s ) ];
    const id = ( e ) => '#' + e.id + ' .' + String( e.className ).replace( / +/g, '.' );
    q( 'button[disabled].btn' ).forEach( e => o.push( 'disabled attribute on a .btn ' + id( e ) ) );
    q( 'button[aria-disabled="true"]:not(.btn)' ).forEach( e => o.push( 'aria-disabled on a non-.btn ' + id( e ) ) );
    q( 'button[title], .btn[title]' ).forEach( e => o.push( 'native title ' + id( e ) ) );
    q( '.btn:not(.text)' ).forEach( e => { if( ! e.getAttribute( 'aria-label' ) && ! e.textContent.trim() && ! e.getAttribute( 'aria-labelledby' ) ) o.push( 'no name ' + id( e ) ); } );
    q( '.btn .icon[data-icon]' ).forEach( e => { if( ! e.firstElementChild ) o.push( 'icon not drawn: ' + e.dataset.icon ); } );
    q( '.switch .track, .switch input:not([role=switch])' ).forEach( e => o.push( 'old switch ' + id( e ) ) );
    q( '.btn.is-active' ).forEach( e => o.push( 'is-active on a .btn ' + id( e ) ) );
    q( '.btn:is([aria-haspopup], [popovertarget]) > svg' ).forEach( e => { if( e.querySelectorAll( 'circle' ).length === 3 ) o.push( 'a ⋮ drawn inline (Ayni cannot tell it from other popups) ' + id( e.parentNode ) ); } );
    q( '[data-act="close"], [data-act="primary"], [data-act="danger"]' ).forEach( e => o.push( 'old data-act ' + id( e ) ) );
    return [ ...new Set( o ) ]; } )()`;

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    const size = ( w ) => c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: w < 600 } );
    const ev = ( s ) => c.evaluate( s );
    const until = async ( s, ms = 4000 ) => { for( let t = 0; t < ms; t += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const open = async ( app, w ) =>
    {
        await size( w );
        await c.send( "Page.navigate", { url: BASE + "/nayive/" + ( app ? app + "/" : "" ) } );
        await until( "window.Ayni && Ayni.ready && document.readyState === 'complete'", 8000 );
        await ev( "Ayni.ready.then( () => true )" );
        await sleep( app === "write" ? 4000 : 1500 );
    };
    const mouse = async ( type, x, y ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( r => JSON.stringify( [ r.left + r.width / 2, r.top + r.height / 2 ] ) )( document.querySelector( ${JSON.stringify( sel )} ).getBoundingClientRect() )` ) );

    await size( 390 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "RULES - every app, phone and desktop, light and dark" );
    for( const theme of [ "light", "dark" ] )
    {
        await ev( `localStorage.setItem( 'ayni-theme', '${theme}' ); true` );
        for( const w of [ 390, 1280 ] )
            for( const app of [ "", ...APPS ] )
            {
                if( app === "desktop" && w < 600 ) continue;     // a phone is sent back to the launcher
                await open( app, w );
                const found = await ev( RULES );
                ok( ! found.length, `${theme} ${w}px ${app || "launcher"}`, found );
            }
    }
    await ev( "localStorage.removeItem( 'ayni-theme' ); true" );

    console.log( "DIALOGS - Drive's New folder" );
    await open( "drive", 1280 );
    await ev( "document.getElementById( 'newFolderBtn' ).click(); true" );
    ok( await until( "document.getElementById( 'newFolderBackdrop' )?.open" ), "New folder opens" );
    const okBtn = JSON.parse( await ev( `( b => JSON.stringify( [ b.className, getComputedStyle( b ).backgroundColor, getComputedStyle( document.documentElement ).getPropertyValue( '--accent' ).trim(), b.offsetWidth, b.getAttribute( 'aria-label' ) ] ) )( document.getElementById( 'newFolderConfirmBtn' ) )` ) );
    ok( /\bprimary\b/.test( okBtn[ 0 ] ) && okBtn[ 1 ] !== "rgba(0, 0, 0, 0)", "the ✓ is the filled default button", okBtn );
    ok( okBtn[ 3 ] === 36, "dialog buttons are 36 px with a mouse", okBtn[ 3 ] );
    ok( !! okBtn[ 4 ], "the ✓ is named after its tooltip", okBtn[ 4 ] );
    const x = JSON.parse( await ev( `( b => JSON.stringify( [ b.hasAttribute( 'data-close' ), getComputedStyle( b ).backgroundColor ] ) )( document.getElementById( 'newFolderCancelBtn' ) )` ) );
    ok( x[ 0 ] && x[ 1 ] === "rgba(0, 0, 0, 0)", "the × is marked data-close and has no fill at rest", x );
    await c.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } );
    await c.send( "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } );
    ok( await until( "! document.getElementById( 'newFolderBackdrop' ).open" ), "Escape closes it (through its ×)" );
    await ev( "document.getElementById( 'newFolderBtn' ).click(); true" );
    await until( "document.getElementById( 'newFolderBackdrop' ).open" );
    await ev( "document.getElementById( 'newFolderCancelBtn' ).click(); true" );
    ok( await until( "! document.getElementById( 'newFolderBackdrop' ).open" ), "a click on the × closes it" );
    ok( await ev( "!! document.querySelector( '#propsBackdrop > header > #propsCloseBtn[data-close]' ) && ! document.querySelector( '#propsBackdrop footer' )" ),
        "a lone × goes to the title line, the empty row is dropped" );

    console.log( "DIALOGS - one built in code (Ayni.confirm)" );
    await ev( "window.__a = Ayni.confirm( { title: 'T', body: 'B', confirm: 'Go', danger: true } ); true" );
    ok( await until( "!! document.querySelector( 'dialog.panel[open]:not([id]) footer .btn.danger' )" ), "a danger confirm shows its trash button" );
    const dz = JSON.parse( await ev( `( b => JSON.stringify( [ b.classList.contains( 'primary' ), b.dataset.tip, b.getAttribute( 'aria-label' ), !! b.querySelector( '.icon svg' ) ] ) )( document.querySelector( 'dialog.panel[open]:not([id]) .btn.danger' ) )` ) );
    ok( ! dz[ 0 ] && dz[ 1 ] === "Go" && dz[ 2 ] === "Go" && dz[ 3 ], "it is never the default, says what it does and has its icon", dz );
    await ev( "document.querySelector( 'dialog.panel[open]:not([id]) [data-close]' ).click(); true" );
    ok( await ev( "window.__a.then( v => v === false )" ), "its × answers no" );

    console.log( "DISABLED - Music's Play with nothing loaded" );
    await open( "music", 1280 );
    const pl = JSON.parse( await ev( `( b => JSON.stringify( [ b.getAttribute( 'aria-disabled' ), getComputedStyle( b ).opacity, b.tabIndex, b.disabled ] ) )( document.getElementById( 'playBtn' ) )` ) );
    ok( pl[ 0 ] === "true" && pl[ 1 ] === "0.45" && pl[ 2 ] >= 0 && pl[ 3 ] === false, "faded, still focusable, no disabled attribute", pl );
    await ev( "window.__clicked = 0; document.getElementById( 'playBtn' ).addEventListener( 'click', () => window.__clicked++ ); document.getElementById( 'playBtn' ).click(); true" );
    ok( await ev( "window.__clicked === 0" ), "a click does nothing" );

    console.log( "TOGGLES, POPUPS, TOOLTIPS - Drive" );
    await open( "drive", 1280 );
    const vw = JSON.parse( await ev( `JSON.stringify( [ 'gridBtn', 'listBtn' ].map( i => [ document.getElementById( i ).getAttribute( 'aria-pressed' ), getComputedStyle( document.getElementById( i ) ).backgroundColor ] ) )` ) );
    ok( vw[ 0 ][ 0 ] === "true" && vw[ 0 ][ 1 ] !== "rgba(0, 0, 0, 0)" && vw[ 1 ][ 0 ] !== "true" && vw[ 1 ][ 1 ] === "rgba(0, 0, 0, 0)", "the view in force is tinted, the other is not", vw );
    ok( await ev( "getComputedStyle( document.getElementById( 'moreBtn' ), '::after' ).content === 'none'" ), "the ⋮ shows no popup triangle" );
    const [ sx, sy ] = await centre( "#searchToggleBtn" );
    await mouse( "mouseMoved", sx, sy );
    ok( await until( "document.getElementById( 'ayni-tip' )?.matches( ':popover-open' ) && document.getElementById( 'ayni-tip' ).textContent.startsWith( 'Search' )", 2500 ),
        "hovering a button shows its tooltip", await ev( "document.getElementById( 'ayni-tip' )?.textContent" ) );
    await mouse( "mouseMoved", 5, 790 );

    console.log( "SWITCHES - Language's 'Local'" );
    await open( "language", 1280 );
    const sw = JSON.parse( await ev( `( i => JSON.stringify( [ i.getAttribute( 'role' ), i.offsetWidth, i.offsetHeight, i.checked ] ) )( document.getElementById( 'local' ) )` ) );
    ok( sw[ 0 ] === "switch" && sw[ 1 ] === 36 && sw[ 2 ] === 20, "drawn by Ayni: 36 x 20, role=switch", sw );
    const [ lx, ly ] = await centre( "#local" );
    await mouse( "mousePressed", lx, ly ); await mouse( "mouseReleased", lx, ly );
    ok( await ev( `document.getElementById( 'local' ).checked === ${ ! sw[ 3 ] }` ), "a click flips it" );

    console.log( "TOUCH - a finger" );
    await open( "drive", 390 );
    await ev( "Ayni.setTouchPreview( true ); true" );
    ok( await ev( "document.documentElement.classList.contains( 'touch' )" ), "html.touch is on" );
    ok( await ev( `( () => { const b = document.getElementById( 'searchToggleBtn' ), r = b.getBoundingClientRect(); return document.elementFromPoint( r.left - 3, r.top + r.height / 2 )?.closest( '#searchToggleBtn' ) === b && r.width === 36; } )()` ),
        "a header button keeps 36 px and is hit 3 px outside it (44 px area)" );
    await ev( "document.getElementById( 'newFolderBtn' ).click(); true" );
    await until( "document.getElementById( 'newFolderBackdrop' ).open" );
    ok( await ev( "document.getElementById( 'newFolderConfirmBtn' ).offsetWidth === 44" ), "dialog buttons are 44 px on touch",
        await ev( "document.getElementById( 'newFolderConfirmBtn' ).offsetWidth" ) );
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
