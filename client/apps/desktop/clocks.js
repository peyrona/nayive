/* desktop/clocks.js - the desktop's clock, out of Ayni's desk page (2026-11-23): it ticks on a timer of its
   own, so it is Nayive's, not UI. On the bar: the clock "<weekday> <date> <time>" (#clock) and up to 5 other
   clocks before it (#clocks2); in the "⋮": "Show the clock", its cog that opens CLOCK AND DATE (#clkBackdrop),
   and the other clocks' rows; THE MONTH (#calPop), the popup of the clock's weekday / date. This device's
   choices are keys of the desk page's settings (D.set), under the names they always had.
   A plain script: desktop/index.html puts the markup in the desk page's slots, then calls
     var C = NayiveDesk.clocks( D, hooks )     C: { clock, calOpen(), calWasOpen() }, for the countdowns. */
( window.NayiveDesk = window.NayiveDesk || {} ).clocks = function ( D, h )
{
    var set = D.set, saveSet = D.saveSet, placeMore = D.relayout, closeMore = D.closeMore, moreBtn = D.moreBtn,
        setTip = D.setTip, t = D.t;
    // The clock's defaults (the desk page's own until 2026-11-23), under the same names.
    [ [ 'dow', 'short' ], [ 'date', false ], [ 'secs', false ] ].forEach( function ( d ) { if( ! ( d[ 0 ] in set ) ) set[ d[ 0 ] ] = d[ 1 ]; } );

    // THE CLOCK - every change applies at once; the menu (and the CLOCK AND DATE
    // dialog) stays open. The clock's rows live in that dialog (below).
    var F = {
        dow:  document.getElementById( 'setDow' ), date: document.getElementById( 'setDateFmt' ),
        secs: document.getElementById( 'setSecs' ), pad: document.getElementById( 'setPad' ),
        h12:  document.getElementById( 'clk12' ), h24: document.getElementById( 'clk24' )
    };
    F.secs.checked = !! set.secs; F.pad.checked = set.hourPad !== false;
    F.h12.checked = !! set.h12; F.h24.checked = ! set.h12;
    // The weekday and the date are Ayni list pickers: set once Ayni has started
    document.addEventListener( 'DOMContentLoaded', function () { if( window.Ayni ) Ayni.ready.then( function ()
    {
        Ayni.picker( F.dow ).set( set.dow );
        loadDateFmts(); loadZones();
    } ); } );
    Object.keys( F ).forEach( function ( k )
    {
        F[ k ].addEventListener( k === 'dow' || k === 'date' ? 'ayni:change' : 'change', function ()
        {
            var df = Ayni.picker( F.date ).value || 'none';
            set.dow = Ayni.picker( F.dow ).value; set.secs = F.secs.checked;
            set.date = df !== 'none'; if( set.date ) set.dateFmt = df;      // the format is kept while the date is off
            set.hourPad = F.pad.checked; set.h12 = F.h12.checked;
            saveSet();
            tick();
            placeMore();
        } );
    } );

    // OTHER CLOCKS' rows (2026-11-23): one per zone of set.zones (ZONES_MAX at most, the bar's order), each
    // an Ayni filtered list of the time zones and a bin; "+" adds one (UTC) and opens its list at once, to
    // type the city. Made again at each menu open (ui.js is deferred) and after an add or a remove.
    var ZONES_MAX = 5;
    if( ! Array.isArray( set.zones ) ) set.zones = [];
    set.zones = set.zones.filter( function ( z ) { return typeof z === 'string' && z; } ).slice( 0, ZONES_MAX );
    delete set.tz2; delete set.tz2On;      // the one second clock until 2026-11-23: not carried over (his call)
    var zoneRows = document.getElementById( 'zoneRows' ), zoneAdd = document.getElementById( 'zoneAdd' ), zoneOpts = null;
    function zoneItem( z ) { return { value: z, text: z.replace( /_/g, ' ' ) }; }
    function zoneOptions()
    {
        if( ! zoneOpts )
        {
            var zones = Ayni.dates.zones().slice();
            if( zones.indexOf( 'UTC' ) < 0 ) zones.unshift( 'UTC' );
            zoneOpts = zones.map( zoneItem );
        }
        // a saved zone the browser's list lacks still shows
        var extra = set.zones.filter( function ( z ) { return ! zoneOpts.some( function ( o ) { return o.value === z; } ); } );
        return extra.filter( function ( z, i ) { return extra.indexOf( z ) === i; } ).map( zoneItem ).concat( zoneOpts );
    }
    function loadZones()
    {
        zoneAdd.disabled = set.zones.length >= ZONES_MAX;
        if( ! window.Ayni || ! Ayni.picker ) return;      // called again once Ayni has started
        zoneRows.textContent = '';
        var opts = zoneOptions();
        return set.zones.map( function ( z, i )
        {
            var row = document.createElement( 'div' ), el = document.createElement( 'div' ), del = document.createElement( 'button' );
            row.className = 'set-row';
            el.className = 'picker'; el.dataset.picker = 'filter'; el.setAttribute( 'aria-label', t( 'desktop.clock2Zone' ) );
            del.type = 'button'; del.className = 'btn'; del.innerHTML = Ayni.icon( 'trash' );
            del.dataset.tip = t( 'desktop.clockDel' ); del.setAttribute( 'aria-label', del.dataset.tip );
            row.append( el, del );
            zoneRows.append( row );
            var pk = Ayni.picker( el );
            pk.options = opts; pk.set( z );
            el.addEventListener( 'ayni:change', function () { set.zones[ i ] = pk.value || 'UTC'; saveSet(); tick(); } );
            del.addEventListener( 'click', function ()
            {
                set.zones.splice( i, 1 );
                saveSet(); loadZones(); tick(); placeMore();
                zoneAdd.focus();
            } );
            return pk;
        } );
    }
    zoneAdd.addEventListener( 'click', function ()
    {
        if( set.zones.length >= ZONES_MAX ) return;
        set.zones.push( 'UTC' );
        saveSet();
        var pks = loadZones() || [];
        tick(); placeMore();
        var pk = pks[ pks.length - 1 ];
        if( pk ) { pk.field.focus(); if( pk.field.select ) pk.field.select(); pk.open(); }
    } );
    // SHOW THE CLOCK - off (set.clockOff) hides all the clocks, disables the cog before it (CLOCK AND DATE)
    // and greys the other clocks' rows.
    var clockChk = document.getElementById( 'setClock' ), clockSetBtn = document.getElementById( 'clockSetBtn' ),
        clock2Rows = document.getElementById( 'clock2Rows' );
    function clockShown() { clockChk.checked = ! set.clockOff; clockSetBtn.disabled = !! set.clockOff; clock2Rows.inert = !! set.clockOff; }
    clockShown();
    clockChk.addEventListener( 'change', function () { set.clockOff = ! clockChk.checked; clockShown(); saveSet(); tick(); placeMore(); } );
    loadZones();
    moreBtn.addEventListener( 'click', loadZones );

    // CLOCK AND DATE (2026-11-23) - the cog in the menu's clock row: a close-only
    // dialog with the clock as the bar shows it on top (drawn by tick), then the
    // time (24 h / 12 h, two-digit hour, seconds) and the date (weekday, format)
    // of the main clock; the second clock stays in the menu, always short. The cog is a button inside the row's <label>: a press on
    // it never flips the switch (a label leaves its buttons alone).
    var clkBack = document.getElementById( 'clkBackdrop' ), clkPrev = document.getElementById( 'clkPreview' );
    clockSetBtn.addEventListener( 'click', function ()
    {
        closeMore();
        loadDateFmts();
        clkBack.showModal();
        tick();
    } );
    clkBack.addEventListener( 'close', function () { moreBtn.focus(); } );      // its cog went with the menu
    // THE DATE's list: "Don't show", then today in each format, grouped by what comes first (so
    // 05/06 and 06/05 never look alike); the month's name in the interface language.
    function loadDateFmts()
    {
        if( ! window.Ayni || ! Ayni.picker ) return;      // called again once Ayni has started
        var now = new Date(), items = [ { value: 'none', text: t( 'desktop.weekdayNone' ) } ];
        DATE_GROUPS.forEach( function ( g )
        {
            items.push( { heading: t( g[ 0 ] ) } );
            g[ 1 ].forEach( function ( f ) { items.push( { value: f, text: dateText( now, f ) } ); } );
        } );
        var pk = Ayni.picker( F.date );
        pk.options = items;
        pk.set( set.date ? set.dateFmt || 'iso' : 'none' );
    }

    //------------------------------------------------------------------------//
    // THE CLOCK - "<weekday> <date> <time>", as CLOCK AND DATE says: the weekday
    // short or long, the date in one of DATE_GROUPS' formats (yyyy-mm-dd until
    // 2026-11-23, still the first), the time 24 h or 12 h, with or without the
    // hour's leading zero and the seconds; names in the interface language. A
    // press on the time opens the countdown (below), on the weekday / date the
    // month (THE MONTH).

    var clock = document.getElementById( 'clock' ), clockTimer = 0;
    var pad = Ayni.dates.pad, isoDate = Ayni.dates.iso;
    // The date formats, by what comes first: [ heading, [ format... ] ].
    var DATE_GROUPS = [
        [ 'desktop.dateYearFirst',  [ 'iso', 'ymd/' ] ],
        [ 'desktop.dateDayFirst',   [ 'dmy/', 'dmy.', 'dmy-', 'dmyy/', 'dm/' ] ],
        [ 'desktop.dateMonthFirst', [ 'mdy/', 'mdyy/', 'md/' ] ],
        [ 'desktop.dateNamed',      [ 'dMMMy', 'dMMMMy', 'dMMM', 'dMMMM' ] ]
    ];
    var NAMED = { dMMMy:  { day: 'numeric', month: 'short', year: 'numeric' }, dMMMMy: { day: 'numeric', month: 'long', year: 'numeric' },
                  dMMM:   { day: 'numeric', month: 'short' },                  dMMMM:  { day: 'numeric', month: 'long' } };
    function uiLang() { return window.Ayni && Ayni.i18n.lang ? Ayni.i18n.lang() : undefined; }
    function dayName( d, style )
    {
        var iso = d.getDay() || 7;
        return window.Ayni ? Ayni.i18n.weekday( iso, style ) : d.toLocaleDateString( undefined, { weekday: style } );
    }
    function dateText( d, f )
    {
        if( NAMED[ f ] ) { try { return d.toLocaleDateString( uiLang(), NAMED[ f ] ); } catch( e ) { f = 'iso'; } }
        var y = String( d.getFullYear() ), m = pad( d.getMonth() + 1 ), dd = pad( d.getDate() ), sep = f.slice( -1 );
        switch( f )
        {
            case 'ymd/':  return y + sep + m + sep + dd;
            case 'dmy/': case 'dmy.': case 'dmy-': return dd + sep + m + sep + y;
            case 'dmyy/': return dd + sep + m + sep + y.slice( -2 );
            case 'dm/':   return dd + sep + m;
            case 'mdy/':  return m + sep + dd + sep + y;
            case 'mdyy/': return m + sep + dd + sep + y.slice( -2 );
            case 'md/':   return m + sep + dd;
            default:      return isoDate( d );
        }
    }
    // "AM" / "PM" in the interface language ("a. m." in Spanish), for 12 h.
    var dayPeriods = {};
    function dayPeriod( hr )
    {
        var k = ( uiLang() || '' ) + ( hr < 12 ? 'a' : 'p' );
        if( ! dayPeriods[ k ] )
        {
            try
            {
                var part = new Intl.DateTimeFormat( uiLang(), { hour: 'numeric', hour12: true, timeZone: 'UTC' } )
                    .formatToParts( new Date( Date.UTC( 2024, 0, 1, hr < 12 ? 9 : 21 ) ) )
                    .filter( function ( x ) { return x.type === 'dayPeriod'; } )[ 0 ];
                dayPeriods[ k ] = part ? part.value : '';
            }
            catch( e ) {}
            dayPeriods[ k ] = dayPeriods[ k ] || ( hr < 12 ? 'AM' : 'PM' );
        }
        return dayPeriods[ k ];
    }
    // "14:05", "2:05 PM", "09:05:30"...: the main clock.
    function timeText( hr, min, sec )
    {
        var suffix = '';
        if( set.h12 ) { suffix = ' ' + dayPeriod( hr ); hr = hr % 12 || 12; }
        return ( set.hourPad === false ? String( hr ) : pad( hr ) ) + ':' + pad( min ) + ( sec == null ? '' : ':' + pad( sec ) ) + suffix;
    }
    function tick()
    {
        clearTimeout( clockTimer );
        var now = new Date();
        clock.hidden = !! set.clockOff;
        var head = [];
        if( set.dow !== 'none' ) head.push( dayName( now, set.dow ) );
        if( set.date )           head.push( dateText( now, set.dateFmt || 'iso' ) );
        var time = timeText( now.getHours(), now.getMinutes(), set.secs ? now.getSeconds() : null );
        clock.querySelector( 'span:not(.icon)' ).textContent = head.join( ' ' );
        clock.querySelector( 'span:not(.icon)' ).hidden = ! head.length;
        clock.querySelector( 'b' ).textContent = time;
        setTip( clock, dayName( now, 'long' ) + ' ' + dateText( now, 'dMMMMy' ) );
        tick2( now );
        // CLOCK AND DATE's top line: the same text
        if( clkBack.open )
        {
            clkPrev.children[ 0 ].textContent = head.join( ' ' );
            clkPrev.children[ 1 ].textContent = time;
        }
        clockTimer = setTimeout( tick, set.secs ? 1000 - now.getMilliseconds() + 20
                                                : 60000 - now.getSeconds() * 1000 - now.getMilliseconds() + 50 );
    }

    // OTHER CLOCKS (2026-10-09, up to 5 since 2026-11-23) - other time zones (set.zones, the "⋮"
    // menu): each "<city> <hh:mm>" just before the clock, paler, and "+1" / "-1" when that place is
    // already on another day. Always short: CLOCK AND DATE is the main clock's only. Shows only: no press.
    var clocks2 = document.getElementById( 'clocks2' );
    function zoneCity( z ) { return z.split( '/' ).pop().replace( /_/g, ' ' ); }
    function tick2( now )
    {
        var zs = set.clockOff ? [] : set.zones;
        while( clocks2.children.length > zs.length ) clocks2.lastChild.remove();
        while( clocks2.children.length < zs.length )
        {
            var w = document.createElement( 'span' );
            w.className = 'widget clock2'; w.innerHTML = '<span></span><b></b><i></i>';
            clocks2.append( w );
        }
        zs.forEach( function ( z, n ) { zoneTick( clocks2.children[ n ], z, now ); } );
    }
    function zoneTick( el, z, now )
    {
        var p = {};
        try
        {
            new Intl.DateTimeFormat( 'en-GB', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit',
                                                hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } )
                .formatToParts( now ).forEach( function ( x ) { p[ x.type ] = x.value; } );
        }
        catch( e ) { el.hidden = true; return; }      // a zone this browser no longer knows
        el.hidden = false;
        var there = Date.UTC( +p.year, +p.month - 1, +p.day ),
            here  = Date.UTC( now.getFullYear(), now.getMonth(), now.getDate() ),
            days  = Math.round( ( there - here ) / 86400000 );
        el.children[ 0 ].textContent = zoneCity( z );
        el.children[ 1 ].textContent = p.hour + ':' + p.minute;
        el.children[ 2 ].textContent = days > 0 ? '+' + days : days < 0 ? String( days ) : '';
        el.title = z + ' - ' + p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
    }
    tick();
    // the weekday is written in the interface language: once more when that is in
    if( window.Ayni ) Ayni.i18n.ready.then( tick );

    //------------------------------------------------------------------------//
    // THE MONTH (2026-10-08) - a press on the clock's weekday / date (only when
    // shown) opens a month's calendar beside the bar, like many Linux desktops:
    // Ayni's calendar, view only: a day has no press. It always opens on today's
    // month, and each row starts with its ISO week number.

    var calPop = document.getElementById( 'calPop' ), calView = null, calWasOpen = false;

    function calOpen()
    {
        h.closeMenu();
        calView = calView || Ayni.calendar( document.getElementById( 'calView' ) );
        calView.set( new Date() );
        Ayni.showPopup( calPop, clock );
    }
    // A press on the clock closes an open popup before its click comes: noted first,
    // so a second press on the date closes the month, and does not open it again.
    clock.addEventListener( 'pointerdown', function () { calWasOpen = calPop.matches( ':popover-open' ); }, true );

    return { clock: clock, calOpen: calOpen, calWasOpen: function () { return calWasOpen; } };
};
