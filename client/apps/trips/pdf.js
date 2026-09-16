/* pdf.js - export a trip to PDF (print). */

//------------------------------------------------------------------------//
// EXPORT TRIP -> PDF
//
// No PDF library: fill a hidden #printRoot with a clean, linear, light-theme
// version of the whole trip and call window.print(). The user picks "Save as
// PDF" (or a real printer) in the browser's own dialog. Works offline. The
// print stylesheet (see <style>) hides #app and shows only #printRoot on paper.

// `trip` is the one to print - the button lives on that trip's card in the list.
async function exportTripPdf( trip )
{
    if( ! trip )
        return;

    // Forecasts are fetched lazily as the stage cards render, so a trip printed from
    // the list may have loaded none of them. Fill in what is missing before building
    // the sheet (capped, so a slow API never holds up the print dialog).
    if( navigator.onLine )
        await preloadTripWeather( trip );

    const root = document.getElementById( 'printRoot' );
    root.innerHTML = '';
    const docNode = buildTripPrintDoc( trip );
    root.appendChild( docNode );

    // The browser's "Save as PDF" dialog seeds the file name from document.title,
    // so swap in the trip name while the dialog is open -> "<trip name>.pdf".
    const prevTitle = document.title;
    document.title  = pdfFileTitle( trip );

    function cleanup()
    {
        document.title = prevTitle;
        if( printMapInstance ) { printMapInstance.remove(); printMapInstance = null; }
        root.innerHTML  = '';
        root.style.cssText = '';   // drop the off-screen staging styles (see below)
    }

    // Clear the print DOM again once the dialog closes so it never lingers.
    window.addEventListener( 'afterprint', function done()
    {
        window.removeEventListener( 'afterprint', done );
        cleanup();
    });

    const initMap = docNode._initMap;

    if( initMap && navigator.onLine )
    {
        // Leaflet needs a laid-out container (a display:none element measures 0x0),
        // so stage #printRoot off-screen at roughly the printed text width while the
        // map builds, wait for its tiles, then open the dialog. The @media print
        // block resets these inline styles so the sheet still fills the page.
        root.style.cssText = 'display:block; position:fixed; left:-10000px; top:0; width:680px;';

        let printed = false;
        const go = function()
        {
            if( printed ) return;
            printed = true;
            if( printMapInstance ) printMapInstance.invalidateSize();
            setTimeout( function() { window.print(); }, 80 );
        };

        requestAnimationFrame( function() { initMap( go ); } );
        setTimeout( go, 4000 );   // hard cap - never leave the export hanging on slow tiles
    }
    else
    {
        // No map (offline, or nothing to plot): the original fast path.
        setTimeout( function() { window.print(); }, 60 );
    }
}

// Every forecast the printed sheet wants, fetched once into weatherCache.
// stagePrintWeather() only ever reads that cache, so anything still missing when
// the wait gives up simply prints without weather.
async function preloadTripWeather( trip )
{
    const jobs = ( trip.stages || [] )
        .filter( function( st ) { return stageEnabled( st ) && typeof st.lat === 'number' && typeof st.lon === 'number' && st.startDate; } )
        .map( function( st ) { return { key: st.lat.toFixed( 3 ) + ',' + st.lon.toFixed( 3 ) + ',' + st.startDate, st: st }; } )
        .filter( function( j ) { return ! weatherCache.has( j.key ); } )
        .map( function( j ) { return loadStageWeather( j.key, j.st.lat, j.st.lon, j.st.startDate ); } );

    if( ! jobs.length )
        return;

    await Promise.race( [ Promise.all( jobs ),
                          new Promise( function( resolve ) { setTimeout( resolve, 2500 ); } ) ] );
}

