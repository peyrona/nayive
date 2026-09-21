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
        trashItems = await withBusy( GumApi.trashList() );
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
    try { trashItems = await withBusy( GumApi.trashList() ); }
    catch( _ ) { trashItems = []; }
    render();
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

async function emptyTrash()
{
    if( ! trashItems.length ) return;
    if( ! await NayiveUI.confirm( {
        title: T( 'drive.emptyTrashTitle' ),
        body: TF( 'drive.emptyTrashBody', { n: trashItems.length } ),
        confirm: T( 'drive.emptyTrash' ), danger: true } ) ) return;
    setStatus( T( 'drive.emptyingTrash' ) );
    try
    {
        await withBusy( GumApi.trashEmpty() );
        await refreshTrash();
        flashStatus( T( 'drive.trashEmptied' ) );
    }
    catch( _ ) { setStatus( '' ); NayiveUI.toast( T( 'drive.emptyTrashFailed' ) ); }
}
