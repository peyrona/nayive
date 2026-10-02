// ds-media-notes.mjs - a photo's note (data/photos/comments.json) is never
// deleted or written over by Photos' clean-up or by Drive's move upkeep.
// Real Photos + Drive in Chromium, a second "device" over plain HTTP.
//
// G1 (list-apps #6): Photos' sweep drops only notes whose photo is neither
//     listed NOR in the bin, and never on a reload made by Drive's file news:
//     bin a photo in Drive, Photos reloads, Drive's Undo -> the note is back.
//     A photo restored while the sweep reads the bin keeps its note too, and
//     an album someone shared with us is never swept (its bin is theirs).
// G3 (drive-files #11): a move with "Replace" (and a move or copy onto the
//     name of something binned) parks the replaced photo's note instead of
//     writing over it; Drive's Undo brings both notes back. The image
//     editor's "Save a copy" onto a taken name, or onto a binned photo's
//     name, parks it the same way; its Undo brings it back.
// C7 (drive-files #13): the move upkeep re-keys on the copy read just then -
//     a note another device saved before the move survives it. (Green on
//     the old code too: the write is not version-checked yet; this pins the
//     narrow window so it cannot widen.)
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep, REPO } from "./lib.mjs";
import { png, bytesOnDisk, PW } from "./office-lib.mjs";

const s = await server( { test: "test", ana: "ana-clave" } );
const PNG = fs.readFileSync( path.join( REPO, "client/apps/icons/icon-192.png" ) );
const seed = ( rel, body ) => { const f = path.join( s.home(), rel ); fs.mkdirSync( path.dirname( f ), { recursive: true } ); fs.writeFileSync( f, body ); };
const NOTES = "data/photos/comments.json";
const notes = () => { try { return JSON.parse( onDisk( s, NOTES ) ); } catch { return null; } };
const exists = rel => fs.existsSync( path.join( s.home(), rel ) );
// Waits for a condition on the server's disk (never a fixed time).
async function disk( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}

// Before the browser reads anything, so straight to disk is safe.
seed( "files/F/a.png", PNG );
seed( "files/F/b.png", PNG );
seed( "files/A/x.png", "AX" );
seed( "files/A/y.png", "AY" );
seed( "files/B/x.png", "BX" );
seed( "files/B/y.png", "BY" );
seed( "files/D/p.png", "DP" );
seed( "files/E/p.png", "EP" );
seed( "files/C/m.png", "CM" );
const RED = png( 200, 0, 0 ), BLUE = png( 0, 0, 200 ), GREEN = png( 0, 160, 0 );
seed( "files/H/src.png", RED );
seed( "files/H/dst.png", BLUE );
seed( "files/H/old.png", GREEN );
seed( NOTES, JSON.stringify( { "files/F/a.png": "note a", "files/F/b.png": "note b",
                               "files/A/x.png": "note AX", "files/A/y.png": "note AY", "files/B/x.png": "note BX",
                               "files/D/p.png": "note DP", "files/E/p.png": "note EP", "files/C/m.png": "note CM",
                               "files/H/src.png": "note src", "files/H/dst.png": "note dst", "files/H/old.png": "note old" } ) );
// Ana's album, lent to test (Photos opens it read-only).
const anaSeed = ( rel, body ) => { const f = path.join( s.home( "ana" ), rel ); fs.mkdirSync( path.dirname( f ), { recursive: true } ); fs.writeFileSync( f, body ); };
anaSeed( "files/Album/s1.png", PNG );
anaSeed( "files/Album/s2.png", PNG );

const c = await browser( s );
const phone = await s.client();
const undo = p => p.evaluate( "( () => { const b = document.querySelector( '#toast .toast-undo' ); if( b ) b.click(); return !! b; } )()" );

//----------------------------------------------------------------------------
section( "G1 - Photos keeps the note of a binned photo" );

const P = c;
ok( await P.open( "/nayive/photos/index.html?dir=files/F" ), "Photos opens on files/F" );
ok( await P.until( "typeof PHOTOS !== 'undefined' && PHOTOS.length === 2 && document.querySelectorAll( '#grid .tile' ).length === 2" ), "both photos listed" );
// Counts the sweeps from here on (a classic script: the global binding is the one loadFolder calls).
await P.evaluate( "( () => { window.__sweeps = 0; const real = window.sweepComments; window.sweepComments = function () { window.__sweeps++; return real.apply( this, arguments ); }; return true; } )()" );
// A note whose photo is gone for good (not listed, not in the bin): the one the sweep is for.
const n0 = notes();
n0[ "files/F/gone.png" ] = "dead note";
ok( ( await phone.put( NOTES, JSON.stringify( n0 ) ) ).status === 200, "the phone adds a note of a photo that is gone" );

