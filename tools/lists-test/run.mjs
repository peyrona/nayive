// run.mjs - Ayni's lists family in Nayive (Ayni.list, Ayni.tree, Ayni.pickNode,
// Ayni's pick lists), in a real (headless) browser: the rules on every page,
// then what moving onto Ayni changed. The picking itself (mouse, keys, touch,
// drag, every app's actions) is tools/browser-test; this is the rest.
//
//   node tools/lists-test/run.mjs            (SHOTS=/some/dir also saves screenshots)
//
// Same scratch server as tools/search-test (its own run-root in /tmp, a copy of
// client/apps, a user "test" with a few files and a task, a second user "ana"
// to share with); the real store/ is never touched. Nothing is saved: the share
// and the plan sheet are closed without their ✓.
//
// RULES, every app, phone and desktop width: no old list API (NayiveUI.browser,
//   tree, pickNode, dropZone, glyph, tickHtml) and no old markup (.ntree,
//   .tree-row, .is-selected, .sel-group...); Ayni's family is loaded; every
//   navigation tree is a named ul; every .lb is a list box (Photos' lightbox is
//   not); a page's own [role=listbox] that is not Ayni's keeps its own look;
//   no error.
// BEHAVIOURS: Drive (a pick is the soft tint with an Accent tick, light and
//   dark; typing a letter jumps to a file; Move to… is the boxed tree, a click
//   lights a folder); Contacts' tree (arrows only move, Enter goes; on a phone
//   the sheet slides in, rows 40 px, Esc closes); Music's headings only open and
//   close, the triangle is a 24 px target; the share sheet's people (an Ayni
//   pick list; "Everybody" greys it and it takes no clicks); Tasks' plan sheet
//   (the siblings as an Ayni pick list); eMail's own list box keeps its look;
//   the form rows (Bookmarks duplicates, Contacts merge, Trips categories) are
//   Ayni check rows.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const APPS = fs.readdirSync( path.join( REPO, "client/apps" ) )
               .filter( d => fs.existsSync( path.join( REPO, "client/apps", d, "index.html" ) ) ).sort();

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "lists-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
for( const u of [ "test", "ana" ] )
{
    fs.mkdirSync( `${RUN}/homes/${u}/data`, { recursive: true } );
    fs.mkdirSync( `${RUN}/homes/${u}/files/Docs/Work`, { recursive: true } );
    fs.writeFileSync( `${RUN}/homes/${u}/data/config.json`, JSON.stringify( { password: u } ) );
}
for( const n of [ "apple.txt", "banana.txt", "cherry.txt" ] ) fs.writeFileSync( `${RUN}/homes/test/files/${n}`, n );
fs.writeFileSync( `${RUN}/homes/test/data/tasks.json`, JSON.stringify( [ { id: 1, text: "Move house", done: false, subtasks: [
    { id: 11, text: "Boxes", done: false, days: 2 }, { id: 12, text: "Van", done: false }, { id: 13, text: "Keys", done: false, after: [ 11 ] } ] } ] ) );
for( const a of [ "photos", "music", "movies" ] )
{
    fs.mkdirSync( `${RUN}/homes/test/data/${a}`, { recursive: true } );
    fs.writeFileSync( `${RUN}/homes/test/data/${a}/config.json`, JSON.stringify( { folder: "files" } ) );
}
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 500 ) ) );
};
const SHOTS = process.env.SHOTS || "";

