// ds-store-lostanswer.mjs - a save that reached the server but whose answer
// never came back is SAVED, not "changed on another device" (2026-10-07).
//
// A Calc window closed while its save was on its way: the server kept the
// file, the page died before it heard, and the next open sent the same save
// again - 412 - and the red plug said "Cambiado en otro dispositivo". The same
// with netFetch's own re-send after a dropped answer. Now a 412 looks at the
// file there first: exactly this save's bytes = saved. Anything else is still
// the conflict it always was (ds-store-core A1), and an entry already held
// back as a conflict is asked again the same way.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { stPage, seed } from "./store-lib.mjs";

const s = await server();
stPage( s );
const phone = await s.client();
const A = await browser( s );
await A.open( "/nayive/st.html" );

const disk = rel => onDisk( s, rel );

// The next PUT lands on the server, but its answer is lost (a dropped connection).
await A.evaluate( `( () => { const f1 = window.fetch; window.loseNext = false;
    window.fetch = async function ( u, o ) {
        const r = await f1.apply( this, arguments );
        if( window.loseNext && o && o.method === 'PUT' ) { window.loseNext = false; throw new TypeError( 'Failed to fetch' ); }
        return r; };
    return true; } )()` );

//----------------------------------------------------------------------------//
section( "THE ANSWER IS LOST, THE PAGE SENDS IT AGAIN" );
{
    const F = "files/lost.txt";
    await seed( phone, F, "v0\n" );
    await A.evaluate( `SC.read( '${F}' ).then( r => { M.doc = r.body; EV.length = 0; window.loseNext = true; return true; } )` );
    const r = JSON.parse( await A.evaluate( `J( SC.write( '${F}', M.doc + 'typed\\n' ) )` ) );
    ok( r.ok && ! r.conflict, "saved: the 412 was its own first try", r );
    ok( disk( F ) === "v0\ntyped\n", "the file is this save", disk( F ) );
    ok( ! await A.evaluate( "EV.some( e => e.conflict )" ), "no conflict question", await A.evaluate( "EV" ) );
    ok( await A.evaluate( `idb( 'outbox', '${F}' ).then( e => e === null )` ), "nothing left in the outbox" );
    ok( await A.evaluate( "SC.state !== 'conflict'" ), "the plug is not red", await A.evaluate( "SC.state" ) );
    const r2 = JSON.parse( await A.evaluate( `J( SC.write( '${F}', M.doc + 'typed\\nmore\\n' ) )` ) );
    ok( r2.ok && disk( F ) === "v0\ntyped\nmore\n", "the next save goes up on the new version", { r2, disk: disk( F ) } );
}

//----------------------------------------------------------------------------//
section( "THE WINDOW CLOSED MID-SAVE: THE NEXT OPEN SENDS IT AGAIN" );
{
    const F = "files/closed.txt";
    await seed( phone, F, "c0\n" );
    await A.evaluate( `SC.read( '${F}' ).then( r => { M.c = r.body; EV.length = 0; return offline( true ); } )` );
    const q = JSON.parse( await A.evaluate( `J( SC.write( '${F}', M.c + 'edited\\n' ) )` ) );
    ok( q.offline, "the save waits in the outbox", q );
    await seed( phone, F, "c0\nedited\n" );       // ...where its first try had already landed
    await A.evaluate( "offline( false )" );
    await A.evaluate( "SC.flush().then( () => true )" );
    ok( await A.evaluate( `idb( 'outbox', '${F}' ).then( e => e === null )` ), "sent again: found there, so saved - out of the outbox",
        await A.evaluate( `idb( 'outbox', '${F}' )` ) );
    ok( disk( F ) === "c0\nedited\n" && ! await A.evaluate( "EV.some( e => e.conflict )" ), "no conflict, the file unchanged",
        { disk: disk( F ), ev: await A.evaluate( "EV" ) } );
}

//----------------------------------------------------------------------------//
section( "ANOTHER DEVICE'S FILE THERE: STILL A CONFLICT" );
{
    const F = "files/other.txt";
    await seed( phone, F, "o0\n" );
    await A.evaluate( `SC.read( '${F}' ).then( r => { M.o = r.body; EV.length = 0; return offline( true ); } )` );
    await A.evaluate( `J( SC.write( '${F}', M.o + 'mine\\n' ) )` );
    await seed( phone, F, "o0\ntheirs\n" );
    await A.evaluate( "offline( false )" );
    await A.evaluate( "SC.flush().then( () => true )" );
    ok( disk( F ) === "o0\ntheirs\n", "their file is not overwritten", disk( F ) );
    ok( await A.until( "EV.some( e => e.conflict )" ) && await A.evaluate( `SC.conflicted( '${F}' )` ),
        "the conflict question comes, as before" );
    const held = await A.evaluate( `idb( 'outbox', '${F}' )` );
    ok( held && held.conflict && held.body === "o0\nmine\n", "and this save is kept, held back", held );
}

//----------------------------------------------------------------------------//
section( "HELD BACK BEFORE THIS FIX, BUT THE FILE THERE IS THIS SAVE" );
{
    const F = "files/flagged.txt";
    await seed( phone, F, "f0\n" );
    await A.evaluate( `SC.read( '${F}' ).then( r => { M.f = r.body; EV.length = 0; return offline( true ); } )` );
    await A.evaluate( `J( SC.write( '${F}', M.f + 'kept\\n' ) )` );
    await seed( phone, F, "f0\nkept\n" );
    await A.evaluate( `idb( 'outbox', '${F}' ).then( e => idbPut( 'outbox', Object.assign( e, { conflict: true } ) ) )` );
    await A.evaluate( "offline( false )" );
    ok( ! await A.evaluate( `SC.conflicted( '${F}' )` ), "conflicted() asks the server again: not a conflict" );
    ok( await A.evaluate( `idb( 'outbox', '${F}' ).then( e => e === null )` ), "the held save is done with",
        await A.evaluate( `idb( 'outbox', '${F}' )` ) );
    ok( disk( F ) === "f0\nkept\n", "the file unchanged", disk( F ) );

    const G = "files/flagged-other.txt";
    await seed( phone, G, "g0\n" );
    await A.evaluate( `SC.read( '${G}' ).then( r => { M.g = r.body; return offline( true ); } )` );
    await A.evaluate( `J( SC.write( '${G}', M.g + 'mine\\n' ) )` );
    await seed( phone, G, "g0\ntheirs\n" );
    await A.evaluate( `idb( 'outbox', '${G}' ).then( e => idbPut( 'outbox', Object.assign( e, { conflict: true } ) ) )` );
    await A.evaluate( "offline( false )" );
    ok( await A.evaluate( `SC.conflicted( '${G}' )` ), "a held save that differs from the file there stays a conflict" );
    const g = await A.evaluate( `idb( 'outbox', '${G}' )` );
    ok( g && g.conflict && g.body === "g0\nmine\n" && disk( G ) === "g0\ntheirs\n", "both texts kept", { g, disk: disk( G ) } );
}

const errs = A.logs.filter( l => /EXCEPTION/.test( l ) );
ok( errs.length === 0, "no exceptions in the page", errs.slice( 0, 3 ) );
await done( A, s );
