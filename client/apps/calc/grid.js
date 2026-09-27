/*
 * grid.js - Calc's grid: the open workbook, the Handsontable grid and its
 * context menu, the sheet tabs, sort, pointing at cells while a formula is
 * typed, and the formula editor. Imported by calc.js.
 *
 * Its top level runs BEFORE calc.js's `await NayiveI18n.ready`: nothing out
 * here may call T() or read another file's names - keep that inside functions.
 */

import
{
    encodeCell, decodeCell, formatNumber
}
from './lib/xlsx-format_v2.4.1.js';
import
{
    T, PHONE, fold, HT_LOCALE, refreshNameBox, gotoReference, refreshFormulaBar,
    mirrorEditorToBar, refreshSelStats, FUNCTIONS, fxRowsHtml, scheduleAutosave
}
from './calc.js';
import
{
    updateToolbarActiveState
}
from './format.js';
import
{
    DEFAULT_COL_PX, stashActiveSheet, formulaEngine, registerSheetsInEngine
}
from './codec.js';

let table          = null;  // Handsontable instance

//--------------------------------------------------------------------//
// THE OPEN WORKBOOK
//
// Everything that has to survive a save lives on a SHEET ENTRY, never as
// a loose global: the file is rewritten from scratch on every autosave,
// so anything the model does not carry is destroyed the moment the user
// types. Widths, heights, frozen panes, hidden rows/cols, comments and
// the untouched xlsx parts all hang off the same entry, and a second
// sheet is just a second entry — add a FIELD here, not a new global.
//
// `activeSheet` is the entry the grid is currently showing. It is
// re-pointed in exactly one place (setActiveSheet), so the sheet tabs
// will have nothing new to wire up.

function newSheet( name )
{
    return {
        name       : name || 'Hoja1',
        data       : [ [ '' ] ],
        cellStyles : {},                 // { "A1": {bold,size,color,bg,align,…} }
        merges     : [],                 // [{row,col,rowspan,colspan}, …]
        cols       : [],                 // px widths,  sparse by column index
        rows       : [],                 // px heights, sparse by row index
        // The file's own units, kept so an untouched column is written back
        // byte-identical instead of drifting a little on every save. Cleared
        // for a column/row the moment the user drags its edge.
        colsSrc    : [],                 // Excel character widths
        rowsSrc    : [],                 // points
        autofilter : null,               // { ref } — the filter buttons' range
        margins    : null,               // page margins, for printing
        hidden     : 0,                  // 0 visible, 1 hidden, 2 very hidden
        freeze     : { rows: 0, cols: 0 },
        hiddenRows : [],
        hiddenCols : [],
        comments   : {},                 // { "A1": "text" }
        noteAuthors: null,               // { "note text": "author" } from the file (codec.js)
        links      : {},                 // { "A1": { target, tooltip } }
        unread     : false,              // the codec could not read it: it opened EMPTY (calc.js, loadSheet)
        raw        : null                // xlsx fragments Calc cannot model, kept verbatim
    };
}

function newDoc()
{
    return {
        sheets   : [ newSheet() ],
        active   : 0,
        names    : null,     // workbook-level defined names (cross-sheet ranges)
        lossy    : [],       // what THIS file has that a save would destroy
        lossyAck : false,    // the user chose "continue anyway" for this file
        csvOk    : null,     // ... or for this .csv path: what a .csv drops (calc.js, csvLosses)
        date1904 : false,    // the file counts its dates from 1904 (codec.js reads and writes it)
        srcZip   : null      // the bytes we opened, for the parts we cannot rebuild
    };
}

let doc         = newDoc();
let activeSheet = doc.sheets[ 0 ];

// True only while initGrid is drawing a sheet. Handsontable reports the work
// of loading a file — padding the grid out to minRows/minCols, attaching the
// notes a file carried — through the same hooks a real edit uses, and some of
// them (afterSetCellMeta) carry no `source` to tell the two apart. Without
// this, opening a file with a comment in it scheduled a save of that file.
let gridBooting = false;

function setActiveSheet( i )
{
    doc.active  = i;
    activeSheet = doc.sheets[ i ];
}

//------------------------------------------------------------------------//
// GRID

let lastSelection = null;   // {r1,c1,r2,c2} — captured on selection, since toolbar buttons steal focus

// Handsontable's theme class follows the shared colour scheme. The --ht-* variables in
// the stylesheet are wired to the app tokens for both classes; swapping the class here
// also lets HT's own light-dark() internals (scrollbars, menus) resolve to the right side.
function htThemeName()
{
    return document.documentElement.dataset.theme === 'light' ? 'ht-theme-main' : 'ht-theme-main-dark';
}

// Handsontable's free context menu is text-only. cmItem() wraps a menu entry in a
// renderer that keeps HT's own label — including the state-dependent ones (Merge /
// Unmerge, Freeze / Unfreeze, Add / Edit comment) — and just prefixes the matching
// glyph, drawn from the same icon vocabulary as the formatting toolbar. The paired
// CSS in the <style> block ('.cm-ico', plus the .htCustomMenuRenderer hover/cursor
// rules HT drops for custom-rendered items) finishes the look.
function cmIcon( body )
{
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
         + 'stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
}

const CM_ICONS =
{
    row_above       : cmIcon( '<path d="M4 20h16M4 15h16"/><path d="M12 3v7"/><path d="M8.5 6.5 12 3l3.5 3.5"/>' ),
    row_below       : cmIcon( '<path d="M4 4h16M4 9h16"/><path d="M12 21v-7"/><path d="M8.5 17.5 12 21l3.5-3.5"/>' ),
    col_left        : cmIcon( '<path d="M20 4v16M15 4v16"/><path d="M3 12h7"/><path d="M6.5 8.5 3 12l3.5 3.5"/>' ),
    col_right       : cmIcon( '<path d="M4 4v16M9 4v16"/><path d="M21 12h-7"/><path d="M17.5 8.5 21 12l-3.5 3.5"/>' ),
    remove_row      : cmIcon( '<path d="M3 12h5M16 12h5"/><path d="M9.5 9.5 14.5 14.5M14.5 9.5 9.5 14.5"/>' ),
    remove_col      : cmIcon( '<path d="M12 3v5M12 16v5"/><path d="M9.5 9.5 14.5 14.5M14.5 9.5 9.5 14.5"/>' ),
    mergeCells      : cmIcon( '<rect x="3" y="4" width="8" height="7"/><rect x="13" y="4" width="8" height="7"/><rect x="3" y="14" width="18" height="7"/>' ),
    undo            : cmIcon( '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12H8"/>' ),
    redo            : cmIcon( '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h6"/>' ),
    cut             : cmIcon( '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>' ),
    copy            : cmIcon( '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' ),
    commentsAddEdit : cmIcon( '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/>' ),
    commentsRemove  : cmIcon( '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9 10h6"/>' )
};

function cmItem( key )
{
    return {
        renderer : function( hot, wrapper, row, col, prop, itemValue )
        {
            // `ownerDoc`, not `doc` — the module's `doc` is the open workbook.
            const ownerDoc = wrapper.ownerDocument;
            const icon     = ownerDoc.createElement( 'span' );
            icon.className = 'cm-ico';
            icon.innerHTML = CM_ICONS[ key ] || '';

            wrapper.appendChild( icon );
            wrapper.appendChild( ownerDoc.createTextNode(
                typeof itemValue === 'string' ? itemValue : String( itemValue == null ? '' : itemValue ) ) );

            return wrapper;
        }
    };
}

//------------------------------------------------------------------------//
// SHEET TABS
//
// One Handsontable, several sheet entries: switching swaps what the grid is
// showing rather than building a second grid. The order below matters —
// HyperFormula is told which sheet it is writing into BEFORE the new data
// arrives, or loadData() pours this sheet's cells into the one just left.

function renderSheetTabs()
{
    const strip   = document.getElementById( 'sheetTabs' );
    const visible = doc.sheets.filter( function( sh ) { return ! sh.hidden; } );

    strip.hidden = visible.length < 2;      // a one-sheet file looks untouched
    strip.innerHTML = '';

    if( strip.hidden ) return;

    doc.sheets.forEach( function( sh, i )
    {
        if( sh.hidden ) return;

        const b = document.createElement( 'button' );
        b.type      = 'button';
        b.className = 'sheet-tab' + ( i === doc.active ? ' is-active' : '' );
        b.textContent = sh.name;
        b.title       = sh.name;
        b.setAttribute( 'role', 'tab' );
        b.setAttribute( 'aria-selected', i === doc.active ? 'true' : 'false' );
        b.addEventListener( 'click', function() { switchToSheet( i ); } );

        strip.appendChild( b );
    });
}

function switchToSheet( i )
{
    if( ! table || i === doc.active || ! doc.sheets[ i ] ) return;

    stashActiveSheet();          // the sheet being left keeps everything it had
    setActiveSheet( i );

    gridBooting  = true;         // redrawing is not editing
    removedStash = [];           // loadData wipes the undo history
    typedFormats = {};

    // The engine has to know the new sheet's name before its rows arrive.
    table.updateSettings( {
        formulas          : { sheetName: activeSheet.name },
        mergeCells        : activeSheet.merges,
        fixedRowsTop      : activeSheet.freeze.rows,
        fixedColumnsStart : activeSheet.freeze.cols
    } );

    table.loadData( activeSheet.data && activeSheet.data.length ? activeSheet.data : [ [ '' ] ] );

    // Notes go on AFTER the rows: loadData throws away all cell meta, so a
    // `cell:` passed with the settings above would be wiped a line later.
    Object.keys( activeSheet.comments ).forEach( function( addr )
    {
        const rc = decodeCell( addr );
        table.setCellMeta( rc.r, rc.c, 'comment', { value: activeSheet.comments[ addr ] } );
    });

    // The hidden lists are per sheet, and the plugins keep the ones from the
    // sheet we just left, so clear before applying.
    const hc = table.getPlugin( 'hiddenColumns' );
    const hr = table.getPlugin( 'hiddenRows' );
    hc.showColumns( hc.getHiddenColumns() || [] );
    hr.showRows(    hr.getHiddenRows()    || [] );
    if( activeSheet.hiddenCols.length ) hc.hideColumns( activeSheet.hiddenCols.slice() );
    if( activeSheet.hiddenRows.length ) hr.hideRows(    activeSheet.hiddenRows.slice() );

    lastSelection = null;
    table.render();
    table.selectCell( 0, 0 );

    gridBooting = false;

    renderSheetTabs();
    updateToolbarActiveState();
}

