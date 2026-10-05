/*
 * input.js - Bookmarks: every click, key and drag. The header and its "⋮"
 * (the shared NayiveUI.fitBar: what does not fit, then Bookmarks' own), the tree, the cards, search, the sheets' buttons, drag and drop and the
 * pane resizer. Picking, the item menu, the selection's header buttons and
 * the list keys are the shared item browser (shared/browser.js): this file
 * only gives it the action list.
 */
"use strict";

let browse      = null;   // the shared item browser on #items
let treeView    = null;   // the shared tree in #tree
let searchTimer = null;

function $( id ) { return document.getElementById( id ); }

function wireAll()
{
    wireHeader();
    wireTree();
    wireItems();
    wireSearch();
    wireSheets();
    wireDragDrop();
    wireResizer();
    wireKeys();

    window.addEventListener( 'resize', function() { renderCrumbs(); } );
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
    $( 'upBtn' ).innerHTML = NayiveUI.icon( 'back' );
    $( 'treeBtn' ).addEventListener( 'click', function() { treeView.openSheet(); } );
}

function setMode( m ) { ui.mode = m; saveUi(); render(); }

function focusSearch()
{
    $( 'listPane' ).scrollTop = 0;
    searchFold.open();                  // unfolds and focuses it
    $( 'searchInput' ).select();
}

// The "⋮" (NayiveUI.fitBar, wireItems): after the buttons that did not fit,
// Import, Export, Find duplicates, the bookmarklet, the sort order - and on
// a phone the grid / list switch, which leaves the header there.
const SORTS = [ [ 'saved', 'bookmarks.sortSaved' ], [ 'az', 'bookmarks.sortAz' ], [ 'za', 'bookmarks.sortZa' ],
                [ 'new', 'bookmarks.sortNew' ], [ 'old', 'bookmarks.sortOld' ] ];

// Rows in the NayiveUI.menuAt format, built anew each time the ⋮ opens (so
// the ticks follow the current sort and view).
function topMenuItems()
{
    const phone = isPhone();
    const mode  = function( m, btn, label )
    {
        return { id: 'mode:' + m, label: T( label ), icon: $( btn ).innerHTML, checked: ( ui.mode === 'list' ) === ( m === 'list' ),
                 hidden: ! phone, run: function() { setMode( m ); } };
    };
    return [
        { id: 'import', label: T( 'bookmarks.import' ),      icon: SVG.importI,  run: function() { NayiveUI.open( 'importBackdrop' ); } },
        { id: 'export', label: T( 'bookmarks.export' ),      icon: SVG.exportI,  run: function() { NayiveUI.open( 'exportBackdrop' ); } },
        { id: 'dupes',  label: T( 'bookmarks.findDupes' ),   icon: SVG.dupes,    run: openDupSheet },
        { id: 'bmlet',  label: T( 'bookmarks.bookmarklet' ), icon: SVG.bookmark, run: function() { NayiveUI.open( 'bmletBackdrop' ); } },
        { sep: true },
        { caption: T( 'bookmarks.sort' ) }
    ].concat( SORTS.map( function( s )
    {
        return { id: 'sort:' + s[ 0 ], label: T( s[ 1 ] ), checked: ui.sort === s[ 0 ], run: function() { ui.sort = s[ 0 ]; saveUi(); render(); } };
    } ) ).concat( [
        { sep: true, hidden: ! phone },
        mode( 'grid', 'gridBtn', 'bookmarks.viewGrid' ),
        mode( 'list', 'listBtn', 'bookmarks.viewList' )
    ] );
}

//------------------------------------------------------------------------//
// TREE  -  the shared tree (NayiveUI.tree): the arrow opens and closes, a
// click opens the folder, right-click / long-press give the folder the
// same menu it has as a card, keys as in a file tree. Folders drag; the top
// or bottom edge of a row puts a folder before / after it (a line shows
// where), its middle puts it inside. On a phone it slides in from #treeBtn.

