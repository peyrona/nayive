// ds-office-rename.mjs - an office document's rename, "Save as" and first
// save never write over what is not theirs, and the screen says what the
// store's answers mean (batch C4c). Text in plain tabs; Calc for Restore.
//
// C3 (office #3): a rename while the save is held as "changed on another
//     device" moved THEIR file and dropped ours. Now refused, saying why.
// E5 (office #4): a rename while a save is not sent yet (quota full, a 5xx)
//     forgot the only copy of it. Now refused, saying why; it goes up later.
// C6 (office #18): after a rename the first save to the new name went up
//     with no check. Now it carries the version (the tag survives a move).
// D6 (office #5): "Save as" / the first save onto a name the page could not
//     check (offline, the listing failed) wrote over the file there on
//     reconnect. Now create-only; a name taken asks Replace / Keep both.
// K2 / K5 office side: a save kept only in this page, or gone before it was
//     sent, is said - never "Saved".
// G2 follow-up: Calc's Restore swap waits only for THIS file's save, not
//     for any save anywhere in the outbox.
// L5 (office #14): ana's tab left open while beto signed in on the same
//     browser: Restore and rename acted on BETO's files. Now refused.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { put, xlsx, bytesOnDisk, PW } from "./office-lib.mjs";

const s = await server( { ana: "aaa", beto: "bbb" } );
const phone = await s.client( "ana" );
const first = await browser( s, { user: "ana" } );
let c = first;

const CM    = "document.querySelector('.CodeMirror').CodeMirror";
const value = () => c.evaluate( `${CM}.getValue()` );
const type  = text => c.evaluate( `${CM}.replaceRange( ${JSON.stringify( text )}, { line: 0, ch: 0 } ), true` );
// Ctrl+S, the way CodeMirror hands it to the app (saveNow: no 7 s wait).
const save  = () => c.evaluate( `${CM}.triggerOnKeyDown( { type: 'keydown', keyCode: 83, ctrlKey: true, preventDefault: function () {}, stopPropagation: function () {} } ), true` );
const TOLD  = key => `( window.__toasts || [] ).some( function ( t ) { return t.indexOf( NayiveUI.t( '${key}' ) ) !== -1; } )`;
const label = () => c.evaluate( "document.getElementById('fileLabel').textContent" );
const disk  = ( rel, u ) => onDisk( s, rel, u || "ana" );
async function untilDisk( rel, want, ms = 15000, u )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { if( disk( rel, u ) === want ) return true; await new Promise( r => setTimeout( r, 150 ) ); }
    return false;
}
// Every question the shared sheet would ask, answered by the test:
// __asks[ i ].r( true | false | "other" ).
const ASK = `( function () { window.__asks = []; NayiveUI.confirm = function ( o ) {
    return new Promise( function ( r ) { window.__asks.push( { title: o.title, body: o.body, r: r } ); } ); }; return true; } )()`;
// The page's PUTs: path, If-Match, If-None-Match, status. And a switch per
// path that makes the server "answer" 507 (quota full) without sending.
const NET = `( function () { if( window.__puts ) return true; window.__puts = []; window.__fail = {}; var f = window.fetch;
    window.fetch = async function ( u, o ) {
        var url = String( u && u.url || u ), p = decodeURIComponent( url.replace( /^.*file=/, '' ).replace( /&.*$/, '' ) );
        if( o && o.method === 'PUT' && window.__fail[ p ] ) return new Response( '{}', { status: window.__fail[ p ] } );
        var r = await f.apply( this, arguments );
        if( o && o.method === 'PUT' ) { var h = o.headers || {}; window.__puts.push( { p: p, im: h[ 'If-Match' ] || null, inm: h[ 'If-None-Match' ] || null, st: r.status } ); }
        return r; };
    return true; } )()`;
// This browser's outbox: [ { path, body, conflict } ].
const OUTBOX = `new Promise( function ( res ) { var q = indexedDB.open( 'nube-store' ); q.onsuccess = function () {
    var db = q.result, g = db.transaction( 'outbox' ).objectStore( 'outbox' ).getAll();
    g.onsuccess = function () { db.close(); res( g.result.map( function ( e ) { return { path: e.file || e.path,
        body: typeof e.body === 'string' ? e.body : null, conflict: !! ( e.file ? e.xc : e.conflict ) }; } ) ); }; }; } )`;
