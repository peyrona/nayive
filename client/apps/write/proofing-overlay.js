/*
 * proofing-overlay.js - Write's spell check, drawn over the engine's pages.
 *
 * The engine has no spell-check hook (it even sets spellcheck="false"), but what
 * it paints is plain DOM: every run of text is a <span class="layout-run-text">
 * carrying the paragraph it belongs to (data-paragraph-id) and where in that
 * paragraph's text it starts (data-start). So:
 *
 *   1. the paragraphs on screen are read back from those spans - their text,
 *      offset by offset - and handed to the spell checker (proofing.js, which
 *      runs the dictionaries in a worker);
 *   2. each word it flags gets a red wavy line, an absolutely placed element in
 *      a layer of our own inside the scroller (#spellLayer), measured with a DOM
 *      Range over the word's characters - so the lines follow zoom and scroll;
 *   3. a right-click on a flagged word gives write.js the menu rows for it -
 *      the suggestions, "Add to the dictionary" and "Ignore" (itemsAt) - which
 *      it shows above cut / copy / paste. A suggestion replaces
 *      the word with public calls only: findMatches() finds it, and the match
 *      whose paragraph id and offset are the ones under the pointer is the one
 *      replaced (write.js replaceMatch). A span's data-paragraph-id IS a match's
 *      blockId and data-start + the offset in the span IS its start - checked
 *      on his 35 files by tools/docx-editor-smoke (719/719).
 *
 * Only the pages on screen (and one screenful either side) are read, so a long
 * document costs what a short one does. A paragraph is checked again only when
 * its text changed; after an edit the lines of untouched paragraphs are simply
 * redrawn at once, and the edited one is re-checked 600 ms after the typing
 * stops.
 *
 *   const spell = createSpellOverlay( {
 *       editor    : () => editor,
 *       check     : segments => Promise<issues>,        // proofing.js provider.check
 *       suggest   : word => Promise<[ ... ]>,           // proofing.js suggestionsFor
 *       langs     : () => [ 'es' ],                     // none = spell check off
 *       isPersonal: word => bool,
 *       addWord   : word => ...,                        // the personal dictionary
 *       replace   : ( match, text ) => ...              // write.js replaceMatch
 *   } );
 *   spell.changed()    after an edit        spell.refresh()    after a scroll / zoom
 *   spell.reset()      the languages changed        spell.forget( word )  added to the dictionary
 *   await spell.itemsAt( x, y )   the menu rows for the flagged word there, or null
 *
 *   runRects( root, pid, a, b, index? )   where characters [a, b) of a paragraph are
 *                                 painted - the find bar (find.js) marks its matches with it
 *   runIndex( root )              the painted spans grouped by paragraph, for runRects
 */

const RECHECK_MS = 600;      // after the last edit
const SCROLL_MS  = 150;      // after the last scroll
const SUGGEST_MS = 2500;     // the longest a right-click waits for suggestions

