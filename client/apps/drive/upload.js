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
        const shown = it.clash || it.relPath;   // a twin's name, when it is the twin that clashes
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
// APP IMPORTS: a .ics / .vcf dropped at the top level of an upload may be
// merged into the Calendar (data/calendar.ics) / Contacts (data/contacts.vcf)
// file instead of being stored as a plain file in the tree. Drive asks each
// time (askAppImport): add, or keep as a file.

function isAppImport( it )
{
    if( it.relPath.indexOf( '/' ) !== -1 ) return false;     // part of a folder upload — leave it
    const n = it.relPath.toLowerCase();
    return n.endsWith( '.ics' ) || n.endsWith( '.vcf' );
}

// calendar.ics / contacts.vcf are read and written through the same store
// Calendar and Contacts use. Its read sees an edit an open Calendar has queued
// but not sent yet, and the merged file then takes that queued write's place
// in the shared outbox (one per path). A direct PUT raced it instead: the
// queued write went up after the merge and took the imported events away.
let appFileStore = null;

function appStore()
{
    return appFileStore || ( appFileStore = NayiveStore.createStore( { apiBase: GumApi.API_FILES } ) );
}

async function readTextOrEmpty( path )
{
    const res = await appStore().read( path );
    if( res.source === 'empty' ) return '';                            // no such file yet
    if( res.body === null ) throw new Error( T( 'ui.store.notRead' ) );  // never merge into nothing
    return res.body;
}

// Written as text, the way Calendar and Contacts write it. Offline, or any
// answer the store keeps the write for, is queued and goes up later: only a
// write it refuses or drops is a failure.
async function writeAppFile( path, text )
{
    const res = await appStore().write( path, text );
    if( res.blocked )   throw new Error( T( 'ui.store.notRead' ) );
    if( res.forbidden ) throw new Error( 'HTTP 403' );
}

// Unfold RFC 5545 / RFC 6350 continuation lines; normalise EOLs to \n.
function unfoldLines( text )
{
    return text.replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).replace( /\n[ \t]/g, '' );
}

// Every top-level BEGIN:<name> … END:<name> block, returned as CRLF strings.
// Lines are kept exactly as they are: a leading space or tab marks a folded
// line (RFC 5545 / 6350), and trimming it cut every long line of the file -
// a note, the rest of an address, a PHOTO. A folded line is never a BEGIN / END.
function extractBlocks( rawText, name )
{
    const up    = 'BEGIN:' + name.toUpperCase();
    const lines = String( rawText || '' ).replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).split( '\n' );
    const out   = [];
    let   buf   = null, depth = 0;

    for( const line of lines )
    {
        const t = /^[ \t]/.test( line ) ? '' : line.trim().toUpperCase();

        if( ! buf )
        {
            if( t === up ) { buf = [ line ]; depth = 1; }
            continue;
        }

        buf.push( line );
        if( t.indexOf( 'BEGIN:' ) === 0 )      depth++;
        else if( t.indexOf( 'END:' ) === 0 )
        {
            depth--;
            if( depth === 0 ) { out.push( buf.join( '\r\n' ) ); buf = null; }
        }
    }
    return out;
}

// The value of a simple property (UID, TZID, RECURRENCE-ID) of a block - its
// own, not one of a component inside it (a VALARM may carry a UID too).
function blockProp( block, prop )
{
    const want = prop.toUpperCase();
    let   depth = 0;
    for( const l of unfoldLines( block ).split( '\n' ) )
    {
        const m = l.match( /^([^:;]+)(?:;[^:]*)?:(.*)$/ );
        if( ! m ) continue;
        const name = m[ 1 ].trim().toUpperCase();
        if( name === 'BEGIN' ) { depth++; continue; }
        if( name === 'END' )   { depth--; continue; }
        if( depth === 1 && name === want ) return m[ 2 ].trim();
    }
    return '';
}

// An event's identity: its UID plus its RECURRENCE-ID. A moved occurrence of a
// repeating event carries the series' UID; by UID alone it replaced the series.
function eventKey( block )
{
    return blockProp( block, 'UID' ) + '\n' + blockProp( block, 'RECURRENCE-ID' );
}

