// photos.mjs - Photos on the shared item browser: a mouse picks tiles, a
// double-click opens the photo full screen, one menu, the keys, the bin with
// Undo and no question, "Move to album…" / "Copy to album…" with the albums
// tree, a drag onto an album, the album menu (new, rename, bin, the open
// album with its Undo carried along); then a phone: tap opens, long-press
// picks, the tree slides in. Every change is checked on disk, notes too.
//
//   SHOTS=<dir> node tools/browser-test/photos.mjs    also saves screenshots
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, sleep, mouse, key, finger, drag, menuRows, seed, exists, onDisk } from "./lib.mjs";
import { REPO } from "../data-safety-test/lib.mjs";

// Real pictures: the app icon (a valid PNG, no EXIF / GPS, so nothing asks
// Nominatim), each with a few extra bytes so the sizes (thumb keys) differ.
const PNG = fs.readFileSync( path.join( REPO, "client/apps/icons/icon-192.png" ) );
const pic = n => Buffer.concat( [ PNG, Buffer.alloc( n ) ] );
const NOTES = "data/photos/comments.json";

const s = await server();
seed( s, { "data/photos/config.json": JSON.stringify( { folder: "files/Pics" } ),
           "files/Pics/Lisbon/a.png": pic( 1 ), "files/Pics/Lisbon/b.png": pic( 2 ), "files/Pics/Lisbon/c.png": pic( 3 ),
           "files/Pics/Lisbon/Tiles": null, "files/Pics/Granada/x.png": pic( 4 ), "files/Pics/Old/o.png": pic( 5 ),
           [ NOTES ]: JSON.stringify( { "files/Pics/Lisbon/a.png": "note a", "files/Pics/Lisbon/b.png": "note b", "files/Pics/Lisbon/c.png": "note c" } ) } );
const notes = () => { try { return JSON.parse( onDisk( s, NOTES ) ) || {}; } catch { return {}; } };

const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:photos', '1' ); true" );
const TILE = p => `#grid .tile[data-id="files/Pics/${p}"]`;
const TREE = p => `#tree .tree-row[data-id="files/Pics${p ? "/" + p : ""}"]`;
const sel  = () => c.evaluate( "browse.ids().join()" );
const L    = n => "files/Pics/Lisbon/" + n;
const SHOTS = process.env.SHOTS || "";
async function shot( name )
{
    if( ! SHOTS ) return;
    fs.mkdirSync( SHOTS, { recursive: true } );
    const r = await c.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
}
async function openAlbum( dir, n )
{
    ok( await c.open( "/nayive/photos/index.html?dir=" + encodeURIComponent( dir ), "/nayive/photos/index.html" ) &&
        await c.until( `typeof PHOTOS !== 'undefined' && PHOTOS.length === ${n} && document.querySelectorAll( '#grid .tile[data-id]' ).length === ${n} && !! browse`, 20000 ),
        "Photos opens " + dir + " (" + n + " photos)" );
    await c.until( "document.querySelectorAll( '#tree .tree-row' ).length > 1" );
}
const pickIn = async ( row ) => c.evaluate( `( () => { const P = '.sheet-backdrop.open .pick-tree ';
    const r = document.querySelector( P + '.tree-row[data-id="${row}"]' ); if( ! r ) return false;
    r.click(); document.querySelector( '.sheet-backdrop.open .pick-ok' ).click(); return true; } )()` );
const undo = () => c.evaluate( "( () => { const b = document.querySelector( '#toast .toast-undo' ); if( b ) b.click(); return !! b; } )()" );

