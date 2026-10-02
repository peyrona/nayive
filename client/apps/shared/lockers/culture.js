/*
 * lockers/culture.js - "Salon", the screen locker for people of letters
 * (shared/locker.js; design: docs/culture-locker-plan.md). A triptych of boxes:
 *
 *   left:   the time (the hour and the date in words) · the weather
 *   centre: a masterpiece from a great museum, with its story · on this day
 *   right:  the word of the day (or of the week) · a quote
 *
 * Everything is LIVE, from free sources: Wikidata + Commons + Wikipedia (art,
 * on this day), Wiktionary (words), Wikiquote (quotes), Open-Meteo / MET Norway /
 * wttr.in (weather, the user picks).
 * The Nayive server fetches the Wikimedia pages (GET /api/culture/fetch, one
 * fetch for every user, kept on disk); this file reads them and chooses. What
 * it chose is kept in localStorage, so the screen is never blank offline.
 *
 * LANGUAGES TAKE TURNS: each box shows one of the user's languages at a time
 * and moves to the next one every TURN seconds (the boxes a few seconds apart,
 * so they never all change at once). A language with nothing to say is skipped.
 *
 * EVERY DEVICE SHOWS THE SAME: every choice depends only on the date and the
 * time slot (never on Math.random), so two desktops show the same painting.
 *
 * SETTINGS are PER USER (every device the same): data/salon.json in the
 * user's home, written by the settings dialog (lockers/culture-settings.js,
 * opened from the desktop's "⋮" menu), with a copy in localStorage for when
 * the server cannot be reached. window.NayiveSalon holds what both share.
 */
