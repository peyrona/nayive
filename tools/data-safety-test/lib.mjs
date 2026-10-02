// lib.mjs - what every data-safety test shares: a scratch server, a browser,
// sign-in, waits, and a plain HTTP client for "the other device".
//
//   import { server, browser, ok, done } from "./lib.mjs";
//   const s = await server();                  // build + start, user test/test
//   const c = await browser( s );              // headless Chromium, signed in
//   await c.open( "/nayive/text/?file=files/a.txt", "/nayive/text/" );
//   ok( await c.until( "document.title" ), "loaded" );
//   const phone = await s.client();            // a second session over HTTP
//   await phone.put( "files/a.txt", "from the phone" );
//   await done( s, c );                        // stops everything, exits 0/1
//
// Nothing of the real store/ is touched: the run-root is a fresh folder in
// /tmp with its own config, users and a `cp -a` copy of client/apps.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser as chromium, attach } from "../cdp.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
export const REPO = path.resolve( HERE, "../.." );
const GO = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );

export const sleep = ms => new Promise( r => setTimeout( r, ms ) );

//------------------------------------------------------------------------//
// CHECKS

let pass = 0, fail = 0;
export function ok( cond, what, extra )
{
    if( cond ) { pass++; console.log( "  ok   " + what ); }
    else { fail++; console.log( "  FAIL " + what + ( extra !== undefined ? "  -> " + JSON.stringify( extra ) : "" ) ); }
    return !! cond;
}
export function section( name ) { console.log( name ); }

// Stops the browser(s) and the server, prints the tally, exits 0 / 1.
export async function done( ...things )
{
    for( const t of things ) { try { await t?.stop?.(); } catch {} }
    if( built ) { try { fs.rmSync( built, { recursive: true, force: true } ); } catch {} }
    console.log( `${pass} passed, ${fail} failed` );
    process.exit( fail ? 1 : 0 );
}

//------------------------------------------------------------------------//
// SCRATCH SERVER
//
// users: { name: password } (default { test: "test" }). Every user gets
// homes/<name>/data/config.json and files/. Returns the base URL, the run-root
// (to look at files on disk), a node-side client maker, and stop().

let built = null;      // one build per process

// A port nobody listens on right now. Only a guess: it is free again the
// moment this returns, and anything on the machine may take it before our
// server binds it - see server() below.
export const freePort = () => new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );

