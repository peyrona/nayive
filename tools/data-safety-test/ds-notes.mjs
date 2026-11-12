// ds-notes.mjs - Quick notes (shared/notes.js, data/notes/notes.json), the
// launcher's cards and the desktop's sticky notes. Real pages in Chromium, a
// second "device" over plain HTTP.
//
// N1 the first note makes the file; a note left blank is never saved.
// N2 a damaged file is never written over ("+" is refused).
// N3 no server and nothing cached is not "no notes": nothing is written.
// N4 another device's save meanwhile: both kept (412 -> merge by id).
// N5 delete + Undo: back as it was, in the list as it is now.
// N6 the desktop: a sticky note saves; its place never reaches the file.
import { server, browser, ok, section, done, onDisk, disk, type, click, sleep } from "./lib.mjs";

const F = "data/notes/notes.json";
const s = await server();
const phone = await s.client();
const json = () => { try { return JSON.parse( onDisk( s, F ) ); } catch { return null; } };
const has  = pred => disk( () => { const l = json(); return l && pred( l ); }, 30000 );
const ready = "document.querySelector( '.notes-wall .notes-empty' ) && ( ! document.querySelector( '.notes-wall .notes-empty' ).hidden || document.querySelector( '.note.card' ) )";
const closeFull = c => c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
const openCard  = ( c, t ) => c.evaluate( `[ ...document.querySelectorAll( '.note.card' ) ].find( x => x.textContent.includes( ${JSON.stringify( t )} ) ).click(); true` );

//------------------------------------------------------------------------//
section( "N1 · THE FIRST NOTE, A BLANK ONE" );
const c = await browser( s, { width: 390, height: 844 } );
await c.open( "/nayive/" );
ok( await c.until( ready ), "the notes section is ready" );
await click( c, "#notesNewBtn" );
await c.until( "document.activeElement && document.activeElement.classList.contains( 'note-text' )" );
await closeFull( c );
await sleep( 1500 );
ok( onDisk( s, F ) === null, "a note left blank: no file" );
await click( c, "#notesNewBtn" );
await c.until( "document.activeElement && document.activeElement.classList.contains( 'note-text' )" );
await type( c, "first" );
ok( await has( l => l.length === 1 && l[ 0 ].text === "first" ), "the first note makes the file" );
await closeFull( c );

//------------------------------------------------------------------------//
section( "N4 · ANOTHER DEVICE SAVED MEANWHILE" );
{
    const l = json();
    l.push( { id: "n_pc", title: "PC", text: "from the PC", list: false, items: [], pinned: false, color: null, created: 1, updated: 1 } );
    ok( ( await phone.put( F, JSON.stringify( l, null, 2 ) ) ).status === 200, "the other device saves" );
    await openCard( c, "first" );
    await c.until( "document.querySelector( 'dialog.notes-full' ).open" );
    await c.evaluate( "const t = document.querySelector( 'dialog.notes-full .note-text' ); t.focus(); t.setSelectionRange( 5, 5 ); true" );
    await type( c, " edit" );
    ok( await has( l => l.some( x => x.id === "n_pc" && x.text === "from the PC" ) && l.some( x => x.text === "first edit" ) ), "both kept" );
    await closeFull( c );
}

//------------------------------------------------------------------------//
section( "N5 · DELETE AND UNDO" );
{
    await openCard( c, "first edit" );
    await c.until( "document.querySelector( 'dialog.notes-full' ).open" );
    await c.evaluate( "document.querySelectorAll( 'dialog.notes-full .note-tools .btn' )[ 2 ].click(); true" );     // colour · pin · delete
    ok( await has( l => l.length === 1 && l[ 0 ].id === "n_pc" ), "deleted" );
    // the other device adds one before the Undo
    const l = json();
    l.push( { id: "n_pc2", title: "PC2", text: "second", list: false, items: [], pinned: false, color: null, created: 2, updated: 2 } );
    await phone.put( F, JSON.stringify( l, null, 2 ) );
    await c.until( "document.querySelector( '#ayni-toasts .toast.undo' )" );
    await c.evaluate( "[ ...document.querySelectorAll( '#ayni-toasts .toast.undo button' ) ][ 0 ].click(); true" );
    ok( await has( l => l.some( x => x.text === "first edit" ) && l.some( x => x.id === "n_pc2" ) && l.some( x => x.id === "n_pc" ) ),
        "Undo brings it back and keeps the other device's new note" );
}

