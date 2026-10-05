// ds-upload-pending.mjs - the marks of parked saves (shared/store.js PARKED
// SAVES, docs/upload-less-plan.md): "changes waiting on device X" in
// data/office/pending.json, and what each device does with them.
//
//   - a parked save puts this device's mark up once; the entry is `marked`
//     and stays so when a later save replaces it; every way out takes the
//     mark away (sent, dropped, set aside, forget, a 409, a sign-out that
//     leaves it unsent); a mark 31 days old is not shown and goes
//   - another device sees it (pendingElsewhere) and may dismiss it
//   - dismissed: with the page open = the conflict question (why
//     "dismissed"), never a silent drop; with no page = dropped, no PUT,
//     nothing left to requeue it
//   - a 412 with no page = a copy beside the file (files/ when its folder is
//     gone), never over it nor at its old name; with the page open = the
//     conflict question
//   - a tab that opens a closed tab's parked save holds it: no flush
//     elsewhere sends or drops it behind its back
//   - Drive on this device sends parked changes before it deletes; Drive on
//     another device asks, and the device that parked drops them - the file
//     is never brought back
//   - the sign-out sends what is parked even with its tab open
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";
import { stPage, seed, untilNode } from "./store-lib.mjs";

const s = await server();
stPage( s );
const phone = await s.client();
const A = await browser( s );                 // device A
await A.open( "/nayive/st.html" );
const B = await browser( s );                 // device B: its own profile, its own device id
await B.open( "/nayive/st.html" );

const MARKS = "data/office/pending.json";
const disk  = rel => onDisk( s, rel );
const marks = () => { try { return JSON.parse( disk( MARKS ) ).marks || []; } catch { return []; } };
const markOf = rel => marks().filter( m => m.path === rel );
const big   = ( kb, tag ) => { let o = tag + "\n"; while( o.length < kb * 1024 ) o += crypto.randomBytes( 40 ).toString( "hex" ) + "\n"; return o; };
const J     = v => JSON.stringify( v );
const write = ( t, rel, body, o ) => t.evaluate( `J( SC.write( ${J( rel )}, ${J( body )}, ${J( o || { park: true } )} ) )` ).then( JSON.parse );
const read  = ( t, rel ) => t.evaluate( `SC.read( ${J( rel )} ).then( function () { return true; } )` );
const entry = ( t, rel ) => t.evaluate( `idb( 'outbox', ${J( rel )} ).then( function ( e ) { return e && { park: !! e.park, marked: !! e.marked, conflict: !! e.conflict }; } )` );
const cached = ( t, rel ) => t.evaluate( `idb( 'docs', ${J( rel )} ).then( function ( d ) { return !! d; } )` );
const puts  = ( t, rel ) => t.evaluate( `LOG.filter( function ( l ) { return l.put === ${J( rel )}; } ).length` );
const flush = t => t.evaluate( "SC.flush().then( function () { return true; } )" );
async function untilEntry( t, rel, fn, ms = 10000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { const e = await entry( t, rel ); if( fn( e ) ) return true; await sleep( 150 ); }
    return false;
}
async function tabOf( b, extra )
{
    const t = await b.tab();
    await t.open( "/nayive/st.html" );
    await t.evaluate( `( SC.onConflict( function ( p, why ) { EV.push( { c2: p, why: why || '' } ); } ), true )` );
    if( extra ) await t.evaluate( extra );
    return t;
}
async function closeTab( b, t ) { await fetch( `http://127.0.0.1:${b.port}/json/close/${t.id}` ).catch( () => {} ); await sleep( 300 ); }
// A tab parks `rel` (read first, then a big save), and waits for its mark.
async function parkIn( b, rel, tag )
{
    const t = await tabOf( b );
    await read( t, rel );
    const body = big( 300, tag );
    const r = await write( t, rel, body );
    const marked = await untilEntry( t, rel, e => e && e.marked );
    return { t, body, parked: !! r.parked && marked };
}
for( const t of [ A, B ] ) await t.evaluate( `( SC.onConflict( function ( p, why ) { EV.push( { c2: p, why: why || '' } ); } ), true )` );

