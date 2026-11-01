/*
 * render.js - Passwords: what is on screen while the vault is open. The tree
 * pane, the filter pills, the crumbs, the rows and the empty screens. The
 * gate (set-up, unlock, recovery key) is lock.js. Picking and the selection's
 * header buttons are the shared item list (input.js wires it).
 *
 * Nothing secret is ever drawn here: a row shows the name, the user name and
 * the site, never a password.
 */
"use strict";

let curFolder = ROOT;          // the folder being browsed
let filter    = 'all';         // 'all' (browse) | 'fav'
let query     = '';            // the search box

const SVG = {
    folder:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>',
    star:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7 12 2.8"></polygon></svg>',
    key:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"></circle><path d="M10.7 12.3 21 2"></path><path d="m15.5 7.5 3 3"></path><path d="m18 5 2.5 2.5"></path></svg>',
    user:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
    note:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg>',
    external:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>',
    dice:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="8" cy="8" r="1.2" fill="currentColor"></circle><circle cx="16" cy="8" r="1.2" fill="currentColor"></circle><circle cx="12" cy="12" r="1.2" fill="currentColor"></circle><circle cx="8" cy="16" r="1.2" fill="currentColor"></circle><circle cx="16" cy="16" r="1.2" fill="currentColor"></circle></svg>',
    again:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>',
    importI: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    exportI: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
    minus:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>'
};

function $( id ) { return document.getElementById( id ); }

function esc( s ) { return NayiveUI.escapeHtml( s == null ? '' : String( s ) ); }

function isPhone() { return window.matchMedia( '(max-width: 640px)' ).matches; }

// After a re-read or an edit: forget what no longer exists.
function pruneState()
{
    if( curFolder !== ROOT && ! isFolder( item( curFolder ) ) ) curFolder = ROOT;
}

//------------------------------------------------------------------------//
// SITES  -  an entry's first address, as shown; the coloured initial.

function siteOf( n ) { return n && n.urls && n.urls.length ? n.urls[ 0 ] : ''; }

function hostOf( url )
{
    try { return new URL( /^[a-z][a-z0-9+.-]*:/i.test( url ) ? url : 'https://' + url ).host.toLowerCase(); }
    catch( e ) { return ''; }
}

function domainOf( url ) { return hostOf( url ).replace( /^www\./, '' ); }

function hueOf( s )
{
    let h = 0;
    for( let i = 0; i < s.length; i++ ) h = ( h * 31 + s.charCodeAt( i ) ) >>> 0;
    return h % 360;
}

function initialOf( n )
{
    const s = ( n.title || domainOf( siteOf( n ) ) || '?' ).replace( /^[^\p{L}\p{N}]+/u, '' );
    return ( s.charAt( 0 ) || '?' ).toUpperCase();
}

//------------------------------------------------------------------------//

// The vault is on screen: open, and the new vault's recovery key no longer on show.
function vaultShown() { return isOpen() && gateStep !== 'recovery'; }

function render()
{
    const open = vaultShown();
    document.getElementById( 'vaultRow' ).hidden  = ! open;
    document.getElementById( 'vaultTools' ).hidden = ! open;
    document.getElementById( 'gate' ).hidden = open;
    if( ! open )
    {
        if( browse ) browse.clear();
        document.getElementById( 'selActions' ).hidden = true;
        renderGate();
        return;
    }
    pruneState();
    renderTree();
    renderFilters();
    renderCrumbs();
    renderItems();
}

//------------------------------------------------------------------------//
// TREE  -  the shared tree (input.js makes it: Ayni.tree, nav), folders only.

function treeRoots()
{
    function mk( f ) { return { id: f.id, name: folderName( f ), children: sortByName( childrenOf( f.id ).filter( isFolder ) ).map( mk ) }; }
    return sortByName( childrenOf( ROOT ).filter( isFolder ) ).map( mk );
}

function renderTree() { if( treeView ) treeView.build(); }

