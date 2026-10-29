// run.mjs - Ayni's notifications family in Nayive (toasts, Undo, progress), in
// a real (headless) browser: the rules on every page, then the behaviours.
//
//   node tools/toasts-test/run.mjs            (SHOTS=/some/dir also saves screenshots)
//
// Same scratch server as tools/smoke-test (its own run-root in /tmp, a copy of
// client/apps, one user "test"); the real store/ is never touched.
//
// RULES, every app, phone and desktop width: no old toast markup or API; Ayni's
//   family is loaded and styled; a toast shows with its icon and close button,
//   and close() takes it away; no error on the page.
// BEHAVIOURS: Drive's bin offers an Undo (icon + word, the Ctrl+Z hint); Ctrl+Z
//   brings it back while it shows; news stacks beside an Undo; closing the Undo
//   makes it final and Ctrl+Z then does nothing; uploads and eMail's long jobs
//   are progress notifications (600 ms wait, Stop, steps); on a phone a toast
//   sits above Calc's status bar; an error stays, a success goes after 6 s.
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "toasts-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
fs.writeFileSync( `${RUN}/homes/test/files/a.txt`, "a" );
fs.writeFileSync( `${RUN}/homes/test/files/b.txt`, "b" );
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

// The rules, read off the page as it stands, after one notification was shown.
const RULES = `( async () => { const o = [];
    if( document.getElementById( 'toast' ) || document.querySelector( '.toast-undo, .transfer-bar, [data-transfer-slot]' ) ) o.push( 'old toast markup' );
    if( window.NayiveUI && ( NayiveUI.toast || NayiveUI.undoToast || NayiveUI.undoSettle || NayiveUI.transfer ) ) o.push( 'old NayiveUI toast API' );
    if( typeof Ayni.toast !== 'function' || typeof Ayni.progress !== 'function' || typeof Ayni.settleUndo !== 'function' ) return [ 'no Ayni notifications family' ];
    const h = Ayni.toast( 'info', 'Probe' );
    const t = [ ...document.querySelectorAll( '#ayni-toasts > .toast' ) ].find( x => x.textContent.includes( 'Probe' ) );
    if( ! t ) o.push( 'Ayni.toast shows nothing' );
    else
    {
        if( getComputedStyle( t ).display !== 'flex' ) o.push( 'the toast is not styled (no ayni-toasts.css)' );
        if( ! t.querySelector( '.icon[data-icon="info"] svg' ) ) o.push( 'no kind icon' );
        if( ! t.querySelector( '.dismiss .icon svg' ) ) o.push( 'no close button' );
        if( ! document.getElementById( 'ayni-toasts' ).matches( ':popover-open' ) ) o.push( 'the stack is not open' );
    }
    h.close();
    if( document.querySelector( '#ayni-toasts > .toast' ) ) o.push( 'close() left it' );
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
        await sleep( app === "write" ? 4000 : 1500 );
    };
    const mouse = async ( type, x, y ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( r => JSON.stringify( [ r.left + r.width / 2, r.top + r.height / 2 ] ) )( document.querySelector( ${JSON.stringify( sel )} ).getBoundingClientRect() )` ) );
    const key = async ( k, code, vk, modifiers = 0 ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers } ); };
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    };
    const shown = () => ev( "[ ...document.querySelectorAll( '#ayni-toasts > .toast' ) ].map( x => x.querySelector( 'p' ).firstChild.textContent )" );
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

    console.log( "UNDO - Drive's bin" );
    await open( "drive", 1280 );
    const ROW = p => `#listing .row[data-path="${p}"]`;
    ok( await until( `!! document.querySelector( '${ROW( "files/a.txt" )}' )`, 8000 ), "Drive lists a.txt" );
    let [ rx, ry ] = await centre( ROW( "files/a.txt" ) );
    await mouse( "mousePressed", rx, ry ); await mouse( "mouseReleased", rx, ry );
    await key( "Delete", "Delete", 46 );
    ok( await until( `! document.querySelector( '${ROW( "files/a.txt" )}' ) && !! document.querySelector( '#ayni-toasts .toast.undo' )`, 6000 ), "Del: to the bin, with an Undo" );
    const u = JSON.parse( await ev( `( t => JSON.stringify( [ t.classList.contains( 'ok' ), t.querySelector( '.act' ).textContent.trim(), !! t.querySelector( '.act .icon[data-icon="undo"] svg' ), t.querySelector( '.undo-key' ).textContent ] ) )( document.querySelector( '#ayni-toasts .toast.undo' ) )` ) );
    ok( u[ 0 ] && u[ 1 ] === "Undo" && u[ 2 ] && u[ 3 ] === "Ctrl+Z also undoes", "a success toast, the undo icon and the word, the Ctrl+Z hint", u );
    await shot( "drive-undo-light" );
    await ev( "localStorage.setItem( 'ayni-theme', 'dark' ); Ayni.setTheme( 'dark' ); true" );
    await sleep( 300 );
    await shot( "drive-undo-dark" );
    await ev( "Ayni.setTheme( null ); localStorage.removeItem( 'ayni-theme' ); true" );
    await ev( "document.activeElement && document.activeElement.blur(); true" );
    await key( "z", "KeyZ", 90, 2 );
    ok( await until( `!! document.querySelector( '${ROW( "files/a.txt" )}' )`, 6000 ) && fs.existsSync( `${RUN}/homes/test/files/a.txt` ), "Ctrl+Z while it shows: back" );
    ok( ! await ev( "!! document.querySelector( '#ayni-toasts .toast.undo' )" ), "…and the Undo toast is gone" );
    [ rx, ry ] = await centre( ROW( "files/b.txt" ) );
    await mouse( "mousePressed", rx, ry ); await mouse( "mouseReleased", rx, ry );
    await key( "Delete", "Delete", 46 );
    await until( "!! document.querySelector( '#ayni-toasts .toast.undo' )", 6000 );
    await ev( "Ayni.toast( 'info', 'News' ); true" );
    ok( await ev( "!! document.querySelector( '#ayni-toasts .toast.undo' )" ) && ( await shown() ).includes( "News" ), "news stacks beside the Undo and does not end it", await shown() );
    await ev( "document.querySelector( '#ayni-toasts .toast.undo .dismiss' ).click(); true" );
    ok( ! await ev( "!! document.querySelector( '#ayni-toasts .toast.undo' )" ), "closing the Undo makes it final" );
    await key( "z", "KeyZ", 90, 2 );
    await sleep( 1500 );
    ok( ! fs.existsSync( `${RUN}/homes/test/files/b.txt` ) && ! await ev( `!! document.querySelector( '${ROW( "files/b.txt" )}' )` ), "…and Ctrl+Z after that does nothing" );

    console.log( "PROGRESS - uploads and eMail's long jobs" );
    await ev( "document.querySelectorAll( '#ayni-toasts > .toast' ).forEach( x => x.remove() ); true" );
    await ev( "document.dispatchEvent( new CustomEvent( 'nayive:upload', { detail: { id: 'q', loaded: 30, total: 100 } } ) ); true" );
    await sleep( 300 );
    ok( ! await ev( "!! document.querySelector( '#ayni-toasts .toast.progress' )" ), "an upload shows nothing in its first 600 ms" );
    await sleep( 500 );
    const pr = await ev( "( p => p && [ p.querySelector( 'p' ).textContent, p.getAttribute( 'aria-valuenow' ) ].join( '|' ) )( document.querySelector( '#ayni-toasts .toast.progress' ) )" );
    ok( /30/.test( pr || "" ) && /\|30$/.test( pr || "" ), "then a progress notification: its text and 30 %", pr );
    await shot( "drive-upload" );
    await ev( "document.dispatchEvent( new CustomEvent( 'nayive:upload', { detail: { id: 'q', done: true } } ) ); true" );
    ok( await until( "! document.querySelector( '#ayni-toasts .toast.progress' )", 3000 ), "done: it goes" );
    await ev( "document.dispatchEvent( new CustomEvent( 'nayive:upload', { detail: { id: 'r', loaded: 1, total: 9 } } ) ); document.dispatchEvent( new CustomEvent( 'nayive:upload', { detail: { id: 'r', done: true } } ) ); true" );
    await sleep( 1300 );
    ok( ! await ev( "!! document.querySelector( '#ayni-toasts .toast.progress' )" ), "a quick upload never shows one" );
    await open( "email", 1280 );
    await ev( "window.__stopped = 0; NayiveMail.bar( 'Reading 5 of 50', 10, () => window.__stopped++ ); true" );
    ok( await until( "!! document.querySelector( '#ayni-toasts .toast.progress .stop' )", 2000 ), "eMail's bar: a progress notification with Stop" );
    await ev( "document.querySelector( '#ayni-toasts .toast.progress .stop' ).click(); true" );
    ok( await ev( "window.__stopped === 1 && ! document.querySelector( '#ayni-toasts .toast.progress' )" ), "Stop stops it, once, and it goes" );
    await ev( "window.__j = NayiveMail.job( 300 ); true" );
    ok( await until( "!! document.querySelector( '#ayni-toasts .toast.progress' )", 2000 ), "a job on 300 emails shows its bar" );
    await ev( "__j.step( 150 ); true" );
    ok( await ev( "document.querySelector( '#ayni-toasts .toast.progress' ).getAttribute( 'aria-valuenow' ) === '50'" ), "…which moves with its steps" );
    await ev( "__j.end(); true" );
    ok( ! await ev( "!! document.querySelector( '#ayni-toasts .toast.progress' )" ), "…and goes at its end" );

    console.log( "PHONES - over a bottom bar" );
    for( const theme of [ "light", "dark" ] )
    {
        await ev( `localStorage.setItem( 'ayni-theme', '${theme}' ); true` );
        await open( "calc", 390, 760 );
        await sleep( 1500 );
        await ev( "Ayni.toast( 'ok', 'Saved.' ); true" );
        await sleep( 400 );
        const g = JSON.parse( await ev( `JSON.stringify( [ document.getElementById( 'statusBar' ).getBoundingClientRect().top, document.getElementById( 'statusBar' ).getBoundingClientRect().bottom, innerHeight,
            document.getElementById( 'ayni-toasts' ).getBoundingClientRect().bottom, document.getElementById( 'ayni-toasts' ).getBoundingClientRect().left,
            innerWidth - document.getElementById( 'ayni-toasts' ).getBoundingClientRect().right ] )` ) );
        ok( g[ 1 ] >= g[ 2 ] - 2 && g[ 3 ] <= g[ 0 ] && g[ 4 ] === 16 && g[ 5 ] === 16, `${theme}: Calc, a toast sits above its status bar at the bottom, full width less 16 px`, g );
        await shot( "calc-phone-" + theme );
        await ev( "document.getElementById( 'statusBar' ).style.display = 'none'; true" );
        await sleep( 300 );
        const lift = await ev( "getComputedStyle( document.documentElement ).getPropertyValue( '--toasts-lift' ).trim()" );
        ok( lift === "0px", `${theme}: the bar hidden, no lift`, lift );
    }
    await ev( "localStorage.removeItem( 'ayni-theme' ); true" );

    console.log( "KINDS - an error stays, a plain one goes" );
    await open( "drive", 1280 );
    await ev( "Ayni.toast( 'err', 'Could not save.' ); Ayni.toast( 'ok', 'Saved.' ); true" );
    await sleep( 6500 );
    ok( ( await shown() ).join() === "Could not save.", "after 6 s the error is still there, the success has gone", await shown() );
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
