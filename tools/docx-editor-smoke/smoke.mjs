/*
 * smoke.mjs - run a folder of .docx files through the vendored docx-editor.dev
 * engine, headless. The upgrade gate: after tools/build-docx-editor.sh <new>,
 * the numbers must be the same as before, or better.
 *
 *     CORPUS=<folder> node tools/docx-editor-smoke/smoke.mjs            every .docx in it
 *     CORPUS=<folder> node tools/docx-editor-smoke/smoke.mjs Report     only names containing this
 *
 * KEEP=1 keeps the saved .docx and the PDFs in a temp folder; JSON=<file>
 * dumps every row. Needs Chromium, python3, pandoc and poppler-utils (pdfinfo,
 * pdftotext). Nothing is written outside a temp folder removed at the end; the
 * files in CORPUS are only read.
 *
 * The question is not "does it work" but "what is lost". For every file:
 *
 *   1. open it, and compare what the .docx HOLDS (read here, straight from the
 *      zip) with what the editor PAINTED: header, footer, a live page number,
 *      a coloured paragraph, a watermark - and whether the layout used the
 *      real fonts (the packaged fonts and HarfBuzz wasm were found);
 *   2. save it untouched, and diff the two zips part by part - the engine says
 *      "untouched content survives", this checks it;
 *   3. type Spanish at the very start with real key events, save again, and ask
 *      an INDEPENDENT reader (pandoc) whether the text is the old text plus
 *      exactly what was typed;
 *   4. print it to PDF and count sheets and real text;
 *   5. check what Write's spell check will rely on: a painted span's
 *      data-paragraph-id / data-start agree with findMatches() (page.js idProbe).
 *
 * The yardstick is always the file itself (or pandoc), never another editor.
 * In particular NEVER SuperDoc: its engine licence (§1.6) forbids using its
 * behaviour or output to build a replacement.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import url  from 'node:url';
import zlib from 'node:zlib';
import { browser, attach } from '../cdp.mjs';

const HERE   = path.dirname( url.fileURLToPath( import.meta.url ) );
const CORPUS = process.env.CORPUS;
const FILTER = process.argv[ 2 ] || '';

if( ! CORPUS || ! fs.existsSync( CORPUS ) )
{
    console.error( 'smoke: set CORPUS=<a folder of .docx files>' );
    process.exit( 1 );
}

// What gets typed at the start of every document: every character a Spanish
// keyboard could get wrong, and a tail that is easy to find again.
const TYPED = '¿Qué tal? «Ñandú» — áéíóú ü ñ ¡Sí! ';

//----------------------------------------------------------------------------//
// A .docx, read without the engine

// A zip is its central directory: name, method, sizes, where the data is. That
// is thirty lines, and it spares unzip's wildcards ("[Content_Types].xml") and
// its trouble with names that came from a Mac (NFD).
function readZip( buf )
{
    let eocd = buf.length - 22;
    while( eocd >= 0 && buf.readUInt32LE( eocd ) !== 0x06054b50 ) eocd--;
    if( eocd < 0 ) throw new Error( 'not a zip' );

    const parts = new Map();
    let p = buf.readUInt32LE( eocd + 16 );
    for( let i = buf.readUInt16LE( eocd + 10 ); i > 0; i-- )
    {
        const method = buf.readUInt16LE( p + 10 ), csize = buf.readUInt32LE( p + 20 );
        const nlen   = buf.readUInt16LE( p + 28 ), xlen  = buf.readUInt16LE( p + 30 ), clen = buf.readUInt16LE( p + 32 );
        const local  = buf.readUInt32LE( p + 42 );
        const name   = buf.toString( 'utf8', p + 46, p + 46 + nlen );
        const start  = local + 30 + buf.readUInt16LE( local + 26 ) + buf.readUInt16LE( local + 28 );
        const raw    = buf.subarray( start, start + csize );
        parts.set( name, method === 0 ? raw : zlib.inflateRawSync( raw ) );
        p += 46 + nlen + xlen + clen;
    }
    return parts;
}

// A watermark is a header shape: Word's own is VML with a <v:textpath>, a
// text-box one is DrawingML with <a:prstTxWarp>. They get their own column, so
// a header that holds ONLY a watermark does not count as a header here.
const WATERMARK = /v:textpath|prstTxWarp|PowerPlusWaterMark/;

function withoutWatermarks( xml )
{
    const drop = m => WATERMARK.test( m ) ? '' : m;
    return xml.replace( /<mc:AlternateContent>[\s\S]*?<\/mc:AlternateContent>/g, drop )
              .replace( /<w:pict>[\s\S]*?<\/w:pict>/g, drop )
              .replace( /<w:drawing>[\s\S]*?<\/w:drawing>/g, drop );
}

const textOf = xml => ( xml.match( /<w:t[ >][^<]*/g ) || [] ).join( '' ).replace( /<[^>]*>/g, '' ).trim();

