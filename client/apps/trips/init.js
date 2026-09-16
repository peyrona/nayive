/* init.js - start-up (once the dictionary is in), live clocks, where the viewer is. */

//------------------------------------------------------------------------//
// INITIALIZATION

NayiveI18n.ready.then( function()
{
    API_FILES = GumApi.API_FILES;
    store     = NayiveStore.createStore( { apiBase: API_FILES } );

    document.addEventListener( 'keydown', function( e )
    {
        if( e.key !== 'Escape' ) return;

        if(      document.getElementById( 'confirmSheetBackdrop'   ).classList.contains( 'open' ) ) closeConfirm();
        else if( document.getElementById( 'filePickerSheetBackdrop' ).classList.contains( 'open' ) ) closeFilePicker();
        else if( document.getElementById( 'stageSheetBackdrop'    ).classList.contains( 'open' ) ) closeStageSheet();
        else if( document.getElementById( 'tripSheetBackdrop'     ).classList.contains( 'open' ) ) closeTripSheet();
        else if( document.getElementById( 'mapSheetBackdrop'      ).classList.contains( 'open' ) ) closeSheet( 'mapSheetBackdrop' );
        else if( document.getElementById( 'locSheetBackdrop'      ).classList.contains( 'open' ) ) closeSheet( 'locSheetBackdrop' );
        else if( document.getElementById( 'currencySheetBackdrop' ).classList.contains( 'open' ) ) closeSheet( 'currencySheetBackdrop' );
    });

    // Crossing the 920px breakpoint toggles whether the route panel is visible at all
    // (see renderRoutePanel()) - re-render on the transition so resizing/rotating into
    // "wide" while a trip is open builds the live map instead of leaving it blank.
    wideMql.addEventListener( 'change', function() { if( view === 'detail' ) renderRoutePanel(); } );

    // The store's state machine drives the header plug for every read and write.
    store.onState( setSyncStatus );

    // The plug's click and the focus / visibilitychange re-reads, all on ONE guarded
    // path (shared/ui.js). Never while a sheet is open. The AUTOMATIC paths also stay
    // on the trip list: loadTrips() ends in renderAll(), which from the detail screen
    // tears down the open trip and its live Leaflet map - the same reason
    // refreshLiveClocks() leaves the route panel alone. A deliberate tap on the plug
    // ("plug") is different: it happens because the user WANTS fresh data, so it is
    // allowed from either screen.
    refresher = NayiveUI.wireRefresh(
    {
        store: store,
        read:  loadTrips,
        guard: function( force, why ) { return anySheetOpen() || ( why !== 'plug' && view !== 'list' ); }
    } );

    // A stage weather lookup that failed while offline is cached as "no data";
    // drop that cache on reconnect so the forecast fills in on the next render.
    window.addEventListener( 'online', function()
    {
        weatherCache.clear();
        if( view === 'detail' && ! anySheetOpen() ) renderContent();
    });

    clockTimer = setInterval( refreshLiveClocks, 30000 );

    // Background tabs get their timers throttled (sometimes to once a minute or less),
    // so the 30s interval alone can leave a stale time on screen for a while after the
    // user switches back. Force an immediate refresh the moment the tab becomes visible.
    // (The trip list's own re-read is wireRefresh's job, above.)
    document.addEventListener( 'visibilitychange', function()
    {
        if( document.visibilityState === 'visible' ) refreshLiveClocks();
    });

    // Probe the API, then load. On a failed probe the shared helper bounces to the
    // sign-in page only when we are really online with nothing cached; otherwise it
    // opens on the local cache and the store syncs once the connection is back.
    NayiveUI.bootWithStore( store, loadTrips );
});

function refreshLiveClocks()
{
    // Only the open trip-detail screen shows live clocks / "you're here" state, and it
    // has no persistent focused input, so a full refresh here never steals keyboard focus
    // the way refreshing an open sheet's form mid-edit would. The route panel is
    // deliberately NOT rebuilt here: it shows no time-dependent content, and tearing down
    // a live Leaflet map + re-fetching its tiles every 30s would just flicker for nothing.
    if( view === 'detail' && ! anySheetOpen() )
    {
        renderContent();
        if( ! viewerPos || Date.now() - viewerPos.at > VIEWER_POS_MAX_AGE ) refreshViewerPos( false );
    }
}

// WHERE THE VIEWER IS - the device's own position, for the "you are here" badge.
// A time zone is far too coarse for that (Madrid, Málaga and Marbella share one),
// so a stage counts only when it is the CLOSEST located stage and within
// HERE_RADIUS_KM. No position (refused, unknown, not asked yet) -> no badge.
const HERE_RADIUS_KM     = 30;
const VIEWER_POS_MAX_AGE = 5 * 60 * 1000;
let viewerPos = null;   // { lat, lon, at } from the last fix

function stageHasCoords( st ) { return stageEnabled( st ) && typeof st.lat === 'number' && typeof st.lon === 'number'; }

// Reads the device position. Only a real tap (opening a trip) may raise the
// browser's permission prompt - bMayPrompt; every other caller reads it quietly,
// and only if permission was already granted. A trip with no located stage
// never asks at all.
function refreshViewerPos( bMayPrompt )
{
    const trip = findTrip( selectedTripId );
    if( ! navigator.geolocation || ! trip || ! trip.stages.some( stageHasCoords ) ) return;

    function locate()
    {
        navigator.geolocation.getCurrentPosition(
            function( pos )
            {
                viewerPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, at: Date.now() };
                if( view === 'detail' && ! anySheetOpen() ) renderContent();
            },
            function( err )
            {
                // Refused -> forget the old fix; merely unknown / slow -> keep it.
                if( err.code === 1 && viewerPos ) { viewerPos = null; if( view === 'detail' && ! anySheetOpen() ) renderContent(); }
            },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: VIEWER_POS_MAX_AGE } );
    }

    if( bMayPrompt ) { locate(); return; }
    if( ! navigator.permissions || ! navigator.permissions.query ) return;

    navigator.permissions.query( { name: 'geolocation' } )
        .then( function( p ) { if( p.state === 'granted' ) locate(); } )
        .catch( function() { /* browser without the geolocation permission name */ } );
}

// Great-circle distance (haversine), km.
function distanceKm( lat1, lon1, lat2, lon2 )
{
    const rad = Math.PI / 180;
    const a   = Math.pow( Math.sin( ( lat2 - lat1 ) * rad / 2 ), 2 )
              + Math.cos( lat1 * rad ) * Math.cos( lat2 * rad ) * Math.pow( Math.sin( ( lon2 - lon1 ) * rad / 2 ), 2 );
    return 12742 * Math.asin( Math.sqrt( a ) );   // 12742 = Earth's diameter in km
}

// The id of the one stage the viewer is at, or null.
function hereStageId( trip )
{
    if( ! viewerPos ) return null;

    let best = null, bestKm = HERE_RADIUS_KM;
    trip.stages.filter( stageHasCoords ).forEach( function( st )
    {
        const km = distanceKm( viewerPos.lat, viewerPos.lon, st.lat, st.lon );
        if( km <= bestKm ) { best = st.id; bestKm = km; }
    });
    return best;
}

function anySheetOpen()
{
    return ['tripSheetBackdrop', 'stageSheetBackdrop', 'mapSheetBackdrop', 'locSheetBackdrop', 'currencySheetBackdrop', 'filePickerSheetBackdrop', 'confirmSheetBackdrop']
        .some( function( id ) { return document.getElementById( id ).classList.contains( 'open' ); } );
}
