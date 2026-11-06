/*
 * image-editor.js - the photo editor of Image and of Chat's "Editar foto",
 * drawn by Fabric.js (shared/lib/fabric_*.min.js) under OUR bars.
 *
 * shared/photo.js loads Fabric and this file on the first edit
 * (AyniPhoto.loadEditor) and builds one (AyniPhoto.newEditor), which is
 *
 *     AyniImageEditor.create( host, url, name, opts )
 *         opts.tools:    where the tools go (the app's header); else a bar over the picture
 *         opts.head:     where undo / redo go (the app's header); else that bar
 *         opts.btnClass: their class there ("btn" by default, Chat: "btn on-media")
 *
 * and answers what the apps ask of an editor:
 *
 *     ed.on( "undoStackChanged", fn( n ) )   n = the steps undo can go back
 *     ed.toDataURL( { format, quality } )    the edited picture, full size
 *     ed.getCanvasSize()                     its { width, height }
 *     ed.destroy()
 *
 * The edit is a RECIPE, never pixels: the turn (a 2x2 matrix of 0 / ±1), the
 * crop (a rectangle of the original, in its own pixels), three adjustments
 * and the size (a factor on the cropped picture, aspect kept). The screen shows the recipe live (Fabric draws the turned,
 * cropped picture; a CSS filter on its canvas shows the adjustments), and
 * toDataURL() renders it ONCE, from the original, at full size. Undo / redo
 * step through recipes, so nothing is ever re-encoded twice.
 *
 * The view: zoom works on the whole picture (+ / -, Ctrl + wheel, two
 * fingers), Fit and 1:1, and the picture moves with the scroll bars or by
 * dragging it while the hand is on (it is on, except while cropping).
 *
 * The tools (in the app's header, or a bar over the picture; a tool's
 * options show in a strip under them, over the picture):
 * Crop (free, original, 1:1, 4:3, 16:9), Rotate (90° left / right, flip
 * horizontal / vertical), Adjust (brightness, contrast, saturation), Resize
 * (width, height or %, tied; the screen shows the picture as before, only the
 * saved one changes size) and Back to the original.
 */
