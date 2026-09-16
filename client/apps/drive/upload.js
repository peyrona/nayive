/*
 * upload.js - Drive: new folder and upload (replace prompt, MP4 conversion,
 * Calendar / Contacts imports).
 */
"use strict";

//------------------------------------------------------------------------//
// ACTIONS: NEW FOLDER

function openNewFolder()
{
    document.getElementById( 'newFolderName' ).value = '';
    setBackdrop( 'newFolderBackdrop', true );
    document.getElementById( 'newFolderName' ).focus();
}

async function confirmNewFolder()
{
    const name = document.getElementById( 'newFolderName' ).value.trim();
    if( ! name ) return;

    setBackdrop( 'newFolderBackdrop', false );
    setStatus( T( 'drive.creatingFolder' ) );

    try
    {
        await withBusy( GumApi.makeDir( currentFolder, name ) );
        await reload();
    }
    catch( _ )
    {
        NayiveUI.toast( T( 'drive.createFolderFailed' ) );
        setStatus( '' );
    }
}

//------------------------------------------------------------------------//
// ACTIONS: UPLOAD

// Each upload item is { relPath, file }, where relPath is the path of the
// file relative to the current folder ('sub/dir/name.ext' for a folder
// upload, just 'name.ext' for a plain file).

function onUploadInputChange( e )
{
    const items = Array.from( e.target.files || [] ).map( function( f ) {
        return { relPath: (f.webkitRelativePath || f.name), file: f };
    } );
    e.target.value = '';
    uploadItems( items );
}

function onDrop( e )
{
    if( dragPaths ) return;                 // an internal move, handled by the folder row
    e.preventDefault();
    document.getElementById( 'listPane' ).classList.remove( 'drag-over' );

    const dt = e.dataTransfer;
    if( ! dt ) return;

    // Prefer the entry API so dropped folders are walked recursively.
    const entries = [];
    if( dt.items && dt.items.length )
    {
        for( let i = 0; i < dt.items.length; i++ )
        {
            const en = dt.items[i].webkitGetAsEntry && dt.items[i].webkitGetAsEntry();
            if( en ) entries.push( en );
        }
    }

    if( entries.length )
    {
        setStatus( T( 'drive.readingFolder' ) );
        Promise.all( entries.map( function( en ) { return walkEntry( en, '' ); } ) )
               .then( function( lists ) { uploadItems( [].concat.apply( [], lists ) ); } )
               .catch( function() { setStatus( '' ); NayiveUI.toast( T( 'drive.readFolderFailed' ) ); } );
        return;
    }

    const files = Array.from( dt.files || [] );
    if( files.length ) uploadItems( files.map( function( f ) { return { relPath: f.name, file: f }; } ) );
}

// Recursively turn a FileSystemEntry into a flat list of { relPath, file }.
function walkEntry( entry, prefix )
{
    if( entry.isFile )
    {
        return new Promise( function( resolve, reject ) {
            entry.file( function( f ) { resolve( [ { relPath: prefix + f.name, file: f } ] ); }, reject );
        } );
    }

    const reader  = entry.createReader();
    const dirPath = prefix + entry.name + '/';
    const all     = [];

    return new Promise( function( resolve, reject ) {
        (function readBatch() {
            reader.readEntries( function( batch ) {
                if( ! batch.length )
                {
                    Promise.all( all.map( function( en ) { return walkEntry( en, dirPath ); } ) )
                           .then( function( lists ) { resolve( [].concat.apply( [], lists ) ); } )
                           .catch( reject );
                    return;
                }
                for( let i = 0; i < batch.length; i++ ) all.push( batch[i] );
                readBatch();                       // keep reading: readEntries returns at most ~100 per call
            }, reject );
        })();
    } );
}

// The overwrite-warning dialog resolves this when the user picks an option.
let replaceResolver = null;

