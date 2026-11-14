// drive-fixes.mjs - the Drive fixes of docs/audit/drive-2026-11-14.md, checked
// on disk: Copy + Paste into another folder (D1, N1), two same-named items
// moved at once (D6), the New folder name checks (D5), a "[" in the search
// box (D9), a search hit renamed onto a taken name (D4), an empty folder
// dropped (N2), two uploads at once (D11), the drop rules (D3, N6).
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, seed, exists } from "./lib.mjs";

const s = await server( { test: "test" } );
seed( s, { "files/A/f.txt": "F", "files/B/keep.txt": "k", "files/X/s.txt": "x", "files/Y/s.txt": "y", "files/Z/z.txt": "z",
           "files/q.txt": "OLD", "files/[draft].txt": "1", "files/d.txt": "2", "files/S/hit.txt": "h", "files/S/taken.txt": "t" } );
const read = rel => fs.readFileSync( path.join( s.home(), rel ), "utf8" );

const c = await browser( s, { mouse: true } );
await c.open( "/nayive/drive/", "/nayive/drive/" );
await c.until( "!! document.querySelector('#listing .row')" );
await c.evaluate( "document.querySelectorAll('dialog[open]').forEach( d => d.close() ); true" );
const goTo = async p => { await c.evaluate( `navigateTo( ${JSON.stringify( p )} ); true` ); await c.until( `! listingLoading && curListing.path === ${JSON.stringify( p )}` ); };

section( "DRIVE FIXES · COPY + PASTE IN ANOTHER FOLDER (D1, N1)" );
await goTo( "files/A" );
await c.evaluate( "setClipboard( 'copy', [ 'files/A/f.txt' ] ); true" );
await goTo( "files/B" );
await c.evaluate( "doPaste().then( () => true )" );
ok( exists( s, "files/B/f.txt" ) && read( "files/B/f.txt" ) === "F", "the file is copied into the other folder" );
ok( exists( s, "files/A/f.txt" ), "the original stays" );
ok( await c.evaluate( "!! ( clipboard && clipboard.mode === 'copy' )" ), "a copy can be pasted again" );
await c.evaluate( "doPaste().then( () => true )" );
const inB = fs.readdirSync( path.join( s.home(), "files/B" ) ).filter( n => n.startsWith( "f" ) );
ok( inB.length === 2, "the second paste makes a second copy, under a free name", inB );

section( "DRIVE FIXES · TWO SAME-NAMED ITEMS MOVED AT ONCE (D6)" );
await c.evaluate( "document.querySelectorAll('.toast').forEach( t => t.remove() ); doMove( [ 'files/X/s.txt', 'files/Y/s.txt' ], 'files/Z' ).then( () => true )" );
ok( exists( s, "files/Z/s.txt" ) && read( "files/Z/s.txt" ) === "x", "the first one goes" );
ok( exists( s, "files/Y/s.txt" ) && read( "files/Y/s.txt" ) === "y", "the second is skipped, still home" );
ok( await c.evaluate( "! [ ...document.querySelectorAll('.toast') ].some( t => /could not move/i.test( t.textContent ) )" ), "no error" );

section( "DRIVE FIXES · NEW FOLDER NAMES (D5)" );
await goTo( "files" );
const tryName = async n => c.evaluate( `( () => { openNewFolder(); document.getElementById( 'newFolderName' ).value = ${JSON.stringify( n )}; return confirmNewFolder().then( () => {
    const e = document.getElementById( 'newFolderError' );
    const r = { open: document.getElementById( 'newFolderBackdrop' ).open, err: e.hidden ? '' : e.getAttribute( 'data-i18n' ) };
    document.getElementById( 'newFolderBackdrop' ).close(); return r; } ); } )()` );
let r = await tryName( "a/b" );
ok( r.open && r.err === "drive.noSlash" && ! exists( s, "files/a" ), "a \"/\" is refused, the dialog stays", r );
r = await tryName( ".hid" );
ok( r.open && r.err === "drive.noDotName" && ! exists( s, "files/.hid" ), "a \".\" name is refused", r );
r = await tryName( "A" );
ok( r.open && r.err === "drive.nameTaken", "a name already here is said", r );
r = await tryName( "Nueva" );
ok( ! r.open && exists( s, "files/Nueva" ), "a good name makes the folder", r );

