// ds-image.mjs - Image, the photo editor, never leaves a picture nowhere.
// C4 part (office #12): the first ✓ of a session keeps the original (in the
// bin, with an Undo) instead of re-encoding it in place with no way back.
// D12 (office #13): "Save a copy" onto an existing name puts that file back
// when the copy is not written.
import { server, browser, ok, section, done } from "./lib.mjs";
import { put, png, bytesOnDisk, PW } from "./office-lib.mjs";

const s = await server();
const RED = png( 200, 0, 0 ), BLUE = png( 0, 0, 200 ), GREEN = png( 0, 160, 0 );
put( s, "files/q.png", RED );
put( s, "files/p.png", GREEN );
put( s, "files/p-copy.png", BLUE );
const c = await browser( s, { width: 1280, height: 900 } );
const phone = await s.client();
const binList = async () => JSON.parse( ( await phone.call( "GET", "/api/files?trash=list" ) ).text ).items || [];

async function imagePage( rel )
{
    await c.open( "/nayive/image/?file=" + rel, "/nayive/image/" );
    await c.evaluate( PW + "( window )" );
    return c.until( "document.querySelector('.tie-btn-flip') && ! document.getElementById('editorSaveBtn').disabled", 30000 );
}

async function untilBytes( rel, want, ms = 10000 )
{
    const end = Date.now() + ms;
    let b = null;
    while( Date.now() < end ) { b = bytesOnDisk( s, rel ); if( b && want( b ) ) return b; await new Promise( r => setTimeout( r, 150 ) ); }
    return b;
}

//----------------------------------------------------------------------------//
section( "C4 · THE FIRST ✓ KEEPS THE ORIGINAL" );

ok( await imagePage( "files/q.png" ), "q.png is open in the editor" );
// An edit: Flip X, from the editor's own menu.
await c.evaluate( "document.querySelector('.tie-btn-flip').click(), true" );
await c.until( "document.querySelector('.tie-flip-button .tui-image-editor-button.flipX')" );
await c.evaluate( "document.querySelector('.tie-flip-button .tui-image-editor-button.flipX').click(), true" );
await c.evaluate( "document.getElementById('editorSaveBtn').click(), true" );

const q = await untilBytes( "files/q.png", b => ! b.equals( RED ) );
ok( q && ! q.equals( RED ), "✓ wrote the edited picture" );
let bin = await binList();
ok( bin.some( it => it.orig === "files/q.png" ), "the original went to the bin first", bin );
ok( await c.until( "document.querySelector('#toast .toast-undo')", 3000 ), "and the toast offers an Undo" );
await c.evaluate( "( document.querySelector('#toast .toast-undo') || { click: function () {} } ).click(), true" );
const back = await untilBytes( "files/q.png", b => b.equals( RED ) );
ok( back && back.equals( RED ), "Undo: the original is back, byte for byte" );

//----------------------------------------------------------------------------//
section( "D12 · \"SAVE A COPY\" ONTO A NAME THAT EXISTS, AND THE WRITE FAILS" );

ok( await imagePage( "files/p.png" ), "p.png is open in the editor" );
// The copy's write fails (a dropped line, a full disk...). GumApi PUTs a
// file with XMLHttpRequest (upload progress).
await c.evaluate( `( function () {
    var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function ( m, u ) { this.__fail = m === 'PUT' && String( u ).indexOf( 'p-copy.png' ) !== -1; return open.apply( this, arguments ); };
    XMLHttpRequest.prototype.send = function () {
        if( ! this.__fail ) return send.apply( this, arguments );
        var x = this; setTimeout( function () { if( x.onerror ) x.onerror(); }, 10 );
    };
    return true; } )()` );
await c.evaluate( "document.getElementById('editorSaveAsBtn').click(), true" );
ok( await c.until( "document.getElementById('saveCopyBackdrop').classList.contains('open')" ), "the copy's name is asked" );
await c.evaluate( "document.getElementById('saveCopyName').value = 'p-copy.png', document.getElementById('saveCopyConfirmBtn').click(), true" );
ok( await c.until( "window.__sheet().indexOf( NayiveUI.t('drive.nameExistsTitle') ) !== -1" ), "it asks before replacing p-copy.png" );
await c.evaluate( "window.__pressConfirm()" );

ok( await c.until( "( window.__toasts || [] ).some( function ( t ) { return t.indexOf( 'p-copy.png' ) !== -1; } )", 15000 ),
    "the user is told what happened", await c.toasts() );
const pc = bytesOnDisk( s, "files/p-copy.png" );
ok( pc && pc.equals( BLUE ), "p-copy.png is back as it was", pc ? pc.length : null );
bin = await binList();
ok( ! bin.some( it => it.orig === "files/p-copy.png" ), "and not left in the bin", bin );

await done( c, s );
