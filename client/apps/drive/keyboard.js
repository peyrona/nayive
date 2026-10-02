/*
 * keyboard.js - Drive: keyboard navigation and shortcuts.
 */
"use strict";

//------------------------------------------------------------------------//
// KEYBOARD NAVIGATION
//   Left / Right : move the cursor between the folder tree and the file list
//   Up   / Down  : move the highlight within the focused pane
//   Enter        : open the highlighted item (tree: go into the folder;
//                  list: navigate a folder / open a file)

function kbdTreeRows() { return Array.from( document.querySelectorAll( '#treePane .tree-row' ) ); }
function kbdListRows() { return Array.from( document.querySelectorAll( '#listing .row'   ) ); }

function paintKbdPane()
{
    document.body.classList.toggle( 'kbd-tree', kbdPane === 'tree' );
    document.body.classList.toggle( 'kbd-list', kbdPane === 'list' );
}

function focusPane( which )
{
    if( isPhone() || trashMode ) return;
    kbdPane = which;

    if( which === 'tree' )
    {
        const rows = kbdTreeRows();
        if( ! rows.length ) { kbdPane = 'list'; return; }
        if( ! rows.some( function( r ) { return r.dataset.path === kbdTreePath; } ) )
            kbdTreePath = rows.some( function( r ) { return r.dataset.path === currentFolder; } )
                        ? currentFolder : rows[0].dataset.path;
        renderTree();
        scrollKbdIntoView( kbdTreeRows().find( function( r ) { return r.dataset.path === kbdTreePath; } ) );
    }
    else
    {
        renderTree();                    // drop the tree's keyboard cursor
        const rows = kbdListRows();
        if( rows.length && ! rows.some( function( r ) { return selectedPaths.has( r.dataset.path ); } ) )
        {
            selectedPaths.clear();
            selectedPaths.add( rows[0].dataset.path );
            paintSelection();
            updateToolbarState();
        }
        scrollKbdIntoView( kbdListRows().find( function( r ) { return selectedPaths.has( r.dataset.path ); } ) );
    }

    paintKbdPane();
}

function scrollKbdIntoView( el ) { if( el ) el.scrollIntoView( { block: 'nearest', inline: 'nearest' } ); }

function kbdTreeMove( dir, activate )
{
    const rows  = kbdTreeRows();
    if( ! rows.length ) return;
    const paths = rows.map( function( r ) { return r.dataset.path; } );
    let i = paths.indexOf( kbdTreePath );

    if( activate )
    {
        if( i >= 0 ) { kbdTreePath = paths[i]; navigateTo( paths[i] ); paintKbdPane(); }
        return;
    }

    i = i < 0 ? 0 : Math.min( Math.max( i + dir, 0 ), rows.length - 1 );
    kbdTreePath = paths[i];
    renderTree();
    scrollKbdIntoView( kbdTreeRows()[i] );
}

function kbdListMove( dir, activate )
{
    const rows  = kbdListRows();
    if( ! rows.length ) return;
    const paths = rows.map( function( r ) { return r.dataset.path; } );
    const here  = paths.filter( function( p ) { return selectedPaths.has( p ); } );
    let i = here.length ? paths.indexOf( here[here.length - 1] ) : -1;

    if( activate )
    {
        if( i >= 0 ) openNode( rowNode( paths[i] ) );
        return;
    }

    i = i < 0 ? 0 : Math.min( Math.max( i + dir, 0 ), rows.length - 1 );
    selectedPaths.clear();
    selectedPaths.add( paths[i] );
    paintSelection();
    updateToolbarState();
    scrollKbdIntoView( rows[i] );
}

//------------------------------------------------------------------------//
// KEYBOARD SHORTCUTS
//
// Only the six things a person does most in Drive get one — buscar, nueva
// carpeta, subir, descargar, renombrar y enviar a la papelera. The table
// below is the single source of truth: the same entry matches the keypress
// AND builds the "· Ctrl+F" that button's tooltip ends in, so the keys and
// what the tooltips promise can never drift apart.
//
// Nothing here happens on a phone: no keyboard, and a title there is also
// the ⋮ menu's label and the help card's name, so the hints come off too.

const IS_MAC = NayiveUI.isMac;

// "Ctrl+F" on a PC, "⌘F" on a Mac. The modifier NAMES are translated
// (Strg / Entf in German, Supr in Spanish); the Mac glyphs are the same
// in every language, so they stay literal.
const HINT_SEP = ' · ';                                   // "Renombrar · F2"
function combo( parts ) { return parts.join( IS_MAC ? '' : '+' ); }
function kMod() { return IS_MAC ? '⌘' : T( 'ui.keyCtrl' ); }   // ⌘ / Ctrl
function kAlt() { return IS_MAC ? '⌥' : T( 'ui.keyAlt'  ); }   // ⌥ / Alt

// The Ctrl of the platform, and nothing else held down. e.code (not e.key)
// because e.key is what the LAYOUT produces: Ctrl+F on a Cyrillic keyboard
// reads as "ф", and Mac's ⌥N types a dead "˜".
function modOnly( e )
{
    return ( IS_MAC ? ( e.metaKey && ! e.ctrlKey ) : ( e.ctrlKey && ! e.metaKey ) )
           && ! e.altKey && ! e.shiftKey;
}
function bare( e ) { return ! e.ctrlKey && ! e.metaKey && ! e.altKey && ! e.shiftKey; }

