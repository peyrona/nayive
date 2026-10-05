// contacts.mjs - Contacts on the shared item browser: a mouse picks, a
// double-click / Enter opens the card, one menu, the keys, favourites and
// groups (the cards' CATEGORIES line, checked on disk), drag onto the tree,
// delete with Undo and no question; then a phone: tap opens, long-press
// picks, the tree slides in.
import { server, browser, ok, section, done, sleep, onDisk, mouse, key, finger, drag, menuRows, seed, fitState } from "./lib.mjs";

const F = "data/contacts.vcf";
const card = ( uid, fn, n, extra = [] ) => [ "BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + fn, "N:" + n, ...extra, "END:VCARD" ].join( "\r\n" );
const s = await server();
seed( s, { [ F ]: [ card( "a", "Ana López", "López;Ana;;;", [ "TEL;TYPE=CELL:600111111", "CATEGORIES:Family" ] ),
                    card( "b", "Bruno Díaz", "Díaz;Bruno;;;", [ "CATEGORIES:Family,starred" ] ),
                    card( "c", "Carla Gil", "Gil;Carla;;;", [ "EMAIL;TYPE=HOME:carla@x.es" ] ),
                    card( "d", "David Ruiz", "Ruiz;David;;;" ),
                    card( "e", "Elena Mora", "Mora;Elena;;;", [ "CATEGORIES:Work" ] ) ].join( "\r\n" ) + "\r\n" } );

const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:contact', '1' ); true" );
const ROW  = u => `#contactList .contact-row[data-uid="${u}"]`;
const NODE = id => `#tree .tree-row[data-id="${id}"]`;
const sel  = () => c.evaluate( "browse.ids().join()" );
const shownRows = () => c.evaluate( "[ ...document.querySelectorAll('#contactList .contact-row') ].map( r => r.dataset.uid ).join()" );
// One card's text on disk ("" when it is not there).
const onCard = uid => { const m = new RegExp( "BEGIN:VCARD\\r?\\n(?:(?!END:VCARD)[\\s\\S])*?UID:" + uid + "\\r?\\n[\\s\\S]*?END:VCARD" ).exec( onDisk( s, F ) || "" ); return m ? m[ 0 ] : ""; };
const cats = uid => { const l = /^CATEGORIES:(.*)$/m.exec( onCard( uid ) ); return l ? l[ 1 ].trim() : ""; };
async function disk( fn, ms = 10000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}
async function undo()
{
    if( ! await c.until( "!! document.querySelector('#toast .toast-undo')" ) ) return false;
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    return true;
}

section( "CONTACTS · MOUSE" );
ok( await c.open( "/nayive/contact/" ) && await c.until( "typeof contacts !== 'undefined' && contacts.length === 5 && document.querySelectorAll('#contactList .contact-row').length === 5" ), "Contacts opens the book" );
await mouse( c, ROW( "a" ), { dx: 120 } );
ok( await sel() === "a", "a click picks one row" );
ok( await c.evaluate( "! document.getElementById('detailBackdrop').classList.contains('open')" ), "…and does not open it" );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .sel-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await mouse( c, ROW( "d" ), { dx: 120, mods: 8 } );
ok( await sel() === "a,b,c,d", "Shift+click picks the range", await sel() );
await mouse( c, ROW( "b" ), { dx: 120, mods: 2 } );
ok( await sel() === "a,c,d", "Ctrl+click takes one out", await sel() );
ok( await c.evaluate( "document.querySelectorAll('#contactList .contact-row.is-selected').length === 3" ), "the picked rows are painted" );
await key( c, "Escape" );
ok( await sel() === "" && await c.evaluate( "document.getElementById('selActions').hidden" ), "Esc clears; the group goes" );
await mouse( c, ROW( "a" ), { dx: 120 } );
await key( c, "a", 2 );
ok( await c.evaluate( "browse.ids().length === 5" ), "Ctrl+A picks all" );
await mouse( c, "#contactList .letter-head", { dx: 40 } );
ok( await sel() === "", "a click off the rows clears" );
await mouse( c, ROW( "c" ), { dx: 120, count: 2 } );
ok( await c.until( "document.getElementById('detailBackdrop').classList.contains('open') && document.getElementById('detailName').textContent === 'Carla Gil'" ), "a double-click opens the card" );
await key( c, "Escape" );
ok( await c.until( "! document.getElementById('detailBackdrop').classList.contains('open')" ) && await sel() === "c", "Esc closes the card; the pick stays" );

section( "CONTACTS · ONE MENU" );
await mouse( c, ROW( "b" ), { dx: 120, button: "right" } );
let rows = await menuRows( c );
ok( await sel() === "b" && rows && rows.some( r => r.act === "edit" && ! r.off ), "right-click picks that row and opens the menu" );
ok( rows && [ "open", "fav", "group", "export", "merge", "delete" ].every( a => rows.some( r => r.act === a ) ) && rows.find( r => r.act === "merge" ).off, "…with every action (Merge off for one)", rows );
ok( rows && rows.find( r => r.act === "fav" ).label.includes( "Remove from favourites" ), "…Bruno is a favourite: the toggle says so" );
ok( await c.evaluate( "[ ...document.querySelectorAll('.item-menu .mi-key') ].some( k => k.textContent === 'F2' )" ), "…and the keys beside them" );
await key( c, "Escape" );
ok( await c.evaluate( "document.querySelector('.item-menu').hidden" ), "Esc closes the menu" );
ok( await c.evaluate( "! document.querySelector('#contactList [data-more], #tree [data-more], #selActions [data-sel=menu]')" ), "no row ⋮, no tree ⋮, no ⋮ in the selection group" );
// Share is there only where the browser can share files (headless may not).
const SHARE = await c.evaluate( "canShareFiles()" );
let fs = await fitState( c );
ok( fs.acts.join() === [ "edit", "fav", "group", SHARE && "share", "export", "delete" ].filter( Boolean ).join() && ! fs.out.length && fs.rows.join() === "import" && ! fs.crowded,
    "wide: every action is a button, in menu order (no Merge for one, no Remove from group outside one); the ⋮ holds only Import (the picked cards' Export stands for Export all)", fs );
await mouse( c, ROW( "a" ), { dx: 120, mods: 2 } );
fs = await fitState( c );
ok( fs.acts.includes( "merge" ) && ! fs.acts.includes( "edit" ) && ! fs.out.length && fs.rows.join() === "import", "…two picked: Merge shows too, Edit leaves", fs );
await mouse( c, ROW( "a" ), { dx: 120, mods: 2 } );
const ALL = "#selActions [data-sel=all]";
await mouse( c, ALL );
ok( await c.until( "browse.ids().length === document.querySelectorAll('#contactList .contact-row').length" ) &&
    await c.evaluate( "document.querySelector('" + ALL + "').getAttribute('aria-label') === 'Unselect all'" ), "Select all picks every row and turns into Unselect all" );
await mouse( c, ALL );
ok( await c.until( "browse.ids().length === 0" ), "…Unselect all drops them all" );
await c.evaluate( "browse.clear(); true" );
await mouse( c, "#contactList .letter-head", { dx: 40, button: "right" } );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === "new" ) && rows.some( r => r.act === "selectAll" ), "right-click off the rows: New contact, Select all", rows );
await key( c, "Escape" );

