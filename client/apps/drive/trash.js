// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * trash.js - Drive: the trash view ("Papelera").
 */
"use strict";

//------------------------------------------------------------------------//
// TRASH VIEW ("Papelera")

async function openTrash()
{
    setStatus( T( 'drive.loadingTrash' ) );
    try
    {
        trashItems = shownTrash( await withBusy( AyniNet.trashList() ) );
        trashMode  = true;
        clearSel();
        clearSearch();
        render();
        setStatus( '' );
    }
    catch( _ ) { setStatus( T( 'drive.trashOpenFailed' ) ); }
}

function closeTrash()
{
    trashMode  = false;
    trashItems = [];
    if( binList ) binList.clear();
    document.getElementById( 'trashListing' ).innerHTML = '';
    render();
    reload();                        // refresh the tree + disk gauge
}

async function refreshTrash()
{
    try { trashItems = shownTrash( await withBusy( AyniNet.trashList() ) ); }
    catch( _ ) { trashItems = []; }
    render();
}

// Picking in the bin: the same shared list as the folder (click, Ctrl,
// Shift, ticks, long tap, Ctrl+A), on its own box and its own bar, so the
// picks are bin ids. Restore and Delete forever then work on the picks.
let binList = null;

function wireTrashList()
{
    binList = Ayni.list( document.getElementById( 'trashListing' ), {
        main:    true,
        row:     '.row[data-bin]',
        idOf:    function( el ) { return el.dataset.bin; },
        bar:     document.getElementById( 'trashSel' ),
        active:  function() { return trashMode; },
        actions: [
            { id: 'restore', label: T( 'drive.restore' ), icon: SVG_RESTORE, group: 1,
              run: function( ids ) { restoreTrash( ids ); } },
            { id: 'purge', label: T( 'drive.deleteForever' ), icon: SVG_TRASH, key: 'Del', danger: true, group: 2,
              run: function( ids ) { purgeTrash( ids ); } }
        ]
    } );
}

// Bin ids deleted for good once their Undo is gone (purgeTrash). Until
// then every read of the bin leaves them out, so a refresh cannot bring
// one back.
const trashPurging = new Set();

function shownTrash( items )
{
    return items.filter( function( it ) { return ! trashPurging.has( it.id ); } );
}

// The disk space bin items hold (the bin bar, the disk bar's "empty it" question).
function binHeld( items ) { return items.reduce( function( sum, it ) { return sum + ( it.size || 0 ); }, 0 ); }

function renderTrashBar()
{
    const bar = document.getElementById( 'trashTools' );
    bar.innerHTML = '';

    // The bin shows the disk space it is holding, not how many rows: what
    // matters is the room emptying it would give back.
    if( trashItems.length )
    {
        const held = document.createElement( 'span' );
        held.className   = 'trash-held';
        held.textContent = fmtSize( binHeld( trashItems ) );
        bar.appendChild( held );
    }

    const empty = document.createElement( 'button' );
    empty.className   = 'btn danger';
    Ayni.setTip( empty, T( 'drive.emptyTrash' ) );
    empty.setAttribute( 'aria-label', T( 'drive.emptyTrash' ) );
    empty.innerHTML   = SVG_TRASH;
    empty.ariaDisabled    = ! trashItems.length;
    empty.addEventListener( 'click', emptyTrash );
    bar.appendChild( empty );
}

function renderTrashListing()
{
    if( ! trashItems.length )
    {
        document.getElementById( 'trashListing' ).innerHTML =
            '<div class="empty-hint" data-i18n="drive.trashEmptyMsg"></div>';
        return;
    }

    const box  = document.getElementById( 'trashListing' );
    box.innerHTML = '';
    const host = document.createElement( 'div' );
    host.className = 'list-rows';
    box.appendChild( host );

    trashItems.forEach( function( item )
    {
        const row = document.createElement( 'div' );
        row.className   = 'row';
        row.dataset.bin = item.id;

        const ic = document.createElement( 'span' );
        ic.className = 'row-ic';
        ic.innerHTML = item.dir ? SVG_FOLDER : SVG_FILE;

        const label = document.createElement( 'span' );
        label.className   = 'row-name';
        label.textContent = item.name;

        const meta = document.createElement( 'span' );
        meta.className = 'row-meta';
        const where = fsRel( Ayni.dirOf( item.orig ) ) || homeName();
        const bits = [ where, fmtDate( item.deleted ) ];
        if( ! item.dir ) bits.push( fmtSize( item.size ) );
        meta.textContent = bits.join( ' · ' );
        meta.title       = TF( 'drive.wasIn', { where: fsRel( item.orig ) || item.orig } );

        const actions = document.createElement( 'span' );
        actions.className = 'row-trash-actions';

        const restoreBtn = document.createElement( 'button' );
        restoreBtn.className = 'btn sm';
        Ayni.setTip( restoreBtn, T( 'drive.restore' ) );
        restoreBtn.setAttribute( 'aria-label', T( 'drive.restore' ) );
        restoreBtn.innerHTML = SVG_RESTORE;
        restoreBtn.addEventListener( 'click', function() { restoreTrash( [ item.id ] ); } );

        const delBtn = document.createElement( 'button' );
        delBtn.className   = 'btn sm danger';
        Ayni.setTip( delBtn, T( 'drive.deleteForever' ) );
        delBtn.setAttribute( 'aria-label', T( 'drive.deleteForever' ) );
        delBtn.innerHTML   = SVG_TRASH;
        delBtn.addEventListener( 'click', function() { purgeTrash( [ item.id ] ); } );

        actions.appendChild( restoreBtn );
        actions.appendChild( delBtn );

        row.appendChild( ic );
        row.appendChild( label );
        row.appendChild( meta );
        row.appendChild( actions );
        host.appendChild( row );
    });
}

