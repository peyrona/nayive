// ds-passwords.mjs - Passwords (client/apps/passwords): the vault file is
// only ever written whole, from a vault this page opened, with its version.
//
// P1  Nothing is written before the vault is known: a set-up that the rules
//     refuse, a wrong master password, a file this version cannot read
//     (damaged, a KDF below the floor, a newer format) - all leave the file
//     as it was.
// P2  An entry that will not open (damaged) is never lost: later saves keep
//     it byte for byte.
// P3  Every save carries the version it was made from (If-Match), the first
//     one is create-only (If-None-Match).
// P4  Two devices: saves are merged without the key - added on both, both
//     stay; the same entry changed on both, both versions stay; deleted on
//     one and changed on the other, the change stays.
// P5  Two vaults made at the same time on two devices: the one on the
//     server is never written over.
// P6  Delete + Undo; a new master password, a new recovery key and a
//     reminder phrase leave every entry as it was (same ciphertext); the
//     phrase is saved encrypted, and kept by a new master password.
// P7  Only ciphertext leaves the page: the file, its .bak and the offline
//     cache hold none of the entry.
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, sleep, disk, onDisk } from "./lib.mjs";

const FILE = "data/passwords/passwords.json";
const PW   = "correct horse battery staple 42";
const PW2  = "another long master passphrase 7";

const s = await server( { test: "test", ana: "ana" } );
const c = await browser( s );
const json = u => { try { return JSON.parse( onDisk( s, FILE, u ) ); } catch { return null; } };
const raw  = u => onDisk( s, FILE, u );
const live = u => Object.entries( json( u ).items ).filter( ( [ , e ] ) => e.c && e.x !== 1 );
const put  = ( f, u ) => fs.writeFileSync( path.join( s.home( u ), FILE ), typeof f === "string" ? f : JSON.stringify( f, null, 2 ) );

async function openApp( p )
{
    await p.evaluate( "localStorage.setItem( 'balata-intro-dismiss:passwords', '1' ); true" );
    await p.send( "Page.navigate", { url: "about:blank" } );
    await p.until( "location.href === 'about:blank'" );
    await p.open( "/nayive/passwords/", "/nayive/passwords/" );
    const up = await p.until( "typeof fileState !== 'undefined' && fileState !== 'unknown'", 20000 );
    // Every PUT of the vault file: its checks and the answer.
    await p.evaluate( `( function () { window.__puts = []; var f = window.fetch;
        window.fetch = async function ( u, o ) { var r = await f.apply( this, arguments );
            if( o && o.method === 'PUT' && String( u ).indexOf( 'passwords.json' ) !== -1 ) {
                var h = o.headers || {}; window.__puts.push( { im: h[ 'If-Match' ] || null, inm: h[ 'If-None-Match' ] || null, st: r.status } ); }
            return r; };
        return true; } )()` );
    return up;
}

async function unlock( p, pw )
{
    await p.evaluate( `document.getElementById( 'unlockPw' ).value = ${JSON.stringify( pw )}; unlockVault(); true` );
    await p.until( "isOpen() || ! document.getElementById( 'unlockErr' ).hidden", 30000 );
    return p.evaluate( "isOpen()" );
}

async function create( p, pw )
{
    await p.evaluate( `document.getElementById( 'setupPw' ).value = document.getElementById( 'setupPw2' ).value = ${JSON.stringify( pw )}; createVault(); true` );
    const shown = await p.until( "! document.getElementById( 'recoveryBox' ).hidden", 30000 );
    await p.evaluate( "recoveryDone(); true" );
    return shown;
}

const addEntry = ( p, title, pass ) => p.evaluate( `( function () { var now = nowIso();
    return putItems( [ { id: PwVault.newId(), type: 'login', title: ${JSON.stringify( title )}, user: 'u', pass: ${JSON.stringify( pass || "p" )}, urls: [], notes: '', totp: '', fields: [], folder: '', fav: false, history: [], created: now, updated: now } ] )
        .then( function () { return true; } ); } )()` );