function toggleOpen( id, force )
{
    const i = ui.open.indexOf( id );
    const want = force != null ? force : i < 0;
    if( want && i < 0 ) ui.open.push( id );
    if( ! want && i >= 0 ) ui.open.splice( i, 1 );
    saveUi();
}

function revealInTree( id )
{
    for( const f of ancestry( id ) ) if( f.id !== id ) toggleOpen( f.id, true );
}

//------------------------------------------------------------------------//
// FILTER PILLS  -  All (n) · Favourites (n)

function renderFilters()
{
    const all = allEntries();
    const labels = {
        all: TF( 'passwords.filterAll', { n: all.length } ),
        fav: TF( 'passwords.filterFav', { n: all.filter( function( n ) { return n.fav; } ).length } )
    };
    document.querySelectorAll( '#filterRow .pill' ).forEach( function( p )
    {
        p.textContent = labels[ p.dataset.filter ];
        p.classList.toggle( 'is-active', ! query && filter === p.dataset.filter );
    } );
}

//------------------------------------------------------------------------//
// CRUMBS  -  "All › Bank › Cards", each part a link and a drop target.

function renderCrumbs()
{
    const host = document.getElementById( 'crumbs' );
    const up   = document.getElementById( 'upBtn' );
    let html = '';

    if( query )
        html = '<span class="crumb-note">' + esc( T( 'passwords.results' ) ) + '</span>';
    else if( filter === 'all' && curFolder !== ROOT )
    {
        const parts = [ null ].concat( ancestry( curFolder ) );
        parts.forEach( function( f, i )
        {
            if( i ) html += '<span class="crumb-sep">›</span>';
            html += '<button type="button" class="crumb-seg" data-id="' + esc( f ? f.id : ROOT ) + '"' +
                    ( i === parts.length - 1 ? ' aria-current="true"' : '' ) + '>' + esc( folderName( f ) ) + '</button>';
        } );
    }
    host.innerHTML = html;
    host.parentElement.hidden = ! html && ! isPhone();     // a phone keeps the row: the folder button opens the tree
    up.hidden = ! ( isPhone() && ! query && filter === 'all' && curFolder !== ROOT );
}

//------------------------------------------------------------------------//
// ROWS

function sortEntries( list )
{
    if( ui.sort === 'changed' )
        return list.slice().sort( function( a, b ) { return ( b.updated || '' ).localeCompare( a.updated || '' ); } );
    return sortByName( list );
}

// Search: the shared rule (words in any order, "phrase", -word, accents
// folded) over the name, the user name, the sites, the notes and the extra
// fields' names. Never over a password or a hidden field's value.
function makeMatcher( q )
{
    const m = Ayni.matcher( q );
    if( ! m ) return null;
    return function( n )
    {
        if( isFolder( n ) ) return m( n.title );
        return m( [ n.title, n.user, n.urls.join( '\n' ), n.notes ]
                  .concat( n.fields.map( function( f ) { return f.hidden ? f.name : f.name + ' ' + f.value; } ) ).join( '\n' ) );
    };
}

function visibleItems()
{
    if( query )
    {
        const m = makeMatcher( query );
        const hits = m ? Object.keys( items ).map( item ).filter( m ) : [];
        return { items: foldersFirst( hits ), withPath: true };
    }
    if( filter === 'fav' )
        return { items: sortEntries( allEntries().filter( function( n ) { return n.fav; } ) ), withPath: true };
    return { items: foldersFirst( childrenOf( curFolder ) ), withPath: false };
}

function foldersFirst( list )
{
    return sortByName( list.filter( isFolder ) ).concat( sortEntries( list.filter( function( n ) { return ! isFolder( n ); } ) ) );
}

function renderItems()
{
    const host = document.getElementById( 'items' );
    const vis  = visibleItems();
    host.innerHTML = vis.items.map( function( n ) { return itemHtml( n, vis.withPath ); } ).join( '' );
    renderEmpty( vis.items.length );
}

