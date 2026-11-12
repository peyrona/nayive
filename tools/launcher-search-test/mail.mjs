// mail.mjs - the launcher's search through mail, against a real Nayive with a
// mail account on an in-memory IMAP server (TestMailE2EServe, the same one
// tools/email-test uses).
//
//   node tools/launcher-search-test/mail.mjs
//
// Words reach the mail server; From and "With attachment" are checked here;
// a result opens that very message in eMail, with the words in its box.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || path.join( os.homedir(), "sdk/go1.27.1/bin/go" );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
let pass = 0, fail = 0;
const ok = ( cond, what, extra ) => { if( cond ) pass++; else fail++; console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 600 ) ) ); };

const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;
const TMP  = fs.mkdtempSync( path.join( os.tmpdir(), "launcher-mail-test-" ) );
const STOP = path.join( TMP, "stop" );
const server = spawn( GO, [ "test", "-v", "-count=1", "-timeout", "20m", "-run", "^TestMailE2EServe$", "." ],
                      { cwd: path.join( REPO, "server/go" ), env: { ...process.env, NAYIVE_MAIL_E2E: "127.0.0.1:" + PORT, NAYIVE_MAIL_E2E_STOP: STOP },
                        stdio: [ "ignore", "pipe", "inherit" ] } );
await new Promise( ( res, rej ) =>
{
    let buf = "";
    const t = setTimeout( () => rej( new Error( "the test server did not start: " + buf ) ), 180000 );
    server.stdout.on( "data", d => { buf += d; if( buf.includes( "E2E READY" ) ) { clearTimeout( t ); res(); } } );
    server.on( "exit", code => rej( new Error( "the test server stopped: " + code + " " + buf ) ) );
} );

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false } );
    const ev = s => c.evaluate( s );
    const until = async ( s, ms = 8000 ) => { for( let i = 0; i < ms; i += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const nav = async ( url, want ) => { await c.send( "Page.navigate", { url } ); await until( `location.pathname === ${JSON.stringify( want )} && document.readyState === 'complete'` ); };
    const errors = () => c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]/.test( l ) );

    await nav( `${BASE}/nayive/login.html`, "/nayive/login.html" );
    await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never'); localStorage.setItem('balata-desktop','never');
        ['launcher','email'].forEach( a => localStorage.setItem('balata-intro-dismiss:' + a, '1') ); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'ana',password:'abc'})}).then(r=>r.status)` );
    await nav( `${BASE}/nayive/index.html`, "/nayive/index.html" );
    await until( "window.NayiveSearch && Ayni.ready" );
    await sleep( 1000 );
    c.logs.length = 0;

    const RES = "document.getElementById('lsResults')";
    const mailRows = `[ ...${RES}.querySelectorAll('.ls-group[data-kind=mail] .ls-row .ls-title') ].map( e => e.textContent )`;
    const ask = async ( text ) =>
    {
        await ev( `( () => { const d = document.getElementById('lsDialog'); if( ! d.open ) { document.getElementById('lsInput').value = ${JSON.stringify( text )};
            document.querySelector('#lsField .filter-btn').click(); } else { const i = document.getElementById('lsWords'); i.value = ${JSON.stringify( text )};
            i.dispatchEvent( new Event( 'input', { bubbles: true } ) ); } return true; } )()` );
        await sleep( 500 );
        await until( `! /Searching/.test( ${RES}.innerText )` );
    };
    await ask( "in:mail file" );
    ok( await until( `${mailRows}.includes( 'With a file' )` ), "a word finds the mail (IMAP search)", await ev( `${RES}.innerText` ) );
    ok( await ev( `!! ${RES}.querySelector('.ls-group[data-kind=mail] .ls-clip')` ), "its paper clip shows" );
    await ask( "from:eve" );
    ok( await until( `JSON.stringify( ${mailRows} ) === '["Pictures"]'` ), "from:eve -> Eve's mail only", await ev( mailRows ) );
    await ask( "has:attachment" );
    ok( await until( `${mailRows}.includes( 'With a file' ) && ! ${mailRows}.includes( 'Pictures' )` ), "has:attachment -> the one with a file", await ev( mailRows ) );
    await ask( "file" );
    await until( `${mailRows}.includes( 'With a file' )` );
    const href = await ev( `[ ...${RES}.querySelectorAll('.ls-group[data-kind=mail] .ls-row') ].find( a => /With a file/.test( a.textContent ) ).getAttribute('href')` );
    ok( /^email\/index\.html\?a=.+&t=inbox&m=.+&mid=.+&s=With\+a\+file&q=file$/.test( href ), "its link: account, tray, ref, Message-ID, subject, words", href );
    ok( ! errors().length, "no errors", errors() );
    await ev( `[ ...${RES}.querySelectorAll('.ls-group[data-kind=mail] .ls-row') ].find( a => /With a file/.test( a.textContent ) ).click(); true` );
    ok( await until( "location.pathname === '/nayive/email/index.html'" ), "a click opens eMail" );
    ok( await until( "document.getElementById('readSubject').textContent === 'With a file' && /See the file/.test( document.getElementById('readBody').innerText )", 15000 ),
        "…with that message open", await ev( "document.getElementById('readSubject').textContent + ' | ' + document.getElementById('readBody').innerText.slice( 0, 80 )" ) );
    ok( await until( "document.getElementById('searchInput').value === 'file'" ), "…and the words in its search box" );
    ok( await ev( "location.search === ''" ), "the address is clean again (a reload does not re-open it)" );
}
finally
{
    await b.kill();
    try { fs.writeFileSync( STOP, "" ); } catch {}
    setTimeout( () => { try { server.kill(); } catch {} }, 1500 );
    try { fs.rmSync( TMP, { recursive: true, force: true } ); } catch {}
}
console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "SOME FAILED" : "ALL GREEN" );
setTimeout( () => process.exit( fail ? 1 : 0 ), 2000 );
