/*
 * app.mjs - the vault in the REAL apps: Text's padlock and the launcher's
 * Account › Locked documents, over a real server in a scratch run-root.
 *
 *     node tools/vault-test/app.mjs          # from the repo root
 *
 * Like tools/smoke-test: builds server/go into /tmp, one user "test", a copy
 * of client/apps, the service worker bypassed. The real store/ is never
 * touched. Served at http://localhost (passkeys refuse an IP address).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";
import { xlsx } from "../data-safety-test/office-lib.mjs";   // only the fixture builder

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

let pass = 0, fail = 0;
const ok = ( name, cond, extra ) =>
{
    if( cond ) { pass++; console.log( "  PASS " + name ); }
    else       { fail++; console.log( "  FAIL " + name + ( extra !== undefined ? " -> " + JSON.stringify( extra ).slice( 0, 300 ) : "" ) ); }
};
const section = s => console.log( "\n== " + s );

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "vault-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://localhost:${PORT}`;
const HOME = `${RUN}/homes/test`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${HOME}/data`, { recursive: true } );
fs.mkdirSync( `${HOME}/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${HOME}/data/config.json`, JSON.stringify( { password: "test" } ) );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( `http://127.0.0.1:${PORT}/api/whoami` ); break; } catch { await sleep( 100 ); } }

const disk = rel => { try { return fs.readFileSync( path.join( HOME, rel ), "utf8" ); } catch { return null; } };
const put  = ( rel, body ) => { fs.mkdirSync( path.dirname( path.join( HOME, rel ) ), { recursive: true } ); fs.writeFileSync( path.join( HOME, rel ), body ); };
async function untilDisk( rel, cond, ms = 20000 )
{
    const end = Date.now() + ms;
    for( ;; ) { const t = disk( rel ); if( cond( t ) || Date.now() > end ) return t; await sleep( 150 ); }
}

const V2 = "NAYIVE-LOCK-B62\n";
const CM = "document.querySelector('.CodeMirror').CodeMirror";

const b = await browser();
let c;
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await c.evaluate( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( "signed in", st === 200, st );

    const until = async ( expr, ms = 15000 ) =>
    {
        const end = Date.now() + ms;
        for( ;; ) { let v = null; try { v = await c.evaluate( expr ); } catch {} if( v || Date.now() > end ) return v; await sleep( 120 ); }
    };
    const helpers = fs.readFileSync( path.join( HERE, "page.html" ), "utf8" ).split( "// Helpers the runner drives the real dialogs with." )[ 1 ].split( "</script>" )[ 0 ];
    async function go( url, ready )
    {
        await c.send( "Page.navigate", { url: BASE + url } );
        await sleep( 1200 );
        await until( "document.readyState === 'complete'" );
        await c.evaluate( helpers + "; true" );
        return until( ready, 20000 );
    }
    const textUp = "document.querySelector('.CodeMirror') && window.AyniVault && window.AyniCrypt";

    //------------------------------------------------------------------------//
    section( "TEXT: THE PADLOCK SETS UP THE VAULT" );

    put( "files/v.txt", "texto en claro\n" );
    ok( "v.txt is open", await go( "/nayive/text/?file=files/v.txt", textUp ) );
    ok( "with its text", await until( `${CM}.getValue() === 'texto en claro\\n'` ) );
    await c.evaluate( "document.getElementById('lockBtn').click(), true" );
    ok( "it warns: already written", await until( "document.querySelector('dialog.panel[open]') && document.querySelector('dialog.panel[open]').textContent.indexOf( Ayni.t('lock.pastTitle') ) !== -1" ) );
    await c.evaluate( `( function () { var d = document.querySelector( 'dialog.panel[open]' );
        Array.prototype.find.call( d.querySelectorAll( 'footer button' ), function ( x ) { return x.dataset.tip === Ayni.t( 'lock.lockAnyway' ); } ).click(); return true; } )()` );
    ok( "the lock password, twice", await c.evaluate( "typeNew( 'clave-de-candado-1' )" ) );
    const code = await c.evaluate( "codeShown()" );
    ok( "the recovery code", /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test( code || "" ), code );
    if( await until( "top_() && top_().textContent.indexOf( Ayni.t('ayni.vault.pkOfferTitle') ) !== -1", 2000 ) ) await c.evaluate( "answer( false )" );
    const sealed = await untilDisk( "files/v.txt", t => t && t.startsWith( V2 ) );
    ok( "v.txt on disk is v2", sealed && sealed.startsWith( V2 ), ( sealed || "" ).slice( 0, 20 ) );
    ok( "no plain text in it", sealed && sealed.indexOf( "en claro" ) === -1 );
    const rec = disk( "data/vault.json" );
    ok( "data/vault.json on disk", rec && JSON.parse( rec ).id && JSON.parse( rec ).pw );
    ok( "no password in it", rec && rec.indexOf( "clave-de-candado" ) === -1 );
    ok( "the padlock is lit", await c.evaluate( "document.getElementById('lockBtn').getAttribute('aria-pressed') === 'true'" ) );

    //------------------------------------------------------------------------//
    section( "TEXT: A NEW PAGE ASKS; AN EDIT IS SAVED v2" );

    ok( "v.txt in a new page", await go( "/nayive/text/?file=files/v.txt", "document.getElementById('ayniVaultLead')" ) );
    ok( "the dialog names the file", ( await c.evaluate( "document.getElementById('ayniVaultLead').textContent" ) ).indexOf( "v.txt" ) !== -1 );
    await c.evaluate( "unlockWith( 'pw', 'clave-de-candado-1' )" );
    ok( "it opens", await until( `${CM}.getValue() === 'texto en claro\\n'` ) );
    await c.evaluate( `${CM}.setValue( 'texto cambiado\\n' ), true` );
    const edited = await untilDisk( "files/v.txt", t => t && t !== sealed );
    ok( "the edit is saved v2, no plain text", edited && edited.startsWith( V2 ) && edited.indexOf( "cambiado" ) === -1 );

    //------------------------------------------------------------------------//
    section( "TEXT: AN OLD PASSWORD DOCUMENT MOVES TO THE VAULT" );

    const oldBody = await c.evaluate( "( async function () { return AyniCrypt.seal( await AyniCrypt.newLock( 'clave-vieja-1' ), 'texto viejo\\n' ); } )()" );
    put( "files/viejo.txt", oldBody );
    ok( "viejo.txt, its own password asked", await go( "/nayive/text/?file=files/viejo.txt", "document.getElementById('ayni-ask-pw')" ) );
    await c.evaluate( `( function () { var i = document.getElementById( 'ayni-ask-pw' ); i.value = 'clave-vieja-1'; i.closest( 'dialog' ).querySelector( 'footer button:last-child' ).click(); return true; } )()` );
    await c.evaluate( "unlockWith( 'pw', 'clave-de-candado-1' )" );
    ok( "it opens", await until( `${CM}.getValue() === 'texto viejo\\n'` ) );
    await c.evaluate( `${CM}.setValue( 'texto viejo, movido\\n' ), true` );
    const moved = await untilDisk( "files/viejo.txt", t => t && t.startsWith( V2 ) );
    ok( "its next save is v2", moved && moved.startsWith( V2 ), ( moved || "" ).slice( 0, 20 ) );

    //------------------------------------------------------------------------//
    section( "TEXT: THE MOVED DOCUMENT'S OLD .bak STILL OPENS; PADLOCK OFF" );

    const bak = disk( "files/.bak/viejo.txt" );
    ok( "its .bak is the copy from before the move (v1)", bak && bak.startsWith( "NAYIVE-LOCK-B64\n" ), ( bak || "" ).slice( 0, 20 ) );
    await c.evaluate( "document.getElementById('lockBtn').click(), true" );
    ok( "padlock off asks first", await until( "top_() && top_().textContent.indexOf( Ayni.t('lock.offTitle') ) !== -1" ) );
    await c.evaluate( "answer( true )" );
    ok( "the file is plain again", await untilDisk( "files/viejo.txt", t => t === "texto viejo, movido\n" ) === "texto viejo, movido\n" );
    ok( "and its old .bak too (opened with the old key, no question)", await untilDisk( "files/.bak/viejo.txt", t => t === "texto viejo\n" ) === "texto viejo\n", disk( "files/.bak/viejo.txt" ) );

    //------------------------------------------------------------------------//
    section( "CALC: BYTES ARE SEALED v2 (BI2)" );

    fs.writeFileSync( path.join( HOME, "files/h.xlsx" ), xlsx( { a1: "SECRETO" } ) );
    ok( "h.xlsx is open", await go( "/nayive/calc/?file=files/h.xlsx", "window.AyniVault && document.getElementById('fileLabel') && document.getElementById('fileLabel').textContent.indexOf('h.xlsx') !== -1" ) );
    await sleep( 800 );
    await c.evaluate( "document.getElementById('lockBtn').click(), true" );
    ok( "it warns: already written", await until( "top_() && top_().textContent.indexOf( Ayni.t('lock.pastTitle') ) !== -1" ) );
    await c.evaluate( `( function () { var d = top_();
        Array.prototype.find.call( d.querySelectorAll( 'footer button' ), function ( x ) { return x.dataset.tip === Ayni.t( 'lock.lockAnyway' ); } ).click(); return true; } )()` );
    await c.evaluate( "unlockWith( 'pw', 'clave-de-candado-1' )" );
    const cx = await untilDisk( "files/h.xlsx", t => t && t.startsWith( "NAYIVE-LOCK-BI2\n" ) );
    ok( "h.xlsx on disk is BI2", cx && cx.startsWith( "NAYIVE-LOCK-BI2\n" ), ( cx || "" ).slice( 0, 16 ) );
    ok( "no zip inside it in the clear", cx && cx.indexOf( "[Content_Types]" ) === -1 );

    //------------------------------------------------------------------------//
    section( "LAUNCHER: ACCOUNT › LOCKED DOCUMENTS, A PASSKEY" );

    await c.send( "WebAuthn.enable", { enableUI: false } );
    const auth = await c.send( "WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
        hasPrf: true, automaticPresenceSimulation: true } } );
    ok( "virtual authenticator", !! ( auth.result && auth.result.authenticatorId ), auth.error );

    ok( "the launcher", await go( "/nayive/", "document.getElementById('vaultBtn')" ) );
    await c.evaluate( "document.getElementById('pwBackdrop').showModal(), document.getElementById('vaultBtn').click(), true" );
    ok( "Manage opens the dialog (scripts loaded on the tap)", await until( "document.getElementById('ayniVaultPkBtn')" ) );
    await c.evaluate( "document.getElementById('ayniVaultPkBtn').click(), true" );
    await until( "document.getElementById('ayniPkAdd')" );
    await c.evaluate( "document.getElementById('ayniPkNew').value = 'Test phone', document.getElementById('ayniPkAdd').click(), true" );
    await c.evaluate( "unlockWith( 'pw', 'clave-de-candado-1' )" );
    const note = await until( "( function () { var n = document.getElementById( 'ayniPkNote' ), e = document.getElementById( 'ayniPkErr' ); return ( n && ! n.hidden && n.textContent ) || ( e && ! e.hidden && 'ERR ' + e.textContent ); } )()" );
    ok( "a passkey is added", note && note.indexOf( "ERR" ) !== 0, note );
    const rec2 = JSON.parse( disk( "data/vault.json" ) );
    ok( "on disk: one passkey, with its PRF salt", rec2.pk.length === 1 && rec2.pk[ 0 ].name === "Test phone" && !! rec2.pk[ 0 ].salt, rec2.pk );
    ok( "the version before is kept", !! disk( "data/vault.prev.json" ) );

    section( "TEXT: THE PASSKEY OPENS A LOCKED DOCUMENT" );
    ok( "v.txt in a new page", await go( "/nayive/text/?file=files/v.txt", "document.getElementById('ayniVaultPk')" ) );
    await c.evaluate( "unlockWith( 'pk' )" );
    ok( "opened by the passkey alone", await until( `${CM}.getValue() === 'texto cambiado\\n'`, 20000 ), await c.evaluate( "vaultErr()" ) );

    //------------------------------------------------------------------------//
    section( "TEXT: FORGOT THE PASSWORD - THE RECOVERY CODE; THEN PADLOCK OFF" );

    const before = JSON.parse( disk( "data/vault.json" ) );
    ok( "v.txt in a new page", await go( "/nayive/text/?file=files/v.txt", "document.getElementById('ayniVaultLead')" ) );
    await c.evaluate( `unlockWith( 'code', ${JSON.stringify( code.toLowerCase() )} )` );
    ok( "the code opens it and asks a new lock password", await c.evaluate( "typeNew( 'clave-nueva-del-candado' )" ) );
    ok( "the document is open", await until( `${CM}.getValue() === 'texto cambiado\\n'` ) );
    const after = JSON.parse( await untilDisk( "data/vault.json", t => t && JSON.parse( t ).pw.wrapped !== before.pw.wrapped ) );
    ok( "the new password's wrap is on disk; same vault, same code", after.pw.wrapped !== before.pw.wrapped && after.id === before.id && after.rec.wrapped === before.rec.wrapped );
    ok( "the version before is in data/vault.prev.json", JSON.parse( disk( "data/vault.prev.json" ) ).pw.wrapped === before.pw.wrapped );
    await c.evaluate( "document.getElementById('lockBtn').click(), true" );
    await until( "top_() && top_().textContent.indexOf( Ayni.t('lock.offTitle') ) !== -1" );
    await c.evaluate( "answer( true )" );
    ok( "padlock off: v.txt is plain on disk", await untilDisk( "files/v.txt", t => t === "texto cambiado\n" ) === "texto cambiado\n" );
    ok( "the vault stays", !! disk( "data/vault.json" ) );

    const errs = c.logs.filter( l => /^EXCEPTION/.test( l ) );
    ok( "no page exceptions", errs.length === 0, errs );
}
catch ( e ) { fail++; console.log( "  FAIL (threw) " + ( e && e.stack || e ) ); }
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
