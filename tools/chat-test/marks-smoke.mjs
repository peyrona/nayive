// marks-smoke.mjs - Chat's text marks and format bar in a real browser:
// node tools/chat-test/marks-smoke.mjs [screenshot.png]
// The bar shows on focus and keeps it while pressed; B / list toggle;
// a new line in a "- " item; bubbles draw <b> and <ul>; the list strips.
import fs from "node:fs";
import { server, browser, ok, section, done, click, type, sleep } from "../data-safety-test/lib.mjs";

const s = await server();
const phone = await s.client();
const CA = "d-" + JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name: "Carmen" } ),
                                                  { "Content-Type": "application/json" } ) ).text ).id;
const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
await c.open( "/nayive/chat/index.html" );
ok( await c.until( `document.querySelector( '[data-conv="${CA}"]' )` ), "Chat opens" );
await c.evaluate( `document.querySelector( '[data-conv="${CA}"]' ).click(); true` );
ok( await c.until( `NayiveChat.S.open === "${CA}" && ! document.getElementById( 'vConv' ).hidden` ), "Carmen's chat opens" );

const TA = "document.querySelector( '#composer textarea' )";
const val = () => c.evaluate( TA + ".value" );
const set = ( v, a, b ) => c.evaluate( `( () => { const t = ${TA}; t.focus(); t.value = ${JSON.stringify( v )};
    t.setSelectionRange( ${a ?? v.length}, ${b ?? a ?? v.length} ); return true; } )()` );
const sel = () => c.evaluate( `[ ${TA}.selectionStart, ${TA}.selectionEnd ]` );
const barOn = () => c.evaluate( "document.querySelector( '.fmt-bar' ).classList.contains( 'on' )" );
const focused = () => c.evaluate( `document.activeElement === ${TA}` );
const btn = n => `.fmt-bar .icon-btn:nth-child(${n + 1})`;     // the 1st is the "←"
const shiftEnter = async () =>
{
    for( const type of [ "rawKeyDown", "char", "keyUp" ] )
        await c.send( "Input.dispatchKeyEvent", { type: type === "char" ? "char" : type, key: "Enter", code: "Enter",
                      windowsVirtualKeyCode: 13, modifiers: 8, text: type === "char" ? "\r" : undefined } );
};

section( "THE BAR" );
ok( ! await barOn(), "hidden at first" );
await click( c, "#composer textarea" );
ok( ! await barOn(), "focus alone does not show it" );
await click( c, "#fmtBtn" );
ok( await barOn() && await focused(), "the T shows it, the box keeps the focus" );
await sleep( 300 );
ok( await c.evaluate( "getComputedStyle( document.querySelector( '.fmt-bar' ) ).opacity" ) === "1", "fully shown after the rise" );
const shot = process.argv[ 2 ];
if( shot )
{
    await set( "Hola *Carmen*" );
    const p = await c.send( "Page.captureScreenshot", { format: "png", clip: { x: 0, y: 560, width: 1280, height: 240, scale: 1 } } );
    fs.writeFileSync( shot, Buffer.from( p.data ?? p.result?.data, "base64" ) );
}

section( "B / I / S" );
await set( "say hola now", 4, 8 );
await click( c, btn( 1 ) );
ok( await val() === "say *hola* now", "B wraps the selection", await val() );
ok( await focused() && await barOn(), "the box keeps the focus, the bar stays" );
ok( JSON.stringify( await sel() ) === "[4,10]", "the wrapped words stay selected", await sel() );
await click( c, btn( 1 ) );
ok( await val() === "say hola now", "B again takes the marks away", await val() );
await c.evaluate( "document.execCommand( 'undo' )" );
ok( await val() === "say *hola* now", "Ctrl+Z gives the change back", await val() );
await set( "say hola now", 5, 9 );
await click( c, btn( 2 ) );
ok( await val() === "say h_ola_ now", "I with a space at the edge leaves it out", await val() );
await set( "x ", 2 );
await click( c, btn( 3 ) );
ok( await val() === "x ~~" && JSON.stringify( await sel() ) === "[3,3]", "S with nothing selected: the pair, cursor inside", [ await val(), await sel() ] );
await click( c, btn( 3 ) );
ok( await val() === "x ", "S again on the empty pair: gone", await val() );
await set( "a ~b~ c", 3, 4 );
await click( c, btn( 3 ) );
ok( await val() === "a b c", "S on a word inside its marks takes them away", await val() );

