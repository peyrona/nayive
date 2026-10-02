/*
 * input.js - Bookmarks: every click, key, long-press and drag. The header and
 * its "⋮", the tree, the cards, the item menu, the selection bar, search, the
 * sheets' buttons, drag and drop and the pane resizer.
 */
"use strict";

let dragIds    = null;    // what a mouse drag is carrying
let menuAt     = 0;       // when the item menu last opened (a long-press also fires contextmenu)
let swallowTap = false;   // eat the click a long-press leaves behind
let searchTimer = null;

function $( id ) { return document.getElementById( id ); }

function wireAll()
{
    wireHeader();
    wireTopMenu();
    wireTree();
    wireItems();
    wireItemMenu();
    wireSelectBar();
    wireSearch();
    wireSheets();
    wireDragDrop();
    wireResizer();
    wireKeys();

    window.addEventListener( 'resize', function() { closeItemMenu(); renderCrumbs(); } );
}

//------------------------------------------------------------------------//
// HEADER

function wireHeader()
{
    $( 'addBtn' ).addEventListener( 'click', function() { openBookmarkSheet( null ); } );
    $( 'newFolderBtn' ).addEventListener( 'click', function() { openFolderSheet( null ); } );
    $( 'gridBtn' ).addEventListener( 'click', function() { setMode( 'grid' ); } );
    $( 'listBtn' ).addEventListener( 'click', function() { setMode( 'list' ); } );

    // Icons the markup leaves empty: one glyph per meaning, from ui.js.
    $( 'selectLeave' ).innerHTML   = NayiveUI.icon( 'back' );
    $( 'upBtn' ).innerHTML         = NayiveUI.icon( 'back' );
    $( 'selectMoveBtn' ).innerHTML = SVG.move;
    $( 'selectDeleteBtn' ).innerHTML = NayiveUI.icon( 'trash' );
}

function setMode( m ) { ui.mode = m; saveUi(); render(); }

function focusSearch()
{
    $( 'listPane' ).scrollTop = 0;
    searchFold.open();                  // unfolds and focuses it
    $( 'searchInput' ).select();
}

// The "⋮": Import, Export, Find duplicates, the sort order, Select - and on
// a phone the grid / list switch, which leaves the header there.
const SORTS = [ [ 'saved', 'bookmarks.sortSaved' ], [ 'az', 'bookmarks.sortAz' ], [ 'za', 'bookmarks.sortZa' ],
                [ 'new', 'bookmarks.sortNew' ], [ 'old', 'bookmarks.sortOld' ] ];

function wireTopMenu()
{
    const menu = $( 'topMenu' );
    const check = '<svg class="mi-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    const item = function( act, icon, label, extra ) { return '<button type="button" class="menu-item' + ( extra || '' ) + '" role="menuitem" data-act="' + act + '">' + icon + '<span>' + esc( label ) + '</span></button>'; };

    menu.innerHTML =
        item( 'import', SVG.importI, T( 'bookmarks.import' ) ) +
        item( 'export', SVG.exportI, T( 'bookmarks.export' ) ) +
        item( 'dupes',  SVG.dupes,   T( 'bookmarks.findDupes' ) ) +
        item( 'bmlet',  SVG.bookmark, T( 'bookmarks.bookmarklet' ) ) +
        item( 'select', SVG.select,  T( 'bookmarks.select' ) ) +
        '<div class="menu-sep"></div>' +
        '<div class="menu-caption">' + SVG.sort + '<span>' + esc( T( 'bookmarks.sort' ) ) + '</span></div>' +
        SORTS.map( function( s ) { return item( 'sort:' + s[ 0 ], check, T( s[ 1 ] ) ); } ).join( '' ) +
        '<div class="menu-sep mi-phone"></div>' +
        item( 'mode:grid', $( 'gridBtn' ).innerHTML, T( 'bookmarks.viewGrid' ), ' mi-phone' ) +
        item( 'mode:list', $( 'listBtn' ).innerHTML, T( 'bookmarks.viewList' ), ' mi-phone' );

    const m = NayiveUI.wireMenu( { btn: 'moreBtn', menu: 'topMenu', onPick: function( b )
    {
        const act = b.dataset.act || '';
        if( act === 'import' ) NayiveUI.open( 'importBackdrop' );
        else if( act === 'export' ) NayiveUI.open( 'exportBackdrop' );
        else if( act === 'dupes' ) openDupSheet();
        else if( act === 'bmlet' ) NayiveUI.open( 'bmletBackdrop' );
        else if( act === 'select' ) setSelecting( true );
        else if( act.indexOf( 'sort:' ) === 0 ) { ui.sort = act.slice( 5 ); saveUi(); render(); }
        else if( act.indexOf( 'mode:' ) === 0 ) setMode( act.slice( 5 ) );
    } } );

    // The ticks follow the current sort each time it opens.
    $( 'moreBtn' ).addEventListener( 'click', function()
    {
        menu.querySelectorAll( '[data-act^="sort:"]' ).forEach( function( b ) { b.classList.toggle( 'is-active', b.dataset.act === 'sort:' + ui.sort ); } );
        menu.querySelectorAll( '[data-act^="mode:"]' ).forEach( function( b ) { b.classList.toggle( 'is-active', b.dataset.act === 'mode:' + ui.mode ); } );
    }, true );
    return m;
}

