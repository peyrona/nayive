/*
 * spike.js - Canvas-Editor, asked the four questions Write actually cares about.
 *
 * This is a SPIKE. It is not Write, it shares no code with Write, and nothing
 * under client/apps/write/ knows it exists. It exists to answer, with real
 * files instead of READMEs:
 *
 *   1. Do his own .docx files open, and do the PAGES survive - size, margins,
 *      orientation, header, footer?
 *   2. What happens to a page NUMBER that came from Word? (Reading the plugin's
 *      importer says: a `PAGE` field arrives as its cached text, so "3" becomes
 *      the literal three and stops counting. The readout below makes that
 *      visible instead of taking my word for it.)
 *   3. Does Spanish type properly - acentos, ñ, ¿ ¡, « » - into a canvas the
 *      editor draws itself, with no contenteditable underneath?
 *   4. What does it PRINT like? Canvas-Editor's print() takes a list of base64
 *      page images, so paper gets pictures of text, not type. Judge it on paper.
 *
 * WHAT IS NOT HERE, on purpose: no Drive, no save-to-server, no .bak, no first
 * save folder, no proofing. Those are Write's, they do not touch the engine,
 * and they are exactly the part a swap would NOT have to rewrite.
 */
import Editor, { docxPlugin } from './lib/canvas-editor_v1.0.3.min.js';

//----------------------------------------------------------------------------//
// THE STARTING DOCUMENT
//
// Spanish on purpose, and every character that a canvas editor could get wrong:
// the accents, the ñ, the opening ¿ and ¡, the guillemets, a ligature-ish "fi".

const SAMPLE_HEADER = [
    { value: 'Nayive · documento de prueba', size: 14, color: '#666666' }
];

const SAMPLE_MAIN = [
    { value: 'El señor de la mañana', size: 26, bold: true },
    { value: '\n' },
    { value: '¿Qué pasó aquí? ¡Nada! Un día de otoño, con niebla, café y una ' +
             '«conversación» difícil sobre el año que viene.', size: 16 },
    { value: '\n' },
    { value: 'Acentos: á é í ó ú ü ñ Ñ · Símbolos: ¿ ¡ « » — … € ' +
             '· Ligaduras: fi fl · Números: 1.234,56', size: 16 },
    { value: '\n' },
    { value: 'Escribe aquí para probar el teclado, el acento agudo y la diéresis.', size: 16 }
];

const SAMPLE_FOOTER = [
    { value: 'Prueba de Canvas-Editor', size: 12, color: '#666666' }
];

// A4 at Canvas-Editor's 96 dpi, and Word's default 1 inch margins.
const OPTIONS = {
    width   : 794,
    height  : 1123,
    margins : [ 96, 96, 96, 96 ],
    header  : { top: 40 },
    footer  : { bottom: 40 },
    // The live page number. `{pageNo}` counts; an imported Word one will not.
    pageNumber: { format: 'Página {pageNo} de {pageCount}', size: 12, color: '#666666' }
};

//----------------------------------------------------------------------------//
// BOOT

const host     = document.getElementById( 'host' );
const readout  = document.getElementById( 'readout' );
const filePick = document.getElementById( 'file' );

const editor = new Editor( host,
                           { header: SAMPLE_HEADER, main: SAMPLE_MAIN, footer: SAMPLE_FOOTER },
                           OPTIONS );
editor.use( docxPlugin );

let pageCount   = 1;
let numbersOn   = true;
let lastOpened  = null;

editor.listener.pageSizeChange = n => { pageCount = n; report(); };
editor.listener.contentChange  = () => report();

// The probe hangs itself on window so the CDP smoke test can read the same
// numbers a person reads, without scraping the bar's text.
window.__spike = { editor, state: () => snapshot() };

report( 'Listo. Abre uno de tus .docx.' );

//----------------------------------------------------------------------------//
// THE READOUT - the whole point of the page
//
// After an import it says what SURVIVED, because that is the decision: pages,
// header, footer, and whether the footer's page number is still a number that
// counts or a frozen digit that came along as text.

