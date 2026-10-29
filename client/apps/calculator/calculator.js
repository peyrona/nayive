/* calculator.js - Calculator: the arithmetic, the screen, the history and the
 * currency mode. The rates are shared/fx.js's (NayiveFx).
 *
 * Arithmetic, phone style: × and ÷ before + and −; "=" again repeats the last
 * operation; "%" after + or − takes that percentage of what comes before
 * (50 + 10 % = 55); up to 9 typed digits; results tidied to 12 significant
 * digits, very big or tiny ones in exponent form; ÷ 0 shows the error. The
 * eraser always clears everything, ⌫ deletes one digit.
 *
 * Currency mode: the typed amount on the bottom line, in the "from" currency;
 * the converted one above it, in the "to" currency's own decimals, at the
 * verified rate; above both, the rate and its day (a tap shows how it was
 * checked). No verified rate: "—", never a guess.
 */

'use strict';

const $  = function( id ) { return document.getElementById( id ); };
const T  = function( k ) { return Ayni.t( k ); };
const TF = function( k, o ) { return Ayni.tf( k, o ); };

const MAX_DIGITS  = 9;
const MAX_HISTORY = 50;
const KEY_HISTORY = 'balata-calculator-history';
const KEY_PREFS   = 'balata-calculator';      // { mode, from, to }: this device's last choice

const OPS    = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const KEYMAP = { ',': 'dot', '.': 'dot', '+': '+', '-': '-', '*': '*', x: '*', X: '*', '/': '/', '÷': '/', '=': '=', Enter: '=',
                 Escape: 'clear', Delete: 'clear', Backspace: 'back', '%': 'percent', F9: 'sign' };

let LOCALE = 'es';
let DEC    = ',';     // the interface language's decimal mark

//------------------------------------------------------------------------//
// STATE

let tokens   = [];      // numbers and operators already closed: [ 2, '+', 3, '*' ]
let entry    = null;    // the number being typed, as text ("12.5"), or null
let shown    = 0;       // the value shown when nothing is being typed
let lastOp   = null;    // { op, val } that "=" repeats
let done     = false;   // "=" was just pressed
let error    = false;
let exprText = '';
let hist     = [];    // [ { expr, result } ], newest first

let mode = 'arith';     // 'arith' | 'fx'
let from = 'EUR';
let to   = 'USD';
let guessPlace = '';    // Trips could not tell this place's currency

//------------------------------------------------------------------------//
// ARITHMETIC

function tidy( x )  { return Object.is( x, -0 ) ? 0 : Number( x.toPrecision( 12 ) ); }
function isOp( t )  { return typeof t === 'string'; }
// A number as text to keep typing on, without exponent notation.
function plain( x ) { return String( x ).includes( 'e' ) ? x.toLocaleString( 'en-US', { useGrouping: false, maximumFractionDigits: 20 } ) : String( x ); }

function apply( a, op, b )
{
    if( op === '/' && b === 0 ) throw new Error( 'div0' );
    return tidy( op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b );
}

// [ n, op, n, op, n… ] with × and ÷ first.
function evaluate( ts )
{
    const sum = [];
    let acc = ts[ 0 ];

    for( let i = 1; i < ts.length; i += 2 )
    {
        const op = ts[ i ], n = ts[ i + 1 ];
        if( op === '*' || op === '/' ) acc = apply( acc, op, n );
        else { sum.push( acc, op ); acc = n; }
    }
    sum.push( acc );

    let r = sum[ 0 ];
    for( let i = 1; i < sum.length; i += 2 ) r = apply( r, sum[ i ], sum[ i + 1 ] );
    return r;
}

function current() { return entry !== null ? Number( entry ) : shown; }
function reset()   { tokens = []; entry = null; shown = 0; lastOp = null; done = false; error = false; exprText = ''; }
function fresh()   { if( error || done ) { const keep = shown, err = error; reset(); shown = err ? 0 : keep; } }
function digitCount() { return entry.replace( /[-.]/g, '' ).length; }