// Show the "Ya existen" dialog and resolve to 'cancel' | 'skip' | 'overwrite'.
//   collisions - the upload items whose target file already exists
//   total      - how many items are in the whole upload
function askReplace( collisions, total )
{
    const allCollide = collisions.length === total;

    // One clash gets the singular title; data-i18n keeps it right on a language switch.
    const titleKey = collisions.length === 1 ? 'drive.alreadyExistOne' : 'drive.alreadyExist';
    const titleEl  = document.getElementById( 'replaceTitle' );
    titleEl.setAttribute( 'data-i18n', titleKey );
    titleEl.textContent = T( titleKey );

    document.getElementById( 'replaceMsg' ).textContent = collisions.length === 1
        ? T( 'drive.oneClash' )
        : TF( 'drive.nClashes', { n: collisions.length } );

    const ul = document.getElementById( 'replaceList' );
    ul.innerHTML = '';
    const SHOWN = 12;
    collisions.slice( 0, SHOWN ).forEach( function( it )
    {
        const li    = document.createElement( 'li' );
        const shown = clashName( it ) || it.relPath;   // a twin's name, when it is the twin that clashes
        li.textContent = shown;
        li.title = shown;
        ul.appendChild( li );
    });
    if( collisions.length > SHOWN )
    {
        const li = document.createElement( 'li' );
        li.textContent = TF( 'drive.andNMore', { n: collisions.length - SHOWN } );
        ul.appendChild( li );
    }

    // When every item collides there is nothing to "skip to", so the only
    // meaningful choice is replace-or-cancel: hide the checkbox, force overwrite.
    document.getElementById( 'replaceOptWrap' ).hidden = allCollide;
    document.getElementById( 'replaceOverwrite' ).checked = allCollide;

    const confirmBtn = document.getElementById( 'replaceConfirmBtn' );
    confirmBtn.title = allCollide ? T( 'drive.replace' ) : T( 'drive.continue' );
    confirmBtn.setAttribute( 'aria-label', confirmBtn.title );

    setBackdrop( 'replaceBackdrop', true );

    return new Promise( function( resolve ) { replaceResolver = resolve; } );
}

function settleReplace( choice )
{
    setBackdrop( 'replaceBackdrop', false );
    const r = replaceResolver;
    replaceResolver = null;
    if( r ) r( choice );
}

//------------------------------------------------------------------------//
// UPLOAD: CONVERT TO MP4. A video no browser can play is offered for
// conversion on the server before it is sent (server/go/convert.go; plan
// in docs/avi-to-mp4.md). The server queues it, one film at a time, and
// pushes a notification when it is done; meanwhile the row shows "En
// cola" / "Convirtiendo… 42 %".

// Keep the same list as convertExts in server/go/convert.go.
const CONVERT_EXT = [ 'avi', 'divx', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'vob',
                      'ts', 'm2ts', 'mts', '3gp', 'rm', 'rmvb', 'ogm', 'mkv', 'mov' ];

function isConvertible( path )
{
    const dot = path.lastIndexOf( '.' );
    return dot > path.lastIndexOf( '/' ) &&
           CONVERT_EXT.indexOf( path.slice( dot + 1 ).toLowerCase() ) !== -1;
}

async function getJson( url )
{
    try { return JSON.parse( await GumApi.fetchText( url ) ); }
    catch( _ ) { return null; }
}

let convertResolver = null;

// 'convert' | 'plain' | 'cancel'. No dialog at all ('plain') when the
// server has no ffmpeg: then there is nothing to offer.
async function askConvert( videos )
{
    const st = await getJson( '/api/convert' );
    if( ! st || ! st.available ) return 'plain';

    // "te avisaremos" must not be a lie: warn when NO device of this
    // user has notifications on (per user - a phone may have them).
    const push = await getJson( '/api/push' );
    document.getElementById( 'convertNoPush' ).hidden = !! ( push && push.count > 0 );

    const ul = document.getElementById( 'convertList' );
    ul.innerHTML = '';
    const SHOWN = 12;
    videos.slice( 0, SHOWN ).forEach( function( it )
    {
        const li = document.createElement( 'li' );
        li.textContent = it.relPath;
        li.title = it.relPath;
        ul.appendChild( li );
    });
    if( videos.length > SHOWN )
    {
        const li = document.createElement( 'li' );
        li.textContent = TF( 'drive.andNMore', { n: videos.length - SHOWN } );
        ul.appendChild( li );
    }

    setBackdrop( 'convertBackdrop', true );
    return new Promise( function( resolve ) { convertResolver = resolve; } );
}

function settleConvert( choice )
{
    setBackdrop( 'convertBackdrop', false );
    const r = convertResolver;
    convertResolver = null;
    if( r ) r( choice );
}

let convertJobs  = new Map();     // path -> { state, percent }: this user's queue
let convertTimer = null;

