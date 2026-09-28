/* location.js - time zone and coordinates of a place, and a stage's weather. */

//------------------------------------------------------------------------//
// LOCATION - a stage's (or trip's) timezone AND map coordinates, both detected from its
// free-text location via live geocoding, never asked for and never assumed: a location
// that can't be resolved is reported as unresolved, not silently defaulted to UTC/0,0
// or the viewer's own zone.

// Two free, no-key lookups chained together: Nominatim (OSM's own geocoder) resolves the
// free-text name to coordinates - unlike open-meteo's geocoder, it understands alt-language
// names (e.g. Spanish "Bruselas"/"Gante" for Brussels/Ghent) instead of matching whatever
// obscure namesake hamlet happens to share the literal spelling - then open-meteo's forecast
// endpoint turns those coordinates into an IANA timezone.
//
// Nominatim's usage policy caps anonymous use at 1 request/second, so calls are serialized
// through nominatimQueue rather than fired in parallel (a multi-stage trip geocodes several
// locations at once via ensureRouteCoords()).
let nominatimQueue = Promise.resolve();

function queuedNominatimSearch( sQuery )
{
    const run = function()
    {
        return fetch( 'https://nominatim.openstreetmap.org/search?format=json&limit=3&addressdetails=1&accept-language=en&q=' + encodeURIComponent( sQuery ) )
            .then( function( res ) { return new Promise( function( resolve ) { setTimeout( function() { resolve( res ); }, 1100 ); } ); } );
    };

    const result = nominatimQueue.then( run, run );
    nominatimQueue = result.catch( function() {} );
    return result;
}

// Which of the (up to 3) hits is the actual place. Normally Nominatim links a town's
// place-node into its administrative boundary and the boundary then reports the node's
// position, so hit [0] is already right (Nerja, Madrid, Paris...). When that link is
// missing, the boundary keeps its raw polygon centroid instead - for Marbella that is
// 7.2 km east of the town, out by Las Chapas, because the municipality runs from San
// Pedro to Cabopino and the town sits in its western half. The unlinked town node then
// shows up as a separate, lower-ranked hit, which is what this picks up.
//
// Only boundaries are second-guessed, so a stage typed as a hotel, an airport or a
// landmark always keeps hit [0]. The same-name + inside-the-bounding-box guard is what
// stops us jumping to a namesake abroad (searching "Marbella" also returns one in
// Colombia).
function pickHit( aHits )
{
    const top = aHits[ 0 ];

    if( ! top || top.class !== 'boundary' )
        return top;

    const bbox = ( top.boundingbox || [] ).map( parseFloat );   // [ south, north, west, east ]

    if( bbox.length !== 4 || bbox.some( function( n ) { return ! isFinite( n ); } ) )
        return top;

    const sName = ( top.name || '' ).toLowerCase();

    if( ! sName )
        return top;

    const town = aHits.slice( 1 ).find( function( h )
    {
        if( h.class !== 'place' || ( h.name || '' ).toLowerCase() !== sName )
            return false;

        const lat = parseFloat( h.lat );
        const lon = parseFloat( h.lon );

        return isFinite( lat ) && isFinite( lon )
            && lat >= bbox[ 0 ] && lat <= bbox[ 1 ]
            && lon >= bbox[ 2 ] && lon <= bbox[ 3 ];
    });

    return town || top;
}

