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
 *   - embedded mode: inside another Nayive page's <iframe> (Planner frames
 *     calendar + tasks + habits) Ayni.frame stamps <html> .is-embedded, app.css
 *     hides the app's own title / sync dot (the host shows them once), and
 *     anything that must leave the frame (home link, sign-in) navigates
 *     Ayni.frame.owner(). When the host window is wider than a phone the <html>
 *     also gets .is-embedded-wide and the app's own icon stays on, labelling its
 *     pane in Planner's split view.
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

    // EMBEDDED, WINDOWED - inside a frame at all, and in a window of the desktop
    // (Ayni.frame, which also stamps <html>). A window keeps its own icon, title
    // and sync dot: that row IS the window's title bar. Still EMBEDDED for the JS:
    // the update bar, quota card and Chat dot belong to the desktop, not to a window.
    var EMBEDDED = Ayni.frame.embedded, WINDOWED = Ayni.frame.windowed;

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
                    Ayni.plug.draw( n );
                    watchToastLifts( n );
                }
            }
        } );
        try { dtObserver.observe( document.documentElement, { childList: true, subtree: true } ); }
        catch ( e ) {}
    }

    //------------------------------------------------------------------------//
    // DIALOG ACTION BUTTONS

    // The app's own logos: the rest of the icons are Ayni's (ayni-icons-more.js).
    if( window.Ayni ) Ayni.icons.add( {
        // App logos that do not fit the 24 grid: their own viewBox. `write` =
        // fountain pen + inkwell, `calc` = the "f(x)" mark, `nayive` = the real
        // Nayive logo (the launcher's artwork, never redrawn): the icon of every
        // button about Nayive's own files (From Nayive, Save to Nayive...).
        nayive:
            '<svg viewBox="0 0 24 24"><image href="/nayive/icons/icon-192.png" width="24" height="24"></image></svg>',
        write:
            '<svg viewBox="0 0 512 512" fill="currentColor"><g transform="translate(45 465) rotate(-48)"><path d="M0 0 28 -14 82 -36C96 -36 110 -27 122 -19L122 19C110 27 96 36 82 36L28 14Z"></path><rect x="132" y="-26" width="350" height="52"></rect><path d="M494 -26 522 -26C542 -26 550 -14 550 0 550 14 542 26 522 26L494 26Z"></path></g><rect x="262" y="220" width="176" height="50" rx="12"></rect><path fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" d="M294 270 294 300C294 314 228 312 228 332L228 445C228 460 240 472 255 472L445 472C460 472 472 460 472 445L472 332C472 312 406 314 406 300L406 270"></path><path d="M228 415 472 415 472 445C472 460 460 472 445 472L255 472C240 472 228 460 228 445Z"></path>',
        calc:
            '<svg viewBox="0 0 512 512" fill="currentColor"><g transform="translate(-213.2 -558.1) scale(1.8891 3.2191)"><g transform="translate(37.3 3.7)"><path d="m 159.5,210.8 v 7.2 h 25.2 v 16.5 H 159.5 V 300 h -21.5 v -65.6 h -19.9 v -16.5 h 19.9 v -5.7 q 0,-14.8 6.2,-20.5 6.2,-5.7 22.9,-5.7 h 17.7 v 16.5 h -16.8 q -4.8,0 -6.6,1.8 -1.7,1.8 -1.8,6.5 z"></path><g transform="translate(67.4 112.5) scale(.625)"><path d="m 243.4,186.2 q -9.7,17.5 -14.4,33.9 -4.7,16.4 -4.7,32.8 0,16.3 4.7,32.8 4.7,16.5 14.4,34.1 h -16.7 q -11.6,-16.9 -17.3,-33.3 -5.6,-16.5 -5.6,-33.5 0,-17 5.6,-33.5 5.7,-16.6 17.3,-33.3 z"></path><path d="M 329.9,218 302.2,257.2 332.3,300 H 307.2 L 291.1,272.4 275.1,300 h -25 l 30.3,-42.8 -27.9,-39.3 h 25 l 13.6,24.5 13.7,-24.5 z"></path><path d="m 338.9,186.2 h 16.7 q 11.6,16.7 17.2,33.3 5.7,16.5 5.7,33.5 0,17.1 -5.6,33.5 -5.6,16.4 -17.3,33.3 h -16.7 q 9.7,-17.6 14.4,-34.1 4.7,-16.6 4.7,-32.8 0,-16.4 -4.7,-32.8 -4.7,-16.4 -14.4,-33.9 z"></path></g></g></g></svg>',
    } );

    var h = Ayni.h;

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


    // (CONFIRM / ALERT / ASK FOR ONE NAME are Ayni's: Ayni.confirm, Ayni.alert,
    // Ayni.ask - shared/ayni/ayni-dialogs.js.)

    //------------------------------------------------------------------------//
    // ROOM FOR AN UPLOAD  (and the offer to empty the papelera)
    //------------------------------------------------------------------------//

    // Is there room for `need` bytes? Ayni.ensureRoom asks; the data is the server's.
    // Every upload path (Drive, Photos, the share target) calls this. The server
    // enforces the quota anyway (507).
    function ensureRoom( need )
    {
        return Ayni.ensureRoom( need, {
            space:  function () { return AyniNet.fetchText( AyniNet.API_FILES + "?stat=disk" ).then( JSON.parse ); },
            binIds: function () { return AyniNet.trashList().then( function ( l ) { return l.map( function ( it ) { return it.id; } ); } ); },
            empty:  function ( ids ) { return AyniNet.trashDelete( ids ); }
        } );
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

    var HOME_SEL = ".app-icon.home-link, h1.home-link";

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

    function goHome()
    {
        // In a desktop window "home" is the desktop's menu: leaving would close every window.
        if( WINDOWED ) { try { window.top.AyniDesk.menu(); } catch ( err ) {} return; }
        // A red Chat dot on the icon (see CHAT DOT below): the tap - icon OR
        // name, one target for a finger - goes to Chat.
        var toChat = chatDot.showing();
        Ayni.frame.owner().location.href = toChat ? "/nayive/chat/" : "/nayive/";   // the TOP window when framed (Planner)
    }

    Ayni.plug.bars += ", .trip-header";
    var applyHomeLinks = Ayni.homeLinks( { go: goHome, tip: "ui.toApps", heads: ".topbar, .header, .trip-header",
                                           not: ".trip-header-title", onIcon: function () { placeChatDot(); } } );

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

    var chatDot    = Ayni.badge( ".app-icon.home-link" );
    var chatUnread = -1;           // -1 = not asked yet: unread found at load shows, but does not blink

    function chatDotWanted()
    {
        var p = location.pathname;
        // the launcher has its own count on the Chat tile
        if( p === "/nayive/" || p === "/nayive/index.html" ) return false;
        return ! EMBEDDED && p.indexOf( "/nayive/" ) === 0 && p.indexOf( "/nayive/chat/" ) !== 0;
    }

    function placeChatDot() { chatDot.place(); }

    function showChatDot( n )
    {
        var before = chatUnread;
        chatUnread = n;
        // The desktop (desktop/index.html) has no app icon: it draws its own dot.
        try { document.dispatchEvent( new CustomEvent( "nayive:chatunread", { detail: n } ) ); } catch ( e ) {}
        chatDot.set( n, before >= 0 && n > before );
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
    // Needs AyniNet (shared/ayni/ayni-net.js) for the folders-only tree (GET ?tree=dirs).
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

    // The dialog is Ayni's (Ayni.pickFolder); what stays here is the data: the
    // folders of files/, and what a change does to them.
    function pickFolder( opts )
    {
        opts = opts || {};
        var ctl = null;

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

        // The tree from AyniNet.dirTree() is folders-only, so every node here is
        // a folder; a folder with no sub-folders just has nodes:[].
        function treeNodes( nodes )
        {
            return sortNodes( nodes || [] ).filter( function ( n ) { return Array.isArray( n.nodes ); } )
                .map( function ( n )
                {
                    return { id: n.path, name: String( n.path ).split( "/" ).pop(), children: treeNodes( n.nodes ) };
                } );
        }

        function load()
        {
            return ( window.AyniNet ? AyniNet.dirTree() : Promise.reject( new Error( "no AyniNet" ) ) ).then( function ( tree )
            {
                var nodes = ( tree && tree.nodes ) || [];
                for( var i = 0; i < nodes.length; i++ )
                    if( nodes[ i ].path === "files" ) return treeNodes( nodes[ i ].nodes );
                return [];
            } );
        }

        function renameFolder( from, to )
        {
            return AyniNet.rename( from, to ).then( function ()
            {
                // The whole sub-tree moves with the folder: what the user had
                // open under it stays open. Only once the server has said yes: a
                // refused rename must leave the tree exactly as it was.
                ctl.rekey( from, to );

                // The photo notes and scan entries under it follow, as they do
                // on a rename in Drive.
                return sidecarUpkeep( "remapPaths", [ [ from, to ] ] );
            } );
        }

        // An Undo's server call: on the tree when the picker is still open, on
        // its own when it has closed meanwhile.
        function afterUndo( p )
        {
            if( ctl.isOpen() ) ctl.task( p );
            else p.catch( taskFailed );
        }

        // A name already taken is the server's 409: say it in words, not
        // "HTTP 409: Conflict".
        function taskFailed( err )
        {
            Ayni.toast( "warn", err && err.status === 409 ? t( "drive.nameExistsTitle" )
                                             : String( ( err && err.message ) || err ) );
        }

        function rename( from, name )
        {
            var to = from.slice( 0, from.lastIndexOf( "/" ) + 1 ) + name;
            return renameFolder( from, to ).then( function ()
            {
                Ayni.toast( "ok", t( "ui.toast.renamed" ), { undo: function ()
                {
                    afterUndo( renameFolder( to, from ).then( function () { return from; } ) );
                } } );
                return to;
            } );
        }

        // Straight to the papelera - Drive can put it back - so this acts at
        // once, with an Undo: a delete already inside a dialog never asks a
        // second time. Its scan entries and thumbnails go, as on a delete in
        // Drive (the notes stay, so a restore brings them back).
        function remove( gone )
        {
            return AyniNet.binPaths( [ gone ] ).then( function ( ids )
            {
                if( ids && ids.length )
                    Ayni.toast( "ok", t( "ui.toast.binned" ), { undo: function ()
                    {
                        afterUndo( AyniNet.trashRestore( ids ).then( function () { return gone; } ) );
                    } } );
                return sidecarUpkeep( "purgePaths", [ gone ] );
            } );
        }

        return Ayni.pickFolder( {
            title:     opts.title,
            note:      opts.note,
            root:      "files",
            rootName:  opts.allowRoot ? ( opts.rootLabel || t( "ui.fp.allFiles" ) ) : null,
            noFolders: t( "ui.fp.noFolders" ),
            load:      load,
            create:    function ( parent, name )
            {
                return AyniNet.makeDir( parent, name ).then( function () { return parent + "/" + name; } );
            },
            rename:    rename,
            remove:    remove,
            failed:    taskFailed,
            onOpen:    function ( c ) { ctl = c; }
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
    // Needs AyniNet (listDir).

    function pickFile( opts )
    {
        opts = opts || {};

        function nameOf( n ) { return String( n.path ).split( "/" ).pop(); }

        // The dialog is Ayni's (Ayni.pickFile); the listing is the data.
        function list( dir )
        {
            return ( window.AyniNet ? AyniNet.listDir( dir ) : Promise.reject( new Error( "no AyniNet" ) ) ).then( function ( res )
            {
                return ( ( res && res.nodes ) || [] ).filter( function ( n )
                {
                    if( nameOf( n ).charAt( 0 ) === "." ) return false;   // hide .bak etc.
                    return Array.isArray( n.nodes ) || ! opts.only || opts.only( nameOf( n ) );
                } ).map( function ( n )
                {
                    return { id: n.path, name: nameOf( n ), dir: Array.isArray( n.nodes ), size: n.size || 0 };
                } );
            } );
        }

        return Ayni.pickFile( {
            title:    opts.title,
            dir:      opts.dir || "files",
            rootName: t( "ui.filesRoot" ),
            okTip:    opts.confirm,
            list:     list,
            sizeText: Ayni.fmtBytes
        } ).then( function ( n )
        {
            return n ? { path: n.id, name: n.name, size: n.size } : null;
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

        return AyniNet.readJson( cfgPath ).then( function ( cfg )
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
            if( err && err.status === 401 && ! opts.noRedirect && navigator.onLine ) AyniNet.loginRedirect();
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
        return AyniNet.writeJson( cfgPath, next )
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
            return AyniNet.readJson( cfgPath ).then( function ( cfg )
            {
                return saveLauncherFolder( cfgPath, cfg, picked );
            }, function () { return picked; } );
        } );
    }

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

    // The dialog is Ayni's (Ayni.share); what stays here is the data: who the users
    // are, the /api/shares calls, and a trip's public link.
    function shareSheet( opts )
    {
        opts = opts || {};
        return Ayni.share( Object.assign( {}, opts, {
            link:       opts.app === "trips",
            lead:       opts.app === "trips" ? t( "share.leadTrip" ) : "",
            peopleHead: t( "share.people.head" ),
            api:        shareApi,
            users:      function ()
            {
                return fetch( window.location.origin + "/api/users" ).then( function ( r ) { return r.json(); } )
                    .then( function ( j ) { return ( j && j.users ) || []; } );
            }
        } ) );
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
    // Called by shared/ayni/ayni-net.js (assertOk) and shared/ayni/ayni-store.js (netGet/netPut)
    // on a real 401 only - never on a 403, which here means "not yours /
    // read-only", and never for the /api/whoami boot probe, whose 401 every app
    // already handles by itself.
    //
    // It deliberately does NOT redirect on its own. Apps that hold state in
    // memory (an unnamed Text/Calc document, a half-filled admin form) would
    // lose it, so the user picks the moment. Everything wired to shared/ayni/ayni-store.js
    // has already kept the edit locally; signing in again just flushes it.

    // Send the browser to the sign-in page, returning here afterwards. Framed
    // pages (Planner's iframes, a desktop window) navigate the TOP window, or
    // the sign-in form would open inside the frame. A cross-origin
    // `top.location` throws; then we fall back to ourselves. AyniNet.loginRedirect
    // is this same function (admin.html and the launcher have no AyniNet).
    //
    // Leaving drops whatever the page has not kept yet - a save only in this
    // page, an office document still being written, an Image edit. A page of
    // its own is guarded by its beforeunload (the browser asks). A FRAMED
    // page - a desktop window, a Planner pane - goes with the TOP window,
    // every other window with it, and its beforeunload may show nothing (no
    // click in that frame yet): so it is asked first, as the desktop's (x)
    // asks it - window.ayniBeforeClose (shared/ayni/ayni-store.js, office.js, eMail,
    // Image). "Stay" stays; the bar's button can be pressed again.
    var redirecting = false;

    async function loginRedirect()
    {
        if( redirecting ) return;
        redirecting = true;
        try
        {
            if( EMBEDDED && typeof window.ayniBeforeClose === "function" )
            {
                var go = true;
                try { go = await Promise.resolve( window.ayniBeforeClose() ); }
                catch ( e ) { go = true; }        // as the desktop's (x): a throw closes
                if( ! go ) return;
            }

            var win = Ayni.frame.owner();
            win.location.href = "/nayive/login.html?return=" +
                encodeURIComponent( win.location.pathname + win.location.search );
        }
        finally { redirecting = false; }
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
    // (AyniStore.leaveDevice, shared/ayni/ayni-store.js SIGNING OUT).
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
            if( window.AyniStore )
            {
                var go = true;
                try
                {
                    go = await AyniStore.leaveDevice( function ( n, why )
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

    // UPLOAD PROGRESS: Ayni.uploads. AyniNet.putBinary announces every upload as
    // "nayive:upload" events; a real upload (not an autosave or a thumbnail) may
    // just have pushed the space past 90%: look now rather than at the next page.
    Ayni.uploads( { event: "nayive:upload", onBurst: function ( bytes )
    {
        if( bytes >= QUOTA_BURST_MIN ) scheduleQuotaCheck( true, 1500 );
    } } );

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
    // fetch, not AyniNet: a signed-out page must get a quiet 401, not the
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
        return ! EMBEDDED && p.indexOf( "/nayive/" ) === 0 &&
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
        var pct = Math.min( 100, Math.floor( 100 * used / total ) );
        quotaCard = Ayni.spaceCard( {
            title: t( "ui.quota.title" ),
            used:  tf( "ui.quota.used", { pct: pct, used: Ayni.fmtBytes( used ), total: Ayni.fmtBytes( total ) } ),
            how:   t( "ui.quota.how" ),
            items: [ held > 0 ? tf( "ui.quota.binHolds", { held: Ayni.fmtBytes( held ) } ) : t( "ui.quota.bin" ),
                     t( "ui.quota.chat" ),
                     t( "ui.quota.big" ) ],
            action: { label: t( "ui.quota.find" ), icon: "search", run: function ()
            {
                // Drive listens for "nayive:bigfiles" and opens the list in place;
                // anywhere else it is a trip to Drive.
                var ev = new CustomEvent( "nayive:bigfiles", { cancelable: true } );
                if( document.dispatchEvent( ev ) ) location.href = "/nayive/drive/index.html?big=1";
            } }
        } );
    }


    //------------------------------------------------------------------------//
    // CLOSE-ONLY DIALOGS  -  the GNOME way (docs/audit/dialogs.md): a settings
    // dialog has only its ×, and every change is kept. × = Escape = close =
    // KEEP. Ayni.autoSave( field, save, o ) saves one field on its own; the
    // dialog's own `close` event runs what is kept only when it goes. Moving,
    // the first field, Escape and the × are Ayni's too (ayni-dialogs.js).

    //------------------------------------------------------------------------//
    window.AyniPhotoBackend = window.AyniNet;
    window.AyniFabricUrl    = "/nayive/shared/lib/fabric_v7.4.0.min.js";

    // The browser side of an installed app is Ayni's (Ayni.pwa); these are Nayive's.
    Ayni.pwa.config( {
        app:    "Nayive",
        logo:   "/nayive/icons/icon-192.png",
        keys:   { install: "nayive-install-snooze", browser: "nayive-chrome-warn", batt: "nayive-batt-warned" },
        apkRef: /^android-app:\/\/org\.nayive\.app\b/, apkKey: "nayive-apk",
        held:   function () { return introHeld; },
        page:   quotaPage,
        signIn: loginRedirect
    } );

    function applyI18n() { if( window.Ayni ) Ayni.i18n.apply( document ); }

    function uiInit()
    {
        applyI18n();
        applySheetButtons();
        applyHomeLinks();
        Ayni.plug.draw();
        startChatDot();

        // uiInit runs at DOMContentLoaded; the dictionary usually lands a moment
        // later, and applySheetButtons may have added keys of
        // their own, so translate once more when it does.
        i18nReady.then( function () { applyI18n(); } );

        Ayni.pwa.pingUpdate();
        scheduleQuotaCheck( false, 3000 );
        Ayni.pwa.watchBattery();
        document.addEventListener( "visibilitychange", function ()
        {
            if( document.visibilityState !== "visible" ) return;
            Ayni.pwa.pingUpdate();
            scheduleQuotaCheck( false, 3000 );
        } );
    }

    if( document.readyState === "loading" )
        document.addEventListener( "DOMContentLoaded", uiInit );
    else
        uiInit();

    // An Office file with a password set in Word / Excel is no zip but an OLE
    // box (D0 CF 11 E0) holding an "EncryptedPackage" stream: no engine here
    // reads it. Write and Calc call this before loading: it says why, and
    // throws an error marked .said, so ayni-doc adds no "could not be opened".
    // Read-only: it only looks at the bytes.
    function refuseOfficeLocked( body )
    {
        var b = body instanceof Uint8Array ? body
              : body instanceof ArrayBuffer ? new Uint8Array( body ) : null;
        if( ! b || b.length < 512 || b[ 0 ] !== 0xD0 || b[ 1 ] !== 0xCF || b[ 2 ] !== 0x11 || b[ 3 ] !== 0xE0 ) return;

        var tag = "EncryptedPackage", n = tag.length, found = false;
        for( var i = 0; i + n * 2 <= b.length && ! found; i++ )
        {
            var k = 0;
            while( k < n && b[ i + k * 2 ] === tag.charCodeAt( k ) && b[ i + k * 2 + 1 ] === 0 ) k++;
            found = ( k === n );
        }
        if( ! found ) return;

        Ayni.alert( { title: t( "office.lockedTitle" ), body: t( "office.lockedBody" ) } );
        var e = new Error( "Office file with a password" );
        e.said = true;
        throw e;
    }

    window.NayiveUI = {
        refuseOfficeLocked: refuseOfficeLocked,   // Write / Calc: an Office password file, said and refused
        loginRedirect:  loginRedirect,   // to the sign-in page and back here (AyniNet.loginRedirect too)
        signOut:        signOut,          // the launcher's and admin's sign-out ({ unlinkPhone, swScope })
        townName:   townName,      // the town at a position, "" when unknown (trips/public.html)
        applySheetButtons: applySheetButtons,
        applyHomeLinks:    applyHomeLinks,
        ensureRoom: ensureRoom,
        holdIntro: holdIntro,     // no help card / first-visit marks / install offer this load
        isShared:     isShared,
        sharedWithMe: sharedWithMe,   // everything shared WITH us, fetched once per page
        canAddTo:     canAddTo,
        sharedBadge:  sharedBadge,
        shareSheet:   shareSheet,
        jsonApi:         jsonApi,             // one JSON call to this server
        pickFolder:           pickFolder,
        pickFile:             pickFile,
        launcherFolder:       launcherFolder,
        changeLauncherFolder: changeLauncherFolder
    };
    window.AyniDocHost = window.NayiveUI;     // what a document needs from Nayive: the folder picker, sharing
} )();
