// ds-drive-tree-drop.mjs - Drive's tree-list (List view, folders open in
// place): a drop onto a NESTED folder moves the file there and only there,
// and a folder picked together with a file inside it moves once, carrying
// the file (menus.js topPicks) - nothing lost, nothing doubled, nothing binned.
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";

const s = await server();
const phone = await s.client();
const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };
const mkdir = rel => fs.mkdirSync( path.join( s.home(), rel ), { recursive: true } );
const inBin = async () => JSON.parse( ( await phone.call( "GET", "/api/files?trash=list" ) ).text ).items.length;
const there = rel => fs.existsSync( path.join( s.home(), rel ) );
const read  = rel => onDisk( s, rel );

mkdir( "files/A" );
mkdir( "files/A/B" );
mkdir( "files/C" );
await seed( "files/A/one.txt", "one" );
await seed( "files/A/B/two.txt", "two" );
await seed( "files/top.txt", "top" );

const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:drive', '1' ); localStorage.setItem( 'drive-view', 'list' ); true" );
const READY = "typeof toggleDir === 'function' && FS_ROOT === 'files' && currentFolder === 'files' && ! listingLoading";
const row = p => `document.querySelector( '#listing .row[data-path="${ p }"]' )`;

// A drag the way the browser makes one: dragstart on the row, dragover and
// drop on the target (Ayni.dropZone reads the ids taken at dragstart).
const dragTo = ( from, to ) => c.evaluate( `( function() {
    const dt = new DataTransfer();
    const src = ${ row( from ) }, dst = ${ row( to ) };
    if( ! src || ! dst ) return false;
    src.dispatchEvent( new DragEvent( 'dragstart', { bubbles: true, cancelable: true, dataTransfer: dt } ) );
    dst.dispatchEvent( new DragEvent( 'dragover',  { bubbles: true, cancelable: true, dataTransfer: dt } ) );
    dst.dispatchEvent( new DragEvent( 'drop',      { bubbles: true, cancelable: true, dataTransfer: dt } ) );
    src.dispatchEvent( new DragEvent( 'dragend',   { bubbles: true, cancelable: true, dataTransfer: dt } ) );
    return true; } )()` );

//------------------------------------------------------------------------//
section( "A DROP ONTO A NESTED FOLDER" );
{
    ok( await c.open( "/nayive/drive/", "/nayive/drive/" ) && await c.until( READY, 20000 ), "Drive is open (List view)" );
    await c.evaluate( "toggleDir( 'files/A', true ); true" );
    ok( await c.until( `!! ${ row( "files/A/B" ) }` ), "A opens in place: B shows under it" );
    ok( await dragTo( "files/top.txt", "files/A/B" ), "top.txt dragged onto the nested B" );
    ok( await c.until( `!! ( function() { return ! ${ row( "files/top.txt" ) }; } )()` ), "top.txt leaves the list" );
    ok( there( "files/A/B/top.txt" ) && read( "files/A/B/top.txt" ) === "top", "it is in A/B, whole" );
    ok( ! there( "files/top.txt" ), "and gone from Home" );
    ok( there( "files/A/B/two.txt" ) && read( "files/A/B/two.txt" ) === "two", "B's own file is untouched" );
    ok( await inBin() === 0, "nothing went to the bin" );
}

//------------------------------------------------------------------------//
section( "A FOLDER AND A FILE INSIDE IT, PICKED TOGETHER" );
{
    await c.evaluate( "toggleDir( 'files/A/B', true ); true" );
    ok( await c.until( `!! ${ row( "files/A/B/two.txt" ) }` ), "B opens: two.txt shows" );
    await c.evaluate( "browse.set( [ 'files/A/B', 'files/A/B/two.txt' ] ); true" );
    const targets = await c.evaluate( "actionTargets()" );
    ok( targets.length === 1 && targets[ 0 ] === "files/A/B", "the actions see only the folder", targets );
    ok( await dragTo( "files/A/B", "files/C" ), "both dragged onto C" );
    ok( await c.until( `! ${ row( "files/A/B" ) }` ), "B leaves A" );
    ok( there( "files/C/B/two.txt" ) && read( "files/C/B/two.txt" ) === "two", "two.txt went with its folder, whole" );
    ok( there( "files/C/B/top.txt" ) && read( "files/C/B/top.txt" ) === "top", "and so did top.txt" );
    ok( ! there( "files/C/two.txt" ), "two.txt was not moved a second time on its own" );
    ok( ! there( "files/A/B" ), "A/B is gone" );
    ok( there( "files/A/one.txt" ) && read( "files/A/one.txt" ) === "one", "A's own file is untouched" );
    ok( await inBin() === 0, "nothing went to the bin" );
}

//------------------------------------------------------------------------//
section( "THE OPEN FOLDERS FOLLOW A RELOAD" );
{
    await c.evaluate( "toggleDir( 'files/C', true ); true" );
    ok( await c.until( `!! ${ row( "files/C/B" ) }` ), "C opens: B shows under it" );
    await seed( "files/C/new.txt", "new" );                 // another device
    await c.evaluate( "reload(); true" );
    ok( await c.until( `!! ${ row( "files/C/new.txt" ) }` ), "a reload shows the new file inside the open C" );
}

await done( c, s );