//------------------------------------------------------------------------//
// TREE

function wireTree()
{
    const tree = $( 'tree' );
    tree.addEventListener( 'click', function( e )
    {
        if( swallowTap ) return;
        const row = e.target.closest( '.tree-row' );
        if( ! row ) return;
        const id = row.dataset.id;
        if( e.target.closest( '[data-twisty]' ) && id !== ROOT )
        {
            toggleOpen( id );
            renderTree();
            return;
        }
        goFolder( id );
        if( e.detail === 0 ) focusTreeRow( id );      // Enter / Space: the keys stay in the tree
    } );

    // Keys, as in a file tree: ↑ ↓ move, → opens (then goes in), ← closes
    // (then goes up), Home / End. Enter opens the folder.
    tree.addEventListener( 'keydown', function( e )
    {
        const row = e.target.closest( '.tree-row' );
        if( ! row || e.altKey || e.ctrlKey || e.metaKey ) return;
        const rows = Array.from( tree.querySelectorAll( '.tree-row' ) );
        const i = rows.indexOf( row ), id = row.dataset.id;
        const kids = childrenOf( id ).filter( isFolder );
        const open = id === ROOT || ui.open.indexOf( id ) >= 0;
        switch( e.key )
        {
            case 'ArrowDown': if( rows[ i + 1 ] ) rows[ i + 1 ].focus(); break;
            case 'ArrowUp':   if( rows[ i - 1 ] ) rows[ i - 1 ].focus(); break;
            case 'Home':      rows[ 0 ].focus(); break;
            case 'End':       rows[ rows.length - 1 ].focus(); break;
            case 'ArrowRight':
                if( ! kids.length ) break;
                if( open ) focusTreeRow( kids[ 0 ].id );
                else { toggleOpen( id, true ); renderTree(); focusTreeRow( id ); }
                break;
            case 'ArrowLeft':
                if( open && kids.length && id !== ROOT ) { toggleOpen( id, false ); renderTree(); focusTreeRow( id ); }
                else if( node( id ) && node( id ).parentId ) focusTreeRow( node( id ).parentId );
                break;
            default: return;
        }
        e.preventDefault();
    } );
    tree.addEventListener( 'dblclick', function( e )
    {
        const row = e.target.closest( '.tree-row' );
        if( row && row.dataset.id !== ROOT && ! e.target.closest( '[data-twisty]' ) ) { toggleOpen( row.dataset.id ); renderTree(); }
    } );
    tree.addEventListener( 'contextmenu', function( e )
    {
        const row = e.target.closest( '.tree-row' );
        if( ! row ) return;
        e.preventDefault();
        openItemMenu( row.dataset.id, e.clientX, e.clientY, true );
    } );
    wireLongPress( tree, '.tree-row', true );

    $( 'expandAllBtn' ).addEventListener( 'click', function()
    {
        ui.open = folderList().map( function( e ) { return e.f.id; } ).filter( function( id ) { return id !== ROOT; } );
        saveUi(); renderTree();
    } );
    $( 'collapseAllBtn' ).addEventListener( 'click', function() { ui.open = []; saveUi(); renderTree(); } );
}

//------------------------------------------------------------------------//
// ITEMS  -  the card body opens the link (a folder: goes in). A tag chip
// searches that tag. The row "⋮" opens the item menu. In selection mode a
// tap picks.

