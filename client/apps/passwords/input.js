/*
 * input.js - Passwords: every click, key and drag. The header and its "⋮"
 * (the shared Ayni.fitBar), the tree, the rows, search, the sheets'
 * buttons, the gate's boxes, dropping onto folders and the pane resizer.
 * Picking, the item menu, the selection's header buttons and the list keys
 * are the shared item list (Ayni.list): this file only gives it
 * the action list.
 */
"use strict";

let browse      = null;   // the shared item list on #items
let treeView    = null;   // the shared tree in #tree
let searchFold  = null;   // the header's search field (Ayni.searchField)
let searchTimer = null;

function wireAll()
{
    wireHeader();
    wireTree();
    wireItems();
    wireSearch();
    wireSecrets();
    wireItemSheet();
    wireOtherSheets();
    wireGate();
    wireDragDrop();
    wireResizer();
    wireAutoLock();

    window.addEventListener( 'resize', function() { if( isOpen() ) renderCrumbs(); } );
}

//------------------------------------------------------------------------//
// HEADER

function wireHeader()
{
    $( 'addBtn' ).addEventListener( 'click', function() { openItemSheet( null ); } );
    $( 'newFolderBtn' ).addEventListener( 'click', function() { openFolderSheet( null ); } );
    $( 'lockBtn' ).addEventListener( 'click', lock );
    $( 'upBtn' ).innerHTML = Ayni.icon( 'back' );
    $( 'treeBtn' ).addEventListener( 'click', function() { treeView.openSheet(); } );
}

const SORTS = [ [ 'name', 'passwords.sortName' ], [ 'changed', 'passwords.sortChanged' ] ];

// The "⋮": after the buttons that did not fit, Passwords' own rows - only
// while the vault is open.
function topMenuItems()
{
    const off = ! vaultShown();
    return [
        { id: 'gen',      label: T( 'passwords.generator' ), icon: SVG.dice,    hidden: off, run: function() { openGenerator( null ); } },
        { id: 'import',   label: T( 'passwords.import' ),    icon: SVG.importI, hidden: off, run: function() { document.getElementById( 'importBackdrop' ).showModal(); } },
        { id: 'export',   label: T( 'passwords.export' ),    icon: SVG.exportI, hidden: off, run: function() { document.getElementById( 'exportBackdrop' ).showModal(); } },
        { id: 'settings', label: T( 'passwords.settings' ),  icon: 'settings',      hidden: off, run: openSettings },
        { sep: true, hidden: off },
        { caption: T( 'passwords.sort' ), hidden: off }
    ].concat( SORTS.map( function( s )
    {
        return { id: 'sort:' + s[ 0 ], label: T( s[ 1 ] ), checked: ui.sort === s[ 0 ], hidden: off,
                 run: function() { ui.sort = s[ 0 ]; saveUi(); render(); } };
    } ) );
}

//------------------------------------------------------------------------//
// TREE  -  the shared tree: folders only. A click opens the folder; rows
// take dropped entries and folders (into them; the order is by name).

function wireTree()
{
    treeView = Ayni.tree( $( 'tree' ), {
        nav:     true,
        sheet:   $( 'treePane' ),
        items:   treeRoots,
        isOpen:  function( id ) { return ui.open.indexOf( id ) >= 0; },
        setOpen: function( id, v ) { toggleOpen( id, v ); },
        current: function() { return filter === 'all' && ! query ? curFolder : null; },
        go:      function( id ) { goFolder( id ); },
        menu:    function( id, x, y, anchor ) { Ayni.menuAt( browse.items( [ id ] ), { x: x, y: y, anchor: anchor } ); },
        keys:    true,
        drag:    function( id ) { return [ id ]; },
        drop:    { can: treeCan, drop: dropInto }
    } );
}

//------------------------------------------------------------------------//
// ROWS  -  a click picks, a double-click (a tap) opens: the entry's sheet,
// or the folder. A row's own buttons copy the user name / the password.
// Every action, once: the header group, the menu and the keys read this list.

function entriesOnly( ids ) { return ids.length > 0 && ids.every( function( id ) { return item( id ) && ! isFolder( item( id ) ); } ); }
function oneLogin( ids )    { return ids.length === 1 && !! item( ids[ 0 ] ) && item( ids[ 0 ] ).type === 'login'; }
function oneFolder( ids )   { return ids.length === 1 && isFolder( item( ids[ 0 ] ) ); }

function openItem( id )
{
    if( isFolder( item( id ) ) ) goFolder( id ); else openItemSheet( id );
}

