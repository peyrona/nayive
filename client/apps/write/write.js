/*
 * write.js - Personal single-user word processor, on SuperDoc 2.
 *
 * .docx is the native format. A document lives wherever the user put it in
 * Drive - "Guardar como" asks for the folder on the first save - and a copy of
 * the previous version is kept in a .bak/ beside it. Loaded as a module by
 * index.html AFTER shared/gum-api.js, shared/ui.js and shared/office.js
 * (classic scripts) have set window.GumApi / NayiveUI / NayiveOffice, and
 * AFTER the inline script in <head> pinned __SUPERDOC_V2_BROWSER_WORKER_URL__.
 *
 * The SuperDoc bundle under lib/superdoc/ is vendored and pinned; see
 * lib/superdoc/BUILD.md. SuperDoc's DOCX engine is proprietary (self-host only,
 * no redistribution) — that trade was accepted for this private tool.
 */
import { SuperDoc, BlankDOCX } from './lib/superdoc/superdoc.min.js';
import { makeSpellProvider, PROOF_LANGS, setPersonalWords, isPersonalWord, fillSuggestions } from './proofing.js';

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

// SuperDoc's sections API takes inches. Page sizes here are portrait, inches.
const PAGE_SIZES = {
    A4     : { w:  8.2677, h: 11.6929 },
    Letter : { w:  8.5,    h: 11      },
    Legal  : { w:  8.5,    h: 14      },
    A3     : { w: 11.6929, h: 16.5354 },
    A5     : { w:  5.8268, h:  8.2677 },
    B5     : { w:  6.9291, h:  9.8425 }
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

let sd            = null;    // the SuperDoc instance
let bootSource    = null;    // the File boot() builds SuperDoc on (see loadBody)

// Phone (see TWO LAYOUT MODES in shared/app.css): the A4 page is 794px wide at
// 100 %, twice a phone screen, so the zoom is set to make it fit the editor box
// (~45 % on a 390px screen), and set again when the phone is turned. SuperDoc
// has a "fit-width" zoom mode of its own, but in this build it measures the
// container instead of the page and lands on 100 % - so the fit is computed
// here. `offsetWidth` is the page's unscaled width (the zoom is a transform on
// its parent), which keeps the maths stable across repeated calls. The fit is
// only redone when the editor's WIDTH changes (turning the phone) - the on-screen
// keyboard fires resize too, and must not undo a zoom the user picked from the
// toolbar's zoom menu. PC / tablet keep the usual 100 %.
const PHONE = window.matchMedia( '(max-width: 640px)' );

let phoneZoomOn = false;   // true while the phone fit is what set the zoom
let phoneFitW   = 0;       // editor width the last fit was computed for

// Two ways to fit a page on a 390px screen:
//   'page' — the whole sheet, margins included: ~46 %, and the text is tiny.
//   'text' — only the text column, so the words are as big as the screen allows
//            and the margins fall off the sides. Better for reading, which is
//            what a phone is mostly used for here.
// The suite pins `user-scalable=no` in all four apps' viewport meta, so pinch is
// not an option; this is the readable alternative that does not break that.
const PHONE_FIT_KEY = 'nayive-write-phonefit';

let phoneFit = readPhoneFit();

function readPhoneFit()
{
    try { return localStorage.getItem( PHONE_FIT_KEY ) === 'page' ? 'page' : 'text'; }
    catch( _ ) { return 'text'; }
}

function setPhoneFit( mode )
{
    phoneFit = mode === 'page' ? 'page' : 'text';
    try { localStorage.setItem( PHONE_FIT_KEY, phoneFit ); } catch( _ ) {}

    phoneFitW = 0;            // force a recompute
    fitPhoneZoom();
    syncPhoneFitBtn();
}

function togglePhoneFit() { setPhoneFit( phoneFit === 'text' ? 'page' : 'text' ); }

function syncPhoneFitBtn()
{
    const b = document.getElementById( 'fitBtn' );
    if( ! b ) return;

    b.classList.toggle( 'is-active', phoneFit === 'text' );
    b.setAttribute( 'aria-pressed', String( phoneFit === 'text' ) );
}

function fitPhoneZoom( tries )
{
    if( ! sd || typeof sd.setZoom !== 'function' ) return;

    if( ! PHONE.matches )                       // wide again (phone turned sideways, or a PC)
    {
        if( phoneZoomOn ) { phoneZoomOn = false; phoneFitW = 0; sd.setZoom( 100 ); }
        return;
    }

    const box  = document.getElementById( 'editor' );
    const page = box && box.querySelector( '.superdoc-page' );

    if( ! page || ! page.offsetWidth )          // the page mounts a moment after onReady
    {
        if( ( tries || 0 ) < 20 ) setTimeout( function() { fitPhoneZoom( ( tries || 0 ) + 1 ); }, 250 );
        return;
    }

    if( box.clientWidth === phoneFitW ) return;   // same width as last time (keyboard, not rotation)
    phoneFitW = box.clientWidth;

    // 'text' fits the text column instead of the whole sheet: take the page's
    // own margins off first. They come from the section, so any page setup works.
    let fitTo = page.offsetWidth;

    if( phoneFit === 'text' )
    {
        const m = phoneTextWidthPx( page );
        if( m > 0 ) fitTo = m;
    }

    const zoom = Math.floor( ( box.clientWidth - 12 ) / fitTo * 100 );
    if( zoom <= 0 || zoom >= 300 ) return;

    phoneZoomOn = true;
    if( zoom !== sd.getZoom() ) sd.setZoom( zoom );
}

// The width of the text column in unscaled page pixels: the sheet minus its left
// and right margins, read from the section (cached, so no await in the fit path).
let phoneMarginsIn = null;

function phoneTextWidthPx( page )
{
    if( ! phoneMarginsIn ) { readPhoneMargins(); return 0; }

    const secW = phoneMarginsIn.width;
    if( ! secW ) return 0;

    const pxPerIn = page.offsetWidth / secW;
    const text    = secW - phoneMarginsIn.left - phoneMarginsIn.right;

    return text > 0 ? text * pxPerIn : 0;
}

async function readPhoneMargins()
{
    try
    {
        const sec = ( await sd.activeEditor.doc.sections.list() ).items[ 0 ];
        const ps  = sec.pageSetup || {};
        const mg  = sec.margins   || {};

        phoneMarginsIn = { width: ps.width || 0, left: mg.left || 0, right: mg.right || 0 };

        phoneFitW = 0;
        fitPhoneZoom();
    }
    catch( _ ) {}
}

( function()
{
    let t = null;
    window.addEventListener( 'resize', function() { clearTimeout( t ); t = setTimeout( fitPhoneZoom, 150 ); } );
} )();


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
// Folding sets height:0, never display:none: SuperDoc watches #toolbar's width
// and re-lays its items out on every change, so the width must stay steady.

const MENU_BTNS = [ 'newBtn', 'openBtn', 'importBtn', 'saveAsBtn', 'printBtn', 'pdfBtn', 'tplBtn', 'restoreBtn', 'commentsBtn', 'pageSetupBtn', 'headerBtn', 'footerBtn', 'pageNumBtn', 'paraBtn', 'statsBtn', 'settingsBtn' ];

// `fold.isOpen()` is the truth now; this stays only for readability at call sites.
function toolbarOpen() { return fold ? fold.isOpen() : true; }

// Show / hide the formatting row and keep the "Aa" button in step with it.
// Folding also closes the "⋮" expansion — coming back to a four-row toolbar
// would undo the whole point of folding it away.
// shared/office.js's foldingToolbar does all of this: the "is-folded" height-0
// fold (never display:none — SuperDoc watches #toolbar's width), the "⋮"
// expansion, and both buttons' aria state. Write kept its own copy only because
// it predated the shared one.
let fold = null;   // set in wireStaticUI, once the DOM is there

function setToolbarOpen( open ) { if( fold ) fold.setOpen( open ); }

// The "⋮" at the end of the row: show every toolbar item (it wraps onto a few
// lines) or just the nine the phone keeps. index.html does the hiding; this only
// flips the class and the button's own pressed look.
function setMoreTools( open ) { if( fold ) fold.setMore( open ); }

// One entry per app button, with that button's own glyph and title cloned, so
// the menu never drifts from the toolbar. Clicking an entry clicks the real
// (hidden) button — wireStaticUI keeps the only set of handlers.
function buildTopMenu()
{
    const menu = document.getElementById( 'topMenu' );

    for( const id of MENU_BTNS )
    {
        const src = document.getElementById( id );
        const svg = src && src.querySelector( 'svg' );
        if( ! svg ) continue;

        const item = document.createElement( 'button' );
        item.type            = 'button';
        item.className       = 'menu-item';
        item.dataset.menu    = id;
        item.appendChild( svg.cloneNode( true ) );
        item.appendChild( document.createTextNode( src.getAttribute( 'title' ) || id ) );
        menu.appendChild( item );
    }
}

function closeTopMenu()
{
    const menu = document.getElementById( 'topMenu' );
    if( menu.hidden ) return;

    menu.hidden = true;
    document.getElementById( 'moreBtn' ).setAttribute( 'aria-expanded', 'false' );
}

function openTopMenu()
{
    const btn  = document.getElementById( 'moreBtn' );
    const menu = document.getElementById( 'topMenu' );
    const r    = btn.getBoundingClientRect();

    // Anchored under the button, like this app's own #tbPopup: .topbar carries
    // overflow-x, so an absolutely positioned child of it would be clipped.
    menu.style.top   = ( r.bottom + 4 ) + 'px';
    menu.style.right = Math.max( 6, window.innerWidth - r.right ) + 'px';
    menu.hidden      = false;
    btn.setAttribute( 'aria-expanded', 'true' );
}

function wireTopMenu()
{
    const btn  = document.getElementById( 'moreBtn' );
    const menu = document.getElementById( 'topMenu' );

    btn.addEventListener( 'click', function( e )
    {
        e.stopPropagation();                       // else the document handler below closes it again
        if( menu.hidden ) openTopMenu(); else closeTopMenu();
    } );

    menu.addEventListener( 'click', function( e )
    {
        const item = e.target.closest( 'button[data-menu]' );
        if( ! item ) return;

        closeTopMenu();
        document.getElementById( item.dataset.menu ).click();
    } );

    document.addEventListener( 'click', function( e )
    {
        if( ! menu.contains( e.target ) && ! btn.contains( e.target ) ) closeTopMenu();
    } );
}

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
    closeTopMenu();
    setMoreTools( false );
    if( ! PHONE.matches ) setToolbarOpen( true );
}
let ready         = false;   // SuperDoc mounted; edits after this are the user's

// The open document - its path, whether it is someone else's, its name, the
// top-bar label, New / Import / "Guardar como" / rename / Restore, start-up,
// the header plug and the autosave - is the one Calc and Text use
// (shared/office.js, THE OPEN DOCUMENT). Write only says how a .docx gets into
// and out of SuperDoc, and that its files are always .docx.
const session = NayiveOffice.session( {
    app        : 'write',
    store      : store,
    appDir     : DOC_DIR,
    openRoot   : OPEN_ROOT,
    defaultName: 'documento.docx',
    encode     : function() { return exportBytes(); },
    load       : loadBody,
    blank      : loadBlank,
    finishName : docxName,
    renameName : docxName,
    canOpen    : isOpenable,                                 // what the Open dialog lists
    onPick     : function( path ) { openPickedFile( path ); },   // a foreign format is converted first
    emptyKey   : 'write.noDocs',
    ready      : function() { return ready; },
    focus      : function() { try { sd && sd.focus(); } catch( _ ) {} }   // the caret stays where it was
} );

// Page setup for this session. A new blank document is created with these
// margins; the dialog also pre-fills from here. SuperDoc's browser build can't
// read a section back (its query API is Node-only), so we just remember.
let pageSetup = { size: 'A4', orientation: 'portrait', top: 2, bottom: 1.6, left: 2, right: 1.6 };

let applyingDefaults = false;   // true while boot() pushes the default page setup onto a new doc

// Spell-check languages. Persisted; the provider reads this live.
const PROOF_LANG_KEY = 'nayive-write-prooflang';
let proofLangs = readProofLangs();

