/*
 * write.js - Personal single-user word processor, on the docx-editor.dev engine.
 *
 * .docx is the native format. A document lives wherever the user put it in
 * Drive - "Guardar como" asks for the folder on the first save - and a copy of
 * the previous version is kept in a .bak/ beside it. Loaded as a module by
 * index.html AFTER shared/gum-api.js, shared/ui.js and shared/office.js
 * (classic scripts) have set window.GumApi / NayiveUI / NayiveOffice.
 *
 * The engine under lib/docx-editor/ is vendored and pinned (Apache-2.0, its
 * fonts OFL); see lib/docx-editor/BUILD.md. Its PUBLIC API does the work here -
 * createDocxEditor, load / save / exec / snapshot / on and the toolbar helpers -
 * which is what keeps a version bump one command (docs/write-docx-editor-plan.md).
 * Where that API has no answer Write reaches past it - editor.surface (links,
 * the caret's offsets), the painted pages' DOM (spelling, find, autocorrect) and
 * the typing in its contenteditable - and every such place is a record in
 * quirks.js, to walk after a bump.
 *
 * The toolbar is ours (toolbar.js), and so are the menus, the dialogs, the
 * find bar (find.js), the right-click menu, the spelling underlines
 * (proofing-overlay.js) and the correct-as-you-type rules: the engine paints
 * the pages and owns the document, nothing else.
 */
import { createDocxEditor, packagedFonts, runToolbarCommand, toolbarCommandState, toolbarCommandStates,
         blankDocumentBytes, executeImageCommand, unzipSync, zipSync, strFromU8, strToU8 }
    from './lib/docx-editor/docx-editor_v2.21.0.min.js';
import { createToolbar } from './toolbar.js';
import { createPatcher } from './docx-patch.js';
import { createFindBar } from './find.js';
import { PROOF_LANGS, setPersonalWords, isPersonalWord, makeSpellProvider, suggestionsFor, resetProofing } from './proofing.js';
import { createSpellOverlay } from './proofing-overlay.js';
// Every place Write works around the engine, as data - see quirks.js.
import { Q } from './quirks.js';

//----------------------------------------------------------------------------//
// STATE

// Where new documents are saved. Drive opens Write with ?dir=<folder> (a path
// relative to the file root, e.g. "files/Cartas") so a doc created from a
// Drive folder lands in that folder; opened straight from the launcher there is
// no ?dir= and documents go to the user's files/ root.
const DOC_DIR = ( function() {
    const raw = new URLSearchParams( location.search ).get( 'dir' );
    const dir = raw ? raw.replace( /^\/+|\/+$/g, '' ) : '';
    return dir || 'files';
} )();
// The Open browser never walks above the user's files/ root (the first path
// segment of DOC_DIR — "files" when Write is opened from the launcher).
const OPEN_ROOT = DOC_DIR.split( '/' )[ 0 ] || 'files';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Page sizes, portrait, in inches (the engine takes twips: x 1440).
// Five decimals, so that x 1440 rounds to the twips Word itself writes (A4 is
// 11906 x 16838; four decimals gave 11905).
const PAGE_SIZES = {
    A4     : { w:  8.26772, h: 11.69291 },
    Letter : { w:  8.5,     h: 11       },
    Legal  : { w:  8.5,     h: 14       },
    A3     : { w: 11.69291, h: 16.53543 },
    A5     : { w:  5.82677, h:  8.26772 },
    B5     : { w:  6.92913, h:  9.84252 }
};

// Which named size is this page? Used to fill the dialog from the document.
// A hundredth of an inch of slack: .docx stores twentieths of a point, so a page
// that came from Word is never exactly the number above.
function sizeNameFor( w, h )
{
    for( const name in PAGE_SIZES )
    {
        const z = PAGE_SIZES[ name ];
        if( Math.abs( w - z.w ) < 0.01 && Math.abs( h - z.h ) < 0.01 ) return name;
    }
    return 'custom';
}


// Offline-capable persistence (../shared/store.js): every write is cached in
// IndexedDB first and the PUT is queued, so a crash or a dropped connection
// never loses the document. binary — bodies are .docx bytes. conflicts — a save
// over a file changed on another device since it was opened is refused.
const store = NayiveStore.createStore( { apiBase: GumApi.API_FILES, binary: true, conflicts: true } );

let editor = null;    // the docx-editor.dev instance, made once in boot()

// Phone (see TWO LAYOUT MODES in shared/app.css). The engine shrinks the page
// towards the width by itself (its zoom mode 'auto') but never below 50 % - an
// A4 is then ~397 px, a little wider than a 390 px phone - and the viewport
// allows pinch zoom for the rest (his call). No phone fit of our own any more.
const PHONE = window.matchMedia( '(max-width: 640px)' );


//----------------------------------------------------------------------------//
// PHONE CHROME  (see the phone block in index.html)
//
// A full toolbar took three rows — about a third of the screen once the
// keyboard is up. Two moves fix that, and both are phone-only:
//
//   1. ONE ROW. index.html keeps the nine controls a phone actually reaches for
//      and hides the rest; "⋮" (#moreToolsBtn) opens the whole toolbar in place
//      and closes it again. The app's own six buttons leave the row for the
//      header's "⋮" menu, built here from those same buttons.
//   2. IT FOLDS. Tapping into the text folds the row away; the header's "Aa"
//      button brings it back. Formatting costs one extra tap, the document
//      gets the whole screen.
//
// Folding sets height:0, never display:none, so the real buttons stay in the
// DOM for the menu entries that click them.

// The header's "⋮" menu, built by shared/office.js from the REAL buttons -
// glyph and title cloned, an entry clicks the button it came from - so there
// is one set of handlers and the menu can never drift from them.
//
// `ids` is everything a phone needs, because at <=640px #writeTools is gone
// whole. `phoneOnly` names the ones a PC still has on the row (or inside one
// of its group cards), and app.css drops those entries above 640px, so a PC
// is never offered the same thing twice. What is left on a PC is the file
// block: the eight buttons that are on no bar at all (#fileTools).
const MENU_IDS =
[
    'newBtn', 'openBtn', 'importBtn', 'saveAsBtn', 'restoreBtn', 'lockBtn', 'settingsBtn', 'scBtn',
    'tplBtn', 'printBtn', 'pdfBtn',
    'pageSetupBtn', 'headerBtn', 'footerBtn', 'pageNumBtn', 'paraBtn'
];
const MENU_PHONE_ONLY =
[
    'tplBtn', 'printBtn', 'pdfBtn',
    'pageSetupBtn', 'headerBtn', 'footerBtn', 'pageNumBtn', 'paraBtn'
];

let fileMenu = null;    // set in wireStaticUI, once the DOM is there
let helpMenu = null;    // the "?" menu, ditto

// The tool row's group cards: print / PDF, and the four page ones. The buttons
// in them are the real ones, wired below exactly as when they sat on the row.
let groups = [];
function closeGroupPopups() { groups.forEach( function( g ) { if( g ) g.close(); } ); }

// `fold.isOpen()` is the truth now; this stays only for readability at call sites.
function toolbarOpen() { return fold ? fold.isOpen() : true; }

// Show / hide the formatting row and keep the "Aa" button in step with it.
// Folding also closes the "⋮" expansion — coming back to a four-row toolbar
// would undo the whole point of folding it away.
// shared/office.js's foldingToolbar does all of this: the "is-folded" height-0
// fold, the "⋮" expansion, and both buttons' aria state.
let fold = null;   // set in wireStaticUI, once the DOM is there

function setToolbarOpen( open ) { if( fold ) fold.setOpen( open ); }

// The "⋮" at the end of the row: show every toolbar item (it wraps onto a few
// lines) or just the ones the phone keeps. index.html does the hiding; this only
// flips the class and the button's own pressed look.
function setMoreTools( open ) { if( fold ) fold.setMore( open ); }

// The "?" is the SAME button in both layouts — on a phone it moves into the
// header, because the row it normally sits in folds away. A second copy would
// break the coach marks, which point at the first [data-intro-open] on the page.
// only the things CSS cannot do: move the "?", close the menus, unfold.
function applyPhoneChrome()
{
    applyKeyHints();          // the hints come off on a phone and back on a PC

    // shared/office.js does exactly this: "?" in the header on a phone (after the
    // two chrome buttons, before the sync dot), last in the tool row on a PC.
    //
    // Never in the header in MENU mode, on a phone or not: the Ayuda menu is
    // right there, and one "?" in two places at once is one too many.
    NayiveOffice.placeHelpButton( PHONE.matches && ! CHROME.on(), 'topActions', 'writeTools', null, 'savedAt' );
    if( fileMenu ) fileMenu.close();
    if( helpMenu ) helpMenu.close();
    closeGroupPopups();
    setMoreTools( false );
    if( ! PHONE.matches ) setToolbarOpen( true );
}
let ready         = false;   // a document is on screen; edits after this are the user's

// A load() fires one 'change' of its own (revision 0) before it returns - not an
// edit. So ready is false across every load, and a change whose revision is not
// past the one the document was loaded at is not an edit either.
let loadedRevision = 0;
let lastGood       = null;   // what is on screen, as bytes - retaken before every load: a failed open goes back to it

// The open document - its path, whether it is someone else's, its name, the
// top-bar label, New / Import / "Guardar como" / rename / Restore, start-up,
// the header plug and the autosave - is the one Calc and Text use
// (shared/office.js, THE OPEN DOCUMENT). Write only says how a .docx gets into
// and out of the engine, and that its files are always .docx.
const session = NayiveOffice.session( {
    app        : 'write',
    store      : store,
    appDir     : DOC_DIR,
    openRoot   : OPEN_ROOT,
    // Read when "Guardar como" opens: at module load the language is not in yet.
    get defaultName() { return NayiveUI.t( 'write.defaultFile' ); },
    encode     : function() { return exportBytes(); },
    load       : loadBody,
    blank      : loadBlank,
    finishName : docxName,
    renameName : docxName,
    canOpen    : isOpenable,                                 // what the Open dialog lists
    onPick     : function( path ) { openPickedFile( path ); },   // any other format is turned away
    emptyKey   : 'write.noDocs',
    ready      : function() { return ready; },
    focus      : function() { focusEditor(); }                        // the caret stays where it was
} );

// Nayive's page setup for a NEW document (centimetres). An opened document
// keeps its own; the dialog reads the document itself (getPageSetup).
let pageSetup = { size: 'A4', orientation: 'portrait', top: 2, bottom: 1.6, left: 2, right: 1.6 };

// Spell-check languages. Persisted; the spell check reads this live.
const PROOF_LANG_KEY = 'nayive-write-prooflang';
let proofLangs = readProofLangs();

function readProofLangs()
{
    try
    {
        const raw = localStorage.getItem( PROOF_LANG_KEY );
        // a dropped dictionary (Italian, 2026-09-28) may still be in there
        if( raw !== null ) return raw ? raw.split( ',' ).filter( c => PROOF_LANGS.indexOf( c ) >= 0 ) : [];
    }
    catch( _ ) {}
    return defaultProofLangs();
}

// No stored choice yet: start from the user's own locale (the same source the
// shared date/time pickers use). Only Spanish and English dictionaries ship, so
// anything else falls back to Spanish.
function defaultProofLangs()
{
    let loc = 'es';
    try { loc = ( navigator.language || 'es' ).toLowerCase(); } catch( _ ) {}
    return loc.indexOf( 'en' ) === 0 ? [ 'en' ] : [ 'es' ];
}

//----------------------------------------------------------------------------//
// INITIALIZATION

NayiveI18n.ready.then( function()
{
    wireStaticUI();

    // The shared boot (shared/ui.js), the same one Calc and Text use: probe
    // /api/whoami, bounce to sign-in ONLY when we are really online with nothing
    // cached (otherwise open on the local cache and let the store sync when the
    // connection is back), show #app, run boot(). It also settles the header
    // plug afterwards, so a brand-new blank document opens on the real resting
    // state instead of the red "no state yet" one.
    NayiveUI.bootWithStore( store, boot );
});

async function boot( who )
{
    loadPersonalWords();          // best effort; the spell check reads it live

    // Toolbar or pull-down menus, from the account. Awaited here, before
    // anything is drawn, so a correction cannot flash.
    await CHROME.sync();

    // The engine first, empty: every way a document arrives - ?file=, ?import=,
    // the untitled one kept on this device, a blank one - goes through load()
    // from here on, and a file that cannot be opened is refused the same way
    // whichever it was (loadBody throws; the session says so).
    initEditor( who );

    await session.boot();

    document.getElementById( 'editor' ).classList.add( 'is-ready' );
    focusEditor();
}