const D = await c.tab();
ok( await D.open( "/nayive/drive/index.html" ), "Drive opens in a second tab" );
ok( await D.until( "typeof FS_ROOT !== 'undefined' && FS_ROOT === 'files' && typeof confirmDelete === 'function' && typeof curListing !== 'undefined' && !! curListing" ), "Drive ready" );
// Drive's own delete: to the bin, the scan entries purged, an Undo toast.
await D.evaluate( "deleteTargets = [ 'files/F/a.png' ]; confirmDelete(); true" );
ok( await disk( () => ! exists( "files/F/a.png" ) ), "Drive binned a.png" );
ok( await D.until( "!! document.querySelector( '#toast .toast-undo' )" ), "Drive shows its Undo" );

await P.front();                                  // the user looks at Photos again: its news reload runs
ok( await P.until( "PHOTOS.length === 1 && document.querySelectorAll( '#grid .tile' ).length === 1" ), "Photos reloaded on Drive's news" );
ok( await P.evaluate( "window.__sweeps" ) === 0, "a reload made by another page's news does not sweep the notes",
    await P.evaluate( "window.__sweeps" ) );

// An explicit reload sweeps: the dead note goes (the sentinel that the sweep
// ran to the end), the binned photo's note stays.
await P.evaluate( "document.getElementById( 'reloadBtn' ).click(); true" );
ok( await disk( () => ! ( "files/F/gone.png" in notes() ) ), "Reload: the note of a photo that is gone is swept" );
ok( notes()[ "files/F/a.png" ] === "note a", "Reload: the note of the BINNED photo is kept", notes() );

await D.front();
ok( await undo( D ), "Drive: Undo pressed" );
ok( await disk( () => exists( "files/F/a.png" ) ), "a.png is back" );
ok( notes()[ "files/F/a.png" ] === "note a" && notes()[ "files/F/b.png" ] === "note b", "the photo came back WITH its note", notes() );

// A photo restored AFTER Photos listed the folder but BEFORE its sweep reads
// the bin is in neither: the sweep lists the folder again. The bin read is
// slowed down here, the restore lands in that moment.
const binned = JSON.parse( ( await phone.del( "/api/files?paths=" + encodeURIComponent( "files/F/b.png" ) ) ).text ).ids;
ok( Array.isArray( binned ) && ! exists( "files/F/b.png" ), "the phone bins b.png" );
const n2 = notes();
n2[ "files/F/gone2.png" ] = "dead note 2";
ok( ( await phone.put( NOTES, JSON.stringify( n2 ) ) ).status === 200, "...and adds a note of a photo gone for good" );
await P.front();
await P.evaluate( `( () => { const real = GumApi.trashList;
    GumApi.trashList = async function () {
        await fetch( '/api/files?trash=restore&ids=' + encodeURIComponent( ${JSON.stringify( ( binned || [] ).join( ";" ) )} ), { method: 'POST' } );
        GumApi.trashList = real; return real(); };
    document.getElementById( 'reloadBtn' ).click(); return true; } )()` );
ok( await disk( () => ! ( "files/F/gone2.png" in notes() ) ), "Reload: the sweep ran (the dead note is gone)" );
ok( exists( "files/F/b.png" ) && notes()[ "files/F/b.png" ] === "note b", "b.png, restored while the sweep read the bin, keeps its note", notes() );

//----------------------------------------------------------------------------
section( "G1 - an album someone shared with us is never swept" );

