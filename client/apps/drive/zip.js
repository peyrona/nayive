/*
 * zip.js - Drive: a .zip. A double-click shows what is inside (#zipBackdrop)
 * with an "Extract here" button; the context menu's "Extract here" does the
 * same without the list. The server unpacks it beside the zip, in a new
 * folder (server/go/api_zip.go) - the zip never comes down to the browser.
 * "Compress" (toolbar and menu) is the other way: the server packs what is
 * selected into one new .zip beside it.
 */
"use strict";

let zipPath  = null;   // the .zip the open dialog shows
let zipToken = 0;      // a list that arrives after the dialog moved on is dropped

function isZipNode( node )
{
    return !! node && ! isDir( node ) && typeExt( node ) === 'zip';
}

// GET /api/zip -> { entries, truncated, files, dirs, size, locked, unsupported, into }
async function fetchZipList( path )
{
    const q = new URLSearchParams( { file: path } );
    return JSON.parse( await withBusy( GumApi.fetchText( '/api/zip?' + q.toString() ) ) );
}

// What to say when the server said no (the codes: api_zip.go).
function zipFailText( err, name )
{
    const s = err && err.status;
    if( s === 423 ) return TF( 'drive.zipLocked',      { name: name } );
    if( s === 415 ) return TF( 'drive.zipUnsupported', { name: name } );
    if( s === 413 ) return TF( 'drive.zipTooMany',     { name: name } );
    if( s === 507 ) return TF( 'drive.zipQuota',       { name: name } );
    if( s === 403 ) return TF( 'drive.zipReadOnly',    { name: name } );
    if( s === 422 ) return TF( 'drive.zipBroken',      { name: name } );
    return TF( 'drive.zipFailed', { name: name } );
}

async function openZipDialog( node )
{
    const token = ++zipToken;
    const name  = displayName( node );
    const list  = document.getElementById( 'zipList' );
    const sum   = document.getElementById( 'zipSummary' );
    const note  = document.getElementById( 'zipNote' );
    const btn   = document.getElementById( 'zipExtractBtn' );

    zipPath = node.path;
    document.getElementById( 'zipTitle' ).textContent = name;
    sum.textContent  = T( 'ui.loading' );
    note.textContent = '';
    list.textContent = '';
    list.hidden      = true;
    btn.disabled     = true;
    setBackdrop( 'zipBackdrop', true );

    let r;
    try { r = await fetchZipList( node.path ); }
    catch( err )
    {
        if( token !== zipToken ) return;
        sum.textContent = zipFailText( err, name );
        return;
    }
    if( token !== zipToken ) return;

    sum.textContent = countLabel( r.files, r.dirs ) + '  ·  ' + fmtSize( r.size );

    for( const e of r.entries )
    {
        const li   = document.createElement( 'li' );
        const nm   = document.createElement( 'span' );
        const size = document.createElement( 'span' );
        const cut  = e.name.lastIndexOf( '/' ) + 1;

        nm.className = 'zip-name';
        if( cut )
        {
            const dir = document.createElement( 'span' );
            dir.className   = 'zip-dir';
            dir.textContent = e.name.slice( 0, cut );
            nm.appendChild( dir );
        }
        nm.appendChild( document.createTextNode( e.name.slice( cut ) ) );
        nm.title = e.name;

        size.className   = 'zip-size';
        size.textContent = fmtSize( e.size );

        li.append( nm, size );
        list.appendChild( li );
    }
    if( r.truncated )
    {
        const li = document.createElement( 'li' );
        li.textContent = TF( 'drive.zipMore', { n: r.files - r.entries.length } );
        list.appendChild( li );
    }
    list.hidden = ! list.children.length;

    // The first reason it cannot be extracted, or where it will go.
    let why = '';
    if(      r.locked )                  why = TF( 'drive.zipLocked',      { name: name } );
    else if( r.unsupported )             why = TF( 'drive.zipUnsupported', { name: name } );
    else if( ! r.files && ! r.dirs )     why = TF( 'drive.zipEmpty',       { name: name } );
    else if( ! r.into )                  why = TF( 'drive.zipReadOnly',    { name: name } );

    note.textContent = why || TF( 'drive.zipInto', { folder: r.into } );
    btn.disabled     = !! why;
}

function extractFromDialog()
{
    const path = zipPath;
    setBackdrop( 'zipBackdrop', false );
    zipPath = null;
    if( path ) extractZip( path );
}

// The menu's "Extract here": straight to the server, no list.
function extractSelectedZip()
{
    const t = actionTargets();
    if( t.length !== 1 ) return;
    extractZip( t[0] );
}

// POST /api/zip -> { path, files, skipped }. The new folder is selected when
// it lands in the folder on screen (a search hit can live somewhere else).
async function extractZip( path )
{
    const name = path.split( '/' ).pop();
    const q    = new URLSearchParams( { file: path } );

    showProgress( TF( 'drive.zipExtracting', { name: name } ) );
    let r;
    try
    {
        r = JSON.parse( await withBusy( GumApi.fetchText( '/api/zip?' + q.toString(), { method: 'POST' } ) ) );
    }
    catch( err )
    {
        hideProgress();
        NayiveUI.toast( zipFailText( err, name ), { ms: 6000 } );
        return;
    }
    hideProgress();

    const folder = r.path.split( '/' ).pop();
    NayiveUI.toast( r.skipped ? TF( 'drive.zipDoneSkipped', { folder: folder, n: r.skipped } )
                              : TF( 'drive.zipDone',        { folder: folder } ), { ms: 5000 } );

    await reload();
    selectIfListed( r.path );
}

// After a reload: select what the server just made, when it is in the
// folder on screen (a search hit can live somewhere else).
function selectIfListed( path )
{
    if( ! ( curListing.nodes || [] ).some( function( n ) { return n.path === path; } ) ) return;
    setSel( [ path ] );
    const row = document.querySelector( '#listing .row.is-selected' );
    if( row ) row.scrollIntoView( { block: 'nearest' } );
}

// What to say when the server would not compress (api_zip.go, COMPRESS).
function compressFailText( err )
{
    const s = err && err.status;
    if( s === 507 ) return T( 'drive.compressQuota' );
    if( s === 403 ) return T( 'drive.compressReadOnly' );
    if( s === 413 ) return T( 'drive.compressTooMany' );
    return T( 'drive.compressFailed' );
}

// Toolbar / menu "Compress": the selected items (or, nothing ticked, the
// open folder) into ONE new .zip, in the folder of the first of them,
// named after it (the server picks the name, " (2)" when it is taken).
async function compressSelection()
{
    const paths = actionTargets();
    if( ! paths.length ) return;

    const q = new URLSearchParams();
    paths.forEach( function( p ) { q.append( 'paths', p ); } );

    showProgress( T( 'drive.zipping' ) );
    let r;
    try
    {
        r = JSON.parse( await withBusy( GumApi.fetchText( '/api/zip?' + q.toString(), { method: 'POST' } ) ) );
    }
    catch( err )
    {
        hideProgress();
        NayiveUI.toast( compressFailText( err ), { ms: 6000 } );
        return;
    }
    hideProgress();

    NayiveUI.toast( TF( 'drive.compressDone', { name: r.path.split( '/' ).pop() } ), { ms: 5000 } );
    await reload();
    selectIfListed( r.path );
}

function wireZip()
{
    document.getElementById( 'zipExtractBtn' ).addEventListener( 'click', extractFromDialog );
    document.getElementById( 'zipCloseBtn'   ).addEventListener( 'click', function()
    {
        zipToken++;
        zipPath = null;
        setBackdrop( 'zipBackdrop', false );
    } );
}
