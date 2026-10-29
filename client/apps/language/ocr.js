/*
 * ocr.js - Language: the text in a photo, with tesseract.js, on the device
 * (design document, section 4.4). The library is vendored in lib/ and only
 * loaded on the first use; the language data (spa, fra, chi_sim...) comes
 * from its usual CDN the first time and is then kept by the library. The
 * image never leaves the browser. The text goes to the box for the user to
 * check - it is never translated by itself.
 */

import { TranslationError, abortError } from './errors.js';
import { OCR } from './languages.js';
import { OCR_LIB } from './config.js';

let libP = null;
const workers = new Map();                         // "spa" -> Promise<worker>

function loadLib()
{
    if( window.Tesseract ) return Promise.resolve( window.Tesseract );
    if( ! libP )
    {
        libP = new Promise( ( resolve, reject ) =>
        {
            const s = document.createElement( 'script' );
            s.src = new URL( OCR_LIB.script, import.meta.url ).href;
            s.onload = () => resolve( window.Tesseract );
            s.onerror = () => { libP = null; reject( new TranslationError( 'network', 'OCR library not loaded' ) ); };
            document.head.appendChild( s );
        } );
    }
    return libP;
}

// Scale the longest side down to maxSide and drop the colour.
async function prepareImage( image, maxSide )
{
    let bmp;
    try { bmp = await createImageBitmap( image ); }
    catch( e ) { throw new TranslationError( 'invalid-input', 'Not an image', { field: 'image' } ); }
    const k = Math.min( 1, maxSide / Math.max( bmp.width, bmp.height ) );
    const c = document.createElement( 'canvas' );
    c.width = Math.max( 1, Math.round( bmp.width * k ) );
    c.height = Math.max( 1, Math.round( bmp.height * k ) );
    const g = c.getContext( '2d' );
    g.filter = 'grayscale(1)';
    g.drawImage( bmp, 0, 0, c.width, c.height );
    bmp.close && bmp.close();
    return c;
}

export const ocr = {
    async recognize( image, { language, maxSide = 2000, maxLength = 5000, signal, onProgress } )
    {
        const lang = OCR[ language ] || 'spa';
        const progress = ( p ) => onProgress && onProgress( p );
        const T = await loadLib();
        if( signal && signal.aborted ) throw abortError( signal );
        const canvas = await prepareImage( image, maxSide );

        let current = null;
        if( ! workers.has( lang ) )
        {
            const p = T.createWorker( lang, 1, {
                workerPath: new URL( OCR_LIB.worker, import.meta.url ).href,
                corePath:   new URL( OCR_LIB.core, import.meta.url ).href,
                workerBlobURL: false,
                logger: ( m ) => { if( current ) current( m ); }
            } );
            p.catch( () => workers.delete( lang ) );
            workers.set( lang, p );
        }
        // Loading the data is the first half of the bar, reading the second.
        current = ( m ) =>
        {
            if( m.status === 'recognizing text' ) progress( 0.5 + 0.5 * m.progress );
            else if( typeof m.progress === 'number' ) progress( 0.5 * m.progress );
        };

        let worker;
        try { worker = await workers.get( lang ); }
        catch( e ) { throw new TranslationError( 'network', 'OCR data not loaded', { cause: e } ); }

        const onAbort = () => { workers.delete( lang ); worker.terminate(); };
        if( signal ) signal.addEventListener( 'abort', onAbort, { once: true } );
        try
        {
            const { data } = await worker.recognize( canvas );
            if( signal && signal.aborted ) throw abortError( signal );
            let text = String( data.text || '' ).replace( /[ \t]+\n/g, '\n' ).replace( /\n{3,}/g, '\n\n' ).trim();
            if( lang === 'chi_sim' ) text = text.replace( /(?<=[㐀-鿿]) (?=[㐀-鿿])/g, '' );
            const truncated = text.length > maxLength;
            progress( 1 );
            return { text: truncated ? text.slice( 0, maxLength ) : text, language, confidence: ( data.confidence || 0 ) / 100, truncated };
        }
        catch( e )
        {
            if( signal && signal.aborted ) throw abortError( signal );
            throw e instanceof TranslationError ? e : new TranslationError( 'internal', String( e && e.message || e ) );
        }
        finally { current = null; if( signal ) signal.removeEventListener( 'abort', onAbort ); }
    },

    dispose() { for( const p of workers.values() ) p.then( ( w ) => w.terminate(), () => {} ); workers.clear(); }
};
