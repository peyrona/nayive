/*
 * menus.js - Drive: the right-click / row ⋮ context menus, the header ⋮ menu,
 * cut / paste and setBackdrop.
 */
"use strict";

//------------------------------------------------------------------------//
// CONTEXT MENUS (right-click on desktop; on touch, the row's ⋮ button)
//
//   #ctxMenu     - on a listing row: acts on the current selection
//   #ctxAreaMenu - on empty space:  Nueva carpeta / Pegar (internal clipboard)
//
// Touch long-press is NOT a menu shortcut — it opens the pressed item
// (folder: navigate in; file: viewer / editor), a firm alternative to the
// fiddly double-tap.

let ctxOpenedAt  = 0;      // guards the close-on-click that follows an open
let swallowClick = false;  // eat the click a touch long-press leaves behind
let clipboard    = null;   // { mode: 'move' | 'copy', paths: [...] } set by Cortar / Copiar

function wireContextMenu()
{
    const listing = document.getElementById( 'listing' );

    listing.addEventListener( 'contextmenu', onListingContextMenu );

    document.getElementById( 'ctxOpen'     ).addEventListener( 'click', function() { closeCtxMenus(); openSelectedNode(); } );
    document.getElementById( 'ctxDownload' ).addEventListener( 'click', function() { closeCtxMenus(); downloadSelection(); } );
    document.getElementById( 'ctxCut'      ).addEventListener( 'click', function() { closeCtxMenus(); setClipboard( 'move' ); } );
    document.getElementById( 'ctxClip'     ).addEventListener( 'click', function() { closeCtxMenus(); setClipboard( 'copy' ); } );
    document.getElementById( 'ctxMove'     ).addEventListener( 'click', function() { closeCtxMenus(); openFolderPicker( 'move' ); } );
    document.getElementById( 'ctxCopy'     ).addEventListener( 'click', function() { closeCtxMenus(); openFolderPicker( 'copy' ); } );
    document.getElementById( 'ctxRename'   ).addEventListener( 'click', function() { closeCtxMenus(); openRename(); } );
    document.getElementById( 'ctxLink'     ).addEventListener( 'click', function() { closeCtxMenus(); copySelectionLink(); } );
    document.getElementById( 'ctxDelete'   ).addEventListener( 'click', function() { closeCtxMenus(); openDeleteConfirm(); } );
    document.getElementById( 'ctxProps'    ).addEventListener( 'click', function() { closeCtxMenus(); openProperties(); } );

    document.getElementById( 'ctxAreaNewFolder' ).addEventListener( 'click', function() { closeCtxMenus(); openNewFolder(); } );
    document.getElementById( 'ctxAreaPaste'     ).addEventListener( 'click', function() { closeCtxMenus(); doPaste(); } );

    document.addEventListener( 'click', function( e )
    {
        if( swallowClick ) { swallowClick = false; e.preventDefault(); e.stopPropagation(); return; }
        if( Date.now() - ctxOpenedAt < 300 ) return;
        if( ! e.target.closest( '.ctx-menu' ) ) closeCtxMenus();
    }, true );

    document.addEventListener( 'scroll', function() { closeCtxMenus(); }, true );
    window.addEventListener( 'resize', function() { closeCtxMenus(); } );

    // Touch long-press on a row -> open that item (not a menu; the ⋮ button is the menu).
    let lpTimer = null, lpX = 0, lpY = 0;

    listing.addEventListener( 'touchstart', function( e )
    {
        if( e.target.closest( '.row-menu' ) ) return;          // the ⋮ button handles its own tap

        const rowEl = e.target.closest( '.row' );
        if( ! rowEl || ! rowEl.dataset.path ) return;
        const t = e.touches[0];
        lpX = t.clientX; lpY = t.clientY;

        lpTimer = setTimeout( function()
        {
            lpTimer      = null;
            swallowClick = true;
            setTimeout( function() { swallowClick = false; }, 700 );   // self-heal if no click follows
            const node = rowNode( rowEl.dataset.path );
            if( node ) openNode( node );
        }, 500 );
    }, { passive: true } );

    listing.addEventListener( 'touchmove', function( e )
    {
        if( ! lpTimer ) return;
        const t = e.touches[0];
        if( Math.abs( t.clientX - lpX ) > 10 || Math.abs( t.clientY - lpY ) > 10 ) { clearTimeout( lpTimer ); lpTimer = null; }
    }, { passive: true } );

    listing.addEventListener( 'touchend', function() { if( lpTimer ) { clearTimeout( lpTimer ); lpTimer = null; } } );
}

