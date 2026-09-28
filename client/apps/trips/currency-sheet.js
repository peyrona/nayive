/* currency-sheet.js - the currency sheet. */

//------------------------------------------------------------------------//
// RENDERING - CURRENCY SHEET

function renderCurrencySheet()
{
    const trip  = findTrip( selectedTripId );
    const sheet = document.getElementById( 'currencySheet' );
    sheet.innerHTML = '';

    if( ! trip )
        return;

    buildSheetHeader( T( 'trips.currency' ), 'currencySheetBackdrop', sheet );

    if( ! currencyLookup )
    {
        const loading = document.createElement( 'p' );
        loading.className = 'calc-rate';
        loading.textContent = T( 'trips.fxChecking' );
        sheet.appendChild( loading );
        return;
    }

    const lookup = currencyLookup;

    if( ! lookup.matched )
    {
        const notMatched = document.createElement( 'p' );
        notMatched.className = 'calc-warn';
        notMatched.textContent = TF( 'trips.fxNoCurrency', { place: currencyContextName || trip.destination } );
        sheet.appendChild( notMatched );
    }

    const sourceList = document.createElement( 'div' );
    sourceList.className = 'calc-sources';
    lookup.results.forEach( function( r )
    {
        const row = document.createElement( 'div' );
        row.className = 'calc-source-row';
        const name = document.createElement( 'span' );
        name.textContent = r.source;
        const val = document.createElement( 'span' );
        val.textContent = r.ok ? TF( 'trips.fxRate', { rate: r.rate.toFixed( 4 ), code: lookup.code } )
                               : TF( 'trips.fxUnavailable', { reason: r.reason } );
        row.appendChild( name );
        row.appendChild( val );
        sourceList.appendChild( row );
    });
    sheet.appendChild( sourceList );

    if( lookup.verified )
    {
        const asOf = lookup.verified.sourceA.asOf || lookup.verified.sourceB.asOf;
        const rateNote = document.createElement( 'p' );
        rateNote.className = 'calc-rate';
        rateNote.textContent = TF( 'trips.fxVerified', {
            a: lookup.verified.sourceA.source, b: lookup.verified.sourceB.source,
            tol: rateToleranceText( lookup.verified.sourceA.rate, lookup.verified.sourceB.rate ),
            rate: lookup.verified.rate.toFixed( 4 ), code: lookup.code } )
            + ( asOf ? TF( 'trips.fxAsOf', { date: asOf } ) : '' ) + '.';
        sheet.appendChild( rateNote );
    }
    else
    {
        const warn = document.createElement( 'p' );
        warn.className = 'calc-warn';
        warn.textContent = lookup.compared.length
            ? TF( 'trips.fxUnverified', { tol: rateToleranceText( lookup.compared[ lookup.compared.length - 1 ].a.rate,
                                                                 lookup.compared[ lookup.compared.length - 1 ].b.rate ) } )
            : T( 'trips.fxNoSource' );
        sheet.appendChild( warn );
    }

    const localField = document.createElement( 'div' );
    localField.className = 'field';
    const localLabel = document.createElement( 'label' );
    localLabel.textContent = TF( 'trips.amountIn', { name: currencyName( lookup.code ), code: lookup.code } );
    const localInput = document.createElement( 'input' );
    localInput.type = 'number';
    localInput.placeholder = '0.00';
    localInput.value = calcLocal;
    localInput.disabled = ! lookup.verified;
    localInput.addEventListener( 'input', function() { calcOnLocalChange( localInput.value ); } );
    localField.appendChild( localLabel );
    localField.appendChild( localInput );
    sheet.appendChild( localField );

    const eurField = document.createElement( 'div' );
    eurField.className = 'field';
    const eurLabel = document.createElement( 'label' );
    eurLabel.textContent = T( 'trips.amountInEur' );
    const eurInput = document.createElement( 'input' );
    eurInput.type = 'number';
    eurInput.placeholder = '0.00';
    eurInput.value = calcEur;
    eurInput.disabled = ! lookup.verified;
    eurInput.addEventListener( 'input', function() { calcOnEurChange( eurInput.value ); } );
    eurField.appendChild( eurLabel );
    eurField.appendChild( eurInput );
    sheet.appendChild( eurField );
}
