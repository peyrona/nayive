// run.mjs - Quick notes (shared/notes.js) in a real (headless) browser: the
// launcher's cards on a phone, the desktop's sticky notes and its "show the
// desk" button. Its own scratch server; the real store/ is never touched.
//
//   node tools/notes-test/run.mjs
//
// PHONE: no server and nothing cached is not "no notes"; a fresh home makes notes.json at the first note; a blank note is
//   never saved; an old checklist (another device) opens as text, one line per
//   item, and is saved as text; pin + colour; delete +
//   Undo; another device's save merges with this one's; a damaged file is
//   never written over.
// DESKTOP: the notes sit on the wallpaper; "show the desk" hides the windows
//   and brings the same ones back (Tile on too); a window opened meanwhile ends
//   it; "+" shows the desk and makes a note; moving one changes this device
//   only; a blank one goes when the focus leaves.
import { server, browser, ok, section, done, onDisk, sleep, seed } from "../browser-test/lib.mjs";
import { disk, type, click } from "../data-safety-test/lib.mjs";

const F = "data/notes/notes.json";

// The notes pair sits in the launcher menu's top row (a frame): open the menu, then a real
// mouse press at the frame's offset plus the button's place in it.
const MENU_DOC = "document.querySelector( '#menu iframe' ).contentDocument";
const inMenu = id => `${MENU_DOC}.getElementById( '${id}' )`;
async function pairClick( c, id )
{
    await c.evaluate( "document.getElementById( 'menu' ).hidden && document.getElementById( 'menuBtn' ).click(); true" );
    await c.until( `( () => { try { const b = ${inMenu( id )}; return !! b && b.getBoundingClientRect().width > 0; } catch( e ) { return false; } } )()` );
    const r = await c.evaluate( `( () => { const f = document.querySelector( '#menu iframe' ).getBoundingClientRect(), b = ${inMenu( id )}.getBoundingClientRect();
        return { x: f.left + b.left + b.width / 2, y: f.top + b.top + b.height / 2 }; } )()` );
    await c.send( "Page.bringToFront" );
    for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] )
        await c.send( "Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } );
}
const s = await server();
const phone = await s.client();
const json = () => { try { return JSON.parse( onDisk( s, F ) ); } catch { return null; } };
const has = ( pred ) => disk( () => { const l = json(); return l && pred( l ); } );

//------------------------------------------------------------------------//
section( "PHONE · THE FIRST NOTE" );
const c = await browser( s, { width: 390, height: 844 } );
await c.open( "/nayive/" );
ok( await c.until( "document.querySelector( '.notes-wall .notes-empty' ) && ! document.querySelector( '.notes-wall .notes-empty' ).hidden" ), "the launcher shows the empty notes section" );
ok( onDisk( s, F ) === null, "no notes.json before the first note" );

// A blank note is never saved.
await click( c, "#notesNewBtn" );
ok( await c.until( "document.querySelector( 'dialog.notes-full' ).open && document.activeElement.classList.contains( 'note-text' )" ), "+ opens the full view, the text field focused" );
await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
await sleep( 1200 );
ok( onDisk( s, F ) === null && await c.evaluate( "document.querySelectorAll( '.note.card' ).length === 0" ), "a note left blank is not saved and not shown" );

await click( c, "#notesNewBtn" );
await c.until( "document.activeElement.classList.contains( 'note-text' )" );
await type( c, "Call the plumber" );
ok( await has( l => l.length === 1 && l[ 0 ].text === "Call the plumber" && ! l[ 0 ].list ), "the text is saved while typed (fresh home: notes.json made)" );
await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
ok( await c.until( "[ ...document.querySelectorAll( '.note.card' ) ].some( x => x.textContent.includes( 'Call the plumber' ) )" ), "back: its card shows" );

