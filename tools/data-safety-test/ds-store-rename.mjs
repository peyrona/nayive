// ds-store-rename.mjs - accounts on the client (batch C4c). The real
// store.js on a bare page (store-lib.mjs), the real launcher, a real admin
// rename.
//
// L3 (server-writes #4, store-core #8): saves waiting in a browser when the
//     admin renamed ana to ana2 kept "user:ana": ana2's pages never sent nor
//     showed them, and the sign-out deleted them. Now ana2's page re-tags
//     them (outbox, cached copies, device drafts) ONCE - only when the
//     server's "nayive_was" cookie starts with the page's own owner; never
//     for another account.
// L6 (store-core #10): signing out with a list save only its app can merge
//     (412, no merge on the launcher) said "go online first" - it IS online.
//     Now it names the app to open.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { stPage, seed, untilNode } from "./store-lib.mjs";

const s = await server( { ana: "aaa", beto: "bbb" } );
stPage( s );
const A = await browser( s, { user: "ana" } );
const login = ( c, user, password ) => c.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify( { user: ${JSON.stringify( user )}, password: ${JSON.stringify( password )} } ) } ).then( r => r.status )` );
// A device draft of an office editor (shared/office.js "nayive-drafts").
const DRAFT = ( app, who ) => `new Promise( function ( res ) { var q = indexedDB.open( 'nayive-drafts', 1 );
    q.onupgradeneeded = function () { q.result.createObjectStore( 'drafts', { keyPath: 'app' } ); };
    q.onsuccess = function () { var tx = q.result.transaction( 'drafts', 'readwrite' );
        tx.objectStore( 'drafts' ).put( { app: ${JSON.stringify( app )}, name: 'nota.txt', body: 'typed before the rename', at: Date.now(), who: ${JSON.stringify( who )} } );
        tx.oncomplete = function () { q.result.close(); res( true ); }; }; } )`;
const DRAFTS = `new Promise( function ( res ) { var q = indexedDB.open( 'nayive-drafts', 1 );
    q.onupgradeneeded = function () { q.result.createObjectStore( 'drafts', { keyPath: 'app' } ); };
    q.onsuccess = function () { var g = q.result.transaction( 'drafts' ).objectStore( 'drafts' ).getAll();
        g.onsuccess = function () { q.result.close(); res( g.result.map( function ( r ) { return { app: r.app, who: r.who }; } ) ); }; }; } )`;

//----------------------------------------------------------------------------//
section( "L3 · AN ADMIN RENAME: THE SAVES WAITING HERE BECOME THE NEW NAME'S" );
{
    const F = "data/t/l3.json";
    await A.open( "/nayive/st.html" );
    ok( await A.evaluate( "NayiveStore.me" ) === "user:ana", "the page is ana's" );
    const q = JSON.parse( await A.evaluate( `( offline( true ), J( SM.write( '${F}', JSON.stringify( [ { id: 'queued-as-ana' } ] ) ) ) )` ) );
    ok( q.offline, "ana's save waits here (offline)", q );
    await A.evaluate( DRAFT( "text:old-tab", "user:ana" ) );
    ok( ( await A.evaluate( `idb( 'outbox', '${F}' )` ) ).who === "user:ana", "it is tagged user:ana" );

    // The admin renames ana to ana2 (her sessions end); she signs in again here.
    const admin = await s.client( "jefe", "secreto" );
    const r = await admin.post( "/api/admin", JSON.stringify( { action: "rename-user", name: "ana", new_name: "ana2" } ), { "Content-Type": "application/json" } );
    ok( r.status === 200, "the admin renames ana to ana2", r.text );
    ok( await login( A, "ana2", "aaa" ) === 200, "ana2 signs in on this browser" );
    ok( /nayive_was=/.test( await A.evaluate( "document.cookie" ) ), "(the server says which names were hers: nayive_was)", await A.evaluate( "document.cookie" ) );

    const B = await A.tab();
    await B.open( "/nayive/st.html" );
    ok( await B.evaluate( "NayiveStore.me" ) === "user:ana2", "a new page is ana2's" );
    ok( await untilNode( async () => ( ( await B.evaluate( `idb( 'outbox', '${F}' )` ) ) || {} ).who === "user:ana2" ), "her waiting save is re-tagged to ana2",
        await B.evaluate( `idb( 'outbox', '${F}' )` ) );
    ok( ( await B.evaluate( DRAFTS ) ).some( d => d.app === "text:old-tab" && d.who === "user:ana2" ), "...and so is her device draft", await B.evaluate( DRAFTS ) );
    await B.evaluate( "SM.flush().then( () => true )" );
    ok( await untilNode( () => onDisk( s, F, "ana2" ) === JSON.stringify( [ { id: "queued-as-ana" } ] ) ), "it goes up - into ana2's home",
        onDisk( s, F, "ana2" ) );
    ok( ( await B.evaluate( "idb( 'outbox' )" ) ).length === 0, "nothing is left waiting" );
    await B.evaluate( `new Promise( function ( res ) { var q = indexedDB.open( 'nayive-drafts', 1 ); q.onsuccess = function () {
        var tx = q.result.transaction( 'drafts', 'readwrite' ); tx.objectStore( 'drafts' ).delete( 'text:old-tab' );
        tx.oncomplete = function () { q.result.close(); res( true ); }; }; } )` );    // (the draft's part is done)
    await fetch( `http://127.0.0.1:${A.port}/json/close/${B.id}` ).catch( () => {} );
}

