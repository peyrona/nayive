/*
 * codec.js - Calc's file codecs: an .xlsx / .csv file into the workbook
 * model and back, through the vendored xlsx-format. Imported by calc.js.
 *
 * Its top level runs BEFORE calc.js's `await NayiveI18n.ready`: nothing out
 * here may call T() or read another file's names - keep that inside functions.
 */

import
{
    read, write, createWorkbook, appendSheet, decodeRange, encodeRange, encodeCell,
    decodeCell
}
from './lib/xlsx-format_v2.4.1.js';
import
{
    table, newSheet, newDoc, doc, activeSheet
}
from './grid.js';

//------------------------------------------------------------------------//
// FORMAT CODECS (xlsx / csv via xlsx-format)
//
// Unlike the plain-AOA approach, this bridge carries formulas, cell styling
// (bold, colors, alignment) and merged cells both ways — not just raw values.
// Formulas ride through the cell's raw source value as a leading '=' string,
// which Handsontable's Formulas plugin (HyperFormula) auto-detects, and
// getSourceData() hands back the same way on save (getData() would return
// the *computed* value instead).
//
// Known gap: xlsx-format has no "xls"/"ods" support (xlsx/xlsm/csv/tsv/html
// only — dropped ODS import/export when we switched off SheetJS).
// Italic/underline were added to the vendored codec's font read/write path
// (lib/xlsx-format_v2.4.1.js: parseFonts, normalizeFont, writeFont) so they
// round-trip like bold — the library's original xlsx.js/SheetJS lineage only
// ever wrote <b/>, not <i/>/<u/>.

// What a save would destroy. Each entry is an i18n key; the gate
// (lossyBlocked, the saver's `blocked`) turns them into one plain-language
// dialog. Two sources: the parsed workbook, for the things the codec
// does model, and the raw zip parts, for the things it silently drops.
function detectLossy( wb )
{
    const lossy = [];

    const zip = wb._zip;
    if( ! zip || ! zip.files ) return lossy;

    const names = Object.keys( zip.files );
    const has   = function( frag ) { return names.some( function( n ) { return n.indexOf( frag ) !== -1; } ); };

    // Charts, the drawings and pictures they sit on, tables, conditional
    // formatting and data validation are all carried over verbatim now
    // (see captureRawSheet and the codec's preserveSourceParts), so they
    // are deliberately NOT listed here. What is left is what a save still
    // destroys.
    //
    // Pivot tables hang off the workbook, not off a sheet: their caches
    // live in xl/pivotCache/ and are wired up in workbook.xml.rels, which
    // Calc rewrites. Same for links out to another workbook.
    if( has( 'xl/pivotCache' ) || has( 'xl/pivotTables' ) ) lossy.push( 'calc.lossyPivots' );
    if( has( 'xl/externalLinks/' ) )                        lossy.push( 'calc.lossyLinks' );

    const dec = new TextDecoder();
    let sheetXml = '';
    names.forEach( function( n )
    {
        if( n.indexOf( 'xl/worksheets/sheet' ) === 0 ) sheetXml += dec.decode( zip.files[ n ] );
    });

    if( sheetXml.indexOf( '<sheetProtection' ) !== -1 ) lossy.push( 'calc.lossyProtection' );

    return lossy;
}

// Excel and the grid measure the same things in different units, so every
// width and height crosses these four functions and nowhere else.
//   column width : Excel counts '0' characters of the default font (7px each,
//                  plus 5px of cell padding); Handsontable counts pixels.
//   row height   : Excel counts points; Handsontable counts pixels (96/72).
const colCharsToPx = function( ch ) { return Math.round( ch * 7 ) + 5; };
const colPxToChars = function( px ) { return Math.max( 0, ( px - 5 ) / 7 ); };
const rowPtToPx    = function( pt ) { return Math.round( pt / 0.75 ); };
const rowPxToPt    = function( px ) { return px * 0.75; };

const DEFAULT_COL_PX = 100;