// The cards are told apart as Contacts tells them (shared/vcard.js): each is
// kept as the text it is in the file, and a card dropped again (same UID)
// takes its old one's place.
async function mergeIntoContacts( incomingText )
{
    const incoming = NayiveVCard.cards( incomingText ) || [];
    if( ! incoming.length ) throw new Error( T( 'drive.noContactsInFile' ) );

    const book   = NayiveVCard.cards( await readTextOrEmpty( 'data/contacts.vcf' ) ) || [];
    const blocks = book.map( function( c ) { return c.text; } );
    const byUid  = new Map();
    book.forEach( function( c, i ) { if( c.uid ) byUid.set( c.uid, i ); } );

    for( const c of incoming )
    {
        const u = c.uid;
        if( u && byUid.has( u ) ) blocks[ byUid.get( u ) ] = c.text;
        else { blocks.push( c.text ); if( u ) byUid.set( u, blocks.length - 1 ); }
    }

    await writeAppFile( 'data/contacts.vcf', blocks.join( '\r\n' ) + '\r\n' );
    return incoming.length;
}

async function mergeIntoCalendar( incomingText )
{
    const events = extractBlocks( incomingText, 'VEVENT' );
    const zones  = extractBlocks( incomingText, 'VTIMEZONE' );
    if( ! events.length ) throw new Error( T( 'drive.noEventsInFile' ) );

    let existing = await readTextOrEmpty( 'data/calendar.ics' );
    if( ! /BEGIN:VCALENDAR/i.test( existing ) )
        existing = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Nayive//Personal Calendar//EN\r\nEND:VCALENDAR\r\n';

    // The existing file stays as it is, line for line - its header, a VTODO,
    // anything else Drive does not know: an event dropped again (same UID and
    // RECURRENCE-ID) takes its old one's place, a new one goes in before the
    // last END:VCALENDAR, a new VTIMEZONE before the first event.
    const eol   = /\r\n/.test( existing ) ? '\r\n' : '\n';
    const lines = existing.replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).split( '\n' );
    const at    = new Map();          // eventKey -> [ first, last ] line of an existing top-level VEVENT
    const haveTz = new Set();
    let   depth = 0, start = -1, kind = '', firstEvent = -1, calEnd = -1;

    for( let i = 0; i < lines.length; i++ )
    {
        const m = /^[ \t]/.test( lines[ i ] ) ? null : /^(BEGIN|END):\s*([^\s;:]+)\s*$/i.exec( lines[ i ].trim() );
        if( ! m ) continue;

        const tag = m[ 2 ].toUpperCase();
        if( m[ 1 ].toUpperCase() === 'BEGIN' )
        {
            if( ++depth === 2 ) { start = i; kind = tag; if( tag === 'VEVENT' && firstEvent < 0 ) firstEvent = i; }
            continue;
        }

        if( depth === 2 && start >= 0 )
        {
            const block = lines.slice( start, i + 1 ).join( '\n' );
            if( kind === 'VEVENT' && blockProp( block, 'UID' ) && ! at.has( eventKey( block ) ) ) at.set( eventKey( block ), [ start, i ] );
            if( kind === 'VTIMEZONE' ) haveTz.add( blockProp( block, 'TZID' ) );
            start = -1;
        }
        if( depth === 1 && tag === 'VCALENDAR' ) calEnd = i;
        depth--;
    }

    const replace = new Map();        // first line of an existing event -> { last, text }
    const added   = [];
    const addedAt = new Map();        // eventKey -> index in `added` (the same event twice in one file: the last wins)
    for( const b of events )
    {
        const k = eventKey( b ), has = !! blockProp( b, 'UID' );
        if( has && at.has( k ) )           replace.set( at.get( k )[ 0 ], { last: at.get( k )[ 1 ], text: b } );
        else if( has && addedAt.has( k ) ) added[ addedAt.get( k ) ] = b;
        else { if( has ) addedAt.set( k, added.length ); added.push( b ); }
    }

    const newZones = zones.filter( function( b )
    {
        const id = blockProp( b, 'TZID' );
        if( haveTz.has( id ) ) return false;
        haveTz.add( id );
        return true;
    } );

    const out     = [];
    const zonesAt = firstEvent >= 0 ? firstEvent : calEnd;
    for( let i = 0; i < lines.length; i++ )
    {
        if( i === zonesAt ) out.push( ...newZones );
        if( i === calEnd )  out.push( ...added );

        const r = replace.get( i );
        if( r ) { out.push( r.text ); i = r.last; continue; }
        out.push( lines[ i ] );
    }
    if( calEnd < 0 )                  // a file that never closed its VCALENDAR
    {
        while( out.length && out[ out.length - 1 ] === '' ) out.pop();
        out.push( ...( zonesAt < 0 ? newZones : [] ), ...added, 'END:VCALENDAR', '' );
    }

    const text = out.join( '\n' ).replace( /\r\n/g, '\n' ).replace( /\n/g, eol );
    await writeAppFile( 'data/calendar.ics', /\n$/.test( text ) ? text : text + eol );
    return events.length;
}

