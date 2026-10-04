// ds-drive-bigpick.mjs - Drive: a pick of 1,300 files (Ctrl+A in a big
// folder), then Download, Compress, Bin and its Undo (AB1, bugs-2).
//
// Every path rode in the address (?paths=): 1,300 long names passed the
// server's 64 KiB header cap and it answered 431 - "download failed",
// "trash failed", every time, for that folder. Now the bin goes in batches
// (one Undo for all of them) and Download / Compress send the list in a body.
import fs from "node:fs";
import { server, browser, ok, section, done, sleep } from "./lib.mjs";

const N = 1300;
const s = await server();
const dir = s.home() + "/files/Big";
fs.mkdirSync( dir );
const names = [];
for( let i = 0; i < N; i++ )
{
    const name = "IMG_20250812_" + String( i ).padStart( 6, "0" ) + "_vacaciones_en_la_playa_de_mallorca.jpg";
    fs.writeFileSync( dir + "/" + name, "jpeg" );
    names.push( name );
}
const paths = JSON.stringify( names.map( n => "files/Big/" + n ) );
const jpgsOnDisk = () => fs.readdirSync( dir ).filter( n => n.endsWith( ".jpg" ) ).length;
async function until( fn, ms = 30000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}

const c = await browser( s );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:drive', '1' ); true" );
const READY = "typeof openDeleteConfirm === 'function' && FS_ROOT === 'files' && ! listingLoading";
ok( await c.open( "/nayive/drive/", "/nayive/drive/" ) && await c.until( READY, 20000 ), "Drive is open" );
await c.evaluate( "navigateTo( 'files/Big' ); true" );
ok( await c.until( "currentFolder === 'files/Big' && ! listingLoading", 20000 ), "the big folder is open" );
const pickAll = () => c.evaluate( `setSel( ${paths} ); actionTargets().length` );

//------------------------------------------------------------------------//
section( "DOWNLOAD 1,300 PICKED FILES" );
{
    ok( await pickAll() === N, "all 1,300 picked" );
    await c.evaluate( "downloadSelection(); true" );
    ok( await c.until( "dlJob && dlJob.files === " + N, 30000 ), "the download starts, one zip of 1,300 files",
        await c.evaluate( "dlJob && dlJob.files" ) );
    await c.evaluate( "if( dlJob ) stopDownload(); true" );
}

//------------------------------------------------------------------------//
section( "COMPRESS 1,300 PICKED FILES" );
{
    ok( await pickAll() === N, "all 1,300 picked" );
    await c.evaluate( "compressSelection(); true" );
    ok( await until( () => fs.readdirSync( dir ).some( n => n.endsWith( ".zip" ) ) ), "a .zip is made beside them",
        fs.readdirSync( dir ).filter( n => ! n.endsWith( ".jpg" ) ) );
}

//------------------------------------------------------------------------//
section( "BIN 1,300 PICKED FILES, THEN ONE UNDO" );
{
    await c.until( READY, 20000 );
    ok( await pickAll() === N, "all 1,300 picked" );
    await c.evaluate( "openDeleteConfirm(); true" );
    ok( await until( () => jpgsOnDisk() === 0, 60000 ), "all 1,300 go to the bin", jpgsOnDisk() );
    ok( await c.until( "document.querySelector( '.toast-undo' ) && ! deleteBusy", 30000 ), "...with one Undo" );
    await c.evaluate( "document.querySelector( '.toast-undo' ).click(); true" );
    ok( await until( () => jpgsOnDisk() === N, 60000 ), "the Undo brings all 1,300 back", jpgsOnDisk() );
}

//------------------------------------------------------------------------//
section( "A PICK TOO BIG EVEN FOR A BODY (OVER 1 MIB): SAID CLEARLY (review)" );
{
    const said = await c.evaluate( `postPaths( '/api/zip', Array.from( { length: 20000 }, ( _, i ) => 'files/Big/' + i + '_${names[ 0 ]}' ) )
        .then( () => 'sent', err => err.tooMany ? compressFailText( err ) : 'other: ' + err.message )` );
    ok( said === await c.evaluate( "T( 'drive.pickTooMany' )" ), "refused before sending, with 'too many items at once'", said );
}

//------------------------------------------------------------------------//
section( "A BATCH THAT HALF WENT: WHAT WENT STILL HAS ITS UNDO (review)" );
{
    // b.txt sits in a folder nobody may write: it cannot leave it; a.txt goes.
    // The server answers 500 with the ids of what went.
    const half = s.home() + "/files/Half";
    fs.mkdirSync( half + "/ro", { recursive: true } );
    fs.writeFileSync( half + "/a.txt", "a" );
    fs.writeFileSync( half + "/ro/b.txt", "b" );
    fs.chmodSync( half + "/ro", 0o555 );
    await c.evaluate( "deleteTargets = [ 'files/Half/a.txt', 'files/Half/ro/b.txt' ]; confirmDelete(); true" );
    ok( await until( () => ! fs.existsSync( half + "/a.txt" ) ), "a.txt goes to the bin" );
    ok( fs.existsSync( half + "/ro/b.txt" ), "(b.txt cannot, and stays)" );
    ok( await c.until( "document.querySelector( '.actionable .toast-undo' ) && ! deleteBusy", 30000 ), "the failure toast still has an Undo" );
    await c.evaluate( "document.querySelector( '.actionable .toast-undo' ).click(); true" );
    ok( await until( () => fs.existsSync( half + "/a.txt" ) ), "the Undo brings a.txt back" );
    fs.chmodSync( half + "/ro", 0o755 );
}

await done( c, s );
