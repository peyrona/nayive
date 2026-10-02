// ds-office-calc.mjs - Calc and what it cannot write back (pivots, print
// setup, sheet protection... codec.js detectLossy).
// E3 (office #10): after "Do not save" on the loss gate, later edits still
// get the device draft, and closing the window asks.
// G2 (office #7): "Restore the previous copy" swaps the two FILES byte for
// byte - it never re-encodes either side through Calc's model; it refuses
// while edits the gate held back are on screen; its Undo never leaves the
// sheet as it was nowhere.
import { server, browser, ok, section, done, click } from "./lib.mjs";
import { put, xlsx, bytesOnDisk, untilDraft, unzipText, DRAFT_B64, PW } from "./office-lib.mjs";

const s = await server();
const LAND = xlsx( { a1: "NOW", landscape: true } );       // calc.lossyPage
const OLD  = xlsx( { a1: "OLD", protect: true } );         // calc.lossyProtection
const NOW2 = xlsx( { a1: "NOW2" } );                       // nothing Calc drops
const OLD2 = xlsx( { a1: "OLD2", protect: true } );
put( s, "files/land.xlsx", LAND );
put( s, "files/sheet.xlsx", LAND );
put( s, "files/.bak/sheet.xlsx", OLD );
put( s, "files/s2.xlsx", NOW2 );
put( s, "files/.bak/s2.xlsx", OLD2 );
const NOW3 = xlsx( { a1: "NOW3", landscape: true } ), OLD3 = xlsx( { a1: "OLD3" } );
put( s, "files/s3.xlsx", NOW3 );
put( s, "files/.bak/s3.xlsx", OLD3 );
const NOW4 = xlsx( { a1: "NOW4" } ), OLD4 = xlsx( { a1: "OLD4", protect: true } );
put( s, "files/s4.xlsx", NOW4 );
put( s, "files/.bak/s4.xlsx", OLD4 );
const first = await browser( s );
let c = first;

const A1 = "( function () { var td = document.querySelector('#gridHost .ht_master tbody tr td'); return td ? td.textContent : null; } )()";
const B2 = "( function () { var td = document.querySelector('#gridHost .ht_master tbody tr:nth-child(2) td:nth-of-type(2)'); return td ? td.textContent : null; } )()";
const TOLD = key => `( window.__toasts || [] ).some( function ( t ) { return t.indexOf( NayiveUI.t( '${key}' ) ) !== -1; } )`;

async function openSheet( rel, a1 )
{
    await c.open( "/nayive/calc/?file=" + rel, "/nayive/calc/" );
    await c.evaluate( PW + "( window )" );
    return c.until( `${A1} === ${JSON.stringify( a1 )} && document.getElementById('fileLabel').textContent`, 20000 );
}