function digit( d )
{
    if( error || done ) reset();
    if( entry === null || entry === '0' || entry === '-0' ) entry = ( entry === '-0' ? '-' : '' ) + d;
    else if( digitCount() < MAX_DIGITS ) entry += d;
}

function dot()
{
    if( error || done ) reset();
    if( entry === null ) entry = '0.';
    else if( ! entry.includes( '.' ) && digitCount() < MAX_DIGITS ) entry += '.';
}

function operator( op )
{
    fresh();
    if( entry !== null ) { tokens.push( Number( entry ) ); entry = null; }
    else if( isOp( tokens[ tokens.length - 1 ] ) ) tokens.pop();
    else if( ! tokens.length ) tokens.push( shown );

    // The partial result, as a phone shows it: with + or − everything before;
    // with × or ÷ only the last run of × and ÷.
    let start = 0;
    if( op === '*' || op === '/' )
        for( let i = tokens.length - 2; i > 0; i -= 2 )
            if( tokens[ i ] === '+' || tokens[ i ] === '-' ) { start = i + 1; break; }

    try { shown = evaluate( tokens.slice( start ) ); }
    catch( e ) { fail(); return; }
    tokens.push( op );
}

function equals()
{
    if( error ) return;
    let ts;

    if( done )
    {
        if( ! lastOp ) return;
        ts = [ shown, lastOp.op, lastOp.val ];
    }
    else
    {
        ts = tokens.slice();
        if( entry !== null ) ts.push( Number( entry ) );
        else if( isOp( ts[ ts.length - 1 ] ) ) ts.push( shown );   // 5 + = -> 10
        if( ts.length < 3 )
        {
            if( entry !== null ) { shown = Number( entry ); entry = null; }
            return;
        }
        lastOp = { op: ts[ ts.length - 2 ], val: ts[ ts.length - 1 ] };
    }

    const expr = fmtTokens( ts ) + ' =';
    let r;
    try { r = evaluate( ts ); }
    catch( e ) { fail( expr ); return; }

    addHistory( expr, r );
    tokens = []; entry = null; shown = r; done = true; exprText = expr;
}

function fail( expr ) { reset(); error = true; exprText = expr || ''; }

function sign()
{
    if( error ) return;
    if( entry === null )
    {
        if( done ) { shown = tidy( -shown ); exprText = ''; done = false; return; }
        entry = plain( shown );
    }
    entry = entry.startsWith( '-' ) ? entry.slice( 1 ) : '-' + entry;
}

function percent()
{
    if( error ) return;
    const x = current(), prevOp = isOp( tokens[ tokens.length - 1 ] ) ? tokens[ tokens.length - 1 ] : null;
    let r = x / 100;

    if( prevOp === '+' || prevOp === '-' )
    {
        try { r = evaluate( tokens.slice( 0, -1 ) ) * x / 100; }   // of what comes before the + or −
        catch( e ) { fail(); return; }
    }
    if( done ) { done = false; exprText = ''; }
    entry = plain( tidy( r ) );
}

function back()
{
    if( entry === null || error ) return;
    entry = entry.slice( 0, -1 );
    if( entry === '' || entry === '-' ) entry = '0';
}

// One key, from the keypad, the keyboard or the tests (window.calcPress).
function press( k )
{
    if( /^\d$/.test( k ) )   digit( k );
    else if( k === 'dot' )   dot();
    else if( k in OPS )      operator( k );
    else if( k === '=' )     equals();
    else if( k === 'clear' ) reset();
    else if( k === 'sign' )  sign();
    else if( k === 'percent' ) percent();
    else if( k === 'back' )  back();
    else return;
    render();
}

//------------------------------------------------------------------------//
// FORMATTING - in the interface language (1.234,5 in Spanish, 1,234.5 in English)

