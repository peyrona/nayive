/*
 * page.js - the vendored docx-editor.dev engine, on a page with nothing else.
 *
 * It loads the engine the way Write does - the bundle, its stylesheet, the
 * packaged fonts on demand - from the folder tools/build-docx-editor.sh wrote,
 * by the names in its lock file, so a bump needs no edit here. smoke.mjs
 * drives it through window.__smoke; by hand it opens, saves and prints a file.
 *
 * Only the public API: createDocxEditor, snapshot(), save(), findMatches()...
 * NO @docx-editor.dev/pro: comments and tracked changes are its paid part.
 */
const readout  = document.getElementById( 'readout' );
const host     = document.getElementById( 'host' );
const filePick = document.getElementById( 'file' );

const lock = await fetch( '/engine/docx-editor.lock.json' ).then( r =>
{
    if( ! r.ok ) throw new Error( 'no engine build - run tools/build-docx-editor.sh' );
    return r.json();
} );

await new Promise( resolve =>
{
    const link = Object.assign( document.createElement( 'link' ), { rel: 'stylesheet', href: '/engine/' + lock.css } );
    link.onload = link.onerror = resolve;
    document.head.append( link );
} );

const { createDocxEditor, packagedFonts } = await import( '/engine/' + lock.bundle );

// On demand: only the families a document names are fetched (Calibri ->
// Carlito, Times New Roman -> Liberation Serif...). Without fonts the engine
// falls back to a fixed-width estimate and the page breaks are guesses.
const FONTS = packagedFonts();

let editor   = null;
let fileName = 'test.docx';
let errors   = [];

//----------------------------------------------------------------------------//
// OPEN

function mount( source, name )
{
    if( editor ) editor.destroy();
    host.textContent = '';
    errors   = [];
    fileName = name || 'test.docx';

    editor = createDocxEditor( { container: host, document: source, fonts: FONTS,
                                 locale: 'es-ES', author: 'Nayive', mode: 'edit' } );
    editor.on( 'change',          report );
    editor.on( 'selectionChange', report );
    editor.on( 'error', e => { errors.push( String( e?.message || e?.code || e ) ); report(); } );
    report();
    return editor;
}

// Resolves once the document is laid out: not loading, not opening, and the
// font measurer settled (so the page count is the real one, not the estimate).
function ready( ms = 30000 )
{
    const t0 = Date.now();
    return new Promise( ( resolve, reject ) =>
    {
        ( function poll()
        {
            const s = editor.snapshot();
            const f = editor.fontMeasurement();
            if( s.parseError )                                                     return reject( new Error( 'parseError: ' + s.parseError ) );
            if( ! s.isLoading && ! s.isOpening && ! f.resolving && s.page.total > 0 ) return resolve( Date.now() - t0 );
            if( Date.now() - t0 > ms )                                             return reject( new Error( 'not open after ' + ms + ' ms' ) );
            setTimeout( poll, 50 );
        } )();
    } );
}

//----------------------------------------------------------------------------//
// WHAT THE READOUT SAYS

function report()
{
    if( ! editor ) return;
    const s = editor.snapshot();
    const f = editor.fontMeasurement();
    const parts = [
        'docx-editor.dev ' + lock.core,
        fileName,
        s.page.total + ' page(s)',
        f.measurer === 'shaped' ? 'real font metrics' : 'ESTIMATED metrics (no fonts)',
    ];
    if( s.fontSubstitutions?.length ) parts.push( 'substituted: ' + s.fontSubstitutions.join( ', ' ) );
    if( s.parseError )                parts.push( 'DOES NOT OPEN: ' + s.parseError );
    if( errors.length )               parts.push( errors.length + ' error(s)' );
    readout.textContent = parts.join( ' · ' );
    readout.classList.toggle( 'warn', !! ( s.parseError || errors.length ) );
}

//----------------------------------------------------------------------------//
// SAVE AND PRINT

async function saveBytes()
{
    return new Uint8Array( await editor.save() );
}

function download( bytes, name )
{
    const url = URL.createObjectURL( new Blob( [ bytes ],
                { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } ) );
    const a = Object.assign( document.createElement( 'a' ), { href: url, download: name } );
    a.click();
    setTimeout( () => URL.revokeObjectURL( url ), 5000 );
}

