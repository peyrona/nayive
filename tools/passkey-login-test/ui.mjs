/*
 * ui.mjs - sign in with a passkey, in a real browser over a real server
 * (client/apps/login.html, shared/login-passkeys.js, server/go/login_passkey.go).
 *
 *     node tools/passkey-login-test/ui.mjs          # from the repo root
 *
 * Builds server/go into a scratch run-root (admin "jefe", user "ana"), copies
 * client/apps, bypasses the service worker. The passkey lives on Chromium's
 * virtual authenticator (CDP WebAuthn), which touches and verifies by itself.
 */
import { spawn, spawnSync } from "node:child_process";
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "pk-login-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://localhost:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/ana/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/ana/files`, { recursive: true } );
fs.writeFileSync( `${RUN}/homes/ana/data/config.json`, JSON.stringify( { password: "abc" } ) );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( `http://127.0.0.1:${PORT}/api/whoami` ); break; } catch { await sleep( 100 ); } }

const b = await browser();
let c;
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "WebAuthn.enable" );
    const { authenticatorId } = ( await c.send( "WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true } } ) ).result;

    const until = async ( expr, ms = 15000 ) =>
    {
        const end = Date.now() + ms;
        for( ;; ) { let v = null; try { v = await c.evaluate( expr ); } catch {} if( v || Date.now() > end ) return v; await sleep( 120 ); }
    };
    const click = sel => c.evaluate( `( function () { var e = document.querySelector( ${JSON.stringify( sel )} ); if ( ! e ) return false; e.click(); return true; } )()` );
    const type = ( sel, v ) => c.evaluate( `( function () { var e = document.querySelector( ${JSON.stringify( sel )} ); e.value = ${JSON.stringify( v )};
        e.dispatchEvent( new Event( 'input', { bubbles: true } ) ); return true; } )()` );
    const askOk = "( function () { var d = document.querySelectorAll( 'dialog[open]' ); d = d[ d.length - 1 ]; var b = d.querySelector( '.btn.primary' ); b.click(); return true; } )()";
    const keys = `${RUN}/homes/ana/data/passkeys.json`;

    //------------------------------------------------------------------------//
    section( "ADD A PASSKEY IN MY ACCOUNT" );

    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await c.evaluate( `localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'ana',password:'abc',remember:true})}).then(r=>r.status)` );
    ok( "signed in as ana with the password", st === 200, st );
    await c.send( "Page.navigate", { url: BASE + "/nayive/" } );
    ok( "the launcher has the passkeys row", await until( "document.readyState === 'complete' && !! document.getElementById('loginPkBtn')" ) );
    await click( "#loginPkBtn" );
    ok( "the Sign-in passkeys dialog opens", await until( "!! document.getElementById('ayniPkAdd')" ) );
    await type( "#ayniPkNew", "Laptop" );
    await click( "#ayniPkAdd" );
    ok( "it asks the password", await until( "!! document.getElementById('ayni-ask-pw')" ) );
    await type( "#ayni-ask-pw", "wrong" );
    await c.evaluate( askOk );
    ok( "a wrong password is refused", ( await until( "( function () { var e = document.getElementById('ayniPkErr'); return e && ! e.hidden && e.textContent; } )()" ) || "" ).indexOf( "Wrong password" ) !== -1 );
    ok( "nothing saved", ! fs.existsSync( keys ) );
    await type( "#ayniPkNew", "Laptop" );
    await click( "#ayniPkAdd" );
    await until( "!! document.getElementById('ayni-ask-pw')" );
    await type( "#ayni-ask-pw", "abc" );
    await c.evaluate( askOk );
    ok( "the passkey is listed", await until( "[ ...document.querySelectorAll('.ayni-pk-name') ].some( e => e.textContent === 'Laptop' )" ) );
    ok( "passkeys.json is there, 0600", fs.existsSync( keys ) && ( fs.statSync( keys ).mode & 0o777 ) === 0o600 );
    const creds = ( await c.send( "WebAuthn.getCredentials", { authenticatorId } ) ).result.credentials;
    ok( "a discoverable passkey on the device", creds.length === 1 && creds[ 0 ].isResidentCredential, creds );

    //------------------------------------------------------------------------//
    section( "SIGN OUT, SIGN IN WITH THE PASSKEY - NO NAME TYPED" );

    await c.evaluate( "fetch('/api/logout',{method:'POST'}).then(r=>r.status)" );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    ok( "the passkey button shows", await until( "document.readyState === 'complete' && ! document.getElementById('pkBtn').hidden" ),
        await c.evaluate( "JSON.stringify({ path: location.pathname, pk: !! window.AyniPasskey, sup: window.AyniPasskey && AyniPasskey.supported(), btn: !! document.getElementById('pkBtn'), scripts: [ ...document.scripts ].map( s => s.src ).filter( s => /passkey/.test( s ) ) })" ) + c.logs.join( " / " ) );
    ok( "its label is translated", ( await c.evaluate( "document.querySelector('#pkBtn .label').textContent" ) ) === "Sign in with a passkey" );
    await click( "#pkBtn" );
    ok( "the launcher opens", await until( "location.pathname === '/nayive/' && document.readyState === 'complete'", 20000 ) );
    const me = await until( "fetch('/api/whoami').then(r=>r.json()).then(j=>j.user)" );
    ok( "signed in as ana", me === "ana", me );
    ok( "the passkey shows as used", !! JSON.parse( fs.readFileSync( keys, "utf8" ) ).keys[ 0 ].used );

    //------------------------------------------------------------------------//
    section( "REMOVE IT: THE PASSKEY NO LONGER SIGNS IN" );

    await until( "!! document.getElementById('loginPkBtn')" );
    await click( "#loginPkBtn" );
    await until( "!! document.querySelector('[data-del]')" );
    await click( "[data-del]" );
    await until( "!! document.getElementById('ayni-ask-pw')" );
    await type( "#ayni-ask-pw", "abc" );
    await c.evaluate( askOk );
    ok( "the list is empty", await until( "!! document.getElementById('ayniPkAdd') && ! document.querySelector('.ayni-pk-name')" ) );
    await c.evaluate( "fetch('/api/logout',{method:'POST'}).then(r=>r.status)" );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await until( "document.readyState === 'complete' && ! document.getElementById('pkBtn').hidden" );
    await click( "#pkBtn" );
    ok( "refused, with a hint to use the password", ( await until( "document.getElementById('error').textContent" ) || "" ).indexOf( "password" ) !== -1 );
    ok( "still on the login page", await c.evaluate( "location.pathname" ) === "/nayive/login.html" );

    //------------------------------------------------------------------------//
    section( "AUTOFILL COMES BACK; NO SERVER, NO LOOP" );

    // Count the login challenges the page asks for.
    await c.evaluate( `window.__lb = 0; window.__f = window.fetch; window.__down = false;
        window.fetch = function ( u, o ) { if( /login-begin/.test( String( u ) ) ) { window.__lb++; if( window.__down ) return Promise.reject( new TypeError( 'offline' ) ); }
            return window.__f.apply( this, arguments ); }; true` );
    const auto = await c.evaluate( "PublicKeyCredential.isConditionalMediationAvailable ? PublicKeyCredential.isConditionalMediationAvailable() : false" );
    await click( "#pkBtn" );
    await sleep( 5000 );
    const n1 = await c.evaluate( "window.__lb" );
    // Chromium's virtual authenticator answers the autofill offer by itself:
    // each refusal starts it again, until the third.
    ok( "after a refusal the autofill offer starts again", auto ? n1 >= 2 && n1 <= 3 : n1 === 1, { auto, n1 } );
    await sleep( 3000 );
    ok( "...and stops after three refusals", await c.evaluate( "window.__lb" ) === n1 );
    await c.evaluate( "window.__down = true; window.__lb = 0; true" );
    await click( "#pkBtn" );
    await sleep( 4000 );
    const n2 = await c.evaluate( "window.__lb" );
    ok( "no server: one try, no loop", n2 === 1, n2 );
    ok( "and it says so", !! await c.evaluate( "document.getElementById('error').textContent" ) );

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
