// run.mjs - Ayni's search family in Nayive (Ayni.searchField, Ayni.matcher,
// Ayni.findBar, Ctrl+F), in a real (headless) browser: the rules on every
// page, then the behaviours.
//
//   node tools/search-test/run.mjs            (SHOTS=/some/dir also saves screenshots)
//
// Same scratch server as tools/menus-test (its own run-root in /tmp, a copy of
// client/apps, one user "test" with a few files, two Split groups, three
// Calendar events, two pictures); the real store/ is never touched.
//
// RULES, every app, phone and desktop width: no old search API (NayiveUI.
//   searchFold / fold / matcher); Ayni's family is loaded; no old search markup;
//   every search field is an .input-group with an input.input type=search,
//   wired by Ayni; a folded one has its Search button beside it; only an
//   Enter-only field has a Go button; no raw "ayni.*" key in a tooltip, label
//   or placeholder (a control made before Ayni.ready); no error.
// BEHAVIOURS: Drive (opens + focuses, live search, Esc in two steps, Ctrl+F,
//   the funnel: Accent + "Filters: n", typing ends it, × clears + folds);
//   Calendar steps through its hits ("1 / 2", up / down, Enter); Split and
//   Photos count ("1 / 2"); on a phone the open field keeps the header on one
//   row (what does not fit goes into the ⋮); Language's dictionary searches
//   on Enter / Go only; Calc's function list uses the search rule; Ayni.fold /
//   matcher (ß, umlauts, phrases, -word); Write's find bar LAST (Ctrl+F, count,
//   Enter steps, Match case, Replace all, a red 0, Ctrl+H, Esc).
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "search-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
for( const n of [ "a.txt", "b.txt", "c.txt" ] ) fs.writeFileSync( `${RUN}/homes/test/files/${n}`, n );
// Data for the searches: two Split groups, three Calendar events, two pictures (the
// media apps' folder is files/, so no first-run folder question).
for( const [ id, name ] of [ [ "lisboa-2026-aaaa", "Lisboa 2026" ], [ "piso-bbbb", "Piso" ] ] )
{
    fs.mkdirSync( `${RUN}/homes/test/data/split/${id}`, { recursive: true } );
    fs.writeFileSync( `${RUN}/homes/test/data/split/${id}/group.json`, JSON.stringify( { id, name, currency: "EUR", created: "2026-09-06", archived: false,
        members: [ { id: "m_1", name: "Fran", me: true }, { id: "m_2", name: "Ana" } ], rates: {}, entries: [] } ) );
}
const ics = ( d, uid, sum ) => { const t = new Date( Date.now() + d * 86400000 ).toISOString().replace( /[-:]/g, "" ).slice( 0, 15 ) + "Z";
    return `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${t}\r\nDTSTART:${t}\r\nDURATION:PT1H\r\nSUMMARY:${sum}\r\nEND:VEVENT\r\n`; };
fs.writeFileSync( `${RUN}/homes/test/data/calendar.ics`, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//search-test//EN\r\n" +
    ics( 1, "e1", "Dentist" ) + ics( 8, "e2", "Dentist check" ) + ics( 3, "e3", "Lunch with Ana" ) + "END:VCALENDAR\r\n" );
for( const a of [ "photos", "music", "movies" ] )
{
    fs.mkdirSync( `${RUN}/homes/test/data/${a}`, { recursive: true } );
    fs.writeFileSync( `${RUN}/homes/test/data/${a}/config.json`, JSON.stringify( { folder: "files" } ) );
}
const JPEG = spawnSync( "convert", [ "-size", "8x8", "xc:#c84", "jpeg:-" ] ).stdout;
const PICS = !! ( JPEG && JPEG.length );
if( PICS ) for( const n of [ "beach.jpg", "city.jpg" ] ) fs.writeFileSync( `${RUN}/homes/test/files/${n}`, JPEG );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 500 ) ) );
};
const SHOTS = process.env.SHOTS || "";            // a folder: screenshots go there