async function answerPassword( p, pw )
{
    await p.until( "!! document.querySelector( 'dialog.panel[open] #askPw1' )" );
    return p.evaluate( `( function () { document.getElementById( 'askPw1' ).value = ${JSON.stringify( pw )};
        var backs = document.querySelectorAll( 'dialog.panel[open]' ), b = backs[ backs.length - 1 ];
        b.querySelector( '.btn.primary' ).click(); return true; } )()` );
}

//----------------------------------------------------------------------------//
section( "P1 · NOTHING WRITTEN BEFORE THE VAULT IS KNOWN" );
{
    ok( await openApp( c ), "Passwords is open" );
    await c.evaluate( "document.getElementById( 'setupPw' ).value = document.getElementById( 'setupPw2' ).value = 'too short'; createVault(); true" );
    await sleep( 1500 );
    ok( raw() === null, "a master password the rules refuse: no file made" );

    ok( await create( c, PW ), "a vault made" );
    ok( await disk( () => json() && json().format === "nayive-passwords" ), "…and on disk" );
    await c.until( "window.__puts.length > 0" );
    const puts0 = await c.evaluate( "window.__puts" );
    ok( puts0.length && puts0[ 0 ].inm === "*", "P3: the first save is create-only (If-None-Match: *)", puts0 );

    await addEntry( c, "Mail", "mail-secret-1" );
    await addEntry( c, "Bank", "bank-secret-2" );
    ok( await disk( () => live().length === 2 ), "two entries saved" );
    await sleep( 2500 );                    // nothing of this page still on its way

    await c.evaluate( "lock(); true" );
    const before = raw(), t0 = fs.statSync( path.join( s.home(), FILE ) ).mtimeMs;
    for( let i = 0; i < 3; i++ ) await unlock( c, "a wrong master password " + i );
    await sleep( 1000 );
    ok( raw() === before && fs.statSync( path.join( s.home(), FILE ) ).mtimeMs === t0, "wrong master passwords: the file untouched" );

    for( const [ why, change ] of [ [ "a damaged header", f => { f.keys = null; } ],
                                    [ "a KDF below the floor", f => { f.kdf.m = 1024; } ],
                                    [ "a newer format", f => { f.v = 2; } ] ] )
    {
        const f = JSON.parse( before );
        change( f );
        put( f );
        const bytes = raw();
        await openApp( c );
        await c.evaluate( "( typeof save === 'function' ) && save(); true" );       // a stray save: refused while not open
        await sleep( 1500 );
        ok( raw() === bytes && await c.evaluate( "! isOpen()" ), why + ": shown, never written over" );
    }
    put( before );
}

//----------------------------------------------------------------------------//
section( "P2 · A DAMAGED ENTRY IS NEVER LOST" );
let ids;
{
    const f = JSON.parse( raw() );
    ids = Object.keys( f.items );
    const hurt = ids[ 0 ];
    const c0 = f.items[ hurt ].c;
    f.items[ hurt ].c = c0.slice( 0, 40 ) + ( c0[ 40 ] === "A" ? "B" : "A" ) + c0.slice( 41 );
    put( f );
    await openApp( c );
    ok( await unlock( c, PW ), "opens" );
    ok( await c.until( "damaged === 1 && Object.keys( items ).length === 1" ), "one entry will not open, the other does" );
    await addEntry( c, "After", "after-secret-3" );
    ok( await disk( () => live().length === 3 ), "a save after it" );
    ok( json().items[ hurt ].c === f.items[ hurt ].c && json().items[ hurt ].r === f.items[ hurt ].r, "…keeps the damaged entry byte for byte" );
    // Put it right again for what follows.
    const g = json();
    g.items[ hurt ].c = c0;
    put( g );
    await openApp( c );
    ok( await unlock( c, PW ), "reopened" );
    ok( await c.until( "damaged === 0 && Object.keys( items ).length === 3" ), "all 3 open" );
}

//----------------------------------------------------------------------------//
section( "P3 · EVERY SAVE CARRIES ITS VERSION" );
{
    await addEntry( c, "Versioned", "v-secret-4" );
    await sleep( 3000 );
    const puts = await c.evaluate( "window.__puts" );
    ok( puts.length && puts.every( x => x.im || x.inm ), "every PUT of the vault had If-Match or If-None-Match", puts );
}