//------------------------------------------------------------------------//
// SORT
//
// Deliberately NOT Handsontable's columnSorting plugin. That one reorders
// the VIEW and leaves the source data alone, so a sheet sorted, saved and
// reopened comes back in its old order — the sort silently does not stick.
// This moves the rows themselves, and everything addressed by row number
// (styles, links, notes, heights, hidden flags) moves with them.
//
// Two things it refuses rather than get wrong: a range with merged cells,
// and a range with formulas — moving a row changes what =B2*2 points at,
// and rewriting formulas is a different and much larger job.

function lastUsedRow( data )
{
    for( let r = data.length - 1; r >= 0; r-- )
    {
        const row = data[ r ] || [];
        for( let c = 0; c < row.length; c++ )
            if( row[ c ] !== '' && row[ c ] !== null && row[ c ] !== undefined ) return r;
    }
    return -1;
}

function sortByColumn( descending )
{
    if( ! lastSelection || ! table ) return;

    const data = table.getSourceData();
    const col  = lastSelection.c1;

    // A selection of several rows sorts exactly those. A single cell sorts
    // the whole column below row 1, keeping row 0 as the header.
    const multi = lastSelection.r2 > lastSelection.r1;
    const first = multi ? lastSelection.r1 : 1;
    const last  = multi ? lastSelection.r2 : lastUsedRow( data );

    if( last <= first ) return;

    const touchesMerge = activeSheet.merges.some( function( m )
    {
        return m.row <= last && ( m.row + m.rowspan - 1 ) >= first;
    });
    if( touchesMerge ) { NayiveUI.toast( T( 'calc.sortMerged' ) ); return; }

    for( let r = first; r <= last; r++ )
    {
        const row = data[ r ] || [];
        for( let c = 0; c < row.length; c++ )
            if( typeof row[ c ] === 'string' && row[ c ].charAt( 0 ) === '=' )
            { NayiveUI.toast( T( 'calc.sortFormulas' ) ); return; }
    }

    const order = [];
    for( let r = first; r <= last; r++ ) order.push( r );

    const blank = function( v ) { return v === '' || v === null || v === undefined; };

    // Array.prototype.sort is stable, so equal keys keep their old order.
    order.sort( function( ra, rb )
    {
        const a = ( data[ ra ] || [] )[ col ];
        const b = ( data[ rb ] || [] )[ col ];

        if( blank( a ) && blank( b ) ) return 0;
        if( blank( a ) ) return 1;        // blanks sink, whichever way we sort
        if( blank( b ) ) return -1;

        const na = ( typeof a === 'number' ) ? a : Number( a );
        const nb = ( typeof b === 'number' ) ? b : Number( b );
        const aNum = typeof a !== 'boolean' && isFinite( na ) && String( a ).trim() !== '';
        const bNum = typeof b !== 'boolean' && isFinite( nb ) && String( b ).trim() !== '';

        let cmp;
        if( aNum && bNum )      cmp = na - nb;
        else if( aNum )         cmp = -1;                       // numbers before text
        else if( bNum )         cmp = 1;
        else                    cmp = String( a ).localeCompare( String( b ), NayiveI18n.locale() );

        return descending ? -cmp : cmp;
    } );

    applyRowOrder( first, last, order );
}

// Rewrite rows `first`..`last` in the order given, carrying everything that
// is keyed by row number along with them.
function applyRowOrder( first, last, order )
{
    const data = table.getSourceData();

    // old row -> new row
    const moveTo = {};
    order.forEach( function( oldRow, i ) { moveTo[ oldRow ] = first + i; } );

    const rows = data.map( function( row ) { return row.slice(); } );
    order.forEach( function( oldRow, i ) { rows[ first + i ] = ( data[ oldRow ] || [] ).slice(); } );

    // Styles are addressed "A7", so each one in range moves to its row's
    // new address. Built fresh so nothing is overwritten mid-move.
    const styles = {};
    Object.keys( activeSheet.cellStyles ).forEach( function( addr )
    {
        const rc = decodeCell( addr );
        const to = ( rc.r >= first && rc.r <= last ) ? moveTo[ rc.r ] : rc.r;
        styles[ encodeCell( { r: to, c: rc.c } ) ] = activeSheet.cellStyles[ addr ];
    });
    activeSheet.cellStyles = styles;

    // Links are addressed the same way, and belong to the row's text.
    const links = {};
    Object.keys( activeSheet.links ).forEach( function( addr )
    {
        const rc = decodeCell( addr );
        const to = ( rc.r >= first && rc.r <= last ) ? moveTo[ rc.r ] : rc.r;
        links[ encodeCell( { r: to, c: rc.c } ) ] = activeSheet.links[ addr ];
    });
    activeSheet.links = links;

    // Notes live in cell meta while the sheet is on screen, so they are read
    // from there rather than from the last stash.
    const notes = {};
    ( table.getCellsMeta() || [] ).forEach( function( meta )
    {
        if( ! meta || ! meta.comment || ! meta.comment.value ) return;
        const to = ( meta.row >= first && meta.row <= last ) ? moveTo[ meta.row ] : meta.row;
        notes[ encodeCell( { r: to, c: meta.col } ) ] = meta.comment.value;
    });
    activeSheet.comments = notes;

    const heights = [], heightsSrc = [], hidden = [];
    activeSheet.rows.forEach( function( px, r )
    {
        if( px != null ) heights[ ( r >= first && r <= last ) ? moveTo[ r ] : r ] = px;
    });
    activeSheet.rowsSrc.forEach( function( pt, r )
    {
        if( pt != null ) heightsSrc[ ( r >= first && r <= last ) ? moveTo[ r ] : r ] = pt;
    });
    ( table.getPlugin( 'hiddenRows' ).getHiddenRows() || [] ).forEach( function( r )
    {
        hidden.push( ( r >= first && r <= last ) ? moveTo[ r ] : r );
    });

    activeSheet.rows       = heights;
    activeSheet.rowsSrc    = heightsSrc;
    activeSheet.hiddenRows = hidden;

    // loadData shows every column again: read the hidden ones off the plugin
    // (the sheet entry only catches up at the next stash) and hide them after.
    const hiddenCols = ( table.getPlugin( 'hiddenColumns' ).getHiddenColumns() || [] ).slice();

    gridBooting  = true;                 // redrawing is not editing
    removedStash = [];                   // loadData wipes the undo history
    typedFormats = {};

    table.loadData( rows );

    Object.keys( activeSheet.comments ).forEach( function( addr )
    {
        const rc = decodeCell( addr );
        table.setCellMeta( rc.r, rc.c, 'comment', { value: activeSheet.comments[ addr ] } );
    });

    const hr = table.getPlugin( 'hiddenRows' );
    hr.showRows( hr.getHiddenRows() || [] );
    if( hidden.length ) hr.hideRows( hidden.slice() );

    const hc = table.getPlugin( 'hiddenColumns' );
    hc.showColumns( hc.getHiddenColumns() || [] );
    if( hiddenCols.length ) hc.hideColumns( hiddenCols );
    activeSheet.hiddenCols = hiddenCols;

    table.render();

    gridBooting = false;

    // loadData is not an undoable edit, so the save has to be asked for.
    scheduleAutosave();
}

//------------------------------------------------------------------------//
// INSERTED AND REMOVED ROWS AND COLUMNS
//
// Handsontable moves the cells, their notes (cell meta), the hidden flags
// and its own copy of the merges. Everything else addressed by row or
// column number is this app's, and moves here, from the four hooks in
// initGrid: the styles and links ("B7"), the widths and heights, the merge
// list the file is written from, the filter buttons' range, and the ranges
// of the conditional formats and validations kept verbatim from the file -
// with the cell references in their rules, as Excel moves them. Left
// alone, the look of row 7 stayed on row 7 when a row went in above it,
// and was saved so.
//
// A removal keeps what it took: Handsontable's undo puts the rows back,
// and their styles, links and sizes come back with them.

const REMOVED_KEEP = 100;   // removals remembered for undo
let removedStash   = [];    // [{ axis, at, n, styles, links, sizes, sizesSrc, merges, raw, autofilter }]

// Where row/column i ends up when n of them go in at `at` (n > 0) or come
// out from there (n < 0); -1 = it was one of those removed.
function shiftIndex( i, at, n )
{
    if( i < at ) return i;
    if( n > 0 )  return i + n;
    return i < at - n ? -1 : i + n;
}

// A run lo..hi after the same move, or null when none of it is left. A run
// the insertion falls inside grows, and a removal inside it shrinks it.
function shiftSpan( lo, hi, at, n )
{
    if( n > 0 ) return [ lo >= at ? lo + n : lo, hi >= at ? hi + n : hi ];

    const end = at - n;                     // the first index after the removed ones
    const a   = lo < at ? lo : ( lo < end ? at     : lo + n );
    const b   = hi < at ? hi : ( hi < end ? at - 1 : hi + n );
    return b < a ? null : [ a, b ];
}

// "$C$8" -> its parts, or null for anything that is not one cell.
function parseRef( text )
{
    const m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)$/.exec( text );
    if( ! m ) return null;

    const rc = decodeCell( m[ 2 ] + m[ 4 ] );
    if( ! ( rc.c >= 0 && rc.c < 16384 && rc.r >= 0 ) ) return null;     // "TAX2020" is a name
    return { r: rc.r, c: rc.c, colAbs: m[ 1 ], rowAbs: m[ 3 ] };
}

function refText( p )
{
    return p.colAbs + colLetters( p.c ) + p.rowAbs + ( p.r + 1 );
}

// "B3", "$B$3" or "B3:D9" after the move, the "$" kept; null = all of it
// was removed. Anything else (a whole column, a name) is left as it is.
function shiftRef( text, axis, at, n )
{
    const parts = text.split( ':' );
    if( parts.length > 2 ) return text;

    const a = parseRef( parts[ 0 ] );
    const b = parts.length === 2 ? parseRef( parts[ 1 ] ) : a;
    if( ! a || ! b ) return text;

    const k    = axis === 'row' ? 'r' : 'c';
    const flip = a[ k ] > b[ k ];
    const span = shiftSpan( Math.min( a[ k ], b[ k ] ), Math.max( a[ k ], b[ k ] ), at, n );
    if( ! span ) return null;

    const a2 = Object.assign( {}, a ), b2 = Object.assign( {}, b );
    a2[ k ] = flip ? span[ 1 ] : span[ 0 ];
    b2[ k ] = flip ? span[ 0 ] : span[ 1 ];

    return parts.length === 2 ? refText( a2 ) + ':' + refText( b2 ) : refText( a2 );
}

// Every reference to this sheet in a rule's formula, moved; one whose cells
// were all removed becomes #REF!, as in Excel. Text in quotes and
// references to another sheet are left alone. Works on the XML text as it
// is, so a quote may also be written &quot;.
const FORMULA_REF = /("(?:[^"]|"")*"|&quot;(?:(?!&quot;)[\s\S])*&quot;)|((?:'[^']*'|[A-Za-z_][\w.]*)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)(?![\w(!])/g;

