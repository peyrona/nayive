/*
 * navigate.js - Drive: the folder tree and breadcrumb, navigateTo and loadListing.
 */
"use strict";

function renderTree()
{
    const host = document.getElementById( 'treePane' );
    host.innerHTML = '';
    host.appendChild( buildTreeNode( findNode( FS_ROOT ) || dirTreeRoot, 0 ) );

    // Everything other people shared with us hangs off its own root, next
    // to Drive. It is a virtual folder (lib/shares.py) — the paths inside
    // it are real, they just point into someone else's home, read-only.
    const shared = findNode( 'shared' );
    if( shared ) host.appendChild( buildTreeNode( shared, 0, T( 'drive.sharedWithMe' ) ) );
}

function buildTreeNode( node, depth, rootLabel )
{
    const wrap = document.createElement( 'div' );
    wrap.className = 'tree-node';

    const subDirs = (node.nodes || []).filter( isDir ).sort( function( a, b )
    {
        return displayName( a ).localeCompare( displayName( b ), NayiveUI.lang(), { sensitivity: 'base', numeric: true } );
    });
    const isOpen  = expandedFolders.has( node.path );

    const row = document.createElement( 'div' );
    // Only the open folder is highlighted: a folder selected in the list is
    // already shown there, and two lit rows here read as two open folders.
    row.className = 'tree-row'
                  + (node.path === currentFolder ? ' selected' : '')
                  + (kbdPane === 'tree' && node.path === kbdTreePath ? ' kbd' : '');
    row.dataset.path = node.path;

    const twisty = document.createElement( 'span' );
    twisty.className = 'twisty' + (subDirs.length ? (isOpen ? ' open' : '') : ' leaf');
    twisty.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    twisty.addEventListener( 'click', function( e )
    {
        e.stopPropagation();
        if( ! subDirs.length ) return;
        if( isOpen ) expandedFolders.delete( node.path ); else expandedFolders.add( node.path );
        renderTree();
    });

    const folderIc = document.createElement( 'span' );
    folderIc.className = 'folder-ic';
    folderIc.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';

    const label = document.createElement( 'span' );
    label.className   = 'tree-name';
    label.textContent = depth === 0 ? (rootLabel || 'Drive') : displayName( node );

    row.appendChild( twisty );
    row.appendChild( folderIc );
    row.appendChild( label );

    // Every folder but the "Drive" root gets the same per-item actions the
    // right pane offers: right-click on desktop, a ⋮ button on touch, plus
    // drag-to-move. They act on this folder without navigating into it.
    if( depth > 0 )
    {
        const menuBtn = document.createElement( 'button' );
        menuBtn.className = 'icon-btn sm row-menu';
        menuBtn.title     = T( 'ui.actions' );
        menuBtn.setAttribute( 'aria-label', T( 'ui.actions' ) );
        menuBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>';
        menuBtn.addEventListener( 'click', function( e )
        {
            e.stopPropagation();
            const r = menuBtn.getBoundingClientRect();
            openTreeMenuFor( node.path, r.right, r.bottom );
        });
        row.appendChild( menuBtn );

        row.addEventListener( 'contextmenu', function( e )
        {
            e.preventDefault();
            e.stopPropagation();
            openTreeMenuFor( node.path, e.clientX, e.clientY );
        });

        makeDraggable( row, node );
    }

    row.addEventListener( 'click', function() { navigateTo( node.path ); } );
    makeDropTarget( row, function() { return node.path; } );

    wrap.appendChild( row );

    const childrenHost = document.createElement( 'div' );
    childrenHost.className = 'tree-children' + (isOpen ? ' open' : '');

    subDirs.forEach( function( c ) { childrenHost.appendChild( buildTreeNode( c, depth + 1 ) ); } );

    wrap.appendChild( childrenHost );

    return wrap;
}

