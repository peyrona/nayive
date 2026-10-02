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
// the Drafts / Trash rows on the server (ref, mid, subject, date)
const rows = async tray => JSON.parse( ( await phone.call( "GET", `/api/mail/${encodeURIComponent( acct )}/list?tray=${tray}` ) ).text ).items || [];
const msgOf = async ref => JSON.parse( ( await phone.call( "GET", `/api/mail/${encodeURIComponent( acct )}/msg/${encodeURIComponent( ref )}` ) ).text );
// another device saves a draft over `row` (its Message-ID, replacing it)
const phoneSave = async ( row, text, keep = [] ) =>
{
    const fd = new FormData();
    fd.append( "json", JSON.stringify( { to: "bob@example.com", subject: row.subject, text, html: "<div>" + text + "</div>",
                                         mid: row.mid, draftRef: row.ref, keep, drive: [] } ) );
    return ( await phone.call( "POST", `/api/mail/${encodeURIComponent( acct )}/draft`, fd ) ).status;
};
const until = async ( fn, ms = 15000 ) => { const end = Date.now() + ms; while( Date.now() < end ) { if( await fn() ) return true; await sleep( 150 ); } return false; };
// the question a copy with no draft on the server brings (restoreLocal)
const ASKED = "document.querySelector( '.sheet-backdrop.open h2' )?.textContent === 'Un correo sin guardar'";
// its buttons, in shared/ui.js confirmDialog's order: Más tarde, Descartar, Recuperar como borrador
const answer = which => c.evaluate( `( () => { const b = [ ...document.querySelectorAll( '.sheet-backdrop.open .sheet-actions button' ) ];
    b[ ${ JSON.stringify( { later: 0, drop: 1, keep: 2 } ) }[ ${ JSON.stringify( which ) } ] ]?.click(); return b.length; } )()` );
const toastNow = () => c.evaluate( "( window.__toasts || [] ).join( ' | ' ) + ' | ' + document.getElementById( 'toast' ).textContent" );
const closeWriter = async () => { if( await writing() ) { await c.evaluate( "document.getElementById( 'backBtn' ).click(); true" ); await c.until( "document.getElementById( 'composeView' ).hidden" ); } };
// What sign-out counts of eMail (shared/store.js localCount: every record of "nayive-drafts")
const RECORDS = `new Promise( r => { const q = indexedDB.open( 'nayive-drafts', 1 );
    q.onupgradeneeded = () => q.result.createObjectStore( 'drafts', { keyPath: 'app' } );
    q.onsuccess = () => { const g = q.result.transaction( 'drafts' ).objectStore( 'drafts' ).getAll();
        g.onsuccess = () => { r( g.result.filter( x => String( x.app ).startsWith( 'email:' ) ).map( x => x.app + '=' + ( x.who || '' ) + '=' + ( x.fields ? x.fields.subject : '' ) ) ); q.result.close(); }; };
    q.onerror = () => r( [ 'idb-error' ] ); } )`;
