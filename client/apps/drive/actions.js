/*
 * actions.js - Drive: rename, properties, copy link, deep links, delete and download.
 */
"use strict";

//------------------------------------------------------------------------//
// ACTIONS: RENAME

function openRename()
{
    const targets = actionTargets();
    if( targets.length !== 1 ) return;

    const path = targets[0];
    document.getElementById( 'renameName' ).value = path.split( '/' ).pop();
    setBackdrop( 'renameBackdrop', true );
    document.getElementById( 'renameName' ).focus();
}

async function confirmRename()
{
    const targets = actionTargets();
    if( targets.length !== 1 ) return;

    const oldPath = targets[0];
    const newName = document.getElementById( 'renameName' ).value.trim();
    if( ! newName ) return;

    setBackdrop( 'renameBackdrop', false );
    setStatus( T( 'drive.renaming' ) );

    const parent  = oldPath.includes( '/' ) ? oldPath.slice( 0, oldPath.lastIndexOf( '/' ) ) : '';
    const newPath = joinPath( parent, newName );

    // What the Undo walks back (undoMoves, move-copy.js): the rename, and
    // the bin ids of the item a "Replace" moved out of the way.
    const step    = { from: oldPath, to: newPath, moved: false, bin: null };
    let   canUndo = newPath !== oldPath;

    // The server refuses to rename onto an existing item (it would be
    // destroyed with no trip through the papelera). Offer to move the
    // one in the way to the papelera first.
    if( newPath !== oldPath && rowNode( newPath ) )
    {
        if( ! await NayiveUI.confirm( {
            title: T( 'drive.nameExistsTitle' ),
            body: TF( 'drive.nameExistsBody', { name: newName } ),
            confirm: T( 'drive.moveAndRename' ), danger: true } ) )
        {
            setStatus( '' );
            return;
        }
        try { step.bin = await withBusy( GumApi.binPaths( [ newPath ] ) ); }
        catch( _ ) { NayiveUI.toast( T( 'drive.moveExistingFailed' ) ); setStatus( '' ); return; }
        if( ! step.bin ) canUndo = false;     // an old server: nothing to restore it by
    }

    try
    {
        await withBusy( GumApi.rename( oldPath, newPath ) );
        step.moved = true;
        await NayiveMedia.remapPaths( [ [ oldPath, newPath ] ] );
        if( oldPath === currentFolder ) currentFolder = newPath;   // renamed the folder we're in — stay in it
        selectedPaths.clear();
        await reload();

        if( canUndo )
            NayiveUI.undoToast( T( 'ui.toast.renamed' ),
                                function() { undoMoves( [ step ], 'drive.renameFailed' ); } );
        else if( newPath !== oldPath )
            NayiveUI.toast( T( 'ui.toast.renamed' ) );
    }
    catch( err )
    {
        // The one in the way may be in the bin already: its Undo brings it back.
        const msg = TF( 'drive.renameFailed', { err: err.message } );
        if( step.bin ) NayiveUI.undoToast( msg, function() { undoMoves( [ step ], 'drive.renameFailed' ); } );
        else           NayiveUI.toast( msg );
        setStatus( '' );
    }
}

//------------------------------------------------------------------------//
// ACTIONS: PROPIEDADES
//
// What the server knows about what is selected: name, kind, where it
// lives, how big it is and when it last changed. A folder carries no
// size of its own, so its total (and its item count) are walked with
// listDirRecursive() AFTER the dialog is on screen — a deep folder takes
// a moment and the other rows should not wait for it.

let propsToken = 0;   // bumped on each open; a walk that lands late and no longer matches is dropped