// Types into the cell under B2 the way a person does (Handsontable reads the key codes).
async function typeInB2( text )
{
    await click( c, "#gridHost .ht_master tbody tr:nth-child(2) td:nth-of-type(2)" );
    for( const ch of text )
    {
        await c.send( "Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, code: "Digit" + ch, windowsVirtualKeyCode: ch.charCodeAt( 0 ) } );
        await c.send( "Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: "Digit" + ch, windowsVirtualKeyCode: ch.charCodeAt( 0 ) } );
    }
    await c.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } );
    await c.send( "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } );
}

//----------------------------------------------------------------------------//
section( "E3 · EDITS AFTER \"DO NOT SAVE\" ON THE LOSS GATE" );

ok( await openSheet( "files/land.xlsx", "NOW" ), "land.xlsx (landscape print setup) is open" );
await typeInB2( "77" );
ok( await c.until( "document.getElementById('lossyBackdrop').classList.contains('open')" ), "the edit opens the loss gate" );
await c.evaluate( "NayiveUI.close('lossyBackdrop'), true" );             // ✗ = do not write it now
ok( await untilDraft( c, d => d.name === "land.xlsx" ), "the held edits are in a device draft (the 7 s timer)" );
const b64 = await c.evaluate( DRAFT_B64( "land.xlsx" ) );
const draft = b64 ? Buffer.from( b64, "base64" ) : null;
const cells = draft ? ( unzipText( draft, "xl/worksheets/sheet1.xml" ) || "" ) + ( unzipText( draft, "xl/sharedStrings.xml" ) || "" ) : "";
ok( />77</.test( cells ), "and the draft holds the edit itself (77)", cells.slice( 0, 300 ) );
ok( bytesOnDisk( s, "files/land.xlsx" ).equals( LAND ), "the file itself is untouched" );

ok( await c.evaluate( "typeof window.nayiveBeforeClose === 'function'" ), "the page answers the desktop's close" );
await c.evaluate( "window.__closing = window.nayiveBeforeClose && window.nayiveBeforeClose(), true" );
ok( await c.until( "window.__sheet().indexOf( NayiveUI.t('drive.unsavedBody') ) !== -1" ), "and closing it asks first (held back, not in the file)" );

//----------------------------------------------------------------------------//
section( "G2 · RESTORE WHEN THE FILE HAS WHAT CALC CANNOT WRITE" );

// A tab of its own: the one above holds edits back, and its beforeunload
// question would stop any navigation away from it.
c = await first.tab();

ok( await openSheet( "files/sheet.xlsx", "NOW" ), "sheet.xlsx (landscape) is open; its .bak is protected" );
await c.evaluate( "document.getElementById('restoreBtn').click(), true" );
ok( await c.until( "window.__sheet().indexOf( NayiveUI.t('write.restore') ) !== -1" ), "Restore asks first (no Undo for it)" );
await c.evaluate( "window.__pressConfirm()" );
ok( await c.until( `${A1} === 'OLD'` ), "the previous copy is on screen" );
let file = null, bak = null;
for( let i = 0; i < 50; i++ )
{
    file = bytesOnDisk( s, "files/sheet.xlsx" ); bak = bytesOnDisk( s, "files/.bak/sheet.xlsx" );
    if( file && file.equals( OLD ) ) break;
    await new Promise( r => setTimeout( r, 200 ) );
}
ok( file && file.equals( OLD ), "the file is the old copy, byte for byte (its protection kept)" );
ok( bak && bak.equals( LAND ), "the .bak is the file as it was, byte for byte (its print setup kept)" );

ok( await openSheet( "files/s2.xlsx", "NOW2" ), "s2.xlsx (plain) is open; its .bak is protected" );
await c.evaluate( "document.getElementById('restoreBtn').click(), true" );
ok( await c.until( `${A1} === 'OLD2'` ), "Restore at once (undoable)" );
ok( await c.until( "document.querySelector('#toast .toast-undo')", 3000 ), "with an Undo" );
let f2 = null;
for( let i = 0; i < 50 && ! ( f2 && f2.equals( OLD2 ) ); i++ ) { await new Promise( r => setTimeout( r, 200 ) ); f2 = bytesOnDisk( s, "files/s2.xlsx" ); }
ok( f2 && f2.equals( OLD2 ), "the file is the old copy, byte for byte" );
await c.evaluate( "( document.querySelector('#toast .toast-undo') || { click: function () {} } ).click(), true" );
ok( await c.until( `${A1} === 'NOW2'` ), "Undo: the sheet as it was is back on screen" );
for( let i = 0; i < 50 && ! ( f2 && f2.equals( NOW2 ) ); i++ ) { await new Promise( r => setTimeout( r, 200 ) ); f2 = bytesOnDisk( s, "files/s2.xlsx" ); }
ok( f2 && f2.equals( NOW2 ), "and in the file, byte for byte" );
ok( bytesOnDisk( s, "files/.bak/s2.xlsx" ).equals( OLD2 ), "the .bak is the old copy again, byte for byte" );

//----------------------------------------------------------------------------//
section( "G2 · NO RESTORE OVER EDITS THE GATE HELD BACK" );

// A tab of its own again: this one ends with held edits too.
c = await first.tab();
ok( await openSheet( "files/s3.xlsx", "NOW3" ), "s3.xlsx (landscape) is open" );
await typeInB2( "77" );
ok( await c.until( "document.getElementById('lossyBackdrop').classList.contains('open')" ), "the edit opens the loss gate" );
await c.evaluate( "NayiveUI.close('lossyBackdrop'), true" );
ok( await c.until( `${B2} === '77'` ), "77 is on screen, not in the file" );
await c.evaluate( "document.getElementById('restoreBtn').click(), true" );
await c.until( `${TOLD( "write.restoreSaveFirst" )} || window.__sheet()`, 15000 );
// The old way asked first, then swapped: answered here, to show what it did.
if( await c.evaluate( "!! window.__sheet()" ) ) { await c.evaluate( "window.__pressConfirm()" ); await c.until( `${A1} === 'OLD3'`, 10000 ); }
ok( await c.evaluate( TOLD( "write.restoreSaveFirst" ) ), "Restore says: save a copy first", await c.toasts() );
ok( await c.evaluate( `${B2} === '77' && ${A1} === 'NOW3'` ), "the held edit stays on screen" );
ok( bytesOnDisk( s, "files/s3.xlsx" ).equals( NOW3 ) && bytesOnDisk( s, "files/.bak/s3.xlsx" ).equals( OLD3 ), "both files untouched" );

//----------------------------------------------------------------------------//
section( "G2 · ITS UNDO, WHEN THE FILE CANNOT BE WRITTEN" );

c = await first.tab();
ok( await openSheet( "files/s4.xlsx", "NOW4" ), "s4.xlsx (plain) is open; its .bak is protected" );
await c.evaluate( "document.getElementById('restoreBtn').click(), true" );
ok( await c.until( `${A1} === 'OLD4'` ), "Restore at once (undoable)" );
ok( await c.until( "document.querySelector('#toast .toast-undo')", 3000 ), "with an Undo" );
let f4 = null;
for( let i = 0; i < 50 && ! ( f4 && f4.equals( OLD4 ) ); i++ ) { await new Promise( r => setTimeout( r, 200 ) ); f4 = bytesOnDisk( s, "files/s4.xlsx" ); }
ok( f4 && f4.equals( OLD4 ) && bytesOnDisk( s, "files/.bak/s4.xlsx" ).equals( NOW4 ), "swapped: the file is the old copy, the .bak the sheet as it was" );
// From now on the server refuses the file itself (403: not this user's to write).
await c.evaluate( `( function () {
    var f = window.fetch;
    window.fetch = function ( u, o ) {
        if( o && o.method === 'PUT' && String( u && u.url || u ).indexOf( 'files%2Fs4.xlsx' ) !== -1 )
            return Promise.resolve( new Response( '{}', { status: 403, headers: { 'Content-Type': 'application/json' } } ) );
        return f( u, o );
    };
    return true; } )()` );
await c.evaluate( "( document.querySelector('#toast .toast-undo') || { click: function () {} } ).click(), true" );
ok( await c.until( TOLD( "write.actionFailed" ) ), "the Undo says it did not work" );
ok( bytesOnDisk( s, "files/.bak/s4.xlsx" ).equals( NOW4 ), "and the sheet as it was is still in the .bak (not nowhere)" );

await done( first, s );
