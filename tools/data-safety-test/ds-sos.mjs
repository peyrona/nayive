// ds-sos.mjs - SOS settings and alerts (server/go/sos.go, config/sos.json,
// shared/sos.js). Plain HTTP: the page only calls these.
//
// S1 no file: opening the launcher (GET /api/sos) and "I'm OK" write nothing.
// S2 a save keeps the other users' rows; only real other users become contacts.
// S3 a refused save (bad hours, bad time) leaves the file byte for byte.
// S4 an admin rename / delete follows the owner and the contact.
// S5 a damaged file is never written over: moved aside, dated, before a save.
import fs from "node:fs";
import path from "node:path";
import { server, ok, section, done, sleep } from "./lib.mjs";

const s = await server( { test: "test", ana: "ana", beto: "beto" } );
const F = path.join( s.run, "config", "sos.json" );
const raw  = () => { try { return fs.readFileSync( F, "utf8" ); } catch { return null; } };
const json = () => { try { return JSON.parse( raw() ); } catch { return null; } };
const row  = u => ( ( json() || {} ).users || [] ).find( r => r.owner === u );
const test = await s.client( "test" );
const ana  = await s.client( "ana" );
const put  = ( c, body ) => c.call( "PUT", "/api/sos", JSON.stringify( body ), { "Content-Type": "application/json" } );

//------------------------------------------------------------------------//
section( "S1 · NO FILE YET" );
ok( ( await test.call( "GET", "/api/sos" ) ).status === 200, "GET answers" );
ok( ( await test.post( "/api/sos/ok", "{}", { "Content-Type": "application/json" } ) ).status === 200, "I'm OK answers" );
await sleep( 300 );
ok( raw() === null, "nothing written by just looking" );

//------------------------------------------------------------------------//
section( "S2 · SAVES" );
ok( ( await put( ana, { contacts: [ "test" ], silent: 4, idle: 0 } ) ).status === 200, "ana saves" );
ok( ( await put( test, { contacts: [ "beto", "nobody", "test", "beto" ], silent: 6, idle: 12, quietFrom: "23:00", quietTo: "08:00" } ) ).status === 200, "test saves" );
ok( JSON.stringify( row( "test" )?.contacts ) === '["beto"]' && row( "test" ).idle === 12, "only real other users, once", row( "test" ) );
ok( row( "ana" )?.silent === 4 && JSON.stringify( row( "ana" ).contacts ) === '["test"]', "ana's row kept", row( "ana" ) );

//------------------------------------------------------------------------//
section( "S3 · REFUSED SAVES" );
const before = raw();
ok( ( await put( test, { contacts: [ "beto" ], silent: 99 } ) ).status === 400, "hours out of range refused" );
ok( ( await put( test, { contacts: [ "beto" ], quietFrom: "25:61" } ) ).status === 400, "a bad time refused" );
ok( raw() === before, "the file is byte for byte as it was" );

//------------------------------------------------------------------------//
section( "S4 · ADMIN RENAME AND DELETE" );
const admin = await s.client( "jefe", "secreto" ).catch( () => null );
ok( !! admin, "the admin signs in" );
if( admin )
{
    const r = await admin.post( "/api/admin", JSON.stringify( { action: "rename-user", name: "beto", new_name: "bea" } ), { "Content-Type": "application/json" } );
    if( r.status === 200 )
    {
        ok( JSON.stringify( row( "test" )?.contacts ) === '["bea"]', "a renamed contact follows", row( "test" ) );
        const d = await admin.post( "/api/admin", JSON.stringify( { action: "delete-user", name: "ana" } ), { "Content-Type": "application/json" } );
        if( d.status === 200 ) ok( ! row( "ana" ) && row( "test" ), "a deleted user's row goes, the others stay", json() );
        else ok( false, "admin delete answered", d.status + " " + d.text.slice( 0, 120 ) );
    }
    else ok( false, "admin rename answered", r.status + " " + r.text.slice( 0, 120 ) );
}

//------------------------------------------------------------------------//
section( "S5 · A DAMAGED FILE" );
{
    await s.stop();
    const s2 = await server( { test: "test", beto: "beto" } );
    const F2 = path.join( s2.run, "config", "sos.json" );
    fs.writeFileSync( F2, "{ broken" );
    const t2 = await s2.client( "test" );
    ok( ( await t2.call( "GET", "/api/sos" ) ).status === 200, "it still answers" );
    ok( fs.readFileSync( F2, "utf8" ) === "{ broken", "looking writes nothing" );
    ok( ( await t2.call( "PUT", "/api/sos", JSON.stringify( { contacts: [ "beto" ], silent: 6 } ), { "Content-Type": "application/json" } ) ).status === 200, "a save" );
    const aside = fs.readdirSync( path.dirname( F2 ) ).filter( f => f.startsWith( "sos.json.broken-" ) );
    ok( aside.length === 1 && fs.readFileSync( path.join( path.dirname( F2 ), aside[ 0 ] ), "utf8" ) === "{ broken", "the damaged file is kept aside, untouched", aside );
    ok( JSON.parse( fs.readFileSync( F2, "utf8" ) ).users[ 0 ].contacts[ 0 ] === "beto", "the new file is whole" );
    await s2.stop();
}

await done();
