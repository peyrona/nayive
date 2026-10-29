/*
 * engine-mymemory.js - Language: MyMemory, the remote fallback.
 *
 * api.mymemory.translated.net: no key, a GET, CORS allowed (checked
 * 2026-10-28). About 500 bytes per request, so pieces are measured in UTF-8
 * bytes (a Chinese character is three). Its quota notices come back INSIDE a
 * 200 answer - turned into a "quota" error here. An optional email raises
 * the daily quota; it is not secret, and the settings say so.
 */

import { TranslationError } from './errors.js';
import { utf8Length } from './split.js';
import { decodeEntities, fetchJson } from './net.js';

const CODE = { zh: 'zh-CN' };

export default {
    id: 'mymemory',
    location: 'remote',
    maxChars: 480,
    measure: utf8Length,
    canDetect: false,
    optionsSchema: [ { key: 'email', type: 'email', labelKey: 'language.optEmail', helpKey: 'language.optEmailHelp' } ],

    validateOptions( o )
    {
        const email = String( ( o && o.email ) || '' ).trim();
        if( email && ! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test( email ) )
            throw new TranslationError( 'invalid-input', 'Invalid email', { field: 'email' } );
        return { email };
    },

    async availability() { return 'available'; },
    async prepare() {},

    async translate( { text, source, target, options, signal } )
    {
        const q = new URLSearchParams( { q: text, langpair: ( CODE[ source ] || source ) + '|' + ( CODE[ target ] || target ) } );
        if( options && options.email ) q.set( 'de', options.email );
        const j = await fetchJson( 'https://api.mymemory.translated.net/get?' + q, { signal } );
        const out = String( ( j && j.responseData && j.responseData.translatedText ) || '' );
        const status = Number( j && j.responseStatus );
        if( j.quotaFinished || status === 429 || /MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS/i.test( out ) )
            throw new TranslationError( 'quota', 'MyMemory quota used up', { retryAfter: tomorrow() } );
        if( status === 403 || /INVALID LANGUAGE PAIR|IS AN INVALID TARGET LANGUAGE/i.test( out ) )
            throw new TranslationError( 'unsupported', 'MyMemory: unsupported pair' );
        if( status && status !== 200 ) throw new TranslationError( 'invalid-response', 'MyMemory said ' + status );
        if( ! out.trim() ) throw new TranslationError( 'invalid-response', 'Empty answer' );
        return decodeEntities( out );
    }
};

function tomorrow()
{
    const d = new Date();
    d.setHours( 24, 0, 0, 0 );
    return d;
}