//----------------------------------------------------------------------------//
section( "P4 · TWO DEVICES: MERGED WITHOUT THE KEY, NOTHING LOST" );
{
    const d = await browser( s );
    await openApp( d );
    ok( await unlock( d, PW ), "the second device opens the vault" );
    const n0 = live().length;
    await addEntry( c, "From PC" );
    ok( await disk( () => live().length === n0 + 1 ), "the PC adds one" );
    await addEntry( d, "From phone" );
    ok( await disk( () => live().length === n0 + 2 ), "the phone, from the version before, adds one: merged, both there" );
    const puts = await d.evaluate( "window.__puts" );
    ok( puts.some( x => x.st === 412 ), "(the phone's save met the PC's: 412, then the merge)", puts );

    await c.evaluate( "loadData().then( function () { return true; } )" );
    await d.evaluate( "loadData().then( function () { return true; } )" );
    const mail = "Object.keys( items ).filter( function ( id ) { return items[ id ].title === 'Mail'; } )[ 0 ]";
    await c.evaluate( `putItems( [ Object.assign( {}, item( ${mail} ), { pass: 'pc-changed' } ) ] ).then( function () { return true; } )` );
    await sleep( 1000 );
    await d.evaluate( `putItems( [ Object.assign( {}, item( ${mail} ), { pass: 'phone-changed' } ) ] ).then( function () { return true; } )` );
    ok( await disk( () => live().length === n0 + 3 && ! json().copies, 20000 ), "the same entry changed on both: both versions are entries now" );
    await d.evaluate( "loadData().then( function () { return true; } )" );
    ok( await d.until( "allEntries().some( function ( n ) { return n.pass === 'pc-changed'; } ) && allEntries().some( function ( n ) { return n.pass === 'phone-changed'; } )" ),
        "…the phone shows both" );

    await c.evaluate( "loadData().then( function () { return true; } )" );
    await d.evaluate( "loadData().then( function () { return true; } )" );
    const bank = "Object.keys( items ).filter( function ( id ) { return items[ id ].title === 'Bank'; } )[ 0 ]";
    await c.evaluate( `deleteItems( [ ${bank} ] ).then( function () { return true; } )` );
    await sleep( 1000 );
    await d.evaluate( `putItems( [ Object.assign( {}, item( ${bank} ), { pass: 'bank-changed' } ) ] ).then( function () { return true; } )` );
    await sleep( 3000 );
    await c.evaluate( "loadData().then( function () { return true; } )" );
    ok( await c.until( "allEntries().some( function ( n ) { return n.pass === 'bank-changed'; } )" ), "deleted on the PC, changed on the phone: the change stays" );
    await d.stop();
}

//----------------------------------------------------------------------------//
section( "P5 · TWO VAULTS MADE AT ONCE: THE SERVER'S IS NEVER WRITTEN OVER" );
{
    const a = await browser( s, { user: "ana", password: "ana" } );
    ok( await openApp( a ), "ana opens Passwords: no vault yet" );
    ok( await a.evaluate( "fileState === 'empty'" ), "…the set-up shows" );
    // Meanwhile her phone made one (any valid vault file will do: test's).
    const phone = await s.client( "ana", "ana" );
    const theirs = raw();
    const r = await phone.put( FILE, theirs );
    ok( r.status === 200 || r.status === 201, "her phone's vault is on the server" );
    ok( await create( a, PW2 ), "this page makes its own (it read \"empty\" before)" );
    await sleep( 4000 );
    ok( raw( "ana" ) === theirs, "the phone's vault is still the file, untouched" );
    const puts = await a.evaluate( "window.__puts" );
    ok( puts.some( x => x.st === 412 ) && puts.every( x => x.st !== 200 && x.st !== 201 ), "this page's save was refused (412), never sent blind", puts );
    await a.stop();
}

