// run.mjs - Calculator (client/apps/calculator) and its rates (shared/fx.js), in a
// real browser on a phone-sized screen:
//
//   node tools/calculator-test/run.mjs
//
// The arithmetic, the keypad, the history, the currency mode with the three rate
// sources answered by fixed rates (no network): the cross-check protocol, offline
// with kept rates and with none, the narrow layout, the interface language's
// number format - and Trips' converter button landing in Calculator. Scratch
// server; the real store/ is never touched.
import { server, browser, ok, section, done, seed } from "../browser-test/lib.mjs";

// The three sources' answers (1 EUR = …). USD and JPY agree on the 1st pair; GBP
// only on the 2nd (Frankfurter is off); ARS is not in Frankfurter; BRL never
// agrees, so it has no rate.
const SOURCES = [
    [ "frankfurter", { date: "2026-10-27", rates: { USD: 1.08, JPY: 160, GBP: 0.80, CHF: 0.95, BRL: 6 } } ],
    [ "er-api", { result: "success", time_last_update_utc: "Tue, 27 Oct 2026 00:02:31 +0000",
                  rates: { EUR: 1, USD: 1.08, JPY: 160.2, GBP: 0.85, CHF: 0.95, ARS: 1000, BRL: 7 } } ],
    [ "currency-api", { date: "2026-10-27", eur: { eur: 1, usd: 1.08, gbp: 0.851, ars: 1001, brl: 8 } } ]
];
// Before any page script: the rate services answer from SOURCES, or fail while
// localStorage 'test-fx-offline' is set. Every other request goes through.
const STUB = `( () => {
    const FIX = ${JSON.stringify( SOURCES )}, real = window.fetch;
    window.fetch = function( u ) {
        const s = String( u && u.url || u );
        for( const [ k, json ] of FIX ) if( s.includes( k ) ) {
            if( localStorage.getItem( 'test-fx-offline' ) ) return Promise.reject( new TypeError( 'offline' ) );
            return Promise.resolve( new Response( JSON.stringify( json ), { status: 200, headers: { 'Content-Type': 'application/json' } } ) );
        }
        return real.apply( this, arguments );
    };
} )();`;

const s = await server();
seed( s, { "data/trips/osaka/trip.json": JSON.stringify( { id: 9100, destination: "Osaka", dirName: "osaka", startDate: "2026-11-01", endDate: "2026-11-10",
    lat: 34.7, lon: 135.5, documents: [], stages: [ { id: 91, location: "Osaka", startDate: "2026-11-02", startTime: "", endDate: "2026-11-03", endTime: "",
    transport: "train", tz: "Asia/Tokyo", tzLabel: "Asia/Tokyo", lat: 34.7, lon: 135.5, accommodation: "", notes: "", enabled: true, documents: [] } ] } ) } );

const c = await browser( s, { width: 390, height: 844 } );
await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: STUB } );

const reset = async ( { offline = false, rates = null, prefs = null } = {} ) =>
{
    await c.evaluate( `localStorage.removeItem( 'balata-fx' ); localStorage.removeItem( 'balata-calculator' ); localStorage.removeItem( 'balata-calculator-history' );
        localStorage.setItem( 'balata-intro-dismiss:calculator', '1' );
        ${ offline ? "localStorage.setItem( 'test-fx-offline', '1' );" : "localStorage.removeItem( 'test-fx-offline' );" }
        ${ rates ? `localStorage.setItem( 'balata-fx', ${JSON.stringify( JSON.stringify( rates ) )} );` : "" }
        ${ prefs ? `localStorage.setItem( 'balata-calculator', ${JSON.stringify( JSON.stringify( prefs ) )} );` : "" } true` );
};
const open = async ( q = "" ) => ok( await c.open( "/nayive/calculator/" + q, "/nayive/calculator/" ) && await c.until( "window.calcPress" ), "Calculator opens " + q );
const run  = keys => c.evaluate( `( () => { calcPress( 'clear' ); const r = calcPress( ${JSON.stringify( keys )} ); return [ r.text, r.expr ]; } )()` );
const same = ( got, want ) => JSON.stringify( got ) === JSON.stringify( want );
const txt  = id => c.evaluate( `document.getElementById( '${id}' ).textContent` );
// Picks a currency in a drop-down as a person does (a change event follows).
const pick  = ( id, v ) => c.evaluate( `( () => { const e = document.getElementById( '${id}' ); e.value = '${v}'; e.dispatchEvent( new Event( 'change' ) ); return true; } )()` );
const click = sel => c.evaluate( `document.querySelector( ${JSON.stringify( sel )} ).click(); true` );