section( "LIST" );
await set( "milk\neggs", 0, 9 );
await click( c, btn( 4 ) );
ok( await val() === "- milk\n- eggs", "list marks every selected line", await val() );
await click( c, btn( 4 ) );
ok( await val() === "milk\neggs", "list again takes it away", await val() );
await set( "Buy:\nmilk", 7 );
await click( c, btn( 4 ) );
ok( await val() === "Buy:\n- milk" && JSON.stringify( await sel() ) === "[9,9]", "no selection: the cursor's line only", [ await val(), await sel() ] );
await set( "- milk" );
await shiftEnter();
ok( await val() === "- milk\n- ", "a new line after an item starts the next one", await val() );
await shiftEnter();
ok( await val() === "- milk\n", "a new line from an empty item ends the list", await val() );
await shiftEnter();
ok( await val() === "- milk\n\n", "then new lines are plain again", await val() );

section( "BUBBLES AND THE LIST" );
const sendText = async t => { await set( t ); await c.evaluate( "document.querySelector( '#composer .send' ).click(); true" ); };
await sendText( "*hi* and https://x.com/a_b_c" );
ok( await c.until( `[ ...document.querySelectorAll( '#wall .msg.out b' ) ].some( b => b.textContent === 'hi' )` ), "*hi* is bold in the bubble" );
ok( await c.evaluate( `[ ...document.querySelectorAll( '#wall .msg.out a' ) ].some( a => a.href === 'https://x.com/a_b_c' )` ), "the link stays whole" );
ok( await c.until( `( document.querySelector( '[data-conv="${CA}"] .prev' ) || {} ).textContent?.includes( 'hi and https' )` ), "the list row shows no marks" );
await sendText( "Buy:\n- milk\n- eggs" );
ok( await c.until( `[ ...document.querySelectorAll( '#wall .msg.out ul' ) ].some( u => u.children.length === 2 )` ), "two items make one list" );
ok( await c.until( `( document.querySelector( '[data-conv="${CA}"] .prev' ) || {} ).textContent?.includes( '• milk' )` ), "the list row shows bullets" );
ok( await focused(), "after sending the box keeps the focus" );
await c.evaluate( "document.getElementById( 'fmtBtn' ).click(); true" );
ok( await barOn(), "the T brings the bar up again" );
await sendText( "Plan:\n\n- *bold item*\n- _italic_ and ~gone~\nThanks!" );
ok( ! await barOn(), "sending folds the bar" );
await sleep( 800 );
if( shot )
{
    const p = await c.send( "Page.captureScreenshot", { format: "png", clip: { x: 340, y: 0, width: 940, height: 420, scale: 1 } } );
    fs.writeFileSync( shot.replace( /\.png$/, "-wall.png" ), Buffer.from( p.data ?? p.result?.data, "base64" ) );
}

section( "RIGHT-CLICK MENU" );
const at = await c.evaluate( `( () => { const r = [ ...document.querySelectorAll( '#wall .msg.out' ) ].pop().getBoundingClientRect();
    return { x: Math.round( r.left + 10 ), y: Math.round( r.top + 8 ) }; } )()` );
for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] )
    await c.send( "Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "right", buttons: type === "mousePressed" ? 2 : 0, clickCount: 1 } );
ok( await c.until( "document.querySelector( '.ctx.at' )" ), "a right-click opens the menu in pointer mode" );
const box = await c.evaluate( "( () => { const r = document.querySelector( '.ctx-box' ).getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; } )()" );
ok( Math.abs( box.x - at.x ) < 2 && Math.abs( box.y - at.y ) < 2 || box.r <= 1280 - 7 && box.b <= 800 - 7 && ( box.x < at.x || box.y < at.y ),
    "its corner is at the pointer (or pulled inside the window)" );
await c.evaluate( "document.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Escape' } ) ); true" );
ok( await c.until( "! document.querySelector( '.ctx' )" ), "Escape closes it" );

section( "LEAVING THE BOX" );
await click( c, "#wall" );
ok( ! await barOn(), "the bar hides when the box loses focus" );

await done( c, s );
