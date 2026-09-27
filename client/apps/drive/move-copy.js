/*
 * move-copy.js - Drive: move to… / copy to….
 */
"use strict";

//------------------------------------------------------------------------//
// ACTIONS: MOVE TO… / COPY TO…
//
// Both open the same folder chooser. "Move" is one server rename() per
// item (old path -> new parent). "Copy" has no server verb, so Drive
// reads every file's bytes and writes them under the destination,
// recreating any sub-folder structure as it goes.

let pickerMode     = null;              // 'move' | 'copy'
let pickerDest     = null;              // chosen folder path (FS_ROOT = Drive root); null = nothing chosen
let pickerExpanded = new Set();

function openFolderPicker( mode )
{
    closeCtxMenus();
    if( ! actionTargets().length ) return;

    pickerMode     = mode;
    pickerDest     = null;
    pickerExpanded = new Set( [ FS_ROOT ] );

    let acc = '';
    for( const seg of splitPath( currentFolder ) ) { acc = acc ? acc + '/' + seg : seg; pickerExpanded.add( acc ); }

    document.getElementById( 'pickFolderTitle' ).textContent = (mode === 'move') ? T( 'drive.moveTo' ) : T( 'drive.copyTo' );

    const cb = document.getElementById( 'pickFolderConfirmBtn' );
    cb.title = (mode === 'move') ? T( 'drive.move' ) : NayiveUI.t( 'ui.copy' );
    cb.setAttribute( 'aria-label', cb.title );

    renderFolderPicker();
    updatePickerConfirm();
    setBackdrop( 'pickFolderBackdrop', true );
}

function renderFolderPicker()
{
    const host = document.getElementById( 'pickFolderTree' );
    host.innerHTML = '';
    host.appendChild( buildPickerNode( findNode( FS_ROOT ) || dirTreeRoot, 0 ) );
}

// A folder is not a valid destination if it is one of the selected
// folders itself, or lives inside one (you cannot move/copy a folder
// into its own subtree).
function isBadDest( path )
{
    for( const p of actionTargets() )
    {
        const n = findNode( p );
        if( n && isDir( n ) && (path === p || path.indexOf( p + '/' ) === 0) ) return true;
    }
    return false;
}

function buildPickerNode( node, depth )
{
    const wrap = document.createElement( 'div' );
    wrap.className = 'tree-node';

    const subDirs = (node.nodes || []).filter( isDir );
    const isOpen  = pickerExpanded.has( node.path );
    const bad     = isBadDest( node.path );

    const row = document.createElement( 'div' );
    row.className = 'tree-row' + (node.path === pickerDest ? ' selected' : '') + (bad ? ' bad' : '');

    const twisty = document.createElement( 'span' );
    twisty.className = 'twisty' + (subDirs.length ? (isOpen ? ' open' : '') : ' leaf');
    twisty.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    twisty.addEventListener( 'click', function( e )
    {
        e.stopPropagation();
        if( ! subDirs.length ) return;
        if( isOpen ) pickerExpanded.delete( node.path ); else pickerExpanded.add( node.path );
        renderFolderPicker();
    });

    const folderIc = document.createElement( 'span' );
    folderIc.className = 'folder-ic';
    folderIc.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';

    const label = document.createElement( 'span' );
    label.className   = 'tree-name';
    label.textContent = depth === 0 ? 'Drive' : nameOf( node );

    row.appendChild( twisty );
    row.appendChild( folderIc );
    row.appendChild( label );

    if( ! bad )
        row.addEventListener( 'click', function()
        {
            pickerDest = node.path;
            pickerExpanded.add( node.path );
            renderFolderPicker();
            updatePickerConfirm();
        });

    wrap.appendChild( row );

    const childrenHost = document.createElement( 'div' );
    childrenHost.className = 'tree-children' + (isOpen ? ' open' : '');
    subDirs.forEach( function( c ) { childrenHost.appendChild( buildPickerNode( c, depth + 1 ) ); } );
    wrap.appendChild( childrenHost );

    return wrap;
}

function updatePickerConfirm()
{
    document.getElementById( 'pickFolderConfirmBtn' ).disabled = (pickerDest === null);

    const tgts = actionTargets();
    const what = tgts.length === 1
        ? ('"' + tgts[0].split( '/' ).pop() + '"')
        : TF( 'drive.nItems', { n: tgts.length } );

    const dst = pickerDest === FS_ROOT ? 'Drive' : (pickerDest || '').split( '/' ).pop();

    document.getElementById( 'pickFolderMsg' ).textContent = (pickerDest === null)
        ? TF( 'drive.pickDest', { what: what } )
        : TF( pickerMode === 'move' ? 'drive.moveWhatTo' : 'drive.copyWhatTo', { what: what, dst: dst } );
}

