// drive.mjs - Drive on the shared item browser: a mouse picks, a double-click
// opens, one menu, the keys, the tree, "Move to…", drag, the bin with Undo
// and no question; then a phone: tap opens, long-press picks.
import { server, browser, ok, section, done, sleep, where, mouse, key, finger, drag, menuRows, seed, exists, fitState } from "./lib.mjs";

const s = await server();
seed( s, { "files/Docs/a.txt": "a", "files/Docs/b.txt": "b", "files/Docs/c.md": "c", "files/Docs/Work": null,
           "files/Pics": null, "files/Old/x.txt": "x", "files/Empty": null } );
const c = await browser( s, { mouse: true } );
const ROW = p => `#listing .row[data-path="${p}"]`;
const sel = () => c.evaluate( "browse.ids().join()" );

section( "DRIVE · MOUSE" );
ok( await c.open( "/nayive/drive/?open=files/Docs", "/nayive/drive/" ) && await c.until( "document.querySelectorAll('#listing .row[data-path]').length === 4" ), "Drive opens Docs" );
await c.evaluate( "document.querySelectorAll('.sheet-backdrop.open').forEach( b => b.classList.remove('open') ); true" );
await mouse( c, ROW( "files/Docs/a.txt" ), { dx: 120 } );
ok( await sel() === "files/Docs/a.txt", "a click picks one row" );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .sel-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await mouse( c, ROW( "files/Docs/c.md" ), { dx: 120, mods: 8 } );
ok( await sel() === "files/Docs/a.txt,files/Docs/b.txt,files/Docs/c.md", "Shift+click picks the range", await sel() );
await mouse( c, ROW( "files/Docs/b.txt" ), { dx: 120, mods: 2 } );
ok( await sel() === "files/Docs/a.txt,files/Docs/c.md", "Ctrl+click takes one out", await sel() );
ok( await c.evaluate( "document.querySelectorAll('#listing .row.is-selected').length === 2" ), "the picked rows are painted" );
await key( c, "Escape" );
ok( await sel() === "" && await c.evaluate( "document.getElementById('selActions').hidden" ), "Esc clears; the group goes" );
await mouse( c, ROW( "files/Docs/a.txt" ), { dx: 120 } );
await key( c, "a", 2 );
ok( await c.evaluate( "browse.ids().length === 4" ), "Ctrl+A picks all" );
await mouse( c, "#listing", { dx: 40 } );
ok( await c.evaluate( "browse.ids().length === 0 || document.querySelector('#listing .row:last-child').getBoundingClientRect().bottom > innerHeight" ), "a click on empty space clears" );

section( "DRIVE · ONE MENU" );
await mouse( c, ROW( "files/Docs/b.txt" ), { dx: 120, button: "right" } );
let rows = await menuRows( c );
ok( await sel() === "files/Docs/b.txt" && rows && rows.some( r => r.act === "rename" && ! r.off ), "right-click picks that row and opens the menu" );
ok( rows && rows.some( r => r.act === "bin" ) && rows.some( r => r.act === "move" ) && rows.some( r => r.act === "props" ), "…with every action" );
ok( await c.evaluate( "[ ...document.querySelectorAll('.item-menu .mi-key') ].some( k => k.textContent === 'F2' )" ), "…and its key beside it" );
await key( c, "Escape" );
ok( await c.evaluate( "document.querySelector('.item-menu').hidden" ), "Esc closes the menu" );
ok( await c.evaluate( "! document.querySelector('#listing [data-more], #tree [data-more], #selActions [data-sel=menu]')" ), "no row ⋮, no tree ⋮, no ⋮ in the selection group" );
let fs = await fitState( c );
ok( fs.acts.join() === "download,move,copyTo,rename,link,share,compress,props,bin" && ! fs.out.length && ! fs.more && ! fs.crowded,
    "wide: every action is a button, in menu order (no cut / copy, no Extract on a .txt); no ⋮", fs );
await c.evaluate( "browse.clear(); true" );
await mouse( c, "#listing", { dx: 40, button: "right" } );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === "newFolder" ) && rows.some( r => r.act === "paste" && r.off ) && rows.some( r => r.act === "selectAll" ), "right-click on empty space: New folder, Paste (off), Select all" );
await key( c, "Escape" );

