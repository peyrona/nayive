// ds-office-drafts.mjs - an unnamed document is never thrown away by Open
// (E2, office #6), and keys typed while another document is opening are
// saved, not dropped (E4, office #11). Text, in a plain tab.
import { server, browser, ok, section, done } from "./lib.mjs";
import { put, untilDisk, untilDraft, DRAFTS } from "./office-lib.mjs";

const s = await server();
put( s, "files/a.txt", "base\n" );
put( s, "files/slow.txt", "slow\n" );
const c = await browser( s );

const CM    = "document.querySelector('.CodeMirror').CodeMirror";
const value = async () => c.evaluate( `${CM}.getValue()` );
const type  = async text => c.evaluate( `${CM}.replaceRange( ${JSON.stringify( text )}, { line: 0, ch: 0 } ), true` );
const drafts = () => c.evaluate( DRAFTS );
const withBody = ( list, text ) => list.filter( d => String( d.body ).indexOf( text ) !== -1 );

// The Open sheet, the way a person uses it: the file's row in the list.
async function openFile( name )
{
    await c.evaluate( "document.getElementById('openBtn').click(), true" );
    const there = await c.until( `Array.prototype.some.call( document.querySelectorAll('#openList li'), function ( li ) { return li.textContent === ${JSON.stringify( name )}; } )` );
    await c.evaluate( `( Array.prototype.find.call( document.querySelectorAll('#openList li'), function ( li ) { return li.textContent === ${JSON.stringify( name )}; } ) || { click: function () {} } ).click(), true` );
    return there;
}

// A new note: typed, its name sheet (1.5 s later) closed with ✗, its device
// draft written (the app's own 7 s timer).
async function note( text )
{
    await type( text );
    await c.until( "document.getElementById('saveAsBackdrop').classList.contains('open')" );
    await c.evaluate( "NayiveUI.close('saveAsBackdrop'), true" );
    return untilDraft( c, text );
}

//----------------------------------------------------------------------------//
section( "E2 · OPEN OVER AN UNNAMED NOTE, THEN ANOTHER NOTE" );

await c.open( "/nayive/text/?new=1", "/nayive/text/" );
ok( await c.until( "document.querySelector('.CodeMirror') && document.getElementById('fileLabel').textContent" ), "Text is up with a blank document" );
ok( await note( "nota uno\n" ), "the unnamed note is in its device draft" );

ok( await openFile( "a.txt" ), "the Open sheet lists a.txt" );
ok( await c.until( `${CM}.getValue() === 'base\\n'` ), "a.txt is on screen" );

// New swaps in place here (no mouse: one screen), and the next unnamed
// note used to take the same draft slot - the first note was gone.
await c.evaluate( "document.getElementById('newBtn').click(), true" );
ok( await c.until( `${CM}.getValue() === ''` ), "New: a blank document" );
ok( await note( "nota dos\n" ), "the second note is in a device draft" );

const list = await drafts();
ok( withBody( list, "nota uno" ).length === 1, "the FIRST note is still in a device draft (once)", list );
ok( withBody( list, "nota dos" ).length === 1, "and the second one beside it", list );

//----------------------------------------------------------------------------//
section( "E2 · ITS UNDO" );

await c.open( "/nayive/text/?new=1", "/nayive/text/" );
ok( await c.until( "document.querySelector('.CodeMirror') && document.getElementById('fileLabel').textContent" ), "a blank document again" );
ok( await note( "nota tres\n" ), "a third note, in its device draft" );
ok( await openFile( "a.txt" ), "Open a.txt over it" );
ok( await c.until( `${CM}.getValue() === 'base\\n'` ), "a.txt is on screen" );
ok( await c.until( "document.querySelector('#toast .toast-undo')", 3000 ), "an Undo is offered for the note it replaced" );
await c.evaluate( "( document.querySelector('#toast .toast-undo') || { click: function () {} } ).click(), true" );
ok( await c.until( `${CM}.getValue() === 'nota tres\\n'` ), "Undo brings the note back over the opened file" );
// Its draft is written again at once (a flush, no timer). A second copy
// would be there within this moment; an absence can only be checked so.
await new Promise( r => setTimeout( r, 1500 ) );
ok( withBody( await drafts(), "nota tres" ).length === 1, "and its draft is not copied a second time", await drafts() );

//----------------------------------------------------------------------------//
section( "E4 · KEYS TYPED WHILE ANOTHER DOCUMENT OPENS" );

await c.open( "/nayive/text/?file=files/a.txt", "/nayive/text/" );
ok( await c.until( `document.querySelector('.CodeMirror') && ${CM}.getValue() === 'base\\n'` ), "a.txt open" );

// slow.txt takes 2.5 s to come down (a phone on a bad line).
await c.evaluate( `( function () {
    var f = window.fetch; window.__slow = false;
    window.fetch = function ( u, o ) {
        var url = String( u && u.url || u );
        if( url.indexOf( 'files%2Fslow.txt' ) !== -1 && ( ! o || ! o.method || o.method === 'GET' ) ) {
            window.__slow = true;
            return new Promise( function ( r ) { setTimeout( r, 2500 ); } ).then( function () { return f( u, o ); } );
        }
        return f( u, o );
    };
    return true; } )()` );

ok( await openFile( "slow.txt" ), "Open slow.txt" );
ok( await c.until( "window.__slow" ), "its download is under way" );
await type( "TYPED while it opened\n" );
ok( await c.until( `${CM}.getValue() === 'slow\\n'` ), "slow.txt is on screen" );
const got = await untilDisk( s, "files/a.txt", t => /TYPED/.test( t || "" ) );
ok( got === "TYPED while it opened\nbase\n", "the keys typed meanwhile are saved in a.txt", got );

await done( c, s );
