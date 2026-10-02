// run.mjs - load every app in a real (headless) browser and report any page
// exception. The cheapest "nothing is broken" check, run after every change.
//
//   node tools/smoke-test/run.mjs [app ...]     (default: every app)
//
// Builds server/go into a scratch run-root in /tmp (its own config, one user
// "test", a `cp -a` copy of client/apps), serves it on a free port, signs in,
// opens the launcher and each app with the service worker bypassed. The real
// store/ is never touched. Exits non-zero when an app throws.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || "go";
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const APPS = process.argv.slice( 2 ).length ? process.argv.slice( 2 )
           : fs.readdirSync( path.join( REPO, "client/apps" ) )
               .filter( d => fs.existsSync( path.join( REPO, "client/apps", d, "index.html" ) ) ).sort();

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "smoke-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
// cp -a keeps the mtimes, so a stale .gz sidecar stays older than its source.
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

const b = await browser();
let bad = 0;
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await c.evaluate( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('balata-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    if( st !== 200 ) { console.log( "sign-in failed: " + st ); bad++; }

    for( const app of [ "", ...APPS ] )
    {
        const from = c.logs.length;
        const want = `/nayive/${app ? app + "/" : ""}`;
        // The desktop sends a phone-size screen back to the launcher, by design.
        const wide = app === "desktop";
        await c.send( "Emulation.setDeviceMetricsOverride", { width: wide ? 1280 : 390, height: 800, deviceScaleFactor: 1, mobile: ! wide } );
        await c.send( "Page.navigate", { url: BASE + want } );
        await sleep( app === "write" ? 7000 : 3500 );
        const at   = await c.evaluate( "location.pathname" ).catch( () => "?" );
        const errs = c.logs.slice( from ).filter( l => /^EXCEPTION/.test( l ) );
        const lost = ! at.startsWith( want );          // bounced to login, 404...
        if( errs.length || lost ) bad++;
        console.log( ( errs.length || lost ? "ERR " : "ok  " ) + ( app || "launcher" ) + " @ " + at +
                     ( errs.length ? "  " + JSON.stringify( errs ).slice( 0, 400 ) : "" ) );
    }
}
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( bad ? bad + " app(s) with problems" : "ALL APPS LOAD CLEAN" );
process.exit( bad ? 1 : 0 );