function wireItems()
{
    const items = $( 'items' );

    items.addEventListener( 'click', function( e )
    {
        if( swallowTap ) { e.preventDefault(); return; }
        const card = e.target.closest( '.bm-item' );
        if( ! card ) return;
        const id = card.dataset.id;

        if( e.target.closest( '.row-menu' ) )
        {
            const r = e.target.closest( '.row-menu' ).getBoundingClientRect();
            openItemMenu( id, r.right, r.bottom, false );
            return;
        }
        if( selecting ) { togglePick( id ); return; }

        const tag = e.target.closest( '.bm-tag' );
        if( tag ) { setQuery( '#' + tag.dataset.tag, tag.dataset.tag ); return; }
        if( e.target.closest( 'button' ) ) return;

        if( isFolder( node( id ) ) ) goFolder( id ); else openLink( id );
    } );

    // Middle click opens the link too, as a link would.
    items.addEventListener( 'auxclick', function( e )
    {
        if( e.button !== 1 ) return;
        const card = e.target.closest( '.bm-item' );
        if( card && ! isFolder( node( card.dataset.id ) ) ) { e.preventDefault(); openLink( card.dataset.id ); }
    } );

    items.addEventListener( 'keydown', function( e )
    {
        if( e.key !== 'Enter' && e.key !== ' ' ) return;
        const card = e.target.closest( '.bm-item' );
        if( ! card || e.target !== card ) return;
        e.preventDefault();
        card.click();
    } );

    items.addEventListener( 'contextmenu', function( e )
    {
        const card = e.target.closest( '.bm-item' );
        if( ! card ) return;
        e.preventDefault();
        openItemMenu( card.dataset.id, e.clientX, e.clientY, false );
    } );
    wireLongPress( items, '.bm-item', false );

    // A site's icon, once it is in, covers the initial (and is shown at once
    // on the next render).
    items.addEventListener( 'load', function( e )
    {
        if( e.target.tagName !== 'IMG' ) return;
        const card = e.target.closest( '.bm-item' );
        const b = card && node( card.dataset.id );
        if( b ) iconOk.add( hostOf( b.url ) );
        e.target.classList.add( 'ok' );
    }, true );

    // A site with no icon of its own keeps its coloured initial.
    items.addEventListener( 'error', function( e )
    {
        if( e.target.tagName !== 'IMG' ) return;
        const card = e.target.closest( '.bm-item' );
        const b = card && node( card.dataset.id );
        if( b ) noIcon.add( hostOf( b.url ) );
        e.target.remove();
    }, true );

    // The filter pills, the crumbs, ← up, the empty screen's buttons.
    $( 'filterRow' ).addEventListener( 'click', function( e )
    {
        const p = e.target.closest( '.pill' );
        if( ! p ) return;
        filter = p.dataset.filter;
        if( filter === 'all' ) curFolder = ROOT;
        if( query ) { query = ''; $( 'searchInput' ).value = ''; }
        render();
    } );
    $( 'crumbs' ).addEventListener( 'click', function( e )
    {
        const s = e.target.closest( '.crumb-seg' );
        if( s ) goFolder( s.dataset.id );
    } );
    $( 'upBtn' ).addEventListener( 'click', function()
    {
        const f = node( curFolder );
        if( f && f.parentId ) goFolder( f.parentId );
    } );
    $( 'emptyHint' ).addEventListener( 'click', function( e )
    {
        const b = e.target.closest( '[data-empty]' );
        if( ! b ) return;
        if( b.dataset.empty === 'add' ) openBookmarkSheet( null );
        else if( b.dataset.empty === 'import' ) NayiveUI.open( 'importBackdrop' );
    } );
}

// The tree is drawn anew on each change: put the keyboard back on a row.
function focusTreeRow( id )
{
    const row = document.querySelector( '#tree .tree-row[data-id="' + CSS.escape( id ) + '"]' );
    if( row ) row.focus();
}