section( "CONTACTS · KEYS" );
await mouse( c, ROW( "d" ), { dx: 120 } );
await key( c, "F2" );
ok( await c.until( "document.getElementById('editBackdrop').classList.contains('open') && document.getElementById('fGiven').value === 'David'" ), "F2 edits" );
await c.evaluate( "document.getElementById('editCloseBtn').click(); true" );
await sleep( 200 );
await mouse( c, ROW( "a" ), { dx: 120 } );
await key( c, "Enter" );
ok( await c.until( "document.getElementById('detailBackdrop').classList.contains('open') && document.getElementById('detailName').textContent === 'Ana López'" ), "Enter opens the card" );
await c.evaluate( "document.getElementById('detailCloseBtn').click(); true" );
await sleep( 200 );
await mouse( c, ROW( "c" ), { dx: 120 } );
await key( c, "ArrowDown" );
ok( await sel() === "d", "↓ moves the pick" );
await mouse( c, ROW( "c" ), { dx: 120 } );
await key( c, "s" );
ok( await disk( () => cats( "c" ) === "starred" ) && await c.until( "!! document.querySelector('" + ROW( "c" ) + " .ct-star')" ), "S makes Carla a favourite (CATEGORIES:starred on disk, a star on the row)", onCard( "c" ) );
ok( /REV:20/.test( onCard( "c" ) ) && /EMAIL;TYPE=HOME:carla@x\.es/.test( onCard( "c" ) ), "…with a new REV, the rest of her card as it was", onCard( "c" ) );
await key( c, "s" );
ok( await disk( () => cats( "c" ) === "" && onCard( "c" ) ) && await c.until( "! document.querySelector('" + ROW( "c" ) + " .ct-star')" ), "S again takes it off", onCard( "c" ) );