function shiftFormulaRefs( f, axis, at, n )
{
    return f.replace( FORMULA_REF, function( all, quoted, sheet, ref, off, whole )
    {
        if( quoted || sheet ) return all;
        if( /[\w.$]/.test( whole.charAt( off - 1 ) ) ) return all;     // the tail of a longer name

        const moved = shiftRef( ref, axis, at, n );
        return moved === null ? '#REF!' : moved;
    } );
}

// The conditional formats / validations kept verbatim (sheet.raw): every
// sqref and every formula in them. A block left with no cells goes.
function shiftRawXml( xml, axis, at, n )
{
    if( ! xml ) return xml;

    let out = xml.replace( /(\bsqref=")([^"]*)(")/g, function( all, open, list, close )
    {
        const kept = list.split( /\s+/ ).filter( Boolean )
                         .map( function( r ) { return shiftRef( r, axis, at, n ); } )
                         .filter( function( r ) { return r !== null; } );
        return open + kept.join( ' ' ) + close;
    } );

    out = out.replace( /(<(formula|formula1|formula2)>)([\s\S]*?)(<\/\2>)/g, function( all, open, tag, body, close )
    {
        return open + shiftFormulaRefs( body, axis, at, n ) + close;
    } );

    out = out.replace( /<conditionalFormatting\b[^>]*\bsqref=""[^>]*>[\s\S]*?<\/conditionalFormatting>/g, '' );
    out = out.replace( /<dataValidation\b[^>]*\bsqref=""[^>]*?(?:\/>|>[\s\S]*?<\/dataValidation>)/g, '' );

    // <dataValidations count="N"> has to agree with what is left in it.
    if( out.indexOf( '<dataValidations' ) !== -1 )
    {
        const k = ( out.match( /<dataValidation\b/g ) || [] ).length;
        out = k ? out.replace( /(<dataValidations\b[^>]*\bcount=")\d+(")/, '$1' + k + '$2' ) : '';
    }

    return out;
}

// A "B7"-keyed map after the move; what was removed goes into `taken`.
function shiftAddrMap( map, axis, at, n, taken )
{
    const out = {};

    Object.keys( map ).forEach( function( addr )
    {
        const rc = decodeCell( addr );
        const i  = shiftIndex( axis === 'row' ? rc.r : rc.c, at, n );

        if( i < 0 ) { taken[ addr ] = map[ addr ]; return; }
        out[ encodeCell( axis === 'row' ? { r: i, c: rc.c } : { r: rc.r, c: i } ) ] = map[ addr ];
    });

    return out;
}

// A sparse width/height array after the move.
function shiftSizes( list, at, n, taken )
{
    const out = [];

    list.forEach( function( v, k )
    {
        if( v == null ) return;

        const i = shiftIndex( k, at, n );
        if( i < 0 ) taken[ k ] = v;
        else        out[ i ] = v;
    });

    return out;
}

// The merges, moved the way Handsontable moves its own copy (MergedCellCoords
// .shift), so the file and the screen agree. One left a single cell is no merge.
function shiftMerges( list, axis, at, n )
{
    const pos  = axis === 'row' ? 'row'     : 'col';
    const len  = axis === 'row' ? 'rowspan' : 'colspan';
    const out  = [];

    list.forEach( function( m )
    {
        const span = shiftSpan( m[ pos ], m[ pos ] + m[ len ] - 1, at, n );
        if( ! span ) return;

        const e = { row: m.row, col: m.col, rowspan: m.rowspan, colspan: m.colspan };
        e[ pos ] = span[ 0 ];
        e[ len ] = span[ 1 ] - span[ 0 ] + 1;
        if( e.rowspan > 1 || e.colspan > 1 ) out.push( e );
    });

    return out;
}

// The one place a structural edit reaches the sheet entry: `n` rows or
// columns (axis 'row' / 'col') went in at `at` (n > 0) or came out (n < 0).
function moveRowsOrCols( axis, at, n, source )
{
    const sizesKey = axis === 'row' ? 'rows'    : 'cols';
    const srcKey   = axis === 'row' ? 'rowsSrc' : 'colsSrc';
    const raw      = activeSheet.raw;
    const taken    = { axis: axis, at: at, n: -n, styles: {}, links: {}, sizes: {}, sizesSrc: {},
                       merges:     activeSheet.merges,
                       raw:        raw ? { cf: raw.cf, dv: raw.dv } : null,
                       autofilter: activeSheet.autofilter };

    activeSheet.cellStyles  = shiftAddrMap( activeSheet.cellStyles, axis, at, n, taken.styles );
    activeSheet.links       = shiftAddrMap( activeSheet.links,      axis, at, n, taken.links );
    activeSheet[ sizesKey ] = shiftSizes( activeSheet[ sizesKey ], at, n, taken.sizes );
    activeSheet[ srcKey ]   = shiftSizes( activeSheet[ srcKey ],   at, n, taken.sizesSrc );
    activeSheet.merges      = shiftMerges( activeSheet.merges, axis, at, n );

    if( raw ) { raw.cf = shiftRawXml( raw.cf, axis, at, n ); raw.dv = shiftRawXml( raw.dv, axis, at, n ); }

    if( activeSheet.autofilter && activeSheet.autofilter.ref )
    {
        const ref = shiftRef( activeSheet.autofilter.ref, axis, at, n );
        activeSheet.autofilter = ref ? Object.assign( {}, activeSheet.autofilter, { ref: ref } ) : null;
    }

    if( n < 0 )
    {
        if( source === 'UndoRedo.undo' ) return;     // the undo of an insert: nothing to give back later
        removedStash.push( taken );
        if( removedStash.length > REMOVED_KEEP ) removedStash.shift();
        return;
    }

    // Undo of a removal: the same rows are back where they were, so what
    // they took goes back on them. What is not keyed by one cell - the
    // merges, the kept ranges, the filter - is put back as it was: nothing
    // else can change those between a removal and its undo.
    if( source !== 'UndoRedo.undo' ) return;

    for( let i = removedStash.length - 1; i >= 0; i-- )
    {
        const s = removedStash[ i ];
        if( s.axis !== axis || s.at !== at || s.n !== n ) continue;

        removedStash.splice( i, 1 );

        Object.assign( activeSheet.cellStyles, s.styles );
        Object.assign( activeSheet.links,      s.links );
        Object.keys( s.sizes    ).forEach( function( k ) { activeSheet[ sizesKey ][ k ] = s.sizes[ k ]; } );
        Object.keys( s.sizesSrc ).forEach( function( k ) { activeSheet[ srcKey ][ k ]   = s.sizesSrc[ k ]; } );
        activeSheet.merges     = s.merges;
        activeSheet.autofilter = s.autofilter;
        if( raw && s.raw ) { raw.cf = s.raw.cf; raw.dv = s.raw.dv; }
        return;
    }
}

//------------------------------------------------------------------------//
// TYPED NUMBERS AND DATES
//
// The cell editor hands back text, always: "12" arrived as the string "12".
// The formula engine read it as a number, so the sheet looked right, but it
// was saved as text - Excel's SUM skipped it and no number format applied.
// What is typed or pasted is stored as what it is:
//   - a number: "12", "-7", "1,5e-7", and a decimal written with the
//     interface language's own mark ("3.5" in English, "3,5" in Spanish).
//     Text it stays when a number would change it: a leading zero ("08001"
//     is a postcode), a "+" ("+34600123456" is a phone), more than 15
//     digits (an account number - a number keeps only 15), and a cell
//     formatted as text ("@");
//   - a date written yyyy-mm-dd: its serial number, shown yyyy-mm-dd unless
//     the cell already has a date format - as a date read from a file.
// A leading apostrophe says "this is text", as in Excel: '123 is stored as
// the text 123, and F2 or the formula bar show it with the apostrophe again
// so it stays text when it goes back. ('= is left as it is: codec.js keeps
// text that begins with "=" that way.) Ctrl+Z takes back a date's format
// with the date.

function decimalComma()
{
    const m = numberMarks();
    return !! m && m.dec === ',';
}

//------------------------------------------------------------------------//
// NUMBERS ON SCREEN
//
// A number is stored as a number; it is SHOWN with the interface language's
// own marks - "3,5" and "1.234,50" in Spanish, "3.5" and "1,234.50" in
// English - in the grid, in the cell editor and the formula bar (so what is
// edited comes back as a number, see TYPED NUMBERS AND DATES), in the
// formula editor's answer and in the number-format preview. Formulas keep
// the engine's own syntax, with "." whatever the language. The file format
// library only knows the English marks, so its output is translated here.
// A plain number shows at most 15 significant digits, as in Excel: 0.1+0.2
// is 0.3, not 0.30000000000000004.

let marksFor = null;     // the locale numberMarks() last looked at
let marks    = null;     // its { dec, group }, or null where they are "." and ","

function numberMarks()
{
    const loc = NayiveI18n.locale();
    if( loc === marksFor ) return marks;

    let dec = '.', group = ',';
    try
    {
        new Intl.NumberFormat( loc ).formatToParts( 12345.6 ).forEach( function( p )
        {
            if( p.type === 'decimal' ) dec   = p.value;
            if( p.type === 'group' )   group = p.value;
        });
    }
    catch( _ ) {}

    marksFor = loc;
    marks    = ( dec === '.' && group === ',' ) ? null : { dec: dec, group: group };
    return marks;
}

// A date or time format shows no decimal mark to translate ("dd.mm.yyyy"
// keeps its dots): what is left of the code once the quoted text, [colours]
// and escaped characters are out still has a y, m, d, h or s in it.
function isDateFormat( fmt )
{
    const f = String( fmt ).replace( /"[^"]*"/g, '' ).replace( /\[[^\]]*\]/g, '' ).replace( /[\\_*]./g, '' );
    return /[ymdhs]/i.test( f.replace( /general/ig, '' ) );
}

// The marks of a number the library formatted the English way, swapped for
// the language's. Only a mark with a digit after it is one.
function localMarks( text, fmt )
{
    const m = numberMarks();
    if( ! m || ( fmt && isDateFormat( fmt ) ) ) return text;

    return String( text ).replace( /[.,](?=\d)/g, function( ch ) { return ch === '.' ? m.dec : m.group; } );
}

// A number as the grid shows it: through its number format, or plain - a
// whole number exactly, a fraction without the float noise.
function showNumber( v, fmt )
{
    if( fmt )
    {
        try { return localMarks( formatNumber( fmt, v, { date1904: !! doc.date1904 } ), fmt ); }
        catch( _ ) { /* a format the library cannot read: shown plain */ }
    }

    return editNumber( Number.isInteger( v ) ? v : Number( v.toPrecision( 15 ) ) );
}

