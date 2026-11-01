// run.mjs - Ayni's dialogs family in Nayive (dialog.panel, Ayni.confirm /
// alert / ask, the first field, Esc, Enter, moving, sizes), in a real
// (headless) browser: the rules on every page, then the behaviours.
//
//   node tools/dialogs-test/run.mjs            (SHOTS=/some/dir also saves screenshots)
//
// Same scratch server as tools/smoke-test (its own run-root in /tmp, a copy of
// client/apps, one user "test"); the real store/ is never touched.
//
// RULES, every app, phone and desktop width: no old sheet markup or API; Ayni's
//   family is loaded; every dialog in the page is a dialog.panel with its parts
//   in place (a lone × in the title row, never alone in a bottom row), opens as
//   modal at its size (small 300-460 px, big 880 px or full screen), and no
//   error on the page.
// BEHAVIOURS: Drive's New folder: the caret in the name, a dimmed-page click
//   keeps it, Esc closes it through its ×, Enter creates ONE folder; F2 +
//   Enter renames once; a danger confirm starts on Cancel; the info popup
//   shows above a dialog and takes the pointer; the help dialog's × in its
//   title row; moving by the title row (not on a phone); a big dialog fills a
//   tablet; Drive's progress ignores Esc.
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "dialogs-test-" ) );
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

