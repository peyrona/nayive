// ds-store-accounts.mjs - signing out, and two accounts on one browser
// (batch C4a). The real store.js on a bare page (store-lib.mjs) and the real
// launcher.
//
// K5 (office #17, list-apps #29): the launcher's sign-out counted the saves
//     still here, asked, then cleared EVERYTHING - a save another tab made
//     while the question was up was deleted unseen. Now only what was counted
//     goes; what came in meanwhile is counted and asked about again.
// L4 (store-core #7): ana's save waits on this browser (her session ended);
//     beto signs in here and opens the same app. His read stripped her save
//     of its version (the cached copy became his), his edit replaced her save
//     outright (one record per path). Now both stay, and each goes up to its
//     own home with its own version.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { stPage, seed, untilNode } from "./store-lib.mjs";

const s = await server( { ana: "aaa", beto: "bbb" } );
stPage( s );
const anaPhone  = await s.client( "ana" );
const betoPhone = await s.client( "beto" );
const A = await browser( s, { user: "ana" } );

//----------------------------------------------------------------------------//
section( "K5 · A SAVE MADE WHILE THE SIGN-OUT QUESTION IS UP" );
{
    await A.open( "/nayive/st.html" );
    ok( await A.evaluate( "offline( true ), SC.write( 'files/before.txt', 'counted\\n' ).then( r => r.offline )" ), "a save waits here (offline)" );

    const L = await A.tab();
    await L.open( "/nayive/" );
    ok( await L.until( "window.NayiveStore && window.NayiveUI && document.getElementById( 'logoutBtn' )" ), "the launcher is up" );
    // The question, answered by the test; the launcher offline too, so
    // nothing goes up before the count.
    await L.evaluate( `Object.defineProperty( navigator, 'onLine', { get: () => false, configurable: true } );
        window.asks = []; NayiveUI.confirm = o => new Promise( r => asks.push( { body: o.body, r } ) ); true` );
    await L.evaluate( "document.getElementById( 'logoutBtn' ).click(), true" );
    ok( await L.until( "asks.length === 1" ), "Sign out asks about the save still here" );

    ok( await A.evaluate( "SC.write( 'files/while-asked.txt', 'typed while the question was up\\n' ).then( r => r.offline )" ),
        "another tab saves while the question is up (offline: it waits here)" );
    await L.evaluate( "asks[ 0 ].r( true ), true" );
    ok( await L.until( "asks.length === 2", 8000 ), "after \"Sign out\", the new save is counted and asked about again",
        await L.evaluate( "( window.asks || [] ).map( a => a.body )" ) );
    const box = await A.evaluate( "idb( 'outbox' ).then( l => l.map( e => e.path ) )" );
    ok( box.includes( "files/while-asked.txt" ) && ! box.includes( "files/before.txt" ),
        "only the save that was counted is gone; the new one is still here", box );
    await L.evaluate( "window.asks && asks[ 1 ] && asks[ 1 ].r( false ), true" );
    ok( await untilNode( () => L.evaluate( "fetch( '/api/whoami' ).then( r => r.status === 200 )" ) ), "\"Stay\": still signed in" );
    await A.evaluate( "offline( false ), SC.flush().then( () => true )" );
    ok( await untilNode( () => onDisk( s, "files/while-asked.txt", "ana" ) === "typed while the question was up\n" ), "and that save goes up" );
}

