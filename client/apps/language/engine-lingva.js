/*
 * engine-lingva.js - Language: a Lingva instance (an unofficial front end to
 * Google Translate). In the catalog but off and without an address: public
 * instances come and go, and Google never allowed it (design document, D7).
 */

import { TranslationError } from './errors.js';
import { fetchJson, checkBaseUrl } from './net.js';

const CODE = { zh: 'zh' };

export default {
    id: 'lingva',
    location: 'remote',
    maxChars: 1000,
    canDetect: false,
    optionsSchema: [ { key: 'baseUrl', type: 'url', required: true, labelKey: 'language.optUrl', helpKey: 'language.optLingvaHelp' } ],

    validateOptions( o ) { return { baseUrl: checkBaseUrl( o && o.baseUrl, 'baseUrl' ) }; },

    async availability( { options } ) { return options.baseUrl ? 'available' : 'unavailable'; },
    async prepare() {},

    async translate( { text, source, target, options, signal } )
    {
        if( ! options.baseUrl ) throw new TranslationError( 'unavailable', 'No server address' );
        const url = options.baseUrl + '/api/v1/' + ( CODE[ source ] || source ) + '/' + ( CODE[ target ] || target ) + '/' + encodeURIComponent( text );
        const j = await fetchJson( url, { signal } );
        if( j && j.error ) throw new TranslationError( 'invalid-response', String( j.error ) );
        const out = String( ( j && j.translation ) || '' );
        if( ! out.trim() ) throw new TranslationError( 'invalid-response', 'Empty answer' );
        return out;
    }
};
