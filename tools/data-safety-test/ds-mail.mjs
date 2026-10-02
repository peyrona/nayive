// ds-mail.mjs - eMail: what the writer holds is never lost (data-safety I1,
// I4), and an Undo of a delete that brought nothing back says so (I9).
//
// lib.mjs's server() has no mail account, so this one starts the eMail
// test server of tools/email-test (TestMailE2EServe in server/go: a whole
// Nayive, user ana/abc, one account on an in-memory IMAP server, and
// /e2e/draft?fail=1 / ?slow=MS to make draft saves fail or wait).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, client, ok, section, done, REPO, sleep } from "./lib.mjs";

const GO = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );

async function mailServer()
{
    const port = await new Promise( res => { const x = net.createServer(); x.listen( 0, "127.0.0.1", () => { const p = x.address().port; x.close( () => res( p ) ); } ); } );
    const tmp  = fs.mkdtempSync( path.join( os.tmpdir(), "ds-mail-" ) );
    const stop = path.join( tmp, "stop" );
    const proc = spawn( GO, [ "test", "-v", "-count=1", "-timeout", "20m", "-run", "^TestMailE2EServe$", "." ],
                        { cwd: path.join( REPO, "server/go" ), stdio: [ "ignore", "pipe", "inherit" ],
                          env: { ...process.env, NAYIVE_MAIL_E2E: "127.0.0.1:" + port, NAYIVE_MAIL_E2E_STOP: stop } } );
    // a test that dies half way must not leave the server running (15 min)
    process.on( "exit", () => { try { fs.writeFileSync( stop, "" ); } catch {} try { proc.kill(); } catch {} } );
    await new Promise( ( res, rej ) =>
    {
        let buf = "";
        const t = setTimeout( () => rej( new Error( "the mail test server did not start: " + buf ) ), 300000 );
        proc.stdout.on( "data", d => { buf += d; if( buf.includes( "E2E READY" ) ) { clearTimeout( t ); res(); } } );
        proc.on( "exit", code => rej( new Error( "the mail test server stopped: " + code + " " + buf ) ) );
    } );
    return {
        base: "http://127.0.0.1:" + port, users: { ana: "abc" },
        stop: async () =>
        {
            try { fs.writeFileSync( stop, "" ); } catch {}
            await new Promise( r => { if( proc.exitCode !== null ) r(); else { proc.once( "exit", r ); setTimeout( () => { try { proc.kill(); } catch {} r(); }, 4000 ); } } );
            try { fs.rmSync( tmp, { recursive: true, force: true } ); } catch {}
        }
    };
}

const s = await mailServer();
const knob = q => fetch( s.base + "/e2e/draft?" + q );
const phone = await client( s.base, "ana", "abc" );        // another device: the server's view
const c = await browser( s, { lang: "es" } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:email', '1' ); true" );

const PAGE = "/nayive/email/index.html";
const openMail = async () => { await c.open( PAGE ); return c.until( "document.querySelectorAll( '#list .mail-row' ).length > 0 && NayiveMail.S.acct" ); };
const writing = () => c.evaluate( "! document.getElementById( 'composeView' ).hidden" );
const field = ( id, v ) => c.evaluate( `( () => { const e = document.getElementById( ${JSON.stringify( id )} ); e.value = ${JSON.stringify( v )};
    e.dispatchEvent( new Event( 'input' ) ); return true; } )()` );
// the text box is Squire's: a change reaches it by its MutationObserver, a moment later
const body = html => c.evaluate( `( async () => { document.getElementById( 'cText' ).innerHTML = ${JSON.stringify( html )};
    await new Promise( r => setTimeout( r, 80 ) ); return true; } )()` );
const compose = async ( to, subject, html ) =>
{
    await c.evaluate( "document.getElementById( 'composeBtn' ).click(); true" );
    await c.until( "! document.getElementById( 'composeView' ).hidden" );
    await field( "cTo", to );
    await field( "cSubject", subject );
    await body( html );
};
const status = () => c.evaluate( "document.getElementById( 'cStatus' ).textContent" );
const toasts = () => c.evaluate( "( window.__toasts || [] ).join( ' | ' )" );
// this device's copies (IndexedDB "nayive-drafts", "email:<lid>"): their subjects
// c.until() takes its expression as a plain value (a promise would count as
// true at once): this one waits for what a promise answers
const settles = async ( expr, ms = 15000 ) =>
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( await c.evaluate( expr ) ) return true; } catch {} await new Promise( r => setTimeout( r, 100 ) ); }
    return false;
};
const COPIES = `new Promise( r => { const q = indexedDB.open( 'nayive-drafts', 1 );
    q.onupgradeneeded = () => q.result.createObjectStore( 'drafts', { keyPath: 'app' } );
    q.onsuccess = () => { const g = q.result.transaction( 'drafts' ).objectStore( 'drafts' ).getAll();
        g.onsuccess = () => { r( g.result.filter( x => /^email:[^#]+$/.test( x.app ) ).map( x => x.fields && x.fields.subject ) ); q.result.close(); }; };
    q.onerror = () => r( [ 'idb-error' ] ); } )`;
