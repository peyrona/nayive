/*
 * proofing.js - Spell-check provider for SuperDoc's proofing API.
 *
 * Client-side, offline. Typo.js (Hunspell) with the Spanish and English
 * dictionaries vendored in lib/proofing/. SuperDoc owns segment extraction and
 * draws the red underline + the right-click "corregir / ignorar" menu; this just
 * answers "is this word spelled right, and if not, what are the suggestions".
 *
 * The dictionaries and all the checking live in proofing-worker.js. Finding a
 * misspelling is instant; finding what you meant costs about a second a word,
 * and doing that here froze the document after every file opened (see the
 * worker's header). So a check answers straight away with whatever suggestions
 * are already known, and the rest arrive in the background - the next check
 * and the right-click menu (fillSuggestions) pick them up.
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
let   nextId  = 1;
let   worker  = null;
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

        if( m.type === 'sugg' ) { sugg.set( m.key, m.list ); return; }

        if( m.type === 'result' )
        {
            const done = pending.get( m.id );
            if( done ) { pending.delete( m.id ); done( m.issues ); }
        }
    };

    // A worker that cannot start (a 404 offline, say) must not leave SuperDoc
    // waiting on every check: answer "nothing found" and stop trying.
    worker.onerror = function()
    {
        for( const done of pending.values() ) done( [] );
        pending.clear();
    };

    return worker;
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

            const langs = langsNow();
            const id    = nextId++;
            const lk    = langs.join( ',' );

            // SuperDoc starts a new check on almost every repaint and aborts the
            // old one; drop it here, the worker's late answer is simply ignored.
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

// The right-click menu is built from the issue as it stood at the last check,
// which may predate the word's suggestions. Put in what we know now; if we
// know nothing yet, move the word to the head of the worker's queue so the
// next right-click has them.
export function fillSuggestions( word, sections )
{
    if( ! word || ! Array.isArray( sections ) ) return;

    const sec = sections.find( s => s && s.id === 'proofing' );
    if( ! sec || ! Array.isArray( sec.items ) ) return;
    if( sec.items.some( it => it && /^proofing-replace-/.test( it.id ) ) ) return;

    const key  = suggKey( word );
    const list = sugg.get( key );

    if( ! list )
    {
        if( worker ) worker.postMessage( { type: 'first', key, word, langs: langsNow() } );
        return;
    }

    if( ! list.length ) return;

    sec.items = list.slice( 0, 5 ).map( function( r, i )
    {
        return { id: 'proofing-replace-' + i, label: r, intent: { kind: 'proofing.replace', replacement: r } };
    } ).concat( sec.items.filter( it => it && it.id !== 'proofing-no-suggestions' ) );
}
