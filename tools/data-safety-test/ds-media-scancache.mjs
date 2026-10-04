// ds-media-scancache.mjs - a scan cache that could not be read is never
// written (A1-04, Phase 6b).
//
// Photos, Music and Movies each guarded by hand "never set, prune or save a
// cache whose load failed" - its empty map would be merged over the real
// file. The guard now lives in shared/media.js scanCache itself, so a new
// caller cannot forget it. Here the read fails on purpose, then every write
// path is tried: the file on disk must stay byte for byte as it was.
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";

const s = await server();
const SCAN = "data/music/scan-cache.json";
const before = JSON.stringify( { "files/Music/a.mp3": { size: 1, mtime: 1, title: "A" },
                                 "files/Music/b.mp3": { size: 2, mtime: 2, title: "B" } } );
const f = path.join( s.home(), SCAN );
fs.mkdirSync( path.dirname( f ), { recursive: true } );
fs.writeFileSync( f, before );
fs.mkdirSync( path.join( s.home(), "files/G" ), { recursive: true } );

const c = await browser( s );
ok( await c.open( "/nayive/photos/index.html?dir=files/G" ), "a media page opens (Photos)" );
ok( await c.until( "typeof NayiveMedia === 'object' && typeof GumApi === 'object'" ), "media.js is loaded" );

//------------------------------------------------------------------------//
section( "THE READ FAILS: SET, PRUNE, SAVE, SAVENOW, FLUSH WRITE NOTHING" );
{
    const r = await c.evaluate( `( async () => {
        const read = GumApi.readJson;
        GumApi.readJson = p => p === ${JSON.stringify( SCAN )} ? Promise.reject( Object.assign( new Error( "offline" ), { status: 0 } ) ) : read( p );
        window.__sc = NayiveMedia.scanCache( ${JSON.stringify( SCAN )} );
        await __sc.load();
        GumApi.readJson = read;
        const loaded = __sc.loaded;
        __sc.set( { path: "files/Music/new.mp3", size: 3, mtime: 3 }, { title: "New" } );
        const pruned = __sc.prune( new Set(), null );
        __sc.save();
        await __sc.saveNow();
        await __sc.flush();
        return { loaded, pruned, keys: Object.keys( __sc.map ).length };
    } )()` );
    ok( r.loaded === false, "(the cache could not be read)", r );
    ok( r.pruned === false && r.keys === 0, "set and prune leave the empty map alone", r );
    await sleep( 3000 );                                  // past set()'s 2.5 s save timer
    ok( onDisk( s, SCAN ) === before, "the file on disk is untouched", onDisk( s, SCAN ) );
}

//------------------------------------------------------------------------//
section( "THE READ WORKS: SET + FLUSH WRITE, A SECOND FLUSH DOES NOT" );
{
    const r = await c.evaluate( `( async () => {
        await __sc.load();
        __sc.set( { path: "files/Music/new.mp3", size: 3, mtime: 3 }, { title: "New" } );
        await __sc.flush();
        let puts = 0; const f = window.fetch;
        window.fetch = function ( u, o ) { if( o && o.method === "PUT" ) puts++; return f.apply( this, arguments ); };
        await __sc.flush();
        window.fetch = f;
        return { loaded: __sc.loaded, puts };
    } )()` );
    ok( r.loaded === true, "(the cache is read)" );
    const after = JSON.parse( onDisk( s, SCAN ) );
    ok( after[ "files/Music/new.mp3" ] && after[ "files/Music/a.mp3" ] && after[ "files/Music/b.mp3" ], "the new entry is saved, the old ones kept", after );
    ok( r.puts === 0, "a flush with nothing set since writes nothing", r );
}

await done( c, s );
