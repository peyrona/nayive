/*
 * gen.js - Passwords: making passwords, and checking them.
 *
 *   genChars( opts )  random characters: length 8-64, the sets asked for, one
 *                     of each set at least; "no look-alikes" drops 0 O o 1 l I |
 *   genWords( opts )  a passphrase of 3-10 words from the EFF large list
 *                     (7 776 words, ~12.9 bits each; lib/eff-large-words.txt,
 *                     the words of eff.org's eff_large_wordlist.txt, CC BY 3.0 US,
 *                     sha256 addd3553…996b903e of the original) -> a promise
 *   leakCount( pw )   Have I Been Pwned, k-anonymity: only the first 5 hex
 *                     characters of the password's SHA-1 leave the browser,
 *                     with padding -> how many leaks, 0, or -1 (no answer)
 *   predictable( pw ) one character over and over, a run (abcd…, 9876…), one
 *                     short piece repeated
 *
 * Every random number is crypto.getRandomValues with rejection sampling, so
 * no character or word is likelier than another.
 */
"use strict";

const SETS = {
    lower:   'abcdefghijklmnopqrstuvwxyz',
    upper:   'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digits:  '0123456789',
    symbols: '!#$%&*+-=?@^_~.:,;()[]{}<>/'
};
const LOOKALIKE = /[0Oo1lI|]/g;
const GEN_DEF = { mode: 'chars', len: 20, lower: true, upper: true, digits: true, symbols: true, noLook: false,
                  count: 5, sep: '-', caps: true, num: true };

// A uniform whole number in [0, n).
function randInt( n )
{
    const lim = Math.floor( 0x100000000 / n ) * n;
    const buf = new Uint32Array( 1 );
    do window.crypto.getRandomValues( buf ); while( buf[ 0 ] >= lim );
    return buf[ 0 ] % n;
}

function genChars( o )
{
    const sets = [ 'lower', 'upper', 'digits', 'symbols' ].filter( function( k ) { return o[ k ]; } )
                    .map( function( k ) { return o.noLook ? SETS[ k ].replace( LOOKALIKE, '' ) : SETS[ k ]; } );
    if( ! sets.length ) sets.push( SETS.lower );
    const pool = sets.join( '' );
    const len  = Math.max( 8, Math.min( 64, o.len | 0 ) );
    let out;
    // Drawn again until every set chosen is in it: still uniform over the
    // passwords that qualify.
    do
    {
        out = '';
        for( let i = 0; i < len; i++ ) out += pool[ randInt( pool.length ) ];
    }
    while( ! sets.every( function( s ) { return Array.from( out ).some( function( c ) { return s.indexOf( c ) >= 0; } ); } ) );
    return { text: out, bits: Math.floor( len * Math.log2( pool.length ) ) };
}

let wordList = null;

function loadWords()
{
    if( ! wordList )
        wordList = fetch( 'lib/eff-large-words.txt' )
            .then( function( r ) { if( ! r.ok ) throw new Error( r.status ); return r.text(); } )
            .then( function( t )
            {
                const w = t.split( '\n' ).map( function( x ) { return x.trim(); } ).filter( Boolean );
                if( w.length !== 7776 ) throw new Error( 'words' );
                return w;
            } )
            .catch( function( e ) { wordList = null; throw e; } );
    return wordList;
}

async function genWords( o )
{
    const words = await loadWords();
    const count = Math.max( 3, Math.min( 10, o.count | 0 ) );
    const list = [];
    for( let i = 0; i < count; i++ )
    {
        const w = words[ randInt( words.length ) ];
        list.push( o.caps ? w.charAt( 0 ).toUpperCase() + w.slice( 1 ) : w );
    }
    let bits = count * Math.log2( words.length );
    if( o.num )
    {
        const at = randInt( count );
        list[ at ] += String( randInt( 10 ) );
        bits += Math.log2( 10 * count );
    }
    return { text: list.join( o.sep != null ? o.sep : '-' ), bits: Math.floor( bits ) };
}

function predictable( pw )
{
    const c = Array.from( pw );
    if( c.length < 3 ) return true;
    if( c.every( function( x ) { return x === c[ 0 ]; } ) ) return true;
    const codes = c.map( function( x ) { return x.codePointAt( 0 ); } );
    const step = codes[ 1 ] - codes[ 0 ];
    if( Math.abs( step ) === 1 && codes.every( function( v, i ) { return ! i || v - codes[ i - 1 ] === step; } ) ) return true;
    for( let k = 1; k <= 4 && k < c.length; k++ )
    {
        const piece = c.slice( 0, k ).join( '' );
        if( c.length % k === 0 && piece.repeat( c.length / k ) === pw ) return true;
    }
    return false;
}