function snapshot()
{
    const res  = editor.command.getValue();
    const data = res.data || {};
    const opt  = res.options || {};

    const header = data.header || [];
    const footer = data.footer || [];
    const main   = data.main   || [];

    // A `PAGE` field imported from Word arrives as the cached text Word last
    // drew - "3", "Página 3 de 10". Nothing counts it any more. That is what a
    // footer made only of digits and the word "página" means here.
    const footerText = footer.map( e => e.value || '' ).join( '' ).trim();
    const frozenNum  = /\d/.test( footerText ) &&
                       !/\{pageNo\}/.test( footerText ) &&
                       lastOpened !== null;

    return {
        file        : lastOpened,
        pages       : pageCount,
        paper       : `${ Math.round( opt.width || 0 ) } × ${ Math.round( opt.height || 0 ) } px`,
        margins     : ( opt.margins || [] ).map( Math.round ).join( ' / ' ),
        landscape   : opt.paperDirection === 'horizontal',
        headerCount : header.length,
        // Un fondo de párrafo del .docx sólo puede llegar aquí como `highlight`
        // por elemento: el editor no tiene fondo de párrafo. Cero resaltados en
        // un archivo que traía párrafos con fondo = se perdieron.
        highlights  : main.filter( e => e.highlight ).length,
        footerCount : footer.length,
        mainCount   : main.length,
        footerText  : footerText.slice( 0, 60 ),
        frozenNum   : frozenNum,
        numbersOn   : numbersOn
    };
}

function report( note )
{
    const s = snapshot();
    const bits = [];

    if( s.file ) bits.push( `<b>${ esc( s.file ) }</b>` );
    bits.push( `<span class="spk-num">${ s.pages }</span> pág.` );
    bits.push( `papel ${ s.paper }${ s.landscape ? ' (apaisado)' : '' }` );
    bits.push( `márgenes ${ s.margins }` );
    bits.push( `encabezado: ${ s.headerCount === 0 ? '<span class="spk-warn">ninguno</span>'
                                                   : s.headerCount + ' elem.' }` );
    bits.push( `pie: ${ s.footerCount === 0 ? '<span class="spk-warn">ninguno</span>'
                                            : s.footerCount + ' elem.' }` );
    bits.push( `nº de página: ${ s.numbersOn ? 'vivo' : 'apagado' }` );

    if( s.frozenNum )
        bits.push( `<span class="spk-warn">pie con número fijo: “${ esc( s.footerText ) }”</span>` );

    if( note ) bits.push( `<span class="spk-ok">${ esc( note ) }</span>` );

    readout.innerHTML = bits.join( ' · ' );
}

function esc( s ) { return String( s ).replace( /[<>&"]/g, c => ( { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' } )[ c ] ); }

//----------------------------------------------------------------------------//
// THE FOUR QUESTIONS, one button each

document.getElementById( 'btnOpen' ).onclick = () => filePick.click();

filePick.onchange = () => { if( filePick.files[ 0 ] ) openDocx( filePick.files[ 0 ] ); filePick.value = ''; };

// Drag a file anywhere on the page - faster than the picker when trying twenty
// of his own documents in a row.
document.addEventListener( 'dragover', e => { e.preventDefault(); } );
document.addEventListener( 'drop', e =>
{
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[ 0 ];
    if( f ) openDocx( f );
} );

async function openDocx( file )
{
    if( !/\.docx$/i.test( file.name ) )
    {
        report( `“${ file.name }” no es un .docx.` );
        return;
    }
    report( `abriendo ${ file.name }…` );
    const t0 = performance.now();
    try
    {
        const arrayBuffer = await file.arrayBuffer();
        await editor.command.executeImportDocx( { arrayBuffer } );
        lastOpened = file.name;
        // The import lands asynchronously; one frame is enough for pageSizeChange.
        setTimeout( () => report( `abierto en ${ Math.round( performance.now() - t0 ) } ms` ), 60 );
    }
    catch( err )
    {
        console.error( err );
        report( `falló: ${ err && err.message ? err.message : err }` );
    }
}

document.getElementById( 'btnSave' ).onclick = async () =>
{
    const name = ( lastOpened || 'prueba.docx' ).replace( /\.docx$/i, '' ) + '-canvas';
    try { await editor.command.executeExportDocx( { fileName: name } ); report( `exportado ${ name }.docx` ); }
    catch( err ) { console.error( err ); report( `no exportó: ${ err }` ); }
};

document.getElementById( 'btnPrint' ).onclick = () => editor.command.executePrint();

// Page numbers are an editor OPTION, not content - which is also why an
// imported Word one cannot become this by itself.
document.getElementById( 'btnNum' ).onclick = () =>
{
    numbersOn = !numbersOn;
    editor.command.executeUpdateOptions( { pageNumber: { ...OPTIONS.pageNumber, disabled: !numbersOn } } );
    report();
};

document.getElementById( 'btnZoomIn'  ).onclick = () => editor.command.executePageScaleAdd();
document.getElementById( 'btnZoomOut' ).onclick = () => editor.command.executePageScaleMinus();

// Find: the thing I said a canvas editor could not do. It can - it is built in.
const find = document.getElementById( 'find' );
find.oninput = () => editor.command.executeSearch( find.value || null );
find.onkeydown = e => { if( e.key === 'Enter' ) editor.command.executeSearchNavigateNext(); };