// The relationship types of the parts Calc keeps but cannot model.
const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const REL_TABLE   = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table';

// Which file in the archive holds which sheet. The names are in workbook.xml
// and the file paths behind them in workbook.xml.rels — sheet order and file
// numbering do not have to agree, so this reads the mapping rather than
// assuming sheet 2 lives in sheet2.xml.
function sheetPartsByName( zip )
{
    const out = {};
    if( ! zip || ! zip.files ) return out;

    const dec  = new TextDecoder();
    const book = zip.files[ 'xl/workbook.xml' ];
    const rels = zip.files[ 'xl/_rels/workbook.xml.rels' ];
    if( ! book || ! rels ) return out;

    const target = {};
    String( dec.decode( rels ) ).replace( /<Relationship\b[^>]*>/g, function( tag )
    {
        const id = /Id="([^"]+)"/.exec( tag );
        const tg = /Target="([^"]+)"/.exec( tag );
        if( id && tg ) target[ id[ 1 ] ] = tg[ 1 ].replace( /^\//, '' ).replace( /^(?!xl\/)/, 'xl/' );
        return tag;
    } );

    String( dec.decode( book ) ).replace( /<sheet\b[^>]*>/g, function( tag )
    {
        const nm = /name="([^"]*)"/.exec( tag );
        const id = /r:id="([^"]+)"/.exec( tag );
        if( nm && id && target[ id[ 1 ] ] ) out[ decodeXmlText( nm[ 1 ] ) ] = target[ id[ 1 ] ];
        return tag;
    } );

    return out;
}

function decodeXmlText( t )
{
    return String( t ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' )
                      .replace( /&quot;/g, '"' ).replace( /&apos;/g, "'" )
                      .replace( /&amp;/g, '&' );
}

// The bits of a sheet Calc keeps verbatim because it has no model for them:
// the conditional-formatting and data-validation blocks, and the parts the
// sheet points at (the drawing its charts and pictures live on, its tables).
function captureRawSheet( zip, partPath )
{
    if( ! zip || ! zip.files || ! partPath || ! zip.files[ partPath ] ) return null;

    const dec = new TextDecoder();
    const xml = dec.decode( zip.files[ partPath ] );
    const raw = { cf: '', dv: '', refs: [] };

    ( xml.match( /<conditionalFormatting[\s>][\s\S]*?<\/conditionalFormatting>/g ) || []
    ).forEach( function( frag ) { raw.cf += frag; } );

    const dv = /<dataValidations[\s>][\s\S]*?<\/dataValidations>/.exec( xml );
    if( dv ) raw.dv = dv[ 0 ];

    // Sheet-level <extLst> is deliberately NOT carried: it holds x14 blocks
    // whose namespace prefixes are declared on the source's <worksheet> root,
    // and Calc writes its own root. Copying it would make the file invalid.

    const i = partPath.lastIndexOf( '/' );
    const relsPath = partPath.slice( 0, i + 1 ) + '_rels/' + partPath.slice( i + 1 ) + '.rels';
    const relsBuf  = zip.files[ relsPath ];
    if( relsBuf )
    {
        const byId = {};
        String( dec.decode( relsBuf ) ).replace( /<Relationship\b[^>]*>/g, function( tag )
        {
            const id = /Id="([^"]+)"/.exec( tag );
            const tg = /Target="([^"]+)"/.exec( tag );
            const ty = /Type="([^"]+)"/.exec( tag );
            if( id && tg && ty ) byId[ id[ 1 ] ] = { target: tg[ 1 ], type: ty[ 1 ] };
            return tag;
        } );

        // A .rels Target is usually RELATIVE to the part that owns it
        // ("../drawings/drawing1.xml"), and only sometimes absolute. Resolve
        // it to one absolute archive path: it is both the key the part is
        // copied under and a Target the writer can emit as-is.
        const resolvePart = function( target )
        {
            if( target.charAt( 0 ) === '/' ) return target.slice( 1 );

            const base = partPath.slice( 0, partPath.lastIndexOf( '/' ) + 1 ).split( '/' ).filter( Boolean );
            target.split( '/' ).forEach( function( seg )
            {
                if( seg === '.' || seg === '' ) return;
                if( seg === '..' ) base.pop();
                else base.push( seg );
            });
            return base.join( '/' );
        };

        const take = function( re, tag, type )
        {
            let m;
            while( ( m = re.exec( xml ) ) !== null )
            {
                const rel = byId[ m[ 1 ] ];
                if( ! rel || rel.type !== type ) continue;

                const part = resolvePart( rel.target );

                // Never point at something we cannot actually copy: a
                // relationship to a missing part makes the file unreadable.
                if( ! zip.files[ part ] ) continue;

                raw.refs.push( { tag: tag, target: '/' + part, type: type } );
            }
        };

        take( /<drawing[^>]*r:id="([^"]+)"/g,   'drawing',   REL_DRAWING );
        take( /<tablePart[^>]*r:id="([^"]+)"/g, 'tablePart', REL_TABLE );
    }

    return ( raw.cf || raw.dv || raw.refs.length ) ? raw : null;
}

