// run.mjs - every tour check in this folder, one after the other.
//   node tools/tour-test/run.mjs [name...]     (e.g. habits shared)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const want = process.argv.slice( 2 );
const files = fs.readdirSync( HERE ).filter( f => f.endsWith( ".mjs" ) && ! [ "lib.mjs", "run.mjs" ].includes( f ) )
                .filter( f => ! want.length || want.includes( f.replace( /\.mjs$/, "" ) ) ).sort();
let bad = [];
for( const f of files )
{
    console.log( "\n=== " + f );
    const r = spawnSync( process.execPath, [ path.join( HERE, f ) ], { stdio: "inherit" } );
    if( r.status !== 0 ) bad.push( f );
}
console.log( bad.length ? "\nFAILED: " + bad.join( ", " ) : "\nALL GREEN (" + files.length + " files)" );
process.exit( bad.length ? 1 : 0 );