section( "ARITHMETIC" );
await c.open( "/nayive/calculator/", "/nayive/calculator/" );
await reset( { prefs: { mode: "arith" } } );
await open();
for( const [ name, keys, want ] of [
    [ "precedence",        [ "2", "+", "3", "*", "4", "=" ],             [ "14", "2 + 3 × 4 =" ] ],
    [ "repeat =",          [ "5", "+", "=", "=" ],                       [ "15", "10 + 5 =" ] ],
    [ "percent",           [ "5", "0", "+", "1", "0", "percent", "=" ],  [ "55", "50 + 5 =" ] ],
    [ "divide by zero",    [ "1", "/", "0", "=" ],                       [ "Error", "1 ÷ 0 =" ] ],
    [ "sign and decimals", [ "1", "dot", "5", "sign", "*", "2", "=" ],   [ "-3", "-1.5 × 2 =" ] ],
    [ "float tidy",        [ "0", "dot", "1", "+", "0", "dot", "2", "=" ], [ "0.3", "0.1 + 0.2 =" ] ],
    [ "grouping",          [ "1", "2", "3", "4", "dot", "5" ],           [ "1,234.5", "1,234.5" ] ] ] )
{
    const got = await run( keys );
    ok( same( got, want ), name, got );
}
ok( await c.evaluate( "document.querySelector( '[data-k=dot]' ).textContent" ) === ".", "the decimal key shows English's mark" );

await c.evaluate( "calcPress( 'clear' ); localStorage.removeItem( 'balata-calculator-history' ); true" );
await open();
for( const k of [ "1", "2", "*", "3", "=" ] ) await click( `#keys [data-k="${k}"]` );
ok( await txt( "display" ) === "36", "keypad clicks", await txt( "display" ) );

section( "HISTORY" );
await click( '#keys [data-k="clear"]' );
await click( "#histBtn" );
ok( await c.until( "document.getElementById( 'histBackdrop' ).open" ), "the history opens" );
const rows = await c.evaluate( "[ ...document.querySelectorAll( '#histList button' ) ].map( b => b.textContent )" );
ok( same( rows, [ "12 × 3 =36" ] ), "the result is listed", rows );
ok( await c.evaluate( "document.getElementById( 'histEmpty' ).hidden" ), "no 'empty' note" );
await click( "#histList button" );
ok( await txt( "display" ) === "36" && ! await c.evaluate( "document.getElementById( 'histBackdrop' ).open" ),
    "a tap puts it back and closes the dialog" );
await click( "#histBtn" );
await click( "#histClearBtn" );
ok( await c.evaluate( "! document.getElementById( 'histList' ).children.length && ! document.getElementById( 'histEmpty' ).hidden" ),
    "the trash empties it at once" );
ok( await c.evaluate( "localStorage.getItem( 'balata-calculator-history' )" ) === "[]", "...on this device too" );
await click( "#histBackdrop button[data-close]" );

