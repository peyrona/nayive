/*
 * dictionaries.js - Language: the two dictionary sources, both over the
 * internet and both without a key (CORS checked 2026-10-28).
 *
 * WIKTIONARY. A foreign word's entry in the TARGET language's Wiktionary is
 * defined in the target language - fr.wiktionary "estación" (Espagnol)
 * says "Gare. Station. Saison." - which is exactly a translation. When that
 * page does not exist, the SOURCE language's Wiktionary is read for its
 * translation table ("Français : gare"). Pages come through the MediaWiki
 * parse API as HTML and are read in an inert DOMParser document: nothing in
 * them runs, and only their text is kept.
 *
 * TATOEBA. Example sentences with a translation (api.tatoeba.org, v1).
 */

import { TranslationError } from './errors.js';
import { fetchJson } from './net.js';
import { ISO639_3 } from './languages.js';

// The heading of a language's section in each Wiktionary: NAMES[wiki][lang].
const NAMES = {
    es: { es: [ 'Español' ], fr: [ 'Francés' ], zh: [ 'Chino', 'Mandarín', 'Chino mandarín' ], de: [ 'Alemán' ], pt: [ 'Portugués' ] },
    fr: { es: [ 'Espagnol' ], fr: [ 'Français' ], zh: [ 'Chinois', 'Mandarin' ], de: [ 'Allemand' ], pt: [ 'Portugais' ] },
    de: { es: [ 'Spanisch' ], fr: [ 'Französisch' ], zh: [ 'Chinesisch' ], de: [ 'Deutsch' ], pt: [ 'Portugiesisch' ] },
    pt: { es: [ 'Espanhol' ], fr: [ 'Francês' ], zh: [ 'Chinês', 'Mandarim' ], de: [ 'Alemão' ], pt: [ 'Português' ] },
    zh: { es: [ '西班牙語', '西班牙语' ], fr: [ '法語', '法语' ], zh: [ '漢語', '汉语', '官話', '官话' ], de: [ '德語', '德语' ], pt: [ '葡萄牙語', '葡萄牙语' ] }
};

const MAX_SENSES = 8;

async function parsePage( wiki, word, signal )
{
    const q = new URLSearchParams( { action: 'parse', page: word, prop: 'text', format: 'json', formatversion: '2',
                                     redirects: '1', origin: '*' } );
    const j = await fetchJson( 'https://' + wiki + '.wiktionary.org/w/api.php?' + q, { signal } );
    if( ! j || ! j.parse || typeof j.parse.text !== 'string' ) return null;   // "missingtitle"
    const doc = new DOMParser().parseFromString( j.parse.text, 'text/html' );
    doc.querySelectorAll( 'style, script, sup.reference, .mw-editsection, .reference, .noprint' ).forEach( ( n ) => n.remove() );
    return { doc, title: j.parse.title || word };
}

const clean = ( s ) => String( s || '' ).replace( /\s+/g, ' ' ).trim();

// The elements of the section whose heading names `lang`, in document order.
function section( doc, wiki, lang )
{
    const names = ( NAMES[ wiki ] && NAMES[ wiki ][ lang ] ) || [];
    const heads = Array.from( doc.querySelectorAll( 'h2' ) );
    const h = heads.find( ( x ) => names.some( ( n ) => clean( x.textContent ).toLowerCase().includes( n.toLowerCase() ) ) );
    if( ! h ) return null;
    const start = h.closest( '.mw-heading' ) || h;
    const out = [];
    for( let n = start.nextElementSibling; n; n = n.nextElementSibling )
    {
        if( n.matches( 'h2, .mw-heading2' ) ) break;
        out.push( n );
    }
    return out;
}

// "(Chemin de fer) Gare." -> { translation: "Gare", gloss: "Chemin de fer" }
function sense( text, extraGloss )
{
    let t = clean( text ).replace( /^\[\d+\]\s*/, '' );
    let gloss = extraGloss || '';
    const m = t.match( /^\(([^)]{1,60})\)\s*(.+)$/ );
    if( m ) { gloss = gloss ? gloss + ', ' + m[ 1 ] : m[ 1 ]; t = m[ 2 ]; }
    t = t.replace( /[.。]$/, '' ).trim();
    if( t.length > 160 ) t = t.slice( 0, 157 ) + '…';
    return t ? { translation: t, gloss: gloss || undefined } : null;
}

