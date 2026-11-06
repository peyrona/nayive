// movies.mjs - Movies on the shared item browser: a mouse picks, a
// double-click opens the film, one menu, the keys (W), "Mark watched" on a
// pick with ONE Undo (checked in progress.json), "Find poster" on a pick
// only (posters.json), the header's view buttons and the folders tree; then a
// phone: tap opens, long-press picks, Folders slides the tree in.
import { server, browser, ok, section, done, sleep, mouse, key, finger, menuRows, seed, onDisk, fitState } from "./lib.mjs";

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
const VIEW = v => `.tb-modes .btn[data-view="${v}"]`;
const NODE = id => `#tree [role=treeitem][data-id="${id}"] > .ti`;   // the row (the item holds its children too)
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
ok( await c.evaluate( "document.querySelectorAll('.tb-modes .btn').length === 3 && document.querySelector('.tb-modes .btn[data-view=movies]').getAttribute('aria-pressed') === 'true'" ), "the header holds Films / Genres / Folders, Films lit" );
ok( await c.evaluate( "getComputedStyle( document.getElementById('treePane') ).display === 'none'" ), "no panel in Films" );
await key( c, "Tab" );
ok( await c.evaluate( "! document.getElementById('tree').contains( document.activeElement )" ), "Tab does not step into the hidden tree" );
await mouse( c, CARD( UNO ) + " .poster-title" );
ok( await sel() === UNO && await c.evaluate( "! document.querySelector('.movie-detail')" ), "a click picks one film (it does not open)" );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .pick-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await mouse( c, CARD( TRES ) + " .poster-title", { mods: 2 } );
ok( ( await sel() ).split( "," ).length === 2, "Ctrl+click adds one", await sel() );
await key( c, "Escape" );
ok( await sel() === "", "Esc clears" );
await mouse( c, CARD( UNO ) + " .poster-title" );
await key( c, "a", 2 );
ok( await c.evaluate( "browse.ids().length === 3" ), "Ctrl+A picks all" );
await key( c, "Escape" );

await mouse( c, "#folderInfoBtn" );
ok( await c.until( "document.getElementById('folderMenu').matches(':popover-open')" ) && await c.evaluate( "( () => { const r = document.getElementById('folderMenu').getBoundingClientRect(), b = document.getElementById('folderInfoBtn'); return r.left >= 0 && r.right <= innerWidth && r.width > 0 && b.nextElementSibling.matches('[data-help-open]') && b.parentElement.matches('.tb-sys'); } )()" ), "the i sits before help and its popup fits the window" );
await key( c, "Escape" );

section( "MOVIES · ONE MENU" );
await mouse( c, CARD( DOS ) + " .poster-title", { button: "right" } );
let rows = await menuRows( c );
ok( await sel() === DOS && rows && [ "open", "play", "watched", "poster", "drive" ].every( a => rows.some( r => r.act === a && ! r.off ) ), "right-click: Open, Play, Mark watched, Find poster, Show in Drive", rows );
await key( c, "Escape" );
ok( await c.evaluate( "! document.querySelector('#libContent [data-more], #tree [data-more], #selActions [data-pick=menu]')" ), "no card ⋮, no tree ⋮, no ⋮ in the selection group" );
let fs = await fitState( c );
ok( fs.acts.join() === "play,watched,poster,drive" && ! fs.out.length && ! fs.more && ! fs.crowded, "wide: every action is a button, in menu order; no ⋮", fs );

section( "MOVIES · WATCHED, ONE UNDO" );
await mouse( c, CARD( UNO ) + " .poster-title" );
await mouse( c, CARD( DOS ) + " .poster-title", { mods: 2 } );
await key( c, "w" );
ok( await disk( () => json( PROG ).watched[ UNO ] && json( PROG ).watched[ DOS ] && ! json( PROG ).resume[ UNO ] ), "W marks both watched (on disk; Uno's resume point goes)", json( PROG ) );
ok( await c.until( "!! document.querySelector('#ayni-toasts .toast.undo .act')" ), "…one Undo for the lost resume point" );
await c.evaluate( "document.querySelector('#ayni-toasts .toast.undo .act').click(); true" );
ok( await disk( () => ! json( PROG ).watched[ UNO ] && json( PROG ).resume[ UNO ] && json( PROG ).resume[ UNO ].t === 600 ), "Undo: Uno not watched, back at its point", json( PROG ) );
ok( json( PROG ).watched[ DOS ], "…Dos (no point lost) stays watched" );
await c.evaluate( "browse.set( [ " + JSON.stringify( DOS ) + " ] ); true" );
await mouse( c, CARD( DOS ) + " .poster-title", { button: "right" } );
ok( ( await menuRows( c ) )?.some( r => r.act === "watched" && /not watched/.test( r.label ) ), "a watched film's menu says Mark as not watched" );
await c.evaluate( "document.querySelector('#ayni-menu [data-act=watched]').click(); true" );
ok( await disk( () => ! json( PROG ).watched[ DOS ] ), "…and un-marks it (on disk)" );

