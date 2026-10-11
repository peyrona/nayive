/* intro.js - the two help cards (trip list, open trip). */

NayiveI18n.ready.then( function () {
    if( ! window.NayiveUI ) return;
    var T = function ( k ) { return NayiveUI.t( k ); };

    // TWO help cards, like Split: the trip list and one open trip (its stages).
    // renderHeader() calls NayiveUI.setIntro with the card for the screen you
    // are on. The stage rows use named icons (not `sel`): a trip with no stages
    // yet has no stage buttons on screen.
    // The guided tour ("Ver el tour" in the card) walks the card's rows on the
    // screen you are on ('buttons'). On a trip each stage row lights the first
    // stage's own button, found by its label; with no stage yet, the
    // itinerary heading stands in as a ghost.
    var STAGE = function ( key ) { return '.stage-actions .icon-btn[title="' + T( key ) + '"]'; };
    var NO_STAGE = '.timeline, .detail-section .empty-note, #tripContent';
    var stages = {
        app:   'trips',
        title: T( 'trips.itinerary' ),
        tour:  [ 'buttons' ],
        buttons: [
            { icon: 'search', name: T( 'ui.search' ),           text: T( 'ui.tour.search' ), tour: { sel: '#searchBtn' } },
            { icon: 'plus',   name: T( 'trips.addStage' ),      text: T( 'trips.introStage' ),
              tour: { sel: '.detail-heading-row .icon-btn[aria-label="' + T( 'trips.addStage' ) + '"]' } },
            { icon: 'compass', name: T( 'trips.disc.btn' ),      text: T( 'trips.introDiscover' ), tour: { sel: STAGE( 'trips.disc.btn' ), ghost: NO_STAGE } },
            { icon: 'edit',   name: T( 'trips.editStage' ),     text: T( 'trips.introEditStage' ), tour: { sel: STAGE( 'trips.editStage' ), ghost: NO_STAGE } },
            { icon: 'eyeoff', name: T( 'trips.toggleStage' ),   text: T( 'trips.introToggleStage' ),
              tour: { sel: STAGE( 'trips.disableStage' ) + ', ' + STAGE( 'trips.enableStage' ), ghost: NO_STAGE } },
            { icon: 'trash',  name: T( 'trips.deleteStage' ),   text: T( 'trips.introDeleteStage' ), tour: { sel: STAGE( 'trips.deleteStage' ), ghost: NO_STAGE } },
            { icon: 'grip',   name: T( 'trips.introDragName' ), text: T( 'trips.introDrag' ), tour: { sel: '.stage-drag', ghost: NO_STAGE } }
        ],
        tip: T( 'trips.introMap' )
    };

    var home = {
        app:   'trips',
        title: 'Trips',
        lead:  NayiveUI.t( 'trips.introLead' ),
        buttons: [
            { sel: '.trip-header-actions #searchBtn', text: NayiveUI.t( 'ui.tour.search' ) },
            { sel: '.trip-header-actions #addTripBtn', text: NayiveUI.t( 'trips.introAdd' ) },
            { sel: '.trip-header-actions #settingsBtn', text: NayiveUI.t( 'trips.introSettings' ) },
            // Export and Share are on each trip card, so they show once the list has a trip.
            { sel: '.trip-card-actions .trip-pdf-btn',   text: NayiveUI.t( 'trips.introExport' ), tour: { ghost: '.trip-card, .empty-list-note, #tripContent' } },
            { sel: '.trip-card-actions .trip-share-btn', text: NayiveUI.t( 'trips.introShare' ), tour: { ghost: '.trip-card, .empty-list-note, #tripContent' } }
        ],
        tour: [ { sel: '.trip-card', ghost: '.empty-list-note, #tripContent', icon: 'forward', text: NayiveUI.t( 'trips.tourOpen' ) }, 'buttons' ]
    };

    window.TRIPS_INTRO = { home: home, stages: stages };
    NayiveUI.firstRun( home );
} );
