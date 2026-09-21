/*
 * calc.js - Calc: a spreadsheet editor (xlsx / csv) over the user's files.
 * Handsontable + HyperFormula. Loaded as a module by index.html, after the
 * shared classic scripts. This is the app itself: start-up, the open file,
 * the toolbar wiring, the formula bar, the function picker and the menus.
 * grid.js, format.js and codec.js hold the rest. The four import each other;
 * every use across files sits inside a function, so the order they load in
 * does not matter - and this one, the entry, always runs last.
 */

// Nothing is drawn from JS before the dictionary is in: without an
// in-source fallback, an early render would paint the bare keys.
await NayiveI18n.ready;

import
{
    decodeRange, encodeCell
}
from './lib/xlsx-format_v2.4.1.js';
import
{
    table, doc, activeSheet, gridBooting, lastSelection, htThemeName, CM_ICONS,
    switchToSheet, sortByColumn, initGrid, wireFormulaPanel, pasteWithoutStyles
}
from './grid.js';
import
{
    toggleStyleField, setStyleField, clearSelectionStyle, setOrClearStyleField, setColorBar,
    toggleMergeSelection, toggleFreezeColumns, toggleFreezeRows, openBorderPopup,
    closeBorderPopup, syncBorderPopupState, applyBorder, openNumFmtDialog,
    updateNumFmtPreview, confirmNumFmt, cancelNumFmt
}
from './format.js';
import
{
    decodeToDoc, encodeFromGrid
}
from './codec.js';

//------------------------------------------------------------------------//
// STATE

// Folder for "Guardar como". Drive opens Calc with ?dir=<folder> so a new
// sheet saves in the folder the user is in; from the launcher (no ?dir=)
// it defaults to the user's files/ root.
const O = NayiveOffice;   // paths, the file label, the Open browser (../shared/office.js)

// Folder for "Guardar como": Drive's ?dir=<folder>, else the files/ root.
const APP_DIR = O.appDirFromUrl();

// Extensions the "Abrir documento" browser shows. xlsx / csv open
// straight away; a file in CONVERT_EXTS (LibreOffice Calc .ods, legacy
// .xls, …) would be converted to .xlsx on the server first — that isn't
// wired up yet, so CONVERT_EXTS is empty and only the two appear.
const OPEN_EXTS     = [ 'xlsx', 'csv' ];
const CONVERT_EXTS  = [];
const OPENABLE_EXTS = OPEN_EXTS.concat( CONVERT_EXTS );

// The browser never walks above the user's files/ root (the first path
// segment of APP_DIR — "files" when Calc is opened from the launcher).
const OPEN_ROOT = APP_DIR.split( '/' )[ 0 ] || 'files';

// Sample serial (2026-12-31 14:30) for the number-format dialog's live preview.
const NF_SAMPLE_DATE = Math.round( ( Date.UTC( 2026, 11, 31 ) - Date.UTC( 1899, 11, 30 ) ) / 86400000 ) + 14.5 / 24;

let borderWeight     = 'thin';   // sticky border-popup choices
let borderColorValue = '8B8E93';

// Offline-capable persistence (../shared/store.js), same as Write. Every
// save lands in a local IndexedDB cache and a write outbox BEFORE the PUT
// is attempted, so a caducated session or a dropped connection can no
// longer lose the sheet: it goes up on the next flush (reconnect, tab
// focus, or right after signing in again). binary:true - the bodies here
// are .xlsx/.ods bytes, not text.
// Interface strings: every one of them lives in shared/i18n/*.json.
const T  = k           => NayiveUI.t( k );
const TF = ( k, vars ) => NayiveUI.tf( k, vars );

// conflicts: a save over a sheet changed on another device since it was
// opened is refused (shared/store.js, CONFLICTS).
const store = NayiveStore.createStore( { apiBase: GumApi.API_FILES, binary: true, conflicts: true } );

// The Open browser: a shared widget, this app only says what it lists.
// The open sheet - its path, whether it is someone else's, its name, the
// top-bar label, New / Open / Import / "Guardar como" / rename / Restore,
// start-up, the header plug and the autosave - is the one Write and Text
// use (shared/office.js, THE OPEN DOCUMENT). Calc only says how a sheet
// becomes bytes and back, which files it can open, and keeps an
// extension on a rename.
const session = O.session( {
    app        : 'calc',
    store      : store,
    appDir     : APP_DIR,
    openRoot   : OPEN_ROOT,
    defaultName: 'hoja.xlsx',
    canOpen    : isOpenable,                                    // what the Open dialog lists
    onPick     : function( p ) { openPickedFile( p ); },        // a foreign format is converted first
    emptyKey   : 'calc.noSheets',
    // A draft is always .xlsx: a .csv would lose the formatting.
    encode     : function( path ) { return encodeFromGrid( path ? O.extOf( path ) : 'xlsx' ); },
    load       : loadSheet,
    blank      : function() { initGrid( null ); },
    renameName : keepExt,
    // THE LOSS GATE's hard stop, checked on every edit AND every write -
    // Ctrl+S and the pagehide flush never pass through an edit. Writing
    // somewhere NEW is always let through: that is the "save a copy" way
    // out of the dialog.
    blocked    : function( path ) { return path === session.path() && lossyBlocked(); },
    onSavedAs  : sheetSavedAs,
    // a cell half typed (maybe a formula picked with the mouse): the name can wait
    busy       : function() { const ed = table && table.getActiveEditor(); return !! ( ed && ed.isOpened() ); },
    // listen() alone leaves the keys on <body>: the grid needs DOM focus back
    focus      : function() { if( table ) { table.listen(); table.getFocusManager().focusOnHighlightedCell(); } }
} );

//--------------------------------------------------------------------//
// PHONE CHROME  (see the phone block in the CSS above)
//
// Two moves, both phone-only: the toolbar is ONE row of favourites with a
// "⋮" that opens the rest in place, and the whole strip folds away the
// moment a cell editor opens (the keyboard is about to take half the
// screen). The header's "Aa" brings it back.
//
// The file buttons are NOT one of those two moves any more: they are behind
// the header's "⋮" on every screen, PC included, because a toolbar with
// thirty-eight controls on it was no easier to read than a phone's.

const PHONE = window.matchMedia( '(max-width: 640px)' );

// AYUDA, wherever it is asked for: the pull-down Ayuda menu and the toolbar's
// "?" show the SAME three entries, each clicking its own real button - so the
// two chromes cannot drift and there is still one set of handlers.
const HELP_ITEMS =
[
    { key: 'write.stats',       el: 'statsBtn' },
    { key: 'write.shortcuts',   el: 'scBtn'    },
    { key: 'ui.toolbarButtons', el: 'guideBtn' }
];
const HELP_IDS = HELP_ITEMS.map( function( it ) { return it.el; } );

const fileMenu = O.fileMenu( { btn: 'moreBtn', menu: 'topMenu',
                               ids: [ 'newBtn', 'openBtn', 'importBtn', 'saveAsBtn', 'restoreBtn', 'lockBtn', 'scBtn' ] } );

// Ayuda on the "?" - the three entries HELP_ITEMS names. setHelpMenu tells
// shared/ui.js to leave the click to this menu instead of opening the guide
// card itself; the card is the third entry.
const helpMenu = O.buttonMenu( { btn: 'helpBtn', menu: 'helpMenu', ids: HELP_IDS } );
NayiveUI.setHelpMenu( true );