function wireStaticUI()
{
    // New, Import, "Guardar como" and Restore are wired by the session (shared/office.js).
    document.getElementById( 'printBtn'         ).addEventListener( 'click', function() { printDocument( false ); } );
    document.getElementById( 'tplBtn'           ).addEventListener( 'click', openTemplates );
    document.getElementById( 'tplCloseBtn'      ).addEventListener( 'click', function() { setBackdrop( 'tplBackdrop', false ); } );
    document.getElementById( 'tplChangeBtn'     ).addEventListener( 'click', changeTemplatesDir );
    document.getElementById( 'paraBtn'          ).addEventListener( 'click', openParagraph );
    document.getElementById( 'paraCancelBtn'    ).addEventListener( 'click', function() { setBackdrop( 'paraBackdrop', false ); } );
    document.getElementById( 'paraConfirmBtn'   ).addEventListener( 'click', confirmParagraph );

    // Any change in the dialog marks its GROUP, so Apply only touches what the
    // user actually changed (see PARRAFO).
    for( const g in PARA_GROUPS )
        for( const id of PARA_GROUPS[ g ] )
            document.getElementById( id ).addEventListener( 'change', function( e )
            {
                markParagraphTouched( e.target.id );
                if( e.target.id === 'paListLevel' ) showListFormat();
                syncParagraphRows();
            } );

    document.getElementById( 'statsBtn'         ).addEventListener( 'click', openStats );
    document.getElementById( 'statsCloseBtn'    ).addEventListener( 'click', function() { setBackdrop( 'statsBackdrop', false ); } );
    document.getElementById( 'scBtn'            ).addEventListener( 'click', openShortcuts );
    document.getElementById( 'scCloseBtn'       ).addEventListener( 'click', function() { setBackdrop( 'scBackdrop', false ); } );
    document.getElementById( 'pdfBtn'           ).addEventListener( 'click', function() { printDocument( true ); } );
    document.getElementById( 'saveAsCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'saveAsBackdrop', false ); } );
    document.getElementById( 'pageSetupBtn'        ).addEventListener( 'click', openPageSetup );
    document.getElementById( 'headerBtn'           ).addEventListener( 'click', function() { toggleHeaderFooter( 'header' ); } );
    document.getElementById( 'footerBtn'           ).addEventListener( 'click', function() { toggleHeaderFooter( 'footer' ); } );
    document.getElementById( 'pageNumBtn'          ).addEventListener( 'click', function() { runSlot( 'insert.pageNumber' ); } );
    document.getElementById( 'symbolsBtn'          ).addEventListener( 'click', openSymbols );
    document.getElementById( 'linkBtn'             ).addEventListener( 'click', openLinkDialog );
    document.getElementById( 'imageBtn'            ).addEventListener( 'click', pickImage );
    document.getElementById( 'tableBordersBtn'     ).addEventListener( 'click', openTableBorders );
    document.getElementById( 'findBtn'             ).addEventListener( 'click', function() { openFind( false ); } );

    wireTableBorders();
    restoreTbStyle();

    document.getElementById( 'settingsBtn'         ).addEventListener( 'click', openSettings );
    document.getElementById( 'settingsCancelBtn'   ).addEventListener( 'click', function() { setBackdrop( 'settingsBackdrop', false ); } );
    document.getElementById( 'settingsConfirmBtn'  ).addEventListener( 'click', confirmSettings );
    document.getElementById( 'pageSetupCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'pageSetupBackdrop', false ); } );
    document.getElementById( 'pageSetupConfirmBtn' ).addEventListener( 'click', confirmPageSetup );
    document.getElementById( 'psSize'              ).addEventListener( 'change', syncPageSizeRows );

    // ---- the header menu and the group cards ----
    fileMenu = NayiveOffice.fileMenu( { btn: 'moreBtn', menu: 'topMenu',
                                        ids: MENU_IDS, phoneOnly: MENU_PHONE_ONLY } );

    // Ayuda on the "?" - the same three entries the pull-down Ayuda menu holds.
    // setHelpMenu tells shared/ui.js to leave the click to this menu instead of
    // opening the guide card itself (the card is the third entry).
    document.getElementById( 'guideBtn' ).addEventListener( 'click', function() { NayiveUI.showIntro(); } );
    helpMenu = NayiveOffice.buttonMenu( { btn: 'helpBtn', menu: 'helpMenu', ids: NayiveOffice.HELP_IDS } );
    NayiveUI.setHelpMenu( true );
    groups =
    [
        NayiveOffice.groupPopup( { btn: 'wrOutputBtn', popup: 'outputPopup' } ),
        NayiveOffice.groupPopup( { btn: 'wrPageBtn',   popup: 'pagePopup'   } )
    ];

    // ---- phone chrome (see PHONE CHROME above) ----
    applyPhoneChrome();
    applyKeyHints();
    PHONE.addEventListener( 'change', applyPhoneChrome );

    // The shared folding toolbar wires #fmtBtn and #moreToolsBtn itself.
    fold = NayiveOffice.foldingToolbar( { toolbar: 'toolbarRow' } );

    // ---- the pull-down menus (see PULL-DOWN MENUS below) ----
    // Built once; the panels are built fresh on every open, so a language
    // change only has to reach the bar - and it does, through data-i18n.
    MENUBAR.build();      // again, now that the dictionary is in - the bar carries data-i18n
    CHROME.wire();
    CHROME.apply();

    // ---- the formatting strip (toolbar.js) ----
    toolbar = createToolbar(
    {
        states   : function( slots ) { return editor ? toolbarCommandStates( editor, slots ) : null; },
        run      : runSlot,
        painter  : togglePainter,
        blocked  : slotBlocked,
        menus    : MENUBAR,
        dropdowns: TOOLBAR_DROPDOWNS,
        fonts    : MENU_FONTS,
        sizes    : MENU_SIZES,
        after    : paintOwnButtons
    } );

    // ---- the spell check (proofing-overlay.js) ----
    spell = createSpellOverlay(
    {
        editor    : function() { return editor; },
        check     : function( segments ) { return spellProvider.check( { segments: segments } ).then( function( r ) { return r.issues; } ); },
        suggest   : suggestionsFor,
        langs     : function() { return proofLangs; },
        isPersonal: isPersonalWord,
        addWord   : addPersonalWord,
        replace   : replaceMatch
    } );

    // ---- the right-click menu: spelling first, then the clipboard ----
    document.getElementById( 'editor' ).addEventListener( 'contextmenu', onContextMenu, true );

    // Tab in a table: the next cell, as in Word (see TABLE CELLS).
    document.getElementById( 'editor' ).addEventListener( 'keydown', onTableTab, true );

    // Ctrl+V is the engine's; only where the caret ends up is ours (caretAfterPaste).
    document.getElementById( 'editor' ).addEventListener( 'paste', function( e )
    {
        const dt = e.clipboardData;
        if( ready && dt && [ ...dt.types ].indexOf( 'text/html' ) >= 0 ) caretAfterPaste( dt.getData( 'text/plain' ) );
    }, true );

    // Autocorreccion, when it is on: the typed character passes through Write
    // first (see AUTOCORRECCION). Capture, above the engine's own listeners.
    document.getElementById( 'editor' ).addEventListener( 'beforeinput', onBeforeInput, true );

    // ---- the find / replace bar (find.js) ----
    find = createFindBar(
    {
        editor: function() { return editor; },
        ready : function() { return ready; },
        focus : focusEditor
    } );

    document.getElementById( 'imgInput'      ).addEventListener( 'change', function( e ) { insertPickedImage( e.target.files[0] ); e.target.value = ''; } );
    document.getElementById( 'linkCancelBtn' ).addEventListener( 'click', function() { setBackdrop( 'linkBackdrop', false ); } );
    document.getElementById( 'linkConfirmBtn' ).addEventListener( 'click', confirmLink );
    document.getElementById( 'linkHref'      ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) confirmLink(); } );

    // Tapping into the document folds the row away — the keyboard is about to
    // take half the screen. Only a tap INSIDE #editor: a toolbar button also
    // puts focus back in the text, and must not fold the row under your finger.
    // Capture phase, so the engine cannot swallow it first. isTrusted keeps a
    // synthetic tap from folding the row - the bar has to be seen once before
    // it can hide.
    document.getElementById( 'editor' ).addEventListener( 'pointerdown', function( e )
    {
        if( e.isTrusted && PHONE.matches && toolbarOpen() ) setToolbarOpen( false );
    }, true );

    document.addEventListener( 'keydown', onShortcutKey );

    // Escape is not a shortcut in the table above: it closes whatever is open,
    // in a fixed order, and never reaches the document.
    document.addEventListener( 'keydown', function( e )
    {
        if( e.key === 'Escape' )
        {
            if( fileMenu && fileMenu.isOpen() ) { fileMenu.close(); return; }
            if( document.getElementById( 'tbPopup'  ).classList.contains( 'open' ) ) { tbPopup.close();  return; }
            if( document.getElementById( 'symPopup' ).classList.contains( 'open' ) ) { symPopup.close(); return; }

            const open = document.querySelector( '.sheet-backdrop.open' );
            if( open ) { setBackdrop( open.id, false ); return; }

            if( find && find.isOpen() ) { find.close(); return; }
        }
    });
}

function setBackdrop( id, open ) { NayiveUI.setOpen( id, open ); }   // impl in shared/ui.js

//----------------------------------------------------------------------------//
// EDITOR

function initEditor( who )
{
    editor = createDocxEditor(
    {
        container: document.getElementById( 'editorHost' ),

        // On demand: only the families a document names are fetched (Calibri ->
        // Carlito, Times New Roman -> Liberation Serif ...), from the vendored
        // fonts_v<ver>/ folder. They are NOT in the offline precache (his call,
        // 2026-09-18): offline, a document whose fonts were never fetched lays
        // out on the engine's estimate until the connection is back.
        fonts    : packagedFonts(),

        locale   : NayiveUI.locale(),
        author   : ( who && ( who.user || who.name ) ) || NayiveUI.t( 'write.meAuthor' ),
        mode     : 'edit'
    } );

    editor.on( 'change', onChange );
    editor.on( 'selectionChange', refreshToolbar );
    editor.on( 'error', function( e ) { console.error( 'Write: engine', e ); } );

    // A click on a link shows what it points at (and open / edit / remove);
    // Ctrl+K asks for one. The engine draws the link, Write the sheet and menu.
    editor.setHyperlinkChrome( { onPopover: showLinkMenu, onRequest: openLinkDialog } );
}

// Resolves once the document just handed to load() is on screen: parsed, laid
// out, at least one page. Throws when the engine refused it. The fonts may
// still be arriving - the page is shown on the engine's estimate and
// re-paginates by itself when they land, which beats a blank wait.
function whenOpen()
{
    const t0 = Date.now();

    return new Promise( function( resolve, reject )
    {
        ( function poll()
        {
            const s = editor.snapshot();

            if( s.parseError ) { reject( new Error( s.parseError ) ); return; }
            if( ! s.isLoading && ! s.isOpening && s.page.total > 0 ) { resolve(); return; }

            if( Date.now() - t0 > OPEN_SLOW_MS )
            {
                NayiveUI.toast( NayiveUI.t( 'write.editorSlow' ) );
                resolve();
                return;
            }
            setTimeout( poll, 30 );
        } )();
    } );
}

const OPEN_SLOW_MS = 30000;

// The .docx changes the engine has no command for (docx-patch.js).
const patcher = createPatcher( { unzipSync: unzipSync, zipSync: zipSync, strFromU8: strFromU8,
                                 strToU8: strToU8, blank: blankDocumentBytes } );

// Word's Heading 1-3 added to a file that lacks them, the way Word does when
// one is used (docx-patch.js). If anything about that goes wrong, the file goes
// on screen as it came - the headings are then simply greyed.
function withHeadings( bytes )
{
    try { return patcher.withHeadingStyles( bytes ); }
    catch( e ) { console.error( 'Write: heading styles -', e ); return bytes; }
}

// Put .docx bytes on screen. A file the engine refuses throws - and the
// document that was there before goes back on screen first, so the session
// (which keeps the old path when an open fails) and the page still agree.
async function loadIntoEditor( bytes )
{
    // What is on screen NOW, edits and all - not the bytes it was loaded
    // from: the session keeps the old path when an open fails, so whatever
    // goes back on screen is what the next keystroke saves there. If it
    // cannot be taken, nothing is loaded over it (the caller says so).
    if( ready && lastGood ) lastGood = new Uint8Array( await editor.save() );

    ready = false;
    bytes = withHeadings( bytes );

    try
    {
        editor.load( bytes );
        await whenOpen();
        lastGood = bytes;
    }
    catch( e )
    {
        console.error( 'Write: the engine refused the document -', e.message );

        if( lastGood )
        {
            editor.load( lastGood );
            await whenOpen().catch( function() {} );
        }
        throw e;
    }
    finally
    {
        loadedRevision = editor.getDocumentHandle().revision;
        ready = true;
        refreshToolbar();
        resetProofing();                 // another document: nothing it knew applies
        if( spell ) spell.reset();
    }

    focusEditor();
}

// Give the editor the focus back after an action that took it (a menu, a
// dialog, a toolbar button). A freshly loaded document already has its caret at
// the start, so there is nothing to synthesise.
function focusEditor()
{
    try { editor && editor.focus(); } catch( _ ) {}
}

function onChange( change )
{
    refreshToolbar();
    if( spell ) spell.changed();

    if( ! ready ) return;
    if( Q.loadFiresChange && change && typeof change.revision === 'number' && change.revision <= loadedRevision ) return;

    session.edited();
}

//----------------------------------------------------------------------------//
// SETTINGS  (gear button)
//
// Editing or read-only, the proofing languages and autocorrect. The engine
// holds the mode, so the dialog reads it back each time it opens and only
// pushes what changed on "Aplicar". (Suggesting, the ruler and the unit are
// gone with the old engine - his decision, 2026-09-18.)

function docMode()
{
    try { return editor && editor.getEditingMode() === 'viewing' ? 'viewing' : 'editing'; }
    catch( _ ) { return 'editing'; }
}

function setDocMode( mode )
{
    if( ! editor || docMode() === mode ) return;

    const r = editor.setEditingMode( mode === 'viewing' ? 'viewing' : 'editing' );
    if( r && r.ok === false ) console.error( 'Write: editing mode -', r.reason );
    refreshToolbar();          // read-only greys the buttons at once, not at the next caret move
}

function openSettings()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    document.getElementById( 'setMode' ).value = docMode();
    renderProofLangs();
    document.getElementById( 'setAutocorrect' ).checked = autocorrectOn;

    setBackdrop( 'settingsBackdrop', true );
}

function confirmSettings()
{
    const lang = [ ...document.querySelectorAll( '#proofLangs input:checked' ) ]
                     .map( function( i ) { return i.value; } ).join( ',' );

    setBackdrop( 'settingsBackdrop', false );

    setDocMode( document.getElementById( 'setMode' ).value );
    setAutocorrect( document.getElementById( 'setAutocorrect' ).checked );

    if( lang !== proofLangs.join( ',' ) ) changeProofLangs( lang );
    focusEditor();
}

//----------------------------------------------------------------------------//
// PROOFING LANGUAGE
//
// The spell check (proofing-overlay.js over proofing.js) reads `proofLangs`
// live; a change throws away what it had checked, so the page is read again in
// the new languages. No language at all = no red lines.

const spellProvider = makeSpellProvider( function() { return proofLangs; } );
let   spell         = null;     // proofing-overlay.js, made in wireStaticUI

function changeProofLangs( raw )
{
    proofLangs = raw ? raw.split( ',' ) : [];

    try { localStorage.setItem( PROOF_LANG_KEY, proofLangs.join( ',' ) ); } catch( _ ) {}
    resetProofing();
    if( spell ) spell.reset();
}

// One checkbox per vendored dictionary, built from proofing.js's own list so a
// new .aff/.dic pair shows up here without touching this file.
function renderProofLangs()
{
    const box = document.getElementById( 'proofLangs' );
    box.innerHTML = '';

    for( const code of PROOF_LANGS )
    {
        const label = document.createElement( 'label' );

        const box2 = document.createElement( 'input' );
        box2.type    = 'checkbox';
        box2.value   = code;
        box2.checked = proofLangs.indexOf( code ) >= 0;

        const txt = document.createElement( 'span' );
        txt.textContent = NayiveUI.t( 'write.proof.' + code );

        label.appendChild( box2 );
        label.appendChild( txt );
        box.appendChild( label );
    }
}

//----------------------------------------------------------------------------//
// ENCABEZADO / PIE  (and the page number in them)
//
// The buttons go in and out: "Encabezado" puts the caret in the page's header
// (the engine makes one if the section has none), pressed again it goes back to
// the body; "Pie" while in the header goes straight to the footer. Where the
// caret is comes from the engine (getHeaderFooterState), not from us.
//
// The page number is a real PAGE field, and only in a header or a footer - in
// the body it would print once, wherever it landed - so its button follows the
// engine's insert.pageNumber slot: greyed anywhere else (refreshToolbar).