// The writer saves now: the page going out of sight does that (the 4 s, or
// a minute with files, would otherwise have to pass)
const saveNow = () => c.evaluate( "Object.defineProperty( document, 'hidden', { value: true, configurable: true } ); document.dispatchEvent( new Event( 'visibilitychange' ) ); delete document.hidden; true" );
// another device's draft, files and all (round-2 review helpers)
const enc = encodeURIComponent;
const save = async ( o, files = [] ) =>
{
    const fd = new FormData();
    fd.append( "json", JSON.stringify( { to: o.to || "bob@example.com", cc: "", bcc: "", subject: o.subject, text: o.text,
                                         html: o.html ?? ( "<div>" + o.text + "</div>" ), mid: o.mid, draftRef: o.ref || "",
                                         keep: o.keep || [], drive: [] } ) );
    for( const [ name, data ] of files ) fd.append( "file", new Blob( [ data ] ), name );
    const r = await phone.call( "POST", `/api/mail/${enc( acct )}/draft`, fd );
    return { status: r.status, ...( JSON.parse( r.text || "{}" ) ) };
};
const byMid = async ( tray, mid ) => ( await rows( tray ) ).filter( m => m.mid === mid );
const attBytes = async ( ref, part ) => ( await phone.call( "GET", `/api/mail/${enc( acct )}/att/${enc( ref )}/${enc( part )}` ) ).text;
const filesOf = async ref => { const m = await msgOf( ref ); const out = []; for( const p of ( m.parts || [] ).filter( p => ! p.inline ) ) out.push( p.name + "=" + await attBytes( ref, p.id ) ); return out; };
async function attachMany( t, paths )
{
    const { root } = ( await t.send( "DOM.getDocument", {} ) ).result;
    const input = await t.send( "DOM.querySelector", { nodeId: root.nodeId, selector: "#cFileInput" } );
    await t.send( "DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: paths } );
}
const mkfile = ( dir, name, text ) => { const d = path.join( os.tmpdir(), "ds-" + dir ); fs.mkdirSync( d, { recursive: true } ); const f = path.join( d, name ); fs.writeFileSync( f, text ); return f; };
// The Drafts tray on screen, read: its list has come in
const readDrafts = async ( t = c ) => { await t.evaluate( "NayiveMail.openTray( 'inbox' ); true" ); await sleep( 300 );
                                        await t.evaluate( "NayiveMail.openTray( 'drafts' ); true" );
                                        return t.until( "NayiveMail.S.tray === 'drafts' && ! NayiveMail.S.loading" ); };
// a file's bytes kept for a copy (IndexedDB "nayive-mail-files")
const BYTES = ( op, key ) => `new Promise( r => { const q = indexedDB.open( 'nayive-mail-files', 1 );
    q.onupgradeneeded = () => q.result.createObjectStore( 'files', { keyPath: 'key' } );
    q.onsuccess = () => { const t = q.result.transaction( 'files', 'readwrite' ), os = t.objectStore( 'files' ), out = {};
        if( ${JSON.stringify( op )} === 'put' ) os.put( { key: ${JSON.stringify( key )}, at: Date.now(), blob: new Blob( [ 'x' ] ) } );
        else { const g = os.get( ${JSON.stringify( key )} ); g.onsuccess = () => { out.v = !! g.result; }; }
        t.oncomplete = () => { q.result.close(); r( out.v ); }; }; } )`;

async function attach( name, text )
{
    const file = path.join( os.tmpdir(), name );
    fs.writeFileSync( file, text );
    const { root } = ( await c.send( "DOM.getDocument", {} ) ).result;
    const input = await c.send( "DOM.querySelector", { nodeId: root.nodeId, selector: "#cFileInput" } );
    await c.send( "DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [ file ] } );
    return c.until( `document.getElementById( 'cFiles' ).textContent.includes( ${JSON.stringify( name )} )` );
}

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
ok( await openMail() && await c.until( ASKED ), "closed and opened again: it asks what to do with the copy (no draft of it on the server)" );
await answer( "keep" );
ok( await c.until( "! document.getElementById( 'composeView' ).hidden && NayiveMail.composeText().includes( 'Veinte minutos de texto' )" ),
    "'Recuperar como borrador': the writer is back with the text", await c.evaluate( "NayiveMail.composeText()" ) );
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
ok( await openMail() && await c.until( ASKED ), "signed in again: it asks about the copy" );
await answer( "keep" );
ok( await c.until( "! document.getElementById( 'composeView' ).hidden && NayiveMail.composeText().includes( 'texto antes de entrar' )", 8000 ),
    "…and the writer is back with its text", await c.evaluate( "NayiveMail.composeText()" ) );
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

section( "I1 - THE DRAFT CHANGED ON THE PHONE: BOTH STAY (review RV-A)" );
await compose( "bob@example.com", "Conflicto", "<div>palabras del PC</div>" );
ok( await settles( COPIES + ".then( l => l.includes( 'Conflicto' ) )", 5000 ), "the copy here is written" );
await away();
ok( await until( async () => ( await drafts() ).some( d => d.subject === "Conflicto" ) ), "the save as the page went reached Drafts" );
ok( ( await c.evaluate( COPIES ) ).includes( "Conflicto" ), "(the copy stays on the PC)" );
const rowA = ( await rows( "drafts" ) ).find( m => m.subject === "Conflicto" );
ok( await phoneSave( rowA, "palabras del PC y un parrafo largo del movil" ) === 200, "the phone opens that draft and adds a paragraph" );
ok( await openMail() && await c.until( "! document.getElementById( 'composeView' ).hidden && NayiveMail.composeText().includes( 'palabras del PC' )" ),
    "the PC opens eMail: its copy comes back in the writer" );
ok( /aparte/.test( await toastNow() ), "…as a draft apart, saying so", await toastNow() );
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 12000 ), "…and it is saved", await status() );
const afterA = ( await drafts() ).filter( d => d.subject === "Conflicto" );
ok( afterA.some( d => d.text.includes( "parrafo largo del movil" ) ), "the phone's paragraph is still in Drafts", afterA );
ok( afterA.length === 2, "both stay: two drafts", afterA );
await closeWriter();

