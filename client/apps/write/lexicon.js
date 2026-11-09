/*
 * lexicon.js - Write's dictionary panel (#lexPanel in index.html): synonyms,
 * antonyms, definitions with examples, and etymology of one word.
 *
 * The panel is Ayni's dock (Ayni.dock): it floats, or docks to any window
 * edge when dropped there by its top bar.
 *
 * SOURCE. Wiktionary, in the chosen language (es, en, fr, de, pt): open, no
 * key, no account. The request carries no cookies (credentials: 'omit') and
 * no referrer, so Wiktionary only sees the word and the IP. ONE request per
 * word: the page is read once and its synonyms, antonyms, senses and
 * etymology all come from it (cached for the session). The page comes through
 * the MediaWiki parse API as HTML and is read in an inert DOMParser document:
 * nothing in it runs, only its text is kept, and it is shown with textContent.
 *
 * Every Wiktionary lays a page out its own way; read() walks the language's
 * section and sorts what it meets by its heading ("Sinónimos", "Synonyms",
 * "Étymologie"...), by a bold label ("Sinónimos:" in es, "Synonyme:" in de)
 * or by Wiktionary's own marks (en .nyms).
 *
 *   const lex = createLexicon( {
 *       word : () => string,     // the selected word, or the word at the caret ('' = none)
 *       lang : () => code        // the starting language (the proofing one)
 *   } );
 *   lex.toggle()   lex.open()   lex.close()   lex.isOpen()
 */

const LANGS = [ 'es', 'en', 'fr', 'de', 'pt' ];
const NAME  = { es: 'Español', en: 'English', fr: 'Français', de: 'Deutsch', pt: 'Português' };
const LANG_KEY = 'write.lex.lang';

const MAX_SENSES = 14, MAX_EX = 2, MAX_WORDS = 40, MAX_ETY = 2;

const ETY  = /etimolog|etymolog|étymolog|herkunft/i;
const SYN  = /sin[oóô]nim|synonym/i;
const ANT  = /ant[oóô]nim|antonym|gegenw[öo]rter/i;
const EX   = /^(ejemplos?|beispiele|exemplos?|exemples?|examples?)\b/i;
const DEFL = /^bedeutungen/i;
const SKIP = /pronun|prononc|pronúncia|aussprache|referen|référen|notes|anmerkung|quellen|anagram|homophon|traduc|transl|übersetz|tradução/i;

const clean = ( s ) => String( s || '' ).replace( /\s+/g, ' ' ).trim();
const clip  = ( s, n ) => ( s.length > n ? s.slice( 0, n - 1 ) + '…' : s );

//---- reading a page --------------------------------------------------------//

const cache = new Map();          // lang + '|' + word -> Promise<result|null>

