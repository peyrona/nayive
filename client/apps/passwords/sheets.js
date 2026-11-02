// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * sheets.js - Passwords: the entry sheet (add / see / edit), the folder
 * sheet, "Move to…", the deletes (at once, with Undo), favourites, copying
 * to the clipboard (cleared after a while) and opening a site.
 */
"use strict";

let editId     = null;    // the entry being edited, or null for a new one
let editType   = 'login'; // the new entry's kind (the pills)
let folderEdit = null;    // the folder being renamed, or null for a new one

// The indented folder list every picker shares. `skip`: a folder and all
// below it may not be offered (moving that folder).
function fillFolderSelect( sel, chosen, skip )
{
    sel.innerHTML = folderList().filter( function( e ) { return ! skip || ! isInside( e.id, skip ); } ).map( function( e )
    {
        return '<option value="' + esc( e.id ) + '"' + ( e.id === chosen ? ' selected' : '' ) + '>' +
               '   '.repeat( e.depth ) + esc( e.name ) + '</option>';
    } ).join( '' );
    if( ! sel.value ) sel.value = ROOT;
}

// Where a new thing goes: the folder on screen, or the top while a search
// or a filter is showing.
function targetFolder() { return ! query && filter === 'all' ? curFolder : ROOT; }

// Every secret box starts hidden again, its eye (Ayni's [data-reveal]) shut.
function hideSecrets( root )
{
    root.querySelectorAll( '[data-reveal]' ).forEach( function( b )
    {
        const input = b.closest( '.input-group' ).querySelector( 'input' );
        if( input ) input.type = 'password';
        b.setAttribute( 'aria-pressed', 'false' );
        Ayni.setIcon( b, 'eye' );
        Ayni.setTip( b, Ayni.t( 'ayni.password.show' ) );
        b.setAttribute( 'aria-label', b.dataset.tip );
    } );
}

//------------------------------------------------------------------------//
// ENTRY SHEET

function openItemSheet( id )
{
    if( ! isOpen() ) return;
    const n = id ? item( id ) : null;
    editId   = n ? n.id : null;
    editType = n ? n.type : 'login';

    $( 'itemTitle' ).textContent = n ? ( n.title || T( 'ui.untitled' ) ) : T( 'passwords.newItem' );
    $( 'itName' ).value  = n ? n.title : '';
    $( 'itUser' ).value  = n ? n.user || '' : '';
    $( 'itPass' ).value  = n ? n.pass || '' : '';
    $( 'itUrls' ).value  = n ? ( n.urls || [] ).join( '\n' ) : '';
    $( 'itNotes' ).value = n ? n.notes || '' : '';
    $( 'itTotp' ).value  = n ? n.totp || '' : '';
    $( 'itFav' ).checked = n ? !! n.fav : false;
    fillFolderSelect( $( 'itFolder' ), n ? parentOf[ n.id ] : targetFolder() );
    drawFields( n ? n.fields || [] : [] );
    $( 'itMore' ).open = !! ( n && ( n.totp || ( n.fields && n.fields.length ) || ( n.type !== 'note' && n.notes ) ) );
    drawHistory( n );
    $( 'itDates' ).textContent = n && n.updated ? TF( 'passwords.changedOn', { date: fmtDate( n.updated ) } ) : '';
    $( 'itDeleteBtn' ).hidden = ! n;
    $( 'itemTypeRow' ).hidden = !! n;
    setItemType( editType );
    hideSecrets( $( 'itemBackdrop' ) );
    fitUrls();

    document.getElementById( 'itemBackdrop' ).showModal();
    if( ! n ) setTimeout( function() { $( 'itName' ).focus(); }, 0 );
}

function setItemType( type )
{
    editType = type === 'note' ? 'note' : 'login';
    document.querySelectorAll( '#itemTypeRow .pill' ).forEach( function( p ) { p.classList.toggle( 'is-active', p.dataset.type === editType ); } );
    document.querySelectorAll( '#itemBackdrop .pw-login-only' ).forEach( function( el ) { el.hidden = editType !== 'login'; } );
    $( 'itNotes' ).rows = editType === 'note' ? 8 : 3;
    // A login keeps its notes under "More fields"; a note's text is the note itself.
    if( editType === 'note' ) $( 'itMore' ).before( $( 'itNotesField' ) );
    else                      $( 'itMore' ).querySelector( 'summary' ).after( $( 'itNotesField' ) );
}

// The sites box grows with its lines (one per line).
function fitUrls()
{
    const ta = $( 'itUrls' );
    ta.rows = Math.min( 5, Math.max( 1, ta.value.split( '\n' ).length ) );
}

function fmtDate( iso )
{
    const d = new Date( iso );
    if( isNaN( d ) ) return iso;
    return d.toLocaleDateString( Ayni.i18n.lang(), { day: 'numeric', month: 'short', year: 'numeric' } ) + ' ' +
           d.toLocaleTimeString( Ayni.i18n.lang(), { hour: '2-digit', minute: '2-digit' } );
}