function readProofLangs()
{
    try
    {
        const raw = localStorage.getItem( PROOF_LANG_KEY );
        if( raw !== null ) return raw ? raw.split( ',' ) : [];
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

// bootWithStore hands us whoever /api/whoami reported. SuperDoc needs it AT
// CONSTRUCTION: its engine refuses authored edits (comments, tracked changes)
// with "set user.name ... and reopen the document" when it is missing, and
// setting it afterwards does not count.
let whoAmI = null;

async function boot( who )
{
    whoAmI = who;

    loadPersonalWords();          // best effort; the provider reads it live

    // Toolbar or pull-down menus, from the account. Awaited here, before
    // anything is drawn into #toolbar, so a correction cannot flash.
    await CHROME.sync();

    // ?file= / ?import= / the untitled document kept on this device - or a
    // blank one (shared/office.js). SuperDoc is not up yet, so loadBody() only
    // puts the file aside for initEditor below.
    await session.boot();

    await initEditor( bootSource || BlankDOCX );

    // A brand-new document opens with Nayive's default page setup. Opened /
    // imported files keep their own.
    if( ! bootSource && ready ) await applyDefaultPageSetup();
}

function wireStaticUI()
{
    // New, Import, "Guardar como" and Restore are wired by the session (shared/office.js).
    document.getElementById( 'printBtn'         ).addEventListener( 'click', function() { printDocument( false ); } );
    document.getElementById( 'commentsBtn'      ).addEventListener( 'click', toggleComments );
    document.getElementById( 'commentsCloseBtn' ).addEventListener( 'click', function() { setComments( false ); } );
    document.getElementById( 'tplBtn'           ).addEventListener( 'click', openTemplates );
    document.getElementById( 'tplCloseBtn'      ).addEventListener( 'click', function() { setBackdrop( 'tplBackdrop', false ); } );
    document.getElementById( 'tplChangeBtn'     ).addEventListener( 'click', changeTemplatesDir );
    document.getElementById( 'paraBtn'          ).addEventListener( 'click', openParagraph );
    document.getElementById( 'paraCancelBtn'    ).addEventListener( 'click', function() { setBackdrop( 'paraBackdrop', false ); } );
    document.getElementById( 'paraConfirmBtn'   ).addEventListener( 'click', confirmParagraph );

    // Any change in the dialog marks its GROUP, so Apply only touches what the
    // user actually looked at (there is no way to read the current values back).
    for( const g in PARA_GROUPS )
        for( const id of PARA_GROUPS[ g ] )
            document.getElementById( id ).addEventListener( 'change', function( e )
            {
                markParagraphTouched( e.target.id );
                syncParagraphRows();
            } );

    document.getElementById( 'statsBtn'         ).addEventListener( 'click', openStats );
    document.getElementById( 'statsCloseBtn'    ).addEventListener( 'click', function() { setBackdrop( 'statsBackdrop', false ); } );
    document.getElementById( 'scBtn'            ).addEventListener( 'click', openShortcuts );
    document.getElementById( 'scCloseBtn'       ).addEventListener( 'click', function() { setBackdrop( 'scBackdrop', false ); } );
    document.getElementById( 'pdfBtn'           ).addEventListener( 'click', function() { printDocument( true ); } );
    window.addEventListener( 'afterprint', restoreZoom );
    document.getElementById( 'saveAsCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'saveAsBackdrop', false ); } );
    document.getElementById( 'pageSetupBtn'        ).addEventListener( 'click', openPageSetup );
    document.getElementById( 'headerBtn'           ).addEventListener( 'click', function() { toggleHeaderFooter( 'header' ); } );
    document.getElementById( 'footerBtn'           ).addEventListener( 'click', function() { toggleHeaderFooter( 'footer' ); } );
    document.getElementById( 'pageNumBtn'          ).addEventListener( 'click', insertPageNumber );

    // Leaving the header/footer overlay can happen by clicking in the body, not
    // only through these buttons — so follow the editor, not just our handlers.
    new MutationObserver( function()
    {
        updatePageNumBtn();
        if( ! hfExitButton() ) hfOpenKind = null;
    } ).observe( document.getElementById( 'editor' ), { childList: true, subtree: true } );

    // SuperDoc's find bar is a Vue render, rebuilt on every open inside a
    // .sd-surface-host it adds to <body> the first time. Its ‹ › × are local
    // look-alikes (28px rounded squares), so each mount swaps them for the shared
    // .icon-btn.sm - the chevrons are Calendar's pager glyphs, the × the shared
    // one. Vue only ever patches their disabled / title / aria-label, so the new
    // class and icons stay put.
    const surfaceHosts = new WeakSet();
    function chevron( points )
    {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
               '<polyline points="' + points + '"></polyline></svg>';
    }
    const FIND_NAV_ICONS = [ chevron( '15 18 9 12 15 6' ), chevron( '9 18 15 12 9 6' ), NayiveUI.icon( 'x' ) ];   // prev, next, close
    function standardFindNav()
    {
        // The chevron before the field (show / hide Replace) too. ITS class is
        // bound to the open state, so Vue writes it back on every toggle - the
        // host observer watches class, and this puts .icon-btn.sm back each
        // time. The open state still shows through aria-expanded (index.html).
        const x = document.querySelector( '.sd-find-replace__btn--expander' );
        if( x )
        {
            x.className = 'icon-btn sm';
            if( ! x.querySelector( 'polyline' ) ) x.innerHTML = chevron( '9 18 15 12 9 6' );
        }

        const nav = document.querySelector( '.sd-find-replace__nav:not(.sd-find-replace__nav--actions)' );
        if( ! nav || nav.querySelector( '.icon-btn' ) ) return;

        nav.querySelectorAll( ':scope > button' ).forEach( function( b, i )
        {
            if( ! FIND_NAV_ICONS[ i ] ) return;

            b.className = 'icon-btn sm';
            b.innerHTML = FIND_NAV_ICONS[ i ];
        } );
    }
    new MutationObserver( function()
    {
        const host = document.querySelector( 'body > .sd-surface-host' );
        if( ! host || surfaceHosts.has( host ) ) return;

        surfaceHosts.add( host );
        new MutationObserver( standardFindNav ).observe( host, { childList: true, subtree: true, attributes: true, attributeFilter: [ 'class' ] } );
        standardFindNav();
    } ).observe( document.body, { childList: true } );

    wireTableBorders();
    restoreTbStyle();

    document.getElementById( 'settingsBtn'         ).addEventListener( 'click', openSettings );
    document.getElementById( 'settingsCancelBtn'   ).addEventListener( 'click', function() { setBackdrop( 'settingsBackdrop', false ); } );
    document.getElementById( 'settingsConfirmBtn'  ).addEventListener( 'click', confirmSettings );
    document.getElementById( 'pageSetupCancelBtn'  ).addEventListener( 'click', function() { setBackdrop( 'pageSetupBackdrop', false ); } );
    document.getElementById( 'pageSetupConfirmBtn' ).addEventListener( 'click', confirmPageSetup );
    document.getElementById( 'psSize'              ).addEventListener( 'change', syncPageSizeRows );

    // ---- phone chrome (see PHONE CHROME above) ----
    buildTopMenu();
    wireTopMenu();
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

    document.getElementById( 'imgInput'      ).addEventListener( 'change', function( e ) { insertPickedImage( e.target.files[0] ); e.target.value = ''; } );
    document.getElementById( 'linkCancelBtn' ).addEventListener( 'click', function() { setBackdrop( 'linkBackdrop', false ); } );
    document.getElementById( 'linkConfirmBtn' ).addEventListener( 'click', confirmLink );
    document.getElementById( 'linkHref'      ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' ) confirmLink(); } );

    document.getElementById( 'fitBtn'       ).addEventListener( 'click', togglePhoneFit );
    syncPhoneFitBtn();
    // Tapping into the document folds the row away — the keyboard is about to
    // take half the screen. Only a tap INSIDE #editor: a toolbar button also
    // puts focus back in the text, and must not fold the row under your finger.
    // Capture phase, so SuperDoc cannot swallow it first. isTrusted keeps
    // placeInitialCaret()'s synthetic tap from folding the row on load — the
    // bar has to be seen once before it can hide.
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
            if( ! document.getElementById( 'topMenu' ).hidden ) { closeTopMenu(); return; }
            if( document.getElementById( 'tbPopup'  ).classList.contains( 'open' ) ) { closeTbPopup();  return; }
            if( document.getElementById( 'symPopup' ).classList.contains( 'open' ) ) { closeSymPopup(); return; }

            const open = document.querySelector( '.sheet-backdrop.open' );
            if( open ) setBackdrop( open.id, false );
        }
    });
}

function setBackdrop( id, open ) { NayiveUI.setOpen( id, open ); }   // impl in shared/ui.js

//----------------------------------------------------------------------------//
// EDITOR

function initEditor( source )
{
    return new Promise( function( resolve )
    {
        // SuperDoc's mount can silently never fire onReady (bad bundle, worker
        // 404, unsupported browser). Don't let boot() hang forever on it.
        let settled  = false;
        const finish = function() { if( ! settled ) { settled = true; clearTimeout( watchdog ); resolve(); } };

        const watchdog = setTimeout( function()
        {
            if( ! ready ) NayiveUI.toast( NayiveUI.t( 'write.editorSlow' ) );
            document.getElementById( 'editor' ).classList.add( 'is-ready' );   // never leave the overlay up
            finish();
        }, 30000 );

        sd = new SuperDoc(
        {
            selector     : '#editor',
            documentMode : 'editing',
            document     : source,

            // Without a name the engine writes comments as "Default SuperDoc
            // user"; with one they carry the person who wrote them.
            user         : { id   : ( whoAmI && ( whoAmI.user || whoAmI.id ) ) || null,
                             name : ( whoAmI && ( whoAmI.user || whoAmI.name ) ) || NayiveUI.t( 'write.meAuthor' ),
                             email: ( whoAmI && whoAmI.email ) || null },
            measurementUnit : 'cm',   // ruler / page-setup / margin inputs in cm, not inches

            // Contained mode: SuperDoc lives in our fixed-height #editor box and
            // runs its OWN scroll container inside it (centres the page, shows a
            // vertical scrollbar, keeps the caret hit-testing aligned). Without
            // it SuperDoc assumes the whole page scrolls and the paper sticks to
            // the top-left with no scrollbar.
            contained    : true,

            // ui.search: off by default — turn it on so the toolbar find button
            // (and Ctrl+F) work. 'ai' phones home. The two tracked-change buttons
            // used to be excluded as dead weight, which left "Sugerir" mode in
            // Settings with no way to FINISH a review; they are built now and CSS
            // hides them unless the mode is actually 'suggesting' (excludeItems is
            // read once at construction, so hiding is the only runtime lever).
            // 'ruler' / 'measurementUnit' / 'documentMode' are pulled out of the
            // toolbar into the app's own Settings dialog (the gear button) —
            // driven there via sd.toggleRuler() / sd.setMeasurementUnit() /
            // sd.setDocumentMode().
            // overflow:'wrap' + responsiveTo:'container' — the toolbar reflows
            // onto more lines as it narrows instead of hiding items in a menu.
            // Its own 'overflow' (⋮) button stays excluded: it can only cut the
            // TAIL of SuperDoc's fixed item order (the sole item it will pin is
            // hard-coded, `te = ["search"]`), so it would bury common things
            // like the alignment or the lists just for being late in that order.
            // The phone's one-row split is done in index.html instead, by name
            // — see PHONE CHROME below.
            ui           : { // SuperDoc's own "Opening document..." overlay is permanently
                             // English (its normalizer drops any texts we pass), so it is
                             // off and index.html's #editorLoading stands in.
                             loading: false,
                             search: { strings: textsFrom( FIND_TEXT_KEYS, 'write.find.' ) },
                             contextMenu : { menuProvider: function( ctx, sections )
                                             {
                                                 fillSuggestions( misspelledWordAt( ctx, sections ), sections );
                                                 addDictionaryItem( ctx, sections );
                                                 return localizeMenu( sections );
                                             } },
                             toolbar: { container    : '#toolbar',
                                        texts        : textsFrom( TB_TEXT_KEYS, 'write.tb.' ),
                                        overflow     : 'wrap',
                                        responsiveTo : 'container',
                                        excludeItems : [ 'ai', 'overflow',
                                                         'ruler', 'measurementUnit', 'documentMode' ],
                                        // A "table borders" button SuperDoc lacks. It renders at the
                                        // toolbar end; index.html CSS `order`s it next to table options.
                                        // Every item needs an explicit `attributes.ariaLabel`: SuperDoc
                                        // otherwise derives one from the (absent) `label` and a screen
                                        // reader is read "undefined" plus whatever text the icon holds.
                                        // Buttons SuperDoc has commands for but builds no item for.
                                        // Their position in the row is CSS `order` (index.html) —
                                        // custom items always render at the end otherwise.
                                        customItems  : [ { id: 'tableBorders', type: 'button', tooltip: NayiveUI.t( 'write.tableBorders' ),
                                                           attributes: { ariaLabel: NayiveUI.t( 'write.tableBorders' ) },
                                                           icon: '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" stroke-width="2.2"></rect><line x1="3.5" y1="12" x2="20.5" y2="12" stroke-width="1.3"></line><line x1="12" y1="3.5" x2="12" y2="20.5" stroke-width="1.3"></line></svg>',
                                                           command: function() { openTableBorders(); } },

                                                         { id: 'superScript', type: 'button', tooltip: NayiveUI.t( 'write.superscript' ),
                                                           attributes: { ariaLabel: NayiveUI.t( 'write.superscript' ) },
                                                           icon: '<svg viewBox="0 0 24 24"><text x="0.5" y="21" font-size="24" font-weight="600" font-family="serif" fill="currentColor">x</text><text x="13.5" y="11" font-size="14" font-weight="600" font-family="serif" fill="currentColor">2</text></svg>',
                                                           command: function() { setVertAlign( 'superscript' ); } },

                                                         { id: 'subScript', type: 'button', tooltip: NayiveUI.t( 'write.subscript' ),
                                                           attributes: { ariaLabel: NayiveUI.t( 'write.subscript' ) },
                                                           icon: '<svg viewBox="0 0 24 24"><text x="0.5" y="17" font-size="24" font-weight="600" font-family="serif" fill="currentColor">x</text><text x="13.5" y="23" font-size="14" font-weight="600" font-family="serif" fill="currentColor">2</text></svg>',
                                                           command: function() { setVertAlign( 'subscript' ); } },

                                                         { id: 'pageBreak', type: 'button', tooltip: NayiveUI.t( 'write.pageBreak' ),
                                                           attributes: { ariaLabel: NayiveUI.t( 'write.pageBreak' ) },
                                                           icon: '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v3"></path><path d="M19 14v7H6a1 1 0 0 1-1-1v-6"></path><line x1="2.5" y1="12" x2="21.5" y2="12" stroke-dasharray="3 2.5"></line></svg>',
                                                           command: function() { insertPageBreak(); } },

                                                         { id: 'footNote', type: 'button', tooltip: NayiveUI.t( 'write.footnote' ),
                                                           attributes: { ariaLabel: NayiveUI.t( 'write.footnote' ) },
                                                           icon: '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3.5" y1="5" x2="14" y2="5"></line><line x1="3.5" y1="9.5" x2="11" y2="9.5"></line><line x1="3.5" y1="18" x2="12" y2="18"></line><line x1="3.5" y1="21" x2="9" y2="21"></line><line x1="3.5" y1="13.8" x2="9" y2="13.8" stroke-width="1.4"></line><text x="15" y="10" font-size="9" font-family="serif" fill="currentColor" stroke="none">1</text></svg>',
                                                           command: function() { insertFootnote(); } },

                                                         { id: 'insertToc', type: 'button', tooltip: NayiveUI.t( 'write.toc' ),
                                                           attributes: { ariaLabel: NayiveUI.t( 'write.toc' ) },
                                                           icon: '<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="6" y2="6"></line><line x1="9" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="6" y2="12"></line><line x1="9" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="6" y2="18"></line><line x1="9" y1="18" x2="21" y2="18"></line></svg>',
                                                           command: function() { runSdCommand( 'table-of-contents-insert' ); } },

                                                         { id: 'symbols', type: 'button', tooltip: NayiveUI.t( 'write.symbols' ),
                                                           attributes: { ariaLabel: NayiveUI.t( 'write.symbols' ) },
                                                           icon: '<svg viewBox="0 0 24 24"><text x="12" y="21" font-size="26" font-weight="600" font-family="serif" text-anchor="middle" fill="currentColor">Ω</text></svg>',
                                                           command: function() { openSymbols(); } },

                                                         { id: 'showMarks', type: 'button', tooltip: NayiveUI.t( 'write.formattingMarks' ),
                                                           attributes: { ariaLabel: NayiveUI.t( 'write.formattingMarks' ) },
                                                           icon: '<svg viewBox="0 0 24 24"><text x="12" y="21.5" font-size="27" font-weight="600" font-family="serif" text-anchor="middle" fill="currentColor">\u00b6</text></svg>',
                                                           command: function() { runSdCommand( 'formatting-marks' ); } } ] } },

            handleImageUpload : fileToDataUrl,   // keep images inline so the doc stays self-contained / offline-safe
            proofing     :
            {
                enabled        : true,
                provider       : makeSpellProvider( () => proofLangs ),
                defaultLanguage : proofLangs[0] || 'es',
                debounceMs      : 600
            },

            onReady        : function()
            {
                ready = true; window.superdoc = sd;   // window.superdoc: handy for the browser console
                document.getElementById( 'editor' ).classList.add( 'is-ready' );
                applyModeChrome( sd.config && sd.config.documentMode );
                wireAutocorrect();
                sd.on( 'document-mode-change', function( p ) { applyModeChrome( ( p && p.documentMode ) || ( sd.config && sd.config.documentMode ) ); } );
                finish(); focusEditor(); fitPhoneZoom();
            },
            onEditorUpdate : onEdit,
            onPaginationUpdate : function( p ) { if( p && p.totalPages ) pageTotal = p.totalPages; },
            onContentError : function( p ) { console.error( 'Write: content error', p && p.error ); NayiveUI.toast( NayiveUI.t( 'write.openDocFailed' ) ); },
            onException    : function( p )
            {
                console.error( 'Write: exception', p );
                if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.editorStartFailed' ) ); finish(); }
            }
        });
    });
}

// Swap the open document without tearing down the editor (stable identity).
async function loadIntoEditor( file )
{
    ready = false;

    try
    {
        await sd.replaceFile( file );
    }
    finally
    {
        ready = true;
        focusEditor();
    }
}

// Put the caret in the page so the user can type straight away, after the
// initial mount and after every document swap. sd.focus() only focuses the
// hidden input — the document itself still has no caret until it's clicked,
// so we synthesise that first click near the top of the first page.
function focusEditor()
{
    setTimeout( function()
    {
        try { sd && sd.focus(); } catch( _ ) {}
        placeInitialCaret();
    }, 30 );
}

function placeInitialCaret()
{
    try
    {
        const page = document.querySelector( '#editor .superdoc-page' );
        if( ! page ) return;

        const box = page.getBoundingClientRect();
        const cx  = box.left + 100;                 // ~1st line, inside the page margin
        const cy  = box.top  + 100;
        const el  = document.elementFromPoint( cx, cy );
        if( ! el || ! page.contains( el ) ) return;

        const base = { bubbles: true, cancelable: true, composed: true, view: window,
                       clientX: cx, clientY: cy, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };

        el.dispatchEvent( new PointerEvent( 'pointerdown', { ...base, buttons: 1 } ) );
        el.dispatchEvent( new MouseEvent(   'mousedown',   { ...base, buttons: 1 } ) );
        el.dispatchEvent( new PointerEvent( 'pointerup',   { ...base, buttons: 0 } ) );
        el.dispatchEvent( new MouseEvent(   'mouseup',     { ...base, buttons: 0 } ) );
        el.dispatchEvent( new MouseEvent(   'click',       { ...base, buttons: 0 } ) );
    }
    catch( _ ) {}
}

function onEdit()
{
    if( ! ready || applyingDefaults ) return;

    session.edited();
}

//----------------------------------------------------------------------------//
// SETTINGS  (gear button)
//
// Four controls that used to live in the toolbar: SuperDoc's own document-mode /
// ruler / measurement-unit widgets (removed via excludeItems) plus the app's
// proofing-language <select>. SuperDoc holds the live state, so the dialog reads
// it back each time it opens and only pushes the deltas on "Aplicar":
//   sd.config.documentMode     'editing' | 'suggesting' | 'viewing'
//   sd.config.rulers           bool  (sd.toggleRuler() flips it)
//   sd.getMeasurementUnit()    'cm' | 'in'
// The language change still goes through changeProofLangs() (which reloads the
// document so the whole text is re-checked) — run last, as it rebuilds the editor.

const DOC_MODES = [ 'editing', 'suggesting', 'viewing' ];

function currentMeasurementUnit()
{
    try { return sd && sd.getMeasurementUnit() === 'in' ? 'in' : 'cm'; }
    catch( _ ) { return 'cm'; }
}

function openSettings()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    const mode = ( sd && sd.config && sd.config.documentMode ) || 'editing';
    document.getElementById( 'setMode'   ).value   = DOC_MODES.indexOf( mode ) >= 0 ? mode : 'editing';
    document.getElementById( 'setUnit'   ).value   = currentMeasurementUnit();
    document.getElementById( 'setRuler'  ).checked = !! ( sd && sd.config && sd.config.rulers );
    renderProofLangs();
    document.getElementById( 'setAutocorrect' ).checked = autocorrectOn;

    setBackdrop( 'settingsBackdrop', true );
}