const ana = await s.client( "ana" );
const sh = await ana.post( "/api/shares", JSON.stringify( { to: "test", root: "files/Album", app: "photos" } ), { "Content-Type": "application/json" } );
ok( sh.status === 201, "Ana lends files/Album to test", sh.status );
const lent = ( JSON.parse( ( await phone.call( "GET", "/api/shares" ) ).text ).with_me || [] )[ 0 ];
const LENT = lent && lent.path;
ok( !! LENT, "it is in test's \"shared with me\"", lent );
const n3 = notes();
n3[ LENT + "/s1.png" ] = "my note s1";
n3[ LENT + "/s2.png" ] = "my note s2";
ok( ( await phone.put( NOTES, JSON.stringify( n3 ) ) ).status === 200, "test has notes on both of her photos" );
ok( ( await ana.del( "/api/files?paths=" + encodeURIComponent( "files/Album/s1.png" ) ) ).status === 200, "Ana bins s1.png (her bin, not test's)" );
// Counts the page's writes of the notes from its first line on (GumApi PUTs
// with XMLHttpRequest): the disk is read only once every one has landed.
await P.send( "Page.addScriptToEvaluateOnNewDocument", { source: `( () => { window.__xp = { on: 0, off: 0 };
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function ( m, u ) { this.__n = m === 'PUT' && String( u ).indexOf( 'comments.json' ) !== -1; return open.apply( this, arguments ); };
    XMLHttpRequest.prototype.send = function () { if( this.__n ) { window.__xp.on++; this.addEventListener( 'loadend', () => window.__xp.off++ ); } return send.apply( this, arguments ); };
} )()` } );
ok( await P.open( "/nayive/photos/index.html?dir=" + encodeURIComponent( LENT ) ), "Photos opens her album" );
ok( await P.until( "typeof PHOTOS !== 'undefined' && PHOTOS.length === 1 && document.querySelectorAll( '#grid .tile' ).length === 1" ), "one photo listed" );
// A Reload's sweep, waited for to the end (its promise), then every write.
await P.evaluate( "( () => { const real = window.sweepComments; window.sweepComments = function () { return window.__sweep = real.apply( this, arguments ); }; return true; } )()" );
await P.evaluate( "document.getElementById( 'reloadBtn' ).click(); true" );
ok( await P.until( "!! window.__sweep" ), "Reload swept (or skipped)" );
await P.evaluate( "window.__sweep.then( () => true )" );
ok( await P.until( "window.__xp.on === window.__xp.off" ), "every write of the notes has landed" );
ok( notes()[ LENT + "/s1.png" ] === "my note s1", "our note on the photo SHE binned stays (her Restore brings it back)", notes() );

//----------------------------------------------------------------------------
section( "G3 - a move with Replace parks the replaced photo's note; Undo brings both back" );

await D.evaluate( "NayiveUI.confirm = () => Promise.resolve( true ); true" );     // "Replace" in the clash question
await D.evaluate( "doMove( [ 'files/B/x.png', 'files/B/y.png' ], 'files/A' ).then( () => true )" );
ok( await disk( () => onDisk( s, "files/A/x.png" ) === "BX" && onDisk( s, "files/A/y.png" ) === "BY" ), "B/x and B/y moved over A/x and A/y" );
let n = notes();
ok( n[ "files/A/x.png" ] === "note BX", "the moved photo's note followed it", n );
ok( ! ( "files/A/y.png" in n ), "a moved photo with no note shows none (not the replaced one's)", n );
ok( JSON.stringify( n ).includes( "note AX" ) && JSON.stringify( n ).includes( "note AY" ), "the replaced photos' notes are kept (parked)", n );

ok( await undo( D ), "Drive: Undo pressed" );
ok( await disk( () => onDisk( s, "files/A/x.png" ) === "AX" && onDisk( s, "files/B/x.png" ) === "BX" &&
                      onDisk( s, "files/A/y.png" ) === "AY" && onDisk( s, "files/B/y.png" ) === "BY" ), "Undo: every file back in place" );
n = notes();
ok( n[ "files/A/x.png" ] === "note AX" && n[ "files/B/x.png" ] === "note BX" && n[ "files/A/y.png" ] === "note AY" &&
    ! ( "files/B/y.png" in n ), "Undo: both notes of each pair are back on their own photo", n );
ok( ! ( "#aside" in n ), "Undo: nothing is left parked", n );

