// run.mjs - the Bookmarks app in a real (headless) browser, against a real
// scratch server built from server/go. See README.md.
//
//   node tools/bookmarks-test/run.mjs [real-export.html ...]
//
// Extra arguments are browser exports of your own to import as well (never
// commit those - they are private). Needs Go, Chromium and the internet
// (page titles and site icons are fetched for real).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

const HERE  = path.dirname( new URL( import.meta.url ).pathname );
const REPO  = path.resolve( HERE, "../.." );
const FX    = path.join( HERE, "fixtures" );
const EXTRA = process.argv.slice( 2 );
const GO    = process.env.GO || "go";

let pass = 0, fail = 0;
function ok( cond, what, extra ) { if( cond ) { pass++; console.log( "  ok  " + what ); } else { fail++; console.log( "  FAIL " + what + ( extra !== undefined ? "  -> " + JSON.stringify( extra ) : "" ) ); } }
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

//------------------------------------------------------------------------//
// A SCRATCH SERVER: its own run-root in /tmp (config, one user "test",
// a copy of client/apps), the current server/go built into it, a free port.
// Nothing of the real store/ is touched.

const RUN   = fs.mkdtempSync( path.join( os.tmpdir(), "bookmarks-test-" ) );
const SHOTS = fs.mkdtempSync( path.join( os.tmpdir(), "bookmarks-shots-" ) );
const PORT  = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE  = `http://127.0.0.1:${PORT}`;
const APP   = `${BASE}/nayive/bookmarks/index.html`;
const FILE  = `${RUN}/homes/test/data/bookmarks/bookmarks.json`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
// cp -a, not a plain copy: it keeps the mtimes, so a stale .gz sidecar stays
// older than its source and the server serves the source.
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

function cleanup()
{
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}

// What a browser export holds, counted the plain way: its links (minus
// place: / javascript: / data:) and its folders.
function expected( file )
{
    const s = fs.readFileSync( file, "utf8" );
    const hrefs = [ ...s.matchAll( /<A\s+HREF="([^"]*)"/gi ) ].map( m => m[ 1 ].trim() );
    return { b: hrefs.filter( h => h && ! /^(place|javascript|data):/i.test( h ) ).length, f: ( s.match( /<H3/gi ) || [] ).length };
}

const MOUSE = [ "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4" ];

async function launch( mouse )
{
    const b = await browser( mouse ? MOUSE : [] );
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    c.kill = b.kill;
    return c;
}

async function waitFor( c, expr, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( await c.evaluate( "!!(" + expr + ")" ) ) return true; } catch {} await sleep( 100 ); }
    return false;
}

async function nav( c, url, pathWant )
{
    await c.send( "Page.navigate", { url } );
    await waitFor( c, `location.pathname === ${JSON.stringify( pathWant )} && document.readyState === 'complete'` );
}

