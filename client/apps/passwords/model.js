// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * model.js - Passwords: the file as read, the open vault in memory, and every
 * write. No DOM here.
 *
 * Two layers, never mixed:
 *   env    the vault file exactly as the server and the cache hold it -
 *          ciphertext only (vault.js THE FILE). Every save is THIS object,
 *          with the entries an edit changed sealed again. An entry this page
 *          could not open (damaged) is never touched, so it is never lost.
 *   items  id -> the plain entry, ONLY while the vault is open (keys set).
 *          lock() empties it.
 *
 * A plain entry (what is sealed, plus `id` at run time):
 *   { type: "login" | "note" | "folder", title, user, pass, urls: [],
 *     notes, totp, fields: [ { name, value, hidden } ], folder (a folder's id,
 *     "" = top), fav, history: [ { pass, at } ] (newest first, 5 kept),
 *     created, updated }
 * A key this version does not know is kept as it is (a newer app wrote it).
 *
 * NOTHING IS WRITTEN unless the file was read and understood: "empty" (then
 * only the set-up writes it) or a vault this page opened. A damaged file, one
 * from a newer version, or one never read is shown, never written over.
 */
"use strict";

const FILE      = 'data/passwords/passwords.json';
const UI_KEY    = 'balata-passwords-ui';
const BAK_KEY   = 'balata-passwords-bak';    // the day this device last kept a server .bak
const ROOT      = '';                        // the top level: no folder
const GONE_DAYS = 90;                        // a deleted entry's mark is kept this long (MERGE)
const HISTORY_N = 5;

let env       = null;        // the file (see the top); null = none known
let fileState = 'unknown';   // 'unknown' never read | 'empty' no vault yet | 'ok' | 'bad' damaged | 'newer'
let keys      = null;        // { vault, item } while open; null = locked
let items     = {};          // id -> plain entry, while open
let parentOf  = {};          // id -> the folder it really sits in (ROOT when its own is gone or a loop)
let damaged   = 0;           // live entries that would not open
let store     = null;        // NayiveStore, set by boot.js
let chain     = Promise.resolve();   // writes, one at a time, in order
const opened  = new Map();   // id -> { r, c, item }: the entries already opened (a re-read skips them)

function T( k )     { return Ayni.t( k ); }
function TF( k, v ) { return Ayni.tf( k, v ); }

function nowIso() { return new Date().toISOString().replace( /\.\d{3}Z$/, 'Z' ); }
function today()  { return new Date().toISOString().slice( 0, 10 ); }

function isOpen()   { return !! keys && fileState === 'ok' && !! env; }
function item( id ) { return Object.prototype.hasOwnProperty.call( items, id ) ? items[ id ] : null; }
function isFolder( n ) { return !! n && n.type === 'folder'; }

//------------------------------------------------------------------------//
// A PLAIN ENTRY

function str( v ) { return typeof v === 'string' ? v : ''; }

// What the screen relies on; unknown keys stay as they are.
function cleanItem( o )
{
    const n = Object.assign( {}, o );
    n.type   = [ 'login', 'note', 'folder' ].indexOf( o.type ) >= 0 ? o.type : 'note';
    n.title  = str( o.title );
    n.folder = str( o.folder );
    n.created = str( o.created );
    n.updated = str( o.updated );
    if( n.type === 'folder' ) return n;
    n.user  = str( o.user );
    n.pass  = str( o.pass );
    n.notes = str( o.notes );
    n.totp  = str( o.totp );
    n.fav   = !! o.fav;
    n.urls  = Array.isArray( o.urls ) ? o.urls.filter( function( u ) { return typeof u === 'string' && u.trim(); } ) : [];
    n.fields = Array.isArray( o.fields ) ? o.fields.filter( function( f ) { return f && typeof f === 'object'; } ).map( function( f )
               { return { name: str( f.name ), value: str( f.value ), hidden: !! f.hidden }; } ) : [];
    n.history = Array.isArray( o.history ) ? o.history.filter( function( h ) { return h && typeof h.pass === 'string'; } )
                                                      .map( function( h ) { return { pass: h.pass, at: str( h.at ) }; } ).slice( 0, HISTORY_N ) : [];
    return n;
}

// What is sealed: the entry less its run-time fields.
function sealedForm( n )
{
    const o = {};
    for( const k of Object.keys( n ) ) if( k !== 'id' && k.charAt( 0 ) !== '_' ) o[ k ] = n[ k ];
    return o;
}

