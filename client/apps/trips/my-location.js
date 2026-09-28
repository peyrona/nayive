/* my-location.js - "My location": the account's location URL for a phone app. */

//------------------------------------------------------------------------//
// This account's ONE location URL: where a phone app sends where you are,
// from the background, for every trip (server/go/location.go). Two apps use
// it, both free and open source, neither ours - Overland on iPhone,
// GPSLogger on Android. Each has its own ending on the same key and its own
// one-tap set-up link, so the phone being read on decides which card is
// shown; a PC, which can set up neither, shows both.
// Returns an element that loads and redraws itself: make it, add it, done.
// Trips' "My location" sheet (route.js openMyLocation) is its home; it lived
// in shared/ui.js until 2026-09-28 (shared.md #21).
function locationSection()
{
    const t = NayiveUI.t;

    const box = document.createElement( 'div' );
    box.className = 'share-sect share-link';

    let tracker = null;      // {url, created} when on
    let loaded  = false;

    function isAndroid() { return /android/i.test( navigator.userAgent ); }

    const APPS = [
        {
            key:   'overland',
            name:  'Overland',
            head:  'trips.loc.overland',
            how:   'trips.loc.overlandHow',
            store: 'https://apps.apple.com/app/id1292426766',
            mine:  NayiveUI.isIOS,
            // The app reads its whole setup from this link: no typing on the phone.
            setup: function( url ) { return 'overland://setup?url=' + encodeURIComponent( url ) + '&device_id=nayive'; }
        },
        {
            key:   'gpslogger',
            name:  'GPSLogger',
            head:  'trips.loc.gpslogger',
            how:   'trips.loc.gpsloggerHow',
            store: 'https://f-droid.org/packages/com.mendhak.gpslogger/',
            mine:  isAndroid,
            // Same idea, its own way: the server writes a .properties profile.
            setup: function( url ) { return 'gpslogger://properties/' + url + '.properties'; }
        }
    ];

    // (i): what the apps are, and where your location goes.
    function infoButton()
    {
        const info = document.createElement( 'button' );
        info.className = 'info-dot';
        info.setAttribute( 'data-info', t( 'trips.loc.info' ) );
        return info;
    }

    // A link that looks like a button. The store opens in a new tab; a set-up
    // link hands over to the app itself, so it stays in this one.
    function linkButton( label, href )
    {
        const a = document.createElement( 'a' );
        a.className   = 'loc-link';
        a.href        = href;
        a.textContent = label;
        if( /^https:/.test( href ) ) { a.target = '_blank'; a.rel = 'noopener'; }
        return a;
    }

    function appCard( app, url, last )
    {
        const card = document.createElement( 'div' );
        card.className = 'loc-app';

        const head = document.createElement( 'p' );
        head.className   = 'share-head';
        head.textContent = t( app.head );
        card.appendChild( head );

        const row = document.createElement( 'div' );
        row.className = 'share-row share-link-app';

        const text = document.createElement( 'span' );
        text.className   = 'share-link-url';
        text.textContent = url;
        row.appendChild( text );
        row.appendChild( NayiveUI.rowButton( 'copy', t( 'trips.loc.copy' ), function()
        {
            return NayiveUI.copyText( url ).then( function() { NayiveUI.toast( t( 'share.link.copied' ) ); },
                                                  function() { NayiveUI.toast( url ); } );
        } ) );
        card.appendChild( row );

        const links = document.createElement( 'p' );
        links.className = 'loc-links';
        links.appendChild( linkButton( t( 'trips.loc.get' ).replace( '{app}', app.name ), app.store ) );
        if( app.mine() )
            links.appendChild( linkButton( t( 'trips.loc.setup' ).replace( '{app}', app.name ), app.setup( url ) ) );
        card.appendChild( links );

        // The steps - or, on a PC, where to go instead. The (i) follows the
        // sheet's last words, but only when those words are the steps.
        const mine = app.mine();
        const how  = document.createElement( 'p' );
        how.className   = 'share-note share-link-how';
        how.textContent = mine ? t( app.how ) : t( 'trips.loc.onPhone' );
        if( last && mine ) how.appendChild( infoButton() );
        card.appendChild( how );

        return card;
    }

    function render()
    {
        box.innerHTML = '';

        const note = document.createElement( 'p' );
        note.className   = 'share-note';
        note.textContent = t( 'trips.loc.lead' );
        box.appendChild( note );

        if( ! tracker )
        {
            // Nothing set up yet: one row, and the "+" that makes the URL.
            const row = document.createElement( 'div' );
            row.className = 'share-row share-link-app';

            const text = document.createElement( 'span' );
            text.className   = 'share-link-url';
            text.textContent = loaded ? t( 'trips.loc.none' ) : '…';
            row.appendChild( text );

            if( loaded )
            {
                text.classList.add( 'has-info' );
                row.appendChild( infoButton() );
                row.appendChild( NayiveUI.rowButton( 'plus', t( 'trips.loc.create' ), function()
                {
                    return NayiveUI.jsonApi( '/api/location', 'POST' ).then( load );
                } ) );
            }
            box.appendChild( row );
            NayiveUI.applyInfoDots( box );
            return;
        }

        const base  = window.location.origin + tracker.url;
        const cards = APPS.filter( function( a ) { return a.mine() || ( ! NayiveUI.isIOS() && ! isAndroid() ); } );
        cards.forEach( function( a, i )
        {
            box.appendChild( appCard( a, base + '/' + a.key, i === cards.length - 1 ) );
        } );

        // Turning off is about the key, not the app: one button for both.
        const off = document.createElement( 'div' );
        off.className = 'share-row loc-off';

        const onText = document.createElement( 'span' );
        onText.className   = 'share-link-url';
        onText.textContent = t( 'trips.loc.on' );
        off.appendChild( onText );

        off.appendChild( NayiveUI.rowButton( 'x', t( 'trips.loc.stop' ), function()
        {
            // The phone keeps sending to this URL, which then just fails: ask first.
            return NayiveUI.confirm( { title: t( 'trips.loc.stopTitle' ), body: t( 'trips.loc.stopBody' ),
                                       confirm: t( 'trips.loc.stopOk' ) } )
                .then( function( yes ) { if( yes ) return NayiveUI.jsonApi( '/api/location', 'DELETE' ).then( load ); } );
        } ) );
        box.appendChild( off );

        NayiveUI.applyInfoDots( box );
    }

    function load()
    {
        return NayiveUI.jsonApi( '/api/location', 'GET' )
            .then( function( j ) { tracker = j && j.url ? j : null; },
                   function( e ) { NayiveUI.toast( e.message || t( 'ui.loadFailed' ) ); } )
            .then( function() { loaded = true; render(); } );
    }

    render();
    load();
    return box;
}
