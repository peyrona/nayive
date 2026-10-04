/*
 * toolbar.js - Drive: toolbar state, status line, disk gauge, sync dot and reload().
 */
"use strict";

// What a picked item can do lives in ONE place: the action list in
// menus.js (the selection group, the menu and the keys read it). Here: the
// header's own tools, and a nudge to the browser to re-read those rules
// when Drive's state changed (a download started, a grant arrived).
function updateToolbarState()
{
    // Both write into the open folder. Anything under shared/ belongs to
    // somebody else and the server refuses every write on it. Upload is the
    // ONE thing an "add" share opens up: a folder somebody shared with us,
    // having ticked "pueden añadir archivos" (canAddHere).
    const roHere = readOnlyHere();
    document.getElementById( 'newFolderBtn' ).disabled = roHere;
    document.getElementById( 'uploadBtn'    ).disabled = roHere && ! canAddHere;

    if( browse ) browse.redraw();

    // The "· Alt+N" hints go back on last.
    applyKeyHints();
}

function setStatus( text ) { document.getElementById( 'statusLabel' ).textContent = text || ''; }

// The thin bar under the "Drive" title showing how full the server disk is.
// frac is 0..1; null hides the bar (unknown / request failed).
// Colour: green ≤70 %, gold ≤90 %, red above.
function setDiskGauge( frac )
{
    const bar = document.getElementById( 'diskBar' );

    if( frac == null ) { bar.hidden = true; return; }

    frac = Math.max( 0, Math.min( 1, frac ) );
    const pct = frac * 100;
    const col = pct <= 70 ? 'var(--ok)' : pct <= 90 ? 'var(--warn)' : 'var(--danger)';

    bar.hidden = false;
    bar.style.setProperty( '--disk-fill', col );
    bar.firstElementChild.style.width = pct.toFixed( 1 ) + '%';
}

async function refreshDiskGauge()
{
    try
    {
        const s    = JSON.parse( await GumApi.fetchText( GumApi.API_FILES + '?stat=disk' ) );
        const used = s.total - s.usable;
        const held = s.trash || 0;
        setDiskGauge( used / s.total );
        document.getElementById( 'diskBar' ).title =
            TF( 'drive.diskPct', { pct: Math.round( 100 * used / s.total ),
                                   used: fmtSize( used ), total: fmtSize( s.total ) } ) +
            ( held ? '\n' + TF( 'drive.trashHolds', { held: fmtSize( held ) } ) : '' );

        // Nearly full and the papelera is holding something: one tap on
        // the bar is the quickest way to get the space back.
        offerEmptyTrash( used / s.total >= 0.9 && held > 0, held );
    }
    catch( _ )
    {
        setDiskGauge( null );
        offerEmptyTrash( false, 0 );
    }
}

// Makes the disk bar clickable while the disk is nearly full and the
// papelera has something in it. Emptying it is the only space a user
// can reclaim without deleting anything they still have.
function offerEmptyTrash( on, held )
{
    const bar = document.getElementById( 'diskBar' );
    bar.classList.toggle( 'disk-bar--offer', !! on );
    bar.onclick = ! on ? null : async function ()
    {
        // The bin as it is when asked: only those go (purgeBinIds, G4), and
        // the question counts them - not the gauge's older figure.
        let items;
        try { items = await withBusy( GumApi.trashList() ); }
        catch( _ ) { NayiveUI.toast( T( 'drive.emptyTrashFailed' ) ); return; }
        if( ! items.length ) { reload(); return; }
        const ids  = items.map( function( it ) { return it.id; } );
        const size = items.reduce( function( sum, it ) { return sum + ( it.size || 0 ); }, 0 );
        if( ! await NayiveUI.confirm( {
                title:   T( 'drive.emptyTrashTitle' ),
                body:    TF( 'drive.diskFullBody', { held: fmtSize( size ) } ) + '\n\n' + TF( 'drive.emptyTrashBody', { n: ids.length } ),
                confirm: T( 'drive.emptyTrash' ), danger: true } ) ) return;
        try { await purgeBinIds( ids ); }
        catch( _ ) { NayiveUI.toast( T( 'drive.emptyTrashFailed' ) ); return; }
        NayiveUI.toast( T( 'drive.trashEmptied' ) );
        reload();
    };
}

