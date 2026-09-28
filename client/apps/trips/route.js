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
            geocodeInto( trip.id, 'stage', st.id, st.location, st.startDate );
    });
}

// sDate: a stage's start date, so its weather comes in the same call (location.js).
async function geocodeInto( tripId, sKind, id, sQuery, sDate )
{
    const key = tripId + ':' + sKind + ':' + id;

    if( pendingGeocodes.has( key ) )
        return;

    pendingGeocodes.add( key );
    const result = await geocodeLocation( sQuery, sDate );
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

// Phone map (below 920px): the whole screen, no dialog. Top-right corner: Plan,
// Journey (the one shown is disabled) and close. It takes one history entry, so
// the phone's "go back" gesture closes it too, as the × does.
function openMapSheet()
{
    // Sheet opens BEFORE the map is built - Leaflet measures its container's size at
    // init, and a still-hidden (display:none) container measures as 0x0.
    openSheet( 'mapSheetBackdrop' );
    renderMapSheet();
    history.pushState( { tripsMap: true }, '' );
}

function mapSheetOpen() { return document.getElementById( 'mapSheetBackdrop' ).classList.contains( 'open' ); }

function closeMapSheet()
{
    if( history.state && history.state.tripsMap ) history.back();   // popstate below closes it
    else                                          closeSheet( 'mapSheetBackdrop' );
}

window.addEventListener( 'popstate', function() { if( mapSheetOpen() ) closeSheet( 'mapSheetBackdrop' ); } );

// Escape goes through closeMapSheet() as well, so the history entry goes with it.
// Capture on window: runs before shared/ui.js's own Escape, which would just hide it.
window.addEventListener( 'keydown', function( e )
{
    if( e.key !== 'Escape' || ! mapSheetOpen() ) return;
    e.preventDefault();
    e.stopPropagation();
    closeMapSheet();
}, true );

function renderMapSheet()
{
    const trip  = findTrip( selectedTripId );
    const sheet = document.getElementById( 'mapSheet' );
    sheet.innerHTML = '';

    if( ! trip )
        return;

    ensureRouteCoords( trip );

    buildRouteMapBlock( trip, 'sheet', sheet );

    // The corner buttons: Plan / Journey (a shared trip has none) + close.
    const bar  = sheet.querySelector( '.map-bar' );
    let   mode = bar.querySelector( '.map-mode' );
    if( ! mode )
    {
        mode = document.createElement( 'div' );
        mode.className = 'map-mode';
        bar.appendChild( mode );
    }
    mode.querySelectorAll( 'button[aria-pressed="true"]' ).forEach( function( b ) { b.disabled = true; } );

    const closeBtn = document.createElement( 'button' );
    closeBtn.type      = 'button';
    closeBtn.className = 'icon-btn sm';
    closeBtn.title     = NayiveUI.t( 'ui.close' );
    closeBtn.setAttribute( 'aria-label', closeBtn.title );
    closeBtn.appendChild( svgIcon( ICON_X, 16 ) );
    closeBtn.addEventListener( 'click', closeMapSheet );
    mode.appendChild( closeBtn );
}

// "My location" (list header): what places you on the Journey maps - the
// location URL, drawn and kept by locationSection (my-location.js).
function openMyLocation()
{
    const sheet = document.getElementById( 'locSheet' );
    sheet.innerHTML = '';
    buildSheetHeader( T( 'trips.myLocation' ), 'locSheetBackdrop', sheet );
    sheet.insertBefore( locationSection(), sheet.querySelector( '.sheet-actions' ) );
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