// ---- the toolbar's group cards (shared/office.js, groupPopup) ----
// Four runs of near-identical buttons that cost fifteen slots on the bar and
// now cost four. The buttons are THE REAL ONES, sitting inside the cards in
// index.html: their click handlers below are wired exactly as before and
// format.js still lights them up. Only `align` and `freeze` hold toggles, so
// only their triggers can light up - syncToolbar() calls sync() on both.
const groups =
[
    O.groupPopup( { btn: 'fmtTableBtn',     popup: 'tablePopup'  } ),
    O.groupPopup( { btn: 'fmtSortBtn',      popup: 'sortPopup'   } ),
    O.groupPopup( { btn: 'fmtAlignBtn',     popup: 'alignPopup',  activeFrom: [ 'fmtWrapBtn' ] } ),
    O.groupPopup( { btn: 'fmtFreezeGrpBtn', popup: 'freezePopup', activeFrom: [ 'fmtFreezeBtn', 'fmtFreezeRowBtn' ] } )
];

// Called by format.js after every toolbar refresh.
function syncGroupTriggers() { groups.forEach( function( g ) { if( g ) g.sync(); } ); }
function closeGroupPopups()  { groups.forEach( function( g ) { if( g ) g.close(); } ); }

// Folding sets height:0 rather than display:none - Handsontable sizes
// itself to the space left over and re-renders on resize either way.
const fold = O.foldingToolbar( { toolbar: 'fmtToolbar', afterChange: function() { if( table ) table.refreshDimensions(); } } );

// Once at start-up and again whenever the phone is turned. The split
// itself is pure CSS, so this only does what CSS cannot: move the "?",
// close the menus, unfold.
function applyPhoneChrome()
{
    // The "?" moves to the header on a phone, where the toolbar folds away
    // while you type - but NEVER in menu mode: the Ayuda menu is right
    // there, and one "?" in two places at once is one too many. (The
    // coach marks skip a "?" they cannot see and try again later, so
    // hiding it costs nothing - shared/ui.js, coachTargets.)
    const headerHelp = PHONE.matches && ! CHROME.on();

    O.placeHelpButton( headerHelp, 'topActions', 'fmtToolbar', 'moreToolsBtn', 'savedAt' );
    fileMenu.close();
    if( helpMenu ) helpMenu.close();
    closeGroupPopups();
    fold.setMore( false );
    if( ! PHONE.matches ) fold.setOpen( true );
}