function toggleHeaderFooter( kind )
{
    if( ! ready || ! editor ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    const cmd = hfEditing() === kind ? { type: 'exitHeaderFooter' }
                                     : { type: 'editHeaderFooter', position: kind };
    let r;
    try { r = editor.exec( cmd ); }
    catch( e ) { r = { ok: false, reason: String( e && e.message || e ) }; }

    if( r && r.ok === false )
    {
        console.error( 'Write: ' + cmd.type + ' -', r.reason );
        NayiveUI.toast( NayiveUI.t( 'write.headerFailed' ) );
        return;
    }
    focusEditor();          // the engine keeps the caret in the header or footer
    refreshToolbar();
}

// The buttons that are not engine slots, painted with the toolbar (toolbar.js
// calls this at the end of each paint): nothing that edits in read-only mode,
// table borders only in a table, and the header / footer / page number below.
function paintOwnButtons()
{
    let snap = null;
    try { snap = editor && editor.snapshot(); } catch( _ ) {}
    const editable = !! snap && snap.editable !== false;

    for( const id of [ 'paraBtn', 'linkBtn', 'imageBtn', 'symbolsBtn', 'headerBtn', 'footerBtn' ] )
        document.getElementById( id ).disabled = ! editable;

    document.getElementById( 'tableBordersBtn' ).disabled = ! editable || ! ( snap && snap.table );

    paintHeaderFooter();
}

// 'header', 'footer' or null: where the caret is.
function hfEditing()
{
    try { const now = editor && editor.getHeaderFooterState(); return now ? now.editing : null; }
    catch( _ ) { return null; }
}

// The Encabezado / Pie buttons look pressed while the caret is in theirs, and
// the page number is usable only there.
function paintHeaderFooter()
{
    const now = hfEditing();

    for( const kind of [ 'header', 'footer' ] )
    {
        const b  = document.getElementById( kind + 'Btn' );
        const on = now === kind;
        b.classList.toggle( 'is-active', on );
        b.setAttribute( 'aria-pressed', String( on ) );
    }
    document.getElementById( 'pageNumBtn' ).disabled = slotState( 'insert.pageNumber' ).enabled !== true;
}

//----------------------------------------------------------------------------//
// MI DICCIONARIO  (words the user adds by hand)
//
// A name you use every day should stop being red. The list lives with the rest
// of the app's data so it follows the account, not the browser.

const PERSONAL_DICT = 'data/write/dict.json';
let   personalWords = [];
let   dictRead      = false;   // the list was read (or there is none yet): only then may it be written

// None yet (a 404) is an empty list. Any other failure - a 5xx, a timeout, bad
// JSON, a shape that is not ours - leaves it UNKNOWN, and an unknown list is
// never written over (addPersonalWord): it would keep one word.
async function loadPersonalWords()
{
    try
    {
        const j = await GumApi.readJson( PERSONAL_DICT );
        if( j !== null && ! Array.isArray( j && j.words ) ) throw new Error( PERSONAL_DICT + ' has no word list' );
        personalWords = j ? j.words : [];
        dictRead      = true;
    }
    catch( e ) { console.error( 'Write: my dictionary -', e.message ); }

    setPersonalWords( personalWords );
}

async function addPersonalWord( word )
{
    word = String( word || '' ).trim();
    if( ! word ) return;

    if( ! dictRead ) await loadPersonalWords();       // it failed at start-up: once more
    if( ! dictRead ) { NayiveUI.toast( NayiveUI.tf( 'write.dictUnread', { word: word } ) ); return; }

    if( isPersonalWord( word ) ) return;

    personalWords.push( word );
    setPersonalWords( personalWords );

    let saved = true;
    try { await GumApi.writeJson( PERSONAL_DICT, { words: personalWords } ); }
    catch( _ ) { saved = false; }

    if( spell ) spell.forget( word );        // its red lines go at once

    if( ! saved ) { NayiveUI.toast( NayiveUI.t( 'write.dictSaveFailed' ) ); return; }
    session.offerUndo( NayiveUI.tf( 'write.wordAdded', { word: word } ), function() { removePersonalWord( word ); } );
}

// The Undo of "Add to dictionary": out of the list again, and red again. A full
// re-check (spell.reset), not a redraw: paragraphs checked after the add never
// flagged it - the worker skips the personal words.
async function removePersonalWord( word )
{
    const i = personalWords.indexOf( word );
    if( i === -1 ) return;

    personalWords.splice( i, 1 );
    setPersonalWords( personalWords );
    if( spell ) spell.reset();

    try { await GumApi.writeJson( PERSONAL_DICT, { words: personalWords } ); }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.dictSaveFailed' ) ); }
}

//----------------------------------------------------------------------------//
// AUTOCORRECCION  (smart quotes and friends)
//
// Off by default: it fights with file names, code and anything typed literally.
// One checkbox in Settings turns it on. It corrects the character as it is
// typed (onBeforeInput below) - not a paste, and not a symbol picked from the
// popup, which are meant to arrive exactly as they are.

const AUTOCORRECT_KEY = 'nayive-write-autocorrect';
let   autocorrectOn   = readAutocorrect();

function readAutocorrect()
{
    try { return localStorage.getItem( AUTOCORRECT_KEY ) === '1'; } catch( _ ) { return false; }
}

function setAutocorrect( on )
{
    autocorrectOn = !! on;
    try { localStorage.setItem( AUTOCORRECT_KEY, autocorrectOn ? '1' : '0' ); } catch( _ ) {}
}

// The replacements, applied to the text about to be inserted plus the character
// just before it (read off the page by the caller, for the quotes).
function autocorrectText( text, before )
{
    if( ! autocorrectOn || ! text ) return text;

    let out = text;

    out = out.replace( /\.\.\./g, '…' );
    out = out.replace( /(\s|^)--(\s)/g, '$1—$2' );

    // A quote opens after a space or at the start of a line, closes otherwise.
    out = out.replace( /"/g, function( _m, i )
    {
        const prev = i > 0 ? out[ i - 1 ] : ( before || '' ).slice( -1 );
        return ( ! prev || /[\s(¿¡«]/.test( prev ) ) ? '\u201C' : '\u201D';
    } );

    out = out.replace( /'/g, function( _m, i )
    {
        const prev = i > 0 ? out[ i - 1 ] : ( before || '' ).slice( -1 );
        return ( ! prev || /[\s(¿¡«]/.test( prev ) ) ? '\u2018' : '\u2019';
    } );

    return out;
}

// The only characters that can start a rule: the two quotes, the third dot, the
// space after --. Keep it in step with the rules above and below - a keystroke
// that cannot correct anything must not pay for reading the page.
const AUTOCORRECT_TRIGGERS = /["'.\s]/;

// Nothing public sees a character before it goes in, so the typing is caught in
// the DOM: the engine owns an ordinary contenteditable (.docx-pages, inside
// #editorHost), every character reaches it as a beforeinput of inputType
// "insertText", and Write listens in the CAPTURE phase of the scroller above it
// (quirks.js, noTypingHook). An event a rule does not touch is left completely
// alone - the engine's handlers must still see it.
function onBeforeInput( e )
{
    if( ! Q.noTypingHook || ! autocorrectOn || ! ready || ! editor ) return;
    if( e.inputType !== 'insertText' || ! e.data || e.isComposing ) return;
    if( ! AUTOCORRECT_TRIGGERS.test( e.data ) ) return;

    // Read-only, or a caret the engine cannot place text at: not ours to take.
    if( ! canExec( { type: 'insertText', text: e.data } ) ) return;

    const sel = caretNow();
    if( ! sel || ! sel.anchor || ! sel.head ) return;

    const pid  = sel.anchor.paragraphId;
    const text = paintedText( pid );

    // The dots and the dashes need the characters already typed, which only a
    // plain caret on one paragraph has: with something selected - about to be
    // replaced - only the quote rule runs, on the character before it.
    const same  = sel.head.paragraphId === pid;
    const start = same ? Math.min( sel.anchor.offset, sel.head.offset ) : sel.anchor.offset;
    const caret = same && sel.anchor.offset === sel.head.offset;
    const two   = caret ? ( text[ start - 2 ] || '' ) + ( text[ start - 1 ] || '' ) : '';

    let over = 0, out = null;

    if( caret && two === '..' && e.data === '.' )                       // a third dot
    {
        over = 2;  out = '…';
    }
    else if( caret && two === '--' && /\s/.test( e.data ) &&            // a space after --
             ( start === 2 || /\s/.test( text[ start - 3 ] || '' ) ) )
    {
        over = 2;  out = '—' + e.data;
    }
    else
    {
        const fixed = autocorrectText( e.data, text[ start - 1 ] || '' );
        if( fixed !== e.data ) out = fixed;
    }

    if( out === null ) return;

    // Taken over: preventDefault, or the browser writes the raw character into
    // the painted page; stopPropagation, or the engine puts it in as well.
    e.preventDefault();
    e.stopPropagation();

    // Swallow the characters the correction replaces. If the engine will not
    // take that selection, the character simply goes in as it was typed.
    if( over && ! selectBack( pid, start - over, start ) ) out = e.data;

    runExec( { type: 'insertText', text: out } );
}

// The `over` characters before the caret, selected so the next insert replaces
// them. True when the engine took it.
function selectBack( pid, from, to )
{
    try
    {
        const r = editor.exec( { type: 'setSelection',
                                 range: { anchor: { paragraphId: pid, offset: from },
                                          head  : { paragraphId: pid, offset: to   } } } );
        return ! r || r.ok !== false;
    }
    catch( _ ) { return false; }
}

//----------------------------------------------------------------------------//
// PLANTILLAS  /  RESTAURAR  /  RECIENTES

// Templates are just .docx files in a folder you pick. Nothing is shipped: the
// folder is yours, so what counts as a template is your business. Its own key in
// data/write/config.json, NOT the launcher-folder slot, so a future "open Write
// in folder X" cannot collide with it. Read-modify-write (shared/office.js,
// appConfig): a file that could not be read is never written over with just
// the key being changed (the templates folder, the menu bar).
const writeCfg = NayiveOffice.appConfig( 'data/write/config.json', 'ui.prefsUnread' );

async function openTemplates()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    let cfg;
    try { cfg = await writeCfg.read(); }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'ui.prefsUnread' ) ); return; }   // where the templates are is not known

    let dir = cfg.templatesDir;

    if( ! dir )
    {
        dir = await NayiveUI.pickFolder( { title: NayiveUI.t( 'write.pickTemplatesDir' ),
                                           note : NayiveUI.t( 'write.pickTemplatesNote' ),
                                           allowRoot: true } );
        if( ! dir ) return;
        await writeCfg.write( { templatesDir: dir } );
    }

    setBackdrop( 'tplBackdrop', true );
    renderTemplates( dir );
}

async function renderTemplates( dir )
{
    const list = document.getElementById( 'tplList' );
    const crumb = document.getElementById( 'tplCrumb' );

    crumb.textContent = NayiveOffice.dirLabel ? NayiveOffice.dirLabel( dir ) : dir;
    list.innerHTML = '<li class="is-loading"></li>';

    let nodes = [];
    try { nodes = ( ( await GumApi.listDir( dir ) ) || {} ).nodes || []; }
    catch( _ ) { list.innerHTML = ''; NayiveUI.toast( NayiveUI.t( 'ui.openFailed' ) ); return; }

    const docs = nodes.filter( function( n ) { return n.nodes === null && /\.docx$/i.test( n.path || '' ); } )
                      .sort( NayiveOffice.byBaseName );

    list.innerHTML = '';

    if( ! docs.length ) { list.innerHTML = '<li class="is-empty" data-i18n="write.noTemplates"></li>'; return; }

    for( const n of docs )
    {
        const li = document.createElement( 'li' );
        li.innerHTML = '<span class="open-ic"></span>';
        const nm = document.createElement( 'span' );
        nm.className   = 'open-nm';
        nm.textContent = baseName( n.path ).replace( /\.docx$/i, '' );
        li.appendChild( nm );
        li.addEventListener( 'click', function() { useTemplate( n.path ); } );
        list.appendChild( li );
    }
}

// A template opens as an UNTITLED document, so the first save asks where it goes
// - the template itself is never overwritten. It is named "<name> (copia)", so
// "Guardar como" in the templates folder never offers the template's own name
// either. An untitled document with edits
// is only in the device draft, and the template takes its place: as with New,
// it goes at once and the toast's Undo brings it back. One the session cannot
// keep for that (a password on it) gets New's question instead, while the list
// is still open (a "no" stays in it).
async function useTemplate( path )
{
    const dropping = session.dirty() && ! session.path();
    const kept     = dropping ? await session.keepUntitled() : null;
    if( dropping && ! kept && ! await NayiveUI.confirm( { title: NayiveUI.t( 'write.newDoc' ), body: NayiveUI.t( 'write.newDropsDraft' ),
                                                          confirm: NayiveUI.t( 'write.newDoc' ) } ) ) return;

    setBackdrop( 'tplBackdrop', false );

    try
    {
        await session.flush();

        await loadIntoEditor( await fetchBytes( path ) );

        if( dropping ) await session.dropDraft();     // or a reload would bring it back over the template
        session.untitled( docxName( NayiveUI.tf( 'write.templateCopy', { name: baseName( path ).replace( /\.docx$/i, '' ) } ) ),
                          { dirty: true } );
        if( kept ) session.offerBack( kept );
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.openDocFailed' ) ); }
}

async function changeTemplatesDir()
{
    const dir = await NayiveUI.pickFolder( { title: NayiveUI.t( 'write.pickTemplatesDir' ),
                                             note : NayiveUI.t( 'write.pickTemplatesNote' ),
                                             allowRoot: true } );
    if( ! dir ) return;

    await writeCfg.write( { templatesDir: dir } );
    renderTemplates( dir );
}

//----------------------------------------------------------------------------//
// SIMBOLOS  (special characters)
//
// An anchored popup off a toolbar button, the same trio as the table borders
// one: open / close / pointerdown-outside. A character goes in at the caret
// (over the selection, as typing would) and the popup stays open for the next.

const SYMBOL_SETS = [
    { key: 'punct',    chars: '¡¿…–—·•«»“”‘’„†‡§¶©®™°′″‰&@#*/\\|~^_' },
    { key: 'latin',    chars: 'áéíóúüñÁÉÍÓÚÜÑàèìòùâêîôûäëïöçÇåøæœÅØÆŒßÿ' },
    { key: 'math',     chars: '+−×÷=≠≈<>≤≥±∓∞√∛∫∑∏∂∆∇%‱½⅓¼¾⅔⅛π¬∧∨∩∪⊂⊃∈∉∅' },
    { key: 'arrows',   chars: '←→↑↓↔↕⇐⇒⇑⇓⇔⇕↖↗↘↙⟵⟶⟷▲▼◀▶△▽◁▷' },
    { key: 'currency', chars: '€$£¥¢₽₹₩₪₫₴₺₦₡₱฿' },
    { key: 'other',    chars: '★☆✓✔✗✘☑☐☒♠♣♥♦♪♫☀☁☂❄☺☹✉✂✈⌛⌚№' }
];

let symTab = 0;

function openSymbols()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    if( document.getElementById( 'symPopup' ).classList.contains( 'open' ) ) { symPopup.close(); return; }

    renderSymbols();
    symPopup.open();
}

function renderSymbols()
{
    const tabs = document.getElementById( 'symTabs' );
    const grid = document.getElementById( 'symGrid' );

    tabs.innerHTML = '';
    grid.innerHTML = '';

    SYMBOL_SETS.forEach( function( set, i )
    {
        const b = document.createElement( 'button' );
        b.type        = 'button';
        b.className   = 'pill sym-tab' + ( i === symTab ? ' is-active' : '' );
        b.textContent = NayiveUI.t( 'write.sym.' + set.key );
        b.addEventListener( 'click', function() { symTab = i; renderSymbols(); } );
        tabs.appendChild( b );
    } );

    for( const ch of Array.from( SYMBOL_SETS[ symTab ].chars ) )
    {
        const b = document.createElement( 'button' );
        b.type        = 'button';
        b.className   = 'sym-cell';
        b.textContent = ch;
        b.title       = ch;
        // mousedown would move focus out of the editor before the click lands.
        b.addEventListener( 'mousedown', function( e ) { e.preventDefault(); } );
        b.addEventListener( 'click', function() { insertSymbol( ch ); } );
        grid.appendChild( b );
    }
}

function insertSymbol( ch ) { runExec( { type: 'insertText', text: ch } ); }

const symPopup = anchoredPopup( 'symPopup', '#symbolsBtn' );

//----------------------------------------------------------------------------//
// PARRAFO  (spacing, indents, keep-together, tab stops, list number format)
//
// Filled from the caret's paragraph (snapshot().formatting reads it back) and
// applied with ONE setParagraphFormat - one undo step. Still, only the GROUPS
// the user touched are sent: over several paragraphs that disagree a field
// shows blank, and applying the whole form would flatten what nobody looked
// at. Borders and shading are gone with the old engine (his call, 2026-09-18).
//
// The list number format has no engine command: it is written into
// numbering.xml (docx-patch.js) and the document reloaded, which clears the
// undo history - the dialog says so.

const PARA_GROUPS = {
    paSpacing : [ 'paBefore', 'paAfter', 'paLine' ],
    paIndent  : [ 'paLeft', 'paRight', 'paSpecial', 'paSpecialBy' ],
    paKeep    : [ 'paKeepNext', 'paKeepLines' ],
    paTabs    : [ 'paTabPos', 'paTabAlign' ],
    paList    : [ 'paListLevel', 'paListFormat' ]
};

let paraTouched = new Set();
let paraFmt     = null;     // snapshot().formatting when the dialog opened
let paraList    = null;     // { paraId, numId, ilvl, formats } when the caret is in a numbered list

// "1,5" in Spanish, "1.5" in English - the dialogs' own numbers (this one's
// and the page setup's).
function fmtNum( v ) { return ( Math.round( v * 100 ) / 100 ).toLocaleString( NayiveUI.locale(), { maximumFractionDigits: 2 } ); }
function parseNum( raw ) { const n = parseFloat( String( raw ).replace( ',', '.' ) ); return Number.isFinite( n ) ? n : null; }