// Turn one parsed worksheet into a sheet entry (see THE OPEN WORKBOOK).
function worksheetToSheet( ws, name )
{
    const sh    = newSheet( name );
    const range = ws[ '!ref' ] ? decodeRange( ws[ '!ref' ] ) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };

    sh.data = [];

    // ALWAYS start at A1, whatever the used range says. A sheet whose content
    // begins at, say, B2 has a !ref of "B2:H12", and reading from there while
    // pushing rows into a plain array put file cell B2 at grid cell A1 — the
    // whole sheet slid one row up and one column left, and everything keyed by
    // address (styles, notes, column widths, merges, hidden columns) then
    // pointed at the wrong cells. Saving wrote the shifted copy back. Most
    // real spreadsheets have a blank first row or column, so this was the
    // common case, not the odd one.
    const endRow = Math.max( 0, range.e.r );
    const endCol = Math.max( 0, range.e.c );

    for( let r = 0; r <= endRow; r++ )
    {
        const row = [];

        for( let c = 0; c <= endCol; c++ )
        {
            const addr = encodeCell( { r: r, c: c } );
            const cell = ws[ addr ];

            row.push( cellToValue( cell ) );

            const style = xlsxStyleToObj( cell && cell.s );
            if( style ) sh.cellStyles[ addr ] = style;

            // A note and a link are cell facts the grid can show, so they
            // belong on the sheet entry like everything else.
            if( cell && cell.c && cell.c.length ) sh.comments[ addr ] = cell.c.map( function( n ) { return n.t || ''; } ).join( '\n' ).trim();
            if( cell && cell.l && cell.l.Target ) sh.links[ addr ] = { target: cell.l.Target, tooltip: cell.l.Tooltip || '' };
        }

        sh.data.push( row );
    }

    sh.merges = ( ws[ '!merges' ] || [] ).map( function( rng )
    {
        return { row: rng.s.r, col: rng.s.c, rowspan: rng.e.r - rng.s.r + 1, colspan: rng.e.c - rng.s.c + 1 };
    });

    // Column widths and hidden columns share one array in the file.
    ( ws[ '!cols' ] || [] ).forEach( function( col, i )
    {
        if( ! col ) return;
        if( col.width  ) { sh.cols[ i ] = colCharsToPx( col.width ); sh.colsSrc[ i ] = col.width; }
        if( col.hidden ) sh.hiddenCols.push( i );
    });

    ( ws[ '!rows' ] || [] ).forEach( function( row, r )
    {
        if( ! row ) return;
        if( row.hpt    ) { sh.rows[ r ] = rowPtToPx( row.hpt ); sh.rowsSrc[ r ] = row.hpt; }
        if( row.hidden ) sh.hiddenRows.push( r );
    });

    // A frozen pane is a split with state 'frozen'; xSplit/ySplit count the
    // columns/rows held still on the left/top.
    const view = ( ws[ '!views' ] || [] ).filter( function( v ) { return v && v.state === 'frozen'; } )[ 0 ];
    if( view ) sh.freeze = { rows: view.ySplit || 0, cols: view.xSplit || 0 };

    // Carried through untouched: the codec models both, and rebuilding the
    // worksheet from scratch would otherwise drop them.
    sh.autofilter = ws[ '!autofilter' ] || null;
    sh.margins    = ws[ '!margins' ]    || null;

    return sh;
}