section( "DRIVE · KEYS" );
await mouse( c, ROW( "files/Docs/b.txt" ), { dx: 120 } );
await key( c, "F2" );
ok( await c.until( "document.getElementById('renameBackdrop').classList.contains('open')" ), "F2 renames" );
await c.evaluate( "document.getElementById('renameCancelBtn').click(); true" );
await sleep( 200 );
await mouse( c, ROW( "files/Docs/b.txt" ), { dx: 120 } );
await key( c, "ArrowDown" );
ok( await sel() === "files/Docs/c.md", "↓ moves the pick" );
await key( c, "ArrowUp", 8 );
ok( await sel() === "files/Docs/c.md,files/Docs/b.txt" || await sel() === "files/Docs/b.txt,files/Docs/c.md", "Shift+↑ grows it", await sel() );
await mouse( c, ROW( "files/Docs/a.txt" ), { dx: 120 } );
await key( c, "x", 2 );
await c.evaluate( "navigateTo('files/Pics'); true" );
await c.until( "currentFolder === 'files/Pics' && ! listingLoading" );
await mouse( c, "#listing", { dx: 40 } );
await key( c, "v", 2 );
ok( await c.until( "!! document.querySelector('#listing .row[data-path=\"files/Pics/a.txt\"]')" ) && exists( s, "files/Pics/a.txt" ) && ! exists( s, "files/Docs/a.txt" ), "Ctrl+X, then Ctrl+V in another folder moves it" );

section( "DRIVE · BIN, NO QUESTION" );
await mouse( c, ROW( "files/Pics/a.txt" ), { dx: 120 } );
await key( c, "Delete" );
ok( await c.until( "! document.querySelector('#listing .row[data-path=\"files/Pics/a.txt\"]')" ) && ! exists( s, "files/Pics/a.txt" ), "Del: to the bin at once" );
ok( await c.evaluate( "! document.querySelector('.sheet-backdrop.open')" ) && await c.until( "!! document.querySelector('#toast .toast-undo')" ), "…no question, an Undo" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await c.until( "!! document.querySelector('#listing .row[data-path=\"files/Pics/a.txt\"]')" ) && exists( s, "files/Pics/a.txt" ), "Undo brings it back" );
await c.evaluate( "renderTree(); true" );
await mouse( c, '#tree .tree-row[data-id="files/Old"]', { button: "right", dx: 40 } );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === "bin" && ! r.off ), "a tree folder's right-click: the same menu" );
await c.evaluate( "document.querySelector('.item-menu [data-act=bin]').click(); true" );
ok( await c.until( "! document.querySelector('#tree .tree-row[data-id=\"files/Old\"]')" ) && ! exists( s, "files/Old" ) && await c.evaluate( "! document.querySelector('.sheet-backdrop.open')" ), "a folder goes to the bin at once too" );
await c.until( "!! document.querySelector('#toast .toast-undo')" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await c.until( "!! document.querySelector('#tree .tree-row[data-id=\"files/Old\"]')", 8000 ) && exists( s, "files/Old/x.txt" ), "…and Undo brings the folder back" );

section( "DRIVE · MOVE TO… AND DRAG" );
await c.evaluate( "navigateTo('files/Docs'); true" );
await c.until( "currentFolder === 'files/Docs' && ! listingLoading && document.querySelectorAll('#listing .row[data-path]').length === 3" );
await mouse( c, ROW( "files/Docs/b.txt" ), { dx: 120 } );
await c.evaluate( "browse.run('move'); true" );
ok( await c.until( "!! document.querySelector('.sheet-backdrop.open .pick-tree .tree-row')" ), "Move to… shows the same tree" );
ok( await c.evaluate( "! document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id=\"shared\"]')" ), "…Drive's folders only" );
await c.evaluate( `( () => { const P = '.sheet-backdrop.open .pick-tree '; const d = document.querySelector( P + '.tree-row[data-id="files/Docs"]' ); if( d.getAttribute('aria-expanded') !== 'true' ) d.querySelector('[data-twisty]').click(); document.querySelector( P + '.tree-row[data-id="files/Docs/Work"]' ).click(); document.querySelector('.pick-ok').click(); } )(); true` );
ok( await c.until( "! document.querySelector('#listing .row[data-path=\"files/Docs/b.txt\"]')" ) && exists( s, "files/Docs/Work/b.txt" ), "…and moves there" );
await c.until( "! listingLoading" );
const lit = await drag( c, ROW( "files/Docs/c.md" ), '#tree .tree-row[data-id="files/Pics"]' );
ok( lit === true && await c.until( "! document.querySelector('#listing .row[data-path=\"files/Docs/c.md\"]')" ) && exists( s, "files/Pics/c.md" ), "a row dragged onto a tree folder moves (target lit)", lit );
await mouse( c, ROW( "files/Docs/Work" ), { dx: 120, count: 2 } );
ok( await c.until( "currentFolder === 'files/Docs/Work'" ), "a double-click opens a folder" );

