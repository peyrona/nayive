// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
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
 *     applyI18n / lang / locale / weekday / month
 *   - dialog action buttons: the one Nayive style (see Calendar -> "Ir a mes").
 *   - the info dot: a circled "i" by a label that opens a small popup
 *     (NayiveUI.applyInfoDots; paired CSS .info-dot / .info-popup in app.css).
 *   - movable dialogs: drag any open .sheet from a free spot (see MOVABLE
 *     DIALOGS below). Wired once for the whole page, no per-dialog code.
 *   - dialogs open with the caret already in their first field (see DIALOG
 *     FIRST FIELD below). Also wired once, nothing to add to a new dialog.
 *   - embedded mode: when the page runs inside another Nayive page's <iframe>
 *     (Planner frames calendar + tasks + habits) the <html> gets .is-embedded, app.css
 *     hides the app's own title / sync dot (the host shows them once), and
 *     anything that must leave the frame (home link, sign-in) navigates the TOP
 *     window. When the host
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
 * button is moved to the sheet's top-right corner, on the title's line (class
 * `.sheet-close`, styled in shared/theme.css) and the empty row is dropped - a bottom row is only for
 * dialogs that also have a primary / danger action.
 *
 * A SETTINGS dialog has no ✓ at all: every change is kept (on change, or when
 * it closes) and its × just closes - see CLOSE-ONLY DIALOGS below.
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

    // WINDOWED - framed, but as a whole app in a window of the desktop
    // (desktop/index.html), not as a pane of another app. It keeps its own
    // icon, title and sync dot - that row IS the window's title bar - so it gets
    // html.is-windowed instead of .is-embedded. Still EMBEDDED for the JS: the
    // update bar, quota card and Chat dot belong to the desktop, not to a window.
    var WINDOWED = false;
    try
    {
        WINDOWED = EMBEDDED && window.parent === window.top &&
                   window.top.location.pathname.indexOf( "/nayive/desktop/" ) === 0;
    }
    catch ( e ) {}
    if( EMBEDDED ) { try { document.documentElement.classList.add( WINDOWED ? "is-windowed" : "is-embedded" ); } catch ( e ) {} }

    // The card's title row is sticky (app.css) - everywhere since 2026-09-30,
    // not only in a window; its height goes in --win-head-h so an app's own
    // sticky heads (Contacts' letters) sit under it.
    if( window.ResizeObserver ) document.addEventListener( "DOMContentLoaded", function ()
    {
        var head = document.querySelector( ".page > .page-inner > .card > .header" );
        if( ! head ) return;
        new ResizeObserver( function ()
        {
            document.documentElement.style.setProperty( "--win-head-h", head.offsetHeight + "px" );
        } ).observe( head );
    } );

    // ...and is the HOST window wide enough to show every pane at once? Planner's
    // PC / tablet layout puts calendar + tasks + habits side by side, and each of
    // those panes gets its own app icon back (app.css) so a glance tells which
    // area is which. On a phone Planner shows ONE pane at a time, picked with
    // three icon buttons in its header, so a second copy of the same icon inside
    // the pane would just be noise - hence the extra class, not a plain
    // .is-embedded rule. The width to test is the TOP window's (same 640px
    // breakpoint Planner uses): our own frame is only a slice of it, and a 25%-
    // wide pane on a desktop is narrower than a phone.
    if( EMBEDDED && ! WINDOWED ) try
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
    //   packSheet( sheetEl, { min: 320, max: 440 } )       -> manual, custom bounds
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
    // one we watch the `.open` class come off any backdrop - in the page's one
    // class observer, wireSheetFocus (a second one here cost every class
    // change in Calc and Write twice).
    function recentreSheet( back )
    {
        var s = back.querySelector( ".sheet" );
        if( s && ( s.nayiveDragX || s.nayiveDragY ) ) moveSheet( s, 0, 0 );
    }

    function initDragSheets()
    {
        document.addEventListener( "pointerdown", onDragDown,  true );
        document.addEventListener( "click",       onDragClick, true );
        window.addEventListener( "resize", reclampSheets );
    }

    // Bottom-centre transient toast. Needs a <div id="toast" class="toast"> in
    // the page (styled by shared/theme.css). opts: { id, ms, keepUndo }.
    //
    // keepUndo: news the user did not ask for (a background merge, a sync):
    // with an Undo on show it waits until that one is gone - shown over it,
    // it made the Undo final and the user lost the way back (Bookmarks'
    // "Merged" over Replace all's Undo).
    function toast( msg, opts )
    {
        opts = opts || {};
        var t = byId( opts.id || "toast" );
        if( ! t ) return;

        if( opts.keepUndo && undoPending && undoPending.tt === t )
        {
            undoPending.after = [ msg, opts ];
            return;
        }

        settleUndo();                           // it takes an Undo's place: that one is final now
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
    // date/time inputs added to the DOM after this script runs. (Their
    // data-i18n text is shared/i18n.js's own observer's job, not this one's.)
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
        filter: [ 2,   '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>' ],
        // "Limpiar": empties a dialog's fields (the advanced searches).
        eraser: [ 2,   '<path d="M7 21l-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21"></path><line x1="22" y1="21" x2="7" y2="21"></line><line x1="5" y1="11" x2="14" y2="20"></line>' ],
        textcursor: [ 2, '<path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1"></path><path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5"></path><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"></path><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"></path><line x1="9" y1="7" x2="9" y2="17"></line>' ],
        plus:   [ 2.4, '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>' ],
        back:   [ 2.2, '<line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>' ],
        // Arrows move BETWEEN SCREENS - "back", and "forward" to open an item. A chevron
        // never navigates: it means expand or step in place (Drive's tree twisty, the
        // month pagers in Calendar and Habits, a collapsible section's caret).
        forward: [ 2.2, '<line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>' ],
        up:     [ 2.2, '<polyline points="18 15 12 9 6 15"></polyline>' ],      // move up in a list
        down:   [ 2.2, '<polyline points="6 9 12 15 18 9"></polyline>' ],       // move down in a list
        edit:   [ 2,   '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>' ],
        grid:   [ 1.9, '<rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line>' ],
        folder: [ 2,   '<path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>' ],
        // "New folder" - the same glyph Drive's toolbar uses, so the verb reads
        // the same in the toolbar and in the folder picker.
        folderplus: [ 2, '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line>' ],
        // "Extract here" - the same folder, with an arrow going into it (Drive's .zip).
        unzip:  [ 2,   '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="10" x2="12" y2="17"></line><polyline points="9 14 12 17 15 14"></polyline>' ],
        doc:    [ 2,   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="12" y2="17"></line>' ],
        // "Save as" - the check, with a small + centred near the top edge for "as a new copy".
        saveas: [ 2,   '<polyline points="5 14 10 18 17 9" stroke-width="2.5"></polyline><line x1="12" y1="1" x2="12" y2="7" stroke-width="2.4"></line><line x1="9" y1="4" x2="15" y2="4" stroke-width="2.4"></line>' ],
        save:   [ 2,   '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline>' ],
        // "Quick tour" - a compass.
        compass:[ 2,   '<circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>' ],
        // Settings - a cog wheel.
        gear:   [ 2,   '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' ],
        // "Mi cuenta" - a person bust.
        user:   [ 2,   '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>' ],
        // "Show the password" - an eye (NayiveUI.pwEye, eMail's account form).
        eye:    [ 2,   '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle>' ],
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
        // Android's browser menu (three dots, one above the other).
        menudots: [ 0, '<circle cx="12" cy="5" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="12" cy="19" r="1.8"></circle>' ],
        fullscr:  [ 2, '<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M21 16v3a2 2 0 0 1-2 2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path>' ],
        bolt:     [ 2, '<polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"></polygon>' ],
        // "Solo lectura" - a closed padlock. Drawn blue in .ro-badge (see app.css).
        lock:     [ 2, '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path>' ],
        // A document's password (Write / Calc) - the Passwords app's key.
        key:      [ 2, '<circle cx="7.5" cy="15.5" r="4.5"></circle><path d="M10.7 12.3 21 2"></path><path d="m15.5 7.5 3 3"></path><path d="m18 5 2.5 2.5"></path>' ],
        // Cortar / Copiar / Pegar - the same three glyphs Drive's context menu
        // draws. Write's and Calc's Edición menus use them (shared/menubar.js).
        cut:      [ 2, '<circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line>' ],
        copy:     [ 2, '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' ],
        paste:    [ 2, '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect><path d="M9 14l2 2 4-4"></path>' ],
        // Pausa / Seguir / Parar - a running thing (the desktop's countdown).
        pause:    [ 2.2, '<line x1="9" y1="5" x2="9" y2="19"></line><line x1="15" y1="5" x2="15" y2="19"></line>' ],
        play:     [ 2.2, '<polygon points="7 4 19 12 7 20 7 4"></polygon>' ],
        stop:     [ 2.2, '<rect x="6" y="6" width="12" height="12" rx="1.5"></rect>' ]
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

    /* The DOM builder (Chat's C.h, eMail's E.h):
     *   h( "div", { class: "x", text: "…", html: "<svg…>", on: { click: fn },
     *               attrs: {…}, data: {…}, anyProperty: v }, child, … )
     * A null / false prop or attr is skipped ("" is not: class "" still sets
     * it). Children: elements, strings and numbers (text nodes), arrays, and
     * null / false (skipped). `html` is for our own icons only. */
    function h( tag, props )
    {
        var el = document.createElement( tag );
        props = props || {};
        for( var k in props )
        {
            var v = props[ k ];
            if( v == null || v === false ) continue;
            if( k === "class" )      el.className = v;
            else if( k === "text" )  el.textContent = v;
            else if( k === "on" )    { for( var e in v ) el.addEventListener( e, v[ e ] ); }
            else if( k === "attrs" ) { for( var a in v ) if( v[ a ] != null && v[ a ] !== false ) el.setAttribute( a, v[ a ] ); }
            else if( k === "data" )  { for( var d in v ) el.dataset[ d ] = v[ d ]; }
            else if( k === "html" )  el.innerHTML = v;
            else el[ k ] = v;
        }
        for( var i = 2; i < arguments.length; i++ ) hKid( el, arguments[ i ] );
        return el;
    }

    function hKid( el, kid )
    {
        if( kid == null || kid === false ) return;
        if( Array.isArray( kid ) ) { kid.forEach( function ( k ) { hKid( el, k ); } ); return; }
        el.appendChild( typeof kid === "string" || typeof kid === "number" ? document.createTextNode( String( kid ) ) : kid );
    }

    function icon( name )
    {
        if( APP_LOGOS[ name ] ) return APP_LOGOS[ name ];

        var d = ICONS[ name ] || ICONS.check;
        if( d[ 0 ] === 0 )      // filled glyph (e.g. the drag grip), not stroked
            return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">' + d[ 1 ] + '</svg>';
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + d[ 0 ] +
               '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d[ 1 ] + '</svg>';
    }

    // PASSWORD EYE - the button beside a password field shows / hides its
    // text (the launcher's "Mi cuenta", the admin panel; login.html keeps its
    // own copy, as it does not load this file).
    function pwEye( btn, input )
    {
        btn.innerHTML = icon( "eye" );
        btn.addEventListener( "click", function ()
        {
            var show = input.type === "password";
            input.type = show ? "text" : "password";
            btn.innerHTML = icon( show ? "eyeoff" : "eye" );
            btn.setAttribute( "aria-label", t( show ? "ui.hidePassword" : "ui.showPassword" ) );
            input.focus();
        } );
    }

    // SEARCH FOLD - every toolbar search field (app.css SEARCH FOLD). At rest
    // only a magnifier shows; a click opens the field in its place. The field
    // takes the room the bar has left; only when that is under `min` px do
    // the bar's other icons step aside (.search-tight) so it takes the bar.
    // Inside the field, on the right: when the field has a dialog of filters,
    // a funnel button that opens it; then the ×, which (like Escape) clears
    // the field and folds it away.
    //   o.box       the wrapper around the input (the field's own box)
    //   o.input     the text field
    //   o.bar       the row whose icons step aside (default: the closest
    //               .topbar / .view-bar)
    //   o.toggle    the magnifier to open it (default: one is made, before box)
    //   o.filter()  opens the filter dialog (the in-field button shows a funnel)
    //   o.filterTitle  its tooltip (an i18n key)
    //   o.filterBtn the app's own filter button instead (it wires the click)
    //   o.onClose() the field has been emptied: drop the search (default:
    //               an "input" event on it)
    //   o.min       the narrowest the field may get beside the icons (180)
    // Returns { open, close, fit, isOpen, count }. count( "12 / 300" ) shows
    // how many items match, dim, inside the field before its buttons ("" hides
    // it). open( true ) unfolds it without
    // the focus (a search the app set itself: no phone keyboard); close( true )
    // folds it without onClose (the app is about to show something else).
    function searchFold( o )
    {
        var box = o.box, input = o.input, min = o.min || 180;
        var bar = o.bar || box.parentElement.closest( ".topbar, .view-bar" );
        var toggle = o.toggle;
        if( ! toggle )
        {
            toggle = document.createElement( "button" );
            toggle.type = "button";
            toggle.className = "icon-btn";
            toggle.innerHTML = icon( "search" );
            toggle.setAttribute( "data-i18n-attr", "title:ui.search, aria-label:ui.search" );
            toggle.title = t( "ui.search" );
            toggle.setAttribute( "aria-label", t( "ui.search" ) );
            box.parentNode.insertBefore( toggle, box );
        }
        toggle.classList.add( "search-fold-toggle" );
        box.classList.add( "search-fold" );
        bar.classList.add( "search-fold-bar" );

        var ends = document.createElement( "span" );
        ends.className = "search-ends";
        // A filter dialog gets its funnel button; a plain field gets nothing
        // there - a magnifier that cannot be pressed would only look like one.
        var mark = o.filterBtn;
        if( mark ) mark.classList.add( "icon-btn", "sm" );
        else if( o.filter )
        {
            mark = document.createElement( "button" );
            mark.type = "button";
            mark.className = "icon-btn sm";
            mark.addEventListener( "click", function () { o.filter(); } );
            if( o.filterTitle )
            {
                mark.setAttribute( "data-i18n-attr", "title:" + o.filterTitle + ", aria-label:" + o.filterTitle );
                mark.title = t( o.filterTitle );
                mark.setAttribute( "aria-label", t( o.filterTitle ) );
            }
        }
        if( mark )
        {
            mark.classList.add( "search-mark" );
            mark.innerHTML = icon( "filter" );
            box.classList.add( "has-filter" );
        }
        var shut = document.createElement( "button" );
        shut.type = "button";
        shut.className = "icon-btn sm search-shut";
        shut.innerHTML = icon( "x" );
        shut.setAttribute( "data-i18n-attr", "title:ui.close, aria-label:ui.close" );
        shut.title = t( "ui.close" );
        shut.setAttribute( "aria-label", t( "ui.close" ) );
        shut.addEventListener( "click", function () { close(); } );
        var tally = document.createElement( "span" );
        tally.className = "search-count";
        tally.hidden = true;
        ends.appendChild( tally );
        if( mark ) ends.appendChild( mark );
        ends.appendChild( shut );
        box.appendChild( ends );

        // The field's text must stop before the count + buttons, whatever
        // their width; with no count the CSS padding stands.
        function count( text )
        {
            tally.textContent = text || "";
            tally.hidden = ! text;
            input.style.paddingRight = text ? ( ends.offsetWidth + 8 ) + "px" : "";
        }

        function isOpen() { return box.classList.contains( "is-open" ); }
        function open( noFocus )
        {
            box.classList.add( "is-open" );
            fit();
            if( noFocus !== true && ! input.hidden ) input.focus();
        }
        function close( quiet )
        {
            box.classList.remove( "is-open" );
            fit();
            input.value = "";
            count( "" );
            if( quiet === true ) return;
            if( o.onClose ) o.onClose();
            else input.dispatchEvent( new Event( "input" ) );
        }
        // The bar's state follows the field as it is SHOWN: an app mode that
        // hides the box (reading a message, the bin) gives the icons back.
        // Tried with the icons shown, and tight only when the field gets too
        // little - measured in one go, so nothing flickers.
        function fit()
        {
            var shown = isOpen() && box.getClientRects().length > 0;
            bar.classList.toggle( "searching", shown );
            bar.classList.remove( "search-tight" );
            if( shown && box.offsetWidth < min ) bar.classList.add( "search-tight" );
        }

        toggle.addEventListener( "click", function () { open(); } );
        input.addEventListener( "keydown", function ( e )
        {
            if( e.key !== "Escape" || ! isOpen() ) return;
            e.preventDefault();
            e.stopPropagation();      // not the app's own Escape (a dialog, a viewer)
            close();
        } );
        // The bar resizing, and the box itself coming and going (an app mode
        // shows or hides it). fit() ends where it started for a given size,
        // so its own changes settle at once.
        if( window.ResizeObserver )
        {
            var ro = new ResizeObserver( fit );
            ro.observe( bar );
            ro.observe( box );
        }

        return { open: open, close: close, fit: fit, isOpen: isOpen, count: count };
    }

    // A Mac (or an iPhone / iPad with a keyboard): its shortcuts take ⌘, not
    // Ctrl, and show as glyphs. For every app that names or reads a combo.
    var IS_MAC = /Mac|iPhone|iPad|iPod/.test( navigator.platform || navigator.userAgent || "" );

    // PANE RESIZER - a .pane-resizer handle (app.css) sets the width of the
    // side pane next to it: Drive's tree, Chat's list, Bookmarks' tree,
    // Music's queue. Mouse, pen and touch alike; a double-click puts the
    // default width back.
    //   rz, pane    the handle and the pane it sizes
    //   o.min/max   the widths a drag may reach (px)
    //   o.def       the double-click's width (null: whatever the CSS says)
    //   o.set( w )  applies a width (a custom property, a style)
    //   o.key       localStorage key: the width is put back now, and kept
    //               after a drag and a double-click (this device's own)
    //   o.save( w ) instead of `key`, when the app keeps it itself
    //   o.right     the pane is right of the handle (a drag right narrows it)
    //   o.off()     true while there is nothing to drag (a phone layout)
    function paneResizer( rz, pane, o )
    {
        var keep = o.save || function ( w )
        {
            if( o.key ) try { localStorage.setItem( o.key, w ); } catch( _ ) {}
        };

        if( o.key )
        {
            var saved = NaN;
            try { saved = parseInt( localStorage.getItem( o.key ), 10 ); } catch( _ ) {}
            if( saved >= o.min && saved <= o.max ) o.set( saved );
        }

        var dragging = false, startX = 0, startW = 0;

        rz.addEventListener( "pointerdown", function ( e )
        {
            if( o.off && o.off() ) return;
            dragging = true;
            startX   = e.clientX;
            startW   = pane.getBoundingClientRect().width;
            rz.setPointerCapture( e.pointerId );
            rz.classList.add( "dragging" );
            document.body.style.userSelect = "none";
        } );
        rz.addEventListener( "pointermove", function ( e )
        {
            if( ! dragging ) return;
            var dx = ( e.clientX - startX ) * ( o.right ? -1 : 1 );
            o.set( Math.max( o.min, Math.min( o.max, Math.round( startW + dx ) ) ) );
        } );
        function end()
        {
            if( ! dragging ) return;
            dragging = false;
            rz.classList.remove( "dragging" );
            document.body.style.userSelect = "";
            keep( Math.round( pane.getBoundingClientRect().width ) );
        }
        rz.addEventListener( "pointerup", end );
        rz.addEventListener( "pointercancel", end );
        rz.addEventListener( "dblclick", function ()
        {
            o.set( o.def );
            if( o.def != null ) keep( o.def );
        } );
    }

    // THE CLIP'S PANEL (Chat's writer, eMail's): a round coloured button per
    // choice, its name under it, three to a row (app.css .attach). items:
    // [{ icon: <svg> node, label, color: 0-5, act }]. A tap runs onPick (the
    // caller closes the panel), then the choice. The caller places it.
    function attachPanel( items, onPick )
    {
        var el = document.createElement( "div" );
        el.className = "attach";
        items.forEach( function ( a )
        {
            var ai = document.createElement( "span" );
            ai.className = "ai";
            ai.appendChild( a.icon );
            var b = document.createElement( "button" );
            b.type = "button";
            b.className = "att";
            b.setAttribute( "data-c", String( a.color ) );
            b.appendChild( ai );
            b.appendChild( document.createTextNode( a.label ) );
            b.addEventListener( "click", function () { if( onPick ) onPick(); a.act(); } );
            el.appendChild( b );
        } );
        return el;
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

    // If `row` holds nothing but a close button, move it to the sheet's top-right
    // corner as a .sheet-close and remove the now-empty row. With a title, the ×
    // goes on the title's own line (a .sheet-header: the title, then any
    // .sheet-tool buttons, then the ×), so a long title wraps instead of
    // running under it. With none, it is pinned to the corner.
    function cornerLoneClose( row )
    {
        var kids = row.children;
        if( kids.length !== 1 || ! kids[ 0 ]._nayiveClose ) return;

        var b     = kids[ 0 ];
        var sheet = row.closest && row.closest( ".sheet" );
        if( ! sheet ) return;

        b.classList.remove( "btn", "btn-secondary" );
        b.classList.add( "sheet-close" );

        var head = titleRow( sheet );
        if( head )
        {
            head.appendChild( b );
            row.parentNode.removeChild( row );
            return;
        }

        b.style.position = "absolute";
        b.style.top      = "10px";
        b.style.right    = "10px";
        sheet.appendChild( b );
        row.parentNode.removeChild( row );

        if( getComputedStyle( sheet ).position === "static" )
            sheet.style.position = "relative";
    }

    // The sheet's title line: its .sheet-header, or its <h2> wrapped in one now.
    function titleRow( sheet )
    {
        var head = sheet.querySelector( ":scope > .sheet-header" );
        if( head ) return head;

        var h2 = sheet.querySelector( ":scope > h2" );
        if( ! h2 ) return null;

        head = document.createElement( "div" );
        head.className = "sheet-header";
        sheet.insertBefore( head, h2 );
        head.appendChild( h2 );
        return head;
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

        setInfoText( infoPopupEl, dot.getAttribute( "data-info" ) || "" );
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

    // The popup's text, with every "https://..." in it made a link (new tab).
    // Text nodes only, never innerHTML. A tap on the link does not close the
    // popup first: onInfoOutside ignores presses inside it.
    function setInfoText( el, text )
    {
        el.textContent = "";
        text.split( /(https:\/\/\S+)/ ).forEach( function ( part, i )
        {
            if( i % 2 === 0 )
            {
                if( part ) el.appendChild( document.createTextNode( part ) );
                return;
            }
            var a = document.createElement( "a" );
            a.href        = part;
            a.target      = "_blank";
            a.rel         = "noopener";
            a.textContent = part;
            el.appendChild( a );
        } );
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
            watchSyncChip( el );
        }
    }

    //------------------------------------------------------------------------//
    // THE PLUG AS A FLOATING CHIP  (his call, 2026-09-30)
    //
    // Green is the normal case, so the plug takes no room in the header: it is
    // hidden while the connection is fine and, when it is not, floats as a
    // round chip just outside the END of its bar - under a top bar, above a
    // bottom one, beside a side one (the desktop's). Same spot in every app.
    //
    //   - It shows only once the link has been bad for 3 s: a lift or a
    //     wifi → 4G hand-over would otherwise blink it.
    //   - Blue (a GET / PUT in flight) never shows it on its own, and does not
    //     restart the 3 s either: a retry loop going red → blue → red shows.
    //   - When the link is back it stays green 1.5 s, then fades away.
    //
    // Apps keep toggling the same state classes; this watches them. The timing
    // lives per id, not per element, so a header rebuilt from scratch (Trips)
    // keeps a chip that is already up. In a frame the dot stays hidden
    // (app.css), whatever this does. theme.css draws .sy-show / .sy-fade.

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
        var bar = el.closest( ".topbar, .header, .bar, .trip-header, header" ) || el.parentElement;
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

    // The bar may move (a card page scrolls, the window is resized, the
    // desktop's bar changes side): keep an open chip glued to it.
    function placeSyncChips()
    {
        for( var k in syChips )
            if( syChips[ k ].shown && syChips[ k ].el.isConnected ) placeSyncChip( syChips[ k ].el );
    }
    window.addEventListener( "resize", placeSyncChips );
    document.addEventListener( "scroll", placeSyncChips, { capture: true, passive: true } );

    // Wire every <button class="info-dot"> under `root` (default: document).
    // Idempotent; fills in the icon + ARIA if missing.
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
    // CONFIRM / ALERT  - a Nayive sheet, never the browser's window.confirm /
    // window.alert (those ignore the theme and the style guide).
    //
    //   if( await NayiveUI.confirm( { title: 'Vaciar la papelera?',
    //                               body: 'Se borraran 12 elementos.',
    //                               confirm: 'Vaciar', danger: true } ) ) { ... }
    //   await NayiveUI.alert( { title: 'No se pudo importar', body: msg } );
    //
    // A confirm may carry a THIRD answer - `other: 'Solo protegerlo'` (with
    // `otherIcon`) puts a second button between cancel and confirm and resolves
    // the string "other". For the question that is not yes/no: two ways
    // forward and a way out. Three is the ceiling - a fourth is a menu, not a
    // question.
    //
    // The sheet is built on the fly and removed on close. It closes on its own
    // buttons or Escape only - never a backdrop click (dialog-close rule).
    // `body` may hold "\n" - each line becomes its own <p>. A plain string
    // argument is taken as the body.

    //------------------------------------------------------------------------//
    // ONE DIALOG, BUILT ON THE FLY  -  the frame every dialog made here is
    // thrown away in (confirm / alert, askPassword, the intro, pickFolder,
    // pickFile, the install sheet, Compartir; Chat's own too): the backdrop,
    // its sheet, an optional title, Escape, and one close.
    //
    //   var d = modal( { cls: "sheet--pack", title: "...", escape: fn } );
    //   ... fill d.sheet ...
    //   d.show( fill )   on the page: appended, then fill() (buttons are
    //                    styled in place), then Escape heard and "open" set
    //   d.close()        taken off, once: false when it already was
    //
    //   o.cls        more classes for the sheet;   o.id  the backdrop's id
    //   o.title      an <h2>, first in the sheet
    //   o.escape()   what Escape does (default: close); the key never goes
    //                on to the page underneath
    //   o.top()      Escape only while this answers true (a dialog asked
    //                from inside this one closes first)
    //   o.key( e )   any other key
    //   o.linger     ms the node stays after close (a fade), 0 by default

    function modal( o )
    {
        o = o || {};
        var done = false;

        var back = document.createElement( "div" );
        back.className = "sheet-backdrop";
        if( o.id ) back.id = o.id;
        back.setAttribute( "role", "dialog" );
        back.setAttribute( "aria-modal", "true" );

        var sheet = document.createElement( "div" );
        sheet.className = "sheet" + ( o.cls ? " " + o.cls : "" );
        back.appendChild( sheet );

        if( o.title )
        {
            var h = document.createElement( "h2" );
            h.textContent = o.title;
            sheet.appendChild( h );
        }

        function onKey( e )
        {
            if( e.key !== "Escape" ) { if( o.key ) o.key( e ); return; }
            if( o.top && ! o.top() ) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            ( o.escape || close )();
        }

        function close()
        {
            if( done ) return false;
            done = true;
            document.removeEventListener( "keydown", onKey, true );
            back.classList.remove( "open" );
            if( o.linger ) setTimeout( function () { if( back.parentNode ) back.parentNode.removeChild( back ); }, o.linger );
            else if( back.parentNode ) back.parentNode.removeChild( back );
            return true;
        }

        function show( fill )
        {
            document.body.appendChild( back );
            if( fill ) fill();
            document.addEventListener( "keydown", onKey, true );
            back.classList.add( "open" );
        }

        return { back: back, sheet: sheet, show: show, close: close };
    }

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
            var d     = modal( { title: opts.title, escape: function () { finish( false ); } } );
            var sheet = d.sheet;

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

            var other = null;
            if( withCancel && opts.other )
            {
                other = document.createElement( "button" );
                other.setAttribute( "data-act", "secondary:" + ( opts.otherIcon || "check" ) );
                other.title = opts.other;
                row.appendChild( other );
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
                if( d.close() ) resolve( val );
            }

            // applySheetButtons keeps the same button nodes (it only re-classes
            // them and may move a lone close to the sheet corner).
            ok.addEventListener( "click", function () { finish( true ); } );
            if( other )  other.addEventListener( "click", function () { finish( "other" ); } );
            if( cancel ) cancel.addEventListener( "click", function () { finish( false ); } );

            d.show( function () { applySheetButtons( sheet ); } );   // classes + SVGs; lone close -> corner

            // For a destructive confirm, focus the safe (cancel) button so a
            // stray Enter doesn't trigger the delete.
            ( opts.danger && cancel ? cancel : ok ).focus();
        } );
    }

    function confirmDialog( opts ) { return makeDialog( opts, true ); }
    function alertDialog( opts )   { return makeDialog( opts, false ); }

    //------------------------------------------------------------------------//
    // ASK FOR ONE NAME  -  a new album (Photos), a group (Chat, Contacts), a rename
    //
    //   var name = await NayiveUI.askText( { title: '...', label: '...' } );
    //   if( ! name ) return;             // cancelled, or Escape: null
    //
    //   o.value        the text it starts with (selected)
    //   o.label        a <label> above the field, or
    //   o.placeholder  the field's own grey text (and its aria-label)
    //   o.hint         a line under the field
    //   o.okTitle      the ✓'s tooltip (default "Accept");  o.okClass  a class on it
    //   o.max          the field's maxlength
    //   o.ids          { input, ok, cancel }: ids for the three
    //   o.wide         a full sheet (default: a packed one, sheet--pack)
    //   o.topOnly      Escape only while it is the page's last node (asked over
    //                  another dialog that also hears Escape)
    //   o.check( v )   the answer for the trimmed text v, or false to keep the
    //                  dialog open (check says why); the field is then selected
    //
    // An empty field is never an answer: the ✓ only puts the focus back in it.
    function askText( o )
    {
        o = o || {};
        var ids = o.ids || {};

        return new Promise( function ( resolve )
        {
            var d = modal( { cls: o.wide ? "" : "sheet--pack", title: o.title, escape: function () { finish( null ); },
                             top: o.topOnly ? function () { return document.body.lastElementChild === d.back; } : null } );

            var field = document.createElement( "div" );
            field.className = "field";
            var input = document.createElement( "input" );
            input.type = "text";
            input.autocomplete = "off";
            if( ids.input ) input.id = ids.input;
            if( o.max ) input.maxLength = o.max;
            input.value = o.value || "";
            if( o.label )
            {
                var lbl = document.createElement( "label" );
                lbl.textContent = o.label;
                if( ids.input ) lbl.htmlFor = ids.input;
                field.appendChild( lbl );
            }
            if( o.placeholder )
            {
                input.placeholder = o.placeholder;
                input.setAttribute( "aria-label", o.placeholder );
            }
            field.appendChild( input );
            d.sheet.appendChild( field );

            if( o.hint )
            {
                var hint = document.createElement( "p" );
                hint.className = "hint";
                hint.textContent = o.hint;
                d.sheet.appendChild( hint );
            }

            var row = document.createElement( "div" );
            row.className = "sheet-actions";
            var no = document.createElement( "button" );
            no.type = "button";
            if( ids.cancel ) no.id = ids.cancel;
            no.setAttribute( "data-act", "close" );
            no.title = t( "ui.cancel" );
            var ok = document.createElement( "button" );
            ok.type = "button";
            if( ids.ok ) ok.id = ids.ok;
            if( o.okClass ) ok.className = o.okClass;
            ok.setAttribute( "data-act", "primary" );
            ok.title = o.okTitle || t( "ui.accept" );
            row.appendChild( no );
            row.appendChild( ok );
            d.sheet.appendChild( row );
            applySheetButtons( d.sheet );

            function finish( v ) { if( d.close() ) resolve( v ); }

            function submit()
            {
                var v = input.value.trim();
                if( ! v ) { input.focus(); return; }
                if( o.check )
                {
                    var r = o.check( v );
                    if( r === false ) { input.select(); return; }
                    v = r;
                }
                finish( v );
            }

            no.addEventListener( "click", function () { finish( null ); } );
            ok.addEventListener( "click", submit );
            input.addEventListener( "keydown", function ( e )
            {
                if( e.key === "Enter" && ! e.isComposing ) { e.preventDefault(); submit(); }
            } );

            d.show();
            setTimeout( function () { input.focus(); input.select(); }, 30 );
        } );
    }

    //------------------------------------------------------------------------//
    // ASK FOR A PASSWORD  -  the sheet the office apps lock a document with
    //
    //   var pw = await NayiveUI.askPassword( { title: '...', body: '...',
    //                                          confirm: 'Proteger', verify: true } );
    //   if( pw === null ) { ... }        // cancelled, or Escape
    //
    // `verify: true` asks for it twice (setting a NEW password: there is no way
    // back from a typo) and refuses anything shorter than `min` (default 8).
    // Without it the sheet asks for a password that already exists, so it only
    // refuses an empty box.
    // Built and thrown away like confirm/alert, and it closes the same way:
    // its own buttons or Escape, never a backdrop click.
    //
    // The value is returned, never kept: the caller turns it into a key and
    // this sheet's nodes are gone from the DOM before the promise resolves.

    function askPassword( opts )
    {
        opts = normDialogOpts( opts );
        var min = opts.min || 8;

        return new Promise( function ( resolve )
        {
            var d     = modal( { cls: "sheet--pack", title: opts.title, escape: function () { finish( null ); }, key: onKey } );
            var sheet = d.sheet;

            if( opts.body )
            {
                var lead = document.createElement( "p" );
                lead.className   = "dialog-text";
                lead.textContent = String( opts.body );
                sheet.appendChild( lead );
            }

            // A field is the standard .field pair, so it inherits the app's
            // input styling instead of growing a look-alike of its own.
            function field( labelText, id )
            {
                var box = document.createElement( "div" );
                var lab = document.createElement( "label" );
                var inp = document.createElement( "input" );

                box.className    = "field";
                lab.textContent  = labelText;
                lab.htmlFor      = id;
                inp.type         = "password";
                inp.id           = id;
                // A new password (verify) or one that already exists: the
                // browser's password manager offers to make one or to fill it.
                inp.autocomplete = opts.verify ? "new-password" : "current-password";

                box.appendChild( lab );
                box.appendChild( inp );
                sheet.appendChild( box );
                return inp;
            }

            var one = field( t( "lock.password" ), "askPw1" );
            var two = opts.verify ? field( t( "lock.repeat" ), "askPw2" ) : null;

            var warn = document.createElement( "p" );
            warn.className = "field-error";
            warn.hidden    = true;
            sheet.appendChild( warn );

            var row = document.createElement( "div" );
            row.className = "sheet-actions";
            sheet.appendChild( row );

            var cancel = document.createElement( "button" );
            cancel.setAttribute( "data-act", "close" );
            cancel.title = opts.cancel || t( "ui.cancel" );
            row.appendChild( cancel );

            var ok = document.createElement( "button" );
            ok.setAttribute( "data-act", "primary" );
            ok.title = opts.confirm || t( "ui.accept" );
            row.appendChild( ok );

            function complain( key )
            {
                warn.textContent = t( key );
                warn.hidden      = false;
            }

            function finish( val )
            {
                if( d.close() ) resolve( val );
            }

            function submit()
            {
                var pw = one.value;

                // The length rule belongs to a NEW password. Asking for an
                // existing one only refuses an empty box - the password it
                // was set with is whatever it is.
                if( two )
                {
                    if( pw.length < min )     { complain( "lock.tooShort" ); one.focus(); return; }
                    if( two.value !== pw )    { complain( "lock.noMatch" ); two.value = ""; two.focus(); return; }
                }
                else if( ! pw ) { one.focus(); return; }

                finish( pw );
            }

            // Enter in a field is the ✓ (Escape is the modal's).
            function onKey( e )
            {
                if( e.key === "Enter" && ( e.target === one || e.target === two ) )
                {
                    e.preventDefault();
                    submit();
                }
            }

            ok.addEventListener( "click", submit );
            cancel.addEventListener( "click", function () { finish( null ); } );

            d.show( function () { applySheetButtons( sheet ); } );
            packSheet( sheet, { min: 300, max: 420 } );
            one.focus();
        } );
    }

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

        // Only what the bin holds when the user is asked is deleted - those
        // ids, never "empty everything": an item deleted on another device
        // after that (its Undo toast maybe still up there) stays (G4). The
        // ids travel in the URL: at most 2000 a call.
        var ids = null;
        if ( held > 0 && need <= s.usable + held )
        {
            try { ids = ( await GumApi.trashList() ).map( function ( it ) { return it.id; } ); }
            catch ( e ) { ids = null; }
        }
        if ( ids && ids.length )
        {
            var ok = await confirmDialog( {
                title:   t( "ui.room.title" ),
                body:    short + "\n\n" + tf( "ui.room.trashBody", { held: fmtBytes( held ) } ),
                confirm: t( "ui.room.empty" ), danger: true } );
            if ( ! ok ) return false;
            try
            {
                for ( var i = 0; i < ids.length; i += 2000 ) await GumApi.trashDelete( ids.slice( i, i + 2000 ) );
                return true;
            }
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
    //       // { section: "Ajustes" } in `buttons`: a line + subtitle, then the rows go on
    //       tip: "Consejo: ...",          // extra line under the list (launcher)
    //       autoShow: true,               // open on load until dismissed (launcher)
    //       dismissible: true             // add a "No volver a mostrar" button
    //   } );
    //
    // A row's glyph + name come from the real button named by `sel` (so they
    // always match what is on screen); `text` is the hand-written explanation.
    // `{ icon, name, text }` describes a row with no single button behind it;
    // `icon` next to `sel` swaps just the glyph (two buttons that look alike).
    // `svg` (ready markup) is for an app's own glyph that the shared set lacks.
    // Apps never auto-open the dialog - it opens only from the toolbar "?"
    // button ([data-intro-open], wired here) or NayiveUI.showIntro(). The launcher
    // passes autoShow + dismissible: it re-opens every visit until the user
    // clicks "No volver a mostrar" (localStorage "balata-intro-dismiss:<app>").

    var introOpts = null;
    var introHeld = false;      // set by holdIntro() when something more important must own the screen

    // Write / Calc / Text put a three-entry Ayuda menu on the "?" (Estadisticas,
    // Atajos de teclado, Botones de la barra) instead of opening this card
    // straight away - the card is one of the three entries. They say so with
    // NayiveUI.setHelpMenu( true ) and open the menu themselves; the "?" keeps
    // its data-intro-open, so the coach marks and placeHelpButton still find it.
    var helpIsMenu = false;

    // Suppress the auto-opening help card for this page load and close it if it
    // is already up. The launcher calls this when a first-time user must set a
    // password before anything else.
    function holdIntro()
    {
        introHeld = true;
        var x = document.querySelector( ".sheet-backdrop.open .intro-close" );
        if( x ) x.click();
    }

    // The glyph for one list row: a named shared icon when the row gives one
    // (it wins over `sel`, e.g. to tell two same-looking buttons apart), else
    // the real button's <svg> (cloned so CSS sizes it), else the button's short
    // text, else a dot.
    function introGlyph( it, el )
    {
        var span = document.createElement( "span" );
        span.className = "intro-btn-i";

        var svg = el && el.querySelector && el.querySelector( "svg" );
        if( it.svg )
        {
            span.innerHTML = it.svg;
        }
        else if( it.icon )
        {
            span.innerHTML = icon( it.icon );
        }
        else if( svg )
        {
            var c = svg.cloneNode( true );
            c.removeAttribute( "width" );
            c.removeAttribute( "height" );
            span.appendChild( c );
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
        var app   = opts.app || appKey();
        var d     = modal( { cls: "intro-sheet", title: opts.title } );
        var sheet = d.sheet;

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

                // { section: "Title" }: a line, a subtitle, then a fresh list.
                if( it.section )
                {
                    if( ul.children.length ) sheet.appendChild( ul );
                    sheet.appendChild( document.createElement( "hr" ) ).className = "intro-sep";
                    var sh = document.createElement( "h3" );
                    sh.className   = "intro-sub";
                    sh.textContent = it.section;
                    sheet.appendChild( sh );
                    ul = document.createElement( "ul" );
                    ul.className = "intro-btns";
                    continue;
                }

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
                // The plug is a floating chip now: say when it shows at all.
                if( el && el.classList.contains( "sync-indicator" ) ) tx.textContent += " " + t( "ui.sync.chipHint" );
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

        function finish() { d.close(); }

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

        d.show();
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
        // In a desktop window "home" is the desktop's menu: leaving would close every window.
        if( WINDOWED ) { try { window.top.NayiveDesktop.menu(); } catch ( err ) {} return; }
        // A red Chat dot on the icon (see CHAT DOT below): the tap - icon OR
        // name, one target for a finger - goes to Chat.
        var toChat = chatDot && ! chatDot.hidden && chatDot.style.display !== "none";
        navWindow().location.href = toChat ? "/nayive/chat/" : "/nayive/";   // the TOP window when framed (Planner)
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
            if( isIcon && EMBEDDED && ! WINDOWED ) continue;
            if( el._nayiveHome ) continue;
            el._nayiveHome = true;

            el.classList.add( "nayive-home-link" );
            if( isIcon )
            {
                if( ! el.getAttribute( "title" ) ) el.setAttribute( "data-i18n-attr", "title:ui.toApps" );
                el.setAttribute( "role", "button" );
            }
            el.addEventListener( "click", onHomeClick );
            if( isIcon ) placeChatDot();
        }
    }

    //------------------------------------------------------------------------//
    // CHAT DOT  - a new Chat message while the user is in another app
    //
    // A red dot sits on the app's icon (top-right) while Chat has unread
    // messages (muted chats do not count - /api/chat/unread). When the count
    // goes UP it blinks 5 times. A tap on the icon or the name then opens Chat instead of
    // the launcher (onHomeClick). Not in Chat itself, not in a Planner frame
    // (the host page shows it), not on the launcher, and not for the admin
    // (403) or a page with no login (401): those stop asking.
    //
    // News comes three ways: the worker forwards every chat push (sw.js,
    // { chat: "new" }), the page asks again when it comes back on screen, and
    // every 60 s while it is on screen (a device without notifications).

    var chatDot    = null;
    var chatUnread = -1;           // -1 = not asked yet: unread found at load shows, but does not blink

    function chatDotWanted()
    {
        var p = location.pathname;
        // the launcher has its own count on the Chat tile
        if( p === "/nayive/" || p === "/nayive/index.html" ) return false;
        return ! EMBEDDED && p.indexOf( "/nayive/" ) === 0 && p.indexOf( "/nayive/chat/" ) !== 0;
    }

    // The dot lives in the icon's parent (an <svg> cannot hold it), placed over
    // the icon's top-right corner. It is absolute, so the header's flex gap and
    // layout do not change.
    function placeChatDot()
    {
        if( ! chatDot || chatDot.hidden ) return;
        var ico = null, all = document.querySelectorAll( ".app-icon.nayive-home-link" );
        for( var i = 0; i < all.length && ! ico; i++ ) if( onScreen( all[ i ] ) ) ico = all[ i ];
        if( ! ico ) { chatDot.style.display = "none"; return; }

        var host = ico.parentNode;
        if( chatDot.parentNode !== host ) host.appendChild( chatDot );
        if( getComputedStyle( host ).position === "static" ) host.style.position = "relative";
        chatDot.style.display = "";

        var hr = host.getBoundingClientRect(), ir = ico.getBoundingClientRect();
        chatDot.style.left = ( ir.right - hr.left + host.scrollLeft - host.clientLeft - 8 ) + "px";
        chatDot.style.top  = ( ir.top   - hr.top  + host.scrollTop  - host.clientTop  - 3 ) + "px";
    }

    function showChatDot( n )
    {
        var before = chatUnread;
        chatUnread = n;
        // The desktop (desktop/index.html) has no app icon: it draws its own dot.
        try { document.dispatchEvent( new CustomEvent( "nayive:chatunread", { detail: n } ) ); } catch ( e ) {}
        if( ! n ) { if( chatDot ) chatDot.hidden = true; return; }

        if( ! chatDot )
        {
            chatDot = document.createElement( "span" );
            chatDot.className = "chat-dot";
            chatDot.setAttribute( "aria-hidden", "true" );
        }
        chatDot.hidden = false;
        placeChatDot();

        if( before >= 0 && n > before )
        {
            chatDot.classList.remove( "blink" );
            void chatDot.offsetWidth;                 // restart the animation
            chatDot.classList.add( "blink" );
        }
    }

    var chatAsking = false, chatStopped = false;

    function askChatUnread()
    {
        if( chatStopped || chatAsking || document.hidden ) return;
        chatAsking = true;
        fetch( "/api/chat/unread", { credentials: "same-origin", headers: { Accept: "application/json" } } )
            .then( function ( r )
            {
                if( r.status === 401 || r.status === 403 ) chatStopped = true;
                return r.ok ? r.json() : null;
            } )
            .then( function ( j ) { if( j ) showChatDot( j.n || 0 ); } )
            .catch( function () {} )
            .then( function () { chatAsking = false; } );
    }

    function startChatDot()
    {
        if( ! chatDotWanted() ) return;
        askChatUnread();
        setInterval( askChatUnread, 60000 );
        document.addEventListener( "visibilitychange", askChatUnread );
        window.addEventListener( "resize", placeChatDot );
        if( navigator.serviceWorker )
            navigator.serviceWorker.addEventListener( "message", function ( e )
            {
                if( e.data && e.data.chat === "new" ) askChatUnread();
            } );
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
    // showCoach( true ) forces it back for a demo or a test.

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
                    if( ! helpIsMenu ) doShowIntro( introOpts, false );
                }
            }, true );
        }

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

    // "The ? opens my own Ayuda menu, not the card." See helpIsMenu above.
    function setHelpMenu( on ) { helpIsMenu = on !== false; }

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
    //
    // It also DOES the folder housekeeping the user would otherwise have to go
    // to Drive for: three buttons in the bottom-left corner delete, rename and
    // create folders (folders only - files are Drive's job). They are part of
    // the shared sheet, so every caller gets them: Photos / Music / Movies, the
    // office save-as folder row, Write's templates folder, share-target, Trips.

    // The path-keyed sidecars (a photo's note in data/photos/comments.json, the
    // Photos / Music scan caches) must follow a folder the picker renames or
    // trashes, or its notes vanish. That upkeep lives in shared/media.js
    // (NayiveMedia.remapPaths / purgePaths, the same calls Drive makes), and
    // most callers of the picker - Write, Calc, Text, Trips, Chat,
    // share-target - do not load it, so it is fetched on first use from beside
    // this file. Best-effort like the upkeep itself: it never throws.
    var MEDIA_JS = ( function ()
    {
        try { return new URL( "media.js", document.currentScript.src ).href; }
        catch ( e ) { return "/nayive/shared/media.js"; }
    } )();
    var mediaLoad = null;

    function sidecarUpkeep( verb, arg )
    {
        if( ! window.NayiveMedia && ! mediaLoad )
            mediaLoad = new Promise( function ( resolve )
            {
                var s = document.createElement( "script" );
                s.src     = MEDIA_JS;
                s.onload  = resolve;
                s.onerror = function () { mediaLoad = null; resolve(); };   // a later call tries again
                document.head.appendChild( s );
            } );

        return Promise.resolve( window.NayiveMedia ? null : mediaLoad )
            .then( function ()
            {
                var m = window.NayiveMedia;
                return m && m[ verb ] ? m[ verb ]( arg ) : null;
            } )
            .catch( function () {} );
    }

    // The shared tree lives in browser.js, which only the list apps load: the
    // picker fetches it on first use from beside this file, like media.js.
    var BROWSER_JS = MEDIA_JS.replace( /media\.js$/, "browser.js" );
    var browserLoad = null;

    function loadBrowser()
    {
        if( window.NayiveUI && window.NayiveUI.tree ) return Promise.resolve();
        if( ! browserLoad )
            browserLoad = new Promise( function ( resolve )
            {
                var s = document.createElement( "script" );
                s.src     = BROWSER_JS;
                s.onload  = resolve;
                s.onerror = function () { browserLoad = null; resolve(); };
                document.head.appendChild( s );
            } );
        return browserLoad;
    }

    // Its look (.fp-*, and the shared tree's .ntree) is in shared/app.css.
    function pickFolder( opts )
    {
        opts = opts || {};

        return new Promise( function ( resolve )
        {
            var done      = false;
            var expanded  = {};       // folder path -> true
            var selected  = null;     // the folder path the user has highlighted
            var filesNode = null;     // { path:'files', nodes:[...] }, once loaded
            var treeErr   = false;
            var jsErr     = false;   // browser.js failed to load: show it, never retry in a loop

            // The three folder verbs (delete / rename / new folder) live in the
            // bottom-left corner. While a name is being typed the same sheet
            // becomes the name form: the tree stays visible, and x / v mean
            // "drop the name" / "apply it" instead of "cancel" / "choose".
            // No second dialog is stacked on this one - a child sheet would sit
            // under this one's document-level Escape handler.
            var nameMode   = null;    // null | "create" | "rename"
            var nameTarget = null;    // create: the parent folder;  rename: the folder itself
            var nameVal    = "";
            var namePicked = false;   // the text was select()ed once already
            var busy       = false;   // a server call is in flight

            // Escape is heard on document/capture, BEFORE the name field's own
            // keydown: while a name is open, that is what Escape drops.
            var d     = modal( { escape: function () { if( nameMode ) cancelName(); else finish( null ); } } );
            var sheet = d.sheet;

            function finish( val )
            {
                if( ! d.close() ) return;
                done = true;
                resolve( val || null );
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
            // is a folder; a folder with no sub-folders just has nodes:[]. It is
            // drawn by the shared tree (shared/browser.js, NayiveUI.tree), the
            // same one every "Move to…" and side pane uses: the arrow opens and
            // closes, a click lights a folder, a double-click / Enter chooses it.
            function treeNodes( nodes )
            {
                return sortNodes( nodes || [] ).filter( function ( n ) { return Array.isArray( n.nodes ); } )
                    .map( function ( n )
                    {
                        return { id: n.path, name: String( n.path ).split( "/" ).pop(), kids: treeNodes( n.nodes ) };
                    } );
            }

            // One of the three bottom-left folder buttons.
            function fpAct( act, title, off, fn )
            {
                var b = document.createElement( "button" );
                b.setAttribute( "data-act", act );
                b.title    = title;
                b.disabled = !! off;
                b.addEventListener( "click", fn );
                return b;
            }

            //---- the tree -------------------------------------------------//

            function loadTree()
            {
                return ( window.GumApi ? GumApi.dirTree() : Promise.reject( new Error( "no GumApi" ) ) )
                    .then( function ( tree )
                    {
                        var nodes = ( tree && tree.nodes ) || [];
                        var found = null;
                        for( var i = 0; i < nodes.length; i++ )
                            if( nodes[ i ].path === "files" ) { found = nodes[ i ]; break; }
                        filesNode = found || { path: "files", nodes: [] };
                        treeErr   = false;
                    },
                    function () { treeErr = true; } );
            }

            function nodeAt( node, path )
            {
                if( ! node ) return null;
                if( node.path === path ) return node;

                var kids = node.nodes || [];
                for( var i = 0; i < kids.length; i++ )
                {
                    var hit = nodeAt( kids[ i ], path );
                    if( hit ) return hit;
                }
                return null;
            }

            // Run one server call, then re-read the whole tree: the server is
            // the truth, so nothing here patches the local nodes by hand. `p`
            // resolves to the path that should stay selected afterwards.
            function runTask( p )
            {
                busy     = true;
                nameMode = null;
                render();

                p.then( function ( sel ) { selected = sel || null; }, taskFailed )
                 .then( loadTree )
                 .then( function ()
                 {
                     busy = false;
                     if( selected && ! nodeAt( filesNode, selected ) ) selected = null;
                     render();
                 } );
            }

            //---- delete / rename / new folder -----------------------------//

            function startName( mode )
            {
                nameMode   = mode;
                namePicked = false;
                nameTarget = mode === "create" ? ( selected || filesNode.path ) : selected;
                nameVal    = mode === "create" ? "" : String( selected ).split( "/" ).pop();
                render();
            }

            function cancelName()
            {
                nameMode   = null;
                nameTarget = null;
                nameVal    = "";
                render();
            }

            // A folder name is ONE segment: not empty, no "/", not "." / "..".
            function nameOk()
            {
                var nm = String( nameVal || "" ).trim();
                return !! nm && nm.indexOf( "/" ) === -1 && nm !== "." && nm !== "..";
            }

            function commitName()
            {
                if( ! nameOk() ) return;

                var nm     = String( nameVal ).trim();
                var target = nameTarget;

                if( nameMode === "create" )
                {
                    expanded[ target ] = true;          // show the new child at once
                    runTask( GumApi.makeDir( target, nm )
                                   .then( function () { return target + "/" + nm; } ) );
                    return;
                }

                var to = target.slice( 0, target.lastIndexOf( "/" ) + 1 ) + nm;
                if( to === target ) { cancelName(); return; }

                runTask( renameFolder( target, to ).then( function ()
                {
                    undoToast( t( "ui.toast.renamed" ), function ()
                    {
                        afterUndo( renameFolder( to, target ).then( function () { return target; } ) );
                    } );
                    return to;
                } ) );
            }

            function renameFolder( from, to )
            {
                return GumApi.rename( from, to ).then( function ()
                {
                    // The whole sub-tree moves with the folder, so re-key what
                    // the user had open under it or it all collapses on the
                    // reload. Only once the server has said yes: a refused
                    // rename must leave the tree exactly as it was.
                    var reopen = {};
                    Object.keys( expanded ).forEach( function ( k )
                    {
                        var moved = ( k === from || k.indexOf( from + "/" ) === 0 );
                        reopen[ moved ? to + k.slice( from.length ) : k ] = expanded[ k ];
                    } );
                    expanded = reopen;

                    // The photo notes and scan entries under it follow, as
                    // they do on a rename in Drive.
                    return sidecarUpkeep( "remapPaths", [ [ from, to ] ] );
                } );
            }

            // An Undo's server call: on the tree when the picker is still open,
            // on its own when it has closed meanwhile.
            function afterUndo( p )
            {
                if( ! done ) runTask( p );
                else p.catch( taskFailed );
            }

            // A name already taken is the server's 409: say it in words, not
            // "HTTP 409: Conflict".
            function taskFailed( err )
            {
                toast( err && err.status === 409 ? t( "drive.nameExistsTitle" )
                                                 : String( ( err && err.message ) || err ) );
            }

            // Straight to the papelera - Drive can put it back - so this acts at
            // once, with an Undo: a delete already inside a dialog never asks a
            // second time. Its scan entries and thumbnails go, as on a delete in
            // Drive (the notes stay, so a restore brings them back).
            function deleteFolder()
            {
                var gone = selected;
                runTask( GumApi.binPaths( [ gone ] ).then( function ( ids )
                {
                    if( ids && ids.length )
                        undoToast( t( "ui.toast.binned" ), function ()
                        {
                            afterUndo( GumApi.trashRestore( ids ).then( function () { return gone; } ) );
                        } );
                    return sidecarUpkeep( "purgePaths", [ gone ] ).then( function () { return null; } );
                } ) );
            }

            //---- the sheet ------------------------------------------------//

            function render()
            {
                // Keep the tree scrolled where it was across the rebuild.
                var prevBox    = sheet.querySelector( ".fp-tree" );
                var prevScroll = prevBox ? prevBox.scrollTop : 0;
                var hadFocus   = !! prevBox && prevBox.contains( document.activeElement );

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

                if( treeErr || jsErr )
                    box.appendChild( fpMsg( t( "ui.fp.loadError" ) ) );
                else if( filesNode === null )
                    box.appendChild( fpMsg( t( "ui.fp.loading" ) ) );
                else if( ! window.NayiveUI.tree )
                {
                    box.appendChild( fpMsg( t( "ui.fp.loading" ) ) );
                    loadBrowser().then( function () { if( ! window.NayiveUI.tree ) jsErr = true; if( ! done ) render(); } );
                }
                else
                {
                    var kids  = treeNodes( filesNode.nodes );
                    var roots = opts.allowRoot
                              ? [ { id: filesNode.path, name: opts.rootLabel || t( "ui.fp.allFiles" ), kids: kids } ]
                              : kids;
                    if( opts.allowRoot ) expanded[ filesNode.path ] = expanded[ filesNode.path ] !== false;

                    if( ! roots.length )
                        box.appendChild( fpMsg( t( "ui.fp.noFolders" ) ) );
                    else
                    {
                        var host = document.createElement( "div" );
                        box.appendChild( host );
                        var tr = window.NayiveUI.tree( {
                            host:     host,
                            pick:     true,
                            roots:    function () { return roots; },
                            isOpen:   function ( id ) { return !! expanded[ id ]; },
                            setOpen:  function ( id, v ) { expanded[ id ] = v; },
                            current:  function () { return selected; },
                            disabled: function () { return busy; },
                            go:       function ( id ) { selected = id; render(); },
                            confirm:  function ( id ) { if( ! busy && ! nameMode ) finish( id ); }
                        } );
                        if( hadFocus ) tr.focus( selected );     // the keys stay in the tree across a redraw
                    }
                }

                box.scrollTop = prevScroll;

                // The name form, only while Rename / New folder is open.
                var input = null;

                if( nameMode )
                {
                    var fld = document.createElement( "div" );
                    fld.className = "field";

                    var lab = document.createElement( "label" );
                    lab.textContent = nameMode === "create" ? t( "ui.newFolder" ) : t( "ui.rename" );
                    fld.appendChild( lab );

                    input = document.createElement( "input" );
                    input.type         = "text";
                    input.autocomplete = "off";
                    input.value        = nameVal;
                    input.addEventListener( "input", function ()
                    {
                        nameVal     = input.value;
                        ok.disabled = ! nameOk();
                    } );
                    input.addEventListener( "keydown", function ( e )
                    {
                        if( e.key === "Enter" ) { e.preventDefault(); commitName(); }
                    } );
                    fld.appendChild( input );

                    sheet.appendChild( fld );
                }

                var arow = document.createElement( "div" );
                arow.className = "sheet-actions";

                if( ! nameMode )
                {
                    // Folder housekeeping, pinned to the far left: delete or
                    // rename the highlighted folder, create one inside it (with
                    // nothing highlighted, "new" creates it in Files itself).
                    var ready = ! busy && !! filesNode && ! treeErr;
                    var onOne = ready && !! selected && selected !== filesNode.path;

                    var left = document.createElement( "div" );
                    left.className = "sheet-actions-left";
                    left.appendChild( fpAct( "danger", t( "ui.delete" ), ! onOne, deleteFolder ) );
                    left.appendChild( fpAct( "secondary:edit", t( "ui.rename" ), ! onOne,
                                             function () { startName( "rename" ); } ) );
                    left.appendChild( fpAct( "secondary:folderplus", t( "ui.newFolder" ), ! ready,
                                             function () { startName( "create" ); } ) );
                    arow.appendChild( left );
                }

                var cancel = document.createElement( "button" );
                cancel.setAttribute( "data-act", "close" );
                cancel.title = t( "ui.cancel" );
                arow.appendChild( cancel );

                var ok = document.createElement( "button" );
                ok.setAttribute( "data-act", "primary" );
                ok.title = ! nameMode ? t( "ui.fp.choose" )
                         : nameMode === "create" ? t( "ui.newFolder" ) : t( "ui.rename" );
                arow.appendChild( ok );

                sheet.appendChild( arow );

                applySheetButtons( sheet );

                cancel.addEventListener( "click", function ()
                {
                    if( nameMode ) cancelName();
                    else           finish( null );
                } );

                if( nameMode )
                {
                    ok.disabled = ! nameOk();
                    ok.addEventListener( "click", commitName );
                    input.focus();
                    if( ! namePicked ) { namePicked = true; input.select(); }
                }
                else
                {
                    ok.disabled = ! selected || busy;
                    ok.addEventListener( "click", function () { if( selected ) finish( selected ); } );
                }
            }

            d.show( render );

            loadTree().then( render );
        } );
    }

    //------------------------------------------------------------------------//
    // FILE PICKER
    //
    // Pick ONE file from the user's own files/ tree - for an app that sends
    // something already in Nayive (Chat: the clip's "Nayive doc", a picture
    // for a profile). One folder at a time: the crumb on top goes back up,
    // folders come first, then the files with their size. A folder opens on a
    // tap; a file is highlighted on a tap and chosen with the button (or a
    // double tap). opts.dir: the folder it opens in ("files" by default);
    // opts.only( name ): the files to show (every folder always shows).
    //
    //   const f = await NayiveUI.pickFile( { title: 'Elige un archivo' } );
    //   if( f ) { ... }       // { path: "files/fotos/a.jpg", name: "a.jpg", size: 1234 }
    //
    // Needs GumApi (listDir). Same closing rules as pickFolder: its own
    // buttons or Escape, never a backdrop click.

    function pickFile( opts )
    {
        opts = opts || {};

        return new Promise( function ( resolve )
        {
            var dir      = opts.dir || "files";
            var nodes    = null;      // what `dir` holds, once listed
            var failed   = false;
            var selected = null;      // the highlighted file's node
            var seq      = 0;         // the newest listing asked for

            var d     = modal( { escape: function () { finish( null ); } } );
            var sheet = d.sheet;

            function finish( node )
            {
                if( d.close() ) resolve( node ? { path: node.path, name: nameOf( node ), size: node.size || 0 } : null );
            }

            function nameOf( n )  { return String( n.path ).split( "/" ).pop(); }
            function isDir( n )   { return Array.isArray( n.nodes ); }

            function open( path )
            {
                dir = path; nodes = null; failed = false; selected = null;
                var my = ++seq;
                render();
                ( window.GumApi ? GumApi.listDir( path ) : Promise.reject( new Error( "no GumApi" ) ) ).then( function ( res )
                {
                    if( my !== seq ) return;
                    nodes = ( ( res && res.nodes ) || [] ).filter( function ( n )
                    {
                        if( nameOf( n ).charAt( 0 ) === "." ) return false;   // hide .bak etc.
                        return isDir( n ) || ! opts.only || opts.only( nameOf( n ) );
                    } ).sort( function ( a, b )
                    {
                        if( isDir( a ) !== isDir( b ) ) return isDir( a ) ? -1 : 1;
                        return nameOf( a ).localeCompare( nameOf( b ), undefined, { numeric: true, sensitivity: "base" } );
                    } );
                    render();
                }, function () { if( my === seq ) { failed = true; render(); } } );
            }

            function fpMsg( text )
            {
                var p = document.createElement( "p" );
                p.className   = "fp-msg";
                p.textContent = text;
                return p;
            }

            function fileRow( n )
            {
                var row = document.createElement( "div" );
                row.className = "fp-row" + ( selected === n ? " sel" : "" );
                row.setAttribute( "role", "option" );
                row.setAttribute( "aria-selected", selected === n ? "true" : "false" );

                var caret = document.createElement( "span" );
                caret.className   = "fp-caret";
                caret.textContent = isDir( n ) ? "▸" : "";
                row.appendChild( caret );

                var ic = document.createElement( "span" );
                ic.className = "fp-ic";
                ic.innerHTML = icon( isDir( n ) ? "folder" : "doc" );
                row.appendChild( ic );

                var name = document.createElement( "span" );
                name.className   = "fp-name";
                name.textContent = nameOf( n );
                row.appendChild( name );

                if( ! isDir( n ) )
                {
                    var size = document.createElement( "span" );
                    size.className   = "fp-size";
                    size.textContent = fmtBytes( n.size || 0 );
                    row.appendChild( size );
                }

                row.addEventListener( "click", function ()
                {
                    if( isDir( n ) ) { open( n.path ); return; }
                    selected = n;
                    render();
                } );
                if( ! isDir( n ) ) row.addEventListener( "dblclick", function () { finish( n ); } );
                return row;
            }

            function render()
            {
                sheet.innerHTML = "";

                var h = document.createElement( "h2" );
                h.textContent = opts.title || t( "ui.fp.pickFile" );
                sheet.appendChild( h );

                // "Archivos > fotos > 2024": every step but the last goes back there.
                var crumbs = document.createElement( "div" );
                crumbs.className = "fp-crumbs";
                var parts = String( dir ).split( "/" );
                parts.forEach( function ( part, i )
                {
                    if( i ) crumbs.appendChild( document.createTextNode( "›" ) );
                    var label = i === 0 ? t( "ui.filesRoot" ) : part;
                    var el;
                    if( i === parts.length - 1 ) { el = document.createElement( "b" ); el.textContent = label; }
                    else
                    {
                        el = document.createElement( "button" );
                        el.type        = "button";
                        el.textContent = label;
                        el.addEventListener( "click", function () { open( parts.slice( 0, i + 1 ).join( "/" ) ); } );
                    }
                    crumbs.appendChild( el );
                } );
                sheet.appendChild( crumbs );

                var box = document.createElement( "div" );
                box.className = "fp-tree";
                box.setAttribute( "role", "listbox" );
                sheet.appendChild( box );

                if( failed )             box.appendChild( fpMsg( t( "ui.fp.loadError" ) ) );
                else if( nodes === null ) box.appendChild( fpMsg( t( "ui.fp.loading" ) ) );
                else if( ! nodes.length ) box.appendChild( fpMsg( t( "ui.fp.emptyFolder" ) ) );
                else nodes.forEach( function ( n ) { box.appendChild( fileRow( n ) ); } );

                var arow = document.createElement( "div" );
                arow.className = "sheet-actions";

                var cancel = document.createElement( "button" );
                cancel.setAttribute( "data-act", "close" );
                cancel.title = t( "ui.cancel" );
                cancel.addEventListener( "click", function () { finish( null ); } );
                arow.appendChild( cancel );

                var ok = document.createElement( "button" );
                ok.setAttribute( "data-act", "primary" );
                ok.title    = opts.confirm || t( "ui.fp.chooseFile" );
                ok.disabled = ! selected;
                ok.addEventListener( "click", function () { if( selected ) finish( selected ); } );
                arow.appendChild( ok );

                sheet.appendChild( arow );
                applySheetButtons( sheet );
            }

            d.show();
            open( dir );
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
                return saveLauncherFolder( cfgPath, cfg, picked );
            } );
        }, function ( err )
        {
            if( err && err.status === 401 && ! opts.noRedirect && navigator.onLine ) GumApi.loginRedirect();
            return null;
        } );
    }

    // The app's config.json keeps whatever else it holds: only `folder`
    // changes. `cfg` is what it holds now (null = no file yet). Resolves with
    // `picked` either way - a failed write costs only the memory of it.
    function saveLauncherFolder( cfgPath, cfg, picked )
    {
        var next = ( cfg && typeof cfg === "object" && ! Array.isArray( cfg ) ) ? cfg : {};
        next.folder = picked;
        return GumApi.writeJson( cfgPath, next )
            .then( function () { return picked; }, function () { return picked; } );
    }

    // Change the remembered folder later (the crumb button): pick + save. The
    // caller reloads at ?dir=<result>. The file is read again first: an
    // unreadable one (not a 404) is left as it is rather than written over.
    function changeLauncherFolder( opts )
    {
        opts = opts || {};
        var cfgPath = "data/" + opts.app + "/config.json";
        return pickFolder( {
            title:     opts.title || t( "ui.changeFolder" ),
            note:      opts.note,
            allowRoot: opts.allowRoot,
            rootLabel: opts.rootLabel
        } ).then( function ( picked )
        {
            if( ! picked ) return null;
            return GumApi.readJson( cfgPath ).then( function ( cfg )
            {
                return saveLauncherFolder( cfgPath, cfg, picked );
            }, function () { return picked; } );
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

    // PUSH KEYS (the launcher, a Chat link). base64url (the server's VAPID key)
    // -> the bytes pushManager.subscribe() wants: it will not take the string.
    // (chat/guest-sw.js keeps its own copy: a worker cannot load this file.)
    function b64ToU8( s )
    {
        var pad = "=".repeat( ( 4 - s.length % 4 ) % 4 );
        var raw = atob( ( s + pad ).replace( /-/g, "+" ).replace( /_/g, "/" ) );
        var out = new Uint8Array( raw.length );
        for( var i = 0; i < raw.length; i++ ) out[ i ] = raw.charCodeAt( i );
        return out;
    }

    // Does this subscription still match the server's VAPID key? If the key
    // was regenerated, the push service rejects every message for it forever -
    // and nothing would ever say so. Can't tell -> true (don't nag the user).
    function samePushKey( sub, b64 )
    {
        try
        {
            var a = new Uint8Array( sub.options.applicationServerKey ), b = b64ToU8( b64 );
            if( a.length !== b.length ) return false;
            for( var i = 0; i < a.length; i++ ) if( a[ i ] !== b[ i ] ) return false;
            return true;
        }
        catch ( e ) { return true; }
    }
    // A browser embedded in another app (Instagram, Facebook, WhatsApp...): it can
    // never install anything, the user has to open Nayive in a real browser first.
    function isInAppBrowser()
    {
        return /FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Twitter/i.test( navigator.userAgent );
    }
    // Inside the Nayive Android app (a Trusted Web Activity): Chrome gives the
    // first page the app opens the referrer "android-app://org.nayive.app/";
    // the later pages of that tab find it in sessionStorage. device.html (only
    // the app opens it) sets the same flag.
    var IN_APK = "nayive-apk";
    try { if( /^android-app:\/\/org\.nayive\.app\b/.test( document.referrer ) ) sessionStorage.setItem( IN_APK, "1" ); } catch ( _ ) {}
    function inAndroidApp()
    {
        try { return sessionStorage.getItem( IN_APK ) === "1"; } catch ( _ ) { return false; }
    }

    // What can this device actually do right now?
    //   installed | prompt (Chromium) | ios (manual steps) | inapp |
    //   android (manual steps) | unsupported
    //
    // "android": Chrome on Android does not always fire beforeinstallprompt
    // (its own rules on when to offer it), yet its ⋮ menu always has "Instalar
    // app". Saying "this browser can't" there was simply wrong (2026-09-19).
    function installMode()
    {
        var v;
        try { v = localStorage.getItem( INSTALL_SNOOZE ); } catch ( _ ) {}
        if( isStandalone() || v === "installed" ) return "installed";
        if( deferredInstall )                     return "prompt";
        if( isIOS() )                             return "ios";
        if( isInAppBrowser() )                    return "inapp";
        if( /android/i.test( navigator.userAgent ) ) return "android";
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
        var d     = modal( { id: "nayive-install-bar", cls: "intro-sheet install-sheet" } );
        var back  = d.back;
        var sheet = d.sheet;

        function finish() { d.close(); }
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

        if( mode === "android" )
        {
            var subA = document.createElement( "p" );
            subA.className   = "scm-h install-h";
            subA.textContent = t( "ui.install.stepsH" );
            sheet.appendChild( subA );

            var olA = document.createElement( "ol" );
            olA.className = "install-steps";
            olA.appendChild( installStep( "menudots", t( "ui.install.a1a" ),
                                                      t( "ui.install.a1b" ),
                                                      t( "ui.install.a1c" ) ) );
            olA.appendChild( installStep( "addhome",  t( "ui.install.a2a" ),
                                                      t( "ui.install.a2b" ),
                                                      t( "ui.install.a2c" ) ) );
            olA.appendChild( installStep( "check",    t( "ui.install.a3a" ),
                                                      t( "ui.install.a3b" ),
                                                      t( "ui.install.a3c" ) ) );
            sheet.appendChild( olA );
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

        d.show();
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
    // than forcing one - Write may hold unsaved text, and share-target
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
     * (server/go/shares.go + Users.Resolve in users.go).
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
     * `fresh` asks again and remembers the new answer: Trips and Split re-read
     * the list on every refresh, so a share made or taken back meanwhile shows.
     * Returns a promise of the /api/shares "with_me" array, [] on any failure. */
    var _withMe = null;

    function sharedWithMe( fresh )
    {
        if( ! _withMe || fresh )
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
     * (server/go/shares.go Modes). A path of our own resolves to false - our own
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
        return jsonApi( "/api/shares" + ( id ? "?id=" + encodeURIComponent( id ) : "" ), method, body );
    }

    // One JSON call to this server: the parsed answer, or an Error with its message.
    function jsonApi( path, method, body )
    {
        var url  = window.location.origin + path;
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

    // The full URL of a server path the API answered with ("/s/<token>", "/api/location/<key>").
    function linkUrl( g ) { return window.location.origin + g.url; }

    // A round icon button (.share-drop) that disables itself while its action runs.
    function rowButton( name, title, action )
    {
        var b = document.createElement( "button" );
        b.type      = "button";
        b.className = "share-drop";
        b.title     = title;
        b.setAttribute( "aria-label", title );
        b.innerHTML = icon( name );
        b.addEventListener( "click", function ()
        {
            b.disabled = true;
            Promise.resolve().then( action )
                .catch( function ( e ) { toast( e.message ); } )
                .then( function () { b.disabled = false; } );
        } );
        return b;
    }

    // To the clipboard. navigator.clipboard is absent on the plain-HTTP LAN URL
    // (it needs a secure context) and may refuse; then a hidden textarea and
    // execCommand("copy"). Resolves when one of the two worked.
    function copyText( value )
    {
        function legacy()
        {
            var ta = document.createElement( "textarea" );
            ta.value = value;
            ta.setAttribute( "readonly", "" );
            ta.style.position = "fixed";
            ta.style.opacity  = "0";
            document.body.appendChild( ta );
            ta.select();
            var ok = false;
            try { ok = document.execCommand( "copy" ); } catch ( e ) {}
            ta.remove();
            if( ! ok ) throw new Error( "copy failed" );
        }

        if( navigator.clipboard && navigator.clipboard.writeText )
            return navigator.clipboard.writeText( value ).catch( legacy );
        return new Promise( function ( resolve ) { legacy(); resolve(); } );
    }

    // To this device as a file (a download): `data` is a Blob / File as it is,
    // or text put in one of `type`. A throwaway link, dropped after 1 s.
    function saveFile( data, name, type )
    {
        var blob = data instanceof Blob ? data : new Blob( [ data ], { type: type } );
        var a = document.createElement( "a" );
        a.href = URL.createObjectURL( blob );
        a.download = name;
        document.body.appendChild( a );
        a.click();
        setTimeout( function () { URL.revokeObjectURL( a.href ); a.remove(); }, 1000 );
    }

    // "Export to PDF" with no PDF library (Calendar, Split): `html` goes into the
    // page's hidden #printRoot, <html> gets .printing (the page's own @media print
    // rules show only #printRoot), `title` seeds the suggested file name, and the
    // browser's print dialog writes the file ("Save as PDF"). All undone on afterprint.
    function printPage( html, title, hintKey )
    {
        var root = document.getElementById( "printRoot" );
        root.innerHTML = html;

        var prevTitle = document.title;
        document.title = title;
        document.documentElement.classList.add( "printing" );

        window.addEventListener( "afterprint", function done()
        {
            window.removeEventListener( "afterprint", done );
            document.documentElement.classList.remove( "printing" );
            document.title = prevTitle;
            root.innerHTML = "";
        } );

        toast( t( hintKey ), { ms: 5000 } );
        setTimeout( function () { window.print(); }, 350 );
    }

    // The public links whose × is still on Undo: a sheet opened again meanwhile
    // must not show (or hand out) a link about to die.
    var linksGoing = {};

    /* The "Compartir" dialog: tick one or more people, see who already has it, take it back.
     * opts = { path, app, title }. Resolves when the dialog closes. */
    function shareSheet( opts )
    {
        opts = opts || {};
        var path = opts.path || "";

        return new Promise( function ( resolve )
        {
            // Escape as the other dialogs take it: from anywhere (nothing inside
            // needs the focus first), and never on to the app underneath. Only
            // while this is the top sheet: a question asked from inside it
            // (NayiveUI.confirm) is closed by its own Escape, not this one.
            // Closed, it fades out before it goes.
            var d = modal( { escape: close, linger: 200, top: function () { return topSheetBackdrop() === back; } } );
            var back  = d.back;
            var sheet = d.sheet;

            var users = [], mine = [], chosen = [];   // chosen = every person ticked right now
            var mayAdd = false;                      // "pueden añadir archivos" ticked?
            var toAll  = false;                      // "Todos" ticked: one grant to every user, now and later
            var link   = null;                       // a trip's public link, when it has one
            var dropped = false;                     // × on the link: no new one until the sheet opens again

            function close()
            {
                if( d.close() ) resolve();
            }

            var ok = null;   // the "Compartir" button, so a tick-box can enable it

            function render()
            {
                ok = null;
                sheet.innerHTML = "";

                var what = opts.title || path.split( "/" ).pop();

                var h = document.createElement( "h2" );
                h.textContent = tf( "share.title", { what: what } );
                sheet.appendChild( h );

                // --- anyone with the link (a trip only - server/go/api_public.go), above the people ---
                if( opts.app === "trips" ) sheet.appendChild( linkSection() );

                // --- only the people you pick: a heading and a note, like the link's ---
                var people = document.createElement( "div" );
                people.className = "share-sect";

                var head = document.createElement( "p" );
                head.className   = "share-head";
                head.textContent = t( "share.people.head" );
                people.appendChild( head );

                var lead = document.createElement( "p" );
                lead.className = "share-note";

                // The note says what the share will actually allow, so it never
                // contradicts the "pueden añadir" tick below it.
                function setLead()
                {
                    lead.textContent = mayAdd                ? t( "share.leadadd" )
                                     : opts.app === "trips" ? t( "share.leadTrip" )
                                     :                        t( "share.lead" );
                }
                setLead();
                people.appendChild( lead );

                // --- who already has it ---
                if( mine.length )
                {
                    var have = document.createElement( "div" );
                    have.className = "share-have";
                    mine.forEach( function ( g )
                    {
                        var row = document.createElement( "div" );
                        row.className = "share-row";

                        // "*" is the grant to everybody (server/go/shares.go Everyone).
                        var name = g.to === "*" ? t( "share.all" ) : g.to;
                        var who  = document.createElement( "span" );
                        who.textContent = g.mode === "add"
                                        ? tf( "share.hasadd", { who: name } )
                                        : name;
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
                                .then( function ()
                                {
                                    // Undo shares it again, the same way (a new grant, same person and rights).
                                    undoToast( tf( "share.stopped", { who: name } ), function ()
                                    {
                                        shareApi( "POST", { to: g.to, root: path, app: g.app || opts.app || "folder",
                                                            title: g.title || opts.title || "", mode: g.mode || "ro" } )
                                            .catch( function ( e ) { toast( e.message ); } )
                                            .then( function () { if( back.parentNode ) return load(); } );
                                    } );
                                    return load();
                                } )
                                .catch( function ( e ) { toast( e.message ); del.disabled = false; } );
                        } );
                        row.appendChild( del );
                        have.appendChild( row );
                    } );
                    people.appendChild( have );
                }

                // --- who else could have it ---
                // Shared with everybody already: nobody is left to pick.
                var already = mine.map( function ( g ) { return g.to; } );
                var free    = already.indexOf( "*" ) !== -1 ? []
                            : users.filter( function ( n ) { return already.indexOf( n ) === -1; } );

                if( ! free.length )
                {
                    var none = document.createElement( "p" );
                    none.className   = "fp-msg";
                    none.textContent = users.length
                        ? t( "share.everyone" )
                        : t( "share.nobody" );
                    people.appendChild( none );
                }
                else
                {
                    var list = document.createElement( "div" );
                    list.className = "share-pick";
                    list.setAttribute( "role", "group" );
                    list.setAttribute( "aria-label", t( "share.pick" ) );
                    list.classList.toggle( "all", toAll );

                    // "Todos" on top, the whole width: one grant that also reaches
                    // whoever gets an account later. While it is ticked the names
                    // below are greyed out - everybody is in already.
                    var allLab = document.createElement( "label" );
                    allLab.className = "share-user share-all" + ( toAll ? " on" : "" );

                    var allBox = document.createElement( "input" );
                    allBox.type    = "checkbox";
                    allBox.checked = toAll;
                    allBox.addEventListener( "change", function ()
                    {
                        toAll = allBox.checked;
                        allLab.classList.toggle( "on", toAll );
                        list.classList.toggle( "all", toAll );
                        list.querySelectorAll( "input" ).forEach( function ( b ) { if( b !== allBox ) b.disabled = toAll; } );
                        if( ok ) ok.disabled = ! ( toAll || chosen.length );
                    } );

                    var allName = document.createElement( "span" );
                    allName.textContent = t( "share.allPick" );
                    allLab.title = allName.textContent;

                    allLab.appendChild( allBox );
                    allLab.appendChild( allName );
                    list.appendChild( allLab );

                    free.forEach( function ( name )
                    {
                        var on  = chosen.indexOf( name ) !== -1;
                        var lab = document.createElement( "label" );
                        lab.className = "share-user" + ( on ? " on" : "" );

                        // A plain <input type="checkbox"> inside a <label>: every browser
                        // draws it, and clicking the name ticks it. No custom drawing.
                        var box = document.createElement( "input" );
                        box.type     = "checkbox";
                        box.value    = name;
                        box.checked  = on;
                        box.disabled = toAll;
                        box.addEventListener( "change", function ()
                        {
                            var at = chosen.indexOf( name );
                            if( box.checked ) { if( at === -1 ) chosen.push( name ); }
                            else if( at !== -1 ) chosen.splice( at, 1 );

                            // No render() here: it would scroll the list back to the top.
                            lab.classList.toggle( "on", box.checked );
                            if( ok ) ok.disabled = ! ( toAll || chosen.length );
                        } );

                        // A <span>, not a bare text node: only an element can end in "..."
                        // when the name is wider than its column. The tooltip has it whole.
                        var nm = document.createElement( "span" );
                        nm.textContent = name;
                        lab.title = name;

                        lab.appendChild( box );
                        lab.appendChild( nm );
                        list.appendChild( lab );
                    } );
                    people.appendChild( list );
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

                    // An on / off option: the text, then the shared .switch.
                    var addSw = document.createElement( "span" );
                    addSw.className = "switch sm";
                    var addTrack = document.createElement( "span" );
                    addTrack.className = "track";
                    addSw.appendChild( addBox );
                    addSw.appendChild( addTrack );

                    addLab.appendChild( document.createTextNode(
                        t( "share.mayadd" ) ) );
                    addLab.appendChild( addSw );
                    people.appendChild( addLab );
                }
                sheet.appendChild( people );

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
                    ok.disabled = ! ( toAll || chosen.length );
                    ok.addEventListener( "click", function ()
                    {
                        if( ! toAll && ! chosen.length ) return;
                        ok.disabled = true;

                        // Everybody: ONE grant. The server drops the ones made to
                        // single people for this same item.
                        if( toAll )
                        {
                            shareApi( "POST", { to: "*", root: path,
                                                app: opts.app || "folder", title: opts.title || "",
                                                mode: mayAdd ? "add" : "ro" } )
                                .then( function ()
                                {
                                    toAll = false;
                                    toast( t( "share.allDone" ) );
                                    return load();
                                } )
                                .catch( function ( e ) { toast( e.message ); return load(); } );
                            return;
                        }

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

            // "Cualquiera con el enlace": the trip's public link - send it, copy it,
            // take it away. Nothing to "create": load() makes it as the sheet opens.
            // The row is the same .share-row / .share-drop as a person's.
            function linkSection()
            {
                var box = document.createElement( "div" );
                box.className = "share-sect share-link";

                var head = document.createElement( "p" );
                head.className   = "share-head";
                head.textContent = t( "share.link.head" );
                box.appendChild( head );

                var note = document.createElement( "p" );
                note.className   = "share-note";
                note.textContent = t( "share.link.warn" );
                box.appendChild( note );

                var row = document.createElement( "div" );
                row.className = "share-row";

                // "..." while load() is still making it; after its ×, how to get one back.
                var text = document.createElement( "span" );
                text.className   = "share-link-url";
                text.textContent = link ? linkUrl( link ) : dropped ? t( "share.link.none" ) : "…";
                row.appendChild( text );

                if( link )
                {
                    var url = linkUrl( link );
                    if( navigator.share )
                        row.appendChild( rowButton( "share", t( "share.link.send" ), function ()
                        {
                            return navigator.share( { title: opts.title || "", url: url } )
                                            .catch( function () { /* the person closed the share sheet */ } );
                        } ) );
                    row.appendChild( rowButton( "copy", t( "share.link.copy" ), function ()
                    {
                        return copyText( url ).then( function () { toast( t( "share.link.copied" ) ); },
                                                     function () { toast( url ); } );
                    } ) );
                    // Gone from the sheet at once; the link itself dies when the
                    // Undo does (a new link would be a new address).
                    row.appendChild( rowButton( "x", t( "share.link.stop" ), function ()
                    {
                        var id = link.id;
                        linksGoing[ id ] = true;
                        link    = null;
                        dropped = true;
                        render();
                        undoToast( t( "share.link.stopped" ), function ()
                        {
                            delete linksGoing[ id ];
                            dropped = false;
                            if( back.parentNode ) load();
                        }, { onExpire: function ()
                        {
                            shareApi( "DELETE", null, id )
                                .catch( function ( e ) { toast( e.message ); } )
                                .then( function () { delete linksGoing[ id ]; } );
                        } } );
                    } ) );
                }
                box.appendChild( row );
                return box;
            }

            function load()
            {
                return Promise.all( [
                    fetch( window.location.origin + "/api/users" ).then( function ( r ) { return r.json(); } ),
                    shareApi( "GET" )
                ] ).then( function ( res )
                {
                    users = ( res[ 0 ] && res[ 0 ].users ) || [];
                    var here = ( ( res[ 1 ] && res[ 1 ].mine ) || [] )
                                .filter( function ( g ) { return g.root === path; } );
                    // A public link is not a person: it has its own section.
                    mine = here.filter( function ( g ) { return ! g.token; } );
                    link = here.filter( function ( g ) { return !! g.token; } )[ 0 ] || null;
                    if( link && linksGoing[ link.id ] ) { link = null; dropped = true; }   // its × is still on Undo

                    // One link per trip, the same for whoever gets it - so it is made
                    // as the sheet opens, with nothing to press first. After its ×
                    // it stays gone until the next open (his call, 2026-09-15).
                    if( opts.app === "trips" && ! link && ! dropped )
                        return shareApi( "POST", { link: true, root: path, title: opts.title || "" } )
                                   .then( function ( g ) { link = g; } );
                } ).catch( function ( e )
                {
                    toast( e.message || t( "ui.loadFailed" ) );
                } ).then( render );
            }

            d.show( render );
            load();
        } );
    }

    // The town at a (rounded) position, in the viewer's language; "" when unknown.
    // Asks OpenStreetMap's Nominatim, so pass a position already rounded.
    function townName( lat, lon )
    {
        var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=" +
                  encodeURIComponent( I18N ? I18N.locale() : "es" ) + "&lat=" + lat + "&lon=" + lon;
        return fetch( url, { headers: { Accept: "application/json" } } )
            .then( function ( r ) { return r.ok ? r.json() : {}; } )
            .then( function ( j )
            {
                var a = ( j && j.address ) || {};
                return a.city || a.town || a.village || a.municipality || a.county || a.state || "";
            } )
            .catch( function () { return ""; } );
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

    // Send the browser to the sign-in page, returning here afterwards. Framed
    // pages (Planner's iframes, a desktop window) navigate the TOP window, or
    // the sign-in form would open inside the frame. A cross-origin
    // `top.location` throws; then we fall back to ourselves. GumApi.loginRedirect
    // is this same function (admin.html and the launcher have no GumApi).
    //
    // Leaving drops whatever the page has not kept yet - a save only in this
    // page, an office document still being written, an Image edit. A page of
    // its own is guarded by its beforeunload (the browser asks). A FRAMED
    // page - a desktop window, a Planner pane - goes with the TOP window,
    // every other window with it, and its beforeunload may show nothing (no
    // click in that frame yet): so it is asked first, as the desktop's (x)
    // asks it - window.nayiveBeforeClose (shared/store.js, office.js, eMail,
    // Image). "Stay" stays; the bar's button can be pressed again.
    var redirecting = false;

    async function loginRedirect()
    {
        if( redirecting ) return;
        redirecting = true;
        try
        {
            if( window.top !== window && typeof window.nayiveBeforeClose === "function" )
            {
                var go = true;
                try { go = await Promise.resolve( window.nayiveBeforeClose() ); }
                catch ( e ) { go = true; }        // as the desktop's (x): a throw closes
                if( ! go ) return;
            }

            var win = window;
            try { if( window.top !== window && window.top.location.pathname ) win = window.top; }
            catch ( e ) {}
            win.location.href = "/nayive/login.html?return=" +
                encodeURIComponent( win.location.pathname + win.location.search );
        }
        finally { redirecting = false; }
    }

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
        btn.addEventListener( "click", loginRedirect );

        bar.appendChild( msg );
        bar.appendChild( btn );
        document.body.appendChild( bar );
        sessionBar = bar;
    }

    //------------------------------------------------------------------------//
    // SIGN OUT - the launcher's button and admin.html's link, one copy
    //
    // Sign out is a POST (a GET could be fired by a picture in an email, or a
    // link on another site): the link only works through this.
    //
    // First the saves still waiting here get one more chance to go up (up to
    // 10 s while one is being sent, no wait offline); what is left - saves and
    // untitled drafts - is counted, the user is asked, and only what was
    // counted is deleted: a save another tab makes while the question is up is
    // counted and asked about again, never deleted unseen
    // (NayiveStore.leaveDevice, shared/store.js SIGNING OUT).
    //
    // Then what this browser keeps for the account must not outlive the
    // session (forgetBrowser): the push subscription (else the notices keep
    // coming here, and the next person's sign-in would register it for them
    // too), the active trip's PDFs and the share inbox. Before the logout: the
    // DELETE needs the session. getRegistration(), not .ready - .ready never
    // settles with no service worker, and a sign-out must never hang (3 s cap).
    //
    // opts.unlinkPhone (the launcher): also THIS phone's link to the account:
    // unlinked, the Android app asks to be linked again, and the next person
    // to sign in on it gets it (server/go/devices.go, ENROLMENT). Admin's
    // sign-out does not (his call, 2026-10-04).
    // opts.swScope: the scope getRegistration asks for (admin: "/nayive/").
    function forgetBrowser( opts )
    {
        var work = ( async function ()
        {
            if( opts.unlinkPhone )
            {
                try
                {
                    var phone = JSON.parse( localStorage.getItem( "nayive-device" ) || "null" );
                    if( phone && phone.id )
                    {
                        var r = await fetch( "/api/device/" + encodeURIComponent( phone.id ),
                                             { method: "DELETE", credentials: "same-origin" } );
                        if( r.ok || r.status === 404 ) localStorage.removeItem( "nayive-device" );
                    }
                }
                catch ( e ) {}
            }
            try
            {
                var reg = ( "serviceWorker" in navigator ) ? await navigator.serviceWorker.getRegistration( opts.swScope ) : null;
                var sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
                if( sub )
                {
                    var ep = sub.endpoint;
                    try { await sub.unsubscribe(); } catch ( e ) {}
                    await fetch( "/api/push?endpoint=" + encodeURIComponent( ep ),
                                 { method: "DELETE", credentials: "same-origin" } );
                }
            }
            catch ( e ) {}
            try { localStorage.removeItem( "nayive-push-note" ); } catch ( e ) {}
            try
            {
                if( window.caches ) await Promise.all( [ caches.delete( "nayive-trips-docs" ),
                                                         caches.delete( "nayive-share-inbox" ) ] );
            }
            catch ( e ) {}
        } )();
        return Promise.race( [ work, new Promise( function ( r ) { setTimeout( r, 3000 ); } ) ] );
    }

    var signingOut = false;
    async function signOut( opts )
    {
        opts = opts || {};
        if( signingOut ) return;
        signingOut = true;
        try
        {
            if( window.NayiveStore )
            {
                var go = true;
                try
                {
                    go = await NayiveStore.leaveDevice( function ( n, why )
                    {
                        // A list save that only its app can merge (L6): going
                        // online is not enough - name the app to open.
                        var apps = ( why && why.apps ) || [];
                        // window.NayiveUI.confirm, not confirmDialog: a test answers it.
                        return window.NayiveUI.confirm( { title: t( "launcher.unsavedTitle" ),
                                                          body: apps.length ? tf( "launcher.unsavedBodyApps", { n: n, apps: apps.join( ", " ) } )
                                                                            : tf( "launcher.unsavedBody", { n: n } ),
                                                          confirm: t( "launcher.unsavedOk" ), danger: true } );
                    } );
                }
                catch ( err ) {}
                if( ! go ) return;
            }
            await forgetBrowser( opts );
            try { await fetch( "/api/logout", { method: "POST", credentials: "same-origin" } ); } catch ( err ) {}
            location.href = "/nayive/login.html";
        }
        finally { signingOut = false; }
    }

    //------------------------------------------------------------------------//
    // TRANSFER BAR - uploads and downloads, one look
    //
    // One box, a row per transfer under way: the uploads (drawn from GumApi's
    // "nayive:upload" events, below) and whatever an app hands to transfer() -
    // Drive's downloads. A row is its text with the percent, the bar, and a ✕
    // when the transfer can be stopped. Never modal: the app stays usable.
    //
    // WHERE. An app may offer room in its toolbar: an element with
    // data-transfer-slot (class .transfer-slot takes the toolbar's free width).
    // When that room is at least TRANSFER_SLOT_MIN px the box sits there, flat;
    // otherwise - a phone, a narrow window, an app with no slot - it floats
    // above the toast at the bottom, the way the upload bar always did. Asked
    // again on every update and on resize. Styled in theme.css.

    var TRANSFER_SLOT_MIN = 220;
    var transferBox = null;

    function placeTransferBox()
    {
        if( ! transferBox || ! document.body ) return;
        var slot = document.querySelector( "[data-transfer-slot]" );
        var fits = !! ( slot && slot.getClientRects().length && slot.clientWidth >= TRANSFER_SLOT_MIN );
        var host = fits ? slot : document.body;
        if( transferBox.parentNode !== host ) host.appendChild( transferBox );
        transferBox.classList.toggle( "in-slot", fits );
    }

    window.addEventListener( "resize", placeTransferBox );

    // A new row on the transfer bar; opts.onStop adds a ✕ that calls it.
    // Answers { set( text, pct ), end() }: set draws the row (it shows on the
    // first call), end takes it away - the box fades out with its last row.
    function transfer( opts )
    {
        opts = opts || {};
        if( ! transferBox )
        {
            transferBox = document.createElement( "div" );
            transferBox.className = "transfer-bar";
        }

        var row = document.createElement( "div" );
        row.className = "transfer-row";
        row.setAttribute( "role", "progressbar" );
        row.setAttribute( "aria-valuemin", "0" );
        row.setAttribute( "aria-valuemax", "100" );
        row.innerHTML = '<span class="transfer-text"></span>' +
                        '<span class="transfer-track"><span class="transfer-fill"></span></span>';
        if( opts.onStop )
        {
            var stop = document.createElement( "button" );
            stop.type      = "button";
            stop.className = "icon-btn sm transfer-stop";
            stop.title     = t( "ui.cancel" );
            stop.setAttribute( "aria-label", t( "ui.cancel" ) );
            stop.innerHTML = icon( "x" );
            stop.addEventListener( "click", function () { stop.disabled = true; opts.onStop(); } );
            row.appendChild( stop );
            row.classList.add( "can-stop" );
        }

        var ended = false;
        return {
            set: function ( text, pct )
            {
                if( ended ) return;
                pct = Math.max( 0, Math.min( 100, Math.floor( pct || 0 ) ) );
                row.setAttribute( "aria-valuenow", String( pct ) );
                row.querySelector( ".transfer-text" ).textContent = text;
                row.querySelector( ".transfer-fill" ).style.width = pct + "%";
                if( row.parentNode !== transferBox ) transferBox.appendChild( row );
                placeTransferBox();
                transferBox.classList.add( "show" );
            },
            end: function ()
            {
                if( ended ) return;
                ended = true;
                if( row.parentNode !== transferBox ) return;
                // The last row stays while the box fades, so it does not
                // shrink to an empty frame first.
                var last = true;
                for( var r = transferBox.firstChild; r; r = r.nextSibling )
                    if( r !== row && ! r.classList.contains( "ended" ) ) last = false;
                row.classList.add( "ended" );
                if( last ) transferBox.classList.remove( "show" );
                setTimeout( function () { if( row.parentNode ) row.parentNode.removeChild( row ); },
                            last ? 250 : 0 );
            }
        };
    }

    //------------------------------------------------------------------------//
    // UPLOAD PROGRESS
    //
    // GumApi.putBinary announces every upload as "nayive:upload" events on the
    // document ({ id, loaded, total }, then { id, done: true }). Most uploads -
    // a settings file, a thumbnail - finish at once and must show nothing, so
    // the row appears only once a BURST of uploads has run for UPLOAD_SHOW_MS.
    // A burst, not one request: Photos and Drive send many files one after
    // another, and each alone may be quick. It goes UPLOAD_HIDE_MS after the
    // last one ends, so it does not flicker in the gap between two files.
    //
    // The percent is of what is in flight NOW; the apps already say "3 de 12"
    // in their own status line when they send several.

    var UPLOAD_SHOW_MS = 600;
    var UPLOAD_HIDE_MS = 400;

    var uploads     = {};     // id -> { loaded, total }, the requests in flight
    var burstBytes  = 0;      // bytes the finished uploads of this burst sent
    var uploadRow   = null;   // the uploads' row on the transfer bar, while shown
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
        if( ! uploadRow ) uploadRow = transfer();
        uploadRow.set( tf( "ui.uploading", { pct: pct } ), pct );
    }

    function uploadBarShown() { return !! uploadRow; }

    function endUploadBurst()
    {
        uploadHideT = null;
        clearTimeout( uploadShowT );      // a burst that ended before the bar was due
        uploadShowT = null;
        burstStart  = 0;
        if( uploadRow ) { uploadRow.end(); uploadRow = null; }
        // A real upload (not an autosave or a thumbnail) may just have pushed
        // the space past 90%: look now rather than at the next page.
        if( burstBytes >= QUOTA_BURST_MIN ) scheduleQuotaCheck( true, 1500 );
        burstBytes = 0;
    }

    function onUploadEvent( e )
    {
        var d = e.detail || {};
        if( d.done && uploads[ d.id ] ) burstBytes += uploads[ d.id ].total;
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
    // "SPACE ALMOST FULL" CARD
    //
    // Once 90% of the account's space is used, the next Nayive page shows a
    // card at the bottom: how full it is, how to get space back (the bin, Chat,
    // big files) and a button to Drive's "Biggest files" list. It stays until
    // closed, and it is shown ONCE: this browser remembers it per account
    // ("nayive-quota-warned:<user>") and forgets it when the space drops below
    // 90% again, so filling up a second time warns a second time.
    //
    // A page checks a few seconds after it opens (its own requests go first),
    // when it comes back to the screen, and right after an upload burst of a
    // megabyte or more ends - the moment the space usually crosses the line.
    // The first two are throttled to one check per QUOTA_EVERY_MS for the whole
    // browser, and every check waits while a dialog is open. Plain
    // fetch, not GumApi: a signed-out page must get a quiet 401, not the
    // "session expired" bar. Framed pages (Planner's panes), the sign-in and
    // admin pages, and the pages behind a public link never check.

    var QUOTA_WARN_AT  = 0.9;
    var QUOTA_EVERY_MS = 10 * 60 * 1000;
    var QUOTA_BURST_MIN = 1024 * 1024;  // an upload burst this big checks at once
    var QUOTA_LAST_KEY = "nayive-quota-checked";
    var quotaCard      = null;
    var quotaTimer     = null;
    var quotaForce     = false;     // a pending check skips the throttle (an upload asked for it)

    function quotaPage()
    {
        var p = location.pathname;
        return window.top === window && p.indexOf( "/nayive/" ) === 0 &&
               ! /\/(login|admin|public|guest)\.html$/.test( p );
    }

    function scheduleQuotaCheck( force, ms )
    {
        quotaForce = quotaForce || force;
        clearTimeout( quotaTimer );
        quotaTimer = setTimeout( function ()
        {
            var f = quotaForce;
            quotaForce = false;
            checkQuota( f );
        }, ms );
    }

    function dialogOpen() { return !! document.querySelector( ".sheet-backdrop.open" ); }

    async function checkQuota( force )
    {
        if( ! quotaPage() || ( quotaCard && document.body.contains( quotaCard ) ) ) return;
        if( dialogOpen() ) { scheduleQuotaCheck( force, 5000 ); return; }      // never over a dialog
        try
        {
            if( ! force && Date.now() - Number( localStorage.getItem( QUOTA_LAST_KEY ) || 0 ) < QUOTA_EVERY_MS ) return;
        }
        catch ( _ ) { return; }         // no storage: it could not remember "shown once", so never nag

        var s;
        try
        {
            var r = await fetch( location.origin + "/api/files?stat=disk", { credentials: "same-origin" } );
            if( ! r.ok ) return;        // signed out: no stamp, so signing in checks at once
            localStorage.setItem( QUOTA_LAST_KEY, String( Date.now() ) );
            s = await r.json();
        }
        catch ( _ ) { return; }
        if( ! s || ! ( s.total > 0 ) || typeof s.usable !== "number" ) return;

        var used = Math.max( 0, s.total - s.usable );
        var key  = "nayive-quota-warned:" + ( s.user || "" );
        try
        {
            if( used / s.total < QUOTA_WARN_AT ) { localStorage.removeItem( key ); return; }
            if( localStorage.getItem( key ) ) return;
            if( dialogOpen() ) { scheduleQuotaCheck( true, 5000 ); return; }  // one opened meanwhile
            localStorage.setItem( key, "1" );
        }
        catch ( _ ) { return; }

        showQuotaCard( used, s.total, s.trash || 0 );
    }

    function showQuotaCard( used, total, held )
    {
        if( ! document.body ) return;

        var card = document.createElement( "div" );
        card.className = "quota-card";
        card.setAttribute( "role", "alert" );

        var head  = document.createElement( "div" );
        head.className = "quota-card-head";
        var title = document.createElement( "strong" );
        title.textContent = t( "ui.quota.title" );
        var close = document.createElement( "button" );
        close.type      = "button";
        close.className = "icon-btn sm";
        close.title     = t( "ui.close" );
        close.setAttribute( "aria-label", t( "ui.close" ) );
        close.innerHTML = icon( "x" );
        close.addEventListener( "click", function () { card.remove(); } );
        head.appendChild( title );
        head.appendChild( close );

        var pct  = Math.min( 100, Math.floor( 100 * used / total ) );
        var line = document.createElement( "p" );
        line.textContent = tf( "ui.quota.used", { pct: pct, used: fmtBytes( used ), total: fmtBytes( total ) } );

        var how = document.createElement( "p" );
        how.textContent = t( "ui.quota.how" );

        var list = document.createElement( "ul" );
        [ held > 0 ? tf( "ui.quota.binHolds", { held: fmtBytes( held ) } ) : t( "ui.quota.bin" ),
          t( "ui.quota.chat" ),
          t( "ui.quota.big" ) ].forEach( function ( text )
        {
            var li = document.createElement( "li" );
            li.textContent = text;
            list.appendChild( li );
        } );

        // Drive listens for "nayive:bigfiles" and opens the list in place;
        // anywhere else it is a trip to Drive.
        var find = document.createElement( "button" );
        find.type      = "button";
        find.className = "text-btn";
        find.innerHTML = icon( "search" ) + "<span></span>";
        find.lastChild.textContent = t( "ui.quota.find" );
        find.addEventListener( "click", function ()
        {
            card.remove();
            var ev = new CustomEvent( "nayive:bigfiles", { cancelable: true } );
            if( document.dispatchEvent( ev ) ) location.href = "/nayive/drive/index.html?big=1";
        } );
        var acts = document.createElement( "div" );
        acts.className = "quota-card-actions";
        acts.appendChild( find );

        card.appendChild( head );
        card.appendChild( line );
        card.appendChild( how );
        card.appendChild( list );
        card.appendChild( acts );
        document.body.appendChild( card );
        quotaCard = card;
    }


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

    // "hoja.XLSX" -> "xlsx" (no dot, lower case); "" when there is none.
    function extOf( name )
    {
        var m = /\.([a-z0-9]+)$/i.exec( String( name || "" ) );
        return m ? m[ 1 ].toLowerCase() : "";
    }

    // "files/a/b.txt" -> "b.txt"
    function baseName( path ) { return String( path || "" ).split( "/" ).pop(); }

    // "foto.jpg" -> "foto (2).jpg", "foto (3).jpg"... while the name is in
    // `taken` (a Set of the folder's names). Photos' and the share target's
    // uploads; Drive's copies say "(copia)" instead (move-copy.js).
    function uniqueName( name, taken )
    {
        if( ! taken.has( name ) ) return name;
        var dot  = name.lastIndexOf( "." );
        var stem = dot > 0 ? name.slice( 0, dot ) : name;
        var ext  = dot > 0 ? name.slice( dot )    : "";
        var i = 2;
        while( taken.has( stem + " (" + i + ")" + ext ) ) i++;
        return stem + " (" + i + ")" + ext;
    }

    // A name as a safe folder / file name: "Córdoba 2026" -> "cordoba-2026".
    // Accents are dropped (NFD), not the letters; anything else that is not a-z
    // or 0-9 becomes one "-". `max` cuts it; `fallback` stands in for "".
    function slugify( s, fallback, max )
    {
        var out = String( s || "" ).normalize( "NFD" ).replace( /[\u0300-\u036f]/g, "" )
                  .toLowerCase().replace( /[^a-z0-9]+/g, "-" ).replace( /^-+|-+$/g, "" );
        if( max ) out = out.slice( 0, max );
        return out || fallback || "item";
    }

    // Every IANA time zone this browser knows. Ancient browsers have no
    // supportedValuesOf; they get a short list of the common ones.
    function timeZones()
    {
        try { return Intl.supportedValuesOf( "timeZone" ); }
        catch ( e )
        {
            return [ "UTC","Europe/Madrid","Europe/London","Europe/Paris","Europe/Berlin",
                     "Europe/Rome","Europe/Lisbon","America/New_York","America/Chicago",
                     "America/Denver","America/Los_Angeles","America/Sao_Paulo",
                     "America/Mexico_City","Asia/Tokyo","Asia/Shanghai","Asia/Hong_Kong",
                     "Asia/Singapore","Asia/Dubai","Asia/Kolkata","Australia/Sydney",
                     "Pacific/Auckland" ];
        }
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
                      offline: "offline", pending: "pending", "needs-auth": "needsAuth",
                      conflict: "conflict" };

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
    // #syncIndicator click -> refreshNow; window.nayiveRefresh = refreshNow for
    // Planner's single plug; while the store is "offline", a retry ("retry", 5 s
    // up to 1 min) and "online" -> maybeRefresh( true, "online" ).
    //
    // `guard( force, why )` returns true while a re-read must NOT happen (a sheet is
    // open, text is being typed); the default is "any .sheet-backdrop is open".
    // `why` is "visible" / "focus" / "plug" / "retry" / "online", so an app can tell a DELIBERATE refresh
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
        // A click on a window without focus fires "focus" between its press and its
        // release. The re-read then redraws the list under the pointer, the release
        // lands on a NEW button and the click is lost (the second click works). So
        // while a button is held the re-read waits until the click is done.
        var held = false, waiting = false;

        window.addEventListener( "pointerdown",   function () { held = true;  }, true );
        window.addEventListener( "pointercancel", function () { held = false; }, true );
        window.addEventListener( "pointerup",     function ()
        {
            held = false;
            if( ! waiting ) return;
            waiting = false;
            setTimeout( function () { maybeRefresh( false, "focus" ); }, 0 );   // after the click
        }, true );
        window.addEventListener( "focus", function ()
        {
            if( held ) waiting = true;
            else       maybeRefresh( false, "focus" );
        } );

        // RETRY (2026-10-03) - a read that failed for want of the network leaves
        // the plug "offline" (gold), and nothing above tries again until a focus,
        // a tab switch or a tap. The PWA starts at sign-in, often before the
        // network is up: a window nobody clicks (a Planner pane, a desktop
        // window behind) stayed gold for hours. So while the store says
        // "offline" the read is tried again by itself: 5 s, doubling up to
        // 1 min. One at a time; a read's own "loading" does not reset the wait.
        // "online": the store only sends what is queued and turns green, so the
        // data on screen is re-read too.
        if( opts.store && opts.store.onState )
        {
            var retryT = 0, retryMs = 5000, retrying = false;

            var armRetry = function ()
            {
                if( retryT || retrying ) return;
                retryT = setTimeout( async function ()
                {
                    retryT   = 0;
                    retrying = true;
                    try { if( navigator.onLine ) await maybeRefresh( true, "retry" ); }
                    catch ( e ) {}
                    retrying = false;
                    retryMs  = Math.min( retryMs * 2, 60000 );
                    if( opts.store.state === "offline" ) armRetry();   // still out, or the guard said no
                }, retryMs );
            };

            var onStore = function ( s )
            {
                if( s === "offline" ) armRetry();
                else if( s !== "loading" && s !== "saving" )
                {
                    clearTimeout( retryT );
                    retryT  = 0;
                    retryMs = 5000;
                }
            };

            opts.store.onState( onStore );
            onStore( opts.store.state );       // a read that failed before this ran
            window.addEventListener( "online", function () { maybeRefresh( true, "online" ); } );
        }

        var dot = byId( opts.indicatorId || "syncIndicator" );
        if( dot && dot.tagName === "BUTTON" ) dot.addEventListener( "click", refreshNow );

        return { maybeRefresh: maybeRefresh, refreshNow: refreshNow };
    }

    //------------------------------------------------------------------------//
    // UNDO TOAST  -  "Eliminado  [Deshacer]" for a few seconds. Paired CSS
    // (.toast.actionable / .toast-undo) lives in shared/theme.css.
    //
    //   NayiveUI.undoToast( msg, undo, opts )     opts: { id, ms, label,
    //                                                     onExpire, keepOnLeave }
    //
    // Two ways to use it:
    //   - do it now, `undo` puts it back (a move, a rename, a delete to the bin);
    //   - hide it now and do the real thing in `onExpire` (a delete with no way
    //     back): `undo` then only shows it again.
    // onExpire runs once, when the Undo is gone for good: the time is up, another
    // toast takes this one's place, undoSettle() is called (an editor or a game
    // on its next key), or the page is closed. keepOnLeave: a closed page does
    // NOT run it (a send: the draft keeps the mail).
    var undoPending = null;             // { tt, onExpire, keepOnLeave } of the Undo on show

    function undoToast( msg, fn, opts )
    {
        opts = opts || {};
        var tt = byId( opts.id || "toast" );
        if( ! tt ) return;

        settleUndo();                   // one Undo at a time: the older one is final now
        clearTimeout( tt._nayiveToastTimer );
        tt.textContent = msg;

        var mine = { tt: tt, onExpire: opts.onExpire || null, keepOnLeave: !! opts.keepOnLeave };
        undoPending = mine;

        var b = document.createElement( "button" );
        b.type        = "button";
        b.className   = "toast-undo";
        b.textContent = opts.label || t( "ui.undo" );
        b.addEventListener( "click", function ()
        {
            if( undoPending !== mine ) return;
            undoPending = null;
            clearTimeout( tt._nayiveToastTimer );
            tt.classList.remove( "show", "actionable" );
            showAfter( mine );          // before the undo: a toast of its own goes over it
            fn();
        } );
        tt.appendChild( b );

        tt.classList.add( "actionable", "show" );
        tt._nayiveToastTimer = setTimeout( function ()
        {
            tt.classList.remove( "show" );
            setTimeout( function () { tt.classList.remove( "actionable" ); }, 250 );
            if( undoPending === mine ) settleUndo();
        }, opts.ms || 6000 );
    }

    // The Undo on show (if any) is final: its onExpire runs now. Cleared BEFORE
    // the call - an onExpire that shows a toast must not settle itself again.
    function settleUndo( leaving )
    {
        var p = undoPending;
        if( ! p ) return;
        undoPending = null;
        if( p.onExpire && ! ( leaving && p.keepOnLeave ) )
        {
            try
            {
                if( leaving ) withKeepalive( p.onExpire );
                else          p.onExpire();
            }
            catch ( e ) { console.error( e ); }
        }
        if( ! leaving ) showAfter( p );
    }

    // The keepUndo toast that waited for this Undo (see toast), now.
    function showAfter( p )
    {
        var a = p && p.after;
        if( ! a ) return;
        p.after = null;
        toast( a[ 0 ], Object.assign( {}, a[ 1 ], { keepUndo: false } ) );
    }

    // B5: an editor or a game closes the Undo on the next key or move, or the
    // Undo would throw the new work away.
    function undoSettle()
    {
        var p = undoPending;
        if( ! p ) return;
        clearTimeout( p.tt._nayiveToastTimer );
        p.tt.classList.remove( "show", "actionable" );
        settleUndo();
    }

    // A fetch started while the page is going away is cancelled with it unless
    // it carries keepalive (small bodies only: the browser caps them at 64 KB).
    // So while a closing page runs its last onExpire, every fetch gets the flag.
    // Only the fetches started in that same tick: one after an await is lost.
    function withKeepalive( fn )
    {
        var real = window.fetch;
        if( ! real ) { fn(); return; }
        window.fetch = function ( url, init )
        {
            var o = Object.assign( {}, init || {} ), body = o.body;
            if( body == null || ( typeof body === "string" && body.length < 60000 ) ) o.keepalive = true;
            return real.call( window, url, o );
        };
        try { fn(); }
        finally { window.fetch = real; }
    }

    window.addEventListener( "pagehide", function () { settleUndo( true ); } );

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

        // Right-aligned under its button is right for a header "..." at the end
        // of the row; a trigger sitting near the LEFT edge (Text's "?" on a
        // phone) would push the card off screen instead. Measured once it is
        // shown, and only then flipped to hang off its left edge.
        function keepInside()
        {
            var r = menu.getBoundingClientRect();
            if( r.left >= 6 ) return;
            menu.style.right = "auto";
            menu.style.left  = "6px";
        }
        function isOpen() { return ! menu.hidden; }
        function open()
        {
            place();
            menu.hidden = false;
            keepInside();
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
    // CLOSE-ONLY DIALOGS  -  the GNOME way (docs/audit/dialogs.md): a settings
    // dialog has only its ×, and every change is kept. × = Escape = close =
    // KEEP. Two helpers, so no dialog writes this by hand again:
    //
    //   NayiveUI.autoSave( field, save, o )
    //       Saves one field on its own: a select / tick-box / switch on
    //       "change"; a text box also while typing, o.wait ms after the last
    //       key (default 700), and at once when it loses the focus.
    //       save( value ) does the work and returns a promise (or nothing).
    //       While it runs a select / tick-box is disabled (a text box is not:
    //       that would take the caret away). A failure puts a select /
    //       tick-box back to the last saved value (a text box keeps what was
    //       typed - the next change tries again) and o.msg (a <p>) says the
    //       i18n key o.fail, or "Could not save.". o.done( value ) after a
    //       good save. Callable before the page's words are in (keys, not text).
    //       Returns { saved( v ) }: tell it the value loaded from outside.
    //
    //   NayiveUI.onSheetClose( back, fn )
    //       fn() every time the .sheet-backdrop `back` (element or id) closes,
    //       by any road: its ×, Escape, the app's own code. For what is kept
    //       only when the dialog goes: a costly re-check, or one server write
    //       for the whole dialog instead of one per change.

    function autoSave( field, save, o )
    {
        o = o || {};
        var box   = field.type === "checkbox";
        var typed = field.tagName === "TEXTAREA" ||
                    ( field.tagName === "INPUT" && ! box && field.type !== "radio" );
        var good  = get();
        var timer = 0;
        var queue = Promise.resolve();     // one save at a time, in order

        function get()      { return box ? field.checked : field.value; }
        function put( v )   { if( box ) field.checked = v; else field.value = v; }
        function say( txt ) { if( o.msg ) { o.msg.textContent = txt || ""; o.msg.hidden = ! txt; } }

        function run()
        {
            clearTimeout( timer );
            timer = 0;
            queue = queue.then( function ()
            {
                var v = get();
                if( v === good ) return;
                if( ! typed ) field.disabled = true;
                say( "" );
                return Promise.resolve()
                    .then( function () { return save( v ); } )
                    .then( function ()
                    {
                        good = v;
                        if( o.done ) o.done( v );
                    }, function ()
                    {
                        if( ! typed ) put( good );
                        say( t( o.fail || "ui.saveFailed" ) );
                    } )
                    .then( function () { field.disabled = false; } );
            } );
        }

        field.addEventListener( "change", run );
        if( typed )
            field.addEventListener( "input", function ()
            {
                clearTimeout( timer );
                timer = setTimeout( run, o.wait || 700 );
            } );

        return { saved: function ( v ) { good = v; } };
    }

    function onSheetClose( back, fn )
    {
        if( typeof back === "string" ) back = byId( back );
        if( ! back ) return;

        var was = back.classList.contains( "open" );
        new MutationObserver( function ()
        {
            var now = back.classList.contains( "open" );
            if( was && ! now ) fn();
            was = now;
        } ).observe( back, { attributes: true, attributeFilter: [ "class" ] } );
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

    //------------------------------------------------------------------------//
    // DIALOG FIRST FIELD  -  every dialog opens with the caret already in it.
    //
    // The rule for the whole suite: when a .sheet-backdrop gets ".open", the
    // FIRST usable field inside it takes the focus, so the user can type (or
    // arrow / space) straight away without reaching for the mouse. Wired ONCE
    // here for every dialog in the page - static markup and the sheets ui.js
    // builds on the fly alike - so there is nothing to add to a new dialog.
    //
    // What it never does:
    //   - it does not steal a focus the app set itself. A dialog that puts the
    //     caret somewhere else on purpose (Drive's "Propiedades" -> the close
    //     button, a destructive confirm -> "cancel", pickFolder -> the name it
    //     pre-selects) has already focused it by the time we look, and anything
    //     already focused inside the sheet is left alone.
    //   - it never focuses a BUTTON. A dialog with no field keeps the focus
    //     where it was: landing on the corner "x" would turn a stray Enter into
    //     "close", which is exactly the accident this feature must not cause.
    //
    // "Ready to receive input" is the catch: some sheets are still empty when
    // they open (shareSheet lists people after a fetch, a field may start
    // disabled). So when there is no field yet, a small observer watches THAT
    // dialog and focuses the first one that shows up. It gives up on the first
    // success, when the dialog closes, or after FOCUS_WAIT ms.
    //------------------------------------------------------------------------//

    var FOCUS_WAIT = 4000;    // ms to keep waiting for an async dialog's fields

    // A field the user can actually put text / a choice into - never a button.
    function isField( el )
    {
        var tag = el.tagName;

        if( el.disabled || el.readOnly ) return false;
        if( el.getAttribute( "aria-hidden" ) === "true" ) return false;

        // Taken out of the tab order on purpose = not a field to start on. The
        // ATTRIBUTE, not el.tabIndex: a contenteditable div reads -1 there by
        // default in Chrome, and that one IS where the user types.
        var ti = el.getAttribute( "tabindex" );
        if( ti !== null && +ti < 0 ) return false;

        if( tag === "INPUT" )
        {
            var ty = ( el.type || "text" ).toLowerCase();
            if( ty === "hidden" || ty === "button" || ty === "submit" ||
                ty === "reset"  || ty === "image" ) return false;
        }
        else if( tag !== "SELECT" && tag !== "TEXTAREA" )
        {
            var ce = el.getAttribute( "contenteditable" );
            if( ce === null || ce === "false" ) return false;
        }

        return el.getClientRects().length > 0;      // laid out = really on screen
    }

    function firstField( sheet )
    {
        var all  = sheet.querySelectorAll( "input, select, textarea, [contenteditable]" );
        var head = null;                  // a field in .sheet-header, kept as a last resort

        for( var i = 0; i < all.length; i++ )
        {
            var el = all[ i ];
            if( ! isField( el ) ) continue;

            // .sheet-header is the title row - "one small control on the right"
            // (Calendar's "all day" switch). It sits before the form but it is
            // not the form's first field, so the caret goes past it. Unless it
            // is the only field there is.
            if( el.closest( ".sheet-header" ) ) { if( ! head ) head = el; continue; }

            return el;
        }

        return head;
    }

    // Try once. true = done with this dialog (focused, or someone else owns it).
    function focusFirstField( back )
    {
        if( ! back.classList.contains( "open" ) ) return true;
        if( back.contains( document.activeElement ) ) return true;   // the app chose

        var f = firstField( back );
        if( ! f ) return false;

        f.focus( { preventScroll: true } );

        // A text field opens with the caret AFTER what is already there (a
        // suggested file name, the value being edited) - ready to add to it, not
        // to type in front of it. Dialogs that mean "replace this whole value"
        // call select() themselves, and those we never reach anyway.
        if( f.tagName === "TEXTAREA" || /^(text|search|url|tel|password)$/.test( f.type || "" ) )
            try { f.setSelectionRange( f.value.length, f.value.length ); } catch ( e ) {}

        // A spinner (number) or an e-mail field has no setSelectionRange, so a
        // browser that selects all on focus left its value marked. Putting the
        // value back moves the caret to the end; the "" step is needed because
        // Firefox only moves it when the value CHANGES. No input event fires.
        else if( /^(number|email)$/.test( f.type || "" ) && f.value !== "" )
        {
            var v = f.value;
            f.value = "";
            f.value = v;
        }

        return true;
    }

    // Nothing to focus yet: watch this one dialog until there is.
    function waitForField( back )
    {
        var mo    = null;
        var timer = null;

        function stop()
        {
            if( mo )    { mo.disconnect();  mo    = null; }
            if( timer ) { clearTimeout( timer ); timer = null; }
        }

        mo = new MutationObserver( function ()
        {
            if( focusFirstField( back ) ) stop();
        } );

        mo.observe( back, { childList: true, subtree: true,
                            attributes: true,
                            attributeFilter: [ "disabled", "readonly", "class", "style" ] } );

        timer = setTimeout( stop, FOCUS_WAIT );
    }

    function wireSheetFocus()
    {
        // One observer for the page: every .sheet-backdrop that gains ".open"
        // (and, for recentreSheet, every one that loses it).
        // Both dialog families are covered - setOpen() toggles the class on the
        // markup's backdrops, and the sheets ui.js builds are in the document
        // before they get it.
        new MutationObserver( function ( recs )
        {
            for( var i = 0; i < recs.length; i++ )
            {
                var back = recs[ i ].target;

                if( back.nodeType !== 1 || ! back.classList.contains( "sheet-backdrop" ) ) continue;

                // Read the LIVE class, not the record: an open-then-close inside
                // one tick arrives here as two records for a closed dialog.
                if( ! back.classList.contains( "open" ) )
                {
                    back._nayiveFocused = false;
                    recentreSheet( back );
                    continue;
                }
                if( back._nayiveFocused ) continue;

                back._nayiveFocused = true;

                // Right here, no rAF, no timer. A MutationObserver callback is a
                // microtask: the whole opening handler - packSheet, the app's own
                // focus() / select() - has already run, and we are still inside
                // the user's gesture, which is the only moment iOS Safari lets a
                // programmatic focus raise the keyboard.
                if( ! focusFirstField( back ) ) waitForField( back );
            }
        } ).observe( document.documentElement,
                     { attributes: true, attributeFilter: [ "class" ], subtree: true } );
    }

    function uiInit()
    {
        applyI18n();
        applySheetButtons();
        localizeDateTimeInputs();
        applyInfoDots();
        applyHomeLinks();
        applySyncDots();
        startChatDot();
        initDragSheets();
        wireSheetClosing();
        wireSheetFocus();

        // uiInit runs at DOMContentLoaded; the dictionary usually lands a moment
        // later, and applySheetButtons / applyInfoDots may have added keys of
        // their own, so translate once more when it does.
        i18nReady.then( function () { applyI18n(); } );

        pingSwUpdate();
        scheduleQuotaCheck( false, 3000 );
        document.addEventListener( "visibilitychange", function ()
        {
            if( document.visibilityState !== "visible" ) return;
            pingSwUpdate();
            scheduleQuotaCheck( false, 3000 );
        } );
    }

    if( document.readyState === "loading" )
        document.addEventListener( "DOMContentLoaded", uiInit );
    else
        uiInit();

    window.NayiveUI = {
        setOpen:  setOpen,
        paneResizer: paneResizer,   // a .pane-resizer handle sizes the pane next to it
        isMac:    IS_MAC,           // shortcuts take ⌘ (Drive, Write, Calc, Text)
        pwEye:    pwEye,            // show / hide a password field's text
        searchFold: searchFold,     // a toolbar search field folded behind a magnifier
        modal:    modal,            // a dialog built on the fly: backdrop, sheet, Escape, close
        autoSave: autoSave,         // close-only dialogs: one field saves itself on change
        onSheetClose: onSheetClose, // close-only dialogs: run something when a sheet closes
        open:     open,
        close:    close,
        toast:    toast,
        sessionExpired: sessionExpired,   // the shared "your session expired" bar (gum-api / store call it)
        loginRedirect:  loginRedirect,    // to the sign-in page and back here (GumApi.loginRedirect too)
        signOut:        signOut,          // the launcher's and admin's sign-out ({ unlinkPhone, swScope })
        viewerTz: viewerTz,
        escapeHtml: escapeHtml,
        townName:   townName,      // the town at a position, "" when unknown (trips/public.html)
        pad2:       pad2,
        todayIso:   todayIso,
        extOf:      extOf,
        baseName:   baseName,
        uniqueName: uniqueName,    // "foto.jpg" -> "foto (2).jpg" in a folder that has it
        slugify:    slugify,       // "Córdoba" -> "cordoba" (Trips, Split)
        timeZones:  timeZones,     // every IANA zone (the launcher, Calendar)
        applySyncState: applySyncState,   // store state -> the header plug (classes + title)
        syncIndicator:  syncIndicator,    // a ready store.onState listener for #syncIndicator
        bootWithStore:  bootWithStore,    // the access probe + "open from cache" fallback
        wireRefresh:    wireRefresh,      // visibilitychange / focus / plug-click re-read
        undoToast:      undoToast,        // "Eliminado [Deshacer]"
        undoSettle:     undoSettle,       // the Undo on show is final now (editor / game: next key)
        transfer:       transfer,         // a row on the shared upload/download bar
        wireMenu:       wireMenu,         // the header "..." popup menu
        icon:              icon,
        h:                 h,             // build DOM: h( "div", { class, text, on, attrs, data }, kids… )
        attachPanel:       attachPanel,   // the clip's round-button panel (Chat, eMail)
        t:         t,
        tf:        tf,
        applyI18n: applyI18n,
        lang:      I18N ? I18N.lang    : function () { return "es"; },
        locale:    I18N ? I18N.locale  : function () { return "es"; },
        weekday:   I18N ? I18N.weekday : function ( n ) { return String( n ); },
        month:     I18N ? I18N.month   : function ( n ) { return String( n ); },
        applySheetButtons: applySheetButtons,
        applyInfoDots:     applyInfoDots,
        applyHomeLinks:    applyHomeLinks,
        applySyncDots:     applySyncDots,
        windowed:          WINDOWED,     // true inside a desktop window
        confirm:  confirmDialog,
        askPassword: askPassword,
        askText:  askText,        // one name in a small dialog -> the text, or null
        alert:    alertDialog,
        fmtBytes:   fmtBytes,
        ensureRoom: ensureRoom,
        firstRun:  firstRun,      // register the help dialog for this app
        setIntro:  setIntro,      // swap that dialog when the app changes screen
        setHelpMenu: setHelpMenu, // the "?" opens the app's own Ayuda menu instead
        showIntro: showIntro,     // open it now (the toolbar "?" button)
        holdIntro: holdIntro,     // suppress + close the auto help card for this load
        isShared:     isShared,
        sharedWithMe: sharedWithMe,   // everything shared WITH us, fetched once per page
        canAddTo:     canAddTo,
        sharedBadge:  sharedBadge,
        shareSheet:   shareSheet,
        rowButton:       rowButton,           // the share sheet's round button (trips/my-location.js too)
        jsonApi:         jsonApi,             // one JSON call to this server
        copyText:        copyText,            // to the clipboard, or a rejected promise
        saveFile:        saveFile,            // to this device as a download (Blob or text)
        printPage:       printPage,           // "Export to PDF" through #printRoot + window.print()
        isIOS:           isIOS,
        b64ToU8:         b64ToU8,             // a VAPID key -> applicationServerKey bytes
        samePushKey:     samePushKey,         // a push subscription made with this key?
        inAndroidApp:    inAndroidApp,
        pickFolder:           pickFolder,
        pickFile:             pickFile,
        launcherFolder:       launcherFolder,
        changeLauncherFolder: changeLauncherFolder,
        offerInstall:         offerInstall,
        isStandalone:         isStandalone,
        installMode:          installMode
    };
} )();
