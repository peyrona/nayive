// uitest.mjs - Machines inside Games, in headless Chromium, with real touch input.
//
//   node tools/machines-test/uitest.mjs [shotDir]
//
// Builds the first level by finger, runs it, edits it, zooms; then every
// level's stored solution through design mode, whose end hash must equal the
// one Node computes from the same files (same machine, same bits). Then the
// design tools and the level code. Scratch server (data-safety harness); the
// real store/ is never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { server, browser, ok, section, done, sleep, key } from "../browser-test/lib.mjs";

const shots = process.argv[ 2 ] || fs.mkdtempSync( path.join( os.tmpdir(), "machines-ui-" ) );
const GAMES = path.join( import.meta.dirname, "../../client/apps/games" );

// What Node says each stored solution ends in: its state and its hash.
vm.runInThisContext( fs.readFileSync( path.join( GAMES, "lib/nape_v3.43.5.min.js" ), "utf8" ) + ";globalThis.Nape=Nape" );
for( const f of [ "machines-sim.js", "machines-levels.js" ] ) vm.runInThisContext( fs.readFileSync( path.join( GAMES, f ), "utf8" ) );
const LEVELS = globalThis.MachinesLevels, nodeEnd = LEVELS.map( l =>
{
    const s = new globalThis.Machines.Sim( l, l.solution );
    for( let i = 0; i < 120 * 30 && s.state === "running"; i++ ) s.step();
    return s.state + " #" + s.hash();
} );

const s = await server();
const c = await browser( s );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:games', '1' ); true" );

const device = ( w, h, touch, dark ) => Promise.all( [
    c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: touch ? 3 : 1, mobile: touch } ),
    c.send( "Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 2 } ),
    c.send( "Emulation.setEmulatedMedia", { features: [ { name: "prefers-color-scheme", value: dark ? "dark" : "light" } ] } ) ] );
const shot = async n => { const r = await c.send( "Page.captureScreenshot", { format: "png" } ); fs.writeFileSync( path.join( shots, n + ".png" ), Buffer.from( r.result.data, "base64" ) ); };
const S = "MachinesBoard.state";
const ev = e => c.evaluate( e );

async function openGame( dark )
{
    await c.evaluate( `localStorage.setItem( 'ayni-theme', '${ dark ? "dark" : "light" }' ); true` );
    ok( await c.open( "/nayive/games/" ) && await c.until( `!! document.querySelector('.game-tile[data-game="machines"]')` ), "Games opens with the Machines card" );
    await ev( `document.querySelector( '.game-tile[data-game="machines"]' ).click(); true` );
    ok( await c.until( `window.MachinesBoard && document.getElementById( 'mchCover' ).hidden && ${ S }.live`, 15000 ), "the game loads on first open" );
    await sleep( 200 );
}

const board = at => ev( `(()=>{const st=${ S },c=document.getElementById('mchCanvas').getBoundingClientRect(),s=Math.min(c.width/st.scene.w,c.height/st.scene.h)*st.zoom,ox=(c.width-st.scene.w*s)/2+st.panX,oy=(c.height-st.scene.h*s)/2+st.panY;return {x:c.left+ox+${ at[ 0 ] }*s,y:c.top+oy+${ at[ 1 ] }*s}})()` );
const touch = ( type, pts ) => c.send( "Input.dispatchTouchEvent", { type, touchPoints: pts.map( ( p, i ) => ( { x: p.x, y: p.y, id: i } ) ) } );
const tapXY = async p => { await touch( "touchStart", [ p ] ); await touch( "touchEnd", [] ); await sleep( 40 ); };
const tapAt = async at => tapXY( await board( at ) );
const centre = sel => ev( `(()=>{const e=document.querySelector(${ JSON.stringify( sel ) });if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()` );
const tool = async t => { await tapXY( await centre( `.mch-tool[data-tool="${ t }"]` ) ); await sleep( 40 ); };
const button = async id => { await tapXY( await centre( "#" + id ) ); await sleep( 300 ); };
// A finger drag; the board aims above a moving finger, so the finger ends below the target.
const drag = async ( a, b ) =>
{
    const p = await board( a ), q = await board( b ); q.y += 56;
    await touch( "touchStart", [ p ] );
    for( let i = 1; i <= 8; i++ ) { await touch( "touchMove", [ { x: p.x + ( q.x - p.x ) * i / 8, y: p.y + ( q.y - p.y ) * i / 8 } ] ); await sleep( 16 ); }
    await touch( "touchEnd", [] ); await sleep( 40 );
};
const untilDone = async ms => { for( let t = 0; t < ms; t += 100 ) { const r = await ev( `${ S }.sim && ${ S }.sim.state` ); if( r && r !== "running" ) return r; await sleep( 100 ); } return "timeout"; };
const fits = () => ev( `document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.topbar button, .mch-tool')].filter(b=>b.offsetParent).every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})` );
const pickMenu = async text =>
{
    await button( "mchBoard" );
    const hit = await ev( `(()=>{const m=[...document.querySelectorAll('#ayni-menu [role^="menuitem"]')].find(x=>x.textContent.includes(${ JSON.stringify( text ) }));if(!m)return false;m.click();return true})()` );
    await sleep( 250 );
    return hit;
};

