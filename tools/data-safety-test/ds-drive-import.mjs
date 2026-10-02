// ds-drive-import.mjs - Drive's ".ics / .vcf -> Add to Calendar / Contacts"
// never builds on an old copy, never goes up blind, never reverts an edit,
// and has an Undo (batch C4c).
//
// C1 (drive-files #3, list-apps #10, store-core #9): offline (or the server
//     not reached) the import was added to the copy this browser cached and
//     went up later with no check - every event the phone added since was
//     lost. Now it reads the server's copy fresh, or refuses ("go online");
//     and its save carries the version it was made from: a save made
//     elsewhere in between answers 412, and the import is made again on it.
// C2 (list-apps #3): an event / card dropped again replaced the one in the
//     calendar WHOLE - an old export took back every edit since. Now only a
//     NEWER copy replaces it (SEQUENCE, then LAST-MODIFIED / DTSTAMP; REV for
//     cards); an older or equal one is kept and the toast says so. Undo
//     takes out what the import put in (by UID, only where it is still as
//     the import left it).
// K2 / K5 Drive side: a save kept only in the page, or gone before it was
//     sent, is "not saved" - never "Imported".
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";

const s = await server();
const phone = await s.client();
const c = await browser( s );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:drive', '1' ); true" );

const CALF = "data/calendar.ics", CONF = "data/contacts.vcf";
const VEV = ( uid, sum, stamp, extra = [] ) => [ "BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + stamp, "DTSTART:20261010T100000Z",
                                                  "DTEND:20261010T110000Z", "SUMMARY:" + sum, ...extra, "END:VEVENT" ];
const CAL = ( ...evs ) => [ "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...evs.flat(), "END:VCALENDAR", "" ].join( "\r\n" );
const VC  = ( uid, fn, rev ) => [ "BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + fn, "N:" + fn + ";;;;", ...( rev ? [ "REV:" + rev ] : [] ), "END:VCARD" ].join( "\r\n" );
const BOOK = ( ...cards ) => cards.join( "\r\n" ) + "\r\n";
const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 && r.status !== 201 ) throw new Error( "seed " + rel + ": " + r.status ); };
const has  = ( rel, text ) => String( onDisk( s, rel ) || "" ).indexOf( text ) !== -1;
async function untilNode( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( await fn() ) return true; } catch {} await new Promise( r => setTimeout( r, 150 ) ); }
    return false;
}

// Drive, its questions answered by the test: alerts recorded, toasts recorded.
async function drive()
{
    await c.open( "/nayive/drive/", "/nayive/drive/" );
    const up = await c.until( "typeof runAppImports === 'function' && typeof appStore === 'function' && window.NayiveUI", 20000 );
    await c.evaluate( "window.__alerts = []; NayiveUI.alert = function ( o ) { window.__alerts.push( o.body ); return Promise.resolve(); }; window.__toasts = []; true" );
    return up;
}
// One dropped file, "Add" answered: resolves once the import is over.
const drop = ( name, text ) => c.evaluate( `runAppImports( [ { relPath: ${JSON.stringify( name )}, file: new File( [ ${JSON.stringify( text )} ], ${JSON.stringify( name )} ) } ] ).then( () => true )` );
const OUTBOX = `new Promise( function ( res ) { var q = indexedDB.open( 'nube-store' ); q.onsuccess = function () {
    var db = q.result, g = db.transaction( 'outbox' ).objectStore( 'outbox' ).getAll();
    g.onsuccess = function () { db.close(); res( g.result.map( function ( e ) { return e.file || e.path; } ) ); }; }; } )`;
const toasted = text => c.evaluate( `( window.__toasts || [] ).some( function ( t ) { return t.indexOf( ${JSON.stringify( text )} ) !== -1; } )` );

