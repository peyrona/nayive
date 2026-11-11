// ds-login-leftovers.mjs - the sign-in page's LEFTOVERS wipe (D2,
// docs/audit/predeploy-2026-11.md).
//
// D2: the last session here had "Keep me signed in" off ("nayive-shared" = 1)
//     and ended with no sign-out (browser closed, the 12 h ran out). The next
//     visit to login.html asked the server to wipe the browser
//     (X-Nayive-Forget -> Clear-Site-Data) at once - the saves still only here
//     went with it, unasked. Now it counts first (AyniStore.localCount): any
//     unsent work keeps the browser as it is, and its owner's next sign-in
//     sends it. Nothing unsent: the wipe still happens.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { stPage, untilNode } from "./store-lib.mjs";

const s = await server( { ana: "aaa", beto: "bbb" } );
stPage( s );

// On login.html only: every fetch is noted in window.__calls ("logout+forget",
// "whoami", "login"); the sign-in POST is held until window.__go() so the
// page stays to be looked at. The sign-in waits for LEFTOVERS first, so once
// "login" is noted, LEFTOVERS is over.
const WATCH = `( () => { if( ! /login\\.html$/.test( location.pathname ) ) return;
    const f = window.fetch; window.__calls = []; let go; const gate = new Promise( r => go = r ); window.__go = () => go();
    window.fetch = async function ( u, o ) {
        const url = String( u && u.url || u ), h = ( o && o.headers ) || {};
        if( /\\/api\\/logout$/.test( url ) ) window.__calls.push( h[ 'X-Nayive-Forget' ] === '1' ? 'logout+forget' : 'logout' );
        else if( /\\/api\\/whoami$/.test( url ) ) window.__calls.push( 'whoami' );
        else if( /\\/api\\/login$/.test( url ) ) { window.__calls.push( 'login' ); await gate; }
        return f.apply( this, arguments );
    }; } )()`;

// The session's cookie gone with no sign-out: the browser was closed.
async function sessionEnds( c )
{
    await c.send( "Network.clearBrowserCookies" );
    ok( await c.evaluate( "fetch( '/api/whoami' ).then( r => r.status === 401 )" ), "no session left" );
}

async function signIn( c, user, pw )
{
    await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: WATCH } );
    ok( await c.open( "/nayive/login.html" ), "the sign-in page is up" );
    ok( await c.until( "document.getElementById( 'notMine' ).hidden === false" ), "it says \"not your device?\" (the mark is there)" );
    await c.evaluate( `( () => { document.getElementById( 'user' ).value = ${JSON.stringify( user )};
        document.getElementById( 'password' ).value = ${JSON.stringify( pw )};
        document.getElementById( 'loginForm' ).requestSubmit(); return true; } )()` );
    ok( await c.until( "window.__calls.includes( 'login' )", 20000 ), "the sign-in is sent (LEFTOVERS is over)" );
    return c.evaluate( "window.__calls.slice()" );
}

//----------------------------------------------------------------------------//
section( "D2 · UNSENT WORK IS NEVER WIPED BY THE SIGN-IN PAGE" );
{
    const A = await browser( s, { user: "ana" } );
    await A.open( "/nayive/st.html" );
    ok( await A.evaluate( "offline( true ), SC.write( 'files/kept.txt', 'only on this browser\\n' ).then( r => r.offline )" ),
        "ana saves offline: it waits here" );
    await A.evaluate( "localStorage.setItem( 'nayive-shared', '1' ), true" );
    await sessionEnds( A );

    const calls = await signIn( A, "ana", "aaa" );
    ok( calls.includes( "whoami" ) && ! calls.some( x => x.indexOf( "logout" ) === 0 ),
        "no wipe asked for: a save is still here", calls );
    // Read straight from the browser: st.html's idb() is not on this page.
    const box = await A.evaluate( `new Promise( res => { const q = indexedDB.open( 'nube-store' ); q.onsuccess = () => {
        const g = q.result.transaction( 'outbox' ).objectStore( 'outbox' ).getAllKeys(); g.onsuccess = () => { q.result.close(); res( g.result ); }; }; } )` );
    ok( box.includes( "files/kept.txt" ), "her save is still in the browser", box );

    await A.evaluate( "window.__go(), true" );
    ok( await A.until( "location.pathname === '/nayive/'", 20000 ), "signed in: the launcher" );
    ok( await untilNode( () => onDisk( s, "files/kept.txt", "ana" ) === "only on this browser\n" ),
        "and her sign-in sends it up" );
    await A.stop();
}

//----------------------------------------------------------------------------//
section( "D2 · NOTHING UNSENT: THE BROWSER IS STILL WIPED" );
{
    const B = await browser( s, { user: "beto" } );
    await B.open( "/nayive/st.html" );
    const box = await B.evaluate( "idb( 'outbox' )" );
    ok( Array.isArray( box ) && box.length === 0, "nothing waits here", box );
    await B.evaluate( "localStorage.setItem( 'nayive-shared', '1' ), true" );
    await sessionEnds( B );

    const calls = await signIn( B, "beto", "bbb" );
    ok( calls.includes( "logout+forget" ), "the wipe is asked for, as before", calls );
    await B.evaluate( "window.__go(), true" );
    ok( await B.until( "location.pathname === '/nayive/'", 20000 ), "signed in: the launcher" );
    await done( B, s );
}
