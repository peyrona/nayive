// ds-text-offline.mjs - Text never opens an OLD offline copy as the file it
// is editing (batch C4b, item 5).
//
// A file that is not UTF-8 arrives from the store with U+FFFD in it, and Text
// reads its bytes again to decode them for what they are. When that second
// read is the service worker's offline copy (X-Nayive-Copy: offline - a trip
// document with no network) it is an older version: if it read as good UTF-8
// it opened EDITABLE, showing the old text, and the next save (carrying the
// store's newer version) would write it over the newer file. Now such a copy
// counts as "no bytes": the file opens read-only, as Text does offline.
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done } from "./lib.mjs";

const s = await server();
const phone = await s.client();
const NEW = Buffer.concat( [ Buffer.from( "caf" ), Buffer.from( [ 0xe9 ] ), Buffer.from( " nuevo\n" ) ] );   // Windows-1252
const r = await phone.put( "files/viejo.txt", NEW );
if( r.status !== 200 ) throw new Error( "seed: " + r.status );
const c = await browser( s );

// The offline copy, stood in for (the tests bypass the worker): the store's
// own read (it says method GET) gets the file; Text's second read of its
// bytes gets an older version, valid UTF-8, marked as the worker marks it.
await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: `( () => { const f = window.fetch;
    window.fetch = function ( u, o ) {
        if( String( u ).indexOf( 'file=' + encodeURIComponent( 'files/viejo.txt' ) ) !== -1 && ! ( o && o.method ) )
            return Promise.resolve( new Response( 'café viejo\\n', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'ETag': '"old"', 'X-Nayive-Copy': 'offline' } } ) );
        return f.apply( this, arguments ); }; } )()` } );

section( "A NOT-UTF-8 FILE WHOSE BYTES COME BACK FROM THE OFFLINE COPY" );
await c.open( "/nayive/text/?file=files/viejo.txt", "/nayive/text/" );
const CM = "document.querySelector('.CodeMirror') && document.querySelector('.CodeMirror').CodeMirror";
ok( await c.until( CM + " && " + CM + ".getValue().indexOf( 'caf' ) === 0" ), "Text shows the file" );
ok( await c.until( "( window.__toasts || [] ).length || document.getElementById('toast').classList.contains('show')", 10000 ), "it says something about it" );
const value = await c.evaluate( CM + ".getValue()" );
ok( value.indexOf( "viejo" ) === -1, "the old copy's text is not what it shows", value );
ok( await c.evaluate( CM + ".getOption( 'readOnly' )" ) === true, "it opens read-only (no way to tell what the bytes are)" );
ok( fs.readFileSync( path.join( s.home(), "files/viejo.txt" ) ).equals( NEW ), "the file is untouched" );

await done( c, s );
