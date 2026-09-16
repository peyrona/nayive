/* currency.js - the currency of a place, and the live, cross-checked exchange rate. */

//------------------------------------------------------------------------//
// CURRENCY - the CODE is detected from the trip's destination text (never asked for);
// the RATE is never hard-coded and never assumed. It is fetched live, on demand, from
// two independent free services, cross-checked against each other, and openly reported
// as unavailable when neither responds - this is money, so a guessed number is worse
// than no number.

// Currency names come from the browser in the interface language
// (Intl.DisplayNames), so there is no list of them to translate.
let _curNames = null;
function currencyName( sCode )
{
    try
    {
        if( _curNames === null )
            _curNames = ( typeof Intl !== "undefined" && Intl.DisplayNames )
                      ? new Intl.DisplayNames( [ NayiveUI.locale() ], { type: "currency" } ) : false;
        if( _curNames ) return _curNames.of( sCode ) || sCode;
    }
    catch ( e ) {}
    return sCode;
}

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
// LIVE EXCHANGE RATE - a priority-ordered list of independent, free, no-key services.
// Verification protocol (exact, per explicit instruction - do not "improve" this):
//   1. Fetch sources in order, skipping any that return no data.
//   2. Compare the 1st and 2nd sources that DID return data. If |rate1 - rate2| <= 0.01,
//      the rate is verified (their average is used).
//   3. Otherwise compare the 2nd and 3rd, then the 3rd and 4th, and so on - always the
//      next CONSECUTIVE pair, never re-trying an earlier one against a later one.
//   4. If the list runs out with no pair agreeing, say plainly that the rate could not
//      be verified. Never fall back to a guessed or hard-coded number - this is money.
const RATE_TOLERANCE_ABS = 0.01;   // absolute difference between two quoted rates, e.g. 172.40 vs 172.41 is fine, 172.40 vs 172.52 is not

function ratesAgree( a, b )
{
    return Math.abs( a - b ) <= RATE_TOLERANCE_ABS;
}

async function fetchRateFrankfurter( sCurrency )
{
    const SOURCE = 'Frankfurter (ECB reference rates)';

    if( sCurrency === 'EUR' )
        return { ok: true, rate: 1, asOf: null, source: SOURCE };

    try
    {
        const res = await fetch( 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=' + encodeURIComponent( sCurrency ) );

        if( ! res.ok )
            return { ok: false, source: SOURCE, reason: 'HTTP ' + res.status };

        const data = await res.json();
        const rate = data && data.rates ? data.rates[ sCurrency ] : undefined;

        if( typeof rate !== 'number' )
            return { ok: false, source: SOURCE, reason: 'does not track ' + sCurrency };

        return { ok: true, rate: rate, asOf: data.date, source: SOURCE };
    }
    catch( _ )
    {
        return { ok: false, source: SOURCE, reason: 'network error' };
    }
}

async function fetchRateExchangerateApi( sCurrency )
{
    const SOURCE = 'exchangerate-api.com (open access)';

    try
    {
        const res = await fetch( 'https://open.er-api.com/v6/latest/EUR' );

        if( ! res.ok )
            return { ok: false, source: SOURCE, reason: 'HTTP ' + res.status };

        const data = await res.json();

        if( data.result !== 'success' || ! data.rates )
            return { ok: false, source: SOURCE, reason: 'lookup failed' };

        const rate = data.rates[ sCurrency ];

        if( typeof rate !== 'number' )
            return { ok: false, source: SOURCE, reason: 'does not track ' + sCurrency };

        return { ok: true, rate: rate, asOf: data.time_last_update_utc, source: SOURCE };
    }
    catch( _ )
    {
        return { ok: false, source: SOURCE, reason: 'network error' };
    }
}

async function fetchRateFawaz( sCurrency )
{
    const SOURCE = 'fawazahmed0/currency-api';

    try
    {
        const res = await fetch( 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json' );

        if( ! res.ok )
            return { ok: false, source: SOURCE, reason: 'HTTP ' + res.status };

        const data = await res.json();
        const rate = data && data.eur ? data.eur[ sCurrency.toLowerCase() ] : undefined;

        if( typeof rate !== 'number' )
            return { ok: false, source: SOURCE, reason: 'does not track ' + sCurrency };

        return { ok: true, rate: rate, asOf: data.date, source: SOURCE };
    }
    catch( _ )
    {
        return { ok: false, source: SOURCE, reason: 'network error' };
    }
}

// Priority-ordered source list. Extend here (a 4th, 5th... source) to give the
// verification chain more to fall back on before it has to admit defeat.
const RATE_SOURCE_FETCHERS = [ fetchRateFrankfurter, fetchRateExchangerateApi, fetchRateFawaz ];

// Walks RATE_SOURCE_FETCHERS in order (only calling as many as actually needed).
// Sources that return no data (network error, HTTP error, or that service simply
// doesn't track this currency) are skipped entirely - they don't occupy a "slot".
// Among the sources that DID return a value, compares the 1st against the 2nd; if
// that fails, the 2nd against the 3rd; then the 3rd against the 4th, and so on -
// always the next consecutive pair, never re-trying an earlier one. Stops at the
// first pair that agrees.
// Result shape: { code, matched, results, verified, compared }
//   - results:  every fetch actually made, in order, each { ok, rate?, asOf?, source, reason? }
//   - verified: null if unverified, else { rate, sourceA, sourceB } (rate = their average)
//   - compared: every consecutive pair actually checked, each with its absolute
//               difference - shown so a real disagreement is visible, not hidden
async function lookupExchangeRate( sCurrency, bMatched )
{
    const results    = [];
    const compared   = [];
    const successful = [];
    let   verified   = null;

    for( const fetchFn of RATE_SOURCE_FETCHERS )
    {
        const r = await fetchFn( sCurrency );
        results.push( r );

        if( ! r.ok )
            continue;   // no data from this source - not a slot, just skip it

        successful.push( r );

        if( successful.length < 2 )
            continue;

        const prev = successful[ successful.length - 2 ];
        const diff = Math.abs( prev.rate - r.rate );
        compared.push( { a: prev, b: r, diff: diff } );

        if( ratesAgree( prev.rate, r.rate ) )
        {
            verified = { rate: (prev.rate + r.rate) / 2, sourceA: prev, sourceB: r };
            break;
        }
        // else: this pair disagreed - the loop moves on and the NEXT source (if any)
        // will be compared against `r`, not against `prev` again
    }

    return { code: sCurrency, matched: bMatched, results: results, verified: verified, compared: compared };
}
