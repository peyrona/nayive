/*
 * navigate.js - Drive: the folder tree and breadcrumb, navigateTo and loadListing.
 */
"use strict";

// The shared tree (NayiveUI.tree, made in menus.js): Drive, and "Shared
// with me" beside it. Every folder but the roots has the same actions the
// right pane offers (right-click, ⋮, long-press) and takes dropped items.
function renderTree() { if( treeView ) treeView.render(); }

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
    rootCrumb.addEventListener( 'click', function() { isPhone() ? treeView.openSheet() : navigateTo( FS_ROOT ); } );
    host.appendChild( rootCrumb );

    if( searching )
    {
        const sep = document.createElement( 'span' );
        sep.className   = 'crumb-sep';
        sep.textContent = '/';
        host.appendChild( sep );

        const info = document.createElement( 'span' );
        info.className   = 'crumb current';
        info.textContent = TF( 'drive.resultsFor', { q: searchQuery.trim() } );
        if( bigMode )        bigFilesCrumbs( host, info );      // listing.js
        else if( advSearch ) advSearchCrumbs( host, info );     // advsearch.js
        else                 host.appendChild( info );
        return;
    }

    // "shared/..." is not under FS_ROOT (files/): it is the other virtual
    // root, so its crumbs are built from the real path, and the first
    // segment is shown by its Spanish name.
    const inShared = NayiveUI.isShared( currentFolder );
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
    clearSel();
    clearSearch();
    if( isPhone() ) treeView.closeSheet();
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
