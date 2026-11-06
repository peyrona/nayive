/* fx.js - live exchange rates, cross-checked, for Calculator (and Trips through it).
 *
 * window.AyniFx. The RATE is never hard-coded and never assumed: it comes from
 * three independent free services (no key), each currency is cross-checked
 * between them, and a currency no pair agrees on has NO rate - this is money, so
 * a guessed number is worse than no number. Moved here from trips/currency.js
 * (2026-10-28), where it was fetched per currency on demand.
 *
 * The verified rates are kept on this device (localStorage), so a conversion
 * shows at once and offline; they are fetched again when older than 6 hours,
 * every hour that passes, and when the connection comes back. rate() and
 * convert() are synchronous - they read only that copy - so Calculator calls
 * them on every key.
 *
 *   AyniFx.start()               load the kept rates, refresh them in the background
 *   AyniFx.onChange( fn )        fn() when new rates arrive or the connection state changes
 *   AyniFx.rate( from, to )      1 `from` = this many `to`, or null (no verified rate)
 *   AyniFx.convert( n, from, to )
 *   AyniFx.check( code )         how `code` was checked, for the "rate check" sheet
 *   AyniFx.date() / offline()    day of the rates ("2026-10-27") / last refresh failed
 *   AyniFx.CODES                 the currencies offered (a traveller's set)
 *   AyniFx.name( code ) / symbol( code ) / digits( code )   in the interface language
 */
