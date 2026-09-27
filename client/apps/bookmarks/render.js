/*
 * render.js - Bookmarks: what is on screen. The tree pane, the filter pills,
 * the crumbs, the cards / rows, the selection bar and the empty screens.
 */
"use strict";

let curFolder = ROOT;          // the folder being browsed
let filter    = 'all';         // 'all' (browse) | 'fav' | 'recent'
let query     = '';            // the search box
let selecting = false;         // selection mode
let selected  = new Set();     // ids picked in selection mode
let chipTag   = null;          // the tag a chip searched: matched whole while the box still says "#tag"

const ICON_API = window.location.origin + '/api/bookmarks/icon?host=';
const noIcon   = new Set();    // hosts whose icon failed to load on this page
const iconOk   = new Set();    // hosts whose icon loaded on this page: shown at once next time

const SVG = {
    folder:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>',
    star:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7 12 2.8"></polygon></svg>',
    starOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7 12 2.8"></polygon></svg>',
    dots:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.9"></circle><circle cx="12" cy="12" r="1.9"></circle><circle cx="12" cy="19" r="1.9"></circle></svg>',
    move:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="12 10 15 13 12 16"></polyline><line x1="8" y1="13" x2="15" y2="13"></line></svg>',
    link:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
    select:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><polyline points="8 12 11 15 16 9"></polyline></svg>',
    bookmark:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>',
    importI: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    exportI: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
    dupes:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"></rect><path d="M4 16V5a2 2 0 0 1 2-2h11"></path></svg>',
    sort:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="14" y2="6"></line><line x1="4" y1="12" x2="11" y2="12"></line><line x1="4" y1="18" x2="8" y2="18"></line><polyline points="15 15 18 18 21 15"></polyline><line x1="18" y1="6" x2="18" y2="18"></line></svg>'
};

function esc( s ) { return NayiveUI.escapeHtml( s == null ? '' : String( s ) ); }

function isPhone() { return window.matchMedia( '(max-width: 640px)' ).matches; }

// After a re-read or an edit: forget what no longer exists.
function pruneState()
{
    if( ! isFolder( node( curFolder ) ) ) curFolder = ROOT;
    for( const id of Array.from( selected ) ) if( ! node( id ) ) selected.delete( id );
}

//------------------------------------------------------------------------//

function render()
{
    renderTree();
    renderFilters();
    renderCrumbs();
    renderItems();
    renderSelectBar();

    // A search on: the magnifier in the field turns into the × that clears it.
    document.getElementById( 'searchClear' ).classList.toggle( 'show', !! query );
    document.getElementById( 'searchIcon' ).style.display = query ? 'none' : '';

    document.getElementById( 'gridBtn' ).classList.toggle( 'is-active', ui.mode === 'grid' );
    document.getElementById( 'listBtn' ).classList.toggle( 'is-active', ui.mode === 'list' );
}

//------------------------------------------------------------------------//
// TREE

function renderTree()
{
    const host = document.getElementById( 'tree' );
    const open = new Set( ui.open );
    const lit  = filter === 'all' && ! query ? curFolder : null;
    let html = '';

    ( function row( f, depth )
    {
        const kids = childrenOf( f.id ).filter( isFolder );
        const isOpen = f.id === ROOT || open.has( f.id );
        html += '<div class="tree-node">' +
                '<button type="button" class="folder-row tree-row' + ( f.id === lit ? ' is-active' : '' ) + '" data-id="' + esc( f.id ) + '" style="padding-left:' + ( 4 + depth * 16 ) + 'px">' +
                '<span class="twisty' + ( kids.length ? ( isOpen ? ' open' : '' ) : ' leaf' ) + '" data-twisty="1">' + SVG.chevron + '</span>' +
                ( f.id === ROOT ? SVG.bookmark : SVG.folder ) +
                '<span class="tree-name">' + esc( folderName( f ) ) + '</span></button>';
        if( kids.length && isOpen ) for( const k of kids ) row( k, depth + 1 );
        html += '</div>';
    } )( node( ROOT ), 0 );

    host.innerHTML = html;
}

function toggleOpen( id, force )
{
    const i = ui.open.indexOf( id );
    const want = force != null ? force : i < 0;
    if( want && i < 0 ) ui.open.push( id );
    if( ! want && i >= 0 ) ui.open.splice( i, 1 );
    saveUi();
}

// The tree shows the folder being browsed: open every folder above it.
function revealInTree( id )
{
    for( const f of ancestry( id ) ) if( f.id !== id && f.id !== ROOT ) toggleOpen( f.id, true );
}

