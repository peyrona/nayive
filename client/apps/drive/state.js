/*
 * state.js - Drive: the T / TF string helpers, the page state, the "Drive" root and
 * pruning rules, and the phone-layout helpers.
 */
"use strict";

// Interface strings: every one of them lives in shared/i18n/*.json.
const T  = k           => NayiveUI.t( k );
const TF = ( k, vars ) => NayiveUI.tf( k, vars );

//------------------------------------------------------------------------//
// STATE

let dirTreeRoot     = null;          // FOLDERS-ONLY recursive tree (left pane), from ?tree=dirs
let IS_ADMIN        = false;         // set from the tree root's `role` field

// The open folder's own contents (files + sub-folders, one level), from
// ?dir=. The right pane renders straight from this — the folders-only
// tree above no longer carries file nodes (D4 phase 2).
let curListing      = { path: null, nodes: [] };
let listingLoading  = false;
let listingSeq      = 0;             // guards against an out-of-order folder load landing late

// The folder shown to the user AS "Drive". Admin sees the real server root
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
let expandedFolders = new Set( [''] );
let selectedPaths   = new Set();      // paths selected in the current listing
let searchQuery     = '';            // when non-empty, the listing shows server-side name matches
let searchHits      = null;          // array of match nodes while a search is active, else null
let searchTruncated = false;         // the server capped the result list
let searchSeq       = 0;             // guards against a stale search response landing late
let searchTimer     = null;          // debounce for the search box
let advSearch       = null;          // the advanced search in force: { draft, spec, summary, nFilters } (listing.js)
let bigMode         = false;         // the "Biggest files" list is on screen (listing.js, openBigFiles)
let trashMode       = false;         // the "Papelera" view is open instead of the file tree
let trashItems      = [];            // entries from GumApi.trashList() while trashMode is on
let trashDays       = null;          // auto-delete period (days) shown in the Papelera bar
let dragPaths       = null;          // paths being drag-moved inside Drive (null = not an internal drag)
let kbdPane         = 'list';        // which pane the arrow keys drive: 'tree' (folders) | 'list' (files)
let kbdTreePath     = null;          // tree row under the keyboard cursor while kbdPane === 'tree'

// A search of any kind - the box's own, the advanced one, or the "Biggest
// files" list - is on screen.
function isSearching() { return !! searchQuery.trim() || !! advSearch || bigMode; }

// Phone layout: the folder tree becomes a slide-in sheet, the search field
// collapses behind a magnifier, the app launchers are hidden (see @media ≤640px).
const PHONE = window.matchMedia( '(max-width: 640px)' );
function isPhone() { return PHONE.matches; }

function openTreeSheet()
{
    document.getElementById( 'treePane'     ).classList.add( 'open' );
    document.getElementById( 'treeBackdrop' ).classList.add( 'open' );
}
function closeTreeSheet()
{
    document.getElementById( 'treePane'     ).classList.remove( 'open' );
    document.getElementById( 'treeBackdrop' ).classList.remove( 'open' );
}

// Open a file / editor URL. On a phone there is no visible way back from a new
// browser tab, so navigate in place — the browser's Back button returns to Drive.
function openDoc( url )
{
    if( isPhone() ) location.href = url;
    else            window.open( url, '_blank' );
}
