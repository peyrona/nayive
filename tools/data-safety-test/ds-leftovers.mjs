// ds-leftovers.mjs - small follow-ups of the earlier batches (batch C4c).
//
// Trips newId(): two rows made in the same millisecond (or one apart) got
//     ONE id, and the uploads put one file name on both rows.
// Chat's outbox: after "online" it got ONE try; a failure then (the server
//     restarting) left the message waiting until something else happened.
//     Now it tries again by itself, sooner first, then less often.
// Locker settings (lockers/culture.js): their PUT carried no X-Nayive-User:
//     a page left open while another account signed in on the browser
//     wrote these settings into THAT account's home (L5).
// shared/ui.js: an informational toast (Bookmarks' "Merged") made a pending
//     Undo final; NayiveUI.loginRedirect left a desktop window's page without
//     asking it first (window.nayiveBeforeClose).
import fs from "node:fs";
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";

const s = await server( { test: "test", beto: "bbb" } );
fs.writeFileSync( `${s.run}/apps/outer.html`, `<!doctype html><meta charset=utf-8><title>outer</title>
<iframe id="f" src="/nayive/inner.html"></iframe>` );
fs.writeFileSync( `${s.run}/apps/inner.html`, `<!doctype html><meta charset=utf-8><title>inner</title>
<div id="toast" class="toast"></div><script src="shared/i18n.js"></script><script src="shared/ui.js"></script>` );
const c = await browser( s );
const phone = await s.client();

//----------------------------------------------------------------------------//
section( "TRIPS · NEW IDS NEVER REPEAT" );
{
    await c.open( "/nayive/trips/", "/nayive/trips/" );
    ok( await c.until( "typeof newId === 'function'", 20000 ), "Trips is up" );
    const r = await c.evaluate( "( () => { const s = new Set(); for( let i = 0; i < 3000; i++ ) s.add( newId() ); const one = newId(); return { n: s.size, num: Number.isFinite( one ) }; } )()" );
    ok( r.n === 3000, "3000 ids made at once: 3000 different ones", r );
    ok( r.num, "...and still numbers" );
}