section( "I1 - A DRAFT THE PHONE SENT: ASKED, NEVER SAVED ON ITS OWN (review RV-B)" );
await compose( "bob@example.com", "Enviado ya", "<div>texto enviado desde el movil</div>" );
ok( await settles( COPIES + ".then( l => l.includes( 'Enviado ya' ) )", 5000 ), "the copy here is written" );
await away();
ok( await until( async () => ( await drafts() ).some( d => d.subject === "Enviado ya" ) ), "the save as the page went reached Drafts" );
{
    const rowB = ( await rows( "drafts" ) ).find( m => m.subject === "Enviado ya" );
    const fd = new FormData();
    fd.append( "json", JSON.stringify( { to: "bob@example.com", subject: "Enviado ya", text: "texto enviado desde el movil", html: "",
                                         mid: rowB.mid, draftRef: rowB.ref, keep: [], drive: [] } ) );
    const r = await phone.call( "POST", `/api/mail/${encodeURIComponent( acct )}/send`, fd );
    ok( r.status === 200 && ! ( await drafts() ).some( d => d.subject === "Enviado ya" ), "the phone sends it (Drafts no longer has it)", r.status );
}
ok( await openMail() && await c.until( ASKED ), "the PC opens eMail: it asks what to do with the copy" );
await sleep( 6000 );    // longer than the writer's 4 s autosave: nothing may save it meanwhile
ok( ! ( await drafts() ).some( d => d.subject === "Enviado ya" ) && ! await writing(), "nothing goes back to Drafts on its own" );
await answer( "drop" );
ok( await settles( COPIES + ".then( l => ! l.includes( 'Enviado ya' ) )", 5000 ), "'Descartar': the copy goes" );
ok( ! ( await drafts() ).some( d => d.subject === "Enviado ya" ) && ! await writing(), "…and Drafts stays without it" );

section( "I4 - THE SAVE ON ITS WAY AND THE LEAVING ONE: THE LAST WORDS STAY (review RV-C)" );
await knob( "slow=3000" );
await compose( "bob@example.com", "Dos veces 0", "<div>uno</div>" );
ok( await c.until( "/Guardando/.test( document.getElementById( 'cStatus' ).textContent )", 12000 ), "a slow save is on its way" );
await body( "<div>uno dos tres</div>" );
await away();
ok( await until( async () => ( await drafts() ).filter( d => d.subject === "Dos veces 0" ).length >= 2, 15000 ), "both saves land" );
await knob( "slow=0" );
ok( await openMail(), "eMail again" );
ok( await settles( COPIES + ".then( l => ! l.includes( 'Dos veces 0' ) )", 15000 ) || await c.until( ASKED, 1000 ), "the copy is settled" );
if( await c.evaluate( ASKED ) ) await answer( "keep" );
await sleep( 5000 );    // a copy put back is saved 4 s after it shows
ok( ( await drafts() ).some( d => d.subject === "Dos veces 0" && d.text.includes( "uno dos tres" ) ), "the last words are still in Drafts", await drafts() );
await closeWriter();
await c.evaluate( FORGET );

section( "I4 - TWINS OF ONE WRITER: BOTH STAY, NOTHING IS TRASHED (review RV-C, round 2)" );
await knob( "slow=3000" );
await compose( "bob@example.com", "Dos veces", "<div>uno</div>" );
ok( await c.until( "/Guardando/.test( document.getElementById( 'cStatus' ).textContent )", 12000 ), "a slow save is on its way" );
await body( "<div>uno dos tres</div>" );
await sleep( 1500 );    // the two saves then land in different seconds (the server's date has whole seconds)
await away();
ok( await until( async () => ( await drafts() ).filter( d => d.subject === "Dos veces" ).length === 2, 15000 ), "both saves land: two drafts, one Message-ID",
    ( await drafts() ).filter( d => d.subject === "Dos veces" ) );
