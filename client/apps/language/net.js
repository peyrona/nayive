/*
 * net.js - Language: the network helpers every remote engine and dictionary
 * shares. Errors come out typed (errors.js): a failed fetch is "network" (a
 * browser cannot tell a CORS block from a dead network - both are "network"),
 * a 429 "quota", a body that is not JSON "invalid-response".
 */

import { TranslationError, abortError } from './errors.js';

export async function fetchJson( url, init )
{
    const r = await request( url, init );
    try { return await r.json(); }
    catch( e )
    {
        if( init && init.signal && init.signal.aborted ) throw abortError( init.signal );
        throw new TranslationError( 'invalid-response', 'Not JSON' );
    }
}

export async function request( url, init )
{
    const signal = init && init.signal;
    let r;
    try { r = await fetch( url, Object.assign( { credentials: 'omit' }, init ) ); }
    catch( e )
    {
        if( signal && signal.aborted ) throw abortError( signal );
        throw new TranslationError( 'network', 'Network error', { cause: e } );
    }
    if( r.status === 429 ) throw new TranslationError( 'quota', 'Too many requests' );
    if( ! r.ok ) throw new TranslationError( r.status === 404 ? 'unsupported' : 'invalid-response', 'HTTP ' + r.status );
    return r;
}

// "l&#39;eau &amp; &quot;x&quot;" -> "l'eau & \"x\"" - entities only, never
// any HTML: the text is shown with textContent anyway.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities( s )
{
    return String( s ).replace( /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, ( m, e ) =>
    {
        if( e[ 0 ] === '#' )
        {
            const n = e[ 1 ] === 'x' || e[ 1 ] === 'X' ? parseInt( e.slice( 2 ), 16 ) : parseInt( e.slice( 1 ), 10 );
            return n > 0 && n < 0x110000 ? String.fromCodePoint( n ) : m;
        }
        return Object.prototype.hasOwnProperty.call( NAMED, e.toLowerCase() ) ? NAMED[ e.toLowerCase() ] : m;
    } );
}

// A user-typed base URL: https only, no user:password, no trailing slash.
export function checkBaseUrl( raw, field )
{
    const s = String( raw || '' ).trim();
    if( ! s ) return '';
    let u;
    try { u = new URL( s ); }
    catch( e ) { throw new TranslationError( 'invalid-input', 'Invalid URL', { field } ); }
    if( u.protocol !== 'https:' || u.username || u.password )
        throw new TranslationError( 'invalid-input', 'Only https, without credentials', { field } );
    return u.origin + u.pathname.replace( /\/+$/, '' );
}
