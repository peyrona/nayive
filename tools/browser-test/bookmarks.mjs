// bookmarks.mjs - Bookmarks on the shared item browser: a mouse picks, one
// menu, the header that fits (every action a button when wide, the ⋮ with
// Bookmarks' own rows: import, export, sort...), delete with Undo and no
// question (checked on disk); then a phone: the top ranks stay, the ⋮ lists
// the rest in toolbar order, then the own rows; long-press picks.
import { server, browser, ok, section, done, sleep, onDisk, mouse, key, finger, menuRows, seed, fitState } from "./lib.mjs";

const F = "data/bookmarks/bookmarks.json";
const T0 = "2026-01-01T10:00:00.000Z";
const bm = ( id, title, url, extra = {} ) => ( { id, title, type: "bookmark", parentId: "root", url, tags: [], notes: "", favorite: false, createdAt: T0, ...extra } );
const s = await server();
seed( s, { [ F ]: JSON.stringify( { version: 1, rootId: "root", nodes: {
    root:   { id: "root", title: "", type: "folder", parentId: null, children: [ "f_work", "b_a", "b_b", "b_c" ], createdAt: T0 },
    f_work: { id: "f_work", title: "Work", type: "folder", parentId: "root", children: [ "b_d" ], createdAt: T0 },
    b_a: bm( "b_a", "Alpha", "https://alpha.invalid/" ),
    b_b: bm( "b_b", "Beta", "https://beta.invalid/", { favorite: true } ),
    b_c: bm( "b_c", "Gamma", "https://gamma.invalid/" ),
    b_d: bm( "b_d", "Delta", "https://delta.invalid/", { parentId: "f_work" } ) } } ) } );

const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:bookmarks', '1' ); true" );
const ROW = id => `#items .bm-item[data-id="${id}"]`;
const sel = () => c.evaluate( "browse.ids().join()" );
const onFile = () => { try { return JSON.parse( onDisk( s, F ) || "{}" ).nodes || {}; } catch { return {}; } };
async function disk( fn, ms = 10000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}
// Bookmarks' own rows in the ⋮ (wide: no grid / list, the header has them).
const OWN = "import,export,dupes,bmlet,sort:saved,sort:az,sort:za,sort:new,sort:old";
const openPage = async () => { await c.open( "/nayive/bookmarks/" ); return c.until( "typeof loaded !== 'undefined' && loaded && document.querySelectorAll('#items .bm-item').length === 4" ); };

section( "BOOKMARKS · MOUSE" );
ok( await openPage(), "Bookmarks opens: the folder and three bookmarks" );
await mouse( c, ROW( "b_a" ), { dx: 120 } );
ok( await sel() === "b_a", "a click picks one", await sel() );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .sel-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await mouse( c, ROW( "b_c" ), { dx: 120, mods: 2 } );
ok( await sel() === "b_a,b_c", "Ctrl+click adds one", await sel() );
ok( await c.evaluate( "document.querySelectorAll('#items .bm-item.is-selected').length === 2" ), "the picked cards are painted" );
await key( c, "Escape" );
ok( await sel() === "" && await c.evaluate( "document.getElementById('selActions').hidden" ), "Esc clears; the group goes" );

section( "BOOKMARKS · ONE MENU, THE HEADER THAT FITS" );
await mouse( c, ROW( "b_b" ), { dx: 120, button: "right" } );
let rows = await menuRows( c );
ok( await sel() === "b_b" && rows && [ "open", "edit", "fav", "link", "move", "delete" ].every( a => rows.some( r => r.act === a && ! r.off ) ), "right-click picks that card: every action", rows );
ok( rows && rows.find( r => r.act === "fav" ).label.startsWith( await c.evaluate( "T( 'bookmarks.unfavourite' )" ) ), "…Beta is a favourite: the toggle says so", rows );
ok( await c.evaluate( "[ ...document.querySelectorAll('.item-menu .mi-key') ].some( k => k.textContent === 'F2' )" ), "…and the keys beside them" );
await key( c, "Escape" );
ok( await c.evaluate( "document.querySelector('.item-menu').hidden" ), "Esc closes the menu" );
ok( await c.evaluate( "! document.querySelector('#items [data-more], #tree [data-more], #selActions [data-sel=menu], #topMenu')" ), "no card ⋮, no tree ⋮, no ⋮ in the selection group, no old #topMenu" );
let ft = await fitState( c );
ok( ft.acts.join() === "edit,fav,link,move,delete" && ! ft.out.length && ! ft.crowded, "wide: every action is a button, in menu order (no Open all, no New subfolder for one bookmark)", ft );
ok( ft.more && ft.rows.filter( Boolean ).join() === OWN, "…the ⋮ shows: Bookmarks' own rows only", ft );
await mouse( c, ROW( "b_c" ), { dx: 120, mods: 2 } );
ft = await fitState( c );
ok( ft.acts.join() === "openAll,edit,fav,link,move,delete" && await c.evaluate( "document.querySelector('#selActions [data-sel-act=edit]').disabled && ! document.querySelector('#selActions [data-sel-act=delete]').disabled" ),
    "two bookmarks: Open all comes (hideOff); Edit greyed, Delete not", ft );
await mouse( c, ROW( "f_work" ), { dx: 120 } );
ft = await fitState( c );
ok( ft.acts.join() === "edit,fav,link,move,subfolder,delete" && await c.evaluate( "document.querySelector('#selActions [data-sel-act=fav]').disabled" ),
    "a folder: New subfolder comes (hideOff); Favourite greyed", ft );
