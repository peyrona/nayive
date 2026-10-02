// ds-store-merges.mjs - a save merged by ANOTHER tab, and what that tab and
// this one save next (batch C4a, review rounds 1-2; cases written by the
// reviewer). The real store.js on a bare page (store-lib.mjs); one page with
// no BroadcastChannel (an old Safari, or a page that missed every message).
//
// A2 (list-apps #1) and the review blocker: a save that took another page's
// save in must not let that page's next save pass over what was merged in;
// and that page's own deletes and undos made since must hold (its next merge
// starts from its own last body once that is known to be on the server).
import fs from "node:fs";
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { stPage, seed, untilNode } from "./store-lib.mjs";
const s = await server();
stPage( s );
// a page with no BroadcastChannel (old Safari, or a page that missed every message)
fs.writeFileSync( `${s.run}/apps/nb.html`, fs.readFileSync( `${s.run}/apps/st.html`, "utf8" )
    .replace( "<title>st</title>", "<title>nb</title><script>window.BroadcastChannel = undefined;</script>" ) );
const phone = await s.client();
const A = await browser( s );
await A.open( "/nayive/st.html" );
const B = await A.tab();
await B.open( "/nayive/st.html" );
const C = await A.tab();
await C.open( "/nayive/st.html" );
const N = await A.tab();
await N.open( "/nayive/nb.html" );
const items = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
const ids = rel => ( items( rel ) || [] ).map( x => x.id );
const disk = rel => onDisk( s, rel );
const W = ( c, F, list ) => c.evaluate( `J( SM.write( '${F}', JSON.stringify( ${JSON.stringify( list )} ) ) )` ).then( JSON.parse );
const R = ( c, F ) => c.evaluate( `SM.read( '${F}' ).then( r => r.body )` );

section( "A2 · AFTER ANOTHER TAB MERGED THIS TAB'S SAVE, ITS OWN DELETE AND UNDO HOLD" );
{
    const F = "data/t/cost.json";
    await seed( phone, F, JSON.stringify( [ { id: "a" }, { id: "k", v: 1 } ] ) );
    for( const c of [ A, B ] ) await R( c, F );
    await A.evaluate( "offline( true )" ); await B.evaluate( "offline( true )" );
    // A adds A1 and changes k to 2; B adds B1 (merged into A's waiting save)
    await W( A, F, [ { id: "a" }, { id: "k", v: 2 }, { id: "A1" } ] );
    await W( B, F, [ { id: "a" }, { id: "k", v: 1 }, { id: "B1" } ] );
    await A.evaluate( "offline( false )" ); await B.evaluate( "offline( false )" );
    await B.evaluate( "SM.flush().then( () => true )" );
    await untilNode( () => ids( F ).includes( "A1" ) && ids( F ).includes( "B1" ) );
    console.log( "  after merge went up:", disk( F ) );
    // A (its app took the merged list in, say) deletes its OWN A1 and undoes k back to 1
    const w = await W( A, F, [ { id: "a" }, { id: "k", v: 1 }, { id: "B1" } ] );
    await untilNode( () => { const k = ( items( F ) || [] ).find( x => x.id === "k" ); return ! ids( F ).includes( "A1" ) && k && k.v === 1; } );
    console.log( "  A's write:", JSON.stringify( w ), " disk:", disk( F ) );
    const k = ( items( F ) || [] ).find( x => x.id === "k" );
    ok( ! ids( F ).includes( "A1" ), "A's own item, deleted after the merge, stays deleted", disk( F ) );
    ok( k && k.v === 1, "A's undo of its own change (k back to 1) holds", disk( F ) );
    ok( ids( F ).includes( "B1" ), "B's item survives", disk( F ) );
}