function fmtNum( x )
{
    if( ! isFinite( x ) ) return T( 'calculator.error' );
    const abs = Math.abs( x );
    if( abs !== 0 && ( abs >= 1e9 || abs < 1e-8 ) )
        return x.toExponential( 5 ).replace( /\.?0+e/, 'e' ).replace( '.', DEC ).replace( 'e+', 'e' );
    const intDigits = Math.max( 1, Math.floor( Math.log10( abs || 1 ) ) + 1 );
    return new Intl.NumberFormat( LOCALE, { maximumFractionDigits: Math.max( 0, MAX_DIGITS - intDigits ), useGrouping: 'always' } ).format( x );
}

function fmtEntry( s )
{
    const neg = s.startsWith( '-' ), parts = s.replace( '-', '' ).split( '.' );
    const int = new Intl.NumberFormat( LOCALE, { useGrouping: 'always' } ).format( Number( parts[ 0 ] ) );
    return ( neg ? '-' : '' ) + int + ( parts[ 1 ] !== undefined ? DEC + parts[ 1 ] : '' );
}

// In the currency's own decimals: 2 for most, none for JPY or CLP.
function fmtMoney( x, code )
{
    const dp = NayiveFx.digits( code );
    return Math.abs( x ) >= 1e12 ? fmtNum( x )
         : new Intl.NumberFormat( LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp, useGrouping: 'always' } ).format( x );
}

function fmtTokens( ts ) { return ts.map( function( t ) { return isOp( t ) ? OPS[ t ] : fmtNum( t ); } ).join( ' ' ); }

function fmtRate( k ) { return k.toLocaleString( LOCALE, { maximumSignificantDigits: 5 } ); }

//------------------------------------------------------------------------//
// SCREEN

// Shrinks a line's font until the number (and its currency symbol) fits.
function fitOne( d )
{
    d.style.fontSize = '';
    const line = d.parentElement, sym = line.querySelector( '.sym' );
    const max  = line.clientWidth - ( sym && sym.offsetWidth ? sym.offsetWidth + 12 : 0 );
    let size   = parseFloat( getComputedStyle( d ).fontSize );
    while( d.scrollWidth > max && size > 18 ) { size -= 2; d.style.fontSize = size + 'px'; }
}

function fit() { fitOne( $( 'display' ) ); if( mode === 'fx' ) fitOne( $( 'displayTo' ) ); }

function render()
{
    $( 'display' ).textContent = error ? T( 'calculator.error' ) : entry !== null ? fmtEntry( entry ) : fmtNum( shown );
    if( ! done && ! error ) exprText = [ fmtTokens( tokens ), entry !== null ? fmtEntry( entry ) : '' ].filter( Boolean ).join( ' ' );
    $( 'expr' ).textContent = exprText;

    // The pending operator stays lit until the next number starts.
    const pending = entry === null && isOp( tokens[ tokens.length - 1 ] ) ? tokens[ tokens.length - 1 ] : null;
    document.querySelectorAll( '#keys .op' ).forEach( function( b ) { b.setAttribute( 'aria-pressed', b.dataset.k === pending ); } );

    renderFx();
    fit();
}

//------------------------------------------------------------------------//
// CURRENCY MODE

function converted()
{
    if( error ) return null;
    const r = NayiveFx.convert( current(), from, to );
    return r === null || ! isFinite( r ) ? null : tidy( r );
}

// The line over the amounts: the rate and its day, or why there is none.
function noteText()
{
    const day = NayiveFx.date();
    if( ! day ) return NayiveFx.offline() ? T( 'calculator.fxNoRates' ) : T( 'calculator.fxLoading' );

    const k   = NayiveFx.rate( from, to );
    const off = NayiveFx.offline() ? ' · ' + T( 'calculator.fxOffline' ) : '';
    if( k === null )  return TF( 'calculator.fxNoRate', { pair: from + '/' + to } ) + ' · ' + day + off;
    if( from === to ) return TF( 'calculator.fxRatesOf', { date: day } ) + off;
    return '1 ' + from + ' = ' + fmtRate( k ) + ' ' + to + ' · ' + day + off;
}

