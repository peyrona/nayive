/*
 * lockers/science.js - "Science", the screen locker for people of science
 * (shared/locker.js; design: docs/culture-locker-plan.md). The sister of
 * Bellas artes (lockers/culture.js), on the same engine
 * (window.NayiveSalon.engine) and with the same look. Six boxes:
 *
 *   left:   the time (UTC, day of the year, Unix time) · the sky (weather,
 *           sun, hours of light, the Moon's phase - computed here)
 *   centre: the image of the day (NASA, ESO, ESA/Hubble + ESA/Webb, taking
 *           turns); under it, side by side, on this day
 *           (scientists born / died) and the element of the day (with its
 *           place in the periodic table)
 *   right:  the NEWS ZONE: science news in the user's languages, all the
 *           column - one story at length, the next headlines under it
 *
 * Everything is LIVE, from free sources whose terms allow it (checked
 * 2026-09-30): Agencia SINC (CC BY 4.0), The Conversation (CC BY-ND 4.0),
 * Agência FAPESP (CC BY-NC-ND), NASA (public domain), ESO + ESA/Hubble +
 * ESA/Webb (CC BY 4.0), Wikipedia + Wikidata,
 * Open-Meteo / MET Norway / wttr.in (weather, the user picks). News are shown
 * as their authors wrote them: title and lead, no
 * pictures (The Conversation's are stock photos under other terms), the
 * source always named. There is no German source with such terms (idw needs
 * a paid contract): German news are simply absent, the box shows the others.
 *
 * NOTHING in a language the user has not chosen: the pictures' English text only
 * shows when English is one of the picture box's languages (else the image
 * alone), and English articles mixed into a Spanish or French feed are dropped.
 *
 * CLICKS: a story, a headline, the picture, the element, a person of "on this
 * day" and the sources open their page in a new tab (engine.linkTo); the
 * lock stays.
 *
 * As in Bellas artes: languages TAKE TURNS in each box, every choice depends
 * only on the date and time (every device shows the same), what was fetched
 * is kept in localStorage ("nv-science:") so the screen is never blank.
 *
 * SETTINGS are PER USER: data/science.json (the dialog: culture-settings.js,
 * opened from the desktop's "⋮" menu). Until it is saved once, the user's
 * Bellas artes settings (languages, place, look) are used.
 */
