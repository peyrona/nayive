// ds-media-bigpick.mjs - Photos: a pick of 1,300 photos (Ctrl+A in a big
// album), then Download, Bin and its Undo (A1-61, Phase 6b).
//
// Photos sent every path in the address (?paths=) as Drive once did: past the
// server's 64 KiB header cap it answered 431 - "download failed", "trash
// failed" for that album, every time. Now it batches the way Drive does
// (shared/media.js binInBatches / restoreInBatches / postPaths): the bin in
// batches with ONE Undo, the download list in a body.
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
ok( await c.open( "/nayive/photos/index.html?dir=files/Big" ), "Photos opens on the big album" );
ok( await c.until( "typeof PHOTOS !== 'undefined' && PHOTOS.length === " + N, 30000 ), "all 1,300 photos listed",
    await c.evaluate( "typeof PHOTOS !== 'undefined' && PHOTOS.length" ) );
await c.toasts();

//------------------------------------------------------------------------//
section( "DOWNLOAD 1,300 PICKED PHOTOS" );
{
    await c.evaluate( `( () => { const f = NayiveMedia.postPaths; window.__dl = null;
        NayiveMedia.postPaths = ( u, p ) => f( u, p ).then( t => { window.__dl = JSON.parse( t ); return t; } ); return true; } )()` );
    await c.evaluate( `downloadPaths( ${paths} ).then( () => true )` );
    ok( await c.evaluate( "!! window.__dl && window.__dl.files === " + N ), "the server takes it: one zip of 1,300 photos",
        await c.evaluate( "window.__dl" ) );
    ok( ! ( await c.toasts() ).some( t => t.indexOf( "ownload" ) !== -1 ), "no 'download failed'", await c.toasts() );
    await c.evaluate( "window.__dl && fetch( '/api/download?id=' + encodeURIComponent( window.__dl.id ), { method: 'DELETE' } ).then( () => true )" );
}

//------------------------------------------------------------------------//
section( "BIN 1,300 PICKED PHOTOS, THEN ONE UNDO" );
{
    await c.evaluate( `binPaths( ${paths} ); true` );
    ok( await until( () => jpgsOnDisk() === 0, 60000 ), "all 1,300 go to the bin", jpgsOnDisk() );
    ok( await c.until( "document.querySelector( '.toast-undo' ) && ! binBusy", 30000 ), "...with one Undo" );
    ok( await c.evaluate( "PHOTOS.length" ) === 0, "...and the album shows none", await c.evaluate( "PHOTOS.length" ) );
    await c.evaluate( "document.querySelector( '.toast-undo' ).click(); true" );
    ok( await until( () => jpgsOnDisk() === N, 60000 ), "the Undo brings all 1,300 back", jpgsOnDisk() );
    ok( await c.until( "PHOTOS.length === " + N, 30000 ), "...and the album shows them again", await c.evaluate( "PHOTOS.length" ) );
}

//------------------------------------------------------------------------//
section( "A BATCH THAT HALF WENT: WHAT WENT STILL HAS ITS UNDO" );
{
    // b.jpg sits in a folder nobody may write: it cannot leave it; a.jpg goes.
    // The server answers 500 with the ids of what went.
    const half = s.home() + "/files/Half";
    fs.mkdirSync( half + "/ro", { recursive: true } );
    fs.writeFileSync( half + "/a.jpg", "a" );
    fs.writeFileSync( half + "/ro/b.jpg", "b" );
    fs.chmodSync( half + "/ro", 0o555 );
    await c.evaluate( "binPaths( [ 'files/Half/a.jpg', 'files/Half/ro/b.jpg' ] ); true" );
    ok( await until( () => ! fs.existsSync( half + "/a.jpg" ) ), "a.jpg goes to the bin" );
    ok( fs.existsSync( half + "/ro/b.jpg" ), "(b.jpg cannot, and stays)" );
    ok( await c.until( "document.querySelector( '.actionable .toast-undo' ) && ! binBusy", 30000 ), "the failure toast still has an Undo" );
    await c.evaluate( "document.querySelector( '.actionable .toast-undo' ).click(); true" );
    ok( await until( () => fs.existsSync( half + "/a.jpg" ) ), "the Undo brings a.jpg back" );
    fs.chmodSync( half + "/ro", 0o755 );
}

await done( c, s );