async function confirmFolderPicker()
{
    if( pickerDest === null ) return;

    const dest  = pickerDest;
    const mode  = pickerMode;
    const paths = actionTargets();

    setBackdrop( 'pickFolderBackdrop', false );

    if( mode === 'move' ) await doMove( paths, dest );
    else                  await doCopy( paths, dest );
}

// The names already present in `dest` (one listDir call). Empty on failure
// — the server's own clobber guard is the real backstop.
async function destNameSet( dest )
{
    try
    {
        const r = await GumApi.listDir( dest );
        return new Set( ( r.nodes || [] ).map( function( n ) { return n.path.split( '/' ).pop(); } ) );
    }
    catch( _ ) { return new Set(); }
}

async function doMove( paths, dest )
{
    setStatus( T( 'drive.moving' ) );

    // A move onto an existing item would destroy it (the server refuses,
    // outright rename would erase it with no papelera). Find the clashes
    // up front and let the user replace-via-papelera or skip them.
    const destNames = await destNameSet( dest );
    const clashes = paths.filter( function( p )
    {
        const parent = p.indexOf( '/' ) !== -1 ? p.slice( 0, p.lastIndexOf( '/' ) ) : '';
        return parent !== dest && destNames.has( p.split( '/' ).pop() );
    } );

    let replace = false;
    if( clashes.length )
    {
        replace = await NayiveUI.confirm( {
            title: T( 'drive.clashesTitle' ),
            body: ( clashes.length === 1
                        ? TF( 'drive.oneClashDest', { name: clashes[0].split( '/' ).pop() } )
                        : TF( 'drive.nClashesDest', { n: clashes.length } ) ) +
                  '\n\n' + T( 'drive.clashesHint' ),
            confirm: T( 'drive.replace' ), cancel: T( 'drive.skip' ), danger: true } );
    }

    let moved = 0, skipped = 0;
    const remapped = [];
    const steps    = [];         // what the Undo walks back: { from, to, moved, bin } (undoMoves)
    let   canUndo  = true;       // false: a "Replace" got no bin ids back (an old server)

    try
    {
        for( const p of paths )
        {
            const name   = p.split( '/' ).pop();
            const parent = p.indexOf( '/' ) !== -1 ? p.slice( 0, p.lastIndexOf( '/' ) ) : '';

            if( parent === dest ) { skipped++; continue; }      // already there

            const to    = joinPath( dest, name );
            const clash = clashes.indexOf( p ) !== -1;

            if( clash && ! replace ) { skipped++; continue; }

            const step = { from: p, to: to, moved: false, bin: null };
            steps.push( step );

            if( clash )
            {
                step.bin = await withBusy( GumApi.binPaths( [ to ] ) );   // existing -> papelera
                if( ! step.bin ) canUndo = false;
            }

            await withBusy( GumApi.rename( p, to ) );
            step.moved = true;
            remapped.push( [ p, to ] );
            moved++;
        }

        await NayiveMedia.remapPaths( remapped );
        const movedCur = remapped.find( function( r ) { return r[0] === currentFolder; } );
        if( movedCur ) currentFolder = movedCur[1];   // moved the folder we're in — follow it
        selectedPaths.clear();
        await reload();

        const msg = TF( 'drive.nMoved', { n: moved } )
                  + (skipped ? ' · ' + TF( 'drive.nSkipped', { n: skipped } ) : '');
        if( moved && canUndo ) NayiveUI.undoToast( msg, function() { undoMoves( steps ); } );
        else                   flashStatus( msg );
    }
    catch( err )
    {
        // Whatever DID move before the failure still has to take its
        // sidecars with it, or those notes are orphaned. Safe here:
        // remapPaths() is best-effort and never throws.
        await NayiveMedia.remapPaths( remapped );

        // The Undo puts back only what did happen: the items that moved,
        // and a "Replace" whose item went to the bin.
        const msg  = TF( 'drive.moveFailed', { err: err && err.message || err } );
        const done = steps.filter( function( s ) { return s.moved || s.bin; } );
        if( done.length && canUndo ) NayiveUI.undoToast( msg, function() { undoMoves( done ); } );
        else                         NayiveUI.toast( msg );
        await reload();
    }
}