//------------------------------------------------------------------------//
// FOLDERS  -  every entry's real place, worked out once per change: a folder
// that is gone, or a loop of folders, puts its entries at the top.

function reindex()
{
    parentOf = {};
    for( const id of Object.keys( items ) )
    {
        let p = items[ id ].folder || ROOT;
        if( p !== ROOT && ! isFolder( item( p ) ) ) p = ROOT;
        parentOf[ id ] = p;
    }
    for( const id of Object.keys( items ) )
    {
        if( ! isFolder( items[ id ] ) ) continue;
        let p = parentOf[ id ], guard = 0;
        while( p !== ROOT && guard++ < 1000 ) { if( p === id ) break; p = parentOf[ p ]; }
        if( p === id || guard >= 1000 ) parentOf[ id ] = ROOT;
    }
}

function childrenOf( fid ) { return Object.keys( items ).filter( function( id ) { return parentOf[ id ] === fid; } ).map( item ); }

function ancestry( id )          // the folders above `id`, top first, then `id` itself
{
    const out = [];
    let cur = id, guard = 0;
    while( cur !== ROOT && item( cur ) && guard++ < 1000 ) { out.unshift( item( cur ) ); cur = parentOf[ cur ]; }
    return out;
}

function isInside( id, folderId )   // id is folderId or below it
{
    let cur = id, guard = 0;
    while( cur !== ROOT && guard++ < 1000 ) { if( cur === folderId ) return true; cur = parentOf[ cur ]; }
    return false;
}

function descendants( fid )
{
    const out = [];
    ( function walk( id ) { for( const c of childrenOf( id ) ) { out.push( c ); if( isFolder( c ) ) walk( c.id ); } } )( fid );
    return out;
}

function allEntries() { return Object.keys( items ).map( item ).filter( function( n ) { return ! isFolder( n ); } ); }

function folderName( f ) { return ! f ? T( 'passwords.all' ) : ( f.title || T( 'ui.untitled' ) ); }

function pathText( fid ) { return ancestry( fid ).map( folderName ).join( ' › ' ); }

// Folders in tree order, with depth, for the pickers.
function folderList()
{
    const out = [ { id: ROOT, name: T( 'passwords.all' ), depth: 0 } ];
    ( function walk( id, d )
    {
        for( const c of sortByName( childrenOf( id ).filter( isFolder ) ) ) { out.push( { id: c.id, name: folderName( c ), depth: d } ); walk( c.id, d + 1 ); }
    } )( ROOT, 1 );
    return out;
}

function sortByName( list )
{
    return list.slice().sort( function( a, b ) { return NayiveUI.fold( a.title ).localeCompare( NayiveUI.fold( b.title ) ); } );
}

//------------------------------------------------------------------------//
// LOAD  -  the file, then (while open) every entry not opened yet.

async function loadData()
{
    const res = await store.read( FILE );

    if( res.source === 'empty' )
    {
        env = null;
        fileState = 'empty';
        if( keys ) lock();          // the vault went away (deleted elsewhere)
    }
    else if( res.body !== null && res.body !== undefined )
    {
        let f = null;
        try { f = JSON.parse( res.body ); } catch( e ) { f = null; }
        const st = PwVault.check( f );
        if( st === 'ok' )
        {
            if( keys && f.vault !== keys.vault ) lock();     // another vault took its place
            env = f;
        }
        else env = null;
        fileState = st;
        if( st !== 'ok' && keys ) lock();
    }
    // else: unreachable and nothing cached - what is on screen stays.

    if( isOpen() ) await openAll();
    render();

    // A save still held back as a conflict (TWO DEVICES): sent again, it goes
    // through the merge, checked against the version it was made from.
    if( isOpen() && await store.conflicted( FILE ) ) save();
}

// Opens what changed since the last look; the rest is reused. Copies left by
// a merge (vault.js MERGE) become entries of their own.
async function openAll()
{
    if( ! isOpen() ) return;
    const k = keys, f = env;
    const next = {};
    let bad = 0;
    for( const id of Object.keys( f.items ) )
    {
        const e = f.items[ id ];
        if( ! PwVault.isLive( e ) ) continue;
        const had = opened.get( id );
        if( had && had.c === e.c && had.r === e.r ) { next[ id ] = had.item; continue; }
        try
        {
            const n = cleanItem( await PwVault.openItem( k, id, e.r, e.c ) );
            n.id = id;
            opened.set( id, { r: e.r, c: e.c, item: n } );
            next[ id ] = n;
        }
        catch( err ) { bad++; opened.delete( id ); }
        if( keys !== k || env !== f ) return openAll();      // locked, or re-read meanwhile: start again
    }
    for( const id of Array.from( opened.keys() ) ) if( ! next[ id ] ) opened.delete( id );
    items = next;
    if( bad !== damaged && bad ) Ayni.toast( 'warn', TF( 'passwords.damagedN', { n: bad } ) );
    damaged = bad;
    reindex();
    if( f.copies && f.copies.length ) takeCopies();
}