function openParagraph()
{
    if( ! ready || ! editor ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    let f = null;
    try { f = editor.snapshot().formatting; } catch( _ ) {}
    paraFmt = f || {};

    const val = function( id, v ) { document.getElementById( id ).value = v; };
    const has = function( v ) { return v !== null && v !== undefined; };
    const ind = paraFmt.indent || null;

    val( 'paBefore', has( paraFmt.spaceBeforePt ) ? fmtNum( paraFmt.spaceBeforePt ) : ( paraFmt.disagrees && paraFmt.disagrees.spaceBeforePt ? '' : '0' ) );
    val( 'paAfter',  has( paraFmt.spaceAfterPt  ) ? fmtNum( paraFmt.spaceAfterPt  ) : ( paraFmt.disagrees && paraFmt.disagrees.spaceAfterPt  ? '' : '0' ) );
    showLineSpacing( paraFmt.lineSpacing || null );

    val( 'paLeft',  ind && ! ind.mixed.left  ? fmtNum( twipsToCm( ind.left  ) ) : ( ind ? '' : '0' ) );
    val( 'paRight', ind && ! ind.mixed.right ? fmtNum( twipsToCm( ind.right ) ) : ( ind ? '' : '0' ) );

    const first = ind && ! ind.mixed.firstLine ? ind.firstLine : 0;
    val( 'paSpecial',   first > 0 ? 'first' : first < 0 ? 'hanging' : 'none' );
    val( 'paSpecialBy', fmtNum( first ? twipsToCm( Math.abs( first ) ) : 1.25 ) );

    const flags = paraFmt.paragraphFlags || {};
    document.getElementById( 'paKeepNext'  ).checked = flags.keepNext  === true;
    document.getElementById( 'paKeepLines' ).checked = flags.keepLines === true;

    val( 'paTabPos', '0' );
    val( 'paTabAlign', 'left' );

    paraTouched = new Set();
    paraList    = null;
    fillParagraphList();
    syncParagraphRows();
    setBackdrop( 'paraBackdrop', true );
}

// The line spacing list holds Word's multiples; a value it does not name (1,08,
// "exactly 12 pt") is added for the moment, so the dialog shows the truth and
// applying it without touching it changes nothing.
function showLineSpacing( ls )
{
    const sel   = document.getElementById( 'paLine' );
    const extra = sel.querySelector( 'option[data-extra]' );
    if( extra ) extra.remove();

    // The multiples in the markup are labelled in the language's own way: "1,5" or "1.5".
    for( const o of sel.options ) o.textContent = fmtNum( parseFloat( o.value ) );

    if( ! ls ) { sel.value = ''; return; }

    const v = ls.rule === 'multiple' ? String( Math.round( ls.value * 100 ) / 100 ) : ls.rule + ':' + ls.value;

    if( ! [ ...sel.options ].some( function( o ) { return o.value === v; } ) )
    {
        const op = new Option( ls.rule === 'multiple' ? fmtNum( ls.value ) : fmtNum( ls.value ) + ' pt', v );
        op.dataset.extra = '1';
        sel.appendChild( op );
    }
    sel.value = v;
}

// The list part: which level of the caret's list, and how it is numbered. The
// numbering lives in the saved package, so it is read from there (a save is a
// few milliseconds) and the fields fill in when it answers - greyed until then,
// so a pick made meanwhile is not overwritten by the answer.
let paraListAsk = 0;     // the newest fillParagraphList: an older answer is dropped

async function fillParagraphList()
{
    const note  = document.getElementById( 'paListNote' );
    const level = document.getElementById( 'paListLevel' );
    const fmt   = document.getElementById( 'paListFormat' );
    const mine  = ++paraListAsk;

    level.value    = '1';
    fmt.value      = 'decimal';
    note.hidden    = true;
    level.disabled = fmt.disabled = false;

    let paraId = null;
    try { const sel = editor.snapshot().selection; paraId = sel && sel.from && sel.from.paraId; } catch( _ ) {}
    if( ! paraId || ! slotState( 'list.numbered' ).active ) return;

    level.disabled = fmt.disabled = true;
    try
    {
        const info = patcher.listInfo( new Uint8Array( await editor.save() ), paraId );
        if( ! info || mine !== paraListAsk ) return;

        paraList    = Object.assign( { paraId: paraId }, info );
        level.value = String( Math.min( info.ilvl + 1, level.options.length ) );
        note.hidden = false;
        showListFormat();
    }
    catch( e ) { console.error( 'Write: list format -', e ); }
    finally { if( mine === paraListAsk ) level.disabled = fmt.disabled = false; }
}

// The format select follows the level select: level 2 of a "1, 2, 3" list may
// well be "a, b, c".
function showListFormat()
{
    if( ! paraList ) return;

    const sel   = document.getElementById( 'paListFormat' );
    const want  = paraList.formats[ parseInt( document.getElementById( 'paListLevel' ).value, 10 ) - 1 ] || 'decimal';
    const extra = sel.querySelector( 'option[data-extra]' );
    if( extra ) extra.remove();

    if( ! [ ...sel.options ].some( function( o ) { return o.value === want; } ) )
    {
        const op = new Option( want === 'bullet' ? '•' : want, want );
        op.dataset.extra = '1';
        sel.appendChild( op );
    }
    sel.value = want;
}

// "Primera línea" / "Francesa" need an amount; "Ninguna" does not. Same
// row-hiding idiom Calc's number-format dialog uses.
function syncParagraphRows()
{
    const sp = document.getElementById( 'paSpecial' ).value;
    document.getElementById( 'paSpecialByField' ).hidden = sp === 'none';
}

function markParagraphTouched( id )
{
    for( const g in PARA_GROUPS ) if( PARA_GROUPS[ g ].indexOf( id ) >= 0 ) paraTouched.add( g );
}

// The command for the touched groups. A blank field (the selection disagreed
// and the user left it so) is left out, not zeroed.
function paragraphCommand()
{
    const val = function( id ) { return document.getElementById( id ).value; };
    const cmd = { type: 'setParagraphFormat' };

    if( paraTouched.has( 'paSpacing' ) )
    {
        const b = parseNum( val( 'paBefore' ) ), a = parseNum( val( 'paAfter' ) );
        if( b !== null ) cmd.spaceBeforePt = Math.max( 0, b );
        if( a !== null ) cmd.spaceAfterPt  = Math.max( 0, a );

        const line = val( 'paLine' );
        const m    = /^(exact|atLeast):(.+)$/.exec( line );
        if( m ) cmd.lineSpacing = { rule: m[1], value: parseFloat( m[2] ) };
        else if( parseNum( line ) ) cmd.lineSpacing = { rule: 'multiple', value: parseNum( line ) };
    }

    if( paraTouched.has( 'paIndent' ) )
    {
        const l = parseCm( val( 'paLeft' ), 20 ), r = parseCm( val( 'paRight' ), 20 );
        if( l !== null ) cmd.indentLeftTwips  = cmToTw( l );
        if( r !== null ) cmd.indentRightTwips = cmToTw( r );

        const special = val( 'paSpecial' );
        const by      = cmToTw( parseCm( val( 'paSpecialBy' ), 20 ) ?? 0 );
        cmd.indentFirstLineTwips = special === 'first' ? by : special === 'hanging' ? -by : 0;
    }

    if( paraTouched.has( 'paKeep' ) )
    {
        cmd.keepNext  = document.getElementById( 'paKeepNext'  ).checked;
        cmd.keepLines = document.getElementById( 'paKeepLines' ).checked;
    }

    // One stop per apply, as before: 0 clears them all, anything else is added
    // to (or replaces, at the same place) the ones the paragraph has.
    if( paraTouched.has( 'paTabs' ) )
    {
        const pos = parseCm( val( 'paTabPos' ), 50 );
        cmd.tabStops = pos === null || pos <= 0 ? [] : tabStopsWith( cmToTw( pos ), val( 'paTabAlign' ) );
    }

    return Object.keys( cmd ).length > 1 ? cmd : null;
}

// The paragraph's own stops plus the new one. The engine's read-back also lists
// the stop Word implies at a hanging indent, which is not in the file - it is
// left out, or applying would write it for real.
function tabStopsWith( twips, alignment )
{
    const ind  = paraFmt && paraFmt.indent;
    const have = ( paraFmt && paraFmt.tabStops ) || [];

    const own = have.filter( function( t )
    {
        if( ind && ind.firstLine < 0 && t.positionTwips === ind.left && t.alignment === 'left' ) return false;
        return Math.abs( t.positionTwips - twips ) > 10;
    } );

    return own.concat( [ { positionTwips: twips, alignment: alignment } ] )
              .sort( function( a, b ) { return a.positionTwips - b.positionTwips; } );
}

async function confirmParagraph()
{
    setBackdrop( 'paraBackdrop', false );

    if( ! ready || ! editor || ! paraTouched.size ) { focusEditor(); return; }   // nothing touched: change nothing

    const cmd = paragraphCommand();
    if( cmd ) runExec( cmd );

    if( paraTouched.has( 'paList' ) ) await applyListFormat();
}

// Level n of the caret's list numbered the chosen way (docx-patch.js), then the
// document back on screen with the caret where it was. load() starts a fresh
// undo history (the dialog says so) and is not an edit, so the session is told.
async function applyListFormat()
{
    if( ! paraList ) { NayiveUI.toast( NayiveUI.t( 'write.notInList' ) ); return; }

    const ilvl = parseInt( document.getElementById( 'paListLevel' ).value, 10 ) - 1;
    const fmt  = document.getElementById( 'paListFormat' ).value;
    if( paraList.formats[ ilvl ] === fmt ) return;

    const scroller = document.getElementById( 'editor' );
    const top      = scroller.scrollTop;

    try
    {
        // The dialog's other changes armed the autosave: it goes now, not in
        // the middle of the load below.
        await session.flush();

        const bytes = patcher.withListFormat( new Uint8Array( await editor.save() ), paraList, ilvl, fmt );
        if( ! bytes ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); return; }

        await loadIntoEditor( bytes );

        editor.exec( { type: 'setSelection', anchor: { paraId: paraList.paraId } } );
        scroller.scrollTop = top;
        session.edited();
        focusEditor();
    }
    catch( e )
    {
        console.error( 'Write: list format -', e );
        NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) );
    }
}

//----------------------------------------------------------------------------//
// ESTADISTICAS  (word count)
//
// Read when the dialog opens, not live. The body's paragraphs, one by one (so
// the last word of one and the first of the next never run together) - headers,
// footers and footnotes are not in it, which matches what people mean by a
// word count.

async function openStats()
{
    if( ! ready || ! editor ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    let paras;
    try { paras = editor.query( { type: 'paragraphs' } ) || []; }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); return; }

    let words = 0, chars = 0, noSpaces = 0, count = 0;

    for( const p of paras )
    {
        const t = ( p && p.text ) || '';

        chars    += t.length;
        noSpaces += t.replace( /\s/g, '' ).length;

        const trimmed = t.trim();
        if( ! trimmed ) continue;

        count += 1;
        words += trimmed.split( /\s+/ ).length;
    }

    NayiveOffice.showStats( [
        { text: NayiveUI.t( 'write.statWords'      ), value: fmtCount( words )    },
        { text: NayiveUI.t( 'write.statChars'      ), value: fmtCount( chars )    },
        { text: NayiveUI.t( 'write.statCharsNoSp'  ), value: fmtCount( noSpaces ) },
        { text: NayiveUI.t( 'write.statParagraphs' ), value: fmtCount( count )    },
        { text: NayiveUI.t( 'write.statPages'      ), value: fmtCount( editor.getTotalPages() ) }
    ], NayiveUI.t( 'write.statNote' ) );
}

// Thousands separators in the reader's own locale.
function fmtCount( n )
{
    try { return new Intl.NumberFormat( NayiveUI.locale() ).format( n ); }
    catch( _ ) { return String( n ); }
}

//----------------------------------------------------------------------------//
// KEYBOARD SHORTCUTS
//
// Same shape as Drive's table (apps/drive/index.html): one row per shortcut,
// `match` on e.code rather than e.key because e.key is what the LAYOUT produces
// (Ctrl+P on a Cyrillic keyboard reads as a Cyrillic letter), and `label` for
// both the tooltip hint and the help sheet.
//
// Ctrl+N is NOT here: Chrome opens a new window on it and a page cannot take
// that back. "Documento nuevo" gets Alt+N, exactly as Drive's "nueva carpeta"
// did for the same reason.

const IS_MAC = NayiveUI.isMac;

function kMod()   { return IS_MAC ? '⌘' : NayiveUI.t( 'ui.keyCtrl'  ); }
function kAlt()   { return IS_MAC ? '⌥' : NayiveUI.t( 'ui.keyAlt'   ); }
function kShift() { return IS_MAC ? '⇧' : NayiveUI.t( 'ui.keyShift' ); }
function combo( parts ) { return parts.join( IS_MAC ? '' : '+' ); }

function modOnly( e )
{
    return ( IS_MAC ? ( e.metaKey && ! e.ctrlKey ) : ( e.ctrlKey && ! e.metaKey ) )
           && ! e.altKey && ! e.shiftKey;
}

// AltGr is Ctrl+Alt to the browser on Windows, so AltGr+2 ("@" on a Spanish or
// French keyboard) would read as Ctrl+Alt+2. When the keys TYPE something other
// than the digit, the typing wins. (A Mac needs ⌘, which AltGr never is.)
function modAlt( e )
{
    if( ! IS_MAC && e.key && e.key.length === 1 && ! /[0-9]/.test( e.key ) ) return false;
    return ( IS_MAC ? e.metaKey : e.ctrlKey ) && e.altKey && ! e.shiftKey;
}

function modShift( e )
{
    return ( IS_MAC ? ( e.metaKey && ! e.ctrlKey ) : ( e.ctrlKey && ! e.metaKey ) )
           && e.shiftKey && ! e.altKey;
}

const SHORTCUTS = [
    // Saves in place, so no button carries its hint ("Guardar como" asks for a
    // name); the Archivo menu's Guardar row shows it.
    { key: 'write.sc.save',   label: () => combo( [ kMod(), 'S' ] ), browserDialog: true,
      match: e => modOnly( e ) && e.code === 'KeyS', run: saveNow },

    { el: 'printBtn',  key: 'write.print',     label: () => combo( [ kMod(), 'P' ] ), browserDialog: true,
      match: e => modOnly( e ) && e.code === 'KeyP', run: () => printDocument( false ) },

    { el: 'openBtn',   key: 'ui.openDoc',      label: () => combo( [ kMod(), 'O' ] ), browserDialog: true,
      match: e => modOnly( e ) && e.code === 'KeyO' },

    { el: 'newBtn',    key: 'write.newDoc',    label: () => combo( [ kAlt(), 'N' ] ),
      match: e => e.altKey && ! e.ctrlKey && ! e.metaKey && ! e.shiftKey && e.code === 'KeyN' },

    // Cut, copy and paste are the ENGINE's (the old engine's stale-copy
    // workaround is gone with it). Listed for the help sheet, never matched.
    // Paste without formatting is ours, as before: the clipboard's text alone.
    { key: 'ui.cut',   label: () => combo( [ kMod(), 'X' ] ), match: () => false },
    { key: 'ui.copy',  label: () => combo( [ kMod(), 'C' ] ), match: () => false },
    { key: 'ui.paste', label: () => combo( [ kMod(), 'V' ] ), match: () => false },
    { key: 'ui.pastePlain', label: () => combo( [ kMod(), kShift(), 'V' ] ),
      match: e => modShift( e ) && e.code === 'KeyV', run: () => clipPaste( true ) },

    // Ctrl+K reaches the engine first, which asks for the link sheet itself
    // (setHyperlinkChrome, onRequest); matched here too so the browser's own
    // Ctrl+K never opens.
    { key: 'write.sc.link',    label: () => combo( [ kMod(), 'K' ] ),
      match: e => modOnly( e ) && e.code === 'KeyK', run: () => openLinkDialog() },
    { key: 'write.sc.find',    label: () => combo( [ kMod(), 'F' ] ),
      match: e => modOnly( e ) && e.code === 'KeyF', run: () => openFind( false ) },
    { key: 'write.sc.replace', label: () => combo( [ kMod(), 'H' ] ),
      match: e => modOnly( e ) && e.code === 'KeyH', run: () => openFind( true ) },

    { key: 'write.sc.alignLeft',    label: () => combo( [ kMod(), 'L' ] ),
      match: e => modOnly( e ) && e.code === 'KeyL', run: () => runSlot( 'alignment.left' ) },
    { key: 'write.sc.alignCenter',  label: () => combo( [ kMod(), 'E' ] ),
      match: e => modOnly( e ) && e.code === 'KeyE', run: () => runSlot( 'alignment.center' ) },
    { key: 'write.sc.alignRight',   label: () => combo( [ kMod(), 'R' ] ),
      match: e => modOnly( e ) && e.code === 'KeyR', run: () => runSlot( 'alignment.right' ) },
    { key: 'write.sc.alignJustify', label: () => combo( [ kMod(), 'J' ] ),
      match: e => modOnly( e ) && e.code === 'KeyJ', run: () => runSlot( 'alignment.justify' ) },

    { key: 'write.sc.normal',   label: () => combo( [ kMod(), kAlt(), '0' ] ),
      match: e => modAlt( e ) && e.code === 'Digit0', run: () => setStyle( 'Normal' ) },
    { key: 'write.sc.heading1', label: () => combo( [ kMod(), kAlt(), '1' ] ),
      match: e => modAlt( e ) && e.code === 'Digit1', run: () => setStyle( 'Heading1' ) },
    { key: 'write.sc.heading2', label: () => combo( [ kMod(), kAlt(), '2' ] ),
      match: e => modAlt( e ) && e.code === 'Digit2', run: () => setStyle( 'Heading2' ) },
    { key: 'write.sc.heading3', label: () => combo( [ kMod(), kAlt(), '3' ] ),
      match: e => modAlt( e ) && e.code === 'Digit3', run: () => setStyle( 'Heading3' ) },

    { el: 'settingsBtn', key: 'ui.settings', label: () => combo( [ kMod(), ',' ] ),
      match: e => modOnly( e ) && e.code === 'Comma' }
];

