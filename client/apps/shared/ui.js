/*
 * ui.js - Tiny UI helpers every Nayive app kept its own copy of.
 *
 * Classic script, one global `NayiveUI`. Its only dependency is
 * shared/i18n.js, which every page loads first (see docs/i18n.md). Load ui.js
 * before the app's own script:
 *     <script src="../shared/i18n.js"></script>
 *     <script src="../shared/ui.js" defer></script>
 *
 * NO interface string lives here either: NayiveUI.t / .tf re-export the engine
 * in shared/i18n.js, and every message is a `ui.*` / `share.*` key in
 * shared/i18n/*.json. Because ui.js is deferred, an app's inline script must
 * not call NayiveUI while it is being parsed - wrap the call in a function.
 *
 * Deliberately small - just the bits that were byte-identical across apps:
 *   - backdrop / sheet / popup open-close (the `.open` class dance)
 *   - the bottom-centre transient toast (paired CSS is in shared/theme.css)
 *   - the viewer's IANA time zone
 *   - the interface language, re-exported from shared/i18n.js: t / tf /
 *     applyI18n / i18nReady / lang / saved / locale / weekday / month / setLang
 *   - dialog action buttons: the one Nayive style (see Calendar -> "Ir a mes").
 *   - the info dot: a circled "i" by a label that opens a small popup
 *     (NayiveUI.applyInfoDots; paired CSS .info-dot / .info-popup in app.css).
 *   - movable dialogs: drag any open .sheet from a free spot (see MOVABLE
 *     DIALOGS below). Wired once for the whole page, no per-dialog code.
 *   - embedded mode: when the page runs inside another Nayive page's <iframe>
 *     (Planner frames calendar + tasks + habits) the <html> gets .is-embedded, app.css
 *     hides the app's own title / sync dot (the host shows them once), and
 *     anything that must leave the frame (home link, sign-in) navigates the TOP
 *     window. NayiveUI.embedded tells an app which case it is in. When the host
 *     window is wider than a phone the <html> also gets .is-embedded-wide and
 *     the app's own icon stays on, labelling its pane in Planner's split view.
 *
 * Per-app UI that only looked similar (calendar's named close* handlers,
 * contact's flashUndo) was left where it is.
 *
 * ---------------------------------------------------------------------------
 * DIALOG ACTION BUTTONS
 *
 * The Nayive convention for a dialog's bottom action row is a right-aligned line
 * of round, icon-only buttons: a card-coloured "close" (X) and an accent
 * "primary" (check), plus optional "danger" (trash) and "ghost" (help) roles.
 * The shape lives in shared/theme.css (.sheet-actions / .btn / .btn-*).
 *
 * Write the buttons with a `data-act` attribute instead of a class + inline SVG:
 *
 *     <div class="sheet-actions">
 *       <button id="fooCancel"  data-act="close"   title="Cancelar"></button>
 *       <button id="fooConfirm" data-act="primary" title="Guardar"></button>
 *     </div>
 *
 * `data-act` = `role[:icon]`. Roles: close | primary | secondary | danger |
 * ghost. Override the icon with e.g. `data-act="primary:search"`. On load this
 * fills in the class + SVG (IDs and event listeners are untouched). Apps that
 * build dialogs dynamically call NayiveUI.applySheetButtons( sheetEl ) after.
 *
 * UIX rule: when a dialog's whole action row is just a "close" button, that
 * button is moved to the sheet's top-right corner (class `.sheet-close`, styled
 * in shared/theme.css) and the empty row is dropped - a bottom row is only for
 * dialogs that also have a primary / danger action.
 *
 * ---------------------------------------------------------------------------
 * THE ONE ICON PER MEANING RULE  (whole Nayive UI, dialogs and toolbars alike)
 *
 *   - "check"  = confirm / apply / commit. ALWAYS this glyph, whatever the verb:
 *                Guardar, Renombrar, Crear, Aplicar, Fusionar, Ir... If a button
 *                means "yes, do the thing I set up", it is the check. No
 *                exceptions inside that meaning - no diskette, no "OK" text.
 *   - "saveas" = save the current thing as a NEW named copy: the check with a
 *                small + centred near the top edge. Used by calc / write / text
 *                "Guardar como" and the launcher's "Guardar como esquema nuevo".
 *                Nothing else.
 *   - "trash" (danger role) = a destructive confirm (Eliminar / Quitar). Kept
 *                visually distinct on purpose - a delete that looks like a save
 *                is a footgun.
 *
 * The check is NOT used for buttons that are a different verb than "confirm":
 *   - "edit"   (Contact "Editar")  - opens a form, changes nothing yet.
 *   - "search" (Calendar "Buscar") - runs a query, changes nothing.
 *   - "plus" / nested-plus (Tasks "Anadir") - an always-on compose bar whose
 *     icon shows the mode.
 * ...and it cannot be used when a dialog offers 2+ affirmative choices (Drive
 * "abrir con Calc / Write", "subir archivos / carpeta") - there the icon has to
 * tell the options apart.
 */