function renderFx()
{
    if( mode !== 'fx' ) return;
    $( 'symFrom' ).textContent = NayiveFx.symbol( from );
    $( 'symTo'   ).textContent = NayiveFx.symbol( to );
    const r = converted();
    $( 'displayTo' ).textContent = r === null ? '—' : fmtMoney( r, to );
    $( 'fxNote' ).textContent = noteText();
    $( 'fxNote' ).classList.toggle( 'warn', NayiveFx.rate( from, to ) === null );
    $( 'fxGuess' ).hidden = ! guessPlace;
    if( guessPlace ) $( 'fxGuess' ).textContent = TF( 'calculator.fxNoCurrency', { place: guessPlace } );
}

function fillCurrencies()
{
    const list = NayiveFx.CODES.slice().sort( function( a, b ) { return NayiveFx.name( a ).localeCompare( NayiveFx.name( b ), LOCALE ); } );
    [ 'fxFrom', 'fxTo' ].forEach( function( id )
    {
        $( id ).replaceChildren.apply( $( id ), list.map( function( c )
        {
            const o = document.createElement( 'option' );
            o.value = c;
            o.textContent = c + ' · ' + NayiveFx.name( c );
            return o;
        } ) );
    } );
}

function setCurrencies( f, t )
{
    if( NayiveFx.CODES.includes( f ) ) from = f;
    if( NayiveFx.CODES.includes( t ) ) to   = t;
    $( 'fxFrom' ).value = from;
    $( 'fxTo'   ).value = to;
    savePrefs();
    render();
}

function setMode( m )
{
    mode = m === 'fx' ? 'fx' : 'arith';
    $( 'calc' ).dataset.mode = mode;
    document.querySelector( '#modeSwitch input[value="' + mode + '"]' ).checked = true;
    if( mode === 'fx' ) NayiveFx.start();
    savePrefs();
    render();
}

// What each source said for the pair's currencies, and which pair agreed.
// Same words as Trips' old converter sheet.
function renderCheck()
{
    const body  = $( 'fxCheckBody' );
    const h     = NayiveUI.h;
    const codes = [ from, to ].filter( function( c, i, a ) { return c !== 'EUR' && a.indexOf( c ) === i; } );
    const kids  = [];

    if( ! NayiveFx.date() )
        kids.push( h( 'p', { class: 'dim-note', text: noteText() } ) );
    else if( ! codes.length )
        kids.push( h( 'p', { class: 'dim-note', text: T( 'calculator.fxBase' ) } ) );

    codes.forEach( function( code )
    {
        if( ! NayiveFx.date() ) return;
        const lookup = NayiveFx.check( code );
        kids.push( h( 'h3', { class: 'fx-code', text: code + ' · ' + NayiveFx.name( code ) } ) );
        kids.push( h( 'div', { class: 'fx-sources' }, lookup.results.map( function( r )
        {
            return h( 'div', { class: 'fx-source-row' }, [
                h( 'span', { text: r.source } ),
                h( 'span', { text: r.ok ? TF( 'calculator.fxRate', { rate: r.rate.toFixed( 4 ), code: code } )
                                        : TF( 'calculator.fxUnavailable', { reason: r.reason } ) } ) ] );
        } ) ) );

        if( lookup.verified )
        {
            const v    = lookup.verified;
            const asOf = v.sourceA.asOf || v.sourceB.asOf;
            kids.push( h( 'p', { class: 'dim-note', text: TF( 'calculator.fxVerified', {
                a: v.sourceA.source, b: v.sourceB.source,
                tol: NayiveFx.toleranceText( v.sourceA.rate, v.sourceB.rate ),
                rate: v.rate.toFixed( 4 ), code: code } ) + ( asOf ? TF( 'calculator.fxAsOf', { date: asOf } ) : '' ) + '.' } ) );
        }
        else
        {
            const last = lookup.compared[ lookup.compared.length - 1 ];
            kids.push( h( 'p', { class: 'warn-box', text: last
                ? TF( 'calculator.fxUnverified', { tol: NayiveFx.toleranceText( last.a.rate, last.b.rate ) } )
                : T( 'calculator.fxNoSource' ) } ) );
        }
    } );

    body.replaceChildren.apply( body, kids );
}

