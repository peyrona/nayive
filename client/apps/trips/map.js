/* map.js - the route map (side panel on wide screens, sheet on narrow ones). */

//------------------------------------------------------------------------//
// RENDERING - MAP (side panel on wide screens, sheet on narrow ones) - a real Leaflet
// map (OpenStreetMap data, free, no API key - see shared/basemap.js), plotting the
// trip's stages by their geocoded coordinates. Coordinates are never guessed: a stage
// that hasn't been geocoded yet, or couldn't be resolved, is simply left off the map and
// disclosed via the warning note below it - same honesty rule as timezone/currency.

// Two independent Leaflet instances can be alive at once (panel + sheet). Each slot
// tracks its own so a re-render can .remove() the previous one first - Leaflet throws if
// you try to re-init a map onto a container it already owns, and just wiping the
// container's innerHTML would leak the old instance's tile requests/event listeners.
let panelMapInstance = null;
let sheetMapInstance = null;

// "El mapa necesita conexión…" - shown where a map cannot be drawn. Built in one
// place: the Journey guard below raises it up front, and buildRealMap()'s onFail
// raises it for the Plan map once the tiles have really failed to load.
function offlineNote()
{
    const off = document.createElement( 'div' );
    off.className = 'route-offline';
    off.textContent = T( 'trips.mapNeedsNet' );
    return off;
}

function destroyMap( sWhich )
{
    const instance = sWhich === 'panel' ? panelMapInstance : sheetMapInstance;

    if( instance )
        instance.remove();

    if( sWhich === 'panel' ) panelMapInstance = null; else sheetMapInstance = null;
}

// The stage whose card the pointer is currently over, or null. Kept at module level
// so buildRealMap() can restore the highlight after a re-render rebuilds the map.
let hoveredStageId = null;

// Highlight (or un-highlight) the route leg that LEAVES the given stage - the same leg
// the stage's transport colours, and the same journey its node icon shows. The .leg-active
// class does the rest in CSS: drawn solid instead of dotted. Applied to
// whichever maps are alive (the wide-layout panel, the narrow-layout sheet, or both).
// Silently does nothing when there is no such leg: the last stage departs nowhere, and
// a disabled or not-yet-geocoded stage is not on the map at all.
function setLegActive( sStageId, bOn )
{
    [ panelMapInstance, sheetMapInstance ].forEach( function( map )
    {
        const leg = map && map.nayiveLegs && map.nayiveLegs[ sStageId ];
        const el  = leg && leg.getElement();

        if( el ) el.classList.toggle( 'leg-active', bOn );
    });
}

function buildRealMap( trip, container, sWhich )
{
    destroyMap( sWhich );

    const map = L.map( container, { zoomControl: true, attributionControl: true } );

    // The base map is visually busy, so `.route-map` desaturates it in CSS to a
    // calm grey backdrop - the trip route stays the only colour on the map.
    // onFail is the ONLY thing standing between the user and a blank grey box:
    // it covers no internet at all, connected to Wi-Fi with no real internet
    // (navigator.onLine is still true then), and offline with these tiles not in
    // the browser cache. Swap the block for the offline note the first time it
    // can't load.
    let swapped = false;
    NayiveBaseMap.add( map, { onFail: function()
    {
        if( swapped ) return;
        swapped = true;

        const block = container.parentElement;   // the wrap div from buildRouteMapBlock
        destroyMap( sWhich );

        if( block )
        {
            // The legend and the caption go with the map, but the bar's Plan / Journey
            // switch must stay: this is the only route back, and offline (where this
            // now fires) it is the one control still worth having.
            const bar = block.querySelector( '.map-bar' );
            block.innerHTML = '';
            if( bar ) block.appendChild( bar );
            block.appendChild( offlineNote() );
        }
    } } );

    const points = trip.stages
        .filter( function( st ) { return stageEnabled( st ) && typeof st.lat === 'number' && typeof st.lon === 'number'; } )
        .map( function( st, i ) { return { id: st.id, lat: st.lat, lon: st.lon, label: st.location, index: i + 1, transport: st.transport || 'other' }; } );

    // Every drawn leg, keyed by the id of the stage it DEPARTS from - that is what
    // setLegActive() looks up when the pointer enters a stage card.
    const legs = {};

    if( points.length )
    {
        const latlngs = points.map( function( p ) { return [ p.lat, p.lon ]; } );

        // One coloured leg per hop, coloured by the transport of the stage it
        // leaves from (a stage's transport is how you travel onward from it, the
        // journey next to its "Salida" field), so each mode reads as its own line.
        for( let i = 1; i < points.length; i++ )
        {
            const mode = points[ i - 1 ].transport;
            legs[ points[ i - 1 ].id ] =
                L.polyline( [ [ points[i-1].lat, points[i-1].lon ], [ points[i].lat, points[i].lon ] ],
                    { color: ownKey( TRANSPORT_COLORS, mode ) || TRANSPORT_COLORS.other, weight: 4, opacity: 0.9, dashArray: '8, 8', lineJoin: 'round' } )
                    .bindTooltip( ownKey( TRANSPORT_LABELS(), mode ) || T( 'trips.leg' ), { sticky: true } )
                    .addTo( map );
        }

        points.forEach( function( p )
        {
            L.marker( [ p.lat, p.lon ] ).bindPopup( NayiveUI.escapeHtml( TF( 'trips.stageN', { n: p.index } ) + ': ' + p.label ) ).addTo( map );
        });

        map.fitBounds( latlngs, { padding: [ 28, 28 ], maxZoom: 12 } );
    }
    // The trip's own name is only ever a map pin when there are NO stages - once a
    // trip has stages its name is just the trip's title, not a place on the map.
    else if( trip.stages.length === 0 && typeof trip.lat === 'number' && typeof trip.lon === 'number' )
    {
        map.setView( [ trip.lat, trip.lon ], 9 );
        L.marker( [ trip.lat, trip.lon ] ).bindPopup( NayiveUI.escapeHtml( trip.destination || '' ) ).addTo( map );
    }
    else
    {
        map.setView( [ 20, 0 ], 2 );   // nothing resolved yet - filled in once geocoding lands, see ensureRouteCoords()
    }

    map.nayiveLegs = legs;

    if( sWhich === 'panel' ) panelMapInstance = map; else sheetMapInstance = map;

    // A background save (a geocode or a weather lookup landing) re-renders and rebuilds
    // this map from scratch, on brand-new polylines. If the pointer is still resting on a
    // stage card, put its highlight straight back so the rebuild is invisible to the user.
    if( hoveredStageId ) setLegActive( hoveredStageId, true );

    // The container may have been zero-sized at init (e.g. sheet still mid-transition) -
    // let layout settle for a frame, then have Leaflet recheck its size.
    requestAnimationFrame( function() { map.invalidateSize(); } );

    return map;
}

