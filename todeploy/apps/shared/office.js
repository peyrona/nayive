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
 * This is the one copy (2026-09-06). What is NOT here, on purpose, is policy
 * that differs between the three - how a name is completed with an
 * extension, what "save as" writes, when autosave runs - that stays per app.
 *
 * Paired CSS: the OFFICE CHROME block in shared/app.css (.file-label,
 * .open-crumb, .open-list, .folder-pick) and the "MORE" MENU block (.top-menu).
 */
( function ()
{
    "use strict";

    function byId( id ) { return document.getElementById( id ); }
    function t( k )     { return window.NayiveUI ? NayiveUI.t( k ) : k; }

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
    // "ABRIR DOCUMENTO"  -  a plain folder browser over the user's files/
    //
    //   var browser = NayiveOffice.openBrowser( {
    //       backdropId: "openBackdrop",          // the .sheet-backdrop to open
    //       root:       OPEN_ROOT,               // never walks above this
    //       canOpen:    function ( path ) {...}, // which files are listed
    //       onOpen:     function ( path ) {...}, // a file was picked
    //       emptyKey:   "calc.noSheets",         // "nothing here" line
    //       offline:    async function () {...}  // optional: cached paths to list with no network
    //   } );
    //   browser.open( startDir );
    //
    // One level at a time; every breadcrumb segment jumps there. Offline it
    // shows the app's cached documents when `offline` is given, else a note.
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

        function open( startDir )
        {
            cwd = startDir || opts.root;
            NayiveUI.open( opts.backdropId || "openBackdrop" );
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
        fileMenu:       fileMenu,
        placeHelpButton: placeHelpButton,
        foldingToolbar: foldingToolbar
    };
} )();