//------------------------------------------------------------------------//
// HISTORY - this device only

function saveHistory() { try { localStorage.setItem( KEY_HISTORY, JSON.stringify( hist ) ); } catch( e ) {} }

function addHistory( expr, result )
{
    hist.unshift( { expr: expr, result: result } );
    hist.length = Math.min( hist.length, MAX_HISTORY );
    saveHistory();
}

function renderHistory()
{
    $( 'histList' ).replaceChildren.apply( $( 'histList' ), hist.map( function( it )
    {
        const b = NayiveUI.h( 'button', { attrs: { type: 'button', 'aria-label': it.expr + ' ' + fmtNum( it.result ) }, data: { value: it.result } }, [
            NayiveUI.h( 'span', { class: 'h-expr', text: it.expr } ),
            NayiveUI.h( 'span', { class: 'h-res',  text: fmtNum( it.result ) } ) ] );
        return NayiveUI.h( 'li', {}, [ b ] );
    } ) );
    $( 'histEmpty' ).hidden = hist.length > 0;
    $( 'histClearBtn' ).ariaDisabled = hist.length === 0;
}

// A result from the history becomes the number being typed.
function useValue( v )
{
    if( error || done ) reset();
    entry = plain( Number( v ) );
    render();
}

//------------------------------------------------------------------------//
// PREFERENCES AND THE ADDRESS - ?mode=fx&from=JPY&to=EUR&place=… (Trips)

function savePrefs() { try { localStorage.setItem( KEY_PREFS, JSON.stringify( { mode: mode, from: from, to: to } ) ); } catch( e ) {} }

function loadPrefs()
{
    try
    {
        const p = JSON.parse( localStorage.getItem( KEY_PREFS ) ) || {};
        if( p.mode ) mode = p.mode;
        if( NayiveFx.CODES.includes( p.from ) ) from = p.from;
        if( NayiveFx.CODES.includes( p.to ) )   to   = p.to;
    }
    catch( e ) {}

    const q = new URLSearchParams( location.search );
    if( q.get( 'mode' ) ) mode = q.get( 'mode' );
    if( NayiveFx.CODES.includes( q.get( 'from' ) ) ) from = q.get( 'from' );
    if( NayiveFx.CODES.includes( q.get( 'to' ) ) )   to   = q.get( 'to' );
    guessPlace = q.get( 'place' ) || '';
    return q.has( 'from' );   // opened by another app
}

// ← : back to the app that opened this page (a phone), or the tab closes.
function leave()
{
    if( window.history.length > 1 ) { window.history.back(); return; }
    window.close();
    setTimeout( function() { location.href = '../index.html'; }, 400 );
}

//------------------------------------------------------------------------//
// WIRING

function flash( k )
{
    const b = document.querySelector( '#keys [data-k="' + CSS.escape( k ) + '"]' );
    if( b ) { b.classList.add( 'flash' ); setTimeout( function() { b.classList.remove( 'flash' ); }, 120 ); }
}

