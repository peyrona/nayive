/*
 * theme.js - Colour-scheme toggle shared by every Balata single-page app.
 *
 * Works together with shared/theme.css. Responsibilities:
 *
 *   1. Apply the saved scheme on load (the <head> inline script already does
 *      this before first paint; this repeats it so the page is correct even if
 *      the inline script was omitted).
 *   2. Enhance the app's toggle button. The app supplies an empty
 *          <button class="icon-btn" data-theme-toggle title="Tema"></button>
 *      somewhere in its header; this script fills in the icon and handles the
 *      click. Because the button keeps the app's own .icon-btn class it looks
 *      native to each app.
 *   3. Keep the <meta name="theme-color"> in sync (mobile browser chrome).
 *   4. React to the "storage" event so a change made in one tab / app updates
 *      every other open tab on this origin (also covers the planner iframes).
 *   5. Apply the user's custom colour scheme, if any. The launcher's "Esquemas
 *      de color" dialog stores schemes under "balata-schemes"; the active one
 *      for the current mode is painted as inline :root overrides on top of
 *      theme.css. No custom scheme -> theme.css's built-in palette is used.
 *   6. AUTOMATIC mode: follow the real sun. When "balata-theme-auto" is "1"
 *      this script works out sunrise and sunset for the device's coordinates
 *      and flips the theme at each of them, on a timer. See AUTOMATIC below.
 *
 * The choice is stored in localStorage under "balata-theme" with value
 * "light" or "dark". Light is the default; only an explicit "dark" is dark.
 * That key always holds the RESOLVED mode, even in automatic mode: the inline
 * <head> script in every app reads it before first paint and knows nothing
 * about the sun, and every other tab picks the change up through "storage".
 *
 * Load with:  <script src="../shared/theme.js" defer></script>
 */
