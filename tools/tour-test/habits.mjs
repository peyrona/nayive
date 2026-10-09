// habits.mjs - Habits' tour: ghosts with no habit yet, the real buttons with
// two, the user's own tap on «Mes», back to «Hoy» at the end, the phone, and
// never a byte written.
import { server, browser, ok, section, done, onDisk, key, seed, mouse,
         state, startTour, next, tourGone, walk, errors } from "./lib.mjs";

const F = "data/habits/habits.json";
const ago = n => { const d = new Date(); d.setDate( d.getDate() - n ); return d.toLocaleDateString( "sv" ); };
const s = await server();
const c = await browser( s, { mouse: true, lang: "es" } );
await c.front();
const shows = id => c.evaluate( `! document.getElementById( '${id}' ).hidden` );

section( "HABITS · NO HABITS YET (ghosts)" );
ok( await c.open( "/nayive/habits/" ) && await c.until( "! document.getElementById( 'homeEmpty' ).hidden" ), "Habits opens empty" );
ok( await startTour( c ), "the help card's «Ver el tour» starts it" );
ok( ! await c.evaluate( "!! document.querySelector( '.sheet-backdrop.open' )" ), "the help card closed" );
await walk( c, "empty", {
    1: s => /nayive-home-link/.test( s.lit ) || "starts at the app's name",
    2: s => /addBtn/.test( s.lit ) || "lights +",
    3: s => s.ghost && !! s.note || "mark: a ghost over the empty list",
    5: s => s.ghost || "edit: a ghost",
    6: s => s.tap && !! s.note || "«Mes» asks for a tap",
    7: s => s.ghost || "no month yet: a ghost",
    8: s => /icon-btn/.test( s.lit ) && s.n === s.m || "ends at the «?»" } );
ok( await tourGone( c ) && await shows( "todayView" ), "it closes and leaves «Hoy» on screen" );

section( "HABITS · BACK, ESCAPE" );
await startTour( c );
for( let i = 0; i < 6; i++ ) await next( c );      // step 7: the month
ok( await shows( "monthView" ), "Siguiente on the tap step tapped «Mes»" );
await key( c, "ArrowLeft" );
ok( ( await state( c ) ).n === 6 && await shows( "todayView" ), "← goes back and «Hoy» is shown again" );
await key( c, "Escape" );
ok( await tourGone( c ), "Escape leaves the tour" );

section( "HABITS · TWO HABITS (real buttons)" );
seed( s, { [ F ]: JSON.stringify( [
    { id: "a", name: "Beber agua", icon: "water", color: 1, days: [], target: null, created: ago( 20 ), done: [ ago( 3 ), ago( 2 ) ] },
    { id: "b", name: "Leer", icon: "book", color: 2, days: [], target: null, created: ago( 20 ), done: [] } ] ) } );
const before = onDisk( s, F );
ok( await c.open( "/nayive/habits/" ) && await c.until( "document.querySelectorAll( '#dueList .habit-row' ).length === 2" ), "Habits shows two habits" );
await startTour( c );
await next( c ); await next( c );
let st = await state( c );
ok( /check-btn/.test( st.lit ) && ! st.ghost, "step 3 lights a real check button", st );
await mouse( c, ".tour-lid" );
ok( ( await state( c ) ).n === 3 && await c.evaluate( "! document.querySelector( '.check-btn.done' )" ), "the lid keeps it from being pressed" );
await next( c ); st = await state( c );
ok( /danger/.test( st.lit ), "step 4 lights «Ayer ✗»", st );
await next( c ); await next( c );
const tab = await c.evaluate( "( () => { const b = document.querySelector( '[data-view=\"month\"]' ).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } )()" );
await mouse( c, tab );
ok( await c.until( "! document.getElementById( 'monthView' ).hidden" ), "the user's own tap on «Mes» reaches the app" );
await c.until( "document.querySelector( '.tour-count' ).textContent.startsWith( '7' )", 3000 );
st = await state( c );
ok( st.n === 7 && ! st.ghost && /gridWrap|cell|row|h-/.test( st.lit ), "and the tour lights the month grid", st );
await key( c, "Escape" ); await tourGone( c );
ok( onDisk( s, F ) === before, "nothing was written" );

section( "HABITS · PHONE" );
const p = await c.tab();
await p.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 760, deviceScaleFactor: 1, mobile: true } );
await p.front();
ok( await p.open( "/nayive/habits/" ) && await p.until( "document.querySelectorAll( '#dueList .habit-row' ).length === 2" ), "Habits opens on a phone" );
await startTour( p );
await walk( p, "phone" );
ok( await tourGone( p ), "the phone tour ends" );

ok( ! errors( c, p ).length, "no script errors", errors( c, p ) );
await done( c, s );
