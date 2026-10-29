/*
 * speech.js - Language: reading a translation aloud with the browser's own
 * voices (Web Speech API, design document section 4.5). No download, no
 * server. A language with no voice is never read with another language's
 * voice. In Local mode only voices that run on the device are used (Chrome
 * also offers Google's online voices, which send the text away).
 */

import { TranslationError } from './errors.js';
import { VOICE } from './languages.js';

const synth = () => ( typeof speechSynthesis !== 'undefined' ? speechSynthesis : null );

// The voice list arrives late in Chrome: wait for it, a little.
function allVoices()
{
    const s = synth();
    if( ! s ) return Promise.resolve( [] );
    const now = s.getVoices();
    if( now.length ) return Promise.resolve( now );
    return new Promise( ( resolve ) =>
    {
        const done = () => { s.removeEventListener( 'voiceschanged', done ); resolve( s.getVoices() ); };
        s.addEventListener( 'voiceschanged', done );
        setTimeout( done, 1500 );
    } );
}

async function voicesFor( language, localOnly )
{
    const want = VOICE[ language ] || language;
    const list = ( await allVoices() ).filter( ( v ) => v.lang.toLowerCase().replace( '_', '-' ).split( '-' )[ 0 ] === language &&
                                                      ( ! localOnly || v.localService ) );
    // The exact region first (fr-FR before fr-CA), then the system's default.
    return list.sort( ( a, b ) => ( b.lang === want ) - ( a.lang === want ) || ( b.default - a.default ) );
}

let speaking = false;

export const speech = {
    async voices( language, localOnly )
    {
        return ( await voicesFor( language, localOnly ) ).map( ( v ) => ( { voiceURI: v.voiceURI, name: v.name, lang: v.lang, local: v.localService } ) );
    },

    async speak( text, language, { rate = 1, voiceURI, signal, localOnly } = {} )
    {
        const s = synth();
        if( ! s ) throw new TranslationError( 'unavailable', 'No speech synthesis' );
        const list = await voicesFor( language, localOnly );
        const voice = list.find( ( v ) => v.voiceURI === voiceURI ) || list[ 0 ];
        if( ! voice ) throw new TranslationError( 'no-voice', 'No voice for ' + language );
        s.cancel();
        const u = new SpeechSynthesisUtterance( text );
        u.voice = voice;
        u.lang = voice.lang;
        u.rate = Math.min( 2, Math.max( 0.5, rate ) );
        speaking = true;
        await new Promise( ( resolve ) =>
        {
            u.onend = u.onerror = () => resolve();
            if( signal ) signal.addEventListener( 'abort', () => { s.cancel(); resolve(); }, { once: true } );
            s.speak( u );
        } );
        speaking = false;
    },

    stop() { const s = synth(); if( s ) s.cancel(); speaking = false; },

    speaking() { return speaking; }
};