section( "PHOTOS · MOUSE" );
await openAlbum( "files/Pics/Lisbon", 3 );
await mouse( c, TILE( "Lisbon/a.png" ) );
ok( await sel() === L( "a.png" ), "a click picks one tile, it does not open it", await sel() );
ok( await c.evaluate( "! document.getElementById( 'lb' ).classList.contains( 'open' )" ), "…the lightbox stays shut" );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .sel-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await mouse( c, TILE( "Lisbon/c.png" ), { mods: 8 } );
ok( await sel() === [ "a.png", "b.png", "c.png" ].map( L ).join(), "Shift+click picks the range", await sel() );
await mouse( c, TILE( "Lisbon/b.png" ), { mods: 2 } );
ok( await sel() === [ "a.png", "c.png" ].map( L ).join(), "Ctrl+click takes one out", await sel() );
ok( await c.evaluate( "document.querySelectorAll( '#grid .tile.is-selected' ).length === 2" ), "the picked tiles are painted" );
await shot( "desktop-picked" );
await key( c, "Escape" );
ok( await sel() === "" && await c.evaluate( "document.getElementById('selActions').hidden" ), "Esc clears; the group goes" );
await mouse( c, TILE( "Lisbon/a.png" ) );
await key( c, "a", 2 );
ok( await c.evaluate( "browse.ids().length === 3" ), "Ctrl+A picks all" );
await mouse( c, "#grid", { dx: 20 } );
ok( await sel() === "", "a click on empty space clears", await sel() );
await mouse( c, TILE( "Lisbon/a.png" ) );
await key( c, "ArrowRight" );
ok( await sel() === L( "b.png" ), "→ moves the pick in the grid", await sel() );
await mouse( c, TILE( "Lisbon/b.png" ), { count: 2 } );
ok( await c.until( "document.getElementById( 'lb' ).classList.contains( 'open' ) && st.lbId === " + JSON.stringify( L( "b.png" ) ) ), "a double-click opens the photo full screen" );
await key( c, "Escape" );
ok( await c.until( "! document.getElementById( 'lb' ).classList.contains( 'open' )" ) && await sel() === L( "b.png" ), "Esc closes it; the pick stays", await sel() );
await key( c, "Enter" );
ok( await c.until( "document.getElementById( 'lb' ).classList.contains( 'open' )" ), "Enter opens it too" );
await key( c, "Escape" );

section( "PHOTOS · ONE MENU" );
await mouse( c, TILE( "Lisbon/c.png" ), { button: "right" } );
let rows = await menuRows( c );
ok( await sel() === L( "c.png" ) && rows && [ "open", "edit", "share", "download", "move", "copyTo", "map", "bin" ].every( a => rows.some( r => r.act === a ) ),
    "right-click picks that tile and opens the menu with every action", rows && rows.map( r => r.act ) );
ok( rows && rows.find( r => r.act === "map" ).off, "…Show on map is grey (no place)" );
ok( await c.evaluate( "[ ...document.querySelectorAll('.item-menu .mi-key') ].some( k => k.textContent === 'Del' )" ), "…with the keys beside them" );
await shot( "desktop-menu" );
await key( c, "Escape" );
ok( await c.evaluate( "document.querySelector('.item-menu').hidden" ), "Esc closes the menu" );
await mouse( c, TILE( "Lisbon/c.png" ) + " [data-more]" );
ok( ( await menuRows( c ) )?.some( r => r.act === "move" ), "the tile ⋮ opens the same menu" );
await key( c, "Escape" );
await mouse( c, "#selActions [data-sel=menu]" );
ok( ( await menuRows( c ) )?.some( r => r.act === "move" ), "the header ⋮ opens the same menu" );
await key( c, "Escape" );
await c.evaluate( "browse.clear(); true" );
await mouse( c, "#grid", { dx: 20, button: "right" } );
rows = await menuRows( c );
ok( rows && [ "upload", "newAlbum", "selectAll" ].every( a => rows.some( r => r.act === a ) ), "right-click on empty space: Upload, New album, Select all", rows && rows.map( r => r.act ) );
await key( c, "Escape" );

section( "PHOTOS · KEYS" );
await c.evaluate( "window.__opened = null; window.open = u => { window.__opened = String( u ); return null; }; true" );
await mouse( c, TILE( "Lisbon/a.png" ) );
await key( c, "e" );
ok( await c.until( "( window.__opened || '' ).indexOf( 'image/index.html?file=' + encodeURIComponent( " + JSON.stringify( L( "a.png" ) ) + " ) ) !== -1" ), "E edits the photo in Image", await c.evaluate( "window.__opened" ) );

section( "PHOTOS · BIN, NO QUESTION" );
await mouse( c, TILE( "Lisbon/c.png" ) );
await key( c, "Delete" );
ok( await c.until( "! document.querySelector( '" + TILE( "Lisbon/c.png" ) + "' )" ) && ! exists( s, L( "c.png" ) ), "Del: to the bin at once" );
ok( await c.evaluate( "! document.querySelector( '.sheet-backdrop.open' )" ) && await c.until( "!! document.querySelector( '#toast .toast-undo' )" ), "…no question, an Undo" );
ok( notes()[ L( "c.png" ) ] === "note c", "…its note is kept for a restore", notes() );
ok( await undo(), "Undo pressed" );
ok( await c.until( "!! document.querySelector( '" + TILE( "Lisbon/c.png" ) + "' )" ) && exists( s, L( "c.png" ) ) && notes()[ L( "c.png" ) ] === "note c", "Undo brings it back, with its note" );