//------------------------------------------------------------------------//
// FILTER PILLS

function renderFilters()
{
    const all = allBookmarks();
    const fav = all.filter( function( b ) { return b.favorite; } ).length;
    const labels = {
        all:    TF( 'bookmarks.filterAll', { n: all.length } ),
        fav:    TF( 'bookmarks.filterFav', { n: fav } ),
        recent: T( 'bookmarks.filterRecent' )
    };
    document.querySelectorAll( '#filterRow .pill' ).forEach( function( p )
    {
        p.textContent = labels[ p.dataset.filter ];
        p.classList.toggle( 'is-active', ! query && filter === p.dataset.filter );
    } );
}

//------------------------------------------------------------------------//
// CRUMBS  -  "All › Development › Frontend", each part a link and a drop
// target. While searching or filtering they say what is shown instead.

function renderCrumbs()
{
    const host = document.getElementById( 'crumbs' );
    const up   = document.getElementById( 'upBtn' );
    let html = '';

    if( query )
        html = '<span class="crumb-note">' + esc( T( 'bookmarks.results' ) ) + '</span>';
    else if( filter === 'fav' )
        html = '<span class="crumb-note">' + esc( T( 'bookmarks.favourites' ) ) + '</span>';
    else if( filter === 'recent' )
        html = '<span class="crumb-note">' + esc( T( 'bookmarks.recentAdded' ) ) + '</span>';
    else
    {
        const parts = ancestry( curFolder );
        parts.forEach( function( f, i )
        {
            if( i ) html += '<span class="crumb-sep">›</span>';
            html += '<button type="button" class="crumb-seg" data-id="' + esc( f.id ) + '"' +
                    ( i === parts.length - 1 ? ' aria-current="true"' : '' ) + '>' + esc( folderName( f ) ) + '</button>';
        } );
    }
    host.innerHTML = html;

    // ← goes up one level: a phone has no tree to do it with.
    up.hidden = ! ( isPhone() && ! query && filter === 'all' && curFolder !== ROOT );
}

//------------------------------------------------------------------------//
// ITEMS

function sortNodes( list )
{
    const by = ui.sort;
    if( by === 'saved' ) return list;
    const cmp = {
        az:  function( a, b ) { return fold( a.title ).localeCompare( fold( b.title ) ); },
        za:  function( a, b ) { return fold( b.title ).localeCompare( fold( a.title ) ); },
        new: byDate( true ),
        old: byDate( false )
    }[ by ];
    return list.slice().sort( cmp );
}

// What the list shows now, and whether each item says where it lives.
function visibleItems()
{
    if( query )
    {
        const m = chipTag !== null && query === '#' + chipTag ? tagMatcher( chipTag ) : makeMatcher( query );
        const hits = m ? descendants( ROOT ).filter( m ) : [];
        return { items: foldersFirst( hits ), withPath: true };
    }
    if( filter === 'fav' )
        return { items: sortNodes( allBookmarks().filter( function( b ) { return b.favorite; } ) ), withPath: true };
    if( filter === 'recent' )
        return { items: allBookmarks().filter( function( b ) { return b.createdAt; } ).sort( byDate( true ) ).slice( 0, RECENT_N ),
                 withPath: true };
    return { items: foldersFirst( childrenOf( curFolder ) ), withPath: false };
}

function foldersFirst( list )
{
    return sortNodes( list.filter( isFolder ) ).concat( sortNodes( list.filter( function( n ) { return ! isFolder( n ); } ) ) );
}

function renderItems()
{
    const host = document.getElementById( 'items' );
    const vis  = visibleItems();

    host.className = 'items ' + ( ui.mode === 'list' ? 'is-list' : 'is-grid' ) + ( selecting ? ' is-selecting' : '' );
    host.innerHTML = vis.items.map( function( n ) { return itemHtml( n, vis.withPath ); } ).join( '' );
    renderEmpty( vis.items.length );
}