// A number as it is edited: every digit it has, the language's decimal mark
// and no thousands - "1234,5" or "1,5e-7", which typedValues reads back.
function editNumber( v )
{
    const m = numberMarks();
    const s = String( v );
    return m ? s.replace( '.', m.dec ) : s;
}

// What a cell holds, written the way it is edited: a number with the
// language's marks, and text that would be read back as a number or a date
// with the apostrophe that keeps it text. The formula bar shows the same.
function editText( v, r, c )
{
    if( typeof v === 'number' ) return editNumber( v );
    if( v === null || v === undefined ) return '';

    // A leading apostrophe of its own needs one more ('=, see codec.js, does not).
    const s     = String( v );
    const quote = ( s.charAt( 0 ) === "'" && s.charAt( 1 ) !== '=' ) ||
                  !! typedValue( s, activeSheet.cellStyles[ encodeCell( { r: r, c: c } ) ] );
    return quote ? "'" + s : s;
}

// F2, Enter or a double-click put the cell's own value in the editor
// (typing into it starts from nothing): it goes in the way it is edited.
function editorShowsNumber()
{
    const ed = table && table.getActiveEditor();
    if( ! ed || ! ed.TEXTAREA || ! ed.isInFullEditMode() ) return;

    const v = table.getSourceDataAtCell( ed.row, ed.col );
    if( v !== null && v !== undefined && ed.TEXTAREA.value === String( v ) ) ed.TEXTAREA.value = editText( v, ed.row, ed.col );
}

// A copy or a cut carries numbers the way they are edited too, so a paste
// here reads them back as numbers - and one into another program in the
// same language does as well.
function copiedNumbers( data )
{
    if( ! numberMarks() || ! data ) return;

    data.forEach( function( row )
    {
        if( row ) row.forEach( function( v, i ) { if( typeof v === 'number' && isFinite( v ) ) row[ i ] = editNumber( v ); } );
    });
}

// Excel's serial number for a day: days since 1899-12-30, or since 1904-01-01
// in a workbook on the 1904 system. null = no such day, or one before either.
function dateSerial( y, mo, d )
{
    const t    = Date.UTC( y, mo - 1, d );
    const back = new Date( t );
    if( back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d ) return null;

    const n = Math.round( ( t - ( doc.date1904 ? Date.UTC( 1904, 0, 1 ) : Date.UTC( 1899, 11, 30 ) ) ) / 86400000 );
    return n < ( doc.date1904 ? 0 : 1 ) ? null : n;
}

// The number or date typed text stands for: { value } or { value, date: true },
// null when it is to stay text (see TYPED NUMBERS AND DATES).
function typedValue( s, style )
{
    if( style && style.numFmt === '@' ) return null;

    const text = s.trim();

    let m = /^(-?)(\d+)(?:([.,])(\d+))?(?:[eE]([-+]?\d+))?$/.exec( text );
    if( m )
    {
        // Only the language's own decimal mark: "1,000" in English and
        // "1.500" in Spanish are thousands, not 1 and 1.5 - left as text.
        if( m[ 3 ] && ( m[ 3 ] === ',' ) !== decimalComma() ) return null;
        if( m[ 2 ].length > 1 && m[ 2 ].charAt( 0 ) === '0' ) return null;
        if( m[ 2 ].length + ( m[ 4 ] || '' ).length > 15 )    return null;

        const n = Number( m[ 1 ] + m[ 2 ] + ( m[ 4 ] ? '.' + m[ 4 ] : '' ) + ( m[ 5 ] ? 'e' + m[ 5 ] : '' ) );
        return isFinite( n ) ? { value: n } : null;
    }

    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec( text );
    if( m )
    {
        const n = dateSerial( +m[ 1 ], +m[ 2 ], +m[ 3 ] );
        return n === null ? null : { value: n, date: true };
    }

    return null;
}

// The date formats typing put on a cell, so Ctrl+Z can take them back:
// { "B7": { value, was, set } } - the serial, the format before, the one set.
let typedFormats = {};

// beforeChange: only what the user typed, pasted or dragged in. An undo puts
// back what was there, and loading a file is not typing.
function typedValues( changes, source )
{
    if( [ 'edit', 'CopyPaste.paste', 'Autofill.fill', 'autofill.fill' ].indexOf( source ) === -1 ) return;
    if( ! changes ) return;

    changes.forEach( function( ch )
    {
        if( ! ch || typeof ch[ 3 ] !== 'string' || typeof ch[ 1 ] !== 'number' ) return;

        // '08001: the text 08001. ('= stays: codec.js reads it as text.)
        if( ch[ 3 ].charAt( 0 ) === "'" && ch[ 3 ].charAt( 1 ) !== '=' ) { ch[ 3 ] = ch[ 3 ].slice( 1 ); return; }

        const addr  = encodeCell( { r: ch[ 0 ], c: ch[ 1 ] } );
        const style = activeSheet.cellStyles[ addr ];
        const got   = typedValue( ch[ 3 ], style );
        if( ! got ) return;

        ch[ 3 ] = got.value;

        // A date shows as one: in its own date format if the cell has one,
        // else yyyy-mm-dd - over a currency or number format too, as in Excel.
        if( got.date && ! ( style && style.numFmt && isDateFormat( style.numFmt ) ) )
        {
            typedFormats[ addr ] = { value: got.value, was: style ? style.numFmt : undefined, set: 'yyyy-mm-dd' };
            activeSheet.cellStyles[ addr ] = Object.assign( {}, style, { numFmt: 'yyyy-mm-dd' } );
        }
    });
}

// afterUndo / afterRedo: a date's format goes and comes back with the edit
// that typed it - and only that edit, while the cell still has that format.
function undoTypedFormats( action, redo )
{
    if( ! action || action.actionType !== 'change' || ! action.changes ) return;

    action.changes.forEach( function( ch )
    {
        const addr = encodeCell( { r: ch[ 0 ], c: ch[ 1 ] } );
        const t    = typedFormats[ addr ];
        if( ! t || ch[ 3 ] !== t.value ) return;

        const style = activeSheet.cellStyles[ addr ];

        if( ! redo && style && style.numFmt === t.set )
        {
            if( t.was === undefined ) delete style.numFmt;
            else                      style.numFmt = t.was;
            if( ! Object.keys( style ).length ) delete activeSheet.cellStyles[ addr ];
        }
        if( redo && ( ! style || style.numFmt === t.was ) )
            activeSheet.cellStyles[ addr ] = Object.assign( {}, style, { numFmt: t.set } );
    });

    table.render();
}

// One step on Handsontable's own Ctrl+Z / Ctrl+Y lists for a change it does
// not make itself (a note deleted, formats cleared): `back` undoes it, `again`
// does it once more. In the plugin's lists, so Ctrl+Z walks back through the
// cell edits and these in order; loadData (a sort, another sheet) clears them.
// done() is called whatever happens - until it is, the plugin takes no more.
function undoStep( back, again )
{
    const ur = table && table.getPlugin( 'undoRedo' );
    if( ! ur || ! ur.isEnabled() ) return;

    ur.done( function()
    {
        return {
            actionType : 'nayive',
            undo       : function( hot, done ) { try { back();  hot.render(); updateToolbarActiveState(); } finally { done(); } },
            redo       : function( hot, done ) { try { again(); hot.render(); updateToolbarActiveState(); } finally { done(); } }
        };
    } );
}

// Right-click "Delete note": what Handsontable's own item does (every note in
// the selection goes), plus a Ctrl+Z step that puts them back - its own has none.
function removeNotes()
{
    const range = table.getSelectedRangeActive();
    if( ! range ) return;

    const comments = table.getPlugin( 'comments' );
    const gone     = [];

    range.forAll( function( r, c )
    {
        if( r < 0 || c < 0 ) return;
        const meta = table.getCellMeta( r, c ).comment;
        if( meta ) gone.push( { r: r, c: c, meta: Object.assign( {}, meta ) } );
        comments.removeCommentAtCell( r, c, false );
    } );
    table.render();

    if( gone.length ) undoStep(
        function() { gone.forEach( function( n ) { table.setCellMeta( n.r, n.c, 'comment', Object.assign( {}, n.meta ) ); } ); },
        function() { gone.forEach( function( n ) { comments.removeCommentAtCell( n.r, n.c, false ); } ); } );
}

// The active sheet's notes, in the shape Handsontable's `cell` setting wants.
function commentCells()
{
    return Object.keys( activeSheet.comments ).map( function( addr )
    {
        const rc = decodeCell( addr );
        return { row: rc.r, col: rc.c, comment: { value: activeSheet.comments[ addr ] } };
    } );
}

