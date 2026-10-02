/* actions.js - navigation, sheet helpers, trip and stage actions. */

//------------------------------------------------------------------------//
// NAVIGATION

function goToDetail( tripId ) { hoveredStageId = null; selectedTripId = tripId; view = 'detail'; renderAll(); refreshViewerPos( true ); }
function goToList()           { hoveredStageId = null; view = 'list'; renderAll(); }

function renderAll() { renderHeader(); renderContent(); renderRoutePanel(); }

//------------------------------------------------------------------------//
// SHEET HELPERS

function openSheet( sId )  { NayiveUI.open( sId ); }     // impl in shared/ui.js
function closeSheet( sId ) { NayiveUI.close( sId ); }

//------------------------------------------------------------------------//
// TRIP ACTIONS

let tripDraft         = null;
let tripOpen          = null;   // the trip as the sheet opened it, moved on by each merge (patchDraft)
let isEditingTrip     = false;
let tripDocsCollapsed = true;   // the trip sheet's doc list starts folded

function openAddTrip()
{
    tripDraft = { id: null, destination: '', startDate: '', endDate: '', documents: [] };
    tripOpen  = null;
    isEditingTrip = false;
    tripDocsCollapsed = true;
    tripSaveError = '';
    tripSheetBusy = false;
    renderTripSheet();
    openSheet( 'tripSheetBackdrop' );
}

function openEditTrip()
{
    const t = findTrip( selectedTripId );

    if( ! t )
        return;

    tripDraft = { ...t, documents: ( t.documents || [] ).map( function( d ) { return { ...d }; } ) };
    tripOpen  = JSON.parse( JSON.stringify( t ) );
    isEditingTrip = true;
    tripDocsCollapsed = true;
    tripSaveError = '';
    tripSheetBusy = false;
    renderTripSheet();
    openSheet( 'tripSheetBackdrop' );
}

function closeTripSheet() { closeSheet( 'tripSheetBackdrop' ); tripDraft = null; tripOpen = null; tripSaveError = ''; tripSheetBusy = false; }

function addTripDoc()      { tripDraft.documents.push( { id: newId(), name: '', type: 'passport' } ); tripDocsCollapsed = false; renderTripSheet(); }

// The "+" beside "Documentos" on the trip detail screen. The document rows live
// in the trip sheet (that is where a name is typed and a type picked), so this
// opens it with one blank row already waiting.
function addTripDocFromDetail()
{
    openEditTrip();
    if( tripDraft ) addTripDoc();
}
function removeTripDoc(id) { tripDraft.documents = tripDraft.documents.filter( function( d ) { return d.id !== id; } ); renderTripSheet(); }

let tripSaveError = '';