// Returns one of:
//   { timezone, label, lat, lon }  - resolved
//   null                           - the services are reachable but returned no match
//   { unreachable: true }          - could not reach a service (offline / 5xx)
// The caller MUST NOT persist a "not found" (null -> lat:null) for the
// unreachable case, or a stage geocoded once while offline is stuck
// forever (retry only fires while lat === undefined).
//
// `sDate` (optional, a stage's start date): the time zone is asked for with
// that day's weather in the SAME open-meteo call, and the answer seeds
// weatherCache - one request per place instead of two (the free-tier budget
// counts requests). Should that wider call fail (the archive's CORS answer is
// not reliable), the plain time-zone call is made, as before.
async function geocodeLocation( sQuery, sDate )
{
    try
    {
        const geoRes = await queuedNominatimSearch( sQuery );

        if( ! geoRes.ok )
            return { unreachable: true };

        const geoData = await geoRes.json();

        if( ! Array.isArray( geoData ) )
            return { unreachable: true };

        const hit = pickHit( geoData );

        if( ! hit )
            return null;   // reachable, genuinely no match

        const lat = parseFloat( hit.lat );
        const lon = parseFloat( hit.lon );

        if( ! isFinite( lat ) || ! isFinite( lon ) )
            return null;

        let tzData = null;

        if( sDate )
        {
            try
            {
                const wxRes = await fetch( weatherUrl( lat, lon, sDate ) );
                const wxKey = lat.toFixed( 3 ) + ',' + lon.toFixed( 3 ) + ',' + sDate;

                // An answer - even "no data for that day" (a date past the
                // forecast's reach) - is what the weather call would get too, so
                // it is cached either way; only a failed fetch is asked again.
                if( ! wxRes.ok ) weatherCache.set( wxKey, null );
                else
                {
                    const wxData = await wxRes.json();
                    weatherCache.set( wxKey, parseWeather( wxData ) );
                    if( wxData && wxData.timezone ) tzData = wxData;
                }
            }
            catch( _ ) { tzData = null; }
        }

        if( ! tzData )
        {
            const tzRes = await fetch( 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&timezone=auto&daily=weathercode' );

            if( ! tzRes.ok )
                return { unreachable: true };

            tzData = await tzRes.json();
        }

        if( ! tzData.timezone )
            return { unreachable: true };

        const addr  = hit.address || {};
        const name  = hit.name || addr.city || addr.town || addr.village || sQuery;
        const extra = [ addr.state, addr.country ].filter( function( s ) { return s && s !== name; } );

        return { timezone: tzData.timezone, label: [ name ].concat( extra ).join( ', ' ), lat: lat, lon: lon };
    }
    catch( _ )
    {
        return { unreachable: true };   // fetch threw - offline / DNS / CORS
    }
}

//------------------------------------------------------------------------//
// WEATHER - a stage's daily min/max temperature and sky for its start date, from
// open-meteo (no key). Fetched once per (place, date), cached in memory. A date
// within ~5 days of today or ahead uses the live forecast endpoint; anything
// older uses the historical archive. Whatever can't be resolved shows as "—".

const weatherCache   = new Map();   // "lat,lon,date" -> { tmin, tmax, bucket } | null
const weatherPending = new Set();

function fillStageWeather( el, st )
{
    if( typeof st.lat !== 'number' || typeof st.lon !== 'number' || ! st.startDate )
    {
        el.hidden = true;
        return;
    }

    el.hidden = false;

    const key    = st.lat.toFixed( 3 ) + ',' + st.lon.toFixed( 3 ) + ',' + st.startDate;
    const cached = weatherCache.get( key );

    const paint = function( w )
    {
        el.innerHTML = '';

        const mn = document.createElement( 'span' );
        mn.className = 'wx-min';
        mn.textContent = w && w.tmin != null ? Math.round( w.tmin ) + '°' : '—';

        const mx = document.createElement( 'span' );
        mx.className = 'wx-max';
        mx.textContent = w && w.tmax != null ? Math.round( w.tmax ) + '°' : '—';

        el.appendChild( mn );
        el.appendChild( svgIcon( w ? WX_ICONS[ w.bucket ] : WX_ICONS.none, 15 ) );
        el.appendChild( mx );

        el.title = TF( w ? 'trips.forecastFor' : 'trips.noForecastFor', { date: st.startDate } );
    };

    if( cached !== undefined )
    {
        paint( cached );
        return;
    }

    paint( null );   // placeholder while the fetch is in flight
    loadStageWeather( key, st.lat, st.lon, st.startDate );
}

async function loadStageWeather( key, lat, lon, sDate )
{
    if( weatherPending.has( key ) )
        return;

    weatherPending.add( key );

    let w = null;

    try   { w = await fetchWeather( lat, lon, sDate ); }
    catch ( _ ) { w = null; }

    weatherPending.delete( key );

    // Cache the outcome either way (null included) so a stage that has no data,
    // or one viewed while offline, isn't re-requested on every 30s re-render.
    // The 'online' handler clears the cache so it retries once back online.
    weatherCache.set( key, w );

    if( view === 'detail' && ! anySheetOpen() )
        renderContent();
}

async function fetchWeather( lat, lon, sDate )
{
    const res = await fetch( weatherUrl( lat, lon, sDate ) );

    if( ! res.ok )
        return null;

    return parseWeather( await res.json() );
}

// The one day's weather of a place; with timezone=auto the answer also names
// the place's time zone, which is what lets geocodeLocation() ask for both at once.
function weatherUrl( lat, lon, sDate )
{
    const near = sDate >= addDaysIso( todayIso(), -5 );
    const base = near ? 'https://api.open-meteo.com/v1/forecast'
                      : 'https://archive-api.open-meteo.com/v1/archive';

    return base + '?latitude=' + lat + '&longitude=' + lon +
                  '&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto' +
                  '&start_date=' + sDate + '&end_date=' + sDate;
}

function parseWeather( data )
{
    const dy   = data && data.daily;

    if( ! dy || ! dy.time || ! dy.time.length )
        return null;

    const tmax = dy.temperature_2m_max ? dy.temperature_2m_max[ 0 ] : null;
    const tmin = dy.temperature_2m_min ? dy.temperature_2m_min[ 0 ] : null;
    const code = dy.weathercode         ? dy.weathercode[ 0 ]         : null;

    if( tmax == null && tmin == null )
        return null;

    return { tmin: tmin, tmax: tmax, bucket: wxBucket( code ) };
}
