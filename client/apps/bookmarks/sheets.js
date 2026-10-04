// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * sheets.js - Bookmarks: the add / edit sheet, the folder sheet, "Move to…",
 * and the deletes (a bookmark goes at once with Undo; a folder asks once).
 */
"use strict";

let editId      = null;   // the bookmark being edited, or null for a new one
let autoTitle   = '';     // the title WE filled in (a domain, then the page's own)
let titleSeq    = 0;      // the newest title lookup asked for
let titleAsk    = null;   // { url, promise } - the page-title lookup in flight
const titleSeen = new Map();   // url -> the answer it got on this page ("" = none)
let folderEdit  = null;   // the folder being renamed, or null for a new one
let moveIds     = [];     // what "Move to…" moves

// The indented folder list every picker shares. `skip` is the folders that
// may not be offered (a folder and everything below it, when moving it).
function fillFolderSelect( sel, chosen, skip )
{
    const bad = new Set();
    for( const id of skip || [] )
    {
        bad.add( id );
        for( const d of descendants( id ) ) bad.add( d.id );
    }
    sel.innerHTML = folderList().filter( function( e ) { return ! bad.has( e.f.id ); } ).map( function( e )
    {
        return '<option value="' + esc( e.f.id ) + '"' + ( e.f.id === chosen ? ' selected' : '' ) + '>' +
               '   '.repeat( e.depth ) + esc( folderName( e.f ) ) + '</option>';
    } ).join( '' );
    if( ! sel.value ) sel.value = ROOT;
}

// Where a new thing goes: the folder on screen, or the root while a search
// or filter is showing.
function targetFolder() { return ! query && filter === 'all' ? curFolder : ROOT; }

//------------------------------------------------------------------------//
// BOOKMARK SHEET

// `preset` (a link dropped on the page, or ?add= from the "Save from any
// page" button): { url, title, folder }.
function openBookmarkSheet( id, preset )
{
    const b = id ? node( id ) : null;
    editId    = b ? b.id : null;
    autoTitle = '';
    titleSeq++;

    document.getElementById( 'bmTitle' ).textContent = T( b ? 'bookmarks.editBookmark' : 'bookmarks.newBookmark' );
    document.getElementById( 'bmUrl' ).value   = b ? b.url : ( preset && preset.url ) || '';
    document.getElementById( 'bmName' ).value  = b ? b.title : ( preset && preset.title ) || '';
    document.getElementById( 'bmTags' ).value  = b ? b.tags.join( ', ' ) : '';
    document.getElementById( 'bmNotes' ).value = b ? b.notes : '';
    document.getElementById( 'bmFav' ).checked = b ? b.favorite : false;
    fillFolderSelect( document.getElementById( 'bmFolder' ), b ? b.parentId : ( preset && preset.folder ) || targetFolder() );
    document.getElementById( 'bmDeleteBtn' ).hidden = ! b;
    document.getElementById( 'bmUrlError' ).hidden  = true;
    checkDupUrl();

    NayiveUI.open( 'bmBackdrop' );
    if( preset && preset.url && ! preset.title ) autofillTitle();
    if( ! b && ! ( preset && preset.url ) )
    {
        const input = document.getElementById( 'bmUrl' );
        setTimeout( function() { input.focus(); }, 0 );
    }
}

// "Already in Development › Frontend", while the URL is typed.
function checkDupUrl()
{
    const note = document.getElementById( 'bmDupNote' );
    const url  = normalizeUrl( document.getElementById( 'bmUrl' ).value );
    const hit  = url && findByUrl( url, editId );
    note.hidden = ! hit;
    if( hit ) note.textContent = TF( 'bookmarks.alreadyIn', { path: pathText( hit.parentId ) || T( 'bookmarks.all' ) } );
}

// An empty title becomes the domain at once, then the page's own <title>
// when the server has read it - but only while the field still holds what
// WE put there, never over something typed.
function autofillTitle()
{
    const urlEl  = document.getElementById( 'bmUrl' );
    const nameEl = document.getElementById( 'bmName' );
    const url    = normalizeUrl( urlEl.value );
    if( ! url ) return;
    if( nameEl.value.trim() && nameEl.value !== autoTitle ) return;

    const u = new URL( url );
    if( u.protocol !== 'http:' && u.protocol !== 'https:' ) return;

    autoTitle    = domainOf( url );
    nameEl.value = autoTitle;

    const seq = ++titleSeq;
    askTitle( url ).then( function( title )
    {
        if( ! title || seq !== titleSeq ) return;
        if( ! document.getElementById( 'bmBackdrop' ).classList.contains( 'open' ) ) return;
        if( nameEl.value !== autoTitle ) return;
        autoTitle    = title;
        nameEl.value = title;
    } );
}

