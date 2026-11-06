// ds-drive-thumbs.mjs - Drive's picture previews (drive/thumbs.js) and the
// Photos sweep that keeps them (photos/index.html sweepThumbs).
//
// Drive's icons view shows a picture's thumbnail and makes the missing ones
// in the browser: data/photos/thumbs/<size>_<mtime>.jpg, the file Photos
// makes. The write must be create-only (a thumbnail there is never written
// over), touch nothing else, and never happen in the list view. Photos' daily
// sweep must keep every thumbnail a picture in Home still has (Drive's too),
// delete only true orphans, and delete nothing when Home cannot be listed in
// full.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { server, browser, ok, section, done, sleep } from "./lib.mjs";
import { put, png, bytesOnDisk } from "./office-lib.mjs";

const s = await server();
const RED = png( 200, 0, 0 ), BLUE = png( 0, 0, 200 ), GREEN = png( 0, 160, 0 ), GREY = png( 90, 90, 90 );
put( s, "files/Pics/a.png", RED );
put( s, "files/Pics/b.png", BLUE );
put( s, "files/Pics/note.txt", "not a picture" );

const thumbOf = rel =>
{
    const st = fs.statSync( path.join( s.home(), rel ) );
    return "data/photos/thumbs/" + st.size + "_" + Math.floor( st.mtimeMs / 1000 ) + ".jpg";
};
// b.png already has a "thumbnail" (not even a picture): it must stay as it is.
const KEEP = Buffer.from( "an existing thumbnail - never written over" );
put( s, thumbOf( "files/Pics/b.png" ), KEEP );

// Every file of the home, with a hash of its bytes.
function snapshot()
{
    const out = {};
    const walk = d =>
    {
        for( const e of fs.readdirSync( d, { withFileTypes: true } ) )
        {
            const p = path.join( d, e.name );
            if( e.isDirectory() ) walk( p );
            else out[ path.relative( s.home(), p ) ] = crypto.createHash( "sha1" ).update( fs.readFileSync( p ) ).digest( "hex" );
        }
    };
    walk( s.home() );
    return out;
}
async function untilFile( rel, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { const b = bytesOnDisk( s, rel ); if( b && b.length ) return b; await sleep( 150 ); }
    return null;
}

const c = await browser( s, { width: 1280, height: 900 } );

//----------------------------------------------------------------------------//
section( "DRIVE · ICONS: A MISSING THUMBNAIL IS MADE, NOTHING ELSE IS WRITTEN" );
{
    const before = snapshot();
    ok( await c.open( "/nayive/drive/?open=files/Pics", "/nayive/drive/" ) &&
        await c.until( "document.querySelectorAll('#listing .list-rows.is-grid .row[data-path]').length === 3" ), "Drive opens Pics as icons" );

    const A = thumbOf( "files/Pics/a.png" );
    const made = await untilFile( A );
    ok( made && made[ 0 ] === 0xff && made[ 1 ] === 0xd8, "a.png's thumbnail is made, a JPEG", A );
    ok( await c.until( "!! document.querySelector('#listing .row[data-path=\"files/Pics/a.png\"] img.row-thumb')" ), "…and shown in its tile" );
    await sleep( 1500 );                                   // b.png's try (create-only) has had time to land

    ok( bytesOnDisk( s, thumbOf( "files/Pics/b.png" ) ).equals( KEEP ), "b.png's existing thumbnail is not written over" );
    ok( bytesOnDisk( s, "files/Pics/a.png" ).equals( RED ) && bytesOnDisk( s, "files/Pics/b.png" ).equals( BLUE ), "the pictures themselves are untouched" );

    const after = snapshot();
    const changed = Object.keys( after ).filter( k => after[ k ] !== before[ k ] );
    const gone    = Object.keys( before ).filter( k => ! ( k in after ) );
    ok( changed.join() === A && ! gone.length, "the one new file is that thumbnail; nothing changed or went", { changed, gone } );
}

//----------------------------------------------------------------------------//
section( "DRIVE · LIST VIEW MAKES NONE" );
{
    await c.evaluate( "setViewMode( 'list' ); true" );
    put( s, "files/Pics/c.png", GREEN );
    await c.evaluate( "loadListing( 'files/Pics' ); true" );
    await c.until( "!! document.querySelector('#listing .row[data-path=\"files/Pics/c.png\"]')" );
    await sleep( 2000 );
    ok( ! bytesOnDisk( s, thumbOf( "files/Pics/c.png" ) ), "a new picture shown as a list row gets no thumbnail" );
    ok( await c.evaluate( "! document.querySelector('#listing img.row-thumb')" ), "…and the list shows no previews" );
}