// Editing an already-saved trip goes through the store, so it works offline.
// Creating one makes its directory server-side first (GumApi.makeDir), so a
// brand-new trip needs a live connection.
async function saveTrip()
{
    if( ! tripDraft.destination.trim() || ! tripDraft.startDate || ! tripDraft.endDate )
        return;

    if( tripDraft.endDate < tripDraft.startDate )
    {
        tripSaveError = T( 'trips.endBeforeStart' );
        renderTripSheet();
        return;
    }

    tripSaveError = '';
    setTripSheetBusy( true );

    if( isEditingTrip )
    {
        const original = findTrip( tripDraft.id );

        // The trip as saved: the sheet's draft (dirName carried over unchanged from the
        // original trip). The trip's own lat/lon only ever back the map's "no stages
        // yet" fallback pin, geocoded from this destination text (see
        // ensureRouteCoords()) - if the text just changed, drop the old coordinates
        // rather than show a stale pin.
        const build = function( docs )
        {
            const u = { ...tripDraft, documents: docs };
            if( original && original.destination !== u.destination )
            {
                delete u.lat;
                delete u.lon;
            }
            return u;
        };
        let updated = build( tripDraft.documents );

        // Removed in THIS sheet: rows of its opening copy (moved on by each merge,
        // patchDraft) that the trip still has and the draft does not - never a
        // document another device added meanwhile (H6: its file went to the bin).
        const nowIds  = new Set( ( original ? original.documents : [] ).map( function( d ) { return d.id; } ) );
        const oldDocs = ( tripOpen ? tripOpen.documents || [] : original ? original.documents : [] )
                            .filter( function( d ) { return nowIds.has( d.id ); } );

        // Attachments (upload a picked file / delete a removed one) need the network;
        // a text-only edit still saves offline through the store.
        if( docFilesDirty( updated.documents, oldDocs ) )
        {
            if( ! navigator.onLine )
            {
                tripSaveError = T( 'trips.filesNeedNet' );
                setTripSheetBusy( false );
                return;
            }

            try
            {
                const stored = await syncDocFiles( tripBase( original || updated ), updated.documents, oldDocs,
                                                   allTripDocs( { stages: original ? original.stages : [] } ) );

                // Another device's save merged in during the upload patched the
                // draft (persistence.js onTripMerged): built again from it, with
                // the names the uploads got, or that is lost.
                if( tripDraft ) updated = build( tripDraft.documents );
                storedNames( updated.documents, stored );
            }
            catch( _ )
            {
                setSyncStatus( 'error' );
                tripSaveError = T( 'trips.uploadFailed' );
                setTripSheetBusy( false );
                return;
            }
        }

        persistTrip( updated );   // cached now, uploaded now or on reconnect
        trips = trips.map( function( t ) { return t.id === updated.id ? updated : t; } );

        const oldIds = ( original ? original.documents : [] ).map( function( d ) { return d.id; } );
        if( updated.documents.some( function( d ) { return oldIds.indexOf( d.id ) === -1; } ) )
            expandSection( 'docs' );

        closeTripSheet();
        renderAll();
        syncActiveTripDocs();
        return;
    }

    try
    {
        const dirName = resolveNewTripDirName( tripDraft.destination, tripDraft.startDate );
        const created = { ...tripDraft, id: newId(), stages: [], dirName: dirName, _base: 'data/trips/' + dirName };

        await GumApi.makeDir( 'data/trips', dirName );
        await syncDocFiles( tripBase( created ), created.documents, [], [] );
        await persistTrip( created );

        trips = [ ...trips, created ];
        if( created.documents.length ) expandSection( 'docs' );
        closeTripSheet();
        renderAll();
        syncActiveTripDocs();
    }
    catch( _ )
    {
        setSyncStatus( 'error' );
        tripSaveError = navigator.onLine
            ? T( 'trips.createFailed' )
            : T( 'trips.createNeedsNet' );
        setTripSheetBusy( false );
    }
}

async function deleteTrip()
{
    const trip = findTrip( selectedTripId );

    if( ! trip )
        return;

    // From the trip's sheet the button goes at once, so a second tap must not
    // send a second delete while the first is out.
    if( tripDraft )
    {
        if( tripSheetBusy ) return;
        setTripSheetBusy( true );
    }

    setSyncStatus( 'saving' );

    // The bin ids of the trip folder, for the Undo (null from an old server).
    let ids = null;

    try
    {
        // Its own folder (tripBase), never 'data/trips/' + dirName: a restored
        // copy's dirName named the OTHER trip's folder (H7).
        ids = await GumApi.binPaths( tripBase( trip ) );
        await store.forget( tripBase( trip ) + '/trip.json' );
        trips = trips.filter( function( t ) { return t.id !== trip.id; } );
        setSyncStatus( 'synced' );
        syncActiveTripDocs();
    }
    catch( _ )
    {
        // Deletion failed server-side - the trip is untouched, so stay right where we
        // are instead of navigating away as if it had worked (that would read as success).
        setSyncStatus( 'error' );

        // Only touch the trip sheet's own busy/error UI when delete was actually triggered
        // from inside it (tripDraft is null when this came from the detail header's trash
        // icon instead - renderTripSheet() would crash reading a null tripDraft.destination).
        if( tripDraft )
        {
            tripSaveError = T( 'trips.deleteFailed' );
            setTripSheetBusy( false );
        }

        return;
    }

    view = 'list';
    closeTripSheet();
    renderAll();

    // From the detail header the question stays (a whole trip goes); from inside
    // the trip's own sheet that sheet was the question. The Undo covers the slip. The whole
    // folder went to the bin - trip.json, its files, positions.json - so restoring
    // it brings all of that back. Shares and the public /s/ link live on the
    // server and point at the folder, so they work again once it is back.
    if( ! ids || ! ids.length )
    {
        NayiveUI.toast( T( 'ui.toast.binned' ) );
        return;
    }

    NayiveUI.undoToast( T( 'ui.toast.binned' ), function()
    {
        GumApi.trashRestore( ids )
            .then( loadTrips )
            .catch( function() { setSyncStatus( 'error' ); NayiveUI.toast( T( 'trips.restoreFailed' ) ); } );
    });
}

