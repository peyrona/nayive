/*
 * format.js - Calc's cell formatting: the formatting toolbar, the border
 * picker and the number-format dialog. Imported by calc.js.
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
    NF_SAMPLE_DATE, borderWeight, borderColorValue, T, scheduleAutosave, menus, CHROME,
    syncGroupTriggers
}
from './calc.js';
import
{
    table, activeSheet, lastSelection, localMarks, undoStep, lineStyle, styleOf
}
from './grid.js';

let nfCategory     = null;   // number-format category the numFmt dialog is currently editing

//------------------------------------------------------------------------//
// FORMATTING TOOLBAR

function forEachSelectedCell( fn )
{
    if( ! lastSelection ) return;

    for( let r = lastSelection.r1; r <= lastSelection.r2; r++ )
        for( let c = lastSelection.c1; c <= lastSelection.c2; c++ )
            fn( encodeCell( { r: r, c: c } ) );
}

const MAX_COLS = 16384;     // Excel's columns, A..XFD

// The look every column shares after a whole sheet was formatted (one
// object on all 16,384 of them), or null.
function allColumnsStyle( sh )
{
    const cs    = sh.colStyles || [];
    const first = cs[ 0 ];
    if( ! first ) return null;

    for( let c = 1; c < MAX_COLS; c++ ) if( cs[ c ] !== first ) return null;
    return first;
}

// What a change of look lands on (see THE LOOK OF A CELL in grid.js):
//   addrs  cells - the selection, or for whole lines the cells in them that
//          have a look of their own, plus each cell where a styled line
//          crosses a changed one and would otherwise hide the change (a
//          row's look beats its columns': formatting column B leaves B7 of
//          a styled row 7 alone unless B7 gets the change as its own);
//   rows / cols  the whole lines, from the headers; the corner (or Ctrl+A)
//          is every column and every styled row;
//   edge   the selection the border picker measures edges against - a
//          whole line has no first or last cell along it.
// Worked out BEFORE the change: a crossing depends on what was styled.
function lookTargets()
{
    const sel = lastSelection;
    const sh  = activeSheet;
    const t   = { addrs: [], rows: [], cols: [], lines: sel ? sel.lines : null, edge: sel, base: null };
    if( ! sel ) return t;

    if( ! sel.lines ) { forEachSelectedCell( function( a ) { t.addrs.push( a ); } ); return t; }

    const rows = sh.rowStyles || ( sh.rowStyles = [] );
    const cols = sh.colStyles || ( sh.colStyles = [] );
    const all  = sel.lines === 'all';
    const inRows = function( r ) { return all || ( sel.lines === 'rows' && r >= sel.r1 && r <= sel.r2 ); };
    const inCols = function( c ) { return all || ( sel.lines === 'cols' && c >= sel.c1 && c <= sel.c2 ); };
    const seen   = {};
    const add    = function( a ) { if( ! seen[ a ] ) { seen[ a ] = true; t.addrs.push( a ); } };

    Object.keys( sh.cellStyles ).forEach( function( a )
    {
        const rc = decodeCell( a );
        if( inRows( rc.r ) || inCols( rc.c ) ) add( a );
    });

    if( all )
    {
        rows.forEach( function( st, r ) { t.rows.push( r ); } );
        for( let c = 0; c < MAX_COLS; c++ ) t.cols.push( c );
        t.edge = { r1: -Infinity, r2: Infinity, c1: -Infinity, c2: Infinity };
        return t;
    }

    if( sel.lines === 'rows' )
    {
        // A row with no look yet starts from the one every column shares,
        // so a formatted sheet stays formatted; any other styled column
        // crossing it keeps its own look where they meet (in the columns
        // the grid has - past them nothing is on screen).
        t.base = allColumnsStyle( sh );
        const width = Math.min( table.countCols(), MAX_COLS );

        for( let r = sel.r1; r <= sel.r2; r++ )
        {
            t.rows.push( r );
            if( rows[ r ] ) continue;
            for( let c = 0; c < width; c++ )
                if( cols[ c ] && cols[ c ] !== t.base && ! sh.cellStyles[ encodeCell( { r: r, c: c } ) ] ) add( encodeCell( { r: r, c: c } ) );
        }
        t.edge = { r1: sel.r1, r2: sel.r2, c1: -Infinity, c2: Infinity };
        return t;
    }

    for( let c = sel.c1; c <= sel.c2; c++ ) t.cols.push( c );
    rows.forEach( function( st, r )
    {
        for( let c = sel.c1; c <= sel.c2; c++ )
            if( ! sh.cellStyles[ encodeCell( { r: r, c: c } ) ] ) add( encodeCell( { r: r, c: c } ) );
    });
    t.edge = { r1: -Infinity, r2: Infinity, c1: sel.c1, c2: sel.c2 };
    return t;
}

// Apply `fn( st, r, c )` - it edits the one style object it is handed - to
// every target. A cell with no look of its own starts from the one it
// showed (its row's or column's), so the change adds to that look instead
// of replacing it, and gets an own style only if the change did something.
// A line gets a new object each time, never an edited one; lines that
// shared an object before share the new one (a whole sheet: one object).
// An empty result takes the style away. `r` / `c` are NaN along a line.
function changeLook( t, fn )
{
    const sh   = activeSheet;
    const copy = function( st ) { return st ? JSON.parse( JSON.stringify( st ) ) : {}; };

    t.addrs.forEach( function( a )
    {
        const rc  = decodeCell( a );
        const own = sh.cellStyles[ a ];
        if( own ) { fn( own, rc.r, rc.c ); return; }

        const was = lineStyle( sh, rc.r, rc.c );
        const st  = copy( was );
        fn( st, rc.r, rc.c );
        if( JSON.stringify( st ) !== JSON.stringify( was || {} ) ) sh.cellStyles[ a ] = st;
    });

    // Only the corner changes every line alike (no edge along either way),
    // so only there is one new object made per old one.
    const made = ( t.lines === 'all' ) ? new Map() : null;
    const line = function( list, i, base, r, c )
    {
        const old = list[ i ] || base || null;
        let   st;

        if( made && made.has( old ) ) st = made.get( old );
        else
        {
            st = copy( old );
            fn( st, r, c );
            if( ! Object.keys( st ).length ) st = null;
            if( made ) made.set( old, st );
        }

        if( st ) list[ i ] = st;
        else     delete list[ i ];
    };

    t.rows.forEach( function( r ) { line( sh.rowStyles, r, t.base, r, NaN ); } );
    t.cols.forEach( function( c ) { line( sh.colStyles, c, null,   NaN, c ); } );

    // An EMPTY cell whose own look now matches its line's adds nothing but
    // one more styled <c> in the file: it goes. (A cell with a value keeps
    // its own - it is its look, whatever its line does next.)
    if( t.lines ) t.addrs.forEach( function( a )
    {
        const rc  = decodeCell( a );
        const own = sh.cellStyles[ a ];
        const ln  = lineStyle( sh, rc.r, rc.c );
        const v   = table.getSourceDataAtCell( rc.r, rc.c );
        if( own && ln && ( v === '' || v == null ) && JSON.stringify( own ) === JSON.stringify( ln ) ) delete sh.cellStyles[ a ];
    });
}

// Ctrl+Z for a change of look - bold, a colour, a border, a number format:
// the styles of the targets before `change` ran and after, as one step
// (grid.js, undoStep). A colour picker fires on every move of the
// pointer; while its step is still the last one done, a move of the same
// picker over the same cells grows that step instead of adding another.
let lookStep = null;     // { key, step, state } of the last change of look

function withLookUndo( key, change, t )
{
    const sheet = activeSheet;
    const addrs = t.addrs;
    const lines = t.rows.length || t.cols.length;

    // Line styles are never edited in place (see changeLook), so a copy of
    // the two lists is enough; a cell's own style is.
    const copy = function( st ) { return st ? JSON.parse( JSON.stringify( st ) ) : null; };
    const snap = function()
    {
        const o = { cells: {} };
        addrs.forEach( function( a ) { o.cells[ a ] = copy( sheet.cellStyles[ a ] ); } );
        if( lines ) { o.rows = sheet.rowStyles.slice(); o.cols = sheet.colStyles.slice(); }
        return o;
    };
    const put  = function( s )
    {
        for( const a in s.cells ) { if( s.cells[ a ] ) sheet.cellStyles[ a ] = copy( s.cells[ a ] ); else delete sheet.cellStyles[ a ]; }
        if( s.rows ) { sheet.rowStyles = s.rows.slice(); sheet.colStyles = s.cols.slice(); }
    };

    const ur   = table.getPlugin( 'undoRedo' );
    const top  = ur && ur.doneActions ? ur.doneActions[ ur.doneActions.length - 1 ] : null;
    const same = key && lastSelection ? key + '@' + lastSelection.r1 + ',' + lastSelection.c1 + ':' + lastSelection.r2 + ',' + lastSelection.c2 + ':' + lastSelection.lines : null;

    if( same && lookStep && lookStep.key === same && lookStep.step && lookStep.step === top )
    {
        change();
        lookStep.state.after = snap();
        return;
    }

    const before = snap();
    change();
    const state  = { after: snap() };
    const step   = undoStep( function() { put( before ); }, function() { put( state.after ); } );

    lookStep = { key: same, step: step, state: state };
}

// A change of look to the selection: the targets, the undo step, the redraw.
function restyle( key, fn, seen )
{
    if( ! lastSelection ) return;

    const t = lookTargets();
    if( seen ) seen( t );
    withLookUndo( key, function() { changeLook( t, fn ); }, t );

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
}

function toggleStyleField( field )
{
    if( ! lastSelection ) return;

    // Mirror the anchor cell's current state, so a mixed selection turns fully on.
    const anchor = styleOf( activeSheet, lastSelection.r1, lastSelection.c1 );
    const turnOn = ! ( anchor && anchor[ field ] );

    restyle( null, function( st ) { st[ field ] = turnOn; } );
}

function setStyleField( field, value )
{
    // The two colour pickers fire on every move (see withLookUndo).
    const picker = ( field === 'color' || field === 'bg' ) ? field : null;

    restyle( picker, function( st ) { st[ field ] = value; } );
}

function clearSelectionStyle()
{
    if( ! lastSelection ) return;

    const sheet = activeSheet;
    const t     = lookTargets();

    // Whole lines: their looks go, and so does every look of their own
    // inside them - where another styled line crosses, the cell is kept
    // plain ({}), or that line's look would show through.
    if( t.lines )
    {
        // Every crossing this time, not only the ones a change needs.
        if( t.lines !== 'all' )
        {
            const have  = new Set( t.addrs );
            const cross = function( r, c ) { const a = encodeCell( { r: r, c: c } ); if( ! have.has( a ) ) { have.add( a ); t.addrs.push( a ); } };
            const width = Math.min( table.countCols(), MAX_COLS );

            if( t.lines === 'rows' ) t.rows.forEach( function( r ) { for( let c = 0; c < width; c++ ) if( sheet.colStyles[ c ] ) cross( r, c ); } );
            else sheet.rowStyles.forEach( function( st, r ) { t.cols.forEach( function( c ) { cross( r, c ); } ); } );
        }

        withLookUndo( null, function()
        {
            t.addrs.forEach( function( a ) { delete sheet.cellStyles[ a ]; } );
            t.rows.forEach( function( r ) { delete sheet.rowStyles[ r ]; } );
            t.cols.forEach( function( c ) { delete sheet.colStyles[ c ]; } );
            t.addrs.forEach( function( a )
            {
                const rc = decodeCell( a );
                if( lineStyle( sheet, rc.r, rc.c ) ) sheet.cellStyles[ a ] = {};
            });
        }, t );

        table.render();
        updateToolbarActiveState();
        scheduleAutosave();
        return;
    }

    // Ctrl+Z puts the formats back (undoStep), under any style set on those
    // cells since - that one stays on top. The sheet itself is kept: a sort
    // gives it a new cellStyles object (and clears Ctrl+Z anyway). A cell in
    // a styled row or column is kept plain ({}) rather than bare, or the
    // line's look would come straight back.
    const was   = {};
    const plain = function( a ) { const rc = decodeCell( a ); return !! lineStyle( sheet, rc.r, rc.c ); };

    forEachSelectedCell( function( addr )
    {
        const own = sheet.cellStyles[ addr ];
        if( own && ! Object.keys( own ).length && plain( addr ) ) return;    // already plain

        if( own || plain( addr ) ) was[ addr ] = own || null;
        if( plain( addr ) ) sheet.cellStyles[ addr ] = {};
        else                delete sheet.cellStyles[ addr ];
    } );

    if( Object.keys( was ).length ) undoStep(
        function()
        {
            for( const a in was )
            {
                const now = sheet.cellStyles[ a ];
                if( was[ a ] ) sheet.cellStyles[ a ] = Object.assign( {}, was[ a ], now );
                else if( now && ! Object.keys( now ).length ) delete sheet.cellStyles[ a ];
            }
        },
        function() { for( const a in was ) { if( plain( a ) ) sheet.cellStyles[ a ] = {}; else delete sheet.cellStyles[ a ]; } } );

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
}

//------------------------------------------------------------------------//
// FORMAT PAINTER
//
// "Copiar formato", as in Write: the button takes the look of the selected
// cells, and the next cells selected get it - all of it, number format and
// borders included, in place of what they had - then it goes off. A block
// painted over a bigger one repeats, as in Excel. A second press of the
// button, or Escape, gives up. One Ctrl+Z takes the paint back off.

const PAINT_MAX = 10000;     // cells copied at most: a whole-column pick is mostly empty rows

let painter = null;          // { looks: [[style|null]], h, w } while it is on

// Also from grid.js with nothing (New, Open): the painter goes off.
function setPainter( p )
{
    painter = p || null;
    document.getElementById( 'fmtPainterBtn' ).classList.toggle( 'active', !! p );
    document.body.classList.toggle( 'calc-painting', !! p );    // the grid's className is reset on New / Open
}

function togglePainter()
{
    if( painter || ! lastSelection ) { setPainter( null ); return; }

    const s = lastSelection;
    const w = Math.min( s.c2 - s.c1 + 1, PAINT_MAX );
    const h = Math.max( 1, Math.min( s.r2 - s.r1 + 1, Math.floor( PAINT_MAX / w ) ) );
    const looks = [];

    for( let r = 0; r < h; r++ )
    {
        const row = [];
        for( let c = 0; c < w; c++ )
        {
            const st = styleOf( activeSheet, s.r1 + r, s.c1 + c );
            row.push( st ? JSON.parse( JSON.stringify( st ) ) : null );
        }
        looks.push( row );
    }

    setPainter( { looks: looks, h: h, w: w } );
}

// From grid.js, on every selection made: when the painter is on, this one
// gets the look.
function paintFormat()
{
    if( ! painter || ! lastSelection ) return;

    const p   = painter;
    const sel = lastSelection;
    setPainter( null );

    // Along a whole line (r or c NaN, see changeLook) the block's first row
    // or column is what repeats.
    const at = function( i, from, n ) { return isNaN( i ) ? 0 : ( ( i - from ) % n + n ) % n; };

    restyle( null, function( st, r, c )
    {
        const look = p.looks[ at( r, sel.r1, p.h ) ][ at( c, sel.c1, p.w ) ];
        for( const k of Object.keys( st ) ) delete st[ k ];
        if( look ) Object.assign( st, JSON.parse( JSON.stringify( look ) ) );
    } );
}

document.addEventListener( 'keydown', function( e ) { if( painter && e.key === 'Escape' ) setPainter( null ); }, true );

// Like setStyleField, but an empty/null value clears the field instead of storing
// it — used by the select-based controls (font, size, number format) whose first
// option means "back to default", not a literal value to persist.
function setOrClearStyleField( field, value )
{
    restyle( null, function( st )
    {
        if( value === '' || value == null ) delete st[ field ];
        else                                st[ field ] = value;
    } );
}

// Paints the small bar under the text/fill colour glyphs to match the picked
// colour — same visual cue TinyMCE's own colour buttons give in the Write app.
function setColorBar( input )
{
    const btn = input.closest( '.fmt-color-btn' );
    if( btn ) btn.style.setProperty( '--fmt-bar', input.value );
}

function updateToolbarActiveState()
{
    const style = lastSelection ? styleOf( activeSheet, lastSelection.r1, lastSelection.c1 ) : null;

    document.getElementById( 'fmtBoldBtn'         ).classList.toggle( 'active', !! ( style && style.bold )      );
    document.getElementById( 'fmtItalicBtn'       ).classList.toggle( 'active', !! ( style && style.italic )    );
    document.getElementById( 'fmtUnderlineBtn'    ).classList.toggle( 'active', !! ( style && style.underline ) );
    document.getElementById( 'fmtBorderBtn'       ).classList.toggle( 'active', !! ( style && style.border )    );
    document.getElementById( 'fmtWrapBtn'         ).classList.toggle( 'active', !! ( style && style.wrap )      );
    document.getElementById( 'fmtAlignLeftBtn'    ).classList.toggle( 'active', !! style && style.align  === 'left'   );
    document.getElementById( 'fmtAlignCenterBtn'  ).classList.toggle( 'active', !! style && style.align  === 'center' );
    document.getElementById( 'fmtAlignRightBtn'   ).classList.toggle( 'active', !! style && style.align  === 'right'  );
    document.getElementById( 'fmtValignTopBtn'    ).classList.toggle( 'active', !! style && style.valign === 'top'    );
    document.getElementById( 'fmtValignMiddleBtn' ).classList.toggle( 'active', !! style && style.valign === 'middle' );
    document.getElementById( 'fmtValignBottomBtn' ).classList.toggle( 'active', !! style && style.valign === 'bottom' );

    const ink = gridColors();
    document.getElementById( 'fmtFontColor'  ).value = '#' + ( ( style && style.color ) || ink.text  );
    document.getElementById( 'fmtFillColor'  ).value = '#' + ( ( style && style.bg )    || ink.paper );
    setColorBar( document.getElementById( 'fmtFontColor' ) );
    setColorBar( document.getElementById( 'fmtFillColor' ) );
    document.getElementById( 'fmtFontFamily' ).value = ( style && style.fontFamily ) || '';
    document.getElementById( 'fmtFontSize'   ).value = ( style && style.size )        || '';
    document.getElementById( 'fmtNumFormat'  ).value = numFmtCategory( style && style.numFmt );

    document.getElementById( 'fmtSplitBtn'     ).disabled = ! mergesInSelection().length;

    document.getElementById( 'fmtFreezeBtn'    ).classList.toggle( 'active', table.getSettings().fixedColumnsStart > 0 );
    document.getElementById( 'fmtFreezeRowBtn' ).classList.toggle( 'active', table.getSettings().fixedRowsTop      > 0 );

    // Alignment, wrap and freeze live inside group cards now, so the bar shows
    // none of the lights above until a card is opened. The two that answer a
    // yes/no question - "¿ajustar texto?", "¿algo inmovilizado?" - hand their
    // light to the button that opens the card (calc.js, groups).
    syncGroupTriggers();
}

// What a cell with no colours of its own is drawn in - the theme's text on
// the grid's paper - as "RRGGBB", for the two pickers to start from: the
// dark theme's pair showed in the light theme too. Read off the page, since
// the light paper is a color-mix() only the browser can work out (a 1x1
// canvas turns any CSS colour into its bytes). Kept until the theme or the
// colour scheme changes.
let inkKey = null;
let ink    = null;

function gridColors()
{
    const root = getComputedStyle( document.documentElement );
    const key  = root.getPropertyValue( '--text' ) + '|' + root.getPropertyValue( '--calc-paper' ) + '|' + root.getPropertyValue( '--bg' ) +
                 '|' + root.getPropertyValue( '--card2' );
    if( ink && key === inkKey ) return ink;

    const probe = document.createElement( 'span' );
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--text);background-color:var(--calc-paper)';
    document.body.appendChild( probe );
    const cs = getComputedStyle( probe );

    const cv  = document.createElement( 'canvas' );
    cv.width  = cv.height = 1;
    const ctx = cv.getContext( '2d', { willReadFrequently: true } );
    const hex = function( css, fallback )
    {
        if( ! ctx || ! css ) return fallback;
        ctx.clearRect( 0, 0, 1, 1 );
        ctx.fillStyle = '#000';
        ctx.fillStyle = css;
        ctx.fillRect( 0, 0, 1, 1 );
        const px = ctx.getImageData( 0, 0, 1, 1 ).data;
        return Array.prototype.slice.call( px, 0, 3 ).map( function( b ) { return ( '0' + b.toString( 16 ) ).slice( -2 ); } ).join( '' ).toUpperCase();
    };

    ink    = { text: hex( cs.color, 'E7E7E9' ), paper: hex( cs.backgroundColor, '1E1F23' ) };
    inkKey = key;
    probe.remove();
    return ink;
}

// Two buttons, one job each: Merge joins the selection into one cell, Split
// takes apart every merged block the selection touches. Merged blocks are
// looked up in activeSheet.merges, the list save/load already tracks
// (Handsontable has no "all merges" call).
function mergesInSelection()
{
    const s = lastSelection;
    if( ! s ) return [];

    return activeSheet.merges.filter( function( m )
    {
        return m.row <= s.r2 && m.row + m.rowspan - 1 >= s.r1 && m.col <= s.c2 && m.col + m.colspan - 1 >= s.c1;
    } );
}

function mergeSelection()
{
    if( ! lastSelection ) return;
    if( lastSelection.r1 === lastSelection.r2 && lastSelection.c1 === lastSelection.c2 ) return;   // one cell: nothing to join

    // No args: the grid's own current selection, which still matches
    // `lastSelection` here since toolbar buttons never blur it.
    table.getPlugin( 'mergeCells' ).mergeSelection();
    updateToolbarActiveState();
    scheduleAutosave();
}

function splitSelection()
{
    const plugin = table.getPlugin( 'mergeCells' );
    const list   = mergesInSelection();
    if( ! list.length ) return;

    // One block at a time: unmerging a range only takes the blocks wholly inside it.
    list.slice().forEach( function( m )
    {
        plugin.unmerge( m.row, m.col, m.row + m.rowspan - 1, m.col + m.colspan - 1 );
    } );
    updateToolbarActiveState();
    scheduleAutosave();
}

// manualColumnFreeze's freezeColumn()/unfreezeColumn() move one column at a time —
// not what "freeze up to the selection" needs, so this sets the underlying
// fixedColumnsStart grid setting directly instead (the plugin only adds the
// interactive drag-to-freeze divider; the setting itself is what the renderer
// actually reads, and it's what the right-click freeze_column/unfreeze_column
// menu items end up changing too, one column at a time).
function toggleFreezeColumns()
{
    if( ! lastSelection ) return;

    const was = table.getSettings().fixedColumnsStart;
    const now = was > 0 ? 0 : ( lastSelection.c1 + 1 );

    table.updateSettings( { fixedColumnsStart: now } );
    undoStep( function() { table.updateSettings( { fixedColumnsStart: was } ); },
              function() { table.updateSettings( { fixedColumnsStart: now } ); } );

    updateToolbarActiveState();
    scheduleAutosave();
}

// The same move for rows. fixedRowsTop is the setting the renderer reads and
// the one encodeFromGrid writes into the file's frozen pane, so a frozen
// header row now survives a save like a frozen column always did.
function toggleFreezeRows()
{
    if( ! lastSelection ) return;

    const was = table.getSettings().fixedRowsTop;
    const now = was > 0 ? 0 : ( lastSelection.r1 + 1 );

    table.updateSettings( { fixedRowsTop: now } );
    undoStep( function() { table.updateSettings( { fixedRowsTop: was } ); },
              function() { table.updateSettings( { fixedRowsTop: now } ); } );

    updateToolbarActiveState();
    scheduleAutosave();
}

//------------------------------------------------------------------------//
// BORDER PICKER — an anchored icon-only popup. Position buttons apply
// immediately to the selection; weight/colour are sticky choices. Borders are
// written per side into `activeSheet.cellStyles` (the same tracked map every other format
// control uses) so they round-trip through save/reopen rather than living only
// in Handsontable's own customBorders plugin.

function openBorderPopup()
{
    if( ! lastSelection ) return;

    const pop  = document.getElementById( 'borderPopup' );

    // In menu mode the toolbar button is collapsed to a zero-height
    // sliver, so the menu row that ran the entry is the honest anchor.
    const rect = menus.anchorRect( '#fmtBorderBtn', CHROME.on(), 'menuBar' );

    pop.style.top  = ( rect.bottom + 4 ) + 'px';
    pop.style.left = rect.left + 'px';
    pop.classList.add( 'open' );

    // nudge back inside the viewport if the button sits near the right edge
    const pr = pop.getBoundingClientRect();
    if( pr.right > window.innerWidth - 8 )
        pop.style.left = Math.max( 8, window.innerWidth - 8 - pr.width ) + 'px';

    syncBorderPopupState();
}

function closeBorderPopup()
{
    document.getElementById( 'borderPopup' ).classList.remove( 'open' );
}

// Reflects the sticky weight choice and the colour swatch in the popup.
function syncBorderPopupState()
{
    document.querySelectorAll( '#borderPopup [data-weight]' ).forEach( function( b )
    {
        b.classList.toggle( 'active', b.dataset.weight === borderWeight );
    });

    document.getElementById( 'borderColor' ).value = '#' + borderColorValue;
    document.getElementById( 'borderColorLabel' ).style.setProperty( '--border-bar', '#' + borderColorValue );
}

// Which sides a given cell in the selection gets, for the picked preset.
function borderSidesFor( pos, r, c, sel )
{
    switch( pos )
    {
        case 'all':
            return [ 'top', 'right', 'bottom', 'left' ];

        case 'outer':
        {
            const out = [];
            if( r === sel.r1 ) out.push( 'top' );
            if( r === sel.r2 ) out.push( 'bottom' );
            if( c === sel.c1 ) out.push( 'left' );
            if( c === sel.c2 ) out.push( 'right' );
            return out;
        }

        case 'inner':
        {
            const out = [];
            if( r !== sel.r2 ) out.push( 'bottom' );
            if( c !== sel.c2 ) out.push( 'right' );
            return out;
        }

        case 'top':    return ( r === sel.r1 ) ? [ 'top' ]    : [];
        case 'bottom': return ( r === sel.r2 ) ? [ 'bottom' ] : [];
        case 'left':   return ( c === sel.c1 ) ? [ 'left' ]   : [];
        case 'right':  return ( c === sel.c2 ) ? [ 'right' ]  : [];

        default:       return [];
    }
}

function applyBorder( pos )
{
    if( ! lastSelection ) { closeBorderPopup(); return; }

    const weight = borderWeight;
    const color  = borderColorValue;

    // A whole row or column has no first or last cell along it, so "outer"
    // draws only its two long edges there (see lookTargets, edge).
    let edge = null;

    restyle( null, function( st, r, c )
    {
        if( pos === 'none' ) { delete st.border; return; }

        const cur  = ( typeof st.border === 'object' && st.border ) ? st.border : {};
        const next = { top: cur.top, right: cur.right, bottom: cur.bottom, left: cur.left };

        borderSidesFor( pos, r, c, edge ).forEach( function( side ) { next[ side ] = true; } );

        [ 'top', 'right', 'bottom', 'left' ].forEach( function( side ) { if( ! next[ side ] ) delete next[ side ]; } );

        if( ! Object.keys( next ).length ) return;   // this cell isn't on the picked edge

        next.style = weight;
        next.color = color;
        st.border  = next;
    }, function( t ) { edge = t.edge; } );

    closeBorderPopup();
}

//------------------------------------------------------------------------//
// NUMBER-FORMAT DIALOG — each dropdown category except "General" opens here to
// fine-tune the Excel format code stored in `activeSheet.cellStyles[*].numFmt` (rendered by
// the SSF engine in styledRenderer, carried into xlsx by objToXlsxStyle).

// Best-effort mapping of a stored format code back to a dropdown category, so the
// control shows the right label as the selection moves between cells.
function numFmtCategory( code )
{
    if( ! code )              return 'general';
    if( /%/.test( code ) )    return 'porcentaje';

    const bare = code.replace( /"[^"]*"/g, '' );   // drop quoted literals first

    if( /[ymdhs]/i.test( bare ) && ! /[0#]/.test( bare ) ) return 'fecha';
    if( /["$€£¥]/.test( code ) )                           return 'moneda';

    return 'numero';
}

function openNumFmtDialog( cat )
{
    if( ! lastSelection ) return;

    nfCategory = cat;

    document.getElementById( 'numFmtTitle' ).textContent =
    ({
        numero    : T( 'calc.fmtNumber' ),
        moneda    : T( 'calc.fmtCurrency' ),
        porcentaje: T( 'calc.fmtPercent' ),
        fecha     : T( 'calc.fmtDate' )
    })[ cat ] || T( 'calc.numFormat' );

    document.querySelectorAll( '#numFmtBackdrop .field[data-nf]' ).forEach( function( row )
    {
        row.style.display = ( row.dataset.nf.split( ' ' ).indexOf( cat ) !== -1 ) ? '' : 'none';
    });

    updateNumFmtPreview();
    NayiveUI.open( 'numFmtBackdrop' );
}

// Assembles an Excel number-format code from the dialog's current field values.
function buildNumFmtCode()
{
    const decimals = Number( document.getElementById( 'nfDecimals' ).value );
    const decPart  = decimals > 0 ? ( '.' + '0'.repeat( decimals ) ) : '';

    if( nfCategory === 'porcentaje' )
        return '0' + decPart + '%';

    if( nfCategory === 'fecha' )
        return document.getElementById( 'nfDatePattern' ).value;

    const thousands = document.getElementById( 'nfThousands' ).checked;
    const redNeg    = document.getElementById( 'nfRedNeg'    ).checked;

    let num = ( thousands ? '#,##0' : '0' ) + decPart;

    if( nfCategory === 'moneda' )
    {
        const sym = document.getElementById( 'nfCurrency'    ).value.trim() || '€';
        const pos = document.getElementById( 'nfCurrencyPos' ).value;

        num = ( pos === 'before' ) ? ( '"' + sym + '" ' + num ) : ( num + ' "' + sym + '"' );
    }

    // `[Red]-<code>` keeps the minus sign; a bare `[Red]<code>` negative section drops it.
    return redNeg ? ( num + ';[Red]-' + num ) : num;
}

function updateNumFmtPreview()
{
    const code = buildNumFmtCode();
    const el   = document.getElementById( 'nfPreview' );

    // A negative sample so "Negativos en rojo" visibly changes the preview
    // (the SSF engine only returns text, so the red colour is applied here).
    const sample = ( nfCategory === 'fecha' )      ? NF_SAMPLE_DATE
                 : ( nfCategory === 'porcentaje' ) ? -0.1256
                                                   : -1234.56;

    try        { el.textContent = localMarks( formatNumber( code, sample ), code ); }   // the language's marks, as in the grid
    catch( _ ) { el.textContent = code; }

    const redNeg = document.getElementById( 'nfRedNeg' ).checked && ( nfCategory === 'numero' || nfCategory === 'moneda' );
    el.style.color = redNeg ? 'var(--danger)' : '';
}

function confirmNumFmt()
{
    setOrClearStyleField( 'numFmt', buildNumFmtCode() );
    NayiveUI.close( 'numFmtBackdrop' );
}

// Closing without applying must also put the dropdown back to the selected cell's
// real category — the change event that opened the dialog already moved it off.
function cancelNumFmt()
{
    NayiveUI.close( 'numFmtBackdrop' );

    const st = lastSelection ? styleOf( activeSheet, lastSelection.r1, lastSelection.c1 ) : null;

    document.getElementById( 'fmtNumFormat' ).value = numFmtCategory( st && st.numFmt );
}

export
{
    toggleStyleField, setStyleField, clearSelectionStyle, setOrClearStyleField, setColorBar,
    updateToolbarActiveState, mergeSelection, splitSelection, mergesInSelection, toggleFreezeColumns, toggleFreezeRows,
    openBorderPopup, closeBorderPopup, syncBorderPopupState, applyBorder, openNumFmtDialog,
    updateNumFmtPreview, confirmNumFmt, cancelNumFmt, gridColors, togglePainter, paintFormat, setPainter
};
