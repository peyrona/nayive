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
        trashItems = shownTrash( await withBusy( GumApi.trashList() ) );
        try { trashDays = ( await GumApi.trashDays() ).days; }
        catch( _e ) { trashDays = null; }
        trashMode  = true;
        selectedPaths.clear();
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
    render();
    reload();                        // refresh the tree + disk gauge
}

async function refreshTrash()
{
    try { trashItems = shownTrash( await withBusy( GumApi.trashList() ) ); }
    catch( _ ) { trashItems = []; }
    render();
}

// Bin ids deleted for good once their Undo is gone (purgeTrash). Until
// then every read of the bin leaves them out, so a refresh cannot bring
// one back.
const trashPurging = new Set();

function shownTrash( items )
{
    return items.filter( function( it ) { return ! trashPurging.has( it.id ); } );
}

function renderTrashBar()
{
    const host = document.getElementById( 'breadcrumb' );
    host.innerHTML = '';

    const bar = document.createElement( 'div' );
    bar.className = 'trash-bar';

    // No "<-" here: the lit bin in the header is the way back (see render).

    // The bin shows the disk space it is holding, not how many rows: what
    // matters is the room emptying it would give back.
    const held = trashItems.reduce( function( sum, it ) { return sum + ( it.size || 0 ); }, 0 );

    const title = document.createElement( 'span' );
    title.className   = 'trash-title';
    title.textContent = T( 'acct.trash' ) + ( trashItems.length ? ' (' + fmtSize( held ) + ')' : '' );
    bar.appendChild( title );

    if( trashDays != null )
    {
        const dwrap = document.createElement( 'label' );
        dwrap.className   = 'trash-days';
        dwrap.textContent = T( 'drive.deleteAfter' ) + ' ';

        const dinput = document.createElement( 'input' );
        dinput.type  = 'number';
        dinput.min   = '1';
        dinput.max   = '90';
        dinput.value = trashDays;
        dinput.addEventListener( 'change', async function()
        {
            let v = parseInt( dinput.value, 10 );
            if( ! Number.isFinite( v ) ) { dinput.value = trashDays; return; }
            v = Math.max( 1, Math.min( 90, v ) );
            try
            {
                const res = await GumApi.setTrashDays( v );
                trashDays = res.days;
                dinput.value = trashDays;
                flashStatus( TF( 'drive.deleteAfterMsg', { n: trashDays } ) );
            }
            catch( _ ) { dinput.value = trashDays; setStatus( T( 'drive.saveFailedShort' ) ); }
        } );
        dwrap.appendChild( dinput );
        dwrap.appendChild( document.createTextNode( ' ' + T( 'acct.days' ) ) );

        const dinfo = document.createElement( 'button' );
        dinfo.className = 'info-dot';
        dinfo.setAttribute( 'data-info', T( 'drive.trashDaysInfo' ) );
        dwrap.appendChild( dinfo );
        if( window.NayiveUI ) NayiveUI.applyInfoDots( dwrap );

        bar.appendChild( dwrap );
    }

    const empty = document.createElement( 'button' );
    empty.className   = 'icon-btn danger';
    empty.title       = T( 'drive.emptyTrash' );
    empty.setAttribute( 'aria-label', T( 'drive.emptyTrash' ) );
    empty.innerHTML   = SVG_TRASH;
    empty.disabled    = ! trashItems.length;
    empty.addEventListener( 'click', emptyTrash );
    bar.appendChild( empty );

    host.appendChild( bar );
}