async function fetchPage( lang, title, signal )
{
    const q = new URLSearchParams( { action: 'parse', page: title, prop: 'text', format: 'json', formatversion: '2',
                                     redirects: '1', origin: '*' } );
    const r = await fetch( 'https://' + lang + '.wiktionary.org/w/api.php?' + q,
                           { signal, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' } );
    if( ! r.ok ) throw new Error( 'HTTP ' + r.status );
    const j = await r.json();
    if( ! j || ! j.parse || typeof j.parse.text !== 'string' ) return null;     // no such page
    const doc = new DOMParser().parseFromString( j.parse.text, 'text/html' );
    doc.querySelectorAll( 'style, script, link, sup, .mw-editsection, .reference, .noprint, figure, .etytree, .cite-bracket' )
       .forEach( ( n ) => n.remove() );
    return { doc, title: j.parse.title || title };
}

// The language's own section: from its heading (h1 in pt, h2 elsewhere) to the next one of that level.
function section( doc, lang )
{
    const name = NAME[ lang ].toLowerCase();
    const heads = Array.from( doc.querySelectorAll( 'h1, h2' ) );
    const h = heads.find( ( x ) => clean( x.textContent ).toLowerCase() === name )
           || heads.find( ( x ) => clean( x.textContent ).toLowerCase().includes( name ) );
    if( ! h ) return null;
    const level = h.tagName;
    const start = h.closest( '.mw-heading' ) || h;
    const out = [];
    for( let n = start.nextElementSibling; n; n = n.nextElementSibling )
    {
        const t = n.matches( '.mw-heading' ) ? n.querySelector( 'h1, h2, h3, h4, h5, h6' ) : n.matches( 'h1, h2, h3, h4, h5, h6' ) ? n : null;
        if( t && t.tagName <= level ) break;          // 'H1' < 'H2': the same level or above ends it
        out.push( n );
    }
    return out;
}

const headingOf = ( n ) => ( n.matches( '.mw-heading, h1, h2, h3, h4, h5, h6' ) ? clean( n.textContent ) : '' );

// de: a bold paragraph "Synonyme:" names what the next list holds.
const labelOf = ( n ) => ( n.tagName === 'P' && /:$/.test( clean( n.textContent ) ) && clean( n.textContent ).length < 40 ? clean( n.textContent ) : '' );

function modeOf( text )
{
    if( ETY.test( text ) ) return 'ety';
    if( SYN.test( text ) ) return 'syn';
    if( ANT.test( text ) ) return 'ant';
    if( EX.test( text ) )  return 'ex';
    if( SKIP.test( text ) ) return 'skip';
    return 'def';
}

// The words a list links to: no namespace pages (Thesaurus:, Category:), no labels in italics.
function wordsIn( node, into, self )
{
    for( const a of node.querySelectorAll( 'a' ) )
    {
        const href = a.getAttribute( 'href' ) || '', title = a.getAttribute( 'title' ) || '';
        if( ! /^\/wiki\/|^\/w\/index\.php\?title=/.test( href ) || title.indexOf( ':' ) >= 0 ) continue;
        if( a.closest( 'i, small, .qualifier-content, .ib-content, .gender' ) ) continue;
        const w = clean( a.textContent );
        if( w && w.length <= 40 && w.toLowerCase() !== self && into.length < MAX_WORDS && into.indexOf( w ) < 0 ) into.push( w );
    }
}

function textOf( node, drop )
{
    const c = node.cloneNode( true );
    if( drop ) c.querySelectorAll( drop ).forEach( ( x ) => x.remove() );
    return clean( c.textContent ).replace( /^\[\d+(?:[,–-]\s*\d+)*\]\s*/, '' );
}

function read( nodes, lang, self )
{
    const res = { groups: [], syn: [], ant: [], ety: [], ex: [] };
    let mode = 'def', group = null, last = null;
    const count = () => res.groups.reduce( ( n, g ) => n + g.senses.length, 0 );
    const groupNow = () => { if( ! group ) { group = { cat: '', senses: [] }; res.groups.push( group ); } return group; };
    const addSense = ( text ) =>
    {
        text = clip( text.replace( /\s*[.。]$/, '' ), 300 );
        if( ! text || count() >= MAX_SENSES ) { last = null; return; }
        last = { text, ex: [] };
        groupNow().senses.push( last );
    };
    const addEx = ( text, to ) =>
    {
        text = clip( clean( text ).replace( /^(ejemplos?|exemplos?|exemples?|examples?)\s*:\s*/i, '' ), 240 );
        if( ! text ) return;
        const s = to || last;
        if( s ) { if( s.ex.length < MAX_EX ) s.ex.push( text ); }
        else if( res.ex.length < MAX_EX * 2 ) res.ex.push( text );
    };
    // A list item that names what it holds: "Sinónimos: a, b", en's <span class="nyms synonym">.
    const labelled = ( li ) =>
    {
        const b = li.querySelector( ':scope > b' ) || li.querySelector( ':scope > span > b' );
        const label = b ? clean( b.textContent ) : '';
        if( ! label ) return false;
        if( SYN.test( label ) ) { wordsIn( li, res.syn, self ); return true; }
        if( ANT.test( label ) ) { wordsIn( li, res.ant, self ); return true; }
        if( EX.test( label ) )  { b.remove(); addEx( textOf( li, '.ref, .trad' ) ); return true; }
        return /:\s*$/.test( label );                  // "Uso:", "Ámbito:" ... not ours
    };
    const nyms = ( root ) =>
    {
        root.querySelectorAll( '.nyms.synonym' ).forEach( ( s ) => wordsIn( s, res.syn, self ) );
        root.querySelectorAll( '.nyms.antonym' ).forEach( ( s ) => wordsIn( s, res.ant, self ) );
    };

    for( const n of nodes )
    {
        const head = headingOf( n );
        if( head )
        {
            mode = modeOf( head );
            if( mode === 'def' ) { group = { cat: clip( head.replace( /\s*\d+$/, '' ), 60 ), senses: [] }; res.groups.push( group ); last = null; }
            continue;
        }
        const label = lang === 'de' ? labelOf( n ) : '';
        if( label ) { mode = DEFL.test( label ) ? 'def' : modeOf( label ) === 'def' ? 'skip' : modeOf( label ); continue; }

        if( mode === 'skip' ) continue;
        if( mode === 'ety' )
        {
            if( res.ety.length < MAX_ETY && /^(P|DL|UL|OL)$/.test( n.tagName ) ) { const t = clip( textOf( n ), 600 ); if( t ) res.ety.push( t ); }
            continue;
        }
        if( mode === 'syn' || mode === 'ant' ) { wordsIn( n, res[ mode ], self ); continue; }
        if( mode === 'ex' )                     // de "Beispiele:": "[2] ..." goes with sense 2
        {
            n.querySelectorAll( ':scope > dd' ).forEach( ( dd ) =>
            {
                const m = clean( dd.textContent ).match( /^\[(\d+)/ );
                const all = [].concat( ...res.groups.map( ( g ) => g.senses ) );
                addEx( textOf( dd ), m ? all[ Number( m[ 1 ] ) - 1 ] : null );
            } );
            continue;
        }

        // mode === 'def'
        if( lang === 'de' )
        {
            if( n.tagName === 'DL' ) n.querySelectorAll( ':scope > dd' ).forEach( ( dd ) => addSense( textOf( dd ) ) );
            continue;
        }
        if( n.tagName === 'OL' )                // en, fr, pt: one <li> per sense, its examples under it
        {
            n.querySelectorAll( ':scope > li' ).forEach( ( li ) =>
            {
                nyms( li );
                addSense( textOf( li, 'ul, ol, dl, .nyms, .HQToggle' ) );
                if( ! last ) return;
                li.querySelectorAll( ':scope > dl > dd, :scope > ul > li' ).forEach( ( x ) =>
                {
                    if( x.querySelector( '.nyms' ) || labelled( x ) ) return;
                    if( x.querySelector( '.cited-source, .citation-whole' ) && ! x.querySelector( '.e-quotation, .h-quotation' ) ) return;
                    const q = x.querySelector( '.e-quotation, .h-quotation' );
                    addEx( q ? clean( q.textContent ) : textOf( x, 'dl, ul, .e-translation' ) );
                } );
            } );
            continue;
        }
        if( n.tagName === 'DL' )                // es: <dt>1</dt><dd>sense <ul><li>Sinónimos: ...</li></ul></dd>
        {
            let dt = false;
            for( const c of n.children )
            {
                if( c.tagName === 'DT' ) { dt = true; continue; }
                if( c.tagName !== 'DD' ) continue;
                if( dt ) { addSense( textOf( c, 'ul, ol, dl' ) ); dt = false; }
                c.querySelectorAll( 'li' ).forEach( ( li ) => labelled( li ) );
            }
            continue;
        }
        if( n.tagName === 'UL' ) n.querySelectorAll( ':scope > li' ).forEach( ( li ) => labelled( li ) );
    }
    res.groups = res.groups.filter( ( g ) => g.senses.length );
    return res;
}

// Wiktionary titles are case-sensitive: the word as given, then lower case, then Capitalised (German nouns).
function lookup( lang, word )
{
    const key = lang + '|' + word;
    if( cache.has( key ) ) return cache.get( key );
    const p = ( async () =>
    {
        const lower = word.toLowerCase(), cap = lower.charAt( 0 ).toUpperCase() + lower.slice( 1 );
        for( const t of [ ...new Set( [ word, lower, cap ] ) ] )
        {
            const page = await fetchPage( lang, t );
            if( ! page ) continue;
            const nodes = section( page.doc, lang );
            if( ! nodes ) continue;
            const r = read( nodes, lang, lower );
            r.title = page.title;
            r.url = 'https://' + lang + '.wiktionary.org/wiki/' + encodeURIComponent( page.title.replace( / /g, '_' ) );
            return r;
        }
        return null;
    } )();
    cache.set( key, p );
    p.catch( () => cache.delete( key ) );          // a network failure is tried again next time
    return p;
}

//---- the panel -------------------------------------------------------------//

export function createLexicon( o )
{
    const panel = document.getElementById( 'lexPanel' );
    const field = document.getElementById( 'lexWord' );
    const out   = document.getElementById( 'lexOut' );
    const t = ( k ) => Ayni.t( 'write.lex.' + k );
    let what = null, seq = 0;

    const dock = Ayni.dock( panel, { key: 'write.lex.dock', edge: 'right' } );

    let saved = null;
    try { saved = localStorage.getItem( LANG_KEY ); } catch( _ ) {}
    const first = LANGS.indexOf( saved ) >= 0 ? saved : LANGS.indexOf( o.lang() ) >= 0 ? o.lang() : 'en';
    const langPick = Ayni.picker( '#lexLang', {
        options : LANGS.map( ( c ) => ( { value: c, text: Ayni.t( 'write.proof.' + c ), short: c.toUpperCase() } ) ),
        value   : first,
        onChange: function( v ) { try { localStorage.setItem( LANG_KEY, v ); } catch( _ ) {} if( what ) show( what ); }
    } );
    const lang = () => langPick.value || first;

    // The copy button must not take the caret out of the document: the selection is read as it is pressed.
    const copy = document.getElementById( 'lexCopyBtn' );
    copy.addEventListener( 'pointerdown', ( e ) => e.preventDefault() );
    copy.addEventListener( 'click', () =>
    {
        const w = clean( o.word() );
        if( ! w ) { Ayni.toast( 'info', t( 'noSel' ) ); return; }
        field.value = w;
        if( what ) show( what );
    } );

    for( const [ id, kind ] of [ [ 'lexSynBtn', 'syn' ], [ 'lexAntBtn', 'ant' ], [ 'lexDefBtn', 'def' ] ] )
        document.getElementById( id ).addEventListener( 'click', () => show( kind ) );
    field.addEventListener( 'keydown', ( e ) => { if( e.key === 'Enter' ) { e.preventDefault(); show( what || 'def' ); } } );

    const el = ( tag, cls, text ) => { const x = document.createElement( tag ); if( cls ) x.className = cls; if( text != null ) x.textContent = text; return x; };
    const note = ( text ) => { out.replaceChildren( el( 'p', 'lex-note', text ) ); };

    function pressed( kind )
    {
        for( const [ id, k ] of [ [ 'lexSynBtn', 'syn' ], [ 'lexAntBtn', 'ant' ], [ 'lexDefBtn', 'def' ] ] )
            document.getElementById( id ).setAttribute( 'aria-pressed', String( k === kind ) );
    }

    async function show( kind )
    {
        what = kind; pressed( kind );
        const word = clean( field.value );
        if( ! word ) { note( t( 'typeWord' ) ); field.focus(); return; }
        const my = ++seq;
        note( t( 'busy' ) );
        let r;
        try { r = await lookup( lang(), word ); }
        catch( _ ) { if( my === seq ) note( t( 'offline' ) ); return; }
        if( my !== seq ) return;                    // a newer question was asked meanwhile
        if( ! r ) { note( t( 'none' ) ); return; }

        const box = [];
        if( kind === 'syn' || kind === 'ant' )
        {
            const list = r[ kind ];
            if( ! list.length ) box.push( el( 'p', 'lex-note', t( 'none' ) ) );
            else
            {
                const words = el( 'div', 'lex-words' );
                for( const w of list )
                {
                    // A word found: tap it to ask about it in turn.
                    const b = el( 'button', 'btn text bordered sm', w );
                    b.type = 'button';
                    b.addEventListener( 'click', () => { field.value = w; show( kind ); } );
                    words.append( b );
                }
                box.push( words );
            }
        }
        else
        {
            if( ! r.groups.length && ! r.ety.length ) box.push( el( 'p', 'lex-note', t( 'none' ) ) );
            for( const g of r.groups )
            {
                if( g.cat ) box.push( el( 'h4', 'lex-cat', g.cat ) );
                const ol = el( 'ol', 'lex-senses' );
                for( const s of g.senses )
                {
                    const li = el( 'li', null, s.text );
                    for( const x of s.ex ) li.append( el( 'q', 'lex-ex', x ) );
                    ol.append( li );
                }
                box.push( ol );
            }
            for( const x of r.ex ) box.push( el( 'q', 'lex-ex', x ) );
            if( r.ety.length )
            {
                box.push( el( 'h4', 'lex-cat', t( 'ety' ) ) );
                for( const x of r.ety ) box.push( el( 'p', 'lex-ety', x ) );
            }
        }
        const src = el( 'a', 'lex-src', t( 'source' ) + ' · ' + r.title );
        src.href = r.url; src.target = '_blank'; src.rel = 'noopener noreferrer';
        box.push( src );
        out.replaceChildren( ...box );
        out.scrollTop = 0;
    }

    function open()
    {
        dock.open();
        // Opening with a word selected looks it up at once.
        const w = clean( o.word() );
        if( w && w !== clean( field.value ) ) { field.value = w; show( what || 'def' ); }
        else if( ! out.childElementCount ) note( t( 'typeWord' ) );
        field.focus();
    }

    return {
        open,
        close : () => dock.close(),
        toggle: () => ( dock.isOpen ? dock.close() : open() ),
        isOpen: () => dock.isOpen
    };
}

// For tools/: the reader alone, on a parsed section.
export const _test = { section, read, fetchPage };