function actionList() { return [
    { id: 'open', label: T( 'ui.open' ), icon: 'edit', key: 'Enter', group: 0, when: function( ids ) { return ids.length === 1; },
      run: function( ids ) { openItem( ids[ 0 ] ); } },
    { id: 'copyUser', label: T( 'passwords.copyUser' ), icon: SVG.user, rank: 6, hideOff: true, group: 1,
      when: function( ids ) { return oneLogin( ids ) && !! item( ids[ 0 ] ).user; },
      run: function( ids ) { copyFromItem( ids[ 0 ], 'user' ); } },
    { id: 'copyPass', label: T( 'passwords.copyPass' ), icon: SVG.key, rank: 2, hideOff: true, group: 1,
      when: function( ids ) { return oneLogin( ids ) && !! item( ids[ 0 ] ).pass; },
      run: function( ids ) { copyFromItem( ids[ 0 ], 'pass' ); } },
    { id: 'site', label: T( 'passwords.openSite' ), icon: 'external', rank: 7, hideOff: true, group: 1,
      when: function( ids ) { return oneLogin( ids ) && !! siteOf( item( ids[ 0 ] ) ); },
      run: function( ids ) { openSite( siteOf( item( ids[ 0 ] ) ) ); } },
    { id: 'fav', icon: 'star', key: 'S', rank: 5, group: 2, when: entriesOnly,
      label: function( ids ) { return T( ids.length && ids.every( function( id ) { return item( id ) && item( id ).fav; } ) ? 'passwords.unfavourite' : 'passwords.favAdd' ); },
      run: setFavourite },
    { id: 'rename', label: T( 'ui.rename' ), icon: 'edit', key: 'F2', rank: 8, hideOff: true, group: 2, when: oneFolder,
      run: function( ids ) { openFolderSheet( ids[ 0 ] ); } },
    { id: 'move', label: T( 'passwords.moveTo' ), icon: 'move', rank: 3, group: 2, run: openMoveSheet },
    { id: 'subfolder', label: T( 'passwords.newSubfolder' ), icon: 'folder-plus', rank: 9, hideOff: true, group: 2, when: oneFolder,
      run: function( ids ) { openFolderSheet( null, ids[ 0 ] ); } },
    // Never a bare ⌫ (Drive's rule): ⌘⌫ on a Mac, Del elsewhere.
    { id: 'delete', label: T( 'ui.delete' ), icon: 'trash', key: NayiveUI.isMac ? [ 'Del', 'Ctrl+Backspace' ] : 'Del', rank: 1, group: 3, danger: true,
      run: deleteNodes }
]; }

function areaList() { return [
    { id: 'add', label: T( 'passwords.newItem' ), icon: 'plus', run: function() { openItemSheet( null ); } },
    { id: 'newFolder', label: T( 'ui.newFolder' ), icon: 'folder-plus', key: 'Alt+N', run: function() { openFolderSheet( null ); } }
]; }

function wireItems()
{
    const list = $( 'items' );

    Ayni.fitBar( document.querySelector( '.topbar' ), { btn: '#moreBtn', more: topMenuItems } );

    browse = Ayni.list( list, {
        main:    true,
        row:     '.pw-item',
        bar:     $( 'selActions' ),
        actions: actionList(),
        area:    areaList(),
        tree:    treeView,
        open:    openItem,
        grid:    function() { return true; },    // cards side by side: the arrows move in two directions
        active:  isOpen,
        drag:    { text: function( ids ) { const n = item( ids[ 0 ] ); return n ? n.title : ''; } }
    } );

    list.addEventListener( 'click', function( e )
    {
        const b = e.target.closest( '.pw-copy' );
        const row = b && b.closest( '.pw-item' );
        if( row ) copyFromItem( row.dataset.id, b.dataset.copy );
    } );

    $( 'filterRow' ).addEventListener( 'click', function( e )
    {
        const p = e.target.closest( '.pill' );
        if( ! p ) return;
        filter = p.dataset.filter;
        if( filter === 'all' ) curFolder = ROOT;
        if( query ) { query = ''; $( 'searchInput' ).value = ''; }
        render();
    } );
    $( 'crumbs' ).addEventListener( 'click', function( e )
    {
        const s = e.target.closest( '.crumb-seg' );
        if( s ) goFolder( s.dataset.id );
    } );
    $( 'upBtn' ).addEventListener( 'click', function() { if( curFolder !== ROOT ) goFolder( parentOf[ curFolder ] || ROOT ); } );
    $( 'emptyHint' ).addEventListener( 'click', function( e )
    {
        const b = e.target.closest( '[data-empty]' );
        if( ! b ) return;
        if( b.dataset.empty === 'add' ) openItemSheet( null );
        else if( b.dataset.empty === 'import' ) document.getElementById( 'importBackdrop' ).showModal();
    } );
}

