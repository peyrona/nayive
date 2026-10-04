// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
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
//   names      - every file the upload would replace: each clashing file,
//                and each Office twin that is there, on a line of its own
//                (markClash) - "Replace" replaces exactly these
//   allCollide - every item of the upload clashes: nothing to skip to
function askReplace( names, allCollide )
{
    // One clash gets the singular title; data-i18n keeps it right on a language switch.
    const titleKey = names.length === 1 ? 'drive.alreadyExistOne' : 'drive.alreadyExist';
    const titleEl  = document.getElementById( 'replaceTitle' );
    titleEl.setAttribute( 'data-i18n', titleKey );
    titleEl.textContent = T( titleKey );

    document.getElementById( 'replaceMsg' ).textContent = names.length === 1
        ? T( 'drive.oneClash' )
        : TF( 'drive.nClashes', { n: names.length } );

    const ul = document.getElementById( 'replaceList' );
    ul.innerHTML = '';
    const SHOWN = 12;
    names.slice( 0, SHOWN ).forEach( function( shown )
    {
        const li = document.createElement( 'li' );
        li.textContent = shown;
        li.title = shown;
        ul.appendChild( li );
    });
    if( names.length > SHOWN )
    {
        const li = document.createElement( 'li' );
        li.textContent = TF( 'drive.andNMore', { n: names.length - SHOWN } );
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

// calendar.ics / contacts.vcf are read and written through the store Calendar
// and Contacts use (one outbox: a direct PUT raced a save an open Calendar
// had queued, and took the imported events away). Since 2026-10-02 (C1, A3,
// list-apps #2 #10, store-core #9) an import is made from the SERVER's copy,
// read fresh - never from the copy this device cached, nor the service
// worker's offline one: an old copy, sent later, dropped everything the
// phone added since. Offline, or with a Calendar save still waiting here, it
// is refused and says why (the file can still be kept as a plain file).
// It goes up checked against the version it was made from (If-Match). A
// save another device made in between answers 412: the store reads the file
// again and calls this page's merge, which makes the import again on that
// newer copy - an import is the same change made twice. Any other merge
// this page is asked for (a Calendar save it flushed for another page) is
// not Drive's to make: null - held back for its own app, which merges it
// when it next reads the file.
let appFileStore = null;
let importing    = null;    // the change being written: { path, bodies: Set of what it wrote, apply( text ) -> text }

function appStore()
{
    return appFileStore || ( appFileStore = NayiveStore.createStore( {
        apiBase: GumApi.API_FILES, conflicts: true,
        merge: function( path, base, mine, theirs )
        {
            if( ! importing || importing.path !== path || ! importing.bodies.has( mine ) ) return null;
            return importing.apply( theirs );
        } } ) );
}

// One change to an app's file. fn( text ) -> { text, changed, ... } is
// pure: it runs on the server's copy as read now ('' = no file yet), and
// again on a newer one after a 412. Resolves fn's answer that went up (or
// waits in the outbox, checked: the network dropped after the read); throws,
// writing nothing, when the server's copy cannot be read now or the change
// could not be kept. `app`: its name, for "open Calendar first".
async function updateAppFile( path, app, fn )
{
    const st = appStore();
    if( ! navigator.onLine ) throw new Error( T( 'drive.importOffline' ) );
    try { await st.flush(); } catch( e ) {}                     // what waits here goes first

    const res = await st.read( path );
    if( res.source !== 'network' && res.source !== 'empty' )
    {
        // A save of the app's still waiting here (its own merge to make), or
        // the server not reached: never an import onto that copy.
        let wait = null;
        try { wait = await st.pending( path ); } catch( e ) {}
        throw new Error( wait ? TF( 'drive.importWaiting', { app: app } ) : T( 'drive.importOffline' ) );
    }

    let job = fn( res.source === 'empty' ? '' : res.body );
    if( ! job.changed ) return job;

    const bodies = new Set( [ job.text ] );
    importing = { path: path, bodies: bodies, apply: function( theirs ) { job = fn( theirs ); bodies.add( job.text ); return job.text; } };
    let w;
    try { w = ( await st.write( path, job.text ) ) || {}; }
    finally { importing = null; }

    if( w.blocked )   throw new Error( T( 'ui.store.notRead' ) );
    if( w.forbidden ) throw new Error( 'HTTP 403' );
    // Kept only in this page (the browser's storage failed), or gone before
    // it was sent: NOT saved, never "imported". The page-only one is
    // withdrawn - it was made from the file the user still has - so a
    // second try starts clean.
    if( w.pageOnly || w.unknown )
    {
        if( w.pageOnly ) try { await st.forget( path ); } catch( e ) {}
        throw new Error( T( 'drive.importNotSaved' ) );
    }
    // Held back for the app's own merge (it went up beside a save of the
    // app's): kept in the outbox, merged when the app next reads the file.
    if( w.conflict ) throw new Error( TF( 'drive.importWaiting', { app: app } ) );
    return job;          // up - or queued with its check (offline since the read, a 5xx)
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

// Two blocks the same, whatever their line ends.
function sameBlock( a, b )
{
    return String( a ).replace( /\r\n?/g, '\n' ).replace( /\n+$/, '' ) === String( b ).replace( /\r\n?/g, '\n' ).replace( /\n+$/, '' );
}

// "2026-09-28T10:15:00Z" / "20260928T101500Z" -> 14 digits that compare as
// text; none = the oldest.
function stampKey( v )
{
    return String( v || '' ).replace( /\D/g, '' ).slice( 0, 14 ).padEnd( 14, '0' );
}

// The dropped copy of an event is NEWER than the one in the calendar: a
// higher SEQUENCE (an organiser's new version of an invitation), else at the
// same SEQUENCE a later LAST-MODIFIED - or DTSTAMP, which Calendar moves on
// at each edit (shared/ical.js stampOf: the rule its merge uses). The same
// or unknown is not newer: the calendar's stays (C2).
function eventNewer( dropped, have )
{
    const seq = function( b ) { return parseInt( blockProp( b, 'SEQUENCE' ), 10 ) || 0; };
    if( seq( dropped ) !== seq( have ) ) return seq( dropped ) > seq( have );
    const st = function( b ) { return stampKey( blockProp( b, 'LAST-MODIFIED' ) || blockProp( b, 'DTSTAMP' ) ); };
    return st( dropped ) > st( have );
}

// A card's REV, as Contacts reads it (contact/index.html revOf / revKey).
function cardRev( c ) { return stampKey( c.rev ); }

// The cards are told apart as Contacts tells them (shared/vcard.js): each is
// kept as the text it is in the file. A card dropped again (same UID) takes
// its old one's place only when it is NEWER - a later REV, as Contacts' own
// import: an old export dropped again never takes back the edits made since
// (C2). Pure (see updateAppFile): `book` is the file's text now.
// -> { text, changed, added: [ { uid, text } ], replaced: [ { uid, was, now } ], kept }
function addCards( book, incoming )
{
    const have = String( book || '' ).trim() ? NayiveVCard.cards( book ) : [];
    if( ! have ) throw new Error( T( 'ui.store.badFile' ) );       // text with no card in it: never written over

    const blocks = have.map( function( c ) { return c.text; } );
    const revs   = have.map( cardRev );
    const byUid  = new Map();
    have.forEach( function( c, i ) { if( c.uid ) byUid.set( c.uid, i ); } );
    const orig   = new Map();    // uid -> the block it had before this import (null: it is new)
    const named  = new Set();    // uids of the book's own cards the drop has
    const loose  = [];           // cards with no UID: always new

    for( const c of incoming )
    {
        const u = c.uid;
        if( u && byUid.has( u ) )
        {
            const i = byUid.get( u );
            if( i < have.length ) named.add( u );
            if( sameBlock( blocks[ i ], c.text ) || cardRev( c ) <= revs[ i ] ) continue;    // the same, or not newer: stays
            if( ! orig.has( u ) ) orig.set( u, blocks[ i ] );
            blocks[ i ] = c.text;
            revs[ i ]   = cardRev( c );
        }
        else
        {
            blocks.push( c.text );
            revs.push( cardRev( c ) );
            if( u ) { byUid.set( u, blocks.length - 1 ); orig.set( u, null ); }
            else    loose.push( c.text );
        }
    }

    const added = loose.map( function( t ) { return { uid: '', text: t }; } ), replaced = [];
    orig.forEach( function( was, u )
    {
        const now = blocks[ byUid.get( u ) ];
        if( was === null ) added.push( { uid: u, text: now } );
        else if( ! sameBlock( was, now ) ) replaced.push( { uid: u, was: was, now: now } );
    } );
    const kept = Array.from( named ).filter( function( u ) { return ! orig.has( u ); } ).length;
    if( ! added.length && ! replaced.length ) return { text: book, changed: false, added: [], replaced: [], kept: kept };
    return { text: blocks.join( '\r\n' ) + '\r\n', changed: true, added: added, replaced: replaced, kept: kept };
}

// Its Undo, on the file as it is NOW: a card it added goes, a card it
// replaced gets its old text back - each only while it is still exactly
// what the import wrote (edited since in Contacts: left as it is).
function revertCards( book, job )
{
    const have = String( book || '' ).trim() ? NayiveVCard.cards( book ) : [];
    if( ! have ) throw new Error( T( 'ui.store.badFile' ) );
    let blocks = have.map( function( c ) { return c.text; } );
    const uids = have.map( function( c ) { return c.uid; } );
    let changed = false;

    job.replaced.forEach( function( r )
    {
        const i = uids.indexOf( r.uid );
        if( i !== -1 && sameBlock( blocks[ i ], r.now ) ) { blocks[ i ] = r.was; changed = true; }
    } );
    job.added.forEach( function( a )
    {
        const i = blocks.findIndex( function( b, k ) { return blocks[ k ] !== null && ( ! a.uid || uids[ k ] === a.uid ) && sameBlock( b, a.text ); } );
        if( i !== -1 ) { blocks[ i ] = null; changed = true; }
    } );
    blocks = blocks.filter( function( b ) { return b !== null; } );
    return { text: blocks.length ? blocks.join( '\r\n' ) + '\r\n' : '', changed: changed };
}

async function mergeIntoContacts( incomingText )
{
    const incoming = NayiveVCard.cards( incomingText ) || [];
    if( ! incoming.length ) throw new Error( T( 'drive.noContactsInFile' ) );

    const path = 'data/contacts.vcf';
    const job  = await updateAppFile( path, 'Contacts', function( book ) { return addCards( book, incoming ); } );
    return { n: job.added.length + job.replaced.length, kept: job.kept,
             undo: job.changed ? { path: path, app: 'Contacts', fn: function( book ) { return revertCards( book, job ); } } : null };
}

// The calendar's top-level blocks (inside its VCALENDAR): [ { s, e, kind,
// text } ] by line, plus where the first event and the VCALENDAR's END are.
function calBlocks( lines )
{
    const out = [];
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
            out.push( { s: start, e: i, kind: kind, text: lines.slice( start, i + 1 ).join( '\n' ) } );
            start = -1;
        }
        if( depth === 1 && tag === 'VCALENDAR' ) calEnd = i;
        depth--;
    }
    return { blocks: out, firstEvent: firstEvent, calEnd: calEnd };
}

// Every event of a dropped .ics into the calendar's text `existing` ('' =
// no file yet). The existing file stays as it is, line for line - its
// header, a VTODO, anything else Drive does not know. An event dropped again
// (same UID and RECURRENCE-ID) takes its old one's place only when the
// dropped copy is NEWER (eventNewer): an old export, or an invitation sent
// again, never takes back the edits made since (C2). A new one goes in
// before the last END:VCALENDAR, a new VTIMEZONE before the first event.
// Pure (see updateAppFile).
// -> { text, changed, added: [ { key, text } ], replaced: [ { key, was, now } ], kept }
function addEvents( existing, events, zones )
{
    if( ! /BEGIN:VCALENDAR/i.test( existing ) )
        existing = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Nayive//Personal Calendar//EN\r\nEND:VCALENDAR\r\n';

    const eol   = /\r\n/.test( existing ) ? '\r\n' : '\n';
    const lines = existing.replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).split( '\n' );
    const cal   = calBlocks( lines );
    const at    = new Map();          // eventKey -> the first top-level VEVENT with it
    const haveTz = new Set();
    cal.blocks.forEach( function( b )
    {
        if( b.kind === 'VEVENT' && blockProp( b.text, 'UID' ) && ! at.has( eventKey( b.text ) ) ) at.set( eventKey( b.text ), b );
        if( b.kind === 'VTIMEZONE' ) haveTz.add( blockProp( b.text, 'TZID' ) );
    } );

    const replace = new Map();        // first line of an existing event -> { last, text, was, key }
    const added   = [];
    const addedAt = new Map();        // eventKey -> index in `added` (the same event twice in one file: the last wins)
    const keptKeys = new Set();
    for( const b of events )
    {
        const k = eventKey( b ), has = !! blockProp( b, 'UID' );
        if( has && at.has( k ) )
        {
            const old = at.get( k ), now = replace.has( old.s ) ? replace.get( old.s ).text : old.text;
            if( sameBlock( now, b ) || ! eventNewer( b, now ) ) { if( ! replace.has( old.s ) ) keptKeys.add( k ); continue; }
            keptKeys.delete( k );
            replace.set( old.s, { last: old.e, text: b, was: old.text, key: k } );
        }
        else if( has && addedAt.has( k ) ) added[ addedAt.get( k ) ] = b;
        else { if( has ) addedAt.set( k, added.length ); added.push( b ); }
    }
    if( ! added.length && ! replace.size ) return { text: existing, changed: false, added: [], replaced: [], kept: keptKeys.size };

    const newZones = zones.filter( function( b )
    {
        const id = blockProp( b, 'TZID' );
        if( haveTz.has( id ) ) return false;
        haveTz.add( id );
        return true;
    } );

    const out     = [];
    const zonesAt = cal.firstEvent >= 0 ? cal.firstEvent : cal.calEnd;
    for( let i = 0; i < lines.length; i++ )
    {
        if( i === zonesAt ) out.push( ...newZones );
        if( i === cal.calEnd ) out.push( ...added );

        const r = replace.get( i );
        if( r ) { out.push( r.text ); i = r.last; continue; }
        out.push( lines[ i ] );
    }
    if( cal.calEnd < 0 )              // a file that never closed its VCALENDAR
    {
        while( out.length && out[ out.length - 1 ] === '' ) out.pop();
        out.push( ...( zonesAt < 0 ? newZones : [] ), ...added, 'END:VCALENDAR', '' );
    }

    const text = out.join( '\n' ).replace( /\r\n/g, '\n' ).replace( /\n/g, eol );
    return { text: /\n$/.test( text ) ? text : text + eol, changed: true,
             added: added.map( function( b ) { return { key: blockProp( b, 'UID' ) ? eventKey( b ) : '', text: b }; } ),
             replaced: Array.from( replace.values() ).map( function( r ) { return { key: r.key, was: r.was, now: r.text }; } ),
             kept: keptKeys.size };
}