//----------------------------------------------------------------------------//
section( "PHOTOS · THE SWEEP KEEPS DRIVE'S THUMBNAILS, DROPS ORPHANS" );
{
    // A picture Photos never opened, with a thumbnail Drive made; and an orphan.
    put( s, "files/Other/d.png", GREY );
    const D = thumbOf( "files/Other/d.png" );
    put( s, D, Buffer.from( "made by Drive" ) );
    const ORPHAN = "data/photos/thumbs/999_1.jpg";
    put( s, ORPHAN, Buffer.from( "no picture has this key" ) );

    ok( await c.open( "/nayive/photos/index.html?dir=files/Pics" ), "Photos opens on Pics" );
    ok( await c.until( "typeof SCAN_CACHE === 'object' && SCAN_CACHE.loaded && typeof sweepThumbs === 'function'", 20000 ), "(its scan cache is read)" );

    await c.evaluate( "( async () => { localStorage.removeItem( THUMB_SWEEP_KEY ); await sweepThumbs(); return true; } )()" );
    ok( ! bytesOnDisk( s, ORPHAN ), "the orphan thumbnail goes" );
    ok( bytesOnDisk( s, D ) && bytesOnDisk( s, D ).toString() === "made by Drive", "the thumbnail Drive made for a folder Photos never opened stays" );
    ok( bytesOnDisk( s, thumbOf( "files/Pics/a.png" ) ), "…and so do the ones of the open album" );

    // Home cannot be listed in full (every search cut short): nothing goes.
    const ORPHAN2 = "data/photos/thumbs/998_1.jpg";
    put( s, ORPHAN2, Buffer.from( "another orphan" ) );
    await c.evaluate( `( async () => {
        const real = AyniNet.search;
        AyniNet.search = () => Promise.resolve( { nodes: [], truncated: true } );
        localStorage.removeItem( THUMB_SWEEP_KEY );
        try { await sweepThumbs(); } finally { AyniNet.search = real; }
        return true; } )()` );
    ok( bytesOnDisk( s, ORPHAN2 ) && bytesOnDisk( s, D ), "Home not listed in full: the sweep deletes nothing" );

    // The search fails (offline): nothing goes either.
    await c.evaluate( `( async () => {
        const real = AyniNet.search;
        AyniNet.search = () => Promise.reject( Object.assign( new Error( "offline" ), { status: 0 } ) );
        localStorage.removeItem( THUMB_SWEEP_KEY );
        try { await sweepThumbs(); } finally { AyniNet.search = real; }
        return true; } )()` );
    ok( bytesOnDisk( s, ORPHAN2 ) && bytesOnDisk( s, D ), "the search fails: the sweep deletes nothing" );
}

//----------------------------------------------------------------------------//
section( "PHOTOS · VIDEOS: A FRAME BECOMES THE THUMBNAIL, ADD UPLOADS ONE, THE SWEEP KEEPS THEM" );
{
    const CLIP = fs.readFileSync( path.join( path.dirname( new URL( import.meta.url ).pathname ), "fixtures", "clip.webm" ) );
    put( s, "files/Vids/clip.webm", CLIP );
    put( s, "files/Elsewhere/far.webm", Buffer.concat( [ CLIP, Buffer.from( [ 0 ] ) ] ) );     // another size: a thumbnail key is size + second
    const FAR = thumbOf( "files/Elsewhere/far.webm" );
    put( s, FAR, Buffer.from( "a video thumbnail of a folder Photos never opened" ) );
    const T = thumbOf( "files/Vids/clip.webm" );

    ok( await c.open( "/nayive/photos/index.html?dir=files/Vids" ), "Photos opens on Vids" );
    const made = await untilFile( T, 40000 );                             // longer than Photos' own 30 s for reading a frame
    ok( made && made[ 0 ] === 0xFF && made[ 1 ] === 0xD8, "the video's thumbnail is a JPEG made from a frame" );
    ok( bytesOnDisk( s, "files/Vids/clip.webm" ).equals( CLIP ), "the video itself is untouched" );

    // Add: the picked video goes up byte for byte, beside the first.
    const pick = path.join( fs.mkdtempSync( path.join( s.home(), "..", "pick-" ) ), "second.webm" );
    fs.writeFileSync( pick, CLIP );
    const doc = await c.send( "DOM.getDocument", {} );
    const q   = await c.send( "DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#addInput" } );
    await c.send( "DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [ pick ] } );
    const up = await untilFile( "files/Vids/second.webm" );
    ok( up && up.equals( CLIP ), "Add uploads the video as it is" );
    ok( bytesOnDisk( s, "files/Vids/clip.webm" ).equals( CLIP ), "...and the one already there is untouched" );

    await c.evaluate( "( async () => { localStorage.removeItem( THUMB_SWEEP_KEY ); await sweepThumbs(); return true; } )()" );
    ok( bytesOnDisk( s, T ), "the sweep keeps the open album's video thumbnail" );
    ok( bytesOnDisk( s, FAR ), "...and a video's thumbnail in a folder Photos never opened" );
}

await done( c, s );