function wireStaticUI()
{
    registerUiLocale();

    // ---- phone chrome (see PHONE CHROME above) ----
    applyPhoneChrome();
    PHONE.addEventListener( 'change', applyPhoneChrome );

    // New, Open, Import, "Guardar como" and Restore are wired by the session
    // (shared/office.js); the dialogs' × buttons and Escape once for every
    // app by shared/ui.js.

    // Border popup: position buttons are actions; weight/colour are sticky mode choices.
    document.getElementById( 'borderPopup' ).addEventListener( 'mousedown', function( e )
    {
        if( ! e.target.closest( '#borderColorLabel' ) ) e.preventDefault();   // keep the grid selection; let the colour picker open
    });
    document.getElementById( 'borderPopup' ).addEventListener( 'click', function( e )
    {
        const posBtn = e.target.closest( '[data-pos]' );
        if( posBtn ) { applyBorder( posBtn.dataset.pos ); return; }

        const wBtn = e.target.closest( '[data-weight]' );
        if( wBtn ) { borderWeight = wBtn.dataset.weight; syncBorderPopupState(); }
    });
    document.getElementById( 'borderColor' ).addEventListener( 'input', function( e )
    {
        borderColorValue = e.target.value.replace( '#', '' ).toUpperCase();
        syncBorderPopupState();
    });

    document.getElementById( 'numFmtCloseBtn'   ).addEventListener( 'click', cancelNumFmt );
    document.getElementById( 'numFmtConfirmBtn' ).addEventListener( 'click', confirmNumFmt );
    [ 'nfDecimals', 'nfThousands', 'nfRedNeg', 'nfCurrency', 'nfCurrencyPos', 'nfDatePattern' ].forEach( function( id )
    {
        document.getElementById( id ).addEventListener( 'input', updateNumFmtPreview );
    });

    // Outside click / ESC dismiss the border popup and any open dialog.
    document.addEventListener( 'click', function( e )
    {
        const pop = document.getElementById( 'borderPopup' );
        if( pop.classList.contains( 'open' ) && ! pop.contains( e.target ) && ! e.target.closest( '#fmtBorderBtn' ) )
            closeBorderPopup();
    });
    document.addEventListener( 'keydown', function( e )
    {
        // Ctrl/Cmd+S: save now (an untitled sheet goes to "Guardar como"), as in Text and Write.
        if( ( e.ctrlKey || e.metaKey ) && e.key.toLowerCase() === 's' )
        {
            e.preventDefault();
            saveNow();
            return;
        }
        // Ctrl/Cmd+B, I, U format the selection — unless something is being
        // typed into, where they belong to the text.
        //
        // "Is a text field focused?" is the wrong test here: Handsontable
        // keeps focus in a hidden <textarea> whenever the grid is active, so
        // a plain input/textarea check never lets these through at all. What
        // actually matters is whether the CELL EDITOR is open, plus the two
        // boxes of the formula row, which are real inputs of ours outside
        // the grid.
        if( ( e.ctrlKey || e.metaKey ) && ! e.altKey && 'biu'.indexOf( e.key.toLowerCase() ) !== -1 )
        {
            if( e.target && ( e.target.id === 'nameBox' || e.target.id === 'formulaBar' ) ) return;
            if( ! table || ! lastSelection ) return;

            const editor = table.getActiveEditor && table.getActiveEditor();
            if( editor && typeof editor.isOpened === 'function' && editor.isOpened() ) return;

            e.preventDefault();
            toggleStyleField( { b: 'bold', i: 'italic', u: 'underline' }[ e.key.toLowerCase() ] );
            return;
        }
        // Ctrl/Cmd+Shift+V: paste without the copied cells' formatting. Caught
        // here rather than left to Handsontable, whose own paste always lays
        // the styles back down (see CLIPBOARD STYLES in grid.js). Same guards
        // as the three above: the cell editor and the formula row own their
        // own keys.
        if( ( e.ctrlKey || e.metaKey ) && e.shiftKey && ! e.altKey && e.code === 'KeyV' )
        {
            if( e.target && ( e.target.id === 'nameBox' || e.target.id === 'formulaBar' ) ) return;
            if( ! table || ! lastSelection ) return;

            const cellEditor = table.getActiveEditor && table.getActiveEditor();
            if( cellEditor && typeof cellEditor.isOpened === 'function' && cellEditor.isOpened() ) return;

            e.preventDefault();
            clipPastePlain();
            return;
        }
        // Escape on the border popup; the "⋮" menu and every dialog are closed by shared/ui.js.
        if( e.key === 'Escape' && document.getElementById( 'borderPopup' ).classList.contains( 'open' ) )
        {
            e.preventDefault();
            closeBorderPopup();
        }
    });

    document.getElementById( 'undoBtn'  ).addEventListener( 'click', function() { table.undo(); } );
    document.getElementById( 'redoBtn'  ).addEventListener( 'click', function() { table.redo(); } );

    document.getElementById( 'fxBtn'        ).addEventListener( 'click', openFxPicker );
    document.getElementById( 'fxSearch'     ).addEventListener( 'input', function( e ) { renderFxList( e.target.value ); } );
    wireFormulaPanel();

    // The loss gate's three ways out. The "x" (and Escape) are wired by
    // shared/ui.js and mean "do not write" — the edit stays in the grid,
    // the file on disk is untouched, and the dialog comes back on the next
    // save. So only the other two need a handler here.
    document.getElementById( 'lossyAnywayBtn' ).addEventListener( 'click', function()
    {
        doc.lossyAck = true;                 // for this file, until it is closed
        NayiveUI.close( 'lossyBackdrop' );
        saveNow();
    } );
    document.getElementById( 'lossyCopyBtn' ).addEventListener( 'click', function()
    {
        NayiveUI.close( 'lossyBackdrop' );
        session.openSaveAs();                // a copy Calc CAN write, original intact
    } );
    document.getElementById( 'fxList'       ).addEventListener( 'click', function( e )
    {
        const btn = e.target.closest( '.fx-item' );
        if( btn ) insertFunction( btn.dataset.fn );
    });

    document.getElementById( 'insRowBtn' ).addEventListener( 'click', function() { if( lastSelection ) table.alter( 'insert_row_below', lastSelection.r1 ); } );
    document.getElementById( 'delRowBtn' ).addEventListener( 'click', function() { if( lastSelection ) table.alter( 'remove_row', lastSelection.r1, lastSelection.r2 - lastSelection.r1 + 1 ); } );
    document.getElementById( 'insColBtn' ).addEventListener( 'click', function() { if( lastSelection ) table.alter( 'insert_col_end', lastSelection.c1 ); } );
    document.getElementById( 'delColBtn' ).addEventListener( 'click', function() { if( lastSelection ) table.alter( 'remove_col', lastSelection.c1, lastSelection.c2 - lastSelection.c1 + 1 ); } );

    document.getElementById( 'fmtFontFamily' ).addEventListener( 'change', function( e ) { setOrClearStyleField( 'fontFamily', e.target.value ); } );
    document.getElementById( 'fmtFontSize'   ).addEventListener( 'change', function( e ) { setOrClearStyleField( 'size', e.target.value ? Number( e.target.value ) : null ); } );

    document.getElementById( 'fmtBoldBtn'        ).addEventListener( 'click', function() { toggleStyleField( 'bold' ); } );
    document.getElementById( 'fmtItalicBtn'      ).addEventListener( 'click', function() { toggleStyleField( 'italic' ); } );
    document.getElementById( 'fmtUnderlineBtn'   ).addEventListener( 'click', function() { toggleStyleField( 'underline' ); } );
    document.getElementById( 'fmtBorderBtn'      ).addEventListener( 'click', function( e )
    {
        e.stopPropagation();
        const pop = document.getElementById( 'borderPopup' );
        if( pop.classList.contains( 'open' ) ) closeBorderPopup();
        else                                   openBorderPopup();
    });
    document.getElementById( 'fmtAlignLeftBtn'   ).addEventListener( 'click', function() { setStyleField( 'align', 'left'   ); } );
    document.getElementById( 'fmtAlignCenterBtn' ).addEventListener( 'click', function() { setStyleField( 'align', 'center' ); } );
    document.getElementById( 'fmtAlignRightBtn'  ).addEventListener( 'click', function() { setStyleField( 'align', 'right'  ); } );
    document.getElementById( 'fmtValignTopBtn'   ).addEventListener( 'click', function() { setStyleField( 'valign', 'top'    ); } );
    document.getElementById( 'fmtValignMiddleBtn').addEventListener( 'click', function() { setStyleField( 'valign', 'middle' ); } );
    document.getElementById( 'fmtValignBottomBtn').addEventListener( 'click', function() { setStyleField( 'valign', 'bottom' ); } );
    document.getElementById( 'fmtWrapBtn'        ).addEventListener( 'click', function() { toggleStyleField( 'wrap' ); } );
    document.getElementById( 'fmtClearBtn'       ).addEventListener( 'click', clearSelectionStyle );
    document.getElementById( 'fmtFontColor'      ).addEventListener( 'input', function( e ) { setStyleField( 'color', e.target.value.replace( '#', '' ).toUpperCase() ); setColorBar( e.target ); } );
    document.getElementById( 'fmtFillColor'      ).addEventListener( 'input', function( e ) { setStyleField( 'bg',    e.target.value.replace( '#', '' ).toUpperCase() ); setColorBar( e.target ); } );
    document.getElementById( 'fmtNumFormat'      ).addEventListener( 'change', function( e )
    {
        if( e.target.value === 'general' ) setOrClearStyleField( 'numFmt', '' );
        else                               openNumFmtDialog( e.target.value );
    });

    document.getElementById( 'fmtMergeBtn' ).addEventListener( 'click', toggleMergeSelection );
    document.getElementById( 'nameBox' ).addEventListener( 'keydown', function( e )
    {
        if( e.key === 'Enter' )  { e.preventDefault(); gotoReference( e.target.value ); }
        if( e.key === 'Escape' ) { e.preventDefault(); refreshNameBox(); table.listen(); }
    } );
    document.getElementById( 'nameBox' ).addEventListener( 'blur', refreshNameBox );

    // The formula bar (see THE FORMULA BAR below). Enter writes it into the
    // cell and moves down, as every spreadsheet does; Escape gives up and
    // hands the keyboard back to the grid. Leaving the bar with something
    // typed in it writes it too — clicking a toolbar button must not throw
    // the edit away — and that is why a commit always goes to the cell the
    // bar was FILLED FROM, never to whatever is selected by then.
    const fBar = document.getElementById( 'formulaBar' );

    fBar.addEventListener( 'input', function() { barDirty = true; } );
    fBar.addEventListener( 'blur',  function() { commitFormulaBar( false ); refreshFormulaBar(); } );
    fBar.addEventListener( 'keydown', function( e )
    {
        if( e.key === 'Enter' )
        {
            e.preventDefault();
            commitFormulaBar( true );
        }
        if( e.key === 'Escape' )
        {
            e.preventDefault();
            barDirty = false;
            e.target.blur();          // the refresh only fills a box nobody is typing in
            refreshFormulaBar();
            table.listen();
        }
    } );

    document.getElementById( 'sortAscBtn'      ).addEventListener( 'click', function() { sortByColumn( false ); } );
    document.getElementById( 'sortDescBtn'     ).addEventListener( 'click', function() { sortByColumn( true  ); } );
    document.getElementById( 'scBtn'           ).addEventListener( 'click', openShortcuts );
    document.getElementById( 'statsBtn'        ).addEventListener( 'click', openStats );
    document.getElementById( 'guideBtn'        ).addEventListener( 'click', function() { NayiveUI.showIntro(); } );

    document.getElementById( 'fmtFreezeBtn'    ).addEventListener( 'click', toggleFreezeColumns );
    document.getElementById( 'fmtFreezeRowBtn' ).addEventListener( 'click', toggleFreezeRows );

    // Toolbar buttons must not steal focus from the grid — mousedown would blur the
    // active cell/clear its selection before the click handler ever runs.
    document.querySelectorAll( '.fmt-btn' ).forEach( function( btn ) { btn.addEventListener( 'mousedown', function( e ) { e.preventDefault(); } ); } );

    // ---- toolbar or pull-down menus (see PULL-DOWN MENUS below) ----
    // The bar itself was built and wired when `menus` was created; this
    // only hangs the two header buttons and paints the remembered choice.
    CHROME.wire();
    CHROME.apply();
}

