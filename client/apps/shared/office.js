// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * office.js - what the three document editors (Calc, Text, Write) share.
 *
 * Classic script, one global `NayiveOffice`. Load it deferred, after ui.js and
 * crypt.js (it calls NayiveUI and NayiveCrypt at run time, never while it is
 * parsed):
 *     <script src="../shared/ui.js" defer></script>
 *     <script src="../shared/crypt.js" defer></script>
 *     <script src="../shared/office.js" defer></script>
 *
 * Each editor used to carry its own copy of the same plumbing: the path
 * helpers, the "Abrir documento" folder browser, the click-to-rename file
 * label, the save-as folder row, the read-through-the-store hint toasts, the
 * phone "..." menu built from the real buttons and the "?" that moves into
 * the header on a phone.
 * This is the one copy (2026-09-06). Since 2026-09-11 the open document itself
 * is here too - its path, name and label, New / Import / "Guardar como" /
 * rename / Restore, start-up, the header plug and the autosave (see THE OPEN
 * DOCUMENT and AUTOSAVE), so the three look and behave the same. What stays per
 * app is only what really differs: how a body gets on and off the screen, and
 * each one's file-name rule (Write: always .docx; Calc keeps the extension on a
 * rename; Text never writes one it could not reopen).
 *
 * Paired CSS: the OFFICE CHROME block in shared/app.css (.file-label,
 * .open-crumb, .open-list, .folder-pick) and the "MORE" MENU block (.top-menu).
 */
