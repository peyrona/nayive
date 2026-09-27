/*
 * model.js - Bookmarks: the data, its repair, and every pure helper over it
 * (paths, counts, search, the duplicate key). No DOM here.
 *
 * The file is one normalised map:
 *
 *   { version: 1, rootId: "root", nodes: {
 *       "root": { id, title: "", type: "folder", parentId: null, children: [...], createdAt },
 *       "f_x":  { id, title, type: "folder",   parentId, children: [...], createdAt },
 *       "b_y":  { id, title, type: "bookmark", parentId, url, tags: [], notes, favorite, createdAt } } }
 *
 * `children` holds the saved order. A field starting with "_" is runtime only
 * and never written (see serialize). `createdAt` is "" when nobody knows it (a
 * browser file without ADD_DATE): such a bookmark sorts last by date and is
 * never "recent".
 */
"use strict";

const FILE    = 'data/bookmarks/bookmarks.json';
const UI_KEY  = 'balata-bookmarks-ui';
const ROOT    = 'root';
const RECENT_N = 15;

let data    = emptyData();
let loaded  = false;    // false = we do not know what is in the file: never write it
let store   = null;     // NayiveStore, set by boot.js
let base    = null;     // the file as the server last had it (text): the common ancestor of a merge
let sent    = null;     // the body of our newest write; it becomes `base` once the server has it
let merging = false;    // a conflict is being merged: reads and writes wait for it

function T( k )     { return NayiveUI.t( k ); }
function TF( k, v ) { return NayiveUI.tf( k, v ); }

function emptyData()
{
    return { version: 1, rootId: ROOT,
             nodes: { root: { id: ROOT, title: '', type: 'folder', parentId: null, children: [], createdAt: nowIso() } } };
}

function nowIso() { return new Date().toISOString().replace( /\.\d{3}Z$/, 'Z' ); }

function newId( kind )
{
    let id;
    do id = kind + '_' + Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 7 );
    while( data.nodes[ id ] );
    return id;
}

function node( id )   { return data.nodes[ id ] || null; }
function isFolder( n ) { return !! n && n.type === 'folder'; }

//------------------------------------------------------------------------//
// REPAIR  -  whatever the file holds, what comes out is a clean tree: one
// root, every node reachable from it exactly once, parentId in step with
// children. Orphans (and cycles, which are unreachable from the root) land in
// their parent if it is known, else in the root.