// Touch: a long-press opens the item menu (the pointer stays where it is).
function wireLongPress( host, sel, fromTree )
{
    let timer = null, x = 0, y = 0;
    host.addEventListener( 'touchstart', function( e )
    {
        if( e.touches.length !== 1 || e.target.closest( '.row-menu' ) ) return;
        const el = e.target.closest( sel );
        if( ! el ) return;
        x = e.touches[ 0 ].clientX; y = e.touches[ 0 ].clientY;
        timer = setTimeout( function()
        {
            timer = null;
            swallowTap = true;
            setTimeout( function() { swallowTap = false; }, 700 );
            openItemMenu( el.dataset.id, x, y, fromTree );
        }, 500 );
    }, { passive: true } );
    host.addEventListener( 'touchmove', function( e )
    {
        if( ! timer ) return;
        const t = e.touches[ 0 ];
        if( Math.abs( t.clientX - x ) > 10 || Math.abs( t.clientY - y ) > 10 ) { clearTimeout( timer ); timer = null; }
    }, { passive: true } );
    host.addEventListener( 'touchend', function() { if( timer ) { clearTimeout( timer ); timer = null; } } );
    host.addEventListener( 'touchcancel', function() { if( timer ) { clearTimeout( timer ); timer = null; } } );
}

function togglePick( id )
{
    if( selected.has( id ) ) selected.delete( id ); else selected.add( id );
    render();
}

//------------------------------------------------------------------------//
// THE ITEM MENU  -  right-click, long-press or the row "⋮". Built for the
// item it is about; the shared .top-menu look, placed at the pointer.

let menuFor = null;

function openItemMenu( id, x, y, fromTree )
{
    const n = node( id );
    if( ! n ) return;
    if( Date.now() - menuAt < 600 && menuFor === id ) return;   // the contextmenu a long-press also fires
    menuFor = id;
    menuAt  = Date.now();

    const I = function( act, icon, label, danger )
    {
        return '<button type="button" class="menu-item' + ( danger ? ' danger' : '' ) + '" role="menuitem" data-act="' + act + '">' + icon + '<span>' + esc( label ) + '</span></button>';
    };
    let html;
    if( id === ROOT )
        html = I( 'subfolder', NayiveUI.icon( 'folderplus' ), T( 'bookmarks.newSubfolder' ) );
    else if( isFolder( n ) )
        html = I( 'subfolder', NayiveUI.icon( 'folderplus' ), T( 'bookmarks.newSubfolder' ) ) +
               I( 'rename', NayiveUI.icon( 'edit' ), T( 'ui.rename' ) ) +
               I( 'move', SVG.move, T( 'bookmarks.moveTo' ) ) +
               ( fromTree ? '' : I( 'select', SVG.select, T( 'bookmarks.select' ) ) ) +
               '<div class="menu-sep"></div>' +
               I( 'delete', NayiveUI.icon( 'trash' ), T( 'ui.delete' ), true );
    else
        html = I( 'edit', NayiveUI.icon( 'edit' ), T( 'bookmarks.edit' ) ) +
               I( 'fav', n.favorite ? SVG.starOff : SVG.star, T( n.favorite ? 'bookmarks.unfavourite' : 'bookmarks.favAdd' ) ) +
               I( 'copy', SVG.link, T( 'bookmarks.copyLink' ) ) +
               I( 'move', SVG.move, T( 'bookmarks.moveTo' ) ) +
               I( 'select', SVG.select, T( 'bookmarks.select' ) ) +
               '<div class="menu-sep"></div>' +
               I( 'delete', NayiveUI.icon( 'trash' ), T( 'ui.delete' ), true );

    const m = $( 'ctxMenu' );
    m.innerHTML = html;
    m.hidden = false;
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.right = 'auto';
    m.style.left = Math.max( 6, Math.min( x, window.innerWidth  - w - 8 ) ) + 'px';
    m.style.top  = Math.max( 6, Math.min( y, window.innerHeight - h - 8 ) ) + 'px';
}

function closeItemMenu() { $( 'ctxMenu' ).hidden = true; }

function wireItemMenu()
{
    const m = $( 'ctxMenu' );
    m.addEventListener( 'click', function( e )
    {
        const b = e.target.closest( '.menu-item' );
        if( ! b ) return;
        const id = menuFor;
        closeItemMenu();
        // In selection mode an action on a picked item acts on the whole pick.
        const many = selecting && selected.has( id ) && selected.size > 1 ? Array.from( selected ) : [ id ];
        switch( b.dataset.act )
        {
            case 'edit':      openBookmarkSheet( id ); break;
            case 'fav':       toggleFavourite( id ); break;
            case 'copy':      copyLink( id ); break;
            case 'move':      openMoveSheet( many ); break;
            case 'select':    selecting = true; selected.add( id ); render(); break;
            case 'delete':    deleteNodes( many ); break;
            case 'rename':    openFolderSheet( id ); break;
            case 'subfolder': openFolderSheet( null, id ); break;
        }
    } );
    document.addEventListener( 'click', function( e )
    {
        if( m.hidden || Date.now() - menuAt < 300 ) return;
        if( ! m.contains( e.target ) ) closeItemMenu();
    }, true );
    document.addEventListener( 'scroll', closeItemMenu, true );
}

