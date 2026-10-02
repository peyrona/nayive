// ds-listapps-trips.mjs - Trips: every write goes to the trip's own folder, a
// merge under an open stage sheet bins nothing, and two documents never share
// one file. The real app in Chromium; a second "device" over plain HTTP.
//
// H7 (list-apps #23): a trip folder restored from the bin as "<dir> (restaurado
//     …)" still says the old dirName inside: deleting it binned the OTHER trip.
// H6 (list-apps #22): a merge lands while the stage sheet is open: Save kept
//     the stale draft, dropped the other device's document and binned its file.
// D2 (list-apps #4): two stages' "ticket.pdf" became one file; an upload over
//     a file already in the folder replaced it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";

const s = await server();
const c = await browser( s );
const phone = await s.client();
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:trips', '1' ); true" );

const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };
const json = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
async function disk( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}
async function reopen( p, want )
{
    await c.send( "Page.navigate", { url: "about:blank" } );
    await c.until( "location.href === 'about:blank'" );
    return c.open( p, want );
}
async function setFile( selector, file )
{
    const doc = await c.send( "DOM.getDocument", {} );
    const q   = await c.send( "DOM.querySelector", { nodeId: doc.result.root.nodeId, selector } );
    await c.send( "DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [ file ] } );
}
const TMP = fs.mkdtempSync( path.join( os.tmpdir(), "ds-trips-" ) );
// Stages and trips with their place and zone known: no lookups, no automatic saves.
const stage = ( id, location, extra = {} ) => ( { id, location, startDate: "2026-11-02", startTime: "", endDate: "2026-11-03", endTime: "",
    transport: "train", tz: "Europe/Rome", tzLabel: "Europe/Rome", lat: 41.9, lon: 12.5, accommodation: "", notes: "", enabled: true, documents: [], ...extra } );
const trip = ( id, dirName, destination, extra = {} ) => JSON.stringify( { id, destination, dirName, startDate: "2026-11-01", endDate: "2026-11-10",
    lat: 41.9, lon: 12.5, documents: [], stages: [], ...extra }, null, 2 );

//------------------------------------------------------------------------//
section( "H7 · A TRIP RESTORED AS \"(restaurado …)\" WITH THE OTHER'S NAME AND ID INSIDE" );
{
    const ORIG = "data/trips/japan-2026", REST = "data/trips/japan-2026 (restaurado 2026-10-02 10-00-00)";
    const doc  = { id: 1, name: "pass", type: "passport", kind: "upload", file: "pass.pdf" };
    await seed( ORIG + "/trip.json", trip( 5000, "japan-2026", "Japan", { documents: [ doc ] } ) );
    await seed( ORIG + "/pass.pdf", "ORIGINAL" );
    await seed( REST + "/trip.json", trip( 5000, "japan-2026", "Japan (old)", { documents: [ doc ] } ) );
    await seed( REST + "/pass.pdf", "RESTORED" );

    await reopen( "/nayive/trips/" );
    ok( await c.until( "typeof trips !== 'undefined' && trips.length === 2" ), "both trips listed" );
    const info = await c.evaluate( "trips.map( t => ( { base: t._base, id: t.id, dir: t.dirName } ) )" );
    const r = info.find( t => t.base === REST ), o = info.find( t => t.base === ORIG );
    ok( r && o && r.id !== o.id, "each has its own id", info );
    ok( r && r.dir === "japan-2026 (restaurado 2026-10-02 10-00-00)", "the restored one's folder name is its own", r );
    ok( await disk( () => json( REST + "/trip.json" ).id !== 5000 && json( ORIG + "/trip.json" ).id === 5000 ), "the new id is saved; the original keeps its own" );

    await c.evaluate( `( () => { const t = trips.find( x => x._base === ${JSON.stringify( REST )} ); selectedTripId = t.id; view = 'detail'; return deleteTrip(); } )()` );
    ok( await disk( () => onDisk( s, REST + "/trip.json" ) === null ), "Delete trip on the restored one: its folder goes to the bin" );
    ok( onDisk( s, ORIG + "/trip.json" ) !== null && onDisk( s, ORIG + "/pass.pdf" ) === "ORIGINAL", "...and the other trip is untouched" );
}

//------------------------------------------------------------------------//
section( "H6 · A MERGE LANDS WHILE THE STAGE SHEET IS OPEN" );
{
    const F = "data/trips/italy-2026/trip.json";
    await seed( F, trip( 7000, "italy-2026", "Italy", { stages: [ stage( 71, "Roma" ), stage( 72, "Firenze" ) ] } ) );
    await reopen( "/nayive/trips/" );
    ok( await c.until( "typeof trips !== 'undefined' && trips.some( t => t.id === 7000 )" ), "the trip is listed" );
    await c.evaluate( "goToDetail( 7000 ); true" );

    // This device, offline: a change waits in the outbox; then the Roma sheet is opened.
    await c.send( "Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    await c.until( "! navigator.onLine" );
    await c.evaluate( "toggleStage( 72 ); true" );
    await c.evaluate( "openEditStage( 71 ); true" );
    ok( await c.until( "document.getElementById( 'stageSheetBackdrop' ).classList.contains( 'open' )" ), "the Roma sheet is open" );

    // The phone uploads a ticket to Roma and sets its hotel.
    await seed( "data/trips/italy-2026/b.pdf", "PHONE-TICKET" );
    const r = await phone.get( F );
    const t = JSON.parse( r.text );
    t.stages[ 0 ].documents.push( { id: 900, name: "b", type: "ticket", kind: "upload", file: "b.pdf" } );
    t.stages[ 0 ].accommodation = "Hotel Phone";
    ok( ( await phone.put( F, JSON.stringify( t, null, 2 ), { "If-Unmodified-Since": r.headers.get( "last-modified" ) } ) ).status === 200, "the phone adds a ticket and a hotel to Roma" );

    // Back online: the waiting save meets the phone's (412 -> merge) under the open sheet.
    await c.send( "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    ok( await disk( () => { const d = json( F ); return d.stages[ 1 ].enabled === false && d.stages[ 0 ].documents.some( x => x.id === 900 ); } ), "the merge landed" );

    await c.evaluate( "stageDraft.notes = 'pc note'; true" );   // typed in the sheet
    await c.evaluate( "saveStage()" );
    ok( await disk( () => json( F ).stages[ 0 ].notes === "pc note" ), "Save: the note is saved" );
    const roma = json( F ).stages[ 0 ];
    ok( roma.documents.some( x => x.id === 900 ) && roma.accommodation === "Hotel Phone", "...and the phone's ticket and hotel are kept", roma );
    ok( onDisk( s, "data/trips/italy-2026/b.pdf" ) === "PHONE-TICKET", "...and its file was not binned" );
    ok( json( F ).stages[ 1 ].enabled === false, "...and the change that waited offline is kept" );
}

section( "H6 · ...AND WHILE THE TRIP SHEET IS OPEN, ITS DOCUMENT LIST TOUCHED" );
{
    const DIR = "data/trips/peru-2026", F = DIR + "/trip.json";
    await seed( F, trip( 9000, "peru-2026", "Peru", { stages: [ stage( 91, "Cusco" ) ],
        documents: [ { id: 11, name: "p1", type: "passport", kind: "upload", file: "p1.pdf" } ] } ) );
    await seed( DIR + "/p1.pdf", "P1" );
    await reopen( "/nayive/trips/" );
    ok( await c.until( "typeof trips !== 'undefined' && trips.some( t => t.id === 9000 )" ), "the trip is listed" );
    await c.evaluate( "goToDetail( 9000 ); true" );

    await c.send( "Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    await c.until( "! navigator.onLine" );
    await c.evaluate( "toggleStage( 91 ); openEditTrip(); removeTripDoc( 11 ); true" );   // a change waits; the sheet drops p1
    ok( await c.until( "document.getElementById( 'tripSheetBackdrop' ).classList.contains( 'open' )" ), "the trip sheet is open, p1 removed in it" );

    await seed( DIR + "/ph.pdf", "PHONE-DOC" );
    const r = await phone.get( F );
    const t = JSON.parse( r.text );
    t.documents.push( { id: 12, name: "ph", type: "visa", kind: "upload", file: "ph.pdf" } );
    ok( ( await phone.put( F, JSON.stringify( t, null, 2 ), { "If-Unmodified-Since": r.headers.get( "last-modified" ) } ) ).status === 200, "the phone adds a document to the trip" );

    await c.send( "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    ok( await disk( () => { const d = json( F ); return d.stages[ 0 ].enabled === false && d.documents.some( x => x.id === 12 ); } ), "the merge landed" );

    await c.evaluate( "saveTrip()" );
    ok( await disk( () => onDisk( s, DIR + "/p1.pdf" ) === null ), "Save: the document removed in the sheet goes (to the bin)" );
    ok( await disk( () => JSON.stringify( json( F ).documents.map( d => d.id ) ) === "[12]" ), "...the phone's document stays in the list", json( F ).documents );
    ok( onDisk( s, DIR + "/ph.pdf" ) === "PHONE-DOC", "...and its file was not binned" );
}

//------------------------------------------------------------------------//
section( "D2 · TWO STAGES' \"ticket.pdf\", AND A FILE ALREADY IN THE FOLDER" );
{
    const DIR = "data/trips/japan-d2";
    await seed( DIR + "/trip.json", trip( 8000, "japan-d2", "Japan", { stages: [
        stage( 81, "Tokyo", { documents: [ { id: 811, name: "ticket", type: "ticket", kind: "upload", file: "ticket.pdf" } ] } ),
        stage( 82, "Kyoto" ) ] } ) );
    await seed( DIR + "/ticket.pdf", "TOKYO" );
    await seed( DIR + "/boarding.pdf", "STRAY" );   // in the folder, in no list here (another device's upload)

    await reopen( "/nayive/trips/" );
    ok( await c.until( "typeof trips !== 'undefined' && trips.some( t => t.id === 8000 )" ), "the trip is listed" );
    await c.evaluate( "goToDetail( 8000 ); openEditStage( 82 ); true" );
    ok( await c.until( "document.getElementById( 'stageSheetBackdrop' ).classList.contains( 'open' )" ), "the Kyoto sheet is open" );

    for( const [ name, body ] of [ [ "ticket.pdf", "KYOTO" ], [ "boarding.pdf", "KYOTO-BOARDING" ] ] )
    {
        const f = path.join( TMP, name );
        fs.writeFileSync( f, body );
        await c.evaluate( "addStageDoc(); [ ...document.querySelectorAll( '#stageSheet .doc-attach-btn' ) ].pop().click(); true" );
        await setFile( "#docUploadInput", f );
        await c.until( `stageDraft.documents.some( d => d._pending && d._pending.name === ${JSON.stringify( name )} )` );
    }
    await c.evaluate( "saveStage()" );
    ok( await disk( () => ( json( DIR + "/trip.json" ).stages[ 1 ].documents || [] ).length === 2 ), "Kyoto saved with two documents" );

    const files = json( DIR + "/trip.json" ).stages[ 1 ].documents.map( d => d.file );
    ok( onDisk( s, DIR + "/ticket.pdf" ) === "TOKYO", "Tokyo's ticket.pdf is untouched", onDisk( s, DIR + "/ticket.pdf" ) );
    ok( onDisk( s, DIR + "/boarding.pdf" ) === "STRAY", "the file already in the folder is untouched" );
    ok( ! files.includes( "ticket.pdf" ) && ! files.includes( "boarding.pdf" ), "Kyoto's two got names of their own", files );
    ok( files.map( f => onDisk( s, DIR + "/" + f ) ).sort().join( "," ) === "KYOTO,KYOTO-BOARDING", "...holding Kyoto's own bytes" );
}

fs.rmSync( TMP, { recursive: true, force: true } );
await done( c, s );
