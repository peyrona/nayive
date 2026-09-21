/*
 * tree.js - Drive: tree helpers, the pane resizer and render().
 */
"use strict";

//------------------------------------------------------------------------//
// TREE HELPERS

function splitPath( path ) { return path ? path.split( '/' ) : []; }

function joinPath( parent, name ) { return parent ? parent + '/' + name : name; }

// Walks the FOLDERS-ONLY tree. Resolves any folder path; returns null for
// a file path (files no longer live in this tree — use rowNode() for
// something shown in the right pane, or fetch the folder with listDir()).
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

// The node behind a path currently shown in the right pane: a folder from
// the tree, or a file from the open folder's one-level listing / the
// active search results.
function rowNode( path )
{
    return findNode( path ) ||
           ( curListing.nodes || [] ).find( function( n ) { return n.path === path; } ) ||
           ( searchHits || [] ).find( function( n ) { return n.path === path; } ) ||
           null;
}

function isDir( node ) { return node && node.nodes !== null && node.nodes !== undefined; }

function nameOf( node ) { return node.path === '' ? 'Drive' : node.path.split( '/' ).pop(); }

// What the user reads. Same as nameOf() everywhere except in "Compartido
// conmigo": there the path segment is a slug the server made ("Le Nord" ->
// "le-nord"), so the grant's own title is shown instead. nameOf() stays the
// ON-DISK name — copy-to and the zip writer must keep using that.
function displayName( node )
{
    return ( node && node.shared && node.shared.title ) || nameOf( node );
}

// An existing direct child of the open folder with this name, or null.
// Nested upload paths ("sub/x") aren't in the one-level listing — those
// fall through to the server's own overwrite guard.
function currentChild( relPath )
{
    if( relPath.indexOf( '/' ) !== -1 ) return null;
    return ( curListing.nodes || [] ).find( function( n ) { return nameOf( n ) === relPath; } ) || null;
}

//------------------------------------------------------------------------//
// PANE RESIZER — drag the divider to set the tree-pane width (desktop only).
// Width is stored in localStorage and applied as the --tree-w custom
// property; the phone @media rule hard-codes its own width, so the sheet
// layout is untouched. Double-click resets to the default.

function initPaneResizer()
{
    const rz  = document.getElementById( 'paneResizer' );
    const tp  = document.getElementById( 'treePane' );
    const KEY = 'drive-tree-width';
    const MIN = 140, MAX = 640, DEF = 250;

    const saved = parseInt( localStorage.getItem( KEY ), 10 );
    if( saved >= MIN && saved <= MAX )
        document.documentElement.style.setProperty( '--tree-w', saved + 'px' );

    let dragging = false, startX = 0, startW = 0;

    rz.addEventListener( 'pointerdown', function( e )
    {
        if( isPhone() ) return;
        dragging = true;
        startX   = e.clientX;
        startW   = tp.getBoundingClientRect().width;
        rz.setPointerCapture( e.pointerId );
        rz.classList.add( 'dragging' );
        document.body.style.userSelect = 'none';
    });

    rz.addEventListener( 'pointermove', function( e )
    {
        if( ! dragging ) return;
        let w = Math.round( startW + ( e.clientX - startX ) );
        w = Math.max( MIN, Math.min( MAX, w ) );
        document.documentElement.style.setProperty( '--tree-w', w + 'px' );
    });

    function endDrag()
    {
        if( ! dragging ) return;
        dragging = false;
        rz.classList.remove( 'dragging' );
        document.body.style.userSelect = '';
        try { localStorage.setItem( KEY, parseInt( tp.getBoundingClientRect().width, 10 ) ); } catch( _ ) {}
    }
    rz.addEventListener( 'pointerup', endDrag );
    rz.addEventListener( 'pointercancel', endDrag );

    rz.addEventListener( 'dblclick', function()
    {
        document.documentElement.style.setProperty( '--tree-w', DEF + 'px' );
        try { localStorage.setItem( KEY, DEF ); } catch( _ ) {}
    });
}

//------------------------------------------------------------------------//
// RENDER

function render()
{
    document.body.classList.toggle( 'trash-mode', trashMode );
    // The bin is the Papelera's on/off switch: lit while it is open, and
    // then its tooltip says where a tap takes you - back to Drive.
    const binBtn = document.getElementById( 'trashViewBtn' );
    binBtn.classList.toggle( 'is-active', trashMode );
    binBtn.title = T( trashMode ? 'drive.backToDrive' : 'acct.trash' );
    // "Biggest files" is the same kind of switch.
    const bigBtn = document.getElementById( 'bigFilesBtn' );
    bigBtn.classList.toggle( 'is-active', bigMode );
    bigBtn.title = T( bigMode ? 'drive.backToDrive' : 'drive.bigTitle' );

    if( trashMode )
    {
        renderTrashBar();
        renderTrashListing();
        return;
    }

    renderTree();
    renderBreadcrumb();
    renderListing();
    updateToolbarState();
}
