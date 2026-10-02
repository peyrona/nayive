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
    decodeCell, decodeCol, encodeCol, arrayToSheet
}
from './lib/xlsx-format_v2.4.1.js';
import
{
    table, newSheet, newDoc, doc, activeSheet, defaultSheetName, lineStyle
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

    // The next four the library can neither read nor write (theme-coloured
    // fills, the sheet's default column width, the height of an empty row
    // and a note's author ARE carried, see readStyleParts and friends).
    // Each counts only when it would change what the user sees or prints:
    // LibreOffice writes a default page set-up, <strike val="0"/> and
    // one-colour "rich" text into ordinary files, and a warning for those
    // would train him to click through the dialog.
    const styles = zip.files[ 'xl/styles.xml' ] ? dec.decode( zip.files[ 'xl/styles.xml' ] ) : '';
    const sst    = zip.files[ 'xl/sharedStrings.xml' ] ? dec.decode( zip.files[ 'xl/sharedStrings.xml' ] ) : '';

    if( hasRichText( sst ) ) lossy.push( 'calc.lossyRich' );

    const fonts = /<(?:\w+:)?fonts\b[^>]*>([\s\S]*?)<\/(?:\w+:)?fonts>/.exec( styles );
    if( fonts && isOn( fonts[ 1 ], 'strike' ) ) lossy.push( 'calc.lossyStrike' );

    // Only thin and medium lines are written; the rest become the nearest.
    const borders = /<(?:\w+:)?borders\b[^>]*>([\s\S]*?)<\/(?:\w+:)?borders>/.exec( styles );
    if( borders && /\bstyle="(?!thin"|medium"|none")\w+"/.test( borders[ 1 ] ) ) lossy.push( 'calc.lossyBorders' );

    if( /<(?:\w+:)?pageSetup\b[^>]*\borientation="landscape"/.test( sheetXml )                               ||
        /<(?:\w+:)?pageSetup\b[^>]*\bscale="(?!100")\d+"/.test( sheetXml )                                   ||
        /<(?:\w+:)?pageSetUpPr\b[^>]*\bfitToPage="(?:1|true)"/.test( sheetXml )                              ||
        /<(?:\w+:)?printOptions\b[^>]*\b(?:gridLines|headings|horizontalCentered|verticalCentered)="(?:1|true)"/.test( sheetXml ) ||
        /<(?:\w+:)?(?:odd|even|first)(?:Header|Footer)>[^<]/.test( sheetXml )                                ||
        /<(?:\w+:)?(?:rowBreaks|colBreaks)\b[^>]*>\s*<(?:\w+:)?brk\b/.test( sheetXml ) )
        lossy.push( 'calc.lossyPage' );

    return lossy;
}

// Is <tag> (b, strike, …) present and switched on anywhere in `xml`?
// <b/> and <b val="1"/> are on; <b val="0"/> is off.
function isOn( xml, tag )
{
    const re = new RegExp( '<(?:\\w+:)?' + tag + '\\b([^>]*?)\\/?>', 'g' );
    let m;
    while( ( m = re.exec( xml ) ) !== null )
        if( ! /\bval="(?:0|false|none|baseline)"/.test( m[ 1 ] ) ) return true;
    return false;
}

