// run.mjs - Ayni's layout family in Nayive (tabs, splitters, the status bar, choice
// rows, More fields), in a real (headless) browser: the rules on every page, then
// what the move changed in each app.
//
//   node tools/layout-test/run.mjs            (SHOTS=/some/dir also saves screenshots;
//                                              ONLY=calc,planner runs those sections alone, ONLY=rules
//                                              the rules too; APPS=drive,text limits the rules' apps)
//
// Same scratch server as tools/pickers-test (its own run-root in /tmp, a copy of
// client/apps, a user "test" and the admin "jefe"); the real store/ is never touched.
//
// RULES, every app, phone and desktop width (every dialog of the page opened in
//   turn): Ayni's layout family is loaded; none of the old parts (.pill, .tabs,
//   .set-tabs, .sheet-tab, .pane-resizer, .hsplitter, .btn.is-active); every tab
//   row is named, has one selected tab and never sits in a title row; a tab's
//   panel exists; a view switch is toggles; every bar is a named separator, 7 px;
//   a More fields line controls something; every choice has aria-pressed;
//   tabs are 44 px high on touch; no error.
// BEHAVIOURS: Calc's sheets (under the page, in the status bar; keys, typing kept
//   over a switch, rename, drag, one sheet = no row); Planner's bars (keys, saved
//   per screen, the old saves, the Habits fold, a phone); Habits' view switch;
//   Split's tabs; settings dialogs (eMail, Chat, Trips); Write's symbols; a bar's
//   fold kept in Bookmarks; Text's bar with no glyphs; More fields in Calendar and
//   Contacts; Locker settings (every page drawn); Admin's tabs; Spanish.
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

const APPS = process.env.APPS ? process.env.APPS.split( "," ) : fs.readdirSync( path.join( REPO, "client/apps" ) )
               .filter( d => fs.existsSync( path.join( REPO, "client/apps", d, "index.html" ) ) ).sort();

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "layout-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
fs.writeFileSync( `${RUN}/homes/test/files/a.txt`, "a" );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 600 ) ) );
};
const SHOTS = process.env.SHOTS || "";
// ONLY=calc,write runs those behaviour sections alone (no rules pass)
const ONLY = process.env.ONLY ? process.env.ONLY.split( "," ) : null;
const want = ( n ) => ! ONLY || ONLY.includes( n );

// Every file under a folder, with its text (to find what an app saved)
const filesUnder = ( dir ) => fs.readdirSync( dir, { withFileTypes: true } ).flatMap( e =>
    e.isDirectory() ? filesUnder( path.join( dir, e.name ) ) : [ path.join( dir, e.name ) ] );


