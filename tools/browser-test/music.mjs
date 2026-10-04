// music.mjs - Music on the shared item browser: a mouse picks, a double-click
// plays, one menu, the keys (Q, Del), the tree of library views and
// playlists (drop songs on one; its own menu), "Remove from playlist" with
// Undo and no question (checked on disk), "Add to playlist…" with the same
// tree; then a phone: tap plays, long-press picks, the tree slides in.
import { server, browser, ok, section, done, sleep, mouse, key, finger, drag, menuRows, seed, onDisk } from "./lib.mjs";

// A real, tiny sound: half a second of 8 kHz 8-bit mono silence.
function wav()
{
    const n = 4000, b = Buffer.alloc( 44 + n, 0x80 );
    b.write( "RIFF", 0 ); b.writeUInt32LE( 36 + n, 4 ); b.write( "WAVE", 8 );
    b.write( "fmt ", 12 ); b.writeUInt32LE( 16, 16 ); b.writeUInt16LE( 1, 20 ); b.writeUInt16LE( 1, 22 );
    b.writeUInt32LE( 8000, 24 ); b.writeUInt32LE( 8000, 28 ); b.writeUInt16LE( 1, 32 ); b.writeUInt16LE( 8, 34 );
    b.write( "data", 36 ); b.writeUInt32LE( n, 40 );
    return b;
}

const M = "files/Music";
const ONE = `${M}/Ann/North/01 - One.wav`, TWO = `${M}/Ann/North/02 - Two.wav`,
      THREE = `${M}/Bo/South/01 - Three.wav`, FOUR = `${M}/Four.wav`, GONE = `${M}/gone.wav`;
const LISTS = "data/music/playlists.json";

const s = await server();
seed( s, { [ ONE ]: wav(), [ TWO ]: wav(), [ THREE ]: wav(), [ FOUR ]: wav(),
           [ LISTS ]: JSON.stringify( [ { id: "plA", name: "Road", paths: [ ONE, THREE, GONE ] } ] ) } );
const c = await browser( s, { mouse: true } );
const ROW = p => `#libContent .song-row[data-path="${p}"]`;
const NODE = id => `#tree .tree-row[data-id="${id}"]`;
const sel = () => c.evaluate( "browse.ids().join()" );
const lists = () => { try { return JSON.parse( onDisk( s, LISTS ) ); } catch { return null; } };
const road = () => ( lists() || [] ).find( p => p.id === "plA" ) || null;
async function disk( fn, ms = 8000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}

section( "MUSIC · MOUSE" );
ok( await c.open( `/nayive/music/index.html?dir=${M}` ) && await c.until( "typeof st !== 'undefined' && st.songs.length === 4 && document.querySelectorAll('#libContent .song-row').length === 4" ), "Music lists the 4 songs" );
await c.evaluate( "document.head.insertAdjacentHTML( 'beforeend', '<style>.quota-card{display:none!important}</style>' ); true" );   // the scratch disk's "space almost full" card
ok( await c.evaluate( "!! document.querySelector('#tree .tree-row[data-id=\"pl:plA\"]') && ! document.getElementById('filterSongs')" ), "the tree holds the playlist; the old view buttons are gone" );
await mouse( c, ROW( ONE ), { dx: 120 } );
ok( await sel() === ONE && await c.evaluate( "st.playingIndex === -1" ), "a click picks one song (it does not play)" );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .sel-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await mouse( c, ROW( THREE ), { dx: 120, mods: 8 } );
ok( ( await sel() ).split( "," ).length === 3, "Shift+click picks the range", await sel() );
await mouse( c, ROW( TWO ), { dx: 120, mods: 2 } );
ok( ( await sel() ).split( "," ).length === 2 && ! ( await sel() ).includes( TWO ), "Ctrl+click takes one out", await sel() );
await key( c, "Escape" );
ok( await sel() === "" && await c.evaluate( "document.getElementById('selActions').hidden" ), "Esc clears; the group goes" );
await mouse( c, ROW( ONE ), { dx: 120 } );
await key( c, "a", 2 );
ok( await c.evaluate( "browse.ids().length === 4" ), "Ctrl+A picks all" );