// The extra fields: a name, then the value with its buttons - eye (secret
// ones), "secret" on / off, copy, remove.
function drawFields( list )
{
    const host = $( 'itFields' );
    host.innerHTML = '';
    list.forEach( addFieldRow );
}

function addFieldRow( f )
{
    f = f || { name: '', value: '', hidden: false };
    const row = document.createElement( 'div' );
    row.className = 'pw-xfield';
    row.innerHTML =
        '<input class="input pf-name" type="text" autocomplete="off" spellcheck="false" placeholder="' + esc( T( 'passwords.fieldName' ) ) + '" aria-label="' + esc( T( 'passwords.fieldName' ) ) + '">' +
        '<div class="input-group pw-line">' +
            '<input class="input pf-value pw-mono" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="' + esc( T( 'passwords.fieldValue' ) ) + '" aria-label="' + esc( T( 'passwords.fieldValue' ) ) + '">' +
            '<button type="button" class="btn" data-f="secret"></button>' +
            '<button type="button" class="btn" data-f="copy" data-tip="' + esc( T( 'ui.copy' ) ) + '" aria-label="' + esc( T( 'ui.copy' ) ) + '">' + Ayni.icon( 'copy' ) + '</button>' +
            '<button type="button" class="btn" data-f="remove" data-tip="' + esc( T( 'ui.delete' ) ) + '" aria-label="' + esc( T( 'ui.delete' ) ) + '">' + Ayni.icon( 'trash' ) + '</button>' +
        '</div>';
    row.querySelector( '.pf-name' ).value  = f.name;
    row.querySelector( '.pf-value' ).value = f.value;
    setFieldSecret( row, !! f.hidden );
    $( 'itFields' ).appendChild( row );
    return row;
}

// A secret field's value is dotted; its lock button says so.
function setFieldSecret( row, on )
{
    row.dataset.secret = on ? '1' : '';
    row.querySelector( '.pf-value' ).type = on ? 'password' : 'text';
    const b = row.querySelector( '[data-f="secret"]' );
    b.innerHTML = Ayni.icon( 'lock' );
    b.setAttribute( 'aria-pressed', on ? 'true' : 'false' );
    Ayni.setTip( b, T( on ? 'passwords.fieldSecretOff' : 'passwords.fieldSecretOn' ) );
    b.setAttribute( 'aria-label', b.dataset.tip );
}

function readFields()
{
    return Array.from( document.querySelectorAll( '#itFields .pw-xfield' ) ).map( function( row )
    {
        return { name: row.querySelector( '.pf-name' ).value.trim(), value: row.querySelector( '.pf-value' ).value,
                 hidden: row.dataset.secret === '1' };
    } ).filter( function( f ) { return f.name || f.value; } );
}

// The passwords this entry had before (newest first), each with copy.
function drawHistory( n )
{
    const box = $( 'itHistory' );
    const list = n && n.history ? n.history : [];
    box.hidden = ! list.length;
    box.open = false;
    $( 'itHistorySum' ).textContent = TF( 'passwords.historyN', { n: list.length } );
    $( 'itHistoryList' ).innerHTML = list.map( function( h, i )
    {
        return '<div class="pw-hist-row"><span class="pw-hist-date">' + esc( h.at ? fmtDate( h.at ) : '' ) + '</span>' +
               '<span class="pw-hist-pass pw-mono">••••••••</span>' +
               '<button type="button" class="btn sm" data-hist="' + i + '" data-tip="' + esc( T( 'passwords.copyPass' ) ) + '" aria-label="' + esc( T( 'passwords.copyPass' ) ) + '">' + Ayni.icon( 'copy' ) + '</button></div>';
    } ).join( '' );
}

function copyHistory( i )
{
    const n = editId ? item( editId ) : null;
    const h = n && n.history ? n.history[ i ] : null;
    if( h ) copySecret( h.pass, 'passwords.passCopied' );
}

