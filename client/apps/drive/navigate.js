/*
 * navigate.js - Drive: the breadcrumb, navigateTo and loadListing.
 */
"use strict";

function renderBreadcrumb()
{
    const host = document.getElementById( 'breadcrumb' );
    host.innerHTML = '';

    // The "Home" crumb is always shown — even in search mode, where it is
    // the way back. Every crumb but the open folder takes dropped items
    // (menus.js): the way to move something up.
    const searching = isSearching();
    const rootCrumb = document.createElement( 'span' );
    rootCrumb.className    = 'crumb crumb-root' + (currentFolder === FS_ROOT && ! searching ? ' current' : '');
    rootCrumb.textContent  = homeName();
    rootCrumb.dataset.path = FS_ROOT;
    rootCrumb.addEventListener( 'click', function() { navigateTo( FS_ROOT ); } );
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
        crumb.className    = 'crumb' + (i === segs.length - 1 ? ' current' : '');
        crumb.dataset.path = path;
        // "shared" -> its Spanish name; "shared/<slug>" -> the grant's real
        // title ("le-nord" -> "Le Nord"); anything deeper is a real folder
        // name already.
        crumb.textContent = inShared
                          ? ( i === 0 ? T( 'drive.sharedWithMe' )
                            : i === 1 ? displayName( rowNode( path ) || { path: path } )
                            : seg )
                          : seg;
        if( ! inShared ) crumbShareMark( crumb, path );
        crumb.addEventListener( 'click', function() { navigateTo( path ); } );
        host.appendChild( crumb );
    });
}

// The crumb of a folder the user shared gets the same people / globe icon
// its row has (listing.js FOLDER_MARKS): inside a shared folder the path
// shows where the share starts. Its subfolders get nothing of their own.
function crumbShareMark( crumb, path )
{
    const m   = folderMarks.get( markPath( path ) );
    const def = m && m.share && FOLDER_MARKS[ m.share ];
    if( ! def ) return;

    const text = document.createElement( 'span' );
    text.textContent  = crumb.textContent;
    crumb.textContent = '';
    crumb.classList.add( 'crumb-shared', def.cls );
    crumb.title     = T( def.tip );
    crumb.innerHTML = Ayni.icon( def.icon );
    crumb.appendChild( text );
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
    closeAllDirs();
    clearSel();
    clearSearch();
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
        const r = await AyniNet.listDir( path, true );      // shortcuts too (tree.js isLink)
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
        if( err && err.status === 401 ) { AyniNet.loginRedirect(); return; }
        Ayni.toast( 'err', T( 'drive.openFolderFailed' ) );
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