function wireTree()
{
    treeView = NayiveUI.tree( {
        host:    $( 'tree' ),
        pane:    $( 'treePane' ),
        roots:   treeRoots,
        isOpen:  function( id ) { return ui.open.indexOf( id ) >= 0; },
        setOpen: function( id, v ) { toggleOpen( id, v ); },
        current: function() { return filter === 'all' && ! query ? curFolder : null; },
        go:      function( id ) { goFolder( id ); },
        menu:    function( id, x, y, anchor ) { NayiveUI.menuAt( x, y, browse.items( [ id ] ), { anchor: anchor } ); },
        drag:    function( id ) { return [ id ]; },
        drop:    { can: treeCan, drop: dropInto }
    } );

    $( 'expandAllBtn' ).addEventListener( 'click', function()
    {
        ui.open = folderList().map( function( e ) { return e.f.id; } ).filter( function( id ) { return id !== ROOT; } );
        saveUi(); renderTree();
    } );
    $( 'collapseAllBtn' ).addEventListener( 'click', function() { ui.open = []; saveUi(); renderTree(); } );
}

// Keys back on a tree row (the tree is drawn anew on each change).
function focusTreeRow( id ) { treeView.focus( id ); }

//------------------------------------------------------------------------//
// ITEMS  -  the shared item browser: a click picks, a double-click (a tap)
// opens the link or goes into the folder. A tag chip searches that tag.
// Every action, once: the header group (what does not fit goes into the
// header's ⋮), the menu (right-click, long-press) and the keys read this one
// list. rank: 1 = the last button to leave a narrow header (Select all is 4).

function bmOnly( ids ) { return ids.every( function( id ) { return node( id ) && ! isFolder( node( id ) ); } ); }
function one( ids )    { return ids.length === 1; }

function openItem( id )
{
    if( isFolder( node( id ) ) ) goFolder( id ); else openLink( id );
}

// Built once the dictionary is in (wireAll runs after it).
function actionList() { return [
    { id: 'open', label: T( 'ui.open' ), icon: 'external', key: 'Enter', group: 0, when: one,
      run: function( ids ) { openItem( ids[ 0 ] ); } },
    { id: 'openAll', label: T( 'bookmarks.openAll' ), icon: 'external', rank: 7, hideOff: true, group: 0,
      when: function( ids ) { return ids.length > 1 && bmOnly( ids ); },
      run: function( ids ) { ids.forEach( openLink ); } },
    { id: 'edit', label: T( 'bookmarks.edit' ), icon: 'edit', key: 'F2', rank: 5, group: 1, when: one,
      run: function( ids ) { if( isFolder( node( ids[ 0 ] ) ) ) openFolderSheet( ids[ 0 ] ); else openBookmarkSheet( ids[ 0 ] ); } },
    { id: 'fav', icon: 'star', key: 'S', rank: 2, group: 1, when: bmOnly,
      label: function( ids ) { return T( ids.length && ids.every( function( id ) { return node( id ) && node( id ).favorite; } ) ? 'bookmarks.unfavourite' : 'bookmarks.favAdd' ); },
      run: setFavourite },
    { id: 'link', label: T( 'bookmarks.copyLink' ), icon: 'link', rank: 6, group: 1,
      when: function( ids ) { return one( ids ) && bmOnly( ids ); },
      run: function( ids ) { copyLink( ids[ 0 ] ); } },
    { id: 'move', label: T( 'bookmarks.moveTo' ), icon: 'move', rank: 3, group: 2,
      run: openMoveSheet },
    { id: 'subfolder', label: T( 'bookmarks.newSubfolder' ), icon: 'folderplus', rank: 8, hideOff: true, group: 2,
      when: function( ids ) { return one( ids ) && isFolder( node( ids[ 0 ] ) ); },
      run: function( ids ) { openFolderSheet( null, ids[ 0 ] ); } },
    { id: 'delete', label: T( 'ui.delete' ), icon: 'trash', key: [ 'Del', 'Backspace' ], rank: 1, group: 3, danger: true,
      run: deleteNodes }
]; }

// Right-click on empty space: what you make here.
function areaList() { return [
    { id: 'add', label: T( 'bookmarks.newBookmark' ), icon: 'plus', run: function() { openBookmarkSheet( null ); } },
    { id: 'newFolder', label: T( 'ui.newFolder' ), icon: 'folderplus', key: 'Alt+N', run: function() { openFolderSheet( null ); } }
]; }