// Its Undo, on the calendar as it is NOW: an event it added goes, one it
// replaced gets its old text back - each only while it is still exactly
// what the import wrote (moved or edited since in Calendar: left as it is).
// A time zone it added stays: harmless, and another event may use it.
function revertEvents( existing, job )
{
    const eol   = /\r\n/.test( existing ) ? '\r\n' : '\n';
    const lines = String( existing || '' ).replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' ).split( '\n' );
    const evs   = calBlocks( lines ).blocks.filter( function( b ) { return b.kind === 'VEVENT'; } );
    const put   = new Map();          // first line -> { last, text: null (drop) | the old text }

    job.replaced.forEach( function( r )
    {
        const b = evs.find( function( x ) { return ! put.has( x.s ) && eventKey( x.text ) === r.key && sameBlock( x.text, r.now ); } );
        if( b ) put.set( b.s, { last: b.e, text: r.was } );
    } );
    job.added.forEach( function( a )
    {
        const b = evs.find( function( x ) { return ! put.has( x.s ) && ( ! a.key || eventKey( x.text ) === a.key ) && sameBlock( x.text, a.text ); } );
        if( b ) put.set( b.s, { last: b.e, text: null } );
    } );
    if( ! put.size ) return { text: existing, changed: false };

    const out = [];
    for( let i = 0; i < lines.length; i++ )
    {
        const r = put.get( i );
        if( r ) { if( r.text !== null ) out.push( r.text ); i = r.last; continue; }
        out.push( lines[ i ] );
    }
    return { text: out.join( '\n' ).replace( /\r\n/g, '\n' ).replace( /\n/g, eol ), changed: true };
}

