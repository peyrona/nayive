/*
 * proofing.js - the spell checker, as Write's pages ask it.
 *
 * Client-side, offline. Typo.js (Hunspell) with the dictionaries vendored in
 * lib/proofing/. proofing-overlay.js hands it the text of the paragraphs on
 * screen and draws the red underline + the right-click menu itself (the
 * engine has no spell-check hook); this just answers "which words are not
 * right, and what are the suggestions".
 *
 * The dictionaries and all the checking live in proofing-worker.js. Finding a
 * misspelling is instant; finding what you meant costs about a second a word,
 * and doing that here froze the document after every file opened (see the
 * worker's header). So a check answers straight away with whatever suggestions
 * are already known, and the rest arrive in the background - the next check
 * and the right-click menu (suggestionsFor) pick them up.
 *
 * Grammar (kind: 'grammar' / 'style') is not covered yet — English-only grammar
 * via Harper is a later add. See lib/proofing/README.txt.
 *
 * Loaded as a module by write.js.
 */

// One entry per dictionary pair vendored in lib/proofing/. Adding a language is
// dropping <code>.aff/.dic (+ a .LICENSE) in there and adding a line here — the
// Settings list is built from these keys.
const DICT = {
    es: { aff: 'lib/proofing/es.aff', dic: 'lib/proofing/es.dic' },
    en: { aff: 'lib/proofing/en.aff', dic: 'lib/proofing/en.dic' },
    pt: { aff: 'lib/proofing/pt.aff', dic: 'lib/proofing/pt.dic' },
    fr: { aff: 'lib/proofing/fr.aff', dic: 'lib/proofing/fr.dic' },
    de: { aff: 'lib/proofing/de.aff', dic: 'lib/proofing/de.dic' },
    it: { aff: 'lib/proofing/it.aff', dic: 'lib/proofing/it.dic' }
};

export const PROOF_LANGS = Object.keys( DICT );

// Words the user added by hand. Kept here rather than in the caller so the
// check path stays one place; write.js loads and saves the list. The worker
// gets a copy, so it neither flags them nor spends time suggesting for them.
let personal = new Set();

export function setPersonalWords( words )
{
    personal = new Set( ( words || [] ).map( function( w ) { return String( w ).toLowerCase(); } ) );
    if( worker ) worker.postMessage( { type: 'personal', words: [ ...personal ] } );
}

export function isPersonalWord( w )
{
    return personal.has( String( w ).toLowerCase() );
}

// "es,en|palabra" -> [ suggestions ], filled as the worker posts them.
const sugg    = new Map();
const pending = new Map();   // check id -> resolve
const waiting = new Map();   // "es,en|palabra" -> [ resolve ], for suggestionsFor
let   nextId  = 1;
let   worker  = null;
let   dead    = false;       // the worker failed: every check answers "nothing found" at once
let   getLangsFn = null;

function langsNow()
{
    return ( getLangsFn && getLangsFn() ) || [ 'es' ];
}

function suggKey( word )
{
    return langsNow().join( ',' ) + '|' + word;
}

function startWorker()
{
    if( worker ) return worker;

    worker = new Worker( new URL( './proofing-worker.js', import.meta.url ) );
    worker.postMessage( { type: 'init', dicts: DICT } );
    worker.postMessage( { type: 'personal', words: [ ...personal ] } );

    worker.onmessage = function( e )
    {
        const m = e.data || {};

        if( m.type === 'sugg' )
        {
            sugg.set( m.key, m.list );
            for( const done of waiting.get( m.key ) || [] ) done( m.list );
            waiting.delete( m.key );
            return;
        }

        if( m.type === 'result' )
        {
            const done = pending.get( m.id );
            if( done ) { pending.delete( m.id ); done( m.issues ); }
        }
    };

    // A worker that cannot start (a 404 offline, say) must not leave the page
    // waiting on every check: answer "nothing found" and stop trying.
    worker.onerror = function()
    {
        dead = true;
        for( const done of pending.values() ) done( [] );
        pending.clear();
        for( const list of waiting.values() ) for( const done of list ) done( [] );
        waiting.clear();
    };

    return worker;
}

// Another document, or other languages: the words still waiting for their
// suggestions are dropped (minutes of work on words no longer on screen), and so
// is every suggestion kept and every dictionary no longer switched on - Spanish
// alone is ~66 MB. The right-click menus still waiting get "none".
export function resetProofing()
{
    sugg.clear();
    for( const list of waiting.values() ) for( const done of list ) done( [] );
    waiting.clear();

    if( worker && ! dead ) worker.postMessage( { type: 'reset', langs: langsNow() } );
}

// getLangs() returns the active language codes, e.g. ['es'] or ['es','en'].
// A word is flagged only when NO active dictionary accepts it, and never when it
// is in the user's own list.
export function makeSpellProvider( getLangs )
{
    getLangsFn = getLangs;

    return {
        id: 'nayive-typo-spell',

        getCapabilities: () => ( { issueKinds: [ 'spelling' ] } ),

        check: ( { segments, maxSuggestions = 5, signal } ) => new Promise( function( resolve, reject )
        {
            signal?.throwIfAborted();
            if( dead ) { resolve( { issues: [] } ); return; }

            const langs = langsNow();
            const id    = nextId++;
            const lk    = langs.join( ',' );

            // A newer check can make this one pointless and abort it; drop it
            // here, the worker's late answer is simply ignored.
            signal?.addEventListener( 'abort', function()
            {
                if( pending.delete( id ) ) reject( signal.reason );
            }, { once: true } );

            pending.set( id, function( found )
            {
                resolve( { issues: found.map( function( f )
                {
                    return {
                        segmentId   : f.segmentId,
                        start       : f.start,
                        end         : f.end,
                        kind        : 'spelling',
                        message     : NayiveUI.tf( 'write.notInDict', { word: f.word } ),
                        replacements: ( sugg.get( lk + '|' + f.word ) || [] ).slice( 0, maxSuggestions )
                    };
                } ) } );
            } );

            startWorker().postMessage( { type: 'check', id, langs,
                                         segments: segments.map( s => ( { id: s.id, text: s.text } ) ) } );
        } )
    };
}

// A word's suggestions, for the right-click menu: at once when the worker has
// already got to it, else as soon as it does - and it is asked to do this word
// next. Resolves [] when there are none (or the worker cannot run).
export function suggestionsFor( word )
{
    const key  = suggKey( word );
    const list = sugg.get( key );
    if( list ) return Promise.resolve( list );
    if( dead ) return Promise.resolve( [] );

    return new Promise( function( resolve )
    {
        if( ! waiting.has( key ) ) waiting.set( key, [] );
        waiting.get( key ).push( resolve );
        startWorker().postMessage( { type: 'first', key, word, langs: langsNow() } );
    } );
}