function repair( raw )
{
    const out   = emptyData();
    const src   = raw && typeof raw === 'object' && raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : {};
    const rootId = raw && typeof raw.rootId === 'string' && src[ raw.rootId ] ? raw.rootId : ROOT;

    // 1. Clean every node on its own.
    const nodes = {};
    for( const key of Object.keys( src ) )
    {
        const n = src[ key ];
        if( ! n || typeof n !== 'object' ) continue;
        const id = key === rootId ? ROOT : key;
        const folder = n.type === 'folder' || ( n.type !== 'bookmark' && ! n.url );
        const c = { id: id, title: typeof n.title === 'string' ? n.title : '',
                    type: folder ? 'folder' : 'bookmark', parentId: null,
                    createdAt: typeof n.createdAt === 'string' ? n.createdAt : '' };
        if( folder )
        {
            c.children = Array.isArray( n.children ) ? n.children.map( function( x ) { return x === rootId ? ROOT : x; } ) : [];
            c._parent  = n.parentId === rootId ? ROOT : n.parentId;
        }
        else
        {
            // Normalised like a typed one, which also mends "nas.local:5000"
            // saved before it was read as a host; a refused one stays as it
            // was (it only cannot be opened).
            c.url      = typeof n.url === 'string' ? normalizeUrl( n.url ) || n.url : '';
            c.tags     = cleanTags( n.tags );
            c.notes    = typeof n.notes === 'string' ? n.notes : '';
            c.favorite = !! n.favorite;
            c._parent  = n.parentId === rootId ? ROOT : n.parentId;
        }
        nodes[ id ] = c;
    }
    if( ! isFolder( nodes[ ROOT ] ) ) nodes[ ROOT ] = out.nodes.root;
    nodes[ ROOT ].title = '';

    // 2. Walk from the root: each node is kept in the FIRST folder that
    //    lists it; later mentions, unknown ids and the root itself drop.
    const seen = new Set( [ ROOT ] );
    function walk( fid )
    {
        const f = nodes[ fid ];
        const kept = [];
        for( const cid of f.children )
        {
            if( typeof cid !== 'string' || ! nodes[ cid ] || seen.has( cid ) ) continue;
            seen.add( cid );
            nodes[ cid ].parentId = fid;
            kept.push( cid );
        }
        f.children = kept;
        for( const cid of kept ) if( isFolder( nodes[ cid ] ) ) walk( cid );
    }
    walk( ROOT );

    // 3. Orphans: into the folder their parentId names if that one is on
    //    the tree now, else the root. A whole orphaned subtree comes along.
    let moved = true;
    while( moved )
    {
        moved = false;
        for( const id of Object.keys( nodes ) )
        {
            if( seen.has( id ) ) continue;
            const want = nodes[ id ]._parent;
            const dest = want && seen.has( want ) && isFolder( nodes[ want ] ) ? want : null;
            if( ! dest ) continue;
            attachOrphan( id, dest );
            moved = true;
        }
        if( ! moved )
            for( const id of Object.keys( nodes ) )
                if( ! seen.has( id ) ) { attachOrphan( id, ROOT ); moved = true; break; }
    }
    function attachOrphan( id, dest )
    {
        seen.add( id );
        nodes[ id ].parentId = dest;
        nodes[ dest ].children.push( id );
        if( isFolder( nodes[ id ] ) ) walk( id );
    }

    for( const id of Object.keys( nodes ) ) delete nodes[ id ]._parent;
    nodes[ ROOT ].parentId = null;
    out.nodes = nodes;
    return out;
}

