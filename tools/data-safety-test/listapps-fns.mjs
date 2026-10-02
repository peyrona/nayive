// listapps-fns.mjs - the list apps' REAL merge functions under Node, no browser
// and no server: what the ds-listapps-*.mjs node tests run their cases on.
//
//   const ical = await loadIcal();                  // client/apps/shared/ical.js, as the app imports it
//   const S    = loadStore();                       // NayiveStore (shared/store.js): mergeLists...
//   const V    = loadVcard();                       // NayiveVCard (shared/vcard.js)
//   const f    = appFns( "client/apps/contact/index.html", [ "mergeBook", ... ], { NayiveStore: S } );
//
// appFns cuts each named `function name(...) {...}` out of the app's file (brace
// matched) and runs them together in one context with the given globals, so a
// function finds the helpers it calls. Not a test itself (no "ds-" prefix).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { REPO } from "./lib.mjs";

const require = createRequire( import.meta.url );
export const read = rel => fs.readFileSync( path.join( REPO, rel ), "utf8" );

// ical.js imports "./lib/ical_v2.2.1.esm.min.js", which Node will not load as
// a module under a .js name: both are copied to a scratch folder as .mjs.
// luxon and rrule are the page's classic-script globals; NayiveUI.pad2 too.
export async function loadIcal()
{
    const LIB = path.join( REPO, "client/apps/shared/lib" );
    vm.runInThisContext( fs.readFileSync( path.join( LIB, "luxon_v3.7.2.min.js" ), "utf8" ) + "\n;globalThis.luxon = luxon;" );
    globalThis.rrule    = require( path.join( LIB, "rrule_v2.8.1.min.js" ) );
    globalThis.NayiveUI = { pad2: n => ( n < 10 ? "0" : "" ) + n };

    const dir = fs.mkdtempSync( path.join( os.tmpdir(), "ds-ical-" ) );
    fs.mkdirSync( path.join( dir, "lib" ) );
    fs.copyFileSync( path.join( LIB, "ical_v2.2.1.esm.min.js" ), path.join( dir, "lib/ical_v2.2.1.esm.min.mjs" ) );
    fs.writeFileSync( path.join( dir, "ical.mjs" ),
                      read( "client/apps/shared/ical.js" ).replace( "./lib/ical_v2.2.1.esm.min.js", "./lib/ical_v2.2.1.esm.min.mjs" ) );
    const mod = await import( path.join( dir, "ical.mjs" ) );
    fs.rmSync( dir, { recursive: true, force: true } );
    return mod;
}

function classic( rel, global, extra = {} )
{
    const ctx = { console, setTimeout, clearTimeout, Date, JSON, Math, Promise, Object, Array, String, Number, Map, Set,
                  TextEncoder, TextDecoder, Uint8Array, navigator: { onLine: true },
                  document: { cookie: "", addEventListener() {}, visibilityState: "visible" }, ...extra };
    ctx.window = ctx; ctx.addEventListener = () => {};
    vm.createContext( ctx );
    vm.runInContext( read( rel ), ctx );
    return ctx[ global ];
}

export const loadStore = () => classic( "client/apps/shared/store.js", "NayiveStore" );
export const loadVcard = () => classic( "client/apps/shared/vcard.js", "NayiveVCard" );

// The source of `function name( ... ) { ... }` in `src` (strings, template
// literals and comments skipped while matching braces).
export function extract( src, name )
{
    const m = new RegExp( "(?:async\\s+)?function\\s+" + name + "\\s*\\(" ).exec( src );
    if( ! m ) throw new Error( "no function " + name );
    let p = m.index + m[ 0 ].length, depthP = 1;
    while( depthP ) { const c = src[ p++ ]; if( c === "(" ) depthP++; else if( c === ")" ) depthP--; }
    const i = src.indexOf( "{", p );
    let depth = 0, j = i, inStr = null;
    for( ; j < src.length; j++ )
    {
        const c = src[ j ], n = src[ j + 1 ];
        if( inStr ) { if( c === "\\" ) { j++; continue; } if( c === inStr ) inStr = null; continue; }
        if( c === "/" && n === "/" ) { j = src.indexOf( "\n", j ); continue; }
        if( c === "/" && n === "*" ) { j = src.indexOf( "*/", j ) + 1; continue; }
        if( c === '"' || c === "'" || c === "`" ) { inStr = c; continue; }
        if( c === "{" ) depth++;
        else if( c === "}" ) { depth--; if( depth === 0 ) break; }
    }
    return src.slice( m.index, j + 1 );
}

// The named functions of an app file, run together; `vars` are their globals.
// A name ending in "?" may be missing (an older build of the app): a case
// then fails on what it checks, not on loading.
export function appFns( rel, names, vars = {} )
{
    const src  = read( rel );
    const have = names.filter( n => ! n.endsWith( "?" ) || new RegExp( "function\\s+" + n.slice( 0, -1 ) + "\\s*\\(" ).test( src ) )
                      .map( n => n.replace( /\?$/, "" ) );
    const ctx  = { console, JSON, Math, Object, Array, String, Number, Map, Set, Date, ...vars };
    vm.createContext( ctx );
    vm.runInContext( have.map( n => extract( src, n ) ).join( "\n" ) +
                     "\n;this.__fns = { " + have.join( ", " ) + " };", ctx );
    return ctx.__fns;
}
