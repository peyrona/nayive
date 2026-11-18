// run.mjs - the launcher's search (shared/launcher-search.js + /api/search) in a
// real (headless) browser.
//
//   node tools/launcher-search-test/run.mjs      (SHOTS=/some/dir also saves screenshots)
//
// Its own scratch run-root in /tmp (one user "test" with files, contacts,
// events and a chat); the real store/ is never touched.
//
// THE FIELD: apps, contacts (umlaut spelt out), files, events as you type; the
//   arrows and Enter open the picked row (a real link); Esc clears; a shortcut
//   makes Enter open the dialog. THE DIALOG: the words carried over, groups per
//   kind, shortcuts become choices, a filter a kind cannot test hides it
//   (from: -> mail + chats only; type: -> files only), "no mail account".
// PHONE: the field folds behind a magnifier. Planner passes ?date= on to its
//   Calendar. Drive still boots (its kinds come from shared/file-kinds.js).
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "textsize-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = `${RUN}/homes/test`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${HOME}/data/chat/conv/d-p1`, { recursive: true } );
fs.mkdirSync( `${HOME}/files/Facturas`, { recursive: true } );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${HOME}/data/config.json`, JSON.stringify( { password: "test" } ) );
fs.writeFileSync( `${HOME}/files/Facturas/factura-luz.pdf`, "%PDF-1.4" );
fs.writeFileSync( `${HOME}/files/notas.txt`, "x" );
fs.writeFileSync( `${HOME}/files/informe.docx`, "x" );
fs.writeFileSync( `${HOME}/data/contacts.vcf`, [ "BEGIN:VCARD", "VERSION:3.0", "UID:c-jose", "FN:José Müller", "EMAIL:jose@x.es",
    "TEL:+34 600 11 22 33", "END:VCARD", "" ].join( "\r\n" ) );
const t = ( d ) => new Date( Date.now() + d * 86400000 ).toISOString().replace( /[-:]/g, "" ).slice( 0, 15 ) + "Z";
fs.writeFileSync( `${HOME}/data/calendar.ics`, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" +
    `BEGIN:VEVENT\r\nUID:e1\r\nDTSTART:${t( 2 )}\r\nSUMMARY:Dentista\r\nLOCATION:Calle Mayor\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:e2\r\nDTSTART:${t( -9 )}\r\nSUMMARY:Pagar factura\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` );
fs.writeFileSync( `${HOME}/data/chat/chat.json`, JSON.stringify( { me: { name: "Test" }, contacts: [ { id: "p1", name: "Pepe", created: 1 } ], groups: [] } ) );
const now = Date.now();
fs.writeFileSync( `${HOME}/data/chat/conv/d-p1/${new Date( now ).toISOString().slice( 0, 7 )}.json`, JSON.stringify( { messages: [
    { id: 1, rev: 1, at: now - 5000, from: "p1", kind: "text", text: "Te paso la factura mañana" },
    { id: 2, rev: 2, at: now - 4000, from: "o", kind: "text", text: "Vale, gracias" } ] } ) );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

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
    const key = async ( k, code, vk ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk } ); await sleep( 80 ); };
    const typeIn = async ( sel, text ) => { await ev( `( i => { i.focus(); i.value = ${JSON.stringify( text )}; i.dispatchEvent( new Event( 'input', { bubbles: true } ) ); } )( document.querySelector( ${JSON.stringify( sel )} ) ); true` ); };
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        await sleep( 300 );
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    };
    const errors = () => c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]/.test( l ) );
    const QUICK = "document.getElementById('lsQuick')";
    const groups = ( box ) => `[ ...${box}.querySelectorAll('.ls-group') ].map( g => g.dataset.kind ).join(',')`;
    const hrefs = ( box ) => `[ ...${box}.querySelectorAll('.ls-row') ].map( a => a.getAttribute('href') ).join(' ')`;

    await size( 1280 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('nayive-sos-tip','1'); localStorage.setItem('ayni-lang','en'); localStorage.setItem('balata-desktop','never');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );
    await sleep( 1500 );
    await open( "index.html", 1280 );
    const sel = "document.getElementById('textSizeSel')";
    ok( await ev( `!!${sel}` ), "Account has the text size picker" );
    ok( await ev( `document.documentElement.style.fontSize === ''` ), "Normal by default" );
    // a desktop-like window: Drive in a frame
    await ev( `( f => { f.src = 'drive/'; f.setAttribute('data-ayni-window',''); f.style.cssText='width:800px;height:600px'; document.body.append( f ); f.id='tsF'; } )( document.createElement('iframe') ); true` );
    await until( "document.getElementById('tsF').contentWindow.Ayni?.textSize", 8000 ); await sleep( 800 );
    const before = await ev( `parseFloat( getComputedStyle( document.getElementById('tsF').contentDocument.querySelector('.btn, button') ).fontSize )` );
    await ev( `Ayni.picker( ${sel} ).choose( '130' ); true` );
    await sleep( 400 );
    ok( await ev( `document.documentElement.style.fontSize` ) === "130%", "launcher html is 130%" );
    ok( await ev( `localStorage.getItem('ayni-text-size')` ) === "130", "saved on the device" );
    ok( await ev( `document.getElementById('tsF').contentDocument.documentElement.style.fontSize` ) === "130%", "open window follows live" );
    const after = await ev( `parseFloat( getComputedStyle( document.getElementById('tsF').contentDocument.querySelector('.btn, button') ).fontSize )` );
    ok( after > before * 1.2, "window text grew", { before, after } );
    await open( "calendar/", 1280 );
    ok( await ev( `document.documentElement.style.fontSize` ) === "130%", "a fresh app starts at 130%" );
    await ev( `Ayni.textSize.set( 100 ); true` );
    ok( await ev( `localStorage.getItem('ayni-text-size') === null && document.documentElement.style.fontSize === ''` ), "Normal clears it" );
    ok( errors().length === 0, "no errors", errors() );
} finally { await b.kill(); try { server.kill(); } catch {} try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {} }
console.log( pass + " passed, " + fail + " failed" ); process.exit( fail ? 1 : 0 );