let toolbar = null;    // toolbar.js, made in wireStaticUI

function refreshToolbar() { if( toolbar ) toolbar.refresh(); }

// A toolbar slot of the engine's own chrome vocabulary ('alignment.left',
// 'styles.style' + a style id ...): the same call the toolbar's buttons make,
// so a shortcut and its button can never disagree.
function runSlot( slot, value )
{
    if( ! ready || ! editor || slotBlocked( slot ) ) return;

    let r;
    try { r = value === undefined ? runToolbarCommand( editor, slot ) : runToolbarCommand( editor, slot, value ); }
    catch( e ) { r = { ok: false, reason: String( e && e.message || e ) }; }

    if( r && r.ok === false )
    {
        console.error( 'Write: ' + slot + ' -', r.reason );
        NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) );
        return;
    }
    if( slot === 'insert.pageBreak' ) landAfterPageBreak();
    focusEditor();
}

// A page break as the very last thing in the document gets no page of its own
// until something follows it, so the caret stays on the old page (quirks.js,
// pageBreakNotRepainted). Word puts a new paragraph after the break there, and
// so does Write: the new page appears, with the caret on it. Undo is then two
// steps, that paragraph and the break.
function landAfterPageBreak()
{
    if( ! Q.pageBreakNotRepainted || ! editor ) return;

    try
    {
        const paras = editor.query( { type: 'paragraphs' } ) || [];
        const last  = paras[ paras.length - 1 ];
        const snap  = editor.snapshot();
        const sel   = caretNow();

        if( ! last || ! snap.selection || snap.selection.from.paraId !== last.paraId || ! /\f$/.test( last.text ) ) return;
        if( ! sel || sel.anchor.offset !== last.text.length || sel.head.offset !== last.text.length ) return;

        editor.surface.splitParagraph();
    }
    catch( e ) { console.error( 'Write: page break -', e ); }
}

// A slot the engine would run but Write holds back. A footnote with text
// selected REPLACES that text with the note's mark (Word keeps the text and
// puts the mark after it), and it takes two undos to get the text back - so it
// waits for a plain caret (quirks.js, footnoteReplacesSelection).
function slotBlocked( slot )
{
    if( slot !== 'insert.footnote' || ! editor ) return false;
    try { return ! editor.snapshot().selectionCollapsed; } catch( _ ) { return false; }
}

// The format painter is on / off, from the button and the menu alike: a press
// arms it for one paste, the next press puts it away. (The engine's own cycle is
// off -> once -> locked -> off; the locked step is skipped, so the button and
// the tick read as the on / off they look like.)
function togglePainter()
{
    const armed = function() { return ( slotState( 'format.painter' ).value || 'off' ) !== 'off'; };

    if( ! armed() ) { runSlot( 'format.painter' ); return; }
    for( let i = 0; i < 2 && armed(); i++ ) runSlot( 'format.painter' );
}

// Replace one found word (a TextMatch from findMatches) with `text`. The engine's
// own replaceMatch is refused in 2.21.0 ("not supported by the tree editor"),
// so: select the match, then insert the text over the selection - one undo
// step, and the new word takes the old one's formatting, as typing would
// (quirks.js, replaceMatchUnsupported).
function replaceMatch( match, text )
{
    if( ! ready || ! editor ) return;

    const sel = match ? editor.selectMatch( match ) : null;
    if( ! sel || sel.ok === false ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); return; }

    runExec( { type: 'insertText', text: text } );
}

// An engine command that is not a toolbar slot (the table's rows and columns).
function runExec( cmd )
{
    if( ! ready || ! editor ) return;

    let r;
    try { r = editor.exec( cmd ); }
    catch( e ) { r = { ok: false, reason: String( e && e.message || e ) }; }

    if( r && r.ok === false )
    {
        console.error( 'Write: ' + cmd.type + ' -', r.reason );
        NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) );
        return;
    }
    focusEditor();
}

//---- TABLE CELLS: Tab and Shift+Tab ------------------------------------------//
//
// In a table Tab goes to the next cell and Shift+Tab to the one before, as in
// Word, and Tab in the last cell adds a row. The engine types a tab character
// there instead (quirks.js, tabInTable). The cells' paragraphs come in reading
// order from the paragraphs query; the caret walks them until the engine's
// table context names another cell.

function onTableTab( e )
{
    if( e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || ! Q.tabInTable || ! ready || ! editor ) return;

    let snap = null;
    try { snap = editor.snapshot(); } catch( _ ) { return; }
    if( ! snap || ! snap.table || ! snap.selection || snap.editable === false ) return;

    e.preventDefault();
    e.stopPropagation();
    moveCell( e.shiftKey ? -1 : 1, snap.table, snap.selection.from.paraId );
}

function moveCell( dir, from, here, grown )
{
    let paras = [];
    try { paras = editor.query( { type: 'paragraphs' } ) || []; } catch( _ ) {}

    const put = function( id ) { editor.exec( { type: 'setSelection', anchor: { paraId: id } } ); };
    let i = paras.findIndex( function( p ) { return p.paraId === here; } );
    if( i < 0 ) return;

    for( i += dir; i >= 0 && i < paras.length; i += dir )
    {
        put( paras[ i ].paraId );
        const t = editor.snapshot().table;
        if( ! t ) break;                                               // out of the table
        if( t.rowIndex !== from.rowIndex || t.columnIndex !== from.columnIndex ) { focusEditor(); return; }
    }

    // Past the first or the last cell: the caret stays; Tab in the last one
    // adds a row below and goes on into it.
    put( here );
    if( dir > 0 && ! grown && from.rowIndex === from.rows - 1 && from.columnIndex === from.columns - 1 )
    {
        const r = editor.exec( { type: 'insertRow', where: 'below' } );
        if( r && r.ok !== false ) { moveCell( 1, from, here, true ); return; }
    }
    focusEditor();
}

// A new table at the caret. The engine lands it after the caret's paragraph
// and puts the caret in its first cell.
function tableCommand( rows, cols )
{
    return { type: 'insertTable', target: editor && editor.snapshot().selection, rows: rows, cols: cols };
}

// The zoom: a fixed percentage, or 'fit' - the engine's own fit to the width
// (never below 50 %), which is what every document opens with.
function setZoom( z )
{
    if( ! editor ) return;

    const r = z === 'fit' ? editor.setZoomMode( 'auto' ) : editor.setZoom( z / 100 );
    if( r && r.ok === false ) console.error( 'Write: zoom -', r.reason );
    focusEditor();
}

function zoomFixed()
{
    try { return editor.getZoomMode().type === 'fixed'; }
    catch( _ ) { return false; }
}

// A shortcut must not fire while a dialog owns the screen, or while the user is
// typing in one of OUR text boxes (the file name, a page-setup field). The
// EDITOR is not such a box - shortcuts are for use while writing.
function inOwnField( t )
{
    const f = ( t && t.closest ) ? t.closest( 'input, textarea, select' ) : null;
    return !! f && ! f.closest( '#editor' );
}

function onShortcutKey( e )
{
    const s = SHORTCUTS.find( function( x ) { return x.match( e ); } );
    if( ! s ) return;

    // A sheet or a field of ours has the keys: the shortcut waits - but the
    // browser's own save / print / open dialog must not open over it either.
    if( document.querySelector( '.sheet-backdrop.open' ) || inOwnField( e.target ) )
    {
        if( s.browserDialog ) e.preventDefault();
        return;
    }

    // Swallowed even when the action cannot run, so the browser's own print /
    // open / bookmark never appears over the document.
    e.preventDefault();

    if( s.run ) { s.run(); return; }

    const btn = s.el && document.getElementById( s.el );
    if( btn && ! btn.disabled ) btn.click();
}

// Hang " - Ctrl+P" off each button's tooltip on a PC, and take it off again on a
// phone. Idempotent: i18n rewrites these titles when the language changes.
const HINT_SEP = ' · ';

function applyKeyHints()
{
    const phone = PHONE.matches;

    for( const s of SHORTCUTS )
    {
        const el = s.el && document.getElementById( s.el );
        if( ! el ) continue;

        const hint = HINT_SEP + s.label();
        let   t    = el.getAttribute( 'title' ) || '';

        if( t.slice( -hint.length ) === hint ) t = t.slice( 0, -hint.length );
        if( ! t ) continue;

        el.setAttribute( 'title', phone ? t : t + hint );
    }
}

// The help sheet: the same table, rendered (the sheet is Calc's too).
function openShortcuts()
{
    NayiveOffice.showShortcuts( SHORTCUTS.map( function( s ) { return { text: NayiveUI.t( s.key ), keys: s.label() }; } ) );
}

//----------------------------------------------------------------------------//
// PRINT  /  SAVE AS PDF
//
// The browser's own dialog over the @media print block in index.html: the
// pages are real DOM with real text, so paper gets type. "Guardar como PDF" is
// the SAME dialog - the browser writes a very good PDF - and the only
// difference is a line telling you where to pick it.
//
// The printed sheet has to be the DOCUMENT's page, not the printer's default:
// without an @page size the browser prints on Letter, an A4 page is taller than
// that, and every page spills onto two sheets. The size is read from the
// document (twips) just before printing.

function applyPrintPageSize()
{
    let css = '@page { margin: 0; }';

    try
    {
        const ps = editor.getPageSetup();
        if( ps && ps.pageWidthTwips && ps.pageHeightTwips )
        {
            const mm = function( t ) { return ( t / 1440 * 25.4 ).toFixed( 2 ) + 'mm'; };
            css = '@page { size: ' + mm( ps.pageWidthTwips ) + ' ' + mm( ps.pageHeightTwips ) + '; margin: 0; }';
        }
    }
    catch( _ ) { /* fall back to the plain margin:0 rule */ }

    let el = document.getElementById( 'printPageSize' );
    if( ! el ) { el = document.createElement( 'style' ); el.id = 'printPageSize'; document.head.appendChild( el ); }
    el.textContent = css;
}

function printDocument( pdfHint )
{
    if( ! ready || ! editor ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    applyPrintPageSize();

    if( pdfHint ) NayiveUI.toast( NayiveUI.t( 'write.pdfHint' ), { ms: 5000 } );

    // A tick, so the toast paints before the modal print dialog freezes the page.
    setTimeout( function() { window.print(); }, pdfHint ? 350 : 0 );
}

//----------------------------------------------------------------------------//
// PULL-DOWN MENUS  -  Write's other menu chrome
//
// Write has TWO chromes and a pair of header buttons picks between them (the
// same shape Calendar uses for day / week / month - icons with tooltips, the
// current one filled with the accent):
//
//   'toolbar'  the icon strip (the original, and still the default)
//   'menus'    classic pull-downs - Archivo, Edicion, Ver, Insertar, Formato,
//              Herramientas, Tabla, Ayuda - laid out the way Word did it before
//              the ribbon.
//
// The choice is saved TWICE on purpose: in localStorage, which is what a fresh
// load starts from with no network wait, and in data/write/config.json, which is
// the account's copy - so picking menus on the desktop is what the phone opens
// with too. The server copy wins at boot; localStorage is only the fast cache.
//
// Neither is a second implementation of anything. A menu entry either CLICKS the
// real button in #writeTools (`el`), or runs the same engine command the toolbar
// button runs (`cmd`), or calls the very function the button is wired to
// (`run`). So there is still one set of handlers, exactly as the phone's "..."
// menu does it (MENU_IDS above).
//
// Menu mode collapses #toolbarRow to height 0 with visibility:hidden, so the
// real buttons stay in the DOM for the entries that click them.
//
// An entry that formats names the engine's toolbar SLOT (`slot`, the same call
// the toolbar's button makes) and its tick and greying come from the engine's
// toolbarCommandState() at the moment the panel opens.
//
// THE MACHINERY IS NOT HERE. The bar, the panels, the hover-to-slide behaviour
// and the toolbar/menus switch all live in shared/menubar.js, which Calc uses
// too; the item vocabulary is documented at the top of that file. What is left
// below is Write's own: the table of menus, and the small hooks that read and
// drive the engine.

//---- the table ------------------------------------------------------------//
//
// One entry per menu. An item is:
//
//   { key }                   label (an i18n key)
//   { el:'saveAsBtn' }        click that button - and grey the entry out when
//                             the button itself is disabled
//   { slot:'text.bold' }      run that toolbar slot; tick while it is on
//   { slot, value }           a value slot (a size, a colour): tick while it is the one
//   { exec:{ type:... } }     an engine command; grey while a dry run says no
//   { run: fn }               call it
//   { sub: [...] | fn }       a submenu (a function is called at open time)
//   { sep: true }             a hairline
//   { checked: fn }           tick when fn() says so
//   { enabled: fn }           grey out when fn() says no
//   { sc:'write.sc.save' }    show that SHORTCUTS entry's key combo on the right
//   { swatch:'#c00' }         a colour chip before the label
//   { iconOf: '#x svg' }      the glyph before the label, cloned from the
//                             toolbar (an `el` entry gets its button's by itself)
//   { icon:'cut' }            ... or a NayiveUI.icon() name, for no-button entries

const MENU_FONTS  = [ 'Arial', 'Calibri', 'Cambria', 'Courier New', 'Georgia',
                      'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana' ];
const MENU_SIZES  = [ '8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36', '48', '72' ];
const MENU_ZOOMS  = [ 50, 75, 100, 125, 150, 200 ];
const MENU_LINES  = [ 1, 1.15, 1.5, 2 ];
const MENU_GRIDS  = [ [ 2, 2 ], [ 2, 3 ], [ 3, 3 ], [ 4, 4 ], [ 5, 5 ] ];

// Highlighting is Word's fixed set of named colours (ST_HighlightColor), not
// any hex: [ swatch, name key, the engine's name ]. Word calls magenta "Pink".
const MENU_MARKS  = [ [ '#FFFF00', 'yellow', 'yellow'    ], [ '#00FF00', 'green', 'green'     ],
                      [ '#00FFFF', 'cyan',   'cyan'      ], [ '#FF00FF', 'pink',  'magenta'   ],
                      [ '#FF0000', 'red',    'red'       ], [ '#C0C0C0', 'gray',  'lightGray' ] ];

// Cell fills: the pale tones Word's shading palette starts with, [ swatch, name key ].
const MENU_FILLS  = [ [ '#D9D9D9', 'gray'   ], [ '#FFF2CC', 'yellow' ], [ '#E2EFD9', 'green'  ],
                      [ '#DEEAF6', 'blue'   ], [ '#FBE4D5', 'orange' ], [ '#F2DCDB', 'red'    ],
                      [ '#E5DFEC', 'purple' ] ];

// An entry is one of the engine's toolbar SLOTS - the very call the toolbar's
// button makes - or an engine command (`exec`), or a function of ours (`run`).
//   { slot:'text.bold' }                 a toggle: ticked while it is on
//   { slot:'font.size', value: 24 }      a value: ticked while it is the one
//   { exec:{ type:'insertRow', ... } }   greyed while the engine would refuse it
// iconOf clones the toolbar button's glyph, so a row and its button look alike.
function fontItems()
{
    return MENU_FONTS.map( function( f ) { return { text: f, slot: 'font.family', value: f }; } );
}

function sizeItems()
{
    return MENU_SIZES.map( function( s ) { return { text: s, slot: 'font.size', value: Number( s ) * 2 }; } );
}

function textColorItems()
{
    // Word's own first row of text colours, plus white (NayiveMenus.COLORS,
    // Calc's too). The engine takes the six hex digits without the '#'.
    return NayiveMenus.COLORS.map( function( c )
    {
        return { key: 'ui.color.' + c[1], swatch: c[0], slot: 'text.color', value: c[0].slice( 1 ) };
    } );
}

function highlightItems()
{
    return MENU_MARKS.map( function( c )
    {
        return { key: 'ui.color.' + c[1], swatch: c[0], slot: 'text.highlight', value: c[2] };
    } ).concat( [ { sep: true }, { key: 'write.noHighlight', slot: 'text.highlight', value: 'none' } ] );
}

function zoomItems()
{
    const out = MENU_ZOOMS.map( function( z )
    {
        return { text: z + ' %', run: function() { setZoom( z ); },
                 checked: function() { return zoomFixed() && Math.round( editor.getZoom() * 100 ) === z; } };
    } );

    out.push( { sep: true },
              { key: 'write.zoomFitWidth', run: function() { setZoom( 'fit' ); },
                checked: function() { return ! zoomFixed(); } } );

    return out;
}

function gridItems()
{
    return MENU_GRIDS.map( function( g )
    {
        return { text: g[0] + ' × ' + g[1],
                 run    : function() { runExec( tableCommand( g[0], g[1] ) ); },
                 enabled: function() { return canExec( tableCommand( g[0], g[1] ) ); } };
    } );
}

// Normal and Heading 1-3, found by their BUILT-IN NAME ("heading 1"), not by
// id: Word writes the id in the document's language ("Ttulo1" in a Spanish
// file). A file that lacks them gets Word's own definitions as it opens
// (withHeadings); should that fail, the missing ones are greyed here.
const STYLE_KEYS = [ [ 'Normal', 'write.sc.normal' ], [ 'Heading1', 'write.sc.heading1' ],
                     [ 'Heading2', 'write.sc.heading2' ], [ 'Heading3', 'write.sc.heading3' ] ];

function styleIdFor( want )
{
    const name = want === 'Normal' ? 'normal' : want.replace( /^Heading(\d)$/, 'heading $1' );
    let list = [];
    try { list = editor.getDocumentStyles().filter( function( s ) { return s.type === 'paragraph'; } ); }
    catch( _ ) { return null; }

    const hit = list.find( function( s ) { return s.styleId === want; } ) ||
                list.find( function( s ) { return String( s.name ).toLowerCase() === name; } );
    return hit ? hit.styleId : null;
}

function styleItems()
{
    return STYLE_KEYS.map( function( k )
    {
        const id = styleIdFor( k[0] );
        return { key: k[1], slot: 'styles.style', value: id || k[0], sc: k[1],
                 enabled: function() { return !! id && slotState( 'styles.style' ).enabled === true; } };
    } );
}

// The Ctrl+Alt+0..3 shortcuts: the same lookup.
function setStyle( want )
{
    const id = styleIdFor( want );
    if( ! id ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); return; }
    runSlot( 'styles.style', id );
}

