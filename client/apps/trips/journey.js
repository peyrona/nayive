/* journey.js - the Journey map: where you really went. */

//------------------------------------------------------------------------//
// JOURNEY MAP - the other map of a trip: where you really went. GET /api/journey
// (server/go/journey.go) answers with the very view a public link shows - the
// route so far (stages started + the positions kept for the trip), the photos with
// their spots, and "where I am now", all rounded to ~100 m - so drawing it follows
// trips/public.html's renderMap.

let mapMode = 'plan';          // 'plan' | 'journey': the switch above the route map

function buildMapModeSwitch()
{
    const bar = document.createElement( 'div' );
    bar.className = 'map-mode';

    [ [ 'plan', ICON_MAP, 'trips.mapPlan' ], [ 'journey', ICON_ROUTE, 'trips.mapJourney' ] ].forEach( function( m )
    {
        const on = mapMode === m[ 0 ];
        const b  = document.createElement( 'button' );
        b.type      = 'button';
        b.className = 'icon-btn sm' + ( on ? ' is-active' : '' );
        b.title     = T( m[ 2 ] );
        b.setAttribute( 'aria-label', T( m[ 2 ] ) );
        b.setAttribute( 'aria-pressed', on ? 'true' : 'false' );
        b.appendChild( svgIcon( m[ 1 ], 16 ) );
        b.addEventListener( 'click', function()
        {
            if( mapMode === m[ 0 ] ) return;
            mapMode = m[ 0 ];
            renderRoutePanel();
            if( document.getElementById( 'mapSheetBackdrop' ).classList.contains( 'open' ) ) renderMapSheet();
        });
        bar.appendChild( b );
    });
    return bar;
}

// One fetch per trip a minute at most: every background save (a geocode, the
// weather) re-renders the whole route map, and would ask again each time.
const journeyCache = {};       // dirName -> { at, promise }

function loadJourney( trip )
{
    const key = trip.dirName;
    const hit = journeyCache[ key ];
    if( hit && Date.now() - hit.at < 60000 ) return hit.promise;

    const promise = fetch( window.location.origin + '/api/journey?trip=' + encodeURIComponent( key ) )
        .then( function( r ) { if( ! r.ok ) throw new Error( 'HTTP ' + r.status ); return r.json(); } );
    journeyCache[ key ] = { at: Date.now(), promise: promise };
    promise.catch( function() { delete journeyCache[ key ]; } );
    return promise;
}

function journeyPhotoUrl( trip, p, sKind )
{
    return window.location.origin + '/api/journey/' + sKind + '/' + encodeURIComponent( p.name ) +
           '?trip=' + encodeURIComponent( trip.dirName ) + '&v=' + p.mtime;
}

function journeyAgo( epoch )
{
    const secs = Math.max( 0, Date.now() / 1000 - epoch );
    const rtf  = new Intl.RelativeTimeFormat( NayiveUI.locale(), { numeric: 'auto' } );
    if( secs < 3600 )  return rtf.format( -Math.max( 1, Math.round( secs / 60 ) ), 'minute' );
    if( secs < 86400 ) return rtf.format( -Math.round( secs / 3600 ), 'hour' );
    return rtf.format( -Math.round( secs / 86400 ), 'day' );
}

// Same sentences as the public page: "photo", "plan", or a location app (said
// the same way whichever app it was).
function journeyNowText( now )
{
    if( now.source === 'plan' ) return TF( 'trips.pub.nowPlan', { place: now.place || '' } );
    const ago = journeyAgo( now.at );
    if( now.source === 'photo' )
        return now.place ? TF( 'trips.pub.nowPhoto', { place: now.place, ago: ago } )
                         : TF( 'trips.pub.nowPhotoNoPlace', { ago: ago } );
    return now.place ? TF( 'trips.pub.nowPhone', { place: now.place, ago: ago } )
                     : TF( 'trips.pub.nowPhoneNoPlace', { ago: ago } );
}

// bar - the row above the map: "Now in ..." takes the legend's place there
// (Journey has no transport legend), before Plan / Journey.
function buildJourneyBlock( trip, sWhich, wrap, bar )
{
    destroyMap( sWhich );

    const nowLine = document.createElement( 'span' );
    nowLine.className = 'journey-now';
    nowLine.hidden = true;
    bar.insertBefore( nowLine, bar.firstChild );

    const mapDiv = document.createElement( 'div' );
    mapDiv.className = 'route-map';
    wrap.appendChild( mapDiv );

    const caption = document.createElement( 'p' );
    caption.className = 'map-caption';
    caption.textContent = T( 'trips.journeyCaption' );
    wrap.appendChild( caption );

    // Answered after a re-render replaced this block: leave the new one alone.
    const stale = function() { return ! mapDiv.isConnected || mapMode !== 'journey'; };

    function note( sText )
    {
        const off = document.createElement( 'div' );
        off.className = 'route-offline';
        off.textContent = sText;
        mapDiv.replaceWith( off );
    }

    loadJourney( trip ).then( function( j )
    {
        if( stale() ) return;

        const spots = j.photos.filter( function( p ) { return p.lat != null && p.lon != null; } );
        if( ! j.route.length && ! j.now && ! spots.length ) { note( T( 'trips.journeyEmpty' ) ); return; }

        if( j.now )
        {
            nowLine.textContent = journeyNowText( j.now );
            nowLine.hidden = false;

            // A photo or a location app's position comes with no town name: look it up once.
            if( ! j.now.place && j.now.source !== 'plan' && NayiveUI.townName )
                NayiveUI.townName( j.now.lat, j.now.lon ).then( function( place )
                {
                    if( ! place ) return;
                    j.now.place = place;
                    if( nowLine.isConnected ) nowLine.textContent = journeyNowText( j.now );
                });
        }
        buildJourneyMap( trip, j, mapDiv, sWhich );
    }, function()
    {
        if( ! stale() ) note( T( 'trips.pub.failed' ) );
    });
}