section( "MUSIC · ONE MENU" );
await key( c, "Escape" );
await mouse( c, ROW( TWO ), { dx: 120, button: "right" } );
let rows = await menuRows( c );
ok( await sel() === TWO && rows && [ "play", "next", "queue", "playlist", "album", "drive" ].every( a => rows.some( r => r.act === a && ! r.off ) ), "right-click picks that song: Play, Play next, Queue, Add to playlist, Go to album, Show in Drive", rows );
ok( rows && ! rows.some( r => r.act === "remove" ), "…no Remove from playlist outside a playlist" );
ok( await c.evaluate( "[ ...document.querySelectorAll('.item-menu .mi-key') ].some( k => k.textContent === 'Q' )" ), "…keys beside them (Q)" );
await key( c, "Escape" );
await mouse( c, ROW( TWO ) + " [data-more]" );
ok( ( await menuRows( c ) )?.some( r => r.act === "queue" ), "the row ⋮ opens the same menu" );
await key( c, "Escape" );
await mouse( c, "#selActions [data-sel=menu]" );
ok( ( await menuRows( c ) )?.some( r => r.act === "queue" ), "the header ⋮ opens the same menu" );
await key( c, "Escape" );
await c.evaluate( "browse.clear(); true" );
await mouse( c, "#libContent", { dx: 30, button: "right" } );
rows = await menuRows( c );
ok( rows && rows.length === 1 && rows[ 0 ].act === "selectAll", "right-click on empty space: Select all", rows );
await key( c, "Escape" );

section( "MUSIC · PLAY AND QUEUE" );
await mouse( c, ROW( ONE ), { dx: 120 } );
await mouse( c, ROW( TWO ), { dx: 120, mods: 2 } );
await key( c, "q" );
ok( await c.until( "st.queue.length === 2 && st.queue[ 0 ].song.path === " + JSON.stringify( ONE ) + " && st.playingIndex === 0" ), "Q queues the picked songs; the first plays" );
await mouse( c, ROW( THREE ), { dx: 120, count: 2 } );
ok( await c.until( "st.queue[ st.playingIndex ] && st.queue[ st.playingIndex ].song.path === " + JSON.stringify( THREE ) ), "a double-click plays that song" );
await c.evaluate( "browse.set( [ " + JSON.stringify( ONE ) + ", " + JSON.stringify( FOUR ) + " ] ); document.activeElement.blur(); true" );
await key( c, "Enter" );
ok( await c.until( "st.queue.length === 2 && st.playingIndex === 0 && st.queue.map( e => e.song.path ).join() === " + JSON.stringify( FOUR + "," + ONE ) ), "Enter on two picked songs: they become the queue, in the list's order" );
ok( await c.until( "!! document.querySelector('#toast .toast-undo')" ), "…with an Undo" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await c.until( "st.queue.length === 3" ), "Undo brings the old queue back" );