// Handsontable only ships an en-US dictionary here, so the one the app uses
// is built at runtime: start from en-US and translate the phrases this
// app's context menu can surface, from shared/i18n/*.json. Anything not
// listed stays as en-US. Registered under the fixed code HT_LOCALE
// whatever the language is, so `language:` below never has to change.
const HT_LOCALE = 'nayive';

function registerUiLocale()
{
    const en = Handsontable.languages.getLanguageDictionary( 'en-US' );

    const t =
    {
        'Insert row above'    : T( 'calc.ht.insRowAbove' ),
        'Insert row below'    : T( 'calc.ht.insRowBelow' ),
        'Insert column left'  : T( 'calc.ht.insColLeft' ),
        'Insert column right' : T( 'calc.ht.insColRight' ),
        'Remove row'          : T( 'calc.ht.rmRow' ),
        'Remove rows'         : T( 'calc.ht.rmRows' ),
        'Remove column'       : T( 'calc.ht.rmCol' ),
        'Remove columns'      : T( 'calc.ht.rmCols' ),
        'Undo'                : T( 'ui.undo' ),
        'Redo'                : T( 'ui.redo' ),
        'Copy'                : T( 'ui.copy' ),
        'Cut'                 : T( 'ui.cut' ),
        'Merge cells'         : T( 'calc.mergeCells' ),
        'Unmerge cells'       : T( 'calc.ht.unmerge' ),
        'Freeze column'       : T( 'calc.ht.freezeCol' ),
        'Unfreeze column'     : T( 'calc.ht.unfreezeCol' ),
        'Borders'             : T( 'calc.borders' ),
        'Top'                 : T( 'calc.ht.top' ),
        'Right'               : T( 'calc.ht.right' ),
        'Bottom'              : T( 'calc.ht.bottom' ),
        'Left'                : T( 'calc.ht.left' ),
        'Remove border(s)'    : T( 'calc.ht.rmBorders' ),
        'Add comment'         : T( 'calc.ht.addComment' ),
        'Edit comment'        : T( 'calc.ht.editComment' ),
        'Delete comment'      : T( 'calc.ht.delComment' ),
        'Read-only comment'   : T( 'calc.ht.roComment' ),
        'No available options': T( 'calc.ht.noOptions' ),
        'OK'                  : T( 'ui.accept' ),
        'Cancel'              : T( 'ui.cancel' )
    };

    const dict = {};

    Object.keys( en ).forEach( function( key )
    {
        const val = en[ key ];
        dict[ key ] = Array.isArray( val )
                    ? val.map( function( s ) { return t[ s ] || s; } )
                    : ( t[ val ] || val );
    });

    dict.languageCode = HT_LOCALE;

    Handsontable.languages.registerLanguageDictionary( dict );
}

//------------------------------------------------------------------------//
// THE SHEET AS A FILE  (what the session in shared/office.js needs from Calc)

// A body on screen: opened, imported, the device draft (always .xlsx) or
// the .bak copy. A file Calc cannot read throws, and the session says so.
async function loadSheet( body, name, how )
{
    initGrid( await decodeToDoc( body, how === 'draft' ? 'xlsx' : O.extOf( name ) ) );
}

// A rename keeps the file's own extension whatever was typed, so a stray
// or wrong one can't make the sheet look like another format.
function keepExt( typed, path )
{
    const ext  = O.extOf( path );
    const base = typed.replace( /\.[a-z0-9]+$/i, '' );
    return ext ? base + '.' + ext : base;
}

// What "Guardar como" just wrote came out of Calc's own model, so it holds
// nothing the next save could destroy. The original keeps its charts.
function sheetSavedAs()
{
    doc.lossy    = [];
    doc.lossyAck = false;
}

//------------------------------------------------------------------------//
// NAME BOX, FORMULA BAR AND SELECTION TOTALS
//
// All three hang off one thing: whatever is selected. afterSelectionEnd
// already fires for every way a selection can change, so all three are
// refreshed there — the formula bar from afterChange as well, since undo,
// paste and fx change the cell under the cursor without moving it.

function refreshNameBox()
{
    const box = document.getElementById( 'nameBox' );
    if( ! box || box === document.activeElement ) return;   // don't fight what is being typed

    if( ! lastSelection ) { box.value = ''; return; }

    const a = encodeCell( { r: lastSelection.r1, c: lastSelection.c1 } );
    const b = encodeCell( { r: lastSelection.r2, c: lastSelection.c2 } );

    box.value = ( a === b ) ? a : ( a + ':' + b );
}

// "B12", "b12", "B2:D5", or "Notas!A1" to land on another sheet.
function gotoReference( raw )
{
    const text = String( raw || '' ).trim();
    if( ! text ) return;

    let ref = text;
    const bang = text.lastIndexOf( '!' );

    if( bang !== -1 )
    {
        const wanted = text.slice( 0, bang ).replace( /^'|'$/g, '' );
        const i      = doc.sheets.findIndex( function( sh ) { return sh.name === wanted; } );

        if( i === -1 ) { NayiveUI.toast( T( 'calc.gotoNoSheet' ) ); return; }

        ref = text.slice( bang + 1 );
        if( i !== doc.active ) switchToSheet( i );
    }

    // decodeRange happily returns nonsense for nonsense, so the result is
    // checked rather than trusted.
    let r;
    try { r = decodeRange( ref.toUpperCase().replace( /\$/g, '' ) ); }
    catch( _ ) { r = null; }

    if( ! r || ! isFinite( r.s.r ) || ! isFinite( r.s.c ) || r.s.r < 0 || r.s.c < 0 )
    {
        NayiveUI.toast( T( 'calc.gotoBadRef' ) );
        return;
    }

    const lastRow = table.countRows() - 1;
    const lastCol = table.countCols() - 1;
    const r1 = Math.min( r.s.r, lastRow ), c1 = Math.min( r.s.c, lastCol );
    const r2 = Math.min( isFinite( r.e.r ) ? r.e.r : r.s.r, lastRow );
    const c2 = Math.min( isFinite( r.e.c ) ? r.e.c : r.s.c, lastCol );

    table.selectCell( r1, c1, r2, c2 );
    table.listen();
}

//---- THE FORMULA BAR ---------------------------------------------------
//
// The second way to edit a cell, the one LibreOffice Calc and Excel have:
// the bar shows what the cell HOLDS — the formula, not the number it shows
// — and typing there and pressing Enter writes it exactly as typing in the
// cell does (table.setDataAtCell, the very call the fx picker uses).
// Editing IN PLACE is untouched; while that is going on the bar MIRRORS
// the open editor, so the two never disagree.
//
// Pointing at cells with the mouse (POINTING below) belongs to the cell
// editor only: with the bar focused, a click on the grid just goes there.

let barDirty = false;   // something was typed in the bar since it was last filled
let barCell  = null;    // the cell it was filled from — the only cell a commit writes to

// What the cell HOLDS. getSourceDataAtCell reads the very store the file is
// saved from (see stashActiveSheet), so the bar and the file always agree;
// getDataAtCell would hand back HyperFormula's answer instead.
function cellSourceText( r, c )
{
    const v = table ? table.getSourceDataAtCell( r, c ) : null;
    return ( v === null || v === undefined ) ? '' : String( v );
}

