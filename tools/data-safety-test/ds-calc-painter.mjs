// ds-calc-painter.mjs - Calc's format painter (format.js, FORMAT PAINTER):
// the look it copies reaches the FILE, survives closing and opening it again,
// lands on the picked cells only, and Ctrl+Z takes it back off.
import { server, browser, ok, section, done, click, sleep } from "./lib.mjs";
import { put, xlsx, bytesOnDisk, unzipText, PW } from "./office-lib.mjs";

const s = await server();
put( s, "files/paint.xlsx", xlsx( { a1: "SRC" } ) );
const before = bytesOnDisk( s, "files/paint.xlsx" );
const c = await browser( s, { mouse: true } );

const G    = "( await import('/nayive/calc/grid.js') )";
const look = a => c.evaluate( `( async () => { const g = ${G}; return JSON.stringify( g.activeSheet.cellStyles[ ${JSON.stringify( a )} ] || null ); } )()` );
const pick = ( r1, c1, r2, c2 ) => c.evaluate( `( async () => { const g = ${G}; g.table.selectCell( ${r1}, ${c1}, ${r2}, ${c2} ); return true; } )()` );

async function openSheet()
{
    await c.open( "/nayive/calc/?file=files/paint.xlsx", "/nayive/calc/" );
    await c.evaluate( PW + "( window )" );
    const up = await c.until( "document.getElementById('nameBox').value === 'A1' && document.querySelector('#gridHost .ht_master tbody tr td') && document.querySelector('#gridHost .ht_master tbody tr td').textContent === 'SRC'", 20000 );
    await c.evaluate( `( async () => { window.__g = ${G}; return true; } )()` );   // until() wants plain expressions, not promises
    return up;
}

try
{
    section( "FORMAT PAINTER" );

    ok( await openSheet(), "paint.xlsx is open" );
    // Values in the targets: an EMPTY cell keeps only a fill or a box when
    // the file is read (codec.js), whatever painted it.
    await c.evaluate( "window.__g.table.setDataAtCell( [ [ 2, 2, 'c3' ], [ 3, 3, 'd4' ] ] ), true" );
    await pick( 0, 0, 0, 0 );
    await click( c, "#fmtBoldBtn" );
    ok( await c.until( "!! ( window.__g.activeSheet.cellStyles.A1 || {} ).bold" ), "A1 is bold" );

    await click( c, "#fmtPainterBtn" );
    ok( await c.evaluate( "document.getElementById('fmtPainterBtn').classList.contains('active')" ), "the painter is on" );
    await pick( 2, 2, 3, 3 );                                      // C3:D4
    ok( JSON.parse( await look( "C3" ) )?.bold === true && JSON.parse( await look( "D4" ) )?.bold === true, "C3 and D4 took the look" );
    ok( await look( "B2" ) === "null" && await look( "E5" ) === "null", "nothing outside C3:D4 changed" );
    ok( await c.evaluate( "! document.getElementById('fmtPainterBtn').classList.contains('active')" ), "one use, then off" );

    // Ctrl+Z / Ctrl+Y: one step.
    await c.front();
    const key = async ( k, code, vk ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: 2 } ); };
    await key( "z", "KeyZ", 90 );
    ok( await c.until( "! window.__g.activeSheet.cellStyles.C3 && ! window.__g.activeSheet.cellStyles.D4 && !! window.__g.activeSheet.cellStyles.A1" ), "Ctrl+Z takes the paint off, A1 keeps its own" );
    await key( "y", "KeyY", 89 );
    ok( await c.until( "!! window.__g.activeSheet.cellStyles.C3" ), "Ctrl+Y puts it back" );

    // The autosave writes the file; the painted cells carry a style there.
    let saved = null;
    for( let i = 0; i < 100 && ! saved; i++ )
    {
        const now = bytesOnDisk( s, "files/paint.xlsx" );
        if( now && ! now.equals( before ) && /<c r="D4"[^>]*\bs="[1-9]/.test( unzipText( now, "xl/worksheets/sheet1.xml" ) || "" ) ) saved = now;
        else await sleep( 200 );
    }
    ok( !! saved, "the autosave wrote the painted cells to the file" );
    const sheet = saved ? unzipText( saved, "xl/worksheets/sheet1.xml" ) : "";
    ok( /<c r="C3"[^>]*\bs="[1-9]/.test( sheet ) && /<c r="D4"[^>]*\bs="[1-9]/.test( sheet ), "C3 and D4 carry a style in the file", sheet.slice( 0, 600 ) );

    // Opened again: the look is still there.
    ok( await openSheet(), "paint.xlsx opens again" );
    ok( JSON.parse( await look( "C3" ) )?.bold === true && JSON.parse( await look( "D4" ) )?.bold === true, "C3 and D4 are still bold after reopening", await look( "C3" ) );
    ok( await look( "E5" ) === "null", "E5 still plain after reopening" );
}
catch( e ) { console.log( e ); ok( false, "threw: " + e.message ); }
finally { await done( c, s ); }
