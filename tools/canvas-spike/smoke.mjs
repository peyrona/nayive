/*
 * smoke.mjs - run his whole .docx folder through Canvas-Editor, headless.
 *
 *     node tools/canvas-spike/smoke.mjs                 all of them
 *     node tools/canvas-spike/smoke.mjs Informe         only names containing this
 *     CORPUS=/some/where node tools/canvas-spike/smoke.mjs
 *
 * Needs Chromium (or Chrome) and the bundle from build.sh. Nothing is written
 * anywhere; the run prints a table and exits.
 *
 * WHY A TABLE AND NOT A PASS/FAIL
 *   The question is not "does it work", it is "what is lost". So for every file
 *   the run compares what the .docx CONTAINS (unzipped: header parts, footer
 *   parts, a PAGE field) with what the editor ENDED UP WITH (its own getValue).
 *   A header that is in the file and not in the editor is the cost, stated in
 *   files instead of in adjectives.
 *
 * Each file gets its own page load, as superdoc-probe does: an import mutates
 * the editor's options as well as its content, and a second import on top of
 * the first would be measuring the leftovers of the first.
 */
import { spawn }   from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs          from 'node:fs';
import path        from 'node:path';
import url         from 'node:url';
import { browser, attach } from '../superdoc-probe/cdp.mjs';

const HERE   = path.dirname( url.fileURLToPath( import.meta.url ) );
const CORPUS = process.env.CORPUS || path.join( process.env.HOME, 'Downloads', 'Telegram Desktop' );
const PORT   = 8098;
const FILTER = process.argv[ 2 ] || '';

// What the .docx itself holds - the truth to compare the editor against.
//
// A part is NOT enough: Word ships empty word/header1.xml parts in almost every
// document, so counting parts calls a header "lost" that was never there. What
// counts is a part with something IN it - text, a field or a picture - and only
// the ones the body's LAST sectPr actually references, because that is the pair
// the importer reads (importDocx.ts line 481).
function partsWithContent( file, kind )
{
    const names = ( execFileSync( 'unzip', [ '-l', file ], { encoding: 'utf8' } )
                    .match( new RegExp( `word/${ kind }\\d+\\.xml`, 'g' ) ) || [] );
    let withText = 0, pageField = false;

    for( const n of new Set( names ) )
    {
        let xml = '';
        try { xml = execFileSync( 'unzip', [ '-p', file, n ], { encoding: 'utf8' } ); } catch { continue; }
        const text = ( xml.match( /<w:t[ >][^<]*/g ) || [] ).join( '' ).replace( /<[^>]*>/g, '' ).trim();
        if( text || /<w:drawing|<w:pict/.test( xml ) ) withText++;
        if( /\bPAGE\b/.test( xml ) ) pageField = true;
    }
    return { withText, pageField };
}

// Párrafos con FONDO (<w:pPr><w:shd w:fill="993366">). El importador lee w:shd
// de un run (línea 231) pero no del párrafo, así que un titular blanco sobre
// vino tinto llega en blanco sobre blanco: invisible. El fondo de celda de tabla
// va por otro camino (línea 1749) y ese sí funciona, por eso se mira sólo pPr.
function shadedParagraphs( file )
{
    let xml = '';
    try { xml = execFileSync( 'unzip', [ '-p', file, 'word/document.xml' ], { encoding: 'utf8' } ); }
    catch { return 0; }

    let n = 0;
    for( const m of xml.matchAll( /<w:pPr>([\s\S]*?)<\/w:pPr>/g ) )
        if( /<w:shd[^>]*w:fill="(?!auto)[0-9A-Fa-f]{6}"/.test( m[ 1 ] ) ) n++;
    return n;
}

function whatIsInTheFile( file )
{
    const h = partsWithContent( file, 'header' );
    const f = partsWithContent( file, 'footer' );
    return { headerParts: h.withText, footerParts: f.withText,
             pageField: h.pageField || f.pageField, shaded: shadedParagraphs( file ) };
}

const files = fs.readdirSync( CORPUS )
                .filter( n => n.toLowerCase().endsWith( '.docx' ) )
                .filter( n => !FILTER || n.toLowerCase().includes( FILTER.toLowerCase() ) )
                .sort();

if( !files.length ) { console.error( `smoke: no .docx in ${ CORPUS }` ); process.exit( 1 ); }
if( !fs.existsSync( path.join( HERE, 'lib', 'canvas-editor_v1.0.3.min.js' ) ) )
{
    console.error( 'smoke: no bundle - run tools/canvas-spike/build.sh first' );
    process.exit( 1 );
}

const server = spawn( process.execPath, [ path.join( HERE, 'serve.mjs' ) ],
                      { env: { ...process.env, PORT: String( PORT ), CORPUS }, stdio: 'ignore' } );