//----------------------------------------------------------------------------//
section( "A PARKED SAVE PUTS ITS MARK UP; A REPLACING SAVE KEEPS IT" );
{
    const F = "files/f.txt";
    await seed( phone, F, "old\n" );
    const p = await parkIn( A, F, "f1" );
    ok( p.parked, "parked and marked" );
    const m = markOf( F );
    ok( m.length === 1 && m[ 0 ].state === "pending" && /·/.test( m[ 0 ].name ), "pending.json: one pending mark, named '<system> · <browser>'", m );
    await write( p.t, F, big( 300, "f2" ) );
    ok( ( await entry( p.t, F ) || {} ).marked, "a later save replacing it is still marked" );
    await sleep( 500 );
    ok( markOf( F ).length === 1, "still one mark" );

    const seen = await B.evaluate( `NayiveStore.pendingElsewhere( ${J( F )} )` );
    ok( seen.length === 1 && seen[ 0 ].name === m[ 0 ].name, "the other device sees it", seen );
    ok( ( await p.t.evaluate( `NayiveStore.pendingElsewhere( ${J( F )} )` ) ).length === 0, "this device does not warn itself" );
    ok( ( await B.evaluate( `NayiveStore.pendingElsewhere( 'files' )` ) ).length === 1, "a folder counts for what is in it" );

    await p.t.evaluate( `SC.unpark( ${J( F )}, { open: true } ).then( function () { return true; } )` );
    ok( await untilNode( () => markOf( F ).length === 0 ), "sent: the mark goes" );
    await closeTab( A, p.t );
}

//----------------------------------------------------------------------------//
section( "A MARK 31 DAYS OLD IS IGNORED, AND GOES AT THE NEXT WRITE" );
{
    const OLD = "files/ancient.txt";
    const now = JSON.parse( disk( MARKS ) || '{"marks":[]}' );
    now.marks.push( { path: OLD, device: "gone-phone", name: "Old phone", at: Date.now() - 31 * 86400000, state: "pending" } );
    await seed( phone, MARKS, JSON.stringify( now ) );
    ok( ( await B.evaluate( `NayiveStore.pendingElsewhere( ${J( OLD )} )` ) ).length === 0, "not shown" );
    await seed( phone, "files/g.txt", "old\n" );
    const p = await parkIn( A, "files/g.txt", "g" );
    ok( p.parked && markOf( OLD ).length === 0, "dropped from pending.json at the next write" );
    await p.t.evaluate( "SC.unpark( 'files/g.txt', { open: true } ).then( function () { return true; } )" );
    await closeTab( A, p.t );
}

//----------------------------------------------------------------------------//
section( "DISMISSED, PAGE OPEN: THE CONFLICT QUESTION, NEVER A SILENT DROP" );
{
    const F = "files/open.txt";
    await seed( phone, F, "old\n" );
    const p = await parkIn( A, F, "open" );
    ok( await B.evaluate( `NayiveStore.dismissPending( ${J( F )} )` ) && markOf( F )[ 0 ].state === "dismissed", "device B goes on: dismissed" );
    const r = JSON.parse( await p.t.evaluate( `J( SC.unpark( ${J( F )}, { open: true } ) )` ) );
    ok( r.conflict && r.dismissed, "its upload is held back as a conflict", r );
    ok( await p.t.until( `EV.some( function ( e ) { return e.c2 === ${J( F )} && e.why === 'dismissed'; } )` ), "the page is told, with why 'dismissed'" );
    ok( disk( F ) === "old\n" && await puts( p.t, F ) === 0, "no PUT: the file is as it was" );
    ok( ( await entry( p.t, F ) || {} ).conflict, "the changes stay in the outbox (conflict)" );
    await p.t.evaluate( `SC.forget( ${J( F )} ).then( function () { return true; } )` );
    ok( await untilNode( () => markOf( F ).length === 0 ), "forget() takes its mark away" );
    await closeTab( A, p.t );
}

//----------------------------------------------------------------------------//
section( "DISMISSED, NO PAGE: DROPPED IN SILENCE, NO PUT, NOTHING TO REQUEUE" );
{
    const F = "files/closed.txt";
    await seed( phone, F, "old\n" );
    const p = await parkIn( A, F, "closed" );
    await B.evaluate( `NayiveStore.dismissPending( ${J( F )} )` );
    await closeTab( A, p.t );
    await flush( A );
    ok( await untilEntry( A, F, e => ! e ), "a flush elsewhere drops the entry" );
    ok( ! await cached( A, F ), "and its cached copy (a read cannot queue it again)" );
    ok( disk( F ) === "old\n" && await puts( A, F ) === 0, "no PUT: the file is as it was" );
    ok( await untilNode( () => markOf( F ).length === 0 ), "the mark goes" );
    ok( ! ( await A.evaluate( "EV" ) ).some( e => e.c2 === F ), "and no question anywhere" );
}

