/* actions.js - confirm dialog, navigation, sheet helpers, trip and stage actions. */

//------------------------------------------------------------------------//
// CONFIRM DIALOG - a small yes/no sheet used before every destructive delete
// (trips and stages). Only its two buttons (or Escape) close it.

let confirmOnYes = null;

function openConfirm( sTitle, sMessage, sYesLabel, fnYes )
{
    confirmOnYes = fnYes;

    const sheet = document.getElementById( 'confirmSheet' );
    sheet.innerHTML = '';

    const h2 = document.createElement( 'h2' );
    h2.textContent = sTitle;
    sheet.appendChild( h2 );

    const p = document.createElement( 'p' );
    p.className = 'confirm-msg';
    p.textContent = sMessage;
    sheet.appendChild( p );

    const actions = document.createElement( 'div' );
    actions.className = 'sheet-actions';

    const cancelBtn = document.createElement( 'button' );
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.title = NayiveUI.t( 'ui.cancel' );
    cancelBtn.appendChild( svgIcon( ICON_X, 17 ) );
    cancelBtn.addEventListener( 'click', closeConfirm );

    const yesBtn = document.createElement( 'button' );
    yesBtn.className = 'btn btn-danger';
    yesBtn.title = sYesLabel || NayiveUI.t( 'ui.delete' );
    yesBtn.appendChild( svgIcon( ICON_TRASH, 17 ) );
    yesBtn.addEventListener( 'click', function()
    {
        const fn = confirmOnYes;
        closeConfirm();
        if( fn ) fn();
    });

    actions.appendChild( cancelBtn );
    actions.appendChild( yesBtn );
    sheet.appendChild( actions );

    openSheet( 'confirmSheetBackdrop' );
}

function closeConfirm() { closeSheet( 'confirmSheetBackdrop' ); confirmOnYes = null; }

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
let isEditingTrip     = false;
let tripDocsCollapsed = true;   // the trip sheet's doc list starts folded

function openAddTrip()
{
    tripDraft = { id: null, destination: '', startDate: '', endDate: '', documents: [] };
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
    isEditingTrip = true;
    tripDocsCollapsed = true;
    tripSaveError = '';
    tripSheetBusy = false;
    renderTripSheet();
    openSheet( 'tripSheetBackdrop' );
}

function closeTripSheet() { closeSheet( 'tripSheetBackdrop' ); tripDraft = null; tripSaveError = ''; tripSheetBusy = false; }

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
// Creating one needs its directory made server-side first (Gum's file write
// does NOT auto-create parents), so a brand-new trip needs a live connection.
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
        const updated  = { ...tripDraft };   // dirName carried over unchanged from the original trip

        // The trip's own lat/lon only ever back the map's "no stages yet" fallback
        // pin, geocoded from this destination text (see ensureRouteCoords()) - if the
        // text just changed, drop the old coordinates rather than show a stale pin.
        if( original && original.destination !== updated.destination )
        {
            delete updated.lat;
            delete updated.lon;
        }

        // Attachments (upload a picked file / delete a removed one) need the network;
        // a text-only edit still saves offline through the store.
        if( docFilesDirty( updated.documents, original ? original.documents : [] ) )
        {
            if( ! navigator.onLine )
            {
                tripSaveError = T( 'trips.filesNeedNet' );
                setTripSheetBusy( false );
                return;
            }

            try
            {
                await syncDocFiles( updated.dirName, updated.documents, original ? original.documents : [] );
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
        const created = { ...tripDraft, id: newId(), stages: [], dirName: dirName };

        await GumApi.makeDir( 'data/trips', dirName );
        await syncDocFiles( dirName, created.documents, [] );
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

    setSyncStatus( 'saving' );

    try
    {
        await GumApi.deletePaths( 'data/trips/' + trip.dirName );
        await store.forget( 'data/trips/' + trip.dirName + '/trip.json' );
        trips = trips.filter( function( t ) { return t.id !== selectedTripId; } );
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
}

//------------------------------------------------------------------------//
// STAGE ACTIONS

let stageDraft         = null;
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
    editingStageId = stageId;
    stageSaveError = '';
    stageDocsCollapsed = true;
    renderStageSheet();
    openSheet( 'stageSheetBackdrop' );
}

function closeStageSheet() { closeSheet( 'stageSheetBackdrop' ); stageDraft = null; editingStageId = null; stageSaveError = ''; stageSheetBusy = false; }

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
    const oldDocs = originalStage ? originalStage.documents : [];

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
            await syncDocFiles( parentTrip.dirName, stageDraft.documents, oldDocs );
        }
        catch( _ )
        {
            stageSheetBusy = false;
            stageSaveError = T( 'trips.uploadFailed' );
            renderStageSheet();
            return;
        }

        stageSheetBusy = false;
    }

    mutateTrip( selectedTripId, function( t )
    {
        let stages;

        if( editingStageId )
        {
            stages = t.stages.map( function( st ) { return st.id === stageDraft.id ? { ...stageDraft } : st; } );
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

function deleteStage( stageId )
{
    mutateTrip( selectedTripId, function( t )
    {
        return { ...t, stages: t.stages.filter( function( st ) { return st.id !== stageId; } ) };
    });
}

// The trash button on a stage card's document row. Same rules as removing the row in
// the stage sheet and saving: an uploaded file is deleted too (needs the network),
// a link just goes - the linked file stays in the user's files.
async function deleteStageDoc( stageId, doc )
{
    const trip  = findTrip( selectedTripId );
    const stage = trip && trip.stages.find( function( s ) { return s.id === stageId; } );
    if( ! stage ) return;

    const oldDocs = stage.documents;
    const newDocs = oldDocs.filter( function( x ) { return x !== doc; } );   // by identity: names can repeat

    if( docFilesDirty( newDocs, oldDocs ) )
    {
        if( ! navigator.onLine )
        {
            NayiveUI.toast( T( 'trips.filesNeedNet' ) );
            return;
        }

        await syncDocFiles( trip.dirName, newDocs, oldDocs );
    }

    mutateTrip( trip.id, function( t )
    {
        return { ...t, stages: t.stages.map( function( st ) { return st.id === stageId ? { ...st, documents: newDocs } : st; } ) };
    });
}

// The trash button on a trip-level document row (trip detail -> "Documentos").
// Same rules as deleteStageDoc.
async function deleteTripDoc( doc )
{
    const trip = findTrip( selectedTripId );
    if( ! trip ) return;

    const oldDocs = trip.documents;
    const newDocs = oldDocs.filter( function( x ) { return x !== doc; } );   // by identity: names can repeat

    if( docFilesDirty( newDocs, oldDocs ) )
    {
        if( ! navigator.onLine )
        {
            NayiveUI.toast( T( 'trips.filesNeedNet' ) );
            return;
        }

        await syncDocFiles( trip.dirName, newDocs, oldDocs );
    }

    mutateTrip( trip.id, function( t ) { return { ...t, documents: newDocs }; } );
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

    mutateTrip( selectedTripId, function( t )
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

        return { ...t, stages };
    });
}