// The definitions in a section: <ol><li> (fr, pt, zh, en), <dl><dt><dd> (es),
// or the "Bedeutungen:" list (de).
function definitions( nodes, wiki )
{
    const senses = [];
    let category = '';
    const add = ( s ) => { if( s && senses.length < MAX_SENSES && ! senses.some( ( x ) => x.translation === s.translation ) ) senses.push( s ); };

    for( const n of nodes )
    {
        const head = n.matches( 'h3, h4, .mw-heading3, .mw-heading4' ) ? clean( n.textContent ) : '';
        if( head ) { if( ! category && ! /tymolog|Prononciation|發音|詞源|Pronunciación|Pronúncia|Aussprache/i.test( head ) ) category = head; continue; }

        if( wiki === 'de' )
        {
            if( /^Bedeutungen:?$/.test( clean( n.textContent ) ) )
            {
                const dl = n.nextElementSibling;
                if( dl && dl.tagName === 'DL' ) dl.querySelectorAll( ':scope > dd' ).forEach( ( dd ) => add( sense( dd.textContent ) ) );
            }
            continue;
        }
        if( n.tagName === 'OL' )
            n.querySelectorAll( ':scope > li' ).forEach( ( li ) =>
            {
                const c = li.cloneNode( true );
                c.querySelectorAll( 'ul, ol, dl' ).forEach( ( x ) => x.remove() );   // the examples under it
                add( sense( c.textContent ) );
            } );
        if( n.tagName === 'DL' && wiki === 'es' )
            n.querySelectorAll( ':scope > dt' ).forEach( ( dt ) =>
            {
                const dd = dt.nextElementSibling;
                if( ! dd || dd.tagName !== 'DD' ) return;
                const domain = clean( dt.textContent ).replace( /^\d+\s*/, '' );
                add( sense( dd.textContent, domain ) );
            } );
    }
    return { senses, category };
}

// "Français : gare (fr) féminin, station" -> [ "gare", "station" ]
function fromTranslationTable( nodes, wiki, target )
{
    const names = ( NAMES[ wiki ] && NAMES[ wiki ][ target ] ) || [];
    const senses = [];
    for( const n of nodes )
        n.querySelectorAll( 'li' ).forEach( ( li ) =>
        {
            const t = clean( li.textContent );
            const name = names.find( ( x ) => t.toLowerCase().startsWith( x.toLowerCase() ) );
            if( ! name ) return;
            const rest = t.slice( name.length ).replace( /^\s*[:：]\s*/, '' );
            for( const w of rest.split( /[,;，；]/ ) )
            {
                const word = w.replace( /\[\d+\]|\([^)]*\)|\b(m|f|n|masculin|féminin|neutre|masculino|femenino|feminino)\b\.?/gi, '' ).trim();
                if( word && word.length <= 40 && senses.length < MAX_SENSES && ! senses.some( ( s ) => s.translation === word ) )
                    senses.push( { translation: word } );
            }
        } );
    return senses;
}

export const wiktionary = {
    async lookup( word, { source, target, signal } )
    {
        // 1. The target's Wiktionary, the source language's section.
        const page = await parsePage( target, word, signal );
        if( page )
        {
            const nodes = section( page.doc, target, source );
            if( nodes )
            {
                const r = definitions( nodes, target );
                if( r.senses.length ) return { word: page.title, category: r.category, senses: r.senses, examples: [] };
            }
        }
        // 2. The source's Wiktionary, its translation table.
        const own = await parsePage( source, word, signal );
        if( own )
        {
            const nodes = section( own.doc, source, source ) || Array.from( own.doc.body.children );
            const senses = fromTranslationTable( nodes, source, target );
            if( senses.length ) return { word: own.title, category: definitions( nodes, source ).category, senses, examples: [] };
        }
        return null;
    }
};

export const tatoeba = {
    async lookup( word, { source, target, signal } )
    {
        const from = ISO639_3[ source ], to = ISO639_3[ target ];
        const q = new URLSearchParams( { lang: from, q: '=' + word, 'trans:lang': to, sort: 'relevance', limit: '5' } );
        let j;
        try { j = await fetchJson( 'https://api.tatoeba.org/v1/sentences?' + q, { signal } ); }
        catch( e ) { if( e instanceof TranslationError && e.category === 'unsupported' ) return null; throw e; }
        const examples = [];
        for( const s of ( j && j.data ) || [] )
        {
            const flat = [].concat( ...( s.translations || [] ).map( ( t ) => ( Array.isArray( t ) ? t : [ t ] ) ) );
            const tr = flat.find( ( t ) => t && t.lang === to && t.text );
            if( tr && s.text ) examples.push( { source: s.text, target: tr.text } );
            if( examples.length >= 2 ) break;
        }
        return examples.length ? { senses: [], examples } : null;
    }
};