// The rules, read off the page as it stands, every dialog opened in turn.
const RULES = `( async () => { const o = [];
    if( typeof Ayni.tabs !== 'function' || ! document.querySelector( 'link[href*="ayni-layout.css"]' ) ) return [ 'no Ayni layout family' ];
    const OLD = '.pill, .tabs, .set-tabs, .sheet-tab, .pane-resizer, .hsplitter, .btn.is-active, .pane-restore';
    const look = () =>
    {
        for( const x of document.querySelectorAll( OLD ) ) o.push( 'old part: ' + x.outerHTML.slice( 0, 80 ) );
        const touch = document.documentElement.classList.contains( 'touch' );
        for( const l of document.querySelectorAll( '[role="tablist"]' ) )
        {
            const id = l.id || l.className;
            if( ! l.getAttribute( 'aria-label' ) || /\bayni\./.test( l.getAttribute( 'aria-label' ) ) ) o.push( 'a tab row with no name: ' + id );
            if( l.closest( '.topbar, .header, .tb-modes' ) ) o.push( 'a tab row in a title row: ' + id );
            const tabs = [ ...l.querySelectorAll( ':scope > [role="tab"]' ) ].filter( t => ! t.hidden );
            if( tabs.length && tabs.filter( t => t.getAttribute( 'aria-selected' ) === 'true' ).length !== 1 ) o.push( 'not one selected tab: ' + id );
            for( const t of tabs )
            {
                const c = t.getAttribute( 'aria-controls' );
                if( c && ! document.getElementById( c ) ) o.push( 'a tab with no panel: ' + t.textContent );
                if( touch && t.checkVisibility() && t.getBoundingClientRect().height < 44 ) o.push( 'a tab under 44 px: ' + t.textContent );
            }
        }
        for( const t of document.querySelectorAll( '.tb-modes [role="tab"], .tb-modes[role="tablist"]' ) ) o.push( 'a view switch as tabs: ' + ( t.id || t.className ) );
        for( const b of document.querySelectorAll( '.splitter' ) )
        {
            if( b.getAttribute( 'role' ) !== 'separator' ) { if( ! b.hidden ) o.push( 'a bar Ayni did not wire: ' + b.id ); continue; }   // hidden: its app has nothing to divide yet
            if( ! b.getAttribute( 'aria-label' ) || /\bayni\./.test( b.getAttribute( 'aria-label' ) ) ) o.push( 'a bar with no name: ' + b.id );
            const r = b.getBoundingClientRect(), side = b.classList.contains( 'rows' ) ? r.height : r.width;
            if( b.checkVisibility() && Math.round( side ) !== 13 ) o.push( 'bar ' + b.id + ' is ' + side + ' px' );
        }
        for( const b of document.querySelectorAll( '.more-toggle' ) )
        {
            if( ! document.getElementById( b.getAttribute( 'aria-controls' ) ) ) o.push( 'a More fields line with nothing to fold: ' + b.id );
            if( ! b.textContent.trim() ) o.push( 'a More fields line with no words: ' + b.id );
        }
        for( const b of document.querySelectorAll( '.choices .btn' ) ) if( ! b.hasAttribute( 'aria-pressed' ) ) o.push( 'a choice with no state: ' + b.textContent );
    };
    look();
    for( const d of document.querySelectorAll( 'dialog.panel' ) )
    {
        if( d.open || d.classList.contains( 'lock' ) || d.classList.contains( 'lock-dlg' ) ) continue;
        try { d.showModal(); } catch { continue; }
        look();
        d.close();
    }
    return [ ...new Set( o ) ]; } )()`;

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    const size = ( w, h = 800 ) => c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 } );
    const touch = ( on ) => c.send( "Emulation.setEmulatedMedia", { features: [ { name: "pointer", value: on ? "coarse" : "fine" }, { name: "any-pointer", value: on ? "coarse" : "fine" } ] } );
    const ev = ( s ) => c.evaluate( s );
    const until = async ( s, ms = 4000 ) => { for( let t = 0; t < ms; t += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const open = async ( app, w, h, query = "" ) =>
    {
        // A page with an edit would ask before leaving, and the question blocks the navigation
        await ev( "( addEventListener( 'beforeunload', e => e.stopImmediatePropagation(), true ), true )" ).catch( () => {} );
        await size( w, h );
        await c.send( "Page.navigate", { url: BASE + "/nayive/" + ( app ? app + "/" : "" ) + query } );
        await until( "window.Ayni && Ayni.ready && document.readyState === 'complete'", 8000 );
        await ev( "Ayni.ready.then( () => true )" );
        await sleep( app === "write" ? 4000 : 1500 );
    };
    const mouse = async ( type, x, y ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( r => JSON.stringify( [ r.left + r.width / 2, r.top + r.height / 2 ] ) )( document.querySelector( ${JSON.stringify( sel )} ).getBoundingClientRect() )` ) );
    const press = async ( sel ) => { const [ x, y ] = await centre( sel ); await mouse( "mouseMoved", x, y ); await mouse( "mousePressed", x, y ); await mouse( "mouseReleased", x, y ); await sleep( 150 ); };
    const key = async ( k, code, vk ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, ...( k === "Enter" && type === "keyDown" ? { text: "\r" } : {} ) } ); await sleep( 80 ); };
    const type = async ( s ) => { await c.send( "Input.insertText", { text: s } ); await sleep( 60 ); };
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        await sleep( 300 );
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    };
    const errors = () => c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]/.test( l ) );

    await size( 390 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "RULES - every app, phone and desktop" );
    for( const [ w, t ] of ONLY && ! ONLY.includes( "rules" ) ? [] : [ [ 390, true ], [ 1280, false ] ] )
    {
        await touch( t );
        for( const app of [ "", ...APPS ] )
        {
            if( app === "desktop" && w < 600 ) continue;     // a phone is sent back to the launcher
            c.logs.length = 0;
            await open( app, w );
            if( t ) await ev( "( Ayni.setTouchPreview( true ), true )" );
            const found = await ev( RULES );
            const errs = errors();
            ok( ! found.length && ! errs.length, `${w}px ${app || "launcher"}`, found.concat( errs ) );
        }
    }
    await touch( false );
    await ev( "( Ayni.setTouchPreview( false ), true )" );

    console.log( "BEHAVIOURS" );


    // A drag with the button held; the key with modifiers (2 = Ctrl)
    const held = ( type, x, y, buttons ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1, pointerType: "mouse" } );
    const dragBy = async ( x, y, dx, dy = 0 ) =>
    {
        await held( "mouseMoved", x, y, 0 ); await held( "mousePressed", x, y, 1 );
        await held( "mouseMoved", x + dx / 2, y + dy / 2, 1 ); await held( "mouseMoved", x + dx, y + dy, 1 );
        await held( "mouseReleased", x + dx, y + dy, 0 ); await sleep( 150 );
    };
    const VK = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Home: 36, End: 35, PageUp: 33, PageDown: 34, F2: 113 };
    const press2 = async ( k, mods = 0 ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: VK[ k ], modifiers: mods, ...( k === "Enter" && type === "keyDown" ? { text: "\r" } : {} ) } ); await sleep( 120 ); };
    const barMid = ( sel ) => ev( `( r => [ r.left + r.width / 2, r.top + ( r.height > 80 ? 14 : r.height / 2 ) ] )( document.querySelector( ${ JSON.stringify( sel ) } ).getBoundingClientRect() )` );
    const tabsOf = ( sel ) => ev( `Ayni.tabs( ${ JSON.stringify( sel ) } ).tabs.filter( t => ! t.hidden ).map( t => t.textContent.trim() ).join( '|' )` );
    const picked = ( sel ) => ev( `Ayni.tabs( ${ JSON.stringify( sel ) } ).tabs.find( t => t.getAttribute( 'aria-selected' ) === 'true' )?.textContent.trim()` );

    if( want( "planner" ) )
    {
        await open( "planner", 1280, 900 );
        await ev( "( Object.keys( localStorage ).filter( k => k.startsWith( 'planner.' ) ).forEach( k => localStorage.removeItem( k ) ), true )" );
        await open( "planner", 1280, 900 );
        await sleep( 1500 );
        const barW = () => ev( "Math.round( document.getElementById('calendarPane').getBoundingClientRect().width / document.getElementById('panes').getBoundingClientRect().width * 100 )" );
        ok( await ev( "document.getElementById('splitter').getAttribute('role') === 'separator' && document.querySelectorAll('#splitter .split-ctl button').length === 3 && document.getElementById('hsplitter').getAttribute('aria-orientation') === 'horizontal'" ), "Planner: two Ayni bars, with glyphs" );
        ok( await barW() === 75, "…the Calendar at its default", await barW() );
        await shot( "planner" );
        await ev( "( document.getElementById('splitter').focus(), true )" );
        await press2( "ArrowLeft" );
        ok( await barW() === 70, "Left moves the bar", await barW() );
        const k = await ev( "Object.keys( localStorage ).find( k => /^planner\\.calPct\\./.test( k ) )" );
        ok( k && await ev( `localStorage.getItem( ${ JSON.stringify( k ) } )` ) === "70", "…saved for this screen", k );
        await open( "planner", 1280, 900 );
        await sleep( 800 );
        ok( await barW() === 70, "…and back after a reload" );
        await ev( "document.querySelector('#hsplitter [data-to=\"last\"]').click(), true" );
        await sleep( 300 );
        ok( await ev( "document.getElementById('habitsPane').hidden && document.getElementById('tasksPane').classList.contains('split-fill')" ), "▾ folds Habits, Tasks takes the room" );
        await shot( "planner-fold" );
        await open( "planner", 1280, 900 );
        await sleep( 800 );
        ok( await ev( "document.getElementById('habitsPane').hidden" ), "…still folded after a reload" );
        ok( await ev( "Math.abs( document.getElementById('tasksPane').getBoundingClientRect().bottom - document.getElementById('rightCol').getBoundingClientRect().bottom ) < 15" ), "…Tasks reaches the bar at the bottom" );
        await open( "planner", 390, 800 );
        // A fold is kept per screen: this one's, to show a phone layout ignores it
        await ev( "( localStorage.setItem( 'planner.tasksPct.' + Math.min( screen.width, screen.height ) + 'x' + Math.max( screen.width, screen.height ) + ( matchMedia( '(orientation: portrait)' ).matches ? '-p' : '-l' ) + '.fold', 'last' ), true )" );
        await open( "planner", 390, 800 );
        await sleep( 800 );
        await ev( "document.querySelector('[data-pane=\"habitsPane\"]').click(), true" );
        await sleep( 300 );
        ok( await ev( "! document.getElementById('habitsPane').hidden && document.querySelector('[data-pane=\"habitsPane\"]').getAttribute('aria-pressed') === 'true'" ), "phone: Habits shows, a fold or not" );
        ok( await ev( "getComputedStyle( document.getElementById('splitter') ).display === 'none' && getComputedStyle( document.getElementById('hsplitter') ).display === 'none'" ), "phone: no bars" );
        await ev( "( localStorage.removeItem( 'planner.tasksPct.' + Math.min( screen.width, screen.height ) + 'x' + Math.max( screen.width, screen.height ) + ( matchMedia( '(orientation: portrait)' ).matches ? '-p' : '-l' ) + '.fold' ), localStorage.setItem( 'planner.pane', 'calendarPane' ), true )" );
        await open( "planner", 1280, 900 );
        await sleep( 800 );
        await ev( "document.querySelector('#hsplitter [data-to=\"reset\"]').click(), true" );
        await sleep( 300 );
        ok( await ev( "! document.getElementById('habitsPane').hidden && ! document.getElementById('tasksPane').classList.contains('split-fill')" ), "the dot brings Habits back" );
        ok( ! await ev( "Object.keys( localStorage ).some( k => /tasksPct.*fold/.test( k ) )" ), "…and forgets the fold" );
        await ev( "( Object.keys( localStorage ).filter( k => k.startsWith( 'planner.' ) ).forEach( k => localStorage.removeItem( k ) ), localStorage.setItem( 'planner.calPct', '50' ), localStorage.setItem( 'planner.habitsFolded', '1' ), true )" );
        await open( "planner", 1280, 900 );
        await sleep( 800 );
        ok( await barW() === 50, "an old save (no screen in its key) is the starting point", await barW() );
        ok( await ev( "document.getElementById('habitsPane').hidden && localStorage.getItem('planner.habitsFolded') === null" ), "an old Habits fold stays folded, and its key goes" );
        ok( await ev( "! document.getElementById('habitsPane').contentDocument?.getElementById('collapseBtn')" ), "the [v] is gone" );
        await ev( "( Object.keys( localStorage ).filter( k => k.startsWith( 'planner.' ) ).forEach( k => localStorage.removeItem( k ) ), true )" );
        ok( ! errors().length, "Planner: no errors", errors() );
    }

    if( want( "habits" ) )
    {
        await open( "habits", 1280, 900 );
        ok( await ev( "! document.querySelector('[role=\"tablist\"]') && document.querySelectorAll('.tb-modes [data-view]').length === 2" ), "Habits: Today / Month are the view switch" );
        ok( await ev( "document.querySelector('[data-view=\"today\"]').getAttribute('aria-label') && document.querySelector('[data-view=\"today\"]').getAttribute('aria-pressed') === 'true'" ), "…named, Today pressed" );
        await shot( "habits" );
        await press( "[data-view=\"month\"]" ); await sleep( 300 );
        ok( await ev( "document.querySelector('[data-view=\"month\"]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-view=\"today\"]').getAttribute('aria-pressed') === 'false'" ), "…Month pressed, Today not" );
    }

    if( want( "split" ) )
    {
        await open( "split", 1280, 900 );
        await press( "#addBtn" ); await sleep( 400 );
        await ev( "( document.getElementById('groupNameInput').value = 'Trip', document.getElementById('othersInput').value = 'Ana', true )" );
        await press( "#groupSaveBtn" ); await sleep( 1200 );
        if( ! await ev( "! document.getElementById('groupView').hidden" ) ) { await ev( "document.querySelector('#groupList .card-row')?.click(), true" ); await sleep( 800 ); }
        ok( await ev( "! document.getElementById('groupTabs').closest('.header') && ! document.getElementById('groupTabs').hidden" ), "Split: Entries / Balances under the title row" );
        ok( await picked( "#groupTabs" ) && ! await ev( "document.getElementById('entriesTab').hidden" ), "…Entries first" );
        await shot( "split" );
        await press( "#groupTabs [data-value=\"balances\"]" ); await sleep( 400 );
        ok( await ev( "! document.getElementById('balancesTab').hidden && document.getElementById('entriesTab').hidden" ), "…Balances shows" );
        ok( await ev( "! /role=\"tablist\"/.test( document.getElementById('groupView').hidden ) && getComputedStyle( document.getElementById('balancesTab') ).paddingLeft === '0px'" ), "…with the card's own margins" );
        ok( ! errors().length, "Split: no errors", errors() );
    }

    if( want( "dialogs" ) )
    {
        await open( "email", 1280, 900 );
        await ev( "E = null, document.getElementById('setBtn').click(), true" ).catch( () => ev( "document.getElementById('setBtn').click(), true" ) );
        await sleep( 800 );
        ok( await ev( "document.getElementById('setSheet').open && ! document.getElementById('setAccounts').hidden" ), "eMail settings: Accounts first" );
        await press( "#setTabs [data-value=\"general\"]" ); await sleep( 300 );
        ok( await ev( "! document.getElementById('setGeneral').hidden && document.getElementById('setAccounts').hidden" ), "…General shows" );
        await shot( "email-settings" );
        await ev( "( document.getElementById('setSheet').close(), true )" );
        await open( "trips", 1280, 900 );
        await ev( "( openSettings(), true )" ); await sleep( 500 );
        ok( ( await tabsOf( "#setSheet > [role=\"tablist\"]" ) ).split( "|" ).length === 2, "Trips settings: two tabs, at the top of the body" );
        await shot( "trips-settings" );
        await ev( "document.querySelectorAll('#setSheet > [role=\"tablist\"] > [role=\"tab\"]')[1].click(), true" ); await sleep( 200 );
        ok( await ev( "[ ...document.querySelectorAll('#setSheet > [role=\"tabpanel\"]') ].filter( p => ! p.hidden ).length === 1" ), "…one page at a time" );
        await ev( "( document.getElementById('setSheetBackdrop').close(), true )" );
        await open( "chat", 1280, 900 );
        await ev( "( NayiveChat.openSettings(), true )" ); await sleep( 500 );
        ok( ( await ev( "document.querySelectorAll('dialog.chat-settings [role=\"tab\"]').length" ) ) === 2, "Chat settings: two tabs" );
        await shot( "chat-settings" );
        ok( await ev( "document.querySelectorAll('dialog.chat-settings [role=\"tab\"]')[1].click(), [ ...document.querySelectorAll('dialog.chat-settings [role=\"tabpanel\"]') ].filter( p => ! p.hidden ).length === 1" ), "…one page at a time" );
        await ev( "document.querySelector('dialog.chat-settings [data-close], dialog.chat-settings .btn')?.click(), true" );
        ok( ! errors().length, "Dialogs: no errors", errors() );
    }

    if( want( "write" ) )
    {
        await open( "write", 1280, 900 );
        await ev( "( document.getElementById('symbolsBtn').click(), true )" ); await sleep( 500 );
        const n = await ev( "Ayni.tabs('#symTabs').tabs.length" );
        ok( n > 2, "Write: the symbol sets are tabs", n );
        const first = await ev( "document.querySelector('#symGrid .sym-cell').textContent" );
        await shot( "write-symbols" );
        await press( "#symTabs > [role=\"tab\"]:nth-of-type(2)" ); await sleep( 300 );
        ok( await ev( "document.querySelector('#symGrid .sym-cell').textContent" ) !== first, "…a pick draws that set" );
        ok( await ev( "Ayni.tabs('#symTabs').tabs[1].getAttribute('aria-selected') === 'true'" ), "…and keeps it selected" );
    }

    if( want( "bookmarks" ) )
    {
        await open( "bookmarks", 1280, 900 );
        const width = () => ev( "Math.round( document.getElementById('treePane').getBoundingClientRect().width )" );
        const w0 = await width();
        ok( await ev( "document.querySelectorAll('#paneResizer .split-ctl button').length === 3" ), "Bookmarks: the bar has glyphs" );
        await shot( "bookmarks" );
        const [ x, y ] = await barMid( "#paneResizer" );
        await dragBy( x, y, 60 );
        ok( Math.abs( await width() - w0 - 60 ) < 3, "…a drag sizes the tree", [ w0, await width() ] );
        await ev( "document.querySelector('#paneResizer [data-to=\"first\"]').click(), true" ); await sleep( 200 );
        ok( await ev( "document.getElementById('treePane').hidden" ), "…the arrow folds it" );
        await open( "bookmarks", 1280, 900 );
        ok( await ev( "document.getElementById('treePane').hidden" ), "…still folded after a reload" );
        await open( "bookmarks", 390, 800 );
        ok( await ev( "! document.getElementById('treePane').hidden && getComputedStyle( document.getElementById('paneResizer') ).display === 'none'" ), "phone: no bar, and the fold does not hide the tree" );
        await open( "bookmarks", 1280, 900 );
        await ev( "document.querySelector('#paneResizer [data-to=\"reset\"]').click(), true" ); await sleep( 200 );
        ok( await ev( "! document.getElementById('treePane').hidden" ) && await width() === 240, "…the dot brings it back at its default", await width() );
    }

    if( want( "text" ) )
    {
        await open( "text", 1280, 900 );
        await ev( "( localStorage.setItem( 'gum_text_md_width', '300' ), true )" );
        await open( "text", 1280, 900 );
        ok( await ev( "document.getElementById('preview').hidden && document.getElementById('mdResizer').hidden" ), "Text: a saved width does not open the preview" );
        ok( await ev( "! document.querySelector('#mdResizer .split-ctl')" ), "…its bar has no glyphs: the toolbar's button folds it" );
        await ev( "( localStorage.removeItem( 'gum_text_md_width' ), true )" );
    }

    if( want( "more" ) )
    {
        for( const [ app, more, less ] of [ [ "calendar", "More", "Less" ], [ "contact", "More fields", "Fewer fields" ] ] )
        {
            await open( app, 1280, 900 );
            const label = () => ev( "document.getElementById('moreToggle').textContent.replace( /[^\\p{L} ]/gu, '' ).trim()" );
            ok( await ev( "document.getElementById('moreSection').hidden" ) && new RegExp( more, "i" ).test( await label() ), `${ app }: folded, says ${ more }`, await label() );
            await ev( "( document.getElementById('moreToggle').click(), true )" );
            ok( await ev( "! document.getElementById('moreSection').hidden && document.getElementById('moreToggle').getAttribute('aria-expanded') === 'true'" ) && new RegExp( less, "i" ).test( await label() ), `…pressed: open, says ${ less }`, await label() );
        }
    }

    if( want( "locker" ) )
    {
        for( const [ id, tab ] of [ [ "culture", "Art" ], [ "science", "News" ] ] )
        {
            await open( "desktop", 1280, 900 );
            await ev( `( localStorage.setItem( 'nayive-locker', JSON.stringify( { id: ${ JSON.stringify( id ) }, min: 15 } ) ), true )` );
            await open( "desktop", 1280, 900 );
            await ev( "( document.getElementById('moreBtn').click(), true )" ); await sleep( 400 );
            await ev( "( document.getElementById('salonBtn').click(), true )" ); await sleep( 2000 );
            const tabs = await ev( "[ ...document.querySelectorAll('#salonSettings [role=\"tab\"]') ].map( t => t.textContent ).join( '|' )" );
            ok( tabs.includes( tab ) && tabs.split( "|" ).length === 4, `Locker ${ id }: four tabs`, tabs );
            ok( await ev( "[ ...document.querySelectorAll('#salonSettings .salon-pane') ].every( p => p.children.length > 1 )" ), "…every page is drawn", await ev( "[ ...document.querySelectorAll('#salonSettings .salon-pane') ].map( p => p.children.length )" ) );
            await shot( "locker-" + id );
            await ev( "document.querySelector('#salonSettings header [data-close]').click(), true" ); await sleep( 300 );
        }
        await ev( "( localStorage.removeItem( 'nayive-locker' ), true )" );
        ok( ! errors().length, "Locker: no errors", errors() );
    }

    if( want( "admin" ) )
    {
        await ev( "fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { user: 'jefe', password: 'secreto' } ) } ).then( r => r.status )" );
        await size( 1280, 900 );
        await c.send( "Page.navigate", { url: BASE + "/nayive/admin.html" } );
        await sleep( 2000 );
        ok( ( await tabsOf( "#tabs" ) ) === "Account|Web sites|Users|Language", "Admin: four tabs", await tabsOf( "#tabs" ) );
        ok( await ev( "! document.getElementById('tabs').closest('.brand') && ! document.getElementById('adminSec').hidden && document.getElementById('usersSec').hidden" ), "…in a row of their own, Account first" );
        await shot( "admin" );
        await press( "#tabs > [role=\"tab\"]:nth-of-type(3)" ); await sleep( 300 );
        ok( await ev( "! document.getElementById('usersSec').hidden && document.getElementById('adminSec').hidden" ), "…Users shows" );
        await c.send( "Page.navigate", { url: BASE + "/nayive/admin.html" } );
        await sleep( 2000 );
        ok( await picked( "#tabs" ) === "Users", "…and is remembered" );
        ok( ( await ev( "getComputedStyle( document.getElementById('usersSec') ).paddingLeft" ) ) === "20px", "…a section keeps its padding" );
        await ev( "( localStorage.removeItem( 'nayive-admin-tab' ), true )" );
        await ev( "fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { user: 'test', password: 'test' } ) } ).then( r => r.status )" );
    }

    if( want( "es" ) )
    {
        await ev( "( localStorage.setItem( 'ayni-lang', 'es' ), true )" );
        await open( "bookmarks", 1280, 900 );
        ok( await ev( "document.getElementById('paneResizer').dataset.tip === 'Arrastra para cambiar el tamaño'" ), "Spanish: the bar says so" );
        await open( "calendar", 1280, 900 );
        ok( /m[aá]s/i.test( await ev( "document.getElementById('moreToggle').textContent" ) ), "Spanish: More fields", await ev( "document.getElementById('moreToggle').textContent" ) );
        await ev( "( localStorage.setItem( 'ayni-lang', 'en' ), true )" );
    }

    // Last: an edit in Calc hangs any navigation away from it
    if( want( "calc" ) )
    {
        await open( "calc", 1280, 900 );
        await sleep( 1500 );
        ok( await ev( "document.getElementById('sheetTabs').hidden && !! document.querySelector('#statusBar.statusbar')" ), "Calc: one sheet, no tab row; the bar is Ayni's" );
        await press( "#addSheetBtn" ); await sleep( 500 );
        await press( "#addSheetBtn" ); await sleep( 500 );
        // A new document asks its name and folder at the first pause: its × means no more asking
        await until( "!! document.querySelector('dialog[open]')", 6000 );
        await ev( "document.querySelector('dialog[open] [data-close]')?.click(), true" ); await sleep( 300 );
        const names = await tabsOf( "#sheetTabs" );
        ok( names.split( "|" ).length === 3, "…two more sheets, three tabs", names );
        ok( await ev( "document.getElementById('statusBar').firstElementChild.id === 'sheetTabs' && document.getElementById('sheetTabs').classList.contains('bottom')" ), "…under the page, first in the status bar" );
        await shot( "calc-tabs" );
        const [ s1, s2, s3 ] = names.split( "|" );
        ok( await picked( "#sheetTabs" ) === s3, "…the new sheet is the selected one" );
        await press( `#sheetTabs > [role="tab"]:nth-of-type(1)` ); await sleep( 500 );
        ok( await picked( "#sheetTabs" ) === s1, "a click goes to that sheet" );
        const [ cx, cy ] = await centre( "#gridHost .ht_master td" );
        for( const clickCount of [ 1, 2 ] ) for( const t2 of [ "mousePressed", "mouseReleased" ] ) await c.send( "Input.dispatchMouseEvent", { type: t2, x: cx, y: cy, button: "left", buttons: t2 === "mousePressed" ? 1 : 0, clickCount, pointerType: "mouse" } );
        await sleep( 300 ); await type( "kept" );
        ok( await ev( "document.activeElement.value === 'kept'" ), "a cell is being typed", await ev( "[ document.activeElement.tagName, document.activeElement.className ]" ) );
        await press2( "PageDown", 2 ); await sleep( 500 );
        ok( await picked( "#sheetTabs" ) === s2, "Ctrl+Page Down from a cell being typed: the next sheet" );
        await press2( "PageUp", 2 ); await sleep( 500 );
        ok( await picked( "#sheetTabs" ) === s1, "Ctrl+Page Up: back" );
        ok( await ev( "[ ...document.querySelectorAll('#gridHost td') ].some( t => t.textContent === 'kept' )" ), "…what was being typed is kept", await ev( "[ document.getElementById('formulaBar').value, document.activeElement.className, document.querySelectorAll('#gridHost td').length ]" ) );
        await ev( `( document.querySelector('#sheetTabs > [role="tab"][aria-selected="true"]').focus(), true )` );
        await press2( "ArrowRight" ); await sleep( 500 );
        ok( await picked( "#sheetTabs" ) === s2, "Right on a tab: the next sheet" );
        await press( "#gridHost td" ); await sleep( 300 );
        ok( await ev( "! [ ...document.querySelectorAll('#gridHost td') ].some( t => t.textContent === 'kept' )" ), "…with its own cells" );
        await ev( `document.querySelector('#sheetTabs > [role="tab"]:nth-of-type(2)').dispatchEvent( new MouseEvent( 'dblclick', { bubbles: true } ) )` );
        await sleep( 200 );
        ok( await ev( "document.activeElement.classList.contains('sheet-tab-edit')" ), "a double-click renames in place" );
        await ev( "( document.execCommand( 'selectAll' ), true )" ); await type( "Ventas" ); await press2( "Enter" ); await sleep( 500 );
        ok( ( await tabsOf( "#sheetTabs" ) ) === `${ s1 }|Ventas|${ s3 }`, "…Enter keeps the name, the field goes", await tabsOf( "#sheetTabs" ) );
        ok( await ev( "! document.querySelector('.sheet-tab-edit')" ), "…no field left in the row" );
        await ev( `document.querySelector('#sheetTabs > [role="tab"]:nth-of-type(2)').dispatchEvent( new MouseEvent( 'dblclick', { bubbles: true } ) )` );
        await sleep( 200 ); await type( "Nope" ); await press2( "Escape" ); await sleep( 400 );
        ok( ( await tabsOf( "#sheetTabs" ) ) === `${ s1 }|Ventas|${ s3 }`, "…Escape keeps the old one" );
        const [ fx, fy ] = await barMid( `#sheetTabs > [role="tab"]:nth-of-type(1)` );
        const [ tx ] = await ev( `( r => [ r.right - 2 ] )( document.querySelector('#sheetTabs > [role="tab"]:nth-of-type(3)').getBoundingClientRect() )` );
        await dragBy( fx, fy, tx - fx ); await sleep( 500 );
        ok( ( await tabsOf( "#sheetTabs" ) ) === `Ventas|${ s3 }|${ s1 }`, "a drag moves the sheet to the end", await tabsOf( "#sheetTabs" ) );
        ok( await picked( "#sheetTabs" ) === "Ventas", "…the drag's click picks nothing", await picked( "#sheetTabs" ) );
        const [ ox, oy ] = await barMid( `#sheetTabs > [role="tab"]:nth-of-type(3)` );
        await dragBy( ox, oy, 8 ); await sleep( 400 );
        ok( await picked( "#sheetTabs" ) === "Ventas", "…a short drag inside one tab picks nothing either", await picked( "#sheetTabs" ) );
        ok( ! errors().length, "Calc: no errors", errors() );
    }
}
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "FAILED" : "ALL GREEN" );
process.exit( fail ? 1 : 0 );
