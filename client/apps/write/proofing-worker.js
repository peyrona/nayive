/*
 * proofing-worker.js - the spell checker's dictionaries and the slow part of
 * its work, off the page's main thread.
 *
 * Typo.js answers "is this word right?" in microseconds, but "what did you
 * mean?" (suggest) costs about a second per word - up to three - and one call
 * cannot be split. Run on the page, that froze the whole document for as long
 * as it took to get through every misspelling after a file opened: half a
 * minute for an ordinary Spanish letter, many minutes for a text in a language
 * whose dictionary is not on. So the dictionaries live here instead:
 *
 *   check     answered at once - where the misspellings are, nothing else.
 *   sugg      posted later, one word at a time, as the background queue gets
 *             to it. proofing.js keeps them and hands them to the next check
 *             and to the right-click menu.
 *
 * A single copy of each dictionary (Spanish is ~66 MB once parsed), and its
 * ~1 s parse happens here too, not on the page.
 */

importScripts( 'lib/proofing/typo.js' );

const WORD_RE     = /\p{L}[\p{L}'’‘\-]*/gu;
const TRAIL_MARKS = /[-'’‘]+$/u;

let dictPaths = {};                 // lang -> { aff, dic }, sent by proofing.js
const loaded   = {};                // lang -> Promise<Typo|null>
let personal   = new Set();         // lower-cased words the user added
const done     = new Set();         // "langs|word" whose suggestions were posted
let queue      = [];                // [ { key, word, langs } ] still to suggest
let busy       = false;

function getDict( lang )
{
    if( lang in loaded ) return loaded[ lang ];

    const d = dictPaths[ lang ];
    if( ! d ) return ( loaded[ lang ] = Promise.resolve( null ) );

    loaded[ lang ] = Promise.all( [
        fetch( d.aff ).then( r => r.text() ),
        fetch( d.dic ).then( r => r.text() )
    ] )
    .then( ( [ aff, dic ] ) => new Typo( lang, aff, dic ) )
    .catch( () => { delete loaded[ lang ]; return null; } );

    return loaded[ lang ];
}

// Only dictionaries that finished loading - the queue runs between messages
// and must not wait on a fetch.
async function dictsFor( langs )
{
    return ( await Promise.all( langs.map( getDict ) ) ).filter( Boolean );
}

async function check( msg )
{
    const langs = msg.langs.length ? msg.langs : [];
    const dicts = await dictsFor( langs );
    const issues = [];

    if( ! dicts.length ) { postMessage( { type: 'result', id: msg.id, issues } ); return; }

    const lk    = langs.join( ',' );
    const fresh = [];
    const seen  = new Set();

    for( const seg of msg.segments )
    {
        for( const m of seg.text.matchAll( WORD_RE ) )
        {
            const word = m[0].replace( TRAIL_MARKS, '' );

            if( word.length < 2 || /\d/.test( word ) ) continue;
            if( personal.has( word.toLowerCase() ) )  continue;
            if( dicts.some( t => t.check( word ) || t.check( word.toLowerCase() ) ) ) continue;

            issues.push( { segmentId: seg.id, start: m.index, end: m.index + word.length, word } );

            const key = lk + '|' + word;
            if( ! done.has( key ) && ! seen.has( key ) ) { seen.add( key ); fresh.push( { key, word, langs } ); }
        }
    }

    postMessage( { type: 'result', id: msg.id, issues } );

    // The newest check's words go first, in reading order. What was already
    // waiting stays behind them: SuperDoc checks in pairs (a smaller story,
    // then the body), so the last check is not always the whole document.
    queue = fresh.concat( queue.filter( j => ! seen.has( j.key ) ) );
    pump();
}

// One word per turn, then back to the event loop so a check that arrived
// meanwhile is answered before the next (up to three second) suggest.
function pump()
{
    if( busy || ! queue.length ) return;
    busy = true;

    setTimeout( async function()
    {
        const job = queue.shift();
        busy = false;

        if( job && ! done.has( job.key ) && ! personal.has( job.word.toLowerCase() ) )
        {
            // With Spanish and English both on, an English typo should get
            // English guesses too: every active dictionary, in language order,
            // no duplicates.
            const out = [];

            for( const t of await dictsFor( job.langs ) )
            {
                let got = [];
                try { got = t.suggest( job.word, 5 ) || []; } catch( _ ) {}
                for( const r of got ) if( out.indexOf( r ) === -1 ) out.push( r );
            }

            out.length = Math.min( out.length, 5 );
            done.add( job.key );
            postMessage( { type: 'sugg', key: job.key, list: out } );
        }

        pump();
    }, 0 );
}

onmessage = function( e )
{
    const msg = e.data || {};

    switch( msg.type )
    {
        case 'init'    : dictPaths = msg.dicts || {}; break;
        case 'personal': personal  = new Set( msg.words || [] ); break;
        case 'check'   : check( msg ).catch( function() { postMessage( { type: 'result', id: msg.id, issues: [] } ); } ); break;

        // The right-click menu opened on a word we have not got to yet: do it next.
        case 'first'   :
            if( done.has( msg.key ) ) break;
            queue = [ { key: msg.key, word: msg.word, langs: msg.langs } ].concat( queue.filter( j => j.key !== msg.key ) );
            pump();
            break;
    }
};
