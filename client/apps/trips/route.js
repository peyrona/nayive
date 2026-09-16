/* route.js - route geocoding, the map sheet, "My location", the route panel. */

// Geocodes anything in `trip` that has never been looked up (lat === undefined - a stage
// saved before the map feature existed, or one saved while its lookup was still in
// flight): the trip's own destination (for the "no stages yet" pin) and every stage.
// Whatever resolves is written straight to disk via mutateTrip, exactly like any other
// edit - so each location is only ever geocoded once, not on every render/reload.
const pendingGeocodes = new Set();

function ensureRouteCoords( trip )
{
    // Only geocode the trip's own name when it has no stages - with stages, the trip
    // name is a title, not a place, and must never become a map pin (even a city name).
    if( trip.stages.length === 0 && trip.lat === undefined && trip.destination.trim() )
        geocodeInto( trip.id, 'trip', null, trip.destination );

    trip.stages.forEach( function( st )
    {
        if( st.lat === undefined && st.location.trim() )
            geocodeInto( trip.id, 'stage', st.id, st.location );
    });
}

async function geocodeInto( tripId, sKind, id, sQuery )
{
    const key = tripId + ':' + sKind + ':' + id;

    if( pendingGeocodes.has( key ) )
        return;

    pendingGeocodes.add( key );
    const result = await geocodeLocation( sQuery );
    pendingGeocodes.delete( key );

    if( selectedTripId !== tripId )
        return;   // navigated away before this resolved - don't touch a trip that isn't open any more

    if( result && result.unreachable )
        return;   // offline / service down - leave lat === undefined so it retries later

    const coords = result ? { lat: result.lat, lon: result.lon } : { lat: null, lon: null };

    if( sKind === 'trip' )
    {
        mutateTrip( tripId, function( t ) { return { ...t, lat: coords.lat, lon: coords.lon }; } );
    }
    else
    {
        mutateTrip( tripId, function( t )
        {
            const stages = t.stages.map( function( st ) { return st.id === id ? { ...st, lat: coords.lat, lon: coords.lon } : st; } );
            return { ...t, stages };
        });
    }
}

function renderMapSheet()
{
    const trip  = findTrip( selectedTripId );
    const sheet = document.getElementById( 'mapSheet' );
    sheet.innerHTML = '';

    if( ! trip )
        return;

    ensureRouteCoords( trip );

    buildSheetHeader( T( 'trips.route' ), 'mapSheetBackdrop', sheet );
    buildRouteMapBlock( trip, 'sheet', sheet );
}

// "My location" (list header): what places you on the Journey maps - the
// location URL, drawn and kept by NayiveUI.locationSection (shared/ui.js).
function openMyLocation()
{
    const sheet = document.getElementById( 'locSheet' );
    sheet.innerHTML = '';
    buildSheetHeader( T( 'trips.myLocation' ), 'locSheetBackdrop', sheet );
    sheet.insertBefore( NayiveUI.locationSection(), sheet.querySelector( '.sheet-actions' ) );
    openSheet( 'locSheetBackdrop' );
}

// Title + lone "close" for sheets whose only control is close. The close
// button follows the shared Nayive convention: NayiveUI.applySheetButtons()
// moves it to the sheet's top-right corner. (Sheets with other actions
// keep their close in a .sheet-actions row.) Appends into `sheet`.
function buildSheetHeader( title, backdropId, sheet )
{
    const header = document.createElement( 'div' );
    header.className = 'sheet-header';

    const h2 = document.createElement( 'h2' );
    h2.textContent = title;
    header.appendChild( h2 );
    sheet.appendChild( header );

    const actions = document.createElement( 'div' );
    actions.className = 'sheet-actions';

    const closeBtn = document.createElement( 'button' );
    closeBtn.type = 'button';
    closeBtn.setAttribute( 'data-act', 'close' );
    closeBtn.title = NayiveUI.t( 'ui.close' );
    closeBtn.addEventListener( 'click', function() { closeSheet( backdropId ); } );
    actions.appendChild( closeBtn );
    sheet.appendChild( actions );

    NayiveUI.applySheetButtons( sheet );
}

const wideMql = window.matchMedia( '(min-width: 920px)' );

function renderRoutePanel()
{
    const body = document.getElementById( 'routePanelBody' );
    const trip = view === 'detail' ? findTrip( selectedTripId ) : null;

    if( ! trip )
    {
        destroyMap( 'panel' );
        body.innerHTML = '';
        const placeholder = document.createElement( 'div' );
        placeholder.className = 'route-placeholder';
        placeholder.textContent = T( 'trips.openTripForRoute' );
        body.appendChild( placeholder );
        return;
    }

    ensureRouteCoords( trip );

    if( ! wideMql.matches )
    {
        // Hidden by CSS below 920px (the map opens in a sheet instead, via the header's
        // map button) - skip building a live tile map into an invisible container:
        // Leaflet can't size itself at display:none, and the tiles would load for nothing
        // anyone can see. ensureRouteCoords() above still ran, so the sheet has data ready.
        destroyMap( 'panel' );
        body.innerHTML = '';
        return;
    }

    body.innerHTML = '';
    buildRouteMapBlock( trip, 'panel', body );
}