( function ()
{
    "use strict";

    function byId( id ) { return document.getElementById( id ); }
    function t( k )     { return window.NayiveUI ? NayiveUI.t( k ) : k; }
    function tf( k, v ) { return window.NayiveUI ? NayiveUI.tf( k, v ) : k; }

    // ?new=1 - opened by New in a window of its own (newDocument): start blank,
    // never with a closed tab's draft. Dropped from the address at once, before
    // the page's load: the desktop remembers a window by its address then, and a
    // reload must find this window's own draft again.
    var START_NEW = ( function ()
    {
        try
        {
            var u = new URL( location.href );
            if( ! u.searchParams.has( "new" ) ) return false;
            u.searchParams.delete( "new" );
            history.replaceState( history.state, "", u.pathname + u.search + u.hash );
            return true;
        }
        catch ( e ) { return false; }
    } )();

    //------------------------------------------------------------------------//
    // PATHS

    function baseName( path ) { return NayiveUI.baseName( path ); }

    function dirName( path )
    {
        var p = String( path || "" ), i = p.lastIndexOf( "/" );
        return i > 0 ? p.slice( 0, i ) : "";
    }

    // "hoja.XLSX" -> "xlsx" (no dot, lower case); "" when there is none.
    function extOf( path ) { return NayiveUI.extOf( path ); }

    function byBaseName( a, b )
    {
        return baseName( a.path ).localeCompare( baseName( b.path ), window.NayiveUI ? NayiveUI.lang() : undefined );
    }

    // The label shown in the top bar for an opened file: its path minus the
    // folder the app was opened in (or the files/ root), else just the name.
    function relLabel( path, appDir, openRoot )
    {
        if( path.indexOf( appDir + "/" ) === 0 )   return path.slice( appDir.length + 1 );
        if( path.indexOf( openRoot + "/" ) === 0 ) return path.slice( openRoot.length + 1 );
        return baseName( path );
    }

    // A user-typed name reduced to a safe single filename: no path separators
    // (they would make folders, or escape the one the app is in), no leading
    // dots (a hidden file). "" when nothing usable is left.
    function safeName( raw )
    {
        return String( raw || "" ).trim().replace( /[\/\\]+/g, " " ).replace( /^\.+/, "" ).trim();
    }

    // The folder new documents go to. Drive opens an editor with ?dir=<folder>
    // (a path relative to the file root, e.g. "files/Cartas"); opened from the
    // launcher there is no ?dir= and documents go to the user's files/ root.
    function appDirFromUrl()
    {
        var raw = new URLSearchParams( location.search ).get( "dir" );
        var dir = raw ? raw.replace( /^\/+|\/+$/g, "" ) : "";
        return dir || "files";
    }

    //------------------------------------------------------------------------//
    // READ THROUGH THE STORE
    //
    // The network first, the last-known-good local copy when that fails, with
    // a hint toast when what came back is a cached copy. Returns { body,
    // source } - `body` is null when there is genuinely nothing to show and a
    // failed GET is never reported as "empty" (the old bug where the next save
    // wiped the real server copy).
    async function readViaStore( store, path, opts )
    {
        opts = opts || {};
        var res;
        try { res = await store.read( path ); }
        catch ( _ ) { res = { body: null, source: "unknown" }; }

        if( res.source === "cache" )
            NayiveUI.toast( t( navigator.onLine ? "ui.recovered" : "ui.localCopy" ) );
        else if( res.source === "empty" )
            NayiveUI.toast( t( opts.emptyKey || "ui.fileGone" ) );
        else if( res.source === "unauth" || res.source === "unknown" )
            NayiveUI.toast( t( opts.failKey || "ui.openFailed" ) );

        return { body: res.body != null ? res.body : null, source: res.source };
    }

    //------------------------------------------------------------------------//
    // THE FILE LABEL  -  click the name in the top bar to rename in place
    //
    //   var label = NayiveOffice.fileLabel( { onCommit: async function ( raw ) { ... } } );
    //   label.set( "carta.docx" );   label.get();
    //
    // Enter commits (through blur), Escape cancels. `onCommit( raw )` receives
    // the trimmed new text only when it differs from what was shown; the app
    // decides what a rename means (first save of an untitled doc, or a move).
    function fileLabel( opts )
    {
        opts = opts || {};
        var label = byId( opts.labelId || "fileLabel" );
        var input = byId( opts.inputId || "fileNameInput" );

        function set( text )                     // <bdi>: see .file-label in app.css
        {
            var bdi = document.createElement( "bdi" );
            bdi.textContent = text;
            label.replaceChildren( bdi );
        }
        function get()       { return label.textContent; }

        function start()
        {
            input.value = ( label.textContent === t( "ui.untitled" ) ) ? "" : label.textContent;
            label.style.display = "none";
            input.style.display = "";
            input.focus();
            input.select();
        }
        function cancel()
        {
            input.value = label.textContent;
            input.style.display = "none";
            label.style.display = "";
        }
        async function commit()
        {
            var raw = input.value.trim();
            input.style.display = "none";
            label.style.display = "";
            if( ! raw || raw === label.textContent ) return;
            if( opts.onCommit ) await opts.onCommit( raw );
        }

        label.addEventListener( "click", start );
        input.addEventListener( "blur", commit );
        input.addEventListener( "keydown", function ( e )
        {
            if( e.key === "Enter"  ) { e.preventDefault(); input.blur(); }
            if( e.key === "Escape" ) { e.preventDefault(); e.stopPropagation(); cancel(); }
        } );

        return { set: set, get: get, start: start };
    }

    //------------------------------------------------------------------------//
    // THE SAVE-AS FOLDER ROW  -  "where does this document go?"
    //
    // A document's FIRST save must ask for a folder, not silently drop the file
    // in the folder the app happens to have been opened in. The row is a button
    // that looks like a field control and opens NayiveUI.pickFolder:
    //
    //   <div class="field">
    //     <label data-i18n="ui.folder"></label>
    //     <button type="button" id="saveDirBtn" class="folder-pick">
    //       <span class="fp-btn-ic"></span><span id="saveDirName" class="fp-btn-nm"></span>
    //     </button>
    //   </div>
    //
    //   var dirField = NayiveOffice.folderField();   // + { btnId, nameId, dir }
    //   dirField.set( APP_DIR );   dirField.get();   // -> "files/Cartas"
    //
    // Paired CSS: the .folder-pick rule in the OFFICE CHROME block of app.css.

    // "files/Cartas/2026" -> "Archivos / Cartas / 2026" (the root segment is the
    // one the user sees in Drive, not the on-disk name).
    function dirLabel( dir )
    {
        var parts = String( dir || "files" ).split( "/" );
        parts[ 0 ] = t( "ui.filesRoot" );
        return parts.join( " / " );
    }

    function folderField( opts )
    {
        opts = opts || {};
        var btn  = byId( opts.btnId  || "saveDirBtn" );
        var name = byId( opts.nameId || "saveDirName" );
        var dir  = "files";

        function set( d )
        {
            dir = String( d || "files" ).replace( /^\/+|\/+$/g, "" ) || "files";
            name.textContent = dirLabel( dir );
        }

        if( btn.querySelector( ".fp-btn-ic" ) )
            btn.querySelector( ".fp-btn-ic" ).innerHTML = NayiveUI.icon( "folder" );

        // The picker builds its own id-less backdrop on top of the open save-as
        // sheet, so the suite's Escape rule leaves the sheet alone (it only ever
        // closes the top-most backdrop, and only when that one has an id).
        btn.addEventListener( "click", function ()
        {
            NayiveUI.pickFolder( { allowRoot: true, rootLabel: t( "ui.filesRoot" ) } )
                    .then( function ( picked ) { if( picked ) set( picked ); } );
        } );

        set( opts.dir );

        return { set: set, get: function () { return dir; } };
    }

    //------------------------------------------------------------------------//
    // RECENT DOCUMENTS  -  the last ten this app opened, on this device only
    //
    // One key per app in localStorage, so Write's list is not Calc's. A path
    // that no longer exists is NOT checked here (that would be a request per
    // row): opening it fails and says so, and the dead one drops off the list
    // as newer documents push it out.
    function recentFiles( app )
    {
        var KEY = "nayive-" + app + "-recent";
        var MAX = 10;

        function list()
        {
            try { return JSON.parse( localStorage.getItem( KEY ) || "[]" ); }
            catch ( e ) { return []; }
        }

        function add( path )
        {
            if( ! path ) return;

            try
            {
                var next = list().filter( function ( p ) { return p !== path; } );
                next.unshift( path );
                localStorage.setItem( KEY, JSON.stringify( next.slice( 0, MAX ) ) );
            }
            catch ( e ) {}
        }

        function remove( path )
        {
            try { localStorage.setItem( KEY, JSON.stringify( list().filter( function ( p ) { return p !== path; } ) ) ); }
            catch ( e ) {}
        }

        return { list: list, add: add, remove: remove };
    }

    //------------------------------------------------------------------------//
    // "ABRIR DOCUMENTO"  -  a plain folder browser over the user's files/
    //
    //   var browser = NayiveOffice.openBrowser( {
    //       backdropId: "openBackdrop",          // the .sheet-backdrop to open
    //       root:       OPEN_ROOT,               // never walks above this
    //       canOpen:    function ( path ) {...}, // which files are listed
    //       onOpen:     function ( path ) {...}, // a file was picked
    //       emptyKey:   "calc.noSheets",         // "nothing here" line
    //       recent:     function () {...},       // optional: paths for the "Recientes" rows
    //       offline:    async function () {...}  // optional: cached paths to list with no network
    //   } );
    //   browser.open( startDir );
    //
    // One level at a time; every breadcrumb segment jumps there. Above the
    // listing, the recent documents (when the page has a #openRecent box and
    // `recent` is given). Offline it shows the app's cached documents when
    // `offline` is given, else a note.
    function openBrowser( opts )
    {
        var crumb = byId( opts.crumbId || "openCrumb" );
        var list  = byId( opts.listId  || "openList" );
        var cwd   = opts.root;
        var seq   = 0;                       // drops a stale listing

        function row( iconName, label, isFolder )
        {
            var li = document.createElement( "li" );
            if( isFolder ) li.className = "is-folder";
            var ic = document.createElement( "span" );
            ic.className = "open-ic";
            ic.innerHTML = NayiveUI.icon( iconName );
            var nm = document.createElement( "span" );
            nm.className   = "open-nm";
            nm.textContent = label;
            li.appendChild( ic );
            li.appendChild( nm );
            return li;
        }

        function note( text )
        {
            var li = document.createElement( "li" );
            li.className   = "is-empty";
            li.textContent = text;
            return li;
        }

        function pick( path )
        {
            NayiveUI.close( opts.backdropId || "openBackdrop" );
            opts.onOpen( path );
        }

        async function render()
        {
            var mine = ++seq;

            crumb.className = "open-crumb";
            crumb.innerHTML = "";

            var parts = cwd.split( "/" );
            parts.forEach( function ( seg, i )
            {
                var path = parts.slice( 0, i + 1 ).join( "/" );
                var b = document.createElement( "button" );
                b.type        = "button";
                b.className   = "crumb-seg";
                b.textContent = i === 0 ? t( "ui.filesRoot" ) : seg;
                b.disabled    = ( path === cwd );
                b.addEventListener( "click", function () { cwd = path; render(); } );
                crumb.appendChild( b );
                if( i < parts.length - 1 )
                {
                    var sep = document.createElement( "span" );
                    sep.className   = "crumb-sep";
                    sep.textContent = "›";
                    crumb.appendChild( sep );
                }
            } );

            list.innerHTML = "";
            list.appendChild( note( t( "ui.loading" ) ) );

            var entries;
            try
            {
                if( ! navigator.onLine ) throw new Error( "offline" );
                var res = await GumApi.listDir( cwd );
                entries = ( res && res.nodes ) || [];
            }
            catch ( _ )
            {
                if( mine !== seq ) return;
                return renderOffline();
            }
            if( mine !== seq ) return;

            var folders = entries.filter( function ( n ) { return Array.isArray( n.nodes ) && baseName( n.path ).charAt( 0 ) !== "."; } ).sort( byBaseName );
            var files   = entries.filter( function ( n ) { return n.nodes === null && baseName( n.path ).charAt( 0 ) !== "." && opts.canOpen( n.path ); } ).sort( byBaseName );

            list.innerHTML = "";
            folders.forEach( function ( n )
            {
                var li = row( "folder", baseName( n.path ), true );
                li.addEventListener( "click", function () { cwd = n.path; render(); } );
                list.appendChild( li );
            } );
            files.forEach( function ( n )
            {
                var li = row( "doc", baseName( n.path ), false );
                li.addEventListener( "click", function () { pick( n.path ); } );
                list.appendChild( li );
            } );
            if( ! folders.length && ! files.length )
                list.appendChild( note( t( opts.emptyKey || "ui.nothingHere" ) ) );
        }

        // No network: the folder tree cannot be walked. List what the offline
        // store has (when the app can say), else just say so.
        async function renderOffline()
        {
            crumb.className = "open-crumb is-note";
            list.innerHTML  = "";

            var paths = null;
            if( opts.offline )
            {
                try { paths = await opts.offline(); } catch ( _ ) { paths = null; }
            }
            if( ! paths )
            {
                crumb.textContent = t( "ui.offlineBrowse" );
                return;
            }

            crumb.textContent = t( "ui.offlineLocalOnly" );
            paths.sort( function ( a, b ) { return a.localeCompare( b, NayiveUI.lang() ); } );
            paths.forEach( function ( p )
            {
                var rel = p.indexOf( opts.root + "/" ) === 0 ? p.slice( opts.root.length + 1 ) : p;
                var li  = row( "doc", rel, false );
                li.addEventListener( "click", function () { pick( p ); } );
                list.appendChild( li );
            } );
            if( ! paths.length ) list.appendChild( note( t( opts.emptyKey || "ui.nothingHere" ) ) );
        }

        // "Recientes", above the folder listing. Hidden while there is none.
        function renderRecent()
        {
            var box = byId( opts.recentId || "openRecent" );
            if( ! box ) return;

            var paths = opts.recent ? opts.recent() : [];

            box.innerHTML = "";
            box.hidden    = ! paths.length;
            if( ! paths.length ) return;

            // One drop-down, so the folder list below keeps the room. The first
            // option only names the box; picking any other opens that file.
            box.className = "field";
            var sel = document.createElement( "select" );
            var ph  = document.createElement( "option" );
            ph.value       = "";
            ph.textContent = t( "ui.recent" ) + "…";
            ph.disabled    = true;
            ph.selected    = true;
            sel.appendChild( ph );
            paths.forEach( function ( p )
            {
                var o = document.createElement( "option" );
                o.value       = p;
                o.textContent = baseName( p );
                o.title       = p;                             // the folder it is in
                sel.appendChild( o );
            } );
            sel.addEventListener( "change", function () { if( sel.value ) pick( sel.value ); } );
            box.appendChild( sel );
        }

        function open( startDir )
        {
            cwd = startDir || opts.root;
            NayiveUI.open( opts.backdropId || "openBackdrop" );
            renderRecent();
            render();
        }

        return { open: open };
    }

    //------------------------------------------------------------------------//
    // PHONE CHROME
    //
    // On a phone the editors keep one row of favourite controls and move their
    // file buttons behind the header's "..." (a .top-menu built from the REAL
    // buttons - glyph and title cloned - so it never drifts from the toolbar:
    // an entry just clicks the button it came from). The "?" moves into the
    // header too, because the row it lives in folds away while you type.

    // Build the menu entries and wire the popup. `ids` are the buttons to
    // mirror; the menu is the .top-menu element, the button the header "...".
    // `phoneOnly` names the ids that are still ON the bar on a PC (Write's
    // print, page setup, comments...): they are built all the same, so the
    // phone has them when the bar is gone, and CSS drops them above 640px so
    // a PC is never offered the same thing twice (.mi-phone in app.css).
    //
    // The same builder serves the "?" - its Ayuda menu is three hidden buttons
    // mirrored exactly like the file ones - so it is exported twice: fileMenu
    // for the header "...", buttonMenu for anything else.
    function buttonMenu( opts )
    {
        var menu  = byId( opts.menu || "topMenu" );
        var phone = opts.phoneOnly || [];
        ( opts.ids || [] ).forEach( function ( id )
        {
            var src = byId( id );
            var svg = src && src.querySelector( "svg" );
            if( ! svg ) return;
            var item = document.createElement( "button" );
            item.type         = "button";
            item.className    = "menu-item" + ( phone.indexOf( id ) >= 0 ? " mi-phone" : "" );
            item.dataset.menu = id;
            item.appendChild( svg.cloneNode( true ) );
            item.appendChild( document.createTextNode( src.getAttribute( "title" ) || id ) );
            menu.appendChild( item );
        } );
        return NayiveUI.wireMenu( { btn: opts.btn || "moreBtn", menu: menu, onPick: function ( item )
        {
            var src = item.dataset.menu && byId( item.dataset.menu );
            if( src ) src.click();
        } } );
    }

    //------------------------------------------------------------------------//
    // TOOLBAR GROUP POPUP  (paired CSS: TOOLBAR GROUP POPUP in shared/app.css)
    //
    // Six alignment buttons in a row cost six slots and read as one blur. One
    // button takes their place on the bar and the six live in a .popup card
    // under it. The buttons in that card are THE REAL ONES - they sit inside
    // the popup in index.html, they keep their ids, their handlers and their
    // "active" light. Nothing is cloned and nothing is moved at run time, so
    // there is no flash on load and no second copy to keep in step.
    //
    //   var g = NayiveOffice.groupPopup( { btn: "fmtAlignBtn", popup: "alignPopup",
    //                                      activeFrom: [ "fmtWrapBtn" ] } );
    //
    //   btn         the trigger already in the markup, carrying .has-popup
    //   popup       the .popup element holding the real buttons
    //   activeFrom  ids whose "active" lights the TRIGGER too, so a toggle that
    //               is on can be seen with the card shut. Left out: never lit.
    //   anchor      () -> a DOMRect to hang the card from, when the trigger
    //               itself is collapsed (menu chrome). Default: the trigger.
    //
    // Returns { open, close, isOpen, sync }. Call sync() from wherever the app
    // refreshes its toolbar state.
    function groupPopup( opts )
    {
        var btn = typeof opts.btn   === "string" ? byId( opts.btn )   : opts.btn;
        var pop = typeof opts.popup === "string" ? byId( opts.popup ) : opts.popup;
        if( ! btn || ! pop ) return null;

        var watch = ( opts.activeFrom || [] ).map( byId ).filter( Boolean );

        function isOpen() { return pop.classList.contains( "open" ); }

        function close()
        {
            if( ! isOpen() ) return;
            pop.classList.remove( "open" );
            btn.setAttribute( "aria-expanded", "false" );
        }

        function open()
        {
            var r = opts.anchor ? opts.anchor() : btn.getBoundingClientRect();
            pop.style.top  = ( r.bottom + 4 ) + "px";
            pop.style.left = r.left + "px";
            pop.classList.add( "open" );

            // nudge back inside the viewport when the trigger sits near an edge
            var pr = pop.getBoundingClientRect();
            if( pr.right > window.innerWidth - 8 )
                pop.style.left = Math.max( 8, window.innerWidth - 8 - pr.width ) + "px";

            btn.setAttribute( "aria-expanded", "true" );
        }

        // The trigger lights up when one of its toggles is on, so "ajustar
        // texto" can be seen without opening the card.
        function sync()
        {
            if( ! watch.length ) return;
            btn.classList.toggle( "active", watch.some( function ( el )
            {
                return el.classList.contains( "active" ) || el.classList.contains( "is-active" );
            } ) );
        }

        btn.addEventListener( "click", function ( e )
        {
            e.stopPropagation();
            if( isOpen() ) close(); else open();
        } );

        // Pressing inside the card must not take focus off the document: Calc
        // would lose the cell selection the button is about to format.
        pop.addEventListener( "mousedown", function ( e )
        {
            if( ! e.target.closest( "input, select, textarea" ) ) e.preventDefault();
        } );

        // Every button in there is an action - it closes behind itself. The
        // button's own handler runs as usual; this only shuts the card.
        pop.addEventListener( "click", function ( e )
        {
            if( e.target.closest( "button" ) ) close();
        } );

        document.addEventListener( "click", function ( e )
        {
            if( isOpen() && ! pop.contains( e.target ) && ! btn.contains( e.target ) ) close();
        } );
        document.addEventListener( "keydown", function ( e ) { if( e.key === "Escape" ) close(); } );
        window.addEventListener( "resize", close );

        btn.setAttribute( "aria-haspopup", "true" );
        btn.setAttribute( "aria-expanded", "false" );
        sync();

        return { open: open, close: close, isOpen: isOpen, sync: sync };
    }

    // The "?" is the SAME button in both layouts - a second copy would break
    // the coach marks, which point at the first [data-intro-open] on the page.
    // `phone` -> append it to phoneHost (last, as in every other header);
    // else put it back in pcHost, before `before` (or last).
    // `before` / `headerBefore` name an element to put the "?" IN FRONT OF,
    // wherever that element happens to live - the header row has no container of
    // its own, so the anchor's parent is used. In the header the "?" belongs
    // after the two chrome buttons and before the sync dot.
    function placeHelpButton( phone, phoneHost, pcHost, before, headerBefore )
    {
        var help = document.querySelector( "[data-intro-open]" );
        if( ! help ) return;

        var anchor = headerBefore && byId( headerBefore );

        if( phone && anchor ) anchor.parentNode.insertBefore( help, anchor );
        else if( phone ) byId( phoneHost ).appendChild( help );
        else if( before && byId( before ) ) byId( pcHost ).insertBefore( help, byId( before ) );
        else byId( pcHost ).appendChild( help );
    }

    // THE PHONE CHROME of Write and Calc - at start-up and whenever the phone is
    // turned; the split itself is CSS, this is only what CSS cannot do. The "?"
    // and the File button (#moreBtn) are the SAME buttons in both layouts: on a
    // phone they go up into the header (#topActions), because the tool row folds
    // away while you type - the "?" never in menu mode (`o.menus()`), where the
    // Ayuda menu is right there; on a PC the "?" goes back into `o.tools`
    // (before `o.helpBefore`, or last) and the File button in front of #fileSep.
    // `o.fileClass( btn, phone )` gives the File button its look. Then every
    // menu and popup `o.close()` lists is shut, the "..." expansion folded, and
    // on a PC the row unfolded (`o.fold()`: null while it is not made yet).
    function phoneChrome( phone, o )
    {
        placeHelpButton( phone && ! o.menus(), "topActions", o.tools, o.helpBefore, "savedAt" );

        var btn = byId( "moreBtn" ), sep = byId( "fileSep" );
        if( phone ) byId( "topActions" ).appendChild( btn );
        else        sep.parentNode.insertBefore( btn, sep );
        o.fileClass( btn, phone );

        o.close().forEach( function ( m ) { if( m ) m.close(); } );
        var fold = o.fold();
        if( fold ) fold.setMore( false );
        if( fold && ! phone ) fold.setOpen( true );
    }

    // The folding toolbar: "Aa" (#fmtBtn) folds the whole row away while you
    // type, "..." (#moreToolsBtn) opens the rest of it in place. Folding sets
    // height: 0 through .is-folded, never display: none - the editors measure
    // that row. opts.afterChange runs after either change (Calc re-measures
    // the grid).
    function foldingToolbar( opts )
    {
        var bar   = byId( opts.toolbar );
        var fmt   = byId( opts.fmtBtn || "fmtBtn" );
        var more  = byId( opts.moreToolsBtn || "moreToolsBtn" );
        var isOpen = true;

        function setMore( open )
        {
            bar.classList.toggle( "is-open", !! open );
            more.setAttribute( "aria-expanded", String( !! open ) );
            if( opts.afterChange ) opts.afterChange();
        }
        function setOpen( open )
        {
            isOpen = !! open;
            bar.classList.toggle( "is-folded", ! isOpen );
            if( ! isOpen ) setMore( false );
            fmt.classList.toggle( "is-active", isOpen );
            fmt.setAttribute( "aria-expanded", String( isOpen ) );
            if( opts.afterChange ) opts.afterChange();
        }

        fmt.addEventListener( "click", function () { setOpen( ! isOpen ); } );
        more.addEventListener( "click", function () { setMore( more.getAttribute( "aria-expanded" ) !== "true" ); } );
        setOpen( true );

        return { setOpen: setOpen, setMore: setMore, isOpen: function () { return isOpen; } };
    }

    //------------------------------------------------------------------------//
    // AUTOSAVE  -  the one save pipeline of Calc, Text and Write
    //
    //   var saver = NayiveOffice.autosave( {
    //       app:      "calc",                                // key of this app's device draft
    //       store:    store,                                 // a NayiveStore made with { conflicts: true }
    //       path:     function () { return currentPath; },   // null = untitled
    //       readOnly: function () { return readOnly; },      // someone else's file: never written
    //       name:     function () { return pendingName; },   // the name a draft is kept under
    //       encode:   async function ( path ) { ... },       // the body, bytes or text (path null = for the draft)
    //       blocked:  function ( path ) { ... },             // optional: true = do not write it now
    //       failKey:  "calc.saveFileFailed",                 // optional: toast when encode() throws
    //       setSync:  setSyncStatus,                         // the header plug
    //       saveAs:   openSaveAs                             // "Guardar como"
    //   } );
    //
    //   saver.edited()            the user changed the document
    //   saver.flush()             save what is waiting, now (before a swap or a rename)
    //   saver.idle()              resolves when no save is running
    //   saver.saveNow()           Ctrl+S
    //   saver.saveTo( path )      "Guardar como": write there; the app then makes it the open doc
    //   saver.opened( o )         another document is on screen; o.pristine = imported bytes, o.dirty
    //   saver.moved( from, to )   the open document was renamed
    //   saver.bakTaken( path )    its .bak was just written by hand (Restore's Undo): no copy over it this session
    //   saver.dirty()             edited since it was opened or last saved
    //   saver.takeDraft()         at boot: this tab's device draft, or a closed tab's -> { name, body, at } or null
    //   saver.restored( d )       the app has put that draft on screen
    //   saver.dropDraft()         the user threw the untitled document away
    //   saver.pristine()          the imported bytes still waiting to be the first .bak
    //   saver.lock()              the open document's key, or null
    //   saver.setLock( l )        this document is (not) locked - no writing
    //   saver.lockDoc( l )        put a password on: also frees the plain .bak
    //   saver.unlockDoc()         take it off: puts the sealed .bak back in the clear
    //
    // What it does:
    //   - saves 7 s after the last edit, and at least every 3 min while typing
    //   - a document with nowhere to save to (untitled, or someone else's) goes
    //     to a DRAFT on this device only - IndexedDB "nayive-drafts", one per
    //     app and tab (ONE DRAFT PER TAB below), never the store's own
    //     database (bumping its version would block on another open tab and
    //     silently turn the store online-only). The
    //     session asks an untitled one for its name and folder at the first
    //     pause after its first edit; that save drops the draft.
    //   - a document with a password (see THE PADLOCK) is encrypted on the one
    //     road out of here - the server file, its .bak and the device draft
    //   - one .bak/<name> beside the document: the server's copy from before
    //     the document's first save in this session
    //   - "Guardado 12:04" / "Borrador 12:04" in #savedAt
    //   - a file saved from another device since it was opened: the store gets
    //     a 412, keeps the edits here, and the user is offered a copy
    //   - closing the tab asks only while something is NOT safe yet: a save
    //     waiting or running, one that was refused, or edits the app holds
    //     back (Calc's loss gate - those are in the device draft meanwhile)
    //   - a desktop window asks its page before it closes (settle, and the
    //     session's window.nayiveBeforeClose): what waits is kept first
    //
    // Paired CSS: .saved-at in the OFFICE CHROME block of app.css.

    var SAVE_DELAY_MS    = 7000;          // quiet time after the last edit
    var SAVE_MAX_WAIT_MS = 3 * 60000;     // longest an edit waits while typing goes on

    // The server's copy from before a session's first save lives here.
    function bakPath( path ) { return ( dirName( path ) || "files" ) + "/.bak/" + baseName( path ); }

    // ---- the device draft store ---------------------------------------------

    // "nayive-drafts" (GumApi.draftsDb). draftTx: fn( objectStore ) -> request;
    // resolves with its result, null on any failure.
    var drafts = GumApi.draftsDb();

    function draftTx( mode, fn ) { return drafts.tx( mode, fn ); }

    // The account this page belongs to, as store.js read it at load ("" = unknown).
    function draftWho() { return ( window.NayiveStore && NayiveStore.me ) || ""; }

    // THE PAGE'S OWNER IS STILL THE ONE SIGNED IN (L5, office #14). The
    // editor's side calls - the .bak's read and write, rename, the clean
    // copy's delete and purge - go through GumApi with whatever session the
    // browser holds NOW. A tab left open after another account signed in on
    // this browser would read THAT account's .bak, write into its home and
    // delete its file. So they run only while the "nayive_who" cookie still
    // names this page's owner. Unknown either way (no cookie): as before.
    // (NayiveI18n.whoNow: shared/i18n.js WHOSE PAGE, loaded first.)
    function ownerHere()
    {
        var me = draftWho();
        if( ! me ) return true;
        var now = NayiveI18n.whoNow();
        return ! now || now === me;
    }

    // ---- ONE DRAFT PER TAB ----------------------------------------------------
    //
    // Each tab keeps its own draft, keyed "<app>:<tab id>" - until 2026-09-28
    // the key was the app's name alone, so two untitled documents in two tabs
    // wrote over each other. The id lives in sessionStorage, so a reload of
    // the tab finds its draft again. While the tab lives it holds a Web Lock
    // named after the key: "Duplicate tab" copies sessionStorage, and an id
    // whose lock is already taken is another live tab's - the copy gets a new
    // one. A draft whose lock nobody holds is an ORPHAN (its tab was closed):
    // the next tab of that app with no draft of its own takes it over (the
    // saver's takeDraft). The old bare "<app>" key is an orphan too - that is
    // its migration.

    var DRAFT_ORPHAN_MS = 90 * 86400000;   // an orphan this old is dropped - unless it is the one coming back

    var draftKeys = {};                    // app -> Promise<{ key, release }> - this tab's key and its lock

    function newTabId() { return Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 8 ); }

    // The lock's release() when this tab now holds it (for as long as it
    // lives, or until release), null when another tab has it. No Web Locks in
    // this browser: a do-nothing release, and no tab is ever known to be alive.
    function holdLock( name )
    {
        return GumApi.tryLock( name, true ).catch( function () { return function () {}; } );
    }

    // id: the one to try first (null = a fresh one).
    async function claimDraftKey( app, id )
    {
        // A taken id = a duplicated tab: a fresh one (a clash of those is
        // next to impossible, but it is not left to chance).
        var release = null;
        for( var i = 0; i < 3 && ! release; i++ )
        {
            if( ! id ) id = newTabId();
            release = await holdLock( "nayive-draft:" + app + ":" + id );
            if( ! release ) id = null;
        }
        if( ! id ) id = newTabId();

        try { sessionStorage.setItem( "nayive-draft-tab:" + app, id ); } catch ( e ) {}
        return { key: app + ":" + id, release: release || function () {} };
    }

    function draftKey( app )
    {
        if( ! draftKeys[ app ] )
        {
            var id = null;
            try { id = sessionStorage.getItem( "nayive-draft-tab:" + app ); } catch ( e ) {}
            draftKeys[ app ] = claimDraftKey( app, id );
        }
        return draftKeys[ app ].then( function ( t ) { return t.key; } );
    }

    // This tab's key holds ANOTHER account's draft (someone else signed in
    // here, in this same tab): leave it for its owner - its lock let go, so it
    // is an orphan now - and take a fresh key.
    function newDraftKey( app )
    {
        var old = draftKeys[ app ];
        draftKeys[ app ] = ( async function ()
        {
            var t = old && await old;
            if( t ) t.release();
            return claimDraftKey( app, null );
        } )();
        return draftKeys[ app ].then( function ( t ) { return t.key; } );
    }

    // The draft keys whose tab is open now; null = not known (no Web Locks).
    function liveDraftKeys()
    {
        return GumApi.heldLocks( "nayive-draft:" ).catch( function () { return null; } );
    }

    function hhmm( at )
    {
        var d = new Date( at );
        return NayiveUI.pad2( d.getHours() ) + ":" + NayiveUI.pad2( d.getMinutes() );
    }

    // ---- the saver ----------------------------------------------------------

    function autosave( o )
    {
        var timer    = null;
        var since    = 0;           // when the oldest edit still waiting was made (0 = none)
        var busy     = 0;           // saves / drafts running
        var seq      = 0;           // a newer save wins over an older one still encoding
        var dirty    = false;       // edited since opened or last saved
        var failed   = false;       // the last real save was refused (or held back as a conflict)
        var drafted  = false;       // THIS document is the one in the device draft
        var askedFor = null;        // the conflict was already offered for this path
        var savingAs = false;       // inside saveTo(): no conflict dialog on top of "Guardar como"
        var pristine = null;        // imported bytes: the .bak when the server has no copy yet
        var backedUp = new Set();   // paths already copied to .bak/ this session
        var lock     = null;        // set = this document is written encrypted (shared/crypt.js)
        var held     = false;       // the app will not have it written now (Calc's loss gate): its edits go to the device draft
        var gen      = 0;           // which document is on screen (opened() counts them)
        var draftOk  = true;        // the last device draft of THIS document was written
        var waiters  = [];          // idle(): resolved when nothing is running any more
        var slotQ    = Promise.resolve();   // one device-draft write at a time (keepDraft / dropDraft)
        var fresh    = new Set();   // names saved create-only (D6) whose file the server has not confirmed yet
        var onlyHere = false;       // the last save is kept only in this page (the store's pageOnly)

        draftKey( o.app );          // this tab's draft key and its lock, from the start: the tab counts as open

        function sync( s )  { if( o.setSync ) o.setSync( s ); }
        function path()     { return o.path(); }
        function writable() { return !! path() && ! o.readOnly(); }

        // busy-- and, at zero, wake whoever waits for idle().
        function done()
        {
            busy--;
            if( busy ) return;
            var w = waiters;
            waiters = [];
            w.forEach( function ( f ) { f(); } );
        }
        function idle() { return busy ? new Promise( function ( r ) { waiters.push( r ); } ) : Promise.resolve(); }

        // The device-draft slot is read, maybe moved and written in one go:
        // two drafts of one tab must not both decide the slot is someone else's.
        function inSlot( fn )
        {
            var p = slotQ.then( fn );
            slotQ = p.catch( function () {} );
            return p;
        }

        function stamp( key, at, note )
        {
            var el = byId( o.savedAtId || "savedAt" );
            if( ! el ) return;
            el.textContent = key ? tf( key, { time: hhmm( at ) } ) : "";
            el.title       = note || "";
        }

        // The timer: SAVE_DELAY_MS after the last edit, but never later than
        // SAVE_MAX_WAIT_MS after the first one that is still waiting - someone
        // typing without a pause still gets a save every few minutes.
        function arm()
        {
            var now = Date.now();
            if( ! since ) since = now;
            clearTimeout( timer );
            timer = setTimeout( run, Math.max( 0, Math.min( SAVE_DELAY_MS, since + SAVE_MAX_WAIT_MS - now ) ) );
        }

        function run()
        {
            clearTimeout( timer );
            timer = null;
            since = 0;
            return writable() && ! held ? writeTo( path() ) : keepDraft();
        }

        function edited()
        {
            dirty = true;

            if( writable() )
            {
                // The app decides (Calc's loss gate, which asks by itself). A
                // document it holds back is not written - but its edits still
                // go to the device draft, or they lived only in memory and a
                // close lost them with no question (held makes closing ask).
                held = !! ( o.blocked && o.blocked( path() ) );
                if( ! held ) sync( navigator.onLine ? "saving" : "offline" );
            }
            else if( ! path() ) sync( "unsaved" );              // nothing on the server to save TO yet

            arm();
        }

        function flush() { return timer ? run() : Promise.resolve(); }

        // Keys typed while something else was awaited (a file coming down for
        // Open) went into the document still on screen: saved now, round after
        // round while typing goes on - the caller is about to replace that
        // document, and opened() drops a waiting timer with its edits.
        async function catchUp()
        {
            for( var i = 0; timer && i < 10; i++ ) await run();
        }

        // Nothing on screen is only on screen: it is on the server, queued in
        // the store's outbox, or in the device draft - and nothing is waiting,
        // running or refused.
        function kept()
        {
            if( timer || busy || failed ) return false;
            return ( writable() && ! held ) || ! dirty || ( drafted && draftOk );
        }

        // ...and nothing is held back either (in the draft, never in the file).
        function safe() { return kept() && ! held; }

        // The page is about to be removed with no beforeunload and no time for
        // pagehide's flush (a desktop window's close). What waits goes NOW, an
        // edit with no timer behind it (an import, a template, a draft that
        // failed) gets its device draft, and what is on its way is waited for,
        // up to `ms` - a PUT has no time limit of its own. True = safe().
        async function settle( ms )
        {
            var all = ( async function ()
            {
                await catchUp();
                if( dirty && ( ! writable() || held ) && ! ( drafted && draftOk ) ) await keepDraft();
                await idle();
                return true;
            } )();
            var late = new Promise( function ( r ) { setTimeout( function () { r( false ); }, ms ); } );
            return ( await Promise.race( [ all, late ] ) ) && safe();
        }

        // ---- the password ----------------------------------------------------
        //
        // A locked document is encrypted HERE, on the one road out of the
        // editor - the server file, the .bak beside it and the device draft all
        // go through it, so none of them can be left in the clear by accident.
        // The key only ever lives in this closure: a reload asks again.

        function sealed( body )
        {
            return lock ? NayiveCrypt.seal( lock, body ) : Promise.resolve( body );
        }

        // Put a password on the open document. The .bak beside it is the copy
        // from BEFORE the password - plain - so it is dropped from the "already
        // taken" set: the next save reads the server copy, seals it, and writes
        // it over that one.
        function lockDoc( l )
        {
            lock = l;
            if( path() ) backedUp.delete( path() );
        }

        // Take it off. The .bak is sealed and we are about to throw the only key
        // away, so it is put back in the clear first - with no key it would be a
        // "previous copy" nobody could ever restore.
        // False = refused, nothing changed: another account is signed in on
        // this browser now (L5) - the .bak it would put back is not ours to read.
        async function unlockDoc()
        {
            var p   = path();
            var old = lock;
            if( p && old && ! ownerHere() ) return false;
            lock = null;
            if( ! p || ! old ) return true;

            try
            {
                var prev = await GumApi.readFileBytes( bakPath( p ) );
                if( prev && prev.length && NayiveCrypt.looksLocked( prev ) )
                {
                    var plain = await NayiveCrypt.unseal( old, prev );
                    await GumApi.writeFileBytes( bakPath( p ),
                        typeof plain === "string" ? new TextEncoder().encode( plain ) : plain );
                }
            }
            catch ( e ) { /* no .bak, or it cannot be read: nothing to put back */ }

            // Either way, never take a NEW one from the server this session: the
            // copy up there is still sealed until the save that follows.
            backedUp.add( p );
            return true;
        }

        // how: "create" - a name this page did not mean to write over (Save
        // as / the first save onto a name that was free or could not be
        // checked: D6): written only where there is no file; "replace" - the
        // user said "Replace" to a file that is there. See store.js
        // CREATE-ONLY AND REPLACE.
        async function writeTo( p, how )
        {
            // Not written now (the app's gate). The open document's edits go
            // to the device draft instead (see edited) - Ctrl+S included.
            if( o.blocked && o.blocked( p ) )
            {
                if( p !== path() ) return null;
                held = true;
                return keepDraft();
            }

            var mine = ++seq;
            busy++;
            try
            {
                sync( "saving" );

                var body;
                try { body = await sealed( await o.encode( p ) ); }
                catch ( e )
                {
                    if( mine === seq )
                    {
                        failed = true;
                        sync( "error" );
                        NayiveUI.toast( t( lock ? "lock.failed" : ( o.failKey || "ui.saveFailed" ) ) );
                    }
                    return null;
                }
                if( mine !== seq ) return null;        // a newer save started meanwhile - it wins

                await backup( p, how );
                if( mine !== seq ) return null;

                if( how === "create" ) fresh.add( p );
                if( how === "replace" ) fresh.delete( p );
                var res = ( await o.store.write( p, body, how === "create" ? { createOnly: true }
                                                         : how === "replace" ? { replace: true } : undefined ) ) || {};
                if( res.ok === true ) fresh.delete( p );     // the file there is ours now
                if( mine !== seq ) return res;

                onlyHere = false;
                if( res.conflict )
                {
                    failed = true;
                    offerCopy( p );
                    return res;
                }

                // Offline / queued / needs-auth all keep the body safe on this
                // device (the store's cache + outbox): saved, from the user's side.
                // Only a hard refusal is a failure - and so is a save kept only
                // in this page (the browser's storage failed) or one that
                // vanished before it was sent: neither is "Saved" (K2, K5).
                failed = res.ok === false && ! res.offline && ! res.needsAuth && ! res.otherAccount;
                if( res.forbidden ) NayiveUI.toast( t( "ui.saveFailed" ) );
                if( res.pageOnly )
                {
                    // The store goes on trying (and says so in a toast): the
                    // screen says it here too, until it is up (onSaved below).
                    onlyHere = true;
                    stamp( "write.pageOnlyAt", Date.now(), t( "ui.store.pageOnly" ) );
                }
                else if( res.unknown )
                {
                    stamp( null );
                    NayiveUI.toast( t( "write.notSaved" ), { ms: 6000 } );
                }
                if( ! failed )
                {
                    if( ! timer ) dirty = false;       // an edit made meanwhile is still waiting
                    held = false;                      // written ("Save anyway", a copy): not held any more
                    if( drafted ) dropDraft();         // the edits it held are in the store now
                    stamp( "write.savedAt", Date.now() );
                }
                return res;
            }
            finally { done(); }
        }

        async function keepDraft()
        {
            var mine = ++seq;
            var g    = gen;
            busy++;
            try
            {
                var body;
                try { body = await sealed( await o.encode( null ) ); }
                catch ( e ) { if( g === gen ) draftOk = false; return null; }
                if( mine !== seq ) return null;

                var at  = Date.now();
                var put = await inSlot( async function ()
                {
                    var key = await ownDraftKey();

                    // The slot still holds ANOTHER document's body - an unnamed
                    // one that Open, Import or New took off the screen, or edits
                    // to someone else's document. Never written over: it stays,
                    // and becomes an orphan the next tab of this app takes
                    // over (takeDraft); this document gets a key of its own.
                    if( ! drafted || g !== gen )
                    {
                        var had = await draftTx( "readonly", function ( os ) { return os.get( key ); } );
                        if( had && had.body != null ) key = await newDraftKey( o.app );
                    }

                    var ok = await draftTx( "readwrite", function ( os )
                    {
                        return os.put( { app: key, name: ( o.name && o.name() ) || null, body: body, at: at,
                                         who: draftWho() } );
                    } );
                    if( ok && g === gen ) drafted = true;     // the slot is this document's now
                    return ok;
                } );
                if( g === gen ) draftOk = !! put;
                if( put && mine === seq ) stamp( "ui.draftAt", at, t( "ui.draftNote" ) );
                return null;
            }
            finally { done(); }
        }

        // One copy of the server's version per document per session, taken
        // before the first save - not on every save, or .bak would just follow
        // the live document and be worthless as "the previous version". Best
        // effort: skipped offline; when there is no server copy yet (the first
        // save of an import) the imported original is used.
        // how: writeTo's. A create-only save (D6) that finds a file there will
        // not write over it - nor over the .bak beside it, which is THAT
        // file's previous copy: no .bak now (taken if the user says Replace).
        async function backup( p, how )
        {
            // Another account signed in on this browser now (L5): its .bak is
            // not ours to read or write. Not taken now; the save itself goes
            // to the store, which keeps it for this page's owner (423).
            if( backedUp.has( p ) || ! navigator.onLine || ! ownerHere() ) return;

            try
            {
                // No server copy yet (404) = the imported original. Any other
                // failure is thrown to the catch below: no .bak now, and the
                // next save tries again - not "nothing to keep" for the session.
                var prev = null;
                try { prev = await GumApi.readFileBytes( p ); }
                catch ( e )
                {
                    if( ! e || e.status !== 404 ) throw e;
                    prev = pristine;
                }
                if( how === "create" && prev !== pristine ) return;     // another's file is there

                // The server copy of a locked document is already sealed;
                // imported bytes never are. Either way what lands in .bak/ is
                // what the document itself is, so a reader needs the same key.
                if( prev && prev.length && lock && ! NayiveCrypt.looksLocked( prev ) )
                    prev = await NayiveCrypt.seal( lock, prev );

                if( prev && prev.length )
                {
                    // The document can sit in any folder ("Guardar como" asks for
                    // one), so make its .bak/ first. Already there = a harmless refusal.
                    try { await GumApi.makeDir( dirName( p ) || "files", ".bak" ); } catch ( e ) {}
                    await GumApi.writeFileBytes( bakPath( p ),
                        typeof prev === "string" ? new TextEncoder().encode( prev ) : prev );
                }

                backedUp.add( p );     // taken, or nothing to take - not again this session
                pristine = null;
            }
            catch ( e ) { /* the copy failed - try again on the next save */ }
        }

        // Saved from another device since it was opened. The store keeps our
        // version here and will not send it; the way out is a copy of our own.
        async function offerCopy( p )
        {
            sync( "conflict" );
            if( savingAs || askedFor === p ) return;
            askedFor = p;

            // Not "changed since": a name saved create-only (D6) was taken
            // on the server meanwhile - Replace it, or keep both (o.taken).
            if( fresh.has( p ) && o.taken ) { o.taken( p ); return; }

            var copy = await NayiveUI.confirm( {
                title:   t( "ui.conflictTitle" ),
                body:    tf( "ui.conflictBody", { name: baseName( p ) } ),
                confirm: t( "ui.conflictCopy" ),
                cancel:  t( "ui.notNow" ) } );

            if( copy && p === path() ) o.saveAs();
        }

        function saveNow()
        {
            if( o.readOnly() ) { NayiveUI.toast( t( "text.notYours" ) ); o.saveAs(); return; }
            if( ! path() )     { o.saveAs(); return; }

            askedFor = null;                  // a deliberate save may ask about a conflict again
            clearTimeout( timer );
            timer = null;
            since = 0;
            return writeTo( path() );
        }

        // how: as writeTo's ("create" for a name nobody said "Replace" to).
        async function saveTo( p, how )
        {
            savingAs = true;
            try
            {
                await flush();                // what is waiting goes to the OLD place first
                var from = path();

                // Another document's file is about to be written over (the user
                // said "replace"): what it holds now gets its own .bak, even when
                // that name was already saved to earlier in this session.
                if( from !== p ) backedUp.delete( p );

                var res  = await writeTo( p, how );

                if( ! res || failed ) return res;

                if( drafted ) dropDraft();

                // Our copy of a conflicted file is now safe under the new name:
                // drop the held-back write, so theirs is what the old name shows.
                if( from && from !== p && await o.store.conflicted( from ) )
                {
                    await o.store.forget( from );
                    await o.store.resting();
                }
                return res;
            }
            finally { savingAs = false; }
        }

        function opened( x )
        {
            x = x || {};
            clearTimeout( timer );
            timer    = null;
            since    = 0;
            gen++;
            dirty    = !! x.dirty;
            failed   = false;
            held     = false;
            draftOk  = true;
            drafted  = false;           // the slot may still hold the last document: keepDraft leaves it be
            askedFor = null;
            pristine = x.pristine || null;
            stamp( null );

            // Reopened with an edit still held back as a conflict: say so now.
            var p = path();
            if( p && ! o.readOnly() )
                o.store.conflicted( p ).then( function ( c ) { if( c && p === path() ) offerCopy( p ); } );
        }

        function moved( from, to ) { if( backedUp.has( from ) ) backedUp.add( to ); }

        // "Replace" to a name saved create-only and found taken (o.taken): the
        // file there gets its own .bak first, then this document goes over it.
        function replaceAt( p )
        {
            backedUp.delete( p );
            askedFor = null;
            failed   = false;
            clearTimeout( timer );
            timer = null;
            since = 0;
            return writeTo( p, "replace" );
        }

        // ---- the device draft -----------------------------------------------

        // This tab's draft key - never one that holds another account's draft
        // (a sign-in as someone else in this tab): that one gets a new key, so
        // nothing here writes over or drops it.
        async function ownDraftKey()
        {
            var key = await draftKey( o.app );
            var who = draftWho();
            var r   = await draftTx( "readonly", function ( os ) { return os.get( key ); } );
            return r && r.who && who && r.who !== who ? newDraftKey( o.app ) : key;
        }

        // The untitled document of an earlier visit. No question here: the
        // session puts it back on screen and asks for its name.
        //
        // This tab's own draft first (a reload). With none, the newest ORPHAN of
        // this app - a closed tab's, or the old one-per-app draft - is taken
        // over: moved to this tab's key in the same transaction, so two tabs
        // opening at once cannot both get it. The other orphans stay for the
        // next tab; those older than DRAFT_ORPHAN_MS are dropped on the way.
        // Another account's draft on this browser is never offered or touched
        // (store.js, WHOSE SAVE).
        async function takeDraft()
        {
            var key  = await ownDraftKey();
            var live = await liveDraftKeys();
            var who  = draftWho();
            var now  = Date.now();

            var d = await draftTx( "readwrite", function ( os )
            {
                var out = { result: null };      // draftTx resolves with .result once the transaction is done
                var all = os.getAll();
                all.onsuccess = function ()
                {
                    var own = null, orphans = [];

                    ( all.result || [] ).forEach( function ( r )
                    {
                        if( r.app !== o.app && String( r.app ).indexOf( o.app + ":" ) !== 0 ) return;   // another app's
                        if( r.app === key ) { own = r; return; }
                        if( live && live.has( r.app ) ) return;                  // its tab is open
                        if( r.who && who && r.who !== who ) return;             // another account's
                        if( r.body == null ) { os.delete( r.app ); return; }     // nothing in it
                        orphans.push( r );
                    } );

                    orphans.sort( function ( a, b ) { return ( b.at || 0 ) - ( a.at || 0 ); } );
                    var take = ! own && orphans.length ? orphans.shift() : null;

                    orphans.forEach( function ( r ) { if( now - ( r.at || 0 ) > DRAFT_ORPHAN_MS ) os.delete( r.app ); } );

                    if( take )
                    {
                        os.delete( take.app );
                        take.app = key;
                        os.put( take );
                        own = take;
                    }
                    out.result = own;
                };
                return out;
            } );

            if( d && d.who && who && d.who !== who ) return null;
            return d && d.body != null ? d : null;
        }

        function restored( d )
        {
            drafted = true;
            dirty   = true;
            sync( "unsaved" );
            stamp( "ui.draftAt", d.at, t( "ui.draftNote" ) );
        }

        // Only THIS document's own draft: a slot that still holds another
        // document's body (see keepDraft) is left alone - New's red bin on a
        // blank page dropped the unnamed one before it. force: the boot's
        // locked draft, which is in the slot before anything is on screen.
        function dropDraft( force )
        {
            if( ! drafted && ! force ) return Promise.resolve( null );
            drafted = false;
            return inSlot( async function ()
            {
                var key = await ownDraftKey();
                return draftTx( "readwrite", function ( os ) { return os.delete( key ); } );
            } );
        }

        // ---- leaving --------------------------------------------------------

        document.addEventListener( "visibilitychange", function () { if( document.visibilityState === "hidden" ) flush(); } );
        window.addEventListener( "pagehide", function () { flush(); } );
        window.addEventListener( "beforeunload", function ( e )
        {
            if( ! timer && ! busy && ! failed && ! held ) return;   // held: in the device draft only, the file never got it
            flush();                          // start it now, in case they stay
            e.preventDefault();
            e.returnValue = "";
        } );

        // A background flush (reconnect, tab focus) can meet the conflict too.
        o.store.onConflict( function ( p ) { if( p === path() ) offerCopy( p ); } );

        // A save of this page went up later, sent by the store on its own (a
        // reconnect, its retry of a save kept only in this page): a
        // create-only name's file is ours now, and "only in this page" is
        // over - the screen says "Saved".
        if( o.store.onSaved ) o.store.onSaved( function ( p, body, tag, mine )
        {
            if( ! mine ) return;
            fresh.delete( p );
            if( p !== path() || ! onlyHere || busy ) return;
            onlyHere = false;
            failed   = false;
            stamp( "write.savedAt", Date.now() );
        } );

        return {
            edited:    edited,
            flush:     flush,
            idle:      idle,
            catchUp:   catchUp,
            settle:    settle,
            kept:      kept,
            saveNow:   saveNow,
            saveTo:    saveTo,
            replaceAt: replaceAt,
            offerCopy: offerCopy,
            opened:    opened,
            moved:     moved,
            bakTaken:  function ( p ) { backedUp.add( p ); },
            dirty:     function () { return dirty; },
            takeDraft: takeDraft,
            restored:  restored,
            dropDraft: dropDraft,
            drafted:   function () { return drafted; },
            pristine:  function () { return pristine; },
            lock:      function () { return lock; },
            setLock:   function ( l ) { lock = l; },
            lockDoc:   lockDoc,
            unlockDoc: unlockDoc
        };
    }

    //------------------------------------------------------------------------//
    // THE OPEN DOCUMENT  -  what Calc, Text and Write do with "the file"
    //
    //   var session = NayiveOffice.session( {
    //       app:         "calc",                  // the device draft's key
    //       store:       store,                   // a NayiveStore made with { conflicts: true }
    //       appDir:      APP_DIR,                 // where "Guardar como" starts
    //       openRoot:    OPEN_ROOT,               // the label is relative to these two
    //       defaultName: "hoja.xlsx",             // "Guardar como" for a never-named document
    //       encode:      async function ( path ) {...},             // the body to save (path null = the draft)
    //       load:        async function ( body, name, how ) {...},  // put a body on screen; throw if it can't
    //                                             // how: "open" | "import" | "draft" | "restore"
    //                                             // an error with .said = true: the app already said why
    //       blank:       async function () {...},                   // put an empty document on screen
    //       nameKey:     "calc.defaultFile",      // the "Guardar como" name box's placeholder
    //       // optional:
    //       formats:     [ { value: "xlsx", text: "Excel (.xlsx)" }, { value: "", key: "text.extOther" } ],
    //       formatKey:   "calc.format",                 // with `formats`: the "Guardar como" format row
    //       pack:        false,                         // "Guardar como" at the full sheet width (Calc)
    //       openExts:    [ "xlsx", "csv" ],             // the formats it opens: the Open dialog lists
    //                                                   //   these, and any other picked is turned away
    //       turnAwayEnd: ".",                           //   ...with this after the toast (Calc)
    //       canOpen:     function ( path ) {...},       // or: which files the Open dialog lists (default: all)
    //       emptyKey:    "calc.noSheets",               // its "nothing here" line
    //       finishName:  function ( name, fmt ) {...},  // "Guardar como": the final name, null = stay in the dialog
    //       renameName:  function ( typed, path ) {...},// rename in place: the new file name
    //       blocked:     function ( path ) {...},       // true = do not write it now (Calc's loss gate)
    //       lossless:    function () {...},             // false = what is on screen, written back, loses something
    //                                                   //   the file has (Calc: charts): Restore asks, no Undo
    //       restoreBytes: async function ( copy, path ) {...}, // true = Restore swaps the two FILES as bytes (Calc)
    //       ready:       function () {...},             // false = the editor is not up yet (Write)
    //       busy:        function () {...},             // true = not a moment to ask for a name (Calc: a cell is being typed)
    //       onChange:    function () {...},             // the document's name changed (Text re-picks the language)
    //       onOpened:    function ( path ) {...},       // a server file was opened
    //       onSavedAs:   function ( path ) {...},       // "Guardar como" wrote it (Calc's loss gate resets)
    //       focus:       function () {...}              // back into the document after a dialog
    //   } );
    //
    //   session.path()  .readOnly()  .name()   the open document (name = an untitled one's)
    //   session.boot()                         ?file= / ?import= / the device draft (asks its name) / a blank one
    //   session.open( path )                   a file from the server; resolves true when it is on screen
    //   session.untitled( name, o )            the app put a new untitled document on screen (o.dirty, o.pristine)
    //   session.edited()  .flush()  .saveNow()  .openSaveAs()  .dirty()
    //   session.catchUp()                      keys typed while something was awaited: saved now (Write: a template)
    //   session.dropDraft()                    the untitled document was thrown away (Write: a template over it)
    //   session.openDialog()                   the "Abrir documento" sheet
    //   session.recentItems()                  "Recientes" as menu entries (shared/menubar.js)
    //   session.openPicked( path )             open a file the user picked (see openExts)
    //   session.locked()                       it is written encrypted
    //   session.keepUntitled()                 the untitled document about to go, for an Undo (null = none)
    //   session.offerBack( kept, aside )       its "Borrador descartado [Deshacer]" (Write: a template over it);
    //                                          aside: its draft was kept - "apartado", not "descartado"
    //   session.offerUndo( msg, back )         an Undo toast the next key or edit makes final (Write: the dictionary)
    //
    // THE PADLOCK (#lockBtn, optional): a password on the open document. The
    // key is derived once and kept in this tab only (shared/crypt.js), so a
    // reload asks for it again and a forgotten one cannot be recovered by
    // anybody - us included. Everything read back (a file, an import, the
    // device draft, the .bak) is sniffed for the seal and asks by itself.
    //
    // It builds the four sheets the three apps share (see THE SHEETS) and wires
    // whatever the page has of: #newBtn, #openBtn, #importBtn + #importInput,
    // #saveAsBtn, #restoreBtn, the "Abrir documento" sheet (#openBackdrop,
    // #openRecent, #openCrumb, #openList), the "Guardar como" sheet
    // (#saveAsBackdrop, #saveName, #saveFormat, #saveDirBtn, #saveAsConfirmBtn,
    // #saveAsDeleteBtn) and the file label.
    // The header plug gets the office wording: offline = "safe on this device",
    // an untitled document with edits = "use Guardar como".
    // A new document asks for its name and folder by itself, once (see askName).

    var OFFICE_TITLES = { offline: "write.offlineSafe", pending: "write.offlineSafe",
                          unsaved: "write.unsavedUseSaveAs" };

    var ASK_NAME_MS = 1500;     // how long without a key before a new document asks for its name

    // "carta" + "docx" -> "carta.docx"; a name that already ends so, or no format, stays.
    function withExt( name, fmt )
    {
        return fmt && ! new RegExp( "\\." + fmt + "$", "i" ).test( name ) ? name + "." + fmt : name;
    }

    // THE SHEETS - the keyboard shortcuts (#scBackdrop, filled by showShortcuts),
    // the statistics (#statsBackdrop, showStats), "Guardar como" (#saveAsBackdrop)
    // and "Abrir documento" (#openBackdrop): the same four in the three apps, so
    // they are written once, here. Built when the session is made - before
    // anything looks them up - right after #app, in that order. Their buttons
    // get their look here (applySheetButtons) and their words from
    // shared/i18n.js as they land, so they come out the same whenever the page
    // makes its session. A page that wrote its own (tools/locktest) keeps them.
    function buildSheets( o )
    {
        if( byId( "saveAsBackdrop" ) ) return;

        function actions( id ) { return '<div class="sheet-actions">\n<button id="' + id + '" data-act="close" data-i18n-attr="title:ui.close"></button>\n</div>'; }
        function field( forId, key, control ) { return '<div class="field">\n<label for="' + forId + '" data-i18n="' + key + '"></label>\n' + control + '\n</div>'; }

        var box = document.createElement( "div" );
        box.innerHTML = [
            '<div id="scBackdrop" class="sheet-backdrop">', '<div class="sheet sheet--pack">',
                '<h2 data-i18n="write.shortcuts"></h2>',
                '<div id="scList" class="sc-list"></div>',
                actions( "scCloseBtn" ),
            '</div>', '</div>',
            '<div id="statsBackdrop" class="sheet-backdrop">', '<div class="sheet sheet--pack">',
                '<h2 data-i18n="write.stats"></h2>',
                '<div id="stList" class="st-list"></div>',
                '<p id="stNote" class="dialog-text st-note" hidden></p>',
                actions( "statsCloseBtn" ),
            '</div>', '</div>',
            '<div id="saveAsBackdrop" class="sheet-backdrop">', '<div class="sheet' + ( o.pack === false ? "" : " sheet--pack" ) + '">',
                '<h2 data-i18n="ui.saveAs"></h2>',
                field( "saveName", "ui.fileName", '<input type="text" id="saveName" data-i18n-attr="placeholder:' + o.nameKey + '" autocomplete="off">' ),
                o.formats ? field( "saveFormat", o.formatKey, '<select id="saveFormat"></select>' ) : "",
                field( "saveDirBtn", "ui.folder", '<button type="button" id="saveDirBtn" class="folder-pick" data-i18n-attr="title:ui.fp.pickFolder">\n' +
                                                  '<span class="fp-btn-ic"></span><span id="saveDirName" class="fp-btn-nm"></span>\n</button>' ),
                '<div class="sheet-actions">',
                    '<button id="saveAsDeleteBtn" class="sheet-actions-left" type="button" data-act="danger" hidden data-i18n-attr="title:ui.discardDoc"></button>',
                    '<button id="saveAsCancelBtn" data-act="close" data-i18n-attr="title:ui.close"></button>',
                    '<button id="saveAsConfirmBtn" data-act="primary" data-i18n-attr="title:ui.save"></button>',
                '</div>',
            '</div>', '</div>',
            '<div id="openBackdrop" class="sheet-backdrop">', '<div class="sheet">',
                '<h2 data-i18n="ui.openDoc"></h2>',
                '<div id="openRecent" hidden></div>',          // the last ten documents opened, above the folder listing
                '<div id="openCrumb" class="open-crumb"></div>',
                '<ul id="openList" class="open-list"></ul>',
                actions( "openCloseBtn" ),
            '</div>', '</div>'
        ].filter( Boolean ).join( "\n" );

        ( o.formats || [] ).forEach( function ( f )
        {
            var op = document.createElement( "option" );
            op.value = f.value;
            if( f.key ) op.setAttribute( "data-i18n", f.key );
            else        op.textContent = f.text;
            box.querySelector( "#saveFormat" ).appendChild( op );
        } );

        NayiveUI.applySheetButtons( box );

        var app   = byId( "app" );
        var host  = app ? app.parentNode : document.body;
        var after = app ? app.nextSibling : null;
        while( box.firstChild ) host.insertBefore( box.firstChild, after );
    }

    function session( o )
    {
        buildSheets( o );

        var path     = null;     // relative to the file root; null = untitled
        var readOnly = false;    // someone else's file ("shared/..."): read, never written
        var pending  = null;     // the name of a document that has none on the server yet
        var asked    = false;    // this untitled document was already offered "Guardar como"
        var askTimer = null;
        var wipeAfter = null;    // "Copia limpia": the plain path to wipe after the save-as

        var sync     = NayiveUI.syncIndicator( { titles: OFFICE_TITLES } );
        var label    = fileLabel( { onCommit: rename } );
        var dirField = folderField( { dir: o.appDir } );
        var renaming = null;        // the old name while a rename is on its way: no save goes to it
        var renameHeld = false;     // a save was held by it: saved under the new name after
        var saver    = autosave( {
            app:      o.app,
            store:    o.store,
            path:     function () { return path; },
            readOnly: function () { return readOnly; },
            name:     function () { return pending || ( path && baseName( path ) ); },
            encode:   o.encode,
            // a rename on its way holds the old name's saves (see rename)
            blocked:  function ( p )
            {
                if( renaming && p === renaming ) { renameHeld = true; return true; }
                return !! ( o.blocked && o.blocked( p ) );
            },
            failKey:  "ui.saveFailed",
            setSync:  sync,
            saveAs:   openSaveAs,
            taken:    askTaken
        } );

        // The store drives the plug for every read and write - from the first one.
        o.store.onState( sync );

        // "Abrir documento": the same sheet in the three apps - the recent
        // documents over a folder browser. The app only says which files it can
        // open (`canOpen`), and what to do with the one picked when that is not
        // simply opening it (`onPick`: Calc and Write convert a foreign format
        // first). With no network the folder tree cannot be walked, so it lists
        // what this app has in the offline store instead.
        var canOpen = o.openExts ? function ( p ) { return o.openExts.indexOf( extOf( p ) ) !== -1; } : o.canOpen;
        var recent  = recentFiles( o.app );
        var browser = openBrowser( {
            root:     o.openRoot,
            canOpen:  canOpen || function () { return true; },
            onOpen:   function ( p ) { if( o.openExts ) openPicked( p ); else open( p ); },
            emptyKey: o.emptyKey,
            recent:   recent.list,
            offline:  async function ()
            {
                var cached = await o.store.listCached( o.openRoot + "/" );
                return cached.filter( function ( p )
                {
                    return p.indexOf( "/.bak/" ) === -1 && ( ! canOpen || canOpen( p ) );
                } );
            }
        } );

        function openDialog() { browser.open( o.appDir ); }

        // A file the user picked. The Open dialog lists only what this app
        // opens, but "Recientes" hands over any path the session ever opened (a
        // ?file= from Drive included), so anything else is still turned away here.
        async function openPicked( p )
        {
            if( ! canOpen || canOpen( p ) ) { await open( p ); return; }

            NayiveUI.toast( t( "write.formatUnsupported" ) + ( o.turnAwayEnd || "" ) );
        }

        // "Recientes" in the pull-down menus: the same ten paths the Open dialog
        // lists, so the menu never drifts from it. An empty list still shows one
        // (greyed) row - a menu that silently has no submenu is worse than one
        // that says why.
        function recentItems()
        {
            var list = recent.list();

            if( ! list.length ) return [ { key: "ui.noRecent", enabled: function () { return false; } } ];

            return list.map( function ( p )
            {
                return { text: baseName( p ), run: function () { openPicked( p ); } };
            } );
        }

        function toast( k ) { NayiveUI.toast( t( k ) ); }

        // Another account is signed in on this browser now (ownerHere, L5):
        // a side action on the server is refused, and says so.
        function notOwner()
        {
            if( ownerHere() ) return false;
            NayiveUI.toast( t( "ui.otherAccountHere" ), { ms: 7000 } );
            return true;
        }

        function showLabel()
        {
            label.set( path ? relLabel( path, o.appDir, o.openRoot ) + ( readOnly ? t( "text.readOnlySuffix" ) : "" )
                            : ( pending || t( "ui.untitled" ) ) );
            showLock();
            if( o.onChange ) o.onChange();
        }

        // The toolbar key lit = what leaves this tab is encrypted. Text's key
        // (data-only-locked) shows only on a document that is locked already.
        function showLock()
        {
            var btn = byId( "lockBtn" );
            if( ! btn ) return;
            btn.classList.toggle( "is-active", !! saver.lock() );
            if( btn.hasAttribute( "data-only-locked" ) ) btn.hidden = ! saver.lock();
        }

        function notReady()
        {
            if( ! o.ready || o.ready() ) return false;
            toast( "write.waitForDoc" );
            return true;
        }

        // ---- a locked document ------------------------------------------------
        //
        // Anything read back - a file, an import, the device draft, the .bak -
        // may be sealed (shared/crypt.js). Ask for its password and open it;
        // null = the user gave up, and the caller must NOT put it on screen.

        async function unsealAsk( body, name )
        {
            if( ! NayiveCrypt.available() ) { toast( "lock.noCrypto" ); return null; }

            for( ;; )
            {
                var pw = await NayiveUI.askPassword( { title:   t( "lock.askTitle" ),
                                                       body:    tf( "lock.askBody", { name: name } ),
                                                       confirm: t( "lock.openIt" ) } );
                if( pw === null ) return null;

                try
                {
                    var lock = await NayiveCrypt.lockFrom( pw, body );
                    return { lock: lock, body: await NayiveCrypt.unseal( lock, body ) };
                }
                catch ( e )
                {
                    // A wrong password and a damaged file look exactly the same
                    // from here - that is what the tag is for.
                    toast( "lock.wrong" );
                }
            }
        }

        // ---- what is on screen ----------------------------------------------

        function opened( p )
        {
            settleUndo();                      // another document: the Undo of the last one is over
            path     = p;
            readOnly = NayiveUI.isShared( p );
            pending  = null;
            saver.opened();
            showLabel();
            recent.add( p );                   // ?file= from Drive counts as opening it too
            if( o.onOpened ) o.onOpened( p );
        }

        function untitled( name, x )
        {
            x = x || {};
            settleUndo();
            path     = null;
            readOnly = false;
            pending  = name || null;
            asked    = false;
            clearTimeout( askTimer );
            askTimer = null;
            saver.setLock( x.lock || null );     // another document: never its password
            saver.opened( x );
            showLabel();
            if( x.dirty ) sync( "unsaved" );   // on screen, not on the server yet
        }

        async function open( p )
        {
            await saver.flush();               // don't lose a waiting autosave for the one we're leaving

            var res = await readViaStore( o.store, p );   // the store drives the plug; toasts on trouble
            if( res.body === null ) return false;

            var body = res.body;
            var got  = null;

            if( NayiveCrypt.looksLocked( body ) )
            {
                got = await unsealAsk( body, baseName( p ) );
                if( ! got ) return false;                // no password, no document
                body = got.body;
            }

            // Keys typed while the file came down (seconds, on a phone) went
            // into the document still on screen: saved to IT now - load()
            // replaces it, and opened() drops a waiting autosave.
            await saver.catchUp();

            // What is on screen only on this device (unnamed, or edits to
            // someone else's) is not thrown away: its device draft stays (the
            // next draft of this tab takes a key of its own) and, as with New,
            // the toast's Undo brings it straight back.
            var kept = await keepUntitled();

            try { await o.load( body, p, "open" ); }
            catch ( e )
            {
                sync( "error" );
                if( ! ( e && e.said ) ) toast( "ui.openFailed" );   // said: the app told why already (Text: not text)
                return false;
            }

            opened( p );
            saver.setLock( got ? got.lock : null );      // opened() reopened the saver: set it after
            showLock();                                  // ...and light the padlock by it (opened() drew the last one's)
            if( kept ) offerBack( kept, true );
            return true;
        }

        // An import opens UNTITLED, so its first save asks where it goes. The
        // original bytes are the first .bak copy.
        async function importBytes( bytes, name )
        {
            var got = null;

            if( NayiveCrypt.looksLocked( bytes ) )
            {
                got = await unsealAsk( bytes, name );
                if( ! got ) return false;
                bytes = got.body;
            }

            try { await o.load( bytes, name, "import" ); }
            catch ( e ) { if( ! ( e && e.said ) ) toast( "text.importFailed" ); return false; }

            // `pristine` is the plain original on purpose: autosave seals
            // whatever goes to .bak/ while a password is on.
            untitled( name, { pristine: bytes, dirty: true, lock: got && got.lock } );
            return true;
        }

        async function importFile( file )
        {
            if( ! file || notReady() ) return;
            await saver.flush();

            var bytes;
            try { bytes = new Uint8Array( await file.arrayBuffer() ); }
            catch ( e ) { toast( "text.importFailed" ); return; }

            // As Open does (see open): the document it replaces keeps its draft and gets an Undo.
            await saver.catchUp();
            var kept = await keepUntitled();
            if( await importBytes( bytes, file.name ) && kept ) offerBack( kept, true );
        }

        // Drive's "Abrir con" of a file another app owns: ?import=<path>.
        async function importPath( p )
        {
            var bytes;
            try { bytes = await GumApi.readFileBytes( p ); }
            catch ( e ) { toast( "text.importFailed" ); return false; }

            return importBytes( bytes, baseName( p ) );
        }

        // The ?file= this page was opened on, until boot() has opened it (nayiveDocPath).
        var booting = new URLSearchParams( location.search ).get( "file" );

        async function boot()
        {
            var q    = new URLSearchParams( location.search );
            var file = q.get( "file" );
            var imp  = q.get( "import" );

            booting = file;
            var shown = false;
            try { shown = !! file && await open( file ); }
            finally { booting = null; }
            if( shown ) return;
            if( ! file && imp && await importPath( imp ) ) return;

            if( ! file && ! imp && ! START_NEW )
            {
                // The untitled document from an earlier visit, kept on this device.
                var d = await saver.takeDraft();
                if( d )
                {
                    var lock = null;

                    if( NayiveCrypt.looksLocked( d.body ) )
                    {
                        var got = await takeLockedDraft( d );
                        if( got ) { d = { name: d.name, body: got.body, at: d.at }; lock = got.lock; }
                        else      { d = null; }        // thrown away: fall through to a blank one
                    }

                    if( d ) try
                    {
                        await o.load( d.body, d.name, "draft" );
                        untitled( d.name, { lock: lock } );
                        saver.restored( d );
                        askSoon();                     // still nowhere to save it: ask for a name
                        return;
                    }
                    catch ( e ) { toast( "ui.openFailed" ); }
                }
            }

            await o.blank();
            untitled( null );
        }

        // A draft is kept on this device alone: there is no copy anywhere else.
        // So a cancelled password cannot just drop through to a blank document -
        // the next edit would write over it. Ask again, or throw it away for good.
        async function takeLockedDraft( d )
        {
            for( ;; )
            {
                var got = await unsealAsk( d.body, d.name || t( "ui.untitled" ) );
                if( got ) return got;

                var drop = await NayiveUI.confirm( { title:   t( "lock.draftTitle" ),
                                                     body:    t( "lock.draftBody" ),
                                                     confirm: t( "ui.discardDoc" ),
                                                     cancel:  t( "lock.tryAgain" ),
                                                     danger:  true } );
                if( drop ) { await saver.dropDraft( true ); return null; }
            }
        }

        // On a big screen New leaves this document where it is, as desktops do:
        // a blank one opens in a desktop window (its window.open makes one,
        // desktop/index.html hookOpen) or a browser tab of its own. False when
        // there is one screen - a phone, the installed app, a pane of another
        // app - or the browser blocked it: New swaps there, as below.
        function newWindow()
        {
            var framed = window.self !== window.top;
            if( framed ? ! NayiveUI.windowed
                       : NayiveUI.isStandalone() || ! matchMedia( "(hover: hover) and (pointer: fine)" ).matches ) return false;

            var q = new URLSearchParams( location.search ), u = new URLSearchParams();
            if( q.get( "dir" ) ) u.set( "dir", q.get( "dir" ) );      // Write saves where Drive opened it
            u.set( "new", "1" );
            return !! window.open( location.pathname + "?" + u, "_blank" );
        }

        // A blank document without leaving the app (see newWindow first). An
        // untitled one with edits is only in the device draft: it goes at once,
        // and the toast's Undo brings it back. One that cannot be kept for that
        // (a password on it, or it cannot be read) still asks first, as it always did.
        async function newDocument()
        {
            if( notReady() ) return;
            if( newWindow() ) return;

            var dropping = saver.dirty() && ! path;
            // Edits to someone else's document are only in the device draft
            // too: never dropped - the draft stays where it is (the blank one
            // drafts under a key of its own) and the toast says so.
            var aside    = saver.dirty() && !! path && readOnly;
            var kept     = dropping || aside ? await keepUntitled() : null;
            if( dropping && ! kept && ! await NayiveUI.confirm( { title: t( "write.newDoc" ), body: t( "write.newDropsDraft" ),
                                                                  confirm: t( "write.newDoc" ) } ) ) return;

            if( ! await startBlank( dropping ) ) return;
            if( kept )       offerBack( kept, aside );
            else if( aside ) toast( "write.draftSetAside" );      // a password on it: no copy in memory, so no Undo
        }

        // "Guardar como"'s bin, shown only for a document that is nowhere but
        // on this device: throw it away and start blank. No second question -
        // pressing a red bin inside a dialog already is one - and an Undo.
        async function discardUntitled()
        {
            if( path || notReady() ) return;
            var kept = await keepUntitled();
            NayiveUI.close( "saveAsBackdrop" );
            if( await startBlank( true ) && kept ) offerBack( kept );
        }

        // True when the blank document is on screen.
        async function startBlank( dropping )
        {
            await saver.flush();               // a named document keeps its waiting autosave
            if( dropping ) await saver.dropDraft();

            try { await o.blank(); }
            catch ( e ) { toast( "ui.openFailed" ); return false; }

            untitled( null );
            o.store.resting();                 // nothing was read or written: settle the plug by hand
            if( o.focus ) o.focus();
            return true;
        }

        // ---- Undo: the document that New, the red bin or Restore swapped away --
        //
        // Kept in memory only, while its toast is on show (NayiveUI.undoToast).
        // The first key or edit in what replaced it makes the Undo final - it
        // would throw that new work away - and so does another document on
        // screen (opened / untitled). The Undo button's own Enter is not "a key".

        var undoOn = false;      // one of ours is on show

        // Set AFTER undoToast: it settles the Undo it replaces first, and when
        // that one is ours too, its onExpire clears the flag.
        function offerUndo( msg, back )
        {
            NayiveUI.undoToast( msg, function () { undoOn = false; back(); },
                                { onExpire: function () { undoOn = false; } } );
            undoOn = true;
        }

        function settleUndo()
        {
            if( ! undoOn ) return;
            undoOn = false;
            NayiveUI.undoSettle();
        }

        document.addEventListener( "keydown", function ( e )
        {
            if( ! undoOn || /^(Shift|Control|Alt|AltGraph|Meta|CapsLock|Tab)$/.test( e.key ) ) return;
            if( e.target && e.target.closest && e.target.closest( "#toast" ) ) return;
            settleUndo();
        }, true );

        // The untitled document about to be thrown away: its body as the device
        // draft keeps it, its name, and whether "Guardar como" was offered
        // already (✗ = not again). Edits to someone else's document count too
        // (Open / Import over them): they are only in the draft as well.
        // Null when there is nothing to bring back - no edits, it cannot be
        // read - or it has a password: no copy of that is ever kept in the
        // clear, not even here (THE PADLOCK).
        async function keepUntitled()
        {
            if( ( path && ! readOnly ) || ! saver.dirty() || saver.lock() ) return null;

            try
            {
                return { body: await o.encode( null ), name: pending || ( path && baseName( path ) ), asked: asked,
                         pristine: saver.pristine(), drafted: saver.drafted() };
            }
            catch ( e ) { return null; }
        }

        // Its Undo: back on screen and back in the device draft - now, not in 7 s.
        // aside: its draft was KEPT (Open, Import, New over someone else's
        // document), not dropped - the toast must not say "discarded".
        function offerBack( kept, aside )
        {
            var on = path;                             // what took its place (null: New's blank)

            offerUndo( t( aside ? "write.draftSetAside" : "write.draftDiscarded" ), async function ()
            {
                if( path !== on ) return;              // another document now: leave it be

                try { await o.load( kept.body, kept.name, "draft" ); }
                catch ( e ) { toast( "ui.openFailed" ); return; }

                untitled( kept.name, { dirty: true, pristine: kept.pristine } );
                // Open / Import left its draft in this tab's slot: that one is
                // written again, not copied to a new key (nothing else wrote it
                // meanwhile - the first key in what replaced it ends the Undo).
                if( kept.drafted ) saver.restored( { at: Date.now() } );
                asked = kept.asked;
                saver.edited();
                saver.flush();
                if( ! asked ) askSoon();
                if( o.focus ) o.focus();
            } );
        }

        // ---- a new document asks for its name ---------------------------------
        //
        // Once, at the first pause after its first edit - never mid-word, or the
        // rest of the word would land in the name field. ✗ keeps it untitled
        // (the device draft goes on as its backup) and it is not asked again.
        // An import or a template waits for its first edit too.

        function edited()
        {
            settleUndo();                      // new work: an Undo now would throw it away
            saver.edited();
            if( ! path && ! asked ) askSoon();
        }

        function askSoon()
        {
            clearTimeout( askTimer );
            askTimer = setTimeout( askName, ASK_NAME_MS );
        }

        function askName()
        {
            askTimer = null;
            if( path || asked ) return;

            // Not now: the editor is still starting (Write), the user is mid-way
            // through something (a Calc cell being typed), or a dialog is up.
            if( ( o.ready && ! o.ready() ) || ( o.busy && o.busy() ) ||
                document.querySelector( ".sheet-backdrop.open" ) ) { askSoon(); return; }

            openSaveAs();
        }

        // Still typing (a key inside a Calc cell is not an edit yet): wait.
        document.addEventListener( "keydown", function () { if( askTimer ) askSoon(); }, true );

        // Back into the document when "Guardar como" closes, whichever way.
        var saveBack = byId( "saveAsBackdrop" );
        var saveOpen = false;
        if( saveBack )
            new MutationObserver( function ()
            {
                var now = saveBack.classList.contains( "open" );
                if( saveOpen && ! now )
                {
                    // Closed without writing: a "Copia limpia" that never
                    // happened must not wipe anything on the NEXT save-as.
                    wipeAfter = null;
                    if( o.focus ) o.focus();
                }
                saveOpen = now;
            } ).observe( saveBack, { attributes: true, attributeFilter: [ "class" ] } );

        // ---- "Guardar como" --------------------------------------------------

        // The #saveFormat option for a name: its extension when offered, else
        // the "" (other: keep the name as it is) option when there is one, else
        // the first - so "foo.log" in Text is not turned into "foo.log.txt".
        function formatFor( name )
        {
            var sel = byId( "saveFormat" );
            if( ! sel ) return "";

            var vals = Array.prototype.map.call( sel.options, function ( op ) { return op.value; } );
            var ext  = extOf( name );
            if( ext && vals.indexOf( ext ) !== -1 ) return ext;
            return vals.indexOf( "" ) !== -1 ? "" : vals[ 0 ];
        }

        function openSaveAs()
        {
            var input = byId( "saveName" );
            var name  = pending || ( path ? baseName( path ) : o.defaultName );

            asked = true;                      // asked by hand counts too: not again by itself
            clearTimeout( askTimer );
            askTimer = null;

            input.value = name;
            if( byId( "saveFormat" ) ) byId( "saveFormat" ).value = formatFor( name );
            if( byId( "saveAsDeleteBtn" ) ) byId( "saveAsDeleteBtn" ).hidden = !! path;   // a Drive file is never deleted from here

            // Someone else's document: our copy goes to a folder of ours, never
            // back to the folder of theirs it was read from.
            dirField.set( ( ! readOnly && path && dirName( path ) ) || o.appDir );

            NayiveUI.open( "saveAsBackdrop" );
            input.focus();
            input.select();
        }

        async function confirmSaveAs()
        {
            var name = safeName( byId( "saveName" ).value );
            if( ! name ) return;

            var fmt = byId( "saveFormat" ) ? byId( "saveFormat" ).value : "";
            name = o.finishName ? o.finishName( name, fmt ) : withExt( name, fmt );
            if( ! name ) return;

            var p = dirField.get() + "/" + name;

            // The app's own gate (Calc: what the file would lose there) is asked
            // FIRST, before anything changes: a "no" leaves the sheet open and
            // the document keeps its name. Asked only at the write, it left the
            // document pointing at a .csv that was never written.
            if( o.blocked && o.blocked( p ) ) return;

            // A file the app will not write under its own name (Text: not UTF-8)
            // needs ANOTHER name: say so, keep the sheet open, write nothing.
            if( p === path && o.store.isBlocked && o.store.isBlocked( p ) === "bad" )
            {
                NayiveUI.toast( o.sameNameRefused ? o.sameNameRefused( name ) : t( "ui.store.badFile" ), { ms: 6000 } );
                return;
            }

            // Another file of that name is written over only when the user says
            // so - once. A "no" leaves the sheet open: another name, or ✗.
            // Any other new name - free when the folder was listed, or not
            // known (offline, the listing failed) - is saved CREATE-ONLY
            // (D6): a file of that name there on the server, now or by the
            // time it goes up, is never written over - the save is held back
            // and askTaken asks.
            var how = "";
            if( p !== path )
            {
                if( checkingName ) return;             // Enter held down: one question, not two
                checkingName = true;
                try
                {
                    var taken = await nameTaken( p );
                    if( taken === true && ! await NayiveUI.confirm( { title:   t( "drive.nameExistsTitle" ),
                                                                      body:    tf( "ui.saveAsExists", { name: name } ),
                                                                      confirm: t( "drive.replace" ),
                                                                      danger:  true } ) ) return;
                    how = taken === true ? "" : "create";
                }
                finally { checkingName = false; }
            }

            // Taken BEFORE the sheet closes: closing clears it (a "Copia
            // limpia" the user backed out of must not wipe anything later).
            var wipeThis = wipeAfter;
            wipeAfter = null;

            NayiveUI.close( "saveAsBackdrop" );

            // saveTo lands any waiting autosave under the OLD name first, then
            // writes here - and a new destination gets its own .bak copy.
            var res = await saver.saveTo( p, how );

            // Refused - nothing went there (the app's gate, a store that will
            // not write it, the server saying no): the document stays what
            // and where it was. Offline or queued is saved, from the user's side.
            if( ! res || res.blocked || res.forbidden )
            {
                if( o.focus ) o.focus();
                return;
            }

            path     = p;
            readOnly = false;
            pending  = null;
            showLabel();

            // The name was taken on the server after all (create-only: held
            // back, nothing written over): Replace, or keep both.
            if( res.conflict ) saver.offerCopy( p );

            // "Copia limpia": the plain original goes only once the protected
            // copy is REALLY on the server. Offline, queued or refused, it
            // stays - and so does the only readable version of the document.
            if( wipeThis && wipeThis !== p && res && res.ok === true && ! res.conflict )
                await wipeForGood( wipeThis );

            if( o.onSavedAs ) o.onSavedAs( p );
            if( o.focus ) o.focus();
        }

        var checkingName = false;    // confirmSaveAs is asking whether the name is taken

        // Is there a file at p already? true / false as the folder's listing
        // says; null = not known (offline, the listing failed) - unless the
        // copy this device keeps of it says it is there. Only `true` asks
        // "Replace?"; false and null are saved create-only (confirmSaveAs).
        async function nameTaken( p )
        {
            try
            {
                var list = await GumApi.listDir( dirName( p ) );
                return ( ( list && list.nodes ) || [] ).some( function ( n ) { return n.path === p && ! Array.isArray( n.nodes ); } );
            }
            catch ( e )
            {
                if( e && e.status === 404 ) return false;          // no such folder yet: no such file
                try { return await o.store.hasCache( p ) ? true : null; } catch ( e2 ) { return null; }
            }
        }

        // A name saved create-only was taken on the server (another device
        // or window put a file there - before the save, or before it went up
        // from offline): nothing was written over it, the save is held back.
        // Replace it (its file gets a .bak first), or keep both - this
        // document goes to the next free name. ✗ leaves it held back (the
        // plug says so); Ctrl+S asks again.
        async function askTaken( p )
        {
            var r = await NayiveUI.confirm( { title:     t( "drive.nameExistsTitle" ),
                                              body:      tf( "ui.saveAsAppeared", { name: baseName( p ) } ),
                                              confirm:   t( "drive.replace" ),
                                              danger:    true,
                                              other:     t( "drive.keepBoth" ),
                                              otherIcon: "copy" } );
            if( p !== path ) return;                   // another document now
            if( r === true ) { await saver.replaceAt( p ); return; }
            if( r !== "other" ) return;

            var free = await freeName( p );
            var res  = await saver.saveTo( free, "create" );    // drops p's held-back save once this one is kept
            if( ! res || res.blocked || res.forbidden || path !== p ) return;
            path = free;
            showLabel();
            if( res.conflict ) saver.offerCopy( free );
        }

        // "carta.docx" -> "carta (2).docx", "carta (3).docx"... the first one
        // the folder's listing does not have; the listing failing, " (2)" -
        // it is saved create-only, so a taken one is asked about again.
        async function freeName( p )
        {
            var dir = dirName( p ), base = baseName( p ), names = new Set();
            try { names = await GumApi.namesIn( dir ); }
            catch ( e ) {}
            return dir + "/" + GumApi.uniqueName( base, { has: function ( n ) { return n === base || names.has( n ); } } );
        }

        // ---- the file label: rename in place ----------------------------------

        async function rename( raw )
        {
            var name = safeName( raw );
            if( ! name ) return;

            // Untitled, or someone else's: the name goes to "Guardar como" - a
            // first save has to ask WHERE, and their file is never renamed.
            if( ! path || readOnly )
            {
                pending = name;
                showLabel();
                openSaveAs();
                return;
            }

            // Kept in its own folder, which need not be appDir (the Open browser
            // reaches anywhere in Drive).
            var to = ( dirName( path ) || o.appDir ) + "/" + ( o.renameName ? o.renameName( name, path ) : name );
            if( to === path ) return;
            if( notOwner() ) { showLabel(); return; }

            sync( "saving" );
            try
            {
                // The latest body under the OLD name, and nothing queued for it:
                // a PUT flushing after the move would recreate the old file.
                // From then on the old name takes no save (an autosave or a
                // Ctrl+S during the move: device draft, saved under the new
                // name right after), and one already running is waited for.
                await saver.flush();
                renaming = path;
                await saver.idle();
                try { await o.store.flush(); } catch ( e ) {}

                // Still waiting for the old name: the rename would leave it
                // behind - a save held back as "changed on another device" (C3:
                // the move took THEIR file, and ours was dropped or later
                // went up blind), or one the server did not take yet (E5:
                // quota full, a 5xx - forgetting it dropped the only copy).
                // Refused, saying why; nothing moves.
                var wait = null;
                try { wait = await o.store.pending( path ); } catch ( e ) { wait = { unknown: true }; }
                if( wait )
                {
                    sync( wait.conflict ? "conflict" : "error" );
                    showLabel();
                    NayiveUI.toast( t( wait.conflict ? "text.renameHeld" : "text.renameUnsent" ), { ms: 7000 } );
                    if( wait.conflict && wait.mine ) saver.offerCopy( path );
                    return;
                }

                await GumApi.rename( path, to );
                // The new name is this page's file from the same version (the
                // server keeps it across a move): its first save is checked,
                // never blind (C6). Only now is the old cache entry stale.
                try { await o.store.renamed( path, to ); } catch ( e ) {}

                saver.moved( path, to );

                // A file the app would not write (Text: not UTF-8) is the same
                // file under its new name.
                var why = o.store.isBlocked ? o.store.isBlocked( path ) : "";
                if( why && why !== "loading" ) o.store.block( to, why );

                path = to;
                showLabel();
                sync( "synced" );
            }
            catch ( e )
            {
                sync( "error" );
                toast( "text.renameFailed" );
            }
            finally
            {
                renaming = null;
                if( renameHeld ) { renameHeld = false; saver.edited(); }
            }
        }

        // ---- "Restaurar la copia anterior" ------------------------------------
        //
        // ONE .bak per document, taken before its first save of the session. The
        // order matters: read the copy FIRST, then write what is on screen over
        // it, and only then load - so restoring is itself undoable.
        //
        // A plain document swaps at once and the toast's Undo swaps it back.
        // It still asks first, with no Undo, when a password is on either side
        // (no plain copy of it is kept in memory), when the store will not
        // write the file as it is (Text: not UTF-8; Calc: a sheet it could not
        // read), or when the app says what is on screen could not be written
        // back whole (Calc: charts, pivots) - the Undo would write it so.
        //
        // An app that cannot carry one side whole (o.restoreBytes - Calc with
        // pivot tables, print setup...) never goes through encode() / load()
        // for the files: they swap as BYTES (swapFiles). Re-encoding wrote what
        // Calc drops out of BOTH copies.
        async function restorePrevious()
        {
            if( notReady() ) return;
            if( ! path )   { toast( "write.noBackupYet" ); return; }
            if( readOnly ) { toast( "text.notYours" );     return; }
            if( notOwner() ) return;                   // that account's .bak, read and written (L5)

            var p    = path;
            var bak  = bakPath( path );
            var prev = null;
            try { prev = await GumApi.readFileBytes( bak ); } catch ( e ) { prev = null; }
            if( ! prev || ! prev.length ) { toast( "write.noBackupYet" ); return; }
            var raw = prev;                    // the .bak's bytes as they are on the server

            // An app that may restore by swapping the files (Calc): edits its
            // gate held back are in neither copy, and the swap would take them
            // off the screen. Said BEFORE anything is asked - "save a copy
            // first" (the gate's own way out), never a promise the swap breaks.
            if( o.restoreBytes )
            {
                await saver.settle( CLOSE_WAIT_MS );
                if( saver.dirty() ) { toast( "write.restoreSaveFirst" ); return; }
            }

            // A copy sealed with a password, back into a document that has none
            // now: it is written without one (see below) - and the toast says so.
            var doneKey = NayiveCrypt.looksLocked( prev ) && ! saver.lock() ? "write.restoredNoPassword" : "write.restored";

            var undoable = ! saver.lock() && ! NayiveCrypt.looksLocked( prev ) &&
                           ! ( o.store.isBlocked && o.store.isBlocked( p ) ) && ( ! o.lossless || o.lossless() );

            if( ! undoable && ! await NayiveUI.confirm( { title:   t( "write.restore" ),
                                                          body:    tf( "write.restoreBody", { size: NayiveUI.fmtBytes( prev.length ) } ),
                                                          confirm: t( "write.restore" ) } ) ) return;

            // The copy coming back was sealed by the key of its day: the one we
            // hold, or - after the password changed - one only the user knows.
            // Opened BEFORE anything is written: a cancel here must leave the
            // .bak exactly as it was.
            //
            // It opens with that password, but the document KEEPS its own (or
            // none, if it has none now): every save from here seals it with the
            // padlock's key, as before the restore. Taking the old key on, as
            // this did, silently switched the document to a password the user
            // typed once - and a forgotten password is a lost document.
            if( NayiveCrypt.looksLocked( prev ) )
            {
                var plain = null;
                if( saver.lock() )
                    try { plain = await NayiveCrypt.unseal( saver.lock(), prev ); } catch ( e ) { plain = null; }

                if( plain === null )
                {
                    var got = await unsealAsk( prev, baseName( bak ) );
                    if( ! got ) return;
                    plain = got.body;
                }
                prev = plain;
            }

            // Asked with the plain copy; one the app cannot read at all throws -
            // and nothing has been written yet.
            var swap = false;
            if( o.restoreBytes )
                try { swap = await o.restoreBytes( prev, p ); }
                catch ( e ) { toast( "write.actionFailed" ); return; }
            if( swap ) { await swapFiles( p, bak, raw, prev, undoable, doneKey ); return; }

            var bakWas = undoable ? prev.slice() : null;     // the .bak's own bytes, whatever load() does with prev

            try
            {
                // The copy going up takes the document's own state with it.
                var now = await o.encode( path );
                var up  = saver.lock() ? await NayiveCrypt.seal( saver.lock(), now ) : now;
                await GumApi.writeFileBytes( bak, typeof up === "string" ? new TextEncoder().encode( up ) : up );
                // The session's first save must not take a NEW .bak over it: it
                // holds what was on screen - the way back (Undo, or Restore again).
                saver.bakTaken( p );

                await o.load( prev, path, "restore" );
                saver.edited();                // the restored copy still has to be saved over the document
            }
            catch ( e ) { toast( "write.actionFailed" ); return; }

            if( ! undoable ) { toast( doneKey ); return; }

            // Undo: the .bak as it was, and what was on screen back on screen -
            // to be saved over the document again.
            offerUndo( t( "write.restored" ), async function ()
            {
                if( path !== p || notOwner() ) return; // another document now / another account
                try
                {
                    await GumApi.writeFileBytes( bak, bakWas );
                    saver.bakTaken( p );        // or the next save's first-time copy would write over it
                    await o.load( now, p, "restore" );
                    saver.edited();
                }
                catch ( e ) { toast( "write.actionFailed" ); }
            } );
        }

        // Restore as a swap of the two FILES on the server, byte for byte: the
        // document's file becomes the .bak, the .bak becomes the file, and the
        // screen shows the copy as the app reads it (Calc's gate then guards it
        // like any opened file). raw: the .bak's bytes; plain: the same, opened.
        //
        // What is on screen must be somewhere first - in the file (a flush), or
        // held back in the device draft (Calc's gate): that draft then stays as
        // it is, an orphan the next Calc tab offers. Otherwise nothing is done.
        // Order: .bak first (a failure there changes nothing), then the file
        // through the store - its outbox holds the bytes before the PUT, and its
        // server time stays right (a GumApi write left it stale: a false 412).
        async function swapFiles( p, bak, raw, plain, undoable, doneKey )
        {
            await saver.settle( CLOSE_WAIT_MS );
            try { await o.store.flush(); await o.store.resting(); } catch ( e ) {}
            // THIS file must have nothing waiting to go up (the swap reads it
            // from the server) - another document's or another window's save
            // waiting for another file does not matter (the plug's state did:
            // any save anywhere refused the restore).
            var wait = null;
            try { wait = await o.store.pending( p ); } catch ( e ) { wait = { unknown: true }; }
            if( ! saver.kept() || wait || path !== p ) { toast( "write.actionFailed" ); return; }

            // Edits the file never got (Calc's gate held them back): neither
            // copy has them, and a swap would take them off the screen with
            // no way back but an orphan draft. restorePrevious already says
            // so before asking; this is in case one was made since.
            if( saver.dirty() ) { toast( "write.restoreSaveFirst" ); return; }

            var cur;
            try { cur = await GumApi.readFileBytes( p ); }
            catch ( e ) { toast( "write.actionFailed" ); return; }

            // Sealed with the document's own password, or none (see restorePrevious).
            var back = saver.lock() ? await NayiveCrypt.seal( saver.lock(), plain ) : plain;

            try { await GumApi.writeFileBytes( bak, cur ); }
            catch ( e ) { toast( "write.actionFailed" ); return; }
            saver.bakTaken( p );               // never a first-save copy over it: it is the way back

            var put = await putFile( p, back );
            if( put !== "kept" )
            {
                // Refused: the file still has `cur` - the .bak gets its own
                // bytes back. Only in this page ("later"): the file may still
                // become the copy, so the .bak keeps `cur`, the way back.
                if( ! put ) try { await GumApi.writeFileBytes( bak, raw ); } catch ( e ) {}
                toast( "write.actionFailed" );
                return;
            }

            try { await o.load( plain, p, "restore" ); }
            catch ( e )
            {
                // The file is the copy now, the screen still what was: both
                // back - the .bak only once the file has `cur` again, or `cur`
                // would be nowhere.
                if( await putFile( p, cur ) === "kept" )
                    try { await GumApi.writeFileBytes( bak, raw ); } catch ( e2 ) {}
                toast( "write.actionFailed" );
                return;
            }
            saver.opened();                    // the screen IS the file now: nothing waits to be saved

            if( ! undoable ) { toast( doneKey ); return; }

            offerUndo( t( doneKey ), async function ()
            {
                if( path !== p || notOwner() ) return; // another document now / another account
                try
                {
                    if( NayiveCrypt.looksLocked( cur ) ) throw new Error( "sealed" );   // undoable said no key is on either side
                    await GumApi.writeFileBytes( bak, raw );
                    saver.bakTaken( p );
                    if( await putFile( p, cur ) !== "kept" )
                    {
                        // `cur` is only in memory now: back into the .bak it came from.
                        try { await GumApi.writeFileBytes( bak, cur ); } catch ( e2 ) {}
                        throw new Error( "not written" );
                    }
                    await o.load( cur, p, "restore" );
                    saver.opened();
                }
                catch ( e ) { toast( "write.actionFailed" ); }
            } );
        }

        // The file's own bytes through the store. Not refused for what the
        // SCREEN cannot write (a block: Calc's unread sheet) - these are not the
        // screen's; load() blocks the path again when what it shows needs it.
        // "kept" = on the server or safe in the store's outbox; "" = refused
        // for good, or gone before it was sent (unknown): the file still has
        // what it had. "later" = kept only in this page (the store's
        // pageOnly): NOT kept - the swap must not go on as if the file had
        // it - yet it may still go up, so the .bak keeps what it holds.
        async function putFile( p, bytes )
        {
            var why = o.store.isBlocked ? o.store.isBlocked( p ) : "";
            if( why && why !== "loading" ) o.store.unblock( p );
            var res;
            try { res = ( await o.store.write( p, bytes ) ) || {}; }
            catch ( e ) { res = { ok: false, forbidden: true }; }
            finally { if( why && why !== "loading" ) o.store.block( p, why ); }
            if( res.pageOnly ) return "later";
            return res.blocked || res.forbidden || res.unknown ? "" : "kept";
        }

        // ---- the padlock: put a password on, or take it off ---------------------
        //
        // On: the body is encrypted from here on - the server file, the .bak
        // beside it and the device draft. Off: it goes back to plain, and the
        // sealed .bak with it (autosave.unlockDoc, while the key is still here).
        // Either way the document is written at once, so what is up there
        // matches what the padlock says.

        async function toggleLock()
        {
            if( notReady() ) return;
            if( readOnly )                   { toast( "text.notYours" ); return; }
            if( ! NayiveCrypt.available() )  { toast( "lock.noCrypto" ); return; }

            if( saver.lock() ) await removeLock();
            else               await addLock();
        }

        // A document that has been written already is the dangerous case: the
        // version from before the password is on this device (the store cache,
        // the device draft) and on the server (the file and its .bak), and a
        // password now does NOT go back and erase it. Nothing about the padlock
        // shows that, so it is said out loud, once, before the password is even
        // asked for - and with the way out offered as the first answer.
        async function warnAlreadyWritten()
        {
            if( ! path )
                return await NayiveUI.confirm( { title:   t( "lock.pastTitle" ),
                                                 body:    t( "lock.pastDraftBody" ),
                                                 confirm: t( "lock.protect" ) } ) ? "lock" : null;

            var r = await NayiveUI.confirm( {
                title:     t( "lock.pastTitle" ),
                body:      tf( "lock.pastBody", { name: baseName( path ) } ),
                confirm:   t( "lock.cleanCopy" ),
                other:     t( "lock.lockAnyway" ),
                otherIcon: "key" } );

            return r === true ? "clean" : ( r === "other" ? "lock" : null );
        }

        async function addLock()
        {
            // Never written anywhere yet (the padlock pressed before the first
            // word): there is no past to warn about, and none will exist.
            var how = ( path || saver.drafted() ) ? await warnAlreadyWritten() : "lock";
            if( ! how ) return;

            var pw = await NayiveUI.askPassword( { title:   t( "lock.setTitle" ),
                                                   body:    t( "lock.setBody" ),
                                                   confirm: t( "lock.protect" ),
                                                   verify:  true } );
            if( pw === null ) return;

            try { saver.lockDoc( await NayiveCrypt.newLock( pw ) ); }
            catch ( e ) { toast( "lock.failed" ); return; }

            showLock();

            // A clean copy goes to a NEW name; the old one is wiped only once
            // the protected copy is really on the server (confirmSaveAs).
            if( how === "clean" ) { wipeAfter = path; openSaveAs(); return; }

            await writeLockState();
            toast( "lock.on" );
        }

        // The copy from before the password, once the protected one is safe:
        // out of Drive AND out of the Bin, so it is not left sitting there in
        // the clear. What this canNOT reach is said in the dialog, not hidden:
        // the nightly off-site backup keeps its own copy for a while.
        async function wipeForGood( old )
        {
            var paths = [ old, bakPath( old ) ];

            // Another account signed in now (L5): its file of that name and
            // its bin items would go. The plain copy stays; the toast says why.
            if( notOwner() ) return;

            try
            {
                try { await o.store.forget( old ); } catch ( e ) {}
                recent.remove( old );

                // One at a time: a document with no .bak yet must not stop the
                // deletion of the document itself. Each delete only moves it
                // to the papelera, and says under which ids: exactly those are
                // taken out again. Matching the bin by name purged OTHER items
                // too - last year's file of that name, an older .bak.
                var ids = [], gone = false;
                for( var i = 0; i < paths.length; i++ )
                {
                    var got = null;
                    try { got = await GumApi.binPaths( [ paths[ i ] ] ); } catch ( e ) {}
                    if( got ) ids = ids.concat( got );
                    if( i === 0 ) gone = !! ( got && got.length );
                }

                if( ids.length ) await GumApi.trashDelete( ids );
                toast( gone ? "lock.wiped" : "lock.wipeFailed" );
            }
            catch ( e ) { toast( "lock.wipeFailed" ); }
        }

        async function removeLock()
        {
            var ok = await NayiveUI.confirm( { title:   t( "lock.offTitle" ),
                                               body:    t( "lock.offBody" ),
                                               confirm: t( "lock.remove" ),
                                               danger:  true } );
            if( ! ok ) return;

            if( ! await saver.unlockDoc() ) { notOwner(); return; }   // another account now (L5): nothing changed
            showLock();
            await writeLockState();
            toast( "lock.off" );
        }

        // Right now, not in seven seconds: while the old state is still up
        // there, the padlock would be telling the truth about the wrong file.
        // An untitled document has only its device draft - flush() writes that.
        async function writeLockState()
        {
            if( path && ! readOnly ) await saver.saveNow();
            else                     { saver.edited(); await saver.flush(); }
            if( o.focus ) o.focus();
        }

        // ---- the buttons and the sheet ------------------------------------------

        function on( id, ev, fn ) { var el = byId( id ); if( el ) el.addEventListener( ev, fn ); }

        on( "newBtn",           "click",   function () { newDocument(); } );
        on( "openBtn",          "click",   function () { openDialog(); } );
        on( "restoreBtn",       "click",   function () { restorePrevious(); } );
        on( "lockBtn",          "click",   function () { toggleLock(); } );
        on( "importBtn",        "click",   function () { if( byId( "importInput" ) ) byId( "importInput" ).click(); } );
        on( "importInput",      "change",  function ( e ) { var f = e.target.files[ 0 ]; e.target.value = ""; importFile( f ); } );
        on( "saveAsBtn",        "click",   function () { openSaveAs(); } );
        on( "saveAsConfirmBtn", "click",   function () { confirmSaveAs(); } );
        on( "saveAsDeleteBtn",  "click",   function () { discardUntitled(); } );
        on( "saveName",         "keydown", function ( e ) { if( e.key === "Enter" ) confirmSaveAs(); } );

        // ---- a desktop window ---------------------------------------------------
        //
        // The desktop removes a window's frame at once: no beforeunload, and
        // pagehide's flush dies with it (desktop/index.html, close). So it asks
        // here first. What waits is kept NOW - the store's outbox or the device
        // draft, both in IndexedDB - and only what could not be kept is asked
        // about (a refused save, a sheet Calc's gate holds back, a save still
        // running after CLOSE_WAIT_MS). Never throws: the desktop closes on a throw.
        var CLOSE_WAIT_MS = 10000;

        window.nayiveBeforeClose = async function ()
        {
            try { if( await saver.settle( CLOSE_WAIT_MS ) ) return true; }
            catch ( e ) {}

            return NayiveUI.confirm( { title:   t( "drive.unsavedTitle" ),
                                       body:    t( "drive.unsavedBody" ),
                                       confirm: t( "drive.closeWithout" ),
                                       danger:  true } );
        };

        // Which document this window shows, so the desktop opens a second
        // ?file= of it in THIS window, not in another editor that would save
        // over it. While boot() is still opening ?file=, that one.
        window.nayiveDocPath = function () { return path || booting; };

        return {
            path:       function () { return path; },
            readOnly:   function () { return readOnly; },
            name:       function () { return pending; },
            boot:       boot,
            open:       open,
            untitled:   untitled,
            edited:     edited,
            flush:      saver.flush,
            catchUp:    saver.catchUp,
            saveNow:    saver.saveNow,
            dirty:      saver.dirty,
            dropDraft:  saver.dropDraft,
            openSaveAs: openSaveAs,
            openDialog: openDialog,
            recentItems: recentItems,
            openPicked: openPicked,
            locked:     function () { return !! saver.lock(); },
            keepUntitled: keepUntitled,
            offerBack:    offerBack,
            offerUndo:    offerUndo
        };
    }

    //------------------------------------------------------------------------//
    // THE APP'S OWN SETTINGS FILE  (data/<app>/config.json)
    //
    //   var cfg = NayiveOffice.appConfig( "data/write/config.json", "ui.prefsUnread" );
    //   ( await cfg.read() ).chrome        cfg.write( { chrome: "menus" } )
    //
    // One read-modify-write JSON object per app, so a key added later is never
    // clobbered. read(): nothing saved yet (a 404) is {}; any other failure -
    // offline, a 5xx, bad JSON, not an object - throws: a file that could not
    // be read must never be written over with just the key being changed.
    // write( patch ) goes over what is on the server and resolves the new
    // object; when that cannot be read it writes nothing, says `warnKey` once
    // per page, and resolves null.

    function appConfig( path, warnKey )
    {
        var warned = false;

        async function read()
        {
            var cfg = await GumApi.readJson( path );
            if( cfg !== null && ( typeof cfg !== "object" || Array.isArray( cfg ) ) ) throw new Error( path + " is not an object" );
            return cfg || {};
        }

        async function write( patch )
        {
            var cfg;
            try { cfg = await read(); }
            catch ( e )
            {
                if( ! warned ) { warned = true; NayiveUI.toast( t( warnKey ) ); }
                return null;
            }
            Object.assign( cfg, patch );
            try { await GumApi.writeJson( path, cfg ); } catch ( e ) {}
            return cfg;
        }

        return { read: read, write: write };
    }

    //------------------------------------------------------------------------//
    // HELP  -  the "?" and the Ayuda menu: the same three entries in Write,
    // Calc and Text, each clicking its own real (hidden) button, so the two
    // chromes cannot drift and there is still one set of handlers.

    var HELP_ITEMS =
    [
        { key: "write.stats",       el: "statsBtn" },
        { key: "write.shortcuts",   el: "scBtn"    },
        { key: "ui.toolbarButtons", el: "guideBtn" }
    ];
    var HELP_IDS = HELP_ITEMS.map( function ( it ) { return it.el; } );

    //   var menu = NayiveOffice.helpMenu( { stats: openStats, shortcuts: openShortcuts } );
    //
    // Wires the three hidden entries (#statsBtn, #scBtn, #guideBtn: the guide
    // card) and builds the "?" menu (#helpBtn -> #helpMenu) from them;
    // setHelpMenu leaves the "?" click to that menu. Returns the menu.
    function helpMenu( o )
    {
        byId( "statsBtn" ).addEventListener( "click", o.stats );
        byId( "scBtn"    ).addEventListener( "click", o.shortcuts );
        byId( "guideBtn" ).addEventListener( "click", function () { NayiveUI.showIntro(); } );
        var menu = buttonMenu( { btn: "helpBtn", menu: "helpMenu", ids: HELP_IDS } );
        NayiveUI.setHelpMenu( true );
        return menu;
    }

    //------------------------------------------------------------------------//
    // KEYBOARD SHORTCUTS  -  Help ▸ "Keyboard shortcuts" in Calc and Write
    //
    //   NayiveOffice.showShortcuts( [ { text: "Guardar", keys: "Ctrl+S" }, ... ] );
    //
    // Fills #scList in the page's #scBackdrop sheet - one row per shortcut, its
    // keys on the right - and opens it. Paired CSS: .sc-list / .sc-row in the
    // OFFICE CHROME block of app.css.

    function showShortcuts( rows )
    {
        var list = byId( "scList" );
        if( ! list ) return;
        list.innerHTML = "";

        rows.forEach( function ( r )
        {
            var row  = document.createElement( "div" );
            var what = document.createElement( "span" );
            var keys = document.createElement( "kbd" );
            row.className    = "sc-row";
            what.textContent = r.text;
            keys.textContent = r.keys;
            row.appendChild( what );
            row.appendChild( keys );
            list.appendChild( row );
        } );

        NayiveUI.open( "scBackdrop" );
    }

    //------------------------------------------------------------------------//
    // STATISTICS  -  Help > "Statistics" in Write, Calc and Text
    //
    //   NayiveOffice.showStats( [ { text: "Words", value: 812 }, ... ], note );
    //
    // Same sheet in the three apps: #statsBackdrop, one #stList row per figure,
    // the number on the right (with the reader's own thousands separators), an
    // optional grey `note` under the list. Paired
    // CSS: .st-list / .st-row / .st-note in the OFFICE CHROME block of app.css.

    function showStats( rows, note )
    {
        var list = byId( "stList" );
        if( ! list ) return;
        list.innerHTML = "";

        rows.forEach( function ( r )
        {
            var row  = document.createElement( "div" );
            var what = document.createElement( "span" );
            var val  = document.createElement( "b" );
            row.className    = "st-row";
            what.textContent = r.text;
            val.textContent  = typeof r.value === "number" ? r.value.toLocaleString( NayiveUI.locale() ) : r.value;
            row.appendChild( what );
            row.appendChild( val );
            list.appendChild( row );
        } );

        var n = byId( "stNote" );
        if( n )
        {
            n.textContent = note || "";
            n.hidden      = ! note;
        }

        NayiveUI.open( "statsBackdrop" );
    }

    //------------------------------------------------------------------------//
    // THE CLIPBOARD
    //
    // Cut / copy / paste in a menu must move exactly what Ctrl+X / Ctrl+C /
    // Ctrl+V move, formatting and all. Neither editor engine offers that:
    // Write's takes a bare string, Handsontable's takes text, and a page may
    // not call execCommand( "paste" ) at all.
    //
    // What BOTH engines do have is ordinary DOM listeners for "copy" / "cut" /
    // "paste" that work off the event's clipboardData rather than the system
    // clipboard. So a synthetic ClipboardEvent carrying our own DataTransfer
    // drives the very same code the keyboard drives:
    //
    //   copy / cut  - hand the engine an empty DataTransfer, let it fill in
    //                 text/plain + text/html + whatever private formats it
    //                 keeps, then put all of that on the system clipboard;
    //   paste       - read the system clipboard back into a DataTransfer and
    //                 hand it over, and the engine picks the richest form.
    //
    // `node` is where the event is dispatched. It only has to be somewhere the
    // engine's listener will see it - both listen with capture, high up - and
    // Handsontable additionally insists the target be the body or inside its
    // own root, so the apps pass what each engine accepts.
    //
    // Private formats travel as Chrome "web custom formats" (a "web " prefix),
    // which is what makes an app-to-app paste exact. A browser without them
    // still gets text/html, which is already styled; one without
    // clipboard.read() gets plain text. Every rung falls to the next.

    var CLIP_WEB = "web ";

    // The two types a ClipboardItem takes under their own name.
    function clipPlainType( type ) { return type === "text/plain" || type === "text/html"; }

    // Onto the system clipboard, richest form first. Firefox rejects a
    // ClipboardItem holding types it does not know, hence the second rung.
    async function clipWrite( dt )
    {
        function item( all )
        {
            var parts = {}, i, type, data;

            for( i = 0; i < dt.types.length; i++ )
            {
                type = dt.types[ i ];
                if( ! all && ! clipPlainType( type ) ) continue;

                data = dt.getData( type );
                if( ! data ) continue;

                parts[ clipPlainType( type ) ? type : CLIP_WEB + type ] = new Blob( [ data ], { type: type } );
            }

            return new ClipboardItem( parts );
        }

        if( window.ClipboardItem && navigator.clipboard && navigator.clipboard.write )
        {
            try { await navigator.clipboard.write( [ item( true  ) ] ); return true; } catch ( e ) {}

            if( dt.getData( "text/html" ) )
            { try { await navigator.clipboard.write( [ item( false ) ] ); return true; } catch ( e ) {} }
        }

        try { await navigator.clipboard.writeText( dt.getData( "text/plain" ) ); return true; }
        catch ( e ) { return false; }
    }

    // The system clipboard as a DataTransfer. `unsanitized` keeps Chrome from
    // rewriting the HTML on the way out; an older Chrome ignores the unknown
    // option, and a browser with no clipboard.read() leaves us plain text.
    async function clipRead()
    {
        var dt = new DataTransfer(), items = null, i, j, type, name, blob;

        if( navigator.clipboard && navigator.clipboard.read )
        {
            try
            {
                try      { items = await navigator.clipboard.read( { unsanitized: [ "text/html" ] } ); }
                catch ( e ) { items = await navigator.clipboard.read(); }

                for( i = 0; i < items.length; i++ )
                    for( j = 0; j < items[ i ].types.length; j++ )
                    {
                        type = items[ i ].types[ j ];
                        name = type.indexOf( CLIP_WEB ) === 0 ? type.slice( CLIP_WEB.length ) : type;
                        blob = await items[ i ].getType( type );

                        // An image is a file to an engine, never a string.
                        if( name.indexOf( "image/" ) === 0 ) dt.items.add( new File( [ blob ], "image", { type: name } ) );
                        else                                 dt.setData( name, await blob.text() );
                    }

                if( dt.types.length ) return dt;
            }
            catch ( e ) { /* fall through to plain text */ }
        }

        try { dt.setData( "text/plain", await navigator.clipboard.readText() ); }
        catch ( e ) { return null; }

        return dt.types.length ? dt : null;
    }

    function clipEvent( node, kind, dt )
    {
        node.dispatchEvent( new ClipboardEvent( kind,
            { clipboardData: dt, bubbles: true, cancelable: true, composed: true } ) );
    }

    // "empty" = the engine had nothing to give / the clipboard held nothing,
    // "blocked" = the browser refused the clipboard, "ok" = done. The caller
    // words the toast: only it knows what "nothing selected" means on screen.
    var clip =
    {
        out: async function( node, kind )
        {
            if( ! node ) return "empty";

            var dt = new DataTransfer();
            clipEvent( node, kind, dt );

            if( ! dt.types.length ) return "empty";

            return await clipWrite( dt ) ? "ok" : "blocked";
        },

        // `plainOnly` is "paste without formatting": the text alone reaches the
        // engine, so it takes the look of wherever the caret is.
        into: async function( node, plainOnly )
        {
            if( ! node ) return "empty";

            var dt = await clipRead(), txt;

            if( ! dt )              return "blocked";
            if( ! dt.types.length ) return "empty";

            if( plainOnly )
            {
                txt = dt.getData( "text/plain" );
                if( ! txt ) return "empty";

                dt = new DataTransfer();
                dt.setData( "text/plain", txt );
            }

            clipEvent( node, "paste", dt );
            return "ok";
        },

        // A DataTransfer the caller built itself, straight onto the system
        // clipboard. For an engine whose copy EVENT cannot be trusted but whose
        // document API can - see Write's "Edicion > cortar / copiar / pegar".
        put: clipWrite,

        // The system clipboard as a DataTransfer (null = the browser refused),
        // for an engine whose paste is a COMMAND taking the text and the HTML
        // rather than an event - Write's "Edicion > pegar".
        read: clipRead,

        // Plain text both ways, for an editor that has no formats of its own.
        text:  async function()     { try { return await navigator.clipboard.readText(); } catch ( e ) { return null; } },
        write: async function( txt ) { try { await navigator.clipboard.writeText( txt ); return true; } catch ( e ) { return false; } }
    };

    window.NayiveOffice = {
        baseName:       baseName,
        dirName:        dirName,
        extOf:          extOf,
        byBaseName:     byBaseName,
        appDirFromUrl:  appDirFromUrl,
        fileLabel:      fileLabel,
        dirLabel:       dirLabel,
        folderField:    folderField,
        openBrowser:    openBrowser,
        fileMenu:       buttonMenu,
        buttonMenu:     buttonMenu,
        groupPopup:     groupPopup,
        placeHelpButton: placeHelpButton,
        phoneChrome:    phoneChrome,
        foldingToolbar: foldingToolbar,
        autosave:       autosave,
        session:        session,
        withExt:        withExt,
        showShortcuts:  showShortcuts,
        showStats:      showStats,
        appConfig:      appConfig,
        HELP_ITEMS:     HELP_ITEMS,
        HELP_IDS:       HELP_IDS,
        helpMenu:       helpMenu,
        clip:           clip
    };
} )();