section( "Phone, portrait: build level 1 by finger, from empty" );
await device( 390, 844, true, false );
await openGame( false );
ok( await fits(), "header and pieces fit the screen, no sideways scroll" );
ok( await ev( `document.getElementById('mchLevel').textContent` ) === "1 / " + LEVELS.length, "the pager shows level 1" );
await tool( "gear" ); await tapAt( [ 4, 6 ] ); await tapAt( [ 7, 6 ] ); await tapAt( [ 7, 6 ] );   // second tap: size 2
await tool( "axle" ); await tapAt( [ 4, 6 ] ); await tapAt( [ 7, 6 ] );
await tool( "motor" ); await tapAt( [ 4, 6 ] );
await tool( "beam" ); await drag( [ 7, 6 ], [ 7, 9 ] );
await tool( "bolt" ); await tapAt( [ 7, 8 ] );
const built = await ev( `JSON.stringify(${ S }.build)` );
ok( built.includes( '"a":[7,6],"b":[7,9]' ), "a finger drag laid the beam on the right points" );
ok( await ev( `Machines.check(${ S }.build).links.length` ) === 1, "the gears show as meshed" );
ok( await ev( `document.querySelector('.mch-tool[data-tool="gear"] i').textContent` ) === "1", "the gear count went down to 1" );
await shot( "phone-build" );
const icon = () => ev( `[ 'run', 'stop' ].filter( k => ! document.querySelector( '#mchRun [data-ic="' + k + '"]' ).hasAttribute( 'hidden' ) ).join()` );
ok( await icon() === "run", "the run button shows ▶" );
await button( "mchRun" ); await sleep( 1200 ); await shot( "phone-run" );
ok( await icon() === "stop", "...and ■ while it runs" );
ok( await fits(), "the header fits while running" );
ok( await untilDone( 8000 ) === "won", "the hand-built machine solves level 1" );
ok( ! await ev( `document.getElementById('mchWin').hidden` ) && ! await ev( `document.getElementById('mchWinNext').hidden` ), "the banner says so, with Next level" );
await shot( "phone-won" );
await button( "mchRun" );
ok( await ev( `JSON.stringify(${ S }.build)` ) === built && await ev( `${ S }.sim === null` ), "Stop puts everything back exactly" );
ok( await icon() === "run", "...and the button is ▶ again" );

