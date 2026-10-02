// ds-locker-settings.mjs - the screen-locker settings dialog (Bellas artes /
// Science, shared/lockers/culture-settings.js) never saves a stand-in over
// the user's real settings, nor puts back a field another device changed.
// Real dialog in Chromium (desktop page), a second "device" over HTTP.
//
// F6 (store-core #11, list-apps #27): a read that FAILS (timeout, 5xx, 401 -
//     anything but 404) opens the dialog read-only, ✓ off; ✓ re-reads the
//     file and writes only the fields this dialog changed; a failed re-read
//     writes nothing and keeps the dialog open.
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";

const s = await server();
const SALON = "data/salon.json", SCI = "data/science.json";
const seed = ( rel, body ) => { const f = path.join( s.home(), rel ); fs.mkdirSync( path.dirname( f ), { recursive: true } ); fs.writeFileSync( f, body ); };
const json = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
seed( SALON, JSON.stringify( { langs: [ "es", "en" ], units: "f", size: "l" } ) );
const before = onDisk( s, SALON );

const c = await browser( s );
const phone = await s.client();

ok( await c.open( "/nayive/desktop/index.html" ), "desktop page opens" );
ok( await c.until( "typeof NayiveUI !== 'undefined' && typeof NayiveLock !== 'undefined' && typeof NayiveI18n !== 'undefined'" ), "ready" );
// The lockers' scripts, as the desktop's ⋮ menu loads them; a switch that
// makes the server's answer to one settings file a 503 (window.__failRead);
// and a count of the page's PUTs (window.__puts), so the disk is read only
// once every write a press started has landed.
ok( await c.evaluate( `( async () => {
    const load = src => new Promise( ( ok, no ) => { const sc = document.createElement( 'script' ); sc.src = src; sc.onload = ok; sc.onerror = no; document.head.appendChild( sc ); } );
    await load( '../shared/lockers/culture.js' ); await load( '../shared/lockers/science.js' ); await load( '../shared/lockers/culture-settings.js' );
    window.__failRead = ''; window.__puts = { on: 0, off: 0 }; const f = window.fetch;
    window.fetch = function ( u, o ) {
        const get = ! o || ! o.method || o.method === 'GET';
        if( get && window.__failRead && String( u ).indexOf( encodeURIComponent( 'data/' + window.__failRead ) ) !== -1 )
            return Promise.resolve( new Response( 'busy', { status: 503 } ) );
        if( o && o.method === 'PUT' ) { window.__puts.on++; return f.apply( this, arguments ).finally( () => { window.__puts.off++; } ); }
        return f.apply( this, arguments ); };
    return !! window.NayiveSalonSettings; } )()` ), "locker scripts loaded" );
const SETTLED = "window.__puts.on === window.__puts.off";

const SAVE  = "document.querySelector( '#salonSettings .sheet-actions .btn-primary' )";
const OPEN  = "!! document.querySelector( '#salonSettings.open' )";
const DRAWN = "!! document.querySelector( '#salonSettings .salon-pane .salon-row' )";
const close = () => c.evaluate( "( () => { const b = [ ...document.querySelectorAll( '#salonSettings .sheet-actions button' ) ].find( x => x._nayiveClose ); if( b ) b.click(); return true; } )()" );
const setField = ( key, value ) => c.evaluate( `( () => {
    const f = [ ...document.querySelectorAll( '#salonSettings .field' ) ].find( x => x.querySelector( 'label' ) && x.querySelector( 'label' ).textContent === NayiveI18n.t( ${JSON.stringify( key )} ) );
    const sel = f.querySelector( 'select' ); sel.value = ${JSON.stringify( value )}; sel.dispatchEvent( new Event( 'change' ) ); return true; } )()` );
const readFailShown = "document.querySelector( '#salonSettings' ).textContent.indexOf( NayiveI18n.t( 'salon.readFail' ) ) !== -1";

//----------------------------------------------------------------------------
section( "F6 - a failed read opens the dialog read-only" );