//------------------------------------------------------------------------//
// WRITE  -  every change goes through here, one at a time (`chain`):
// seal what changed, check it opens again, put it in env, one store.write.

// Say so, and answer false, while nothing may be written. Called BEFORE
// anything changes.
function canEdit()
{
    if( isOpen() ) return true;
    Ayni.toast( ( fileState === 'ok' ? 'warn' : 'err' ), T( fileState === 'ok' ? 'passwords.locked' : 'ui.store.notRead' ) );
    return false;
}

// The day's first save also keeps the server copy as it was (.bak beside the
// file, made by the server: store.js BAK). Ciphertext, like the file.
function bakToday()
{
    try
    {
        if( localStorage.getItem( BAK_KEY ) === today() ) return false;
        localStorage.setItem( BAK_KEY, today() );
        return true;
    }
    catch( e ) { return false; }
}

// Deleted entries' marks older than GONE_DAYS go (every device has merged
// them by then).
function purgeGone( f )
{
    const limit = new Date( Date.now() - GONE_DAYS * 86400000 ).toISOString().slice( 0, 10 );
    for( const id of Object.keys( f.items ) )
    {
        const e = f.items[ id ];
        if( PwVault.isGone( e ) && typeof e.at === 'string' && e.at < limit ) delete f.items[ id ];
    }
}

function serialize( f ) { return JSON.stringify( f || env, null, 2 ); }

function save()
{
    if( ! isOpen() ) return false;
    purgeGone( env );
    store.write( FILE, serialize(), bakToday() ? { bak: true } : undefined );
    return true;
}

// Run `fn` after every write asked before it; a failure is said, never lost
// in silence. -> its promise.
function queue( fn )
{
    const p = chain.then( fn );
    chain = p.catch( function() {} );
    return p.catch( function( e )
    {
        Ayni.toast( ( e && e.message === 'locked' ? 'warn' : 'err' ), T( e && e.message === 'locked' ? 'passwords.locked' : 'passwords.saveFailed' ) );
        throw e;
    } );
}

// Seal `n` (a plain entry with its id) at the next revision. The revision is
// read again after the await: a merge that came in meanwhile moved it.
async function sealEntry( n )
{
    for( let tries = 0; tries < 5; tries++ )
    {
        if( ! isOpen() ) throw new Error( 'locked' );
        const k = keys;
        const cur = env.items[ n.id ];
        const r = ( cur ? cur.r : 0 ) + 1;
        const form = sealedForm( n );
        const c = await PwVault.sealItem( k, n.id, r, form );
        // Write-verify: what goes to disk opens again, to the same entry.
        const back = await PwVault.openItem( k, n.id, r, c );
        if( JSON.stringify( back ) !== JSON.stringify( form ) ) throw new Error( 'verify' );
        if( ! isOpen() || keys !== k ) throw new Error( 'locked' );
        const now = env.items[ n.id ];
        if( ( now ? now.r : 0 ) + 1 !== r ) continue;
        env.items[ n.id ] = { r: r, c: c };
        opened.set( n.id, { r: r, c: c, item: n } );
        items[ n.id ] = n;
        return;
    }
    throw new Error( 'busy' );
}

// Save these entries (new or changed). -> a promise.
function putItems( list )
{
    return queue( async function()
    {
        for( const n of list ) await sealEntry( n );
        reindex();
        save();
    } );
}

// Delete: each entry becomes a mark ({ r, x: 1, at }). -> the plain entries
// that went, for Undo (putItems puts them back, at a newer revision).
function dropItems( ids )
{
    const gone = [];
    for( const id of ids )
    {
        const n = item( id ), e = env && env.items[ id ];
        if( ! n || ! e ) continue;
        gone.push( n );
        env.items[ id ] = { r: e.r + 1, x: 1, at: today() };
        opened.delete( id );
        delete items[ id ];
    }
    return gone;
}