const FORGET = `new Promise( r => { const q = indexedDB.open( 'nayive-drafts', 1 );
    q.onupgradeneeded = () => q.result.createObjectStore( 'drafts', { keyPath: 'app' } );
    q.onsuccess = () => { const t = q.result.transaction( 'drafts', 'readwrite' );
        t.objectStore( 'drafts' ).delete( IDBKeyRange.bound( 'email:', 'email:\\uffff' ) ); t.oncomplete = () => { q.result.close(); r( true ); }; }; } )`;
let acct = "", got = false;
// the Drafts tray on the server: each draft's subject and text
async function drafts()
{
    const l = JSON.parse( ( await phone.call( "GET", `/api/mail/${encodeURIComponent( acct )}/list?tray=drafts` ) ).text );
    const out = [];
    for( const m of l.items || l.msgs || [] )
    {
        const one = JSON.parse( ( await phone.call( "GET", `/api/mail/${encodeURIComponent( acct )}/msg/${encodeURIComponent( m.ref )}` ) ).text );
        out.push( { subject: one.subject, text: one.text || "" } );
    }
    return out;
}
// Leaves the page as a closed tab does (pagehide), then a page of the same
// site, where this device's copies can be looked at or cleared.
const away = async () => { await c.open( "/nayive/login.html" ); };

ok( await openMail(), "eMail opens with the account's Inbox" );
acct = await c.evaluate( "NayiveMail.S.acct" );

section( "I1 - SAVES REFUSED: SAID, KEPT HERE, ASKED ON CLOSE, BACK NEXT TIME" );
await knob( "fail=1" );
await compose( "bob@example.com", "Larga", "<div>Veinte minutos de texto</div>" );
// the app's own timer: the first save goes 4 s after the last change
ok( await c.until( "( window.__toasts || [] ).some( t => /No se guardó en Borradores/.test( t ) )", 12000 ),
    "a save that fails is said in a toast", await toasts() );
ok( await settles( COPIES + ".then( l => l.includes( 'Larga' ) )", 5000 ), "the writer is kept on this device", await c.evaluate( COPIES ) );
await c.evaluate( "window.__asked = typeof window.nayiveBeforeClose === 'function' ? window.nayiveBeforeClose() : Promise.resolve( 'none' ); true" );
ok( await c.until( "document.querySelector( '.sheet-backdrop.open h2' )?.textContent === 'Sin guardar en Borradores'" ),
    "the desktop's × (window.nayiveBeforeClose) asks first", await c.evaluate( "String( typeof window.nayiveBeforeClose )" ) );
// its first button is Cancel (shared/ui.js confirmDialog)
await c.evaluate( "document.querySelector( '.sheet-backdrop.open .sheet-actions button' )?.click(); true" );
ok( await c.evaluate( "window.__asked" ) === false && await writing(), "…'Cancel' keeps the window and the writer" );
await away();
ok( await openMail() && await c.until( "! document.getElementById( 'composeView' ).hidden && NayiveMail.composeText().includes( 'Veinte minutos de texto' )" ),
    "closed and opened again: the writer is back with the text", await c.evaluate( "NayiveMail.composeText()" ) );
ok( await c.evaluate( "document.getElementById( 'cSubject' ).value" ) === "Larga" && await c.evaluate( "document.getElementById( 'cTo' ).value" ) === "bob@example.com",
    "…and its fields" );
// (the toast may come before lib's recorder is on: what shows now counts too)
ok( /Recuperado/.test( await toasts() + ( await c.evaluate( "document.getElementById( 'toast' ).textContent" ) ) ), "…saying so", await toasts() );
await knob( "fail=0" );
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 12000 ), "saves working again: it goes to Drafts", await status() );
ok( ( await drafts() ).some( d => d.subject === "Larga" && d.text.includes( "Veinte minutos de texto" ) ), "the server has it", await drafts() );
ok( await settles( COPIES + ".then( l => ! l.length )", 5000 ), "the copy here is gone", await c.evaluate( COPIES ) );
await c.evaluate( "window.__asked = window.nayiveBeforeClose ? window.nayiveBeforeClose() : Promise.resolve( 'none' ); true" );
ok( await c.until( "window.__asked.then( v => window.__answer = v ) && window.__answer === true" ) &&
    ! await c.evaluate( "!! document.querySelector( '.sheet-backdrop.open' )" ), "all in Drafts: the × closes with no question" );
await c.evaluate( "document.getElementById( 'backBtn' ).click(); true" );
ok( await c.until( "document.getElementById( 'composeView' ).hidden" ), "← leaves the writer" );