function renderTrashListing()
{
    if( ! trashItems.length )
    {
        document.getElementById( 'listing' ).innerHTML =
            '<div class="empty-hint" data-i18n="drive.trashEmptyMsg"></div>';
        return;
    }

    const host = listRowsHost();

    trashItems.forEach( function( item )
    {
        const row = document.createElement( 'div' );
        row.className = 'row';

        const ic = document.createElement( 'span' );
        ic.className = 'row-ic';
        ic.innerHTML = item.dir ? SVG_FOLDER : SVG_FILE;

        const label = document.createElement( 'span' );
        label.className   = 'row-name';
        label.textContent = item.name;

        const meta = document.createElement( 'span' );
        meta.className = 'row-meta';
        const where = fsRel( item.orig.indexOf( '/' ) !== -1
                             ? item.orig.slice( 0, item.orig.lastIndexOf( '/' ) ) : '' ) || 'Drive';
        const bits = [ where, fmtDate( item.deleted ) ];
        if( ! item.dir ) bits.push( fmtSize( item.size ) );
        meta.textContent = bits.join( ' · ' );
        meta.title       = TF( 'drive.wasIn', { where: fsRel( item.orig ) || item.orig } );

        const actions = document.createElement( 'span' );
        actions.className = 'row-trash-actions';

        const restoreBtn = document.createElement( 'button' );
        restoreBtn.className = 'icon-btn sm';
        restoreBtn.title     = T( 'drive.restore' );
        restoreBtn.setAttribute( 'aria-label', T( 'drive.restore' ) );
        restoreBtn.innerHTML = SVG_RESTORE;
        restoreBtn.addEventListener( 'click', function() { restoreTrash( [ item.id ] ); } );

        const delBtn = document.createElement( 'button' );
        delBtn.className   = 'icon-btn sm danger';
        delBtn.title       = T( 'drive.deleteForever' );
        delBtn.setAttribute( 'aria-label', T( 'drive.deleteForever' ) );
        delBtn.innerHTML   = SVG_TRASH;
        delBtn.addEventListener( 'click', function() { purgeTrash( [ item.id ], item.name ); } );

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
        const res = await withBusy( GumApi.trashRestore( ids ) );
        await refreshTrash();
        if( res && res.renamed && res.renamed.length )
            flashStatus( TF( 'drive.restoredAs', { name: res.renamed[0] } ) );
        else
            flashStatus( T( 'drive.restored' ) );
    }
    catch( _ ) { setStatus( '' ); NayiveUI.toast( T( 'drive.restoreFailed' ) ); }
}

async function purgeTrash( ids, name )
{
    if( ids.length === 1 ) { purgeOneLater( ids ); return; }

    // Several at once: the question stays, and they go at once, no Undo.
    if( ! await NayiveUI.confirm( {
        title: T( 'drive.deleteForever' ),
        body: TF( 'drive.deleteForeverBody', { name: name } ),
        confirm: T( 'drive.delete' ), danger: true } ) ) return;
    setStatus( T( 'drive.deleting' ) );
    try
    {
        await withBusy( GumApi.trashDelete( ids ) );
        await refreshTrash();
        flashStatus( T( 'drive.deletedForever' ) );
    }
    catch( _ ) { setStatus( '' ); NayiveUI.toast( T( 'drive.deleteFailedMsg' ) ); }
}

// One item: no question. Its row goes now and it is deleted for good when
// the Undo is gone (a real delete has no way back, so it waits). A closing
// page still sends it: the fetch is the first thing onExpire does.
function purgeOneLater( ids )
{
    ids.forEach( function( id ) { trashPurging.add( id ); } );
    trashItems = shownTrash( trashItems );
    render();

    function forget() { ids.forEach( function( id ) { trashPurging.delete( id ); } ); }

    NayiveUI.undoToast( T( 'ui.toast.deleted' ), function()
    {
        forget();
        if( trashMode ) refreshTrash();
    },
    { onExpire: function()
    {
        // Gone: the ids stay in the set, so a bin read that was already on
        // its way cannot draw the row again.
        withBusy( GumApi.trashDelete( ids ) ).catch( function()
        {
            forget();
            NayiveUI.toast( T( 'drive.deleteFailedMsg' ) );
            if( trashMode ) refreshTrash();      // it is still in the bin: show it again
        } );
    } } );
}

async function emptyTrash()
{
    if( ! trashItems.length ) return;
    if( ! await NayiveUI.confirm( {
        title: T( 'drive.emptyTrashTitle' ),
        body: TF( 'drive.emptyTrashBody', { n: trashItems.length } ),
        confirm: T( 'drive.emptyTrash' ), danger: true } ) ) return;
    NayiveUI.undoSettle();            // a one-item delete waiting on its Undo goes now: all of it is going
    setStatus( T( 'drive.emptyingTrash' ) );
    try
    {
        await withBusy( GumApi.trashEmpty() );
        await refreshTrash();
        flashStatus( T( 'drive.trashEmptied' ) );
    }
    catch( _ ) { setStatus( '' ); NayiveUI.toast( T( 'drive.emptyTrashFailed' ) ); }
}
