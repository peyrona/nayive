// ds-office-vault.mjs - the account's ONE key for every locked document
// (shared/ayni/ayni-vault.js + ayni-crypt.js v2), in the real Text app over
// the real server: what reaches the disk when a document is locked, reopened,
// moved from its own old password, opened with the recovery code, unlocked.
//
//   V1  locking: the vault is set up; the file on disk is v2 and holds no
//       plain text; data/vault.json holds no password
//   V2  a new page asks the lock password and opens it; an edit is saved v2
//   V3  an old document with its own password moves to the vault at its next save
//   V4  the recovery code opens it and sets a new lock password;
//       the record before the change is kept in data/vault.prev.json
//   V5  the padlock off: the file goes back to plain
import { server, browser, ok, section, done } from "./lib.mjs";
import { put, untilDisk, PW } from "./office-lib.mjs";

const s = await server();
const c = await browser( s );
const CM = "document.querySelector('.CodeMirror').CodeMirror";
const V2 = "NAYIVE-LOCK-B62\n";

async function textPage( url )
{
    await c.open( url, "/nayive/text/" );
    await c.evaluate( PW + "( window )" );
    return c.until( "document.querySelector('.CodeMirror') && window.AyniVault && window.AyniCrypt", 20000 );
}

// The open document, opened in the page with the vault the page holds.
const inPage = rel => c.evaluate( `( async function () {
    var r = await fetch( '/api/files?file=' + encodeURIComponent( ${JSON.stringify( rel )} ), { cache: 'no-store' } );
    var body = await r.text();
    var l = await AyniCrypt.docLockFrom( AyniVault.current(), body );
    return AyniCrypt.unseal( l, body );
} )()` );

//----------------------------------------------------------------------------//
section( "V1 · LOCKING SETS UP THE VAULT; THE DISK HOLDS ONLY CIPHERTEXT" );

put( s, "files/v.txt", "texto en claro\n" );
ok( await textPage( "/nayive/text/?file=files/v.txt" ), "v.txt is open" );
ok( await c.until( `${CM}.getValue() === 'texto en claro\\n'` ), "with its text" );

await c.evaluate( "document.getElementById('lockBtn').click(), true" );
ok( await c.until( "window.__sheet().indexOf( Ayni.t('lock.pastTitle') ) !== -1" ), "the padlock warns about the copy already written" );
await c.evaluate( `( function () {
    var d = document.querySelector( 'dialog.panel[open]' );
    var b = Array.prototype.find.call( d.querySelectorAll( 'footer button' ), function ( x ) { return x.dataset.tip === Ayni.t( 'lock.lockAnyway' ); } );
    b.click(); return true;
} )()` );
const code = await c.evaluate( "window.__vaultSetup( 'clave-de-candado-1' )" );
ok( /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test( code || "" ), "the lock password is set, and the recovery code shown once", code );

const sealed = await untilDisk( s, "files/v.txt", t => t && t.startsWith( V2 ), 20000 );
ok( sealed && sealed.startsWith( V2 ), "v.txt on disk is sealed under the vault (v2)", ( sealed || "" ).slice( 0, 20 ) );
ok( sealed && sealed.indexOf( "texto en claro" ) === -1, "no plain text in it" );

const rec = await untilDisk( s, "data/vault.json", t => !! t, 5000 );
let recJ = null; try { recJ = JSON.parse( rec ); } catch {}
ok( recJ && recJ.id && recJ.pw && recJ.rec && Array.isArray( recJ.pk ), "data/vault.json is there: id, pw, rec, pk", rec );
ok( rec && rec.indexOf( "clave-de-candado-1" ) === -1 && rec.indexOf( code.replace( /-/g, "" ) ) === -1, "it holds neither the password nor the code" );
ok( await inPage( "files/v.txt" ) === "texto en claro\n", "the page's vault opens the file on disk" );

//----------------------------------------------------------------------------//
section( "V2 · A NEW PAGE ASKS THE LOCK PASSWORD; AN EDIT IS SAVED SEALED" );

ok( await textPage( "/nayive/text/?file=files/v.txt" ), "v.txt again, in a new page" );
ok( await c.evaluate( "window.__vaultUnlock( 'una-que-no-es' )" ), "a wrong lock password..." );
ok( await c.until( "document.getElementById('ayniVaultErr') && ! document.getElementById('ayniVaultErr').hidden" ), "...says so and asks again" );
ok( await c.evaluate( "window.__vaultUnlock( 'clave-de-candado-1' )" ), "the right one" );
ok( await c.until( `${CM}.getValue() === 'texto en claro\\n'` ), "opens it" );
ok( await c.evaluate( "document.getElementById('lockBtn').getAttribute('aria-pressed') === 'true'" ), "the padlock is lit" );