await knob( "slow=0" );
ok( await openMail(), "eMail again (the copy here makes it look at that draft)" );
ok( await settles( COPIES + ".then( l => ! l.includes( 'Dos veces' ) )", 15000 ), "the copy (same words as the newest) only goes" );
ok( await readDrafts(), "the Drafts tray is read" );
ok( ( await drafts() ).filter( d => d.subject === "Dos veces" ).length === 2, "both drafts stay (a duplicate is not a loss)",
    ( await drafts() ).filter( d => d.subject === "Dos veces" ) );
ok( ( await drafts() ).some( d => d.subject === "Dos veces" && d.text.includes( "uno dos tres" ) ), "…the last words among them" );
ok( ! ( await rows( "trash" ) ).some( m => m.subject === "Dos veces" ), "nothing went to the Trash" );
await closeWriter();
await c.evaluate( FORGET );

section( "I1 - A KEPT FILE GONE: MENDED, AND IT SAVES AGAIN (review 4)" );
ok( await openMail(), "eMail again" );
await compose( "bob@example.com", "Con fichero", "<div>con adjunto</div>" );
ok( await attach( "informe-ds.txt", "un informe\n" ), "a file from this device" );
ok( await settles( COPIES + ".then( l => l.includes( 'Con fichero' ) )", 5000 ), "the copy here is written" );
ok( ( await c.evaluate( RECORDS ) ).length === 1, "one record here for the mail and its file (sign-out counts mails, not files)", await c.evaluate( RECORDS ) );
await saveNow();
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 12000 ), "saved: the file now lives in the draft", await status() );
const rowF = ( await rows( "drafts" ) ).find( m => m.subject === "Con fichero" );
const partF = ( ( await msgOf( rowF.ref ) ).parts || [] ).find( p => p.name === "informe-ds.txt" );
ok( partF && await phoneSave( rowF, "con adjunto y del movil", [ { acct, ref: rowF.ref, part: partF.id } ] ) === 200,
    "the phone re-saves that draft, file and all (the PC's file ref is gone now)" );
await body( "<div>con adjunto y mas del PC</div>" );
await c.evaluate( "document.getElementById( 'cStatus' ).textContent = ''; true" );     // the next 'saved' is this save's
await saveNow();
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 15000 ), "the PC's save meets 'gone', mends, and saves", await status() );
let pc = null;
for( const r of await rows( "drafts" ) ) { const m = await msgOf( r.ref ); if( ( m.text || "" ).includes( "mas del PC" ) ) pc = m; }
ok( pc && ( pc.parts || [] ).some( p => p.name === "informe-ds.txt" ), "the PC's draft has its words and the file", pc && pc.parts );
ok( ( await drafts() ).some( d => d.text.includes( "del movil" ) ), "the phone's draft is still there (not replaced)" );
await closeWriter();

section( "I1 - TYPING THAT NEVER PAUSES IS KEPT TOO (review 5)" );
await compose( "bob@example.com", "Sin parar", "<div>palabra</div>" );
let seen = false;
for( let i = 0; i < 12; i++ )
{
    await body( "<div>" + "palabra ".repeat( i + 2 ) + "</div>" );
    await sleep( 120 );     // a change every ~200 ms: never the 300 ms pause
    if( i >= 7 && ( await c.evaluate( COPIES ) ).includes( "Sin parar" ) ) seen = true;
}
ok( seen, "while typing goes on, the copy here is written (at least every second)" );
await closeWriter();

section( "I1 - A COPY WRITTEN BEFORE THE ACCOUNT IS KNOWN GETS ITS OWNER (review 6)" );
await c.evaluate( "NayiveMail.S.user = ''; true" );        // as after a start with no answer
await compose( "bob@example.com", "Sin dueño", "<div>de quién</div>" );
ok( await settles( RECORDS + ".then( l => l.some( x => x.endsWith( '=ana=Sin dueño' ) ) )", 8000 ), "the copy is written again with its owner", await c.evaluate( RECORDS ) );
await closeWriter();