function itemHtml( n, withPath )
{
    const picked = selecting && selected.has( n.id );
    const cls = 'card-row bm-item' + ( isFolder( n ) ? ' is-folder' : '' ) + ( picked ? ' is-selected' : '' );
    const menu = '<button type="button" class="icon-btn sm row-menu" data-menu="1" title="' + esc( T( 'ui.actions' ) ) +
                 '" aria-label="' + esc( T( 'ui.actions' ) ) + '">' + SVG.dots + '</button>';
    const where = withPath ? '<div class="bm-path">' + SVG.folder + '<span>' + esc( pathText( n.parentId ) || T( 'bookmarks.all' ) ) + '</span></div>' : '';

    if( isFolder( n ) )
    {
        const c = countIn( n.id );
        return '<div class="' + cls + '" data-id="' + esc( n.id ) + '" role="button" tabindex="0">' +
               '<div class="bm-top"><span class="bm-ic is-folder">' + SVG.folder + '</span>' +
               '<div class="bm-head"><div class="bm-title">' + esc( folderName( n ) ) + '</div>' +
               '<div class="bm-domain">' + esc( c.bookmarks === 1 ? T( 'bookmarks.folderCountOne' ) : TF( 'bookmarks.folderCount', { n: c.bookmarks } ) ) + '</div></div>' + menu + '</div>' +
               where + '</div>';
    }

    const host = hostOf( n.url );
    // Unseen until it loads (input.js adds "ok"): the initial shows meanwhile.
    const img  = host && ! noIcon.has( host )
               ? '<img alt="" loading="lazy" decoding="async"' + ( iconOk.has( host ) ? ' class="ok"' : '' ) +
                 ' src="' + esc( ICON_API + encodeURIComponent( host ) ) + '">' : '';
    const tags = n.tags.length
               ? '<div class="bm-tags">' + n.tags.map( function( t ) { return '<button type="button" class="pill bm-tag" data-tag="' + esc( t ) + '">#' + esc( t ) + '</button>'; } ).join( '' ) + '</div>'
               : '';
    return '<div class="' + cls + '" data-id="' + esc( n.id ) + '" role="link" tabindex="0" title="' + esc( n.url ) + '">' +
           '<div class="bm-top"><span class="bm-ic" style="--hue:' + hueOf( domainOf( n.url ) || n.title ) + '">' + esc( initialOf( n ) ) + img + '</span>' +
           '<div class="bm-head"><div class="bm-title">' + esc( n.title || domainOf( n.url ) || n.url ) + '</div>' +
           '<div class="bm-domain">' + esc( domainOf( n.url ) || n.url ) + '</div></div>' +
           ( n.favorite ? '<span class="bm-star" title="' + esc( T( 'bookmarks.favourite' ) ) + '">' + SVG.star + '</span>' : '' ) +
           menu + '</div>' +
           ( n.notes ? '<div class="bm-notes">' + esc( n.notes ) + '</div>' : '' ) +
           tags + where + '</div>';
}

//------------------------------------------------------------------------//
// EMPTY SCREENS

function renderEmpty( count )
{
    const box = document.getElementById( 'emptyHint' );
    if( count ) { box.hidden = true; return; }

    let text, btns = [];
    if( ! loaded )
        text = T( 'bookmarks.notLoaded' );          // the plug reads again
    else if( ! descendants( ROOT ).length )
    {
        text = T( 'bookmarks.emptyAll' );
        btns = [ [ 'add', T( 'bookmarks.newBookmark' ) ], [ 'import', T( 'bookmarks.importBrowser' ) ] ];
    }
    else if( query )
        text = T( 'bookmarks.emptySearch' );        // the × in the field clears it
    else if( filter === 'fav' )
        text = T( 'bookmarks.emptyFav' );
    else if( filter === 'recent' )
        text = T( 'bookmarks.emptyRecent' );
    else
    {
        text = T( 'bookmarks.emptyFolder' );
        btns = [ [ 'add', T( 'bookmarks.newBookmark' ) ] ];
    }

    box.innerHTML = SVG.bookmark + '<p>' + esc( text ) + '</p>' +
        ( btns.length ? '<div class="empty-btns">' + btns.map( function( b, i )
        {
            return '<button type="button" class="text-btn' + ( i ? ' ghost' : '' ) + '" data-empty="' + b[ 0 ] + '">' + esc( b[ 1 ] ) + '</button>';
        } ).join( '' ) + '</div>' : '' );
    box.hidden = false;
}

//------------------------------------------------------------------------//
// SELECTION BAR

function renderSelectBar()
{
    const bar = document.getElementById( 'selectBar' );
    bar.hidden = ! selecting;
    document.getElementById( 'filterRow' ).hidden = selecting;
    if( ! selecting ) return;
    document.getElementById( 'selectCount' ).textContent = TF( 'bookmarks.selectedN', { n: selected.size } );
    document.getElementById( 'selectMoveBtn' ).disabled   = ! selected.size;
    document.getElementById( 'selectDeleteBtn' ).disabled = ! selected.size;
}

function setSelecting( on )
{
    selecting = on;
    if( ! on ) selected.clear();
    render();
}
