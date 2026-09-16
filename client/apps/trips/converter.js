/* converter.js - currency converter: state and sums. */

//------------------------------------------------------------------------//
// CURRENCY CONVERTER

let calcLocal      = '';
let calcEur        = '';
let currencyLookup = null;   // null while loading; see lookupExchangeRate() for shape
let currencyContextName = '';   // place name shown in the sheet's "couldn't determine" note

// codeArg/matchedArg/contextName are passed by a per-stage converter button; with no
// args (the header button) the currency is derived from the trip's stages or destination.
function openCurrency( codeArg, matchedArg, contextName )
{
    const trip = findTrip( selectedTripId );

    if( ! trip )
        return;

    calcLocal      = '';
    calcEur        = '';
    currencyLookup = null;

    let code, matched;

    if( codeArg )
    {
        code    = codeArg;
        matched = matchedArg !== false;
        currencyContextName = contextName || trip.destination;
    }
    else if( (trip.stages || []).length )
    {
        const c = stageCurrency( trip.stages[ 0 ] );
        code    = c.code;
        matched = c.matched;
        currencyContextName = trip.stages[ 0 ].location || trip.destination;
    }
    else
    {
        const d = detectCurrency( trip.destination );
        code    = d.code;
        matched = d.matched;
        currencyContextName = trip.destination;
    }

    renderCurrencySheet();   // shows the loading state
    openSheet( 'currencySheetBackdrop' );

    const mySheetOpenAt = ++currencyLookupSeq;

    lookupExchangeRate( code, matched ).then( function( result )
    {
        if( mySheetOpenAt !== currencyLookupSeq )
            return;   // sheet was reopened (or a different trip) before this resolved - discard

        currencyLookup = result;
        renderCurrencySheet();
    });
}

let currencyLookupSeq = 0;

function calcOnLocalChange( sVal )
{
    if( ! currencyLookup || ! currencyLookup.verified )
        return;   // no verified rate - the fields stay disabled, this should not fire

    const rate = currencyLookup.verified.rate;
    const n    = parseFloat( sVal );

    calcLocal = sVal;
    calcEur   = (sVal === '' || isNaN( n )) ? '' : String( round2( n / rate ) );
    renderCurrencySheet();
}

function calcOnEurChange( sVal )
{
    if( ! currencyLookup || ! currencyLookup.verified )
        return;

    const rate = currencyLookup.verified.rate;
    const n    = parseFloat( sVal );

    calcEur   = sVal;
    calcLocal = (sVal === '' || isNaN( n )) ? '' : String( round2( n * rate ) );
    renderCurrencySheet();
}
