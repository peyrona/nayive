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

// Settings (list header, the gear), two tabs (2026-10-02):
//   Location - what places you on the Journey maps: the location URL, drawn
//              and kept by locationSection (my-location.js).
//   General  - "Remind me about a trip N days before" (was in the launcher's
//              "Mi cuenta").
function openSettings()
{
    const sheet = document.getElementById( 'setSheet' );
    sheet.innerHTML = '';
    buildSheetHeader( T( 'ui.settings' ), 'setSheetBackdrop', sheet );

    const tabs = document.createElement( 'div' );
    tabs.className = 'set-tabs';
    tabs.setAttribute( 'role', 'tablist' );

    const panes = [ [ 'location', T( 'trips.tabLocation' ), locationSection() ],
                    [ 'general',  T( 'trips.tabGeneral' ),  reminderSection() ] ];

    function show( key )
    {
        tabs.querySelectorAll( '.pill' ).forEach( function( b )
        {
            const on = b.getAttribute( 'data-tab' ) === key;
            b.classList.toggle( 'is-active', on );
            b.setAttribute( 'aria-selected', on ? 'true' : 'false' );
        } );
        sheet.querySelectorAll( '[data-pane]' ).forEach( function( p ) { p.hidden = p.getAttribute( 'data-pane' ) !== key; } );
    }

    const actions = sheet.querySelector( '.sheet-actions' );
    sheet.insertBefore( tabs, actions );
    panes.forEach( function( p )
    {
        const b = document.createElement( 'button' );
        b.type = 'button';
        b.className = 'pill';
        b.setAttribute( 'role', 'tab' );
        b.setAttribute( 'data-tab', p[ 0 ] );
        b.textContent = p[ 1 ];
        b.addEventListener( 'click', function() { show( p[ 0 ] ); } );
        tabs.appendChild( b );

        p[ 2 ].setAttribute( 'data-pane', p[ 0 ] );
        sheet.insertBefore( p[ 2 ], actions );
    } );

    show( 'location' );
    openSheet( 'setSheetBackdrop' );
}

// "Remind me about a trip N days before": ACCOUNT state on the server
// (/api/files?tripdays=), saved on change. 0 = no reminder.
function reminderSection()
{
    const t = NayiveUI.t;

    const box = document.createElement( 'div' );

    const field = document.createElement( 'div' );
    field.className = 'field';

    const label = document.createElement( 'label' );
    label.htmlFor     = 'tripDaysSet';
    label.textContent = t( 'acct.remindTrip' ) + ' (' + t( 'acct.daysBefore' ) + ')';

    const input = document.createElement( 'input' );
    input.id        = 'tripDaysSet';
    input.type      = 'number';
    input.min       = '0';
    input.max       = '90';
    input.inputMode = 'numeric';

    const msg = document.createElement( 'p' );
    msg.className = 'share-note';
    msg.hidden    = true;

    field.append( label, input );
    box.append( field, msg );

    let saved = null;

    function say( text ) { msg.textContent = text; msg.hidden = ! text; }

    fetch( '/api/files?tripdays=1', { credentials: 'same-origin' } )
        .then( function( r ) { return r.ok ? r.json() : null; } )
        .then( function( d ) { if( d ) { saved = d.days; input.value = d.days; } } )
        .catch( function() { /* leave it blank */ } );

    input.addEventListener( 'change', async function()
    {
        let v = parseInt( input.value, 10 );
        if( ! isFinite( v ) ) { input.value = ( saved == null ? '' : saved ); return; }
        v = Math.max( 0, Math.min( 90, v ) );

        input.disabled = true;
        try
        {
            // Through GumApi: it names the page's owner (X-Nayive-User), so an
            // old tab of another account is refused (423), not saved (AB3).
            const q = new URLSearchParams( { tripdays: '1', value: String( v ) } ).toString();
            const text = await GumApi.fetchText( '/api/files?' + q, { method: 'POST' } );
            let d = {};
            try { d = JSON.parse( text ) || {}; } catch( _ ) {}
            saved = d.days; input.value = d.days;
            say( d.days > 0 ? NayiveUI.tf( 'acct.tripMsg', { n: d.days } ) : t( 'acct.tripNone' ) );
        }
        catch( e ) { input.value = ( saved == null ? '' : saved ); say( e && e.status ? t( 'ui.saveFailed' ) : t( 'login.noServer' ) ); }
        input.disabled = false;
    } );

    return box;
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
