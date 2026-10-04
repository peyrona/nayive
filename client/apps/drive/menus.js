/*
 * menus.js - Drive: the item browser (shared/browser.js) on the listing and
 * the tree - its ONE action list, which feeds the header's selection group,
 * the menu (right-click, the row ⋮, the folder ⋮ in the tree, the group's ⋮)
 * and the keys - plus the phone's header ⋮, cut / paste and setBackdrop.
 */
"use strict";

let browse    = null;     // NayiveUI.browser on #listing
let treeView  = null;     // NayiveUI.tree in #treePane
let clipboard = null;     // { mode: 'move' | 'copy', paths: [...] } set by Cortar / Copiar

// The paths an action works on. A row action: the picked rows. A folder's
// menu in the tree: that folder (actTargets), until the next pick. There is
// no "nothing picked = the open folder" any more: the folder's own menu in
// the tree does that (one action, one knob).
let actTargets = null;

function actionTargets()
{
    return actTargets ? actTargets.slice() : Array.from( selectedPaths );
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

// Compartir: exactly one thing, mine, and not a whole virtual root.
function canShare( paths )
{
    const p = paths.length === 1 ? paths[ 0 ] : '';
    return !! p && ! NayiveUI.isShared( p ) && p !== 'files' && p !== 'data';
}

function sharePaths( paths )
{
    if( ! canShare( paths ) ) return;
    const node = rowNode( paths[ 0 ] );
    NayiveUI.shareSheet( {
        path:   paths[ 0 ],
        app:    (node && isDir( node )) ? 'folder' : 'file',
        title:  paths[ 0 ].split( '/' ).pop(),
        canAdd: !! (node && isDir( node ))   // only a folder can be added to
    } );
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
        { id: 'download', label: T( 'ui.download' ), icon: 'download', key: 'Ctrl+D', bar: 1, group: 0,
          when: function() { return ! dlJob; }, run: act( downloadSelection ) },
        { id: 'extract', label: T( 'drive.extractHere' ), icon: 'unzip', group: 0,
          when: function( p ) { return one( p ) && rw( p ) && isZipNode( rowNode( p[ 0 ] ) ); }, run: act( extractSelectedZip ) },
        { id: 'cut', label: T( 'ui.cut' ), icon: 'cut', key: 'Ctrl+X', group: 1, when: rw,
          run: function( p ) { setClipboard( 'move', p ); } },
        { id: 'copy', label: T( 'ui.copy' ), icon: 'copy', key: 'Ctrl+C', group: 1,
          run: function( p ) { setClipboard( 'copy', p ); } },
        { id: 'move', label: T( 'drive.moveToDots' ), icon: 'move', bar: 3, phone: 1, group: 1, when: rw,
          run: act( function() { openFolderPicker( 'move' ); } ) },
        { id: 'copyTo', label: T( 'drive.copyToDots' ), icon: 'copy', bar: 4, group: 1,
          run: act( function() { openFolderPicker( 'copy' ); } ) },
        { id: 'rename', label: T( 'ui.rename' ), icon: 'edit', key: 'F2', bar: 2, group: 2,
          when: function( p ) { return one( p ) && rw( p ); }, run: act( openRename ) },
        { id: 'link', label: T( 'drive.copyLink' ), icon: 'link', bar: 5, group: 2, when: one, run: act( copySelectionLink ) },
        { id: 'share', label: T( 'ui.share' ), icon: 'share', bar: 6, phone: 1, group: 2, when: canShare, run: sharePaths },
        { id: 'compress', label: T( 'drive.compress' ), icon: SVG_ZIP, bar: 7, group: 2, when: rw, run: act( compressSelection ) },
        { id: 'props', label: T( 'drive.properties' ), icon: 'info', key: 'Alt+Enter', bar: 8, group: 2, run: act( openProperties ) },
        { id: 'bin', label: T( 'ui.toTrash' ), icon: 'trash', key: IS_MAC ? [ 'Del', 'Backspace' ] : 'Del', bar: 9, phone: 1, group: 3,
          danger: true, when: rw, run: act( openDeleteConfirm ) }
    ];
}