// Draw the workbook `d` (see THE OPEN WORKBOOK above). Everything the grid
// needs now comes off the active sheet entry, so the sheet tabs will call
// this with a different `active` and nothing else changes.
function initGrid( d )
{
    hideFormulaPanel();          // the cell editor it follows goes with the old grid
    if( table ) table.destroy();

    gridBooting = true;

    doc = d || newDoc();
    setActiveSheet( Math.min( doc.active || 0, doc.sheets.length - 1 ) );

    const el = document.getElementById( 'gridHost' );
    el.innerHTML = '';
    el.className = htThemeName();

    lastSelection = null;
    point         = null;
    removedStash  = [];      // a new grid starts a new undo history
    typedFormats  = {};

    table = new Handsontable( el,
    {
        licenseKey  : 'non-commercial-and-evaluation',
        themeName   : htThemeName(),
        language    : HT_LOCALE,   // registered at load by registerUiLocale()
        data        : ( activeSheet.data && activeSheet.data.length ) ? activeSheet.data : [[ '' ]],
        minRows     : 100,
        minCols     : 26,
        rowHeaders  : true,
        colHeaders  : true,
        // 'alignment' is deliberately excluded: it writes Handsontable's own className,
        // not the `activeSheet.cellStyles` map this app tracks, so it would look applied but vanish
        // on save/reopen — the toolbar's align buttons are the persisted path instead.
        // 'borders' and 'paste' were dropped: HT18 has no predefined 'paste' item and
        // the CustomBorders plugin isn't enabled (calc has its own border picker), so
        // both rendered as dead, un-actioned rows. Object form + cmItem() so every
        // remaining entry carries an icon (see CM_ICONS above).
        // No Freeze / Unfreeze column here, nor the manualColumnFreeze plugin
        // behind them: that plugin MOVES the column to the frozen edge, and
        // styles, widths, links and notes are all keyed by position, so the
        // file came back with the wrong column frozen and everything beside it
        // shifted. The toolbar's freeze (toggleFreezeColumns) only moves the
        // edge. It also keeps a column's place on screen = its place in the
        // file, which the row/column hooks below rely on.
        contextMenu : { items : {
                         row_above       : cmItem( 'row_above' ),
                         row_below       : cmItem( 'row_below' ),
                         col_left        : cmItem( 'col_left' ),
                         col_right       : cmItem( 'col_right' ),
                         sep1            : '---------',
                         remove_row      : cmItem( 'remove_row' ),
                         remove_col      : cmItem( 'remove_col' ),
                         sep2            : '---------',
                         mergeCells      : cmItem( 'mergeCells' ),
                         sep3            : '---------',
                         undo            : cmItem( 'undo' ),
                         redo            : cmItem( 'redo' ),
                         sep4            : '---------',
                         cut             : cmItem( 'cut' ),
                         copy            : cmItem( 'copy' ),
                         sep6            : '---------',
                         commentsAddEdit : cmItem( 'commentsAddEdit' ),
                         commentsRemove  : Object.assign( cmItem( 'commentsRemove' ), { callback: removeNotes } )
                        } },
        comments    : true,
        // Keep the selection (and its green highlight) visible while the user works
        // the external toolbar / border popup — otherwise clicking any control blurs it.
        outsideClickDeselects: false,
        manualColumnResize: true,
        manualRowResize   : true,
        // Widths/heights come off the sheet entry, so a file opens at the
        // size it was saved at instead of a flat 100px everywhere. Functions
        // rather than arrays: a sheet is 26+ columns wide and only a few of
        // them carry a stored width.
        colWidths   : function( i ) { return activeSheet.cols[ i ] || DEFAULT_COL_PX; },
        rowHeights  : function( r ) { return activeSheet.rows[ r ] || undefined; },
        fixedRowsTop      : activeSheet.freeze.rows,
        fixedColumnsStart : activeSheet.freeze.cols,
        // Empty on purpose — the real lists are applied after construction,
        // see below. Both keys still have to be here to switch the plugins on.
        hiddenColumns     : { columns: [], indicators: true },
        hiddenRows        : { rows:    [], indicators: true },
        // The comments plugin reads its text out of per-cell meta, so the
        // notes the file carried are handed over as the initial meta.
        cell        : commentCells(),
        mergeCells  : activeSheet.merges,
        renderer    : styledRenderer,
        // The engine's sheet carries the real name, so a formula written as
        // ='Ventas'!B2 matches whichever sheet is on the grid. A workbook that
        // counts its dates from 1904 has the engine count from there too, or
        // DATE(), YEAR() and friends would be four years out.
        formulas    : { engine: doc.date1904 ? { hyperformula: HyperFormula, nullDate: { year: 1904, month: 1, day: 1 } }
                                             : HyperFormula,
                        sheetName: activeSheet.name || 'Hoja1' },
        width       : '100%',
        height      : '100%',
        // The cell's look is this app's, not Handsontable's - see CLIPBOARD
        // STYLES below.
        beforeCopy        : copiedNumbers,
        beforeCut         : copiedNumbers,
        afterCopy         : stashClipStyles,
        afterCut          : cutClipStyles,
        afterPaste        : applyClipStyles,
        // A number or date typed as text is stored as one (see TYPED
        // NUMBERS AND DATES above).
        beforeChange      : typedValues,
        // The formula bar follows the cell under the cursor even when the
        // cursor does not move: undo, redo, paste, fill and fx all change
        // it in place.
        afterChange       : function( changes, source )
                            {
                                refreshFormulaBar();
                                if( source !== 'loadData' && source !== 'updateData' ) scheduleAutosave();
                            },
        // Phone: the cell editor opening is the on-screen keyboard
        // arriving — give the grid the toolbar's 159px back. Selecting
        // a cell does NOT fold it, so formatting a selection stays one
        // tap. "Aa" in the header brings it back.
        afterBeginEditing : function() { if( PHONE.matches && fold.isOpen() ) fold.setOpen( false ); editorShowsNumber(); pointEditorOpened(); mirrorEditorToBar(); syncFormulaPanel(); },
        // A formula being typed takes clicks, drags and arrow keys as
        // references to other cells (see POINTING below).
        beforeOnCellMouseDown : pointMouseDown,
        beforeOnCellMouseOver : pointMouseOver,
        beforeKeyDown         : pointKeyDown,
        // `source` matters here exactly as it does in afterChange above.
        // Handsontable pads a freshly loaded sheet up to minRows/minCols and
        // reports those as real row/col insertions with source 'auto' — so an
        // unguarded hook scheduled an autosave the moment ANY file smaller than
        // 100x26 was opened, and Calc rewrote it 2.5s later with nobody having
        // typed a thing. Every save-time loss (other sheets, column widths,
        // charts…) therefore fired on mere OPEN. A real insert — the toolbar's
        // alter() calls and the context menu alike — carries no source at all.
        // What is keyed by row or column number moves with the cells (see
        // INSERTED AND REMOVED ROWS AND COLUMNS) - padding is not an insert.
        afterCreateRow    : function( i, n, source ) { if( source !== 'auto' ) { moveRowsOrCols( 'row', i,  n, source ); scheduleAutosave(); } },
        afterRemoveRow    : function( i, n, rows, source ) { moveRowsOrCols( 'row', i, -n, source ); scheduleAutosave(); },
        afterCreateCol    : function( i, n, source ) { if( source !== 'auto' ) { moveRowsOrCols( 'col', i,  n, source ); scheduleAutosave(); } },
        afterRemoveCol    : function( i, n, cols, source ) { moveRowsOrCols( 'col', i, -n, source ); scheduleAutosave(); },
        afterUndo         : function( action ) { undoTypedFormats( action, false ); scheduleAutosave(); },
        afterRedo         : function( action ) { undoTypedFormats( action, true );  scheduleAutosave(); },
        // A dragged column edge is a real edit now that widths are saved.
        // Writing or clearing a note only ever touches cell meta — without this
        // a comment could be typed and would never reach the file.
        afterSetCellMeta  : function( row, col, key ) { if( key === 'comment' ) scheduleAutosave(); },
        afterOnCellMouseDown : function( event, coords ) { if( coords && coords.row >= 0 && coords.col >= 0 ) followLinkAt( coords.row, coords.col, event ); },
        afterColumnResize : function( newSize, column ) { activeSheet.cols[ column ] = newSize; activeSheet.colsSrc[ column ] = null; scheduleAutosave(); },
        afterRowResize    : function( newSize, row    ) { activeSheet.rows[ row ]    = newSize; activeSheet.rowsSrc[ row ]    = null; scheduleAutosave(); },
        afterMergeCells   : function( cellRange, mergeParent ) { trackMerge( mergeParent ); scheduleAutosave(); },
        afterUnmergeCells : function( cellRange ) { untrackMerge( cellRange ); scheduleAutosave(); },
        afterRender       : function()
        {
            // Tooltip for the corner "select all" glyph (styled in the <style> block).
            // HT rebuilds the header DOM on render, so re-apply after each one.
            const corner = el.querySelector( '.ht_clone_top_inline_start_corner thead th' );
            if( corner && ! corner.title ) corner.title = T( 'calc.selectAll' );
        },
        afterSelectionEnd : function( row, col, row2, col2 )
        {
            lastSelection = { r1: Math.min( row, row2 ), c1: Math.min( col, col2 ), r2: Math.max( row, row2 ), c2: Math.max( col, col2 ) };
            updateToolbarActiveState();
            refreshNameBox();
            refreshFormulaBar();
            refreshSelStats();
        }
    });

    // Hidden rows/columns are applied HERE, not through the settings above:
    // the plugins only accept indexes that exist in the data they were built
    // with, and a sheet is padded out to minRows/minCols afterwards. A file
    // whose hidden column sits past its last written column — the common case,
    // since hiding a column tends to leave it empty — was silently shown.
    if( activeSheet.hiddenCols.length ) table.getPlugin( 'hiddenColumns' ).hideColumns( activeSheet.hiddenCols.slice() );
    if( activeSheet.hiddenRows.length ) table.getPlugin( 'hiddenRows'    ).hideRows(    activeSheet.hiddenRows.slice() );
    if( activeSheet.hiddenCols.length || activeSheet.hiddenRows.length ) table.render();

    // Selects A1 by default, like every other spreadsheet app — without this,
    // lastSelection stays null until the user clicks a cell, and every toolbar
    // button (fx, insert row/col, merge, formatting…) silently no-ops until then.
    table.selectCell( 0, 0 );
    table.listen();          // give the grid keyboard focus so you can type into A1 at once

    // Every other sheet goes into HyperFormula so ='Notas'!A1 resolves, and
    // the tab strip appears only when there is more than one sheet to show.
    registerSheetsInEngine();
    renderSheetTabs();

    gridBooting = false;     // from here on, a hook firing really is the user
}

// Handsontable's MergeCells plugin exposes no "get all current merges" call, so the
// merge list is tracked independently here via the after(Un)mergeCells hooks — this
// also fixes a jspreadsheet-era gap where a mid-session merge was silently lost on save.
function trackMerge( m )
{
    activeSheet.merges = activeSheet.merges.filter( function( e ) { return ! ( e.row === m.row && e.col === m.col ); } );
    activeSheet.merges.push( { row: m.row, col: m.col, rowspan: m.rowspan, colspan: m.colspan } );
}

function untrackMerge( cellRange )
{
    const row = cellRange.from.row;
    const col = cellRange.from.col;
    activeSheet.merges = activeSheet.merges.filter( function( e ) { return ! ( e.row === row && e.col === col ); } );
}

//--------------------------------------------------------------------//
// CLIPBOARD STYLES
//
// Handsontable's clipboard carries VALUES. The look of a cell lives in
// `activeSheet.cellStyles`, which is this app's own map and means nothing
// to the plugin, so a copy would paste the numbers naked. These three
// hooks ride the styles along: the copy stashes them, the paste lays them
// down again. Ctrl+C / Ctrl+X / Ctrl+V and the Edicion menu both end in
// the plugin, so both get this for free.
//
// The stash is matched on the copied VALUES, never on the clipboard text:
// a paste whose values are not the ones that were copied came from
// somewhere else - Excel, a text editor, another tab - and its cells are
// left with whatever style they already had. That also means a copy in
// ONE Calc tab and a paste in ANOTHER moves values only; the stash is a
// page's own memory, not something the system clipboard can hold.

let clipStash = null;         // { values: [[…]], styles: [[…]] } of the last copy / cut
let clipBare  = false;        // one paste, values only: "pegar sin formato"

// Ctrl+Shift+V. Armed by calc.js right before it hands the paste over, and
// disarmed the moment a paste has been through - so a paste that never happens
// (empty clipboard, a browser that says no) cannot strip the NEXT one's styles.
function pasteWithoutStyles( on ) { clipBare = on !== false; }

