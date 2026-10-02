/* persistence.js - load / save each trip.json, and the offline copies of the active trip's PDFs. */

//------------------------------------------------------------------------//
// PERSISTENCE - each trip is its own directory under data/trips/ (data/trips/{dirName}/trip.json),
// per explicit requirement: "each travel and all its associated files exist inside its
// own dir". One recursive listing of data/trips (see loadTrips) discovers which trip
// directories exist on load. dirName is assigned
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
            paths = err && err.status === 404 ? [] : null;
        }

        // Trips other people shared with us. They live in THEIR home and we
        // only ever read them (server/go/shares.go + ResolvePath). Outside the
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
                const t = tripShape( JSON.parse( res.body ) );
                // Where this trip's documents live, and whether it is ours
                // to change. A "shared/..." path is someone else's trip.
                t._base = path.replace( /\/trip\.json$/, '' );
                t._ro   = t._base.indexOf( 'shared/' ) === 0;
                loaded.push( t );
            }
            catch( _ ) { /* one unreadable/corrupt trip.json must not take down the list */ }
        }
    }

    const reIded = repairTrips( loaded );
    trips = loaded;
    reIded.forEach( persistTrip );   // a new id must stay: saved at once (see repairTrips)
    applyOpenParam();

    if( paths.length === 0 )                 // nothing to read -> the store never emitted
        setSyncStatus( navigator.onLine ? 'synced' : 'offline' );

    renderAll();
    syncActiveTripDocs();   // background: keep only the current/next trip's PDFs on the device
}

// THE FOLDER A trip.json WAS READ FROM IS THE TRUTH (H7, list-apps #23). A trip
// folder restored from the bin onto a taken name comes back as
// "<dir> (restaurado …)" while its trip.json still names the old folder, and
// every write went by that name - into the OTHER trip's folder ("Delete trip"
// binned the other trip). Every write now goes to tripBase(); dirName is
// repaired here from the folder (Journey asks the server by it). Two of our own
// trips with one id (a trip re-made, then its old copy restored) were saved as
// one (mutateTrip maps by id): one of them - the one whose folder had to be
// repaired, else the later folder - gets the smallest free id above it. The
// same pick on every device, so two devices that do it agree; returned to be
// saved at once, or the next load would pick again.
function repairTrips( list )
{
    const own   = list.filter( function( t ) { return ! t._ro; } );
    const moved = new Set();

    own.forEach( function( t )
    {
        const dir = t._base.slice( t._base.lastIndexOf( '/' ) + 1 );
        if( t.dirName !== dir ) { t.dirName = dir; moved.add( t ); }
    } );

    const ids   = new Set( list.map( function( t ) { return t.id; } ) );
    const byId  = new Map();
    const reIded = [];
    own.forEach( function( t ) { if( ! byId.has( t.id ) ) byId.set( t.id, [] ); byId.get( t.id ).push( t ); } );

    byId.forEach( function( group )
    {
        if( group.length < 2 ) return;
        group.sort( function( a, b ) { return a._base < b._base ? -1 : 1; } );
        const keep = group.find( function( t ) { return ! moved.has( t ); } ) || group[ 0 ];

        group.forEach( function( t )
        {
            if( t === keep ) return;
            let id = Number( keep.id );
            if( ! Number.isFinite( id ) ) id = newId();
            while( ids.has( id ) ) id++;
            ids.add( id );
            t.id = id;
            reIded.push( t );
        } );
    } );

    return reIded;
}

// Every screen reads a trip's stages and documents as lists, each stage's
// documents too: a trip.json without one (written by hand, or cut short)
// gets an empty list rather than blanking the whole trip list.
function tripShape( t )
{
    if( ! Array.isArray( t.stages ) )    t.stages    = [];
    if( ! Array.isArray( t.documents ) ) t.documents = [];
    t.stages.forEach( function( st ) { if( st && ! Array.isArray( st.documents ) ) st.documents = []; } );
    return t;
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
    const grants = await NayiveUI.sharedWithMe( true );   // asked again on every read: [] on any failure
    return grants
        .filter( function( g ) { return g.app === 'trips' && ! g.gone; } )
        .map( function( g ) { sharedOwners[ g.path ] = g.by; return g.path + '/trip.json'; } );
}