const queued = async rel => ( await c.evaluate( OUTBOX ) ).find( e => e.path === rel ) || null;
async function untilQueued( rel, fn, ms = 10000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { const e = await queued( rel ); if( e && fn( e ) ) return e; await new Promise( r => setTimeout( r, 150 ) ); }
    return null;
}
// The file label: rename in place, as typed there.
const rename = name => c.evaluate( `( function () { document.getElementById('fileLabel').click();
    var i = document.getElementById('fileNameInput'); i.value = ${JSON.stringify( name )}; i.dispatchEvent( new Event( 'blur' ) ); return true; } )()` );

// Each case in a tab of its own, the last one closed (its beforeunload
// question - a save held back - must not stop the next case, and its store
// must not flush this case's outbox).
async function newTab()
{
    if( c !== first ) await fetch( `http://127.0.0.1:${first.port}/json/close/${c.id}` ).catch( () => {} );
    c = await first.tab();
    return c;
}

async function textPage( rel, want )
{
    await c.open( "/nayive/text/?file=" + rel, "/nayive/text/" );
    const up = await c.until( `document.querySelector('.CodeMirror') && ${CM}.getValue() === ${JSON.stringify( want )}`, 20000 );
    await c.evaluate( ASK );
    await c.evaluate( NET );
    return up;
}

//----------------------------------------------------------------------------//
section( "C3 · RENAME WHILE THE SAVE IS HELD AS \"CHANGED ON ANOTHER DEVICE\"" );
{
    await newTab();
    put( s, "files/c3.txt", "base\n", "ana" );
    ok( await textPage( "files/c3.txt", "base\n" ), "c3.txt is open" );
    await phone.put( "files/c3.txt", "PHONE\n" );
    await type( "mine\n" );
    await save();
    ok( await c.until( "window.__asks.length === 1" ), "the save meets the phone's: the conflict question" );
    await c.evaluate( "window.__asks[ 0 ] && window.__asks[ 0 ].r( false ), true" );           // "Not now"
    ok( !! await untilQueued( "files/c3.txt", e => e.conflict && e.body === "mine\nbase\n" ), "our text is held back in the outbox" );

    await rename( "c3-renamed.txt" );
    ok( await c.until( TOLD( "text.renameHeld" ), 8000 ), "the rename is refused, saying why", await c.toasts() );
    ok( disk( "files/c3.txt" ) === "PHONE\n" && disk( "files/c3-renamed.txt" ) === null, "nothing moved: the phone's version stays where it was",
        { old: disk( "files/c3.txt" ), now: disk( "files/c3-renamed.txt" ) } );
    ok( !! await queued( "files/c3.txt" ) && ( await queued( "files/c3.txt" ) ).body === "mine\nbase\n", "our text is still held, not forgotten" );
    ok( /c3\.txt$/.test( await label() ), "the document keeps its name", await label() );
}

//----------------------------------------------------------------------------//
section( "E5 · RENAME WHILE A SAVE IS NOT SENT YET (507)" );
{
    await newTab();
    put( s, "files/e5.txt", "base\n", "ana" );
    ok( await textPage( "files/e5.txt", "base\n" ), "e5.txt is open" );
    await c.evaluate( "window.__fail[ 'files/e5.txt' ] = 507, true" );
    await type( "unsent\n" );
    await save();
    ok( !! await untilQueued( "files/e5.txt", e => e.body === "unsent\nbase\n" ), "the save waits in the outbox (quota full)" );

    await rename( "e5-new.txt" );
    ok( await c.until( TOLD( "text.renameUnsent" ), 8000 ), "the rename is refused, saying why", await c.toasts() );
    ok( disk( "files/e5.txt" ) === "base\n" && disk( "files/e5-new.txt" ) === null, "nothing moved" );
    ok( !! await queued( "files/e5.txt" ), "the unsent text is still in the outbox" );
    await c.evaluate( "window.__fail = {}, window.dispatchEvent( new Event( 'online' ) ), true" );
    ok( await untilDisk( "files/e5.txt", "unsent\nbase\n" ), "room again: it goes up", disk( "files/e5.txt" ) );
}

