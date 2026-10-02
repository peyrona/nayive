// ds-versioned-settings.mjs - small settings files are written only over the
// version just read (batch C4b): another window's or device's save between a
// page's read and its write is kept, never written over. Each case makes that
// race happen every time (race.mjs); the old code wrote blind and dropped it.
//
// A5 (office #8): Write's "Add to dictionary" (data/write/dict.json).
// F6 write half (store-core #11, list-apps #27): the screen-locker settings
//     dialog's ✓ (data/salon.json).
// share-target: "remember this album" (data/photos/config.json).
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";
import { installRace, arm, raced } from "./race.mjs";

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
const add = ( obj ) => `t => JSON.stringify( Object.assign( JSON.parse( t ), ${JSON.stringify( obj )} ) )`;

const DICT = "data/write/dict.json", SALON = "data/salon.json", CFG = "data/photos/config.json";
await seed( DICT, JSON.stringify( { words: [ "Uno" ] } ) );
await seed( SALON, JSON.stringify( { langs: [ "es", "en" ], units: "f", size: "l" } ) );
await seed( "files/Album/IMG_1.jpg", "THE ALBUM'S PHOTO" );
await seed( CFG, JSON.stringify( { folder: "files/Album" } ) );

const c = await browser( s, { width: 1280, height: 900 } );

//----------------------------------------------------------------------------
section( "F6 · LOCKER SETTINGS: THE PHONE SAVES BETWEEN ✓'S READ AND ITS WRITE" );
{
    ok( await c.open( "/nayive/desktop/index.html" ), "desktop page opens" );
    ok( await c.until( "typeof NayiveUI !== 'undefined' && typeof NayiveLock !== 'undefined' && typeof NayiveI18n !== 'undefined'" ), "ready" );
    ok( await c.evaluate( `( async () => {
        const load = src => new Promise( ( ok, no ) => { const sc = document.createElement( 'script' ); sc.src = src; sc.onload = ok; sc.onerror = no; document.head.appendChild( sc ); } );
        await load( '../shared/lockers/culture.js' ); await load( '../shared/lockers/science.js' ); await load( '../shared/lockers/culture-settings.js' );
        return !! window.NayiveSalonSettings; } )()` ), "locker scripts loaded" );
    await installRace( c );
    await c.evaluate( "NayiveSalonSettings.open(); true" );
    ok( await c.until( "!! document.querySelector( '#salonSettings .salon-pane .salon-row' )" ), "dialog drawn (a good read)" );
    await c.evaluate( `( () => {
        const f = [ ...document.querySelectorAll( '#salonSettings .field' ) ].find( x => x.querySelector( 'label' ) && x.querySelector( 'label' ).textContent === NayiveI18n.t( 'salon.contrast' ) );
        const sel = f.querySelector( 'select' ); sel.value = 'high'; sel.dispatchEvent( new Event( 'change' ) ); return true; } )()` );
    await arm( c, SALON, add( { units: "c" } ) );
    await c.evaluate( "document.querySelector( '#salonSettings .sheet-actions .btn-primary' ).click(); true" );
    ok( await raced( c ), "the phone set °C in between" );
    ok( await c.until( "! document.querySelector( '#salonSettings' )" ), "✓: saved and closed" );
    const st = json( SALON );
    ok( st && st.contrast === "high", "this dialog's change is saved", st );
    ok( st && st.units === "c" && st.size === "l", "...and the phone's °C is not put back", st );
}

