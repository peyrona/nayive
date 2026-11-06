/*
 * keyboard.js - Drive: the key hints in the tooltips.
 */
"use strict";

// The list's own keys (arrows, Shift / Ctrl, Space, Enter, Ctrl+A, Esc,
// Del, F2, Ctrl+C / X / V, Alt+N, Ctrl+U, Ctrl+D) are the shared item list's: each one belongs to an
// action in menus.js; Ctrl+F (the search) is Ayni's. This file keeps the tooltips' hints.

//------------------------------------------------------------------------//
// KEYBOARD SHORTCUTS
//
// The header's own buttons and their keys: buscar, nueva carpeta, subir.
// Each entry builds the "· Ctrl+F" that button's tooltip ends in. Ctrl+F is
// Ayni's (ayni-search.js); Alt+N and Ctrl+U are the browser's area actions
// (menus.js), listed for the hint.
//
// Nothing here happens on a phone: no keyboard, and a title there is also
// the ⋮ menu's label and the help card's name, so the hints come off too.

const IS_MAC = Ayni.isMac;

// "Ctrl+F" on a PC, "⌘F" on a Mac (Ayni.keyLabel: the modifier NAMES
// translated - Strg in German - the Mac glyphs the same in every language).

const SHORTCUTS = [
    // Ctrl+F opens the search (Ayni's, from anywhere, even a text box); only
    // its hint is here, on the magnifier.
    { el: 'searchToggleBtn', label: () => Ayni.keyLabel( 'Ctrl+F' ), match: () => false },

    // Ctrl+Shift+N is Chrome's incognito window and cannot be taken away
    // from it, so nueva carpeta gets Alt+N instead.
    { el: 'newFolderBtn', label: () => Ayni.keyLabel( 'Alt+N' ), match: () => false },
    { el: 'uploadBtn',    label: () => Ayni.keyLabel( 'Ctrl+U' ), match: () => false }
];

// Shortcut hints on the tooltips (Ayni.keyHints). updateToolbarState
// rewrites some of these titles ("Descargar selección") on every selection
// change and calls this right after.
function applyKeyHints() { Ayni.keyHints( SHORTCUTS, isPhone() ); }