section( "A2 · B deleted an item A kept in its waiting save: still deleted after A's next save" );
{
    const F = "data/t/cost2.json";
    await seed( phone, F, JSON.stringify( [ { id: "a" }, { id: "d" } ] ) );
    for( const c of [ A, B ] ) await R( c, F );
    await A.evaluate( "offline( true )" ); await B.evaluate( "offline( true )" );
    await W( A, F, [ { id: "a" }, { id: "d" }, { id: "A1" } ] );
    await W( B, F, [ { id: "a" }, { id: "B1" } ] );
    await A.evaluate( "offline( false )" ); await B.evaluate( "offline( false )" );
    await B.evaluate( "SM.flush().then( () => true )" );
    await untilNode( () => ids( F ).includes( "A1" ) && ids( F ).includes( "B1" ) );
    console.log( "  after merge went up:", disk( F ) );
    const w = await W( A, F, [ { id: "a" }, { id: "d" }, { id: "A1" }, { id: "A2" } ] );
    await untilNode( () => ids( F ).includes( "A2" ) );
    ok( ! ids( F ).includes( "d" ) && ids( F ).includes( "B1" ) && ids( F ).includes( "A1" ), "d stays deleted, B1 and A1 kept", { w, disk: disk( F ) } );
}

section( "A2 · a page with NO BroadcastChannel: its save merged by another tab, then it saves again" );
{
    const F = "data/t/nobc.json";
    await seed( phone, F, JSON.stringify( [ { id: "a" } ] ) );
    await R( N, F ); await R( B, F );
    await N.evaluate( "offline( true )" ); await B.evaluate( "offline( true )" );
    await W( N, F, [ { id: "a" }, { id: "N1" } ] );
    await W( B, F, [ { id: "a" }, { id: "B1" } ] );
    await seed( phone, F, JSON.stringify( [ { id: "a" }, { id: "P" } ] ) );
    await N.evaluate( "offline( false )" ); await B.evaluate( "offline( false )" );
    await B.evaluate( "SM.flush().then( () => true )" );
    ok( await untilNode( () => { const g = ids( F ); return g.includes( "N1" ) && g.includes( "B1" ) && g.includes( "P" ); } ), "all three up", disk( F ) );
    const w = await W( N, F, [ { id: "a" }, { id: "N1" }, { id: "N2" } ] );
    await untilNode( () => ids( F ).includes( "N2" ) );
    ok( ids( F ).includes( "B1" ) && ids( F ).includes( "P" ) && ids( F ).includes( "N2" ), "N's next save (no broadcasts heard) keeps B1 and P", { w, disk: disk( F ) } );
}

section( "A2 · three tabs: A waits, B reads+adds, C reads+adds, phone saves, C sends (412 merge); A and B save again from old models" );
{
    const F = "data/t/chain.json";
    await seed( phone, F, JSON.stringify( [ { id: "a" }, { id: "o" } ] ) );
    await R( A, F );
    await A.evaluate( "offline( true )" );
    await W( A, F, [ { id: "a" }, { id: "o" }, { id: "A1" } ] );
    await seed( phone, F, JSON.stringify( [ { id: "a" }, { id: "o" }, { id: "P" } ] ) );
    for( const c of [ B, C ] ) await c.evaluate( "offline( true )" );
    const rb = JSON.parse( await R( B, F ) ).map( x => x.id ).join();
    await W( B, F, JSON.parse( await R( B, F ) ).concat( [ { id: "B1" } ] ) );
    const rc = JSON.parse( await R( C, F ) ).map( x => x.id ).join();
    await W( C, F, JSON.parse( await R( C, F ) ).concat( [ { id: "C1" } ] ) );
    console.log( "  B read:", rb, " C read:", rc );
    for( const c of [ A, B, C ] ) await c.evaluate( "offline( false )" );
    await C.evaluate( "SM.flush().then( () => true )" );
    ok( await untilNode( () => [ "A1", "B1", "C1", "P" ].every( x => ids( F ).includes( x ) ) ), "C sends all, merged with the phone's", disk( F ) );
    // A deletes the original "o" and adds A2, from its old model [a,o,A1]
    const wa = await W( A, F, [ { id: "a" }, { id: "A1" }, { id: "A2" } ] );
    await untilNode( () => ids( F ).includes( "A2" ) );
    // B (model a,o,A1,B1) adds B2
    const wb = await W( B, F, [ { id: "a" }, { id: "o" }, { id: "A1" }, { id: "B1" }, { id: "B2" } ] );
    await untilNode( () => ids( F ).includes( "B2" ) );
    const g = ids( F );
    ok( [ "A1", "B1", "C1", "P", "A2", "B2" ].every( x => g.includes( x ) ), "nothing anybody added is lost", { wa, wb, disk: disk( F ) } );
    ok( ! g.includes( "o" ), "A's delete of 'o' holds", disk( F ) );
}

