// crossbrowser.mjs - do Node, Chromium and Firefox compute the very same physics?
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os'; import vm from 'vm'; import { spawn } from 'child_process';
const dir = import.meta.dirname, got = {};
vm.runInThisContext( fs.readFileSync( path.join( dir, 'vendor/nape.min.js' ), 'utf8' ) + ';globalThis.Nape=Nape' );
for( const f of [ 'sim.js', 'scenes.js' ] ) vm.runInThisContext( fs.readFileSync( path.join( dir, f ), 'utf8' ) );
const M = globalThis.Machines, node = {};
for( const sc of M.scenes ) { if( ! sc.solution.length ) continue; const s = new M.Sim( sc, sc.solution ), t = []; for( let i = 0; i < 720; i++ ) { s.step(); if( i % 120 === 119 ) t.push( s.hash() ); } node[ sc.id ] = t.join( ' ' ) + ' ' + s.state; }
got.node = node;
let done;
const allIn = new Promise( ok => done = ok );
const server = http.createServer( ( q, r ) =>
{
    if( q.url.startsWith( '/report' ) )
    {
        let b = ''; q.on( 'data', d => b += d ); q.on( 'end', () => { const ua = decodeURIComponent( q.url.split( 'ua=' )[ 1 ] ); got[ /Firefox/.test( ua ) ? 'firefox' : 'chromium' ] = JSON.parse( b ); r.end(); if( got.firefox && got.chromium ) done(); } );
        return;
    }
    fs.readFile( path.join( dir, q.url.split( '?' )[ 0 ] ), ( e, d ) => { if( e ) { r.writeHead( 404 ); r.end(); } else { r.writeHead( 200, { 'content-type': q.url.includes( '.js' ) ? 'text/javascript' : 'text/html' } ); r.end( d ); } } );
} );
await new Promise( ok => server.listen( 0, '127.0.0.1', ok ) );
const url = `http://127.0.0.1:${ server.address().port }/crossbrowser.html`;
const home = fs.mkdtempSync( path.join( os.tmpdir(), 'mpoc-x' ) );
const a = spawn( 'chromium', [ '--headless=new', '--no-sandbox', `--user-data-dir=${ home }/c`, url ], { stdio: 'ignore' } );
fs.mkdirSync( home + '/f' );
const b = spawn( 'firefox', [ '--headless', '--no-remote', '--profile', home + '/f', url ], { stdio: 'ignore', env: { ...process.env, HOME: home } } );
await Promise.race( [ allIn, new Promise( ok => setTimeout( ok, 50000 ) ) ] );
a.kill(); b.kill(); server.close();
for( const k of Object.keys( node ) )
{
    const c = got.chromium?.[ k ], f = got.firefox?.[ k ];
    console.log( k.padEnd( 8 ), 'chromium', c === node[ k ] ? 'SAME' : c ? 'DIFFERENT' : 'no data', ' firefox', f === node[ k ] ? 'SAME' : f ? 'DIFFERENT' : 'no data' );
    if( f && f !== node[ k ] ) console.log( '   node ', node[ k ], '\n   ff   ', f );
}
process.exit( 0 );
