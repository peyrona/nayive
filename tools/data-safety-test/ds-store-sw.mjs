// ds-store-sw.mjs - the service worker never hands an app an old copy as the
// server's (B6, store-core #6, list-apps #9). The service worker is ON here
// (every other test bypasses it).
//
// The trips page keeps the active trip's documents in "nayive-trips-docs",
// and sw.js answered EVERY GET of such a document from there, never
// refreshed: an editor showed an old copy with its old version, and the Image
// editor saved over the newer file. Now: the network first, the request and
// the answer untouched (If-None-Match, ETag); the trip's copy only when the
// network fails, marked, and shared/store.js reads it as "offline".
import { server, browser, ok, section, done } from "./lib.mjs";
import { stPage, seed } from "./store-lib.mjs";

const s = await server();
stPage( s );
const phone = await s.client();
const c = await browser( s );
const F = "files/pass.txt";
const URL = "/api/files?file=" + encodeURIComponent( F );

section( "B6 · A TRIP DOCUMENT CACHED FOR OFFLINE, CHANGED SINCE" );

await seed( phone, F, "VERSION-2 (the server's)" );
await c.send( "Network.setBypassServiceWorker", { bypass: false } );
await c.open( "/nayive/st.html" );
await c.evaluate( "navigator.serviceWorker.register( 'sw.js' ).then( () => navigator.serviceWorker.ready ).then( () => true )" );
await c.open( "/nayive/st.html" );
ok( await c.until( "!! navigator.serviceWorker.controller", 30000 ), "the page is controlled by the service worker" );

// What the trips page does (trips/persistence.js): the document, by its exact
// URL, into the trips cache - an older copy than the server's now.
await c.evaluate( `caches.open( 'nayive-trips-docs' ).then( k => k.put( location.origin + ${JSON.stringify( URL )},
    new Response( 'VERSION-1 (cached by Trips)', { headers: { 'Content-Type': 'text/plain', 'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT' } } ) ) ).then( () => true )` );

const got = await c.evaluate( `fetch( ${JSON.stringify( URL )} ).then( async r => ( { body: await r.text(), tag: r.headers.get( 'ETag' ), copy: r.headers.get( 'X-Nayive-Copy' ) } ) )` );
ok( got.body === "VERSION-2 (the server's)" && /^"/.test( got.tag ) && ! got.copy, "a GET gets the server's file, with its version tag", got );
const read = await c.evaluate( `SC.read( '${F}' ).then( r => ( { body: r.body, source: r.source } ) )` );
ok( read.body === "VERSION-2 (the server's)" && read.source === "network", "...and so does an editor's read", read );
const st304 = await c.evaluate( `fetch( ${JSON.stringify( URL )}, { headers: { 'If-None-Match': ${JSON.stringify( got.tag )} } } ).then( r => r.status )` );
ok( st304 === 304, "If-None-Match goes through untouched (304 for the same version)", st304 );

// A weak network (an airport's Wi-Fi): the service worker's own request is
// held on its own DevTools target - it never answers, then a gateway's 502.
const sw = ( await ( await fetch( `http://127.0.0.1:${c.port}/json` ) ).json() ).find( t => t.type === "service_worker" );
const ws = new WebSocket( sw.webSocketDebuggerUrl );
await new Promise( ( r, j ) => { ws.onopen = r; ws.onerror = j; } );
let mode = "hang", n = 0, enabled = null;
const ready = new Promise( r => { enabled = r; } );
ws.onmessage = e =>
{
    const m = JSON.parse( e.data );
    if( m.id === 1 ) enabled();
    if( m.method !== "Fetch.requestPaused" ) return;
    if( mode === "502" ) ws.send( JSON.stringify( { id: ++n + 1000, method: "Fetch.fulfillRequest",
        params: { requestId: m.params.requestId, responseCode: 502, body: Buffer.from( "Bad Gateway" ).toString( "base64" ) } } ) );
};
ws.send( JSON.stringify( { id: 1, method: "Fetch.enable", params: { patterns: [ { urlPattern: "*pass.txt*" } ] } } ) );
await ready;   // Fetch.enable answered
const t0 = Date.now();
const slow = await c.evaluate( `Promise.race( [ fetch( ${JSON.stringify( URL )} ).then( async r => ( { body: await r.text(), copy: r.headers.get( 'X-Nayive-Copy' ) } ) ),
                                         new Promise( r => setTimeout( () => r( { stillWaiting: true } ), 12000 ) ) ] )` );
const waited = Date.now() - t0;
ok( slow.body === "VERSION-1 (cached by Trips)" && slow.copy === "offline" && waited < 9000,
    "no answer from the network: the trip's copy comes after a few seconds, marked offline", { slow, waited } );
mode = "502";
const bad = await c.evaluate( `fetch( ${JSON.stringify( URL )} ).then( async r => ( { status: r.status, body: await r.text(), copy: r.headers.get( 'X-Nayive-Copy' ) } ) )` );
ok( bad.body === "VERSION-1 (cached by Trips)" && bad.copy === "offline", "a gateway's 502: the trip's copy, marked offline", bad );
ws.send( JSON.stringify( { id: 2, method: "Fetch.disable" } ) );
ws.close();

// The network fails (the server is gone): the trip's copy, marked.
await s.stop();
const off = await c.evaluate( `fetch( ${JSON.stringify( URL )} ).then( async r => ( { body: await r.text(), copy: r.headers.get( 'X-Nayive-Copy' ) } ), e => ( { error: String( e ) } ) )` );
ok( off.body === "VERSION-1 (cached by Trips)" && off.copy === "offline", "offline, the trip's copy is there - and says it is an offline copy", off );
const offRead = await c.evaluate( `SC.read( '${F}' ).then( r => ( { body: r.body, source: r.source } ) )` );
ok( offRead.source === "cache" && offRead.body === "VERSION-2 (the server's)", "an editor's read takes it as \"offline\" (its own last copy), not as the server's", offRead );

await done( c, s );