const SHORTCUTS = [
    // Ctrl+F is the one key that also works from inside a text box — that
    // is where the browser's own find bar would have opened.
    { el: 'searchInput', label: () => combo( [ kMod(), 'F' ] ), inField: true,
      match: e => modOnly( e ) && e.code === 'KeyF',
      run:   focusSearch },

    // Ctrl+Shift+N is Chrome's incognito window and cannot be taken away
    // from it, so nueva carpeta gets Alt+N instead.
    { el: 'newFolderBtn', label: () => combo( [ kAlt(), 'N' ] ),
      match: e => e.altKey && ! e.ctrlKey && ! e.metaKey && ! e.shiftKey && e.code === 'KeyN' },

    { el: 'uploadBtn',   label: () => combo( [ kMod(), 'U' ] ),
      match: e => modOnly( e ) && e.code === 'KeyU' },

    { el: 'downloadBtn', label: () => combo( [ kMod(), 'D' ] ),
      match: e => modOnly( e ) && e.code === 'KeyD' },

    { el: 'renameBtn',   label: () => 'F2',
      match: e => e.key === 'F2' && bare( e ) },

    // The button, with nothing ticked, sends the WHOLE OPEN FOLDER to the
    // papelera. A stray Supr must never do that, so the key acts only on a
    // selection.
    { el: 'deleteBtn',   label: () => T( 'ui.keyDel' ), needsSelection: true,
      match: e => e.key === 'Delete' && bare( e ) }
];

function focusSearch()
{
    if( advSearch ) { openSearchBuilder(); return; }    // the box is hidden behind its button

    driveSearch.open();                                  // unfolds and focuses it
    document.getElementById( 'searchInput' ).select();
}

// Hangs " · Ctrl+F" off each shortcut button's tooltip — and takes it off
// again on a phone. A middle dot rather than parentheses: the search tip
// already ends in "(uno)". Idempotent, because updateToolbarState rewrites
// some of these titles ("Descargar selección") on every selection change
// and calls us right after.
function applyKeyHints()
{
    const phone = isPhone();

    for( const s of SHORTCUTS )
    {
        const el = document.getElementById( s.el );
        if( ! el ) continue;

        const hint = HINT_SEP + s.label();
        let   t    = el.getAttribute( 'title' ) || '';

        if( t.slice( -hint.length ) === hint ) t = t.slice( 0, -hint.length );
        if( ! t ) continue;                    // no tooltip yet: nothing to hang the hint on

        el.setAttribute( 'title', phone ? t : t + hint );
    }
}

// The tooltip a shortcut button carries is also what the phone's ⋮ menu
// labels its row with (updateTopMenuState); strip the hint there in case
// a desktop window was just narrowed into the phone layout.
function stripKeyHint( title )
{
    for( const s of SHORTCUTS )
    {
        const hint = HINT_SEP + s.label();
        if( title.slice( -hint.length ) === hint ) return title.slice( 0, -hint.length );
    }
    return title;
}

// A checkbox is not a text field: ticking rows and then pressing Supr is
// exactly how a person deletes, so that one keeps working.
function inTextField( t )
{
    const f = ( t && t.closest ) ? t.closest( 'input, textarea, select, [contenteditable]' ) : null;
    return !! f && f.type !== 'checkbox';
}

function onShortcutKey( e )
{
    const s = SHORTCUTS.find( function( x ) { return x.match( e ); } );
    if( ! s ) return;

    if( isPhone() || trashMode ) return;
    if( anyCtxMenuOpen() ) return;
    // A dialog, the viewer or the player owns the screen:
    // the toolbar behind it is not what the key is for.
    if( document.querySelector( '.sheet-backdrop.open, .viewer-backdrop.open, .media-backdrop.open' ) ) return;
    if( ! s.inField && inTextField( e.target ) ) return;

    // Swallowed even when the action itself cannot run, so the browser's
    // find bar / view-source / bookmark never appears over Drive.
    e.preventDefault();

    if( s.run ) { s.run(); return; }

    const btn = document.getElementById( s.el );
    if( ! btn || btn.disabled ) return;
    if( s.needsSelection && ! selectedPaths.size ) return;

    btn.click();                               // one path in, same as the ⋮ menu takes
}

function onNavKey( e )
{
    if( e.ctrlKey || e.metaKey || e.altKey || e.shiftKey ) return;
    if( [ 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter' ].indexOf( e.key ) === -1 ) return;

    const t = e.target;
    if( t && t.closest && t.closest( 'input, textarea, button, a, select, [contenteditable]' ) ) return;
    if( isPhone() || trashMode ) return;
    if( anyCtxMenuOpen() ) return;
    if( document.querySelector( '.sheet-backdrop.open, .viewer-backdrop.open, .media-backdrop.open' ) ) return;

    if( e.key === 'ArrowLeft'  ) { e.preventDefault(); focusPane( 'tree' ); return; }
    if( e.key === 'ArrowRight' ) { e.preventDefault(); focusPane( 'list' ); return; }

    e.preventDefault();
    const dir      = e.key === 'ArrowDown' ? 1 : -1;
    const activate = e.key === 'Enter';
    if( kbdPane === 'tree' ) kbdTreeMove( dir, activate );
    else                     kbdListMove( dir, activate );
    paintKbdPane();
}