//----------------------------------------------------------------------------//
section( "C6 · THE FIRST SAVE AFTER A RENAME IS CHECKED" );
{
    await newTab();
    put( s, "files/c6.txt", "base\n", "ana" );
    ok( await textPage( "files/c6.txt", "base\n" ), "c6.txt is open" );
    await type( "one\n" );
    await save();
    ok( await untilDisk( "files/c6.txt", "one\nbase\n" ), "saved" );
    await rename( "c6b.txt" );
    ok( await untilDisk( "files/c6b.txt", "one\nbase\n" ) && disk( "files/c6.txt" ) === null && await c.until( "/c6b\\.txt$/.test( document.getElementById('fileLabel').textContent )" ),
        "renamed to c6b.txt" );

    await phone.put( "files/c6b.txt", "PHONE AT THE NEW NAME\n" );
    await type( "two\n" );
    await save();
    ok( await c.until( "window.__puts.some( function ( p ) { return p.p === 'files/c6b.txt'; } )" ), "the next save goes to the new name" );
    const p = await c.evaluate( "window.__puts.filter( function ( p ) { return p.p === 'files/c6b.txt'; } )[ 0 ]" );
    ok( p && p.im && p.st === 412, "it carries the version (If-Match) - and meets the phone's: 412", p );
    ok( disk( "files/c6b.txt" ) === "PHONE AT THE NEW NAME\n", "the phone's save at the new name is not written over", disk( "files/c6b.txt" ) );
    ok( await c.until( "window.__asks.length >= 1" ), "the conflict question is asked" );
    await c.evaluate( "window.__asks.forEach( function ( a ) { a.r( false ); } ), true" );
}

//----------------------------------------------------------------------------//
section( "D6 · SAVE AS ONTO A NAME THE PAGE COULD NOT CHECK (THE LISTING FAILED)" );
{
    await newTab();
    put( s, "files/d6.txt", "PRECIOUS\n", "ana" );
    await c.open( "/nayive/text/?new=1", "/nayive/text/" );
    await c.until( "document.querySelector('.CodeMirror')", 20000 );
    await c.evaluate( ASK );
    await c.evaluate( NET );
    await c.evaluate( "GumApi.listDir = function () { var e = new Error( 'HTTP 500' ); e.status = 500; return Promise.reject( e ); }; true" );
    await type( "my new note\n" );
    ok( await c.until( "document.getElementById('saveAsBackdrop').classList.contains('open')" ), "the new note asks for its name" );
    await c.evaluate( "document.getElementById('saveName').value = 'd6.txt'; document.getElementById('saveAsConfirmBtn').click(); true" );
    ok( await c.until( "window.__asks.length >= 1", 10000 ), "the name is taken on the server: asked", await c.evaluate( "window.__puts" ) );
    const q = await c.evaluate( "window.__asks[ 0 ] && window.__asks[ 0 ].body" );
    ok( q === await c.evaluate( "NayiveUI.tf( 'ui.saveAsAppeared', { name: 'd6.txt' } )" ), "...Replace, or keep both", q );
    ok( disk( "files/d6.txt" ) === "PRECIOUS\n", "the file that was there is untouched", disk( "files/d6.txt" ) );
    ok( disk( "files/.bak/d6.txt" ) === null, "...and so is its .bak (none was written over it)", disk( "files/.bak/d6.txt" ) );
    ok( await c.evaluate( "window.__puts.some( function ( p ) { return p.p === 'files/d6.txt' && p.inm === '*' && p.st === 412; } )" ),
        "(the save was create-only: If-None-Match, 412)", await c.evaluate( "window.__puts" ) );
    await c.evaluate( "window.__asks[ 0 ] && window.__asks[ 0 ].r( 'other' ), true" );           // Keep both
    ok( await untilDisk( "files/d6 (2).txt", "my new note\n" ), "Keep both: this one is saved as d6 (2).txt", disk( "files/d6 (2).txt" ) );
    ok( await c.until( "/d6 \\(2\\)\\.txt$/.test( document.getElementById('fileLabel').textContent )" ), "...and the document is called so" );
    ok( disk( "files/d6.txt" ) === "PRECIOUS\n", "the other file is still untouched" );
    ok( ! await queued( "files/d6.txt" ), "nothing is left waiting for d6.txt" );
}