//------------------------------------------------------------------------//
// STAGE ACTIONS

let stageDraft         = null;
let stageOpen          = null;   // the stage as the sheet opened it, moved on by each merge (patchDraft)
let editingStageId     = null;
let stageSaveError     = '';
let stageSheetBusy     = false;
let stageDocsCollapsed = true;   // the doc list starts folded when a stage has >1 document

function openAddStage()
{
    // lat/lon start undefined, not null: undefined means "never resolved, retry later"
    // (ensureRouteCoords picks it up on the next map render), while null means the
    // geocoder gave a definite no-match and there is no point asking again. Seeding
    // null here left a stage saved before its lookup returned - or saved offline -
    // without a pin forever. JSON.stringify drops undefined keys, so it persists as absent.
    stageDraft = { id: null, location: '', startDate: '', startTime: '', endDate: '', endTime: '', transport: 'other', tz: null, tzLabel: '', tzStatus: 'idle', lat: undefined, lon: undefined, accommodation: '', notes: '', enabled: true, documents: [] };
    stageOpen  = null;
    editingStageId = null;
    stageSaveError = '';
    stageDocsCollapsed = true;
    renderStageSheet();
    openSheet( 'stageSheetBackdrop' );
}

function openEditStage( stageId )
{
    const trip = findTrip( selectedTripId );
    const st   = trip.stages.find( function( s ) { return s.id === stageId; } );

    if( ! st )
        return;

    // Reuse whatever timezone this stage already has (found earlier, or from the sample
    // data) without re-querying the geocoder on every open - a fresh lookup only fires if
    // the user edits the location text again.
    stageDraft = {
        ...st,
        tzStatus: st.tz ? 'found' : 'idle',
        tzLabel: st.tzLabel || st.tz || '',
        documents: ( st.documents || [] ).map( function( d ) { return { ...d }; } )
    };
    stageOpen = JSON.parse( JSON.stringify( st ) );
    editingStageId = stageId;
    stageSaveError = '';
    stageDocsCollapsed = true;
    renderStageSheet();
    openSheet( 'stageSheetBackdrop' );
}

function closeStageSheet() { closeSheet( 'stageSheetBackdrop' ); stageDraft = null; stageOpen = null; editingStageId = null; stageSaveError = ''; stageSheetBusy = false; }

function addStageDoc()      { stageDraft.documents.push( { id: newId(), name: '', type: 'ticket' } ); stageDocsCollapsed = false; renderStageSheet(); }
function removeStageDoc(id) { stageDraft.documents = stageDraft.documents.filter( function( d ) { return d.id !== id; } ); renderStageSheet(); }

