/*
 * io.js - Bookmarks: import (browser HTML or this app's JSON), export (the
 * same two), and the duplicates sheet.
 *
 * THE BROWSER FILE is the "Netscape bookmark file" Chrome, Firefox, Safari
 * and Edge all write and read:
 *
 *   <!DOCTYPE NETSCAPE-Bookmark-file-1>
 *   <DL><p>
 *     <DT><H3 ADD_DATE="1695000000">Folder</H3>
 *     <DL><p>
 *       <DT><A HREF="https://…" ADD_DATE="…" TAGS="a,b">Title</A>
 *       <DD>A note (Firefox)
 *     </DL><p>
 *   </DL><p>
 *
 * Parsed with the browser's own HTML parser, so its quirks decide the shape:
 * a folder's <DL> may land inside its <DT> (the usual case) or after it, or
 * inside the <DD> that follows it (a folder with a description). All three
 * are looked for. ADD_DATE is in seconds; a file without it (Safari) gives
 * bookmarks with no date (""). Every address goes through normalizeUrl, like
 * a typed one: a script link or anything else it refuses is skipped and
 * counted (Firefox's place: queries are skipped without a word).
 */
"use strict";

//------------------------------------------------------------------------//
// PARSE

// -> { items: [ { folder: true, title, createdAt, items: [...] } |
//               { title, url, tags, notes, createdAt } ], skipped }
function parseNetscape( text )
{
    const doc = new DOMParser().parseFromString( text, 'text/html' );
    const top = doc.querySelector( 'dl' );
    const out = { items: [], skipped: 0 };
    if( top ) out.items = readDl( top, out );
    return out;
}

function readDl( dl, out0 )
{
    const out = [];
    for( const dt of dtsOf( dl ) )
    {
        const h3 = dt.querySelector( ':scope > h3' );
        const a  = dt.querySelector( ':scope > a' );
        if( h3 )
        {
            const sub = dt.querySelector( ':scope > dl' ) || followingDl( dt );
            out.push( { folder: true, title: h3.textContent.trim(), createdAt: fromEpoch( h3.getAttribute( 'add_date' ) ),
                        items: sub ? readDl( sub, out0 ) : [] } );
        }
        else if( a )
        {
            const href = ( a.getAttribute( 'href' ) || '' ).trim();
            if( ! href || /^place:/i.test( href ) ) continue;
            const url = normalizeUrl( href );
            if( ! url ) { out0.skipped++; continue; }
            const dd = nextEl( dt );
            out.push( { title: a.textContent.trim(), url: url,
                        tags: cleanTags( a.getAttribute( 'tags' ) || '' ),
                        notes: dd && dd.tagName === 'DD' ? ownText( dd ) : '',
                        createdAt: fromEpoch( a.getAttribute( 'add_date' ) ) } );
        }
    }
    return out;
}

// The <DT>s of a list: its children, and those of any <P> wrapper in it.
function dtsOf( dl )
{
    const out = [];
    for( const el of dl.children )
    {
        if( el.tagName === 'DT' ) out.push( el );
        else if( el.tagName === 'P' ) for( const k of el.children ) if( k.tagName === 'DT' ) out.push( k );
    }
    return out;
}

function nextEl( el )
{
    let n = el.nextElementSibling;
    while( n && n.tagName === 'P' ) n = n.nextElementSibling;
    return n;
}

// A folder's list when the parser did not nest it in the <DT>.
function followingDl( dt )
{
    const n = nextEl( dt );
    if( ! n ) return null;
    if( n.tagName === 'DL' ) return n;
    if( n.tagName === 'DD' ) return n.querySelector( ':scope > dl' );
    return null;
}

// A <DD>'s own words, without a nested list. A <BR> is a line break (our own
// export writes a note's lines that way); spaces collapse within a line.
function ownText( dd )
{
    let s = '';
    for( const c of dd.childNodes )
        if( c.nodeType === 3 ) s += c.nodeValue;
        else if( c.nodeName === 'BR' ) s += '\n';
    return s.split( '\n' ).map( function( l ) { return l.replace( /\s+/g, ' ' ).trim(); } ).join( '\n' ).trim();
}