const ALIGN_ITEMS =
[
    { key: 'write.sc.alignLeft',    slot: 'alignment.left',    sc: 'write.sc.alignLeft',    icon: matIcon( 'M120-120v-80h720v80H120Zm0-160v-80h480v80H120Zm0-160v-80h720v80H120Zm0-160v-80h480v80H120Zm0-160v-80h720v80H120Z' ) },
    { key: 'write.sc.alignCenter',  slot: 'alignment.center',  sc: 'write.sc.alignCenter',  icon: matIcon( 'M120-120v-80h720v80H120Zm160-160v-80h400v80H280ZM120-440v-80h720v80H120Zm160-160v-80h400v80H280ZM120-760v-80h720v80H120Z' ) },
    { key: 'write.sc.alignRight',   slot: 'alignment.right',   sc: 'write.sc.alignRight',   icon: matIcon( 'M120-760v-80h720v80H120Zm240 160v-80h480v80H360ZM120-440v-80h720v80H120Zm240 160v-80h480v80H360ZM120-120v-80h720v80H120Z' ) },
    { key: 'write.sc.alignJustify', slot: 'alignment.justify', sc: 'write.sc.alignJustify', icon: matIcon( 'M120-120v-80h720v80H120Zm0-160v-80h720v80H120Zm0-160v-80h720v80H120Zm0-160v-80h720v80H120Zm0-160v-80h720v80H120Z' ) }
];

// The line-spacing multiples: 1,15 in Spanish, 1.15 in English.
function lineItems()
{
    return MENU_LINES.map( function( n )
    {
        return { text: n.toLocaleString( NayiveUI.locale() ), slot: 'list.lineSpacing', value: n };
    } );
}

// Rows and columns act on the cell the caret is in; merging and splitting are
// greyed while the engine says it cannot yet (2.21.0: "not supported yet").
const TABLE_EDIT_ITEMS =
[
    { key: 'write.tb.addRowBefore',    exec: { type: 'insertRow', where: 'above' } },
    { key: 'write.tb.addRowAfter',     exec: { type: 'insertRow', where: 'below' } },
    { key: 'write.tb.deleteRow',       exec: { type: 'deleteRow' } },
    { sep: true },
    { key: 'write.tb.addColumnBefore', exec: { type: 'insertColumn', where: 'left'  } },
    { key: 'write.tb.addColumnAfter',  exec: { type: 'insertColumn', where: 'right' } },
    { key: 'write.tb.deleteColumn',    exec: { type: 'deleteColumn' } },
    { sep: true },
    { key: 'write.tb.mergeCells', exec: { type: 'mergeCells' } },
    { key: 'write.tb.splitCell',  exec: { type: 'splitCell', rows: 1, cols: 2 } },
    { sep: true },
    { key: 'write.tb.deleteTable', exec: { type: 'deleteTable' } }
];

// Tabla > Relleno de celda: the selected cells (the caret's alone when none are).
function fillItems()
{
    return MENU_FILLS.map( function( c )
    {
        return { key: 'ui.color.' + c[1], swatch: c[0],
                 exec: { type: 'setCellFill', color: { kind: 'hex', value: c[0].slice( 1 ) } } };
    } ).concat( [ { sep: true }, { key: 'write.noFill', exec: { type: 'setCellFill', color: null } } ] );
}

// The toolbar's table button: insert one, or change the one the caret is in.
function tableItems()
{
    return [ { key: 'write.cm.insertTable', sub: gridItems }, { sep: true } ].concat( TABLE_EDIT_ITEMS );
}

// A Material glyph for a menu row that has no toolbar button of its own.
function matIcon( d )
{
    return '<svg viewBox="0 -960 960 960" fill="currentColor"><path d="' + d + '"></path></svg>';
}

// "Recientes": the same ten paths the Open dialog lists (shared/office.js keeps
// them), so the menu never drifts from it. An empty list still shows one
// (greyed) row - a menu that silently has no submenu is worse than one that
// says why.
function recentItems()
{
    const list = session.recent();

    if( ! list.length ) return [ { key: 'ui.noRecent', enabled: function() { return false; } } ];

    return list.map( function( p )
    {
        return { text: baseName( p ), run: function() { openPickedFile( p ); } };
    } );
}

// Cortar / Copiar / Pegar / Pegar sin formato: the Edicion menu's and the
// right-click menu's (see EDICION > CORTAR / COPIAR / PEGAR).
const CLIP_ITEMS =
[
    { key: 'ui.cut',        exec: { type: 'cut' },  sc: 'ui.cut',  icon: 'cut'  },
    { key: 'ui.copy',       exec: { type: 'copy' }, sc: 'ui.copy', icon: 'copy' },
    { key: 'ui.paste',      run: function() { clipPaste( false ); }, sc: 'ui.paste', icon: 'paste',
      enabled: function() { return canExec( { type: 'paste', text: ' ' } ); } },
    { key: 'ui.pastePlain', run: function() { clipPaste( true ); }, sc: 'ui.pastePlain', icon: 'paste',
      enabled: function() { return canExec( { type: 'pasteWithoutFormatting', text: ' ' } ); } }
];

const MENUS = [
{
    key: 'ui.menu.file',
    items:
    [
        { key: 'write.newDoc',  el: 'newBtn'  },
        { key: 'ui.openDoc',    el: 'openBtn', sc: 'ui.openDoc' },
        { key: 'ui.recent',     sub: recentItems },
        { sep: true },
        { key: 'ui.save',       run: saveNow, sc: 'write.sc.save', icon: 'check' },
        { key: 'ui.saveAs',     el: 'saveAsBtn' },
        { key: 'ui.importDevice', el: 'importBtn' },
        { key: 'write.templates', el: 'tplBtn' },
        { key: 'write.restore', el: 'restoreBtn' },
        { sep: true },
        { key: 'write.pageSetup', el: 'pageSetupBtn' },
        { key: 'write.print',   el: 'printBtn', sc: 'write.print' },
        { key: 'write.savePdf', el: 'pdfBtn' }
    ]
},
{
    key: 'ui.menu.edit',
    items:
    [
        { key: 'ui.undo', slot: 'history.undo', iconOf: '#undoBtn' },
        { key: 'ui.redo', slot: 'history.redo', iconOf: '#redoBtn' },
        { sep: true }
    ].concat( CLIP_ITEMS, [
        { sep: true },
        { key: 'write.sc.find',    run: function() { openFind( false ); }, sc: 'write.sc.find',    iconOf: '#findBtn' },
        { key: 'write.sc.replace', run: function() { openFind( true );  }, sc: 'write.sc.replace', iconOf: '#findBtn' } ] )
},
{
    key: 'ui.menu.view',
    items:
    [
        { key: 'ui.chrome', sub:
            [ { key: 'ui.chromeToolbar', run: function() { CHROME.set( 'toolbar' ); }, iconOf: '#chromeToolbarBtn',
                checked: function() { return ! menusOn(); } },
              { key: 'ui.chromeMenus',   run: function() { CHROME.set( 'menus'   ); }, iconOf: '#chromeMenusBtn',
                checked: menusOn } ] },
        { sep: true },
        { key: 'write.formattingMarks', slot: 'review.paragraphMarks', iconOf: '#marksBtn' },
        { sep: true },
        { key: 'write.header', el: 'headerBtn', checked: function() { return hfEditing() === 'header'; } },
        { key: 'write.footer', el: 'footerBtn', checked: function() { return hfEditing() === 'footer'; } },
        { sep: true },
        { key: 'write.tb.zoom', sub: zoomItems, iconOf: '#zoomBtn' },
        { key: 'write.mode', sub:
            [ { key: 'write.modeEdit',    run: function() { setDocMode( 'editing' ); }, checked: function() { return docMode() === 'editing'; } },
              { key: 'write.modeRead',    run: function() { setDocMode( 'viewing' ); }, checked: function() { return docMode() === 'viewing'; } } ] }
    ]
},
{
    key: 'ui.menu.insert',
    items:
    [
        { key: 'write.pageBreak',  slot: 'insert.pageBreak', iconOf: '#pageBreakBtn' },
        { key: 'write.pageNumber', el:  'pageNumBtn' },
        { sep: true },
        { key: 'write.tb.image', el: 'imageBtn' },
        { key: 'write.tb.table', sub: gridItems, iconOf: '#tableBtn' },
        { key: 'write.sc.link',  el: 'linkBtn', sc: 'write.sc.link' },
        { sep: true },
        { key: 'write.footnote', slot: 'insert.footnote', iconOf: '#footnoteBtn' },
        { key: 'write.toc',      slot: 'insert.toc',      iconOf: '#tocBtn' },
        { key: 'write.symbols',  el: 'symbolsBtn' }
    ]
},
{
    key: 'ui.menu.format',
    items:
    [
        { key: 'write.tb.bold',          slot: 'text.bold',      iconOf: '#boldBtn' },
        { key: 'write.tb.italic',        slot: 'text.italic',    iconOf: '#italicBtn' },
        { key: 'write.tb.underline',     slot: 'text.underline', iconOf: '#underlineBtn' },
        { key: 'write.tb.strikethrough', slot: 'text.strike',    iconOf: '#strikeBtn' },
        { key: 'write.superscript',      slot: 'script.super',   iconOf: '#superBtn' },
        { key: 'write.subscript',        slot: 'script.sub',     iconOf: '#subBtn' },
        { sep: true },
        { key: 'write.tb.fontFamily', sub: fontItems },
        { key: 'write.tb.fontSize',   sub: sizeItems },
        { key: 'write.tb.color',      sub: textColorItems, iconOf: '#colorBtn' },
        { key: 'write.tb.highlight',  sub: highlightItems, iconOf: '#highlightBtn' },
        { sep: true },
        { key: 'write.tb.linkedStyles', sub: styleItems, iconOf: '#stylesBtn' },
        { key: 'write.tb.textAlign',    sub: ALIGN_ITEMS, iconOf: '#alignBtn' },
        { key: 'write.tb.lineHeight',   sub: lineItems,   iconOf: '#lineSpacingBtn' },
        { sep: true },
        { key: 'write.tb.bulletList',   slot: 'list.bullet',   iconOf: '#bulletBtn' },
        { key: 'write.tb.numberedList', slot: 'list.numbered', iconOf: '#numberedBtn' },
        { key: 'write.tb.indentRight',  slot: 'list.indent',   iconOf: '#indentBtn' },
        { key: 'write.tb.indentLeft',   slot: 'list.outdent',  iconOf: '#outdentBtn' },
        { sep: true },
        { key: 'write.paragraph',          el:   'paraBtn' },
        { key: 'write.tb.copyFormat',      slot: 'format.painter', run: togglePainter, iconOf: '#painterBtn' },
        { key: 'write.tb.clearFormatting', slot: 'format.clear',   iconOf: '#clearBtn' }
    ]
},
{
    key: 'ui.menu.table',
    items:
    [
        { key: 'write.cm.insertTable', sub: gridItems, iconOf: '#tableBtn' },
        { sep: true }
    ].concat( TABLE_EDIT_ITEMS.slice( 0, -1 ),
              [ { key: 'write.tableBorders', el: 'tableBordersBtn' },
                { key: 'write.cellFill', sub: fillItems } ],
              TABLE_EDIT_ITEMS.slice( -1 ) )
},
{
    key: 'ui.menu.tools',
    items:
    [
        { key: 'write.autocorrect', run: function() { setAutocorrect( ! autocorrectOn ); },
          checked: function() { return autocorrectOn; } },
        { sep: true },
        { key: 'ui.settings', el: 'settingsBtn', sc: 'ui.settings' }
    ]
},
{
    key: 'ui.menu.help',
    items: NayiveOffice.HELP_ITEMS   // the "?" shows the same three (shared/office.js)
} ];