//------------------------------------------------------------------------//
section( "PHONE · AN OLD CHECKLIST" );
// Checklists were dropped (2026-11-12, notes.js norm): one saved by another
// device opens as text, one line per item, and an edit saves it as text.
{
    const now = json();
    now.push( { id: "n_shop", title: "Shopping", text: "", list: true, pinned: false, color: null, created: 2, updated: 2,
                items: [ { id: "i_1", text: "Eggs", done: true }, { id: "i_2", text: "Bread", done: false } ] } );
    ok( ( await phone.put( F, JSON.stringify( now, null, 2 ) ) ).status === 200, "another device saves a checklist" );
    await c.open( "/nayive/" );
    ok( await c.until( "[ ...document.querySelectorAll( '.note.card' ) ].some( x => /Shopping/.test( x.textContent ) && /Eggs/.test( x.textContent ) && /Bread/.test( x.textContent ) )" ),
        "its card shows the items as text" );
    await c.evaluate( "[ ...document.querySelectorAll( '.note.card' ) ].find( x => x.textContent.includes( 'Shopping' ) ).click(); true" );
    await c.until( "document.querySelector( 'dialog.notes-full' ).open" );
    ok( await c.evaluate( "document.querySelector( 'dialog.notes-full .note-text' ).value === 'Eggs\\nBread'" ), "opened: one line per item",
        await c.evaluate( "document.querySelector( 'dialog.notes-full .note-text' ).value" ) );
    await c.evaluate( "( t => { t.focus(); t.setSelectionRange( t.value.length, t.value.length ); return true; } )( document.querySelector( 'dialog.notes-full .note-text' ) )" );
    await type( c, " and milk" );
    ok( await has( l => { const n = l.find( x => x.id === "n_shop" ); return n && ! n.list && ! n.items.length && n.text === "Eggs\nBread and milk"; } ),
        "an edit saves it as text, nothing lost", json() );
    await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
    ok( await c.evaluate( "! document.querySelector( 'dialog.notes-full' ).open" ), "closed" );
}

//------------------------------------------------------------------------//
section( "PHONE · PIN AND COLOUR" );
const openCard = t => c.evaluate( `[ ...document.querySelectorAll( '.note.card' ) ].find( x => x.textContent.includes( ${JSON.stringify( t )} ) ).click(); true` );
await openCard( "Call the plumber" );
await c.until( "document.querySelector( 'dialog.notes-full' ).open" );
await c.evaluate( "document.querySelectorAll( 'dialog.notes-full .note-tools .btn' )[ 1 ].click(); true" );       // pin
await c.evaluate( "document.querySelectorAll( 'dialog.notes-full .note-tools .btn' )[ 0 ].click(); true" );       // colour
await c.until( "document.querySelector( '.notes-pal' ) && document.querySelector( '.notes-pal' ).matches( ':popover-open' )" );
await c.evaluate( "document.querySelector( '.notes-pal [data-v=\"3\"]' ).click(); true" );
ok( await has( l => { const n = l.find( x => x.text === "Call the plumber" ); return n && n.pinned && n.color === 3; } ), "pinned, colour 4 saved" );
await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
ok( await c.until( "document.querySelector( '.note.card' ).textContent.includes( 'Call the plumber' ) && document.querySelector( '.note.card' ).dataset.c === '3'" ),
    "the pinned note comes first, in its colour" );

//------------------------------------------------------------------------//
section( "PHONE · DELETE AND UNDO" );
await openCard( "Shopping" );
await c.until( "document.querySelector( 'dialog.notes-full' ).open" );
await c.evaluate( "document.querySelectorAll( 'dialog.notes-full .note-tools .btn' )[ 2 ].click(); true" );     // delete
ok( await has( l => l.length === 1 ), "deleted at once" );
ok( await c.evaluate( "! document.querySelector( 'dialog.notes-full' ).open" ), "the full view closes" );
ok( await c.until( "[ ...document.querySelectorAll( '#ayni-toasts .toast.undo button' ) ].length" ), "an Undo toast" );
await c.evaluate( "[ ...document.querySelectorAll( '#ayni-toasts .toast.undo button' ) ].find( b => ! b.matches( '[data-close], .toast-x' ) ).click(); true" );
ok( await has( l => l.length === 2 && l.some( x => x.title === "Shopping" && x.text === "Eggs\nBread and milk" ) ), "Undo puts it back, with its text" );

//------------------------------------------------------------------------//
section( "PHONE · ANOTHER DEVICE SAVED MEANWHILE" );
{
    const now = json();
    now.push( { id: "n_other", title: "From the PC", text: "hi", list: false, items: [], pinned: false, color: null, created: 1, updated: 1 } );
    const r = await phone.put( F, JSON.stringify( now, null, 2 ) );
    ok( r.status === 200, "the other device saves" );
    await openCard( "Call the plumber" );
    await c.until( "document.querySelector( 'dialog.notes-full' ).open" );
    await c.evaluate( "const t = document.querySelector( 'dialog.notes-full .note-text' ); t.focus(); t.setSelectionRange( t.value.length, t.value.length ); true" );
    await type( c, " today" );
    ok( await has( l => l.some( x => x.id === "n_other" ) && l.some( x => x.text === "Call the plumber today" ) ), "both kept: its note and this edit" );
    await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
    ok( await c.until( "[ ...document.querySelectorAll( '.note.card' ) ].some( x => x.textContent.includes( 'From the PC' ) )" ), "its note shows here" );
}