// "" when the file does not say.
function fromEpoch( v )
{
    const n = parseInt( v, 10 );
    if( ! ( n > 0 ) ) return '';
    // Some exporters write microseconds (Chrome's own "date_added"); seconds
    // are ten digits until the year 2286.
    const secs = n > 1e11 ? Math.floor( n / ( n > 1e14 ? 1e6 : 1e3 ) ) : n;
    return new Date( secs * 1000 ).toISOString().replace( /\.\d{3}Z$/, 'Z' );
}

// This app's own JSON, as the same neutral shape.
function parseOwnJson( text )
{
    const d = repair( JSON.parse( text ) );
    const out = { items: [], skipped: 0 };
    const walk = function( fid )
    {
        const list = [];
        for( const id of d.nodes[ fid ].children || [] )
        {
            const n = d.nodes[ id ];
            if( n.type === 'folder' ) { list.push( { folder: true, title: n.title, createdAt: n.createdAt, items: walk( id ) } ); continue; }
            const url = normalizeUrl( n.url );
            if( ! url ) { out.skipped++; continue; }
            list.push( { title: n.title, url: url, tags: n.tags, notes: n.notes, favorite: n.favorite, createdAt: n.createdAt } );
        }
        return list;
    };
    out.items = walk( ROOT );
    return out;
}