section( "DRIVE FIXES · SEARCH, DROPS (D9, D3, N6)" );
ok( await c.evaluate( "buildQuery( '[draft]' ).glob === '*[[]draft]*'" ), "a \"[\" is a plain character in the box" );
ok( await c.evaluate( "canDropInto( 'files/A', [ 'files/A/f.txt' ] ) === false" ), "a drop onto its own folder is refused" );
ok( await c.evaluate( "( trashMode = true, ( r => ( trashMode = false, r ) )( canDropFiles() ) ) === false" ), "no file drop on the bin" );

await goTo( "files" );
await c.evaluate( "searchQuery = '[draft]'; Promise.resolve( runSearch() ).then( () => true )" );
ok( await c.until( "searchHits && searchHits.length === 1 && searchHits[ 0 ].path === 'files/[draft].txt'" ),
    "the server finds \"[draft].txt\" only", await c.evaluate( "( searchHits || [] ).map( n => n.path )" ) );

section( "DRIVE FIXES · A SEARCH HIT RENAMED ONTO A TAKEN NAME (D4)" );
await c.evaluate( "searchQuery = 'hit'; Promise.resolve( runSearch() ).then( () => true )" );
await c.until( "searchHits && searchHits.some( n => n.path === 'files/S/hit.txt' )" );
await c.evaluate( "renameTarget = 'files/S/hit.txt'; document.getElementById( 'renameName' ).value = 'taken.txt'; window.__rn = null; confirmRename().then( () => { window.__rn = 'done'; } ); true" );
ok( await c.until( "[ ...document.querySelectorAll( 'dialog.panel[open]:not([id])' ) ].some( d => d.textContent.includes( Ayni.t( 'drive.nameExistsTitle' ) ) )", 5000 ),
    "the \"That name already exists\" question shows" );
await c.evaluate( "document.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Escape', bubbles: true } ) ); true" );
ok( await c.until( "window.__rn === 'done'", 5000 ) && read( "files/S/hit.txt" ) === "h" && read( "files/S/taken.txt" ) === "t", "No: both files untouched" );
await c.evaluate( "clearSearch(); render(); true" );

section( "DRIVE FIXES · AN EMPTY FOLDER DROPPED (N2)" );
await c.evaluate( "uploadItems( [], [ 'E/F' ] ).then( () => true )" );
ok( fs.existsSync( path.join( s.home(), "files/E/F" ) ), "E and E/F are made" );

section( "DRIVE FIXES · TWO UPLOADS AT ONCE (D11)" );
await c.evaluate( `( () => { window.__u = 0;
    const one = t => uploadItems( [ { relPath: 'q.txt', file: new File( [ t ], 'q.txt' ) } ] ).then( () => { window.__u++; } );
    one( 'NEW1' ); one( 'NEW2' ); return true; } )()` );
for( let i = 0; i < 2; i++ )
{
    ok( await c.until( "document.getElementById( 'replaceBackdrop' ).open", 8000 ), `the "already exists" question ${ i + 1 }` );
    await c.evaluate( "settleReplace( 'overwrite' ); true" );
    await c.until( `window.__u === ${ i + 1 }`, 8000 );
}
ok( await c.until( "window.__u === 2", 8000 ), "both uploads end" );
ok( read( "files/q.txt" ) === "NEW2", "they ran one after the other", read( "files/q.txt" ) );
await c.evaluate( "uploadItems( [ { relPath: 'q.txt', file: new File( [ 'NEW3' ], 'q.txt' ) } ] ); true" );
await c.until( "document.getElementById( 'replaceBackdrop' ).open", 8000 );
await c.evaluate( "document.getElementById( 'replaceBackdrop' ).close(); window.__u = 0; uploadItems( [ { relPath: 'w.txt', file: new File( [ 'W' ], 'w.txt' ) } ] ).then( () => { window.__u = 1; } ); true" );
ok( await c.until( "window.__u === 1", 8000 ) && read( "files/q.txt" ) === "NEW2" && read( "files/w.txt" ) === "W", "a question shut by close() is a cancel: the next upload goes on" );

await done( c, s );
