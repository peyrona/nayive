// ds-versioned-media.mjs - the media apps' shared files are written only over
// the version they read (batch C4b): another device's save that lands between
// a page's read and its write is kept, never written over.
//
// Each case makes that race happen every time (race.mjs): the page reads the
// file, the other device saves, and only then does the page write. The old
// code re-read right before writing but wrote blind - it dropped that save.
//
// C7 (drive-files #13): media.js upkeep of Drive's move/copy/bin - photo notes,
//     Movies' resume points, the scan caches.
// A4 (list-apps #5): Music's "Save list".
// A7 (list-apps #30, #31, #32): Movies' posters.json and progress.json,
//     Photos' places.json; and Photos' own note save.
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep, REPO } from "./lib.mjs";
import { installRace, arm, raced } from "./race.mjs";

const s = await server();
const PNG = fs.readFileSync( path.join( REPO, "client/apps/icons/icon-192.png" ) );
const seed = ( rel, body ) => { const f = path.join( s.home(), rel ); fs.mkdirSync( path.dirname( f ), { recursive: true } ); fs.writeFileSync( f, body ); };
const json = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
async function disk( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}
// The other device's change, as the source of a function text -> text.
const add = ( obj ) => `t => JSON.stringify( Object.assign( JSON.parse( t ), ${JSON.stringify( obj )} ) )`;

const LISTS    = "data/music/playlists.json";
const POSTERS  = "data/movies/posters.json";
const PROG     = "data/movies/progress.json";
const PLACES   = "data/photos/places.json";
const NOTES    = "data/photos/comments.json";
const MSCAN    = "data/music/scan-cache.json";
const FILM1 = "files/Movies/Uno (2001).mp4", FILM2 = "files/Movies/Dos (2002).mp4";

// Before the browser reads anything, so straight to disk is safe.
seed( "files/Music/song.mp3", "not really a song" );
seed( LISTS, JSON.stringify( [ { id: "plA", name: "A", paths: [ "files/Music/song.mp3" ] } ] ) );
seed( FILM1, "not really a film" );
seed( FILM2, "not really a film" );
seed( POSTERS, JSON.stringify( { key: "K1", items: {} } ) );
seed( PROG, JSON.stringify( { version: 1, watched: {}, resume: {} } ) );
seed( PLACES, JSON.stringify( { "1.000,1.000": "Old" } ) );
seed( NOTES, JSON.stringify( { "files/Z/x.png": "note x" } ) );
seed( MSCAN, JSON.stringify( { "files/Elsewhere/old.mp3": { size: 1, mtime: 1 } } ) );
seed( "files/G/a.png", PNG );

const c = await browser( s );

//----------------------------------------------------------------------------
section( "A4 · Music: a list saved between the page's read and its write is kept" );
{
    ok( await c.open( "/nayive/music/index.html?dir=files/Music" ), "Music opens" );
    ok( await c.until( "typeof st !== 'undefined' && st.playlists.length === 1" ), "Music read its one list" );
    await installRace( c );
    await arm( c, LISTS, "t => JSON.stringify( JSON.parse( t ).concat( [ { id: 'plR', name: 'R', paths: [] } ] ) )" );
    await c.evaluate( `( () => { st.queue = [ { song: { path: 'files/Music/song.mp3', title: 'song' } } ]; openSaveSheet();
                                 document.getElementById( 'playlistName' ).value = 'S'; return true; } )()` );
    await c.evaluate( "confirmSave().then( () => true, () => true )" );
    ok( await raced( c ), "the phone saved list R in between" );
    ok( await disk( () => ( json( LISTS ) || [] ).some( p => p.name === "S" ) ), "Save list: S is on the server" );
    const names = ( json( LISTS ) || [] ).map( p => p.name ).sort().join( "," );
    ok( names === "A,R,S", "...and the phone's R is still there", names );
    ok( await c.evaluate( "st.playlists.map( p => p.name ).sort().join() === 'A,R,S'" ), "the page shows the three" );
}

