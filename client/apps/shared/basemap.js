/*
 * basemap.js - the base map under the Trips and Photos Leaflet maps:
 * OpenStreetMap, with place names in the UI language.
 *
 * OSM's own tile server sends finished pictures, always labelled with each
 * place's local `name`. OpenFreeMap sends the same OSM data as vector tiles,
 * drawn here by MapLibre GL inside Leaflet (the maplibre-gl-leaflet bridge),
 * so each label can read `name:<lang>` - "Bruselas", not "Bruxelles - Brussel".
 * With no WebGL, or when OpenFreeMap can't be reached, it falls back to the
 * OSM pictures (local names).
 *
 * Plain classic script, one global. Needs Leaflet; MapLibre GL and the bridge
 * are optional (without them: the OSM pictures). All three are vendored in
 * trips/lib/ - Trips loads them in its <head>, Photos on first use of its map.
 *
 *     NayiveBaseMap.add( map, {
 *         print:   true,    // keep the WebGL picture, so window.print() can capture it
 *         onReady: fn,      // the first view is fully drawn
 *         onFail:  fn       // not even the OSM pictures load (no real internet)
 *     } );                  // every option is optional
 *
 * Call it before or after the map's first setView / fitBounds.
 */
( function ()
{
    "use strict";

    var OFM_STYLE = "https://tiles.openfreemap.org/styles/liberty";

    var glUsable = null;   // tested once: every probe would hold a WebGL context

    function canUseGL()
    {
        if( ! window.L || ! L.maplibreGL || ! window.maplibregl ) return false;

        if( glUsable === null )
        {
            try
            {
                var c   = document.createElement( "canvas" );
                var gl  = c.getContext( "webgl2" ) || c.getContext( "webgl" );
                var ext = gl && gl.getExtension( "WEBGL_lose_context" );
                glUsable = !! gl;
                if( ext ) ext.loseContext();
            }
            catch( e ) { glUsable = false; }
        }

        return glUsable;
    }

    // Every label that shows a name (not the road-number shields) reads the UI
    // language first, then the Latin-script name, then the local one.
    function localizeLabels( glMap )
    {
        var lang = ( window.NayiveUI && NayiveUI.lang ) ? NayiveUI.lang() : "en";
        var text = [ "coalesce", [ "get", "name:" + lang ], [ "get", "name:latin" ], [ "get", "name" ] ];

        glMap.getStyle().layers.forEach( function ( l )
        {
            var tf = l.layout && l.layout[ "text-field" ];
            if( tf && JSON.stringify( tf ).indexOf( '"name' ) !== -1 )
                glMap.setLayoutProperty( l.id, "text-field", text );
        } );
    }

    function add( map, o )
    {
        o = o || {};

        if( ! canUseGL() ) { addRaster( map, o ); return; }

        // The raster layer capped the zoom; this layer doesn't, so cap the map itself.
        map.setMaxZoom( 19 );

        var layer   = L.maplibreGL( { style: OFM_STYLE, preserveDrawingBuffer: !! o.print } );
        var settled = false;   // loaded, or already fell back

        // The GL map only exists once Leaflet has a view (fitBounds / setView).
        layer.on( "add", function ()
        {
            var gl = layer.getMaplibreMap();

            gl.on( "style.load", function () { localizeLabels( gl ); } );
            gl.once( "load", function ()
            {
                settled = true;
                gl.once( "idle", function () { if( o.onReady ) o.onReady(); } );
            } );

            // It never loaded (OpenFreeMap down, WebGL refused...): OSM pictures instead.
            // Outside this handler - the layer's removal destroys `gl`.
            gl.on( "error", function ()
            {
                if( settled ) return;
                settled = true;
                setTimeout( function ()
                {
                    if( ! map.hasLayer( layer ) ) return;   // map already gone
                    map.removeLayer( layer );
                    addRaster( map, o );
                }, 0 );
            } );
        } );

        layer.addTo( map );
    }

    // The standard OpenStreetMap tiles: pictures, labelled in the local language.
    function addRaster( map, o )
    {
        var tiles = L.tileLayer( "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        } );

        if( o.onFail )  tiles.on( "tileerror", o.onFail );
        if( o.onReady ) tiles.on( "load", function () { setTimeout( o.onReady, 150 ); } );
        tiles.addTo( map );
    }

    window.NayiveBaseMap = { add: add };
} )();