function refreshFormulaBar()
{
    const bar = document.getElementById( 'formulaBar' );
    if( ! bar || bar === document.activeElement ) return;   // don't fight what is being typed

    barDirty  = false;
    barCell   = lastSelection ? { r: lastSelection.r1, c: lastSelection.c1 } : null;
    bar.value = barCell ? cellSourceText( barCell.r, barCell.c ) : '';
}

// Write the bar into ITS cell — the one it was filled from. Enter then moves
// on to the row below and gives the grid the keyboard back; a plain blur
// (a toolbar button, another window) only writes and leaves the grid alone.
function commitFormulaBar( move )
{
    const bar = document.getElementById( 'formulaBar' );
    const at  = barCell;
    if( ! table || ! at ) return;

    if( barDirty )
    {
        barDirty = false;               // cleared FIRST: the write refreshes the bar
        table.setDataAtCell( at.r, at.c, bar.value );
    }

    if( ! move ) return;

    bar.blur();                         // so the refreshes below are not fought off
    table.selectCell( Math.min( at.r + 1, table.countRows() - 1 ), at.c );
    table.listen();
}

// While a cell is edited IN PLACE the bar shows the same text, live —
// including a reference just pointed at, which changes the formula as much
// as a keystroke does. A mirror only: what is typed goes on going into the
// cell editor, and the bar is filled from the cell again when it closes.
function mirrorEditorToBar()
{
    const bar = document.getElementById( 'formulaBar' );
    const ed  = table && table.getActiveEditor();

    if( ! bar || bar === document.activeElement ) return;
    if( ! ed || ! ed.isOpened() || ! ed.TEXTAREA ) return;

    barDirty  = false;                  // the cell's text, not something typed here
    bar.value = ed.TEXTAREA.value;
}

// Sum, average and count of the selection, off the COMPUTED values — a
// formula cell should count for what it shows, not for its source text.
function refreshSelStats()
{
    const el = document.getElementById( 'selStats' );
    if( ! el ) return;

    if( ! lastSelection || ! table ) { el.innerHTML = ''; return; }

    let sum = 0, numbers = 0, filled = 0;

    for( let r = lastSelection.r1; r <= lastSelection.r2; r++ )
    {
        for( let c = lastSelection.c1; c <= lastSelection.c2; c++ )
        {
            const v = table.getDataAtCell( r, c );
            if( v === null || v === undefined || v === '' ) continue;

            filled++;

            const n = ( typeof v === 'number' ) ? v : Number( String( v ).replace( ',', '.' ) );
            if( typeof v !== 'boolean' && isFinite( n ) && String( v ).trim() !== '' ) { sum += n; numbers++; }
        }
    }

    if( ! filled ) { el.innerHTML = ''; return; }

    // NayiveI18n.locale() is the tag the rest of Nayive hands Intl: the
    // INTERFACE language, not whatever the browser happens to be set to.
    const fmt  = function( n ) { return n.toLocaleString( NayiveI18n.locale(), { maximumFractionDigits: 2 } ); };
    const cell = function( label, value ) { return '<span>' + label + ' <b>' + value + '</b></span>'; };

    const parts = [];

    if( numbers )
    {
        parts.push( cell( T( 'calc.statSum' ), fmt( sum ) ) );
        parts.push( cell( T( 'calc.statAvg' ), fmt( sum / numbers ) ) );
    }
    parts.push( cell( T( 'calc.statCount' ), String( filled ) ) );

    el.innerHTML = parts.join( '' );
}

//------------------------------------------------------------------------//
// FUNCTION PICKER (fx) — a curated list of the functions HyperFormula already
// executes; this only adds a way to browse/insert them without typing from memory.

const FUNCTIONS =
[
    { name: 'SUM',         desc: T( 'calc.fxSum' ) },
    { name: 'AVERAGE',     desc: T( 'calc.fxAverage' ) },
    { name: 'COUNT',       desc: T( 'calc.fxCount' ) },
    { name: 'COUNTA',      desc: T( 'calc.fxCounta' ) },
    { name: 'MAX',         desc: T( 'calc.fxMax' ) },
    { name: 'MIN',         desc: T( 'calc.fxMin' ) },
    { name: 'IF',          desc: T( 'calc.fxIf' ) },
    { name: 'IFERROR',     desc: T( 'calc.fxIfError' ) },
    { name: 'AND',         desc: T( 'calc.fxAnd' ) },
    { name: 'OR',          desc: T( 'calc.fxOr' ) },
    { name: 'NOT',         desc: T( 'calc.fxNot' ) },
    { name: 'SUMIF',       desc: T( 'calc.fxSumIf' ) },
    { name: 'COUNTIF',     desc: T( 'calc.fxCountIf' ) },
    { name: 'ROUND',       desc: T( 'calc.fxRound' ) },
    { name: 'ABS',         desc: T( 'calc.fxAbs' ) },
    { name: 'SQRT',        desc: T( 'calc.fxSqrt' ) },
    { name: 'POWER',       desc: T( 'calc.fxPower' ) },
    { name: 'CONCATENATE', desc: T( 'calc.fxConcat' ) },
    { name: 'LEN',         desc: T( 'calc.fxLen' ) },
    { name: 'TRIM',        desc: T( 'calc.fxTrim' ) },
    { name: 'UPPER',       desc: T( 'calc.fxUpper' ) },
    { name: 'LOWER',       desc: T( 'calc.fxLower' ) },
    { name: 'TODAY',       desc: T( 'calc.fxToday' ) },
    { name: 'NOW',         desc: T( 'calc.fxNow' ) },
    { name: 'VLOOKUP',     desc: T( 'calc.fxVlookup' ) },
    { name: 'INDEX',       desc: T( 'calc.fxIndex' ) },
    { name: 'MATCH',       desc: T( 'calc.fxMatch' ) }
];

function openFxPicker()
{
    if( ! lastSelection ) return;

    document.getElementById( 'fxSearch' ).value = '';
    renderFxList( '' );
    NayiveUI.open( 'fxBackdrop' );
    document.getElementById( 'fxSearch' ).focus();
}

function renderFxList( filterText )
{
    const list = document.getElementById( 'fxList' );
    const q    = filterText.trim().toUpperCase();
    const rows = FUNCTIONS.filter( function( f ) { return ! q || f.name.indexOf( q ) !== -1; } );

    list.innerHTML = rows.length
        ? fxRowsHtml( rows )
        : '<div class="fx-empty" data-i18n="calc.noFxMatch"></div>';
}

// One row per function, name and what it does. The formula editor's list too.
function fxRowsHtml( rows )
{
    return rows.map( function( f ) { return '<button type="button" class="fx-item" data-fn="' + f.name + '"><b>' + f.name + '</b><span>' + f.desc + '</span></button>'; } ).join( '' );
}

// Wraps the current selection as the function's argument when it spans more than
// one cell (mirrors a common range like SUM(A1:A10)); a single-cell selection
// just inserts empty parentheses for the user to fill in by hand.
function insertFunction( name )
{
    if( ! lastSelection ) return;

    const isRange = lastSelection.r1 !== lastSelection.r2 || lastSelection.c1 !== lastSelection.c2;
    const arg     = isRange
        ? encodeCell( { r: lastSelection.r1, c: lastSelection.c1 } ) + ':' + encodeCell( { r: lastSelection.r2, c: lastSelection.c2 } )
        : '';

    table.setDataAtCell( lastSelection.r1, lastSelection.c1, '=' + name + '(' + arg + ')' );

    NayiveUI.close( 'fxBackdrop' );
}

