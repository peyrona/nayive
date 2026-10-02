// store-lib.mjs - what the ds-store-*.mjs tests share (not a test itself:
// run.mjs only runs ds-*.mjs): a bare page with the REAL shared/store.js and
// three stores on it, a network the test can hold or cut, and a look into the
// browser's own storage.
//
//   stPage( s )        writes /nayive/st.html into the scratch server's apps
//   await c.open( "/nayive/st.html" )
//   in the page:  SM (merging, list of {id}), SC (conflicts), SP (plain);
//                 M = the "app model"; LOG = every PUT with its checks;
//                 EV = merged / conflict / saved events; offline( true|false );
//                 hold( "PUT", "a.txt" ) ... release(); netDown = true;
//                 idb( store[, key] ), idbPut( store, record )
import fs from "node:fs";

const PAGE = `<!doctype html><meta charset=utf-8><title>st</title>
<script>
window.LOG = [];
window.EV  = [];
window.M   = {};
( function () {
    var f0 = window.fetch, waiting = [];
    window.holds = {};
    window.held = 0;
    window.netDown = false;
    window.hold = function ( method, part ) { window.holds[ method ] = part; };
    window.release = function () { var w = waiting; waiting = []; window.holds = {}; w.forEach( function ( f ) { f(); } ); };
    window.fetch = async function ( u, o ) {
        var m = ( o && o.method ) || "GET", url = String( u && u.url || u );
        if( window.netDown && url.indexOf( "/api/files" ) !== -1 ) throw new TypeError( "Failed to fetch" );
        var h = window.holds[ m ];
        if( h && url.indexOf( h ) !== -1 ) { window.held++; await new Promise( function ( r ) { waiting.push( r ); } ); }
        var r = await f0.apply( this, arguments );
        if( m === "PUT" ) {
            var hd = ( o && o.headers ) || {};
            LOG.push( { put: decodeURIComponent( url.replace( /^.*file=/, "" ) ), im: hd[ "If-Match" ] || null,
                        ius: hd[ "If-Unmodified-Since" ] || null, inm: hd[ "If-None-Match" ] || null, st: r.status } );
        }
        return r;
    };
} )();
window.offline = function ( on ) {
    if( on ) Object.defineProperty( navigator, "onLine", { get: function () { return false; }, configurable: true } );
    else delete navigator.onLine;
    return true;
};
window.idb = function ( store, key ) {
    return new Promise( function ( res ) {
        var q = indexedDB.open( "nube-store" );
        q.onsuccess = function () {
            var db = q.result, os = db.transaction( store ).objectStore( store );
            var g = key === undefined ? os.getAll() : os.get( key );
            g.onsuccess = function () { db.close(); res( g.result === undefined ? null : g.result ); };
        };
    } );
};
window.idbPut = function ( store, rec ) {
    return new Promise( function ( res ) {
        var q = indexedDB.open( "nube-store" );
        q.onsuccess = function () {
            var db = q.result, tx = db.transaction( store, "readwrite" );
            tx.objectStore( store ).put( rec );
            tx.oncomplete = function () { db.close(); res( true ); };
        };
    } );
};
</script>
<script src="shared/store.js"></script>
<script>
window.mergeList = function ( p, base, mine, theirs ) {
    return JSON.stringify( NayiveStore.mergeLists( base ? JSON.parse( base ) : null, JSON.parse( mine ), JSON.parse( theirs ),
                                                   { id: function ( x ) { return x.id; } } ) );
};
var API = location.origin + "/api/files";
window.SM = NayiveStore.createStore( { apiBase: API, conflicts: true, merge: mergeList } );
window.SC = NayiveStore.createStore( { apiBase: API, conflicts: true } );
window.SP = NayiveStore.createStore( { apiBase: API } );
SM.onMerged( function ( p, b ) { EV.push( { merged: p, body: b } ); } );
SC.onConflict( function ( p ) { EV.push( { conflict: p } ); } );
if( SM.onSaved ) SM.onSaved( function ( p, b, t, mine ) { EV.push( { saved: p, body: b, tag: t, mine: mine } ); } );
window.ids = function ( body ) { return JSON.parse( body ).map( function ( x ) { return x.id; } ).join( "," ); };
window.J = function ( p ) { return p.then( function ( r ) { return JSON.stringify( r ); } ); };
</script>`;

export function stPage( s )
{
    fs.writeFileSync( `${s.run}/apps/st.html`, PAGE );
}

// A file put by "the phone" (a second session), its answer checked.
export async function seed( phone, rel, body )
{
    const r = await phone.put( rel, body );
    if( r.status !== 200 && r.status !== 201 ) throw new Error( "seed " + rel + ": " + r.status + " " + r.text );
    return r;
}

// Waits until fn() is true (node side), up to ms.
export async function untilNode( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end )
    {
        try { if( await fn() ) return true; } catch {}
        await new Promise( r => setTimeout( r, 100 ) );
    }
    return false;
}