//------------------------------------------------------------------------//
section( "PHONE · A DAMAGED FILE" );
{
    const c2 = await browser( s, { width: 390, height: 844 } );
    const good = onDisk( s, F );
    await phone.put( F, "{ not json" );
    await c2.open( "/nayive/" );
    ok( await c2.until( "[ ...document.querySelectorAll( '#ayni-toasts .toast' ) ].some( t => /damaged/.test( t.textContent ) )" ), "it says the file is damaged" );
    await click( c2, "#notesNewBtn" );
    await sleep( 1500 );
    ok( onDisk( s, F ) === "{ not json" && await c2.evaluate( "! ( document.querySelector( 'dialog.notes-full' ) || {} ).open" ), "+ is refused; the file is not written over" );
    await phone.put( F, good );
    c2.stop();
}

//------------------------------------------------------------------------//
section( "PHONE · NO SERVER, NOTHING CACHED" );
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
section( "DESKTOP · STICKY NOTES" );
const d = await browser( s, { mouse: true } );
await d.open( "/nayive/desktop/" );
const nOnDisk = json().length;
ok( await d.until( `document.querySelectorAll( '.notes-layer .note.sticky' ).length === ${nOnDisk}` ), "every note sits on the wallpaper", nOnDisk );
ok( await d.evaluate( "document.querySelector( '.notes-layer .note.sticky .note-text, .notes-layer .note.sticky .note-items' ) !== null" ), "each with its editor" );

section( "DESKTOP · SHOW THE DESK" );
await d.until( "window.AyniDesk && AyniDesk.open" );
await d.evaluate( "AyniDesk.open( '/nayive/calculator/index.html' ); AyniDesk.open( '/nayive/games/index.html' ); true" );
await d.until( "document.querySelectorAll( '.win:not([hidden])' ).length === 2" );
const order = () => d.evaluate( "[ ...document.querySelectorAll( '.win' ) ].sort( ( a, b ) => a.style.zIndex - b.style.zIndex ).map( w => w.querySelector( 'iframe' ).src.split( '/' ).slice( -2, -1 )[ 0 ] ).join()" );
const before = await order();
await pairClick( d, "deskBtn" );
ok( await d.until( "document.querySelectorAll( '.win:not([hidden])' ).length === 0 && " + inMenu( "deskBtn" ) + ".getAttribute( 'aria-pressed' ) === 'true'" ), "every window hidden, the button pressed" );
await pairClick( d, "deskBtn" );
ok( await d.until( "document.querySelectorAll( '.win:not([hidden])' ).length === 2 && " + inMenu( "deskBtn" ) + ".getAttribute( 'aria-pressed' ) === 'false'" ), "a second press brings both back" );
ok( await order() === before, "in the same order", before );

await pairClick( d, "deskBtn" );
await d.until( "document.querySelectorAll( '.win:not([hidden])' ).length === 0" );
await d.evaluate( "AyniDesk.open( '/nayive/split/index.html' ); true" );
ok( await d.until( inMenu( "deskBtn" ) + ".getAttribute( 'aria-pressed' ) === 'false'" ), "a window opened meanwhile ends it" );

await d.evaluate( "AyniDesk.tile(); true" );
await d.until( "AyniDesk.isTiled()" );
const shown = await d.evaluate( "document.querySelectorAll( '.win:not([hidden])' ).length" );
await pairClick( d, "deskBtn" );
await d.until( "document.querySelectorAll( '.win:not([hidden])' ).length === 0" );
await pairClick( d, "deskBtn" );
ok( await d.until( `document.querySelectorAll( '.win:not([hidden])' ).length === ${shown} && AyniDesk.isTiled()` ), "with Tile on: hidden, back, still tiled", shown );
await d.evaluate( "AyniDesk.untile(); true" );

