/* scenes.js - the test rooms of the proof of concept. Each one starts empty and
   carries one stored solution, which test.js replays to prove it is solvable.
   These are technical tests of one mechanism each, not the game's levels. */
( function ( root )
{
    'use strict';

    var A = function ( x, y ) { return { type: 'axle', at: [ x, y ] }; };
    var P = function ( x, y ) { return { type: 'pin', at: [ x, y ] }; };
    var B = function ( x, y ) { return { type: 'bolt', at: [ x, y ] }; };
    var beam = function ( a, b, c, d ) { return { type: 'beam', a: [ a, b ], b: [ c, d ] }; };
    var gear = function ( x, y, r ) { return { type: 'gear', at: [ x, y ], r: r }; };
    var wheel = function ( x, y, r ) { return { type: 'wheel', at: [ x, y ], r: r }; };
    var motor = function ( x, y, d ) { return { type: 'motor', at: [ x, y ], dir: d }; };
    var rope = function ( a, b, c, d ) { return { type: 'rope', a: [ a, b ], b: [ c, d ] }; };
    var spring = function ( a, b, c, d, m ) { return { type: 'spring', a: [ a, b ], b: [ c, d ], mode: m }; };

    root.Machines.scenes = [
        {
            id: 'gears', name: 'Gears: push the ball off the ledge',
            w: 24, h: 15, ball: [ 8.5, 9.05 ], basket: { x: 12, y: 12, w: 3.5, h: 2.25 },
            blocks: [ [ 2, 9.5, 9, 0.5 ] ],
            inventory: { beam: 2, gear: 3, axle: 3, bolt: 2, motor: 1 },
            solution: [ gear( 4, 6, 1 ), gear( 7, 6, 2 ), A( 4, 6 ), A( 7, 6 ), motor( 4, 6, 1 ),
                        beam( 7, 6, 7, 9 ), B( 7, 8 ) ]
        },
        {
            id: 'car', name: 'Car: drive the ball off the shelf',
            w: 24, h: 15, ball: [ 10.5, 7.55 ], basket: { x: 16.5, y: 12, w: 3.5, h: 2.25 },
            blocks: [ [ 0, 8, 15, 0.5 ] ],
            inventory: { beam: 2, wheel: 3, pin: 3, bolt: 2, motor: 2 },
            solution: [ wheel( 3, 7, 1 ), wheel( 7, 7, 1 ), beam( 3, 7, 7, 7 ), P( 3, 7 ), P( 7, 7 ), motor( 3, 7, 1 ) ]
        },
        {
            id: 'hoist', name: 'Hoist: wind the rope over the pulley, tip the ball',
            w: 24, h: 15, ball: [ 8.5, 9.4 ], basket: { x: 15, y: 12, w: 3.5, h: 2.25 },
            pulleys: [ [ 6, 3 ] ], blocks: [ [ 4, 10.2, 3, 0.5 ] ],
            inventory: { beam: 2, wheel: 2, axle: 3, rope: 3, motor: 1 },
            solution: [ beam( 6, 10, 14, 10 ), A( 14, 10 ), wheel( 2, 3, 1 ), A( 2, 3 ), motor( 2, 3, 1 ),
                        rope( 2, 3, 6, 3 ), rope( 6, 3, 6, 10 ) ]
        },
        {
            id: 'weight', name: 'Weight: no motor, a falling wheel does the work',
            w: 24, h: 15, ball: [ 8.5, 9.4 ], basket: { x: 15, y: 12, w: 3.5, h: 2.25 },
            pulleys: [ [ 6, 3 ] ], blocks: [ [ 4, 10.2, 3, 0.5 ] ],
            inventory: { beam: 2, wheel: 2, axle: 2, rope: 2 },
            solution: [ beam( 6, 10, 14, 10 ), A( 14, 10 ), wheel( 3, 6, 1 ), rope( 3, 6, 6, 3 ), rope( 6, 3, 6, 10 ) ]
        },
        {
            id: 'spring', name: 'Spring: throw the ball over the wall',
            w: 24, h: 15, ball: [ 10.5, 11.4 ], basket: { x: 17, y: 12, w: 4, h: 2.25 },
            blocks: [ [ 15, 8, 0.5, 6.5 ], [ 11.5, 9, 1, 0.5 ] ],
            inventory: { beam: 2, spring: 2, axle: 2, bolt: 1 },
            solution: [ beam( 7, 12, 14, 12 ), A( 14, 12 ), spring( 10, 14, 10, 12, 'push' ) ]
        },
        {
            id: 'free', name: 'Free play: everything, no limits',
            w: 24, h: 15, ball: [ 3, 13.9 ], basket: { x: 19, y: 12, w: 3.5, h: 2.25 },
            pulleys: [ [ 6, 2 ], [ 12, 2 ], [ 18, 2 ] ], blocks: [],
            inventory: {}, solution: []
        }
    ];
} )( typeof window !== 'undefined' ? window : globalThis );