( function ()
{
    "use strict";

    function byId( id ) { return document.getElementById( id ); }

    // EMBEDDED  - are we inside another page's <iframe>? (Planner frames
    // calendar + tasks.) Stamped on <html> at once so app.css can hide the
    // framed app's own title and sync dot - the host shows them once for
    // both frames. A cross-origin `top` throws: treat that as framed too.
    var EMBEDDED = false;
    try { EMBEDDED = ( window.self !== window.top ); } catch ( e ) { EMBEDDED = true; }
    if( EMBEDDED ) { try { document.documentElement.classList.add( "is-embedded" ); } catch ( e ) {} }

    // ...and is the HOST window wide enough to show every pane at once? Planner's
    // PC / tablet layout puts calendar + tasks + habits side by side, and each of
    // those panes gets its own app icon back (app.css) so a glance tells which
    // area is which. On a phone Planner shows ONE pane at a time, picked with
    // three icon buttons in its header, so a second copy of the same icon inside
    // the pane would just be noise - hence the extra class, not a plain
    // .is-embedded rule. The width to test is the TOP window's (same 640px
    // breakpoint Planner uses): our own frame is only a slice of it, and a 25%-
    // wide pane on a desktop is narrower than a phone.
    if( EMBEDDED ) try
    {
        var wide = window.top.matchMedia( "(min-width: 641px)" );

        var syncWide = function ()
        {
            try { document.documentElement.classList.toggle( "is-embedded-wide", wide.matches ); } catch ( e ) {}
        };

        syncWide();
        wide.addEventListener( "change", syncWide );
        // the listener lives on the HOST's MediaQueryList, which outlives this
        // document - drop it when the frame navigates away
        window.addEventListener( "pagehide", function () { wide.removeEventListener( "change", syncWide ); } );
    }
    catch ( e ) {}

    // The window that owns the address bar: `top` while we are framed by a
    // same-origin page (Planner), ourselves otherwise. Navigating THIS one is
    // what makes "go home" / "go to login" leave the frame instead of loading
    // the launcher or the sign-in form inside a 25%-wide pane.
    function navWindow()
    {
        try { if( EMBEDDED && window.top.location.pathname ) return window.top; } catch ( e ) {}
        return window;
    }

    // Toggle an element's ".open" class (backdrops, sheets, popups). When a sheet
    // is opened, size it to its content if it (or the sheet inside it) asked for
    // it with .sheet--pack (see packSheet).
    function setOpen( id, open )
    {
        var el = byId( id );
        if( ! el ) return;

        el.classList.toggle( "open", !! open );

        if( open )
        {
            var s = el.classList.contains( "sheet" ) ? el : el.querySelector( ".sheet" );
            if( s && s.classList.contains( "sheet--pack" ) ) packSheet( s );
        }
    }

    function open( id )  { setOpen( id, true ); }
    function close( id ) { setOpen( id, false ); }

    // Java-Swing-style pack(): shrink a dialog to the width its content actually
    // needs instead of always sitting at the CSS max-width. Height already
    // self-fits (.sheet has max-height + internal scroll), so this only touches
    // width. The natural width is clamped to [min, max] and to what fits on
    // screen. Safe to call on every open - it recomputes from scratch.
    //
    //   <div class="sheet sheet--pack"> ...      -> packed automatically on open
    //   NayiveUI.pack( sheetEl, { min: 320, max: 440 } )   -> manual, custom bounds
    //
    // `target` may be the .sheet, the .sheet-backdrop around it, or either's id.
    function packSheet( target, opts )
    {
        var el = ( typeof target === "string" ) ? byId( target ) : target;
        if( ! el ) return;

        var sheet = el.classList.contains( "sheet" ) ? el : el.querySelector( ".sheet" );
        if( ! sheet ) return;

        opts = opts || {};
        var min = opts.min || 300;
        var max = opts.max || 460;

        // Measure at natural width: drop every width constraint, read, restore.
        var saved = { w: sheet.style.width, min: sheet.style.minWidth, max: sheet.style.maxWidth };
        sheet.style.width    = "max-content";
        sheet.style.minWidth = "0";
        sheet.style.maxWidth = "none";

        var natural = Math.ceil( sheet.getBoundingClientRect().width );

        sheet.style.width    = saved.w;
        sheet.style.minWidth = saved.min;
        sheet.style.maxWidth = saved.max;

        var host  = sheet.parentElement;
        var avail = ( ( host && host.clientWidth ) || window.innerWidth ) - 32;   // backdrop padding

        var w = Math.min( max, Math.max( min, natural ) );
        if( w > avail ) w = avail;

        sheet.style.width    = w + "px";
        sheet.style.minWidth = w + "px";   // beat the .sheet--pack fallback min-width
        sheet.style.maxWidth = w + "px";
    }

    /* -------------------------------------------------------------------------
     * MOVABLE DIALOGS
     *
     * Every open .sheet can be pushed around the screen: press on any free spot
     * of the dialog and drag. There is no grip to aim at - the dialog itself is
     * the handle - so nothing is drawn for this; the only hint is the "held"
     * cursor once a drag is under way.
     *
     * How: the backdrop centres the sheet with flexbox, so rather than fight it
     * with left/top the sheet gets a `transform: translate(dx, dy)`. The centred
     * spot stays the origin, the packed width (packSheet) and the sheet's own
     * scrolling are untouched, and going back to the middle is just dropping the
     * transform.
     *
     * The rules that keep it out of the way:
     *   - phones (<= 640px) never move a dialog: it is nearly full width there
     *     and a stray finger must not drag it off.
     *   - a press on a control (button, field, link, map...) is left alone.
     *   - nothing moves until the pointer travelled DRAG_SLOP px, so a plain
     *     click still reaches whatever is under it, and the click that ends a
     *     real drag is swallowed.
     *   - the dialog is always kept inside the window, also when it is resized.
     *   - the offset is dropped when the dialog closes: dialogs always open
     *     centred.
     *
     * On a touch screen the browser may claim the gesture for scrolling instead
     * (we get a pointercancel); the drag then simply stops. Nothing breaks.
     * ---------------------------------------------------------------------- */

    var DRAG_SLOP   = 4;      // px of travel before a press counts as a drag
    var DRAG_MARGIN = 8;      // px of window edge the dialog may not cross
    var DRAG_PHONE  = 640;    // at or below this width dialogs do not move

    // A press on any of these is a press on a control, not on the dialog.
    var DRAG_SKIP = "button, a, input, select, textarea, label, summary," +
                    "[contenteditable], [role=button], canvas, video, audio," +
                    "iframe, .info-dot, .leaflet-container";

    var drag      = null;     // the drag in progress, or null
    var dragEnded = false;    // a drag just finished -> swallow its click

    // Park the sheet at (x, y) away from its centred spot. x = y = 0 removes the
    // transform, which is also how a closing dialog forgets it was ever moved.
    function moveSheet( sheet, x, y )
    {
        sheet.nayiveDragX = x;
        sheet.nayiveDragY = y;
        sheet.style.transform = ( x || y ) ? "translate(" + x + "px," + y + "px)" : "";
    }

    // Keep the dialog inside the window: its edge has to stay between MARGIN and
    // (window - size - MARGIN). `base` is where the edge sits with no offset. A
    // dialog bigger than the window swaps the two bounds over, and the clamp
    // then lets it be pushed either way to bring the hidden edge into view.
    function clampDrag( v, base, size, win )
    {
        var a  = DRAG_MARGIN - base;
        var b  = win - DRAG_MARGIN - size - base;
        var lo = Math.min( a, b );
        var hi = Math.max( a, b );
        return Math.min( hi, Math.max( lo, v ) );
    }

    function onDragDown( e )
    {
        dragEnded = false;                                    // a new press, a fresh click
        if( drag || e.button ) return;                         // main button only, one at a time
        if( window.innerWidth <= DRAG_PHONE ) return;
        if( ! e.target || ! e.target.closest ) return;
        if( e.target.closest( DRAG_SKIP ) ) return;

        var sheet = e.target.closest( ".sheet" );
        if( ! sheet ) return;

        var x = sheet.nayiveDragX || 0;
        var y = sheet.nayiveDragY || 0;
        var r = sheet.getBoundingClientRect();

        drag = { sheet: sheet, id: e.pointerId, moving: false,
                 px: e.clientX, py: e.clientY, x: x, y: y,
                 baseL: r.left - x, baseT: r.top - y,
                 w: r.width, h: r.height };

        document.addEventListener( "pointermove",   onDragMove, true );
        document.addEventListener( "pointerup",     onDragUp,   true );
        document.addEventListener( "pointercancel", onDragUp,   true );
    }

    function onDragMove( e )
    {
        if( ! drag || e.pointerId !== drag.id ) return;

        var dx = e.clientX - drag.px;
        var dy = e.clientY - drag.py;

        if( ! drag.moving )
        {
            if( Math.abs( dx ) < DRAG_SLOP && Math.abs( dy ) < DRAG_SLOP ) return;
            drag.moving = true;
            drag.sheet.classList.add( "is-dragging" );
            closeInfo();                       // the popup is placed against the page, it cannot follow

            // Drop the text the press started selecting on the way here.
            var sel = window.getSelection && window.getSelection();
            if( sel && sel.removeAllRanges ) sel.removeAllRanges();
        }

        moveSheet( drag.sheet,
                   clampDrag( drag.x + dx, drag.baseL, drag.w, document.documentElement.clientWidth  ),
                   clampDrag( drag.y + dy, drag.baseT, drag.h, document.documentElement.clientHeight ) );
        e.preventDefault();
    }

    function onDragUp( e )
    {
        if( ! drag || ( e.pointerId != null && e.pointerId !== drag.id ) ) return;

        if( drag.moving )
        {
            drag.sheet.classList.remove( "is-dragging" );
            dragEnded = true;      // onDragClick eats the click this drag is about to fire
        }
        drag = null;

        document.removeEventListener( "pointermove",   onDragMove, true );
        document.removeEventListener( "pointerup",     onDragUp,   true );
        document.removeEventListener( "pointercancel", onDragUp,   true );
    }

    // A drag ends with a click on whatever the pointer landed on. Swallow it, or
    // moving a dialog over a list would also pick a row. Cleared by the next
    // press (onDragDown), so a normal click is never lost.
    function onDragClick( e )
    {
        if( ! dragEnded ) return;
        dragEnded = false;
        e.stopPropagation();
        e.preventDefault();
    }

    // A moved dialog must not end up off screen when the window shrinks (or the
    // phone layout kicks in, where dialogs do not move at all).
    function reclampSheets()
    {
        var list  = document.querySelectorAll( ".sheet-backdrop.open .sheet" );
        var phone = window.innerWidth <= DRAG_PHONE;

        for( var i = 0; i < list.length; i++ )
        {
            var s = list[ i ];
            if( ! s.nayiveDragX && ! s.nayiveDragY ) continue;

            if( phone ) { moveSheet( s, 0, 0 ); continue; }

            var r = s.getBoundingClientRect();
            moveSheet( s,
                       clampDrag( s.nayiveDragX, r.left - s.nayiveDragX, r.width,  document.documentElement.clientWidth  ),
                       clampDrag( s.nayiveDragY, r.top  - s.nayiveDragY, r.height, document.documentElement.clientHeight ) );
        }
    }

    // Dialogs open centred, always - so a closing one forgets where it was put.
    // Apps close them in ~15 different places (NayiveUI.close, a plain
    // classList.remove, a whole node thrown away), so instead of hooking each
    // one we just watch the `.open` class come off any backdrop.
    function watchSheetClose()
    {
        if( ! window.MutationObserver ) return;

        new MutationObserver( function ( recs )
        {
            for( var i = 0; i < recs.length; i++ )
            {
                var el = recs[ i ].target;
                if( ! el.classList || ! el.classList.contains( "sheet-backdrop" ) ) continue;
                if( el.classList.contains( "open" ) ) continue;

                var s = el.querySelector( ".sheet" );
                if( s && ( s.nayiveDragX || s.nayiveDragY ) ) moveSheet( s, 0, 0 );
            }
        } ).observe( document.body, { subtree: true, attributes: true, attributeFilter: [ "class" ] } );
    }

    function initDragSheets()
    {
        document.addEventListener( "pointerdown", onDragDown,  true );
        document.addEventListener( "click",       onDragClick, true );
        window.addEventListener( "resize", reclampSheets );
        watchSheetClose();
    }

    // Bottom-centre transient toast. Needs a <div id="toast" class="toast"> in
    // the page (styled by shared/theme.css). opts: { id, ms }.
    function toast( msg, opts )
    {
        opts = opts || {};
        var t = byId( opts.id || "toast" );
        if( ! t ) return;

        clearTimeout( t._nayiveToastTimer );
        t.classList.remove( "actionable" );     // clear a prior actionable toast (contact)
        t.textContent = msg;
        t.classList.add( "show" );

        t._nayiveToastTimer = setTimeout( function ()
        {
            t.classList.remove( "show" );
        }, opts.ms || 1800 );
    }

    // The viewer's IANA zone, or "UTC" if the browser won't say.
    function viewerTz()
    {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
        catch ( e ) { return "UTC"; }
    }

    //------------------------------------------------------------------------//
    // NATIVE DATE / TIME PICKERS - locale
    //
    // The browser's <input type=date|time> popup - its calendar grid's first day
    // of the week, and 24-hour vs AM/PM on the clock - follows the element's
    // `lang`. Left unset it inherits the page's hard-coded lang="es"; we stamp
    // the viewer's own locale instead so pickers read the way they expect. (The
    // OS/browser UI locale still wins in browsers that ignore `lang` on inputs.)

    function pickerLocale()
    {
        try { return navigator.language || document.documentElement.lang || "es"; }
        catch ( e ) { return "es"; }
    }

    function localizeDateTimeInput( el )
    {
        if( ! el || el._nayiveDTLocalized ) return;
        el._nayiveDTLocalized = true;
        el.setAttribute( "lang", pickerLocale() );
    }

    function localizeDateTimeInputs( root )
    {
        var scope = root && root.querySelectorAll ? root : document;
        var list  = scope.querySelectorAll( 'input[type="date"], input[type="time"]' );
        for( var i = 0; i < list.length; i++ ) localizeDateTimeInput( list[ i ] );
    }

    //------------------------------------------------------------------------//
    // i18n  -  re-exported from shared/i18n.js (loaded before this script)
    //
    // The engine lives in shared/i18n.js so the login screen, which does not
    // need the rest of ui.js, can translate itself too. Everything here is a
    // thin alias, kept because every app already says NayiveUI.t(...).

    var I18N      = window.NayiveI18n || null;
    var t         = I18N ? I18N.t         : function ( k ) { return k; };
    var tf        = I18N ? I18N.tf        : function ( k ) { return k; };
    var applyI18n = I18N ? I18N.applyI18n : function () {};
    var i18nReady = I18N ? I18N.ready     : Promise.resolve( {} );

    // Sheets are often built dynamically (trip, calendar recurrence row) - catch
    // date/time inputs added to the DOM after this script runs.
    if( window.MutationObserver )
    {
        var dtObserver = new MutationObserver( function ( muts )
        {
            for( var i = 0; i < muts.length; i++ )
            {
                var added = muts[ i ].addedNodes;
                for( var j = 0; j < added.length; j++ )
                {
                    var n = added[ j ];
                    if( ! n || n.nodeType !== 1 ) continue;
                    if( n.matches && n.matches( 'input[type="date"], input[type="time"]' ) ) localizeDateTimeInput( n );
                    localizeDateTimeInputs( n );
                    applyI18n( n );
                    applyInfoDots( n );
                    applyHomeLinks( n );
                    applySyncDots( n );
                }
            }
        } );
        try { dtObserver.observe( document.documentElement, { childList: true, subtree: true } ); }
        catch ( e ) {}
    }

    //------------------------------------------------------------------------//
    // DIALOG ACTION BUTTONS

    // name -> [ stroke-width, inner SVG markup ]. 24x24 viewBox; CSS sizes it.
    var ICONS = {
        x:      [ 2.2, '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>' ],
        check:  [ 2.6, '<polyline points="20 6 9 17 4 12"></polyline>' ],
        trash:  [ 2,   '<line x1="4" y1="7" x2="20" y2="7"></line><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"></path><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path>' ],
        help:   [ 2,   '<circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>' ],
        info:   [ 2,   '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="11" x2="12" y2="16"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>' ],
        search: [ 2,   '<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>' ],
        plus:   [ 2.4, '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>' ],
        back:   [ 2.2, '<line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>' ],
        // Arrows move BETWEEN SCREENS - "back", and "forward" to open an item. A chevron
        // never navigates: it means expand or step in place (Drive's tree twisty, the
        // month pagers in Calendar and Habits, a collapsible section's caret).
        forward: [ 2.2, '<line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>' ],
        edit:   [ 2,   '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>' ],
        grid:   [ 1.9, '<rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line>' ],
        folder: [ 2,   '<path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>' ],
        doc:    [ 2,   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="12" y2="17"></line>' ],
        // "Save as" - the check, with a small + centred near the top edge for "as a new copy".
        saveas: [ 2,   '<polyline points="5 14 10 18 17 9" stroke-width="2.5"></polyline><line x1="12" y1="1" x2="12" y2="7" stroke-width="2.4"></line><line x1="9" y1="4" x2="15" y2="4" stroke-width="2.4"></line>' ],
        // "Quick tour" - a compass.
        compass:[ 2,   '<circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>' ],
        // Settings - a cog wheel.
        gear:   [ 2,   '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' ],
        // "Mi cuenta" - a person bust.
        user:   [ 2,   '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>' ],
        // "Do not show again" - an eye with a slash.
        eyeoff: [ 2,   '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>' ],
        // "Marcar como pendiente" - a counter-clockwise arrow (standard undo).
        undo:   [ 2.2, '<path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>' ],
        // Drag-reorder grip - six dots. Stroke-width 0 = render filled, not stroked
        // (matches the handle tasks / trips draw in their list rows).
        grip:   [ 0,   '<circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle>' ],
        // "Instalar app" + the install dialog: the tray-with-an-arrow, iOS's
        // Compartir (box with an arrow leaving it), iOS's "Añadir a pantalla de
        // inicio" (box with a +), full screen (four corners) and speed (a bolt).
        download: [ 2, '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>' ],
        share:    [ 2, '<path d="M8 7H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"></path><polyline points="8 6 12 2 16 6"></polyline><line x1="12" y1="2" x2="12" y2="14"></line>' ],
        addhome:  [ 2, '<rect x="3" y="3" width="18" height="18" rx="3"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line>' ],
        fullscr:  [ 2, '<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M21 16v3a2 2 0 0 1-2 2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path>' ],
        bolt:     [ 2, '<polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"></polygon>' ],
        // "Solo lectura" - a closed padlock. Drawn blue in .ro-badge (see app.css).
        lock:     [ 2, '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path>' ],
        // Cortar / Copiar / Pegar - the same three glyphs Drive's context menu
        // draws. Write's and Calc's Edición menus use them (shared/menubar.js).
        cut:      [ 2, '<circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line>' ],
        copy:     [ 2, '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' ],
        paste:    [ 2, '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect><path d="M9 14l2 2 4-4"></path>' ]
    };

    // App logos that don't fit the 24 stroke grid the ICONS table above uses:
    // each carries its own 512 viewBox. `write` = fountain pen + inkwell,
    // `calc` = the "f(x)" formula mark (vertically stretched).
    var APP_LOGOS = {
        write:
            '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">' +
            '<g transform="translate(45 465) rotate(-48)">' +
            '<path d="M0 0 28 -14 82 -36C96 -36 110 -27 122 -19L122 19C110 27 96 36 82 36L28 14Z"></path>' +
            '<rect x="132" y="-26" width="350" height="52"></rect>' +
            '<path d="M494 -26 522 -26C542 -26 550 -14 550 0 550 14 542 26 522 26L494 26Z"></path></g>' +
            '<rect x="262" y="220" width="176" height="50" rx="12"></rect>' +
            '<path fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" ' +
            'd="M294 270 294 300C294 314 228 312 228 332L228 445C228 460 240 472 255 472L445 472C460 472 472 460 472 445L472 332C472 312 406 314 406 300L406 270"></path>' +
            '<path d="M228 355 472 355 472 445C472 460 460 472 445 472L255 472C240 472 228 460 228 445Z"></path></svg>',
        calc:
            '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">' +
            '<g transform="translate(-213.2 -558.1) scale(1.8891 3.2191)"><g transform="translate(37.3 3.7)">' +
            '<path d="m 159.5,210.8 v 7.2 h 25.2 v 16.5 H 159.5 V 300 h -21.5 v -65.6 h -19.9 v -16.5 h 19.9 v -5.7 q 0,-14.8 6.2,-20.5 6.2,-5.7 22.9,-5.7 h 17.7 v 16.5 h -16.8 q -4.8,0 -6.6,1.8 -1.7,1.8 -1.8,6.5 z"></path>' +
            '<g transform="translate(67.4 112.5) scale(.625)">' +
            '<path d="m 243.4,186.2 q -9.7,17.5 -14.4,33.9 -4.7,16.4 -4.7,32.8 0,16.3 4.7,32.8 4.7,16.5 14.4,34.1 h -16.7 q -11.6,-16.9 -17.3,-33.3 -5.6,-16.5 -5.6,-33.5 0,-17 5.6,-33.5 5.7,-16.6 17.3,-33.3 z"></path>' +
            '<path d="M 329.9,218 302.2,257.2 332.3,300 H 307.2 L 291.1,272.4 275.1,300 h -25 l 30.3,-42.8 -27.9,-39.3 h 25 l 13.6,24.5 13.7,-24.5 z"></path>' +
            '<path d="m 338.9,186.2 h 16.7 q 11.6,16.7 17.2,33.3 5.7,16.5 5.7,33.5 0,17.1 -5.6,33.5 -5.6,16.4 -17.3,33.3 h -16.7 q 9.7,-17.6 14.4,-34.1 4.7,-16.6 4.7,-32.8 0,-16.4 -4.7,-32.8 -4.7,-16.4 -14.4,-33.9 z"></path>' + '</g></g></g></svg>'
    };

    function icon( name )
    {
        if( APP_LOGOS[ name ] ) return APP_LOGOS[ name ];

        var d = ICONS[ name ] || ICONS.check;
        if( d[ 0 ] === 0 )      // filled glyph (e.g. the drag grip), not stroked
            return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">' + d[ 1 ] + '</svg>';
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + d[ 0 ] +
               '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d[ 1 ] + '</svg>';
    }

    // role -> [ css class, default icon ]
    var ROLES = {
        close:     [ "btn-secondary", "x"     ],
        primary:   [ "btn-primary",   "check" ],
        secondary: [ "btn-secondary", null    ],
        danger:    [ "btn-danger",    "trash" ],
        ghost:     [ "btn-ghost",     "help"  ]
    };

    // Style every <button data-act="…"> under `root` (default: document) as a
    // Nayive dialog button. Idempotent; keeps id / title / disabled / listeners.
    function applySheetButtons( root )
    {
        var scope = root || document;
        var list  = scope.querySelectorAll( "button[data-act]" );

        for( var i = 0; i < list.length; i++ )
        {
            var b     = list[ i ];
            var spec  = ( b.getAttribute( "data-act" ) || "primary" ).split( ":" );
            var role  = ROLES[ spec[ 0 ] ] || ROLES.primary;

            b.classList.add( "btn" );
            if( role[ 0 ] ) b.classList.add( role[ 0 ] );

            b.innerHTML = icon( spec[ 1 ] || role[ 1 ] || "check" );

            // The title is usually a data-i18n-attr key that shared/i18n.js has
            // not filled in yet, so mirror the KEY into aria-label and let
            // applyI18n set both at once. A literal title is copied as before.
            if( ! b.getAttribute( "aria-label" ) )
            {
                var i18nAttr = b.getAttribute( "data-i18n-attr" ) || "";
                var titleKey = /(?:^|,)\s*title\s*:\s*([\w.]+)/.exec( i18nAttr );

                if( titleKey && i18nAttr.indexOf( "aria-label" ) === -1 )
                    b.setAttribute( "data-i18n-attr", i18nAttr + ", aria-label:" + titleKey[ 1 ] );
                else if( b.title )
                    b.setAttribute( "aria-label", b.title );
            }

            if( spec[ 0 ] === "close" ) b._nayiveClose = true;

            b.removeAttribute( "data-act" );
        }

        // A dialog whose only action is "close" shows it in the top-right corner.
        var rows = scope.querySelectorAll( ".sheet-actions" );
        for( var j = 0; j < rows.length; j++ )
            cornerLoneClose( rows[ j ] );
    }

    // If `row` holds nothing but a close button, move it to the sheet's corner
    // as a .sheet-close and remove the now-empty row.
    function cornerLoneClose( row )
    {
        var kids = row.children;
        if( kids.length !== 1 || ! kids[ 0 ]._nayiveClose ) return;

        var b     = kids[ 0 ];
        var sheet = row.closest && row.closest( ".sheet" );
        if( ! sheet ) return;

        b.classList.remove( "btn", "btn-secondary" );
        b.classList.add( "sheet-close" );
        b.style.position = "absolute";
        b.style.top      = "10px";
        b.style.right    = "10px";
        sheet.appendChild( b );
        row.parentNode.removeChild( row );

        if( getComputedStyle( sheet ).position === "static" )
            sheet.style.position = "relative";
    }

    //------------------------------------------------------------------------//
    // INFO DOT + POPUP  - a circled "i" next to a label / control that opens a
    // small explanatory popup. NOT a dialog: no "x", no backdrop. It closes on a
    // second tap, a tap outside, Escape, or a scroll / resize. Text is read from
    // the trigger's `data-info` ("\n" -> new line). Paired CSS: shared/app.css
    // (.info-dot / .info-popup).
    //
    // ON A PC (a real mouse: "hover: hover" AND "pointer: fine") the popup also
    // opens on hover, so the texts can be read by just sweeping the dots. Leaving
    // the dot closes it after a short delay - long enough to cross the 6px gap
    // into the popup, which keeps itself open while the pointer is inside it, so
    // the long admin texts can be read. A CLICK PINS the popup: it then behaves
    // exactly as on a phone (stays until a second click / outside / Esc / scroll).
    // The hover check is done per event, not once at load, so plugging a mouse in
    // later works. All of it is wired ONCE in applyInfoDots(), never per dot.

    var infoPopupEl  = null;    // the single shared popup node (lazy)
    var infoOpenDot  = null;    // the .info-dot it currently belongs to, or null
    var infoByHover  = false;   // true while the open popup came from hover (not pinned)
    var infoCloseTmr = null;    // pending "mouse left" close

    // A PC, i.e. something that can really hover. Touch screens report
    // "hover: none" and coarse pointers, so they keep the tap-only behaviour.
    function infoHoverable()
    {
        return !! ( window.matchMedia
                    && window.matchMedia( "(hover: hover) and (pointer: fine)" ).matches );
    }

    function infoCancelClose()
    {
        if( infoCloseTmr ) { clearTimeout( infoCloseTmr ); infoCloseTmr = null; }
    }

    function infoCloseSoon()
    {
        infoCancelClose();
        infoCloseTmr = setTimeout( function()
        {
            infoCloseTmr = null;
            if( infoByHover ) closeInfo();      // a click may have pinned it meanwhile
        }, 180 );
    }

    function onInfoEnter( e )
    {
        if( ! infoHoverable() ) return;
        infoCancelClose();
        var dot = e.currentTarget;
        if( infoOpenDot === dot ) return;
        closeInfo();
        openInfo( dot );
        infoByHover = true;
    }

    function onInfoLeave()
    {
        if( infoByHover ) infoCloseSoon();
    }

    function closeInfo()
    {
        infoCancelClose();
        infoByHover = false;
        if( ! infoOpenDot ) return;
        infoOpenDot.classList.remove( "is-open" );
        infoOpenDot = null;
        if( infoPopupEl ) infoPopupEl.style.display = "none";

        document.removeEventListener( "pointerdown", onInfoOutside, true );
        document.removeEventListener( "keydown", onInfoKey, true );
        window.removeEventListener( "scroll", closeInfo, true );
        window.removeEventListener( "resize", closeInfo, true );
    }

    function onInfoOutside( e )
    {
        if( infoPopupEl && infoPopupEl.contains( e.target ) ) return;
        if( infoOpenDot && infoOpenDot.contains( e.target ) ) return;   // the dot handles its own toggle
        closeInfo();
    }

    function onInfoKey( e )
    {
        if( e.key === "Escape" ) { e.stopPropagation(); closeInfo(); }
    }

    function openInfo( dot )
    {
        if( ! infoPopupEl )
        {
            infoPopupEl = document.createElement( "div" );
            infoPopupEl.className = "info-popup";
            infoPopupEl.setAttribute( "role", "tooltip" );
            // Reading the text means putting the pointer ON the popup: keep it
            // open while it is there, close it again when the pointer leaves.
            infoPopupEl.addEventListener( "mouseenter", infoCancelClose );
            infoPopupEl.addEventListener( "mouseleave", onInfoLeave );
            document.body.appendChild( infoPopupEl );
        }

        infoByHover = false;                            // openInfo() alone = pinned

        infoPopupEl.textContent = dot.getAttribute( "data-info" ) || "";
        infoPopupEl.style.display    = "block";
        infoPopupEl.style.visibility = "hidden";        // measure before placing
        infoPopupEl.style.left = "0px";
        infoPopupEl.style.top  = "0px";

        var r    = dot.getBoundingClientRect();
        var pw   = infoPopupEl.offsetWidth;
        var ph   = infoPopupEl.offsetHeight;
        var sx   = window.pageXOffset;
        var sy   = window.pageYOffset;
        var vw   = document.documentElement.clientWidth;
        var vh   = document.documentElement.clientHeight;
        var gap  = 6;
        var pad  = 8;

        var left = r.left;
        if( left + pw > vw - pad ) left = vw - pad - pw;
        if( left < pad ) left = pad;

        var top = r.bottom + gap;                       // below the dot by default
        if( top + ph > vh - pad && r.top - gap - ph >= pad )
            top = r.top - gap - ph;                     // flip above if it would overflow

        infoPopupEl.style.left = ( left + sx ) + "px";
        infoPopupEl.style.top  = ( top + sy ) + "px";
        infoPopupEl.style.visibility = "visible";

        infoOpenDot = dot;
        dot.classList.add( "is-open" );

        document.addEventListener( "pointerdown", onInfoOutside, true );
        document.addEventListener( "keydown", onInfoKey, true );
        window.addEventListener( "scroll", closeInfo, true );
        window.addEventListener( "resize", closeInfo, true );
    }

    function onInfoClick( e )
    {
        e.preventDefault();
        var dot = e.currentTarget;
        if( infoOpenDot === dot )
        {
            // Clicking a popup opened by hover PINS it (the pointer is still on
            // the dot, so closing here would just look like the click failed).
            if( infoByHover ) { infoByHover = false; infoCancelClose(); }
            else closeInfo();
        }
        else { closeInfo(); openInfo( dot ); }
    }

    // Wire every <button class="info-dot"> under `root` (default: document).
    // Idempotent; fills in the icon + ARIA if missing.
    //------------------------------------------------------------------------//
    // SYNC INDICATOR GLYPH
    //
    // Every app's header carries a `.sync-indicator`. It used to be a filled dot
    // whose COLOUR was the whole message; now it is ONE plug, drawn either seated
    // in its socket or pulled out of it, so the state reads without relying on
    // colour alone. The colours are unchanged (theme.css):
    //
    //     .synced   green  plugged in
    //     .busy     blue   plugged in (a GET / PUT is in flight)
    //     .offline  gold   unplugged  (offline / changes queued)
    //     no class  red    unplugged  (not synced yet / error)
    //
    // theme.css picks the half to draw from that same state class, so an app only
    // ever toggles the classes it already toggled. The markup lives here, not in
    // 14 copies of the same <svg>: applySyncDots() fills every `.sync-indicator`
    // it finds, and the MutationObserver below catches the ones built later (trips
    // builds its header in JS).

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
            if( el._nayiveSync ) continue;
            el._nayiveSync = true;
            el.innerHTML = SYNC_GLYPH;
        }
    }

    function applyInfoDots( root )
    {
        var scope = root && root.querySelectorAll ? root : document;
        var list  = [].slice.call( scope.querySelectorAll( ".info-dot" ) );

        // querySelectorAll only sees descendants - include `scope` itself if it
        // is a dot (a node just added by the MutationObserver).
        if( scope.nodeType === 1 && scope.matches && scope.matches( ".info-dot" ) )
            list.push( scope );

        for( var i = 0; i < list.length; i++ )
        {
            var d = list[ i ];
            if( d._nayiveInfo ) continue;
            d._nayiveInfo = true;

            if( d.tagName === "BUTTON" && ! d.getAttribute( "type" ) )
                d.setAttribute( "type", "button" );
            if( ! d.innerHTML.trim() ) d.innerHTML = icon( "info" );
            if( ! d.getAttribute( "aria-label" ) )
                d.setAttribute( "data-i18n-attr",
                                ( d.getAttribute( "data-i18n-attr" ) ? d.getAttribute( "data-i18n-attr" ) + ", " : "" )
                                + "aria-label:ui.moreInfo" );

            d.addEventListener( "click", onInfoClick );
            d.addEventListener( "mouseenter", onInfoEnter );
            d.addEventListener( "mouseleave", onInfoLeave );
        }
    }

    //------------------------------------------------------------------------//
    // APP KEY  - the <name> in /nayive/<name>/. Used as the first-run intro's
    // per-app localStorage suffix and to switch the "back to the launcher"
    // hint off on the launcher itself.

    function appKey()
    {
        var m = ( location.pathname || "" ).match( /\/(?:nayive|apps)\/([^\/]+)/ );
        return m ? m[ 1 ] : "app";
    }

    //------------------------------------------------------------------------//
    // GUIDED TOUR HOOK  - NayiveUI.startTour. NayiveUI.firstRun re-points this at
    // the app's own first-run intro card (see below); until then it just says
    // "coming soon". The launcher's "Que es Nayive" button calls it.

    function defaultTour()
    {
        toast( t( "ui.tourSoon" ) );
    }

    //------------------------------------------------------------------------//
    // CONFIRM / ALERT  - a Nayive sheet, never the browser's window.confirm /
    // window.alert (those ignore the theme and the style guide).
    //
    //   if( await NayiveUI.confirm( { title: 'Vaciar la papelera?',
    //                               body: 'Se borraran 12 elementos.',
    //                               confirm: 'Vaciar', danger: true } ) ) { ... }
    //   await NayiveUI.alert( { title: 'No se pudo importar', body: msg } );
    //
    // The sheet is built on the fly and removed on close. It closes on its own
    // buttons or Escape only - never a backdrop click (dialog-close rule).
    // `body` may hold "\n" - each line becomes its own <p>. A plain string
    // argument is taken as the body.

    function normDialogOpts( opts )
    {
        if( typeof opts === "string" ) return { body: opts };
        return opts || {};
    }

    function makeDialog( opts, withCancel )
    {
        opts = normDialogOpts( opts );

        return new Promise( function ( resolve )
        {
            var done = false;

            var back = document.createElement( "div" );
            back.className = "sheet-backdrop";
            back.setAttribute( "role", "dialog" );
            back.setAttribute( "aria-modal", "true" );

            var sheet = document.createElement( "div" );
            sheet.className = "sheet";
            back.appendChild( sheet );

            if( opts.title )
            {
                var h = document.createElement( "h2" );
                h.textContent = opts.title;
                sheet.appendChild( h );
            }

            var bodyText = opts.body == null ? "" : String( opts.body );
            if( bodyText )
            {
                var p = document.createElement( "p" );
                p.className = "dialog-text";
                p.textContent = bodyText;      // CSS white-space: pre-wrap keeps "\n"
                sheet.appendChild( p );
            }

            var row = document.createElement( "div" );
            row.className = "sheet-actions";
            sheet.appendChild( row );

            var cancel = null;
            if( withCancel )
            {
                cancel = document.createElement( "button" );
                cancel.setAttribute( "data-act", "close" );
                cancel.title = opts.cancel || t( "ui.cancel" );
                row.appendChild( cancel );
            }

            var ok = document.createElement( "button" );
            if( withCancel )
                ok.setAttribute( "data-act", opts.danger ? "danger" : "primary" );
            else
                ok.setAttribute( "data-act", "close" );        // lone close -> corner "x"
            ok.title = opts.confirm || ( withCancel ? t( "ui.accept" ) : t( "ui.close" ) );
            row.appendChild( ok );

            function finish( val )
            {
                if( done ) return;
                done = true;
                document.removeEventListener( "keydown", onKey, true );
                back.classList.remove( "open" );
                if( back.parentNode ) back.parentNode.removeChild( back );
                resolve( val );
            }

            function onKey( e )
            {
                if( e.key === "Escape" )
                {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    finish( false );
                }
            }

            document.body.appendChild( back );
            applySheetButtons( sheet );     // classes + SVGs; lone close -> corner

            // applySheetButtons keeps the same button nodes (it only re-classes
            // them and may move a lone close to the sheet corner).
            ok.addEventListener( "click", function () { finish( true ); } );
            if( cancel ) cancel.addEventListener( "click", function () { finish( false ); } );

            document.addEventListener( "keydown", onKey, true );
            back.classList.add( "open" );

            // For a destructive confirm, focus the safe (cancel) button so a
            // stray Enter doesn't trigger the delete.
            ( opts.danger && cancel ? cancel : ok ).focus();
        } );
    }

    function confirmDialog( opts ) { return makeDialog( opts, true ); }
    function alertDialog( opts )   { return makeDialog( opts, false ); }

    //------------------------------------------------------------------------//
    // ROOM FOR AN UPLOAD  (and the offer to empty the papelera)
    //------------------------------------------------------------------------//

    function fmtBytes( n )
    {
        var u = [ "B", "KB", "MB", "GB", "TB" ], i = 0;
        n = Math.max( 0, n || 0 );
        while ( n >= 1024 && i < u.length - 1 ) { n /= 1024; i++; }
        return ( n < 10 && i ? n.toFixed( 1 ) : Math.round( n ) ) + " " + u[ i ];
    }

    /* Is there room for `need` bytes? Resolves true to go ahead, false to stop.
     *
     * A trashed file still takes up disk and still counts against the quota, so
     * when the upload does not fit but WOULD fit with the papelera emptied,
     * this offers exactly that and empties it if the user agrees. Every upload
     * path (Drive, Photos, the share target) calls this instead of reading
     * ?stat=disk itself. The server enforces the quota anyway (507); this is
     * only here to say something useful before a long upload fails. */
    async function ensureRoom( need )
    {
        var s;
        try { s = JSON.parse( await GumApi.fetchText( GumApi.API_FILES + "?stat=disk" ) ); }
        catch ( e ) { return true; }                  // can't tell: let the server decide
        if ( ! s || typeof s.usable !== "number" || need <= s.usable ) return true;

        var held  = s.trash || 0;
        var short = tf( "ui.room.short", { need: fmtBytes( need ), free: fmtBytes( s.usable ) } );

        if ( held > 0 && need <= s.usable + held )
        {
            var ok = await confirmDialog( {
                title:   t( "ui.room.title" ),
                body:    short + "\n\n" + tf( "ui.room.trashBody", { held: fmtBytes( held ) } ),
                confirm: t( "ui.room.empty" ), danger: true } );
            if ( ! ok ) return false;
            try { await GumApi.trashEmpty(); return true; }
            catch ( e ) { toast( t( "ui.room.emptyFail" ) ); return false; }
        }

        toast( t( "ui.room.none" ) + " " + short +
               ( held > 0 ? " " + tf( "ui.room.trashHolds", { held: fmtBytes( held ) } ) : "" ) );
        return false;
    }

    //------------------------------------------------------------------------//
    // HELP DIALOG  ("what is this app, and what does each toolbar button do")
    //
    //   NayiveUI.firstRun( {
    //       app:   "photos",             // default: the <name> in /nayive/<name>/
    //       title: "Photos",
    //       lead:  "Las fotos de una carpeta de tu Drive.",   // optional summary
    //                                     // (an array: one paragraph per entry)
    //       buttons: [                   // one row per toolbar button
    //           { sel: "#addBtn", text: "Sube fotos a esta carpeta." },
    //           { sel: "[data-intro-open]", text: "Abre esta ayuda." },
    //           { icon: "grid", name: "Vistas", text: "Cuadricula, mapa o pase." }
    //       ],
    //       tip: "Consejo: ...",          // extra line under the list (launcher)
    //       autoShow: true,               // open on load until dismissed (launcher)
    //       dismissible: true             // add a "No volver a mostrar" button
    //   } );
    //
    // A row's glyph + name come from the real button named by `sel` (so they
    // always match what is on screen); `text` is the hand-written explanation.
    // `{ icon, name, text }` describes a row with no single button behind it.
    // Apps never auto-open the dialog - it opens only from the toolbar "?"
    // button ([data-intro-open], wired here) or NayiveUI.showIntro(). The launcher
    // passes autoShow + dismissible: it re-opens every visit until the user
    // clicks "No volver a mostrar" (localStorage "balata-intro-dismiss:<app>").

    var introOpts = null;
    var introHeld = false;      // set by holdIntro() when something more important must own the screen

    // Suppress the auto-opening help card for this page load and close it if it
    // is already up. The launcher calls this when a first-time user must set a
    // password before anything else.
    function holdIntro()
    {
        introHeld = true;
        var x = document.querySelector( ".sheet-backdrop.open .intro-close" );
        if( x ) x.click();
    }

    // The glyph for one list row: the real button's <svg> (cloned so CSS sizes
    // it), else a named shared icon, else the button's short text, else a dot.
    function introGlyph( it, el )
    {
        var span = document.createElement( "span" );
        span.className = "intro-btn-i";

        var svg = el && el.querySelector && el.querySelector( "svg" );
        if( svg )
        {
            var c = svg.cloneNode( true );
            c.removeAttribute( "width" );
            c.removeAttribute( "height" );
            span.appendChild( c );
        }
        else if( it.icon )
        {
            span.innerHTML = icon( it.icon );
        }
        else
        {
            var t = el && ( el.textContent || "" ).trim();
            span.textContent = t && t.length <= 2 ? t : "•";
        }
        return span;
    }

    function buildIntro( opts )
    {
        var app = opts.app || appKey();

        var back = document.createElement( "div" );
        back.className = "sheet-backdrop";
        back.setAttribute( "role", "dialog" );
        back.setAttribute( "aria-modal", "true" );

        var sheet = document.createElement( "div" );
        sheet.className = "sheet intro-sheet";
        back.appendChild( sheet );

        if( opts.title )
        {
            var h = document.createElement( "h2" );
            h.textContent = opts.title;
            sheet.appendChild( h );
        }

        // One paragraph, or several: `lead` takes a string or an array of them,
        // so an app can add a note under its summary without a new option.
        if( opts.lead )
        {
            [].concat( opts.lead ).forEach( function ( line )
            {
                if( ! line ) return;
                var p = document.createElement( "p" );
                p.className   = "dialog-text";
                p.textContent = String( line );
                sheet.appendChild( p );
            } );
        }

        var rows = opts.buttons || [];
        if( rows.length )
        {
            var ul = document.createElement( "ul" );
            ul.className = "intro-btns";

            for( var i = 0; i < rows.length; i++ )
            {
                var it = rows[ i ];
                var el = it.sel ? document.querySelector( it.sel ) : null;
                if( it.sel && ! el ) continue;         // button not on this screen

                var li = document.createElement( "li" );
                li.appendChild( introGlyph( it, el ) );

                var boxx = document.createElement( "div" );
                boxx.className = "intro-btn-t";

                var name = it.name
                        || ( el && ( el.getAttribute( "title" ) || el.getAttribute( "aria-label" ) ) )
                        || "";
                if( name )
                {
                    var nb = document.createElement( "b" );
                    nb.textContent = name;
                    boxx.appendChild( nb );
                }
                var tx = document.createElement( "span" );
                tx.textContent = it.text || "";
                boxx.appendChild( tx );

                li.appendChild( boxx );
                ul.appendChild( li );
            }
            sheet.appendChild( ul );
        }

        if( opts.tip )
        {
            var hint = document.createElement( "p" );
            hint.className   = "dialog-text intro-home-hint";
            hint.textContent = String( opts.tip );
            sheet.appendChild( hint );
        }

        var done = false;
        function finish()
        {
            if( done ) return;
            done = true;
            document.removeEventListener( "keydown", onKey, true );
            back.classList.remove( "open" );
            if( back.parentNode ) back.parentNode.removeChild( back );
        }
        function onKey( e )
        {
            if( e.key === "Escape" )
            {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                finish();
            }
        }

        // Close (x) in the top-right corner, like every other Nayive dialog. It is
        // sticky, not just absolute, so it stays put while a long button list
        // scrolls under it. First child so it sits above the title.
        var xb = document.createElement( "button" );
        xb.type      = "button";
        xb.className = "sheet-close intro-close";
        xb.title     = opts.confirm || t( "ui.close" );
        xb.setAttribute( "aria-label", xb.title );
        xb.innerHTML = icon( "x" );
        xb.addEventListener( "click", finish );
        sheet.insertBefore( xb, sheet.firstChild );

        // The launcher keeps its wide "No volver a mostrar" button at the bottom.
        if( opts.dismissible )
        {
            var row = document.createElement( "div" );
            row.className = "sheet-actions";
            var db = document.createElement( "button" );
            db.type      = "button";
            db.className = "intro-dismiss";
            db.textContent = opts.dismissLabel || t( "ui.dontShowAgain" );
            db.addEventListener( "click", function ()
            {
                try { localStorage.setItem( "balata-intro-dismiss:" + app, "1" ); }
                catch ( e ) {}
                finish();
            } );
            row.appendChild( db );
            sheet.appendChild( row );
        }

        document.body.appendChild( back );
        document.addEventListener( "keydown", onKey, true );
        back.classList.add( "open" );
        xb.focus();
    }

    function introDismissed( app )
    {
        try { return localStorage.getItem( "balata-intro-dismiss:" + app ) === "1"; }
        catch ( e ) { return true; }        // no storage -> treat as dismissed
    }

    function doShowIntro( opts, deferIfBusy )
    {
        opts = opts || introOpts;
        if( ! opts || introHeld ) return;

        // don't stack on top of a folder picker / other open sheet
        if( deferIfBusy && document.querySelector( ".sheet-backdrop.open" ) )
        {
            setTimeout( function () { doShowIntro( opts, false ); }, 800 );
            return;
        }
        buildIntro( opts );
    }

    //------------------------------------------------------------------------//
    // APP NAME / ICON  ->  THE LAUNCHER
    //
    // Tapping an app's icon or its <h1> goes back to /nayive/. Every app header is
    // the same shape - an .app-icon SVG next to the <h1> - inside a .topbar /
    // .header / .trip-header. trips' list header is JS-built (its <h1> carries
    // .app-title) and caught by the MutationObserver; trips' single-trip view is
    // an <h1> with no .app-icon and no .app-title, so it is left alone. The
    // launcher page has neither and is a no-op here.

    function isAppTitleH1( el )
    {
        if( ! el || el.tagName !== "H1" ) return false;
        if( el.classList.contains( "app-title" ) ) return true;
        var head = el.closest && el.closest( ".topbar, .header, .trip-header" );
        if( ! head || ! head.querySelector( ".app-icon" ) ) return false;
        return ! ( el.closest && el.closest( ".trip-header-title" ) );
    }

    function onHomeClick( e )
    {
        // a real control inside the header keeps its own job
        if( e.target.closest && e.target.closest( "a, button, input, select" ) ) return;
        e.preventDefault();
        navWindow().location.href = "/nayive/";      // the TOP window when framed (Planner)
    }

    function applyHomeLinks( root )
    {
        var scope = root && root.querySelectorAll ? root : document;
        var list  = [].slice.call( scope.querySelectorAll( ".app-icon, h1" ) );
        if( scope.nodeType === 1 && scope.matches &&
            ( scope.matches( ".app-icon" ) || scope.matches( "h1" ) ) )
            list.push( scope );

        for( var i = 0; i < list.length; i++ )
        {
            var el     = list[ i ];
            var isIcon = !! ( el.classList && el.classList.contains( "app-icon" ) );
            if( ! isIcon && ! isAppTitleH1( el ) ) continue;
            // Framed (Planner): the icon is back on screen as the pane's label, but
            // the host header already owns the way home - a pane icon that walked
            // the TOP window out of Planner would be a trap.
            if( isIcon && EMBEDDED ) continue;
            if( el._nayiveHome ) continue;
            el._nayiveHome = true;

            el.classList.add( "nayive-home-link" );
            if( isIcon )
            {
                if( ! el.getAttribute( "title" ) ) el.setAttribute( "data-i18n-attr", "title:ui.toApps" );
                el.setAttribute( "role", "button" );
            }
            el.addEventListener( "click", onHomeClick );
        }
    }

    //------------------------------------------------------------------------//
    // COACH MARKS  - the two bubbles a brand-new user sees ONCE, ever
    //
    // The first time anybody opens ANY Nayive app (one flag for all of them,
    // localStorage "balata-coach-seen") a dim overlay rings the two things a
    // novice never finds on their own and hangs a small bubble off each:
    //
    //     [icono] Fotos   <- "toca el nombre o el icono y vuelves al inicio"
    //     [?]             <- "aqui esta la ayuda de esta aplicacion"
    //
    // Each bubble carries its own (x) in its top-right corner, but that corner
    // shows a 9..1 countdown first: the (x) only works once the count is over,
    // so the two lines cannot be swatted away before they have been read.
    // Escape is swallowed for the same 9 seconds.
    //
    // It never shows on the launcher (no app icon and no "?" there). The flag is
    // written the moment the count reaches 0 - not when the bubbles are closed,
    // and not when they open - so whoever sat through the 9 seconds never sees
    // it again, while whoever quit the app first meets it in the next one.
    // NayiveUI.showCoach( true ) forces it back for a demo or a test.

    var COACH_KEY  = "balata-coach-seen";
    var COACH_SECS = 9;
    var coachOpen  = false;

    function coachSeen()
    {
        try { return localStorage.getItem( COACH_KEY ) === "1"; }
        catch ( e ) { return true; }          // no storage -> never nag
    }

    function onScreen( el )
    {
        if( ! el || ! el.getBoundingClientRect ) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // A plain box from a DOMRect, and the box that holds two of them (the app
    // icon and its <h1> are one single target).
    function boxOf( el )
    {
        var r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                 width: r.width, height: r.height };
    }

    function boxUnion( a, b )
    {
        var l = Math.min( a.left, b.left ), t2 = Math.min( a.top, b.top );
        var r = Math.max( a.right, b.right ), b2 = Math.max( a.bottom, b.bottom );
        return { left: l, top: t2, right: r, bottom: b2, width: r - l, height: b2 - t2 };
    }

    // The two things we point at, or null while they are not on screen yet
    // (trips builds its header - and its "?" - in JS, well after firstRun).
    function coachTargets()
    {
        var ico  = document.querySelector( ".app-icon.nayive-home-link" );
        var h1   = document.querySelector( "h1.nayive-home-link" );
        var help = document.querySelector( "[data-intro-open]" );

        var home = [];
        if( onScreen( ico ) ) home.push( ico );
        if( onScreen( h1 )  ) home.push( h1 );
        if( ! home.length || ! onScreen( help ) ) return null;

        return [
            { els:  home,
              text: t( "ui.coach.home" ) },
            { els:  [ help ],
              text: t( "ui.coach.help" ) }
        ];
    }

    function buildCoach( items )
    {
        var over = document.createElement( "div" );
        over.className = "coach-overlay";
        over.setAttribute( "role", "dialog" );
        over.setAttribute( "aria-modal", "true" );

        // Nothing behind the overlay can be touched while it is up: the overlay
        // covers the viewport and eats the tap itself (a tap on the very "?" we
        // are pointing at must not open the help sheet UNDER the bubble). Only
        // the bubbles opt back in - see .coach-layer in app.css.

        // Two layers so a later mark's ring / hairline never draws over an
        // earlier mark's bubble: rings and lines below, bubbles on top.
        var back = document.createElement( "div" );
        back.className = "coach-layer";
        over.appendChild( back );

        var front = document.createElement( "div" );
        front.className = "coach-layer";
        over.appendChild( front );

        var marks = [];

        for( var i = 0; i < items.length; i++ ) marks.push( makeMark( items[ i ] ) );

        function makeMark( it )
        {
            var ring = document.createElement( "div" );        // outline around the target
            ring.className = "coach-ring";

            var line = document.createElement( "div" );        // hairline ring -> bubble
            line.className = "coach-line";

            var bub = document.createElement( "div" );
            bub.className = "coach-bubble";

            var arrow = document.createElement( "span" );      // the bubble's pointer
            arrow.className = "coach-arrow";
            bub.appendChild( arrow );

            var btn = document.createElement( "button" );      // countdown, then (x)
            btn.type      = "button";
            btn.className = "coach-close";
            btn.disabled  = true;
            btn.title     = t( "ui.coach.wait" );
            btn.setAttribute( "aria-label", btn.title );
            bub.appendChild( btn );

            var p = document.createElement( "p" );
            p.textContent = it.text;
            bub.appendChild( p );

            back.appendChild( ring );
            back.appendChild( line );
            front.appendChild( bub );

            var m = { it: it, ring: ring, line: line, bub: bub, arrow: arrow,
                      btn: btn, alive: true };
            btn.addEventListener( "click", function () { closeMark( m ); } );
            return m;
        }

        // Where this mark's target is right now (both header pieces together).
        function targetBox( m )
        {
            var box = null;
            for( var i = 0; i < m.it.els.length; i++ )
            {
                var el = m.it.els[ i ];
                if( ! onScreen( el ) ) continue;
                box = box ? boxUnion( box, boxOf( el ) ) : boxOf( el );
            }
            return box;
        }

        // Lay the rings and the bubbles out over the live page. Re-run on every
        // resize / scroll / close, so a bubble never drifts off its button.
        function place()
        {
            var vw = window.innerWidth, vh = window.innerHeight, PAD = 8, taken = [];
            var boxes = [];

            // The ringed buttons are obstacles too: a bubble that lands on top
            // of the other target hides the very thing it is pointing at (the
            // phone header wraps, so the "?" sits right under the app icon).
            for( var j = 0; j < marks.length; j++ )
            {
                boxes[ j ] = marks[ j ].alive ? targetBox( marks[ j ] ) : null;
                if( boxes[ j ] )
                    taken.push( { left: boxes[ j ].left - 6, top: boxes[ j ].top - 6,
                                  w: boxes[ j ].width + 12, h: boxes[ j ].height + 12 } );
            }

            for( var i = 0; i < marks.length; i++ )
            {
                var m = marks[ i ];
                if( ! m.alive ) continue;

                var r = boxes[ i ];
                if( ! r )                       // target went away (a mode switch)
                {
                    m.ring.hidden = m.line.hidden = m.bub.hidden = true;
                    continue;
                }
                m.ring.hidden = m.line.hidden = m.bub.hidden = false;

                m.ring.style.left   = ( r.left   -  5 ) + "px";
                m.ring.style.top    = ( r.top    -  5 ) + "px";
                m.ring.style.width  = ( r.width  + 10 ) + "px";
                m.ring.style.height = ( r.height + 10 ) + "px";

                var bw = m.bub.offsetWidth, bh = m.bub.offsetHeight;
                var cx = r.left + r.width / 2;

                var below = r.bottom + 16 + bh + PAD <= vh;     // the header case
                var top   = below ? r.bottom + 16 : r.top - 16 - bh;
                var left  = Math.max( PAD, Math.min( cx - bw / 2, vw - bw - PAD ) );

                // Push this bubble under anything already claimed - a ringed
                // button or a bubble placed before it (top only ever grows, so
                // the walk always ends).
                for( var k = 0; k < taken.length; k++ )
                {
                    var o = taken[ k ];
                    if( left < o.left + o.w + 6 && o.left < left + bw + 6 &&
                        top  < o.top  + o.h + 6 && o.top  < top  + bh + 6 )
                    {
                        top = o.top + o.h + 14;
                        k   = -1;               // start the check again
                    }
                }
                top = Math.max( PAD, Math.min( top, vh - bh - PAD ) );
                taken.push( { left: left, top: top, w: bw, h: bh } );

                m.bub.style.left = left + "px";
                m.bub.style.top  = top  + "px";
                m.bub.classList.toggle( "coach-bubble--up", ! below );

                // The pointer always sits over the target's centre...
                m.arrow.style.left = Math.max( 12, Math.min( cx - left, bw - 12 ) ) + "px";

                // ...and a hairline joins it to the ring when the bubble had to
                // move away (phone, second bubble pushed down).
                var lTop = below ? r.bottom + 5 : top + bh;
                var lBot = below ? top          : r.top - 5;
                m.line.style.left   = ( cx - 1 ) + "px";
                m.line.style.top    = lTop + "px";
                m.line.style.height = Math.max( 0, lBot - lTop ) + "px";
            }
        }

        //--- the shared 9-second countdown -----------------------------------
        var secs  = COACH_SECS;
        var timer = null;

        function paint()
        {
            for( var i = 0; i < marks.length; i++ )
            {
                var b = marks[ i ].btn;
                if( secs > 0 ) { b.textContent = String( secs ); continue; }

                b.innerHTML = icon( "x" );
                b.disabled  = false;
                b.title     = t( "ui.close" );
                b.setAttribute( "aria-label", b.title );
            }

            // Count over = it has been read: remember it and never show it
            // again. Written HERE, not when the overlay opens, so somebody who
            // closes the app after 3 seconds still meets it in the next one.
            if( secs <= 0 )
            {
                try { localStorage.setItem( COACH_KEY, "1" ); }
                catch ( e ) {}
            }
        }

        function onKey( e )
        {
            if( e.key !== "Escape" ) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();       // no app shortcut fires either
            if( secs <= 0 ) finish();
        }

        function closeMark( m )
        {
            if( ! m.alive || secs > 0 ) return;
            m.alive = false;
            [ m.ring, m.line, m.bub ].forEach( function ( n )
            {
                if( n.parentNode ) n.parentNode.removeChild( n );
            } );

            for( var i = 0; i < marks.length; i++ ) if( marks[ i ].alive ) { place(); return; }
            finish();
        }

        var done = false;
        function finish()
        {
            if( done ) return;
            done = true;
            if( timer ) clearInterval( timer );
            document.removeEventListener( "keydown", onKey, true );
            window.removeEventListener( "resize", place );
            window.removeEventListener( "orientationchange", place );
            window.removeEventListener( "scroll", place, true );
            if( over.parentNode ) over.parentNode.removeChild( over );
            coachOpen = false;
        }

        document.body.appendChild( over );
        paint();
        place();
        requestAnimationFrame( place );         // once the bubbles have their real size
        over.classList.add( "open" );

        timer = setInterval( function ()
        {
            secs--;
            paint();
            if( secs <= 0 ) { clearInterval( timer ); timer = null; }
        }, 1000 );

        document.addEventListener( "keydown", onKey, true );
        window.addEventListener( "resize", place );
        window.addEventListener( "orientationchange", place );
        window.addEventListener( "scroll", place, true );
    }

    // Show the coach marks now. `force` ignores the "seen it" flag (demo/test).
    function showCoach( force )
    {
        if( coachOpen || introHeld ) return false;
        if( ! force && coachSeen() ) return false;

        var items = coachTargets();
        if( ! items ) return false;

        coachOpen = true;
        buildCoach( items );        // the "seen it" flag is set when the count ends
        return true;
    }

    // Called from firstRun in every app. The header may still be JS-built
    // (trips) or a folder picker may own the screen (photos / music / movies on
    // their very first run), so keep looking for a while - and if we give up,
    // give up WITHOUT setting the flag, so the next app gets its turn.
    function maybeCoach( tries )
    {
        // Framed (Planner): the icon / title it would ring are hidden, and the
        // host page is where a newcomer is looking anyway.
        if( EMBEDDED || coachOpen || coachSeen() || introHeld ) return;

        var busy = !! document.querySelector( ".sheet-backdrop.open" );
        if( ! busy && showCoach( false ) ) return;

        if( tries < ( busy ? 100 : 15 ) )
            setTimeout( function () { maybeCoach( tries + 1 ); }, 600 );
    }

    function firstRun( opts )
    {
        introOpts = opts || {};

        if( ! firstRun._wired )
        {
            firstRun._wired = true;
            document.addEventListener( "click", function ( e )
            {
                var t = e.target;
                if( t && t.closest && t.closest( "[data-intro-open]" ) )
                {
                    e.preventDefault();
                    doShowIntro( introOpts, false );
                }
            }, true );
        }

        // the launcher's NayiveUI.startTour hook still opens this dialog
        if( window.NayiveUI ) window.NayiveUI.startTour = function () { doShowIntro( introOpts, false ); };

        // Apps never auto-open. The launcher passes autoShow and re-opens every
        // visit until the user dismisses it for good.
        if( introOpts.autoShow && ! introDismissed( introOpts.app || appKey() ) )
            setTimeout( function () { doShowIntro( introOpts, true ); }, 400 );

        // Brand-new user, first app ever: point at the two things nobody finds
        // on their own (see COACH MARKS). Once in a lifetime, all apps share it.
        setTimeout( function () { maybeCoach( 0 ); }, 700 );
    }

    function showIntro( opts ) { doShowIntro( opts || introOpts, false ); }

    // Re-point the "?" at another card without re-running firstRun (which would
    // also restart the coach-mark polling). For an app whose one screen becomes
    // two: Split calls it from render() with the list card or the group card.
    function setIntro( opts ) { if( opts ) introOpts = opts; }

    //------------------------------------------------------------------------//
    // FOLDER PICKER
    //
    // Browse the user's own files/ tree and pick ONE folder. Built for Photos /
    // Music / Movies when they are opened straight from the launcher (no ?dir=):
    // there is no Drive folder to inherit, so they ask once and remember the
    // answer in their own data/<app>/config.json.
    //
    //   const dir = await NayiveUI.pickFolder( { title: 'Elige tu carpeta de música' } );
    //   if( dir ) { ... }      // e.g. "files/musica"      (null = cancelled)
    //
    // Needs GumApi (shared/gum-api.js) for the folders-only tree (GET ?tree=dirs).
    // Same rules as the confirm/alert sheet: closes on its own button or Escape,
    // never a backdrop click.

    var FP_CSS_DONE = false;

    function injectFpCss()
    {
        if( FP_CSS_DONE ) return;
        FP_CSS_DONE = true;
        var s = document.createElement( "style" );
        s.textContent =
            ".fp-tree{margin:4px 0 2px;min-height:240px;max-height:min(66vh,560px);overflow-y:auto;border:1px solid var(--line);border-radius:var(--radius-m)}" +
            ".fp-msg{margin:0;padding:16px;color:var(--text-dim);font-size:.9rem;line-height:1.4}" +
            ".fp-row{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 8px;cursor:pointer;" +
                "border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent)}" +
            ".fp-row:last-child{border-bottom:none}" +
            ".fp-row:hover{background:color-mix(in srgb,var(--accent) 10%,transparent)}" +
            ".fp-row.sel{background:color-mix(in srgb,var(--accent) 22%,transparent)}" +
            ".fp-row.sel .fp-ic,.fp-row.sel .fp-name{color:var(--text)}" +
            ".fp-caret{flex:0 0 auto;width:20px;align-self:stretch;display:flex;align-items:center;" +
                "justify-content:center;color:var(--text-dim);font-size:.8rem}" +
            ".fp-caret.has:hover{color:var(--text)}" +
            ".fp-ic{flex:0 0 auto;display:flex;color:var(--text-dim)}.fp-ic svg{width:16px;height:16px}" +
            ".fp-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9rem}";
        document.head.appendChild( s );
    }

    function pickFolder( opts )
    {
        opts = opts || {};
        injectFpCss();

        return new Promise( function ( resolve )
        {
            var done      = false;
            var expanded  = {};       // folder path -> true
            var selected  = null;     // the folder path the user has highlighted
            var filesNode = null;     // { path:'files', nodes:[...] }, once loaded
            var treeErr   = false;

            var back = document.createElement( "div" );
            back.className = "sheet-backdrop";
            back.setAttribute( "role", "dialog" );
            back.setAttribute( "aria-modal", "true" );

            var sheet = document.createElement( "div" );
            sheet.className = "sheet";
            back.appendChild( sheet );

            function finish( val )
            {
                if( done ) return;
                done = true;
                document.removeEventListener( "keydown", onKey, true );
                back.classList.remove( "open" );
                if( back.parentNode ) back.parentNode.removeChild( back );
                resolve( val || null );
            }

            function onKey( e )
            {
                if( e.key === "Escape" )
                {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    finish( null );
                }
            }

            function sortNodes( nodes )
            {
                return nodes.filter( function ( n )
                {
                    return String( n.path ).split( "/" ).pop().charAt( 0 ) !== ".";   // hide .bak etc.
                } ).sort( function ( a, b )
                {
                    return String( a.path ).toLowerCase() < String( b.path ).toLowerCase() ? -1 : 1;
                } );
            }

            // The tree from GumApi.dirTree() is folders-only, so every node here
            // is a folder; a folder with no sub-folders just has nodes:[].
            function appendNode( host, node, depth )
            {
                if( ! Array.isArray( node.nodes ) ) return;
                host.appendChild( fpRow( node, depth ) );
                if( expanded[ node.path ] )
                    sortNodes( node.nodes ).forEach( function ( c ) { appendNode( host, c, depth + 1 ); } );
            }

            function fpRow( node, depth, label )
            {
                var kids = Array.isArray( node.nodes ) && node.nodes.length > 0;

                var row = document.createElement( "div" );
                row.className = "fp-row" + ( selected === node.path ? " sel" : "" );
                row.style.paddingLeft = ( 8 + depth * 16 ) + "px";
                row.setAttribute( "role", "option" );
                row.setAttribute( "aria-selected", selected === node.path ? "true" : "false" );

                // The caret is the only expand/collapse control; a tap anywhere
                // else on the row just selects the folder.
                var caret = document.createElement( "span" );
                caret.className   = "fp-caret" + ( kids ? " has" : "" );
                caret.textContent = kids ? ( expanded[ node.path ] ? "▾" : "▸" ) : "";
                if( kids )
                    caret.addEventListener( "click", function ( e )
                    {
                        e.stopPropagation();
                        expanded[ node.path ] = ! expanded[ node.path ];
                        render();
                    } );
                row.appendChild( caret );

                var ic = document.createElement( "span" );
                ic.className = "fp-ic";
                ic.innerHTML = icon( "folder" );
                row.appendChild( ic );

                var name = document.createElement( "span" );
                name.className   = "fp-name";
                name.textContent = label || String( node.path ).split( "/" ).pop();
                row.appendChild( name );

                row.addEventListener( "click", function ()
                {
                    selected = node.path;
                    render();
                } );

                return row;
            }

            function render()
            {
                // Keep the tree scrolled where it was across the rebuild.
                var prevBox    = sheet.querySelector( ".fp-tree" );
                var prevScroll = prevBox ? prevBox.scrollTop : 0;

                sheet.innerHTML = "";

                var h = document.createElement( "h2" );
                h.textContent = opts.title || t( "ui.fp.pickFolder" );
                sheet.appendChild( h );

                if( opts.note )
                {
                    var note = document.createElement( "p" );
                    note.className   = "dialog-text";
                    note.textContent = opts.note;
                    sheet.appendChild( note );
                }

                var box = document.createElement( "div" );
                box.className = "fp-tree";
                sheet.appendChild( box );

                var fpMsg = function ( text )
                {
                    var p = document.createElement( "p" );
                    p.className   = "fp-msg";
                    p.textContent = text;
                    return p;
                };

                if( treeErr )
                    box.appendChild( fpMsg( t( "ui.fp.loadError" ) ) );
                else if( filesNode === null )
                    box.appendChild( fpMsg( t( "ui.fp.loading" ) ) );
                else
                {
                    var kids = sortNodes( filesNode.nodes || [] );

                    if( opts.allowRoot )
                        box.appendChild( fpRow( { path: filesNode.path, nodes: [] }, 0,
                                                opts.rootLabel || t( "ui.fp.allFiles" ) ) );

                    if( ! kids.length && ! opts.allowRoot )
                        box.appendChild( fpMsg( t( "ui.fp.noFolders" ) ) );
                    else
                        kids.forEach( function ( k ) { appendNode( box, k, opts.allowRoot ? 1 : 0 ); } );
                }

                box.scrollTop = prevScroll;

                var arow = document.createElement( "div" );
                arow.className = "sheet-actions";

                var cancel = document.createElement( "button" );
                cancel.setAttribute( "data-act", "close" );
                cancel.title = t( "ui.cancel" );
                arow.appendChild( cancel );

                var ok = document.createElement( "button" );
                ok.setAttribute( "data-act", "primary" );
                ok.title = t( "ui.fp.choose" );
                arow.appendChild( ok );

                sheet.appendChild( arow );

                applySheetButtons( sheet );
                cancel.addEventListener( "click", function () { finish( null ); } );
                ok.disabled = ! selected;
                ok.addEventListener( "click", function () { if( selected ) finish( selected ); } );
            }

            document.body.appendChild( back );
            render();
            document.addEventListener( "keydown", onKey, true );
            back.classList.add( "open" );

            ( window.GumApi ? GumApi.dirTree() : Promise.reject( new Error( "no GumApi" ) ) )
                .then( function ( tree )
                {
                    var nodes = ( tree && tree.nodes ) || [];
                    for( var i = 0; i < nodes.length; i++ )
                        if( nodes[ i ].path === "files" ) { filesNode = nodes[ i ]; break; }
                    if( ! filesNode ) filesNode = { path: "files", nodes: [] };
                    render();
                } )
                .catch( function () { treeErr = true; render(); } );
        } );
    }

    // Higher-level: the folder a launcher-opened viewer should use. Reads
    // data/<app>/config.json { folder }; if absent, opens the picker and saves
    // the choice. Returns the path, or null (cancelled, or - unless
    // opts.noRedirect - it will bounce a logged-out visitor to the login page
    // and resolve null).
    function launcherFolder( opts )
    {
        opts = opts || {};
        var cfgPath = "data/" + opts.app + "/config.json";

        return GumApi.readJson( cfgPath ).then( function ( cfg )
        {
            if( cfg && cfg.folder ) return cfg.folder;

            return pickFolder( {
                title:     opts.title,
                note:      opts.note,
                allowRoot: opts.allowRoot,
                rootLabel: opts.rootLabel
            } ).then( function ( picked )
            {
                if( ! picked ) return null;
                return GumApi.writeJson( cfgPath, { folder: picked } )
                    .then( function () { return picked; }, function () { return picked; } );
            } );
        }, function ( err )
        {
            var is401 = String( err && err.message ).indexOf( "401" ) !== -1;
            if( is401 && ! opts.noRedirect && navigator.onLine ) GumApi.loginRedirect();
            return null;
        } );
    }

    // Change the remembered folder later (the crumb button): pick + save. The
    // caller reloads at ?dir=<result>.
    function changeLauncherFolder( opts )
    {
        opts = opts || {};
        return pickFolder( {
            title:     opts.title || t( "ui.changeFolder" ),
            note:      opts.note,
            allowRoot: opts.allowRoot,
            rootLabel: opts.rootLabel
        } ).then( function ( picked )
        {
            if( ! picked ) return null;
            return GumApi.writeJson( "data/" + opts.app + "/config.json", { folder: picked } )
                .then( function () { return picked; }, function () { return picked; } );
        } );
    }

    //------------------------------------------------------------------------//
    // "INSTALL THIS APP" DIALOG
    //
    // Installing Nayive as a PWA is the single most useful thing a new user can
    // do (own icon, full screen, faster start, offline apps, share-to-Photos) and
    // the one almost nobody knows about - so this is a proper dialog that says
    // what you get, not a one-line bar.
    //
    // Chrome / Edge / Android fire `beforeinstallprompt`: we stash it and call
    // .prompt() when the user taps "Instalar". iOS never fires it, so there we
    // show the three real steps (Compartir -> Añadir a pantalla de inicio ->
    // Añadir). Two ways in:
    //
    //   NayiveUI.offerInstall()                  // automatic nudge (the launcher)
    //   NayiveUI.offerInstall( { manual: true } ) // the launcher's "Instalar app" button
    //
    // The automatic one only speaks when the install is really possible. It comes
    // back on EVERY visit (so on every login) until the app is installed or the
    // user clicks "No mostrar más"; "Ahora no" only hides it for the rest of this
    // visit. It waits for the launcher's welcome dialog to close first (two modals
    // at once is one too many). The manual one always opens and always explains
    // something - including "your browser can't".

    var deferredInstall = null;   // the saved beforeinstallprompt event (Chromium)
    var installPending  = false;  // a retry is already queued (both launcher calls share it)
    var installTries    = 0;      // give up after a while instead of retrying forever
    var INSTALL_SNOOZE  = "nayive-install-snooze";   // "installed" | "never"
    var installLater    = false;  // "Ahora no" this visit: quiet until the next page load

    window.addEventListener( "beforeinstallprompt", function ( e )
    {
        e.preventDefault();               // keep Chrome's own mini-infobar away
        deferredInstall = e;
        // Chromium never fires this while the app IS installed, so the event
        // itself proves an old "installed" flag is stale (they uninstalled it).
        try { if( localStorage.getItem( INSTALL_SNOOZE ) === "installed" )
                  localStorage.removeItem( INSTALL_SNOOZE ); } catch ( _ ) {}
    } );
    window.addEventListener( "appinstalled", function ()
    {
        deferredInstall = null;
        try { localStorage.setItem( INSTALL_SNOOZE, "installed" ); } catch ( _ ) {}
        var back = document.getElementById( "nayive-install-bar" );
        // _finish also drops the dialog's Escape listener - remove() alone leaks it
        if( back ) { if( back._finish ) back._finish(); else back.remove(); }
        toast( t( "ui.install.done" ), { ms: 3200 } );
    } );

    function isStandalone()
    {
        return ( window.matchMedia && matchMedia( "(display-mode: standalone)" ).matches ) ||
               window.navigator.standalone === true;
    }
    function isIOS()
    {
        return /iphone|ipad|ipod/i.test( navigator.userAgent ) ||
               ( navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1 );   // iPadOS 13+
    }
    // A browser embedded in another app (Instagram, Facebook, WhatsApp...): it can
    // never install anything, the user has to open Nayive in a real browser first.
    function isInAppBrowser()
    {
        return /FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Twitter/i.test( navigator.userAgent );
    }

    // What can this device actually do right now?
    //   installed | prompt (Chromium) | ios (manual steps) | inapp | unsupported
    function installMode()
    {
        var v;
        try { v = localStorage.getItem( INSTALL_SNOOZE ); } catch ( _ ) {}
        if( isStandalone() || v === "installed" ) return "installed";
        if( deferredInstall )                     return "prompt";
        if( isIOS() )                             return "ios";
        if( isInAppBrowser() )                    return "inapp";
        return "unsupported";
    }

    function installSnoozed()
    {
        if( installLater ) return true;
        var v;
        try { v = localStorage.getItem( INSTALL_SNOOZE ); } catch ( _ ) { return false; }
        // "never" = "No mostrar más". Anything else (an old timestamp from the
        // days when "Ahora no" snoozed for a week) is ignored: it asks again.
        return v === "installed" || v === "never";
    }
    // "Ahora no": quiet for the rest of this visit, back on the next page load
    // (that is, on the next login). Deliberately NOT persisted anywhere.
    function snoozeInstall()
    {
        installLater = true;
    }
    // Permanent opt-out: the nudge never appears again on this device (the
    // launcher's "Instalar app" button still opens it by hand).
    function neverShowInstall()
    {
        try { localStorage.setItem( INSTALL_SNOOZE, "never" ); } catch ( _ ) {}
    }

    // One "icon + bold claim + sentence" row, same shape as the help dialog's list.
    function installRow( iconName, name, text )
    {
        var li = document.createElement( "li" );

        var ic = document.createElement( "span" );
        ic.className = "intro-btn-i";
        ic.innerHTML = icon( iconName );
        li.appendChild( ic );

        var box = document.createElement( "div" );
        box.className = "intro-btn-t";
        var b  = document.createElement( "b" );
        b.textContent = name;
        var sp = document.createElement( "span" );
        sp.textContent = text;
        box.appendChild( b );
        box.appendChild( sp );
        li.appendChild( box );
        return li;
    }

    // One numbered iOS step: the real glyph, then the sentence (its <b> part is
    // the label the user has to look for on screen).
    function installStep( iconName, before, strong, after )
    {
        var li = document.createElement( "li" );

        var ic = document.createElement( "span" );
        ic.className = "intro-btn-i";
        ic.innerHTML = icon( iconName );
        li.appendChild( ic );

        var sp = document.createElement( "span" );
        sp.appendChild( document.createTextNode( before ) );
        var b = document.createElement( "b" );
        b.textContent = strong;
        sp.appendChild( b );
        if( after ) sp.appendChild( document.createTextNode( after ) );
        li.appendChild( sp );
        return li;
    }

    function buildInstall( mode, manual )
    {
        var back = document.createElement( "div" );
        back.className = "sheet-backdrop";
        back.id        = "nayive-install-bar";
        back.setAttribute( "role", "dialog" );
        back.setAttribute( "aria-modal", "true" );

        var sheet = document.createElement( "div" );
        sheet.className = "sheet intro-sheet install-sheet";
        back.appendChild( sheet );

        var done = false;
        function finish()
        {
            if( done ) return;
            done = true;
            document.removeEventListener( "keydown", onKey, true );
            back.classList.remove( "open" );
            if( back.parentNode ) back.parentNode.removeChild( back );
        }
        function onKey( e )
        {
            if( e.key === "Escape" )
            {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                finish();
            }
        }
        back._finish = finish;

        // Corner x, sticky, above the title - like every other Nayive dialog.
        var xb = document.createElement( "button" );
        xb.type      = "button";
        xb.className = "sheet-close intro-close";
        xb.title     = t( "ui.close" );
        xb.setAttribute( "aria-label", xb.title );
        xb.innerHTML = icon( "x" );
        xb.addEventListener( "click", finish );
        sheet.appendChild( xb );

        var logo = document.createElement( "img" );
        logo.className = "install-logo";
        logo.src       = "/nayive/icons/icon-192.png";
        logo.alt       = "";
        sheet.appendChild( logo );

        var h = document.createElement( "h2" );
        h.className   = "install-title";
        h.textContent = mode === "installed"
            ? t( "ui.install.titleDone" )
            : t( "ui.install.title" );
        sheet.appendChild( h );

        var lead = document.createElement( "p" );
        lead.className   = "dialog-text install-lead";
        lead.textContent = mode === "installed"
            ? t( "ui.install.leadDone" )
            : t( "ui.install.lead" );
        sheet.appendChild( lead );

        if( mode !== "installed" )
        {
            var ul = document.createElement( "ul" );
            ul.className = "intro-btns";
            ul.appendChild( installRow( "grid", t( "ui.install.b1n" ),
                t( "ui.install.b1" ) ) );
            ul.appendChild( installRow( "fullscr", t( "ui.install.b2n" ),
                t( "ui.install.b2" ) ) );
            ul.appendChild( installRow( "bolt", t( "ui.install.b3n" ),
                t( "ui.install.b3" ) ) );
            sheet.appendChild( ul );
        }

        if( mode === "ios" )
        {
            var sub = document.createElement( "p" );
            sub.className   = "scm-h install-h";
            sub.textContent = t( "ui.install.stepsH" );
            sheet.appendChild( sub );

            var ol = document.createElement( "ol" );
            ol.className = "install-steps";
            ol.appendChild( installStep( "share",   t( "ui.install.s1a" ),
                                                    t( "ui.install.s1b" ),
                                                    t( "ui.install.s1c" ) ) );
            ol.appendChild( installStep( "addhome", t( "ui.install.s2a" ),
                                                    t( "ui.install.s2b" ),
                                                    t( "ui.install.s2c" ) ) );
            ol.appendChild( installStep( "check",   t( "ui.install.s3a" ),
                                                    t( "ui.install.s3b" ),
                                                    t( "ui.install.s3c" ) ) );
            sheet.appendChild( ol );
        }

        if( mode === "inapp" || mode === "unsupported" )
        {
            var note = document.createElement( "p" );
            note.className   = "dialog-text install-note";
            note.textContent = mode === "inapp"
                ? t( "ui.install.inapp" )
                : t( "ui.install.unsupported" );
            sheet.appendChild( note );
        }

        var acts = document.createElement( "div" );
        acts.className = "install-actions";

        if( mode === "prompt" )
        {
            var go = document.createElement( "button" );
            go.type        = "button";
            go.className   = "intro-dismiss primary";
            go.textContent = t( "ui.install.cta" );
            go.addEventListener( "click", async function ()
            {
                var evt = deferredInstall;
                finish();
                if( ! evt ) return;
                deferredInstall = null;
                try
                {
                    evt.prompt();
                    await evt.userChoice;      // {outcome:'accepted'|'dismissed'}
                }
                catch ( _ ) {}
            } );
            acts.appendChild( go );
        }

        // Only the automatic nudge offers to go away: if they opened it themselves
        // there is nothing to snooze.
        if( ! manual && mode !== "installed" )
        {
            var later = document.createElement( "button" );
            later.type        = "button";
            later.className   = "intro-dismiss";
            later.textContent = t( "ui.notNow" );
            later.addEventListener( "click", function () { snoozeInstall(); finish(); } );
            acts.appendChild( later );

            var never = document.createElement( "button" );
            never.type        = "button";
            never.className   = "intro-dismiss install-never";
            never.textContent = t( "ui.install.dismiss" );
            never.addEventListener( "click", function () { neverShowInstall(); finish(); } );
            acts.appendChild( never );
        }

        if( acts.children.length ) sheet.appendChild( acts );

        document.body.appendChild( back );
        document.addEventListener( "keydown", onKey, true );
        back.classList.add( "open" );
        xb.focus();
        return back;
    }

    // opts.manual: opened by the user (the launcher's "Instalar app" button) -
    // always shows, and always has something to say.
    function offerInstall( opts )
    {
        opts = opts || {};
        var manual = !! opts.manual;
        var mode   = installMode();

        if( manual ) installTries = 0;      // asked on purpose: it gets its own patience

        if( ! manual )
        {
            if( mode !== "prompt" && mode !== "ios" ) return;   // nothing real to offer
            if( installSnoozed() ) return;
        }

        if( document.getElementById( "nayive-install-bar" ) ) return;   // already up

        // Never on top of another sheet (welcome card, mandatory password...).
        // installPending keeps the launcher's two calls (300 ms + 1500 ms) from
        // both waiting here and then opening two dialogs. While a sheet is
        // visibly open we wait as long as it takes (the user is reading it);
        // the give-up only guards the "held but nothing on screen" case.
        if( introHeld || document.querySelector( ".sheet-backdrop.open" ) )
        {
            if( installPending ) return;
            if( ! document.querySelector( ".sheet-backdrop.open" ) && ++installTries > 15 )
                return;                            // ~12 s held with nothing visible: next visit
            installPending = true;
            setTimeout( function ()
            {
                installPending = false;
                offerInstall( opts );
            }, 800 );
            return;
        }

        return buildInstall( mode, manual );
    }

    //------------------------------------------------------------------------//
    // SERVICE-WORKER UPDATE CHECK
    //
    // The apps/sw.js worker controls the whole /nayive/ scope, and its install
    // calls skipWaiting() - so a newer worker takes over on the NEXT launch.
    // The catch: the browser only checks for a newer sw.js on its own schedule,
    // which iOS stretches to ~a day. So after a deploy the phone can sit on the
    // old version until then. This nudges that check on every load and every
    // time the app comes back to the foreground (throttled), so a deploy is
    // picked up within one open instead of one day. No cost to this launch -
    // the check and any download happen in the background.

    var lastSwPing = 0;

    function pingSwUpdate()
    {
        if( ! ( "serviceWorker" in navigator ) ) return;

        var now = Date.now();
        if( now - lastSwPing < 20 * 60 * 1000 ) return;   // at most once / 20 min per page
        lastSwPing = now;

        try
        {
            navigator.serviceWorker.getRegistration().then( function ( reg )
            {
                if( reg ) reg.update().catch( function () {} );
            } ).catch( function () {} );
        }
        catch ( _ ) {}
    }

    //------------------------------------------------------------------------//
    // "NEW VERSION" BAR
    //
    // pingSwUpdate() above gets the NEW worker installed; sw.js then calls
    // skipWaiting() + clients.claim(), so it takes over this page's fetches at
    // once. But THIS document keeps running the HTML and the JS it was loaded
    // with - only a navigation picks the new build up, and tapping a PWA's icon
    // usually RESUMES the page rather than reloading it. Without this the phone
    // can sit on the old version until its storage is cleared by hand.
    //
    // clients.claim() fires "controllerchange" here; we offer a reload rather
    // than forcing one - Write/SuperDoc may hold unsaved text, and share-target
    // is mid-upload when it runs.

    var updateBar = null;

    function showUpdateBar()
    {
        // Deferred until there is a <body> to append to: the listener is armed
        // at load, so the worker can win the race against DOMContentLoaded.
        if( ! document.body )
            return document.addEventListener( "DOMContentLoaded", showUpdateBar );

        if( updateBar && document.body.contains( updateBar ) ) return;   // one bar per page

        // A 401 bar means a reload would only bounce to the sign-in page; the
        // new build arrives with that navigation anyway.
        if( sessionBar && document.body.contains( sessionBar ) ) return;

        var bar = document.createElement( "div" );
        bar.className = "session-bar";                  // same one bar style (theme.css)
        bar.id        = "nayive-update-bar";
        bar.setAttribute( "role", "status" );

        var msg = document.createElement( "span" );
        msg.textContent = t( "ui.update.available" );

        var btn = document.createElement( "button" );
        btn.type        = "button";
        btn.className   = "session-bar-btn";
        btn.textContent = t( "ui.update.reload" );
        btn.addEventListener( "click", function ()
        {
            // A navigation: htmlStrategy answers it from the NEW worker's cache.
            window.location.reload();
        } );

        bar.appendChild( msg );
        bar.appendChild( btn );
        document.body.appendChild( bar );
        updateBar = bar;
    }

    // Armed at load, NOT in uiInit(): a warm update is mostly cache-to-cache and
    // can activate before DOMContentLoaded fires on these big inline-HTML pages.
    ( function watchForNewWorker()
    {
        if( ! ( "serviceWorker" in navigator ) ) return;

        // No controller yet = this is the FIRST install. clients.claim() fires
        // controllerchange for that too, and there is nothing new to reload to.
        var hadController = !! navigator.serviceWorker.controller;

        try
        {
            navigator.serviceWorker.addEventListener( "controllerchange", function ()
            {
                if( ! hadController ) return;

                // The planner embeds the other apps in iframes; each one would
                // raise its own bar, and reloading a frame alone fixes nothing.
                // The top-level page gets this same event and handles it.
                try { if( window.top !== window ) return; } catch ( e ) { return; }

                showUpdateBar();
            } );
        }
        catch ( _ ) {}
    } )();

    /* -----------------------------------------------------------------------
     * SHARING  -  read-only, between Nayive users
     *
     * A share lets another user of THIS server see one file or one folder of
     * yours. They can look, never change: the server roots their "shared/<slug>"
     * path at your folder with writable=false, so every write is refused there
     * (lib/shares.py + users.resolve_path).
     *
     * isShared( path ) is what every app uses to switch itself to read-only.
     * ---------------------------------------------------------------------*/
    function isShared( path )
    {
        var p = String( path || "" );
        // "shared" itself is the virtual "Compartido conmigo" folder - nothing of
        // ours either, so Drive's Nueva carpeta / Subir must be off there too.
        return p === "shared" || p.indexOf( "shared/" ) === 0;
    }

    /* Everything shared WITH us, fetched once and remembered for the life of the
     * page. Both Drive and Photos need the same answer ("may I add files here?")
     * and neither should ask the server again on every render.
     * Returns a promise of the /api/shares "with_me" array, [] on any failure. */
    var _withMe = null;

    function sharedWithMe()
    {
        if( ! _withMe )
            _withMe = fetch( window.location.origin + "/api/shares" )
                .then( function ( r ) { return r.ok ? r.json() : {}; } )
                .then( function ( j ) { return j.with_me || []; } )
                .catch( function () { return []; } );
        return _withMe;
    }

    /* The grant a "shared/<slug>/..." path belongs to, or null. */
    function sharedGrantFor( path, grants )
    {
        var p = String( path || "" );
        for( var i = 0; i < grants.length; i++ )
        {
            var root = grants[ i ].path;                 // "shared/<slug>"
            if( p === root || p.indexOf( root + "/" ) === 0 ) return grants[ i ];
        }
        return null;
    }

    /* Promise of true when this path sits in a folder somebody shared with us
     * AND they ticked "pueden añadir archivos". Adding is ALL it allows: the
     * server still refuses overwrite, delete, rename and re-sharing there
     * (lib/shares.py MODES). A path of our own resolves to false - our own
     * folders are not "shared", they are simply ours. */
    function canAddTo( path )
    {
        if( ! isShared( path ) ) return Promise.resolve( false );

        return sharedWithMe().then( function ( grants )
        {
            var g = sharedGrantFor( path, grants );
            return !! ( g && g.mode === "add" && ! g.gone );
        } );
    }

    // "[candado] \u00b7 de mar\u00eda" - the chip a read-only app shows in its header.
    // The blue padlock says "you cannot change this"; the words say whose it is.
    // The full sentence stays as the tooltip / aria-label, for anyone who does
    // not read the glyph.
    function sharedBadge( by )
    {
        var el = document.createElement( "span" );
        el.className = "ro-badge";
        el.innerHTML = icon( "lock" );

        if( by )
        {
            var who = document.createElement( "span" );
            who.textContent = tf( "share.byline", { who: by } );
            el.appendChild( who );
        }

        var full = by ? tf( "share.bytitle", { who: by } )
                      : t( "share.readonly" );
        el.title = full;
        el.setAttribute( "aria-label", full );
        return el;
    }

    function shareApi( method, body, id )
    {
        var url  = window.location.origin + "/api/shares" + ( id ? "?id=" + encodeURIComponent( id ) : "" );
        var opts = { method: method };
        if( body ) { opts.body = JSON.stringify( body ); opts.headers = { "Content-Type": "application/json" }; }

        return fetch( url, opts ).then( function ( r )
        {
            return r.json().catch( function () { return {}; } ).then( function ( j )
            {
                if( ! r.ok ) throw new Error( j.error || ( "HTTP " + r.status ) );
                return j;
            } );
        } );
    }

    /* The "Compartir" dialog: tick one or more people, see who already has it, take it back.
     * opts = { path, app, title }. Resolves when the dialog closes. */
    function shareSheet( opts )
    {
        opts = opts || {};
        var path = opts.path || "";

        return new Promise( function ( resolve )
        {
            var back = document.createElement( "div" );
            back.className = "sheet-backdrop";
            back.setAttribute( "role", "dialog" );
            back.setAttribute( "aria-modal", "true" );

            var sheet = document.createElement( "div" );
            sheet.className = "sheet";
            back.appendChild( sheet );

            var users = [], mine = [], chosen = [];   // chosen = every person ticked right now
            var mayAdd = false;                      // "pueden añadir archivos" ticked?

            function close()
            {
                back.classList.remove( "open" );
                setTimeout( function () { if( back.parentNode ) back.parentNode.removeChild( back ); }, 200 );
                resolve();
            }

            var ok = null;   // the "Compartir" button, so a tick-box can enable it

            function render()
            {
                ok = null;
                sheet.innerHTML = "";

                var h = document.createElement( "h2" );
                h.textContent = t( "share.title" );
                sheet.appendChild( h );

                var lead = document.createElement( "p" );
                lead.className = "dialog-text";
                var what = opts.title || path.split( "/" ).pop();

                // The lead says what the share will actually allow, so it never
                // contradicts the "pueden añadir" tick below it.
                function setLead()
                {
                    lead.textContent = mayAdd
                        ? tf( "share.leadadd", { what: what } )
                        : tf( "share.lead", { what: what } );
                }
                setLead();
                sheet.appendChild( lead );

                // --- who already has it ---
                if( mine.length )
                {
                    var have = document.createElement( "div" );
                    have.className = "share-have";
                    mine.forEach( function ( g )
                    {
                        var row = document.createElement( "div" );
                        row.className = "share-row";

                        var who = document.createElement( "span" );
                        who.textContent = g.mode === "add"
                                        ? tf( "share.hasadd", { who: g.to } )
                                        : g.to;
                        row.appendChild( who );

                        var del = document.createElement( "button" );
                        del.type      = "button";
                        del.className = "share-drop";
                        del.title     = t( "share.stop" );
                        del.innerHTML = icon( "x" );
                        del.addEventListener( "click", function ()
                        {
                            del.disabled = true;
                            shareApi( "DELETE", null, g.id )
                                .then( load )
                                .catch( function ( e ) { toast( e.message ); del.disabled = false; } );
                        } );
                        row.appendChild( del );
                        have.appendChild( row );
                    } );
                    sheet.appendChild( have );
                }

                // --- who else could have it ---
                var already = mine.map( function ( g ) { return g.to; } );
                var free    = users.filter( function ( n ) { return already.indexOf( n ) === -1; } );

                if( ! free.length )
                {
                    var none = document.createElement( "p" );
                    none.className   = "fp-msg";
                    none.textContent = users.length
                        ? t( "share.everyone" )
                        : t( "share.nobody" );
                    sheet.appendChild( none );
                }
                else
                {
                    var list = document.createElement( "div" );
                    list.className = "share-pick";
                    list.setAttribute( "role", "group" );
                    list.setAttribute( "aria-label", t( "share.pick" ) );

                    free.forEach( function ( name )
                    {
                        var on  = chosen.indexOf( name ) !== -1;
                        var lab = document.createElement( "label" );
                        lab.className = "share-user" + ( on ? " on" : "" );

                        // A plain <input type="checkbox"> inside a <label>: every browser
                        // draws it, and clicking the name ticks it. No custom drawing.
                        var box = document.createElement( "input" );
                        box.type    = "checkbox";
                        box.value   = name;
                        box.checked = on;
                        box.addEventListener( "change", function ()
                        {
                            var at = chosen.indexOf( name );
                            if( box.checked ) { if( at === -1 ) chosen.push( name ); }
                            else if( at !== -1 ) chosen.splice( at, 1 );

                            // No render() here: it would scroll the list back to the top.
                            lab.classList.toggle( "on", box.checked );
                            if( ok ) ok.disabled = ! chosen.length;
                        } );

                        lab.appendChild( box );
                        lab.appendChild( document.createTextNode( name ) );
                        list.appendChild( lab );
                    } );
                    sheet.appendChild( list );
                }

                // --- may they add files of their own? ---
                // Only offered for a FOLDER (opts.canAdd) - there is nothing to
                // add to a single file, and a trip folder holds a JSON document
                // the apps rewrite whole. Adding is all it grants: the server
                // still refuses overwrite, delete, rename and re-share.
                if( opts.canAdd && free.length )
                {
                    var addLab = document.createElement( "label" );
                    addLab.className = "share-add";

                    var addBox = document.createElement( "input" );
                    addBox.type    = "checkbox";
                    addBox.checked = mayAdd;
                    addBox.addEventListener( "change", function ()
                    {
                        mayAdd = addBox.checked;
                        setLead();          // no render(): that would scroll the list back to the top
                    } );

                    addLab.appendChild( addBox );
                    addLab.appendChild( document.createTextNode(
                        t( "share.mayadd" ) ) );
                    sheet.appendChild( addLab );
                }

                // --- buttons ---
                var row2 = document.createElement( "div" );
                row2.className = "sheet-actions";

                var cancel = document.createElement( "button" );
                cancel.setAttribute( "data-act", "close" );
                cancel.title = t( "ui.close" );
                cancel.addEventListener( "click", close );
                row2.appendChild( cancel );

                if( free.length )
                {
                    ok = document.createElement( "button" );
                    ok.setAttribute( "data-act", "primary" );
                    ok.title    = t( "share.send" );
                    ok.disabled = ! chosen.length;
                    ok.addEventListener( "click", function ()
                    {
                        if( ! chosen.length ) return;
                        ok.disabled = true;

                        var done = [];

                        // One POST per person, one after another. Each success drops that
                        // name from "chosen", so if one fails the rest stay ticked.
                        chosen.slice().reduce( function ( chain, name )
                        {
                            return chain.then( function ()
                            {
                                return shareApi( "POST", { to: name, root: path,
                                                           app: opts.app || "folder", title: opts.title || "",
                                                           mode: mayAdd ? "add" : "ro" } )
                                    .then( function ()
                                    {
                                        done.push( name );
                                        var at = chosen.indexOf( name );
                                        if( at !== -1 ) chosen.splice( at, 1 );
                                    } );
                            } );
                        }, Promise.resolve() )
                        .then( function ()
                        {
                            toast( tf( "share.done", { who: done.join( ", " ) } ) );
                            return load();
                        } )
                        .catch( function ( e ) { toast( e.message ); return load(); } );
                    } );
                    row2.appendChild( ok );
                }

                sheet.appendChild( row2 );
                applySheetButtons( sheet );
            }

            function load()
            {
                return Promise.all( [
                    fetch( window.location.origin + "/api/users" ).then( function ( r ) { return r.json(); } ),
                    shareApi( "GET" )
                ] ).then( function ( res )
                {
                    users = ( res[ 0 ] && res[ 0 ].users ) || [];
                    mine  = ( ( res[ 1 ] && res[ 1 ].mine ) || [] )
                                .filter( function ( g ) { return g.root === path; } );
                    render();
                } ).catch( function ( e )
                {
                    toast( e.message || t( "ui.loadFailed" ) );
                    render();
                } );
            }

            document.body.appendChild( back );
            render();
            back.classList.add( "open" );
            load();

            back.addEventListener( "keydown", function ( e )
            {
                if( e.key === "Escape" ) close();
            } );
        } );
    }

    //------------------------------------------------------------------------//
    // "YOUR SESSION EXPIRED" BAR
    //
    // The session table lives in the server's RAM, so a session dies on the idle
    // timeout AND on every server restart (i.e. on every deploy). Nothing polls
    // for it: the first sign is a request answered 401, and each app used to
    // guess on its own - Drive said "no se pudo crear la carpeta", Text said
    // "comprueba tu conexión", the store apps only turned a dot red. This is the
    // one bar, the one message and the one way out for all of them.
    //
    // Called by shared/gum-api.js (assertOk) and shared/store.js (netGet/netPut)
    // on a real 401 only - never on a 403, which here means "not yours /
    // read-only", and never for the /api/whoami boot probe, whose 401 every app
    // already handles by itself.
    //
    // It deliberately does NOT redirect on its own. Apps that hold state in
    // memory (an unnamed Text/Calc document, a half-filled admin form) would
    // lose it, so the user picks the moment. Everything wired to shared/store.js
    // has already kept the edit locally; signing in again just flushes it.

    var sessionBar = null;

    function sessionExpired()
    {
        if( ! document.body ) return;
        if( sessionBar && document.body.contains( sessionBar ) ) return;   // one bar per page, however many 401s

        // Both bars are fixed to the top at z-index 400; a 401 outranks a
        // pending update (the reload would only bounce to the sign-in page).
        if( updateBar ) { updateBar.remove(); updateBar = null; }

        var bar = document.createElement( "div" );
        bar.className = "session-bar";
        bar.id        = "nayive-session-bar";
        bar.setAttribute( "role", "alert" );

        var msg = document.createElement( "span" );
        msg.textContent = t( "ui.session.expired" );

        var btn = document.createElement( "button" );
        btn.type        = "button";
        btn.className   = "session-bar-btn";
        btn.textContent = t( "ui.session.login" );
        btn.addEventListener( "click", function ()
        {
            if( window.GumApi ) return GumApi.loginRedirect();

            // admin.html (and anything else that loads ui.js on its own) has no
            // GumApi: same redirect, done here. Framed pages navigate the TOP
            // window or the sign-in form would open inside the frame.
            var win = window;
            try { if( window.top !== window && window.top.location.pathname ) win = window.top; }
            catch ( e ) {}
            win.location.href = "/nayive/login.html?return=" +
                encodeURIComponent( win.location.pathname + win.location.search );
        } );

        bar.appendChild( msg );
        bar.appendChild( btn );
        document.body.appendChild( bar );
        sessionBar = bar;
    }

    //------------------------------------------------------------------------//
    // UPLOAD PROGRESS BAR
    //
    // GumApi.putBinary announces every upload as "nayive:upload" events on the
    // document ({ id, loaded, total }, then { id, done: true }). Most uploads -
    // a settings file, a thumbnail - finish at once and must show nothing, so
    // the bar appears only once a BURST of uploads has run for UPLOAD_SHOW_MS.
    // A burst, not one request: Photos and Drive send many files one after
    // another, and each alone may be quick. It hides UPLOAD_HIDE_MS after the
    // last one ends, so it does not flicker in the gap between two files.
    //
    // The percent is of what is in flight NOW; the apps already say "3 de 12"
    // in their own status line when they send several. Styled in theme.css.

    var UPLOAD_SHOW_MS = 600;
    var UPLOAD_HIDE_MS = 400;

    var uploads     = {};     // id -> { loaded, total }, the requests in flight
    var uploadBar   = null;
    var burstStart  = 0;      // when the current burst began; 0 = none
    var uploadShowT = null;
    var uploadHideT = null;

    function uploadsBusy() { return Object.keys( uploads ).length > 0; }

    function uploadPercent()
    {
        var loaded = 0, total = 0;
        for( var id in uploads ) { loaded += uploads[ id ].loaded; total += uploads[ id ].total; }
        return total > 0 ? Math.min( 100, Math.floor( loaded * 100 / total ) ) : 0;
    }

    function drawUploadBar( pct )
    {
        if( ! document.body ) return;

        if( ! uploadBar || ! document.body.contains( uploadBar ) )
        {
            uploadBar = document.createElement( "div" );
            uploadBar.className = "upload-bar";
            uploadBar.setAttribute( "role", "progressbar" );
            uploadBar.setAttribute( "aria-valuemin", "0" );
            uploadBar.setAttribute( "aria-valuemax", "100" );
            uploadBar.innerHTML = '<span class="upload-bar-text"></span>' +
                                  '<span class="upload-bar-track"><span class="upload-bar-fill"></span></span>';
            document.body.appendChild( uploadBar );
        }

        uploadBar.setAttribute( "aria-valuenow", String( pct ) );
        uploadBar.querySelector( ".upload-bar-text" ).textContent = tf( "ui.uploading", { pct: pct } );
        uploadBar.querySelector( ".upload-bar-fill" ).style.width = pct + "%";
        uploadBar.classList.add( "show" );
    }

    function uploadBarShown() { return !! ( uploadBar && uploadBar.classList.contains( "show" ) ); }

    function endUploadBurst()
    {
        uploadHideT = null;
        clearTimeout( uploadShowT );      // a burst that ended before the bar was due
        uploadShowT = null;
        burstStart  = 0;
        if( uploadBar ) uploadBar.classList.remove( "show" );
    }

    function onUploadEvent( e )
    {
        var d = e.detail || {};
        if( d.done ) delete uploads[ d.id ];
        else         uploads[ d.id ] = { loaded: d.loaded || 0, total: d.total || 0 };

        if( uploadsBusy() )
        {
            clearTimeout( uploadHideT );
            uploadHideT = null;
            if( ! burstStart ) burstStart = Date.now();

            var waited = Date.now() - burstStart;
            if( waited >= UPLOAD_SHOW_MS )
                drawUploadBar( uploadPercent() );
            else if( ! uploadShowT )
                uploadShowT = setTimeout( function ()
                {
                    uploadShowT = null;
                    // In a gap between two files: the next one draws it at once.
                    if( uploadsBusy() ) drawUploadBar( uploadPercent() );
                }, UPLOAD_SHOW_MS - waited );
        }
        else
        {
            if( uploadBarShown() ) drawUploadBar( 100 );   // it did finish
            if( ! uploadHideT ) uploadHideT = setTimeout( endUploadBurst, UPLOAD_HIDE_MS );
        }
    }

    document.addEventListener( "nayive:upload", onUploadEvent );


    //------------------------------------------------------------------------//
    // SMALL SHARED HELPERS  (2026-09-06: what every app had its own copy of)

    // HTML-escape for the few places an app builds markup from data.
    function escapeHtml( s )
    {
        return String( s == null ? "" : s ).replace( /[&<>"']/g, function ( c )
        {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ c ];
        } );
    }

    function pad2( n ) { return ( n < 10 ? "0" : "" ) + n; }

    // Today as yyyy-mm-dd in the device's local day (the Nayive date rule).
    function todayIso()
    {
        var d = new Date();
        return d.getFullYear() + "-" + pad2( d.getMonth() + 1 ) + "-" + pad2( d.getDate() );
    }

    //------------------------------------------------------------------------//
    // THE SYNC INDICATOR  -  one mapping from shared/store.js states to the
    // header plug, for every app that syncs through the store.
    //
    //   synced           green   plugged in    - the server has the latest
    //   loading/saving   blue    plugged in    - a GET / PUT is in flight
    //   offline/pending  gold    unplugged     - edits are safe in the local cache
    //   error/needs-auth red     unplugged     - attention
    //
    // Titles are the `ui.sync.*` keys; a <button> indicator (the store apps,
    // where the plug is also the refresh control) gets the "tap to refresh"
    // hint appended. opts.titles overrides a state's key (the office apps say
    // "not uploaded yet" rather than "changes queued").
    var SYNC_KEYS = { synced: "synced", loading: "loading", saving: "saving",
                      offline: "offline", pending: "pending", "needs-auth": "needsAuth" };

    function applySyncState( el, state, opts )
    {
        if( typeof el === "string" ) el = byId( el );
        if( ! el ) return;
        opts = opts || {};

        el.classList.toggle( "synced",  state === "synced" );
        el.classList.toggle( "busy",    state === "loading" || state === "saving" );
        el.classList.toggle( "offline", state === "offline" || state === "pending" );

        var key = ( opts.titles && opts.titles[ state ] ) || ( "ui.sync." + ( SYNC_KEYS[ state ] || "error" ) );
        var hint = ( opts.tapHint != null ? opts.tapHint : el.tagName === "BUTTON" ) ? t( "ui.sync.tapHint" ) : "";
        el.title = t( key ) + hint;

        // Stamped so bootWithStore can tell "nobody has touched this plug yet"
        // (settle it) from "the app deliberately put it here" (leave it alone -
        // Write's imported-but-never-saved document is red on purpose).
        el.dataset.syncState = state;
    }

    // A ready-made store.onState listener for the #syncIndicator of the page.
    function syncIndicator( opts )
    {
        return function ( state ) { applySyncState( byId( ( opts && opts.id ) || "syncIndicator" ), state, opts ); };
    }

    //------------------------------------------------------------------------//
    // BOOT  -  the access probe every store-backed app starts with.
    //
    //   NayiveUI.bootWithStore( store, async function ( who ) { ...load + render... } );
    //
    // Probes /api/whoami. On success `start( who )` runs with { user, role } -
    // unless the probe brought back an account language this device does not
    // have yet, in which case it is stored and the page reloads instead.
    // On failure the page bounces to the sign-in screen ONLY when it is really
    // online and the store holds nothing - a genuine "you must authenticate";
    // otherwise it opens on the local cache (start( null )) and the store syncs
    // once the connection is back. #app (or opts.appId) is shown before start.
    //
    // An app can open without reading or writing a single file - Calc on a blank
    // sheet, Write on a new document. store.onState() only fires on real traffic,
    // so the header plug would still be on its "no state yet" resting class: RED,
    // with nothing whatever wrong. store.resting() recomputes the true resting
    // state from the outbox (synced / pending / offline) and emits it, so those
    // apps open green like every other one. Opts.resting: false turns it off.
    async function bootWithStore( store, start, opts )
    {
        opts = opts || {};
        var who = null;
        try { who = await GumApi.probeAccess(); }
        catch ( _ )
        {
            var cached = false;
            try { cached = store ? await store.hasAnyCache() : false; } catch ( e ) {}
            if( navigator.onLine && ! cached ) { GumApi.loginRedirect(); return null; }
        }
        // The language belongs to the ACCOUNT, and it outranks this device's:
        // pick Spanish on the phone and this PC follows on its next boot. The
        // probe above already carries it, so this costs no extra request. When
        // adopt() takes it, a reload is on its way - stop here rather than
        // render a frame that gets thrown away (and flashes the old language).
        if( who && window.NayiveI18n && NayiveI18n.adopt && NayiveI18n.adopt( who.lang ) )
            return null;
        var app = byId( opts.appId || "app" );
        if( app ) app.style.display = "";
        await start( who );

        var dot = byId( opts.indicatorId || "syncIndicator" );

        if( store && store.resting && store.state === "init" && opts.resting !== false
            && dot && ! dot.dataset.syncState )
            try { await store.resting(); } catch ( e ) {}

        return who;
    }

    //------------------------------------------------------------------------//
    // AUTO RE-READ  -  "the plug is the refresh button" (see docs/shared-modules.md)
    //
    //   var rf = NayiveUI.wireRefresh( { store: store, read: loadTasks, guard: isEditing } );
    //   rf.refreshNow()          the plug's click: flush the outbox, then re-read
    //   rf.maybeRefresh( force ) the single re-read path with this app's guards
    //
    // Installs: visibilitychange -> maybeRefresh( true, "visible" ) [then
    // opts.onVisible]; window focus -> maybeRefresh( false, "focus" ), throttled to
    // once per opts.throttleMs (20 s) - a window that never leaves the screen (a
    // second monitor, a Planner pane) never fires visibilitychange; the
    // #syncIndicator click -> refreshNow; and window.nayiveRefresh = refreshNow for
    // Planner's single plug.
    //
    // `guard( force, why )` returns true while a re-read must NOT happen (a sheet is
    // open, text is being typed); the default is "any .sheet-backdrop is open".
    // `why` is "visible" / "focus" / "plug", so an app can tell a DELIBERATE refresh
    // from an automatic one - Trips lets the plug re-read from any screen but keeps
    // the automatic paths on the trip list, where re-rendering costs nothing.
    function wireRefresh( opts )
    {
        opts = opts || {};
        var lastRefresh = 0;
        var throttle    = opts.throttleMs || 20000;
        var guard       = opts.guard || function () { return !! document.querySelector( ".sheet-backdrop.open" ); };

        async function maybeRefresh( force, why )
        {
            if( ! force && Date.now() - lastRefresh < throttle ) return;
            if( guard( force, why || "plug" ) ) return;
            lastRefresh = Date.now();          // stamped only when a read really happens
            await opts.read( force );
        }

        async function refreshNow()
        {
            if( opts.store ) opts.store.flush();
            await maybeRefresh( true, "plug" );
        }

        window.nayiveRefresh = refreshNow;

        document.addEventListener( "visibilitychange", async function ()
        {
            if( document.visibilityState !== "visible" ) return;
            await maybeRefresh( true, "visible" );
            if( opts.onVisible ) opts.onVisible();
        } );
        window.addEventListener( "focus", function () { maybeRefresh( false, "focus" ); } );

        var dot = byId( opts.indicatorId || "syncIndicator" );
        if( dot && dot.tagName === "BUTTON" ) dot.addEventListener( "click", refreshNow );

        return { maybeRefresh: maybeRefresh, refreshNow: refreshNow };
    }

    //------------------------------------------------------------------------//
    // UNDO TOAST  -  "Eliminado  [Deshacer]" for a few seconds. Paired CSS
    // (.toast.actionable / .toast-undo) lives in shared/theme.css.
    function undoToast( msg, fn, opts )
    {
        opts = opts || {};
        var tt = byId( opts.id || "toast" );
        if( ! tt ) return;

        clearTimeout( tt._nayiveToastTimer );
        tt.textContent = msg;

        var b = document.createElement( "button" );
        b.type        = "button";
        b.className   = "toast-undo";
        b.textContent = opts.label || t( "ui.undo" );
        b.addEventListener( "click", function ()
        {
            clearTimeout( tt._nayiveToastTimer );
            tt.classList.remove( "show", "actionable" );
            fn();
        } );
        tt.appendChild( b );

        tt.classList.add( "actionable", "show" );
        tt._nayiveToastTimer = setTimeout( function ()
        {
            tt.classList.remove( "show" );
            setTimeout( function () { tt.classList.remove( "actionable" ); }, 250 );
        }, opts.ms || 6000 );
    }

    //------------------------------------------------------------------------//
    // "MORE" MENU  -  the small popup a header "..." button opens (view switch
    // in Calendar, the phone-only import / export in Contacts, the file buttons
    // in Calc / Write). The menu is a `.top-menu` (shared/app.css: position
    // fixed) anchored under its button; a click on an item, outside, Escape,
    // or a resize closes it.
    //
    //   var menu = NayiveUI.wireMenu( { btn: "moreBtn", menu: "topMenu",
    //                                   onPick: function ( item ) { ... } } );
    //   menu.open() / menu.close() / menu.isOpen()
    function wireMenu( opts )
    {
        var btn  = typeof opts.btn  === "string" ? byId( opts.btn )  : opts.btn;
        var menu = typeof opts.menu === "string" ? byId( opts.menu ) : opts.menu;
        if( ! btn || ! menu ) return null;

        function place()
        {
            var r = btn.getBoundingClientRect();
            menu.style.top   = ( r.bottom + 4 ) + "px";
            menu.style.left  = "auto";
            menu.style.right = Math.max( 6, window.innerWidth - r.right ) + "px";
        }
        function isOpen() { return ! menu.hidden; }
        function open()
        {
            place();
            menu.hidden = false;
            btn.setAttribute( "aria-expanded", "true" );
        }
        function close()
        {
            if( menu.hidden ) return;
            menu.hidden = true;
            btn.setAttribute( "aria-expanded", "false" );
        }

        btn.addEventListener( "click", function ( e )
        {
            e.stopPropagation();                  // or the document handler below closes it again
            if( isOpen() ) close(); else open();
        } );
        menu.addEventListener( "click", function ( e )
        {
            var item = e.target.closest( "button" );
            if( ! item ) return;
            close();
            if( opts.onPick ) opts.onPick( item );
        } );
        document.addEventListener( "click", function ( e )
        {
            if( isOpen() && ! menu.contains( e.target ) && ! btn.contains( e.target ) ) close();
        } );
        document.addEventListener( "keydown", function ( e )
        {
            if( e.key === "Escape" && isOpen() ) { e.preventDefault(); close(); }
        } );
        window.addEventListener( "resize", close );

        return { open: open, close: close, isOpen: isOpen };
    }

    //------------------------------------------------------------------------//
    // DIALOG CLOSING  -  the one rule for the whole suite (see the DIALOG block
    // in shared/app.css): a static .sheet-backdrop closes on its own × / ✓
    // buttons and on Escape - never on a backdrop click. Wired ONCE here, for
    // every dialog written in the page's HTML: a click on its close button
    // (data-act="close", flagged _nayiveClose by applySheetButtons) or Escape
    // while it is the top-most open sheet closes it. The dialogs ui.js builds
    // on the fly carry no id and handle their own closing.
    function topSheetBackdrop()
    {
        var list = document.querySelectorAll( ".sheet-backdrop.open" );
        return list.length ? list[ list.length - 1 ] : null;
    }

    function closeSheetBackdrop( back )
    {
        if( ! back || ! back.id ) return false;
        back.classList.remove( "open" );
        return true;
    }

    function wireSheetClosing()
    {
        document.addEventListener( "click", function ( e )
        {
            var b = e.target.closest && e.target.closest( "button" );
            if( ! b || ! b._nayiveClose ) return;
            var back = b.closest( ".sheet-backdrop" );
            if( back && back.id && back.classList.contains( "open" ) )
                setTimeout( function () { closeSheetBackdrop( back ); }, 0 );   // after the app's own handler
        } );

        document.addEventListener( "keydown", function ( e )
        {
            if( e.key !== "Escape" || e.defaultPrevented ) return;
            var back = topSheetBackdrop();
            if( ! back || ! back.id ) return;
            // Prefer the dialog's own close button: an app may reset state in its handler.
            var x = back.querySelector( "button.sheet-close, button.btn-secondary" );
            if( x && x._nayiveClose ) { x.click(); return; }
            closeSheetBackdrop( back );
        } );
    }

    function uiInit()
    {
        applyI18n();
        applySheetButtons();
        localizeDateTimeInputs();
        applyInfoDots();
        applyHomeLinks();
        applySyncDots();
        initDragSheets();
        wireSheetClosing();

        // uiInit runs at DOMContentLoaded; the dictionary usually lands a moment
        // later, and applySheetButtons / applyInfoDots may have added keys of
        // their own, so translate once more when it does.
        i18nReady.then( function () { applyI18n(); } );

        pingSwUpdate();
        document.addEventListener( "visibilitychange", function ()
        {
            if( document.visibilityState === "visible" ) pingSwUpdate();
        } );
    }

    if( document.readyState === "loading" )
        document.addEventListener( "DOMContentLoaded", uiInit );
    else
        uiInit();

    window.NayiveUI = {
        setOpen:  setOpen,
        open:     open,
        close:    close,
        pack:     packSheet,   // shrink a dialog to its content width (or .sheet--pack)
        toast:    toast,
        sessionExpired: sessionExpired,   // the shared "your session expired" bar (gum-api / store call it)
        viewerTz: viewerTz,
        escapeHtml: escapeHtml,
        pad2:       pad2,
        todayIso:   todayIso,
        applySyncState: applySyncState,   // store state -> the header plug (classes + title)
        syncIndicator:  syncIndicator,    // a ready store.onState listener for #syncIndicator
        bootWithStore:  bootWithStore,    // the access probe + "open from cache" fallback
        wireRefresh:    wireRefresh,      // visibilitychange / focus / plug-click re-read
        undoToast:      undoToast,        // "Eliminado [Deshacer]"
        wireMenu:       wireMenu,         // the header "..." popup menu
        icon:              icon,
        t:         t,
        tf:        tf,
        applyI18n: applyI18n,
        i18nReady: i18nReady,
        lang:      I18N ? I18N.lang    : function () { return "es"; },
        saved:     I18N ? I18N.saved   : function () { return null; },
        locale:    I18N ? I18N.locale  : function () { return "es"; },
        weekday:   I18N ? I18N.weekday : function ( n ) { return String( n ); },
        month:     I18N ? I18N.month   : function ( n ) { return String( n ); },
        langs:     I18N ? I18N.langs   : [],
        setLang:   I18N ? I18N.setLang : function () {},
        applySheetButtons: applySheetButtons,
        applyInfoDots:     applyInfoDots,
        applyHomeLinks:    applyHomeLinks,
        applySyncDots:     applySyncDots,
        embedded:          EMBEDDED,     // true inside Planner's iframes
        localizeDateTimeInputs: localizeDateTimeInputs,
        confirm:  confirmDialog,
        alert:    alertDialog,
        fmtBytes:   fmtBytes,
        ensureRoom: ensureRoom,
        firstRun:  firstRun,      // register the help dialog for this app
        setIntro:  setIntro,      // swap that dialog when the app changes screen
        showIntro: showIntro,     // open it now (the toolbar "?" button)
        showCoach: showCoach,     // the once-ever "name = inicio" / "? = ayuda" bubbles
        holdIntro: holdIntro,     // suppress + close the auto help card for this load
        isShared:     isShared,
        sharedWithMe: sharedWithMe,   // everything shared WITH us, fetched once per page
        canAddTo:     canAddTo,
        sharedBadge:  sharedBadge,
        shareSheet:   shareSheet,
        pickFolder:           pickFolder,
        launcherFolder:       launcherFolder,
        changeLauncherFolder: changeLauncherFolder,
        offerInstall:         offerInstall,
        isStandalone:         isStandalone,
        installMode:          installMode,
        startTour:    defaultTour    // firstRun re-points this at the app's intro card
    };
} )();