function renderBreadcrumb()
{
    const host = document.getElementById( 'breadcrumb' );
    host.innerHTML = '';

    // The "Drive" crumb doubles as the folder-tree opener on phone, so it is
    // always shown — even in search mode.
    const searching = isSearching();
    const rootCrumb = document.createElement( 'span' );
    rootCrumb.className   = 'crumb crumb-root' + (currentFolder === FS_ROOT && ! searching ? ' current' : '');
    rootCrumb.textContent = 'Drive';
    rootCrumb.addEventListener( 'click', function() { isPhone() ? openTreeSheet() : navigateTo( FS_ROOT ); } );
    host.appendChild( rootCrumb );

    if( searching )
    {
        const sep = document.createElement( 'span' );
        sep.className   = 'crumb-sep';
        sep.textContent = '/';
        host.appendChild( sep );

        const info = document.createElement( 'span' );
        info.className   = 'crumb current';
        info.textContent = TF( 'movies.resultsFor', { q: searchQuery.trim() } );
        if( bigMode )        bigFilesCrumbs( host, info );      // listing.js
        else if( advSearch ) advSearchCrumbs( host, info );     // advsearch.js
        else                 host.appendChild( info );
        return;
    }

    // "shared/..." is not under FS_ROOT (files/): it is the other virtual
    // root, so its crumbs are built from the real path, and the first
    // segment is shown by its Spanish name.
    const inShared = currentFolder === 'shared' || currentFolder.indexOf( 'shared/' ) === 0;
    const segs  = splitPath( inShared ? currentFolder : fsRel( currentFolder ) );
    let   accum = inShared ? '' : FS_ROOT;

    segs.forEach( function( seg, i )
    {
        accum = accum ? accum + '/' + seg : seg;
        const path = accum;

        const sep = document.createElement( 'span' );
        sep.className   = 'crumb-sep';
        sep.textContent = '/';
        host.appendChild( sep );

        const crumb = document.createElement( 'span' );
        crumb.className   = 'crumb' + (i === segs.length - 1 ? ' current' : '');
        // "shared" -> its Spanish name; "shared/<slug>" -> the grant's real
        // title ("le-nord" -> "Le Nord"); anything deeper is a real folder
        // name already.
        crumb.textContent = inShared
                          ? ( i === 0 ? T( 'drive.sharedWithMe' )
                            : i === 1 ? displayName( rowNode( path ) || { path: path } )
                            : seg )
                          : seg;
        crumb.addEventListener( 'click', function() { navigateTo( path ); } );
        host.appendChild( crumb );
    });
}

// True while the open folder is one somebody shared with us AND they let us
// add files to it. Answered by the grant (NayiveUI.canAddTo -> /api/shares,
// fetched once per page), so it lands a moment after the folder does — the
// toolbar is repainted when it arrives.
let canAddHere = false;

function refreshCanAdd( path )
{
    canAddHere = false;
    updateToolbarState();
    NayiveUI.canAddTo( path ).then( function( yes )
    {
        if( path !== currentFolder ) return;    // navigated on while we asked
        canAddHere = yes;
        updateToolbarState();
    } );
}

function navigateTo( path )
{
    currentFolder = path;
    expandedFolders.add( path );
    if( kbdPane === 'tree' ) kbdTreePath = path;
    selectedPaths.clear();
    clearSearch();
    if( isPhone() ) closeTreeSheet();
    loadListing( path );                // renders now, and again when the folder arrives
}

// Fetch the open folder's own contents (one level). Renders a "Cargando…"
// hint immediately, then the rows. A newer navigation supersedes an
// in-flight one via listingSeq.
async function loadListing( path )
{
    const seq = ++listingSeq;
    listingLoading = true;
    refreshCanAdd( path );      // every route into a folder passes here
    render();

    try
    {
        const r = await GumApi.listDir( path );
        if( seq !== listingSeq ) return;
        curListing     = { path: path, nodes: pruneNodes( r.nodes || [] ) };
        listingLoading = false;
        render();
    }
    catch( err )
    {
        if( seq !== listingSeq ) return;
        listingLoading = false;
        curListing = { path: path, nodes: [] };
        render();
        if( err && err.status === 401 ) { GumApi.loginRedirect(); return; }
        NayiveUI.toast( T( 'drive.openFolderFailed' ) );
    }
}

function clearSearch()
{
    searchQuery     = '';
    searchHits      = null;
    searchTruncated = false;
    bigMode         = false;
    if( searchTimer ) { clearTimeout( searchTimer ); searchTimer = null; }
    const el = document.getElementById( 'searchInput' );
    if( el ) el.value = '';
    if( advSearch ) { advSearch = null; showAdvSearchBox(); }      // advsearch.js
}
