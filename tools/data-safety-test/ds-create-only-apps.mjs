// ds-create-only-apps.mjs - an upload that was not told "Replace" only ever
// makes a NEW file (batch C4b): a same-named file another device put there
// after the page looked is never written over.
//
// D3 photos part (drive-files #2, list-apps G22): Photos' album upload checked
//     names against the listing on screen and PUT blind - the phone's photo of
//     that name, uploaded since, was replaced for good. Now: create-only, and a
//     412 asks Replace / Keep both, as Drive does.
// D2 race (list-apps #4): Trips' documents - the folder listing, then the PUT:
//     a file another device put there in between was replaced. Now:
//     create-only, and a 412 takes the next free name.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep, REPO } from "./lib.mjs";

const s = await server();
const phone = await s.client();
const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };
const json = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
async function disk( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}
const PNG = fs.readFileSync( path.join( REPO, "client/apps/icons/icon-192.png" ) );
const tail = rel => { try { return fs.readFileSync( path.join( s.home(), rel ) ).subarray( PNG.length ).toString(); } catch { return null; } };

const c = await browser( s );
await c.evaluate( "['photos','trips'].forEach( a => localStorage.setItem( 'balata-intro-dismiss:' + a, '1' ) ); true" );

//----------------------------------------------------------------------------
section( "D3 · PHOTOS: UPLOAD A PHOTO NAMED LIKE ONE THE PHONE PUT THERE SINCE" );
{
    await seed( "files/F/a.png", Buffer.concat( [ PNG, Buffer.from( "A" ) ] ) );
    ok( await c.open( "/nayive/photos/index.html?dir=files/F" ), "Photos opens on the album" );
    ok( await c.until( "typeof PHOTOS !== 'undefined' && PHOTOS.length === 1 && document.querySelectorAll( '#grid .tile' ).length === 1" ), "one photo listed" );
    await seed( "files/F/new.png", Buffer.concat( [ PNG, Buffer.from( "PHONE" ) ] ) );    // the listing on screen does not know it
    await c.evaluate( `( async () => { const b = await ( await fetch( '../icons/icon-192.png' ) ).arrayBuffer();
        window.__up = 'busy'; handleAddPhotos( [ new File( [ b, 'MINE' ], 'new.png', { type: 'image/png' } ) ] ).then( () => { window.__up = 'done'; }, e => { window.__up = 'error ' + e; } );
        return true; } )()` );
    const SHEET = "document.querySelector( '.sheet-backdrop.open .sheet' )";
    ok( await c.until( SHEET + " && " + SHEET + ".textContent.indexOf( NayiveUI.t( 'drive.alreadyExistOne' ) ) !== -1" ), "the upload asks: the name is taken on the server" );
    ok( tail( "files/F/new.png" ) === "PHONE", "the phone's photo is untouched while it asks" );
    // The sheet's buttons are icons: their words are in the title.
    ok( await c.evaluate( `( () => { const b = [ ...document.querySelectorAll( '.sheet-backdrop.open .sheet-actions button' ) ]
        .find( x => x.title === NayiveUI.t( 'drive.keepBoth' ) ); if( b ) b.click(); return !! b; } )()` ), "Keep both pressed" );
    ok( await c.until( "window.__up === 'done'" ), "Keep both: the upload ends" );
    ok( tail( "files/F/new.png" ) === "PHONE", "the phone's photo is still there" );
    ok( await disk( () => tail( "files/F/new (2).png" ) === "MINE" ), "...and this one went up beside it", fs.readdirSync( path.join( s.home(), "files/F" ) ) );
}

//----------------------------------------------------------------------------
section( "D2 · TRIPS: A DOCUMENT NAMED LIKE ONE ANOTHER DEVICE PUT THERE AFTER THE LISTING" );
{
    const DIR = "data/trips/osaka-race";
    const stage = ( id, location ) => ( { id, location, startDate: "2026-11-02", startTime: "", endDate: "2026-11-03", endTime: "",
        transport: "train", tz: "Asia/Tokyo", tzLabel: "Asia/Tokyo", lat: 34.7, lon: 135.5, accommodation: "", notes: "", enabled: true, documents: [] } );
    await seed( DIR + "/trip.json", JSON.stringify( { id: 9100, destination: "Osaka", dirName: "osaka-race", startDate: "2026-11-01", endDate: "2026-11-10",
        lat: 34.7, lon: 135.5, documents: [], stages: [ stage( 91, "Osaka" ) ] }, null, 2 ) );

    ok( await c.open( "/nayive/trips/" ), "Trips opens" );
    ok( await c.until( "typeof trips !== 'undefined' && trips.some( t => t.id === 9100 )" ), "the trip is listed" );
    await c.evaluate( "goToDetail( 9100 ); openEditStage( 91 ); true" );
    ok( await c.until( "document.getElementById( 'stageSheetBackdrop' ).classList.contains( 'open' )" ), "the stage sheet is open" );

    const TMP = fs.mkdtempSync( path.join( os.tmpdir(), "ds-co-" ) );
    const f = path.join( TMP, "ticket.pdf" );
    fs.writeFileSync( f, "OSAKA" );
    await c.evaluate( "addStageDoc(); [ ...document.querySelectorAll( '#stageSheet .doc-attach-btn' ) ].pop().click(); true" );
    const doc = await c.send( "DOM.getDocument", {} );
    const q   = await c.send( "DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#docUploadInput" } );
    await c.send( "DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [ f ] } );
    ok( await c.until( "stageDraft.documents.some( d => d._pending && d._pending.name === 'ticket.pdf' )" ), "ticket.pdf picked" );

    // The other device's ticket.pdf lands right after the page lists the folder.
    await c.evaluate( `( () => { const f0 = window.fetch; let once = true;
        window.fetch = async function ( u, o ) { const r = await f0.apply( this, arguments );
            try { const url = new URL( String( u ), location.href );
                  if( once && url.searchParams.get( 'dir' ) === ${JSON.stringify( DIR )} ) { once = false;
                      window.__phone = ( await f0( '/api/files?file=' + encodeURIComponent( ${JSON.stringify( DIR + "/ticket.pdf" )} ), { method: 'PUT', body: 'PHONE' } ) ).status; } }
            catch( e ) {}
            return r; }; return true; } )()` );
    await c.evaluate( "saveStage()" );
    ok( await c.until( "window.__phone === 200" ), "the other device put its ticket.pdf there after the listing" );
    ok( await disk( () => ( json( DIR + "/trip.json" ).stages[ 0 ].documents || [] ).some( d => d.file ) ), "the stage is saved with its document" );
    const file = json( DIR + "/trip.json" ).stages[ 0 ].documents[ 0 ].file;
    ok( onDisk( s, DIR + "/ticket.pdf" ) === "PHONE", "the other device's ticket.pdf is untouched", onDisk( s, DIR + "/ticket.pdf" ) );
    ok( file !== "ticket.pdf" && onDisk( s, DIR + "/" + file ) === "OSAKA", "this one got a name of its own, with its own bytes", file );
    fs.rmSync( TMP, { recursive: true, force: true } );
}

await done( c, s );
