/*
 * engine-chrome.js - Language: the translator built into desktop Chrome
 * (the Translator and LanguageDetector APIs, Chrome 138+). On the device,
 * free, private. Not on phones or other browsers: there availability() says
 * "unavailable" and the next engine is used.
 *
 * Its language packs download on first use, and Chrome only starts that
 * download from a user gesture (a click): "downloadable" pairs are prepared
 * right after the click on Translate, or from the confirm dialog.
 */

import { TranslationError, abortError } from './errors.js';
import { normalizeLanguage } from './languages.js';

const STALL_MS = 30000;
const sessions = new Map();                       // "es>fr" -> Promise<Translator>
const stalled  = new Set();                       // pairs whose download never moved (this page load)
let detector = null;

const api = () => globalThis.Translator;

export default {
    id: 'chromeBuiltin',
    location: 'local',
    maxChars: 4000,
    canDetect: true,
    optionsSchema: [],

    validateOptions() { return {}; },

    async availability( { source, target } )
    {
        if( ! api() || typeof api().availability !== 'function' || stalled.has( source + '>' + target ) ) return 'unavailable';
        try
        {
            const a = await api().availability( { sourceLanguage: source, targetLanguage: target } );
            if( a === 'available' ) return 'available';
            return a === 'downloadable' || a === 'downloading' ? 'downloadable' : 'unavailable';
        }
        catch( e ) { return 'unavailable'; }
    },

    // Chrome does not say how big a pack is.
    async downloadSize() { return 0; },

    // A download that never moves (no user gesture left, a browser that says
    // "downloadable" but never fetches - headless Chrome does) gives up after
    // STALL_MS with no progress, so the next engine gets its turn.
    async prepare( { source, target, signal, onProgress } )
    {
        const key = source + '>' + target;
        if( ! sessions.has( key ) )
        {
            const stop = new AbortController();
            const onOuter = () => stop.abort( signal.reason );
            if( signal ) signal.addEventListener( 'abort', onOuter, { once: true } );
            let stall = setTimeout( () => stop.abort( new TranslationError( 'unavailable', 'Download did not start' ) ), STALL_MS );
            const p = api().create( {
                sourceLanguage: source, targetLanguage: target, signal: stop.signal,
                monitor( m )
                {
                    m.addEventListener( 'downloadprogress', ( e ) =>
                    {
                        clearTimeout( stall );
                        if( e.loaded < 1 ) stall = setTimeout( () => stop.abort( new TranslationError( 'unavailable', 'Download stalled' ) ), STALL_MS );
                        if( onProgress ) onProgress( e.loaded );
                    } );
                }
            } );
            const guarded = Promise.race( [ p, new Promise( ( _, reject ) =>
                stop.signal.addEventListener( 'abort', () => reject( stop.signal.reason ), { once: true } ) ) ] )
                .finally( () => { clearTimeout( stall ); if( signal ) signal.removeEventListener( 'abort', onOuter ); } );
            guarded.catch( ( e ) => { sessions.delete( key ); if( e instanceof TranslationError && e.category === 'unavailable' ) stalled.add( key ); } );
            sessions.set( key, guarded );
        }
        try { await sessions.get( key ); }
        catch( e )
        {
            if( signal && signal.aborted ) throw abortError( signal );
            if( e instanceof TranslationError ) throw e;
            throw new TranslationError( e && e.name === 'NotAllowedError' ? 'unavailable' : 'internal', String( e && e.message ), { cause: e } );
        }
    },

    async translate( { text, source, target, signal } )
    {
        await this.prepare( { source, target, signal } );
        const t = await sessions.get( source + '>' + target );
        try { return await t.translate( text, { signal } ); }
        catch( e )
        {
            if( signal && signal.aborted ) throw abortError( signal );
            throw new TranslationError( 'internal', String( e && e.message ), { cause: e } );
        }
    },

    async detect( { text, signal } )
    {
        const D = globalThis.LanguageDetector;
        if( ! D ) throw new TranslationError( 'unavailable', 'No LanguageDetector' );
        try
        {
            if( ! detector ) { detector = D.create( { signal } ); detector.catch( () => { detector = null; } ); }
            const list = await ( await detector ).detect( text, { signal } );
            for( const r of list || [] )
            {
                const language = normalizeLanguage( r.detectedLanguage );
                if( language ) return { language, confidence: r.confidence };
            }
            throw new TranslationError( 'unsupported', 'Not one of our languages' );
        }
        catch( e )
        {
            if( e instanceof TranslationError ) throw e;
            if( signal && signal.aborted ) throw abortError( signal );
            throw new TranslationError( 'unavailable', String( e && e.message ), { cause: e } );
        }
    },

    canDetectHere() { return !! globalThis.LanguageDetector; },

    dispose() { for( const p of sessions.values() ) p.then( ( t ) => t.destroy && t.destroy(), () => {} ); sessions.clear(); }
};
