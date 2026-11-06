// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * io.js - Passwords: import and export.
 *
 * IMPORT reads the file in this browser - it is never uploaded - and ADDS:
 *   - a CSV from another password manager. The columns are found by their
 *     names (Chrome, Edge, Firefox, Safari, Bitwarden, KeePassXC, 1Password,
 *     LastPass, Proton Pass); a folder / group column makes folders ("A/B",
 *     "A\B"; KeePassXC's "Root/" left out). An entry already here (same name,
 *     user, password and first site) is not added twice.
 *   - an encrypted backup made here (Export): its master password is asked,
 *     and the entries it has that this vault has not are added.
 * EXPORT
 *   - encrypted: the vault file as it is (it opens with the master password
 *     it had that day).
 *   - plain CSV, Bitwarden's columns: the master password first, then a
 *     download. Never into a Nayive folder: the server must not hold it.
 */
"use strict";

//------------------------------------------------------------------------//
// CSV  -  RFC 4180: quotes, "" inside quotes, line breaks inside quotes,
// CRLF or LF, a byte-order mark. -> rows of strings.

function parseCsv( text )
{
    const rows = [];
    let row = [], cell = '', q = false, i = 0;
    const s = text.charCodeAt( 0 ) === 0xFEFF ? text.slice( 1 ) : text;
    for( ; i < s.length; i++ )
    {
        const ch = s[ i ];
        if( q )
        {
            if( ch === '"' ) { if( s[ i + 1 ] === '"' ) { cell += '"'; i++; } else q = false; }
            else cell += ch;
        }
        else if( ch === '"' ) q = true;
        else if( ch === ',' ) { row.push( cell ); cell = ''; }
        else if( ch === '\n' || ch === '\r' )
        {
            if( ch === '\r' && s[ i + 1 ] === '\n' ) i++;
            row.push( cell ); rows.push( row ); row = []; cell = '';
        }
        else cell += ch;
    }
    if( cell !== '' || row.length ) { row.push( cell ); rows.push( row ); }
    return rows.filter( function( r ) { return r.some( function( c ) { return c.trim() !== ''; } ); } );
}

