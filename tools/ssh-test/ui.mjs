/*
 * ui.mjs - the Admin SSH tab's "confirm it is you" screens, in a real browser
 * over a real server (client/apps/ssh/ssh-tab.js, server/go/confirm_*.go).
 *
 *     node tools/ssh-test/ui.mjs          # from the repo root
 *
 * Builds server/go into a scratch run-root (admin "jefe"), copies client/apps,
 * bypasses the service worker. The setup code is read from its file, as he
 * would over SSH; the app's 6-digit codes are made here (RFC 6238). Takes
 * about a minute and a half: a used code works once, so some steps wait for
 * the next 30-second code. The terminal itself is not opened (no sshd).
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

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

// RFC 6238, SHA1, 6 digits.
function b32( s )
{
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "", out = [];
    for( const ch of s.replace( /[\s=]/g, "" ).toUpperCase() ) bits += abc.indexOf( ch ).toString( 2 ).padStart( 5, "0" );
    for( let i = 0; i + 8 <= bits.length; i += 8 ) out.push( parseInt( bits.slice( i, i + 8 ), 2 ) );
    return Buffer.from( out );
}
const step = () => Math.floor( Date.now() / 1000 / 30 );
function totp( key, s = step() )
{
    const c = Buffer.alloc( 8 );
    c.writeBigUInt64BE( BigInt( s ) );
    const h = crypto.createHmac( "sha1", key ).update( c ).digest();
    const o = h[ h.length - 1 ] & 15;
    return String( ( h.readUInt32BE( o ) & 0x7fffffff ) % 1e6 ).padStart( 6, "0" );
}
// The next code: wait for a step after `used`.
async function nextCode( key, used )
{
    while( step() <= used ) await sleep( 500 );
    return { code: totp( key ), step: step() };
}

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "ssh-ui-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://localhost:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/jefe/data`, { recursive: true } );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( `http://127.0.0.1:${PORT}/api/whoami` ); break; } catch { await sleep( 100 ); } }
const cfg = name => `${RUN}/config/${name}`;

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
    const st = await c.evaluate( `localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'jefe',password:'secreto'})}).then(r=>r.status)` );
    ok( "signed in as the admin", st === 200, st );

    const until = async ( expr, ms = 15000 ) =>
    {
        const end = Date.now() + ms;
        for( ;; ) { let v = null; try { v = await c.evaluate( expr ); } catch {} if( v || Date.now() > end ) return v; await sleep( 120 ); }
    };
    const top = "( function () { var d = document.querySelectorAll( 'dialog.panel[open]' ); return d[ d.length - 1 ]; } )()";
    const click = sel => c.evaluate( `( function () { var e = document.querySelector( ${JSON.stringify( sel )} ); if ( ! e ) return false; e.click(); return true; } )()` );
    const type = ( sel, v ) => c.evaluate( `( function () { var e = document.querySelector( ${JSON.stringify( sel )} ); e.value = ${JSON.stringify( v )};
        e.dispatchEvent( new Event( 'input', { bubbles: true } ) ); return true; } )()` );
    const text = sel => c.evaluate( `( function () { var e = document.querySelector( ${JSON.stringify( sel )} ); return e && ! e.hidden ? e.textContent : ''; } )()` );
    const closeTop = () => c.evaluate( `( function () { var d = ${top}; d.querySelector( '[data-close]' ).click(); return true; } )()` );

    await c.send( "Page.navigate", { url: BASE + "/nayive/admin.html" } );
    await sleep( 1500 );
    await until( "document.readyState === 'complete' && window.AyniPasskey && document.getElementById('sshSec')" );
    await c.evaluate( "document.getElementById('sshSec').hidden = false, true" );
    ok( "the terminal loads", await until( "document.getElementById('sshStatusText').textContent === 'Not connected'", 20000 ) );

    //------------------------------------------------------------------------//
    section( "FIRST TIME: SETUP CODE, THEN THE APP (RECOMMENDED: NO PASSKEYS HERE)" );

    await click( "#sshConnect" );
    ok( "nothing set up: the setup steps", await until( "!! document.getElementById('sshMakeCode')" ) );
    await click( "#sshMakeCode" );
    ok( "the command to read the code", ( await until( "document.getElementById('sshCmd').textContent" ) || "" ).indexOf( "ssh-setup-code.txt" ) !== -1 );
    const code = fs.readFileSync( cfg( "ssh-setup-code.txt" ), "utf8" ).trim();
    ok( "the app is first and the main button here", await until( `( function () { var w = document.querySelector( '.ssh-ways' ).firstElementChild;
        return w.dataset.way === 'app' && w.querySelector( '.btn' ).classList.contains( 'primary' ) && ! w.querySelector( '.ssh-rec' ).hidden; } )()` ) );
    ok( "the USB-key help is kept", !! await c.evaluate( "document.querySelector('.ssh-keyhelp') && document.querySelector('.ssh-keyhelp').textContent.indexOf('authenticator app') !== -1" ) );
    await type( "#sshCode", code );
    await type( "#sshPkName", "Phone app" );
    await click( "#sshAddApp" );
    ok( "the QR code is drawn", await until( "!! document.querySelector('#sshQr canvas')" ) );
    const secret = ( await text( "#sshSecret" ) ).replace( /\s/g, "" );
    ok( "the key as text", /^[A-Z2-7]{32}$/.test( secret ), secret );
    ok( "the otpauth:// link", ( await c.evaluate( "document.getElementById('sshOtpLink').href" ) || "" ).startsWith( "otpauth://totp/Nayive%20SSH:jefe%40localhost?secret=" + secret ) );
    ok( "not saved before a code", ! fs.existsSync( cfg( "ssh-totp.json" ) ) );
    await type( "#sshOtpNew", "000000" );
    ok( "a wrong code is refused", ( await until( "document.getElementById('sshAppErr') && ! document.getElementById('sshAppErr').hidden && document.getElementById('sshAppErr').textContent" ) || "" ).indexOf( "Wrong code" ) !== -1 );
    const key = b32( secret );
    let used = step();
    await type( "#sshOtpNew", totp( key, used ) );
    ok( "the right one goes on to the SSH login", await until( "!! document.getElementById('sshLoginBox')" ) );
    ok( "ssh-totp.json is there, 0600", fs.existsSync( cfg( "ssh-totp.json" ) ) && ( fs.statSync( cfg( "ssh-totp.json" ) ).mode & 0o777 ) === 0o600 );
    ok( "the setup code is spent", ! fs.existsSync( cfg( "ssh-setup-code.txt" ) ) );
    await closeTop();

    //------------------------------------------------------------------------//
    section( "CONNECT AGAIN: ONLY THE CODE IS OFFERED" );

    await click( "#sshConnect" );
    ok( "the code field, no passkey button", await until( "!! document.getElementById('sshOtp') && ! document.getElementById('sshPasskeyBtn')" ) );
    await type( "#sshOtp", totp( key, used ) );
    ok( "the used code is refused: wait for the next", ( await until( "! document.getElementById('sshPkErr').hidden && document.getElementById('sshPkErr').textContent" ) || "" ).indexOf( "next code" ) !== -1 );
    let n = await nextCode( key, used );
    used = n.step;
    await type( "#sshOtp", n.code );
    ok( "the next code goes on", await until( "!! document.getElementById('sshLoginBox')" ) );
    ok( "step 2 says: not the Nayive login", ( await text( ".ssh-explain" ) ).indexOf( "not your Nayive login" ) !== -1 );
    const me = os.userInfo().username;
    ok( "the accounts list, the one Nayive runs as marked and picked", await c.evaluate( `( function () { var p = document.getElementById( 'sshUserPick' );
        return !! p && p.value === ${JSON.stringify( me )} && p.options[ p.selectedIndex ].textContent.indexOf( 'Nayive runs as' ) !== -1; } )()` ) );
    await c.evaluate( "( function () { var p = document.getElementById( 'sshUserPick' ); p.value = ''; p.dispatchEvent( new Event( 'change' ) ); return true; } )()" );
    ok( "Another account… shows the name field", await c.evaluate( "! document.getElementById('sshUser').hidden" ) );
    await type( "#sshUser", "no such" );   // refused before any dial: no login try on this PC
    await type( "#sshPass", "wrong" );
    await c.evaluate( `${top}.querySelector( 'footer .btn.primary' ).click(), true` );
    ok( "a failed login goes back to step 1, with the reason", ( await until( "document.getElementById('sshPkErr') && ! document.getElementById('sshPkErr').hidden && document.getElementById('sshPkErr').textContent", 20000 ) || "" ).indexOf( "Not connected" ) !== -1 );
    ok( "...and says: a NEW code", ( await text( "#sshPkTip" ) ).indexOf( "NEW code" ) !== -1 );
    n = await nextCode( key, used );
    used = n.step;
    await type( "#sshOtp", n.code );
    ok( "step 2 again shows the last try and keeps the name", await until( "! document.getElementById('sshLastErr').hidden && document.getElementById('sshUser').value === 'no such'" ) );
    await closeTop();

    //------------------------------------------------------------------------//
    section( "THE LIST: BOTH KINDS, ADD A PASSKEY, REMOVE THE APP" );

    await c.send( "WebAuthn.enable", { enableUI: false } );
    await c.send( "WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } } );

    await click( "#sshPasskeys" );
    ok( "one row: the app", await until( "document.querySelectorAll('.ayni-pk-list li').length === 1 && document.querySelector('.ayni-pk-list .hint').textContent.indexOf('Authenticator app') === 0" ) );
    ok( "its name", await c.evaluate( "document.querySelector('.ayni-pk-name').textContent" ) === "Phone app" );
    ok( "Add passkey, and no second Add app", await c.evaluate( "document.getElementById('ayniPkAdd').textContent === 'Add passkey' && ! document.querySelector('[data-extra]')" ) );
    await type( "#ayniPkNew", "Laptop" );
    await click( "#ayniPkAdd" );
    ok( "adding asks to confirm: the code", await until( `!! ( ${top} && ${top}.querySelector( '#sshOtp' ) )` ) );
    n = await nextCode( key, used );
    used = n.step;
    await type( "#sshOtp", n.code );
    ok( "two rows now", await until( "document.querySelectorAll('.ayni-pk-list li').length === 2", 20000 ) );
    const keys = JSON.parse( fs.readFileSync( cfg( "ssh-passkeys.json" ), "utf8" ) );
    ok( "the passkey is on disk", keys.length === 1 && keys[ 0 ].name === "Laptop" );

    // Remove the app: the confirm offers both; the passkey does it.
    await c.evaluate( `( function () { var li = Array.prototype.find.call( document.querySelectorAll( '.ayni-pk-list li' ),
        function ( l ) { return l.textContent.indexOf( 'Authenticator app' ) !== -1; } ); li.querySelector( '[data-del]' ).click(); return true; } )()` );
    ok( "removing asks: passkey or code", await until( `!! ( ${top} && ${top}.querySelector( '#sshOtp' ) && ${top}.querySelector( '#sshPasskeyBtn' ) )` ) );
    await click( "#sshPasskeyBtn" );
    ok( "the app is gone", await until( "document.querySelectorAll('.ayni-pk-list li').length === 1 && !! document.querySelector('[data-extra]')", 20000 ) );
    ok( "ssh-totp.json removed", ! fs.existsSync( cfg( "ssh-totp.json" ) ) );
    ok( "the secret never came back in the list", ( await ( async () => c.evaluate( "fetch('/api/ssh/keys').then(r=>r.text())" ) )() ).indexOf( secret ) === -1 );

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
