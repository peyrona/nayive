// run.mjs - Quick notes (shared/notes.js) in a real (headless) browser: the
// launcher's cards on a phone, the desktop's notes panel and its pinned
// notes. Its own scratch server; the real store/ is never touched.
//
//   node tools/notes-test/run.mjs
//
// PHONE: no server and nothing cached is not "no notes"; a fresh home makes notes.json at the first note; a blank note is
//   never saved; an old checklist (another device) opens as text, one line per
//   item, and is saved as text; pin + colour; delete +
//   Undo; another device's save merges with this one's; a damaged file is
//   never written over.
// DESKTOP: the notes sit in a panel on the right (shut at first, nothing on the
//   wallpaper); Office › Notes opens it, ×, Esc shut it; ← spreads it as a board of every note, → back; its "+"
//   makes a note, first (the menu has no "new note"); a pinned note floats over the windows, moving it
//   changes this device only, unpinned it is back in the panel; a blank one
//   goes when the focus leaves or the panel shuts.
// SEARCH: the launcher's search finds a note (/api/search) and opens it - full
//   screen on a phone; on the desktop the menu shuts and the panel opens on it.
// SHARE: text shared to Nayive asks Chat or Note (a link: Bookmarks too); Note
//   makes a note with it on the launcher, saved, and a reload makes no second one.
import { server, browser, ok, section, done, onDisk, sleep, seed } from "../browser-test/lib.mjs";
import { disk, type, click } from "../data-safety-test/lib.mjs";

const F = "data/notes/notes.json";

// The desktop: the notes panel opens from Office › Notes in the launcher menu (a frame).
const MENU_DOC = "document.querySelector( '#menu iframe' ).contentDocument";
const inMenu = id => `${MENU_DOC}.getElementById( '${id}' )`;
async function deskNotes( c )
{
    await c.evaluate( "document.getElementById( 'menu' ).hidden && document.getElementById( 'menuBtn' ).click(); true" );
    await c.until( `( () => { try { return !! ${inMenu( 'notesBtn' )} && ${MENU_DOC}.readyState === 'complete'; } catch( e ) { return false; } } )()` );
    await c.evaluate( `( doc => { doc.getElementById( 'officeBtn' ).click(); doc.getElementById( 'notesBtn' ).click(); return true; } )( ${MENU_DOC} )` );
}
const s = await server();
const phone = await s.client();
const json = () => { try { return JSON.parse( onDisk( s, F ) ); } catch { return null; } };
const has = ( pred ) => disk( () => { const l = json(); return l && pred( l ); } );

//------------------------------------------------------------------------//
section( "PHONE · THE FIRST NOTE" );
const c = await browser( s, { width: 390, height: 844 } );
await c.open( "/nayive/" );
ok( await c.until( "document.querySelector( '.notes-wall' ) && document.querySelector( '.notes-wall' ).hidden && document.getElementById( 'notesNewBtn' )" ), "no notes: no notes area" );
ok( await c.evaluate( "! document.querySelector( '#lsBox #notesNewBtn, #lsBox .icon[data-icon^=\"sticky\"]' )" ), "no notes button in the top row" );
ok( onDisk( s, F ) === null, "no notes.json before the first note" );
await c.evaluate( "NayiveNotes.ready.then( () => true )" );   // + and Office › Notes wait for the first read

// Office › Notes with no notes yet: a new one (the same as +).
const officeNotes = async b => { await b.evaluate( "document.getElementById( 'officeBtn' ).click(); true" );
    await b.until( "document.getElementById( 'officeMenu' ).matches( ':popover-open' )" );
    await click( b, "#notesBtn" ); };
await officeNotes( c );
ok( await c.until( "document.querySelector( 'dialog.notes-full' ) && document.querySelector( 'dialog.notes-full' ).open && ! document.getElementById( 'officeMenu' ).matches( ':popover-open' )" ),
    "Office › Notes, no notes yet: a new note opens, the Office card shuts" );
await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );

