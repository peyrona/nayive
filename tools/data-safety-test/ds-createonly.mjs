// ds-createonly.mjs - GumApi.createFileBytes never replaces a file (S2, G1):
// a name another device took answers 412 and the file stays; a free name saves.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";

const s = await server();
const c = await browser( s );
section( "CREATE-ONLY UPLOAD" );
const phone = await s.client();
await phone.put( "files/foto.jpg", "the phone's photo" );
await c.open( "/nayive/drive/", "/nayive/drive/" );
ok( await c.until( "window.GumApi && typeof GumApi.createFileBytes === 'function'" ), "GumApi.createFileBytes exists" );

// Inside a promise, so a missing function is a FAIL line, not a crash.
const create = ( p, text ) => c.evaluate( `Promise.resolve().then( () => GumApi.createFileBytes( ${JSON.stringify( p )}, new TextEncoder().encode( ${JSON.stringify( text )} ) ) )
    .then( () => 'saved', e => e && ( e.status || String( e ) ) )` );

const taken = await create( "files/foto.jpg", "the PC's photo" );
ok( taken === 412, "a taken name answers err.status 412", taken );
ok( onDisk( s, "files/foto.jpg" ) === "the phone's photo", "the phone's photo is untouched" );

const fresh = await create( "files/nueva.jpg", "new" );
ok( fresh === "saved", "a free name is saved", fresh );
ok( onDisk( s, "files/nueva.jpg" ) === "new", "the new file is on disk" );
await done( c, s );
