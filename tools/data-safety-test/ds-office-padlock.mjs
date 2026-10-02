// ds-office-padlock.mjs - the padlock (a password on a document) and what it
// writes or deletes.
// A6 part (office #15b): "Restore the previous copy" of a .bak sealed with an
// OLDER password keeps the document's own password - no silent switch.
// G6 (office #9): "Clean copy" purges from the bin only what it put there,
// never an older item of the same name.
import { server, browser, ok, section, done } from "./lib.mjs";
import { put, untilDisk, PW } from "./office-lib.mjs";

const s = await server();
const c = await browser( s );
const phone = await s.client();
const CM = "document.querySelector('.CodeMirror').CodeMirror";

async function textPage( url )
{
    await c.open( url, "/nayive/text/" );
    await c.evaluate( PW + "( window )" );
    return c.until( "document.querySelector('.CodeMirror') && window.NayiveCrypt && document.getElementById('fileLabel').textContent", 20000 );
}

//----------------------------------------------------------------------------//
section( "A6 · RESTORE A COPY SEALED WITH AN OLDER PASSWORD" );

ok( await textPage( "/nayive/text/?new=1" ), "Text is up" );
const sealedPair = await c.evaluate( `( async function () {
    var kNew = await NayiveCrypt.newLock( 'clave-nueva-123' ), kOld = await NayiveCrypt.newLock( 'clave-vieja-123' );
    return { cur: await NayiveCrypt.seal( kNew, 'texto nuevo\\n' ), old: await NayiveCrypt.seal( kOld, 'texto viejo\\n' ) };
} )()` );
put( s, "files/n.txt", sealedPair.cur );
put( s, "files/.bak/n.txt", sealedPair.old );

await c.open( "/nayive/text/?file=files/n.txt", "/nayive/text/" );
await c.evaluate( PW + "( window )" );
ok( await c.evaluate( "window.__typePassword( 'clave-nueva-123' )" ), "its password is asked, and given" );
ok( await c.until( `document.querySelector('.CodeMirror') && ${CM}.getValue() === 'texto nuevo\\n'`, 20000 ), "n.txt is open" );
ok( await c.evaluate( "document.getElementById('lockBtn').classList.contains('is-active')" ), "the padlock is lit" );

await c.evaluate( "document.getElementById('restoreBtn').click(), true" );
ok( await c.until( "window.__sheet().indexOf( NayiveUI.t('write.restore') ) !== -1" ), "Restore asks first (a password is on)" );
await c.evaluate( "window.__pressConfirm()" );
ok( await c.evaluate( "window.__typePassword( 'clave-vieja-123' )" ), "the copy asks for the password of ITS day" );
ok( await c.until( `${CM}.getValue() === 'texto viejo\\n'` ), "the previous copy is on screen" );
ok( await c.evaluate( "document.getElementById('lockBtn').classList.contains('is-active')" ), "the padlock is still on" );

// The restored copy is saved over the file by the autosave (the app's 7 s timer).
const saved = await untilDisk( s, "files/n.txt", t => t && t !== sealedPair.cur, 20000 );
const opens = await c.evaluate( `( async function () {
    var body = ${JSON.stringify( saved )};
    async function tryPw( pw ) { try { var k = await NayiveCrypt.lockFrom( pw, body ); return await NayiveCrypt.unseal( k, body ); } catch ( e ) { return null; } }
    return { mine: await tryPw( 'clave-nueva-123' ), old: await tryPw( 'clave-vieja-123' ) };
} )()` );
ok( opens.mine === "texto viejo\n", "the file now holds the old text, sealed with the document's OWN password", opens );
ok( opens.old === null, "not with the old one", opens );

section( "A6 · A SEALED COPY BACK INTO A DOCUMENT WITH NO PASSWORD NOW" );

ok( await textPage( "/nayive/text/?new=1" ), "Text is up" );
const oldSealed = await c.evaluate( `( async function () {
    return NayiveCrypt.seal( await NayiveCrypt.newLock( 'clave-de-antes-1' ), 'texto sellado\\n' ); } )()` );
put( s, "files/m.txt", "texto ahora\n" );
put( s, "files/.bak/m.txt", oldSealed );
ok( await textPage( "/nayive/text/?file=files/m.txt" ), "m.txt (no password) is open" );
ok( await c.until( `${CM}.getValue() === 'texto ahora\\n'` ), "with its text" );
await c.evaluate( "document.getElementById('restoreBtn').click(), true" );
ok( await c.until( "window.__sheet().indexOf( NayiveUI.t('write.restore') ) !== -1" ), "Restore asks first (the copy has a password)" );
await c.evaluate( "window.__pressConfirm()" );
ok( await c.evaluate( "window.__typePassword( 'clave-de-antes-1' )" ), "the copy's password" );
ok( await c.until( `${CM}.getValue() === 'texto sellado\\n'` ), "the previous copy is on screen" );
ok( await c.until( "( window.__toasts || [] ).some( function ( t ) { return t.indexOf( NayiveUI.t('write.restoredNoPassword') ) !== -1; } )", 3000 ),
    "and the toast says it goes on WITHOUT a password", await c.toasts() );
ok( ! await c.evaluate( "document.getElementById('lockBtn').classList.contains('is-active')" ), "the padlock is off, as it says" );

//----------------------------------------------------------------------------//
section( "G6 · \"CLEAN COPY\" AND AN OLDER FILE OF THE SAME NAME IN THE BIN" );

put( s, "files/carta.txt", "la carta del año pasado\n" );
const del = await phone.del( "/api/files?paths=" + encodeURIComponent( "files/carta.txt" ) );
ok( del.status === 200, "last year's carta.txt went to the bin", del.status );
const binList = async () => JSON.parse( ( await phone.call( "GET", "/api/files?trash=list" ) ).text ).items || [];
const older = ( await binList() ).filter( it => it.orig === "files/carta.txt" ).map( it => it.id );
ok( older.length === 1, "it is in the bin", older );

put( s, "files/carta.txt", "texto en claro\n" );
ok( await textPage( "/nayive/text/?file=files/carta.txt" ), "this year's carta.txt is open" );
ok( await c.until( `${CM}.getValue() === 'texto en claro\\n'` ), "with its text" );

await c.evaluate( "document.getElementById('lockBtn').click(), true" );
ok( await c.until( "window.__sheet().indexOf( NayiveUI.t('lock.pastTitle') ) !== -1" ), "the padlock warns about the copy already written" );
await c.evaluate( "window.__pressConfirm()" );                       // "Clean copy"
ok( await c.evaluate( "window.__typePassword( 'una-clave-larga-1' )" ), "a new password" );
ok( await c.until( "document.getElementById('saveAsBackdrop').classList.contains('open')" ), "a new name is asked" );
await c.evaluate( "document.getElementById('saveName').value = 'carta-protegida.txt', document.getElementById('saveAsConfirmBtn').click(), true" );

ok( await untilDisk( s, "files/carta.txt", t => t === null, 15000 ) === null, "the plain carta.txt is gone from Drive" );
let left = [];
for( let i = 0; i < 50; i++ )
{
    left = await binList();
    if( ! left.some( it => it.orig === "files/carta.txt" && older.indexOf( it.id ) === -1 ) ) break;
    await new Promise( r => setTimeout( r, 200 ) );
}
ok( ! left.some( it => it.orig === "files/carta.txt" && older.indexOf( it.id ) === -1 ), "the plain copy it just deleted is out of the bin too", left );
ok( left.some( it => older.indexOf( it.id ) !== -1 ), "last year's carta.txt is STILL in the bin", left );

await done( c, s );