// Right-click on empty space: what you make here.
function driveAreaActions()
{
    return [
        { id: 'newFolder', label: T( 'ui.newFolder' ), icon: 'folderplus', key: 'Alt+N',
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

// The tree's folders: Drive, and "Shared with me" beside it.
function treeRoots()
{
    const byName = function( a, b )
    {
        return displayName( a ).localeCompare( displayName( b ), NayiveUI.lang(), { sensitivity: 'base', numeric: true } );
    };
    function mk( node, depth, label )
    {
        return {
            id:     node.path,
            name:   depth === 0 ? ( label || 'Drive' ) : displayName( node ),
            kids:   ( node.nodes || [] ).filter( isDir ).sort( byName ).map( function( c ) { return mk( c, depth + 1 ); } ),
            noMenu: depth === 0,                   // the roots have no actions
            noDrag: depth === 0 || NayiveUI.isShared( node.path )
        };
    }
    const roots = [];
    const top = findNode( FS_ROOT ) || dirTreeRoot;
    if( top ) roots.push( mk( top, 0 ) );
    // Everything other people shared with us hangs off its own root, next
    // to Drive. It is a virtual folder (server/go/shares.go) — the paths
    // inside it are real, they just point into someone else's home, read-only.
    const shared = findNode( 'shared' );
    if( shared ) roots.push( mk( shared, 0, T( 'drive.sharedWithMe' ) ) );
    return roots;
}

function wireBrowser()
{
    treeView = NayiveUI.tree( {
        host:    document.getElementById( 'tree' ),
        pane:    document.getElementById( 'treePane' ),
        roots:   treeRoots,
        isOpen:  function( p ) { return expandedFolders.has( p ); },
        setOpen: function( p, v ) { if( v ) expandedFolders.add( p ); else expandedFolders.delete( p ); },
        current: function() { return currentFolder; },
        go:      function( p ) { navigateTo( p ); },
        // A folder's ⋮ / right-click: the same menu it has as a row, acting
        // on that folder without going into it.
        menu:    function( p, x, y, anchor ) { NayiveUI.menuAt( x, y, browse.items( [ p ] ), { anchor: anchor } ); },
        drag:    function( p ) { return NayiveUI.isShared( p ) ? null : [ p ]; },
        drop:    { can: function( ids, dest ) { return canDropInto( dest, ids ) ? 'inside' : false; },
                   drop: function( ids, dest ) { doMove( ids, dest ); } }
    } );

    browse = NayiveUI.browser( {
        list:     document.getElementById( 'listing' ),
        row:      '.row[data-path]',
        idOf:     function( el ) { return el.dataset.path; },
        bar:      document.getElementById( 'selActions' ),
        actions:  driveActions(),
        area:     driveAreaActions(),
        tree:     treeView,
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

    // Folder rows in the listing take dropped items too (the tree's rows do
    // through the tree).
    NayiveUI.dropZone( document.getElementById( 'listing' ), {
        sel:    '.row[data-dir]',
        target: function( el ) { return el.dataset.path; },
        can:    function( ids, dest ) { return canDropInto( dest, ids ) ? 'inside' : false; },
        drop:   function( ids, dest ) { doMove( ids, dest ); }
    } );
}

//--------------------------------------------------------------------//
// HEADER "⋮"  (phone only — see B6b in the phone block)
//
// The header buttons a phone reaches for least are hidden there and come
// back in this menu. Each row is built from the button it stands for - same
// glyph, same title - and clicking it clicks that button, so there is still
// one handler and one title per button.

const TOP_MENU_BTNS = [ 'bigFilesBtn', 'trashViewBtn' ];

function wireTopMenu()
{
    const btn = document.getElementById( 'moreBtn' );
    btn.addEventListener( 'click', function( e )
    {
        e.stopPropagation();
        if( NayiveUI.menuOpen() ) { NayiveUI.closeMenu(); return; }
        const trash = document.body.classList.contains( 'trash-mode' );
        const items = TOP_MENU_BTNS.map( function( id )
        {
            const src = document.getElementById( id );
            const svg = src.querySelector( 'svg' );
            // stripKeyHint: a desktop window narrowed into the phone layout
            // can still carry a "· Ctrl+U" in the title.
            const t   = stripKeyHint( src.getAttribute( 'title' ) || '' );
            return { id: id, label: t, icon: svg ? svg.outerHTML : '', disabled: !! src.disabled,
                     // Trash mode takes most of the toolbar away; the menu must
                     // not offer what the bar itself has just hidden.
                     hidden: trash && id !== 'trashViewBtn',
                     run: function() { src.click(); } };
        } );
        NayiveUI.menuAt( 0, 0, items, { anchor: btn, keyboard: e.detail === 0 } );
    } );
}

//--------------------------------------------------------------------//
// CUT / COPY / PASTE  (Drive's own clipboard: paths, not files)

function setClipboard( mode, paths )
{
    paths = paths || actionTargets();
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

    for( const p of paths )
    {
        const n = findNode( p );
        if( n && isDir( n ) && (dest === p || dest.indexOf( p + '/' ) === 0) )
        {
            NayiveUI.toast( T( 'drive.pasteIntoItself' ) );
            return;
        }
    }

    clipboard = null;

    if( mode === 'move' ) await doMove( paths, dest );
    else                  await doCopy( paths, dest );
}

function setBackdrop( id, open ) { NayiveUI.setOpen( id, open ); }   // impl in shared/ui.js
