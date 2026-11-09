// uitest.mjs - drives the real page in headless Chromium with real touch input.
// Run: node uitest.mjs [shotDir]
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process'; import os from 'os';
const root = path.resolve( import.meta.dirname, '../..' ), shots = process.argv[ 2 ] || fs.mkdtempSync( path.join( os.tmpdir(), 'mpoc' ) );
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = http.createServer( ( q, r ) => { const f = path.join( root, decodeURIComponent( q.url.split( '?' )[ 0 ] ) ); fs.readFile( f, ( e, d ) => { if( e ) { r.writeHead( 404 ); r.end(); } else { r.writeHead( 200, { 'content-type': types[ path.extname( f ) ] || 'text/plain' } ); r.end( d ); } } ); } );
await new Promise( ok => server.listen( 0, '127.0.0.1', ok ) );
const url = `http://127.0.0.1:${ server.address().port }/tools/machines-poc/index.html`;
const port = 9400 + Math.floor( Math.random() * 100 ), prof = fs.mkdtempSync( path.join( os.tmpdir(), 'mpoc-prof' ) );
const chrome = spawn( 'chromium', [ '--headless=new', '--no-sandbox', `--remote-debugging-port=${ port }`, '--remote-allow-origins=*', `--user-data-dir=${ prof }`, 'about:blank' ], { stdio: 'ignore' } );
const wait = ms => new Promise( ok => setTimeout( ok, ms ) );
let target;
for( let i = 0; i < 50 && ! target; i++ ) { await wait( 200 ); try { target = ( await ( await fetch( `http://127.0.0.1:${ port }/json` ) ).json() ).find( t => t.type === 'page' ); } catch {} }
const ws = new WebSocket( target.webSocketDebuggerUrl ); await new Promise( ok => ws.onopen = ok );
let id = 0; const pending = {}, errors = [];
ws.onmessage = m => { const d = JSON.parse( m.data ); if( d.id ) { pending[ d.id ]?.( d ); } if( d.method === 'Runtime.exceptionThrown' ) errors.push( d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text ); if( d.method === 'Log.entryAdded' && d.params.entry.level === 'error' ) errors.push( d.params.entry.text ); };
const cdp = ( method, params = {} ) => new Promise( ok => { const i = ++id; pending[ i ] = ok; ws.send( JSON.stringify( { id: i, method, params } ) ); } );
const ev = async e => { const r = await cdp( 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true } ); if( r.result.exceptionDetails ) throw new Error( r.result.exceptionDetails.exception?.description ); return r.result.result.value; };
const shot = async n => { const r = await cdp( 'Page.captureScreenshot', { format: 'png' } ); fs.writeFileSync( path.join( shots, n + '.png' ), Buffer.from( r.result.data, 'base64' ) ); };
let fails = 0; const ok = ( c, w ) => { console.log( ( c ? '  ok   ' : '  FAIL ' ) + w ); if( ! c ) fails++; };