function openProperties()
{
    const nodes = actionTargets().map( propsNode ).filter( Boolean );
    if( ! nodes.length ) return;

    const token = ++propsToken;
    const dl    = document.getElementById( 'propsBody' );
    const files = nodes.filter( function( n ) { return ! isDir( n ); } );
    const dirs  = nodes.filter( isDir );

    let sizeDd  = null;   // the <dd>s the folder walk fills in later
    let countDd = null;

    dl.textContent = '';

    if( nodes.length === 1 )
    {
        const node = nodes[0];
        const dir  = isDir( node );

        propRow( dl, T( 'drive.propName'     ), displayName( node ) );
        propRow( dl, T( 'drive.propType'     ), dir ? T( 'drive.folder' ) : fileKind( node ) );
        propRow( dl, T( 'drive.propLocation' ), parentLabel( node.path ) );

        if( dir )
        {
            countDd = propRow( dl, T( 'drive.propContents' ), T( 'drive.propCalculating' ) );
            sizeDd  = propRow( dl, T( 'drive.propSize'     ), T( 'drive.propCalculating' ) );
        }
        else if( node.size != null )
        {
            propRow( dl, T( 'drive.propSize' ), fmtSize( node.size ),
                     TF( 'drive.propBytes', { n: node.size.toLocaleString() } ) );
        }

        if( node.mtime )                    propRow( dl, T( 'drive.propModified' ), fmtDateTime( node.mtime ) );
        if( node.shared && node.shared.by ) propRow( dl, T( 'drive.propShared'   ), node.shared.by );
    }
    else
    {
        propRow( dl, T( 'drive.propSelection' ), TF( 'drive.nItems', { n: nodes.length } ) );
        propRow( dl, T( 'drive.propContents'  ), countLabel( files.length, dirs.length ) );

        // A search result can hold items from several folders: only say
        // where they are when there is one answer.
        const where = commonParent( nodes );
        if( where !== null ) propRow( dl, T( 'drive.propLocation' ), where );

        if( dirs.length )
        {
            sizeDd = propRow( dl, T( 'drive.propSize' ), T( 'drive.propCalculating' ) );
        }
        else
        {
            const total = files.reduce( function( sum, n ) { return sum + ( n.size || 0 ); }, 0 );
            propRow( dl, T( 'drive.propSize' ), fmtSize( total ),
                     TF( 'drive.propBytes', { n: total.toLocaleString() } ) );
        }
    }

    setBackdrop( 'propsBackdrop', true );
    document.getElementById( 'propsCloseBtn' ).focus();

    if( sizeDd ) fillFolderTotals( token, nodes, files, sizeDd, countDd );
}

// Walks every selected folder once and writes the total in. A walk that
// fails (a share whose grant has gone) leaves an em dash rather than a
// number that would be wrong.
async function fillFolderTotals( token, nodes, files, sizeDd, countDd )
{
    let bytes = files.reduce( function( sum, n ) { return sum + ( n.size || 0 ); }, 0 );
    let nFile = 0, nDir = 0;

    try
    {
        for( const dir of nodes.filter( isDir ) )
        {
            const sub = await withBusy( GumApi.listDirRecursive( dir.path ) );

            walkTotals( sub.nodes || [], function( n )
            {
                if( isDir( n ) ) nDir++;
                else             { nFile++; bytes += n.size || 0; }
            } );
        }
    }
    catch( _ )
    {
        if( ! propsShowing( token ) ) return;
        setPropValue( sizeDd, '—' );
        if( countDd ) setPropValue( countDd, '—' );
        return;
    }

    if( ! propsShowing( token ) ) return;

    setPropValue( sizeDd, fmtSize( bytes ), TF( 'drive.propBytes', { n: bytes.toLocaleString() } ) );
    if( countDd ) setPropValue( countDd, countLabel( nFile, nDir ) );
}

function walkTotals( nodes, fn )
{
    for( const n of nodes )
    {
        fn( n );
        if( isDir( n ) ) walkTotals( n.nodes || [], fn );
    }
}

// Still the same open dialog the walk was started for: an Escape (or a
// second Propiedades on something else) discards what is on its way.
function propsShowing( token )
{
    return token === propsToken &&
           document.getElementById( 'propsBackdrop' ).classList.contains( 'open' );
}

