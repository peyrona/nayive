/* render.js - the header and the content (trip list / open trip). */

//------------------------------------------------------------------------//
// RENDERING - HEADER

function renderHeader()
{
    const header = document.getElementById( 'tripHeader' );
    header.innerHTML = '';

    // Trailing controls go in their own group so the whole button bar
    // wraps below the title as a unit when the header is too narrow.
    const actions = document.createElement( 'div' );
    actions.className = 'trip-header-actions';

    if( view === 'list' )
    {
        header.appendChild( svgIcon( ICON_TRIP, 26, 'app-icon' ) );

        const h1 = document.createElement( 'h1' );
        h1.className = 'app-title';
        h1.style.flex = '1 1 auto';
        h1.textContent = 'Trips';
        header.appendChild( h1 );

        const addBtn = document.createElement( 'button' );
        addBtn.className = 'icon-btn';
        addBtn.id    = 'addTripBtn';          // the help dialog points at it
        addBtn.title = T( 'trips.addTrip' );
        addBtn.appendChild( svgIcon( ICON_PLUS, 18 ) );
        addBtn.addEventListener( 'click', openAddTrip );
        actions.appendChild( addBtn );

        // "My location": the location URL that feeds every trip's Journey map.
        const locBtn = document.createElement( 'button' );
        locBtn.className = 'icon-btn';
        locBtn.id    = 'myLocationBtn';       // the help dialog points at it
        locBtn.title = T( 'trips.myLocation' );
        locBtn.appendChild( svgIcon( ICON_PIN, 17 ) );
        locBtn.addEventListener( 'click', openMyLocation );
        actions.appendChild( locBtn );

        actions.appendChild( buildHelpBtn() );
        actions.appendChild( buildSyncIndicator() );
        header.appendChild( actions );
    }
    else
    {
        const trip = findTrip( selectedTripId );

        if( ! trip ) { view = 'list'; renderHeader(); return; }

        const backBtn = document.createElement( 'button' );
        backBtn.className = 'icon-btn';
        backBtn.title = T( 'trips.backToTrips' );
        backBtn.appendChild( svgIcon( ICON_ARROW_L, 17 ) );
        backBtn.addEventListener( 'click', goToList );
        header.appendChild( backBtn );

        const titleWrap = document.createElement( 'div' );
        titleWrap.className = 'trip-header-title';

        // The name and, on a trip somebody shared with us, the read-only pill
        // right after it: the pill says something about THIS trip, so it reads
        // next to its name instead of among the action buttons at the far end.
        const nameRow = document.createElement( 'div' );
        nameRow.className = 'trip-header-name';
        const h1 = document.createElement( 'h1' );
        h1.textContent = trip.destination;
        nameRow.appendChild( h1 );

        if( tripIsRO( trip ) ) nameRow.appendChild( NayiveUI.sharedBadge( sharedBy( trip ) ) );

        const sub = document.createElement( 'span' );
        sub.className = 'trip-header-sub';
        sub.textContent = fmtRange( trip.startDate, trip.endDate );
        titleWrap.appendChild( nameRow );
        titleWrap.appendChild( sub );
        header.appendChild( titleWrap );

        const mapBtn = document.createElement( 'button' );
        mapBtn.id = 'mapBtn';
        mapBtn.className = 'icon-btn';
        mapBtn.title = T( 'trips.routeMap' );
        mapBtn.appendChild( svgIcon( ICON_MAP, 17 ) );
        // Sheet opens BEFORE the map is built - Leaflet measures its container's size at
        // init, and a still-hidden (display:none) container measures as 0x0.
        mapBtn.addEventListener( 'click', function() { openSheet( 'mapSheetBackdrop' ); renderMapSheet(); } );
        actions.appendChild( mapBtn );

        // The currency converter lives in the header only when the whole trip uses one
        // currency (or has no stages yet). When stages span several currencies it moves
        // onto each stage card instead - see buildStageItem().
        if( currencyPlacement( trip ) === 'trip' )
        {
            const calcBtn = document.createElement( 'button' );
            calcBtn.className = 'icon-btn';
            calcBtn.appendChild( svgIcon( ICON_CALCULATOR, 17 ) );
            calcBtn.addEventListener( 'click', function() { openCurrency(); } );

            // With no stages AND a destination that isn't a recognisable place, the
            // converter can only fall back to a guessed EUR - worse than nothing for
            // money. Disable it and say why. (A trip WITH stages keeps it: the sheet's
            // own "couldn't determine the currency" disclaimer covers a vague title.)
            const noStages     = ( trip.stages || [] ).length === 0;
            const unknownPlace = ! detectCurrency( trip.destination ).matched;

            if( noStages && unknownPlace )
            {
                calcBtn.disabled = true;
                calcBtn.title = T( 'trips.fxNoCountry' );
            }
            else
            {
                calcBtn.title = T( 'trips.fxTitle' );
            }

            actions.appendChild( calcBtn );
        }

        // Share and export-PDF are NOT here: both sit on the trip's card in the
        // list (buildTripCard), where they act on a whole trip without opening it.

        // A trip another user shared with us can be read and mapped - never
        // changed. The server refuses every write on a shared/... path, so these
        // buttons simply are not built. (The read-only pill itself sits next to
        // the title, see above.)
        if( ! tripIsRO( trip ) )
        {
            const editBtn = document.createElement( 'button' );
            editBtn.className = 'icon-btn';
            editBtn.title = T( 'trips.editTrip' );
            editBtn.appendChild( svgIcon( ICON_PENCIL, 17 ) );
            editBtn.addEventListener( 'click', openEditTrip );
            actions.appendChild( editBtn );

            const delBtn = document.createElement( 'button' );
            delBtn.className = 'icon-btn danger';
            delBtn.title = T( 'trips.deleteTrip' );
            delBtn.appendChild( svgIcon( ICON_TRASH, 16 ) );
            delBtn.addEventListener( 'click', function()
            {
                openConfirm( T( 'trips.deleteTrip' ), TF( 'trips.deleteTripBody', { name: trip.destination } ), NayiveUI.t( 'ui.delete' ), deleteTrip );
            });
            actions.appendChild( delBtn );

            // The stages help: a shared trip has none of the buttons it explains.
            actions.appendChild( buildHelpBtn() );
        }

        actions.appendChild( buildSyncIndicator() );
        header.appendChild( actions );
    }

    // The "?" answers about the screen you are on (see TRIPS_INTRO).
    if( window.TRIPS_INTRO && NayiveUI.setIntro )
        NayiveUI.setIntro( view === 'detail' ? TRIPS_INTRO.stages : TRIPS_INTRO.home );
}