// Read a file into the workbook model. Still one sheet on the grid — the
// tabs come later — but the doc shape, the source bytes and the loss list
// are all in place from here on.
async function decodeToDoc( buf, ext )
{
    const wb = await read( buf, { type: 'array', cellFormula: true, cellStyles: true, keepZip: true } );

    const d = newDoc();

    d.srcZip = wb._zip || null;
    d.lossy  = detectLossy( wb );

    d.names = ( wb.Workbook && wb.Workbook.Names ) || null;

    const names = ( wb.SheetNames && wb.SheetNames.length ) ? wb.SheetNames : [ 'Hoja1' ];
    const state = ( wb.Workbook && wb.Workbook.Sheets ) || [];

    const parts = sheetPartsByName( d.srcZip );

    d.sheets = names.map( function( name, i )
    {
        const sh = worksheetToSheet( wb.Sheets[ name ] || {}, name );
        sh.hidden = ( state[ i ] && state[ i ].Hidden ) || 0;
        sh.raw    = captureRawSheet( d.srcZip, parts[ name ] );
        return sh;
    });

    // Open on the first sheet the user can actually see.
    d.active = Math.max( 0, d.sheets.findIndex( function( sh ) { return ! sh.hidden; } ) );

    return d;
}

// Copy everything the grid owns back onto the active sheet entry. Called
// before a save and before leaving a sheet — after it, every sheet in the
// document is described the same way and nothing depends on the grid.
function stashActiveSheet()
{
    if( ! table ) return;

    activeSheet.data   = table.getSourceData().map( function( row ) { return row.slice(); } );
    activeSheet.values = table.getData();     // HyperFormula's answers, for the cached <v>

    activeSheet.hiddenCols = ( table.getPlugin( 'hiddenColumns' ).getHiddenColumns() || [] ).slice();
    activeSheet.hiddenRows = ( table.getPlugin( 'hiddenRows'    ).getHiddenRows()    || [] ).slice();

    const set = table.getSettings();
    activeSheet.freeze = { rows: set.fixedRowsTop || 0, cols: set.fixedColumnsStart || 0 };

    activeSheet.comments = {};
    ( table.getCellsMeta() || [] ).forEach( function( meta )
    {
        if( meta && meta.comment && meta.comment.value )
            activeSheet.comments[ encodeCell( { r: meta.row, c: meta.col } ) ] = meta.comment.value;
    });
}

function formulaEngine()
{
    const plugin = table && table.getPlugin( 'formulas' );
    return ( plugin && plugin.engine ) || null;
}

// Handsontable hands HyperFormula only the sheet it is showing. Every OTHER
// sheet has to be put in by hand or a cross-sheet formula — ='Notas'!A1 —
// resolves to #REF, and that is most of the point of holding several sheets.
function registerSheetsInEngine()
{
    const hf = formulaEngine();
    if( ! hf ) return;

    doc.sheets.forEach( function( sh, i )
    {
        if( i === doc.active ) return;   // the grid's own sheet is already in

        try
        {
            if( ! hf.doesSheetExist( sh.name ) ) hf.addSheet( sh.name );
            hf.setSheetContent( hf.getSheetId( sh.name ), sh.data );
        }
        catch( _ ) { /* a name HyperFormula refuses is not worth losing the file over */ }
    });
}

// The computed values of a sheet that is not on screen, for its cached <v>.
function engineValues( sh )
{
    const hf = formulaEngine();
    if( ! hf ) return null;

    try { return hf.getSheetValues( hf.getSheetId( sh.name ) ); }
    catch( _ ) { return null; }
}