async function saveStage()
{
    if( stageSheetBusy )
        return;

    if( ! stageDraft.location.trim() || ! stageDraft.startDate || ! stageDraft.endDate )
        return;

    if( stageDateTimeKey( stageDraft.endDate, stageDraft.endTime ) < stageDateTimeKey( stageDraft.startDate, stageDraft.startTime ) )
    {
        stageSaveError = T( 'trips.endBeforeStartTime' );
        renderStageSheet();
        return;
    }

    stageSaveError = '';

    // Stage documents live in the (already-existing) trip folder. Uploading or
    // deleting one needs the network; a text-only stage edit still saves offline.
    const parentTrip   = findTrip( selectedTripId );
    const originalStage = editingStageId && parentTrip
        ? parentTrip.stages.find( function( s ) { return s.id === stageDraft.id; } ) : null;

    // Removed in THIS sheet: rows of its opening copy (moved on by each merge,
    // patchDraft) that the stage still has and the draft does not - never a
    // document another device added meanwhile (H6: its file went to the bin).
    const nowIds  = new Set( ( originalStage ? originalStage.documents : [] ).map( function( d ) { return d.id; } ) );
    const oldDocs = ( stageOpen ? stageOpen.documents || [] : [] ).filter( function( d ) { return nowIds.has( d.id ); } );
    const others  = parentTrip ? ( parentTrip.documents || [] ).concat( ...parentTrip.stages
                        .filter( function( s ) { return s.id !== stageDraft.id; } )
                        .map( function( s ) { return s.documents || []; } ) ) : [];

    if( docFilesDirty( stageDraft.documents, oldDocs ) )
    {
        if( ! navigator.onLine )
        {
            stageSaveError = T( 'trips.filesNeedNet' );
            renderStageSheet();
            return;
        }

        stageSheetBusy = true;
        renderStageSheet();

        try
        {
            const stored = await syncDocFiles( tripBase( parentTrip ), stageDraft.documents, oldDocs, others );
            if( ! stageDraft ) return;                    // closed meanwhile (Escape)
            storedNames( stageDraft.documents, stored );  // a merge meanwhile may have swapped the rows (patchDraft)
        }
        catch( _ )
        {
            stageSheetBusy = false;
            stageSaveError = T( 'trips.uploadFailed' );
            if( stageDraft ) renderStageSheet();
            return;
        }

        stageSheetBusy = false;
    }

    mutateTrip( selectedTripId, function( t )
    {
        let stages;

        if( editingStageId )
        {
            // Deleted on another device while this sheet was open: it comes
            // back, as edited here - an edit is never lost to a delete.
            const there = t.stages.some( function( st ) { return st.id === stageDraft.id; } );
            stages = there ? t.stages.map( function( st ) { return st.id === stageDraft.id ? { ...stageDraft } : st; } )
                           : [ ...t.stages, { ...stageDraft } ];
        }
        else
        {
            // New stages are appended at the end - order is otherwise entirely
            // manual (drag the grip handle, see reorderStage), never re-sorted
            // automatically, so a reorder the user made is never silently undone.
            stages = [ ...t.stages, { ...stageDraft, id: newId() } ];
        }

        return { ...t, stages };
    });

    closeStageSheet();
}

// No question: it goes at once, and the Undo puts it back at its place. Its
// documents' files are never touched here (they stay in the trip folder).
function deleteStage( stageId )
{
    const tripId = selectedTripId;
    let removed  = null;
    let at       = -1;

    mutateTrip( tripId, function( t )
    {
        at = t.stages.findIndex( function( st ) { return st.id === stageId; } );
        if( at === -1 ) return t;
        removed = t.stages[ at ];
        return { ...t, stages: t.stages.filter( function( st ) { return st.id !== stageId; } ) };
    });

    if( ! removed ) return;

    NayiveUI.undoToast( T( 'ui.toast.deleted' ), function()
    {
        mutateTrip( tripId, function( t )
        {
            if( t.stages.some( function( st ) { return st.id === removed.id; } ) ) return t;
            const stages = [ ...t.stages ];
            stages.splice( Math.min( at, stages.length ), 0, removed );
            return { ...t, stages };
        });
    });
}

// The trash button on a stage card's document row.
function deleteStageDoc( stageId, doc ) { return deleteDocWithUndo( stageId, doc ); }

// The trash button on a trip-level document row (trip detail -> "Documentos").
function deleteTripDoc( doc ) { return deleteDocWithUndo( null, doc ); }