await c.evaluate( "window.__failRead = 'salon.json'; NayiveSalonSettings.open(); true" );
ok( await c.until( DRAWN ), "dialog drawn" );
ok( await c.evaluate( SAVE + ".disabled" ) === true, "✓ is off: the stand-in can't be saved" );
ok( await c.evaluate( readFailShown ), "it says the settings could not be read" );
ok( await c.evaluate( "[ ...document.querySelectorAll( '#salonSettings .salon-pane select, #salonSettings .salon-pane input' ) ].every( x => x.disabled )" ),
    "every control is read-only" );
await c.evaluate( SAVE + ".click(); true" );
ok( await c.until( SETTLED ), "every write that press started has landed" );
ok( await c.evaluate( OPEN ), "✓ pressed anyway: nothing happens" );
ok( onDisk( s, SALON ) === before, "the real settings are untouched" );
await close();
ok( await c.until( "! document.querySelector( '#salonSettings' )" ), "closed" );

// Science, never saved (404): it starts from Bellas artes' part - read as
// strictly - so a failing salon.json makes it read-only too.
await c.evaluate( "window.__failRead = 'salon.json'; NayiveSalonSettings.open( 'science' ); true" );
ok( await c.until( DRAWN ), "Science dialog drawn" );
ok( await c.evaluate( SAVE + ".disabled" ) === true && await c.evaluate( readFailShown ), "Science: read-only too (its 404 falls back on a FAILED salon read)" );
await c.evaluate( SAVE + ".click(); true" );
ok( await c.until( SETTLED ), "every write that press started has landed" );
ok( json( SCI ) === null, "Science: nothing written" );
await close();
ok( await c.until( "! document.querySelector( '#salonSettings' )" ), "closed" );

//----------------------------------------------------------------------------
section( "F6 - ✓ writes only what the dialog changed" );

await c.evaluate( "window.__failRead = ''; NayiveSalonSettings.open(); true" );
ok( await c.until( DRAWN ), "dialog drawn (a good read)" );
ok( await c.evaluate( SAVE + ".disabled" ) === false, "✓ is on" );
// Meanwhile the phone changes the units.
ok( ( await phone.put( SALON, JSON.stringify( { langs: [ "es", "en" ], units: "c", size: "l" } ) ) ).status === 200, "the phone sets °C" );
await setField( "salon.contrast", "high" );
await c.evaluate( SAVE + ".click(); true" );
ok( await c.until( "! document.querySelector( '#salonSettings' )" ), "✓: saved and closed" );
let st = json( SALON );
ok( st && st.contrast === "high", "this dialog's change is saved", st );
ok( st && st.units === "c" && st.size === "l" && st.langs.join() === "es,en", "the phone's °C is not put back", st );

//----------------------------------------------------------------------------
section( "F6 - a failed re-read at ✓ writes nothing" );

await c.evaluate( "NayiveSalonSettings.open(); true" );
ok( await c.until( DRAWN ), "dialog drawn" );
await setField( "salon.contrast", "normal" );
const kept = onDisk( s, SALON );
await c.evaluate( "window.__failRead = 'salon.json'; window.__toasts = []; " + SAVE + ".click(); true" );
ok( await c.until( "( window.__toasts || [] ).some( x => x.indexOf( NayiveI18n.t( 'salon.readFail' ) ) !== -1 ) || ! document.querySelector( '#salonSettings' )" ),
    "✓ answered" );
ok( await c.until( SETTLED ), "every write that press started has landed" );
ok( await c.evaluate( OPEN ) && await c.evaluate( SAVE + ".disabled" ) === false, "the dialog stays open, ✓ on again" );
ok( onDisk( s, SALON ) === kept, "nothing was written" );
await c.evaluate( "window.__failRead = ''; " + SAVE + ".click(); true" );
ok( await c.until( "! document.querySelector( '#salonSettings' )" ), "✓ again, with the server back: saved" );
st = json( SALON );
ok( st && st.contrast === "normal" && st.units === "c", "saved over the fresh copy", st );

await done( c, s );