function onListingContextMenu( e )
{
    // The papelera has none of these actions — its rows carry no
    // dataset.path, so without this the empty-area menu would open and
    // Nueva carpeta / Pegar would act on the folder BEHIND the papelera,
    // which stays on screen after the reload. Same as the keyboard
    // shortcuts: in trash mode Drive steps aside for the browser.
    if( trashMode ) return;

    e.preventDefault();
    openMenuFor( e.target.closest( '.row' ), e.clientX, e.clientY );
}

// rowEl set  -> the per-item menu (acts on the selection);
// rowEl null -> the empty-area menu (Nueva carpeta / Pegar).
function openMenuFor( rowEl, x, y )
{
    if( rowEl && rowEl.dataset.path )
    {
        selectOnlyForMenu( rowEl.dataset.path );
        openCtxMenu( 'ctxMenu', x, y );
    }
    else
    {
        openCtxMenu( 'ctxAreaMenu', x, y );
    }
}

// If the right-clicked / long-pressed row is not already part of the
// selection, make it the only selected item; otherwise leave the multi
// selection alone so the menu acts on the whole set.
function selectOnlyForMenu( path )
{
    if( selectedPaths.has( path ) ) return;
    selectedPaths = new Set( [ path ] );
    render();
}

// A folder row in the left tree, right-clicked or ⋮-tapped: make it the
// sole selection and open the same per-item menu the listing uses. Every
// action (Renombrar / Mover / Copiar / …) already works off selectedPaths,
// so nothing else needs to know the target came from the tree.
function openTreeMenuFor( path, x, y )
{
    if( ! path ) return;                       // the "Drive" root has no actions
    selectedPaths = new Set( [ path ] );
    render();
    openCtxMenu( 'ctxMenu', x, y );
}

function openCtxMenu( id, x, y )
{
    closeCtxMenus();

    if(      id === 'ctxMenu'     ) updateCtxMenuState();
    else if( id === 'ctxAreaMenu' ) updateAreaMenuState();
    else                            updateTopMenuState();   // the header's ⋮ (phone)

    const m = document.getElementById( id );
    m.classList.add( 'open' );

    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max( 6, Math.min( x, window.innerWidth  - mw - 8 ) ) + 'px';
    m.style.top  = Math.max( 6, Math.min( y, window.innerHeight - mh - 8 ) ) + 'px';

    ctxOpenedAt = Date.now();
}

function closeCtxMenus()
{
    document.getElementById( 'ctxMenu'     ).classList.remove( 'open' );
    document.getElementById( 'ctxAreaMenu' ).classList.remove( 'open' );
    document.getElementById( 'topMenu'     ).classList.remove( 'open' );
    document.getElementById( 'moreBtn'     ).setAttribute( 'aria-expanded', 'false' );
}

function anyCtxMenuOpen()
{
    return document.getElementById( 'ctxMenu'     ).classList.contains( 'open' ) ||
           document.getElementById( 'ctxAreaMenu' ).classList.contains( 'open' ) ||
           document.getElementById( 'topMenu'     ).classList.contains( 'open' );
}

//--------------------------------------------------------------------//
// HEADER "⋮"  (phone only — see B6b in the phone block)
//
// The header buttons a phone reaches for least are hidden there and
// come back in this menu. Each entry is BUILT from the button it stands
// for — same glyph, same title — and clicking it clicks that button, so
// there is still exactly one set of handlers, one enabled/disabled rule
// and one set of titles to keep up to date.

const TOP_MENU_BTNS = [ 'shareBtn', 'trashViewBtn' ];

