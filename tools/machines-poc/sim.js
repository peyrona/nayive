/* sim.js - Machines proof of concept: the rules and the physics, no drawing.

   The same file runs in the page and in the headless tests (test.js), so what
   the tests prove is what the player gets. It needs one global: Nape.

   THE MODEL. A machine is a list of plain objects, all on a grid (cell units):

     { type:'beam',  a:[x,y], b:[x,y] }        rigid bar; a hole at every grid
                                               point it crosses exactly
     { type:'wheel', at:[x,y], r:1|2|3 }       grippy disc; holes at the centre
     { type:'gear',  at:[x,y], r:1|2|3 }       and at 4 points of the rim
     { type:'rope',  a, b }                    pulls, never pushes; goes slack
     { type:'spring',a, b, mode? }             'push' | 'pull' | none (neutral)
     { type:'axle',  at }                      what is at this point turns on
                                               a pin fixed to the board
     { type:'pin',   at }                      what is at this point hinges
     { type:'bolt',  at }                      what is at this point is one
                                               rigid piece; alone, it is fixed
                                               to the board
     { type:'motor', at, dir:1|-1 }            drives the wheel or gear here

   Bolted pieces become ONE body (a joint would flex; a body cannot). Gears do
   not touch: two gears on axles, exactly r1+r2 apart, are tied by a ratio. A
   rope tied to the centre of a wheel on an axle winds onto it: the wheel's
   turning changes the rope's length and the rope's pull turns the wheel back.
   Two ropes that meet at a pulley point are one rope over that pulley.

   Everything is stepped at a fixed rate and nothing reads the clock, so the
   same machine gives the same run on the same device. */
