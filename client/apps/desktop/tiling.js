/*
 * tiling.js - the desktop's window-sizing maths, with no page in it, so it can
 * be tested on its own (tools/desktop-test). The desktop (index.html) does the
 * rest: it measures the pages, moves the windows and keeps the state.
 *
 *   NayiveTiling.tile( n, W, H, opt ) - where n windows go on a W x H desk
 *   NayiveTiling.fit( W, H, nat, cap ) - how much a W x H window shrinks what it shows
 *   NayiveTiling.need( r )             - what a page needs, from one reading of it
 */
( function ( root )
{
    'use strict';

    //------------------------------------------------------------------------//
    // TILE - every window on the desk at once, none on top of another, and no
    // desk left over. A plain grid, so the result is easy to foresee:
    //
    //   - The desk is cut into COLUMNS of equal width. Each column is a stack of
    //     windows of equal height. The windows go column by column, left to
    //     right, and top to bottom inside a column (the caller picks the order).
    //   - When the windows do not share out evenly, the LEFT columns hold fewer,
    //     so the first windows get the bigger places: 3 windows are one tall
    //     one on the left and two stacked on the right; 5 are 1 + 2 + 2.
    //   - How many columns: the count whose places come closest to the shape of
    //     a normal window (SHAPE: width / height) - on a wide screen 2 windows
    //     stand side by side, on a tall one they stack. Places smaller than the
    //     smallest window (opt.minW x opt.minH) are avoided while it can be.
    //
    // opt.gap: pixels between two windows (none at the desk's edges).
    // Returns one { l, t, w, h } per window, in whole pixels; next to each
    // other they cover the desk exactly, with no 1px seam.

    var SHAPE     = 1.4;    // a new window: 70% x 82% of a 16:9 desk
    var TOO_SMALL = 100;    // cost of one place smaller than the smallest window

    // `n` windows in `c` columns, the smaller stacks first: 5 in 3 -> [1, 2, 2].
    function spread( n, c )
    {
        var out = [], small = Math.floor( n / c ), big = n - small * c;   // `big` columns hold one more
        for( var i = 0; i < c; i++ ) out.push( i < c - big ? small : small + 1 );
        return out;
    }

    // `total` pixels cut into `parts` pieces with `gap` between them: whole
    // pixels whose sizes add up to exactly what is there.
    function cut( total, parts, gap )
    {
        var room = total - gap * ( parts - 1 ), out = [];
        for( var i = 0; i < parts; i++ )
        {
            var a = Math.round( i * room / parts ), b = Math.round( ( i + 1 ) * room / parts );
            out.push( { at: a + i * gap, size: b - a } );
        }
        return out;
    }

    function tile( n, W, H, opt )
    {
        opt = opt || {};
        var gap = Math.max( 0, opt.gap || 0 ), minW = opt.minW || 0, minH = opt.minH || 0;
        n = Math.floor( n );
        if( ! ( n > 0 ) || ! ( W > 0 ) || ! ( H > 0 ) ) return [];

        var best = null;
        for( var c = 1; c <= n; c++ )
        {
            var stacks = spread( n, c ), colW = ( W - gap * ( c - 1 ) ) / c, cost = 0;
            for( var i = 0; i < c; i++ )
            {
                var k = stacks[ i ], h = ( H - gap * ( k - 1 ) ) / k;
                cost += k * Math.abs( Math.log( colW / h / SHAPE ) );
                if( colW < minW || h < minH ) cost += k * TOO_SMALL;
            }
            if( ! best || cost < best.cost - 1e-9 ) best = { cost: cost, stacks: stacks };   // a tie keeps fewer columns
        }

        var cols = cut( W, best.stacks.length, gap ), out = [];
        best.stacks.forEach( function ( k, i )
        {
            cut( H, k, gap ).forEach( function ( row )
            {
                out.push( { l: cols[ i ].at, t: row.at, w: cols[ i ].size, h: row.size } );
            } );
        } );
        return out;
    }

    //------------------------------------------------------------------------//
    // FIT - a window with Scale on that is drawn smaller than its page needs
    // (`nat`: the window size, in page pixels, at which it all fits) shows that
    // page whole, shrunk, chrome and all, instead of cut off or scrolled.
    //
    //   s  = the shrink factor, never above 1: the tighter of W / nat.w, H / nat.h
    //   lw, lh = the size the window is LAID OUT at, W / s x H / s: the natural
    //        size on the tight side, more on the other - a narrow window shows
    //        a longer page, never a band of nothing.
    //   w, h = what it covers on the desk, lw * s x lh * s: W x H, unless...
    //
    // ...cap ({w, h}) limits the laid-out size on the loose side (a 1px-wide,
    // 800px-tall window would lay its page out thousands of pixels tall). Past
    // it the window just stops growing that way: w or h comes back smaller
    // than asked, so the window's box is always what is drawn.

    function fit( W, H, nat, cap )
    {
        W = Math.max( 1, W ); H = Math.max( 1, H );
        var nw = Math.max( 1, nat && nat.w || 1 ), nh = Math.max( 1, nat && nat.h || 1 );
        var s = Math.min( 1, W / nw, H / nh );
        if( s >= 1 ) return { s: 1, lw: W, lh: H, w: W, h: H };
        var lw = W / s, lh = H / s;
        if( cap )
        {
            if( cap.w ) lw = Math.min( lw, Math.max( cap.w, nw ) );
            if( cap.h ) lh = Math.min( lh, Math.max( cap.h, nh ) );
        }
        return { s: s, lw: lw, lh: lh, w: lw * s, h: lh * s };
    }

    //------------------------------------------------------------------------//
    // NEED - what a window's page needs, from one reading of it at the size it
    // is laid out at (r):
    //   outW, outH    the window, chrome included (its layout size)
    //   viewW, viewH  the page's visible area (clientWidth / clientHeight)
    //   fullW, fullH  all of the page (scrollWidth / scrollHeight)
    //   deskW, deskH  the desk
    // On each side: 0 when the page fits, else the window size at which it
    // would - or -1 when even the whole desk would not hold it: that page
    // scrolls BY DESIGN on that side (a long list, a wide sheet) and keeps its
    // scrollbar there. Scale never shrinks a long page to a stripe.

    function need( r )
    {
        function side( out, view, full, deskSize )
        {
            if( ! ( full > view + 1 ) ) return 0;          // 1px: sub-pixel rounding
            var n = Math.ceil( out + full - view );
            return n > deskSize ? -1 : n;
        }
        return { w: side( r.outW, r.viewW, r.fullW, r.deskW ),
                 h: side( r.outH, r.viewH, r.fullH, r.deskH ) };
    }

    var api = { tile: tile, fit: fit, need: need, SHAPE: SHAPE };
    root.NayiveTiling = api;
    if( typeof module === 'object' && module.exports ) module.exports = api;
} )( typeof window !== 'undefined' ? window : globalThis );
