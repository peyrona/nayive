/*
 * lockers/culture-settings.js - the settings dialog of the "Salon" screen
 * locker (lockers/culture.js) and of its sister "Science" (lockers/science.js).
 * Opened from the desktop's "⋮" menu when one of them is the chosen locker:
 *     NayiveSalonSettings.open()             Bellas artes
 *     NayiveSalonSettings.open( "science" )  Science (needs science.js loaded too)
 *
 * Needs culture.js loaded first (window.NayiveSalon: the lists, the defaults,
 * read/write) and shared/ui.js (NayiveUI.modal, icons, toast).
 *
 * Four tabs:
 *   Languages   mine, in order of importance; which ones each box uses; how
 *               long each one stays (3, 7, 10 or 15 min)
 *   Content     each box on / off; a new masterpiece every N hours; pronunciation
 *   Art         museums, art forms, periods
 *   Place & look  where the weather is for; who gives it; units; 12 / 24 h; letters; size; contrast
 * Science has News (its sources) in place of Art, and its own Content.
 *
 * Saved PER USER (data/salon.json or data/science.json, every device the
 * same) with ✓; ✗ drops the changes. The locker reads them the next time it starts.
 */
( function ()
{
"use strict";

var S;                                       // window.NayiveSalon, when open() runs
function t( k ) { return window.NayiveI18n ? NayiveI18n.t( k ) : k; }

function el( tag, cls, text, parent )
{
    var e = document.createElement( tag );
    if( cls ) e.className = cls;
    if( text != null ) e.textContent = text;
    if( parent ) parent.appendChild( e );
    return e;
}

// Layout only: every control is a shared one (select, input, .switch,
// .icon-btn, .pill, the browser's own tick-box).
var STYLE =
".salon-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; }" +
".salon-pane { min-height: 330px; }" +
".salon-h { margin: 14px 0 6px; font-size: 0.8rem; color: var(--text-dim); }" +
".salon-h:first-child { margin-top: 0; }" +
".salon-note { margin: 6px 0 0; font-size: 0.8rem; color: var(--text-dim); line-height: 1.4; }" +
".salon-row { display: flex; align-items: center; gap: 10px; min-height: 34px; }" +
".salon-row .grow { flex: 1; min-width: 0; }" +
".salon-row.off .grow { color: var(--text-faint); }" +
".salon-grid { width: 100%; border-collapse: collapse; font-size: 0.9rem; }" +
".salon-grid th { font-weight: 500; font-size: 0.8rem; color: var(--text-dim); padding: 4px 6px; text-align: center; }" +
".salon-grid th:first-child, .salon-grid td:first-child { text-align: left; padding-left: 0; }" +
".salon-grid td { padding: 5px 6px; text-align: center; border-top: 1px solid var(--line); }" +
".salon-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; }" +
".salon-check { display: flex; align-items: center; gap: 8px; min-height: 30px; font-size: 0.92rem; cursor: pointer; }" +
".salon-check input { flex: none; }" +
".salon-two { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }" +
".salon-preview { margin-top: 8px; padding: 12px 14px; border-radius: var(--radius-s); background: #0e0c0a; color: #F6F1E7; }" +
".salon-preview .big { font-size: 2rem; line-height: 1.1; }" +
".salon-preview .txt { margin-top: 6px; font-size: 1.05rem; line-height: 1.45; }" +
"@media ( max-width: 640px ) { .salon-cols, .salon-two { grid-template-columns: 1fr; } }";

function open( kind )
{
    S = window.NayiveSalon;
    var sci = kind === "science";
    var A = sci ? window.NayiveScience : S;      // its boxes, read and write
    if( ! S || ! A ) return;
    var cfg = null;
    var CARD = sci ? "sci.card." : "salon.card.";
    var ui  = NayiveUI.modal( { title: t( sci ? "sci.settings" : "salon.settings" ), cls: "sheet--wide", id: "salonSettings" } );
    var sheet = ui.sheet;

    var style = el( "style", null, STYLE + S.faces(), sheet );
    var tabs  = el( "div", "salon-tabs", null, sheet );
    tabs.setAttribute( "role", "tablist" );
    var panes = {};
    var TABS = [ [ "langs", "salon.tabLangs" ], [ "content", "salon.tabContent" ],
                 sci ? [ "news", "sci.tabNews" ] : [ "art", "salon.tabArt" ], [ "look", "salon.tabLook" ] ];
    TABS.forEach( function ( x )
    {
        var b = el( "button", "pill", t( x[ 1 ] ), tabs );
        b.type = "button";
        b.setAttribute( "role", "tab" );
        b.dataset.tab = x[ 0 ];
        b.addEventListener( "click", function () { show( x[ 0 ] ); } );
        panes[ x[ 0 ] ] = el( "div", "salon-pane", null, sheet );
        panes[ x[ 0 ] ].setAttribute( "role", "tabpanel" );
    } );
    function show( id )
    {
        [].forEach.call( tabs.children, function ( b )
        {
            var on = b.dataset.tab === id;
            b.classList.toggle( "is-active", on );
            b.setAttribute( "aria-selected", on ? "true" : "false" );
        } );
        for( var k in panes ) panes[ k ].hidden = k !== id;
    }

    var actions = el( "div", "sheet-actions", null, sheet );
    var bClose = el( "button", null, null, actions );
    bClose.type = "button";
    bClose.setAttribute( "data-act", "close" );
    bClose.title = t( "ui.close" );
    var bSave = el( "button", null, null, actions );
    bSave.type = "button";
    bSave.setAttribute( "data-act", "primary" );
    bSave.title = t( "ui.save" );
    bClose.addEventListener( "click", function () { ui.close(); } );
    bSave.addEventListener( "click", save );

    ui.show( function () { NayiveUI.applySheetButtons( sheet ); } );
    show( "langs" );
    [].forEach.call( sheet.querySelectorAll( ".salon-pane" ), function ( p ) { el( "p", "salon-note", "…", p ); } );

    A.read().then( function ( s )
    {
        cfg = JSON.parse( JSON.stringify( s ) );
        drawLangs();
        drawContent();
        if( sci ) drawNews(); else drawArt();
        drawLook();
    } );

    //------------------------------------------------------------------------//
    // Helpers

    function check( parent, label, checked, onChange )
    {
        var l = el( "label", "salon-check", null, parent );
        var i = el( "input", null, null, l );
        i.type = "checkbox";
        i.checked = !! checked;
        el( "span", null, label, l );
        i.addEventListener( "change", function () { onChange( i.checked, i ); } );
        return i;
    }
    function toggle( parent, label, checked, onChange )
    {
        var r = el( "label", "salon-row", null, parent );
        el( "span", "grow", label, r );
        var sw = el( "span", "switch sm", null, r );
        var i = el( "input", null, null, sw );
        i.type = "checkbox";
        i.checked = !! checked;
        el( "span", "track", null, sw );
        i.addEventListener( "change", function () { onChange( i.checked ); } );
        return i;
    }
    function choose( parent, label, value, options, onChange )
    {
        var f = el( "div", "field", null, parent );
        var id = "salon-" + Math.random().toString( 36 ).slice( 2 );
        var l = el( "label", null, label, f );
        l.htmlFor = id;
        var s = el( "select", null, null, f );
        s.id = id;
        options.forEach( function ( o )
        {
            var x = el( "option", null, o[ 1 ], s );
            x.value = String( o[ 0 ] );
        } );
        s.value = String( value );
        s.addEventListener( "change", function () { onChange( s.value ); } );
        return s;
    }
    function iconBtn( parent, icon, title, onClick )
    {
        var b = el( "button", "icon-btn sm", null, parent );
        b.type = "button";
        b.innerHTML = NayiveUI.icon( icon );
        b.title = title;
        b.setAttribute( "aria-label", title );
        b.addEventListener( "click", onClick );
        return b;
    }
    var BOXES = sci ? [ "clock", "picture", "days", "news", "element" ]   // the ones that speak (the weather /
                    : [ "clock", "art", "days", "word", "quote" ];         // the sky: the first language)

    //------------------------------------------------------------------------//
    // LANGUAGES

    function drawLangs()
    {
        var p = panes.langs;
        p.innerHTML = "";
        el( "div", "salon-h", t( "salon.myLangs" ), p );
        var order = cfg.langs.concat( S.LANGS.filter( function ( l ) { return cfg.langs.indexOf( l ) < 0; } ) );
        order.forEach( function ( l )
        {
            var mine = cfg.langs.indexOf( l ) >= 0;
            var r = el( "div", "salon-row" + ( mine ? "" : " off" ), null, p );
            var i = el( "input", null, null, r );
            i.type = "checkbox";
            i.checked = mine;
            i.setAttribute( "aria-label", S.name( l ) );
            el( "span", "grow", S.name( l ), r );
            i.addEventListener( "change", function ()
            {
                if( i.checked ) cfg.langs.push( l );
                else if( cfg.langs.length > 1 ) cfg.langs.splice( cfg.langs.indexOf( l ), 1 );
                else { i.checked = true; NayiveUI.toast( t( "salon.needLang" ) ); return; }
                drawLangs();
            } );
            var k = cfg.langs.indexOf( l );
            var up = iconBtn( r, "up", t( "salon.up" ), function () { move( l, -1 ); } );
            var dn = iconBtn( r, "down", t( "salon.down" ), function () { move( l, 1 ); } );
            up.disabled = ! mine || k === 0;
            dn.disabled = ! mine || k === cfg.langs.length - 1;
        } );

        el( "div", "salon-h", t( "salon.perBox" ), p );
        var tb = el( "table", "salon-grid", null, p );
        var hr = el( "tr", null, null, el( "thead", null, null, tb ) );
        el( "th", null, "", hr );
        cfg.langs.forEach( function ( l ) { el( "th", null, S.name( l ), hr ); } );
        var body = el( "tbody", null, null, tb );
        BOXES.forEach( function ( c )
        {
            var tr = el( "tr", null, null, body );
            el( "td", null, t( CARD + c ), tr );
            var have = cfg.cards[ c ].langs || cfg.langs;
            cfg.langs.forEach( function ( l )
            {
                var i = el( "input", null, null, el( "td", null, null, tr ) );
                i.type = "checkbox";
                i.checked = have.indexOf( l ) >= 0;
                i.setAttribute( "aria-label", t( CARD + c ) + " · " + S.name( l ) );
                i.addEventListener( "change", function ()
                {
                    var now = ( cfg.cards[ c ].langs || cfg.langs ).slice();
                    if( i.checked ) now.push( l );
                    else now.splice( now.indexOf( l ), 1 );
                    if( ! now.length ) { i.checked = true; NayiveUI.toast( t( "salon.needLang" ) ); return; }
                    now.sort( function ( a, b ) { return cfg.langs.indexOf( a ) - cfg.langs.indexOf( b ); } );
                    cfg.cards[ c ].langs = now.length === cfg.langs.length ? null : now;
                } );
            } );
        } );
        el( "p", "salon-note", t( sci ? "sci.skyFirst" : "salon.weatherFirst" ), p );

        choose( el( "div", null, null, p ), t( "salon.turn" ), cfg.turn,
                [ 3, 7, 10, 15 ].map( function ( m ) { return [ m * 60, m + " min" ]; } ),
                function ( v ) { cfg.turn = Number( v ); } ).parentNode.style.marginTop = "14px";
    }

    function move( l, by )
    {
        var i = cfg.langs.indexOf( l ), j = i + by;
        if( i < 0 || j < 0 || j >= cfg.langs.length ) return;
        cfg.langs[ i ] = cfg.langs[ j ];
        cfg.langs[ j ] = l;
        drawLangs();
    }

    //------------------------------------------------------------------------//
    // CONTENT

    function drawContent()
    {
        var p = panes.content;
        p.innerHTML = "";
        el( "div", "salon-h", t( "salon.show" ), p );
        A.CARDS.forEach( function ( c )
        {
            toggle( p, t( CARD + c ), cfg.cards[ c ].on, function ( v ) { cfg.cards[ c ].on = v; } );
        } );
        var two = el( "div", "salon-two", null, p );
        two.style.marginTop = "14px";
        if( sci )
        {
            choose( two, t( "sci.picEvery" ), cfg.picHours,
                    [ 1, 2, 4, 8, 24 ].map( function ( h ) { return [ h, h + " h" ]; } ),
                    function ( v ) { cfg.picHours = Number( v ); } );
            choose( two, t( "sci.newsEvery" ), cfg.newsEvery,
                    [ [ 30, "30 s" ], [ 60, "1 min" ], [ 120, "2 min" ], [ 300, "5 min" ] ],
                    function ( v ) { cfg.newsEvery = Number( v ); } );
            el( "div", "salon-h", t( "sci.picSources" ), p );
            Object.keys( A.PICS ).forEach( function ( k )
            {
                var P = A.PICS[ k ];
                check( p, P.name + ( P.lic ? " · " + P.lic : "" ), cfg.pics.indexOf( k ) >= 0, function ( on, i )
                {
                    if( on ) cfg.pics.push( k );
                    else if( cfg.pics.length > 1 ) cfg.pics.splice( cfg.pics.indexOf( k ), 1 );
                    else { i.checked = true; NayiveUI.toast( t( "sci.needSource" ) ); }
                } );
            } );
            return;
        }
        choose( two, t( "salon.artEvery" ), cfg.artHours,
                [ 1, 2, 4, 8, 24 ].map( function ( h ) { return [ h, h + " h" ]; } ),
                function ( v ) { cfg.artHours = Number( v ); } );
        toggle( p, t( "salon.ipa" ), cfg.ipa, function ( v ) { cfg.ipa = v; } );
    }

    //------------------------------------------------------------------------//
    // ART

    function drawArt()
    {
        var p = panes.art;
        p.innerHTML = "";
        el( "div", "salon-h", t( "salon.museums" ), p );
        var cols = el( "div", "salon-cols", null, p );
        Object.keys( S.MUSEUMS ).forEach( function ( m )
        {
            check( cols, S.MUSEUMS[ m ].name, cfg.museums.indexOf( m ) >= 0, function ( on, i )
            {
                if( on ) cfg.museums.push( m );
                else if( cfg.museums.length > 1 ) cfg.museums.splice( cfg.museums.indexOf( m ), 1 );
                else { i.checked = true; NayiveUI.toast( t( "salon.needMuseum" ) ); }
            } );
        } );

        el( "div", "salon-h", t( "salon.forms" ), p );
        var fr = el( "div", "salon-cols", null, p );
        Object.keys( S.FORMS ).forEach( function ( f )
        {
            check( fr, t( "salon.form." + f ), cfg.forms.indexOf( f ) >= 0, function ( on, i )
            {
                if( on ) cfg.forms.push( f );
                else if( cfg.forms.length > 1 ) cfg.forms.splice( cfg.forms.indexOf( f ), 1 );
                else i.checked = true;
            } );
        } );

        el( "div", "salon-h", t( "salon.periods" ), p );
        var pr = el( "div", "salon-cols", null, p );
        Object.keys( S.PERIODS ).forEach( function ( k )
        {
            check( pr, t( "salon.period." + k ), cfg.periods.indexOf( k ) >= 0, function ( on )
            {
                if( on ) cfg.periods.push( k );
                else cfg.periods.splice( cfg.periods.indexOf( k ), 1 );
            } );
        } );
        el( "p", "salon-note", t( "salon.periodsNote" ), p );
    }

    //------------------------------------------------------------------------//
    // NEWS (Science) - the sources, grouped by language.

    function drawNews()
    {
        var p = panes.news;
        p.innerHTML = "";
        var N = A.NEWS;
        S.LANGS.forEach( function ( l )
        {
            var ids = Object.keys( N ).filter( function ( k ) { return N[ k ].lang === l; } );
            el( "div", "salon-h", S.name( l ), p );
            if( ! ids.length ) { el( "p", "salon-note", t( "sci.noSource" ), p ); return; }
            ids.forEach( function ( k )
            {
                check( p, N[ k ].name + ( N[ k ].lic ? " · " + N[ k ].lic : "" ) + ( N[ k ].off ? " · " + t( "sci.allTopics" ) : "" ),
                       cfg.news.indexOf( k ) >= 0, function ( on, i )
                {
                    if( on ) cfg.news.push( k );
                    else if( cfg.news.length > 1 ) cfg.news.splice( cfg.news.indexOf( k ), 1 );
                    else { i.checked = true; NayiveUI.toast( t( "sci.needSource" ) ); }
                } );
            } );
        } );
        el( "p", "salon-note", t( "sci.newsNote" ), p );
    }

    //------------------------------------------------------------------------//
    // PLACE & LOOK

    function drawLook()
    {
        var p = panes.look;
        p.innerHTML = "";

        // Where the weather is for.
        el( "div", "salon-h", t( "salon.place" ), p );
        var geoRow = el( "label", "salon-check", null, p );
        var geo = el( "input", null, null, geoRow );
        geo.type = "radio"; geo.name = "salonPlace"; geo.checked = cfg.place === "geo";
        el( "span", null, t( "salon.placeGeo" ), geoRow );
        var geoMsg = el( "p", "salon-note", "", p );
        geoMsg.hidden = true;
        var cityRow = el( "label", "salon-check", null, p );
        var city = el( "input", null, null, cityRow );
        city.type = "radio"; city.name = "salonPlace"; city.checked = cfg.place === "city";
        el( "span", null, t( "salon.placeCity" ), cityRow );

        var find = el( "div", "salon-row", null, p );
        var q = el( "input", "grow", null, find );
        q.type = "text";
        q.placeholder = t( "salon.city" );
        q.setAttribute( "aria-label", t( "salon.city" ) );
        q.value = cfg.city ? cfg.city.name : "";
        var found = el( "p", "salon-note", "", p );
        iconBtn( find, "search", t( "salon.cityFind" ), lookUp );
        q.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); lookUp(); } } );

        function lookUp()
        {
            var name = q.value.trim();
            if( ! name ) return;
            found.textContent = "…";
            fetch( "https://geocoding-api.open-meteo.com/v1/search?count=1&language=" + encodeURIComponent( cfg.langs[ 0 ] ) +
                   "&name=" + encodeURIComponent( name ) )
                .then( function ( r ) { return r.json(); } )
                .then( function ( d )
                {
                    var r = d.results && d.results[ 0 ];
                    if( ! r ) { found.textContent = t( "salon.cityNone" ); return; }
                    cfg.city = { name: r.name, lat: Math.round( r.latitude * 100 ) / 100, lon: Math.round( r.longitude * 100 ) / 100,
                                 tz: r.timezone };
                    cfg.place = "city";
                    city.checked = true;
                    q.value = r.name;
                    found.textContent = "✓ " + [ r.name, r.admin1, r.country ].filter( Boolean ).join( ", " );
                }, function () { found.textContent = t( "salon.cityNone" ); } );
        }

        // Choosing "here" asks the browser now, while someone is at the
        // keyboard to answer - never later, on the lock screen.
        geo.addEventListener( "change", function ()
        {
            if( ! geo.checked ) return;
            cfg.place = "geo";
            if( ! navigator.geolocation ) { geoMsg.hidden = false; geoMsg.textContent = t( "salon.geoDenied" ); return; }
            geoMsg.hidden = false;
            geoMsg.textContent = "…";
            navigator.geolocation.getCurrentPosition( function ( g )
            {
                var lat = Math.round( g.coords.latitude * 100 ) / 100, lon = Math.round( g.coords.longitude * 100 ) / 100;
                geoMsg.textContent = "✓";
                NayiveUI.townName( lat, lon ).then( function ( n ) { if( n ) geoMsg.textContent = "✓ " + n; } );
            }, function () { geoMsg.textContent = t( "salon.geoDenied" ); }, { timeout: 20000, maximumAge: 30 * 6e4 } );
        } );
        city.addEventListener( "change", function () { if( city.checked ) { cfg.place = "city"; q.focus(); } } );
        if( cfg.place === "geo" && navigator.permissions )
            navigator.permissions.query( { name: "geolocation" } ).then( function ( s )
            {
                if( s.state === "denied" ) { geoMsg.hidden = false; geoMsg.textContent = t( "salon.geoDenied" ); }
            }, function () {} );

        // Who gives it.
        var who = el( "div", "salon-two", null, p );
        who.style.marginTop = "14px";
        choose( who, t( "salon.weatherBy" ), cfg.weather,
                Object.keys( S.WEATHER ).map( function ( k ) { return [ k, S.WEATHER[ k ].name ]; } ),
                function ( v ) { cfg.weather = v; } );

        var two = el( "div", "salon-two", null, p );
        two.style.marginTop = "14px";
        choose( two, t( "salon.units" ), cfg.units, [ [ "c", "°C" ], [ "f", "°F" ] ], function ( v ) { cfg.units = v; } );
        choose( two, t( "salon.clock" ), cfg.hours, [ [ 24, t( "salon.h24" ) ], [ 12, t( "salon.h12" ) ] ],
                function ( v ) { cfg.hours = Number( v ); } );

        // The letters, with a sample in them.
        var three = el( "div", "salon-two", null, p );
        var fontSel = choose( three, t( "salon.font" ), cfg.font,
                              Object.keys( S.FONT_SETS ).map( function ( f ) { return [ f, t( "salon.font." + f ) ]; } ),
                              function ( v ) { cfg.font = v; sample(); } );
        choose( three, t( "salon.size" ), cfg.size, [ [ "s", t( "salon.size.s" ) ], [ "m", t( "salon.size.m" ) ], [ "l", t( "salon.size.l" ) ] ],
                function ( v ) { cfg.size = v; sample(); } );
        var prev = el( "div", "salon-preview", null, p );
        var big = el( "div", "big", "18:43 · procedencia", prev );
        var txt = el( "div", "txt", "Son las siete menos cuarto. — Venus and Mars is an oil painting on canvas by Paolo Veronese.", prev );
        function sample()
        {
            var f = S.FONT_SETS[ fontSel.value ], k = { s: 0.88, m: 1, l: 1.15 }[ cfg.size ];
            big.style.fontFamily = f[ 0 ];
            txt.style.fontFamily = f[ 1 ];
            big.style.fontSize = ( 2 * k ) + "rem";
            txt.style.fontSize = ( 1.05 * k ) + "rem";
            prev.style.background = cfg.contrast === "high" ? "#000" : "";
            prev.style.color = cfg.contrast === "high" ? "#fff" : "";
        }
        sample();

        choose( el( "div", null, null, p ), t( "salon.contrast" ), cfg.contrast,
                [ [ "normal", t( "salon.contrast.normal" ) ], [ "high", t( "salon.contrast.high" ) ] ],
                function ( v ) { cfg.contrast = v; sample(); } ).parentNode.style.marginTop = "14px";
    }

    //------------------------------------------------------------------------//

    function save()
    {
        if( ! cfg ) return;
        bSave.disabled = true;
        A.write( cfg ).then( function ()
        {
            ui.close();
            NayiveUI.toast( t( "salon.saved" ) );
        }, function ()
        {
            // Kept on this device anyway (S.write keeps the local copy first).
            ui.close();
            NayiveUI.toast( t( "salon.saveFail" ) );
        } );
    }
}

window.NayiveSalonSettings = { open: open };
} )();