function convertLabel( job )
{
    return job.state === 'running' ? TF( 'drive.convertRunning', { pct: job.percent || 0 } )
                                   : T( 'drive.convertQueued' );
}

// The "En cola" / "Convirtiendo… %" badge at the front of a row's meta.
// Called by buildListRow and by every poll.
function paintConvertBadge( row )
{
    const job   = convertJobs.get( row.dataset.path );
    const meta  = row.querySelector( '.row-meta' );
    let   badge = row.querySelector( '.row-convert' );
    if( ! job || ! meta ) { if( badge ) badge.remove(); return; }
    if( ! badge )
    {
        badge = document.createElement( 'span' );
        badge.className = 'row-convert';
        meta.insertBefore( badge, meta.firstChild );
    }
    badge.textContent = convertLabel( job );
}

// Every 5 s while this user has a job. When one ends, the listing is
// reloaded: the mp4 has appeared and the original gone to the papelera.
async function pollConvert()
{
    convertTimer = null;
    const st = await getJson( '/api/convert' );
    if( st )
    {
        const before = convertJobs;
        convertJobs = new Map( ( st.jobs || [] ).map( function( j ) { return [ j.path, j ]; } ) );

        let ended = false;
        before.forEach( function( _, p ) { if( ! convertJobs.has( p ) ) ended = true; } );
        if( ended ) await reload();
        else document.querySelectorAll( '#listing .row[data-path]' ).forEach( paintConvertBadge );
    }
    if( convertJobs.size && ! convertTimer ) convertTimer = setTimeout( pollConvert, 5000 );
}

function startConvertPoll()
{
    if( convertTimer ) clearTimeout( convertTimer );
    convertTimer = setTimeout( pollConvert, 800 );
}

//------------------------------------------------------------------------//
// APP IMPORTS: a .ics / .vcf dropped at the top level of an upload is merged
// into the Calendar (data/calendar.ics) / Contacts (data/contacts.vcf) file
// instead of being stored as a plain file in the tree.

function isAppImport( it )
{
    if( it.relPath.indexOf( '/' ) !== -1 ) return false;     // part of a folder upload — leave it
    const n = it.relPath.toLowerCase();
    return n.endsWith( '.ics' ) || n.endsWith( '.vcf' );
}

async function readTextOrEmpty( path )
{
    try { return await GumApi.readFile( path ); }
    catch( err )
    {
        if( /\b404\b/.test( String( err && err.message ) ) ) return '';
        throw err;
    }
}

// Unfold RFC 5545 / RFC 6350 continuation lines; normalise EOLs to \n.
function unfoldLines( text )
{
    return text.replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).replace( /\n[ \t]/g, '' );
}

// Every top-level BEGIN:<name> … END:<name> block, returned as CRLF strings.
function extractBlocks( rawText, name )
{
    const up    = 'BEGIN:' + name.toUpperCase();
    const lines = String( rawText || '' ).replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).split( '\n' );
    const out   = [];
    let   buf   = null, depth = 0;

    for( const line of lines )
    {
        const t = line.trim().toUpperCase();

        if( ! buf )
        {
            if( t === up ) { buf = [ line.trim() ]; depth = 1; }
            continue;
        }

        buf.push( line.trim() );
        if( t.indexOf( 'BEGIN:' ) === 0 )      depth++;
        else if( t.indexOf( 'END:' ) === 0 )
        {
            depth--;
            if( depth === 0 ) { out.push( buf.join( '\r\n' ) ); buf = null; }
        }
    }
    return out;
}

// The value of a simple property (UID, TZID) from inside a block.
function blockProp( block, prop )
{
    const want = prop.toUpperCase();
    for( const l of unfoldLines( block ).split( '\n' ) )
    {
        const m = l.match( /^([^:;]+)(?:;[^:]*)?:(.*)$/ );
        if( m && m[ 1 ].trim().toUpperCase() === want ) return m[ 2 ].trim();
    }
    return '';
}

