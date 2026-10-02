// ds-drive-bin.mjs - "Empty the bin" deletes for good what the user saw,
// nothing else (G4, drive-files #6).
//
// The bin view, the disk bar's offer and "not enough room -> empty the bin"
// (NayiveUI.ensureRoom) asked against a count read earlier, then emptied the
// WHOLE bin: an item another device deleted after that look (its Undo toast
// still up there) was purged too, gone for good.
import fs from "node:fs";
import { server, browser, ok, section, done, sleep } from "./lib.mjs";

const s = await server();
// A tiny quota (0.00001 GB = 10737 bytes), so the disk bar can be "nearly
// full" and an upload "does not fit" with a few small files.
fs.writeFileSync( s.home() + "/data/config.json", JSON.stringify( { password: "test", quota: 0.00001 } ) );

const phone = await s.client();
const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };
const bin  = async rel => { const r = await phone.del( "/api/files?paths=" + encodeURIComponent( rel ) ); if( r.status !== 200 ) throw new Error( "bin " + rel + ": " + r.status ); };
const inBin = async () => JSON.parse( ( await phone.call( "GET", "/api/files?trash=list" ) ).text ).items.map( it => it.orig || it.name );
const has  = ( list, name ) => list.some( p => String( p ).split( "/" ).pop() === name );
async function binUntil( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { const l = await inBin(); if( fn( l ) ) return l; await sleep( 100 ); }
    return await inBin();
}

const c = await browser( s );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:drive', '1' ); true" );
const READY = "typeof emptyTrash === 'function' && FS_ROOT === 'files' && currentFolder === 'files' && ! listingLoading";
const sheetUp = () => c.until( "document.querySelector( '.sheet-backdrop.open:not([id]) .sheet-actions button:last-child' )" );
const confirm = () => c.evaluate( "document.querySelector( '.sheet-backdrop.open:not([id]) .sheet-actions button:last-child' ).click(); true" );

//------------------------------------------------------------------------//
section( "THE BIN VIEW" );
{
    await seed( "files/e.txt", "e" );
    await bin( "files/e.txt" );
    ok( await c.open( "/nayive/drive/", "/nayive/drive/" ) && await c.until( READY, 20000 ), "Drive is open" );
    await c.evaluate( "openTrash(); true" );
    ok( await c.until( "trashMode && trashItems.length === 1" ), "the bin shows e.txt" );

    await seed( "files/f.txt", "f" );
    await bin( "files/f.txt" );                   // the phone, after the PC looked
    await c.evaluate( "emptyTrash(); true" );
    ok( await sheetUp(), "Empty asks (1 item)" );
    await confirm();
    const l = await binUntil( l => ! has( l, "e.txt" ) );
    ok( ! has( l, "e.txt" ), "the item on screen is deleted", l );
    ok( has( l, "f.txt" ), "the one the phone deleted after the PC looked stays in the bin", l );
    await c.evaluate( "closeTrash(); true" );
}

//------------------------------------------------------------------------//
section( "THE DISK BAR (NEARLY FULL)" );
{
    await seed( "files/big.bin", "x".repeat( 9800 ) );
    await bin( "files/big.bin" );
    await c.open( "/nayive/drive/", "/nayive/drive/" );
    ok( await c.until( READY, 20000 ) && await c.until( "document.getElementById('diskBar').classList.contains('disk-bar--offer')" ),
        "the disk bar offers to empty the bin" );
    await c.evaluate( "document.getElementById('diskBar').onclick(); true" );
    ok( await sheetUp(), "it asks" );
    // f.txt (left by the bin view above) and big.bin: the question counts what it will delete.
    const body = await c.evaluate( "document.querySelector( '.sheet-backdrop.open:not([id]) .dialog-text' ).textContent" );
    ok( body.includes( await c.evaluate( "NayiveUI.tf( 'drive.emptyTrashBody', { n: 2 } )" ) ), "...counting what it will delete (2 items)", body );
    await seed( "files/g.txt", "g" );
    await bin( "files/g.txt" );                   // the phone, while the question is up
    await confirm();
    const l = await binUntil( l => ! has( l, "big.bin" ) );
    ok( ! has( l, "big.bin" ), "what the bin held when asked is deleted", l );
    ok( has( l, "g.txt" ), "the phone's item deleted after that stays", l );
}

//------------------------------------------------------------------------//
section( "NOT ENOUGH ROOM -> EMPTY THE BIN (ensureRoom)" );
{
    await seed( "files/h.txt", "h".repeat( 500 ) );
    await bin( "files/h.txt" );
    const st = JSON.parse( ( await phone.call( "GET", "/api/files?stat=disk" ) ).text );
    ok( st.trash > 0 && st.usable >= 0, "(the bin holds something)", st );
    await c.evaluate( `window.__room = null; NayiveUI.ensureRoom( ${st.usable + 1} ).then( function( r ) { window.__room = r; } ); true` );
    ok( await sheetUp(), "an upload that does not fit offers to empty the bin" );
    await seed( "files/i.txt", "i" );
    await bin( "files/i.txt" );                   // the phone, while the question is up
    await confirm();
    ok( await c.until( "window.__room === true" ), "Empty: the upload may go on" );
    const l = await inBin();
    ok( ! has( l, "h.txt" ) && ! has( l, "g.txt" ), "what the bin held when asked is deleted", l );
    ok( has( l, "i.txt" ), "the phone's item deleted after that stays", l );
}

await done( c, s );