// The block a hook is talking about. Only 'cells-only' copies are stashed:
// the header modes hand back rows the styles map has no cells for.
function clipBlock( coords )
{
    const c = coords && coords[ 0 ];
    return ( c && c.startRow >= 0 && c.startCol >= 0 ) ? c : null;
}

function styleAt( r, c )    { return activeSheet.cellStyles[ encodeCell( { r: r, c: c } ) ] || null; }

function stashClipStyles( data, coords )
{
    clipBare = false;         // a fresh copy is never a bare paste
    const c = clipBlock( coords );

    if( ! c ) { clipStash = null; return; }

    const styles = [];

    for( let r = c.startRow; r <= c.endRow; r++ )
    {
        const row = [];
        for( let k = c.startCol; k <= c.endCol; k++ ) row.push( styleAt( r, k ) );
        styles.push( row );
    }

    clipStash = { values: data, styles: styles };
}

// A cut takes the look with it, the way every spreadsheet does: the values
// are already gone by the time this runs, and a cell left empty but still
// red on yellow is not what "cut" means.
function cutClipStyles( data, coords )
{
    stashClipStyles( data, coords );

    const c = clipBlock( coords );
    if( ! c ) return;

    for( let r = c.startRow; r <= c.endRow; r++ )
        for( let k = c.startCol; k <= c.endCol; k++ )
            delete activeSheet.cellStyles[ encodeCell( { r: r, c: k } ) ];

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
}

function applyClipStyles( data, coords )
{
    const c    = clipBlock( coords );
    const bare = clipBare;

    clipBare = false;         // whatever happens below, the arming is spent

    if( bare || ! clipStash || ! c || ! sameValues( data, clipStash.values ) ) return;

    const st = clipStash.styles;
    if( ! st.length || ! st[ 0 ].length ) return;

    for( let r = c.startRow; r <= c.endRow; r++ )
        for( let k = c.startCol; k <= c.endCol; k++ )
        {
            // A paste into a selection bigger than the copy repeats the block,
            // so the styles repeat with it.
            const s    = st[ ( r - c.startRow ) % st.length ][ ( k - c.startCol ) % st[ 0 ].length ];
            const addr = encodeCell( { r: r, c: k } );

            // A fresh object per cell: the styles map is edited in place by the
            // toolbar, and two cells must never end up sharing one entry.
            if( s ) activeSheet.cellStyles[ addr ] = JSON.parse( JSON.stringify( s ) );
            else    delete activeSheet.cellStyles[ addr ];
        }

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
}

// Cell by cell, as text: Handsontable hands a paste back as strings even when
// the copy held numbers.
function sameValues( a, b )
{
    if( ! a || ! b || a.length !== b.length ) return false;

    for( let r = 0; r < a.length; r++ )
    {
        if( ! a[ r ] || ! b[ r ] || a[ r ].length !== b[ r ].length ) return false;

        for( let c = 0; c < a[ r ].length; c++ )
        {
            const x = a[ r ][ c ], y = b[ r ][ c ];
            if( String( x === null || x === undefined ? '' : x ) !==
                String( y === null || y === undefined ? '' : y ) ) return false;
        }
    }

    return true;
}

// Delegates to Handsontable's own text renderer, then paints the style this app
// tracks in `activeSheet.cellStyles` — cells are recycled DOM nodes, so unset properties must be
// explicitly cleared or they'd leak onto whatever cell is rendered into that node next.
function styledRenderer( instance, td, row, col, prop, value, cellProperties )
{
    Handsontable.renderers.getRenderer( 'text' )( instance, td, row, col, prop, value, cellProperties );

    const style = activeSheet.cellStyles[ encodeCell( { r: row, c: col } ) ];

    td.style.fontWeight      = ( style && style.bold )      ? 'bold'      : '';
    td.style.fontStyle       = ( style && style.italic )    ? 'italic'    : '';
    td.style.textDecoration  = ( style && style.underline ) ? 'underline' : '';
    td.style.color           = ( style && style.color )      ? '#' + style.color : '';
    td.style.backgroundColor = ( style && style.bg )         ? '#' + style.bg    : '';
    td.style.textAlign       = ( style && style.align )      ? style.align       : '';
    td.style.verticalAlign   = ( style && style.valign )     ? style.valign      : '';
    td.style.whiteSpace      = ( style && style.wrap )       ? 'normal'          : '';
    td.style.fontFamily      = ( style && style.fontFamily ) ? style.fontFamily  : '';
    td.style.fontSize        = ( style && style.size )       ? style.size + 'pt' : '';

    const bd   = style && style.border;
    const bObj = ( bd === true ) ? { top: true, right: true, bottom: true, left: true, style: 'thin' } : bd;
    const bw   = ( bObj && bObj.style === 'medium' ) ? '2px' : '1px';
    const bc   = ( bObj && bObj.color ) ? ( '#' + bObj.color ) : 'var(--text-dim)';

    td.style.borderTop    = ( bObj && bObj.top )    ? ( bw + ' solid ' + bc ) : '';
    td.style.borderRight  = ( bObj && bObj.right )  ? ( bw + ' solid ' + bc ) : '';
    td.style.borderBottom = ( bObj && bObj.bottom ) ? ( bw + ' solid ' + bc ) : '';
    td.style.borderLeft   = ( bObj && bObj.left )   ? ( bw + ' solid ' + bc ) : '';

    // A number shows through its format, with the language's marks (see
    // NUMBERS ON SCREEN).
    if( typeof value === 'number' && isFinite( value ) ) td.textContent = showNumber( value, style && style.numFmt );

    // Mark a linked cell. Cells are recycled DOM nodes, so this has to be
    // set AND cleared on every render like every other style above.
    const link = activeSheet.links[ encodeCell( { r: row, c: col } ) ];
    td.classList.toggle( 'has-link', !! ( link && link.target ) );

    // The tooltip: a formula cell shows its answer, so hovering it shows
    // the formula; a link adds where it goes. Set AND cleared, as above.
    // `instance`, never `table`: while a new grid is being built, `table` is
    // still the old, destroyed one, and reading it throws (New / open broke).
    const src  = instance.getSourceDataAtCell( row, col );
    const tips = [];
    if( typeof src === 'string' && src.charAt( 0 ) === '=' ) tips.push( src );
    if( link && link.target )     tips.push( ( link.tooltip || link.target ) + ' — ' + T( 'calc.linkHint' ) );
    const tip = tips.join( '\n' );
    if( td.title !== tip ) td.title = tip;

    // The cells a formula being typed points at (see POINTING below).
    const pb = pointedBounds();
    const pt = !! pb && row >= pb.r1 && row <= pb.r2 && col >= pb.c1 && col <= pb.c2;
    td.classList.toggle( 'pt',   pt );
    td.classList.toggle( 'pt-t', pt && row === pb.r1 );
    td.classList.toggle( 'pt-b', pt && row === pb.r2 );
    td.classList.toggle( 'pt-l', pt && col === pb.c1 );
    td.classList.toggle( 'pt-r', pt && col === pb.c2 );
}

// Ctrl/Cmd-click on a linked cell follows the link. Plain click is left
// alone: in a spreadsheet the first job of a click is to select the cell.
function followLinkAt( row, col, event )
{
    if( ! event || ! ( event.ctrlKey || event.metaKey ) ) return;

    const link = activeSheet.links[ encodeCell( { r: row, c: col } ) ];
    if( ! link || ! link.target ) return;

    event.preventDefault();

    // "#Hoja2!A1" is a jump inside the workbook, not a URL.
    if( link.target.charAt( 0 ) === '#' ) { gotoReference( link.target.slice( 1 ) ); return; }

    // Anything that is not plainly http(s) or mailto is not opened: a
    // file:// or javascript: target in someone else's spreadsheet is not
    // something to hand the browser on a click.
    if( ! /^(https?:|mailto:)/i.test( link.target ) ) { NayiveUI.toast( T( 'calc.linkBlocked' ) ); return; }

    window.open( link.target, '_blank', 'noopener,noreferrer' );
}

//------------------------------------------------------------------------//
// POINTING WHILE A FORMULA IS TYPED
//
// What every spreadsheet does: while a cell's "=…" is being typed, a click
// on another cell puts its address into the formula instead of moving
// there. A drag puts a range (A1:C4), a column or row header the whole
// column or row (A:A, 3:3), and Shift+click stretches the range from where
// it started. The arrow keys do the same while the formula is being typed
// (Shift+arrow stretches) - but not after F2 or a double-click, where they
// move the caret, as in Excel.
//
// Only where a reference can go: right after "=", "(", ",", ";", ":" or an
// operator. Anywhere else a click commits the cell and moves on, as it
// always did. A click right after a reference just put in REPLACES it, so
// a wrong click is fixed by clicking the right cell.
//
// Handsontable is kept out of those clicks and keys with its own
// stopImmediatePropagation (the flag its handlers check), and the
// mousedown's default is prevented so the editor keeps focus and caret.