// What the toolbar's drop-downs open (toolbar.js): the same tables.
const TOOLBAR_DROPDOWNS =
{
    stylesBtn     : styleItems,
    colorBtn      : textColorItems,
    highlightBtn  : highlightItems,
    tableBtn      : tableItems,
    alignBtn      : ALIGN_ITEMS,
    lineSpacingBtn: lineItems,
    zoomBtn       : zoomItems
};


//---- reading the engine's state ------------------------------------------//

function slotState( slot )
{
    try { return toolbarCommandState( editor, slot ) || {}; }
    catch( _ ) { return {}; }
}

function canExec( cmd )
{
    try { return !! editor && editor.can( cmd ).ok; }
    catch( _ ) { return false; }
}

// A slot is usable when the engine says so; an engine command when a dry run
// would apply.
function itemEnabled( it )
{
    if( it.slot  ) return slotState( it.slot ).enabled === true && ! slotBlocked( it.slot );
    if( it.exec  ) return canExec( it.exec );
    return undefined;                        // let shared/menubar.js decide
}

// A value entry is ticked when it is the selection's value; a toggle while it
// is on (bold, a list, the alignment it has).
function itemChecked( it )
{
    if( ! it.slot ) return undefined;

    const s = slotState( it.slot );
    if( it.value !== undefined ) return s.value !== undefined && s.value !== null && String( s.value ) === String( it.value );
    return !! s.active;
}

// The key combo shown on the right of an entry, taken from the SHORTCUTS table
// so the two can never disagree.
function hintFor( scKey )
{
    const s = SHORTCUTS.find( function( x ) { return x.key === scKey; } );
    return s ? s.label() : '';
}

//---- the bar and the switch, both from shared/menubar.js ------------------//

const MENUBAR = NayiveMenus.create(
{
    menus   : MENUS,
    ready   : function() { return ready; },   // nothing is live until the document is
    hint    : hintFor,
    enabled : itemEnabled,
    checked : itemChecked,
    exec    : function( it ) { if( it.slot ) runSlot( it.slot, it.value ); else if( it.exec ) runExec( it.exec ); }
} );

const CHROME = NayiveMenus.chrome(
{
    key   : 'nayive-write-chrome',
    menus : MENUBAR,
    load  : async function() { return ( await writeCfg.read() ).chrome; },
    save  : function( mode ) { return writeCfg.write( { chrome: mode } ); },

    // What CSS cannot do: an unfolded / folded state left over from the phone
    // must not decide anything once the strip is back, and the "?" has to go
    // where the visible chrome can show it.
    apply : function( on )
    {
        if( ! on ) setToolbarOpen( true );
        applyPhoneChrome();
    }
} );

function menusOn() { return CHROME.on(); }

// Where an anchored popup (#tbPopup, #symPopup) should hang from. In toolbar
// mode that is the toolbar button that opened it; in menu mode the button is
// collapsed to a zero-height sliver, so the menu row that ran the entry is the
// honest anchor.
function anchorRect( selector )
{
    return MENUBAR.anchorRect( selector, menusOn(), 'toolbar' );
}

// One anchored popup: shown just under its trigger (anchorRect), clamped to stay
// inside the viewport, and closed by a press anywhere outside it or a resize. A
// press on the trigger itself is let through, so the button's own command can
// toggle it shut. `onClose` runs on every close, after the popup is hidden.
function anchoredPopup( id, trigger, onClose )
{
    function outside( e )
    {
        if( document.getElementById( id ).contains( e.target ) ) return;
        if( e.target.closest && e.target.closest( trigger ) ) return;

        close();
    }

    function open()
    {
        const pop = document.getElementById( id );

        pop.classList.add( 'open' );   // lay it out before measuring

        const r  = anchorRect( trigger );
        const vw = document.documentElement.clientWidth;

        let left = Math.min( r.left, vw - pop.offsetWidth - 8 );
        if( left < 8 ) left = 8;

        pop.style.top  = ( r.bottom + 4 ) + 'px';
        pop.style.left = left + 'px';

        setTimeout( function()   // deferred, else the opening click closes it again
        {
            document.addEventListener( 'pointerdown', outside, true );
            window.addEventListener( 'resize', close );
        }, 0 );
    }

    function close()
    {
        document.getElementById( id ).classList.remove( 'open' );
        if( onClose ) onClose();
        document.removeEventListener( 'pointerdown', outside, true );
        window.removeEventListener( 'resize', close );
    }

    return { open: open, close: close };
}

//----------------------------------------------------------------------------//
// EDICION > CORTAR / COPIAR / PEGAR, and the right-click menu
//
// Ctrl+X / C / V are the engine's own. The menu entries run the same engine
// commands: cut and copy put the selection on the system clipboard (greyed at a
// bare caret: nothing to take); paste is a command that takes the clipboard's
// text and HTML, so they are read here, in the click (Chrome asks once); paste
// without formatting hands over the text alone, which takes the look of wherever
// the caret is.


// (CLIP_ITEMS, the four entries, sits with the menu table: MENUS uses it.)

async function clipPaste( plain )
{
    if( ! ready || ! editor ) return;

    const dt = await NayiveOffice.clip.read();
    if( ! dt ) { NayiveUI.toast( NayiveUI.t( 'ui.clipboardBlocked' ) ); return; }

    const text = dt.getData( 'text/plain' ) || '';
    const html = plain ? '' : dt.getData( 'text/html' ) || '';
    if( ! text && ! html ) return;

    if( html ) caretAfterPaste( text );
    runExec( plain ? { type: 'pasteWithoutFormatting', text: text }
                   : html ? { type: 'paste', text: text, html: html } : { type: 'paste', text: text } );
}

// A paste that carries HTML - the engine's own copy, a web page - leaves the
// caret BEFORE what it put in, from the keyboard and the menu alike (quirks.js,
// pasteCaretBefore); Word leaves it after, and the next word typed would land in
// front of the paste. Called just before a paste: once the engine has put the
// text in, and only if the caret is still at the paste's start and the text
// really sits there on the page, the caret goes to its end. A paste over
// several paragraphs is left as the engine leaves it.
function caretAfterPaste( text )
{
    if( ! Q.pasteCaretBefore || ! editor || ! text || /[\r\n]/.test( text ) ) return;

    const before = caretNow();
    if( ! before || before.anchor.paragraphId !== before.head.paragraphId ) return;

    const pid   = before.anchor.paragraphId;
    const start = Math.min( before.anchor.offset, before.head.offset );
    const rev   = revisionNow();
    const t0    = Date.now();

    ( function wait()
    {
        if( revisionNow() === rev ) { if( Date.now() - t0 < 1000 ) setTimeout( wait, 20 ); return; }

        requestAnimationFrame( function() { requestAnimationFrame( function()     // painted
        {
            const now = caretNow();
            if( ! now || now.anchor.paragraphId !== pid || now.anchor.offset !== start || now.head.offset !== start ) return;
            if( paintedText( pid ).slice( start, start + text.length ).join( '' ) !== text ) return;

            const at = { paragraphId: pid, offset: start + text.length };
            try { editor.exec( { type: 'setSelection', range: { anchor: at, head: at } } ); } catch( _ ) {}
        } ); } );
    } )();
}

// The caret with offsets. The command contract's selection names paragraphs
// only; the surface's has the offsets (the same seam the links use).
function caretNow()    { try { return editor.surface.state().selection; } catch( _ ) { return null; } }
function revisionNow() { try { return editor.getDocumentHandle().revision; } catch( _ ) { return -1; } }

// One paragraph's text as painted, character by character (a gap stays empty).
// Only that paragraph's spans are read - this runs on every space typed.
function paintedText( pid )
{
    const out = [];
    for( const span of document.querySelectorAll( '#editor .layout-run-text[data-paragraph-id="' + CSS.escape( String( pid ) ) + '"][data-start]' ) )
    {
        const at = Number( span.getAttribute( 'data-start' ) ), t = span.textContent;
        for( let i = 0; i < t.length; i++ ) out[ at + i ] = t[ i ];
    }
    return out;
}

// The core has no menu of its own. On a page, ours: the spelling rows first when
// the word under the pointer is flagged (proofing-overlay.js), then the
// clipboard. Off the pages, the browser's.
async function onContextMenu( e )
{
    if( ! ready || ! editor || ! e.target.closest || ! e.target.closest( '.docx-page' ) ) return;

    e.preventDefault();
    e.stopPropagation();

    const at    = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 };
    const words = spell ? await spell.itemsAt( e.clientX, e.clientY ) : null;

    MENUBAR.openItems( ( words ? words.concat( [ { sep: true } ] ) : [] ).concat( CLIP_ITEMS ), at );
}

//----------------------------------------------------------------------------//
// BUSCAR / REEMPLAZAR  (find.js draws the bar; Ctrl+F, Ctrl+H, Edicion)

let find = null;     // made in wireStaticUI

function openFind( replace )
{
    if( ! ready || ! editor ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }
    if( find ) find.open( replace );
}

//----------------------------------------------------------------------------//
// HIPERVINCULO  (Ctrl+K, the toolbar, Insertar; a click on a link)
//
// The engine draws links and says when one is clicked or asked for
// (setHyperlinkChrome) but has no command that makes one: the text.link slot is
// not wired and insertHyperlink refuses a target (2.21.0). What works is the
// link API on editor.surface - typed and exported, though the engine calls
// `surface` its seam for hosts that need more than the command contract
// (quirks.js, hyperlinkOnSurface).
//
// The sheet makes a link of the selected text, or changes the one the caret is
// in; an empty address takes the link off. A click on a link opens a small menu
// under it: where it goes, open it, edit it, remove it.

function links() { return editor && editor.surface && editor.surface.hyperlinks; }

let linkEditing = null;     // the link the sheet was opened on, or null for a new one

function openLinkDialog()
{
    if( ! ready || ! editor ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }
    if( document.getElementById( 'linkBackdrop' ).classList.contains( 'open' ) ) return;   // Ctrl+K: engine and table both ask

    const L = links();
    let at = null;
    try { at = L && L.linkAtCaret(); } catch( _ ) {}

    let collapsed = true;
    try { collapsed = editor.snapshot().selectionCollapsed; } catch( _ ) {}

    if( ! at && collapsed ) { NayiveUI.toast( NayiveUI.t( 'write.selectTextFirst' ) ); return; }

    linkEditing = at;
    document.getElementById( 'linkHref' ).value = at ? at.authored || at.href || '' : '';
    setBackdrop( 'linkBackdrop', true );
    setTimeout( function() { const f = document.getElementById( 'linkHref' ); f.focus(); f.select(); }, 50 );
}

function confirmLink()
{
    const raw = document.getElementById( 'linkHref' ).value.trim();
    setBackdrop( 'linkBackdrop', false );

    const L = links();
    if( ! L || ! ready ) return;

    let ok;
    try
    {
        if( ! raw ) ok = linkEditing ? L.removeHyperlink( linkEditing.id ) : true;
        else        ok = L.applyHyperlink( { url: withScheme( raw ) } );
    }
    catch( e ) { console.error( 'Write: link -', e ); ok = false; }

    if( ! ok ) NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) );
    focusEditor();
}

// "nayive.org" is a web address, not a file beside the document.
function withScheme( url )
{
    return /^[a-z][a-z0-9+.-]*:/i.test( url ) || url.charAt( 0 ) === '#' ? url
         : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test( url ) ? 'mailto:' + url
         : 'https://' + url;
}

// A click on a link (the engine refused to navigate and tells us where it was).
function showLinkMenu( act )
{
    const link = act && act.link;
    if( ! link ) return;

    const items = [ { text: link.href || link.authored || '', enabled: function() { return false; } }, { sep: true } ];

    if( link.href && link.kind === 'external' )
        items.push( { key: 'write.linkOpen', run: function() { window.open( link.href, '_blank', 'noopener' ); } } );

    items.push( { key: 'write.linkEdit',   run: openLinkDialog },
                { key: 'write.linkRemove', run: function()
                  {
                      const L = links();
                      let ok = false;
                      try { ok = !! L && L.removeHyperlink( link.id ); } catch( _ ) {}
                      if( ! ok ) NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) );
                      focusEditor();
                  } } );

    const r = act.rect;
    MENUBAR.openItems( items, { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                                width: r.right - r.left, height: r.bottom - r.top } );
}

//----------------------------------------------------------------------------//
// IMAGEN  (Insertar > Imagen, the toolbar)
//
// Put in at the caret, as it would come out of Word: inline, at its own size
// but never wider than the text. Shrunk first to 1600 px on the long side (the
// shared NayivePhoto step Photos and Drive use), because it travels inside the
// .docx for good. The engine's insert is asynchronous (it decodes the picture),
// so it goes through executeImageCommand, not exec.

// What the engine puts into the .docx as it is. Anything else the browser can
// draw (AVIF, TIFF, HEIC on an iPhone ...) is re-encoded to JPEG first.
const IMAGE_MIMES = [ 'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp' ];

function pickImage()
{
    if( ! ready || ! editor ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }
    document.getElementById( 'imgInput' ).click();
}

async function insertPickedImage( file )
{
    if( ! file || ! ready || ! editor ) return;

    try
    {
        let   blob = await shrinkImage( file );
        let   mime = blob.type === 'image/jpg' ? 'image/jpeg' : blob.type;
        if( IMAGE_MIMES.indexOf( mime ) < 0 )
        {
            try { blob = await NayivePhoto.shrinkToJpeg( blob, { maxW: IMAGE_MAX_EDGE, maxH: IMAGE_MAX_EDGE } ); mime = 'image/jpeg'; }
            catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.formatUnsupported' ) ); return; }
        }

        const size = await imagePoints( blob );
        const r = await executeImageCommand( editor, { type: 'insertImage', data: new Uint8Array( await blob.arrayBuffer() ),
                                                       mime: mime, widthPoints: size.w, heightPoints: size.h } );
        if( r && r.ok === false ) throw new Error( r.reason );
        focusEditor();
    }
    catch( e )
    {
        console.error( 'Write: image -', e );
        NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) );
    }
}

// The picture's size in points (96 px to the inch, 72 points), scaled down to
// the width between the margins when it is wider.
async function imagePoints( blob )
{
    const bmp = await createImageBitmap( blob );
    let w = bmp.width * 0.75, h = bmp.height * 0.75;
    if( bmp.close ) bmp.close();

    let max = 450;                                                // points: a Letter page's text width, as a fallback
    try
    {
        const ps = editor.getPageSetup(), m = ps.marginsTwips || {};
        max = ( ps.pageWidthTwips - ( m.left || 0 ) - ( m.right || 0 ) ) / 20;
    }
    catch( _ ) {}

    if( w > max ) { h = h * max / w; w = max; }
    return { w: Math.round( w * 100 ) / 100, h: Math.round( h * 100 ) / 100 };
}

//----------------------------------------------------------------------------//
// TABLE BORDERS
//
// A toolbar button opens a Word-style border picker anchored under it
// (#tbPopup): pick a preset plus weight / line style / colour, then click the ✓
// (the shared round accent button) — nothing touches the table until then.
// While the popup is open the pending selection lives in `tbDraft`; the ✓
// copies it into the sticky `tbState` and issues the borders. The picked
// weight / style / colour are sticky (remembered after a successful apply).
//
// A preset acts on the SELECTED CELLS, like Word - the caret's cell alone when
// nothing is selected (the engine's setTableBorders; it cannot select a whole
// table for you, quirks.js selectTableRegionUnsupported). "Inside" needs
// several cells. The engine has one inside target, so the separate inside-
// horizontal / inside-vertical presets are gone.

const TB_STYLE_KEY = 'nayive-write-tbstyle';

// The sticky line weight / style / colour set in the popup. `color` is stored
// without the leading '#' (setBorders() wants it that way).
const tbState = { lineStyle: 'single', lineWeightPt: 1, color: '000000' };

// The pending selection while the popup is open: a working copy of tbState plus
// the chosen preset (null = none picked yet). Seeded from tbState on open,
// committed to it by the ✓ button.
const tbDraft = { preset: null, lineStyle: 'single', lineWeightPt: 1, color: '000000' };

