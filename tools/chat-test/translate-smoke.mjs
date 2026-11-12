// translate-smoke.mjs - Chat's "Translate and send" (the Send button's menu)
// in a real (headless) browser.
//
//   node tools/chat-test/translate-smoke.mjs
//
// A scratch server like tools/camera-test (own run-root in /tmp, a copy of
// client/apps, a user "test"); the real store/ is never touched. Nothing is
// sent: no translation engine works offline here, so it checks the parts
// that do not need one - the Language app's translator loads inside Chat,
// the menu row, the sheet, and how a translated text is drawn.
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "translate-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.mkdirSync( `${RUN}/homes/test/files`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 400 ) ) );
};

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    const ev = s => c.evaluate( s );
    const until = async ( s, ms = 6000 ) => { for( let t = 0; t < ms; t += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const open = async ( page ) =>
    {
        await c.send( "Page.navigate", { url: BASE + "/nayive/" + page } );
        await until( "window.Ayni && Ayni.ready && document.readyState === 'complete'", 8000 );
        await ev( "Ayni.ready.then( () => true )" );
    };
    await open( "index.html" );
    await ev( `fetch( '/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { user: 'test', password: 'test' } ) } ).then( r => r.status )` );
    await open( "chat/index.html" );
    ok( await until( "!! document.querySelector( '.composer .send' )" ), "Chat shows its composer" );

    // How a translated text is drawn, and its one-line form.
    const drawn = await ev( `( () => { const C = NayiveChat, d = document.createElement( 'div' );
        C.textNodes( d, 'Hola *mundo*' + C.ORIG + 'Hello world' );
        const o = d.querySelector( '.orig' );
        return { main: d.firstChild.textContent, bold: !! d.querySelector( 'b, strong' ), orig: o && o.textContent,
                 strip: C.stripMarks( 'Hola' + C.ORIG + 'Hello' ), plain: C.stripMarks( 'Hola' ) }; } )()` );
    ok( drawn.orig === "Hello world", "the original sits in its own small block", drawn );
    ok( drawn.bold && drawn.main.startsWith( "Hola" ), "the translation keeps its marks", drawn );
    ok( drawn.strip === "Hola" && drawn.plain === "Hola", "one-line places show the translation only", drawn );
    ok( await ev( "parseFloat( getComputedStyle( ( () => { const d = document.createElement( 'div' ); d.className = 'orig'; document.body.append( d ); return d; } )() ).fontSize ) < parseFloat( getComputedStyle( document.body ).fontSize )" ),
        "and in a smaller font" );

    // The menu row and the sheet (a chat id is faked: nothing is sent).
    await ev( `( () => { NayiveChat.S.open = 'x'; const ta = document.querySelector( '.composer textarea' ); ta.value = 'Hola'; return true; } )()` );
    await ev( "document.querySelector( '.composer .send' ).dispatchEvent( new MouseEvent( 'contextmenu', { bubbles: true } ) ), true" );
    await ev( "dispatchEvent( new PointerEvent( 'pointerup' ) ), true" );
    ok( await until( "[ ...document.querySelectorAll( '[popover] [role=menuitem], [popover] button' ) ].some( e => /Translate/.test( e.textContent ) && e.getClientRects().length )" ),
        "the Send menu offers \"Translate and send\"", await ev( "[ ...document.querySelectorAll( '[popover]' ) ].map( e => e.textContent.trim().slice( 0, 80 ) ).join( ' | ' )" ) );
    await ev( "[ ...document.querySelectorAll( '[popover] [role=menuitem], [popover] button' ) ].find( e => /Translate/.test( e.textContent ) ).click(), true" );
    ok( await until( "!! document.querySelector( 'dialog.tr-sheet[open]' )" ), "the sheet opens" );
    ok( await until( "document.querySelectorAll( 'dialog.tr-sheet .picker [role=listbox], dialog.tr-sheet .picker[data-picker]' ).length >= 2", 10000 ),
        "with the From and To pickers (the translator loaded inside Chat)",
        await ev( "document.querySelector( 'dialog.tr-sheet' ) && document.querySelector( 'dialog.tr-sheet' ).textContent" ) );
    ok( await ev( "[ ...document.querySelectorAll( 'dialog.tr-sheet .picker' ) ].every( p => p.getBoundingClientRect().height < 80 && getComputedStyle( p ).position !== 'fixed' )" ),
        "the pickers are plain drop-downs (not Chat's full-screen place picker)" );
    ok( await until( "( s => s && s.textContent && ! /could not start/.test( s.textContent ) )( document.querySelector( 'dialog.tr-sheet .tr-status' ) )" ),
        "and no load error", await ev( "document.querySelector( 'dialog.tr-sheet .tr-status' ).textContent" ) );
    ok( await ev( "document.querySelector( 'dialog.tr-sheet .btn.primary, dialog.tr-sheet button[data-kind=primary]' )?.disabled !== false" ),
        "Send waits for a translation" );
}
finally { await b.kill(); server.kill(); fs.rmSync( RUN, { recursive: true, force: true } ); }

console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "FAILED" : "ALL GREEN" );
process.exit( fail ? 1 : 0 );