//----------------------------------------------------------------------------
section( "A7 · Movies: posters and resume points saved in between are kept" );
{
    ok( await c.open( "/nayive/movies/index.html?dir=files/Movies" ), "Movies opens" );
    ok( await c.until( "typeof st !== 'undefined' && st.movies.length === 2 && st.posters.key === 'K1'" ), "Movies listed 2 films" );
    await installRace( c );
    // TMDB answers one poster per film; its image cannot be fetched (the remote URL is kept).
    await c.evaluate( `( () => { const f = window.fetch;
        window.fetch = function ( u, o ) { if( String( u ).indexOf( 'api.themoviedb.org' ) !== -1 )
            return Promise.resolve( new Response( JSON.stringify( { results: [ { id: 7, poster_path: '/p.jpg', title: 'T' } ] } ), { status: 200 } ) );
            return f.apply( this, arguments ); };
        GumApi.fetchBinary = () => Promise.reject( new TypeError( 'blocked' ) ); return true; } )()` );
    await arm( c, POSTERS, "t => { const d = JSON.parse( t ); d.items[ 'phone|1999' ] = { tmdb: null }; return JSON.stringify( d ); }" );
    await c.evaluate( "fetchPosters().then( () => true )" );
    ok( await raced( c ), "the phone saved a poster in between" );
    const po = json( POSTERS );
    ok( po && po.items[ "phone|1999" ], "posters: the phone's is kept", po );
    ok( po && Object.keys( po.items ).length === 3, "...and both films' posters are saved", po );

    const t = Math.floor( Date.now() / 1000 );
    await arm( c, PROG, `t => { const d = JSON.parse( t ); d.resume[ 'files/Movies/Tres.mp4' ] = { t: 60, d: 6000, at: ${t} }; return JSON.stringify( d ); }` );
    await c.evaluate( `( () => { toggleWatched( st.movies.find( m => m.path === ${JSON.stringify( FILM1 )} ) ); return st.progSaving.then( () => true ); } )()` );
    ok( await raced( c ), "the phone saved a resume point in between" );
    ok( await disk( () => json( PROG ).watched[ FILM1 ] === true ), "progress: this page's mark is saved" );
    ok( json( PROG ).resume[ "files/Movies/Tres.mp4" ], "...and the phone's resume point is kept", json( PROG ) );
}

//----------------------------------------------------------------------------
section( "A7 · Photos: places and notes saved in between are kept" );
{
    ok( await c.open( "/nayive/photos/index.html?dir=files/G" ), "Photos opens" );
    ok( await c.until( "typeof st !== 'undefined' && st.geoReady === true && PHOTOS.length === 1" ), "Photos scanned" );
    await installRace( c );

    // Nominatim answers once __go is set: the run's first read of places.json
    // is over by then; the race is on its save.
    await c.evaluate( `( () => { window.__go = false; window.__asked = false; const f = window.fetch;
        window.fetch = function ( u, o ) { if( String( u ).indexOf( 'nominatim' ) === -1 ) return f.apply( this, arguments );
            window.__asked = true;
            return new Promise( r => { const t = setInterval( () => { if( window.__go ) { clearInterval( t );
                r( new Response( JSON.stringify( { address: { city: 'Uno' } } ), { status: 200 } ) ); } }, 50 ); } ); };
        CLUSTERS = [ { lat: 10, lon: 20, items: [] } ]; geocode(); return true; } )()` );
    ok( await c.until( "window.__asked" ), "the run asks Nominatim" );
    await arm( c, PLACES, add( { "50.000,60.000": "Phone" } ) );
    await c.evaluate( "window.__go = true" );
    ok( await raced( c ), "the phone saved a place in between" );
    ok( await disk( () => json( PLACES ) && json( PLACES )[ "10.000,20.000" ] === "Uno" ), "places: this run's place is saved" );
    ok( json( PLACES )[ "50.000,60.000" ] === "Phone" && json( PLACES )[ "1.000,1.000" ] === "Old", "...and the phone's is kept", json( PLACES ) );

    await arm( c, NOTES, add( { "files/G/b.png": "phone's note" } ) );
    ok( await c.evaluate( "saveComment( 'files/G/a.png', 'note a' )" ) === true, "a note saved here" );
    ok( await raced( c ), "the phone saved a note in between" );
    const n = json( NOTES );
    ok( n && n[ "files/G/a.png" ] === "note a" && n[ "files/G/b.png" ] === "phone's note" && n[ "files/Z/x.png" ] === "note x", "notes: both kept", n );
}