( function ()
{
"use strict";

var FONTS = ( ( document.currentScript && document.currentScript.src ) || "" ).replace( /[^\/]*$/, "" ) + "../fonts/";

//------------------------------------------------------------------------//
// WORDS - the boxes speak the language they show.

var T =
{
    es: { name: "español", time: "La hora", weather: "El tiempo en {c}", here: "El tiempo aquí", art: "Obra maestra",
          wordDay: "Palabra del día", wordWeek: "Palabra de la semana", quote: "Cita", days: "Tal día como hoy",
          born: "Nace", died: "Muere", unknown: "Autor desconocido",
          wait: "Buscando…", fail: "La fuente no responde ahora.",
          now: "Ahora", tomorrow: "Mañana", feels: "Sensación", wind: "viento", rain: "Prob. de lluvia",
          next: "Las próximas horas", sunrise: "Amanecer", sunset: "atardecer", today: "Hoy",
          sky: [ "Despejado", "Parcialmente nublado", "Nublado", "Niebla", "Llovizna", "Lluvia", "Nieve", "Chubascos", "Tormenta" ] },
    en: { name: "English", time: "The time", weather: "Weather in {c}", here: "Weather here", art: "Masterpiece",
          wordDay: "Word of the day", wordWeek: "Word of the week", quote: "Quote", days: "On this day",
          born: "Born", died: "Died", unknown: "Unknown artist",
          wait: "Fetching…", fail: "The source is not reachable right now.",
          now: "Now", tomorrow: "Tomorrow", feels: "Feels like", wind: "wind", rain: "Chance of rain",
          next: "The next hours", sunrise: "Sunrise", sunset: "sunset", today: "Today",
          sky: [ "Clear", "Partly cloudy", "Cloudy", "Fog", "Drizzle", "Rain", "Snow", "Showers", "Thunderstorm" ] },
    fr: { name: "français", time: "L’heure", weather: "Météo à {c}", here: "Météo ici", art: "Chef-d’œuvre",
          wordDay: "Mot du jour", wordWeek: "Mot de la semaine", quote: "Citation", days: "Ce jour-là",
          born: "Naissance", died: "Décès", unknown: "Artiste inconnu",
          wait: "Recherche…", fail: "La source ne répond pas pour l’instant.",
          now: "Maintenant", tomorrow: "Demain", feels: "Ressenti", wind: "vent", rain: "Risque de pluie",
          next: "Les prochaines heures", sunrise: "Lever du soleil", sunset: "coucher", today: "Aujourd’hui",
          sky: [ "Dégagé", "Partiellement nuageux", "Nuageux", "Brouillard", "Bruine", "Pluie", "Neige", "Averses", "Orage" ] },
    de: { name: "Deutsch", time: "Die Uhrzeit", weather: "Wetter in {c}", here: "Wetter hier", art: "Meisterwerk",
          wordDay: "Wort des Tages", wordWeek: "Wort der Woche", quote: "Zitat", days: "An diesem Tag",
          born: "Geboren", died: "Gestorben", unknown: "Unbekannter Künstler",
          wait: "Wird geladen…", fail: "Die Quelle ist gerade nicht erreichbar.",
          now: "Jetzt", tomorrow: "Morgen", feels: "Gefühlt", wind: "Wind", rain: "Regenrisiko",
          next: "Die nächsten Stunden", sunrise: "Sonnenaufgang", sunset: "Sonnenuntergang", today: "Heute",
          sky: [ "Klar", "Teils bewölkt", "Bewölkt", "Nebel", "Nieselregen", "Regen", "Schnee", "Schauer", "Gewitter" ] },
    pt: { name: "português", time: "As horas", weather: "O tempo em {c}", here: "O tempo aqui", art: "Obra-prima",
          wordDay: "Palavra do dia", wordWeek: "Palavra da semana", quote: "Citação", days: "Neste dia",
          born: "Nasce", died: "Morre", unknown: "Artista desconhecido",
          wait: "A procurar…", fail: "A fonte não responde agora.",
          now: "Agora", tomorrow: "Amanhã", feels: "Sensação", wind: "vento", rain: "Prob. de chuva",
          next: "As próximas horas", sunrise: "Nascer do sol", sunset: "pôr do sol", today: "Hoje",
          sky: [ "Limpo", "Parcialmente nublado", "Nublado", "Nevoeiro", "Chuvisco", "Chuva", "Neve", "Aguaceiros", "Trovoada" ] }
};

//----------------------------------------------------------------------------//
// SETTINGS - shared with the settings dialog (culture-settings.js).

var LANGS = [ "es", "en", "fr", "de", "pt" ];                 // what the boxes can speak
var CARDS = [ "clock", "weather", "art", "days", "word", "quote" ];

// Museum -> its Wikidata collections, in the order the dialog lists them. Some
// museums file their works under a department, not under the museum itself
// (the Louvre has 5 paintings; its Paintings department, 4,708). The counts
// of works with an image and a Wikipedia article were checked 2026-09-30:
// none has fewer than about 50.
var MUSEUMS =
{
    prado:       { name: "Museo del Prado",                     q: [ "Q160112" ] },
    louvre:      { name: "Musée du Louvre",                     q: [ "Q3044768", "Q3044772" ] },   // Paintings, Sculptures
    met:         { name: "Metropolitan Museum of Art",          q: [ "Q160236" ] },
    ngLondon:    { name: "National Gallery (London)",           q: [ "Q180788" ] },
    orsay:       { name: "Musée d’Orsay",                       q: [ "Q23402" ] },
    ngWash:      { name: "National Gallery of Art (Washington)", q: [ "Q214867" ] },
    hermitage:   { name: "Hermitage",                           q: [ "Q132783" ] },
    uffizi:      { name: "Galleria degli Uffizi",               q: [ "Q51252" ] },
    rijks:       { name: "Rijksmuseum",                         q: [ "Q190804" ] },
    khm:         { name: "Kunsthistorisches Museum",            q: [ "Q95569" ] },
    berlin:      { name: "Gemäldegalerie (Berlin)",             q: [ "Q165631" ] },
    munich:      { name: "Pinakotheken (München)",              q: [ "Q812285", "Q154568" ] },
    mnac:        { name: "Museu Nacional d’Art de Catalunya",   q: [ "Q861252" ] },
    chicago:     { name: "Art Institute of Chicago",            q: [ "Q239303" ] },
    lyon:        { name: "Musée des Beaux-Arts de Lyon",        q: [ "Q511" ] },
    brera:       { name: "Pinacoteca di Brera",                 q: [ "Q150066" ] },
    thyssen:     { name: "Museo Thyssen-Bornemisza",            q: [ "Q176251" ] },
    stadel:      { name: "Städel Museum",                       q: [ "Q163804" ] },
    brussels:    { name: "Musées royaux des Beaux-Arts (Bruxelles)", q: [ "Q377500" ] },
    mauritshuis: { name: "Mauritshuis",                         q: [ "Q221092" ] },
    mnaa:        { name: "Museu Nacional de Arte Antiga",       q: [ "Q212459" ] },
    masp:        { name: "MASP (São Paulo)",                    q: [ "Q82941" ] }
};

// Art form -> what the work "is an instance of" on Wikidata.
var FORMS =
{
    painting:  [ "Q3305213" ],                                   // painting
    sculpture: [ "Q860861", "Q179700", "Q241045" ],              // sculpture, statue, bust
    drawing:   [ "Q93184" ]                                      // drawing
};

// Letter sets: [the big words and figures, the text]. All self-hosted (OFL,
// shared/fonts/); a browser only downloads the ones it shows.
var FONT_SETS =
{
    elegant: [ "'Bodoni Moda', Didot, serif", "Literata, Georgia, serif" ],
    classic: [ "'Bodoni Moda', Didot, serif", "'EB Garamond', Garamond, Georgia, serif" ],
    book:    [ "Literata, Georgia, serif", "Literata, Georgia, serif" ],
    clear:   [ "'Atkinson Hyperlegible Next', system-ui, sans-serif", "'Atkinson Hyperlegible Next', system-ui, sans-serif" ],
    system:  [ "var(--font-sans, system-ui), sans-serif", "var(--font-sans, system-ui), sans-serif" ]
};

// Period -> [from, to) years of the work's making.
var PERIODS =
{
    medieval:    [ -5000, 1400 ],
    renaissance: [ 1400, 1600 ],
    baroque:     [ 1600, 1750 ],
    c18:         [ 1750, 1850 ],
    c19:         [ 1850, 1920 ],
    modern:      [ 1920, 3000 ]
};

// Who gives the weather (the settings dialog lets the user pick one). All
// three are free, need no key and answer the browser straight.
var WEATHER =
{
    "open-meteo": { name: "Open-Meteo", url: "https://open-meteo.com/" },
    "met-no":     { name: "MET Norway", url: "https://www.met.no/" },
    "wttr":       { name: "wttr.in",    url: "https://wttr.in/" }
};

var DEFAULTS =
{
    langs:    null,                        // in order of importance; none saved = ALL, see allLangs()
    cards:    {},                          // {clock: {on, langs}, ...}; langs null = all of langs
    artHours: 2,                           // a new masterpiece every N hours
    turn:     180,                         // seconds each language stays in a box: 3, 7, 10 or 15 min
    museums:  [ "prado", "met", "orsay", "rijks" ],
    forms:    [ "painting" ],
    periods:  [],                          // none = any
    place:    "geo",                       // the weather's place: "geo" = where this computer is
                                           // (when the browser may say), else `city`, else the time zone
    city:     null,                        // {name, lat, lon, tz}
    weather:  "open-meteo",                // who gives the weather: a key of WEATHER below
    units:    "c",                         // "c" | "f"
    hours:    24,                          // 24 | 12
    font:     "elegant",                   // FONTS_CSS below: elegant | classic | book | clear | system
    contrast: "normal",                    // "normal" | "high"
    size:     "m",                         // "s" | "m" | "l"
    ipa:      true                         // the word's pronunciation
};

// Every language, the one Nayive speaks to this user first (his rule,
// 2026-09-30: by default all are on).
function allLangs()
{
    var ui = window.NayiveI18n && NayiveI18n.lang ? String( NayiveI18n.lang() ).slice( 0, 2 ) : "";
    return LANGS.indexOf( ui ) >= 0 ? [ ui ].concat( LANGS.filter( function ( l ) { return l !== ui; } ) ) : LANGS.slice();
}

// Anything -> a whole, valid settings object.
function normalise( s )
{
    s = s && typeof s === "object" ? s : {};
    function list( v, ok, dflt )
    {
        var out = [];
        ( Array.isArray( v ) ? v : dflt ).forEach( function ( x ) { if( ok( x ) && out.indexOf( x ) < 0 ) out.push( x ); } );
        return out;
    }
    function one( v, allowed, dflt ) { return allowed.indexOf( v ) >= 0 ? v : dflt; }
    var o = {};
    o.langs = list( s.langs, function ( l ) { return LANGS.indexOf( l ) >= 0; }, allLangs() );
    if( ! o.langs.length ) o.langs = allLangs();
    o.cards = {};
    CARDS.forEach( function ( c )
    {
        var x = s.cards && s.cards[ c ] || {};
        var l = Array.isArray( x.langs ) ? list( x.langs, function ( y ) { return o.langs.indexOf( y ) >= 0; }, [] ) : [];
        // Kept in the order of importance, whatever order they were ticked in.
        l.sort( function ( a, b ) { return o.langs.indexOf( a ) - o.langs.indexOf( b ); } );
        o.cards[ c ] = { on: x.on !== false, langs: l.length ? l : null };
    } );
    o.artHours = one( Number( s.artHours ), [ 1, 2, 4, 8, 24 ], DEFAULTS.artHours );
    o.turn     = one( Number( s.turn ), [ 180, 420, 600, 900 ], DEFAULTS.turn );
    o.museums  = list( s.museums, function ( m ) { return !! MUSEUMS[ m ]; }, DEFAULTS.museums );
    if( ! o.museums.length ) o.museums = DEFAULTS.museums.slice();
    o.forms    = list( s.forms, function ( f ) { return !! FORMS[ f ]; }, DEFAULTS.forms );
    if( ! o.forms.length ) o.forms = DEFAULTS.forms.slice();
    o.periods  = list( s.periods, function ( p ) { return !! PERIODS[ p ]; }, [] );
    if( o.periods.length === Object.keys( PERIODS ).length ) o.periods = [];      // all = any
    var c = s.city;
    o.city = c && typeof c.name === "string" && c.name && isFinite( c.lat ) && isFinite( c.lon )
           ? { name: c.name.slice( 0, 80 ), lat: Number( c.lat ), lon: Number( c.lon ) } : null;
    if( o.city && typeof c.tz === "string" && /^[\w+\-\/]{1,64}$/.test( c.tz ) ) o.city.tz = c.tz;
    o.weather  = one( s.weather, Object.keys( WEATHER ), DEFAULTS.weather );
    o.place    = one( s.place, [ "geo", "city" ], "geo" );
    o.units    = one( s.units, [ "c", "f" ], "c" );
    o.hours    = one( Number( s.hours ), [ 24, 12 ], 24 );
    o.font     = one( s.font, Object.keys( FONT_SETS ), DEFAULTS.font );
    o.contrast = one( s.contrast, [ "normal", "high" ], "normal" );
    o.size     = one( s.size, [ "s", "m", "l" ], "m" );
    o.ipa      = s.ipa !== false;
    return o;
}

var FILE  = "data/salon.json";         // in the user's home
var LOCAL = "nayive-salon";            // this device's copy

function localCopy()
{
    try { return JSON.parse( localStorage.getItem( LOCAL ) || "null" ); } catch ( e ) { return null; }
}
function keepLocal( s ) { try { localStorage.setItem( LOCAL, JSON.stringify( s ) ); } catch ( e ) {} }

// The server's copy, waiting `ms` at most. Never saved (404): the defaults.
// Anything else that is not a good answer - no answer in time, a 5xx, a 401,
// a file that is not JSON - rejects.
function fetchSettings( ms )
{
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout( function () { if( ctl ) ctl.abort(); }, ms );
    return fetch( "/api/files?file=" + encodeURIComponent( FILE ),
                  { credentials: "same-origin", cache: "no-store", signal: ctl ? ctl.signal : undefined } )
        .then( function ( r )
        {
            if( r.status === 404 ) return {};                       // never saved: the defaults
            if( ! r.ok ) throw new Error( "status " + r.status );
            return r.json();
        } )
        .then( function ( s ) { clearTimeout( timer ); s = normalise( s ); keepLocal( s ); return s; },
               function ( e ) { clearTimeout( timer ); throw e; } );
}

// The user's settings, for the locker (and the desktop's weather): the
// server's copy, else this device's, else the defaults - a screen must start.
function read()
{
    return fetchSettings( 4000 ).catch( function () { return normalise( localCopy() ); } );
}

// For the settings dialog: the server's copy, or a rejection whose `local` is
// what read() would show instead. Never that stand-in as the settings: the
// dialog's ✓ would save it over the real ones, on every device (F6). The
// dialog can wait longer than a lock screen.
function readStrict()
{
    return fetchSettings( 10000 ).catch( function ( e )
    {
        var err = new Error( "settings not read: " + ( e && e.message || e ) );
        err.local = normalise( localCopy() );
        throw err;
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

window.NayiveSalon =
{
    LANGS: LANGS, CARDS: CARDS, MUSEUMS: MUSEUMS, FORMS: FORMS, PERIODS: PERIODS, DEFAULTS: DEFAULTS,
    FONT_SETS: FONT_SETS, WEATHER: WEATHER,
    name:      function ( lang ) { return T[ lang ] ? T[ lang ].name : lang; },   // in the language itself
    normalise: normalise,
    faces:     function ()                  // the @font-face rules, for the dialog's preview
    {
        return CSS.split( "\n" ).filter( function ( l ) { return l.indexOf( "@font-face" ) === 0; } ).join( "\n" )
                  .replace( /FONTS\//g, FONTS );
    },
    read:      read,
    readStrict: readStrict,
    write:     write
};

// The locker: the settings first (4 s at most), then the screen.
NayiveLock.define( "culture", function ( host )
{
    var stop = null, gone = false;
    read().then( function ( s ) { if( ! gone ) stop = start( host, s ); } );
    return function () { gone = true; if( stop ) stop(); };
} );


//============================================================================//
// THE ENGINE - what every "learn something" locker shares (Bellas artes here,
// Science in science.js): window.NayiveSalon.engine. Nothing here knows the
// settings or the screen.

// WMO weather code (Open-Meteo) -> index into T[lang].sky.
function skyOf( code )
{
    if( code >= 95 ) return 8;
    if( code >= 80 && code <= 82 ) return 7;
    if( ( code >= 71 && code <= 77 ) || code === 85 || code === 86 ) return 6;
    if( code >= 61 && code <= 67 ) return 5;
    if( code >= 51 && code <= 57 ) return 4;
    if( code === 45 || code === 48 ) return 3;
    if( code === 3 ) return 2;
    if( code === 2 ) return 1;
    return 0;
}

//------------------------------------------------------------------------//
// NUMBERS IN WORDS - the hour and the date, as people say them.

function en( n )
{
    var A = [ "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
              "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen" ];
    var D = [ "", "", "twenty", "thirty", "forty", "fifty" ];
    return n < 20 ? A[ n ] : D[ Math.floor( n / 10 ) ] + ( n % 10 ? "-" + A[ n % 10 ] : "" );
}
function enOrd( n )
{
    var O = [ "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
              "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
              "eighteenth", "nineteenth", "twentieth" ];
    if( n <= 20 ) return O[ n ];
    if( n === 30 ) return "thirtieth";
    return ( n < 30 ? "twenty-" : "thirty-" ) + O[ n % 10 ];
}
function es( n )
{
    var A = [ "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
              "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte",
              "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve" ];
    var D = [ "", "", "", "treinta", "cuarenta", "cincuenta" ];
    return n < 30 ? A[ n ] : D[ Math.floor( n / 10 ) ] + ( n % 10 ? " y " + A[ n % 10 ] : "" );
}
function fr( n, fem )
{
    var A = [ "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
              "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf" ];
    var D = [ "", "", "vingt", "trente", "quarante", "cinquante" ];
    var s = n < 20 ? A[ n ] : D[ Math.floor( n / 10 ) ] + ( n % 10 === 1 ? " et un" : n % 10 ? "-" + A[ n % 10 ] : "" );
    return fem ? s.replace( /\bun$/, "une" ) : s;
}
var DE = [ "null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn",
           "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn" ];
function de( n, one )
{
    var D = [ "", "", "zwanzig", "dreißig", "vierzig", "fünfzig" ];
    if( n === 1 && one ) return one;
    if( n < 20 ) return DE[ n ];
    var u = n % 10;
    return u ? ( u === 1 ? "ein" : DE[ u ] ) + "und" + D[ Math.floor( n / 10 ) ] : D[ Math.floor( n / 10 ) ];
}
function deOrd( n )
{
    var S = { 1: "erste", 3: "dritte", 7: "siebte", 8: "achte" };
    return n < 20 ? S[ n ] || DE[ n ] + "te" : de( n ) + "ste";
}
function pt( n, fem )
{
    var A = [ "zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez",
              "onze", "doze", "treze", "catorze", "quinze", "dezasseis", "dezassete", "dezoito", "dezanove" ];
    var D = [ "", "", "vinte", "trinta", "quarenta", "cinquenta" ];
    var s = n < 20 ? A[ n ] : D[ Math.floor( n / 10 ) ] + ( n % 10 ? " e " + A[ n % 10 ] : "" );
    return fem ? s.replace( /\bum$/, "uma" ).replace( /\bdois$/, "duas" ) : s;
}

// The hour: H = 0..23, h = 1..12, m = 0..59.
var SAY =
{
    en: function ( H, h, m )
    {
        var nx = h % 12 + 1;
        if( m === 0 ) return H === 0 ? "It is midnight." : H === 12 ? "It is noon." : "It is " + en( h ) + " o’clock.";
        if( m === 15 ) return "It is a quarter past " + en( h ) + ".";
        if( m === 30 ) return "It is half past " + en( h ) + ".";
        if( m === 45 ) return "It is a quarter to " + en( nx ) + ".";
        var r = m < 30 ? m : 60 - m;
        var mins = r === 1 ? " minute" : r % 5 ? " minutes" : "";
        return "It is " + en( r ) + mins + ( m < 30 ? " past " + en( h ) : " to " + en( nx ) ) + ".";
    },
    es: function ( H, h, m )
    {
        var hour = function ( x ) { return x === 1 ? "Es la una" : "Son las " + es( x ); };
        if( m === 0 )  return hour( h ) + " en punto.";
        if( m === 15 ) return hour( h ) + " y cuarto.";
        if( m === 30 ) return hour( h ) + " y media.";
        if( m < 30 || m % 5 ) return hour( h ) + " y " + es( m ) + ".";
        return hour( h % 12 + 1 ) + " menos " + ( m === 45 ? "cuarto" : es( 60 - m ) ) + ".";
    },
    fr: function ( H, h, m )
    {
        function hour( x, H24 )
        {
            if( x === 12 ) return H24 === 12 || H24 === 11 ? "midi" : "minuit";
            return x === 1 ? "une heure" : fr( x ) + " heures";
        }
        var hh = hour( h, H ), mid = hh === "midi" || hh === "minuit";
        if( m === 0 )  return "Il est " + hh + ".";
        if( m === 15 ) return "Il est " + hh + " et quart.";
        if( m === 30 ) return "Il est " + hh + " et demi" + ( mid ? "" : "e" ) + ".";
        if( m > 30 && m % 5 === 0 )
            return "Il est " + hour( h % 12 + 1, H ) + " moins " + ( m === 45 ? "le quart" : fr( 60 - m ) ) + ".";
        return "Il est " + hh + " " + fr( m, true ) + ".";
    },
    de: function ( H, h, m )
    {
        var nx = h % 12 + 1;
        if( m === 0 )  return "Es ist " + de( h, "ein" ) + " Uhr.";
        if( m === 15 ) return "Es ist Viertel nach " + de( h ) + ".";
        if( m === 30 ) return "Es ist halb " + de( nx ) + ".";
        if( m === 45 ) return "Es ist Viertel vor " + de( nx ) + ".";
        return "Es ist " + de( h, "ein" ) + " Uhr " + de( m ) + ".";
    },
    pt: function ( H, h, m )
    {
        function hour( x, H24 )
        {
            if( x === 12 ) return H24 === 12 || H24 === 11 ? "É meio-dia" : "É meia-noite";
            return x === 1 ? "É uma" : "São " + pt( x, true );
        }
        if( m === 0 )  return hour( h, H ) + ( h === 12 ? "." : " em ponto." );
        if( m === 15 ) return hour( h, H ) + " e um quarto.";
        if( m === 30 ) return hour( h, H ) + " e meia.";
        if( m > 30 && m % 5 === 0 )
            return hour( h % 12 + 1, H ) + " menos " + ( m === 45 ? "um quarto" : pt( 60 - m ) ) + ".";
        return hour( h, H ) + " e " + pt( m ) + ".";
    }
};

// The date: weekday and month from the browser, the day in words.
function dateWords( lang, d )
{
    var wd = new Intl.DateTimeFormat( lang, { weekday: "long" } ).format( d );
    var mo = new Intl.DateTimeFormat( lang, { month: "long" } ).format( d ).toLowerCase();
    var n = d.getDate();
    switch( lang )
    {
        case "en": return cap( wd ) + ", the " + enOrd( n ) + " of " + cap( mo );
        case "es": return wd + ", " + es( n ) + " de " + mo;
        case "fr": return wd + " " + ( n === 1 ? "premier" : fr( n ) ) + " " + mo;
        case "de": return wd + ", der " + deOrd( n ) + " " + cap( mo );
        case "pt": return wd + ", " + ( n === 1 ? "primeiro" : pt( n ) ) + " de " + mo;
    }
    return "";
}

//------------------------------------------------------------------------//
// TIME HELPERS

function pad( n ) { return n < 10 ? "0" + n : "" + n; }
function ymd( d ) { return d.getFullYear() + "-" + pad( d.getMonth() + 1 ) + "-" + pad( d.getDate() ); }
function dayNo( d ) { return Math.floor( ( d - d.getTimezoneOffset() * 6e4 ) / 864e5 ); }
function daysAgo( d, n ) { var x = new Date( d ); x.setDate( x.getDate() - n ); return x; }
function isoWeek( d )
{
    var t = new Date( Date.UTC( d.getFullYear(), d.getMonth(), d.getDate() ) );
    var wd = t.getUTCDay() || 7;
    t.setUTCDate( t.getUTCDate() + 4 - wd );
    var y0 = new Date( Date.UTC( t.getUTCFullYear(), 0, 1 ) );
    return { year: t.getUTCFullYear(), week: Math.ceil( ( ( t - y0 ) / 864e5 + 1 ) / 7 ) };
}
function cap( s ) { return s ? s.charAt( 0 ).toUpperCase() + s.slice( 1 ) : s; }

//------------------------------------------------------------------------//
// DATA - the server's cached fetch, then our own cache in localStorage of
// what was chosen (small). A failed load falls back to the last good copy.
// store( "nv-culture:" ) -> cached( key, ttl ms, get ): each locker its own prefix.

function store( prefix )
{
    // Our copies of past days are of no more use after a week.
    try
    {
        for( var i = localStorage.length - 1; i >= 0; i-- )
        {
            var k = localStorage.key( i );
            if( ! k || k.indexOf( prefix ) ) continue;
            var v = JSON.parse( localStorage.getItem( k ) || "null" );
            if( ! v || Date.now() - v.t > 8 * 864e5 ) localStorage.removeItem( k );
        }
    }
    catch ( e ) {}

    return function cached( key, ttl, get )
    {
        var old = null;
        try { old = JSON.parse( localStorage.getItem( prefix + key ) || "null" ); } catch ( e ) {}
        if( old && Date.now() - old.t < ttl ) return Promise.resolve( old.v );
        return get().then( function ( v )
        {
            try { localStorage.setItem( prefix + key, JSON.stringify( { t: Date.now(), v: v } ) ); } catch ( e ) {}
            return v;
        }, function ( err ) { if( old ) return old.v; throw err; } );
    };
}

// Through the server (it keeps the answer `ttl` seconds for everyone).
function src( url, ttl, asText )
{
    return fetch( "/api/culture/fetch?u=" + encodeURIComponent( url ) + "&ttl=" + ttl, { credentials: "same-origin" } )
        .then( function ( r )
        {
            if( ! r.ok ) throw new Error( "status " + r.status );
            return asText ? r.text() : r.json();
        } );
}
function wapi( host, params, ttl )
{
    var q = "action=parse&format=json&formatversion=2&disablelimitreport=1";
    for( var k in params ) q += "&" + k + "=" + encodeURIComponent( params[ k ] );
    return src( "https://" + host + "/w/api.php?" + q, ttl );
}
// A page, rendered: its HTML as a document (null when it does not exist).
function page( host, title, ttl )
{
    return wapi( host, { page: title, prop: "text" }, ttl ).then( function ( d )
    {
        if( ! d.parse ) return null;
        return new DOMParser().parseFromString( d.parse.text, "text/html" );
    } );
}
// A page's wikitext ("" when it does not exist).
function wikitext( host, title, ttl )
{
    return wapi( host, { page: title, prop: "wikitext" }, ttl ).then( function ( d )
    {
        return d.parse ? d.parse.wikitext : "";
    } );
}
function sparql( q, ttl )
{
    return src( "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent( q ), ttl )
        .then( function ( d ) { return d.results.bindings; } );
}
function clean( el ) { return el ? el.textContent.replace( /\s+/g, " " ).trim() : ""; }
function v( b, k ) { return b[ k ] ? b[ k ].value : ""; }
function qid( uri ) { return uri.replace( /^.*\//, "" ); }
function year( s ) { var m = /^(-?\d{1,4})/.exec( s || "" ); return m ? String( Number( m[ 1 ] ) ) : ""; }

//------------------------------------------------------------------------//
// WIKITEXT - just enough of it for the quote templates.

// Every {{name|...}} in `src` (name matched without case), as its list of
// parameters: {1: .., 2: .., text: ..} - split on the top-level "|" only.
function templates( s, name )
{
    var out = [], low = s.toLowerCase(), key = "{{" + name.toLowerCase(), at = 0;
    while( ( at = low.indexOf( key, at ) ) >= 0 )
    {
        var i = at + key.length, depth = 0, parts = [], cur = "";
        if( ! /[\s|}]/.test( s.charAt( i ) ) ) { at = i; continue; }
        for( ; i < s.length; i++ )
        {
            var two = s.substr( i, 2 );
            if( two === "{{" || two === "[[" ) { depth++; cur += two; i++; continue; }
            if( two === "]]" ) { depth--; cur += two; i++; continue; }
            if( two === "}}" )
            {
                if( depth === 0 ) break;
                depth--; cur += two; i++; continue;
            }
            if( s.charAt( i ) === "|" && depth === 0 ) { parts.push( cur ); cur = ""; continue; }
            cur += s.charAt( i );
        }
        parts.push( cur );
        var p = {}, n = 0;
        parts.slice( 1 ).forEach( function ( x )
        {
            var m = /^\s*([^=\[\]{}]+?)\s*=([\s\S]*)$/.exec( x );
            if( m ) p[ m[ 1 ].toLowerCase() ] = m[ 2 ].trim();
            else p[ ++n ] = x.trim();
        } );
        out.push( p );
        at = i;
    }
    return out;
}

// Wikitext -> plain text. Line breaks stay as "\n".
var decoder = document.createElement( "textarea" );
function plain( s )
{
    s = String( s || "" )
        .replace( /<!--[\s\S]*?-->/g, "" )
        .replace( /\{\{\s*Versalien\s*\|\s*([^}|]*)\}\}/gi, "$1" )
        .replace( /<br\s*\/?>/gi, "\n" )
        .replace( /\s+\/\/\s+/g, "\n" );
    for( var k = 0; k < 5 && /\{\{/.test( s ); k++ ) s = s.replace( /\{\{[^{}]*\}\}/g, "" );
    s = s.replace( /\[\[(?:File|Image|Datei|Fichier|Imagem|Archivo|Arquivo):[^\]]*\]\]/gi, "" )
         .replace( /\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1" )
         .replace( /\[\[([^\]]*)\]\]/g, "$1" )
         .replace( /\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1" )
         .replace( /\[https?:\/\/[^\]]*\]/g, "" )
         .replace( /'''?/g, "" )
         .replace( /<[^>]+>/g, "" );
    decoder.innerHTML = s;
    return decoder.value.replace( /[ \t]+/g, " " ).replace( / *\n */g, "\n" ).trim();
}

// The artists' on-this-day lists (Bellas artes).
//------------------------------------------------------------------------//
// ON THIS DAY - births and deaths of people with one of the occupations
// `occ` (and none of `notOcc`), ranked by fame (how many Wikipedias have
// them). [{year, kind, text}]

var ARTS_OCC = [ "Q36180", "Q49757", "Q6625963", "Q214917", "Q1028181", "Q1281618", "Q36834", "Q5716684",
                 "Q2490358", "Q42973", "Q33231", "Q2526255", "Q4964182", "Q158852", "Q2865819", "Q11774202" ];
// writer, poet, novelist, playwright, painter, sculptor, composer, dancer, choreographer,
// architect, photographer, film director, philosopher, conductor, opera singer, essayist
// ...but not the statesmen who also wrote: politician, statesperson, monarch, military officer.
var NOT_OCC = [ "Q82955", "Q372436", "Q116", "Q189290" ];

function onThisDay( cached, lang, d, occ, notOcc )
{
    return cached( "days:" + lang + ":" + ymd( d ), 864e5, function ()
    {
        var mmdd = pad( d.getMonth() + 1 ) + "/" + pad( d.getDate() );
        return src( "https://" + lang + ".wikipedia.org/api/rest_v1/feed/onthisday/all/" + mmdd, 30 * 86400 ).then( function ( f )
        {
            var byId = {};
            [ [ "births", "b" ], [ "deaths", "d" ] ].forEach( function ( k )
            {
                ( f[ k[ 0 ] ] || [] ).forEach( function ( e )
                {
                    var p = e.pages && e.pages[ 0 ], id = p && p.wikibase_item;
                    if( id && e.text && e.year != null && ! byId[ id ] )
                        byId[ id ] = { year: e.year, kind: k[ 1 ], text: e.text,
                                       url: p.content_urls && p.content_urls.desktop ? p.content_urls.desktop.page
                                          : "https://" + lang + ".wikipedia.org/wiki/" + encodeURIComponent( String( p.title ).replace( / /g, "_" ) ) };
                } );
            } );
            var ids = Object.keys( byId ), chunks = [];
            for( var i = 0; i < ids.length; i += 200 ) chunks.push( ids.slice( i, i + 200 ) );
            return Promise.all( chunks.map( function ( c )
            {
                return sparql( "SELECT ?p (COUNT(DISTINCT ?sl) AS ?n) WHERE {" +
                               " VALUES ?p { wd:" + c.join( " wd:" ) + " }" +
                               " VALUES ?occ { wd:" + occ.join( " wd:" ) + " }" +
                               " ?p wdt:P106 ?occ. ?sl schema:about ?p." +
                               " FILTER NOT EXISTS { ?p wdt:P106 ?no. VALUES ?no { wd:" + notOcc.join( " wd:" ) + " } }" +
                               " } GROUP BY ?p", 30 * 86400 );
            } ) ).then( function ( parts )
            {
                var ranked = [];
                parts.forEach( function ( rows ) { rows.forEach( function ( b ) { ranked.push( { id: qid( v( b, "p" ) ), n: Number( v( b, "n" ) ) } ); } ); } );
                ranked.sort( function ( a, b ) { return b.n - a.n; } );
                var out = ranked.slice( 0, 24 ).map( function ( r ) { return byId[ r.id ]; } );
                if( ! out.length ) throw new Error( "nobody" );
                return out;
            } );
        } );
    } );
}

// A thing's story in one language: the start of its Wikipedia article.
function story( cached, lang, title )
{
    return cached( "story:" + lang + ":" + title, 30 * 864e5, function ()
    {
        return src( "https://" + lang + ".wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent( title.replace( / /g, "_" ) ),
                    30 * 86400 ).then( function ( s ) { return s.extract || ""; } );
    } );
}

//------------------------------------------------------------------------//
// WEATHER - the place from the account's time zone (Nayive's tz-geo.json),
// Open-Meteo straight from the browser (1 call per 30 min).

// Where the weather is for: this computer's position when the browser may
// tell it (the permission is asked in the settings dialog, never on the
// lock screen), else the city chosen there, else the account's time zone.
function placeOf( cfg, cached )
{
    var here = cfg.place === "geo" && navigator.geolocation && navigator.permissions
        ? navigator.permissions.query( { name: "geolocation" } ).then( function ( p )
          {
              if( p.state !== "granted" ) return null;
              return new Promise( function ( ok ) {
                  navigator.geolocation.getCurrentPosition(
                      function ( g ) { ok( { lat: Math.round( g.coords.latitude * 100 ) / 100,      // ~1 km: enough,
                                             lon: Math.round( g.coords.longitude * 100 ) / 100 } ); }, // and kinder to the cache
                      function () { ok( null ); },
                      { maximumAge: 30 * 6e4, timeout: 15000 } );
              } );
          } ).catch( function () { return null; } )
        : Promise.resolve( null );
    return here.then( function ( pos )
    {
        if( pos ) return cached( "town:" + pos.lat + "," + pos.lon, 30 * 864e5, function ()
        {
            return window.NayiveUI && NayiveUI.townName
                ? NayiveUI.townName( pos.lat, pos.lon ).then( function ( n ) { if( ! n ) throw new Error( "no name" ); return n; } )
                : Promise.reject( new Error( "no NayiveUI" ) );
        } ).catch( function () { return ""; } ).then( function ( name ) { return { name: name, lat: pos.lat, lon: pos.lon, tz: myTz() }; } );
        if( cfg.city ) return { name: cfg.city.name, lat: cfg.city.lat, lon: cfg.city.lon, tz: cfg.city.tz || myTz() };
        return tzPlace( cached );
    } );
}

function tzPlace( cached )
{
    return fetch( "/api/tz", { credentials: "same-origin" } )
        .then( function ( r ) { return r.ok ? r.json() : {}; }, function () { return {}; } )
        .then( function ( j )
        {
            var tz = j && j.tz;
            tz = tz || myTz();
            return cached( "place:" + tz, 30 * 864e5, function ()
            {
                return fetch( FONTS + "../tz-geo.json" ).then( function ( r ) { return r.json(); } ).then( function ( g )
                {
                    var p = g[ tz ];
                    if( ! p ) throw new Error( "no place" );
                    return { name: tz.split( "/" ).pop().replace( /_/g, " " ), lat: p[ 0 ], lon: p[ 1 ], tz: tz };
                } );
            } );
        } );
}

// Every provider's answer comes out the way Open-Meteo gives it (the screens
// read only that): place-local "YYYY-MM-DDTHH:MM" times, one hourly entry per
// hour, WMO codes, °C/km/h or °F/mph.
function weatherAt( cached, p, units, who )
{
    who = WEATHER[ who ] ? who : "open-meteo";
    var tz = p.tz || myTz();
    return cached( "weather:" + who + ":" + p.lat + "," + p.lon + ":" + units, 30 * 6e4, function ()
    {
        if( who === "met-no" ) return getJson( "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" + p.lat + "&lon=" + p.lon )
                                     .then( function ( j ) { return fromMet( j, p, tz, units ); } );
        if( who === "wttr" )   return getJson( "https://wttr.in/" + p.lat + "," + p.lon + "?format=j1" )
                                     .then( function ( j ) { return fromWttr( j, tz, units ); } );
        return getJson( "https://api.open-meteo.com/v1/forecast?latitude=" + p.lat + "&longitude=" + p.lon +
                        "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day" +
                        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
                        "&hourly=temperature_2m,weather_code&timezone=auto&forecast_days=2" +
                        ( units === "f" ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "" ) );
    } );
}

function getJson( url )
{
    return fetch( url ).then( function ( r ) { if( ! r.ok ) throw new Error( r.status ); return r.json(); } );
}

function myTz()
{
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Madrid"; } catch ( e ) { return "Europe/Madrid"; }
}

// A moment (ms) -> "YYYY-MM-DDTHH:MM" on the clocks of time zone `tz`.
function localIso( ms, tz )
{
    var o = {};
    new Intl.DateTimeFormat( "en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
                                        hour: "2-digit", minute: "2-digit", hourCycle: "h23" } )
        .formatToParts( new Date( ms ) ).forEach( function ( x ) { o[ x.type ] = x.value; } );
    return o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute;
}

// wttr.in (WorldWeatherOnline codes): 3 days in steps of 3 hours, local times.
var WWO = { 113: 0, 116: 2, 119: 3, 122: 3, 143: 45, 248: 45, 260: 45,
            176: 61, 263: 51, 266: 53, 281: 56, 284: 57, 293: 61, 296: 61, 299: 63, 302: 63, 305: 65, 308: 65,
            311: 66, 314: 67, 317: 67, 320: 73, 350: 77, 353: 80, 356: 81, 359: 82, 362: 80, 365: 81,
            179: 71, 182: 67, 185: 56, 227: 75, 230: 75, 323: 71, 326: 71, 329: 73, 332: 73, 335: 75, 338: 75,
            368: 85, 371: 86, 374: 80, 377: 81, 200: 95, 386: 95, 389: 95, 392: 95, 395: 95 };
function fromWttr( j, tz, units )
{
    var f = units === "f", c = j.current_condition[ 0 ];
    var w = { current: { time: localIso( Date.now(), tz ), temperature_2m: + ( f ? c.temp_F : c.temp_C ),
                         apparent_temperature: + ( f ? c.FeelsLikeF : c.FeelsLikeC ),
                         weather_code: wmoOf( c.weatherCode ), wind_speed_10m: + ( f ? c.windspeedMiles : c.windspeedKmph ) },
              daily:  { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [],
                        precipitation_probability_max: [], sunrise: [], sunset: [] },
              hourly: { time: [], temperature_2m: [], weather_code: [] } };
    function wmoOf( code ) { var k = WWO[ +code ]; return k == null ? 0 : k; }
    function at( day, hhmm )                          // "08:14 AM" -> "YYYY-MM-DDT08:14"
    {
        var m = /^(\d+):(\d+)\s*(AM|PM)$/i.exec( hhmm || "" );
        if( ! m ) return "";
        var h = +m[ 1 ] % 12 + ( /pm/i.test( m[ 3 ] ) ? 12 : 0 );
        return day + "T" + pad( h ) + ":" + m[ 2 ];
    }
    j.weather.forEach( function ( d )
    {
        var noon = d.hourly.filter( function ( x ) { return +x.time === 1200; } )[ 0 ] || d.hourly[ 0 ];
        w.daily.time.push( d.date );
        w.daily.weather_code.push( wmoOf( noon.weatherCode ) );
        w.daily.temperature_2m_max.push( + ( f ? d.maxtempF : d.maxtempC ) );
        w.daily.temperature_2m_min.push( + ( f ? d.mintempF : d.mintempC ) );
        w.daily.precipitation_probability_max.push( Math.max.apply( null, d.hourly.map( function ( x ) { return +x.chanceofrain || 0; } ) ) );
        w.daily.sunrise.push( at( d.date, d.astronomy[ 0 ].sunrise ) );
        w.daily.sunset.push( at( d.date, d.astronomy[ 0 ].sunset ) );
        d.hourly.forEach( function ( x )             // each 3-hour block fills its 3 hours
        {
            for( var k = 0; k < 3; k++ )
            {
                w.hourly.time.push( d.date + "T" + pad( +x.time / 100 + k ) + ":00" );
                w.hourly.temperature_2m.push( + ( f ? x.tempF : x.tempC ) );
                w.hourly.weather_code.push( wmoOf( x.weatherCode ) );
            }
        } );
    } );
    return w;
}

// MET Norway (yr.no): UTC, °C, m/s, symbol names, no sunrise - the Sun's
// times are worked out here (one call less).
var MET = { clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
            lightrain: 61, rain: 63, heavyrain: 65, lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
            lightsleet: 67, sleet: 67, heavysleet: 67, lightsleetshowers: 85, sleetshowers: 85, heavysleetshowers: 86,
            lightsnow: 71, snow: 73, heavysnow: 75, lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86 };
function fromMet( j, p, tz, units )
{
    var f = units === "f";
    function temp( c ) { return f ? c * 9 / 5 + 32 : c; }
    function wmoOf( sym )
    {
        sym = String( sym || "" ).replace( /_(day|night|polartwilight)$/, "" );
        if( /thunder/.test( sym ) ) return 95;
        var k = MET[ sym ];
        return k == null ? 0 : k;
    }
    var w = { current: null,
              daily:  { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [],
                        precipitation_probability_max: [], sunrise: [], sunset: [] },
              hourly: { time: [], temperature_2m: [], weather_code: [] } };
    var days = {};
    j.properties.timeseries.forEach( function ( x )
    {
        var d = x.data, n1 = d.next_1_hours;
        if( ! n1 ) return;                            // past the hourly part
        var t = localIso( Date.parse( x.time ), tz ), c = d.instant.details;
        var code = wmoOf( n1.summary.symbol_code );
        if( ! w.current ) w.current = { time: localIso( Date.now(), tz ), temperature_2m: temp( c.air_temperature ),
                                        apparent_temperature: temp( c.air_temperature ),
                                        weather_code: code, wind_speed_10m: c.wind_speed * ( f ? 2.23694 : 3.6 ) };
        w.hourly.time.push( t );
        w.hourly.temperature_2m.push( temp( c.air_temperature ) );
        w.hourly.weather_code.push( code );
        var day = t.slice( 0, 10 ), o = days[ day ] || ( days[ day ] = { max: -1e9, min: 1e9, code: code } );
        o.max = Math.max( o.max, temp( c.air_temperature ) );
        o.min = Math.min( o.min, temp( c.air_temperature ) );
        if( t.slice( 11, 13 ) === "12" ) o.code = code;
    } );
    if( ! w.current ) throw new Error( "no forecast" );
    Object.keys( days ).sort().slice( 0, 2 ).forEach( function ( day )
    {
        var o = days[ day ], s = sunOf( day, p.lat, p.lon );
        w.daily.time.push( day );
        w.daily.weather_code.push( o.code );
        w.daily.temperature_2m_max.push( o.max );
        w.daily.temperature_2m_min.push( o.min );
        w.daily.precipitation_probability_max.push( null );
        w.daily.sunrise.push( s ? localIso( s[ 0 ], tz ) : "" );
        w.daily.sunset.push( s ? localIso( s[ 1 ], tz ) : "" );
    } );
    return w;
}

// Sunrise and sunset (ms) on day "YYYY-MM-DD" at lat/lon - the sunrise
// equation, good to a minute or two; null when the Sun does not rise or set.
function sunOf( day, lat, lon )
{
    var rad = Math.PI / 180;
    var n = Math.round( Date.UTC( +day.slice( 0, 4 ), +day.slice( 5, 7 ) - 1, +day.slice( 8, 10 ), 12 ) / 864e5 + 2440587.5 - 2451545 );
    var js = n - lon / 360;
    var M = ( 357.5291 + 0.98560028 * js ) % 360;
    var C = 1.9148 * Math.sin( M * rad ) + 0.02 * Math.sin( 2 * M * rad ) + 0.0003 * Math.sin( 3 * M * rad );
    var L = ( M + C + 180 + 102.9372 ) % 360;
    var jt = 2451545 + js + 0.0053 * Math.sin( M * rad ) - 0.0069 * Math.sin( 2 * L * rad );
    var sd = Math.sin( L * rad ) * Math.sin( 23.4397 * rad ), cd = Math.cos( Math.asin( sd ) );
    var cw = ( Math.sin( -0.833 * rad ) - Math.sin( lat * rad ) * sd ) / ( Math.cos( lat * rad ) * cd );
    if( cw < -1 || cw > 1 ) return null;
    var w = Math.acos( cw ) / rad / 360;
    function ms( jd ) { return ( jd - 2440587.5 ) * 864e5; }
    return [ ms( jt - w ), ms( jt + w ) ];
}

//------------------------------------------------------------------------//
// THE SCREEN'S BRICKS

function el( tag, cls, text, parent )
{
    var e = document.createElement( tag );
    if( cls ) e.className = cls;
    if( text != null ) e.textContent = text;
    if( parent ) parent.appendChild( e );
    return e;
}
function deg( n ) { n = Math.round( n ); return ( n < 0 ? "−" + ( -n ) : n ) + "°"; }

// Makes `node` (already in its parent) a link that opens `url` in a new tab
// of the browser - http(s) only. A press on a link does not bring up the
// password box (locker.js); the lock itself stays.
function linkTo( node, url )
{
    if( ! node || ! node.parentNode || ! /^https?:\/\/[^\s]+$/i.test( url || "" ) ) return node;
    var a = document.createElement( "a" );
    a.className = "cl-link";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    node.parentNode.replaceChild( a, node );
    a.appendChild( node );
    return node;
}
function wiki( host, title ) { return "https://" + host + "/wiki/" + encodeURIComponent( String( title ).replace( / /g, "_" ) ); }

window.NayiveSalon.engine =
{
    T: T, FONTS: FONTS, skyOf: skyOf, SAY: SAY, dateWords: dateWords,
    pad: pad, ymd: ymd, dayNo: dayNo, daysAgo: daysAgo, isoWeek: isoWeek, cap: cap,
    store: store, src: src, page: page, wikitext: wikitext, sparql: sparql,
    clean: clean, v: v, qid: qid, year: year, plain: plain, templates: templates,
    onThisDay: onThisDay, story: story, placeOf: placeOf, weatherAt: weatherAt,
    el: el, deg: deg, linkTo: linkTo, wiki: wiki,
    css: function () { return CSS.replace( /FONTS\//g, FONTS ); }   // the fonts and the boxes (.cl-*)
};


function start( host, cfg )
{
    var TURN = cfg.turn;                                   // seconds each language stays
    var OFFSET = { clock: 0, art: 12, word: 24, quote: 36, days: 48 };   // ...and when each box turns

    function langsOf( card )
    {
        var c = cfg.cards[ card ];
        return c && c.langs ? c.langs : cfg.langs;
    }

    // The shared engine, bound to this locker's cache and settings.
    var cached = store( "nv-culture:" );
    var alive = true;
    function getDays( lang, d )   { return onThisDay( cached, lang, d, ARTS_OCC, NOT_OCC ); }
    function getStory( lang, t )  { return story( cached, lang, t ); }
    function getPlace()           { return placeOf( cfg, cached ); }
    function getWeather( p )      { return weatherAt( cached, p, cfg.units, cfg.weather ); }






    //------------------------------------------------------------------------//
    // THE WORD - {word, pos, ipa, defs[], etym, weekly}

    var WORDS =
    {
        en: function ( d )
        {
            var M = [ "January", "February", "March", "April", "May", "June", "July", "August",
                      "September", "October", "November", "December" ];
            var title = "Wiktionary:Word of the day/" + d.getFullYear() + "/" + M[ d.getMonth() ] + " " + d.getDate();
            return page( "en.wiktionary.org", title, 7 * 86400 ).then( function ( doc )
            {
                var t = doc && doc.getElementById( "WOTD-rss-title" );
                if( ! t ) throw new Error( "no word" );
                var w = { word: clean( t ), pos: "", defs: [], weekly: false };
                var td = t.closest( "td" ) || t.parentNode;
                var i = td && td.querySelector( "i" );
                if( i ) w.pos = clean( i );
                var desc = doc.getElementById( "WOTD-rss-description" );
                if( desc ) w.defs = [].slice.call( desc.querySelectorAll( "ol > li" ) ).slice( 0, 2 ).map( function ( li )
                {
                    li = li.cloneNode( true );
                    [].forEach.call( li.querySelectorAll( "ul, ol, dl" ), function ( x ) { x.remove(); } );
                    return clean( li );
                } );
                // Its own entry: the pronunciation and where it comes from.
                return src( "https://en.wiktionary.org/api/rest_v1/page/html/" + encodeURIComponent( w.word.replace( / /g, "_" ) ),
                            30 * 86400, true ).then( function ( html )
                {
                    var p = new DOMParser().parseFromString( html, "text/html" );
                    var h = p.getElementById( "English" ), sec = h && h.closest( "section" );
                    if( sec )
                    {
                        var ipa = sec.querySelector( ".IPA" );
                        if( ipa ) w.ipa = clean( ipa );
                        var eh = sec.querySelector( "[id^=Etymology]" ), es_ = eh && eh.closest( "section" );
                        var para = es_ && es_.querySelector( "p" );
                        if( para ) { [].forEach.call( para.querySelectorAll( "sup" ), function ( x ) { x.remove(); } ); w.etym = clean( para ); }
                    }
                    return w;
                }, function () { return w; } );
            } );
        },

        // Written the night before, around 21:00 UTC: if today's is not there
        // yet, yesterday's.
        fr: function ( d )
        {
            function one( k )
            {
                var x = daysAgo( d, k );
                return page( "fr.wiktionary.org", "Modèle:Entrée du jour/" + x.getFullYear() + "/" + pad( x.getMonth() + 1 ) + "/" + pad( x.getDate() ),
                             k ? 7 * 86400 : 3600 ).then( function ( doc )
                {
                    var b = doc && doc.querySelector( "p b" );
                    if( ! b ) return k < 2 ? one( k + 1 ) : Promise.reject( new Error( "no word" ) );
                    var p = b.closest( "p" ), w = { word: clean( b ), defs: [], weekly: false };
                    var ipa = p.querySelector( ".API" );
                    if( ipa ) w.ipa = clean( ipa );
                    var m = /—\s*([^\\\/]+?)\s*(?:\\|$)/.exec( clean( p ) );
                    if( m ) w.pos = m[ 1 ];
                    var g = p.querySelector( ".ligne-de-forme" );
                    if( g ) w.pos = ( w.pos ? w.pos + ", " : "" ) + clean( g );
                    w.defs = [].slice.call( doc.querySelectorAll( "ol > li" ) ).slice( 0, 2 ).map( function ( li )
                    {
                        li = li.cloneNode( true );
                        [].forEach.call( li.querySelectorAll( "ul, ol, dl" ), function ( x ) { x.remove(); } );
                        return clean( li );
                    } );
                    return w;
                } );
            }
            return one( 0 );
        },

        es: function ( d )
        {
            return page( "es.wiktionary.org", "Plantilla:palabra de la semana/" + isoWeek( d ).week, 86400 ).then( function ( doc )
            {
                var h = doc && doc.querySelector( "h3" );
                if( ! h ) throw new Error( "no word" );
                var w = { word: clean( h ), defs: [], weekly: true };
                var sp = doc.querySelector( "p span" );
                if( sp && /^→/.test( clean( sp ) ) ) w.etym = clean( sp ).replace( /^→\s*/, "" );
                [].forEach.call( doc.querySelectorAll( "dl" ), function ( dl )
                {
                    var dt = dl.querySelector( "dt" ), dd = dl.querySelector( "dd" );
                    if( dd && w.defs.length < 2 )
                    {
                        var c = clean( dt ).replace( /^\d+\s*/, "" );
                        w.defs.push( ( c ? c + ": " : "" ) + clean( dd ) );
                    }
                } );
                return w;
            } );
        },

        de: function ( d )
        {
            return page( "de.wiktionary.org", "Vorlage:Hauptseite Wort der Woche/" + isoWeek( d ).week, 86400 ).then( function ( doc )
            {
                var a = doc && doc.querySelector( "big a, big" );
                if( ! a ) throw new Error( "no word" );
                var w = { word: clean( a ), defs: [], weekly: true };
                [].forEach.call( doc.querySelectorAll( ".wdw-card-details tr" ), function ( tr )
                {
                    var td = tr.querySelectorAll( "td" );
                    if( td.length < 2 ) return;
                    var k = clean( td[ 0 ] ).replace( /:$/, "" );
                    if( k === "Wortart" ) w.pos = clean( td[ 1 ] );
                    if( k === "Aussprache" ) { var i = td[ 1 ].querySelector( ".ipa" ); w.ipa = "[" + clean( i || td[ 1 ] ) + "]"; }
                    if( k === "Herkunft" ) w.etym = clean( td[ 1 ] );
                } );
                // The meaning is in the word's own entry.
                return page( "de.wiktionary.org", w.word, 30 * 86400 ).then( function ( e )
                {
                    var ps = e ? e.querySelectorAll( "p" ) : [];
                    for( var i = 0; i < ps.length; i++ )
                    {
                        if( clean( ps[ i ] ) !== "Bedeutungen:" ) continue;
                        var dl = ps[ i ].nextElementSibling;
                        if( dl && dl.tagName === "DL" )
                            w.defs = [].slice.call( dl.querySelectorAll( "dd" ) ).slice( 0, 2 ).map( function ( dd )
                            {
                                return clean( dd ).replace( /^\[\d+[a-z]?\]\s*/, "" );
                            } );
                        break;
                    }
                    return w;
                }, function () { return w; } );
            } );
        },

        // Changed by hand, about once a week: the one there now.
        pt: function ()
        {
            return wikitext( "pt.wiktionary.org", "Predefinição:palavra do dia", 86400 ).then( function ( s )
            {
                var t = templates( s, "PDD2" )[ 0 ];
                var def = t && t[ "definição" ];
                var m = def && /'''\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*'''\s*(?:\(([^)]*)\))?\s*([\s\S]*)/.exec( def );
                if( ! m ) throw new Error( "no word" );
                return { word: m[ 1 ].trim(), pos: m[ 2 ] || "", defs: [ plain( m[ 3 ] ) ], weekly: true };
            } );
        }
    };

    function getWord( lang, d )
    {
        var key = /^(es|de|pt)$/.test( lang ) ? "w" + isoWeek( d ).week : ymd( d );   // their word is weekly
        return cached( "word:" + lang + ":" + key, lang === "fr" ? 3 * 3600e3 : 864e5, function () { return WORDS[ lang ]( d ); } );
    }

    //------------------------------------------------------------------------//
    // THE QUOTES - three a day (00-08, 08-16, 16-24): [{text, author, work}]

    var PT_MONTHS = [ "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
                      "Setembro", "Outubro", "Novembro", "Dezembro" ];
    var EN_MONTHS = [ "January", "February", "March", "April", "May", "June", "July", "August",
                      "September", "October", "November", "December" ];

    // The three dates a day draws from: today, and 121 and 242 days back -
    // not the same day of past years, which repeat the same few authors.
    function threeDays( d ) { return [ d, daysAgo( d, 121 ), daysAgo( d, 242 ) ]; }

    function eachPage( host, titles, pick )
    {
        return Promise.all( titles.map( function ( t )
        {
            return wikitext( host, t, 30 * 86400 ).then( pick, function () { return null; } );
        } ) ).then( function ( l ) { return l.filter( function ( q ) { return q && q.text; } ); } );
    }

    var QUOTES =
    {
        en: function ( d )
        {
            return eachPage( "en.wikiquote.org", threeDays( d ).map( function ( x )
            {
                return "Wikiquote:Quote of the day/" + EN_MONTHS[ x.getMonth() ] + " " + x.getDate() + ", " + x.getFullYear();
            } ), function ( s )
            {
                var t = templates( s, "Wikiquote:Quote of the day/Template" )[ 0 ];
                return t && { text: plain( t.quote ), author: plain( t.author ) };
            } );
        },

        // A {{#switch}} on the year: this year's branch, else the last #default.
        es: function ( d )
        {
            return eachPage( "es.wikiquote.org", threeDays( d ).map( function ( x )
            {
                return "Plantilla:" + pad( x.getMonth() + 1 ) + pad( x.getDate() );
            } ), function ( s )
            {
                var y = new RegExp( "\\|\\s*" + d.getFullYear() + "\\s*=\\s*\\{\\{CitaDía" ), at = s.search( y );
                if( at < 0 ) at = s.lastIndexOf( "#default=" );
                var t = at >= 0 && templates( s.slice( at ), "CitaDía" )[ 0 ];
                return t && { text: plain( t[ 1 ] ), author: plain( t[ 2 ] ) };
            } );
        },

        pt: function ( d )
        {
            return eachPage( "pt.wikiquote.org", threeDays( d ).map( function ( x )
            {
                return "Predefinição:Frase do dia/" + x.getDate() + " de " + PT_MONTHS[ x.getMonth() ];
            } ), function ( s )
            {
                var t = templates( s, "frase do dia" )[ 0 ];
                return t && { text: plain( t.frase ).replace( /^["“]\s*|\s*["”]$/g, "" ), author: plain( t.autor ) };
            } );
        },

        // A pool of 42, three a day.
        fr: function ( d )
        {
            var n = dayNo( d ) * 3;
            return eachPage( "fr.wikiquote.org", [ 0, 1, 2 ].map( function ( k )
            {
                return "Modèle:Citation du jour/Switch/" + ( ( n + k ) % 42 + 1 );
            } ), function ( s )
            {
                var t = templates( s, "Citation du jour/Préchargement" )[ 0 ];
                return t && { text: plain( t.citation ), author: plain( t.auteur ) };
            } );
        },

        // One page holds the whole pool (about 51, with their sources).
        de: function ( d )
        {
            return wikitext( "de.wikiquote.org", "Vorlage:Zitat des Tages", 7 * 86400 ).then( function ( s )
            {
                var all = templates( s, "Zitat des Tages/Zitat" ).map( function ( t )
                {
                    var work = plain( t.quelle ).split( /[,.]\s/ )[ 0 ].replace( /^In:\s*/, "" );
                    return { text: plain( t.text ), author: plain( t.autor ), work: work };
                } ).filter( function ( q ) { return q.text && q.text.length < 400; } );
                if( ! all.length ) throw new Error( "no quotes" );
                var n = dayNo( d ) * 3;
                return [ 0, 1, 2 ].map( function ( k ) { return all[ ( n + k ) % all.length ]; } );
            } );
        }
    };

    function getQuotes( lang, d )
    {
        return cached( "quote:" + lang + ":" + ymd( d ), 864e5, function ()
        {
            return QUOTES[ lang ]( d ).then( function ( l ) { if( ! l.length ) throw new Error( "none" ); return l; } );
        } );
    }


    //------------------------------------------------------------------------//
    // THE MASTERPIECES - a pool for the day from the chosen museums: paintings
    // with an image and a Wikipedia article in one of the user's languages
    // (a famous work, with a story to tell). Picked by a hash of the date.

    function getArt( d )
    {
        var colls = [];
        cfg.museums.forEach( function ( m ) { colls = colls.concat( MUSEUMS[ m ].q ); } );
        var kinds = [];
        cfg.forms.forEach( function ( f ) { kinds = kinds.concat( FORMS[ f ] ); } );
        var when = cfg.periods.map( function ( p )
        {
            return "(YEAR(?inc) >= " + PERIODS[ p ][ 0 ] + " && YEAR(?inc) < " + PERIODS[ p ][ 1 ] + ")";
        } ).join( " || " );
        var n = Math.ceil( 24 / Math.max( 1, cfg.artHours ) );
        var key = "art:" + ymd( d ) + ":" + colls.join( "," ) + ":" + kinds.join( "," ) + ":" + cfg.periods.join( "," ) +
                  ":" + cfg.langs.join( "," ) + ":" + n;
        return cached( key, 864e5, function ()
        {
            var wps = cfg.langs.map( function ( l ) { return "<https://" + l + ".wikipedia.org/>"; } ).join( " " );
            var q = "SELECT ?item (SAMPLE(?img) AS ?image) (SAMPLE(?coll) AS ?museum) (SAMPLE(?creator) AS ?artist)" +
                    " (SAMPLE(?inc) AS ?made) (SAMPLE(?born) AS ?b) (SAMPLE(?died) AS ?dd)" +
                    " (GROUP_CONCAT(DISTINCT ?art; separator=\" \") AS ?arts) WHERE {" +
                    " VALUES ?coll { wd:" + colls.join( " wd:" ) + " }" +
                    " VALUES ?kind { wd:" + kinds.join( " wd:" ) + " }" +
                    " ?item wdt:P195 ?coll; wdt:P31 ?kind; wdt:P18 ?img." +
                    " ?art schema:about ?item; schema:isPartOf ?wp. VALUES ?wp { " + wps + " }" +
                    " OPTIONAL { ?item wdt:P170 ?creator. OPTIONAL { ?creator wdt:P569 ?born } OPTIONAL { ?creator wdt:P570 ?died } }" +
                    ( when ? " ?item wdt:P571 ?inc. FILTER(" + when + ")" : " OPTIONAL { ?item wdt:P571 ?inc }" ) +
                    " } GROUP BY ?item ORDER BY MD5(CONCAT(STR(?item), \"" + ymd( d ) + "\")) LIMIT " + ( n + 6 );
            return sparql( q, 7 * 86400 ).then( function ( rows )
            {
                var works = rows.map( function ( b )
                {
                    var arts = {};
                    v( b, "arts" ).split( " " ).forEach( function ( u )
                    {
                        var m = /^https:\/\/(\w+)\.wikipedia\.org\/wiki\/(.+)$/.exec( u );
                        if( m ) arts[ m[ 1 ] ] = decodeURIComponent( m[ 2 ] );
                    } );
                    return { id: qid( v( b, "item" ) ), image: v( b, "image" ).replace( /^http:/, "https:" ),
                             museum: qid( v( b, "museum" ) ), artist: v( b, "artist" ) ? qid( v( b, "artist" ) ) : "",
                             made: year( v( b, "made" ) ), born: year( v( b, "b" ) ), died: year( v( b, "dd" ) ), arts: arts };
                } ).filter( function ( a ) { return a.image && ! /\.(tiff?|pdf|djvu|svg)$/i.test( a.image ); } );
                // Their names, the artists' and the museums', in every language.
                var ids = [];
                works.forEach( function ( a ) { [ a.id, a.artist, a.museum ].forEach( function ( x ) { if( x && ids.indexOf( x ) < 0 ) ids.push( x ); } ); } );
                var chunks = [];
                for( var i = 0; i < ids.length; i += 50 ) chunks.push( ids.slice( i, i + 50 ) );
                return Promise.all( chunks.map( function ( c )
                {
                    return src( "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|descriptions" +
                                "&languages=" + Object.keys( T ).join( "|" ) + "&ids=" + c.join( "|" ), 30 * 86400 );
                } ) ).then( function ( parts )
                {
                    var ent = {};
                    parts.forEach( function ( p ) { for( var k in p.entities ) ent[ k ] = p.entities[ k ]; } );
                    function names( id, what )
                    {
                        var e = ent[ id ], o = {};
                        if( e && e[ what ] ) for( var l in e[ what ] ) o[ l ] = e[ what ][ l ].value;
                        return o;
                    }
                    works.forEach( function ( a )
                    {
                        a.title = names( a.id, "labels" );
                        a.about = names( a.id, "descriptions" );
                        a.by = a.artist ? names( a.artist, "labels" ) : {};
                        a.at = names( a.museum, "labels" );
                    } );
                    return works;
                } );
            } );
        } );
    }



    //------------------------------------------------------------------------//
    // THE SCREEN

    var style = document.createElement( "style" );
    style.textContent = CSS.replace( /FONTS\//g, FONTS );
    document.head.appendChild( style );

    // "2026-09-30T15:00" -> "3 p. m." (the next hours, on a 12-hour clock: narrow columns).
    function hourOnly( iso )
    {
        return new Intl.DateTimeFormat( cfg.langs[ 0 ], { hour: "numeric", hour12: true } )
            .format( new Date( 2000, 0, 1, +iso.slice( 11, 13 ) ) );
    }

    // "2026-09-30T19:58" -> "19:58", or "7:58 p. m." on a 12-hour clock.
    function hm( iso )
    {
        if( ! iso ) return "";
        if( cfg.hours !== 12 ) return iso.slice( 11, 16 );
        return new Intl.DateTimeFormat( cfg.langs[ 0 ], { hour: "numeric", minute: "2-digit", hour12: true } )
            .format( new Date( 2000, 0, 1, +iso.slice( 11, 13 ), +iso.slice( 14, 16 ) ) );
    }

    function box( parent, cls, source )
    {
        var b = el( "section", "cl-box " + cls, null, parent );
        var h = el( "div", "cl-head", null, b );
        var l = el( "span", "", null, h );
        el( "span", "src", source || "", h );
        var body = el( "div", "cl-body", null, b );
        return { box: b, head: l, body: body, lang: "", shown: "" };
    }

    // Fades a box out, refills it, fades it in. `sig` = what it will show:
    // the same thing again is not redrawn (no blink).
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
    function quiet( part, lang, head, key )
    {
        refill( part, "quiet:" + lang + ":" + key, head, lang, function ( b ) { el( "div", "cl-quiet", T[ lang ][ key ], b ); } );
    }

    var wall  = el( "img", "cl-wall", null, host ); wall.alt = "";
    var grid  = el( "div", "cl-grid" + ( cfg.contrast === "high" ? " cl-high" : "" ), null, host );
    grid.style.setProperty( "--cl-display", FONT_SETS[ cfg.font ][ 0 ] );
    grid.style.setProperty( "--cl-text", FONT_SETS[ cfg.font ][ 1 ] );
    grid.style.setProperty( "--k", { s: 0.88, m: 1, l: 1.15 }[ cfg.size ] );
    if( cfg.contrast === "high" ) wall.hidden = true;           // plain black behind the boxes
    var left  = el( "div", "cl-wing", null, grid );
    var mid   = el( "div", "cl-wing", null, grid );
    var right = el( "div", "cl-wing", null, grid );

    var clock   = box( left, "cl-clock", "" );
    var weather = box( left, "cl-weather", WEATHER[ cfg.weather ].name );
    linkTo( weather.box.querySelector( ".src" ), WEATHER[ cfg.weather ].url );
    var art     = box( mid, "cl-art", "Wikidata · Wikipedia" );
    var days    = box( mid, "cl-days", "Wikipedia" );
    var word    = box( right, "cl-word", "Wiktionary" );
    var quote   = box( right, "cl-quote", "Wikiquote" );

    // Boxes turned off leave the screen (they keep working, unseen, but ask
    // nothing - see on()); an empty column goes, the others share its room.
    function on( card ) { return cfg.cards[ card ].on; }
    [ [ clock, "clock" ], [ weather, "weather" ], [ art, "art" ], [ days, "days" ], [ word, "word" ], [ quote, "quote" ] ]
        .forEach( function ( p ) { if( ! on( p[ 1 ] ) ) p[ 0 ].box.remove(); } );
    var cols = [];
    [ [ left, 26 ], [ mid, 48 ], [ right, 26 ] ].forEach( function ( w )
    {
        if( w[ 0 ].childNodes.length ) cols.push( "minmax(0," + w[ 1 ] + "fr)" );
        else w[ 0 ].remove();
    } );
    grid.style.gridTemplateColumns = cols.join( " " );

    var L0 = cfg.langs[ 0 ];
    [ [ art, "art" ], [ days, "days" ], [ word, "wordDay" ], [ quote, "quote" ], [ weather, "now" ] ].forEach( function ( p )
    {
        quiet( p[ 0 ], L0, T[ L0 ][ p[ 1 ] ].replace( "{c}", "…" ), "wait" );
    } );

    // Which language a box shows now: its turn, among those that have something.
    function turnLang( card, have )
    {
        var list = langsOf( card ).filter( have );
        if( ! list.length ) return "";
        var n = Math.floor( ( Date.now() / 1000 - OFFSET[ card ] ) / TURN );
        return list[ ( ( n % list.length ) + list.length ) % list.length ];
    }

    // -- the clock --------------------------------------------------------- //

    var timeEl = el( "div", "cl-time", null, clock.body );
    var sayEl  = el( "div", "cl-words", null, clock.body );
    var dateEl = el( "div", "cl-date", null, clock.body );
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
            var ap = new Intl.DateTimeFormat( cfg.langs[ 0 ], { hour: "numeric", hour12: true } ).formatToParts( d )
                .filter( function ( x ) { return x.type === "dayPeriod"; } )[ 0 ];
            if( ap ) el( "span", "ampm", ap.value, timeEl );
        }
        var lang = turnLang( "clock", function () { return true; } ) || L0;
        var sig = lang + H + ":" + m;
        if( clock.shown === sig ) return;
        clock.shown = sig;
        clock.head.textContent = T[ lang ].time;
        clock.box.lang = lang;
        sayEl.textContent = SAY[ lang ]( H, H % 12 || 12, m );
        dateEl.textContent = cap( dateWords( lang, d ) ) + ".";
        tongue.textContent = T[ lang ].name;
    }

    // -- the weather (in the first language) -------------------------------- //

    var place = null, wx = null;
    function drawWeather()
    {
        if( ! wx || ! place ) return;
        var c = wx.current, dl = wx.daily, t = T[ L0 ];
        var head = place.name ? t.weather.replace( "{c}", place.name ) : t.here;
        refill( weather, "wx:" + c.time + head, head, L0, function ( b )
        {
            var g = el( "div", "cl-wx", null, b );
            var now = el( "div", "", null, g ), tom = el( "div", "", null, g );
            el( "div", "when", t.now, now );
            el( "div", "big", deg( c.temperature_2m ), now );
            el( "div", "sky", t.sky[ skyOf( c.weather_code ) ], now );
            el( "div", "small", t.feels + " " + deg( c.apparent_temperature ) + ", " + t.wind + " " + Math.round( c.wind_speed_10m ) + " " + ( cfg.units === "f" ? "mph" : "km/h" ), now );
            var td = new Date( dl.time[ 1 ] + "T12:00" );
            el( "div", "when", t.tomorrow + ", " + new Intl.DateTimeFormat( L0, { weekday: "long" } ).format( td ), tom );
            el( "div", "mid", deg( dl.temperature_2m_max[ 1 ] ) + " / " + deg( dl.temperature_2m_min[ 1 ] ), tom );
            el( "div", "sky", t.sky[ skyOf( dl.weather_code[ 1 ] ) ], tom );
            if( dl.precipitation_probability_max[ 1 ] != null )
                el( "div", "small", t.rain + " " + dl.precipitation_probability_max[ 1 ] + "%", tom );
            var hr = wx.hourly, i0 = hr.time.indexOf( c.time.slice( 0, 13 ) + ":00" );
            if( i0 >= 0 )
            {
                el( "div", "cl-hours-head", t.next, b );
                var hs = el( "div", "cl-hours", null, b );
                for( var i = i0 + 3; i < hr.time.length && hs.childNodes.length < 5; i += 3 )
                {
                    var h = el( "div", "", null, hs );
                    el( "div", "hh", cfg.hours === 12 ? hourOnly( hr.time[ i ] ) : hm( hr.time[ i ] ), h );
                    el( "div", "ht", deg( hr.temperature_2m[ i ] ), h );
                    el( "div", "hs", t.sky[ skyOf( hr.weather_code[ i ] ) ], h );
                }
            }
            el( "div", "cl-sun", t.sunrise + " " + hm( dl.sunrise[ 0 ] ) + ", " + t.sunset + " " + ( hm( dl.sunset[ 0 ] ) + "." ).replace( /\.\.$/, "." ) + " " +
                                 t.today + " " + deg( dl.temperature_2m_max[ 0 ] ) + " / " + deg( dl.temperature_2m_min[ 0 ] ) + ".", b );
        } );
    }

    function loadWeather()
    {
        if( ! on( "weather" ) ) return;
        getPlace().then( function ( p )                 // again each time: a laptop moves
        {
            place = p;
            return getWeather( p ).then( function ( w ) { if( alive ) { wx = w; drawWeather(); } } );
        } ).catch( function ()
        {
            if( alive && ! wx ) quiet( weather, L0, T[ L0 ].weather.replace( "{c}", place ? place.name : "…" ), "fail" );
        } );
    }

    // -- the masterpiece ---------------------------------------------------- //

    var works = null, workAt = -1, skip = 0, stories = {}, artImg = null, artSize = function () {};
    function onResize() { artSize(); }
    window.addEventListener( "resize", onResize );

    function workNow( d )
    {
        if( ! works || ! works.length ) return null;
        var slot = Math.floor( d.getHours() / Math.max( 1, cfg.artHours ) );
        return works[ ( slot + skip ) % works.length ];
    }

    function haveArt( a ) { return function ( l ) { return !! ( a.title[ l ] || stories[ a.id + l ] ); }; }

    // New work: load its picture (a broken or odd-shaped one is skipped) and
    // the stories in every language, then draw.
    function showWork( d )
    {
        var a = workNow( d );
        if( ! a ) return;
        if( artImg && artImg.work === a ) { drawArt(); return; }
        var img = new Image();
        img.work = a;
        img.onerror = function () { if( alive && skip < 8 ) { skip++; showWork( new Date() ); } };
        img.onload = function ()
        {
            if( ! alive ) return;
            var r = img.naturalWidth / img.naturalHeight;
            if( ( r > 2.4 || r < 0.4 ) && skip < 8 ) { skip++; showWork( new Date() ); return; }   // scrolls, screens
            artImg = img;
            wall.classList.remove( "on" );
            setTimeout( function () { if( alive ) { wall.src = img.src; wall.classList.add( "on" ); } }, 400 );
            drawArt();
        };
        img.src = a.image + "?width=1600";
        langsOf( "art" ).forEach( function ( l )
        {
            if( ! a.arts[ l ] || stories[ a.id + l ] != null ) return;
            getStory( l, a.arts[ l ] ).then( function ( s )
            {
                stories[ a.id + l ] = s;
                if( alive && artImg && artImg.work === a ) drawArt();
            }, function () {} );
        } );
    }

    function drawArt()
    {
        if( ! artImg ) return;
        var a = artImg.work, img = artImg;
        var lang = turnLang( "art", haveArt( a ) ) || L0;
        var story = stories[ a.id + lang ] || a.about[ lang ] || "";
        // Words only in the language shown; a name (the artist's) may come
        // from another of the user's languages, then any.
        function any( o )
        {
            if( o[ lang ] ) return o[ lang ];
            for( var i = 0; i < cfg.langs.length; i++ ) if( o[ cfg.langs[ i ] ] ) return o[ cfg.langs[ i ] ];
            return o[ Object.keys( o )[ 0 ] ] || "";
        }
        var title = a.title[ lang ] || ( a.arts[ lang ] || "" ).replace( /_/g, " " );
        var url = a.arts[ lang ] ? wiki( lang + ".wikipedia.org", a.arts[ lang ] ) : "https://www.wikidata.org/wiki/" + a.id;
        refill( art, a.id + lang + ( story ? 1 : 0 ), T[ lang ].art, lang, function ( b )
        {
            var hang = el( "div", "cl-hang", null, b );
            img.alt = title;
            hang.appendChild( img );
            linkTo( img, url );
            var lab = el( "div", "cl-label", null, b );
            var l1 = el( "div", "", null, lab );
            el( "span", "who", any( a.by ) || T[ lang ].unknown, l1 );
            if( a.born || a.died ) el( "span", "life", "(" + a.born + "–" + a.died + ")", l1 );
            var l2 = el( "div", "", null, lab );
            if( title ) linkTo( el( "span", "title", title, l2 ), url );
            if( a.made ) l2.appendChild( document.createTextNode( ( title ? ", " : "" ) + a.made ) );
            if( a.at[ lang ] ) l2.appendChild( document.createTextNode( ". " + a.at[ lang ] + "." ) );
            if( story ) el( "div", "story", story, lab );

            // As big as the box allows, never cropped; the label under it.
            artSize = function ()
            {
                var gap = parseFloat( getComputedStyle( lab ).marginTop ) || 0;
                var aw = b.clientWidth, ah = b.clientHeight - lab.offsetHeight - gap;
                var k = Math.max( 0, Math.min( aw / img.naturalWidth, ah / img.naturalHeight ) );
                img.style.width  = Math.floor( img.naturalWidth * k ) + "px";
                img.style.height = Math.floor( img.naturalHeight * k ) + "px";
            };
            artSize();
            if( document.fonts ) document.fonts.ready.then( function () { if( alive ) artSize(); } );
        } );
    }

    // -- on this day -------------------------------------------------------- //

    var dayList = {};
    function drawDays( d )
    {
        var lang = turnLang( "days", function ( l ) { return !! ( dayList[ l ] && dayList[ l ].length ); } );
        if( ! lang ) return;
        var l = dayList[ lang ], e = l[ d.getHours() % l.length ];
        refill( days, lang + e.year + e.text, T[ lang ].days, lang, function ( b )
        {
            var p = el( "div", "cl-day", null, b );
            el( "span", "yr", String( e.year ), p );
            el( "span", "kind", ( e.kind === "b" ? T[ lang ].born : T[ lang ].died ), p );
            p.appendChild( document.createTextNode( " " + e.text ) );
            linkTo( p, e.url );
        } );
    }

    // -- the word ----------------------------------------------------------- //

    var wordOf = {};
    function drawWord()
    {
        var lang = turnLang( "word", function ( l ) { return !! wordOf[ l ]; } );
        if( ! lang ) return;
        var w = wordOf[ lang ];
        refill( word, lang + w.word, w.weekly ? T[ lang ].wordWeek : T[ lang ].wordDay, lang, function ( b )
        {
            linkTo( el( "div", "cl-lemma", w.word, b ), wiki( lang + ".wiktionary.org", w.word ) );
            var meta = el( "div", "cl-meta", null, b );
            if( w.pos ) el( "span", "pos", w.pos, meta );
            if( w.ipa && cfg.ipa ) el( "span", "ipa", w.ipa, meta );
            if( w.defs && w.defs.length )
            {
                var ol = el( "ol", "cl-defs", null, b );
                w.defs.forEach( function ( x ) { if( x ) el( "span", "", x, el( "li", "", null, ol ) ); } );
            }
            if( w.etym ) el( "div", "cl-etym", w.etym, b );
        } );
    }

    // -- the quote ---------------------------------------------------------- //

    var quoteOf = {};
    function drawQuote( d )
    {
        var lang = turnLang( "quote", function ( l ) { return !! ( quoteOf[ l ] && quoteOf[ l ].length ); } );
        if( ! lang ) return;
        var l = quoteOf[ lang ], q = l[ Math.floor( d.getHours() / 8 ) % l.length ];
        refill( quote, lang + q.text, T[ lang ].quote, lang, function ( b )
        {
            var t = el( "blockquote", "cl-q", q.text, b );
            var by = el( "div", "cl-by", null, b );
            linkTo( el( "span", "author", q.author, by ),
                    "https://" + lang + ".wikiquote.org/wiki/Special:Search?search=" + encodeURIComponent( q.author ) );
            if( q.work ) by.appendChild( document.createTextNode( ", " + q.work ) );
            // Shrinks a long quote until it fits its box.
            function fit()
            {
                t.style.fontSize = "";
                var px = parseFloat( getComputedStyle( t ).fontSize );
                while( b.scrollHeight > b.clientHeight + 1 && px > 14 ) { px -= 1; t.style.fontSize = px + "px"; }
            }
            fit();
            if( document.fonts ) document.fonts.ready.then( function () { if( alive ) fit(); } );
        } );
    }

    //------------------------------------------------------------------------//
    // LOADING AND THE BEAT

    var loadedDay = "";
    function loadDay( d )
    {
        loadedDay = ymd( d );
        wordOf = {}; quoteOf = {}; dayList = {};
        works = null; artImg = null; skip = 0; stories = {};
        var fails = { word: 0, quote: 0, days: 0 };
        function failed( card, part, key, n )
        {
            if( ++fails[ card ] >= n && alive && ! part.shown.indexOf( "quiet" ) ) quiet( part, L0, T[ L0 ][ key ], "fail" );
        }

        // Languages in order of importance: the first one is asked first.
        if( on( "word" ) ) langsOf( "word" ).forEach( function ( l )
        {
            getWord( l, d ).then( function ( w ) { if( alive ) { wordOf[ l ] = w; drawWord(); } },
                                  function () { failed( "word", word, "wordDay", langsOf( "word" ).length ); } );
        } );
        if( on( "quote" ) ) langsOf( "quote" ).forEach( function ( l )
        {
            getQuotes( l, d ).then( function ( q ) { if( alive ) { quoteOf[ l ] = q; drawQuote( new Date() ); } },
                                    function () { failed( "quote", quote, "quote", langsOf( "quote" ).length ); } );
        } );
        if( on( "days" ) ) langsOf( "days" ).forEach( function ( l )
        {
            getDays( l, d ).then( function ( x ) { if( alive ) { dayList[ l ] = x; drawDays( new Date() ); } },
                                  function () { failed( "days", days, "days", langsOf( "days" ).length ); } );
        } );
        if( on( "art" ) ) getArt( d ).then( function ( w ) { if( alive ) { works = w; showWork( new Date() ); } },
                          function () { if( alive ) quiet( art, L0, T[ L0 ].art, "fail" ); } );
    }

    var lastMin = -1, lastSlot = -1;
    function beat()
    {
        var d = new Date();
        if( ymd( d ) !== loadedDay ) { lastSlot = -1; loadDay( d ); }
        drawClock( d );
        var slot = Math.floor( d.getHours() / Math.max( 1, cfg.artHours ) );
        if( slot !== lastSlot && works ) { lastSlot = slot; skip = 0; showWork( d ); }
        drawArt();
        drawDays( d );
        drawWord();
        drawQuote( d );
        if( d.getMinutes() !== lastMin )
        {
            lastMin = d.getMinutes();
            // A few px of drift every minute: no burn-in, too slow to notice.
            grid.style.transform = "translate(" + ( ( dayNo( d ) * 7 + lastMin * 13 ) % 13 - 6 ) + "px," +
                                                  ( ( lastMin * 7 ) % 11 - 5 ) + "px)";
        }
    }

    beat();
    loadWeather();
    var t1 = setInterval( beat, 1000 );
    var t2 = setInterval( loadWeather, 10 * 6e4 );    // the cache keeps it to one call per 30 min

    return function ()
    {
        alive = false;
        window.removeEventListener( "resize", onResize );
        clearInterval( t1 );
        clearInterval( t2 );
        host.innerHTML = "";
        style.remove();
    };
}


//----------------------------------------------------------------------------//
// THE LOOK - gallery at night: near-opaque boxes (text >= 7:1), a double rule
// like a book plate, Bodoni Moda for figures and words, EB Garamond for text.

var CSS = [
"@font-face { font-family: 'Bodoni Moda'; font-style: normal; font-weight: 400 600; font-display: swap; src: url('FONTS/BodoniModa-normal-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }",
"@font-face { font-family: 'Bodoni Moda'; font-style: normal; font-weight: 400 600; font-display: swap; src: url('FONTS/BodoniModa-normal-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }",
"@font-face { font-family: 'EB Garamond'; font-style: normal; font-weight: 400 600; font-display: swap; src: url('FONTS/EBGaramond-normal-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }",
"@font-face { font-family: 'EB Garamond'; font-style: normal; font-weight: 400 600; font-display: swap; src: url('FONTS/EBGaramond-normal-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }",
"@font-face { font-family: 'EB Garamond'; font-style: italic; font-weight: 400 600; font-display: swap; src: url('FONTS/EBGaramond-italic-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }",
"@font-face { font-family: 'EB Garamond'; font-style: italic; font-weight: 400 600; font-display: swap; src: url('FONTS/EBGaramond-italic-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }",
"@font-face { font-family: 'Atkinson Hyperlegible Next'; font-style: italic; font-weight: 400 700; font-display: swap; src: url('FONTS/AtkinsonHyperlegibleNext-italic-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }",
"@font-face { font-family: 'Atkinson Hyperlegible Next'; font-style: italic; font-weight: 400 700; font-display: swap; src: url('FONTS/AtkinsonHyperlegibleNext-italic-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }",
"@font-face { font-family: 'Atkinson Hyperlegible Next'; font-style: normal; font-weight: 400 700; font-display: swap; src: url('FONTS/AtkinsonHyperlegibleNext-normal-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }",
"@font-face { font-family: 'Atkinson Hyperlegible Next'; font-style: normal; font-weight: 400 700; font-display: swap; src: url('FONTS/AtkinsonHyperlegibleNext-normal-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }",
"@font-face { font-family: 'Literata'; font-style: italic; font-weight: 400 600; font-display: swap; src: url('FONTS/Literata-italic-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }",
"@font-face { font-family: 'Literata'; font-style: italic; font-weight: 400 600; font-display: swap; src: url('FONTS/Literata-italic-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }",
"@font-face { font-family: 'Literata'; font-style: normal; font-weight: 400 600; font-display: swap; src: url('FONTS/Literata-normal-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }",
"@font-face { font-family: 'Literata'; font-style: normal; font-weight: 400 600; font-display: swap; src: url('FONTS/Literata-normal-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }",

".cl-wall { position: absolute; inset: -8%; width: 116%; height: 116%; object-fit: cover;",
"  filter: blur(60px) saturate(1.1) brightness(0.3); opacity: 0; transition: opacity 1.5s ease; }",
".cl-wall.on { opacity: 1; }",
".cl-grid { --ivory: #F6F1E7; --smoke: #CFC7B6; --rule: rgba(246,241,231,0.22); --rule-2: rgba(246,241,231,0.10);",
"  position: absolute; inset: 3.4vh 2.2vw; display: grid; gap: 1.3vw;",
"  grid-template-columns: minmax(0,26fr) minmax(0,48fr) minmax(0,26fr);",
"  font-family: var(--cl-text); color: var(--ivory); -webkit-font-smoothing: antialiased;",
"  transition: transform 40s linear; }",
".cl-grid.cl-high { --ivory: #FFFFFF; --smoke: #E8E8E8; --rule: rgba(255,255,255,0.5); --rule-2: rgba(255,255,255,0.25); }",
".cl-grid.cl-high .cl-box { background: #000; }",
".cl-wing { display: flex; flex-direction: column; gap: 1.3vw; min-height: 0; }",
".cl-box { position: relative; min-height: 0; overflow: hidden; background: rgba(14,12,10,0.86);",
"  border: 1px solid var(--rule); padding: 2.2vh 1.5vw 2.4vh; display: flex; flex-direction: column;",
"  transition: opacity 0.35s ease; }",
".cl-box.out { opacity: 0; }",
".cl-box::before { content: ''; position: absolute; inset: 5px; border: 1px solid var(--rule-2); pointer-events: none; }",
".cl-head { flex: none; display: flex; justify-content: space-between; align-items: baseline; gap: 1em;",
"  font-style: italic; color: var(--smoke); font-size: calc(var(--k, 1) * clamp(14px,1vw,19px));",
"  padding-bottom: 0.55em; margin-bottom: 0.9em; border-bottom: 1px solid var(--rule-2); }",
".cl-head .src { font-size: 0.8em; white-space: nowrap; }",
".cl-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }",
".cl-link { color: inherit; text-decoration: none; cursor: pointer; }",
".cl-link:hover > *, .cl-link:hover { text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 0.18em; }",
".cl-link:hover > img { outline: 1px solid var(--rule); outline-offset: 3px; }",
".cl-hang .cl-link { display: block; }",
".cl-quiet { color: var(--smoke); font-style: italic; font-size: calc(var(--k, 1) * clamp(15px,1.05vw,19px)); }",

".cl-clock { flex: none; }",
".cl-time { font-family: var(--cl-display); font-weight: 400; font-optical-sizing: auto;",
"  font-size: calc(var(--k, 1) * clamp(52px,5.2vw,104px)); line-height: 0.95; letter-spacing: -0.01em;",
"  font-variant-numeric: lining-nums tabular-nums; margin: 0.05em 0 0.2em -0.03em; }",
".cl-time .ampm { font-size: 0.32em; margin-left: 0.3em; letter-spacing: 0.02em; color: var(--smoke); }",
".cl-time .colon { opacity: 0.55; margin: 0 0.02em; position: relative; top: -0.06em; }",
".cl-words { font-style: italic; font-size: calc(var(--k, 1) * clamp(17px,1.3vw,25px)); line-height: 1.3; }",
".cl-date { font-size: calc(var(--k, 1) * clamp(15px,1.08vw,21px)); line-height: 1.35; margin-top: 0.35em; }",
".cl-tongue { color: var(--smoke); font-size: calc(var(--k, 1) * clamp(13px,0.85vw,16px)); margin-top: 0.5em; letter-spacing: 0.04em; font-variant-caps: small-caps; }",

".cl-weather { flex: 1; }",
".cl-wx { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2vw; font-size: calc(var(--k, 1) * clamp(14px,1vw,19px)); line-height: 1.4; }",
".cl-wx .when { color: var(--smoke); font-style: italic; margin-bottom: 0.2em; }",
".cl-wx .big { font-size: calc(var(--k, 1) * clamp(38px,3.1vw,62px)); line-height: 1.05; font-variant-numeric: lining-nums; }",
".cl-wx .mid { font-size: calc(var(--k, 1) * clamp(24px,1.9vw,38px)); line-height: 1.25; font-variant-numeric: lining-nums; }",
".cl-wx .sky { font-size: 1.15em; margin-top: 0.15em; }",
".cl-wx .small { color: var(--smoke); margin-top: 0.3em; font-variant-numeric: lining-nums; }",
".cl-hours-head { color: var(--smoke); font-style: italic; margin-top: 1.4em; padding-top: 0.8em; border-top: 1px solid var(--rule-2); font-size: calc(var(--k, 1) * clamp(14px,1vw,19px)); }",
".cl-hours { display: grid; grid-template-columns: repeat(5,1fr); gap: 0.4em; margin-top: 0.5em; font-variant-numeric: lining-nums; }",
".cl-hours .hh { color: var(--smoke); font-size: calc(var(--k, 1) * clamp(13px,0.9vw,17px)); }",
".cl-hours .ht { font-size: calc(var(--k, 1) * clamp(18px,1.35vw,26px)); line-height: 1.2; }",
".cl-hours .hs { color: var(--smoke); font-style: italic; font-size: calc(var(--k, 1) * clamp(12px,0.85vw,16px)); line-height: 1.2; }",
".cl-sun { margin-top: auto; padding-top: 0.8em; border-top: 1px solid var(--rule-2); color: var(--smoke); font-size: calc(var(--k, 1) * clamp(14px,0.95vw,18px)); font-variant-numeric: lining-nums; }",

".cl-art { flex: 1; }",
".cl-art .cl-body { justify-content: center; }",
".cl-hang { flex: none; }",
".cl-hang img { display: block; margin: 0 auto; box-shadow: 0 2px 3px rgba(0,0,0,0.5), 0 24px 60px rgba(0,0,0,0.65); }",
".cl-label { flex: none; margin-top: 1.8vh; font-size: calc(var(--k, 1) * clamp(14px,1vw,19px)); line-height: 1.4; color: var(--smoke); }",
".cl-label .who { color: var(--ivory); font-variant-caps: small-caps; letter-spacing: 0.04em; font-size: 1.1em; }",
".cl-label .life { margin-left: 0.5em; }",
".cl-label .title { color: var(--ivory); font-style: italic; font-size: 1.1em; }",
".cl-label .story { color: var(--ivory); margin-top: 0.5em; font-size: calc(var(--k, 1) * clamp(15px,1.02vw,19px)); line-height: 1.42;",
"  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }",

".cl-days { flex: none; }",
".cl-days .cl-head { margin-bottom: 0.5em; }",
".cl-day { font-size: calc(var(--k, 1) * clamp(15px,1.08vw,20px)); line-height: 1.4; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }",
".cl-day .yr { font-family: var(--cl-display); font-size: 1.3em; margin-right: 0.45em; font-variant-numeric: lining-nums; }",
".cl-day .kind { font-style: italic; color: var(--smoke); margin-right: 0.1em; }",

".cl-word { flex: 1.3; }",
".cl-lemma { font-family: var(--cl-display); font-size: calc(var(--k, 1) * clamp(30px,2.5vw,50px)); line-height: 1.05; overflow-wrap: anywhere; }",
".cl-meta { color: var(--smoke); margin-top: 0.35em; font-size: calc(var(--k, 1) * clamp(14px,1vw,19px)); }",
".cl-meta .pos { font-style: italic; margin-right: 0.6em; }",
".cl-meta .ipa { font-family: 'Gentium Plus', 'Charis SIL', 'DejaVu Serif', serif; font-size: 0.92em; }",
".cl-defs { margin: 0.7em 0 0; padding: 0 0 0 1.2em; font-size: calc(var(--k, 1) * clamp(15px,1.08vw,20px)); line-height: 1.4; }",
".cl-defs li { margin-bottom: 0.25em; }",
".cl-defs li span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }",
".cl-etym { color: var(--smoke); font-size: calc(var(--k, 1) * clamp(14px,0.98vw,18px)); line-height: 1.45; margin-top: 0.6em;",
"  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }",

".cl-quote { flex: 1; }",
".cl-quote .cl-body { justify-content: safe center; }",
".cl-q { margin: 0; font-style: italic; font-size: calc(var(--k, 1) * clamp(18px,1.42vw,27px)); line-height: 1.35; white-space: pre-line; text-wrap: pretty; }",
".cl-q::before { content: '“'; } .cl-q::after { content: '”'; }",
".cl-by { color: var(--smoke); margin-top: 0.7em; font-size: calc(var(--k, 1) * clamp(14px,1vw,19px)); }",
".cl-by .author { color: var(--ivory); font-variant-caps: small-caps; letter-spacing: 0.04em; }"
].join( "\n" );

} )();