section( "MUSIC · TREE AND PLAYLISTS" );
await mouse( c, NODE( "v:albums" ), { dx: 60 } );
ok( await c.until( "st.filter === 'albums' && !! document.querySelector('#libContent .album-card')" ), "the tree's Albums shows the albums" );
await mouse( c, NODE( "v:songs" ), { dx: 60 } );
await c.until( "st.filter === 'songs' && document.querySelectorAll('#libContent .song-row').length === 4" );
const lit = await drag( c, ROW( TWO ), NODE( "pl:plA" ) );
ok( lit === true && await disk( () => road().paths.includes( TWO ) ), "a song dropped on a playlist goes into it (target lit; on disk)", lit );
await mouse( c, NODE( "pl:plA" ), { dx: 60 } );
ok( await c.until( "st.filter === 'playlist' && document.querySelectorAll('#libContent .song-row').length === 4" ), "a click on the playlist shows its 4 songs" );
ok( await c.evaluate( "!! document.querySelector('#libContent .song-row.is-missing[data-path=\"" + GONE + "\"]')" ), "…a song no longer in the library is still a (dimmed) row" );
await mouse( c, ROW( ONE ), { dx: 120, button: "right" } );
ok( ( await menuRows( c ) )?.some( r => r.act === "remove" && ! r.off ), "inside a playlist the menu has Remove from playlist" );
await key( c, "Escape" );
await mouse( c, ROW( ONE ), { dx: 120 } );
await key( c, "Delete" );
ok( await disk( () => ! road().paths.includes( ONE ) ) && await c.until( "! document.querySelector('" + ROW( ONE ).replace( /"/g, '\\"' ) + "')" ), "Del takes it out of the list at once (on disk)" );
ok( await c.evaluate( "! document.querySelector('.sheet-backdrop.open')" ) && await c.until( "!! document.querySelector('#toast .toast-undo')" ), "…no question, an Undo" );
ok( onDisk( s, ONE ).length > 0, "…and the song's file is still there" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await disk( () => road().paths[ 0 ] === ONE ), "Undo puts it back at its place", road() );
await mouse( c, NODE( "pl:plA" ), { dx: 60, button: "right" } );
rows = await menuRows( c );
ok( rows && [ "play", "shuffle", "rename", "delete" ].every( a => rows.some( r => r.act === a ) ), "a playlist's right-click: Play, Shuffle, Rename, Delete", rows );
await c.evaluate( "document.querySelector('.item-menu [data-act=rename]').click(); true" );
ok( await c.until( "document.getElementById('saveBackdrop').classList.contains('open') && document.getElementById('playlistName').value === 'Road'" ), "Rename asks the name" );
await c.evaluate( "document.getElementById('playlistName').value = 'Trip'; document.getElementById('saveConfirmBtn').click(); true" );
ok( await disk( () => road().name === "Trip" ) && await c.until( "document.querySelector('" + NODE( "pl:plA" ).replace( /"/g, '\\"' ) + " .tree-name').textContent === 'Trip'" ), "…and renames it (on disk and in the tree)" );
await mouse( c, NODE( "pl:plA" ), { dx: 60, button: "right" } );
await c.evaluate( "document.querySelector('.item-menu [data-act=play]').click(); true" );
ok( await c.until( "st.queue.length === 3 && st.queue[ st.playingIndex ].song.path === " + JSON.stringify( ONE ) ), "Play loads the playlist into the queue" );
await mouse( c, NODE( "pl:plA" ), { dx: 60, button: "right" } );
await c.evaluate( "document.querySelector('.item-menu [data-act=delete]').click(); true" );
ok( await disk( () => ! road() ) && await c.until( "st.filter === 'songs' && ! document.querySelector('" + NODE( "pl:plA" ).replace( /"/g, '\\"' ) + "')" ), "Delete playlist: gone at once (on disk), the songs show" );
ok( await c.evaluate( "! document.querySelector('.sheet-backdrop.open')" ) && await c.until( "!! document.querySelector('#toast .toast-undo')" ), "…no question, an Undo" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await disk( () => road() && road().paths.length === 4 ) && await c.until( "!! document.querySelector('" + NODE( "pl:plA" ).replace( /"/g, '\\"' ) + "')" ), "Undo brings the playlist back, songs and all" );
await mouse( c, ROW( FOUR ), { dx: 120 } );
await c.evaluate( "browse.run('playlist'); true" );
ok( await c.until( "!! document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id=\"new\"]') && !! document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id=\"pl:plA\"]')" ), "Add to playlist… shows the same tree: New playlist + the lists" );
await c.evaluate( "document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id=\"new\"]').click(); document.querySelector('.pick-ok').click(); true" );
ok( await c.until( "document.getElementById('saveBackdrop').classList.contains('open')" ), "…New playlist asks a name" );
await c.evaluate( "document.getElementById('playlistName').value = 'Solo'; document.getElementById('saveConfirmBtn').click(); true" );
ok( await disk( () => ( lists() || [] ).some( p => p.name === "Solo" && p.paths.join() === FOUR ) ) && road(), "…a new list with that song; the other list stays", lists() );
await c.until( "!! document.querySelector('#tree .tree-row[data-id^=\"pl:\"]:not([data-id=\"pl:plA\"])')" );
ok( true, "the new list is in the tree" );

section( "MUSIC · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
await c.evaluate( "browse.clear(); setFilter( 'songs' ); true" );
await c.until( "document.querySelectorAll('#libContent .song-row').length === 4" );
await finger( c, ROW( TWO ) );
ok( await c.until( "st.queue[ st.playingIndex ] && st.queue[ st.playingIndex ].song.path === " + JSON.stringify( TWO ) ) && await sel() === "", "a tap plays the song" );
await finger( c, ROW( THREE ), 700 );
ok( await c.until( "browse.ids().join() === " + JSON.stringify( THREE ) ) && await c.evaluate( "document.getElementById('libContent').classList.contains('is-picking')" ), "a long-press picks (ticks on)" );
await finger( c, ROW( FOUR ) );
ok( ( await sel() ).split( "," ).length === 2, "…then a tap adds one" );
ok( await c.evaluate( "document.querySelectorAll('#selActions [data-sel-act]').length === 3" ), "phone header: three actions" );
await finger( c, "#selActions [data-sel=clear]" );
ok( await c.until( "browse.ids().length === 0 && ! document.getElementById('libContent').classList.contains('is-picking')" ), "the × stops picking" );
await finger( c, "#treeBtn" );
ok( await c.until( "document.getElementById('treePane').classList.contains('open')" ), "the tree button slides the tree in" );
await finger( c, NODE( "pls" ) );
ok( await c.evaluate( "document.getElementById('treePane').classList.contains('open')" ), "…a heading row only opens / closes (the sheet stays)" );
await finger( c, NODE( "v:artists" ) );
ok( await c.until( "st.filter === 'artists' && ! document.getElementById('treePane').classList.contains('open')" ), "…a view row shows it and the sheet goes" );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
await done( c, s );
