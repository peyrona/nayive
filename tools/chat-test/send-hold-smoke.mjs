// send-hold-smoke.mjs - the Send button on a phone (compose.js wireSendHold):
// node tools/chat-test/send-hold-smoke.mjs
// A tap sends; a hold (Ayni.holdMs) buzzes once and opens the send menu when
// the finger lifts, sending nothing; with the box empty the button is disabled
// and a hold does nothing at all (no ring, no buzz, no menu).
import { server, browser, ok, section, done } from "../data-safety-test/lib.mjs";

const s = await server();
const phone = await s.client();
const CA = "d-" + JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name: "Carmen" } ),
                                                { "Content-Type": "application/json" } ) ).text ).id;
const c = await browser( s, { width: 400, height: 800 } );     // no mouse: a touch device
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
await c.open( "/nayive/chat/index.html" );
ok( await c.until( `document.querySelector( '[data-conv="${CA}"]' )` ), "Chat opens" );
await c.evaluate( `NayiveChat.openConv( "${CA}" ).then( () => true )` );
ok( await c.until( `NayiveChat.S.open === "${CA}" && document.querySelector( '.composer .send' )` ), "Carmen's chat opens" );

const wait = ( ms ) => new Promise( r => setTimeout( r, ms ) );
await c.evaluate( `( () => {
    window.vib = 0; navigator.vibrate = () => { vib++; return true; };
    return true; } )()` );
const at = await c.evaluate( `( () => { const r = document.querySelector( '.composer .send' ).getBoundingClientRect(); return [ r.x + r.width / 2, r.y + r.height / 2 ]; } )()` );
const MENU = "document.querySelector( '#ayni-menu:popover-open' )";
const state = () => c.evaluate( `( () => { const b = document.querySelector( '.composer .send' );
    return { ring: b.classList.contains( 'holding' ), menu: !! ${MENU}, vib,
             typing: document.activeElement === document.querySelector( '#composer textarea' ),
             sent: [ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === 'text' ).map( m => m.text + ( m.silent ? ' (silent)' : '' ) ) }; } )()` );
const typeIn = ( t ) => c.evaluate( `( () => { const ta = document.querySelector( '#composer textarea' ); ta.focus(); ta.value = ${JSON.stringify( t )};
    ta.dispatchEvent( new Event( 'input', { bubbles: true } ) ); return true; } )()` );
const reset = () => c.evaluate( `${MENU}?.hidePopover(); vib = 0; true` );
async function tap( x, y )
{
    await c.send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ { x, y } ] } );
    await wait( 60 );
    await c.send( "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] } );
}

section( "THE BOX EMPTY: THE BUTTON IS DISABLED" );
await typeIn( "" );
await c.send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ { x: at[ 0 ], y: at[ 1 ] } ] } );
await wait( 150 );
let st = await state();
ok( ! st.ring, "a hold paints no ring", st );
await wait( 500 );
await c.send( "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] } );
await wait( 300 );
st = await state();
ok( st.vib === 0 && ! st.menu, "…and neither buzzes nor opens the menu", st );
await reset();

section( "A HOLD WITH TEXT: THE MENU" );
await typeIn( "hola menú" );
// A real long-press gesture, as a finger makes it (the browser's own contextmenu too).
const hold = c.send( "Input.synthesizeTapGesture", { x: at[ 0 ], y: at[ 1 ], duration: 700, tapCount: 1, gestureSourceType: "touch" } );
await wait( 200 );
st = await state();
ok( st.ring, "the ring paints while the finger is down", st );
// A phone also sends its own contextmenu during a long press (the gesture here does not).
await wait( 300 );
await c.evaluate( `document.querySelector( '.composer .send' ).dispatchEvent( new PointerEvent( 'contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch' } ) ); true` );
await hold;
ok( await c.until( MENU, 3000 ), "the send menu opens when the finger lifts" );
await wait( 600 );
st = await state();
ok( st.menu, "…and stays open", st );
ok( st.vib === 1, "one buzz, not one per listener", st );
ok( st.sent.length === 0, "nothing was sent", st );
ok( st.typing, "the box keeps the focus (the keyboard stays up)", st );
ok( await c.evaluate( `document.querySelectorAll( '#ayni-menu:popover-open [role^="menuitem"]' ).length >= 2` ), "it offers Without sound and Schedule" );
const item = await c.evaluate( `( () => { const r = document.querySelector( '#ayni-menu:popover-open [role^="menuitem"]' ).getBoundingClientRect(); return [ r.x + r.width / 2, r.y + r.height / 2 ]; } )()` );
await tap( item[ 0 ], item[ 1 ] );
ok( await c.until( `[ ...NayiveChat.S.msgs.values() ].some( m => m.kind === 'text' && m.text === 'hola menú' && m.silent )`, 10000 ), "Without sound sends it, silent" );
st = await state();
ok( ! st.menu && st.typing, "the menu closes, the box keeps the focus", st );
await reset();

section( "A TAP SENDS" );
await typeIn( "hola toque" );
await tap( at[ 0 ], at[ 1 ] );
ok( await c.until( `[ ...NayiveChat.S.msgs.values() ].some( m => m.kind === 'text' && m.text === 'hola toque' && ! m.silent )`, 10000 ), "a tap sends it, with sound" );
st = await state();
ok( ! st.menu && st.vib === 0 && st.typing, "no menu, no buzz, the box keeps the focus", st );

await done( c, s );
