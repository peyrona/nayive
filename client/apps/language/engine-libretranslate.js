/*
 * engine-libretranslate.js - Language: a LibreTranslate server of our own
 * (design document, section 4.3). Off and empty by default: the VPS has no
 * RAM to spare today. No key - a key in a browser is visible to anyone.
 * It can also detect the language.
 */

import { TranslationError } from './errors.js';
import { fetchJson, checkBaseUrl } from './net.js';
import { normalizeLanguage } from './languages.js';

const langsOf = new Map();                         // baseUrl -> Promise<Map: our code -> the server's ("zh" -> "zh-Hans")>

function languages( base, signal )
{
    if( ! langsOf.has( base ) )
    {
        const p = fetchJson( base + '/languages', { signal } ).then( ( list ) =>
        {
            const codes = new Map();
            for( const l of Array.isArray( list ) ? list : [] )
            {
                const ours = l && normalizeLanguage( l.code, true );
                if( ! ours ) continue;
                // "zh" itself or "zh-Hans" (simplified, what we mean) beat "zh-Hant".
                const best = l.code === ours || /^zh[-_]hans/i.test( l.code );
                if( ! codes.has( ours ) || best ) codes.set( ours, l.code );
            }
            return codes;
        } );
        p.catch( () => langsOf.delete( base ) );
        langsOf.set( base, p );
    }
    return langsOf.get( base );
}

function post( base, path, body, signal )
{
    return fetchJson( base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                     body: JSON.stringify( body ), signal } );
}

export default {
    id: 'libretranslate',
    location: 'remote',
    maxChars: 1800,
    canDetect: true,
    optionsSchema: [ { key: 'baseUrl', type: 'url', required: true, labelKey: 'language.optUrl', helpKey: 'language.optUrlHelp' } ],

    validateOptions( o ) { return { baseUrl: checkBaseUrl( o && o.baseUrl, 'baseUrl' ) }; },

    async availability( { source, target, options } )
    {
        if( ! options.baseUrl ) return 'unavailable';
        try
        {
            const have = await languages( options.baseUrl );
            return have.has( source ) && have.has( target ) ? 'available' : 'unavailable';
        }
        catch( e ) { return 'available'; }         // unknown: let the translation itself say
    },

    async prepare() {},

    async translate( { text, source, target, options, signal } )
    {
        if( ! options.baseUrl ) throw new TranslationError( 'unavailable', 'No server address' );
        // The codes the server listed (newer servers say "zh-Hans", not "zh").
        const have = await languages( options.baseUrl, signal ).catch( () => null );
        const code = ( c ) => ( have && have.get( c ) ) || c;
        const j = await post( options.baseUrl, '/translate', { q: text, source: code( source ), target: code( target ), format: 'text' }, signal );
        if( j && j.error ) throw new TranslationError( 'invalid-response', String( j.error ) );
        const out = String( ( j && j.translatedText ) || '' );
        if( ! out.trim() ) throw new TranslationError( 'invalid-response', 'Empty answer' );
        return out;
    },

    async detect( { text, options, signal } )
    {
        if( ! options.baseUrl ) throw new TranslationError( 'unavailable', 'No server address' );
        const j = await post( options.baseUrl, '/detect', { q: text }, signal );
        const best = Array.isArray( j ) ? j[ 0 ] : null;
        const language = best && normalizeLanguage( best.language );
        if( ! language ) throw new TranslationError( 'unsupported', 'Language not detected' );
        return { language, confidence: Math.max( 0, Math.min( 1, Number( best.confidence ) / 100 ) ) };
    }
};