export async function server( users = { test: "test" } )
{
    const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "ds-test-" ) );

    if( ! built )
    {
        built = fs.mkdtempSync( path.join( os.tmpdir(), "ds-bin-" ) );
        const b = spawnSync( GO, [ "build", "-o", path.join( built, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
        if( b.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
    }
    fs.mkdirSync( `${RUN}/config` );
    for( const [ u, pw ] of Object.entries( users ) )
    {
        fs.mkdirSync( `${RUN}/homes/${u}/data`, { recursive: true } );
        fs.mkdirSync( `${RUN}/homes/${u}/files` );
        fs.writeFileSync( `${RUN}/homes/${u}/data/config.json`, JSON.stringify( { password: pw } ) );
    }
    // cp -a keeps the mtimes, so a stale .gz sidecar stays older than its source.
    spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );

    // THIS run's server, told apart from any other by a token only it serves
    // (icons/ is public: no sign-in needed). The port is picked free, closed,
    // then handed to the server - and in that gap a busy machine (another
    // suite's scratch server, `go test`'s httptest servers) may take it. Our
    // server then cannot bind and stops, and "the port answers" alone would
    // have the whole test talk to that other server: its sign-in answered
    // 401 for our user (ds-drive-bin, under load). So: ready = OUR token
    // comes back; our server gone first = the port was taken: a new one.
    const TOKEN = `ds-run-${process.pid}-${Date.now()}-${Math.random().toString( 36 ).slice( 2 )}`;
    fs.writeFileSync( `${RUN}/apps/icons/ds-run.txt`, TOKEN );
    let proc = null, BASE = "", tail = "";
    for( let attempt = 1; ! BASE; attempt++ )
    {
        const port = await freePort();
        fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
        tail = "";
        proc = spawn( path.join( built, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: [ "ignore", "ignore", "pipe" ] } );
        proc.stderr.on( "data", d => { tail = ( tail + d ).slice( -4000 ); } );    // read always: a full pipe would stall the server
        let exited = false;
        proc.once( "exit", () => { exited = true; } );
        const url = `http://127.0.0.1:${port}`;
        const end = Date.now() + 90000;     // a loaded machine starts it slowly
        while( ! exited && Date.now() < end )
        {
            try
            {
                const r = await fetch( url + "/nayive/icons/ds-run.txt" );
                if( r.status === 200 && ( await r.text() ) === TOKEN ) { BASE = url; break; }
            }
            catch {}
            await sleep( 100 );
        }
        if( BASE ) break;
        try { proc.kill(); } catch {}
        if( attempt >= 5 ) throw new Error( `the scratch server did not start (${attempt} ports tried): ${tail}` );
        console.log( `  (port ${port} was not ours - ${exited ? "the server stopped: " + tail.trim().split( "\n" ).pop() : "no answer"} - another port)` );
    }

    const s = {
        base: BASE, run: RUN, users,
        home: u => `${RUN}/homes/${u || Object.keys( users )[ 0 ]}`,
        // A second "device": its own session cookie, plain HTTP.
        client: ( u, pw ) => client( BASE, u || Object.keys( users )[ 0 ], pw || users[ u || Object.keys( users )[ 0 ] ] ),
        stop: async () =>
        {
            try { proc.kill(); } catch {}
            await new Promise( r => { if( proc.exitCode !== null ) r(); else { proc.once( "exit", r ); setTimeout( r, 2000 ); } } );
            try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
        }
    };
    return s;
}

// A node-side session: get / put / post / del answer { status, headers, text }.
export async function client( base, user, password )
{
    const r = await fetch( base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
                                                  body: JSON.stringify( { user, password } ) } );
    if( r.status !== 200 ) throw new Error( `login ${user}: ${r.status}` );
    const cookie = r.headers.getSetCookie().map( x => x.split( ";" )[ 0 ] ).join( "; " );
    const call = async ( method, url, body, headers = {} ) =>
    {
        const res = await fetch( base + url, { method, headers: { Cookie: cookie, ...headers }, body } );
        return { status: res.status, headers: res.headers, text: await res.text() };
    };
    const f = p => "/api/files?file=" + encodeURIComponent( p );
    return {
        cookie, call,
        get:  ( p, headers )       => call( "GET", f( p ), undefined, headers ),
        put:  ( p, body, headers ) => call( "PUT", f( p ), body, headers ),
        post: ( url, body, headers ) => call( "POST", url, body, headers ),
        del:  ( url, headers )     => call( "DELETE", url, undefined, headers ),
    };
}

//------------------------------------------------------------------------//
// BROWSER
//
// A headless Chromium signed in as `user` on server `s`. mouse: true makes it
// report a real mouse (hover / fine pointer) - headless otherwise does not.
// Every page gets: service worker bypassed, coach marks / install sheet off,
// language `lang`, and a toast recorder (window.__toasts).

const MOUSE = [ "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4" ];
const QUIET = ( lang ) => `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
    localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('balata-lang', ${JSON.stringify( lang )}); true`;
const TOASTS = `( () => { if( window.__toastsOn ) return true; window.__toastsOn = true; window.__toasts = [];
    const t = document.getElementById('toast'); if( ! t ) return true;
    new MutationObserver( () => { if( t.classList.contains('show') ) window.__toasts.push( t.textContent ); } )
        .observe( t, { attributes: true, childList: true, characterData: true, subtree: true } ); return true; } )()`;

export async function browser( s, { user, password, mouse = false, lang = "en", width = 1280, height = 800 } = {} )
{
    const u  = user || Object.keys( s.users )[ 0 ];
    const pw = password || s.users[ u ];
    const b = await chromium( mouse ? MOUSE : [] );
    const pages = [];

    async function tab( url = "about:blank" )
    {
        const t = await b.newTab( "about:blank" );
        const c = await attach( t.webSocketDebuggerUrl );
        c.id = t.id;
        await c.send( "Network.enable" );
        await c.send( "Network.setBypassServiceWorker", { bypass: true } );
        await c.send( "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 } );
        await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: `try{ ${QUIET( lang )} }catch(e){}` } );
        c.until = ( expr, ms = 15000 ) => until( c, expr, ms );
        c.open  = ( p, want ) => open( c, s.base + p, want || p.split( "?" )[ 0 ] );
        c.front = () => c.send( "Page.bringToFront" );
        c.toasts = async () => { await c.evaluate( TOASTS ).catch( () => {} ); return c.evaluate( "window.__toasts || []" ); };
        c.watchToasts = () => c.evaluate( TOASTS );
        pages.push( c );
        if( url !== "about:blank" ) await c.open( url );
        return c;
    }

    const first = await tab();
    await open( first, s.base + "/nayive/login.html", "/nayive/login.html" );
    const st = await first.evaluate( `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({user:${JSON.stringify( u )},password:${JSON.stringify( pw )}})}).then(r=>r.status)` );
    if( st !== 200 ) throw new Error( "browser sign-in failed: " + st );

    first.tab  = tab;
    first.port = b.port;
    first.stop = () => b.kill();
    return first;
}

// Waits for a CONDITION, never a fixed time. Returns true / false.
export async function until( c, expr, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end )
    {
        try { if( await c.evaluate( "!!(" + expr + ")" ) ) return true; } catch {}
        await sleep( 100 );
    }
    return false;
}

// Navigates and waits for THAT page (the old document answers "complete"
// before the new one starts, so the path is checked too).
export async function open( c, url, wantPath )
{
    await c.send( "Page.navigate", { url } );
    const okd = await until( c, `location.pathname === ${JSON.stringify( wantPath )} && document.readyState === 'complete'`, 20000 );
    if( okd ) await c.evaluate( TOASTS ).catch( () => {} );
    return okd;
}

// Types text into whatever has the focus (the page must be in front).
export async function type( c, text )
{
    await c.send( "Page.bringToFront" );
    await c.send( "Input.insertText", { text } );
}

// A real mouse click at the centre of `selector` (button:'left' on every event).
export async function click( c, selector )
{
    const r = await c.evaluate( `( () => { const e = document.querySelector( ${JSON.stringify( selector )} ); if( ! e ) return null;
        const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } )()` );
    if( ! r ) throw new Error( "click: no " + selector );
    await c.send( "Page.bringToFront" );
    for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] )
        await c.send( "Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } );
}

// The file as the server has it now (bytes as text), or null when missing.
export function onDisk( s, rel, user )
{
    try { return fs.readFileSync( path.join( s.home( user ), rel ), "utf8" ); } catch { return null; }
}