// The toolbar "?" - opens whichever card NayiveUI.setIntro last picked.
function buildHelpBtn()
{
    const b = document.createElement( 'button' );
    b.className = 'icon-btn';
    b.type = 'button';
    b.title = NayiveUI.t( 'ui.help' );
    b.setAttribute( 'aria-label', NayiveUI.t( 'ui.help' ) );
    b.setAttribute( 'data-intro-open', '' );
    b.appendChild( svgIcon( ICON_HELP, 18 ) );
    return b;
}

//------------------------------------------------------------------------//
// RENDERING - CONTENT (list / detail)

function renderContent()
{
    const content = document.getElementById( 'tripContent' );
    content.innerHTML = '';

    if( view === 'list' )
        content.appendChild( buildListView() );
    else
        content.appendChild( buildDetailView() );
}

function buildListView()
{
    const wrap  = document.createElement( 'div' );
    const today = todayIso();

    const upcoming = trips.filter( function( t ) { return t.endDate >= today; } ).sort( function( a, b ) { return a.startDate.localeCompare( b.startDate, NayiveUI.lang() ); } );
    const past     = trips.filter( function( t ) { return t.endDate < today; } ).sort( function( a, b ) { return b.startDate.localeCompare( a.startDate, NayiveUI.lang() ); } );

    if( trips.length === 0 )
    {
        const note = document.createElement( 'div' );
        note.className = 'empty-list-note';
        note.textContent = T( 'trips.noTrips' );
        wrap.appendChild( note );
        return wrap;
    }

    if( upcoming.length )
    {
        wrap.appendChild( sectionLabel( T( 'trips.upcoming' ), false ) );
        upcoming.forEach( function( t ) { wrap.appendChild( buildTripCard( t, false ) ); } );
    }

    if( past.length )
    {
        wrap.appendChild( sectionLabel( T( 'trips.past' ), true ) );
        past.forEach( function( t ) { wrap.appendChild( buildTripCard( t, true ) ); } );
    }

    return wrap;
}

