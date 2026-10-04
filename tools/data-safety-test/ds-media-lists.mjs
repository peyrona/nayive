// ds-media-lists.mjs - the media apps' shared lists are never saved WHOLE
// from the copy a page read at start-up: another device's change stays.
// Real Music / Movies / Photos in Chromium, a second "device" over HTTP; the
// outside services (TMDB, Nominatim) are stubbed in the page.
//
// A4 (list-apps #5): Music: "Save list", a delete and its Undo each re-read
//     playlists.json and apply only their own change (by id).
// A7 (list-apps #30, #31, #32): Movies' posters.json (items + TMDB key),
//     Photos' places.json, Movies' progress.json (the newer per film wins).
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep, REPO } from "./lib.mjs";

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

const LISTS   = "data/music/playlists.json";
const POSTERS = "data/movies/posters.json";
const PROG    = "data/movies/progress.json";
const PLACES  = "data/photos/places.json";
const FILM1 = "files/Movies/Uno (2001).mp4", FILM2 = "files/Movies/Dos (2002).mp4";

// Before the browser reads anything, so straight to disk is safe.
seed( "files/Music/song.mp3", "not really a song" );
seed( LISTS, JSON.stringify( [ { id: "plA", name: "A", paths: [ "files/Music/song.mp3" ] } ] ) );
seed( FILM1, "not really a film" );
seed( FILM2, "not really a film" );
seed( POSTERS, JSON.stringify( { key: "K1", items: {} } ) );
seed( "files/G/a.png", PNG );

const c = await browser( s );
const phone = await s.client();
const put = async ( rel, obj ) => { const r = await phone.put( rel, JSON.stringify( obj ) ); if( r.status !== 200 ) throw new Error( "phone " + rel + ": " + r.status ); };
const undo = () => c.evaluate( "( () => { const b = document.querySelector( '#toast .toast-undo' ); if( b ) b.click(); return !! b; } )()" );
const ids = () => ( json( LISTS ) || [] ).map( p => p.id ).sort().join( "," );

//----------------------------------------------------------------------------
section( "A4 - Music: a list saved on the phone is not dropped" );

ok( await c.open( "/nayive/music/index.html?dir=files/Music" ), "Music opens" );
ok( await c.until( "typeof st !== 'undefined' && st.playlists.length === 1" ), "Music read its one list" );
await put( LISTS, [ { id: "plA", name: "A", paths: [] }, { id: "plB", name: "B", paths: [] } ] );

await c.evaluate( `( () => { st.queue = [ { song: { path: 'files/Music/song.mp3', title: 'song' } } ]; openSaveSheet();
                             document.getElementById( 'playlistName' ).value = 'C'; return true; } )()` );
await c.evaluate( "confirmName().then( () => true )" );
ok( await disk( () => ( json( LISTS ) || [] ).some( p => p.name === "C" ) ), "Save list: C is on the server" );
ok( ids().split( "," ).length === 3 && ids().includes( "plA" ) && ids().includes( "plB" ), "Save list: the phone's B is still there", json( LISTS ) );

await c.evaluate( "deletePlaylist( 'plA' ).then( () => true )" );
ok( await disk( () => ! ids().includes( "plA" ) ), "delete: A is gone" );
ok( ids().includes( "plB" ) && ( json( LISTS ) || [] ).some( p => p.name === "C" ), "delete: B and C stay", json( LISTS ) );
const now = json( LISTS );
await put( LISTS, now.concat( [ { id: "plD", name: "D", paths: [] } ] ) );
ok( await undo(), "the delete's Undo pressed" );
ok( await disk( () => ids().includes( "plA" ) ), "Undo: A is back" );
ok( ids().includes( "plB" ) && ids().includes( "plD" ) && ( json( LISTS ) || [] ).some( p => p.name === "C" ),
    "Undo: the phone's D (saved after the delete) stays", json( LISTS ) );

// "Save list" whose write is reported failed (it did land: the answer was
// lost on the way back - GumApi PUTs with XMLHttpRequest): the sheet stays
// open with the name typed, and ✓ again saves ONE list, not two.
await c.evaluate( `( () => { window.__lie = true; const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function ( m, u ) { this.__lie = m === 'PUT' && String( u ).indexOf( 'playlists.json' ) !== -1; return open.apply( this, arguments ); };
    XMLHttpRequest.prototype.send = function () { const x = this;
        if( x.__lie && window.__lie ) x.onload = function () { if( x.onerror ) x.onerror(); };
        return send.apply( this, arguments ); };
    openSaveSheet(); document.getElementById( 'playlistName' ).value = 'E'; return true; } )()` );
await c.evaluate( "window.__toasts = []; confirmName().then( () => true )" );
ok( await c.evaluate( "( window.__toasts || [] ).some( t => t.indexOf( NayiveUI.t( 'music.listSaveFailed' ) ) !== -1 )" ), "the failed save is said", await c.toasts() );
ok( await c.evaluate( "document.getElementById( 'saveBackdrop' ).classList.contains( 'open' ) && document.getElementById( 'playlistName' ).value === 'E'" ),
    "the sheet stays open, the name kept" );
await c.evaluate( "window.__lie = false; confirmName().then( () => true )" );
ok( await c.evaluate( "! document.getElementById( 'saveBackdrop' ).classList.contains( 'open' )" ), "✓ again: saved, the sheet closes" );
ok( ( json( LISTS ) || [] ).filter( p => p.name === "E" ).length === 1, "one list E, not two", json( LISTS ) );

