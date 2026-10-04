// run.mjs - the item browser (shared/browser.js) in every app that uses it,
// with real mouse, keyboard and touch input. See README.md.
//
//   node tools/browser-test/run.mjs          every app
//   node tools/browser-test/run.mjs drive    only the files whose name holds "drive"
//
// Each <app>.mjs beside this one builds its own scratch server (nothing of the
// real store/ is touched). Exits non-zero when anything fails.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE   = path.dirname( new URL( import.meta.url ).pathname );
const filter = process.argv.slice( 2 );
const files  = fs.readdirSync( HERE ).filter( f => /\.mjs$/.test( f ) && ! /^(run|lib)\.mjs$/.test( f ) ).sort()
                 .filter( f => ! filter.length || filter.some( x => f.includes( x ) ) );
const results = [];
for( const f of files )
{
    console.log( "== " + f );
    const r = spawnSync( process.execPath, [ path.join( HERE, f ) ], { stdio: "inherit", timeout: 15 * 60 * 1000 } );
    results.push( [ f, r.status === 0 ] );
}
console.log( "\n== item browser" );
for( const [ name, good ] of results ) console.log( ( good ? "  ok   " : "  FAIL " ) + name );
const bad = results.filter( r => ! r[ 1 ] ).length;
console.log( bad ? `${bad} FAILED` : "ALL GREEN" );
process.exit( bad ? 1 : 0 );