async function mergeIntoContacts( incomingText )
{
    const incoming = extractBlocks( incomingText, 'VCARD' );
    if( ! incoming.length ) throw new Error( T( 'drive.noContactsInFile' ) );

    const blocks = extractBlocks( await readTextOrEmpty( 'data/contacts.vcf' ), 'VCARD' );
    const byUid  = new Map();
    blocks.forEach( function( b, i ) { const u = blockProp( b, 'UID' ); if( u ) byUid.set( u, i ); } );

    for( const b of incoming )
    {
        const u = blockProp( b, 'UID' );
        if( u && byUid.has( u ) ) blocks[ byUid.get( u ) ] = b;
        else { blocks.push( b ); if( u ) byUid.set( u, blocks.length - 1 ); }
    }

    await GumApi.writeFileBytes( 'data/contacts.vcf',
        new TextEncoder().encode( blocks.join( '\r\n' ) + '\r\n' ) );
    return incoming.length;
}

async function mergeIntoCalendar( incomingText )
{
    const events = extractBlocks( incomingText, 'VEVENT' );
    const zones  = extractBlocks( incomingText, 'VTIMEZONE' );
    if( ! events.length ) throw new Error( T( 'drive.noEventsInFile' ) );

    let existing = await readTextOrEmpty( 'data/calendar.ics' );
    if( ! /BEGIN:VCALENDAR/i.test( existing ) )
        existing = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mingle//Personal Calendar//EN\r\nEND:VCALENDAR\r\n';

    const exEvents = extractBlocks( existing, 'VEVENT' );
    const exZones  = extractBlocks( existing, 'VTIMEZONE' );

    const byUid = new Map();
    exEvents.forEach( function( b, i ) { const u = blockProp( b, 'UID' ); if( u ) byUid.set( u, i ); } );
    for( const b of events )
    {
        const u = blockProp( b, 'UID' );
        if( u && byUid.has( u ) ) exEvents[ byUid.get( u ) ] = b;
        else { exEvents.push( b ); if( u ) byUid.set( u, exEvents.length - 1 ); }
    }

    const haveTz = new Set( exZones.map( function( b ) { return blockProp( b, 'TZID' ); } ) );
    for( const b of zones )
    {
        const id = blockProp( b, 'TZID' );
        if( ! haveTz.has( id ) ) { exZones.push( b ); haveTz.add( id ); }
    }

    // Keep the existing VCALENDAR header lines, replace the body.
    const head = [];
    for( const raw of existing.replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).split( '\n' ) )
    {
        const t = raw.trim().toUpperCase();
        if( ! t ) continue;
        if( t === 'BEGIN:VCALENDAR' ) { head.push( 'BEGIN:VCALENDAR' ); continue; }
        if( t.indexOf( 'BEGIN:' ) === 0 || t.indexOf( 'END:' ) === 0 ) break;   // body / footer reached
        if( head.length ) head.push( raw.trim() );
    }
    if( ! head.length ) head.push( 'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mingle//Personal Calendar//EN' );

    const out = head.concat( exZones, exEvents, [ 'END:VCALENDAR' ] ).join( '\r\n' ) + '\r\n';
    await GumApi.writeFileBytes( 'data/calendar.ics', new TextEncoder().encode( out ) );
    return events.length;
}

async function runAppImports( imports )
{
    let calEvents = 0, calFiles = 0, conCards = 0, conFiles = 0;
    const failed = [];

    for( const it of imports )
    {
        setStatus( TF( 'drive.importing', { name: it.relPath } ) );
        const isIcs = it.relPath.toLowerCase().endsWith( '.ics' );
        try
        {
            const text = await it.file.text();
            if( isIcs ) { calEvents += await mergeIntoCalendar( text ); calFiles++; }
            else        { conCards  += await mergeIntoContacts( text ); conFiles++; }
        }
        catch( err )
        {
            failed.push( it.relPath + ( err && err.message ? ' (' + err.message + ')' : '' ) );
        }
    }

    const done = [];
    if( calFiles ) done.push( TF( calEvents === 1 ? 'drive.oneEventTo' : 'drive.nEventsTo', { n: calEvents } ) );
    if( conFiles ) done.push( TF( conCards  === 1 ? 'drive.oneContactTo' : 'drive.nContactsTo', { n: conCards } ) );
    if( done.length ) NayiveUI.toast( TF( 'drive.imported', { what: done.join( T( 'drive.and' ) ) } ) );
    if( failed.length ) NayiveUI.alert( { title: T( 'drive.importFailedTitle' ), body: failed.join( '\n' ) } );
}

