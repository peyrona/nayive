/*
 * menus.js - Drive: the item list (Ayni.list) on the listing -
 * its ONE action list, which feeds the header's selection group, the menu
 * (right-click, the row ⋮, the group's ⋮) and the keys - plus the header ⋮,
 * the drops on the breadcrumb, cut / paste and setBackdrop.
 */
"use strict";

let browse    = null;     // Ayni.list on #listing
let clipboard = null;     // { mode: 'move' | 'copy', paths: [...] } set by Cortar / Copiar

// The paths an action works on: the rows it was run on (actTargets), until
// the next pick. There is no "nothing picked = the open folder": the open
// folder is a row in the folder above it (one action, one knob).
let actTargets = null;

function actionTargets()
{
    return topPicks( actTargets ? actTargets.slice() : Array.from( selectedPaths ) );
}

// The tree-list can show a folder and things inside it at once: when both
// are picked, the folder carries them - so nothing moves, copies or goes to
// the bin twice.
function topPicks( paths )
{
    return paths.filter( function( p )
    {
        return ! paths.some( function( q ) { return q !== p && p.indexOf( q + '/' ) === 0; } );
    } );
}

// The browser's picks are Drive's selectedPaths; everything that clears or
// sets them goes through here, so the two never disagree.
function clearSel() { if( browse ) browse.clear(); else selectedPaths.clear(); }
function setSel( paths ) { if( browse ) browse.set( paths ); else selectedPaths = new Set( paths ); }

// Anything under shared/ belongs to somebody else and the server refuses
// every write on it, so the actions that would write are off there: an
// action that can only ever end in an error toast is not worth offering.
// Reading (Abrir, Descargar, Copiar, Copiar a…, Enlace) stays on: copying
// OUT is fine.
function readOnlyOf( paths ) { return paths.some( NayiveUI.isShared ); }
function readOnlyHere()     { return NayiveUI.isShared( currentFolder ); }

// Compartir: exactly one thing, mine, and not a whole virtual root - nor a
// shortcut, which only means something in its owner's Drive.
function canShare( paths )
{
    const p = paths.length === 1 ? paths[ 0 ] : '';
    return !! p && ! NayiveUI.isShared( p ) && p !== 'files' && p !== 'data' && ! anyLink( paths );
}

// Some of `paths` are shortcuts (tree.js isLink): Download, Share and
// Compress leave them out on the server, so they are not offered for one.
function anyLink( paths ) { return paths.some( function( p ) { return isLink( rowNode( p ) ); } ); }

function sharePaths( paths )
{
    if( ! canShare( paths ) ) return;
    const node = rowNode( paths[ 0 ] );
    NayiveUI.shareSheet( {
        path:   paths[ 0 ],
        app:    (node && isDir( node )) ? 'folder' : 'file',
        title:  paths[ 0 ].split( '/' ).pop(),
        canAdd: !! (node && isDir( node ))   // only a folder can be added to
    } ).then( loadFolderMarks );             // its badge comes or goes at once
}

// Each action states once when it works: the header button, the menu row
// and the key all read it. `run` gets the paths; the Drive functions behind
// them read actionTargets(), so the paths are handed over first.
function act( fn ) { return function( paths ) { actTargets = paths.slice(); fn(); }; }

