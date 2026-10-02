// ds-image-version.mjs - Image's ✓ writes only over the version of the
// picture it opened (C4, office #12, If-Match half - batch C4b).
//
// The picture changed elsewhere after the editor opened it (another window,
// another device, Photos): ✓ writes nothing - not over it, and it does not
// send it to the bin - and offers "Save my version as a copy". The same for
// a later ✓ (the original already kept), which used to write over blind. A
// picture opened from the offline copy (X-Nayive-Copy) is never saved over.
import { server, browser, ok, section, done } from "./lib.mjs";
import { put, png, bytesOnDisk, PW } from "./office-lib.mjs";

const s = await server();
const RED = png( 200, 0, 0 ), BLUE = png( 0, 0, 200 ), GREEN = png( 0, 160, 0 ), GREY = png( 90, 90, 90 );
put( s, "files/q.png", RED );
put( s, "files/r.png", GREEN );
put( s, "files/o.png", GREY );
const c = await browser( s, { width: 1280, height: 900 } );
const phone = await s.client();
const binList = async () => JSON.parse( ( await phone.call( "GET", "/api/files?trash=list" ) ).text ).items || [];

// The offline copy: the service worker answers a file GET from its cache,
// marked, when the network fails. Stood in for here (the tests bypass the
// worker): GumApi's reads of o.png come back marked.
await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: `( () => { const f = window.fetch;
    window.fetch = async function ( u, o ) {
        if( String( u ).indexOf( 'file=' + encodeURIComponent( 'files/o.png' ) ) === -1 || ( o && o.method && o.method !== 'GET' ) ) return f.apply( this, arguments );
        const r = await f.apply( this, arguments );
        const h = new Headers( r.headers ); h.set( 'X-Nayive-Copy', 'offline' );
        return new Response( await r.arrayBuffer(), { status: r.status, headers: h } ); }; } )()` } );

async function imagePage( rel )
{
    await c.open( "/nayive/image/?file=" + rel, "/nayive/image/" );
    await c.evaluate( PW + "( window )" );
    return c.until( "document.querySelector('.tie-btn-flip') && ! document.getElementById('editorSaveBtn').disabled", 30000 );
}
async function flip()
{
    await c.evaluate( "document.querySelector('.tie-btn-flip').click(), true" );
    await c.until( "document.querySelector('.tie-flip-button .tui-image-editor-button.flipX')" );
    await c.evaluate( "document.querySelector('.tie-flip-button .tui-image-editor-button.flipX').click(), true" );
}
const check = () => c.evaluate( "document.getElementById('editorSaveBtn').click(), true" );
const CONFLICT = "window.__sheet().indexOf( NayiveUI.t('ui.conflictTitle') ) !== -1";
// Once the ✓ is over (saving or not), the editor's buttons are on again.
const settled = () => c.until( "! document.getElementById('editorSaveBtn').disabled" );
async function untilBytes( rel, want, ms = 10000 )
{
    const end = Date.now() + ms;
    let b = null;
    while( Date.now() < end ) { b = bytesOnDisk( s, rel ); if( b && want( b ) ) return b; await new Promise( r => setTimeout( r, 150 ) ); }
    return b;
}

//----------------------------------------------------------------------------//
section( "C4 · THE FIRST ✓, OVER A PICTURE CHANGED ELSEWHERE SINCE IT OPENED" );
{
    ok( await imagePage( "files/q.png" ), "q.png is open in the editor" );
    ok( ( await phone.put( "files/q.png", BLUE ) ).status === 200, "another device saves its own q.png" );
    await flip();
    await check();
    ok( await c.until( CONFLICT, 15000 ), "✓ says the picture changed elsewhere", await c.evaluate( "window.__sheet()" ) );
    await settled();
    const q = bytesOnDisk( s, "files/q.png" );
    ok( q && q.equals( BLUE ), "the other device's picture is untouched" );
    ok( ! ( await binList() ).some( it => it.orig === "files/q.png" ), "...and did not go to the bin" );

    // "Save my version as a copy": the copy's name is asked, and it goes up beside it.
    await c.evaluate( "window.__pressConfirm()" );
    ok( await c.until( "document.getElementById('saveCopyBackdrop').classList.contains('open')" ), "it offers to save this edit as a copy" );
    await c.evaluate( "document.getElementById('saveCopyName').value = 'q-mine.png', document.getElementById('saveCopyConfirmBtn').click(), true" );
    const mine = await untilBytes( "files/q-mine.png", b => b.length > 0 );
    ok( mine && ! mine.equals( BLUE ) && ! mine.equals( RED ), "the edit is saved as q-mine.png" );
    ok( bytesOnDisk( s, "files/q.png" ).equals( BLUE ), "q.png is still the other device's" );
}

//----------------------------------------------------------------------------//
section( "C4 · A LATER ✓ (THE ORIGINAL ALREADY KEPT), OVER A PICTURE CHANGED SINCE" );
{
    ok( await imagePage( "files/r.png" ), "r.png is open in the editor" );
    await flip();
    await check();
    const first = await untilBytes( "files/r.png", b => ! b.equals( GREEN ) );
    ok( first && ! first.equals( GREEN ), "the first ✓ saved the edit" );
    await settled();
    ok( ( await phone.put( "files/r.png", BLUE ) ).status === 200, "then another device saves its own r.png" );
    await flip();
    await check();
    ok( await c.until( CONFLICT, 15000 ), "the next ✓ says the picture changed elsewhere", await c.evaluate( "window.__sheet()" ) );
    await settled();
    const r = bytesOnDisk( s, "files/r.png" );
    ok( r && r.equals( BLUE ), "the other device's picture is not written over" );
    await c.evaluate( "window.__pressCancel ? window.__pressCancel() : document.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Escape', bubbles: true } ) ), true" );
}

//----------------------------------------------------------------------------//
section( "C4 · OPENED FROM THE OFFLINE COPY: ✓ NEVER WRITES OVER IT" );
{
    ok( await imagePage( "files/o.png" ), "o.png is open in the editor (from the offline copy)" );
    await c.evaluate( "window.__toasts = []; true" );
    await flip();
    await check();
    ok( await c.until( "( window.__toasts || [] ).some( t => t.indexOf( NayiveUI.t( 'image.offlineCopy' ) ) !== -1 )", 15000 ), "✓ says why it does not save", await c.toasts() );
    await settled();
    const o = bytesOnDisk( s, "files/o.png" );
    ok( o && o.equals( GREY ), "o.png is untouched" );
    ok( ! ( await binList() ).some( it => it.orig === "files/o.png" ), "...and not in the bin" );
}

await done( c, s );