section( "CONTACTS · DELETE, NO QUESTION, UNDO" );
await mouse( c, ROW( "c" ), { dx: 120 } );
await mouse( c, ROW( "d" ), { dx: 120, mods: 2 } );
await key( c, "Delete" );
ok( await disk( () => ! onCard( "c" ) && ! onCard( "d" ) && onCard( "a" ) ), "Del: both cards leave the file" );
ok( await c.evaluate( "! document.querySelector('.sheet-backdrop.open') && ! document.querySelector('" + ROW( "c" ) + "')" ), "…at once, no question" );
ok( await undo(), "…with an Undo" );
ok( await disk( () => onCard( "c" ).includes( "carla@x.es" ) && onCard( "d" ) ) && await c.until( "!! document.querySelector('" + ROW( "d" ) + "')" ), "Undo puts both back, as they were" );

section( "CONTACTS · MERGE" );
await mouse( c, ROW( "a" ), { dx: 120 } );
await mouse( c, ROW( "b" ), { dx: 120, mods: 2 } );
await c.evaluate( "document.querySelector('#selActions [data-sel-act=merge]').click(); true" );
ok( await c.until( "document.getElementById('mergeBackdrop').classList.contains('open') && mergeModel.members.length === 2" ), "Merge (2 picked) opens the merge preview with both" );
await c.evaluate( "document.getElementById('mergeCloseBtn').click(); true" );
await sleep( 200 );

section( "CONTACTS · GROUPS TREE" );
ok( await c.evaluate( `[ 'all', 'fav', 'groups', 'g:Family', 'g:Work' ].every( id => document.querySelector( '#tree .tree-row[data-id="' + id + '"]' ) ) && ! document.querySelector( '#tree .tree-row[data-id="g:starred"]' )` ), "the tree: All, Favourites, Groups › Family, Work (starred is not a group)" );
await mouse( c, NODE( "g:Family" ), { dx: 40 } );
ok( await c.until( "view === 'g:Family'" ) && await shownRows() === "a,b", "a group shows its people", await shownRows() );
await mouse( c, NODE( "fav" ), { dx: 40 } );
ok( await c.until( "view === 'fav'" ) && await shownRows() === "b", "Favourites shows Bruno", await shownRows() );
await mouse( c, NODE( "all" ), { dx: 40 } );
await c.until( "view === 'all'" );
let lit = await drag( c, ROW( "c" ), NODE( "g:Work" ) );
ok( lit === true && await disk( () => cats( "c" ) === "Work" ), "Carla dragged onto Work joins it (lit; CATEGORIES:Work on disk)", lit );
ok( await undo() && await disk( () => cats( "c" ) === "" && onCard( "c" ) ), "…and Undo takes her out again" );
lit = await drag( c, ROW( "d" ), NODE( "fav" ) );
ok( lit === true && await disk( () => cats( "d" ) === "starred" ), "David dragged onto Favourites is one", lit );
ok( await drag( c, ROW( "d" ), NODE( "all" ) ) === false, "All contacts takes no drop" );

await mouse( c, NODE( "g:Work" ), { dx: 40, button: "right" } );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === "renameGroup" ) && rows.some( r => r.act === "deleteGroup" ), "a group's right-click: Rename, Delete", rows );
await c.evaluate( "document.querySelector('.item-menu [data-act=deleteGroup]').click(); true" );
ok( await disk( () => ! /Work/.test( onDisk( s, F ) ) && onCard( "e" ) ) && await c.until( "! document.querySelector('" + NODE( "g:Work" ) + "')" ), "Delete group: the word leaves the cards, Elena stays" );
ok( await undo() && await disk( () => cats( "e" ) === "Work" ) && await c.until( "!! document.querySelector('" + NODE( "g:Work" ) + "')" ), "…Undo brings the group back" );

await mouse( c, NODE( "g:Family" ), { dx: 40, button: "right" } );
await c.evaluate( "document.querySelector('.item-menu [data-act=renameGroup]').click(); true" );
await c.until( "!! document.getElementById('groupNameInput')" );
await c.evaluate( "document.getElementById('groupNameInput').value = 'Familia'; document.getElementById('groupNameOk').click(); true" );
ok( await disk( () => cats( "a" ) === "Familia" && cats( "b" ) === "Familia,starred" ) && await c.until( "!! document.querySelector('" + NODE( "g:Familia" ) + "') && ! document.querySelector('" + NODE( "g:Family" ) + "')" ), "Rename group: Family → Familia on both cards (Bruno stays a favourite)", [ cats( "a" ), cats( "b" ) ] );