async function leakCount( pw )
{
    try
    {
        const hash = new Uint8Array( await crypto.subtle.digest( 'SHA-1', new TextEncoder().encode( pw ) ) );
        const hex  = Array.from( hash ).map( function( b ) { return b.toString( 16 ).padStart( 2, '0' ); } ).join( '' ).toUpperCase();
        const ctl  = new AbortController();
        const timer = setTimeout( function() { ctl.abort(); }, 8000 );
        const r = await fetch( 'https://api.pwnedpasswords.com/range/' + hex.slice( 0, 5 ),
                               { headers: { 'Add-Padding': 'true' }, signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' } );
        clearTimeout( timer );
        if( ! r.ok ) return -1;
        const rest = hex.slice( 5 );
        for( const line of ( await r.text() ).split( '\n' ) )
        {
            const p = line.trim().split( ':' );
            if( p[ 0 ] === rest ) return parseInt( p[ 1 ], 10 ) || 0;    // a padding line counts 0
        }
        return 0;
    }
    catch( e ) { return -1; }
}

//------------------------------------------------------------------------//
// THE GENERATOR SHEET  -  its choices are this device's (ui.gen). Opened from
// an entry's password box, "Use" puts the result there.

let genFor = null;      // the input "Use" fills, or null (opened from the ⋮)
let genSeq = 0;

function genOpts()
{
    return Object.assign( {}, GEN_DEF, ui.gen || {} );
}

function openGenerator( target )
{
    genFor = target || null;
    const o = genOpts();
    $( 'genLen' ).value = o.len;
    $( 'genLower' ).checked = o.lower; $( 'genUpper' ).checked = o.upper;
    $( 'genDigits' ).checked = o.digits; $( 'genSymbols' ).checked = o.symbols;
    $( 'genNoLook' ).checked = o.noLook;
    $( 'genCount' ).value = o.count;
    $( 'genSep' ).value = o.sep;
    $( 'genCaps' ).checked = o.caps; $( 'genNum' ).checked = o.num;
    $( 'genUseBtn' ).hidden = ! genFor;
    showGenMode( o.mode );
    document.getElementById( 'genBackdrop' ).showModal();
    regenerate();
}

function showGenMode( mode )
{
    document.querySelectorAll( '.pw-gen-tabs .pill' ).forEach( function( p ) { p.classList.toggle( 'is-active', p.dataset.gen === mode ); } );
    $( 'genChars' ).hidden = mode !== 'chars';
    $( 'genWords' ).hidden = mode !== 'words';
}

function readGen()
{
    const o = {
        mode:   $( 'genWords' ).hidden ? 'chars' : 'words',
        len:    +$( 'genLen' ).value,
        lower:  $( 'genLower' ).checked, upper: $( 'genUpper' ).checked,
        digits: $( 'genDigits' ).checked, symbols: $( 'genSymbols' ).checked,
        noLook: $( 'genNoLook' ).checked,
        count:  +$( 'genCount' ).value,
        sep:    $( 'genSep' ).value,
        caps:   $( 'genCaps' ).checked, num: $( 'genNum' ).checked
    };
    // At least one set: the last one switched off comes back on.
    if( ! o.lower && ! o.upper && ! o.digits && ! o.symbols ) { o.lower = true; $( 'genLower' ).checked = true; }
    ui.gen = o;
    saveUi();
    return o;
}

async function regenerate()
{
    const o = readGen();
    $( 'genLenVal' ).textContent = o.len;
    $( 'genCountVal' ).textContent = o.count;
    const seq = ++genSeq;
    let r;
    try { r = o.mode === 'words' ? await genWords( o ) : genChars( o ); }
    catch( e ) { Ayni.toast( 'err', T( 'passwords.wordsFailed' ) ); return; }
    if( seq !== genSeq ) return;
    $( 'genOut' ).value = r.text;
    $( 'genBits' ).textContent = TF( 'passwords.genBits', { n: r.bits } );
}

function useGenerated()
{
    const v = $( 'genOut' ).value;
    if( genFor && v )
    {
        genFor.value = v;
        genFor.dispatchEvent( new Event( 'input', { bubbles: true } ) );
    }
    document.getElementById( 'genBackdrop' ).close();
}