// One sheet entry -> one worksheet. Reads nothing but `sh`, so the sheet
// being written does not have to be the one on screen.
function sheetToWorksheet( sh )
{
    const aoa = sh.data || [];
    const out = sh.values || engineValues( sh ) || [];

    const ws = {};

    let maxRow = 0;
    let maxCol = 0;

    aoa.forEach( function( row, r )
    {
        row.forEach( function( raw, c )
        {
            if( raw === '' || raw == null ) return;

            const addr  = encodeCell( { r: r, c: c } );
            const cell  = valueToCell( raw );
            const style = objToXlsxStyle( sh.cellStyles[ addr ] );

            // A formula is written with its last result beside it. Excel
            // recalculates on open and never notices, but anything that
            // trusts the stored value — LibreOffice's converters, a
            // preview pane, a script reading the file — showed 0 for every
            // formula in the sheet without this.
            if( cell.f ) cacheFormulaResult( cell, out[ r ] && out[ r ][ c ] );

            if( style ) cell.s = style;

            ws[ addr ] = cell;

            if( r > maxRow ) maxRow = r;
            if( c > maxCol ) maxCol = c;
        });
    });

    // A cell can hold nothing but a fill, a border or a merge anchor. The loop
    // above skips empty values, so those cells used to reach the file with no
    // style at all — the colours and boxes a user painted simply vanished.
    Object.keys( sh.cellStyles ).forEach( function( addr )
    {
        if( ws[ addr ] ) return;

        const style = objToXlsxStyle( sh.cellStyles[ addr ] );
        if( ! style ) return;

        const rc = decodeCell( addr );
        ws[ addr ] = { t: 's', v: '', s: style };

        if( rc.r > maxRow ) maxRow = rc.r;
        if( rc.c > maxCol ) maxCol = rc.c;
    });

    // Hyperlinks. The codec grew a writer for these (writeWorksheetXml), so
    // the model's links go back onto the cells and out to the file.
    Object.keys( sh.links ).forEach( function( addr )
    {
        const link = sh.links[ addr ];
        if( ! link || ! link.target ) return;

        // A link can sit on a cell with no value of its own.
        if( ! ws[ addr ] ) ws[ addr ] = { t: 's', v: '' };

        ws[ addr ].l = link.tooltip ? { Target: link.target, Tooltip: link.tooltip }
                                    : { Target: link.target };
    });

    // The file keeps notes as a list of [address, [note, …]] pairs, and the
    // '!legacy' flag is what makes the VML part Excel needs get written.
    const notes = Object.keys( sh.comments ).map( function( addr )
    {
        return [ addr, [ { t: sh.comments[ addr ], a: 'Calc' } ] ];
    });

    if( notes.length )
    {
        ws[ '!comments' ] = notes;
        ws[ '!legacy' ]   = true;
    }

    ws[ '!ref' ] = encodeRange( { s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } } );

    if( sh.merges.length )
    {
        ws[ '!merges' ] = sh.merges.map( function( m )
        {
            return { s: { r: m.row, c: m.col }, e: { r: m.row + m.rowspan - 1, c: m.col + m.colspan - 1 } };
        });
    }

    // Column widths / row heights / hidden flags, back into the two arrays
    // the file format keeps them in. Read the hidden lists off the plugins,
    // not off the sheet entry, so a hide/show made during this session counts.
    const hiddenCols = sh.hiddenCols;
    const hiddenRows = sh.hiddenRows;
    const cols = [];
    const rows = [];

    for( let c = 0; c <= Math.max( maxCol, sh.cols.length - 1 ); c++ )
    {
        const px     = sh.cols[ c ];
        const hidden = hiddenCols.indexOf( c ) !== -1;
        if( ! px && ! hidden ) continue;

        // An untouched column goes back with the exact figure it came in
        // with; only a column the user actually dragged is recomputed.
        const chars = ( sh.colsSrc[ c ] != null ) ? sh.colsSrc[ c ]
                                                           : colPxToChars( px || DEFAULT_COL_PX );
        cols[ c ] = hidden ? { width: chars, hidden: true } : { width: chars };
    }
    for( let r = 0; r <= Math.max( maxRow, sh.rows.length - 1 ); r++ )
    {
        const px     = sh.rows[ r ];
        const hidden = hiddenRows.indexOf( r ) !== -1;
        if( ! px && ! hidden ) continue;

        const hpt = ( sh.rowsSrc[ r ] != null ) ? sh.rowsSrc[ r ]
                                                         : rowPxToPt( px || 20 );
        rows[ r ] = hidden ? { hpt: hpt, hidden: true } : { hpt: hpt };
    }

    if( cols.length ) ws[ '!cols' ] = cols;
    if( rows.length ) ws[ '!rows' ] = rows;

    const fr = sh.freeze.rows;
    const fc = sh.freeze.cols;
    if( fr || fc ) ws[ '!views' ] = [ { state: 'frozen', xSplit: fc, ySplit: fr } ];

    if( sh.autofilter ) ws[ '!autofilter' ] = sh.autofilter;
    if( sh.margins )    ws[ '!margins' ]    = sh.margins;
    if( sh.raw )        ws[ '!raw' ]        = sh.raw;

    // The sheet keeps the name it was opened with. createWorkbook used to be
    // handed a hard-coded 'Sheet1', so every file came back renamed.
    return ws;
}