section( "DRIVE · KEYS: BEHIND A VIEWER, OTHER LAYOUTS, AN EMPTY FOLDER" );
// A key as another layout sends it: e.key is what the layout types, e.code the place.
const rawKey = async ( k, code, vk, mods ) =>
{
    await c.send( "Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods } );
    await c.send( "Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods } );
    await sleep( 120 );
};
await c.until( "! listingLoading && document.querySelectorAll('#listing .row[data-path]').length === 1" );
await mouse( c, ROW( "files/Docs/Work/b.txt" ), { dx: 120 } );
// CS3: the picture viewer (or the player) is open over the list.
await c.evaluate( "document.getElementById('viewerBackdrop').classList.add('open'); true" );
await key( c, "F2" );
await key( c, "Delete" );
await sleep( 300 );
ok( await c.evaluate( "! document.querySelector('.sheet-backdrop.open')" ) && exists( s, "files/Docs/Work/b.txt" ) && await sel() === "files/Docs/Work/b.txt",
    "with the viewer open, F2 / Del do nothing to the list behind it" );
await c.evaluate( "document.getElementById('viewerBackdrop').classList.remove('open'); true" );
// CS4: Ctrl+A on a Russian keyboard ("ф"), Alt+N on a Mac (a dead key).
await key( c, "Escape" );
await mouse( c, ROW( "files/Docs/Work/b.txt" ), { dx: 120 } );
await key( c, "Escape" );
await rawKey( "ф", "KeyA", 65, 2 );
ok( await sel() === "files/Docs/Work/b.txt", "Ctrl+A on a Cyrillic layout picks all", await sel() );
await key( c, "Escape" );
await rawKey( "Dead", "KeyN", 78, 1 );
ok( await c.until( "document.getElementById('newFolderBackdrop').classList.contains('open')" ), "Mac ⌥N (a dead key) opens New folder" );
await c.evaluate( "document.getElementById('newFolderCancelBtn').click(); true" );
await sleep( 200 );
// CS5: Tab leaves the tree when the list is empty.
await c.evaluate( "navigateTo('files/Empty'); true" );
await c.until( "currentFolder === 'files/Empty' && ! listingLoading" );
await c.evaluate( `( () => { window.__tabPrevented = null;
    window.addEventListener( 'keydown', e => { if( e.key === 'Tab' ) window.__tabPrevented = e.defaultPrevented; } );
    document.querySelector( '#tree .tree-row[data-id="files/Empty"]' ).focus(); return true; } )()` );
await key( c, "Tab" );
ok( await c.evaluate( "window.__tabPrevented === false" ), "Tab from the tree, the list empty: the browser's Tab goes on" );

section( "DRIVE · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
await c.evaluate( "navigateTo('files'); true" );
await c.until( "currentFolder === 'files' && ! listingLoading && document.querySelectorAll('#listing .row[data-path]').length >= 3" );
await finger( c, ROW( "files/Docs" ) );
ok( await c.until( "currentFolder === 'files/Docs'" ), "a tap opens a folder" );
await c.until( "! listingLoading && document.querySelectorAll('#listing .row[data-path]').length >= 1" );
await finger( c, ROW( "files/Docs/Work" ), 700 );
ok( await c.until( "browse.ids().join() === 'files/Docs/Work'" ) && await c.evaluate( "document.getElementById('listing').classList.contains('is-picking') && currentFolder === 'files/Docs'" ), "a long-press picks (ticks on), it does not open" );
fs = await fitState( c );
ok( ! fs.crowded && fs.more && [ "move", "share", "bin" ].every( a => fs.acts.includes( a ) ) && ! fs.tools.includes( "trashViewBtn" ),
    "phone header: one row; the top ranks stay, the tools leave first, the ⋮ shows", fs );
ok( fs.rows.slice( 0, fs.out.length ).join() === fs.out.join() && fs.out.join() === [ "download", "copyTo", "rename", "link", "share", "compress", "props" ].filter( a => fs.out.includes( a ) ).join(),
    "…its ⋮ lists the hidden actions in toolbar order, then the hidden tools", fs );
await mouse( c, "#moreBtn" );
let mrows = await menuRows( c );
ok( mrows && mrows.some( r => r.act === fs.out[ 0 ] ) && mrows.some( r => r.act === "trashViewBtn" ), "the ⋮ opens with them", mrows );
await key( c, "Escape" );
await finger( c, "#selActions [data-sel=clear]" );
ok( await c.until( "browse.ids().length === 0 && ! document.getElementById('listing').classList.contains('is-picking')" ), "the × stops picking" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 300, height: 800, deviceScaleFactor: 1, mobile: true } );
await sleep( 250 );
fs = await fitState( c );
ok( fs.tools.includes( "searchToggleBtn" ) && ! fs.crowded, "nothing picked, 300 px: Search stays in the bar", fs );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
await sleep( 250 );
await finger( c, ".breadcrumb .crumb-root" );
ok( await c.until( "document.getElementById('treePane').classList.contains('open')" ), "the Drive crumb slides the tree in" );
await c.evaluate( "treeView.closeSheet(); true" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false } );
await c.until( "!! document.querySelector('#listing .row[data-path]')" );
await c.evaluate( "browse.set( [ document.querySelector('#listing .row[data-path]').dataset.path ] ); true" );
await sleep( 200 );
fs = await fitState( c );
ok( ! fs.out.length && ! fs.more && fs.tools.includes( "trashViewBtn" ), "back to 1400 px: everything is a button again, no ⋮", fs );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
await done( c, s );
