/*
 * run.mjs - the vault tests: one key for every locked document
 * (shared/ayni/ayni-crypt.js v2, ayni-vault.js, ayni-passkey.js).
 *
 *     node tools/vault-test/run.mjs          # from the repo root
 *
 * Serves client/apps over 127.0.0.1, drops page.html in as _vaulttest.html,
 * drives a headless Chromium and takes the page away again. The page stubs
 * AyniNet with an in-memory server (data/vault.json); the crypto, the dialogs
 * and the passkey calls are the real ones - the passkey through Chromium's
 * virtual authenticator (with PRF).
 */
import { browser, attach } from "../cdp.mjs";
import { serve } from "../locktest/serve.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname( fileURLToPath( import.meta.url ) );
const APPS = path.resolve( HERE, "..", "..", "client", "apps" );
const PAGE = path.join( APPS, "_vaulttest.html" );

let pass = 0, fail = 0;
const ok = ( name, cond, extra ) =>
{
    if( cond ) { pass++; console.log( "  PASS " + name ); }
    else       { fail++; console.log( "  FAIL " + name + ( extra !== undefined ? " -> " + JSON.stringify( extra ) : "" ) ); }
};
const section = s => console.log( "\n== " + s );

fs.copyFileSync( path.join( HERE, "page.html" ), PAGE );

const site = await serve( APPS );
const b    = await browser();
let   p, p2;

async function up( tabp )
{
    await new Promise( r => setTimeout( r, 1500 ) );
    for( let i = 0; i < 200; i++ )
    {
        let ready = false;
        try { ready = await tabp.evaluate( "!!(window.AyniVault && window.AyniCrypt && window.Ayni && Ayni.dialog)" ); } catch {}
        if( ready ) break;
        await new Promise( r => setTimeout( r, 50 ) );
    }
    await tabp.evaluate( "Ayni.i18n.ready" );
}