//----------------------------------------------------------------------------//
section( "P6 · DELETE + UNDO; NEW MASTER PASSWORD AND RECOVERY KEY KEEP EVERY ENTRY" );
{
    const n0 = live().length;
    await c.evaluate( "deleteNodes( [ Object.keys( items )[ 0 ] ] ); true" );
    ok( await disk( () => live().length === n0 - 1 ), "deleted" );
    await c.evaluate( "( document.querySelector( '#ayni-toasts .toast.undo .act' ) || { click: function () {} } ).click(); true" );
    ok( await disk( () => live().length === n0 ), "Undo: back" );
    await sleep( 1000 );

    const entries = JSON.stringify( json().items );
    await c.evaluate( `openPhraseSheet(); document.getElementById( 'hintEdit' ).value = 'the ds reminder';
                       document.getElementById( 'hintMaster' ).value = ${JSON.stringify( PW )}; document.getElementById( 'hintLogin' ).value = 'test'; savePhrase(); true` );
    ok( await c.until( "! document.getElementById( 'hintBackdrop' ).open", 30000 ), "a reminder phrase saved" );
    ok( await disk( () => json().hint && json().hint.c ) && raw().indexOf( "ds reminder" ) < 0, "…encrypted in the file" );
    ok( JSON.stringify( json().items ) === entries, "…every entry exactly as it was" );
    const hint = JSON.stringify( json().hint );

    await c.evaluate( `openChangePw( false ); document.getElementById( 'chpwCur' ).value = ${JSON.stringify( PW )};
                       document.getElementById( 'chpwNew' ).value = document.getElementById( 'chpwNew2' ).value = ${JSON.stringify( PW2 )}; saveChangePw(); true` );
    ok( await c.until( "! document.getElementById( 'chpwBackdrop' ).open", 30000 ), "a new master password saved" );
    await sleep( 1500 );
    ok( JSON.stringify( json().items ) === entries, "…every entry exactly as it was (same ciphertext)" );
    ok( JSON.stringify( json().hint ) === hint, "…and the reminder phrase too" );
    await c.evaluate( "lock(); true" );
    ok( ! await unlock( c, PW ), "the old one no longer opens it" );
    ok( await unlock( c, PW2 ), "the new one does" );

    await c.evaluate( "newRecoveryKey(); true" );
    await answerPassword( c, PW2 );
    ok( await c.until( "document.getElementById( 'recShowBackdrop' ).open", 30000 ), "a new recovery key" );
    await sleep( 1500 );
    ok( JSON.stringify( json().items ) === entries, "…every entry exactly as it was" );
    await c.evaluate( "document.getElementById( 'recShowBackdrop' ).close(); true" );
}

//----------------------------------------------------------------------------//
section( "P7 · ONLY CIPHERTEXT LEAVES THE PAGE" );
{
    const secrets = [ "mail-secret-1", "bank-secret-2", "after-secret-3", "v-secret-4", "pc-changed", "phone-changed", "bank-changed", "Mail", "From PC" ];
    const clean = t => ! secrets.some( x => String( t ).indexOf( x ) >= 0 );
    ok( clean( raw() ), "the vault file: no entry readable" );
    const bak = onDisk( s, "data/passwords/.bak/passwords.json" );
    ok( bak === null || clean( bak ), "its .bak: none either" );
    const idb = await c.evaluate( `new Promise( function ( res ) {
        var rq = indexedDB.open( 'nube-store' );
        rq.onsuccess = function () {
            var db = rq.result, out = [], names = Array.from( db.objectStoreNames ), left = names.length;
            if( ! left ) return res( '' );
            names.forEach( function ( n ) {
                var all = db.transaction( n ).objectStore( n ).getAll();
                all.onsuccess = function () { out.push( JSON.stringify( all.result, function ( k, v ) { return v instanceof Uint8Array ? new TextDecoder().decode( v ) : v; } ) ); if( ! --left ) res( out.join( '\\n' ) ); };
                all.onerror = function () { if( ! --left ) res( out.join( '\\n' ) ); };
            } );
        };
        rq.onerror = function () { res( '' ); };
    } )` );
    ok( idb.indexOf( "nayive-passwords" ) >= 0 && clean( idb ), "the offline cache and outbox: the vault, ciphertext only" );
}

await done( s, c );
