// ds-store-oldtab.mjs - a tab still running the store.js from before batch
// C4a (fixtures/store-before-c4a.js), open across the deploy, beside new
// tabs: one browser, one IndexedDB. The old code sends any page's queued
// save, keeps no `sent` record and knows no version tags.
//
// L4 guard: another account's save kept beside the path ("\1who\1path") is
//     never sent by an old tab as a file name, nor dropped.
// Deploy transition (review of C4a): an old tab that sent a new tab's save
//     made the new tab's next save - or that very save's own answer - a
//     false "changed on another device".
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { stPage, seed, untilNode } from "./store-lib.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const s = await server( { ana: "aaa", beto: "bbb" } );
stPage( s );
fs.copyFileSync( path.join( HERE, "fixtures/store-before-c4a.js" ), `${s.run}/apps/shared/store-old.js` );
fs.writeFileSync( `${s.run}/apps/old.html`, fs.readFileSync( `${s.run}/apps/st.html`, "utf8" )
    .replace( "shared/store.js", "shared/store-old.js" ).replace( "<title>st</title>", "<title>old</title>" ) );
const ana  = await s.client( "ana" );
const beto = await s.client( "beto" );
const A = await browser( s, { user: "ana" } );
const login = ( c, u, p ) => c.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify( { user: '${u}', password: '${p}' } ) } ).then( r => r.status )` );

//----------------------------------------------------------------------------//
section( "L4 · ANOTHER ACCOUNT'S SAVE KEPT BESIDE, AND AN OLD TAB" );
{
    const F = "data/t/e1.json";
    await seed( ana, F, '[{"id":"a"}]' );
    await seed( beto, F, '[{"id":"b"}]' );
    await A.open( "/nayive/st.html" );
    await A.evaluate( `SM.read( '${F}' ).then( r => { M.l = JSON.parse( r.body ); return true; } )` );
    await A.evaluate( `( offline( true ), M.l.push( { id: 'ana-unsent' } ), SM.write( '${F}', JSON.stringify( M.l ) ).then( () => true ) )` );
    await login( A, "beto", "bbb" );
    const B = await A.tab();
    await B.open( "/nayive/st.html" );
    await B.evaluate( `SM.read( '${F}' ).then( () => true )` );
    await B.evaluate( `( offline( true ), SM.write( '${F}', JSON.stringify( [ { id: 'b' }, { id: 'beto-unsent' } ] ) ).then( () => true ) )` );
    ok( ( await B.evaluate( "idb( 'outbox' )" ) ).length === 2, "ana's and beto's saves wait side by side" );

    const O = await A.tab();
    await O.open( "/nayive/old.html" );
    await O.evaluate( "Promise.all( [ SC.flush(), SM.flush(), SP.flush() ] ).then( () => true )" );
    const log = await O.evaluate( "LOG" );
    ok( ! log.some( l => l.put.indexOf( "\u0001" ) !== -1 ), "the old tab never sends the key beside as a file name", log );
    ok( ( await O.evaluate( "idb( 'outbox' )" ) ).length === 2, "and both are still there after its flush" );
    await B.evaluate( "offline( false ), SM.flush().then( () => true )" );
    ok( await untilNode( () => onDisk( s, F, "beto" ) === JSON.stringify( [ { id: "b" }, { id: "beto-unsent" } ] ) ), "beto's goes up from a new tab",
        onDisk( s, F, "beto" ) );
    for( const c of [ B, O ] ) await c.send( "Page.navigate", { url: "about:blank" } );
    await B.open( "/nayive/st.html" );
    await B.evaluate( "NayiveStore.localCount().then( () => NayiveStore.clearLocal() ).then( () => true )" );
    await login( A, "ana", "aaa" );
}

//----------------------------------------------------------------------------//
section( "AN OLD TAB SENDS A NEW TAB'S SAVE" );
{
    const F = "files/e2.txt";
    await seed( ana, F, "v0\n" );
    const N = await A.tab();
    await N.open( "/nayive/st.html" );
    await N.evaluate( `SC.read( '${F}' ).then( () => ( EV.length = 0, true ) )` );
    const w1 = JSON.parse( await N.evaluate( `( offline( true ), J( SC.write( '${F}', 'v0\\nN1\\n' ) ) )` ) );
    ok( w1.offline, "the new tab's save waits (offline)", w1 );
    const O = await A.tab();
    await O.open( "/nayive/old.html" );
    await O.evaluate( "SC.flush().then( () => true )" );
    ok( await untilNode( () => onDisk( s, F, "ana" ) === "v0\nN1\n" ), "an old tab sends it", onDisk( s, F, "ana" ) );
    await N.evaluate( "offline( false ), true" );
    const w2 = JSON.parse( await N.evaluate( `J( SC.write( '${F}', 'v0\\nN1\\nN2\\n' ) )` ) );
    ok( w2.ok && onDisk( s, F, "ana" ) === "v0\nN1\nN2\n", "the new tab's next save goes up (no false conflict)", { w2, disk: onDisk( s, F, "ana" ) } );
    ok( ! await N.evaluate( "EV.some( e => e.conflict )" ), "and it is asked nothing" );
    await O.send( "Page.navigate", { url: "about:blank" } );
}

//----------------------------------------------------------------------------//
section( "AN OLD TAB SENDS IT WHILE THE NEW TAB'S OWN PUT IS ON ITS WAY" );
{
    const F = "files/e3.txt";
    await seed( ana, F, "v0\n" );
    const N = await A.tab();
    await N.open( "/nayive/st.html" );
    await N.evaluate( `SC.read( '${F}' ).then( () => ( EV.length = 0, true ) )` );
    await N.evaluate( `held = 0, hold( 'PUT', 'e3.txt' ), window.w1 = J( SC.write( '${F}', 'v0\\nN1\\n' ) ), true` );
    ok( await N.until( "held === 1" ), "the new tab's PUT is on its way (held)" );
    const O = await A.tab();
    await O.open( "/nayive/old.html" );
    await O.evaluate( "SC.flush().then( () => true )" );
    ok( await untilNode( () => onDisk( s, F, "ana" ) === "v0\nN1\n" ), "an old tab sends the same save first" );
    await N.evaluate( "release(), true" );
    const r1 = JSON.parse( await N.evaluate( "w1" ) );
    ok( r1.ok && ! await N.evaluate( "EV.some( e => e.conflict )" ), "the new tab's save answers \"saved\" (it is), no conflict", r1 );
}

await done( A, s );
