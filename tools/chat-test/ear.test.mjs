/*
 * ear.test.mjs - a voice call at the ear (client/apps/chat/ear.js): the padlock
 * and the call to the Android app, driven with real touches in headless
 * Chromium (which reports a touch screen). The server's half is
 * server/go/devices_ear_test.go.
 *
 *   node tools/chat-test/ear.test.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, attach } from "../cdp.mjs";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const apps = path.join( here, "../../client/apps" );

// The page: ear.js and chat.css as they ship, NayiveChat's three helpers, and
// a button under the padlock that counts the presses it gets.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/chat/chat.css">
<style>body { margin: 0; height: 100vh; } #under { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; }</style>
<script>
window.presses = 0;
function h( tag, o ) {
    var el = document.createElement( tag ); o = o || {};
    if( o.class ) el.className = o.class;
    if( o.text ) el.textContent = o.text;
    Object.keys( o.attrs || {} ).forEach( function ( k ) { if( o.attrs[ k ] === true ) el.setAttribute( k, "" ); else el.setAttribute( k, o.attrs[ k ] ); } );
    [].slice.call( arguments, 2 ).forEach( function ( c ) { el.appendChild( c ); } );
    return el;
}
window.NayiveChat = { h: h, T: function ( k ) { return k; },
                      ic: function () { return document.createElementNS( "http://www.w3.org/2000/svg", "svg" ); } };
</script>
<script src="/chat/ear.js"></script>
</head><body><button id="under" onclick="presses++">hang up</button></body></html>`;

// The server: what the page told it, and what it answers ("app").
let told = [], answerApp = false;
const server = http.createServer( ( req, res ) =>
{
    if( req.url === "/favicon.ico" ) { res.writeHead( 204 ).end(); return; }
    if( req.url === "/t.html" ) { res.writeHead( 200, { "Content-Type": "text/html" } ).end( PAGE ); return; }
    const m = /^\/api\/device\/([^/]+)\/ear$/.exec( req.url );
    if( m && req.method === "POST" )
    {
        let body = "";
        req.on( "data", d => body += d );
        req.on( "end", () =>
        {
            told.push( { id: decodeURIComponent( m[ 1 ] ), on: JSON.parse( body ).on } );
            res.writeHead( 200, { "Content-Type": "application/json" } ).end( JSON.stringify( { ok: true, app: answerApp } ) );
        } );
        return;
    }
    const file = path.join( apps, req.url.split( "?" )[ 0 ] );
    if( ! file.startsWith( apps ) || ! fs.existsSync( file ) ) { res.writeHead( 404 ).end(); return; }
    res.writeHead( 200, { "Content-Type": file.endsWith( ".css" ) ? "text/css" : "text/javascript" } ).end( fs.readFileSync( file ) );
} );
await new Promise( r => server.listen( 0, "127.0.0.1", r ) );
const base = "http://127.0.0.1:" + server.address().port;

let fails = 0, passes = 0;
function check( name, ok, more )
{
    if( ok ) passes++;
    else { fails++; console.log( "FAIL " + name + ( more !== undefined ? "  (" + JSON.stringify( more ) + ")" : "" ) ); }
}
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const b = await browser();
try
{
    const targets = await ( await fetch( "http://127.0.0.1:" + b.port + "/json" ) ).json();
    const { send, evaluate, logs } = await attach( targets.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true } );
    await send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 } );

    async function load( device )
    {
        await send( "Page.navigate", { url: base + "/t.html" } );
        for( let i = 0; i < 100 && await evaluate( "!! ( document.readyState === 'complete' && window.NayiveChat && NayiveChat.ear )" ).catch( () => false ) !== true; i++ ) await sleep( 50 );
        await evaluate( device ? "localStorage.setItem( 'nayive-device', JSON.stringify( { id: 'P1' } ) ), 1"
                               : "localStorage.removeItem( 'nayive-device' ), 1" );
        await send( "Page.bringToFront" );
        told = [];
    }
    const locked  = () => evaluate( "!! ( document.querySelector( '.ear-pad' ) && ! document.querySelector( '.ear-pad' ).hidden )" );
    const presses = () => evaluate( "presses" );
    const knobAt  = () => evaluate( "( function () { var r = document.querySelector( '.ear-knob' ).getBoundingClientRect(), t = document.querySelector( '.ear-track' ).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, end: t.right - 8 }; } )()" );

    const point = ( x, y, id = 0, r = 5 ) => ( { x, y, id, radiusX: r, radiusY: r } );
    async function tap( x, y, r = 5 )
    {
        await send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ point( x, y, 0, r ) ] } );
        await send( "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] } );
    }
    async function slide( from, toX, r = 5 )
    {
        await send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ point( from.x, from.y, 0, r ) ] } );
        for( let i = 1; i <= 10; i++ )
            await send( "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [ point( from.x + ( toX - from.x ) * i / 10, from.y, 0, r ) ] } );
        await send( "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] } );
    }

    // --- no app: the padlock ------------------------------------------------
    await load( false );
    check( "touch screen seen", await evaluate( "matchMedia( '(hover: none) and (pointer: coarse)' ).matches" ) );
    await evaluate( "NayiveChat.ear( true, true ), 1" );
    await sleep( 1500 );
    check( "no padlock before 3 s", ! await locked() );
    await tap( 195, 300 );                       // a touch starts the count again
    await sleep( 2200 );
    check( "a touch pushes the padlock back", ! await locked() );
    await sleep( 1200 );
    check( "padlock after 3 s without a touch", await locked() );
    check( "no device: the server is not asked", told.length === 0, told );

    await tap( 195, 760 );                       // the ear on "hang up"
    await tap( 60, 760 );
    check( "nothing under the padlock is pressed", await presses() === 0, await presses() );

    let k = await knobAt();
    await slide( k, k.x + 60 );
    await sleep( 300 );
    check( "half a slide keeps it locked", await locked() );

    await slide( k, k.x + 400, 40 );             // a cheek: 80 px wide
    await sleep( 300 );
    check( "a wide contact cannot slide it", await locked() );

    // Two contacts: the slide stops halfway.
    await send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ point( k.x, k.y, 0 ) ] } );
    await send( "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [ point( k.x + 50, k.y, 0 ) ] } );
    await send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ point( k.x + 50, k.y, 0 ), point( 100, 200, 1 ) ] } );
    await send( "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [ point( k.end, k.y, 0 ), point( 100, 200, 1 ) ] } );
    await send( "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] } );
    await sleep( 300 );
    check( "two contacts cannot slide it", await locked() );

    await slide( k, k.end + 40 );
    await sleep( 300 );
    check( "a full slide opens it", ! await locked() );
    check( "...and no press leaked through", await presses() === 0, await presses() );
    await tap( 195, 760 );
    check( "open: the buttons work again", await presses() === 1, await presses() );
    await sleep( 3400 );
    check( "it locks again 3 s later", await locked() );

    await evaluate( "NayiveChat.ear( true, false ), 1" );   // the small box
    check( "small box: no padlock", ! await locked() );
    await sleep( 3400 );
    check( "small box: it does not come back", ! await locked() );
    await evaluate( "NayiveChat.ear( true, true ), 1" );
    await sleep( 3400 );
    check( "full screen again: padlock", await locked() );
    await evaluate( "NayiveChat.ear( false, false ), 1" );   // the call ends
    check( "call over: padlock gone", ! await locked() );

    // --- a phone whose app has no sensor (or an old APK): the padlock -------
    answerApp = false;
    await load( true );
    await evaluate( "NayiveChat.ear( true, true ), 1" );
    await sleep( 3400 );
    check( "app says no: padlock", await locked() );
    check( "...after asking the server for P1", told.length === 1 && told[ 0 ].id === "P1" && told[ 0 ].on === true, told );
    await evaluate( "NayiveChat.ear( false, false ), 1" );
    await sleep( 300 );
    check( "call over: told off", told.length === 2 && told[ 1 ].on === false, told );

    // --- the app turns the screen off: no padlock ---------------------------
    answerApp = true;
    await load( true );
    await evaluate( "NayiveChat.ear( true, true ), 1" );
    await sleep( 3400 );
    check( "app says yes: no padlock", ! await locked() );
    await evaluate( "NayiveChat.ear( true, true ), NayiveChat.ear( true, false ), NayiveChat.ear( true, true ), 1" );
    await sleep( 200 );
    check( "renders do not ask again", told.length === 1, told );
    await evaluate( "NayiveChat.ear( false, false ), 1" );
    await sleep( 300 );
    check( "call over: the app is told off", told.length === 2 && told[ 1 ].on === false, told );

    const bad = logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) );
    check( "no errors in the page", bad.length === 0, bad );
}
finally
{
    await b.kill();
    server.close();
}

console.log( ( fails ? "FAILED " + fails : "OK" ) + " - " + passes + " passed" );
process.exit( fails ? 1 : 0 );
