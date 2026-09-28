/*
 * init.js - Drive: start-up: waits for the dictionary, wires the static UI and
 * loads the first folder. A module (the only one) for its top-level await;
 * it reads the state the classic scripts declare. NayiveI18n.ready only
 * comes after every Drive script has run, so it starts the app last even
 * though it loads second.
 */

// Nothing is drawn from JS before the dictionary is in: without an
// in-source fallback, an early render would paint the bare keys.
await NayiveI18n.ready;

//------------------------------------------------------------------------//
// INITIALIZATION

NayiveI18n.ready.then( function()
{
    wireStaticUI();
    _tryAutoAccess_();
});

async function _tryAutoAccess_()
{
    try
    {
        // Folders-only tree — also the auth gate (401 here => not signed in).
        dirTreeRoot = scopeTree( await GumApi.dirTree() );

        // A regular user's "Drive" root IS their files/ folder.
        computeFsRoot();
        currentFolder   = FS_ROOT;
        expandedFolders = new Set( [ FS_ROOT ] );

        document.getElementById( 'app' ).style.display = '';
        await loadListing( FS_ROOT );                       // fills the right pane + renders
        await applyDeepLink();
        pollConvert();   // a conversion may still be running from an earlier upload
        refreshDiskGauge();                                 // fill the server-HD bar under the title
    }
    catch( err )
    {
        // Only a 401 means "not signed in". Anything else - offline, a server
        // hiccup, a bad ?sel= - leaves Drive where it is and says so; a press
        // on the plug tries again (reload()).
        if( err && err.status === 401 ) { GumApi.loginRedirect(); return; }
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
    document.getElementById( 'renameBtn'         ).addEventListener( 'click', openRename );
    document.getElementById( 'copyLinkBtn'       ).addEventListener( 'click', copySelectionLink );
    document.getElementById( 'compressBtn'       ).addEventListener( 'click', compressSelection );
    document.getElementById( 'propsBtn'          ).addEventListener( 'click', openProperties );
    document.getElementById( 'downloadBtn'       ).addEventListener( 'click', downloadSelection );
    document.getElementById( 'deleteBtn'         ).addEventListener( 'click', openDeleteConfirm );
    // New documents are created in the folder currently open in Drive
    // (?dir=), so they save where the user is looking, not the files/ root.
    document.getElementById( 'syncIndicator'     ).addEventListener( 'click', function() { reload(); } );
    document.getElementById( 'trashViewBtn'      ).addEventListener( 'click', function() { trashMode ? closeTrash() : openTrash(); } );
    document.getElementById( 'bigFilesBtn'       ).addEventListener( 'click', function() { bigMode ? endAdvSearch() : openBigFiles(); } );

    wireTopMenu();      // the header's ⋮ (phone) — see B6b in the phone block

    // The "space almost full" card (shared/ui.js) asks for the list here
    // instead of reloading Drive with ?big=1.
    document.addEventListener( 'nayive:bigfiles', function( e ) { e.preventDefault(); openBigFiles(); } );
    initPaneResizer();

    document.getElementById( 'searchInput' ).addEventListener( 'input', function( e )
    {
        searchQuery = e.target.value;
        bigMode     = false;                   // typing a name ends the "Biggest files" list
        selectedPaths.clear();
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
        if( e.key === 'Escape' && e.target.value )
        {
            e.stopPropagation();          // keep the global Escape (dialogs / viewer) out of it
            clearSearch();
            selectedPaths.clear();
            document.querySelector( '.topbar' ).classList.remove( 'searching' );
            render();
            return;
        }

        // ArrowDown drops out of the search box straight into the file list.
        if( e.key === 'ArrowDown' && ! isPhone() )
        {
            e.preventDefault();
            e.target.blur();
            focusPane( 'list' );
        }
    });

    // Phone: the magnifier reveals the search field (which keeps its live filter);
    // tapping it again hides and clears it.
    document.getElementById( 'searchToggleBtn' ).addEventListener( 'click', function()
    {
        const on = document.querySelector( '.topbar' ).classList.toggle( 'searching' );
        if( on ) document.getElementById( 'searchInput' ).focus();
        else     { clearSearch(); selectedPaths.clear(); render(); }
    });

    // The magnifier inside the box: the advanced search dialog (advsearch.js).
    // While one is in force, the button standing in for the box reopens it,
    // and Escape on that button ends it.
    document.getElementById( 'searchBuilderBtn' ).addEventListener( 'click', openSearchBuilder );
    document.getElementById( 'advChip'          ).addEventListener( 'click', openSearchBuilder );
    document.getElementById( 'advChip'          ).addEventListener( 'keydown', function( e )
    {
        if( e.key !== 'Escape' ) return;
        e.stopPropagation();
        endAdvSearch();
    });
    document.getElementById( 'sbCancelBtn' ).addEventListener( 'click', function() { setBackdrop( 'searchBuilderBackdrop', false ); } );
    document.getElementById( 'sbSearchBtn' ).addEventListener( 'click', applySearchBuilder );
    document.getElementById( 'sbClearBtn'  ).addEventListener( 'click', clearSearchBuilder );
    document.getElementById( 'sbAddRule'   ).addEventListener( 'click', addBuilderRule );
    document.getElementById( 'sbFrom'      ).addEventListener( 'input', onBuilderDate );
    document.getElementById( 'sbTo'        ).addEventListener( 'input', onBuilderDate );

    document.getElementById( 'treeBackdrop' ).addEventListener( 'click', closeTreeSheet );
    PHONE.addEventListener( 'change', function() { closeTreeSheet(); render(); } );


    document.getElementById( 'newFolderCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'newFolderBackdrop', false ); } );
    document.getElementById( 'newFolderConfirmBtn' ).addEventListener( 'click', confirmNewFolder );
    document.getElementById( 'newFolderName'       ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) confirmNewFolder(); } );

    document.getElementById( 'propsCloseBtn' ).addEventListener( 'click', function() { setBackdrop( 'propsBackdrop', false ); } );

    document.getElementById( 'renameCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'renameBackdrop', false ); } );
    document.getElementById( 'renameConfirmBtn' ).addEventListener( 'click', confirmRename );
    document.getElementById( 'renameName'       ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) confirmRename(); } );

    document.getElementById( 'deleteCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'deleteBackdrop', false ); } );
    document.getElementById( 'deleteConfirmBtn' ).addEventListener( 'click', confirmDelete );

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

    document.getElementById( 'editorSaveBtn'   ).addEventListener( 'click', saveEditor );
    document.getElementById( 'editorSaveAsBtn' ).addEventListener( 'click', saveEditorAs );
    document.getElementById( 'editorCloseBtn'  ).addEventListener( 'click', function() { closeImageEditor( false ); } );

    document.getElementById( 'saveCopyCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'saveCopyBackdrop', false ); } );
    document.getElementById( 'saveCopyConfirmBtn' ).addEventListener( 'click', confirmSaveCopy );
    document.getElementById( 'saveCopyName'       ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) { e.preventDefault(); confirmSaveCopy(); } } );

    // Media player: only the dark area or the ✕ closes — never a click that
    // lands on the <video>/<audio> element (those go to its own controls).
    document.getElementById( 'mediaCloseBtn' ).addEventListener( 'click', closeMediaViewer );
    document.getElementById( 'mediaBackdrop' ).addEventListener( 'click', function( e )
    {
        if( e.target === this ) closeMediaViewer();
    });
    document.addEventListener( 'keydown', function( e )
    {
        if( e.key !== 'Escape' ) return;

        if( anyCtxMenuOpen() )
        {
            closeCtxMenus();
            return;
        }

        if( isPhone() && document.getElementById( 'treePane' ).classList.contains( 'open' ) )
        {
            closeTreeSheet();
            return;
        }

        if( document.getElementById( 'saveCopyBackdrop' ).classList.contains( 'open' ) )
        {
            setBackdrop( 'saveCopyBackdrop', false );
            return;
        }

        if( document.getElementById( 'editorBackdrop' ).classList.contains( 'open' ) )
        {
            closeImageEditor( false );
            return;
        }

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

        const open = document.querySelector( '.sheet-backdrop.open' );

        if( ! open || open.id === 'progressBackdrop' )   // indeterminate progress is not user-dismissable
            return;

        if( open.id === 'replaceBackdrop' )
        {
            settleReplace( 'cancel' );
            return;
        }

        if( open.id === 'convertBackdrop' )
        {
            settleConvert( 'cancel' );
            return;
        }

        if( open.id === 'importWithBackdrop' )
            openWithPath = null;

        setBackdrop( open.id, false );
    });

    document.addEventListener( 'keydown', onNavKey );
    document.addEventListener( 'keydown', onShortcutKey );

    // A click anywhere in a pane makes it the keyboard-focused one. (Just
    // flips the flag — no re-render here, so the row's own click still lands.)
    document.getElementById( 'treePane' ).addEventListener( 'mousedown', function() { kbdPane = 'tree'; paintKbdPane(); } );
    document.getElementById( 'listing'  ).addEventListener( 'mousedown', function() { kbdPane = 'list'; paintKbdPane(); } );

    const listPane = document.getElementById( 'listPane' );
    listPane.addEventListener( 'dragover', function( e ) { if( dragPaths ) return; e.preventDefault(); listPane.classList.add( 'drag-over' ); } );
    listPane.addEventListener( 'dragleave', function( e )
    {
        // Crossing into a child row fires dragleave on the pane too; only a
        // real exit (relatedTarget outside the pane) hides the cover.
        if( e.relatedTarget && listPane.contains( e.relatedTarget ) ) return;
        listPane.classList.remove( 'drag-over' );
    } );
    listPane.addEventListener( 'drop', onDrop );

    document.getElementById( 'moveToBtn' ).addEventListener( 'click', function() { openFolderPicker( 'move' ); } );
    document.getElementById( 'copyToBtn' ).addEventListener( 'click', function() { openFolderPicker( 'copy' ); } );
    document.getElementById( 'shareBtn' ).addEventListener( 'click', function()
    {
        const tg = actionTargets();
        if( tg.length !== 1 ) return;
        const node = rowNode( tg[ 0 ] );
        NayiveUI.shareSheet( {
            path:   tg[ 0 ],
            app:    (node && isDir( node )) ? 'folder' : 'file',
            title:  tg[ 0 ].split( '/' ).pop(),
            canAdd: !! (node && isDir( node ))   // only a folder can be added to
        } );
    } );

    document.getElementById( 'pickFolderCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'pickFolderBackdrop', false ); } );
    document.getElementById( 'pickFolderConfirmBtn' ).addEventListener( 'click', confirmFolderPicker );

    wireContextMenu();
    wireZip();          // the .zip list and "Extract here" (zip.js)
}
