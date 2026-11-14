// review-fixes-smoke.mjs - Chat fixes from docs/audit/chat-2026-11-14.md, in a
// real (headless) browser: node tools/chat-test/review-fixes-smoke.mjs
// M1: a photo sent from the Photo sheet takes the reply quote, never the
//     words typed in the box. N2: a poll takes the reply quote too.
// M2: another chat opening under a sheet closes it (its Send would reach the
//     new chat). N6: a poll option takes 60 characters, as the server keeps.
// A scratch server (data-safety-test/lib.mjs); the real store/ is never touched.
import { server, browser, ok, section, done, click } from "../data-safety-test/lib.mjs";

const s = await server();
const phone = await s.client();
async function contact( name )
{
    return "d-" + JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name: name } ),
                                                  { "Content-Type": "application/json" } ) ).text ).id;
}
const CA = await contact( "Carmen" ), JA = await contact( "Javi" );
const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
await c.open( "/nayive/chat/index.html" );
ok( await c.until( `document.querySelector( '[data-conv="${CA}"]' )` ), "Chat opens" );
await c.evaluate( `document.querySelector( '[data-conv="${CA}"]' ).click(); true` );
ok( await c.until( `NayiveChat.S.open === "${CA}"` ), "Carmen's chat opens" );

const TA = "document.querySelector( 'textarea[enterkeyhint=send]' )";
const SHEET = "document.querySelector( 'dialog.panel[open]' )";
const LAST = ( kind ) => `[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === '${kind}' && m.id > 0 ).pop()`;
const dropPhoto = `( async () => {
    const cv = document.createElement( "canvas" ); cv.width = 64; cv.height = 48;
    cv.getContext( "2d" ).fillRect( 0, 0, 64, 48 );
    const f = new File( [ await new Promise( r => cv.toBlob( r, "image/jpeg", 0.9 ) ) ], "p.jpg", { type: "image/jpeg" } );
    const dt = new DataTransfer(); dt.items.add( f );
    document.dispatchEvent( new DragEvent( "drop", { dataTransfer: dt, bubbles: true, cancelable: true } ) );
    return true; } )()`;

// A message to answer.
await c.evaluate( `NayiveChat.sendMsg( { kind: "text", text: "hello" } ); true` );
ok( await c.until( LAST( "text" ) ), "a text to answer is there" );
const helloId = await c.evaluate( LAST( "text" ) + ".id" );

section( "M1 - A PHOTO KEEPS THE TYPED WORDS" );
await c.evaluate( `NayiveChat.replyTo( ${LAST( "text" )} ); const t = ${TA}; t.value = "words being written"; t.dispatchEvent( new Event( "input", { bubbles: true } ) ); true` );
await c.evaluate( dropPhoto );
ok( await c.until( SHEET + " && " + SHEET + ".querySelector( '.prev-one' )" ), "the Photo sheet opens" );
await click( c, "dialog.panel[open] footer button:last-child" );
ok( await c.until( LAST( "photo" ), 20000 ), "the photo arrives" );
ok( await c.evaluate( LAST( "photo" ) + ".replyTo" ) === helloId, "it answers the quoted message" );
ok( await c.evaluate( TA + ".value" ) === "words being written", "the typed words are still in the box" );
ok( await c.evaluate( "NayiveChat.S.replyTo === null" ), "the reply quote is gone" );

section( "N2 - A POLL TAKES THE REPLY QUOTE" );
await c.evaluate( `NayiveChat.replyTo( ${LAST( "text" )} ); NayiveChat.openPollSheet(); true` );
ok( await c.until( SHEET + " && document.querySelector( '#pollQ' )" ), "the poll sheet opens" );
const maxlen = await c.evaluate( `[ ...document.querySelectorAll( 'dialog.panel[open] .opt-row input' ) ].map( i => i.maxLength )` );
ok( maxlen.length === 2 && maxlen.every( n => n === 60 ), "N6: an option takes 60 characters", maxlen );
await c.evaluate( `( () => {
    const set = ( el, v ) => { el.value = v; el.dispatchEvent( new Event( "input", { bubbles: true } ) ); };
    set( document.querySelector( '#pollQ' ), "Where?" );
    const o = document.querySelectorAll( 'dialog.panel[open] .opt-row input' );
    set( o[ 0 ], "Here" ); set( o[ 1 ], "There" );
    return true; } )()` );
await click( c, "dialog.panel[open] footer button:last-child" );
ok( await c.until( LAST( "poll" ), 20000 ), "the poll arrives" );
ok( await c.evaluate( LAST( "poll" ) + ".replyTo" ) === helloId, "it answers the quoted message" );
ok( await c.evaluate( TA + ".value" ) === "words being written", "the typed words are still in the box" );

section( "M2 - ANOTHER CHAT OPENING CLOSES THE SHEET" );
await c.evaluate( dropPhoto );
ok( await c.until( SHEET + " && " + SHEET + ".querySelector( '.prev-one' )" ), "the Photo sheet opens in Carmen's chat" );
await c.evaluate( `NayiveChat.openConv( "${JA}" ); true` );
ok( await c.until( `NayiveChat.S.open === "${JA}"` ), "Javi's chat opens (a notification tapped)" );
ok( await c.until( "! " + SHEET ), "the Photo sheet is gone" );
const javi = await c.evaluate( `[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === 'photo' ).length` );
ok( javi === 0, "no photo went to Javi", javi );

await done( c, s );
