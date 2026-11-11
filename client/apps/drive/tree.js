/*
 * tree.js - Drive: path / node helpers and render().
 */
"use strict";

//------------------------------------------------------------------------//
// TREE HELPERS

function splitPath( path ) { return path ? path.split( '/' ) : []; }

function joinPath( parent, name ) { return parent ? parent + '/' + name : name; }

// Walks the FOLDERS-ONLY tree (never drawn: it answers "is this a folder?"
// and feeds the "Move to…" picker). Resolves any folder path; returns null
// for a file path (use rowNode() for something shown in the listing, or
// fetch the folder with listDir()).
function findNode( path )
{
    if( ! path ) return dirTreeRoot;

    let node = dirTreeRoot;

    for( const seg of splitPath( path ) )
    {
        if( ! node || ! node.nodes ) return null;
        node = node.nodes.find( function( n ) { return n.path.split( '/' ).pop() === seg; } );
    }

    return node || null;
}

// The node behind a path currently shown in the listing: a folder from
// the tree, or a file from the open folder's one-level listing / the
// active search results.
function rowNode( path )
{
    return findNode( path ) ||
           ( curListing.nodes || [] ).find( function( n ) { return n.path === path; } ) ||
           ( searchHits || [] ).find( function( n ) { return n.path === path; } ) ||
           ( dirKids.get( Ayni.dirOf( path ) ) || [] ).find( function( n ) { return n.path === path; } ) ||
           null;
}

function isDir( node ) { return node && node.nodes !== null && node.nodes !== undefined; }

// The top folder is "Home" in every app ("Drive" is only the app's name).
function homeName() { return T( 'ui.filesRoot' ); }

function nameOf( node ) { return node.path === '' ? homeName() : node.path.split( '/' ).pop(); }

// What the user reads. Same as nameOf() everywhere except in "Compartido
// conmigo": there the path segment is a slug the server made ("Le Nord" ->
// "le-nord"), so the grant's own title is shown instead. nameOf() stays the
// ON-DISK name — copy-to and the zip writer must keep using that.
function displayName( node )
{
    if( isLink( node ) ) return nameOf( node ).slice( 0, -LINK_EXT.length );
    return ( node && node.shared && node.shared.title ) || nameOf( node );
}

// A shortcut (server/go/links.go): a small "<name>.nayive-link" file whose
// `link` says where it leads - { to, dir } - or { broken: true }. Drive
// alone lists them (AyniNet.listDir( path, true )); the name shown drops the
// ending.
const LINK_EXT = '.nayive-link';
function isLink( node )     { return !! ( node && node.link ); }
function linkBroken( node ) { return isLink( node ) && ( node.link.broken || ! node.link.to ); }

// What a shortcut leads to, as a node of its own: openNode / listIcon take it.
function linkTarget( node )
{
    return { path: node.link.to, nodes: node.link.dir ? [] : null };
}

//------------------------------------------------------------------------//
// RENDER

function render()
{
    document.body.classList.toggle( 'trash-mode', trashMode );
    // The bin is the Papelera's on/off switch: while it is open it is an
    // arrow back to Drive, and it never leaves the bar for the ⋮.
    const binBtn = document.getElementById( 'trashViewBtn' );
    binBtn.innerHTML = Ayni.icon( trashMode ? 'back' : 'trash' );
    binBtn.ayniFitPin = trashMode;
    Ayni.setTip( binBtn, T( trashMode ? 'drive.backToDrive' : 'acct.trash' ) );
    document.getElementById( 'trashTools' ).hidden = ! trashMode;
    document.getElementById( 'propsBtn' ).hidden   = trashMode;
    // "Biggest files" is the same kind of switch.
    const bigBtn = document.getElementById( 'bigFilesBtn' );
    bigBtn.setAttribute( 'aria-pressed', bigMode );
    Ayni.setTip( bigBtn, T( bigMode ? 'drive.backToDrive' : 'drive.bigTitle' ) );
    // The view switch: which of its two is lit.
    document.getElementById( 'gridBtn' ).setAttribute( 'aria-pressed', viewMode === 'grid' );
    document.getElementById( 'listBtn' ).setAttribute( 'aria-pressed', viewMode === 'list' );

    if( trashMode )
    {
        renderTrashBar();
        renderTrashListing();
        return;
    }

    renderBreadcrumb();
    renderListing();
    updateToolbarState();
}