//----------------------------------------------------------------------------
section( "SHARE TO NAYIVE: \"REMEMBER THIS ALBUM\" KEEPS A SETTING SAVED IN BETWEEN" );
{
    const PAGE = "/nayive/share-target/index.html";
    await c.open( PAGE, PAGE );
    ok( await c.evaluate( `( async () => { const cache = await caches.open( 'nayive-share-inbox' );
        await cache.put( new URL( 'inbox/manifest.json', location.href ).toString(),
                         new Response( JSON.stringify( { count: 1, names: [ 'IMG_2.jpg' ] } ), { headers: { 'Content-Type': 'application/json' } } ) );
        await cache.put( new URL( 'inbox/0', location.href ).toString(), new Response( new Blob( [ 'THE SHARED PHOTO' ], { type: 'image/jpeg' } ) ) );
        return true; } )()` ), "one photo waits in the inbox" );
    await c.open( PAGE + "?n=1", PAGE );
    ok( await c.until( "ITEMS.length === 1 && DEST === 'files/Album' && ! document.getElementById('goBtn').disabled" ), "the page shows it, album chosen" );
    await installRace( c );
    await arm( c, CFG, add( { sort: "phone's" } ) );
    await c.evaluate( "document.getElementById('goBtn').click(); true" );
    ok( await disk( () => onDisk( s, "files/Album/IMG_2.jpg" ) === "THE SHARED PHOTO" ), "the photo went up" );
    ok( await disk( () => ( json( CFG ) || {} ).sort === "phone's" && json( CFG ).folder === "files/Album", 8000 ),
        "the album is remembered, and the setting saved in between is kept", json( CFG ) );
    // Then the page goes on to Photos by itself: let it, before the next case opens a page.
    ok( await c.until( "location.pathname.indexOf( '/photos/' ) !== -1 && document.readyState === 'complete'" ), "...and goes on to Photos" );
}

//----------------------------------------------------------------------------
// Last: Write keeps the page from being left (its typed text).
section( "A5 · WRITE: A WORD ADDED IN ANOTHER WINDOW BETWEEN THE READ AND THE WRITE" );
{
    const WORD = "Xqzwvbkt";
    await c.open( "/nayive/write/?new=1", "/nayive/write/" );
    ok( await c.until( "document.getElementById('editor').classList.contains('is-ready') && document.querySelector('.docx-page')", 30000 ), "Write is up with a blank document" );
    await installRace( c );

    // A word the spell check flags, typed into the page.
    const page = await c.evaluate( "( function () { var r = document.querySelector('.docx-page').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 120 }; } )()" );
    for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] )
        await c.send( "Input.dispatchMouseEvent", { type, x: page.x, y: page.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } );
    await c.send( "Input.insertText", { text: WORD + " " } );
    ok( await c.until( "document.querySelector('.spell-squiggle')", 30000 ), "the spell check flags it" );

    const at = await c.evaluate( "( function () { var r = document.querySelector('.spell-squiggle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top - 4 }; } )()" );
    await c.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y } );
    await c.send( "Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "right", buttons: 2, clickCount: 1 } );
    await c.send( "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "right", buttons: 0, clickCount: 1 } );
    const addText = await c.evaluate( `NayiveUI.tf( 'write.addToDict', { word: ${JSON.stringify( WORD )} } )` );
    const ITEM = `Array.prototype.find.call( document.querySelectorAll( 'button.menu-item' ), function ( e ) { return e.offsetParent && e.textContent.indexOf( ${JSON.stringify( addText )} ) !== -1; } )`;
    ok( await c.until( ITEM, 10000 ), "its menu offers \"" + addText + "\"" );

    // The other window adds "Nayive" right after this one reads the list.
    await arm( c, DICT, "t => { const d = JSON.parse( t ); d.words.push( 'Nayive' ); return JSON.stringify( d ); }" );
    await c.evaluate( `${ITEM}.click(), true` );
    ok( await raced( c ), "another window added a word in between" );
    ok( await disk( () => ( json( DICT ) || { words: [] } ).words.includes( WORD ) ), "the word is in the dictionary", json( DICT ) );
    const w = ( json( DICT ) || { words: [] } ).words;
    ok( w.includes( "Nayive" ) && w.includes( "Uno" ), "...and the other window's word is still there", w );
}

await done( c, s );