async function mergeIntoCalendar( incomingText )
{
    const events = extractBlocks( incomingText, 'VEVENT' );
    const zones  = extractBlocks( incomingText, 'VTIMEZONE' );
    if( ! events.length ) throw new Error( T( 'drive.noEventsInFile' ) );

    const path = 'data/calendar.ics';
    const job  = await updateAppFile( path, 'Calendar', function( text ) { return addEvents( text, events, zones ); } );
    return { n: job.added.length + job.replaced.length, kept: job.kept,
             undo: job.changed ? { path: path, app: 'Calendar', fn: function( text ) { return revertEvents( text, job ); } } : null };
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

// The toast counts what went in (added or replaced by a newer copy) and
// what was already there, the same or newer, and kept (C2); its Undo takes
// out what went in (undoAppImports).
async function runAppImports( imports )
{
    let calEvents = 0, calFiles = 0, conCards = 0, conFiles = 0, kept = 0;
    const failed = [], undos = [];

    for( const it of imports )
    {
        setStatus( TF( 'drive.importing', { name: it.relPath } ) );
        const isIcs = it.relPath.toLowerCase().endsWith( '.ics' );
        try
        {
            const text = await it.file.text();
            const r    = isIcs ? await mergeIntoCalendar( text ) : await mergeIntoContacts( text );
            if( isIcs ) { calEvents += r.n; calFiles++; }
            else        { conCards  += r.n; conFiles++; }
            kept += r.kept;
            if( r.undo ) undos.push( r.undo );
        }
        catch( err )
        {
            failed.push( it.relPath + ( err && err.message ? ' (' + err.message + ')' : '' ) );
        }
    }

    const done = [];
    if( calFiles && calEvents ) done.push( TF( calEvents === 1 ? 'drive.oneEventTo' : 'drive.nEventsTo', { n: calEvents } ) );
    if( conFiles && conCards )  done.push( TF( conCards  === 1 ? 'drive.oneContactTo' : 'drive.nContactsTo', { n: conCards } ) );
    const msg = ( done.length ? TF( 'drive.imported', { what: done.join( T( 'drive.and' ) ) } ) : '' ) +
                ( kept ? ( done.length ? ' · ' : '' ) + TF( 'drive.importKept', { n: kept } ) : '' );
    if( msg && undos.length ) NayiveUI.undoToast( msg, function() { undoAppImports( undos ); }, { ms: 8000 } );
    else if( msg )            NayiveUI.toast( msg, { ms: 5000 } );
    if( failed.length ) NayiveUI.alert( { title: T( 'drive.importFailedTitle' ), body: failed.join( '\n' ) } );
}

// The Undo of an import, newest first: each file read fresh from the server
// and written back checked, as the import was (updateAppFile) - only what
// the import put in, and only where it is still as the import left it.
async function undoAppImports( undos )
{
    const failed = [];
    for( const u of undos.slice().reverse() )
    {
        try { await updateAppFile( u.path, u.app, u.fn ); }
        catch( err ) { failed.push( u.app + ( err && err.message ? ' (' + err.message + ')' : '' ) ); }
    }
    if( failed.length ) NayiveUI.alert( { title: T( 'drive.importUndoFailed' ), body: failed.join( '\n' ) } );
    else NayiveUI.toast( T( 'drive.importUndone' ) );
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
// drive-files #1, #2): the folder `dest`'s own files, and every file inside
// each dropped top folder, at any depth. A Map relPath -> size. Read fresh,
// never from the listing on screen: that one knew only the open folder's
// top level - so a folder dropped again replaced every same-named file in
// it with no question - and it misses what another device put there since.
// null when a folder cannot be read: then nothing is sent (a 404 is a top
// folder that is not there yet, so it holds nothing).
async function filesThere( items, dest )
{
    const there  = new Map();
    const prefix = dest ? dest + '/' : '';
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
        add( ( await withBusy( GumApi.listDir( dest ) ) ).nodes );     // one level: its sub-folders come back empty
        for( const top of tops )
        {
            try { add( ( await withBusy( GumApi.listDirRecursive( joinPath( dest, top ) ) ) ).nodes ); }
            catch( err ) { if( ! err || err.status !== 404 ) throw err; }
        }
    }
    catch( _ ) { return null; }
    return there;
}

// What an upload item would land on at the destination: the file itself,
// and - for a LibreOffice document - its twin. Each is a clash of its own:
// the question lists both (a .docx edited in Write since must be seen to be
// replaced), and "Replace" replaces only what it listed. Returns the names
// to list, [] when nothing clashes.
function markClash( it, there )
{
    const twin = officeTwinRel( it.relPath );
    it.fileThere = there.has( it.relPath );
    it.twinThere = !! twin && there.has( twin );
    const names = [];
    if( it.fileThere ) names.push( it.relPath );
    if( it.twinThere ) names.push( twin );
    return names;
}

// createFileBytes with Drive's "&convert=mp4": the same create-only PUT
// (If-None-Match: *, a 412 when the name is taken), plus the query. A 412
// that is this upload's own first try (sent again after a dropped
// connection, its first try landed) is a success already: GumApi's "our own
// first try" reads the file back and finds these bytes.
function createUpload( path, blob, conv )
{
    return GumApi.createFileBytes( path, blob, conv ? { convert: 'mp4' } : null );
}

// A name free in relPath's folder (under `dest`) NOW - a fresh listing - and
// not written by this batch: "x (copia).jpg", "x (copia 2).jpg"...
async function freeRel( dest, relPath, used )
{
    const i      = relPath.lastIndexOf( '/' );
    const dir    = i < 0 ? '' : relPath.slice( 0, i + 1 );
    const parent = dir ? joinPath( dest, dir.slice( 0, -1 ) ) : dest;
    const r      = await withBusy( GumApi.listDir( parent ) );
    const names  = new Set( ( r.nodes || [] ).map( function( n ) { return n.path.split( '/' ).pop(); } ) );
    return dir + uniqueName( relPath.slice( i + 1 ), { has: n => names.has( n ) || used.has( dir + n ) } );
}

function inShared( path ) { return path === 'shared' || path.indexOf( 'shared/' ) === 0; }

// Sends a file the user did NOT say "Replace" to, into `dest`: it may only
// make a new file. A 412 is a name taken since filesThere looked (another
// device or window; this very upload's first try never gets here, see
// createUpload). The user then picks: replace it, or keep both - this one
// goes up as "x (copia).jpg".
// In a folder shared with us the name taken is a 409 and there is nothing to
// pick (it only ever gains files): this one goes up beside it. Resolves the
// relPath it was saved under; null when the user cancels (the rest of the
// upload stops too). 20 names in a row taken is not a race: an error.
async function sendNew( dest, relPath, blob, conv, used )
{
    for( let tries = 0; ; tries++ )
    {
        const path = joinPath( dest, relPath );
        let   status;
        try { await withBusy( createUpload( path, blob, conv ) ); return relPath; }
        catch( err )
        {
            status = err && err.status;
            if( ( status !== 412 && ! ( status === 409 && inShared( path ) ) ) || tries >= 20 ) throw err;
        }

        if( status === 412 )
        {
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
        }
        relPath = await freeRel( dest, relPath, used );
        used.add( relPath );
    }
}

async function uploadItems( items )
{
    if( ! items.length ) return;

    // THE FOLDER IT GOES TO, fixed now: the user may open another folder while
    // it runs, and a "Replace" said for this one must never land on a
    // same-named file there (nor anything else of this upload).
    const dest = currentFolder;

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
    // a twin already here is a clash too, listed on its own - see markClash.
    const there = await filesThere( items, dest );
    if( ! there ) { setStatus( '' ); NayiveUI.toast( T( 'drive.checkDestFailed' ), { ms: 6000 } ); return; }
    const clashNames = [];
    const collisions = items.filter( function( it )
    {
        const names = markClash( it, there );
        clashNames.push.apply( clashNames, names );
        return names.length > 0;
    } );

    if( collisions.length )
    {
        const choice = await askReplace( clashNames, collisions.length === items.length );

        if( choice === 'cancel' ) { setStatus( '' ); return; }

        if( choice === 'skip' )
        {
            const drop = new Set( collisions );
            items = items.filter( function( it ) { return ! drop.has( it ); } );
            if( ! items.length ) { setStatus( '' ); return; }
        }
        // "Replace" replaces exactly what the question listed - the file, and
        // the twin, each listed on its own. Everything else goes up
        // create-only (sendNew), and a twin not listed is left as it is.
        else collisions.forEach( function( it ) { it.replaceFile = it.fileThere; it.replaceTwin = it.twinThere; } );
    }

    // Videos a browser cannot play (.avi, .wmv, ...): offer to turn them
    // into an .mp4 on the server, BEFORE anything is sent. Never inside a
    // shared folder: the job ends by moving the original to the papelera.
    let toConvert = new Set();
    const inSharedDir = inShared( dest );
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
        const parent = joinPath( dest, segs.join( '/' ) );
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
                await withBusy( GumApi.writeFileBytes( joinPath( dest, relPath ), ready.blob, conv ? { convert: 'mp4' } : null ) );
            else
            {
                const got = await sendNew( dest, relPath, ready.blob, conv, used );
                if( got === null )                      // cancelled: nothing more is sent - and the message says what
                {
                    const left = items.slice( i ).map( function( x ) { return x.relPath; } );
                    notes.push( TF( 'drive.notSentN', { n: left.length,
                                    names: left.slice( 0, 3 ).join( ', ' ) + ( left.length > 3 ? '…' : '' ) } ) );
                    break;
                }
                relPath = got;
            }
            if( conv ) converting++;
            // Its twin replaces one only when "Replace" was said to it too.
            if( officeTwinRel( relPath ) )
                toOffice.push( { path: joinPath( dest, relPath ), name: relPath.split( '/' ).pop(),
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
