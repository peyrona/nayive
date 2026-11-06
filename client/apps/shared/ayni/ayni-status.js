/* Ayni library 0.2.0, status: what an app says about itself. The connection plug (Ayni.plug), the card for almost-full space
   (Ayni.spaceCard) and the unread dot on the app's icon (Ayni.badge). Plain JavaScript, no build step, evergreen browsers 2024+.
   Optional: load it after ayni-base.js, with ayni-status.css. The rules are chapter 18.8 of the guidelines. */
( function ()
{
    "use strict";

    //------------------------------------------------------------------------//
    // SYNC INDICATOR GLYPH
    //
    // Every app's header carries a `.sync-indicator`. It used to be a filled dot
    // whose COLOUR was the whole message; now it is ONE plug, drawn either seated
    // in its socket or pulled out of it, so the state reads without relying on
    // colour alone. The colours are unchanged (ayni-status.css):
    //
    //     .synced   green  plugged in
    //     .busy     blue   plugged in (a GET / PUT is in flight)
    //     .offline  gold   unplugged  (offline / changes queued)
    //     no class  red    unplugged  (not synced yet / error)
    //
    // ayni-status.css picks the half to draw from that same state class, so an app only
    // ever toggles the classes it already toggled. The markup lives here, not in
    // 14 copies of the same <svg>: applySyncDots() fills every `.sync-indicator`
    // it finds, and the MutationObserver below catches the ones built later (a title row
    // built in code).

    var SYNC_GLYPH =
        '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
             'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            /* the socket never moves; its mouth is at x=16 */
            '<path d="M16 5h2a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-2"></path>' +
            /* plugged in: the prongs reach the mouth, so plug + socket read as one shape.
               The body is FILLED on purpose - at 19px that block of colour is what the eye
               catches from the corner, the way the old dot did. */
            '<g class="sy-in">' +
                '<rect x="7" y="6" width="6" height="12" rx="2" fill="currentColor" stroke="none"></rect>' +
                '<path d="M13 10h3"></path><path d="M13 14h3"></path>' +
            '</g>' +
            /* unplugged: the same plug pulled back to x=1, leaving a 6-unit gap - about 5px
               at 19px, which survives the phone header. Checked at true size, both themes. */
            '<g class="sy-out">' +
                '<rect x="1" y="6" width="6" height="12" rx="2" fill="currentColor" stroke="none"></rect>' +
                '<path d="M7 10h3"></path><path d="M7 14h3"></path>' +
            '</g>' +
        '</svg>';

    function applySyncDots( root )
    {
        var scope = root && root.querySelectorAll ? root : document;
        var list  = [].slice.call( scope.querySelectorAll( ".sync-indicator" ) );
        if( scope.nodeType === 1 && scope.matches && scope.matches( ".sync-indicator" ) )
            list.push( scope );

        for( var i = 0; i < list.length; i++ )
        {
            var el = list[ i ];
            if( el._ayniSync ) continue;
            el._ayniSync = true;
            el.innerHTML = SYNC_GLYPH;
            watchSyncChip( el );
        }
    }

    //------------------------------------------------------------------------//
    // THE PLUG AS A FLOATING CHIP
    //
    // Green is the normal case, so the plug takes no room in the header: it is
    // hidden while the connection is fine and, when it is not, floats as a
    // round chip just outside the END of its bar - under a top bar, above a
    // bottom one, beside a side one (a desktop's).
    //
    //   - It shows only once the link has been bad for 3 s: a lift or a
    //     wifi → 4G hand-over would otherwise blink it.
    //   - Blue (a GET / PUT in flight) never shows it on its own, and does not
    //     restart the 3 s either: a retry loop going red → blue → red shows.
    //   - When the link is back it stays green 1.5 s, then fades away.
    //
    // Apps keep toggling the same state classes; this watches them. The timing
    // lives per id, not per element, so a header rebuilt from scratch
    // keeps a chip that is already up. In a frame the dot stays hidden
    // (ayni-status.css), whatever this does. ayni-status.css draws .sy-show / .sy-fade.

    var SY_WAIT = 3000, SY_FLASH = 1500, SY_FADE = 250;
    var syChips = {};   // id → { el, badSince, okSince, shown, timer }

    function syncMood( el )
    {
        var c = el.classList;
        return c.contains( "busy" ) ? "busy" : c.contains( "synced" ) ? "ok" : "bad";
    }

    function watchSyncChip( el )
    {
        var key = el.id || "sync";
        var st  = syChips[ key ] || ( syChips[ key ] = { badSince: 0, okSince: 0, shown: false, timer: 0 } );
        st.el = el;                                    // the newest one is the one on screen
        new MutationObserver( function () { if( st.el === el ) syncChipUpdate( st ); } )
            .observe( el, { attributes: true, attributeFilter: [ "class" ] } );
        syncChipUpdate( st );
    }

    // Re-entrant on purpose: its own .sy-show / .sy-fade wake the observer
    // again, and the second pass changes nothing.
    function syncChipUpdate( st )
    {
        var mood = syncMood( st.el ), now = Date.now(), show, wait = 0;

        clearTimeout( st.timer );
        st.timer = 0;
        if( mood === "bad" && ! st.badSince ) st.badSince = now;
        if( mood === "ok" ) st.badSince = 0;
        if( mood !== "ok" ) st.okSince = 0;

        if( mood === "bad" )
        {
            wait = st.badSince + SY_WAIT - now;
            show = st.shown || wait <= 0;
        }
        else if( mood === "busy" ) show = st.shown;    // up already: stays, blue
        else if( st.shown )                            // back to green: the short flash
        {
            if( ! st.okSince ) st.okSince = now;
            wait = st.okSince + SY_FLASH - now;
            show = wait > 0;
            if( ! show ) st.okSince = 0;
        }
        else show = false;

        if( wait > 0 ) st.timer = setTimeout( function () { syncChipUpdate( st ); }, wait );
        syncChipShow( st, show );
    }

    function syncChipShow( st, show )
    {
        var el = st.el, c = el.classList;
        st.shown = show;
        if( show )
        {
            // Only real changes: even a no-op classList call rewrites the
            // attribute, which would wake the observer again - forever.
            if( c.contains( "sy-fade" ) ) c.remove( "sy-fade" );
            if( ! c.contains( "sy-show" ) ) c.add( "sy-show" );
            placeSyncChip( el );
        }
        else if( c.contains( "sy-show" ) && ! c.contains( "sy-fade" ) )
        {
            c.add( "sy-fade" );
            setTimeout( function () { if( ! st.shown ) c.remove( "sy-show", "sy-fade" ); }, SY_FADE );
        }
    }

    // Just outside the bar's end, where the plug used to sit.
    function placeSyncChip( el )
    {
        var bar = el.closest( Ayni.plug.bars ) || el.parentElement;
        if( ! bar ) return;

        var r = bar.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight, gap = 6;
        var s = el.style;
        s.top = s.bottom = s.left = s.right = "";

        if( r.height > r.width )                       // a side bar: beside its lower end
        {
            s.bottom = Math.max( gap, H - r.bottom + gap ) + "px";
            if( r.left > W / 2 ) s.right = ( W - r.left + gap ) + "px";
            else                 s.left  = ( r.right + gap ) + "px";
        }
        else
        {
            s.right = Math.max( gap, W - r.right + gap ) + "px";
            if( r.top > H / 2 ) s.bottom = ( H - r.top + gap ) + "px";            // a bottom bar: above it
            else                s.top    = Math.max( gap, r.bottom + gap ) + "px"; // a top bar: under it
        }
    }

    //------------------------------------------------------------------------//
    // THE SYNC INDICATOR  -  one mapping from shared/a store's states to the
    // header plug, for every app that syncs through the store.
    //
    //   synced           green   plugged in    - the server has the latest
    //   loading/saving   blue    plugged in    - a GET / PUT is in flight
    //   offline/pending  gold    unplugged     - edits are safe in the local cache
    //   error/needs-auth red     unplugged     - attention
    //
    // Titles are the `ayni.sync.*` keys; a <button> indicator (apps with one store,
    // where the plug is also the refresh control) gets the "tap to refresh"
    // hint appended. opts.titles overrides a state's key (an app may say
    // "not uploaded yet" rather than "changes queued").
    var SYNC_KEYS = { synced: "synced", loading: "loading", saving: "saving",
                      offline: "offline", pending: "pending", "needs-auth": "needsAuth",
                      conflict: "conflict" };

    function applySyncState( el, state, opts )
    {
        if( typeof el === "string" ) el = document.getElementById( el );
        if( ! el ) return;
        opts = opts || {};

        el.classList.toggle( "synced",  state === "synced" );
        el.classList.toggle( "busy",    state === "loading" || state === "saving" );
        el.classList.toggle( "offline", state === "offline" || state === "pending" );

        var key = ( opts.titles && opts.titles[ state ] ) || ( "ayni.sync." + ( SYNC_KEYS[ state ] || "error" ) );
        var hint = ( opts.tapHint != null ? opts.tapHint : el.tagName === "BUTTON" ) ? Ayni.t( "ayni.sync.tapHint" ) : "";
        Ayni.setTip( el, Ayni.t( key ) + hint );

        // Stamped so a boot can tell "nobody has touched this plug yet"
        // (settle it) from "the app deliberately put it here" (leave it alone -
        // a document imported and never saved is red on purpose).
        el.dataset.syncState = state;
    }

    // A ready-made store.onState listener for the #syncIndicator of the page.
    function syncIndicator( opts )
    {
        return function ( state ) { applySyncState( document.getElementById( ( opts && opts.id ) || "syncIndicator" ), state, opts ); };
    }

    // The bar may move (a card page scrolls, the window is resized, the
    // desktop's bar changes side): keep an open chip glued to it.
    function placeSyncChips()
    {
        for( var k in syChips )
            if( syChips[ k ].shown && syChips[ k ].el.isConnected ) placeSyncChip( syChips[ k ].el );
    }

    window.addEventListener( "resize", placeSyncChips );
    document.addEventListener( "scroll", placeSyncChips, { capture: true, passive: true } );

    Ayni.plug = { draw: applySyncDots, set: applySyncState, listener: syncIndicator, place: placeSyncChips, bars: ".topbar, .header, .taskbar, header" };

    //------------------------------------------------------------------------//
    // THE SPACE CARD  -  it stays until closed, bottom-centre. opts: title, used
    // (a line), how (a line), items (a list of lines), action { label, icon, run }.
    // Returns the card. When to show it is the app's: only it knows its space.
    Ayni.spaceCard = function ( opts )
    {
        if( ! document.body ) return null;

        var card = document.createElement( "div" );
        card.className = "quota-card";
        card.setAttribute( "role", "alert" );

        var head  = document.createElement( "div" );
        head.className = "quota-card-head";
        var title = document.createElement( "strong" );
        title.textContent = opts.title;
        var close = document.createElement( "button" );
        close.type = "button";
        close.className = "btn sm";
        Ayni.setTip( close, Ayni.t( "ayni.close" ) );
        close.setAttribute( "aria-label", close.dataset.tip );
        close.innerHTML = Ayni.icon( "close" );
        close.addEventListener( "click", function () { card.remove(); } );
        head.appendChild( title );
        head.appendChild( close );

        var line = document.createElement( "p" );
        line.textContent = opts.used;

        var how = document.createElement( "p" );
        how.textContent = opts.how;

        var list = document.createElement( "ul" );
        opts.items.forEach( function ( text )
        {
            var li = document.createElement( "li" );
            li.textContent = text;
            list.appendChild( li );
        } );

        var acts = document.createElement( "div" );
        acts.className = "quota-card-actions";
        if( opts.action )
        {
            var find = document.createElement( "button" );
            find.type      = "button";
            find.className = "btn text primary";
            find.innerHTML = Ayni.icon( opts.action.icon || "search" ) + "<span></span>";
            find.lastChild.textContent = opts.action.label;
            find.addEventListener( "click", function () { card.remove(); opts.action.run(); } );
            acts.appendChild( find );
        }

        card.appendChild( head );
        card.appendChild( line );
        card.appendChild( how );
        card.appendChild( list );
        card.appendChild( acts );
        document.body.appendChild( card );
        return card;
    };

    //------------------------------------------------------------------------//
    // THE UNREAD DOT  -  a red dot on the app's icon. Ayni.badge( selector ) returns
    // { set( n, blink ), place(), showing() }. It blinks 5 times when told to: also with
    // "reduce motion" on, it is a short signal, not decoration.
    function onScreen( el )
    {
        if( ! el || ! el.getBoundingClientRect ) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    Ayni.badge = function ( sel )
    {
        var dot = null;

        // The dot lives in the icon's parent (an <svg> cannot hold it), placed over
        // the icon's top-right corner. It is absolute, so the header's flex gap and
        // layout do not change.
        function place()
        {
            if( ! dot || dot.hidden ) return;
            var ico = null, all = document.querySelectorAll( sel );
            for( var i = 0; i < all.length && ! ico; i++ ) if( onScreen( all[ i ] ) ) ico = all[ i ];
            if( ! ico ) { dot.style.display = "none"; return; }

            var host = ico.parentNode;
            if( dot.parentNode !== host ) host.appendChild( dot );
            if( getComputedStyle( host ).position === "static" ) host.style.position = "relative";
            dot.style.display = "";

            var hr = host.getBoundingClientRect(), ir = ico.getBoundingClientRect();
            dot.style.left = ( ir.right - hr.left + host.scrollLeft - host.clientLeft - 8 ) + "px";
            dot.style.top  = ( ir.top   - hr.top  + host.scrollTop  - host.clientTop  - 3 ) + "px";
        }

        function set( n, blink )
        {
            if( ! n ) { if( dot ) dot.hidden = true; return; }

            if( ! dot )
            {
                dot = document.createElement( "span" );
                dot.className = "icon-badge";
                dot.setAttribute( "aria-hidden", "true" );
            }
            dot.hidden = false;
            place();

            if( blink )
            {
                dot.classList.remove( "blink" );
                void dot.offsetWidth;                 // restart the animation
                dot.classList.add( "blink" );
            }
        }

        return { set: set, place: place, showing: function () { return !! dot && ! dot.hidden && dot.style.display !== "none"; } };
    };
} )();