// A file-name-safe version of the trip name for the exported PDF (drops the
// characters an OS forbids in file names; the browser appends ".pdf" itself).
function pdfFileTitle( trip )
{
    const name = ( trip.destination || '' ).trim()
                     .replace( /[\/\\:*?"<>|]+/g, ' ' )
                     .replace( /\s+/g, ' ' )
                     .trim();
    return name || T( 'trips.trip' );
}

// Days a trip spans, inclusive of the first and last day.
function tripDayCount( trip )
{
    if( ! trip.startDate || ! trip.endDate ) return null;
    const ms = new Date( trip.endDate + 'T00:00:00' ) - new Date( trip.startDate + 'T00:00:00' );
    if( isNaN( ms ) || ms < 0 ) return null;
    return Math.round( ms / 86400000 ) + 1;
}

// How a document's bytes are attached, in words, for the print sheet.
function docKindLabel( d )
{
    if( docIsLink( d ) )            return T( 'trips.docLinked' );
    if( d && d._pending )           return T( 'trips.docUploadedPending' );
    if( d && (d.kind === 'upload' || d.file) ) return T( 'trips.docUploaded' );
    return T( 'trips.docNoFile' );
}

// The stored path of a document, or '' when it has no file yet.
function docFullPath( trip, d )
{
    if( docIsLink( d ) )  return d.path || '';
    if( docHasFile( d ) ) return docPath( tripBase( trip ), d );
    return '';
}

function prEl( sTag, sClass, sText )
{
    const e = document.createElement( sTag );
    if( sClass ) e.className = sClass;
    if( sText != null ) e.textContent = sText;
    return e;
}

function stagePrintWeather( st )
{
    if( typeof st.lat !== 'number' || typeof st.lon !== 'number' || ! st.startDate )
        return null;

    const w = weatherCache.get( st.lat.toFixed( 3 ) + ',' + st.lon.toFixed( 3 ) + ',' + st.startDate );

    if( ! w )
        return null;

    const temps = [];
    if( w.tmin != null ) temps.push( TF( 'trips.tempMin', { t: Math.round( w.tmin ) } ) );
    if( w.tmax != null ) temps.push( TF( 'trips.tempMax', { t: Math.round( w.tmax ) } ) );

    return [ WX_LABELS()[ w.bucket ], temps.join( ' · ' ) ].filter( Boolean ).join( ' · ' ) || null;
}

function prDocList( trip, docs )
{
    const ul = prEl( 'ul', 'pr-doclist' );

    docs.forEach( function( d )
    {
        const li = prEl( 'li' );
        li.appendChild( prEl( 'div', 'pr-doc-name',
            ( ( d.name && d.name.trim() ) || T( 'trips.docUntitled' ) ) + ' — ' + ( DOC_TYPE_LABELS()[ d.type ] || d.type || T( 'trips.docOther' ) ) ) );
        li.appendChild( prEl( 'div', 'pr-doc-kind', docKindLabel( d ) ) );

        const path = docFullPath( trip, d );
        li.appendChild( prEl( 'div', 'pr-doc-path', path || T( 'trips.docNoFileParen' ) ) );

        ul.appendChild( li );
    });

    return ul;
}

// A two-column key/value table for the print sheet. `rows` is [ [key, value], ... ];
// a null / '' value drops the row.
function prKvTable( rows )
{
    const kv = prEl( 'table', 'pr-kv' );

    rows.forEach( function( r )
    {
        if( r[ 1 ] == null || r[ 1 ] === '' ) return;
        const tr = document.createElement( 'tr' );
        tr.appendChild( prEl( 'th', null, r[ 0 ] ) );
        tr.appendChild( prEl( 'td', null, r[ 1 ] ) );
        kv.appendChild( tr );
    });

    return kv;
}

function tripFolderPath( trip ) { return 'data/trips/' + trip.dirName + '/'; }

function coordText( lat, lon )
{
    return ( typeof lat === 'number' && typeof lon === 'number' )
         ? lat.toFixed( 5 ) + ', ' + lon.toFixed( 5 )
         : '';
}

function buildTripPrintDoc( trip )
{
    const doc    = prEl( 'div', 'pr-doc' );
    const stages = trip.stages || [];

    const head = prEl( 'div', 'pr-head' );
    head.appendChild( prEl( 'h1', null, trip.destination || T( 'trips.trip' ) ) );
    // Nothing below the title: no date range, no folder path - the title alone.
    doc.appendChild( head );

    // -- Trip summary --
    const stageDocCount = stages.reduce( function( a, st ) { return a + (( st.documents || [] ).length); }, 0 );
    const days = tripDayCount( trip );

    const sumSec = prEl( 'section', 'pr-sec' );
    sumSec.appendChild( prEl( 'h2', null, T( 'trips.summary' ) ) );
    sumSec.appendChild( prKvTable( [
        [ T( 'trips.dates' ),               fmtRange( trip.startDate, trip.endDate ) ],
        [ T( 'trips.duration' ),             days != null ? TF( days === 1 ? 'trips.oneDay' : 'trips.nDays', { n: days } ) : '' ],
        [ T( 'trips.coords' ),          stages.length ? '' : coordText( trip.lat, trip.lon ) ],
        [ T( 'trips.stageCount' ),         String( stages.length ) ],
        [ T( 'trips.tripDocs' ), String( ( trip.documents || [] ).length ) ],
        [ T( 'trips.stageDocs' ), String( stageDocCount ) ]
    ] ) );
    doc.appendChild( sumSec );

    // -- Trip documents --
    const docsSec = prEl( 'section', 'pr-sec' );
    docsSec.appendChild( prEl( 'h2', null, T( 'trips.tripDocs' ) ) );
    if( trip.documents && trip.documents.length )
        docsSec.appendChild( prDocList( trip, trip.documents ) );
    else
        docsSec.appendChild( prEl( 'p', 'pr-empty', T( 'trips.noDocs' ) ) );
    doc.appendChild( docsSec );

    // -- Itinerary --
    const itinSec = prEl( 'section', 'pr-sec' );
    itinSec.appendChild( prEl( 'h2', null, T( 'trips.itinerary' ) ) );

    if( ! stages.length )
    {
        itinSec.appendChild( prEl( 'p', 'pr-empty', T( 'trips.noStagesOneLeg' ) ) );
    }
    else
    {
        const ol = prEl( 'ol', 'pr-stages' );

        stages.forEach( function( st, i )
        {
            const li     = prEl( 'li', 'pr-stage' );
            const isLast = i === stages.length - 1;

            const h = prEl( 'div', 'pr-stage-head' );
            h.appendChild( prEl( 'span', 'pr-num', String( i + 1 ) ) );
            h.appendChild( prEl( 'span', 'pr-loc', st.location || T( 'trips.noLocation' ) ) );
            // A stage's transport is how you travel onward from it, so the last stage has none.
            if( ! isLast )
                h.appendChild( prEl( 'span', 'pr-transport', TRANSPORT_LABELS()[ st.transport ] || T( 'trips.trOther' ) ) );
            li.appendChild( h );

            // "Salida" / "Llegada" are the journey's departure and arrival stamps
            // (stage start/end time, on the stage start/end date). The plain date
            // range lives in "Fechas"; the times move onto their own rows next to
            // the transport mode.
            const depTxt = st.startTime ? fmtDate( st.startDate ) + ' ' + st.startTime : '';
            const arrTxt = st.endTime   ? fmtDate( st.endDate )   + ' ' + st.endTime   : '';
            const cur      = stageCurrency( st );
            const stDocs   = st.documents || [];

            li.appendChild( prKvTable( [
                [ T( 'trips.location' ),   st.location || T( 'trips.noLocation' ) ],
                [ T( 'trips.dates' ),      fmtRange( fmtDate( st.startDate ), fmtDate( st.endDate ) ) ],
                [ T( 'trips.timezone' ), [ st.tzLabel, st.tz && st.tz !== st.tzLabel ? '(' + st.tz + ')' : '' ].filter( Boolean ).join( ' ' ) || st.tz || '' ],
                [ T( 'trips.coords' ), coordText( st.lat, st.lon ) ],
                [ T( 'trips.transport' ),  isLast ? '' : ( TRANSPORT_LABELS()[ st.transport ] || T( 'trips.trOther' ) ) ],
                [ T( 'trips.departure' ),      depTxt ],
                [ T( 'trips.arrival' ),     arrTxt ],
                [ T( 'trips.currency' ),      cur.code + ( cur.matched ? '' : ' (aproximada)' ) ],
                [ T( 'trips.weather' ), stagePrintWeather( st ) ],
                [ T( 'trips.lodging' ), st.accommodation && st.accommodation.trim() ? st.accommodation.trim() : '' ],
                [ NayiveUI.t( 'ui.notes' ),       st.notes && st.notes.trim() ? st.notes.trim() : '' ],
                [ T( 'trips.documents' ),  String( stDocs.length ) ]
            ] ) );

            if( stDocs.length )
            {
                const dw = prEl( 'div', 'pr-stage-docs' );
                dw.appendChild( prEl( 'strong', null, T( 'trips.stageDocsColon' ) ) );
                dw.appendChild( prDocList( trip, stDocs ) );
                li.appendChild( dw );
            }

            ol.appendChild( li );
        });

        itinSec.appendChild( ol );
    }

    doc.appendChild( itinSec );

    // -- Appendix: every associated file path in one list --
    const files = [];
    ( trip.documents || [] ).forEach( function( d ) { files.push( [ T( 'trips.trip' ), d ] ); } );
    stages.forEach( function( st, i )
    {
        ( st.documents || [] ).forEach( function( d )
        {
            files.push( [ TF( 'trips.stageN', { n: i + 1 } ) + ( st.location ? ' · ' + st.location : '' ), d ] );
        });
    });

    const filesSec = prEl( 'section', 'pr-sec' );
    filesSec.appendChild( prEl( 'h2', null, T( 'trips.linkedFiles' ) ) );

    if( ! files.length )
    {
        filesSec.appendChild( prEl( 'p', 'pr-empty', T( 'trips.noLinkedFiles' ) ) );
    }
    else
    {
        const tbl = prEl( 'table', 'pr-files' );
        const hr  = document.createElement( 'tr' );
        [ T( 'trips.belongsTo' ), T( 'trips.document' ), T( 'trips.fullPath' ) ].forEach( function( t ) { hr.appendChild( prEl( 'th', null, t ) ); } );
        tbl.appendChild( hr );

        files.forEach( function( f )
        {
            const owner = f[ 0 ], d = f[ 1 ];
            const tr = document.createElement( 'tr' );
            tr.appendChild( prEl( 'td', null, owner ) );
            tr.appendChild( prEl( 'td', null, (d.name && d.name.trim()) || T( 'trips.docUntitled' ) ) );
            tr.appendChild( prEl( 'td', null, docFullPath( trip, d ) || T( 'trips.docNoFileParen' ) ) );
            tbl.appendChild( tr );
        });

        filesSec.appendChild( tbl );
    }

    doc.appendChild( filesSec );

    // -- Route map, last: the whole route with every stage marked --
    const mapSec = buildPrintRouteMap( trip );
    if( mapSec )
    {
        doc.appendChild( mapSec );
        doc._initMap = mapSec._initMap || null;   // exportTripPdf() runs this once the node is laid out
    }

    doc.appendChild( prEl( 'div', 'pr-foot', TF( 'trips.generatedOn', { date: todayIso() } ) + ' · Trips — Nayive' ) );

    return doc;
}

// The Leaflet map built for the print sheet. Kept in one place so exportTripPdf()
// can invalidateSize() it before printing and remove() it on afterprint.
let printMapInstance = null;

// The route-map section for the PDF's last page: the full route with a coloured
// leg per hop and every stage marked and labelled. Returns null when the trip has
// nothing to plot. The Leaflet map itself is built later, via section._initMap(),
// because Leaflet must measure a container that is already laid out (exportTripPdf
// stages #printRoot off-screen for exactly this).
function buildPrintRouteMap( trip )
{
    const pts = ( trip.stages || [] )
        .filter( function( st ) { return stageEnabled( st ) && typeof st.lat === 'number' && typeof st.lon === 'number'; } )
        .map( function( st, i ) { return { lat: st.lat, lon: st.lon, label: st.location, index: i + 1, transport: st.transport || 'other' }; } );

    const hasTripPin = ( trip.stages || [] ).length === 0 && typeof trip.lat === 'number' && typeof trip.lon === 'number';

    if( ! pts.length && ! hasTripPin )
        return null;

    const sec = prEl( 'section', 'pr-sec pr-map-sec' );
    sec.appendChild( prEl( 'h2', null, T( 'trips.routeMap' ) ) );

    if( ! navigator.onLine )
    {
        sec.appendChild( prEl( 'p', 'pr-empty', T( 'trips.mapNeedsNetPdf' ) ) );
        return sec;
    }

    // Legend: one entry per transport mode actually used between stages.
    const modes = [];
    pts.slice( 0, -1 ).forEach( function( p ) { if( modes.indexOf( p.transport ) === -1 ) modes.push( p.transport ); } );

    if( modes.length )
    {
        const legend = prEl( 'div', 'pr-map-legend' );
        modes.forEach( function( m )
        {
            const it = prEl( 'span', 'pr-map-legend-item' );
            const sw = prEl( 'span', 'pr-map-legend-swatch' );
            sw.style.background = TRANSPORT_COLORS[ m ] || TRANSPORT_COLORS.other;
            it.appendChild( sw );
            it.appendChild( document.createTextNode( TRANSPORT_LABELS()[ m ] || T( 'trips.trOther' ) ) );
            legend.appendChild( it );
        });
        sec.appendChild( legend );
    }

    const mapDiv = prEl( 'div', 'pr-map' );
    sec.appendChild( mapDiv );

    sec._initMap = function( onReady )
    {
        if( printMapInstance ) { printMapInstance.remove(); printMapInstance = null; }

        // A static snapshot: no zoom/pan controls, not interactive - it only has to print.
        const map = L.map( mapDiv, { zoomControl: false, attributionControl: true,
                                     dragging: false, scrollWheelZoom: false, doubleClickZoom: false } );
        printMapInstance = map;

        let fired = false;
        const ready = function() { if( fired ) return; fired = true; onReady(); };
        NayiveBaseMap.add( map, { print: true, onReady: ready } );

        if( pts.length )
        {
            for( let i = 1; i < pts.length; i++ )
            {
                const mode = pts[ i - 1 ].transport;
                L.polyline( [ [ pts[i-1].lat, pts[i-1].lon ], [ pts[i].lat, pts[i].lon ] ],
                    { color: TRANSPORT_COLORS[ mode ] || TRANSPORT_COLORS.other,
                      weight: 4, opacity: 0.9, dashArray: '8, 8', lineJoin: 'round' } ).addTo( map );
            }

            pts.forEach( function( p )
            {
                L.marker( [ p.lat, p.lon ] )
                    .bindTooltip( p.index + '. ' + ( p.label || '' ),
                                  { permanent: true, direction: 'top', offset: [ 0, -6 ] } )
                    .addTo( map );
            });

            map.fitBounds( pts.map( function( p ) { return [ p.lat, p.lon ]; } ), { padding: [ 34, 34 ], maxZoom: 12 } );
        }
        else
        {
            map.setView( [ trip.lat, trip.lon ], 9 );
            L.marker( [ trip.lat, trip.lon ] )
                .bindTooltip( trip.destination || '', { permanent: true, direction: 'top', offset: [ 0, -6 ] } )
                .addTo( map );
        }

        map.invalidateSize();
        setTimeout( ready, 2500 );   // fallback: 'load' may never fire if every tile is cached or errors
    };

    return sec;
}
