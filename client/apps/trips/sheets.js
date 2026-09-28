/* sheets.js - the trip sheet and the stage sheet. */

//------------------------------------------------------------------------//
// RENDERING - TRIP SHEET

let tripSheetBusy = false;

function setTripSheetBusy( b )
{
    tripSheetBusy = b;
    renderTripSheet();   // safe here: only ever called right after a Save click or its
                          // failure, never mid-keystroke, so there is no focus to preserve
}

function renderTripSheet()
{
    const sheet = document.getElementById( 'tripSheet' );
    sheet.innerHTML = '';

    const h2 = document.createElement( 'h2' );
    h2.textContent = isEditingTrip ? T( 'trips.editTrip' ) : T( 'trips.newTrip' );
    sheet.appendChild( h2 );

    if( tripSaveError )
    {
        const err = document.createElement( 'p' );
        err.className = 'calc-warn';
        err.textContent = tripSaveError;
        sheet.appendChild( err );
    }

    // The label reads "Descripcion" now, but the key and the stored field stay
    // `destination`: that is what names the trip's folder (resolveNewTripDirName)
    // and what the currency lookup geocodes, so renaming it would be a data
    // migration, not a wording change.
    sheet.appendChild( textField( T( 'trips.destination' ), T( 'trips.destinationPh' ), tripDraft.destination, function( v ) { tripDraft.destination = v; refreshTripDocPaths(); } ) );

    const dateRow = document.createElement( 'div' );
    dateRow.className = 'field-row';
    dateRow.appendChild( dateField( T( 'trips.startDate' ), tripDraft.startDate, function( v ) { tripDraft.startDate = v; refreshTripDocPaths(); } ) );
    dateRow.appendChild( dateField( T( 'trips.endDate' ), tripDraft.endDate, function( v ) { tripDraft.endDate = v; } ) );
    sheet.appendChild( dateRow );

    // "Save where I am": on unless switched off. The server keeps the trip's
    // positions (a location app, photos with GPS) for its Journey map; only an OFF is
    // written - on is the key left out (server/go/positions.go).
    const trackLab = document.createElement( 'label' );
    trackLab.className = 'share-add';
    const trackBox = document.createElement( 'input' );
    trackBox.type    = 'checkbox';
    trackBox.checked = tripDraft.track !== false;
    trackBox.addEventListener( 'change', function()
    {
        if( trackBox.checked ) delete tripDraft.track; else tripDraft.track = false;
    });
    const trackInfo = document.createElement( 'button' );
    trackInfo.className = 'info-dot';
    trackInfo.setAttribute( 'data-info', T( 'trips.trackInfo' ) );
    trackLab.appendChild( trackBox );
    trackLab.appendChild( document.createTextNode( T( 'trips.track' ) ) );
    trackLab.appendChild( trackInfo );
    sheet.appendChild( trackLab );

    // A plain "Documentos" heading: the "+" and the info dot live beside the one
    // on the trip detail screen, which is also where this sheet is opened from.
    // The rows stay - this is where a document gets its name and its type.
    const tripDocRows = tripDraft.documents.map( function( d )
    {
        return buildDocRow( d, function( v ) { d.type = v; }, function() { removeTripDoc( d.id ); }, tripDraftDirNamePreview, renderTripSheet, function() { return tripDraft.documents; } );
    });

    const tripDocsField = buildDocsField( tripDocRows, [], tripDocsCollapsed, function( b ) { tripDocsCollapsed = b; } );
    tripDocsField.classList.add( 'trip-docs-field' );
    sheet.appendChild( tripDocsField );

    const actions = document.createElement( 'div' );
    actions.className = 'sheet-actions';

    if( isEditingTrip )
    {
        const delBtn = document.createElement( 'button' );
        delBtn.className = 'btn btn-danger sheet-actions-left';
        delBtn.title = T( 'trips.deleteTrip' );
        delBtn.disabled = tripSheetBusy;
        delBtn.appendChild( svgIcon( ICON_TRASH, 17 ) );
        // Already inside a dialog: no second question, it goes at once with an Undo.
        delBtn.addEventListener( 'click', deleteTrip );
        actions.appendChild( delBtn );
    }

    const cancelBtn = document.createElement( 'button' );
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.title = NayiveUI.t( 'ui.cancel' );
    cancelBtn.disabled = tripSheetBusy;
    cancelBtn.appendChild( svgIcon( ICON_X, 17 ) );
    cancelBtn.addEventListener( 'click', closeTripSheet );

    const saveBtn = document.createElement( 'button' );
    saveBtn.className = 'btn btn-primary';
    saveBtn.title = tripSheetBusy ? T( 'ui.sync.saving' ) : T( 'ui.save' );
    saveBtn.disabled = tripSheetBusy;
    saveBtn.appendChild( svgIcon( ICON_CHECK, 18 ) );
    saveBtn.addEventListener( 'click', saveTrip );

    actions.appendChild( cancelBtn );
    actions.appendChild( saveBtn );
    sheet.appendChild( actions );
}