//----------------------------------------------------------------------------//
section( "CHAT · A SEND THAT FAILS AFTER \"ONLINE\" IS TRIED AGAIN BY ITSELF" );
{
    const person = JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name: "Carmen" } ), { "Content-Type": "application/json" } ) ).text );
    const CA = "d-" + person.id;
    const onServer = async () => ( JSON.parse( ( await phone.call( "GET", "/api/chat/conv/" + CA + "/messages" ) ).text ).msgs || [] ).map( m => m.text );
    await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
    // Sends refused by "the server" while window.__failSend is on.
    await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: `( () => { const f = window.fetch; window.fetch = function ( u, o ) {
        if( window.__failSend && o && o.method === 'POST' && /\\/messages$/.test( String( u ) ) ) { window.__refused = ( window.__refused || 0 ) + 1; return Promise.reject( new TypeError( 'Failed to fetch' ) ); }
        return f.apply( this, arguments ); }; } )()` } );
    await c.open( "/nayive/chat/index.html", "/nayive/chat/index.html" );
    ok( await c.until( `document.querySelector( '[data-conv="${CA}"]' )`, 20000 ), "Chat is up" );
    await c.evaluate( `document.querySelector( '[data-conv="${CA}"]' ).click(); true` );
    await c.until( `NayiveChat.S.open === ${JSON.stringify( CA )}` );
    await c.send( "Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    await c.evaluate( `( () => { const t = document.querySelector( '#composer textarea' ); t.value = 'hola otra vez';
        t.dispatchEvent( new InputEvent( 'input', { inputType: 'insertText' } ) ); document.querySelector( '#composer .send' ).click(); return true; } )()` );
    ok( await c.until( "[ ...document.querySelectorAll( '#wall .msg.out' ) ].some( b => b.textContent.includes( 'hola otra vez' ) && b.classList.contains( 'failed' ) )" ),
        "offline: it waits" );
    // The network comes back, but the server is not taking sends yet: the
    // one try "online" gives fails. Then the server is fine - and nothing
    // else happens (no chat opened, the page not shown again).
    await c.evaluate( "window.__failSend = true; window.__refused = 0; true" );
    await c.send( "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );
    ok( await c.until( "window.__refused >= 1 && [ ...document.querySelectorAll( '#wall .msg.out' ) ].some( b => b.textContent.includes( 'hola otra vez' ) && b.classList.contains( 'failed' ) )" ),
        "back online, its one try is refused (the server restarting)" );
    await c.evaluate( "window.__failSend = false; true" );
    let sent = false;
    // Its first retry comes 5 s after that failure (the app's own timer).
    for( let i = 0; i < 150 && ! sent; i++ ) { sent = ( await onServer() ).includes( "hola otra vez" ); if( ! sent ) await new Promise( r => setTimeout( r, 100 ) ); }
    ok( sent, "it goes by itself, a little later" );
    ok( ( await onServer() ).filter( t => t === "hola otra vez" ).length === 1, "...once" );
}

//----------------------------------------------------------------------------//
section( "LOCKER SETTINGS · NEVER INTO ANOTHER ACCOUNT'S HOME" );
{
    await c.open( "/nayive/desktop/index.html" );
    await c.until( "typeof NayiveUI !== 'undefined'" );
    ok( await c.evaluate( `new Promise( ( ok, no ) => { const sc = document.createElement( 'script' ); sc.src = '../shared/lockers/culture.js';
        sc.onload = () => ok( !! window.NayiveSalon ); sc.onerror = no; document.head.appendChild( sc ); } )` ), "the locker's settings code is loaded (test's page)" );
    ok( await c.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { user: 'beto', password: 'bbb' } ) } ).then( r => r.status === 200 )` ), "beto signs in on this browser" );
    const r = await c.evaluate( "NayiveSalon.update( function ( s ) { s.units = 'f'; return s; } ).then( () => 'written', e => String( e && e.message ) )" );
    ok( onDisk( s, "data/salon.json", "beto" ) === null, "test's settings did not land in beto's home", r );
    ok( /423/.test( r ), "the server refused it (another account's page: 423)", r );
    await c.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { user: 'test', password: 'test' } ) } ).then( r => r.status )` );
}

//----------------------------------------------------------------------------//
section( "UI · AN INFORMATIONAL TOAST WAITS FOR A PENDING UNDO" );
{
    await c.open( "/nayive/inner.html" );
    ok( await c.until( "window.NayiveUI && NayiveUI.undoToast" ), "a page with the shared UI" );
    await c.evaluate( `window.__undone = false; window.__final = false; window.__seen = [];
        new MutationObserver( () => { const t = document.getElementById( 'toast' ); if( t.classList.contains( 'show' ) ) window.__seen.push( t.textContent ); } )
            .observe( document.getElementById( 'toast' ), { attributes: true, childList: true, subtree: true, characterData: true } );
        NayiveUI.undoToast( 'Deleted', function () { window.__undone = true; }, { ms: 20000, onExpire: function () { window.__final = true; } } );
        NayiveUI.toast( 'Merged', { keepUndo: true } ); true` );
    ok( await c.evaluate( "!! document.querySelector( '#toast .toast-undo' ) && ! window.__final" ), "the Undo is still on show, not final" );
    await c.evaluate( "( document.querySelector( '#toast .toast-undo' ) || { click: function () {} } ).click(), true" );
    ok( await c.evaluate( "window.__undone" ), "and it still undoes" );
    ok( await c.until( "window.__seen.some( t => t === 'Merged' )" ), "the news is shown once the Undo is gone" );
}

//----------------------------------------------------------------------------//
section( "UI · SIGN-IN FROM A DESKTOP WINDOW ASKS THE WINDOW FIRST" );
{
    await c.open( "/nayive/outer.html" );
    ok( await c.until( "document.getElementById( 'f' ).contentWindow.NayiveUI" ), "a framed page (a desktop window's)" );
    await c.evaluate( `( () => { const w = document.getElementById( 'f' ).contentWindow; window.__asked = 0;
        w.nayiveBeforeClose = function () { window.__asked++; return new Promise( function ( r ) { window.__answer = r; } ); };
        w.NayiveUI.loginRedirect(); return true; } )()` );
    ok( await c.until( "window.__asked === 1", 5000 ), "it asks the window before leaving" );
    await c.evaluate( "window.__answer && window.__answer( false ), true" );                   // "stay"
    ok( await c.until( "location.pathname === '/nayive/outer.html' && ( document.getElementById( 'f' ).contentWindow.NayiveUI.loginRedirect(), true ) && window.__asked === 2", 5000 ),
        "\"stay\": nothing left, and the button asks again" );
    await c.evaluate( "window.__answer && window.__answer( true ), true" );
    ok( await c.until( "location.pathname === '/nayive/login.html'", 10000 ), "\"go\": to the sign-in page" );
}

await done( c, s );