// "album/foto.HEIC" + "foto.jpg" -> "album/foto.jpg", and never onto a
// name that is already taken: a photo converted to .jpg lands on a name
// the collision question at the top of uploadItems never asked about,
// so it gets "(copia)" instead of overwriting anything.
// `used` holds the paths this same batch has already written. Like the
// collision check itself, currentChild() only knows the folder on
// screen, so inside a dragged-in sub-folder only `used` protects.
function renameTo( relPath, name, used )
{
    const i    = relPath.lastIndexOf( '/' );
    const dir  = i < 0 ? '' : relPath.slice( 0, i + 1 );
    // uniqueName() only ever calls taken.has(), so a small object with
    // that one method does the job of a Set here.
    const taken = { has: n => !! currentChild( dir + n ) || used.has( dir + n ) };
    return dir + uniqueName( name, taken );
}

// The name an upload would overwrite in the folder on screen: the file
// itself, or - for a LibreOffice document - its twin. '' when nothing.
function clashName( it )
{
    const node = currentChild( it.relPath );
    if( node && ! isDir( node ) ) return it.relPath;
    const twin = officeTwinRel( it.relPath );
    const tn   = twin && currentChild( twin );
    return tn && ! isDir( tn ) ? twin : '';
}

async function uploadItems( items )
{
    if( ! items.length ) return;

    // LibreOffice kinds with no app here (Impress, Draw, Math, Base) are
    // refused, all named in one message; the rest goes on. `notes` are
    // said again in the last message, so a long upload cannot bury them.
    const notes   = [];
    const refused = items.filter( function( it ) { return officeKind( extOf( it.relPath ) ) === 'refuse'; } );
    if( refused.length )
    {
        items = items.filter( function( it ) { return refused.indexOf( it ) === -1; } );
        notes.push( TF( 'drive.officeRefused',
                        { names: refused.map( function( it ) { return it.relPath.split( '/' ).pop(); } ).join( ', ' ) } ) );
        NayiveUI.toast( notes[0], { ms: 6000 } );
        if( ! items.length ) return;
    }

    // Pull out .ics / .vcf files — they go to Calendar / Contacts, not the tree.
    const imports = items.filter( isAppImport );
    if( imports.length )
    {
        items = items.filter( function( it ) { return ! isAppImport( it ); } );
        await runAppImports( imports );
        if( ! items.length ) { setStatus( '' ); await reload(); return; }
    }

    // Warn before overwriting anything that already exists at the destination.
    // A LibreOffice document also lands its twin ("x.odt" -> "x.docx"), so
    // a twin already here is a clash too - see clashName.
    const collisions = items.filter( function( it ) { return !! clashName( it ); } );

    if( collisions.length )
    {
        const choice = await askReplace( collisions, items.length );

        if( choice === 'cancel' ) { setStatus( '' ); return; }

        if( choice === 'skip' )
        {
            const drop = new Set( collisions );
            items = items.filter( function( it ) { return ! drop.has( it ); } );
            if( ! items.length ) { setStatus( '' ); return; }
        }
        // choice === 'overwrite': fall through with every item
    }

    // Videos a browser cannot play (.avi, .wmv, ...): offer to turn them
    // into an .mp4 on the server, BEFORE anything is sent. Never inside a
    // shared folder: the job ends by moving the original to the papelera.
    let toConvert = new Set();
    const inSharedDir = currentFolder === 'shared' || currentFolder.indexOf( 'shared/' ) === 0;
    const videos      = inSharedDir ? [] : items.filter( function( it ) { return isConvertible( it.relPath ); } );
    if( videos.length )
    {
        const choice = await askConvert( videos );
        if( choice === 'cancel' ) { setStatus( '' ); return; }
        if( choice === 'convert' ) toConvert = new Set( videos );
    }
    let converting = 0;
    const toOffice = [];    // LibreOffice documents sent: their twins are made after the upload

    // Quota check: refuse the whole batch up-front if it would not fit.
    // ensureRoom() offers to empty the papelera when that alone would
    // make room. (The server enforces the quota too; this is just a
    // friendlier message before a long upload.)
    let need = 0;
    for( const it of items )
    {
        need += it.file.size;
        if( toConvert.has( it ) ) need += it.file.size;   // the mp4 sits beside it until done
        if( officeTwinRel( it.relPath ) ) need += it.file.size;   // its twin, about as big
        const node = currentChild( it.relPath );
        if( node && ! isDir( node ) && node.size ) need -= node.size;   // overwrite frees the old bytes
    }
    if( ! await NayiveUI.ensureRoom( need ) ) { setStatus( '' ); return; }

    // If this user has a max photo size, images are shrunk to it and
    // turned into JPEG here, in the browser, before being sent.
    const maxPx = await NayivePhoto.limit();
    const used  = new Set();          // paths already written by this batch

    // Create every directory that appears in the item paths, shallow first.
    const dirs = new Set();
    for( const it of items )
    {
        const segs = it.relPath.split( '/' );
        let acc = '';
        for( let i = 0; i < segs.length - 1; i++ )
        {
            acc = acc ? acc + '/' + segs[i] : segs[i];
            dirs.add( acc );
        }
    }

    const sorted = Array.from( dirs ).sort( function( a, b ) { return a.split( '/' ).length - b.split( '/' ).length; } );

    for( const d of sorted )
    {
        const segs   = d.split( '/' );
        const name   = segs.pop();
        const parent = joinPath( currentFolder, segs.join( '/' ) );
        setStatus( T( 'drive.creatingFolders' ) );
        try { await withBusy( GumApi.makeDir( parent, name ) ); }
        catch( _ ) { /* already exists — fine */ }
    }

    for( let i = 0; i < items.length; i++ )
    {
        const it = items[i];
        setStatus( TF( 'photos.uploadingN', { i: i + 1, n: items.length } ) );

        try
        {
            // No limit, or not a photo -> ready.blob IS it.file.
            const ready   = await NayivePhoto.prepare( it.file, maxPx );
            const relPath = ready.changed && ready.name !== it.file.name
                          ? renameTo( it.relPath, ready.name, used )
                          : it.relPath;
            used.add( relPath );
            const path    = joinPath( currentFolder, relPath );

            // Send the Blob itself: the browser streams it from disk.
            // Reading it into memory first crashed the tab on big files.
            const conv = toConvert.has( it );
            await withBusy( GumApi.writeFileBytes( path, ready.blob, conv ? { convert: 'mp4' } : null ) );
            if( conv ) converting++;
            if( officeTwinRel( relPath ) ) toOffice.push( { path: path, name: relPath.split( '/' ).pop() } );
        }
        catch( err )
        {
            if( String( err && err.message ).indexOf( '507' ) >= 0 )
            {
                NayiveUI.toast( TF( 'drive.uploadQuota', { name: it.relPath } ) );
                break;
            }
            NayiveUI.toast( TF( 'drive.uploadFailed', { name: it.relPath } ) );
        }
    }

    // LibreOffice documents: now their Microsoft Office twins, beside
    // them - one at a time, as the server does them anyway.
    if( toOffice.length )
    {
        NayiveUI.toast( T( 'drive.officeStart' ), { ms: 4000 } );
        const done = [], failed = [];
        let   off  = false;
        for( let i = 0; i < toOffice.length && ! off; i++ )
        {
            setStatus( TF( 'drive.officeConvertingN', { i: i + 1, n: toOffice.length } ) );
            try { await officeTwin( toOffice[i].path, true ); done.push( toOffice[i].name ); }
            catch( err )
            {
                if( String( err && err.message ).indexOf( '503' ) >= 0 ) off = true;   // no LibreOffice: none will
                else failed.push( toOffice[i].name );
            }
        }
        if( off )                  notes.push( T( 'drive.officeOffUpload' ) );
        else if( failed.length )   notes.push( TF( 'drive.officeFailedN', { names: failed.join( ', ' ) } ) );
        else if( done.length > 1 ) notes.push( TF( 'drive.officeConvertedN', { n: done.length } ) );
        else                       notes.push( TF( 'drive.officeConverted', { name: officeTwinRel( done[0] ) } ) );
    }

    setStatus( '' );
    await reload();
    // Ask the server rather than trust the count: it may have refused to
    // queue (ffmpeg gone meanwhile), and the PUT's answer is not read.
    if( converting )
    {
        const st = await getJson( '/api/convert' );
        if( st && st.jobs && st.jobs.length )
        {
            if( notes.length ) notes.push( T( 'drive.convertStarted' ) );
            else               NayiveUI.toast( T( 'drive.convertStarted' ) );
            startConvertPoll();
        }
    }
    // One message with all of it: a toast replaces the one before.
    if( notes.length ) NayiveUI.toast( notes.join( ' ' ), { ms: 4000 + 2000 * notes.length } );
}
