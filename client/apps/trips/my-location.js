/* my-location.js - "My location": the account's location URL for a phone app. */

//------------------------------------------------------------------------//
// This account's ONE location URL: where a phone app sends where you are,
// from the background, for every trip (server/go/location.go). On iPhone
// that is Overland (free, open source, not ours), with a one-tap set-up link.
// On Android the Nayive app does it by itself (/api/device/report, no URL),
// so Android gets a card that recommends the app instead (2026-10-02; it was
// GPSLogger - its URL ending still works for phones already sending). A PC
// shows both cards. An Android phone sees the URL only to turn it off.
// Returns an element that loads and redraws itself: make it, add it, done.
// Trips' Settings › Location (route.js openSettings) is its home; it lived
// in shared/ui.js until 2026-09-28 (shared.md #21).
function locationSection()
{
    const t = NayiveUI.t;

    const box = document.createElement( 'div' );
    box.className = 'share-sect share-link';

    let tracker = null;      // {url, created} when on
    let loaded  = false;

    function isAndroid() { return /android/i.test( navigator.userAgent ); }
    function isPC()      { return ! NayiveUI.isIOS() && ! isAndroid(); }

    const APPS = [
        {
            key:   'overland',
            name:  'Overland',
            head:  'trips.loc.overland',
            about: 'trips.loc.overlandAbout',
            how:   'trips.loc.overlandHow',
            store: 'https://apps.apple.com/app/id1292426766',
            mine:  NayiveUI.isIOS,
            // The app reads its whole setup from this link: no typing on the phone.
            setup: function( url ) { return 'overland://setup?url=' + encodeURIComponent( url ) + '&device_id=nayive'; }
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

    // The app's name, what it does, where to get it. Its address comes
    // after the on / off box (appAddress).
    function appCard( app )
    {
        const card = document.createElement( 'div' );
        card.className = 'loc-app';

        const head = document.createElement( 'p' );
        head.className   = 'share-head';
        head.textContent = t( app.head );
        card.appendChild( head );

        // What the app does, always - the iPhone twin of the Android card's words.
        const about = document.createElement( 'p' );
        about.className   = 'share-note';
        about.textContent = t( app.about );
        card.appendChild( about );

        const links = document.createElement( 'p' );
        links.className = 'loc-links';
        links.appendChild( linkButton( t( 'trips.loc.get' ).replace( '{app}', app.name ), app.store ) );
        card.appendChild( links );

        return card;
    }

    // Switched on: the address, below the on / off box (his call, 2026-10-02),
    // then how to give it to the app.
    function appAddress( app, url, last )
    {
        const card = document.createElement( 'div' );
        card.className = 'loc-app';

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

        const mine = app.mine();
        if( mine )
        {
            const links = document.createElement( 'p' );
            links.className = 'loc-links';
            links.appendChild( linkButton( t( 'trips.loc.setup' ).replace( '{app}', app.name ), app.setup( url ) ) );
            card.appendChild( links );
        }

        // The steps - or, on a PC, the same from the phone. The (i) follows
        // the sheet's last words, but only when those words are the steps.
        const how = document.createElement( 'p' );
        how.className   = 'share-note share-link-how';
        how.textContent = mine ? t( app.how ) : t( 'trips.loc.onPhone' );
        if( last && mine ) how.appendChild( infoButton() );
        card.appendChild( how );

        return card;
    }

    // Android: the Nayive app sends where you are by itself, and does much
    // more - recommend it. It needs no location URL. Inside the app already:
    // say so, no "Get" button (his call, 2026-10-02).
    function apkCard()
    {
        const card = document.createElement( 'div' );
        card.className = 'loc-app';

        const head = document.createElement( 'p' );
        head.className   = 'share-head';
        head.textContent = t( 'trips.loc.apk' );
        card.appendChild( head );

        const how = document.createElement( 'p' );
        how.className   = 'share-note';
        how.textContent = t( NayiveUI.inAndroidApp() ? 'trips.loc.apkHave' : 'trips.loc.apkHow' );
        card.appendChild( how );
        if( NayiveUI.inAndroidApp() ) return card;

        const links = document.createElement( 'p' );
        links.className = 'loc-links';
        links.appendChild( linkButton( t( 'trips.loc.getApk' ), window.location.origin + '/app/' ) );
        card.appendChild( links );

        return card;
    }

    // The on / off for the location address, boxed and loud (his call,
    // 2026-10-02). Only Overland (iPhone) and old GPSLogger phones use it - the
    // Nayive app does not. It sits last, at the bottom of the tab (his call).
    // On makes the address; off asks first, then drops it.
    function masterRow()
    {
        const row = document.createElement( 'label' );
        row.className = 'share-add loc-master' + ( tracker ? ' on' : '' );

        const text = document.createElement( 'span' );
        text.className   = 'loc-master-text';
        text.textContent = loaded ? t( tracker ? 'trips.loc.on' : 'trips.loc.none' ) : '…';
        row.appendChild( text );
        if( loaded && ! tracker ) row.appendChild( infoButton() );

        const input = document.createElement( 'input' );
        input.type     = 'checkbox';
        // The row is a <label>: tie it to the switch, or a click anywhere
        // in it goes to the (i), the first control inside.
        input.id       = 'locMasterSw';
        row.htmlFor    = input.id;
        input.checked  = !! tracker;
        input.disabled = ! loaded;
        input.addEventListener( 'change', function()
        {
            input.disabled = true;
            const done = input.checked
                ? NayiveUI.jsonApi( '/api/location', 'POST' )
                : NayiveUI.confirm( { title: t( 'trips.loc.stopTitle' ), body: t( 'trips.loc.stopBody' ),
                                      confirm: t( 'trips.loc.stopOk' ) } )
                      .then( function( yes ) { if( yes ) return NayiveUI.jsonApi( '/api/location', 'DELETE' ); } );
            done.then( load, function( e ) { NayiveUI.toast( e.message || t( 'ui.loadFailed' ) ); load(); } );
        } );

        const sw = document.createElement( 'span' );
        sw.className = 'switch sm';
        const track = document.createElement( 'span' );
        track.className = 'track';
        sw.appendChild( input );
        sw.appendChild( track );
        row.appendChild( sw );

        return row;
    }

    function render()
    {
        box.innerHTML = '';

        const note = document.createElement( 'p' );
        note.className   = 'share-note';
        note.textContent = t( 'trips.loc.lead' );
        box.appendChild( note );

        if( isAndroid() || isPC() ) box.appendChild( apkCard() );

        const base  = tracker ? window.location.origin + tracker.url : '';
        const cards = APPS.filter( function( a ) { return a.mine() || isPC(); } );
        cards.forEach( function( a ) { box.appendChild( appCard( a ) ); } );

        // Android has no use for the address: its switch shows only to turn an old one off.
        if( ! ( isAndroid() && ! tracker ) ) box.appendChild( masterRow() );

        if( tracker )
            cards.forEach( function( a, i )
            {
                box.appendChild( appAddress( a, base + '/' + a.key, i === cards.length - 1 ) );
            } );

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