function setSyncStatus( ok )
{
    const el = document.getElementById( 'syncIndicator' );
    el.classList.toggle( 'synced', ok !== false );
    // The plug IS the "re-read this folder" button now (it replaced #refreshBtn).
    el.title = T( ok === false ? 'drive.connError' : 'ui.sync.synced' ) + T( 'ui.sync.tapHint' );
}

// Any request in flight (list, upload, rename, delete, download) turns the dot
// blue; the .busy class wins over .synced in the stylesheet while it lasts.
let netInFlight = 0;

function netBusy( delta )
{
    netInFlight = Math.max( 0, netInFlight + delta );

    const el = document.getElementById( 'syncIndicator' );
    if( el ) el.classList.toggle( 'busy', netInFlight > 0 );
}

// Run a GumApi call with the dot blue for as long as it is in flight.
function withBusy( promise )
{
    netBusy( 1 );
    return promise.finally( function() { netBusy( -1 ); } );
}

async function reload()
{
    setStatus( T( 'ui.loading' ) );

    try
    {
        dirTreeRoot = scopeTree( await withBusy( GumApi.dirTree() ) );
        computeFsRoot();
        expandedFolders.add( FS_ROOT );

        if( ! findNode( currentFolder ) )
            currentFolder = FS_ROOT;

        clearSel();
        await loadListing( currentFolder );      // refetch the open folder + render
        if( isSearching() ) runSearch();         // keep an active search live
        setSyncStatus( true );
        setStatus( '' );
        refreshDiskGauge();          // keep the server-HD bar current on manual refresh
    }
    catch( _ )
    {
        setSyncStatus( false );
        setStatus( T( 'drive.reloadError' ) );
    }
}

//------------------------------------------------------------------------//
// NEWS FROM OTHER APPS
//
// Another tab or desktop window changed files (shared/gum-api.js sends the
// news): a "Save as" in Write, a new folder in a second Drive... Refresh
// quietly - no "Loading", the selection kept - but only when it touches the
// open folder, or the folder tree. A hidden Drive waits until it is seen.

let newsTimer   = null;
let newsTree    = false;     // the folder tree needs a refetch too
let newsWaiting = false;     // news came while the page was hidden

function onFilesNews( msg )
{
    if( ! dirTreeRoot ) return;      // still starting: the first load shows it anyway

    const parent = function( p ) { const i = p.lastIndexOf( '/' ); return i < 0 ? '' : p.slice( 0, i ); };
    const seen   = ( msg.paths || [] ).filter( function( p )
    {
        if( typeof p !== 'string' ) return false;
        if( FS_ROOT && p !== FS_ROOT && p.indexOf( FS_ROOT + '/' ) !== 0 ) return false;
        return ! p.split( '/' ).some( function( s ) { return s.charAt( 0 ) === '.'; } );
    } );

    if( ! seen.length ) return;
    if( ! msg.folders && ! seen.some( function( p ) { return parent( p ) === currentFolder; } ) ) return;

    if( msg.folders ) newsTree = true;
    if( document.hidden ) { newsWaiting = true; return; }

    clearTimeout( newsTimer );
    newsTimer = setTimeout( applyNews, 400 );     // a burst of saves = one refresh
}

async function applyNews()
{
    newsTimer = null;
    if( trashMode ) return;      // the bin is on screen; closeTrash() reloads on the way out

    const tree = newsTree;
    newsTree   = false;

    try
    {
        if( tree )
        {
            dirTreeRoot = scopeTree( await GumApi.dirTree() );
            computeFsRoot();
            if( ! findNode( currentFolder ) ) { reload(); return; }   // the open folder went away
        }

        const path = currentFolder;
        const seq  = ++listingSeq;
        const r    = await GumApi.listDir( path );
        if( seq !== listingSeq || path !== currentFolder || trashMode ) return;

        curListing = { path: path, nodes: pruneNodes( r.nodes || [] ) };
        render();                  // picks that are gone drop out on their own (the browser)
        if( isSearching() ) runSearch();
    }
    catch( _ ) {}     // offline or a hiccup: the next news or a manual reload catches up
}

function catchUpNews()
{
    if( ! newsWaiting || document.hidden ) return;
    newsWaiting = false;
    newsTree    = true;
    applyNews();
}