section( "A2 · 'later' merge: B's version descends from the waiting save's" );
{
    const F = "data/t/later2.json";
    await seed( phone, F, JSON.stringify( [ { id: "a" }, { id: "x" }, { id: "y" } ] ) );
    for( const c of [ A, B ] ) await R( c, F );
    // B deletes x and it goes up (V1); A never heard of it
    const w1 = await W( B, F, [ { id: "a" }, { id: "y" } ] );
    ok( w1.ok && ids( F ).join() === "a,y", "B's delete of x is up", disk( F ) );
    // A (offline, model from V0) adds A1 and deletes y
    await A.evaluate( "offline( true )" );
    await W( A, F, [ { id: "a" }, { id: "x" }, { id: "A1" } ] );
    // B (online) adds B2: merges into A's waiting save, base = V0 ('later')
    const w2 = await W( B, F, [ { id: "a" }, { id: "y" }, { id: "B2" } ] );
    console.log( "  B write2:", JSON.stringify( w2 ), " LOG B:", JSON.stringify( await B.evaluate( "LOG.slice( -2 )" ) ) );
    await A.evaluate( "offline( false )" );
    await B.evaluate( "SM.flush().then( () => true )" );
    await untilNode( () => ids( F ).includes( "B2" ) && ids( F ).includes( "A1" ) );
    const g = ids( F );
    ok( g.includes( "A1" ) && g.includes( "B2" ), "both adds kept", disk( F ) );
    ok( ! g.includes( "x" ), "B's delete of x holds (not resurrected)", disk( F ) );
    ok( ! g.includes( "y" ), "A's delete of y holds", disk( F ) );
}

section( "K2 · beforeunload after direct saves went up, and after a direct save's conflict" );
{
    const F = "files/bu.txt";
    await seed( phone, F, "v0\n" );
    for( const c of [ A, B ] ) await c.evaluate( `SC.read( '${F}' ).then( () => true )` );
    await B.evaluate( `( offline( true ), SC.write( '${F}', 'v0\\nB\\n' ).then( () => offline( false ) ) )` );
    const r1 = await A.evaluate( `J( SC.write( '${F}', 'v0\\nA1\\n' ) )` );
    const r2 = await A.evaluate( `J( SC.write( '${F}', 'v0\\nA1\\nA2\\n' ) )` );
    const bu = () => A.evaluate( "( () => { const ev = new Event( 'beforeunload', { cancelable: true } ); window.dispatchEvent( ev ); return ev.defaultPrevented; } )()" );
    ok( ! await bu(), "A's direct saves went up: closing asks nothing", { r1, r2, disk: disk( F ) } );
    // B's waiting save now 412s; then A edits on top of the phone's change, directly again
    await seed( phone, F, "phone\n" );
    await B.evaluate( `( offline( true ), SC.write( '${F}', 'v0\\nB\\nB2\\n' ).then( () => offline( false ) ) )` );
    const r3 = await A.evaluate( `J( SC.write( '${F}', 'v0\\nA1\\nA2\\nA3\\n' ) )` );
    console.log( "  r3:", r3, " A state:", await A.evaluate( "SC.state" ) );
    ok( await bu(), "A's direct save refused (only in A): closing asks", r3 );
    await A.evaluate( `SC.forget( '${F}' ).then( () => true )` );
    ok( ! await bu(), "after forget(): asks nothing" );
}

await done( A, s );