// Paper size comes from the document (twips -> mm), so a Letter or landscape
// file prints on its own paper; the painted pages already carry the margins.
function preparePrint()
{
    const ps = editor.getPageSetup();
    if( ps )
    {
        const mm = t => ( t / 1440 * 25.4 ).toFixed( 1 ) + 'mm';
        document.getElementById( 'pageRule' ).textContent =
            `@page { size: ${ mm( ps.pageWidthTwips ) } ${ mm( ps.pageHeightTwips ) }; margin: 0; }`;
    }
}

//----------------------------------------------------------------------------//
// THE SPELL-CHECK OVERLAY'S ASSUMPTION (plan, Phase 4)
//
// Write's spell check will read words off the PAINTED spans and replace one
// with findMatches() + replaceMatch(). That works only if a painted span's
// data-paragraph-id is the same string as TextMatch.blockId, and its
// data-start + the offset inside the span is TextMatch.start. This asks, for
// up to `max` whole words painted on screen. The engine paints about a word per
// span, so whether a word is WHOLE is read off the paragraph's painted text
// around it, not the span's.

function idProbe( max = 25 )
{
    const spans = [ ...document.querySelectorAll( '[data-paragraph-id][data-start]' ) ];
    const chars = new Map();              // "<paragraph id>@<offset>" -> the painted character
    for( const span of spans )
    {
        const pid = span.getAttribute( 'data-paragraph-id' ), start = Number( span.getAttribute( 'data-start' ) );
        const text = span.textContent;       // UTF-16 offsets, like m.index below
        for( let i = 0; i < text.length; i++ ) chars.set( pid + '@' + ( start + i ), text[ i ] );
    }
    const edge = ( pid, at ) => { const c = chars.get( pid + '@' + at ); return c !== undefined && ! /[\p{L}\p{N}]/u.test( c ); };

    const misses = [];
    let tried = 0, same = 0;
    for( const span of spans )
    {
        if( tried >= max ) break;
        const pid = span.getAttribute( 'data-paragraph-id' );
        const m   = /\p{L}{4,}/u.exec( span.textContent );
        if( ! m ) continue;
        const at  = Number( span.getAttribute( 'data-start' ) ) + m.index;
        if( ! edge( pid, at - 1 ) || ! edge( pid, at + m[ 0 ].length ) ) continue;
        tried++;

        const hits = editor.findMatches( m[ 0 ], { wholeWord: true, matchCase: true } );
        if( hits.some( h => h.blockId === pid && h.start === at ) ) same++;
        else if( misses.length < 3 )
            misses.push( { word: m[ 0 ], pid, at, found: hits.slice( 0, 3 ).map( h => h.blockId + '@' + h.start ) } );
    }
    return { spans: spans.length, tried, same, misses, sample: spans[ 0 ]?.getAttribute( 'data-paragraph-id' ) ?? null };
}

//----------------------------------------------------------------------------//
// BAR

document.getElementById( 'btnOpen'  ).onclick = () => filePick.click();
document.getElementById( 'btnSave'  ).onclick = async () => download( await saveBytes(), fileName );
document.getElementById( 'btnPrint' ).onclick = () => { preparePrint(); window.print(); };

filePick.addEventListener( 'change', async () =>
{
    const f = filePick.files[ 0 ];
    if( ! f ) return;
    mount( new Uint8Array( await f.arrayBuffer() ), f.name );
    filePick.value = '';
} );

//----------------------------------------------------------------------------//
// BOOT - ?f=<name> opens a file of the corpus (serve.mjs's /corpus/), else blank.

const want = new URLSearchParams( location.search ).get( 'f' );
if( want )
{
    const buf = await fetch( '/corpus/' + encodeURIComponent( want ) ).then( r => r.arrayBuffer() );
    mount( new Uint8Array( buf ), want );
}
else mount( 'blank', 'test.docx' );

// For smoke.mjs. Not an API - a handle for the headless run.
window.__smoke = {
    get editor() { return editor; },
    lock, mount, ready, saveBytes, preparePrint, report, idProbe,
    errors: () => errors.slice()
};