( function ( root )
{
    'use strict';

    var CELL = 40;              // physics units per grid cell
    var DT = 1 / 120;           // fixed step
    var GRAVITY = 600;
    var THICK = 0.3;            // beam thickness, cells
    var RATE = 3;               // motor speed, rad/s
    var TORQUE = 1.5e5;         // motor torque limit: a load has to be able to beat it
    var LINK = 5e7;             // gear link torque limit
    var ROPE_MIN = 0.5;         // shortest a wound rope gets, cells
    var PUSH = 1.9, PULL = 0.5; // spring rest length, as a share of built length
    var WIN_HOLD = 0.5;         // seconds the ball must rest in the basket
    var WIN_SPEED = 40;         // ...moving slower than this
    var BROKEN = 12000;         // a body this fast means the physics blew up

    var isBody = function ( p ) { return p.type === 'beam' || p.type === 'wheel' || p.type === 'gear'; };
    var isDisc = function ( p ) { return p.type === 'wheel' || p.type === 'gear'; };
    var same = function ( p, q ) { return p[ 0 ] === q[ 0 ] && p[ 1 ] === q[ 1 ]; };
    var gcd = function ( a, b ) { a = Math.abs( a ); b = Math.abs( b ); while( b ) { var t = a % b; a = b; b = t; } return a; };
    /* sqrt, never Math.hypot: engines differ in the last bit, and this file must
       not (see vendor/det-math.js). */
    var hyp = function ( x, y ) { return Math.sqrt( x * x + y * y ); };
    var dist = function ( a, b ) { return hyp( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ] ); };

    /* Every grid point of a piece that something can connect to. */
    function holes( p )
    {
        if( p.type === 'beam' )
        {
            var dx = p.b[ 0 ] - p.a[ 0 ], dy = p.b[ 1 ] - p.a[ 1 ], n = gcd( dx, dy ) || 1, out = [];
            for( var i = 0; i <= n; i++ ) out.push( [ p.a[ 0 ] + dx * i / n, p.a[ 1 ] + dy * i / n ] );
            return out;
        }
        if( isDisc( p ) )
        {
            var x = p.at[ 0 ], y = p.at[ 1 ], r = p.r;
            return [ [ x, y ], [ x + r, y ], [ x - r, y ], [ x, y + r ], [ x, y - r ] ];
        }
        return [];
    }

    function hasHole( p, at ) { return holes( p ).some( function ( h ) { return same( h, at ); } ); }

    /* The parts that make bodies, and which of them sit at a point. */
    function bodiesAt( build, at ) { return build.filter( function ( p ) { return isBody( p ) && hasHole( p, at ); } ); }

    function connectorAt( build, at )
    {
        return build.filter( function ( p ) { return ( p.type === 'axle' || p.type === 'pin' || p.type === 'bolt' ) && same( p.at, at ); } )[ 0 ] || null;
    }

    function pairsOfGears( build )
    {
        var gears = build.filter( function ( p ) { return p.type === 'gear'; } ), out = [];
        for( var i = 0; i < gears.length; i++ )
            for( var j = i + 1; j < gears.length; j++ )
                if( Math.abs( dist( gears[ i ].at, gears[ j ].at ) - gears[ i ].r - gears[ j ].r ) < 1e-9 )
                    out.push( [ gears[ i ], gears[ j ] ] );
        return out;
    }

    /* What the builder needs to show before Run: which gears mesh, and what
       will not work. Pure: it reads the model only. */
    function check( build )
    {
        var links = [], open = [], problems = [];
        pairsOfGears( build ).forEach( function ( g )
        {
            var a = connectorAt( build, g[ 0 ].at ), b = connectorAt( build, g[ 1 ].at );
            if( a && b && a.type === 'axle' && b.type === 'axle' ) links.push( g ); else open.push( g );
        } );
        if( open.length ) problems.push( 'Gears mesh only when both are on an axle' );
        build.forEach( function ( p )
        {
            if( p.type !== 'motor' ) return;
            var disc = bodiesAt( build, p.at ).filter( function ( q ) { return isDisc( q ) && same( q.at, p.at ); } )[ 0 ];
            var c = connectorAt( build, p.at );
            if( ! disc ) problems.push( 'A motor needs a wheel or gear' );
            else if( ! c || c.type === 'bolt' ) problems.push( 'A motor needs an axle or pin at the centre' );
        } );
        return { links: links, open: open, problems: problems };
    }

    function Sim( scene, build )
    {
        var N = root.Nape, self = this;
        var V = function ( x, y ) { return new N.Vec2( x * CELL, y * CELL ); };

        var space = new N.Space( new N.Vec2( 0, GRAVITY ) );
        space.deterministic = true;
        this.space = space;
        this.scene = scene;
        this.build = build;
        this.time = 0;
        this.state = 'running';     // running | won | lost | broken
        this.winFor = 0;
        this.ropes = [];
        this.stats = { ratioErr: 0, ropeOver: 0, maxSpeed: 0 };

        var board = new N.Material( 0.1, 0.7, 0.9, 1 );
        var wood = new N.Material( 0.1, 0.6, 0.8, 0.5 );
        var rubber = new N.Material( 0.2, 1.4, 1.8, 0.6 );
        var iron = new N.Material( 0.05, 0.3, 0.4, 2 );
        var ballMat = new N.Material( 0.25, 0.4, 0.5, 1.2 );

        function box( x, y, w, h, mat )
        {
            var b = new N.Body( N.BodyType.STATIC, V( x + w / 2, y + h / 2 ) );
            b.shapes.add( new N.Polygon( N.Polygon.box( w * CELL, h * CELL ), mat ) );
            b.space = space;
            return b;
        }

        /* --- the scene -------------------------------------------------- */
        var W = scene.w, H = scene.h;
        box( -1, H - 0.5, W + 2, 2, board );        // floor
        box( -1, -60, 1, H + 62, board );           // walls: tall, a throw can
        box( W, -60, 1, H + 62, board );            // go well above the view
        ( scene.blocks || [] ).forEach( function ( k ) { box( k[ 0 ], k[ 1 ], k[ 2 ], k[ 3 ], board ); } );

        var bk = scene.basket;
        box( bk.x, bk.y + bk.h, bk.w, 0.25, board );
        box( bk.x - 0.25, bk.y, 0.25, bk.h + 0.25, board );
        box( bk.x + bk.w, bk.y, 0.25, bk.h + 0.25, board );

        var ball = new N.Body( N.BodyType.DYNAMIC, V( scene.ball[ 0 ], scene.ball[ 1 ] ) );
        ball.shapes.add( new N.Circle( ( scene.ballR || 0.45 ) * CELL, undefined, ballMat ) );
        ball.isBullet = true;
        ball.space = space;
        this.ball = ball;

        /* --- rigid groups: bolted pieces are one body ------------------- */
        var parts = build.filter( isBody );
        var parent = parts.map( function ( p, i ) { return i; } );
        var find = function ( i ) { while( parent[ i ] !== i ) i = parent[ i ] = parent[ parent[ i ] ]; return i; };
        var fixed = {};

        build.forEach( function ( c )
        {
            if( c.type !== 'bolt' ) return;
            var here = bodiesAt( build, c.at );
            if( here.length === 1 ) fixed[ parts.indexOf( here[ 0 ] ) ] = true;
            for( var i = 1; i < here.length; i++ )
                parent[ find( parts.indexOf( here[ i ] ) ) ] = find( parts.indexOf( here[ 0 ] ) );
        } );

        var groups = {};
        parts.forEach( function ( p, i )
        {
            var r = find( i );
            ( groups[ r ] = groups[ r ] || { parts: [], fixed: false, axles: [] } ).parts.push( p );
            if( fixed[ i ] ) groups[ r ].fixed = true;
        } );

        /* Two axles at different points hold a piece still: make it static
           rather than leave two joints to fight. */
        build.forEach( function ( c )
        {
            if( c.type !== 'axle' ) return;
            var seen = {};
            bodiesAt( build, c.at ).forEach( function ( p )
            {
                var r = find( parts.indexOf( p ) );
                if( seen[ r ] ) return;
                seen[ r ] = true;
                groups[ r ].axles.push( c.at );
            } );
        } );

        var groupOf = function ( p ) { return groups[ find( parts.indexOf( p ) ) ]; };
        var bodyOf = function ( p ) { return groupOf( p ).body; };
        this.groupOf = groupOf;

        Object.keys( groups ).sort( function ( a, b ) { return a - b; } ).forEach( function ( key )
        {
            var g = groups[ key ], cx = 0, cy = 0;
            g.parts.forEach( function ( p )
            {
                var c = p.type === 'beam' ? [ ( p.a[ 0 ] + p.b[ 0 ] ) / 2, ( p.a[ 1 ] + p.b[ 1 ] ) / 2 ] : p.at;
                cx += c[ 0 ] / g.parts.length;
                cy += c[ 1 ] / g.parts.length;
            } );
            g.cx = cx; g.cy = cy;
            var still = g.fixed || g.axles.length > 1;
            var body = new N.Body( still ? N.BodyType.STATIC : N.BodyType.DYNAMIC, V( cx, cy ) );

            g.parts.forEach( function ( p )
            {
                if( isDisc( p ) )
                {
                    var mat = p.type === 'wheel' ? rubber : iron;
                    body.shapes.add( new N.Circle( p.r * CELL * ( p.type === 'gear' ? 0.94 : 1 ), V( p.at[ 0 ] - cx, p.at[ 1 ] - cy ), mat ) );
                    return;
                }
                var ax = ( p.a[ 0 ] - cx ) * CELL, ay = ( p.a[ 1 ] - cy ) * CELL;
                var bx = ( p.b[ 0 ] - cx ) * CELL, by = ( p.b[ 1 ] - cy ) * CELL;
                var len = hyp( bx - ax, by - ay ) || 1;
                var nx = -( by - ay ) / len * THICK * CELL / 2, ny = ( bx - ax ) / len * THICK * CELL / 2;
                body.shapes.add( new N.Polygon( [
                    new N.Vec2( ax + nx, ay + ny ), new N.Vec2( bx + nx, by + ny ),
                    new N.Vec2( bx - nx, by - ny ), new N.Vec2( ax - nx, ay - ny ) ], wood ) );
                body.shapes.add( new N.Circle( THICK * CELL / 2, new N.Vec2( ax, ay ), wood ) );
                body.shapes.add( new N.Circle( THICK * CELL / 2, new N.Vec2( bx, by ), wood ) );
            } );
            body.space = space;
            g.body = body;
        } );

        var local = function ( g, at ) { return V( at[ 0 ] - g.cx, at[ 1 ] - g.cy ); };

        /* --- what collides ---------------------------------------------- */
        /* Pieces joined by hinges, or meshing, are drawn overlapping on
           purpose: one machine does not collide with itself. Two separate
           machines do. */
        var keys = Object.keys( groups ), mparent = {};
        keys.forEach( function ( k ) { mparent[ k ] = k; } );
        var mfind = function ( k ) { while( mparent[ k ] !== k ) k = mparent[ k ] = mparent[ mparent[ k ] ]; return k; };
        var mjoin = function ( a, b ) { mparent[ mfind( find( parts.indexOf( a ) ) ) ] = mfind( find( parts.indexOf( b ) ) ); };

        build.forEach( function ( c )
        {
            if( c.type !== 'axle' && c.type !== 'pin' ) return;
            var here = bodiesAt( build, c.at );
            for( var i = 1; i < here.length; i++ ) mjoin( here[ 0 ], here[ i ] );
        } );
        var info = check( build );
        info.links.forEach( function ( g ) { mjoin( g[ 0 ], g[ 1 ] ); } );

        var igroups = {};
        keys.forEach( function ( k )
        {
            var m = mfind( k );
            igroups[ m ] = igroups[ m ] || new N.InteractionGroup( true );
            groups[ k ].body.group = igroups[ m ];
        } );

        /* --- hinges ----------------------------------------------------- */
        var pivot = function ( a, pa, b, pb ) { new N.PivotJoint( a, b, pa, pb ).space = space; };

        build.forEach( function ( c )
        {
            if( c.type === 'axle' )
            {
                var seen = [];
                bodiesAt( build, c.at ).forEach( function ( p )
                {
                    var g = groupOf( p );
                    if( seen.indexOf( g ) >= 0 || g.body.isStatic() ) return;
                    seen.push( g );
                    pivot( space.world, V( c.at[ 0 ], c.at[ 1 ] ), g.body, local( g, c.at ) );
                } );
            }
            else if( c.type === 'pin' )
            {
                var here = bodiesAt( build, c.at ), first = groupOf( here[ 0 ] || {} );
                if( ! here.length ) return;
                here.slice( 1 ).forEach( function ( p )
                {
                    var g = groupOf( p );
                    if( g !== first && ! ( g.body.isStatic() && first.body.isStatic() ) ) pivot( first.body, local( first, c.at ), g.body, local( g, c.at ) );
                } );
            }
        } );

        /* What a disc turns against: the board, or the piece it is pinned to.
           Null when it has no hinge. */
        function baseOf( disc )
        {
            var c = connectorAt( build, disc.at );
            if( ! c || c.type === 'bolt' ) return null;
            if( c.type === 'axle' ) return space.world;
            var other = bodiesAt( build, disc.at ).filter( function ( q ) { return groupOf( q ) !== groupOf( disc ); } )[ 0 ];
            return other ? bodyOf( other ) : null;
        }

        /* --- motors and gears ------------------------------------------- */
        build.forEach( function ( m )
        {
            if( m.type !== 'motor' ) return;
            var disc = bodiesAt( build, m.at ).filter( function ( q ) { return isDisc( q ) && same( q.at, m.at ); } )[ 0 ];
            var base = disc && baseOf( disc );
            if( ! base || bodyOf( disc ).isStatic() ) return;
            var j = new N.MotorJoint( base, bodyOf( disc ), m.dir * RATE );
            j.maxForce = TORQUE;
            j.space = space;
        } );

        this.links = [];
        info.links.forEach( function ( g )
        {
            var a = bodyOf( g[ 0 ] ), b = bodyOf( g[ 1 ] );
            if( a === b || a.isStatic() && b.isStatic() ) return;
            // Same physics as the first prototype: a ratio between two speeds.
            var j = new N.MotorJoint( a, b, 0, -g[ 1 ].r / g[ 0 ].r );
            j.maxForce = LINK;
            j.space = space;
            self.links.push( { a: a, b: b, ra: g[ 0 ].r, rb: g[ 1 ].r } );
        } );

        /* --- ropes ------------------------------------------------------ */
        /* Where a rope's end is held: { body, anchor, world point, disc? }.
           disc is set when it winds onto a wheel on an axle. */
        function hold( at )
        {
            var here = bodiesAt( build, at ), p = here[ 0 ];
            if( ! p ) return { body: space.world, anchor: V( at[ 0 ], at[ 1 ] ), g: null, at: at };
            var g = groupOf( p ), drum = null, c = connectorAt( build, at );

            // Several discs at one centre: the rope winds on the smallest.
            here.forEach( function ( q )
            {
                if( isDisc( q ) && same( q.at, at ) && c && c.type === 'axle' && ( ! drum || q.r < drum.r ) ) { drum = q; g = groupOf( q ); }
            } );
            if( g.body.isStatic() ) return { body: space.world, anchor: V( at[ 0 ], at[ 1 ] ), g: null, at: at };
            if( drum ) return { body: space.world, anchor: V( at[ 0 ], at[ 1 ] ), g: null, at: at, drum: drum, drumBody: g.body };
            return { body: g.body, anchor: local( g, at ), g: g, at: at };
        }

        var pulleys = scene.pulleys || [];
        var ropes = build.filter( function ( p ) { return p.type === 'rope'; } );
        var used = [];

        pulleys.forEach( function ( pt )
        {
            var two = ropes.filter( function ( r ) { return used.indexOf( r ) < 0 && ( same( r.a, pt ) || same( r.b, pt ) ); } ).slice( 0, 2 );
            if( two.length < 2 ) return;
            used.push( two[ 0 ], two[ 1 ] );
            var far = function ( r ) { return same( r.a, pt ) ? r.b : r.a; };
            var ha = hold( far( two[ 0 ] ) ), hb = hold( far( two[ 1 ] ) );
            var L = dist( far( two[ 0 ] ), pt ) + dist( pt, far( two[ 1 ] ) );
            var world = space.world, joint, off = 0, pv = V( pt[ 0 ], pt[ 1 ] );
            if( ha.body === world && hb.body === world ) return;
            if( ha.body === world || hb.body === world )
            {
                /* One end does not move, so that side of the rope is a fixed
                   length and nape's pulley refuses it: what is left is a
                   limit from the pulley to the end that moves. */
                var moving = ha.body === world ? hb : ha, still = ha.body === world ? ha : hb;
                off = dist( still.at, pt ) * CELL;
                joint = new N.DistanceJoint( world, moving.body, pv, moving.anchor, 0, L * CELL - off );
            }
            else joint = new N.PulleyJoint( ha.body, world, world, hb.body, ha.anchor, pv, pv, hb.anchor, 0, L * CELL, 1 );
            joint.space = space;
            self.ropes.push( { pieces: two, joint: joint, ends: [ ha, hb ], via: pt, L: L * CELL, full: L * CELL, off: off } );
        } );

        ropes.forEach( function ( r )
        {
            if( used.indexOf( r ) >= 0 ) return;
            var ha = hold( r.a ), hb = hold( r.b ), L = dist( r.a, r.b ) * CELL;
            if( ha.body === hb.body ) return;
            var joint = new N.DistanceJoint( ha.body, hb.body, ha.anchor, hb.anchor, 0, L );
            joint.space = space;
            self.ropes.push( { pieces: [ r ], joint: joint, ends: [ ha, hb ], via: null, L: L, full: L, off: 0 } );
        } );

        this.ropes.forEach( function ( r )
        {
            r.drums = r.ends.filter( function ( e ) { return e.drum; } ).map( function ( e )
            {
                return { body: e.drumBody, r: e.drum.r * CELL, last: e.drumBody.rotation };
            } );
        } );

        /* --- springs ---------------------------------------------------- */
        this.springs = [];
        build.forEach( function ( s )
        {
            if( s.type !== 'spring' ) return;
            var ha = hold( s.a ), hb = hold( s.b ), L = dist( s.a, s.b ) * CELL;
            if( ha.body === hb.body ) return;
            var rest = L * ( s.mode === 'push' ? PUSH : s.mode === 'pull' ? PULL : 1 );
            var j = new N.SpringJoint( ha.body, hb.body, ha.anchor, hb.anchor, rest );
            j.frequency = 3.5;
            j.damping = 0.25;
            j.space = space;
            self.springs.push( { piece: s, joint: j, ends: [ ha, hb ] } );
        } );

        /* Stable order for the hash and the draw. */
        this.bodies = keys.sort( function ( a, b ) { return a - b; } ).map( function ( k ) { return groups[ k ].body; } );
        this.bodies.push( ball );
    }

    /* World position of a rope end, in physics units. */
    function endPoint( e )
    {
        var w = e.body.localPointToWorld( e.anchor );
        var o = { x: w.x, y: w.y };
        w.dispose && w.dispose();
        return o;
    }

    Sim.prototype.ropeLength = function ( r )
    {
        var a = endPoint( r.ends[ 0 ] ), b = endPoint( r.ends[ 1 ] );
        if( ! r.via ) return hyp( a.x - b.x, a.y - b.y );
        var px = r.via[ 0 ] * CELL, py = r.via[ 1 ] * CELL;
        return hyp( a.x - px, a.y - py ) + hyp( b.x - px, b.y - py );
    };

    Sim.prototype.step = function ()
    {
        var i, j;

        /* Winding, before the step: the drum's turn since last step changes
           how much rope is free. Positive rotation winds in. */
        for( i = 0; i < this.ropes.length; i++ )
        {
            var r = this.ropes[ i ];
            for( j = 0; j < r.drums.length; j++ )
            {
                var d = r.drums[ j ], now = d.body.rotation;
                r.L = Math.max( ROPE_MIN * CELL + r.off, Math.min( r.full, r.L - ( now - d.last ) * d.r ) );
                d.last = now;
                r.joint.jointMax = r.L - r.off;
            }
        }

        this.space.step( DT, 20, 20 );
        this.time += DT;
        this.measure();

        /* The rope's pull, back onto the drum: this is what makes a load heavy
           for the motor and what lets a falling load spin the wheel. */
        for( i = 0; i < this.ropes.length; i++ )
        {
            var q = this.ropes[ i ];
            // All paid out: the end of the rope holds, the drum is not turned.
            if( ! q.drums.length || q.joint.isSlack() || q.L >= q.full ) continue;
            var pull = Math.abs( q.joint.impulse().x( 0, 0 ) );
            for( j = 0; j < q.drums.length; j++ )
                q.drums[ j ].body.angularVel -= pull * q.drums[ j ].r / q.drums[ j ].body.inertia;
        }

        this.judge();
    };

    Sim.prototype.measure = function ()
    {
        var s = this.stats, i;
        for( i = 0; i < this.links.length; i++ )
        {
            var l = this.links[ i ], top = Math.max( Math.abs( l.a.angularVel * l.ra ), 0.1 * l.ra );
            s.ratioErr = Math.max( s.ratioErr, Math.abs( l.a.angularVel * l.ra + l.b.angularVel * l.rb ) / top );
        }
        for( i = 0; i < this.ropes.length; i++ )
            s.ropeOver = Math.max( s.ropeOver, ( this.ropeLength( this.ropes[ i ] ) - this.ropes[ i ].L ) / CELL );
        for( i = 0; i < this.bodies.length; i++ )
        {
            var v = this.bodies[ i ].velocity;
            s.maxSpeed = Math.max( s.maxSpeed, hyp( v.x, v.y ) );
        }
    };

    Sim.prototype.judge = function ()
    {
        if( this.state === 'broken' || this.state === 'won' ) return;

        for( var i = 0; i < this.bodies.length; i++ )
        {
            var b = this.bodies[ i ];
            if( ! isFinite( b.position.x ) || hyp( b.velocity.x, b.velocity.y ) > BROKEN ) { this.state = 'broken'; return; }
        }

        var p = this.ball.position, v = this.ball.velocity, k = this.scene.basket;
        if( p.y > ( this.scene.h + 3 ) * CELL || p.x < -CELL || p.x > ( this.scene.w + 1 ) * CELL ) { this.state = 'lost'; return; }
        var inside = p.x > k.x * CELL && p.x < ( k.x + k.w ) * CELL && p.y > k.y * CELL && p.y < ( k.y + k.h ) * CELL;
        if( inside && hyp( v.x, v.y ) < WIN_SPEED )
        {
            this.winFor += DT;
            if( this.winFor >= WIN_HOLD ) this.state = 'won';
        }
        else this.winFor = 0;
    };

    /* Where a part is now: its start point moves with its body. */
    Sim.prototype.pose = function ( p )
    {
        var g = this.groupOf( p ), b = g.body;
        return { x: b.position.x, y: b.position.y, rot: b.rotation, cx: g.cx * CELL, cy: g.cy * CELL };
    };

    /* An exact fingerprint of the run: the bits of every number that matters.
       Two runs with the same hash went through the same state. */
    Sim.prototype.hash = function ()
    {
        var h = 2166136261 >>> 0, f = new Float64Array( 1 ), w = new Uint32Array( f.buffer );
        var mix = function ( x ) { f[ 0 ] = x; h = Math.imul( h ^ w[ 0 ], 16777619 ); h = Math.imul( h ^ w[ 1 ], 16777619 ); };
        this.bodies.forEach( function ( b ) { mix( b.position.x ); mix( b.position.y ); mix( b.rotation ); } );
        return ( h >>> 0 ).toString( 16 );
    };

    root.Machines = {
        CELL: CELL, DT: DT, Sim: Sim, check: check, holes: holes, isBody: isBody, isDisc: isDisc,
        same: same, dist: dist, bodiesAt: bodiesAt, connectorAt: connectorAt, endPoint: endPoint, THICK: THICK
    };
} )( typeof window !== 'undefined' ? window : globalThis );
