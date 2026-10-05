/*
 * browser.js - the item browser: ONE way to pick things in a list and act on
 * them, shared by every app that shows a list (Drive, Bookmarks, eMail,
 * Contacts, Photos, Music, Movies, the Chat list). See docs/item-browser-plan.md.
 *
 * Classic script, loaded AFTER shared/ui.js; it adds to the same global:
 *     <script src="../shared/ui.js" defer></script>
 *     <script src="../shared/browser.js" defer></script>
 *
 * The parts (each usable on its own):
 *
 *   NayiveUI.browser( cfg )   select + header group + menu + keys + drag, on one list
 *   NayiveUI.fitBar( header, opts )   the toolbar shows what fits; ONE ⋮ holds the rest
 *   NayiveUI.menuAt( x, y, items, opts )   the one popup menu (.top-menu.item-menu)
 *   NayiveUI.tree( cfg )      a folder tree: arrow, open, menu, drop, keys, phone sheet
 *   NayiveUI.pickNode( cfg )  "Move to…": a dialog with the same tree, -> Promise(id | null)
 *   NayiveUI.longPress( host, sel, fn )   one copy of the touch long-press
 *   NayiveUI.dropZone( host, cfg )        one copy of "drop picked items on a folder"
 *   NayiveUI.keyLabel( "Ctrl+C" )         "Ctrl+C" / "⌘C", as the menus show it
 *
 * THE RULES (the same in every app)
 *   Mouse: click selects one, Ctrl+click adds / removes, Shift+click a range,
 *   double-click or Enter opens, a click on empty space clears. A round tick
 *   at the start of each row shows on hover; a click on it adds / removes.
 *   Touch: tap opens. Long-press starts picking: ticks show on every row and
 *   each tap adds / removes. The × in the header or Esc stops.
 *   Header: while something is picked, the selection group (cfg.bar) shows
 *   the count with ×, Select all, then EVERY action as a button, in the menu's
 *   order. What does not fit goes into the toolbar's one ⋮ (fitBar), least
 *   important (highest rank) first; the order never changes.
 *   Right-click (long-press on touch) opens the full menu. Right-click on a
 *   row that is not picked picks only that row first; on empty space it
 *   gives the area actions (New, Paste, Select all). Rows have no ⋮.
 *
 * ONE RULE PER ACTION
 *   { id, label, icon, key, rank, noBar, hideOff, group, danger, where, when, run }
 *   - label: a string or fn( ids ) (a toggle: "Star" / "Unstar")
 *   - icon:  a NayiveUI.icon name, or an SVG string
 *   - key:   "Del", "F2", "Ctrl+C", "Shift+Del", "R" ... (or an array: the first
 *            is shown). The browser runs the action on that key.
 *   - rank:  how important its header button is: 1 is the last to leave when
 *            the toolbar runs out of room (Select all is 4, tools 20+)
 *   - noBar: menu and key only, no header button (Drive's cut / copy: they
 *            repeat "Move to" / "Copy to")
 *   - hideOff: hidden from the header, not greyed, when `when` says no
 *            (an action for one kind of item: Extract, Merge...)
 *   - group: menu section; a line goes between two sections (a gap in the header)
 *   - where(): false HIDES it here (Spam vs Not spam: never applies here)
 *   - when( ids ): false GREYS it for this selection (one item, a .zip ...)
 *   - run( ids, ev ): does it. The app's own data calls stay where they are.
 *   The header button, the menu row and the key all read the same rules.
 *
 * An app never re-renders its list on a selection change: the browser paints
 * .is-selected in place (a re-render between the two clicks of a double-click
 * would lose it). cfg.onSelect is for what lives OUTSIDE the list.
 */
