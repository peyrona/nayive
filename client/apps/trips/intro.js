/* intro.js - the two help cards (trip list, open trip). */

NayiveI18n.ready.then( function () {
    if( ! window.NayiveUI ) return;
    var T = function ( k ) { return NayiveUI.t( k ); };

    // TWO help cards, like Split: the trip list and one open trip (its stages).
    // renderHeader() calls NayiveUI.setIntro with the card for the screen you
    // are on. The stage rows use named icons (not `sel`): a trip with no stages
    // yet has no stage buttons on screen.
    var stages = {
        app:   'trips',
        title: T( 'trips.itinerary' ),
        buttons: [
            { icon: 'plus',   name: T( 'trips.addStage' ),      text: T( 'trips.introStage' ) },
            { icon: 'compass', name: T( 'trips.disc.btn' ),      text: T( 'trips.introDiscover' ) },
            { icon: 'edit',   name: T( 'trips.editStage' ),     text: T( 'trips.introEditStage' ) },
            { icon: 'eyeoff', name: T( 'trips.toggleStage' ),   text: T( 'trips.introToggleStage' ) },
            { icon: 'trash',  name: T( 'trips.deleteStage' ),   text: T( 'trips.introDeleteStage' ) },
            { icon: 'grip',   name: T( 'trips.introDragName' ), text: T( 'trips.introDrag' ) }
        ],
        tip: T( 'trips.introMap' )
    };

    var home = {
        app:   'trips',
        title: 'Trips',
        lead:  NayiveUI.t( 'trips.introLead' ),
        buttons: [
            { sel: '.trip-header-actions #addTripBtn', text: NayiveUI.t( 'trips.introAdd' ) },
            { sel: '.trip-header-actions #settingsBtn', text: NayiveUI.t( 'trips.introSettings' ) },
            // Export and Share are on each trip card, so they show once the list has a trip.
            { sel: '.trip-card-actions .trip-pdf-btn',   text: NayiveUI.t( 'trips.introExport' ) },
            { sel: '.trip-card-actions .trip-share-btn', text: NayiveUI.t( 'trips.introShare' ) },
            { sel: '.trip-header-actions .sync-indicator', name: NayiveUI.t( 'ui.syncName' ),
              text: NayiveUI.t( 'trips.introSync' ) }
        ]
    };

    window.TRIPS_INTRO = { home: home, stages: stages };
    NayiveUI.firstRun( home );
} );