async function encodeFromGrid( ext )
{
    stashActiveSheet();

    // Every sheet the file arrived with goes back into it, in order and
    // under its own name. Only the active one has a grid behind it; the
    // rest are written straight out of the model.
    const wb = createWorkbook( null );

    doc.sheets.forEach( function( sh )
    {
        appendSheet( wb, sheetToWorksheet( sh ), sh.name || 'Hoja1' );
    });

    // A sheet hidden in the original stays hidden.
    const sheetState = doc.sheets.map( function( sh ) { return { Hidden: sh.hidden || 0 }; } );

    const bookType = ( ext === 'csv' ) ? 'csv' : 'xlsx';

    // Named ranges are workbook-level, so they hang off the workbook, not
    // the sheet. A formula like =SUMA(Ventas) breaks without them.
    //
    // Only the ones that still point at a sheet we are writing, though: a
    // name reading 'Notas'!$A$1 in a file we are saving without the Notas
    // sheet is a dangling reference, and Excel offers to repair the file
    // over it. Names with no sheet qualifier always travel.
    const names = ( doc.names || [] ).filter( function( n )
    {
        if( ! n || ! n.Ref ) return false;

        const m = /^'?([^'!]+)'?!/.exec( n.Ref );
        if( ! m ) return true;

        return doc.sheets.some( function( sh ) { return sh.name === m[ 1 ]; } );
    });

    wb.Workbook = { Sheets: sheetState };
    if( names.length ) wb.Workbook.Names = names;

    return await write( wb, { type: 'array', bookType: bookType, cellStyles: true,
                              preserve: doc.srcZip } );
}

function cellToValue( cell )
{
    if( ! cell ) return '';
    if( cell.f ) return '=' + cell.f;
    if( cell.t === 'd' && cell.w ) return cell.w;
    return cell.v === undefined ? '' : cell.v;
}

// Put HyperFormula's answer into the cell as the cached <v>. Errors are left
// out on purpose: a stale "#DIV/0!" written as a value would outlive the
// condition that caused it.
function cacheFormulaResult( cell, value )
{
    if( value === null || value === undefined || value === '' ) return;

    if( typeof value === 'number'  && isFinite( value ) ) { cell.t = 'n'; cell.v = value; return; }
    if( typeof value === 'boolean' )                      { cell.t = 'b'; cell.v = value; return; }

    const text = String( value );
    if( text.charAt( 0 ) === '#' ) return;      // an error result, not a value

    cell.t = 's';
    cell.v = text;
}

