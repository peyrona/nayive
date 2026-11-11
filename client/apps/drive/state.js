/*
 * state.js - Drive: the T / TF string helpers, the page state, the "Home" root and
 * pruning rules, and the phone-layout helpers.
 */
"use strict";

// Interface strings: every one of them lives in shared/i18n/*.json.
const T  = k           => Ayni.t( k );
const TF = ( k, vars ) => Ayni.tf( k, vars );

//------------------------------------------------------------------------//
// STATE

let dirTreeRoot     = null;          // FOLDERS-ONLY recursive tree (not drawn; findNode, "Move to…"), from ?tree=dirs
let IS_ADMIN        = false;         // set from the tree root's `role` field

// The open folder's own contents (files + sub-folders, one level), from
// ?dir=. The listing renders straight from this — the folders-only
// tree above no longer carries file nodes (D4 phase 2).
let curListing      = { path: null, nodes: [] };
let listingLoading  = false;
let listingSeq      = 0;             // guards against an out-of-order folder load landing late

// The folder shown to the user AS "Home". Admin sees the real server root
// (''); a regular user's documents live under files/, so we show that node
// as the root and hide the "Files" wrapper. Real paths kept as-is (the
// server still wants the `files/` prefix) — only the display is rerooted.
let FS_ROOT = '';
function computeFsRoot() { FS_ROOT = ( ! IS_ADMIN && findNode( 'files' ) ) ? 'files' : ''; }
function fsRel( path )                // strip the FS_ROOT prefix, for display only
{
    if( ! FS_ROOT || path === FS_ROOT ) return path === FS_ROOT ? '' : path;
    return path.indexOf( FS_ROOT + '/' ) === 0 ? path.slice( FS_ROOT.length + 1 ) : path;
}

// The server sends everything this session may see. For a regular user
// that already excludes other homes; we additionally hide their own data/
// folder (app data — tasks.json, calendar.ics, trips/…) and any
// dotfiles/dot-dirs (e.g. files/.bak). Admin sees everything.
// Every listing / tree / search result is filtered through pruneNodes so
// the rule lives in one place.
function pruneNodes( nodes )
{
    if( ! Array.isArray( nodes ) ) return [];
    if( IS_ADMIN ) return nodes.slice();

    return nodes.filter( function( n )
    {
        var name = n.path.split( '/' ).pop();
        if( name.charAt( 0 ) === '.' ) return false;
        return n.path !== 'data' && n.path.indexOf( 'data/' ) !== 0;
    } );
}

function pruneTreeInPlace( node )
{
    if( ! node || ! Array.isArray( node.nodes ) ) return node;
    node.nodes = pruneNodes( node.nodes );
    node.nodes.forEach( pruneTreeInPlace );
    return node;
}

function scopeTree( raw )
{
    IS_ADMIN = !! ( raw && raw.role === 'admin' );
    return pruneTreeInPlace( raw );
}
let currentFolder   = '';            // path relative to file-manager root ('' = root)
let selectedPaths   = new Set();      // paths selected in the current listing
let searchQuery     = '';            // when non-empty, the listing shows server-side name matches
let searchHits      = null;          // array of match nodes while a search is active, else null
let searchTruncated = false;         // the server capped the result list
let searchSeq       = 0;             // guards against a stale search response landing late
let searchTimer     = null;          // debounce for the search box
let advSearch       = null;          // the advanced search in force: { draft, spec, summary, nFilters } (listing.js)
let driveSearch     = null;          // the header search field: { open, close, isOpen, filtered } (Ayni.searchField, init.js)
let bigMode         = false;         // the "Biggest files" list is on screen (listing.js, openBigFiles)
let trashMode       = false;         // the "Papelera" view is open instead of the folder
let trashItems      = [];            // entries from AyniNet.trashList() while trashMode is on

// How the listing shows: 'grid' (icons, the default) or 'list' (rows with
// size and date). Kept per device; the bin and "Biggest files" are always a
// list (their rows carry buttons / the size they are about).
const VIEW_KEY = 'drive-view';
let viewMode = ( function() { try { return localStorage.getItem( VIEW_KEY ) === 'list' ? 'list' : 'grid'; } catch( _ ) { return 'grid'; } } )();

function setViewMode( m )
{
    viewMode = m === 'list' ? 'list' : 'grid';
    try { localStorage.setItem( VIEW_KEY, viewMode ); } catch( _ ) {}
    if( viewMode === 'grid' ) closeAllDirs();
    render();
}

// The list is a tree-list: a folder row opens in place, its children under
// it (listing.js toggleDir). openDirs = the folders open now; dirKids = their
// one-level contents (null while loading). Both reset on a new folder.
let openDirs = new Set();
let dirKids  = new Map();
let dirKidsSeq = 0;              // a newer load of the same folder wins

function closeAllDirs() { openDirs = new Set(); dirKids = new Map(); dirKidsSeq++; }

// A search of any kind - the box's own, the advanced one, or the "Biggest
// files" list - is on screen.
function isSearching() { return !! searchQuery.trim() || !! advSearch || bigMode; }

// Phone layout: the search field collapses behind a magnifier and the view
// switch moves into the ⋮ (see @media ≤640px).
const PHONE = window.matchMedia( '(max-width: 640px)' );
function isPhone() { return PHONE.matches; }


// Open a file / editor URL. On a phone there is no visible way back from a new
// browser tab, so navigate in place — the browser's Back button returns to Drive.
function openDoc( url )
{
    if( isPhone() ) location.href = url;
    else            window.open( url, '_blank' );
}
