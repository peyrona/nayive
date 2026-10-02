// ds-drive-sendto.mjs - what other apps send into the user's folders never
// replaces a file there (batch C3a).
//
// D4 (drive-files #12): photos shared from the phone while the album's
//     listing failed went up under their own names over the album's.
// D7 (list-apps #24): a new trip named like one another device made since
//     this page loaded replaced that trip's trip.json.
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";

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
const c = await browser( s );

//------------------------------------------------------------------------//
section( "D4 · SHARE TO NAYIVE WHILE THE ALBUM CANNOT BE READ" );
{
    await seed( "files/Album/IMG_1.jpg", "THE ALBUM'S PHOTO" );
    await seed( "data/photos/config.json", JSON.stringify( { folder: "files/Album" } ) );
    const PAGE = "/nayive/share-target/index.html";
    await c.open( PAGE, PAGE );
    // What the service worker leaves in the inbox when the gallery shares one photo.
    ok( await c.evaluate( `( async () => { const cache = await caches.open( 'nayive-share-inbox' );
        await cache.put( new URL( 'inbox/manifest.json', location.href ).toString(),
                         new Response( JSON.stringify( { count: 1, names: [ 'IMG_1.jpg' ] } ), { headers: { 'Content-Type': 'application/json' } } ) );
        await cache.put( new URL( 'inbox/0', location.href ).toString(), new Response( new Blob( [ 'THE SHARED PHOTO' ], { type: 'image/jpeg' } ) ) );
        return true; } )()` ), "one photo waits in the inbox" );
    await c.open( PAGE + "?n=1", PAGE );
    ok( await c.until( "ITEMS.length === 1 && DEST === 'files/Album' && ! document.getElementById('goBtn').disabled" ), "the page shows it, album chosen" );

    // The listing fails (a 5xx, a hiccup); the PUTs would work.
    await c.evaluate( `GumApi.listDir = function() { const e = new Error( 'HTTP 502: Bad Gateway' ); e.status = 502; return Promise.reject( e ); }; true` );
    await c.evaluate( "document.getElementById('goBtn').click(); true" );
    ok( await c.until( "document.querySelector( '.sheet-backdrop.open .dialog-text' )" ), "it says so" );
    const said = await c.evaluate( "( document.querySelector( '.sheet-backdrop.open .dialog-text' ) || {} ).textContent || ''" );
    ok( said.includes( await c.evaluate( "NayiveUI.t( 'st.albumUnread' )" ) ), "...that the album could not be read and nothing was sent", said );
    ok( onDisk( s, "files/Album/IMG_1.jpg" ) === "THE ALBUM'S PHOTO", "the album's photo is untouched", onDisk( s, "files/Album/IMG_1.jpg" ) );
    ok( await c.evaluate( "( async () => !! await ( await caches.open( 'nayive-share-inbox' ) ).match( new URL( 'inbox/0', location.href ).toString() ) )()" ),
        "the shared photo is still in the inbox, to try again" );
    await c.evaluate( "document.querySelector( '.sheet-backdrop.open .sheet-close' )?.click(); true" );

    // Again, with a listing that does not know the name yet (another device
    // put it there after the look): create-only gets a 412 -> the next free name.
    await c.evaluate( `GumApi.listDir = function() { return Promise.resolve( { nodes: [] } ); }; true` );
    await c.until( "! document.getElementById('goBtn').disabled" );
    await c.evaluate( "document.getElementById('goBtn')?.click(); true" );
    ok( await disk( () => onDisk( s, "files/Album/IMG_1 (2).jpg" ) === "THE SHARED PHOTO" ), "the shared photo goes up under the next free name",
        onDisk( s, "files/Album/IMG_1 (2).jpg" ) );
    ok( onDisk( s, "files/Album/IMG_1.jpg" ) === "THE ALBUM'S PHOTO", "the album's photo is untouched" );
}