async function signIn( c )
{
    await nav( c, `${BASE}/nayive/login.html`, "/nayive/login.html" );
    await c.evaluate( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('balata-intro-dismiss:bookmarks','1');
        localStorage.setItem('balata-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
}

async function openApp( c )
{
    await nav( c, APP, "/nayive/bookmarks/index.html" );
    return waitFor( c, "typeof loaded !== 'undefined' && document.getElementById('app').style.display !== 'none' && document.getElementById('items') && store && store.state !== 'init' && store.state !== 'loading'" );
}

async function shot( c, name )
{
    const r = await c.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( `${SHOTS}/${name}.png`, Buffer.from( r.result.data, "base64" ) );
}

// Toasts, recorded as they show.
const TOASTS = `window.__toasts = []; new MutationObserver( () => { const t = document.getElementById('toast'); if( t.classList.contains('show') ) window.__toasts.push( t.firstChild ? t.firstChild.textContent : t.textContent ); } ).observe( document.getElementById('toast'), { attributes: true, childList: true, characterData: true, subtree: true } ); true`;

const counts = `( () => { const all = descendants( ROOT ); return { b: all.filter( n => n.type === 'bookmark' ).length, f: all.filter( n => n.type === 'folder' ).length }; } )()`;
const diskCounts = () =>
{
    try { const d = JSON.parse( fs.readFileSync( FILE, "utf8" ) ); const v = Object.values( d.nodes ); return { b: v.filter( n => n.type === "bookmark" ).length, f: v.filter( n => n.type === "folder" ).length - 1 }; }
    catch( e ) { return null; }
};
async function flushed( c ) { await c.evaluate( "store.flush()" ); await waitFor( c, "store.state === 'synced'", 8000 ); }

// ---------------------------------------------------------------------------
const c = await launch( true );
try
{
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false } );
    await signIn( c );
    ok( await openApp( c ), "app boots" );
    await c.evaluate( TOASTS );

    console.log( "EMPTY" );
    ok( await c.evaluate( "!document.getElementById('emptyHint').hidden && document.querySelectorAll('#emptyHint [data-empty]').length === 2" ), "empty screen offers Add + Import" );
    await shot( c, "01-empty-pc-light" );

    console.log( "ADD / EDIT" );
    await c.evaluate( "document.getElementById('addBtn').click()" );
    ok( await c.evaluate( "document.getElementById('bmBackdrop').classList.contains('open')" ), "add sheet opens" );
    await c.evaluate( "var u = document.getElementById('bmUrl'); u.value = 'example.com'; u.dispatchEvent( new Event('blur') ); true" );
    ok( await c.evaluate( "document.getElementById('bmName').value === 'example.com'" ), "title autofills the domain at once" );
    ok( await waitFor( c, "document.getElementById('bmName').value === 'Example Domain'", 12000 ), "then the page's own <title> (server)",
        await c.evaluate( "document.getElementById('bmName').value" ) );
    await c.evaluate( "document.getElementById('bmTags').value = 'docs, #web, docs'; document.getElementById('bmNotes').value = 'A test note'; document.getElementById('bmSaveBtn').click(); true" );
    ok( await c.evaluate( "!document.getElementById('bmBackdrop').classList.contains('open')" ), "sheet closes on ✓" );
    const b1 = await c.evaluate( "JSON.stringify( allBookmarks()[0] )" );
    const bm = JSON.parse( b1 );
    ok( bm.url === "https://example.com/" && bm.title === "Example Domain" && bm.tags.join() === "docs,web", "saved with https://, title, clean tags", bm );
    await flushed( c );
    ok( JSON.stringify( diskCounts() ) === JSON.stringify( { b: 1, f: 0 } ), "written to data/bookmarks/bookmarks.json", diskCounts() );

    // A typed title is never replaced.
    await c.evaluate( "openBookmarkSheet( null ); document.getElementById('bmName').value = 'Mine'; var u = document.getElementById('bmUrl'); u.value = 'https://example.org'; u.dispatchEvent( new Event('blur') ); true" );
    await sleep( 2500 );
    ok( await c.evaluate( "document.getElementById('bmName').value === 'Mine'" ), "a typed title is left alone" );
    ok( await c.evaluate( "document.getElementById('bmDupNote').hidden" ), "no duplicate note for a new URL" );
    await c.evaluate( "document.getElementById('bmUrl').value = 'http://www.example.com'; document.getElementById('bmUrl').dispatchEvent( new Event('input') ); true" );
    ok( await c.evaluate( "!document.getElementById('bmDupNote').hidden" ), "duplicate note: 'Already saved in…'", await c.evaluate( "document.getElementById('bmDupNote').textContent" ) );
    await c.evaluate( "document.getElementById('bmUrl').value = 'javascript:alert(1)'; document.getElementById('bmSaveBtn').click(); true" );
    ok( await c.evaluate( "!document.getElementById('bmUrlError').hidden && document.getElementById('bmBackdrop').classList.contains('open')" ), "javascript: refused" );
    await c.evaluate( "NayiveUI.close('bmBackdrop'); true" );

    // Edit through the row's right-click menu (no row ⋮ since 2026-10-05).
    await c.evaluate( "( () => { const r = document.querySelector('.bm-item').getBoundingClientRect(); document.querySelector('.bm-item .bm-title').dispatchEvent( new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 10 }) ); } )(); true" );
    ok( await c.evaluate( "!document.querySelector('.item-menu').hidden && !!document.querySelector('.item-menu [data-act=edit]')" ), "right-click opens the item menu" );
    ok( await c.evaluate( "document.querySelector('.bm-item').classList.contains('is-selected') && !document.getElementById('selActions').hidden" ), "…on that row, picked (the header group shows)" );
    await c.evaluate( "document.querySelector('.item-menu [data-act=edit]').click(); document.getElementById('bmFav').checked = true; document.getElementById('bmSaveBtn').click(); true" );
    ok( await c.evaluate( "allBookmarks()[0].favorite === true" ), "edit: favourite set" );

    console.log( "FOLDERS / MOVE / CYCLE" );
    await c.evaluate( "document.getElementById('newFolderBtn').click(); document.getElementById('folderName').value = 'Dev'; document.getElementById('folderSaveBtn').click(); true" );
    const dev = await c.evaluate( "Object.values( data.nodes ).find( n => n.title === 'Dev' ).id" );
    // Subfolder from the tree row's right-click menu.
    await c.evaluate( `document.querySelector('.tree-row[data-id="${dev}"]').dispatchEvent( new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 120 }) ); true` );
    await c.evaluate( "document.querySelector('.item-menu [data-act=subfolder]').click(); document.getElementById('folderName').value = 'Frontend'; document.getElementById('folderSaveBtn').click(); true" );
    const fe = await c.evaluate( "Object.values( data.nodes ).find( n => n.title === 'Frontend' ).id" );
    ok( await c.evaluate( `node('${fe}').parentId === '${dev}'` ), "tree menu: new subfolder" );
    ok( await c.evaluate( `!!document.querySelector('.tree-row[data-id="${fe}"]')` ), "tree shows the subfolder (parent opened)" );

    const bid = bm.id;
    // "Move to…" is the shared tree in a dialog (NayiveUI.pickNode).
    await c.evaluate( `openMoveSheet( ['${bid}'] ); true` );
    ok( await waitFor( c, "!!document.querySelector('.sheet-backdrop.open .pick-tree .tree-row')" ), "move dialog shows the folder tree" );
    await c.evaluate( `( () => { const P = '.sheet-backdrop.open .pick-tree '; const d = document.querySelector( P + '.tree-row[data-id="${dev}"]' ); if( d.getAttribute('aria-expanded') !== 'true' ) d.querySelector('[data-twisty]').click(); document.querySelector( P + '.tree-row[data-id="${fe}"]' ).click(); document.querySelector('.sheet-backdrop.open .pick-ok').click(); } )(); true` );
    ok( await waitFor( c, `node('${bid}').parentId === '${fe}'` ), "Move to… moves the bookmark" );
    await c.evaluate( `openMoveSheet( ['${dev}'] ); true` );
    await waitFor( c, "!!document.querySelector('.sheet-backdrop.open .pick-tree .tree-row')" );
    await c.evaluate( `( () => { const d = document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id="${dev}"]'); if( d.getAttribute('aria-expanded') !== 'true' ) d.querySelector('[data-twisty]').click(); } )(); true` );
    ok( await c.evaluate( `[ '${dev}', '${fe}' ].every( id => document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id="' + id + '"]').classList.contains('is-off') ) && !document.querySelector('.sheet-backdrop.open .pick-tree .tree-row[data-id="root"]').classList.contains('is-off')` ), "move dialog greys the folder and its subfolders" );
    await c.evaluate( "document.querySelector('.sheet-backdrop.open .pick-cancel').click(); true" );

    // Drag Dev onto its own subfolder: refused with a toast, nothing moves.
    await c.evaluate( `revealInTree('${fe}'); renderTree(); window.__toasts = []; true` );
    const dragJs = ( src, dst ) => `( () => {
        const s = document.querySelector(${JSON.stringify( src )}), d = document.querySelector(${JSON.stringify( dst )});
        const dt = new DataTransfer();
        s.dispatchEvent( new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }) );
        d.dispatchEvent( new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt }) );
        const lit = d.classList.contains('drop-target');
        d.dispatchEvent( new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt }) );
        s.dispatchEvent( new DragEvent('dragend',   { bubbles: true, dataTransfer: dt }) );
        return lit; } )()`;
    ok( await c.evaluate( `document.querySelector('.tree-row[data-id="${dev}"]').draggable === true` ), "tree rows are draggable with a mouse" );
    const litBad = await c.evaluate( dragJs( `.tree-row[data-id="${dev}"]`, `.tree-row[data-id="${fe}"]` ) );
    ok( ! litBad && await c.evaluate( `node('${dev}').parentId === ROOT && node('${fe}').parentId === '${dev}'` ), "drag into own subfolder: nothing moves" );
    ok( await c.evaluate( "window.__toasts.some( t => /cannot go inside itself/.test( t ) )" ), "…and an error toast", await c.evaluate( "window.__toasts" ) );

    // Drag the bookmark card onto the "All" crumb.
    await c.evaluate( `goFolder('${fe}'); true` );
    const litGood = await c.evaluate( dragJs( `.bm-item[data-id="${bid}"]`, `.crumb-seg[data-id="root"]` ) );
    ok( litGood && await c.evaluate( `node('${bid}').parentId === ROOT` ), "drag a card onto the 'All' crumb moves it (target lit)" );
    // …and onto a folder card.
    await c.evaluate( "goFolder(ROOT); true" );
    await c.evaluate( dragJs( `.bm-item[data-id="${bid}"]`, `.bm-item.is-folder[data-id="${dev}"]` ) );
    ok( await c.evaluate( `node('${bid}').parentId === '${dev}'` ), "drag a card onto a folder card" );

    console.log( "TREE REORDER" );
    // A drag onto the top / bottom edge of a tree row puts a folder before /
    // after it; the middle puts it inside. y is where the pointer is.
    const treeDrag = ( srcSel, dstSel, zone ) => `( () => {
        const s = document.querySelector(${JSON.stringify( srcSel )}), d = document.querySelector(${JSON.stringify( dstSel )});
        const r = d.getBoundingClientRect(), x = r.left + 30;
        const y = r.top + r.height * ${zone === "before" ? 0.1 : zone === "after" ? 0.9 : 0.5};
        const dt = new DataTransfer();
        s.dispatchEvent( new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }) );
        d.dispatchEvent( new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }) );
        const marks = [ 'drop-before', 'drop-after', 'drop-target' ].filter( k => d.classList.contains( k ) );
        d.dispatchEvent( new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }) );
        s.dispatchEvent( new DragEvent('dragend',   { bubbles: true, dataTransfer: dt }) );
        return marks; } )()`;
    const row = id => `.tree-row[data-id="${id}"]`;
    await c.evaluate( "goFolder(ROOT); [ 'TA', 'TB', 'TC' ].forEach( function( n ) { makeFolder( n, ROOT ); } ); save(); render(); true" );
    const T3 = JSON.parse( await c.evaluate( "JSON.stringify( Object.fromEntries( [ 'TA', 'TB', 'TC' ].map( n => [ n, Object.values( data.nodes ).find( x => x.title === n ).id ] ) ) )" ) );
    const order = id => c.evaluate( `node('${id}').children.map( node ).filter( n => /^T[ABC]$/.test( n.title ) ).map( n => n.title ).join()` );

    let marks = await c.evaluate( treeDrag( row( T3.TC ), row( T3.TA ), "before" ) );
    ok( marks.join() === "drop-before" && await order( "root" ) === "TC,TA,TB", "top edge of a row: before it (a line on top)", { marks, order: await order( "root" ) } );
    marks = await c.evaluate( treeDrag( row( T3.TC ), row( T3.TB ), "after" ) );
    ok( marks.join() === "drop-after" && await order( "root" ) === "TA,TB,TC", "bottom edge: after it (a line below)", { marks, order: await order( "root" ) } );
    marks = await c.evaluate( treeDrag( row( T3.TA ), row( T3.TB ), "inside" ) );
    ok( marks.join() === "drop-target" && await c.evaluate( `node('${T3.TA}').parentId === '${T3.TB}'` ), "middle: inside it, as before" );
    await c.evaluate( `toggleOpen( '${T3.TB}', true ); renderTree(); true` );
    await c.evaluate( treeDrag( row( T3.TC ), row( T3.TB ), "after" ) );
    ok( await order( T3.TB ) === "TC,TA", "bottom edge of an OPEN folder: its first place inside", await order( T3.TB ) );
    await c.evaluate( "window.__toasts = []; true" );
    marks = await c.evaluate( treeDrag( row( T3.TB ), row( T3.TA ), "before" ) );
    ok( ! marks.length && await c.evaluate( `node('${T3.TB}').parentId === ROOT` ), "next to its own subfolder: refused, no line, nothing moves" );
    ok( await c.evaluate( "window.__toasts.some( t => /cannot go inside itself/.test( t ) )" ), "…and the error toast" );
    await c.evaluate( "window.__toasts = []; true" );
    await c.evaluate( treeDrag( row( T3.TC ), row( T3.TC ), "before" ) );
    ok( await order( T3.TB ) === "TC,TA" && await c.evaluate( "window.__toasts.length === 0" ), "onto its own edge: nothing happens, no toast" );
    await c.evaluate( `goFolder('${dev}'); true` );
    marks = await c.evaluate( treeDrag( `.bm-item[data-id="${bid}"]`, row( T3.TB ), "before" ) );
    ok( marks.join() === "drop-target" && await c.evaluate( `node('${bid}').parentId === '${T3.TB}'` ), "a bookmark card on a row's edge goes inside (only folders reorder)" );
    await c.evaluate( `moveNodes( [ '${bid}' ], '${dev}' ); save(); render(); true` );
    await flushed( c );
    const onDisk = JSON.parse( fs.readFileSync( FILE, "utf8" ) );
    ok( onDisk.nodes[ T3.TB ].children.filter( id => onDisk.nodes[ id ].type === "folder" ).map( id => onDisk.nodes[ id ].title ).join() === "TC,TA", "the new order is saved" );

    console.log( "OPEN / TAG / SEARCH" );
    await c.evaluate( `window.__opened = []; window.open = function( u ) { window.__opened.push( u ); return null; }; goFolder('${dev}'); document.querySelector('.bm-item[data-id="${bid}"] .bm-title').click(); true` );
    ok( await c.evaluate( `window.__opened.length === 0 && browse.ids().join() === '${bid}'` ), "a click picks the card (it does not open it)" );
    await c.evaluate( `document.querySelector('.bm-item[data-id="${bid}"] .bm-title').dispatchEvent( new MouseEvent('dblclick', { bubbles: true }) ); true` );
    ok( await c.evaluate( "window.__opened[0] === 'https://example.com/'" ), "a double-click opens the link" );
    await c.evaluate( `document.querySelector('.bm-item[data-id="${bid}"] .bm-tag').click(); true` );
    ok( await c.evaluate( "query === '#docs' && document.querySelectorAll('#items .bm-item').length === 1 && window.__opened.length === 1" ), "a tag chip searches that tag (and does not open the link)" );
    await c.evaluate( "setQuery('EXÁMPLE'); true" );
    ok( await c.evaluate( "document.querySelectorAll('#items .bm-item:not(.is-folder)').length === 1 && !!document.querySelector('#items .bm-path')" ), "accent-insensitive search, with folder path" );
    ok( await c.evaluate( "document.querySelector('.search-fold').classList.contains('is-open') && !!document.querySelector('.search-fold .search-shut')" ), "while searching: the field is open, with its ×" );
    await c.evaluate( "setQuery('zzzqqq'); true" );
    ok( await c.evaluate( "!document.getElementById('emptyHint').hidden && !document.querySelector('#emptyHint [data-empty]')" ), "no results: no big button" );
    await c.evaluate( "document.querySelector('.search-fold .search-shut').click(); true" );
    ok( await c.evaluate( "query === '' && !document.querySelector('.search-fold').classList.contains('is-open')" ), "× clears it and folds the field" );
    await c.evaluate( "setQuery('EXÁMPLE'); true" );
    await c.evaluate( "document.getElementById('searchInput').focus(); document.dispatchEvent( new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) ); document.getElementById('searchInput').dispatchEvent( new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) ); true" );
    ok( await c.evaluate( "query === ''" ), "Esc clears the search" );
    await c.evaluate( "document.activeElement.blur(); document.dispatchEvent( new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }) ); true" );
    ok( await c.evaluate( "document.activeElement.id === 'searchInput'" ), "Ctrl+/ focuses the search" );

    console.log( "DELETE + UNDO" );
    await c.evaluate( `window.__toasts = []; deleteNodes( ['${bid}'] ); true` );
    ok( await c.evaluate( `!node('${bid}') && document.getElementById('toast').classList.contains('actionable')` ), "bookmark deleted at once, with Undo" );
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    ok( await c.evaluate( `!!node('${bid}')` ), "Undo brings it back" );
    await c.evaluate( `deleteNodes( ['${dev}'] ); true` );
    ok( await c.evaluate( "!document.querySelector('.sheet-backdrop.open[role=dialog]')" ), "folder delete does not ask (Undo instead)" );
    ok( await waitFor( c, `!node('${dev}') && !node('${fe}') && !node('${bid}')` ), "folder + contents deleted" );
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    ok( await c.evaluate( `!!node('${dev}') && !!node('${fe}') && !!node('${bid}') && node('${fe}').parentId === '${dev}'` ), "Undo restores the whole folder" );
    await flushed( c );

    console.log( "IMPORT (Chrome- and Firefox-shaped exports)" );
    async function importFixture( file, mode )
    {
        // value = '': the same file twice in a row would fire no "change".
        await c.evaluate( `NayiveUI.open('importBackdrop'); document.getElementById('importInput').value = ''; document.querySelector('input[name=importMode][value=${mode}]').checked = true; true` );
        const doc = await c.send( "DOM.getDocument", {} );
        const q = await c.send( "DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#importInput" } );
        await c.send( "DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [ file ] } );
    }
    await c.evaluate( "window.__toasts = []; true" );
    let firstImport = true;
    for( const file of [ path.join( FX, "chrome.html" ), path.join( FX, "firefox.html" ), ...EXTRA ] )
    {
        const want = expected( file ), name = path.basename( file );
        const b0 = await c.evaluate( counts );
        await importFixture( file, "add" );
        ok( await waitFor( c, `${counts}.b === ${b0.b} + ${want.b}` ), `${name}: ${want.b} bookmarks added`, await c.evaluate( counts ) );
        ok( await c.evaluate( `${counts}.f === ${b0.f} + ${want.f} + 1` ), `…in its ${want.f} folders (+ the 'Imported' one)`, await c.evaluate( counts ) );
        if( firstImport )
        {
            const said = `Import finished: ${want.b} bookmarks` + ( want.f ? `, ${want.f} folder${want.f === 1 ? "" : "s"}` : "" );
            ok( await c.evaluate( `window.__toasts.some( t => t.indexOf( ${JSON.stringify( said )} ) === 0 )` ), "result toast", await c.evaluate( "window.__toasts" ) );
            await sleep( 700 );
            const dupes = await c.evaluate( "findDuplicates().length" );
            ok( ! dupes || await c.evaluate( "document.getElementById('dupBackdrop').classList.contains('open')" ), "duplicates sheet opens after an import (when there are any)", dupes );
            await shot( c, "02-import-pc" );
            firstImport = false;
        }
        await sleep( 500 );
        await c.evaluate( "NayiveUI.close('dupBackdrop'); true" );
    }

    const b3 = await c.evaluate( counts );
    await importFixture( `${FX}/firefox-shapes.html`, "add" );
    ok( await waitFor( c, `${counts}.b === ${b3.b} + 3` ), "Firefox shapes: place:/javascript: skipped", await c.evaluate( counts ) );
    const mdn = JSON.parse( await c.evaluate( "JSON.stringify( allBookmarks().find( b => b.title === 'MDN Web Docs' ) )" ) );
    ok( mdn && mdn.tags.join() === "docs,web" && mdn.notes === "The reference for the web" && mdn.createdAt === "2020-09-13T12:26:40Z", "TAGS -> tags, <DD> -> notes, ADD_DATE seconds", mdn );
    ok( await c.evaluate( `node( allBookmarks().find( b => b.title === 'MDN Web Docs' ).parentId ).title === 'Reading & Docs'` ), "a folder whose <DL> sits inside its <DD>" );
    ok( await c.evaluate( "allBookmarks().find( b => b.title === 'Example again' ).createdAt.slice( 0, 4 ) === '2023'" ), "microsecond ADD_DATE" );
    ok( await c.evaluate( "allBookmarks().some( b => b.title === 'Example <home>' )" ), "entities in titles" );
    await c.evaluate( "NayiveUI.close('dupBackdrop'); true" );

    console.log( "EXPORT -> RE-IMPORT" );
    const all1 = await c.evaluate( counts );
    const html = await c.evaluate( "toNetscape()" );
    fs.writeFileSync( `${RUN}/exported.html`, html );
    ok( /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/.test( html ) && /<DT><H3 ADD_DATE="\d+">/.test( html ), "export is a Netscape file" );
    const re = await c.evaluate( `( () => { const t = parseNetscape( ${JSON.stringify( html )} ); return countTree( t.items ); } )()` );
    ok( re.bookmarks === all1.b && re.folders === all1.f, "exported HTML parses back to the same counts", { re, all1 } );
    const json = await c.evaluate( "serialize()" );
    const rj = await c.evaluate( `countTree( parseOwnJson( ${JSON.stringify( json )} ).items )` );
    ok( rj.bookmarks === all1.b && rj.folders === all1.f, "JSON backup parses back to the same counts" );
    ok( await c.evaluate( `parseOwnJson( ${JSON.stringify( json )} ).items.length > 0 && JSON.stringify( parseOwnJson( ${JSON.stringify( json )} ) ).indexOf( '"favorite":true' ) > 0` ), "JSON keeps favourites" );
    // Real round trip through the importer, in Add mode.
    await importFixture( `${RUN}/exported.html`, "add" );
    ok( await waitFor( c, `${counts}.b === ${all1.b} * 2` ), "export → import doubles the bookmarks exactly", await c.evaluate( counts ) );
    await c.evaluate( "NayiveUI.close('dupBackdrop'); true" );

    console.log( "DUPLICATES" );
    const groups = await c.evaluate( "findDuplicates().length" );
    const keys = await c.evaluate( "new Set( allBookmarks().map( b => dupKey( b.url ) ) ).size" );
    ok( groups > 0, "duplicates found after the double import", groups );
    const ex = await c.evaluate( "findDuplicates().find( g => g.items.some( b => b.url === 'https://www.example.com/' ) ).items.map( b => b.url )" );
    // The import already normalises each address (host case, the root's "/"),
    // so the fixture's www / http / case / trailing variants arrive as these.
    ok( ex.includes( "https://www.example.com/" ) && ex.includes( "http://example.com/" ) && ex.includes( "https://example.com/" ), "www / http / case / trailing / count as the same", ex );
    await c.evaluate( "openDupSheet(); true" );
    ok( await c.evaluate( "document.getElementById('dupBackdrop').classList.contains('open') && document.querySelectorAll('.dup-group').length === findDuplicates().length" ), "duplicates sheet lists the groups" );
    const beforeDup = await c.evaluate( counts );
    await c.evaluate( "document.getElementById('dupRemoveBtn').click(); true" );
    ok( await c.evaluate( "findDuplicates().length === 0 && allBookmarks().length === " + keys ), "one button removes the rest (one per address left)" );
    const mdnTags = await c.evaluate( "allBookmarks().filter( b => b.url === 'https://developer.mozilla.org/' ).length" );
    ok( mdnTags === 1, "one MDN left", mdnTags );
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    ok( JSON.stringify( await c.evaluate( counts ) ) === JSON.stringify( beforeDup ), "Undo puts them back" );
    await c.evaluate( "document.getElementById('dupRemoveBtn').click(); true" );
    await c.evaluate( "window.__toasts = []; openDupSheet(); true" );
    ok( await waitFor( c, "window.__toasts.includes('No duplicates')", 3000 ), "'No duplicates' toast", await c.evaluate( "window.__toasts" ) );

    console.log( "REPLACE ALL" );
    const beforeReplace = await c.evaluate( counts );
    await importFixture( `${FX}/firefox-shapes.html`, "replace" );
    ok( await waitFor( c, "document.querySelector('.sheet-backdrop.open[role=dialog]')" ), "Replace all asks (danger)" );
    await c.evaluate( "document.querySelector('.sheet-backdrop.open:not([id]) .sheet-actions button:last-child').click(); true" );
    ok( await waitFor( c, `JSON.stringify( ${counts} ) === JSON.stringify( { b: 3, f: 2 } )` ), "Replace all leaves only the file's bookmarks", await c.evaluate( counts ) );
    await c.evaluate( "NayiveUI.close('dupBackdrop'); document.querySelector('#toast .toast-undo') && document.querySelector('#toast .toast-undo').click(); true" );
    ok( JSON.stringify( await c.evaluate( counts ) ) === JSON.stringify( beforeReplace ), "…and Undo brings everything back", await c.evaluate( counts ) );
    await flushed( c );
    ok( diskCounts() && diskCounts().b === ( await c.evaluate( counts ) ).b, "disk file matches", diskCounts() );

    console.log( "SELECTION (the shared item browser)" );
    await c.evaluate( "goFolder(ROOT); browse.clear(); true" );
    const card = i => `document.querySelectorAll('#items .bm-item')[${i}]`;
    await c.evaluate( `${card(0)}.click(); ${card(2)}.dispatchEvent( new MouseEvent('click', { bubbles: true, ctrlKey: true }) ); true` );
    ok( await c.evaluate( "browse.ids().length === 2 && document.querySelectorAll('#items .bm-item.is-selected').length === 2" ), "click + Ctrl+click pick two" );
    ok( await c.evaluate( "!document.getElementById('selActions').hidden && /2/.test( document.querySelector('#selActions .sel-count').textContent ) && !document.getElementById('filterRow').hidden" ), "the header group shows the count; the pills stay" );
    await c.evaluate( `${card(0)}.click(); ${card(3)}.dispatchEvent( new MouseEvent('click', { bubbles: true, shiftKey: true }) ); true` );
    ok( await c.evaluate( "browse.ids().length === 4" ), "Shift+click picks a range" );
    await c.evaluate( "document.querySelector('#selActions [data-sel=all]').click(); true" );
    ok( await c.evaluate( "browse.ids().length === document.querySelectorAll('#items .bm-item').length && browse.ids().length > 0" ), "Select all" );
    await c.evaluate( "document.body.focus(); document.dispatchEvent( new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) ); true" );
    ok( await c.evaluate( "!browse.ids().length && document.getElementById('selActions').hidden" ), "Esc clears the pick" );
    await c.evaluate( `${card(0)}.dispatchEvent( new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }) ); true` );
    ok( await c.evaluate( "browse.ids().length === 1 && !document.querySelector('.item-menu').hidden && !!document.querySelector('.item-menu [data-act=delete]')" ), "right-click picks that card and opens the same menu" );
    await c.evaluate( "NayiveUI.closeMenu(); document.getElementById('items').dispatchEvent( new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }) ); true" );
    ok( await c.evaluate( "!document.querySelector('.item-menu').hidden && !!document.querySelector('.item-menu [data-act=add]') && !!document.querySelector('.item-menu [data-act=selectAll]')" ), "right-click on empty space: New bookmark, New folder, Select all" );
    await c.evaluate( "NayiveUI.closeMenu(); browse.clear(); true" );

    console.log( "VIEWS / FILTERS / LAYOUT" );
    await c.evaluate( "document.querySelector('#filterRow [data-filter=fav]').click(); true" );
    ok( await c.evaluate( "document.querySelectorAll('#items .bm-item').length === allBookmarks().filter( b => b.favorite ).length" ), "Favourites filter" );
    await c.evaluate( "document.querySelector('#filterRow [data-filter=recent]').click(); true" );
    ok( await c.evaluate( "document.querySelectorAll('#items .bm-item').length === 15" ), "Recent = 15 newest" );
    await c.evaluate( "document.querySelector('#filterRow [data-filter=all]').click(); document.getElementById('listBtn').click(); true" );
    ok( await c.evaluate( "document.getElementById('items').classList.contains('is-list') && document.getElementById('listBtn').classList.contains('is-active')" ), "list mode" );
    await shot( c, "03-list-pc-light" );
    await c.evaluate( "document.getElementById('gridBtn').click(); true" );
    ok( await c.evaluate( "JSON.parse( localStorage.getItem('balata-bookmarks-ui') ).mode === 'grid'" ), "view choice kept on this device" );
    ok( await c.evaluate( "document.documentElement.scrollWidth <= innerWidth" ), "PC: no sideways scroll" );
    // Icons: some image loaded over the initial.
    await c.evaluate( "goFolder( Object.values( data.nodes ).find( n => n.title === 'Util' ).id ); true" );
    await sleep( 6000 );
    const icons = await c.evaluate( "Array.from( document.querySelectorAll('.bm-ic img') ).filter( i => i.complete && i.naturalWidth > 0 ).length" );
    ok( icons > 0, "site icons load over the initials", icons );
    ok( await c.evaluate( "noIcon.size > 0 && document.querySelectorAll('.bm-ic img').length < document.querySelectorAll('.bm-item:not(.is-folder)').length" ), "a site with no icon (204) keeps its initial", await c.evaluate( "noIcon.size" ) );
    await shot( c, "04-folder-icons-pc-light" );
    ok( await c.evaluate( "document.querySelectorAll('.bm-ic img.ok').length > 0 && Array.from( document.querySelectorAll('.bm-ic img:not(.ok)') ).every( i => getComputedStyle( i ).opacity === '0' )" ),
        "#20 an icon shows once loaded; until then the initial does" );

    console.log( "PHASE B (docs/audit/bookmarks.md)" );
    await c.evaluate( "goFolder(ROOT); window.__toasts = []; true" );
    ok( await c.evaluate( "normalizeUrl('nas.local:5000') === 'https://nas.local:5000/' && normalizeUrl('localhost:3000/x') === 'https://localhost:3000/x' && normalizeUrl('mailto:a@b.c') === 'mailto:a@b.c' && normalizeUrl('http:example.com') === 'http://example.com/'" ),
        "#1 'nas.local:5000' is a host, not a scheme" );
    ok( await c.evaluate( "repair( { nodes: { root: { type: 'folder', children: [ 'x' ] }, x: { type: 'bookmark', url: 'nas.local:5000', title: 'NAS' } } } ).nodes.x.url === 'https://nas.local:5000/'" ),
        "#1 …and one saved the old way is mended on load" );
    ok( await c.evaluate( "normalizeUrl('java\\tscript:alert(1)') === null && normalizeUrl('javascript://%0aalert(1)') === null && normalizeUrl(' JAVASCRIPT:alert(1)') === null && normalizeUrl('data:text/html,x') === null" ),
        "#8 script links refused however they are spelled" );
    const jsImp = await c.evaluate( "( () => { const a = parseNetscape( '<DL><p><DT><A HREF=\"java&#9;script:alert(1)\">x</A><DT><A HREF=\"https://ok.example/\">ok</A></DL>' ); const b = parseOwnJson( JSON.stringify( { nodes: { root: { type: 'folder', children: [ 'j' ] }, j: { type: 'bookmark', url: 'javascript:alert(1)' } } } ) ); return [ a.items.length, a.skipped, b.items.length, b.skipped ].join(); } )()" );
    ok( jsImp === "1,1,0,1", "#8 imports (HTML and JSON) skip script links and count them", jsImp );
    await c.evaluate( "window.__toasts = []; ( () => { const b = makeBookmark( { url: 'chrome://settings/', title: 'C' }, ROOT ); openLink( b.id ); removeNodes( [ b.id ] ); } )(); true" );
    ok( await c.evaluate( "window.__toasts.some( t => /cannot be opened/.test( t ) )" ), "#8 a card opens only web / mail / phone addresses" );

    // #2: Undo puts back only what the delete took.
    const u2 = JSON.parse( await c.evaluate( "( () => { const a = makeBookmark( { url: 'https://undo-a.example/', title: 'UA' }, ROOT ), b = makeBookmark( { url: 'https://undo-b.example/', title: 'UB' }, ROOT ); save(); render(); return JSON.stringify( [ a.id, b.id, node( ROOT ).children.indexOf( a.id ) ] ); } )()" ) );
    await c.evaluate( `deleteNodes( [ '${u2[ 0 ]}' ] ); toggleFavourite( '${u2[ 1 ]}' ); true` );
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    ok( await c.evaluate( `!!node('${u2[ 0 ]}') && node( ROOT ).children.indexOf( '${u2[ 0 ]}' ) === ${u2[ 2 ]} && node('${u2[ 1 ]}').favorite === true` ),
        "#2 Undo brings the bookmark back to its place and keeps the star given after" );

    ok( await c.evaluate( "( () => { const flat = l => l.flatMap( i => i.folder ? flat( i.items ) : [ i ] ); const b = makeBookmark( { url: 'https://notes.example/', title: 'N', notes: 'first line\\nsecond line' }, ROOT ); const html = toNetscape(); removeNodes( [ b.id ] ); const back = flat( parseNetscape( html ).items ).find( i => i.url === 'https://notes.example/' ); return !! back && back.notes === 'first line\\nsecond line'; } )()" ),
        "#3 export → import keeps a note's lines" );

    // #6: a tag chip matches its tag whole.
    await c.evaluate( "makeBookmark( { url: 'https://zq1.example/', title: 'Z1', tags: 'zq' }, ROOT ); makeBookmark( { url: 'https://zq2.example/', title: 'Z2', tags: 'zqx, zq one' }, ROOT ); save(); setQuery( '#zq', 'zq' ); true" );
    ok( await c.evaluate( "document.querySelectorAll('#items .bm-item').length === 1" ), "#6 the chip #zq is not #zqx" );
    await c.evaluate( "( () => { const i = document.getElementById('searchInput'); i.value = '#zq'; i.dispatchEvent( new Event('input') ); } )(); true" );
    await sleep( 250 );
    ok( await c.evaluate( "document.querySelectorAll('#items .bm-item').length === 2" ), "#6 …a typed #zq still finds both" );
    await c.evaluate( "setQuery( '#zq one', 'zq one' ); true" );
    ok( await c.evaluate( "document.querySelectorAll('#items .bm-item').length === 1" ), "#6 …and 'zq one' is one tag, not two words" );
    await c.evaluate( "setQuery( '' ); true" );

    ok( await c.evaluate( "( () => { const mine = makeFolder( 'Mine9', ROOT ); const filed = makeBookmark( { url: 'https://filed.example/', title: 'F' }, mine.id ); const imp = makeFolder( 'Imported9', ROOT ); makeBookmark( { url: 'https://filed.example/', title: 'F', createdAt: '2015-01-01T00:00:00Z' }, imp.id ); const g = findDuplicates( imp.id ).find( g => g.items.some( b => b.id === filed.id ) ); const r = g.keep === filed.id; removeNodes( [ mine.id, imp.id ] ); return r; } )()" ),
        "#9 duplicates keep the copy you filed, not the (older) imported one" );

    ok( await c.evaluate( "( () => { const b = makeBookmark( parseNetscape( '<DL><p><DT><A HREF=\"https://nodate.example/\">n</A></DL>' ).items[ 0 ], ROOT ); const known = allBookmarks().find( x => x.createdAt ); filter = 'recent'; const inRecent = visibleItems().items.includes( b ); filter = 'all'; const r = b.createdAt === '' && ! inRecent && byDate( true )( b, known ) > 0 && ! /ADD_DATE/.test( toNetscape().split( '\\n' ).find( l => l.includes( 'nodate.example' ) ) ); removeNodes( [ b.id ] ); return r; } )()" ),
        "#15 no date in the file: unknown, not 'now' (not recent, last by date, none exported)" );

    ok( await c.evaluate( "( () => { const keep = data; data = emptyData(); loaded = false; render(); const t = document.getElementById('emptyHint').textContent, btn = !! document.querySelector('#emptyHint [data-empty]'); data = keep; loaded = true; render(); return /could not be read/.test( t ) && ! btn; } )()" ),
        "#18 file not read: says so, offers nothing" );
    ok( await c.evaluate( "( () => { const keep = data; data = emptyData(); makeFolder( 'F', ROOT ); filter = 'recent'; render(); const t = document.getElementById('emptyHint').textContent; filter = 'all'; data = keep; render(); return /No recent bookmarks/.test( t ); } )()" ),
        "#16 Recent with nothing in it has its own words" );
    ok( await c.evaluate( "( () => { const b = allBookmarks()[ 0 ], was = b.favorite; loaded = false; toggleFavourite( b.id ); const same = node( b.id ).favorite === was; loaded = true; return same; } )()" ),
        "#17 not read: an edit changes nothing, not even the screen" );
    await c.evaluate( "window.__toasts = []; ( () => { const b = allBookmarks()[ 0 ]; doMove( [ b.id ], b.parentId ); } )(); true" );
    ok( await c.evaluate( "window.__toasts.length === 0" ), "#19 'Move here' on its own folder: nothing said", await c.evaluate( "window.__toasts" ) );
    const self19 = await c.evaluate( "( () => { const f = makeFolder( 'Self19', ROOT ); save(); goFolder( ROOT ); window.__toasts = []; return f.id; } )()" );
    await c.evaluate( dragJs( `.bm-item.is-folder[data-id="${self19}"]`, `.bm-item.is-folder[data-id="${self19}"]` ) );
    ok( await c.evaluate( "window.__toasts.length === 0" ), "#19 a folder dropped on itself: no error toast", await c.evaluate( "window.__toasts" ) );

    await c.evaluate( "openBookmarkSheet( null ); true" );
    await sleep( 150 );
    ok( await c.evaluate( "document.activeElement.id === 'bmUrl'" ), "#21 a new bookmark starts in the address field" );
    await c.evaluate( "NayiveUI.close('bmBackdrop'); true" );

    // #12: saved before the page's title came - it still lands.
    await c.evaluate( "window.__realFetch = window.fetch; window.fetch = function( u, o ) { if( /\\/api\\/bookmarks\\/title/.test( String( u ) ) ) return new Promise( r => setTimeout( () => r( new Response( JSON.stringify( { title: 'Late title' } ), { headers: { 'Content-Type': 'application/json' } } ) ), 800 ) ); return window.__realFetch( u, o ); }; true" );
    await c.evaluate( "( () => { openBookmarkSheet( null ); const u = document.getElementById('bmUrl'); u.value = 'https://late-title.example/page'; u.dispatchEvent( new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) ); } )(); true" );
    ok( await c.evaluate( "!document.getElementById('bmBackdrop').classList.contains('open') && allBookmarks().some( b => b.url === 'https://late-title.example/page' && b.title === 'late-title.example' )" ),
        "#12 Enter saves at once, with the domain…" );
    ok( await waitFor( c, "allBookmarks().some( b => b.url === 'https://late-title.example/page' && b.title === 'Late title' )", 4000 ), "#12 …and the page's own title lands after" );
    await c.evaluate( "window.fetch = window.__realFetch; true" );

    const tk = await c.evaluate( "( () => { const f = makeFolder( 'KeyA', ROOT ); makeFolder( 'KeyB', f.id ); toggleOpen( f.id, false ); render(); focusTreeRow( f.id ); const key = k => document.activeElement.dispatchEvent( new KeyboardEvent('keydown', { key: k, bubbles: true }) ); key( 'ArrowRight' ); const opened = ui.open.includes( f.id ); key( 'ArrowRight' ); const inKid = node( document.activeElement.dataset.id ).title === 'KeyB'; key( 'ArrowLeft' ); const up = document.activeElement.dataset.id === f.id; key( 'ArrowLeft' ); const closed = ! ui.open.includes( f.id ); removeNodes( [ f.id ] ); save(); render(); return [ opened, inKid, up, closed ].join(); } )()" );
    ok( tk === "true,true,true,true", "#25 the tree answers the arrow keys", tk );
    ok( await c.evaluate( "parseFloat( getComputedStyle( document.querySelector('.tree-row .twisty') ).width ) >= 24" ), "#25 the twisty is a 24 px target" );

    await flushed( c );
    await c.evaluate( "ui.open.push( 'f_gone' ); saveUi(); true" );
    await c.evaluate( "loadData()" );
    ok( await c.evaluate( "! ui.open.includes( 'f_gone' ) && ! JSON.parse( localStorage.getItem('balata-bookmarks-ui') ).open.includes( 'f_gone' )" ), "#26 open-folder memory forgets folders that are gone" );

    // #27 Add has an Undo; #28 removing copies also removes the folders it empties.
    const b27 = await c.evaluate( counts );
    await importFixture( `${FX}/firefox-shapes.html`, "add" );
    ok( await waitFor( c, `${counts}.b === ${b27.b} + 3` ), "#27 the file is added", { b27, now: await c.evaluate( counts ), t: await c.evaluate( "window.__toasts" ) } );
    await c.evaluate( "NayiveUI.close('dupBackdrop'); document.querySelector('#toast .toast-undo').click(); true" );
    await sleep( 600 );
    await c.evaluate( "NayiveUI.close('dupBackdrop'); true" );
    ok( JSON.stringify( await c.evaluate( counts ) ) === JSON.stringify( b27 ), "#27 'Add them in a new folder' has an Undo", await c.evaluate( counts ) );
    await c.evaluate( "window.__toasts = []; true" );
    await importFixture( `${FX}/firefox-shapes.html`, "add" );
    await waitFor( c, `${counts}.b === ${b27.b} + 3` );
    ok( await waitFor( c, "document.getElementById('dupBackdrop').classList.contains('open')", 3000 ), "#28 the copies sheet opens" );
    await c.evaluate( "window.__toasts = []; document.getElementById('dupRemoveBtn').click(); true" );
    // The fixture: Imported › { Reading & Docs › 2 links, Empty › nothing, 1 link }. Reading & Docs
    // goes (emptied by the removal); "Empty" was empty in the browser too and stays, so its
    // "Imported" folder stays with it.
    ok( JSON.stringify( await c.evaluate( counts ) ) === JSON.stringify( { b: b27.b, f: b27.f + 2 } ) && await c.evaluate( "window.__toasts.some( t => /1 empty folder removed/.test( t ) )" ),
        "#28 …the copies go, and so do the folders they leave empty (said in the toast)", { now: await c.evaluate( counts ), b27, t: await c.evaluate( "window.__toasts" ) } );
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    ok( JSON.stringify( await c.evaluate( counts ) ) === JSON.stringify( { b: b27.b + 3, f: b27.f + 3 } ), "#28 …and Undo puts copies and folders back", await c.evaluate( counts ) );
    await c.evaluate( "openDupSheet(); document.getElementById('dupRemoveBtn').click(); removeNodes( [ node( ROOT ).children[ node( ROOT ).children.length - 1 ] ] ); save(); render(); true" );

    // #30 Export into a Nayive folder (the picker answers "files").
    await c.evaluate( "window.__pick = NayiveUI.pickFolder; NayiveUI.pickFolder = function() { return Promise.resolve( 'files' ); }; document.querySelector('input[name=exportWhere][value=nayive]').checked = true; NayiveUI.open('exportBackdrop'); document.getElementById('exportHtmlBtn').click(); true" );
    await waitFor( c, "!document.getElementById('exportBackdrop').classList.contains('open')", 5000 );
    await c.evaluate( "NayiveUI.open('exportBackdrop'); document.getElementById('exportJsonBtn').click(); true" );
    await waitFor( c, "!document.getElementById('exportBackdrop').classList.contains('open')", 5000 );
    await c.evaluate( "NayiveUI.open('exportBackdrop'); document.getElementById('exportJsonBtn').click(); true" );
    await waitFor( c, "!document.getElementById('exportBackdrop').classList.contains('open')", 5000 );
    const saved = fs.readdirSync( `${RUN}/homes/test/files` ).filter( n => /^bookmarks-/.test( n ) ).sort();
    ok( saved.length === 3 && saved.some( n => /\.html$/.test( n ) ) && saved.some( n => / \(2\)\.json$/.test( n ) ), "#30 Export can save into a Nayive folder (a name taken gets (2))", saved );
    await c.evaluate( "NayiveUI.pickFolder = window.__pick; document.querySelector('input[name=exportWhere][value=device]').checked = true; NayiveUI.open('exportBackdrop'); true" );
    await shot( c, "11-export-sheet" );
    await c.evaluate( "NayiveUI.close('exportBackdrop'); NayiveUI.open('bmletBackdrop'); true" );
    await shot( c, "12-save-from-any-page" );
    await c.evaluate( "NayiveUI.close('bmletBackdrop'); true" );

    // #10: another device changed the file since this page last read it.
    console.log( "TWO DEVICES" );
    await flushed( c );
    const xId = await c.evaluate( "( () => { const x = makeBookmark( { url: 'https://gone-here.example/', title: 'X' }, ROOT ); save(); return x.id; } )()" );
    await flushed( c );
    await sleep( 1100 );                                       // the server's clock is in whole seconds
    const disk = JSON.parse( fs.readFileSync( FILE, "utf8" ) );
    disk.nodes.yPhone = { id: "yPhone", title: "Y", type: "bookmark", parentId: "root", url: "https://from-phone.example/", tags: [], notes: "", favorite: false, createdAt: "2026-01-01T00:00:00Z" };
    disk.nodes.root.children.push( "yPhone" );
    fs.writeFileSync( FILE, JSON.stringify( disk, null, 2 ) );
    await c.evaluate( `window.__toasts = []; removeNodes( [ '${xId}' ] ); makeBookmark( { url: 'https://from-pc.example/', title: 'Z' }, ROOT ); save(); true` );
    ok( await waitFor( c, "window.__toasts.some( t => /Merged/.test( t ) )", 10000 ), "#10 a save over another device's change is merged, not lost", await c.evaluate( "window.__toasts" ) );
    await flushed( c );
    const mergedUrls = Object.values( JSON.parse( fs.readFileSync( FILE, "utf8" ) ).nodes ).map( n => n.url ).filter( Boolean );
    ok( mergedUrls.includes( "https://from-phone.example/" ) && mergedUrls.includes( "https://from-pc.example/" ) && ! mergedUrls.includes( "https://gone-here.example/" ),
        "#10 …the file has both new links, and this PC's delete", mergedUrls.length );
    ok( await c.evaluate( "!! node( 'yPhone' ) && ! document.getElementById('syncIndicator').classList.contains('conflict')" ), "#10 …the screen shows it, and the plug is not stuck" );

    // #29 ?add= (the "Save from any page" button) and a link dropped in.
    await nav( c, APP + "?add=" + encodeURIComponent( "https://from-bookmarklet.example/x" ) + "&title=Hi%20there", "/nayive/bookmarks/index.html" );
    ok( await waitFor( c, "document.getElementById('bmBackdrop').classList.contains('open') && document.getElementById('bmUrl').value === 'https://from-bookmarklet.example/x' && document.getElementById('bmName').value === 'Hi there' && location.search === ''" ),
        "#29 ?add= opens the sheet with that page" );
    await c.evaluate( "NayiveUI.close('bmBackdrop'); true" );
    ok( await c.evaluate( "/^javascript:.*\\?add=/.test( document.getElementById('bmletLink').getAttribute('href') ) && topMenuItems().filter( i => i.id === 'bmlet' ).length === 1" ),
        "#29 …which the 'Save from any page' button (⋮) sends" );
    ok( await c.evaluate( "( () => { const dt = new DataTransfer(); dt.setData( 'text/uri-list', 'https://dropped.example/' ); dt.setData( 'text/html', '<a href=\"https://dropped.example/\">Dropped page</a>' ); const t = document.getElementById('items'); t.dispatchEvent( new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }) ); t.dispatchEvent( new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }) ); return document.getElementById('bmBackdrop').classList.contains('open') && document.getElementById('bmUrl').value === 'https://dropped.example/' && document.getElementById('bmName').value === 'Dropped page'; } )()" ),
        "#29 a link dropped from another tab opens the sheet with it" );
    await c.evaluate( "NayiveUI.close('bmBackdrop'); true" );


    // Dark.
    await c.evaluate( "localStorage.setItem('balata-theme','dark'); true" );
    await openApp( c );
    await c.evaluate( "goFolder( Object.values( data.nodes ).find( n => n.title === 'Util' ).id ); true" );
    await sleep( 1500 );
    ok( await c.evaluate( "document.documentElement.getAttribute('data-theme') !== 'light'" ), "dark scheme applied" );
    await shot( c, "05-folder-pc-dark" );

    // Phone widths.
    for( const w of [ 375, 320 ] )
    {
        await c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: 740, deviceScaleFactor: 2, mobile: true } );
        await openApp( c );
        const util = await c.evaluate( "Object.values( data.nodes ).find( n => n.title === 'Util' ).id" );
        await c.evaluate( `goFolder('${util}'); true` );
        await sleep( 800 );
        ok( await c.evaluate( "document.getElementById('treePane').getBoundingClientRect().right <= 0 && getComputedStyle( document.getElementById('treeBtn') ).display !== 'none'" ), `phone ${w}: tree off screen, folder button there` );
        await c.evaluate( "document.getElementById('treeBtn').click(); true" );
        ok( await c.evaluate( "document.getElementById('treePane').classList.contains('open') && !!document.querySelector('.tree-backdrop.open')" ), `phone ${w}: the folder button slides the tree in` );
        await c.evaluate( "treeView.closeSheet(); true" );
        ok( await c.evaluate( "!document.getElementById('upBtn').hidden" ), `phone ${w}: ← up inside a folder` );
        ok( await c.evaluate( "document.documentElement.scrollWidth <= innerWidth && document.getElementById('listPane').scrollWidth <= document.getElementById('listPane').clientWidth" ), `phone ${w}: no sideways scroll`,
            await c.evaluate( "[document.documentElement.scrollWidth, innerWidth, document.getElementById('listPane').scrollWidth, document.getElementById('listPane').clientWidth]" ) );
        // At 320 px the shared toolbar wraps its icons under the title (since 2026-09-30); that is fine.
        if( w > 320 ) ok( await c.evaluate( "document.querySelector('.topbar').getBoundingClientRect().height < 60" ), `phone ${w}: header on one row`, await c.evaluate( "document.querySelector('.topbar').getBoundingClientRect().height" ) );
        await shot( c, `06-phone-${w}-dark` );
        await c.evaluate( "document.getElementById('upBtn').click(); true" );
        ok( await c.evaluate( "curFolder !== '" + util + "'" ), `phone ${w}: ← goes up` );
    }
    await c.evaluate( "localStorage.setItem('balata-theme','light'); true" );
    await openApp( c );
    await c.evaluate( "document.getElementById('moreBtn').click(); true" );
    await shot( c, "07-phone-menu-light" );
    ok( await c.evaluate( "!! document.querySelector('.item-menu:not([hidden]) [data-act=\"mode:list\"]')" ), "phone: grid/list in the ⋮" );
    await c.evaluate( "document.body.click(); openBookmarkSheet( allBookmarks()[0].id ); true" );
    await shot( c, "08-phone-edit-sheet-light" );
    await c.evaluate( "NayiveUI.close('bmBackdrop'); true" );

    await c.evaluate( "document.querySelector('[data-intro-open]').click(); true" );
    ok( await waitFor( c, "[...document.querySelectorAll('.sheet-backdrop.open')].some( b => /Import, export/.test( b.textContent ) )", 4000 ), "? opens the help card with the toolbar rows" );
    await shot( c, "10-help-phone" );
    // 404: the first read of a new file; 412: the two-devices check (#10).
    const errs = c.logs.filter( l => /EXCEPTION|LOGERR|error/i.test( l ) && ! /(404|412) .*api\/files\?file=data%2Fbookmarks%2Fbookmarks\.json/.test( l ) ); console.log( errs.slice( 0, 12 ).join( "\n" ) );
    ok( errs.length === 0, "no console errors / exceptions", errs );
}
catch( e ) { fail++; console.log( "CRASH " + ( e.stack || e ) ); }
finally { c.kill(); }