function sectionLabel( sText, bSpaced )
{
    const el = document.createElement( 'div' );
    el.className = 'section-label' + (bSpaced ? ' spaced' : '');
    el.textContent = sText;
    return el;
}

// Whole days from today (local) until `isoDate`. 0 = today, negative = in the past.
function daysUntil( isoDate )
{
    if( ! isoDate ) return null;
    const ms = new Date( isoDate + 'T00:00:00' ) - new Date( todayIso() + 'T00:00:00' );
    return isNaN( ms ) ? null : Math.round( ms / 86400000 );
}

// The right-aligned countdown pill for an upcoming trip: "Faltan N días" until it
// starts, "Empieza hoy", or "En curso" once the start date has passed. Past trips
// (their end date is gone) get nothing.
function tripCountdownPill( t, bPast )
{
    if( bPast ) return null;

    const d = daysUntil( t.startDate );
    if( d == null ) return null;

    const txt = d <  0 ? T( 'trips.ongoing' )
              : d === 0 ? T( 'trips.startsToday' )
              : d === 1 ? T( 'trips.oneDayLeft' )
              :           TF( 'trips.nDaysLeft', { n: d } );

    const p = pill( txt );
    p.classList.add( 'meta-pill-right' );
    return p;
}

function buildTripCard( t, bPast )
{
    const totalDocs = t.documents.length + t.stages.reduce( function( a, st ) { return a + st.documents.length; }, 0 );
    const nStages   = t.stages.length;

    const card = document.createElement( 'div' );
    card.className = 'trip-card' + (bPast ? ' past' : '');
    // The card opens the trip - its own action buttons must not (same guard the
    // stage cards use).
    card.addEventListener( 'click', function( e )
    {
        if( e.target.closest( 'button' ) ) return;
        goToDetail( t.id );
    });

    const top = document.createElement( 'div' );
    top.className = 'trip-card-top';

    const avatar = document.createElement( 'div' );
    avatar.className = 'trip-avatar';
    avatar.appendChild( svgIcon( ICON_TRIP, 24 ) );
    top.appendChild( avatar );

    const info = document.createElement( 'div' );
    info.className = 'trip-info';
    const name = document.createElement( 'div' );
    name.className = 'trip-name';
    name.textContent = t.destination;
    const dates = document.createElement( 'div' );
    dates.className = 'trip-dates';
    dates.textContent = fmtRange( t.startDate, t.endDate );
    info.appendChild( name );
    info.appendChild( dates );
    top.appendChild( info );

    // The card's toolbar: this trip's own actions. No "open" button - the card
    // body itself opens the trip (see the click handler above).
    const actions = document.createElement( 'div' );
    actions.className = 'trip-card-actions';

    const pdfBtn = document.createElement( 'button' );
    pdfBtn.className = 'icon-btn sm trip-pdf-btn';     // the help dialog points at it
    pdfBtn.title = T( 'trips.exportPdf' );
    pdfBtn.appendChild( svgIcon( ICON_EXPORT, 17 ) );
    pdfBtn.addEventListener( 'click', function() { exportTripPdf( t ); } );
    actions.appendChild( pdfBtn );

    // A trip somebody shared with us is not ours to pass on - the server refuses
    // every write on a shared/... path. Printing it is fine, so only Share goes.
    if( ! tripIsRO( t ) )
    {
        const shareBtn = document.createElement( 'button' );
        shareBtn.className = 'icon-btn sm trip-share-btn';   // the help dialog points at it
        shareBtn.title = T( 'trips.shareTrip' );
        shareBtn.appendChild( svgIcon( ICON_SHARE, 17 ) );
        shareBtn.addEventListener( 'click', function()
        {
            NayiveUI.shareSheet( { path: tripBase( t ), app: 'trips',
                                   title: t.destination || T( 'trips.trip' ) } );
        });
        actions.appendChild( shareBtn );
    }

    top.appendChild( actions );
    card.appendChild( top );

    const meta = document.createElement( 'div' );
    meta.className = 'trip-card-meta';
    meta.appendChild( pill( nStages   === 0 ? T( 'trips.noStages' )
                          : nStages   === 1 ? T( 'trips.oneStage' ) : TF( 'trips.nStages', { n: nStages } ) ) );
    meta.appendChild( pill( totalDocs === 0 ? T( 'trips.noDocsShort' )
                          : totalDocs === 1 ? T( 'trips.oneDoc' )   : TF( 'trips.nDocs',   { n: totalDocs } ) ) );

    const countdown = tripCountdownPill( t, bPast );
    if( countdown ) meta.appendChild( countdown );

    card.appendChild( meta );

    return card;
}