//----------------------------------------------------------------------------
section( "A7 - Movies: posters.json keeps the other device's posters and key" );

ok( await c.open( "/nayive/movies/index.html?dir=files/Movies" ), "Movies opens" );
ok( await c.until( "typeof st !== 'undefined' && st.movies.length === 2 && st.posters.key === 'K1'" ), "Movies listed 2 films, key K1" );
// TMDB answers one poster per film; its image cannot be fetched (the remote URL is kept).
await c.evaluate( `( () => { const f = window.fetch;
    window.fetch = function ( u, o ) { if( String( u ).indexOf( 'api.themoviedb.org' ) !== -1 )
        return Promise.resolve( new Response( JSON.stringify( { results: [ { id: 7, poster_path: '/p.jpg', title: 'T' } ] } ), { status: 200 } ) );
        return f.apply( this, arguments ); };
    GumApi.fetchBinary = () => Promise.reject( new TypeError( 'blocked' ) ); return true; } )()` );
await put( POSTERS, { key: "K2", items: { "otra|1999": { tmdb: null } } } );
await c.evaluate( "fetchPosters().then( () => true )" );
let po = json( POSTERS );
ok( po && Object.keys( po.items ).length === 3, "posters: both films' posters saved", po );
ok( po && po.items[ "otra|1999" ] && po.key === "K2", "posters: the phone's poster and its new key stay", po );

await put( POSTERS, Object.assign( {}, po, { items: Object.assign( {}, po.items, { "tercera|2000": { tmdb: null } } ) } ) );
await c.evaluate( `( () => { openTmdbKeySheet(); document.getElementById( 'tmdbKey' ).value = 'K3';
                             document.getElementById( 'tmdbSaveBtn' ).click(); return true; } )()` );
ok( await disk( () => json( POSTERS ).key === "K3" ), "the key typed here is saved" );
ok( json( POSTERS ).items[ "tercera|2000" ] && json( POSTERS ).items[ "otra|1999" ], "...and the phone's posters stay", json( POSTERS ) );

//----------------------------------------------------------------------------
section( "A7 - Movies: progress.json, the newer per film wins" );

const t = Math.floor( Date.now() / 1000 );
// Film 1: the phone stopped at 10:00 an hour AFTER this page's tap (a clock
// ahead stands for "later"). Film 2: the phone's point is an hour old.
await put( PROG, { version: 1, watched: {}, resume: { [ FILM1 ]: { t: 600, d: 6000, at: t + 3600 },
                                                       [ FILM2 ]: { t: 900, d: 6000, at: t - 3600 } } } );
await c.evaluate( `( () => { const m1 = st.movies.find( m => m.path === ${JSON.stringify( FILM1 )} ),
                                   m2 = st.movies.find( m => m.path === ${JSON.stringify( FILM2 )} );
                             toggleWatched( m1 ); toggleWatched( m2 ); return st.progSaving.then( () => true ); } )()` );
ok( await disk( () => json( PROG ).watched[ FILM2 ] === true ), "film 2 marked watched (this page's change is the newer)" );
const pg = json( PROG );
ok( ! pg.resume[ FILM2 ], "film 2: its older resume point is dropped", pg );
ok( pg.resume[ FILM1 ] && pg.resume[ FILM1 ].t === 600 && ! pg.watched[ FILM1 ], "film 1: the phone's NEWER resume point stays", pg );

//----------------------------------------------------------------------------
section( "A7 - Photos: places.json keeps the places another device found" );

ok( await c.open( "/nayive/photos/index.html?dir=files/G" ), "Photos opens" );
ok( await c.until( "typeof st !== 'undefined' && st.geoReady === true && PHOTOS.length === 1" ), "Photos scanned (no GPS: no places asked)" );
// Nominatim: the first place answers at once, the second waits for __go2.
await c.evaluate( `( () => { window.__go2 = false; let n = 0; const f = window.fetch;
    window.fetch = function ( u, o ) { if( String( u ).indexOf( 'nominatim' ) === -1 ) return f.apply( this, arguments );
        const name = ++n === 1 ? 'Uno' : 'Dos';
        const answer = () => new Response( JSON.stringify( { address: { city: name } } ), { status: 200 } );
        if( name === 'Uno' ) return Promise.resolve( answer() );
        return new Promise( r => { const t = setInterval( () => { if( window.__go2 ) { clearInterval( t ); r( answer() ); } }, 50 ); } ); };
    CLUSTERS = [ { lat: 10, lon: 20, items: [] }, { lat: 30, lon: 40, items: [] } ];
    geocode(); return true; } )()` );
ok( await disk( () => json( PLACES ) && json( PLACES )[ "10.000,20.000" ] === "Uno" ), "first place saved" );
await put( PLACES, Object.assign( {}, json( PLACES ), { "50.000,60.000": "Phone" } ) );
await c.evaluate( "window.__go2 = true" );
ok( await disk( () => json( PLACES ) && json( PLACES )[ "30.000,40.000" ] === "Dos" ), "second place saved" );
ok( json( PLACES )[ "50.000,60.000" ] === "Phone" && json( PLACES )[ "10.000,20.000" ] === "Uno", "the phone's place is kept", json( PLACES ) );

await done( c, s );