// What the .docx itself holds - the truth to compare the editor against.
function truth( zip )
{
    const xml   = n => zip.get( n )?.toString( 'utf8' ) ?? '';
    const names = [ ...zip.keys() ];
    const zone  = kind => names.filter( n => new RegExp( `^word/${ kind }\\d*\\.xml$` ).test( n ) ).map( xml );

    const filled = x => { const s = withoutWatermarks( x ); return !! textOf( s ) || /<w:drawing|<w:pict/.test( s ); };
    const headers = zone( 'header' ), footers = zone( 'footer' );

    const marks = headers.filter( x => WATERMARK.test( x ) ).map( x =>
        ( /v:textpath[^>]*string="([^"]*)"/.exec( x ) || [] )[ 1 ] ||
        textOf( ( /<wps:txbx>[\s\S]*?<\/wps:txbx>/.exec( x ) || [ '' ] )[ 0 ] ) || '?' );

    const doc   = xml( 'word/document.xml' );
    const fills = new Set();
    for( const m of doc.matchAll( /<w:pPr>([\s\S]*?)<\/w:pPr>/g ) )
    {
        const f = /<w:shd[^>]*w:fill="([0-9A-Fa-f]{6})"/.exec( m[ 1 ] );
        if( f ) fills.add( f[ 1 ].toUpperCase() );
    }

    return {
        headers   : headers.filter( filled ).length,
        footers   : footers.filter( filled ).length,
        pageField : [ ...headers, ...footers ].some( x => /\bPAGE\b/.test( x ) ),
        watermark : [ ...new Set( marks ) ].join( ', ' ),
        fills     : [ ...fills ].sort(),
        comments  : ( xml( 'word/comments.xml' ).match( /<w:comment /g ) || [] ).length,
        revisions : ( doc.match( /<w:(ins|del) /g ) || [] ).length,
        wordPages : Number( ( /<Pages>(\d+)</.exec( xml( 'docProps/app.xml' ) ) || [] )[ 1 ] ) || null
    };
}

// Two zips, part by part, by MEANING (zipdiff.py says why not by bytes), plus
// an integrity check of the saved one.
const zipdiff = ( a, b ) => JSON.parse( execFileSync( 'python3', [ path.join( HERE, 'zipdiff.py' ), a, b ],
                                                      { encoding: 'utf8' } ) );

// pandoc is the independent reader: if IT sees the same text, the save kept it.
function plain( file )
{
    try { return execFileSync( 'pandoc', [ '-f', 'docx', '-t', 'plain', '--wrap=none', file ],
                               { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } ); }
    catch { return null; }
}

//----------------------------------------------------------------------------//
// The run

const files = fs.readdirSync( CORPUS )
                .filter( n => n.toLowerCase().endsWith( '.docx' ) )
                .filter( n => ! FILTER || n.toLowerCase().includes( FILTER.toLowerCase() ) )
                .sort();

if( ! files.length ) { console.error( `smoke: no .docx in ${ CORPUS }` ); process.exit( 1 ); }

