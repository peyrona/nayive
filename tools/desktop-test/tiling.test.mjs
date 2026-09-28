/*
 * tiling.test.mjs - the desktop's window-sizing maths (client/apps/desktop/tiling.js)
 * on its own, no browser: node tools/desktop-test/tiling.test.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const src  = fs.readFileSync( path.join( here, "../../client/apps/desktop/tiling.js" ), "utf8" );
const ctx  = { window: {} };
vm.runInNewContext( src, ctx );
const T = ctx.window.NayiveTiling;

let fails = 0, passes = 0;
function check( name, ok, info )
{
    if( ok ) passes++;
    else { fails++; console.log( "FAIL " + name + ( info !== undefined ? "  " + JSON.stringify( info ) : "" ) ); }
}

// Columns and how many windows each holds, left to right.
function shape( rects )
{
    const per = new Map();
    rects.forEach( r => per.set( r.l, ( per.get( r.l ) || 0 ) + 1 ) );
    return [ ...per.keys() ].sort( ( a, b ) => a - b ).map( k => per.get( k ) ).join( "+" );
}

// Every pixel of the desk covered once (gap 0), all whole pixels, inside the desk.
function coversExactly( rects, W, H )
{
    let area = 0;
    for( const r of rects )
    {
        if( ! [ r.l, r.t, r.w, r.h ].every( Number.isInteger ) ) return "not whole pixels";
        if( r.l < 0 || r.t < 0 || r.l + r.w > W || r.t + r.h > H ) return "outside the desk";
        area += r.w * r.h;
        for( const q of rects )
            if( q !== r && r.l < q.l + q.w && q.l < r.l + r.w && r.t < q.t + q.h && q.t < r.t + r.h ) return "overlap";
    }
    return area === W * H ? "" : "area " + area + " != " + W * H;
}

// --- TILE: the small counts the spec names, on a wide desk
const W = 1920, H = 1032;
check( "0 windows -> nothing", T.tile( 0, W, H ).length === 0 );
check( "1 window -> the whole desk", JSON.stringify( T.tile( 1, W, H ) ) === JSON.stringify( [ { l: 0, t: 0, w: W, h: H } ] ) );
check( "2 windows side by side", shape( T.tile( 2, W, H ) ) === "1+1" );
const three = T.tile( 3, W, H );
check( "3 windows: one tall left, two stacked right", shape( three ) === "1+2" && three[ 0 ].h === H && three[ 1 ].l === three[ 2 ].l, three );
check( "4 windows: 2 x 2", shape( T.tile( 4, W, H ) ) === "2+2" );
check( "5 windows: 1 + 2 + 2 (fewer on the left)", shape( T.tile( 5, W, H ) ) === "1+2+2" );
check( "6 windows: 3 columns of 2", shape( T.tile( 6, W, H ) ) === "2+2+2" );

// --- TILE: a tall desk stacks
check( "2 windows on a tall desk stack", shape( T.tile( 2, 1080, 1872 ) ) === "2" );

// --- TILE: exact cover, whole pixels, for many counts and odd sizes
for( const [ w, h ] of [ [ 1920, 1032 ], [ 1366, 720 ], [ 1023, 551 ], [ 3440, 1392 ], [ 1080, 1872 ], [ 1001, 777 ] ] )
    for( let n = 1; n <= 16; n++ )
    {
        const r = T.tile( n, w, h );
        check( `${n} on ${w}x${h}: ${n} boxes`, r.length === n );
        const why = coversExactly( r, w, h );
        check( `${n} on ${w}x${h}: covers the desk exactly`, why === "", why );
    }

// --- TILE: gaps sit between windows, never at the desk's edges
{
    const r = T.tile( 3, W, H, { gap: 6 } );
    check( "gap: left edge at 0", r[ 0 ].l === 0 && r[ 0 ].t === 0 );
    check( "gap: right edge on the desk's edge", r[ 1 ].l + r[ 1 ].w === W && r[ 2 ].t + r[ 2 ].h === H );
    check( "gap: 6px between columns", r[ 1 ].l - ( r[ 0 ].l + r[ 0 ].w ) === 6 );
    check( "gap: 6px between rows", r[ 2 ].t - ( r[ 1 ].t + r[ 1 ].h ) === 6 );
}

// --- TILE: the same input always gives the same boxes (predictable)
check( "deterministic", JSON.stringify( T.tile( 7, W, H ) ) === JSON.stringify( T.tile( 7, W, H ) ) );

// --- TILE: prefers boxes no smaller than the smallest window
{
    const r = T.tile( 9, 1024, 552, { minW: 320, minH: 200 } );
    const small = r.filter( b => b.w < 320 || b.h < 200 ).length;
    const plain = T.tile( 9, 1024, 552 ).filter( b => b.w < 320 || b.h < 200 ).length;
    check( "min size: never more too-small boxes than without it", small <= plain, { small, plain } );
}
check( "bad input -> nothing", T.tile( 3, 0, 500 ).length === 0 && T.tile( NaN, 500, 500 ).length === 0 );

// --- FIT
{
    const f = T.fit( 900, 700, { w: 800, h: 500 } );
    check( "fit: big enough -> 1:1, laid out as drawn", f.s === 1 && f.lw === 900 && f.lh === 700 );
}
{
    const f = T.fit( 400, 400, { w: 800, h: 500 } );
    check( "fit: narrow -> width decides", Math.abs( f.s - 0.5 ) < 1e-12, f );
    check( "fit: tight side laid out at the natural size", f.lw === 800 );
    check( "fit: loose side laid out LONGER (no empty band)", f.lh === 800 && f.h === 400 );
}
{
    const f = T.fit( 800, 100, { w: 800, h: 500 } );
    check( "fit: short -> height decides", Math.abs( f.s - 0.2 ) < 1e-12 && f.lh === 500 && Math.abs( f.lw - 4000 ) < 1e-9, f );
}
{
    const f = T.fit( 2, 800, { w: 800, h: 500 }, { w: 3840, h: 2064 } );
    check( "fit: no smallest size", f.s > 0 && f.s < 0.01 && Math.abs( f.w - 2 ) < 1e-9 );
    check( "fit: cap holds the loose side, the box follows", f.lh === 2064 && f.h < 800, f );
}
{
    const f = T.fit( 0, 0, { w: 800, h: 500 } );
    check( "fit: zero size is 1px, never NaN", Number.isFinite( f.s ) && f.w >= 1 && f.h >= 1, f );
}

// --- NEED
const base = { outW: 600, outH: 400, viewW: 596, viewH: 352, deskW: 1920, deskH: 1032 };
check( "need: fits -> 0, 0", JSON.stringify( T.need( { ...base, fullW: 596, fullH: 352 } ) ) === '{"w":0,"h":0}' );
check( "need: 1px of rounding is not overflow", JSON.stringify( T.need( { ...base, fullW: 597, fullH: 353 } ) ) === '{"w":0,"h":0}' );
check( "need: 104px too narrow -> 104px wider", T.need( { ...base, fullW: 700, fullH: 352 } ).w === 704 );
check( "need: too short -> taller", T.need( { ...base, fullW: 596, fullH: 452 } ).h === 500 );
check( "need: longer than the desk -> scrolls by design (-1)", T.need( { ...base, fullW: 596, fullH: 3000 } ).h === -1 );
check( "need: wider than the desk -> scrolls by design (-1)", T.need( { ...base, fullW: 4000, fullH: 352 } ).w === -1 );

console.log( ( fails ? "FAILED " : "OK " ) + passes + " passed, " + fails + " failed" );
process.exit( fails ? 1 : 0 );