//------------------------------------------------------------------------//
// SEARCH

function setQuery( q )
{
    query = q;
    $( 'searchInput' ).value = q;
    render();
    $( 'listPane' ).scrollTop = 0;
}

function wireSearch()
{
    const input = $( 'searchInput' );
    input.addEventListener( 'input', function()
    {
        clearTimeout( searchTimer );
        searchTimer = setTimeout( function() { query = input.value.trim(); render(); }, 90 );
    } );
    searchFold = Ayni.searchField( input.parentElement, { onClose: function() { clearTimeout( searchTimer ); if( isOpen() ) setQuery( '' ); } } );
}

//------------------------------------------------------------------------//
// KEYS  -  Ctrl+F (Ayni's) opens the search; Esc in it clears it, then folds
// it. Enter in a sheet's one-line box = its ✓.

function enterSubmits( backId, fn )
{
    $( backId ).addEventListener( 'keydown', function( e )
    {
        if( e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range' && ! e.isComposing )
        {
            e.preventDefault();
            fn();
        }
    } );
}

//------------------------------------------------------------------------//
// SECRET BOXES  -  every [data-reveal] (Ayni's) shows / hides its box; every
// [data-copy-field] copies its box (a password box through copySecret,
// which wipes the clipboard later).

function wireSecrets()
{
    document.querySelectorAll( '[data-copy-field]' ).forEach( function( b )
    {
        b.innerHTML = Ayni.icon( 'copy' );
        b.addEventListener( 'click', function()
        {
            const input = $( b.dataset.copyField );
            if( ! input.value ) return;
            if( input.id === 'itUser' ) NayiveUI.copyText( input.value ).then( function() { Ayni.toast( 'ok', T( 'passwords.userCopied' ) ); }, function() {} );
            else copySecret( input.value, input.id === 'itPass' ? 'passwords.passCopied' : 'passwords.secretCopied' );
        } );
    } );
}

//------------------------------------------------------------------------//
// THE ENTRY SHEET

// fn() each time the dialog `id` closes, by any road (its ×, Escape, the
// code). Not when it was opened again before the `close` event came.
function onClosed( id, fn )
{
    const d = $( id );
    d.addEventListener( 'close', function() { if( ! d.open ) fn(); } );
}

function wireItemSheet()
{
    $( 'itSaveBtn' ).addEventListener( 'click', saveItemSheet );
    $( 'itDeleteBtn' ).addEventListener( 'click', function()
    {
        const id = editId;
        document.getElementById( 'itemBackdrop' ).close();
        if( id ) deleteNodes( [ id ] );
    } );
    enterSubmits( 'itemBackdrop', saveItemSheet );
    $( 'itemTypeRow' ).addEventListener( 'click', function( e )
    {
        const p = e.target.closest( '.pill' );
        if( p ) setItemType( p.dataset.type );
    } );
    $( 'itGenBtn' ).innerHTML = SVG.dice;
    $( 'itGenBtn' ).addEventListener( 'click', function() { openGenerator( $( 'itPass' ) ); } );
    $( 'itOpenBtn' ).innerHTML = SVG.external;
    $( 'itOpenBtn' ).addEventListener( 'click', function() { openSite( $( 'itUrls' ).value.split( '\n' )[ 0 ] ); } );
    $( 'itUrls' ).addEventListener( 'input', fitUrls );
    $( 'itAddField' ).addEventListener( 'click', function() { addFieldRow().querySelector( '.pf-name' ).focus(); } );
    $( 'itFields' ).addEventListener( 'click', function( e )
    {
        const b = e.target.closest( '[data-f]' );
        const row = b && b.closest( '.pw-xfield' );
        if( ! row ) return;
        if( b.dataset.f === 'remove' ) row.remove();
        else if( b.dataset.f === 'secret' ) setFieldSecret( row, row.dataset.secret !== '1' );
        else if( b.dataset.f === 'copy' )
        {
            const v = row.querySelector( '.pf-value' ).value;
            if( v ) copySecret( v, 'passwords.secretCopied' );
        }
    } );
    $( 'itHistoryList' ).addEventListener( 'click', function( e )
    {
        const b = e.target.closest( '[data-hist]' );
        if( b ) copyHistory( +b.dataset.hist );
    } );
    // Closed by any road: nothing of the entry stays in the boxes.
    onClosed( 'itemBackdrop', function()
    {
        [ 'itName', 'itUser', 'itPass', 'itUrls', 'itNotes', 'itTotp' ].forEach( function( id ) { $( id ).value = ''; } );
        $( 'itFields' ).innerHTML = '';
        $( 'itHistoryList' ).innerHTML = '';
        editId = null;
    } );
}

//------------------------------------------------------------------------//
// THE OTHER SHEETS

function openSettings()
{
    document.getElementById( 'settingsBackdrop' ).showModal();
}

function wireOtherSheets()
{
    $( 'folderSaveBtn' ).addEventListener( 'click', saveFolderSheet );
    enterSubmits( 'folderBackdrop', saveFolderSheet );

    // Generator
    document.querySelector( '.pw-gen-tabs' ).addEventListener( 'click', function( e )
    {
        const p = e.target.closest( '.pill' );
        if( ! p ) return;
        showGenMode( p.dataset.gen );
        regenerate();
    } );
    [ 'genLen', 'genCount' ].forEach( function( id ) { $( id ).addEventListener( 'input', regenerate ); } );
    [ 'genLower', 'genUpper', 'genDigits', 'genSymbols', 'genNoLook', 'genSep', 'genCaps', 'genNum' ].forEach( function( id )
    {
        $( id ).addEventListener( 'change', regenerate );
    } );
    $( 'genAgainBtn' ).innerHTML = SVG.again;
    $( 'genAgainBtn' ).addEventListener( 'click', regenerate );
    $( 'genCopyBtn' ).innerHTML = Ayni.icon( 'copy' );
    $( 'genCopyBtn' ).addEventListener( 'click', function() { copySecret( $( 'genOut' ).value, 'passwords.passCopied' ); } );
    $( 'genUseBtn' ).addEventListener( 'click', useGenerated );
    onClosed( 'genBackdrop', function() { $( 'genOut' ).value = ''; genFor = null; } );

    // Settings: close-only, each choice kept on change (this device's).
    const fill = function( sel, list, key, unit )
    {
        sel.innerHTML = list.map( function( v ) { return '<option value="' + v + '">' + esc( TF( unit, { n: v } ) ) + '</option>'; } ).join( '' );
        sel.value = String( ui[ key ] );
        Ayni.autoSave( sel, function( v ) { ui[ key ] = +v; saveUi(); markActive(); } );
    };
    fill( $( 'setLock' ), LOCK_CHOICES, 'lockMin', 'passwords.minutesN' );
    fill( $( 'setClip' ), CLIP_CHOICES, 'clipSec', 'passwords.secondsN' );
    $( 'chpwOpenBtn' ).addEventListener( 'click', function() { document.getElementById( 'settingsBackdrop' ).close(); openChangePw( false ); } );
    $( 'newRecBtn' ).addEventListener( 'click', newRecoveryKey );

    // A new master password
    $( 'chpwSaveBtn' ).addEventListener( 'click', saveChangePw );
    enterSubmits( 'chpwBackdrop', saveChangePw );
    [ 'chpwNew', 'chpwNew2' ].forEach( function( id )
    {
        $( id ).addEventListener( 'input', function()
        {
            drawChecks( 'chpwChecks', $( 'chpwNew' ).value, $( 'chpwNew2' ).value );
            drawPhraseWarn( 'chpwHintWarn', $( 'chpwNew' ).value, chpwPhrase );
            sayError( 'chpwErr', '' );
        } );
    } );

    // Settings › Reminder phrase
    $( 'hintSetBtn' ).addEventListener( 'click', openPhraseSheet );
    $( 'hintSaveBtn' ).addEventListener( 'click', savePhrase );
    enterSubmits( 'hintBackdrop', savePhrase );
    [ 'hintEdit', 'hintMaster', 'hintLogin' ].forEach( function( id )
    {
        $( id ).addEventListener( 'input', function() { phraseRows(); sayError( 'hintErr', '' ); } );
    } );
    onClosed( 'hintBackdrop', phraseClosed );
    onClosed( 'chpwBackdrop', chpwClosed );

    // The recovery key: typed in; a new one shown
    $( 'recGoBtn' ).addEventListener( 'click', useRecovery );
    enterSubmits( 'recBackdrop', useRecovery );
    $( 'recShowCopy' ).addEventListener( 'click', function() { copySecret( recShown, 'passwords.recCopied' ); } );
    $( 'recShowPrint' ).addEventListener( 'click', function() { printRecovery( recShown ); } );
    $( 'recShowDone' ).addEventListener( 'click', function() { document.getElementById( 'recShowBackdrop' ).close(); } );
    onClosed( 'recShowBackdrop', function() { $( 'recShowCode' ).textContent = ''; recShown = ''; } );

    // Import / export
    $( 'importPickBtn' ).addEventListener( 'click', pickImportFile );
    $( 'importInput' ).addEventListener( 'change', function( e )
    {
        const f = e.target.files && e.target.files[ 0 ];
        if( f ) importFile( f );
        e.target.value = '';
    } );
    $( 'exportEncBtn' ).addEventListener( 'click', exportEncrypted );
    $( 'exportCsvBtn' ).addEventListener( 'click', exportCsv );
}

//------------------------------------------------------------------------//
// THE GATE

function wireGate()
{
    $( 'unlockBtn' ).addEventListener( 'click', unlockVault );
    $( 'unlockPw' ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' && ! e.isComposing ) { e.preventDefault(); unlockVault(); } } );
    $( 'unlockPw' ).addEventListener( 'input', function() { if( Date.now() >= waitUntil ) sayError( 'unlockErr', '' ); } );
    $( 'useRecoveryBtn' ).addEventListener( 'click', openRecoverySheet );

    [ 'setupPw', 'setupPw2', 'setupHint' ].forEach( function( id )
    {
        $( id ).addEventListener( 'input', function()
        {
            drawChecks( 'setupChecks', $( 'setupPw' ).value, $( 'setupPw2' ).value );
            drawPhraseWarn( 'setupHintWarn', $( 'setupPw' ).value, readPhrase( 'setupHint' ) );
            $( 'setupLoginRow' ).hidden = ! readPhrase( 'setupHint' );
            sayError( 'setupErr', '' );
        } );
        $( id ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' && ! e.isComposing ) { e.preventDefault(); createVault(); } } );
    } );
    $( 'setupLogin' ).addEventListener( 'keydown', function( e ) { if( e.key === 'Enter' && ! e.isComposing ) { e.preventDefault(); createVault(); } } );
    $( 'hintBtn' ).addEventListener( 'click', showPhrase );
    $( 'createBtn' ).addEventListener( 'click', createVault );

    $( 'recCopyBtn' ).addEventListener( 'click', function() { copySecret( recoveryCode, 'passwords.recCopied' ); } );
    $( 'recPrintBtn' ).addEventListener( 'click', function() { printRecovery( recoveryCode ); } );
    $( 'recDoneBtn' ).addEventListener( 'click', recoveryDone );
}

//------------------------------------------------------------------------//
// DROP  -  rows and folders dragged (mouse) onto a tree row, a folder row
// or a crumb go into that folder. A folder into itself or below itself:
// refused, with a toast. Touch has no HTML5 drag: "Move to…" does it.

function treeCan( ids, id )
{
    if( id !== ROOT && ! isFolder( item( id ) ) ) return false;
    return canMove( ids, id ) ? 'inside' : { zone: 'inside', ok: false };
}

function dropInto( ids, id )
{
    if( ids.indexOf( id ) >= 0 ) return;
    doMove( ids, id );
}

function wireDragDrop()
{
    Ayni.dropZone( $( 'listPane' ), {
        sel: '.pw-item.is-folder, .crumb-seg', target: function( el ) { return el.dataset.id; },
        can: treeCan, drop: dropInto
    } );
}

//------------------------------------------------------------------------//
// PANE RESIZER  -  drag the divider; the width is this device's.

const TREE_MIN = 160, TREE_MAX = 520, TREE_DEF = 240;

function applyTreeWidth()
{
    if( ui.treeW >= TREE_MIN && ui.treeW <= TREE_MAX ) document.documentElement.style.setProperty( '--tree-w', ui.treeW + 'px' );
    else document.documentElement.style.removeProperty( '--tree-w' );
}

function wireResizer()
{
    NayiveUI.paneResizer( $( 'paneResizer' ), $( 'treePane' ),
    {
        min: TREE_MIN, max: TREE_MAX, def: TREE_DEF, off: isPhone, save: saveUi,
        set: function( w ) { ui.treeW = w; applyTreeWidth(); }
    } );
}