//------------------------------------------------------------------------//
section( "N2 · A DAMAGED FILE" );
{
    const good = onDisk( s, F );
    await phone.put( F, "{ broken" );
    const c2 = await browser( s, { width: 390, height: 844 } );
    await c2.open( "/nayive/" );
    await c2.until( "[ ...document.querySelectorAll( '#ayni-toasts .toast' ) ].some( t => /damaged/.test( t.textContent ) )" );
    await click( c2, "#notesNewBtn" );
    await sleep( 2000 );
    ok( onDisk( s, F ) === "{ broken", "never written over" );
    await phone.put( F, good );
    c2.stop();
}

//------------------------------------------------------------------------//
section( "N3 · NO SERVER, NOTHING CACHED" );
{
    // A fresh profile whose notes GET never reaches the server (a network
    // error, on the page's own DevTools target, armed before it loads): it
    // holds nothing, so it must not say "no notes", and "+" must not save.
    const before = onDisk( s, F );
    const c3 = await browser( s, { width: 390, height: 844 } );
    const tg = ( await ( await fetch( `http://127.0.0.1:${c3.port}/json` ) ).json() ).find( t => t.id === c3.id );
    const ws = new WebSocket( tg.webSocketDebuggerUrl );
    await new Promise( ( r, j ) => { ws.onopen = r; ws.onerror = j; } );
    let armed = null, failed = 0;
    const on = new Promise( r => { armed = r; } );
    ws.onmessage = e =>
    {
        const m = JSON.parse( e.data );
        if( m.id === 1 ) armed();
        if( m.method !== "Fetch.requestPaused" ) return;
        failed++;
        ws.send( JSON.stringify( { id: 1000 + failed, method: "Fetch.failRequest", params: { requestId: m.params.requestId, errorReason: "InternetDisconnected" } } ) );
    };
    ws.send( JSON.stringify( { id: 1, method: "Fetch.enable", params: { patterns: [ { urlPattern: "*notes%2Fnotes.json*" }, { urlPattern: "*notes/notes.json*" } ] } } ) );
    await on;
    await c3.open( "/nayive/" );
    ok( await disk( () => failed > 0, 15000 ), "the read failed", failed );
    await sleep( 1000 );
    ok( await c3.evaluate( "document.querySelector( '.notes-wall .notes-empty' ).hidden && ! document.querySelector( '.note.card' )" ), "it does not say \"no notes\"" );
    await click( c3, "#notesNewBtn" );
    await sleep( 2000 );
    ok( onDisk( s, F ) === before && await c3.evaluate( "! ( document.querySelector( 'dialog.notes-full' ) || {} ).open" ), "+ is refused, the file is untouched" );
    ws.close();
    c3.stop();
}

//------------------------------------------------------------------------//
section( "N6 · THE DESKTOP" );
{
    const d = await browser( s, { mouse: true } );
    await d.open( "/nayive/desktop/" );
    await d.until( "document.querySelectorAll( '.notes-layer .note.sticky' ).length" );
    // the notes pair sits in the launcher menu's top row (a frame): open the menu, press at frame offset + its place
    await d.evaluate( "document.getElementById( 'menu' ).hidden && document.getElementById( 'menuBtn' ).click(); true" );
    const NB = "document.querySelector( '#menu iframe' ).contentDocument.getElementById( 'noteNewBtn' )";
    await d.until( `( () => { try { return ${NB}.getBoundingClientRect().width > 0; } catch( e ) { return false; } } )()` );
    const nr = await d.evaluate( `( () => { const f = document.querySelector( '#menu iframe' ).getBoundingClientRect(), b = ${NB}.getBoundingClientRect();
        return { x: f.left + b.left + b.width / 2, y: f.top + b.top + b.height / 2 }; } )()` );
    for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] )
        await d.send( "Input.dispatchMouseEvent", { type, x: nr.x, y: nr.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } );
    await d.until( "document.activeElement && document.activeElement.closest( '.note.sticky' )" );
    await type( d, "on the desk" );
    ok( await has( l => l.some( x => x.text === "on the desk" ) ), "a sticky note saves" );
    ok( ! /"(x|y|w|h|z|left|top)"\s*:/.test( onDisk( s, F ) ), "its place is not in the shared file" );
    ok( json().length === 4, "nothing else changed", json().length );
    d.stop();
}

c.stop();
await done();
