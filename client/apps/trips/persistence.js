/* persistence.js - load / save each trip.json, and the offline copies of the active trip's PDFs. */

//------------------------------------------------------------------------//
// PERSISTENCE - each trip is its own directory under data/trips/ (data/trips/{dirName}/trip.json),
// per explicit requirement: "each travel and all its associated files exist inside its
// own dir". The file API has no "list a folder" call, only "GET the whole file tree",
// so that's what discovers which trip directories exist on load. dirName is assigned
// ONCE at creation (see resolveNewTripDirName) and stored on the trip itself - it is
// NEVER recomputed from destination/date later, because collision-avoidance numbering
// (japan-2026, japan-2026-2, ...) depends on what else exists at creation time, and
// silently recomputing it later could point at the wrong folder.

async function loadTrips()
{
    // Which trip.json files to load. Online: the server's file tree. Offline
    // (or if that call fails): every trip.json the store already has cached.
    let paths = null;

    if( navigator.onLine )
    {
        try
        {
            // Just the data/trips subtree (one call), never the whole
            // account tree - that walked every photo folder too.
            const tripAppNode = await GumApi.listDirRecursive( 'data/trips' );
            const tripDirs = (tripAppNode.nodes || []).filter( function( n ) { return Array.isArray( n.nodes ); } );

            paths = tripDirs
                .filter( function( dn ) { return (dn.nodes || []).some( function( n ) { return n.path === dn.path + '/trip.json'; } ); } )
                .map( function( dn ) { return dn.path + '/trip.json'; } );
        }
        catch( err )
        {
            // No data/trips folder yet (a fresh account) = no trips, not
            // "offline": don't fall back to the cache in that case.
            paths = String( err && err.message ).indexOf( 'HTTP 404' ) !== -1 ? [] : null;
        }

        // Trips other people shared with us. They live in THEIR home and we
        // only ever read them (lib/shares.py + resolve_path). Outside the
        // try above on purpose: someone with no trips of their own takes
        // the 404 branch, and must still see what was shared with them.
        if( paths !== null ) paths = paths.concat( await sharedTripPaths() );
    }

    if( paths === null )
    {
        const cached = await store.listCached( 'data/trips/' );
        paths = cached.filter( function( p ) { return /\/trip\.json$/.test( p ); } );
    }

    const loaded = [];

    for( const path of paths )
    {
        const res = await store.read( path );

        if( res.body )
        {
            try
            {
                const t = JSON.parse( res.body );
                // Where this trip's documents live, and whether it is ours
                // to change. A "shared/..." path is someone else's trip.
                t._base = path.replace( /\/trip\.json$/, '' );
                t._ro   = t._base.indexOf( 'shared/' ) === 0;
                loaded.push( t );
            }
            catch( _ ) { /* one unreadable/corrupt trip.json must not take down the list */ }
        }
    }

    trips = loaded;
    applyOpenParam();

    if( paths.length === 0 )                 // nothing to read -> the store never emitted
        setSyncStatus( navigator.onLine ? 'synced' : 'offline' );

    renderAll();
    syncActiveTripDocs();   // background: keep only the current/next trip's PDFs on the device
}

/* Deep link: ?open=<trip folder> lands straight on that trip's detail
 * screen. Drive's "Compartido conmigo" uses it to open a shared trip
 * ("shared/<slug>"), but any trip folder works. Applied ONCE, right after
 * the first load: a later reload must not drag the user back here, and an
 * unknown folder just leaves the list on screen. */
const OPEN_PARAM = new URLSearchParams( location.search ).get( 'open' ) || '';
let openParamUsed = false;

function applyOpenParam()
{
    if( openParamUsed || ! OPEN_PARAM ) return;
    openParamUsed = true;

    const t = trips.find( function( x ) { return tripBase( x ) === OPEN_PARAM; } );
    if( t ) { selectedTripId = t.id; view = 'detail'; refreshViewerPos( false ); }   // no tap here: never prompt
}

/* Every trip.json another user shared with us: "shared/<slug>/trip.json".
 * A share is a row on the server (GET /api/shares); a failure here just
 * means no shared trips, never a broken trip list. */
