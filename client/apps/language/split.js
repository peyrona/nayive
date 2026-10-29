/*
 * split.js - Language: cut a text into pieces an engine can take (design
 * document, section 10.3).
 *
 * Paragraphs first; a paragraph longer than the limit by sentences
 * (Intl.Segmenter); a sentence still too long at spaces, and as a last resort
 * anywhere. Line breaks and the spaces around the pieces are kept as pieces of
 * their own, marked untranslatable, so joining the output gives the same
 * layout back.
 *
 *   splitText( text, 450 )                    -> [ { text, translatable }, ... ]
 *   splitText( text, 480, utf8Length )        a limit in bytes (MyMemory)
 */

export function utf8Length( s ) { return new TextEncoder().encode( s ).length; }

const charLength = ( s ) => s.length;

export function splitText( text, max, measure )
{
    const len   = measure || charLength;
    const parts = [];
    const push  = ( t, translatable ) => { if( t ) parts.push( { text: t, translatable } ); };

    // Keep the runs of blank space (line breaks included) as they are.
    for( const chunk of String( text ).split( /(\s*\n\s*)/ ) )
    {
        if( ! chunk ) continue;
        if( ! chunk.trim() ) { push( chunk, false ); continue; }
        const lead  = chunk.match( /^\s*/ )[ 0 ];
        const trail = chunk.match( /\s*$/ )[ 0 ];
        const body  = chunk.slice( lead.length, chunk.length - trail.length );
        push( lead, false );
        fit( body, max, len ).forEach( ( p, i ) => { if( i ) push( ' ', false ); push( p, true ); } );
        push( trail, false );
    }
    return parts;
}

// One paragraph -> pieces no longer than max, each without outer spaces;
// splitText puts one space back between them (dropped for Chinese output).
function fit( para, max, len )
{
    if( len( para ) <= max ) return [ para ];
    const out = [];
    let cur = '';
    for( const sentence of sentences( para ) )
    {
        const s = sentence.trim();
        if( ! s ) continue;
        if( len( s ) > max )
        {
            if( cur ) { out.push( cur ); cur = ''; }
            out.push( ...byWords( s, max, len ) );
            continue;
        }
        const next = cur ? cur + ' ' + s : s;
        if( len( next ) <= max ) cur = next;
        else { out.push( cur ); cur = s; }
    }
    if( cur ) out.push( cur );
    return out;
}

function sentences( para )
{
    try
    {
        const seg = new Intl.Segmenter( undefined, { granularity: 'sentence' } );
        return Array.from( seg.segment( para ), ( x ) => x.segment );
    }
    catch( e ) { return para.split( /(?<=[.!?。！？])\s+/ ); }
}

function byWords( s, max, len )
{
    const out = [];
    let cur = '';
    for( const w of s.split( /\s+/ ) )
    {
        if( len( w ) > max )                          // one "word" longer than the limit (Chinese has no spaces)
        {
            if( cur ) { out.push( cur ); cur = ''; }
            let rest = w;
            while( len( rest ) > max )
            {
                let n = Math.min( rest.length, max );
                while( n > 1 && len( rest.slice( 0, n ) ) > max ) n--;
                out.push( rest.slice( 0, n ) );
                rest = rest.slice( n );
            }
            cur = rest;
            continue;
        }
        const next = cur ? cur + ' ' + w : w;
        if( len( next ) <= max ) cur = next;
        else { out.push( cur ); cur = w; }
    }
    if( cur ) out.push( cur );
    return out;
}