// The page's own <title>, read by the server -> a promise of it, or of ""
// (no title, no answer within 12 s). One lookup per address: Save reuses the
// one the sheet started, or its answer.
function askTitle( url )
{
    if( titleSeen.has( url ) ) return Promise.resolve( titleSeen.get( url ) );
    if( titleAsk && titleAsk.url === url ) return titleAsk.promise;
    const ctl = window.AbortController ? new AbortController() : null;
    const timer = ctl ? setTimeout( function() { ctl.abort(); }, 12000 ) : 0;
    const promise = fetch( window.location.origin + '/api/bookmarks/title?url=' + encodeURIComponent( url ),
                           { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined } )
        .then( function( r ) { return r.ok ? r.json() : null; } )
        .then( function( j ) { return j && typeof j.title === 'string' ? j.title : ''; } )
        .catch( function() { return ''; } )
        .then( function( t )
        {
            clearTimeout( timer );
            titleSeen.set( url, t );
            if( titleAsk && titleAsk.promise === promise ) titleAsk = null;
            return t;
        } );
    titleAsk = { url: url, promise: promise };
    return promise;
}

// Saved before the page's title came (paste + Enter): it still lands, on the
// bookmark, while that one keeps the domain we put there.
function titleLater( id, url, shown )
{
    let u;
    try { u = new URL( url ); } catch( e ) { return; }
    if( u.protocol !== 'http:' && u.protocol !== 'https:' ) return;
    askTitle( url ).then( function( title )
    {
        const b = node( id );
        if( ! title || ! b || b.url !== url || b.title !== shown ) return;
        b.title = title;
        if( save() ) render();
    } );
}

function saveBookmarkSheet()
{
    if( ! canEdit() ) return;
    const raw = document.getElementById( 'bmUrl' ).value;
    const url = normalizeUrl( raw );
    const err = document.getElementById( 'bmUrlError' );
    if( ! url )
    {
        err.textContent = T( raw.trim() ? 'bookmarks.badUrl' : 'bookmarks.needUrl' );
        err.hidden = false;
        document.getElementById( 'bmUrl' ).focus();
        return;
    }
    const typed = document.getElementById( 'bmName' ).value;
    // Nobody typed a title and the page's has not come yet: it may still.
    const auto  = ! typed.trim() || ( typed === autoTitle && typed === domainOf( url ) );
    const f = {
        url:      url,
        title:    typed.trim() || domainOf( url ) || url,
        tags:     document.getElementById( 'bmTags' ).value,
        notes:    document.getElementById( 'bmNotes' ).value.trim(),
        favorite: document.getElementById( 'bmFav' ).checked
    };
    const dest = document.getElementById( 'bmFolder' ).value || ROOT;

    let b;
    if( editId && node( editId ) )
    {
        b = node( editId );
        b.url = f.url; b.title = f.title; b.tags = cleanTags( f.tags ); b.notes = f.notes; b.favorite = f.favorite;
        if( b.parentId !== dest ) moveNodes( [ b.id ], dest );
    }
    else
        b = makeBookmark( f, dest );

    if( ! save() ) return;
    NayiveUI.close( 'bmBackdrop' );
    render();
    if( auto ) titleLater( b.id, b.url, b.title );
}

//------------------------------------------------------------------------//
// FOLDER SHEET

function openFolderSheet( id, parentId )
{
    const f = id ? node( id ) : null;
    folderEdit = f ? f.id : null;
    document.getElementById( 'folderTitle' ).textContent = T( f ? 'ui.rename' : 'ui.newFolder' );
    document.getElementById( 'folderName' ).value = f ? f.title : '';
    fillFolderSelect( document.getElementById( 'folderParent' ),
                      f ? f.parentId : ( parentId || targetFolder() ), f ? [ f.id ] : [] );
    NayiveUI.open( 'folderBackdrop' );
    const input = document.getElementById( 'folderName' );
    setTimeout( function() { input.focus(); input.select(); }, 0 );
}

function saveFolderSheet()
{
    if( ! canEdit() ) return;
    const name = document.getElementById( 'folderName' ).value.trim();
    if( ! name ) { document.getElementById( 'folderName' ).focus(); return; }
    const dest = document.getElementById( 'folderParent' ).value || ROOT;

    if( folderEdit && node( folderEdit ) )
    {
        const f = node( folderEdit );
        if( f.parentId !== dest && ! canMove( [ f.id ], dest ) ) { NayiveUI.toast( T( 'bookmarks.cycle' ) ); return; }
        f.title = name;
        if( f.parentId !== dest ) moveNodes( [ f.id ], dest );
    }
    else
    {
        const f = makeFolder( name, dest );
        revealInTree( f.id );
    }
    if( ! save() ) return;
    NayiveUI.close( 'folderBackdrop' );
    render();
}

//------------------------------------------------------------------------//
// MOVE TO…