function buildJourneyMap( trip, j, mapDiv, sWhich )
{
    destroyMap( sWhich );

    const map = L.map( mapDiv, { zoomControl: true, attributionControl: true } );
    NayiveBaseMap.add( map );

    const css    = getComputedStyle( document.documentElement );
    const cv     = function( sName, sFallback ) { return css.getPropertyValue( sName ).trim() || sFallback; };
    const accent = cv( '--accent', '#16A085' );
    const blue   = cv( '--link',   '#5B9DF9' );
    const gold   = cv( '--warn',   '#E0A21E' );
    const red    = cv( '--danger', '#D9707D' );
    const bounds = [];

    if( j.route.length > 1 )
        L.polyline( j.route.map( function( p ) { return [ p.lat, p.lon ]; } ),
                    { color: accent, weight: 3, opacity: 0.85, lineJoin: 'round' } ).addTo( map );

    j.route.forEach( function( p )
    {
        const stage  = p.kind === 'stage';
        const colour = stage ? accent : blue;
        const mark   = L.circleMarker( [ p.lat, p.lon ], { radius: stage ? 7 : 4, color: colour, weight: 2,
                                                           fillColor: colour, fillOpacity: stage ? 0.9 : 0.7 } );
        // A tooltip string is HTML to Leaflet, and a place name is someone's text.
        if( p.place ) mark.bindTooltip( NayiveUI.escapeHtml( p.place ), { direction: 'top' } );
        mark.addTo( map );
        bounds.push( [ p.lat, p.lon ] );
    });

    // Photos taken at the same (rounded) spot share one pin; its popup shows them.
    const spots = new Map();
    j.photos.forEach( function( p )
    {
        if( p.lat == null || p.lon == null ) return;
        const key = p.lat + ',' + p.lon;
        if( ! spots.has( key ) ) spots.set( key, { lat: p.lat, lon: p.lon, photos: [] } );
        spots.get( key ).photos.push( p );
    });
    spots.forEach( function( s )
    {
        L.circleMarker( [ s.lat, s.lon ], { radius: 6, color: gold, weight: 2, fillColor: gold, fillOpacity: 0.55 } )
            .bindTooltip( TF( 'trips.pub.photoCount', { n: s.photos.length } ), { direction: 'top' } )
            .bindPopup( function() { return journeyPhotoPopup( trip, s.photos ); } )
            .addTo( map );
        bounds.push( [ s.lat, s.lon ] );
    });

    if( j.now )
    {
        L.circleMarker( [ j.now.lat, j.now.lon ], { radius: 11, color: red, weight: 3, fillColor: red, fillOpacity: 0.3 } )
            .bindTooltip( function() { return NayiveUI.escapeHtml( journeyNowText( j.now ) ); }, { direction: 'top' } )
            .addTo( map );
        bounds.push( [ j.now.lat, j.now.lon ] );
    }

    if( bounds.length === 1 ) map.setView( bounds[ 0 ], 11 );
    else map.fitBounds( bounds, { padding: [ 28, 28 ], maxZoom: 12 } );

    map.nayiveLegs = {};       // no legs to light up: setLegActive() finds nothing
    if( sWhich === 'panel' ) panelMapInstance = map; else sheetMapInstance = map;
    requestAnimationFrame( function() { map.invalidateSize(); } );
}

// A photo pin's popup: up to six thumbnails (each opens the photo in a new tab)
// and the way to the whole folder in Photos.
function journeyPhotoPopup( trip, photos )
{
    const box  = document.createElement( 'div' );
    box.className = 'journey-pop';
    const grid = document.createElement( 'div' );
    grid.className = 'journey-pop-grid';

    photos.slice( 0, 6 ).forEach( function( p )
    {
        const a = document.createElement( 'a' );
        a.href   = journeyPhotoUrl( trip, p, 'photo' );
        a.target = '_blank';
        a.rel    = 'noopener';
        a.title  = p.comment || p.name;
        const img = document.createElement( 'img' );
        img.alt     = p.comment || '';
        img.loading = 'lazy';
        img.src     = journeyPhotoUrl( trip, p, p.thumb ? 'thumb' : 'photo' );
        a.appendChild( img );
        grid.appendChild( a );
    });
    box.appendChild( grid );

    const all = document.createElement( 'a' );
    all.href   = '../photos/index.html?dir=' + encodeURIComponent( trip.photosDir || '' );
    all.target = '_blank';
    all.rel    = 'noopener';
    all.textContent = TF( 'trips.pub.photoCount', { n: photos.length } ) + ' ' + T( 'trips.openInPhotos' );
    box.appendChild( all );
    return box;
}
