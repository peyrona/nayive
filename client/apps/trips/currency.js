/* currency.js - the currency of a place, and the way to the converter (Calculator). */

//------------------------------------------------------------------------//
// CURRENCY - the CODE is detected from the trip's destination text (never asked for).
// The RATE is never hard-coded and never assumed: Calculator (shared/ayni/ayni-fx.js) fetches it
// live and cross-checks it, and says so plainly when it cannot - this is money, so a
// guessed number is worse than no number.

const PLACE_CURRENCY = {
    'japan': 'JPY', 'tokyo': 'JPY', 'kyoto': 'JPY', 'osaka': 'JPY',
    'portugal': 'EUR', 'lisbon': 'EUR', 'porto': 'EUR',
    'spain': 'EUR', 'madrid': 'EUR', 'barcelona': 'EUR', 'seville': 'EUR',
    'france': 'EUR', 'paris': 'EUR', 'nice': 'EUR',
    'italy': 'EUR', 'rome': 'EUR', 'milan': 'EUR', 'venice': 'EUR', 'florence': 'EUR',
    'germany': 'EUR', 'berlin': 'EUR', 'munich': 'EUR',
    'netherlands': 'EUR', 'amsterdam': 'EUR',
    'belgium': 'EUR', 'brussels': 'EUR',
    'austria': 'EUR', 'vienna': 'EUR',
    'greece': 'EUR', 'athens': 'EUR', 'santorini': 'EUR',
    'ireland': 'EUR', 'dublin': 'EUR',
    'finland': 'EUR', 'helsinki': 'EUR',
    'croatia': 'EUR', 'malta': 'EUR', 'cyprus': 'EUR', 'slovenia': 'EUR', 'estonia': 'EUR', 'latvia': 'EUR', 'lithuania': 'EUR', 'slovakia': 'EUR',
    'united kingdom': 'GBP', 'uk': 'GBP', 'england': 'GBP', 'scotland': 'GBP', 'wales': 'GBP', 'london': 'GBP', 'edinburgh': 'GBP',
    'united states': 'USD', 'usa': 'USD', 'america': 'USD', 'new york': 'USD', 'los angeles': 'USD', 'san francisco': 'USD', 'chicago': 'USD', 'miami': 'USD', 'las vegas': 'USD', 'hawaii': 'USD',
    'canada': 'CAD', 'toronto': 'CAD', 'vancouver': 'CAD', 'montreal': 'CAD',
    'mexico': 'MXN', 'cancun': 'MXN', 'mexico city': 'MXN',
    'brazil': 'BRL', 'rio de janeiro': 'BRL', 'sao paulo': 'BRL',
    'argentina': 'ARS', 'buenos aires': 'ARS',
    'chile': 'CLP', 'santiago': 'CLP',
    'colombia': 'COP', 'bogota': 'COP',
    'peru': 'PEN', 'lima': 'PEN', 'cusco': 'PEN',
    'switzerland': 'CHF', 'zurich': 'CHF', 'geneva': 'CHF',
    'norway': 'NOK', 'oslo': 'NOK',
    'sweden': 'SEK', 'stockholm': 'SEK',
    'denmark': 'DKK', 'copenhagen': 'DKK',
    'iceland': 'ISK', 'reykjavik': 'ISK',
    'poland': 'PLN', 'warsaw': 'PLN', 'krakow': 'PLN',
    'czech republic': 'CZK', 'czechia': 'CZK', 'prague': 'CZK',
    'hungary': 'HUF', 'budapest': 'HUF',
    'romania': 'RON', 'bucharest': 'RON',
    'thailand': 'THB', 'bangkok': 'THB', 'phuket': 'THB', 'chiang mai': 'THB',
    'vietnam': 'VND', 'hanoi': 'VND', 'ho chi minh': 'VND',
    'indonesia': 'IDR', 'bali': 'IDR', 'jakarta': 'IDR',
    'malaysia': 'MYR', 'kuala lumpur': 'MYR',
    'singapore': 'SGD',
    'philippines': 'PHP', 'manila': 'PHP',
    'india': 'INR', 'mumbai': 'INR', 'delhi': 'INR', 'goa': 'INR',
    'china': 'CNY', 'beijing': 'CNY', 'shanghai': 'CNY',
    'south korea': 'KRW', 'korea': 'KRW', 'seoul': 'KRW',
    'taiwan': 'TWD', 'taipei': 'TWD',
    'hong kong': 'HKD',
    'australia': 'AUD', 'sydney': 'AUD', 'melbourne': 'AUD',
    'new zealand': 'NZD', 'auckland': 'NZD',
    'turkey': 'TRY', 'istanbul': 'TRY', 'cappadocia': 'TRY',
    'israel': 'ILS', 'tel aviv': 'ILS', 'jerusalem': 'ILS',
    'united arab emirates': 'AED', 'uae': 'AED', 'dubai': 'AED', 'abu dhabi': 'AED',
    'qatar': 'QAR', 'doha': 'QAR',
    'saudi arabia': 'SAR', 'riyadh': 'SAR',
    'egypt': 'EGP', 'cairo': 'EGP',
    'morocco': 'MAD', 'marrakech': 'MAD', 'casablanca': 'MAD',
    'south africa': 'ZAR', 'cape town': 'ZAR', 'johannesburg': 'ZAR',
    'kenya': 'KES', 'nairobi': 'KES',
    'russia': 'RUB', 'moscow': 'RUB',
    'dominican republic': 'DOP', 'santo domingo': 'DOP', 'punta cana': 'DOP',
    'porto alegre': 'BRL',

    // The same places as typed in the other app languages (T18), written without
    // accents: the text is folded the same way before it is matched.
    // Spanish
    'japon': 'JPY', 'tokio': 'JPY', 'kioto': 'JPY',
    'lisboa': 'EUR', 'oporto': 'EUR', 'espana': 'EUR', 'sevilla': 'EUR', 'francia': 'EUR', 'niza': 'EUR',
    'italia': 'EUR', 'roma': 'EUR', 'venecia': 'EUR', 'florencia': 'EUR', 'alemania': 'EUR',
    'paises bajos': 'EUR', 'holanda': 'EUR', 'belgica': 'EUR', 'bruselas': 'EUR', 'viena': 'EUR',
    'grecia': 'EUR', 'atenas': 'EUR', 'irlanda': 'EUR', 'finlandia': 'EUR', 'croacia': 'EUR', 'chipre': 'EUR',
    'eslovenia': 'EUR', 'letonia': 'EUR', 'lituania': 'EUR', 'eslovaquia': 'EUR',
    'reino unido': 'GBP', 'inglaterra': 'GBP', 'escocia': 'GBP', 'gales': 'GBP', 'londres': 'GBP', 'edimburgo': 'GBP',
    'estados unidos': 'USD', 'eeuu': 'USD', 'nueva york': 'USD', 'mexico df': 'MXN', 'ciudad de mexico': 'MXN',
    'brasil': 'BRL', 'suiza': 'CHF', 'ginebra': 'CHF', 'noruega': 'NOK', 'suecia': 'SEK', 'estocolmo': 'SEK',
    'dinamarca': 'DKK', 'copenhague': 'DKK', 'islandia': 'ISK', 'polonia': 'PLN', 'varsovia': 'PLN', 'cracovia': 'PLN',
    'republica checa': 'CZK', 'chequia': 'CZK', 'praga': 'CZK', 'hungria': 'HUF', 'rumania': 'RON', 'bucarest': 'RON',
    'tailandia': 'THB', 'malasia': 'MYR', 'singapur': 'SGD', 'filipinas': 'PHP', 'pekin': 'CNY',
    'corea del sur': 'KRW', 'corea': 'KRW', 'seul': 'KRW', 'nueva zelanda': 'NZD', 'turquia': 'TRY', 'estambul': 'TRY',
    'emiratos arabes unidos': 'AED', 'emiratos': 'AED', 'catar': 'QAR', 'arabia saudi': 'SAR', 'arabia saudita': 'SAR',
    'egipto': 'EGP', 'el cairo': 'EGP', 'marruecos': 'MAD', 'sudafrica': 'ZAR', 'rusia': 'RUB', 'moscu': 'RUB',
    'republica dominicana': 'DOP',
    // French
    'espagne': 'EUR', 'lisbonne': 'EUR', 'italie': 'EUR', 'venise': 'EUR', 'allemagne': 'EUR',
    'pays bas': 'EUR', 'belgique': 'EUR', 'bruxelles': 'EUR', 'autriche': 'EUR', 'vienne': 'EUR', 'grece': 'EUR', 'athenes': 'EUR',
    'irlande': 'EUR', 'finlande': 'EUR', 'croatie': 'EUR', 'slovenie': 'EUR', 'slovaquie': 'EUR', 'lituanie': 'EUR', 'lettonie': 'EUR', 'estonie': 'EUR',
    'royaume uni': 'GBP', 'angleterre': 'GBP', 'ecosse': 'GBP', 'pays de galles': 'GBP',
    'etats unis': 'USD', 'mexique': 'MXN', 'bresil': 'BRL', 'argentine': 'ARS', 'chili': 'CLP', 'colombie': 'COP', 'perou': 'PEN',
    'suisse': 'CHF', 'geneve': 'CHF', 'norvege': 'NOK', 'suede': 'SEK', 'danemark': 'DKK', 'islande': 'ISK', 'pologne': 'PLN', 'varsovie': 'PLN',
    'tchequie': 'CZK', 'hongrie': 'HUF', 'roumanie': 'RON', 'thailande': 'THB', 'indonesie': 'IDR', 'malaisie': 'MYR', 'singapour': 'SGD',
    'inde': 'INR', 'chine': 'CNY', 'coree du sud': 'KRW', 'coree': 'KRW', 'australie': 'AUD', 'nouvelle zelande': 'NZD',
    'turquie': 'TRY', 'emirats arabes unis': 'AED', 'arabie saoudite': 'SAR', 'egypte': 'EGP', 'le caire': 'EGP', 'maroc': 'MAD',
    'afrique du sud': 'ZAR', 'russie': 'RUB', 'moscou': 'RUB', 'republique dominicaine': 'DOP',
    // German
    'spanien': 'EUR', 'lissabon': 'EUR', 'frankreich': 'EUR', 'italien': 'EUR', 'rom': 'EUR', 'mailand': 'EUR', 'venedig': 'EUR', 'florenz': 'EUR',
    'deutschland': 'EUR', 'munchen': 'EUR', 'niederlande': 'EUR', 'belgien': 'EUR', 'brussel': 'EUR', 'osterreich': 'EUR', 'wien': 'EUR',
    'griechenland': 'EUR', 'athen': 'EUR', 'irland': 'EUR', 'finnland': 'EUR', 'kroatien': 'EUR', 'zypern': 'EUR',
    'slowenien': 'EUR', 'estland': 'EUR', 'lettland': 'EUR', 'litauen': 'EUR', 'slowakei': 'EUR',
    'vereinigtes konigreich': 'GBP', 'grossbritannien': 'GBP', 'schottland': 'GBP',
    'vereinigte staaten': 'USD', 'kanada': 'CAD', 'mexiko': 'MXN', 'brasilien': 'BRL', 'argentinien': 'ARS', 'kolumbien': 'COP',
    'schweiz': 'CHF', 'genf': 'CHF', 'norwegen': 'NOK', 'schweden': 'SEK', 'kopenhagen': 'DKK',
    'polen': 'PLN', 'warschau': 'PLN', 'krakau': 'PLN', 'tschechien': 'CZK', 'prag': 'CZK', 'ungarn': 'HUF', 'rumanien': 'RON', 'bukarest': 'RON',
    'indonesien': 'IDR', 'philippinen': 'PHP', 'indien': 'INR', 'peking': 'CNY', 'sudkorea': 'KRW', 'australien': 'AUD', 'neuseeland': 'NZD',
    'turkei': 'TRY', 'agypten': 'EGP', 'kairo': 'EGP', 'marokko': 'MAD', 'sudafrika': 'ZAR', 'russland': 'RUB', 'moskau': 'RUB',
    'dominikanische republik': 'DOP',
    // Portuguese
    'japao': 'JPY', 'toquio': 'JPY', 'espanha': 'EUR', 'franca': 'EUR', 'milao': 'EUR', 'veneza': 'EUR', 'florenca': 'EUR',
    'alemanha': 'EUR', 'berlim': 'EUR', 'munique': 'EUR', 'paises baixos': 'EUR', 'bruxelas': 'EUR',
    'eua': 'USD', 'nova iorque': 'USD', 'nova york': 'USD', 'suica': 'CHF', 'genebra': 'CHF', 'romenia': 'RON',
    'singapura': 'SGD', 'pequim': 'CNY', 'coreia do sul': 'KRW', 'coreia': 'KRW', 'nova zelandia': 'NZD',
    'egito': 'EGP', 'marrocos': 'MAD', 'africa do sul': 'ZAR', 'moscovo': 'RUB'
};

