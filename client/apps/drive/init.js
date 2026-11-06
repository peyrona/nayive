/*
 * init.js - Drive: start-up: waits for the dictionary, wires the static UI and
 * loads the first folder. A module (the only one) for its top-level await;
 * it reads the state the classic scripts declare. Ayni.i18n.ready only
 * comes after every Drive script has run, so it starts the app last even
 * though it loads second.
 */

// Nothing is drawn from JS before the dictionary is in: without an
// in-source fallback, an early render would paint the bare keys.
await Ayni.i18n.ready;

//------------------------------------------------------------------------//
// INITIALIZATION

wireStaticUI();
_tryAutoAccess_();

async function _tryAutoAccess_()
{
    try
    {
        // Folders-only tree — also the auth gate (401 here => not signed in).
        dirTreeRoot = scopeTree( await AyniNet.dirTree() );

        // A regular user's "Home" IS their files/ folder.
        computeFsRoot();
        currentFolder   = FS_ROOT;
        await loadDrivePrefs();                             // Settings: the listing's order, the previews

        document.getElementById( 'app' ).style.display = '';
        await loadListing( FS_ROOT );                       // fills the listing + renders
        loadFolderMarks();                                  // the folders' badges, when they come
        await applyDeepLink();
        pollConvert();   // a conversion may still be running from an earlier upload
        refreshDiskGauge();                                 // fill the server-HD bar under the title
    }
    catch( err )
    {
        // Only a 401 means "not signed in". Anything else - offline, a server
        // hiccup, a bad ?sel= - leaves Drive where it is and says so; a press
        // on the plug tries again (reload()).
        if( err && err.status === 401 ) { AyniNet.loginRedirect(); return; }
        console.error( err );
        document.getElementById( 'app' ).style.display = '';
        setSyncStatus( false );
        setStatus( T( 'drive.reloadError' ) );
    }
}