section( "ROUND 2 T1 - TWINS THAT DIFFER (SUBJECT, TO, A FILE, EMPTY TEXT) BOTH STAY" );
await c.evaluate( FORGET );
ok( await openMail(), "eMail again" );
const M1 = "nayive.dstwinone" + Date.now() + "@example.com", M1b = "nayive.dstwinempty" + Date.now() + "@example.com";
await save( { mid: M1, to: "carlos@example.com", subject: "Factura firmada", text: "Hola" }, [ [ "factura.pdf", "PDF-FACTURA-BYTES" ] ] );
await save( { mid: M1b, to: "carlos@example.com", subject: "Plano de la casa", text: "", html: "" }, [ [ "plano.pdf", "PLANO-BYTES" ] ] );
await sleep( 1300 );     // the twins land in another second (the server's date has whole seconds)
await save( { mid: M1, to: "bob@example.com", subject: "Factura", text: "Hola Juan" } );
await save( { mid: M1b, to: "bob@example.com", subject: "otra cosa", text: "", html: "" } );
ok( ( await byMid( "drafts", M1 ) ).length === 2 && ( await byMid( "drafts", M1b ) ).length === 2, "two pairs of twins in Drafts" );
ok( await readDrafts(), "the Drafts tray is read" );
await sleep( 1500 );     // what the app does after reading Drafts has had its time
ok( ( await byMid( "drafts", M1 ) ).length === 2 && ! ( await byMid( "trash", M1 ) ).length, "twins with other subject, To and a file both stay" );
ok( ( await byMid( "drafts", M1b ) ).length === 2 && ! ( await byMid( "trash", M1b ) ).length, "twins with empty text both stay" );

section( "ROUND 2 T3 - A DRAFT OPEN IN ANOTHER TAB'S WRITER KEEPS ITS FILE" );
const M3 = "nayive.dstwintab" + Date.now() + "@example.com";
await save( { mid: M3, subject: "Contrato", text: "Adjunto el contrato" }, [ [ "contrato.pdf", "CONTRATO-BYTES" ] ] );
const t2 = await c.tab();
await t2.open( PAGE );
await t2.until( "NayiveMail.S.acct" );
ok( await readDrafts( t2 ) && await t2.until( `NayiveMail.S.items.some( m => m.mid === ${JSON.stringify( M3 )} )` ), "tab 2 lists the draft" );
await t2.evaluate( `NayiveMail.openDraft( NayiveMail.S.items.find( m => m.mid === ${JSON.stringify( M3 )} ) ); true` );
ok( await t2.until( "! document.getElementById( 'composeView' ).hidden && document.getElementById( 'cFiles' ).textContent.includes( 'contrato.pdf' )" ), "tab 2 writes it, with contrato.pdf" );
await sleep( 1300 );
await save( { mid: M3, subject: "Contrato", text: "Adjunto el contrato firmado" } );       // the phone: a twin, newer, more words, no file
await c.front();
ok( await readDrafts(), "tab 1 reads Drafts" );
await sleep( 1500 );     // what the app does after reading Drafts has had its time
ok( ! ( await byMid( "trash", M3 ) ).length, "the draft open in tab 2 is not trashed" );
await t2.evaluate( "( async () => { document.getElementById( 'cText' ).innerHTML = '<div>Adjunto el contrato. Saludos desde la pestana 2</div>'; await new Promise( r => setTimeout( r, 80 ) ); return true; } )()" );
await t2.evaluate( "document.getElementById( 'cStatus' ).textContent = ''; true" );
await t2.evaluate( "Object.defineProperty( document, 'hidden', { value: true, configurable: true } ); document.dispatchEvent( new Event( 'visibilitychange' ) ); delete document.hidden; true" );
ok( await t2.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 15000 ), "tab 2 saves" );
let t3 = null;
for( const r of await rows( "drafts" ) ) { const m = await msgOf( r.ref ); if( ( m.text || "" ).includes( "pestana 2" ) ) t3 = r; }
ok( t3 && ( await filesOf( t3.ref ) ).some( f => f.startsWith( "contrato.pdf=CONTRATO-BYTES" ) ), "tab 2's draft still has contrato.pdf" );
await t2.evaluate( "document.getElementById( 'backBtn' ).click(); true" );
await c.front();