function saveItemSheet()
{
    if( ! canEdit() ) return;
    const old  = editId ? item( editId ) : null;
    const urls = $( 'itUrls' ).value.split( '\n' ).map( function( u ) { return u.trim(); } ).filter( Boolean );
    const login = editType === 'login';
    const now  = nowIso();
    const n = Object.assign( {}, old || {}, {
        id:     old ? old.id : PwVault.newId(),
        type:   editType,
        title:  $( 'itName' ).value.trim(),
        user:   login ? $( 'itUser' ).value.trim() : ( old ? old.user || '' : '' ),
        pass:   login ? $( 'itPass' ).value : ( old ? old.pass || '' : '' ),
        urls:   login ? urls : ( old ? old.urls || [] : [] ),
        notes:  $( 'itNotes' ).value,
        totp:   login ? $( 'itTotp' ).value.trim() : ( old ? old.totp || '' : '' ),
        fields: readFields(),
        folder: $( 'itFolder' ).value || ROOT,
        fav:    $( 'itFav' ).checked,
        history: old && old.history ? old.history.slice() : [],
        created: old && old.created ? old.created : now,
        updated: now
    } );
    if( ! n.title ) n.title = domainOf( urls[ 0 ] || '' ) || n.user || '';
    if( ! n.title && ! n.pass && ! n.notes && ! n.user ) { $( 'itName' ).focus(); return; }

    // The password it replaces goes to the history (newest first).
    if( old && old.pass && old.pass !== n.pass )
        n.history = [ { pass: old.pass, at: now } ].concat( n.history ).slice( 0, HISTORY_N );

    // Nothing changed: nothing written (and no new revision).
    if( old && JSON.stringify( sealedForm( Object.assign( {}, n, { updated: old.updated } ) ) ) === JSON.stringify( sealedForm( old ) ) )
    {
        document.getElementById( 'itemBackdrop' ).close();
        return;
    }

    putItems( [ n ] ).then( function()
    {
        document.getElementById( 'itemBackdrop' ).close();
        render();
    }, function() {} );
}

//------------------------------------------------------------------------//
// FOLDER SHEET

function openFolderSheet( id, parentId )
{
    if( ! isOpen() ) return;
    const f = id ? item( id ) : null;
    folderEdit = f ? f.id : null;
    $( 'folderTitle' ).textContent = T( f ? 'ui.rename' : 'ui.newFolder' );
    $( 'folderName' ).value = f ? f.title : '';
    fillFolderSelect( $( 'folderParent' ), f ? parentOf[ f.id ] : ( parentId != null ? parentId : targetFolder() ), f ? f.id : null );
    document.getElementById( 'folderBackdrop' ).showModal();
    const input = $( 'folderName' );
    setTimeout( function() { input.focus(); input.select(); }, 0 );
}

function saveFolderSheet()
{
    if( ! canEdit() ) return;
    const name = $( 'folderName' ).value.trim();
    if( ! name ) { $( 'folderName' ).focus(); return; }
    const dest = $( 'folderParent' ).value || ROOT;
    const old  = folderEdit ? item( folderEdit ) : null;
    if( old && dest !== ROOT && isInside( dest, old.id ) ) { Ayni.toast( 'warn', T( 'passwords.cycle' ) ); return; }
    const now = nowIso();
    const f = Object.assign( {}, old || {}, { id: old ? old.id : PwVault.newId(), type: 'folder', title: name, folder: dest,
                                              created: old && old.created ? old.created : now, updated: now } );
    putItems( [ f ] ).then( function()
    {
        if( ! old ) revealInTree( f.id );
        document.getElementById( 'folderBackdrop' ).close();
        render();
    }, function() {} );
}

//------------------------------------------------------------------------//
// MOVE TO…  -  the shared dialog (Ayni.pickNode) with the side pane's
// tree, "All" on top. A folder can not go into itself or below it.

async function openMoveSheet( ids )
{
    ids = ids.filter( function( id ) { return !! item( id ); } );
    if( ! ids.length || ! canEdit() ) return;
    const folders = ids.filter( function( id ) { return isFolder( item( id ) ); } );
    const dest = await Ayni.pickNode( {
        title:    ids.length === 1 ? TF( 'passwords.moveOne', { name: item( ids[ 0 ] ).title || T( 'ui.untitled' ) } )
                                   : TF( 'passwords.moveN', { n: ids.length } ),
        okLabel:  T( 'passwords.moveHere' ),
        items:    function() { return [ { id: '/', name: T( 'passwords.all' ), children: treeRoots() } ]; },
        current:  parentOf[ ids[ 0 ] ] || '/',
        disabled: function( id ) { return id !== '/' && folders.some( function( f ) { return isInside( id, f ); } ); }
    } );
    if( dest != null ) doMove( ids, dest === '/' ? ROOT : dest );
}

function canMove( ids, dest )
{
    if( dest !== ROOT && ! isFolder( item( dest ) ) ) return false;
    return ids.every( function( id ) { return dest === ROOT || ! isInside( dest, id ); } );
}

// Already all there: nothing to do, nothing said.
function doMove( ids, dest )
{
    ids = ids.filter( function( id ) { return !! item( id ); } );
    if( ids.every( function( id ) { return parentOf[ id ] === dest; } ) ) return true;
    if( ! canEdit() ) return false;
    if( ! canMove( ids, dest ) ) { Ayni.toast( 'warn', T( 'passwords.cycle' ) ); return false; }
    const now = nowIso();
    const list = ids.filter( function( id ) { return parentOf[ id ] !== dest; } )
                    .map( function( id ) { return Object.assign( {}, item( id ), { folder: dest, updated: now } ); } );
    putItems( list ).then( function()
    {
        Ayni.toast( 'ok', TF( 'passwords.movedTo', { name: folderName( item( dest ) ) } ) );
        render();
    }, function() {} );
    return true;
}