//----------------------------------------------------------------------------//
section( "C1 · OFFLINE, OVER THE COPY THIS BROWSER CACHED" );
{
    await seed( CALF, CAL( VEV( "a", "Old event", "20260901T100000Z" ) ) );
    ok( await drive(), "Drive is up" );
    ok( await c.evaluate( `appStore().read( '${CALF}' ).then( r => r.source === 'network' )` ), "this browser has a copy of the calendar (cached)" );
    await seed( CALF, CAL( VEV( "a", "Old event", "20260901T100000Z" ), VEV( "p", "From the phone", "20261001T100000Z" ) ) );

    await c.send( "Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    await c.until( "! navigator.onLine" );
    await drop( "cena.ics", CAL( VEV( "n", "Dinner", "20261002T100000Z" ) ) );
    const offlineSaid = await c.evaluate( "NayiveUI.t( 'drive.importOffline' )" );
    ok( await c.evaluate( `window.__alerts.some( function ( b ) { return b.indexOf( ${JSON.stringify( offlineSaid )} ) !== -1; } )` ),
        "offline: refused, saying it must read the server's copy", await c.evaluate( "window.__alerts" ) );
    await c.send( "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    await c.until( "navigator.onLine" );
    // (the old way queued it on the old copy: back online, it went up)
    await untilNode( async () => ! ( await c.evaluate( OUTBOX ) ).includes( CALF ), 10000 );
    ok( has( CALF, "SUMMARY:From the phone" ), "back online: the phone's event is still in the calendar", onDisk( s, CALF ) );
}

//----------------------------------------------------------------------------//
section( "C1 · A SAVE MADE ELSEWHERE BETWEEN THE READ AND THE WRITE" );
{
    await seed( CALF, CAL( VEV( "a", "Old event", "20260901T100000Z" ) ) );
    ok( await drive(), "Drive is up" );
    // The import's first PUT: just before it, the phone saves an event.
    const phoneCal = CAL( VEV( "a", "Old event", "20260901T100000Z" ), VEV( "q", "Phone in between", "20261001T100000Z" ) );
    await c.evaluate( `( function () { var f = window.fetch; window.__raced = false; window.__puts = [];
        window.fetch = async function ( u, o ) {
            if( o && o.method === 'PUT' && String( u ).indexOf( 'calendar.ics' ) !== -1 ) {
                if( ! window.__raced ) { window.__raced = true; await f( '/api/files?file=${encodeURIComponent( CALF )}', { method: 'PUT', body: ${JSON.stringify( phoneCal )} } ); }
                var h = o.headers || {}, r = await f.apply( this, arguments );
                window.__puts.push( { im: h[ 'If-Match' ] || null, inm: h[ 'If-None-Match' ] || null, st: r.status } );
                return r;
            }
            return f.apply( this, arguments ); };
        return true; } )()` );
    await drop( "cine.ics", CAL( VEV( "m", "Cinema", "20261002T100000Z" ) ) );
    ok( await untilNode( () => has( CALF, "SUMMARY:Cinema" ) ), "the import is in the calendar", onDisk( s, CALF ) );
    ok( has( CALF, "SUMMARY:Phone in between" ), "...and so is the phone's event saved in between (not written over)", onDisk( s, CALF ) );
    const puts = await c.evaluate( "window.__puts" );
    ok( puts.length && puts[ 0 ].im && puts[ 0 ].st === 412, "its first save carried the version it was made from (If-Match): 412", puts );
}

//----------------------------------------------------------------------------//
section( "C2 · AN OLD EXPORT NEVER TAKES BACK THE EDITS MADE SINCE" );
{
    await seed( CALF, CAL( VEV( "e1", "Edited title", "20261001T120000Z", [ "DESCRIPTION:my notes" ] ) ) );
    ok( await drive(), "Drive is up" );
    await drop( "old-export.ics", CAL( VEV( "e1", "Old title", "20260901T100000Z" ), VEV( "e2", "New one", "20260901T100000Z" ) ) );
    ok( await untilNode( () => has( CALF, "SUMMARY:New one" ) ), "the new event is added" );
    ok( has( CALF, "SUMMARY:Edited title" ) && has( CALF, "DESCRIPTION:my notes" ) && ! has( CALF, "SUMMARY:Old title" ),
        "the event edited since keeps its edits (the dropped copy is older)", onDisk( s, CALF ) );
    ok( await toasted( await c.evaluate( "NayiveUI.tf( 'drive.importKept', { n: 1 } )" ) ), "the toast says one was kept as it was", await c.toasts() );

    await drop( "invite.ics", CAL( VEV( "e1", "Moved by the organiser", "20260901T100000Z", [ "SEQUENCE:1" ] ) ) );
    ok( await untilNode( () => has( CALF, "SUMMARY:Moved by the organiser" ) ), "a NEWER copy (a higher SEQUENCE) does replace it", onDisk( s, CALF ) );

    await seed( CONF, BOOK( VC( "c1", "Ana Edited", "20261001T120000Z" ) ) );
    await drop( "old.vcf", BOOK( VC( "c1", "Ana Old", "20260901T100000Z" ), VC( "c2", "Beto", "20260901T100000Z" ) ) );
    ok( await untilNode( () => has( CONF, "FN:Beto" ) ), "the new card is added" );
    ok( has( CONF, "FN:Ana Edited" ) && ! has( CONF, "FN:Ana Old" ), "the card edited since keeps its edits (older REV dropped)", onDisk( s, CONF ) );
    await drop( "new.vcf", BOOK( VC( "c1", "Ana Newer", "20261101T120000Z" ) ) );
    ok( await untilNode( () => has( CONF, "FN:Ana Newer" ) ), "a card with a NEWER REV does replace it", onDisk( s, CONF ) );
}

//----------------------------------------------------------------------------//
section( "C2 · ITS UNDO" );
{
    await seed( CALF, CAL( VEV( "u1", "Mine", "20261001T120000Z" ), VEV( "u2", "Untouched", "20261001T120000Z" ) ) );
    ok( await drive(), "Drive is up" );
    await c.evaluate( "window.__toasts = []; true" );
    await drop( "u.ics", CAL( VEV( "u1", "Theirs, newer", "20261005T120000Z" ), VEV( "u3", "Added", "20261005T120000Z" ),
                              VEV( "u4", "Added, then edited", "20261005T120000Z" ) ) );
    ok( await untilNode( () => has( CALF, "SUMMARY:Added" ) && has( CALF, "SUMMARY:Theirs, newer" ) ), "imported: one replaced, two added" );
    ok( await c.until( "document.querySelector( '#toast .toast-undo' )", 5000 ), "the toast has an Undo" );
    // Before the Undo, Calendar (the phone) edits one of the added events.
    await seed( CALF, onDisk( s, CALF ).replace( "SUMMARY:Added, then edited", "SUMMARY:Edited after the import" ) );
    await c.evaluate( "( document.querySelector( '#toast .toast-undo' ) || { click: function () {} } ).click(), true" );
    ok( await untilNode( () => ! has( CALF, "SUMMARY:Added\r\n" ) && has( CALF, "SUMMARY:Mine" ) ), "Undo: the added event goes, the replaced one is back",
        onDisk( s, CALF ) );
    ok( has( CALF, "SUMMARY:Edited after the import" ), "...the one edited since the import stays", onDisk( s, CALF ) );
    ok( has( CALF, "SUMMARY:Untouched" ) && ! has( CALF, "SUMMARY:Theirs, newer" ), "...and the rest is as it was" );
}

//----------------------------------------------------------------------------//
section( "K2 · A SAVE KEPT ONLY IN THE PAGE IS NOT \"IMPORTED\"" );
{
    await seed( CALF, CAL( VEV( "a", "Old event", "20260901T100000Z" ) ) );
    ok( await drive(), "Drive is up" );
    await c.evaluate( "appStore().write = function () { return Promise.resolve( { ok: false, pageOnly: true } ); }; window.__toasts = []; true" );
    await drop( "k2.ics", CAL( VEV( "k", "Kept nowhere", "20261002T100000Z" ) ) );
    ok( ( await c.evaluate( "window.__alerts" ) ).length === 1, "it is said as not imported", await c.evaluate( "window.__alerts" ) );
    ok( ! await toasted( await c.evaluate( "NayiveUI.tf( 'drive.imported', { what: '' } ).trim()" ) ), "no \"Imported\" toast", await c.toasts() );
}

await done( c, s );
