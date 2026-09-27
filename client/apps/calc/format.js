/*
 * format.js - Calc's cell formatting: the formatting toolbar, the border
 * picker and the number-format dialog. Imported by calc.js.
 *
 * Its top level runs BEFORE calc.js's `await NayiveI18n.ready`: nothing out
 * here may call T() or read another file's names - keep that inside functions.
 */

import
{
    encodeCell, formatNumber
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
    table, activeSheet, lastSelection, localMarks, undoStep
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

function toggleStyleField( field )
{
    if( ! lastSelection ) return;

    // Mirror the anchor cell's current state, so a mixed selection turns fully on.
    const anchorAddr = encodeCell( { r: lastSelection.r1, c: lastSelection.c1 } );
    const turnOn      = ! ( activeSheet.cellStyles[ anchorAddr ] && activeSheet.cellStyles[ anchorAddr ][ field ] );

    forEachSelectedCell( function( addr )
    {
        activeSheet.cellStyles[ addr ] = activeSheet.cellStyles[ addr ] || {};
        activeSheet.cellStyles[ addr ][ field ] = turnOn;
    });

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
}

function setStyleField( field, value )
{
    if( ! lastSelection ) return;

    forEachSelectedCell( function( addr )
    {
        activeSheet.cellStyles[ addr ] = activeSheet.cellStyles[ addr ] || {};
        activeSheet.cellStyles[ addr ][ field ] = value;
    });

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
}

function clearSelectionStyle()
{
    if( ! lastSelection ) return;

    // Ctrl+Z puts the formats back (undoStep), under any style set on those
    // cells since - that one stays on top. The sheet itself is kept: a sort
    // gives it a new cellStyles object (and clears Ctrl+Z anyway).
    const sheet = activeSheet;
    const was   = {};

    forEachSelectedCell( function( addr )
    {
        if( sheet.cellStyles[ addr ] ) was[ addr ] = sheet.cellStyles[ addr ];
        delete sheet.cellStyles[ addr ];
    } );

    if( Object.keys( was ).length ) undoStep(
        function() { for( const a in was ) sheet.cellStyles[ a ] = Object.assign( {}, was[ a ], sheet.cellStyles[ a ] ); },
        function() { for( const a in was ) delete sheet.cellStyles[ a ]; } );

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
}

// Like setStyleField, but an empty/null value clears the field instead of storing
// it — used by the select-based controls (font, size, number format) whose first
// option means "back to default", not a literal value to persist.
function setOrClearStyleField( field, value )
{
    if( ! lastSelection ) return;

    forEachSelectedCell( function( addr )
    {
        if( value === '' || value == null )
        {
            if( activeSheet.cellStyles[ addr ] ) delete activeSheet.cellStyles[ addr ][ field ];
        }
        else
        {
            activeSheet.cellStyles[ addr ] = activeSheet.cellStyles[ addr ] || {};
            activeSheet.cellStyles[ addr ][ field ] = value;
        }
    });

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
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
    const anchorAddr = lastSelection ? encodeCell( { r: lastSelection.r1, c: lastSelection.c1 } ) : null;
    const style      = anchorAddr ? activeSheet.cellStyles[ anchorAddr ] : null;

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

    document.getElementById( 'fmtFontColor'  ).value = '#' + ( ( style && style.color ) || 'E7E7E8' );
    document.getElementById( 'fmtFillColor'  ).value = '#' + ( ( style && style.bg )    || '202124' );
    setColorBar( document.getElementById( 'fmtFontColor' ) );
    setColorBar( document.getElementById( 'fmtFillColor' ) );
    document.getElementById( 'fmtFontFamily' ).value = ( style && style.fontFamily ) || '';
    document.getElementById( 'fmtFontSize'   ).value = ( style && style.size )        || '';
    document.getElementById( 'fmtNumFormat'  ).value = numFmtCategory( style && style.numFmt );

    document.getElementById( 'fmtFreezeBtn'    ).classList.toggle( 'active', table.getSettings().fixedColumnsStart > 0 );
    document.getElementById( 'fmtFreezeRowBtn' ).classList.toggle( 'active', table.getSettings().fixedRowsTop      > 0 );

    // Alignment, wrap and freeze live inside group cards now, so the bar shows
    // none of the lights above until a card is opened. The two that answer a
    // yes/no question - "¿ajustar texto?", "¿algo inmovilizado?" - hand their
    // light to the button that opens the card (calc.js, groups).
    syncGroupTriggers();
}

// Merged range membership has no direct query API, so the anchor cell's
// address is looked up in the same activeSheet.merges list save/load already tracks.
function toggleMergeSelection()
{
    if( ! lastSelection ) return;

    const plugin  = table.getPlugin( 'mergeCells' );
    const already = activeSheet.merges.some( function( m ) { return m.row === lastSelection.r1 && m.col === lastSelection.c1; } );

    // No args: both methods default to the grid's own current selection, which
    // still matches `lastSelection` here since toolbar buttons never blur it.
    if( already ) plugin.unmergeSelection();
    else           plugin.mergeSelection();

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

    const frozen = table.getSettings().fixedColumnsStart > 0;

    table.updateSettings( { fixedColumnsStart: frozen ? 0 : ( lastSelection.c1 + 1 ) } );

    updateToolbarActiveState();
    scheduleAutosave();
}

// The same move for rows. fixedRowsTop is the setting the renderer reads and
// the one encodeFromGrid writes into the file's frozen pane, so a frozen
// header row now survives a save like a frozen column always did.
function toggleFreezeRows()
{
    if( ! lastSelection ) return;

    const frozen = table.getSettings().fixedRowsTop > 0;

    table.updateSettings( { fixedRowsTop: frozen ? 0 : ( lastSelection.r1 + 1 ) } );

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
    const sel    = lastSelection;

    for( let r = sel.r1; r <= sel.r2; r++ )
    {
        for( let c = sel.c1; c <= sel.c2; c++ )
        {
            const addr = encodeCell( { r: r, c: c } );

            if( pos === 'none' )
            {
                if( activeSheet.cellStyles[ addr ] ) delete activeSheet.cellStyles[ addr ].border;
                continue;
            }

            const cur  = ( activeSheet.cellStyles[ addr ] && typeof activeSheet.cellStyles[ addr ].border === 'object' ) ? activeSheet.cellStyles[ addr ].border : {};
            const next = { top: cur.top, right: cur.right, bottom: cur.bottom, left: cur.left };

            borderSidesFor( pos, r, c, sel ).forEach( function( side ) { next[ side ] = true; } );

            [ 'top', 'right', 'bottom', 'left' ].forEach( function( side ) { if( ! next[ side ] ) delete next[ side ]; } );

            if( ! Object.keys( next ).length ) continue;   // this cell isn't on the picked edge

            next.style = weight;
            next.color = color;

            activeSheet.cellStyles[ addr ] = activeSheet.cellStyles[ addr ] || {};
            activeSheet.cellStyles[ addr ].border = next;
        }
    }

    table.render();
    updateToolbarActiveState();
    scheduleAutosave();
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

    const anchor = lastSelection ? encodeCell( { r: lastSelection.r1, c: lastSelection.c1 } ) : null;
    const st     = anchor ? activeSheet.cellStyles[ anchor ] : null;

    document.getElementById( 'fmtNumFormat' ).value = numFmtCategory( st && st.numFmt );
}

export
{
    toggleStyleField, setStyleField, clearSelectionStyle, setOrClearStyleField, setColorBar,
    updateToolbarActiveState, toggleMergeSelection, toggleFreezeColumns, toggleFreezeRows,
    openBorderPopup, closeBorderPopup, syncBorderPopupState, applyBorder, openNumFmtDialog,
    updateNumFmtPreview, confirmNumFmt, cancelNumFmt
};