// TWO DEVICES, ONE TRIP (shared/store.js MERGE). Both saved trip.json from the
// same copy: both changes are kept - stages and documents one by one, by id; a
// stage or document changed on both takes, field by field, the side that changed
// it, mine when both did; the trip's own fields likewise. null = a side that is
// not a trip: nothing is merged over it.
function mergeTrip( path, base, mine, theirs )
{
    const S     = NayiveStore;
    const parse = function( t ) { try { const v = JSON.parse( t ); return v && typeof v === 'object' && ! Array.isArray( v ) ? v : null; } catch( _ ) { return null; } };
    const m = parse( mine ), t = parse( theirs ), b = base == null ? null : parse( base );
    if( ! m || ! t ) return null;

    const byId = function( x ) { return x && x.id; };
    const list = function( bl, ml, tl, both )
    {
        return S.mergeLists( Array.isArray( bl ) ? bl : ( b ? [] : null ), Array.isArray( ml ) ? ml : [], Array.isArray( tl ) ? tl : [],
                             { id: byId, both: both || S.mergeFields } );
    };
    const docs  = function( bl, ml, tl ) { return list( bl, ml, tl ); };
    const stage = function( bs, ms, ts ) { return S.mergeFields( bs, ms, ts, { documents: docs } ); };

    const merged = S.mergeFields( b, m, t );
    // The lists always, not only where both sides changed them: one side's new
    // stage and the other's edited one are both changes inside `stages`.
    if( m.stages || t.stages )       merged.stages    = list( b && b.stages, m.stages, t.stages, stage );
    if( m.documents || t.documents ) merged.documents = docs( b && b.documents, m.documents, t.documents );
    return JSON.stringify( merged, null, 2 );
}

// The store merged another device's save of a trip in: that trip from now on.
// An open trip or stage sheet keeps what it has edited and takes the rest from
// the merged trip (patchDraft), or saving it would drop that.
function onTripMerged( path, body )
{
    let t;
    try { t = JSON.parse( body ); } catch( _ ) { return; }
    if( ! t || typeof t !== 'object' ) return;
    tripShape( t );
    t._base = path.replace( /\/trip\.json$/, '' );
    t._ro   = t._base.indexOf( 'shared/' ) === 0;

    const old = trips.find( function( x ) { return tripBase( x ) === t._base; } );
    if( ! old ) return;
    t.dirName = old.dirName;   // the folder's own name (repairTrips), not what the file says

    const redrawTrip = !! ( tripDraft && tripOpen && tripDraft.id === old.id && patchDraft( tripDraft, tripOpen, t ) );
    let   redrawStage = false;

    if( stageDraft && stageOpen && editingStageId && old.id === selectedTripId )
    {
        const st = t.stages.find( function( s ) { return s.id === stageDraft.id; } );
        if( st ) redrawStage = patchDraft( stageDraft, stageOpen, st );
    }

    trips = trips.map( function( x ) { return x === old ? t : x; } );
    if( ! anySheetOpen() ) renderAll();
    if( redrawTrip  && tripDraft )  renderTripSheet();
    if( redrawStage && stageDraft ) renderStageSheet();
}