// Both of the above (stageId null = the trip's own list). No question: the row
// goes at once and the Undo puts it back at its place. Same rules as removing the
// row in a sheet and saving: an uploaded file goes to the bin too (needs the
// network) and the Undo brings it back from there; a link just goes - the linked
// file stays in the user's files.
async function deleteDocWithUndo( stageId, doc )
{
    const trip  = findTrip( selectedTripId );
    const stage = trip && stageId !== null ? trip.stages.find( function( s ) { return s.id === stageId; } ) : null;
    const docs  = stageId === null ? ( trip && trip.documents ) : ( stage && stage.documents );
    if( ! docs ) return;

    const tripId = trip.id;
    const at     = docs.indexOf( doc );                                     // by identity: names can repeat
    if( at === -1 ) return;

    let ids = null;                                                        // the file's bin id, for the Undo

    // A file name another document of the trip still uses (two lists once
    // shared one, D2) is not this row's alone: only the row goes.
    const file   = docStoredFile( doc );
    const shared = !! file && allTripDocs( trip ).some( function( x ) { return x !== doc && docStoredFile( x ) === file; } );

    if( ! shared && docFilesDirty( docs.filter( function( x ) { return x !== doc; } ), docs ) )
    {
        if( ! navigator.onLine )
        {
            NayiveUI.toast( T( 'trips.filesNeedNet' ) );
            return;
        }

        // Straight to the bin (not syncDocFiles) so the Undo knows its bin id.
        // A failure is not fatal, as there: never uploaded / already gone.
        try { ids = await GumApi.binPaths( tripBase( trip ) + '/' + file ); }
        catch( _ ) { ids = null; }
    }

    editDocs( tripId, stageId, function( list ) { return list.filter( function( x ) { return x !== doc; } ); } );

    NayiveUI.undoToast( T( 'ui.toast.deleted' ), function()
    {
        editDocs( tripId, stageId, function( list )
        {
            if( list.indexOf( doc ) !== -1 ) return list;
            const out = [ ...list ];
            out.splice( Math.min( at, out.length ), 0, doc );
            return out;
        });

        if( ids && ids.length )
            GumApi.trashRestore( ids ).catch( function() { setSyncStatus( 'error' ); NayiveUI.toast( T( 'trips.restoreFailed' ) ); } );
    });
}

// fn( documents ) -> the new document list of the trip (stageId null) or of that stage.
function editDocs( tripId, stageId, fn )
{
    mutateTrip( tripId, function( t )
    {
        if( stageId === null ) return { ...t, documents: fn( t.documents || [] ) };
        return { ...t, stages: t.stages.map( function( st ) { return st.id === stageId ? { ...st, documents: fn( st.documents || [] ) } : st; } ) };
    });
}

function deleteStageFromSheet()
{
    const id = editingStageId;
    closeStageSheet();
    deleteStage( id );
}

// A stage is "enabled" unless it carries enabled === false. A disabled stage is
// kept in the trip and the list (collapsed), but drops out of the route map. The
// flag is deliberately generic - future features may hang more off it.
function stageEnabled( st ) { return st.enabled !== false; }

function toggleStage( stageId )
{
    mutateTrip( selectedTripId, function( t )
    {
        return { ...t, stages: t.stages.map( function( st )
        {
            return st.id === stageId ? { ...st, enabled: ! stageEnabled( st ) } : st;
        }) };
    });
}

// Drop `stageId` immediately before / after `targetStageId` in the itinerary.
// Ids are numbers but arrive here as strings from dataset - compare as strings.
function reorderStage( stageId, targetStageId, bBefore )
{
    const sId = String( stageId );
    const tId = String( targetStageId );

    if( sId === tId )
        return;

    const tripId = selectedTripId;
    let   oldAt  = -1;          // where it was, for the Undo; stays -1 when nothing moved

    mutateTrip( tripId, function( t )
    {
        const stages = [ ...t.stages ];
        const from   = stages.findIndex( function( st ) { return String( st.id ) === sId; } );

        if( from === -1 )
            return t;

        const [ moved ] = stages.splice( from, 1 );

        let to = stages.findIndex( function( st ) { return String( st.id ) === tId; } );

        if( to === -1 )
            return t;

        if( ! bBefore )
            to += 1;

        stages.splice( to, 0, moved );

        if( to !== from ) oldAt = from;   // dropped right beside itself = same order

        return { ...t, stages };
    });

    if( oldAt === -1 )
        return;

    // Undo moves this one stage back to where it was.
    NayiveUI.undoToast( T( 'ui.toast.moved' ), function()
    {
        mutateTrip( tripId, function( t )
        {
            const stages = [ ...t.stages ];
            const now    = stages.findIndex( function( st ) { return String( st.id ) === sId; } );

            if( now === -1 )
                return t;

            const [ moved ] = stages.splice( now, 1 );
            stages.splice( Math.min( oldAt, stages.length ), 0, moved );

            return { ...t, stages };
        });
    });
}