// A copy onto the name of a photo in the bin: the binned photo's note is
// parked, not written over (a restore must not find someone else's).
await D.evaluate( "GumApi.binPaths( [ 'files/D/p.png' ] ).then( () => NayiveMedia.purgePaths( [ 'files/D/p.png' ] ) ).then( () => true )" );
ok( ! exists( "files/D/p.png" ) && notes()[ "files/D/p.png" ] === "note DP", "D/p.png binned, its note kept at its path" );
// What Drive's doCopy does (it copies only rows of the folder on screen).
await D.evaluate( `GumApi.fetchText( GumApi.API_FILES + '?' + new URLSearchParams( { from: 'files/E/p.png', 'new': 'files/D/p.png' } ), { method: 'POST' } )
                   .then( () => NayiveMedia.copyPaths( [ [ 'files/E/p.png', 'files/D/p.png' ] ] ) ).then( () => true )` );
ok( await disk( () => onDisk( s, "files/D/p.png" ) === "EP" ), "E/p.png copied to D/p.png" );
n = notes();
ok( n[ "files/D/p.png" ] === "note EP" && JSON.stringify( n ).includes( "note DP" ), "the copy has its own note; the binned one's is parked", n );

//----------------------------------------------------------------------------
section( "C7 - the move upkeep works on the notes as they are now" );

const n1 = notes();
n1[ "files/Z/z.png" ] = "phone note";
ok( ( await phone.put( NOTES, JSON.stringify( n1 ) ) ).status === 200, "the phone saves a note while Drive is open" );
await D.evaluate( "doMove( [ 'files/C/m.png' ], 'files/A' ).then( () => true )" );
ok( await disk( () => exists( "files/A/m.png" ) && notes()[ "files/A/m.png" ] === "note CM" ), "C/m.png moved with its note" );
ok( notes()[ "files/Z/z.png" ] === "phone note", "the phone's note survived the move upkeep", notes() );

//----------------------------------------------------------------------------
section( "G3 - Image's \"Save a copy\" parks the note of what it replaces" );

// old.png goes to the bin first: its note stays at its name, for a restore.
ok( ( await phone.del( "/api/files?paths=" + encodeURIComponent( "files/H/old.png" ) ) ).status === 200 && ! exists( "files/H/old.png" ),
    "old.png binned (its note stays at its name)" );
const I = await c.tab();
ok( await I.open( "/nayive/image/?file=files/H/src.png", "/nayive/image/" ), "Image opens src.png" );
await I.evaluate( PW + "( window )" );
ok( await I.until( "document.querySelector('.tie-btn-flip') && ! document.getElementById('editorSaveBtn').disabled && document.getElementById('editorComment').value === 'note src'", 30000 ),
    "the editor is up, with src.png's note" );
async function saveCopy( name )
{
    await I.evaluate( "document.getElementById('editorSaveAsBtn').click(), true" );
    ok( await I.until( "document.getElementById('saveCopyBackdrop').classList.contains('open')" ), "the copy's name is asked" );
    await I.evaluate( "document.getElementById('saveCopyName').value = " + JSON.stringify( name ) + ", document.getElementById('saveCopyConfirmBtn').click(), true" );
}

await saveCopy( "dst.png" );
ok( await I.until( "window.__sheet().indexOf( NayiveUI.t('drive.nameExistsTitle') ) !== -1" ), "it asks before replacing dst.png" );
await I.evaluate( "window.__pressConfirm()" );
ok( await disk( () => { const b = bytesOnDisk( s, "files/H/dst.png" ); return b && ! b.equals( BLUE ) && notes()[ "files/H/dst.png" ] === "note src"; } ),
    "the copy is written over dst.png, with the copy's note" );
ok( JSON.stringify( notes() ).includes( "note dst" ), "the replaced dst.png's note is kept (parked)", notes() );
ok( await I.until( "!! document.querySelector( '#toast .toast-undo' )" ), "its toast offers an Undo" );
ok( await undo( I ), "Undo pressed" );
ok( await disk( () => { const b = bytesOnDisk( s, "files/H/dst.png" ); return b && b.equals( BLUE ) && notes()[ "files/H/dst.png" ] === "note dst"; } ),
    "Undo: dst.png is back, with its own note", notes() );
ok( ! ( ( notes()[ "#aside" ] || {} )[ "files/H/dst.png" ] ), "Undo: nothing left parked for dst.png", notes() );

await saveCopy( "old.png" );                    // a free name - but a binned photo's
ok( await disk( () => exists( "files/H/old.png" ) && notes()[ "files/H/old.png" ] === "note src" ), "a copy at old.png, with the copy's note" );
ok( JSON.stringify( notes() ).includes( "note old" ), "the binned old.png's note is kept (parked), not written over", notes() );


await done( c, s );
