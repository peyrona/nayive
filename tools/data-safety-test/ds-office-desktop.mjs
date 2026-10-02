// ds-office-desktop.mjs - the desktop's windows and the office editors.
// E1 (office #2): closing a Write/Calc/Text window keeps what was typed
// (the server, or the device draft) before the window goes.
// A1 part (office #1): a document already open in a window is opened in
// THAT window, not in a second editor that would save over it.
import { server, browser, ok, section, done } from "./lib.mjs";
import { put, untilDisk, untilDraft } from "./office-lib.mjs";

const s = await server();
put( s, "files/b.txt", "keep\n" );
put( s, "files/c.txt", "see\n" );
const c = await browser( s, { width: 1600, height: 1000 } );

await c.evaluate( `localStorage.setItem( 'balata-desktop', JSON.stringify( { mode: 'always' } ) );
    localStorage.setItem( 'balata-intro-dismiss:text', '1' ); localStorage.setItem( 'balata-intro-dismiss:desktop', '1' ); true` );
await c.open( "/nayive/desktop/", "/nayive/desktop/" );
ok( await c.until( "window.NayiveDesktop && typeof NayiveDesktop.open === 'function'", 20000 ), "the desktop is up" );

const WINS  = "document.querySelectorAll('#desk > .win').length";
const LAST  = "( function () { var ws = document.querySelectorAll('#desk > .win'); return ws[ ws.length - 1 ]; } )()";
const FRAME = `${LAST}.querySelector('iframe').contentWindow`;
const CM    = `${FRAME}.document.querySelector('.CodeMirror').CodeMirror`;
const closeFront = "document.querySelector('#tasks .task.front [data-win=\"close\"]').click(), true";

// A Text window on `url`, its page up (the document on screen).
async function textWindow( url, want )
{
    const before = await c.evaluate( WINS );
    await c.evaluate( `NayiveDesktop.open( ${JSON.stringify( url )} ), true` );
    await c.until( `${WINS} === ${before + 1}` );
    return c.until( `( function () { try { var cm = ${CM}; return cm && ${want === null ? "true" : `cm.getValue() === ${JSON.stringify( want )}`}
                       && ${FRAME}.document.getElementById( 'fileLabel' ).textContent; } catch ( e ) { return false; } } )()`, 20000 );
}

//----------------------------------------------------------------------------//
section( "E1 · CLOSE A WINDOW RIGHT AFTER TYPING" );

ok( await textWindow( "/nayive/text/index.html?file=files/b.txt", "keep\n" ), "b.txt open in a Text window" );
await c.evaluate( `${CM}.replaceRange( 'EDIT typed just before closing\\n', { line: 0, ch: 0 } ), true` );
const n1 = await c.evaluate( WINS );
await c.evaluate( closeFront );                       // 7 s before the autosave would run
ok( await c.until( `${WINS} === ${n1 - 1}` ), "the window closes (nothing to ask)" );
const b = await untilDisk( s, "files/b.txt", t => /EDIT/.test( t || "" ), 3000 );
ok( b === "EDIT typed just before closing\nkeep\n", "what was typed is in the file", b );

ok( await textWindow( "/nayive/text/index.html?new=1", null ), "New: a blank Text window" );
await c.evaluate( `${CM}.replaceRange( 'my new note, never named\\n', { line: 0, ch: 0 } ), true` );
ok( await c.until( `${FRAME}.document.getElementById('saveAsBackdrop').classList.contains('open')` ), "its name sheet is up" );
const n2 = await c.evaluate( WINS );
await c.evaluate( closeFront );
ok( await c.until( `${WINS} === ${n2 - 1}` ), "the window closes" );
ok( await untilDraft( c, "my new note, never named", 3000 ), "the unnamed note is in a device draft" );

//----------------------------------------------------------------------------//
section( "A1 · THE SAME DOCUMENT TWICE" );

ok( await textWindow( "/nayive/text/index.html?file=files/b.txt", null ), "b.txt open again" );
const n3 = await c.evaluate( WINS );
// Drive opens a document with window.open on every double-click.
// (the desktop's window.open adds a window synchronously: counted right after)
await c.evaluate( `${FRAME}.open( '/nayive/text/index.html?file=files%2Fb.txt', '_blank' ), true` );
ok( await c.evaluate( WINS ) === n3, "a second open of b.txt shows its window, no second editor" );

// The window opens c.txt from its own Open sheet: it shows c.txt now.
await c.until( `${FRAME}.document.getElementById('openBtn')` );
await c.evaluate( `${FRAME}.document.getElementById('openBtn').click(), true` );
ok( await c.until( `Array.prototype.some.call( ${FRAME}.document.querySelectorAll('#openList li'), function ( li ) { return li.textContent === 'c.txt'; } )` ), "its Open sheet lists c.txt" );
await c.evaluate( `( Array.prototype.find.call( ${FRAME}.document.querySelectorAll('#openList li'), function ( li ) { return li.textContent === 'c.txt'; } ) || { click: function () {} } ).click(), true` );
ok( await c.until( `${CM}.getValue() === 'see\\n'` ), "the window shows c.txt" );

await c.evaluate( `${FRAME}.open( '/nayive/text/index.html?file=files%2Fc.txt', '_blank' ), true` );
ok( await c.evaluate( WINS ) === n3, "c.txt (what the window shows NOW) goes to that window" );

await c.evaluate( `${FRAME}.open( '/nayive/text/index.html?file=files%2Fb.txt', '_blank' ), true` );
ok( await c.until( `${WINS} === ${n3 + 1}` ), "b.txt (no longer shown anywhere) gets a window of its own" );

ok( /window/i.test( await c.evaluate( "NayiveUI.t('ui.conflictTitle')" ) ), "the 412 question says another window, too" );

await done( c, s );
