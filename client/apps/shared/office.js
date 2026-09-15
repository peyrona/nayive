/*
 * office.js - what the three document editors (Calc, Text, Write) share.
 *
 * Classic script, one global `NayiveOffice`. Load it deferred, after ui.js
 * (it calls NayiveUI at run time, never while it is parsed):
 *     <script src="../shared/ui.js" defer></script>
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

    //------------------------------------------------------------------------//
    // PATHS

    function baseName( path ) { return String( path || "" ).split( "/" ).pop(); }

    function dirName( path )
    {
        var p = String( path || "" ), i = p.lastIndexOf( "/" );
        return i > 0 ? p.slice( 0, i ) : "";
    }

    // "hoja.XLSX" -> "xlsx" (no dot, lower case); "" when there is none.
    function extOf( path )
    {
        var m = /\.([a-z0-9]+)$/i.exec( String( path || "" ) );
        return m ? m[ 1 ].toLowerCase() : "";
    }

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

        function set( text ) { label.textContent = text; }
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

        return { list: list, add: add };
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

            var head = document.createElement( "div" );
            head.className   = "section-label";
            head.textContent = t( "ui.recent" );
            box.appendChild( head );

            var ul = document.createElement( "ul" );
            ul.className = "open-list";
            paths.forEach( function ( p )
            {
                var li = row( "doc", baseName( p ), false );
                li.querySelector( ".open-nm" ).title = p;      // the folder it is in
                li.addEventListener( "click", function () { pick( p ); } );
                ul.appendChild( li );
            } );
            box.appendChild( ul );
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
    function fileMenu( opts )
    {
        var menu = byId( opts.menu || "topMenu" );
        ( opts.ids || [] ).forEach( function ( id )
        {
            var src = byId( id );
            var svg = src && src.querySelector( "svg" );
            if( ! svg ) return;
            var item = document.createElement( "button" );
            item.type         = "button";
            item.className    = "menu-item";
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
    //   saver.saveNow()           Ctrl+S
    //   saver.saveTo( path )      "Guardar como": write there; the app then makes it the open doc
    //   saver.opened( o )         another document is on screen; o.pristine = imported bytes, o.dirty
    //   saver.moved( from, to )   the open document was renamed
    //   saver.dirty()             edited since it was opened or last saved
    //   saver.takeDraft()         at boot: the device draft -> { name, body, at } or null
    //   saver.restored( d )       the app has put that draft on screen
    //   saver.dropDraft()         the user threw the untitled document away
    //
    // What it does:
    //   - saves 7 s after the last edit, and at least every 3 min while typing
    //   - a document with nowhere to save to (untitled, or someone else's) goes
    //     to a DRAFT on this device only - IndexedDB "nayive-drafts", one per
    //     app, never the store's own database (bumping its version would block
    //     on another open tab and silently turn the store online-only). The
    //     session asks an untitled one for its name and folder at the first
    //     pause after its first edit; that save drops the draft.
    //   - one .bak/<name> beside the document: the server's copy from before
    //     the document's first save in this session
    //   - "Guardado 12:04" / "Borrador 12:04" in #savedAt
    //   - a file saved from another device since it was opened: the store gets
    //     a 412, keeps the edits here, and the user is offered a copy
    //   - closing the tab asks only while something is NOT safe yet: a save
    //     waiting or running, or one that was refused
    //
    // Paired CSS: .saved-at in the OFFICE CHROME block of app.css.

    var SAVE_DELAY_MS    = 7000;          // quiet time after the last edit
    var SAVE_MAX_WAIT_MS = 3 * 60000;     // longest an edit waits while typing goes on

    // The server's copy from before a session's first save lives here.
    function bakPath( path ) { return ( dirName( path ) || "files" ) + "/.bak/" + baseName( path ); }

    // ---- the device draft store ---------------------------------------------

    var draftDb = null;

    function openDrafts()
    {
        if( draftDb ) return draftDb;

        draftDb = new Promise( function ( resolve )
        {
            var rq;
            try { rq = indexedDB.open( "nayive-drafts", 1 ); }
            catch ( e ) { resolve( null ); return; }

            rq.onupgradeneeded = function () { rq.result.createObjectStore( "drafts", { keyPath: "app" } ); };
            rq.onsuccess = function () { resolve( rq.result ); };
            rq.onerror = rq.onblocked = function () { resolve( null ); };
        } );
        return draftDb;
    }

    // fn( objectStore ) -> request; resolves with its result, null on any failure.
    function draftTx( mode, fn )
    {
        return openDrafts().then( function ( db )
        {
            if( ! db ) return null;

            return new Promise( function ( resolve )
            {
                try
                {
                    var tx = db.transaction( "drafts", mode );
                    var rq = fn( tx.objectStore( "drafts" ) );
                    tx.oncomplete = function () { resolve( rq.result === undefined ? null : rq.result ); };
                    tx.onerror = tx.onabort = function () { resolve( null ); };
                }
                catch ( e ) { resolve( null ); }
            } );
        } );
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

        function sync( s )  { if( o.setSync ) o.setSync( s ); }
        function path()     { return o.path(); }
        function writable() { return !! path() && ! o.readOnly(); }

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
            return writable() ? writeTo( path() ) : keepDraft();
        }

        function edited()
        {
            dirty = true;

            if( writable() )
            {
                if( o.blocked && o.blocked( path() ) ) return;   // the app decides; no timer meanwhile
                sync( navigator.onLine ? "saving" : "offline" );
            }
            else if( ! path() ) sync( "unsaved" );              // nothing on the server to save TO yet

            arm();
        }

        function flush() { return timer ? run() : Promise.resolve(); }

        async function writeTo( p )
        {
            if( o.blocked && o.blocked( p ) ) return null;

            var mine = ++seq;
            busy++;
            try
            {
                sync( "saving" );

                var body;
                try { body = await o.encode( p ); }
                catch ( e )
                {
                    if( mine === seq )
                    {
                        failed = true;
                        sync( "error" );
                        if( o.failKey ) NayiveUI.toast( t( o.failKey ) );
                    }
                    return null;
                }
                if( mine !== seq ) return null;        // a newer save started meanwhile - it wins

                await backup( p );
                if( mine !== seq ) return null;

                var res = ( await o.store.write( p, body ) ) || {};
                if( mine !== seq ) return res;

                if( res.conflict )
                {
                    failed = true;
                    offerCopy( p );
                    return res;
                }

                // Offline / queued / needs-auth all keep the body safe on this
                // device (the store's cache + outbox): saved, from the user's side.
                // Only a hard refusal is a failure.
                failed = res.ok === false && ! res.offline && ! res.needsAuth;
                if( res.forbidden ) NayiveUI.toast( t( "ui.saveFailed" ) );
                if( ! failed )
                {
                    if( ! timer ) dirty = false;       // an edit made meanwhile is still waiting
                    stamp( "write.savedAt", Date.now() );
                }
                return res;
            }
            finally { busy--; }
        }

        async function keepDraft()
        {
            var mine = ++seq;
            busy++;
            try
            {
                var body;
                try { body = await o.encode( null ); }
                catch ( e ) { return null; }
                if( mine !== seq ) return null;

                var at  = Date.now();
                var put = await draftTx( "readwrite", function ( os )
                {
                    return os.put( { app: o.app, name: ( o.name && o.name() ) || null, body: body, at: at } );
                } );
                if( put && mine === seq )
                {
                    drafted = true;
                    stamp( "ui.draftAt", at, t( "ui.draftNote" ) );
                }
                return null;
            }
            finally { busy--; }
        }

        // One copy of the server's version per document per session, taken
        // before the first save - not on every save, or .bak would just follow
        // the live document and be worthless as "the previous version". Best
        // effort: skipped offline; when there is no server copy yet (the first
        // save of an import) the imported original is used.
        async function backup( p )
        {
            if( backedUp.has( p ) || ! navigator.onLine ) return;

            try
            {
                var prev = null;
                try { prev = await GumApi.readFileBytes( p ); }
                catch ( e ) { prev = pristine; }

                if( prev && prev.length )
                {
                    // The document can sit in any folder ("Guardar como" asks for
                    // one), so make its .bak/ first. Already there = a harmless refusal.
                    try { await GumApi.makeDir( dirName( p ) || "files", ".bak" ); } catch ( e ) {}
                    await GumApi.writeFileBytes( bakPath( p ), prev );
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

        async function saveTo( p )
        {
            savingAs = true;
            try
            {
                await flush();                // what is waiting goes to the OLD place first
                var from = path();
                var res  = await writeTo( p );

                if( ! res || failed ) return res;

                if( drafted ) { drafted = false; draftTx( "readwrite", function ( os ) { return os.delete( o.app ); } ); }

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
            dirty    = !! x.dirty;
            failed   = false;
            drafted  = false;
            askedFor = null;
            pristine = x.pristine || null;
            stamp( null );

            // Reopened with an edit still held back as a conflict: say so now.
            var p = path();
            if( p && ! o.readOnly() )
                o.store.conflicted( p ).then( function ( c ) { if( c && p === path() ) offerCopy( p ); } );
        }

        function moved( from, to ) { if( backedUp.has( from ) ) backedUp.add( to ); }

        // ---- the device draft -----------------------------------------------

        // The untitled document of an earlier visit. No question here: the
        // session puts it back on screen and asks for its name.
        async function takeDraft()
        {
            var d = await draftTx( "readonly", function ( os ) { return os.get( o.app ); } );
            return d && d.body != null ? d : null;
        }

        function restored( d )
        {
            drafted = true;
            dirty   = true;
            sync( "unsaved" );
            stamp( "ui.draftAt", d.at, t( "ui.draftNote" ) );
        }

        function dropDraft()
        {
            drafted = false;
            return draftTx( "readwrite", function ( os ) { return os.delete( o.app ); } );
        }

        // ---- leaving --------------------------------------------------------

        document.addEventListener( "visibilitychange", function () { if( document.visibilityState === "hidden" ) flush(); } );
        window.addEventListener( "pagehide", function () { flush(); } );
        window.addEventListener( "beforeunload", function ( e )
        {
            if( ! timer && ! busy && ! failed ) return;
            flush();                          // start it now, in case they stay
            e.preventDefault();
            e.returnValue = "";
        } );

        // A background flush (reconnect, tab focus) can meet the conflict too.
        o.store.onConflict( function ( p ) { if( p === path() ) offerCopy( p ); } );

        return {
            edited:    edited,
            flush:     flush,
            saveNow:   saveNow,
            saveTo:    saveTo,
            opened:    opened,
            moved:     moved,
            dirty:     function () { return dirty; },
            takeDraft: takeDraft,
            restored:  restored,
            dropDraft: dropDraft
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
    //       blank:       async function () {...},                   // put an empty document on screen
    //       // optional:
    //       canOpen:     function ( path ) {...},       // which files the Open dialog lists (default: all)
    //       onPick:      function ( path ) {...},       // a file was picked there (default: open it)
    //       emptyKey:    "calc.noSheets",               // its "nothing here" line
    //       finishName:  function ( name, fmt ) {...},  // "Guardar como": the final name, null = stay in the dialog
    //       renameName:  function ( typed, path ) {...},// rename in place: the new file name
    //       blocked:     function ( path ) {...},       // true = do not write it now (Calc's loss gate)
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
    //   session.openDialog()  .recent()        the "Abrir documento" sheet
    //
    // It wires whatever the page has of: #newBtn, #openBtn, #importBtn +
    // #importInput, #saveAsBtn, #restoreBtn, the "Abrir documento" sheet
    // (#openBackdrop, #openRecent, #openCrumb, #openList), the "Guardar como"
    // sheet (#saveAsBackdrop, #saveName, #saveFormat, #saveDirBtn,
    // #saveAsConfirmBtn, #saveAsDeleteBtn) and the file label.
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

    function session( o )
    {
        var path     = null;     // relative to the file root; null = untitled
        var readOnly = false;    // someone else's file ("shared/..."): read, never written
        var pending  = null;     // the name of a document that has none on the server yet
        var asked    = false;    // this untitled document was already offered "Guardar como"
        var askTimer = null;

        var sync     = NayiveUI.syncIndicator( { titles: OFFICE_TITLES } );
        var label    = fileLabel( { onCommit: rename } );
        var dirField = folderField( { dir: o.appDir } );
        var saver    = autosave( {
            app:      o.app,
            store:    o.store,
            path:     function () { return path; },
            readOnly: function () { return readOnly; },
            name:     function () { return pending || ( path && baseName( path ) ); },
            encode:   o.encode,
            blocked:  o.blocked,
            failKey:  "ui.saveFailed",
            setSync:  sync,
            saveAs:   openSaveAs
        } );

        // The store drives the plug for every read and write - from the first one.
        o.store.onState( sync );

        // "Abrir documento": the same sheet in the three apps - the recent
        // documents over a folder browser. The app only says which files it can
        // open (`canOpen`), and what to do with the one picked when that is not
        // simply opening it (`onPick`: Calc and Write convert a foreign format
        // first). With no network the folder tree cannot be walked, so it lists
        // what this app has in the offline store instead.
        var recent  = recentFiles( o.app );
        var browser = openBrowser( {
            root:     o.openRoot,
            canOpen:  o.canOpen || function () { return true; },
            onOpen:   function ( p ) { if( o.onPick ) o.onPick( p ); else open( p ); },
            emptyKey: o.emptyKey,
            recent:   recent.list,
            offline:  async function ()
            {
                var cached = await o.store.listCached( o.openRoot + "/" );
                return cached.filter( function ( p )
                {
                    return p.indexOf( "/.bak/" ) === -1 && ( ! o.canOpen || o.canOpen( p ) );
                } );
            }
        } );

        function openDialog() { browser.open( o.appDir ); }

        function toast( k ) { NayiveUI.toast( t( k ) ); }

        function showLabel()
        {
            label.set( path ? relLabel( path, o.appDir, o.openRoot ) + ( readOnly ? t( "text.readOnlySuffix" ) : "" )
                            : ( pending || t( "ui.untitled" ) ) );
            if( o.onChange ) o.onChange();
        }

        function notReady()
        {
            if( ! o.ready || o.ready() ) return false;
            toast( "write.waitForDoc" );
            return true;
        }

        // ---- what is on screen ----------------------------------------------

        function opened( p )
        {
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
            path     = null;
            readOnly = false;
            pending  = name || null;
            asked    = false;
            clearTimeout( askTimer );
            askTimer = null;
            saver.opened( x );
            showLabel();
            if( x.dirty ) sync( "unsaved" );   // on screen, not on the server yet
        }

        async function open( p )
        {
            await saver.flush();               // don't lose a waiting autosave for the one we're leaving

            var res = await readViaStore( o.store, p );   // the store drives the plug; toasts on trouble
            if( res.body === null ) return false;

            try { await o.load( res.body, p, "open" ); }
            catch ( e )
            {
                sync( "error" );
                toast( "ui.openFailed" );
                return false;
            }

            opened( p );
            return true;
        }

        // An import opens UNTITLED, so its first save asks where it goes. The
        // original bytes are the first .bak copy.
        async function importBytes( bytes, name )
        {
            try { await o.load( bytes, name, "import" ); }
            catch ( e ) { toast( "text.importFailed" ); return false; }

            untitled( name, { pristine: bytes, dirty: true } );
            return true;
        }

        async function importFile( file )
        {
            if( ! file || notReady() ) return;
            await saver.flush();

            var bytes;
            try { bytes = new Uint8Array( await file.arrayBuffer() ); }
            catch ( e ) { toast( "text.importFailed" ); return; }

            await importBytes( bytes, file.name );
        }

        // Drive's "Abrir con" of a file another app owns: ?import=<path>.
        async function importPath( p )
        {
            var bytes;
            try { bytes = await GumApi.readFileBytes( p ); }
            catch ( e ) { toast( "text.importFailed" ); return false; }

            return importBytes( bytes, baseName( p ) );
        }

        async function boot()
        {
            var q    = new URLSearchParams( location.search );
            var file = q.get( "file" );
            var imp  = q.get( "import" );

            if( file && await open( file ) ) return;
            if( ! file && imp && await importPath( imp ) ) return;

            if( ! file && ! imp )
            {
                // The untitled document from an earlier visit, kept on this device.
                var d = await saver.takeDraft();
                if( d )
                {
                    try
                    {
                        await o.load( d.body, d.name, "draft" );
                        untitled( d.name );
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

        // A blank document without leaving the app. An untitled one with edits
        // is only in the device draft, so it asks first - and then drops it.
        async function newDocument()
        {
            if( notReady() ) return;

            var dropping = saver.dirty() && ! path;
            if( dropping && ! await NayiveUI.confirm( { title: t( "write.newDoc" ), body: t( "write.newDropsDraft" ),
                                                        confirm: t( "write.newDoc" ) } ) ) return;

            await startBlank( dropping );
        }

        // "Guardar como"'s bin, shown only for a document that is nowhere but
        // on this device: throw it away and start blank. No second question -
        // pressing a red bin inside a dialog already is one.
        async function discardUntitled()
        {
            if( path || notReady() ) return;
            NayiveUI.close( "saveAsBackdrop" );
            await startBlank( true );
        }

        async function startBlank( dropping )
        {
            await saver.flush();               // a named document keeps its waiting autosave
            if( dropping ) await saver.dropDraft();

            try { await o.blank(); }
            catch ( e ) { toast( "ui.openFailed" ); return; }

            untitled( null );
            o.store.resting();                 // nothing was read or written: settle the plug by hand
            if( o.focus ) o.focus();
        }

        // ---- a new document asks for its name ---------------------------------
        //
        // Once, at the first pause after its first edit - never mid-word, or the
        // rest of the word would land in the name field. ✗ keeps it untitled
        // (the device draft goes on as its backup) and it is not asked again.
        // An import or a template waits for its first edit too.

        function edited()
        {
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
        if( saveBack && o.focus )
            new MutationObserver( function ()
            {
                var now = saveBack.classList.contains( "open" );
                if( saveOpen && ! now ) o.focus();
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

            NayiveUI.close( "saveAsBackdrop" );

            // saveTo lands any waiting autosave under the OLD name first, then
            // writes here - and a new destination gets its own .bak copy.
            var p = dirField.get() + "/" + name;
            await saver.saveTo( p );

            path     = p;
            readOnly = false;
            pending  = null;
            showLabel();
            if( o.onSavedAs ) o.onSavedAs( p );
            if( o.focus ) o.focus();
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

            sync( "saving" );
            try
            {
                // The latest body under the OLD name, and nothing queued for it:
                // a PUT flushing after the move would recreate the old file.
                await saver.flush();
                try { await o.store.flush(); } catch ( e ) {}

                await GumApi.rename( path, to );
                try { await o.store.forget( path ); } catch ( e ) {}   // only now is the old cache entry stale

                saver.moved( path, to );
                path = to;
                showLabel();
                sync( "synced" );
            }
            catch ( e )
            {
                sync( "error" );
                toast( "text.renameFailed" );
            }
        }

        // ---- "Restaurar la copia anterior" ------------------------------------
        //
        // ONE .bak per document, taken before its first save of the session. The
        // order matters: read the copy FIRST, then write what is on screen over
        // it, and only then load - so restoring is itself undoable.
        async function restorePrevious()
        {
            if( notReady() ) return;
            if( ! path )   { toast( "write.noBackupYet" ); return; }
            if( readOnly ) { toast( "text.notYours" );     return; }

            var bak  = bakPath( path );
            var prev = null;
            try { prev = await GumApi.readFileBytes( bak ); } catch ( e ) { prev = null; }
            if( ! prev || ! prev.length ) { toast( "write.noBackupYet" ); return; }

            var ok = await NayiveUI.confirm( { title:   t( "write.restore" ),
                                               body:    tf( "write.restoreBody", { size: NayiveUI.fmtBytes( prev.length ) } ),
                                               confirm: t( "write.restore" ) } );
            if( ! ok ) return;

            try
            {
                var now = await o.encode( path );
                await GumApi.writeFileBytes( bak, typeof now === "string" ? new TextEncoder().encode( now ) : now );
                await o.load( prev, path, "restore" );
                saver.edited();                // the restored copy still has to be saved over the document
                toast( "write.restored" );
            }
            catch ( e ) { toast( "write.actionFailed" ); }
        }

        // ---- the buttons and the sheet ------------------------------------------

        function on( id, ev, fn ) { var el = byId( id ); if( el ) el.addEventListener( ev, fn ); }

        on( "newBtn",           "click",   function () { newDocument(); } );
        on( "openBtn",          "click",   function () { openDialog(); } );
        on( "restoreBtn",       "click",   function () { restorePrevious(); } );
        on( "importBtn",        "click",   function () { if( byId( "importInput" ) ) byId( "importInput" ).click(); } );
        on( "importInput",      "change",  function ( e ) { var f = e.target.files[ 0 ]; e.target.value = ""; importFile( f ); } );
        on( "saveAsBtn",        "click",   function () { openSaveAs(); } );
        on( "saveAsConfirmBtn", "click",   function () { confirmSaveAs(); } );
        on( "saveAsDeleteBtn",  "click",   function () { discardUntitled(); } );
        on( "saveName",         "keydown", function ( e ) { if( e.key === "Enter" ) confirmSaveAs(); } );

        return {
            path:       function () { return path; },
            readOnly:   function () { return readOnly; },
            name:       function () { return pending; },
            boot:       boot,
            open:       open,
            untitled:   untitled,
            edited:     edited,
            flush:      saver.flush,
            saveNow:    saver.saveNow,
            dirty:      saver.dirty,
            openSaveAs: openSaveAs,
            openDialog: openDialog,
            recent:     recent.list
        };
    }

    //------------------------------------------------------------------------//

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

    window.NayiveOffice = {
        baseName:       baseName,
        dirName:        dirName,
        extOf:          extOf,
        byBaseName:     byBaseName,
        relLabel:       relLabel,
        safeName:       safeName,
        appDirFromUrl:  appDirFromUrl,
        readViaStore:   readViaStore,
        fileLabel:      fileLabel,
        dirLabel:       dirLabel,
        folderField:    folderField,
        openBrowser:    openBrowser,
        recentFiles:    recentFiles,
        fileMenu:       fileMenu,
        placeHelpButton: placeHelpButton,
        foldingToolbar: foldingToolbar,
        autosave:       autosave,
        session:        session,
        bakPath:        bakPath,
        withExt:        withExt,
        showShortcuts:  showShortcuts
    };
} )();