section( "PHOTOS · MOVE / COPY TO ALBUM, AND DRAG" );
await mouse( c, TILE( "Lisbon/a.png" ) );
await c.evaluate( "browse.run( 'move' ); true" );
ok( await c.until( "!! document.querySelector( '.sheet-backdrop.open .pick-tree .tree-row' )" ), "Move to album… shows the albums tree" );
ok( await c.evaluate( "document.querySelector( '.sheet-backdrop.open .pick-tree .tree-row[data-id=\"files/Pics/Lisbon\"]' ).classList.contains( 'is-off' )" ), "…the album it is in is off" );
await shot( "desktop-move" );
ok( await pickIn( "files/Pics/Granada" ), "Granada picked" );
ok( await c.until( "! document.querySelector( '" + TILE( "Lisbon/a.png" ) + "' )" ) && exists( s, "files/Pics/Granada/a.png" ) && ! exists( s, L( "a.png" ) ), "…and moved there" );
ok( await c.until( "PHOTOS.length === 2" ) && notes()[ "files/Pics/Granada/a.png" ] === "note a" && ! notes()[ L( "a.png" ) ], "…its note followed it", notes() );
ok( await undo(), "Undo pressed" );
ok( await c.until( "!! document.querySelector( '" + TILE( "Lisbon/a.png" ) + "' )" ) && exists( s, L( "a.png" ) ) && ! exists( s, "files/Pics/Granada/a.png" ), "Undo moves it back" );
ok( notes()[ L( "a.png" ) ] === "note a" && ! notes()[ "files/Pics/Granada/a.png" ], "…note too", notes() );

await mouse( c, TILE( "Lisbon/b.png" ) );
await c.evaluate( "browse.run( 'copyTo' ); true" );
await c.until( "!! document.querySelector( '.sheet-backdrop.open .pick-tree .tree-row[data-id=\"files/Pics/Lisbon/Tiles\"]' ) || !! document.querySelector( '.sheet-backdrop.open .pick-tree .tree-row[data-id=\"files/Pics/Lisbon\"]' )" );
await c.evaluate( `( () => { const r = document.querySelector( '.sheet-backdrop.open .pick-tree .tree-row[data-id="files/Pics/Lisbon"]' );
    if( r && r.getAttribute( 'aria-expanded' ) !== 'true' ) r.querySelector( '[data-twisty]' ).click(); return true; } )()` );
ok( await pickIn( "files/Pics/Lisbon/Tiles" ), "Copy to album…: Tiles picked" );
ok( await c.until( "( window.__toasts || [] ).some( t => /copied/.test( t ) )" ) && exists( s, "files/Pics/Lisbon/Tiles/b.png" ) && exists( s, L( "b.png" ) ), "…a copy is there, the photo stays" );

await c.until( "! document.querySelector( '.sheet-backdrop.open' )" );
const lit = await drag( c, TILE( "Lisbon/b.png" ), TREE( "Granada" ) );
ok( lit === true && await c.until( "! document.querySelector( '" + TILE( "Lisbon/b.png" ) + "' )" ) && exists( s, "files/Pics/Granada/b.png" ) && ! exists( s, L( "b.png" ) ),
    "a tile dragged onto an album moves it (album lit)", lit );
ok( notes()[ "files/Pics/Granada/b.png" ] === "note b" && ! notes()[ L( "b.png" ) ], "…its note followed it", notes() );