//------------------------------------------------------------------------//
// DELETE  -  at once, with Undo: an entry, a folder with all it holds, or
// many. No "Are you sure?" (the item-browser rule); Undo puts it all back.

function deleteNodes( ids )
{
    ids = ids.filter( function( id ) { return !! item( id ); } );
    if( ! ids.length || ! canEdit() ) return;
    const all = new Set();
    for( const id of ids )
    {
        all.add( id );
        if( isFolder( item( id ) ) ) descendants( id ).forEach( function( d ) { all.add( d.id ); } );
    }
    deleteItems( Array.from( all ) ).then( function( gone )
    {
        pruneState();
        render();
        if( ! gone.length ) return;
        Ayni.toast( 'ok', ids.length === 1 ? T( 'passwords.deleted' ) : TF( 'passwords.deletedN', { n: ids.length } ), { undo: function()
        {
            putItems( gone ).then( function() { render(); }, function() {} );
        } } );
    }, function() {} );
}

//------------------------------------------------------------------------//
// SMALL ACTIONS

// Many at once: all become favourites unless all already are (then none).
function setFavourite( ids )
{
    const list = ids.map( item ).filter( function( n ) { return n && ! isFolder( n ); } );
    if( ! list.length || ! canEdit() ) return;
    const on = list.some( function( n ) { return ! n.fav; } );
    putItems( list.filter( function( n ) { return !! n.fav !== on; } ).map( function( n ) { return Object.assign( {}, n, { fav: on } ); } ) )
        .then( function() { render(); }, function() {} );
}

// A site to open: the first address, https:// added to a bare host. Only the
// web: anything else stays saved but is not opened.
function siteUrl( raw )
{
    let s = String( raw || '' ).trim();
    if( ! s ) return null;
    if( ! /^[a-z][a-z0-9+.-]*:\/\//i.test( s ) ) s = 'https://' + s.replace( /^\/+/, '' );
    try
    {
        const u = new URL( s );
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    }
    catch( e ) { return null; }
}

function openSite( raw )
{
    const url = siteUrl( raw );
    if( ! url ) { Ayni.toast( 'warn', T( 'passwords.cannotOpen' ) ); return; }
    const w = window.open( url, '_blank', 'noopener,noreferrer' );
    if( w ) try { w.opener = null; } catch( e ) {}
}

//------------------------------------------------------------------------//
// CLIPBOARD  -  a copied secret is wiped from the clipboard after
// ui.clipSec seconds (Settings). A browser lets a page write the clipboard
// only while it has the focus: when the time comes and it has not, the
// wipe waits for the focus to come back (5 minutes at most - after that the
// clipboard may well hold something else of the user's).

let clipTimer = 0;
let clipOwed  = 0;      // when a wipe is owed (ms), 0 = none

function copySecret( text, doneKey )
{
    if( ! text ) return;
    NayiveUI.copyText( text ).then( function()
    {
        Ayni.toast( 'ok', TF( 'passwords.copiedFor', { what: T( doneKey ), n: ui.clipSec } ) );
        clearTimeout( clipTimer );
        clipOwed  = 0;
        clipTimer = setTimeout( wipeClipboard, ui.clipSec * 1000 );
    }, function() { Ayni.toast( 'err', T( 'passwords.copyFailed' ) ); } );
}

function wipeClipboard()
{
    clearTimeout( clipTimer );
    if( ! clipOwed ) clipOwed = Date.now();
    if( Date.now() - clipOwed > 5 * 60000 ) { clipOwed = 0; return; }
    if( ! document.hasFocus() || ! navigator.clipboard || ! navigator.clipboard.writeText ) return;
    navigator.clipboard.writeText( '' ).then( function() { clipOwed = 0; }, function() {} );
}

window.addEventListener( 'focus', function() { if( clipOwed ) wipeClipboard(); } );

function copyFromItem( id, what )
{
    const n = item( id );
    if( ! n ) return;
    if( what === 'user' ) NayiveUI.copyText( n.user ).then( function() { Ayni.toast( 'ok', T( 'passwords.userCopied' ) ); }, function() {} );
    else copySecret( n.pass, 'passwords.passCopied' );
}

function goFolder( id )
{
    if( id !== ROOT && ! isFolder( item( id ) ) ) return;
    curFolder = id;
    filter    = 'all';
    if( query ) { query = ''; $( 'searchInput' ).value = ''; }
    if( id !== ROOT ) revealInTree( id );
    render();
    $( 'listPane' ).scrollTop = 0;
}