await mouse( c, "#moreBtn" );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === "import" ) && rows.some( r => r.act === "sort:az" ) && ! rows.some( r => /^mode:/.test( r.act ) ), "the ⋮ opens: import… and the sort list (no grid / list when wide)", rows );
ok( await c.evaluate( "document.querySelector('.item-menu [data-act=\"sort:saved\"]').classList.contains('is-active') && ! document.querySelector('.item-menu [data-act=\"sort:az\"]').classList.contains('is-active')" ), "…the current sort ticked" );
await mouse( c, '.item-menu [data-act="sort:za"]' );
ok( await c.until( "ui.sort === 'za'" ) && await c.until( "[ ...document.querySelectorAll('#items .bm-item:not(.is-folder) .bm-title') ].map( t => t.textContent ).join() === 'Gamma,Beta,Alpha'" ), "a sort row sorts (Z-A)" );
await mouse( c, "#moreBtn" );
ok( await c.evaluate( "document.querySelector('.item-menu [data-act=\"sort:za\"]').classList.contains('is-active')" ), "…and is the one ticked next time" );
await mouse( c, '.item-menu [data-act="sort:saved"]' );
await c.until( "ui.sort === 'saved'" );
await mouse( c, "#moreBtn" );
await mouse( c, '.item-menu [data-act="export"]' );
ok( await c.until( "document.getElementById('exportBackdrop').classList.contains('open')" ), "Export opens its sheet" );
await key( c, "Escape" );
await c.until( "! document.querySelector('.sheet-backdrop.open')" );
await key( c, "Escape" );

section( "BOOKMARKS · DELETE, NO QUESTION, UNDO" );
await mouse( c, ROW( "b_c" ), { dx: 120 } );
await key( c, "Delete" );
ok( await disk( () => ! onFile().b_c && onFile().b_a && ! onFile().root.children.includes( "b_c" ) ), "Del: Gamma leaves the file" );
ok( await c.evaluate( "! document.querySelector('.sheet-backdrop.open') && ! document.querySelector('" + ROW( "b_c" ) + "')" ), "…at once, no question" );
ok( await c.until( "!! document.querySelector('#toast .toast-undo')" ), "…with an Undo" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await disk( () => onFile().b_c && onFile().b_c.url === "https://gamma.invalid/" && onFile().root.children.join() === "f_work,b_a,b_b,b_c" ) && await c.until( "!! document.querySelector('" + ROW( "b_c" ) + "')" ),
    "Undo puts it back, in its place", onFile().root );

section( "BOOKMARKS · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
ok( await openPage(), "Bookmarks on a phone" );
ok( await c.evaluate( "document.documentElement.scrollWidth <= innerWidth" ), "no side scroll" );
await finger( c, ROW( "b_a" ), 700 );
ok( await c.until( "browse.ids().join() === 'b_a'" ) && await c.evaluate( "document.getElementById('items').classList.contains('is-picking')" ), "a long-press picks (ticks on)" );
await sleep( 200 );
ft = await fitState( c );
// toolbar order (by group): edit fav link | move | delete; ranks 5 2 6 | 3 | 1
const BAR = [ "edit", "fav", "link", "move", "delete" ], RANK = { delete: 1, fav: 2, move: 3, edit: 5, link: 6 };
ok( ! ft.crowded && ft.more && [ "delete", "fav" ].every( a => ft.acts.includes( a ) ) && ! ft.tools.includes( "addBtn" ) &&
    Math.max( ...ft.acts.map( a => RANK[ a ] ) ) < Math.min( ...ft.out.map( a => RANK[ a ] ) ),
    "phone header: one row; the top ranks stay (none shown outranked by one hidden), the tools leave first, the ⋮ shows", ft );
const ids = ft.rows.filter( Boolean );
ok( ids.filter( i => BAR.includes( i ) ).join() === ft.out.join() && ft.out.join() === BAR.filter( a => ft.out.includes( a ) ).join() && ft.out.length > 0 &&
    ids.indexOf( ft.out[ ft.out.length - 1 ] ) < ids.indexOf( "searchBtn" ),
    "…its ⋮ lists the hidden actions in toolbar order, then the hidden tools", ft );
ok( ids.slice( -OWN.split( "," ).length - 2 ).join() === OWN + ",mode:grid,mode:list", "…then Bookmarks' own rows, grid / list last (they left the header)", ids );
await finger( c, "#moreBtn" );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === ft.out[ 0 ] ) && rows.some( r => r.act === "mode:list" ), "the ⋮ opens with them", rows );
await c.evaluate( "document.querySelector('.item-menu [data-act=\"mode:list\"]').scrollIntoView( { block: 'nearest' } ); true" );
await finger( c, '.item-menu [data-act="mode:list"]' );
ok( await c.until( "ui.mode === 'list' && document.getElementById('items').classList.contains('is-list')" ), "List from the ⋮ turns the cards into rows" );
await finger( c, "#selActions [data-sel=clear]" );
ok( await c.until( "browse.ids().length === 0 && ! document.getElementById('items').classList.contains('is-picking')" ), "the × stops picking" );
await c.evaluate( "setMode( 'grid' ); true" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false } );
await c.evaluate( "browse.set( [ 'b_a' ] ); true" );
await sleep( 200 );
ft = await fitState( c );
ok( ! ft.out.length && ft.more && ft.tools.includes( "addBtn" ) && ft.rows.filter( Boolean ).join() === OWN, "back to 1400 px: everything is a button again; the ⋮ holds only the own rows", ft );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
await done( c, s );
