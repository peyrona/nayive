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
    { el: 'newFolderBtn', label: () => combo( [ kAlt(), 'N' ] ), match: () => false },
    { el: 'uploadBtn',    label: () => combo( [ kMod(), 'U' ] ), match: () => false }
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
// labels its row with (wireTopMenu); strip the hint there in case
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
    if( NayiveUI.menuOpen() ) return;
    // A dialog, the viewer or the player owns the screen:
    // the toolbar behind it is not what the key is for.
    if( document.querySelector( '.sheet-backdrop.open, .viewer-backdrop.open, .media-backdrop.open' ) ) return;
    if( ! s.inField && inTextField( e.target ) ) return;

    // Swallowed even when the action itself cannot run, so the browser's
    // find bar / view-source / bookmark never appears over Drive.
    e.preventDefault();

    s.run();
}