// Updates the visible "will be stored at ..." preview under each UPLOAD document row
// as the user types the destination/start date (a new trip's folder name shifts with
// it), without rebuilding the sheet - that would drop the focused input's cursor.
// Only upload rows have a .doc-row-path element; it carries data-doc-id so a link row
// between two uploads doesn't throw off the matching.
function refreshTripDocPaths()
{
    const dirName = tripDraftDirNamePreview();

    tripDraft.documents.forEach( function( d )
    {
        const el = document.querySelector( '#tripSheet .doc-row-path[data-doc-id="' + d.id + '"]' );
        if( el ) el.textContent = docPath( 'data/trips/' + dirName, d );
    });
}

//------------------------------------------------------------------------//
// RENDERING - STAGE SHEET

// Debounced timezone auto-detection: fires ~600ms after typing stops in the Location
// field, so a live geocoding lookup isn't fired on every keystroke. stageTzLookupSeq
// guards against a slower, earlier lookup overwriting a faster, later one.
let stageTzDebounceTimer = null;
let stageTzLookupSeq     = 0;

// Never call renderStageSheet() from these - they fire on every keystroke in Location
// (via the debounce below) and rebuilding the whole sheet would drop that input's focus
// mid-keystroke, same issue as the destination/document-name fields. They only ever
// touch the #stageTzStatus element directly.
function scheduleStageTzLookup()
{
    clearTimeout( stageTzDebounceTimer );

    const loc = stageDraft.location.trim();

    if( ! loc )
    {
        stageDraft.tz = null;
        stageDraft.tzLabel = '';
        stageDraft.tzStatus = 'idle';
        stageDraft.lat = undefined;   // nothing to look up yet - not the same as "no match"
        stageDraft.lon = undefined;
        refreshTzStatusDisplay();
        return;
    }

    stageDraft.tzStatus = 'loading';
    refreshTzStatusDisplay();

    stageTzDebounceTimer = setTimeout( runStageTzLookup, 600 );
}

async function runStageTzLookup()
{
    const loc    = stageDraft.location.trim();
    const mySeq  = ++stageTzLookupSeq;
    const result = await geocodeLocation( loc, stageDraft.startDate );

    if( mySeq !== stageTzLookupSeq || ! stageDraft )
        return;   // superseded by a newer lookup, or the sheet was closed meanwhile

    if( result && result.unreachable )
    {
        // Offline / service down: keep whatever tz the stage already had,
        // don't wipe it to "not-found".
        stageDraft.tzStatus = 'offline';

        // Same for the coordinates - real ones are kept - but a stage that never had any
        // must be left at undefined ("retry later"), never null, or saving it now would
        // pin it as unlocatable forever: ensureRouteCoords only retries lat === undefined.
        if( typeof stageDraft.lat !== 'number' || typeof stageDraft.lon !== 'number' )
        {
            stageDraft.lat = undefined;
            stageDraft.lon = undefined;
        }
    }
    else if( result )
    {
        stageDraft.tz = result.timezone;
        stageDraft.tzLabel = result.label;
        stageDraft.tzStatus = 'found';
        stageDraft.lat = result.lat;
        stageDraft.lon = result.lon;
    }
    else
    {
        stageDraft.tz = null;
        stageDraft.tzLabel = '';
        stageDraft.tzStatus = 'not-found';
        stageDraft.lat = null;
        stageDraft.lon = null;
    }

    refreshTzStatusDisplay();
}

function tzStatusText()
{
    if( stageDraft.tzStatus === 'found' )
        return stageDraft.tz + ' (' + stageDraft.tzLabel + ')';

    if( stageDraft.tzStatus === 'loading' )
        return TF( 'trips.tzLooking', { place: stageDraft.location.trim() } );

    if( stageDraft.tzStatus === 'offline' )
        return TF( 'trips.tzOffline', { place: stageDraft.location.trim() } );

    if( stageDraft.tzStatus === 'not-found' )
        return TF( 'trips.tzFailed', { place: stageDraft.location.trim() } );

    return T( 'trips.typeLocationForTz' );
}

function refreshTzStatusDisplay()
{
    const el = document.getElementById( 'stageTzStatus' );

    if( el )
        el.textContent = tzStatusText();
}

// One compact line: "Zona horaria: <status>" - kept out of a .field row so the
// dialog stays as short as possible.
function buildTzStatusField()
{
    const p = document.createElement( 'p' );
    p.className = 'tz-status tz-inline';

    const label = document.createElement( 'span' );
    label.className = 'tz-inline-label';
    label.textContent = T( 'trips.timezone' ) + ': ';

    const status = document.createElement( 'span' );
    status.id = 'stageTzStatus';
    status.textContent = tzStatusText();

    p.appendChild( label );
    p.appendChild( status );
    return p;
}

