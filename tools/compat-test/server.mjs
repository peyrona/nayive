// server.mjs - the scratch Nayive server the compat tools run against.
//
// A fresh build of server/go in /tmp, its own config, one user "test"
// (password "test") and a `cp -a` copy of client/apps. The real store/ is
// never written. With { seed: true } the user starts with a COPY of the local
// store/homes/test/ (trips with stages, tasks with subtasks, Drive files), so
// the screens show real rows instead of empty states.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HERE  = path.dirname( new URL( import.meta.url ).pathname );
export const REPO = path.resolve( HERE, "../.." );
const GO    = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
export const sleep = ms => new Promise( r => setTimeout( r, ms ) );

// Every app folder with an index.html, sorted.
export function allApps()
{
    return fs.readdirSync( path.join( REPO, "client/apps" ) )
             .filter( d => fs.existsSync( path.join( REPO, "client/apps", d, "index.html" ) ) ).sort();
}

// Starts the server; answers { base, dir, stop } (dir: the scratch run-root,
// whose apps/ a caller may change before loading a page).
export async function startServer( { seed = false } = {} )
{
    const run  = fs.mkdtempSync( path.join( os.tmpdir(), "compat-test-" ) );
    const port = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
    const base = `http://127.0.0.1:${port}`;

    const built = spawnSync( GO, [ "build", "-o", path.join( run, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
    if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
    fs.mkdirSync( `${run}/config` );
    fs.mkdirSync( `${run}/homes/test`, { recursive: true } );
    const local = path.join( REPO, "store/homes/test" );
    if( seed && fs.existsSync( local ) )
        spawnSync( "cp", [ "-a", local + "/.", `${run}/homes/test/` ], { stdio: "inherit" } );
    fs.mkdirSync( `${run}/homes/test/data`,  { recursive: true } );
    fs.mkdirSync( `${run}/homes/test/files`, { recursive: true } );
    fs.writeFileSync( `${run}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
    fs.writeFileSync( `${run}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );   // the copy's own password is replaced
    spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( run, "apps" ) ], { stdio: "inherit" } );

    const proc = spawn( path.join( run, "nayive" ), [ "-config", `${run}/config/server.json` ], { stdio: "ignore" } );
    for( let i = 0; i < 100; i++ ) { try { await fetch( base + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

    return {
        base,
        dir: run,
        stop() { try { proc.kill(); } catch {} try { fs.rmSync( run, { recursive: true, force: true } ); } catch {} }
    };
}

// Signs `page` in as "test", with the first-run cards (coach, install, intro) off.
export async function signIn( page, base )
{
    await page.goto( base + "/nayive/login.html" );
    return page.evaluate( () =>
    {
        localStorage.setItem( "balata-coach-seen", "1" );
        localStorage.setItem( "nayive-install-snooze", "never" );
        localStorage.setItem( "balata-intro-dismiss:launcher", "1" );
        localStorage.setItem( "balata-lang", "en" );
        return fetch( "/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify( { user: "test", password: "test" } ) } ).then( r => r.status );
    } );
}