( function ()
{
    "use strict";

    function T( k ) { return window.Ayni ? Ayni.t( k ) : k; }

    var PAD  = 16;           // px around the picture when it is fitted
    var STEP = 1.25;         // one press of + / -
    var MAXZ = 8;            // 800 %
    var MAXK = 4;            // Resize: up to 400 %

    // The 24px stroke icons this editor needs beyond Ayni.icon()'s.
    var ICON =
    {
        redo:   '<path d="M21 7v6h-6"></path><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"></path>',
        crop:   '<path d="M6.13 1 6 16a2 2 0 0 0 2 2h15"></path><path d="M1 6.13 16 6a2 2 0 0 1 2 2v15"></path>',
        rotate: '<polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>',
        rotL:   '<polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>',
        rotR:   '<polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>',
        flipH:  '<path d="m3 7 5 5-5 5V7"></path><path d="m21 7-5 5 5 5V7"></path><path d="M12 20v2"></path><path d="M12 14v2"></path><path d="M12 8v2"></path><path d="M12 2v2"></path>',
        flipV:  '<path d="m17 3-5 5-5-5h10"></path><path d="m17 21-5-5-5 5h10"></path><path d="M4 12H2"></path><path d="M10 12H8"></path><path d="M16 12h-2"></path><path d="M22 12h-2"></path>',
        resize: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M14 15H9v-5"></path><path d="M16 3h5v5"></path><path d="M21 3 9 15"></path>',
        adjust: '<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>',
        reset:  '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path>',
        hand:   '<path d="M18 11V6a2 2 0 0 0-4 0"></path><path d="M14 10V4a2 2 0 0 0-4 0v2"></path><path d="M10 10.5V6a2 2 0 0 0-4 0v8"></path><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"></path>',
        zoomIn: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line>',
        zoomOut:'<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line>',
        fit:    '<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M21 16v3a2 2 0 0 1-2 2h-3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><rect x="8" y="8" width="8" height="8" rx="1"></rect>'
    };

    function svg( name )
    {
        if( ! ICON[ name ] ) return Ayni.icon( name );
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
               'stroke-linejoin="round" aria-hidden="true">' + ICON[ name ] + '</svg>';
    }

    function el( tag, cls, parent )
    {
        var e = document.createElement( tag );
        if( cls ) e.className = cls;
        if( parent ) parent.appendChild( e );
        return e;
    }

    // An icon button: `act` is its data-ie (what tests and the tour find).
    function button( cls, icon, key, act, parent )
    {
        var b = el( "button", cls, parent );
        b.type = "button";
        b.innerHTML = icon.charAt( 0 ) === "<" ? icon : svg( icon );
        Ayni.setTip( b, T( key ) );
        b.setAttribute( "aria-label", T( key ) );
        b.dataset.ie = act;
        return b;
    }

    function clamp( v, lo, hi ) { return v < lo ? lo : v > hi ? hi : v; }

    //------------------------------------------------------------------------//
    // THE TURN - a 2x2 matrix [ a, b, c, d ]: x' = a x + b y, y' = c x + d y,
    // y down. Only quarter turns and mirrors, so every entry is 0 or ±1.

    var ROT_R  = [ 0, -1, 1, 0 ];      // a quarter turn clockwise, on screen
    var ROT_L  = [ 0, 1, -1, 0 ];
    var FLIP_H = [ -1, 0, 0, 1 ];
    var FLIP_V = [ 1, 0, 0, -1 ];

    function mul( p, q ) { return [ p[ 0 ] * q[ 0 ] + p[ 1 ] * q[ 2 ], p[ 0 ] * q[ 1 ] + p[ 1 ] * q[ 3 ],
                                    p[ 2 ] * q[ 0 ] + p[ 3 ] * q[ 2 ], p[ 2 ] * q[ 1 ] + p[ 3 ] * q[ 3 ] ]; }
    function inv( m ) { return [ m[ 0 ], m[ 2 ], m[ 1 ], m[ 3 ] ]; }   // orthogonal: the transpose
    function apply( m, x, y ) { return { x: m[ 0 ] * x + m[ 1 ] * y, y: m[ 2 ] * x + m[ 3 ] * y }; }

    // A w x h rectangle, turned.
    function turned( m, w, h ) { return { w: Math.abs( m[ 0 ] ) * w + Math.abs( m[ 1 ] ) * h,
                                          h: Math.abs( m[ 2 ] ) * w + Math.abs( m[ 3 ] ) * h }; }

    // The turn as Fabric draws it: rotate( angle ) * scale( flipX ? -1 : 1, 1 ).
    function fabricTurn( m )
    {
        var flip = m[ 0 ] * m[ 3 ] - m[ 1 ] * m[ 2 ] < 0;
        var r = flip ? [ -m[ 0 ], m[ 1 ], -m[ 2 ], m[ 3 ] ] : m;
        return { angle: Math.round( Math.atan2( r[ 2 ], r[ 0 ] ) * 180 / Math.PI ), flipX: flip, flipY: false };
    }

    //------------------------------------------------------------------------//
    // THE ADJUSTMENTS - each -100..100, shown as CSS filters and rendered by
    // adjustPixels() with the same formulas (Filter Effects spec, sRGB):
    // brightness( k ), contrast( k ), saturate( k ), k = 1 + v / 100.

    var ADJ = [ "b", "c", "s" ];
    var ADJ_KEY = { b: "imgEd.brightness", c: "imgEd.contrast", s: "imgEd.saturation" };

    function cssFilter( a )
    {
        if( ! a.b && ! a.c && ! a.s ) return "";
        return "brightness(" + ( 1 + a.b / 100 ) + ") contrast(" + ( 1 + a.c / 100 ) + ") saturate(" + ( 1 + a.s / 100 ) + ")";
    }

    function adjustPixels( d, a )
    {
        var kb = 1 + a.b / 100, kc = 1 + a.c / 100, ks = 1 + a.s / 100;
        var r0 = 0.213 + 0.787 * ks, r1 = 0.715 - 0.715 * ks, r2 = 0.072 - 0.072 * ks;
        var g0 = 0.213 - 0.213 * ks, g1 = 0.715 + 0.285 * ks, g2 = 0.072 - 0.072 * ks;
        var b0 = 0.213 - 0.213 * ks, b1 = 0.715 - 0.715 * ks, b2 = 0.072 + 0.928 * ks;
        for( var i = 0; i < d.length; i += 4 )
        {
            var r = d[ i ], g = d[ i + 1 ], b = d[ i + 2 ];
            if( a.b )
            {
                r = Math.min( 255, r * kb ); g = Math.min( 255, g * kb ); b = Math.min( 255, b * kb );
            }
            if( a.c )
            {
                r = clamp( ( r - 127.5 ) * kc + 127.5, 0, 255 );
                g = clamp( ( g - 127.5 ) * kc + 127.5, 0, 255 );
                b = clamp( ( b - 127.5 ) * kc + 127.5, 0, 255 );
            }
            if( a.s )
            {
                var nr = r0 * r + r1 * g + r2 * b, ng = g0 * r + g1 * g + g2 * b, nb = b0 * r + b1 * g + b2 * b;
                r = nr; g = ng; b = nb;
            }
            d[ i ] = r; d[ i + 1 ] = g; d[ i + 2 ] = b;      // a Uint8ClampedArray rounds and clamps
        }
    }

    //------------------------------------------------------------------------//

    function create( host, url, name, opts )
    {
        opts = opts || {};
        var F = window.fabric;
        var listeners = {};
        var src = null;               // the original <img>, once loaded
        var W = 0, H = 0;             // its size
        var state = null;             // { m, crop: { x, y, w, h }, b, c, s, k }
        var undo = [], redo = [];
        var live = null;              // an adjustment being dragged: { key, v }
        var tool = "";                // the open tool: "", "crop", "rotate", "adjust", "resize"
        var hand = true;              // dragging moves the picture
        var z = 1, fitted = true;     // the zoom; fitted = follow the window
        var sw = 0, sh = 0;           // the scroll area
        var box = null;               // cropping: the box, in scene units
        var ratio = "free";
        var adjKey = "b";
        var dead = false;

        // ---- the DOM ----
        host.innerHTML = "";
        var root  = el( "div", "ie", host );
        // Toolbars at the top, as in every app: the tools (when the app keeps
        // no place for them), then the open tool's options, then the picture.
        var bar     = opts.tools ? null : el( "div", "ie-bar ie-tools", root );
        var optsBar = el( "div", "ie-bar ie-opts", root );
        optsBar.hidden = true;
        var main  = el( "div", "ie-main", root );
        var view  = el( "div", "ie-view is-hand", main );
        var sizer = el( "div", "ie-sizer", view );
        var stage = el( "div", "ie-stage", sizer );
        var cEl   = el( "canvas", "", stage );
        var crop  = el( "div", "crop-box ie-crop", stage );
        [ "nw", "ne", "sw", "se", "n", "s", "e", "w" ].forEach( function ( c )
        {
            var s = el( "span", c, crop );
            s.dataset.c = c;
        } );
        crop.hidden = true;

        var zoomBar = el( "div", "ie-zoom", main );
        var handB   = button( "btn sm", "hand", "imgEd.hand", "hand", zoomBar );
        handB.setAttribute( "aria-pressed", true );
        var outB    = button( "btn sm", "zoomOut", "imgEd.zoomOut", "zoomOut", zoomBar );
        var pct     = el( "span", "ie-zoom-pct", zoomBar );
        var inB     = button( "btn sm", "zoomIn", "imgEd.zoomIn", "zoomIn", zoomBar );
        var fitB    = button( "btn sm", "fit", "imgEd.fit", "fit", zoomBar );
        var oneB    = button( "btn sm ie-one", "<span>1:1</span>", "imgEd.actualSize", "actual", zoomBar );

        // The tools, and undo / redo: each in the app's header, else in groups
        // of the bar over the picture (the shared .tb-group, its line included).
        var tools = opts.tools || el( "div", "tb-group", bar );
        var head  = opts.head  || el( "div", "tb-group", bar );
        function cls( place ) { return place === opts.tools || place === opts.head ? ( opts.btnClass || "btn" ) : "btn"; }
        var cropB   = button( cls( tools ), "crop", "imgEd.crop", "crop", tools );
        var rotB    = button( cls( tools ), "rotate", "imgEd.rotate", "rotate", tools );
        var adjB    = button( cls( tools ), "adjust", "imgEd.adjust", "adjust", tools );
        var sizeB   = button( cls( tools ), "resize", "imgEd.resize", "resize", tools );
        var resetB  = button( cls( tools ), "reset", "imgEd.reset", "reset", tools );
        var undoB = button( cls( head ), "undo", "imgEd.undo", "undo", head );
        var redoB = button( cls( head ), "redo", "imgEd.redo", "redo", head );
        // What destroy() takes back out of the app's header.
        var headBtns = ( opts.tools ? [ cropB, rotB, adjB, sizeB, resetB ] : [] ).concat( opts.head ? [ undoB, redoB ] : [] );

        // ---- Fabric ----
        var cnv = new F.Canvas( cEl, {
            selection: false, skipTargetFind: true, renderOnAddRemove: false,
            enableRetinaScaling: true, allowTouchScrolling: false, preserveObjectStacking: true
        } );
        // A big photo drawn small: the browser's best down-scaling, not its fastest.
        cnv.on( "before:render", function () { cnv.getContext().imageSmoothingQuality = "high"; } );
        var pic = null;               // the Fabric image

        function emit( ev, arg ) { ( listeners[ ev ] || [] ).forEach( function ( fn ) { try { fn( arg ); } catch( e ) {} } ); }

        // ---- the scene ----
        // The part of the original on show: all of it while cropping.
        function region() { return tool === "crop" ? { x: 0, y: 0, w: W, h: H } : state.crop; }
        function content() { var r = region(); return turned( state.m, r.w, r.h ); }

        function fitZoom()
        {
            var c = content();
            var vw = view.clientWidth - 2 * PAD, vh = view.clientHeight - 2 * PAD;
            if( vw <= 0 || vh <= 0 || ! c.w || ! c.h ) return 1;
            return Math.min( 1, vw / c.w, vh / c.h );
        }
        function minZoom() { return Math.min( 1, fitZoom() ) / 2; }
        function maxZoom() { return Math.max( MAXZ, fitZoom() ); }

        // Where the scene's (0, 0) - the middle of the picture - is, in the view.
        function origin() { return { x: sw / 2 - view.scrollLeft, y: sh / 2 - view.scrollTop }; }

        function sizeArea()
        {
            var c = content();
            sw = Math.max( view.clientWidth,  Math.ceil( c.w * z + 2 * PAD ) );
            sh = Math.max( view.clientHeight, Math.ceil( c.h * z + 2 * PAD ) );
            sizer.style.width  = sw + "px";
            sizer.style.height = sh + "px";
        }

        // Sizes, the zoom's place and the drawing, from the state as it is.
        function layout()
        {
            if( dead || ! state ) return;
            var vw = view.clientWidth, vh = view.clientHeight;
            if( ! vw || ! vh ) return;
            if( fitted ) z = fitZoom();
            sizeArea();
            stage.style.width  = vw + "px";
            stage.style.height = vh + "px";
            if( cnv.width !== vw || cnv.height !== vh ) cnv.setDimensions( { width: vw, height: vh } );
            var o = origin();
            cnv.setViewportTransform( [ z, 0, 0, z, o.x, o.y ] );
            cnv.requestRenderAll();
            placeCrop();
            pct.textContent = Math.round( z * 100 ) + " %";
            outB.ariaDisabled = z <= minZoom() + 1e-6;
            inB.ariaDisabled  = z >= maxZoom() - 1e-6;
        }

        // Zoom to `nz`, keeping the scene point `p` under the view point `at`.
        function zoomAt( nz, p, at )
        {
            z = clamp( nz, minZoom(), maxZoom() );
            fitted = false;
            sizeArea();
            view.scrollLeft = z * p.x + sw / 2 - at.x;
            view.scrollTop  = z * p.y + sh / 2 - at.y;
            layout();
        }
        function sceneAt( at ) { var o = origin(); return { x: ( at.x - o.x ) / z, y: ( at.y - o.y ) / z }; }
        function zoomBy( k, at )
        {
            if( ! state ) return;
            at = at || { x: view.clientWidth / 2, y: view.clientHeight / 2 };
            zoomAt( z * k, sceneAt( at ), at );
        }
        function fit() { fitted = true; layout(); }

        // The picture as the state says (and the crop box, while cropping).
        function draw()
        {
            if( ! pic ) return;
            var r = region(), t = fabricTurn( state.m );
            pic.set( { cropX: r.x, cropY: r.y, width: r.w, height: r.h,
                       angle: t.angle, flipX: t.flipX, flipY: t.flipY, left: 0, top: 0 } );
            pic.setCoords();
            cnv.lowerCanvasEl.style.filter = cssFilter( live ? withLive( state ) : state );
            layout();
        }

        function withLive( s )
        {
            var o = { b: s.b, c: s.c, s: s.s };
            o[ live.key ] = live.v;
            return o;
        }

        // ---- undo / redo ----
        function same( p, q )
        {
            return p.m.join() === q.m.join() && p.crop.x === q.crop.x && p.crop.y === q.crop.y &&
                   p.crop.w === q.crop.w && p.crop.h === q.crop.h && p.b === q.b && p.c === q.c && p.s === q.s && p.k === q.k;
        }
        function original() { return { m: [ 1, 0, 0, 1 ], crop: { x: 0, y: 0, w: W, h: H }, b: 0, c: 0, s: 0, k: 1 }; }
        function copyOf( s ) { return { m: s.m.slice(), crop: { x: s.crop.x, y: s.crop.y, w: s.crop.w, h: s.crop.h }, b: s.b, c: s.c, s: s.s, k: s.k }; }

        // The size the recipe gives: turned, cropped, then resized.
        function outSize( s )
        {
            var t = turned( s.m, s.crop.w, s.crop.h );
            return { w: Math.max( 1, Math.round( t.w * s.k ) ), h: Math.max( 1, Math.round( t.h * s.k ) ) };
        }

        function commit( next )
        {
            if( same( next, state ) ) return;
            undo.push( state );
            redo = [];
            state = next;
            changed( undo[ undo.length - 1 ] );
        }
        // A new shape (a turn, a crop) is fitted again; an adjustment keeps the zoom.
        function changed( was )
        {
            if( was.m.join() !== state.m.join() || was.crop.x !== state.crop.x || was.crop.y !== state.crop.y ||
                was.crop.w !== state.crop.w || was.crop.h !== state.crop.h ) fitted = true;
            draw();
            syncButtons();
            if( tool === "adjust" ) syncAdjust();
            if( tool === "resize" ) syncSize();
            emit( "undoStackChanged", undo.length );
        }
        function stepBack()
        {
            if( ! undo.length ) return;
            leaveCrop( false );
            redo.push( state );
            state = undo.pop();
            changed( redo[ redo.length - 1 ] );
        }
        function stepForward()
        {
            if( ! redo.length ) return;
            leaveCrop( false );
            undo.push( state );
            state = redo.pop();
            changed( undo[ undo.length - 1 ] );
        }
        function syncButtons()
        {
            undoB.ariaDisabled  = ! undo.length;
            redoB.ariaDisabled  = ! redo.length;
            resetB.ariaDisabled = ! state || same( state, original() );
        }

        // ---- the tools ----
        function openTool( t )
        {
            var was = tool;
            if( tool === "crop" ) leaveCrop( true );
            tool = was === t ? "" : t;
            [ cropB, rotB, adjB, sizeB ].forEach( function ( b ) { b.setAttribute( "aria-pressed", b.dataset.ie === tool ); } );
            optsBar.replaceChildren();
            optsBar.hidden = ! tool;
            if( tool === "crop" )   enterCrop();
            if( tool === "rotate" ) rotateOpts();
            if( tool === "adjust" ) adjustOpts();
            if( tool === "resize" ) resizeOpts();
            if( tool !== "crop" ) setHand( true );
        }

        function turn( q )
        {
            var s = copyOf( state );
            s.m = mul( q, s.m );
            commit( s );
        }

        function rotateOpts()
        {
            var g = el( "div", "tb-group", optsBar );
            button( "btn", "rotL", "imgEd.rotateLeft", "rotL", g ).onclick  = function () { turn( ROT_L ); };
            button( "btn", "rotR", "imgEd.rotateRight", "rotR", g ).onclick = function () { turn( ROT_R ); };
            g = el( "div", "tb-group", optsBar );
            button( "btn", "flipH", "imgEd.flipH", "flipH", g ).onclick = function () { turn( FLIP_H ); };
            button( "btn", "flipV", "imgEd.flipV", "flipV", g ).onclick = function () { turn( FLIP_V ); };
        }

        // Adjust: one slider at a time, picked by its pill.
        var range = null, val = null;
        function adjustOpts()
        {
            var pills = el( "div", "tb-group ie-pills", optsBar );
            ADJ.forEach( function ( k )
            {
                var p = el( "button", "btn text sm bordered", pills );
                p.type = "button";
                p.textContent = T( ADJ_KEY[ k ] );
                p.dataset.ie = "adj-" + k;
                p.onclick = function () { adjKey = k; syncAdjust(); };
            } );
            var row = el( "div", "ie-range", optsBar );
            range = el( "input", "", row );
            range.type = "range";
            range.min = "-100";
            range.max = "100";
            range.step = "1";
            range.dataset.ie = "range";
            val = el( "span", "ie-val", row );
            range.addEventListener( "input", function ()
            {
                live = { key: adjKey, v: +range.value };
                showVal( live.v );
                cnv.lowerCanvasEl.style.filter = cssFilter( withLive( state ) );
            } );
            range.addEventListener( "change", function ()
            {
                var s = copyOf( state );
                s[ adjKey ] = +range.value;
                live = null;
                commit( s );
            } );
            // A double click puts the slider back to 0.
            range.addEventListener( "dblclick", function ()
            {
                var s = copyOf( state );
                s[ adjKey ] = 0;
                live = null;
                commit( s );
            } );
            syncAdjust();
        }
        function showVal( v ) { val.textContent = v > 0 ? "+" + v : String( v ); }
        function syncAdjust()
        {
            if( ! range ) return;
            optsBar.querySelectorAll( "[data-ie]" ).forEach( function ( p ) { p.setAttribute( "aria-pressed", p.dataset.ie === "adj-" + adjKey ); } );
            range.value = state[ adjKey ];
            range.setAttribute( "aria-label", T( ADJ_KEY[ adjKey ] ) );
            showVal( state[ adjKey ] );
        }

        // ---- resize ----
        // Width × height px and %, tied (the aspect never changes). Typing
        // moves the other two; the size is committed when the box is left or
        // on Enter (one undo step). It is a factor, so a later crop keeps it.
        var sizeIn = null;
        function resizeOpts()
        {
            var row = el( "div", "ie-size", optsBar );
            // Ayni number fields (− field +); a comma is a decimal mark too
            function box( key, act )
            {
                var i = el( "input", "input", el( "span", "input-group spin", row ) );
                i.type = "number";
                i.min = "1";
                i.step = act === "pct" ? "any" : "1";
                i.inputMode = "decimal";
                i.title = T( key );
                i.setAttribute( "aria-label", T( key ) );
                i.dataset.ie = "size-" + act;
                return i;
            }
            var iw = box( "imgEd.width", "w" );
            el( "span", "", row ).textContent = "×";
            var ih = box( "imgEd.height", "h" );
            el( "span", "", row ).textContent = "px";
            var ip = box( "imgEd.percent", "pct" );
            el( "span", "", row ).textContent = "%";
            ip.max = String( MAXK * 100 );
            sizeIn = { w: iw, h: ih, pct: ip };

            // The factor a box asks for, or 0 when it asks for nothing valid.
            function factor( i )
            {
                var v = Number( String( i.value ).trim().replace( ",", "." ) ), t = turned( state.m, state.crop.w, state.crop.h );
                if( ! ( v > 0 ) || ! isFinite( v ) ) return 0;
                var k = i === iw ? v / t.w : i === ih ? v / t.h : v / 100;
                return k > 0 && k <= MAXK + 1e-9 ? k : 0;
            }
            [ iw, ih, ip ].forEach( function ( i )
            {
                i.addEventListener( "input", function () { var k = factor( i ); if( k ) syncSize( k, i ); } );
                i.addEventListener( "change", function ()
                {
                    var k = factor( i );
                    if( ! k ) return syncSize();
                    var s = copyOf( state );
                    s.k = Math.round( k * 1e6 ) / 1e6;
                    commit( s );
                    syncSize();
                } );
                i.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) i.blur(); } );
            } );
            syncSize();
        }
        // The boxes from the factor `k` (the state's when none), but the one
        // being typed in.
        function syncSize( k, typing )
        {
            if( ! sizeIn || tool !== "resize" ) return;
            var s = copyOf( state );
            if( k ) s.k = k;
            var o = outSize( s );
            var t = turned( s.m, s.crop.w, s.crop.h );
            sizeIn.w.max = String( Math.round( t.w * MAXK ) );
            sizeIn.h.max = String( Math.round( t.h * MAXK ) );
            if( typing !== sizeIn.w )   sizeIn.w.value = String( o.w );
            if( typing !== sizeIn.h )   sizeIn.h.value = String( o.h );
            if( typing !== sizeIn.pct ) sizeIn.pct.value = String( Math.round( s.k * 1000 ) / 10 );
        }

        // ---- crop ----
        // While cropping the whole picture shows, turned, its middle at the
        // scene's (0, 0); the box is a rectangle of that scene.
        // [ id, label key ] - an id alone is its own label ("4x3" reads 4:3).
        var RATIOS = [ [ "free", "imgEd.custom" ], [ "orig", "imgEd.original" ], [ "1x1" ], [ "4x3" ], [ "16x9" ] ];

        function bounds() { var c = turned( state.m, W, H ); return { x: -c.w / 2, y: -c.h / 2, w: c.w, h: c.h }; }

        function ratioOf( r )
        {
            var b = bounds(), tall = b.h > b.w;
            if( r === "orig" ) return b.w / b.h;
            if( r === "1x1" )  return 1;
            if( r === "4x3" )  return tall ? 3 / 4 : 4 / 3;
            if( r === "16x9" ) return tall ? 9 / 16 : 16 / 9;
            return 0;
        }

        function enterCrop()
        {
            // The crop held now, as a box of the scene.
            var m = state.m, c = state.crop;
            var p = apply( m, c.x - W / 2, c.y - H / 2 ), q = apply( m, c.x + c.w - W / 2, c.y + c.h - H / 2 );
            box = { x: Math.min( p.x, q.x ), y: Math.min( p.y, q.y ), w: Math.abs( q.x - p.x ), h: Math.abs( q.y - p.y ) };
            ratio = "free";

            var pills = el( "div", "tb-group ie-pills", optsBar );
            RATIOS.forEach( function ( r )
            {
                var b = el( "button", "btn text sm bordered", pills );
                b.type = "button";
                b.textContent = r[ 1 ] ? T( r[ 1 ] ) : r[ 0 ].replace( "x", ":" );
                b.dataset.ie = "ratio-" + r[ 0 ];
                b.onclick = function () { pickRatio( r[ 0 ] ); };
            } );
            var g = el( "div", "tb-group", optsBar );
            button( "btn", "close", "imgEd.cancel", "cropCancel", g ).onclick = function () { leaveCrop( false ); openTool( "" ); };
            button( "btn", "check", "imgEd.apply", "cropApply", g ).onclick = function () { openTool( "" ); };
            syncRatio();

            setHand( false );
            crop.hidden = false;
            fitted = true;
            draw();
        }

        // ✓ (or another tool): the box becomes the crop. ×: nothing changes.
        function leaveCrop( keep )
        {
            if( tool !== "crop" || ! box ) return;
            var b = box;
            box = null;
            crop.hidden = true;
            tool = "";
            cropB.setAttribute( "aria-pressed", false );
            optsBar.replaceChildren();
            optsBar.hidden = true;
            setHand( true );
            fitted = true;
            if( keep )
            {
                var mi = inv( state.m );
                var p = apply( mi, b.x, b.y ), q = apply( mi, b.x + b.w, b.y + b.h );
                var x0 = clamp( Math.round( Math.min( p.x, q.x ) + W / 2 ), 0, W ), y0 = clamp( Math.round( Math.min( p.y, q.y ) + H / 2 ), 0, H );
                var x1 = clamp( Math.round( Math.max( p.x, q.x ) + W / 2 ), 0, W ), y1 = clamp( Math.round( Math.max( p.y, q.y ) + H / 2 ), 0, H );
                if( x1 - x0 >= 1 && y1 - y0 >= 1 )
                {
                    var s = copyOf( state );
                    s.crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
                    if( ! same( s, state ) ) { commit( s ); return; }
                }
            }
            draw();
        }

        function syncRatio()
        {
            optsBar.querySelectorAll( "[data-ie]" ).forEach( function ( p ) { p.setAttribute( "aria-pressed", p.dataset.ie === "ratio-" + ratio ); } );
            crop.classList.toggle( "fixed", ratio !== "free" );
        }

        // A ratio: the biggest box of that shape, in the middle of the picture.
        function pickRatio( r )
        {
            ratio = r;
            syncRatio();
            var k = ratioOf( r );
            if( k )
            {
                var b = bounds();
                var w = Math.min( b.w, b.h * k ), h = w / k;
                box = { x: -w / 2, y: -h / 2, w: w, h: h };
            }
            placeCrop();
        }

        function placeCrop()
        {
            if( ! box ) return;
            var o = origin();
            crop.style.left   = ( o.x + box.x * z ) + "px";
            crop.style.top    = ( o.y + box.y * z ) + "px";
            crop.style.width  = ( box.w * z ) + "px";
            crop.style.height = ( box.h * z ) + "px";
        }

        // A drag of the box (c = "move") or of a handle, by (dx, dy) scene
        // units from where it began (b0). Never out of the picture, never
        // smaller than ~24 screen px; a fixed ratio keeps its shape.
        function dragBox( c, b0, dx, dy )
        {
            var lim = bounds();
            var min = Math.min( Math.max( 1, 24 / z ), lim.w, lim.h );
            var L = b0.x, Tp = b0.y, R = b0.x + b0.w, B = b0.y + b0.h;
            if( c === "move" )
            {
                box = { x: clamp( L + dx, lim.x, lim.x + lim.w - b0.w ), y: clamp( Tp + dy, lim.y, lim.y + lim.h - b0.h ), w: b0.w, h: b0.h };
                return placeCrop();
            }
            var k = ratioOf( ratio );
            var east = c.indexOf( "e" ) >= 0, west = c.indexOf( "w" ) >= 0, south = c.indexOf( "s" ) >= 0, north = c.indexOf( "n" ) >= 0;
            if( k && ( east || west ) && ( north || south ) )
            {
                // The opposite corner stays; the box follows the farther axis.
                var w = east ? R + dx - L : R - ( L + dx );
                var h = south ? B + dy - Tp : B - ( Tp + dy );
                w = Math.max( w, h * k );
                var roomW = east ? lim.x + lim.w - L : R - lim.x;
                var roomH = south ? lim.y + lim.h - Tp : B - lim.y;
                w = Math.max( Math.min( w, roomW, roomH * k ), Math.max( min, min * k ) );
                h = w / k;
                box = { x: east ? L : R - w, y: south ? Tp : B - h, w: w, h: h };
                return placeCrop();
            }
            if( k ) return;                                 // edges hide with a fixed ratio
            if( west )  L = clamp( L + dx, lim.x, R - min );
            if( east )  R = clamp( R + dx, L + min, lim.x + lim.w );
            if( north ) Tp = clamp( Tp + dy, lim.y, B - min );
            if( south ) B = clamp( B + dy, Tp + min, lim.y + lim.h );
            box = { x: L, y: Tp, w: R - L, h: B - Tp };
            placeCrop();
        }

        // ---- the hand ----
        function setHand( on )
        {
            hand = on;
            handB.setAttribute( "aria-pressed", on );
            view.classList.toggle( "is-hand", on );
            crop.classList.toggle( "is-off", on );
        }

        // ---- pointers: pan, pinch, the crop box ----
        var ptrs = new Map();
        var gest = null;

        function startOne( e )
        {
            var h = tool === "crop" && ! hand && e.target.closest && e.target.closest( ".ie-crop" );
            if( h )
            {
                gest = { kind: "crop", c: e.target.dataset.c || "move", x: e.clientX, y: e.clientY, b0: { x: box.x, y: box.y, w: box.w, h: box.h } };
                return;
            }
            if( hand )
            {
                gest = { kind: "pan", x: e.clientX, y: e.clientY, sl: view.scrollLeft, st: view.scrollTop };
                view.classList.add( "is-panning" );
            }
        }
        function viewPoint( x, y ) { var r = view.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; }
        function startPinch()
        {
            var p = Array.from( ptrs.values() );
            var mid = viewPoint( ( p[ 0 ].x + p[ 1 ].x ) / 2, ( p[ 0 ].y + p[ 1 ].y ) / 2 );
            gest = { kind: "pinch", d0: Math.hypot( p[ 0 ].x - p[ 1 ].x, p[ 0 ].y - p[ 1 ].y ) || 1, z0: z, at: sceneAt( mid ) };
        }

        view.addEventListener( "pointerdown", function ( e )
        {
            if( e.pointerType === "mouse" && e.button !== 0 ) return;
            if( e.target.closest( ".ie-zoom" ) ) return;
            ptrs.set( e.pointerId, { x: e.clientX, y: e.clientY } );
            try { view.setPointerCapture( e.pointerId ); } catch( _ ) {}
            if( ptrs.size === 1 ) startOne( e );
            else if( ptrs.size === 2 ) startPinch();
            e.preventDefault();
        } );
        view.addEventListener( "pointermove", function ( e )
        {
            if( ! ptrs.has( e.pointerId ) ) return;
            ptrs.set( e.pointerId, { x: e.clientX, y: e.clientY } );
            if( ! gest ) return;
            if( gest.kind === "pan" )
            {
                view.scrollLeft = gest.sl - ( e.clientX - gest.x );
                view.scrollTop  = gest.st - ( e.clientY - gest.y );
            }
            else if( gest.kind === "crop" ) dragBox( gest.c, gest.b0, ( e.clientX - gest.x ) / z, ( e.clientY - gest.y ) / z );
            else if( gest.kind === "pinch" && ptrs.size >= 2 && state )
            {
                var p = Array.from( ptrs.values() );
                var mid = viewPoint( ( p[ 0 ].x + p[ 1 ].x ) / 2, ( p[ 0 ].y + p[ 1 ].y ) / 2 );
                zoomAt( gest.z0 * Math.hypot( p[ 0 ].x - p[ 1 ].x, p[ 0 ].y - p[ 1 ].y ) / gest.d0, gest.at, mid );
            }
        } );
        function lift( e )
        {
            if( ! ptrs.delete( e.pointerId ) ) return;
            view.classList.remove( "is-panning" );
            gest = null;
            // One finger left after a pinch: it goes on moving the picture.
            if( ptrs.size === 1 && hand )
            {
                var p = ptrs.values().next().value;
                gest = { kind: "pan", x: p.x, y: p.y, sl: view.scrollLeft, st: view.scrollTop };
            }
        }
        view.addEventListener( "pointerup", lift );
        view.addEventListener( "pointercancel", lift );

        // Ctrl + wheel (and a touchpad's pinch) zooms where the pointer is; a
        // plain wheel scrolls, as everywhere.
        view.addEventListener( "wheel", function ( e )
        {
            if( ! e.ctrlKey && ! e.metaKey ) return;
            e.preventDefault();
            var k = Math.exp( -e.deltaY * ( e.deltaMode ? 0.05 : 0.002 ) );
            zoomBy( k, viewPoint( e.clientX, e.clientY ) );
        }, { passive: false } );

        var queued = false;
        view.addEventListener( "scroll", function ()
        {
            if( queued ) return;
            queued = true;
            requestAnimationFrame( function () { queued = false; layout(); } );
        } );
        var ro = new ResizeObserver( function () { layout(); } );
        ro.observe( view );

        // ---- buttons ----
        handB.onclick  = function () { setHand( ! hand ); };
        outB.onclick   = function () { zoomBy( 1 / STEP ); };
        inB.onclick    = function () { zoomBy( STEP ); };
        fitB.onclick   = fit;
        oneB.onclick   = function () { zoomBy( 1 / z ); };
        cropB.onclick  = function () { openTool( "crop" ); };
        rotB.onclick   = function () { openTool( "rotate" ); };
        adjB.onclick   = function () { openTool( "adjust" ); };
        sizeB.onclick  = function () { openTool( "resize" ); };
        resetB.onclick = function () { leaveCrop( false ); commit( original() ); };
        undoB.onclick  = stepBack;
        redoB.onclick  = stepForward;

        // ---- keys: before the app's own (window, capture) ----
        function key( e )
        {
            if( ! root.isConnected || document.querySelector( "dialog.panel[open]" ) ) return;
            var typing = e.target && e.target.closest && e.target.closest( "input:not([type=range]), textarea, [contenteditable]" );
            var mod = e.ctrlKey || e.metaKey;
            if( mod && ! typing && ( e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y" ) )
            {
                e.preventDefault();
                e.stopPropagation();
                if( e.key.toLowerCase() === "y" || e.shiftKey ) stepForward(); else stepBack();
                return;
            }
            if( typing || mod ) return;
            if( e.key === "Escape" && tool )
            {
                e.preventDefault();
                e.stopPropagation();
                if( tool === "crop" ) leaveCrop( false );
                openTool( "" );
            }
            else if( e.key === "Enter" && tool === "crop" && ! e.target.closest( "button" ) )
            {
                e.preventDefault();
                e.stopPropagation();
                openTool( "" );
            }
        }
        window.addEventListener( "keydown", key, true );
        // A button pressed with the mouse or a finger keeps no focus: Enter
        // then applies the crop, not that button again.
        root.addEventListener( "click", function ( e )
        {
            var b = e.detail && e.target.closest( "button" );
            if( b ) b.blur();
        } );

        // ---- the picture ----
        [ cropB, rotB, adjB, sizeB, resetB, undoB, redoB ].forEach( function ( b ) { b.ariaDisabled = true; } );
        var img = new Image();
        img.decoding = "async";
        img.onload = function ()
        {
            if( dead ) return;
            src = img;
            W = img.naturalWidth;
            H = img.naturalHeight;
            state = original();
            pic = new F.FabricImage( img, { originX: "center", originY: "center", left: 0, top: 0,
                                            selectable: false, evented: false, objectCaching: false } );
            cnv.add( pic );
            [ cropB, rotB, adjB, sizeB ].forEach( function ( b ) { b.ariaDisabled = false; } );
            syncButtons();
            draw();
            emit( "loaded" );
        };
        img.onerror = function () { if( ! dead ) emit( "error" ); };
        img.src = url;
        img.alt = name || "";

        //--------------------------------------------------------------------//
        // What the apps call

        return {
            on: function ( ev, fn ) { ( listeners[ ev ] = listeners[ ev ] || [] ).push( fn ); },

            // The recipe, drawn once from the original at full size. "data:,"
            // when there is nothing to give (not loaded, a canvas too big for
            // this device): AyniPhoto.dataUrlBytes() refuses that.
            toDataURL: function ( o )
            {
                if( ! src ) return "data:,";
                o = o || {};
                var r = state.crop, m = state.m, sz = outSize( state );
                var kx = sz.w / turned( m, r.w, r.h ).w, ky = sz.h / turned( m, r.w, r.h ).h;
                var fmt = o.format === "jpg" ? "jpeg" : ( o.format || "png" );
                try
                {
                    var out = document.createElement( "canvas" );
                    out.width = sz.w;
                    out.height = sz.h;
                    var g = out.getContext( "2d" );
                    if( ! g ) return "data:,";
                    g.imageSmoothingQuality = "high";
                    g.setTransform( m[ 0 ] * kx, m[ 2 ] * ky, m[ 1 ] * kx, m[ 3 ] * ky, sz.w / 2, sz.h / 2 );
                    g.drawImage( src, r.x, r.y, r.w, r.h, -r.w / 2, -r.h / 2, r.w, r.h );
                    g.setTransform( 1, 0, 0, 1, 0, 0 );
                    if( state.b || state.c || state.s )
                    {
                        var px = g.getImageData( 0, 0, sz.w, sz.h );
                        adjustPixels( px.data, state );
                        g.putImageData( px, 0, 0 );
                    }
                    // A JPEG has no transparency: what was see-through goes white, not black.
                    if( fmt === "jpeg" )
                    {
                        g.globalCompositeOperation = "destination-over";
                        g.fillStyle = "#fff";
                        g.fillRect( 0, 0, sz.w, sz.h );
                    }
                    return out.toDataURL( "image/" + fmt, o.quality );
                }
                catch( e ) { return "data:,"; }
            },

            getCanvasSize: function ()
            {
                if( ! state ) return { width: 0, height: 0 };
                var sz = outSize( state );
                return { width: sz.w, height: sz.h };
            },

            destroy: function ()
            {
                if( dead ) return;
                dead = true;
                window.removeEventListener( "keydown", key, true );
                ro.disconnect();
                headBtns.forEach( function ( b ) { b.remove(); } );
                try { cnv.dispose(); } catch( e ) {}
                host.innerHTML = "";
            }
        };
    }

    window.AyniImageEditor = { create: create };
} )();
