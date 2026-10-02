// run.mjs - THE data-safety suite: every test that guards a user-data write,
// move or delete path (the "sealed CRUD" code, docs: README.md here).
//
//   node tools/data-safety-test/run.mjs            everything
//   node tools/data-safety-test/run.mjs office     only the browser tests whose name holds "office"
//   node tools/data-safety-test/run.mjs --go-only  only the Go tests
//
// 1. Go: `go test -count=1 -run TestDS ./...` in server/go (every TestDS_* function).
// 2. Browser: every ds-*.mjs file beside this one, one after the other (each
//    builds its own scratch server; nothing of the real store/ is touched).
// Exits non-zero when anything fails.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
const args = process.argv.slice( 2 );
const goOnly = args.includes( "--go-only" );
const filter = args.filter( a => ! a.startsWith( "--" ) );

const results = [];

if( ! filter.length )
{
    console.log( "== Go: TestDS_*" );
    const g = spawnSync( GO, [ "test", "-count=1", "-run", "TestDS", "./..." ],
                         { cwd: path.join( REPO, "server/go" ), stdio: "inherit", env: { ...process.env } } );
    results.push( [ "go TestDS_*", g.status === 0 ] );
}

if( ! goOnly )
{
    const files = fs.readdirSync( HERE ).filter( f => /^ds-.*\.mjs$/.test( f ) ).sort()
                    .filter( f => ! filter.length || filter.some( x => f.includes( x ) ) );
    for( const f of files )
    {
        console.log( "== " + f );
        const r = spawnSync( process.execPath, [ path.join( HERE, f ) ], { stdio: "inherit", timeout: 15 * 60 * 1000,
                                                                           env: { ...process.env, GO } } );
        results.push( [ f, r.status === 0 ] );
    }
}

console.log( "\n== data-safety suite" );
for( const [ name, good ] of results ) console.log( ( good ? "  ok   " : "  FAIL " ) + name );
const bad = results.filter( r => ! r[ 1 ] ).length;
console.log( bad ? `${bad} FAILED` : "ALL GREEN" );
process.exit( bad ? 1 : 0 );