section( "ROUND 2 T4 - A FILE GONE: NEVER ANOTHER FILE OF THE SAME NAME" );
await c.evaluate( "NayiveMail.openTray( 'inbox' ); true" );
await compose( "bob@example.com", "Mismo nombre", "<div>foto del PC</div>" );
await attachMany( c, [ mkfile( "a", "image.png", "IMAGEN-ORIGINAL-DEL-PC" ) ] );
await c.until( "document.getElementById( 'cFiles' ).textContent.includes( 'image.png' )" );
await saveNow();
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 15000 ), "saved with image.png" );
const r4 = ( await rows( "drafts" ) ).find( m => m.subject === "Mismo nombre" );
await save( { mid: r4.mid, ref: r4.ref, subject: "Mismo nombre", text: "foto del movil" }, [ [ "image.png", "OTRA-IMAGEN-DEL-MOVIL" ] ] );
await body( "<div>foto del PC y mas del PC cuatro</div>" );
await c.evaluate( "window.__toasts = []; document.getElementById( 'cStatus' ).textContent = ''; true" );
await saveNow();
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 15000 ), "the PC's save mends and saves", await status() );
let t4 = null;
for( const r of await rows( "drafts" ) ) { const m = await msgOf( r.ref ); if( ( m.text || "" ).includes( "mas del PC cuatro" ) ) t4 = r; }
ok( t4 && ! ( await filesOf( t4.ref ) ).some( f => f.includes( "OTRA-IMAGEN-DEL-MOVIL" ) ), "the PC's draft does not carry the phone's other image.png", t4 && await filesOf( t4.ref ) );
ok( /Ya no están: image\.png/.test( await toastNow() ), "…and it names the file to add again", await toastNow() );
await closeWriter();

section( "ROUND 2 T5 - TWO KEPT FILES OF ONE NAME STAY TWO" );
await compose( "bob@example.com", "Dos imagenes", "<div>dos capturas</div>" );
await attachMany( c, [ mkfile( "b", "image.png", "CAPTURA-UNO" ), mkfile( "c", "image.png", "CAPTURA-DOS" ) ] );
await c.until( "( document.getElementById( 'cFiles' ).textContent.match( /image\\.png/g ) || [] ).length >= 2" );
await saveNow();
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 15000 ), "saved with two image.png" );
const r5 = ( await rows( "drafts" ) ).find( m => m.subject === "Dos imagenes" );
const p5 = ( ( await msgOf( r5.ref ) ).parts || [] ).filter( p => ! p.inline );
await save( { mid: r5.mid, ref: r5.ref, subject: "Dos imagenes", text: "dos capturas y del movil", keep: p5.map( p => ( { acct, ref: r5.ref, part: p.id } ) ) } );
await body( "<div>dos capturas y mas del PC cinco</div>" );
await c.evaluate( "document.getElementById( 'cStatus' ).textContent = ''; true" );
await saveNow();
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 15000 ), "the PC's save mends and saves" );
let t5 = null;
for( const r of await rows( "drafts" ) ) { const m = await msgOf( r.ref ); if( ( m.text || "" ).includes( "mas del PC cinco" ) ) t5 = r; }
const t5files = t5 ? await filesOf( t5.ref ) : [];
ok( t5files.some( f => f.includes( "CAPTURA-UNO" ) ) && t5files.some( f => f.includes( "CAPTURA-DOS" ) ), "both captures are in the PC's draft", t5files );
await closeWriter();

section( "ROUND 2 (6) - NO LOCK QUERIES: FILE BYTES ARE NEVER SWEPT" );
await c.evaluate( BYTES( "put", "dsorphan#f1" ) );
const t6 = await c.tab();
// a browser that cannot list who holds a lock (navigator.locks.query)
await t6.send( "Page.addScriptToEvaluateOnNewDocument", { source: "try { Object.defineProperty( LockManager.prototype, 'query', { value: undefined, configurable: true } ); } catch( e ) {}" } );
await t6.open( PAGE );
ok( await t6.until( "NayiveMail.S.accounts.length && typeof navigator.locks.query === 'undefined'" ), "eMail opens in a tab with no lock queries" );
await sleep( 2500 );     // eMail's opening (restoreLocal, where the sweep is) has had its time
ok( await c.evaluate( BYTES( "get", "dsorphan#f1" ) ), "bytes with no copy are left alone there (it cannot tell a writer on screen)" );
await t6.evaluate( "location.href = 'about:blank'; true" );
ok( await openMail() && await settles( BYTES( "get", "dsorphan#f1" ) + ".then( v => ! v )", 8000 ), "(a browser that can tell sweeps them)" );