// Add to Calendar / Contacts, or keep as a file? One question for every
// .ics / .vcf in the drop. Resolves true (add), "other" (keep as files) or
// false (cancel, or Escape: the whole upload stops, as askReplace's cancel).
function askAppImport( imports )
{
    const ics  = imports.some( function( it ) { return /\.ics$/i.test( it.relPath ); } );
    const vcf  = imports.some( function( it ) { return /\.vcf$/i.test( it.relPath ); } );
    const app  = ics && vcf ? 'Calendar' + T( 'drive.and' ) + 'Contacts' : ( ics ? 'Calendar' : 'Contacts' );

    const SHOWN = 12;
    const names = imports.slice( 0, SHOWN ).map( function( it ) { return it.relPath; } );
    if( imports.length > SHOWN ) names.push( TF( 'drive.andNMore', { n: imports.length - SHOWN } ) );

    return NayiveUI.confirm( {
        title:     TF( 'drive.importAskTitle', { app: app } ),
        body:      names.join( '\n' ) + '\n\n' + TF( 'drive.importAskBody', { app: app } ),
        confirm:   T( 'drive.importAdd' ),
        other:     T( 'drive.importKeep' ),
        otherIcon: 'doc' } );
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
// `used` holds the paths this same batch has already written; `there` the
// files at the destination (filesThere).
function renameTo( relPath, name, used, there )
{
    const i    = relPath.lastIndexOf( '/' );
    const dir  = i < 0 ? '' : relPath.slice( 0, i + 1 );
    // uniqueName() only ever calls taken.has(), so a small object with
    // that one method does the job of a Set here.
    const taken = { has: n => there.has( dir + n ) || used.has( dir + n ) };
    return dir + uniqueName( name, taken );
}

// THE FILES AT THE DESTINATION, AS THE SERVER HAS THEM NOW (D1, D3 -
// drive-files #1, #2): the open folder's own files, and every file inside
// each dropped top folder, at any depth. A Map relPath -> size. Read fresh,
// never from the listing on screen: that one knew only the open folder's
// top level - so a folder dropped again replaced every same-named file in
// it with no question - and it misses what another device put there since.
// null when a folder cannot be read: then nothing is sent (a 404 is a top
// folder that is not there yet, so it holds nothing).
async function filesThere( items )
{
    const there  = new Map();
    const prefix = currentFolder ? currentFolder + '/' : '';
    const add = function( nodes )
    {
        ( nodes || [] ).forEach( function( n )
        {
            if( isDir( n ) ) add( n.nodes );
            else if( n.path.indexOf( prefix ) === 0 ) there.set( n.path.slice( prefix.length ), n.size || 0 );
        } );
    };

    const tops = new Set();
    items.forEach( function( it ) { const i = it.relPath.indexOf( '/' ); if( i > 0 ) tops.add( it.relPath.slice( 0, i ) ); } );

    try
    {
        add( ( await withBusy( GumApi.listDir( currentFolder ) ) ).nodes );     // one level: its sub-folders come back empty
        for( const top of tops )
        {
            try { add( ( await withBusy( GumApi.listDirRecursive( joinPath( currentFolder, top ) ) ) ).nodes ); }
            catch( err ) { if( ! err || err.status !== 404 ) throw err; }
        }
    }
    catch( _ ) { return null; }
    return there;
}

// What an upload item would land on at the destination: the file itself,
// and - for a LibreOffice document - its twin. Kept on the item, for the
// question (askReplace shows it.clash) and for what "Replace" may replace.
// Returns the name to show, '' when nothing clashes.
function markClash( it, there )
{
    const twin = officeTwinRel( it.relPath );
    it.fileThere = there.has( it.relPath );
    it.twinThere = !! twin && there.has( twin );
    it.clash     = it.fileThere ? it.relPath : ( it.twinThere ? twin : '' );
    return it.clash;
}

// createFileBytes with Drive's "&convert=mp4": the same create-only PUT
// (If-None-Match: *, a 412 when the name is taken), plus the query.
function createUpload( path, blob, conv )
{
    if( ! conv ) return GumApi.createFileBytes( path, blob );
    return GumApi.putBinary( GumApi.fileUrl( path ) + '&convert=mp4', blob, { 'If-None-Match': '*' } )
                 .then( function() { GumApi.announce( [ path ], false ); } );
}

// A 412 can be this upload's own first try: putBinary sends again after a
// dropped connection, and the first one may have landed. The same size there
// - and the same bytes, when small enough to read back - is that, not a file
// someone else put there.
const SAME_CHECK_MAX = 8 * 1024 * 1024;

async function sameAsSent( path, blob )
{
    try
    {
        const i = path.lastIndexOf( '/' );
        const r = await withBusy( GumApi.listDir( i < 0 ? '' : path.slice( 0, i ) ) );
        const n = ( r.nodes || [] ).find( function( x ) { return x.path === path; } );
        if( ! n || isDir( n ) || n.size !== blob.size ) return false;
        if( blob.size > SAME_CHECK_MAX ) return true;
        const have = await withBusy( GumApi.readFileBytes( path ) );
        const mine = new Uint8Array( await blob.arrayBuffer() );
        if( have.length !== mine.length ) return false;
        for( let k = 0; k < have.length; k++ ) if( have[ k ] !== mine[ k ] ) return false;
        return true;
    }
    catch( _ ) { return false; }
}

// A name free in relPath's folder NOW (a fresh listing) and not written by
// this batch: "x (copia).jpg", "x (copia 2).jpg"...
async function freeRel( relPath, used )
{
    const i      = relPath.lastIndexOf( '/' );
    const dir    = i < 0 ? '' : relPath.slice( 0, i + 1 );
    const parent = dir ? joinPath( currentFolder, dir.slice( 0, -1 ) ) : currentFolder;
    const r      = await withBusy( GumApi.listDir( parent ) );
    const names  = new Set( ( r.nodes || [] ).map( function( n ) { return n.path.split( '/' ).pop(); } ) );
    return dir + uniqueName( relPath.slice( i + 1 ), { has: n => names.has( n ) || used.has( dir + n ) } );
}

// Sends a file the user did NOT say "Replace" to: it may only make a new
// file. A 412 is a name taken since filesThere looked (another device or
// window), or this very upload's first try (sameAsSent). The user then
// picks: replace it, or keep both - this one goes up as "x (copia).jpg".
// Resolves the relPath it was saved under; null when the user cancels (the
// rest of the upload stops too).
async function sendNew( relPath, blob, conv, used )
{
    for( ;; )
    {
        const path = joinPath( currentFolder, relPath );
        try { await withBusy( createUpload( path, blob, conv ) ); return relPath; }
        catch( err ) { if( ! err || err.status !== 412 ) throw err; }

        if( await sameAsSent( path, blob ) ) return relPath;

        const choice = await NayiveUI.confirm( {
            title:     T( 'drive.alreadyExistOne' ),
            body:      TF( 'drive.appearedBody', { name: relPath } ),
            confirm:   T( 'drive.replace' ), danger: true,
            other:     T( 'drive.keepBoth' ),
            otherIcon: 'copy' } );
        if( choice === false ) return null;
        if( choice === true )
        {
            await withBusy( GumApi.writeFileBytes( path, blob, conv ? { convert: 'mp4' } : null ) );
            return relPath;
        }
        relPath = await freeRel( relPath, used );
        used.add( relPath );
    }
}

async function uploadItems( items )
{
    if( ! items.length ) return;

    // `notes` are said again in the last message, so a long upload cannot
    // bury them. LibreOffice kinds with no app here (Impress, Draw, Math,
    // Base) upload as they are: only Writer and Calc files get a twin.
    const notes   = [];

    // .ics / .vcf files: ONE question for all of them - add them to
    // Calendar / Contacts, or keep them as files (they then go on with the
    // rest, as any other file).
    const imports = items.filter( isAppImport );
    if( imports.length )
    {
        const choice = await askAppImport( imports );
        if( choice === false ) { setStatus( '' ); return; }        // cancel: nothing is uploaded

        if( choice === true )
        {
            items = items.filter( function( it ) { return ! isAppImport( it ); } );
            await runAppImports( imports );
            if( ! items.length ) { setStatus( '' ); await reload(); return; }
        }
    }

    // Warn before overwriting anything that already exists at the destination.
    // A LibreOffice document also lands its twin ("x.odt" -> "x.docx"), so
    // a twin already here is a clash too - see markClash.
    const there = await filesThere( items );
    if( ! there ) { setStatus( '' ); NayiveUI.toast( T( 'drive.checkDestFailed' ), { ms: 6000 } ); return; }
    const collisions = items.filter( function( it ) { return !! markClash( it, there ); } );

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
        // "Replace" replaces exactly what the question listed - the file, and
        // the twin that was there. Everything else goes up create-only (sendNew).
        else collisions.forEach( function( it ) { it.replaceFile = it.fileThere; it.replaceTwin = it.twinThere; } );
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
        if( it.replaceFile ) need -= there.get( it.relPath ) || 0;   // overwrite frees the old bytes
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
        setStatus( TF( 'drive.uploadingOf', { i: i + 1, n: items.length } ) );   // the bar beside it already says "Uploading"

        try
        {
            // No limit, or not a photo -> ready.blob IS it.file.
            const ready   = await NayivePhoto.prepare( it.file, maxPx );
            let   relPath = ready.changed && ready.name !== it.file.name
                          ? renameTo( it.relPath, ready.name, used, there )
                          : it.relPath;
            used.add( relPath );

            // Send the Blob itself: the browser streams it from disk.
            // Reading it into memory first crashed the tab on big files.
            // Only a file the user said "Replace" to is PUT over; any other
            // may only make a new file (sendNew): one that took the name
            // since the check is never written over (D1, D3).
            const conv    = toConvert.has( it );
            const replace = it.replaceFile && relPath === it.relPath;
            if( replace )
                await withBusy( GumApi.writeFileBytes( joinPath( currentFolder, relPath ), ready.blob, conv ? { convert: 'mp4' } : null ) );
            else
            {
                const got = await sendNew( relPath, ready.blob, conv, used );
                if( got === null ) break;               // cancelled: nothing more is sent
                relPath = got;
            }
            if( conv ) converting++;
            // Its twin replaces one only when "Replace" was said to it too.
            if( officeTwinRel( relPath ) )
                toOffice.push( { path: joinPath( currentFolder, relPath ), name: relPath.split( '/' ).pop(),
                                 replace: !! it.replaceTwin && relPath === it.relPath } );
        }
        catch( err )
        {
            if( err && err.status === 507 )
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
        const done = [], failed = [], kept = [];
        let   off  = false;
        for( let i = 0; i < toOffice.length && ! off; i++ )
        {
            setStatus( TF( 'drive.officeConvertingN', { i: i + 1, n: toOffice.length } ) );
            // Without `replace` an existing twin is the server's answer, left
            // as it is ("converted": false), and one that took the name while
            // LibreOffice ran is kept too (409, api_office.go): a twin the
            // user never said "Replace" to is never rebuilt over (D1).
            try
            {
                const r = await officeTwin( toOffice[i].path, toOffice[i].replace );
                if( r && r.converted === false ) kept.push( officeTwinRel( toOffice[i].name ) );
                else                             done.push( toOffice[i].name );
            }
            catch( err )
            {
                if( err && err.status === 503 )      off = true;   // no LibreOffice: none will
                else if( err && err.status === 409 ) kept.push( officeTwinRel( toOffice[i].name ) );
                else                                 failed.push( toOffice[i].name );
            }
        }
        if( off )                    notes.push( T( 'drive.officeOffUpload' ) );
        else if( failed.length )     notes.push( TF( 'drive.officeFailedN', { names: failed.join( ', ' ) } ) );
        else if( done.length > 1 )   notes.push( TF( 'drive.officeConvertedN', { n: done.length } ) );
        else if( done.length === 1 ) notes.push( TF( 'drive.officeConverted', { name: officeTwinRel( done[0] ) } ) );
        if( kept.length && ! off )   notes.push( TF( 'drive.officeTwinKept', { names: kept.join( ', ' ) } ) );
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