function pill( sText )
{
    const el = document.createElement( 'span' );
    el.className = 'meta-pill';
    el.textContent = sText;
    return el;
}

function buildDetailView()
{
    const trip = findTrip( selectedTripId );
    const wrap = document.createElement( 'div' );

    if( ! trip )
        return wrap;

    const tz     = viewerTz();
    const hereId = hereStageId( trip );

    // A shared trip lends its photo folder too (see sharedRef), so the row
    // is shown there as well - just without the pick / clear buttons.
    if( ! tripIsRO( trip ) || (trip.photosDir || '').trim() )
        wrap.appendChild( buildPhotosRow( trip ) );

    // "Documentos  (i) [+]" - the "+" opens the trip sheet on a fresh, blank
    // document row; the info dot is the one that used to sit in that sheet.
    const ro       = tripIsRO( trip );
    const docsCtls = ro ? [] : [ docsLabelInfoDot(),
                                 headingBtn( T( 'trips.addDoc' ), ICON_PLUS, addTripDocFromDetail ) ];

    const docsSec = collapsibleSection( T( 'trips.documents' ), true, 'docs', docsCtls );
    if( trip.documents.length )
        docsSec.body.appendChild( buildFileList( trip, trip.documents, deleteTripDoc ) );
    else
        docsSec.body.appendChild( emptyNote( T( 'trips.noDocsYet' ) ) );
    wrap.appendChild( docsSec.el );

    const itinSec = collapsibleSection( T( 'trips.itinerary' ), false, 'itin',
                                        ro ? [] : [ headingBtn( T( 'trips.addStage' ), ICON_PLUS, openAddStage ) ] );
    if( trip.stages.length )
    {
        const timeline = document.createElement( 'div' );
        timeline.className = 'timeline';
        trip.stages.forEach( function( st, i ) { timeline.appendChild( buildStageItem( trip, st, tz, i === trip.stages.length - 1, hereId ) ); } );
        itinSec.body.appendChild( timeline );
    }
    else
    {
        itinSec.body.appendChild( emptyNote( T( 'trips.noStagesOneLeg' ) ) );
    }

    wrap.appendChild( itinSec.el );

    return wrap;
}