// The node a row describes: the one-level listing FIRST — only there does
// a folder carry its mtime (BuildTree leaves it out of the tree) — then
// the folder tree or the search results.
function propsNode( path )
{
    return ( curListing.nodes || [] ).find( function( n ) { return n.path === path; } ) || rowNode( path );
}

// "Tipo" for a file: its extension in capitals (PDF, JPG), or the plain
// word when it has none. typeExt() and not extOf(): a shared item's name
// is a slug with the dot gone ("SEPE.txt" -> "sepe-txt"), so its type has
// to come from the grant's own title.
function fileKind( node )
{
    const ext = typeExt( node );
    return ext ? ext.toUpperCase() : T( 'drive.propFile' );
}

function parentLabel( path )
{
    const parent = path.indexOf( '/' ) !== -1 ? path.slice( 0, path.lastIndexOf( '/' ) ) : '';
    return fsRel( parent ) || 'Drive';
}

// Where a multi-selection lives, or null when it is spread over several folders.
function commonParent( nodes )
{
    const first = parentLabel( nodes[0].path );
    return nodes.every( function( n ) { return parentLabel( n.path ) === first; } ) ? first : null;
}

function countLabel( nFiles, nDirs )
{
    const bits = [];
    if( nFiles ) bits.push( nFiles === 1 ? T( 'drive.propOneFile'   ) : TF( 'drive.propNFiles',   { n: nFiles } ) );
    if( nDirs  ) bits.push( nDirs  === 1 ? T( 'drive.propOneFolder' ) : TF( 'drive.propNFolders', { n: nDirs  } ) );

    return bits.length ? bits.join( ', ' ) : TF( 'drive.nItems', { n: 0 } );
}

// One <dt>label</dt><dd>value</dd> pair. Returns the <dd> so a total that
// is still being walked can be written into it when it arrives.
function propRow( dl, label, value, sub )
{
    const dt = document.createElement( 'dt' );
    dt.textContent = label;

    const dd = document.createElement( 'dd' );

    dl.appendChild( dt );
    dl.appendChild( dd );
    setPropValue( dd, value, sub );

    return dd;
}

function setPropValue( dd, value, sub )
{
    dd.textContent = value;

    if( sub )
    {
        const small = document.createElement( 'span' );
        small.className   = 'props-sub';
        small.textContent = sub;
        dd.appendChild( small );
    }
}

//------------------------------------------------------------------------//
// ACTIONS: COPY LINK
//
// Copies a link that re-opens Drive with this one item highlighted. The
// link is this same page plus ?sel=<path>; applyDeepLink() (run once at
// startup) reads it, opens the item's parent folder and selects the item.

async function copySelectionLink()
{
    // One checked item, else the folder selected in the tree.
    const tgts = actionTargets();
    if( tgts.length !== 1 ) return;
    const path = tgts[0];

    const url = location.origin + location.pathname + '?sel=' + encodeURIComponent( path );

    try
    {
        await NayiveUI.copyText( url );
        flashStatus( T( 'drive.linkCopied' ) );
    }
    catch( _ )
    {
        flashStatus( T( 'drive.linkCopyFailed' ) );
    }
}

// A transient message in the top-bar status slot (before the sync dot).
// Unlike setStatus(), it clears itself so no stale text is left behind.
let statusFlashTimer = null;

function flashStatus( text )
{
    setStatus( text );
    clearTimeout( statusFlashTimer );
    statusFlashTimer = setTimeout( function() { setStatus( '' ); }, 3000 );
}

// The papelera's own "done": it gulps twice (see .bin-gulp in drive.css) for
// the three seconds a status message would have lasted, so a move to the bin
// is answered where the files went instead of in words. On a phone the bin
// button hides inside the header's "⋮", so that one gulps in its place.
let binGulpTimer = null;

