// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * move-copy.js - Drive: move to… / copy to….
 */
"use strict";

//------------------------------------------------------------------------//
// ACTIONS: MOVE TO… / COPY TO…
//
// Both open the same folder chooser. "Move" is one server rename() per
// item (old path -> new parent). "Copy" is one server copy per item
// (POST ?from=&new=, server/go/copy.go): the bytes go disk to
// disk, never through the browser, so a big video cannot fill the tab.

// The chooser is the shared "Move to…" (NayiveUI.pickNode): the same tree
// as the side pane, Drive's own folders only (nothing moves or copies INTO
// "Shared with me"). The paths are read once, before it opens.
async function openFolderPicker( mode )
{
    const paths = actionTargets();
    if( ! paths.length ) return;

    // A folder is not a valid destination if it is one of the selected
    // folders itself, or lives inside one (you cannot move/copy a folder
    // into its own subtree).
    const isBadDest = function( path )
    {
        return paths.some( function( p )
        {
            const n = findNode( p );
            return n && isDir( n ) && (path === p || path.indexOf( p + '/' ) === 0);
        } );
    };
    const what = paths.length === 1
        ? ('"' + paths[0].split( '/' ).pop() + '"')
        : TF( 'drive.nItems', { n: paths.length } );

    const dest = await NayiveUI.pickNode( {
        title:    mode === 'move' ? T( 'drive.moveTo' ) : T( 'drive.copyTo' ),
        okLabel:  mode === 'move' ? T( 'drive.move' ) : T( 'ui.copy' ),
        roots:    function() { return treeRoots().slice( 0, 1 ); },
        current:  currentFolder,
        lit:      null,
        disabled: isBadDest,
        note:     function( lit )
        {
            if( lit === null ) return TF( 'drive.pickDest', { what: what } );
            const dst = lit === FS_ROOT ? 'Drive' : lit.split( '/' ).pop();
            return TF( mode === 'move' ? 'drive.moveWhatTo' : 'drive.copyWhatTo', { what: what, dst: dst } );
        }
    } );
    if( dest === null ) return;

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
        clearSel();
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

    // Keep this BEFORE trashRestore below: the note of a photo a "Replace"
    // sent to the bin was parked aside by media.js, and remapPaths puts it
    // back on that path as the moved item leaves it. The restore must then
    // find the path free and land there, under its note - restored first, it
    // would come back as "(restaurado …)" and its note stay on the old name.
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
    const copied = [];        // [src, dst] of every item copied, for its photo notes

    try
    {
        const taken = await destNameSet( dest );

        for( const p of paths )
        {
            const node = rowNode( p );
            if( ! node ) continue;

            const topName = uniqueName( nameOf( node ), taken );
            taken.add( topName );

            // A folder comes whole, sub-folders and all. The server never
            // copies over anything: a name taken meanwhile is a 409.
            const to  = joinPath( dest, topName );
            const q   = new URLSearchParams( { from: p, 'new': to } ).toString();
            const res = JSON.parse( await withBusy( GumApi.fetchText( GumApi.API_FILES + '?' + q, { method: 'POST' } ) ) );
            files += ( res && res.files ) || 0;

            // ONE pair per item: copyPaths() re-keys by prefix, so a
            // folder's pair carries the photo note of every file inside
            // it - the same single pair doMove() pushes for a moved
            // folder. Without it a copied album arrives blank.
            copied.push( [ p, to ] );
        }

        await NayiveMedia.copyPaths( copied );
        clearSel();
        await reload();
        flashStatus( TF( 'drive.nCopied', { n: files } ) );
    }
    catch( err )
    {
        await NayiveMedia.copyPaths( copied );      // same as doMove: keep what did copy
        if( err && err.status === 507 ) NayiveUI.toast( T( 'ui.room.none' ) );
        else                            NayiveUI.toast( TF( 'drive.copyFailed', { err: err && err.message || err } ) );
        await reload();
    }
    finally
    {
        hideProgress();
    }
}

// A name not already in `taken` (a Set of names present in the
// destination). On a clash it becomes "name (copia).ext", then
// "name (copia 2).ext", … - "copia" in the user's language. The caller
// adds each returned name to `taken`.
function uniqueName( name, taken )
{
    if( ! taken.has( name ) ) return name;

    const dot  = name.lastIndexOf( '.' );
    const base = dot > 0 ? name.slice( 0, dot ) : name;
    const ext  = dot > 0 ? name.slice( dot ) : '';
    const word = T( 'drive.copyWord' );

    for( let i = 1; ; i++ )
    {
        const cand = base + ' (' + word + (i > 1 ? ' ' + i : '') + ')' + ext;
        if( ! taken.has( cand ) ) return cand;
    }
}