async function restoreTrash( ids )
{
    setStatus( T( 'drive.restoring' ) );
    try
    {
        const res = await withBusy( AyniNet.trashRestore( ids ) );
        await refreshTrash();
        restoredStatus( res );                          // actions.js
    }
    catch( _ ) { setStatus( '' ); Ayni.toast( 'err', T( 'drive.restoreFailed' ) ); }
}

async function purgeTrash( ids )
{
    if( ids.length === 1 ) { purgeOneLater( ids ); return; }

    // Several at once: the question stays, and they go at once, no Undo.
    if( ! await Ayni.confirm( {
        title: T( 'drive.deleteForever' ),
        body: TF( 'drive.emptyTrashBody', { n: ids.length } ),
        confirm: T( 'drive.delete' ), danger: true } ) ) return;
    setStatus( T( 'drive.deleting' ) );
    try
    {
        await purgeBinIds( ids );
        await refreshTrash();
        flashStatus( T( 'drive.deletedForever' ) );
    }
    catch( _ ) { setStatus( '' ); Ayni.toast( 'err', T( 'drive.deleteFailedMsg' ) ); }
}

// One item: no question. Its row goes now and it is deleted for good when
// the Undo is gone (a real delete has no way back, so it waits). A closing
// page still sends it: the fetch is the first thing its `final` does.
function purgeOneLater( ids )
{
    ids.forEach( function( id ) { trashPurging.add( id ); } );
    trashItems = shownTrash( trashItems );
    render();

    function forget() { ids.forEach( function( id ) { trashPurging.delete( id ); } ); }

    Ayni.toast( 'ok', T( 'ui.toast.deleted' ), { undo: function()
    {
        forget();
        if( trashMode ) refreshTrash();
    }, final: function()
    {
        // Gone: the ids stay in the set, so a bin read that was already on
        // its way cannot draw the row again.
        withBusy( AyniNet.trashDelete( ids ) ).catch( function()
        {
            forget();
            Ayni.toast( 'err', T( 'drive.deleteFailedMsg' ) );
            if( trashMode ) refreshTrash();      // it is still in the bin: show it again
        } );
    } } );
}

// "EMPTY THE BIN" DELETES WHAT THE USER SAW, NOTHING ELSE (G4, drive-files
// #6): exactly these bin ids - the rows on screen, or the bin as read just
// before the question. Never the server's "empty everything": an item
// deleted on another device after this one looked (its Undo toast maybe
// still up there) stays in the bin. The ids travel in the URL, so at most
// 2000 a call. Used by the bin view and the disk bar (toolbar.js).
const PURGE_BATCH = 2000;

async function purgeBinIds( ids )
{
    for( let i = 0; i < ids.length; i += PURGE_BATCH )
        await withBusy( AyniNet.trashDelete( ids.slice( i, i + PURGE_BATCH ) ) );
}

async function emptyTrash()
{
    if( ! trashItems.length ) return;
    const ids = trashItems.map( function( it ) { return it.id; } );   // what the question counts
    if( ! await Ayni.confirm( {
        title: T( 'drive.emptyTrashTitle' ),
        body: TF( 'drive.emptyTrashBody', { n: ids.length } ),
        confirm: T( 'drive.emptyTrash' ), danger: true } ) ) return;
    Ayni.settleUndo();            // a one-item delete waiting on its Undo goes now: all of it is going
    setStatus( T( 'drive.emptyingTrash' ) );
    try
    {
        await purgeBinIds( ids );
        await refreshTrash();
        flashStatus( T( 'drive.trashEmptied' ) );
    }
    catch( _ ) { setStatus( '' ); Ayni.toast( 'err', T( 'drive.emptyTrashFailed' ) ); }
}
