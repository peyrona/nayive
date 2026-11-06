/* Ayni library 0.2.0, a desktop of whole pages: windows that hold a page each, in a frame. Moving, sizing, Tile, Scale, sticky halves, a window
   that remembers its place, the switcher, the on-screen keyboard, the clock, a second clock, countdowns, weather, battery. Plain JavaScript, no
   build step, evergreen browsers 2024+. Optional: a plain script, without defer, with ayni-deskpage.css, ayni-tiling.js, and the page's own markup
   (.desktop, #desk, #bar, #tasks, #menu, #menuBtn, #snapGhost, and the rest of the "more" menu ids).
     var D = Ayni.deskPage( hooks )
   hooks: appName; APPS { app: { name, svg } }; NARROW, SHORT { app: px }; appsReady, a promise; appOf( url ); openMenu(), closeMenu(), openMoreHere();
   placeUnread(), pokeUnread(), placeMail(), askMail(); loadLocker(), loadScript( url ), weatherEngine(). D holds what the page needs back.
   A page in a window says what it holds with window.ayniDocPath, and may hold the close with window.ayniBeforeClose. Rules: chapter 17.4. */
( function ()
{
    var NAMES = window.AyniNames || {}, KEYS = NAMES.deskKey || 'ayni-';

    Ayni.deskPage = function ( h )
    {
    // A new tooltip. This script runs as the page is read, before Ayni (a
    // deferred script) is in: until then the tooltip is only written down.
    function setTip( el, text )
    {
        if( window.Ayni && Ayni.setTip ) Ayni.setTip( el, text ); else el.dataset.tip = text;
    }

    var ROOT    = NAMES.home || '/';
    var desktop = document.getElementById( 'desktop' );
    var desk    = document.getElementById( 'desk' );
    var bar     = document.getElementById( 'bar' );
    var tasks   = document.getElementById( 'tasks' );
    var menu    = document.getElementById( 'menu' );
    var menuBtn = document.getElementById( 'menuBtn' );
    var ghost   = document.getElementById( 'snapGhost' );

    var ICON_WIN = Ayni.icon( 'window' );

    function t( key, fallback )
    {
        var s = window.Ayni ? Ayni.t( key ) : key;
        return ( ! s || s === key ) ? ( fallback || key ) : s;
    }

    function store( key, val )
    {
        try { if( val === undefined ) return JSON.parse( localStorage.getItem( key ) || 'null' ); localStorage.setItem( key, JSON.stringify( val ) ); }
        catch( e ) { return null; }
    }

    //------------------------------------------------------------------------//
    // SETTINGS - this device's desktop (a PC and a tablet can each want their
    // own), in localStorage "desktop"; set from the "⋮" menu (see MORE).

    var SET_KEY = KEYS + 'desktop';
    var set = { bar: 'bottom', barH: 48, dow: 'short', date: false, secs: false, sticky: true };
    Object.assign( set, store( SET_KEY ) || {} );
    // Until 2026-09-26 the desktop had its own colour schemes; they now follow the account's.
    // Until 2026-09-28 it had "Start with" and a bar font too (dropped with the settings dialog).
    delete set.scheme; delete set.active; delete set.schemes; delete set.start; delete set.font;
    if( [ 'top', 'bottom', 'left', 'right' ].indexOf( set.bar ) < 0 ) set.bar = 'bottom';
    function saveSet() { store( SET_KEY, set ); }

    // TOUCH - a touch screen (a tablet, with or without its mouse): body.touch
    // makes the resize edges, the window buttons and the bar finger-sized (the
    // bar at least 56px, whatever the menu's slider says), and a long press on
    // the desk opens the "⋮" menu (see the desk's contextmenu). A PC with no
    // touch screen sees no change.
    var coarse = window.matchMedia( '(any-pointer: coarse)' );
    var TOUCH_BAR_H = 56;

    // One body class for the bar's side (bar-top, bar-bottom, bar-left, bar-right),
    // plus bar-side for left and right; and body.touch.
    function applyLayout()
    {
        [ 'top', 'bottom', 'left', 'right' ].forEach( function ( p ) { document.body.classList.toggle( 'bar-' + p, set.bar === p ); } );
        document.body.classList.toggle( 'bar-side', set.bar === 'left' || set.bar === 'right' );
        desktop.dataset.edge = set.bar;     // Ayni's taskbar goes by it; the page's own rules by the body classes
        document.body.classList.toggle( 'touch', coarse.matches );
        var h = Math.max( 36, Math.min( 72, +set.barH || 48 ) );
        document.documentElement.style.setProperty( '--bar-h', ( coarse.matches ? Math.max( TOUCH_BAR_H, h ) : h ) + 'px' );
    }

    applyLayout();
    if( coarse.addEventListener ) coarse.addEventListener( 'change', applyLayout );

    //------------------------------------------------------------------------//
    // WINDOWS

    var wins  = [];     // in the order they were opened = the order of the bar buttons
    var zTop  = 10;
    var front = null;

    // The smallest a window gets (.win's min-width / min-height too). With Scale
    // on there is no smallest: it shrinks what it shows instead (see SCALE).
    var MIN_W = 320, MIN_H = 200;

    function deskRect() { return { w: desk.clientWidth, h: desk.clientHeight }; }

    // opts.fresh: a new window even if the app has one; opts.geom: {l,t,w,h} to
    // restore; opts.nav: an app already open goes to `url` (a notification, "big files").
    function openApp( url, opts )
    {
        opts = opts || {};
        var app = h.appOf( url );
        if( app && ! opts.fresh )
            for( var i = 0; i < wins.length; i++ )
                if( wins[ i ].app === app ) { reuse( wins[ i ], url, opts.nav ); return wins[ i ]; }

        var info = h.APPS[ app ] || { name: app ? app.charAt( 0 ).toUpperCase() + app.slice( 1 ) : h.appName, svg: ICON_WIN };
        var w = { app: app, name: info.name, svg: info.svg, url: '', pre: null,
                  scale: !! set.scaleNew, nat: null, s: 1, g: null };     // see SCALE; the menu's "Scale on open" sets the default

        var el = document.createElement( 'div' );
        el.className = 'win';
        el.innerHTML =
            '<div class="win-bar">' + info.svg + '<span class="win-title"></span></div>' +
            '<iframe class="win-frame" data-ayni-window></iframe>' +
            [ 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw' ].map( function ( d ) { return '<div class="grip ' + d + '" data-dir="' + d + '"></div>'; } ).join( '' );
        el.querySelector( '.win-title' ).textContent = info.name;

        var g = opts.geom, last = g ? null : ( store( LAST_KEY ) || {} )[ app ];
        if( g )
        {
            // a saved window: "123px" strings, plus its Scale (see SCALE)
            w.scale = !! g.scale; w.nat = g.nat || null;
            g = { l: parseFloat( g.l ) || 0, t: parseFloat( g.t ) || 0, w: parseFloat( g.w ) || 0, h: parseFloat( g.h ) || 0 };
        }
        else if( last )
        {
            // where this app's window was when last closed (LAST), kept inside the desk
            var d = deskRect();
            g = { w: Math.min( last.w, d.w ), h: Math.min( last.h, d.h ) };
            g.l = Math.max( 0, Math.min( last.l, d.w - g.w ) );
            g.t = Math.max( 0, Math.min( last.t, d.h - g.h ) );
            if( last.max ) el.classList.add( 'max' );
        }
        else
        {
            // 70% x 82% of the desk, each new one 32px down-right of the last;
            // a one-column app (a list) no wider than it needs (h.NARROW).
            var r = deskRect();
            var W = Math.min( h.NARROW[ app ] || 1100, Math.round( r.w * 0.7 ) ), H = Math.min( h.SHORT[ app ] || 780, Math.round( r.h * 0.82 ) );
            var n = wins.length % 6;
            g = { l: Math.max( 0, Math.round( ( r.w - W ) / 2 ) - 80 + n * 32 ), t: Math.max( 0, 24 + n * 32 ), w: W, h: H };
        }

        // Its chip on the bar (Ayni's markup; see ayni-desktop.css). The window's buttons
        // show on the chip of the window in front only.
        var chip = document.createElement( 'div' );
        chip.className = 'chip';
        chip.setAttribute( 'role', 'group' );
        chip.setAttribute( 'aria-label', info.name );
        chip.innerHTML = '<button class="chip-main" type="button">' + info.svg + '<span></span></button><span class="chip-ctl">' +
            CTL.map( function ( d ) { return '<button class="btn" type="button" data-win="' + d[ 0 ] + '">' + d[ 3 ] + '</button>'; } ).join( '' ) +
            '</span>';
        var main = chip.querySelector( '.chip-main' );
        main.querySelector( 'span:not(.icon)' ).textContent = info.name;
        setTip( main, info.name );
        CTL.forEach( function ( d )
        {
            if( ! d[ 1 ] ) return;              // Scale / Resize: see paintScale
            var b = chip.querySelector( '[data-win="' + d[ 0 ] + '"]' );
            setTip( b, t( d[ 1 ], d[ 2 ] ) );
            b.setAttribute( 'aria-label', b.dataset.tip );
        } );

        w.el = el; w.chip = chip; w.main = main; w.frame = el.querySelector( 'iframe' );
        wins.push( w );
        desk.appendChild( el );
        place( w, g );
        tasks.appendChild( chip );

        wire( w );
        if( url ) w.frame.src = url;
        focus( w );
        h.placeUnread();
        h.placeMail();
        retile();
        upright();
        return w;
    }

    function reuse( w, url, nav )
    {
        focus( w );
        if( ! nav || ! url ) return;
        var u = new URL( url, location.href ), want = u.pathname + u.search + u.hash;
        // Chat is never reloaded (it may be in a call): it is told which chat to show.
        if( w.app === 'chat' )
        {
            try
            {
                var cw = w.frame.contentWindow;
                cw.navigator.serviceWorker.dispatchEvent( new cw.MessageEvent( 'message', { data: { open: u.href } } ) );
            }
            catch( e ) {}
            return;
        }
        if( w.url !== want ) w.frame.src = want;
    }

    function setTitle( w, text, tip )
    {
        w.el.querySelector( '.win-title' ).textContent = text;
        w.main.querySelector( 'span:not(.icon)' ).textContent = text;
        w.chip.setAttribute( 'aria-label', text );
        setTip( w.main, tip || text );
    }

    function focus( w )
    {
        var back = w.el.hidden;     // brought back from the bar: it was minimised
        if( back ) w.el.hidden = false;
        w.el.style.zIndex = ++zTop;
        var was = front;
        front = w;
        paint();
        w.chip.scrollIntoView( { block: 'nearest', inline: 'nearest' } );     // many windows: the row or column of chips scrolls
        saveWins();
        if( back ) { queueMeasure( w ); retile(); }
        if( was && was !== w && was.app === 'chat' ) h.pokeUnread();
        if( was && was !== w && was.app === 'email' ) h.askMail();
        kbFit();
    }

    function minimise( w )
    {
        w.el.hidden = true;
        if( front === w ) front = topmost();
        paint();
        saveWins();
        retile();
    }

    // An app with work not yet saved (Image; Write, Calc and Text keep theirs
    // first, shared/office.js) asks first: its window.ayniBeforeClose answers
    // true to go, false to stay. While it asks, the window is in front.
    function close( w )
    {
        var ask = null;
        try { ask = w.frame.contentWindow.ayniBeforeClose; } catch( e ) {}
        if( typeof ask !== 'function' ) { shut( w ); return; }
        if( w.asking ) return;
        w.asking = true;
        focus( w );
        Promise.resolve().then( ask ).then( function ( ok ) { w.asking = false; if( ok ) shut( w ); },
                                            function () { w.asking = false; shut( w ); } );
    }

    function shut( w )
    {
        if( wins.indexOf( w ) < 0 ) return;     // gone already
        keepLast( w );
        if( kbWin === w ) kbWin = null;
        w.el.remove(); w.chip.remove();
        wins.splice( wins.indexOf( w ), 1 );
        if( front === w ) front = topmost();
        paint();
        h.placeUnread();
        h.placeMail();
        if( w.app === 'email' ) h.askMail();
        if( tiled ) { tiled.snaps.delete( w ); if( ! wins.length ) { autoWant = !! tiled.auto; tiled = null; } }   // see UPRIGHT
        paintTile();
        saveWins();
        retile();
    }

    function topmost()
    {
        var best = null;
        wins.forEach( function ( w ) { if( ! w.el.hidden && ( ! best || +w.el.style.zIndex > +best.el.style.zIndex ) ) best = w; } );
        return best;
    }

    function paint()
    {
        wins.forEach( function ( w )
        {
            var isFront = ( w === front && ! w.el.hidden );
            w.el.classList.toggle( 'focused', isFront );
            // the app's own title row (chromeless) softens too - an attribute, not a
            // class: Scale's watcher re-measures on class changes
            try { w.frame.contentDocument.documentElement.toggleAttribute( 'data-win-behind', ! isFront ); } catch( e ) {}
            if( isFront ) w.chip.setAttribute( 'aria-current', 'true' ); else w.chip.removeAttribute( 'aria-current' );
            w.chip.classList.toggle( 'min', w.el.hidden );
            w.chip.classList.toggle( 'has-dialog', !! w.dialog && ! isFront );
            paintScale( w );
        } );
        paintTile();
    }

    function act( w, what )
    {
        if( what === 'min' )   minimise( w );
        if( what === 'max' )   setMax( w, ! isMax( w ) );
        if( what === 'close' ) close( w );
        if( what === 'scale' ) setScale( w, ! w.scale );
    }

    function wire( w )
    {
        var el = w.el;

        // The chip: bring forward - or, when already in front, minimise. Its
        // window's buttons (in front only) do their own job.
        w.chip.addEventListener( 'click', function ( e )
        {
            var b = e.target.closest( '[data-win]' );
            if( b ) { act( w, b.getAttribute( 'data-win' ) ); return; }
            if( w === front && ! el.hidden ) minimise( w ); else focus( w );
        } );

        el.querySelector( '.win-bar' ).addEventListener( 'dblclick', function ( e )
        {
            if( ! e.target.closest( 'button' ) ) act( w, 'max' );
        } );

        el.addEventListener( 'pointerdown', function () { if( front !== w ) focus( w ); }, true );

        // Drag by the title bar; resize by the grips.
        el.addEventListener( 'pointerdown', function ( e )
        {
            if( e.button !== 0 ) return;
            var grip = e.target.closest( '.grip' );
            var wbar = ! grip && e.target.closest( '.win-bar' );
            if( ! grip && ! wbar ) return;
            if( wbar && ( e.target.closest( 'button' ) || el.classList.contains( 'max' ) ) ) return;
            drag( w, e, grip ? grip.getAttribute( 'data-dir' ) : '' );
        } );

        // Inside the frame (same origin): a press brings the window forward, the
        // document's name names it, and a new-tab open becomes a new desktop window.
        w.frame.addEventListener( 'load', function ()
        {
            var cw;
            try { cw = w.frame.contentWindow; cw.document; } catch( e ) { return; }
            if( ! cw ) return;
            // A signed-out app lands on the login page: that belongs to the whole desktop.
            if( /\/login\.html$/.test( cw.location.pathname ) ) { location.href = cw.location.href; return; }
            // kept without the origin: a site moved to https still finds its windows
            if( cw.location.href !== 'about:blank' ) { w.url = cw.location.pathname + cw.location.search + cw.location.hash; saveWins(); }
            // an editor puts the document it opens in its address (shared/office.js, showAddress)
            cw.addEventListener( 'ayni-address', function () { w.url = cw.location.pathname + cw.location.search + cw.location.hash; saveWins(); } );
            w.el.classList.remove( 'chromeless' );
            cw.addEventListener( 'pointerdown', function () { h.closeMenu(); closeMore(); if( front !== w ) focus( w ); }, true );
            hookAlt( cw );
            hookInner( w, cw );
            watchDialog( w, cw );
            // Taking the keys out of a frame drops its caret: kept here for giveKeys.
            cw.document.addEventListener( 'focusin', function ( e ) { w.lastFocus = e.target; }, true );
            // A plain link to the launcher (Planner's name) opens the menu instead.
            cw.document.addEventListener( 'click', function ( e )
            {
                var a = e.target.closest && e.target.closest( 'a[href]' );
                if( ! a || ! new RegExp( '^' + ROOT + '(index\\.html)?$' ).test( new URL( a.href, cw.location.href ).pathname ) ) return;
                e.preventDefault();
                h.openMenu();
            }, true );
            hookOpen( cw );
            cw.close = function () { close( w ); };     // an app's own "close" (Image's ✗ / Escape) closes its window
            trackTitle( w, cw );
            adoptHead( w, cw );
            paint();
            // Scale: the new page is measured, and again each time it changes -
            // its data came in, a panel opened (see SCALE).
            new cw.MutationObserver( function () { if( w.scale && w.frame.contentWindow === cw ) queueMeasure( w ); } )
                .observe( cw.document.documentElement, { childList: true, subtree: true, characterData: true,
                                                         attributes: true, attributeFilter: [ 'class', 'style', 'hidden' ] } );
            if( w.scale ) queueMeasure( w );
        } );
    }

    // Frames inside the window's page (Planner's Calendar / Tasks / Habits): a
    // press there never reaches the page's own listener, so each inner page -
    // at any depth, also one that loads later - brings the window forward too.
    function hookInner( w, cw )
    {
        function hook( f )
        {
            if( f._deskHooked ) return;
            f._deskHooked = true;
            function on()
            {
                var icw;
                try { icw = f.contentWindow; icw.document; } catch( e ) { return; }
                if( ! icw || icw._deskHooked ) return;
                icw._deskHooked = true;
                icw.addEventListener( 'pointerdown', function () { h.closeMenu(); closeMore(); if( front !== w ) focus( w ); }, true );
                hookAlt( icw );
                hookInner( w, icw );
                watchDialog( w, icw );
            }
            f.addEventListener( 'load', on );
            on();
        }
        function scan( root ) { if( root.tagName === 'IFRAME' ) hook( root ); else if( root.querySelectorAll ) root.querySelectorAll( 'iframe' ).forEach( hook ); }
        scan( cw.document.documentElement );
        new cw.MutationObserver( function ( recs )
        {
            recs.forEach( function ( r ) { r.addedNodes.forEach( scan ); } );
        } ).observe( cw.document.documentElement, { childList: true, subtree: true } );
    }

    // DIALOG MARK - a dialog (Ayni's dialog.panel[open]) open in the
    // window's page, or in a frame inside it (Planner's Calendar...), marks its
    // bar button while the window is behind others or minimised, so a question
    // left waiting is not forgotten. Dialogs stay modal to their own window.
    function hasDialog( doc )
    {
        if( doc.querySelector( 'dialog.panel[open]' ) ) return true;
        var fs = doc.querySelectorAll( 'iframe' );
        for( var i = 0; i < fs.length; i++ )
        {
            var d = null;
            try { d = fs[ i ].contentDocument; } catch( e ) {}
            if( d && hasDialog( d ) ) return true;
        }
        return false;
    }
    function markDialog( w )
    {
        w.dialogQueued = false;
        var on = false;
        try { on = hasDialog( w.frame.contentDocument ); } catch( e ) {}
        if( on === !! w.dialog ) return;
        w.dialog = on;
        paint();
    }
    // Class changes are many (a Calc selection...): one look per frame is enough.
    function watchDialog( w, cw )
    {
        function queue() { if( ! w.dialogQueued ) { w.dialogQueued = true; requestAnimationFrame( function () { markDialog( w ); } ); } }
        new cw.MutationObserver( queue )
            .observe( cw.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [ 'class', 'open' ] } );
        queue();
    }

    // The bar button says which DOCUMENT the window shows: Write / Calc / Text
    // name it in their #fileLabel, the other apps in their page title.
    function trackTitle( w, cw )
    {
        var doc = cw.document, label = doc.getElementById( 'fileLabel' );
        function update()
        {
            if( w.frame.contentWindow !== cw ) return;
            var name = label ? label.textContent.trim() : '';
            // Chat's "(3) Chat": the count is already on the button's red disc.
            var tt   = doc.title && doc.title !== 'about:blank' ? doc.title.replace( /^\(\d+\+?\)\s*/, '' ) : '';
            var text = name || tt || w.name;
            setTitle( w, text, text === w.name ? w.name : w.name + ' - ' + text );
        }
        update();
        var mo = new cw.MutationObserver( update ), opt = { childList: true, characterData: true, subtree: true };
        if( label ) mo.observe( label, opt );
        var te = doc.querySelector( 'title' );
        if( te ) mo.observe( te, opt );
    }

    // Move (dir "") or resize (dir "n", "se"...) a window with the pointer that
    // pressed. Screen coordinates, because the press may come from INSIDE the
    // frame (the app's own top row), whose client coordinates move with it.
    // A move let go at the desk's left / right edge fills that half of it, at
    // the top edge the whole of it; dragging a half-window again gives it back
    // its old size.
    // The grabbing hand, from the press on a title bar until it is let go. An
    // app's own row lives in its frame, so the rule goes into that page too.
    function grabCursor( doc, on )
    {
        if( on && ! doc.getElementById( 'winGrabCss' ) )
        {
            var st = doc.createElement( 'style' );
            st.id = 'winGrabCss';
            st.textContent = 'html.win-grab, html.win-grab * { cursor: grabbing !important; }';
            doc.head.appendChild( st );
        }
        doc.documentElement.classList.toggle( 'win-grab', on );
    }

    function drag( w, e, dir )
    {
        var el = w.el, inFrame = e.target.ownerDocument !== document;
        // Inside a frame the page holds the pointer, not the element pressed: an
        // app may redraw its row mid-drag (Trips does) and take that element away.
        var tgt = inFrame ? e.target.ownerDocument.documentElement : e.target;
        var x0 = e.screenX, y0 = e.screenY;
        var L = w.g.l, T = w.g.t, W = w.g.w, H = w.g.h;
        var r = deskRect(), zone = '';
        var minW = w.scale ? 1 : MIN_W, minH = w.scale ? 1 : MIN_H;     // Scale on: no smallest size

        // Where the pointer is on the desk (a move only needs this for the edges).
        var dr = desk.getBoundingClientRect(), px, py;
        // (a page shrunk by Scale counts in its own, bigger pixels: times w.s)
        if( inFrame ) { var fr = w.frame.getBoundingClientRect(); px = fr.left + e.clientX * w.s - dr.left; py = fr.top + e.clientY * w.s - dr.top; }
        else          { px = e.clientX - dr.left; py = e.clientY - dr.top; }
        if( ! dir && w.pre )
        {
            var fx = ( px - L ) / W;
            W = w.pre.w; H = w.pre.h; L = Math.round( px - fx * W );
            w.pre = null;
            place( w, { l: L, t: T, w: W, h: H } );
            W = w.g.w; H = w.g.h;
        }

        e.preventDefault();
        try { tgt.setPointerCapture( e.pointerId ); } catch( err ) {}
        // No frame may swallow the pointer on the way - except the one that holds it.
        el.classList.add( 'dragging' );
        desk.classList.add( inFrame ? 'busy-frame' : 'busy' ); document.body.classList.add( 'busy' );
        if( inFrame ) tgt.ownerDocument.documentElement.style.userSelect = 'none';
        if( ! dir ) { grabCursor( document, true ); if( inFrame ) grabCursor( tgt.ownerDocument, true ); }

        // Sticky windows: the half of the desk an edge offers.
        function zoneRect( z )
        {
            var hw = Math.round( r.w / 2 ), hh = Math.round( r.h / 2 );
            return z === 'left'   ? { l: 0,  t: 0,  w: hw,       h: r.h }
                 : z === 'right'  ? { l: hw, t: 0,  w: r.w - hw, h: r.h }
                 : z === 'top'    ? { l: 0,  t: 0,  w: r.w,      h: hh }
                 :                  { l: 0,  t: hh, w: r.w,      h: r.h - hh };
        }

        function showZone( z )
        {
            zone = z;
            ghost.hidden = ! z;
            if( ! z ) return;
            var g = zoneRect( z );
            ghost.style.left   = g.l + 'px';
            ghost.style.top    = g.t + 'px';
            ghost.style.width  = g.w + 'px';
            ghost.style.height = g.h + 'px';
        }

        function move( ev )
        {
            var dx = ev.screenX - x0, dy = ev.screenY - y0;
            if( ! dir )
            {
                // keep at least the top row reachable (all of a window smaller than that)
                var kx = Math.min( 80, W ), ky = Math.min( 38, H );
                moveTo( w, Math.min( r.w - kx, Math.max( kx - W, L + dx ) ), Math.min( r.h - ky, Math.max( 0, T + dy ) ) );
                var cx = px + dx, cy = py + dy;
                // Bottom: the window's own lower edge pushed 6px past the desk's
                // (the pointer, up on the title bar, is far from it) - for a window
                // that started above it; one already on it (tiled) needs the pointer.
                var low = ( T + H < r.h && w.g.t + H >= r.h + 6 ) || cy >= r.h - 6;
                if( set.sticky ) showZone( cx <= 6 ? 'left' : cx >= r.w - 6 ? 'right' : cy <= 6 ? 'top' : low ? 'bottom' : '' );
                return;
            }
            var nl = L, nt = T, nw = W, nh = H;
            if( dir.indexOf( 'e' ) >= 0 ) nw = Math.max( minW, W + dx );
            if( dir.indexOf( 's' ) >= 0 ) nh = Math.max( minH, H + dy );
            if( dir.indexOf( 'w' ) >= 0 ) { nw = Math.max( minW, W - dx ); nl = L + W - nw; }
            if( dir.indexOf( 'n' ) >= 0 ) { nh = Math.max( minH, H - dy ); nt = Math.max( 0, T + H - nh ); nh = T + H - nt; }
            place( w, { l: nl, t: nt, w: nw, h: nh } );
            // A shrunk window that cannot stretch further one way (AyniTiling.fit's
            // cap) keeps the edge that is not being pulled where it was.
            if( dir.indexOf( 'w' ) >= 0 && w.g.w !== nw ) moveTo( w, nl + nw - w.g.w, w.g.t );
            if( dir.indexOf( 'n' ) >= 0 && w.g.h !== nh ) moveTo( w, w.g.l, nt + nh - w.g.h );
        }
        function up()
        {
            el.classList.remove( 'dragging' );
            desk.classList.remove( 'busy', 'busy-frame' ); document.body.classList.remove( 'busy' );
            if( inFrame ) tgt.ownerDocument.documentElement.style.userSelect = '';
            if( ! dir ) { grabCursor( document, false ); if( inFrame ) grabCursor( tgt.ownerDocument, false ); }
            tgt.removeEventListener( 'pointermove', move );
            tgt.removeEventListener( 'pointerup', up );
            tgt.removeEventListener( 'pointercancel', up );
            if( zone ) { w.pre = { w: W, h: H }; place( w, zoneRect( zone ) ); }
            showZone( '' );
            saveWins();
        }
        tgt.addEventListener( 'pointermove', move );
        tgt.addEventListener( 'pointerup', up );
        tgt.addEventListener( 'pointercancel', up );
    }

    //------------------------------------------------------------------------//
    // THE WINDOW'S BUTTONS live on the bar, on the bar button of the window in
    // front (see .chip-ctl): Scale / Resize, minimise, maximise, close. Scale /
    // Resize is two-state: its icon and tooltip say which way the window is now.
    var SVG_OPEN     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">';
    var ICON_SCALE   = SVG_OPEN + '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M14 15H9v-5"/><path d="M16 3h5v5"/><path d="M21 3 9 15"/></svg>';
    var ICON_RESIZE  = SVG_OPEN + '<polyline points="5 11 5 5 11 5"/><polyline points="19 13 19 19 13 19"/><line x1="5" y1="5" x2="19" y2="19"/></svg>';
    var ICON_TILE    = SVG_OPEN + '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="12" y1="12" x2="21" y2="12"/></svg>';
    var CTL = [
        [ 'scale', '',                 '',         ICON_RESIZE ],
        [ 'min',   'ayni.win.minimise', 'Minimise', SVG_OPEN + '<line x1="5" y1="12" x2="19" y2="12"/></svg>' ],
        [ 'max',   'ayni.win.maximise', 'Maximise', SVG_OPEN + '<rect x="5" y="5" width="14" height="14" rx="2"/></svg>' ],
        [ 'close', 'ayni.close',         'Close',    SVG_OPEN + '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>' ]
    ];

    function paintScale( w )
    {
        var b = w.chip.querySelector( '[data-win="scale"]' ), on = !! w.scale;
        if( ! b || b.getAttribute( 'aria-pressed' ) === String( on ) ) return;
        b.setAttribute( 'aria-pressed', String( on ) );
        b.innerHTML = on ? ICON_SCALE : ICON_RESIZE;
        setTip( b, on ? t( 'ayni.desktop.scaleOn',  'Scale: a smaller window shrinks everything in it' )
                     : t( 'ayni.desktop.scaleOff', 'Resize: a smaller window rearranges its content' ) );
        b.setAttribute( 'aria-label', b.dataset.tip );
    }

    //------------------------------------------------------------------------//
    // THE APP'S OWN TOP ROW AS TITLE BAR. Every app opens with a row holding
    // its icon, its name and its toolbar; in a window that row drags the window
    // from any empty spot and maximises it on a double click. The row is the
    // first one that holds the app's icon - also when it is only a column
    // (Chat's list) or sits in a card (Trips). A page with no such row (a
    // document opened blank) keeps the desktop's own bar.

    var HEAD_SEL    = '.topbar, .header, .trip-header';
    var INTERACTIVE = 'button, a, input, .picker, textarea, label, [contenteditable], [role="button"], [tabindex]';

    function findHead( doc )
    {
        var list = doc.querySelectorAll( HEAD_SEL );
        for( var i = 0; i < list.length; i++ )
        {
            var r = list[ i ].getBoundingClientRect();
            if( r.height > 0 && list[ i ].querySelector( '.app-icon' ) ) return list[ i ];
        }
        return null;
    }

    function adoptHead( w, cw )
    {
        var doc = cw.document, head = null;

        // Find the row - and find it again. Some apps draw their row only once
        // their data is in, and some redraw it, so this runs on every change of
        // the page. Once found, the same row stays the title bar while it is on
        // the page: Trips keeps its header box when a trip is open, even though
        // the app icon is gone from it then.
        function ensure()
        {
            if( w.frame.contentWindow !== cw ) { mo.disconnect(); return; }
            if( ! head || ! head.isConnected ) head = findHead( doc );
            if( ! head ) return;
            // a finger on it drags the window: the browser must not take it for a scroll
            if( head.style.touchAction !== 'none' ) head.style.touchAction = 'none';
            if( ! w.el.classList.contains( 'chromeless' ) ) { w.el.classList.add( 'chromeless' ); paint(); }
        }
        // style / hidden too: an app that starts with its whole page hidden
        // (#app display: none until signed in) and then only UN-hides parts -
        // eMail with no account yet - adds no node at all, and its row would
        // never be found. Only those two attributes, so the rest of the app's
        // restyling does not wake this up.
        var mo = new cw.MutationObserver( ensure );
        mo.observe( doc.documentElement, { childList: true, subtree: true,
                                           attributes: true, attributeFilter: [ 'style', 'hidden' ] } );
        ensure();

        // A press only becomes a drag once it moves 4px: Calc, Write and Text
        // fill most of the row with their file name, which a plain click edits,
        // and Trips with its name, which a plain click takes to the menu.
        // The empty strip ABOVE the row drags too, and so does any empty spot
        // of a layer that covers the row (data-win-drag: Chat's call screen,
        // and its open chat's bar when the window is as narrow as a phone),
        // except its own boxes (data-win-nodrag: the picture in the corner).
        doc.addEventListener( 'pointerdown', function ( e )
        {
            if( e.button !== 0 || e.target.closest( INTERACTIVE ) || w.el.classList.contains( 'max' ) ) return;
            var cover = e.target.closest( '[data-win-drag]' );
            if( cover ? e.target.closest( '[data-win-nodrag]' ) : ! head ) return;
            if( ! cover && ! head.contains( e.target ) && e.clientY >= head.getBoundingClientRect().top ) return;
            var x0 = e.screenX, y0 = e.screenY;
            grabCursor( doc, true );                              // the hand shows on the press, not the 4px
            function move( ev )
            {
                if( Math.abs( ev.screenX - x0 ) + Math.abs( ev.screenY - y0 ) < 4 ) return;
                stop();
                drag( w, e, '' );
                // ...and the click that ends the drag must not edit the name. The
                // browser fires it right after pointerup, if at all: the eater
                // leaves on the next tick either way.
                function eat( c ) { c.stopPropagation(); c.preventDefault(); }
                doc.addEventListener( 'click', eat, true );
                doc.addEventListener( 'pointerup', function () { setTimeout( function () { doc.removeEventListener( 'click', eat, true ); }, 0 ); }, { capture: true, once: true } );
            }
            function stop()
            {
                grabCursor( doc, false );                         // drag() puts it back if a drag starts
                doc.removeEventListener( 'pointermove', move, true );
                doc.removeEventListener( 'pointerup', stop, true );
            }
            doc.addEventListener( 'pointermove', move, true );
            doc.addEventListener( 'pointerup', stop, true );
        } );
        doc.addEventListener( 'dblclick', function ( e )
        {
            // the same spots a press drags from: the row, or a data-win-drag layer
            var cover = e.target.closest( '[data-win-drag]' );
            if( e.target.closest( INTERACTIVE ) || ( cover ? e.target.closest( '[data-win-nodrag]' ) : ! ( head && head.contains( e.target ) ) ) ) return;
            act( w, 'max' );
        } );
    }

    // window.open from inside an app: a the app page opens as a desktop window; the
    // opener gets that window's frame, so Drive's "open blank now, point it at the
    // file later" still works. Anything else (a map, an outside site) keeps its tab.
    function hookOpen( cw )
    {
        var real = cw.open;
        cw.open = function ( url, target, features )
        {
            url = url || '';
            if( url && ! h.appOf( url ) ) return real.call( cw, url, target, features );
            var abs = url ? new URL( url, cw.location.href ).href : 'about:blank';
            var w = sameImage( abs ) || sameDoc( abs );
            if( w ) focus( w ); else w = openApp( abs, { fresh: true } );
            return /noopener/.test( features || '' ) ? null : w.frame.contentWindow;
        };
    }

    // A picture already open in Image: its window, never a second editor on
    // the same file (two would each save over the other).
    function sameImage( abs )
    {
        if( h.appOf( abs ) !== 'image' ) return null;
        var u = new URL( abs ), want = u.pathname + u.search;
        for( var i = 0; i < wins.length; i++ )
            if( wins[ i ].app === 'image' && wins[ i ].url === want ) return wins[ i ];
        return null;
    }

    // The same for a document already open in Write, Calc or Text (Drive
    // opens one on every double-click): two editors on one file each saved
    // over the other with no question. The window is asked what it shows NOW
    // (shared/office.js, ayniDocPath) - another document may have been
    // opened in it since; its address only while its page cannot answer yet.
    // Any of the three counts: a .csv open in Calc and "Open with > Text"
    // would be two editors on one file just the same.
    var DOC_APPS = [ 'write', 'calc', 'text' ];

    function sameDoc( abs )
    {
        if( DOC_APPS.indexOf( h.appOf( abs ) ) < 0 ) return null;
        var want = new URL( abs ).searchParams.get( 'file' );
        if( ! want ) return null;
        for( var i = 0; i < wins.length; i++ )
        {
            var w = wins[ i ], has = null, ask = null;
            if( DOC_APPS.indexOf( w.app ) < 0 ) continue;
            try { ask = w.frame.contentWindow.ayniDocPath; } catch( e ) {}
            if( typeof ask === 'function' ) { try { has = ask(); } catch( e ) {} }
            else has = new URL( w.url || w.frame.src, location.href ).searchParams.get( 'file' );
            if( has === want ) return w;
        }
        return null;
    }

    //------------------------------------------------------------------------//
    // OPEN WINDOWS SURVIVE A RELOAD - their pages, places, sizes, order and
    // state, per device ("desktop-wins"). Written a moment after each change.

    var WINS_KEY = KEYS + 'desktop-wins', saveTimer = 0, restoring = false;

    function saveWins()
    {
        if( restoring ) return;
        clearTimeout( saveTimer );
        saveTimer = setTimeout( function ()
        {
            var list = wins.filter( function ( w ) { return w.url; } )
                .sort( function ( a, b ) { return +a.el.style.zIndex - +b.el.style.zIndex; } )
                .map( function ( w )
                {
                    var rec = { url: w.url, l: px( w.g.l ), t: px( w.g.t ), w: px( w.g.w ), h: px( w.g.h ),
                                max: isMax( w ), min: !! w.el.hidden, pre: w.pre };
                    if( w.scale ) { rec.scale = true; rec.nat = w.nat; }
                    if( tiled && tiled.snaps.has( w ) ) rec.snap = tiled.snaps.get( w );
                    return rec;
                } );
            store( WINS_KEY, list );
            store( TILE_KEY, tiled ? { dw: tiled.dw, dh: tiled.dh, auto: !! tiled.auto } : null );
        }, 300 );
    }

    // LAST - where each app's window was when it closed, per device
    // ("desktop-last"); its next window opens there. Of two windows of
    // one app, the last one closed counts. A tiled window keeps nothing; Scale
    // is not kept ("Scale on open" decides it).
    var LAST_KEY = KEYS + 'desktop-last';

    function keepLast( w )
    {
        if( ! w.app || ! w.g || ( tiled && tiled.snaps.has( w ) ) ) return;
        var last = store( LAST_KEY ) || {};
        last[ w.app ] = { l: w.g.l, t: w.g.t, w: w.g.w, h: w.g.h, max: isMax( w ) };
        store( LAST_KEY, last );
    }

    function restoreWins()
    {
        var list = store( WINS_KEY ) || [];
        var tl   = store( TILE_KEY );
        restoring = true;
        if( tl ) tiled = { snaps: new Map(), dw: tl.dw, dh: tl.dh, auto: !! tl.auto };
        var minimised = [];
        list.forEach( function ( s )
        {
            if( ! s || ! s.url || ! h.appOf( s.url ) ) return;
            var w = openApp( s.url, { fresh: true, geom: s } );
            w.url = s.url;
            w.pre = s.pre || null;
            if( s.max ) { w.el.classList.add( 'max' ); place( w, w.g ); }
            if( s.min ) minimised.push( w );
            if( tiled && s.snap ) tiled.snaps.set( w, s.snap );
        } );
        minimised.forEach( function ( w ) { w.el.hidden = true; } );
        front = topmost();
        paint();
        restoring = false;
        if( tiled && ! wins.length ) tiled = null;
        // tiled on a desk of another size (the browser window changed meanwhile)
        if( tiled && ( desk.clientWidth !== tiled.dw || desk.clientHeight !== tiled.dh ) ) retile( true );
    }

    //------------------------------------------------------------------------//
    // SCALE - per window (w.scale), off by default. Off (Resize), a window is
    // what it always was: never smaller than MIN_W x MIN_H, and a smaller window
    // rearranges its page. On (Scale), there is no smallest size, and a window
    // made smaller shrinks like a picture of itself, chrome and all, from the
    // size it had at 1:1 (his call, 2026-09-28: the apps rearrange themselves
    // down to phone size, so "shrink only where scrollbars would appear" never
    // showed). That size is its NATURAL size (w.nat): the window stays laid out
    // at it and is drawn smaller by a CSS transform from its top-left corner
    // (AyniTiling.fit). Clicks, typing and the apps' own menus keep working:
    // the browser maps them through the transform.
    //
    // w.nat is kept while the window is shrunk - moved, tiled, maximised and
    // restored - and let go when the window is pulled back out to it (1:1 again,
    // at whatever size it then gets) or Scale is switched. Maximised, it is
    // always 1:1 - the sure way back to a readable window; restored, it is
    // shrunk again as before. Laid out at a fixed size, a shrunk page never
    // re-wraps, so there is nothing to chase.
    //
    // One more reason to shrink: a page too WIDE for its window (a fixed-width
    // sheet) is measured (AyniTiling.need) a moment after the window or the
    // page changes, and the window shrinks to show all of its width - the
    // natural width only ever grows that way. Height never counts: pages scroll.
    // "A moment" is two frames: some apps size parts of their page from
    // JavaScript on a resize, and a reading taken at once would see their old size.

    function isMax( w ) { return w.el.classList.contains( 'max' ); }
    function px( n )    { return Math.round( n * 100 ) / 100 + 'px'; }

    // Where a window shows on the desk: g = { l, t, w, h }, desk pixels. Every
    // change of a window's size comes through here; moveTo only moves it.
    function place( w, g )
    {
        g = { l: Math.round( g.l ), t: Math.round( g.t ), w: Math.max( 1, g.w ), h: Math.max( 1, g.h ) };
        var f = { s: 1, lw: g.w, lh: g.h };
        if( isMax( w ) ) { /* the CSS makes it the whole desk, 1:1; g is where it goes back to */ }
        else if( ! w.scale )
        {
            g.w = f.lw = Math.max( MIN_W, g.w );
            g.h = f.lh = Math.max( MIN_H, g.h );
        }
        else
        {
            // made smaller than it is at 1:1: that 1:1 size becomes the natural one
            if( ! w.nat && w.g && w.s === 1 && ( g.w < w.g.w || g.h < w.g.h ) )
                w.nat = { w: Math.max( MIN_W, w.g.w ), h: Math.max( MIN_H, w.g.h ) };
            if( ! w.nat && ( g.w < MIN_W || g.h < MIN_H ) ) w.nat = { w: MIN_W, h: MIN_H };
            if( w.nat )
            {
                var r = deskRect();
                f = AyniTiling.fit( g.w, g.h, w.nat, { w: 2 * r.w, h: 2 * r.h } );
                if( f.s >= 1 ) w.nat = null;             // pulled back out to full size: 1:1 from here
                g.w = f.w; g.h = f.h;
            }
            queueMeasure( w );
        }
        w.g = g;
        w.s = f.s;
        var st = w.el.style;
        st.left  = px( g.l );  st.top    = px( g.t );
        st.width = px( f.lw ); st.height = px( f.lh );
        st.transform = f.s < 1 ? 'scale(' + f.s + ')' : '';
        if( f.s < 1 ) st.setProperty( '--win-s', f.s ); else st.removeProperty( '--win-s' );
        if( kbWin === w ) kbShrink( w );         // the keyboard is still up: keep clear of it
        paintMax( w );
    }

    // The chip's maximise button says what a press will do: Restore while maximised.
    function paintMax( w )
    {
        var b = w.chip.querySelector( '[data-win="max"]' ), on = isMax( w ), max = CTL[ 2 ];
        if( ! b || b.classList.contains( 'is-max' ) === on ) return;
        b.classList.toggle( 'is-max', on );
        b.innerHTML = on && window.Ayni ? Ayni.icon( 'restore' ) : max[ 3 ];
        setTip( b, on ? t( 'ayni.win.restore', 'Restore' ) : t( max[ 1 ], max[ 2 ] ) );
        b.setAttribute( 'aria-label', b.dataset.tip );
    }

    // An app of a fixed size asks its window to hug the page: cw's frame becomes
    // W x H, its corner stays, all on the desk. Calculator (hugWindow). Answers
    // false for a window that must keep its size (maximised, tiled, Scale on) or
    // when the desk is too small for it.
    window.ayniFitWindow = function ( cw, W, H )
    {
        var w = wins.filter( function ( x ) { return x.frame.contentWindow === cw; } )[ 0 ];
        if( ! w || isMax( w ) || w.scale || ( tiled && tiled.snaps.has( w ) ) ) return false;
        var d  = deskRect();
        var gw = Math.min( W + w.el.offsetWidth  - w.frame.offsetWidth,  d.w );
        var gh = H + w.el.offsetHeight - w.frame.offsetHeight;
        if( gh > d.h ) return false;
        place( w, { l: Math.max( 0, Math.min( w.g.l, d.w - gw ) ), t: Math.max( 0, Math.min( w.g.t, d.h - gh ) ), w: gw, h: gh } );
        saveWins();
        return true;
    };

    function moveTo( w, l, t )
    {
        w.g.l = Math.round( l ); w.g.t = Math.round( t );
        w.el.style.left = px( w.g.l ); w.el.style.top = px( w.g.t );
    }

    // Maximise / restore: maximised is always 1:1; restored, a shrunk window is shrunk again as before.
    function setMax( w, on )
    {
        w.el.classList.toggle( 'max', on );
        place( w, w.g );
        saveWins();
    }

    // Scale on / off. Switched on, the window's size now is its natural one:
    // made smaller from here, it shrinks (and a page too wide for it shrinks at
    // once). Switched off, the page is 1:1 again and the window at least
    // MIN_W x MIN_H.
    function setScale( w, on )
    {
        w.scale = !! on;
        w.nat = null;
        place( w, w.g );
        paint();
        saveWins();
    }

    function queueMeasure( w )
    {
        if( w.measuring ) return;
        w.measuring = true;
        requestAnimationFrame( function () { requestAnimationFrame( function () { w.measuring = false; measure( w ); } ); } );
    }

    function measure( w )
    {
        if( ! w.scale || isMax( w ) || w.el.hidden || wins.indexOf( w ) < 0 ) return;
        var de;
        try { de = w.frame.contentDocument && w.frame.contentDocument.documentElement; } catch( e ) { return; }
        if( ! de ) return;
        var r = deskRect();
        var n = AyniTiling.need( { outW:  w.el.offsetWidth, outH:  w.el.offsetHeight,     // laid-out size, not drawn
                                     viewW: de.clientWidth,   viewH: de.clientHeight,
                                     fullW: de.scrollWidth,   fullH: de.scrollHeight,
                                     deskW: r.w,              deskH: r.h } );
        // Only a page too wide for the window counts, and only to widen the natural size.
        var nat = w.nat || { w: MIN_W, h: Math.max( MIN_H, w.g.h ) };
        if( ! ( n.w > nat.w ) ) return;
        w.nat = { w: n.w, h: nat.h };
        place( w, w.g );
        saveWins();
    }

    //------------------------------------------------------------------------//
    // TILE / UNTILE - one switch for the whole desk. Tile deals the desk out
    // among the windows on it (minimised ones stay minimised), in the order of
    // their bar buttons (AyniTiling.tile). Each window just gets a box: one
    // with Scale on shrinks to fit it, one without shows scrollbars, as always.
    // Untile puts every window back EXACTLY as it was before: place, size,
    // maximised, minimised, Scale and its factor. Whatever was done to them
    // while tiled is dropped. The stacking order is not put back: the window
    // in front stays in front.
    //
    // The "before" (tiled.snaps) is kept here, by the desktop, not by the
    // window, and it survives a reload (in each window's saved record). It is
    // taken for every window when Tile is switched on, and for a window opened
    // while tiled the first time the layout places it - so Untile sends that
    // one to where a new window opens.
    //
    // While tiled, opening, closing, minimising or bringing back a window deals
    // the desk out again (RETILE; false = a new window floats until the next
    // Tile), and so does a new desk size (the browser window, the bar).

    var RETILE   = true;
    var TILE_GAP = 0;               // pixels between two tiled windows
    var TILE_KEY = KEYS + 'desktop-tile';
    var tiled    = null;            // while tiled: { snaps: Map( window -> its state before ), dw, dh: the desk tiled,
                                    //                auto: tiled by UPRIGHT, not by hand }
    var retiling = false;

    function stateOf( w )
    {
        return { g: { l: w.g.l, t: w.g.t, w: w.g.w, h: w.g.h }, max: isMax( w ), min: !! w.el.hidden,
                 pre: w.pre ? { w: w.pre.w, h: w.pre.h } : null,
                 scale: !! w.scale, nat: w.nat ? { w: w.nat.w, h: w.nat.h } : null, s: w.s };
    }

    function tile()
    {
        var list = wins.filter( function ( w ) { return ! w.el.hidden; } );
        if( ! tiled && ! list.length ) return false;      // nothing on the desk to deal out
        if( ! tiled )
        {
            tiled = { snaps: new Map() };
            wins.forEach( function ( w ) { tiled.snaps.set( w, stateOf( w ) ); } );
        }
        var r = deskRect();
        tiled.dw = r.w; tiled.dh = r.h;
        AyniTiling.tile( list.length, r.w, r.h, { gap: TILE_GAP, minW: MIN_W, minH: MIN_H } ).forEach( function ( g, i )
        {
            var w = list[ i ];
            if( ! tiled.snaps.has( w ) ) tiled.snaps.set( w, stateOf( w ) );
            // a maximised window shrinks (Scale) from the whole desk it showed
            if( isMax( w ) ) { w.el.classList.remove( 'max' ); w.g = { l: 0, t: 0, w: r.w, h: r.h }; w.nat = null; w.s = 1; }
            w.pre = null;
            place( w, g );
        } );
        paintTile();
        saveWins();
        return true;
    }

    function untile()
    {
        if( ! tiled ) return false;
        var snaps = tiled.snaps;
        tiled = null;
        snaps.forEach( function ( st, w )
        {
            if( wins.indexOf( w ) < 0 ) return;           // closed while tiled
            w.el.classList.toggle( 'max', !! st.max );
            w.el.hidden = !! st.min;
            w.pre   = st.pre || null;
            w.scale = !! st.scale;
            w.nat   = st.nat || null;
            w.g     = { l: st.g.l, t: st.g.t, w: st.g.w, h: st.g.h };   // exactly as before: no "made smaller" here
            place( w, st.g );
        } );
        if( ! front || front.el.hidden ) front = topmost();
        paint();
        saveWins();
        return true;
    }

    // Deal the desk out again, once, on the next frame. `always`: even with RETILE off.
    function retile( always )
    {
        if( ! tiled || restoring || retiling || ! ( RETILE || always ) ) return;
        retiling = true;
        requestAnimationFrame( function () { retiling = false; if( tiled ) tile(); } );
    }

    new ResizeObserver( function ()
    {
        upright();
        if( tiled && ( desk.clientWidth !== tiled.dw || desk.clientHeight !== tiled.dh ) ) retile( true );
    } ).observe( desk );

    // UPRIGHT (2026-10-01) - a touch screen narrower than 1024px (a tablet held
    // upright) tiles the desk by itself: windows side by side, never on top of
    // each other. Wide again, the desk goes back to Free - only if this did the
    // tiling (tiled.auto, saved with it, so a reload in between still knows);
    // a desk tiled by hand stays tiled. It acts when the width CROSSES 1024px,
    // so Free picked by hand while upright stays Free; with no window yet, the
    // first one opened is tiled. The "⋮" switch is the same one; nothing else
    // is saved. A PC (no touch screen) never does this.
    var narrow = null, autoWant = false;
    function upright()
    {
        if( restoring ) return;
        var n = coarse.matches && window.innerWidth < 1024;
        if( n !== narrow )
        {
            narrow = n;
            autoWant = n;
            if( ! n && tiled && tiled.auto ) untile();
        }
        if( autoWant && ! tiled && tile() ) tiled.auto = true;
        if( tiled ) autoWant = false;
    }
    if( coarse.addEventListener ) coarse.addEventListener( 'change', upright );

    // THE SWITCH in the "⋮": "Free ()== Tile". A word picks its side, the switch
    // flips. The word Tile while tiled deals the desk out again - after windows
    // were moved or maximised by hand, say.
    var tileSw = document.getElementById( 'tileSw' ), tileOn = document.getElementById( 'tileOn' ),
        tileOff = document.getElementById( 'tileOff' );

    function paintTile()
    {
        var idle = ! tiled && ! wins.some( function ( w ) { return ! w.el.hidden; } );
        tileOn.checked  = !! tiled;
        tileOff.checked = ! tiled;
        tileOn.disabled = tileOff.disabled = idle;
        tileSw.classList.toggle( 'idle', idle );
    }

    tileOn.addEventListener( 'change', function () { tile(); paintTile(); } );
    tileOff.addEventListener( 'change', function () { untile(); paintTile(); } );
    tileOn.addEventListener( 'click', function () { if( tiled ) { tile(); paintTile(); } } );     // already on: no change event
    paintTile();

    //------------------------------------------------------------------------//
    // MORE - the "⋮" after the clock (2026-09-28): Ayni's popup with controls
    // (opened by its button, or by h.openMoreHere). Holds the Free/Tile switch,
    // Sticky windows, the clock, the bar, the screen locker and Lock now. Open
    // popups close on their own with a press elsewhere, Escape, a resize, or when
    // a frame takes the focus; a press in a frame that does not take it: closeMore.

    var moreBtn = document.getElementById( 'moreBtn' ), moreMenu = document.getElementById( 'moreMenu' );

    function placeMore() { if( moreMenu.matches( ':popover-open' ) ) Ayni.place( moreMenu, moreBtn ); }

    // The bar's popups (the "⋮", the weather, the month), closed from code.
    function closeMore()
    {
        [ moreMenu, wxPop, calPop ].forEach( function ( p ) { if( p.matches( ':popover-open' ) ) p.hidePopover(); } );
    }

    document.getElementById( 'lockNowBtn' ).addEventListener( 'click', function ()
    {
        closeMore();
        if( window.AyniLocker ) AyniLocker.lock();
    } );

    // STICKY WINDOWS - this device's choice (set.sticky); see drag.
    var stickyChk = document.getElementById( 'stickyChk' );
    stickyChk.checked = set.sticky !== false;
    stickyChk.addEventListener( 'change', function () { set.sticky = stickyChk.checked; saveSet(); } );

    // SCALE ON OPEN - this device's choice (set.scaleNew); see SCALE.
    var scaleNewChk = document.getElementById( 'scaleNewChk' );
    scaleNewChk.checked = !! set.scaleNew;
    scaleNewChk.addEventListener( 'change', function () { set.scaleNew = scaleNewChk.checked; saveSet(); } );

    // OPEN THE DESKTOP - this device's choice (set.mode): auto (a big screen
    // with a mouse or touchpad), always (a big screen, mouse or not), never
    // (the simple view). Set ONLY in My account (../index.html, #deskModeSel;
    // one action, one knob), which also opens in a window here: we follow its
    // change. The launcher reads it before it sends a big screen here; both
    // pages ask the same rule (ayniWantDesk, shared/desk-rule.js). A choice
    // that no longer wants the desktop leaves for the simple view at once.
    function toSimple() { location.replace( '../index.html' ); }
    if( set.mode !== 'always' && set.mode !== 'never' ) set.mode = 'auto';
    window.addEventListener( 'storage', function ( e )
    {
        if( e.key !== SET_KEY ) return;
        var m = ( store( SET_KEY ) || {} ).mode;
        if( m !== 'always' && m !== 'never' ) m = 'auto';
        if( m === set.mode ) return;
        set.mode = m;
        if( ! ayniWantDesk( set.mode ) ) toSimple();
    } );

    // MOUSE CHIP - on Auto, the mouse or touchpad taken away offers the simple
    // view (the launcher offers the desktop when one comes back): the shared
    // toast with a button. Never a move on its own: left alone, it goes.
    var finePtr = window.matchMedia( '(any-pointer: fine)' );
    function onFineChange()
    {
        if( finePtr.matches || set.mode !== 'auto' ) return;
        Ayni.toast( 'info', t( 'ayni.desktop.toSimpleAsk' ), { action: { label: t( 'ayni.desktop.toSimpleGo' ), icon: 'apps', run: toSimple } } );
    }
    if( finePtr.addEventListener ) finePtr.addEventListener( 'change', onFineChange );

    // THE CLOCK AND THE BAR - every change applies at once; the menu stays open,
    // and follows the bar when it moves or changes size.
    var F = {
        dow:  document.getElementById( 'setDow' ), date: document.getElementById( 'setDate' ),
        secs: document.getElementById( 'setSecs' ), bar: document.getElementById( 'setBar' ),
        barH: document.getElementById( 'setBarH' )
    };
    var barHOut = document.getElementById( 'setBarHOut' );
    F.date.checked = !! set.date; F.secs.checked = !! set.secs;
    F.barH.value = set.barH; barHOut.textContent = set.barH + ' px';
    // The weekday and the bar's side are Ayni list pickers: set once Ayni has started
    document.addEventListener( 'DOMContentLoaded', function () { if( window.Ayni ) Ayni.ready.then( function ()
    {
        Ayni.picker( F.dow ).set( set.dow ); Ayni.picker( F.bar ).set( set.bar );
        loadTz2(); h.loadLocker();
    } ); } );
    Object.keys( F ).forEach( function ( k )
    {
        F[ k ].addEventListener( k === 'barH' ? 'input' : k === 'dow' || k === 'bar' ? 'ayni:change' : 'change', function ()
        {
            set.dow = Ayni.picker( F.dow ).value; set.date = F.date.checked; set.secs = F.secs.checked;
            set.bar = Ayni.picker( F.bar ).value; set.barH = +F.barH.value;
            barHOut.textContent = set.barH + ' px';
            saveSet();
            applyLayout();
            tick();
            placeMore();
        } );
    } );

    // THE SECOND CLOCK's rows: the switch shows the zone's list; the list is
    // filled at each menu open (ui.js is deferred), its first pick UTC.
    var tz2On = document.getElementById( 'setTz2On' ), tz2Sel = document.getElementById( 'setTz2' ),
        tz2Wrap = document.getElementById( 'tz2Wrap' );
    function loadTz2()
    {
        if( ! window.Ayni || ! Ayni.picker ) return;      // an Ayni filtered list; called again once Ayni has started
        var pk = Ayni.picker( tz2Sel );
        var zones = Ayni.dates.zones().slice();
        if( set.tz2 && zones.indexOf( set.tz2 ) < 0 ) zones.unshift( set.tz2 );
        if( zones.indexOf( 'UTC' ) < 0 ) zones.unshift( 'UTC' );
        if( pk.options.length !== zones.length )
            pk.options = zones.map( function ( z ) { return { value: z, text: z.replace( /_/g, ' ' ) }; } );
        pk.set( set.tz2 || 'UTC' );
        tz2On.checked = !! set.tz2On;
        tz2Wrap.hidden = ! set.tz2On;
    }
    function saveTz2()
    {
        set.tz2On = tz2On.checked; set.tz2 = Ayni.picker( tz2Sel ).value || 'UTC';
        tz2Wrap.hidden = ! set.tz2On;
        saveSet();
        tick();
        placeMore();
    }
    tz2On.addEventListener( 'change', saveTz2 );
    tz2Sel.addEventListener( 'ayni:change', saveTz2 );
    loadTz2();
    moreBtn.addEventListener( 'click', loadTz2 );

    //------------------------------------------------------------------------//
    // WEATHER - this device's choice (set.weatherBar, the "⋮" menu): the sky
    // now as an icon on the bar, again every 30 min; a press opens today's
    // forecast beside it, fetched then (never on its own). The place, the units
    // and who gives it are the screen locker's (Bellas artes' settings, per
    // user), and so is the engine: shared/lockers/culture.js, loaded only when
    // this is on. Its cache too ("nv-culture:"): the locker reuses our call.

    var wxBtn = document.getElementById( 'wxBtn' ), wxPop = document.getElementById( 'wxPop' ),
        wxChk = document.getElementById( 'weatherBarChk' );
    var wxTimer = 0, wxGen = 0, wxPopGen = 0, wxCached = null;
    var WX_EVERY = 30 * 60000;

    // One icon per sky of the engine's skyOf (clear, partly cloudy, cloudy, fog,
    // drizzle, rain, snow, showers, storm), [ day, night ] where they differ.
    // Class "s" paints amber (sun, bolt), "sd" fills the sun's disc, "r" blue (rain, snow).
    var WX_CLOUD = '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>';
    // A sun behind the cloud `d`: its rays, and its disc (filled, like the clear
    // sky's) cut away by the cloud with a small gap - a mask, "#M" made unique per
    // icon in wxSvg; then the cloud itself.
    function wxPeek( d )
    {
        return '<path class="s" d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41"/>' +
               '<mask id="M"><rect width="24" height="24" fill="#fff" stroke="none"/>' +
               '<path d="' + d + '" fill="#000" stroke="#000" stroke-width="5"/></mask>' +
               '<circle class="s sd" cx="12" cy="12" r="4" mask="url(#M)"/><path d="' + d + '"/>';
    }
    var WX_ICONS =
    [
        [ '<g class="s"><circle class="sd" cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></g>',
          '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>' ],
        [ wxPeek( 'M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z' ),
          '<path d="M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z"/><path d="M10.1 9A6 6 0 0 1 16 4a4 4 0 0 0 6 6 6 6 0 0 1-3 5.197"/>' ],
        [ '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>' ],
        [ WX_CLOUD + '<path d="M16 17H7M17 21H9"/>' ],
        [ WX_CLOUD + '<path class="r" d="M8 19v1M8 14v1M16 19v1M16 14v1M12 21v1M12 16v1"/>' ],
        [ WX_CLOUD + '<path class="r" d="M16 14v6M8 14v6M12 16v6"/>' ],
        [ WX_CLOUD + '<path class="r" d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/>' ],
        [ wxPeek( 'M3 20a5 5 0 1 1 8.9-4H13a3 3 0 0 1 2 5.24' ) + '<path class="r" d="M11 20v2M7 19v2"/>',
          WX_CLOUD + '<path class="r" d="M16 14v6M8 14v6M12 16v6"/>' ],
        [ '<path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path class="s" d="m13 12-3 5h4l-3 5"/>' ]
    ];
    var wxMask = 0;
    function wxSvg( k, day )
    {
        var i = WX_ICONS[ k ] || WX_ICONS[ 2 ], id = 'wxm' + ( ++wxMask );
        return '<svg class="wx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
               ( day || i.length < 2 ? i[ 0 ] : i[ 1 ] ).replace( 'id="M"', 'id="' + id + '"' ).replace( 'url(#M)', 'url(#' + id + ')' ) + '</svg>';
    }

    // Day or night at place-local time `iso` ("YYYY-MM-DDTHH:MM"): Open-Meteo says
    // so for now (is_day); else that day's sunrise and sunset; day when unknown.
    function wxDay( w, iso, isDay )
    {
        if( isDay != null ) return !! isDay;
        var i = w.daily.time.indexOf( iso.slice( 0, 10 ) ), up = w.daily.sunrise[ i ], down = w.daily.sunset[ i ];
        return i < 0 || ! up || ! down || ( iso >= up && iso < down );
    }

    function wxEngine()
    {
        return h.weatherEngine();
    }

    // The locker's settings, the place, the weather. `fresh`: a new call (the
    // 30-min turn, a press); else the cache while under 30 min old (a reload).
    // The place keeps its own long cache (no new name lookup each time).
    function wxGet( fresh )
    {
        return wxEngine().then( function ( S )
        {
            var E = S.engine;
            wxCached = wxCached || E.store( 'nv-culture:' );
            var get = fresh ? function ( k, ttl, fn ) { return wxCached( k, 0, fn ); } : wxCached;
            return S.read().then( function ( cfg )
            {
                return E.placeOf( cfg, wxCached ).then( function ( p )
                {
                    return E.weatherAt( get, p, cfg.units, cfg.weather ).then( function ( w ) { return { S: S, cfg: cfg, p: p, w: w }; } );
                } );
            } );
        } );
    }

    function wxT( S )                         // the engine's words, in the interface language
    {
        var l = window.Ayni ? String( Ayni.i18n.lang() ).slice( 0, 2 ) : '';
        return S.engine.T[ l ] || S.engine.T.en;
    }

    function wxPaint( d )                     // the bar's icon: the sky now
    {
        var E = d.S.engine, c = d.w.current;
        wxBtn.innerHTML = wxSvg( E.skyOf( c.weather_code ), wxDay( d.w, c.time, c.is_day ) );
        setTip( wxBtn, t( 'ayni.desktop.weather' ) + ': ' + E.deg( c.temperature_2m ) + ', ' + wxT( d.S ).sky[ E.skyOf( c.weather_code ) ] );
    }

    function wxTick( fresh )
    {
        clearTimeout( wxTimer );
        wxTimer = setTimeout( function () { wxTick( true ); }, WX_EVERY );
        var g = ++wxGen;
        wxGet( fresh ).then( function ( d ) { if( g === wxGen ) wxPaint( d ); }, function () {} );
    }

    function wxEl( tag, cls, text, parent )
    {
        var e = document.createElement( tag );
        if( cls ) e.className = cls;
        if( text != null ) e.textContent = text;
        if( parent ) parent.appendChild( e );
        return e;
    }

    // The popup: the place first, a sliding bar until the forecast comes, then
    // the next 5 times 3 hours apart from the coming hour: "hh:mm", the sky, the temperature.
    function wxOpen()
    {
        var g = ++wxPopGen;
        wxPop.innerHTML = '';
        var head = wxEl( 'div', 'wx-head', t( 'ayni.desktop.weather' ), wxPop );
        var busy = wxEl( 'span', 'wx-busy', null, wxPop );
        busy.setAttribute( 'role', 'progressbar' );
        wxEl( 'span', null, null, busy );
        Ayni.place( wxPop, wxBtn );
        wxGet( true ).then( function ( d )
        {
            if( set.weatherBar ) wxPaint( d );
            if( g !== wxPopGen ) return;
            var E = d.S.engine, T = wxT( d.S ), w = d.w, hr = w.hourly, now = w.current.time;
            head.textContent = ( d.p.name ? T.weather.replace( '{c}', d.p.name ) : T.here ) + ' · ' + d.S.WEATHER[ d.cfg.weather ].name;
            var cols = wxEl( 'div', 'wx-cols' ), i = 0;
            while( i < hr.time.length && hr.time[ i ] <= now ) i++;
            for( ; i < hr.time.length && cols.childNodes.length < 5; i += 3 )
            {
                var k = E.skyOf( hr.weather_code[ i ] ), col = wxEl( 'div', 'wx-col', null, cols );
                col.title = T.sky[ k ];
                wxEl( 'span', '', hr.time[ i ].slice( 11, 16 ), col );
                col.insertAdjacentHTML( 'beforeend', wxSvg( k, wxDay( w, hr.time[ i ] ) ) );
                wxEl( 'b', '', E.deg( hr.temperature_2m[ i ] ), col );
            }
            if( ! cols.childNodes.length ) throw new Error( 'no hours' );
            wxPop.replaceChild( cols, busy );
            Ayni.place( wxPop, wxBtn );
        } ).catch( function ()
        {
            if( g !== wxPopGen || ! busy.parentNode ) return;
            wxPop.replaceChild( wxEl( 'div', 'wx-fail', t( 'ayni.loadFailed' ) ), busy );
            Ayni.place( wxPop, wxBtn );
        } );
    }

    function wxApply()
    {
        wxChk.checked = !! set.weatherBar;
        wxBtn.hidden = ! set.weatherBar;
        if( set.weatherBar )
        {
            if( ! wxBtn.firstChild ) wxBtn.innerHTML = wxSvg( 2, true );     // a cloud until the first answer
            wxTick( false );
            return;
        }
        clearTimeout( wxTimer );
        wxGen++; wxPopGen++;
        if( wxPop.matches( ':popover-open' ) ) wxPop.hidePopover();
    }
    wxChk.addEventListener( 'change', function () { set.weatherBar = wxChk.checked; saveSet(); wxApply(); placeMore(); } );
    wxApply();

    wxPop.addEventListener( 'toggle', function ( e ) { if( e.newState === 'open' ) wxOpen(); else wxPopGen++; } );

    //------------------------------------------------------------------------//
    // BATTERY - this device's choice (set.battBar, the first row of the "⋮"
    // menu): the level on the bar, an icon and "80%". Only where the browser
    // tells it (navigator.getBattery: Chrome, Edge; not Firefox or Safari) and
    // there is a battery; else the switch is greyed and the bar shows nothing.
    // A PC without one reports "charging, full, no time left" - and so does a
    // full laptop on its charger: greyed too, until it is unplugged. The
    // low-battery dialog is shared/ui.js's (every page, this switch or not).

    var battEl = document.getElementById( 'batt' ), battChk = document.getElementById( 'battBarChk' ),
        battRow = document.getElementById( 'battRow' ), batt = null;

    function battNone( b )
    {
        return ! b || ( b.charging && b.level >= 1 && b.chargingTime === 0 && b.dischargingTime === Infinity );
    }

    function battApply()
    {
        var none = battNone( batt );
        battChk.checked  = !! set.battBar;
        battChk.disabled = none;
        battRow.toggleAttribute( 'disabled', none );
        battEl.hidden = none || ! set.battBar;
        if( battEl.hidden ) return;
        var n = Math.round( batt.level * 100 );
        battEl.classList.toggle( 'low', ! batt.charging && batt.level <= 0.15 );
        battEl.classList.toggle( 'chg', batt.charging );
        battEl.querySelector( '.batt-fill' ).setAttribute( 'width', Math.max( 1, 14 * batt.level ).toFixed( 1 ) );
        battEl.querySelector( 'b' ).textContent = n + '%';
        battEl.title = t( 'ayni.desktop.battery' ) + ': ' + n + '%' + ( batt.charging ? ' · ' + t( 'ayni.desktop.battCharging' ) : '' );
        battEl.setAttribute( 'aria-label', battEl.title );
    }
    battChk.addEventListener( 'change', function () { set.battBar = battChk.checked; saveSet(); battApply(); placeMore(); } );
    battApply();
    if( window.Ayni ) Ayni.i18n.ready.then( battApply );     // the tooltip's words
    if( navigator.getBattery ) navigator.getBattery().then( function ( b )
    {
        batt = b;
        [ 'chargingchange', 'levelchange', 'chargingtimechange', 'dischargingtimechange' ].forEach( function ( ev ) { b.addEventListener( ev, battApply ); } );
        battApply();
    }, function () {} );

    // A window by its place on the bar (0, 1...), its app's folder ("drive"), or itself.
    function winOf( which )
    {
        if( typeof which === 'number' ) return wins[ which ] || null;
        if( typeof which === 'string' ) return wins.filter( function ( w ) { return w.app === which; } )[ 0 ] || null;
        return wins.indexOf( which ) >= 0 ? which : null;
    }

    //------------------------------------------------------------------------//
    // SWITCHER - Alt pressed and let go on its own (no other key, no press in
    // between) shows every window, the last used first, as Alt-Tab does on a
    // PC: Left / Right choose, Enter or a click switches, Escape (or Alt again,
    // or a press elsewhere) closes. Keys typed in a window never reach this
    // page, so each window's frame and the menu's are hooked too (hookAlt).
    // Only "Alt": AltGr (the right Alt of a Spanish keyboard: @ # [ ]) is typing.

    var switcher = document.getElementById( 'switcher' );
    var altAlone = false, swSel = 0, swBack = null;

    function hookAlt( cw )
    {
        cw.addEventListener( 'keydown', function ( e )
        {
            if( e.key !== 'Alt' ) altAlone = false;
            else if( ! e.repeat ) altAlone = ! ( e.ctrlKey || e.shiftKey || e.metaKey );   // Ctrl / Shift already held: not alone (Shift+Alt = layout switch)
        }, true );
        cw.addEventListener( 'keyup', function ( e )
        {
            if( e.key !== 'Alt' || ! altAlone ) return;
            altAlone = false;
            e.preventDefault();          // Firefox shows its menu bar on a lone Alt
            if( switcher.hidden ) openSwitcher(); else closeSwitcher( true );
        }, true );
        cw.addEventListener( 'pointerdown', function ( e )
        {
            altAlone = false;
            if( ! switcher.hidden && ! ( cw === window && switcher.contains( e.target ) ) ) closeSwitcher( false );
        }, true );
        cw.addEventListener( 'blur', function () { altAlone = false; } );   // the system's own Alt-Tab
    }

    // Shown windows by how recently they were in front (z-order), then the minimised ones.
    function swList()
    {
        return wins.slice().sort( function ( a, b )
        {
            return ( a.el.hidden - b.el.hidden ) || ( +b.el.style.zIndex - +a.el.style.zIndex );
        } );
    }

    function openSwitcher()
    {
        if( ! wins.length || menu.classList.contains( 'full' ) || document.querySelector( 'dialog.panel[open]' ) ) return;
        h.closeMenu();
        var list = swList();
        switcher.innerHTML = '';
        list.forEach( function ( w )
        {
            var b = document.createElement( 'button' );
            b.type = 'button';
            b.className = 'btn large bordered sw-item' + ( w.el.hidden ? ' min' : '' );
            b.setAttribute( 'role', 'option' );
            b.innerHTML = w.svg + '<span></span>';
            b.querySelector( 'span:not(.icon)' ).textContent = w.main.querySelector( 'span:not(.icon)' ).textContent;
            setTip( b, w.main.dataset.tip );
            b.swWin = w;
            switcher.appendChild( b );
        } );
        swBack = document.activeElement;     // a window's frame, most of the time
        switcher.hidden = false;
        // The window in front is first: Enter alone goes back to the one before it.
        swSelect( list.length > 1 && list[ 0 ] === front ? 1 : 0 );
    }

    function swSelect( i )
    {
        var items = switcher.children, n = items.length;
        swSel = ( i + n ) % n;
        [].forEach.call( items, function ( b, k )
        {
            b.classList.toggle( 'sel', k === swSel );
            b.setAttribute( 'aria-selected', k === swSel ? 'true' : 'false' );
        } );
        items[ swSel ].focus();       // the keys come here now, not to the window
    }

    // restore: give the keyboard back to where it was (Escape, Alt), not after a press elsewhere.
    function closeSwitcher( restore )
    {
        if( switcher.hidden ) return;
        switcher.hidden = true;
        switcher.innerHTML = '';
        if( restore && swBack && swBack !== document.body )
        {
            var w = wins.filter( function ( x ) { return x.frame === swBack; } )[ 0 ];
            if( w ) giveKeys( w );
            else try { swBack.focus(); } catch( e ) {}
        }
        swBack = null;
    }

    // The keyboard goes into the window, back to the field it was in: typing goes on there.
    function giveKeys( w )
    {
        try
        {
            w.frame.focus();
            w.frame.contentWindow.focus();
            var el = w.lastFocus;
            if( el && el.isConnected && el.ownerDocument === w.frame.contentDocument && el !== el.ownerDocument.body )
                el.focus( { preventScroll: true } );
        }
        catch( e ) {}
    }

    function swPick( w )
    {
        closeSwitcher( false );
        if( wins.indexOf( w ) < 0 ) return;
        focus( w );
        giveKeys( w );
    }

    switcher.addEventListener( 'keydown', function ( e )
    {
        var k = e.key;
        if( k === 'ArrowLeft' || k === 'ArrowRight' ) swSelect( swSel + ( k === 'ArrowLeft' ? -1 : 1 ) );
        else if( k === 'Tab' )                        swSelect( swSel + ( e.shiftKey ? -1 : 1 ) );
        else if( k === 'Enter' || k === ' ' )         swPick( switcher.children[ swSel ].swWin );
        else if( k === 'Escape' )                     closeSwitcher( true );
        else return;
        e.preventDefault();
        e.stopPropagation();
    } );
    switcher.addEventListener( 'click', function ( e )
    {
        var b = e.target.closest( '.sw-item' );
        if( b ) swPick( b.swWin );
    } );

    hookAlt( window );

    //------------------------------------------------------------------------//
    // THE CLOCK - "<weekday> <yyyy-mm-dd> <hh:mm[:ss]>", weekday and date as the
    // settings say, the weekday in the interface language. A press on the time
    // opens the countdown (below), on the weekday / date the month (THE MONTH).

    var clock = document.getElementById( 'clock' ), clockTimer = 0;
    var pad = Ayni.dates.pad, isoDate = Ayni.dates.iso;
    function dayName( d, style )
    {
        var iso = d.getDay() || 7;
        return window.Ayni ? Ayni.i18n.weekday( iso, style ) : d.toLocaleDateString( undefined, { weekday: style } );
    }
    function tick()
    {
        clearTimeout( clockTimer );
        var now = new Date();
        var head = [];
        if( set.dow !== 'none' ) head.push( dayName( now, set.dow ) );
        if( set.date )           head.push( isoDate( now ) );
        clock.querySelector( 'span:not(.icon)' ).textContent = head.join( ' ' );
        clock.querySelector( 'span:not(.icon)' ).hidden = ! head.length;
        clock.querySelector( 'b' ).textContent =
            pad( now.getHours() ) + ':' + pad( now.getMinutes() ) + ( set.secs ? ':' + pad( now.getSeconds() ) : '' );
        setTip( clock, dayName( now, 'long' ) + ' ' + isoDate( now ) );
        tick2( now );
        clockTimer = setTimeout( tick, set.secs ? 1000 - now.getMilliseconds() + 20
                                                : 60000 - now.getSeconds() * 1000 - now.getMilliseconds() + 50 );
    }

    // THE SECOND CLOCK (2026-10-09) - another time zone (set.tz2On + set.tz2,
    // the "⋮" menu; the zone is kept while off): "<city> <hh:mm>" just before the clock, paler, and "+1" / "-1"
    // when that place is already on another day. Shows only: no press.
    var clock2 = document.getElementById( 'clock2' );
    function zoneCity( z ) { return z.split( '/' ).pop().replace( /_/g, ' ' ); }
    function tick2( now )
    {
        var z = set.tz2On && set.tz2;
        clock2.hidden = ! z;
        if( ! z ) return;
        var p = {};
        try
        {
            new Intl.DateTimeFormat( 'en-GB', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit',
                                                hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } )
                .formatToParts( now ).forEach( function ( x ) { p[ x.type ] = x.value; } );
        }
        catch( e ) { clock2.hidden = true; return; }      // a zone this browser no longer knows
        var there = Date.UTC( +p.year, +p.month - 1, +p.day ),
            here  = Date.UTC( now.getFullYear(), now.getMonth(), now.getDate() ),
            days  = Math.round( ( there - here ) / 86400000 );
        clock2.querySelector( 'span:not(.icon)' ).textContent = zoneCity( z );
        clock2.querySelector( 'b' ).textContent = p.hour + ':' + p.minute;
        clock2.querySelector( 'i' ).textContent = days > 0 ? '+' + days : days < 0 ? String( days ) : '';
        clock2.title = z + ' - ' + p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
    }
    tick();
    // the weekday is written in the interface language: once more when that is in
    if( window.Ayni ) Ayni.i18n.ready.then( tick );

    //------------------------------------------------------------------------//
    // THE MONTH (2026-10-08) - a press on the clock's weekday / date (only when
    // shown) opens a month's calendar beside the bar, like many Linux desktops:
    // Ayni's calendar, view only: a day has no press. It always opens on today's
    // month, and each row starts with its ISO week number.

    var calPop = document.getElementById( 'calPop' ), calView = null, calWasOpen = false;

    function calOpen()
    {
        h.closeMenu();
        calView = calView || Ayni.calendar( document.getElementById( 'calView' ) );
        calView.set( new Date() );
        Ayni.showPopup( calPop, clock );
    }
    // A press on the clock closes an open popup before its click comes: noted first,
    // so a second press on the date closes the month, and does not open it again.
    clock.addEventListener( 'pointerdown', function () { calWasOpen = calPop.matches( ':popover-open' ); }, true );

    //------------------------------------------------------------------------//
    // THE COUNTDOWNS - as many as wanted at once, on this device (localStorage),
    // so they go on after a reload. Each: running = `end` (a wall-clock time,
    // never a counter a sleeping tab would slow down); paused = `left` (ms still
    // to go); `len` its length in seconds. `last` is the length last started, to
    // offer it again for a new one. Each has its own chip on the bar, just before
    // the clock (oldest first) - the time left (not the text) and small Pause /
    // Play and Stop buttons. The clock adds a new one; a chip changes its own.
    // Time's up (`done`): beeps again and again until a press on a chip, a
    // system notice when the desktop is not on screen, and NO dialog - the chip
    // stays on the bar with the text (or 0:00 when there is none) and a small x
    // at its end that takes it away.

    var CD_KEY = KEYS + 'countdowns', CD_OLD = KEYS + 'countdown';   // until 2026-10-12: one countdown
    var cds = cdLoad();
    var cdBox = document.getElementById( 'cds' ), cdTpl = document.getElementById( 'cdTpl' ), cdBack = document.getElementById( 'cdBackdrop' );
    var cdH = document.getElementById( 'cdH' ), cdM = document.getElementById( 'cdM' ), cdS = document.getElementById( 'cdS' );
    var cdText = document.getElementById( 'cdText' ), cdPlay = document.getElementById( 'cdPlay' );
    var cdTitle = document.getElementById( 'cdTitle' ), cdNote = document.getElementById( 'cdNote' );
    var cdTimer = 0, audio = null, ringTimer = 0, cdEdit = 0;      // cdEdit: the id the dialog changes (0 = a new one)

    function cdLoad()
    {
        var v = store( CD_KEY );
        if( ! v )                                           // the old single one, if any
        {
            var o = store( CD_OLD ) || {};
            v = { list: ( o.end || o.left || o.done ) ? [ { id: 1, end: o.end || 0, left: o.left || 0, done: !! o.done, text: o.text || '', len: o.last || 300 } ] : [],
                  last: o.last };
        }
        return { list: Array.isArray( v.list ) ? v.list : [], last: v.last > 0 ? v.last : 300 };
    }
    function cdSave() { store( CD_KEY, cds ); try { localStorage.removeItem( CD_OLD ); } catch( e ) {} }
    function cdById( id ) { return cds.list.filter( function ( c ) { return c.id === id; } )[ 0 ]; }
    function cdMs( c )    { return c.end ? Math.max( 0, c.end - Date.now() ) : c.left; }
    function cdFmt( ms )
    {
        var s = Math.ceil( ms / 1000 ), h = Math.floor( s / 3600 ), m = Math.floor( s / 60 ) % 60;
        s %= 60;
        return ( h ? h + ':' + pad( m ) : m ) + ':' + pad( s );
    }

    // One chip per countdown, in the list's order; chips of ones gone go too.
    function cdPaint()
    {
        if( ! cds.list.some( function ( c ) { return c.done; } ) ) stopRing();   // all started again, stopped or taken away (also in another tab)
        var keep = {};
        cds.list.forEach( function ( c )
        {
            keep[ c.id ] = true;
            var el = cdBox.querySelector( '[data-id="' + c.id + '"]' );
            if( ! el ) { el = cdTpl.content.firstElementChild.cloneNode( true ); el.setAttribute( 'data-id', c.id ); }
            cdBox.appendChild( el );                        // (re)placed in order
            cdPaintChip( el, c );
        } );
        Array.prototype.slice.call( cdBox.children ).forEach( function ( el ) { if( ! keep[ el.getAttribute( 'data-id' ) ] ) el.remove(); } );
    }

    function cdPaintChip( el, c )
    {
        var on = !! ( c.end || c.left ), done = ! on && !! c.done;
        var pp = el.querySelector( '.cd-pp' ), stop = el.querySelector( '.cd-stop' ), x = el.querySelector( '.cd-x' );
        el.classList.toggle( 'paused', on && ! c.end );
        el.classList.toggle( 'done', done );
        el.querySelector( 'b' ).textContent = on ? cdFmt( cdMs( c ) ) : done && ! c.text ? cdFmt( 0 ) : '';
        el.querySelector( '.cd-text' ).textContent = done ? c.text : '';   // the text only once time is up
        setTip( el.querySelector( '.cd-main' ), done ? t( 'ayni.desktop.cdDone' ) : t( 'ayni.desktop.countdown' ) + ( c.text ? ' - ' + c.text : '' ) );
        pp.hidden = stop.hidden = ! on;
        x.hidden = ! done;
        var icon = c.end ? 'pause' : 'play';
        if( pp.getAttribute( 'data-icon' ) !== icon )
        {
            pp.innerHTML = Ayni.icon( icon );
            pp.setAttribute( 'data-icon', icon );
        }
        if( ! stop.firstChild ) stop.innerHTML = Ayni.icon( 'stop' );
        tip( pp, c.end ? 'ayni.desktop.cdPause' : 'ayni.desktop.cdContinue' );
        tip( stop, 'ayni.desktop.cdStop' );
        tip( x, 'ayni.close' );
    }

    function tip( el, key ) { setTip( el, t( key ) ); el.setAttribute( 'aria-label', el.dataset.tip ); }

    // Ends the ones whose time is up, repaints, and comes back at the next
    // second change of the soonest running one.
    function cdTick()
    {
        clearTimeout( cdTimer );
        var now = Date.now(), ended = cds.list.filter( function ( c ) { return c.end && c.end <= now; } );
        if( ended.length ) cdDone( ended );
        cdPaint();
        var next = 0;
        cds.list.forEach( function ( c )
        {
            if( ! c.end ) return;
            var ms = ( c.end - now ) % 1000 + 20;
            if( ! next || ms < next ) next = ms;
        } );
        if( next ) cdTimer = setTimeout( cdTick, next );
    }

    // The AudioContext is made on a press (Start), or a browser keeps it silent.
    function wakeAudio()
    {
        var AC = window.AudioContext || window.webkitAudioContext;
        try { if( ! audio && AC ) audio = new AC(); if( audio && audio.state !== 'running' ) audio.resume(); } catch( e ) {}
    }
    // Only a context a press already woke: one made now (no press) would hold
    // the beeps and play them at the next Start.
    function beep()
    {
        if( ! audio || audio.state !== 'running' ) return;
        try
        {
            for( var i = 0; i < 6; i++ )           // 3 pairs of short beeps
            {
                var at = audio.currentTime + 0.05 + Math.floor( i / 2 ) * 0.8 + ( i % 2 ) * 0.22;
                var o = audio.createOscillator(), g = audio.createGain();
                o.frequency.value = 880;
                g.gain.setValueAtTime( 0.0001, at );
                g.gain.exponentialRampToValueAtTime( 0.25, at + 0.01 );
                g.gain.exponentialRampToValueAtTime( 0.0001, at + 0.16 );
                o.connect( g ); g.connect( audio.destination );
                o.start( at ); o.stop( at + 0.18 );
            }
        } catch( e ) {}
    }

    // Time's up rings until the user stops it (his call, 2026-10-11): the 3
    // pairs again every 2.5 s, until a press on the chip.
    function ring()     { stopRing(); beep(); ringTimer = setInterval( beep, 2500 ); }
    function stopRing() { clearInterval( ringTimer ); ringTimer = 0; }

    function cdDone( ended )
    {
        ended.forEach( function ( c )
        {
            c.end = c.left = 0;
            c.done = true;
            try
            {
                if( document.hidden && window.Notification && Notification.permission === 'granted' )
                    new Notification( t( 'ayni.desktop.cdDone' ), { body: c.text, icon: '../icons/icon-192.png' } );
            } catch( e ) {}
        } );
        cdSave();
        ring();
    }

    // `by`: what was pressed (the clock or a chip); the dialog sits beside it,
    // on the desk side of the bar, as the month does. `c`: the countdown to
    // change (its chip), or none for a new one (the clock).
    var cdBy = clock;
    function cdOpen( by, c )
    {
        h.closeMenu();
        cdEdit = c ? c.id : 0;
        var s = c && c.len > 0 ? c.len : cds.last;
        cdH.value = Math.floor( s / 3600 ); cdM.value = Math.floor( s / 60 ) % 60; cdS.value = s % 60;
        cdText.value = c ? c.text : '';
        cdTitle.textContent = t( c ? 'ayni.desktop.cdChange' : 'ayni.desktop.cdNew' );
        cdNote.hidden = !! c;
        cdBack.showModal();
        cdBy = by || clock;
        Ayni.place( cdBack, cdBy );
    }
    window.addEventListener( 'resize', function ()
    {
        if( cdBack.open ) Ayni.place( cdBack, cdBy.isConnected ? cdBy : clock );
    } );

    function num( el, max ) { var n = Math.floor( +el.value ); return n > 0 ? Math.min( n, max ) : 0; }

    // Play: restarts the one being changed (if still there), else adds a new one.
    function cdStart()
    {
        var secs = num( cdH, 99 ) * 3600 + num( cdM, 59 ) * 60 + num( cdS, 59 );
        if( ! secs ) { cdH.focus(); return; }
        wakeAudio();
        var c = cdEdit && cdById( cdEdit );
        if( ! c )
        {
            c = { id: cds.list.reduce( function ( n, x ) { return Math.max( n, x.id ); }, 0 ) + 1 };
            cds.list.push( c );
        }
        Object.assign( c, { end: Date.now() + secs * 1000, left: 0, done: false, text: cdText.value.trim(), len: secs } );
        cds.last = secs;
        cdSave();
        cdBack.close();
        cdTick();
    }

    // The clock: its weekday / date opens the month (a second press closes it), the rest a new countdown.
    clock.addEventListener( 'click', function ( e )
    {
        var head = clock.querySelector( 'span:not(.icon)' );
        if( ! head.hidden && head.contains( e.target ) ) { if( ! calWasOpen ) calOpen(); return; }
        cdOpen( clock );
    } );
    cdPlay.addEventListener( 'click', cdStart );
    [ cdH, cdM, cdS, cdText ].forEach( function ( el )
    {
        el.addEventListener( 'keydown', function ( e ) { if( e.key === 'Enter' ) { e.preventDefault(); cdStart(); } } );
    } );
    // A chip: Pause / Play, Stop (at once, no "are you sure") and, time's up,
    // the x that takes it away; anywhere else opens the dialog to change it.
    cdBox.addEventListener( 'click', function ( e )
    {
        var chip = e.target.closest( '.cd-chip' ), c = chip && cdById( +chip.getAttribute( 'data-id' ) );
        if( ! c ) return;
        var b = e.target.closest( '[data-cd]' ), what = b && b.getAttribute( 'data-cd' );
        stopRing();                                         // any press on a chip silences it
        if( ! what ) { cdOpen( chip, c ); return; }
        if( what === 'pp' )
        {
            if( c.end ) { c.left = Math.max( 1000, c.end - Date.now() ); c.end = 0; }
            else        { wakeAudio(); c.end = Date.now() + c.left; c.left = 0; }
        }
        else                                                // stop / x
        {
            var at = cds.list.indexOf( c ), was = Object.assign( {}, c );
            cds.list.splice( at, 1 );
            // Undo: back in its place with the same end moment (never one gone by
            // meanwhile), the same time left when paused, or its time's-up chip.
            Ayni.toast( 'ok', t( what === 'stop' ? 'ayni.desktop.cdStopped' : 'ayni.toast.removed' ), { undo: function ()
            {
                if( cdById( was.id ) || ( was.end && was.end <= Date.now() ) ) return;
                if( was.end ) wakeAudio();
                cds.list.splice( Math.min( at, cds.list.length ), 0, was );
                cdSave();
                cdTick();
            } } );
        }
        cdSave();
        cdTick();
    } );
    // Another tab of the desktop started / paused / stopped one: follow.
    window.addEventListener( 'storage', function ( e )
    {
        if( e.key !== CD_KEY ) return;
        cds = cdLoad();
        cdTick();
    } );
    // First look once shared/ui.js (deferred) is in: a countdown that ended while
    // the desktop was closed still says so, on its chip.
    if( document.readyState === 'loading' ) document.addEventListener( 'DOMContentLoaded', cdTick );
    else cdTick();
    if( window.Ayni ) Ayni.i18n.ready.then( cdPaint );

    //------------------------------------------------------------------------//
    // KEYBOARD (2026-10-01) - while the on-screen keyboard is up, the window in
    // front gets shorter, down to the keyboard's top edge, so the field typed
    // into stays in sight; when it goes, the window gets its size back. Seen
    // through visualViewport: the keyboard is up while the visible height is
    // 120px or more below the tallest seen at this width. A browser that
    // shrinks the whole page for it instead (the Android app may) shrinks the
    // desk too: the edge is the lower of the two. Only the window's style
    // changes - w.g, what is saved and restored, keeps its real size.

    var vv = window.visualViewport, kbWin = null, kbBase = 0, kbW = 0, kbEdge = 0;
    var KB_MIN = 120, KB_KEEP = 240;    // a keyboard is at least this tall; the window keeps at least this much

    function kbFit()
    {
        if( ! vv ) return;
        if( window.innerWidth !== kbW ) { kbW = window.innerWidth; kbBase = 0; }   // turned: a new tallest
        kbBase = Math.max( kbBase, vv.height );
        var dr = desk.getBoundingClientRect();
        kbEdge = Math.min( dr.bottom, vv.offsetTop + vv.height ) - dr.top;         // in desk pixels
        var w = kbBase - vv.height >= KB_MIN && front && ! front.el.hidden && wins.indexOf( front ) >= 0 ? front : null;
        if( kbWin && kbWin !== w ) kbRelease();
        if( ! w ) return;
        kbWin = w;
        kbShrink( w );
        // the field typed into: back in sight inside the shorter window
        try
        {
            var el = w.frame.contentDocument.activeElement;
            if( el && el !== w.frame.contentDocument.body && el.scrollIntoView ) el.scrollIntoView( { block: 'nearest' } );
        }
        catch( e ) {}
    }

    // Style only (place() calls it again while the keyboard is up).
    function kbShrink( w )
    {
        var st = w.el.style;
        if( isMax( w ) )
        {
            w.el.classList.add( 'kb' );
            st.setProperty( '--kb-h', Math.max( 1, kbEdge ) + 'px' );
            return;
        }
        st.removeProperty( '--kb-h' );
        if( w.g.t + w.g.h <= kbEdge )                              // clear of it: its own size
        {
            if( w.el.classList.contains( 'kb' ) ) { w.el.classList.remove( 'kb' ); kbWin = null; place( w, w.g ); kbWin = w; }
            return;
        }
        var top = Math.max( 0, Math.min( w.g.t, kbEdge - KB_KEEP ) );
        w.el.classList.add( 'kb' );
        st.top    = px( top );
        st.height = px( Math.max( 1, kbEdge - top ) / w.s );     // laid-out pixels: a shrunk window is drawn w.s smaller
    }

    function kbRelease()
    {
        var w = kbWin;
        kbWin = null;
        if( ! w || wins.indexOf( w ) < 0 ) return;
        w.el.classList.remove( 'kb' );
        w.el.style.removeProperty( '--kb-h' );
        place( w, w.g );
    }

    if( vv )
    {
        vv.addEventListener( 'resize', kbFit );
        vv.addEventListener( 'scroll', kbFit );
    }

    // SCALE and TILE for the buttons to come (the desktop has none for them yet).
    Object.assign( window.AyniDesk = window.AyniDesk || {}, {
        windows: function ()
        {
            return wins.map( function ( w )
            {
                return { app: w.app, name: w.main.querySelector( 'span:not(.icon)' ).textContent, scale: !! w.scale, factor: w.s,
                         max: isMax( w ), min: !! w.el.hidden, box: { l: w.g.l, t: w.g.t, w: w.g.w, h: w.g.h },
                         nat: w.nat, tiled: !! tiled && tiled.snaps.has( w ) };
            } );
        },
        open:       function ( url ) { return !! openApp( url, { fresh: true } ); },
        scale:      function ( which, on ) { var w = winOf( which ); if( w ) setScale( w, on === undefined ? ! w.scale : on ); return !! w; },
        tile:       tile,
        untile:     untile,
        toggleTile: function () { return tiled ? untile() : tile(); },
        isTiled:    function () { return !! tiled; }
    } );

    // narrow = null: looked at afresh, so a desk tiled upright and reloaded wide goes back to Free
    h.appsReady.then( function () { restoreWins(); narrow = null; upright(); } );

        return { ICON_SCALE: ICON_SCALE, ICON_TILE: ICON_TILE, ICON_WIN: ICON_WIN, ROOT: ROOT, bar: bar, battEl: battEl, clock: clock, closeMore: closeMore, desk: desk, desktop: desktop, focus: focus, ghost: ghost, hookAlt: hookAlt, menu: menu, menuBtn: menuBtn, moreBtn: moreBtn, moreMenu: moreMenu, narrow: narrow, openApp: openApp, placeMore: placeMore, set: set, setTip: setTip, t: t, tasks: tasks, tile: tile, wins: wins, wxSvg: wxSvg };
    };
} )();
