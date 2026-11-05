// all.mjs - the locker tests, each needing "a scratch server with the test/test
// account": this starts one (its own run-root in /tmp, a copy of client/apps, the
// port they expect), runs them one after the other and stops it.
//
//   node tools/locker-test/all.mjs
//
// The real store/ is never touched. science.mjs reads live news and pictures:
// a check on what today's feeds say can fail with no fault in the code.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "locker-test-" ) );
const PORT = 4471;     // the address these tests expect
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

let bad = 0;
for( const f of [ "run.mjs", "culture.mjs", "culture-settings.mjs", "science.mjs" ] )
{
    console.log( "== " + f );
    const r = spawnSync( process.execPath, [ path.join( HERE, "../locker-test", f ) ], { stdio: "inherit", timeout: 240000 } );
    if( r.status !== 0 ) bad++;
}
server.kill();
try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
console.log( bad ? bad + " FAILED" : "ALL GREEN" );
process.exit( bad ? 1 : 0 );
