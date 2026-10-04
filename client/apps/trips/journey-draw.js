/*
 * journey-draw.js - "where you really went", drawn the same in two places:
 * the Journey map of a trip (trips/journey.js) and the trip's public link
 * (trips/public.html, /s/<token>). Both get the same view from the server -
 * the route so far, the photos with their spots, "where I am now" - and draw
 * it with this. Plain classic script, one global:
 *
 *     NayiveJourney.ago( epoch )            "5 minutes ago", in the interface language
 *     NayiveJourney.nowText( now )          "Now in Lisboa (photo, 2 hours ago)"...
 *     NayiveJourney.spots( photos )         photos at the same (rounded) spot -> one pin each
 *     NayiveJourney.draw( box, j, o )       the Leaflet map, or null when there is nothing to show
 *
 * Public on purpose (server/go/static.go): a public link has no session. No
 * trip data lives here. It only defines functions: Trips loads it before
 * shared/ui.js has run.
 */
( function ()
{
    "use strict";

    function ago( epoch )
    {
        var secs = Math.max( 0, Date.now() / 1000 - epoch );
        var rtf  = new Intl.RelativeTimeFormat( NayiveUI.locale(), { numeric: "auto" } );
        if( secs < 3600 )  return rtf.format( -Math.max( 1, Math.round( secs / 60 ) ), "minute" );
        if( secs < 86400 ) return rtf.format( -Math.round( secs / 3600 ), "hour" );
        return rtf.format( -Math.round( secs / 86400 ), "day" );
    }

    // now.source: "photo", "plan", or a location app (every app said the same way).
    function nowText( now )
    {
        var TF = NayiveUI.tf;
        if( now.source === "plan" ) return TF( "trips.pub.nowPlan", { place: now.place || "" } );
        var a = ago( now.at );
        if( now.source === "photo" )
            return now.place ? TF( "trips.pub.nowPhoto", { place: now.place, ago: a } )
                             : TF( "trips.pub.nowPhotoNoPlace", { ago: a } );
        return now.place ? TF( "trips.pub.nowPhone", { place: now.place, ago: a } )
                         : TF( "trips.pub.nowPhoneNoPlace", { ago: a } );
    }

    // Photos taken at the same (rounded) spot share one pin: [ { lat, lon,
    // photos, first } ] in the order the spots first appear (`first`: the
    // index in `photos` of the spot's first photo). Photos with no place are left out.
    function spots( photos )
    {
        var by = new Map();
        photos.forEach( function ( p, i )
        {
            if( p.lat == null || p.lon == null ) return;
            var key = p.lat + "," + p.lon;
            if( ! by.has( key ) ) by.set( key, { lat: p.lat, lon: p.lon, photos: [], first: i } );
            by.get( key ).photos.push( p );
        } );
        return Array.from( by.values() );
    }

    // box: the map's element (shown here, before Leaflet measures it).
    // j = { route, spots, now }. o = {
    //   wheel:   false - the mouse wheel scrolls the page, not the map
    //   pin( marker, spot ): what a photo pin does when pressed
    //   nowTip:  the "now" circle's tooltip (Leaflet's: HTML text, or a function)
    //   padding: around the whole trip when it is fitted in }
    // Returns { map, now } (now: the "now" circle, or null), or null when
    // there is nothing to show (or no Leaflet).
    function draw( box, j, o )
    {
        var bounds = [];
        j.route.forEach( function ( p ) { bounds.push( [ p.lat, p.lon ] ); } );
        j.spots.forEach( function ( s ) { bounds.push( [ s.lat, s.lon ] ); } );
        if( j.now ) bounds.push( [ j.now.lat, j.now.lon ] );
        if( ! bounds.length || ! window.L ) return null;
        box.hidden = false;

        var map = L.map( box, { zoomControl: true, attributionControl: true, scrollWheelZoom: o.wheel !== false } );
        if( window.NayiveBaseMap ) NayiveBaseMap.add( map );

        var css    = getComputedStyle( document.documentElement );
        var cv     = function ( name, fallback ) { return css.getPropertyValue( name ).trim() || fallback; };
        var accent = cv( "--accent", "#16A085" );
        var blue   = cv( "--link",   "#5B9DF9" );
        var gold   = cv( "--warn",   "#E0A21E" );
        var red    = cv( "--danger", "#D9707D" );
        // A photo spot: a tiny camera, in the marker pane above every route dot.
        var photoIcon = L.divIcon( { className: "", iconSize: [ 18, 18 ], iconAnchor: [ 9, 9 ], popupAnchor: [ 0, -9 ], tooltipAnchor: [ 0, -9 ],
                                     html: '<svg width="18" height="18" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 0 1px rgba(0,0,0,.6))"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" fill="' + gold + '" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.6" fill="none" stroke="#fff" stroke-width="2"/></svg>' } );

        if( j.route.length > 1 )
            L.polyline( j.route.map( function ( p ) { return [ p.lat, p.lon ]; } ),
                        { color: accent, weight: 2, opacity: 0.85, dashArray: "1, 6", lineCap: "round" } ).addTo( map );

        j.route.forEach( function ( p )
        {
            var stage  = p.kind === "stage";
            var colour = stage ? accent : blue;
            var mark   = L.circleMarker( [ p.lat, p.lon ], { radius: stage ? 7 : 4, color: colour, weight: 2,
                                                           fillColor: colour, fillOpacity: stage ? 0.9 : 0.7 } );
            // A tooltip string is HTML to Leaflet, and a place name is someone's text.
            if( p.place ) mark.bindTooltip( NayiveUI.escapeHtml( p.place ), { direction: "top" } );
            mark.addTo( map );
        } );

        j.spots.forEach( function ( s )
        {
            var pin = L.marker( [ s.lat, s.lon ], { icon: photoIcon } )
                .bindTooltip( NayiveUI.tf( "trips.pub.photoCount", { n: s.photos.length } ), { direction: "top" } );
            o.pin( pin, s );
            pin.addTo( map );
        } );

        var now = null;
        if( j.now )
            now = L.circleMarker( [ j.now.lat, j.now.lon ], { radius: 11, color: red, weight: 3, fillColor: red, fillOpacity: 0.3 } )
                .bindTooltip( o.nowTip, { direction: "top" } )
                .addTo( map );

        if( bounds.length === 1 ) map.setView( bounds[ 0 ], 11 );
        else map.fitBounds( bounds, { padding: [ o.padding, o.padding ], maxZoom: 12 } );
        return { map: map, now: now };
    }

    window.NayiveJourney = { ago: ago, nowText: nowText, spots: spots, draw: draw };
} )();
