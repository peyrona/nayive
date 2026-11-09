/* test.js - headless proof of the physics. Run: node test.js [fuzzRuns]
   It loads the same sim.js the page runs. */
'use strict';
const fs = require( 'fs' ), vm = require( 'vm' ), path = require( 'path' );
for( const f of [ 'vendor/nape.min.js', 'sim.js', 'scenes.js' ] )
    vm.runInThisContext( fs.readFileSync( path.join( __dirname, f ), 'utf8' ) + ( f.includes( 'nape' ) ? ';globalThis.Nape=Nape' : '' ) );
const M = globalThis.Machines;

let fails = 0;
const ok = ( cond, what ) => { console.log( ( cond ? '  ok   ' : '  FAIL ' ) + what ); if( ! cond ) fails++; };

const scene = { w: 24, h: 15, ball: [ 1, 13.9 ], basket: { x: 20, y: 12, w: 3, h: 2.25 } };
const steps = ( s, secs ) => { for( let i = 0; i < secs * 120 && s.state !== 'broken'; i++ ) s.step(); return s; };
const use = b => { const n = {}; b.forEach( p => n[ p.type ] = ( n[ p.type ] || 0 ) + 1 ); return n; };

console.log( 'Scenes: stored solutions' );
for( const sc of M.scenes )
{
    if( ! sc.solution.length ) continue;
    const prints = [];
    let last;
    for( let run = 0; run < 3; run++ )
    {
        const s = new M.Sim( sc, sc.solution );
        let i = 0, trail = [];
        for( ; i < 120 * 25 && s.state === 'running'; i++ ) { s.step(); if( i % 60 === 59 ) trail.push( s.hash() ); }
        prints.push( trail.join() + s.state + i );
        last = { s, i };
    }
    const n = use( sc.solution ), over = Object.keys( n ).filter( k => n[ k ] > ( sc.inventory[ k ] || 0 ) );
    ok( last.s.state === 'won', `${ sc.id }: solved in ${ ( last.i / 120 ).toFixed( 1 ) } s` );
    ok( prints[ 0 ] === prints[ 1 ] && prints[ 1 ] === prints[ 2 ], `${ sc.id }: 3 runs identical, hash ${ last.s.hash() }` );
    ok( ! over.length, `${ sc.id }: solution fits the inventory ${ over }` );
    ok( ! M.check( sc.solution ).problems.length, `${ sc.id }: no warnings` );
    ok( last.s.stats.ropeOver < 0.1 && last.s.stats.ratioErr < 0.01, `${ sc.id }: ratio err ${ last.s.stats.ratioErr.toFixed( 4 ) }, rope over ${ last.s.stats.ropeOver.toFixed( 3 ) } cells` );
}

console.log( 'Gears' );
{
    const b = [ { type:'gear', at:[8,6], r:2 }, { type:'gear', at:[11,6], r:1 }, { type:'gear', at:[15,6], r:3 },
                { type:'axle', at:[8,6] }, { type:'axle', at:[11,6] }, { type:'axle', at:[15,6] }, { type:'motor', at:[8,6], dir:1 } ];
    const s = steps( new M.Sim( scene, b ), 3 ), w = s.bodies.slice( 0, 3 ).map( x => x.angularVel );
    ok( Math.abs( w[ 1 ] / w[ 0 ] + 2 ) < 0.01 && Math.abs( w[ 2 ] / w[ 1 ] + 1 / 3 ) < 0.01, `2:1:3 train turns ${ w.map( x => x.toFixed( 2 ) ) }` );
    const c = M.check( [ { type:'gear', at:[8,6], r:2 }, { type:'gear', at:[11,6], r:1 }, { type:'axle', at:[8,6] } ] );
    ok( c.open.length === 1 && c.links.length === 0, 'gear without an axle does not mesh, and says so' );
    const t = M.check( [ { type:'gear', at:[0,0], r:2 }, { type:'gear', at:[3,4], r:3 }, { type:'axle', at:[0,0] }, { type:'axle', at:[3,4] } ] );
    ok( t.links.length === 1, 'gears mesh on a diagonal too (3-4-5)' );
}

console.log( 'Rope, motor, load' );
const hoist = ( bolts, extra ) =>
{
    const b = [ { type:'axle', at:[8,4] }, { type:'rope', a:[8,4], b:[8,10] }, { type:'pin', at:[8,10] } ].concat( extra );
    for( let i = 0; i < bolts; i++ ) b.push( { type:'beam', a:[6,10], b:[10,10] } );
    if( bolts > 1 ) b.push( { type:'bolt', at:[6,10] } );
    return b;
};
const beamY = s => s.bodies[ s.bodies.length - 2 ].position.y / 40;
{
    const direct = [ { type:'wheel', at:[8,4], r:2 }, { type:'motor', at:[8,4], dir:1 } ];
    const light = steps( new M.Sim( scene, hoist( 1, direct ) ), 2 );
    ok( beamY( light ) < 7, `motor lifts a light load (y 10 -> ${ beamY( light ).toFixed( 1 ) })` );
    const heavy = steps( new M.Sim( scene, hoist( 14, direct ) ), 2 );
    ok( beamY( heavy ) > 9.5, `motor stalls on a heavy load (y ${ beamY( heavy ).toFixed( 1 ) })` );
    // Same motor, same load, through a 1:3 reduction: a small gear drives a big
    // one, and a small drum shares the big one's axle (a beam bolts them together).
    const geared = hoist( 14, [ { type:'gear', at:[8,4], r:3 }, { type:'wheel', at:[8,4], r:1 }, { type:'beam', a:[9,4], b:[11,4] },
        { type:'bolt', at:[9,4] }, { type:'bolt', at:[11,4] }, { type:'gear', at:[4,4], r:1 }, { type:'axle', at:[4,4] }, { type:'motor', at:[4,4], dir:-1 } ] );
    const g = steps( new M.Sim( scene, geared ), 6 );
    ok( beamY( g ) < 9, `gears beat the stall (y ${ beamY( g ).toFixed( 1 ) })` );
    ok( g.stats.ratioErr < 0.05, `...and hold the ratio under load (err ${ g.stats.ratioErr.toFixed( 4 ) })` );
    const free = [ { type:'wheel', at:[8,4], r:1 } ];
    const f = new M.Sim( scene, hoist( 1, free ) );
    const start = beamY( f ), spin = steps( f, 2 ).bodies[ 0 ].angularVel;
    ok( Math.abs( beamY( f ) - start ) < 0.1 && Math.abs( spin ) < 0.5, 'rope fully paid out holds; the drum does not spin' );
}

