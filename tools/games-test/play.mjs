// play.mjs - the games' shared parts in play (index.html: NayiveGames.stopwatch
// and NayiveGames.machine), real mouse over CDP:
//
//   node tools/games-test/play.mjs
//
// Minesweeper, Sudoku and Solitaire: the clock starts on the first move, a
// pause covers the board and stops the clock, a resume takes up where it
// stopped. Chess and Checkers: the machine answers the player's move. Scratch
// server (data-safety harness); the real store/ is never touched.
import { server, browser, ok, section, done, sleep, mouse } from "../browser-test/lib.mjs";

const s = await server();
const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:games', '1' ); true" );

async function openGame( g, sel )
{
    ok( await c.open( "/nayive/games/" ) && await c.until( `!! document.querySelector('.game-tile[data-game="${g}"]')` ), "Games opens" );
    await c.evaluate( `document.querySelector( '.game-tile[data-game="${g}"]' ).click(); true` );
    ok( await c.until( `document.querySelector( '${sel}' ) && document.querySelector( '${sel}' ).offsetWidth > 0` ), g + " shows" );
    await c.front();
}
const txt = id => c.evaluate( `document.getElementById( '${id}' ).textContent` );
const hidden = id => c.evaluate( `document.getElementById( '${id}' ).hidden` );

async function clockAndPause( g, pre, start )
{
    section( g.toUpperCase() + " · CLOCK + PAUSE" );
    ok( await txt( pre + "Time" ) === "0:00", "clock at 0:00 before the first move" );
    ok( await c.evaluate( `document.getElementById( '${pre}Pause' ).disabled` ), "pause disabled before the first move" );
    await start();
    ok( await c.until( `document.getElementById( '${pre}Time' ).textContent === '0:02'`, 4000 ), "the clock runs", await txt( pre + "Time" ) );
    ok( ! await c.evaluate( `document.getElementById( '${pre}Pause' ).disabled` ), "pause enabled once started" );
    await mouse( c, "#" + pre + "Pause" );
    ok( ! await hidden( pre + "Paused" ), "pause covers the board" );
    const at = await txt( pre + "Time" );
    await sleep( 2200 );
    ok( await txt( pre + "Time" ) === at, "the clock stands while paused", at + " -> " + await txt( pre + "Time" ) );
    await mouse( c, "#" + pre + "Pause" );
    ok( await hidden( pre + "Paused" ), "resume uncovers it" );
    ok( await txt( pre + "Time" ) === at, "resume takes up where it stopped", await txt( pre + "Time" ) );
    await sleep( 1300 );
    ok( await txt( pre + "Time" ) !== at, "and it runs again", await txt( pre + "Time" ) );
}

await openGame( "mines", "#minesBoard > *" );
await clockAndPause( "mines", "mines", () => mouse( c, "#minesBoard > *", { i: 40 } ) );

await openGame( "sudoku", "#sudokuBoard > *" );
await clockAndPause( "sudoku", "sudoku", async () =>
{
    const i = await c.evaluate( "[ ...document.querySelectorAll( '#sudokuBoard > *' ) ].findIndex( e => ! e.textContent.trim() )" );
    await mouse( c, "#sudokuBoard > *", { i } );
    await mouse( c, ".spad", { i: 0 } );
} );

await openGame( "solitaire", "#solStock" );
await clockAndPause( "solitaire", "sol", () => mouse( c, "#solStock" ) );

section( "CHESS · THE MACHINE ANSWERS" );
await openGame( "chess", ".chess-sq" );
await mouse( c, ".chess-sq", { i: 52 } );
await mouse( c, ".chess-sq", { i: 36 } );
const afterMine = await c.evaluate( "[ ...document.querySelectorAll( '.chess-sq' ) ].slice( 0, 24 ).map( e => e.innerHTML.length ).join()" );
ok( await c.until( `[ ...document.querySelectorAll( '.chess-sq' ) ].slice( 0, 24 ).map( e => e.innerHTML.length ).join() !== ${JSON.stringify( afterMine )}`, 15000 ), "black replies to e4" );

section( "CHECKERS · THE MACHINE ANSWERS" );
await openGame( "checkers", ".checkers-sq" );
let moved = false;
for( let i = 63; i >= 40 && ! moved; i-- )
{
    await mouse( c, ".checkers-sq", { i } );
    const t = await c.evaluate( "[ ...document.querySelectorAll( '.checkers-sq' ) ].findIndex( e => e.classList.contains( 'is-move' ) )" );
    if( t >= 0 ) { await mouse( c, ".checkers-sq", { i: t } ); moved = true; }
}
ok( moved, "the player moves" );
const top = await c.evaluate( "[ ...document.querySelectorAll( '.checkers-sq' ) ].slice( 0, 32 ).map( e => e.innerHTML.length ).join()" );
ok( await c.until( `[ ...document.querySelectorAll( '.checkers-sq' ) ].slice( 0, 32 ).map( e => e.innerHTML.length ).join() !== ${JSON.stringify( top )}`, 15000 ), "the machine replies" );

done( c, s );