function cleanTags( tags )
{
    const list = Array.isArray( tags ) ? tags : typeof tags === 'string' ? tags.split( ',' ) : [];
    const out = [];
    for( let t of list )
    {
        if( typeof t !== 'string' ) continue;
        t = t.trim().replace( /^#+/, '' ).replace( /\s+/g, ' ' );
        if( t && out.indexOf( t ) < 0 ) out.push( t );
    }
    return out;
}

// The file as written: no "_" fields, root first.
function serialize()
{
    return JSON.stringify( data, function( k, v ) { return k.charAt( 0 ) === '_' ? undefined : v; }, 2 );
}

//------------------------------------------------------------------------//
// LOAD / SAVE  -  the Games pattern: nothing is written until a read has
// told us what the file holds (an empty file, or a body we could parse).

async function loadData()
{
    if( merging ) return;
    const res = await store.read( FILE );
    if( merging ) return;

    if( res.source === 'empty' )
    {
        data   = emptyData();
        loaded = true;
        base   = null;
    }
    else if( res.body !== null && res.body !== undefined )
    {
        try
        {
            data   = repair( JSON.parse( res.body ) );
            loaded = true;
            if( res.source === 'network' ) base = res.body;
        }
        catch( e )
        {
            // A damaged file is shown as nothing and never written over.
            data   = emptyData();
            loaded = false;
            NayiveUI.toast( T( 'ui.store.badFile' ) );
        }
    }
    // else: unreachable and nothing cached - keep what is on screen, unloaded.

    if( loaded ) pruneOpen();
    pruneState();
    render();

    // Held back by a flush from another page: merge it now.
    if( loaded && await store.conflicted( FILE ) ) resolveConflict();
}

// Say so, and answer false, while the file is not known: an edit then would
// change the screen but never reach the file. Called BEFORE anything changes.
function canEdit()
{
    if( loaded ) return true;
    NayiveUI.toast( T( 'ui.store.notRead' ) );
    return false;
}

function save()
{
    if( ! canEdit() ) return false;
    // During a merge too: the write only joins the held-back one (not sent),
    // and keeps the edit safe if the merge fails; the merge's own write
    // replaces it.
    sent = serialize();
    store.write( FILE, sent );
    return true;
}

// A deep copy of the whole file, for Replace all's Undo.
function snapshot() { return JSON.parse( JSON.stringify( data ) ); }

//------------------------------------------------------------------------//
// TWO DEVICES  -  the store sends If-Unmodified-Since, so a save over a file
// changed elsewhere since our last read is refused (412) and held back. It is
// then merged here, node by node, against `base` (the file as the server last
// had it): a side that did not touch a node takes the other side's; both
// touched it, ours wins; a node one side deleted and the other did not touch
// goes. Without a base (the page was opened with the write already held back)
// nothing counts as deleted: both sides' nodes stay. repair() then makes one
// clean tree of it. Checked by tools/bookmarks-test.

// The store says "synced" when the outbox is empty: our last write is the
// server's file now.
function watchBase( s )
{
    if( s === 'synced' && sent !== null && ! merging ) base = sent;
}

async function resolveConflict()
{
    if( merging ) return;
    merging = true;
    let ok = false;
    try
    {
        const theirs = await GumApi.readFile( FILE );
        const t = repair( JSON.parse( theirs ) );
        const b = base !== null ? repair( JSON.parse( base ) ) : null;
        await store.forget( FILE );                 // drops the held-back write; ours is `data`
        data = merge3( b, repair( JSON.parse( serialize() ) ), t );
        base = theirs;
        ok = true;
    }
    catch( e ) {}                                   // unreadable now: stays held back, tried on the next load
    merging = false;
    if( ! ok ) return;
    save();
    pruneState();
    render();
    NayiveUI.toast( T( 'bookmarks.merged' ) );
}

function sameJson( a, b ) { return JSON.stringify( a ) === JSON.stringify( b ); }

function merge3( b, m, t )
{
    const out = { version: 1, rootId: ROOT, nodes: {} };
    const ids = new Set( Object.keys( m.nodes ).concat( Object.keys( t.nodes ) ) );
    for( const id of ids )
    {
        const bn = b ? b.nodes[ id ] : null, mn = m.nodes[ id ], tn = t.nodes[ id ];
        if( mn && tn ) out.nodes[ id ] = mergeNode( bn, mn, tn );
        else
        {
            const only = mn || tn;
            if( bn && sameJson( bn, only ) ) continue;       // the other side deleted it; this one did not touch it
            out.nodes[ id ] = only;                          // added, or changed after the other side deleted it
        }
    }
    return repair( out );
}

function mergeNode( bn, mn, tn )
{
    const out = {};
    for( const k of new Set( Object.keys( mn ).concat( Object.keys( tn ) ) ) )
    {
        if( k === 'children' ) out.children = mergeList( bn && bn.children, mn.children || [], tn.children || [] );
        else out[ k ] = bn && sameJson( mn[ k ], bn[ k ] ) ? tn[ k ] : mn[ k ];
    }
    return out;
}

// A folder's order: the side that changed it wins; both changed it: ours,
// less what they took out, plus what they put in.
function mergeList( b, m, t )
{
    if( sameJson( m, t ) ) return m.slice();
    if( b && sameJson( b, m ) ) return t.slice();
    if( b && sameJson( b, t ) ) return m.slice();
    const had = new Set( b || [] ), ours = new Set( m ), theirs = new Set( t );
    const out = m.filter( function( id ) { return ! ( had.has( id ) && ! theirs.has( id ) ); } );
    for( const id of t ) if( ! ours.has( id ) && ! had.has( id ) ) out.push( id );
    return out;
}

//------------------------------------------------------------------------//
// TREE HELPERS

function childrenOf( fid )
{
    const f = node( fid );
    return f && f.children ? f.children.map( node ).filter( Boolean ) : [];
}

// Root first: [ root, …, the folder itself ].
function ancestry( id )
{
    const out = [];
    let n = node( id ), guard = 0;
    while( n && guard++ < 1000 ) { out.unshift( n ); n = node( n.parentId ); }
    return out;
}

function isInside( id, folderId )           // id is folderId or below it
{
    let n = node( id ), guard = 0;
    while( n && guard++ < 1000 ) { if( n.id === folderId ) return true; n = node( n.parentId ); }
    return false;
}

function folderName( f ) { return f.id === ROOT ? T( 'bookmarks.all' ) : ( f.title || T( 'ui.untitled' ) ); }

// "Development › Frontend" (the root left out); "" for the root itself.
function pathText( folderId )
{
    return ancestry( folderId ).filter( function( f ) { return f.id !== ROOT; } )
                               .map( folderName ).join( ' › ' );
}

// Everything below a folder, depth first.
function descendants( fid )
{
    const out = [];
    ( function walk( id ) { for( const c of childrenOf( id ) ) { out.push( c ); if( isFolder( c ) ) walk( c.id ); } } )( fid );
    return out;
}

function countIn( fid )
{
    let folders = 0, bookmarks = 0;
    for( const n of descendants( fid ) ) if( isFolder( n ) ) folders++; else bookmarks++;
    return { folders: folders, bookmarks: bookmarks };
}

function allBookmarks() { return descendants( ROOT ).filter( function( n ) { return ! isFolder( n ); } ); }

// Folders in tree order, each with its depth, for the indented pickers.
function folderList()
{
    const out = [ { f: node( ROOT ), depth: 0 } ];
    ( function walk( id, d ) { for( const c of childrenOf( id ) ) if( isFolder( c ) ) { out.push( { f: c, depth: d } ); walk( c.id, d + 1 ); } } )( ROOT, 1 );
    return out;
}

//------------------------------------------------------------------------//
// EDITS  -  each one changes `data` only; the caller saves and renders.

function addNode( n, parentId, index )
{
    const p = isFolder( node( parentId ) ) ? node( parentId ) : node( ROOT );
    n.parentId = p.id;
    data.nodes[ n.id ] = n;
    if( index == null || index < 0 || index > p.children.length ) p.children.push( n.id );
    else p.children.splice( index, 0, n.id );
    return n;
}

function makeFolder( title, parentId )
{
    return addNode( { id: newId( 'f' ), title: title, type: 'folder', parentId: null, children: [], createdAt: nowIso() }, parentId );
}

// `f.createdAt`: an import passes what the file said ("" = unknown); the
// sheet passes nothing, so a new bookmark is "now".
function makeBookmark( f, parentId )
{
    return addNode( { id: newId( 'b' ), title: f.title || '', type: 'bookmark', parentId: null,
                      url: f.url || '', tags: cleanTags( f.tags ), notes: f.notes || '',
                      favorite: !! f.favorite, createdAt: f.createdAt != null ? f.createdAt : nowIso() }, parentId );
}

// Refused when a folder would go into itself or one of its own subfolders.
function canMove( ids, destId )
{
    const dest = node( destId );
    if( ! isFolder( dest ) ) return false;
    return ids.every( function( id ) { return id !== ROOT && ! isInside( destId, id ); } );
}

function moveNodes( ids, destId )
{
    if( ! canMove( ids, destId ) ) return false;
    const dest = node( destId );
    for( const id of ids )
    {
        const n = node( id );
        if( ! n || n.parentId === destId ) continue;
        const from = node( n.parentId );
        if( from ) from.children = from.children.filter( function( x ) { return x !== id; } );
        n.parentId = destId;
        dest.children.push( id );
    }
    return true;
}

// Where a tree drop on the edge of a row puts things: right before / after
// that folder, among its siblings. "After" an OPEN folder that shows
// subfolders means its first place inside, which is where the line is drawn.
// -> { dest, index } or null when that folder cannot take them.
function placeSpot( ids, anchorId, where )
{
    const anchor = node( anchorId );
    if( ! anchor || anchorId === ROOT || ids.indexOf( anchorId ) >= 0 ) return null;
    if( where === 'after' && ui.open.indexOf( anchorId ) >= 0 && childrenOf( anchorId ).some( isFolder ) )
        return canMove( ids, anchorId ) ? { dest: anchorId, index: 0 } : null;
    if( ! canMove( ids, anchor.parentId ) ) return null;
    return { dest: anchor.parentId, index: -1 };
}

// Moves `ids` next to `anchorId` (see placeSpot). The anchor's place is looked
// up AFTER the moved ones leave, so a move within one folder lands right.
function placeNodes( ids, anchorId, where )
{
    const spot = placeSpot( ids, anchorId, where );
    if( ! spot ) return null;
    const dest = node( spot.dest );
    for( const id of ids )
    {
        const n = node( id ), from = n && node( n.parentId );
        if( from ) from.children = from.children.filter( function( x ) { return x !== id; } );
    }
    let at = spot.index >= 0 ? spot.index : dest.children.indexOf( anchorId ) + ( where === 'after' ? 1 : 0 );
    for( const id of ids )
    {
        if( ! node( id ) ) continue;
        node( id ).parentId = spot.dest;
        dest.children.splice( at++, 0, id );
    }
    return spot.dest;
}

// -> what was taken, for putBack(): each item's place, and a copy of it and
// of everything below it.
function removeNodes( ids )
{
    const rec = { places: [], nodes: {} };
    for( const id of ids )
    {
        const n = node( id );
        if( ! n || id === ROOT ) continue;
        const from = node( n.parentId );
        rec.places.push( { id: id, parentId: n.parentId, index: from ? from.children.indexOf( id ) : -1 } );
        for( const g of [ n ].concat( isFolder( n ) ? descendants( id ) : [] ) )
        {
            rec.nodes[ g.id ] = JSON.parse( JSON.stringify( g ) );
            delete data.nodes[ g.id ];
        }
        if( from ) from.children = from.children.filter( function( x ) { return x !== id; } );
    }
    return rec;
}

// Undo of removeNodes: only what it took goes back, each to its old place
// (or the root, if that folder has gone since), onto the file AS IT IS NOW -
// whatever was done after the removal stays. Newest removal first, so an item
// taken from a folder that went later lands back inside it.
function putBack( rec )
{
    for( const id of Object.keys( rec.nodes ) )
        if( ! data.nodes[ id ] ) data.nodes[ id ] = JSON.parse( JSON.stringify( rec.nodes[ id ] ) );
    for( let i = rec.places.length - 1; i >= 0; i-- )
    {
        const p = rec.places[ i ], n = node( p.id );
        if( ! n ) continue;
        const dest = isFolder( node( p.parentId ) ) ? node( p.parentId ) : node( ROOT );
        if( dest.children.indexOf( p.id ) >= 0 ) continue;
        n.parentId = dest.id;
        dest.children.splice( p.index >= 0 && p.index <= dest.children.length ? p.index : dest.children.length, 0, p.id );
    }
    data = repair( data );
}

// Folders `rec` left empty (and the folders THEY leave empty) go too; added
// to `rec`, so putBack() restores them first. -> how many went.
function dropEmptied( rec )
{
    let n = 0;
    const seen = new Set();
    for( let i = 0; i < rec.places.length; i++ )
    {
        const f = node( rec.places[ i ].parentId );
        if( ! f || f.id === ROOT || seen.has( f.id ) || f.children.length ) continue;
        seen.add( f.id );
        const more = removeNodes( [ f.id ] );
        rec.places.push( more.places[ 0 ] );       // looked at in turn: its own folder may be empty now
        Object.assign( rec.nodes, more.nodes );
        n++;
    }
    return n;
}

//------------------------------------------------------------------------//
// URLS

// What the user typed (or a file held), as a URL we will keep: "example.com"
// and "nas.local:5000" -> "https://…". A scheme counts only with "//" after
// it or when it is one that never has them (mailto:, tel:…): "nas.local:" is
// a host, not a scheme. null for a script / data URL - judged on the PARSED
// scheme, so "java<tab>script:" is caught too - or for no address at all.
const BARE_SCHEMES = /^(https?|mailto|tel|sms|magnet|about|news|geo|urn|webcal|feed):/i;
const REFUSED      = [ 'javascript:', 'data:', 'vbscript:', 'blob:' ];

function normalizeUrl( raw )
{
    let s = String( raw || '' ).trim();
    if( ! s ) return null;
    if( ! /^[a-z][a-z0-9+.-]*:\/\//i.test( s ) && ! BARE_SCHEMES.test( s ) ) s = 'https://' + s.replace( /^\/+/, '' );
    try
    {
        const u = new URL( s );
        if( REFUSED.indexOf( u.protocol ) >= 0 ) return null;
        if( ( u.protocol === 'http:' || u.protocol === 'https:' ) && ! u.hostname ) return null;
        return u.href;
    }
    catch( e ) { return null; }
}

// What a card may open: the web, mail, phone. Anything else a file brought in
// (chrome://, file://, one this app refuses) stays saved but is not opened.
function isOpenable( url )
{
    try { return [ 'http:', 'https:', 'ftp:', 'mailto:', 'tel:', 'sms:' ].indexOf( new URL( url ).protocol ) >= 0; }
    catch( e ) { return false; }
}

function hostOf( url )
{
    try { return new URL( url ).host.toLowerCase(); } catch( e ) { return ''; }
}

// The domain as shown: no "www.".
function domainOf( url ) { return hostOf( url ).replace( /^www\./, '' ); }

// Two URLs are "the same" when they differ only in host case, "www.",
// http vs https, or a trailing "/".
function dupKey( url )
{
    try
    {
        const u = new URL( url );
        if( u.protocol !== 'http:' && u.protocol !== 'https:' ) return url.trim();
        const host = u.host.toLowerCase().replace( /^www\./, '' );
        const path = u.pathname.replace( /\/+$/, '' );
        return host + path + u.search + u.hash;
    }
    catch( e ) { return String( url ).trim(); }
}

// A hue from the domain, like Contacts' initials.
function hueOf( s )
{
    let h = 0;
    for( let i = 0; i < s.length; i++ ) h = ( h * 31 + s.charCodeAt( i ) ) >>> 0;
    return h % 360;
}

function initialOf( n )
{
    const s = ( domainOf( n.url ) || n.title || '?' ).replace( /^[^\p{L}\p{N}]+/u, '' );
    return ( s.charAt( 0 ) || '?' ).toUpperCase();
}

//------------------------------------------------------------------------//
// SEARCH  -  accent-insensitive, every word must match. "#tag" matches tags
// only (from the start of the tag).

function fold( s ) { return String( s || '' ).normalize( 'NFD' ).replace( /[̀-ͯ]/g, '' ).toLowerCase(); }

function makeMatcher( q )
{
    const words = fold( q ).split( /\s+/ ).filter( Boolean );
    if( ! words.length ) return null;
    return function( n )
    {
        const tags = isFolder( n ) ? [] : n.tags.map( fold );
        const hay  = isFolder( n ) ? fold( n.title )
                   : fold( n.title ) + '\n' + fold( n.url ) + '\n' + tags.join( '\n' ) + '\n' + fold( n.notes );
        return words.every( function( w )
        {
            if( w.charAt( 0 ) === '#' )
            {
                const t = w.slice( 1 );
                return !! t && tags.some( function( x ) { return x.indexOf( t ) === 0; } );
            }
            return hay.indexOf( w ) >= 0;
        } );
    };
}

// A tag chip's search: that one tag, whole - #go is not #google, and
// "web dev" is one tag, not two words.
function tagMatcher( tag )
{
    const t = fold( tag );
    return function( n ) { return ! isFolder( n ) && n.tags.some( function( x ) { return fold( x ) === t; } ); };
}

// Newest / oldest first; an unknown date ("") last either way.
function byDate( newest )
{
    return function( a, b )
    {
        const x = a.createdAt || '', y = b.createdAt || '';
        if( ! x || ! y ) return x ? -1 : y ? 1 : 0;
        return newest ? y.localeCompare( x ) : x.localeCompare( y );
    };
}

//------------------------------------------------------------------------//
// DUPLICATES  -  groups of bookmarks with the same dupKey, each with the one
// kept by default: a copy OUTSIDE the folder an import just made (the one
// the user filed stays where it is filed), then the favourite, then the
// oldest.

function findDuplicates( newFolder )
{
    const by = new Map();
    for( const b of allBookmarks() )
    {
        if( ! b.url ) continue;
        const k = dupKey( b.url );
        if( ! by.has( k ) ) by.set( k, [] );
        by.get( k ).push( b );
    }
    const groups = [];
    for( const list of by.values() )
    {
        if( list.length < 2 ) continue;
        list.sort( byDate( false ) );
        const filed = newFolder ? list.filter( function( b ) { return ! isInside( b.id, newFolder ); } ) : [];
        const pool  = filed.length ? filed : list;
        const keep  = pool.find( function( b ) { return b.favorite; } ) || pool[ 0 ];
        groups.push( { items: list, keep: keep.id } );
    }
    return groups;
}

// The other copies' tags, notes and star go to the kept one, then they go.
// `rec` (from removeNodes) gathers what went, plus `kept`: the kept ones'
// fields as they were, for the Undo.
function mergeGroup( items, keepId, rec )
{
    const keep = node( keepId );
    if( ! keep ) return 0;
    rec.kept.push( { id: keep.id, tags: keep.tags.slice(), notes: keep.notes, favorite: keep.favorite, title: keep.title } );
    const drop = [];
    for( const b of items )
    {
        if( b.id === keepId || ! node( b.id ) ) continue;
        keep.tags = cleanTags( keep.tags.concat( b.tags ) );
        const note = ( b.notes || '' ).trim();
        if( note && ( keep.notes || '' ).indexOf( note ) < 0 ) keep.notes = keep.notes ? keep.notes + '\n' + note : note;
        if( b.favorite ) keep.favorite = true;
        if( ! keep.title && b.title ) keep.title = b.title;
        drop.push( b.id );
    }
    const r = removeNodes( drop );
    rec.places = rec.places.concat( r.places );
    Object.assign( rec.nodes, r.nodes );
    return drop.length;
}

// Undo of a merge: the kept ones get their fields back, the others return.
function unmerge( rec )
{
    for( const k of rec.kept )
    {
        const n = node( k.id );
        if( n ) { n.tags = k.tags; n.notes = k.notes; n.favorite = k.favorite; n.title = k.title; }
    }
    putBack( rec );
}

// The bookmark already saved at this URL (not `exceptId`), or null.
function findByUrl( url, exceptId )
{
    const k = dupKey( url );
    return allBookmarks().find( function( b ) { return b.id !== exceptId && b.url && dupKey( b.url ) === k; } ) || null;
}

//------------------------------------------------------------------------//
// PER-DEVICE VIEW CHOICES  -  localStorage, every access in try/catch.

let ui = { mode: 'grid', sort: 'saved', open: [], treeW: 0 };

function loadUi()
{
    try
    {
        const s = JSON.parse( localStorage.getItem( UI_KEY ) || '{}' );
        if( s && typeof s === 'object' )
        {
            if( s.mode === 'grid' || s.mode === 'list' ) ui.mode = s.mode;
            if( [ 'saved', 'az', 'za', 'new', 'old' ].indexOf( s.sort ) >= 0 ) ui.sort = s.sort;
            if( Array.isArray( s.open ) ) ui.open = s.open.filter( function( x ) { return typeof x === 'string'; } );
            if( s.treeW > 0 ) ui.treeW = s.treeW;
        }
    }
    catch( e ) {}
}

function saveUi()
{
    try { localStorage.setItem( UI_KEY, JSON.stringify( ui ) ); } catch( e ) {}
}

// The open folders this device remembers, less the ones that are gone.
function pruneOpen()
{
    const keep = ui.open.filter( function( id ) { return isFolder( node( id ) ); } );
    if( keep.length !== ui.open.length ) { ui.open = keep; saveUi(); }
}