// The rules, read off the page as it stands.
const RULES = `( async () => { const o = [];
    if( document.querySelector( '.sheet-backdrop, .sheet, .sheet-actions, .sheet-header, .sheet-close' ) ) o.push( 'old sheet markup' );
    if( window.NayiveUI && [ 'open', 'close', 'setOpen', 'modal', 'confirm', 'alert', 'askText', 'sheetButton', 'autoSave', 'onSheetClose' ].some( k => NayiveUI[ k ] ) ) o.push( 'old NayiveUI dialog API' );
    if( typeof Ayni.dialog !== 'function' || typeof Ayni.confirm !== 'function' ) return [ 'no Ayni dialogs family' ];
    for( const d of document.querySelectorAll( 'dialog' ) )
    {
        if( d.classList.contains( 'lock-dlg' ) ) continue;
        const id = d.id || '?';
        if( ! d.classList.contains( 'panel' ) ) { o.push( id + ': not a dialog.panel' ); continue; }
        const kids = [ ...d.children ].map( k => k.tagName.toLowerCase() + ( k.classList.contains( 'body' ) ? '.body' : '' ) );
        if( ! kids.includes( 'div.body' ) ) o.push( id + ': no .body' );
        const foot = d.querySelector( ':scope > footer' );
        if( foot && foot.children.length === 1 && foot.children[ 0 ].hasAttribute( 'data-close' ) ) o.push( id + ': a lone × in the bottom row' );
        if( d.open || d.classList.contains( 'map-dialog' ) ) continue;     // Trips' phone map: full screen on purpose
        d.showModal();
        const r = d.getBoundingClientRect(), vw = document.documentElement.clientWidth;
        const big = d.classList.contains( 'big' ), full = r.width >= vw - 1;
        if( ! d.matches( ':modal' ) ) o.push( id + ': not modal' );
        if( big ? ! ( full ? vw < 1024 : Math.round( r.width ) === 880 ) : ! ( r.width <= 461 && r.width <= vw - 31 && ( r.width >= 299 || r.width >= vw - 33 ) && ! full ) )
            o.push( id + ': size ' + Math.round( r.width ) + ' at ' + vw );
        d.close();
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
        await sleep( app === "write" ? 4000 : 1500 );
    };
    const mouse = async ( type, x, y ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( r => JSON.stringify( [ r.left + r.width / 2, r.top + r.height / 2 ] ) )( document.querySelector( ${JSON.stringify( sel )} ).getBoundingClientRect() )` ) );
    const key = async ( k, code, vk, modifiers = 0 ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers } ); };
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        await sleep( 300 );                       // past the dialog's fade-in
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

    const ROW = p => `#listing .row[data-path="${p}"]`;
    const press = async ( sel ) => { const [ x, y ] = await centre( sel ); await mouse( "mousePressed", x, y ); await mouse( "mouseReleased", x, y ); };
    const dirs = () => fs.readdirSync( `${RUN}/homes/test/files` ).filter( n => fs.statSync( `${RUN}/homes/test/files/${n}` ).isDirectory() ).sort();

    console.log( "NEW FOLDER - Drive" );
    await open( "drive", 1280 );
    ok( await until( `!! document.querySelector( '${ROW( "files/a.txt" )}' )`, 8000 ), "Drive lists a.txt" );
    await press( "#newFolderBtn" );
    ok( await until( "document.getElementById( 'newFolderBackdrop' ).matches( ':modal' )" ), "New folder opens as a modal dialog" );
    ok( await until( "document.activeElement && document.activeElement.id === 'newFolderName'" ), "the caret is in the name field" );
    await shot( "drive-newfolder-light" );
    await mouse( "mousePressed", 8, 8 ); await mouse( "mouseReleased", 8, 8 );
    await sleep( 200 );
    ok( await ev( "document.getElementById( 'newFolderBackdrop' ).open" ), "a click on the dimmed page keeps it open" );
    await key( "Escape", "Escape", 27 );
    ok( await until( "! document.getElementById( 'newFolderBackdrop' ).open" ), "Esc closes it (through its ×)" );
    const before = dirs();
    await press( "#newFolderBtn" );
    await until( "document.activeElement && document.activeElement.id === 'newFolderName'" );
    await c.send( "Input.insertText", { text: "Fotos" } );
    for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...( type === "keyDown" ? { text: "\r" } : {} ) } );
    ok( await until( `!! document.querySelector( '${ROW( "files/Fotos" )}' )`, 6000 ), "Enter creates it" );
    await sleep( 800 );
    const made = dirs().filter( n => ! before.includes( n ) );
    ok( made.join() === "Fotos", "…one folder, not two", made );
    ok( ! await ev( "document.getElementById( 'newFolderBackdrop' ).open" ), "…and the dialog closes" );

    console.log( "RENAME - Drive, F2 + Enter" );
    await press( ROW( "files/b.txt" ) );
    await key( "F2", "F2", 113 );
    ok( await until( "document.getElementById( 'renameBackdrop' ).open && document.activeElement.id === 'renameName'" ), "F2 opens Rename with the caret in the name" );
    await ev( "( i => { i.value = 'c.txt'; i.dispatchEvent( new Event( 'input', { bubbles: true } ) ); } )( document.getElementById( 'renameName' ) ); true" );
    for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...( type === "keyDown" ? { text: "\r" } : {} ) } );
    ok( await until( `!! document.querySelector( '${ROW( "files/c.txt" )}' )`, 6000 ), "Enter renames it" );
    await sleep( 800 );
    ok( fs.existsSync( `${RUN}/homes/test/files/c.txt` ) && ! fs.existsSync( `${RUN}/homes/test/files/b.txt` ) && ! await ev( "!! document.querySelector( '#ayni-toasts .toast.err' )" ), "…once: c.txt there, b.txt gone, no error" );

    console.log( "CONFIRM, INFO POPUP, HELP - Drive" );
    await ev( "window.__r = 'pending'; Ayni.confirm( { title: 'Delete?', body: 'Gone for good.', danger: true, confirm: 'Delete' } ).then( v => window.__r = v ); true" );
    await sleep( 200 );
    ok( await ev( "document.activeElement.hasAttribute( 'data-close' ) && !! document.activeElement.closest( 'dialog.panel' )" ), "a danger confirm starts on Cancel" );
    await shot( "drive-confirm-light" );
    await key( "Escape", "Escape", 27 );
    ok( await until( "window.__r === false" ), "Esc answers false" );
    await press( "#newFolderBtn" );
    await until( "document.getElementById( 'newFolderBackdrop' ).open" );
    await ev( "( b => { const d = document.createElement( 'button' ); d.type = 'button'; d.className = 'info-tip'; d.id = 'probeDot'; d.setAttribute( 'data-help', 'A probe text that explains something.' ); b.appendChild( d ); Ayni.init( d ); } )( document.querySelector( '#newFolderBackdrop .body' ) ); true" );
    await press( "#probeDot" );
    ok( await until( "!! document.querySelector( '.info-pop:popover-open' )" ), "an info tip in a dialog opens its popup" );
    ok( await ev( "( p => { const r = p.getBoundingClientRect(); const h = document.elementFromPoint( r.left + r.width / 2, r.top + r.height / 2 ); return !! h && p.contains( h ); } )( document.querySelector( '.info-pop' ) )" ), "…above the dialog, and it takes the pointer" );
    await key( "Escape", "Escape", 27 );
    ok( await until( "! document.querySelector( '.info-pop:popover-open' )" ) && await ev( "document.getElementById( 'newFolderBackdrop' ).open" ), "Esc closes the popup first, the dialog stays" );
    await key( "Escape", "Escape", 27 );
    await until( "! document.getElementById( 'newFolderBackdrop' ).open" );
    await ev( "document.getElementById( 'probeDot' ).remove(); true" );
    await press( "[data-help-open]" );
    ok( await until( "!! document.querySelector( 'dialog.panel.help-card[open] > header > [data-close]' )" ), "the help dialog: its × in the title row" );
    await shot( "drive-help-light" );
    await key( "Escape", "Escape", 27 );
    ok( await until( "! document.querySelector( 'dialog.panel.help-card' )" ), "…Esc closes and removes it" );

    console.log( "MOVING - by the title row" );
    await press( "#newFolderBtn" );
    await until( "document.getElementById( 'newFolderBackdrop' ).open" );
    const L0 = await ev( "document.getElementById( 'newFolderBackdrop' ).getBoundingClientRect().left" );
    const [ hx, hy ] = await centre( "#newFolderBackdrop > header h2" );
    await mouse( "mousePressed", hx, hy );
    for( let i = 1; i <= 5; i++ ) await c.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: hx + i * 20, y: hy, button: "left", buttons: 1, pointerType: "mouse" } );
    await mouse( "mouseReleased", hx + 100, hy );
    ok( Math.round( await ev( "document.getElementById( 'newFolderBackdrop' ).getBoundingClientRect().left" ) - L0 ) === 100, "a drag on the title row moves it" );
    await key( "Escape", "Escape", 27 );
    await until( "! document.getElementById( 'newFolderBackdrop' ).open" );
    await press( "#newFolderBtn" );
    await until( "document.getElementById( 'newFolderBackdrop' ).open" );
    const mid = await ev( "( r => r.left + r.width / 2 - document.documentElement.clientWidth / 2 )( document.getElementById( 'newFolderBackdrop' ).getBoundingClientRect() )" );
    ok( Math.abs( mid ) < 2, "…and it opens centred again", mid );
    await key( "Escape", "Escape", 27 );

    console.log( "PROGRESS - Esc does not close it" );
    await ev( "document.getElementById( 'progressBackdrop' ).showModal(); true" );
    await key( "Escape", "Escape", 27 );
    await sleep( 300 );
    ok( await ev( "document.getElementById( 'progressBackdrop' ).open" ), "Drive's progress stays on Esc" );
    await ev( "document.getElementById( 'progressBackdrop' ).close(); true" );

    console.log( "SIZES AND THEMES" );
    await open( "bookmarks", 800, 900 );
    await ev( "document.getElementById( 'dupBackdrop' ).showModal(); true" );
    const bg = JSON.parse( await ev( "( d => JSON.stringify( [ d.getBoundingClientRect().width, document.documentElement.clientWidth, getComputedStyle( d.querySelector( 'header' ) ).backgroundColor ] ) )( document.getElementById( 'dupBackdrop' ) )" ) );
    ok( bg[ 0 ] >= bg[ 1 ] - 1 && bg[ 2 ] !== "rgba(0, 0, 0, 0)", "a big dialog fills a tablet, its title row a strip", bg );
    ok( await ev( "( d => Math.abs( d.querySelector( 'footer' ).getBoundingClientRect().bottom - d.getBoundingClientRect().bottom ) < 2 )( document.getElementById( 'dupBackdrop' ) )" ), "…its bottom row at the bottom" );
    await shot( "bookmarks-big-tablet" );
    for( const theme of [ "light", "dark" ] )
    {
        await ev( `localStorage.setItem( 'ayni-theme', '${theme}' ); true` );
        await open( "calendar", 390, 760 );
        await ev( "document.getElementById( 'goToBackdrop' ).showModal(); true" );
        await sleep( 300 );
        const g = JSON.parse( await ev( "( d => JSON.stringify( [ d.getBoundingClientRect().width, innerWidth, getComputedStyle( d.querySelector( 'footer' ) ).borderTopWidth ] ) )( document.getElementById( 'goToBackdrop' ) )" ) );
        ok( g[ 0 ] < g[ 1 ] && g[ 2 ] === "1px", `${theme}: on a phone a small dialog floats, a line over its bottom row`, g );
        await shot( "calendar-goto-phone-" + theme );
        const L1 = await ev( "document.getElementById( 'goToBackdrop' ).getBoundingClientRect().left" );
        const [ px, py ] = await centre( "#goToBackdrop > header h2" );
        await mouse( "mousePressed", px, py );
        for( let i = 1; i <= 5; i++ ) await c.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: px + i * 10, y: py, button: "left", buttons: 1, pointerType: "mouse" } );
        await mouse( "mouseReleased", px + 50, py );
        ok( await ev( "document.getElementById( 'goToBackdrop' ).getBoundingClientRect().left" ) === L1, `${theme}: …and does not move` );
    }
    await ev( "localStorage.removeItem( 'ayni-theme' ); true" );
    await open( "drive", 1280 );
    await ev( "localStorage.setItem( 'ayni-theme', 'dark' ); Ayni.setTheme( 'dark' ); true" );
    await press( "#newFolderBtn" );
    await until( "document.getElementById( 'newFolderBackdrop' ).open" );
    await sleep( 300 );
    await shot( "drive-newfolder-dark" );
    await ev( "Ayni.setTheme( null ); localStorage.removeItem( 'ayni-theme' ); true" );
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