// The sticky line style / weight / colour, as setBorders() wants them.
function tbSpec()
{
    return {
        lineStyle    : tbState.lineStyle    || 'single',
        lineWeightPt : tbState.lineWeightPt || 1,
        color        : ( tbState.color || '000000' ).replace( /^#/, '' )
    };
}

async function openTableBorders()
{
    if( ! ready ) return;

    if( document.getElementById( 'tbPopup' ).classList.contains( 'open' ) ) { tbPopup.close(); return; }

    openTbPopup();
}

// Popup preset -> the engine's border target.
const TB_TARGETS = { all: 'all', box: 'outside', inside: 'inside', top: 'top', bottom: 'bottom', left: 'left', right: 'right' };

function applyTableBorderPreset( which )
{
    if( ! ready || ! editor ) return;

    let snap = null;
    try { snap = editor.snapshot(); } catch( _ ) {}
    if( ! snap || ! snap.table ) { NayiveUI.toast( NayiveUI.t( 'write.cursorInTable' ) ); return; }

    const one = ! snap.selection || snap.selection.from.paraId === snap.selection.to.paraId;
    if( which === 'inside' && one ) { NayiveUI.toast( NayiveUI.t( 'write.selectCells' ) ); return; }

    const b   = tbSpec();
    const cmd = which === 'none'
        ? { type: 'setTableBorders', scope: 'none', target: 'all' }
        : { type: 'setTableBorders', scope: TB_TARGETS[ which ],
            spec: { style: b.lineStyle, size: Math.round( b.lineWeightPt * 8 ), color: { kind: 'hex', value: b.color.toUpperCase() } } };

    if( ! cmd.scope ) return;

    runExec( cmd );
    persistTbState();
}

function persistTbState()
{
    try { localStorage.setItem( TB_STYLE_KEY, JSON.stringify( tbSpec() ) ); } catch( _ ) {}
}

function restoreTbStyle()
{
    try
    {
        const s = JSON.parse( localStorage.getItem( TB_STYLE_KEY ) || 'null' );
        if( s )
        {
            if( s.lineStyle    ) tbState.lineStyle    = s.lineStyle;
            if( s.lineWeightPt ) tbState.lineWeightPt = parseFloat( s.lineWeightPt );
            if( s.color        ) tbState.color        = String( s.color ).replace( /^#/, '' );
        }
    }
    catch( _ ) {}

    tbDraft.lineStyle    = tbState.lineStyle;
    tbDraft.lineWeightPt = tbState.lineWeightPt;
    tbDraft.color        = tbState.color;
    syncTbUI();
}

// Reflect tbDraft in the popup: the pressed preset / weight / style buttons and
// the colour swatch.
function syncTbUI()
{
    const pop = document.getElementById( 'tbPopup' );

    pop.querySelectorAll( '[data-tb]' ).forEach( function( b )
    {
        b.setAttribute( 'aria-pressed', String( b.getAttribute( 'data-tb' ) === tbDraft.preset ) );
    } );
    pop.querySelectorAll( '[data-tbw]' ).forEach( function( b )
    {
        b.setAttribute( 'aria-pressed', String( parseFloat( b.getAttribute( 'data-tbw' ) ) === tbDraft.lineWeightPt ) );
    } );
    pop.querySelectorAll( '[data-tbs]' ).forEach( function( b )
    {
        b.setAttribute( 'aria-pressed', String( b.getAttribute( 'data-tbs' ) === tbDraft.lineStyle ) );
    } );

    document.getElementById( 'tbColorSwatch' ).style.background = '#' + tbDraft.color;
    document.getElementById( 'tbColorInput'  ).value           = '#' + tbDraft.color;
}

// Wire the popup's preset / weight / style / colour controls. Every control only
// stages its pick into tbDraft; the ✓ button is what commits and draws the borders.
function wireTableBorders()
{
    const pop = document.getElementById( 'tbPopup' );

    pop.querySelectorAll( '[data-tb]' ).forEach( function( b )
    {
        b.addEventListener( 'click', function()
        {
            tbDraft.preset = ( tbDraft.preset === b.getAttribute( 'data-tb' ) ) ? null : b.getAttribute( 'data-tb' );
            syncTbUI();
        } );
    } );

    pop.querySelectorAll( '[data-tbw]' ).forEach( function( b )
    {
        b.addEventListener( 'click', function()
        {
            tbDraft.lineWeightPt = parseFloat( b.getAttribute( 'data-tbw' ) );
            syncTbUI();
        } );
    } );

    pop.querySelectorAll( '[data-tbs]' ).forEach( function( b )
    {
        b.addEventListener( 'click', function()
        {
            tbDraft.lineStyle = b.getAttribute( 'data-tbs' );
            syncTbUI();
        } );
    } );

    const swatch = document.getElementById( 'tbColorSwatch' );
    const input  = document.getElementById( 'tbColorInput' );

    swatch.addEventListener( 'click', function()
    {
        if( input.showPicker ) input.showPicker(); else input.click();
    } );
    const onColor = function()
    {
        tbDraft.color = input.value.replace( /^#/, '' );
        syncTbUI();
    };
    input.addEventListener( 'input',  onColor );   // live while dragging (Chrome/FF)
    input.addEventListener( 'change', onColor );   // on close (Safari)

    document.getElementById( 'tbApplyBtn' ).addEventListener( 'click', function()
    {
        const which = tbDraft.preset;
        if( ! which ) { NayiveUI.toast( NayiveUI.t( 'write.pickBorder' ) ); return; }

        tbState.lineStyle    = tbDraft.lineStyle;
        tbState.lineWeightPt = tbDraft.lineWeightPt;
        tbState.color        = tbDraft.color;

        applyTableBorderPreset( which );   // persists tbState on success
        tbPopup.close();
    } );
}

// The popup hangs under the toolbar's "Bordes de tabla" button (anchoredPopup).
// Closing it drops the preset picked in it.
const tbPopup = anchoredPopup( 'tbPopup', '#tableBordersBtn', function() { tbDraft.preset = null; } );

function openTbPopup()
{
    // Fresh draft each time: last-used weight / style / colour, no preset yet.
    tbDraft.preset       = null;
    tbDraft.lineStyle    = tbState.lineStyle;
    tbDraft.lineWeightPt = tbState.lineWeightPt;
    tbDraft.color        = tbState.color;
    syncTbUI();

    tbPopup.open();
}

//----------------------------------------------------------------------------//
// PAGE SETUP  (size / orientation / margins)
//
// Read from the DOCUMENT (getPageSetup, twips) and written back with the
// setPageSetup command, on the section the caret is in. Columns and line
// numbers are gone with the old engine (his call, 2026-09-18) until an engine
// release draws them.

const CM_PER_IN = 2.54;
const TWIPS_PER_IN = 1440;

// parseNum held between 0 and `max`. `max` defaults to 10 cm, which is right
// for a MARGIN. A custom page size has to pass its own ceiling, or a 15 x 20 cm
// page comes out 10 x 10.
function parseCm( raw, max )
{
    const n = parseNum( raw );
    return n === null ? null : Math.min( Math.max( n, 0 ), max === undefined ? 10 : max );
}

function twipsToCm( t ) { return ( t || 0 ) / TWIPS_PER_IN * CM_PER_IN; }
function cmToTw( cm )   { return Math.round( ( cm || 0 ) / CM_PER_IN * TWIPS_PER_IN ); }
function inToTw( i )    { return Math.round( ( i || 0 ) * TWIPS_PER_IN ); }

function openPageSetup()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    // Fill from the DOCUMENT, not from Nayive's defaults. If the read fails,
    // fall back to the defaults rather than showing nothing.
    let cur = null;
    try { cur = readPageSetup(); } catch( _ ) {}

    const v = cur || pageSetup;

    document.getElementById( 'psSize'   ).value = PAGE_SIZES[ v.size ] ? v.size : 'custom';
    document.getElementById( 'psOrient' ).value = v.orientation;
    document.getElementById( 'psTop'    ).value = fmtNum( v.top );
    document.getElementById( 'psBottom' ).value = fmtNum( v.bottom );
    document.getElementById( 'psLeft'   ).value = fmtNum( v.left );
    document.getElementById( 'psRight'  ).value = fmtNum( v.right );
    document.getElementById( 'psWidth'  ).value = fmtNum( ( v.width  || 0 ) * CM_PER_IN );
    document.getElementById( 'psHeight' ).value = fmtNum( ( v.height || 0 ) * CM_PER_IN );

    syncPageSizeRows();
    setBackdrop( 'pageSetupBackdrop', true );
}

// The two custom width/height fields only make sense for "custom".
function syncPageSizeRows()
{
    document.getElementById( 'psCustomRow' ).hidden =
        document.getElementById( 'psSize' ).value !== 'custom';
}

// The open document's page setup, in the dialog's units: centimetres for the
// margins, inches for the sheet (PAGE_SIZES).
function readPageSetup()
{
    const ps = editor.getPageSetup();
    if( ! ps ) return null;

    const land = ps.orientation === 'landscape';
    const m    = ps.marginsTwips || {};

    // width/height are as laid out, so undo the rotation before naming the size.
    const w = ( land ? ps.pageHeightTwips : ps.pageWidthTwips  ) / TWIPS_PER_IN;
    const h = ( land ? ps.pageWidthTwips  : ps.pageHeightTwips ) / TWIPS_PER_IN;

    return {
        size        : sizeNameFor( w, h ),
        orientation : land ? 'landscape' : 'portrait',
        width       : w,
        height      : h,
        top         : twipsToCm( m.top ),
        bottom      : twipsToCm( m.bottom ),
        left        : twipsToCm( m.left ),
        right       : twipsToCm( m.right )
    };
}

// The setPageSetup command for a page setup in the dialog's units. `scope`
// 'section' is Word's "Apply to: this section".
function pageSetupCommand( setup, scope )
{
    const size = setup.size === 'custom' ? { w: setup.width, h: setup.height } : PAGE_SIZES[ setup.size ];
    const land = setup.orientation === 'landscape';

    return {
        type        : 'setPageSetup',
        pageWidth   : inToTw( land ? size.h : size.w ),
        pageHeight  : inToTw( land ? size.w : size.h ),
        orientation : land ? 'landscape' : 'portrait',
        marginTop   : cmToTw( setup.top ),
        marginBottom: cmToTw( setup.bottom ),
        marginLeft  : cmToTw( setup.left ),
        marginRight : cmToTw( setup.right ),
        scope       : scope || 'section'
    };
}

function confirmPageSetup()
{
    const chosen = document.getElementById( 'psSize' ).value;

    const next = {
        size        : PAGE_SIZES[ chosen ] ? chosen : 'custom',
        orientation : document.getElementById( 'psOrient' ).value === 'landscape' ? 'landscape' : 'portrait',
        // A page, not a margin: 200 cm is a generous ceiling, 1 cm a sane floor.
        width       : Math.max( parseCm( document.getElementById( 'psWidth'  ).value, 200 ) ?? 21,   1 ) / CM_PER_IN,
        height      : Math.max( parseCm( document.getElementById( 'psHeight' ).value, 200 ) ?? 29.7, 1 ) / CM_PER_IN,
        top         : parseCm( document.getElementById( 'psTop'    ).value ) ?? pageSetup.top,
        bottom      : parseCm( document.getElementById( 'psBottom' ).value ) ?? pageSetup.bottom,
        left        : parseCm( document.getElementById( 'psLeft'   ).value ) ?? pageSetup.left,
        right       : parseCm( document.getElementById( 'psRight'  ).value ) ?? pageSetup.right
    };

    setBackdrop( 'pageSetupBackdrop', false );

    const r = editor.exec( pageSetupCommand( next ) );
    if( r && r.ok === false )
    {
        console.error( 'Write: page setup -', r.reason );
        NayiveUI.toast( NayiveUI.t( 'write.pageSetupFailed' ) );
        return;
    }
    focusEditor();          // the change event marks it dirty
}

//----------------------------------------------------------------------------//
// SAVE

// A .docx is a zip, so it starts "PK". Anything else - an empty buffer, above
// all - is never handed to the saver: it would empty the file. The throw makes
// the save fail out loud ("could not be saved"), and the next edit tries again.
async function exportBytes()
{
    const bytes = new Uint8Array( await editor.save() );
    if( bytes.length < 4 || bytes[ 0 ] !== 0x50 || bytes[ 1 ] !== 0x4B ) throw new Error( 'Write: the engine gave no .docx to save (' + bytes.length + ' bytes)' );
    return bytes;
}

// Ctrl-S / the menu: save now. An untitled or someone else's document goes to
// "Guardar como" (shared/office.js).
function saveNow() { session.saveNow(); }

//----------------------------------------------------------------------------//
// OPEN  (the dialog itself is the shared one: shared/office.js, openBrowser -
// recent documents over a folder browser. Write only says which files it lists
// and what to do with the one picked.)

// Extensions the Open dialog shows: Write opens .docx alone.
const OPEN_EXTS = [ 'docx' ];

function isOpenable( path ) { return OPEN_EXTS.indexOf( NayiveOffice.extOf( path ) ) !== -1; }

// Open a file the user picked. The Open dialog lists only .docx, but
// "Recientes" hands over any path the session ever opened (a ?file= from
// Drive included), so anything else is still turned away here.
async function openPickedFile( path )
{
    if( isOpenable( path ) ) { await session.open( path ); return; }

    NayiveUI.toast( NayiveUI.t( 'write.formatUnsupported' ) );
}

//----------------------------------------------------------------------------//
// THE DOCUMENT IN THE ENGINE  (what the session in shared/office.js needs from Write)

// A .docx body on screen: opened, imported, the device draft or the .bak copy.
// Throws when the engine refuses it - the session says "could not be opened".
async function loadBody( body )
{
    await loadIntoEditor( await toBytes( body ) );
}

// A blank document with Nayive's page setup (A4, the margins above). Made once
// per visit: Word's blank template, the page setup written into it, saved, and
// those bytes are what every New loads. Loading them - rather than applying the
// page setup to a fresh blank - is what keeps Ctrl+Z on a new document from
// taking the page back to Letter.
let blankBytes = null;

async function loadBlank()
{
    if( ! blankBytes )
    {
        if( ready && lastGood ) lastGood = new Uint8Array( await editor.save() );   // the edits on screen (loadIntoEditor)
        ready = false;
        editor.load( 'blank' );

        const r = editor.exec( pageSetupCommand( pageSetup, 'document' ) );
        if( r && r.ok === false ) console.error( 'Write: default page setup -', r.reason );

        blankBytes = new Uint8Array( await editor.save() );
    }

    await loadIntoEditor( blankBytes );
}

async function toBytes( body )
{
    if( body instanceof Uint8Array ) return body;
    if( body instanceof ArrayBuffer ) return new Uint8Array( body );
    if( body && typeof body.arrayBuffer === 'function' ) return new Uint8Array( await body.arrayBuffer() );
    return new Uint8Array( body );
}

//----------------------------------------------------------------------------//
// HELPERS

// Straight through to shared/office.js — this was an identical copy. A function
// declaration on purpose: it is hoisted, and code above uses it.
function baseName( path ) { return NayiveOffice.baseName( path ); }

// Write's file-name rule, for "Guardar como" and a rename: always .docx.
function docxName( name ) { return /\.docx$/i.test( name ) ? name : name + '.docx'; }

async function fetchBytes( path )
{
    return toBytes( await GumApi.readFileBytes( path ) );
}

// An image is stored inside the .docx, so whatever comes out of here is carried
// in the document for good. A phone photo is 3-6 MB and turns a two-page letter
// into a file nobody can e-mail, so it goes through the same shrink Photos and
// Drive use (shared/photo.js) first.
const IMAGE_MAX_EDGE = 1600;   // px on the long side - plenty at 100 % on paper

async function shrinkImage( file )
{
    try
    {
        if( window.NayivePhoto )
        {
            const prepared = await NayivePhoto.prepare( file, IMAGE_MAX_EDGE );
            if( prepared && prepared.blob ) return prepared.blob;
        }
    }
    catch( _ ) {}   // undecodable (HEIC on some Androids): use it as it came
    return file;
}