section( "THE MODE SWITCH" );
const modeNow = () => c.evaluate( "[ document.getElementById( 'calc' ).dataset.mode, document.querySelector( '#modeSwitch input[value=fx]' ).checked ]" );
await click( '#modeSwitch [data-mode="fx"]' );
ok( same( await modeNow(), [ "fx", true ] ), "the € icon picks Currency, the thumb goes right", await modeNow() );
await click( "#modeSwitch .track" );
ok( same( await modeNow(), [ "arith", false ] ), "the track flips back", await modeNow() );
await c.evaluate( "document.querySelector( '#modeSwitch input[value=arith]' ).focus(); document.querySelector( '#modeSwitch input[value=arith]' ).dispatchEvent( new KeyboardEvent( 'keydown', { key: 'ArrowRight', bubbles: true } ) ); true" );
ok( same( await modeNow(), [ "fx", true ] ), "→ picks the right side", await modeNow() );
ok( await c.evaluate( "document.getElementById( 'calc' ).getBoundingClientRect().bottom <= innerHeight" ), "the calculator fits the screen" );

section( "CURRENCY - THE CROSS-CHECK" );
ok( await c.until( "window.NayiveFx && NayiveFx.date()" ), "the rates arrive" );
await pick( "fxFrom", "EUR" ); await pick( "fxTo", "USD" );
await c.evaluate( "calcPress( 'clear' ); true" );
for( const k of [ "1", "0", "0" ] ) await click( `#keys [data-k="${k}"]` );
ok( await txt( "displayTo" ) === "108.00", "EUR → USD", await txt( "displayTo" ) );
ok( await txt( "fxNote" ) === "1 EUR = 1.08 USD · 2026-10-27", "the note: rate and day", await txt( "fxNote" ) );
await click( "#fxSwap" );
ok( await txt( "displayTo" ) === "92.59" && await txt( "fxNote" ) === "1 USD = 0.92593 EUR · 2026-10-27", "⇄ swaps", [ await txt( "displayTo" ), await txt( "fxNote" ) ] );
const r = await c.evaluate( "[ NayiveFx.rate( 'EUR', 'JPY' ), NayiveFx.rate( 'EUR', 'GBP' ), NayiveFx.rate( 'EUR', 'ARS' ), NayiveFx.rate( 'EUR', 'BRL' ) ]" );
ok( r[ 0 ] === 160.1, "1st pair agrees: their average (JPY 160.1)", r[ 0 ] );
ok( r[ 1 ] === 0.8505, "1st pair off, 2nd agrees (GBP 0.8505)", r[ 1 ] );
ok( r[ 2 ] === 1000.5, "a currency only two sources have (ARS 1000.5)", r[ 2 ] );
ok( r[ 3 ] === null, "no pair agrees: no rate (BRL)", r[ 3 ] );
await pick( "fxFrom", "EUR" ); await pick( "fxTo", "JPY" );
ok( await txt( "displayTo" ) === "16,010", "JPY has no decimals", await txt( "displayTo" ) );
await pick( "fxTo", "BRL" );
ok( await txt( "displayTo" ) === "—" && await txt( "fxNote" ) === "No verified rate for EUR/BRL · 2026-10-27", "BRL: '—' and why", [ await txt( "displayTo" ), await txt( "fxNote" ) ] );
await click( "#fxNote" );
ok( await c.until( "document.getElementById( 'fxCheckBackdrop' ).open" ), "the note opens the rate check" );
const chk = await c.evaluate( "[ document.querySelectorAll( '#fxCheckBody .fx-source-row' ).length, !! document.querySelector( '#fxCheckBody .warn-box' ) ]" );
ok( same( chk, [ 3, true ] ), "...with the three sources and the warning", chk );
await click( "#fxCheckBackdrop header [data-close]" );
ok( await c.evaluate( "NayiveFx.rate( 'EUR', 'XXX' ) === null && ! /1INCH/.test( localStorage.getItem( 'balata-fx' ) )" ), "only the offered currencies are kept" );