function flashBin()
{
    const btns = [ 'trashViewBtn', 'moreBtn' ].map( function( id ) { return document.getElementById( id ); } );
    const el   = btns.find( function( b ) { return b && b.getClientRects().length; } );

    if( ! el ) return;

    clearTimeout( binGulpTimer );
    btns.forEach( function( b ) { if( b ) b.classList.remove( 'bin-gulp' ); } );
    void el.offsetWidth;                 // two deletes in a row: without this reflow
    el.classList.add( 'bin-gulp' );      // re-adding the class would not restart it

    binGulpTimer = setTimeout( function() { el.classList.remove( 'bin-gulp' ); }, 3000 );
}

//------------------------------------------------------------------------//
// DEEP LINK: ?sel=<path>   -> open that item's folder with it selected
//            ?open=<path>  -> navigate straight into that folder (used by Trip's
//                            "Fotos" row); falls back to ?sel behaviour for a file

async function applyDeepLink()
{
    const params = new URLSearchParams( location.search );
    const open   = params.get( 'open' );

    if( params.get( 'big' ) ) { openBigFiles(); return; }      // the "space almost full" card

    if( open )
    {
        const node = findNode( open );

        if( node && isDir( node ) )
        {
            expandTo( open );
            navigateTo( open );

            const treeRow = document.querySelector( '#treePane .tree-row.selected' );
            if( treeRow ) treeRow.scrollIntoView( { block: 'nearest' } );
            return;
        }
        // a file, or gone — reveal it like ?sel (its parent folder is checked below)
        params.set( 'sel', open );
    }

    const sel = params.get( 'sel' );
    if( ! sel ) return;

    const parent = sel.indexOf( '/' ) !== -1 ? sel.slice( 0, sel.lastIndexOf( '/' ) ) : '';

    if( parent && ! findNode( parent ) )
    {
        flashStatus( T( 'drive.linkGone' ) );
        return;
    }

    currentFolder = parent;
    expandTo( sel );                       // open the tree all the way down to the target
    clearSearch();
    await loadListing( parent );           // fetch the folder that holds the target

    if( ! ( curListing.nodes || [] ).some( function( n ) { return n.path === sel; } ) )
    {
        flashStatus( T( 'drive.linkGone' ) );
        return;
    }

    selectedPaths = new Set( [ sel ] );
    render();

    const treeRow = document.querySelector( '#treePane .tree-row.selected' );
    if( treeRow ) treeRow.scrollIntoView( { block: 'nearest' } );

    const row = document.querySelector( '#listing .row.selected' );
    if( row ) row.scrollIntoView( { block: 'center' } );
}

// Mark every folder on the way to `path` (and `path` itself) as expanded,
// so renderTree() draws the branch open down to it.
function expandTo( path )
{
    let acc = '';
    expandedFolders.add( '' );

    for( const seg of splitPath( path ) )
    {
        acc = acc ? acc + '/' + seg : seg;
        expandedFolders.add( acc );
    }
}

//------------------------------------------------------------------------//
// ACTIONS: DELETE

let deleteTargets = [];   // paths the open confirm dialog will delete

function openDeleteConfirm()
{
    let msg;

    if( selectedPaths.size )
    {
        deleteTargets = Array.from( selectedPaths );

        // Only files: no question - they go at once and the toast's Undo
        // brings them back. A folder holds more than you see: it still asks.
        if( deleteTargets.every( isFileRow ) ) { confirmDelete(); return; }

        const names = deleteTargets.map( function( p ) { return p.split( '/' ).pop(); } );
        msg = names.length === 1 ? TF( 'drive.trashOne', { name: names[0] } )
                                  : TF( 'drive.trashN', { n: names.length } );
    }
    else if( currentFolder && currentFolder !== FS_ROOT )
    {
        deleteTargets = [ currentFolder ];
        const count = curListing.nodes.length;   // the open folder's own listing
        const name  = currentFolder.split( '/' ).pop();
        msg = count === 0
            ? TF( 'drive.trashFolderQ', { name: name } )
            : TF( count === 1 ? 'drive.trashFolderOneQ' : 'drive.trashFolderNQ',
                  { name: name, n: count } );
    }
    else return;

    document.getElementById( 'deleteMsg' ).textContent = msg;

    // No selection -> this deletes the folder you are viewing. Make that
    // impossible to miss instead of letting it look like a normal delete.
    const warn = document.getElementById( 'deleteFolderWarn' );
    if( ! selectedPaths.size )
    {
        warn.textContent = T( 'drive.nothingSelected' );
        warn.hidden = false;
    }
    else warn.hidden = true;

    setBackdrop( 'deleteBackdrop', true );
}

