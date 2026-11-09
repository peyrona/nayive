/* ui.js - Machines proof of concept: the board. Draws the model, or the running
   simulation, on a Canvas 2D, and turns presses into pieces. It only ever
   changes state.build; sim.js never sees a press and this file never moves a
   body, which is why Stop can return everything: the build was never touched. */
( function ()
{
    'use strict';

    var M = window.Machines, CELL = M.CELL;
    var $ = function ( id ) { return document.getElementById( id ); };
    var cv = $( 'view' ), ctx = cv.getContext( '2d' );

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
        erase:  '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'
    };
    var TOOLS = [ [ 'move', 'Move' ], [ 'beam', 'Beam' ], [ 'wheel', 'Wheel' ], [ 'gear', 'Gear' ], [ 'rope', 'Rope' ],
                  [ 'spring', 'Spring' ], [ 'axle', 'Axle' ], [ 'pin', 'Pin' ], [ 'bolt', 'Bolt' ], [ 'motor', 'Motor' ],
                  [ 'erase', 'Delete' ] ];
    var HELP = {
        move: 'Drag a piece, or the end of a beam. Tap a spring to change it',
        beam: 'Drag from point to point, or tap both ends',
        wheel: 'Tap a point. Tap the wheel again for another size',
        gear: 'Tap a point. Gears mesh when they touch, both on an axle',
        rope: 'Drag between two points. At a pulley, tie two ropes to run over it',
        spring: 'Drag between two points',
        axle: 'Tap a hole: it turns there, held to the board',
        pin: 'Tap a hole where two pieces meet: they hinge',
        bolt: 'Tap a hole: pieces become one. Alone, a piece is fixed to the board',
        motor: 'Tap the centre of a wheel or gear on an axle or pin',
        erase: 'Tap a piece'
    };

    var state = {
        scene: M.scenes[ 0 ], build: [], tool: 'beam',
        sim: null, paused: false, wonAt: 0,
        zoom: 1, panX: 0, panY: 0,
        pending: null, ghost: null, drag: null, pointers: {}, pinch: null,
        last: 0, acc: 0, fps: 60, stepMs: 0, note: ''
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
    matchMedia( '(prefers-color-scheme: dark)' ).addEventListener( 'change', function () { readTheme(); } );

    /* --- board <-> screen ---------------------------------------------- */
    var dpr = 1, W = 0, H = 0;
    function fit()
    {
        var r = $( 'stage' ).getBoundingClientRect();
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
        var inv = state.scene.inventory;
        if( ! Object.keys( inv ).length ) return Infinity;
        return ( inv[ type ] || 0 ) - state.build.filter( function ( p ) { return p.type === type; } ).length;
    }
    function add( piece )
    {
        if( left( piece.type ) <= 0 ) { say( 'No ' + piece.type + ' left' ); return false; }
        state.build.push( piece );
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

    function tapPoint( at, raw )
    {
        var t = state.tool, q;
        if( t === 'wheel' || t === 'gear' )
        {
            q = atPoint( [ t ], at );
            if( q ) q.r = q.r % 3 + 1; else add( { type: t, at: at, r: 1 } );
        }
        else if( t === 'axle' || t === 'pin' || t === 'bolt' )
        {
            q = atPoint( [ 'axle', 'pin', 'bolt' ], at );
            if( ! M.bodiesAt( state.build, at ).length ) { say( 'Nothing at that point' ); return; }
            if( q ) { var same = q.type === t; remove( q ); if( same ) return; }
            add( { type: t, at: at } );
        }
        else if( t === 'motor' )
        {
            var disc = state.build.filter( function ( p ) { return M.isDisc( p ) && M.same( p.at, at ); } )[ 0 ];
            if( ! disc ) { say( 'A motor goes on the centre of a wheel or gear' ); return; }
            q = atPoint( [ 'motor' ], at );
            if( ! q ) add( { type: 'motor', at: at, dir: 1 } );
            else if( q.dir === 1 ) q.dir = -1;
            else remove( q );
        }
        else if( t === 'erase' ) { q = hit( raw ); if( q ) remove( q ); }
        else if( t === 'move' )
        {
            q = hit( raw );
            if( q && q.type === 'spring' ) q.mode = q.mode === 'push' ? 'pull' : q.mode === 'pull' ? undefined : 'push';
            if( q && q.type === 'spring' ) say( 'Spring: ' + ( q.mode || 'relaxed' ) );
        }
        else if( t === 'beam' || t === 'rope' || t === 'spring' )
        {
            if( ! state.pending ) { state.pending = at; return; }
            line( state.pending, at );
            state.pending = null;
        }
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
        if( ! q || ! ( q.a || M.isDisc( q ) ) ) return null;

        // What sits only on this piece travels with it.
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

        var raw = toBoard( e ), g = { x: e.clientX, y: e.clientY, raw: raw, at: snap( raw ), moved: false, pan: false };
        if( state.sim ) g.pan = true;
        else if( state.tool === 'move' )
        {
            g.target = dragTarget( raw );
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
        var at = snap( aim( e, g ) );
        if( g.target )
        {
            if( g.target.whole ) { shift( g.target, at[ 0 ] - g.last[ 0 ], at[ 1 ] - g.last[ 1 ] ); g.last = at; }
            else
            {
                var other = g.target.piece[ g.target.end === 'a' ? 'b' : 'a' ];
                if( ! M.same( other, at ) ) g.target.piece[ g.target.end ] = at;
            }
        }
        else if( /beam|rope|spring/.test( state.tool ) ) state.ghost = { a: g.at, b: at };
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
        if( ! g.moved ) tapPoint( g.at, g.raw );
        else if( g.target ) prune();
        else if( ghost && ghost.a ) { state.pending = null; line( ghost.a, ghost.b ); }
        else if( ghost && ghost.at ) tapPoint( ghost.at, { x: ghost.at[ 0 ], y: ghost.at[ 1 ] } );
        refresh();
    }
    cv.addEventListener( 'pointerup', release );
    cv.addEventListener( 'pointercancel', function ( e ) { delete state.pointers[ e.pointerId ]; state.pinch = null; state.drag = null; state.ghost = null; } );

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

    addEventListener( 'keydown', function ( e ) { if( e.key === 'Escape' ) state.pending = null; } );

    /* --- buttons -------------------------------------------------------- */
    TOOLS.forEach( function ( t )
    {
        var b = document.createElement( 'button' );
        b.className = 'tool';
        b.dataset.tool = t[ 0 ];
        b.innerHTML = '<svg viewBox="0 0 24 24">' + ICON[ t[ 0 ] ] + '</svg><span>' + t[ 1 ] + '</span><i></i>';
        // On press, not click: a tap right after a fast drag loses its click.
        var pick = function () { state.tool = t[ 0 ]; state.pending = null; refresh(); };
        b.addEventListener( 'pointerdown', pick );
        b.addEventListener( 'click', pick );
        $( 'tools' ).appendChild( b );
    } );

    M.scenes.forEach( function ( s, i )
    {
        var o = document.createElement( 'option' );
        o.value = i; o.textContent = s.name;
        $( 'scene' ).appendChild( o );
    } );

    function stop() { state.sim = null; state.paused = false; $( 'win' ).hidden = true; }

    $( 'scene' ).addEventListener( 'change', function ()
    {
        stop();
        state.scene = M.scenes[ this.value ];
        state.build = []; state.pending = null; state.zoom = 1; state.panX = state.panY = 0;
        refresh();
    } );
    $( 'clear' ).addEventListener( 'click', function () { stop(); state.build = []; state.pending = null; refresh(); } );
    $( 'solution' ).addEventListener( 'click', function () { stop(); state.build = JSON.parse( JSON.stringify( state.scene.solution ) ); refresh(); } );
    $( 'run' ).addEventListener( 'click', function ()
    {
        if( state.sim ) stop();
        else { state.sim = new M.Sim( state.scene, state.build ); state.acc = 0; state.last = 0; state.pending = null; }
        refresh();
    } );
    $( 'pause' ).addEventListener( 'click', function () { state.paused = ! state.paused; refresh(); } );

    function say( text ) { state.note = text; clearTimeout( say.t ); say.t = setTimeout( function () { state.note = ''; refresh(); }, 2500 ); }

    function refresh()
    {
        var on = !! state.sim;
        $( 'run' ).textContent = on ? 'Stop' : 'Run';
        $( 'pause' ).hidden = ! on;
        $( 'pause' ).textContent = state.paused ? 'Resume' : 'Pause';
        $( 'solution' ).hidden = on || ! state.scene.solution.length;
        $( 'clear' ).hidden = on;
        $( 'tools' ).classList.toggle( 'off', on );

        var free = ! Object.keys( state.scene.inventory ).length;
        document.querySelectorAll( '.tool' ).forEach( function ( b )
        {
            var t = b.dataset.tool, n = left( t ), real = t !== 'move' && t !== 'erase';
            b.setAttribute( 'aria-pressed', t === state.tool );
            b.hidden = real && ! free && ! state.scene.inventory[ t ];
            b.querySelector( 'i' ).textContent = real && ! free ? n : '';
        } );
        if( $( 'tools' ).querySelector( '[aria-pressed="true"]' ).hidden ) { state.tool = 'move'; return refresh(); }

        var problems = on ? [] : M.check( state.build ).problems;
        $( 'noteText' ).textContent = state.note || problems[ 0 ] || ( on ? '' : HELP[ state.tool ] );
    }

    /* --- the loop ------------------------------------------------------- */
    function frame( now )
    {
        requestAnimationFrame( frame );
        var dt = state.last ? Math.min( 0.05, ( now - state.last ) / 1000 ) : 0;
        state.last = now;
        if( dt ) state.fps += ( 1 / dt - state.fps ) * 0.05;

        var s = state.sim;
        if( s && ! state.paused && s.state === 'running' )
        {
            state.acc += dt;
            var t0 = performance.now(), n = 0;
            while( state.acc >= M.DT && s.state === 'running' ) { s.step(); state.acc -= M.DT; n++; }
            if( n ) state.stepMs += ( ( performance.now() - t0 ) / n - state.stepMs ) * 0.1;
            if( s.state !== 'running' )
            {
                var w = $( 'win' );
                w.hidden = false;
                w.textContent = s.state === 'won' ? 'Solved in ' + s.time.toFixed( 1 ) + ' s' : s.state === 'lost' ? 'The ball is lost' : 'The machine broke';
                w.style.background = s.state === 'won' ? C.ok : C.danger;
            }
        }
        draw();
        $( 'meters' ).textContent = s
            ? s.time.toFixed( 1 ) + ' s · ' + Math.round( state.fps ) + ' fps · step ' + state.stepMs.toFixed( 2 ) + ' ms · hash ' + s.hash()
            : '';
    }

    /* --- drawing, in cell units ---------------------------------------- */
    function draw()
    {
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

        if( ! state.sim ) drawGrid( sc );
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
            var s = state.sim ? state.sim.time * c.dir * 3 : 0, cw = c.dir > 0, r = 0.42;
            ctx.strokeStyle = C.danger; ctx.lineWidth = 0.09;
            ctx.beginPath(); ctx.arc( p.x, p.y, r, s, s + 4.6 * ( cw ? 1 : -1 ), ! cw ); ctx.stroke();
            var e = s + 4.6 * ( cw ? 1 : -1 ), ex = p.x + Math.cos( e ) * r, ey = p.y + Math.sin( e ) * r, d = cw ? 1 : -1;
            ctx.beginPath();
            ctx.moveTo( ex + Math.cos( e - d * 2.3 ) * 0.2, ey + Math.sin( e - d * 2.3 ) * 0.2 ); ctx.lineTo( ex, ey );
            ctx.lineTo( ex + Math.cos( e + d * 2.6 ) * 0.2, ey + Math.sin( e + d * 2.6 ) * 0.2 ); ctx.stroke();
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
        ring( g.a ); ring( g.b );
        ctx.strokeStyle = C.accent; ctx.lineWidth = 0.1; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo( g.a[ 0 ], g.a[ 1 ] ); ctx.lineTo( g.b[ 0 ], g.b[ 1 ] ); ctx.stroke();
        ctx.globalAlpha = 1;
    }

    /* --- start ---------------------------------------------------------- */
    readTheme();
    fit();
    new ResizeObserver( function () { fit(); clampPan(); } ).observe( $( 'stage' ) );
    refresh();
    requestAnimationFrame( frame );

    window.MachinesPoC = { state: state, refresh: refresh };
} )();