//------------------------------------------------------------------------//
// SELECTION BAR

function wireSelectBar()
{
    $( 'selectLeave' ).addEventListener( 'click', function() { setSelecting( false ); } );
    $( 'selectAllBtn' ).addEventListener( 'click', function()
    {
        const all = visibleItems().items.map( function( n ) { return n.id; } );
        const every = all.length && all.every( function( id ) { return selected.has( id ); } );
        if( every ) selected.clear(); else all.forEach( function( id ) { selected.add( id ); } );
        render();
    } );
    $( 'selectMoveBtn' ).addEventListener( 'click', function() { openMoveSheet( Array.from( selected ) ); } );
    $( 'selectDeleteBtn' ).addEventListener( 'click', function() { deleteNodes( Array.from( selected ) ); } );
}

//------------------------------------------------------------------------//
// SEARCH

// `tag`: a chip asked - that tag is matched whole (see tagMatcher) until the
// box is edited.
function setQuery( q, tag )
{
    query = q;
    chipTag = tag != null ? tag : null;
    $( 'searchInput' ).value = q;
    if( q && searchFold ) searchFold.open( true );    // a chip's search shows in the field
    render();
    $( 'listPane' ).scrollTop = 0;
}

// The magnifier unfolds the field (the shared fold); its × and Escape clear
// the search and fold it away.
let searchFold = null;

function wireSearch()
{
    const input = $( 'searchInput' );
    input.addEventListener( 'input', function()
    {
        clearTimeout( searchTimer );
        searchTimer = setTimeout( function() { query = input.value.trim(); chipTag = null; render(); }, 90 );
    } );
    searchFold = NayiveUI.searchFold( { box: input.parentElement, input: input, toggle: $( 'searchBtn' ),
                                        onClose: function() { clearTimeout( searchTimer ); setQuery( '' ); } } );
}

//------------------------------------------------------------------------//
// KEYS  -  Ctrl+/ (Cmd+/) goes to the search box; Esc clears the search or
// leaves selection mode when nothing else is open.

function wireKeys()
{
    document.addEventListener( 'keydown', function( e )
    {
        if( ( e.ctrlKey || e.metaKey ) && e.key === '/' ) { e.preventDefault(); focusSearch(); return; }
        if( e.key !== 'Escape' || document.querySelector( '.sheet-backdrop.open' ) ) return;
        if( ! $( 'ctxMenu' ).hidden ) { closeItemMenu(); return; }
        if( selecting ) { setSelecting( false ); return; }
        if( query ) setQuery( '' );
    } );
}

//------------------------------------------------------------------------//
// SHEETS

function wireSheets()
{
    const url = $( 'bmUrl' );
    url.addEventListener( 'input', function() { $( 'bmUrlError' ).hidden = true; checkDupUrl(); } );
    url.addEventListener( 'blur', function() { autofillTitle(); checkDupUrl(); } );
    url.addEventListener( 'paste', function() { setTimeout( function() { autofillTitle(); checkDupUrl(); }, 0 ); } );
    $( 'bmSaveBtn' ).addEventListener( 'click', saveBookmarkSheet );
    $( 'bmDeleteBtn' ).addEventListener( 'click', function()
    {
        const id = editId;
        NayiveUI.close( 'bmBackdrop' );
        if( id ) deleteNodes( [ id ] );
    } );
    enterSubmits( 'bmBackdrop', saveBookmarkSheet );

    $( 'folderSaveBtn' ).addEventListener( 'click', saveFolderSheet );
    enterSubmits( 'folderBackdrop', saveFolderSheet );

    // "Save from any page": the button is only for dragging to the browser's
    // bookmarks bar; a click here would just open this app again.
    const bmlet = $( 'bmletLink' );
    bmlet.href = bookmarkletHref();
    bmlet.addEventListener( 'click', function( e ) { e.preventDefault(); } );

    $( 'moveOkBtn' ).addEventListener( 'click', function()
    {
        if( doMove( moveIds, $( 'moveFolder' ).value || ROOT ) ) NayiveUI.close( 'moveBackdrop' );
    } );

    $( 'importDeviceBtn' ).addEventListener( 'click', importFromDevice );
    $( 'importNayiveBtn' ).addEventListener( 'click', importFromNayive );
    $( 'importInput' ).addEventListener( 'change', function( e )
    {
        const f = e.target.files && e.target.files[ 0 ];
        if( f ) importFile( f );
    } );
    $( 'exportHtmlBtn' ).addEventListener( 'click', exportHtml );
    $( 'exportJsonBtn' ).addEventListener( 'click', exportJson );
    $( 'dupRemoveBtn' ).addEventListener( 'click', removeDuplicates );
}