//------------------------------------------------------------------------//
// THE LOSS GATE
//
// Calc rewrites the whole file on every save, out of a model that does not
// hold everything an .xlsx can carry (see detectLossy). Until it does, the
// honest move is to say so BEFORE the first write instead of quietly
// dropping the user's charts. Raised once per open file, from the two
// places a write can start: the debounced autosave and Ctrl+S.

function lossyDialogIsOpen()
{
    const el = document.getElementById( 'lossyBackdrop' );
    return !! el && el.classList.contains( 'open' );
}

// True = "do not write". Opens the dialog the first time it says so.
function lossyBlocked()
{
    if( ! doc.lossy.length || doc.lossyAck ) return false;

    if( ! lossyDialogIsOpen() )
    {
        const list = document.getElementById( 'lossyList' );
        list.innerHTML = doc.lossy.map( function( k )
        {
            const li = document.createElement( 'li' );
            li.textContent = T( k );
            return li.outerHTML;
        } ).join( '' );

        NayiveUI.open( 'lossyBackdrop' );
    }

    return true;
}

// Every edit lands here. Someone else's sheet, an untitled one (the
// device draft) and the loss gate are the session's business.
function scheduleAutosave()
{
    if( gridBooting ) return;     // drawing a file is not editing it — see initGrid
    session.edited();
}

// Ctrl-S: save now. A shared (read-only) or untitled sheet goes to "Guardar como".
function saveNow() { session.saveNow(); }

// Re-skin the grid live when the shared colour scheme is toggled (from Drive / the launcher).
window.addEventListener( 'balata:themechange', function()
{
    if( ! table ) return;
    const name = htThemeName();
    document.getElementById( 'gridHost' ).className = name;
    table.useTheme( name );
    table.render();
} );

//------------------------------------------------------------------------//
// OPEN  (the shared folder browser - shared/office.js - lists the files Calc
// can open; see OPEN_EXTS)

function isOpenable( path ) { return OPENABLE_EXTS.indexOf( O.extOf( path ) ) !== -1; }

// Open a file the user picked: xlsx / csv directly, anything else
// via a server-side conversion to .xlsx first.
async function openPickedFile( path )
{
    if( OPEN_EXTS.indexOf( O.extOf( path ) ) !== -1 )
    {
        await session.open( path );
        return;
    }

    const nativePath = await convertForOpen( path );
    if( nativePath ) await session.open( nativePath );
}

// Convert a non-native spreadsheet (LibreOffice Calc .ods, legacy .xls,
// …) to .xlsx on the server, save it next to the original and return its
// path. The LibreOffice-backed endpoint isn't deployed yet, so
// CONVERT_EXTS is empty and this is never reached.
async function convertForOpen( path )
{
    NayiveUI.toast( T( 'write.formatUnsupported' ) + '.' );
    return null;
}

//------------------------------------------------------------------------//
// PULL-DOWN MENUS
//
// Calc has TWO chromes and the user picks one: the icon toolbar it always
// had, or the classic "Archivo · Edición · Ver · Insertar · Formato ·
// Datos · Ayuda" bar of the old spreadsheets. Two header buttons switch
// between them (.chrome-btn) and the choice is remembered - in this
// browser and in the account, so another device opens the same way.
//
// THE GOLDEN RULE: a menu entry never re-implements anything. It clicks
// the real (collapsed) toolbar button, or calls the very function that
// button is wired to. So there is still ONE set of handlers, exactly as
// the phone's "⋮" menu does it.
//
// The bar, the panels, the hover-to-slide behaviour and the switch itself
// all live in shared/menubar.js - Write uses the same code. What is here
// is only Calc's own table of menus.

const CALC_CFG = 'data/calc/config.json';

async function readCalcCfg()
{
    try { return ( await GumApi.readJson( CALC_CFG ) ) || {}; }
    catch( _ ) { return {}; }
}

async function writeCalcCfg( patch )
{
    const cfg = await readCalcCfg();
    Object.assign( cfg, patch );
    try { await GumApi.writeJson( CALC_CFG, cfg ); } catch( _ ) {}
    return cfg;
}

// The key combos shown on the right of an entry. Calc's shortcuts are the
// handful wired in wireStaticUI() plus the ones Handsontable itself
// handles (copy / cut / paste, undo / redo).
const IS_MAC = navigator.platform.indexOf( 'Mac' ) === 0;
const MOD    = IS_MAC ? '⌘' : 'Ctrl+';
const SC  =
{
    save: MOD + 'S', bold: MOD + 'B', italic: MOD + 'I', underline: MOD + 'U',
    undo: MOD + 'Z', redo: MOD + 'Y', cut: MOD + 'X', copy: MOD + 'C', paste: MOD + 'V',
    // A getter, not a string: the Shift key's NAME is translated, and this
    // table is built before the dictionaries are in.
    get pastePlain() { return IS_MAC ? '⌘⇧V' : MOD + T( 'ui.keyShift' ) + '+V'; }
};

// Help ▸ Keyboard shortcuts: the combos above, then the grid's own keys
// (Handsontable's). Only keys that really work in Calc go here.
function openShortcuts()
{
    O.showShortcuts( [
        [ 'write.sc.save',  SC.save      ],
        [ 'ui.undo',        SC.undo      ],
        [ 'ui.redo',        SC.redo      ],
        [ 'ui.cut',         SC.cut       ],
        [ 'ui.copy',        SC.copy      ],
        [ 'ui.paste',       SC.paste     ],
        [ 'ui.pastePlain',  SC.pastePlain ],
        [ 'calc.bold',      SC.bold      ],
        [ 'calc.italic',    SC.italic    ],
        [ 'calc.underline', SC.underline ],
        [ 'calc.selectAll', MOD + 'A'    ],
        [ 'calc.sc.edit',   'F2'                  ],
        [ 'calc.sc.down',   T( 'ui.keyEnter' )    ],
        [ 'calc.sc.right',  'Tab'                 ],
        [ 'calc.sc.cancel', T( 'ui.keyEsc' )      ],
        [ 'calc.sc.clear',  T( 'ui.keyDel' )      ]
    ].map( function( r ) { return { text: T( r[ 0 ] ), keys: r[ 1 ] }; } ) );
}

// Help > Estadísticas: what the sheet on screen actually holds. Read on open,
// not live - the status bar already carries the live figures for the selection.
// Off the SOURCE data, not HyperFormula's answers: "=SUM(A1:A9)" has to count
// as a formula, and a cell holding only a formula's result is not a filled one.
function openStats()
{
    if( ! table ) { NayiveUI.toast( T( 'write.waitForDoc' ) ); return; }

    // ONE getSourceData() and then plain arrays, as codec.js does on save: a
    // getSourceDataAtCell() per cell runs Handsontable's hooks a million times
    // over on a real imported sheet and stalls the tab for seconds.
    const data = table.getSourceData();
    let lastRow = -1, lastCol = -1, filled = 0, formulas = 0;

    for( let r = 0; r < data.length; r++ )
    {
        const row = data[ r ];
        if( ! row ) continue;

        for( let c = 0; c < row.length; c++ )
        {
            const v = row[ c ];
            if( v === null || v === undefined || v === '' ) continue;

            filled++;
            if( r > lastRow ) lastRow = r;
            if( c > lastCol ) lastCol = c;
            if( String( v ).charAt( 0 ) === '=' ) formulas++;
        }
    }

    const n = function( x ) { return x.toLocaleString( NayiveI18n.locale() ); };

    O.showStats( [
        { text: T( 'calc.statSheets'   ), value: n( ( doc && doc.sheets ? doc.sheets.length : 1 ) ) },
        { text: T( 'calc.statRows'     ), value: n( lastRow + 1 ) },
        { text: T( 'calc.statCols'     ), value: n( lastCol + 1 ) },
        { text: T( 'calc.statCells'    ), value: n( filled   ) },
        { text: T( 'calc.statFormulas' ), value: n( formulas ) }
    ], T( 'calc.statNote' ) );
}

