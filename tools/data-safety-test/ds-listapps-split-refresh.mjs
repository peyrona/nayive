// ds-listapps-split-refresh.mjs - Split's re-read (focus, tab, plug) reads only
// the groups whose file changed on the server, and still sees every change.
//
// B5-18 (cleanup 6b): it used to GET every group.json on each focus. Now the
// folder listing's mtime|size says which ones moved; an unchanged group keeps
// the copy on screen. Checked here: nothing changed = no group GET; one group
// changed on "the phone" = one GET and the change on screen; a group deleted
// on the phone leaves the list; a save waiting here is never skipped.
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";

const s = await server();
const c = await browser( s );
const phone = await s.client();
const until15 = c.until;
c.until = ( expr, ms = 30000 ) => until15( expr, ms );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:split', '1' ); true" );

const mem = [ { id: "m1", name: "Ana", me: true }, { id: "m2", name: "Luis" } ];
const ex  = ( id, text ) => ( { id, type: "expense", date: "2026-10-01", amount: 1000, currency: "EUR", rate: 1, created: 1, text, paidBy: "m1", split: { among: [ "m1", "m2" ] } } );
const grp = ( id, name, entries ) => JSON.stringify( { id, name, currency: "EUR", created: "2026-09-01", archived: false, members: mem, rates: {}, entries }, null, 2 );
const F   = id => `data/split/${id}/group.json`;
const write = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };

await write( F( "g1" ), grp( "g1", "Alpha", [ ex( "e1", "Taxi" ) ] ) );
await write( F( "g2" ), grp( "g2", "Bravo", [] ) );
await write( F( "g3" ), grp( "g3", "Charlie", [] ) );

// The page's GETs of one file (the store's ?file=) from now on.
const GETLOG = `( () => { window.__gets = []; if( window.__getsOn ) return true; window.__getsOn = true; const f = window.fetch;
    window.fetch = function( u, i ) { if( ( ! i || ! i.method || i.method === 'GET' ) && /[?&]file=/.test( String( u ) ) )
        window.__gets.push( decodeURIComponent( String( u ).split( 'file=' )[ 1 ] ) ); return f.apply( this, arguments ); };
    return true; } )()`;
const names   = "[...document.querySelectorAll('#groupList .card-row')].map( r => r.textContent ).join( '|' )";
const refresh = async () => { await c.evaluate( GETLOG ); await c.evaluate( "window.nayiveRefresh().then( () => true )" ); return c.evaluate( "window.__gets.slice().sort()" ); };

await c.open( "/nayive/split/" );
ok( await c.until( "document.querySelectorAll('#groupList .card-row').length === 3" ), "three groups listed" );
await c.until( "document.getElementById('syncIndicator').dataset.syncState === 'synced'" );

section( "B5-18 · nothing changed: no group is read again" );
{
    const gets = await refresh();
    ok( gets.length === 0, "no group GET on a re-read", gets.join( "," ) );
    ok( ( await c.evaluate( names ) ).includes( "Alpha" ), "the list is still there" );
    ok( await c.until( "document.getElementById('syncIndicator').dataset.syncState === 'synced'" ), "the plug rests on synced" );
}

section( "B5-18 · one group changed on the phone: that one is read, and shown" );
{
    await sleep( 1100 );                       // a new second: the listing's mtime moves
    await write( F( "g2" ), grp( "g2", "Bravo changed", [] ) );
    const gets = await refresh();
    ok( gets.length === 1 && gets[ 0 ] === F( "g2" ), "exactly one GET, of g2", gets.join( "," ) );
    ok( await c.until( names + ".includes( 'Bravo changed' )" ), "the new name is on screen" );
}

section( "B5-18 · a group deleted on the phone leaves the list" );
{
    const r = await phone.del( "/api/files?paths=" + encodeURIComponent( "data/split/g3" ) );
    ok( r.status === 200, "the phone deletes g3", r.status );
    const gets = await refresh();
    ok( gets.includes( F( "g3" ) ) && ! gets.includes( F( "g1" ) ), "the unlisted g3 is read, g1 is not", gets.join( "," ) );
    ok( await c.until( "! " + names + ".includes( 'Charlie' )" ), "Charlie is gone from the list" );
}

section( "B5-18 · inside a group: the open group follows the phone" );
{
    await c.evaluate( "[...document.querySelectorAll('#groupList .card-row')].find( r => r.textContent.includes( 'Alpha' ) ).click(); true" );
    ok( await c.until( "document.querySelectorAll('#entryList .card-row').length === 1" ), "Alpha is open" );
    let gets = await refresh();
    ok( gets.length === 0, "unchanged: no GET", gets.join( "," ) );
    ok( await c.evaluate( "document.querySelectorAll('#entryList .card-row').length === 1" ), "the entry is still on screen" );

    await sleep( 1100 );
    const g = JSON.parse( ( await phone.get( F( "g1" ) ) ).text );
    g.entries.push( ex( "e2", "Hotel" ) );
    await write( F( "g1" ), JSON.stringify( g, null, 2 ) );
    gets = await refresh();
    ok( gets.length === 1 && gets[ 0 ] === F( "g1" ), "one GET, of g1", gets.join( "," ) );
    ok( await c.until( "[...document.querySelectorAll('#entryList .card-row')].some( r => r.textContent.includes( 'Hotel' ) )" ), "the phone's Hotel is on screen" );
}

section( "B5-18 · a save waiting here is read back, never skipped" );
{
    // The page's PUTs fail as a dropped connection does, so the rename stays in
    // the outbox. The re-read must read that group (its queued body), not take
    // it as "unchanged" from the listing.
    await c.evaluate( `( () => { const f = window.fetch; window.fetch = function( u, i ) {
        if( i && i.method === 'PUT' && window.__noPut ) return Promise.reject( new TypeError( 'Failed to fetch' ) );
        return f.apply( this, arguments ); }; window.__noPut = true; return true; } )()` );
    await c.evaluate( "document.getElementById('editBtn').click(); true" );
    await c.until( "document.getElementById('groupSheetBackdrop').classList.contains('open')" );
    await c.evaluate( "( () => { const i = document.getElementById('groupNameInput'); i.value = 'Alpha local'; i.dispatchEvent( new Event( 'input', { bubbles: true } ) ); document.getElementById('groupSaveBtn').click(); return true; } )()" );
    ok( await c.until( "! document.getElementById('groupSheetBackdrop').classList.contains('open')" ), "renamed" );
    // The PUT has failed (its retries done): the save is back in the outbox.
    ok( await c.until( "[ 'offline', 'pending', 'error' ].includes( document.getElementById('syncIndicator').dataset.syncState )" ),
        "the plug says the save is waiting", await c.evaluate( "document.getElementById('syncIndicator').dataset.syncState" ) );
    // (The store answers that read from the outbox, with no GET, so it is not
    // seen in __gets; what the page must show is the waiting save, never the
    // server's older body.)
    await refresh();
    ok( await c.until( "document.getElementById('groupName').textContent.includes( 'Alpha local' )" ), "the local name stays on screen" );
    ok( ! /Alpha local/.test( onDisk( s, F( "g1" ) ) || "" ), "...and it really was still waiting (not on the server)" );
    await c.evaluate( "window.__noPut = false; window.nayiveRefresh().then( () => true )" );
    let up = false;
    for( const end = Date.now() + 30000; ! up && Date.now() < end; await sleep( 200 ) ) up = /Alpha local/.test( onDisk( s, F( "g1" ) ) || "" );
    ok( up, "once the connection is back the rename goes up" );
}

await done( c, s );