console.log( 'Reset and pieces' );
{
    const sc = M.scenes[ 0 ], s = new M.Sim( sc, sc.solution );
    for( let i = 0; i < 300; i++ ) s.step();
    const a = s.hash();
    const t = new M.Sim( sc, sc.solution );
    for( let i = 0; i < 300; i++ ) t.step();
    ok( a === t.hash(), 'rebuild from the model = identical run (Stop returns exactly)' );
    const fixed = new M.Sim( scene, [ { type:'beam', a:[4,6], b:[10,6] }, { type:'bolt', at:[4,6] } ] );
    steps( fixed, 1 );
    ok( fixed.bodies[ 0 ].position.y === 6 * 40, 'a lone bolt fixes a piece to the board' );
    const two = new M.Sim( scene, [ { type:'beam', a:[4,6], b:[10,6] }, { type:'axle', at:[4,6] }, { type:'axle', at:[10,6] } ] );
    steps( two, 1 );
    ok( two.bodies[ 0 ].position.y === 6 * 40, 'two axles hold a piece still' );
}

console.log( 'Random machines: does anything blow up?' );
{
    const runs = Number( process.argv[ 2 ] ) || 200;
    let seed = 12345;
    const rnd = n => { seed = ( Math.imul( seed, 1664525 ) + 1013904223 ) >>> 0; return seed % n; };
    const pt = () => [ 2 + rnd( 20 ), 2 + rnd( 11 ) ];
    let broken = 0, lost = 0, bad = [], worst = 0, stepsDone = 0, t0 = Date.now(), crashed = 0;
    for( let r = 0; r < runs; r++ )
    {
        const b = [], n = 4 + rnd( 16 );
        for( let i = 0; i < n; i++ )
        {
            const k = rnd( 7 ), a = pt();
            if( k === 0 ) { const c = pt(); if( ! M.same( a, c ) ) b.push( { type:'beam', a, b:c } ); }
            else if( k === 1 ) b.push( { type:'wheel', at:a, r:1 + rnd( 2 ) } );
            else if( k === 2 ) b.push( { type:'gear', at:a, r:1 + rnd( 3 ) } );
            else if( k === 3 ) { const c = pt(); if( ! M.same( a, c ) ) b.push( { type: rnd( 2 ) ? 'rope' : 'spring', a, b:c, mode: [ undefined, 'push', 'pull' ][ rnd( 3 ) ] } ); }
            else if( k === 4 ) { const h = b.filter( M.isBody ); if( h.length ) { const hs = M.holes( h[ rnd( h.length ) ] ); b.push( { type:[ 'axle', 'pin', 'bolt' ][ rnd( 3 ) ], at: hs[ rnd( hs.length ) ] } ); } }
            else if( k === 5 ) { const d = b.filter( M.isDisc ); if( d.length ) { const q = d[ rnd( d.length ) ]; b.push( { type:'axle', at:q.at } ); b.push( { type:'motor', at:q.at, dir: rnd( 2 ) ? 1 : -1 } ); } }
            else { const h = b.filter( M.isBody ); if( h.length ) { const hs = M.holes( h[ rnd( h.length ) ] ); b.push( { type:'pin', at: hs[ 0 ] } ); } }
        }
        // one connector per point, as the builder allows
        const seen = {}, build = b.filter( p => { if( ! /axle|pin|bolt/.test( p.type ) ) return true; const k = p.at.join(); if( seen[ k ] ) return false; return seen[ k ] = true; } );
        try
        {
            const s = new M.Sim( scene, build );
            for( let i = 0; i < 120 * 10 && s.state !== 'broken'; i++ ) { s.step(); stepsDone++; }
            worst = Math.max( worst, s.stats.maxSpeed );
            if( s.state === 'broken' ) { broken++; if( bad.length < 2 ) bad.push( JSON.stringify( build ) ); }
            if( s.state === 'lost' ) lost++;
        }
        catch( e ) { crashed++; if( bad.length < 2 ) bad.push( e.message.slice( 0, 120 ) + ' ' + JSON.stringify( build ) ); }
    }
    const ms = ( Date.now() - t0 ) / stepsDone;
    console.log( `  ${ runs } machines, 10 s each: ${ broken } blew up, ${ crashed } crashed, ${ lost } ended with the ball lost, top speed ${ worst.toFixed( 0 ) }; ${ ms.toFixed( 3 ) } ms per step` );
    ok( broken === 0 && crashed === 0, 'no blow-ups, no crashes' );
    bad.forEach( x => console.log( '  sample: ' + x.slice( 0, 700 ) ) );
}

console.log( fails ? `\n${ fails } FAILED` : '\nALL PASS' );
process.exit( fails ? 1 : 0 );