async function confirmSettings()
{
    const mode  = document.getElementById( 'setMode'  ).value;
    const unit  = document.getElementById( 'setUnit'  ).value === 'in' ? 'in' : 'cm';
    const ruler = document.getElementById( 'setRuler' ).checked;
    const lang  = [ ...document.querySelectorAll( '#proofLangs input:checked' ) ]
                      .map( function( i ) { return i.value; } ).join( ',' );

    setBackdrop( 'settingsBackdrop', false );

    try
    {
        if( DOC_MODES.indexOf( mode ) >= 0 && sd.config && sd.config.documentMode !== mode )
            sd.setDocumentMode( mode );
    }
    catch( e ) { console.error( 'Write: document mode', e ); }

    try
    {
        if( currentMeasurementUnit() !== unit ) sd.setMeasurementUnit( unit );
    }
    catch( e ) { console.error( 'Write: measurement unit', e ); }

    try
    {
        if( !! ( sd.config && sd.config.rulers ) !== ruler ) sd.toggleRuler();
    }
    catch( e ) { console.error( 'Write: ruler', e ); }

    setAutocorrect( document.getElementById( 'setAutocorrect' ).checked );

    if( lang !== proofLangs.join( ',' ) ) await changeProofLangs( lang );
}

//----------------------------------------------------------------------------//
// PROOFING LANGUAGE
//
// The provider reads `proofLangs` live, but SuperDoc only re-checks text that
// changes — so switching language re-runs the whole document by reloading its
// own bytes (a byte-identical round-trip; see BUILD.md fidelity notes).

async function changeProofLangs( raw )
{
    proofLangs = raw ? raw.split( ',' ) : [];

    try { localStorage.setItem( PROOF_LANG_KEY, proofLangs.join( ',' ) ); } catch( _ ) {}

    if( ! ready ) return;

    await session.flush();      // land any waiting autosave before we tear the doc down and reload it

    try
    {
        const bytes = await exportBytes();
        await loadIntoEditor( new File( [ bytes ], baseName( session.path() || session.name() || 'documento.docx' ), { type: DOCX_MIME } ) );
    }
    catch( _ ) { /* leave the editor as is; the new language applies on the next edit */ }
}

//----------------------------------------------------------------------------//
// HEADER / FOOTER
//
// SuperDoc has full native header/footer editing (type in the top/bottom page
// margin, "Options ▾" for different-first-page / odd-even / distances) — you
// just enter it by double-clicking the margin, which is not discoverable. This
// button synthesises that double-click on the first page's header band, and
// clicks the overlay's own "×" to leave again. (Automatic page-number FIELDS
// can't be inserted yet — SuperDoc's browser build has no working selection API
// for doc.fields.insert — so header/footer text is manual for now.)

// Are we inside the header/footer overlay right now?
function hfExitButton() { return document.querySelector( '#editor [data-sd-hf-exit]' ); }

let hfOpenKind = null;   // which band the overlay is showing, or null

// `kind` is 'header' or 'footer'. Clicking the button for the band you are
// already in leaves it; clicking the other one leaves and enters that one.
function toggleHeaderFooter( kind )
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    const exit = hfExitButton();

    if( exit )
    {
        const was = hfOpenKind;
        exit.dispatchEvent( new PointerEvent( 'pointerdown', { bubbles: true, cancelable: true } ) );
        hfOpenKind = null;
        focusEditor();

        if( was === kind ) return;                                    // that was a "leave"
        setTimeout( function() { enterHeaderFooter( kind ); }, 300 );  // swap bands
        return;
    }

    enterHeaderFooter( kind );
}