await mouse( c, ROW( "e" ), { dx: 120 } );
await c.evaluate( "browse.run('group'); true" );
ok( await c.until( "!! document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id=\"g:Familia\"]')" ), "Add to group… shows the groups in the same tree" );
await c.evaluate( "document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id=\"g:Familia\"]').click(); document.querySelector('.pick-ok').click(); true" );
ok( await disk( () => cats( "e" ) === "Work,Familia" ), "…and adds Elena to Familia", cats( "e" ) );
await mouse( c, NODE( "g:Familia" ), { dx: 40 } );
await c.until( "view === 'g:Familia'" );
await mouse( c, ROW( "e" ), { dx: 120, button: "right" } );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === "ungroup" ), "inside a group the menu offers Remove from this group" );
await c.evaluate( "document.querySelector('.item-menu [data-act=ungroup]').click(); true" );
ok( await disk( () => cats( "e" ) === "Work" ) && await c.until( "! document.querySelector('" + ROW( "e" ) + "')" ), "…which takes her out (on disk and on screen)" );

await mouse( c, NODE( "groups" ), { dx: 40, button: "right" } );
await c.evaluate( "document.querySelector('.item-menu [data-act=newGroup]').click(); true" );
await c.until( "!! document.getElementById('groupNameInput')" );
await c.evaluate( "document.getElementById('groupNameInput').value = 'Club'; document.getElementById('groupNameOk').click(); true" );
ok( await c.until( "!! document.querySelector('" + NODE( "g:Club" ) + "')" ), "New group: Club shows in the tree" );
await mouse( c, NODE( "g:Club" ), { dx: 40 } );
ok( await c.until( "view === 'g:Club' && getComputedStyle( document.getElementById('emptyState') ).display !== 'none'" ), "…empty, with a hint" );
await mouse( c, NODE( "all" ), { dx: 40 } );
await c.until( "view === 'all'" );
ok( await c.evaluate( "contacts.length === 5" ) && ( onDisk( s, F ).match( /^UID:/mg ) || [] ).length === 5, "no card was lost on the way" );

section( "CONTACTS · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
await c.evaluate( "browse.clear(); document.head.insertAdjacentHTML( 'beforeend', '<style>.quota-card{display:none!important}</style>' ); true" );   // the scratch disk's "space almost full" card
await sleep( 300 );
await finger( c, ROW( "c" ) );
ok( await c.until( "document.getElementById('detailBackdrop').classList.contains('open')" ), "a tap opens the card" );
await c.evaluate( "document.getElementById('detailCloseBtn').click(); true" );
await sleep( 300 );
await finger( c, ROW( "d" ), 700 );
ok( await c.until( "browse.ids().join() === 'd'" ) && await c.evaluate( "document.getElementById('contactList').classList.contains('is-picking') && ! document.getElementById('detailBackdrop').classList.contains('open')" ), "a long-press picks (ticks on), it does not open" );
await sleep( 600 );                     // the long-press's own click is eaten for 700 ms
await finger( c, ROW( "e" ) );
ok( await sel() === "d,e", "…then a tap adds one", await sel() );
fs = await fitState( c );
ok( ! fs.crowded && fs.more && [ "group", "delete" ].every( a => fs.acts.includes( a ) ) && ! fs.tools.includes( "addBtn" ),
    "phone header: one row; the top ranks stay, the tools leave first, the ⋮ shows", fs );
const ORDER = [ "edit", "fav", "group", "share", "export", "merge", "delete" ];
ok( fs.out.length && fs.rows.filter( r => r !== "all" ).slice( 0, fs.out.length ).join() === fs.out.join() && fs.out.join() === ORDER.filter( a => fs.out.includes( a ) ).join(),
    "…its ⋮ lists the hidden actions in toolbar order (Select all first, when hidden), then the hidden tools", fs );
ok( fs.rows.filter( r => r === "export" ).length <= 1 && fs.rows.includes( "import" ), "…Export shows once (the picked cards'), Import is there", fs );
await finger( c, ".header .fit-more" );
let mrows = await menuRows( c );
ok( mrows && mrows.some( r => r.act === fs.out[ 0 ] ) && mrows.some( r => r.act === "addBtn" ), "the ⋮ opens with them", mrows );
await finger( c, ".header .fit-more" );
ok( await c.until( "document.querySelector('.item-menu').hidden" ), "…and closes again" );
await finger( c, "#selActions [data-sel=clear]" );
ok( await c.until( "browse.ids().length === 0 && ! document.getElementById('contactList').classList.contains('is-picking')" ), "the × stops picking" );
await finger( c, "#treeBtn" );
ok( await c.until( "document.getElementById('treePane').classList.contains('open')" ), "the folder button slides the tree in" );
await finger( c, NODE( "fav" ) );
ok( await c.until( "view === 'fav' && ! document.getElementById('treePane').classList.contains('open')" ) && await c.evaluate( "document.getElementById('viewName').textContent === 'Favourites'" ), "a tap on Favourites shows them; the tree slides out" );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
await done( c, s );
