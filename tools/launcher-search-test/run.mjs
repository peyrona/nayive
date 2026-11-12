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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "launcher-search-test-" ) );
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
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en'); localStorage.setItem('balata-desktop','never');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "THE FIELD" );
    c.logs.length = 0;
    await open( "index.html", 1280 );
    ok( await ev( "! document.getElementById('lsField').classList.contains('fold') && !! document.querySelector('#lsField .filter-btn')" ), "a plain field with its funnel inside" );
    await typeIn( "#lsInput", "calc" );
    ok( await until( `${groups( QUICK )}.startsWith('apps') && /calc\\/index\\.html/.test( ${hrefs( QUICK )} )` ), "an app by its name", await ev( QUICK + ".innerText" ) );
    await typeIn( "#lsInput", "mueller" );
    ok( await until( `/contact\\/index\\.html\\?uid=c-jose/.test( ${hrefs( QUICK )} )` ), "a contact, umlaut spelt out", await ev( QUICK + ".innerText" ) );
    await typeIn( "#lsInput", "factura" );
    ok( await until( `${groups( QUICK )} === 'files,events'` ), "files and events together (mail and chats not asked here)", await ev( groups( QUICK ) ) );
    ok( await ev( `/drive\\/index\\.html\\?open=files%2FFacturas%2Ffactura-luz\\.pdf/.test( ${hrefs( QUICK )} ) && /planner\\/index\\.html\\?date=\\d{4}-\\d\\d-\\d\\d/.test( ${hrefs( QUICK )} )` ),
        "a PDF opens through Drive, an event on its day in Planner", await ev( hrefs( QUICK ) ) );
    await typeIn( "#lsInput", "informe" );
    ok( await until( `/write\\/index\\.html\\?file=files%2Finforme\\.docx/.test( ${hrefs( QUICK )} )` ), "a .docx opens in Write", await ev( hrefs( QUICK ) ) );
    await typeIn( "#lsInput", "dentista" );
    ok( await until( `/Calle Mayor/.test( ${QUICK}.innerText )` ), "an event shows where", await ev( QUICK + ".innerText" ) );
    await shot( "quick" );
    await typeIn( "#lsInput", "zzqqxx" );
    ok( await until( `${QUICK}.querySelector('.ls-note') && ! ${QUICK}.querySelector('.ls-row')` ), "nothing found says so" );
    await key( "Escape", "Escape", 27 );
    ok( await until( `document.getElementById('lsInput').value === '' && ${QUICK}.hidden` ), "Esc clears and closes the list" );
    // arrows + Enter open the picked row
    await typeIn( "#lsInput", "notas" );
    await until( `/text\\/index\\.html/.test( ${hrefs( QUICK )} )` );
    await key( "Enter", "Enter", 13 );
    ok( await until( "location.pathname.endsWith('/text/index.html') && location.search.includes('notas')" ), "Enter opens the row (Text, notas.txt)", await ev( "location.href" ) );

    console.log( "THE DIALOG" );
    await open( "index.html", 1280 );
    c.logs.length = 0;
    await typeIn( "#lsInput", "factura" );
    await ev( "document.querySelector('#lsField .filter-btn').click(); true" );
    ok( await until( "document.getElementById('lsDialog').open && document.getElementById('lsWords').value === 'factura'" ), "the funnel opens the dialog with the words" );
    const RES = "document.getElementById('lsResults')";
    ok( await until( `${groups( RES )} === 'events,files,mail,chats' && ! /Searching/.test( ${RES}.innerText )`, 8000 ), "events, files, mail, chats (no contact holds it)", await ev( groups( RES ) ) );
    ok( await ev( `/chat\\/index\\.html\\?c=d-p1/.test( ${hrefs( RES )} ) && /No mail account/.test( ${RES}.innerText )` ), "a chat message; no mail account said", await ev( RES + ".innerText" ) );
    await shot( "dialog" );
    await typeIn( "#lsWords", "factura from:pepe" );
    ok( await until( `${groups( RES )} === 'mail,chats' && document.getElementById('lsFrom').value === 'pepe' && document.getElementById('lsWords').value === 'factura'`, 6000 ),
        "from: becomes the From choice; only mail and chats left", await ev( groups( RES ) ) );
    ok( await until( `${RES}.querySelectorAll('.ls-group[data-kind=chats] .ls-row').length === 1` ), "Pepe's message only" );
    await ev( "document.getElementById('lsReset').click(); true" );
    await typeIn( "#lsWords", "type:pdf" );
    ok( await until( `${groups( RES )} === 'files' && ${RES}.querySelectorAll('.ls-row').length === 1`, 6000 ), "type:pdf -> files only, the one PDF", await ev( RES + ".innerText" ) );
    await key( "Escape", "Escape", 27 );
    await until( "! document.getElementById('lsDialog').open" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "A SHORTCUT IN THE FIELD" );
    await typeIn( "#lsInput", "in:events after:2020-01-01" );
    ok( await until( `/Enter/.test( ${QUICK}.innerText )` ), "the list says Enter opens the options", await ev( QUICK + ".innerText" ) );
    await key( "Enter", "Enter", 13 );
    ok( await until( `document.getElementById('lsDialog').open && document.getElementById('lsSince').value === '2020-01-01' && ${groups( RES )} === 'events'`, 6000 ),
        "Enter opens the dialog: only events, from that day", await ev( groups( RES ) ) );
    ok( await until( `${RES}.querySelectorAll('.ls-row').length === 2` ), "both events" );

    console.log( "PHONE" );
    c.logs.length = 0;
    await open( "index.html", 390 );
    ok( await ev( "document.getElementById('lsField').classList.contains('fold') && !! document.querySelector('#lsBox [data-search]')" ), "folded behind a magnifier" );
    await ev( "document.querySelector('#lsBox [data-search]').click(); true" );
    ok( await until( "document.getElementById('lsField').classList.contains('is-open') && document.getElementById('lsField').getBoundingClientRect().width > 200" ), "the magnifier opens a wide field (the note + gear share its row)" );
    await typeIn( "#lsInput", "dentista" );
    ok( await until( `/Dentista/.test( ${QUICK}.innerText )` ), "it searches" );
    ok( await ev( "document.documentElement.scrollWidth <= innerWidth" ), "no sideways scroll" );
    await shot( "phone" );
    await ev( "document.querySelector('#lsField .filter-btn').click(); true" );
    ok( await until( "document.getElementById('lsDialog').open && !! document.querySelector('#lsResults .ls-row')" ), "the dialog on a phone finds it" );
    ok( await ev( "( d => d.scrollWidth <= d.clientWidth + 1 )( document.querySelector('#lsDialog > .body') )" ), "…with no sideways scroll" );
    await shot( "phone-dialog" );
    await key( "Escape", "Escape", 27 );
    ok( ! errors().length, "no errors", errors() );

    console.log( "DESKTOP - the launcher in the desktop's menu" );
    await ev( "localStorage.setItem('balata-desktop','always'); true" );
    c.logs.length = 0;
    await open( "desktop/", 1280 );
    const MF = "document.querySelector('#menu iframe')";
    const IN = ( js ) => `( () => { const w = ${MF}.contentWindow, d = w.document; return ( ${js} ); } )()`;
    await ev( "document.getElementById('menuBtn').click(); true" );
    ok( await until( IN( "w.Ayni && !! d.getElementById('lsInput') && !! w.NayiveSearch" ), 8000 ), "the menu holds the launcher with its field" );
    await sleep( 800 );
    await ev( IN( "( i => { i.focus(); i.value = 'notas'; i.dispatchEvent( new w.Event( 'input', { bubbles: true } ) ); return true; } )( d.getElementById('lsInput') )" ) );
    ok( await until( IN( "/text\\/index\\.html/.test( [ ...d.querySelectorAll('#lsQuick .ls-row') ].map( a => a.getAttribute('href') ).join(' ') )" ) ), "the list in the menu" );
    await ev( IN( "d.querySelector('#lsQuick .ls-row.active').click(), true" ) );
    ok( await until( "AyniDesk.windows().some( w => w.app === 'text' ) && document.getElementById('menu').hidden && location.pathname.endsWith('/desktop/')" ),
        "a result opens a window; the menu shuts; the desktop stays", await ev( "JSON.stringify( [ AyniDesk.windows().map( w => w.app ), document.getElementById('menu').hidden, location.pathname ] )" ) );
    ok( await until( IN( "d.getElementById('lsQuick').hidden" ) ), "the list is gone" );
    await ev( "document.getElementById('menuBtn').click(); true" );
    await sleep( 400 );
    await ev( IN( "( i => { i.value = 'factura'; return true; } )( d.getElementById('lsInput') )" ) );
    await ev( IN( "d.querySelector('#lsField .filter-btn').click(), true" ) );
    ok( await until( IN( "d.getElementById('lsDialog').open && !! d.querySelector('#lsResults .ls-group[data-kind=chats] .ls-row')" ), 8000 ), "the dialog, full screen, finds the chat" );
    await ev( IN( "d.querySelector('#lsResults .ls-group[data-kind=chats] .ls-row').click(), true" ) );
    ok( await until( "AyniDesk.windows().some( w => w.app === 'chat' ) && document.getElementById('menu').hidden && ! document.getElementById('menu').classList.contains('full')" ),
        "a result in the dialog: a Chat window, dialog and menu gone",
        await ev( "JSON.stringify( [ AyniDesk.windows().map( w => w.app ), document.getElementById('menu').hidden, document.getElementById('menu').className ] )" ) );
    ok( await ev( IN( "! d.getElementById('lsDialog').open" ) ), "the dialog is closed" );
    await shot( "desktop" );
    ok( ! errors().length, "no errors", errors() );
    await ev( "localStorage.setItem('balata-desktop','never'); true" );

    console.log( "OTHERS" );
    await open( "planner/index.html?date=2026-12-24", 1280 );
    ok( await until( "/calendar\\/index\\.html\\?date=2026-12-24$/.test( document.getElementById('calendarPane').src )" ), "Planner passes ?date= to its Calendar",
        await ev( "document.getElementById('calendarPane').src" ) );
    c.logs.length = 0;
    await open( "drive/", 1280 );
    ok( await ev( "typeof sbKindList === 'function' && sbKindList().length === 9 && IMAGE_VIEW.length > 0 && CONVERT_EXT.length > 0" ), "Drive reads its kinds from shared/file-kinds.js" );
    ok( ! errors().length, "Drive boots with no error", errors() );
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