section( "I1 - A TAB CLOSED RIGHT AFTER TYPING: NOTHING COMES BACK TWICE" );
// (a guard for the copy itself: the save sent as the page goes arrives, so
// the copy left here must not pop up as "recovered" nor make a second draft)
await compose( "bob@example.com", "Rápido", "<div>cerrado enseguida</div>" );
// the app's own pause (300 ms) before the copy here is written
ok( await settles( COPIES + ".then( l => l.includes( 'Rápido' ) )", 5000 ), "typed: the copy here is written" );
await away();
got = false;
for( let i = 0; i < 100 && ! got; i++ ) { got = ( await drafts() ).some( d => d.subject === "Rápido" ); if( ! got ) await sleep( 100 ); }
ok( got, "closed before its first save: the save as the page went reached Drafts" );
ok( ( await c.evaluate( COPIES ) ).includes( "Rápido" ), "(the copy is still here: the page could not know)" );
ok( await openMail() && await settles( COPIES + ".then( l => ! l.length )", 8000 ), "opened again: the copy, same words as the draft, is dropped", await c.evaluate( COPIES ) );
ok( ! await writing(), "…and no writer pops up" );
ok( ( await drafts() ).filter( d => d.subject === "Rápido" ).length === 1, "one draft of it", await drafts() );

section( "I4 - THE LAST WORDS, A SAVE ON ITS WAY WHEN THE PAGE GOES" );
await knob( "slow=3000" );
await compose( "bob@example.com", "Al vuelo", "<div>uno</div>" );
ok( await c.until( "/Guardando/.test( document.getElementById( 'cStatus' ).textContent )", 12000 ), "a slow save is on its way", await status() );
await body( "<div>uno dos tres</div>" );
await away();
got = false;
for( let i = 0; i < 150 && ! got; i++ ) { got = ( await drafts() ).some( d => d.subject === "Al vuelo" && d.text.includes( "uno dos tres" ) ); if( ! got ) await sleep( 100 ); }
ok( got, "the words typed during that save reached Drafts after the page went", await drafts() );
await knob( "slow=0" );
await c.evaluate( FORGET );

section( "I4 - A DRAFT IN CYRILLIC: BYTES, NOT LETTERS" );
ok( await openMail(), "eMail again" );
// 25 000 letters: under 60 000 as JS counts them (text + HTML), over 64 KiB as UTF-8 bytes
await compose( "bob@example.com", "Кириллица", "<div>" + "Привет мир ".repeat( 2300 ).slice( 0, 25000 ) + "</div>" );
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 15000 ), "it saves (not 'offline')", await status() );
await c.evaluate( "document.getElementById( 'backBtn' ).click(); true" );
await c.until( "document.getElementById( 'composeView' ).hidden" );

section( "I4 - THE SESSION ENDS WHILE WRITING: SIGN IN, AND IT IS BACK" );
await compose( "bob@example.com", "Sesión", "<div>texto antes de entrar</div>" );
await c.evaluate( "fetch( '/api/logout', { method: 'POST', credentials: 'same-origin' } ).then( r => r.status )" );
ok( await c.until( "!! document.getElementById( 'nayive-session-bar' )", 12000 ), "the next save meets the ended session: the bar says so" );
await c.evaluate( "document.querySelector( '#nayive-session-bar button' ).click(); true" );
ok( await c.until( "location.pathname === '/nayive/login.html'", 10000 ), "'Sign in' goes to the sign-in page" );
await c.evaluate( "fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { user: 'ana', password: 'abc' } ) } ).then( r => r.status )" );
ok( await openMail() && await c.until( "! document.getElementById( 'composeView' ).hidden && NayiveMail.composeText().includes( 'texto antes de entrar' )", 8000 ),
    "signed in again: the writer is back with its text", await c.evaluate( "NayiveMail.composeText()" ) );
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 12000 ), "…and it reaches Drafts", await status() );
await c.evaluate( "document.getElementById( 'backBtn' ).click(); true" );
await c.until( "document.getElementById( 'composeView' ).hidden" );

section( "I9 - AN UNDO THAT BROUGHT NOTHING BACK SAYS SO" );
ok( await c.until( "[ ...document.querySelectorAll( '#list .mail-row' ) ].some( r => r.textContent.includes( 'Hello 3' ) )" ), "the Inbox shows 'Hello 3'" );
await c.evaluate( "[ ...document.querySelectorAll( '#list .mail-row' ) ].find( r => r.textContent.includes( 'Hello 3' ) ).click(); true" );
ok( await c.until( "!! NayiveMail.S.open" ), "it opens" );
await c.evaluate( "window.__toasts = []; document.getElementById( 'actDelete' ).click(); true" );
ok( await c.until( "!! document.querySelector( '#toast .toast-undo' )" ), "Delete: to the Trash, with Undo" );
// meanwhile another device deletes it from the Trash for good
const trash = JSON.parse( ( await phone.call( "GET", `/api/mail/${encodeURIComponent( acct )}/list?tray=trash` ) ).text );
const gone = ( trash.items || trash.msgs || [] ).find( m => m.subject === "Hello 3" );
const f = gone && await phone.call( "POST", `/api/mail/${encodeURIComponent( acct )}/forget`, JSON.stringify( { refs: [ gone.ref ] } ), { "Content-Type": "application/json" } );
ok( f && f.status === 200, "(another device empties it from the Trash)", f && f.status );
await c.evaluate( "document.querySelector( '#toast .toast-undo' ).click(); true" );
ok( await c.until( "( window.__toasts || [] ).some( t => /no se pudieron devolver/.test( t ) )", 10000 ), "the Undo says one did not come back", await toasts() );

await done( c, s );