// Lower case, no accents (Perú = peru, Japón = japon), ß = ss, a hyphen is a
// space (pays-bas): the keys above are written that way. "\b" never matched
// after an accented last letter.
function foldPlace( s )
{
    return ( s || '' ).toLowerCase().normalize( 'NFD' ).replace( /[\u0300-\u036f]/g, '' ).replace( /ß/g, 'ss' ).replace( /-/g, ' ' );
}

const PLACE_KEYS = Object.keys( PLACE_CURRENCY ).sort( function( a, b ) { return b.length - a.length; } )
    .map( function( k ) { return [ k, new RegExp( '\\b' + k.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) + '\\b' ) ]; } );

const PLACE_OWN_MONEY = [ 'hong kong' ];

function placeCurrency( sText )
{
    for( const kv of PLACE_KEYS )
        if( kv[ 1 ].test( sText ) ) return PLACE_CURRENCY[ kv[ 0 ] ];
    return null;
}

// Returns { code, matched }. matched === false means the destination text didn't match
// anything and EUR is a fallback guess, not a determination - callers must disclose that,
// never present it as if it were confidently known.
function detectCurrency( sDestination )
{
    const sText = foldPlace( sDestination );

    // The country first: a geocoded label ends with it ("Santiago de
    // Compostela, Galicia, Spain"), and a city that shares a name with one
    // abroad (Santiago, London) must not win over it (T3).
    // A place with a money of its own inside a country (Hong Kong, China) still
    // goes by its own name.
    const parts = sText.split( ',' );
    const own   = PLACE_OWN_MONEY.find( function( k ) { return new RegExp( '\\b' + k + '\\b' ).test( sText ); } );
    const code  = ( own && PLACE_CURRENCY[ own ] )
               || ( parts.length > 1 && placeCurrency( parts[ parts.length - 1 ] ) ) || placeCurrency( sText );

    return code ? { code: code, matched: true } : { code: 'EUR', matched: false };
}