function deleteItems( ids )
{
    let gone = [];
    const p = queue( async function()
    {
        if( ! isOpen() ) throw new Error( 'locked' );
        gone = dropItems( ids );
        reindex();
        save();
    } );
    return p.then( function() { return gone; } );
}

// A header change (master password, recovery key, reminder phrase): `make()`
// works out the new part(s) -> { kdf, pw } and / or { rec } and / or { hint }
// (hint: null = remove it); they go into the file as it is THEN (a merge may
// have come in while Argon2id ran), then one save.
function putHeader( make )
{
    return queue( async function()
    {
        if( ! isOpen() ) throw new Error( 'locked' );
        const k = keys;
        const patch = await make();
        if( ! isOpen() || keys !== k ) throw new Error( 'locked' );
        if( patch.kdf && patch.pw ) { env.kdf = patch.kdf; env.keys.pw = patch.pw; }
        if( 'hint' in patch ) { if( patch.hint ) env.hint = patch.hint; else delete env.hint; }
        if( patch.rec ) env.keys.rec = patch.rec;
        save();
    } );
}

// A copy a merge kept (two devices changed one entry): opened at its own
// place, then saved as a new entry "<title> (other device)". One that will
// not open stays where it is.
function takeCopies()
{
    queue( async function()
    {
        if( ! isOpen() || ! env.copies || ! env.copies.length ) return;
        const k = keys, made = [], left = [];
        for( const x of env.copies )
        {
            try
            {
                const n = cleanItem( await PwVault.openItem( k, x.id, x.r, x.c ) );
                n.id    = PwVault.newId();
                n.title = TF( 'passwords.otherDevice', { name: n.title || T( 'ui.untitled' ) } );
                made.push( n );
            }
            catch( e ) { left.push( x ); }
        }
        if( ! made.length ) return;
        for( const n of made ) await sealEntry( n );
        if( left.length ) env.copies = left; else delete env.copies;
        reindex();
        save();
        render();
        Ayni.toast( 'warn', TF( 'passwords.copiesMade', { n: made.length } ) );
    } ).catch( function() {} );
}

//------------------------------------------------------------------------//
// TWO DEVICES  -  a save over a file another device changed since is held
// back (412); the STORE reads the server's copy and asks mergeFile, which is
// vault.js's merge (it needs no key). Then the page shows the result.

function mergeFile( path, base, mine, theirs )
{
    if( path !== FILE ) return null;
    try { return PwVault.merge( base, mine, theirs ); }
    catch( e ) { return null; }                         // held back, never written over
}

function onFileMerged( path, body )
{
    if( path !== FILE ) return;
    let f = null;
    try { f = JSON.parse( body ); } catch( e ) { return; }
    if( PwVault.check( f ) !== 'ok' || ( keys && f.vault !== keys.vault ) ) return;
    env = f;
    fileState = 'ok';
    ( isOpen() ? openAll() : Promise.resolve() ).then( function()
    {
        render();
        Ayni.toast( 'info', T( 'passwords.merged' ) );
    } );
}

//------------------------------------------------------------------------//
// PER-DEVICE CHOICES  -  localStorage, every access in try/catch.

let ui = { sort: 'name', open: [], treeW: 0, lockMin: 5, clipSec: 30, gen: null };

const LOCK_CHOICES = [ 1, 5, 15, 60 ];
const CLIP_CHOICES = [ 15, 30, 60, 120 ];

function loadUi()
{
    try
    {
        const s = JSON.parse( localStorage.getItem( UI_KEY ) || '{}' );
        if( s && typeof s === 'object' )
        {
            if( s.sort === 'name' || s.sort === 'changed' ) ui.sort = s.sort;
            if( Array.isArray( s.open ) ) ui.open = s.open.filter( function( x ) { return typeof x === 'string'; } );
            if( s.treeW > 0 ) ui.treeW = s.treeW;
            if( LOCK_CHOICES.indexOf( s.lockMin ) >= 0 ) ui.lockMin = s.lockMin;
            if( CLIP_CHOICES.indexOf( s.clipSec ) >= 0 ) ui.clipSec = s.clipSec;
            if( s.gen && typeof s.gen === 'object' ) ui.gen = s.gen;
        }
    }
    catch( e ) {}
}

function saveUi()
{
    try { localStorage.setItem( UI_KEY, JSON.stringify( ui ) ); } catch( e ) {}
}