Ayni.i18n.ready.then( function()
{
    LOCALE = Ayni.i18n.lang();
    DEC    = ( new Intl.NumberFormat( LOCALE ).formatToParts( 1.5 ).find( function( p ) { return p.type === 'decimal'; } ) || { value: ',' } ).value;

    $( 'backBtn' ).innerHTML = Ayni.icon( 'back' );
    $( 'keys' ).querySelector( '[data-k="clear"]' ).innerHTML = Ayni.icon( 'eraser' );
    $( 'keys' ).querySelector( '[data-k="dot"]' ).textContent = DEC;

    try { hist = JSON.parse( localStorage.getItem( KEY_HISTORY ) ) || []; } catch( e ) { hist = []; }

    fillCurrencies();
    const opened = loadPrefs();
    $( 'fxFrom' ).value = from;
    $( 'fxTo'   ).value = to;
    $( 'backBtn' ).hidden = ! opened || NayiveUI.windowed;

    $( 'keys' ).addEventListener( 'click', function( e ) { const b = e.target.closest( '.key' ); if( b ) press( b.dataset.k ); } );

    document.addEventListener( 'keydown', function( e )
    {
        if( e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey ) return;
        if( e.target.closest && e.target.closest( 'input, select, textarea, dialog' ) ) return;
        if( document.querySelector( 'dialog.panel[open]' ) ) return;
        const k = /^\d$/.test( e.key ) ? e.key : KEYMAP[ e.key ];
        if( ! k ) return;
        if( k === '=' && e.target.closest && e.target.closest( 'button:not(.key)' ) ) return;   // Enter on another button presses that button
        e.preventDefault();
        press( k );
        flash( k );
    } );

    // The mode switch (Ayni's .switch-pair): an icon, the track or Left / Right pick a side.
    $( 'modeSwitch' ).addEventListener( 'change', function( e ) { setMode( e.target.value ); } );

    $( 'fxFrom' ).addEventListener( 'change', function() { guessPlace = ''; setCurrencies( this.value, to ); } );
    $( 'fxTo'   ).addEventListener( 'change', function() { guessPlace = ''; setCurrencies( from, this.value ); } );
    $( 'fxSwap' ).addEventListener( 'click',  function() { setCurrencies( to, from ); } );
    $( 'fxNote' ).addEventListener( 'click',  function() { renderCheck(); document.getElementById( 'fxCheckBackdrop' ).showModal(); } );
    NayiveFx.onChange( function() { render(); if( $( 'fxCheckBackdrop' ).open ) renderCheck(); } );

    $( 'histBtn' ).addEventListener( 'click', function() { renderHistory(); document.getElementById( 'histBackdrop' ).showModal(); } );
    $( 'histList' ).addEventListener( 'click', function( e )
    {
        const b = e.target.closest( 'button' );
        if( ! b ) return;
        document.getElementById( 'histBackdrop' ).close();
        useValue( b.dataset.value );
    } );
    $( 'histClearBtn' ).addEventListener( 'click', function() { hist = []; saveHistory(); renderHistory(); } );

    $( 'backBtn' ).addEventListener( 'click', leave );
    window.addEventListener( 'resize', fit );

    setMode( mode );

    const rows = [ { sel: '#histBtn', text: T( 'calculator.introHistory' ) } ];
    if( ! $( 'backBtn' ).hidden ) rows.unshift( { sel: '#backBtn', icon: 'back', text: T( 'calculator.introBack' ) } );
    NayiveUI.firstRun( { app: 'calculator', title: 'Calculator', lead: T( 'calculator.introLead' ), buttons: rows,
        // The guided tour: the two modes, the keypad, then the currency parts.
        tour: [ 'buttons',
                { sel: '#modeSwitch', text: T( 'calculator.tourModes' ) },
                { sel: '#keys',     text: T( 'calculator.tourKeys' ) },
                // hidden in arithmetic mode: then the Currency tab stands in for them
                { sel: '#fxBar',    ghost: '#modeSwitch [data-mode="fx"]', text: T( 'calculator.tourCurrencies' ) },
                { sel: '#fxNote',   ghost: '#modeSwitch [data-mode="fx"]', text: T( 'calculator.tourNote' ) } ] } );

    // For the tests and the console: the state as shown.
    window.calcPress = function( keys ) { [].concat( keys ).forEach( press ); return { text: $( 'display' ).textContent, expr: exprText }; };
} );