function wireTopMenu()
{
    const menu = document.getElementById( 'topMenu' );
    const btn  = document.getElementById( 'moreBtn' );

    for( const id of TOP_MENU_BTNS )
    {
        const src = document.getElementById( id );
        const svg = src && src.querySelector( 'svg' );
        if( ! svg ) continue;

        const item = document.createElement( 'button' );
        item.className    = 'menu-item';
        item.dataset.menu = id;
        item.appendChild( svg.cloneNode( true ) );

        const label = document.createElement( 'span' );
        item.appendChild( label );
        menu.appendChild( item );
    }

    btn.addEventListener( 'click', function( e )
    {
        e.stopPropagation();                       // the document handler would close it again
        if( menu.classList.contains( 'open' ) ) { closeCtxMenus(); return; }

        const r = btn.getBoundingClientRect();
        openCtxMenu( 'topMenu', r.right, r.bottom + 4 );   // openCtxMenu clamps it to the screen
        btn.setAttribute( 'aria-expanded', 'true' );
    } );

    menu.addEventListener( 'click', function( e )
    {
        const item = e.target.closest( 'button[data-menu]' );
        if( ! item || item.disabled ) return;

        closeCtxMenus();
        document.getElementById( item.dataset.menu ).click();
    } );
}

// Called by openCtxMenu just before the menu shows: copy each source
// button's live state across. A tooltip says more than a menu row should
// — the reason a button is off after an em dash, or the file name in a
// quote ("Compartir \"x.txt\" con…"). The row is labelled with whatever
// comes before either; the whole title stays as the row's own tooltip.
function updateTopMenuState()
{
    const trash = document.body.classList.contains( 'trash-mode' );

    for( const item of document.querySelectorAll( '#topMenu button[data-menu]' ) )
    {
        const src = document.getElementById( item.dataset.menu );
        // stripKeyHint: a desktop window narrowed into the phone layout can
        // still carry a "· Ctrl+U" in the title, and a menu row is no place
        // for a key the phone has not got.
        const t   = stripKeyHint( src.getAttribute( 'title' ) || '' );

        item.disabled = !! src.disabled;
        item.title    = t;
        item.querySelector( 'span' ).textContent = t.split( /[\u2014"]/ )[0].trim() || t;

        // Trash mode takes most of the toolbar away; the menu must not
        // offer what the bar itself has just hidden.
        item.hidden = trash && item.dataset.menu !== 'trashViewBtn';
    }
}

// Anything under shared/ belongs to somebody else and the server refuses
// every write on it, so the menus turn those entries off exactly as the
// toolbar does (updateToolbarState) — an action that can only ever end
// in an error toast is not worth offering. Reading (Abrir, Descargar,
// Copiar, Copiar a…, Enlace) stays on: copying OUT is fine.
function readOnlySel()  { return actionTargets().some( NayiveUI.isShared ); }
function readOnlyHere() { return NayiveUI.isShared( currentFolder ); }

function updateCtxMenuState()
{
    const one = selectedPaths.size === 1;
    const ro  = readOnlySel();
    document.getElementById( 'ctxOpen'   ).disabled = ! one;
    document.getElementById( 'ctxRename' ).disabled = ! one || ro;
    document.getElementById( 'ctxLink'   ).disabled = ! one;
    document.getElementById( 'ctxCut'    ).disabled = ro;   // a cut is a move
    document.getElementById( 'ctxMove'   ).disabled = ro;
    document.getElementById( 'ctxDelete' ).disabled = ro;
}

function updateAreaMenuState()
{
    // Both entries write into the open folder. An "add" grant does not
    // help here: it only ever lets a file be UPLOADED (see canAddHere).
    const ro   = readOnlyHere();
    const btn  = document.getElementById( 'ctxAreaPaste' );
    const has  = !! (clipboard && clipboard.paths.length);
    document.getElementById( 'ctxAreaNewFolder' ).disabled = ro;
    btn.disabled = ! has || ro;
    btn.querySelector( 'span' ).textContent = has
        ? TF( clipboard.mode === 'move' ? 'drive.pasteMoveN' : 'drive.pasteCopyN',
              { n: clipboard.paths.length } )
        : T( 'ui.paste' );
}

function setClipboard( mode )
{
    if( ! selectedPaths.size ) return;
    clipboard = { mode: mode, paths: Array.from( selectedPaths ) };
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

function openSelectedNode()
{
    if( selectedPaths.size !== 1 ) return;
    const node = rowNode( Array.from( selectedPaths )[0] );
    if( node ) openNode( node );
}

function setBackdrop( id, open ) { NayiveUI.setOpen( id, open ); }   // impl in shared/ui.js