section( "PHOTOS · THE ALBUMS TREE" );
ok( await c.evaluate( "document.querySelector( '" + TREE( "Lisbon" ) + "' ).classList.contains( 'is-active' )" ), "the open album is lit in the tree" );
await mouse( c, TREE( "" ), { button: "right", dx: 40 } );
rows = await menuRows( c );
ok( rows && rows.find( r => r.act === "newAlbum" && ! r.off ) && rows.find( r => r.act === "bin" ).off && rows.find( r => r.act === "rename" ).off, "the top album: New album only", rows );
await key( c, "Escape" );
await mouse( c, TREE( "Old" ), { button: "right", dx: 40 } );
rows = await menuRows( c );
ok( rows && [ "newAlbum", "rename", "move", "bin" ].every( a => rows.some( r => r.act === a && ! r.off ) ), "an album's right-click: New album, Rename, Move to…, To the bin", rows );
await shot( "desktop-tree-menu" );
await c.evaluate( "document.querySelector( '.item-menu [data-act=bin]' ).click(); true" );
ok( await c.until( "! document.querySelector( '" + TREE( "Old" ) + "' )" ) && ! exists( s, "files/Pics/Old" ) && await c.evaluate( "! document.querySelector( '.sheet-backdrop.open' )" ), "an album goes to the bin at once" );
ok( await undo(), "Undo pressed" );
ok( await c.until( "!! document.querySelector( '" + TREE( "Old" ) + "' )", 8000 ) && exists( s, "files/Pics/Old/o.png" ), "…and comes back" );

await mouse( c, "#grid", { dx: 20, button: "right" } );
await c.evaluate( "document.querySelector( '.item-menu [data-act=newAlbum]' ).click(); true" );
ok( await c.until( "!! document.querySelector( '.sheet-backdrop.open input' )" ), "New album asks a name" );
await c.evaluate( "document.querySelector( '.sheet-backdrop.open input' ).value = 'Summer'; document.querySelector( '.sheet-backdrop.open .name-ok' ).click(); true" );
ok( await c.until( "!! document.querySelector( '" + TREE( "Lisbon/Summer" ) + "' )" ) && exists( s, "files/Pics/Lisbon/Summer" ), "…and makes it inside the open album" );

await mouse( c, TREE( "Granada" ), { button: "right", dx: 40 } );
await c.evaluate( "document.querySelector( '.item-menu [data-act=rename]' ).click(); true" );
await c.until( "!! document.querySelector( '.sheet-backdrop.open input' )" );
await c.evaluate( "document.querySelector( '.sheet-backdrop.open input' ).value = 'Alhambra'; document.querySelector( '.sheet-backdrop.open .name-ok' ).click(); true" );
ok( await c.until( "!! document.querySelector( '" + TREE( "Alhambra" ) + "' )" ) && exists( s, "files/Pics/Alhambra/x.png" ) && ! exists( s, "files/Pics/Granada" ), "Rename an album" );
ok( notes()[ "files/Pics/Alhambra/b.png" ] === "note b" && Object.keys( notes() ).every( k => k.indexOf( "files/Pics/Granada/" ) !== 0 ), "…the notes of its photos follow the new name", notes() );

const dragAlbum = await drag( c, TREE( "Old" ), TREE( "Alhambra" ) );
ok( dragAlbum === true && await c.until( "!! document.querySelector( '" + TREE( "" ) + "' ) && ! document.querySelector( '" + TREE( "Old" ) + "' )" ) && exists( s, "files/Pics/Alhambra/Old/o.png" ), "an album dragged onto another moves into it", dragAlbum );

section( "PHOTOS · THE OPEN ALBUM GOES TO THE BIN" );
await mouse( c, TREE( "Lisbon" ), { button: "right", dx: 40 } );
await c.evaluate( "document.querySelector( '.item-menu [data-act=bin]' ).click(); true" );
ok( await c.until( "new URLSearchParams( location.search ).get( 'dir' ) === 'files/Pics' && typeof albumIndexShown !== 'undefined' && albumIndexShown", 20000 ) && ! exists( s, "files/Pics/Lisbon" ), "binning the open album opens the one above it" );
ok( await c.until( "!! document.querySelector( '#toast .toast-undo' )" ), "…its Undo came along" );
ok( notes()[ L( "a.png" ) ] === "note a", "…the notes of its photos are kept", notes() );
ok( await undo(), "Undo pressed" );
ok( await c.until( "new URLSearchParams( location.search ).get( 'dir' ) === 'files/Pics/Lisbon' && typeof PHOTOS !== 'undefined' && PHOTOS.length === 2", 20000 ) && exists( s, L( "a.png" ) ) && exists( s, L( "c.png" ) ),
    "Undo brings the album back and opens it" );
await mouse( c, TREE( "Lisbon" ), { button: "right", dx: 40 } );
await c.evaluate( "document.querySelector( '.item-menu [data-act=rename]' ).click(); true" );
await c.until( "!! document.querySelector( '.sheet-backdrop.open input' )" );
await c.evaluate( "document.querySelector( '.sheet-backdrop.open input' ).value = 'Lisboa'; document.querySelector( '.sheet-backdrop.open .name-ok' ).click(); true" );
ok( await c.until( "new URLSearchParams( location.search ).get( 'dir' ) === 'files/Pics/Lisboa' && typeof PHOTOS !== 'undefined' && PHOTOS.length === 2", 20000 ) && exists( s, "files/Pics/Lisboa/a.png" ),
    "renaming the open album opens it under its new name" );