function itemHtml( n, withPath )
{
    const cls   = 'card-row pw-item' + ( isFolder( n ) ? ' is-folder' : '' );
    const tick  = Ayni.pickTick();
    const where = withPath ? '<div class="pw-path">' + SVG.folder + '<span>' + esc( pathText( parentOf[ n.id ] ) || T( 'passwords.all' ) ) + '</span></div>' : '';
    const open  = '<div class="' + cls + '" data-id="' + esc( n.id ) + '" role="option" tabindex="-1">';

    if( isFolder( n ) )
    {
        const count = descendants( n.id ).filter( function( x ) { return ! isFolder( x ); } ).length;
        return open + tick + '<span class="pw-ic is-folder">' + SVG.folder + '</span>' +
               '<div class="pw-head"><div class="pw-title">' + esc( folderName( n ) ) + '</div>' +
               '<div class="pw-sub">' + esc( count === 1 ? T( 'passwords.countOne' ) : TF( 'passwords.countN', { n: count } ) ) + '</div>' + where + '</div></div>';
    }

    const site = domainOf( siteOf( n ) );
    const sub  = n.type === 'note' ? T( 'passwords.typeNote' ) : [ n.user, site ].filter( Boolean ).join( ' · ' );
    const ic   = n.type === 'note'
               ? '<span class="pw-ic is-note">' + SVG.note + '</span>'
               : '<span class="pw-ic" style="--hue:' + hueOf( site || n.title ) + '">' + esc( initialOf( n ) ) + '</span>';
    const btn  = function( what, icon, key, off )
    {
        return '<button type="button" class="btn sm pw-copy" data-copy="' + what + '"' + ( off ? ' aria-disabled="true"' : '' ) +
               ' data-tip="' + esc( T( key ) ) + '" aria-label="' + esc( T( key ) ) + '">' + icon + '</button>';
    };
    const acts = n.type === 'login'
               ? '<div class="pw-acts">' + btn( 'user', SVG.user, 'passwords.copyUser', ! n.user ) +
                 btn( 'pass', SVG.key, 'passwords.copyPass', ! n.pass ) + '</div>'
               : '';
    return open + tick + ic +
           '<div class="pw-head"><div class="pw-title">' + esc( n.title || site || T( 'ui.untitled' ) ) + '</div>' +
           '<div class="pw-sub">' + esc( sub ) + '</div>' + where + '</div>' +
           ( n.fav ? '<span class="pw-star" title="' + esc( T( 'passwords.favourite' ) ) + '">' + SVG.star + '</span>' : '' ) +
           acts + '</div>';
}

//------------------------------------------------------------------------//
// EMPTY SCREENS

function renderEmpty( count )
{
    const box = document.getElementById( 'emptyHint' );
    if( count ) { box.hidden = true; return; }

    let text, btns = [];
    if( ! Object.keys( items ).length )
    {
        text = T( 'passwords.emptyAll' );
        btns = [ [ 'add', T( 'passwords.newItem' ) ], [ 'import', T( 'passwords.import' ) ] ];
    }
    else if( query )         text = T( 'passwords.emptySearch' );
    else if( filter === 'fav' ) text = T( 'passwords.emptyFav' );
    else
    {
        text = T( 'passwords.emptyFolder' );
        btns = [ [ 'add', T( 'passwords.newItem' ) ] ];
    }

    box.innerHTML = SVG.key + '<p>' + esc( text ) + '</p>' +
        ( btns.length ? '<div class="empty-btns">' + btns.map( function( b, i )
        {
            return '<button type="button" class="btn text' + ( i ? ' bordered' : ' primary' ) + '" data-empty="' + b[ 0 ] + '">' + esc( b[ 1 ] ) + '</button>';
        } ).join( '' ) + '</div>' : '' );
    box.hidden = false;
}
