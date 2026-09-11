/* money.js - the arithmetic of the Split app. No DOM, no network: a classic
 * script that leaves ONE global, window.SplitMoney, and also loads under Node
 * (module.exports) so it can be unit-tested from the command line:
 *
 *     node -e "const M = require('./nayive/apps/split/money.js'); ..."
 *
 * MONEY IS INTEGERS. Every amount is a whole number of MINOR units - cents for
 * EUR / USD, yen for JPY (0 decimals), fils for KWD (3 decimals). Floats never
 * hold money here; the only floating-point values are exchange RATES and split
 * WEIGHTS (shares, percentages), and every result is rounded back to integers
 * with allocate(), which guarantees the parts add up to the whole.
 *
 * WORDS USED
 *   group     { currency, members:[{id,name,me,hidden}], rates:{USD:0.92}, entries:[...] }
 *   entry     an expense  { type:"expense", amount, currency, rate, paidBy, split }
 *             or a payment { type:"payment", amount, currency, rate, from, to }
 *   rate      how many units of the GROUP currency one unit of the entry's
 *             currency was worth that day. 1 when both are the same.
 *   split     { mode:"equal", among:[ids] }  or
 *             { mode:"exact"|"shares"|"percent", parts:{ id: number } }
 *             exact  -> parts are minor units of the entry currency
 *             shares -> parts are relative weights (1, 2, 3 ...)
 *             percent-> parts add up to 100
 *   net       a member's balance: what they paid minus what they owe, in the
 *             group currency. Positive = others owe them; negative = they owe.
 */
