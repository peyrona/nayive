/*
 * dragdrop.js - Drive: internal drag-and-drop (move onto a folder).
 */
"use strict";

//------------------------------------------------------------------------//
// INTERNAL DRAG-AND-DROP: drag files / folders onto a folder to move them.
// Drop targets are folder rows in the listing and every folder in the tree
// pane. External OS-file drops (uploads) are untouched — onDrop / the
// list-pane drag-over bail out while `dragPaths` is set.

function canDropInto( destPath, paths )
{
    // A drop is a move, and nothing shared moves — in or out. An "add"
    // grant does not open this up either: it only lets a file be
    // uploaded, never renamed into place. Both ends are checked: a
    // search can put a shared hit and one of ours side by side, and
    // dragging OURS would otherwise carry the other one along.
    if( NayiveUI.isShared( destPath ) ) return false;
    if( paths.some( NayiveUI.isShared ) ) return false;

    for( const p of paths )
    {
        if( p === destPath ) return false;                        // onto itself
        const n = findNode( p );
        if( n && isDir( n ) && destPath.indexOf( p + '/' ) === 0 ) // into its own subtree
            return false;
    }
    return true;
}

// Wire an element as a move-drop target. getDest() returns the folder path
// (FS_ROOT / '' = Drive root) or null when it is not a valid target.
function makeDropTarget( el, getDest )
{
    el.addEventListener( 'dragover', function( e )
    {
        if( ! dragPaths ) return;
        const dest = getDest();
        if( dest === null || ! canDropInto( dest, dragPaths ) ) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add( 'drop-target' );
    });
    el.addEventListener( 'dragleave', function( e )
    {
        if( e.relatedTarget && el.contains( e.relatedTarget ) ) return;   // moved onto a child, still inside
        el.classList.remove( 'drop-target' );
    });
    el.addEventListener( 'drop', function( e )
    {
        el.classList.remove( 'drop-target' );
        if( ! dragPaths ) return;
        const dest = getDest();
        if( dest === null || ! canDropInto( dest, dragPaths ) ) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = dragPaths.slice();
        dragPaths = null;
        doMove( paths, dest );
    });
}

// Make a row draggable. On drag start it carries the current multi-selection
// when the row is part of it, otherwise just this one node.
function makeDraggable( el, node )
{
    el.draggable = true;
    el.addEventListener( 'dragstart', function( e )
    {
        // Somebody else's: there is no move to start (see canDropInto).
        if( NayiveUI.isShared( node.path ) ) { e.preventDefault(); return; }

        if( selectedPaths.has( node.path ) && selectedPaths.size )
            dragPaths = Array.from( selectedPaths );
        else
        {
            dragPaths = [ node.path ];
            selectedPaths.clear();
            selectedPaths.add( node.path );
            paintSelection();
            updateToolbarState();
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData( 'text/plain', dragPaths.join( '\n' ) );
        el.classList.add( 'dragging' );
    });
    el.addEventListener( 'dragend', function()
    {
        dragPaths = null;
        el.classList.remove( 'dragging' );
        document.querySelectorAll( '.drop-target' ).forEach( function( t ) { t.classList.remove( 'drop-target' ); } );
    });
}
