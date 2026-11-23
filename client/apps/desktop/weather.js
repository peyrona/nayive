// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/* desktop/weather.js - the weather on the desktop's bar, out of Ayni's desk page (2026-11-23): it fetches and
   runs on a timer, so it is Nayive's, not UI. The sky now on the bar (#wxBtn), today's forecast in its popup
   (#wxPop), and the WEATHER rows of the "⋮" - one place, units and provider per user (data/weather.json, saved
   version-checked by the engine of shared/lockers/culture.js, weatherUpdate). set.weatherBar: this device.
   A plain script: desktop/index.html puts the markup in the desk page's slots, then calls
     var WX = NayiveDesk.weather( D, hooks )     WX: { wxSvg( sky, day ) }, the icons, for the help card. */
( window.NayiveDesk = window.NayiveDesk || {} ).weather = function ( D, h )
{
    var set = D.set, saveSet = D.saveSet, placeMore = D.relayout, moreBtn = D.moreBtn, setTip = D.setTip, t = D.t;

    // WEATHER - this device's choice (set.weatherBar, the "⋮" menu): the sky
    // now as an icon on the bar, again every 30 min; a press opens today's
    // forecast beside it, fetched then (never on its own). The place, the units
    // and who gives it are ONE per user (data/weather.json, set below in this
    // menu, read by both lockers too); the engine is Bellas artes': shared/lockers/culture.js, loaded only when
    // this is on. Its cache too ("nv-culture:"): the locker reuses our call.

    var wxBtn = document.getElementById( 'wxBtn' ), wxPop = document.getElementById( 'wxPop' ),
        wxChk = document.getElementById( 'weatherBarChk' );
    var wxTimer = 0, wxGen = 0, wxPopGen = 0, wxCached = null;
    var WX_EVERY = 30 * 60000;

    // One icon per sky of the engine's skyOf (clear, partly cloudy, cloudy, fog,
    // drizzle, rain, snow, showers, storm), [ day, night ] where they differ.
    // Class "s" paints amber (sun, bolt), "sd" fills the sun's disc, "r" blue (rain, snow).
    var WX_CLOUD = '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>';
    // A sun behind the cloud `d`: its rays, and its disc (filled, like the clear
    // sky's) cut away by the cloud with a small gap - a mask, "#M" made unique per
    // icon in wxSvg; then the cloud itself.
    function wxPeek( d )
    {
        return '<path class="s" d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41"/>' +
               '<mask id="M"><rect width="24" height="24" fill="#fff" stroke="none"/>' +
               '<path d="' + d + '" fill="#000" stroke="#000" stroke-width="5"/></mask>' +
               '<circle class="s sd" cx="12" cy="12" r="4" mask="url(#M)"/><path d="' + d + '"/>';
    }
    var WX_ICONS =
    [
        [ '<g class="s"><circle class="sd" cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></g>',
          '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>' ],
        [ wxPeek( 'M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z' ),
          '<path d="M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z"/><path d="M10.1 9A6 6 0 0 1 16 4a4 4 0 0 0 6 6 6 6 0 0 1-3 5.197"/>' ],
        [ '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>' ],
        [ WX_CLOUD + '<path d="M16 17H7M17 21H9"/>' ],
        [ WX_CLOUD + '<path class="r" d="M8 19v1M8 14v1M16 19v1M16 14v1M12 21v1M12 16v1"/>' ],
        [ WX_CLOUD + '<path class="r" d="M16 14v6M8 14v6M12 16v6"/>' ],
        [ WX_CLOUD + '<path class="r" d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/>' ],
        [ wxPeek( 'M3 20a5 5 0 1 1 8.9-4H13a3 3 0 0 1 2 5.24' ) + '<path class="r" d="M11 20v2M7 19v2"/>',
          WX_CLOUD + '<path class="r" d="M16 14v6M8 14v6M12 16v6"/>' ],
        [ '<path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path class="s" d="m13 12-3 5h4l-3 5"/>' ]
    ];
    var wxMask = 0;
    function wxSvg( k, day )
    {
        var i = WX_ICONS[ k ] || WX_ICONS[ 2 ], id = 'wxm' + ( ++wxMask );
        return '<svg class="wx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
               ( day || i.length < 2 ? i[ 0 ] : i[ 1 ] ).replace( 'id="M"', 'id="' + id + '"' ).replace( 'url(#M)', 'url(#' + id + ')' ) + '</svg>';
    }

    // Day or night at place-local time `iso` ("YYYY-MM-DDTHH:MM"): Open-Meteo says
    // so for now (is_day); else that day's sunrise and sunset; day when unknown.
    function wxDay( w, iso, isDay )
    {
        if( isDay != null ) return !! isDay;
        var i = w.daily.time.indexOf( iso.slice( 0, 10 ) ), up = w.daily.sunrise[ i ], down = w.daily.sunset[ i ];
        return i < 0 || ! up || ! down || ( iso >= up && iso < down );
    }

    function wxEngine()
    {
        return h.weatherEngine();
    }

    // The weather settings (data/weather.json), the place, the weather. `fresh`: a new call (the
    // 30-min turn, a press); else the cache while under 30 min old (a reload).
    // The place keeps its own long cache (no new name lookup each time).
    function wxGet( fresh )
    {
        return wxEngine().then( function ( S )
        {
            var E = S.engine;
            wxCached = wxCached || E.store( 'nv-culture:' );
            var get = fresh ? function ( k, ttl, fn ) { return wxCached( k, 0, fn ); } : wxCached;
            return S.weatherRead().then( function ( cfg )
            {
                return E.placeOf( cfg, wxCached ).then( function ( p )
                {
                    return E.weatherAt( get, p, cfg.units, cfg.weather ).then( function ( w ) { return { S: S, cfg: cfg, p: p, w: w }; } );
                } );
            } );
        } );
    }

    function wxT( S )                         // the engine's words, in the interface language
    {
        var l = window.Ayni ? String( Ayni.i18n.lang() ).slice( 0, 2 ) : '';
        return S.engine.T[ l ] || S.engine.T.en;
    }

    function wxPaint( d )                     // the bar's icon: the sky now
    {
        var E = d.S.engine, c = d.w.current;
        wxBtn.innerHTML = wxSvg( E.skyOf( c.weather_code ), wxDay( d.w, c.time, c.is_day ) );
        setTip( wxBtn, t( 'desktop.weather' ) + ': ' + E.deg( c.temperature_2m ) + ', ' + wxT( d.S ).sky[ E.skyOf( c.weather_code ) ] );
    }

    function wxTick( fresh )
    {
        clearTimeout( wxTimer );
        wxTimer = setTimeout( function () { wxTick( true ); }, WX_EVERY );
        var g = ++wxGen;
        wxGet( fresh ).then( function ( d ) { if( g === wxGen ) wxPaint( d ); }, function () {} );
    }

    function wxEl( tag, cls, text, parent )
    {
        var e = document.createElement( tag );
        if( cls ) e.className = cls;
        if( text != null ) e.textContent = text;
        if( parent ) parent.appendChild( e );
        return e;
    }

    // The popup: the place first, a sliding bar until the forecast comes, then
    // the next 5 times 3 hours apart from the coming hour: "hh:mm", the sky, the temperature.
    function wxOpen()
    {
        var g = ++wxPopGen;
        wxPop.innerHTML = '';
        var head = wxEl( 'div', 'wx-head', t( 'desktop.weather' ), wxPop );
        var busy = wxEl( 'span', 'wx-busy', null, wxPop );
        busy.setAttribute( 'role', 'progressbar' );
        wxEl( 'span', null, null, busy );
        Ayni.place( wxPop, wxBtn );
        wxGet( true ).then( function ( d )
        {
            if( set.weatherBar ) wxPaint( d );
            if( g !== wxPopGen ) return;
            var E = d.S.engine, T = wxT( d.S ), w = d.w, hr = w.hourly, now = w.current.time;
            head.textContent = ( d.p.name ? T.weather.replace( '{c}', d.p.name ) : T.here ) + ' · ' + d.S.WEATHER[ d.cfg.weather ].name;
            var cols = wxEl( 'div', 'wx-cols' ), i = 0;
            while( i < hr.time.length && hr.time[ i ] <= now ) i++;
            for( ; i < hr.time.length && cols.childNodes.length < 5; i += 3 )
            {
                var k = E.skyOf( hr.weather_code[ i ] ), col = wxEl( 'div', 'wx-col', null, cols );
                col.title = T.sky[ k ];
                wxEl( 'span', '', hr.time[ i ].slice( 11, 16 ), col );
                col.insertAdjacentHTML( 'beforeend', wxSvg( k, wxDay( w, hr.time[ i ] ) ) );
                wxEl( 'b', '', E.deg( hr.temperature_2m[ i ] ), col );
            }
            if( ! cols.childNodes.length ) throw new Error( 'no hours' );
            wxPop.replaceChild( cols, busy );
            Ayni.place( wxPop, wxBtn );
        } ).catch( function ()
        {
            if( g !== wxPopGen || ! busy.parentNode ) return;
            wxPop.replaceChild( wxEl( 'div', 'wx-fail', t( 'ayni.loadFailed' ) ), busy );
            Ayni.place( wxPop, wxBtn );
        } );
    }

    function wxApply()
    {
        wxChk.checked = !! set.weatherBar;
        wxBtn.hidden = ! set.weatherBar;
        if( set.weatherBar )
        {
            if( ! wxBtn.firstChild ) wxBtn.innerHTML = wxSvg( 2, true );     // a cloud until the first answer
            wxTick( false );
            return;
        }
        clearTimeout( wxTimer );
        wxGen++; wxPopGen++;
        if( wxPop.matches( ':popover-open' ) ) wxPop.hidePopover();
    }
    wxChk.addEventListener( 'change', function () { set.weatherBar = wxChk.checked; saveSet(); wxApply(); placeMore(); } );
    wxApply();

    wxPop.addEventListener( 'toggle', function ( e ) { if( e.newState === 'open' ) wxOpen(); else wxPopGen++; } );

    // WEATHER SETTINGS in the "⋮" menu (2026-11-11): where, who gives it,
    // units - ONE per user (data/weather.json via the engine's weatherUpdate),
    // for the bar and both lockers. Read again at each menu open; each change
    // saved at once, version-checked. A read that failed shows nothing to
    // change (a stand-in saved would replace the real settings, F6).
    var wxsPlace = document.getElementById( 'wxPlace' ), wxsBy = document.getElementById( 'wxBy' ),
        wxsUnits = document.getElementById( 'wxUnits' ),
        wxsCity = document.getElementById( 'wxCity' ), wxsMsg = document.getElementById( 'wxMsg' ),
        wxsS = null, wxsCfg = null, wxsGen = 0, wxsOff = true;
    function wxsSay( text ) { wxsMsg.hidden = ! text; wxsMsg.textContent = text || ''; }
    function wxsLock( off )
    {
        [ wxsPlace, wxsBy, wxsUnits ].forEach( function ( x ) { Ayni.picker( x ).disabled = off; } );
        wxsOff = off;
        wxsCityOn();
    }
    // The city field is always shown; usable only while "A city" is picked.
    function wxsCityOn()
    {
        var off = wxsOff || ! wxsCfg || wxsCfg.place !== 'city';
        wxsCity.disabled = off;
        document.getElementById( 'wxFind' ).ariaDisabled = off ? 'true' : null;
    }
    function wxsDraw()
    {
        var c = wxsCfg, W = wxsS.WEATHER;
        var pp = Ayni.picker( wxsPlace );
        pp.options = [ { value: 'geo', text: t( 'salon.placeGeo' ) }, { value: 'city', text: t( 'salon.placeCity' ) } ];
        pp.set( c.place );
        var pb = Ayni.picker( wxsBy );
        pb.options = Object.keys( W ).map( function ( k ) { return { value: k, text: W[ k ].name }; } );
        pb.set( c.weather );
        var pu = Ayni.picker( wxsUnits );
        pu.options = [ { value: 'c', text: t( 'salon.metric' ) }, { value: 'f', text: t( 'salon.imperial' ) } ];   // 'c'/'f' kept: the saved value
        pu.set( c.units );
        wxsCityOn();
        if( document.activeElement !== wxsCity ) wxsCity.value = c.city ? c.city.name : '';
        placeMore();
    }
    function wxsFill()
    {
        var g = ++wxsGen;
        wxEngine().then( function ( S ) { return S.weatherReadStrict().then( function ( c ) { return { S: S, c: c }; } ); } ).then( function ( d )
        {
            if( g !== wxsGen ) return;
            wxsS = d.S; wxsCfg = d.c;
            wxsLock( false );
            wxsDraw();
        }, function () { if( g === wxsGen ) { wxsCfg = null; wxsLock( true ); wxsSay( t( 'salon.readFail' ) ); } } );
    }
    // One change: laid over the settings as they are on the server now.
    function wxsSave( patch )
    {
        if( ! wxsS || ! wxsCfg ) return;
        Object.keys( patch ).forEach( function ( k ) { wxsCfg[ k ] = patch[ k ]; } );
        wxsDraw();
        wxsS.weatherUpdate( function ( now )
        {
            var out = JSON.parse( JSON.stringify( now ) );
            Object.keys( patch ).forEach( function ( k ) { out[ k ] = patch[ k ]; } );
            return out;
        } ).then( function ( out )
        {
            wxsCfg = out;
            if( set.weatherBar ) wxTick( true );
        }, function ( e ) { Ayni.toast( e && e.read ? 'err' : 'warn', t( e && e.read ? 'salon.notSaved' : 'salon.saveFail' ) ); } );
    }
    // "Where this computer is" asks the browser now, while someone is at the keyboard.
    function wxsAskHere()
    {
        if( ! navigator.geolocation ) { wxsSay( t( 'salon.geoDenied' ) ); return; }
        wxsSay( '…' );
        navigator.geolocation.getCurrentPosition( function ( g )
        {
            wxsSay( '✓' );
            if( window.NayiveUI && NayiveUI.townName )
                NayiveUI.townName( Math.round( g.coords.latitude * 100 ) / 100, Math.round( g.coords.longitude * 100 ) / 100 )
                    .then( function ( n ) { if( n ) wxsSay( '✓ ' + n ); }, function () {} );
        }, function () { wxsSay( t( 'salon.geoDenied' ) ); }, { timeout: 20000, maximumAge: 30 * 6e4 } );
    }
    function wxsFind()
    {
        var name = wxsCity.value.trim();
        if( ! name || ! wxsCfg || wxsCity.disabled ) return;
        wxsSay( '…' );
        var lang = window.Ayni ? String( Ayni.i18n.lang() ).slice( 0, 2 ) : 'en';
        fetch( 'https://geocoding-api.open-meteo.com/v1/search?count=10&language=' + encodeURIComponent( lang ) + '&name=' + encodeURIComponent( name ) )
            .then( function ( r ) { return r.json(); } )
            .then( function ( d )
            {
                // The biggest of the namesakes ("Lisboa": Lisbon, not a village in Mozambique).
                var r = ( d.results || [] ).reduce( function ( a, b ) { return ! a || ( b.population || 0 ) > ( a.population || 0 ) ? b : a; }, null );
                if( ! r ) { wxsSay( t( 'salon.cityNone' ) ); return; }
                wxsCity.value = r.name;
                wxsSay( '✓ ' + [ r.name, r.admin1, r.country ].filter( Boolean ).join( ', ' ) );
                wxsSave( { place: 'city', city: { name: r.name, lat: Math.round( r.latitude * 100 ) / 100, lon: Math.round( r.longitude * 100 ) / 100, tz: r.timezone } } );
            }, function () { wxsSay( t( 'salon.cityNone' ) ); } );
    }
    wxsPlace.addEventListener( 'ayni:change', function ( e )
    {
        var v = e.detail.value;
        if( ! wxsCfg ) return;
        wxsSay( '' );
        if( v === 'geo' ) { wxsSave( { place: 'geo' } ); wxsAskHere(); return; }
        if( wxsCfg && wxsCfg.city ) wxsSave( { place: 'city' } );
        else { wxsCfg.place = 'city'; wxsDraw(); wxsCity.focus(); }      // saved once a city is found
    } );
    wxsBy.addEventListener( 'ayni:change', function ( e ) { wxsSave( { weather: e.detail.value } ); } );
    wxsUnits.addEventListener( 'ayni:change', function ( e ) { wxsSave( { units: e.detail.value } ); } );
    document.getElementById( 'wxFind' ).addEventListener( 'click', wxsFind );
    wxsCity.addEventListener( 'keydown', function ( e ) { if( e.key === 'Enter' ) { e.preventDefault(); wxsFind(); } } );
    moreBtn.addEventListener( 'click', function () { wxsSay( '' ); wxsFill(); } );

    return { wxSvg: wxSvg };
};