// A MERGE LANDED UNDER AN OPEN SHEET (H6, list-apps #22). The sheet's `draft`
// takes the merged value of every field it has not changed (draft equal to
// `open`, the copy the sheet opened with), and its document list is merged
// with the merged one against `open` (a row the other device added or re-typed
// comes in; one this sheet removed stays out). `open` then becomes the merged
// copy. Saving the stale draft used to drop the other device's edits, and its
// new document counted as "removed here" - its file went to the bin. True when
// the draft changed (the sheet is drawn again from it).
function patchDraft( draft, open, merged )
{
    const S      = NayiveStore;
    const before = JSON.stringify( draft );

    Object.keys( merged ).forEach( function( k )
    {
        if( k.charAt( 0 ) === '_' ) return;

        if( k === 'documents' )
        {
            const mine = new Set( draft.documents || [] );
            draft.documents = S.mergeLists( open.documents || [], draft.documents || [], merged.documents || [],
                                            { id: function( d ) { return d && d.id; }, both: S.mergeFields } )
                               .map( function( d ) { return mine.has( d ) ? d : Object.assign( {}, d ); } );   // never the trip's own objects
        }
        else if( JSON.stringify( draft[ k ] ) === JSON.stringify( open[ k ] ) )
            draft[ k ] = merged[ k ];

        open[ k ] = JSON.parse( JSON.stringify( merged[ k ] === undefined ? null : merged[ k ] ) );
    } );

    return JSON.stringify( draft ) !== before;
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
    if( doc.kind === undefined && doc.name ) return legacySlug( doc.name ) + '.pdf';   // legacy scheme
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
// sheet opened. `folder` is the trip's own (tripBase) and must already exist; online
// only - guarded by callers. `otherDocs`: every document of the trip outside this
// list (allTripDocs). Returns { <doc id>: the file name it was stored under }, for
// the caller to lay on its draft as it is after the awaits (a merge may have
// swapped the row objects meanwhile, onTripMerged).
async function syncDocFiles( folder, newDocs, oldDocs, otherDocs )
{
    const kept   = new Set( newDocs.map( docStoredFile ).filter( Boolean ) );
    const others = new Set( ( otherDocs || [] ).map( docStoredFile ).filter( Boolean ) );
    const stored = {};

    for( const d of ( oldDocs || [] ) )
    {
        const f = docStoredFile( d );

        // A name another document of the trip still uses is not this row's file
        // alone (two lists once shared one, D2): it stays.
        if( f && ! kept.has( f ) && ! others.has( f ) )
        {
            try { await GumApi.deletePaths( folder + '/' + f ); }
            catch( _ ) { /* never uploaded / already gone - not fatal */ }
        }
    }

    const pending = newDocs.filter( function( d ) { return d._pending; } );
    if( ! pending.length ) return stored;

    // D2 (list-apps #4): a PUT replaces a file for good, so an upload never takes
    // a name in use - by any document of the trip, or by any file in its folder
    // as the server has it NOW (another device's upload, trip.json itself).
    const listing = await GumApi.listDir( folder );
    const taken   = new Set( others );
    for( const n of listing.nodes || [] ) taken.add( n.name || String( n.path || '' ).split( '/' ).pop() );
    for( const d of newDocs ) if( ! d._pending && docStoredFile( d ) ) taken.add( docStoredFile( d ) );

    for( const d of pending )
    {
        if( taken.has( d.file ) ) d.file = uniqueFileName( d.file, [], taken );
        taken.add( d.file );

        const bytes = new Uint8Array( await d._pending.arrayBuffer() );
        await GumApi.writeFileBytes( folder + '/' + d.file, bytes );
        delete d._pending;
        stored[ d.id ] = d.file;
    }

    return stored;
}

// syncDocFiles' answer laid on a document list: each uploaded row gets its file
// name and is no longer pending (the list may hold copies of the rows it saw).
function storedNames( docs, stored )
{
    ( docs || [] ).forEach( function( d )
    {
        if( ! Object.prototype.hasOwnProperty.call( stored, d.id ) ) return;
        d.file = stored[ d.id ];
        delete d._pending;
    } );
}

//------------------------------------------------------------------------//
// OFFLINE DOCUMENTS - keep only the ACTIVE trip's PDFs on the device: the
// trip happening today, or else the next one due to start. Other trips'
// documents are still one tap away while online, just not worth the phone
// storage. The service worker answers trips/**.pdf from this same cache.

const TRIP_DOCS_CACHE = 'nayive-trips-docs';

function pickActiveTrip( list )
{
    const today = NayiveUI.todayIso();

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
// the trip's own folder when editing (tripBase, H7), or a live preview of what a brand
// new trip would get right now (which can shift while typing, since it depends on what
// other trips exist - that's fine, it's only ever committed for real at actual save time).
function tripDraftFolderPreview()
{
    return isEditingTrip ? tripBase( tripDraft ) : 'data/trips/' + resolveNewTripDirName( tripDraft.destination, tripDraft.startDate );
}