// Builds the map block AND appends it into `parentEl` itself (rather than just returning
// it for the caller to append) - Leaflet reads the container's real layout size at init
// (for fitBounds/setView), so the div must already be attached to the visible document
// before buildRealMap() runs, not after.
function buildRouteMapBlock( trip, sWhich, parentEl )
{
    const wrap = document.createElement( 'div' );

    // One row above the map: the legend (Plan) or "Now in ..." (Journey) on the
    // left, Plan / Journey on the right. A trip shared with us has no Journey: its positions are the
    // owner's (server/go/journey.go answers only for our own trips).
    const bar = document.createElement( 'div' );
    bar.className = 'map-bar';
    if( ! tripIsRO( trip ) ) bar.appendChild( buildMapModeSwitch() );
    wrap.appendChild( bar );

    if( mapMode === 'journey' && ! tripIsRO( trip ) )
    {
        // Journey cannot be drawn without the network: it is GET /api/journey that
        // has the positions, the photo spots and "where I am now", and /api/* is
        // never cached (sw.js). So offline it can only say so - the same note the
        // Plan map used to show as well.
        if( ! navigator.onLine )
        {
            destroyMap( sWhich );
            wrap.appendChild( offlineNote() );
            parentEl.appendChild( wrap );
            return;
        }

        parentEl.appendChild( wrap );
        buildJourneyBlock( trip, sWhich, wrap, bar );
        return;
    }

    // The PLAN map does not get that guard. Its tiles live in the browser's own
    // HTTP cache - OpenFreeMap serves them max-age=315360000, the OSM raster
    // fallback ~6 days - so an area already looked at draws again with no network
    // at all, which is exactly what you want on a trip with the roaming off.
    // Nothing is lost when they are NOT cached: basemap.js still calls onFail in
    // buildRealMap() below, which puts up the very same note.

    // Legend for the coloured route legs - only the transport modes this trip
    // actually uses to travel between stages. Each leg is coloured by the stage it
    // leaves from, so the last stage (nothing departs it) is skipped. Sits in the
    // bar ABOVE the map, before Plan / Journey.
    const usedModes = [];
    const mapStages = trip.stages.filter( stageEnabled );
    mapStages.slice( 0, -1 ).forEach( function( st )
    {
        const m = st.transport || 'other';
        if( usedModes.indexOf( m ) === -1 ) usedModes.push( m );
    });

    if( usedModes.length )
    {
        const legend = document.createElement( 'div' );
        legend.className = 'map-legend';
        usedModes.forEach( function( m )
        {
            const it = document.createElement( 'span' );
            it.className = 'map-legend-item';
            const sw = document.createElement( 'span' );
            sw.className = 'map-legend-swatch';
            sw.style.background = ownKey( TRANSPORT_COLORS, m ) || TRANSPORT_COLORS.other;
            it.appendChild( sw );
            it.appendChild( document.createTextNode( ownKey( TRANSPORT_LABELS(), m ) || T( 'trips.trOther' ) ) );
            legend.appendChild( it );
        });
        bar.insertBefore( legend, bar.firstChild );
    }

    const mapDiv = document.createElement( 'div' );
    mapDiv.className = 'route-map';
    wrap.appendChild( mapDiv );

    const unresolved = trip.stages.filter( function( st ) { return stageEnabled( st ) && st.lat === null; } );

    if( unresolved.length )
    {
        const warn = document.createElement( 'p' );
        warn.className = 'calc-warn';
        warn.textContent = TF( 'trips.cantLocate', { places: unresolved.map( function( st ) { return st.location; } ).join( ', ' ) } );
        wrap.appendChild( warn );
    }

    const caption = document.createElement( 'p' );
    caption.className = 'map-caption';
    caption.textContent = T( 'trips.liveMap' );
    wrap.appendChild( caption );

    parentEl.appendChild( wrap );
    buildRealMap( trip, mapDiv, sWhich );
}