function csvCell( v )
{
    return '"' + String( v == null ? '' : v ).replace( /"/g, '""' ) + '"';
}

// Column names each manager uses, lower case.
const COLS = {
    title:  [ 'name', 'title', 'account', 'item name' ],
    url:    [ 'login_uri', 'url', 'uri', 'urls', 'website', 'web site', 'login url' ],
    user:   [ 'login_username', 'username', 'user name', 'user', 'login', 'email', 'e-mail' ],
    pass:   [ 'login_password', 'password' ],
    notes:  [ 'notes', 'note', 'extra', 'comments' ],
    folder: [ 'folder', 'group', 'grouping', 'vault' ],
    totp:   [ 'login_totp', 'totp', 'otpauth', 'one-time password' ],
    fav:    [ 'favorite', 'favourite', 'fav' ],
    type:   [ 'type' ],
    fields: [ 'fields' ]
};

// The header row -> { title: index, … } (-1 = none), or null when it has
// neither a password nor a notes column (not a password export).
function mapColumns( head )
{
    const names = head.map( function( h ) { return String( h ).trim().toLowerCase(); } );
    const map = {};
    for( const k of Object.keys( COLS ) )
    {
        map[ k ] = -1;
        for( const alias of COLS[ k ] ) { const at = names.indexOf( alias ); if( at >= 0 ) { map[ k ] = at; break; } }
    }
    // Proton Pass has both: the user name first, the e-mail when it is empty.
    map.email = names.indexOf( 'email' );
    map.group = names[ map.folder ] === 'group';         // KeePassXC: "Root/…"
    return map.pass >= 0 || map.notes >= 0 ? map : null;
}

function rowToEntry( r, map, now )
{
    const get = function( k ) { return map[ k ] >= 0 && map[ k ] < r.length ? String( r[ map[ k ] ] ) : ''; };
    const type = get( 'type' ).trim().toLowerCase();
    const urls = get( 'url' ).split( /[\n,]/ ).map( function( u ) { return u.trim(); } ).filter( Boolean );
    let user = get( 'user' ).trim();
    if( ! user && map.email >= 0 && map.email < r.length ) user = String( r[ map.email ] ).trim();
    const n = {
        type:   ( type === 'note' || type === 'securenote' || type === 'secure note' ) ? 'note' : 'login',
        title:  get( 'title' ).trim(),
        user:   user,
        pass:   get( 'pass' ),
        urls:   urls,
        notes:  get( 'notes' ),
        totp:   get( 'totp' ).trim(),
        fields: get( 'fields' ).split( '\n' ).map( function( l )
                {
                    const at = l.indexOf( ': ' );
                    return at > 0 ? { name: l.slice( 0, at ).trim(), value: l.slice( at + 2 ), hidden: false } : null;
                } ).filter( Boolean ),
        fav:    /^(1|true|yes|x)$/i.test( get( 'fav' ).trim() ),
        folder: ROOT, history: [], created: now, updated: now
    };
    if( ! n.title ) n.title = domainOf( urls[ 0 ] || '' ) || n.user;
    if( ! n.title && ! n.pass && ! n.notes && ! n.user ) return null;
    n._path = get( 'folder' ).split( /[\/\\]/ ).map( function( x ) { return x.trim(); } ).filter( Boolean );
    if( map.group && n._path[ 0 ] === 'Root' ) n._path.shift();
    return n;
}

function dupKey( n ) { return [ Ayni.fold( n.title || '' ), n.user || '', n.pass || '', ( n.urls || [] )[ 0 ] || '' ].join( '\u0001' ); }

// A folder path under the top -> its id; the folders that are missing are
// made (into `made`, to be saved with the entries).
function folderFor( path, made )
{
    let parent = ROOT;
    for( const name of path )
    {
        const want = Ayni.fold( name );
        const pool = Object.keys( items ).map( item ).concat( made )
                           .filter( function( f ) { return isFolder( f ) && ( f.id in parentOf ? parentOf[ f.id ] : f.folder || ROOT ) === parent; } );
        let f = pool.find( function( x ) { return Ayni.fold( x.title ) === want; } );
        if( ! f )
        {
            const now = nowIso();
            f = { id: PwVault.newId(), type: 'folder', title: name, folder: parent, created: now, updated: now };
            made.push( f );
        }
        parent = f.id;
    }
    return parent;
}

function importCsv( text )
{
    const rows = parseCsv( text );
    const map  = rows.length ? mapColumns( rows[ 0 ] ) : null;
    if( ! map ) { Ayni.toast( 'err', T( 'passwords.importUnknown' ) ); return; }
    const now  = nowIso();
    const have = new Set( allEntries().map( dupKey ) );
    const folders = [], list = [];
    let skipped = 0;
    for( const r of rows.slice( 1 ) )
    {
        const n = rowToEntry( r, map, now );
        if( ! n ) continue;
        const k = dupKey( n );
        if( have.has( k ) ) { skipped++; continue; }
        have.add( k );
        n.folder = n._path.length ? folderFor( n._path, folders ) : ROOT;
        delete n._path;
        n.id = PwVault.newId();
        list.push( n );
    }
    finishImport( folders.concat( list ), list.length, skipped, true );
}

// An encrypted backup: its own master password opens it; what this vault
// lacks (by id) is added, folders included.
async function importBackup( f )
{
    const pw = await Ayni.ask( { password: true, title: T( 'passwords.importBackup' ), lead: T( 'passwords.importBackupAsk' ),
                                             okTip: T( 'passwords.continue' ) } );
    if( pw === null || ! isOpen() ) return;
    let k;
    try { k = await PwVault.unlock( f, { password: pw } ); }
    catch( e ) { Ayni.toast( ( e && e.message === 'wrong' ? 'warn' : 'err' ), T( e && e.message === 'wrong' ? 'passwords.wrongPw' : 'passwords.kdfFailed' ) ); return; }
    const list = [];
    let skipped = 0, bad = 0;
    for( const id of Object.keys( f.items ) )
    {
        const e = f.items[ id ];
        if( ! PwVault.isLive( e ) ) continue;
        if( item( id ) || ( env.items[ id ] && PwVault.isLive( env.items[ id ] ) ) ) { skipped++; continue; }
        try
        {
            const n = cleanItem( await PwVault.openItem( k, id, e.r, e.c ) );
            n.id = id;
            list.push( n );
        }
        catch( err ) { bad++; }
    }
    if( bad ) Ayni.toast( 'warn', TF( 'passwords.damagedN', { n: bad } ) );
    finishImport( list, list.filter( function( n ) { return ! isFolder( n ); } ).length, skipped, false );
}

function finishImport( list, added, skipped, wasCsv )
{
    document.getElementById( 'importBackdrop' ).close();
    if( ! list.length )
    {
        Ayni.toast( ( skipped ? 'info' : 'warn' ), skipped ? TF( 'passwords.importNone', { n: skipped } ) : T( 'passwords.importEmpty' ) );
        return;
    }
    putItems( list ).then( function()
    {
        render();
        const msg = TF( 'passwords.imported', { n: added } ) + ( skipped ? ' ' + TF( 'passwords.importSkipped', { n: skipped } ) : '' );
        if( wasCsv ) Ayni.alert( { title: msg, body: T( 'passwords.deleteCsv' ) } );
        else Ayni.toast( "ok", msg );
    }, function() {} );
}

function importFile( file )
{
    if( ! canEdit() ) return;
    const reader = new FileReader();
    reader.onload = function()
    {
        const text = String( reader.result || '' );
        let json = null;
        if( /^\s*\{/.test( text ) ) try { json = JSON.parse( text ); } catch( e ) { json = null; }
        if( json )
        {
            const st = PwVault.check( json );
            if( st === 'ok' ) importBackup( json );
            else Ayni.toast( ( st === 'newer' ? 'warn' : 'err' ), T( st === 'newer' ? 'passwords.newerTitle' : 'passwords.importUnknown' ) );
        }
        else importCsv( text );
    };
    reader.onerror = function() { Ayni.toast( 'err', T( 'passwords.importUnknown' ) ); };
    reader.readAsText( file );
}

function pickImportFile()
{
    const input = $( 'importInput' );
    input.value = '';
    input.click();
}

//------------------------------------------------------------------------//
// EXPORT

function stamp() { return new Date().toISOString().slice( 0, 10 ); }

function exportEncrypted()
{
    if( ! isOpen() ) return;
    Ayni.saveFile( serialize(), 'passwords-' + stamp() + '.json', 'application/json' );
    document.getElementById( 'exportBackdrop' ).close();
    Ayni.toast( 'ok', T( 'passwords.exportedEnc' ) );
}

async function exportCsv()
{
    if( ! isOpen() ) return;
    if( ! await confirmMaster( T( 'passwords.exportCsv' ), T( 'passwords.exportCsvAsk' ) ) ) return;
    const head = [ 'folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp' ];
    const lines = [ head.join( ',' ) ];
    for( const n of sortByName( allEntries() ) )
    {
        lines.push( [
            ancestry( parentOf[ n.id ] ).map( function( f ) { return f.title; } ).join( '/' ),
            n.fav ? '1' : '', n.type === 'note' ? 'note' : 'login', n.title, n.notes,
            n.fields.map( function( f ) { return f.name + ': ' + f.value; } ).join( '\n' ), '',
            n.type === 'login' ? n.urls.join( ',' ) : '', n.type === 'login' ? n.user : '',
            n.type === 'login' ? n.pass : '', n.type === 'login' ? n.totp : ''
        ].map( csvCell ).join( ',' ) );
    }
    Ayni.saveFile( lines.join( '\r\n' ) + '\r\n', 'passwords-' + stamp() + '.csv', 'text/csv' );
    document.getElementById( 'exportBackdrop' ).close();
    Ayni.alert( { title: T( 'passwords.exportedCsv' ), body: T( 'passwords.deleteCsvAfter' ) } );
}
