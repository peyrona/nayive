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
 * NO interface string lives here either: Ayni.t / .tf re-export the engine
 * in shared/i18n.js, and every message is a `ui.*` / `share.*` key in
 * shared/i18n/*.json. Because ui.js is deferred, an app's inline script must
 * not call NayiveUI while it is being parsed - wrap the call in a function.
 *
 * Deliberately small - just the bits that were byte-identical across apps:
 *   - the viewer's IANA time zone
 *   - (the texts are Ayni's: Ayni.t / Ayni.tf / Ayni.i18n, shared/ayni/)
 *   - dialog action buttons: the one Nayive style (see Calendar -> "Ir a mes").
 *   - (the "?" help card, the tour, the first-visit marks and the info "i"
 *     are Ayni's: Ayni.help / tour / coach, .info-tip, shared/ayni/ayni-help.js)
 *   - (dialogs are Ayni's dialog.panel, shared/ayni/ayni-dialogs.js: opening,
 *     Esc, the first field, moving, Ayni.confirm / alert / ask / autoSave)
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
 * A dialog is Ayni's <dialog class="panel"> (header, .body, footer). Its
 * bottom row (footer) is a right-aligned line of Ayni's round, icon-only
 * buttons (shared/ayni/ayni-buttons.css): a plain "close" (×, marked
 * data-close) and the default ✓ (.btn.primary), plus optional .btn.danger
 * (trash) and plain help buttons; footer > .extra holds the left-hand ones.
 * Class and icon are written in the markup:
 *
 *     <footer>
 *       <button class="btn" id="fooCancel" data-close data-tip="Cancelar"><span class="icon" data-icon="close"></span></button>
 *       <button class="btn primary" id="fooConfirm" data-tip="Guardar"><span class="icon" data-icon="check"></span></button>
 *     </footer>
 *
 * A dialog whose only action is "close" has no footer: its × is written in the
 * header, after the title. Dialogs built on the fly use Ayni.dialog and
 * Ayni.dialogButton, then NayiveUI.applySheetButtons( dialogEl ) for the
 * i18n names of buttons whose tooltip is a dictionary key.
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
 *   - "save-as" = save the current thing as a NEW named copy: the check with a
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

    // The viewer's IANA zone, or "UTC" if the browser won't say.
    function viewerTz()
    {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
        catch ( e ) { return "UTC"; }
    }


    //------------------------------------------------------------------------//
    // TEXTS - Ayni's language layer (shared/ayni/ayni-i18n.js, loaded first in
    // <head>): Ayni.t( "key" ), Ayni.tf( "key", { n: 3 } ), Ayni.i18n.ready.
    // These short local names are only for this file.

    var t         = window.Ayni ? Ayni.t  : function ( k ) { return k; };
    var tf        = window.Ayni ? Ayni.tf : function ( k ) { return k; };
    var i18nReady = window.Ayni ? Ayni.i18n.ready : Promise.resolve( {} );

    // Parts built after this script runs (a trip sheet, a dialog made in code):
    // home links, sync dots, toast lifts, and Ayni's info "i"s, number fields and eyes.
    // (Their data-i18n text is shared/i18n.js's own observer's job, not this one's.)
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
                    // Info "i"s, number fields and password eyes built after the page loaded
                    if( n.matches( ".info-tip, .spin, [data-reveal]" ) || n.querySelector( ".info-tip, .spin, [data-reveal]" ) ) Ayni.init( n );
                    applyHomeLinks( n );
                    applySyncDots( n );
                    watchToastLifts( n );
                }
            }
        } );
        try { dtObserver.observe( document.documentElement, { childList: true, subtree: true } ); }
        catch ( e ) {}
    }

    //------------------------------------------------------------------------//
    // DIALOG ACTION BUTTONS

    // NAYIVE'S ICONS - the ones Ayni's controls do not ship (Ayni's own set,
    // shared/ayni/ayni-icons.js, holds close, check, trash, help, info, search,
    // filter, plus, chev-down, edit, folder, file, eye, eye-off, undo, more,
    // cut, copy, paste, sun, moon...). Same drawings as ever, Ayni's names:
    // Ayni.icon( "save-as" ), or <span class="icon" data-icon="save-as"> in a page.
    // A drawing is a 24x24 icon drawn with lines; <g stroke-width> where an icon
    // reads better thicker, <g fill> for a filled one.
    //   "save-as"  = save the current thing as a NEW named copy: the check with a
    //                small + near the top edge.
    //   back / forward move BETWEEN SCREENS; a chevron never navigates: it means
    //   expand or step in place (chev-up / chev-down move up / down in a list).
    if( window.Ayni ) Ayni.icons.add( {
        eraser: '<path d="M7 21l-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21"/><line x1="22" y1="21" x2="7" y2="21"/><line x1="5" y1="11" x2="14" y2="20"/>',
        "text-cursor": '<path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1"/><path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5"/><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/><line x1="9" y1="7" x2="9" y2="17"/>',
        back: '<g stroke-width="2.2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></g>',
        forward: '<g stroke-width="2.2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></g>',
        "chev-up": '<g stroke-width="2.2"><polyline points="18 15 12 9 6 15"/></g>',
        grid: '<g stroke-width="1.9"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></g>',
        "folder-plus": '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
        unzip: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="10" x2="12" y2="17"/><polyline points="9 14 12 17 15 14"/>',
        "save-as": '<polyline points="5 14 10 18 17 9" stroke-width="2.5"/><line x1="12" y1="1" x2="12" y2="7" stroke-width="2.4"/><line x1="9" y1="4" x2="15" y2="4" stroke-width="2.4"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
        compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
        "ios-share": '<path d="M8 7H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"/><polyline points="8 6 12 2 16 6"/><line x1="12" y1="2" x2="12" y2="14"/>',
        share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/>',
        "add-home": '<rect x="3" y="3" width="18" height="18" rx="3"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
        fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/>',
        bolt: '<polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"/>',
        lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
        key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="m15.5 7.5 3 3"/><path d="m18 5 2.5 2.5"/>',
        pause: '<g stroke-width="2.2"><line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/></g>',
        stop: '<g stroke-width="2.2"><rect x="6" y="6" width="12" height="12" rx="1.5"/></g>',
        // Item list and tree actions (were browser.js glyphs, 2026-11-01).
        move: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="12 10 15 13 12 16"/><line x1="8" y1="13" x2="15" y2="13"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        star: '<polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7 12 2.8"/>',
        external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
        tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
        "tag-plus": '<path d="M16 8l-6-6H2v8l6 6"/><line x1="6.5" y1="6.5" x2="6.51" y2="6.5"/><line x1="18" y1="13" x2="18" y2="21"/><line x1="14" y1="17" x2="22" y2="17"/>',
        users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
        "bell-off": '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>',
        "mail-open": '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0z"/><path d="M22 10l-9 5.7a2 2 0 0 1-2 0L2 10"/>',
        queue: '<line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="11" y2="18"/><polygon points="17 14 22 17 17 20 17 14"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
        merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
        // App logos that do not fit the 24 grid: their own viewBox. `write` =
        // fountain pen + inkwell, `calc` = the "f(x)" mark, `nayive` = the real
        // Nayive logo (the launcher's artwork, never redrawn): the icon of every
        // button about Nayive's own files (From Nayive, Save to Nayive...).
        nayive:
            '<svg viewBox="0 0 24 24">',
        write:
            '<svg viewBox="0 0 512 512" fill="currentColor"><g transform="translate(45 465) rotate(-48)"><path d="M0 0 28 -14 82 -36C96 -36 110 -27 122 -19L122 19C110 27 96 36 82 36L28 14Z"></path><rect x="132" y="-26" width="350" height="52"></rect><path d="M494 -26 522 -26C542 -26 550 -14 550 0 550 14 542 26 522 26L494 26Z"></path></g><rect x="262" y="220" width="176" height="50" rx="12"></rect><path fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" d="M294 270 294 300C294 314 228 312 228 332L228 445C228 460 240 472 255 472L445 472C460 472 472 460 472 445L472 332C472 312 406 314 406 300L406 270"></path>',
        calc:
            '<svg viewBox="0 0 512 512" fill="currentColor"><g transform="translate(-213.2 -558.1) scale(1.8891 3.2191)"><g transform="translate(37.3 3.7)"><path d="m 159.5,210.8 v 7.2 h 25.2 v 16.5 H 159.5 V 300 h -21.5 v -65.6 h -19.9 v -16.5 h 19.9 v -5.7 q 0,-14.8 6.2,-20.5 6.2,-5.7 22.9,-5.7 h 17.7 v 16.5 h -16.8 q -4.8,0 -6.6,1.8 -1.7,1.8 -1.8,6.5 z"></path><g transform="translate(67.4 112.5) scale(.625)"><path d="m 243.4,186.2 q -9.7,17.5 -14.4,33.9 -4.7,16.4 -4.7,32.8 0,16.3 4.7,32.8 4.7,16.5 14.4,34.1 h -16.7 q -11.6,-16.9 -17.3,-33.3 -5.6,-16.5 -5.6,-33.5 0,-17 5.6,-33.5 5.7,-16.6 17.3,-33.3 z"></path><path d="M 329.9,218 302.2,257.2 332.3,300 H 307.2 L 291.1,272.4 275.1,300 h -25 l 30.3,-42.8 -27.9,-39.3 h 25 l 13.6,24.5 13.7,-24.5 z"></path><path d="m 338.9,186.2 h 16.7 q 11.6,16.7 17.2,33.3 5.7,16.5 5.7,33.5 0,17.1 -5.6,33.5 -5.6,16.4 -17.3,33.3 h -16.7 q 9.7,-17.6 14.4,-34.1 4.7,-16.6 4.7,-32.8 0,-16.4 -4.7,-32.8 -4.7,-16.4 -14.4,-33.9 z"></path></g></g></g></svg>',
    } );

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

    // A × button of class `cls`, titled `title` ("Cerrar" when none), that runs `onClick`.
    function xButton( cls, onClick, title )
    {
        var b = document.createElement( "button" );
        b.type      = "button";
        b.className = cls;
        Ayni.setTip( b, title || t( "ui.close" ) );
        b.setAttribute( "aria-label", b.dataset.tip );
        b.innerHTML = Ayni.icon( "close" );
        if( onClick ) b.addEventListener( "click", onClick );
        return b;
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
    // [{ icon: <svg> node, label, color: 0-8, act }]. A tap runs onPick (the
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

    // Name the buttons under `root` (default: document): a tooltip that is a
    // dictionary key names the button too (both land with the words), and
    // Ayni wires the ones built on the fly. Idempotent.
    function applySheetButtons( root )
    {
        var scope = root || document;
        scope.querySelectorAll( "button[data-i18n-attr]" ).forEach( function ( b )
        {
            var said = b.getAttribute( "data-i18n-attr" ), key = /(?:^|,)\s*data-tip\s*:\s*([\w.]+)/.exec( said );
            if( key && said.indexOf( "aria-label" ) === -1 && ! b.hasAttribute( "aria-label" ) )
                b.setAttribute( "data-i18n-attr", said + ", aria-label:" + key[ 1 ] );
        } );
        if( root ) Ayni.init( root );
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

    // (CONFIRM / ALERT / ASK FOR ONE NAME are Ayni's: Ayni.confirm, Ayni.alert,
    // Ayni.ask - shared/ayni/ayni-dialogs.js.)

    function normDialogOpts( opts )
    {
        if( typeof opts === "string" ) return { body: opts };
        return opts || {};
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
    // Built on Ayni.dialog and thrown away like Ayni.confirm, and it closes
    // the same way: its own buttons or Escape, never a backdrop click.
    //
    // The value is returned, never kept: the caller turns it into a key and
    // this sheet's nodes are gone from the DOM before the promise resolves.

    function askPassword( opts )
    {
        opts = normDialogOpts( opts );
        var min = opts.min || 8;

        return new Promise( function ( resolve )
        {
            var d     = Ayni.dialog( { title: opts.title } );
            var sheet = d.body;

            if( opts.body )
            {
                var lead = document.createElement( "p" );
                lead.className   = "text";
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
                inp.className    = "input";
                inp.type         = "password";
                inp.id           = id;
                // A new password (verify) or one that already exists: the
                // browser's password manager offers to make one or to fill it.
                inp.autocomplete = opts.verify ? "new-password" : "current-password";

                // The eye inside the box's right end: Ayni's [data-reveal].
                var wrap = document.createElement( "div" );
                var eye  = document.createElement( "button" );
                wrap.className = "input-group";
                eye.type       = "button";
                eye.className  = "btn";
                eye.setAttribute( "data-reveal", "" );
                wrap.appendChild( inp );
                wrap.appendChild( eye );

                box.appendChild( lab );
                box.appendChild( wrap );
                sheet.appendChild( box );
                return inp;
            }

            var one = field( t( "lock.password" ), "askPw1" );
            var two = opts.verify ? field( t( "lock.repeat" ), "askPw2" ) : null;

            var warn = document.createElement( "p" );
            warn.className = "form-error";
            warn.hidden    = true;
            sheet.appendChild( warn );

            var cancel = Ayni.dialogButton( "close", opts.cancel || t( "ui.cancel" ) );
            var ok     = Ayni.dialogButton( "primary", opts.confirm || t( "ui.accept" ) );
            d.place( [ cancel, ok ] );

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

            // Enter in a field is the ✓ and Escape the × (Ayni: the default
            // button, the data-close one); the first field takes the caret.
            ok.addEventListener( "click", submit );
            cancel.addEventListener( "click", function () { finish( null ); } );
            d.dialog.addEventListener( "close", function () { finish( null ); } );

            d.show();
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
            var ok = await Ayni.confirm( {
                title:   t( "ui.room.title" ),
                body:    short + "\n\n" + tf( "ui.room.trashBody", { held: fmtBytes( held ) } ),
                confirm: t( "ui.room.empty" ), danger: true } );
            if ( ! ok ) return false;
            try
            {
                for ( var i = 0; i < ids.length; i += 2000 ) await GumApi.trashDelete( ids.slice( i, i + 2000 ) );
                return true;
            }
            catch ( e ) { Ayni.toast( "err", t( "ui.room.emptyFail" ) ); return false; }
        }

        Ayni.toast( "err", t( "ui.room.none" ) + " " + short +
               ( held > 0 ? " " + tf( "ui.room.trashHolds", { held: fmtBytes( held ) } ) : "" ) );
        return false;
    }

    //------------------------------------------------------------------------//
    // HELP  - the "?" card, the guided tour, the first-visit marks and the info
    // "i" are Ayni's (Ayni.help / Ayni.tour / Ayni.coach, .info-tip[data-help]:
    // shared/ayni/ayni-help.js). Nayive adds only what is Nayive's own:
    //  - every tour starts at the app's name ("home": tap it to go back);
    //  - the first-visit marks ring the app's name and its "?", once for all
    //    apps ("balata-coach-seen"), never in a Planner frame, nor in Chat
    //    (its "?" opens its own cards: it never had them), nor on the launcher
    //    (no app name there: Ayni gives up without using the flag).

    var HOME_SEL = ".app-icon.nayive-home-link, h1.nayive-home-link";

    function onScreen( el )
    {
        if( ! el || ! el.getBoundingClientRect ) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    if( window.Ayni && Ayni.tour )
    {
        Ayni.tour.add( "home", function () { return { sel: HOME_SEL, text: t( "ui.coach.home" ), optional: true }; }, "first" );
        if( ! EMBEDDED && location.pathname.indexOf( "/nayive/chat/" ) !== 0 )
            i18nReady.then( function ()
            {
                setTimeout( function ()
                {
                    Ayni.coach( [ { sel: HOME_SEL,           text: t( "ui.coach.home" ) },
                                  { sel: "[data-help-open]", text: t( "ui.coach.help" ) } ],
                                { key: "balata-coach-seen" } );
                }, 700 );
            } );
    }

    // Something more important owns the screen this load (the launcher's
    // mandatory password): no help card, no first-visit marks, no install offer.
    var introHeld = false;
    function holdIntro()
    {
        introHeld = true;
        if( window.Ayni && Ayni.help ) Ayni.help.hold();
        var x = document.querySelector( "dialog.panel[open] .install-close" );
        if( x ) x.click();
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
                if( ! el.dataset.tip ) el.setAttribute( "data-i18n-attr", "data-tip:ui.toApps, aria-label:ui.toApps" );
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

    // Its look: .fp-* in shared/app.css, the tree is Ayni's (Ayni.tree, pick mode).
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

            // Escape presses the × (Ayni): while a name is open, that is what
            // drops it, and the dialog stays.
            var d     = Ayni.dialog( { title: opts.title || t( "ui.fp.pickFolder" ) } );
            var sheet = d.body;
            d.dialog.addEventListener( "close", function () { finish( null ); } );

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
            // drawn by the shared tree (Ayni.tree), the
            // same one every "Move to…" and side pane uses: the arrow opens and
            // closes, a click lights a folder, a double-click / Enter chooses it.
            function treeNodes( nodes )
            {
                return sortNodes( nodes || [] ).filter( function ( n ) { return Array.isArray( n.nodes ); } )
                    .map( function ( n )
                    {
                        return { id: n.path, name: String( n.path ).split( "/" ).pop(), children: treeNodes( n.nodes ) };
                    } );
            }

            // One of the three bottom-left folder buttons.
            function fpAct( role, icon, title, off, fn )
            {
                var b = Ayni.dialogButton( role, title, icon );
                b.ariaDisabled = !! off;
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
                    Ayni.toast( "ok", t( "ui.toast.renamed" ), { undo: function ()
                    {
                        afterUndo( renameFolder( to, target ).then( function () { return target; } ) );
                    } } );
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
                Ayni.toast( "warn", err && err.status === 409 ? t( "drive.nameExistsTitle" )
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
                        Ayni.toast( "ok", t( "ui.toast.binned" ), { undo: function ()
                        {
                            afterUndo( GumApi.trashRestore( ids ).then( function () { return gone; } ) );
                        } } );
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

                sheet.innerHTML    = "";
                d.footer.innerHTML = "";

                if( opts.note )
                {
                    var note = document.createElement( "p" );
                    note.className   = "text";
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
                    var kids  = treeNodes( filesNode.nodes );
                    var roots = opts.allowRoot
                              ? [ { id: filesNode.path, name: opts.rootLabel || t( "ui.fp.allFiles" ), children: kids } ]
                              : kids;
                    if( opts.allowRoot ) expanded[ filesNode.path ] = expanded[ filesNode.path ] !== false;

                    if( ! roots.length )
                        box.appendChild( fpMsg( t( "ui.fp.noFolders" ) ) );
                    else
                    {
                        var host = document.createElement( "ul" );
                        box.appendChild( host );
                        var tr = Ayni.tree( host, {
                            nav:      true,
                            pick:     true,
                            items:    function () { return roots; },
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
                    input.className    = "input";
                    input.type         = "text";
                    input.autocomplete = "off";
                    input.value        = nameVal;
                    input.addEventListener( "input", function ()
                    {
                        nameVal     = input.value;
                        ok.ariaDisabled = ! nameOk();
                    } );
                    input.addEventListener( "keydown", function ( e )
                    {
                        if( e.key === "Enter" ) { e.preventDefault(); commitName(); }
                    } );
                    fld.appendChild( input );

                    sheet.appendChild( fld );
                }

                var arow = d.footer;

                if( ! nameMode )
                {
                    // Folder housekeeping, pinned to the far left: delete or
                    // rename the highlighted folder, create one inside it (with
                    // nothing highlighted, "new" creates it in Files itself).
                    var ready = ! busy && !! filesNode && ! treeErr;
                    var onOne = ready && !! selected && selected !== filesNode.path;

                    var left = document.createElement( "div" );
                    left.className = "extra";
                    left.appendChild( fpAct( "danger", null, t( "ui.delete" ), ! onOne, deleteFolder ) );
                    left.appendChild( fpAct( "", "edit", t( "ui.rename" ), ! onOne,
                                             function () { startName( "rename" ); } ) );
                    left.appendChild( fpAct( "", "folder-plus", t( "ui.newFolder" ), ! ready,
                                             function () { startName( "create" ); } ) );
                    arow.appendChild( left );
                }

                var cancel = Ayni.dialogButton( "close", t( "ui.cancel" ) );
                arow.appendChild( cancel );

                var ok = Ayni.dialogButton( "primary", ! nameMode ? t( "ui.fp.choose" )
                                                     : nameMode === "create" ? t( "ui.newFolder" ) : t( "ui.rename" ) );
                arow.appendChild( ok );

                applySheetButtons( d.dialog );

                // While a name is open the × only drops it: the dialog stays.
                cancel.addEventListener( "click", function ( e )
                {
                    if( nameMode ) { e.preventDefault(); cancelName(); }
                    else           finish( null );
                } );

                if( nameMode )
                {
                    ok.ariaDisabled = ! nameOk();
                    ok.addEventListener( "click", commitName );
                    input.focus();
                    if( ! namePicked ) { namePicked = true; input.select(); }
                }
                else
                {
                    ok.ariaDisabled = ! selected || busy;
                    ok.addEventListener( "click", function () { if( selected ) finish( selected ); } );
                }
            }

            render();
            d.show();

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

            var d     = Ayni.dialog( { title: opts.title || t( "ui.fp.pickFile" ) } );
            var sheet = d.body;
            d.dialog.addEventListener( "close", function () { finish( null ); } );

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
                ic.innerHTML = Ayni.icon( isDir( n ) ? "folder" : "file" );
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
                sheet.innerHTML    = "";
                d.footer.innerHTML = "";

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

                var cancel = Ayni.dialogButton( "close", t( "ui.cancel" ) );
                cancel.addEventListener( "click", function () { finish( null ); } );
                d.footer.appendChild( cancel );

                var ok = Ayni.dialogButton( "primary", opts.confirm || t( "ui.fp.chooseFile" ) );
                ok.ariaDisabled = ! selected;
                ok.addEventListener( "click", function () { if( selected ) finish( selected ); } );
                d.footer.appendChild( ok );

                applySheetButtons( d.dialog );
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
        if( back ) { if( back._finish ) back._finish(); else back.remove(); }
        Ayni.toast( "ok", t( "ui.install.done" ) );
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
        ic.className = "install-ico";
        ic.innerHTML = Ayni.icon( iconName );
        li.appendChild( ic );

        var box = document.createElement( "div" );
        box.className = "help-t";
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
        ic.className = "install-ico";
        ic.innerHTML = Ayni.icon( iconName );
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
        var d     = Ayni.dialog( { id: "nayive-install-bar", cls: "install-sheet" } );
        var back  = d.dialog;
        var sheet = d.body;

        function finish() { d.close(); }
        back._finish = finish;

        // The x in the title row, like every other Nayive dialog.
        var xb = d.header.appendChild( xButton( "btn install-close", finish ) );
        xb.setAttribute( "data-close", "" );

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
        lead.className   = "text install-lead";
        lead.textContent = mode === "installed"
            ? t( "ui.install.leadDone" )
            : t( "ui.install.lead" );
        sheet.appendChild( lead );

        if( mode !== "installed" )
        {
            var ul = document.createElement( "ul" );
            ul.className = "help-list";
            ul.appendChild( installRow( "grid", t( "ui.install.b1n" ),
                t( "ui.install.b1" ) ) );
            ul.appendChild( installRow( "fullscreen", t( "ui.install.b2n" ),
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
            ol.appendChild( installStep( "ios-share", t( "ui.install.s1a" ),
                                                    t( "ui.install.s1b" ),
                                                    t( "ui.install.s1c" ) ) );
            ol.appendChild( installStep( "add-home", t( "ui.install.s2a" ),
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
            olA.appendChild( installStep( "more", t( "ui.install.a1a" ),
                                                      t( "ui.install.a1b" ),
                                                      t( "ui.install.a1c" ) ) );
            olA.appendChild( installStep( "add-home",  t( "ui.install.a2a" ),
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
            note.className   = "text install-note";
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
            go.className   = "install-btn primary";
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
            later.className   = "install-btn";
            later.textContent = t( "ui.notNow" );
            later.addEventListener( "click", function () { snoozeInstall(); finish(); } );
            acts.appendChild( later );

            var never = document.createElement( "button" );
            never.type        = "button";
            never.className   = "install-btn install-never";
            never.textContent = t( "ui.install.dismiss" );
            never.addEventListener( "click", function () { neverShowInstall(); finish(); } );
            acts.appendChild( never );
        }

        if( acts.children.length ) sheet.appendChild( acts );

        d.show();
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
        if( introHeld || document.querySelector( "dialog.panel[open]" ) )
        {
            if( installPending ) return;
            if( ! document.querySelector( "dialog.panel[open]" ) && ++installTries > 15 )
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
    // "YOUR BROWSER" WARNING
    //
    // Two cases, each on every launch until "Don't show again":
    //  - big-tech: the Android app runs inside the user's default browser;
    //    when that is Google Chrome or Microsoft Edge, say so (Brave keeps
    //    the app working without them). Told apart by their UA-CH brands
    //    (Brave, Samsung Internet carry their own); no brands -> say nothing.
    //  - limited: Firefox Focus / Klar, DuckDuckGo - on any OS, in the app or
    //    not. They forget logins and storage, so much of Nayive falls short.
    //    Tor and private windows hide what they are: not detectable.
    //  - old: a browser older than the floor (Chrome/Edge 111, Safari 16.4,
    //    Firefox 113 - spring 2023), found by asking for what the code uses
    //    (tooOld), never by name. A warning, not a wall: a wrong guess must not
    //    lock anyone out. Its own "Don't show again", apart from the others.

    var CHROME_WARN = "nayive-chrome-warn";

    // What the apps use from spring 2023 on: color-mix() paints every colour
    // in app.css, structuredClone and Object.hasOwn are called bare.
    function tooOld()
    {
        try
        {
            return ! ( window.CSS && CSS.supports( "color", "color-mix(in srgb, red, blue)" ) &&
                       CSS.supports( "container-type", "inline-size" ) &&
                       typeof structuredClone === "function" && typeof Object.hasOwn === "function" );
        }
        catch ( _ ) { return true; }
    }

    function browserWarnCase()
    {
        var ua = navigator.userAgent;
        if( tooOld() )                    return { kind: "old" };
        if( /\bFocus\//.test( ua ) )      return { kind: "limited", name: "Firefox Focus" };
        if( /\bKlar\//.test( ua ) )       return { kind: "limited", name: "Firefox Klar" };
        if( /\bDuckDuckGo\//.test( ua ) ) return { kind: "limited", name: "DuckDuckGo" };
        if( ! inAndroidApp() ) return null;
        var b = ( navigator.userAgentData && navigator.userAgentData.brands ) || [];
        function has( n ) { return b.some( function ( x ) { return x.brand === n; } ); }
        if( has( "Microsoft Edge" ) ) return { kind: "bigtech", name: "Microsoft Edge", company: "Microsoft" };
        if( has( "Google Chrome" ) )  return { kind: "bigtech", name: "Google Chrome", company: "Google" };
        return null;
    }

    function warnChrome()
    {
        var wc = browserWarnCase();
        if( ! wc ) return;
        var key = CHROME_WARN + ( wc.kind === "old" ? "-old" : "" );
        try { if( localStorage.getItem( key ) === "never" ) return; } catch ( _ ) {}
        if( document.getElementById( "nayive-chrome-warn" ) ) return;
        if( introHeld || document.querySelector( "dialog.panel[open]" ) )
            return void setTimeout( warnChrome, 800 );     // never on top of another dialog

        var d     = Ayni.dialog( { id: "nayive-chrome-warn", cls: "install-sheet" } );
        var sheet = d.body;
        function finish() { d.close(); }
        d.dialog._finish = finish;

        var xb = d.header.appendChild( xButton( "btn install-close", finish ) );
        xb.setAttribute( "data-close", "" );

        var h = document.createElement( "h2" );
        h.className   = "install-title";
        h.textContent = t( "ui.chromeWarn.title" );
        sheet.appendChild( h );

        [ wc.kind === "old"     ? t( "ui.chromeWarn.p1old" )
                                 : tf( inAndroidApp() ? "ui.chromeWarn.p1" : "ui.chromeWarn.p1using", { name: wc.name } ),
          wc.kind === "old"     ? t( "ui.chromeWarn.p2old" )
        : wc.kind === "limited" ? t( "ui.chromeWarn.p2limited" )
                                 : tf( "ui.chromeWarn.p2", { company: wc.company } ),
          t( "ui.chromeWarn.p3" ) ].forEach( function ( s )
        {
            var p = document.createElement( "p" );
            p.className   = "text";
            p.textContent = s;
            sheet.appendChild( p );
        } );

        var acts  = document.createElement( "div" );
        acts.className = "install-actions";
        var never = document.createElement( "button" );
        never.type        = "button";
        never.className   = "install-btn install-never";
        never.textContent = t( "ui.install.dismiss" );
        never.addEventListener( "click", function ()
        {
            try { localStorage.setItem( key, "never" ); } catch ( _ ) {}
            finish();
        } );
        acts.appendChild( never );
        sheet.appendChild( acts );

        d.show();
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
        el.innerHTML = Ayni.icon( "lock" );

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
        Ayni.setTip( b, title );
        b.setAttribute( "aria-label", title );
        b.innerHTML = Ayni.icon( name );
        b.addEventListener( "click", function ()
        {
            Ayni.setBusy( b, t( "ui.wait" ) );
            Promise.resolve().then( action )
                .catch( function ( e ) { Ayni.toast( "err", e.message ); } )
                .then( function () { Ayni.setBusy( b, false ); } );
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

        Ayni.toast( "info", t( hintKey ) );
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
            // Escape presses its × (Ayni); a question asked from inside it
            // (Ayni.confirm) is the innermost dialog and takes its own Escape.
            var d = Ayni.dialog( { title: tf( "share.title", { what: opts.title || path.split( "/" ).pop() } ) } );
            var sheet = d.body;
            d.dialog.addEventListener( "close", function () { close(); } );

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
                sheet.innerHTML    = "";
                d.footer.innerHTML = "";
                d.header.querySelectorAll( "[data-close]" ).forEach( function ( b ) { b.remove(); } );

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
                        Ayni.setTip( del, t( "share.stop" ) );
                        del.innerHTML = Ayni.icon( "close" );
                        del.addEventListener( "click", function ()
                        {
                            Ayni.setBusy( del, t( "ui.wait" ) );
                            shareApi( "DELETE", null, g.id )
                                .then( function ()
                                {
                                    // Undo shares it again, the same way (a new grant, same person and rights).
                                    Ayni.toast( "ok", tf( "share.stopped", { who: name } ), { undo: function ()
                                    {
                                        shareApi( "POST", { to: g.to, root: path, app: g.app || opts.app || "folder",
                                                            title: g.title || opts.title || "", mode: g.mode || "ro" } )
                                            .catch( function ( e ) { Ayni.toast( "err", e.message ); } )
                                            .then( function () { if( back.parentNode ) return load(); } );
                                    } } );
                                    return load();
                                } )
                                .catch( function ( e ) { Ayni.toast( "err", e.message ); Ayni.setBusy( del, false ); } );
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
                    // "Everybody" on top: one grant that also reaches whoever gets
                    // an account later. While it is on the names below are greyed
                    // out - everybody is in already.
                    var allLab = document.createElement( "label" );
                    allLab.className = "share-add share-all";
                    var allBox = document.createElement( "input" );
                    allBox.type    = "checkbox";
                    allBox.setAttribute( "role", "switch" );
                    allBox.checked = toAll;
                    var allSw = document.createElement( "span" );
                    allSw.className = "switch";
                    allSw.appendChild( allBox );
                    allLab.appendChild( document.createTextNode( t( "share.allPick" ) ) );
                    allLab.appendChild( allSw );
                    people.appendChild( allLab );

                    // The names: an Ayni pick list (a click or Space ticks one,
                    // Shift a range, Ctrl+A all), in three columns. A name too wide
                    // for its column ends in "..." (the tooltip has it whole).
                    var list = document.createElement( "ul" );
                    list.className = "lb share-pick";
                    list.id        = "sharePick";
                    list.tabIndex  = 0;
                    list.setAttribute( "role", "listbox" );
                    list.setAttribute( "aria-multiselectable", "true" );
                    list.setAttribute( "aria-label", t( "share.pick" ) );
                    if( toAll ) list.setAttribute( "aria-disabled", "true" );

                    free.forEach( function ( name )
                    {
                        var li = document.createElement( "li" );
                        li.setAttribute( "role", "option" );
                        li.setAttribute( "aria-selected", chosen.indexOf( name ) !== -1 ? "true" : "false" );
                        li.title = name;
                        var nm = document.createElement( "span" );
                        nm.textContent = name;
                        li.appendChild( nm );
                        list.appendChild( li );
                    } );

                    // No render() on a change: it would scroll the list back to the top.
                    list.addEventListener( "ayni:change", function ( e )
                    {
                        chosen.splice.apply( chosen, [ 0, chosen.length ].concat( e.detail.selected ) );
                        if( ok ) ok.ariaDisabled = ! ( toAll || chosen.length );
                    } );
                    allBox.addEventListener( "change", function ()
                    {
                        toAll = allBox.checked;
                        list.setAttribute( "aria-disabled", toAll ? "true" : "false" );
                        if( ok ) ok.ariaDisabled = ! ( toAll || chosen.length );
                    } );
                    Ayni.init( list );
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
                    addBox.setAttribute( "role", "switch" );
                    addBox.checked = mayAdd;
                    addBox.addEventListener( "change", function ()
                    {
                        mayAdd = addBox.checked;
                        setLead();          // no render(): that would scroll the list back to the top
                    } );

                    // An on / off option: the text, then the shared .switch.
                    var addSw = document.createElement( "span" );
                    addSw.className = "switch";
                    addSw.appendChild( addBox );

                    addLab.appendChild( document.createTextNode(
                        t( "share.mayadd" ) ) );
                    addLab.appendChild( addSw );
                    people.appendChild( addLab );
                }
                sheet.appendChild( people );

                // --- buttons: a lone × goes in the title row ---
                var row2 = d.footer;

                var cancel = Ayni.dialogButton( "close", t( "ui.close" ) );
                cancel.addEventListener( "click", close );
                ( free.length ? row2 : d.header ).appendChild( cancel );

                if( free.length )
                {
                    ok = Ayni.dialogButton( "primary", t( "share.send" ) );
                    ok.ariaDisabled = ! ( toAll || chosen.length );
                    ok.addEventListener( "click", function ()
                    {
                        if( ! toAll && ! chosen.length ) return;
                        Ayni.setBusy( ok, t( "ui.wait" ) );   // load() draws the list again, with a new ✓

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
                                    Ayni.toast( "ok", t( "share.allDone" ) );
                                    return load();
                                } )
                                .catch( function ( e ) { Ayni.toast( "err", e.message ); return load(); } );
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
                            Ayni.toast( "ok", tf( "share.done", { who: done.join( ", " ) } ) );
                            return load();
                        } )
                        .catch( function ( e ) { Ayni.toast( "err", e.message ); return load(); } );
                    } );
                    row2.appendChild( ok );
                }

                applySheetButtons( d.dialog );
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
                        return copyText( url ).then( function () { Ayni.toast( "ok", t( "share.link.copied" ) ); },
                                                     function () { Ayni.toast( "info", url ); } );
                    } ) );
                    // Gone from the sheet at once; the link itself dies when the
                    // Undo does (a new link would be a new address).
                    row.appendChild( rowButton( "close", t( "share.link.stop" ), function ()
                    {
                        var id = link.id;
                        linksGoing[ id ] = true;
                        link    = null;
                        dropped = true;
                        render();
                        Ayni.toast( "ok", t( "share.link.stopped" ), { undo: function ()
                        {
                            delete linksGoing[ id ];
                            dropped = false;
                            if( back.parentNode ) load();
                        }, final: function ()
                        {
                            shareApi( "DELETE", null, id )
                                .catch( function ( e ) { Ayni.toast( "err", e.message ); } )
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
                    Ayni.toast( "err", e.message || t( "ui.loadFailed" ) );
                } ).then( render );
            }

            render();
            d.show();
            load();
        } );
    }

    // The town at a (rounded) position, in the viewer's language; "" when unknown.
    // Asks OpenStreetMap's Nominatim, so pass a position already rounded.
    function townName( lat, lon )
    {
        var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=" +
                  encodeURIComponent( window.Ayni ? Ayni.i18n.lang() : "es" ) + "&lat=" + lat + "&lon=" + lon;
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
                        // Looked up on window.Ayni at call time: a test answers it.
                        return window.Ayni.confirm( { title: t( "launcher.unsavedTitle" ),
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
    // TOASTS ABOVE A BOTTOM BAR
    //
    // On a phone Ayni's notifications sit at the bottom of the screen. A bar
    // along the bottom (a player, Chat's message box, Calc's sheet tabs) marks
    // itself data-toasts-above, and its height lifts them over it
    // (--toasts-lift, shared/ayni/ayni-toasts.css). Asked again whenever such
    // a bar changes size, shows or hides, and on resize.

    var liftObserver = window.ResizeObserver ? new ResizeObserver( liftToasts ) : null;

    function liftToasts()
    {
        var h = 0, H = window.innerHeight;
        document.querySelectorAll( "[data-toasts-above]" ).forEach( function ( el )
        {
            var r = el.getBoundingClientRect();
            if( r.height && r.bottom >= H - 2 ) h = Math.max( h, H - r.top );
        } );
        document.documentElement.style.setProperty( "--toasts-lift", Math.round( h ) + "px" );
    }

    function watchToastLifts( root )
    {
        if( ! liftObserver || ! root.querySelectorAll ) return;
        if( root.matches && root.matches( "[data-toasts-above]" ) ) liftObserver.observe( root );
        root.querySelectorAll( "[data-toasts-above]" ).forEach( function ( el ) { liftObserver.observe( el ); } );
    }

    if( document.body ) watchToastLifts( document.body );
    else document.addEventListener( "DOMContentLoaded", function () { watchToastLifts( document.body ); } );
    window.addEventListener( "resize", liftToasts );

    //------------------------------------------------------------------------//
    // UPLOAD PROGRESS
    //
    // GumApi.putBinary announces every upload as "nayive:upload" events on the
    // document ({ id, loaded, total }, then { id, done: true }). The uploads of
    // one BURST share one progress notification (Ayni.progress, in the toast
    // stack): Photos and Drive send many files one after another, and each
    // alone may be quick. Ayni shows it only once the burst has run 600 ms, so
    // a settings file or a thumbnail shows nothing. It goes UPLOAD_HIDE_MS
    // after the last one ends, so it does not flicker in the gap between two files.
    //
    // The percent is of what is in flight NOW; the apps already say "3 de 12"
    // in their own status line when they send several.

    var UPLOAD_HIDE_MS = 400;

    var uploads     = {};     // id -> { loaded, total }, the requests in flight
    var burstBytes  = 0;      // bytes the finished uploads of this burst sent
    var uploadRow   = null;   // the burst's progress notification
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
        var text = tf( "ui.uploading", { pct: pct } );
        if( uploadRow ) uploadRow.set( text, pct );
        else if( document.body && window.Ayni && Ayni.progress ) uploadRow = Ayni.progress( text, { pct: pct } );
    }

    function endUploadBurst()
    {
        uploadHideT = null;
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
            drawUploadBar( uploadPercent() );
        }
        else
        {
            if( uploadRow ) drawUploadBar( 100 );           // it did finish
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

    function dialogOpen() { return !! document.querySelector( "dialog.panel[open]" ); }

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
        var close = xButton( "btn sm", function () { card.remove(); } );
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
        find.className = "btn text primary";
        find.innerHTML = Ayni.icon( "search" ) + "<span></span>";
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

    // Hangs " · Ctrl+F" off the tooltip of each shortcut's button (`list`:
    // { el: its id, label() }) - and takes it off again on a phone. A middle
    // dot, not parentheses: some tips already end in "(uno)". Idempotent, so
    // it can run again after a title is rewritten (selection, language).
    // Drive's and Write's toolbars.
    function keyHints( list, phone )
    {
        list.forEach( function ( s )
        {
            var el = s.el && document.getElementById( s.el );
            if( ! el ) return;

            var hint = " (" + s.label() + ")";   // Ayni's form: "Print (Ctrl+P)"
            var tip  = el.dataset.tip || "";

            if( tip.slice( -hint.length ) === hint ) tip = tip.slice( 0, -hint.length );
            if( ! tip ) return;                    // no tooltip yet: nothing to hang the hint on

            Ayni.setTip( el, phone ? tip : tip + hint );
        } );
    }

    // Where `path` is after the moves in `pairs` ([ old, new ]): the same
    // place, or the new one when it is (or lives inside) a moved item.
    // Drive's and Photos' undo of a move.
    function followPath( path, pairs )
    {
        for( var i = 0; i < pairs.length; i++ )
        {
            var pr = pairs[ i ];
            if( path === pr[ 0 ] )                    return pr[ 1 ];
            if( path.indexOf( pr[ 0 ] + "/" ) === 0 ) return pr[ 1 ] + path.slice( pr[ 0 ].length );
        }
        return path;
    }

    // "foto.jpg" -> "foto (2).jpg", "foto (3).jpg"... while the name is in
    // `taken` (a Set of the folder's names). Photos' and the share target's
    // uploads; Drive passes its "(copia)" word to GumApi.uniqueName instead.
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
    // Accents are dropped (Ayni.fold), not the letters; anything else that is not a-z
    // or 0-9 becomes one "-". `max` cuts it; `fallback` stands in for "".
    function slugify( s, fallback, max )
    {
        var out = Ayni.fold( s || "" ).replace( /[^a-z0-9]+/g, "-" ).replace( /^-+|-+$/g, "" );
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
        Ayni.setTip( el, t( key ) + hint );

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
        if( who && window.Ayni && Ayni.i18n.setLang( who.lang ) )
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
    // open, text is being typed); the default is "any dialog is open".
    // `why` is "visible" / "focus" / "plug" / "retry" / "online", so an app can tell a DELIBERATE refresh
    // from an automatic one - Trips lets the plug re-read from any screen but keeps
    // the automatic paths on the trip list, where re-rendering costs nothing.
    function wireRefresh( opts )
    {
        opts = opts || {};
        var lastRefresh = 0;
        var throttle    = opts.throttleMs || 20000;
        var guard       = opts.guard || function () { return !! document.querySelector( "dialog.panel[open]" ); };

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
    // "MORE" MENU  -  the desktop's own bar popups only (its ⋮, the weather;
    // desktop/index.html), until the desktop family moves to Ayni. Every other
    // menu is an Ayni menu (shared/ayni/ayni-menus.js). The menu is a
    // `.top-menu` (shared/app.css: position fixed) anchored under its button;
    // a click on an item, outside, Escape, or a resize closes it.
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

    // A popup menu taller than the room it has scrolls (app.css: .top-menu
    // overflow-y auto) instead of running off the screen. Every app places its
    // menus its own way, so this watches them all: when a .top-menu shows (its
    // `hidden` goes, or it is added), its height is capped at the edge it
    // would cross - the bottom for one hung under its button, the top for one
    // that rises above it (Chat's send menu, the desktop bar at the bottom).
    function fitMenu( m )
    {
        m.style.maxHeight = "";
        if( m.hidden || ! m.isConnected ) return;
        var r = m.getBoundingClientRect(), vh = window.innerHeight, pad = 8;
        if( r.bottom > vh - pad && r.top >= pad )
            m.style.maxHeight = Math.max( 120, vh - pad - r.top ) + "px";
        else if( r.top < pad && r.bottom <= vh - pad )
            m.style.maxHeight = Math.max( 120, r.bottom - pad ) + "px";
    }
    function isMenu( n ) { return n.nodeType === 1 && n.classList.contains( "top-menu" ); }
    new MutationObserver( function ( recs )
    {
        var seen = [];
        recs.forEach( function ( rec )
        {
            var list = rec.type === "attributes" ? [ rec.target ] : rec.addedNodes;
            for( var i = 0; i < list.length; i++ )
                if( isMenu( list[ i ] ) && seen.indexOf( list[ i ] ) < 0 ) seen.push( list[ i ] );
        } );
        seen.forEach( fitMenu );
    } ).observe( document.documentElement, { subtree: true, childList: true,
                                             attributes: true, attributeFilter: [ "hidden" ] } );

    //------------------------------------------------------------------------//
    // CLOSE-ONLY DIALOGS  -  the GNOME way (docs/audit/dialogs.md): a settings
    // dialog has only its ×, and every change is kept. × = Escape = close =
    // KEEP. Ayni.autoSave( field, save, o ) saves one field on its own; the
    // dialog's own `close` event runs what is kept only when it goes. Moving,
    // the first field, Escape and the × are Ayni's too (ayni-dialogs.js).

    //------------------------------------------------------------------------//
    // LOW BATTERY (2026-10-04) - where the browser tells the battery level
    // (navigator.getBattery: Chrome, Edge, Android; not Firefox, Safari or the
    // iPhone), a dialog in the middle of the screen, in front of all, says it
    // is low: 15% or less and not charging. Whatever the desktop's "Show
    // battery" switch says. The top page only, the pages quotaPage() allows
    // (the desktop, or the app on a phone; never a desktop window's frame).
    // Once per drop: "nayive-batt-warned" is set when shown and cleared when
    // charging starts or the level climbs back, so going from app to app on
    // a phone does not ask again. Plugging in closes it. Reads only.

    var BATT_LOW = 0.15, BATT_KEY = "nayive-batt-warned";
    var battDlg = null, battWarned = false;

    function battFlag( on )                 // no `on`: shown already in this drop?
    {
        if( on === undefined )
        {
            try { return battWarned || !! localStorage.getItem( BATT_KEY ); } catch ( _ ) { return battWarned; }
        }
        battWarned = on;
        try { if( on ) localStorage.setItem( BATT_KEY, "1" ); else localStorage.removeItem( BATT_KEY ); } catch ( _ ) {}
    }

    function battShow( level )
    {
        var d = Ayni.dialog( { title: t( "ui.battLowTitle" ) } );   // a modal dialog: in front of everything
        var p = document.createElement( "p" );
        p.className = "text";
        p.textContent = tf( "ui.battLowBody", { n: Math.round( level * 100 ) } );
        d.body.appendChild( p );
        var ok = Ayni.dialogButton( "close", t( "ui.close" ) );
        d.place( [ ok ] );                                     // a lone × goes in the title row
        ok.addEventListener( "click", function () { d.close(); } );
        d.show();
        return d;
    }

    function battWatch()
    {
        if( ! quotaPage() || ! navigator.getBattery ) return;
        navigator.getBattery().then( function ( b )
        {
            function check()
            {
                if( b.charging || b.level > BATT_LOW )
                {
                    battFlag( false );
                    if( battDlg ) { battDlg.close(); battDlg = null; }
                    return;
                }
                if( battFlag() ) return;
                battFlag( true );
                i18nReady.then( function () { battDlg = battShow( b.level ); } );
            }
            b.addEventListener( "chargingchange", check );
            b.addEventListener( "levelchange", check );
            check();
        }, function () {} );
    }

    function applyI18n() { if( window.Ayni ) Ayni.i18n.apply( document ); }

    function uiInit()
    {
        applyI18n();
        applySheetButtons();
        applyHomeLinks();
        applySyncDots();
        startChatDot();

        // uiInit runs at DOMContentLoaded; the dictionary usually lands a moment
        // later, and applySheetButtons may have added keys of
        // their own, so translate once more when it does.
        i18nReady.then( function () { applyI18n(); } );

        pingSwUpdate();
        scheduleQuotaCheck( false, 3000 );
        battWatch();
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
        paneResizer: paneResizer,   // a .pane-resizer handle sizes the pane next to it
        isMac:    IS_MAC,           // shortcuts take ⌘ (Drive, Write, Calc, Text)
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
        followPath: followPath,
        keyHints:   keyHints,
        uniqueName: uniqueName,    // "foto.jpg" -> "foto (2).jpg" in a folder that has it
        slugify:    slugify,       // "Córdoba" -> "cordoba" (Trips, Split)
        timeZones:  timeZones,     // every IANA zone (the launcher, Calendar)
        applySyncState: applySyncState,   // store state -> the header plug (classes + title)
        syncIndicator:  syncIndicator,    // a ready store.onState listener for #syncIndicator
        bootWithStore:  bootWithStore,    // the access probe + "open from cache" fallback
        wireRefresh:    wireRefresh,      // visibilitychange / focus / plug-click re-read
        wireMenu:       wireMenu,         // the header "..." popup menu
        h:                 h,             // build DOM: h( "div", { class, text, on, attrs, data }, kids… )
        attachPanel:       attachPanel,   // the clip's round-button panel (Chat, eMail)
        applySheetButtons: applySheetButtons,
        applyHomeLinks:    applyHomeLinks,
        applySyncDots:     applySyncDots,
        windowed:          WINDOWED,     // true inside a desktop window
        askPassword: askPassword,
        fmtBytes:   fmtBytes,
        ensureRoom: ensureRoom,
        holdIntro: holdIntro,     // no help card / first-visit marks / install offer this load
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
        warnChrome:           warnChrome,
        isStandalone:         isStandalone,
        installMode:          installMode
    };
} )();