// "shared/<slug>" -> the name of the user who shared it, filled by
// sharedTripPaths() so the detail header can say who it came from.
const sharedOwners = {};
function sharedBy( trip ) { return sharedOwners[ tripBase( trip ) ] || ''; }

async function sharedTripPaths()
{
    try
    {
        const r = await fetch( window.location.origin + '/api/shares' );
        if( ! r.ok ) return [];
        const j = await r.json();
        return ( j.with_me || [] )
            .filter( function( g ) { return g.app === 'trips' && ! g.gone; } )
            .map( function( g ) { sharedOwners[ g.path ] = g.by; return g.path + '/trip.json'; } );
    }
    catch( _ ) { return []; }
}

// Writes ONE trip's full current state back to its own trip/{dirName}/trip.json.
// Goes through the store: cached immediately, uploaded now or on reconnect.
// The directory itself must already exist - see resolveNewTripDirName().
function persistTrip( trip )
{
    // A trip another user shared with us is never written back. Without
    // this the old hard-coded 'data/trips/' path would quietly create a
    // COPY of their trip inside our own home instead of failing.
    if( tripIsRO( trip ) ) return Promise.resolve();

    // `_pending` holds a not-yet-uploaded File on a document draft - never serialise it.
    return store.write( tripBase( trip ) + '/trip.json',
        JSON.stringify( trip, function( k, v ) { return k === '_pending' ? undefined : v; }, 2 ) );
}

// The in-folder file name an UPLOADED (or legacy) document occupies, or null for a link.
function docStoredFile( doc )
{
    if( docIsLink( doc ) ) return null;
    if( doc.file ) return doc.file;
    if( doc.kind === undefined && doc.name ) return slugify( doc.name ) + '.pdf';   // legacy scheme
    return null;
}

// True when saving would need to touch the trip folder (upload a picked file, or
// delete the file of a document that was removed / turned into a link since the
// sheet opened). Callers use it to require a connection only when it matters.
function docFilesDirty( newDocs, oldDocs )
{
    if( newDocs.some( function( d ) { return d._pending; } ) )
        return true;

    const kept = new Set( newDocs.map( docStoredFile ).filter( Boolean ) );
    return ( oldDocs || [] ).some( function( d )
    {
        const f = docStoredFile( d );
        return f && ! kept.has( f );
    });
}

// Uploads freshly-picked files and deletes the files of documents removed since the
// sheet opened. `dirName`'s folder must already exist. Online only - guarded by callers.
async function syncDocFiles( dirName, newDocs, oldDocs )
{
    const kept = new Set( newDocs.map( docStoredFile ).filter( Boolean ) );

    for( const d of ( oldDocs || [] ) )
    {
        const f = docStoredFile( d );

        if( f && ! kept.has( f ) )
        {
            try { await GumApi.deletePaths( 'data/trips/' + dirName + '/' + f ); }
            catch( _ ) { /* never uploaded / already gone - not fatal */ }
        }
    }

    for( const d of newDocs )
    {
        if( ! d._pending ) continue;

        const bytes = new Uint8Array( await d._pending.arrayBuffer() );
        await GumApi.writeFileBytes( 'data/trips/' + dirName + '/' + d.file, bytes );
        delete d._pending;
    }
}

//------------------------------------------------------------------------//
// OFFLINE DOCUMENTS - keep only the ACTIVE trip's PDFs on the device: the
// trip happening today, or else the next one due to start. Other trips'
// documents are still one tap away while online, just not worth the phone
// storage. The service worker answers trips/**.pdf from this same cache.

const TRIP_DOCS_CACHE = 'nayive-trips-docs';

function pickActiveTrip( list )
{
    const today = todayIso();

    const current = list.find( function( t )
    {
        return t.startDate && t.endDate && t.startDate <= today && today <= t.endDate;
    });

    if( current )
        return current;

    return list
        .filter( function( t ) { return t.startDate && t.startDate >= today; } )
        .sort( function( a, b ) { return a.startDate < b.startDate ? -1 : 1; } )[ 0 ] || null;
}