section( "Editing by finger" );
await tool( "move" ); await drag( [ 4, 6 ], [ 4, 5 ] );
ok( await ev( `${ S }.build.filter(p=>p.at&&p.at[0]===4).every(p=>p.at[1]===5)` ), "moving a gear carries its axle and motor" );
ok( await ev( `${ S }.sel && ${ S }.sel.piece.type === 'gear' && ${ S }.sel.piece.r === 1` ), "the dragged gear is the chosen piece" );
await key( c, "ArrowRight" ); await key( c, "ArrowDown" );
ok( await ev( `${ S }.build.filter(p=>p.at&&p.at[0]===5&&p.at[1]===6).length` ) === 3, "the arrow keys move it, axle and motor with it" );
await key( c, "ArrowLeft" ); await key( c, "ArrowUp" );
ok( await ev( `${ S }.build.filter(p=>p.at&&p.at[0]===4&&p.at[1]===5).length` ) === 3, "...and back" );
await tapAt( [ 20, 3 ] );
ok( await ev( `${ S }.sel` ) === null, "a tap on nothing: nothing chosen" );
await tool( "erase" ); await tapAt( [ 7, 9 ] );
ok( ! ( await ev( `JSON.stringify(${ S }.build)` ) ).includes( '"beam"' ), "delete removes the beam" );
ok( ! ( await ev( `JSON.stringify(${ S }.build)` ) ).includes( '"bolt"' ), "...and the bolt it held" );
const z0 = await ev( `${ S }.zoom` ), m = { x: 195, y: 300 };
await touch( "touchStart", [ { x: m.x - 30, y: m.y }, { x: m.x + 30, y: m.y } ] );
for( let i = 1; i <= 6; i++ ) { await touch( "touchMove", [ { x: m.x - 30 - i * 15, y: m.y }, { x: m.x + 30 + i * 15, y: m.y } ] ); await sleep( 16 ); }
await touch( "touchEnd", [] );
ok( await ev( `${ S }.zoom` ) > z0 * 1.5, "pinch zooms, " + ( await ev( `${ S }.zoom` ) ).toFixed( 2 ) );
const mid = await ev( `(()=>{const st=${ S },c=document.getElementById('mchCanvas').getBoundingClientRect(),s=Math.min(c.width/st.scene.w,c.height/st.scene.h)*st.zoom,ox=(c.width-st.scene.w*s)/2+st.panX,oy=(c.height-st.scene.h*s)/2+st.panY;return [Math.round((c.width/2-ox)/s),Math.round((c.height/2-oy)/s)]})()` );
await tool( "gear" ); await tapAt( mid );
ok( await ev( `${ S }.build.some(p=>p.at&&p.at[0]===${ mid[ 0 ] }&&p.at[1]===${ mid[ 1 ] })` ), "a tap lands on the right point when zoomed: " + mid );
ok( await ev( `${ S }.sel && ${ S }.sel.piece.at[0]===${ mid[ 0 ] }` ), "the gear just placed is the chosen one" );
await key( c, "Delete" );
ok( ! await ev( `${ S }.build.some(p=>p.at&&p.at[0]===${ mid[ 0 ] }&&p.at[1]===${ mid[ 1 ] })` ) && await ev( `${ S }.sel` ) === null, "Del removes the chosen piece" );
await tapAt( mid );
await shot( "phone-zoomed" );
await button( "mchClear" );
ok( await ev( `${ S }.build.length` ) === 0, "Clear removes every piece" );
await ev( `document.querySelector('.toast .act').click(); true` ); await sleep( 150 );
ok( await ev( `${ S }.build.length` ) > 0, "...and its Undo brings them back" );

section( "Levels: the pager keeps each level's build" );
await button( "mchNext" );
ok( await ev( `${ S }.level` ) === 1 && await ev( `${ S }.build.length` ) === 0, "Next goes to level 2, empty" );
await button( "mchPrev" );
ok( await ev( `${ S }.build.length` ) > 0, "back on level 1, its build is still there" );

section( "Every stored solution, through design mode: the page ends where Node ends" );
await button( "mchDesign" );
ok( await ev( `${ S }.mode` ) === "design" && ! await ev( `document.getElementById('mchBoard').hidden` ), "design mode shows the board menu" );
ok( ! await ev( `document.querySelector('.mch-tool[data-tool="ball"]').hidden` ), "...and the board's own tools" );
for( let i = 0; i < LEVELS.length; i++ )
{
    ok( await pickMenu( "Level " + ( i + 1 ) + ":" ), `menu: level ${ i + 1 }` );
    await button( "mchRun" );
    const r = await untilDone( 15000 ), end = r + " #" + await ev( `${ S }.sim.hash()` );
    await shot( "level-" + LEVELS[ i ].id );
    ok( r === "won" && end === nodeEnd[ i ], `${ LEVELS[ i ].id }: page ${ end }, Node ${ nodeEnd[ i ] }` );
    ok( ( await ev( `document.getElementById('mchWinText').textContent` ) ).includes( "#" + await ev( `${ S }.sim.hash()` ) ), "...and the banner shows that hash" );
    await button( "mchRun" );
}

section( "Design tools" );
ok( await pickMenu( "Empty board" ), "menu: empty board" );
ok( await ev( `${ S }.scene.blocks.length === 0 && ${ S }.build.length === 0` ), "the empty board is empty" );
await tool( "ball" ); await tapAt( [ 5.5, 4 ] );
ok( await ev( `JSON.stringify(${ S }.scene.ball)` ) === "[5.5,4]", "the ball goes where it is tapped" );
await tool( "block" ); await drag( [ 4, 9 ], [ 12, 9.5 ] );
ok( await ev( `JSON.stringify(${ S }.scene.blocks)` ) === "[[4,9,8,0.5]]", "a drag draws a block: " + await ev( `JSON.stringify(${ S }.scene.blocks)` ) );
await tool( "pulley" ); await tapAt( [ 10, 3 ] );
ok( await ev( `JSON.stringify(${ S }.scene.pulleys)` ) === "[[10,3]]", "a tap adds a pulley" );
await tool( "move" ); await drag( [ 8, 9.25 ], [ 8, 8.25 ] );
ok( await ev( `${ S }.scene.blocks[0][1]` ) === 8, "move drags a block" );
await key( c, "ArrowUp" );
ok( await ev( `${ S }.scene.blocks[0][1]` ) === 7.5, "the arrow keys step it half a cell" );
await tool( "pulley" ); await tapAt( [ 14, 3 ] ); await key( c, "Delete" );
ok( await ev( `JSON.stringify(${ S }.scene.pulleys)` ) === "[[10,3]]", "Del removes the chosen pulley, only that one" );
await tool( "ball" ); await tapAt( [ 5.5, 4 ] ); await key( c, "Delete" );
ok( await ev( `JSON.stringify(${ S }.scene.ball)` ) === "[5.5,4]", "...but never the ball" );
await tool( "erase" ); await tapAt( [ 10, 3 ] );
ok( await ev( `${ S }.scene.pulleys.length` ) === 0, "delete removes the pulley" );
await tool( "wheel" ); await tapAt( [ 6, 6 ] );
await shot( "phone-design" );

