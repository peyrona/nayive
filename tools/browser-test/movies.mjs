// movies.mjs - Movies on the shared item browser: a mouse picks, a
// double-click opens the film, one menu, the keys (W), "Mark watched" on a
// pick with ONE Undo (checked in progress.json), "Find poster" on a pick
// only (posters.json), the tree (Films, Genres, Folders); then a phone: tap
// opens, long-press picks, the tree slides in.
import { server, browser, ok, section, done, sleep, mouse, key, finger, menuRows, seed, onDisk } from "./lib.mjs";

const D = "files/Movies";
const UNO = `${D}/Drama/Uno (2001).mp4`, DOS = `${D}/Drama/Dos (2002).mp4`, TRES = `${D}/Comedy/Tres (2003).mp4`;
const PROG = "data/movies/progress.json", POSTERS = "data/movies/posters.json";
const t0 = Math.floor( Date.now() / 1000 ) - 60;

const s = await server();
seed( s, { [ UNO ]: "not really a film", [ DOS ]: "not really a film", [ TRES ]: "not really a film",
           [ PROG ]: JSON.stringify( { version: 1, watched: {}, resume: { [ UNO ]: { t: 600, d: 6000, at: t0 } } } ),
           [ POSTERS ]: JSON.stringify( { key: "K1", items: {} } ) } );
const c = await browser( s, { mouse: true } );
const CARD = p => `#libContent .poster-card[data-open="${p}"]`;
const NODE = id => `#tree .tree-row[data-id="${id}"]`;
const sel = () => c.evaluate( "browse.ids().join()" );
const json = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
async function disk( fn, ms = 8000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}

section( "MOVIES · MOUSE" );
ok( await c.open( `/nayive/movies/index.html?dir=${D}` ) && await c.until( "typeof st !== 'undefined' && st.movies.length === 3 && document.querySelectorAll('#libContent .poster-grid .poster-card').length === 3" ), "Movies lists the 3 films" );
await c.evaluate( "document.head.insertAdjacentHTML( 'beforeend', '<style>.quota-card{display:none!important}</style>' ); true" );   // the scratch disk's "space almost full" card
ok( await c.evaluate( "!! document.querySelector('#tree .tree-row[data-id=\"v:folders\"]') && ! document.getElementById('filterMovies')" ), "the tree holds Films / Genres / Folders; the old view buttons are gone" );
await mouse( c, CARD( UNO ) + " .poster-title" );
ok( await sel() === UNO && await c.evaluate( "! document.querySelector('.movie-detail')" ), "a click picks one film (it does not open)" );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .sel-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await mouse( c, CARD( TRES ) + " .poster-title", { mods: 2 } );
ok( ( await sel() ).split( "," ).length === 2, "Ctrl+click adds one", await sel() );
await key( c, "Escape" );
ok( await sel() === "", "Esc clears" );
await mouse( c, CARD( UNO ) + " .poster-title" );
await key( c, "a", 2 );
ok( await c.evaluate( "browse.ids().length === 3" ), "Ctrl+A picks all" );
await key( c, "Escape" );

section( "MOVIES · ONE MENU" );
await mouse( c, CARD( DOS ) + " .poster-title", { button: "right" } );
let rows = await menuRows( c );
ok( await sel() === DOS && rows && [ "open", "play", "watched", "poster", "drive" ].every( a => rows.some( r => r.act === a && ! r.off ) ), "right-click: Open, Play, Mark watched, Find poster, Show in Drive", rows );
await key( c, "Escape" );
await mouse( c, CARD( DOS ) + " [data-more]" );
ok( ( await menuRows( c ) )?.some( r => r.act === "watched" ), "the card's ⋮ opens the same menu" );
await key( c, "Escape" );
await mouse( c, "#selActions [data-sel=menu]" );
ok( ( await menuRows( c ) )?.some( r => r.act === "watched" ), "the header ⋮ opens the same menu" );
await key( c, "Escape" );

section( "MOVIES · WATCHED, ONE UNDO" );
await mouse( c, CARD( UNO ) + " .poster-title" );
await mouse( c, CARD( DOS ) + " .poster-title", { mods: 2 } );
await key( c, "w" );
ok( await disk( () => json( PROG ).watched[ UNO ] && json( PROG ).watched[ DOS ] && ! json( PROG ).resume[ UNO ] ), "W marks both watched (on disk; Uno's resume point goes)", json( PROG ) );
ok( await c.until( "!! document.querySelector('#toast .toast-undo')" ), "…one Undo for the lost resume point" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await disk( () => ! json( PROG ).watched[ UNO ] && json( PROG ).resume[ UNO ] && json( PROG ).resume[ UNO ].t === 600 ), "Undo: Uno not watched, back at its point", json( PROG ) );
ok( json( PROG ).watched[ DOS ], "…Dos (no point lost) stays watched" );
await c.evaluate( "browse.set( [ " + JSON.stringify( DOS ) + " ] ); true" );
await mouse( c, CARD( DOS ) + " .poster-title", { button: "right" } );
ok( ( await menuRows( c ) )?.some( r => r.act === "watched" && /not watched/.test( r.label ) ), "a watched film's menu says Mark as not watched" );
await c.evaluate( "document.querySelector('.item-menu [data-act=watched]').click(); true" );
ok( await disk( () => ! json( PROG ).watched[ DOS ] ), "…and un-marks it (on disk)" );

