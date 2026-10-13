/*
 * keyboard.js - Drive: the search key and the key hints in the tooltips.
 */
"use strict";

// The list's and the tree's own keys (arrows, Shift / Ctrl, Space, Enter,
// Ctrl+A, Esc, Del, F2, Ctrl+C / X / V, Alt+N, Ctrl+U, Ctrl+D, Tab and ←
// into the tree) are the shared item browser's: each one belongs to an
// action in menus.js. This file keeps the search key and the tooltips' hints.

//------------------------------------------------------------------------//
// KEYBOARD SHORTCUTS
//
// The header's own buttons and their keys: buscar, nueva carpeta, subir.
// The same entry builds the "· Ctrl+F" that button's tooltip ends in. Only
// Ctrl+F is matched here (it also works from inside a text box); Alt+N and
// Ctrl+U are the browser's area actions (menus.js), listed for the hint.
//
// Nothing here happens on a phone: no keyboard, and a title there is also
// the ⋮ menu's label and the help card's name, so the hints come off too.

const IS_MAC = NayiveUI.isMac;

// "Ctrl+F" on a PC, "⌘F" on a Mac (NayiveUI.keyLabel: the modifier NAMES
// translated - Strg in German - the Mac glyphs the same in every language).

// The Ctrl of the platform, and nothing else held down. e.code (not e.key)
// because e.key is what the LAYOUT produces: Ctrl+F on a Cyrillic keyboard
// reads as "ф", and Mac's ⌥N types a dead "˜".
function modOnly( e )
{
    return ( IS_MAC ? ( e.metaKey && ! e.ctrlKey ) : ( e.ctrlKey && ! e.metaKey ) )
           && ! e.altKey && ! e.shiftKey;
}

const SHORTCUTS = [
    // Ctrl+F is the one key that also works from inside a text box — that
    // is where the browser's own find bar would have opened.
    { el: 'searchInput', label: () => NayiveUI.keyLabel( 'Ctrl+F' ),
      match: e => modOnly( e ) && e.code === 'KeyF',
      run:   focusSearch },

    // Ctrl+Shift+N is Chrome's incognito window and cannot be taken away
    // from it, so nueva carpeta gets Alt+N instead.
    { el: 'newFolderBtn', label: () => NayiveUI.keyLabel( 'Alt+N' ), match: () => false },
    { el: 'uploadBtn',    label: () => NayiveUI.keyLabel( 'Ctrl+U' ), match: () => false }
];

function focusSearch()
{
    if( advSearch ) { openSearchBuilder(); return; }    // the box is hidden behind its button

    driveSearch.open();                                  // unfolds and focuses it
    document.getElementById( 'searchInput' ).select();
}

// Shortcut hints on the tooltips (NayiveUI.keyHints). updateToolbarState
// rewrites some of these titles ("Descargar selección") on every selection
// change and calls this right after.
function applyKeyHints() { NayiveUI.keyHints( SHORTCUTS, isPhone() ); }

function onShortcutKey( e )
{
    const s = SHORTCUTS.find( function( x ) { return x.match( e ); } );
    if( ! s ) return;

    if( isPhone() || trashMode ) return;
    if( NayiveUI.menuOpen() ) return;
    // A dialog, the viewer or the player owns the screen:
    // the toolbar behind it is not what the key is for.
    if( document.querySelector( '.sheet-backdrop.open, .viewer-backdrop.open, .media-backdrop.open' ) ) return;

    // Swallowed even when the action itself cannot run, so the browser's
    // find bar / view-source / bookmark never appears over Drive.
    e.preventDefault();

    s.run();
}