// A blank note is never saved.
await officeNotes( c );
ok( await c.until( "document.querySelector( 'dialog.notes-full' ).open && document.activeElement.classList.contains( 'note-text' )" ), "Office › Notes opens the full view, the text field focused" );
await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
await sleep( 1200 );
ok( onDisk( s, F ) === null && await c.evaluate( "document.querySelectorAll( '.note.card' ).length === 0" ), "a note left blank is not saved and not shown" );

await officeNotes( c );
await c.until( "document.activeElement.classList.contains( 'note-text' )" );
await type( c, "Call the plumber" );
ok( await has( l => l.length === 1 && l[ 0 ].text === "Call the plumber" && ! l[ 0 ].list ), "the text is saved while typed (fresh home: notes.json made)" );
await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
ok( await c.until( "[ ...document.querySelectorAll( '.note.card' ) ].some( x => x.textContent.includes( 'Call the plumber' ) )" ), "back: its card shows" );

// Office › Notes with notes: to the cards, nothing new made.
await c.evaluate( "scrollTo( 0, 0 ); true" );
await officeNotes( c );
await sleep( 300 );
ok( await c.evaluate( "( r => r.top >= -1 && r.top < innerHeight )( document.querySelector( '.notes-wall' ).getBoundingClientRect() ) && ! document.querySelector( 'dialog.notes-full' ).open && document.querySelectorAll( '.note.card' ).length === 1" ),
    "Office › Notes with a note: the cards in view, no new note" );
// with notes, the cards' own + (in their head) makes another
await click( c, "#notesNewBtn" );
ok( await c.until( "document.querySelector( 'dialog.notes-full' ).open && document.activeElement.classList.contains( 'note-text' )" ), "with notes: the cards' + opens a new one" );
await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
await sleep( 1200 );

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
section( "PHONE · SEARCH FINDS A NOTE" );
{
    await c.evaluate( "( i => { i.value = 'plumber'; i.dispatchEvent( new Event( 'input', { bubbles: true } ) ); return true; } )( document.getElementById( 'lsInput' ) )" );
    ok( await c.until( "[ ...document.querySelectorAll( '#lsQuick .ls-group[data-kind=notes] .ls-row[data-note]' ) ].some( r => r.textContent.includes( 'Call the plumber today' ) )" ),
        "typed in the launcher's search: a Notes group with the note" );
    await c.evaluate( "document.querySelector( '#lsQuick .ls-row[data-note]' ).click(); true" );
    ok( await c.until( "document.querySelector( 'dialog.notes-full' ).open && document.querySelector( 'dialog.notes-full .note-text' ).value === 'Call the plumber today'" ),
        "picked: the note opens full screen" );
    ok( await c.evaluate( "/^\\/nayive\\/(index\\.html)?$/.test( location.pathname ) && ! location.hash" ), "and the launcher stays put", await c.evaluate( "location.href" ) );
    await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); document.getElementById( 'lsInput' ).value = ''; true" );
}

//------------------------------------------------------------------------//
section( "PHONE · SHARE TEXT TO A NOTE" );
{
    await c.open( "/nayive/share-target/?" + new URLSearchParams( { text: "Buy bread\nand milk", title: "" } ), "/nayive/share-target/" );
    ok( await c.until( "! document.getElementById( 'linkActions' ).hidden && ! document.getElementById( 'toNote' ).hidden && document.getElementById( 'toBookmarks' ).hidden" ),
        "text alone: Chat or Note, no Bookmarks" );
    await c.evaluate( "document.getElementById( 'toNote' ).click(); true" );
    ok( await has( l => l.filter( x => x.text === "Buy bread\nand milk" ).length === 1 ), "Note: a note with the text, saved", json() );
    ok( await c.until( "/^\\/nayive\\/(index\\.html)?$/.test( location.pathname ) && ! location.search && document.querySelector( 'dialog.notes-full' ).open && document.querySelector( 'dialog.notes-full .note-text' ).value === 'Buy bread\\nand milk'" ),
        "the launcher shows it open, ?note= gone from the address", await c.evaluate( "location.href" ) );
    await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
    await c.evaluate( "location.reload(); true" );
    await sleep( 2500 );
    ok( json().filter( x => x.text === "Buy bread\nand milk" ).length === 1, "a reload makes no second one" );

    await c.open( "/nayive/share-target/?" + new URLSearchParams( { link: "https://example.org/a", title: "Example", text: "https://example.org/a" } ), "/nayive/share-target/" );
    ok( await c.until( "! document.getElementById( 'toBookmarks' ).hidden && ! document.getElementById( 'toNote' ).hidden" ), "a link: Bookmarks, Chat or Note" );
    await c.evaluate( "document.getElementById( 'toNote' ).click(); true" );
    ok( await has( l => l.some( x => x.text === "Example\nhttps://example.org/a" ) ), "Note: the page's title, then the link" );
    await c.until( "document.querySelector( 'dialog.notes-full' ) && document.querySelector( 'dialog.notes-full' ).open" );
    await c.evaluate( "document.querySelector( 'dialog.notes-full [data-close]' ).click(); true" );
}