section( "DESKTOP · + A NEW NOTE" );
await pairClick( d, "noteNewBtn" );
ok( await d.until( "document.querySelectorAll( '.win:not([hidden])' ).length === 0" ), "+ shows the desk" );
ok( await d.until( "document.activeElement && document.activeElement.classList.contains( 'note-text' ) && document.activeElement.closest( '.note.sticky' )" ), "a new sticky note, its text focused" );
await type( d, "Desk note" );
ok( await has( l => l.some( x => x.text === "Desk note" ) ), "saved" );
ok( ! /"x"|"left"/.test( onDisk( s, F ) ), "no place in the shared file" );

section( "DESKTOP · A PINNED NOTE FLOATS OVER THE WINDOWS" );
{
    const pid = await d.evaluate( "document.activeElement.closest( '.note.sticky' ).dataset.id" );
    await d.evaluate( `document.querySelectorAll( '.note.sticky[data-id="${pid}"] .note-tools .btn' )[ 1 ].click(); true` );
    ok( await has( l => l.find( x => x.id === pid ).pinned ), "pinned, saved" );
    await d.evaluate( "AyniDesk.open( '/nayive/calculator/index.html' ); true" );
    await d.until( "document.querySelectorAll( '.win:not([hidden])' ).length" );
    ok( await d.evaluate( `( () => { const n = document.querySelector( '.note.sticky[data-id="${pid}"]' ), b = n.getBoundingClientRect();
        return n.parentNode.matches( '.notes-layer.top' ) && document.elementFromPoint( b.left + b.width / 2, b.top + 10 ).closest( '.note.sticky' ) === n; } )()` ),
        "it sits above an open window and takes the clicks there" );
    await d.evaluate( `document.querySelectorAll( '.note.sticky[data-id="${pid}"] .note-tools .btn' )[ 1 ].click(); true` );
    ok( await d.until( `document.querySelector( '.note.sticky[data-id="${pid}"]' ).parentNode.id === 'notesLayer'` ), "unpinned: back under the windows" );
    await d.evaluate( `document.querySelector( '.note.sticky[data-id="${pid}"] .note-text' ).focus(); true` );
}

section( "DESKTOP · MOVE, AND A BLANK ONE" );
const posKey = "nayive-notes-pos:" + await d.evaluate( "AyniStore.me || ''" );
const id = await d.evaluate( "document.activeElement.closest( '.note.sticky' ).dataset.id" );
const p0 = await d.evaluate( `JSON.parse( localStorage.getItem( ${JSON.stringify( posKey )} ) )[ ${JSON.stringify( id )} ]` );
const r = await d.evaluate( `( () => { const b = document.querySelector( '.note.sticky[data-id="${id}"] .note-strip' ).getBoundingClientRect(); return { x: b.left + 3, y: b.top + b.height / 2 }; } )()` );
await d.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y, button: "left", buttons: 0 } );
await d.send( "Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", buttons: 1, clickCount: 1 } );
for( let i = 1; i <= 5; i++ ) await d.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + i * 20, y: r.y + i * 16, button: "left", buttons: 1 } );
await d.send( "Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 100, y: r.y + 80, button: "left", buttons: 0, clickCount: 1 } );
const p1 = await d.evaluate( `JSON.parse( localStorage.getItem( ${JSON.stringify( posKey )} ) )[ ${JSON.stringify( id )} ]` );
ok( p1 && p1.x === p0.x + 100 && p1.y === p0.y + 80, "dragged by its top strip: this device keeps the place", JSON.stringify( [ p0, p1 ] ) );

const count = json().length;
await pairClick( d, "noteNewBtn" );
await d.until( "document.activeElement && document.activeElement.classList.contains( 'note-text' )" );
const n1 = await d.evaluate( "document.querySelectorAll( '.note.sticky' ).length" );
await d.evaluate( "document.activeElement.blur(); true" );
ok( await d.until( `document.querySelectorAll( '.note.sticky' ).length === ${n1 - 1}` ), "a blank note goes when the focus leaves" );
await sleep( 1200 );
ok( json().length === count, "and was never saved" );

section( "DESKTOP · THE MENU'S LAUNCHER HAS NO NOTES" );
ok( await d.until( "document.querySelector( '#menu iframe' ) && document.querySelector( '#menu iframe' ).contentDocument.readyState === 'complete' && document.querySelector( '#menu iframe' ).contentDocument.querySelector( '.grid' )" ), "the menu loaded" );
await sleep( 800 );
ok( await d.evaluate( "! document.querySelector( '#menu iframe' ).contentDocument.querySelector( '.notes-wall' )" ), "no notes section in it" );

d.stop();
c.stop();
await done();