// The style of the cell the selection is anchored on - the same one the
// toolbar reads to light its buttons up, so a tick and a lit button can
// never disagree.
function selStyle()
{
    if( ! lastSelection ) return null;
    return activeSheet.cellStyles[ encodeCell( { r: lastSelection.r1, c: lastSelection.c1 } ) ] || null;
}

function styleOn( field, value )
{
    return function()
    {
        const st = selStyle();
        if( ! st ) return false;
        return value === undefined ? !! st[ field ] : st[ field ] === value;
    };
}

function haveSelection() { return !! lastSelection; }

// A <select> in the toolbar becomes a submenu: one row per option, the
// current one ticked. Picking a row sets the select and fires its own
// 'change' handler - the same path a click on the toolbar takes.
function selectItems( id )
{
    return function()
    {
        const sel = document.getElementById( id );

        return Array.prototype.map.call( sel.options, function( opt )
        {
            return {
                text    : opt.textContent,
                checked : function() { return sel.value === opt.value; },
                enabled : haveSelection,
                run     : function()
                {
                    sel.value = opt.value;
                    sel.dispatchEvent( new Event( 'change', { bubbles: true } ) );
                }
            };
        } );
    };
}

// Excel's own first row of colours. The names are keys because no
// interface string lives in the source (docs/i18n.md).
const MENU_COLORS = [ [ '#000000', 'black'  ], [ '#808080', 'gray'   ], [ '#C00000', 'red'    ],
                      [ '#E36C0A', 'orange' ], [ '#FFC000', 'yellow' ], [ '#00B050', 'green'  ],
                      [ '#0070C0', 'blue'   ], [ '#7030A0', 'purple' ], [ '#FFFFFF', 'white'  ] ];

const MENU_FILLS  = [ [ '#FFFF00', 'yellow' ], [ '#00B050', 'green'  ], [ '#00FFFF', 'cyan'   ],
                      [ '#FF66FF', 'pink'   ], [ '#FF9900', 'orange' ], [ '#BFBFBF', 'gray'   ],
                      [ '#FFFFFF', 'white'  ] ];

// Same idea for the two <input type="color"> pickers: the swatch sets the
// input and fires its 'input' handler, so the colour travels the one path
// that also paints the little bar under the toolbar glyph.
function colorItems( id, table )
{
    return table.map( function( c )
    {
        return {
            key     : 'ui.color.' + c[1],
            swatch  : c[0],
            enabled : haveSelection,
            run     : function()
            {
                const inp = document.getElementById( id );
                inp.value = c[0];
                inp.dispatchEvent( new Event( 'input', { bubbles: true } ) );
            }
        };
    } );
}

//---- the clipboard -------------------------------------------------//
//
// These three ARE Ctrl+X / Ctrl+C / Ctrl+V: the same Handsontable
// handlers, reached the same way, so a menu paste moves exactly what a
// Ctrl+V moves - values, formulas AND the cell's look. The mechanism is
// shared/office.js's THE CLIPBOARD (a synthetic ClipboardEvent over the
// engine's own DOM listeners); what is Calc's alone is the two things
// Handsontable demands before it will listen:
//
//   - `table.listen()`. Clicking a menu takes the grid out of "listening",
//     and the plugin drops every clipboard event while it is out.
//   - document.body as the target. The plugin ignores an event whose
//     target is neither the body nor inside its own root - and a menu
//     button is neither.
//
// The styles are not Handsontable's to carry (they live in
// `activeSheet.cellStyles`); grid.js rides them along on the plugin's own
// hooks - see CLIPBOARD STYLES there.

function clipReady()
{
    if( ! table ) return null;

    table.listen();
    return document.body;
}

async function clipCopy( andCut )
{
    const node = clipReady();
    if( ! node ) return;

    if( await O.clip.out( node, andCut === true ? 'cut' : 'copy' ) === 'blocked' )
        NayiveUI.toast( T( 'ui.clipboardBlocked' ) );
}

function clipCut() { clipCopy( true ); }

async function clipPaste()
{
    const node = clipReady();
    if( ! node ) return;

    if( await O.clip.into( node ) === 'blocked' )
        NayiveUI.toast( T( 'ui.clipboardBlocked' ) );
}

// Ctrl+Shift+V: the values, naked. Only the plain text reaches Handsontable
// (so nothing of the source's own HTML survives) and grid.js is told to let
// this one paste through without laying the copied styles down.
async function clipPastePlain()
{
    const node = clipReady();
    if( ! node ) return;

    pasteWithoutStyles( true );

    try
    {
        if( await O.clip.into( node, true ) === 'blocked' )
            NayiveUI.toast( T( 'ui.clipboardBlocked' ) );
    }
    finally { pasteWithoutStyles( false ); }
}

// Insertar > Comentario. The same plugin call Handsontable's own
// "Añadir comentario" context-menu entry makes.
function addComment()
{
    if( ! table || ! lastSelection ) return;

    const plugin = table.getPlugin( 'comments' );

    plugin.setRange( { from: { row: lastSelection.r1, col: lastSelection.c1 },
                       to:   { row: lastSelection.r1, col: lastSelection.c1 } } );
    plugin.show();
    plugin.focusEditor();
}

// "Recientes": the same ten paths the Open dialog lists (shared/office.js
// keeps them), so the menu never drifts from it. An empty list still
// shows one (greyed) row - a menu that silently has no submenu is worse
// than one that says why.
function recentItems()
{
    const list = session.recent();

    if( ! list.length ) return [ { key: 'ui.noRecent', enabled: function() { return false; } } ];

    return list.map( function( p )
    {
        return { text: O.baseName( p ), run: function() { openPickedFile( p ); } };
    } );
}

//---- the table -----------------------------------------------------//
//
// The grouping is the one every spreadsheet has used since Excel 5:
// Archivo · Edición · Ver · Insertar · Formato · Datos · Ayuda.
// (No "Ventana": Calc is one window. No "Herramientas": everything that
// would live there - language, theme, account - belongs to the launcher.)