ok( notes()[ "files/Pics/Lisboa/a.png" ] === "note a", "…its notes follow", notes() );
ok( await c.until( "!! document.querySelector( '#toast .toast-undo' )" ) && await undo(), "…its Undo came along, pressed" );
ok( await c.until( "new URLSearchParams( location.search ).get( 'dir' ) === 'files/Pics/Lisbon' && typeof PHOTOS !== 'undefined' && PHOTOS.length === 2", 20000 ) &&
    exists( s, L( "a.png" ) ) && ! exists( s, "files/Pics/Lisboa" ) && notes()[ L( "a.png" ) ] === "note a", "Undo puts the old name back and opens it" );
await mouse( c, TREE( "Alhambra" ), { dx: 60 } );
ok( await c.until( "new URLSearchParams( location.search ).get( 'dir' ) === 'files/Pics/Alhambra' && typeof PHOTOS !== 'undefined' && PHOTOS.length === 2", 20000 ), "a click on an album opens it" );
ok( await c.until( "!! document.querySelector( '" + TREE( "Lisbon" ) + "' )" ), "…the tree keeps its top" );

section( "PHOTOS · LIST VIEW" );
await c.evaluate( "setMode( 'lista' ); true" );
const order = await c.evaluate( "[ ...document.querySelectorAll( '#grid .tile[data-id]' ) ].map( t => t.dataset.id )" );
await mouse( c, `#grid .tile[data-id="${order[ 0 ]}"]`, { dx: 200 } );
ok( await sel() === order[ 0 ], "a click picks a row in the list view" );
await key( c, "ArrowDown" );
ok( await sel() === order[ 1 ], "↓ moves the pick", [ await sel(), order ] );
await shot( "desktop-list" );
await c.evaluate( "browse.clear(); setMode( 'grid' ); true" );

section( "PHOTOS · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
await openAlbum( "files/Pics/Lisbon", 2 );
await finger( c, TILE( "Lisbon/a.png" ) );
ok( await c.until( "document.getElementById( 'lb' ).classList.contains( 'open' )" ), "a tap opens the photo" );
await finger( c, "#lbX" );
await c.until( "! document.getElementById( 'lb' ).classList.contains( 'open' )" );
await finger( c, TILE( "Lisbon/a.png" ), 700 );
ok( await c.until( "browse.ids().join() === " + JSON.stringify( L( "a.png" ) ) ) && await c.evaluate( "document.getElementById( 'grid' ).classList.contains( 'is-picking' ) && ! document.getElementById( 'lb' ).classList.contains( 'open' )" ),
    "a long-press picks (ticks on), it does not open" );
await finger( c, TILE( "Lisbon/c.png" ) );
ok( await sel() === [ "a.png", "c.png" ].map( L ).join(), "…then a tap adds", await sel() );
ok( await c.evaluate( "document.querySelectorAll( '#selActions [data-sel-act]' ).length === 3 && getComputedStyle( document.querySelector( '.topbar-actions > .tb-group:not(.sel-group)' ) ).display === 'none'" ),
    "phone header: × count, Select all, three actions, ⋮; the tools step aside",
    await c.evaluate( "[ document.querySelectorAll( '#selActions [data-sel-act]' ).length, getComputedStyle( document.querySelector( '.topbar-actions > .tb-group:not(.sel-group)' ) ).display ]" ) );
await shot( "phone-picking" );
await finger( c, "#selActions [data-sel=clear]" );
ok( await c.until( "browse.ids().length === 0 && ! document.getElementById( 'grid' ).classList.contains( 'is-picking' )" ), "the × stops picking" );
await finger( c, "#treeBtn" );
ok( await c.until( "document.getElementById( 'treePane' ).classList.contains( 'open' )" ), "the folder button slides the albums tree in" );
await sleep( 300 );
await shot( "phone-tree" );
await finger( c, TREE( "Alhambra" ) );
ok( await c.until( "new URLSearchParams( location.search ).get( 'dir' ) === 'files/Pics/Alhambra'", 20000 ), "a tap on an album opens it" );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
await done( c, s );