//----------------------------------------------------------------------------
section( "C7 · Drive's move upkeep (media.js): notes, resume points, scan caches" );
{
    // In the Photos page, which loads media.js as Drive does.
    await arm( c, NOTES, add( { "files/G/c.png": "phone's other note" } ) );
    await c.evaluate( "NayiveMedia.remapPaths( [ [ 'files/Z/x.png', 'files/H/x.png' ] ] ).then( () => true )" );
    ok( await raced( c ), "the phone saved a note while the move re-keyed them" );
    let n = json( NOTES );
    ok( n && n[ "files/H/x.png" ] === "note x" && ! ( "files/Z/x.png" in n ), "the note followed its photo", n );
    ok( n && n[ "files/G/c.png" ] === "phone's other note" && n[ "files/G/a.png" ] === "note a", "...and the phone's note is kept", n );

    await arm( c, NOTES, add( { "files/G/d.png": "phone's copy-time note" } ) );
    await c.evaluate( "NayiveMedia.copyPaths( [ [ 'files/G/a.png', 'files/K/a.png' ] ] ).then( () => true )" );
    ok( await raced( c ), "copy: the phone saved a note in between" );
    n = json( NOTES );
    ok( n && n[ "files/K/a.png" ] === "note a" && n[ "files/G/d.png" ] === "phone's copy-time note", "copy: the note copied, the phone's kept", n );

    // Movies' resume points: a film moved while another device saves its own.
    const t = Math.floor( Date.now() / 1000 );
    await arm( c, PROG, `t => { const d = JSON.parse( t ); d.resume[ 'files/Movies/Cuatro.mp4' ] = { t: 90, d: 6000, at: ${t} }; return JSON.stringify( d ); }` );
    await c.evaluate( `NayiveMedia.remapPaths( [ [ ${JSON.stringify( FILM1 )}, 'files/Pelis/Uno (2001).mp4' ] ] ).then( () => true )` );
    ok( await raced( c ), "the phone saved a resume point while the move re-keyed them" );
    const pg = json( PROG );
    ok( pg && pg.watched[ "files/Pelis/Uno (2001).mp4" ] === true && ! pg.watched[ FILM1 ], "the film's mark followed it", pg );
    ok( pg && pg.resume[ "files/Movies/Cuatro.mp4" ], "...and the phone's resume point is kept", pg );

    // A scan cache: this page's new entry, and one another device saved in
    // between (armed after the cache's load, for its save's read).
    await c.evaluate( `( async () => { window.__race.hits = 0; const sc = NayiveMedia.scanCache( ${JSON.stringify( MSCAN )} ); await sc.load();
        window.__race.arm = { path: ${JSON.stringify( MSCAN )}, change: ${add( { "files/Music/phone.mp3": { size: 3, mtime: 3 } } )} };
        sc.set( { path: 'files/Music/mine.mp3', size: 4, mtime: 4 }, { title: 'mine' } ); await sc.saveNow(); return true; } )()` );
    ok( await raced( c ), "the phone saved a scan entry in between" );
    const sc = json( MSCAN );
    ok( sc && sc[ "files/Music/mine.mp3" ] && sc[ "files/Music/phone.mp3" ] && sc[ "files/Elsewhere/old.mp3" ], "scan cache: this page's entry and the phone's both kept", sc );
}

await done( c, s );