async function enterHeaderFooter( kind )
{
    try
    {
        // Ask SuperDoc whether the band is really there before faking a click at
        // it: it answers { status: 'ready' | 'unavailable' | 'pending' }, so a
        // page that cannot take one fails with a message instead of a dead click.
        const t = sd.activeEditor.host.resolveHeaderFooterEditTarget( { pageIndex: 0, kind: kind } );
        if( ! t || t.status !== 'ready' ) { NayiveUI.toast( NayiveUI.t( 'write.headerFailed' ) ); return; }

        if( ! ( await dblClickBand( kind ) ) ) { NayiveUI.toast( NayiveUI.t( 'write.headerFailed' ) ); return; }

        setTimeout( function()
        {
            if( hfExitButton() ) { hfOpenKind = kind; updatePageNumBtn(); }
            else NayiveUI.toast( NayiveUI.t( 'write.dblClickMargin' ) );
        }, 250 );
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.headerFailed' ) ); }
}

//----------------------------------------------------------------------------//
// PAGE NUMBER
//
// A real Word field, not typed text, so it counts itself on every page.
// A comment here used to say this was impossible ("no working selection API for
// doc.fields.insert"). Half true: SuperDoc's own Mod+Shift+Alt+P route IS dead in
// this build - its guard wants a synchronous selection and the browser adapter
// forces async - but doc.fields.insert itself works, given the caret.
//
// The caret has to be IN a header or footer: a page number in the body would
// simply print once, wherever it landed.

async function insertPageNumber()
{
    if( ! ready || ! sd ) return;

    try
    {
        const doc = sd.activeEditor.doc;

        // Gate on where the CARET is, not on the overlay's close button: that
        // button is briefly detached whenever SuperDoc re-renders the band, so a
        // click landing in that window would be refused for no visible reason.
        // The story is what fields.insert actually needs anyway.
        let sel = await doc.selection.current( { includeText: false } );

        // Entering the band opens the overlay but does not always leave a caret
        // in it: the first double-click is what switches SuperDoc into
        // header/footer editing, and the band only becomes clickable text once
        // that has re-rendered. A second click, now that it has, lands properly.
        if( ! inHeaderFooterStory( sel ) )
        {
            await dblClickBand( hfOpenKind || 'header' );
            await new Promise( function( r ) { setTimeout( r, 700 ); } );
            sel = await doc.selection.current( { includeText: false } );
        }

        if( ! inHeaderFooterStory( sel ) )
        { NayiveUI.toast( NayiveUI.t( 'write.pageNumInHeader' ) ); return; }

        await doc.fields.insert( { at: sel.target, instruction: 'PAGE', mode: 'raw' } );   // mode is required

        // Deliberately NOT focusEditor(): that puts the caret back in the body,
        // which throws you out of the header the moment you number it.
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

function inHeaderFooterStory( sel )
{
    const st = sel && sel.target && sel.target.story;
    return !! st && st.storyType === 'headerFooterPart';
}

// The button only does anything inside a header or footer - grey it out
// everywhere else rather than letting it toast.
function updatePageNumBtn()
{
    const b = document.getElementById( 'pageNumBtn' );
    if( b ) b.disabled = ! hfExitButton();
}

// The pointer dance that puts the caret in the header or footer band. A single
// click does NOT do it - only the double-click SuperDoc listens for - so this is
// shared by entering the band and by the page-number fallback.
//
// Where to aim used to be "3.5 % of the page height from the top", which only
// happened to work on A4: the header box sits at the section's header margin
// (half an inch by default), so on a shorter page 3.5 % lands ABOVE it, on bare
// paper, and the double-click does nothing. Measure it properly instead - the
// page's own height gives us pixels-per-inch, whatever the paper and the zoom.
async function dblClickBand( kind )
{
    const page = document.querySelector( '#editor .superdoc-page' );
    if( ! page ) return false;

    page.scrollIntoView( { block: kind === 'footer' ? 'end' : 'start' } );
    await new Promise( function( r ) { setTimeout( r, 120 ); } );

    const box = page.getBoundingClientRect();

    let inset = box.height * ( kind === 'footer' ? 0.035 : 0.035 );   // fallback

    try
    {
        const sec = ( await sd.activeEditor.doc.sections.list() ).items[ 0 ];
        const hIn = sec.pageSetup && sec.pageSetup.height;
        const hf  = ( sec.headerFooterMargins || {} )[ kind ];

        // A few pixels past the top of the band, so the click lands inside the
        // text box and not on its very edge.
        if( hIn > 0 && hf >= 0 ) inset = ( hf * ( box.height / hIn ) ) + 6;
    }
    catch( _ ) {}

    const cx = box.left + box.width / 2;
    const cy = kind === 'footer' ? box.bottom - inset : box.top + inset;
    const el = document.elementFromPoint( cx, cy );

    if( ! el || ! page.contains( el ) ) return false;

    const o = { bubbles: true, cancelable: true, composed: true, view: window,
                clientX: cx, clientY: cy, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    for( let i = 1; i <= 2; i++ )
    {
        el.dispatchEvent( new PointerEvent( 'pointerdown', { ...o, buttons: 1 } ) );
        el.dispatchEvent( new MouseEvent(   'mousedown',   { ...o, buttons: 1, detail: i } ) );
        el.dispatchEvent( new PointerEvent( 'pointerup',   { ...o, buttons: 0 } ) );
        el.dispatchEvent( new MouseEvent(   'mouseup',     { ...o, buttons: 0, detail: i } ) );
        el.dispatchEvent( new MouseEvent(   'click',       { ...o, buttons: 0, detail: i } ) );
    }
    el.dispatchEvent( new MouseEvent( 'dblclick', { ...o, buttons: 0, detail: 2 } ) );

    return true;
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

// "Añadir al diccionario", next to SuperDoc's own spelling entries. The word
// comes from the misspelling the menu was opened on, so it only appears when
// there is one.
function addDictionaryItem( ctx, sections )
{
    if( ! Array.isArray( sections ) ) return;

    const word = misspelledWordAt( ctx, sections );
    if( ! word ) return;

    sections.unshift( { items: [ {
        id      : 'nayive-add-to-dictionary',
        label   : NayiveUI.tf( 'write.addToDict', { word: word } ),
        onSelect: function() { addPersonalWord( word ); },
        action  : function() { addPersonalWord( word ); }
    } ] } );
}

// Where the last right-click landed. SuperDoc 2.10 does NOT put the proofing
// issue in the menu context - it keeps it to itself - so "Añadir al
// diccionario" never found a word and never showed. Its proofing runtime still
// answers "which misspelling is at this point", which is how its own menu finds
// it. Capture phase: SuperDoc opens the menu from its own contextmenu handler.
let lastMenuPoint = null;

document.addEventListener( 'contextmenu', function( e )
{
    lastMenuPoint = { x: e.clientX, y: e.clientY, t: Date.now() };
}, true );

// Only when SuperDoc itself built a spelling section (so there IS a misspelling
// under the pointer), and only for a right-click just now - a menu opened from
// the keyboard must not pick up a word from an old click.
function issueUnderMenu( sections )
{
    if( ! lastMenuPoint || Date.now() - lastMenuPoint.t > 2000 ) return null;
    if( ! Array.isArray( sections ) || ! sections.some( function( s ) { return s && s.id === 'proofing'; } ) ) return null;

    const rt = sd && sd.activeEditor && sd.activeEditor.host &&
               sd.activeEditor.host.getProofingRuntime && sd.activeEditor.host.getProofingRuntime();

    return ( rt && rt.getIssueFromPoint( lastMenuPoint.x, lastMenuPoint.y ) ) || null;
}

// SuperDoc may one day hand the menu context the issue it was opened on; the
// shape has moved between versions, so read it defensively.
function misspelledWordAt( ctx, sections )
{
    try
    {
        const issue = ( ctx && ( ctx.proofingIssue || ctx.issue ||
                                 ( ctx.proofing && ctx.proofing.issue ) ) ) || issueUnderMenu( sections );

        if( issue && issue.word ) return issue.word;

        // Fall back to the text the message was built from: "«palabra» no está…"
        const m = issue && issue.message && /[«"']([^«»"']+)[»"']/.exec( issue.message );
        if( m ) return m[ 1 ];
    }
    catch( _ ) {}

    return null;
}

//----------------------------------------------------------------------------//
// COMENTARIOS
//
// SuperDoc's whole comment system is in the bundle and was simply never mounted:
// the list needs an element to live in. This is that element, plus the toggle.
// (The engine also wants a real user.name for authored edits - see boot().)

let commentsOn = false;

function toggleComments()
{
    if( ! ready || ! sd ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    setComments( ! commentsOn );
}

function setComments( on )
{
    const panel = document.getElementById( 'commentsPanel' );
    const btn   = document.getElementById( 'commentsBtn' );

    commentsOn = !! on;
    panel.hidden = ! commentsOn;
    btn.classList.toggle( 'is-active', commentsOn );
    btn.setAttribute( 'aria-expanded', String( commentsOn ) );

    try
    {
        if( commentsOn ) sd.addCommentsList( document.getElementById( 'commentsList' ) );
        else if( sd.removeCommentsList ) sd.removeCommentsList();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }

    // The editor box just changed width; SuperDoc re-measures on resize.
    window.dispatchEvent( new Event( 'resize' ) );
}

//----------------------------------------------------------------------------//
// MI DICCIONARIO  (words the user adds by hand)
//
// A name you use every day should stop being red. The list lives with the rest
// of the app's data so it follows the account, not the browser.

const PERSONAL_DICT = 'data/write/dict.json';
let   personalWords = [];

async function loadPersonalWords()
{
    try
    {
        const j = await GumApi.readJson( PERSONAL_DICT );
        personalWords = Array.isArray( j && j.words ) ? j.words : [];
    }
    catch( _ ) { personalWords = []; }

    setPersonalWords( personalWords );
}

async function addPersonalWord( word )
{
    word = String( word || '' ).trim();
    if( ! word || isPersonalWord( word ) ) return;

    personalWords.push( word );
    setPersonalWords( personalWords );

    try { await GumApi.writeJson( PERSONAL_DICT, { words: personalWords } ); }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.dictSaveFailed' ) ); }

    NayiveUI.toast( NayiveUI.tf( 'write.wordAdded', { word: word } ) );
    reproofDocument();
}

// SuperDoc only re-checks text it thinks changed, so nudge it: turning proofing
// off and on again re-runs the provider over the whole document.
function reproofDocument()
{
    try
    {
        if( ! sd || ! sd.setProofingEnabled ) return;
        sd.setProofingEnabled( false );
        setTimeout( function() { sd.setProofingEnabled( true ); }, 60 );
    }
    catch( _ ) {}
}

//----------------------------------------------------------------------------//
// AUTOCORRECCION  (smart quotes and friends)
//
// Off by default: it fights with file names, code and anything typed literally.
// One checkbox in Settings turns it on. It runs on the text as it is typed, by
// watching what goes through the editing input handle.

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
// just before it (which is why the caret's line is read first).
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

// Wrap the editing input handle once the editor is up, so every insertText goes
// through the replacements. Wrapping (rather than a keydown listener) keeps it
// working for paste and for the symbols popup alike.
function wireAutocorrect()
{
    try
    {
        const inp = sd.activeEditor.host.getHandles().editing.input;
        if( ! inp || inp.__nayiveWrapped ) return;

        const original = inp.insertText.bind( inp );

        inp.insertText = function( text )
        {
            return original( autocorrectText( text, lastTypedContext() ) );
        };

        inp.__nayiveWrapped = true;
    }
    catch( _ ) {}
}

// The character before the caret, for deciding whether a quote opens or closes.
function lastTypedContext()
{
    try
    {
        const caret = document.querySelector( '#editor .sd-v2-local-selection-caret' );
        if( ! caret ) return '';

        const r  = caret.getBoundingClientRect();
        const el = document.elementFromPoint( Math.max( 0, r.left - 2 ), r.top + r.height / 2 );

        return el && el.textContent ? el.textContent.slice( -1 ) : '';
    }
    catch( _ ) { return ''; }
}

//----------------------------------------------------------------------------//
// PLANTILLAS  /  RESTAURAR  /  RECIENTES

// Templates are just .docx files in a folder you pick. Nothing is shipped: the
// folder is yours, so what counts as a template is your business. Its own key in
// data/write/config.json, NOT the launcher-folder slot, so a future "open Write
// in folder X" cannot collide with it.
const WRITE_CFG = 'data/write/config.json';

async function readWriteCfg()
{
    try { return ( await GumApi.readJson( WRITE_CFG ) ) || {}; }
    catch( _ ) { return {}; }
}

async function writeWriteCfg( patch )
{
    const cfg = await readWriteCfg();
    Object.assign( cfg, patch );
    try { await GumApi.writeJson( WRITE_CFG, cfg ); } catch( _ ) {}
    return cfg;
}

async function openTemplates()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    const cfg = await readWriteCfg();
    let   dir = cfg.templatesDir;

    if( ! dir )
    {
        dir = await NayiveUI.pickFolder( { title: NayiveUI.t( 'write.pickTemplatesDir' ),
                                           note : NayiveUI.t( 'write.pickTemplatesNote' ),
                                           allowRoot: true } );
        if( ! dir ) return;
        await writeWriteCfg( { templatesDir: dir } );
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
// - the template itself is never overwritten.
async function useTemplate( path )
{
    setBackdrop( 'tplBackdrop', false );

    try
    {
        await session.flush();

        const file = await fetchAsFile( path );
        await loadIntoEditor( file );

        session.untitled( baseName( path ), { dirty: true } );
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.openDocFailed' ) ); }
}

async function changeTemplatesDir()
{
    const dir = await NayiveUI.pickFolder( { title: NayiveUI.t( 'write.pickTemplatesDir' ),
                                             note : NayiveUI.t( 'write.pickTemplatesNote' ),
                                             allowRoot: true } );
    if( ! dir ) return;

    await writeWriteCfg( { templatesDir: dir } );
    renderTemplates( dir );
}

//----------------------------------------------------------------------------//
// SIMBOLOS  (special characters)
//
// An anchored popup off a custom toolbar button, the same trio as the table
// borders one: open / close / pointerdown-outside. Characters go in through the
// editing input handle - there is no contenteditable to type into.

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

    if( document.getElementById( 'symPopup' ).classList.contains( 'open' ) ) { closeSymPopup(); return; }

    renderSymbols();
    openSymPopup();
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
        b.className   = 'sym-tab' + ( i === symTab ? ' is-active' : '' );
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

async function insertSymbol( ch )
{
    try
    {
        await sd.activeEditor.host.getHandles().editing.input.insertText( ch );
        onEdit();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

function openSymPopup()
{
    const pop = document.getElementById( 'symPopup' );

    pop.classList.add( 'open' );   // lay it out before measuring

    const r  = anchorRect( '#toolbar [data-item="btn-symbols"]' );
    const vw = document.documentElement.clientWidth;

    let left = Math.min( r.left, vw - pop.offsetWidth - 8 );
    if( left < 8 ) left = 8;

    pop.style.top  = ( r.bottom + 4 ) + 'px';
    pop.style.left = left + 'px';

    setTimeout( function()   // deferred, else the opening click closes it again
    {
        document.addEventListener( 'pointerdown', onSymOutside, true );
        window.addEventListener( 'resize', closeSymPopup );
    }, 0 );
}

function closeSymPopup()
{
    document.getElementById( 'symPopup' ).classList.remove( 'open' );
    document.removeEventListener( 'pointerdown', onSymOutside, true );
    window.removeEventListener( 'resize', closeSymPopup );
}

function onSymOutside( e )
{
    const pop = document.getElementById( 'symPopup' );
    if( pop.contains( e.target ) ) return;

    // Let the trigger's own click through, so the button can toggle it shut.
    const ctn = e.target.closest && e.target.closest( '.superdoc-toolbar .sd-toolbar-item-ctn' );
    if( ctn && ctn.querySelector( '[data-item="btn-symbols"]' ) ) return;

    closeSymPopup();
}

//----------------------------------------------------------------------------//
// PARRAFO  (spacing, indents, tab stops, borders, shading, keep-together)
//
// Everything here exists in doc.format.paragraph; none of it had a UI.
//
// There is NO read-back for paragraph properties in this build (format.get is an
// unsupported operation, and extract only returns text), so the dialog cannot
// show what the paragraph currently has. That makes "apply everything on the
// form" dangerous: it would silently reset whatever the user did not look at -
// the same trap page setup used to fall into. So each GROUP is applied only if
// something in it was touched this time round.

const PARA_GROUPS = {
    paSpacing : [ 'paBefore', 'paAfter', 'paLine' ],
    paIndent  : [ 'paLeft', 'paRight', 'paSpecial', 'paSpecialBy' ],
    paKeep    : [ 'paKeepNext', 'paKeepLines' ],
    paShading : [ 'paShade' ],
    paBorder  : [ 'paBorderSide', 'paBorderStyle', 'paBorderSize', 'paBorderColor' ],
    paTabs    : [ 'paTabPos', 'paTabAlign' ],
    paList    : [ 'paListLevel', 'paListFormat' ]
};

// What each numbering format's marker looks like. `lvlText` is required whenever
// numFmt is set - "%1" is "the number for level 1".
const LIST_LVL_TEXT = '%1.';

let paraTouched = new Set();

// pt -> twentieths of a point, and cm -> twips (1 inch = 1440 twips).
function ptToTwips( v ) { return Math.round( ( v || 0 ) * 20 ); }
function cmToTwips( v ) { return Math.round( ( v || 0 ) * 1440 / CM_PER_IN ); }

function openParagraph()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    paraTouched = new Set();
    syncParagraphRows();
    setBackdrop( 'paraBackdrop', true );
}

// "Primera línea" / "Francesa" need an amount; "Ninguna" does not. Same
// row-hiding idiom Calc's number-format dialog uses.
function syncParagraphRows()
{
    const sp = document.getElementById( 'paSpecial' ).value;
    document.getElementById( 'paSpecialByField' ).hidden = sp === 'none';

    const side = document.getElementById( 'paBorderSide' ).value;
    document.getElementById( 'paBorderHow' ).hidden = side === 'none';
}

function markParagraphTouched( id )
{
    for( const g in PARA_GROUPS ) if( PARA_GROUPS[ g ].indexOf( id ) >= 0 ) paraTouched.add( g );
}

async function confirmParagraph()
{
    setBackdrop( 'paraBackdrop', false );

    if( ! paraTouched.size ) return;   // nothing was touched: change nothing

    const val = function( id ) { return document.getElementById( id ).value; };
    const on  = function( id ) { return document.getElementById( id ).checked; };

    try
    {
        const doc = sd.activeEditor.doc;
        const sel = await doc.selection.current( { includeText: false } );
        const blk = ( await doc.extract( { target: sel.selectionTarget } ) ).blocks[ 0 ];

        if( ! blk ) { NayiveUI.toast( NayiveUI.t( 'write.selectTextFirst' ) ); return; }

        const target = { kind: 'block', nodeType: blk.type, nodeId: blk.nodeId };
        const P      = doc.format.paragraph;

        if( paraTouched.has( 'paSpacing' ) )
        {
            const mult = parseFloat( String( val( 'paLine' ) ).replace( ',', '.' ) ) || 1;

            // `line` is in twentieths of a point and `lineRule` is REQUIRED
            // whenever it is given; 240 twips is one single-spaced line.
            await P.setSpacing( { target: target,
                                  before  : ptToTwips( parseFloat( String( val( 'paBefore' ) ).replace( ',', '.' ) ) ),
                                  after   : ptToTwips( parseFloat( String( val( 'paAfter'  ) ).replace( ',', '.' ) ) ),
                                  line    : Math.round( mult * 240 ),
                                  lineRule: 'auto' } );
        }

        if( paraTouched.has( 'paIndent' ) )
        {
            const special = val( 'paSpecial' );
            const by      = cmToTwips( parseCm( val( 'paSpecialBy' ), 20 ) ?? 0 );

            // firstLine and hanging are mutually exclusive - sending both throws.
            const ind = { target: target,
                          left : cmToTwips( parseCm( val( 'paLeft'  ), 20 ) ?? 0 ),
                          right: cmToTwips( parseCm( val( 'paRight' ), 20 ) ?? 0 ) };

            if( special === 'first'   ) ind.firstLine = by;
            if( special === 'hanging' ) ind.hanging   = by;

            await P.setIndentation( ind );
        }

        if( paraTouched.has( 'paKeep' ) )
            await P.setKeepOptions( { target: target, keepNext: on( 'paKeepNext' ), keepLines: on( 'paKeepLines' ) } );

        if( paraTouched.has( 'paShading' ) )
        {
            const fill = val( 'paShade' ).replace( '#', '' ).toUpperCase();
            await P.setShading( { target: target, fill: fill } );
        }

        if( paraTouched.has( 'paBorder' ) )
        {
            const side = val( 'paBorderSide' );

            // setBorder takes ONE side per call: { target, side, style, color, size, space }.
            if( side === 'none' )
            {
                await P.clearBorder( { target: target } );
            }
            else
            {
                const sides = side === 'all' ? [ 'top', 'bottom', 'left', 'right' ] : [ side ];

                for( const one of sides )
                    await P.setBorder( { target: target, side: one,
                                         style: val( 'paBorderStyle' ),
                                         color: val( 'paBorderColor' ).replace( '#', '' ).toUpperCase(),
                                         size : Math.round( parseFloat( val( 'paBorderSize' ) ) * 8 ) } );   // eighths of a point
            }
        }

        if( paraTouched.has( 'paList' ) )
        {
            // Only meaningful inside a list; the level comes from the dialog so
            // an outer level can be restyled without moving the caret.
            const items = ( await doc.lists.list( {} ) ).items || [];
            const item  = items.find( function( i ) { return i.address.nodeId === blk.nodeId; } ) || items[ 0 ];

            if( ! item ) NayiveUI.toast( NayiveUI.t( 'write.notInList' ) );
            else
            {
                // No "start at" here on purpose: doc.lists.setLevelStart reports
                // success in this build and changes nothing - neither the marker
                // nor numbering.xml's w:start. A control that lies is worse than
                // no control.
                await doc.lists.setLevelNumbering( { target: item.address,
                                                     level : parseInt( val( 'paListLevel' ), 10 ) - 1,
                                                     numFmt: val( 'paListFormat' ), lvlText: LIST_LVL_TEXT } );
            }
        }

        if( paraTouched.has( 'paTabs' ) )
        {
            const pos = parseCm( val( 'paTabPos' ), 50 );

            if( pos === null || pos <= 0 ) await P.clearAllTabStops( { target: target } );
            else await P.setTabStop( { target: target, position: cmToTwips( pos ), alignment: val( 'paTabAlign' ) } );
        }

        focusEditor();
    }
    catch( e )
    {
        console.error( 'Write: paragraph', e );
        NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) );
    }
}

//----------------------------------------------------------------------------//
// ESTADISTICAS  (word count)
//
// Read when the dialog opens, not live: SuperDoc's `editor-update` is only a
// "something changed" ping with no payload, so a live counter would mean
// re-reading the whole document on every keystroke.
//
// doc.getText() is NOT usable here: it concatenates the blocks with no
// separator, so the last word of one paragraph and the first of the next become
// one word ("seis" + "siete" -> "seissiete"). doc.extract({}) returns the blocks
// one by one, which also gives an honest paragraph count.
//
// Body only - headers, footers and footnotes are not in it. That matches what
// people mean by a word count.

// The page total arrives on its own event; cache it so the dialog opens at once.
let pageTotal = 1;

async function openStats()
{
    if( ! ready || ! sd ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    const set = function( id, n ) { document.getElementById( id ).textContent = fmtCount( n ); };

    // Show the dialog at once with the page count we already have, and fill the
    // rest in after - reading the document is a worker round trip.
    set( 'stPages', pageTotal );
    for( const id of [ 'stWords', 'stChars', 'stCharsNs', 'stParas' ] )
        document.getElementById( id ).textContent = '…';

    setBackdrop( 'statsBackdrop', true );

    let blocks;
    try { blocks = ( await sd.activeEditor.doc.extract( {} ) ).blocks || []; }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); return; }

    let words = 0, chars = 0, noSpaces = 0, paras = 0;

    for( const b of blocks )
    {
        const t = ( b && b.text ) || '';

        chars    += t.length;
        noSpaces += t.replace( /\s/g, '' ).length;

        const trimmed = t.trim();
        if( ! trimmed ) continue;

        paras += 1;
        words += trimmed.split( /\s+/ ).length;
    }

    set( 'stWords',   words );
    set( 'stChars',   chars );
    set( 'stCharsNs', noSpaces );
    set( 'stParas',   paras );

    try { pageTotal = sd.activeEditor.host.getPageMetricsSnapshot().pages.length; } catch( _ ) {}
    set( 'stPages', pageTotal );
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

const IS_MAC = /Mac|iPhone|iPad|iPod/.test( navigator.platform || navigator.userAgent || '' );

function kMod() { return IS_MAC ? '⌘' : NayiveUI.t( 'ui.keyCtrl' ); }
function kAlt() { return IS_MAC ? '⌥' : NayiveUI.t( 'ui.keyAlt'  ); }
function combo( parts ) { return parts.join( IS_MAC ? '' : '+' ); }

function modOnly( e )
{
    return ( IS_MAC ? ( e.metaKey && ! e.ctrlKey ) : ( e.ctrlKey && ! e.metaKey ) )
           && ! e.altKey && ! e.shiftKey;
}

function modAlt( e )
{
    return ( IS_MAC ? e.metaKey : e.ctrlKey ) && e.altKey && ! e.shiftKey;
}

const SHORTCUTS = [
    { el: 'saveAsBtn', key: 'write.sc.save',   label: () => combo( [ kMod(), 'S' ] ),
      match: e => modOnly( e ) && e.code === 'KeyS', run: saveNow },

    { el: 'printBtn',  key: 'write.print',     label: () => combo( [ kMod(), 'P' ] ),
      match: e => modOnly( e ) && e.code === 'KeyP', run: () => printDocument( false ) },

    { el: 'openBtn',   key: 'ui.openDoc',      label: () => combo( [ kMod(), 'O' ] ),
      match: e => modOnly( e ) && e.code === 'KeyO' },

    { el: 'newBtn',    key: 'write.newDoc',    label: () => combo( [ kAlt(), 'N' ] ),
      match: e => e.altKey && ! e.ctrlKey && ! e.metaKey && ! e.shiftKey && e.code === 'KeyN' },

    { key: 'write.sc.link',    label: () => combo( [ kMod(), 'K' ] ),
      match: e => modOnly( e ) && e.code === 'KeyK', run: () => clickToolbarItem( 'btn-link' ) },

    { key: 'write.sc.find',    label: () => combo( [ kMod(), 'F' ] ),
      match: e => modOnly( e ) && e.code === 'KeyF', run: () => clickToolbarItem( 'btn-search' ) },

    { key: 'write.sc.replace', label: () => combo( [ kMod(), 'H' ] ),
      match: e => modOnly( e ) && e.code === 'KeyH', run: () => clickToolbarItem( 'btn-search' ) },

    { key: 'write.sc.alignLeft',    label: () => combo( [ kMod(), 'L' ] ),
      match: e => modOnly( e ) && e.code === 'KeyL', run: () => runSdCommand( 'text-align', 'left' ) },
    { key: 'write.sc.alignCenter',  label: () => combo( [ kMod(), 'E' ] ),
      match: e => modOnly( e ) && e.code === 'KeyE', run: () => runSdCommand( 'text-align', 'center' ) },
    { key: 'write.sc.alignRight',   label: () => combo( [ kMod(), 'R' ] ),
      match: e => modOnly( e ) && e.code === 'KeyR', run: () => runSdCommand( 'text-align', 'right' ) },
    { key: 'write.sc.alignJustify', label: () => combo( [ kMod(), 'J' ] ),
      match: e => modOnly( e ) && e.code === 'KeyJ', run: () => runSdCommand( 'text-align', 'justify' ) },

    { key: 'write.sc.normal',   label: () => combo( [ kMod(), kAlt(), '0' ] ),
      match: e => modAlt( e ) && e.code === 'Digit0', run: () => setParagraphStyle( 'Normal' ) },
    { key: 'write.sc.heading1', label: () => combo( [ kMod(), kAlt(), '1' ] ),
      match: e => modAlt( e ) && e.code === 'Digit1', run: () => setParagraphStyle( 'Heading1' ) },
    { key: 'write.sc.heading2', label: () => combo( [ kMod(), kAlt(), '2' ] ),
      match: e => modAlt( e ) && e.code === 'Digit2', run: () => setParagraphStyle( 'Heading2' ) },
    { key: 'write.sc.heading3', label: () => combo( [ kMod(), kAlt(), '3' ] ),
      match: e => modAlt( e ) && e.code === 'Digit3', run: () => setParagraphStyle( 'Heading3' ) },

    { el: 'settingsBtn', key: 'ui.settings', label: () => combo( [ kMod(), ',' ] ),
      match: e => modOnly( e ) && e.code === 'Comma' }
];

// Click a SuperDoc toolbar item the way a person would. SuperDoc wraps each item
// in a div; the clickable node inside it is what carries the handler.
function clickToolbarItem( name )
{
    const ctn = document.querySelector( '#toolbar [data-item="' + name + '"]' );
    if( ! ctn ) return;

    ( ctn.querySelector( 'button' ) || ctn )
        .dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, view: window } ) );
}

// Heading 1/2/3 and back to Normal. The obvious route - SuperDoc's `linked-style`
// command - silently does nothing when handed a style name, and the doc API wants
// a BLOCK target (kind/nodeType/nodeId), not the selection target every other call
// takes. So: read the caret's block, then set the style by its id.
async function setParagraphStyle( styleId )
{
    if( ! ready || ! sd ) return;

    try
    {
        const doc = sd.activeEditor.doc;
        const sel = await doc.selection.current( { includeText: false } );
        const blk = ( await doc.extract( { target: sel.selectionTarget } ) ).blocks[ 0 ];

        if( ! blk ) return;

        await doc.styles.paragraph.setStyle(
            { target: { kind: 'block', nodeType: blk.type, nodeId: blk.nodeId }, styleId: styleId } );

        focusEditor();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
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

    if( document.querySelector( '.sheet-backdrop.open' ) ) return;
    if( inOwnField( e.target ) ) return;

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
// SuperDoc ships no print API, so this is the browser's own dialog over the
// @media print block in index.html. Two things have to happen first:
//
//   1. zoom back to 100 %. The zoom is a transform on the page's wrapper, and a
//      phone opens at ~46 % - printing that would shrink the paper to a third.
//   2. leave header/footer edit mode, or its overlay prints with the document.
//
// "Guardar como PDF" is the SAME dialog: everything here is client-side, there
// is no converter to call, and the browser's print dialog already writes a very
// good PDF. The only difference is a line telling you where to pick it.

let zoomBeforePrint = null;

// The printed sheet has to be the DOCUMENT's page, not the printer's default.
// Without this the browser prints on Letter (8.5 x 11 in), an A4 page is taller
// than that, and every single page of the document spills onto two sheets - the
// bug this was caught doing: a 2-page document came out as a 4-page PDF.
// Read the real page box (it already reflects size AND orientation) and write it
// into an @page rule just before printing.
function applyPrintPageSize()
{
    let css = '@page { margin: 0; }';

    try
    {
        const base = sd.activeEditor.host.getPageMetricsSnapshot().pages[ 0 ].base;

        if( base && base.widthPx && base.heightPx )
        {
            // getPageMetricsSnapshot reports CSS pixels, and 96 px is one CSS inch
            // by definition. The sheet and the page box are written from the SAME
            // rounded numbers on purpose: a page box even a fraction taller than
            // the sheet spills a sliver onto an extra sheet, and the PDF comes out
            // one page too long (a 4-page document printed as 5 before this).
            const w = ( base.widthPx  / 96 ).toFixed( 6 ) + 'in';
            const h = ( base.heightPx / 96 ).toFixed( 6 ) + 'in';

            css = '@page { size: ' + w + ' ' + h + '; margin: 0; }\n' +
                  '@media print { #editor .superdoc-page {' +
                  ' box-sizing: border-box !important;' +
                  ' width: ' + w + ' !important; height: ' + h + ' !important;' +
                  ' max-height: ' + h + ' !important; } }';
        }
    }
    catch( _ ) { /* fall back to the plain margin:0 rule */ }

    let el = document.getElementById( 'printPageSize' );
    if( ! el ) { el = document.createElement( 'style' ); el.id = 'printPageSize'; document.head.appendChild( el ); }
    el.textContent = css;
}

async function preparePrint()
{
    if( ! ready || ! sd ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return false; }

    // leave header/footer editing if we are in it
    const exit = document.querySelector( '#editor [data-sd-hf-exit]' );
    if( exit ) exit.dispatchEvent( new PointerEvent( 'pointerdown', { bubbles: true, cancelable: true } ) );

    try
    {
        const z = sd.activeEditor.host.getPageMetricsSnapshot().zoom;
        zoomBeforePrint = z && z.percent;

        if( zoomBeforePrint && zoomBeforePrint !== 100 )
        {
            await sd.ui.commands.executeAsync( 'zoom', 100 );
            await new Promise( function( r ) { setTimeout( r, 400 ); } );   // let the relayout land
        }
    }
    catch( _ ) { zoomBeforePrint = null; }

    applyPrintPageSize();   // after the zoom reset: the metrics are read at 100 %

    return true;
}

// Put the zoom back. 'afterprint' fires on cancel too, which is what we want.
function restoreZoom()
{
    if( ! zoomBeforePrint || zoomBeforePrint === 100 ) { zoomBeforePrint = null; return; }

    const z = zoomBeforePrint;
    zoomBeforePrint = null;
    try { sd.ui.commands.executeAsync( 'zoom', z ); } catch( _ ) {}
}

async function printDocument( pdfHint )
{
    if( ! ( await preparePrint() ) ) return;

    if( pdfHint ) NayiveUI.toast( NayiveUI.t( 'write.pdfHint' ), { ms: 5000 } );

    // A tick, so the toast paints before the modal print dialog freezes the page.
    setTimeout( function() { window.print(); }, pdfHint ? 350 : 0 );
}

//----------------------------------------------------------------------------//
// SUPERDOC IN SPANISH (and the other six)
//
// Every string SuperDoc paints is hard-coded English, which made a Spanish app
// with an English toolbar. Three separate hooks fix three separate surfaces:
//
//   ui.toolbar.texts        the toolbar tooltips + the table-options menu
//   ui.search.strings       the find / replace bar
//   ui.contextMenu.menuProvider   the right-click menu (it has no string table,
//                           so the labels are rewritten on the way out)
//
// Two things stay English and cannot be fixed from here: the loading overlay
// ("Opening document...") — its normalizer ignores any texts we pass — and the
// per-item `aria-label`s, which are baked into each item's definition. Both are
// SuperDoc-internal; changing them would mean forking the vendored bundle.

// Toolbar item name -> our key. SuperDoc's own key list is longer; these are the
// items this app actually builds.
const TB_TEXT_KEYS = [ 'bold', 'italic', 'underline', 'strikethrough', 'color', 'highlight',
                       'fontFamily', 'fontSize', 'link', 'image', 'table', 'tableActions',
                       'textAlign', 'bulletList', 'numberedList', 'indentLeft', 'indentRight',
                       'lineHeight', 'linkedStyles', 'formatText', 'copyFormat', 'clearFormatting',
                       'search', 'undo', 'redo', 'zoom', 'formattingMarks', 'tableOfContents',
                       'pageBreak', 'trackChangesAccept', 'trackChangesReject',
                       'addRowBefore', 'addRowAfter', 'addColumnBefore', 'addColumnAfter',
                       'deleteRow', 'deleteColumn', 'deleteTable', 'mergeCells', 'splitCell',
                       'fixTables' ];

const FIND_TEXT_KEYS = [ 'findPlaceholder', 'replacePlaceholder', 'noResults',
                         'previousMatchTitle', 'nextMatchTitle', 'closeTitle',
                         'replace', 'replaceAll', 'toggleReplaceTitle',
                         'matchCase', 'ignoreDiacritics', 'regex', 'invalidPattern' ];

function textsFrom( keys, prefix )
{
    const out = {};
    for( const k of keys ) out[ k ] = NayiveUI.t( prefix + k );
    return out;
}

// The context menu carries no string table, so match on what SuperDoc wrote:
// first the item id, then - for items whose id we have not seen - the English
// label. Anything unmatched is left exactly as it was.
const CM_BY_ID = {
    'cut': 'cut', 'copy': 'copy', 'paste': 'paste', 'undo': 'undo', 'redo': 'redo',
    'insert-link': 'insertLink', 'insert-table': 'insertTable', 'insert-footnote': 'insertFootnote',
    'insert-text': 'insertText', 'comment': 'comment', 'add-comment': 'comment',
    'accept-change': 'acceptChange', 'reject-change': 'rejectChange',
    'update-toc': 'updateToc', 'edit-table': 'editTable',
    'table-properties': 'tableProperties', 'cell-background': 'cellBackground',
    'restart-numbering': 'restartNumbering', 'continue-numbering': 'continueNumbering',
    'increase-indent': 'increaseIndent', 'decrease-indent': 'decreaseIndent'
};

const CM_BY_LABEL = {
    'cut': 'cut', 'copy': 'copy', 'paste': 'paste', 'undo': 'undo', 'redo': 'redo',
    'insert link': 'insertLink', 'insert table': 'insertTable', 'insert footnote': 'insertFootnote',
    'insert text': 'insertText', 'comment': 'comment',
    'accept change': 'acceptChange', 'reject change': 'rejectChange',
    'update table of contents': 'updateToc', 'edit table': 'editTable',
    'table properties': 'tableProperties', 'table properties…': 'tableProperties',
    'cell background': 'cellBackground',
    'restart numbering': 'restartNumbering', 'continue numbering': 'continueNumbering',
    'increase indent': 'increaseIndent', 'decrease indent': 'decreaseIndent'
};

function localizeMenu( sections )
{
    if( ! Array.isArray( sections ) ) return sections;

    for( const sec of sections )
    {
        const items = ( sec && sec.items ) || [];

        for( const it of items )
        {
            if( ! it ) continue;

            const suffix = CM_BY_ID[ it.id ] ||
                           CM_BY_LABEL[ String( it.label || '' ).trim().toLowerCase() ];

            if( suffix ) it.label = NayiveUI.t( 'write.cm.' + suffix );

            if( Array.isArray( it.items ) ) localizeMenu( [ { items: it.items } ] );
        }
    }

    return sections;
}

//----------------------------------------------------------------------------//
// EDITOR EXTRAS - page break, super/subscript, footnote, table of contents,
// formatting marks
//
// SuperDoc ships no toolbar button for any of these, but every command exists:
// the structural / footnote session handles for the first two, doc.format for
// vertAlign, and SuperDoc's own controller registry for the last two. They are
// added through `customItems` (the same route as the table-borders button) and
// placed by CSS `order` in index.html.

function sdEditing()
{
    try { return sd.activeEditor.host.getHandles().editing; } catch( _ ) { return null; }
}

async function insertPageBreak()
{
    const ed = ready && sdEditing();
    if( ! ed ) return;

    try { await ed.structural.insertPageBreakAtSelection(); focusEditor(); }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

async function insertFootnote()
{
    const ed = ready && sdEditing();
    if( ! ed ) return;

    try
    {
        if( ! ( await ed.footnotes.canInsertFootnote() ) )
        { NayiveUI.toast( NayiveUI.t( 'write.noFootnoteHere' ) ); return; }

        await ed.footnotes.insertFootnoteAtSelection( { type: 'footnote' } );
        focusEditor();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

// vertAlign cannot be read back in this build (format.get is an unsupported
// operation), so a SECOND click on the same selection is what turns it off:
// the value we last applied is remembered against a signature of the selection
// it went to, and a repeat of the same pair sends 'baseline' instead.
let lastVert = { sig: null, value: null };

async function setVertAlign( want )
{
    if( ! ready || ! sd ) return;

    try
    {
        const sel = await sd.activeEditor.doc.selection.current( { includeText: false } );

        // A collapsed caret takes the format without complaining and nothing
        // visible happens - say so instead of looking broken.
        if( ! sel || sel.empty ) { NayiveUI.toast( NayiveUI.t( 'write.selectTextFirst' ) ); return; }

        const sig   = JSON.stringify( sel.selectionTarget );
        const value = ( lastVert.sig === sig && lastVert.value === want ) ? 'baseline' : want;

        await sd.activeEditor.doc.format.vertAlign( { value: value, target: sel.selectionTarget } );

        lastVert = { sig: sig, value: value };
        focusEditor();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

// SuperDoc's own controller registry, for commands it knows but builds no
// button for (table of contents, formatting marks) and for the ones the
// keyboard shortcuts drive (text-align).
async function runSdCommand( id, arg )
{
    if( ! ready || ! sd ) return;

    try { await sd.ui.commands.executeAsync( id, arg ); focusEditor(); }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

// Suggesting mode is offered in Settings, so the accept / reject buttons have to
// be reachable - but they are noise in a document nobody is reviewing. They are
// built every time now and CSS hides them unless the mode is 'suggesting'.
function applyModeChrome( mode )
{
    document.getElementById( 'toolbarRow' ).classList.toggle( 'is-suggesting', mode === 'suggesting' );
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
// real button in #writeTools (`el`), or issues the same SuperDoc controller
// command the toolbar item issues (`cmd`), or calls the very function the button
// is wired to (`run`). So there is still one set of handlers, exactly as the
// phone's "..." menu does it (buildTopMenu above).
//
// Menu mode collapses #toolbarRow to height 0 with visibility:hidden - never
// display:none. SuperDoc watches #toolbar's width and re-measures on every
// change, and Ctrl+F / SHORTCUTS still reach the invisible items by click (the
// find bar itself renders in SuperDoc's floating surface at body level, so it is
// visible either way).
//
// Ticks and greying are read from SuperDoc at the moment a panel opens -
// `sd.ui.commands.get( id ).getState()` is synchronous and returns
// { enabled, active, value } - so a panel is built fresh on every open and
// nothing has to be kept in sync.
//
// THE MACHINERY IS NOT HERE. The bar, the panels, the hover-to-slide behaviour
// and the toolbar/menus switch all live in shared/menubar.js, which Calc uses
// too; the item vocabulary is documented at the top of that file. What is left
// below is Write's own: the table of menus, and the four small hooks that read
// and drive SuperDoc.

//---- the table ------------------------------------------------------------//
//
// One entry per menu. An item is:
//
//   { key }                   label (an i18n key)
//   { el:'saveAsBtn' }        click that button - and grey the entry out when
//                             the button itself is disabled
//   { cmd:'bold', arg }       sd.ui.commands.executeAsync( cmd, arg )
//   { run: fn }               call it
//   { sub: [...] | fn }       a submenu (a function is called at open time)
//   { sep: true }             a hairline
//   { check:'active' }        tick when getState().active
//   { check:'value' }         tick when getState().value is truthy (a toggle)
//   { radio: v }             tick when getState().value === v
//   { checked: fn }           tick when fn() says so
//   { enabled: fn }           grey out when fn() says no
//   { sc:'write.sc.save' }    show that SHORTCUTS entry's key combo on the right
//   { swatch:'#c00' }         a colour chip before the label
//   { iconOf: sdIcon('bold') } the glyph before the label, cloned from the
//                             toolbar (an `el` entry gets its button's by itself)
//   { icon:'cut' }            ... or a NayiveUI.icon() name, for no-button entries

const MENU_FONTS  = [ 'Arial', 'Calibri', 'Cambria', 'Courier New', 'Georgia',
                      'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana' ];
const MENU_SIZES  = [ '8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36', '48', '72' ];
const MENU_ZOOMS  = [ 50, 75, 100, 125, 150, 200 ];
const MENU_LINES  = [ 1, 1.15, 1.5, 2 ];
const MENU_GRIDS  = [ [ 2, 2 ], [ 2, 3 ], [ 3, 3 ], [ 4, 4 ], [ 5, 5 ] ];

// Word's own first row of text colours, plus white. The names are keys because
// no interface string lives in the source (docs/i18n.md).
const MENU_COLORS = [ [ '#000000', 'black'  ], [ '#808080', 'gray'   ], [ '#C00000', 'red'    ],
                      [ '#E36C0A', 'orange' ], [ '#FFC000', 'yellow' ], [ '#00B050', 'green'  ],
                      [ '#0070C0', 'blue'   ], [ '#7030A0', 'purple' ], [ '#FFFFFF', 'white'  ] ];

const MENU_MARKS  = [ [ '#FFFF00', 'yellow' ], [ '#00FF00', 'green'  ], [ '#00FFFF', 'cyan'   ],
                      [ '#FF66FF', 'pink'   ], [ '#FF9900', 'orange' ], [ '#BFBFBF', 'gray'   ] ];

function fontItems()
{
    return MENU_FONTS.map( function( f )
    {
        return { text: f, cmd: 'font-family', arg: f, radio: f };
    } );
}

function sizeItems()
{
    return MENU_SIZES.map( function( s )
    {
        return { text: s, cmd: 'font-size', arg: s, radio: s };
    } );
}

function colorItems( cmd, table, noneKey )
{
    const out = table.map( function( c )
    {
        return { key: 'ui.color.' + c[1], swatch: c[0], cmd: cmd, arg: c[0], radio: c[0] };
    } );

    if( noneKey ) out.push( { sep: true }, { key: noneKey, cmd: cmd, arg: null } );

    return out;
}

function zoomItems()
{
    const out = MENU_ZOOMS.map( function( z )
    {
        return { text: z + ' %', cmd: 'zoom', arg: z, radio: z };
    } );

    out.push( { sep: true }, { key: 'write.zoomFitWidth', cmd: 'zoom-fit-width' } );

    return out;
}

function gridItems()
{
    return MENU_GRIDS.map( function( g )
    {
        return { text: g[0] + ' × ' + g[1],
                 run: function() { runSdCommand( 'table-insert', { rows: g[0], cols: g[1] } ); } };
    } );
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
        { key: 'ui.undo', cmd: 'undo', iconOf: sdIcon( 'undo' ) },
        { key: 'ui.redo', cmd: 'redo', iconOf: sdIcon( 'redo' ) },
        { sep: true },
        { key: 'ui.cut',   run: clipCut,   icon: 'cut'   },
        { key: 'ui.copy',  run: clipCopy,  icon: 'copy'  },
        { key: 'ui.paste', run: clipPaste, icon: 'paste' },
        { sep: true },
        { key: 'write.sc.find',    run: function() { clickToolbarItem( 'btn-search' ); }, sc: 'write.sc.find',    iconOf: sdIcon( 'search' ) },
        { key: 'write.sc.replace', run: function() { clickToolbarItem( 'btn-search' ); }, sc: 'write.sc.replace', iconOf: sdIcon( 'search' ) }
    ]
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
        { key: 'write.showRuler',       cmd: 'ruler',            check: 'value' },
        { key: 'write.formattingMarks', cmd: 'formatting-marks', check: 'value', iconOf: sdIcon( 'showMarks' ) },
        { key: 'write.comments',        el:  'commentsBtn',      checked: function() { return commentsOn; } },
        { sep: true },
        { key: 'write.header', el: 'headerBtn' },
        { key: 'write.footer', el: 'footerBtn' },
        { sep: true },
        { key: 'write.tb.zoom', sub: zoomItems },
        { key: 'write.mode', sub:
            [ { key: 'write.modeEdit',    run: function() { setDocMode( 'editing'    ); }, checked: function() { return docMode() === 'editing';    } },
              { key: 'write.modeSuggest', run: function() { setDocMode( 'suggesting' ); }, checked: function() { return docMode() === 'suggesting'; } },
              { key: 'write.modeRead',    run: function() { setDocMode( 'viewing'    ); }, checked: function() { return docMode() === 'viewing';    } } ] }
    ]
},
{
    key: 'ui.menu.insert',
    items:
    [
        { key: 'write.pageBreak',  run: insertPageBreak, iconOf: sdIcon( 'pageBreak' ) },
        { key: 'write.pageNumber', el:  'pageNumBtn' },
        { sep: true },
        { key: 'write.tb.image', run: pickImage,  iconOf: sdIcon( 'image' ) },
        { key: 'write.tb.table', sub: gridItems,  iconOf: sdIcon( 'table' ) },
        { key: 'write.sc.link',  run: openLinkDialog, sc: 'write.sc.link', iconOf: sdIcon( 'link' ) },
        { sep: true },
        { key: 'write.footnote', run: insertFootnote,                  iconOf: sdIcon( 'footNote' )  },
        { key: 'write.toc',      cmd: 'table-of-contents-insert',      iconOf: sdIcon( 'insertToc' ) },
        { key: 'write.symbols',  run: openSymbols,                     iconOf: sdIcon( 'symbols' )   }
    ]
},
{
    key: 'ui.menu.format',
    items:
    [
        { key: 'write.tb.bold',          cmd: 'bold',          check: 'active', iconOf: sdIcon( 'bold' )      },
        { key: 'write.tb.italic',        cmd: 'italic',        check: 'active', iconOf: sdIcon( 'italic' )    },
        { key: 'write.tb.underline',     cmd: 'underline',     check: 'active', iconOf: sdIcon( 'underline' ) },
        { key: 'write.tb.strikethrough', cmd: 'strikethrough', check: 'active', iconOf: sdIcon( 'strike' )    },
        { key: 'write.superscript', run: function() { setVertAlign( 'superscript' ); }, iconOf: sdIcon( 'superScript' ) },
        { key: 'write.subscript',   run: function() { setVertAlign( 'subscript'   ); }, iconOf: sdIcon( 'subScript' )   },
        { sep: true },
        { key: 'write.tb.fontFamily', sub: fontItems },
        { key: 'write.tb.fontSize',   sub: sizeItems },
        { key: 'write.tb.color',      sub: function() { return colorItems( 'text-color', MENU_COLORS, null ); },                     iconOf: sdIcon( 'color' )     },
        { key: 'write.tb.highlight',  sub: function() { return colorItems( 'highlight-color', MENU_MARKS, 'write.noHighlight' ); }, iconOf: sdIcon( 'highlight' ) },
        { sep: true },
        { key: 'write.tb.linkedStyles', iconOf: sdIcon( 'linkedStyles' ), sub:
            [ { key: 'write.sc.normal',   cmd: 'linked-style', arg: 'Normal',   radio: 'Normal',   sc: 'write.sc.normal'   },
              { key: 'write.sc.heading1', cmd: 'linked-style', arg: 'Heading1', radio: 'Heading1', sc: 'write.sc.heading1' },
              { key: 'write.sc.heading2', cmd: 'linked-style', arg: 'Heading2', radio: 'Heading2', sc: 'write.sc.heading2' },
              { key: 'write.sc.heading3', cmd: 'linked-style', arg: 'Heading3', radio: 'Heading3', sc: 'write.sc.heading3' } ] },
        { key: 'write.tb.textAlign', iconOf: sdIcon( 'textAlign' ), sub:
            [ { key: 'write.sc.alignLeft',    cmd: 'text-align', arg: 'left',    radio: 'left',    sc: 'write.sc.alignLeft'    },
              { key: 'write.sc.alignCenter',  cmd: 'text-align', arg: 'center',  radio: 'center',  sc: 'write.sc.alignCenter'  },
              { key: 'write.sc.alignRight',   cmd: 'text-align', arg: 'right',   radio: 'right',   sc: 'write.sc.alignRight'   },
              { key: 'write.sc.alignJustify', cmd: 'text-align', arg: 'justify', radio: 'justify', sc: 'write.sc.alignJustify' } ] },
        // line-height wants a NUMBER; the string form comes back NO_OP.
        { key: 'write.tb.lineHeight', iconOf: sdIcon( 'lineHeight' ), sub: MENU_LINES.map( function( n )
            { return { text: String( n ).replace( '.', ',' ), cmd: 'line-height', arg: n }; } ) },
        { sep: true },
        { key: 'write.tb.bulletList',   cmd: 'bullet-list',   check: 'active', iconOf: sdIcon( 'list' )         },
        { key: 'write.tb.numberedList', cmd: 'numbered-list', check: 'active', iconOf: sdIcon( 'numberedlist' ) },
        { key: 'write.tb.indentRight',  cmd: 'indent-increase',                iconOf: sdIcon( 'indentright' )  },
        { key: 'write.tb.indentLeft',   cmd: 'indent-decrease',                iconOf: sdIcon( 'indentleft' )   },
        { sep: true },
        { key: 'write.paragraph',        el:  'paraBtn' },
        { key: 'write.tb.copyFormat',    cmd: 'copy-format', check: 'active', iconOf: sdIcon( 'copyFormat' )      },
        { key: 'write.tb.clearFormatting', cmd: 'clear-formatting',          iconOf: sdIcon( 'clearFormatting' ) }
    ]
},
{
    key: 'ui.menu.table',
    items:
    [
        { key: 'write.cm.insertTable', sub: gridItems, iconOf: sdIcon( 'table' ) },
        { sep: true },
        { key: 'write.tb.addRowBefore',    cmd: 'table-add-row-before'    },
        { key: 'write.tb.addRowAfter',     cmd: 'table-add-row-after'     },
        { key: 'write.tb.deleteRow',       cmd: 'table-delete-row'        },
        { sep: true },
        { key: 'write.tb.addColumnBefore', cmd: 'table-add-column-before' },
        { key: 'write.tb.addColumnAfter',  cmd: 'table-add-column-after'  },
        { key: 'write.tb.deleteColumn',    cmd: 'table-delete-column'     },
        { sep: true },
        { key: 'write.tb.mergeCells', cmd: 'table-merge-cells' },
        { key: 'write.tb.splitCell',  cmd: 'table-split-cell'  },
        { sep: true },
        { key: 'write.tableBorders',   run: openTableBorders, iconOf: sdIcon( 'tableBorders' ) },
        { key: 'write.tb.deleteTable', cmd: 'table-delete' }
    ]
},
{
    key: 'ui.menu.tools',
    items:
    [
        { key: 'write.stats', el: 'statsBtn' },
        { sep: true },
        { key: 'write.autocorrect', run: function() { setAutocorrect( ! autocorrectOn ); },
          checked: function() { return autocorrectOn; } },
        { sep: true },
        { key: 'write.tb.trackChangesAccept', cmd: 'track-changes-accept-selection', iconOf: sdIcon( 'acceptTrackedChangeBySelection' ) },
        { key: 'write.tb.trackChangesReject', cmd: 'track-changes-reject-selection', iconOf: sdIcon( 'rejectTrackedChangeOnSelection' ) },
        { key: 'write.acceptAll', cmd: 'acceptAllChanges', iconOf: sdIcon( 'acceptTrackedChangeBySelection' ) },
        { key: 'write.rejectAll', cmd: 'rejectAllChanges', iconOf: sdIcon( 'rejectTrackedChangeOnSelection' ) },
        { sep: true },
        { key: 'ui.settings', el: 'settingsBtn', sc: 'ui.settings' }
    ]
},
{
    key: 'ui.menu.help',
    items:
    [
        { key: 'write.shortcuts', el: 'scBtn' },
        { key: 'ui.quickGuide', run: function() { NayiveUI.showIntro(); }, iconOf: '[data-intro-open]' }
    ]
} ];

// The glyph SuperDoc draws for one of its toolbar items - its icon only, never
// the dropdown caret beside it. shared/menubar.js clones it when a panel opens,
// so a menu row shows the very icon its toolbar button shows.
function sdIcon( name ) { return '#toolbar .sd-toolbar-icon__icon--' + name + ' svg'; }

//---- reading SuperDoc's state --------------------------------------------//

function cmdState( id )
{
    try { return sd.ui.commands.get( id ).getState() || {}; }
    catch( _ ) { return {}; }
}

function docMode() { return ( sd && sd.config && sd.config.documentMode ) || 'editing'; }

function setDocMode( mode )
{
    try { if( docMode() !== mode ) sd.setDocumentMode( mode ); }
    catch( e ) { console.error( 'Write: document mode', e ); }
}

// linked-style reports { styleId, styleName }; everything else a plain value.
function radioHit( value, want )
{
    if( value && typeof value === 'object' ) return value.styleId === want;
    return String( value ) === String( want );
}

function itemEnabled( it )
{
    if( it.cmd ) return cmdState( it.cmd ).enabled !== false;
    return undefined;                        // let shared/menubar.js decide
}

function itemChecked( it )
{
    if( ! it.cmd ) return undefined;

    const st = cmdState( it.cmd );

    if( it.radio !== undefined ) return radioHit( st.value, it.radio );
    if( it.check === 'active'  ) return !! st.active;
    if( it.check === 'value'   ) return !! st.value;

    return false;
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
    exec    : function( it ) { runSdCommand( it.cmd, it.arg ); }
} );

const CHROME = NayiveMenus.chrome(
{
    key   : 'nayive-write-chrome',
    menus : MENUBAR,
    load  : async function() { return ( await readWriteCfg() ).chrome; },
    save  : function( mode ) { return writeWriteCfg( { chrome: mode } ); },

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

//---- the entries the toolbar has no button for ---------------------------//

// Insertar > Imagen. The toolbar's own image button is unreachable with the
// strip collapsed, so the menu picks the file and hands the engine a data URL -
// through fileToDataUrl, which is the same 1600 px shrink SuperDoc's own button
// gets (handleImageUpload).
function pickImage()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    document.getElementById( 'imgInput' ).click();
}

async function insertPickedImage( file )
{
    if( ! file ) return;

    try
    {
        const src = await fileToDataUrl( file );
        const res = await sd.ui.commands.executeAsync( 'image', { src: src } );

        if( res === false || ( res && res.success === false ) ) throw new Error( 'image' );

        focusEditor();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

// Insertar > Hipervinculo. `link` takes { href } and wraps the SELECTION, so an
// empty one has nothing to turn into a link - say so instead of failing quietly.
function openLinkDialog()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    document.getElementById( 'linkHref' ).value = '';
    setBackdrop( 'linkBackdrop', true );
    setTimeout( function() { document.getElementById( 'linkHref' ).focus(); }, 50 );
}

async function confirmLink()
{
    const href = document.getElementById( 'linkHref' ).value.trim();

    setBackdrop( 'linkBackdrop', false );
    if( ! href ) return;

    try
    {
        const sel = await sd.activeEditor.doc.selection.current( { includeText: true } );

        if( ! sel || ! sel.text ) { NayiveUI.toast( NayiveUI.t( 'write.selectTextFirst' ) ); return; }

        const res = await sd.ui.commands.executeAsync( 'link', { href: href } );
        if( res === false || ( res && res.success === false ) ) throw new Error( 'link' );

        focusEditor();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

//---- Edicion > cortar / copiar / pegar ------------------------------------//
//
// The engine's own clipboard API is not built into the browser bundle
// (`clipboard.copy is not a supported v2 browser Document API operation`) and
// document.execCommand reports success while doing nothing to the document. So
// these three go through the system clipboard: the selection's TEXT out, and
// pastePlainText (which takes a bare string) back in.
//
// That means the menu entries move PLAIN TEXT. Ctrl+X / Ctrl+C / Ctrl+V and the
// right-click menu are the browser's own path and keep the formatting - the
// shortcut hint on each row points at them.

async function currentSelection()
{
    try { return await sd.activeEditor.doc.selection.current( { includeText: true } ); }
    catch( _ ) { return null; }
}

async function clipCopy( andCut )
{
    if( ! ready ) return;

    const sel = await currentSelection();

    if( ! sel || ! sel.text ) { NayiveUI.toast( NayiveUI.t( 'write.selectTextFirst' ) ); return; }

    try { await navigator.clipboard.writeText( sel.text ); }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'ui.clipboardBlocked' ) ); return; }

    if( ! andCut ) return;

    try
    {
        await sd.activeEditor.doc.delete( { target: sel.selectionTarget } );
        focusEditor();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

function clipCut() { clipCopy( true ); }

async function clipPaste()
{
    if( ! ready ) return;

    let text = '';

    try { text = await navigator.clipboard.readText(); }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'ui.clipboardBlocked' ) ); return; }

    if( ! text ) return;

    try
    {
        await sd.activeEditor.host.getHandles().editing.input.pastePlainText( text );
        focusEditor();
    }
    catch( _ ) { NayiveUI.toast( NayiveUI.t( 'write.actionFailed' ) ); }
}

//----------------------------------------------------------------------------//
// TABLE BORDERS
//
// A custom toolbar button (see the SuperDoc config) opens a Word-style border
// picker anchored under it (#tbPopup): pick a preset plus weight / line style /
// colour, then click the ✓ (the shared round accent button) — nothing touches
// the table until then. While the popup is open the pending selection lives in
// `tbDraft`; the ✓ copies it into the sticky `tbState` and issues the borders.
// The picked weight / style / colour are sticky (remembered after a successful
// apply). SuperDoc's own tableActions menu only offers "remove borders".
//
// A preset acts on the SELECTION, like Word:
//   - caret inside one cell        -> that cell's own edges
//   - several cells selected       -> the selection block; "box" is its outer
//                                     perimeter, "inside" its interior grid, etc.
//   - selection can't be resolved  -> the whole table (fallback)
// tbTarget() resolves which, then setBorders({ nodeId, mode:'edges', edges })
// is issued per target cell (so a multi-cell apply is several undo steps).

const TB_STYLE_KEY = 'nayive-write-tbstyle';

// The sticky line weight / style / colour set in the popup. `color` is stored
// without the leading '#' (setBorders() wants it that way).
const tbState = { lineStyle: 'single', lineWeightPt: 1, color: '000000' };

// The pending selection while the popup is open: a working copy of tbState plus
// the chosen preset (null = none picked yet). Seeded from tbState on open,
// committed to it by the ✓ button.
const tbDraft = { preset: null, lineStyle: 'single', lineWeightPt: 1, color: '000000' };

async function currentTableNodeId()
{
    let tables = [];
    try
    {
        const l = await sd.activeEditor.doc.tables.list();
        tables = ( l.stories || [] ).flatMap( function( s ) { return s.tables || []; } );
    }
    catch( _ ) { return null; }

    if( tables.length === 0 ) return null;
    if( tables.length === 1 ) return tables[0].tableNodeId;

    // Several tables: each rendered cell carries data-layout-fragment-id
    // "body|<n>/table/<k>/…"; the distinct "<n>/table/<k>" keys, top-to-bottom,
    // line up with tables.list()'s document order. Find the caret's.
    try
    {
        const caret = document.querySelector( '#editor .sd-v2-local-selection-caret' );
        if( ! caret ) return tables[0].tableNodeId;

        const keyOf = function( s ) { const m = ( s || '' ).match( /\|(\d+\/table\/\d+)/ ); return m ? m[1] : s; };

        const r = caret.getBoundingClientRect();
        let el  = document.elementFromPoint( r.left, r.top + r.height / 2 );
        let mine = null;
        while( el && ! mine )
        {
            const f = el.getAttribute && el.getAttribute( 'data-layout-fragment-id' );
            if( f && /\/table\//.test( f ) ) mine = keyOf( f );
            el = el.parentElement;
        }
        if( ! mine ) return tables[0].tableNodeId;

        const seen = [];
        document.querySelectorAll( '#editor [data-layout-fragment-id*="/table/"]' ).forEach( function( c )
        {
            const k = keyOf( c.getAttribute( 'data-layout-fragment-id' ) );
            const y = c.getBoundingClientRect().top;
            const hit = seen.find( function( o ) { return o.k === k; } );
            if( hit ) hit.y = Math.min( hit.y, y );
            else seen.push( { k: k, y: y } );
        } );
        seen.sort( function( a, b ) { return a.y - b.y; } );

        const idx = seen.findIndex( function( o ) { return o.k === mine; } );
        return ( tables[ idx ] || tables[0] ).tableNodeId;
    }
    catch( _ ) { return tables[0].tableNodeId; }
}

// The toolbar button's command. Toggles the popup; a click while it is open is
// let through by onTbOutside() and lands here to close it again.
async function openTableBorders()
{
    if( ! ready ) return;

    if( document.getElementById( 'tbPopup' ).classList.contains( 'open' ) ) { closeTbPopup(); return; }

    if( ! ( await tbTarget() ) ) { NayiveUI.toast( NayiveUI.t( 'write.cursorInTable' ) ); return; }

    openTbPopup();
}

// The caret's paragraph block id, read from the DOM node under the caret.
function caretBlockId()
{
    const caret = document.querySelector( '#editor .sd-v2-local-selection-caret' );
    if( ! caret ) return null;

    const r  = caret.getBoundingClientRect();
    const el = document.elementFromPoint( r.left, r.top + r.height / 2 );
    const bl = el && el.closest && el.closest( '#editor [data-sd-block-id]' );
    return bl ? bl.getAttribute( 'data-sd-block-id' ) : null;
}

// Every cell whose grid span overlaps the [start..end] rectangle.
async function cellsInRange( tableNodeId, range )
{
    const r0 = Math.min( range.start.rowIndex,    range.end.rowIndex );
    const r1 = Math.max( range.start.rowIndex,    range.end.rowIndex );
    const c0 = Math.min( range.start.columnIndex, range.end.columnIndex );
    const c1 = Math.max( range.start.columnIndex, range.end.columnIndex );

    let cells = [];
    try { cells = ( await sd.activeEditor.doc.tables.getCells( { nodeId: tableNodeId } ) ).cells || []; }
    catch( _ ) { return []; }

    const overlaps = function( start, span, lo, hi ) { return start <= hi && lo <= start + Math.max( 1, span ) - 1; };

    return cells.filter( function( c )
    {
        return overlaps( c.rowIndex, c.rowspan, r0, r1 ) && overlaps( c.columnIndex, c.colspan, c0, c1 );
    } );
}

// Resolve what the presets act on:
//   { scope:'cell',  cells:[{nodeId}] }
//   { scope:'cells', tableNodeId, cells:[{nodeId,rowIndex,columnIndex,rowspan,colspan}, …] }
//   { scope:'table', tableNodeId }
// or null when the caret is not in a table.
async function tbTarget()
{
    // 1. SuperDoc's own selection -> table context (covers multi-cell selection).
    try
    {
        const host = sd.activeEditor && sd.activeEditor.host;
        const ctx  = host && host.getTableContextAsync ? await host.getTableContextAsync() : null;

        if( ctx && ctx.inTable && ctx.table && ctx.table.nodeId )
        {
            if( ctx.cell && ctx.cell.nodeId )
                return { scope: 'cell', cells: [ { nodeId: ctx.cell.nodeId } ] };

            if( ctx.cellRange )
            {
                const cells = await cellsInRange( ctx.table.nodeId, ctx.cellRange );
                if( cells.length ) return { scope: 'cells', tableNodeId: ctx.table.nodeId, cells: cells };
            }
        }
    }
    catch( _ ) {}

    // 2. Just the caret's cell, via its DOM block id.
    try
    {
        const blockId = caretBlockId();
        if( blockId )
        {
            const ctx = await sd.activeEditor.doc.tables.contextAtSelection( { blockIds: [ blockId ] } );
            if( ctx && ctx.inTable && ctx.cell && ctx.cell.nodeId )
                return { scope: 'cell', cells: [ { nodeId: ctx.cell.nodeId } ] };
        }
    }
    catch( _ ) {}

    // 3. The whole table, located from the caret position.
    const tableNodeId = await currentTableNodeId();
    return tableNodeId ? { scope: 'table', tableNodeId: tableNodeId } : null;
}

// The sticky line style / weight / colour, as setBorders() wants them.
function tbSpec()
{
    return {
        lineStyle    : tbState.lineStyle    || 'single',
        lineWeightPt : tbState.lineWeightPt || 1,
        color        : ( tbState.color || '000000' ).replace( /^#/, '' )
    };
}

// Which of one cell's four edges a preset touches, given the selection's
// bounding box (bbox null => a lone cell, so it is on every side of itself).
// Interior lines are drawn as a cell's bottom / right edge (borders collapse,
// so one side is enough).
function borderEdgesForCell( which, cell, bbox, S )
{
    const rBot   = cell.rowIndex    + ( cell.rowspan || 1 ) - 1;
    const cRight = cell.columnIndex + ( cell.colspan || 1 ) - 1;

    const atTop    = ! bbox || cell.rowIndex    === bbox.r0;
    const atBottom = ! bbox || rBot             === bbox.r1;
    const atLeft   = ! bbox || cell.columnIndex === bbox.c0;
    const atRight  = ! bbox || cRight           === bbox.c1;

    const e = {};
    switch( which )
    {
        case 'all':     e.top = e.bottom = e.left = e.right = S;    break;
        case 'none':    e.top = e.bottom = e.left = e.right = null; break;
        case 'box':
            if( atTop )    e.top    = S;
            if( atBottom ) e.bottom = S;
            if( atLeft )   e.left   = S;
            if( atRight )  e.right  = S;
            break;
        case 'inside':
            if( ! atBottom ) e.bottom = S;
            if( ! atRight )  e.right  = S;
            break;
        case 'insideH': if( ! atBottom ) e.bottom = S; break;
        case 'insideV': if( ! atRight )  e.right  = S; break;
        case 'top':     if( atTop )    e.top    = S; break;
        case 'bottom':  if( atBottom ) e.bottom = S; break;
        case 'left':    if( atLeft )   e.left   = S; break;
        case 'right':   if( atRight )  e.right  = S; break;
    }
    return e;
}

async function applyTableBorderPreset( which )
{
    const target = await tbTarget();
    if( ! target ) { NayiveUI.toast( NayiveUI.t( 'write.cursorInTable' ) ); return; }

    if( target.scope === 'cell' && ( which === 'inside' || which === 'insideH' || which === 'insideV' ) )
    {
        NayiveUI.toast( NayiveUI.t( 'write.selectCells' ) );
        return;
    }

    const b = tbSpec();
    const S = { lineStyle: b.lineStyle, lineWeightPt: b.lineWeightPt, color: b.color };

    try
    {
        if( target.scope === 'table' )
        {
            const N = null;
            const edges = {
                all     : { top: S, bottom: S, left: S, right: S, insideH: S, insideV: S },
                box     : { top: S, bottom: S, left: S, right: S },
                inside  : { insideH: S, insideV: S },
                none    : { top: N, bottom: N, left: N, right: N, insideH: N, insideV: N },
                top     : { top: S },    bottom  : { bottom: S },
                left    : { left: S },   right   : { right: S },
                insideH : { insideH: S }, insideV : { insideV: S }
            }[ which ];

            if( edges )
                await sd.activeEditor.doc.tables.setBorders( { nodeId: target.tableNodeId, mode: 'edges', edges: edges } );
        }
        else
        {
            const cells = target.cells;

            let bbox = null;
            if( cells[0].rowIndex != null )
            {
                bbox = { r0: Infinity, r1: -Infinity, c0: Infinity, c1: -Infinity };
                for( const c of cells )
                {
                    bbox.r0 = Math.min( bbox.r0, c.rowIndex );
                    bbox.r1 = Math.max( bbox.r1, c.rowIndex    + ( c.rowspan || 1 ) - 1 );
                    bbox.c0 = Math.min( bbox.c0, c.columnIndex );
                    bbox.c1 = Math.max( bbox.c1, c.columnIndex + ( c.colspan || 1 ) - 1 );
                }
            }

            for( const c of cells )
            {
                const edges = borderEdgesForCell( which, c, bbox, S );
                if( Object.keys( edges ).length )
                    await sd.activeEditor.doc.tables.setBorders( { nodeId: c.nodeId, mode: 'edges', edges: edges } );
            }
        }

        onEdit();
        persistTbState();
    }
    catch( e )
    {
        console.error( 'Write: table borders', e );
        NayiveUI.toast( NayiveUI.t( 'write.borderFailed' ) );
    }
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
        closeTbPopup();
    } );
}

// Show the popup anchored just under the toolbar's "Bordes de tabla" button,
// clamped to stay inside the viewport.
function openTbPopup()
{
    const pop = document.getElementById( 'tbPopup' );

    // Fresh draft each time: last-used weight / style / colour, no preset yet.
    tbDraft.preset       = null;
    tbDraft.lineStyle    = tbState.lineStyle;
    tbDraft.lineWeightPt = tbState.lineWeightPt;
    tbDraft.color        = tbState.color;
    syncTbUI();

    pop.classList.add( 'open' );   // must be laid out before we can measure it

    const r  = anchorRect( '#toolbar [data-item="btn-tableBorders"]' );
    const vw = document.documentElement.clientWidth;
    let   left = Math.min( r.left, vw - pop.offsetWidth - 8 );
    if( left < 8 ) left = 8;

    pop.style.top  = ( r.bottom + 4 ) + 'px';
    pop.style.left = left + 'px';

    setTimeout( function()
    {
        document.addEventListener( 'pointerdown', onTbOutside, true );
        window.addEventListener( 'resize', closeTbPopup );
    }, 0 );
}

function closeTbPopup()
{
    document.getElementById( 'tbPopup' ).classList.remove( 'open' );
    tbDraft.preset = null;
    document.removeEventListener( 'pointerdown', onTbOutside, true );
    window.removeEventListener( 'resize', closeTbPopup );
}

// Close on any pointer-down outside the popup — but not on the toolbar button
// itself, so its own command can toggle the popup shut.
function onTbOutside( e )
{
    const pop = document.getElementById( 'tbPopup' );
    if( pop.contains( e.target ) ) return;

    const ctn = e.target.closest && e.target.closest( '.superdoc-toolbar .sd-toolbar-item-ctn' );
    if( ctn && ctn.querySelector( '[data-item="btn-tableBorders"]' ) ) return;

    closeTbPopup();
}

//----------------------------------------------------------------------------//
// PAGE SETUP  (size / orientation / margins)
//
// This used to act on a hard-coded "section-0" and NEVER read the document: the
// dialog always showed Nayive's defaults, so opening a Letter/landscape file and
// pressing "Aplicar" silently overwrote its real page setup. Both halves are
// fixed here - the section is the one the caret is in, and the dialog is filled
// from doc.sections.list(), which does work in the browser build (a comment here
// used to say its query API was Node-only; it is not).
//
// One gotcha worth keeping: READS take { address: { kind, sectionId } }, WRITES
// take { target: { kind, sectionId } }. They are not interchangeable.

const CM_PER_IN = 2.54;

function fmtCm( v ) { return ( Math.round( v * 100 ) / 100 ).toString().replace( '.', ',' ); }

// `max` defaults to 10 cm, which is right for a MARGIN. A custom page size has
// to pass its own ceiling, or a 15 x 20 cm page comes out 10 x 10.
function parseCm( raw, max )
{
    const n = parseFloat( String( raw ).replace( ',', '.' ) );
    return Number.isFinite( n ) ? Math.min( Math.max( n, 0 ), max === undefined ? 10 : max ) : null;
}

async function openPageSetup()
{
    if( ! ready ) { NayiveUI.toast( NayiveUI.t( 'write.waitForDoc' ) ); return; }

    // Fill from the DOCUMENT, not from this session's defaults. If the read
    // fails, fall back to the defaults rather than showing nothing.
    let cur = null;
    try { cur = await readPageSetup(); } catch( _ ) {}

    const v = cur || pageSetup;

    document.getElementById( 'psSize'   ).value = PAGE_SIZES[ v.size ] ? v.size : 'custom';
    document.getElementById( 'psOrient' ).value = v.orientation;
    document.getElementById( 'psTop'    ).value = fmtCm( v.top );
    document.getElementById( 'psBottom' ).value = fmtCm( v.bottom );
    document.getElementById( 'psLeft'   ).value = fmtCm( v.left );
    document.getElementById( 'psRight'  ).value = fmtCm( v.right );
    document.getElementById( 'psWidth'  ).value = fmtCm( ( v.width  || 0 ) * CM_PER_IN );
    document.getElementById( 'psHeight' ).value = fmtCm( ( v.height || 0 ) * CM_PER_IN );
    document.getElementById( 'psColumns' ).value = String( ( cur && cur.columns ) || 1 );

    // Line numbering is written but not reported back by sections.list(), so the
    // box shows what this session last set rather than the document's own state.
    document.getElementById( 'psLineNumbers' ).checked = !! lineNumbersOn;

    // Say which section is being changed, but only when there is more than one -
    // otherwise the line is noise.
    const note = document.getElementById( 'psSection' );
    const many = cur && cur.sectionCount > 1;
    note.hidden = ! many;
    if( many ) note.textContent = NayiveUI.tf( 'write.psSection',
                                               { n: cur.sectionIndex + 1, total: cur.sectionCount } );

    syncPageSizeRows();
    setBackdrop( 'pageSetupBackdrop', true );
}

// The two custom width/height fields only make sense for "custom".
function syncPageSizeRows()
{
    document.getElementById( 'psCustomRow' ).hidden =
        document.getElementById( 'psSize' ).value !== 'custom';
}

// The section the caret sits in, falling back to the first one (a fresh document
// has no caret yet, and boot() applies the defaults before anyone has clicked).
async function caretSectionId()
{
    try
    {
        const ctx = sd.activeEditor.host.pageLayout.getActiveRulerContext();
        if( ctx && ctx.sectionId ) return ctx.sectionId;
    }
    catch( _ ) {}

    try { return ( await sd.activeEditor.doc.sections.list() ).items[ 0 ].address.sectionId; }
    catch( _ ) { return 'section-0'; }
}

// Read the open document's real page setup. Everything the API hands back is in
// inches; the dialog works in centimetres.
async function readPageSetup()
{
    const list = await sd.activeEditor.doc.sections.list();
    const id   = await caretSectionId();
    const sec  = list.items.find( function( i ) { return i.address.sectionId === id; } ) || list.items[ 0 ];

    if( ! sec ) return null;

    const ps   = sec.pageSetup || {};
    const mg   = sec.margins   || {};
    const land = ps.orientation === 'landscape';

    // width/height are as laid out, so undo the rotation before naming the size.
    const w = land ? ps.height : ps.width;
    const h = land ? ps.width  : ps.height;

    return {
        size        : sizeNameFor( w, h ),
        orientation : land ? 'landscape' : 'portrait',
        width       : w,
        height      : h,
        top         : ( mg.top    || 0 ) * CM_PER_IN,
        bottom      : ( mg.bottom || 0 ) * CM_PER_IN,
        left        : ( mg.left   || 0 ) * CM_PER_IN,
        right       : ( mg.right  || 0 ) * CM_PER_IN,
        columns     : ( sec.columns && sec.columns.count ) || 1,
        sectionId   : sec.address.sectionId,
        sectionCount: list.items.length,
        sectionIndex: sec.index
    };
}

// Push a page setup (size / orientation / cm margins) onto the section the caret
// is in. SuperDoc's sections API takes INCHES.
async function applyPageSetup( setup, sectionId )
{
    const size = setup.size === 'custom' ? { w: setup.width, h: setup.height }
                                         : PAGE_SIZES[ setup.size ];
    const land   = setup.orientation === 'landscape';
    const doc    = sd.activeEditor.doc;
    const target = { kind: 'section', sectionId: sectionId || ( await caretSectionId() ) };

    await doc.sections.setPageSetup(
    {
        target      : target,
        width       : land ? size.h : size.w,
        height      : land ? size.w : size.h,
        orientation : setup.orientation
    } );

    await doc.sections.setPageMargins(
    {
        target : target,
        top    : setup.top    / CM_PER_IN,
        bottom : setup.bottom / CM_PER_IN,
        left   : setup.left   / CM_PER_IN,
        right  : setup.right  / CM_PER_IN
    } );

    if( setup.columns ) await doc.sections.setColumns( { target: target, count: setup.columns, gap: 0.5 } );

    // `enabled` is required — without it the call is rejected outright.
    if( setup.lineNumbers !== undefined )
        await doc.sections.setLineNumbering( setup.lineNumbers
                                             ? { target: target, enabled: true, countBy: 1, restart: 'newPage' }
                                             : { target: target, enabled: false } );
}

// Not reported by sections.list(), so remembered for the dialog's checkbox.
let lineNumbersOn = false;

async function confirmPageSetup()
{
    const chosen = document.getElementById( 'psSize' ).value;

    const next = {
        size        : PAGE_SIZES[ chosen ] ? chosen : 'custom',
        orientation : document.getElementById( 'psOrient' ).value === 'landscape' ? 'landscape' : 'portrait',
        // A page, not a margin: 200 cm is a generous ceiling, 1 cm a sane floor.
        width       : Math.max( parseCm( document.getElementById( 'psWidth'  ).value, 200 ) ?? 21,   1 ) / CM_PER_IN,
        height      : Math.max( parseCm( document.getElementById( 'psHeight' ).value, 200 ) ?? 29.7, 1 ) / CM_PER_IN,
        columns     : parseInt( document.getElementById( 'psColumns' ).value, 10 ) || 1,
        lineNumbers : document.getElementById( 'psLineNumbers' ).checked,
        top         : parseCm( document.getElementById( 'psTop'    ).value ) ?? pageSetup.top,
        bottom      : parseCm( document.getElementById( 'psBottom' ).value ) ?? pageSetup.bottom,
        left        : parseCm( document.getElementById( 'psLeft'   ).value ) ?? pageSetup.left,
        right       : parseCm( document.getElementById( 'psRight'  ).value ) ?? pageSetup.right
    };

    setBackdrop( 'pageSetupBackdrop', false );

    try
    {
        await applyPageSetup( next );
        phoneMarginsIn = null;   // margins may have moved: the phone fit re-reads them
        pageSetup     = next;
        lineNumbersOn = next.lineNumbers;
        onEdit();   // mark dirty / schedule the save
    }
    catch( e )
    {
        console.error( 'Write: page setup', e );
        NayiveUI.toast( NayiveUI.t( 'write.pageSetupFailed' ) );
    }
}

//----------------------------------------------------------------------------//
// SAVE

async function exportBytes()
{
    const blob = await sd.export( { exportType: [ 'docx' ], triggerDownload: false } );
    return new Uint8Array( await blob.arrayBuffer() );
}

// Ctrl-S / the menu: save now. An untitled or someone else's document goes to
// "Guardar como" (shared/office.js).
function saveNow() { session.saveNow(); }

//----------------------------------------------------------------------------//
// OPEN  (the dialog itself is the shared one: shared/office.js, openBrowser -
// recent documents over a folder browser. Write only says which files it lists
// and what to do with the one picked.)

// Extensions the Open dialog shows. A `.docx` loads straight away; a file in
// CONVERT_EXTS (LibreOffice Writer, ...) is converted to .docx on the server
// first (see convertToDocx). That conversion isn't wired up yet, so
// CONVERT_EXTS is empty for now and only .docx appears.
const OPEN_EXTS     = [ '.docx' ];
const CONVERT_EXTS  = [];
const OPENABLE_EXTS = OPEN_EXTS.concat( CONVERT_EXTS );

function extOf( path )
{
    const m = /\.[^./]+$/.exec( String( path ) );
    return m ? m[ 0 ].toLowerCase() : '';
}

function isOpenable( path ) { return OPENABLE_EXTS.indexOf( extOf( path ) ) !== -1; }

// Straight through to shared/office.js - this was an identical copy. Kept as a
// function declaration, not a const: the old ones were hoisted, and half of
// write.js calls them from code that runs before this line.
function byBaseName( a, b ) { return NayiveOffice.byBaseName( a, b ); }

// Open a file the user picked in the browser: a .docx directly, anything else
// via a server-side conversion to .docx first.
async function openPickedFile( path )
{
    if( OPEN_EXTS.indexOf( extOf( path ) ) !== -1 )
    {
        await session.open( path );
        return;
    }

    const docxPath = await convertToDocx( path );
    if( docxPath ) await session.open( docxPath );
}

// Convert a non-.docx word-processor file (LibreOffice Writer .odt, legacy
// .doc, .rtf, …) to .docx on the server, save it next to the original and
// return its path. The LibreOffice-backed endpoint isn't deployed yet, so
// CONVERT_EXTS is empty and this is never reached — the toast is just a guard.
async function convertToDocx( path )
{
    NayiveUI.toast( NayiveUI.t( 'write.formatUnsupported' ) );
    return null;
}

//----------------------------------------------------------------------------//
// THE DOCUMENT IN SUPERDOC  (what the session in shared/office.js needs from Write)

// A .docx body on screen: opened, imported, the device draft or the .bak copy.
// At start-up SuperDoc does not exist yet - boot() builds it on this file.
async function loadBody( body, name )
{
    const file = new File( [ body ], baseName( name || 'documento.docx' ), { type: DOCX_MIME } );

    if( ! sd ) { bootSource = file; return; }
    await loadIntoEditor( file );
}

// A blank document. BlankDOCX is a data: URL, not bytes - SuperDoc takes it as
// it is. At start-up there is nothing to do: boot() starts on BlankDOCX.
async function loadBlank()
{
    if( ! sd ) return;

    // As a File, like any other document: replaceFile() given the data: URL
    // itself resolves but keeps the old text once a File was loaded (a draft
    // reopened at start-up), so New and "Guardar como"'s bin did nothing.
    const blob = await ( await fetch( BlankDOCX ) ).blob();
    await loadIntoEditor( new File( [ blob ], 'documento.docx', { type: DOCX_MIME } ) );
    lastVert = { sig: null, value: null };
    await applyDefaultPageSetup();
}

// A brand-new document gets Nayive's default page setup; opened files keep their own.
async function applyDefaultPageSetup()
{
    applyingDefaults = true;
    try { await applyPageSetup( pageSetup ); } catch( _ ) {}
    applyingDefaults = false;
}

//----------------------------------------------------------------------------//
// HELPERS

// Straight through to shared/office.js — these were identical copies. Function
// declarations on purpose: they are hoisted, and the session above uses them.
function baseName( path ) { return NayiveOffice.baseName( path ); }
function dirName( path )  { return NayiveOffice.dirName( path ); }

// Write's file-name rule, for "Guardar como" and a rename: always .docx.
function docxName( name ) { return /\.docx$/i.test( name ) ? name : name + '.docx'; }

async function fetchAsFile( path )
{
    const bytes = await GumApi.readFileBytes( path );
    return new File( [ bytes ], baseName( path ), { type: DOCX_MIME } );
}

// SuperDoc stores images inline in the .docx as data URLs, so whatever comes out
// of here is carried in the document for good. A phone photo is 3-6 MB and turns
// a two-page letter into a file nobody can e-mail, so it goes through the same
// shrink Photos and Drive use (shared/photo.js) first. Handing back a resized
// data: URL is the supported contract for handleImageUpload.
const IMAGE_MAX_EDGE = 1600;   // px on the long side - plenty at 100 % on paper

async function fileToDataUrl( file )
{
    let out = file;

    try
    {
        if( window.NayivePhoto )
        {
            const prepared = await NayivePhoto.prepare( file, IMAGE_MAX_EDGE );
            if( prepared && prepared.blob ) out = prepared.blob;
        }
    }
    catch( _ ) { out = file; }   // undecodable (HEIC on some Androids): use it as it came

    return new Promise( function( resolve, reject )
    {
        const fr = new FileReader();
        fr.onload  = function() { resolve( fr.result ); };
        fr.onerror = function() { reject( fr.error ); };
        fr.readAsDataURL( out );
    });
}