//------------------------------------------------------------------------//
section( "PHONE · A DAMAGED FILE" );
{
    const c2 = await browser( s, { width: 390, height: 844 } );
    const good = onDisk( s, F );
    await phone.put( F, "{ not json" );
    await c2.open( "/nayive/" );
    ok( await c2.until( "[ ...document.querySelectorAll( '#ayni-toasts .toast' ) ].some( t => /damaged/.test( t.textContent ) )" ), "it says the file is damaged" );
    await c2.evaluate( "document.getElementById( 'notesNewBtn' ).click(); true" );   // Office › Notes does the same with no notes shown
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
    ok( await c3.evaluate( "! document.querySelector( '.note.card' )" ), "it does not say \"no notes\"" );
    await c3.evaluate( "document.getElementById( 'notesNewBtn' ).click(); true" );
    await sleep( 2000 );
    ok( onDisk( s, F ) === before && await c3.evaluate( "! ( document.querySelector( 'dialog.notes-full' ) || {} ).open" ), "+ is refused, the file is untouched" );
    ws.close();
    c3.stop();
}

//------------------------------------------------------------------------//
section( "DESKTOP · THE NOTES PANEL" );
const d = await browser( s, { mouse: true } );
await d.open( "/nayive/desktop/" );
const onDiskNow = json();
const nPinned = onDiskNow.filter( x => x.pinned ).length, nFree = onDiskNow.length - nPinned;
ok( nPinned > 0 && nFree > 0, "the phone left pinned and unpinned notes", JSON.stringify( [ nPinned, nFree ] ) );
ok( await d.until( `document.querySelectorAll( '.notes-pane .note.sheet' ).length === ${nFree}` ), "the unpinned ones are in the panel", nFree );
ok( await d.evaluate( "document.querySelector( '.notes-pane' ).hidden" ), "the panel starts shut: nothing on the wallpaper" );
ok( await d.evaluate( `document.querySelectorAll( '.notes-layer .note.sticky' ).length === ${nPinned}` ), "the pinned ones float", nPinned );

await d.until( "window.AyniDesk && AyniDesk.open" );
await d.evaluate( "AyniDesk.open( '/nayive/calculator/index.html' ); true" );
await d.until( "document.querySelectorAll( '.win:not([hidden])' ).length === 1" );
const pane = "document.querySelector( '.notes-pane' )";
await deskNotes( d );
ok( await d.until( `! ${pane}.hidden && document.getElementById( 'menu' ).hidden` ), "Office › Notes opens it, the menu shuts" );
ok( await d.evaluate( "document.querySelectorAll( '.win:not([hidden])' ).length === 1" ), "the window stays" );
ok( await d.evaluate( `( () => { const p = ${pane}.getBoundingClientRect(), w = document.querySelector( '#desk' ).getBoundingClientRect();
    return p.width < w.width / 2 && Math.abs( p.right - w.right ) < 2; } )()` ), "a panel on the right" );
// a click in the window keeps it open
const wr = await d.evaluate( "( () => { const b = document.querySelector( '.win' ).getBoundingClientRect(); return { x: b.left + 40, y: b.top + 60 }; } )()" );
for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] )
    await d.send( "Input.dispatchMouseEvent", { type, x: wr.x, y: wr.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } );
await sleep( 300 );
ok( await d.evaluate( `! ${pane}.hidden` ), "a click in a window keeps it open" );

section( "DESKTOP · ← THE BOARD" );
await click( d, ".notes-phead .btn:first-child" );
ok( await d.until( `${pane}.classList.contains( 'board' )` ), "← spreads it as a board" );
ok( await d.evaluate( `( () => { const p = ${pane}.getBoundingClientRect(), w = document.querySelector( '#desk' ).getBoundingClientRect();
    return Math.abs( p.width - w.width ) < 2 && getComputedStyle( document.querySelector( '.notes-list' ) ).display === 'grid'; } )()` ), "over the whole desk, a grid" );
ok( await d.evaluate( `document.querySelectorAll( '.notes-list .note.sheet' ).length === ${nPinned + nFree} && document.querySelector( '.notes-list' ).firstElementChild.classList.contains( 'pinned' )
    && ! document.querySelector( '.notes-layer .note.sticky' ).offsetParent` ), "every note in it, pinned first; the floating ones hidden" );
{
    // search opens a pinned note while the board is up: its board card, not the floating one's size on it
    const pin = onDiskNow.find( x => x.pinned ).id;
    await d.evaluate( `NayiveNotes.show( ${JSON.stringify( pin )} ); true` );
    ok( await d.until( `document.activeElement && document.activeElement.closest( '.notes-list .note.sheet[data-id="${pin}"]' )` ), "a pinned note shown: its board card, focused" );
    ok( await d.evaluate( `! document.querySelector( '.notes-list .note.sheet[data-id="${pin}"]' ).style.width` ), "the card keeps the board's size" );
    await d.evaluate( "document.activeElement.blur(); true" );
}
await click( d, ".notes-phead .btn:first-child" );
ok( await d.until( `! ${pane}.classList.contains( 'board' ) && ! ${pane}.hidden` ), "→ back to the side" );
// a window coming forward: the board goes back to the side, or it would hide it
await click( d, ".notes-phead .btn:first-child" );
await d.until( `${pane}.classList.contains( 'board' )` );
await click( d, ".chip .chip-main" );
await d.until( "document.querySelector( '.win' ).hidden" );
ok( await d.evaluate( `${pane}.classList.contains( 'board' )` ), "a window minimised: the board stays" );
await click( d, ".chip .chip-main" );
ok( await d.until( `! document.querySelector( '.win' ).hidden && ! ${pane}.classList.contains( 'board' ) && ! ${pane}.hidden` ), "brought back from the bar: the board goes to the side" );
await click( d, ".notes-phead .btn:first-child" );
await d.until( `${pane}.classList.contains( 'board' )` );
await d.evaluate( "AyniDesk.open( '/nayive/split/index.html' ); true" );
ok( await d.until( `document.querySelectorAll( '.win:not([hidden])' ).length === 2 && ! ${pane}.classList.contains( 'board' )` ), "a new window: the board goes to the side" );
await d.evaluate( "document.querySelector( '.chip[aria-current=true] [data-win=close]' ).click(); true" );
await d.until( "document.querySelectorAll( '.win' ).length === 1" );
await click( d, ".notes-phead .btn:last-child" );
ok( await d.until( `${pane}.hidden` ), "× shuts it" );
await deskNotes( d );
await d.until( `! ${pane}.hidden` );
await click( d, ".notes-phead .btn:first-child" );
await d.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } );
await d.send( "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } );
ok( await d.until( `${pane}.hidden` ), "Esc shuts it" );
await deskNotes( d );
ok( await d.until( `! ${pane}.hidden && ! ${pane}.classList.contains( 'board' )` ), "opened again: at the side" );
await click( d, ".notes-phead .btn:last-child" );
await d.until( `${pane}.hidden` );

section( "DESKTOP · OFFICE › NOTES" );
{
    await d.evaluate( "document.getElementById( 'menu' ).hidden && document.getElementById( 'menuBtn' ).click(); true" );
    await d.until( `${MENU_DOC}.getElementById( 'notesBtn' )` );
    await d.evaluate( `( doc => { doc.getElementById( 'officeBtn' ).click(); doc.getElementById( 'notesBtn' ).click(); return true; } )( ${MENU_DOC} )` );
    ok( await d.until( `! ${pane}.hidden && document.getElementById( 'menu' ).hidden` ), "the panel opens, the menu shuts" );
    ok( await d.evaluate( "document.querySelectorAll( '.win:not([hidden])' ).length === 1" ), "the window stays" );
    await click( d, ".notes-phead .btn:last-child" );
    await d.until( `${pane}.hidden` );
}

section( "DESKTOP · + A NEW NOTE" );
// the panel's own +; the menu has no "new note" of its own (2026-11-14)
ok( await d.evaluate( `! ${inMenu( "notesPaneBtn" )} && ! ${inMenu( "notesNewBtn" )} && ! ${MENU_DOC}.querySelector( '#lsBox [data-icon^="sticky"]' )` ), "no notes button in the menu's top row" );
const newNote = async () =>
{
    if( await d.evaluate( `${pane}.hidden` ) ) { await deskNotes( d ); await d.until( `! ${pane}.hidden` ); }
    await click( d, ".notes-phead .btn:nth-child(3)" );
};
await newNote();
ok( await d.until( "document.activeElement && document.activeElement.classList.contains( 'note-text' ) && document.activeElement.closest( '.notes-pane .note.sheet' ) === document.querySelector( '.notes-list' ).firstElementChild" ),
    "a new note first in it, its text focused" );
await type( d, "Desk note" );
ok( await has( l => l.some( x => x.text === "Desk note" ) ), "saved" );
ok( ! /"x"|"left"/.test( onDisk( s, F ) ), "no place in the shared file" );

section( "DESKTOP · SEARCH FINDS A NOTE" );
{
    await d.evaluate( "document.activeElement.blur(); true" );
    await click( d, ".notes-phead .btn:last-child" );
    await d.until( `${pane}.hidden` );
    await d.evaluate( "document.getElementById( 'menu' ).hidden && document.getElementById( 'menuBtn' ).click(); true" );
    await d.until( `${MENU_DOC}.getElementById( 'lsInput' ) && document.querySelector( '#menu iframe' ).contentWindow.NayiveSearch` );
    await d.evaluate( `( i => { i.focus(); i.value = 'desk note'; i.dispatchEvent( new ( i.ownerDocument.defaultView.Event )( 'input', { bubbles: true } ) ); return true; } )( ${inMenu( "lsInput" )} )` );
    ok( await d.until( `!! ${MENU_DOC}.querySelector( '#lsQuick .ls-row[data-note]' )` ), "the menu's search lists the note" );
    await d.evaluate( `${MENU_DOC}.querySelector( '#lsQuick .ls-row[data-note]' ).click(); true` );
    ok( await d.until( `document.getElementById( 'menu' ).hidden && ! ${pane}.hidden` ), "picked: the menu shuts, the panel opens" );
    ok( await d.until( "document.activeElement && document.activeElement.classList.contains( 'note-text' ) && document.activeElement.value === 'Desk note' && document.activeElement.closest( '.note.sheet' )" ),
        "the note is focused in it" );
    ok( await d.evaluate( "! [ ...document.querySelectorAll( '.win iframe' ) ].some( f => /\\/nayive\\/(index\\.html)?(#|$)/.test( f.src ) ) && document.querySelectorAll( '.win:not([hidden])' ).length === 1" ),
        "no launcher window, the window stays" );
}

section( "DESKTOP · A PINNED NOTE FLOATS OVER THE WINDOWS" );
const pid = await d.evaluate( "document.activeElement.closest( '.note.sheet' ).dataset.id" );
{
    await d.evaluate( `document.querySelectorAll( '.note.sheet[data-id="${pid}"] .note-tools .btn' )[ 1 ].click(); true` );
    ok( await has( l => l.find( x => x.id === pid ).pinned ), "pinned, saved" );
    ok( await d.until( `! document.querySelector( '.notes-pane .note[data-id="${pid}"]' ) && !! document.querySelector( '.notes-layer .note.sticky[data-id="${pid}"]' )` ),
        "it leaves the panel and floats" );
    await click( d, ".notes-phead .btn:last-child" );
    await d.until( `${pane}.hidden` );
    ok( await d.evaluate( `( () => { const n = document.querySelector( '.note.sticky[data-id="${pid}"]' ), b = n.getBoundingClientRect();
        return document.elementFromPoint( b.left + b.width / 2, b.top + 10 ).closest( '.note.sticky' ) === n; } )()` ),
        "with the panel shut it still sits above the window and takes the clicks there" );
}

section( "DESKTOP · MOVE A PINNED NOTE" );
{
    const posKey = "nayive-notes-pos:" + await d.evaluate( "AyniStore.me || ''" );
    const p0 = await d.evaluate( `JSON.parse( localStorage.getItem( ${JSON.stringify( posKey )} ) )[ ${JSON.stringify( pid )} ]` );
    const r = await d.evaluate( `( () => { const b = document.querySelector( '.note.sticky[data-id="${pid}"] .note-strip' ).getBoundingClientRect(); return { x: b.left + 3, y: b.top + b.height / 2 }; } )()` );
    await d.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y, button: "left", buttons: 0 } );
    await d.send( "Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", buttons: 1, clickCount: 1 } );
    for( let i = 1; i <= 5; i++ ) await d.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + i * 20, y: r.y + i * 16, button: "left", buttons: 1 } );
    await d.send( "Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 100, y: r.y + 80, button: "left", buttons: 0, clickCount: 1 } );
    const p1 = await d.evaluate( `JSON.parse( localStorage.getItem( ${JSON.stringify( posKey )} ) )[ ${JSON.stringify( pid )} ]` );
    ok( p1 && p1.x === p0.x + 100 && p1.y === p0.y + 80, "dragged by its top strip: this device keeps the place", JSON.stringify( [ p0, p1 ] ) );
    await d.evaluate( `document.querySelectorAll( '.note.sticky[data-id="${pid}"] .note-tools .btn' )[ 1 ].click(); true` );
    ok( await d.until( `! document.querySelector( '.note.sticky[data-id="${pid}"]' ) && !! document.querySelector( '.notes-list .note.sheet[data-id="${pid}"]' )` ),
        "unpinned: back in the panel" );
    ok( await has( l => ! l.find( x => x.id === pid ).pinned ), "saved" );
}