function driveActions()
{
    const one = function( p ) { return p.length === 1; };
    const rw  = function( p ) { return ! readOnlyOf( p ); };
    return [
        { id: 'open', label: T( 'drive.open' ), icon: 'external', key: 'Enter', group: 0, when: one,
          run: function( p ) { const n = rowNode( p[ 0 ] ); if( n ) openNode( n ); } },
        { id: 'download', label: T( 'ui.download' ), icon: 'download', key: 'Ctrl+D', rank: 5, group: 0,
          when: function( p ) { return ! dlJob && ! anyLink( p ); }, run: act( downloadSelection ) },
        { id: 'original', label: T( 'drive.goToOriginal' ), icon: 'folder', rank: 15, hideOff: true, group: 0,
          when: function( p ) { const n = one( p ) && rowNode( p[ 0 ] ); return !! n && isLink( n ) && ! linkBroken( n ); },
          run: function( p ) { revealItem( rowNode( p[ 0 ] ).link.to ); } },
        { id: 'extract', label: T( 'drive.extractHere' ), icon: 'unzip', rank: 14, hideOff: true, group: 0,
          when: function( p ) { return one( p ) && rw( p ) && isZipNode( rowNode( p[ 0 ] ) ); }, run: act( extractSelectedZip ) },
        // Cut / copy: no header button - "Move to" / "Copy to" are that knob.
        { id: 'cut', label: T( 'ui.cut' ), icon: 'cut', key: 'Ctrl+X', noBar: true, group: 1, when: rw,
          run: function( p ) { setClipboard( 'move', p ); } },
        { id: 'copy', label: T( 'ui.copy' ), icon: 'copy', key: 'Ctrl+C', noBar: true, group: 1,
          run: function( p ) { setClipboard( 'copy', p ); } },
        { id: 'move', label: T( 'drive.moveToDots' ), icon: 'move', rank: 2, group: 1, when: rw,
          run: act( function() { openFolderPicker( 'move' ); } ) },
        { id: 'copyTo', label: T( 'drive.copyToDots' ), icon: 'copy', rank: 8, group: 1,
          run: act( function() { openFolderPicker( 'copy' ); } ) },
        { id: 'rename', label: T( 'ui.rename' ), icon: 'edit', key: 'F2', rank: 6, group: 2,
          when: function( p ) { return one( p ) && rw( p ); }, run: act( openRename ) },
        { id: 'link', label: T( 'drive.copyLink' ), icon: 'link', rank: 9, group: 2, when: one, run: act( copySelectionLink ) },
        { id: 'share', label: T( 'ui.share' ), icon: 'share', rank: 3, group: 2, when: canShare, run: sharePaths },
        { id: 'compress', label: T( 'drive.compress' ), icon: SVG_ZIP, rank: 10, group: 2,
          when: function( p ) { return rw( p ) && ! anyLink( p ); }, run: act( compressSelection ) },
        // No bar button: its (i) waits in the header, before the (?) (#propsBtn).
        { id: 'props', label: T( 'drive.properties' ), icon: 'info', key: 'Alt+Enter', noBar: true, group: 2, run: act( openProperties ) },
        // Never a bare Backspace on a Mac: it is the key a stray press in a
        // box that just lost focus sends. ⌘⌫, as in Finder.
        { id: 'bin', label: T( 'ui.toTrash' ), icon: 'trash', key: IS_MAC ? [ 'Del', 'Ctrl+Backspace' ] : 'Del', rank: 1, group: 3,
          danger: true, when: rw, run: act( openDeleteConfirm ) }
    ];
}

// Right-click on empty space: what you make here.
function driveAreaActions()
{
    return [
        { id: 'newFolder', label: T( 'ui.newFolder' ), icon: 'folder-plus', key: 'Alt+N',
          when: function() { return ! readOnlyHere(); }, run: function() { openNewFolder(); } },
        { id: 'upload', label: T( 'ui.upload' ), icon: 'upload', key: 'Ctrl+U',
          when: function() { return ! readOnlyHere() || canAddHere; },
          run: function() { document.getElementById( 'uploadBtn' ).click(); } },
        { id: 'paste', key: 'Ctrl+V', icon: 'paste',
          label: function() { return clipboard && clipboard.paths.length
                     ? TF( clipboard.mode === 'move' ? 'drive.pasteMoveN' : 'drive.pasteCopyN', { n: clipboard.paths.length } )
                     : T( 'ui.paste' ); },
          when: function() { return !! ( clipboard && clipboard.paths.length ) && ! readOnlyHere(); },
          run: function() { doPaste(); } }
    ];
}

// The folder tree of the "Move to…" picker (move-copy.js): Home, and
// "Shared with me" beside it (the picker takes only the first).
function treeRoots()
{
    const byName = function( a, b )
    {
        return displayName( a ).localeCompare( displayName( b ), Ayni.i18n.lang(), { sensitivity: 'base', numeric: true } );
    };
    function mk( node, depth, label )
    {
        return {
            id:     node.path,
            name:   depth === 0 ? ( label || homeName() ) : displayName( node ),
            children: ( node.nodes || [] ).filter( isDir ).sort( byName ).map( function( c ) { return mk( c, depth + 1 ); } ),
            noMenu: depth === 0,                   // the roots have no actions
            noDrag: depth === 0 || NayiveUI.isShared( node.path )
        };
    }
    const roots = [];
    const top = findNode( FS_ROOT ) || dirTreeRoot;
    if( top ) roots.push( mk( top, 0 ) );
    // Everything other people shared with us hangs off its own root, next
    // to Home. It is a virtual folder (server/go/shares.go) — the paths
    // inside it are real, they just point into someone else's home, read-only.
    const shared = findNode( 'shared' );
    if( shared ) roots.push( mk( shared, 0, T( 'drive.sharedWithMe' ) ) );
    return roots;
}

