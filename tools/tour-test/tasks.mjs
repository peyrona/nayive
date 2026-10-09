// tasks.mjs - Tasks' tour: ghosts with no task yet; with tasks, the row
// buttons, the sub-task steps unfolding a task and folding it back, the
// user's tap on «Hechas», back on «Activas» at the end; a phone; and never a
// byte written.
import { server, browser, ok, section, done, onDisk, key, seed, mouse,
         state, startTour, next, tourGone, walk, errors } from "./lib.mjs";

const F = "data/tasks.json";
const s = await server();
const c = await browser( s, { mouse: true, lang: "es" } );
await c.front();
const filter = t => t.evaluate( "document.querySelector( '[data-filter].is-active' )?.dataset.filter" );

section( "TASKS · NO TASKS YET (ghosts)" );
ok( await c.open( "/nayive/tasks/" ) && await c.until( "getComputedStyle( document.getElementById( 'emptyState' ) ).display !== 'none'" ), "Tasks opens empty" );
ok( await startTour( c ), "«Ver el tour» starts it" );
await walk( c, "empty", {
    2:  s => /addBtn/.test( s.lit ) || "lights +",
    3:  s => s.ghost || "mark done: a ghost",
    6:  s => s.ghost || "drag: a ghost",
    8:  s => s.tap || "«Hechas» asks for a tap",
    9:  s => s.ghost || "back to active: a ghost",
    11: s => s.n === s.m || "ends at the «?»" } );
ok( await tourGone( c ) && await filter( c ) === "active", "it closes on «Activas»" );

section( "TASKS · WITH TASKS (real buttons)" );
seed( s, { [ F ]: JSON.stringify( [
    { id: "t1", text: "Mudanza", done: false, subtasks: [ { id: "s1", text: "Cajas", done: true }, { id: "s2", text: "Camión", done: false } ] },
    { id: "t2", text: "Llamar al banco", done: false, subtasks: [] },
    { id: "t3", text: "Pagar luz", done: true, subtasks: [] } ] ) } );
const before = onDisk( s, F );
ok( await c.open( "/nayive/tasks/" ) && await c.until( "document.querySelectorAll( '.task-row' ).length === 2" ), "Tasks shows two active tasks" );
await startTour( c );
const seen = await walk( c, "full", {
    3:  s => /check/.test( s.lit ) && ! s.ghost || "lights a real ✓",
    4:  s => ! s.ghost || "lights a real (+)",
    5:  s => /task-chevron/.test( s.lit ) || "lights the chevron",
    6:  s => /subtask-handle/.test( s.lit ) || "unfolds the task and lights the grip",
    7:  s => /subtask-plan-btn/.test( s.lit ) || "lights the plan button",
    9:  s => ! s.ghost || "lights a real «back to active»",
    10: s => /clearCompletedBtn/.test( s.lit ) || "lights «Borrar todas estas»" } );
ok( await tourGone( c ) && await filter( c ) === "active" && ! await c.evaluate( "!! document.querySelector( '.subtask-row' )" ),
    "it ends on «Activas» with the task folded again" );

section( "TASKS · THE USER'S OWN TAP, ESCAPE MID-WAY" );
await startTour( c );
for( let i = 0; i < 7; i++ ) await next( c );           // step 8: «Hechas»
const tab = await c.evaluate( "( () => { const b = document.querySelector( '[data-filter=\"done\"]' ).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } )()" );
await mouse( c, tab );
ok( await c.until( "document.querySelector( '.tour-count' )?.textContent.startsWith( '9' )", 3000 ) && await filter( c ) === "done", "the user's tap shows «Hechas» and the tour goes on" );
await key( c, "Escape" );
ok( await tourGone( c ) && await filter( c ) === "active", "Escape there puts «Activas» back" );
await startTour( c );
for( let i = 0; i < 5; i++ ) await next( c );           // step 6: the grip, task unfolded
await key( c, "Escape" );
ok( await tourGone( c ) && ! await c.evaluate( "!! document.querySelector( '.subtask-row' )" ), "Escape on a sub-task step folds the task again" );
ok( onDisk( s, F ) === before, "nothing was written" );

section( "TASKS · PHONE" );
const p = await browser( s, { lang: "es", width: 390, height: 760 } );
await p.front();
ok( await p.open( "/nayive/tasks/" ) && await p.until( "document.querySelectorAll( '.task-row' ).length === 2" ), "Tasks opens on a phone" );
await startTour( p );
await walk( p, "phone" );
ok( await tourGone( p ), "the phone tour ends" );

ok( onDisk( s, F ) === before, "still nothing written" );
ok( ! errors( c, p ).length, "no script errors", errors( c, p ) );
await p.stop();
await done( c, s );
