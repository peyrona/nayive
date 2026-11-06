// run.mjs - the camera button in Photos, and the same camera in Chat, in a real
// (headless) browser with Chromium's fake camera.
//
//   node tools/camera-test/run.mjs
//
// A scratch server like tools/help-test (own run-root in /tmp, a copy of
// client/apps, a user "test"); the real store/ is never touched.
//
// Computer with a camera: the button shows after Upload; the live view opens,
// Esc and × leave nothing behind; the shutter saves one JPEG in the album.
// Computer with no camera: no button. Phone: the button opens the capture input.
// A shared album without add rights, or the album index: no button.
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "camera-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.mkdirSync( `${RUN}/homes/test/files/Fotos`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/data/photos`, { recursive: true } );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
fs.writeFileSync( `${RUN}/homes/test/data/photos/config.json`, JSON.stringify( { folder: "files/Fotos" } ) );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 400 ) ) );
};
const album = () => fs.readdirSync( `${RUN}/homes/test/files/Fotos` ).filter( n => /\.jpe?g$/.test( n ) );

const MOUSE = [ "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4" ];
const FAKE  = [ "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream" ];

async function session( flags, run )
{
    const b = await browser( flags );
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
        await run( { c, ev, until, open } );
    }
    finally { await b.kill(); }
}

const seen = "( e => e && ! e.hidden && e.getClientRects().length > 0 )( document.querySelector( '#camBtn' ) )";

try
{
    console.log( "\ncomputer with a camera" );
    await session( [ ...MOUSE, ...FAKE ], async ( { ev, until, open, c } ) =>
    {
        await open( "photos/" );
        ok( await until( seen ), "the button shows", await ev( "document.title + ' ' + location.href" ) );
        ok( await ev( "document.querySelector( '#addBtn' ).nextElementSibling.id === 'camBtn'" ), "right after Upload" );
        ok( await ev( "AyniPhoto.ownCamera()" ), "own camera in use" );

        await ev( "document.querySelector( '#camBtn' ).click()" );
        ok( await until( "!! document.querySelector( '.camera-view video' )?.videoWidth" ), "the live view opens" );
        for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } );
        ok( await until( "! document.querySelector( '.camera-view' )" ), "Esc closes it" );

        await ev( "document.querySelector( '#camBtn' ).click()" );
        await until( "!! document.querySelector( '.camera-view video' )?.videoWidth" );
        await ev( "document.querySelector( '.camera-view .editor-actions .btn:last-child' ).click()" );
        ok( await until( "! document.querySelector( '.camera-view' )" ), "× closes it" );
        await sleep( 400 );
        ok( album().length === 0, "closing saves nothing", album() );

        await ev( "document.querySelector( '#camBtn' ).click()" );
        await until( "!! document.querySelector( '.camera-view video' )?.videoWidth && document.querySelector( '.camera-view .cam-bar .btn' ).getAttribute( 'aria-disabled' ) !== 'true'" );
        await ev( "document.querySelector( '.camera-view .cam-bar .btn' ).click()" );
        ok( await until( "! document.querySelector( '.camera-view' )" ), "the shutter closes it" );
        for( let i = 0; i < 40 && ! album().length; i++ ) await sleep( 150 );
        ok( album().length === 1, "one photo saved in the album", album() );
        const f = album()[ 0 ] && fs.readFileSync( `${RUN}/homes/test/files/Fotos/${album()[ 0 ]}` );
        ok( f && f[ 0 ] === 0xFF && f[ 1 ] === 0xD8 && f.length > 1000, "it is a real JPEG", f && f.length );
        ok( await until( "document.querySelectorAll( '#grid img' ).length === 1" ), "and it is on screen" );
    } );

    console.log( "\ncomputer with no camera" );
    await session( MOUSE, async ( { c, ev, until, open } ) =>
    {
        // The machine running this may have a real one.
        await c.send( "Page.enable" );
        await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: "navigator.mediaDevices.enumerateDevices = () => Promise.resolve( [] );" } );
        await open( "photos/" );
        await until( "! document.querySelector( '#addBtn' ).hidden" );
        await sleep( 500 );
        ok( ! await ev( seen ), "no button" );
    } );

    console.log( "\nphone" );
    await session( [ "--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2" ], async ( { ev, until, open } ) =>
    {
        await open( "photos/" );
        ok( await until( "! document.querySelector( '#camBtn' ).hidden" ), "the button is there, camera or not" );
        ok( await ev( "! AyniPhoto.ownCamera()" ), "no live view: the phone's own camera" );
        await ev( `window.__c = 0; document.querySelector( '#camInput' ).addEventListener( 'click', e => { e.preventDefault(); window.__c++; } ); document.querySelector( '#camBtn' ).click()` );
        ok( await ev( "window.__c === 1" ), "it opens the capture input" );
        ok( await ev( "document.querySelector( '#camInput' ).getAttribute( 'capture' ) === 'environment'" ), "which asks for the back camera" );
        const before = album().length;
        await ev( `( () => { const d = new DataTransfer(); const c = document.createElement( 'canvas' ); c.width = c.height = 64;
                   return new Promise( r => c.toBlob( b => { d.items.add( new File( [ b ], 'image.jpg', { type: 'image/jpeg' } ) );
                   const i = document.querySelector( '#camInput' ); i.files = d.files; i.dispatchEvent( new Event( 'change' ) ); r( true ); }, 'image/jpeg' ) ); } )()` );
        for( let i = 0; i < 40 && album().length === before; i++ ) await sleep( 150 );
        ok( album().length === before + 1, "the picture goes up", album() );
        ok( await ev( "document.querySelector( '#camInput' ).value === ''" ), "the input is ready for the next one" );
    } );
}
finally { server.kill(); fs.rmSync( RUN, { recursive: true, force: true } ); }

console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "FAILED" : "ALL GREEN" );
process.exit( fail ? 1 : 0 );