( function ()
{
    "use strict";

    var UI = window.NayiveUI;
    if( ! UI ) return;
    var t  = UI.t, tf = UI.tf;

    function $( x ) { return typeof x === "string" ? document.querySelector( x ) : x; }
    function esc( s ) { return UI.escapeHtml( s == null ? "" : String( s ) ); }

    var MQ_PHONE = window.matchMedia( "(max-width: 640px)" );
    var MQ_TOUCH = window.matchMedia( "(hover: none), (pointer: coarse)" );
    function isPhone() { return MQ_PHONE.matches; }

    // Glyphs this file needs that ui.js has no name for.
    var G = {
        dots:      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="5" r="1.9"></circle><circle cx="12" cy="12" r="1.9"></circle><circle cx="12" cy="19" r="1.9"></circle></svg>',
        checkAll:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
        tick:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>',
        chevron:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>',
        folder:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
        move:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="12 10 15 13 12 16"></polyline><line x1="8" y1="13" x2="15" y2="13"></line></svg>',
        link:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
        star:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7 12 2.8"></polygon></svg>',
        external:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>',
        tag:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>',
        users:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
        pin:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"></path></svg>',
        bellOff:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path><path d="M18 8a6 6 0 0 0-9.33-5"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>',
        mailOpen:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0z"></path><path d="M22 10l-9 5.7a2 2 0 0 1-2 0L2 10"></path></svg>',
        queue:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="15" y2="6"></line><line x1="3" y1="12" x2="15" y2="12"></line><line x1="3" y1="18" x2="11" y2="18"></line><polygon points="17 14 22 17 17 20 17 14"></polygon></svg>',
        image:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
        merge:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M6 21V9a9 9 0 0 0 9 9"></path></svg>',
        upload:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
        restore:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>'
    };

    // A glyph by name: ours first, then ui.js's; an SVG string as it is.
    function glyph( ic )
    {
        if( ! ic ) return "";
        if( ic.charAt( 0 ) === "<" ) return ic;
        return G[ ic ] || UI.icon( ic );
    }

    //------------------------------------------------------------------------//
    // KEYS  -  "Ctrl+Shift+X" <-> a keydown. Ctrl is ⌘ on a Mac.

    var KEY_NAMES = { del: "Delete", delete: "Delete", enter: "Enter", esc: "Escape", escape: "Escape",
                      space: " ", tab: "Tab", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft",
                      right: "ArrowRight", home: "Home", end: "End", backspace: "Backspace" };

    function parseKey( spec )
    {
        var parts = String( spec ).split( "+" );
        var k = { ctrl: false, shift: false, alt: false, key: "" };
        parts.forEach( function ( p, i )
        {
            var low = p.toLowerCase();
            if( i < parts.length - 1 || ( parts.length > 1 && ! p ) )
            {
                if( low === "ctrl" || low === "cmd" ) k.ctrl = true;
                else if( low === "shift" ) k.shift = true;
                else if( low === "alt" ) k.alt = true;
                return;
            }
            k.key = KEY_NAMES[ low ] || ( p.length === 1 ? p.toLowerCase() : p );
        } );
        return k;
    }

    // The key of a shortcut. e.key is what the LAYOUT types: Ctrl+C on a
    // Cyrillic keyboard reads "с", Mac's ⌥N a dead "˜". With Ctrl / Alt held
    // and no Latin letter, the key's place (e.code "KeyC") names it, as the
    // old Drive keyboard.js did; a Latin letter keeps e.key (AZERTY's A).
    function keyOf( e )
    {
        var key = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if( ( e.ctrlKey || e.metaKey || e.altKey ) && ! /^[a-z]$/.test( key ) && /^Key[A-Z]$/.test( e.code || "" ) )
            return e.code.charAt( 3 ).toLowerCase();
        return key;
    }

    function keyMatches( spec, e )
    {
        var specs = Array.isArray( spec ) ? spec : [ spec ];
        return specs.some( function ( s )
        {
            var k = parseKey( s );
            var ctrl = UI.isMac ? e.metaKey : e.ctrlKey;
            if( ctrl !== k.ctrl || e.altKey !== k.alt ) return false;
            if( UI.isMac ? e.ctrlKey : e.metaKey ) return false;
            var key = keyOf( e );
            // A letter's Shift is part of the spec; Shift+Del is too.
            if( e.shiftKey !== k.shift ) return false;
            return key === k.key;
        } );
    }

    // What a menu row / tooltip shows: "Ctrl+C", "⌘C", "Del" in the
    // interface language.
    function keyLabel( spec )
    {
        if( ! spec ) return "";
        var s = Array.isArray( spec ) ? spec[ 0 ] : spec;
        var out = [];
        String( s ).split( "+" ).forEach( function ( p )
        {
            var low = p.toLowerCase();
            if( low === "ctrl" || low === "cmd" ) out.push( UI.isMac ? "⌘" : t( "ui.keyCtrl" ) );
            else if( low === "shift" )            out.push( UI.isMac ? "⇧" : t( "ui.keyShift" ) );
            else if( low === "alt" )              out.push( UI.isMac ? "⌥" : t( "ui.keyAlt" ) );
            else if( low === "del" || low === "delete" ) out.push( t( "ui.keyDel" ) );
            else if( low === "enter" )            out.push( t( "ui.keyEnter" ) );
            else if( low === "esc" )              out.push( t( "ui.keyEsc" ) );
            else out.push( p.length === 1 ? p.toUpperCase() : p );
        } );
        return out.join( UI.isMac ? "" : "+" );
    }

    function inTextField( el )
    {
        if( ! el || ! el.closest ) return false;
        return !! el.closest( "input, textarea, select, [contenteditable=''], [contenteditable='true']" );
    }

    // A dialog - or Drive's picture viewer / media player, Chat's photo
    // editor - owns the screen: the list behind it takes no keys.
    function dialogOpen()
    {
        return !! document.querySelector( ".sheet-backdrop.open, .viewer-backdrop.open, .media-backdrop.open, .editor-backdrop.open" );
    }

    // Was a dialog open when this Escape was pressed? Read before any
    // listener (window, capture): a sheet that shuts on Escape without
    // preventDefault must not let the same key also clear the pick.
    var escHadDialog = false;
    window.addEventListener( "keydown", function ( e )
    {
        if( e.key === "Escape" ) escHadDialog = dialogOpen();
    }, true );

    //------------------------------------------------------------------------//
    // THE ONE MENU  -  NayiveUI.menuAt( x, y, items, opts )
    //
    // items: [ { label, icon, key, danger, disabled, checked, title, run } ,
    //          { sep: true } , { caption: "Sort" } ]
    // opts:  { anchor: el (hang under it, right-aligned), onClose }
    // Fits on screen; closes on an outside press, a scroll, a resize, Esc or
    // a pick. ↑ ↓ move between rows, Enter picks. One open at a time.

    var menuEl = null, menuState = null;

    function ensureMenu()
    {
        if( menuEl ) return menuEl;
        menuEl = document.createElement( "div" );
        menuEl.className = "top-menu item-menu";
        menuEl.setAttribute( "role", "menu" );
        menuEl.hidden = true;
        document.body.appendChild( menuEl );

        menuEl.addEventListener( "click", function ( e )
        {
            var b = e.target.closest( "button.menu-item" );
            if( ! b || b.disabled || ! menuState ) return;
            var it = menuState.items[ +b.dataset.i ];
            closeMenu();
            if( it && it.run ) it.run( e );
        } );
        menuEl.addEventListener( "contextmenu", function ( e ) { e.preventDefault(); } );
        menuEl.addEventListener( "keydown", function ( e )
        {
            var rows = Array.prototype.slice.call( menuEl.querySelectorAll( "button.menu-item:not([disabled])" ) );
            var i = rows.indexOf( document.activeElement );
            if( e.key === "ArrowDown" ) { e.preventDefault(); ( rows[ i + 1 ] || rows[ 0 ] ).focus(); }
            else if( e.key === "ArrowUp" ) { e.preventDefault(); ( rows[ i - 1 ] || rows[ rows.length - 1 ] ).focus(); }
            else if( e.key === "Home" ) { e.preventDefault(); rows[ 0 ].focus(); }
            else if( e.key === "End" ) { e.preventDefault(); rows[ rows.length - 1 ].focus(); }
            else if( e.key === "Tab" ) { e.preventDefault(); closeMenu(); }
        } );

        document.addEventListener( "pointerdown", function ( e )
        {
            if( menuState && ! menuEl.contains( e.target ) &&
                ! ( menuState.anchor && menuState.anchor.contains( e.target ) ) ) closeMenu();
        }, true );
        document.addEventListener( "keydown", function ( e )
        {
            if( e.key === "Escape" && menuState ) { e.preventDefault(); e.stopImmediatePropagation(); closeMenu( true ); }
        }, true );
        document.addEventListener( "scroll", function ( e )
        {
            if( menuState && ! menuEl.contains( e.target ) ) closeMenu();
        }, true );
        window.addEventListener( "resize", function () { closeMenu(); } );
        window.addEventListener( "blur", function () { closeMenu(); } );
        return menuEl;
    }

    function menuHtml( items )
    {
        var html = "", lastSep = true;
        items.forEach( function ( it, i )
        {
            if( ! it || it.hidden ) return;
            if( it.sep ) { if( ! lastSep ) html += '<div class="menu-sep" role="separator"></div>'; lastSep = true; return; }
            lastSep = false;
            if( it.caption ) { html += '<div class="menu-label">' + esc( it.caption ) + "</div>"; return; }
            html += '<button type="button" role="menuitem" class="menu-item' + ( it.danger ? " danger" : "" ) +
                    ( it.checked ? " is-active" : "" ) + '" data-i' + '="' + i + '"' + ( it.id ? ' data-act="' + esc( it.id ) + '"' : "" ) +
                    ( it.disabled ? " disabled" : "" ) + ( it.title ? ' title="' + esc( it.title ) + '"' : "" ) + ">" +
                    ( it.checked != null ? '<span class="mi-check">' + G.tick + "</span>" : "" ) +
                    ( it.icon ? glyph( it.icon ) : '<span class="mi-noicon"></span>' ) +
                    '<span class="mi-label">' + esc( it.label ) + "</span>" +
                    ( it.key ? '<span class="mi-key">' + esc( keyLabel( it.key ) ) + "</span>" : "" ) +
                    "</button>";
        } );
        return html.replace( /<div class="menu-sep" role="separator"><\/div>$/, "" );
    }

    function menuAt( x, y, items, opts )
    {
        opts = opts || {};
        closeMenu();
        var m = ensureMenu();
        m.innerHTML = menuHtml( items );
        if( ! m.firstChild ) return null;
        menuState = { items: items, anchor: opts.anchor || null, onClose: opts.onClose || null,
                      back: document.activeElement };
        m.hidden = false;
        m.style.right = "auto";

        var w = m.offsetWidth, h = m.offsetHeight;
        if( opts.anchor )
        {
            var r = opts.anchor.getBoundingClientRect();
            x = r.right - w;
            y = r.bottom + 4;
            if( y + h > window.innerHeight - 8 && r.top - h - 4 > 6 ) y = r.top - h - 4;
        }
        m.style.left = Math.max( 6, Math.min( x, window.innerWidth  - w - 8 ) ) + "px";
        m.style.top  = Math.max( 6, Math.min( y, window.innerHeight - h - 8 ) ) + "px";
        if( opts.anchor ) opts.anchor.setAttribute( "aria-expanded", "true" );

        // From the keyboard the first row takes the focus; from a pointer the
        // menu just shows.
        if( opts.keyboard )
        {
            var first = m.querySelector( "button.menu-item:not([disabled])" );
            if( first ) first.focus();
        }
        return m;
    }

    function closeMenu( refocus )
    {
        if( ! menuState ) return;
        var st = menuState;
        menuState = null;
        menuEl.hidden = true;
        if( st.anchor ) st.anchor.setAttribute( "aria-expanded", "false" );
        if( refocus && st.back && st.back.focus && document.contains( st.back ) ) st.back.focus( { preventScroll: true } );
        if( st.onClose ) st.onClose();
    }

    function menuOpen() { return !! menuState; }

    //------------------------------------------------------------------------//
    // LONG-PRESS  -  NayiveUI.longPress( host, sel, fn( el, x, y ) )
    // One finger held 500 ms without moving: fn runs, and the click (and the
    // contextmenu Android adds) that follow are eaten - while the finger is
    // still down and for a moment after it lifts, so a quick next tap counts.

    var swallowUntil = 0;

    function longPress( host, sel, fn )
    {
        host = $( host );
        var timer = null, x = 0, y = 0, fired = false;
        function stop() { if( timer ) { clearTimeout( timer ); timer = null; } }
        function lift()
        {
            stop();
            if( fired ) { fired = false; swallowUntil = Date.now() + 350; }
        }

        host.addEventListener( "touchstart", function ( e )
        {
            stop();
            fired = false;
            if( e.touches.length !== 1 ) return;
            var el = e.target.closest( sel );
            if( ! el || ! host.contains( el ) || e.target.closest( "input, textarea" ) ) return;
            x = e.touches[ 0 ].clientX; y = e.touches[ 0 ].clientY;
            timer = setTimeout( function ()
            {
                timer = null;
                fired = true;
                swallowUntil = Date.now() + 60000;     // until the finger lifts
                if( navigator.vibrate ) try { navigator.vibrate( 15 ); } catch( _ ) {}
                fn( el, x, y );
            }, 500 );
        }, { passive: true } );
        host.addEventListener( "touchmove", function ( e )
        {
            if( ! timer ) return;
            var p = e.touches[ 0 ];
            if( Math.abs( p.clientX - x ) > 10 || Math.abs( p.clientY - y ) > 10 ) stop();
        }, { passive: true } );
        host.addEventListener( "touchend", lift );
        host.addEventListener( "touchcancel", lift );
    }

    // After a long-press: the click and contextmenu the finger leaves behind.
    document.addEventListener( "click", function ( e )
    {
        if( Date.now() < swallowUntil ) { swallowUntil = 0; e.preventDefault(); e.stopPropagation(); }
    }, true );
    document.addEventListener( "contextmenu", function ( e )
    {
        if( Date.now() < swallowUntil ) { e.preventDefault(); e.stopPropagation(); }
    }, true );

    // What the last press was made with: a mouse click selects, a finger's tap
    // opens. Read on pointerdown, before the click it leads to.
    var lastPointer = "mouse";
    document.addEventListener( "pointerdown", function ( e ) { lastPointer = e.pointerType || "mouse"; }, true );
    function touchLike() { return lastPointer === "touch" || lastPointer === "pen" && MQ_TOUCH.matches; }

    //------------------------------------------------------------------------//
    // DRAG AND DROP  -  rows (and tree rows) carry their ids; NayiveUI.dropZone
    // marks and takes them. Only a mouse drags: a draggable row fights a
    // finger's scroll on some tablets ("Move to…" is the touch way).
    //
    //   NayiveUI.dropZone( host, {
    //       sel:    ".tree-row, .is-folder",       // what can take a drop
    //       target: el => id,                       // the folder it stands for
    //       can:    ( ids, id, el, e ) => zone,     // "inside" | "before" | "after" | false
    //                                               // | { zone, ok: false } (refused, see below)
    //       drop:   ( ids, id, zone, e, ok ) => {}
    //   } )

    var drag = { ids: null, from: null };
    var MQ_MOUSE = window.matchMedia( "(hover: hover) and (pointer: fine)" );

    function clearDropMarks( keep )
    {
        document.querySelectorAll( ".drop-target, .drop-before, .drop-after" ).forEach( function ( el )
        {
            if( el !== keep ) el.classList.remove( "drop-target", "drop-before", "drop-after" );
        } );
    }

    function startDrag( e, ids, text, from )
    {
        drag.ids  = ids;
        drag.from = from || null;
        closeMenu();
        e.dataTransfer.effectAllowed = "copyMove";
        try { e.dataTransfer.setData( "text/plain", text || "" ); } catch( _ ) {}
        try { e.dataTransfer.setData( "application/x-nayive-ids", JSON.stringify( ids ) ); } catch( _ ) {}
    }

    document.addEventListener( "dragend", function ()
    {
        drag.ids = null;
        drag.from = null;
        document.querySelectorAll( ".dragging" ).forEach( function ( el ) { el.classList.remove( "dragging" ); } );
        clearDropMarks( null );
    } );

    function dropZone( host, cfg )
    {
        host = $( host );
        function hit( e )
        {
            var el = e.target.closest && e.target.closest( cfg.sel );
            if( ! el || ! host.contains( el ) ) return null;
            var id = cfg.target( el );
            return id == null ? null : { el: el, id: id };
        }
        // can() says: false (not a target), a zone (good), or { zone, ok: false }
        // (a target that refuses: no mark, but the drop still comes, so the
        // app can say why - "a folder can not go inside itself").
        function verdict( h, e )
        {
            var v = cfg.can ? cfg.can( drag.ids, h.id, h.el, e ) : "inside";
            if( ! v ) return null;
            return typeof v === "string" ? { zone: v, ok: true } : { zone: v.zone || "inside", ok: v.ok !== false };
        }
        host.addEventListener( "dragover", function ( e )
        {
            if( ! drag.ids ) return;
            var h = hit( e );
            clearDropMarks( h && h.el );
            if( ! h ) return;
            var v = verdict( h, e );
            if( ! v ) { h.el.classList.remove( "drop-target", "drop-before", "drop-after" ); return; }
            e.preventDefault();
            e.dataTransfer.dropEffect = ( e.ctrlKey || e.altKey ) && cfg.copy ? "copy" : "move";
            h.el.classList.toggle( "drop-target", v.ok && v.zone === "inside" );
            h.el.classList.toggle( "drop-before", v.ok && v.zone === "before" );
            h.el.classList.toggle( "drop-after",  v.ok && v.zone === "after" );
        } );
        host.addEventListener( "dragleave", function ( e )
        {
            var h = hit( e );
            if( h && ! h.el.contains( e.relatedTarget ) ) h.el.classList.remove( "drop-target", "drop-before", "drop-after" );
        } );
        host.addEventListener( "drop", function ( e )
        {
            if( ! drag.ids ) return;
            var h = hit( e );
            if( ! h ) return;
            var v = verdict( h, e );
            if( ! v ) return;
            e.preventDefault();
            e.stopPropagation();
            var ids = drag.ids;
            drag.ids = null;
            clearDropMarks( null );
            cfg.drop( ids, h.id, v.zone, e, v.ok );
        } );
    }

    //------------------------------------------------------------------------//
    // THE TOOLBAR FITS  -  NayiveUI.fitBar( header, { more, btn } )
    //
    // Every button that may leave the toolbar carries data-rank (1 = the last
    // to leave). While the header's buttons do not fit on the title's line,
    // the highest rank hides (.fit-out; equal ranks: the later one first) and
    // ONE ⋮ in .tb-sys lists the hidden ones, in toolbar order, then the
    // app's own items (opts.more: () => menu rows). No hidden button and no
    // own items: no ⋮. The order never changes; the rest close up.
    //   header: the .topbar / .header (or any bar that must stay one row)
    //   btn:    the app's own ⋮ button to use (else one is made in .tb-sys)
    // A button the app hides itself ([hidden], display: none) is not ours: it
    // never goes into the ⋮. Calling it again on the same header updates opts.
    // Search (rank 20 in every app) never leaves while nothing is picked: it
    // stays in the same place. While picking, the actions get the room.

    function fitBar( header, opts )
    {
        header = $( header );
        if( ! header ) return null;
        opts = opts || {};
        if( header._fitBar ) { header._fitBar.set( opts ); return header._fitBar; }

        var holder = header.querySelector( ".topbar-actions, .header-actions" ) || header;
        var btn = null, made = false;

        // The ⋮: the app's own button, else one made at the start of .tb-sys.
        // An app that passes its own later (after the browser made one) swaps it in.
        function adopt( b )
        {
            if( btn && b === btn ) return;
            if( made && btn ) btn.remove();
            made = ! b;
            if( ! b )
            {
                var sys = holder.querySelector( ".tb-sys" );
                if( ! sys )
                {
                    sys = document.createElement( "div" );
                    sys.className = "tb-group tb-sys";
                    holder.insertBefore( sys, holder.querySelector( ":scope > .sync-indicator" ) );
                }
                b = document.createElement( "button" );
                b.type = "button";
                b.className = "icon-btn";
                b.innerHTML = G.dots;
                sys.insertBefore( b, sys.firstChild );
            }
            btn = b;
            btn.classList.add( "fit-more" );
            btn.setAttribute( "aria-haspopup", "menu" );
            btn.title = t( "ui.moreOptions" );
            btn.setAttribute( "aria-label", t( "ui.moreOptions" ) );
            btn.hidden = true;
            btn.addEventListener( "click", function ( e )
            {
                if( btn !== e.currentTarget ) return;
                e.stopPropagation();
                if( menuOpen() && menuState.anchor === btn ) { closeMenu(); return; }
                menuAt( 0, 0, items(), { anchor: btn, keyboard: e.detail === 0 } );
            } );
        }

        var fitting = false, queued = false, lastW = -1, lastH = -1;

        function ranked() { return Array.prototype.slice.call( header.querySelectorAll( "[data-rank]" ) ); }
        // Shown, were it not for us: the app has not hidden it or a box around it.
        function shown( el ) { return ! el.classList.contains( "fit-out" ) && el.getClientRects().length > 0; }
        function picking() { return header.classList.contains( "has-selection" ) || !! header.querySelector( ".has-selection" ); }
        function pinned( el )
        {
            if( el.dataset.rank === "20" && ! picking() ) return true;
            return !! ( el._fitPin || el.matches( ".search-fold.is-open" ) || el.querySelector( ".search-fold.is-open" ) );
        }
        function ownItems()
        {
            var m = opts.more ? opts.more() || [] : [];
            return m.filter( function ( it ) { return it && ! it.hidden; } );
        }

        // Off the title's line: a direct child of the header starts below the
        // bottom of the topmost one (the bar wrapped), or the header scrolls.
        function crowded()
        {
            if( header.scrollWidth > header.clientWidth + 1 ) return true;
            if( holder !== header && holder.scrollWidth > holder.clientWidth + 1 ) return true;
            var rs = [];
            Array.prototype.forEach.call( header.children, function ( k )
            {
                if( ! k.getClientRects().length ) return;
                var pos = getComputedStyle( k ).position;
                if( pos === "absolute" || pos === "fixed" ) return;
                var r = k.getBoundingClientRect();
                if( r.width || r.height ) rs.push( r );
            } );
            if( rs.length < 2 ) return false;
            var top = rs[ 0 ];
            rs.forEach( function ( r ) { if( r.top < top.top ) top = r; } );
            return rs.some( function ( r ) { return r.top >= top.bottom - 1; } );
        }

        function fit()
        {
            if( fitting ) return;
            fitting = true;
            var all = ranked();
            all.forEach( function ( el ) { el.classList.remove( "fit-out" ); } );
            var own = ownItems().length > 0;
            btn.hidden = ! own;
            var order = all.filter( function ( el ) { return shown( el ) && ! pinned( el ); } )
                           .map( function ( el, i ) { return { el: el, r: +el.dataset.rank || 99, i: i }; } )
                           .sort( function ( a, b ) { return b.r - a.r || b.i - a.i; } );
            var n = 0;
            while( n < order.length && crowded() )
            {
                if( btn.hidden ) { btn.hidden = false; continue; }
                order[ n++ ].el.classList.add( "fit-out" );
            }
            if( ! n && ! own ) btn.hidden = true;
            lastW = header.clientWidth;
            lastH = header.offsetHeight;
            mo.takeRecords();
            fitting = false;
        }

        function later()
        {
            if( queued ) return;
            queued = true;
            requestAnimationFrame( function () { queued = false; fit(); } );
        }

        // The menu row for a hidden button: a selection action is the
        // browser's own menu row; any other copies the button.
        function itemFor( el )
        {
            var b = el.matches( "button" ) ? el : el.querySelector( "button:not([hidden])" );
            if( ! b ) return null;
            var grp = b.closest( ".sel-group" );
            if( grp && grp._nbRow && b.dataset.selAct ) return grp._nbRow( b.dataset.selAct );
            var label = ( b.getAttribute( "aria-label" ) || b.title || b.textContent || "" ).replace( /\s*[(·][^()]*\)?\s*$/, "" ).trim();
            var svg = b.querySelector( "svg" );
            var toggle = b.hasAttribute( "aria-pressed" ) || b.classList.contains( "is-active" );
            return { id: b.id || b.dataset.sel || "", label: label, icon: svg ? svg.outerHTML : "", danger: b.classList.contains( "danger" ),
                     disabled: !! b.disabled, checked: toggle ? ( b.classList.contains( "is-active" ) || b.getAttribute( "aria-pressed" ) === "true" ) : null,
                     run: function () { press( el, b ); } };
        }

        // A hidden tool runs from the ⋮: it comes back while it is in use (a
        // menu or a field it opens sits under it), until the next press elsewhere.
        function press( el, b )
        {
            el._fitPin = true;
            fit();
            b.click();
            setTimeout( function ()
            {
                document.addEventListener( "pointerdown", function free( e )
                {
                    if( el.contains( e.target ) || ( menuEl && menuEl.contains( e.target ) ) ) return;
                    document.removeEventListener( "pointerdown", free, true );
                    el._fitPin = false;
                    later();
                }, true );
            }, 0 );
        }

        function items()
        {
            var out = [], last = null;
            ranked().forEach( function ( el )
            {
                if( ! el.classList.contains( "fit-out" ) ) return;
                el.classList.remove( "fit-out" );
                var ok = el.getClientRects().length > 0 || el.closest( ".sel-group" );
                el.classList.add( "fit-out" );
                if( ! ok ) return;
                var it = itemFor( el );
                if( ! it ) return;
                var g = el.closest( ".tb-group" );
                var key = ( g && g.classList.contains( "sel-group" ) ? "s" + ( el.dataset.group || "" ) : g ) || null;
                if( last !== null && key !== last ) out.push( { sep: true } );
                last = key;
                out.push( it );
            } );
            var own = ownItems();
            if( out.length && own.length ) out.push( { sep: true } );
            return out.concat( own );
        }

        // Refit when the header changes size other than by our own fit (a
        // wider window; a status text on the left that pushed the bar down),
        // and when the buttons change: the app shows / hides one, the
        // selection group redraws, the search fold opens. A text changing
        // on the left (an upload's status) is left to the size check.
        new ResizeObserver( function ()
        {
            if( ! fitting && ( header.clientWidth !== lastW || header.offsetHeight !== lastH ) ) later();
        } ).observe( header );
        var mo = new MutationObserver( function ( recs )
        {
            if( fitting ) return;
            if( recs.some( function ( r ) { return holder.contains( r.target ) || r.target === header || ( r.type === "attributes" && r.target.parentNode === header ); } ) ) later();
        } );
        mo.observe( header, { childList: true, subtree: true, attributes: true, attributeFilter: [ "hidden", "class" ] } );
        if( document.fonts && document.fonts.ready ) document.fonts.ready.then( later );

        var api = {
            fit: fit,
            later: later,
            set: function ( o ) { for( var k in o ) if( k !== "btn" ) opts[ k ] = o[ k ]; if( o.btn ) adopt( $( o.btn ) ); fit(); },
            items: items,
            crowded: crowded,
            get button() { return btn; }
        };
        adopt( opts.btn ? $( opts.btn ) : null );
        header._fitBar = api;
        fit();
        return api;
    }

    //------------------------------------------------------------------------//
    // THE BROWSER  -  NayiveUI.browser( cfg )
    //
    //   list:    the element the rows live in (events are delegated to it)
    //   row:     selector of one row (default "[data-id]")
    //   idOf:    el => id (default el.dataset.id)
    //   bar:     the header .tb-group the selection group is drawn into
    //   actions: the action list (see the top of the file)
    //   area:    actions for empty space (no selection): New, Paste ...
    //            Select all is added at the end on its own.
    //   open:    ( id, ev ) => {}  double-click, Enter, a tap
    //   preview: ( id ) => {}      a plain click on one row (eMail's wide view)
    //   onSelect:( ids ) => {}     after every change of the selection
    //   active:  () => bool        false: the keys are not ours now (a sub-view)
    //   grid:    () => bool        rows flow in a grid (← → move too)
    //   drag:    { text: ids => "", can: () => bool }   rows drag their ids
    //   tree:    a NayiveUI.tree, for Tab between the two
    //   search:  () => {}          Ctrl+F
    //   pickable:( id ) => bool    a row that can not be picked (a header row)
    //   count:   false             no "× N" chip in the selection group (Chat)

    function browser( cfg )
    {
        var list    = $( cfg.list );
        var rowSel  = cfg.row || "[data-id]";
        var idOf    = cfg.idOf || function ( el ) { return el.dataset.id; };
        var bar     = cfg.bar ? $( cfg.bar ) : null;
        var actions = cfg.actions || [];

        var sel     = [];          // picked ids, in the order they were picked
        var anchor  = null;        // the Shift-range's fixed end
        var cursor  = null;        // the keyboard's row
        var picking = false;       // touch: ticks on, a tap adds / removes

        function rows()
        {
            return Array.prototype.slice.call( list.querySelectorAll( rowSel ) ).filter( function ( el )
            {
                return ! cfg.pickable || cfg.pickable( idOf( el ) );
            } );
        }
        function rowOf( id )
        {
            var all = rows();
            for( var i = 0; i < all.length; i++ ) if( idOf( all[ i ] ) === id ) return all[ i ];
            return null;
        }
        function idsShown() { return rows().map( idOf ); }

        //---- selection --------------------------------------------------//

        function has( id ) { return sel.indexOf( id ) >= 0; }

        function changed()
        {
            if( ! sel.length && picking ) picking = false;
            paint();
            drawBar();
            if( cfg.onSelect ) cfg.onSelect( sel.slice() );
        }

        function set( ids, keepAnchor )
        {
            sel = ( ids || [] ).filter( function ( id, i, a ) { return id != null && a.indexOf( id ) === i; } );
            if( ! keepAnchor ) anchor = sel.length ? sel[ sel.length - 1 ] : null;
            if( sel.length ) cursor = sel[ sel.length - 1 ];
            changed();
        }

        function toggle( id )
        {
            if( has( id ) ) sel.splice( sel.indexOf( id ), 1 ); else sel.push( id );
            anchor = id;
            cursor = id;
            changed();
        }

        function range( to, add )
        {
            var all = idsShown();
            var a = all.indexOf( anchor != null ? anchor : to ), b = all.indexOf( to );
            if( a < 0 ) a = b;
            var span = all.slice( Math.min( a, b ), Math.max( a, b ) + 1 );
            sel = add ? sel.concat( span.filter( function ( id ) { return ! has( id ); } ) ) : span;
            cursor = to;
            changed();
        }

        function clear()
        {
            picking = false;
            if( ! sel.length ) { paint(); drawBar(); return; }
            sel = [];
            anchor = null;
            changed();
        }

        function selectAll()
        {
            sel = idsShown();
            if( touchLike() && isPhone() ) picking = true;
            changed();
        }

        // The rows on screen changed (a re-render): forget picks that are
        // gone, put the ticks back, repaint.
        function refresh()
        {
            var shown = idsShown();
            var before = sel.length;
            sel = sel.filter( function ( id ) { return shown.indexOf( id ) >= 0; } );
            if( cursor != null && shown.indexOf( cursor ) < 0 ) cursor = null;
            if( sel.length !== before ) changed();
            else { paint(); drawBar(); }
        }

        //---- paint ------------------------------------------------------//

        var painting = false;

        function paint()
        {
            painting = true;
            list.classList.toggle( "is-picking", picking );
            list.classList.toggle( "nb-list", true );
            rows().forEach( function ( el )
            {
                var id = idOf( el );
                var on = has( id );
                el.classList.toggle( "is-selected", on );
                el.classList.toggle( "is-cursor", id === cursor );
                el.setAttribute( "aria-selected", on ? "true" : "false" );
                if( ! el.hasAttribute( "tabindex" ) ) el.tabIndex = -1;

                if( cfg.ticks !== false && ! el.querySelector( ":scope > .pick-tick, :scope > * > .pick-tick" ) )
                {
                    var tk = document.createElement( "button" );
                    tk.type = "button";
                    tk.className = "pick-tick";
                    tk.tabIndex = -1;
                    tk.setAttribute( "data-tick", "" );
                    tk.setAttribute( "aria-label", t( "ui.pick" ) );
                    tk.title = t( "ui.pick" );
                    tk.innerHTML = G.tick;
                    el.insertBefore( tk, el.firstChild );
                }
                if( cfg.drag ) el.draggable = MQ_MOUSE.matches && ( ! cfg.drag.can || cfg.drag.can( id ) );
            } );
            painting = false;
        }

        // A re-render of the list puts the ticks and classes back on its own.
        var pending = false;
        new MutationObserver( function ()
        {
            if( painting || pending ) return;
            pending = true;
            Promise.resolve().then( function () { pending = false; refresh(); } );
        } ).observe( list, { childList: true, subtree: true } );

        //---- the actions ------------------------------------------------//

        function here( a ) { return ! a.where || a.where(); }
        function enabled( a, ids ) { return !! ids.length && here( a ) && ( ! a.when || a.when( ids ) ); }
        function labelOf( a, ids ) { return typeof a.label === "function" ? a.label( ids ) : a.label; }

        function run( a, ids, e )
        {
            if( ! enabled( a, ids ) ) return;
            closeMenu();
            a.run( ids.slice(), e );
        }

        function actionItems( ids )
        {
            var list2 = actions.filter( here ).slice().sort( function ( a, b ) { return ( a.group || 0 ) - ( b.group || 0 ); } );
            var out = [], g = null;
            list2.forEach( function ( a )
            {
                if( g !== null && ( a.group || 0 ) !== g ) out.push( { sep: true } );
                g = a.group || 0;
                out.push( { id: a.id, label: labelOf( a, ids ), icon: typeof a.icon === "function" ? a.icon( ids ) : a.icon, key: a.key, danger: a.danger,
                            disabled: ! enabled( a, ids ), title: a.title ? a.title( ids ) : "",
                            run: function ( e ) { run( a, ids, e ); } } );
            } );
            return out;
        }

        function areaItems()
        {
            var out = ( cfg.area || [] ).filter( here ).map( function ( a )
            {
                return { id: a.id, label: labelOf( a, [] ), icon: a.icon, key: a.key, disabled: a.when ? ! a.when( [] ) : false,
                         run: function ( e ) { if( ! a.when || a.when( [] ) ) a.run( [], e ); } };
            } );
            if( idsShown().length )
            {
                if( out.length ) out.push( { sep: true } );
                out.push( { id: "selectAll", label: t( "ui.selectAll" ), icon: G.checkAll, key: "Ctrl+A", run: selectAll } );
            }
            return out;
        }

        // The menu on the current selection, at a point or under a button.
        function openMenu( x, y, opts )
        {
            if( ! sel.length ) return menuAt( x, y, areaItems(), opts );
            return menuAt( x, y, actionItems( sel.slice() ), opts );
        }

        //---- the header group -------------------------------------------//

        function drawBar()
        {
            if( ! bar ) return;
            var n = sel.length;
            var head = bar.closest( ".topbar, .header" ) || bar.parentNode;
            var holder = bar.closest( ".topbar-actions, .header-actions, .topbar, .header" );
            if( holder ) holder.classList.toggle( "has-selection", n > 0 );
            document.body.classList.toggle( "nb-has-selection", n > 0 );
            bar.classList.add( "sel-group" );
            var fitter = fitBar( head );
            if( ! n ) { bar.hidden = true; bar.innerHTML = ""; if( fitter ) fitter.fit(); return; }

            var ids = sel.slice();
            var html = ( cfg.count === false ? "" :
                       '<button type="button" class="icon-btn sel-count" data-sel="clear" title="' + esc( t( "ui.clearSel" ) + " (" + keyLabel( "Esc" ) + ")" ) +
                       '" aria-label="' + esc( t( "ui.clearSel" ) ) + '">' + UI.icon( "x" ) + "<span>" + n + "</span></button>" ) +
                       '<button type="button" class="icon-btn" data-sel="all" data-rank="4" title="' + esc( t( "ui.selectAll" ) + " (" + keyLabel( "Ctrl+A" ) + ")" ) +
                       '" aria-label="' + esc( t( "ui.selectAll" ) ) + '">' + G.checkAll + "</button>";
            var g = null;
            actions.map( function ( a, i ) { return { a: a, i: i }; } )
                   .filter( function ( x ) { var a = x.a; return a.id !== "open" && ! a.noBar && here( a ) && ! ( a.hideOff && ! enabled( a, ids ) ); } )
                   .sort( function ( x, y ) { return ( x.a.group || 0 ) - ( y.a.group || 0 ) || x.i - y.i; } )
                   .forEach( function ( x )
            {
                var a = x.a, l = labelOf( a, ids );
                var gap = g !== null && ( a.group || 0 ) !== g;
                g = a.group || 0;
                html += '<button type="button" class="icon-btn' + ( a.danger ? " danger" : "" ) + ( gap ? " sel-gap" : "" ) + '" data-sel-act="' + esc( a.id ) +
                        '" data-rank="' + ( a.rank || 40 + x.i ) + '" data-group="' + g +
                        '" title="' + esc( l + ( a.key ? " (" + keyLabel( a.key ) + ")" : "" ) ) + '" aria-label="' + esc( l ) + '"' +
                        ( enabled( a, ids ) ? "" : " disabled" ) + ">" + glyph( typeof a.icon === "function" ? a.icon( ids ) : a.icon ) + "</button>";
            } );
            bar.innerHTML = html;
            bar.hidden = false;
            if( fitter ) fitter.fit();
        }

        // The ⋮'s row for a selection button that did not fit.
        if( bar ) bar._nbRow = function ( id )
        {
            return actionItems( sel.slice() ).filter( function ( it ) { return it.id === id; } )[ 0 ] || null;
        };

        if( bar ) bar.addEventListener( "click", function ( e )
        {
            var b = e.target.closest( "button" );
            if( ! b || b.disabled ) return;
            if( b.dataset.sel === "clear" ) clear();
            else if( b.dataset.sel === "all" ) selectAll();
            else if( b.dataset.selAct )
            {
                var a = actions.filter( function ( x ) { return x.id === b.dataset.selAct; } )[ 0 ];
                if( a ) run( a, sel.slice(), e );
            }
        } );

        //---- pointer ----------------------------------------------------//

        function off() { return !! ( cfg.active && ! cfg.active() ); }

        function rowFrom( e )
        {
            if( off() ) return null;
            var el = e.target.closest && e.target.closest( rowSel );
            if( ! el || ! list.contains( el ) ) return null;
            if( cfg.pickable && ! cfg.pickable( idOf( el ) ) ) return null;
            return el;
        }

        // A button / link / field inside a row does its own job (a tag chip,
        // a star, a play button): the browser leaves that click alone.
        function ownControl( e, el )
        {
            var c = e.target.closest( "button, a[href], input, select, textarea, label, [data-no-pick]" );
            return !! c && el.contains( c ) && c !== el && ! c.hasAttribute( "data-tick" );
        }

        list.addEventListener( "mousedown", function ( e )
        {
            // The second press of a double-click must not start a word selection.
            if( e.detail > 1 && rowFrom( e ) ) e.preventDefault();
            // Shift+click: no text selection either.
            if( e.shiftKey && rowFrom( e ) ) e.preventDefault();
        } );

        list.addEventListener( "click", function ( e )
        {
            if( off() ) return;
            var el = rowFrom( e );
            if( ! el )
            {
                // Empty space, with a mouse: clears. (A finger's stray tap
                // between rows does nothing.)
                if( ! touchLike() && list.contains( e.target ) && ! e.target.closest( "button, a, input, select, textarea, label" ) && sel.length ) clear();
                return;
            }
            var id = idOf( el );

            if( e.target.closest( "[data-tick]" ) )
            {
                e.preventDefault();
                if( touchLike() ) picking = true;
                toggle( id );
                return;
            }
            if( ownControl( e, el ) ) return;

            if( touchLike() )
            {
                if( picking ) { toggle( id ); return; }
                if( sel.length ) { sel = []; anchor = null; changed(); }
                cursor = id;
                if( cfg.open ) cfg.open( id, e );
                return;
            }

            var mod = UI.isMac ? e.metaKey : e.ctrlKey;
            if( e.shiftKey ) range( id, mod );
            else if( mod ) toggle( id );
            else
            {
                set( [ id ] );
                if( cfg.preview ) cfg.preview( id, e );
            }
        } );

        list.addEventListener( "dblclick", function ( e )
        {
            var el = rowFrom( e );
            if( ! el || touchLike() || ownControl( e, el ) || e.target.closest( "[data-tick]" ) ) return;
            e.preventDefault();
            var s = window.getSelection();
            if( s ) s.removeAllRanges();
            if( cfg.open ) cfg.open( idOf( el ), e );
        } );

        // Middle click: open, as a link would (Bookmarks opens a new tab).
        list.addEventListener( "auxclick", function ( e )
        {
            if( e.button !== 1 || ! cfg.openMiddle ) return;
            var el = rowFrom( e );
            if( el ) { e.preventDefault(); cfg.openMiddle( idOf( el ), e ); }
        } );

        list.addEventListener( "contextmenu", function ( e )
        {
            if( cfg.contextmenu === false || off() ) return;
            if( e.target.closest( "input, textarea" ) ) return;
            var el = rowFrom( e );
            if( touchLike() && el ) { e.preventDefault(); return; }    // a finger uses the long-press
            e.preventDefault();
            if( el )
            {
                var id = idOf( el );
                if( ! has( id ) ) set( [ id ] );
                cursor = id;
                paint();
            }
            else if( sel.length && ! touchLike() ) clear();
            openMenu( e.clientX, e.clientY );
        } );

        longPress( list, rowSel, function ( el )
        {
            var id = idOf( el );
            if( cfg.pickable && ! cfg.pickable( id ) ) return;
            picking = true;
            if( ! has( id ) ) { sel.push( id ); anchor = id; }
            cursor = id;
            changed();
        } );

        if( cfg.drag )
        {
            list.addEventListener( "dragstart", function ( e )
            {
                var el = rowFrom( e );
                if( ! el ) return;
                var id = idOf( el );
                var ids = has( id ) ? sel.slice() : [ id ];
                startDrag( e, ids, cfg.drag.text ? cfg.drag.text( ids ) : "", api );
                ids.forEach( function ( x ) { var r = rowOf( x ); if( r ) r.classList.add( "dragging" ); } );
            } );
        }

        //---- keys -------------------------------------------------------//

        function ours()
        {
            if( cfg.active && ! cfg.active() ) return false;
            if( dialogOpen() || menuOpen() ) return false;
            var a = document.activeElement;
            if( inTextField( a ) ) return false;
            if( cfg.tree && cfg.tree.host.contains( a ) ) return false;
            // A focused control outside the list (a header button) still
            // lets the list's keys through, except Enter / Space on it.
            return true;
        }

        function focusRow( id, scroll )
        {
            cursor = id;
            var el = rowOf( id );
            paint();
            if( ! el ) return;
            el.focus( { preventScroll: true } );
            if( scroll !== false ) el.scrollIntoView( { block: "nearest", inline: "nearest" } );
        }

        // The row next to `from` in a direction; in a grid, by geometry.
        function neighbour( from, key )
        {
            var all = rows();
            if( ! all.length ) return null;
            var i = from != null ? all.map( idOf ).indexOf( from ) : -1;
            if( key === "Home" ) return idOf( all[ 0 ] );
            if( key === "End" ) return idOf( all[ all.length - 1 ] );
            if( i < 0 ) return idOf( all[ 0 ] );
            var grid = cfg.grid && cfg.grid();
            if( ! grid || key === "ArrowLeft" || key === "ArrowRight" )
            {
                var d = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
                var j = Math.max( 0, Math.min( all.length - 1, i + d ) );
                return idOf( all[ j ] );
            }
            var me = all[ i ].getBoundingClientRect();
            var cx = me.left + me.width / 2;
            var down = key === "ArrowDown";
            var best = null, bestScore = Infinity;
            all.forEach( function ( el )
            {
                var r = el.getBoundingClientRect();
                var dy = down ? r.top - me.bottom : me.top - r.bottom;
                if( dy < -2 ) return;
                var score = dy * 1000 + Math.abs( r.left + r.width / 2 - cx );
                if( score < bestScore ) { bestScore = score; best = el; }
            } );
            return best ? idOf( best ) : idOf( all[ i ] );
        }

        function onKey( e )
        {
            if( e.defaultPrevented || ! ours() ) return;
            var mod = UI.isMac ? e.metaKey : e.ctrlKey;
            var k = e.key;
            var focusInList = list.contains( document.activeElement );
            var onButton = ! focusInList && document.activeElement && document.activeElement.closest &&
                           document.activeElement.closest( "button, a" );

            if( k === "Escape" )
            {
                if( escHadDialog || ( ! sel.length && ! picking ) ) return;
                e.preventDefault();
                clear();
                return;
            }
            if( mod && ! e.shiftKey && ! e.altKey && keyOf( e ) === "a" )
            {
                if( ! idsShown().length ) return;
                e.preventDefault();
                selectAll();
                return;
            }
            if( mod && ! e.shiftKey && ! e.altKey && keyOf( e ) === "f" && cfg.search )
            {
                e.preventDefault();
                cfg.search();
                return;
            }
            if( k === "ArrowLeft" && ! mod && ! e.altKey && ! e.shiftKey && cfg.tree && focusInList && ! ( cfg.grid && cfg.grid() ) )
            {
                e.preventDefault();
                cfg.tree.focus();
                return;
            }
            if( k === "Tab" && ! mod && ! e.altKey && cfg.tree && focusInList )
            {
                e.preventDefault();
                cfg.tree.focus();
                return;
            }

            if( ( k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End" ||
                ( cfg.grid && cfg.grid() && ( k === "ArrowLeft" || k === "ArrowRight" ) ) ) && ! e.altKey )
            {
                if( onButton && ( k === "Home" || k === "End" ) ) return;
                var to = neighbour( cursor != null ? cursor : ( sel.length ? sel[ sel.length - 1 ] : null ), k );
                if( to == null ) return;
                e.preventDefault();
                if( e.shiftKey ) { if( anchor == null ) anchor = cursor != null ? cursor : to; range( to, false ); focusRow( to ); }
                else if( mod ) focusRow( to );
                else { set( [ to ] ); focusRow( to ); if( cfg.preview ) cfg.preview( to, e ); }
                return;
            }
            if( k === " " && ! mod && focusInList && cursor != null )
            {
                e.preventDefault();
                toggle( cursor );
                return;
            }
            if( k === "Enter" && ! mod && ! e.shiftKey && ! e.altKey && ( focusInList || ! onButton ) )
            {
                var target = cursor != null && ( has( cursor ) || ! sel.length ) ? cursor : ( sel.length === 1 ? sel[ 0 ] : null );
                if( target == null || ! cfg.open ) return;
                e.preventDefault();
                cfg.open( target, e );
                return;
            }
            if( k === "ContextMenu" || ( k === "F10" && e.shiftKey ) )
            {
                e.preventDefault();
                var r = cursor != null && rowOf( cursor ) ? rowOf( cursor ).getBoundingClientRect() : list.getBoundingClientRect();
                openMenu( r.left + 24, r.top + Math.min( r.height, 24 ), { keyboard: true } );
                return;
            }

            // The actions' own keys: on the selection; the area's (Paste,
            // New) work with nothing picked.
            var ids = sel.slice();
            for( var i = 0; i < actions.length; i++ )
            {
                var a = actions[ i ];
                if( a.key && here( a ) && keyMatches( a.key, e ) )
                {
                    if( ! enabled( a, ids ) ) return;
                    e.preventDefault();
                    run( a, ids, e );
                    return;
                }
            }
            var area = cfg.area || [];
            for( var j = 0; j < area.length; j++ )
            {
                var b = area[ j ];
                if( b.key && here( b ) && keyMatches( b.key, e ) )
                {
                    if( b.when && ! b.when( [] ) ) return;
                    e.preventDefault();
                    b.run( [], e );
                    return;
                }
            }
        }
        document.addEventListener( "keydown", onKey );

        //---- the api ----------------------------------------------------//

        var api = {
            ids:       function () { return sel.slice(); },
            has:       has,
            set:       function ( ids, pick ) { if( pick ) picking = true; set( ids ); },   // pick: touch picking on (ticks)
            clear:     clear,
            selectAll: selectAll,
            toggle:    toggle,
            refresh:   refresh,             // after the rows changed (also automatic)
            redraw:    function () { paint(); drawBar(); },   // after the app's state changed (an action's `when`)
            focus:     function ( id ) { if( id == null ) id = cursor != null ? cursor : ( sel[ 0 ] != null ? sel[ 0 ] : neighbour( null, "Home" ) ); if( id != null ) focusRow( id ); },
            menu:      openMenu,
            picking:   function () { return picking; },
            actions:   function () { return actions; },
            setActions: function ( list2 ) { actions = list2 || []; drawBar(); },
            run:       function ( id, ids ) { var a = actions.filter( function ( x ) { return x.id === id; } )[ 0 ]; if( a ) run( a, ids || sel.slice() ); },
            items:     actionItems,         // the menu rows for these ids (the tree's folder menu)
            list:      list
        };
        if( cfg.tree ) cfg.tree.peer = api;
        refresh();
        return api;
    }

    //------------------------------------------------------------------------//
    // THE TREE  -  NayiveUI.tree( cfg )
    //
    //   host:     where the rows go (a flat column of .tree-row buttons)
    //   roots:    () => [ node ]   node = { id, name, icon, kids: [node], badge,
    //                                       title, cls, noMenu, noDrag,
    //                                       group (a heading: a click only opens / closes it) }
    //   isOpen:   id => bool,  setOpen: ( id, bool ) => {}   (the app keeps it)
    //   current:  () => id         the lit row (the open folder / tray)
    //   go:       ( id, e ) => {}  a click: open that folder
    //   menu:     ( id, x, y, anchor ) => {}   right-click, long-press, the
    //             ContextMenu key (no menu: leave it out). Tree rows have no ⋮.
    //   drop:     { can, drop }    see dropZone: items dropped on a folder
    //   drag:     id => ids | null   a tree row dragged (a folder moves)
    //   pane:     the pane element that becomes a slide-in sheet on a phone
    //   pick:     true: a picker (Move to…): a click lights the row, a
    //             double-click / Enter confirms (cfg.confirm)
    //   disabled: id => bool       a row that can not be picked (a folder into itself)
    //
    // The arrow opens and closes; a click opens the folder. Keys as in a file
    // tree: ↑ ↓ move, → opens (then steps in), ← closes (then steps up),
    // Home / End, Enter opens; Tab goes back to the list.

    function tree( cfg )
    {
        var host = $( cfg.host );
        host.classList.add( "ntree" );
        host.setAttribute( "role", "tree" );
        var kbd = null;           // the keyboard's row (pick mode: the lit one)
        var parentOf = {};
        var nodeOf = {};

        function render()
        {
            var cur = cfg.current ? cfg.current() : null;
            var html = "";
            parentOf = {};
            nodeOf = {};
            ( function walk( nodes, depth, parent )
            {
                ( nodes || [] ).forEach( function ( n )
                {
                    nodeOf[ n.id ] = n;
                    parentOf[ n.id ] = parent;
                    var kids = n.kids && n.kids.length;
                    var open = kids && cfg.isOpen( n.id );
                    var off = cfg.disabled && cfg.disabled( n.id );
                    html += '<div class="tree-row' + ( n.id === cur ? " is-active" : "" ) + ( open ? " is-open" : "" ) +
                            ( off ? " is-off" : "" ) + ( n.id === kbd ? " is-kbd" : "" ) + ( n.cls ? " " + n.cls : "" ) +
                            '" role="treeitem" tabindex="' + ( n.id === ( kbd != null ? kbd : cur ) ? 0 : -1 ) + '" data-id="' + esc( n.id ) + '"' +
                            ( kids ? ' aria-expanded="' + ( open ? "true" : "false" ) + '"' : "" ) +
                            ( n.id === cur ? ' aria-current="true"' : "" ) +
                            ( off ? ' aria-disabled="true"' : "" ) +
                            ' style="--depth:' + depth + '"' + ( n.title ? ' title="' + esc( n.title ) + '"' : "" ) + ">" +
                            '<span class="twisty' + ( kids ? "" : " leaf" ) + '" data-twisty>' + G.chevron + "</span>" +
                            '<span class="tree-ic">' + glyph( n.icon || "folder" ) + "</span>" +
                            '<span class="tree-name">' + esc( n.name ) + "</span>" +
                            ( n.badge ? '<span class="tree-badge">' + esc( n.badge ) + "</span>" : "" ) +
                            "</div>";
                    if( open ) walk( n.kids, depth + 1, n.id );
                } );
            } )( cfg.roots(), 0, null );
            var had = host.contains( document.activeElement );
            host.innerHTML = html;
            if( MQ_MOUSE.matches && cfg.drag )
                host.querySelectorAll( ".tree-row" ).forEach( function ( r )
                {
                    var n = nodeOf[ r.dataset.id ];
                    r.draggable = !! ( n && ! n.noDrag && cfg.drag( r.dataset.id ) );
                } );
            if( had ) focus( kbd );
        }

        function rowEl( id ) { return host.querySelector( '.tree-row[data-id="' + CSS.escape( String( id ) ) + '"]' ); }

        function focus( id )
        {
            if( id == null ) id = kbd != null && rowEl( kbd ) ? kbd : ( cfg.current ? cfg.current() : null );
            var el = id != null ? rowEl( id ) : null;
            if( ! el ) el = host.querySelector( ".tree-row" );
            if( ! el ) return;
            kbd = el.dataset.id;
            host.querySelectorAll( ".tree-row" ).forEach( function ( r ) { r.tabIndex = r === el ? 0 : -1; r.classList.toggle( "is-kbd", r === el ); } );
            el.focus( { preventScroll: true } );
            el.scrollIntoView( { block: "nearest" } );
        }

        function toggleOpen( id, want )
        {
            var n = nodeOf[ id ];
            if( ! n || ! ( n.kids && n.kids.length ) ) return;
            var open = cfg.isOpen( id );
            if( want == null ) want = ! open;
            if( want === open ) return;
            cfg.setOpen( id, want );
            render();
        }

        function choose( id, e )
        {
            if( cfg.disabled && cfg.disabled( id ) ) return;
            // A heading node ("Labels") only opens and closes.
            if( nodeOf[ id ] && nodeOf[ id ].group && ! cfg.pick ) { toggleOpen( id ); focus( id ); return; }
            if( cfg.pick ) { kbd = id; if( cfg.go ) cfg.go( id, e ); render(); return; }
            if( cfg.go ) cfg.go( id, e );
            if( cfg.pane && isPhone() ) closeSheet();
        }

        host.addEventListener( "click", function ( e )
        {
            var row = e.target.closest( ".tree-row" );
            if( ! row ) return;
            var id = row.dataset.id;
            if( e.target.closest( "[data-twisty]" ) ) { toggleOpen( id ); kbd = id; focus( id ); return; }
            kbd = id;
            choose( id, e );
        } );
        host.addEventListener( "dblclick", function ( e )
        {
            var row = e.target.closest( ".tree-row" );
            if( ! row || e.target.closest( "[data-twisty]" ) ) return;
            if( cfg.pick ) { if( ! ( cfg.disabled && cfg.disabled( row.dataset.id ) ) && cfg.confirm ) cfg.confirm( row.dataset.id ); return; }
            toggleOpen( row.dataset.id );
        } );
        host.addEventListener( "contextmenu", function ( e )
        {
            var row = e.target.closest( ".tree-row" );
            if( ! row || ! cfg.menu || cfg.pick ) return;
            e.preventDefault();
            if( touchLike() ) return;                  // the long-press does it
            var n = nodeOf[ row.dataset.id ];
            if( n && n.noMenu ) return;
            cfg.menu( row.dataset.id, e.clientX, e.clientY, null );
        } );
        if( cfg.menu && ! cfg.pick )
            longPress( host, ".tree-row", function ( el, x, y )
            {
                var n = nodeOf[ el.dataset.id ];
                if( n && ! n.noMenu ) cfg.menu( el.dataset.id, x, y, null );
            } );

        host.addEventListener( "keydown", function ( e )
        {
            var row = e.target.closest( ".tree-row" );
            if( ! row || e.altKey || e.ctrlKey || e.metaKey ) return;
            var all = Array.prototype.slice.call( host.querySelectorAll( ".tree-row" ) );
            var i = all.indexOf( row ), id = row.dataset.id;
            var n = nodeOf[ id ], kids = n && n.kids && n.kids.length;
            var open = kids && cfg.isOpen( id );
            switch( e.key )
            {
                case "ArrowDown": if( all[ i + 1 ] ) focus( all[ i + 1 ].dataset.id ); break;
                case "ArrowUp":   if( all[ i - 1 ] ) focus( all[ i - 1 ].dataset.id ); break;
                case "Home":      focus( all[ 0 ].dataset.id ); break;
                case "End":       focus( all[ all.length - 1 ].dataset.id ); break;
                case "ArrowRight":
                    if( ! kids ) break;
                    if( open ) focus( n.kids[ 0 ].id ); else { toggleOpen( id, true ); focus( id ); }
                    break;
                case "ArrowLeft":
                    if( open ) { toggleOpen( id, false ); focus( id ); }
                    else if( parentOf[ id ] != null ) focus( parentOf[ id ] );
                    break;
                case "Enter":
                    if( cfg.pick && cfg.confirm ) { if( ! ( cfg.disabled && cfg.disabled( id ) ) ) cfg.confirm( id ); }
                    else choose( id, e );
                    break;
                case " ":
                    choose( id, e );
                    break;
                case "Tab":
                    if( ! api.peer || e.shiftKey ) return;
                    api.peer.focus();
                    if( host.contains( document.activeElement ) ) return;   // no row took it (empty list): the browser's Tab goes on
                    break;
                case "ContextMenu":
                    if( ! cfg.menu || cfg.pick || ( n && n.noMenu ) ) return;
                    var r = row.getBoundingClientRect();
                    cfg.menu( id, r.left + 24, r.bottom, null );
                    break;
                default: return;
            }
            e.preventDefault();
        } );

        if( cfg.drag )
            host.addEventListener( "dragstart", function ( e )
            {
                var row = e.target.closest && e.target.closest( ".tree-row" );
                if( ! row ) return;
                var ids = cfg.drag( row.dataset.id );
                if( ! ids ) { e.preventDefault(); return; }
                startDrag( e, ids, nodeOf[ row.dataset.id ] ? nodeOf[ row.dataset.id ].name : "", null );
                row.classList.add( "dragging" );
            } );

        if( cfg.drop )
            dropZone( host, { sel: ".tree-row", target: function ( el ) { return el.dataset.id; },
                              can: cfg.drop.can, drop: cfg.drop.drop, copy: cfg.drop.copy } );

        //---- the phone sheet --------------------------------------------//

        var back = null;
        function openSheet()
        {
            if( ! cfg.pane ) return;
            if( ! back )
            {
                back = document.createElement( "div" );
                back.className = "tree-backdrop";
                back.addEventListener( "click", closeSheet );
                cfg.pane.parentNode.insertBefore( back, cfg.pane );
            }
            cfg.pane.classList.add( "tree-sheet", "open" );
            back.classList.add( "open" );
            render();
            focus();
        }
        function closeSheet()
        {
            if( ! cfg.pane ) return;
            cfg.pane.classList.remove( "open" );
            if( back ) back.classList.remove( "open" );
        }
        if( cfg.pane )
        {
            cfg.pane.classList.add( "tree-sheet" );
            document.addEventListener( "keydown", function ( e )
            {
                if( e.key === "Escape" && cfg.pane.classList.contains( "open" ) && isPhone() && ! dialogOpen() )
                {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    closeSheet();
                }
            }, true );
        }

        var api = {
            host: host,
            render: render,
            focus: focus,
            openSheet: openSheet,
            closeSheet: closeSheet,
            toggle: toggleOpen,
            lit: function () { return kbd; },
            node: function ( id ) { return nodeOf[ id ] || null; },
            peer: null                       // the list's browser: Tab goes there
        };
        render();
        return api;
    }

    //------------------------------------------------------------------------//
    // "MOVE TO…"  -  NayiveUI.pickNode( cfg ) -> Promise( id | null )
    //
    //   title, roots, current (where they are now: lit first), disabled( id ),
    //   lit (the folder lit at first; default `current`, null: none),
    //   okLabel, note (a line under the title; a function: lit id -> text,
    //   asked again on each pick). The dialog keeps its own open folders,
    //   opened down to `current`.
    // The same tree as the side pane, in a dialog. Click lights a folder,
    // double-click / Enter / ✓ picks it.

    function pickNode( cfg )
    {
        return new Promise( function ( resolve )
        {
            var open = {};
            var lit = "lit" in cfg ? cfg.lit : ( cfg.current != null ? cfg.current : null );
            var d = UI.modal( { title: cfg.title, cls: "pick-node-sheet", escape: function () { finish( null ); } } );
            var done = false;
            function finish( v )
            {
                if( done ) return;
                done = true;
                d.close();
                resolve( v );
            }

            // Open every folder down to the one they are in.
            ( function walk( nodes, trail )
            {
                ( nodes || [] ).forEach( function ( n )
                {
                    if( n.id === cfg.current ) trail.forEach( function ( p ) { open[ p ] = true; } );
                    if( n.kids ) walk( n.kids, trail.concat( n.id ) );
                } );
            } )( cfg.roots(), [] );
            ( cfg.roots() || [] ).forEach( function ( n ) { if( cfg.openRoots !== false ) open[ n.id ] = true; } );

            var noteEl = null;
            if( cfg.note )
            {
                noteEl = document.createElement( "p" );
                noteEl.className = "dialog-text";
                d.sheet.appendChild( noteEl );
            }
            var box = document.createElement( "div" );
            box.className = "pick-tree";
            d.sheet.appendChild( box );

            var row = document.createElement( "div" );
            row.className = "sheet-actions";
            var cancel = document.createElement( "button" );
            cancel.className = "pick-cancel";
            cancel.setAttribute( "data-act", "close" );
            cancel.title = t( "ui.cancel" );
            cancel.addEventListener( "click", function () { finish( null ); } );
            var ok = document.createElement( "button" );
            ok.className = "pick-ok";
            ok.setAttribute( "data-act", "primary" );
            ok.title = cfg.okLabel || t( "ui.moveHere" );
            ok.addEventListener( "click", function () { if( lit != null && ! bad( lit ) ) finish( lit ); } );
            row.appendChild( cancel );
            row.appendChild( ok );
            d.sheet.appendChild( row );
            UI.applySheetButtons( d.sheet );

            function bad( id ) { return !! ( cfg.disabled && cfg.disabled( id ) ); }
            function sync()
            {
                ok.disabled = lit == null || bad( lit );
                if( noteEl ) noteEl.textContent = typeof cfg.note === "function" ? cfg.note( lit != null && ! bad( lit ) ? lit : null ) : cfg.note;
            }

            d.show();
            var tr = tree( {
                host: box, pick: true,
                roots: cfg.roots,
                isOpen: function ( id ) { return !! open[ id ]; },
                setOpen: function ( id, v ) { open[ id ] = v; },
                current: function () { return lit; },
                disabled: bad,
                go: function ( id ) { lit = id; sync(); },
                confirm: function ( id ) { lit = id; finish( id ); }
            } );
            sync();
            tr.focus( lit != null ? lit : cfg.current );
        } );
    }

    //------------------------------------------------------------------------//

    UI.browser   = browser;
    UI.tree      = tree;
    UI.pickNode  = pickNode;
    UI.fitBar    = fitBar;
    UI.menuAt    = menuAt;
    UI.closeMenu = closeMenu;
    UI.menuOpen  = menuOpen;
    UI.longPress = longPress;
    UI.dropZone  = dropZone;
    UI.keyLabel  = keyLabel;
    UI.keyMatches = keyMatches;
    UI.glyph     = glyph;
    UI.tickHtml  = function () { return '<button type="button" class="pick-tick" data-tick tabindex="-1" title="' + esc( t( "ui.pick" ) ) + '" aria-label="' + esc( t( "ui.pick" ) ) + '">' + G.tick + "</button>"; };
    UI.isTouch   = touchLike;
    UI.dragIds   = function () { return drag.ids; };
} )();
