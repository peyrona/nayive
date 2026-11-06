/*
 * run.mjs - Nayive on Ayni's helpers and Ayni.frame (wave A, family 1), against
 * the real server and real pages in headless Chromium:
 *     node tools/helpers-test/run.mjs
 *
 *   1. RULES: the old names are gone from the code; every page loads ayni-util.js
 *      right after ayni-i18n.js; the server and the service worker know the file.
 *   2. Frames: a whole page, Planner's panes (wide and phone), desktop windows, the
 *      launcher's frame, Planner inside a window; going home from each.
 *   3. Helpers in the apps: sizes in Drive by language, tooltip key hints, the zone
 *      the launcher sends, the el() that became Ayni.h.
 *
 * Builds server/go into a scratch run-root, as smoke-test does. store/ is never touched.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
const APPS = path.join( REPO, "client/apps" );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

let fails = 0, passes = 0;
function check( name, ok, info )
{
    if( ok ) { passes++; console.log( "ok   " + name ); }
    else { fails++; console.log( "FAIL " + name + ( info !== undefined ? "  " + JSON.stringify( info ) : "" ) ); }
}

//---------------------------------------------------------------- 1. RULES (no browser)
console.log( "\nRULES" );
function walk( dir, out = [] )
{
    for( const e of fs.readdirSync( dir, { withFileTypes: true } ) )
    {
        if( [ "lib", "vendor", "ayni", ".bak", "node_modules" ].includes( e.name ) ) continue;
        const p = path.join( dir, e.name );
        if( e.isDirectory() ) walk( p, out );
        else if( /\.(js|html)$/.test( e.name ) ) out.push( p );
    }
    return out;
}
const OLD = /\bNayiveUI\.(h|escapeHtml|pad2|todayIso|extOf|baseName|uniqueName|slugify|fmtBytes|copyText|saveFile|isMac|isIOS|keyHints|timeZones|viewerTz|windowed|followPath)\b|\bNayiveMedia\.(esc|cssEsc|cssUrl|extOf|baseName|dirOf|stripExt|fmtClock|fmtRuntime|fmtSize|sleep|pool)\b|\b(O|AyniDoc)\.(extOf|baseName|dirName)\b/;
const sources = walk( APPS ), left = [], tags = [];
for( const f of sources )
{
    const s = fs.readFileSync( f, "utf8" ), rel = path.relative( APPS, f );
    if( OLD.test( s ) ) left.push( rel );
    if( /nayive\/desktop\//.test( s ) && /WINDOWED|windowed/.test( s ) ) left.push( rel + " (path test)" );
    if( f.endsWith( ".html" ) && s.includes( "ayni-base.js" ) )
    {
        const lines = s.split( "\n" ), i = lines.findIndex( l => l.includes( "ayni-i18n.js" ) );
        const util = lines.findIndex( l => l.includes( "ayni-util.js" ) ), base = lines.findIndex( l => l.includes( "ayni-base.js" ) );
        if( util !== i + 1 || util > base ) tags.push( rel );
    }
}
check( "the old helper names are gone from the code", left.length === 0, left );
check( "every page with Ayni loads ayni-util.js right after ayni-i18n.js", tags.length === 0, tags );
check( "no copy of the moved jobs left: el, pad, sleep, today in the apps moved",
       ! /function el\( tag, cls, text \)/.test( [ "habits/index.html", "split/index.html", "language/page.js", "language/admin.js" ].map( f => fs.readFileSync( path.join( APPS, f ), "utf8" ) ).join( "" ) ) );
{
    const set = fs.readFileSync( path.join( APPS, "shared/ayni/ayni-icons-more.js" ), "utf8" ), names = new Set( [ "nayive", "write", "calc" ] );
    for( const m of set.matchAll( /^ {4}"?([a-z0-9-]+)"?:\s*(?:$|')/gm ) ) names.add( m[ 1 ] );
    for( const m of fs.readFileSync( path.join( APPS, "shared/ayni/ayni-icons.js" ), "utf8" ).matchAll( /symbol id="i-([\w-]+)"/g ) ) names.add( m[ 1 ] );
    const missing = new Set();
    for( const f of sources )
    {
        const s = fs.readFileSync( f, "utf8" );
        for( const m of s.matchAll( /<symbol id="i-([\w-]+)"/g ) ) names.add( m[ 1 ] );       // a page's own sprite
    }
    for( const f of sources )
    {
        const s = fs.readFileSync( f, "utf8" );
        for( const m of s.matchAll( /Ayni\.icon\( *['"]([a-z0-9-]+)['"]|href=\\?['"]#i-([a-z0-9-]+)/g ) )
            if( ! names.has( m[ 1 ] || m[ 2 ] ) ) missing.add( path.relative( APPS, f ) + ": " + ( m[ 1 ] || m[ 2 ] ) );
    }
    check( "every icon the code names is in Ayni's set", missing.size === 0, [ ...missing ] );
    check( "the brand stays Nayive's", ! /^ {4}"?(nayive|write|calc)"?:/m.test( set ) );
}
const has = ( f, t ) => fs.readFileSync( path.join( REPO, f ), "utf8" ).includes( t );
check( "the server, the service worker and the precache list know the file",
       has( "server/go/static.go", "shared/ayni/ayni-util.js" ) && has( "client/apps/sw.js", "shared/ayni/ayni-util.js" ) && has( "tools/build-precache/main.go", "shared/ayni/ayni-util.js" ) );
check( "the pinned copy has no Nayive word in the helpers", ! /nayive|balata|\/api\//i.test( fs.readFileSync( path.join( APPS, "shared/ayni/ayni-util.js" ), "utf8" ) ) );

//---------------------------------------------------------------- the server
const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "helpers-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;
const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files/Box`, { recursive: true } );
fs.writeFileSync( `${RUN}/homes/test/files/Box/small.txt`, "x".repeat( 1536 ) );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "admin", password: "admin" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
spawnSync( "cp", [ "-a", APPS, path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Page.bringToFront" );
    await c.send( "Emulation.setFocusEmulationEnabled", { enabled: true } );
    const size = ( width, height, mobile = false ) => c.send( "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile } );
    const ev = ( e, ms ) => c.evaluate( e, ms );
    async function until( expr, ms = 8000 )
    {
        const end = Date.now() + ms;
        for( ;; )
        {
            let v = null;
            try { v = await ev( expr ); } catch {}
            if( v ) return v;
            if( Date.now() > end ) return v;
            await sleep( 50 );
        }
    }
    async function go( url, ready )
    {
        await c.send( "Page.navigate", { url: BASE + url } );
        await sleep( 300 );
        return until( ready || "window.Ayni && Ayni.ready && document.readyState === 'complete'" );
    }
    const FRAME = `( function ( w ) { return { embedded: w.Ayni.frame.embedded, windowed: w.Ayni.frame.windowed, top: w.Ayni.frame.owner() === window.top,
        classes: w.document.documentElement.className.split( /\\s+/ ).filter( function ( c ) { return /^is-/.test( c ); } ).sort().join() }; } )`;

    await size( 1366, 800 );
    await go( "/nayive/login.html" );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    check( "signed in", st === 200, st );
    const util = await fetch( BASE + "/nayive/shared/ayni/ayni-util.js" );
    check( "the server serves ayni-util.js", util.status === 200, util.status );

    //------------------------------------------------------------ 2. FRAMES
    console.log( "\nFRAMES" );
    await go( "/nayive/drive/index.html" );
    let f = await ev( `${FRAME}( window )` );
    check( "a whole page: not embedded, no class", ! f.embedded && ! f.windowed && f.classes === "", f );
    const gone = await ev( `[ 'h','escapeHtml','pad2','todayIso','extOf','fmtBytes','copyText','saveFile','isMac','isIOS','viewerTz','timeZones','windowed' ].filter( function ( k ) { return k in NayiveUI; } )
        .concat( [ 'esc','dirOf','fmtClock','fmtSize','sleep','pool' ].filter( function ( k ) { return window.NayiveMedia && k in NayiveMedia; } ) )` );
    check( "NayiveUI and NayiveMedia hold none of the moved names", gone.length === 0, gone );

    await go( "/nayive/planner/index.html", "window.Ayni && document.getElementById( 'calendarPane' ) && document.getElementById( 'calendarPane' ).contentWindow.Ayni && document.getElementById( 'calendarPane' ).contentWindow.Ayni.frame" );
    const PANE = "document.getElementById( 'calendarPane' ).contentWindow";
    await until( `${PANE}.document.readyState === 'complete'` );
    f = await ev( `${FRAME}( ${PANE} )` );
    check( "Planner's pane: embedded, wide on a big screen, the top owns the address", f.embedded && ! f.windowed && f.top && f.classes === "is-embedded,is-embedded-wide", f );
    check( "...the host is a whole page", await ev( "! Ayni.frame.embedded" ) );
    check( "...the app's own title is hidden, its icon stays as the pane's label", await ev( `( function ( w ) { var d = w.document, i = d.querySelector( '.app-icon' ), h = d.querySelector( '.header h1, .topbar h1' ); return ! h || w.getComputedStyle( h ).display === 'none'; } )( ${PANE} )` ) );
    await size( 390, 800, true );
    check( "a phone: the pane loses -wide", await until( `! ${PANE}.document.documentElement.classList.contains( 'is-embedded-wide' )` ) );
    await size( 1366, 800 );

    await go( "/nayive/desktop/index.html", "window.AyniDesk && window.AyniDesk.open" );
    const WIN = i => `document.querySelectorAll( '#desk > .win iframe' )[ ${i} ]`;
    await ev( `AyniDesk.open( '/nayive/drive/index.html' )` );
    await until( `${WIN( 0 )} && ${WIN( 0 )}.contentWindow.Ayni && ${WIN( 0 )}.contentWindow.Ayni.frame && ${WIN( 0 )}.contentDocument.readyState === 'complete'` );
    check( "a desktop window's frame carries the mark", await ev( `${WIN( 0 )}.hasAttribute( 'data-ayni-window' )` ) );
    f = await ev( `${FRAME}( ${WIN( 0 )}.contentWindow )` );
    check( "Drive in a window: windowed, the top owns the address", f.embedded && f.windowed && f.top && f.classes === "is-windowed", f );
    check( "...the desktop page itself is neither", await ev( "! Ayni.frame.embedded && ! document.documentElement.className.includes( 'is-' )" ) );
    await until( `${WIN( 0 )}.contentDocument.querySelector( '.home-link' )` );
    await ev( `( ${WIN( 0 )}.contentDocument.querySelector( '.home-link' ).dispatchEvent( new ( ${WIN( 0 )}.contentWindow.MouseEvent )( 'click', { bubbles: true, cancelable: true } ) ), true )` );
    check( "going home from a window opens the desktop's menu, the desktop stays", await until( "! document.getElementById( 'menu' ).hidden" ) && await ev( "location.pathname.indexOf( '/nayive/desktop/' ) === 0" ) );
    const LAUNCHER = "document.querySelector( '#menu iframe' )";
    if( await until( `!! ${LAUNCHER} && ${LAUNCHER}.contentWindow.Ayni && ${LAUNCHER}.contentWindow.Ayni.frame` ) )
    {
        f = await ev( `${FRAME}( ${LAUNCHER}.contentWindow )` );
        check( "the launcher's frame counts as a window", f.embedded && f.windowed && f.classes === "is-windowed", f );
    }
    else check( "the launcher's frame counts as a window", false, "no frame" );

    await ev( `AyniDesk.open( '/nayive/planner/index.html' )` );
    await until( `${WIN( 1 )} && ${WIN( 1 )}.contentDocument.getElementById( 'calendarPane' ) && ${WIN( 1 )}.contentDocument.getElementById( 'calendarPane' ).contentWindow.Ayni && ${WIN( 1 )}.contentDocument.getElementById( 'calendarPane' ).contentWindow.Ayni.frame` );
    f = await ev( `${FRAME}( ${WIN( 1 )}.contentWindow )` );
    check( "Planner in a window: windowed", f.windowed && f.classes === "is-windowed", f );
    f = await ev( `${FRAME}( ${WIN( 1 )}.contentDocument.getElementById( 'calendarPane' ).contentWindow )` );
    check( "...its pane is a pane, not a window", f.embedded && ! f.windowed && f.classes.startsWith( "is-embedded" ), f );

    //------------------------------------------------------------ 3. HELPERS IN THE APPS
    console.log( "\nHELPERS" );
    await ev( "localStorage.setItem( 'drive-view', 'list' ), true" );   // sizes show in the list, not the icons
    await go( "/nayive/drive/index.html?sel=" + encodeURIComponent( "files/Box/small.txt" ) );
    await until( "document.body.innerText.includes( 'small.txt' )" );
    check( "Drive shows the size", /1\.5 KB/.test( await ev( "document.body.innerText" ) ), await ev( "document.body.innerText.slice( 0, 200 )" ) );
    const tips = await ev( `[].slice.call( document.querySelectorAll( '[data-tip]' ) ).map( function ( e ) { return e.dataset.tip; } ).filter( function ( t ) { return /\\((Ctrl|⌘)/.test( t ); } )` );
    check( "Drive's tooltips carry their shortcut", tips.length > 0, tips );
    await ev( "( NayiveUI.pickFile( {} ), true )" );
    check( "the file picker opens and shows sizes (it takes Ayni.fmtBytes)", await until( "document.querySelector( 'dialog.panel[open] .fp-row' )" ) );
    await ev( "( document.querySelector( 'dialog.panel[open]' ).close(), true )" );
    await ev( "localStorage.setItem( 'ayni-lang', 'es' ), true" );
    await go( "/nayive/drive/index.html?sel=" + encodeURIComponent( "files/Box/small.txt" ) );
    await until( "document.body.innerText.includes( 'small.txt' )" );
    check( "in Spanish the decimal mark is a comma", /1,5 KB/.test( await ev( "document.body.innerText" ) ) );
    await ev( "localStorage.setItem( 'ayni-lang', 'en' ), true" );

    await go( "/nayive/index.html" );
    await sleep( 800 );
    const tz = await ev( "performance.getEntriesByType( 'resource' ).map( function ( e ) { return e.name; } ).filter( function ( n ) { return n.indexOf( 'calendar/today?tz=' ) > 0; } )" );
    check( "the launcher sends the device's zone", tz.length > 0 && tz[ 0 ].endsWith( encodeURIComponent( await ev( "Ayni.dates.zone()" ) ) ), tz );
    check( "the launcher offers Ayni's scheme dialog", await ev( "typeof Ayni.schemeDialog === 'function' && !! document.getElementById( 'schemesBtn' ) && document.querySelectorAll( '#scmBackdrop' ).length === 1" ) );
    await ev( "( document.getElementById( 'schemesBtn' ).click(), true )" );
    check( "...its button opens it on the four schemes, in the page's language", await until( "document.getElementById( 'scmBackdrop' ).open && document.querySelectorAll( '#scmList .scm-row' ).length === 4" ) && await ev( "! /ayni\\.|^scm\\./.test( document.getElementById( 'scmBackdrop' ).innerText )" ) );
    await ev( "( document.getElementById( 'scmBackdrop' ).close(), true )" );
    await go( "/nayive/calculator/index.html" );
    check( "an icon drawn in a page shows", await until( "[ ...document.querySelectorAll( '.icon[data-icon] svg use' ) ].some( u => document.querySelector( u.getAttribute( 'href' ) ) )" ) );
    check( "...no icon is missing", await ev( "[ ...document.querySelectorAll( '.icon[data-icon]' ) ].every( e => e.querySelector( 'svg' ) && document.getElementById( 'i-' + e.dataset.icon ) )" ) );
    await go( "/nayive/calendar/index.html" );
    check( "the icon and the name go home", await until( "document.querySelectorAll( '.app-icon.home-link, h1.home-link' ).length >= 1" ) );
    check( "--win-head-h and the shell's rules are loaded", await ev( "getComputedStyle( document.querySelector( '.topbar' ) ).display === 'flex'" ) );
    check( "the plug is Ayni's and floats only when the link is bad", await ev( "typeof Ayni.plug.set === 'function' && typeof Ayni.badge === 'function' && typeof Ayni.spaceCard === 'function'" ) );
    await go( "/nayive/drive/index.html" );
    check( "the share dialog opens through Ayni", await ev( "typeof Ayni.share === 'function' && typeof Ayni.ensureRoom === 'function' && typeof Ayni.uploads === 'function'" ) );
    await ev( "( NayiveUI.shareSheet( { path: 'files/Box', app: 'folder', title: 'Box' } ), true )" );
    check( "...with its texts", await until( "document.querySelector( 'dialog.panel[open]' ) && ! /ayni\\.|share\\./.test( document.querySelector( 'dialog.panel[open]' ).innerText )" ) );
    await ev( "( document.querySelector( 'dialog.panel[open]' ).close(), true )" );
    check( "the helpers build as el() did", await ev( `( function () {
        function el( tag, cls, text ) { var e = document.createElement( tag ); if( cls ) e.className = cls; if( text != null ) e.textContent = text; return e; }
        return [ [ 'div', 'a', 't' ], [ 'div', null, null ], [ 'span', '', 0 ], [ 'b', undefined, '' ], [ 'i', 'x' ], [ 'p' ] ]
            .every( function ( a ) { return el.apply( null, a ).outerHTML === Ayni.h.apply( null, a ).outerHTML; } ); } )()` ) );
}
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( `\n${passes} passed, ${fails} failed` );
console.log( fails ? "FAILED" : "ALL GREEN" );
process.exit( fails ? 1 : 0 );