section( "Level code: out and back in" );
ok( await pickMenu( "Level code" ), "menu: level code" );
ok( await c.until( `document.querySelector('.mch-code')` ), "the dialog opens" );
const text = await ev( `document.querySelector('.mch-code').value` ), lvl = JSON.parse( text );
ok( lvl.ball[ 0 ] === 5.5 && lvl.blocks.length === 1 && lvl.solution.length === 1 && lvl.inventory.wheel === 1, "the text holds the board, the machine and its pieces" );
ok( text.split( "\n" ).length > 12, "one key a line, one piece a line" );
await shot( "phone-code" );
lvl.ball = [ 2, 2 ];
await ev( `(()=>{const t=document.querySelector('.mch-code');t.value=${ JSON.stringify( JSON.stringify( lvl ) ) };t.dispatchEvent(new Event('input'))})()` );
await ev( `document.querySelector('.mch-code-dialog .btn.primary').click(); true` ); await sleep( 200 );
ok( await ev( `JSON.stringify(${ S }.scene.ball)` ) === "[2,2]" && ! await ev( `!!document.querySelector('.mch-code')` ), "pasted text loads, and the dialog closes" );
await pickMenu( "Level code" );
await ev( `(()=>{const t=document.querySelector('.mch-code');t.value='{ not a board';})()` );
await ev( `document.querySelector('.mch-code-dialog .btn.primary').click(); true` ); await sleep( 200 );
ok( await ev( `document.querySelector('.mch-code').getAttribute('aria-invalid')` ) === "true" && await ev( `JSON.stringify(${ S }.scene.ball)` ) === "[2,2]", "bad text is refused and changes nothing" );
await ev( `document.querySelector('.mch-code-dialog [data-close]').click(); true` ); await sleep( 150 );

section( "Leaving the game stops it" );
await button( "mchPlay" );
ok( await ev( `${ S }.mode` ) === "play" && await ev( `${ S }.build.length` ) > 0, "play mode again, level 1's build kept" );
await ev( `document.getElementById('gamesBack').click(); true` ); await sleep( 200 );
ok( ! await ev( `${ S }.live` ), "back to the cards: the loop stops" );
await ev( `document.querySelector( '.game-tile[data-game="machines"]' ).click(); true` ); await sleep( 200 );
ok( await ev( `${ S }.live` ), "open again: it runs" );

section( "Other screens" );
await device( 844, 390, true, true ); await openGame( true );
await button( "mchDesign" ); await pickMenu( "Level 3:" ); await sleep( 150 );
await shot( "phone-landscape-dark" );
const lt = await ev( `(()=>{const r=document.getElementById('mchStage').getBoundingClientRect();return [r.width,r.height]})()` );
ok( lt[ 1 ] > 250, "a landscape phone keeps the board usable: " + lt.map( Math.round ) );
ok( await fits(), "...and everything fits" );
await device( 1280, 800, false, false ); await openGame( false );
await button( "mchDesign" ); await pickMenu( "Level 3:" ); await sleep( 150 );
await shot( "desktop-light" );
const mo = await board( [ 2, 3 ] );
const r = await c.send( "Page.captureScreenshot", { format: "png", clip: { x: mo.x - 45, y: mo.y - 45, width: 90, height: 90, scale: 4 } } );
fs.writeFileSync( path.join( shots, "motor-arrow.png" ), Buffer.from( r.result.data, "base64" ) );

const errors = c.logs.filter( l => /^(EXCEPTION|LOG-ERROR)/.test( l ) && ! /favicon|401|api\//.test( l ) );
ok( ! errors.length, "no page errors " + errors.slice( 0, 3 ).join( " | " ) );
console.log( "shots:", shots );
await done( c, s );