try
{
    const url = `http://localhost:${site.port}/_vaulttest.html`;   // passkeys refuse an IP address as the site
    p = await attach( ( await b.newTab( url ) ).webSocketDebuggerUrl );
    await up( p );

    //------------------------------------------------------------------------//
    section( "THE v2 FORMAT (ayni-crypt.js)" );

    const c = await p.evaluate( `( async function () {
        async function mk() {
            var raw = crypto.getRandomValues( new Uint8Array( 32 ) );
            return { id: crypto.getRandomValues( new Uint8Array( 16 ) ),
                     key: await crypto.subtle.importKey( "raw", raw, { name: "AES-GCM", length: 256 }, false, [ "encrypt", "decrypt" ] ) };
        }
        async function fails( f ) { try { await f(); return null; } catch ( e ) { return e.code || "error"; } }
        var A = await mk(), B = await mk();
        var lock = await AyniCrypt.newDocLock( A );
        var txt  = await AyniCrypt.seal( lock, "hola, mundo\\n" );
        var bin  = await AyniCrypt.seal( lock, new Uint8Array( [ 1, 2, 3, 250 ] ) );
        var back = await AyniCrypt.unseal( lock, txt );
        var backB = Array.from( await AyniCrypt.unseal( lock, bin ) );

        var again = await AyniCrypt.docLockFrom( A, txt );
        var txt2  = await AyniCrypt.seal( again, "otra vez" );
        var sameHead = txt.slice( 0, 16 ) === txt2.slice( 0, 16 );
        var raw1 = atob( txt.slice( 16 ) ), raw2 = atob( txt2.slice( 16 ) );

        var other = await AyniCrypt.newDocLock( A );
        var byOther = await AyniCrypt.unseal( other, txt );

        var badBin = bin.slice(); badBin[ 50 ] ^= 1;        // in the wrapped file key
        var badIv  = bin.slice(); badIv[ 95 ] ^= 1;         // in this save's IV
        var badCt  = bin.slice(); badCt[ bin.length - 1 ] ^= 1;

        var v1 = await AyniCrypt.newLock( "una-clave-larga" );
        var s1 = await AyniCrypt.seal( v1, "viejo" );

        return {
            txtHead: txt.slice( 0, 16 ), binHead: new TextDecoder().decode( bin.slice( 0, 16 ) ),
            looks: AyniCrypt.looksLocked( txt ) && AyniCrypt.looksLocked( bin ), v2: AyniCrypt.isV2( txt ) && AyniCrypt.isV2( bin ),
            v1isV2: AyniCrypt.isV2( s1 ), v1looks: AyniCrypt.looksLocked( s1 ),
            back: back, backB: backB,
            sameKeyHead: raw1.slice( 0, 92 ) === raw2.slice( 0, 92 ), diffIv: raw1.slice( 92, 104 ) !== raw2.slice( 92, 104 ), sameHead: sameHead,
            byOther: byOther,
            otherVault: await fails( function () { return AyniCrypt.docLockFrom( B, txt ); } ),
            bWrong: await fails( function () { return AyniCrypt.unseal( { v: 2, vault: B, keyHead: new Uint8Array( 92 ) }, txt ); } ),
            tamperWrap: await fails( function () { return AyniCrypt.docLockFrom( A, badBin ); } ),
            tamperIv: await fails( function () { return AyniCrypt.unseal( lock, badIv ); } ),
            tamperCt: await fails( function () { return AyniCrypt.unseal( lock, badCt ); } ),
            v1back: await AyniCrypt.unseal( v1, s1 ),
            moved: await ( async function () { var m = await AyniCrypt.newDocLock( A ); m.v1 = v1; return AyniCrypt.unseal( m, s1 ); } )(),
            v1byV2: await fails( function () { return AyniCrypt.unseal( lock, s1 ); } ),
            v2byV1: await fails( function () { return AyniCrypt.unseal( v1, txt ); } ),
            idOf: AyniPasskey.b64u( AyniCrypt.vaultIdOf( bin ) ) === AyniPasskey.b64u( A.id ), idOfV1: AyniCrypt.vaultIdOf( s1 ),
            size: bin.length
        };
    } )()` );
    ok( "text form is NAYIVE-LOCK-B62", c.txtHead === "NAYIVE-LOCK-B62\n", c.txtHead );
    ok( "bytes form is NAYIVE-LOCK-BI2", c.binHead === "NAYIVE-LOCK-BI2\n", c.binHead );
    ok( "looksLocked + isV2 know it", c.looks && c.v2 );
    ok( "a v1 file is locked, not v2", c.v1looks && ! c.v1isV2 );
    ok( "text round trip", c.back === "hola, mundo\n", c.back );
    ok( "bytes round trip", JSON.stringify( c.backB ) === "[1,2,3,250]", c.backB );
    ok( "104-byte header + 4 + 16 tag", c.size === 104 + 4 + 16, c.size );
    ok( "reopened: the same file key, a new IV", c.sameKeyHead && c.diffIv );
    ok( "another lock of the same vault opens it", c.byOther === "hola, mundo\n" );
    ok( "another vault: says otherVault", c.otherVault === "otherVault", c.otherVault );
    ok( "another vault's lock cannot open it", c.bWrong !== null );
    ok( "a changed wrapped key fails", c.tamperWrap === "error", c.tamperWrap );
    ok( "a changed IV fails", c.tamperIv === "error", c.tamperIv );
    ok( "a changed body fails", c.tamperCt === "error", c.tamperCt );
    ok( "v1 still opens with its password", c.v1back === "viejo" );
    ok( "a moved document's lock still opens its old v1 copies", c.moved === "viejo", c.moved );
    ok( "a v2 lock never opens a v1 file", c.v1byV2 !== null );
    ok( "a v1 lock never opens a v2 file", c.v2byV1 !== null );
    ok( "vaultIdOf", c.idOf && c.idOfV1 === null );

    //------------------------------------------------------------------------//
    section( "SET UP (ayni-vault.js)" );

    ok( "no vault yet", await p.evaluate( "AyniVault.exists().then( function ( x ) { return x === false; } )" ) );
    ok( "unlock with none says noVault", await p.evaluate( "AyniVault.unlock().then( function () { return 'no'; }, function ( e ) { return e.code; } )" ) === "noVault" );

    await p.evaluate( "window.SETUP = AyniVault.ensure(), true" );
    ok( "a short password is refused", await p.evaluate( `( async function () {
        await typeNew( "short-1" );
        var e = await wait( function () { var x = document.querySelector( "dialog[open] .form-error" ); return x && ! x.hidden && x; } );
        return !! e && !! document.getElementById( "ayni-ask-pw" );
    } )()` ) );
    ok( "the lock password is asked twice", await p.evaluate( "typeNew( 'lock-password-1' )" ) );
    const code = await p.evaluate( "codeShown()" );
    ok( "the recovery code is shown once", /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/.test( code || "" ), code );
    // The passkey offer (no authenticator yet): Later.
    ok( "the passkey offer, Later", await p.evaluate( "answer( false )" ) );
    const made = await p.evaluate( `SETUP.then( function ( v ) {
        var r = JSON.parse( SRV[ "data/vault.json" ] );
        return { got: !! v && !! v.key, same: !! v && AyniPasskey.b64u( v.id ) === r.id, cur: AyniVault.current() === v,
                 rec: Object.keys( r ).sort(), pk: r.pk.length, iters: r.pw.iters, plain: SRV[ "data/vault.json" ].indexOf( "lock-password-1" ) };
    } )` );
    ok( "ensure() resolves the vault", made.got && made.cur, made );
    ok( "data/vault.json has id, pw, rec, pk", JSON.stringify( made.rec ) === JSON.stringify( [ "created", "id", "pk", "pw", "rec", "v" ] ), made.rec );
    ok( "the record's id is the vault's", made.same );
    ok( "600 000 rounds", made.iters === 600000, made.iters );
    ok( "no password in the record", made.plain === -1 );

    //------------------------------------------------------------------------//
    section( "UNLOCK" );

    await p.evaluate( `( async function () {
        window.SEALED = await AyniCrypt.seal( await AyniCrypt.newDocLock( AyniVault.current() ), "secreto" );
        AyniVault.forget();
    } )()` );
    ok( "forget(): nothing in this tab", await p.evaluate( "AyniVault.current() === null" ) );

    await p.evaluate( "window.U = AyniVault.unlock( { name: 'carta.txt' } ), true" );
    ok( "the dialog names the document", ( await p.evaluate( "wait( function () { var l = document.getElementById( 'ayniVaultLead' ); return l && l.textContent; } )" ) || "" ).indexOf( "carta.txt" ) !== -1 );
    await p.evaluate( "unlockWith( 'pw', 'wrong-password' )" );
    ok( "a wrong password says so, and stays", !! await p.evaluate( "wait( vaultErr )" ) );
    await p.evaluate( "unlockWith( 'pw', 'lock-password-1' )" );
    ok( "the right password opens the vault", await p.evaluate( `U.then( async function ( v ) {
        var l = await AyniCrypt.docLockFrom( v, SEALED ); return await AyniCrypt.unseal( l, SEALED ) === "secreto";
    } )` ) );

    await p.evaluate( "AyniVault.forget(); window.U = AyniVault.unlock(), true" );
    await p.evaluate( "unlockWith( 'cancel' )" );
    ok( "cancel = null", await p.evaluate( "U.then( function ( v ) { return v === null; } )" ) );

    //------------------------------------------------------------------------//
    section( "FORGOT THE PASSWORD: THE RECOVERY CODE" );

    await p.evaluate( "window.U = AyniVault.unlock(), true" );
    await p.evaluate( "unlockWith( 'code', 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' )" );
    ok( "a wrong code says so", !! await p.evaluate( "wait( vaultErr )" ) );
    // typed loosely: small letters, spaces, an O for a zero
    const loose = code.toLowerCase().replace( /-/g, " " ).replace( /0/g, "o" );
    await p.evaluate( `unlockWith( 'code', ${JSON.stringify( loose )} )` );
    ok( "the code, typed loosely, opens it and asks a new password", await p.evaluate( "typeNew( 'new-lock-password-2' )" ) );
    ok( "...the vault is open", await p.evaluate( `U.then( async function ( v ) {
        var l = await AyniCrypt.docLockFrom( v, SEALED ); return await AyniCrypt.unseal( l, SEALED ) === "secreto";
    } )` ) );
    ok( "the version before is kept in data/vault.prev.json", await p.evaluate( `"data/vault.prev.json" in SRV && JSON.parse( SRV[ "data/vault.prev.json" ] ).pw.wrapped !== JSON.parse( SRV[ "data/vault.json" ] ).pw.wrapped` ) );
    ok( "the vault's id did not change", await p.evaluate( `JSON.parse( SRV[ "data/vault.prev.json" ] ).id === JSON.parse( SRV[ "data/vault.json" ] ).id` ) );

    await p.evaluate( "AyniVault.forget(); window.U = AyniVault.unlock(), true" );
    await p.evaluate( "unlockWith( 'pw', 'lock-password-1' )" );
    ok( "the old password no longer opens it", !! await p.evaluate( "wait( vaultErr )" ) );
    await p.evaluate( "unlockWith( 'pw', 'new-lock-password-2' )" );
    ok( "the new one does", await p.evaluate( "U.then( function ( v ) { return !! v; } )" ) );

    //------------------------------------------------------------------------//
    section( "A PASSKEY (virtual authenticator, PRF)" );

    await p.send( "WebAuthn.enable", { enableUI: false } );
    const auth = await p.send( "WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
        hasPrf: true, automaticPresenceSimulation: true } } );
    ok( "virtual authenticator with PRF", !! ( auth.result && auth.result.authenticatorId ), auth.error );

    await p.evaluate( "AyniVault.manage(), true" );
    await p.evaluate( "wait( function () { return document.getElementById( 'ayniVaultPkBtn' ); } ).then( function ( b ) { b.click(); } )" );
    await p.evaluate( "wait( function () { return document.getElementById( 'ayniPkAdd' ); } ).then( function ( b ) { document.getElementById( 'ayniPkNew' ).value = 'Test phone'; b.click(); } )" );
    await p.evaluate( "unlockWith( 'pw', 'new-lock-password-2' )" );
    const note = await p.evaluate( "wait( function () { var n = document.getElementById( 'ayniPkNote' ); var e = document.getElementById( 'ayniPkErr' ); return ( n && ! n.hidden && n.textContent ) || ( e && ! e.hidden && 'ERR ' + e.textContent ); }, 15000 )" );
    ok( "a passkey is added", note === Ayni_t( "ayni.pk.added" ) || ( note && note.indexOf( "ERR" ) !== 0 ), note );
    const rec = JSON.parse( await p.evaluate( "SRV[ 'data/vault.json' ]" ) );
    ok( "the record lists it, with its PRF salt", rec.pk.length === 1 && rec.pk[ 0 ].name === "Test phone" && !! rec.pk[ 0 ].salt && !! rec.pk[ 0 ].wrapped, rec.pk );
    await p.evaluate( "document.querySelectorAll( 'dialog[open]' ).forEach( function ( d ) { d.close(); } ), true" );

    await p.evaluate( "AyniVault.forget(); window.U = AyniVault.unlock(), true" );
    await p.evaluate( "unlockWith( 'pk' )" );
    ok( "the passkey opens the vault (no password typed)", await p.evaluate( `U.then( async function ( v ) {
        if( ! v ) return false;
        var l = await AyniCrypt.docLockFrom( v, SEALED ); return await AyniCrypt.unseal( l, SEALED ) === "secreto";
    } )`, 20000 ), await p.evaluate( "vaultErr()" ) );

    //------------------------------------------------------------------------//
    section( "OTHER TABS: THE KEY IS NEVER HANDED OVER; LOCK NOW REACHES THEM" );

    p2 = await attach( ( await b.newTab( url ) ).webSocketDebuggerUrl );
    await up( p2 );
    await p2.evaluate( `window.SRV = ${JSON.stringify( { "data/vault.json": JSON.stringify( rec ) } )}; true` );
    await p2.evaluate( "window.U = AyniVault.unlock(), true" );
    ok( "a second tab asks for itself", !! await p2.evaluate( "wait( function () { return document.getElementById( 'ayniVaultLead' ); } )" ) );
    await p2.evaluate( "unlockWith( 'pw', 'new-lock-password-2' )" );
    ok( "...and opens the document", await p2.evaluate( `U.then( async function ( v ) {
        var body = ${JSON.stringify( await p.evaluate( "SEALED" ) )};
        var l = await AyniCrypt.docLockFrom( v, body ); return await AyniCrypt.unseal( l, body ) === "secreto";
    } )` ) );
    ok( "a page asking on the channel gets nothing", await p2.evaluate( `new Promise( function ( resolve ) {
        var ch = new BroadcastChannel( "ayni-vault" ), got = false;
        ch.onmessage = function ( e ) { if( e.data && e.data.key ) got = true; };
        ch.postMessage( { ask: AyniPasskey.b64u( AyniVault.current().id ) } );
        setTimeout( function () { ch.close(); resolve( ! got ); }, 600 );
    } )` ) );
    await p2.evaluate( "AyniVault.forget(), true" );
    await new Promise( r => setTimeout( r, 300 ) );
    ok( "Lock now in one tab locks the other", await p.evaluate( "AyniVault.current() === null" ) );

    //------------------------------------------------------------------------//
    section( "REMOVE THE PASSKEY" );

    await p.evaluate( "window.U = AyniVault.unlock(), true" );
    await p.evaluate( "unlockWith( 'pw', 'new-lock-password-2' )" );
    await p.evaluate( "U" );
    await p.evaluate( "AyniVault.manage(), true" );
    await p.evaluate( "wait( function () { return document.getElementById( 'ayniVaultPkBtn' ); } ).then( function ( b ) { b.click(); } )" );
    await p.evaluate( "wait( function () { return document.querySelector( '[data-del]' ); } ).then( function ( b ) { b.click(); } )" );
    await p.evaluate( "wait( function () { var n = document.getElementById( 'ayniPkNote' ); return n && ! n.hidden; } )" );
    ok( "the record no longer has it", JSON.parse( await p.evaluate( "SRV[ 'data/vault.json' ]" ) ).pk.length === 0 );

    //------------------------------------------------------------------------//
    section( "OFFLINE: THIS BROWSER'S COPY OF THE RECORD" );

    await p.evaluate( `AyniVault.forget(); window.REAL_READ = AyniNet.readJson;
        AyniNet.readJson = function () { return Promise.reject( new TypeError( "Failed to fetch" ) ); };
        window.U = AyniVault.unlock(), true` );
    ok( "with no connection it still asks", !! await p.evaluate( "wait( function () { return document.getElementById( 'ayniVaultLead' ); } )" ) );
    await p.evaluate( "unlockWith( 'pw', 'new-lock-password-2' )" );
    ok( "...and opens", await p.evaluate( "U.then( function ( v ) { return !! v; } )" ) );
    ok( "set-up refuses offline (never makes a second vault)", await p.evaluate( `( async function () {
        AyniVault.forget(); localStorage.clear();
        try { await AyniVault.ensure(); return false; } catch ( e ) { return true; }
    } )()` ) );
    await p.evaluate( "AyniNet.readJson = REAL_READ, true" );

    //------------------------------------------------------------------------//
    section( "THE SCREEN LOCKER: OWN PAGE, AND THE DESKTOP AROUND A WINDOW" );

    await p.evaluate( "window.U = AyniVault.unlock(), true" );
    await p.evaluate( "unlockWith( 'pw', 'new-lock-password-2' )" );
    await p.evaluate( "U" );
    ok( "the locker forgets the key", await p.evaluate( `( async function () {
        document.documentElement.classList.add( "ayni-locked" );
        await new Promise( function ( r ) { setTimeout( r, 50 ); } );
        document.documentElement.classList.remove( "ayni-locked" );
        return AyniVault.current() === null;
    } )()` ) );
    ok( "a window inside the desktop forgets it too", await p.evaluate( `( async function () {
        var f = document.createElement( "iframe" ); f.src = location.href; document.body.appendChild( f );
        var w = await wait( function () { var x = f.contentWindow; return x && x.AyniVault && x.Ayni && x.Ayni.dialog && x.unlockWith && x; }, 10000 );
        await w.Ayni.i18n.ready;
        w.SRV = SRV;
        var u = w.AyniVault.unlock();
        await w.unlockWith( "pw", "new-lock-password-2" );
        var v = await u;
        if( ! v ) return "not unlocked";
        document.documentElement.classList.add( "ayni-locked" );
        await new Promise( function ( r ) { setTimeout( r, 50 ); } );
        document.documentElement.classList.remove( "ayni-locked" );
        var gone = w.AyniVault.current() === null;
        f.remove();
        return gone;
    } )()`, 30000 ) === true );

    //------------------------------------------------------------------------//
    section( "A DAMAGED data/vault.json IS NEVER WRITTEN OVER" );

    const hurt = await p.evaluate( `( async function () {
        AyniVault.forget(); localStorage.clear();
        SRV[ "data/vault.json" ] = '{"v":1,"oops":true}';
        var a = await AyniVault.ensure().then( function () { return "made"; }, function ( e ) { return e.code; } );
        var b = await AyniVault.unlock().then( function () { return "opened"; }, function ( e ) { return e.code; } );
        return { a: a, b: b, still: SRV[ "data/vault.json" ] };
    } )()` );
    ok( "set-up refuses, says damaged", hurt.a === "damaged", hurt );
    ok( "unlock says damaged", hurt.b === "damaged", hurt );
    ok( "the file is untouched", hurt.still === '{"v":1,"oops":true}', hurt.still );

    const errs = p.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon/.test( l ) );
    ok( "no page errors", errs.length === 0, errs );
}
catch ( e ) { fail++; console.log( "  FAIL (threw) " + ( e && e.stack || e ) ); }
finally
{
    try { fs.unlinkSync( PAGE ); } catch {}
    site.close();
    await b.kill();
}

function Ayni_t( k ) { return k; }   // the note is translated in the page; any non-error note counts

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
