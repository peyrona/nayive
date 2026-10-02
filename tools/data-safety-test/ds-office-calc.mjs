// ds-office-calc.mjs - Calc and what it cannot write back (pivots, print
// setup, sheet protection... codec.js detectLossy).
// E3 (office #10): after "Do not save" on the loss gate, later edits still
// get the device draft, and closing the window asks.
// G2 (office #7): "Restore the previous copy" swaps the two FILES byte for
// byte - it never re-encodes either side through Calc's model.
import { server, browser, ok, section, done, click } from "./lib.mjs";
import { put, xlsx, bytesOnDisk, untilDraft, PW } from "./office-lib.mjs";

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
const first = await browser( s );
let c = first;

const A1 = "( function () { var td = document.querySelector('#gridHost .ht_master tbody tr td'); return td ? td.textContent : null; } )()";

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

await done( first, s );