await c.evaluate( `${CM}.setValue( 'texto cambiado\\n' ), true` );
const edited = await untilDisk( s, "files/v.txt", t => t && t !== sealed, 20000 );
ok( edited && edited.startsWith( V2 ) && edited.indexOf( "cambiado" ) === -1, "the edit is saved sealed (v2)" );
ok( await inPage( "files/v.txt" ) === "texto cambiado\n", "and it opens to the new text" );

//----------------------------------------------------------------------------//
section( "V3 · AN OLD DOCUMENT WITH ITS OWN PASSWORD MOVES TO THE VAULT" );

const oldBody = await c.evaluate( `( async function () {
    return AyniCrypt.seal( await AyniCrypt.newLock( 'clave-vieja-1' ), 'texto viejo\\n' ); } )()` );
ok( oldBody.startsWith( "NAYIVE-LOCK-B64\n" ), "a v1 file, as made before the vault" );
put( s, "files/viejo.txt", oldBody );

ok( await textPage( "/nayive/text/?file=files/viejo.txt" ), "viejo.txt, in a new page" );
ok( await c.evaluate( "window.__typePassword( 'clave-vieja-1' )" ), "its own password" );
ok( await c.evaluate( "window.__vaultUnlock( 'clave-de-candado-1' )" ), "then the vault's, to move it" );
ok( await c.until( `${CM}.getValue() === 'texto viejo\\n'` ), "it is open" );
await c.evaluate( `${CM}.setValue( 'texto viejo, ya en el candado\\n' ), true` );
const moved = await untilDisk( s, "files/viejo.txt", t => t && t.startsWith( V2 ), 20000 );
ok( moved && moved.startsWith( V2 ), "its next save is sealed under the vault", ( moved || "" ).slice( 0, 20 ) );
ok( await inPage( "files/viejo.txt" ) === "texto viejo, ya en el candado\n", "and the vault opens it" );

//----------------------------------------------------------------------------//
section( "V4 · FORGOT THE PASSWORD: THE RECOVERY CODE" );

const recBefore = JSON.parse( await untilDisk( s, "data/vault.json", t => !! t, 5000 ) );
ok( await textPage( "/nayive/text/?file=files/v.txt" ), "v.txt, in a new page" );
ok( await c.evaluate( `window.__vaultUnlock( ${JSON.stringify( code.toLowerCase() )}, 'code' )` ), "the recovery code (typed in small letters)" );
ok( await c.evaluate( "window.__typePassword( 'clave-nueva-del-candado' )" ), "a new lock password, asked right after" );
ok( await c.until( `${CM}.getValue() === 'texto cambiado\\n'` ), "the document is open" );
const recAfter = JSON.parse( await untilDisk( s, "data/vault.json", t => t && JSON.parse( t ).pw.wrapped !== recBefore.pw.wrapped, 10000 ) );
ok( recAfter.pw.wrapped !== recBefore.pw.wrapped, "data/vault.json has the new password's wrap" );
ok( recAfter.id === recBefore.id && recAfter.rec.wrapped === recBefore.rec.wrapped, "same vault, same recovery code" );
const prev = await untilDisk( s, "data/vault.prev.json", t => !! t, 5000 );
ok( prev && JSON.parse( prev ).pw.wrapped === recBefore.pw.wrapped, "the version before is kept in data/vault.prev.json" );

ok( await textPage( "/nayive/text/?file=files/v.txt" ), "v.txt, in a new page" );
ok( await c.evaluate( "window.__vaultUnlock( 'clave-de-candado-1' )" ), "the OLD lock password..." );
ok( await c.until( "document.getElementById('ayniVaultErr') && ! document.getElementById('ayniVaultErr').hidden" ), "...no longer opens it" );
ok( await c.evaluate( "window.__vaultUnlock( 'clave-nueva-del-candado' )" ), "the new one" );
ok( await c.until( `${CM}.getValue() === 'texto cambiado\\n'` ), "does" );

//----------------------------------------------------------------------------//
section( "V5 · THE PADLOCK OFF: PLAIN AGAIN" );

await c.evaluate( "document.getElementById('lockBtn').click(), true" );
ok( await c.until( "window.__sheet().indexOf( Ayni.t('lock.offTitle') ) !== -1" ), "it asks first" );
await c.evaluate( "window.__pressConfirm()" );
const plain = await untilDisk( s, "files/v.txt", t => t === "texto cambiado\n", 20000 );
ok( plain === "texto cambiado\n", "v.txt on disk is plain again", ( plain || "" ).slice( 0, 20 ) );
ok( !! await untilDisk( s, "data/vault.json", t => !! t, 2000 ), "the vault stays (other documents use it)" );

await done( c, s );