//----------------------------------------------------------------------------//
section( "412, NO PAGE: A COPY BESIDE THE FILE, NEVER OVER IT" );
{
    const F = "files/Notas/chocan.txt";
    await seed( phone, F, "old\n" );
    const p = await parkIn( A, F, "aside" );
    await seed( phone, F, "the phone's\n" );
    await closeTab( A, p.t );
    await flush( A );
    const dir = path.join( s.home(), "files/Notas" );
    let aside = null;
    await untilNode( () => ( aside = fs.readdirSync( dir ).find( n => n !== "chocan.txt" && n.indexOf( "chocan (" ) === 0 ) ) );
    ok( disk( F ) === "the phone's\n", "the file keeps the other device's version" );
    ok( aside && /^chocan \(.+ · .+, \d\d\.\d\d\)\.txt$/.test( aside ) && disk( "files/Notas/" + aside ) === p.body,
        "the parked changes are beside it: 'chocan (<device>, HH.MM).txt'", aside );
    ok( await untilEntry( A, F, e => ! e ) && await untilNode( () => markOf( F ).length === 0 ), "out of the outbox, mark gone" );

    // The folder deleted meanwhile: the copy goes to files/, the folder is not made again.
    const G = "files/Viejo/borrado.txt";
    await seed( phone, G, "old\n" );
    const q = await parkIn( A, G, "gone" );
    const del = await phone.del( "/api/files?paths=" + encodeURIComponent( "files/Viejo" ) );
    ok( del.status === 200, "the folder goes to the bin from another device", del.status );
    await closeTab( A, q.t );
    await flush( A );
    let top = null;
    await untilNode( () => ( top = fs.readdirSync( path.join( s.home(), "files" ) ).find( n => n.indexOf( "borrado (" ) === 0 ) ) );
    ok( top && disk( "files/" + top ) === q.body, "the copy is in files/", top );
    ok( ! fs.existsSync( path.join( s.home(), "files/Viejo" ) ), "the deleted folder is not made again" );
}

//----------------------------------------------------------------------------//
section( "412, PAGE OPEN: THE CONFLICT QUESTION" );
{
    const F = "files/abierto.txt";
    await seed( phone, F, "old\n" );
    const p = await parkIn( A, F, "open412" );
    await seed( phone, F, "the phone's\n" );
    const r = JSON.parse( await p.t.evaluate( `J( SC.unpark( ${J( F )}, { open: true } ) )` ) );
    ok( r.conflict && ! r.dismissed, "held back as a conflict", r );
    ok( await p.t.until( `EV.some( function ( e ) { return e.c2 === ${J( F )} && e.why === ''; } )` ), "the page is asked (saved elsewhere)" );
    ok( disk( F ) === "the phone's\n" && fs.readdirSync( path.join( s.home(), "files" ) ).every( n => n.indexOf( "abierto (" ) !== 0 ), "nothing written, no copy made behind its back" );
    await p.t.evaluate( `SC.forget( ${J( F )} ).then( function () { return true; } )` );
    await closeTab( A, p.t );
}

//----------------------------------------------------------------------------//
section( "A TAB THAT OPENS A CLOSED TAB'S PARKED SAVE HOLDS IT" );
{
    const F = "files/adopt.txt";
    await seed( phone, F, "old\n" );
    const p = await parkIn( A, F, "adopt" );
    await closeTab( A, p.t );
    const t2 = await tabOf( A );
    await read( t2, F );                                 // it shows the parked body: its model now
    await B.evaluate( `NayiveStore.dismissPending( ${J( F )} )` );
    await flush( A );
    await sleep( 1000 );
    ok( ( await entry( A, F ) || {} ).park && await puts( A, F ) === 0, "a flush in another tab neither sends nor drops it" );
    const r = JSON.parse( await t2.evaluate( `J( SC.unpark( ${J( F )}, { open: true } ) )` ) );
    ok( r.conflict && r.dismissed, "its own upload gets the question (dismissed)", r );
    ok( disk( F ) === "old\n", "and the file is as it was" );
    await t2.evaluate( `SC.forget( ${J( F )} ).then( function () { return true; } )` );
    await closeTab( A, t2 );
}

//----------------------------------------------------------------------------//
section( "A REFUSED SAVE (409) IS DROPPED WITH ITS MARK" );
{
    const F = "files/refused.txt";
    await seed( phone, F, "old\n" );
    const t = await tabOf( A, `( function () { var f = window.fetch; window.fetch = function ( u, o ) {
        if( o && o.method === 'PUT' && String( u ).indexOf( 'refused.txt' ) !== -1 ) return Promise.resolve( new Response( '{}', { status: 409 } ) );
        return f.apply( this, arguments ); }; return true; } )()` );
    await read( t, F );
    await write( t, F, big( 300, "refused" ) );
    ok( await untilEntry( t, F, e => e && e.marked ), "parked and marked" );
    const r = JSON.parse( await t.evaluate( `J( SC.unpark( ${J( F )}, { open: true } ) )` ) );
    ok( r.forbidden, "the server refuses it", r );
    ok( await untilNode( () => markOf( F ).length === 0 ), "and its mark goes with it" );
    await closeTab( A, t );
}