// The browser bookmark that sends the page on show here: this app opens in a
// new tab with ?add=<its address>&title=<its title> (see boot.js).
function bookmarkletHref()
{
    const app = window.location.origin + window.location.pathname;
    return "javascript:(function(){var u='" + app.replace( /'/g, '%27' ) + "?add='+encodeURIComponent(location.href)+" +
           "'&title='+encodeURIComponent(document.title);if(!window.open(u,'_blank'))location.href=u;})()";
}

// Enter in a one-line field of the sheet = its ✓.
function enterSubmits( backId, fn )
{
    $( backId ).addEventListener( 'keydown', function( e )
    {
        if( e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && ! e.isComposing )
        {
            e.preventDefault();
            fn();
        }
    } );
}

//------------------------------------------------------------------------//
// DRAG AND DROP (mouse)  -  cards and tree rows onto tree rows, folder cards
// and crumb parts. A LINK dragged in from another tab or the address bar
// opens the new-bookmark sheet with it (into the folder it was dropped on). In the tree, folders also REORDER: the top or bottom edge
// of a row puts them before / after it (a line shows where); its middle puts
// them inside, as everywhere else. A folder onto itself or below itself: an error toast and
// nothing moves. Dragging a picked card carries the whole pick. Touch has no
// HTML5 drag: "Move to…" in the menus does the same job there.

const DROP_SEL = '.tree-row, .bm-item.is-folder, .crumb-seg';

// Which part of a tree row the pointer is over: 'before' / 'after' (the top
// and bottom 30 %) or 'inside'. Only folders reorder; a card always goes
// inside.
function treeZone( row, e, ids )
{
    if( ! row.classList.contains( 'tree-row' ) || row.dataset.id === ROOT ) return 'inside';
    if( ! ids.every( function( id ) { return isFolder( node( id ) ); } ) ) return 'inside';
    const r = row.getBoundingClientRect(), y = e.clientY - r.top;
    return y < r.height * 0.3 ? 'before' : y > r.height * 0.7 ? 'after' : 'inside';
}

function clearDropMarks( keep )
{
    document.querySelectorAll( '.drop-target, .drop-before, .drop-after' ).forEach( function( el )
    {
        if( el !== keep ) el.classList.remove( 'drop-target', 'drop-before', 'drop-after' );
    } );
}

function wireDragDrop()
{
    document.addEventListener( 'dragstart', function( e )
    {
        const el = e.target.closest && e.target.closest( '.bm-item, .tree-row' );
        if( ! el || el.dataset.id === ROOT ) return;
        const id = el.dataset.id;
        dragIds = selecting && selected.has( id ) ? Array.from( selected ) : [ id ];
        closeItemMenu();
        e.dataTransfer.effectAllowed = 'move';
        const b = node( id );
        e.dataTransfer.setData( 'text/plain', b && b.url ? b.url : ( b ? b.title : '' ) );
        el.classList.add( 'dragging' );
    } );
    // A link dragged back out of the window leaves no mark behind.
    document.addEventListener( 'dragleave', function( e ) { if( ! dragIds && ! e.relatedTarget ) clearDropMarks( null ); } );
    document.addEventListener( 'dragend', function()
    {
        dragIds = null;
        document.querySelectorAll( '.dragging' ).forEach( function( el ) { el.classList.remove( 'dragging' ); } );
        clearDropMarks( null );
    } );
    document.addEventListener( 'dragover', function( e )
    {
        if( ! dragIds )
        {
            if( ! linkDrag( e ) ) return;
            const f = e.target.closest && e.target.closest( DROP_SEL );
            clearDropMarks( f );
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if( f && isFolder( node( f.dataset.id ) ) ) f.classList.add( 'drop-target' );
            return;
        }
        const t = e.target.closest && e.target.closest( DROP_SEL );
        clearDropMarks( t );
        if( ! t || ! isFolder( node( t.dataset.id ) ) ) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const zone = treeZone( t, e, dragIds );
        const good = zone === 'inside' ? canMove( dragIds, t.dataset.id ) : !! placeSpot( dragIds, t.dataset.id, zone );
        t.classList.toggle( 'drop-target', good && zone === 'inside' );
        t.classList.toggle( 'drop-before', good && zone === 'before' );
        t.classList.toggle( 'drop-after',  good && zone === 'after' );
    } );
    document.addEventListener( 'drop', function( e )
    {
        if( ! dragIds )
        {
            if( ! linkDrag( e ) ) return;
            e.preventDefault();
            clearDropMarks( null );
            const f = e.target.closest && e.target.closest( DROP_SEL );
            const link = droppedLink( e.dataTransfer );
            if( link && ! document.querySelector( '.sheet-backdrop.open' ) )
                openBookmarkSheet( null, { url: link.url, title: link.title,
                                           folder: f && isFolder( node( f.dataset.id ) ) ? f.dataset.id : null } );
            return;
        }
        const t = e.target.closest && e.target.closest( DROP_SEL );
        if( ! t || ! isFolder( node( t.dataset.id ) ) ) return;
        e.preventDefault();
        const ids = dragIds;
        const zone = treeZone( t, e, ids );
        dragIds = null;
        clearDropMarks( null );
        if( zone === 'inside' && ids.indexOf( t.dataset.id ) >= 0 ) return;        // a folder nudged onto itself
        if( zone === 'inside' ) doMove( ids, t.dataset.id );
        else if( ids.indexOf( t.dataset.id ) < 0 ) doPlace( ids, t.dataset.id, zone );   // onto its own edge: nothing to do
    } );

    // Mark what can be dragged, after each render. Only with a mouse: a
    // draggable card would fight a finger's scroll on some tablets.
    const mouse = window.matchMedia( '(hover: hover) and (pointer: fine)' );
    const mark = function()
    {
        const on = mouse.matches;
        document.querySelectorAll( '.bm-item, .tree-row' ).forEach( function( el ) { el.draggable = on && el.dataset.id !== ROOT; } );
    };
    new MutationObserver( mark ).observe( $( 'items' ), { childList: true } );
    new MutationObserver( mark ).observe( $( 'tree' ), { childList: true } );
}

// A drag from outside this page that carries a link.
function linkDrag( e )
{
    const types = e.dataTransfer ? Array.from( e.dataTransfer.types || [] ) : [];
    return types.indexOf( 'text/uri-list' ) >= 0 || types.indexOf( 'text/x-moz-url' ) >= 0;
}

// -> { url, title } from a dropped link: the address from text/uri-list (or
// Firefox's text/x-moz-url, whose 2nd line is the title), the words from the
// link's own HTML when there is some. null when it is no address we keep.
function droppedLink( dt )
{
    const moz = ( dt.getData( 'text/x-moz-url' ) || '' ).split( /\r?\n/ );
    const raw = ( dt.getData( 'text/uri-list' ) || '' ).split( /\r?\n/ ).filter( function( l ) { return l && l.charAt( 0 ) !== '#'; } )[ 0 ] || moz[ 0 ];
    const url = normalizeUrl( raw );
    if( ! url ) return null;
    let title = moz[ 1 ] || '';
    const html = dt.getData( 'text/html' );
    if( ! title && html )
    {
        const a = new DOMParser().parseFromString( html, 'text/html' ).querySelector( 'a' );
        title = a ? a.textContent.replace( /\s+/g, ' ' ).trim() : '';
    }
    return { url: url, title: title !== url ? title : '' };
}

//------------------------------------------------------------------------//
// PANE RESIZER  -  drag the divider; the width is this device's (localStorage).
// Double-click puts it back.

const TREE_MIN = 160, TREE_MAX = 520, TREE_DEF = 240;

function applyTreeWidth()
{
    if( ui.treeW >= TREE_MIN && ui.treeW <= TREE_MAX ) document.documentElement.style.setProperty( '--tree-w', ui.treeW + 'px' );
    else document.documentElement.style.removeProperty( '--tree-w' );
}

function wireResizer()
{
    NayiveUI.paneResizer( $( 'paneResizer' ), $( 'treePane' ),
    {
        min: TREE_MIN, max: TREE_MAX, def: TREE_DEF, off: isPhone, save: saveUi,
        set: function( w ) { ui.treeW = w; applyTreeWidth(); }
    } );
}
