// run.mjs - Games checks in a real (headless) browser, real keys over CDP.
//
//   node tools/games-test/run.mjs
//
// The Chess and Checkers boards are ONE tab stop (NayiveGames.roving): Tab
// lands on one square, the arrows move inside the board and stop at its
// edges, a click moves the tab stop, Enter presses the square. Scratch server
// (data-safety harness); the real store/ is never touched.
import { server, browser, ok, section, done, sleep, mouse, key } from "../browser-test/lib.mjs";

const s = await server();
const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:games', '1' ); true" );

const at   = sq => c.evaluate( `( () => { const a = document.activeElement; return a && a.classList.contains( '${sq}' ) ? Number( [ ...a.parentNode.querySelectorAll( '.${sq}' ) ].indexOf( a ) ) : -1; } )()` );
const stops = sq => c.evaluate( `[ ...document.querySelectorAll( '.${sq}' ) ].filter( e => e.tabIndex === 0 ).map( e => [ ...e.parentNode.querySelectorAll( '.${sq}' ) ].indexOf( e ) ).join()` );

for( const [ game, sq ] of [ [ "chess", "chess-sq" ], [ "checkers", "checkers-sq" ] ] )
{
    section( game.toUpperCase() + " · ONE TAB STOP" );
    ok( await c.open( "/nayive/games/" ) && await c.until( "!! document.querySelector('.game-tile[data-game=\"" + game + "\"]')" ), "Games opens" );
    await c.evaluate( `document.querySelector( '.game-tile[data-game="${game}"]' ).click(); true` );
    ok( await c.until( `document.querySelectorAll( '.${sq}' ).length === 64 && document.querySelector( '.${sq}' ).offsetWidth > 0` ), game + " shows 64 squares" );
    ok( await stops( sq ) === "0", "exactly one square is in the tab order", await stops( sq ) );

    await c.front();
    await c.evaluate( `document.querySelectorAll( '.${sq}' )[ 0 ].focus(); true` );
    await key( c, "ArrowLeft" );  ok( await at( sq ) === 0, "Left at the edge stays", await at( sq ) );
    await key( c, "ArrowUp" );    ok( await at( sq ) === 0, "Up at the edge stays", await at( sq ) );
    await key( c, "ArrowRight" ); ok( await at( sq ) === 1, "Right moves one square", await at( sq ) );
    await key( c, "ArrowDown" );  ok( await at( sq ) === 9, "Down moves one row", await at( sq ) );
    ok( await stops( sq ) === "9", "the tab stop follows the arrows", await stops( sq ) );
    for( let i = 0; i < 8; i++ ) await key( c, "ArrowDown" );
    ok( await at( sq ) === 57, "Down stops at the last row", await at( sq ) );
    for( let i = 0; i < 8; i++ ) await key( c, "ArrowRight" );
    ok( await at( sq ) === 63, "Right stops at the last column", await at( sq ) );

    await key( c, "Tab" );
    ok( await at( sq ) === -1, "Tab leaves the board in one press" );
    await key( c, "Tab", 8 );
    ok( await at( sq ) === 63, "Shift+Tab comes back to the same square", await at( sq ) );

    await mouse( c, `.${sq}`, { i: 20 } );
    ok( await stops( sq ) === "20", "a click moves the tab stop there", await stops( sq ) );
}

// Enter presses the square like a click: Chess e2 (index 52) is picked up.
section( "CHESS · ENTER" );
ok( await c.open( "/nayive/games/" ), "Games opens again" );
await c.evaluate( `document.querySelector( '.game-tile[data-game="chess"]' ).click(); true` );
ok( await c.until( "document.querySelectorAll( '.chess-sq' ).length === 64 && document.querySelector( '.chess-sq' ).offsetWidth > 0" ), "chess shows" );
await c.front();
await c.evaluate( "document.querySelectorAll( '.chess-sq' )[ 48 ].focus(); true" );
await key( c, "ArrowRight" ); await key( c, "ArrowRight" ); await key( c, "ArrowRight" ); await key( c, "ArrowRight" );
ok( await at( "chess-sq" ) === 52, "arrows reach e2", await at( "chess-sq" ) );
// A real Enter: keyDown with its "\r" text is what makes a button click.
await c.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" } );
await c.send( "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } );
await sleep( 200 );
ok( await c.evaluate( "document.querySelectorAll( '.chess-sq' )[ 52 ].classList.contains( 'is-from' )" ), "Enter picks the pawn up" );

await done( c, s );