section( "ROUND 2 (5) - A COPY'S DRAFT BEYOND THE FIRST PAGE OF DRAFTS IS FOUND" );
await compose( "bob@example.com", "Lejos", "<div>en la segunda pagina</div>" );
ok( await settles( COPIES + ".then( l => l.includes( 'Lejos' ) )", 5000 ), "the copy here is written" );
await away();
ok( await until( async () => ( await rows( "drafts" ) ).some( m => m.subject === "Lejos" ) ), "the save as the page went reached Drafts" );
for( let i = 0; i < 52; i++ ) await save( { mid: "nayive.dsfill" + i + "." + Date.now() + "@example.com", subject: "Relleno " + i, text: "relleno" } );
ok( ! ( await rows( "drafts" ) ).some( m => m.subject === "Lejos" ), "(52 newer drafts: it is past the first page)" );
ok( await openMail() && await settles( COPIES + ".then( l => ! l.includes( 'Lejos' ) )", 15000 ), "the copy finds its draft (same words) and only goes",
    await c.evaluate( COPIES ) );
ok( ! await c.evaluate( ASKED ) && ! await writing(), "no question, no writer" );

section( "S3b I1 - A TO LIKE 'juan': THE DRAFT IS SAVED, AND COMES BACK AS TYPED" );
await c.evaluate( FORGET );
ok( await openMail(), "eMail again" );
await compose( "juan, bob@example.com", "Para Juan", "<div>un texto para juan</div>" );
await c.evaluate( "document.getElementById( 'cStatus' ).textContent = ''; window.__toasts = []; true" );
await saveNow();
ok( await c.until( "/Borrador guardado/.test( document.getElementById( 'cStatus' ).textContent )", 12000 ), "a To of 'juan' does not stop the save", await status() );
ok( ! /No se guardó/.test( await toasts() ), "…and no 'not saved' is said", await toasts() );
await closeWriter();
ok( await readDrafts() && await c.until( "NayiveMail.S.items.some( m => m.subject === 'Para Juan' )" ), "the draft is in Drafts" );
await c.evaluate( "NayiveMail.openDraft( NayiveMail.S.items.find( m => m.subject === 'Para Juan' ) ); true" );
ok( await c.until( "! document.getElementById( 'composeView' ).hidden && document.getElementById( 'cTo' ).value === 'juan, bob@example.com'" ),
    "opened again: To as typed, 'juan' and all", await c.evaluate( "document.getElementById( 'cTo' ).value" ) );
await closeWriter();

section( "S3b I5 - SENT WITH NO COPY IN SENT: SAID, AND THE DRAFT STAYS" );
await fetch( s.base + "/e2e/send?nocopy=1" );
await c.evaluate( "NayiveMail.openTray( 'inbox' ); true" );
await compose( "bob@example.com", "Sin copia", "<div>el texto sin copia</div>" );
await c.evaluate( "window.__toasts = []; document.getElementById( 'cSend' ).click(); true" );
ok( await c.until( "document.getElementById( 'composeView' ).hidden && !! document.querySelector( '#toast .toast-undo' )", 15000 ), "Send: saved, then its Undo" );
await c.evaluate( "NayiveUI.undoSettle(); true" );         // the Undo's 6 s, now
ok( await c.until( "( window.__toasts || [] ).some( t => /no se pudo guardar una copia en Enviados/.test( t ) )", 15000 ),
    "it went, and the toast says no copy was kept in Sent", await toasts() );
ok( await until( async () => ( await rows( "drafts" ) ).some( m => m.subject === "Sin copia" ) ), "its draft stays in Drafts (the only copy of the words)" );
await fetch( s.base + "/e2e/send?nocopy=0" );

section( "S3b - THE SERVER'S NEW ANSWERS ARE SAID IN WORDS" );
const said = async code => c.evaluate( `NayiveMail.errText( { code: ${JSON.stringify( code )} } )` );
const down = await said( "down" );
ok( /dañado/.test( await said( "damaged" ) ), "a damaged mail file: said so (not 'the server does not answer')", await said( "damaged" ) );
ok( /etiquetas se conservan/.test( await said( "elsewhere" ) ), "a mail in another folder: its labels are kept", await said( "elsewhere" ) );
ok( /Mira en Enviados/.test( await said( "unsure" ) ) && await said( "unsure" ) !== down, "a send with no answer: look in Sent first", await said( "unsure" ) );
ok( /no se envía dos veces/.test( await said( "sent" ) ), "a second Send of one draft: refused, said why", await said( "sent" ) );

await done( c, s );