section( "CURRENCY - OFFLINE" );
const kept = { fetched: 0, sources: [ { ok: true, source: "A", asOf: "2026-10-20", rates: { USD: 1.1 } }, { ok: true, source: "B", asOf: "2026-10-20", rates: { USD: 1.1 } } ] };
await reset( { offline: true, rates: kept, prefs: { mode: "fx", from: "EUR", to: "USD" } } );
await open();
await c.evaluate( "calcPress( [ '5', '0' ] ); true" );
ok( await c.until( "NayiveFx.offline()" ), "the refresh fails" );
const off = [ await txt( "display" ), await txt( "displayTo" ), await txt( "fxNote" ) ];
ok( same( off, [ "50", "55.00", "1 EUR = 1.1 USD · 2026-10-20 · offline" ] ), "kept rates still convert, and the note says offline", off );
await reset( { offline: true, prefs: { mode: "fx", from: "EUR", to: "USD" } } );
await open();
await c.evaluate( "calcPress( '7' ); true" );
await c.until( "NayiveFx.offline()" );
const none = [ await txt( "displayTo" ), await txt( "fxNote" ) ];
ok( same( none, [ "—", "No rates yet: offline" ] ), "first visit offline: no rates at all", none );

section( "LAYOUT" );
ok( await c.evaluate( "document.documentElement.scrollWidth <= innerWidth" ), "no side scroll at 390 px" );
ok( await c.evaluate( "document.getElementById( 'fxBar' ).getBoundingClientRect().bottom <= document.querySelector( '.screen' ).getBoundingClientRect().top" ),
    "the currencies sit over the screen" );

section( "TRIPS → CALCULATOR" );
await reset();
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:trips', '1' ); true" );
ok( await c.open( "/nayive/trips/" ) && await c.until( "!! document.querySelector( '.trip-card' )" ), "Trips opens with the Osaka trip" );
await c.evaluate( "goToDetail( 9100 ); true" );
ok( await c.until( "[ ...document.querySelectorAll( '#tripHeader .btn' ) ].some( b => b.dataset.tip === Ayni.t( 'trips.fxTitle' ) )" ), "the converter button is there" );
await c.evaluate( "[ ...document.querySelectorAll( '#tripHeader .btn' ) ].find( b => b.dataset.tip === Ayni.t( 'trips.fxTitle' ) ).click(); true" );
ok( await c.until( "/^\\/nayive\\/calculator\\//.test( location.pathname ) && window.calcPress" ), "it opens Calculator in place (a phone)", await c.evaluate( "location.href" ) );
const landed = await c.evaluate( "[ document.getElementById( 'calc' ).dataset.mode, document.getElementById( 'fxFrom' ).value, document.getElementById( 'fxTo' ).value, ! document.getElementById( 'backBtn' ).hidden, document.getElementById( 'fxGuess' ).hidden ]" );
ok( same( landed, [ "fx", "JPY", "EUR", true, true ] ), "currency mode, JPY → EUR, with a ←, no guess warning", landed );
await click( "#backBtn" );
ok( await c.until( "location.pathname === '/nayive/trips/'" ), "← goes back to Trips" );

await c.open( "/nayive/calculator/?mode=fx&from=EUR&to=EUR&place=Somewhere", "/nayive/calculator/" );
await c.until( "window.calcPress" );
ok( await c.evaluate( "! document.getElementById( 'fxGuess' ).hidden && /Somewhere/.test( document.getElementById( 'fxGuess' ).textContent )" ),
    "an unknown place's currency is said plainly" );

const errors = c.logs.filter( l => /^EXCEPTION/.test( l ) );
ok( ! errors.length, "no page errors", errors );

section( "SPANISH NUMBERS" );
const e = await browser( s, { width: 390, height: 844, lang: "es" } );
ok( await e.open( "/nayive/calculator/", "/nayive/calculator/" ) && await e.until( "window.calcPress" ), "Calculator opens in Spanish" );
await e.evaluate( "document.querySelector( '#modeSwitch [data-mode=arith]' ).click(); true" );
const es = await e.evaluate( "( () => { calcPress( 'clear' ); const r = calcPress( [ '1', '2', '3', '4', 'dot', '5' ] ); return [ r.text, r.expr, document.querySelector( '[data-k=dot]' ).textContent ]; } )()" );
ok( same( es, [ "1.234,5", "1.234,5", "," ] ), "1.234,5 and a ',' key", es );

await done( c, e, s );