function wireItems()
{
    const items = $( 'items' );

    // The header keeps to one row: what does not fit goes into its ⋮, above
    // Bookmarks' own rows.
    NayiveUI.fitBar( document.querySelector( '.topbar' ), { btn: '#moreBtn', more: topMenuItems } );

    browse = NayiveUI.browser( {
        list:    items,
        row:     '.bm-item',
        bar:     $( 'selActions' ),
        actions: actionList(),
        area:    areaList(),
        tree:    treeView,
        open:    openItem,
        openMiddle: function( id ) { if( ! isFolder( node( id ) ) ) openLink( id ); },
        grid:    function() { return ui.mode !== 'list'; },
        search:  focusSearch,
        drag:    { text: function( ids ) { const b = node( ids[ 0 ] ); return b ? ( b.url || b.title ) : ''; } }
    } );

    // A tag chip searches that tag (its own button: the browser leaves it).
    items.addEventListener( 'click', function( e )
    {
        const tag = e.target.closest( '.bm-tag' );
        if( tag ) setQuery( '#' + tag.dataset.tag, tag.dataset.tag );
    } );

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
// KEYS  -  the list's own keys are the browser's (shared/browser.js). Here:
// Ctrl+/ (Cmd+/) goes to the search box too; Esc clears the search when
// nothing is picked and nothing else is open.

function wireKeys()
{
    document.addEventListener( 'keydown', function( e )
    {
        if( ( e.ctrlKey || e.metaKey ) && e.key === '/' ) { e.preventDefault(); focusSearch(); return; }
        if( e.key !== 'Escape' || e.defaultPrevented || document.querySelector( '.sheet-backdrop.open' ) || NayiveUI.menuOpen() ) return;
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
// DRAG AND DROP (mouse)  -  cards and tree rows carry their ids (the shared
// browser / tree start the drag; a picked card carries the whole pick) onto
// tree rows, folder cards and crumb parts. A folder onto itself or below
// itself: an error toast and nothing moves. A LINK dragged in from another
// tab or the address bar opens the new-bookmark sheet with it (into the
// folder it was dropped on). Touch has no HTML5 drag: "Move to…" does it.

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

// The tree's and the list's verdict: a zone (lit), or refused (no mark, but
// the drop still comes and says why), or not a target at all.
function treeCan( ids, id, el, e )
{
    if( ! isFolder( node( id ) ) ) return false;
    const zone = treeZone( el, e, ids );
    const good = zone === 'inside' ? canMove( ids, id ) : !! placeSpot( ids, id, zone );
    return good ? zone : { zone: zone, ok: false };
}

function dropInto( ids, id, zone )
{
    if( zone === 'inside' && ids.indexOf( id ) >= 0 ) return;        // a folder nudged onto itself
    if( zone === 'inside' ) doMove( ids, id );
    else if( ids.indexOf( id ) < 0 ) doPlace( ids, id, zone );       // onto its own edge: nothing to do
}

const DROP_SEL = '.tree-row, .bm-item.is-folder, .crumb-seg';

function wireDragDrop()
{
    // Folder cards and crumbs take dropped items as the tree does.
    NayiveUI.dropZone( $( 'listPane' ), {
        sel: '.bm-item.is-folder, .crumb-seg', target: function( el ) { return el.dataset.id; },
        can: treeCan, drop: dropInto
    } );

    // A link from outside the page: mark the folder under it, then the sheet.
    const marks = function( keep )
    {
        document.querySelectorAll( '.drop-target' ).forEach( function( el ) { if( el !== keep ) el.classList.remove( 'drop-target' ); } );
    };
    document.addEventListener( 'dragleave', function( e ) { if( ! NayiveUI.dragIds() && ! e.relatedTarget ) marks( null ); } );
    document.addEventListener( 'dragover', function( e )
    {
        if( NayiveUI.dragIds() || ! linkDrag( e ) ) return;
        const f = e.target.closest && e.target.closest( DROP_SEL );
        marks( f );
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if( f && isFolder( node( f.dataset.id ) ) ) f.classList.add( 'drop-target' );
    } );
    document.addEventListener( 'drop', function( e )
    {
        if( NayiveUI.dragIds() || ! linkDrag( e ) ) return;
        e.preventDefault();
        marks( null );
        const f = e.target.closest && e.target.closest( DROP_SEL );
        const link = droppedLink( e.dataTransfer );
        if( link && ! document.querySelector( '.sheet-backdrop.open' ) )
            openBookmarkSheet( null, { url: link.url, title: link.title,
                                       folder: f && isFolder( node( f.dataset.id ) ) ? f.dataset.id : null } );
    } );
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