// A file shown in the listing (or the search results). Anything not
// found is taken for a folder, so it keeps its question.
function isFileRow( path )
{
    const node = rowNode( path );
    return !! node && ! isDir( node );
}

let deleteBusy = false;   // a move to the bin is on its way: a held Del key must not send it twice

async function confirmDelete()
{
    if( ! deleteTargets.length || deleteBusy ) return;

    const targets = deleteTargets;
    deleteTargets = [];
    deleteBusy    = true;

    setBackdrop( 'deleteBackdrop', false );
    setStatus( T( 'drive.movingToTrash' ) );

    const droppedCurrent = targets.indexOf( currentFolder ) !== -1;

    try
    {
        const ids = await withBusy( GumApi.binPaths( targets ) );
        await NayiveMedia.purgePaths( targets );
        selectedPaths.clear();
        deleteBusy = false;

        if( droppedCurrent )
            currentFolder = currentFolder.includes( '/' )
                            ? currentFolder.slice( 0, currentFolder.lastIndexOf( '/' ) ) : FS_ROOT;

        await reload();
        setStatus( '' );      // clears "Moving to the bin..."; the bin itself says it landed
        flashBin();

        // An old server does not say the bin ids: no way back from here.
        if( ids ) NayiveUI.undoToast( T( 'ui.toast.binned' ), function() { undoBin( ids ); } );
        else      NayiveUI.toast( T( 'ui.toast.binned' ) );
    }
    catch( _ )
    {
        deleteBusy = false;
        NayiveUI.toast( T( 'drive.trashFailed' ) );
        setStatus( '' );
    }
}

// Undo of a move to the bin: everything comes back to where it was. The
// view stays where it is now (a binned open folder left it on its parent)
// and is re-read. Sidecars: the same as the bin's own Restore - nothing;
// Photos remakes a thumbnail it misses.
async function undoBin( ids )
{
    setStatus( T( 'drive.restoring' ) );

    let res;
    try { res = await withBusy( GumApi.trashRestore( ids ) ); }
    catch( _ ) { setStatus( '' ); NayiveUI.toast( T( 'drive.restoreFailed' ) ); await refreshView(); return; }

    await refreshView();
    restoredStatus( res );
}

// "Restored", or where one landed when its old name was taken meanwhile.
function restoredStatus( res )
{
    if( res && res.renamed && res.renamed.length )
        flashStatus( TF( 'drive.restoredAs', { name: res.renamed[0] } ) );
    else
        flashStatus( T( 'drive.restored' ) );
}

// After an Undo: show the truth for wherever the user is NOW - the bin, or
// the open folder, which may no longer be the one the action happened in.
function refreshView()
{
    return trashMode ? refreshTrash() : reload();
}

//------------------------------------------------------------------------//
// ACTIONS: DOWNLOAD

function showProgress( title )
{
    document.getElementById( 'progressTitle' ).textContent = title || T( 'drive.working' );
    setBackdrop( 'progressBackdrop', true );
}

function hideProgress() { setBackdrop( 'progressBackdrop', false ); }

// Download: the SERVER sends it (server/go/api_download.go) - one file as it
// is, anything else as ONE .zip it writes while it reads - and the browser
// saves it with its own downloader. So no size is too big for a phone's
// memory, and Drive stays usable meanwhile. Drive only watches: it asks the
// server how far it got and draws that on the shared transfer bar
// (NayiveUI.transfer: in the toolbar when there is room, else at the bottom),
// whose ✕ stops it. One at a time: Download is off while one runs.