( function ()
{
    'use strict';

    //------------------------------------------------------------------------//
    // VERIFICATION PROTOCOL - exact, per explicit instruction - do not "improve" this:
    //   1. Take the sources in order, skipping any that has no rate for the currency.
    //   2. Compare the 1st and 2nd sources that DID give one. If |rate1 - rate2| <= the
    //      tolerance (0.01, or 0.25 % of the rate when that is more), the rate is
    //      verified (their average is used).
    //   3. Otherwise compare the 2nd and 3rd, then the 3rd and 4th, and so on - always
    //      the next CONSECUTIVE pair, never re-trying an earlier one against a later one.
    //   4. If the list runs out with no pair agreeing, say plainly that the rate could
    //      not be verified. Never fall back to a guessed or hard-coded number.
    // The tolerance is RELATIVE for big rates (his call, 2026-09-28): an absolute 0.01
    // asked 1 EUR = 179 JPY, 29 500 VND or 20 400 IDR to agree to 0.005 % or less, which
    // no two sources ever do (live, that day: JPY 179.28 vs 179.19, VND 29 528 vs 29 590 -
    // 0.05 % and 0.21 %). Rates near 1 keep the 0.01 floor: 1.1385 vs 1.1392 is fine.
    const TOLERANCE_ABS = 0.01;     // the floor: two quoted rates may always differ this much
    const TOLERANCE_REL = 0.0025;   // ...or 0.25 % of the bigger rate, when that is more

    function tolerance( a, b ) { return Math.max( TOLERANCE_ABS, TOLERANCE_REL * Math.max( Math.abs( a ), Math.abs( b ) ) ); }
    function agree( a, b )     { return Math.abs( a - b ) <= tolerance( a, b ); }
    // The tolerance for the sheet's words, two significant figures: 0.01, 0.45, 74.
    function toleranceText( a, b ) { return String( Number( tolerance( a, b ).toPrecision( 2 ) ) ); }

    // Priority-ordered sources, each the whole EUR table in one call. read( json )
    // gives { rates: { CODE: EUR->CODE }, asOf } or a reason it failed. Add a 4th,
    // 5th... here to give the chain more to fall back on before it admits defeat.
    const SOURCES = [
        { name: 'Frankfurter (ECB reference rates)', url: 'https://api.frankfurter.dev/v1/latest?base=EUR',
          read: function( d ) { return d && d.rates ? { rates: d.rates, asOf: d.date } : 'lookup failed'; } },
        { name: 'exchangerate-api.com (open access)', url: 'https://open.er-api.com/v6/latest/EUR',
          read: function( d ) { return d && d.result === 'success' && d.rates ? { rates: d.rates, asOf: d.time_last_update_utc } : 'lookup failed'; } },
        { name: 'fawazahmed0/currency-api', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json',
          read: function( d )
          {
              if( ! d || ! d.eur ) return 'lookup failed';
              const rates = {};
              Object.keys( d.eur ).forEach( function( k ) { rates[ k.toUpperCase() ] = d.eur[ k ]; } );
              return { rates: rates, asOf: d.date };
          } }
    ];

    // The currencies offered: every one Trips can detect from a place, plus the
    // Americas' that a traveller from Spain meets most.
    const CODES = [ 'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CNY', 'CAD', 'MXN', 'ARS', 'BRL', 'CLP', 'COP', 'PEN',
                    'NOK', 'SEK', 'DKK', 'ISK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'RUB',
                    'THB', 'VND', 'IDR', 'MYR', 'SGD', 'PHP', 'INR', 'KRW', 'TWD', 'HKD', 'AUD', 'NZD',
                    'ILS', 'AED', 'QAR', 'SAR', 'EGP', 'MAD', 'ZAR', 'KES' ];

    const KEY     = 'ayni-fx';
    const MAX_AGE = 6 * 3600e3;

    // kept = { fetched, sources: [ { source, ok, asOf, rates: { CODE: n } } | { source, ok: false, reason } ] }
    let kept      = null;
    let verified  = {};       // CODE -> EUR->CODE, from kept
    let isOffline = false;
    let busy      = null;
    let started   = false;
    const listeners = [];

    function lang() { return window.Ayni ? Ayni.i18n.lang() : ( navigator.language || 'en' ); }

    //------------------------------------------------------------------------//
    // THE CHECK - the protocol over the kept sources, for one currency. Same shape
    // Trips' sheet had: { code, results, verified, compared }.

    function check( code ) { return checkIn( kept ? kept.sources : [], code ); }

    function checkIn( srcs, code )
    {
        const results    = [];
        const compared   = [];
        const successful = [];
        let   ver        = null;

        for( const s of srcs )
        {
            let r;
            if( ! s.ok )                          r = { ok: false, source: s.source, reason: s.reason };
            else if( code === 'EUR' )             r = { ok: true, rate: 1, asOf: s.asOf, source: s.source };
            else if( typeof s.rates[ code ] !== 'number' ) r = { ok: false, source: s.source, reason: 'does not track ' + code };
            else                                  r = { ok: true, rate: s.rates[ code ], asOf: s.asOf, source: s.source };
            results.push( r );

            if( ! r.ok )
                continue;   // no data from this source - not a slot, just skip it

            successful.push( r );

            if( successful.length < 2 )
                continue;

            const prev = successful[ successful.length - 2 ];
            compared.push( { a: prev, b: r, diff: Math.abs( prev.rate - r.rate ) } );

            if( agree( prev.rate, r.rate ) )
            {
                ver = { rate: ( prev.rate + r.rate ) / 2, sourceA: prev, sourceB: r };
                break;
            }
            // else: this pair disagreed - the NEXT source (if any) is compared against `r`
        }

        return { code: code, results: results, verified: ver, compared: compared };
    }

    function verifyAll( srcs )
    {
        const out = {};
        CODES.forEach( function( c ) { const k = checkIn( srcs, c ); if( k.verified ) out[ c ] = k.verified.rate; } );
        return out;
    }

    //------------------------------------------------------------------------//
    // FETCHING - the sources in order, only as many as needed: it stops once every
    // currency in CODES is verified.

    async function fetchOne( src )
    {
        try
        {
            const res = await fetch( src.url, { cache: 'no-cache', signal: AbortSignal.timeout( 8000 ) } );

            if( ! res.ok )
                return { ok: false, source: src.name, reason: 'HTTP ' + res.status };

            const got = src.read( await res.json() );

            if( typeof got === 'string' )
                return { ok: false, source: src.name, reason: got };

            const rates = {};
            CODES.forEach( function( c ) { const v = got.rates[ c ]; if( typeof v === 'number' && v > 0 ) rates[ c ] = v; } );
            return { ok: true, source: src.name, asOf: dayOf( got.asOf ), rates: rates };
        }
        catch( _ )
        {
            return { ok: false, source: src.name, reason: 'network error' };
        }
    }

    // "Tue, 27 Oct 2026 00:02:31 +0000" or "2026-10-27" -> "2026-10-27"
    function dayOf( s )
    {
        if( /^\d{4}-\d{2}-\d{2}$/.test( s || '' ) ) return s;
        const t = Date.parse( s );
        return isNaN( t ) ? null : new Date( t ).toISOString().slice( 0, 10 );
    }

    async function fetchAll()
    {
        const sources = [];

        for( const src of SOURCES )
        {
            sources.push( await fetchOne( src ) );
            const now = verifyAll( sources );
            if( CODES.every( function( c ) { return c in now; } ) ) break;
        }

        const answered = sources.filter( function( s ) { return s.ok; } ).length;

        // Fewer than two answers can verify nothing: keep what this device had.
        if( answered < 2 && kept )
        {
            setOffline( true );
            return;
        }

        kept     = { fetched: Date.now(), sources: sources };
        verified = verifyAll( sources );
        try { localStorage.setItem( KEY, JSON.stringify( kept ) ); } catch( e ) {}
        isOffline = answered < 2;
        fire();
    }

    function refresh( force )
    {
        if( ! force && kept && Date.now() - kept.fetched < MAX_AGE ) return Promise.resolve();
        if( ! busy ) busy = fetchAll().finally( function() { busy = null; } );
        return busy;
    }

    function setOffline( v ) { if( isOffline !== v ) { isOffline = v; fire(); } }
    function fire() { listeners.forEach( function( fn ) { try { fn(); } catch( e ) {} } ); }

    function start()
    {
        if( started ) return refresh();
        started = true;
        window.addEventListener( 'online',  function() { refresh( true ); } );
        window.addEventListener( 'offline', function() { setOffline( true ); } );
        setInterval( function() { refresh(); }, 3600e3 );
        return refresh();
    }

    //------------------------------------------------------------------------//
    // READING

    function rate( from, to )
    {
        if( from === to ) return 1;
        const a = from === 'EUR' ? 1 : verified[ from ];
        const b = to   === 'EUR' ? 1 : verified[ to ];
        return a > 0 && b > 0 ? b / a : null;
    }

    function convert( n, from, to ) { const k = rate( from, to ); return k === null ? null : n * k; }

    // The newest day among the sources that answered.
    function date()
    {
        if( ! kept ) return null;
        const days = kept.sources.map( function( s ) { return s.asOf; } ).filter( Boolean ).sort();
        return days.length ? days[ days.length - 1 ] : null;
    }

    // Names and symbols come from the browser in the interface language
    // (Intl.DisplayNames), so there is no list of them to translate.
    let names = null;
    function name( code )
    {
        try
        {
            if( names === null )
                names = Intl.DisplayNames ? new Intl.DisplayNames( [ lang() ], { type: 'currency' } ) : false;
            if( names ) return names.of( code ) || code;
        }
        catch( e ) {}
        return code;
    }

    function symbol( code )
    {
        try
        {
            const p = new Intl.NumberFormat( lang(), { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' } )
                .formatToParts( 0 ).find( function( x ) { return x.type === 'currency'; } );
            return p ? p.value : code;
        }
        catch( e ) { return code; }
    }

    // A currency's own decimals: 2 for most, 0 for JPY or CLP.
    function digits( code )
    {
        try { return new Intl.NumberFormat( 'en', { style: 'currency', currency: code } ).resolvedOptions().maximumFractionDigits; }
        catch( e ) { return 2; }
    }

    try
    {
        const k = JSON.parse( localStorage.getItem( KEY ) );
        if( k && Array.isArray( k.sources ) ) { kept = k; verified = verifyAll( k.sources ); }
    }
    catch( e ) {}

    window.AyniFx = {
        CODES: CODES,
        SOURCES: SOURCES,
        start: start,
        refresh: refresh,
        onChange: function( fn ) { listeners.push( fn ); },
        rate: rate,
        convert: convert,
        check: check,
        agree: agree,
        toleranceText: toleranceText,
        date: date,
        offline: function() { return isOffline; },
        name: name,
        symbol: symbol,
        digits: digits
    };
} )();