section( "MOVIES · FIND POSTER ON A PICK" );
await c.evaluate( `( () => { const f = window.fetch; window.__tmdb = [];
    window.fetch = function ( u, o ) { if( String( u ).indexOf( 'api.themoviedb.org' ) !== -1 ) { window.__tmdb.push( String( u ) );
        return Promise.resolve( new Response( JSON.stringify( { results: [ { id: 7, poster_path: '/p.jpg', title: 'T' } ] } ), { status: 200 } ) ); }
        return f.apply( this, arguments ); };
    GumApi.fetchBinary = () => Promise.reject( new TypeError( 'blocked' ) ); return true; } )()` );
await mouse( c, CARD( TRES ) + " .poster-title" );
await c.evaluate( "browse.run('poster'); true" );
ok( await disk( () => Object.keys( json( POSTERS ).items ).length === 1 && json( POSTERS ).items[ "tres|2003" ] ), "Find poster asks for the picked film only (posters.json)", json( POSTERS ) );
ok( await c.evaluate( "window.__tmdb.length === 1" ), "…one TMDB search" );

section( "MOVIES · OPEN AND THE TREE" );
await c.until( "document.querySelectorAll('#libContent .poster-grid .poster-card').length === 3" );
await mouse( c, CARD( DOS ) + " .poster-title", { count: 2 } );
ok( await c.until( "!! document.querySelector('.movie-detail') && st.selectedMovie === " + JSON.stringify( DOS ) ), "a double-click opens the film" );
await mouse( c, "#clearScopeBtn" );
ok( await c.until( "! document.querySelector('.movie-detail')" ), "← goes back" );
await mouse( c, CARD( TRES ) + " .poster-title" );
await key( c, "Enter" );
ok( await c.until( "st.selectedMovie === " + JSON.stringify( TRES ) ), "Enter opens the picked film" );
await mouse( c, NODE( "v:folders" ), { dx: 60 } );
ok( await c.until( "st.filter === 'folders' && !! document.querySelector('#tree .tree-row[data-id=\"f:" + D + "/Drama\"]')" ), "Folders opens and lists the real folders" );
await mouse( c, NODE( "f:" + D + "/Drama" ), { dx: 60 } );
ok( await c.until( "document.querySelectorAll('#libContent .poster-card').length === 2" ), "a folder shows its films" );
await mouse( c, NODE( "v:genres" ), { dx: 60 } );
ok( await c.until( "st.filter === 'genres' && document.querySelectorAll('#libContent .genre-card').length === 2" ), "Genres shows the genres" );
await mouse( c, NODE( "v:movies" ), { dx: 40 } );
await c.until( "st.filter === 'movies'" );

section( "MOVIES · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
await c.evaluate( "browse.clear(); setFilter( 'movies' ); true" );
await c.until( "document.querySelectorAll('#libContent .poster-grid .poster-card').length === 3" );
await finger( c, CARD( UNO ) + " .poster-title", 700 );
ok( await c.until( "browse.ids().join() === " + JSON.stringify( UNO ) ) && await c.evaluate( "document.getElementById('libContent').classList.contains('is-picking') && ! document.querySelector('.movie-detail')" ), "a long-press picks (ticks on), it does not open" );
ok( await c.evaluate( "document.querySelectorAll('#selActions [data-sel-act]').length === 2" ), "phone header: its two actions" );
await finger( c, "#selActions [data-sel=clear]" );
ok( await c.until( "browse.ids().length === 0" ), "the × stops picking" );
await c.evaluate( "document.querySelector('" + CARD( DOS ).replace( /"/g, '\\"' ) + "').scrollIntoView( { block: 'center' } ); true" );
await finger( c, CARD( DOS ) + " .poster-title" );
ok( await c.until( "st.selectedMovie === " + JSON.stringify( DOS ) ), "a tap opens the film" );
await finger( c, "#treeBtn" );
ok( await c.until( "document.getElementById('treePane').classList.contains('open')" ), "the tree button slides the tree in" );
await finger( c, NODE( "v:genres" ) );
ok( await c.until( "st.filter === 'genres' && ! document.getElementById('treePane').classList.contains('open')" ), "…a row shows that view and the sheet goes" );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
await done( c, s );