// The rules, read off the page as it stands.
const RULES = `( () => { const o = [];
    if( window.NayiveUI && [ 'searchFold', 'fold', 'matcher' ].some( k => NayiveUI[ k ] ) ) o.push( 'old NayiveUI search API' );
    if( typeof Ayni.searchField !== 'function' || typeof Ayni.matcher !== 'function' || typeof Ayni.findBar !== 'function' ) return [ 'no Ayni search family' ];
    if( document.querySelector( '.search-fold, .search-wrap, .search-shut, .search-mark, .search-ends, .search-tight, .adv-chip, .topbar-search' ) ) o.push( 'old search markup' );
    for( const f of document.querySelectorAll( '.search-field' ) )
    {
        const i = f.querySelector( 'input' ), id = i && i.id || f.className;
        if( ! i || i.type !== 'search' || ! i.classList.contains( 'input' ) ) o.push( id + ': not an input.input type=search' );
        if( ! f.classList.contains( 'input-group' ) ) o.push( id + ': no .input-group' );
        if( f.closest( '.find-bar' ) ) continue;
        if( ! f.querySelector( '[data-clear]' ) ) o.push( id + ': not wired by Ayni (no ×)' );
        if( f.classList.contains( 'fold' ) && ! [ f.previousElementSibling, f.nextElementSibling ].some( s => s && s.matches( '[data-search]' ) ) ) o.push( id + ': a fold with no Search button beside it' );
        if( f.querySelector( '[data-go]' ) && ! f.hasAttribute( 'data-enter' ) ) o.push( id + ': a Go button on a live field' );
    }
    for( const el of document.querySelectorAll( '[data-tip^="ayni."], [aria-label^="ayni."], [placeholder^="ayni."], [title^="ayni."]' ) )
        o.push( ( el.id || el.className ) + ': a raw Ayni key (made before Ayni.ready)' );
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
    const mouse = async ( type, x, y, button = "left" ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : button,
        buttons: type === "mousePressed" ? ( button === "right" ? 2 : 1 ) : 0, clickCount: 1, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( r => JSON.stringify( [ r.left + r.width / 2, r.top + r.height / 2 ] ) )( document.querySelector( ${JSON.stringify( sel )} ).getBoundingClientRect() )` ) );
    const press = async ( sel, button = "left" ) => { const [ x, y ] = await centre( sel ); await mouse( "mouseMoved", x, y ); await mouse( "mousePressed", x, y, button ); await mouse( "mouseReleased", x, y, button ); await sleep( 120 ); };
    const key = async ( k, code, vk, modifiers = 0 ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers } ); await sleep( 80 ); };
    const isOpen = ( id ) => ev( `!! document.getElementById( '${id}' )?.matches( ':popover-open' )` );
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

    const typeIn = async ( sel, text ) => { await ev( `( i => { i.focus(); i.value = ${JSON.stringify( text )}; i.dispatchEvent( new Event( 'input', { bubbles: true } ) ); } )( document.querySelector( ${JSON.stringify( sel )} ) ); true` ); await sleep( 400 ); };
    const ctrl = ( k ) => key( k, "Key" + k.toUpperCase(), k.toUpperCase().charCodeAt( 0 ), 2 );
    const esc = () => key( "Escape", "Escape", 27 );
    const enter = ( mods = 0 ) => key( "Enter", "Enter", 13, mods );
    const OPEN = ".search-field.fold.is-open";

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

    console.log( "THE RULE - Ayni.fold / Ayni.matcher" );
    ok( await ev( `[ Ayni.fold( 'José Niño' ) === 'jose nino', Ayni.fold( 'Straße' ) === 'strasse', Ayni.fold( 'Œuvre' ) === 'oeuvre', Ayni.fold( 'l’eau' ) === "l'eau",
        Ayni.fold( 'Ve\u20d7ctor' ) === 'vector', Ayni.matcher( 'mueller' )( 'Müller' ), Ayni.matcher( 'Müller' )( 'Mueller' ), ! Ayni.matcher( 'fue' )( 'fumar' ),
        Ayni.matcher( 'luz factura' )( 'Factura de la luz' ), ! Ayni.matcher( '"luz factura"' )( 'Factura de la luz' ), ! Ayni.matcher( 'factura -luz' )( 'Factura de la luz' ),
        Ayni.matcher( '  ' ) === null ].every( Boolean )` ), "accents, ß œ ’, any mark, umlauts both ways, words any order, phrase, -word, nothing asked" );

    console.log( "DRIVE - the folded field, the funnel, Ctrl+F" );
    c.logs.length = 0;
    await open( "drive", 1280 );
    const LIST = "document.getElementById('listing').innerText";
    await press( "#searchToggleBtn" );
    ok( await ev( "document.querySelector('#driveTools .search-field').classList.contains('is-open') && document.activeElement.id === 'searchInput'" ), "the magnifier opens the field, with the cursor in it" );
    ok( await ev( "getComputedStyle( document.getElementById('searchToggleBtn') ).display === 'none'" ), "…in the magnifier's place" );
    await typeIn( "#searchInput", "a.txt" );
    ok( await until( `/a\\.txt/.test( ${LIST} ) && ! /b\\.txt/.test( ${LIST} )` ), "typing searches the whole drive", await ev( LIST ) );
    await esc();
    ok( await ev( "document.getElementById('searchInput').value === '' && document.querySelector('#driveTools .search-field').classList.contains('is-open')" ), "Esc with text: clears, stays open" );
    ok( await until( `/b\\.txt/.test( ${LIST} )` ), "…and the folder comes back" );
    await esc();
    ok( await ev( "! document.querySelector('#driveTools .search-field').classList.contains('is-open') && document.activeElement.id === 'searchToggleBtn'" ), "Esc on the empty field folds it; the cursor goes back to the magnifier" );
    await ev( "document.activeElement.blur(); true" );
    await ctrl( "f" );
    ok( await until( "document.querySelector('#driveTools .search-field').classList.contains('is-open') && document.activeElement.id === 'searchInput'" ), "Ctrl+F opens it from the page" );
    await press( "#searchBuilderBtn" );
    ok( await until( "document.getElementById('searchBuilderBackdrop').open" ), "the funnel opens the advanced search" );
    await ev( "( i => { i.value = 'txt'; i.dispatchEvent( new Event( 'input', { bubbles: true } ) ); } )( document.querySelector('#sbRules input') ); true" );
    await press( "#sbSearchBtn" );
    ok( await until( "document.getElementById('searchBuilderBtn').classList.contains('is-active')" ), "a search in force: the funnel is lit" );
    ok( await until( "getComputedStyle( document.getElementById('searchBuilderBtn') ).color === ( d => { d.style.color = 'var(--accent)'; document.body.append( d ); const c = getComputedStyle( d ).color; d.remove(); return c; } )( document.createElement( 'i' ) )" ), "…in Accent" );
    ok( await ev( "document.getElementById('searchBuilderBtn').dataset.tip === Ayni.tf( 'ayni.filters', { n: 1 } ) && ! document.getElementById('searchInput').hidden && document.querySelector('#driveTools .search-field').classList.contains('is-open')" ),
        "…its tooltip says how many (Filters: 1), and the field stays usable", await ev( "document.getElementById('searchBuilderBtn').dataset.tip" ) );
    await typeIn( "#searchInput", "b" );
    ok( await ev( "! document.getElementById('searchBuilderBtn').classList.contains('is-active') && document.getElementById('searchBuilderBtn').dataset.tip === Ayni.t( 'drive.sbTitle' )" ), "typing in the field ends the advanced search" );
    await press( "#driveTools .search-field [data-clear]" );
    ok( await ev( "! document.querySelector('#driveTools .search-field').classList.contains('is-open') && document.getElementById('searchInput').value === ''" ), "the × clears and folds in one press" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "CALENDAR - steps through its hits" );
    c.logs.length = 0;
    await open( "calendar", 1280 );
    await press( "#searchBtn" );
    await typeIn( "#fSearch", "dentist" );
    const CNT = "( document.querySelector( '.search-field.is-open .search-count' ) || {} ).textContent";
    ok( await until( `${CNT} === '2'` ), "two events match: the count says 2", await ev( CNT ) );
    ok( await ev( "[ ...document.querySelectorAll( '.search-field .search-step' ) ].every( b => b.getAttribute( 'aria-disabled' ) === 'false' )" ), "…and the up / down pair is live" );
    await enter();
    ok( await until( `${CNT} === '1 / 2'` ), "Enter goes to the first one (1 / 2)", await ev( CNT ) );
    await press( '.search-field .search-step[data-tip="' + await ev( "Ayni.t( 'ayni.next' )" ) + '"]' );
    ok( await until( `${CNT} === '2 / 2'` ), "the down arrow: the next one (2 / 2)", await ev( CNT ) );
    ok( await ev( "document.activeElement.id === 'fSearch'" ), "…and the cursor stays in the field" );
    await enter( 8 );
    ok( await until( `${CNT} === '1 / 2'` ), "Shift+Enter goes back", await ev( CNT ) );
    await typeIn( "#fSearch", "zzqq" );
    ok( await until( `${CNT} === '0'` ) && await ev( "[ ...document.querySelectorAll( '.search-field .search-step' ) ].every( b => b.getAttribute( 'aria-disabled' ) === 'true' )" ), "no match: 0, the pair greyed" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "COUNTS - Split, Photos" );
    for( const [ app, btn, q, want ] of [ [ "split", "#searchBtn", "lis", "1 / 2" ], ...( PICS ? [ [ "photos", "#searchToggle", "beach", "1 / 2" ] ] : [] ) ] )
    {
        c.logs.length = 0;
        await open( app, 1280 );
        await press( btn );
        await typeIn( OPEN + " input", q );
        ok( await until( `( document.querySelector( '${OPEN} .search-count' ) || {} ).textContent === '${want}'` ), app + ": '" + q + "' shows " + want, await ev( `( document.querySelector( '${OPEN} .search-count' ) || {} ).textContent` ) );
        await esc();
        ok( await until( `! ( document.querySelector( '${OPEN} .search-count' ) || {} ).textContent` ), app + ": cleared, no count" );
        ok( ! errors().length, app + ": no errors", errors() );
    }
    if( ! PICS ) console.log( "  (no ImageMagick: Photos' count not tried)" );

    console.log( "PHONE - the open field keeps the header on one row" );
    for( const [ app, btn ] of [ [ "drive", "#searchToggleBtn" ], [ "calendar", "#searchBtn" ], [ "split", "#searchBtn" ], [ "contact", "#searchBtn" ], [ "bookmarks", "#searchBtn" ], [ "photos", "#searchToggle" ], [ "chat", "#listSearch" ], [ "trips", "#searchBtn" ] ] )
    {
        c.logs.length = 0;
        await open( app, 390 );
        if( ! await ev( `!! document.querySelector( '${btn}' )?.getClientRects().length` ) ) { ok( false, app + ": its Search button shows" ); continue; }
        await press( btn );
        await sleep( 300 );
        const r = JSON.parse( await ev( `JSON.stringify( ( () => { const f = document.querySelector( '${OPEN}' ); if( ! f ) return null;
            const row = f.closest( '.topbar, .header' ), fr = f.getBoundingClientRect(), mid = ( e ) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; };
            const kids = row ? [ ...row.children ].filter( k => k.getClientRects().length && k.getBoundingClientRect().width > 0 && ! /absolute|fixed/.test( getComputedStyle( k ).position ) ) : [];
            const mids = kids.map( mid );
            return { w: Math.round( fr.width ), focus: f.contains( document.activeElement ), inView: fr.left >= -1 && fr.right <= innerWidth + 1,
                     scrolls: !! row && row.scrollWidth > row.clientWidth + 1, spread: mids.length ? Math.round( Math.max( ...mids ) - Math.min( ...mids ) ) : 0, row: !! row }; } )() )` ) );
        ok( r && r.focus && r.w >= 179 && r.inView && ! r.scrolls, app + ": opens focused, at least 180 px, in view, the header does not scroll", r );
        if( r && r.row ) ok( r.spread < 16, app + ": one row", r );
        await shot( "phone-" + app );
        ok( ! errors().length, app + ": no errors", errors() );
    }

    console.log( "LANGUAGE - the dictionary searches on Enter / Go" );
    c.logs.length = 0;
    await open( "language", 1280 );
    await press( "#tabDic" );
    ok( await until( "! document.getElementById('v-dic').hidden" ), "the dictionary view opens" );
    await ev( "window.__looked = 0; document.getElementById('q').parentElement.addEventListener( 'ayni:search', () => window.__looked++ ); true" );
    await typeIn( "#q", "casa" );
    ok( await ev( "window.__looked === 0" ), "typing does not search" );
    await ev( "document.getElementById('q').focus(); true" );
    await enter();
    ok( await ev( "window.__looked === 1" ), "Enter searches" );
    await press( "#qGo" );
    ok( await ev( "window.__looked === 2" ), "…the Go magnifier too" );
    await esc();
    ok( await ev( "window.__looked === 3 && document.getElementById('q').value === '' && document.getElementById('entry').textContent === ''" ), "Esc empties it, and the old entry goes at once" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "CALC - the function list" );
    c.logs.length = 0;
    await open( "calc", 1280 );
    await ev( "document.getElementById('fxBackdrop').showModal(); document.getElementById('fxSearch').focus(); true" );
    await typeIn( "#fxSearch", "sum" );
    const fx = JSON.parse( await ev( "JSON.stringify( [ ...document.querySelectorAll( '#fxList .fx-item' ) ].map( b => b.dataset.fn ) )" ) );
    ok( fx.includes( "SUM" ) && ! fx.includes( "AVERAGE" ), "'sum' lists SUM, not AVERAGE", fx.slice( 0, 8 ) );
    await esc();
    ok( await ev( "document.getElementById('fxSearch').value === '' && document.getElementById('fxBackdrop').open" ), "Esc with text clears and keeps the dialog" );
    await esc();
    ok( await until( "! document.getElementById('fxBackdrop').open" ), "Esc on the empty field closes the dialog" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "DARK" );
    await ev( "Ayni.setTheme( 'dark' ); true" );
    await open( "drive", 390 );
    await press( "#searchToggleBtn" );
    await shot( "dark-drive-phone" );
    await ev( "Ayni.setTheme( 'light' ); true" );
    // Last: the typing makes Write ask before leaving, and a navigation would hang on it.
    console.log( "WRITE - the find bar" );
    c.logs.length = 0;
    await open( "write", 1280 );
    const at = JSON.parse( await ev( "( r => JSON.stringify( { x: r.left + 20, y: r.top + 20 } ) )( document.querySelector( '.docx-page-content' ).getBoundingClientRect() )" ) );
    for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] ) await mouse( type, at.x, at.y );
    await c.send( "Input.insertText", { text: "hello world, hello again" } );
    await sleep( 600 );
    await ctrl( "f" );
    ok( await until( "! document.getElementById('findBar').hidden && document.getElementById('findBar').classList.contains('find-bar')" ), "Ctrl+F opens Ayni's find bar" );
    const FIN = "#findBar .search-field input", FC = "document.querySelector('#findBar .search-count').textContent";
    await typeIn( FIN, "hello" );
    ok( await until( `${FC} === '1 / 2'` ), "two matches, the first picked (1 / 2)", await ev( FC ) );
    ok( await ev( "document.querySelectorAll('#findLayer .find-mark').length >= 2" ), "…both marked on the page" );
    await enter();
    ok( await until( `${FC} === '2 / 2'` ), "Enter: the next (2 / 2)", await ev( FC ) );
    await press( '#findBar [aria-label="' + await ev( "Ayni.t( 'ayni.matchCase' )" ) + '"]' );
    ok( await ev( "document.querySelector('#findBar [aria-pressed]').getAttribute('aria-pressed') === 'true'" ), "Match case toggles" );
    await typeIn( FIN, "HELLO" );
    ok( await until( `${FC} === '0'` ) && await ev( "document.getElementById('findBar').classList.contains('is-empty')" ), "…HELLO with Match case: a red 0" );
    await press( '#findBar [aria-label="' + await ev( "Ayni.t( 'ayni.matchCase' )" ) + '"]' );
    await ctrl( "h" );
    ok( await ev( "! document.querySelector('#findBar .find-replace').hidden" ), "Ctrl+H shows the replace row" );
    await ev( `( i => { i.value = 'bye'; } )( document.querySelector( '#findBar .find-replace input' ) ); true` );
    await press( '#findBar .find-replace .btn:last-child' );
    ok( await until( `${FC} === '0'` ), "Replace all: no HELLO left", await ev( FC ) );
    ok( await until( "/bye world, bye again/.test( document.querySelector( '.docx-page-content' ).innerText )" ), "…the text now says bye twice", await ev( "document.querySelector( '.docx-page-content' ).innerText.slice( 0, 80 )" ) );
    await ev( `document.querySelector( '${FIN}' ).focus(); true` );
    await esc(); await esc();
    ok( await until( "document.getElementById('findBar').hidden && ! document.querySelector('#findLayer .find-mark')" ), "Esc clears, then closes the bar (marks gone)" );
    await shot( "write-find" );
    ok( ! errors().length, "no errors", errors() );

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