// UNDO of a move / rename (a drop, "Move to…", Cut-Paste, rename). Each
// step is { from, to, moved, bin }: a moved item goes back where it came
// from, its sidecars with it (remapPaths in reverse); THEN whatever a
// "Replace" sent to the bin is restored - in that order, or the restore
// would find its name still taken and land as "name (2)". So when an item
// cannot go back, what it replaced stays in the bin. The view is re-read
// wherever the user is now; one who went into a moved folder follows it.
async function undoMoves( steps, failKey )
{
    setStatus( T( 'drive.moving' ) );

    const back = [], ids = [];
    let   err  = null;

    for( const s of steps.slice().reverse() )
    {
        if( s.moved )
        {
            try { await withBusy( GumApi.rename( s.to, s.from ) ); }
            catch( e ) { err = err || e; continue; }
            back.push( [ s.to, s.from ] );
        }
        if( s.bin ) ids.push.apply( ids, s.bin );
    }

    await NayiveMedia.remapPaths( back );
    currentFolder = followPath( currentFolder, back );

    let res = null;
    if( ids.length )
    {
        try { res = await withBusy( GumApi.trashRestore( ids ) ); }
        catch( e ) { err = err || e; }
    }

    await refreshView();
    if( trashMode ) setStatus( '' );      // the bin's refresh does not clear "Moving…" (reload does)

    if( err )      NayiveUI.toast( TF( failKey || 'drive.moveFailed', { err: err && err.message || err } ) );
    else if( res ) restoredStatus( res );
}

// Where `path` is after the moves in `pairs` ([ old, new ]): the same
// place, or the new one when it is (or lives inside) a moved item.
function followPath( path, pairs )
{
    for( const pr of pairs )
    {
        if( path === pr[0] )                    return pr[1];
        if( path.indexOf( pr[0] + '/' ) === 0 ) return pr[1] + path.slice( pr[0].length );
    }
    return path;
}

async function doCopy( paths, dest )
{
    showProgress( T( 'drive.copying' ) );

    let files = 0;
    const copied = [];        // [src, dst] of every file copied whole, for its photo note

    try
    {
        const taken = await destNameSet( dest );

        for( const p of paths )
        {
            const node = rowNode( p );
            if( ! node ) continue;

            const topName = uniqueName( nameOf( node ), taken );
            taken.add( topName );

            if( ! isDir( node ) )
            {
                const bytes = await withBusy( GumApi.readFileBytes( p ) );
                const to    = joinPath( dest, topName );
                await withBusy( GumApi.writeFileBytes( to, bytes ) );
                copied.push( [ p, to ] );
                files++;
                continue;
            }

            // Folder: recreate it (renamed if the name is taken) and copy
            // every file inside, rebuilding the sub-folder structure first.
            // The folders-only tree has no file nodes — fetch the subtree.
            const sub     = await withBusy( GumApi.listDirRecursive( p ) );
            const entries = [];
            collectEntries( pruneTreeInPlace( { path: p, nodes: sub.nodes || [] } ), topName, entries );

            const dirs = new Set( [ topName ] );
            entries.forEach( function( e )
            {
                const segs = e.zipPath.split( '/' );
                let acc = '';
                for( let i = 0; i < segs.length - 1; i++ ) { acc = acc ? acc + '/' + segs[i] : segs[i]; dirs.add( acc ); }
            });

            const ordered = Array.from( dirs ).sort( function( a, b ) { return a.split( '/' ).length - b.split( '/' ).length; } );

            for( const d of ordered )
            {
                const segs   = d.split( '/' );
                const name   = segs.pop();
                const rel    = segs.join( '/' );
                const parent = rel ? joinPath( dest, rel ) : dest;
                try { await withBusy( GumApi.makeDir( parent, name ) ); }
                catch( _ ) { /* already exists — fine */ }
            }

            for( const e of entries )
            {
                const bytes = await withBusy( GumApi.readFileBytes( e.fullPath ) );
                await withBusy( GumApi.writeFileBytes( joinPath( dest, e.zipPath ), bytes ) );
                files++;
            }

            // ONE pair for the whole folder: copyPaths() re-keys by
            // prefix, so this carries the photo note of every file
            // inside it — the same single pair doMove() pushes for a
            // moved folder. Without it a copied album arrives blank.
            copied.push( [ p, joinPath( dest, topName ) ] );
        }

        await NayiveMedia.copyPaths( copied );
        selectedPaths.clear();
        await reload();
        flashStatus( TF( 'drive.nCopied', { n: files } ) );
    }
    catch( err )
    {
        await NayiveMedia.copyPaths( copied );      // same as doMove: keep what did copy
        NayiveUI.toast( TF( 'drive.copyFailed', { err: err && err.message || err } ) );
        await reload();
    }
    finally
    {
        hideProgress();
    }
}

// A name not already in `taken` (a Set of names present in the
// destination). On a clash it becomes "name (copia).ext", then
// "name (copia 2).ext", … The caller adds each returned name to `taken`.
function uniqueName( name, taken )
{
    if( ! taken.has( name ) ) return name;

    const dot  = name.lastIndexOf( '.' );
    const base = dot > 0 ? name.slice( 0, dot ) : name;
    const ext  = dot > 0 ? name.slice( dot ) : '';

    for( let i = 1; ; i++ )
    {
        const cand = base + ' (copia' + (i > 1 ? ' ' + i : '') + ')' + ext;
        if( ! taken.has( cand ) ) return cand;
    }
}