// A stage's currency, detected from its resolved country label (falls back to the
// raw location text before geocoding lands).
function stageCurrency( st ) { return detectCurrency( (st && (st.tzLabel || st.location)) || '' ); }

// Where the currency converter belongs for this trip:
//   'trip'  - one button in the header: no stages, or every stage uses one currency
//   'stage' - a button on each stage card: the trip spans more than one currency
function currencyPlacement( trip )
{
    const stages = (trip && trip.stages) || [];

    if( stages.length === 0 )
        return 'trip';

    const codes = stages.map( function( s ) { return stageCurrency( s ).code; } );
    return codes.every( function( c ) { return c === codes[ 0 ]; } ) ? 'trip' : 'stage';
}

//------------------------------------------------------------------------//
// THE CONVERTER is the Calculator app (2026-10-28), in currency mode: the place's
// currency typed, the euro beside it. The rate is shared/ayni/ayni-fx.js's - the same three
// sources and the same cross-check this file used to run. A place whose currency
// could not be worked out goes with &place=, and Calculator says so plainly.
// codeArg/matchedArg/contextName come from a per-stage button; with no args (the
// header button) the currency is derived from the trip's stages or destination.
function openCurrency( codeArg, matchedArg, contextName )
{
    const trip = findTrip( selectedTripId );

    if( ! trip )
        return;

    let c, place;

    if( codeArg )
    {
        c     = { code: codeArg, matched: matchedArg !== false };
        place = contextName || trip.destination;
    }
    else if( ( trip.stages || [] ).length )
    {
        c     = stageCurrency( trip.stages[ 0 ] );
        place = trip.stages[ 0 ].location || trip.destination;
    }
    else
    {
        c     = detectCurrency( trip.destination );
        place = trip.destination;
    }

    const url = '../calculator/index.html?mode=fx&from=' + encodeURIComponent( c.code ) + '&to=EUR'
              + ( c.matched ? '' : '&place=' + encodeURIComponent( place || '' ) );

    // A phone has no visible way back from a new tab: in place, Back returns here.
    // A desktop window opens it as a window of its own; a computer, as a tab.
    if( window.matchMedia( '(max-width: 640px)' ).matches ) location.href = url;
    else                                                     window.open( url, '_blank' );
}