// Wait for the port, or the first tab races the server and lands on an error
// page - which then looks exactly like "the editor failed to boot".
for( let i = 0; i < 100; i++ )
{
    try { await fetch( `http://localhost:${ PORT }/tools/canvas-spike/index.html` ); break; }
    catch { await new Promise( r => setTimeout( r, 50 ) ); }
}

const br = await browser();

const rows = [];
try
{
    for( const name of files )
    {
        const inFile = whatIsInTheFile( path.join( CORPUS, name ) );
        const tab    = await br.newTab( `http://localhost:${ PORT }/tools/canvas-spike/index.html` );
        const page   = await attach( tab.webSocketDebuggerUrl );

        let got, err = null;
        try
        {
            // Poll from HERE, not inside the page. A tab that is still on
            // about:blank when we attach has its JS context replaced the moment
            // the real document commits, and an evaluate caught in that swap
            // comes back empty - which a poll running inside the page reads as
            // success. Asking again, from outside, always asks the live context.
            let up = false;
            for( let i = 0; i < 300 && !up; i++ )
            {
                up = await page.evaluate( '!!window.__spike' ).catch( () => false ) === true;
                if( !up ) await new Promise( r => setTimeout( r, 50 ) );
            }
            if( !up ) throw new Error( 'el editor no arrancó' );

            got = await page.evaluate( `( async () => {
                const buf = await fetch( '/corpus/${ encodeURIComponent( name ) }' ).then( r => r.arrayBuffer() );
                await window.__spike.editor.command.executeImportDocx( { arrayBuffer: buf } );
                await new Promise( r => setTimeout( r, 400 ) );
                const s = window.__spike.state();
                s.text = window.__spike.editor.command.getText().main.slice( 0, 40 );
                return s;
            } )()`, 40000 );
        }
        catch( e )
        {
            err = String( e.message || e ).split( '\n' )[ 0 ].slice( 0, 90 );
            if( process.env.VERBOSE ) console.log( '\n' + name + ':\n  ' + page.logs.join( '\n  ' ) );
        }

        const blew = page.logs.filter( l => l.startsWith( 'EXCEPTION' ) ).length;
        rows.push( { name, inFile, got, err, blew } );
        await fetch( `http://127.0.0.1:${ br.port }/json/close/${ tab.id }`, { method: 'PUT' } ).catch( () => {} );

        process.stdout.write( err ? '!' : '.' );
    }
}
finally { br.kill(); server.kill(); }

console.log( '\n' );
console.log( 'file'.padEnd( 46 ) + 'pág.  encabezado   pie        nº pág.   fondo      texto' );
console.log( '-'.repeat( 122 ) );

let opened = 0, headerLost = 0, footerLost = 0, numbersFrozen = 0, shadingLost = 0;

for( const r of rows )
{
    const n = r.name.length > 44 ? r.name.slice( 0, 43 ) + '…' : r.name;
    if( r.err ) { console.log( n.padEnd( 46 ) + 'FALLÓ  ' + r.err ); continue; }
    opened++;

    const hdr = r.inFile.headerParts === 0 ? '—'
              : r.got.headerCount > 0      ? 'sí'
              : ( headerLost++, 'PERDIDO' );
    const ftr = r.inFile.footerParts === 0 ? '—'
              : r.got.footerCount > 0      ? 'sí'
              : ( footerLost++, 'PERDIDO' );
    const num = !r.inFile.pageField ? '—' : ( numbersFrozen++, 'congelado' );
    const bg  = r.inFile.shaded === 0 ? '—'
              : r.got.highlights > 0  ? 'sí'
              : ( shadingLost++, 'PERDIDO' );

    console.log( n.padEnd( 46 ) +
                 String( r.got.pages ).padStart( 4 ) + '  ' +
                 hdr.padEnd( 13 ) + ftr.padEnd( 11 ) + num.padEnd( 10 ) + bg.padEnd( 11 ) +
                 JSON.stringify( ( r.got.text || '' ).replace( /\s+/g, ' ' ) ).slice( 0, 34 ) +
                 ( r.blew ? '  ⚠ ' + r.blew + ' error(es) en consola' : '' ) );
}

console.log( '-'.repeat( 122 ) );
console.log( `${ opened }/${ rows.length } abiertos · ${ headerLost } encabezado(s) perdido(s) · ` +
             `${ footerLost } pie(s) perdido(s) · ${ numbersFrozen } nº de página congelado(s) · ` +
             `${ shadingLost } fondo(s) de párrafo perdido(s)` );
console.log( '\n"congelado" = el .docx traía un campo PAGE y llega como texto fijo: deja de contar.' );
console.log( '"fondo PERDIDO" = el párrafo tenía color de fondo y no llegó ninguno.' );