//----------------------------------------------------------------------------//
section( "L3 · NEVER FOR ANOTHER ACCOUNT" );
{
    const F = "data/t/l3b.json";
    // A save of a name nobody has any more waits here (an older rename).
    await A.evaluate( `idbPut( 'outbox', { path: '${F}', body: '[{"id":"old"}]', queuedAt: Date.now(), conflict: false, bin: false, ius: false,
                                         who: 'user:zoe', ver: 1, id: 'z1', inc: [], anc: [] } )` );
    ok( await login( A, "beto", "bbb" ) === 200, "beto signs in on this browser" );
    // A cookie that names zoe as an old name - but of ana2, not of beto.
    await A.evaluate( "document.cookie = 'nayive_was=user:ana2/user:zoe; path=/'; true" );
    const C = await A.tab();
    await C.open( "/nayive/st.html" );
    ok( await C.evaluate( "NayiveStore.me" ) === "user:beto", "the page is beto's" );
    await C.evaluate( "SM.flush().then( () => true )" );
    const e = await C.evaluate( `idb( 'outbox', '${F}' )` );
    ok( e && e.who === "user:zoe", "a cookie that does not start with this page's owner re-tags nothing", e );
    ok( onDisk( s, F, "beto" ) === null, "and nothing of it reaches beto's home" );
    await C.evaluate( `new Promise( function ( res ) { var q = indexedDB.open( 'nube-store' ); q.onsuccess = function () {
        var tx = q.result.transaction( 'outbox', 'readwrite' ); tx.objectStore( 'outbox' ).delete( '${F}' );
        tx.oncomplete = function () { q.result.close(); res( true ); }; }; } )` );
    await fetch( `http://127.0.0.1:${A.port}/json/close/${C.id}` ).catch( () => {} );
}

//----------------------------------------------------------------------------//
section( "L6 · SIGN-OUT WITH A LIST SAVE ONLY ITS APP CAN MERGE" );
{
    const F = "data/tasks.json";
    const phone = await s.client( "beto" );
    await seed( phone, F, '[{"id":"t1"}]' );
    const P = await A.tab();
    await P.open( "/nayive/st.html" );
    await P.evaluate( `SM.read( '${F}' ).then( () => true )` );
    const q = JSON.parse( await P.evaluate( `( offline( true ), J( SM.write( '${F}', JSON.stringify( [ { id: 't1' }, { id: 'typed-here' } ] ) ) ) )` ) );
    ok( q.offline, "a Tasks save waits here", q );
    await fetch( `http://127.0.0.1:${A.port}/json/close/${P.id}` ).catch( () => {} );   // Tasks closed
    await seed( phone, F, '[{"id":"t1"},{"id":"from-the-phone"}]' );                  // the phone saved since

    const L = await A.tab();
    await L.open( "/nayive/" );
    ok( await L.until( "window.NayiveStore && window.NayiveUI && document.getElementById( 'logoutBtn' )" ), "the launcher is up (online)" );
    await L.evaluate( "window.asks = []; NayiveUI.confirm = o => new Promise( r => asks.push( { body: o.body, r } ) ); true" );
    await L.evaluate( "document.getElementById( 'logoutBtn' ).click(), true" );
    ok( await L.until( "asks.length === 1", 20000 ), "Sign out asks about the save still here" );
    const want = await L.evaluate( "NayiveUI.tf( 'launcher.unsavedBodyApps', { n: 1, apps: 'Planner \u203a Tasks' } )" );
    const body = await L.evaluate( "asks[ 0 ].body" );
    ok( body === want, "it says to open Tasks to finish saving it (not \"go online\")", body );
    await L.evaluate( "asks[ 0 ].r( false ), true" );                       // "Stay"
    ok( await untilNode( () => L.evaluate( "fetch( '/api/whoami' ).then( r => r.status === 200 )" ) ), "\"Stay\": still signed in" );
    const kept = await L.evaluate( `new Promise( function ( res ) { var q = indexedDB.open( 'nube-store' ); q.onsuccess = function () {
        var g = q.result.transaction( 'outbox' ).objectStore( 'outbox' ).get( '${F}' );
        g.onsuccess = function () { q.result.close(); res( g.result ? g.result.body : null ); }; }; } )` );
    ok( String( kept ).indexOf( "typed-here" ) !== -1, "...and the save is still here, for Tasks to merge", kept );
}

await done( A, s );