const MENUS =
[
{
    key: 'ui.menu.file',
    items:
    [
        { key: 'write.newDoc',    el: 'newBtn'     },
        { key: 'ui.openDoc',      el: 'openBtn'    },
        { key: 'ui.recent',       sub: recentItems },
        { sep: true },
        { key: 'ui.save',   run: function() { saveNow(); }, sc: 'save', icon: 'check' },
        { key: 'ui.saveAs', el:  'saveAsBtn' },
        { key: 'ui.importDevice', el: 'importBtn'  },
        { key: 'write.restore',   el: 'restoreBtn' }
    ]
},
{
    key: 'ui.menu.edit',
    items:
    [
        { key: 'ui.undo', el: 'undoBtn', sc: 'undo' },
        { key: 'ui.redo', el: 'redoBtn', sc: 'redo' },
        { sep: true },
        { key: 'ui.cut',   run: clipCut,   sc: 'cut',   enabled: haveSelection, icon: 'cut'   },
        { key: 'ui.copy',  run: clipCopy,  sc: 'copy',  enabled: haveSelection, icon: 'copy'  },
        { key: 'ui.paste', run: clipPaste, sc: 'paste', enabled: haveSelection, icon: 'paste' },
        { key: 'ui.pastePlain', run: clipPastePlain, sc: 'pastePlain', enabled: haveSelection, icon: 'paste' },
        { sep: true },
        { key: 'calc.selectAll', run: function() { table.selectAll(); } },
        { sep: true },
        { key: 'calc.clearFormat', el: 'fmtClearBtn' }
    ]
},
{
    key: 'ui.menu.view',
    items:
    [
        { key: 'ui.chrome', sub:
            [ { key: 'ui.chromeToolbar', run: function() { CHROME.set( 'toolbar' ); }, iconOf: '#chromeToolbarBtn',
                checked: function() { return ! CHROME.on(); } },
              { key: 'ui.chromeMenus',   run: function() { CHROME.set( 'menus'   ); }, iconOf: '#chromeMenusBtn',
                checked: function() { return CHROME.on(); } } ] },
        { sep: true },
        { key: 'calc.freezeRows', el: 'fmtFreezeRowBtn',
          checked: function() { return !! table && table.getSettings().fixedRowsTop      > 0; } },
        { key: 'calc.freezeCols', el: 'fmtFreezeBtn',
          checked: function() { return !! table && table.getSettings().fixedColumnsStart > 0; } }
    ]
},
{
    key: 'ui.menu.insert',
    items:
    [
        { key: 'calc.insRow', el: 'insRowBtn' },
        { key: 'calc.insCol', el: 'insColBtn' },
        { sep: true },
        { key: 'calc.delRow', el: 'delRowBtn' },
        { key: 'calc.delCol', el: 'delColBtn' },
        { sep: true },
        { key: 'calc.insertFx', el: 'fxBtn' },
        { key: 'calc.ht.addComment', run: addComment, enabled: haveSelection, icon: CM_ICONS.commentsAddEdit }
    ]
},
{
    key: 'ui.menu.format',
    items:
    [
        { key: 'calc.bold',      el: 'fmtBoldBtn',      sc: 'bold',      checked: styleOn( 'bold'      ) },
        { key: 'calc.italic',    el: 'fmtItalicBtn',    sc: 'italic',    checked: styleOn( 'italic'    ) },
        { key: 'calc.underline', el: 'fmtUnderlineBtn', sc: 'underline', checked: styleOn( 'underline' ) },
        { sep: true },
        { key: 'calc.fontFamily', sub: selectItems( 'fmtFontFamily' ) },
        { key: 'calc.fontSize',   sub: selectItems( 'fmtFontSize'   ) },
        { sep: true },
        { key: 'calc.fontColor', sub: colorItems( 'fmtFontColor', MENU_COLORS ), iconOf: '.fmt-color-btn:has(#fmtFontColor) svg' },
        { key: 'calc.fillColor', sub: colorItems( 'fmtFillColor', MENU_FILLS  ), iconOf: '.fmt-color-btn:has(#fmtFillColor) svg' },
        { sep: true },
        { key: 'calc.alignment', iconOf: '#fmtAlignLeftBtn', sub:
            [ { key: 'calc.alignLeft',    el: 'fmtAlignLeftBtn',    checked: styleOn( 'align',  'left'   ) },
              { key: 'calc.alignCenter',  el: 'fmtAlignCenterBtn',  checked: styleOn( 'align',  'center' ) },
              { key: 'calc.alignRight',   el: 'fmtAlignRightBtn',   checked: styleOn( 'align',  'right'  ) },
              { sep: true },
              { key: 'calc.valignTop',    el: 'fmtValignTopBtn',    checked: styleOn( 'valign', 'top'    ) },
              { key: 'calc.valignMiddle', el: 'fmtValignMiddleBtn', checked: styleOn( 'valign', 'middle' ) },
              { key: 'calc.valignBottom', el: 'fmtValignBottomBtn', checked: styleOn( 'valign', 'bottom' ) } ] },
        { key: 'calc.wrapText', el: 'fmtWrapBtn', checked: styleOn( 'wrap' ) },
        { sep: true },
        { key: 'calc.borders',   el:  'fmtBorderBtn', checked: styleOn( 'border' ) },
        { key: 'calc.numFormat', sub: selectItems( 'fmtNumFormat' ) },
        { sep: true },
        { key: 'calc.mergeCells', el: 'fmtMergeBtn' }
    ]
},
{
    key: 'ui.menu.data',
    items:
    [
        { key: 'calc.sortAsc',  el: 'sortAscBtn'  },
        { key: 'calc.sortDesc', el: 'sortDescBtn' }
    ]
},
{
    key: 'ui.menu.help',
    items: HELP_ITEMS
}
];

const menus = NayiveMenus.create(
{
    menus : MENUS,
    ready : function() { return !! table; },
    hint  : function( k ) { return SC[ k ] || ''; }
} );

const CHROME = NayiveMenus.chrome(
{
    key   : 'nayive-calc-chrome',
    menus : menus,
    load  : async function() { return ( await readCalcCfg() ).chrome; },
    save  : function( mode ) { return writeCalcCfg( { chrome: mode } ); },

    // What CSS cannot do: the toolbar's height changed, so the grid has to
    // re-measure, and the "?" has to move somewhere still visible. The name
    // box needs nothing here any more — it rides in the formula row, which
    // neither chrome touches.
    apply : function( on )
    {
        // A fold left over from the phone must not decide anything once
        // the strip is back: an editor opened in menu mode folds a
        // toolbar nobody could see, and it would come back blank.
        if( ! on ) fold.setOpen( true );

        applyPhoneChrome();
        if( table ) table.refreshDimensions();
    }
} );

//------------------------------------------------------------------------//
// INITIALIZATION
//
// LAST in the module, on purpose: wireStaticUI() reads module-level `const`s
// declared further down (HT_LOCALE, PHONE, fileMenu, fold). A `const` is in
// its temporal dead zone until execution reaches it, so starting the app any
// earlier threw "Cannot access 'X' before initialization" and the page stayed
// blank. Function declarations hoist; consts do not.

wireStaticUI();

NayiveUI.bootWithStore( store, async function()
{
    // The ACCOUNT's copy of "toolbar or menus" wins, so a browser that has
    // never been told about the choice still opens the way the user left
    // Calc somewhere else. Offline this reads nothing and the local copy
    // stands. Before the grid, so the switch - if any - is invisible.
    await CHROME.sync();

    // ?file= / ?import= / the untitled sheet kept on this device - or a blank one.
    await session.boot();
} );

export
{
    NF_SAMPLE_DATE, borderWeight, borderColorValue, T, PHONE, fold, HT_LOCALE,
    refreshNameBox, gotoReference, refreshFormulaBar, mirrorEditorToBar, refreshSelStats,
    FUNCTIONS, fxRowsHtml, scheduleAutosave, menus, CHROME, syncGroupTriggers
};