function tripDocUrls( trip )
{
    const stageDocs = ( trip.stages || [] ).reduce( function( acc, st ) { return acc.concat( st.documents || [] ); }, [] );
    const allDocs   = ( trip.documents || [] ).concat( stageDocs );

    return allDocs
        .filter( function( d ) { return docHasFile( d ) && ! d._pending; } )
        .map( function( d ) { return new URL( docHref( trip, d ), document.baseURI ).toString(); } );
}

async function syncActiveTripDocs()
{
    if( ! ( 'caches' in window ) || ! navigator.onLine )
        return;

    const active = pickActiveTrip( trips );
    const wanted = new Set( active ? tripDocUrls( active ) : [] );

    try
    {
        const cache = await caches.open( TRIP_DOCS_CACHE );

        for( const url of wanted )
        {
            if( await cache.match( url ) )
                continue;

            try
            {
                const res = await fetch( url, { credentials: 'same-origin' } );
                if( res.ok ) await cache.put( url, res.clone() );
            }
            catch( _ ) { /* a document that isn't on the server yet just 404s when tapped */ }
        }

        for( const req of await cache.keys() )
        {
            if( ! wanted.has( req.url ) )
                await cache.delete( req );
        }
    }
    catch( _ ) { /* Cache API unavailable - skip */ }
}

// Applies fn to the trip identified by tripId (fn returns the new trip object), updates
// the UI immediately, and persists that one trip's file in the background - the pattern
// for every STAGE-level change (add/edit/delete/reorder a stage, which never touches the
// trip's own directory or name). Trip-level create/rename/delete are handled separately
// in saveTrip()/deleteTrip() since those must manage the directory itself.
function mutateTrip( tripId, fn )
{
    let updated = null;

    trips = trips.map( function( t )
    {
        if( t.id !== tripId )
            return t;

        updated = fn( t );
        return updated;
    });

    renderAll();

    // No optimistic rollback any more: persistTrip() caches the change
    // locally right away and the store re-uploads it on reconnect, so a
    // reload can't "silently undo" it even if the PUT fails now. The sync
    // dot (store-driven) shows offline / pending / error.
    if( updated )
        persistTrip( updated );
}

let syncState = 'synced';   // last known state - reapplied whenever renderHeader() rebuilds the indicator

function setSyncStatus( sState )
{
    syncState = sState;

    const el = document.getElementById( 'syncIndicator' );

    if( el )
        NayiveUI.applySyncState( el, sState );
}

// The header is rebuilt on every render, so the indicator is too - which is why the
// click lands here and not in a one-off init. It is a <button>: the plug IS the
// refresh control (it replaced the old "Recargar", which only reloaded the page).
function buildSyncIndicator()
{
    const sync = document.createElement( 'button' );
    sync.id = 'syncIndicator';
    sync.type = 'button';
    sync.className = 'sync-indicator';   // shared/ui.js fills in the plug glyph
    sync.addEventListener( 'click', function() { if( refresher ) refresher.refreshNow(); } );
    NayiveUI.applySyncState( sync, syncState );
    return sync;
}

// Picks the folder name for a BRAND NEW trip: "destination-year", or "-2", "-3"... if
// that name is already used by another trip currently known in memory (which is always
// kept in sync with disk - see loadTrips()/persistTrip()). Computed once at creation
// time only; see the PERSISTENCE comment above for why it is never recomputed later.
function resolveNewTripDirName( sDestination, sStartDate )
{
    const base  = dirNameFor( sDestination, sStartDate );
    const taken = new Set( trips.map( function( t ) { return t.dirName; } ) );

    if( ! taken.has( base ) )
        return base;

    let n = 2;

    while( taken.has( base + '-' + n ) )
        n++;

    return base + '-' + n;
}

// What folder the trip currently open in the Add/Edit Trip sheet will be saved under -
// the already-assigned, stable name when editing, or a live preview of what a brand new
// trip would get right now (which can shift while typing, since it depends on what other
// trips exist - that's fine, it's only ever committed for real at actual save time).
function tripDraftDirNamePreview()
{
    return isEditingTrip ? tripDraft.dirName : resolveNewTripDirName( tripDraft.destination, tripDraft.startDate );
}