const DL_POLL_MS   = 700;
const DL_NET_TRIES = 20;     // polls in a row that may fail before Drive stops watching

let dlJob = null;            // the download under way: { id, name, files, row, timer, fails, stopped }

async function downloadSelection()
{
    if( dlJob ) return;
    const paths = actionTargets();
    if( ! paths.length ) return;

    const q = new URLSearchParams();
    paths.forEach( function( p ) { q.append( 'paths', p ); } );

    let r;
    try
    {
        r = JSON.parse( await withBusy( GumApi.fetchText( '/api/download?' + q.toString(), { method: 'POST' } ) ) );
    }
    catch( err )
    {
        NayiveUI.toast( err && err.status === 413 ? T( 'drive.compressTooMany' ) : T( 'drive.downloadFailed' ),
                        { ms: 6000 } );
        return;
    }

    const job = dlJob = { id: r.id, name: r.name, files: r.files, timer: 0, fails: 0, stopped: false,
                          row: NayiveUI.transfer( { onStop: stopDownload } ) };
    drawDownload( job, 0, 0 );
    updateToolbarState();

    // The browser fetches it itself: a plain link, clicked.
    const a = document.createElement( 'a' );
    a.href     = '/api/download?id=' + encodeURIComponent( job.id );
    a.download = job.name;
    document.body.appendChild( a );
    a.click();
    a.remove();

    job.timer = setTimeout( pollDownload, DL_POLL_MS );
}

// "Downloading… 45%", and "· 3 of 12" for a zip of several files.
function drawDownload( job, pct, done )
{
    const text = job.files > 1 ? TF( 'drive.downloadPctFiles', { pct: pct, done: done, n: job.files } )
                               : TF( 'drive.downloadPct', { pct: pct } );
    job.row.set( text, pct );
}

async function pollDownload()
{
    const job = dlJob;
    if( ! job ) return;

    let p;
    try
    {
        p = JSON.parse( await GumApi.fetchText( '/api/download?progress=1&id=' + encodeURIComponent( job.id ) ) );
        job.fails = 0;
    }
    catch( err )
    {
        // 404: the server forgot it (restarted, or never fetched in time).
        p = { state: ( err && err.status === 404 ) || ++job.fails >= DL_NET_TRIES ? 'gone' : 'net' };
    }
    if( dlJob !== job ) return;       // stopped meanwhile

    if( p.state === 'waiting' || p.state === 'running' || p.state === 'net' )
    {
        if( p.total !== undefined )
            drawDownload( job, p.total > 0 ? Math.min( 100, Math.floor( p.sent * 100 / p.total ) ) : 0, p.done );
        job.timer = setTimeout( pollDownload, DL_POLL_MS );
        return;
    }
    if( p.state === 'done' ) drawDownload( job, 100, job.files );
    endDownload( p.state );
}

// The ✕: the server breaks the connection, and the browser's own list
// shows the download as failed - never half a file that looks whole.
async function stopDownload()
{
    const job = dlJob;
    if( ! job ) return;
    job.stopped = true;
    clearTimeout( job.timer );
    try { await GumApi.fetchText( '/api/download?id=' + encodeURIComponent( job.id ), { method: 'DELETE' } ); }
    catch( _ ) {}
    if( dlJob === job ) endDownload( 'stopped' );
}

function endDownload( state )
{
    const job = dlJob;
    clearTimeout( job.timer );
    dlJob = null;
    // A finished one stays at 100 % a moment, so it reads as done.
    if( state === 'done' ) setTimeout( job.row.end, 800 ); else job.row.end();
    if(      state === 'failed' )                 NayiveUI.toast( T( 'drive.downloadFailed' ), { ms: 6000 } );
    else if( state === 'stopped' && job.stopped ) NayiveUI.toast( T( 'drive.downloadStopped' ) );
    updateToolbarState();
}