( function ()
{
"use strict";

var BASE = ( ( document.currentScript && document.currentScript.src ) || "" ).replace( /[^\/]*$/, "" );

function S() { return window.NayiveSalon; }

//----------------------------------------------------------------------------//
// WORDS - Science's own; the rest (weather, "fetching"...) are Bellas artes'.

var W =
{
    es: { sky: "El cielo en {c}", skyHere: "El cielo aquí", picture: "Imagen del día", news: "Noticias de ciencia",
          element: "Elemento del día", days: "Tal día como hoy", doy: "día {n} del año", week: "semana {n}",
          unix: "Tiempo Unix", light: "Horas de luz", tomorrow: "mañana", lit: "iluminada", full: "Luna llena", newM: "Luna nueva",
          phases: [ "Luna nueva", "Luna creciente", "Cuarto creciente", "Gibosa creciente", "Luna llena", "Gibosa menguante", "Cuarto menguante", "Luna menguante" ],
          number: "Número atómico", mass: "masa atómica", found: "Descubierto en {y}", by: "por {w}",
          period: "periodo {n}", group: "grupo {n}", lan: "lantánido", act: "actínido", more: "Más titulares",
          pd: "Dominio público", noNews: "No hay noticias en tus idiomas ahora." },
    en: { sky: "The sky in {c}", skyHere: "The sky here", picture: "Image of the day", news: "Science news",
          element: "Element of the day", days: "On this day", doy: "day {n} of the year", week: "week {n}",
          unix: "Unix time", light: "Daylight", tomorrow: "tomorrow", lit: "lit", full: "Full moon", newM: "New moon",
          phases: [ "New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent" ],
          number: "Atomic number", mass: "atomic mass", found: "Discovered in {y}", by: "by {w}",
          period: "period {n}", group: "group {n}", lan: "lanthanide", act: "actinide", more: "More headlines",
          pd: "Public domain", noNews: "No news in your languages right now." },
    fr: { sky: "Le ciel à {c}", skyHere: "Le ciel ici", picture: "Image du jour", news: "Actualité scientifique",
          element: "Élément du jour", days: "Ce jour-là", doy: "{n}ᵉ jour de l’année", week: "semaine {n}",
          unix: "Temps Unix", light: "Durée du jour", tomorrow: "demain", lit: "éclairée", full: "Pleine lune", newM: "Nouvelle lune",
          phases: [ "Nouvelle lune", "Premier croissant", "Premier quartier", "Gibbeuse croissante", "Pleine lune", "Gibbeuse décroissante", "Dernier quartier", "Dernier croissant" ],
          number: "Numéro atomique", mass: "masse atomique", found: "Découvert en {y}", by: "par {w}",
          period: "période {n}", group: "groupe {n}", lan: "lanthanide", act: "actinide", more: "Autres titres",
          pd: "Domaine public", noNews: "Pas d’actualités dans vos langues pour l’instant." },
    de: { sky: "Der Himmel in {c}", skyHere: "Der Himmel hier", picture: "Bild des Tages", news: "Wissenschaftsnachrichten",
          element: "Element des Tages", days: "An diesem Tag", doy: "{n}. Tag des Jahres", week: "Woche {n}",
          unix: "Unixzeit", light: "Tageslicht", tomorrow: "morgen", lit: "beleuchtet", full: "Vollmond", newM: "Neumond",
          phases: [ "Neumond", "Zunehmende Sichel", "Erstes Viertel", "Zunehmender Mond", "Vollmond", "Abnehmender Mond", "Letztes Viertel", "Abnehmende Sichel" ],
          number: "Ordnungszahl", mass: "Atommasse", found: "Entdeckt {y}", by: "von {w}",
          period: "Periode {n}", group: "Gruppe {n}", lan: "Lanthanoid", act: "Actinoid", more: "Weitere Schlagzeilen",
          pd: "Gemeinfrei", noNews: "Gerade keine Nachrichten in Ihren Sprachen." },
    pt: { sky: "O céu em {c}", skyHere: "O céu aqui", picture: "Imagem do dia", news: "Notícias de ciência",
          element: "Elemento do dia", days: "Neste dia", doy: "dia {n} do ano", week: "semana {n}",
          unix: "Tempo Unix", light: "Horas de luz", tomorrow: "amanhã", lit: "iluminada", full: "Lua cheia", newM: "Lua nova",
          phases: [ "Lua nova", "Lua crescente", "Quarto crescente", "Crescente gibosa", "Lua cheia", "Minguante gibosa", "Quarto minguante", "Lua minguante" ],
          number: "Número atómico", mass: "massa atómica", found: "Descoberto em {y}", by: "por {w}",
          period: "período {n}", group: "grupo {n}", lan: "lantanídeo", act: "actinídeo", more: "Mais notícias",
          pd: "Domínio público", noNews: "Não há notícias nas suas línguas agora." }
};

//----------------------------------------------------------------------------//
// THE NEWS SOURCES - only ones whose terms let us show them (see the top).
// `off`: not ticked until the user asks (The Conversation Brasil is every
// subject, not only science).

var NEWS =
{
    sinc:   { lang: "es", home: "https://www.agenciasinc.es/", name: "Agencia SINC",             lic: "CC BY 4.0",    url: "https://www.agenciasinc.es/feed/Noticias" },
    tcEs:   { lang: "es", home: "https://theconversation.com/es", name: "The Conversation",         lic: "CC BY-ND 4.0", url: "https://theconversation.com/es/ciencia/articles.atom" },
    tcEn:   { lang: "en", home: "https://theconversation.com/uk", name: "The Conversation",         lic: "CC BY-ND 4.0", url: "https://theconversation.com/uk/technology/articles.atom" },
    nasa:   { lang: "en", home: "https://www.nasa.gov/news/", name: "NASA",                     lic: "",             url: "https://www.nasa.gov/news-release/feed/" },
    tcFr:   { lang: "fr", home: "https://theconversation.com/fr", name: "The Conversation",         lic: "CC BY-ND 4.0", url: "https://theconversation.com/fr/technologie/articles.atom" },
    tcCa:   { lang: "fr", home: "https://theconversation.com/ca-fr", name: "La Conversation Canada",   lic: "CC BY-ND 4.0", url: "https://theconversation.com/ca-fr/science-et-technologie/articles.atom" },
    fapesp: { lang: "pt", home: "https://agencia.fapesp.br/", name: "Agência FAPESP",           lic: "CC BY-NC-ND",  url: "https://agencia.fapesp.br/rss/" },
    tcPt:   { lang: "pt", home: "https://theconversation.com/br", name: "The Conversation Brasil",  lic: "CC BY-ND 4.0", url: "https://theconversation.com/articles.atom?language=pt", off: true }
};
// THE PICTURE SOURCES - all English, all ticked by default. ESA/Hubble's own
// "picture of the week" stopped at the end of 2025: its news images instead.
var PICS =
{
    nasa: { name: "NASA",               lic: "",          home: "https://www.nasa.gov/image-of-the-day/",
            feeds: [ "https://www.nasa.gov/feeds/iotd-feed/" ], img: /^https:\/\/www\.nasa\.gov\/.+\.(jpe?g|png)$/i, w: "?w=1600" },
    eso:  { name: "ESO",                lic: "CC BY 4.0", home: "https://www.eso.org/public/images/potw/",
            feeds: [ "https://www.eso.org/public/images/potw/feed/" ], img: /^https:\/\/cdn\.eso\.org\/.+\.(jpe?g|png)$/i, w: "" },
    esa:  { name: "ESA/Hubble · ESA/Webb", lic: "CC BY 4.0", home: "https://esawebb.org/images/potm/",
            feeds: [ "https://esahubble.org/news/feed/", "https://esawebb.org/images/potm/feed/" ],
            img: /^https:\/\/cdn\.esa(hubble|webb)\.org\/.+\.(jpe?g|png)$/i, w: "" }
};

// On this day: scientists. scientist, physicist, chemist, mathematician,
// astronomer, biologist, engineer, inventor, physician, geologist, botanist,
// zoologist, computer scientist, astronaut, naturalist, statistician,
// meteorologist, paleontologist, geneticist, microbiologist, neuroscientist,
// biochemist, nuclear physicist, theoretical physicist (checked 2026-09-30)...
var SCI_OCC = [ "Q901", "Q169470", "Q593644", "Q170790", "Q11063", "Q864503", "Q81096", "Q205375", "Q39631",
                "Q520549", "Q2374149", "Q350979", "Q82594", "Q11631", "Q18805", "Q2732142", "Q2310145",
                "Q1662561", "Q3126128", "Q3779582", "Q6337803", "Q2919046", "Q16742096", "Q19350898" ];
// ...but not the rulers and soldiers who also did science.
var NOT_OCC = [ "Q82955", "Q372436", "Q116", "Q189290" ];

//----------------------------------------------------------------------------//
// SETTINGS - shared with the dialog (culture-settings.js, "science" profile).

var CARDS = [ "clock", "sky", "picture", "days", "news", "element" ];

function normalise( s )
{
    s = s && typeof s === "object" ? s : {};
    var b = S().normalise( s );            // languages, place, look: as Bellas artes checks them
    var o = { langs: b.langs, turn: b.turn, place: b.place, city: b.city, weather: b.weather, units: b.units, hours: b.hours,
              font: b.font, contrast: b.contrast, size: b.size };
    o.cards = {};
    CARDS.forEach( function ( c )
    {
        var x = s.cards && s.cards[ c ] || {};
        var l = Array.isArray( x.langs ) ? x.langs.filter( function ( y, i, a ) { return o.langs.indexOf( y ) >= 0 && a.indexOf( y ) === i; } ) : [];
        l.sort( function ( a, b ) { return o.langs.indexOf( a ) - o.langs.indexOf( b ); } );
        o.cards[ c ] = { on: x.on !== false, langs: l.length ? l : null };
    } );
    o.news = Array.isArray( s.news ) ? s.news.filter( function ( k, i, a ) { return !! NEWS[ k ] && a.indexOf( k ) === i; } ) : null;
    if( ! o.news ) o.news = Object.keys( NEWS ).filter( function ( k ) { return ! NEWS[ k ].off; } );
    o.newsEvery = [ 30, 60, 120, 300 ].indexOf( Number( s.newsEvery ) ) >= 0 ? Number( s.newsEvery ) : 60;
    o.pics = Array.isArray( s.pics ) ? s.pics.filter( function ( k, i, a ) { return !! PICS[ k ] && a.indexOf( k ) === i; } ) : [];
    if( ! o.pics.length ) o.pics = Object.keys( PICS );
    o.picHours  = [ 1, 2, 4, 8, 24 ].indexOf( Number( s.picHours ) ) >= 0 ? Number( s.picHours ) : 24;
    return o;
}

// From Bellas artes' settings, only what both lockers share.
function shared( b )
{
    var o = {};
    [ "langs", "turn", "place", "city", "weather", "units", "hours", "font", "contrast", "size" ].forEach( function ( k ) { if( b && k in b ) o[ k ] = b[ k ]; } );
    return normalise( o );
}

var FILE  = "data/science.json";       // in the user's home
var LOCAL = "nayive-science";          // this device's copy

function localCopy()
{
    try { return JSON.parse( localStorage.getItem( LOCAL ) || "null" ); } catch ( e ) { return null; }
}
function keepLocal( s ) { try { localStorage.setItem( LOCAL, JSON.stringify( s ) ); } catch ( e ) {} }

// The server's copy, else this device's; never saved: Bellas artes' languages,
// place and look.
function read()
{
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout( function () { if( ctl ) ctl.abort(); }, 4000 );
    return fetch( "/api/files?file=" + encodeURIComponent( FILE ),
                  { credentials: "same-origin", cache: "no-store", signal: ctl ? ctl.signal : undefined } )
        .then( function ( r )
        {
            clearTimeout( timer );
            if( r.status === 404 ) return S().read().then( shared );
            if( ! r.ok ) throw new Error( "status " + r.status );
            return r.json().then( function ( s ) { s = normalise( s ); keepLocal( s ); return s; } );
        } )
        .catch( function ()
        {
            clearTimeout( timer );
            var l = localCopy();
            if( l ) return normalise( l );
            try { return shared( JSON.parse( localStorage.getItem( "nayive-salon" ) || "null" ) ); }
            catch ( e ) { return normalise( null ); }
        } );
}

function write( s )
{
    s = normalise( s );
    keepLocal( s );
    return fetch( "/api/files?file=" + encodeURIComponent( FILE ),
                  { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify( s, null, 2 ) } )
        .then( function ( r ) { if( ! r.ok ) throw new Error( "status " + r.status ); return s; } );
}

window.NayiveScience = { CARDS: CARDS, NEWS: NEWS, PICS: PICS, normalise: normalise, read: read, write: write };

// Bellas artes carries the engine: loaded first, when not there yet.
function need()
{
    if( S() && S().engine ) return Promise.resolve();
    return new Promise( function ( ok, fail )
    {
        var sc = document.createElement( "script" );
        sc.src = BASE + "culture.js";
        sc.onload = function () { if( S() && S().engine ) ok(); else fail( new Error( "no engine" ) ); };
        sc.onerror = fail;
        document.head.appendChild( sc );
    } );
}

// The locker: the engine and the settings first, then the screen.
NayiveLock.define( "science", function ( host )
{
    var stop = null, gone = false;
    need().then( read ).then( function ( s ) { if( ! gone ) stop = start( host, s ); }, function () {} );
    return function () { gone = true; if( stop ) stop(); };
} );


//----------------------------------------------------------------------------//
// THE MOON - its age from a known new moon (2000-01-06 18:14 UTC) and the
// mean synodic month: half a day off at worst, which is plenty for a phase.

var SYNODIC = 29.530588853, NEW0 = Date.UTC( 2000, 0, 6, 18, 14 );

function moon( t )
{
    var age = ( ( t - NEW0 ) / 864e5 ) % SYNODIC;
    if( age < 0 ) age += SYNODIC;
    var f = age / SYNODIC;
    return { f: f, lit: ( 1 - Math.cos( 2 * Math.PI * f ) ) / 2, phase: Math.floor( f * 8 + 0.5 ) % 8,
             full: t + ( ( 1.5 - f ) % 1 || 1 ) * SYNODIC * 864e5,
             newM: t + ( ( 1 - f ) % 1 || 1 ) * SYNODIC * 864e5 };
}

// The Moon as seen from the north (from the south it is mirrored): an SVG.
function moonSvg( m, south )
{
    var waxing = m.f < 0.5, crescent = m.lit < 0.5;
    var rx = Math.abs( Math.cos( 2 * Math.PI * m.f ) ).toFixed( 3 );
    var limb = waxing ? 1 : 0, term = waxing ? ( crescent ? 0 : 1 ) : ( crescent ? 1 : 0 );
    return '<svg viewBox="-1.1 -1.1 2.2 2.2" aria-hidden="true"><g' + ( south ? ' transform="scale(-1,1)"' : '' ) + '>' +
           '<circle r="1" fill="#2a2621" stroke="rgba(246,241,231,0.25)" stroke-width="0.03"/>' +
           '<path d="M0,-1 A1,1 0 0 ' + limb + ' 0,1 A' + rx + ',1 0 0 ' + term + ' 0,-1Z" fill="#EDE6D6"/></g></svg>';
}

//----------------------------------------------------------------------------//
// THE PERIODIC TABLE - where element n sits: {row, col} in the 18-column
// table (lanthanides and actinides in rows 8 and 9), its period and group.

function place( n )
{
    var ends = [ 2, 10, 18, 36, 54, 86, 118 ], p = 0;
    while( n > ends[ p ] ) p++;
    var o = n - ( p ? ends[ p - 1 ] : 0 );              // 1-based inside its period
    var g;
    if( p === 0 ) g = n === 1 ? 1 : 18;
    else if( p < 3 ) g = o <= 2 ? o : o + 10;
    else if( p < 5 ) g = o;
    else if( o <= 2 ) g = o;
    else if( o <= 16 ) return { period: p + 1, group: 0, f: p === 5 ? "lan" : "act", row: p + 3, col: o + 1 };   // La..Yb / Ac..No
    else g = o - 14;
    return { period: p + 1, group: g, f: "", row: p + 1, col: g };
}


function start( host, cfg )
{
    var E = S().engine, T = E.T, el = E.el, pad = E.pad, ymd = E.ymd, cap = E.cap;
    var cached = E.store( "nv-science:" );
    var alive = true;
    var TURN = cfg.turn;
    var OFFSET = { clock: 0, picture: 12, days: 24, news: 36, element: 48 };
    var L0 = cfg.langs[ 0 ];

    function langsOf( card )
    {
        var c = cfg.cards[ card ];
        return c && c.langs ? c.langs : cfg.langs;
    }
    function on( card ) { return cfg.cards[ card ].on; }
    function fmt( s, k, v ) { return s.replace( "{" + k + "}", v ); }

    //------------------------------------------------------------------------//
    // DATA

    function xml( url, ttl )
    {
        return E.src( url, ttl, true ).then( function ( s )
        {
            var d = new DOMParser().parseFromString( s, "text/xml" );
            if( d.getElementsByTagName( "parsererror" ).length ) throw new Error( "not a feed" );
            return d;
        } );
    }
    function kid( node, name )                       // the first child element by local name
    {
        for( var c = node.firstElementChild; c; c = c.nextElementSibling )
            if( c.localName === name ) return c;
        return null;
    }
    function txt( node ) { return node ? node.textContent.replace( /\s+/g, " " ).trim() : ""; }
    // HTML (a feed's description or content) -> its first real paragraph, as text.
    function lead( html )
    {
        if( ! html ) return "";
        var d = new DOMParser().parseFromString( html, "text/html" );
        [].forEach.call( d.querySelectorAll( "figure, img, script, style" ), function ( x ) { x.remove(); } );
        var ps = d.querySelectorAll( "p" ), s = "";
        for( var i = 0; i < ps.length && s.length < 60; i++ ) s = txt( ps[ i ] );
        if( ! s ) s = txt( d.body );
        if( s.length > 420 ) s = s.slice( 0, 420 ).replace( /\s+\S*$/, "" ) + "…";
        return s;
    }

    // The Conversation's Spanish, French... feeds carry a few articles in
    // English, and nothing marks them: the small words tell (title and lead
    // together; in doubt, out).
    var SMALL =
    {
        en: /^(the|and|of|to|is|are|how|what|why|you|it|for|with|this|that|from|was|has|have|its|your|can|new)$/,
        es: /^(el|la|los|las|de|que|y|en|por|qué|un|una|es|del|con|para|se|como|más|su)$/,
        fr: /^(le|la|les|des|de|du|et|est|un|une|que|pour|dans|qui|sur|pas|au|aux|ce|son)$/,
        de: /^(der|die|das|und|ist|nicht|ein|eine|zu|mit|von|auf|für|den|dem|wie|was)$/,
        pt: /^(o|a|os|as|de|do|da|que|e|em|um|uma|para|com|não|dos|das|na|no|se)$/
    };
    function inLang( lang, text )
    {
        if( lang === "en" ) return true;
        var own = 0, en = 0;
        String( text ).toLowerCase().split( /[^a-zà-ÿ]+/ ).forEach( function ( w )
        {
            if( SMALL[ lang ].test( w ) ) own++;
            if( SMALL.en.test( w ) ) en++;
        } );
        return own > en || ( ! own && ! en );
    }

    // A feed, RSS or Atom -> [{title, lead, date (ms or 0), by}], newest first.
    function getFeed( id )
    {
        var f = NEWS[ id ];
        return cached( "news2:" + id, 30 * 6e4, function ()
        {
            return xml( f.url, 3600 ).then( function ( d )
            {
                var items = [].slice.call( d.getElementsByTagName( "item" ) ), atom = false;
                if( ! items.length ) { items = [].slice.call( d.getElementsByTagName( "entry" ) ); atom = true; }
                var out = items.slice( 0, 15 ).map( function ( it )
                {
                    var when = txt( kid( it, atom ? "published" : "pubDate" ) || kid( it, "updated" ) || kid( it, "date" ) );
                    var body = atom ? txt( kid( it, "summary" ) ) || lead( ( kid( it, "content" ) || {} ).textContent )
                                    : lead( ( kid( it, "description" ) || {} ).textContent );
                    var au = atom ? kid( it, "author" ) : kid( it, "creator" ) || kid( it, "author" );
                    var by = au ? txt( atom ? kid( au, "name" ) || au : au ) : "";
                    var title = E.plain( txt( kid( it, "title" ) ) ), ln = kid( it, "link" );
                    var link = atom ? [].filter.call( it.getElementsByTagName( "link" ), function ( l ) { return ( l.getAttribute( "rel" ) || "alternate" ) === "alternate"; } )
                                                .map( function ( l ) { return l.getAttribute( "href" ); } )[ 0 ] || ""
                                    : txt( ln );
                    if( /^APOD:/.test( title ) ) body = "";        // NASA's feed: an APOD entry's text is its page menu
                    return { title: title, lead: body, date: Date.parse( when ) || 0, link: link,
                             by: by === "SINC" ? "" : by.slice( 0, 80 ) };
                } ).filter( function ( n )
                {
                    return n.title && ( ! n.date || Date.now() - n.date < 21 * 864e5 ) && inLang( f.lang, n.title + " " + n.lead );
                } );
                if( ! out.length ) throw new Error( "no news" );
                return out;
            } );
        } );
    }

    // One source's pictures: the last few, newest first.
    function getPictures( id )
    {
        var P = PICS[ id ];
        return cached( "pictures3:" + id, 3 * 3600e3, function ()
        {
            return Promise.all( P.feeds.map( function ( url )
            {
                return xml( url, 3 * 3600 ).then( function ( d )
                {
                    return [].slice.call( d.getElementsByTagName( "item" ) ).slice( 0, 12 ).map( function ( it )
                    {
                        var enc = kid( it, "enclosure" ), text = lead( ( kid( it, "description" ) || {} ).textContent );
                        if( /^[a-z]+\d+[a-z]? - /i.test( text ) ) text = "";          // ESA/Webb's: only "potm2609 - its title"
                        return { title: E.plain( txt( kid( it, "title" ) ) ).replace( /^[\w ]*Release:\s*/i, "" ), text: text,
                                 link: txt( kid( it, "link" ) ), src: id,
                                 image: enc ? enc.getAttribute( "url" ) : "", date: Date.parse( txt( kid( it, "pubDate" ) ) ) || 0 };
                    } );
                }, function () { return []; } );
            } ) ).then( function ( ls )
            {
                var out = [].concat.apply( [], ls ).filter( function ( p ) { return P.img.test( p.image ); } )
                            .sort( function ( x, y ) { return y.date - x.date; } ).slice( 0, 12 );
                if( ! out.length ) throw new Error( "no picture" );
                return out;
            } );
        } );
    }

    // The element of the day: its data, its name in every language, and the
    // titles of its Wikipedia articles.
    function getElement( n )
    {
        return cached( "element:" + n, 30 * 864e5, function ()
        {
            var wps = S().LANGS.map( function ( l ) { return "<https://" + l + ".wikipedia.org/>"; } ).join( " " );
            return E.sparql( "SELECT ?el ?sym (SAMPLE(?m) AS ?mass) (MIN(?d) AS ?found) (SAMPLE(?who) AS ?by)" +
                             " (GROUP_CONCAT(DISTINCT ?art; separator=\" \") AS ?arts) WHERE {" +
                             " ?el wdt:P31 wd:Q11344; wdt:P1086 ?n; wdt:P246 ?sym. FILTER(?n = " + n + ")" +
                             " OPTIONAL { ?el wdt:P2067 ?m } OPTIONAL { ?el wdt:P575 ?d } OPTIONAL { ?el wdt:P61 ?who }" +
                             " OPTIONAL { ?art schema:about ?el; schema:isPartOf ?wp. VALUES ?wp { " + wps + " } }" +
                             " } GROUP BY ?el ?sym", 30 * 86400 ).then( function ( rows )
            {
                var b = rows[ 0 ];
                if( ! b ) throw new Error( "no element" );
                var x = { n: n, id: E.qid( E.v( b, "el" ) ), sym: E.v( b, "sym" ), mass: E.v( b, "mass" ),
                          found: E.year( E.v( b, "found" ) ), who: E.v( b, "by" ) ? E.qid( E.v( b, "by" ) ) : "", arts: {} };
                E.v( b, "arts" ).split( " " ).forEach( function ( u )
                {
                    var m = /^https:\/\/(\w+)\.wikipedia\.org\/wiki\/(.+)$/.exec( u );
                    if( m ) x.arts[ m[ 1 ] ] = decodeURIComponent( m[ 2 ] );
                } );
                return E.src( "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|descriptions" +
                              "&languages=" + S().LANGS.join( "|" ) + "&ids=" + x.id + ( x.who ? "|" + x.who : "" ), 30 * 86400 ).then( function ( p )
                {
                    function names( id, what )
                    {
                        var e = p.entities && p.entities[ id ], o = {};
                        if( e && e[ what ] ) for( var l in e[ what ] ) o[ l ] = e[ what ][ l ].value;
                        return o;
                    }
                    x.name = names( x.id, "labels" );
                    x.about = names( x.id, "descriptions" );
                    x.by = x.who ? names( x.who, "labels" ) : {};
                    return x;
                } );
            } );
        } );
    }

    //------------------------------------------------------------------------//
    // THE SCREEN - Bellas artes' boxes (.cl-*), plus Science's own (.sc-*).

    var style = document.createElement( "style" );
    style.textContent = E.css() + "\n" + CSS;
    document.head.appendChild( style );

    function box( parent, cls, source )
    {
        var b = el( "section", "cl-box " + cls, null, parent );
        var h = el( "div", "cl-head", null, b );
        var l = el( "span", "", null, h );
        var s = el( "span", "src", source || "", h );
        var body = el( "div", "cl-body", null, b );
        return { box: b, head: l, src: s, body: body, shown: "" };
    }
    // Fades a box out, refills it, fades it in; the same thing is not redrawn.
    function refill( part, sig, head, lang, fill )
    {
        if( part.shown === sig ) return;
        var first = ! part.shown;
        part.shown = sig;
        part.box.classList.add( "out" );
        setTimeout( function ()
        {
            if( ! alive || part.shown !== sig ) return;
            part.head.textContent = head;
            part.box.lang = lang || "";
            part.body.innerHTML = "";
            fill( part.body );
            part.box.classList.remove( "out" );
        }, first ? 0 : 350 );
    }
    function quiet( part, head, key )
    {
        refill( part, "quiet:" + key + head, head, L0, function ( b ) { el( "div", "cl-quiet", T[ L0 ][ key ] || W[ L0 ][ key ], b ); } );
    }

    var wall  = el( "img", "cl-wall", null, host ); wall.alt = "";
    var grid  = el( "div", "cl-grid sc-grid" + ( cfg.contrast === "high" ? " cl-high" : "" ), null, host );
    var fonts = S().FONT_SETS[ cfg.font ];
    grid.style.setProperty( "--cl-display", fonts[ 0 ] );
    grid.style.setProperty( "--cl-text", fonts[ 1 ] );
    grid.style.setProperty( "--k", { s: 0.88, m: 1, l: 1.15 }[ cfg.size ] );
    if( cfg.contrast === "high" ) wall.hidden = true;
    var left  = el( "div", "cl-wing", null, grid );
    var mid   = el( "div", "cl-wing", null, grid );
    var right = el( "div", "cl-wing", null, grid );

    var clock   = box( left,  "cl-clock", "" );
    var sky     = box( left,  "sc-sky", S().WEATHER[ cfg.weather ].name );
    E.linkTo( sky.src, S().WEATHER[ cfg.weather ].url );
    var picture = box( mid,   "cl-art sc-picture", "" );
    var pair    = el( "div", "sc-pair", null, mid );
    var days    = box( pair,  "cl-days", "Wikipedia" );
    var element = box( pair,  "sc-element", "Wikidata · Wikipedia" );
    var news    = box( right, "sc-news", "" );

    [ [ clock, "clock" ], [ sky, "sky" ], [ picture, "picture" ], [ days, "days" ], [ news, "news" ], [ element, "element" ] ]
        .forEach( function ( p ) { if( ! on( p[ 1 ] ) ) p[ 0 ].box.remove(); } );
    if( ! pair.childNodes.length ) pair.remove();
    var cols = [];
    [ [ left, 25 ], [ mid, 45 ], [ right, 30 ] ].forEach( function ( w )
    {
        if( w[ 0 ].childNodes.length ) cols.push( "minmax(0," + w[ 1 ] + "fr)" );
        else w[ 0 ].remove();
    } );
    grid.style.gridTemplateColumns = cols.join( " " );

    [ [ sky, W[ L0 ].skyHere ], [ picture, W[ L0 ].picture ], [ days, W[ L0 ].days ],
      [ news, W[ L0 ].news ], [ element, W[ L0 ].element ] ].forEach( function ( p ) { quiet( p[ 0 ], p[ 1 ], "wait" ); } );

    function turnLang( card, have )
    {
        var list = langsOf( card ).filter( have );
        if( ! list.length ) return "";
        var n = Math.floor( ( Date.now() / 1000 - OFFSET[ card ] ) / TURN );
        return list[ ( ( n % list.length ) + list.length ) % list.length ];
    }

    // -- the clock: the time, UTC, the day of the year, Unix time ----------- //

    var timeEl = el( "div", "cl-time", null, clock.body );
    var dateEl = el( "div", "cl-words", null, clock.body );
    var sciEl  = el( "div", "sc-facts", null, clock.body );
    var unixEl = el( "div", "sc-unix", null, clock.body );
    var tongue = el( "div", "cl-tongue", null, clock.body );

    function drawClock( d )
    {
        var H = d.getHours(), m = d.getMinutes();
        timeEl.innerHTML = "";
        timeEl.appendChild( document.createTextNode( cfg.hours === 12 ? String( H % 12 || 12 ) : pad( H ) ) );
        el( "span", "colon", ":", timeEl );
        timeEl.appendChild( document.createTextNode( pad( m ) ) );
        if( cfg.hours === 12 )
        {
            var ap = new Intl.DateTimeFormat( L0, { hour: "numeric", hour12: true } ).formatToParts( d )
                .filter( function ( x ) { return x.type === "dayPeriod"; } )[ 0 ];
            if( ap ) el( "span", "ampm", ap.value, timeEl );
        }
        unixEl.textContent = W[ clock.lang || L0 ].unix + " " + Math.floor( d / 1000 );
        var lang = turnLang( "clock", function () { return true; } ) || L0;
        var sig = lang + H + ":" + m;
        if( clock.shown === sig ) return;
        clock.shown = sig;
        clock.lang = lang;
        clock.head.textContent = T[ lang ].time;
        clock.box.lang = lang;
        dateEl.textContent = cap( E.dateWords( lang, d ) ) + ".";
        var y0 = new Date( d.getFullYear(), 0, 1 ), doy = Math.round( ( new Date( d.getFullYear(), d.getMonth(), d.getDate() ) - y0 ) / 864e5 ) + 1;
        sciEl.textContent = "UTC " + pad( d.getUTCHours() ) + ":" + pad( d.getUTCMinutes() ) + " · " +
                            fmt( W[ lang ].doy, "n", doy ) + " · " + fmt( W[ lang ].week, "n", E.isoWeek( d ).week );
        unixEl.textContent = W[ lang ].unix + " " + Math.floor( d / 1000 );
        tongue.textContent = T[ lang ].name;
    }

    // -- the sky: weather, sun, daylight, the Moon (in the first language) --- //

    var where = null, wx = null;
    function hm( iso )
    {
        if( ! iso ) return "";
        if( cfg.hours !== 12 ) return iso.slice( 11, 16 );
        return new Intl.DateTimeFormat( L0, { hour: "numeric", minute: "2-digit", hour12: true } )
            .format( new Date( 2000, 0, 1, +iso.slice( 11, 13 ), +iso.slice( 14, 16 ) ) );
    }
    function mins( iso ) { return +iso.slice( 11, 13 ) * 60 + +iso.slice( 14, 16 ); }

    function drawSky( d )
    {
        var t = T[ L0 ], w = W[ L0 ], mo = moon( d.getTime() );
        var head = where && where.name ? fmt( w.sky, "c", where.name ) : w.skyHere;
        var sig = "sky:" + ( wx ? wx.current.time : "" ) + head + mo.phase + Math.round( mo.lit * 100 ) + ymd( d );
        refill( sky, sig, head, L0, function ( b )
        {
            if( wx )
            {
                var c = wx.current, dl = wx.daily;
                var now = el( "div", "sc-now", null, b );
                el( "div", "big", E.deg( c.temperature_2m ), now );
                var nr = el( "div", "", null, now );
                el( "div", "sky", t.sky[ E.skyOf( c.weather_code ) ], nr );
                el( "div", "small", t.feels + " " + E.deg( c.apparent_temperature ) + ", " + t.wind + " " +
                                    Math.round( c.wind_speed_10m ) + " " + ( cfg.units === "f" ? "mph" : "km/h" ), nr );
                var sun = el( "div", "sc-sun", null, b );
                if( dl.sunrise[ 0 ] && dl.sunset[ 0 ] && dl.sunrise[ 1 ] && dl.sunset[ 1 ] ) {     // none in a polar day / night
                el( "div", "", t.sunrise + " " + hm( dl.sunrise[ 0 ] ) + ", " + t.sunset + " " + hm( dl.sunset[ 0 ] ) + ".", sun );
                var len0 = mins( dl.sunset[ 0 ] ) - mins( dl.sunrise[ 0 ] ), len1 = mins( dl.sunset[ 1 ] ) - mins( dl.sunrise[ 1 ] );
                var diff = len1 - len0;
                el( "div", "", w.light + " " + Math.floor( len0 / 60 ) + " h " + pad( len0 % 60 ) + " min (" + w.tomorrow + " " +
                               ( diff > 0 ? "+" : diff < 0 ? "−" : "±" ) + Math.abs( diff ) + " min).", sun );
                }
                var hr = wx.hourly, i0 = hr.time.indexOf( c.time.slice( 0, 13 ) + ":00" );
                if( i0 >= 0 )
                {
                    el( "div", "cl-hours-head", t.next, b );
                    var hs = el( "div", "cl-hours", null, b );
                    for( var i = i0 + 3; i < hr.time.length && hs.childNodes.length < 5; i += 3 )
                    {
                        var h = el( "div", "", null, hs );
                        el( "div", "hh", cfg.hours === 12 ? new Intl.DateTimeFormat( L0, { hour: "numeric", hour12: true } )
                                                               .format( new Date( 2000, 0, 1, +hr.time[ i ].slice( 11, 13 ) ) )
                                                         : hm( hr.time[ i ] ), h );
                        el( "div", "ht", E.deg( hr.temperature_2m[ i ] ), h );
                        el( "div", "hs", t.sky[ E.skyOf( hr.weather_code[ i ] ) ], h );
                    }
                }
            }
            var m = el( "div", "sc-moon", null, b );
            var pic = el( "div", "disc", null, m );
            pic.innerHTML = moonSvg( mo, where && where.lat < 0 );
            var mt = el( "div", "", null, m );
            el( "div", "phase", w.phases[ mo.phase ], mt );
            el( "div", "small", Math.round( mo.lit * 100 ) + " % " + w.lit, mt );
            var df = new Intl.DateTimeFormat( L0, { day: "numeric", month: "short" } );
            el( "div", "small", w.full + ": " + df.format( new Date( mo.full ) ) + " · " + w.newM + ": " + df.format( new Date( mo.newM ) ), mt );
        } );
    }

    function loadSky()
    {
        if( ! on( "sky" ) ) return;
        E.placeOf( cfg, cached ).then( function ( p )
        {
            where = p;
            return E.weatherAt( cached, p, cfg.units, cfg.weather ).then( function ( w ) { if( alive ) { wx = w; drawSky( new Date() ); } } );
        } ).catch( function () { if( alive ) drawSky( new Date() ); } );          // the Moon needs nothing
    }

    // -- the image of the day ------------------------------------------------ //

    var pics = null, picImg = null, skip = 0, picSize = function () {};
    function onResize() { picSize(); }
    window.addEventListener( "resize", onResize );
    // ...and when the boxes around it change (the element's story arrives).
    var picSeen = window.ResizeObserver ? new ResizeObserver( function () { picSize(); } ) : null;
    if( picSeen ) picSeen.observe( picture.body );

    // The sources take turns (newest of each first); every device the same.
    function picNow( d )
    {
        if( ! pics || ! pics.length ) return null;
        var perDay = Math.max( 1, 24 / cfg.picHours ), srcs = picSrcs.length || 1;
        var n = Math.min( pics.length, Math.max( srcs, perDay ) );
        var g = E.dayNo( d ) * perDay + Math.floor( d.getHours() / cfg.picHours );
        return pics[ ( g % n + skip ) % pics.length ];
    }

    function showPicture( d )
    {
        var p = picNow( d );
        if( ! p ) return;
        if( picImg && picImg.pic === p ) return;
        var img = new Image();
        img.pic = p;
        img.onerror = function () { if( alive && skip < 6 ) { skip++; showPicture( new Date() ); } };
        img.onload = function ()
        {
            if( ! alive ) return;
            picImg = img;
            wall.classList.remove( "on" );
            setTimeout( function () { if( alive ) { wall.src = img.src; wall.classList.add( "on" ); } }, 400 );
            drawPicture();
        };
        img.src = p.image + ( PICS[ p.src ] || {} ).w;
    }

    function drawPicture()
    {
        if( ! picImg ) return;
        var p = picImg.pic, img = picImg;
        var en = langsOf( "picture" ).indexOf( "en" ) >= 0;       // they all write in English only
        var P = PICS[ p.src ], who = P.name, home = P.home;
        if( p.src === "esa" && /esahubble/.test( p.image ) ) { who = "ESA/Hubble"; home = "https://esahubble.org/news/"; }
        else if( p.src === "esa" ) who = "ESA/Webb";
        refill( picture, "pic:" + p.image + en, W[ L0 ].picture, en ? "en" : L0, function ( b )
        {
            picture.src.textContent = who;
            var a = picture.src.parentNode.tagName === "A" ? picture.src.parentNode : null;
            if( a ) a.href = home; else E.linkTo( picture.src, home );
            var hang = el( "div", "cl-hang", null, b );
            img.alt = en ? p.title : "";
            hang.appendChild( img );
            E.linkTo( img, p.link );
            var lab = el( "div", "cl-label", null, b );
            var l1 = el( "div", "", null, lab );
            if( en ) E.linkTo( el( "span", "title", p.title, l1 ), p.link );
            var bits = [];
            if( p.date ) bits.push( new Intl.DateTimeFormat( L0, { day: "numeric", month: "long" } ).format( new Date( p.date ) ) );
            l1.appendChild( document.createTextNode( ( en ? ", " : "" ) + ( bits.length ? cap( bits[ 0 ] ) + ". " : "" ) + who + ", " + ( P.lic || W[ L0 ].pd.toLowerCase() ) + "." ) );
            if( en && p.text ) el( "div", "story", p.text, lab );
            picSize = function ()
            {
                var gap = parseFloat( getComputedStyle( lab ).marginTop ) || 0;
                var aw = b.clientWidth, ah = b.clientHeight - lab.offsetHeight - gap;
                var k = Math.max( 0, Math.min( aw / img.naturalWidth, ah / img.naturalHeight ) );
                img.style.width  = Math.floor( img.naturalWidth * k ) + "px";
                img.style.height = Math.floor( img.naturalHeight * k ) + "px";
            };
            picSize();
            if( document.fonts ) document.fonts.ready.then( function () { if( alive ) picSize(); } );
        } );
    }

    // -- on this day: scientists -------------------------------------------- //

    var dayList = {};
    function drawDays( d )
    {
        var lang = turnLang( "days", function ( l ) { return !! ( dayList[ l ] && dayList[ l ].length ); } );
        if( ! lang ) return;
        var l = dayList[ lang ], e = l[ d.getHours() % l.length ];
        refill( days, lang + e.year + e.text, W[ lang ].days, lang, function ( b )
        {
            var p = el( "div", "cl-day", null, b );
            el( "span", "yr", String( e.year ), p );
            el( "span", "kind", ( e.kind === "b" ? T[ lang ].born : T[ lang ].died ), p );
            p.appendChild( document.createTextNode( " " + e.text ) );
            E.linkTo( p, e.url );
        } );
    }

    // -- the news ---------------------------------------------------------- //

    var feeds = {};                                   // source id -> its items
    var newsFit = function () {};
    var newsSeen = window.ResizeObserver ? new ResizeObserver( function () { newsFit(); } ) : null;
    if( newsSeen ) newsSeen.observe( news.body );
    // A language's news: its sources taking turns, newest first in each.
    function newsOf( lang )
    {
        var lists = cfg.news.filter( function ( k ) { return NEWS[ k ].lang === lang && feeds[ k ]; } )
                            .map( function ( k ) { return feeds[ k ].map( function ( n ) { n.src = NEWS[ k ].name; n.home = NEWS[ k ].home; return n; } ); } );
        var out = [];
        for( var i = 0; i < 15; i++ ) lists.forEach( function ( l ) { if( l[ i ] ) out.push( l[ i ] ); } );
        return out;
    }
    function ago( lang, t )
    {
        if( ! t || ! window.Intl || ! Intl.RelativeTimeFormat ) return "";
        var r = new Intl.RelativeTimeFormat( lang, { numeric: "auto" } ), s = ( t - Date.now() ) / 1000;
        if( s > -3600 ) return r.format( Math.min( -1, Math.round( s / 60 ) ), "minute" );
        if( s > -86400 ) return r.format( Math.round( s / 3600 ), "hour" );
        return r.format( Math.round( s / 86400 ), "day" );
    }

    function drawNews()
    {
        var lang = turnLang( "news", function ( l ) { return newsOf( l ).length > 0; } );
        if( ! lang ) return;
        var list = newsOf( lang ), k = Math.floor( Date.now() / 1000 / cfg.newsEvery ) % list.length, n = list[ k ];
        refill( news, "news:" + lang + n.title, W[ lang ].news, lang, function ( b )
        {
            news.src.textContent = n.src;
            var a = news.src.parentNode.tagName === "A" ? news.src.parentNode : null;       // the source's own site
            if( a ) a.href = n.home; else E.linkTo( news.src, n.home );
            var top = el( "article", "sc-top", null, b );
            var when = ago( lang, n.date );
            if( when ) el( "div", "sc-meta", cap( when ), top );
            E.linkTo( el( "div", "sc-title", n.title, top ), n.link );
            var lead = n.lead ? el( "div", "sc-lead", n.lead, top ) : null;
            if( n.by ) el( "div", "sc-by", n.by.split( "," )[ 0 ], top );        // the name, not the post
            if( list.length > 1 )
            {
                var more = el( "div", "sc-more", W[ lang ].more, b );
                var ul = el( "ul", "sc-list", null, b );
                for( var i = 1; i <= Math.min( 8, list.length - 1 ); i++ )
                {
                    var x = list[ ( k + i ) % list.length ], li = el( "li", "", null, ul );
                    E.linkTo( el( "span", "t", x.title, li ), x.link );
                    el( "span", "s", x.src, li );
                }
                // Room for two headlines at least (the lead gives up lines,
                // 5 down to 2, for it), then only those that fit, whole -
                // again whenever the box changes size.
                newsFit = function ()
                {
                    var li = ul.children, n = li.length, j;
                    for( j = 0; j < n; j++ ) li[ j ].hidden = false;
                    more.hidden = false;
                    var want = Math.min( ul.scrollHeight, li[ 0 ].offsetHeight + ( li[ 1 ] ? li[ 1 ].offsetHeight : 0 ) + 12 );
                    for( var c = 5; c >= 2 && lead; c-- )
                    {
                        lead.style.webkitLineClamp = c;
                        if( ul.clientHeight >= want && top.scrollHeight <= top.clientHeight + 1 ) break;
                    }
                    while( n && ul.scrollHeight > ul.clientHeight + 1 ) li[ --n ].hidden = true;
                    more.hidden = ! n;
                };
                if( newsSeen ) { newsSeen.disconnect(); newsSeen.observe( news.body ); newsSeen.observe( ul ); }
                if( document.fonts ) document.fonts.ready.then( function () { if( alive ) newsFit(); } );
            }
            else newsFit = function ()
            {
                for( var c = 5; c >= 2 && lead; c-- )
                {
                    lead.style.webkitLineClamp = c;
                    if( top.scrollHeight <= top.clientHeight + 1 ) break;
                }
            };
            el( "div", "sc-dots", ( k + 1 ) + " / " + list.length, b );
            newsFit();
        } );
    }

    // -- the element of the day ---------------------------------------------- //

    var elem = null, elStories = {};
    function drawElement()
    {
        if( ! elem ) return;
        var x = elem;
        var lang = turnLang( "element", function ( l ) { return !! ( x.name[ l ] ); } ) || L0;
        var story = elStories[ lang ] || "";
        refill( element, "el:" + x.n + lang + ( story ? 1 : 0 ), W[ lang ].element, lang, function ( b )
        {
            var w = W[ lang ], pl = place( x.n );
            var top = el( "div", "sc-el", null, b );
            var tile = el( "div", "sc-tile", null, top );
            tile.title = w.number + " " + x.n + ( x.mass ? ", " + w.mass + " " + x.mass : "" );
            el( "div", "z", String( x.n ), tile );
            el( "div", "sym", x.sym, tile );
            if( x.mass ) el( "div", "m", String( Math.round( Number( x.mass ) * 1000 ) / 1000 ), tile );
            var info = el( "div", "sc-info", null, top );
            var url = x.arts[ lang ] ? E.wiki( lang + ".wikipedia.org", x.arts[ lang ] ) : "https://www.wikidata.org/wiki/" + x.id;
            E.linkTo( el( "div", "name", cap( x.name[ lang ] || x.sym ), info ), url );
            E.linkTo( tile, url );
            var facts = cap( pl.group ? fmt( w.period, "n", pl.period ) + ", " + fmt( w.group, "n", pl.group )
                                      : fmt( w.period, "n", pl.period ) + ", " + w[ pl.f ] ) + ".";
            if( x.found && Number( x.found ) > 0 )
            {
                var who = x.by[ lang ] || "";
                facts += " " + fmt( w.found, "y", x.found ) + ( who ? " " + fmt( w.by, "w", who ) : "" ) + ".";
            }
            el( "div", "small", facts, info );
            var text = story || x.about[ lang ] || "";
            if( text ) el( "div", "sc-story", text, b );
            b.appendChild( table( x.n ) );
        } );
    }

    // The periodic table in miniature, today's element lit.
    function table( n )
    {
        var t = el( "div", "sc-table" );
        t.setAttribute( "aria-hidden", "true" );
        for( var z = 1; z <= 118; z++ )
        {
            var p = place( z ), c = el( "i", z === n ? "on" : "", null, t );
            c.style.gridRow = p.row + ( p.row > 7 ? 1 : 0 );        // a gap before the f-block
            c.style.gridColumn = p.col;
        }
        return t;
    }

    //------------------------------------------------------------------------//
    // LOADING AND THE BEAT

    var loadedDay = "";
    function loadDay( d )
    {
        loadedDay = ymd( d );
        dayList = {}; elem = null; elStories = {};
        var fails = 0;
        if( on( "days" ) ) langsOf( "days" ).forEach( function ( l )
        {
            E.onThisDay( cached, l, d, SCI_OCC, NOT_OCC ).then( function ( x ) { if( alive ) { dayList[ l ] = x; drawDays( new Date() ); } },
                function () { if( ++fails >= langsOf( "days" ).length && alive && ! days.shown.indexOf( "quiet" ) ) quiet( days, W[ L0 ].days, "fail" ); } );
        } );
        if( on( "element" ) )
        {
            var n = ( ( E.dayNo( d ) % 118 ) + 118 ) % 118 + 1;
            getElement( n ).then( function ( x )
            {
                if( ! alive ) return;
                elem = x;
                drawElement();
                langsOf( "element" ).forEach( function ( l )
                {
                    if( x.arts[ l ] ) E.story( cached, l, x.arts[ l ] ).then( function ( s )
                    {
                        if( alive && elem === x ) { elStories[ l ] = s; drawElement(); }
                    }, function () {} );
                } );
            }, function () { if( alive ) quiet( element, W[ L0 ].element, "fail" ); } );
        }
        loadPictures();
    }

    // Each source's list, then all of them dealt in turns: NASA 1, ESO 1,
    // ESA 1, NASA 2...
    var picSrcs = [];
    function loadPictures()
    {
        if( ! on( "picture" ) ) return;
        Promise.all( cfg.pics.map( function ( k ) { return getPictures( k ).catch( function () { return []; } ); } ) )
            .then( function ( ls )
            {
                if( ! alive ) return;
                ls = ls.filter( function ( l ) { return l.length; } );
                if( ! ls.length ) { if( ! picImg ) quiet( picture, W[ L0 ].picture, "fail" ); return; }
                var all = [];
                for( var i = 0; i < 12; i++ ) ls.forEach( function ( l ) { if( l[ i ] ) all.push( l[ i ] ); } );
                picSrcs = ls;
                pics = all;
                skip = 0;
                showPicture( new Date() );
            } );
    }

    function loadNews()
    {
        if( ! on( "news" ) ) return;
        var ids = cfg.news.filter( function ( k ) { return langsOf( "news" ).indexOf( NEWS[ k ].lang ) >= 0; } ), left = ids.length;
        if( ! ids.length ) { quiet( news, W[ L0 ].news, "noNews" ); return; }
        ids.forEach( function ( k )
        {
            getFeed( k ).then( function ( l ) { if( alive ) { feeds[ k ] = l; drawNews(); } }, function () {} )
                .then( function ()
                {
                    if( --left === 0 && alive && ! Object.keys( feeds ).length ) quiet( news, W[ L0 ].news, "fail" );
                } );
        } );
    }

    var lastMin = -1, lastSlot = -1;
    function beat()
    {
        var d = new Date();
        if( ymd( d ) !== loadedDay ) { lastSlot = -1; loadDay( d ); }
        drawClock( d );
        var slot = Math.floor( d.getHours() / cfg.picHours );
        if( slot !== lastSlot && pics ) { lastSlot = slot; skip = 0; showPicture( d ); }
        drawDays( d );
        drawNews();
        drawElement();
        if( d.getMinutes() !== lastMin )
        {
            lastMin = d.getMinutes();
            drawSky( d );
            grid.style.transform = "translate(" + ( ( E.dayNo( d ) * 7 + lastMin * 13 ) % 13 - 6 ) + "px," +
                                                  ( ( lastMin * 7 ) % 11 - 5 ) + "px)";
        }
    }

    beat();
    loadSky();
    loadNews();
    var t1 = setInterval( beat, 1000 );
    var t2 = setInterval( function () { loadSky(); loadNews(); }, 10 * 6e4 );   // the caches keep it to 1 call per 30 min
    var t3 = setInterval( loadPictures, 60 * 6e4 );

    return function ()
    {
        alive = false;
        window.removeEventListener( "resize", onResize );
        if( newsSeen ) newsSeen.disconnect();
        if( picSeen ) picSeen.disconnect();
        clearInterval( t1 );
        clearInterval( t2 );
        clearInterval( t3 );
        host.innerHTML = "";
        style.remove();
    };
}


//----------------------------------------------------------------------------//
// THE LOOK - Bellas artes' (engine.css()), plus these.

var CSS = [
".sc-sky { flex: 1; }",
".sc-now { display: flex; align-items: center; gap: 0.9em; font-size: calc(var(--k, 1) * clamp(14px,1vw,19px)); line-height: 1.35; }",
".sc-now .big { font-size: calc(var(--k, 1) * clamp(38px,3.1vw,62px)); line-height: 1.05; font-variant-numeric: lining-nums; }",
".sc-now .sky { font-size: 1.15em; }",
".sc-now .small, .sc-moon .small { color: var(--smoke); font-variant-numeric: lining-nums; }",
".sc-sun { margin-top: 0.9em; padding-top: 0.7em; border-top: 1px solid var(--rule-2); color: var(--smoke); line-height: 1.45;",
"  font-size: calc(var(--k, 1) * clamp(14px,0.95vw,18px)); font-variant-numeric: lining-nums; }",
".sc-moon { margin-top: auto; padding-top: 0.8em; border-top: 1px solid var(--rule-2); display: flex; align-items: center; gap: 1em;",
"  font-size: calc(var(--k, 1) * clamp(14px,0.95vw,18px)); line-height: 1.4; }",
".sc-moon .disc { flex: none; width: calc(var(--k, 1) * clamp(54px,4.4vw,88px)); }",
".sc-moon .disc svg { display: block; width: 100%; height: auto; }",
".sc-moon .phase { font-family: var(--cl-display); font-size: 1.35em; line-height: 1.15; }",
".sc-sky .cl-hours > div { min-width: 0; }",
".sc-sky .cl-hours .hs { hyphens: auto; overflow-wrap: break-word; }",
".sc-facts { color: var(--smoke); margin-top: 0.45em; font-size: calc(var(--k, 1) * clamp(14px,0.98vw,18px)); font-variant-numeric: lining-nums; }",
".sc-unix { color: var(--smoke); margin-top: 0.2em; font-size: calc(var(--k, 1) * clamp(13px,0.9vw,17px)); font-variant-numeric: lining-nums tabular-nums; letter-spacing: 0.02em; }",

".sc-news { flex: 1; }",
".sc-pair { flex: none; display: flex; gap: 1.3vw; min-height: 0; }",
".sc-pair > .cl-box { flex: 1 1 0; min-width: 0; }",
".sc-pair > .cl-days { flex-grow: 0.8; }",
".sc-pair > .sc-element { flex-grow: 1.2; }",
".sc-grid .cl-day { -webkit-line-clamp: 7; }",
".sc-picture .cl-label .story { -webkit-line-clamp: 3; }",
".sc-top { flex: 0 1 auto; min-height: 0; overflow: hidden; }",
".sc-meta { color: var(--smoke); font-style: italic; font-size: calc(var(--k, 1) * clamp(13px,0.92vw,17px)); }",
".sc-title { font-family: var(--cl-display); font-size: calc(var(--k, 1) * clamp(21px,1.6vw,31px)); line-height: 1.18; margin-top: 0.3em; text-wrap: balance;",
"  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }",
".sc-lead { margin-top: 0.55em; font-size: calc(var(--k, 1) * clamp(15px,1.05vw,20px)); line-height: 1.42; text-wrap: pretty;",
"  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }",
".sc-by { color: var(--smoke); font-style: italic; margin-top: 0.4em; font-size: calc(var(--k, 1) * clamp(13px,0.92vw,17px)); }",
".sc-more { color: var(--smoke); font-style: italic; margin-top: 1em; padding-top: 0.7em; border-top: 1px solid var(--rule-2); font-size: calc(var(--k, 1) * clamp(13px,0.92vw,17px)); }",
".sc-list { flex: 1 1 0; display: block; list-style: none; margin: 0.35em 0 0; padding: 0; min-height: 0; overflow: hidden; font-size: calc(var(--k, 1) * clamp(14px,0.98vw,18px)); line-height: 1.32; }",
".sc-list li { margin: 0 0 0.55em; }",
".sc-list li[hidden], .sc-more[hidden] { display: none; }",
".sc-list .cl-link { display: block; }",
".sc-list .t { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }",
".sc-list .s { display: block; color: var(--smoke); font-size: 0.85em; font-variant-caps: small-caps; letter-spacing: 0.04em; }",
".sc-dots { flex: none; padding-top: 0.4em; color: var(--smoke); font-size: calc(var(--k, 1) * clamp(12px,0.85vw,15px)); text-align: right; font-variant-numeric: lining-nums; }",

".sc-element { flex: none; }",
".sc-el { display: flex; gap: 1em; align-items: flex-start; }",
".sc-tile { flex: none; width: calc(var(--k, 1) * clamp(70px,5.4vw,108px)); aspect-ratio: 1; border: 1px solid var(--rule); position: relative;",
"  display: flex; flex-direction: column; justify-content: center; align-items: center; font-variant-numeric: lining-nums; }",
".sc-tile .z { position: absolute; top: 0.3em; left: 0.4em; font-size: calc(var(--k, 1) * clamp(11px,0.8vw,15px)); color: var(--smoke); }",
".sc-tile .sym { font-family: var(--cl-display); font-size: calc(var(--k, 1) * clamp(32px,2.6vw,52px)); line-height: 1; }",
".sc-tile .m { position: absolute; bottom: 0.3em; font-size: calc(var(--k, 1) * clamp(10px,0.72vw,13px)); color: var(--smoke); }",
".sc-info { min-width: 0; font-size: calc(var(--k, 1) * clamp(14px,0.95vw,18px)); line-height: 1.38; }",
".sc-info .name { font-family: var(--cl-display); font-size: calc(var(--k, 1) * clamp(24px,1.9vw,38px)); line-height: 1.1; margin-bottom: 0.2em; overflow-wrap: anywhere; }",
".sc-info .small { color: var(--smoke); font-variant-numeric: lining-nums; }",
".sc-story { margin-top: 0.7em; font-size: calc(var(--k, 1) * clamp(14px,0.98vw,18px)); line-height: 1.42; min-height: 0;",
"  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }",
".sc-table { flex: none; margin: auto auto 0; padding-top: 0.8em; width: min(100%, calc(var(--k, 1) * clamp(140px,10vw,200px)));",
"  display: grid; grid-template-columns: repeat(18, 1fr); grid-template-rows: repeat(7, auto) 0.3em repeat(2, auto); gap: 1px; }",
".sc-table i { display: block; aspect-ratio: 1.3; background: rgba(246,241,231,0.14); }",
".sc-table i.on { background: var(--ivory); box-shadow: 0 0 0 2px rgba(246,241,231,0.35); }",
".cl-high .sc-table i { background: rgba(255,255,255,0.3); }",
".cl-high .sc-table i.on { background: #fff; }"
].join( "\n" );

} )();