// The rules, read off the page as it stands.
const RULES = `( () => { const o = [];
    if( window.NayiveUI && [ 'browser', 'tree', 'pickNode', 'dropZone', 'glyph', 'tickHtml' ].some( k => NayiveUI[ k ] ) ) o.push( 'old NayiveUI list API' );
    if( [ 'list', 'tree', 'pickNode', 'dropZone', 'dragIds', 'pickTick' ].some( k => typeof Ayni[ k ] !== 'function' ) ) return [ 'no Ayni lists family' ];
    const old = document.querySelector( '.ntree, .tree-row, .twisty, .tree-badge, .tree-fit, .pick-tree, .is-selected, .is-cursor, .nb-list, .is-picking, .sel-group, .sel-count, .drop-target, .share-user' );
    if( old ) o.push( 'old list markup: ' + ( old.id || old.className ) );
    for( const t of document.querySelectorAll( '[role="tree"][data-nav]' ) )
    {
        if( t.tagName !== 'UL' ) o.push( ( t.id || t.className ) + ': a tree that is not a ul' );
        if( ! t.getAttribute( 'aria-label' ) && ! t.getAttribute( 'aria-labelledby' ) ) o.push( ( t.id || t.className ) + ': a tree with no name' );
    }
    for( const l of document.querySelectorAll( '.lb' ) ) if( l.getAttribute( 'role' ) !== 'listbox' ) o.push( ( l.id || l.className ) + ': .lb that is not a list box' );
    for( const l of document.querySelectorAll( '[role="listbox"]:not(.lb)' ) )
        if( getComputedStyle( l ).maxHeight === '180px' ) o.push( ( l.id || l.className ) + ': a page list box with Ayni\\'s pick-list look' );
    return o; } )()`;

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    const size = ( w, h = 800 ) => c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 } );
    const ev = ( s ) => c.evaluate( s );
    const until = async ( s, ms = 4000 ) => { for( let t = 0; t < ms; t += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const open = async ( app, w, h ) =>
    {
        await size( w, h );
        await c.send( "Page.navigate", { url: BASE + "/nayive/" + ( app ? app + "/" : "" ) } );
        await until( "window.Ayni && Ayni.ready && document.readyState === 'complete'", 8000 );
        await ev( "Ayni.ready.then( () => true )" );
        await sleep( app === "write" || app === "calc" ? 4000 : 1500 );
    };
    const mouse = async ( type, x, y, button = "left", clickCount = 1 ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : button,
        buttons: type === "mousePressed" ? ( button === "right" ? 2 : 1 ) : 0, clickCount, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( e => { e.scrollIntoView( { block: 'nearest' } ); const r = e.getBoundingClientRect(); return JSON.stringify( [ r.left + Math.min( r.width / 2, 60 ), r.top + r.height / 2 ] ); } )( document.querySelector( ${JSON.stringify( sel )} ) )` ) );
    const press = async ( sel, button = "left" ) => { const [ x, y ] = await centre( sel ); await mouse( "mouseMoved", x, y ); await mouse( "mousePressed", x, y, button ); await mouse( "mouseReleased", x, y, button ); await sleep( 150 ); };
    const key = async ( k, code, vk, modifiers = 0, text ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers, text: type === "keyDown" ? text : undefined } ); await sleep( 90 ); };
    const letter = ( ch ) => key( ch, "Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt( 0 ), 0, ch );
    const esc = () => key( "Escape", "Escape", 27 );
    const down = () => key( "ArrowDown", "ArrowDown", 40 );
    const enter = () => key( "Enter", "Enter", 13 );
    const space = () => key( " ", "Space", 32, 0, " " );
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        await sleep( 300 );
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    };
    const errors = () => c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]/.test( l ) );
    // A colour as the page computes it, to compare backgrounds.
    const ACCENT = "( d => { d.style.background = 'var(--accent)'; document.body.append( d ); const c = getComputedStyle( d ).backgroundColor; d.remove(); return c; } )( document.createElement( 'i' ) )";
    const bg = ( sel ) => `getComputedStyle( document.querySelector( ${JSON.stringify( sel )} ) ).backgroundColor`;

    await size( 390 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "RULES - every app, phone and desktop" );
    for( const w of [ 390, 1280 ] )
        for( const app of [ "", ...APPS ] )
        {
            if( app === "desktop" && w < 600 ) continue;     // a phone is sent back to the launcher
            c.logs.length = 0;
            await open( app, w );
            const found = await ev( RULES );
            const errs = errors();
            ok( ! found.length && ! errs.length, ( app || "launcher" ) + " @ " + w, found.concat( errs ) );
        }

    console.log( "SOURCE - form options are Ayni check rows, not list boxes" );
    const src = ( f ) => fs.readFileSync( path.join( REPO, "client/apps", f ), "utf8" );
    ok( /class="choice dup-row"/.test( src( "bookmarks/io.js" ) ) && /'choice merge-row'/.test( src( "contact/index.html" ) ) && /'choice disc-item'/.test( src( "trips/discover.js" ) ),
        "Bookmarks duplicates, Contacts merge and Trips categories are .choice rows" );
    ok( ! fs.existsSync( path.join( REPO, "client/apps/shared/browser.js" ) ) && ! /browser\.js/.test( src( "sw.js" ) ), "shared/browser.js is gone, and from the service worker's list" );

    console.log( "DRIVE - the picked look, type-ahead, Move to…" );
    c.logs.length = 0;
    await open( "drive", 1280 );
    await until( "!! document.querySelector('#listing .row[data-path=\"files/banana.txt\"]')" );
    await ev( "document.querySelector('.list-rows')?.classList.contains('is-grid') && setViewMode( 'list' ); true" );
    await sleep( 400 );
    const ROW = ( n ) => `#listing .row[data-path="files/${n}"]`;
    await press( ROW( "banana.txt" ) );
    ok( await ev( `document.querySelector( '${ROW( "banana.txt" ).replace( /'/g, "\\'" )}' ).getAttribute( 'aria-selected' ) === 'true'` ), "a click picks the row (aria-selected)" );
    const accent = await ev( ACCENT );
    ok( ( await ev( bg( ROW( "banana.txt" ) ) ) ) !== accent && ( await ev( bg( ROW( "banana.txt" ) ) ) ) !== "rgba(0, 0, 0, 0)", "…with the soft tint, not full Accent", await ev( bg( ROW( "banana.txt" ) ) ) );
    ok( ( await ev( bg( ROW( "banana.txt" ) + " .pick-tick" ) ) ) === accent, "…its tick is Accent" );
    await shot( "drive-picked-light" );
    await ev( "Ayni.setTheme( 'dark' ); true" ); await sleep( 300 );
    const accentD = await ev( ACCENT );
    ok( ( await ev( bg( ROW( "banana.txt" ) ) ) ) !== accentD && ( await ev( bg( ROW( "banana.txt" ) + " .pick-tick" ) ) ) === accentD, "dark: the soft tint, the tick Accent" );
    await shot( "drive-picked-dark" );
    await ev( "Ayni.setTheme( 'light' ); true" );
    await letter( "c" );
    ok( await until( "document.activeElement && document.activeElement.dataset.path === 'files/cherry.txt'" ), "typing a letter jumps to a file (Drive has no letter actions)", await ev( "document.activeElement && document.activeElement.dataset.path" ) );
    await press( ROW( "apple.txt" ) );
    await ev( "browse.run( 'move' ); true" );
    ok( await until( "!! document.querySelector('dialog.panel[open] ul.pick-node[role=tree][data-nav]')" ), "Move to… shows Ayni's tree (ul.pick-node)" );
    ok( await ev( "getComputedStyle( document.querySelector('dialog.panel[open] .pick-node') ).borderTopStyle !== 'none'" ), "…in a box (border)" );
    await until( "!! document.querySelector('dialog.panel[open] .pick-node [data-id=\"files/Docs\"] > .ti')" );
    await press( "dialog.panel[open] .pick-node [data-id=\"files/Docs\"] > .ti" );
    ok( await ev( "document.querySelector('dialog.panel[open] .pick-node [data-id=\"files/Docs\"]').getAttribute('aria-current') === 'true' && document.querySelector('dialog.panel[open] .pick-ok').getAttribute('aria-disabled') !== 'true'" ),
        "…a click lights the folder (Accent) and the ✓ wakes" );
    ok( ( await ev( bg( "dialog.panel[open] .pick-node [data-id=\"files/Docs\"] > .ti" ) ) ) === accent, "…full Accent, also under the mouse" );
    await shot( "drive-move-to" );
    await press( "dialog.panel[open] .pick-cancel" );
    ok( await until( "! document.querySelector('dialog.panel[open]')" ) && fs.existsSync( `${RUN}/homes/test/files/apple.txt` ), "Cancel closes it, nothing moves" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "SHARE - the people are an Ayni pick list" );
    c.logs.length = 0;
    await ev( "NayiveUI.shareSheet( { path: 'files/apple.txt', app: 'file', title: 'apple.txt', canAdd: false } ); true" );
    ok( await until( "!! document.querySelector('dialog.panel[open] ul.lb.share-pick[role=listbox][aria-multiselectable=true] [role=option]')", 6000 ), "the names are an Ayni pick list" );
    ok( await ev( "[ ...document.querySelectorAll('.share-pick [role=option]') ].map( o => o.textContent ).join() === 'ana'" ), "…of the other users", await ev( "document.querySelector('.share-pick')?.textContent" ) );
    const OKB = "[ ...document.querySelectorAll('dialog.panel[open] footer .btn.primary') ].pop()";
    ok( await ev( `${OKB}.getAttribute('aria-disabled') === 'true'` ), "nobody picked: Share is off" );
    await press( ".share-pick [role=option]" );
    ok( await ev( `document.querySelector('.share-pick [role=option]').getAttribute('aria-selected') === 'true' && ${OKB}.getAttribute('aria-disabled') !== 'true'` ), "a click ticks ana; Share wakes" );
    await press( ".share-pick [role=option]" );
    ok( await ev( "document.querySelector('.share-pick [role=option]').getAttribute('aria-selected') === 'false'" ), "…a second click unticks" );
    await press( ".share-all .switch" );
    ok( await ev( `document.querySelector('.share-pick').getAttribute('aria-disabled') === 'true' && getComputedStyle( document.querySelector('.share-pick') ).opacity === '0.45' && ${OKB}.getAttribute('aria-disabled') !== 'true'` ),
        "\"Everybody\" greys the names out; Share wakes" );
    await ev( "document.querySelector('.share-pick').focus(); true" ); await space();
    ok( await ev( "document.querySelector('.share-pick [role=option]').getAttribute('aria-selected') === 'false'" ), "…the greyed list takes no Space" );
    await shot( "share-people" );
    await esc();
    ok( await until( "! document.querySelector('dialog.panel[open]')" ), "Esc closes it (nothing shared)" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "CONTACTS - the tree: arrows move, Enter goes; the phone sheet" );
    c.logs.length = 0;
    await open( "contact", 1280 );
    await until( "!! document.querySelector('#tree [data-id=\"fav\"] > .ti')" );
    await ev( "document.querySelector('#tree [data-id=\"all\"]').focus(); true" );
    await down();
    ok( await ev( "document.activeElement.dataset.id === 'fav' && document.querySelector('#tree [aria-current=true]').dataset.id === 'all'" ), "↓ moves the focus only (All still where you are)" );
    await enter();
    ok( await until( "document.querySelector('#tree [aria-current=true]')?.dataset.id === 'fav'" ), "Enter goes there (Favourites lit)" );
    await open( "contact", 390 );
    await press( "#treeBtn" );
    ok( await until( "document.getElementById('treePane').classList.contains('tree-sheet') && document.getElementById('treePane').classList.contains('open') && !! document.querySelector('.tree-backdrop.open')", 3000 ), "phone: the tree slides in over a dimmed page" );
    await sleep( 450 );
    ok( await ev( "document.querySelector('#tree [role=treeitem] > .ti').getBoundingClientRect().height >= 40" ), "…its rows are at least 40 px tall" );
    await shot( "contacts-phone-sheet" );
    await esc();
    ok( await until( "! document.getElementById('treePane').classList.contains('open')" ), "…Esc closes it" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "MUSIC - headings open and close; the triangle" );
    c.logs.length = 0;
    await open( "music", 1280 );
    await until( "!! document.querySelector('#tree [data-id=\"lib\"] > .ti')", 6000 );
    const libOpen = () => ev( "document.querySelector('#tree [data-id=\"lib\"]').getAttribute('aria-expanded')" );
    const was = await libOpen(), cur = await ev( "st.filter" );
    await press( "#tree [data-id=\"lib\"] > .ti .tn" );
    ok( ( await libOpen() ) !== was && await ev( "st.filter" ) === cur, "a click on a heading (Library) opens or closes it, it goes nowhere", [ was, await libOpen(), cur, await ev( "st.filter" ) ] );
    ok( await ev( "document.querySelector('#tree [data-id=\"lib\"] > .ti > .tw').getBoundingClientRect().width >= 24" ), "the triangle is a 24 px target" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "TASKS - the plan sheet's siblings are an Ayni pick list" );
    c.logs.length = 0;
    await open( "tasks", 1280 );
    await until( "!! document.querySelector('.task-chevron, .subtask-plan-btn')", 6000 );
    if( ! await ev( "document.querySelectorAll('.subtask-plan-btn').length === 3" ) ) await ev( "document.querySelector('.task-chevron').click(); true" );
    await until( "document.querySelectorAll('.subtask-plan-btn').length === 3" );
    await ev( "document.querySelectorAll('.subtask-plan-btn')[ 2 ].click(); true" );       // Keys
    ok( await until( "!! document.querySelector('#planAfterList ul.lb[role=listbox][aria-multiselectable=true]')" ), "the siblings are an Ayni pick list" );
    ok( await ev( "[ ...document.querySelectorAll('#planAfterList [role=option]') ].map( o => o.dataset.id + ':' + o.getAttribute('aria-selected') ).join() === '11:true,12:false'" ),
        "…Boxes ticked (already before), Van not", await ev( "[ ...document.querySelectorAll('#planAfterList [role=option]') ].map( o => o.dataset.id + ':' + o.getAttribute('aria-selected') ).join()" ) );
    await press( "#planAfterList [data-id=\"12\"]" );
    ok( await ev( "document.querySelector('#planAfterList [data-id=\"12\"]').getAttribute('aria-selected') === 'true'" ), "a click ticks Van" );
    await shot( "tasks-plan" );
    await ev( "document.getElementById('planSheetBackdrop').close(); true" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "EMAIL - its own list box keeps its look" );
    await open( "email", 1280 );
    ok( await ev( "( l => getComputedStyle( l ).maxHeight !== '180px' && getComputedStyle( l ).borderTopStyle === 'none' )( document.getElementById('list') )" ), "#list (role=listbox, an item list) has no pick-list box" );

    console.log( "PHOTOS - the lightbox is not a list box" );
    await open( "photos", 1280 );
    ok( await ev( "( l => !! l && l.classList.contains('lightbox') && ! l.classList.contains('lb') && ! l.hasAttribute('aria-activedescendant') )( document.getElementById('lb') )" ), "#lb is .lightbox, not wired as a list box" );
}
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "SOME FAILED" : "ALL GREEN" );
process.exit( fail ? 1 : 0 );