section( "DESKTOP · A BLANK ONE" );
const count = json().length;
await newNote();
await d.until( "document.activeElement && document.activeElement.classList.contains( 'note-text' ) && document.activeElement.closest( '.note.sheet' )" );
const n1 = await d.evaluate( "document.querySelectorAll( '.note.sheet' ).length" );
await d.evaluate( "document.activeElement.blur(); true" );
ok( await d.until( `document.querySelectorAll( '.note.sheet' ).length === ${n1 - 1}` ), "a blank note goes when the focus leaves" );
await sleep( 1200 );
ok( json().length === count, "and was never saved" );
await newNote();
await d.until( "document.activeElement && document.activeElement.closest( '.note.sheet' )" );
await click( d, ".notes-phead .btn:last-child" );
ok( await d.until( `${pane}.hidden && document.querySelectorAll( '.note.sheet' ).length === ${n1 - 1}` ), "nor when the panel shuts on it" );
await sleep( 1200 );
ok( json().length === count, "never saved" );

section( "DESKTOP · THE MENU'S LAUNCHER HAS NO NOTES" );
ok( await d.until( "document.querySelector( '#menu iframe' ) && document.querySelector( '#menu iframe' ).contentDocument.readyState === 'complete' && document.querySelector( '#menu iframe' ).contentDocument.querySelector( '.grid' )" ), "the menu loaded" );
await sleep( 800 );
ok( await d.evaluate( "! document.querySelector( '#menu iframe' ).contentDocument.querySelector( '.notes-wall' )" ), "no notes section in it" );

d.stop();
c.stop();
await done();