//------------------------------------------------------------------------//
section( "D7 · A NEW TRIP NAMED LIKE ONE ANOTHER DEVICE MADE" );
{
    const trip = ( id, dirName, destination ) => JSON.stringify( { id, destination, dirName, startDate: "2026-11-01", endDate: "2026-11-10",
        lat: 41.9, lon: 12.5, documents: [], stages: [] }, null, 2 );
    await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:trips', '1' ); true" );
    await c.send( "Page.navigate", { url: "about:blank" } );
    await c.until( "location.href === 'about:blank'" );
    await c.open( "/nayive/trips/", "/nayive/trips/" );
    ok( await c.until( "typeof trips !== 'undefined' && typeof saveTrip === 'function' && document.getElementById('syncIndicator')" ), "Trips is open, no trips" );

    // Made on the phone after this page loaded.
    await seed( "data/trips/japan-2026/trip.json", trip( 9000, "japan-2026", "Japan (phone)" ) );
    const create = ( dest, before = "" ) => c.evaluate( `( async () => { ${before}
        openAddTrip(); tripDraft.destination = ${JSON.stringify( dest )}; tripDraft.startDate = '2026-11-01'; tripDraft.endDate = '2026-11-10';
        await saveTrip(); return tripSaveError; } )()` );

    ok( await create( "Japan" ) === "", "a new trip \"Japan\" is saved" );
    ok( await disk( () => json( "data/trips/japan-2026-2/trip.json" )?.destination === "Japan" ), "it gets a folder of its own",
        onDisk( s, "data/trips/japan-2026-2/trip.json" ) );
    ok( json( "data/trips/japan-2026/trip.json" )?.destination === "Japan (phone)", "the phone's trip is untouched",
        onDisk( s, "data/trips/japan-2026/trip.json" ) );

    // The name taken after the listing (a stale one here): trip.json is made
    // create-only, the 412 moves on to the next name.
    await seed( "data/trips/peru-2026/trip.json", trip( 9100, "peru-2026", "Peru (phone)" ) );
    const stale = "const real = GumApi.listDir; GumApi.listDir = function( p ) { return p === 'data/trips' ? Promise.resolve( { nodes: [] } ) : real( p ); };";
    ok( await create( "Peru", stale ) === "", "a new trip \"Peru\" is saved" );
    ok( await disk( () => json( "data/trips/peru-2026-2/trip.json" )?.destination === "Peru" ), "it gets the next free folder",
        onDisk( s, "data/trips/peru-2026-2/trip.json" ) );
    ok( json( "data/trips/peru-2026/trip.json" )?.destination === "Peru (phone)", "the phone's trip is untouched" );

    // data/trips cannot be read: the trip is not made (nothing is guessed).
    const broken = "GumApi.listDir = function() { const e = new Error( 'HTTP 502: Bad Gateway' ); e.status = 502; return Promise.reject( e ); };";
    const err = await create( "Chile", broken );
    ok( err === await c.evaluate( "T( 'trips.createFailed' )" ), "a failed listing: \"could not create\"", err );
    ok( onDisk( s, "data/trips/chile-2026/trip.json" ) === null, "...and nothing was written" );

    // A document upload fails after the folder was claimed: the retry keeps
    // that folder - the trip is not made twice.
    await c.evaluate( "location.reload(); true" );
    await c.until( "document.readyState !== 'complete'", 3000 );
    ok( await c.until( "typeof trips !== 'undefined' && trips.length === 4 && typeof saveTrip === 'function'" ), "Trips reloaded (4 trips)" );
    const failOnce = "const realSync = syncDocFiles; window.syncDocFiles = async function() { window.syncDocFiles = realSync; throw new Error( 'upload failed' ); };";
    ok( await create( "Cuba", failOnce ) === await c.evaluate( "T( 'trips.createFailed' )" ), "the first save fails (an upload)" );
    ok( await c.evaluate( "( async () => { await saveTrip(); return tripSaveError; } )()" ) === "", "the retry saves" );
    ok( await disk( () => json( "data/trips/cuba-2026/trip.json" )?.destination === "Cuba" ), "in the folder the first try claimed" );
    ok( onDisk( s, "data/trips/cuba-2026-2/trip.json" ) === null, "no second Cuba trip" );
    ok( await c.evaluate( "trips.filter( function( t ) { return t.destination === 'Cuba'; } ).length" ) === 1, "one Cuba in the list" );
}

await done( c, s );
