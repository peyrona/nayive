// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * thumbs.js - Drive: a picture's own preview in the icons view.
 *
 * The thumbnails are Photos' (photos/index.html, "THUMBNAILS"): one small
 * JPEG per picture, data/photos/thumbs/<size>_<mtime>.jpg (NayivePhoto.
 * thumbPath), made by the browser - never by the server. Drive shows the
 * one there is and makes the one there is not, the same way Photos does:
 *
 *   1. <img src=thumb>. There -> done (no request but the picture's own).
 *   2. 404 -> the same <img> loads the picture itself...
 *   3. ...and, loaded, it is shrunk on a canvas and PUT as the thumbnail
 *      (create-only: never over one that is there), then the <img> takes
 *      the thumbnail so the big picture is let go.
 *
 * Both apps use the same files, so one made here serves Photos and back.
 * Photos' daily sweep keeps every thumbnail a picture in Home still has.
 * Nothing is made for what others share with us (it would outlive the
 * share in OUR data/), nor for a picture too big to fetch for an icon:
 * those show a thumbnail only if one is there, else the plain icon.
 */
"use strict";

const THUMB_EXT  = [ 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif' ];   // Photos' IMG_EXT
const THUMB_W    = 500;                    // Photos' size, so either app's thumbnail fits both
const THUMB_Q    = 0.82;
const THUMB_MAX  = 25 * 1024 * 1024;       // bigger: not fetched just to draw an icon

const thumbState = new Map();              // thumb path -> 'missing' | 'pending' | 'ok' | 'failed'
const thumbQueue = [];                     // [ { img, path } ] waiting for a worker
let   thumbWorkers = 0;

function thumbable( node )
{
    return !! node && ! isDir( node ) && ! isLink( node ) && !! node.size && !! node.mtime &&
           THUMB_EXT.indexOf( typeExt( node ) ) !== -1;
}

function canMakeThumb( node ) { return ! NayiveUI.isShared( node.path ) && node.size <= THUMB_MAX; }

function thumbUrl( path ) { return GumApi.fileUrl( path ) + '&immutable=1'; }   // the name IS the content

// Puts the preview into an icon-view tile (renderListing). The file-type
// glyph stays underneath, shown again if no preview can be had.
function addThumb( row, node )
{
    if( ! thumbable( node ) ) return;

    const path = NayivePhoto.thumbPath( node.size, node.mtime );
    const st   = thumbState.get( path );
    const make = canMakeThumb( node );
    if( st === 'failed' || ( ! make && ( st === 'missing' || st === 'pending' ) ) ) return;

    const ic  = row.querySelector( '.row-ic' );
    const img = document.createElement( 'img' );
    img.className = 'row-thumb';
    img.alt       = '';
    img.loading   = 'lazy';
    img.decoding  = 'async';
    img.draggable = false;

    // Known to be missing: straight to the picture (it makes the thumbnail).
    const full = st === 'missing' || st === 'pending';
    img.dataset.stage = full ? 'full' : 'thumb';
    img.src = full ? GumApi.fileUrl( node.path ) + '&v=' + node.mtime : thumbUrl( path );

    const giveUp = function()
    {
        img.remove();
        ic.classList.remove( 'has-thumb' );
    };

    img.addEventListener( 'error', function()
    {
        if( img.dataset.stage === 'thumb' )
        {
            if( ! thumbState.has( path ) || thumbState.get( path ) === 'ok' ) thumbState.set( path, 'missing' );
            if( ! make ) { giveUp(); return; }
            img.dataset.stage = 'full';
            img.src = GumApi.fileUrl( node.path ) + '&v=' + node.mtime;
            return;
        }
        // The thumbnail just made does not load: keep showing the picture.
        if( img.dataset.stage === 'made' ) { img.dataset.stage = 'done'; img.src = GumApi.fileUrl( node.path ) + '&v=' + node.mtime; return; }
        if( img.dataset.stage === 'full' ) thumbState.set( path, 'failed' );   // the picture itself will not show
        giveUp();
    } );

    img.addEventListener( 'load', function()
    {
        if( img.dataset.stage === 'thumb' ) { thumbState.set( path, 'ok' ); return; }
        if( img.dataset.stage === 'full' && thumbState.get( path ) !== 'pending' && thumbState.get( path ) !== 'ok' )
        {
            thumbState.set( path, 'pending' );
            thumbQueue.push( { img: img, path: path } );
            runThumbQueue();
        }
    } );

    ic.classList.add( 'has-thumb' );
    ic.insertBefore( img, ic.firstChild );
}

// Two at a time, as Photos: a folder of new pictures is not a burst of PUTs.
function runThumbQueue()
{
    while( thumbWorkers < 2 && thumbQueue.length )
    {
        const job = thumbQueue.shift();
        thumbWorkers++;
        makeThumb( job.img, job.path ).then( function() { thumbWorkers--; runThumbQueue(); } );
    }
}

async function makeThumb( img, path )
{
    try
    {
        const blob = await NayivePhoto.shrinkToJpeg( img, { maxW: THUMB_W, quality: THUMB_Q } );
        try { await GumApi.writeFileBytes( path, blob, { createOnly: true } ); }
        catch( err )
        {
            // Another page (Photos, a second Drive) made it meanwhile: as good.
            if( ! err || ( err.status !== 412 && err.status !== 409 ) ) throw err;
        }
        thumbState.set( path, 'ok' );
        if( img.isConnected ) { img.dataset.stage = 'made'; img.src = thumbUrl( path ); }    // let the big picture go
    }
    catch( _ )
    {
        // Quota full, offline...: not again until the next visit. The tile
        // keeps the picture it already has.
        thumbState.set( path, 'failed' );
    }
}