//----------------------------------------------------------------------------//
section( "L4 · TWO ACCOUNTS ON ONE BROWSER" );
{
    const F = "data/t/l4.json";
    await seed( anaPhone, F, '[{"id":"a"}]' );
    await seed( betoPhone, F, '[{"id":"b"}]' );

    // ana: her save waits here. (Signed in again first: with the old
    // sign-out the section above signed her out.)
    await A.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { user: 'ana', password: 'aaa' } ) } ).then( r => r.status )` );
    await A.open( "/nayive/st.html" );
    ok( await A.evaluate( "NayiveStore.me" ) === "user:ana", "the page is ana's", await A.evaluate( "NayiveStore.me" ) );
    await A.evaluate( `SM.read( '${F}' ).then( r => { M.l4 = JSON.parse( r.body ); return true; } )` );
    const qa = JSON.parse( await A.evaluate( `( offline( true ), M.l4.push( { id: 'ana-unsent' } ), J( SM.write( '${F}', JSON.stringify( M.l4 ) ) ) )` ) );
    ok( qa.offline, "ana's save waits here", qa );
    const anaEntry = await A.evaluate( `idb( 'outbox', '${F}' )` );
    const anaDoc   = await A.evaluate( `idb( 'docs', '${F}' )` );
    ok( anaEntry && anaEntry.who === "user:ana" && ( anaEntry.tag || anaEntry.srv ), "it knows the version it was made from", anaEntry );

    // beto signs in on the same browser and opens the same app.
    ok( await A.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { user: 'beto', password: 'bbb' } ) } ).then( r => r.status === 200 )` ), "beto signs in here" );
    const B = await A.tab();
    await B.open( "/nayive/st.html" );
    ok( await B.evaluate( "NayiveStore.me" ) === "user:beto", "the new page is beto's" );
    const rb = await B.evaluate( `SM.read( '${F}' ).then( r => r.body )` );
    ok( rb === '[{"id":"b"}]', "beto reads HIS file", rb );
    const doc1 = await B.evaluate( `idb( 'docs', '${F}' )` );
    ok( doc1 && doc1.who === "user:ana" && doc1.body === anaDoc.body && doc1.srv === anaDoc.srv,
        "his read leaves ana's cached copy (her save's version and base) as it was", doc1 );

    const wb = JSON.parse( await B.evaluate( `( offline( true ), J( SM.write( '${F}', JSON.stringify( [ { id: 'b' }, { id: 'beto-new' } ] ) ) ) )` ) );
    ok( wb.offline, "beto's edit waits here too (offline)", wb );
    const anaAfter = await B.evaluate( `idb( 'outbox', '${F}' )` );
    ok( anaAfter && anaAfter.who === "user:ana" && anaAfter.body === anaEntry.body, "his edit did not replace ana's waiting save", anaAfter );
    const all = await B.evaluate( "idb( 'outbox' )" );
    ok( all.filter( e => ( e.file || e.path ) === F ).length === 2, "both wait, side by side", all.map( e => e.path ) );

    await B.evaluate( "offline( false ), SM.flush().then( () => true )" );
    ok( await untilNode( () => onDisk( s, F, "beto" ) === JSON.stringify( [ { id: "b" }, { id: "beto-new" } ] ) ), "beto's goes up to HIS home",
        onDisk( s, F, "beto" ) );
    ok( JSON.parse( onDisk( s, F, "ana" ) ).map( x => x.id ).join() === "a", "ana's file is untouched so far", onDisk( s, F, "ana" ) );

    // ana's phone saves meanwhile; then ana signs in here again.
    await seed( anaPhone, F, '[{"id":"a"},{"id":"ana-phone"}]' );
    ok( await B.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { user: 'ana', password: 'aaa' } ) } ).then( r => r.status === 200 )` ), "ana signs in here again" );
    const C = await A.tab();
    await C.open( "/nayive/st.html" );
    const rc = await C.evaluate( `SM.read( '${F}' ).then( r => r.body )` );
    ok( String( rc ).indexOf( "ana-unsent" ) !== -1, "her app shows her waiting save", rc );
    await C.evaluate( "SM.flush().then( () => true )" );
    ok( await untilNode( () => { const l = JSON.parse( onDisk( s, F, "ana" ) ).map( x => x.id ); return l.includes( "ana-unsent" ) && l.includes( "ana-phone" ); } ),
        "her save goes up to HER home, merged with her phone's (it kept its version check)", onDisk( s, F, "ana" ) );
    ok( await C.evaluate( `LOG.some( l => l.put === '${F}' && l.st === 412 )` ), "(its first PUT was refused: checked, not blind)", await C.evaluate( "LOG" ) );
    ok( onDisk( s, F, "beto" ) === JSON.stringify( [ { id: "b" }, { id: "beto-new" } ] ), "beto's file is untouched" );
    const left = await C.evaluate( "idb( 'outbox' )" );
    ok( left.length === 0, "nothing is left waiting", left.map( e => e.path ) );
}

await done( A, s );
