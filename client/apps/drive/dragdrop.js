/*
 * dragdrop.js - Drive: the rule for internal drag-and-drop (move onto a folder).
 */
"use strict";

//------------------------------------------------------------------------//
// INTERNAL DRAG-AND-DROP: drag files / folders onto a folder to move them.
// The shared item browser does the dragging and the marks (menus.js wires
// it): drop targets are folder rows in the listing and every folder in the
// tree pane. External OS-file drops (uploads) are untouched — onDrop / the
// list-pane drag-over bail out while NayiveUI.dragIds() is set.

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