function valueToCell( raw )
{
    if( typeof raw === 'string' && raw.startsWith( '=' ) && raw.length > 1 )
        return { t: 'n', f: raw.slice( 1 ) };

    if( typeof raw === 'number'  ) return { t: 'n', v: raw };
    if( typeof raw === 'boolean' ) return { t: 'b', v: raw };

    return { t: 's', v: String( raw ) };
}

function xlsxStyleToObj( s )
{
    if( ! s ) return null;

    const o = {};

    if( s.font )
    {
        if( s.font.bold )                      o.bold       = true;
        if( s.font.italic )                     o.italic     = true;
        if( s.font.underline )                  o.underline  = true;
        if( s.font.name )                       o.fontFamily = s.font.name;
        if( s.font.size )                       o.size       = s.font.size;
        if( s.font.color && s.font.color.rgb )  o.color      = s.font.color.rgb.slice( -6 ).toUpperCase();
    }

    if( s.fill && s.fill.fgColor && s.fill.fgColor.rgb )
        o.bg = s.fill.fgColor.rgb.slice( -6 ).toUpperCase();

    if( s.alignment && s.alignment.horizontal ) o.align  = s.alignment.horizontal;
    if( s.alignment && s.alignment.vertical )   o.valign = s.alignment.vertical;
    if( s.alignment && s.alignment.wrapText )   o.wrap   = true;

    if( s.numFmt ) o.numFmt = s.numFmt;

    // Border round-trips per side, with a thin/medium weight and an optional colour —
    // matching what the toolbar's border dialog can set. The vendored codec only
    // handles 'thin'/'medium', so a heavier weight a source file carries is coerced.
    if( s.border )
    {
        const b = {};

        [ 'top', 'right', 'bottom', 'left' ].forEach( function( side )
        {
            const bs = s.border[ side ];
            if( ! bs || ! bs.style ) return;

            b[ side ] = true;
            b.style   = ( bs.style === 'medium' ) ? 'medium' : 'thin';
            if( bs.color && bs.color.rgb ) b.color = bs.color.rgb.slice( -6 ).toUpperCase();
        });

        if( Object.keys( b ).length ) o.border = b;
    }

    return Object.keys( o ).length ? o : null;
}

function objToXlsxStyle( o )
{
    if( ! o ) return null;

    const style = {};

    if( o.bold || o.italic || o.underline || o.size || o.color || o.fontFamily )
    {
        style.font = {};
        if( o.bold )       style.font.bold      = true;
        if( o.italic )     style.font.italic    = true;
        if( o.underline )  style.font.underline = true;
        if( o.fontFamily ) style.font.name       = o.fontFamily;
        if( o.size )        style.font.size       = o.size;
        if( o.color )       style.font.color      = { rgb: o.color };
    }

    if( o.bg ) style.fill = { patternType: 'solid', fgColor: { rgb: o.bg } };

    if( o.align || o.valign || o.wrap )
    {
        style.alignment = {};
        if( o.align )  style.alignment.horizontal = o.align;
        if( o.valign ) style.alignment.vertical   = o.valign;
        if( o.wrap )   style.alignment.wrapText   = true;
    }

    if( o.numFmt ) style.numFmt = o.numFmt;

    if( o.border && typeof o.border === 'object' )
    {
        const side = { style: o.border.style || 'thin' };
        if( o.border.color ) side.color = { rgb: o.border.color };

        style.border = {};
        if( o.border.top )    style.border.top    = side;
        if( o.border.right )  style.border.right  = side;
        if( o.border.bottom ) style.border.bottom = side;
        if( o.border.left )   style.border.left   = side;
    }
    else if( o.border )   // legacy boolean from an older save
    {
        const side = { style: 'thin' };
        style.border = { top: side, right: side, bottom: side, left: side };
    }

    return Object.keys( style ).length ? style : null;
}

export
{
    DEFAULT_COL_PX, decodeToDoc, stashActiveSheet, formulaEngine, registerSheetsInEngine,
    encodeFromGrid
};