//----------------------------------------------------------------------------//
section( "DRIVE: THIS DEVICE'S PARKED CHANGES GO WITH THE FILE TO THE BIN" );
const ASK = `( function () { window.__asks = []; NayiveUI.confirm = function ( o ) { window.__asks.push( o.title );
    return Promise.resolve( true ); }; return true; } )()`;
{
    const F = "files/papelera.txt";
    await seed( phone, F, "old\n" );
    const p = await parkIn( A, F, "to the bin" );
    const d = await A.tab();
    await d.open( "/nayive/drive/", "/nayive/drive/" );
    ok( await d.until( "typeof confirmDelete === 'function' && typeof appStore === 'function' && window.NayiveUI" ), "Drive is up" );
    await d.evaluate( ASK );
    await d.evaluate( `( deleteTargets = [ ${J( F )} ], confirmDelete().then( function () { return true; } ) )` );
    ok( await untilNode( () => disk( F ) === null ), "the file is in the bin" );
    const binned = ( function walk( dir ) { let out = []; for( const n of fs.readdirSync( dir, { withFileTypes: true } ) )
        out = out.concat( n.isDirectory() ? walk( path.join( dir, n.name ) ) : [ path.join( dir, n.name ) ] ); return out; } )( path.join( s.home(), ".trash" ) );
    ok( binned.some( f => fs.readFileSync( f, "utf8" ) === p.body ), "with the parked changes in it" );
    ok( ( await d.evaluate( "window.__asks" ) ).length === 0, "no question: they were this device's own" );
    await untilNode( () => markOf( F ).length === 0 );
    ok( markOf( F ).length === 0, "no mark left" );
    await closeTab( A, p.t );

    //------------------------------------------------------------------------//
    section( "DRIVE: ANOTHER DEVICE'S PARKED CHANGES - ASKED, THEN DROPPED THERE, NEVER BROUGHT BACK" );
    const G = "files/de-otro.txt";
    await seed( phone, G, "old\n" );
    const q = await parkIn( B, G, "device B" );
    await d.evaluate( `( deleteTargets = [ ${J( G )} ], confirmDelete().then( function () { return true; } ) )` );
    ok( await untilNode( () => disk( G ) === null ), "deleted from device A" );
    const asked = await d.evaluate( "window.__asks" );
    ok( asked.length === 1 && asked[ 0 ] === await d.evaluate( "NayiveUI.t( 'ui.park.title' )" ), "after the question about device B's changes", asked );
    ok( ( markOf( G )[ 0 ] || {} ).state === "dismissed", "its mark is dismissed" );
    await closeTab( B, q.t );
    await flush( B );
    ok( await untilEntry( B, G, e => ! e ), "device B drops them at its next flush" );
    await sleep( 500 );
    ok( disk( G ) === null && await puts( B, G ) === 0, "and the file is not brought back" );
    ok( fs.readdirSync( path.join( s.home(), "files" ) ).every( n => n.indexOf( "de-otro (" ) !== 0 ), "nor a copy of it" );
    await closeTab( A, d );
}

//----------------------------------------------------------------------------//
section( "SIGN-OUT: WHAT IS PARKED GOES UP, EVEN WITH ITS TAB OPEN" );
{
    const F = "files/salir.txt";
    await seed( phone, F, "old\n" );
    const p = await parkIn( A, F, "sign-out" );
    const G = "files/no-sale.txt";
    await seed( phone, G, "old\n" );
    const t2 = await tabOf( A, `( function () { var f = window.fetch; window.fetch = function ( u, o ) {
        if( o && o.method === 'PUT' && String( u ).indexOf( 'no-sale.txt' ) !== -1 ) return Promise.resolve( new Response( '{}', { status: 507 } ) );
        return f.apply( this, arguments ); }; return true; } )()` );
    await read( t2, G );
    await write( t2, G, big( 300, "stuck" ) );
    ok( await untilEntry( t2, G, e => e && e.marked ), "a second parked save, which the server will refuse (quota full)" );
    // The sign-out runs in t2 (its fetch refuses no-sale.txt): leave anyway.
    const went = await t2.evaluate( "NayiveStore.leaveDevice( function () { return Promise.resolve( true ); } )" );
    ok( went === true, "signed out after the question" );
    ok( disk( F ) === p.body, "the parked save of the open tab went up first" );
    ok( disk( G ) === "old\n" && await untilNode( () => markOf( G ).length === 0 ), "the one left unsent loses its mark with it" );
    ok( markOf( F ).length === 0, "no mark left at all" );
}

await done( A, B, s );