// The ⋮ on a phone also holds the view switch, which leaves the header there.
function viewMenuItems()
{
    const mode = function( m, key )
    {
        return { id: 'view:' + m, label: T( key ), checked: viewMode === m, hidden: ! isPhone(),
                 run: function() { setViewMode( m ); } };
    };
    return [ mode( 'grid', 'drive.viewGrid' ), mode( 'list', 'drive.viewList' ) ];
}

function wireBrowser()
{
    // The header keeps to one row: what does not fit goes into its ⋮.
    Ayni.fitBar( document.querySelector( '.topbar' ), { btn: '#moreBtn', more: viewMenuItems } );

    document.getElementById( 'listing' ).addEventListener( 'keydown', treeKey );   // ← / → of the tree-list (listing.js)

    browse = Ayni.list( document.getElementById( 'listing' ), {
        main:     true,
        row:      '.row[data-path]',
        idOf:     function( el ) { return el.dataset.path; },
        bar:      document.getElementById( 'selActions' ),
        actions:  driveActions(),
        area:     driveAreaActions(),
        // Icons: the arrows move by what is on screen, in all four ways.
        grid:     function() { return !! document.querySelector( '#listing .list-rows.is-grid' ); },
        active:   function() { return ! trashMode; },
        open:     function( p ) { const n = rowNode( p ); if( n ) openNode( n ); },
        onSelect: function( ids )
        {
            selectedPaths = new Set( ids );
            actTargets    = null;
            updateToolbarState();
        },
        drag:     { can: function( p ) { return ! NayiveUI.isShared( p ); },
                    text: function( ids ) { return ids.join( '\n' ); } }
    } );

    // Folder rows in the listing take dropped items: a move.
    Ayni.dropZone( document.getElementById( 'listing' ), {
        sel:    '.row[data-dir]',
        target: function( el ) { return el.dataset.path; },
        can:    function( ids, dest ) { return canDropInto( dest, ids ) ? 'inside' : false; },
        drop:   function( ids, dest ) { doMove( topPicks( ids ), dest ); }
    } );

    // So do the folders above the open one, in the breadcrumb: the way to
    // move something up. The open folder's own crumb takes nothing (it is
    // already there).
    Ayni.dropZone( document.getElementById( 'breadcrumb' ), {
        sel:    '.crumb[data-path]:not(.current)',
        target: function( el ) { return el.dataset.path; },
        can:    function( ids, dest ) { return canDropInto( dest, ids ) ? 'inside' : false; },
        drop:   function( ids, dest ) { doMove( topPicks( ids ), dest ); }
    } );
}

//--------------------------------------------------------------------//
// CUT / COPY / PASTE  (Drive's own clipboard: paths, not files)

function setClipboard( mode, paths )
{
    paths = topPicks( paths || actionTargets() );
    if( ! paths.length ) return;
    clipboard = { mode: mode, paths: paths.slice() };
    flashStatus( TF( mode === 'move' ? 'drive.nCut' : 'drive.nCopiedClip', { n: clipboard.paths.length } ) );
}

async function doPaste()
{
    if( ! (clipboard && clipboard.paths.length) ) return;

    const mode  = clipboard.mode;
    const paths = clipboard.paths;
    const dest  = currentFolder;

    if( intoOwnTree( paths, dest ) )
    {
        Ayni.toast( 'warn', T( 'drive.pasteIntoItself' ) );
        return;
    }

    clipboard = null;

    if( mode === 'move' ) await doMove( paths, dest );
    else                  await doCopy( paths, dest );
}

// A dialog opens as modal / closes (Ayni's dialog.panel); the full-screen
// viewers (#viewerBackdrop, #mediaBackdrop) just take .open.
function setBackdrop( id, open )
{
    const el = document.getElementById( id );
    if( el.tagName !== 'DIALOG' ) el.classList.toggle( 'open', open );
    else if( ! open )             el.close();
    else if( ! el.open )          el.showModal();
}
