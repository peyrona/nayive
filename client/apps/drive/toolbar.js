/*
 * toolbar.js - Drive: toolbar state, status line, disk gauge, sync dot and reload().
 */
"use strict";

// The paths a toolbar action (rename / move / copy / link / delete)
// works on: the listing selection if there is one, otherwise the folder
// you are viewing — which is the one shown selected in the tree. The
// Drive root itself is never a target. Delete has always used this
// fallback; rename / move / copy / link use it too, so the tree stays
// actionable without first selecting a row in the right pane.
function actionTargets()
{
    if( selectedPaths.size ) return Array.from( selectedPaths );
    if( currentFolder && currentFolder !== FS_ROOT ) return [ currentFolder ];
    return [];
}

function updateToolbarState()
{
    const n  = selectedPaths.size;
    const nT = actionTargets().length;

    // Anything under shared/ belongs to somebody else. The server refuses
    // every write on it (resolve_path returns writable=false), so the
    // buttons that would write are simply turned off here - a shared item
    // can be opened, downloaded and copied out, never changed.
    const targets = actionTargets();
    const roSel   = readOnlySel();        // same rule the context menus use
    const roHere  = readOnlyHere();

    document.getElementById( 'renameBtn'   ).disabled = (nT !== 1) || roSel;
    document.getElementById( 'moveToBtn'   ).disabled = (nT === 0) || roSel;
    document.getElementById( 'copyToBtn'   ).disabled = (nT === 0);   // copying OUT is fine
    document.getElementById( 'newFolderBtn' ).disabled = roHere;
    // Upload is the ONE thing an "add" share opens up: a folder somebody
    // shared with us, having ticked "pueden añadir archivos". Everything
    // else on this row stays off there — see canAddHere.
    document.getElementById( 'uploadBtn'    ).disabled = roHere && ! canAddHere;

    // Compartir: exactly one thing, mine, and not a whole virtual root.
    const shOne  = (targets.length === 1) ? targets[ 0 ] : '';
    const shareBtn = document.getElementById( 'shareBtn' );
    shareBtn.disabled = ! shOne || NayiveUI.isShared( shOne )
                        || shOne === 'files' || shOne === 'data';
    shareBtn.title    = shOne && ! shareBtn.disabled
                      ? TF( 'drive.shareOne', { name: shOne.split( '/' ).pop() } )
                      : T( 'drive.shareHint' );

    // Delete acts on the checked items, or (nothing checked) on the current
    // folder — disabled only at the root with no selection. A non-empty
    // current folder gets an extra confirmation (see openDeleteConfirm).
    const delBtn = document.getElementById( 'deleteBtn' );
    delBtn.disabled = (nT === 0) || roSel;
    delBtn.title    = (n > 0) ? T( 'drive.trashSelection' ) : T( 'drive.trashFolder' );

    // Copy-link acts on the one checked item, or (nothing checked) on the
    // folder selected in the tree — disabled only at the root with no selection.
    const clBtn = document.getElementById( 'copyLinkBtn' );
    clBtn.disabled = (nT !== 1);
    clBtn.title    = (n === 1) ? T( 'drive.linkItem' ) : T( 'drive.linkFolder' );

    // Download acts on the checked items, or (nothing checked) on the current folder.
    const dlBtn = document.getElementById( 'downloadBtn' );
    dlBtn.disabled = (nT === 0);
    dlBtn.title    = (n > 0) ? T( 'drive.downloadSelection' ) : T( 'drive.downloadFolder' );


    // The six above act on WHAT IS SELECTED: the ticked rows, or (nothing
    // ticked) the folder open in the tree. So the group - rule included, see
    // #selActions in index.html and drive.css - leaves the bar only when
    // there is no target at all (the Drive root, nothing ticked). With just
    // the open folder, Link, Share and Delete show; Rename, Move and Copy
    // wait for a tick.
    document.getElementById( 'selActions' ).hidden = ! nT;
    for( const id of [ 'renameBtn', 'moveToBtn', 'copyToBtn' ] )
        document.getElementById( id ).hidden = ! n;

    // Several of the titles above were just rewritten from scratch, so the
    // "· Ctrl+D" hints go back on last.
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
        if( ! await NayiveUI.confirm( {
                title:   T( 'drive.emptyTrashTitle' ),
                body:    TF( 'drive.diskFullBody', { held: fmtSize( held ) } ),
                confirm: T( 'drive.emptyTrash' ), danger: true } ) ) return;
        try { await GumApi.trashEmpty(); }
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

        selectedPaths.clear();
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
