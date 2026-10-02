// ds-gumapi.mjs - the plain file helper (shared/gum-api.js) checks versions
// (batch C4b), and writes only for the account its page belongs to.
//
// A/C (version half): GumApi.updateJson( path, fn ) - read with the file's
//     version, change, write over THAT version only (If-Match); another
//     device's save in between makes it read again and change again. A file
//     that cannot be read, or only an offline copy of it, is never written.
// "Our own first try": a conditional PUT re-sent after a dropped connection
//     meets the file its first try made (412) - the same bytes are a success,
//     another file's are not.
// L5 (office #14, GumApi half): a page left open after another account signed
//     in on this browser gets 423 - its write never lands in the other home.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { installRace, arm, raced } from "./race.mjs";

const s = await server( { ana: "abc", beto: "xyz" } );
const c = await browser( s, { user: "ana" } );
const phone = await s.client( "ana", "abc" );
const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };
const json = rel => { try { return JSON.parse( onDisk( s, rel, "ana" ) ); } catch { return null; } };

ok( await c.open( "/nayive/split/", "/nayive/split/" ), "a page with GumApi opens" );
ok( await c.until( "window.GumApi && document.readyState === 'complete'" ), "GumApi is there" );
await installRace( c );
// Inside a promise, so a missing function is a FAIL line, not a crash.
const run = js => c.evaluate( `Promise.resolve().then( async () => { ${js} } ).then( v => v, e => ( { error: e && ( e.status || e.message || String( e ) ), notRead: !! ( e && e.notRead ), offline: !! ( e && e.offline ) } ) )` );

//------------------------------------------------------------------------//
section( "updateJson: another device's save in between is kept" );
{
    const F = "data/t/list.json";
    await seed( F, JSON.stringify( { a: 1 } ) );
    await arm( c, F, "t => JSON.stringify( Object.assign( JSON.parse( t ), { phone: 1 } ) )" );
    const r = await run( `return await GumApi.updateJson( '${F}', v => { v.mine = 1; return v; } );` );
    ok( await raced( c ), "the phone saved between the page's read and its write" );
    const d = json( F );
    ok( d && d.a === 1 && d.phone === 1 && d.mine === 1, "the file holds both changes", { r, d } );
}

section( "updateJson: no file yet - made create-only, and one made meanwhile is kept" );
{
    const F = "data/t/new.json";
    const r = await run( `let once = true; return await GumApi.updateJson( '${F}', v => {
        if( once ) { once = false; const x = new XMLHttpRequest(); x.open( 'PUT', '/api/files?file=' + encodeURIComponent( '${F}' ), false ); x.send( '{"phone":1}' ); }
        return Object.assign( v || {}, { mine: 1 } ); } );` );
    const d = json( F );
    ok( d && d.phone === 1 && d.mine === 1, "the file made in between is kept, this change added", { r, d } );
}

section( "updateJson: a file that cannot be read is not written" );
{
    const F = "data/t/busy.json";
    await seed( F, JSON.stringify( { keep: 1 } ) );
    const before = onDisk( s, F, "ana" );
    await c.evaluate( `( () => { const f = window.fetch; window.__busy = true; window.fetch = function ( u, o ) {
        if( window.__busy && String( u ).indexOf( encodeURIComponent( '${F}' ) ) !== -1 && ( ! o || ! o.method || o.method === 'GET' ) )
            return Promise.resolve( new Response( 'busy', { status: 503 } ) );
        return f.apply( this, arguments ); }; return true; } )()` );
    const r = await run( `return await GumApi.updateJson( '${F}', v => ( { only: 'this' } ) );` );
    await c.evaluate( "window.__busy = false; true" );
    ok( r && r.error === 503 && r.notRead, "it throws (notRead) on a 503", r );
    ok( onDisk( s, F, "ana" ) === before, "the file is untouched" );
}

section( "updateJson: an offline copy (X-Nayive-Copy) is not the file - nothing written" );
{
    const F = "data/t/trip.json";
    await seed( F, JSON.stringify( { now: 2 } ) );
    const before = onDisk( s, F, "ana" );
    await c.evaluate( `( () => { const f = window.fetch; window.__copy = true; window.fetch = function ( u, o ) {
        if( window.__copy && String( u ).indexOf( encodeURIComponent( '${F}' ) ) !== -1 && ( ! o || ! o.method || o.method === 'GET' ) )
            return Promise.resolve( new Response( '{"old":1}', { status: 200, headers: { 'ETag': '"stale"', 'X-Nayive-Copy': 'offline' } } ) );
        return f.apply( this, arguments ); }; return true; } )()` );
    const r = await run( `return await GumApi.updateJson( '${F}', v => { v.mine = 1; return v; } );` );
    await c.evaluate( "window.__copy = false; true" );
    ok( r && r.offline && r.notRead, "it throws (offline)", r );
    ok( onDisk( s, F, "ana" ) === before, "the file is untouched" );
}

section( "updateJson: a change that returns nothing does not empty the file" );
{
    const F = "data/t/keep.json";
    await seed( F, JSON.stringify( { keep: 1 } ) );
    const before = onDisk( s, F, "ana" );
    const r = await run( `return await GumApi.updateJson( '${F}', v => { v.mine = 1; } );` );
    ok( r && r.error, "it throws", r );
    ok( onDisk( s, F, "ana" ) === before, "the file is untouched" );
}