( function ()
{
    "use strict";

    var KEY   = "balata-theme";
    var SKEY  = "balata-schemes";
    var AKEY  = "balata-theme-auto";      // "1" while automatic mode is on
    var GKEY  = "balata-geo";             // { lat, lon } for the sun maths
    var LIGHT = "light";
    var DARK  = "dark";

    // The tokens a custom scheme can override (see theme.css): the four neutrals,
    // the highlight colour and the ink on it. A key the scheme lacks falls back
    // to theme.css.
    var SCHEME_KEYS = [ "--bg", "--card", "--card2", "--line", "--accent", "--on-accent" ];


    // Sun shown while dark is active (click for light); moon while light is active.
    var SUN =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="4.2"></circle>' +
        '<path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"></path>' +
        '</svg>';

    var MOON =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>' +
        '</svg>';

    function saved()
    {
        try { return localStorage.getItem( KEY ) === DARK ? DARK : LIGHT; }
        catch ( e ) { return LIGHT; }
    }


    // ----------------------------------------------------------------- //
    // AUTOMATIC MODE - dark after sunset, light after sunrise.
    //
    // Works the same on a phone and on a PC because it needs nothing from the
    // operating system: the browser gives us coordinates once, and the rest is
    // arithmetic. The coordinates live in localStorage, NOT on the account:
    // the timezone belongs to the person, but a laptop travels, so where you
    // are right now is a fact about this device. They are rounded to one
    // decimal (~10 km) - all a sunrise needs, and not a home address.
    //
    // No coordinates (permission refused, old browser, kiosk) is not a
    // failure: auto mode falls back to a plain FALLBACK_RISE-FALLBACK_SET
    // window on the device's own clock.
    // ----------------------------------------------------------------- //

    var RAD      = Math.PI / 180;
    var FALLBACK_RISE = 7;                 // hours, local, used when we have no coordinates
    var FALLBACK_SET  = 19;
    var MAX_WAIT = 6 * 3600 * 1000;        // never sleep longer than this before looking again

    var timer = null;                      // the pending "flip at the next boundary" timeout

    function isAuto()
    {
        try { return localStorage.getItem( AKEY ) === "1"; }
        catch ( e ) { return false; }
    }

    function geo()
    {
        try
        {
            var g = JSON.parse( localStorage.getItem( GKEY ) || "null" );
            if( g && typeof g.lat === "number" && typeof g.lon === "number" ) return g;
        }
        catch ( e ) { /* ignore */ }

        return null;
    }

    // NOAA's sunrise equation in its short form - about a minute of error, which
    // is far more than a colour switch will ever need, and no table and no
    // network. `dayOffset` picks the local solar day: 0 = the one `now` is in.
    // Returns { rise: Date, set: Date }, or the string "up" / "down" near the
    // poles, where the sun does not cross the horizon at all that day.
    function sunTimes( now, lat, lon, dayOffset )
    {
        var jd = now.getTime() / 86400000 + 2440587.5;                  // Julian date of `now`

        // `n` counts whole days since 2000-01-01, but of the LOCAL solar day:
        // the lon/360 term picks the noon nearest `now` at this longitude, so
        // the rise and set we return always straddle today, never yesterday.
        var n     = Math.round( jd - 2451545.0 + 0.0008 + lon / 360 ) + ( dayOffset || 0 );
        var jStar = n - lon / 360;    // the formula counts longitude WEST-positive; geolocation gives east

        var M = ( 357.5291 + 0.98560028 * jStar ) % 360;                // solar mean anomaly
        var C = 1.9148 * Math.sin( M * RAD )
              + 0.0200 * Math.sin( 2 * M * RAD )
              + 0.0003 * Math.sin( 3 * M * RAD );                       // equation of the centre
        var L = ( M + C + 180 + 102.9372 ) % 360;                       // ecliptic longitude

        var jTransit = 2451545.0 + jStar
                     + 0.0053 * Math.sin( M * RAD )
                     - 0.0069 * Math.sin( 2 * L * RAD );                // local solar noon

        var sinDec = Math.sin( L * RAD ) * Math.sin( 23.44 * RAD );     // 23.44 deg = Earth's tilt
        var cosDec = Math.cos( Math.asin( sinDec ) );

        // -0.833 deg, not 0: the sun's disc is half a degree wide and the air
        // bends its light, so it LOOKS risen while its centre is still below.
        var cosW = ( Math.sin( -0.833 * RAD ) - Math.sin( lat * RAD ) * sinDec )
                 / ( Math.cos( lat * RAD ) * cosDec );

        if( cosW >  1 ) return "down";        // polar night: it never comes up
        if( cosW < -1 ) return "up";          // midnight sun: it never goes down

        var w = Math.acos( cosW ) / RAD;      // half the day, as an hour angle in degrees

        return {
            rise: new Date( ( jTransit - w / 360 - 2440587.5 ) * 86400000 ),
            set:  new Date( ( jTransit + w / 360 - 2440587.5 ) * 86400000 )
        };
    }

    // Which mode it should be right now, and when that stops being true.
    // `next` is null when there is no boundary to wait for (polar day/night),
    // and the caller then just looks again later.
    function autoState( now )
    {
        var g = geo();

        if( ! g )
        {
            var h    = now.getHours() + now.getMinutes() / 60;
            var edge = new Date( now.getTime() );
            edge.setMinutes( 0, 0, 0 );

            if( h < FALLBACK_RISE ) { edge.setHours( FALLBACK_RISE ); return { mode: DARK,  next: edge }; }
            if( h < FALLBACK_SET )  { edge.setHours( FALLBACK_SET  ); return { mode: LIGHT, next: edge }; }

            edge.setHours( FALLBACK_RISE );
            edge.setTime( edge.getTime() + 86400000 );
            return { mode: DARK, next: edge };
        }

        var today = sunTimes( now, g.lat, g.lon, 0 );

        if( today === "up"   ) return { mode: LIGHT, next: null };
        if( today === "down" ) return { mode: DARK,  next: null };

        if( now < today.rise ) return { mode: DARK,  next: today.rise };
        if( now < today.set  ) return { mode: LIGHT, next: today.set  };

        // After sunset: the next boundary is tomorrow's sunrise.
        var tomorrow = sunTimes( now, g.lat, g.lon, 1 );
        return { mode: DARK, next: ( tomorrow.rise && tomorrow.rise > now ) ? tomorrow.rise : null };
    }

    function schedule( next )
    {
        if( timer ) { clearTimeout( timer ); timer = null; }
        if( ! isAuto() ) return;

        // +1s so we land just PAST the boundary and never re-fire on the same one.
        var wait = next ? ( next.getTime() - Date.now() + 1000 ) : MAX_WAIT;

        if( wait > MAX_WAIT ) wait = MAX_WAIT;     // a long wait is re-checked instead of trusted
        if( wait < 1000     ) wait = 1000;

        timer = setTimeout( tick, wait );
    }

    // Work out the mode, apply it, and book the next check. Safe to call as
    // often as you like - and it IS called often (every focus, every wake).
    //
    // Hence the guard: apply() fires "balata:themechange", and Calc answers that
    // by re-rendering the whole grid, which would throw away a half-typed cell.
    // Nothing has moved unless the mode actually changed, so say nothing.
    function tick()
    {
        if( ! isAuto() ) return;

        var st = autoState( new Date() );
        if( st.mode !== saved() ) set( st.mode );  // set() writes KEY, so other tabs follow
        schedule( st.next );
    }

    function setAuto( on )
    {
        try { localStorage.setItem( AKEY, on ? "1" : "0" ); }
        catch ( e ) { /* private mode: this session only */ }

        if( on ) tick();
        else if( timer ) { clearTimeout( timer ); timer = null; }
    }

    // The active custom scheme object for a mode, or null when none is set.
    function activeScheme( mode )
    {
        try
        {
            var d = JSON.parse( localStorage.getItem( SKEY ) || "null" );
            if( ! d || ! d.schemes || ! d.schemes.length ) return null;

            var id = mode === LIGHT ? d.activeLight : d.activeDark;
            if( ! id ) return null;

            for( var i = 0; i < d.schemes.length; i++ )
                if( d.schemes[ i ].id === id ) return d.schemes[ i ];
        }
        catch ( e ) { /* ignore */ }

        return null;
    }

    function applyScheme( mode )
    {
        var root = document.documentElement;
        var s    = activeScheme( mode );

        for( var i = 0; i < SCHEME_KEYS.length; i++ )
        {
            var k = SCHEME_KEYS[ i ];

            if( s && s.tokens && s.tokens[ k ] ) root.style.setProperty( k, s.tokens[ k ] );
            else                                 root.style.removeProperty( k );
        }
    }

    function metaThemeColor()
    {
        var m = document.querySelector( 'meta[name="theme-color"]' );

        if( ! m )
        {
            m = document.createElement( "meta" );
            m.setAttribute( "name", "theme-color" );
            document.head.appendChild( m );
        }

        return m;
    }

    function apply( mode )
    {
        var root = document.documentElement;

        if( mode === LIGHT ) root.setAttribute( "data-theme", LIGHT );
        else                 root.removeAttribute( "data-theme" );

        applyScheme( mode );

        // Read the resolved --bg so the browser chrome matches the scheme.
        var bg = getComputedStyle( root ).getPropertyValue( "--bg" ).trim();
        if( bg ) metaThemeColor().setAttribute( "content", bg );

        var btn = document.querySelector( "[data-theme-toggle]" );

        if( btn )
        {
            btn.innerHTML = mode === LIGHT ? MOON : SUN;
            // The label says what the button DOES, so it flips with the mode. It is
            // written as i18n keys and filled in by applyI18n, because this runs long
            // before the dictionary has landed.
            btn.setAttribute( "data-i18n-attr", mode === LIGHT
                            ? "title:ui.themeDark,  aria-label:ui.themeToDark"
                            : "title:ui.themeLight, aria-label:ui.themeToLight" );

            if( window.NayiveI18n ) window.NayiveI18n.ready.then( function () { window.NayiveI18n.applyI18n( btn ); } );
        }

        // Apps with a themed third-party widget (Handsontable, TinyMCE, CodeMirror) listen
        // for this to re-skin the widget, which CSS variables alone cannot reach.
        window.dispatchEvent( new CustomEvent( "balata:themechange", { detail: { theme: mode } } ) );
    }

    function set( mode )
    {
        try { localStorage.setItem( KEY, mode ); } catch ( e ) { /* private mode: keep for this session only */ }
        apply( mode );
    }

    // The button is a MANUAL choice, so it also switches automatic mode off -
    // the same thing a phone does when you flip the theme by hand. Automatic is
    // turned back on from the launcher's "Mi cuenta" dialog.
    function toggle()
    {
        setAuto( false );
        set( saved() === LIGHT ? DARK : LIGHT );
    }

    function init()
    {
        apply( saved() );
        if( isAuto() ) tick();

        var btn = document.querySelector( "[data-theme-toggle]" );
        if( btn ) btn.addEventListener( "click", toggle );

        // A change in another tab / app on this origin (theme choice, a scheme
        // edit, or automatic mode being switched on or off).
        window.addEventListener( "storage", function ( e )
        {
            if( e.key === KEY || e.key === SKEY ) apply( saved() );

            if( e.key === AKEY || e.key === GKEY )
            {
                if( isAuto() ) tick();
                else if( timer ) { clearTimeout( timer ); timer = null; }
            }
        } );

        // A setTimeout does not survive a sleeping phone or a closed laptop lid,
        // so look again whenever the page comes back to the front.
        document.addEventListener( "visibilitychange", function ()
        {
            if( ! document.hidden && isAuto() ) tick();
        } );

        window.addEventListener( "focus",   function () { if( isAuto() ) tick(); } );
        window.addEventListener( "pageshow", function () { if( isAuto() ) tick(); } );
    }

    // Let the launcher's scheme dialog re-apply after it edits "balata-schemes"
    // (the "storage" event only fires in the OTHER tabs).
    window.BalataTheme = {
        refresh: function () { apply( saved() ); },

        // Automatic mode, driven by the launcher's "Mi cuenta" dialog.
        isAuto:  isAuto,
        setAuto: setAuto,
        hasGeo:  function () { return !! geo(); },

        // Coordinates are DEVICE data, not account data - see AUTOMATIC MODE
        // above. Rounded to one decimal (~10 km) before they are stored.
        setGeo: function ( lat, lon )
        {
            try
            {
                localStorage.setItem( GKEY, JSON.stringify( {
                    lat: Math.round( lat * 10 ) / 10,
                    lon: Math.round( lon * 10 ) / 10
                } ) );
            }
            catch ( e ) { /* private mode: fall back to the fixed window */ }

            if( isAuto() ) tick();
        },

        clearGeo: function ()
        {
            try { localStorage.removeItem( GKEY ); } catch ( e ) { /* ignore */ }
            if( isAuto() ) tick();
        }
    };

    if( document.readyState === "loading" ) document.addEventListener( "DOMContentLoaded", init );
    else init();
} )();