// The "Fotos" row: one row holding the "Fotos" label (styled like the Documentos /
// Itinerario headings, just inline - no row to spare), the folder path, and the
// [pick] + [clear] buttons. The path is a pointer into the user's files/ tree
// (trip.photosDir); nothing reads the pictures here - clicking the path opens that
// folder in Drive in a new tab.
function photoDirDisplay( sPath )
{
    const parts = String( sPath || '' ).replace( /^\/+/, '' ).replace( /^files\//, '' ).split( '/' ).filter( Boolean );
    if( parts.length <= 2 ) return parts.join( '/' );
    return '…/' + parts.slice( -2 ).join( '/' );
}

function buildPhotosRow( trip )
{
    const ro  = tripIsRO( trip );
    const row = document.createElement( 'div' );
    row.className = 'photos-row';

    const label = document.createElement( 'span' );
    label.className = 'photos-label';
    label.textContent = T( 'trips.photos' );
    row.appendChild( label );

    const dir  = (trip.photosDir || '').trim();
    const path = document.createElement( 'span' );

    if( dir )
    {
        path.className = 'photos-path';
        path.textContent = '"' + photoDirDisplay( dir ) + '"';
        // The row is called "Fotos", so it opens Photos — an album, not a
        // file list. On a shared trip that is the "shared/<slug>/~/..."
        // path the share lends us (read-only); on our own, the folder
        // itself. (It used to open Drive; Photos is the right tool, and it
        // is the same app in both cases.)
        path.title = ( ro ? photoDirDisplay( dir ) : dir ) + '\n' + T( 'trips.openInPhotos' );
        path.addEventListener( 'click', function()
        {
            window.open( '../photos/index.html?dir=' +
                         encodeURIComponent( sharedRef( tripBase( trip ), dir ) ),
                         '_blank', 'noopener' );
        });
    }
    else
    {
        path.className = 'photos-path empty';
        path.textContent = T( 'trips.noFolder' );
    }

    row.appendChild( path );

    // Someone else's trip: look at the folder, never repoint it.
    if( ro ) return row;

    const btn = document.createElement( 'button' );
    btn.className = 'icon-btn';
    btn.title = T( 'trips.pickPhotoFolder' );
    btn.appendChild( svgIcon( ICON_FOLDER, 15 ) );
    btn.addEventListener( 'click', function()
    {
        // Same folder picker Photos / Music / Movies use (NayiveUI.pickFolder),
        // not the old files/ tree sheet - don't reinvent the wheel.
        NayiveUI.pickFolder( { title: T( 'trips.pickPhotoFolderNote' ) } ).then( function( sPath )
        {
            if( ! sPath ) return;
            mutateTrip( selectedTripId, function( t ) { return { ...t, photosDir: sPath }; } );
        });
    });
    row.appendChild( btn );

    if( dir )
    {
        const clearBtn = document.createElement( 'button' );
        clearBtn.className = 'icon-btn';
        clearBtn.title = T( 'trips.clearPhotoFolder' );
        clearBtn.appendChild( svgIcon( ICON_X, 15 ) );
        clearBtn.addEventListener( 'click', function()
        {
            mutateTrip( selectedTripId, function( t ) { const u = { ...t }; delete u.photosDir; return u; } );
        });
        row.appendChild( clearBtn );
    }

    return row;
}

const collapsedSections = (function()
{
    try { return JSON.parse( localStorage.getItem( 'trip-collapsed' ) || '{}' ); }
    catch( e ) { return {}; }
})();

function saveCollapsedSections()
{
    try { localStorage.setItem( 'trip-collapsed', JSON.stringify( collapsedSections ) ); }
    catch( e ) {}
}

// Unfold a section (e.g. "Documentos" after a document was added, so the user
// sees it there). Call before the redraw.
function expandSection( sKey )
{
    if( ! collapsedSections[ sKey ] ) return;
    collapsedSections[ sKey ] = false;
    saveCollapsedSections();
}

// A "Documentos" / "Itinerario" block: a heading that folds the body away, and -
// like the "Fotos" row above them - room for one or two controls after the label.
// `aControls` are appended NEXT TO the heading, not inside it: the heading is
// itself a <button> and a button may not contain another one.
function collapsibleSection( sText, bFirst, sKey, aControls )
{
    const el = document.createElement( 'div' );
    el.className = 'detail-section';

    const row = document.createElement( 'div' );
    row.className = 'detail-heading-row' + (bFirst ? ' first' : '');

    const head = document.createElement( 'button' );
    head.type = 'button';
    head.className = 'detail-heading collapsible';
    head.appendChild( svgIcon( ICON_CHEVRON_DOWN, 16, 'sec-chevron' ) );
    head.appendChild( document.createTextNode( sText ) );
    row.appendChild( head );

    ( aControls || [] ).forEach( function( c ) { if( c ) row.appendChild( c ); } );

    const body = document.createElement( 'div' );
    body.className = 'section-body';

    let bCollapsed = !! collapsedSections[ sKey ];

    function apply()
    {
        el.classList.toggle( 'collapsed', bCollapsed );
        body.hidden = bCollapsed;
        head.setAttribute( 'aria-expanded', String( ! bCollapsed ) );
    }

    head.addEventListener( 'click', function()
    {
        bCollapsed = ! bCollapsed;
        collapsedSections[ sKey ] = bCollapsed;
        saveCollapsedSections();
        apply();
    });

    apply();
    el.appendChild( row );
    el.appendChild( body );
    return { el: el, body: body };
}

// A heading control, styled like the folder button on the "Fotos" row.
function headingBtn( sTitle, sIcon, fnClick )
{
    const b = document.createElement( 'button' );
    b.type = 'button';
    b.className = 'icon-btn';
    b.title = sTitle;
    b.setAttribute( 'aria-label', sTitle );
    b.appendChild( svgIcon( sIcon, 15 ) );
    b.addEventListener( 'click', fnClick );
    return b;
}

function emptyNote( sText )
{
    const el = document.createElement( 'div' );
    el.className = 'empty-note';
    el.textContent = sText;
    return el;
}

// `fnDelete( doc )`, when given (and the trip is ours), adds a trash button at the
// right end of every row.
function buildFileList( trip, docs, fnDelete )
{
    const list = document.createElement( 'div' );
    list.className = 'file-list';
    const canDelete = !! fnDelete && ! tripIsRO( trip );

    docs.forEach( function( d )
    {
        const has = docHasFile( d );
        const row = document.createElement( has && ! canDelete ? 'a' : 'div' );
        row.className = 'file-row';

        // With a delete button the link is an inner element, so the button is not inside it.
        const link = canDelete ? document.createElement( has ? 'a' : 'span' ) : row;
        if( canDelete )
        {
            link.className = 'file-open';
            row.appendChild( link );
        }

        if( has )
        {
            link.href = docHref( trip, d );
            link.target = '_blank';
            link.rel = 'noopener';
        }

        const iconWrap = document.createElement( 'span' );
        iconWrap.className = 'file-icon';
        iconWrap.appendChild( svgIcon( docIsLink( d ) ? ICON_LINK : DOC_ICONS[ docTypeBucket( d.type ) ], 16 ) );
        link.appendChild( iconWrap );

        // One line: the file itself (with its extension), or "no attachment".
        const name = document.createElement( 'span' );
        name.className = 'file-name';
        name.textContent = ! has          ? T( 'trips.noAttachment' )
                         : docIsLink( d ) ? d.path
                         : ( d.file || docPath( tripBase( trip ), d ) );
        if( docIsLink( d ) )
            link.title = tripIsRO( trip )
                       ? TF( 'trips.linkedFromOwner', { who: sharedBy( trip ) || T( 'trips.whoShares' ) } )
                       : T( 'trips.linkedFromFiles' );
        link.appendChild( name );

        if( canDelete )
        {
            const delBtn = document.createElement( 'button' );
            delBtn.className = 'icon-btn sm danger file-del';
            delBtn.title = T( 'trips.deleteDoc' );
            delBtn.appendChild( svgIcon( ICON_TRASH, 15 ) );
            delBtn.addEventListener( 'click', function()
            {
                openConfirm( T( 'trips.deleteDoc' ), TF( 'trips.deleteStageBody', { name: name.textContent } ),
                             NayiveUI.t( 'ui.delete' ), function() { fnDelete( d ); } );
            });
            row.appendChild( delBtn );
        }

        list.appendChild( row );
    });

    return list;
}

function docTypeBucket( sType )
{
    if( sType === 'passport' ) return 'passport';
    if( sType === 'visa' )     return 'visa';
    if( sType === 'ticket' || sType === 'hotel' ) return 'booking';
    return 'other';
}

function buildStageItem( trip, st, sViewerTz, bIsLast, hereId )
{
    const isHere  = hereId != null && st.id === hereId;
    const enabled = stageEnabled( st );

    const item = document.createElement( 'div' );
    item.className = 'stage-item' + (enabled ? '' : ' disabled');
    item.dataset.stageId = st.id;

    const node = document.createElement( 'div' );
    node.className = 'stage-node' + (isHere ? ' here' : '');
    // The node icon is this stage's onward transport (matches the map leg leaving it);
    // the final stage has no onward journey, so it shows a location pin instead.
    node.appendChild( svgIcon( bIsLast ? ICON_PIN : ( TRANSPORT_ICONS[ st.transport ] || TRANSPORT_ICONS.other ), 17 ) );
    item.appendChild( node );

    const card = document.createElement( 'div' );
    card.className = 'stage-card' + (isHere ? ' here' : '') + (enabled ? '' : ' disabled');

    const top = document.createElement( 'div' );
    top.className = 'stage-top';

    // Drag handle - grab it to reorder the stage within the itinerary. Shown on
    // every card, including a disabled (collapsed) one, so any stage can be moved.
    if( ! tripIsRO( trip ) )
    {
        const grip = document.createElement( 'span' );
        grip.className = 'stage-drag';
        grip.title = T( 'trips.dragToReorder' );
        grip.innerHTML = GRIP_SVG;
        grip.addEventListener( 'pointerdown', function( e ) { onStageDragStart( e, st.id ); } );
        top.appendChild( grip );
    }

    const loc = document.createElement( 'span' );
    loc.className = 'stage-loc' + (enabled ? '' : ' disabled');
    loc.textContent = st.location;
    top.appendChild( loc );

    // Only show the destination clock when its wall time differs from the viewer's
    // own local time (same offset -> no point repeating what the device clock says).
    const stageTime = st.tz ? localTimeIn( st.tz ) : '';
    if( enabled && stageTime && stageTime !== localTimeIn( sViewerTz ) )
    {
        const clock = document.createElement( 'span' );
        clock.className = 'stage-clock';
        clock.title = T( 'trips.localTimeNow' );
        clock.appendChild( svgIcon( ICON_CLOCK, 12 ) );
        clock.appendChild( document.createTextNode( ' ' + stageTime ) );
        top.appendChild( clock );
    }

    if( isHere && enabled )
    {
        const badge = document.createElement( 'span' );
        badge.className = 'here-badge';
        badge.appendChild( svgIcon( ICON_PIN, 11 ) );
        badge.appendChild( document.createTextNode( ' ' + T( 'trips.youAreHere' ) ) );
        top.appendChild( badge );
    }

    const actions = document.createElement( 'div' );
    actions.className = 'stage-actions';

    const editBtn = document.createElement( 'button' );
    editBtn.className = 'icon-btn';
    editBtn.title = T( 'trips.editStage' );
    editBtn.appendChild( svgIcon( ICON_PENCIL, 15 ) );
    editBtn.addEventListener( 'click', function() { openEditStage( st.id ); } );

    const delBtn = document.createElement( 'button' );
    delBtn.className = 'icon-btn danger';
    delBtn.title = T( 'trips.deleteStage' );
    delBtn.appendChild( svgIcon( ICON_TRASH, 15 ) );
    delBtn.addEventListener( 'click', function()
    {
        const label = ( st.location || '' ).trim() || T( 'trips.thisStage' );
        openConfirm( T( 'trips.deleteStage' ), TF( 'trips.deleteStageBody', { name: label } ), NayiveUI.t( 'ui.delete' ), function() { deleteStage( st.id ); } );
    });

    // The eye toggles this stage enabled/disabled - same control as a password field.
    const eyeBtn = document.createElement( 'button' );
    eyeBtn.className = 'icon-btn';
    eyeBtn.title = enabled ? T( 'trips.disableStage' ) : T( 'trips.enableStage' );
    eyeBtn.appendChild( svgIcon( enabled ? ICON_EYE : ICON_EYE_OFF, 15 ) );
    eyeBtn.addEventListener( 'click', function() { toggleStage( st.id ); } );

    // Edit + delete + eye all live in the top row (reordering is the drag handle
    // before the title). A disabled stage collapses to just grip + title + eye.
    if( ! tripIsRO( trip ) )
    {
        if( enabled )
        {
            actions.appendChild( editBtn );
            actions.appendChild( delBtn );
        }
        actions.appendChild( eyeBtn );
    }
    top.appendChild( actions );

    card.appendChild( top );

    // Clicking anywhere on the card (except a link, a button or the drag handle)
    // opens the stage editor. Press-and-drag on the card body reorders instead
    // (onStageCardPointerDown) - and leaves a fresh stageDragEndedAt so the
    // click the browser fires after a drop doesn't also open the editor.
    card.addEventListener( 'pointerdown', function( e ) { onStageCardPointerDown( e, st.id, card ); } );

    // Pointing at a card draws the leg it departs on as a solid line, so you can see on
    // the map which hop of the trip the card is. Mouse only - a touch screen has no
    // hover, and below 920px there is no map beside the list anyway (it opens in a sheet).
    card.addEventListener( 'mouseenter', function()
    {
        if( hoveredStageId && hoveredStageId !== st.id ) setLegActive( hoveredStageId, false );

        hoveredStageId = st.id;
        setLegActive( st.id, true );
    });
    card.addEventListener( 'mouseleave', function()
    {
        if( hoveredStageId === st.id ) hoveredStageId = null;
        setLegActive( st.id, false );
    });
    card.addEventListener( 'click', function( e )
    {
        if( tripIsRO( trip ) ) return;                      // someone else's trip: look, don't touch
        if( e.target.closest( 'a, button, .stage-drag' ) ) return;
        if( Date.now() - stageDragEndedAt < 350 ) return;   // just finished a reorder drag, not a click
        openEditStage( st.id );
    });

    // A disabled stage shows nothing but grip + title + eye - no dates, weather,
    // accommodation, notes or documents.
    if( ! enabled )
    {
        item.appendChild( card );
        return item;
    }

    const dtRow = document.createElement( 'div' );
    dtRow.className = 'stage-row stage-daterow';
    dtRow.appendChild( svgIcon( ICON_CALENDAR, 14 ) );
    const dtText = document.createElement( 'span' );
    const startTxt = fmtDate( st.startDate ) + ( st.startTime ? ' ' + st.startTime : '' );
    const endTxt   = fmtDate( st.endDate )   + ( st.endTime   ? ' ' + st.endTime   : '' );
    dtText.textContent = fmtRange( startTxt, endTxt );   // one date-range format in the app
    dtRow.appendChild( dtText );

    const dtRight = document.createElement( 'div' );
    dtRight.className = 'stage-daterow-right';

    // The (optional) per-stage converter, then the weather.
    if( currencyPlacement( trip ) === 'stage' )
    {
        const cur     = stageCurrency( st );
        const stCalc  = document.createElement( 'button' );
        stCalc.className = 'icon-btn';
        stCalc.title  = TF( 'trips.fxTitleCode', { code: cur.code } );
        stCalc.appendChild( svgIcon( ICON_CALCULATOR, 15 ) );
        stCalc.addEventListener( 'click', function() { openCurrency( cur.code, cur.matched, st.location ); } );
        dtRight.appendChild( stCalc );
    }

    // Weather forecast for the stage's start date - min temp, glyph, max temp.
    const wx = document.createElement( 'div' );
    wx.className = 'stage-weather';
    dtRight.appendChild( wx );
    fillStageWeather( wx, st );

    dtRow.appendChild( dtRight );
    card.appendChild( dtRow );

    if( st.accommodation && st.accommodation.trim() )
    {
        const row = document.createElement( 'div' );
        row.className = 'stage-row';
        row.appendChild( svgIcon( ICON_PIN, 14 ) );
        const t2 = document.createElement( 'span' );
        t2.textContent = st.accommodation;
        row.appendChild( t2 );
        card.appendChild( row );
    }

    if( st.notes && st.notes.trim() )
    {
        const notes = document.createElement( 'div' );
        notes.className = 'stage-notes';
        notes.textContent = st.notes;
        card.appendChild( notes );
    }

    if( st.documents.length )
    {
        const docsWrap = document.createElement( 'div' );
        docsWrap.className = 'stage-docs';
        docsWrap.appendChild( buildFileList( trip, st.documents, function( d ) { deleteStageDoc( st.id, d ); } ) );
        card.appendChild( docsWrap );
    }

    item.appendChild( card );
    return item;
}