const device = ( w, h, touch, dark ) => Promise.all( [
    cdp( 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: touch ? 3 : 1, mobile: touch } ),
    cdp( 'Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 2 } ),
    cdp( 'Emulation.setEmulatedMedia', { features: [ { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' } ] } ) ] );
const load = async () => { await cdp( 'Page.navigate', { url } ); await wait( 500 ); };
const board = at => ev( `(()=>{const S=MachinesPoC.state,c=document.getElementById('view').getBoundingClientRect(),s=Math.min(c.width/S.scene.w,c.height/S.scene.h)*S.zoom,ox=(c.width-S.scene.w*s)/2+S.panX,oy=(c.height-S.scene.h*s)/2+S.panY;return {x:c.left+ox+${ at[ 0 ] }*s,y:c.top+oy+${ at[ 1 ] }*s}})()` );
const touch = ( type, pts ) => cdp( 'Input.dispatchTouchEvent', { type, touchPoints: pts.map( ( p, i ) => ( { x: p.x, y: p.y, id: i } ) ) } );
const tapAt = async at => { const p = await board( at ); await touch( 'touchStart', [ p ] ); await touch( 'touchEnd', [] ); await wait( 30 ); };
const tool = async t => { const b = await ev( `(()=>{const r=document.querySelector('[data-tool=${ t }]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()` ); await touch( 'touchStart', [ b ] ); await touch( 'touchEnd', [] ); await wait( 60 ); };
const button = async i => { const b = await ev( `(()=>{const r=document.getElementById('${ i }').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()` ); await touch( 'touchStart', [ b ] ); await touch( 'touchEnd', [] ); await wait( 350 ); };
// A finger drag; the page aims above a moving finger, so the finger ends below the target.
const drag = async ( a, b ) =>
{
    const p = await board( a ), q = await board( b ); q.y += 56;
    await touch( 'touchStart', [ p ] );
    for( let i = 1; i <= 8; i++ ) { await touch( 'touchMove', [ { x: p.x + ( q.x - p.x ) * i / 8, y: p.y + ( q.y - p.y ) * i / 8 } ] ); await wait( 16 ); }
    await touch( 'touchEnd', [] ); await wait( 30 );
};
const untilDone = async ms => { for( let t = 0; t < ms; t += 100 ) { const s = await ev( `MachinesPoC.state.sim&&MachinesPoC.state.sim.state` ); if( s && s !== 'running' ) return s; await wait( 100 ); } return 'timeout'; };

await cdp( 'Page.enable' ); await cdp( 'Runtime.enable' ); await cdp( 'Log.enable' );

console.log( 'Phone, portrait: build the gears room by finger, from empty' );
await device( 390, 844, true, false ); await load();
const targets = await ev( `[...document.querySelectorAll('button:not([hidden]),select')].filter(b=>b.offsetParent).map(b=>{const r=b.getBoundingClientRect();return [b.id||b.dataset.tool,Math.round(r.width),Math.round(r.height)]})` );
ok( targets.every( t => t[ 1 ] >= 44 && t[ 2 ] >= 44 ), 'every control is at least 44 px: ' + targets.filter( t => t[ 1 ] < 44 || t[ 2 ] < 44 ).join( ' ' ) );
ok( await ev( `document.documentElement.scrollWidth<=innerWidth` ), 'no sideways page scroll' );
const inside = () => ev( `[...document.querySelectorAll('header button:not([hidden])')].every(b=>b.getBoundingClientRect().right<=innerWidth)` );
ok( await inside(), 'header fits while building' );
await tool( 'gear' ); await tapAt( [ 4, 6 ] ); await tapAt( [ 7, 6 ] ); await tapAt( [ 7, 6 ] );   // second tap: size 2
await tool( 'axle' ); await tapAt( [ 4, 6 ] ); await tapAt( [ 7, 6 ] );
await tool( 'motor' ); await tapAt( [ 4, 6 ] );
await tool( 'beam' ); await drag( [ 7, 6 ], [ 7, 9 ] );
await tool( 'bolt' ); await tapAt( [ 7, 8 ] );
const built = await ev( `JSON.stringify(MachinesPoC.state.build)` );
console.log( '  built: ' + built );
ok( built.includes( '"a":[7,6],"b":[7,9]' ), 'finger drag laid the beam on the right points' );
ok( await ev( `Machines.check(MachinesPoC.state.build).links.length` ) === 1, 'gears show as meshed' );
await shot( 'phone-build' );
await button( 'run' ); await wait( 1500 ); await shot( 'phone-run' );
ok( await inside(), 'header fits while running' );
ok( await untilDone( 8000 ) === 'won', 'the hand-built machine solves the room' );
await shot( 'phone-won' );
await button( 'run' );
ok( await ev( `JSON.stringify(MachinesPoC.state.build)` ) === built && await ev( `MachinesPoC.state.sim===null` ), 'Stop puts everything back exactly' );

console.log( 'Editing by finger' );
await tool( 'move' ); await drag( [ 4, 6 ], [ 4, 5 ] );
ok( await ev( `MachinesPoC.state.build.filter(p=>p.at&&p.at[0]===4).every(p=>p.at[1]===5)` ), 'moving a gear carries its axle and motor' );
await tool( 'erase' ); await tapAt( [ 7, 9 ] );
ok( ! ( await ev( `JSON.stringify(MachinesPoC.state.build)` ) ).includes( '"beam"' ), 'delete removes the beam' );
ok( ! ( await ev( `JSON.stringify(MachinesPoC.state.build)` ) ).includes( '"bolt"' ), '...and the bolt it held' );
const z0 = await ev( 'MachinesPoC.state.zoom' ), c = { x: 195, y: 300 };
await touch( 'touchStart', [ { x: c.x - 30, y: c.y }, { x: c.x + 30, y: c.y } ] );
for( let i = 1; i <= 6; i++ ) { await touch( 'touchMove', [ { x: c.x - 30 - i * 15, y: c.y }, { x: c.x + 30 + i * 15, y: c.y } ] ); await wait( 16 ); }
await touch( 'touchEnd', [] );
ok( await ev( 'MachinesPoC.state.zoom' ) > z0 * 1.5, 'pinch zooms, ' + ( await ev( 'MachinesPoC.state.zoom' ) ).toFixed( 2 ) );
const mid = await ev( `(()=>{const S=MachinesPoC.state,c=document.getElementById('view').getBoundingClientRect(),s=Math.min(c.width/S.scene.w,c.height/S.scene.h)*S.zoom,ox=(c.width-S.scene.w*s)/2+S.panX,oy=(c.height-S.scene.h*s)/2+S.panY;return [Math.round((c.width/2-ox)/s),Math.round((c.height/2-oy)/s)]})()` );
await tool( 'gear' ); await tapAt( mid );
ok( await ev( `MachinesPoC.state.build.some(p=>p.at&&p.at[0]===${ mid[ 0 ] }&&p.at[1]===${ mid[ 1 ] })` ), 'tap lands on the right point when zoomed: ' + mid );
await shot( 'phone-zoomed' );

console.log( 'Every stored solution, through the page' );
const scenes = await ev( 'Machines.scenes.length' );
for( let i = 0; i < scenes; i++ )
{
    if( ! await ev( `Machines.scenes[${ i }].solution.length` ) ) continue;
    await ev( `(()=>{const s=document.getElementById('scene');s.value=${ i };s.dispatchEvent(new Event('change'))})()` );
    await button( 'solution' );
    const id = await ev( `Machines.scenes[${ i }].id` );
    await shot( 'scene-' + id );
    await button( 'run' );
    const r = await untilDone( 10000 ); await shot( 'scene-' + id + '-end' );
    const fps = await ev( `Math.round(MachinesPoC.state.fps)` ), ms = await ev( `MachinesPoC.state.stepMs.toFixed(3)` );
    ok( r === 'won', `${ id }: ${ r }, ${ fps } fps, ${ ms } ms per step` );
    await button( 'run' );
}

console.log( 'Other screens' );
await device( 844, 390, true, true ); await load();
await ev( `document.getElementById('solution').click()` ); await wait( 150 );
await shot( 'phone-landscape-dark' );
const lt = await ev( `(()=>{const r=document.getElementById('view').getBoundingClientRect();return [r.width,r.height]})()` );
ok( lt[ 1 ] > 250, 'landscape phone keeps the board usable: ' + lt.map( Math.round ) );
await device( 1280, 800, false, true ); await load();
await ev( `document.getElementById('solution').click()` ); await wait( 150 ); await shot( 'desktop-dark' );
await device( 1280, 800, false, false ); await load();
await ev( `document.getElementById('solution').click()` ); await wait( 150 ); await shot( 'desktop-light' );

ok( ! errors.length, 'no page errors ' + errors.slice( 0, 3 ).join( ' | ' ) );
console.log( fails ? `\n${ fails } FAILED` : '\nALL PASS', '\nshots:', shots );
chrome.kill(); server.close(); ws.close();
process.exit( fails ? 1 : 0 );