( function ( root )
{
    "use strict";

    /* ISO 4217: code -> minor-unit digits. Not the whole standard - the ones
     * people actually travel with, plus every 0- and 3-decimal currency that
     * matters, so the picker is short and the maths never guesses. Anything not
     * listed is formatted with 2 decimals. The human name is NOT kept here: it
     * comes from Intl.DisplayNames in whatever language the interface is in. */
    var CURRENCIES = {
        EUR: 2,  USD: 2,  GBP: 2,  CHF: 2,  JPY: 0,  CNY: 2,
        CAD: 2,  AUD: 2,  NZD: 2,  MXN: 2,  ARS: 2,  BRL: 2,
        CLP: 0,  COP: 2,  PEN: 2,  UYU: 2,  BOB: 2,  PYG: 0,
        VES: 2,  DOP: 2,  CUP: 2,  GTQ: 2,  HNL: 2,  NIO: 2,
        CRC: 2,  PAB: 2,  SEK: 2,  NOK: 2,  DKK: 2,  ISK: 0,
        PLN: 2,  CZK: 2,  HUF: 2,  RON: 2,  BGN: 2,  TRY: 2,
        RUB: 2,  UAH: 2,  ILS: 2,  AED: 2,  SAR: 2,  QAR: 2,
        KWD: 3,  BHD: 3,  OMR: 3,  JOD: 3,  EGP: 2,  MAD: 2,
        TND: 3,  DZD: 2,  ZAR: 2,  NGN: 2,  KES: 2,  INR: 2,
        PKR: 2,  LKR: 2,  THB: 2,  VND: 0,  IDR: 2,  MYR: 2,
        SGD: 2,  PHP: 2,  KRW: 0,  TWD: 2,  HKD: 2
    };

    /* "EUR" -> "euro" / "Euro" / "euro"... in the interface language, straight
     * from the browser. Falls back to the code where Intl.DisplayNames is not
     * there (old Safari) or does not know the currency. */
    var _names = null;
    function currencyName( code )
    {
        try
        {
            if( _names === null )
                _names = typeof Intl !== "undefined" && Intl.DisplayNames
                       ? new Intl.DisplayNames( [ locale() ], { type: "currency" } ) : false;
            if( _names ) return _names.of( code ) || code;
        }
        catch ( e ) {}
        return code;
    }

    // Offered first in every currency picker, before the alphabetical rest.
    var FAVOURITES = [ "EUR", "USD", "GBP", "CHF", "JPY" ];

    var _locale = null;   // null = the browser's; setLocale() overrides (tests)

    function locale()
    {
        if( _locale ) return _locale;
        try { if( window.NayiveI18n ) return NayiveI18n.locale(); } catch ( e ) {}
        if( typeof navigator !== "undefined" && navigator.language ) return navigator.language;
        return "en";
    }

    function setLocale( l ) { _locale = l || null; }

    function codes()
    {
        return Object.keys( CURRENCIES ).sort();
    }

    function currency( code )
    {
        var c = String( code || "" ).toUpperCase();
        var row = CURRENCIES[ c ];
        return { code: c, name: currencyName( c ), digits: row != null ? row : 2 };
    }

    function digits( code ) { return currency( code ).digits; }

    function pow10( n ) { return Math.pow( 10, n ); }

    /* "12,30" / "12.30" / "1.234,56" / "1,234.56" / "1234" -> minor units, or
     * null when the text is not an amount. Negative numbers are not amounts.
     * A lone separator followed by exactly three digits is read as a thousands
     * separator ("1.234" = 1234) unless the currency really has 3 decimals. */
    function parseAmount( text, code )
    {
        var d = digits( code );
        var s = String( text == null ? "" : text ).replace( /\s+/g, "" );
        if( ! s ) return null;

        var lastComma = s.lastIndexOf( "," ), lastDot = s.lastIndexOf( "." );
        var sep = Math.max( lastComma, lastDot );
        var intPart, fracPart = "";

        if( sep === -1 )
        {
            intPart = s;
        }
        else
        {
            var sepChar = s.charAt( sep );
            var other   = sepChar === "," ? "." : ",";
            var head    = s.slice( 0, sep );
            if( head.indexOf( sepChar ) !== -1 ) return null;     // "1,2,3"
            intPart  = head.split( other ).join( "" );             // drop thousands separators
            fracPart = s.slice( sep + 1 );

            var onlyOne = s.indexOf( other ) === -1;
            if( onlyOne && fracPart.length === 3 && d < 3 )        // "1.234" is a thousand
            {
                intPart  = intPart + fracPart;
                fracPart = "";
            }
        }

        if( ! /^\d*$/.test( intPart ) || ! /^\d*$/.test( fracPart ) ) return null;
        if( ! intPart && ! fracPart ) return null;

        var value = Number( ( intPart || "0" ) + "." + ( fracPart || "0" ) );
        if( ! isFinite( value ) ) return null;
        return Math.round( value * pow10( d ) );
    }

    /* 1230 EUR -> "12,30 €" in the viewer's locale. opts.plus adds an explicit
     * "+" on positive amounts (balances); opts.code shows "EUR" instead of "€". */
    function formatAmount( minor, code, opts )
    {
        opts = opts || {};
        var d = digits( code );
        var n = ( minor || 0 ) / pow10( d );
        var s;
        try
        {
            s = new Intl.NumberFormat( locale(), {
                style: "currency", currency: currency( code ).code,
                currencyDisplay: opts.code ? "code" : "symbol",
                minimumFractionDigits: d, maximumFractionDigits: d
            } ).format( n );
        }
        catch ( e )
        {
            s = n.toFixed( d ) + " " + currency( code ).code;     // a code Intl does not know
        }
        s = s.replace( /-/, "−" );                            // a real minus sign
        if( opts.plus && minor > 0 ) s = "+" + s;
        return s;
    }

    /* 1230 -> "12,30" (or "12.30" with sep "."): a bare number for CSV files. */
    function toDecimal( minor, code, sep )
    {
        var d = digits( code );
        var s = ( ( minor || 0 ) / pow10( d ) ).toFixed( d );
        return sep === "," ? s.replace( ".", "," ) : s;
    }

    /* Split `total` (an integer) in proportion to `weights` so the parts are
     * integers that add up EXACTLY to total - the "largest remainder" method:
     * everyone gets the floor of their exact share, then the leftover units go
     * one by one to whoever lost the most in the rounding. A zero or negative
     * weight gets nothing. All weights zero -> all zeros (callers check). */
    function allocate( total, weights )
    {
        var n = weights.length;
        var out = new Array( n );
        var i;

        var sum = 0;
        var w = new Array( n );
        for( i = 0; i < n; i++ )
        {
            w[ i ] = Number( weights[ i ] );
            if( ! ( w[ i ] > 0 ) ) w[ i ] = 0;
            sum += w[ i ];
        }
        if( n === 0 || sum <= 0 )
        {
            for( i = 0; i < n; i++ ) out[ i ] = 0;
            return out;
        }

        var sign = total < 0 ? -1 : 1;
        var abs  = Math.abs( total );
        var given = 0;
        var rem = [];

        for( i = 0; i < n; i++ )
        {
            var exact = abs * w[ i ] / sum;
            var floor = Math.floor( exact );
            out[ i ] = floor;
            given   += floor;
            rem.push( { i: i, r: exact - floor } );
        }

        // Ties go to the earlier member, so the result is stable.
        rem.sort( function ( a, b ) { return b.r - a.r || a.i - b.i; } );

        var left = abs - given;
        for( i = 0; i < rem.length && left > 0; i++ )
        {
            if( w[ rem[ i ].i ] > 0 ) { out[ rem[ i ].i ] += 1; left--; }
        }

        if( sign < 0 ) for( i = 0; i < n; i++ ) out[ i ] = -out[ i ];
        return out;
    }

    /* Who takes part in an entry and with what weight: [ids], [weights]. */
    function participants( entry )
    {
        var sp   = entry.split || {};
        var mode = sp.mode || "equal";
        var ids, weights;

        if( mode === "equal" )
        {
            ids     = ( sp.among || [] ).slice();
            weights = ids.map( function () { return 1; } );
        }
        else
        {
            var parts = sp.parts || {};
            ids = Object.keys( parts ).filter( function ( id ) { return Number( parts[ id ] ) > 0; } );
            weights = ids.map( function ( id ) { return Number( parts[ id ] ); } );
        }
        return { ids: ids, weights: weights, mode: mode };
    }

    /* Each participant's share of an EXPENSE, in the entry's own currency:
     * { memberId: minor }. Always adds up to entry.amount. In "exact" mode the
     * typed parts are used as they are when they add up; if a file holds parts
     * that do not, they are scaled, so a balance is never silently wrong. */
    function shares( entry )
    {
        var p = participants( entry );
        var out = {};
        var i;

        if( p.mode === "exact" )
        {
            var sum = 0;
            for( i = 0; i < p.weights.length; i++ ) sum += Math.round( p.weights[ i ] );
            if( sum === entry.amount )
            {
                for( i = 0; i < p.ids.length; i++ ) out[ p.ids[ i ] ] = Math.round( p.weights[ i ] );
                return out;
            }
        }

        var alloc = allocate( entry.amount, p.weights );
        for( i = 0; i < p.ids.length; i++ ) out[ p.ids[ i ] ] = alloc[ i ];
        return out;
    }

    /* Minor units of `fromCode` -> minor units of `baseCode` at `rate` (units
     * of base per ONE unit of from). 4500 USD @0.92 -> 4140 EUR. */
    function toBase( minor, fromCode, rate, baseCode )
    {
        var fd = digits( fromCode ), bd = digits( baseCode );
        return Math.round( minor * Number( rate ) * pow10( bd ) / pow10( fd ) );
    }

    /* An entry's total in the group currency. */
    function entryBase( entry, baseCode )
    {
        if( ! entry.currency || entry.currency === baseCode ) return entry.amount;
        return toBase( entry.amount, entry.currency, entry.rate || 0, baseCode );
    }

    /* Each participant's share of an expense in the GROUP currency. The total
     * is converted once, then divided in the same proportions as the shares in
     * the entry currency - so the converted parts add up to the converted total
     * exactly, whatever the rounding did on either side. */
    function sharesBase( entry, baseCode )
    {
        var own = shares( entry );
        var ids = Object.keys( own );
        var alloc = allocate( entryBase( entry, baseCode ), ids.map( function ( id ) { return own[ id ]; } ) );
        var out = {};
        for( var i = 0; i < ids.length; i++ ) out[ ids[ i ] ] = alloc[ i ];
        return out;
    }

    function add( map, id, v )
    {
        if( ! id ) return;
        map[ id ] = ( map[ id ] || 0 ) + v;
    }

    function entries( group ) { return Array.isArray( group.entries ) ? group.entries : []; }

    /* Every member's net balance in the group currency. Paying raises your
     * balance, owing a share lowers it; a payment moves money from `from`
     * (balance up - they owe less) to `to` (balance down - they are owed less).
     * The map always sums to zero. */
    function balances( group )
    {
        var base = group.currency;
        var net  = {};
        ( group.members || [] ).forEach( function ( m ) { net[ m.id ] = 0; } );

        entries( group ).forEach( function ( e )
        {
            if( e.type === "payment" )
            {
                var a = entryBase( e, base );
                add( net, e.from, a );
                add( net, e.to,  -a );
            }
            else
            {
                add( net, e.paidBy, entryBase( e, base ) );
                var sh = sharesBase( e, base );
                Object.keys( sh ).forEach( function ( id ) { add( net, id, -sh[ id ] ); } );
            }
        } );
        return net;
    }

    /* The same, but with NO conversion: one balance map per currency that
     * appears in the entries. { EUR: {id: net}, USD: {id: net} } */
    function balancesByCurrency( group )
    {
        var out = {};
        function bucket( code )
        {
            if( ! out[ code ] )
            {
                out[ code ] = {};
                ( group.members || [] ).forEach( function ( m ) { out[ code ][ m.id ] = 0; } );
            }
            return out[ code ];
        }

        entries( group ).forEach( function ( e )
        {
            var code = e.currency || group.currency;
            var net  = bucket( code );
            if( e.type === "payment" )
            {
                add( net, e.from, e.amount );
                add( net, e.to,  -e.amount );
            }
            else
            {
                add( net, e.paidBy, e.amount );
                var sh = shares( e );
                Object.keys( sh ).forEach( function ( id ) { add( net, id, -sh[ id ] ); } );
            }
        } );
        return out;
    }

    /* Turn a balance map into the fewest transfers that settle it:
     * [ { from, to, amount } ]. Greedy: the biggest debtor pays the biggest
     * creditor as much as either can, repeat. Never more than (people - 1)
     * transfers, and no one pays anyone they do not need to. */
    function settle( net )
    {
        var debtors = [], creditors = [];
        Object.keys( net ).forEach( function ( id )
        {
            var v = net[ id ];
            if( v < 0 ) debtors.push( { id: id, amt: -v } );
            else if( v > 0 ) creditors.push( { id: id, amt: v } );
        } );
        var byAmt = function ( a, b ) { return b.amt - a.amt || ( a.id < b.id ? -1 : 1 ); };
        debtors.sort( byAmt );
        creditors.sort( byAmt );

        var out = [];
        var i = 0, j = 0;
        while( i < debtors.length && j < creditors.length )
        {
            var pay = Math.min( debtors[ i ].amt, creditors[ j ].amt );
            if( pay > 0 ) out.push( { from: debtors[ i ].id, to: creditors[ j ].id, amount: pay } );
            debtors[ i ].amt   -= pay;
            creditors[ j ].amt -= pay;
            if( debtors[ i ].amt === 0 ) i++;
            if( creditors[ j ].amt === 0 ) j++;
        }
        return out;
    }

    /* Per member, what they paid and what their share of the expenses is, in
     * the group currency (payments left out - they are settlements, not
     * spending). Plus the group total. */
    function memberTotals( group )
    {
        var base = group.currency;
        var out  = { total: 0, members: {} };
        function row( id )
        {
            if( ! out.members[ id ] ) out.members[ id ] = { paid: 0, share: 0 };
            return out.members[ id ];
        }
        ( group.members || [] ).forEach( function ( m ) { row( m.id ); } );

        entries( group ).forEach( function ( e )
        {
            if( e.type === "payment" ) return;
            var total = entryBase( e, base );
            out.total += total;
            if( e.paidBy ) row( e.paidBy ).paid += total;
            var sh = sharesBase( e, base );
            Object.keys( sh ).forEach( function ( id ) { row( id ).share += sh[ id ]; } );
        } );
        return out;
    }

    /* True when a member appears anywhere in the entries - then they cannot
     * be removed from the group, only hidden. */
    function hasMovements( group, memberId )
    {
        return entries( group ).some( function ( e )
        {
            if( e.paidBy === memberId || e.from === memberId || e.to === memberId ) return true;
            var sp = e.split || {};
            if( ( sp.among || [] ).indexOf( memberId ) !== -1 ) return true;
            return !! ( sp.parts && Number( sp.parts[ memberId ] ) > 0 );
        } );
    }

    /* Every currency the group's entries use, the group's own first. */
    function usedCurrencies( group )
    {
        var seen = {}, out = [];
        function push( c ) { if( c && ! seen[ c ] ) { seen[ c ] = true; out.push( c ); } }
        push( group.currency );
        entries( group ).forEach( function ( e ) { push( e.currency ); } );
        return out;
    }

    var api = {
        CURRENCIES: CURRENCIES, FAVOURITES: FAVOURITES,
        codes: codes, currency: currency, digits: digits,
        parseAmount: parseAmount, formatAmount: formatAmount, toDecimal: toDecimal,
        setLocale: setLocale,
        allocate: allocate, participants: participants, shares: shares,
        toBase: toBase, entryBase: entryBase, sharesBase: sharesBase,
        balances: balances, balancesByCurrency: balancesByCurrency, settle: settle,
        memberTotals: memberTotals, hasMovements: hasMovements, usedCurrencies: usedCurrencies
    };

    root.SplitMoney = api;
    if( typeof module !== "undefined" && module.exports ) module.exports = api;

} )( typeof window !== "undefined" ? window : this );