export function createSpellOverlay( o )
{
    const scroller = document.getElementById( 'editor' );
    const layer    = document.getElementById( 'spellLayer' );

    // paragraph id -> { text, issues: [ { start, end, word } ] } for the text last checked
    const checked  = new Map();
    const ignored  = new Set();       // lower-cased, this visit only
    let   drawn    = [];              // [ { pid, start, end, word, rects: [ content-space boxes ] } ]
    let   run      = 0;               // a newer pass makes an older one's answer stale
    let   recheckT = null, scrollT = null, frame = 0;

    //---- reading the pages ---------------------------------------------------

    // The painted paragraphs of the pages on screen, one screenful either side:
    // { pid -> { chars: [], spans: [ { el, start } ] } }. A gap (text painted on
    // a page further away) stays undefined in `chars`.
    function readPages()
    {
        const view = scroller.getBoundingClientRect();
        const pad  = view.height;
        const out  = new Map();

        for( const page of scroller.querySelectorAll( '.docx-page' ) )
        {
            const r = page.getBoundingClientRect();
            if( r.bottom < view.top - pad || r.top > view.bottom + pad ) continue;

            for( const span of page.querySelectorAll( '.layout-run-text[data-paragraph-id][data-start]' ) )
            {
                const pid   = span.getAttribute( 'data-paragraph-id' );
                const start = Number( span.getAttribute( 'data-start' ) );
                const text  = span.textContent;
                if( ! Number.isFinite( start ) ) continue;

                let p = out.get( pid );
                if( ! p ) out.set( pid, p = { chars: [], spans: [] } );

                p.spans.push( { el: span, start: start, end: start + text.length } );
                for( let i = 0; i < text.length; i++ ) p.chars[ start + i ] = text[ i ];
            }
        }
        return out;
    }

    // The text the checker sees: gaps as spaces, so offsets stay the paragraph's.
    function textOf( p )
    {
        let s = '';
        for( let i = 0; i < p.chars.length; i++ ) s += p.chars[ i ] === undefined ? ' ' : p.chars[ i ];
        return s;
    }

    //---- checking ------------------------------------------------------------

    function langsOn() { const l = o.langs(); return !! ( l && l.length ); }

    // Check the paragraphs whose text is new or changed, then draw them all.
    async function pass()
    {
        const me = ++run;
        if( ! langsOn() ) { clear(); return; }

        const pages = readPages();
        const todo  = [];

        for( const [ pid, p ] of pages )
        {
            const text = textOf( p );
            const had  = checked.get( pid );
            if( ! had || had.text !== text ) todo.push( { id: pid, text: text } );
        }

        if( todo.length )
        {
            let issues = [];
            try { issues = await o.check( todo ); }
            catch( _ ) { return; }                // aborted, or the worker is gone
            if( me !== run ) return;              // a newer pass has the floor

            const by = new Map( todo.map( function( t ) { return [ t.id, { text: t.text, issues: [] } ]; } ) );
            for( const it of issues )
            {
                const e = by.get( it.segmentId );
                if( e ) e.issues.push( { start: it.start, end: it.end, word: e.text.slice( it.start, it.end ) } );
            }
            for( const [ pid, e ] of by ) checked.set( pid, e );
        }

        draw( pages );
    }

    // Draw from the cache only. A paragraph edited since its check keeps the
    // lines of the words the edit did not touch - moved along with the text -
    // so the lines neither blink nor go stale while you type; the touched words
    // wait for the re-check.
    function draw( pages )
    {
        pages = pages || readPages();
        layer.textContent = '';
        drawn = [];

        if( ! langsOn() ) return;

        const origin = layer.getBoundingClientRect();
        const frag   = document.createDocumentFragment();

        for( const [ pid, p ] of pages )
        {
            const e = checked.get( pid );
            if( ! e ) continue;

            const text = textOf( p );
            for( const is of e.text === text ? e.issues : moved( e, text ) )
            {
                if( p.chars[ is.start - 1 ] === undefined && is.start > 0 ) continue;   // cut off by a gap:
                if( p.chars[ is.end ] === undefined && is.end < p.chars.length ) continue;   // not a real word
                if( ignored.has( is.word.toLowerCase() ) || o.isPersonal( is.word ) ) continue;

                const rects = rectsFor( p, is.start, is.end, origin );
                if( ! rects.length ) continue;

                drawn.push( { pid: pid, start: is.start, end: is.end, word: is.word, rects: rects } );

                for( const r of rects )
                {
                    const d = document.createElement( 'div' );
                    d.className   = 'spell-squiggle';
                    d.style.left  = r.x + 'px';
                    d.style.top   = ( r.y + r.h - 2 ) + 'px';
                    d.style.width = r.w + 'px';
                    frag.appendChild( d );
                }
            }
        }
        layer.appendChild( frag );
    }

    // A checked paragraph's issues in its edited text: the ones before the edit
    // stay, the ones after it shift by what the edit added or removed, the ones
    // in it (or right against it - the word may have grown) are dropped.
    function moved( e, text )
    {
        const a = e.text, b = text;
        let pre = 0, suf = 0;

        while( pre < a.length && pre < b.length && a[ pre ] === b[ pre ] ) pre++;
        while( suf < a.length - pre && suf < b.length - pre && a[ a.length - 1 - suf ] === b[ b.length - 1 - suf ] ) suf++;

        const cut = a.length - suf, delta = b.length - a.length, out = [];

        for( const is of e.issues )
        {
            if( is.end < pre ) out.push( is );
            else if( is.start > cut ) out.push( { start: is.start + delta, end: is.end + delta, word: is.word } );
        }
        return out;
    }

    // The boxes of the characters [start, end) of a paragraph, in the layer's
    // own coordinates (it scrolls with the pages, so these stay put on scroll).
    function rectsFor( p, start, end, origin )
    {
        const out = [];

        for( const s of p.spans )
        {
            if( s.end <= start || s.start >= end ) continue;

            const a = Math.max( start, s.start ) - s.start;
            const b = Math.min( end,   s.end   ) - s.start;
            const range = textRange( s.el, a, b );
            if( ! range ) continue;

            for( const r of range.getClientRects() )
                if( r.width > 0 ) out.push( { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height } );
        }
        return out;
    }

    function clear() { layer.textContent = ''; drawn = []; }

    //---- the right-click menu ------------------------------------------------

    function wordAt( x, y )
    {
        const origin = layer.getBoundingClientRect();
        const px = x - origin.left, py = y - origin.top;

        return drawn.find( function( d )
        {
            return d.rects.some( function( r ) { return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; } );
        } ) || null;
    }

    // The rows for the flagged word under the pointer (client coordinates), or
    // null when there is none there. Waits for the suggestions, but not for ever.
    async function itemsAt( x, y )
    {
        const hit = wordAt( x, y );
        if( ! hit ) return null;

        let list = [];
        try { list = await Promise.race( [ o.suggest( hit.word ), new Promise( function( r ) { setTimeout( function() { r( null ); }, SUGGEST_MS ); } ) ] ) || []; }
        catch( _ ) { list = []; }

        const items = list.slice( 0, 5 ).map( function( s ) { return { text: s, run: function() { replaceWord( hit, s ); } }; } );
        if( ! items.length ) items.push( { key: 'write.noSuggestions', enabled: function() { return false; } } );

        items.push( { sep: true },
                    { text: NayiveUI.tf( 'write.addToDict', { word: hit.word } ),
                      run: function() { o.addWord( hit.word ); } },
                    { key: 'write.ignoreWord',
                      run: function() { ignored.add( hit.word.toLowerCase() ); draw(); } } );
        return items;
    }

    // Replace exactly the word under the pointer: the match with its paragraph
    // id and its offset. If the text moved meanwhile there is no such match, and
    // nothing is replaced.
    function replaceWord( hit, text )
    {
        const ed = o.editor();
        if( ! ed ) return;

        let matches = [];
        try { matches = ed.findMatches( hit.word, { wholeWord: true, matchCase: true } ) || []; } catch( _ ) {}

        const m = matches.find( function( x ) { return x.blockId === hit.pid && x.start === hit.start; } );
        o.replace( m || null, text );
    }

    //---- when to run -------------------------------------------------------------

    // After an edit: redraw on the next frame (the pages have just been
    // repainted, and moved() carries the lines along), re-check once the typing
    // stops.
    function changed()
    {
        if( ! frame ) frame = requestAnimationFrame( function() { frame = 0; draw(); } );
        clearTimeout( recheckT );
        recheckT = setTimeout( pass, RECHECK_MS );
    }

    // After a scroll or a zoom: pages that came into view need reading.
    function refresh()
    {
        clearTimeout( scrollT );
        scrollT = setTimeout( pass, SCROLL_MS );
    }

    function reset() { checked.clear(); refresh(); }

    function forget( word ) { draw(); }       // isPersonal() now says yes: its lines go

    scroller.addEventListener( 'scroll', refresh, { passive: true } );
    new ResizeObserver( refresh ).observe( document.getElementById( 'editorHost' ) );

    return { changed: changed, refresh: refresh, reset: reset, forget: forget, itemsAt: itemsAt };
}