// ---------------------------------------------------------------------------
// OFFLINE: the service worker on, then the network off, then a reload.
console.log( "OFFLINE RELOAD" );
const o = await launch( false );
try
{
    await o.send( "Network.enable" );
    await o.send( "Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false } );
    await signIn( o );
    await openApp( o );
    await waitFor( o, "navigator.serviceWorker.controller", 15000 ) || ( await openApp( o ) );
    await waitFor( o, "navigator.serviceWorker.controller", 15000 );
    await sleep( 4000 );                                   // the precache fills
    await openApp( o );
    // Touch: a long-press on a card opens its menu.
    await o.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
    const r = await o.evaluate( "( () => { const b = document.querySelector('.bm-item').getBoundingClientRect(); return { x: b.left + 40, y: b.top + 20 }; } )()" );
    await o.send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ { x: r.x, y: r.y } ] } );
    await sleep( 700 );
    await o.send( "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] } );
    ok( await o.evaluate( "document.querySelector('.bm-item').classList.contains('is-selected') && document.getElementById('items').classList.contains('is-picking')" ), "touch long-press starts picking (ticks on)" );
    ok( await o.evaluate( "document.querySelector('.bm-item').draggable === false" ), "no HTML5 drag on touch" );
    await o.evaluate( "browse.clear(); true" );
    const online = await o.evaluate( counts );
    await o.send( "Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    await openApp( o );
    await sleep( 1500 );
    const off = await o.evaluate( counts ).catch( () => null );
    ok( off && off.b === online.b && off.b > 0, "offline reload shows the same bookmarks", { online, off } );
    ok( await o.evaluate( "document.getElementById('syncIndicator').classList.contains('offline')" ).catch( () => false ), "plug says offline" );
    await shot( o, "09-offline" );
    const errs = o.logs.filter( l => /EXCEPTION/i.test( l ) );
    ok( errs.length === 0, "offline: no exceptions", errs );
}
catch( e ) { fail++; console.log( "CRASH " + ( e.stack || e ) ); }
finally { o.kill(); }

cleanup();
console.log( `\nScreenshots: ${SHOTS}` );
console.log( `${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