section( "writeFileBytes { ifMatch }: only over the version read" );
{
    const F = "files/v.txt";
    await seed( F, "v1" );
    const r = await run( `const v = await GumApi.readVersion( '${F}' );
        const w = await GumApi.writeFileBytes( '${F}', new TextEncoder().encode( 'mine' ), { ifMatch: v.tag } );
        let stale = null;
        try { await GumApi.writeFileBytes( '${F}', new TextEncoder().encode( 'stale' ), { ifMatch: v.tag } ); } catch( e ) { stale = e.status; }
        const w2 = await GumApi.writeFileBytes( '${F}', new TextEncoder().encode( 'mine again' ), { ifMatch: w.tag } );
        return { read: v.body, tag: !! v.tag, newTag: !! w.tag && w.tag !== v.tag, stale, again: !! w2.tag };` );
    ok( r && r.read === "v1" && r.tag, "readVersion: the body and its tag", r );
    ok( r && r.newTag, "a write answers the new version", r );
    ok( r && r.stale === 412, "a write over an older version: 412", r );
    ok( r && r.again && onDisk( s, F, "ana" ) === "mine again", "the new version's tag writes again; the stale write wrote nothing" );
}

//------------------------------------------------------------------------//
// The first PUT lands, but its answer is lost (the connection drops): the
// page sends it again, and that meets the file the first one made.
const DROP = ( mode ) => `( () => { const X = XMLHttpRequest.prototype; if( ! X.__send0 ) { X.__send0 = X.send; X.__open0 = X.open;
    X.open = function ( m, u ) { this.__m = m; this.__u = u; return X.__open0.apply( this, arguments ); };
    X.send = function ( b ) {
        if( window.__drop && this.__m === 'PUT' ) {
            const mode = window.__drop; window.__drop = null; const xhr = this;
            if( mode === 'landed' ) { xhr.onload = () => { xhr.onerror(); }; return X.__send0.apply( this, arguments ); }
            // 'other': it never left, and another device put another file there meanwhile
            const y = new XMLHttpRequest(); y.open( 'PUT', xhr.__u, false ); X.__send0.call( y, 'ANOTHER FILE' );
            setTimeout( () => xhr.onerror(), 0 ); return;
        }
        return X.__send0.apply( this, arguments ); }; }
    window.__drop = ${JSON.stringify( mode )}; return true; } )()`;

section( "OUR OWN FIRST TRY: a re-send that meets its own file is a success" );
{
    await c.evaluate( DROP( "landed" ) );
    const r = await run( `const w = await GumApi.createFileBytes( 'files/first.txt', new TextEncoder().encode( 'MINE' ) ); return { tag: !! ( w && w.tag ) };` );
    ok( r && r.tag, "createFileBytes: saved (the 412 was its own first try), with its version", r );
    ok( onDisk( s, "files/first.txt", "ana" ) === "MINE", "the file is this one's" );

    await seed( "files/im.txt", "v1" );
    await c.evaluate( DROP( "landed" ) );
    const r2 = await run( `const v = await GumApi.readVersion( 'files/im.txt' );
        const w = await GumApi.writeFileBytes( 'files/im.txt', new TextEncoder().encode( 'EDITED' ), { ifMatch: v.tag } ); return { tag: !! ( w && w.tag ) };` );
    ok( r2 && r2.tag && onDisk( s, "files/im.txt", "ana" ) === "EDITED", "If-Match write: the same, with its version", r2 );

    await c.evaluate( DROP( "other" ) );
    const r3 = await run( `await GumApi.createFileBytes( 'files/second.txt', new TextEncoder().encode( 'MINE' ) ); return 'saved';` );
    ok( r3 && r3.error === 412, "...but another device's file there is not: 412", r3 );
    ok( onDisk( s, "files/second.txt", "ana" ) === "ANOTHER FILE", "and that file is untouched" );
}

//------------------------------------------------------------------------//
section( "L5 · A PAGE OF ANA'S, LEFT OPEN WHILE BETO SIGNS IN ON THIS BROWSER" );
{
    const st = await c.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { user: 'beto', password: 'xyz' } ) } ).then( r => r.status )` );
    ok( st === 200 && /nayive_who=user%3Abeto|nayive_who=user:beto/.test( await c.evaluate( "document.cookie" ) ), "beto signed in on this browser", st );
    const r = await run( `await GumApi.writeFileBytes( 'files/ana.txt', new TextEncoder().encode( 'ANA' ) ); return 'saved';` );
    ok( r && r.error === 423, "ana's page: its write is refused (423)", r );
    ok( onDisk( s, "files/ana.txt", "beto" ) === null && onDisk( s, "files/ana.txt", "ana" ) === null, "nothing landed in beto's home (nor anywhere)" );
    const r2 = await run( `return await GumApi.updateJson( 'data/t/ana.json', v => ( { ana: 1 } ) );` );
    ok( r2 && r2.error === 423 && onDisk( s, "data/t/ana.json", "beto" ) === null, "updateJson too", r2 );
}

await done( c, s );