//----------------------------------------------------------------------------//
section( "D6 · ...AND OFFLINE: NEVER WRITTEN OVER ON RECONNECT" );
{
    await newTab();
    put( s, "files/d6off.txt", "PRECIOUS OFF\n", "ana" );
    await c.open( "/nayive/text/?new=1", "/nayive/text/" );
    await c.until( "document.querySelector('.CodeMirror')", 20000 );
    await c.evaluate( ASK );
    await c.evaluate( NET );
    await type( "written on the train\n" );
    ok( await c.until( "document.getElementById('saveAsBackdrop').classList.contains('open')" ), "the new note asks for its name" );
    await c.send( "Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    await c.until( "! navigator.onLine" );
    await c.evaluate( "document.getElementById('saveName').value = 'd6off.txt'; document.getElementById('saveAsConfirmBtn').click(); true" );
    ok( !! await untilQueued( "files/d6off.txt", e => e.body === "written on the train\n" ), "offline: it waits in the outbox" );
    await c.send( "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    ok( await c.until( "window.__asks.length >= 1", 15000 ), "back online: the name is taken - asked, not written over", await c.evaluate( "window.__puts" ) );
    ok( disk( "files/d6off.txt" ) === "PRECIOUS OFF\n", "the file that was there is untouched", disk( "files/d6off.txt" ) );
    await c.evaluate( "window.__asks[ 0 ] && window.__asks[ 0 ].r( true ), true" );               // Replace
    ok( await untilDisk( "files/d6off.txt", "written on the train\n" ), "Replace: this one goes over it", disk( "files/d6off.txt" ) );
    ok( disk( "files/.bak/d6off.txt" ) === "PRECIOUS OFF\n", "...and what was there is kept in its .bak", disk( "files/.bak/d6off.txt" ) );
}

//----------------------------------------------------------------------------//
section( "K2 · A SAVE KEPT ONLY IN THIS PAGE IS SAID, NEVER \"SAVED\"" );
{
    await newTab();
    put( s, "files/k2.txt", "base\n", "ana" );
    ok( await textPage( "files/k2.txt", "base\n" ), "k2.txt is open" );
    // The browser's storage AND the network fail: only the page has it.
    await c.evaluate( `( function () { window.__realTx = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function () { throw new DOMException( 'Connection to Indexed Database server lost.', 'UnknownError' ); };
        window.__fail[ 'files/k2.txt' ] = 503; return true; } )()` );
    await type( "only here\n" );
    await save();
    ok( await c.until( "document.getElementById('savedAt').title.indexOf( NayiveUI.t( 'write.pageOnlyAt' ) ) === 0", 10000 ),
        "the screen says it is only in this page", await c.evaluate( "document.getElementById('savedAt').title" ) );
    ok( await c.evaluate( "document.getElementById('savedAt').dataset.state === 'unsaved'" ), "...not \"Saved\" (red floppy)" );
    await c.evaluate( "IDBDatabase.prototype.transaction = window.__realTx; window.__fail = {}; window.dispatchEvent( new Event( 'online' ) ); true" );
    ok( await untilDisk( "files/k2.txt", "only here\nbase\n" ), "storage and network back: it goes up" );
    ok( await c.until( "document.getElementById('savedAt').title.indexOf( NayiveUI.t( 'write.pageOnlyAt' ) ) !== 0" ), "...and the screen stops saying \"only in this page\"" );
}

//----------------------------------------------------------------------------//
section( "K5 · A SAVE CLEARED BEFORE IT WAS SENT IS SAID: NOT SAVED" );
{
    await newTab();
    put( s, "files/k5.txt", "base\n", "ana" );
    ok( await textPage( "files/k5.txt", "base\n" ), "k5.txt is open" );
    await c.evaluate( `( function () { var f = window.fetch; window.__gate = null;
        window.fetch = function ( u, o ) {
            if( o && o.method === 'PUT' && String( u ).indexOf( 'k5.txt' ) !== -1 && ! window.__gate )
                return new Promise( function ( r ) { window.__gate = function () { r( f( u, o ) ); }; } );
            return f( u, o ); };
        return true; } )()` );
    await type( "first\n" );
    await save();
    ok( await c.until( "!! window.__gate" ), "a save is on its way (held)" );
    await type( "second\n" );
    await save();
    ok( !! await untilQueued( "files/k5.txt", e => e.body === "second\nfirst\nbase\n" ), "the next one waits in the outbox" );
    const L = await first.tab();
    await L.open( "/nayive/" );
    await L.until( "window.NayiveStore" );
    await L.evaluate( "NayiveStore.localCount().then( () => NayiveStore.clearLocal() ).then( () => true )" );   // a sign-out's "yes", in another tab
    await c.front();
    await c.evaluate( "window.__gate(), true" );
    ok( await c.until( TOLD( "write.notSaved" ), 10000 ), "the cleared save says: not saved", await c.toasts() );
    await fetch( `http://127.0.0.1:${first.port}/json/close/${L.id}` ).catch( () => {} );
}

//----------------------------------------------------------------------------//
section( "G2 · CALC'S RESTORE WAITS ONLY FOR ITS OWN FILE'S SAVE" );
{
    const NOW = xlsx( { a1: "NOW5" } ), OLD = xlsx( { a1: "OLD5", protect: true } );
    put( s, "files/sw.xlsx", NOW, "ana" );
    put( s, "files/.bak/sw.xlsx", OLD, "ana" );
    await newTab();
    const A1 = "( function () { var td = document.querySelector('#gridHost .ht_master tbody tr td'); return td ? td.textContent : null; } )()";
    await c.open( "/nayive/calc/?file=files/sw.xlsx", "/nayive/calc/" );
    await c.evaluate( PW + "( window )" );
    ok( await c.until( `${A1} === 'NOW5' && document.getElementById('fileLabel').textContent`, 20000 ), "sw.xlsx is open" );
    // Another file's save waits in the outbox, refused for now (503).
    await c.evaluate( NET );
    await c.evaluate( `new Promise( function ( res ) { window.__fail[ 'files/other.txt' ] = 503;
        var q = indexedDB.open( 'nube-store' ); q.onsuccess = function () {
            var tx = q.result.transaction( 'outbox', 'readwrite' );
            tx.objectStore( 'outbox' ).put( { path: 'files/other.txt', body: 'another file', queuedAt: Date.now(), conflict: false,
                                              bin: false, ius: false, who: NayiveStore.me, ver: 1, id: 'other-1', inc: [], anc: [] } );
            tx.oncomplete = function () { q.result.close(); res( true ); }; }; } )` );
    await c.evaluate( "document.getElementById('restoreBtn').click(), true" );
    ok( await c.until( `${A1} === 'OLD5'`, 15000 ), "Restore swaps (another file's waiting save does not stop it)", await c.toasts() );
    let f = null;
    for( let i = 0; i < 50 && ! ( f && f.equals( OLD ) ); i++ ) { await new Promise( r => setTimeout( r, 200 ) ); f = bytesOnDisk( s, "files/sw.xlsx", "ana" ); }
    ok( f && f.equals( OLD ) && bytesOnDisk( s, "files/.bak/sw.xlsx", "ana" ).equals( NOW ), "the two files are swapped" );
    await c.evaluate( `new Promise( function ( res ) { var q = indexedDB.open( 'nube-store' ); q.onsuccess = function () {
        var tx = q.result.transaction( 'outbox', 'readwrite' ); tx.objectStore( 'outbox' ).delete( 'files/other.txt' );
        tx.oncomplete = function () { q.result.close(); res( true ); }; }; } )` );
}

//----------------------------------------------------------------------------//
section( "L5 · ANA'S TAB, BETO SIGNED IN ON THE SAME BROWSER" );
{
    put( s, "files/l5.txt", "ana's text\n", "ana" );
    put( s, "files/.bak/l5.txt", "ana's old text\n", "ana" );
    put( s, "files/l5.txt", "BETO's text\n", "beto" );
    put( s, "files/.bak/l5.txt", "BETO's old text\n", "beto" );
    await newTab();
    ok( await textPage( "files/l5.txt", "ana's text\n" ), "ana's l5.txt is open" );
    ok( await c.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { user: 'beto', password: 'bbb' } ) } ).then( r => r.status === 200 )` ), "beto signs in on this browser (another tab)" );

    await c.evaluate( "document.getElementById('restoreBtn').click(), true" );
    ok( await c.until( TOLD( "ui.otherAccountHere" ), 8000 ), "Restore is refused, saying why", await c.toasts() );
    ok( await value() === "ana's text\n", "ana's screen still shows her text", await value() );
    ok( disk( "files/.bak/l5.txt", "beto" ) === "BETO's old text\n" && disk( "files/l5.txt", "beto" ) === "BETO's text\n",
        "beto's file and .bak are untouched", { bak: disk( "files/.bak/l5.txt", "beto" ) } );

    await c.evaluate( "window.__toasts = [], true" );
    await rename( "l5-renamed.txt" );
    ok( await c.until( TOLD( "ui.otherAccountHere" ), 8000 ), "rename is refused too", await c.toasts() );
    ok( disk( "files/l5.txt", "beto" ) === "BETO's text\n" && disk( "files/l5-renamed.txt", "beto" ) === null, "beto's file was not moved" );
    ok( disk( "files/l5.txt", "ana" ) === "ana's text\n", "nor ana's" );
}

await done( first, s );