function wireStaticUI()
{
    document.getElementById( 'newFolderBtn'      ).addEventListener( 'click', function() { openNewFolder(); } );
    document.getElementById( 'uploadBtn'         ).addEventListener( 'click', function() { setBackdrop( 'uploadBackdrop', true ); document.getElementById( 'uploadPickFilesBtn' ).focus(); } );
    document.getElementById( 'uploadCancelBtn'   ).addEventListener( 'click', function() { setBackdrop( 'uploadBackdrop', false ); } );
    document.getElementById( 'uploadPickPhotosBtn').addEventListener( 'click', function() { setBackdrop( 'uploadBackdrop', false ); document.getElementById( 'uploadPhotoInput' ).click(); } );
    document.getElementById( 'uploadPickFilesBtn').addEventListener( 'click', function() { setBackdrop( 'uploadBackdrop', false ); document.getElementById( 'uploadInput' ).click(); } );
    document.getElementById( 'uploadPickDirBtn'  ).addEventListener( 'click', function() { setBackdrop( 'uploadBackdrop', false ); document.getElementById( 'uploadDirInput' ).click(); } );
    document.getElementById( 'uploadInput'       ).addEventListener( 'change', onUploadInputChange );
    document.getElementById( 'uploadDirInput'    ).addEventListener( 'change', onUploadInputChange );
    document.getElementById( 'uploadPhotoInput'  ).addEventListener( 'change', onUploadInputChange );
    // New documents are created in the folder currently open in Drive
    // (?dir=), so they save where the user is looking, not the files/ root.
    document.getElementById( 'syncIndicator'     ).addEventListener( 'click', function() { reload(); } );
    AyniNet.onFilesChanged( onFilesNews );                         // another app saved here (toolbar.js)
    listenStoreSaves();                                           // Write/Calc/Text saves (toolbar.js)
    document.addEventListener( 'visibilitychange', catchUpNews );
    document.getElementById( 'propsBtn'          ).addEventListener( 'click', function()
    {
        openProperties( selectedPaths.size ? Array.from( selectedPaths ) : [ currentFolder ] );
    } );
    document.getElementById( 'trashViewBtn'      ).addEventListener( 'click', function() { trashMode ? closeTrash() : openTrash(); } );
    document.getElementById( 'bigFilesBtn'       ).addEventListener( 'click', function() { bigMode ? endAdvSearch() : openBigFiles(); } );

    // The "space almost full" card (shared/ui.js) asks for the list here
    // instead of reloading Drive with ?big=1.
    document.addEventListener( 'nayive:bigfiles', function( e ) { e.preventDefault(); openBigFiles(); } );
    document.getElementById( 'gridBtn'           ).addEventListener( 'click', function() { setViewMode( 'grid' ); } );
    document.getElementById( 'listBtn'           ).addEventListener( 'click', function() { setViewMode( 'list' ); } );

    document.getElementById( 'searchInput' ).addEventListener( 'input', function( e )
    {
        searchQuery = e.target.value;
        bigMode     = false;                   // typing a name ends the "Biggest files" list
        if( advSearch ) { advSearch = null; showAdvSearchBox(); }      // and an advanced search
        clearSel();
        if( searchTimer ) clearTimeout( searchTimer );

        if( ! searchQuery.trim() )
        {
            searchHits = null;
            searchTruncated = false;
            render();
            return;
        }

        searchHits = null;                     // "Buscando…" until the server answers
        render();
        searchTimer = setTimeout( runSearch, 200 );
    });
    document.getElementById( 'searchInput' ).addEventListener( 'keydown', function( e )
    {
        // (Escape is the field's: it clears the box, then folds it away.)
        // ArrowDown drops out of the search box straight into the file list.
        if( e.key === 'ArrowDown' && ! isPhone() )
        {
            e.preventDefault();
            e.target.blur();
            browse.focus();
        }
    });

    // The magnifier opens the search box (Ayni's folded search field); its
    // funnel opens the advanced search dialog (advsearch.js), and its × /
    // Escape clear the search and fold it.
    driveSearch = Ayni.searchField( document.getElementById( 'searchInput' ).parentElement, {
        filter:    openSearchBuilder,
        filterTip: T( 'drive.sbTitle' ),
        onClose:   function() { clearSearch(); clearSel(); render(); }
    } );
    document.getElementById( 'sbCancelBtn' ).addEventListener( 'click', function() { setBackdrop( 'searchBuilderBackdrop', false ); } );
    document.getElementById( 'sbSearchBtn' ).addEventListener( 'click', applySearchBuilder );
    document.getElementById( 'sbClearBtn'  ).addEventListener( 'click', clearSearchBuilder );
    document.getElementById( 'sbAddRule'   ).addEventListener( 'click', addBuilderRule );
    // Ayni's date fields: a pick, or a typed date taken, updates the draft
    Ayni.dateField( document.getElementById( 'sbFrom' ), { onChange: onBuilderDate } );
    Ayni.dateField( document.getElementById( 'sbTo' ),   { onChange: onBuilderDate } );

    PHONE.addEventListener( 'change', function() { render(); } );


    document.getElementById( 'newFolderCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'newFolderBackdrop', false ); } );
    document.getElementById( 'newFolderConfirmBtn' ).addEventListener( 'click', confirmNewFolder );
    document.getElementById( 'newFolderName'       ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) { e.preventDefault(); confirmNewFolder(); } } );

    document.getElementById( 'propsCloseBtn' ).addEventListener( 'click', function() { setBackdrop( 'propsBackdrop', false ); } );

    document.getElementById( 'renameCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'renameBackdrop', false ); } );
    document.getElementById( 'renameConfirmBtn' ).addEventListener( 'click', confirmRename );
    document.getElementById( 'renameName'       ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) { e.preventDefault(); confirmRename(); } } );
    document.getElementById( 'renameName'       ).addEventListener( 'input', noSlash );
    document.getElementById( 'renameName'       ).addEventListener( 'paste', pasteName );


    document.getElementById( 'replaceCancelBtn'  ).addEventListener( 'click', function() { settleReplace( 'cancel' ); } );
    document.getElementById( 'replaceConfirmBtn' ).addEventListener( 'click', function()
    {
        settleReplace( document.getElementById( 'replaceOverwrite' ).checked ? 'overwrite' : 'skip' );
    });

    document.getElementById( 'convertCancelBtn' ).addEventListener( 'click', function() { settleConvert( 'cancel' ); } );
    document.getElementById( 'convertYesBtn'    ).addEventListener( 'click', function() { settleConvert( 'convert' ); } );
    document.getElementById( 'convertNoBtn'     ).addEventListener( 'click', function() { settleConvert( 'plain' ); } );
    document.getElementById( 'convertPushBtn'   ).addEventListener( 'click', function()
    {
        // The switch lives in the launcher's "Mi cuenta". A NEW tab, so
        // this upload is not lost; it copies sessionStorage, so the
        // launcher's reopen note opens the dialog there.
        try { sessionStorage.setItem( 'balata-acct-reopen', '1' ); } catch( _ ) {}
        window.open( '../', '_blank' );
        try { sessionStorage.removeItem( 'balata-acct-reopen' ); } catch( _ ) {}
    });

    document.getElementById( 'importWithCancelBtn' ).addEventListener( 'click', function() { openWithPath = null; setBackdrop( 'importWithBackdrop', false ); } );
    for( const app in OPEN_WITH_BTN )
        document.getElementById( OPEN_WITH_BTN[ app ] )
                .addEventListener( 'click', function( a ) { return function() { chooseOpenWith( a ); }; }( app ) );

    document.getElementById( 'viewerBackdrop' ).addEventListener( 'click', closeImageViewer );   // click anywhere (image, backdrop or ✕) closes

    // Media player: only the dark area or the ✕ closes — never a click that
    // lands on the <video>/<audio> element (those go to its own controls).
    document.getElementById( 'mediaCloseBtn' ).addEventListener( 'click', closeMediaViewer );
    document.getElementById( 'mediaBackdrop' ).addEventListener( 'click', function( e )
    {
        if( e.target === this ) closeMediaViewer();
    });
    document.addEventListener( 'keydown', function( e )
    {
        // (The menu closes itself on Escape; an open dialog takes it - Ayni.)
        if( e.key !== 'Escape' || e.defaultPrevented || document.querySelector( 'dialog.panel[open]' ) ) return;

        if( document.getElementById( 'viewerBackdrop' ).classList.contains( 'open' ) )
        {
            closeImageViewer();
            return;
        }

        if( document.getElementById( 'mediaBackdrop' ).classList.contains( 'open' ) )
        {
            closeMediaViewer();
            return;
        }

        // A dialog: Ayni presses its × (data-close), whose handler cancels
        // (settleReplace / settleConvert / openWithPath = null).
    });

    // An indeterminate progress is not user-dismissable: Escape stops at it.
    document.getElementById( 'progressBackdrop' ).addEventListener( 'keydown', function( e ) { if( e.key === 'Escape' ) e.preventDefault(); } );


    const listPane = document.getElementById( 'listPane' );
    listPane.addEventListener( 'dragover', function( e ) { if( Ayni.dragIds() ) return; e.preventDefault(); listPane.classList.add( 'drag-over' ); } );
    listPane.addEventListener( 'dragleave', function( e )
    {
        // Crossing into a child row fires dragleave on the pane too; only a
        // real exit (relatedTarget outside the pane) hides the cover.
        if( e.relatedTarget && listPane.contains( e.relatedTarget ) ) return;
        listPane.classList.remove( 'drag-over' );
    } );
    listPane.addEventListener( 'drop', onDrop );

    wireBrowser();      // picking, the actions, the menu and the drops (menus.js)
    wireZip();          // the .zip list and "Extract here" (zip.js)
    wireSettings();     // the Settings dialog (settings.js)
}