// The page server runs as its own process: pandoc and python run synchronously
// here and would otherwise stall every request the page makes meanwhile.
const server = spawn( process.execPath, [ path.join( HERE, 'serve.mjs' ) ],
                      { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', CORPUS }, stdio: [ 'ignore', 'pipe', 'inherit' ] } );
const PORT = await new Promise( ( resolve, reject ) =>
{
    let buf = '';
    const t = setTimeout( () => reject( new Error( 'serve.mjs did not start' ) ), 10000 );
    server.stdout.on( 'data', d =>
    {
        buf += d;
        const m = /localhost:(\d+)\//.exec( buf );
        if( m ) { clearTimeout( t ); resolve( +m[ 1 ] ); }
    } );
} );
const PAGE = `http://localhost:${ PORT }/tools/docx-editor-smoke/index.html`;

const lock = await fetch( `http://localhost:${ PORT }/engine/docx-editor.lock.json` ).then( r => r.ok ? r.json() : null );
if( ! lock ) { server.kill(); console.error( 'smoke: no engine build - run tools/build-docx-editor.sh first' ); process.exit( 1 ); }

const TMP  = fs.mkdtempSync( path.join( os.tmpdir(), 'docx-editor-smoke-' ) );
const tmpFile = ( bytes, n ) => { const f = path.join( TMP, n ); fs.writeFileSync( f, bytes ); return f; };

const br   = await browser();
const rows = [];
const b64  = `( async bytes => { let s = ''; for( let i = 0; i < bytes.length; i += 0x8000 )
                 s += String.fromCharCode.apply( null, bytes.subarray( i, i + 0x8000 ) ); return btoa( s ); } )`;

console.log( `docx-editor.dev ${ lock.core } - ${ files.length } file(s)` );

try
{
    for( const [ idx, name ] of files.entries() )
    {
        const origPath = path.join( CORPUS, name );
        const origZip  = readZip( fs.readFileSync( origPath ) );
        const inFile   = truth( origZip );
        const row      = { name, inFile };
        rows.push( row );

        const t0   = Date.now();
        const tab  = await br.newTab( PAGE + '?f=' + encodeURIComponent( name ) );
        const page = await attach( tab.webSocketDebuggerUrl );

        try
        {
            // Poll from HERE, not inside the page: an evaluate caught in the
            // about:blank -> page swap comes back empty.
            let up = false;
            for( let i = 0; i < 300 && ! up; i++ )
            {
                up = await page.evaluate( '!!window.__smoke' ).catch( () => false ) === true;
                if( ! up ) await new Promise( r => setTimeout( r, 50 ) );
            }
            if( ! up ) throw new Error( 'the editor did not start' );

            await page.evaluate( 'window.__smoke.ready( 60000 )', 70000 );
            row.openMs = Date.now() - t0;
            await new Promise( r => setTimeout( r, 300 ) );          // images decode after layout

            // 1. WHAT WAS PAINTED
            row.got = await page.evaluate( `( () => {
                const e = window.__smoke.editor, s = e.snapshot();
                const pages = [ ...document.querySelectorAll( '.docx-page' ) ];
                const painted = h => h.textContent.trim() !== '' || !! h.querySelector( 'img, svg, canvas' );
                const zone = k => [ ...document.querySelectorAll( '.docx-hf[data-docx-hf="' + k + '"]' ) ];
                const hfText = p => [ ...p.querySelectorAll( '.docx-hf' ) ].map( h => h.textContent.trim() ).join( '|' );
                const hex = c => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec( c ); return m ?
                    m.slice( 1, 4 ).map( n => ( +n ).toString( 16 ).padStart( 2, '0' ) ).join( '' ).toUpperCase() : c; };
                return {
                    pages    : s.page.total,
                    measurer : e.fontMeasurement().measurer,
                    subs     : s.fontSubstitutions || [],
                    headers  : zone( 'header' ).filter( painted ).length,
                    footers  : zone( 'footer' ).filter( painted ).length,
                    hfTexts  : pages.slice( 0, 3 ).map( hfText ),
                    fills    : [ ...new Set( [ ...document.querySelectorAll( '.docx-paragraph-shading' ) ]
                                   .map( el => hex( getComputedStyle( el ).backgroundColor ) ) ) ],
                    // Everything painted on a page OUTSIDE its body: headers, footers,
                    // drawing layers - where a watermark would have to be.
                    around   : pages.slice( 0, 2 ).map( p => [ ...p.children ]
                                   .filter( c => ! c.classList.contains( 'docx-page-content' ) )
                                   .map( c => c.textContent ).join( ' ' ) ).join( ' ' ),
                    watermark: e.getWatermark(),
                    comments : e.getComments().length,
                    revisions: e.getTrackedChanges().length,
                    ids      : window.__smoke.idProbe()
                };
            } )()` );

            // 2. SAVE UNTOUCHED
            const saved0 = Buffer.from( await page.evaluate(
                `window.__smoke.saveBytes().then( ${ b64 } )`, 60000 ), 'base64' );
            const file0 = tmpFile( saved0, `s0-${ idx }.docx` );
            row.save0   = { diff: zipdiff( origPath, file0 ), truth: truth( readZip( saved0 ) ) };
            const origText = plain( origPath );
            row.save0.textSame = origText !== null && plain( file0 ) === origText;

            // 3. TYPE, THEN SAVE. Real key events, the way a person types:
            //    click on the first line, Ctrl+Home, then the text.
            await page.send( 'Page.bringToFront' );
            const at = await page.evaluate( `( () => {
                const l = document.querySelector( '.docx-page[data-page-index="0"] .docx-page-content .docx-line' );
                const r = ( l || document.querySelector( '.docx-page-content' ) ).getBoundingClientRect();
                return { x: r.left + 4, y: r.top + r.height / 2 };
            } )()` );
            for( const type of [ 'mouseMoved', 'mousePressed', 'mouseReleased' ] )
                await page.send( 'Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 } );
            for( const type of [ 'rawKeyDown', 'keyUp' ] )
                await page.send( 'Input.dispatchKeyEvent', { type, modifiers: 2, key: 'Home', code: 'Home',
                                                             windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 } );
            await page.send( 'Input.insertText', { text: TYPED } );
            await new Promise( r => setTimeout( r, 400 ) );

            row.typedShows = await page.evaluate(
                `document.querySelector( '.docx-page' )?.textContent.includes( ${ JSON.stringify( TYPED.trim() ) } )` );

            const saved1 = Buffer.from( await page.evaluate(
                `window.__smoke.saveBytes().then( ${ b64 } )`, 60000 ), 'base64' );
            const file1  = tmpFile( saved1, `s1-${ idx }.docx` );
            const text1  = plain( file1 );
            // The old text plus exactly what was typed, once, and nothing else.
            // Lower-cased and with spaces collapsed, because pandoc's plain
            // writer capitalises a title - and the typing lands in the title.
            const norm = s => s.toLowerCase().replace( /\s+/g, ' ' ).trim();
            const typed = norm( TYPED );
            row.save1 = {
                diff : zipdiff( origPath, file1 ),
                truth: truth( readZip( saved1 ) ),
                textOk: origText !== null && text1 !== null && norm( text1 ).includes( typed ) &&
                        norm( norm( text1 ).replace( typed, '' ) ) === norm( origText )
            };

            // 4. PRINT
            await page.evaluate( 'window.__smoke.preparePrint()' );
            const pdf = await page.send( 'Page.printToPDF', { preferCSSPageSize: true, printBackground: true } );
            if( pdf.result?.data )
            {
                const f = tmpFile( Buffer.from( pdf.result.data, 'base64' ), `p-${ idx }.pdf` );
                row.pdfPages = Number( ( /Pages:\s+(\d+)/.exec( execFileSync( 'pdfinfo', [ f ], { encoding: 'utf8' } ) ) || [] )[ 1 ] );
                const words  = execFileSync( 'pdftotext', [ f, '-' ], { encoding: 'utf8' } ).replace( /\s+/g, ' ' );
                row.pdfText  = words.includes( TYPED.trim().slice( 0, 9 ) );
            }

            // Can the free tier ADD a comment? (Comments are the paid part; a
            // release that changes this answer is worth knowing about.)
            const c = await page.evaluate( `JSON.stringify( window.__smoke.editor.addComment( 'x' ) )` );
            row.addComment = JSON.parse( c );
        }
        catch( e )
        {
            row.err = String( e.message || e ).split( '\n' )[ 0 ].slice( 0, 90 );
            const pe = await page.evaluate( 'window.__smoke?.editor?.snapshot().parseError' ).catch( () => null );
            if( pe ) row.err = 'DOES NOT OPEN: ' + pe;
        }

        row.exceptions = page.logs.filter( l => l.startsWith( 'EXCEPTION' ) );
        if( process.env.VERBOSE && page.logs.length ) console.log( '\n' + name + ':\n  ' + page.logs.join( '\n  ' ) );
        await fetch( `http://127.0.0.1:${ br.port }/json/close/${ tab.id }`, { method: 'PUT' } ).catch( () => {} );
        process.stdout.write( row.err ? '!' : '.' );
    }
}
finally
{
    br.kill(); server.kill();
    if( process.env.KEEP ) console.log( '\nkept: ' + TMP );
    else fs.rmSync( TMP, { recursive: true, force: true } );
}

//----------------------------------------------------------------------------//
// The table

const yesNo = ( has, ok ) => ! has ? '—' : ok ? 'yes' : 'LOST';
const count = { opened: 0, shaped: 0, hdr: 0, ftr: 0, num: 0, bg: 0, wm: 0, save0: 0, textSame: 0, save1: 0, typed: 0, pdf: 0,
                idTried: 0, idSame: 0 };
const has   = { hdr: 0, ftr: 0, num: 0, bg: 0, wm: 0 };

console.log( '\n' );
console.log( 'file'.padEnd( 40 ) + 'open   pages(Word) header   footer   page no.   fill     watermark ' +
             'save untouched             type+save          pdf' );
console.log( '-'.repeat( 150 ) );

for( const r of rows )
{
    const n = r.name.length > 38 ? r.name.slice( 0, 37 ) + '…' : r.name;
    if( r.err ) { console.log( n.padEnd( 40 ) + 'FAILED ' + r.err ); continue; }
    count.opened++;
    const f = r.inFile, g = r.got;
    if( g.measurer === 'shaped' ) count.shaped++;
    count.idTried += g.ids.tried;
    count.idSame  += g.ids.same;

    const hdr = yesNo( f.headers, g.headers > 0 );
    const ftr = yesNo( f.footers, g.footers > 0 );

    // A live number differs from page to page; one frozen at Word's cached
    // text is the same on every page.
    let num = '—';
    if( f.pageField )
        num = g.pages < 2 ? ( /\d/.test( g.hfTexts[ 0 ] ) ? 'yes (1 p.)' : 'LOST' )
            : ( g.hfTexts[ 0 ] !== g.hfTexts[ 1 ] && /\d/.test( g.hfTexts[ 1 ] ) ? 'live' : 'FROZEN' );

    const bg = yesNo( f.fills.length, f.fills.every( c => g.fills.includes( c ) ) );
    const wm = yesNo( f.watermark, !! g.watermark ||
                      f.watermark.split( ', ' ).every( t => g.around.includes( t ) ) );

    const d0 = r.save0.diff, d1 = r.save1.diff;
    const kept = ( a, b ) => a.headers === b.headers && a.footers === b.footers && a.pageField === b.pageField &&
                             a.watermark === b.watermark && a.fills.join() === b.fills.join() &&
                             a.comments === b.comments && a.revisions === b.revisions;
    const s0 = `${ d0.same }/${ d0.total } same` + ( d0.lost.length ? `, ${ d0.lost.length } LOST` : '' ) +
               ( kept( f, r.save0.truth ) ? '' : ', CHANGED' ) + ( r.save0.textSame ? '' : ', text≠' ) +
               ( d0.problems.length ? `, ${ d0.problems.length } DEFECTS` : '' );
    // Typing into the first paragraph should touch document.xml and, in it,
    // one block. More is collateral damage.
    const s1 = ( r.typedShows ? '' : 'NOT SHOWN, ' ) + ( r.save1.textOk ? 'text ok' : 'TEXT WRONG' ) +
               ( d1.changed.length > 1 || d1.lost.length ? ` +${ d1.changed.length - 1 + d1.lost.length } parts` : '' ) +
               ( d1.blocks > 1 ? ` ${ d1.blocks } blocks` : '' ) +
               ( kept( f, r.save1.truth ) ? '' : ', CHANGED' ) + ( d1.problems.length ? ', DEFECTS' : '' );
    const pdf = r.pdfPages ? `${ r.pdfPages }${ r.pdfPages === g.pages ? '' : '≠' + g.pages }${ r.pdfText ? '' : ' NO TEXT' }` : '—';

    for( const [ k, v ] of Object.entries( { hdr, ftr, num, bg, wm } ) )
    {
        if( v !== '—' ) has[ k ]++;
        if( v === 'yes' || v === 'live' || v === 'yes (1 p.)' ) count[ k ]++;
    }
    if( d0.same === d0.total && ! d0.lost.length && ! d0.problems.length && kept( f, r.save0.truth ) ) count.save0++;
    if( r.save0.textSame ) count.textSame++;
    if( r.save1.textOk && kept( f, r.save1.truth ) && d1.changed.length <= 1 && d1.blocks <= 1 &&
        ! d1.lost.length && ! d1.problems.length ) count.save1++;
    if( r.typedShows ) count.typed++;
    if( r.pdfPages === g.pages && r.pdfText ) count.pdf++;

    const pages = String( g.pages ) + ( f.wordPages ? ` (${ f.wordPages })` : '' ) + ( g.measurer === 'shaped' ? '' : '~' );
    console.log( n.padEnd( 40 ) +
                 ( ( r.openMs / 1000 ).toFixed( 1 ) + 's' ).padEnd( 7 ) + pages.padEnd( 12 ) +
                 hdr.padEnd( 9 ) + ftr.padEnd( 9 ) + num.padEnd( 11 ) + bg.padEnd( 9 ) + wm.padEnd( 10 ) +
                 s0.padEnd( 27 ) + s1.padEnd( 19 ) + pdf +
                 ( r.exceptions.length ? `  ⚠ ${ r.exceptions.length } console error(s)` : '' ) );
}

console.log( '-'.repeat( 150 ) );
const of = k => `${ count[ k ] }/${ has[ k ] }`;
console.log( `${ count.opened }/${ rows.length } open · real font metrics ${ count.shaped }/${ count.opened } · ` +
             `headers ${ of( 'hdr' ) } · footers ${ of( 'ftr' ) } · live page number ${ of( 'num' ) } · ` +
             `fills ${ of( 'bg' ) } · watermarks ${ of( 'wm' ) }` );
console.log( `save untouched: ${ count.save0 }/${ count.opened } same part by part (by meaning), ` +
             `${ count.textSame }/${ count.opened } same text per pandoc` );
console.log( `type+save: ${ count.save1 }/${ count.opened } with the right text and only that paragraph changed · ` +
             `${ count.typed }/${ count.opened } shown while typing · pdf: ${ count.pdf }/${ count.opened } with its pages and real text` );
console.log( `spell-check ids: ${ count.idSame }/${ count.idTried } painted words found by findMatches() ` +
             `at their span's data-paragraph-id + data-start` );

const idMiss = rows.find( r => r.got?.ids.misses.length );
if( idMiss ) console.log( `  first miss: ${ JSON.stringify( idMiss.got.ids.misses[ 0 ] ) }` );
const subs = new Set( rows.flatMap( r => r.got?.subs || [] ) );
if( subs.size ) console.log( `fonts with no metric twin (drawn with another): ${ [ ...subs ].sort().join( ', ' ) }` );
const cm = rows.find( r => r.addComment );
if( cm ) console.log( `add a comment without the paid package: ${ JSON.stringify( cm.addComment ) }` );
const withComments = rows.filter( r => r.inFile.comments > 0 );
if( withComments.length )
    console.log( `comments: ${ withComments.length } file(s) carry some; shown in ${ withComments.filter( r => r.got?.comments ).length }, ` +
                 `kept on save in ${ withComments.filter( r => r.save1 && r.save1.truth.comments === r.inFile.comments ).length }` );

console.log( '\npages(Word) = the count Word stored in the file, when it did. "~" = estimated metrics, no fonts.' );
console.log( '"save untouched" compares each zip part by meaning (zipdiff.py); "text≠" = pandoc reads other text;' );
console.log( '"DEFECTS" = something Word would refuse: an undeclared mc:Ignorable prefix, a broken relationship.' );
console.log( '"type+save" types ' + JSON.stringify( TYPED ) + ' at the start and asks pandoc for the old text + that.' );

if( process.env.JSON ) fs.writeFileSync( process.env.JSON, JSON.stringify( rows, null, 1 ) );