function renderStageSheet()
{
    const sheet = document.getElementById( 'stageSheet' );
    sheet.innerHTML = '';

    const h2 = document.createElement( 'h2' );
    h2.textContent = editingStageId ? T( 'trips.editStage' ) : T( 'trips.addStage' );
    sheet.appendChild( h2 );

    if( stageSaveError )
    {
        const err = document.createElement( 'p' );
        err.className = 'calc-warn';
        err.textContent = stageSaveError;
        sheet.appendChild( err );
    }

    sheet.appendChild( locationField( T( 'trips.location' ), T( 'trips.cityOrPlace' ), stageDraft.location, function( v ) { stageDraft.location = v; scheduleStageTzLookup(); } ) );
    sheet.appendChild( buildTzStatusField() );

    const datesRow = document.createElement( 'div' );
    datesRow.className = 'field-row';
    datesRow.appendChild( dateField( T( 'trips.startDate' ), stageDraft.startDate, function( v ) { stageDraft.startDate = v; } ) );
    datesRow.appendChild( dateField( T( 'trips.endDate' ), stageDraft.endDate, function( v ) { stageDraft.endDate = v; } ) );
    sheet.appendChild( datesRow );

    const transportRow = document.createElement( 'div' );
    transportRow.className = 'field-row';
    transportRow.appendChild( selectField( T( 'trips.transport' ), stageDraft.transport, TRANSPORT_OPTIONS(), function( v ) { stageDraft.transport = v; } ) );
    transportRow.appendChild( timeField( T( 'trips.departure' ), stageDraft.startTime, function( v ) { stageDraft.startTime = v; } ) );
    transportRow.appendChild( timeField( T( 'trips.arrival' ), stageDraft.endTime, function( v ) { stageDraft.endTime = v; } ) );
    sheet.appendChild( transportRow );

    sheet.appendChild( textAreaField( T( 'trips.lodging' ), T( 'trips.hotelPh' ), stageDraft.accommodation, function( v ) { stageDraft.accommodation = v; }, 2 ) );
    sheet.appendChild( textAreaField( NayiveUI.t( 'ui.notes' ), T( 'trips.notesPh' ), stageDraft.notes, function( v ) { stageDraft.notes = v; } ) );

    const addDocBtn = document.createElement( 'button' );
    addDocBtn.type = 'button';
    addDocBtn.className = 'icon-btn doc-add-btn';
    addDocBtn.title = T( 'trips.addDoc' );
    addDocBtn.appendChild( svgIcon( ICON_PLUS, 14 ) );
    addDocBtn.addEventListener( 'click', addStageDoc );

    // In the stage sheet the dot comes BEFORE the "+": "Documentos (i) [+]".
    const docsInfo = docsLabelInfoDot();

    const trip = findTrip( selectedTripId );
    const dirName = trip ? trip.dirName : 'trip';   // stages only ever belong to an already-saved trip

    const docRows = stageDraft.documents.map( function( d )
    {
        return buildDocRow( d, function( v ) { d.type = v; }, function() { removeStageDoc( d.id ); }, function() { return dirName; }, renderStageSheet, function() { return stageDraft.documents; } );
    });

    sheet.appendChild( buildDocsField( docRows, [ docsInfo, addDocBtn ], stageDocsCollapsed, function( b ) { stageDocsCollapsed = b; } ) );

    const actions = document.createElement( 'div' );
    actions.className = 'sheet-actions';

    if( editingStageId )
    {
        const delBtn = document.createElement( 'button' );
        delBtn.className = 'btn btn-danger sheet-actions-left';
        delBtn.title = T( 'trips.deleteStage' );
        delBtn.disabled = stageSheetBusy;
        delBtn.appendChild( svgIcon( ICON_TRASH, 17 ) );
        // Already inside a dialog: no second question, it goes at once with an Undo.
        delBtn.addEventListener( 'click', deleteStageFromSheet );
        actions.appendChild( delBtn );
    }

    const cancelBtn = document.createElement( 'button' );
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.title = NayiveUI.t( 'ui.cancel' );
    cancelBtn.disabled = stageSheetBusy;
    cancelBtn.appendChild( svgIcon( ICON_X, 17 ) );
    cancelBtn.addEventListener( 'click', closeStageSheet );

    const saveBtn = document.createElement( 'button' );
    saveBtn.className = 'btn btn-primary';
    saveBtn.title = stageSheetBusy ? T( 'ui.sync.saving' ) : T( 'ui.save' );
    saveBtn.disabled = stageSheetBusy;
    saveBtn.appendChild( svgIcon( ICON_CHECK, 18 ) );
    saveBtn.addEventListener( 'click', saveStage );

    actions.appendChild( cancelBtn );
    actions.appendChild( saveBtn );
    sheet.appendChild( actions );
}