const POINT_AFTER = /[=(,;:+\-*\/^&<>]\s*$/;
const POINT_KEYS  = { ArrowUp: [ -1, 0 ], ArrowDown: [ 1, 0 ], ArrowLeft: [ 0, -1 ], ArrowRight: [ 0, 1 ] };

let point        = null;    // { from, to, value, anchor, head, bounds } - the reference last put in
let pointDrag    = false;   // the mouse button is down on a pointing click
let pointWriting = false;   // the 'input' event is ours, not the user typing

// The release is NOT kept from Handsontable: its own document-level
// mouseup is what clears its "button is down" flag, and left set, the
// next plain mouse move drag-selects and closes the editor.
document.addEventListener( 'mouseup', function() { pointDrag = false; } );
document.addEventListener( 'touchend', function() { pointDrag = false; } );

// The open cell editor, when what it holds is a formula.
function formulaEditor()
{
    const ed = table && table.getActiveEditor();
    if( ! ed || ! ed.isOpened() || ! ed.TEXTAREA ) return null;
    return ed.TEXTAREA.value.charAt( 0 ) === '=' ? ed : null;
}

// The reference last put in stays "live" while nothing was typed after it:
// the same text, and the caret still at its end.
function livePoint( ta )
{
    return point && point.value === ta.value &&
           ta.selectionStart === point.to && ta.selectionEnd === point.to ? point : null;
}

function canPoint( ta )
{
    return !! livePoint( ta ) || POINT_AFTER.test( ta.value.slice( 0, ta.selectionStart ) );
}

// r = -1 is a column header, c = -1 a row header.
function kindOf( p ) { return p.r < 0 ? 'col' : p.c < 0 ? 'row' : 'cell'; }

function pointBounds( a, b )
{
    const kind = kindOf( a );
    const b2   = {
        r1: Math.min( a.r, b.r ), r2: Math.max( a.r, b.r ),
        c1: Math.min( a.c, b.c ), c2: Math.max( a.c, b.c ), kind: kind };

    if( kind === 'col' ) { b2.r1 = 0; b2.r2 = table.countRows() - 1; }
    if( kind === 'row' ) { b2.c1 = 0; b2.c2 = table.countCols() - 1; }

    return b2;
}

function colLetters( c ) { return encodeCell( { r: 0, c: c } ).replace( /\d+$/, '' ); }

// "B3", "B3:D7", "B:D" or "3:5".
function pointText( k )
{
    if( k.kind === 'col' ) return colLetters( k.c1 ) + ':' + colLetters( k.c2 );
    if( k.kind === 'row' ) return ( k.r1 + 1 ) + ':' + ( k.r2 + 1 );

    const a = encodeCell( { r: k.r1, c: k.c1 } );
    const b = encodeCell( { r: k.r2, c: k.c2 } );
    return a === b ? a : a + ':' + b;
}

// Put the reference at the caret - or in place of the live one.
function putPoint( ed, anchor, head )
{
    const ta   = ed.TEXTAREA;
    const live = livePoint( ta );
    const from = live ? live.from : ta.selectionStart;
    const to   = live ? live.to   : ta.selectionEnd;
    const k    = pointBounds( anchor, head );
    const ref  = pointText( k );

    ta.value = ta.value.slice( 0, from ) + ref + ta.value.slice( to );

    const end = from + ref.length;
    if( document.activeElement !== ta ) ta.focus();
    ta.setSelectionRange( end, end );

    // Live BEFORE the 'input' below: what that event runs (the formula
    // editor asks canPoint) has to see the reference already there.
    point = { from: from, to: end, value: ta.value, anchor: anchor, head: head, bounds: k };

    // The editor grows to fit, exactly as when the text is typed.
    pointWriting = true;
    ta.dispatchEvent( new Event( 'input', { bubbles: true } ) );
    pointWriting = false;

    table.render();                                  // styledRenderer outlines the cells
}

function clearPoint()
{
    pointDrag = false;
    if( ! point ) return;

    point = null;
    if( table ) table.render();
}

// What styledRenderer outlines: the live reference, while its editor is open.
function pointedBounds()
{
    if( ! point ) return null;

    const ed = table.getActiveEditor();
    return ed && ed.isOpened() ? point.bounds : null;
}

// Typing anything after the reference (or moving the caret off it) ends
// it: the next click adds a new one instead of replacing it.
function pointEditorOpened()
{
    clearPoint();

    const ed = table.getActiveEditor();
    const ta = ed && ed.TEXTAREA;
    if( ! ta || ta.dataset.pointWired ) return;

    ta.dataset.pointWired = '1';
    for( const type of [ 'input', 'keyup', 'mouseup' ] )
        ta.addEventListener( type, function() { if( point && ! pointWriting && ! livePoint( ta ) ) clearPoint(); } );

    // The formula bar follows the editor keystroke by keystroke (see THE
    // FORMULA BAR above). The synthetic 'input' a pointed reference fires
    // counts as one: the formula did change.
    ta.addEventListener( 'input', mirrorEditorToBar );

    // So does the formula editor (see FORMULA EDITOR below): what is
    // typed, where the caret goes, and the editor closing - its holder
    // swaps ht_editor_visible for ht_editor_hidden, whatever closed it.
    // Typing turns Range off; a reference pointed in (pointWriting) does not.
    for( const type of [ 'input', 'keyup', 'mouseup' ] )
        ta.addEventListener( type, function() { if( type === 'input' && ! pointWriting ) rangeArmed = 0; syncFormulaPanel(); } );
    if( ed.TEXTAREA_PARENT )
        new MutationObserver( syncFormulaPanel ).observe( ed.TEXTAREA_PARENT, { attributes: true, attributeFilter: [ 'class' ] } );
}

function pointMouseDown( e, coords )
{
    pointDrag = false;
    if( coords.row < 0 && coords.col < 0 ) return;       // the corner stays "select all"

    const ed = formulaEditor();
    if( ! ed || ! canPoint( ed.TEXTAREA ) ) return;

    Handsontable.dom.stopImmediatePropagation( e );
    e.preventDefault();

    const at   = { r: coords.row, c: coords.col };
    const live = livePoint( ed.TEXTAREA );
    const from = ( e.shiftKey || rangeArmed === 2 ) && live && kindOf( live.anchor ) === kindOf( at ) ? live.anchor : at;

    if( rangeArmed ) rangeArmed = rangeArmed === 1 ? 2 : 0;   // Range: this tap was the first cell, or the last
    putPoint( ed, from, at );
    pointDrag = true;
}

function pointMouseOver( e, coords )
{
    if( ! pointDrag ) return;

    Handsontable.dom.stopImmediatePropagation( e );

    const ed   = formulaEditor();
    const live = ed && livePoint( ed.TEXTAREA );
    if( ! live ) { pointDrag = false; return; }

    // A column drag follows the columns, a row drag the rows; a cell drag
    // ignores the headers.
    const kind = kindOf( live.anchor );
    if( kind === 'col'  && coords.col < 0 ) return;
    if( kind === 'row'  && coords.row < 0 ) return;
    if( kind === 'cell' && ( coords.row < 0 || coords.col < 0 ) ) return;

    if( live.head.r === coords.row && live.head.c === coords.col ) return;

    putPoint( ed, live.anchor, { r: coords.row, c: coords.col } );
}

function pointKeyDown( e )
{
    if( e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab' )
    {
        if( point ) setTimeout( clearPoint, 0 );       // once the editor has closed
        setTimeout( refreshFormulaBar, 0 );            // Escape leaves the mirror showing text the cell never took
        return;
    }

    const d = POINT_KEYS[ e.key ];
    if( ! d || e.ctrlKey || e.metaKey || e.altKey ) return;

    const ed = formulaEditor();
    if( ! ed || ed.isInFullEditMode() || ! canPoint( ed.TEXTAREA ) ) return;

    Handsontable.dom.stopImmediatePropagation( e );
    e.preventDefault();

    // The first arrow starts from the cell being typed into, the next
    // ones from wherever the reference got to.
    const live = livePoint( ed.TEXTAREA );
    const from = live && kindOf( live.head ) === 'cell' ? live.head : { r: ed.row, c: ed.col };
    const head = { r: Math.min( Math.max( from.r + d[ 0 ], 0 ), table.countRows() - 1 ),
                   c: Math.min( Math.max( from.c + d[ 1 ], 0 ), table.countCols() - 1 ) };
    const anch = e.shiftKey && live && kindOf( live.anchor ) === 'cell' ? live.anchor : head;

    putPoint( ed, anch, head );
    table.scrollViewportTo( { row: head.r, col: head.c } );
}

//------------------------------------------------------------------------//
// FORMULA EDITOR
//
// A panel over the top-right corner of the cells while a cell's "=…" is
// typed: the result so far (or what is wrong, in words), the functions,
// the operator keys a tablet keyboard hides, a Range button and ✓ / ✗.
// The chevron in its title folds it down to that row, and it stays folded.
//
// It has NO text field of its own. The typing stays in the cell, and every
// button writes into the cell editor's textarea (putText), so there is one
// formula, never two copies to keep in step. Searching a function is
// typing its name in the cell: "=SU" lists SUM and SUMIF.
//
// What keeps the cell editor open, with its caret where it was:
//   - a press on the panel goes no further. Handsontable's document handler
//     takes any mousedown outside the grid as "done" and closes the editor
//     (outsideClickDeselects is false -> destroyEditor), and its document
//     click stops the grid listening to the keyboard;
//   - the mousedown's default is prevented, so the textarea keeps the
//     focus - and a tablet keeps its keyboard up;
//   - it lives outside #gridHost, which initGrid empties on every open.
//
// Range is Shift for a finger: on a tablet a drag scrolls the sheet, so
// with Range on the next two taps make A1:C4 (pointMouseDown reads it).
// Hidden on a phone, where the keyboard leaves no room for it.

const FE_FOLD_KEY = 'nayive-calc-fe-folded';
const FE_QUICK    = [ 'SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN', 'IF' ];
const FE_ERRORS   = [ 'DIV_BY_ZERO', 'NAME', 'VALUE', 'NUM', 'NA', 'REF', 'CYCLE' ];

// [ what the key shows, what it types ]. '' types the engine's argument separator.
const FE_KEYS =
[
    [ '+', '+' ], [ '−', '-' ], [ '×', '*' ], [ '÷', '/' ], [ '^', '^' ], [ '%', '%' ], [ '&', '&' ], [ '=', '=' ],
    [ '(', '(' ], [ ')', ')' ], [ ':', ':' ], [ ',', ''  ], [ '<', '<' ], [ '>', '>' ], [ '<>', '<>' ], [ '"', '"' ]
];

let rangeArmed = 0;       // Range: 0 off, 1 waiting for the first cell, 2 for the last
let feAll      = false;   // "All functions" is unfolded
let feTimer    = null;    // the result waits for a pause in the typing
let feListKey  = null;    // what the function list shows, so a keystroke does not rebuild it

function fePanel() { return document.getElementById( 'fePanel' ); }

function hideFormulaPanel()
{
    const panel = fePanel();
    if( ! panel || ! panel.classList.contains( 'open' ) ) return;

    panel.classList.remove( 'open' );
    clearTimeout( feTimer );
    rangeArmed = 0;
    feAll      = false;
}

// Open while the cell editor holds a formula, closed the moment it does
// not. Runs on every keystroke, caret move and editor close.
function syncFormulaPanel()
{
    const ed = PHONE.matches ? null : formulaEditor();
    if( ! ed ) { hideFormulaPanel(); return; }

    const panel = fePanel();
    if( ! panel.classList.contains( 'open' ) )
    {
        panel.classList.add( 'open' );
        placeFormulaPanel();
    }
    refreshFormulaPanel( ed );
}

// Top-right of the CELLS: under the column letters, clear of the vertical
// scrollbar. Again whenever the grid changes size (the toolbar folding,
// the menus chrome, the window).
function placeFormulaPanel()
{
    const panel = fePanel();
    const host  = document.getElementById( 'gridHost' );
    if( ! panel || ! host || ! panel.classList.contains( 'open' ) ) return;

    const box    = host.getBoundingClientRect();
    const head   = host.querySelector( '.ht_clone_top thead' );
    const holder = host.querySelector( '.ht_master .wtHolder' );
    const top    = box.top + ( head ? head.offsetHeight : 0 ) + 8;
    const bar    = holder ? holder.offsetWidth - holder.clientWidth : 0;

    panel.style.top       = Math.round( top ) + 'px';
    panel.style.right     = Math.round( window.innerWidth - box.right + bar + 8 ) + 'px';
    panel.style.maxHeight = Math.max( 120, Math.round( box.bottom - top - 8 ) ) + 'px';
}

// Type `text` at the cell editor's caret, over whatever is selected in
// it - exactly as if it had been typed there.
function putText( ed, text )
{
    const ta   = ed.TEXTAREA;
    const from = ta.selectionStart;
    const to   = ta.selectionEnd;

    ta.value = ta.value.slice( 0, from ) + text + ta.value.slice( to );

    const end = from + text.length;
    if( document.activeElement !== ta ) ta.focus();
    ta.setSelectionRange( end, end );

    clearPoint();                     // the next tap adds a reference, it replaces none
    ta.dispatchEvent( new Event( 'input', { bubbles: true } ) );
}

function argSeparator()
{
    const hf = formulaEngine();
    return ( hf && hf.getConfig().functionArgSeparator ) || ',';
}

// The function name being typed right before the caret ("=SU" -> "SU"):
// letters only, straight after "=", a bracket, a separator or an operator.
function feWord( ta )
{
    const m = /(?:^=|[=(,;:+\-*\/^&<>\s])([A-Za-z]+)$/.exec( ta.value.slice( 0, ta.selectionStart ) );
    return m ? m[ 1 ].toUpperCase() : null;
}

// The function whose brackets the caret is in: "=ROUND(SUM(A1:A3" -> SUM.
function feOpenFunction( ta )
{
    const text  = ta.value.slice( 0, ta.selectionStart );
    const stack = [];
    let   quote = false;

    for( let i = 0; i < text.length; i++ )
    {
        const ch = text.charAt( i );
        if( ch === '"' ) quote = ! quote;
        if( quote ) continue;

        if( ch === '(' )
        {
            const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec( text.slice( 0, i ) );
            stack.push( m ? m[ 1 ].toUpperCase() : '' );
        }
        if( ch === ')' ) stack.pop();
    }

    return stack.length ? stack[ stack.length - 1 ] : null;
}

// "SUM(" at the caret - in place of the part of its name already typed.
function feInsertFunction( ed, name )
{
    const ta   = ed.TEXTAREA;
    const word = feWord( ta );

    if( word && name.indexOf( word ) === 0 )
        ta.setSelectionRange( ta.selectionStart - word.length, ta.selectionEnd );

    putText( ed, name + '(' );
}

// Range on: a reference just put in becomes its first cell, so the next
// tap is the last; with none, the next two taps are both.
function toggleRange( ed )
{
    const live = livePoint( ed.TEXTAREA );

    rangeArmed = rangeArmed ? 0 : ( live && kindOf( live.anchor ) === 'cell' ? 2 : 1 );
    refreshFormulaPanel( ed );
}

function setFolded( folded, keep )
{
    fePanel().classList.toggle( 'is-folded', folded );
    document.getElementById( 'feFoldBtn' ).setAttribute( 'aria-expanded', folded ? 'false' : 'true' );

    if( keep ) try { localStorage.setItem( FE_FOLD_KEY, folded ? '1' : '' ); } catch( _ ) {}
}

function refreshFormulaPanel( ed )
{
    const ta  = ed.TEXTAREA;
    const can = canPoint( ta );

    // Range only while a tap on the sheet can put a reference in.
    if( ! can ) rangeArmed = 0;

    const range = document.getElementById( 'feRangeBtn' );
    range.disabled = ! can;
    range.classList.toggle( 'is-active', !! rangeArmed );
    range.setAttribute( 'aria-pressed', rangeArmed ? 'true' : 'false' );

    // The function the caret is inside, and what it does.
    const open = feOpenFunction( ta );
    const fn   = open && FUNCTIONS.find( function( f ) { return f.name === open; } );
    const help = document.getElementById( 'feFnHelp' );

    help.hidden = ! fn;
    if( fn )
    {
        const b = document.createElement( 'b' );
        b.textContent = fn.name;
        help.replaceChildren( b, ' — ' + fn.desc );
    }

    // The list: what the name typed so far can become, or all of them.
    const word = feWord( ta );
    const rows = word ? FUNCTIONS.filter( function( f ) { return f.name.indexOf( word ) === 0; } )
                      : ( feAll ? FUNCTIONS : [] );
    const key  = rows.map( function( f ) { return f.name; } ).join( ',' );
    const list = document.getElementById( 'feList' );

    if( key !== feListKey ) { feListKey = key; list.innerHTML = fxRowsHtml( rows ); list.scrollTop = 0; }
    list.hidden = ! rows.length;

    const all = document.getElementById( 'feAllBtn' );
    all.classList.toggle( 'is-active', feAll );
    all.setAttribute( 'aria-expanded', feAll ? 'true' : 'false' );

    clearTimeout( feTimer );
    feTimer = setTimeout( function() { showFormulaResult( ed ); }, 80 );
}

// The formula's answer as it stands, from the grid's own engine. Nothing
// is written: the cell only takes it on ✓ or Enter.
function showFormulaResult( ed )
{
    const box = document.getElementById( 'feResult' );
    if( ! box || ! ed.isOpened() ) return;

    const text = ed.TEXTAREA.value;
    const hf   = formulaEngine();
    let   main = '', hint = '', bad = false;

    // Range's two steps take the box over while it is on.
    if( rangeArmed )                         hint = T( rangeArmed === 1 ? 'calc.fe.rangeFirst' : 'calc.fe.rangeLast' );
    else if( ! hf || /^=\s*$/.test( text ) ) hint = T( 'calc.fe.start' );
    else
    {
        let v;
        try
        {
            const id = hf.getSheetId( activeSheet.name || 'Hoja1' );
            v = hf.calculateFormula( text, id === undefined ? 0 : id );
        }
        catch( _ ) { v = undefined; }           // not a formula yet: "=SUM(" or "=A1+"

        if( Array.isArray( v ) ) v = ( v[ 0 ] && v[ 0 ].length ) ? v[ 0 ][ 0 ] : null;

        if( v === undefined ) hint = T( 'calc.fe.incomplete' );
        else if( v && typeof v === 'object' && 'type' in v )
        {
            // A name half typed is not a mistake yet: the list shows what it can become.
            if( v.type === 'NAME' && ! document.getElementById( 'feList' ).hidden && feWord( ed.TEXTAREA ) )
                hint = T( 'calc.fe.incomplete' );
            else
            {
                bad  = true;
                main = ( v.value || '#ERROR!' ) + ' ' + T( 'calc.fe.err.' + ( FE_ERRORS.indexOf( v.type ) !== -1 ? v.type : 'other' ) );
            }
        }
        else main = '= ' + feShow( v, ed );
    }

    box.classList.toggle( 'is-error', bad );
    box.dataset.placeholder = hint;
    box.textContent         = main;
}

// A value the way the cell will show it: its number format if it has one.
function feShow( v, ed )
{
    if( v === null || v === '' ) return '';
    if( typeof v === 'boolean' ) return v ? 'TRUE' : 'FALSE';

    if( typeof v === 'number' )
    {
        const style = activeSheet.cellStyles[ encodeCell( { r: ed.row, c: ed.col } ) ];
        return showNumber( v, style && style.numFmt );
    }

    return '"' + v + '"';
}

// ✓ is Enter (writes, moves down), ✗ is Escape (the cell keeps what it had).
function feFinish( ed, cancel )
{
    const r = ed.row, c = ed.col;

    ed.finishEditing( cancel );
    clearPoint();
    hideFormulaPanel();

    setTimeout( function()
    {
        if( ! cancel && ! ed.isOpened() ) table.selectCell( Math.min( r + 1, table.countRows() - 1 ), c );
        refreshFormulaBar();
        table.listen();
    }, 0 );
}

function wireFormulaPanel()
{
    const panel = fePanel();

    // The quick functions go before "All functions"; the keys in two rows of eight.
    const all = document.getElementById( 'feAllBtn' );
    for( const name of FE_QUICK )
    {
        const b = document.createElement( 'button' );
        b.type        = 'button';
        b.className   = 'pill';
        b.dataset.fn  = name;
        b.textContent = name;
        all.parentNode.insertBefore( b, all );
    }

    const keys = document.getElementById( 'feKeys' );
    for( const row of [ FE_KEYS.slice( 0, 8 ), FE_KEYS.slice( 8 ) ] )
    {
        const line = document.createElement( 'div' );
        line.className = 'popup-row';
        for( const k of row )
        {
            const b = document.createElement( 'button' );
            b.type        = 'button';
            b.className   = 'pop-btn fe-key';
            b.dataset.ins = k[ 1 ];
            b.textContent = k[ 0 ];
            line.appendChild( b );
        }
        keys.appendChild( line );
    }

    let folded = false;
    try { folded = localStorage.getItem( FE_FOLD_KEY ) === '1'; } catch( _ ) {}
    setFolded( folded, false );

    // Nothing pressed on the panel may reach Handsontable's document
    // handlers (they would close the cell editor), and no press may take
    // the focus out of the cell's textarea.
    for( const type of [ 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend' ] )
        panel.addEventListener( type, function( e ) { e.stopPropagation(); } );
    panel.addEventListener( 'mousedown', function( e ) { e.preventDefault(); } );

    panel.addEventListener( 'click', function( e )
    {
        if( e.target.closest( '#feHead' ) )
        {
            setFolded( ! panel.classList.contains( 'is-folded' ), true );
            placeFormulaPanel();
            return;
        }

        const ed = formulaEditor();
        if( ! ed ) return;

        const key = e.target.closest( '[data-ins]' );
        const fn  = e.target.closest( '[data-fn]' );

        if( key )                                     putText( ed, key.dataset.ins || argSeparator() );
        else if( fn )                                 feInsertFunction( ed, fn.dataset.fn );
        else if( e.target.closest( '#feRangeBtn' ) )  toggleRange( ed );
        else if( e.target.closest( '#feAllBtn' ) )    { feAll = ! feAll; refreshFormulaPanel( ed ); }
        else if( e.target.closest( '#feOkBtn' ) )     feFinish( ed, false );
        else if( e.target.closest( '#feCancelBtn' ) ) feFinish( ed, true );
    } );

    window.addEventListener( 'resize', placeFormulaPanel );
    if( window.ResizeObserver ) new ResizeObserver( placeFormulaPanel ).observe( document.getElementById( 'gridHost' ) );
    PHONE.addEventListener( 'change', syncFormulaPanel );
}

export
{
    table, newSheet, newDoc, doc, activeSheet, gridBooting, lastSelection, htThemeName,
    CM_ICONS, switchToSheet, sortByColumn, initGrid, wireFormulaPanel, pasteWithoutStyles,
    editText, localMarks, undoStep
};