// Where characters [a, b) of paragraph `pid` are painted, as client rects: the
// same span arithmetic the red lines use, for anyone else who marks text (the
// find bar). Empty when that stretch is not on a page in the DOM. `index`
// (runIndex) saves a caller with many stretches to mark a walk over every span
// for each one.
export function runRects( root, pid, a, b, index )
{
    const out   = [];
    const spans = index ? ( index.get( pid ) || [] )
                        : [ ...root.querySelectorAll( '.layout-run-text[data-paragraph-id][data-start]' ) ]
                              .filter( function( span ) { return span.getAttribute( 'data-paragraph-id' ) === pid; } );

    for( const span of spans )
    {
        const s   = Number( span.getAttribute( 'data-start' ) );
        const len = span.textContent.length;
        if( ! Number.isFinite( s ) || s >= b || s + len <= a ) continue;

        const r = textRange( span, Math.max( a, s ) - s, Math.min( b, s + len ) - s );
        if( r ) for( const rc of r.getClientRects() ) out.push( rc );
    }
    return out;
}

// The painted spans once, grouped by paragraph: pid -> [ span ... ], for runRects.
export function runIndex( root )
{
    const index = new Map();

    for( const span of root.querySelectorAll( '.layout-run-text[data-paragraph-id][data-start]' ) )
    {
        const pid = span.getAttribute( 'data-paragraph-id' );
        if( ! index.has( pid ) ) index.set( pid, [] );
        index.get( pid ).push( span );
    }
    return index;
}

// A Range over characters [a, b) of an element's text, across its text nodes.
function textRange( el, a, b )
{
    const walk  = document.createTreeWalker( el, NodeFilter.SHOW_TEXT );
    const range = document.createRange();
    let pos = 0, set = 0, n;

    while( ( n = walk.nextNode() ) )
    {
        const len = n.data.length;
        if( ! ( set & 1 ) && a <= pos + len ) { range.setStart( n, a - pos ); set |= 1; }
        if( ( set & 1 ) && b <= pos + len )   { range.setEnd( n, b - pos );   set |= 2; break; }
        pos += len;
    }
    return set === 3 ? range : null;
}