function openMoveSheet( ids )
{
    moveIds = ids.filter( function( id ) { return node( id ) && id !== ROOT; } );
    if( ! moveIds.length ) return;
    document.getElementById( 'moveTitle' ).textContent = moveIds.length === 1
        ? TF( 'bookmarks.moveOne', { name: node( moveIds[ 0 ] ).title || domainOf( node( moveIds[ 0 ] ).url || '' ) } )
        : TF( 'bookmarks.moveN', { n: moveIds.length } );
    const folders = moveIds.filter( function( id ) { return isFolder( node( id ) ); } );
    fillFolderSelect( document.getElementById( 'moveFolder' ), node( moveIds[ 0 ] ).parentId, folders );
    NayiveUI.open( 'moveBackdrop' );
}

// Already all there ("Move here" on their own folder, a card dropped on the
// folder it is in): nothing to do, nothing said.
function doMove( ids, dest )
{
    if( ids.every( function( id ) { return node( id ) && node( id ).parentId === dest; } ) ) return true;
    if( ! canEdit() ) return false;
    if( ! canMove( ids, dest ) ) { NayiveUI.toast( T( 'bookmarks.cycle' ) ); return false; }
    moveNodes( ids, dest );
    if( ! save() ) return false;
    NayiveUI.toast( TF( 'bookmarks.movedTo', { name: folderName( node( dest ) ) } ) );
    if( selecting ) setSelecting( false ); else render();
    return true;
}

// The tree's reorder: before / after a folder row (placeNodes). Quiet when
// the folder stays the same - only the order changed.
function doPlace( ids, anchorId, where )
{
    if( ! canEdit() ) return false;
    const n = node( ids[ 0 ] );
    const from = n ? n.parentId : null;
    const dest = placeNodes( ids, anchorId, where );
    if( ! dest ) { NayiveUI.toast( T( 'bookmarks.cycle' ) ); return false; }
    if( ! save() ) return false;
    if( dest !== from ) NayiveUI.toast( TF( 'bookmarks.movedTo', { name: folderName( node( dest ) ) } ) );
    if( dest !== ROOT ) toggleOpen( dest, true );          // the tree shows where they went
    if( selecting ) setSelecting( false ); else render();
    return true;
}

//------------------------------------------------------------------------//
// DELETE  -  a bookmark (or bookmarks only) goes at once, with Undo. A
// folder asks ONE question that says what goes with it; then Undo too.

async function deleteNodes( ids )
{
    ids = ids.filter( function( id ) { return node( id ) && id !== ROOT; } );
    if( ! ids.length || ! canEdit() ) return;

    const folders = ids.filter( function( id ) { return isFolder( node( id ) ); } );
    if( folders.length )
    {
        let nf = 0, nb = 0;
        const counted = new Set();
        for( const id of ids )
            for( const n of [ node( id ) ].concat( isFolder( node( id ) ) ? descendants( id ) : [] ) )
            {
                if( counted.has( n.id ) ) continue;
                counted.add( n.id );
                if( isFolder( n ) ) nf++; else nb++;
            }
        const ok = await NayiveUI.confirm( {
            title:   folders.length === 1 && ids.length === 1 ? TF( 'bookmarks.deleteFolderQ', { name: folderName( node( ids[ 0 ] ) ) } ) : T( 'bookmarks.deleteManyQ' ),
            body:    TF( 'bookmarks.deleteCounts', { folders: nf, bookmarks: nb } ),
            confirm: T( 'ui.delete' ),
            danger:  true
        } );
        if( ! ok ) return;
    }

    const rec = removeNodes( ids );
    save();
    if( selecting ) setSelecting( false );
    pruneState();
    render();
    NayiveUI.undoToast( ids.length === 1 ? T( 'bookmarks.deleted' ) : TF( 'bookmarks.deletedN', { n: ids.length } ), function()
    {
        putBack( rec );
        save();
        pruneState();
        render();
    } );
}

//------------------------------------------------------------------------//
// SMALL ACTIONS

function toggleFavourite( id )
{
    const b = node( id );
    if( ! b || isFolder( b ) || ! canEdit() ) return;
    b.favorite = ! b.favorite;
    if( save() ) render();
}

function copyLink( id )
{
    const b = node( id );
    if( ! b ) return;
    const done = function() { NayiveUI.toast( T( 'bookmarks.linkCopied' ) ); };
    if( navigator.clipboard && navigator.clipboard.writeText )
        navigator.clipboard.writeText( b.url ).then( done, function() { NayiveUI.toast( b.url ); } );
    else
        NayiveUI.toast( b.url );
}

function openLink( id )
{
    const b = node( id );
    if( ! b || ! b.url ) return;
    if( ! isOpenable( b.url ) ) { NayiveUI.toast( T( 'bookmarks.cannotOpen' ) ); return; }
    const w = window.open( b.url, '_blank', 'noopener' );
    if( w ) try { w.opener = null; } catch( e ) {}
}

function goFolder( id )
{
    if( ! isFolder( node( id ) ) ) return;
    curFolder = id;
    filter    = 'all';
    if( query ) { query = ''; document.getElementById( 'searchInput' ).value = ''; }
    revealInTree( id );
    render();
    document.getElementById( 'listPane' ).scrollTop = 0;
}
