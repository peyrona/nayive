/* currency.js - the currency of a place, and the way to the converter (Calculator). */

//------------------------------------------------------------------------//
// CURRENCY - the CODE is detected from the trip's destination text (never asked for).
// The RATE is never hard-coded and never assumed: Calculator (shared/fx.js) fetches it
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
    'russia': 'RUB', 'moscow': 'RUB'
};

// Returns { code, matched }. matched === false means the destination text didn't match
// anything and EUR is a fallback guess, not a determination - callers must disclose that,
// never present it as if it were confidently known.
function detectCurrency( sDestination )
{
    const sText = (sDestination || '').toLowerCase();
    const keys  = Object.keys( PLACE_CURRENCY ).sort( function( a, b ) { return b.length - a.length; } );

    for( const key of keys )
    {
        const re = new RegExp( '\\b' + key.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) + '\\b' );

        if( re.test( sText ) )
            return { code: PLACE_CURRENCY[ key ], matched: true };
    }

    return { code: 'EUR', matched: false };
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
// currency typed, the euro beside it. The rate is shared/fx.js's - the same three
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