// Text in one cell with more than one look - a red word, a bold one - which
// the model keeps as plain text. Runs that differ in nothing a reader would
// see (a font name, an explicit black) do not count.
function hasRichText( sst )
{
    return ( sst.match( /<(?:\w+:)?si>[\s\S]*?<\/(?:\w+:)?si>/g ) || [] ).some( function( si )
    {
        if( ! /<(?:\w+:)?r>/.test( si ) ) return false;

        const sizes = new Set();
        const loud  = ( si.match( /<(?:\w+:)?rPr>[\s\S]*?<\/(?:\w+:)?rPr>/g ) || [] ).some( function( p )
        {
            const sz = /<(?:\w+:)?sz\b[^>]*\bval="([\d.]+)"/.exec( p );
            if( sz ) sizes.add( sz[ 1 ] );

            const cl = /<(?:\w+:)?color\b[^>]*>/.exec( p );
            const plainColor = ! cl || /\brgb="(?:[0-9A-Fa-f]{2})?000000"|\btheme="1"|\bindexed="(?:8|64)"|\bauto="(?:1|true)"/.test( cl[ 0 ] );

            return ! plainColor || [ 'b', 'i', 'u', 'strike', 'vertAlign' ].some( function( t ) { return isOn( p, t ); } );
        });

        return loud || sizes.size > 1;
    });
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
                      .replace( /&#x([0-9a-fA-F]+);/g, function( _, h ) { return String.fromCodePoint( parseInt( h, 16 ) ); } )
                      .replace( /&#(\d+);/g,           function( _, d ) { return String.fromCodePoint( parseInt( d, 10 ) ); } )
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

// A formula moved by ( dr, dc ) cells, the way a copy moves it: every
// relative reference shifts, every $-anchored part stays put. Text in
// quotes, quoted sheet names and [table] references are passed over, and
// a name that only looks like a reference (LOG10( , a sheet called AB1!)
// is told apart by what touches it on either side.
const REF_AT = /(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(!.])|(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})(?![A-Za-z0-9_(!.])|(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![A-Za-z0-9_(!.])/y;

function shiftFormula( f, dr, dc )
{
    if( ! dr && ! dc ) return f;

    // null = not a reference after all (past XFD / row 1048576), '' = moved off the sheet
    const col = function( abs, letters )
    {
        const c = decodeCol( letters );
        if( c > 16383 ) return null;
        const to = c + ( abs ? 0 : dc );
        return ( to < 0 || to > 16383 ) ? '' : abs + encodeCol( to );
    };
    const row = function( abs, digits )
    {
        const r = parseInt( digits, 10 );
        if( r < 1 || r > 1048576 ) return null;
        const to = r + ( abs ? 0 : dr );
        return ( to < 1 || to > 1048576 ) ? '' : abs + to;
    };

    let out = '';
    let i   = 0;

    while( i < f.length )
    {
        const ch = f.charAt( i );

        if( ch === '"' || ch === "'" )
        {
            let j = i + 1;
            for( ; j < f.length; j++ )
            {
                if( f.charAt( j ) !== ch ) continue;
                if( f.charAt( j + 1 ) === ch ) { j++; continue; }     // "" / '' inside
                break;
            }
            out += f.slice( i, j + 1 );
            i = j + 1;
            continue;
        }

        if( ch === '[' )
        {
            let depth = 0;
            let j     = i;
            for( ; j < f.length; j++ )
            {
                if( f.charAt( j ) === '[' ) depth++;
                else if( f.charAt( j ) === ']' && --depth === 0 ) break;
            }
            out += f.slice( i, j + 1 );
            i = j + 1;
            continue;
        }

        REF_AT.lastIndex = i;
        const m = /[A-Za-z0-9_.]/.test( f.charAt( i - 1 ) ) ? null : REF_AT.exec( f );

        let a = null, b = null;
        if( m && m[ 2 ] !== undefined ) { a = col( m[ 1 ], m[ 2 ] );  b = row( m[ 3 ], m[ 4 ] ); }
        else if( m && m[ 6 ] !== undefined ) { a = col( m[ 5 ], m[ 6 ] );  b = col( m[ 7 ], m[ 8 ] ); }
        else if( m ) { a = row( m[ 9 ], m[ 10 ] ); b = row( m[ 11 ], m[ 12 ] ); }

        if( a === null || b === null ) { out += ch; i++; continue; }

        if( a === '' || b === '' ) out += '#REF!';
        else out += ( m[ 2 ] !== undefined ) ? a + b : a + ':' + b;
        i = REF_AT.lastIndex;
    }

    return out;
}

// What the library's parse leaves out of the cells, read straight from the
// sheet's XML: each cell's style number (for the style parts the library
// cannot read, see readStyleParts), the text of a t="d" date, the
// formulas of a shared-formula group, the sheet's default column width, and
// the style numbers of whole rows and columns (<row s= customFormat="1">,
// <col style=>), which the library does not read at all.
//
// A shared formula is written ONCE, on the first cell of its group
// (<f t="shared" ref="D6:D19" si="0">E6/C6</f>); every other cell of the
// group carries only <f t="shared" si="0"/>, and the library read those
// as plain values - the first save froze them (79 formulas became 5 in one
// of his files). Each is rebuilt here from the group's formula, moved by
// the distance between the two cells, the way Excel expands the group.
function scanSheetXml( zip, partPath )
{
    const out = { xf: {}, dates: {}, shared: {}, rows: [], hiddenRows: [], hiddenCols: [], colWidth: null, rowHeight: null,
                  rowXf: [], colXf: [], plainWidth: [] };
    if( ! zip || ! zip.files || ! partPath || ! zip.files[ partPath ] ) return out;

    const xml = new TextDecoder().decode( zip.files[ partPath ] );

    // Whether the part holds any cell at all (see the unread check in decodeToDoc).
    out.cells = /<(?:\w+:)?c\b[^>]*\br=["'][A-Z]+\d+["']/.test( xml );

    // A column with no width of its own is drawn at the sheet's default,
    // which the writer does not carry: each such column gets it as its own
    // width instead. Given only a base width, Excel pads it by 5 pixels and
    // rounds up to a multiple of 8 (a base of 8 is Excel's own default).
    const fmt = /<(?:\w+:)?sheetFormatPr\b[^>]*>/.exec( xml );
    if( fmt )
    {
        const dw = /\bdefaultColWidth="([\d.]+)"/.exec( fmt[ 0 ] );
        const bw = /\bbaseColWidth="(\d+)"/.exec( fmt[ 0 ] );
        if( dw && parseFloat( dw[ 1 ] ) > 0 ) out.colWidth = parseFloat( dw[ 1 ] );
        else if( bw && +bw[ 1 ] !== 8 )       out.colWidth = Math.floor( Math.ceil( ( +bw[ 1 ] * 7 + 5 ) / 8 ) * 8 / 7 * 256 ) / 256;

        // The default row height the same way, but only when it was fixed on
        // purpose (customHeight="1"): the writer always puts out 15 points, so
        // such a sheet at 15.75 had every row without a height of its own
        // shrink. Each such row takes the file's figure instead - written as a
        // custom height, which is what it was. A default that is not custom
        // is left alone: Excel and LibreOffice size those rows themselves, and
        // a custom height on each would stop wrapped rows from growing.
        const dh = /\bdefaultRowHeight="([\d.]+)"/.exec( fmt[ 0 ] );
        const ch = /\bcustomHeight="(?:1|true)"/.test( fmt[ 0 ] );
        if( ch && dh && parseFloat( dh[ 1 ] ) > 0 && parseFloat( dh[ 1 ] ) !== 15 ) out.rowHeight = parseFloat( dh[ 1 ] );
    }

    const sd = /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec( xml );
    if( ! sd ) return out;

    // Row heights and hidden rows, read here as well: the library reads one
    // <row> tag per </row>, so the row right after an empty one
    // (<row r="13" … />) lost its height; and it knows hidden="1" but not
    // LibreOffice's hidden="true" (1,300 filtered-out rows of one of his
    // files came back visible). Hidden columns likewise.
    sd[ 1 ].replace( /<(?:\w+:)?row\b([^>]*)>/g, function( tag, attrs )
    {
        const r  = /\br=["'](\d+)["']/.exec( attrs );
        const ht = /\bht=["']([\d.]+)["']/.exec( attrs );
        if( r && ht ) out.rows[ +r[ 1 ] - 1 ] = parseFloat( ht[ 1 ] );
        if( r && /\bhidden=["'](?:1|true)["']/.test( attrs ) ) out.hiddenRows.push( +r[ 1 ] - 1 );

        // A whole row's look: its s= counts only with customFormat on.
        const s = /\bs=["'](\d+)["']/.exec( attrs );
        if( r && s && +s[ 1 ] > 0 && /\bcustomFormat=["'](?:1|true)["']/.test( attrs ) ) out.rowXf[ +r[ 1 ] - 1 ] = +s[ 1 ];
        return tag;
    } );
    ( xml.match( /<(?:\w+:)?col\b[^>]*>/g ) || [] ).forEach( function( tag )
    {
        const min = /\bmin=["'](\d+)["']/.exec( tag ), max = /\bmax=["'](\d+)["']/.exec( tag );
        if( ! min || ! max ) return;

        const hidden = /\bhidden=["'](?:1|true)["']/.test( tag );
        const st     = /\bstyle=["'](\d+)["']/.exec( tag );

        // A formatted column at Excel's default width, which is how Calc
        // writes a column that has a look but no width of its own (see
        // sheetToWorksheet): not a width to keep, so it opens at Calc's
        // default like its neighbours instead of narrower.
        const plain  = !! st && ! /\bcustomWidth=["'](?:1|true)["']/.test( tag ) && /\bwidth=["']9\.140625["']/.test( tag );

        for( let c = +min[ 1 ] - 1; c < Math.min( +max[ 1 ], 16384 ); c++ )
        {
            if( hidden ) out.hiddenCols.push( c );
            if( st && +st[ 1 ] > 0 ) out.colXf[ c ] = +st[ 1 ];
            if( plain ) out.plainWidth.push( c );
        }
    });

    const groups  = {};    // si -> the group's formula and the cell it is written on
    const members = [];    // [ address, si ] of the cells that only point at a group

    const re = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let m;
    while( ( m = re.exec( sd[ 1 ] ) ) !== null )
    {
        const ref = /\br=["']([A-Z]+\d+)["']/.exec( m[ 1 ] );
        if( ! ref ) continue;

        const addr = ref[ 1 ];
        const s    = /\bs=["'](\d+)["']/.exec( m[ 1 ] );
        if( s ) out.xf[ addr ] = +s[ 1 ];

        const body = m[ 2 ];
        if( ! body ) continue;

        if( /\bt=["']d["']/.test( m[ 1 ] ) )
        {
            const v = /<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/.exec( body );
            if( v ) out.dates[ addr ] = v[ 1 ];
        }

        const f = /<(?:\w+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/.exec( body );
        if( ! f || ! /\bt=["']shared["']/.test( f[ 1 ] ) ) continue;

        const si = /\bsi=["'](\d+)["']/.exec( f[ 1 ] );
        if( ! si ) continue;

        if( f[ 2 ] ) groups[ si[ 1 ] ] = { f: decodeXmlText( f[ 2 ] ), at: decodeCell( addr ) };
        else         members.push( [ addr, si[ 1 ] ] );
    }

    members.forEach( function( mb )
    {
        const g = groups[ mb[ 1 ] ];
        if( ! g ) return;

        const at = decodeCell( mb[ 0 ] );
        out.shared[ mb[ 0 ] ] = shiftFormula( g.f, at.r - g.at.r, at.c - g.at.c );
    });

    return out;
}

// Excel's legacy palette, for a colour given as indexed="n" (64 and 65 are
// the system's own "automatic" colours: no colour at all).
const INDEXED_COLORS = (
    '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
    '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
    '800000 008000 000080 808000 800080 008080 C0C0C0 808080 ' +
    '9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
    '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF ' +
    '00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
    '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 ' +
    '003366 339966 003300 333300 993300 993366 333399 333333' ).split( ' ' );

// A theme colour's tint: lighter ( > 0 ) or darker ( < 0 ) by moving its
// luminance, Excel's own rule (ECMA-376, CT_Color/@tint).
function applyTint( hex, tint )
{
    let r = parseInt( hex.slice( 0, 2 ), 16 ) / 255;
    let g = parseInt( hex.slice( 2, 4 ), 16 ) / 255;
    let b = parseInt( hex.slice( 4, 6 ), 16 ) / 255;

    const max = Math.max( r, g, b ), min = Math.min( r, g, b );
    let h = 0, s = 0, l = ( max + min ) / 2;
    if( max !== min )
    {
        const d = max - min;
        s = ( l > 0.5 ) ? d / ( 2 - max - min ) : d / ( max + min );
        h = ( max === r ) ? ( g - b ) / d + ( g < b ? 6 : 0 ) : ( max === g ) ? ( b - r ) / d + 2 : ( r - g ) / d + 4;
        h /= 6;
    }

    l = ( tint < 0 ) ? l * ( 1 + tint ) : l * ( 1 - tint ) + tint;

    const hue = function( p, q, t )
    {
        if( t < 0 ) t += 1;
        if( t > 1 ) t -= 1;
        if( t < 1 / 6 ) return p + ( q - p ) * 6 * t;
        if( t < 1 / 2 ) return q;
        if( t < 2 / 3 ) return p + ( q - p ) * ( 2 / 3 - t ) * 6;
        return p;
    };

    if( s === 0 ) r = g = b = l;
    else
    {
        const q = ( l < 0.5 ) ? l * ( 1 + s ) : l + s - l * s;
        const p = 2 * l - q;
        r = hue( p, q, h + 1 / 3 );
        g = hue( p, q, h );
        b = hue( p, q, h - 1 / 3 );
    }

    return [ r, g, b ].map( function( v ) { return ( '0' + Math.round( v * 255 ).toString( 16 ) ).slice( -2 ); } ).join( '' ).toUpperCase();
}

// The parts of styles.xml the library reads only halfway, one entry per cell
// format (the s= of a cell): a fill given as a theme colour with its tint or
// as a palette number (the library keeps RGB fills only, so those cells lost
// their colour), every border side with its own line and colour (the
// library drops any line but thin/medium, and every colour but RGB), and
// wrapText="true" (it only knows "1"). Colours come out as RGB, the only
// kind Calc's model holds.
function readStyleParts( zip )
{
    if( ! zip || ! zip.files || ! zip.files[ 'xl/styles.xml' ] ) return null;

    const dec = new TextDecoder();
    const xml = dec.decode( zip.files[ 'xl/styles.xml' ] );

    const block = function( tag )
    {
        const m = new RegExp( '<(?:\\w+:)?' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + tag + '>' ).exec( xml );
        return m ? m[ 1 ] : '';
    };
    const items = function( body, tag )
    {
        return body.match( new RegExp( '<(?:\\w+:)?' + tag + '\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/(?:\\w+:)?' + tag + '>)', 'g' ) ) || [];
    };

    // A file may bring its own palette; the theme's colours sit in
    // theme1.xml in the order dk1 lt1 dk2 lt2 …, but theme="0" means lt1.
    const own     = ( block( 'indexedColors' ).match( /\brgb="[0-9A-Fa-f]{6,8}"/g ) || [] ).map( function( a ) { return a.slice( -7, -1 ); } );
    const indexed = own.length ? own : INDEXED_COLORS;

    const tp = zip.files[ 'xl/theme/theme1.xml' ] ? 'xl/theme/theme1.xml'
             : Object.keys( zip.files ).filter( function( n ) { return /^xl\/theme\/[^/]+\.xml$/.test( n ); } )[ 0 ];
    const scheme = {};
    if( tp ) dec.decode( zip.files[ tp ] ).replace( /<(?:\w+:)?(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>([\s\S]*?)<\/(?:\w+:)?\1>/g, function( all, name, body )
    {
        const c = /\blastClr="([0-9A-Fa-f]{6})"/.exec( body ) || /<(?:\w+:)?srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec( body );
        const hex = c ? c[ 1 ] : /\bval="window"/.test( body ) ? 'FFFFFF' : /\bval="windowText"/.test( body ) ? '000000' : null;
        if( hex && ! scheme[ name ] ) scheme[ name ] = hex.toUpperCase();
        return all;
    } );
    const theme = [ 'lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink' ]
                  .map( function( k ) { return scheme[ k ] || null; } );

    const colorOf = function( tag )
    {
        const at = function( n ) { const m = new RegExp( '\\b' + n + '="([^"]*)"' ).exec( tag ); return m ? m[ 1 ] : null; };

        let hex = null;
        if( at( 'rgb' ) )                   hex = at( 'rgb' ).slice( -6 );
        else if( at( 'theme' ) !== null )   hex = theme[ +at( 'theme' ) ];
        else if( at( 'indexed' ) !== null ) hex = indexed[ +at( 'indexed' ) ];
        if( ! hex || ! /^[0-9A-Fa-f]{6}$/.test( hex ) ) return null;

        const tint = parseFloat( at( 'tint' ) || '0' );
        return tint ? applyTint( hex.toUpperCase(), tint ) : hex.toUpperCase();
    };

    const fills = items( block( 'fills' ), 'fill' ).map( function( fx )
    {
        if( ! /\bpatternType="solid"/.test( fx ) ) return null;
        const fg = /<(?:\w+:)?fgColor\b[^>]*>/.exec( fx );
        return fg ? colorOf( fg[ 0 ] ) : null;
    });

    const SIDE_TAGS = { top: 'top', right: 'right|end', bottom: 'bottom', left: 'left|start' };
    const borders = items( block( 'borders' ), 'border' ).map( function( bx )
    {
        const b = {};
        Object.keys( SIDE_TAGS ).forEach( function( side )
        {
            const t = SIDE_TAGS[ side ];
            const m = new RegExp( '<(?:\\w+:)?(?:' + t + ')\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:\\w+:)?(?:' + t + ')>)' ).exec( bx );
            if( ! m ) return;

            const st = /\bstyle="(\w+)"/.exec( m[ 1 ] );
            if( ! st || st[ 1 ] === 'none' ) return;

            const cl  = m[ 2 ] && /<(?:\w+:)?color\b[^>]*>/.exec( m[ 2 ] );
            const hex = cl ? colorOf( cl[ 0 ] ) : null;
            b[ side ] = hex ? { style: st[ 1 ], color: hex } : { style: st[ 1 ] };
        });
        return Object.keys( b ).length ? b : null;
    });

    const xfs = items( block( 'cellXfs' ), 'xf' ).map( function( x )
    {
        const id = function( n ) { const m = new RegExp( '\\b' + n + '="(\\d+)"' ).exec( x ); return m ? +m[ 1 ] : 0; };
        return { fill: fills[ id( 'fillId' ) ] || null, border: borders[ id( 'borderId' ) ] || null,
                 wrap: /\bwrapText="(?:1|true)"/.test( x ) };
    });

    return { xfs: xfs };
}

// Excel's error values: a cell holding one is an error, not text, both
// ways - read as its text ("#N/A", the number behind it used to come out
// as 0) and written back as t="e".
const EXCEL_ERRORS = [ '#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA' ];

// Serial day numbers, the way Excel stores a date. Day 0 is 1899-12-30 in
// the 1900 system (Excel counts a 29 Feb 1900 that never was, so from March
// 1900 on this lands right) and 1904-01-01 in the 1904 one.
function serialFromParts( y, mo, d, h, mi, s, date1904 )
{
    let n = ( Date.UTC( y, mo - 1, d, h || 0, mi || 0, s || 0 ) - Date.UTC( 1899, 11, 30 ) ) / 86400000;
    if( date1904 )  n -= 1462;
    else if( n < 61 ) n -= 1;          // before the phantom 29 Feb 1900
    return n;
}

// The text of a t="d" cell, an ISO 8601 date and maybe a time, as a serial.
// Read off the digits, not through Date: "2024-01-15" parses as UTC and
// "2024-01-15T10:00" as local time, and Excel means neither.
function isoToSerial( text, date1904 )
{
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec( String( text || '' ).trim() );
    if( ! m ) return null;
    return serialFromParts( +m[ 1 ], +m[ 2 ], +m[ 3 ], +( m[ 4 ] || 0 ), +( m[ 5 ] || 0 ), +( m[ 6 ] || 0 ), date1904 );
}

// Turn one parsed worksheet into a sheet entry (see THE OPEN WORKBOOK).
// `scan` is what scanSheetXml read off the sheet's own XML, `parts` the
// file's readStyleParts; both may be missing (a .csv, a sheet with no part).
function worksheetToSheet( ws, name, scan, parts, date1904 )
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

    // Whole rows and columns with a look (see THE LOOK OF A CELL in grid.js).
    // One object per style number, shared by every line that has it: a
    // formatted sheet is 16,384 columns of the same one (never edited in
    // place, see format.js).
    // A line whose look is the file's own default one (xf 0) has no look:
    // LibreOffice puts such a style= on columns it only sized.
    const lineLooks = {};
    const xfLook    = function( n ) { return ( parts && parts.libStyle ) ? xlsxStyleToObj( parts.libStyle( n ), parts.xfs[ n ] ) : null; };
    const plainLook = JSON.stringify( xfLook( 0 ) );
    const lineLook  = function( n )
    {
        if( ! ( n in lineLooks ) )
        {
            const st = xfLook( n );
            lineLooks[ n ] = ( st && JSON.stringify( st ) !== plainLook ) ? st : null;
        }
        return lineLooks[ n ];
    };
    if( scan )
    {
        scan.rowXf.forEach( function( n, r ) { const st = lineLook( n ); if( st ) sh.rowStyles[ r ] = st; } );
        scan.colXf.forEach( function( n, c ) { const st = lineLook( n ); if( st ) sh.colStyles[ c ] = st; } );
    }

    for( let r = 0; r <= endRow; r++ )
    {
        const row = [];

        for( let c = 0; c <= endCol; c++ )
        {
            const addr = encodeCell( { r: r, c: c } );
            const cell = ws[ addr ];
            const xfN  = scan ? scan.xf[ addr ] : undefined;

            // A cell of a shared-formula group gets its own formula back.
            const value = ( scan && scan.shared[ addr ] ) ? '=' + scan.shared[ addr ]
                                                          : cellToValue( cell, scan && scan.dates[ addr ], date1904 );
            row.push( value );

            let style = xlsxStyleToObj( cell && cell.s, ( parts && xfN > 0 ) ? parts.xfs[ xfN ] : null );

            // A t="d" date is a serial number now; with no number format of
            // its own it would show as one.
            if( cell && cell.t === 'd' && typeof value === 'number' && ( ! style || ! style.numFmt || style.numFmt === 'General' ) )
            {
                style = style || {};
                style.numFmt = ( value % 1 ) ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd';
            }

            // An empty cell (a stub, see decodeToDoc) keeps its look only when
            // there is something to see - a fill or a box. The rest (a font,
            // a number format waiting for a value) would only swell the file:
            // one of his sheets has 28,000 such cells.
            // In a styled row or column every cell the file has keeps its own
            // look, even an empty one: the line's would show instead. One with
            // none of its own (no s=) is plain there in Excel - its own xf 0
            // wins over the line's - and is kept plain, {}.
            const bare = ! cell || cell.t === 'z';
            const line = lineStyle( sh, r, c );
            if( style && ( ! bare || style.bg || style.border || line ) ) sh.cellStyles[ addr ] = style;
            else if( ! style && cell && line ) sh.cellStyles[ addr ] = {};

            // A note and a link are cell facts the grid can show, so they
            // belong on the sheet entry like everything else.
            if( cell && cell.c && cell.c.length )
            {
                const text = cell.c.map( function( n ) { return n.t || ''; } ).join( '\n' ).trim();
                sh.comments[ addr ] = text;

                // Who wrote it, kept by the note's text so it follows the note
                // wherever a sort or an insert moves it. A note edited here,
                // or a new one, is Calc's (see sheetToWorksheet).
                if( cell.c[ 0 ].a ) ( sh.noteAuthors || ( sh.noteAuthors = {} ) )[ text ] = cell.c[ 0 ].a;
            }
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

    // The sheet's default width, on every column of the used range that has
    // none of its own (see scanSheetXml): it goes back out as theirs.
    if( scan && scan.colWidth )
    {
        for( let c = 0; c <= endCol; c++ )
        {
            if( sh.colsSrc[ c ] != null ) continue;
            sh.cols[ c ]    = colCharsToPx( scan.colWidth );
            sh.colsSrc[ c ] = scan.colWidth;
        }
    }

    // A formatted column written at Excel's default width has no width of
    // its own (see scanSheetXml).
    else if( scan ) scan.plainWidth.forEach( function( c )
    {
        if( sh.colsSrc[ c ] !== 9.140625 ) return;
        delete sh.cols[ c ];
        delete sh.colsSrc[ c ];
    });

    ( ws[ '!rows' ] || [] ).forEach( function( row, r )
    {
        if( ! row ) return;
        if( row.hpt    ) { sh.rows[ r ] = rowPtToPx( row.hpt ); sh.rowsSrc[ r ] = row.hpt; }
        if( row.hidden ) sh.hiddenRows.push( r );
    });

    // …and the heights and hidden rows/columns the library missed (see scanSheetXml).
    if( scan )
    {
        scan.rows.forEach( function( hpt, r )
        {
            if( sh.rowsSrc[ r ] == null ) { sh.rows[ r ] = rowPtToPx( hpt ); sh.rowsSrc[ r ] = hpt; }
        });
        const hr = new Set( sh.hiddenRows ), hc = new Set( sh.hiddenCols );
        scan.hiddenRows.forEach( function( r ) { if( ! hr.has( r ) ) { hr.add( r ); sh.hiddenRows.push( r ); } } );
        scan.hiddenCols.forEach( function( c ) { if( ! hc.has( c ) ) { hc.add( c ); sh.hiddenCols.push( c ); } } );

        // The sheet's default height, on every row of the used range that
        // has none of its own (see scanSheetXml).
        if( scan.rowHeight )
        {
            for( let r = 0; r <= endRow; r++ )
            {
                if( sh.rowsSrc[ r ] != null ) continue;
                sh.rows[ r ]    = rowPtToPx( scan.rowHeight );
                sh.rowsSrc[ r ] = scan.rowHeight;
            }
        }
    }

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

// A .csv into a one-sheet workbook. The library reads CSV only from a string,
// and only comma-separated (it took the bytes for a broken .xlsx, so no .csv
// ever opened), so it is split here (splitCsv), keeping each field's own
// text for the save (writeCsv). The bytes are UTF-8, or else Windows' own Latin-1 (what
// Excel writes in Spain); the separator is whichever of , ; or tab the first
// line that has any has most of, outside quotes - the header, as a rule (a
// bank's export may start with a title line that has none; the amounts under
// the header may be written "12,50"). A field becomes a number only when it is
// written as one ("-32.50", "1e5") and a number would not change it: a
// leading zero ("08001" is a postcode), a "+" (a phone) and more than 15
// digits stay text, as when typed (grid.js, TYPED NUMBERS AND DATES).
function readCsv( buf )
{
    const bytes = ( typeof buf === 'string' ) ? null : new Uint8Array( buf );
    let text, latin1 = false;

    if( ! bytes ) text = buf;
    else
    {
        try { text = new TextDecoder( 'utf-8', { fatal: true } ).decode( bytes ); }
        catch( _ ) { text = new TextDecoder( 'windows-1252' ).decode( bytes ); latin1 = true; }
    }

    const bom = ( !! bytes && bytes[ 0 ] === 0xEF && bytes[ 1 ] === 0xBB && bytes[ 2 ] === 0xBF );
    text = text.replace( /^\uFEFF/, '' );

    const head = text.slice( 0, 20000 ).replace( /"(?:[^"]|"")*"/g, '' ).split( /\r\n|\r|\n/ )
                     .filter( function( line ) { return /[,;\t]/.test( line ); } )[ 0 ] || '';
    let sep = ',', most = 0;
    [ ',', ';', '\t' ].forEach( function( ch )
    {
        const n = head.split( ch ).length - 1;
        if( n > most ) { most = n; sep = ch; }
    });

    const fields = splitCsv( text, sep );
    const rows   = fields.map( function( row )
    {
        return row.map( function( f )
        {
            const v = f.value;
            const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE][-+]?\d+)?$/.exec( v );
            if( ! m || ( m[ 2 ].length > 1 && m[ 2 ].charAt( 0 ) === '0' ) || m[ 2 ].length + ( m[ 3 ] || '' ).length > 15 ) return v;
            const n = Number( v );
            return isFinite( n ) ? n : v;
        });
    });

    const name = defaultSheetName();
    const wb   = { SheetNames: [ name ], Sheets: {} };
    wb.Sheets[ name ] = arrayToSheet( rows.length ? rows : [ [ '' ] ] );

    // Each field's text as the file has it, by address; its value is filled
    // in once the sheet is built (decodeToDoc). The line break is the first
    // one the file uses.
    const raw = {};
    fields.forEach( function( row, r ) { row.forEach( function( f, c ) { raw[ encodeCell( { r: r, c: c } ) ] = { raw: f.raw }; } ); } );

    const eol = /\r\n|\n|\r/.exec( text );

    // A Latin-1 file was made for Excel, which reads UTF-8 right only with
    // the mark in front: the save writes UTF-8, so it gets one.
    return { wb: wb, sep: sep, bom: bom || latin1, raw: raw,
             eol: eol ? eol[ 0 ] : '\n', endEol: /(?:\r\n|\n|\r)$/.test( text ) };
}

// A CSV text as rows of fields, each { value, raw }: the value is what the
// field says ("a,b" for "\"a,b\""), the raw text is the field exactly as
// written, quotes and all. A line break ends a row unless it is inside
// quotes; the break after the last row makes no empty row of its own.
function splitCsv( text, sep )
{
    const rows = [];
    let row = [];
    let i   = 0;
    const n = text.length;
    const end = function( ch ) { return ch === sep || ch === '\r' || ch === '\n'; };

    while( i < n )
    {
        const start = i;
        let value   = '';

        if( text.charAt( i ) === '"' )
        {
            for( i++; i < n; i++ )
            {
                const ch = text.charAt( i );
                if( ch !== '"' ) { value += ch; continue; }
                if( text.charAt( i + 1 ) === '"' ) { value += '"'; i++; continue; }
                i++;
                break;
            }
            // Anything between the closing quote and the separator is kept.
            while( i < n && ! end( text.charAt( i ) ) ) value += text.charAt( i++ );
        }
        else
        {
            while( i < n && ! end( text.charAt( i ) ) ) i++;
            value = text.slice( start, i );
        }

        row.push( { value: value, raw: text.slice( start, i ) } );

        if( i < n && text.charAt( i ) === sep )
        {
            i++;
            if( i === n ) row.push( { value: '', raw: '' } );      // "a,b," at the very end
            continue;
        }

        rows.push( row );
        row = [];
        if( text.charAt( i ) === '\r' && text.charAt( i + 1 ) === '\n' ) i += 2;
        else if( i < n ) i++;
    }
    if( row.length ) rows.push( row );

    return rows;
}

// A .csv save of the sheet `sh`. When it was opened from a .csv
// (sh.csvRaw), every field the user did not change goes back exactly as the
// file had it: "-32.50" stays "-32.50", not the number's own -32.5, and
// text from the file never gets an apostrophe. The rest - an edited cell, a
// new one, every cell of a sheet from an .xlsx - is what the library writes,
// field by field (`lib`, its CSV of the worksheet `ws`), with one change:
// text that begins with = + - @ (a formula, to a spreadsheet opening the
// file) gets an apostrophe in front, the usual guard. Rows and fields run as
// far as the file's or the sheet's, whichever is longer, with the file's own
// line break.
function writeCsv( sh, ws, lib, csv )
{
    const fresh = splitCsv( lib, csv.sep );
    const raw   = sh.csvRaw || {};
    const data  = sh.data || [];

    const guard = function( r, c, field )
    {
        const cell = ws[ encodeCell( { r: r, c: c } ) ];
        const text    = cell && cell.t === 's' && /^[=+\-@\t\r]/.test( String( cell.v ) );
        const formula = cell && cell.f && cell.v === undefined;      // no result: written as "=…"
        if( ! text && ! formula ) return field;
        return field.charAt( 0 ) === '"' ? '"\'' + field.slice( 1 ) : "'" + field;
    };

    const width = [];
    const grow  = function( r, c ) { if( ! ( width[ r ] > c ) ) width[ r ] = c + 1; };
    Object.keys( raw ).forEach( function( addr ) { const rc = decodeCell( addr ); grow( rc.r, rc.c ); } );
    data.forEach( function( row, r )
    {
        ( row || [] ).forEach( function( v, c ) { if( v !== '' && v !== null && v !== undefined ) grow( r, c ); } );
    });

    const lines = [];
    for( let r = 0; r < width.length; r++ )
    {
        const fields = [];
        for( let c = 0; c < ( width[ r ] || 0 ); c++ )
        {
            const was = raw[ encodeCell( { r: r, c: c } ) ];
            const now = data[ r ] ? data[ r ][ c ] : undefined;
            const same = was && ( now === was.value || ( ( now === '' || now == null ) && ( was.value === '' || was.value == null ) ) );

            if( same ) fields.push( was.raw );
            else       fields.push( ( fresh[ r ] && fresh[ r ][ c ] ) ? guard( r, c, fresh[ r ][ c ].raw ) : '' );
        }
        lines.push( fields.join( csv.sep ) );
    }

    return lines.join( csv.eol ) + ( csv.endEol && lines.length ? csv.eol : '' );
}

// Read a file into the workbook model. Still one sheet on the grid — the
// tabs come later — but the doc shape, the source bytes and the loss list
// are all in place from here on.
async function decodeToDoc( buf, ext )
{
    // sheetStubs: a cell with a style and no value (a painted or boxed empty
    // cell) is otherwise skipped by the parse, and its look lost. A .csv
    // takes its own way in (readCsv).
    const csv = ( ext === 'csv' ) ? readCsv( buf ) : null;
    const wb  = csv ? csv.wb
                    : await read( buf, { type: 'array', cellFormula: true, cellStyles: true, keepZip: true, sheetStubs: true } );

    const d = newDoc();

    // How the .csv was written, so a save writes it the same way (encodeFromGrid).
    if( csv ) d.csv = { sep: csv.sep, bom: csv.bom, eol: csv.eol, endEol: csv.endEol };

    d.srcZip = wb._zip || null;
    d.lossy  = detectLossy( wb );

    d.names = ( wb.Workbook && wb.Workbook.Names ) || null;

    // A workbook counting its dates from 1904 (old Mac Excel) is written
    // back so; written as 1900, every date in it moved four years.
    d.date1904 = !! ( wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904 );

    const names = ( wb.SheetNames && wb.SheetNames.length ) ? wb.SheetNames : [ defaultSheetName() ];
    const state = ( wb.Workbook && wb.Workbook.Sheets ) || [];

    const parts  = sheetPartsByName( d.srcZip );
    const styles = readStyleParts( d.srcZip );

    // The library's reading of one style number, for whole rows and columns
    // (worksheetToSheet): it reads them only off cells itself.
    if( styles ) styles.libStyle = wb._xfStyle || null;

    d.sheets = names.map( function( name, i )
    {
        const ws   = wb.Sheets[ name ];
        const scan = scanSheetXml( d.srcZip, parts[ name ] );
        const sh   = worksheetToSheet( ws || {}, name, scan, styles, d.date1904 );
        sh.hidden = ( state[ i ] && state[ i ].Hidden ) || 0;
        sh.raw    = captureRawSheet( d.srcZip, parts[ name ] );

        // A sheet the library could not read (a chart sheet, a part it
        // choked on, one whose cells it could not find) opens empty - and
        // the next save would write it empty over the real one. The loss
        // gate asks first, and calc.js can hold the file read-only off
        // this flag.
        const listed = ( wb.SheetNames || [] ).indexOf( name ) !== -1;
        const empty  = ! ws || ! Object.keys( ws ).some( function( k ) { return k.charAt( 0 ) !== '!'; } );
        if( listed && ( ! ws || ( empty && scan.cells ) ) ) sh.unread = true;
        return sh;
    });

    if( d.sheets.some( function( sh ) { return sh.unread; } ) ) d.lossy.push( 'calc.lossyUnread' );

    // Each field of a .csv, with the value the grid holds for it: a field
    // whose cell still holds that value is written back as it was (writeCsv).
    if( csv )
    {
        const sh = d.sheets[ 0 ];
        Object.keys( csv.raw ).forEach( function( addr )
        {
            const rc  = decodeCell( addr );
            const row = sh.data[ rc.r ];
            csv.raw[ addr ].value = row ? row[ rc.c ] : undefined;
        });
        sh.csvRaw = csv.raw;
    }

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

// One sheet entry -> one worksheet. Reads nothing but `sh` (and the engine),
// so the sheet being written does not have to be the one on screen. `xlsx`
// false = a .csv.
//
// The cached <v>: the grid's own answers for the sheet on screen (just
// stashed). Any other sheet takes the engine's, which are live - `sh.values`
// there is what the grid showed when that sheet was left, and a formula over
// a sheet edited since then has moved on. It is only the fallback.
function sheetToWorksheet( sh, xlsx )
{
    const aoa = sh.data || [];
    const out = ( sh === activeSheet ? sh.values : engineValues( sh ) || sh.values ) || [];

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

            // A cell with no look of its own goes out with its row's or
            // column's as its own s=, as Excel writes a value typed into a
            // formatted row: in the file an own s= - even none - wins.
            const style = objToXlsxStyle( sh.cellStyles[ addr ] || lineStyle( sh, r, c ) );

            // A formula is written with its last result beside it. Excel
            // recalculates on open and never notices, but anything that
            // trusts the stored value — LibreOffice's converters, a
            // preview pane, a script reading the file — showed 0 for every
            // formula in the sheet without this.
            if( cell.f ) cacheFormulaResult( cell, out[ r ] && out[ r ][ c ] );

            // No result to cache (an error, or no engine behind the sheet):
            // the writer would put out <v>undefined</v>, a number Excel
            // cannot read - it offers to repair the file, and a repair drops
            // formulas. An empty text result is valid and recalculated anyway.
            if( xlsx && cell.f && cell.v === undefined ) { cell.t = 's'; cell.v = ''; }

            if( style ) cell.s = style;

            ws[ addr ] = cell;

            if( r > maxRow ) maxRow = r;
            if( c > maxCol ) maxCol = c;
        });
    });

    // A cell can hold nothing but a fill, a border or a merge anchor. The loop
    // above skips empty values, so those cells used to reach the file with no
    // style at all — the colours and boxes a user painted simply vanished.
    // (Not in a .csv: it has no looks to keep, and every painted empty cell
    // past the data would only add blank rows and columns to it.)
    if( xlsx ) Object.keys( sh.cellStyles ).forEach( function( addr )
    {
        if( ws[ addr ] ) return;

        const style = objToXlsxStyle( sh.cellStyles[ addr ] );
        const rc    = decodeCell( addr );

        // An empty cell kept plain in a styled row or column ({}, see
        // THE LOOK OF A CELL in grid.js) goes out as a bare <c r=".."/>:
        // its own xf 0 is what keeps the line's look off it.
        if( ! style && ! lineStyle( sh, rc.r, rc.c ) ) return;

        // t 'z': an empty cell, <c r=".." s=".."/> - not a text cell with no text.
        ws[ addr ] = style ? { t: 'z', s: style } : { t: 'z', z: 'General' };

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
    // A note keeps the author it came with (see worksheetToSheet).
    const notes = Object.keys( sh.comments ).map( function( addr )
    {
        const author = ( sh.noteAuthors && sh.noteAuthors[ sh.comments[ addr ] ] ) || 'Calc';
        return [ addr, [ { t: sh.comments[ addr ], a: author } ] ];
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
    // the file format keeps them in. The hidden lists are the plugins' own
    // (stashActiveSheet copied them over), so a hide/show made during this
    // session counts.
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

    // Whole rows and columns with a look (see THE LOOK OF A CELL in grid.js):
    // style= on the <col>, s= customFormat="1" on the <row>. No cell is
    // written for them and the used range does not grow; a column that has
    // no width of its own goes out at Excel's default (the writer). Not in
    // a .csv. Lines a shift pushed past the sheet's edge are dropped.
    if( xlsx )
    {
        const looks = new Map();       // one written style per object: 16,384 columns may share one
        const look  = function( st )
        {
            if( ! looks.has( st ) ) looks.set( st, objToXlsxStyle( st ) );
            return looks.get( st );
        };

        ( sh.colStyles || [] ).forEach( function( st, c )
        {
            const xs = look( st );
            if( ! xs || c > 16383 ) return;
            cols[ c ] = Object.assign( {}, cols[ c ], { s: xs } );
        });
        ( sh.rowStyles || [] ).forEach( function( st, r )
        {
            const xs = look( st );
            if( ! xs || r > 1048575 ) return;
            rows[ r ] = Object.assign( {}, rows[ r ], { s: xs } );
        });
    }

    if( cols.length ) ws[ '!cols' ] = cols;
    if( rows.length ) ws[ '!rows' ] = rows;

    // A row with a height of its own (or hidden) and no cell in it: the
    // writer puts out a <row> only around cells, so its height was lost.
    // One empty cell in column A carries it (<c r="A5"/>, nothing more).
    // Not in a .csv, where it would only add blank lines. A row with only
    // a look needs none: the writer puts that <row> out by itself.
    if( xlsx && rows.length )
    {
        const filled = new Set();
        Object.keys( ws ).forEach( function( k ) { if( k.charAt( 0 ) !== '!' ) filled.add( decodeCell( k ).r ); } );

        rows.forEach( function( rw, r )
        {
            if( filled.has( r ) || ( rw.hpt == null && ! rw.hidden ) ) return;
            ws[ encodeCell( { r: r, c: 0 } ) ] = { t: 'z', z: 'General' };
            if( r > maxRow ) maxRow = r;
        });

        ws[ '!ref' ] = encodeRange( { s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } } );
    }

    const fr = sh.freeze.rows;
    const fc = sh.freeze.cols;
    if( fr || fc ) ws[ '!views' ] = [ { state: 'frozen', xSplit: fc, ySplit: fr } ];

    if( sh.autofilter ) ws[ '!autofilter' ] = sh.autofilter;
    if( sh.margins )    ws[ '!margins' ]    = sh.margins;
    if( sh.raw )        ws[ '!raw' ]        = sh.raw;

    // A conditional-format rule that paints (dxfId="n") points into the
    // <dxfs> of styles.xml, which the library rebuilds without them. It
    // splices the source's block back in (carryDxfs) - but only while it is
    // copying a part a sheet points at (a chart, a table). A sheet with such
    // rules and neither left every dxfId dangling: openpyxl cannot open the
    // file, Excel offers to repair it. Naming styles.xml as a part to keep,
    // with no relationship type, makes the library do exactly that: no
    // relationship is written, styles.xml is already in the output so it is
    // not replaced, and the <dxfs> go back in, indices unchanged.
    if( xlsx && sh.raw && /\bdxfId="/.test( sh.raw.cf ) )
        ws[ '!raw' ] = Object.assign( {}, sh.raw, { refs: sh.raw.refs.concat( [ { target: '/xl/styles.xml' } ] ) } );

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

    const bookType = ( ext === 'csv' ) ? 'csv' : 'xlsx';

    // A .csv holds one sheet, and it is the one on screen. The library's CSV
    // writer takes the workbook's first sheet, so that is the only one handed
    // to it - with every sheet in, a save from Hoja2 wrote Hoja1.
    const sheets = ( bookType === 'csv' ) ? [ doc.sheets[ doc.active ] || doc.sheets[ 0 ] ] : doc.sheets;

    sheets.forEach( function( sh )
    {
        appendSheet( wb, sheetToWorksheet( sh, bookType === 'xlsx' ), sh.name || defaultSheetName() );
    });

    // A sheet hidden in the original stays hidden.
    const sheetState = sheets.map( function( sh ) { return { Hidden: sh.hidden || 0 }; } );

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
    if( names.length )    wb.Workbook.Names   = names;
    if( doc.date1904 )    wb.Workbook.WBProps = { date1904: true };     // see decodeToDoc

    // A .csv goes back with the separator and the byte-order mark it came
    // with (see readCsv); a new one, or one saved from an .xlsx, with commas.
    // The library's own guard against formulas in a .csv is off: it put an
    // apostrophe in front of every negative NUMBER too. writeCsv guards the
    // text written from here instead.
    const csv = ( bookType === 'csv' && doc.csv ) || { sep: ',', eol: '\n', endEol: false };
    let   out = await write( wb, { type: 'array', bookType: bookType, cellStyles: true,
                                   preserve: doc.srcZip, FS: csv.sep, escapeFormulae: false } );

    // A sheet that came from a .csv keeps every field it was not edited in.
    if( bookType === 'csv' && sheets[ 0 ] )
        out = new TextEncoder().encode( writeCsv( sheets[ 0 ], wb.Sheets[ wb.SheetNames[ 0 ] ], new TextDecoder().decode( out ), csv ) );

    if( ! csv.bom ) return out;

    const withBom = new Uint8Array( out.length + 3 );
    withBom.set( [ 0xEF, 0xBB, 0xBF ] );
    withBom.set( out, 3 );
    return withBom;
}

// `iso` is the cell's own text when it is a t="d" date (see scanSheetXml).
function cellToValue( cell, iso, date1904 )
{
    if( ! cell ) return '';
    if( cell.f ) return '=' + cell.f;

    // A date stored as a date: its serial number, like every other date in
    // the sheet. The Date object used to reach the grid as "Thu Dec 31 …"
    // and be saved back as that text.
    if( cell.t === 'd' )
    {
        const n = isoToSerial( iso, date1904 );
        if( n !== null ) return n;

        const dt = cell.v;
        return ( dt instanceof Date && ! isNaN( dt ) )
             ? serialFromParts( dt.getFullYear(), dt.getMonth() + 1, dt.getDate(), dt.getHours(), dt.getMinutes(), dt.getSeconds(), date1904 )
             : ( cell.w || '' );
    }

    // An error value keeps its text ("#N/A"); its number used to come out as 0.
    if( cell.t === 'e' ) return cell.w || '';

    const v = cell.v === undefined ? '' : cell.v;

    // Text that begins with "=" is not a formula. It is escaped with an
    // apostrophe, the grid's own way of saying so: it shows "=> total", the
    // formula engine reads text, and valueToCell drops the apostrophe again.
    // Unescaped, it reopened as a formula and was saved as one.
    if( typeof v === 'string' && v.charAt( 0 ) === '=' ) return "'" + v;

    return v;
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

    // A date handed back as a Date: its serial number, shown as a date.
    if( raw instanceof Date && ! isNaN( raw ) )
        return { t: 'n', z: 'yyyy-mm-dd',
                 v: serialFromParts( raw.getFullYear(), raw.getMonth() + 1, raw.getDate(), raw.getHours(), raw.getMinutes(), raw.getSeconds(), doc.date1904 ) };

    // "'=> total": text that begins with "=" (see cellToValue).
    if( typeof raw === 'string' && raw.startsWith( "'=" ) ) return { t: 's', v: raw.slice( 1 ) };

    if( typeof raw === 'string' && EXCEL_ERRORS.indexOf( raw ) !== -1 ) return { t: 'e', v: raw };

    return { t: 's', v: String( raw ) };
}

// `x` is the cell format's entry from readStyleParts, when the file has one:
// it is the whole truth for the fill, the borders and wrapping.
function xlsxStyleToObj( s, x )
{
    if( ! s && ! x ) return null;
    s = s || {};

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

    if( x ) { if( x.fill ) o.bg = x.fill; }
    else if( s.fill && s.fill.fgColor && s.fill.fgColor.rgb )
        o.bg = s.fill.fgColor.rgb.slice( -6 ).toUpperCase();

    if( s.alignment && s.alignment.horizontal ) o.align  = s.alignment.horizontal;
    if( s.alignment && s.alignment.vertical )   o.valign = s.alignment.vertical;
    if( ( s.alignment && s.alignment.wrapText ) || ( x && x.wrap ) ) o.wrap = true;

    if( s.numFmt ) o.numFmt = s.numFmt;

    // Every side keeps its own line and colour, { style, color }, as the file
    // has them: one weight and one colour for the whole cell (the last side
    // read) moved 73 edges of one of his files. The flat style/color - what
    // the grid draws and the border dialog sets - is still the last side's,
    // as a thin/medium weight. The writer knows only those two, so dotted,
    // double or hair lines go out as the nearest (the loss gate says so).
    let sides = x ? x.border : null;
    if( ! x && s.border )
    {
        sides = {};
        SIDES.forEach( function( side )
        {
            const bs = s.border[ side ];
            if( bs && bs.style ) sides[ side ] = ( bs.color && bs.color.rgb ) ? { style: bs.style, color: bs.color.rgb.slice( -6 ).toUpperCase() }
                                                                              : { style: bs.style };
        });
    }

    if( sides )
    {
        const b = {};

        SIDES.forEach( function( side )
        {
            const bs = sides[ side ];
            if( ! bs || ! bs.style ) return;

            b[ side ] = bs.color ? { style: bs.style, color: bs.color } : { style: bs.style };
            b.style   = lineWeight( bs.style );
            if( bs.color ) b.color = bs.color;
        });

        if( Object.keys( b ).length ) o.border = b;
    }

    return Object.keys( o ).length ? o : null;
}

const SIDES = [ 'top', 'right', 'bottom', 'left' ];

// A file's border line as one of the two weights Calc draws and writes.
function lineWeight( style )
{
    return /^(medium|thick|double|slantDashDot)/.test( style || '' ) ? 'medium' : 'thin';
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

    // A side set in the border dialog is `true` and takes the flat weight
    // and colour; a side read from the file is its own { style, color }.
    if( o.border && typeof o.border === 'object' )
    {
        style.border = {};

        SIDES.forEach( function( s )
        {
            const v = o.border[ s ];
            if( ! v ) return;

            const own   = ( typeof v === 'object' ) ? v : null;
            const color = own ? own.color : o.border.color;
            const side  = { style: lineWeight( own ? own.style : o.border.style ) };
            if( color ) side.color = { rgb: color };

            style.border[ s ] = side;
        });
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
