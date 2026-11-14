// run.mjs - SOS (shared/sos.js + server/go/sos.go) in a real (headless) browser.
//
//   node tools/sos-test/run.mjs      (SHOTS=/some/dir also saves screenshots)
//
// Its own scratch run-root in /tmp (users "test" and "ana"); the real store/
// is never touched.
//
// No contacts: no SOS button, but "SOS" in My account's header. The settings
// dialog: tick a contact -> the red button appears, at the left of the top row.
// The red screen: Cancel sends nothing; Send now sends one alert and says who
// was reached. ?sos=<id> shows the alert; ?sosok=1 answers "Are you OK?".
// Phone width: the button still sits first in the row.
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "sos-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
for( const [ u, pw ] of [ [ "test", "test" ], [ "ana", "ana" ] ] )
{
    fs.mkdirSync( `${RUN}/homes/${u}/data`, { recursive: true } );
    fs.mkdirSync( `${RUN}/homes/${u}/files`, { recursive: true } );
    fs.writeFileSync( `${RUN}/homes/${u}/data/config.json`, JSON.stringify( { password: pw } ) );
}
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }
const alerts = () => { try { return JSON.parse( fs.readFileSync( `${RUN}/config/sos.json`, "utf8" ) ).alerts || []; } catch { return []; } };

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 600 ) ) );
};
const SHOTS = process.env.SHOTS || "";

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Page.bringToFront" );
    const size = ( w, h = 800 ) => c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 } );
    const ev = ( s ) => c.evaluate( s );
    const until = async ( s, ms = 5000 ) => { for( let i = 0; i < ms; i += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const open = async ( url, w ) =>
    {
        await size( w );
        await c.send( "Page.navigate", { url: BASE + "/nayive/" + url } );
        await until( "window.Ayni && Ayni.ready && document.readyState === 'complete'", 8000 );
        await ev( "Ayni.ready.then( () => true )" );
        await sleep( 1200 );
    };
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        await sleep( 300 );
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    };
    const errors = () => c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]|navigator\.vibrate/.test( l ) );
    const click = ( sel ) => ev( `( e => { e.click(); true } )( document.querySelector( ${JSON.stringify( sel )} ) )` );

    await size( 1280 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en'); localStorage.setItem('balata-desktop','never');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "SETTINGS" );
    c.logs.length = 0;
    await open( "index.html", 1280 );
    ok( await until( "!! document.getElementById('sosBtn') && document.getElementById('sosBtn').classList.contains('off')" ), "no contacts: the SOS button is there (off)" );
    await click( "#sosBtn" );
    ok( await until( "!! document.querySelector('#ayni-info:popover-open') && /SOS is off/.test( document.getElementById('ayni-info').textContent )" ), "...a tap shows how to turn it on" );
    ok( await ev( "! document.querySelector('.sos-screen')" ), "...and starts nothing" );
    await click( "#sosBtn" );
    ok( await until( "!! document.getElementById('sosSetBtn')" ), "\"SOS\" in My account's header" );
    await click( "#sosSetBtn" );
    ok( await until( "document.getElementById('sosBackdrop') && document.getElementById('sosBackdrop').open" ), "the settings dialog opens" );
    ok( await ev( "[ ...document.querySelectorAll('#sosContacts [role=option]') ].map( s => s.textContent ).join() === 'ana'" ), "the other user is offered" );
    ok( await ev( "[ ...document.querySelectorAll('#sosBackdrop .sos-quiet .time-field input') ].map( i => i.value ).join() === '23:00,08:00'" ), "quiet hours in 24 hours" );
    await shot( "settings" );
    await ev( "document.querySelector('#sosContacts [role=option]').dispatchEvent( new MouseEvent( 'mousedown', { bubbles: true } ) ); true" );
    ok( await until( "!! document.getElementById('sosBtn') && ! document.getElementById('sosBtn').classList.contains('off')" ), "a contact ticked: the SOS button is on" );
    const pos = await ev( `JSON.stringify( [ document.getElementById('sosBtn').getBoundingClientRect().left, document.getElementById('lsField').getBoundingClientRect().left,
        getComputedStyle( document.getElementById('sosBtn') ).backgroundColor ] )` );
    const [ sl, fl, bg ] = JSON.parse( pos );
    ok( sl < fl && bg === "rgb(150, 35, 6)", "red, left of the search field", pos );
    await ev( "document.getElementById('sosBackdrop').close(); true" );

    console.log( "THE RED SCREEN" );
    await click( "#sosBtn" );
    ok( await until( "!! document.querySelector('.sos-screen .sos-count')" ), "the countdown shows" );
    await shot( "countdown" );
    await click( ".sos-screen .sos-cancel" );
    await sleep( 6000 );
    ok( await ev( "! document.querySelector('.sos-screen')" ) && alerts().length === 0, "Cancel sends nothing", alerts() );
    await click( "#sosBtn" );
    await until( "!! document.querySelector('.sos-screen .sos-now')" );
    await click( ".sos-screen .sos-now" );
    ok( await until( "!! document.querySelector('.sos-screen .sos-to')" ), "Send now: says who was told" );
    ok( await ev( "/ana/.test( document.querySelector('.sos-screen .sos-to').textContent )" ), "...ana is listed", await ev( "document.querySelector('.sos-screen').innerText" ) );
    await shot( "sent" );
    const as = alerts();
    ok( as.length === 1 && as[ 0 ].kind === "sos" && as[ 0 ].to[ 0 ].user === "ana", "one SOS alert on the server", as );
    await click( ".sos-screen .sos-cancel" );

    console.log( "DANGER WATCH (held down)" );
    const myRow = () => { try { return JSON.parse( fs.readFileSync( `${RUN}/config/sos.json`, "utf8" ) ).users.find( u => u.owner === "test" ) || {}; } catch { return {}; } };
    const hold = () => ev( `( b => { b.dispatchEvent( new PointerEvent( 'pointerdown', { bubbles: true, button: 0 } ) ); setTimeout( () => b.dispatchEvent( new PointerEvent( 'pointerup', { bubbles: true } ) ), 900 ); true } )( document.getElementById('sosBtn') )` );
    await hold();
    ok( await until( "!! document.querySelector('.sos-screen.watch .sos-count')" ), "held down: the watch screen" );
    ok( await until( "/^1:2\\d$/.test( document.querySelector('.sos-screen.watch .sos-count').textContent )" ), "...counting from 1:30", await ev( "document.querySelector('.sos-screen.watch .sos-count').textContent" ) );
    await sleep( 500 );
    ok( myRow().watch > Date.now() / 1000 + 60, "...and the SERVER counts", myRow() );
    await shot( "watch" );
    await open( "index.html", 1280 );
    ok( await until( "!! document.querySelector('.sos-screen.watch .sos-count')" ), "the page opened again: the watch screen is back" );
    await click( ".sos-screen.watch .sos-cancel" );
    ok( await until( "! document.querySelector('.sos-screen')" ), "I'm safe: the screen goes" );
    await sleep( 300 );
    ok( ! myRow().watch && alerts().filter( a => a.kind === "watch" ).length === 0, "...the server stopped it, nothing sent", myRow() );
    await hold();
    await until( "!! document.querySelector('.sos-screen.watch .sos-now')" );
    await click( ".sos-screen.watch .sos-now" );
    ok( await until( "!! document.querySelector('.sos-screen .sos-to')" ), "Send now: says who was told" );
    ok( alerts().filter( a => a.kind === "watch" ).length === 1, "one watch alert on the server", alerts() );
    await click( ".sos-screen .sos-cancel" );   // "I'm safe", first after the send
    ok( await until( "! document.querySelector('.sos-screen')" ), "I'm safe after it went out: the screen goes" );
    await sleep( 300 );
    ok( alerts().filter( a => a.kind === "safe" ).length === 1, "...and the contacts are told \"safe\"", alerts() );

    console.log( "DANGER PIN" );
    const put = await ev( "fetch('/api/sos/pin',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'1234'})}).then(r=>r.status)" );
    ok( put === 200 && /^\$pbkdf2/.test( myRow().pin || "" ), "a PIN is set, stored hashed", myRow().pin );
    await open( "index.html", 1280 );
    await click( "#sosSetBtn" );
    ok( await until( "document.querySelectorAll('#sosBackdrop .sos-pin-in').length === 2" ), "settings: current + new PIN fields" );
    await ev( "document.getElementById('sosBackdrop').close(); true" );
    const pinIn = ( v ) => ev( `( f => { f.querySelector('input').value = ${JSON.stringify( v )}; f.requestSubmit(); true } )( document.querySelector('.sos-screen .sos-pin') )` );
    await hold();
    ok( await until( "!! document.querySelector('.sos-screen.watch .sos-count')" ), "held down: the watch screen" );
    await sleep( 500 );
    await click( ".sos-screen.watch .sos-cancel" );
    ok( await until( "!! document.querySelector('.sos-screen .sos-pin input')" ) && await ev( "!! document.querySelector('.sos-screen.watch')" ), "I'm safe asks for the PIN, the screen stays" );
    await shot( "pin" );
    await pinIn( "12" );
    await sleep( 400 );
    ok( await ev( "!! document.querySelector('.sos-screen.watch')" ) && ! alerts().some( a => a.kind === "forced" ), "too short: nothing happens" );
    await pinIn( "9999" );
    ok( await until( "! document.querySelector('.sos-screen')" ), "a wrong PIN: the screen goes, as if stopped" );
    await sleep( 300 );
    ok( alerts().filter( a => a.kind === "forced" ).length === 1 && myRow().watchAlert && ! myRow().watch, "...but \"forced\" went out and it stays open", myRow() );
    await open( "index.html", 1280 );
    ok( await ev( "! document.querySelector('.sos-screen')" ), "the page opened again shows nothing" );
    await hold();
    await until( "!! document.querySelector('.sos-screen.watch .sos-cancel')" );
    await sleep( 500 );
    await click( ".sos-screen.watch .sos-cancel" );
    await until( "!! document.querySelector('.sos-screen .sos-pin input')" );
    const safeBefore = alerts().filter( a => a.kind === "safe" ).length;
    await pinIn( "1234" );
    ok( await until( "! document.querySelector('.sos-screen')" ), "the right PIN: the screen goes" );
    await sleep( 300 );
    ok( alerts().filter( a => a.kind === "safe" ).length === safeBefore + 1 && ! myRow().watchAlert && ! myRow().watch, "...really stopped, the contacts told \"safe\"", myRow() );

    console.log( "LINKS" );
    await open( "index.html?sos=" + ( as[ 0 ] || {} ).id, 1280 );
    ok( await until( "!! document.querySelector('.sos-screen h2') && /SOS - test/.test( document.querySelector('.sos-screen h2').textContent )" ), "?sos=<id> shows the alert" );
    ok( await ev( "! /sos=/.test( location.search )" ), "...and leaves the address clean" );
    await shot( "alert" );
    await open( "index.html?sosok=1", 1280 );
    ok( await until( "/all good/i.test( document.body.innerText )" ), "?sosok=1 answers \"Are you OK?\"" );

    console.log( "PHONE" );
    await open( "index.html", 390 );
    ok( await until( "!! document.getElementById('sosBtn')" ), "the button is there on a phone" );
    const ph = await ev( `JSON.stringify( [ ...document.getElementById('lsBox').children ].filter( e => e.offsetParent ).map( e => [ e.id || e.className, Math.round( e.getBoundingClientRect().left ) ] ) )` );
    const row = JSON.parse( ph ).sort( ( a, b ) => a[ 1 ] - b[ 1 ] );
    ok( row.length && row[ 0 ][ 0 ] === "sosBtn", "...first in the top row", ph );
    await shot( "phone" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "DESKTOP - the launcher in the desktop's menu" );
    await ev( "localStorage.setItem('balata-desktop','always'); true" );
    c.logs.length = 0;
    await open( "desktop/", 1280 );
    const MF = "document.querySelector('#menu iframe')";
    const IN = ( js ) => `( () => { const w = ${MF}.contentWindow, d = w.document; return ( ${js} ); } )()`;
    await ev( "document.getElementById('menuBtn').click(); true" );
    ok( await until( IN( "w.Ayni && !! d.getElementById('sosBtn') && ! d.getElementById('sosBtn').hidden" ), 8000 ), "the SOS button in the desktop's menu" );
    await ev( IN( "d.getElementById('sosBtn').click(), true" ) );
    ok( await until( IN( "!! d.querySelector('.sos-screen .sos-count')" ) ), "the countdown shows there" );
    const box = await ev( IN( "JSON.stringify( [ d.querySelector('.sos-screen').getBoundingClientRect().width, w.innerWidth ] )" ) );
    ok( JSON.parse( box )[ 0 ] === JSON.parse( box )[ 1 ], "...over the whole menu", box );
    await shot( "desktop" );
    await ev( IN( "d.querySelector('.sos-screen .sos-cancel').click(), true" ) );
    ok( ! errors().length, "no errors on the desktop", errors() );
}
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "SOME FAILED" : "ALL GREEN" );
process.exit( fail ? 1 : 0 );
