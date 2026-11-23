// night-ask-smoke.mjs - the "without sound?" question at night (compose.js nightAsk):
// node tools/chat-test/night-ask-smoke.mjs
// It is a modal dialog: a press outside it and Esc do nothing, so the photo
// (already out of its sheet) and its caption are never lost. Only its two
// answers send.
import { server, browser, ok, section, done, click, type } from "../data-safety-test/lib.mjs";

const s = await server();
const phone = await s.client();
async function person( name )
{
    return "d-" + JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name } ),
                                                  { "Content-Type": "application/json" } ) ).text ).id;
}
const CA = await person( "Carmen" ), LU = await person( "Luis" );
const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
await c.open( "/nayive/chat/index.html" );
ok( await c.until( `document.querySelector( '[data-conv="${CA}"]' )` ), "Chat opens" );

// It is night now for everybody else in `conv`.
const NIGHT = `( conv ) => {
    const zs = [ "Pacific/Kiritimati", "Asia/Tokyo", "Asia/Kolkata", "Europe/Madrid", "America/New_York", "America/Los_Angeles", "Pacific/Honolulu" ];
    const z = zs.find( z => { const h = +new Intl.DateTimeFormat( "en-GB", { timeZone: z, hour: "2-digit", hourCycle: "h23" } ).format( new Date() ); return h >= 22 || h < 10; } );
    const w = NayiveChat.W( conv ); w.zones = {};
    NayiveChat.membersOf( conv ).forEach( p => { if( p !== w.me ) w.zones[ p ] = z; } );
    return !! z; }`;
async function openChat( conv )
{
    await c.evaluate( `document.querySelector( '[data-conv="${conv}"]' ).click(); true` );
    const opened = await c.until( `NayiveChat.S.open === "${conv}"` );
    return opened && c.evaluate( `( ${NIGHT} )( "${conv}" )` );
}

const ASK   = "document.querySelector( 'dialog.panel[open] .pick-opt' )";
const msgs  = ( kind ) => c.evaluate( `[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === "${kind}" && m.id > 0 ).map( m => ( { text: m.text || "", silent: !! m.silent } ) )` );
const settle = ( kind, n ) => c.until( `[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === "${kind}" && m.id > 0 ).length >= ${n}`, 20000 );
const wait  = ( ms ) => new Promise( r => setTimeout( r, ms ) );
async function outside()
{
    await c.send( "Page.bringToFront" );
    for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] )
        await c.send( "Input.dispatchMouseEvent", { type, x: 6, y: 6, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } );
}
async function esc()
{
    await c.send( "Page.bringToFront" );
    for( const type of [ "keyDown", "keyUp" ] )
        await c.send( "Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 } );
}
async function staysOpen( what )
{
    await wait( 600 );
    ok( await c.evaluate( "!! " + ASK ), what + ": the question stays" );
}

section( "A PHOTO WITH A CAPTION, AT NIGHT" );
ok( await openChat( CA ), "Carmen's chat opens, and it is night for her" );
await c.evaluate( `( async () => {
    const cv = document.createElement( "canvas" ); cv.width = 80; cv.height = 60;
    const b = await new Promise( r => cv.toBlob( r, "image/jpeg", 0.9 ) );
    const dt = new DataTransfer(); dt.items.add( new File( [ b ], "foto.jpg", { type: "image/jpeg" } ) );
    document.dispatchEvent( new DragEvent( "drop", { dataTransfer: dt, bubbles: true, cancelable: true } ) );
    return true; } )()` );
ok( await c.until( "document.querySelector( 'dialog.panel[open] .prev-one' )" ), "the Photo sheet opens" );
await c.evaluate( "document.querySelector( 'dialog.panel[open] input.input' ).focus(); true" );
await type( c, "Buenas noches" );
await click( c, "dialog.panel[open] footer button:last-child" );
ok( await c.until( ASK ), "Send asks: without sound?" );
ok( await c.evaluate( "document.querySelector( 'dialog.panel[open]' ).matches( ':modal' )" ), "as a modal dialog" );
ok( await c.evaluate( "! document.querySelector( 'dialog.panel[open] [data-close]' )" ), "with no ×" );
await outside();
await staysOpen( "a press outside" );
await esc();
await staysOpen( "Esc" );
const photos0 = ( await msgs( "photo" ) ).length;
ok( photos0 === 0, "nothing went yet" );
await click( c, "dialog.panel[open] .pick-opt:nth-of-type(1) button" );
ok( await settle( "photo", 1 ), "Without sound: the photo goes" );
const ph = ( await msgs( "photo" ) ).pop();
ok( ph.text === "Buenas noches" && ph.silent, "with its caption, without sound", ph );
ok( await c.evaluate( "! document.querySelector( 'dialog.panel[open]' )" ), "the question is gone" );

section( "A TEXT, AT NIGHT: WITH SOUND" );
ok( await openChat( LU ), "Luis's chat opens, and it is night for him" );
await c.evaluate( "NayiveChat.focusComposer(); true" );
await type( c, "Hola Luis" );
await c.evaluate( "document.querySelector( '.btn.primary.send' ).click(); true" );
ok( await c.until( ASK ), "Send asks" );
await outside();
await staysOpen( "a press outside" );
await click( c, "dialog.panel[open] .pick-opt:nth-of-type(2) button" );
ok( await settle( "text", 1 ), "With sound: the text goes" );
const tx = ( await msgs( "text" ) ).pop();
ok( tx.text === "Hola Luis" && ! tx.silent, "with sound", tx );

section( "THE ANSWER HOLDS FOR AN HOUR" );
await c.evaluate( "NayiveChat.focusComposer(); true" );
await type( c, "Otra" );
await c.evaluate( "document.querySelector( '.btn.primary.send' ).click(); true" );
ok( await settle( "text", 2 ), "the next text goes" );
ok( await c.evaluate( "! " + ASK ), "without asking again" );

await done( c, s );