section( "MOVIES · FIND POSTER ON A PICK" );
await c.evaluate( `( () => { const f = window.fetch; window.__tmdb = [];
    window.fetch = function ( u, o ) { if( String( u ).indexOf( 'api.themoviedb.org' ) !== -1 ) { window.__tmdb.push( String( u ) );
        return Promise.resolve( new Response( JSON.stringify( { results: [ { id: 7, poster_path: '/p.jpg', title: 'T' } ] } ), { status: 200 } ) ); }
        return f.apply( this, arguments ); };
    AyniNet.fetchBinary = () => Promise.reject( new TypeError( 'blocked' ) ); return true; } )()` );
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
await mouse( c, VIEW( "folders" ) );
ok( await c.until( "st.filter === 'folders' && !! document.querySelector('#tree [role=treeitem][data-id=\"f:" + D + "/Drama\"]')" ), "Folders opens and lists the real folders" );
ok( await c.evaluate( "getComputedStyle( document.getElementById('treePane') ).display !== 'none' && document.querySelector('.tb-modes .btn[data-view=folders]').getAttribute('aria-pressed') === 'true'" ), "…the panel shows, Folders lit" );
await mouse( c, NODE( "f:" + D + "/Drama" ), { dx: 60 } );
ok( await c.until( "document.querySelectorAll('#libContent .poster-card').length === 2" ), "a folder shows its films" );
await mouse( c, VIEW( "genres" ) );
ok( await c.until( "st.filter === 'genres' && document.querySelectorAll('#libContent .genre-card').length === 2" ), "Genres shows the genres" );
ok( await c.evaluate( "getComputedStyle( document.getElementById('treePane') ).display === 'none'" ), "…the panel goes" );
await mouse( c, VIEW( "movies" ) );
await c.until( "st.filter === 'movies'" );

section( "MOVIES · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
await c.evaluate( "browse.clear(); setFilter( 'movies' ); true" );
await c.until( "document.querySelectorAll('#libContent .poster-grid .poster-card').length === 3" );
ok( await c.until( `( () => { const t = getComputedStyle( document.querySelector( '${ CARD( UNO ).replace( /'/g, "\\'" ) } .pick-tick' ) ); return t.display !== 'none' && t.opacity === '1'; } )()` ), "icons: the ticks show without a long-press" );
await finger( c, CARD( UNO ) + " .poster-title", 700 );
ok( await c.until( "browse.ids().join() === " + JSON.stringify( UNO ) ) && await c.evaluate( "document.getElementById('libContent').classList.contains('picking') && ! document.querySelector('.movie-detail')" ), "a long-press picks (ticks on), it does not open" );
fs = await fitState( c );
ok( ! fs.crowded && fs.more && [ "play", "watched" ].every( a => fs.acts.includes( a ) ) && ! fs.tools.includes( "reloadBtn" ),
    "phone header: one row; the top ranks stay, the tools leave first, the ⋮ shows", fs );
ok( fs.rows.filter( r => fs.out.includes( r ) ).join() === fs.out.join() && fs.out.join() === [ "play", "watched", "poster", "drive" ].filter( a => fs.out.includes( a ) ).join(),
    "…its ⋮ lists the hidden buttons in toolbar order (the left tools, the actions, the right tools)", fs );
await finger( c, ".topbar .fit-more" );
const mrows = await menuRows( c );
ok( mrows && mrows.some( r => r.act === "reloadBtn" ), "the ⋮ opens with them", mrows );
await finger( c, ".topbar .fit-more" );
ok( await c.until( "( ! document.querySelector('#ayni-menu')?.matches(':popover-open') )" ), "…and closes again" );
await finger( c, "#selActions [data-pick=clear]" );
ok( await c.until( "browse.ids().length === 0" ), "the × stops picking" );
await c.evaluate( "document.querySelector('" + CARD( DOS ).replace( /"/g, '\\"' ) + "').scrollIntoView( { block: 'center' } ); document.querySelectorAll( '#ayni-toasts .dismiss' ).forEach( b => b.click() ); true" );   // "1 poster added" lies over it
await finger( c, CARD( DOS ) + " .poster-title" );
ok( await c.until( "st.selectedMovie === " + JSON.stringify( DOS ) ), "a tap opens the film" );
ok( await c.evaluate( "getComputedStyle( document.getElementById('treeBtn') ).display === 'none'" ), "no tree button outside Folders" );
await finger( c, "#clearScopeBtn" );
await c.until( "! document.querySelector('.movie-detail')" );
await finger( c, VIEW( "folders" ) );
ok( await c.until( "st.filter === 'folders' && document.getElementById('treePane').classList.contains('open')" ), "Folders slides the tree in" );
await finger( c, NODE( "f:" + D + "/Drama" ) );
ok( await c.until( "st.selectedFolder === " + JSON.stringify( D + "/Drama" ) + " && ! document.getElementById('treePane').classList.contains('open')" ), "…a row shows that folder and the sheet goes" );
await finger( c, "#treeBtn" );
ok( await c.until( "document.getElementById('treePane').classList.contains('open')" ), "the tree button brings the tree back" );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
await done( c, s );
