/* machines-board.js - Machines, one of the games of Games: the board. Draws the
   model, or the running simulation, on a Canvas 2D, and turns presses into
   pieces. It only ever changes state.build (and, in design mode, the board's
   own ball, basket, blocks and pulleys); machines-sim.js never sees a press and
   this file never moves a body, which is why Stop can return everything: the
   build was never touched.

   Loaded by machines.html the first time the game opens, after nape,
   machines-sim.js and machines-levels.js. It hands back
   window.MachinesBoard = { enter, leave }.

   TWO MODES. Play: the levels, one after another, each with its own pieces.
   Design: a board of your own, empty or copied from a level, with every piece
   and the tools that place the ball, the basket, blocks and pulleys. Its
   "Level code" is the level as text (the shape of machines-levels.js), to copy
   out or paste in. Nothing is saved yet: the builds live while the page does. */
( function ()
{
    'use strict';

    var M = window.Machines, CELL = M.CELL, LEVELS = window.MachinesLevels;
    var NG = window.NayiveGames, T = NG.T, TF = NG.TF, sfx = NG.sfx;
    var $ = function ( id ) { return document.getElementById( id ); };
    var cv = $( 'mchCanvas' ), ctx = cv.getContext( '2d' );

    var ICON = {
        move:   '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
        beam:   '<path d="M4 18L20 6"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="6" r="1.5"/>',
        wheel:  '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/>',
        gear:   '<circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>',
        rope:   '<path d="M4 5c0 12 16 2 16 14"/>',
        spring: '<path d="M3 12h3l2-6 3 12 3-12 3 12 2-6h2"/>',
        axle:   '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 18v4M7 22h10"/>',
        pin:    '<circle cx="12" cy="12" r="5"/><path d="M4 20L9 15M15 9l5-5"/>',
        bolt:   '<path d="M12 4l7 4v8l-7 4-7-4V8z"/><circle cx="12" cy="12" r="2"/>',
        motor:  '<path d="M18 8a8 8 0 1 0 1 7"/><path d="M18 3v5h-5"/>',
        erase:  '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
        ball:   '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
        basket: '<path d="M4 8v11h16V8"/>',
        block:  '<rect x="3" y="9" width="18" height="6" rx="1" fill="currentColor" stroke="none"/>',
        pulley: '<path d="M12 2v4"/><circle cx="12" cy="11" r="5"/><circle cx="12" cy="11" r="1" fill="currentColor"/><path d="M7 11v10M17 11v7"/>'
    };
    var BUILD_TOOLS  = [ 'move', 'beam', 'wheel', 'gear', 'rope', 'spring', 'axle', 'pin', 'bolt', 'motor', 'erase' ];
    var DESIGN_TOOLS = [ 'ball', 'basket', 'block', 'pulley' ];
    var cap = function ( s ) { return s.charAt( 0 ).toUpperCase() + s.slice( 1 ); };
    var toolName = function ( t ) { return T( 'games.machinesTool' + cap( t ) ); };

    // machines-sim.js says what will not work in English; the player reads it here.
    var PROBLEM = {
        'Gears mesh only when both are on an axle':   'games.machinesGearsNeedAxles',
        'A motor needs a wheel or gear':              'games.machinesMotorNeedsDisc',
        'A motor needs an axle or pin at the centre': 'games.machinesMotorNeedsAxle'
    };

    var copy = function ( x ) { return JSON.parse( JSON.stringify( x ) ); };

    function emptyBoard()
    {
        return { id: 'mine', name: { en: '', es: '', pt: '', fr: '', de: '' }, w: 24, h: 15,
                 ball: [ 3, 13.5 ], basket: { x: 19, y: 12, w: 3.5, h: 2.25 }, blocks: [], pulleys: [], inventory: {} };
    }

    var state = {
        mode: 'play', level: 0, builds: LEVELS.map( function () { return []; } ),
        design: { scene: emptyBoard(), build: [] },
        scene: LEVELS[ 0 ], build: [], tool: 'beam',
        sim: null, zoom: 1, panX: 0, panY: 0,
        pending: null, ghost: null, drag: null, pointers: {}, pinch: null,
        sel: null,               // the chosen piece: { piece } or, in design mode, { scene: { kind, i } }
        last: 0, acc: 0, note: '', live: false, raf: 0
    };

    /* --- theme: the colours are Nayive's own tokens -------------------- */
    var C = {};
    function readTheme()
    {
        var css = getComputedStyle( document.documentElement );
        [ 'bg', 'card', 'card2', 'line', 'text', 'text-dim', 'text-faint', 'accent', 'danger', 'ok', 'warn' ].forEach( function ( k )
        {
            C[ k ] = css.getPropertyValue( '--' + k ).trim();
        } );
    }
    // The theme is html[data-theme] (and the scheme a class or a style on it), not only the system's choice.
    new MutationObserver( readTheme ).observe( document.documentElement, { attributes: true } );
    matchMedia( '(prefers-color-scheme: dark)' ).addEventListener( 'change', readTheme );

    /* --- board <-> screen ---------------------------------------------- */
    var dpr = 1, W = 0, H = 0;
    function fit()
    {
        var r = $( 'mchStage' ).getBoundingClientRect();
        dpr = Math.min( window.devicePixelRatio || 1, 2 );
        W = r.width; H = r.height;
        cv.width = Math.round( W * dpr );
        cv.height = Math.round( H * dpr );
    }
    function scale() { return Math.min( W / state.scene.w, H / state.scene.h ) * state.zoom; }
    function origin()
    {
        var s = scale();
        return { x: ( W - state.scene.w * s ) / 2 + state.panX, y: ( H - state.scene.h * s ) / 2 + state.panY };
    }
    function toBoard( e )
    {
        var r = cv.getBoundingClientRect(), s = scale(), o = origin();
        return { x: ( e.clientX - r.left - o.x ) / s, y: ( e.clientY - r.top - o.y ) / s };
    }
    function snap( p )
    {
        return [ Math.max( 1, Math.min( state.scene.w - 1, Math.round( p.x ) ) ),
                 Math.max( 1, Math.min( state.scene.h - 1, Math.round( p.y ) ) ) ];
    }
    /* The board's own things (ball, basket, blocks) sit on half cells, inside the board. */
    function half( p )
    {
        return [ Math.max( 0, Math.min( state.scene.w, Math.round( p.x * 2 ) / 2 ) ),
                 Math.max( 0, Math.min( state.scene.h, Math.round( p.y * 2 ) / 2 ) ) ];
    }
    /* A finger hides what it points at: once a touch drag is under way, aim
       above the finger. A plain tap stays exactly where it lands. */
    function aim( e, g )
    {
        var p = toBoard( e );
        if( e.pointerType === 'touch' && g && g.moved ) p.y -= 56 / scale();
        return p;
    }

    /* --- the build: every change goes through these ---------------------- */
    function left( type )
    {
        if( state.mode === 'design' ) return Infinity;
        var inv = state.scene.inventory;
        return ( inv[ type ] || 0 ) - state.build.filter( function ( p ) { return p.type === type; } ).length;
    }
    function add( piece )
    {
        if( left( piece.type ) <= 0 ) { say( TF( 'games.machinesNoneLeft', { piece: toolName( piece.type ) } ) ); return false; }
        state.build.push( piece );
        if( M.isBody( piece ) || piece.a ) state.sel = { piece: piece };
        return true;
    }
    function remove( piece )
    {
        var hs = M.holes( piece );
        state.build.splice( state.build.indexOf( piece ), 1 );

        // A bolt or pin that joined this piece to another joins nothing now.
        // Left there, a lone bolt would mean "fixed to the board".
        hs.forEach( function ( h )
        {
            var c = M.connectorAt( state.build, h );
            if( c && c.type !== 'axle' && M.bodiesAt( state.build, h ).length < 2 ) state.build.splice( state.build.indexOf( c ), 1 );
        } );
        prune();
        if( state.sel && state.sel.piece === piece ) state.sel = null;
    }

    /* A connector or motor with nothing at its point goes with the piece. */
    function prune()
    {
        state.build = state.build.filter( function ( p )
        {
            if( ! /axle|pin|bolt|motor/.test( p.type ) ) return true;
            return M.bodiesAt( state.build, p.at ).length > 0;
        } );
    }

    function atPoint( types, at ) { return state.build.filter( function ( p ) { return types.indexOf( p.type ) >= 0 && M.same( p.at, at ); } )[ 0 ]; }

    function segDist( p, a, b )
    {
        var dx = b[ 0 ] - a[ 0 ], dy = b[ 1 ] - a[ 1 ], l = dx * dx + dy * dy;
        var t = l ? Math.max( 0, Math.min( 1, ( ( p.x - a[ 0 ] ) * dx + ( p.y - a[ 1 ] ) * dy ) / l ) ) : 0;
        return Math.hypot( p.x - a[ 0 ] - t * dx, p.y - a[ 1 ] - t * dy );
    }

    /* The piece under a point: small things first, big discs last. */
    function hit( p )
    {
        var best = null, bestD = 0.5, i, q, d;
        for( i = 0; i < state.build.length; i++ )
        {
            q = state.build[ i ];
            if( q.at && ! M.isDisc( q ) ) { d = Math.hypot( p.x - q.at[ 0 ], p.y - q.at[ 1 ] ); if( d < bestD ) { best = q; bestD = d; } }
        }
        if( best ) return best;
        for( i = 0; i < state.build.length; i++ )
        {
            q = state.build[ i ];
            if( q.a ) { d = segDist( p, q.a, q.b ); if( d < bestD ) { best = q; bestD = d; } }
        }
        if( best ) return best;
        for( i = 0; i < state.build.length; i++ )
        {
            q = state.build[ i ];
            if( M.isDisc( q ) && Math.hypot( p.x - q.at[ 0 ], p.y - q.at[ 1 ] ) <= q.r ) { if( ! best || q.r < best.r ) best = q; }
        }
        return best;
    }

    /* Design mode: the board's own thing under a point. Pulleys and the ball
       first (small), then the basket, then the blocks, the last drawn first. */
    function sceneHit( p )
    {
        var sc = state.scene, i, k, b = sc.basket;
        var inside = function ( x, y, w, h ) { return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h; };
        for( i = 0; i < sc.pulleys.length; i++ )
            if( Math.hypot( p.x - sc.pulleys[ i ][ 0 ], p.y - sc.pulleys[ i ][ 1 ] ) < 0.5 ) return { kind: 'pulley', i: i };
        if( Math.hypot( p.x - sc.ball[ 0 ], p.y - sc.ball[ 1 ] ) < 0.7 ) return { kind: 'ball' };
        if( inside( b.x - 0.25, b.y, b.w + 0.5, b.h + 0.25 ) ) return { kind: 'basket' };
        for( i = sc.blocks.length - 1; i >= 0; i-- )
        {
            k = sc.blocks[ i ];
            if( inside( k[ 0 ] - 0.15, k[ 1 ] - 0.15, k[ 2 ] + 0.3, k[ 3 ] + 0.3 ) ) return { kind: 'block', i: i };
        }
        return null;
    }

    function placeBall( at ) { state.scene.ball = [ Math.max( 0.5, Math.min( state.scene.w - 0.5, at[ 0 ] ) ), Math.max( 0.5, Math.min( state.scene.h - 1, at[ 1 ] ) ) ]; }
    function placeBasket( at )
    {
        var b = state.scene.basket;
        b.x = Math.max( 0.25, Math.min( state.scene.w - b.w - 0.25, at[ 0 ] - Math.round( b.w ) / 2 ) );
        b.y = Math.max( 0, Math.min( state.scene.h - 0.5 - b.h - 0.25, at[ 1 ] - Math.round( b.h ) / 2 ) );
    }
    /* A rectangle between two half-cell corners; a flat one is half a cell thick. */
    function rect( a, b, min )
    {
        var x = Math.min( a[ 0 ], b[ 0 ] ), y = Math.min( a[ 1 ], b[ 1 ] );
        return [ x, y, Math.max( min, Math.abs( a[ 0 ] - b[ 0 ] ) ), Math.max( min, Math.abs( a[ 1 ] - b[ 1 ] ) ) ];
    }

    /* before: what was chosen before this press (a tap on a chosen spring changes it). */
    function tapPoint( at, raw, before )
    {
        var t = state.tool, q, sc = state.scene;
        if( t === 'wheel' || t === 'gear' )
        {
            q = atPoint( [ t ], at );
            if( q ) { q.r = q.r % 3 + 1; state.sel = { piece: q }; } else add( { type: t, at: at, r: 1 } );
        }
        else if( t === 'axle' || t === 'pin' || t === 'bolt' )
        {
            q = atPoint( [ 'axle', 'pin', 'bolt' ], at );
            if( ! M.bodiesAt( state.build, at ).length ) { say( T( 'games.machinesNothingThere' ) ); return; }
            if( q ) { var same = q.type === t; remove( q ); if( same ) return; }
            add( { type: t, at: at } );
        }
        else if( t === 'motor' )
        {
            var disc = state.build.filter( function ( p ) { return M.isDisc( p ) && M.same( p.at, at ); } )[ 0 ];
            if( ! disc ) { say( T( 'games.machinesMotorWhere' ) ); return; }
            q = atPoint( [ 'motor' ], at );
            if( ! q ) add( { type: 'motor', at: at, dir: 1 } );
            else if( q.dir === 1 ) q.dir = -1;
            else remove( q );
        }
        else if( t === 'erase' )
        {
            q = hit( raw );
            if( q ) { remove( q ); return; }
            q = state.mode === 'design' && sceneHit( raw );
            if( q && q.kind === 'pulley' ) sc.pulleys.splice( q.i, 1 );
            if( q && q.kind === 'block' ) sc.blocks.splice( q.i, 1 );
            if( q && state.sel && state.sel.scene ) state.sel = null;     // the numbers after it moved down
        }
        else if( t === 'move' )
        {
            q = hit( raw );
            if( q && q.type === 'spring' && before && before.piece === q )
            {
                q.mode = q.mode === 'push' ? 'pull' : q.mode === 'pull' ? undefined : 'push';
                say( T( q.mode === 'push' ? 'games.machinesSpringPush' : q.mode === 'pull' ? 'games.machinesSpringPull' : 'games.machinesSpringRelaxed' ) );
            }
        }
        else if( t === 'beam' || t === 'rope' || t === 'spring' )
        {
            if( ! state.pending ) { state.pending = at; return; }
            line( state.pending, at );
            state.pending = null;
        }
        else if( t === 'ball' ) { placeBall( half( raw ) ); state.sel = { scene: { kind: 'ball' } }; }
        else if( t === 'basket' ) { placeBasket( half( raw ) ); state.sel = { scene: { kind: 'basket' } }; }
        else if( t === 'pulley' )
        {
            var i = sc.pulleys.findIndex( function ( p ) { return M.same( p, at ); } );
            if( i >= 0 ) { sc.pulleys.splice( i, 1 ); if( state.sel && state.sel.scene ) state.sel = null; }
            else { sc.pulleys.push( at ); state.sel = { scene: { kind: 'pulley', i: sc.pulleys.length - 1 } }; }
        }
        else if( t === 'block' ) say( T( 'games.machinesHelpBlock' ) );
    }

    function line( a, b )
    {
        if( M.same( a, b ) ) return;
        var p = { type: state.tool, a: a.slice(), b: b.slice() };
        add( p );
    }

    /* --- presses -------------------------------------------------------- */
    function dragTarget( raw )
    {
        var i, q;
        for( i = 0; i < state.build.length; i++ )
        {
            q = state.build[ i ];
            if( ! q.a ) continue;
            if( Math.hypot( raw.x - q.a[ 0 ], raw.y - q.a[ 1 ] ) < 0.6 ) return { piece: q, end: 'a' };
            if( Math.hypot( raw.x - q.b[ 0 ], raw.y - q.b[ 1 ] ) < 0.6 ) return { piece: q, end: 'b' };
        }
        q = hit( raw );

        // A press on an axle or a motor means the piece under it.
        if( q && q.at && ! M.isBody( q ) )
            q = M.bodiesAt( state.build, q.at ).sort( function ( a, b ) { return ( M.isDisc( b ) ? 1 : 0 ) - ( M.isDisc( a ) ? 1 : 0 ); } )[ 0 ];
        if( ! q || ! ( q.a || M.isDisc( q ) ) )
        {
            var s = state.mode === 'design' && sceneHit( raw );
            return s ? { scene: s, last: half( raw ) } : null;
        }

        return wholeOf( q );
    }

    /* A piece moved whole: what sits only on it travels with it. */
    function wholeOf( q )
    {
        var carried = M.isBody( q ) ? state.build.filter( function ( c )
        {
            if( ! /axle|pin|bolt|motor/.test( c.type ) ) return false;
            var here = M.bodiesAt( state.build, c.at );
            return here.length === 1 && here[ 0 ] === q;
        } ) : [];
        return { piece: q, whole: true, carried: carried };
    }

    function shift( t, dx, dy )
    {
        var p = t.piece, pts = p.a ? [ p.a, p.b ] : [ p.at ], s = state.scene;
        for( var i = 0; i < pts.length; i++ )
            if( pts[ i ][ 0 ] + dx < 1 || pts[ i ][ 0 ] + dx > s.w - 1 || pts[ i ][ 1 ] + dy < 1 || pts[ i ][ 1 ] + dy > s.h - 1 ) return;
        pts.concat( t.carried.map( function ( c ) { return c.at; } ) ).forEach( function ( q ) { q[ 0 ] += dx; q[ 1 ] += dy; } );
    }

    /* Design mode: drag the board's own thing; it stays inside the board. */
    function moveScene( t, raw )
    {
        var s = t.scene, h = half( raw ), dx = h[ 0 ] - t.last[ 0 ], dy = h[ 1 ] - t.last[ 1 ];
        if( s.kind === 'pulley' ) { state.scene.pulleys[ s.i ] = snap( raw ); return; }
        if( ! dx && ! dy ) return;
        t.last = h;
        nudgeScene( s, dx, dy );
    }

    /* ...or step it: a pulley by a cell, the rest by half a cell. */
    function nudgeScene( s, dx, dy )
    {
        var sc = state.scene;
        if( s.kind === 'pulley' )
        {
            var p = sc.pulleys[ s.i ];
            if( p ) sc.pulleys[ s.i ] = [ Math.max( 1, Math.min( sc.w - 1, p[ 0 ] + dx ) ), Math.max( 1, Math.min( sc.h - 1, p[ 1 ] + dy ) ) ];
        }
        else if( s.kind === 'ball' ) placeBall( [ sc.ball[ 0 ] + dx, sc.ball[ 1 ] + dy ] );
        else if( s.kind === 'basket' )
        {
            var b = sc.basket;
            b.x = Math.max( 0.25, Math.min( sc.w - b.w - 0.25, b.x + dx ) );
            b.y = Math.max( 0, Math.min( sc.h - 0.5 - b.h - 0.25, b.y + dy ) );
        }
        else if( sc.blocks[ s.i ] )
        {
            var k = sc.blocks[ s.i ];
            k[ 0 ] = Math.max( 0, Math.min( sc.w - k[ 2 ], k[ 0 ] + dx ) );
            k[ 1 ] = Math.max( 0, Math.min( sc.h - k[ 3 ], k[ 1 ] + dy ) );
        }
    }

    var LINE_TOOLS = /^(beam|rope|spring)$/, RECT_TOOLS = /^(block|basket)$/;

    cv.addEventListener( 'pointerdown', function ( e )
    {
        cv.setPointerCapture( e.pointerId );
        state.pointers[ e.pointerId ] = { x: e.clientX, y: e.clientY };
        var ids = Object.keys( state.pointers );
        if( ids.length === 2 )
        {
            state.drag = null; state.ghost = null;
            var a = state.pointers[ ids[ 0 ] ], b = state.pointers[ ids[ 1 ] ];
            var mid = { clientX: ( a.x + b.x ) / 2, clientY: ( a.y + b.y ) / 2 };
            state.pinch = { d: Math.hypot( a.x - b.x, a.y - b.y ), z: state.zoom, at: toBoard( mid ) };
            return;
        }
        if( ids.length > 2 ) return;
        if( state.sel ) state.sel.carry = null;     // a press may change the build: the keys look again

        var raw = toBoard( e ), g = { x: e.clientX, y: e.clientY, raw: raw, at: snap( raw ), half: half( raw ), moved: false, pan: false };
        if( state.sim ) g.pan = true;
        else if( state.tool === 'move' )
        {
            g.target = dragTarget( raw );
            g.before = state.sel;
            if( g.target ) state.sel = g.target.scene ? { scene: g.target.scene } : { piece: g.target.piece };
            if( g.target && g.target.whole ) g.last = g.at;
            if( ! g.target ) g.pan = true;
        }
        state.drag = g;
    } );

    cv.addEventListener( 'pointermove', function ( e )
    {
        if( ! state.pointers[ e.pointerId ] ) return;
        var was = state.pointers[ e.pointerId ];
        state.pointers[ e.pointerId ] = { x: e.clientX, y: e.clientY };

        if( state.pinch )
        {
            var ids = Object.keys( state.pointers );
            if( ids.length < 2 ) return;
            var a = state.pointers[ ids[ 0 ] ], b = state.pointers[ ids[ 1 ] ], p = state.pinch;
            zoomAt( p.z * Math.hypot( a.x - b.x, a.y - b.y ) / p.d, p.at, ( a.x + b.x ) / 2, ( a.y + b.y ) / 2 );
            return;
        }

        var g = state.drag;
        if( ! g ) return;
        if( Math.hypot( e.clientX - g.x, e.clientY - g.y ) > 8 ) g.moved = true;
        if( ! g.moved ) return;

        if( g.pan )
        {
            state.panX += e.clientX - was.x;
            state.panY += e.clientY - was.y;
            clampPan();
            return;
        }
        var raw = aim( e, g ), at = snap( raw );
        if( g.target && g.target.scene ) moveScene( g.target, raw );
        else if( g.target )
        {
            if( g.target.whole ) { shift( g.target, at[ 0 ] - g.last[ 0 ], at[ 1 ] - g.last[ 1 ] ); g.last = at; }
            else
            {
                var other = g.target.piece[ g.target.end === 'a' ? 'b' : 'a' ];
                if( ! M.same( other, at ) ) g.target.piece[ g.target.end ] = at;
            }
        }
        else if( LINE_TOOLS.test( state.tool ) ) state.ghost = { a: g.at, b: at };
        else if( RECT_TOOLS.test( state.tool ) ) state.ghost = { rect: rect( g.half, half( raw ), state.tool === 'block' ? 0.5 : 1 ) };
        else if( state.tool === 'ball' || state.tool === 'basket' ) state.ghost = { at: half( raw ), free: true };
        else state.ghost = { at: at };
    } );

    function release( e )
    {
        if( ! state.pointers[ e.pointerId ] ) return;
        delete state.pointers[ e.pointerId ];
        if( state.pinch ) { if( ! Object.keys( state.pointers ).length ) state.pinch = null; return; }
        var g = state.drag;
        state.drag = null;
        var ghost = state.ghost;
        state.ghost = null;
        if( ! g || g.pan && g.moved ) return;
        if( state.sim ) return;
        if( ! g.moved && state.tool === 'move' && ! g.target ) state.sel = null;    // a tap on nothing: nothing chosen
        if( ! g.moved ) tapPoint( g.at, g.raw, g.before );
        else if( g.target ) prune();
        else if( ghost && ghost.a ) { state.pending = null; line( ghost.a, ghost.b ); }
        else if( ghost && ghost.rect ) dropRect( ghost.rect );
        else if( ghost && ghost.at ) tapPoint( ghost.at, { x: ghost.at[ 0 ], y: ghost.at[ 1 ] } );
        refresh();
    }
    cv.addEventListener( 'pointerup', release );
    cv.addEventListener( 'pointercancel', function ( e ) { delete state.pointers[ e.pointerId ]; state.pinch = null; state.drag = null; state.ghost = null; } );

    function dropRect( r )
    {
        var sc = state.scene;
        if( state.tool === 'block' ) { sc.blocks.push( r ); state.sel = { scene: { kind: 'block', i: sc.blocks.length - 1 } }; return; }
        state.sel = { scene: { kind: 'basket' } };
        // The basket keeps a wall's width inside the board on each side.
        sc.basket = { x: Math.max( 0.25, Math.min( sc.w - r[ 2 ] - 0.25, r[ 0 ] ) ), y: r[ 1 ], w: Math.min( r[ 2 ], sc.w - 0.5 ), h: r[ 3 ] };
    }

    cv.addEventListener( 'wheel', function ( e )
    {
        e.preventDefault();
        zoomAt( state.zoom * ( e.deltaY < 0 ? 1.15 : 0.87 ), toBoard( e ), e.clientX, e.clientY );
    }, { passive: false } );

    /* Zoom keeping one board point under one screen point. */
    function zoomAt( zoom, at, sx, sy )
    {
        var r = cv.getBoundingClientRect();
        state.zoom = Math.max( 1, Math.min( 4, zoom ) );
        var s = scale();
        state.panX = sx - r.left - at.x * s - ( W - state.scene.w * s ) / 2;
        state.panY = sy - r.top - at.y * s - ( H - state.scene.h * s ) / 2;
        clampPan();
    }

    function clampPan()
    {
        var s = scale(), mx = Math.max( 0, ( state.scene.w * s - W ) / 2 + 40 ), my = Math.max( 0, ( state.scene.h * s - H ) / 2 + 40 );
        state.panX = Math.max( -mx, Math.min( mx, state.panX ) );
        state.panY = Math.max( -my, Math.min( my, state.panY ) );
    }

    /* --- the pieces ------------------------------------------------------ */
    BUILD_TOOLS.concat( DESIGN_TOOLS ).forEach( function ( t )
    {
        var b = document.createElement( 'button' );
        b.type = 'button';
        b.className = 'btn mch-tool';
        b.dataset.tool = t;
        b.dataset.tip = toolName( t );
        b.setAttribute( 'aria-label', toolName( t ) );
        b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[ t ] + '</svg><i></i>';
        // On press, not click: a tap right after a fast drag loses its click.
        var pick = function () { if( state.sim ) return; state.tool = t; state.pending = null; refresh(); };
        b.addEventListener( 'pointerdown', pick );
        b.addEventListener( 'click', pick );
        $( 'mchTools' ).appendChild( b );
    } );

    /* --- levels, modes and the run -------------------------------------- */
    function lang( names ) { var l = Ayni.i18n.lang(); return names && ( names[ l ] || names.en ) || ''; }

    /* The build being shown goes back where it belongs before another is shown. */
    function stash()
    {
        if( state.mode === 'play' ) state.builds[ state.level ] = state.build;
        else state.design.build = state.build;
    }
    function show()
    {
        stop();
        state.pending = null; state.sel = null; state.zoom = 1; state.panX = state.panY = 0;
        if( state.mode === 'play' ) { state.scene = LEVELS[ state.level ]; state.build = state.builds[ state.level ]; }
        else { state.scene = state.design.scene; state.build = state.design.build; }
        refresh();
    }
    function goLevel( i )
    {
        if( i < 0 || i >= LEVELS.length ) return;
        stash();
        state.level = i;
        show();
        say( TF( 'games.machinesLevelName', { n: i + 1, name: lang( LEVELS[ i ].name ) } ) );
    }
    function setMode( m )
    {
        if( m === state.mode ) return;
        stash();
        state.mode = m;
        show();
    }

    /* A new board, or Clear, replaces work that is saved nowhere. Clear is one
       tap and sits by the pieces, so it offers Undo; a board picked from the
       menu is a choice made, and comes in silently. */
    function replace( scene, build, msg )
    {
        var was = { mode: state.mode, level: state.level, scene: state.scene, build: state.build };
        stop();
        if( state.mode === 'design' ) state.design.scene = scene;
        state.build = build;
        stash();
        show();
        if( msg ) Ayni.toast( 'info', msg, { undo: function ()
        {
            if( was.mode === 'design' ) { state.design.scene = was.scene; state.design.build = was.build; }
            else state.builds[ was.level ] = was.build;
            if( state.mode === was.mode && ( was.mode === 'design' || state.level === was.level ) ) show();
        } } );
    }

    function stop()
    {
        state.sim = null;
        $( 'mchWin' ).hidden = true;
    }

    function run()
    {
        if( state.sim ) { stop(); refresh(); return; }
        try { state.sim = new M.Sim( state.scene, state.build ); }
        catch ( e ) { console.error( e ); say( T( 'games.machinesBroken' ) ); return; }
        state.acc = 0; state.last = 0; state.pending = null;
        sfx.play( 'start' );
        refresh();
    }

    function ended( s )
    {
        var w = $( 'mchWin' ), next = $( 'mchWinNext' ), won = s.state === 'won';
        var text = won ? TF( 'games.machinesSolved', { s: s.time.toFixed( 1 ) } )
                 : s.state === 'lost' ? T( 'games.machinesLost' ) : T( 'games.machinesBroken' );
        // Design mode shows the run's fingerprint: the same machine gives the same one on every device.
        if( state.mode === 'design' ) text += ' · #' + s.hash();
        $( 'mchWinText' ).textContent = text;
        w.classList.toggle( 'is-won', won );
        next.hidden = ! ( won && state.mode === 'play' && state.level < LEVELS.length - 1 );
        w.hidden = false;
        sfx.play( won ? 'win' : 'over' );
    }

    function boardMenu()
    {
        var items = [ { label: T( 'games.machinesEmptyBoard' ), icon: 'grid', run: function () { replace( emptyBoard(), [] ); } },
                      { sep: true } ];
        LEVELS.forEach( function ( l, i )
        {
            items.push( { label: TF( 'games.machinesLevelName', { n: i + 1, name: lang( l.name ) } ), run: function ()
            {
                var sc = copy( l ), build = sc.solution || [];
                delete sc.solution;
                replace( sc, build );
            } } );
        } );
        items.push( { sep: true }, { label: T( 'games.machinesCode' ), icon: 'code', run: codeDialog } );
        Ayni.menuAt( items, { anchor: $( 'mchBoard' ) } );
    }

    /* --- the level as text ----------------------------------------------- */
    /* One key per line and one piece per line: the shape of machines-levels.js. */
    function flat( x )
    {
        if( Array.isArray( x ) ) return '[' + x.map( flat ).join( ', ' ) + ']';
        if( x && typeof x === 'object' )
        {
            var k = Object.keys( x ).filter( function ( n ) { return x[ n ] !== undefined; } );
            return k.length ? '{ ' + k.map( function ( n ) { return JSON.stringify( n ) + ': ' + flat( x[ n ] ); } ).join( ', ' ) + ' }' : '{}';
        }
        return JSON.stringify( x );
    }
    function levelText()
    {
        var sc = state.scene, used = {};
        state.build.forEach( function ( p ) { used[ p.type ] = ( used[ p.type ] || 0 ) + 1; } );
        var o = { id: sc.id || 'mine', name: sc.name || {}, w: sc.w, h: sc.h, ball: sc.ball, ballR: sc.ballR, basket: sc.basket,
                  blocks: sc.blocks || [], pulleys: sc.pulleys || [],
                  inventory: state.build.length ? used : sc.inventory || {} };
        return '{\n' + Object.keys( o ).filter( function ( k ) { return o[ k ] !== undefined; } ).map( function ( k ) { return '    ' + JSON.stringify( k ) + ': ' + flat( o[ k ] ); } ).join( ',\n' )
             + ',\n    "solution": [' + ( state.build.length ? '\n' + state.build.map( function ( p ) { return '        ' + flat( p ); } ).join( ',\n' ) + '\n    ' : '' ) + ']\n}';
    }

    /* The text back into a board, or an exception: nothing half-read reaches the game. */
    function readLevel( text )
    {
        var o = JSON.parse( text ), num = function ( x ) { return typeof x === 'number' && isFinite( x ); };
        var pt = function ( p ) { return Array.isArray( p ) && p.length === 2 && num( p[ 0 ] ) && num( p[ 1 ] ); };
        var bad = function () { throw new Error( 'not a board' ); };
        if( ! o || typeof o !== 'object' || ! num( o.w ) || ! num( o.h ) || o.w < 4 || o.h < 4 || o.w > 80 || o.h > 60 ) bad();
        if( ! pt( o.ball ) || ! o.basket || ! [ 'x', 'y', 'w', 'h' ].every( function ( k ) { return num( o.basket[ k ] ); } ) ) bad();
        o.blocks = o.blocks || []; o.pulleys = o.pulleys || []; o.inventory = o.inventory || {}; o.solution = o.solution || [];
        if( ! Array.isArray( o.blocks ) || ! o.blocks.every( function ( k ) { return Array.isArray( k ) && k.length === 4 && k.every( num ); } ) ) bad();
        if( ! Array.isArray( o.pulleys ) || ! o.pulleys.every( pt ) || ! Array.isArray( o.solution ) ) bad();
        o.solution.forEach( function ( p )
        {
            if( ! p || BUILD_TOOLS.indexOf( p.type ) < 1 || p.type === 'erase' ) bad();
            if( /^(beam|rope|spring)$/.test( p.type ) ? ! pt( p.a ) || ! pt( p.b ) : ! pt( p.at ) ) bad();
            if( M.isDisc( p ) && [ 1, 2, 3 ].indexOf( p.r ) < 0 ) bad();
            if( p.type === 'motor' && p.dir !== 1 && p.dir !== -1 ) bad();
        } );
        return o;
    }

    function codeDialog()
    {
        var dl = Ayni.dialog( { title: T( 'games.machinesCodeTitle' ), cls: 'mch-code-dialog' } );
        var lead = document.createElement( 'p' ), ta = document.createElement( 'textarea' );
        lead.className = 'text';
        lead.textContent = T( 'games.machinesCodeLead' );
        ta.className = 'input mch-code';
        ta.spellcheck = false;
        ta.setAttribute( 'autocapitalize', 'off' );
        ta.setAttribute( 'aria-label', T( 'games.machinesCodeTitle' ) );
        ta.value = levelText();
        dl.body.append( lead, ta );

        var close = Ayni.dialogButton( 'close', T( 'ui.close' ) );
        var cp = Ayni.dialogButton( '', T( 'games.machinesCopy' ), 'copy' );
        var ok = Ayni.dialogButton( 'primary', T( 'games.machinesLoad' ) );
        dl.place( [ close, cp, ok ] );
        close.addEventListener( 'click', function () { dl.close(); } );
        cp.addEventListener( 'click', function ()
        {
            var done = function () { Ayni.toast( 'ok', T( 'games.machinesCopied' ) ); };
            if( navigator.clipboard && navigator.clipboard.writeText ) navigator.clipboard.writeText( ta.value ).then( done, function () { ta.select(); } );
            else { ta.select(); if( document.execCommand( 'copy' ) ) done(); }
        } );
        ok.addEventListener( 'click', function ()
        {
            var o;
            try { o = readLevel( ta.value ); }
            catch ( e ) { ta.setAttribute( 'aria-invalid', 'true' ); Ayni.toast( 'warn', T( 'games.machinesBadCode' ) ); return; }
            var build = o.solution;
            delete o.solution;
            dl.close();
            replace( o, build );
        } );
        ta.addEventListener( 'input', function () { ta.removeAttribute( 'aria-invalid' ); } );
        dl.show();
    }

    /* --- the toolbar ----------------------------------------------------- */
    $( 'mchPlay' ).addEventListener( 'click', function () { setMode( 'play' ); } );
    $( 'mchDesign' ).addEventListener( 'click', function () { setMode( 'design' ); } );
    $( 'mchPrev' ).addEventListener( 'click', function () { goLevel( state.level - 1 ); } );
    $( 'mchNext' ).addEventListener( 'click', function () { goLevel( state.level + 1 ); } );
    $( 'mchWinNext' ).addEventListener( 'click', function () { goLevel( state.level + 1 ); } );
    $( 'mchBoard' ).addEventListener( 'click', boardMenu );
    $( 'mchRun' ).addEventListener( 'click', run );
    $( 'mchClear' ).addEventListener( 'click', function ()
    {
        if( state.sim || ! state.build.length ) return;
        replace( state.scene, [], T( 'games.machinesCleared' ) );
    } );

    /* The arrow keys move the chosen piece: build pieces by a grid point, the
       board's own things by half a cell (a pulley by one). Del (or Backspace,
       the Mac's delete key) removes it; the ball and the basket stay. Not while
       it runs, nor while a dialog, a menu or a field has the keys. */
    var STEPS = { ArrowLeft: [ -1, 0 ], ArrowRight: [ 1, 0 ], ArrowUp: [ 0, -1 ], ArrowDown: [ 0, 1 ] };
    document.addEventListener( 'keydown', function ( e )
    {
        var d = STEPS[ e.key ], del = e.key === 'Delete' || e.key === 'Backspace', sel = state.sel;
        if( ! ( d || del ) || ! sel || ! state.live || state.sim || e.ctrlKey || e.altKey || e.metaKey ) return;
        if( NG.keyBusy( e ) || document.querySelector( '.panel.menu:popover-open' ) ) return;
        if( sel.piece && state.build.indexOf( sel.piece ) < 0 ) return;
        e.preventDefault();
        if( del )
        {
            var sc = state.scene, s = sel.scene;
            if( sel.piece ) remove( sel.piece );
            else if( s.kind === 'pulley' || s.kind === 'block' ) { ( s.kind === 'pulley' ? sc.pulleys : sc.blocks ).splice( s.i, 1 ); state.sel = null; }
            refresh();
            return;
        }
        // What travels with it is fixed at the first step, as a drag fixes it at its start:
        // passing over another piece's hole must not drop the axle there.
        if( sel.piece ) { sel.carry = sel.carry || wholeOf( sel.piece ); shift( sel.carry, d[ 0 ], d[ 1 ] ); prune(); }
        else { var k = sel.scene.kind === 'pulley' ? 1 : 0.5; nudgeScene( sel.scene, d[ 0 ] * k, d[ 1 ] * k ); }
        refresh();
    } );

    function say( text ) { state.note = text; clearTimeout( say.t ); say.t = setTimeout( function () { state.note = ''; refresh(); }, 2500 ); refresh(); }

    function refresh()
    {
        var on = !! state.sim, design = state.mode === 'design';
        var tip = function ( el, k ) { Ayni.setTip( el, T( k ) ); el.setAttribute( 'aria-label', T( k ) ); };

        $( 'mchPlay' ).setAttribute( 'aria-pressed', ! design );
        $( 'mchDesign' ).setAttribute( 'aria-pressed', design );
        $( 'mchPager' ).hidden = design;
        $( 'mchBoard' ).hidden = ! design;
        $( 'mchLevel' ).textContent = ( state.level + 1 ) + ' / ' + LEVELS.length;
        $( 'mchLevel' ).title = lang( LEVELS[ state.level ].name );
        $( 'mchPrev' ).setAttribute( 'aria-disabled', state.level === 0 );
        $( 'mchNext' ).setAttribute( 'aria-disabled', state.level === LEVELS.length - 1 );
        $( 'mchClear' ).setAttribute( 'aria-disabled', on || ! state.build.length );
        // toggleAttribute, not .hidden: an <svg> has no hidden property, only the attribute.
        $( 'mchRun' ).querySelector( '[data-ic="run"]' ).toggleAttribute( 'hidden', on );
        $( 'mchRun' ).querySelector( '[data-ic="stop"]' ).toggleAttribute( 'hidden', ! on );
        tip( $( 'mchRun' ), on ? 'games.machinesStop' : 'games.machinesRun' );

        var inv = state.scene.inventory;
        document.querySelectorAll( '.mch-tool' ).forEach( function ( b )
        {
            var t = b.dataset.tool, real = t !== 'move' && t !== 'erase', n = left( t );
            b.setAttribute( 'aria-pressed', t === state.tool );
            b.setAttribute( 'aria-disabled', on );
            b.hidden = DESIGN_TOOLS.indexOf( t ) >= 0 ? ! design : real && ! design && ! inv[ t ];
            b.querySelector( 'i' ).textContent = real && ! design && DESIGN_TOOLS.indexOf( t ) < 0 ? n : '';
        } );
        if( $( 'mchTools' ).querySelector( '[aria-pressed="true"]' ).hidden ) { state.tool = 'move'; return refresh(); }

        var problems = on ? [] : M.check( state.build ).problems;
        var problem = problems[ 0 ] && ( PROBLEM[ problems[ 0 ] ] ? T( PROBLEM[ problems[ 0 ] ] ) : problems[ 0 ] );
        $( 'mchNote' ).textContent = state.note || problem || ( on ? '' : toolName( state.tool ) + ': ' + T( 'games.machinesHelp' + cap( state.tool ) ) );
    }

    /* --- the loop ------------------------------------------------------- */
    function frame( now )
    {
        state.raf = requestAnimationFrame( frame );
        var dt = state.last ? Math.min( 0.05, ( now - state.last ) / 1000 ) : 0;
        state.last = now;

        var s = state.sim;
        if( s && s.state === 'running' )
        {
            state.acc += dt;
            while( state.acc >= M.DT && s.state === 'running' ) { s.step(); state.acc -= M.DT; }
            if( s.state !== 'running' ) ended( s );
        }
        draw();
    }

    /* --- drawing, in cell units ---------------------------------------- */
    function draw()
    {
        if( ! W || ! H ) return;
        var s = scale(), o = origin();
        ctx.setTransform( dpr, 0, 0, dpr, 0, 0 );
        ctx.clearRect( 0, 0, W, H );
        ctx.fillStyle = C.bg;
        ctx.fillRect( 0, 0, W, H );
        ctx.setTransform( dpr * s, 0, 0, dpr * s, dpr * o.x, dpr * o.y );
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';

        var sc = state.scene;
        ctx.fillStyle = C.card2;
        ctx.fillRect( 0, 0, sc.w, sc.h );

        if( ! state.sim ) { drawGrid( sc ); drawChosen( sc ); }
        drawScene( sc );

        var phases = gearPhases();
        var map = state.sim ? livePoint : function ( p, at ) { return { x: at[ 0 ], y: at[ 1 ] }; };
        var angle = function ( p ) { return state.sim ? state.sim.pose( p ).rot : 0; };

        state.build.forEach( function ( p ) { if( p.type === 'beam' ) drawBeam( p, map ); } );
        state.build.forEach( function ( p ) { if( M.isDisc( p ) ) drawDisc( p, map( p, p.at ), angle( p ), phases ); } );
        drawLines( map );
        state.build.forEach( function ( p ) { if( /axle|pin|bolt|motor/.test( p.type ) ) drawConnector( p, map ); } );
        if( ! state.sim ) { drawMeshMarks(); drawHoles(); }
        drawBall();
        if( ! state.sim ) drawAim();
    }

    /* The chosen piece: a soft accent halo, drawn under it. */
    function drawChosen( sc )
    {
        var sel = state.sel, p = sel && sel.piece, s = sel && sel.scene, k;
        if( ! sel ) return;
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = ctx.strokeStyle = C.accent;
        var disc = function ( x, y, r ) { ctx.beginPath(); ctx.arc( x, y, r, 0, 7 ); ctx.fill(); };
        if( p && state.build.indexOf( p ) >= 0 )
        {
            if( M.isDisc( p ) ) disc( p.at[ 0 ], p.at[ 1 ], p.r + 0.3 );
            else
            {
                ctx.lineWidth = ( p.type === 'beam' ? M.THICK : 0.1 ) + 0.45;
                ctx.beginPath(); ctx.moveTo( p.a[ 0 ], p.a[ 1 ] ); ctx.lineTo( p.b[ 0 ], p.b[ 1 ] ); ctx.stroke();
            }
        }
        else if( s && s.kind === 'ball' ) disc( sc.ball[ 0 ], sc.ball[ 1 ], ( sc.ballR || 0.45 ) + 0.3 );
        else if( s && s.kind === 'pulley' && sc.pulleys[ s.i ] ) disc( sc.pulleys[ s.i ][ 0 ], sc.pulleys[ s.i ][ 1 ], 0.6 );
        else if( s && s.kind === 'basket' ) ctx.fillRect( sc.basket.x - 0.55, sc.basket.y - 0.3, sc.basket.w + 1.1, sc.basket.h + 0.85 );
        else if( s && s.kind === 'block' && ( k = sc.blocks[ s.i ] ) ) ctx.fillRect( k[ 0 ] - 0.3, k[ 1 ] - 0.3, k[ 2 ] + 0.6, k[ 3 ] + 0.6 );
        ctx.restore();
    }

    /* Where a build point is now: it moves with the piece it belongs to. */
    function livePoint( p, at )
    {
        var q = state.sim.pose( p ), dx = at[ 0 ] * CELL - q.cx, dy = at[ 1 ] * CELL - q.cy;
        var c = Math.cos( q.rot ), n = Math.sin( q.rot );
        return { x: ( q.x + c * dx - n * dy ) / CELL, y: ( q.y + n * dx + c * dy ) / CELL };
    }

    function drawGrid( sc )
    {
        ctx.fillStyle = C[ 'text-faint' ];
        for( var x = 1; x < sc.w; x++ )
            for( var y = 1; y < sc.h; y++ ) { ctx.beginPath(); ctx.arc( x, y, 0.035, 0, 7 ); ctx.fill(); }
    }

    function drawScene( sc )
    {
        ctx.fillStyle = C.line;
        ctx.fillRect( 0, sc.h - 0.5, sc.w, 0.5 );
        ( sc.blocks || [] ).forEach( function ( k ) { ctx.fillRect( k[ 0 ], k[ 1 ], k[ 2 ], k[ 3 ] ); } );

        var b = sc.basket;
        ctx.strokeStyle = C.ok; ctx.lineWidth = 0.25;
        ctx.beginPath();
        ctx.moveTo( b.x - 0.125, b.y ); ctx.lineTo( b.x - 0.125, b.y + b.h + 0.125 );
        ctx.lineTo( b.x + b.w + 0.125, b.y + b.h + 0.125 ); ctx.lineTo( b.x + b.w + 0.125, b.y );
        ctx.stroke();

        ( sc.pulleys || [] ).forEach( function ( p )
        {
            ctx.strokeStyle = C.warn; ctx.lineWidth = 0.08;
            ctx.beginPath(); ctx.arc( p[ 0 ], p[ 1 ], 0.3, 0, 7 ); ctx.stroke();
            ctx.fillStyle = C.warn;
            ctx.beginPath(); ctx.arc( p[ 0 ], p[ 1 ], 0.08, 0, 7 ); ctx.fill();
        } );
    }

    function drawBall()
    {
        var p = state.sim ? state.sim.ball.position : { x: state.scene.ball[ 0 ] * CELL, y: state.scene.ball[ 1 ] * CELL };
        var rot = state.sim ? state.sim.ball.rotation : 0, r = state.scene.ballR || 0.45;
        var x = p.x / CELL, y = p.y / CELL;
        ctx.fillStyle = C.danger;
        ctx.beginPath(); ctx.arc( x, y, r, 0, 7 ); ctx.fill();
        ctx.strokeStyle = C.card2; ctx.lineWidth = 0.06;
        ctx.beginPath(); ctx.moveTo( x, y ); ctx.lineTo( x + Math.cos( rot ) * r * 0.75, y + Math.sin( rot ) * r * 0.75 ); ctx.stroke();
    }

    function drawBeam( p, map )
    {
        var a = map( p, p.a ), b = map( p, p.b );
        ctx.strokeStyle = C.accent; ctx.lineWidth = M.THICK;
        ctx.beginPath(); ctx.moveTo( a.x, a.y ); ctx.lineTo( b.x, b.y ); ctx.stroke();
        ctx.fillStyle = C.card2;
        M.holes( p ).forEach( function ( h )
        {
            var q = map( p, h );
            ctx.beginPath(); ctx.arc( q.x, q.y, 0.06, 0, 7 ); ctx.fill();
        } );
    }

    function drawDisc( p, at, rot, phases )
    {
        ctx.save();
        ctx.translate( at.x, at.y );
        ctx.rotate( rot + ( phases.get( p ) || 0 ) );
        var col = C[ 'text-dim' ];
        if( p.type === 'gear' )
        {
            var n = 8 * p.r, r = p.r, i;
            ctx.fillStyle = col;
            ctx.beginPath();
            for( i = 0; i < n; i++ )
            {
                var a = i * 2 * Math.PI / n, w = Math.PI / n;
                pt( r - 0.14, a - w * 0.95 ); pt( r - 0.14, a - w * 0.45 ); pt( r + 0.14, a - w * 0.28 ); pt( r + 0.14, a + w * 0.28 ); pt( r - 0.14, a + w * 0.45 );
            }
            ctx.closePath(); ctx.fill();
        }
        else
        {
            ctx.fillStyle = C.text;
            ctx.beginPath(); ctx.arc( 0, 0, p.r, 0, 7 ); ctx.fill();
        }
        ctx.fillStyle = C.card2;
        ctx.beginPath(); ctx.arc( 0, 0, p.r * 0.62, 0, 7 ); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 0.08;
        for( var k = 0; k < 4; k++ )
        {
            ctx.beginPath(); ctx.moveTo( 0, 0 );
            ctx.lineTo( Math.cos( k * Math.PI / 2 ) * p.r * 0.62, Math.sin( k * Math.PI / 2 ) * p.r * 0.62 ); ctx.stroke();
        }
        ctx.restore();
    }
    function pt( r, a ) { ctx.lineTo( Math.cos( a ) * r, Math.sin( a ) * r ); }

    /* Teeth must sit in each other's gaps at the start; the ratio keeps them
       there. Walks the mesh from each first gear. */
    function gearPhases()
    {
        var map = new Map(), links = M.check( state.build ).links.concat(), moved = true;
        while( moved )
        {
            moved = false;
            for( var i = 0; i < links.length; i++ )
            {
                var a = links[ i ][ 0 ], b = links[ i ][ 1 ];
                if( ! map.has( a ) && ! map.has( b ) ) map.set( a, 0 );
                if( map.has( a ) && map.has( b ) ) continue;
                var from = map.has( a ) ? a : b, to = from === a ? b : a;
                var phi = Math.atan2( to.at[ 1 ] - from.at[ 1 ], to.at[ 0 ] - from.at[ 0 ] );
                var nf = 8 * from.r, nt = 8 * to.r, u = ( phi - map.get( from ) ) * nf / ( 2 * Math.PI );
                map.set( to, phi + Math.PI - ( 0.5 - u ) * 2 * Math.PI / nt );
                moved = true;
            }
        }
        return map;
    }

    function drawMeshMarks()
    {
        var c = M.check( state.build );
        var mark = function ( g, col )
        {
            var a = g[ 0 ].at, b = g[ 1 ].at, t = g[ 0 ].r / ( g[ 0 ].r + g[ 1 ].r );
            ctx.fillStyle = col;
            ctx.beginPath(); ctx.arc( a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, 0.14, 0, 7 ); ctx.fill();
        };
        c.links.forEach( function ( g ) { mark( g, C.ok ); } );
        c.open.forEach( function ( g ) { mark( g, C.danger ); } );
    }

    function drawLines( map )
    {
        var s = state.sim;
        if( s )
        {
            s.ropes.forEach( function ( r )
            {
                var a = liveEnd( r.ends[ 0 ], r ), b = liveEnd( r.ends[ 1 ], r );
                var slack = Math.sqrt( Math.max( 0, r.L * r.L - Math.pow( s.ropeLength( r ), 2 ) ) ) / CELL / 2;
                ctx.strokeStyle = C.warn; ctx.lineWidth = 0.07;
                ctx.beginPath(); ctx.moveTo( a.x, a.y );
                if( r.via ) { ctx.lineTo( r.via[ 0 ], r.via[ 1 ] ); ctx.lineTo( b.x, b.y ); }
                else ctx.quadraticCurveTo( ( a.x + b.x ) / 2, ( a.y + b.y ) / 2 + slack, b.x, b.y );
                ctx.stroke();
            } );
            s.springs.forEach( function ( q ) { var a = M.endPoint( q.ends[ 0 ] ), b = M.endPoint( q.ends[ 1 ] ); zigzag( a.x / CELL, a.y / CELL, b.x / CELL, b.y / CELL, q.piece.mode ); } );
            return;
        }
        state.build.forEach( function ( p )
        {
            if( p.type === 'rope' )
            {
                ctx.strokeStyle = C.warn; ctx.lineWidth = 0.07;
                ctx.beginPath(); ctx.moveTo( p.a[ 0 ], p.a[ 1 ] ); ctx.lineTo( p.b[ 0 ], p.b[ 1 ] ); ctx.stroke();
                endDot( p.a ); endDot( p.b );
            }
            else if( p.type === 'spring' ) { zigzag( p.a[ 0 ], p.a[ 1 ], p.b[ 0 ], p.b[ 1 ], p.mode ); endDot( p.a ); endDot( p.b ); }
        } );
    }
    function endDot( at ) { ctx.fillStyle = C.warn; ctx.beginPath(); ctx.arc( at[ 0 ], at[ 1 ], 0.09, 0, 7 ); ctx.fill(); }

    /* A rope on a drum leaves from the rim, not the centre. */
    function liveEnd( e, r )
    {
        var q = M.endPoint( e ), x = q.x / CELL, y = q.y / CELL;
        if( ! e.drum ) return { x: x, y: y };
        var other = r.via ? { x: r.via[ 0 ], y: r.via[ 1 ] } : ( function () { var o = M.endPoint( r.ends[ 0 ] === e ? r.ends[ 1 ] : r.ends[ 0 ] ); return { x: o.x / CELL, y: o.y / CELL }; } )();
        var dx = other.x - x, dy = other.y - y, l = Math.hypot( dx, dy ) || 1;
        return { x: x - dy / l * e.drum.r, y: y + dx / l * e.drum.r };
    }

    function zigzag( x1, y1, x2, y2, mode )
    {
        var dx = x2 - x1, dy = y2 - y1, l = Math.hypot( dx, dy ) || 1, nx = -dy / l, ny = dx / l, n = 10, amp = 0.2;
        ctx.strokeStyle = mode === 'push' ? C.danger : mode === 'pull' ? C.accent : C.ok;
        ctx.lineWidth = 0.08;
        ctx.beginPath(); ctx.moveTo( x1, y1 );
        for( var i = 1; i < n; i++ )
        {
            var t = i / n, s = i % 2 ? amp : -amp;
            ctx.lineTo( x1 + dx * t + nx * s, y1 + dy * t + ny * s );
        }
        ctx.lineTo( x2, y2 ); ctx.stroke();
    }

    function drawConnector( c, map )
    {
        var host = M.bodiesAt( state.build, c.at )[ 0 ];
        if( ! host ) return;
        var p = map( host, c.at );
        if( c.type === 'axle' )
        {
            ctx.fillStyle = C.text; ctx.beginPath(); ctx.arc( p.x, p.y, 0.2, 0, 7 ); ctx.fill();
            ctx.fillStyle = C.card2; ctx.beginPath(); ctx.arc( p.x, p.y, 0.07, 0, 7 ); ctx.fill();
        }
        else if( c.type === 'pin' )
        {
            ctx.fillStyle = C.card2; ctx.strokeStyle = C.text; ctx.lineWidth = 0.06;
            ctx.beginPath(); ctx.arc( p.x, p.y, 0.15, 0, 7 ); ctx.fill(); ctx.stroke();
        }
        else if( c.type === 'bolt' )
        {
            ctx.fillStyle = C.text;
            ctx.beginPath();
            for( var i = 0; i < 6; i++ ) ctx.lineTo( p.x + Math.cos( i * Math.PI / 3 ) * 0.17, p.y + Math.sin( i * Math.PI / 3 ) * 0.17 );
            ctx.closePath(); ctx.fill();
        }
        else if( c.type === 'motor' )
        {
            // An arc the way it turns, its head on the end: the tip travels along the
            // tangent (t), and the two barbs point back from it.
            var d = c.dir > 0 ? 1 : -1, s = state.sim ? state.sim.time * d * 3 : 0, r = 0.42, e = s + 4.6 * d;
            var ex = p.x + Math.cos( e ) * r, ey = p.y + Math.sin( e ) * r, t = e + d * Math.PI / 2;
            ctx.strokeStyle = C.danger; ctx.lineWidth = 0.09;
            ctx.beginPath(); ctx.arc( p.x, p.y, r, s, e, d < 0 ); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo( ex + Math.cos( t + Math.PI - 0.5 ) * 0.2, ey + Math.sin( t + Math.PI - 0.5 ) * 0.2 ); ctx.lineTo( ex, ey );
            ctx.lineTo( ex + Math.cos( t + Math.PI + 0.5 ) * 0.2, ey + Math.sin( t + Math.PI + 0.5 ) * 0.2 ); ctx.stroke();
        }
    }

    function drawHoles()
    {
        ctx.fillStyle = C.accent;
        state.build.forEach( function ( p )
        {
            if( ! M.isDisc( p ) ) return;
            M.holes( p ).slice( 1 ).forEach( function ( h ) { ctx.beginPath(); ctx.arc( h[ 0 ], h[ 1 ], 0.07, 0, 7 ); ctx.fill(); } );
        } );
    }

    function ring( at ) { ctx.strokeStyle = C.accent; ctx.lineWidth = 0.07; ctx.beginPath(); ctx.arc( at[ 0 ], at[ 1 ], 0.3, 0, 7 ); ctx.stroke(); }

    function drawAim()
    {
        if( state.pending ) ring( state.pending );
        var g = state.ghost;
        if( ! g ) return;
        if( g.at ) { ring( g.at ); return; }
        ctx.strokeStyle = C.accent; ctx.lineWidth = 0.1; ctx.globalAlpha = 0.6;
        if( g.rect ) ctx.strokeRect( g.rect[ 0 ], g.rect[ 1 ], g.rect[ 2 ], g.rect[ 3 ] );
        else { ctx.beginPath(); ctx.moveTo( g.a[ 0 ], g.a[ 1 ] ); ctx.lineTo( g.b[ 0 ], g.b[ 1 ] ); ctx.stroke(); }
        ctx.globalAlpha = 1;
        if( g.a ) { ring( g.a ); ring( g.b ); }
    }

    /* --- on screen, off screen ------------------------------------------- */
    new ResizeObserver( function () { fit(); clampPan(); } ).observe( $( 'mchStage' ) );

    function enter()
    {
        if( state.live ) return;
        state.live = true;
        readTheme();
        fit();
        refresh();
        state.last = 0;
        state.raf = requestAnimationFrame( frame );
    }

    // Off screen nothing runs; a machine that was running goes on where it was on the way back.
    function leave()
    {
        state.live = false;
        cancelAnimationFrame( state.raf );
        state.pointers = {}; state.drag = null; state.ghost = null; state.pinch = null;
    }

    window.MachinesBoard = { enter: enter, leave: leave, state: state };
} )();