function parseImport( text, name )
{
    const s = text.replace( /^﻿/, '' );
    if( /\.json$/i.test( name || '' ) || /^\s*\{/.test( s ) ) return parseOwnJson( s );
    return parseNetscape( s );
}

//------------------------------------------------------------------------//
// IMPORT

function importMode()
{
    const r = document.querySelector( 'input[name="importMode"]:checked' );
    return r ? r.value : 'add';
}

function importFromDevice()
{
    const input = document.getElementById( 'importInput' );
    input.value = '';
    input.click();
}

async function importFromNayive()
{
    const f = await NayiveUI.pickFile( { title: T( 'bookmarks.import' ),
                                        only: function( name ) { return /\.(html?|json)$/i.test( name ); } } );
    if( ! f ) return;
    let text;
    try { text = await GumApi.readFile( f.path ); }
    catch( e ) { NayiveUI.toast( T( 'ui.openFailed' ) ); return; }
    await applyImport( text, f.name );
}

async function importFile( file )
{
    let text;
    try { text = await file.text(); }
    catch( e ) { NayiveUI.toast( T( 'ui.openFailed' ) ); return; }
    await applyImport( text, file.name );
}

async function applyImport( text, name )
{
    if( ! loaded ) { NayiveUI.toast( T( 'ui.store.notRead' ) ); return; }

    let tree;
    try { tree = parseImport( text, name ); }
    catch( e ) { tree = null; }
    const counts = tree ? countTree( tree.items ) : { folders: 0, bookmarks: 0 };
    if( ! counts.bookmarks && ! counts.folders )
    {
        NayiveUI.toast( T( 'bookmarks.importNone' ) );
        return;
    }
    if( ! canEdit() ) return;

    const mode = importMode();
    if( mode === 'replace' )
    {
        const have = allBookmarks().length;
        const ok = await NayiveUI.confirm( {
            title:   T( 'bookmarks.importReplace' ),
            body:    TF( 'bookmarks.replaceQ', { have: have, n: counts.bookmarks } ),
            confirm: T( 'bookmarks.importReplace' ),
            danger:  true
        } );
        if( ! ok ) return;
    }

    const before = snapshot();
    if( mode === 'replace' ) data = emptyData();
    const dest = mode === 'replace' ? ROOT
               : makeFolder( TF( 'bookmarks.importedFolder', { date: NayiveUI.todayIso() } ), ROOT ).id;
    addTree( tree.items, dest );

    if( ! save() ) { data = before; return; }
    NayiveUI.close( 'importBackdrop' );
    curFolder = dest; filter = 'all';
    if( query ) { query = ''; document.getElementById( 'searchInput' ).value = ''; }
    revealInTree( dest );
    pruneState();
    render();

    const what = [ counts.bookmarks === 1 ? T( 'bookmarks.folderCountOne' ) : TF( 'bookmarks.folderCount', { n: counts.bookmarks } ) ];
    if( counts.folders ) what.push( counts.folders === 1 ? T( 'bookmarks.oneFolder' ) : TF( 'bookmarks.nFolders', { n: counts.folders } ) );
    const msg = TF( 'bookmarks.importDone', { what: what.join( ', ' ) } ) +
                ( tree.skipped ? ' · ' + TF( 'bookmarks.importSkipped', { n: tree.skipped } ) : '' );
    // Undo: Replace all puts the old file back; Add takes the new folder away.
    NayiveUI.undoToast( msg, mode === 'replace'
        ? function() { data = before; save(); pruneState(); render(); }
        : function() { removeNodes( [ dest ] ); save(); pruneState(); render(); } );

    // Contacts does the same after a .vcf import: show the copies at once.
    const fresh = mode === 'replace' ? null : dest;
    if( findDuplicates( fresh ).length ) setTimeout( function() { openDupSheet( true, fresh ); }, 400 );
}

function countTree( items )
{
    let folders = 0, bookmarks = 0;
    ( function walk( list ) { for( const it of list ) if( it.folder ) { folders++; walk( it.items ); } else bookmarks++; } )( items );
    return { folders: folders, bookmarks: bookmarks };
}

function addTree( items, parentId )
{
    for( const it of items )
    {
        if( it.folder )
        {
            const f = makeFolder( it.title || T( 'ui.untitled' ), parentId );
            if( it.createdAt != null ) f.createdAt = it.createdAt;
            addTree( it.items, f.id );
        }
        else
            makeBookmark( it, parentId );
    }
}

//------------------------------------------------------------------------//
// EXPORT

function htmlEsc( s )
{
    return String( s == null ? '' : s ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' )
                                       .replace( /"/g, '&quot;' );
}

// ' ADD_DATE="…"', or nothing when the date is unknown.
function addDate( iso ) { const t = Date.parse( iso || '' ); return t > 0 ? ' ADD_DATE="' + Math.floor( t / 1000 ) + '"' : ''; }

function toNetscape()
{
    const lines = [
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
        '<!-- This is an automatically generated file.',
        '     It will be read and overwritten.',
        '     DO NOT EDIT! -->',
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        '<TITLE>Bookmarks</TITLE>',
        '<H1>Bookmarks</H1>',
        '<DL><p>'
    ];
    ( function walk( fid, pad )
    {
        for( const n of childrenOf( fid ) )
        {
            if( isFolder( n ) )
            {
                lines.push( pad + '<DT><H3' + addDate( n.createdAt ) + '>' + htmlEsc( n.title ) + '</H3>' );
                lines.push( pad + '<DL><p>' );
                walk( n.id, pad + '    ' );
                lines.push( pad + '</DL><p>' );
            }
            else
            {
                lines.push( pad + '<DT><A HREF="' + htmlEsc( n.url ) + '"' + addDate( n.createdAt ) +
                            ( n.tags.length ? ' TAGS="' + htmlEsc( n.tags.join( ',' ) ) + '"' : '' ) + '>' +
                            htmlEsc( n.title ) + '</A>' );
                if( n.notes ) lines.push( pad + '<DD>' + htmlEsc( n.notes ).replace( /\n/g, '<BR>' ) );
            }
        }
    } )( ROOT, '    ' );
    lines.push( '</DL><p>' );
    return lines.join( '\n' ) + '\n';
}

function download( text, name, type )
{
    const blob = new Blob( [ text ], { type: type } );
    const a = document.createElement( 'a' );
    a.href = URL.createObjectURL( blob );
    a.download = name;
    document.body.appendChild( a );
    a.click();
    setTimeout( function() { URL.revokeObjectURL( a.href ); a.remove(); }, 1000 );
}

// The export sheet's "Where": this device (a download) or a Nayive folder.
function exportWhere()
{
    const r = document.querySelector( 'input[name="exportWhere"]:checked' );
    return r ? r.value : 'device';
}

async function deliver( text, name, type )
{
    if( exportWhere() === 'nayive' ) { if( ! await saveInNayive( text, name ) ) return; }
    else download( text, name, type );
    NayiveUI.close( 'exportBackdrop' );
}

// Into a folder the user picks; a name already there gets " (2)", " (3)"…
async function saveInNayive( text, name )
{
    const dir = await NayiveUI.pickFolder( { title: T( 'bookmarks.export' ), allowRoot: true } );
    if( ! dir ) return false;
    let taken = [];
    try { taken = ( ( await GumApi.listDir( dir ) ).nodes || [] ).map( function( n ) { return String( n.path ).split( '/' ).pop(); } ); }
    catch( e ) {}
    const dot = name.lastIndexOf( '.' );
    let free = name;
    for( let i = 2; taken.indexOf( free ) >= 0; i++ ) free = name.slice( 0, dot ) + ' (' + i + ')' + name.slice( dot );
    try { await GumApi.writeFileBytes( dir + '/' + free, new TextEncoder().encode( text ) ); }
    catch( e ) { NayiveUI.toast( T( 'ui.saveFailed' ) ); return false; }
    const rel = dir.replace( /^files\/?/, '' );
    NayiveUI.toast( TF( 'bookmarks.savedIn', { path: ( rel ? rel + '/' : '' ) + free } ) );
    return true;
}

function exportHtml() { return deliver( toNetscape(), 'bookmarks-' + NayiveUI.todayIso() + '.html', 'text/html;charset=utf-8' ); }
function exportJson() { return deliver( serialize(), 'bookmarks-' + NayiveUI.todayIso() + '.json', 'application/json' ); }

//------------------------------------------------------------------------//
// DUPLICATES  -  one card per group; the radio picks the copy that stays
// (the favourite, else the oldest, until changed). One button merges every
// group, with Undo.

let dupGroups = [];

// `auto`: opened by an import, a moment later - by then the user may have
// dealt with them already, and must not get a "No duplicates" over the Undo.
// `newFolder`: the folder that import made (its copies are not the ones kept).
function openDupSheet( auto, newFolder )
{
    if( auto && document.querySelector( '.sheet-backdrop.open' ) ) return;
    dupGroups = findDuplicates( newFolder );
    if( ! dupGroups.length ) { if( auto !== true ) NayiveUI.toast( T( 'bookmarks.noDupes' ) ); return; }

    document.getElementById( 'dupCount' ).textContent = '(' + dupGroups.length + ')';
    document.getElementById( 'dupList' ).innerHTML = dupGroups.map( function( g, gi )
    {
        return '<div class="dup-group">' + g.items.map( function( b )
        {
            return '<label class="dup-row">' +
                   '<input type="radio" name="dup' + gi + '" value="' + esc( b.id ) + '"' + ( b.id === g.keep ? ' checked' : '' ) + '>' +
                   '<span class="dup-meta"><span class="dup-title">' + ( b.favorite ? SVG.star : '' ) + esc( b.title || b.url ) + '</span>' +
                   '<span class="dup-sub">' + esc( b.url ) + '</span>' +
                   '<span class="dup-sub">' + esc( pathText( b.parentId ) || T( 'bookmarks.all' ) ) + ' · ' + esc( ( b.createdAt || '' ).slice( 0, 10 ) ) + '</span></span>' +
                   '</label>';
        } ).join( '' ) + '</div>';
    } ).join( '' );

    NayiveUI.open( 'dupBackdrop' );
}

// The copies go, then the folders that leaves empty (an import's folder
// whose links were all copies). Undo puts back exactly that.
function removeDuplicates()
{
    if( ! canEdit() ) return;
    const rec = { places: [], nodes: {}, kept: [] };
    let gone = 0;
    dupGroups.forEach( function( g, gi )
    {
        const r = document.querySelector( 'input[name="dup' + gi + '"]:checked' );
        gone += mergeGroup( g.items, r ? r.value : g.keep, rec );
    } );
    const emptied = dropEmptied( rec );
    save();
    NayiveUI.close( 'dupBackdrop' );
    pruneState();
    render();
    const msg = ( gone === 1 ? T( 'bookmarks.dupesRemovedOne' ) : TF( 'bookmarks.dupesRemoved', { n: gone } ) ) +
                ( emptied ? ' · ' + ( emptied === 1 ? T( 'bookmarks.emptyFolderGone' ) : TF( 'bookmarks.emptyFoldersGone', { n: emptied } ) ) : '' );
    NayiveUI.undoToast( msg, function() { unmerge( rec ); save(); pruneState(); render(); } );
}
