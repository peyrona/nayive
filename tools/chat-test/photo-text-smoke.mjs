// photo-text-smoke.mjs - Read text in Chat's "Photo" sheet (AyniPhoto.review):
// node tools/chat-test/photo-text-smoke.mjs
// The OCR is stubbed (NayiveUI.ocr): the test is about what goes, not about
// tesseract. After Read text the sheet offers Photo / Text / Both:
//   Text  only the text goes, as a message (a long one in parts of <= 4000)
//   Both  the photo, with the text as its caption
//   Photo the photo alone, as before
import { server, browser, ok, section, done, click } from "../data-safety-test/lib.mjs";

const s = await server();
const phone = await s.client();
const CA = "d-" + JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name: "Carmen" } ),
                                                  { "Content-Type": "application/json" } ) ).text ).id;
const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
await c.open( "/nayive/chat/index.html" );
ok( await c.until( `document.querySelector( '[data-conv="${CA}"]' )` ), "Chat opens" );
await c.evaluate( `document.querySelector( '[data-conv="${CA}"]' ).click(); true` );
ok( await c.until( `NayiveChat.S.open === "${CA}"` ), "Carmen's chat opens" );

// The OCR answers window.OCR_TEXT, and counts its calls.
await c.evaluate( `window.OCR_TEXT = ""; window.OCR_CALLS = 0;
    NayiveUI.ocr = () => ( { langs: [ "es", "en" ], lang: "es", setLang() {},
        recognize: async ( blob, o ) => { window.OCR_CALLS++; if( o.onProgress ) o.onProgress( 1 ); return { text: window.OCR_TEXT, truncated: false }; } } );
    true` );

const SHEET = "document.querySelector( 'dialog.panel[open]' )";
const BOX   = "document.querySelector( 'dialog.panel[open] .prev-text textarea' )";
async function dropPhoto()
{
    await c.evaluate( `( async () => {
        const cv = document.createElement( "canvas" ); cv.width = 200; cv.height = 100;
        const g = cv.getContext( "2d" ); g.fillStyle = "#fff"; g.fillRect( 0, 0, 200, 100 ); g.fillStyle = "#000"; g.fillText( "Alquilo piso", 20, 50 );
        const b = await new Promise( r => cv.toBlob( r, "image/jpeg", 0.9 ) );
        const dt = new DataTransfer(); dt.items.add( new File( [ b ], "anuncio.jpg", { type: "image/jpeg" } ) );
        document.dispatchEvent( new DragEvent( "drop", { dataTransfer: dt, bubbles: true, cancelable: true } ) );
        return true; } )()` );
    return c.until( SHEET + " && " + SHEET + ".querySelector( '.prev-one' )" );
}
async function readText( text )
{
    await c.evaluate( `window.OCR_TEXT = ${JSON.stringify( text )}; true` );
    await click( c, "dialog.panel[open] .prev-tools .btn:nth-child(3)" );
    return c.until( BOX + " && ! " + BOX + ".hidden && " + BOX + ".value.length > 0" );
}
const pressed = () => c.evaluate( `( document.querySelector( 'dialog.panel[open] .choices [aria-pressed="true"]' ) || {} ).dataset?.pick || ""` );
const choose  = ( p ) => click( c, `dialog.panel[open] .choices [data-pick="${p}"]` );
const send    = () => click( c, "dialog.panel[open] footer button:last-child" );
const msgs    = ( kind ) => c.evaluate( `[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === "${kind}" && m.id > 0 ).map( m => ( { id: m.id, text: m.text || "" } ) )` );
const settle  = ( kind, n ) => c.until( `[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === "${kind}" && m.id > 0 ).length >= ${n}`, 20000 );

section( "BEFORE READ TEXT" );
ok( await dropPhoto(), "the Photo sheet opens" );
ok( await c.evaluate( `!! document.querySelector( 'dialog.panel[open] .prev-text' )?.hidden` ), "no text panel yet" );
ok( await c.evaluate( `!! document.querySelector( 'dialog.panel[open] input.input' ) && ! document.querySelector( 'dialog.panel[open] input.input' ).closest( '[hidden]' )` ), "the caption box shows" );

section( "READ TEXT, THEN TEXT" );
ok( await readText( "Alquilo piso\n\nTres habitaciones, 900 €" ), "the text shows, to check" );
ok( await pressed() === "text", "Text is picked by default" );
ok( await c.evaluate( `!! document.querySelector( 'dialog.panel[open] input.input' ).closest( '[hidden]' )` ), "the caption box goes (the text says it all)" );
await c.evaluate( BOX + ".value = 'Alquilo piso\\n\\nTres habitaciones, 950 €'; " + BOX + ".dispatchEvent( new Event( 'input' ) ); true" );
const photos0 = ( await msgs( "photo" ) ).length;
await send();
ok( await settle( "text", 1 ), "a text message arrives" );
let texts = await msgs( "text" );
ok( texts.length === 1 && texts[ 0 ].text === "Alquilo piso\n\nTres habitaciones, 950 €", "it is the text as the user fixed it", texts );
ok( ( await msgs( "photo" ) ).length === photos0, "no photo went" );

section( "BOTH" );
ok( await dropPhoto(), "the sheet opens again" );
ok( await readText( "Se vende coche" ), "read" );
await choose( "both" );
ok( await pressed() === "both", "Both is picked" );
await send();
ok( await settle( "photo", photos0 + 1 ), "a photo arrives" );
const ph = ( await msgs( "photo" ) ).pop();
ok( ph.text === "Se vende coche", "with the text as its caption", ph );
ok( ( await msgs( "text" ) ).length === 1, "and no extra text message" );

section( "PHOTO" );
ok( await dropPhoto(), "the sheet opens again" );
ok( await readText( "Ignorar" ), "read" );
await choose( "photo" );
await send();
ok( await settle( "photo", photos0 + 2 ), "a photo arrives" );
ok( ( await msgs( "photo" ) ).pop().text === "", "without the text" );
ok( ( await msgs( "text" ) ).length === 1, "and no text message" );

section( "A LONG TEXT GOES IN PARTS" );
const para = ( ch ) => Array.from( { length: 600 }, () => ch.repeat( 4 ) ).join( " " );    // 2999 characters
ok( await dropPhoto(), "the sheet opens again" );
ok( await readText( para( "a" ) + "\n\n" + para( "b" ) + "\n\n" + para( "c" ) ), "read" );
await send();
ok( await settle( "text", 4 ), "three more text messages arrive" );
texts = ( await msgs( "text" ) ).slice( 1 );
ok( texts.length === 3 && texts.every( t => [ ...t.text ].length <= 4000 ), "each at most 4000 characters", texts.map( t => t.text.length ) );
ok( texts[ 0 ].text.startsWith( "aaaa" ) && texts[ 1 ].text.startsWith( "bbbb" ) && texts[ 2 ].text.startsWith( "cccc" ), "in order, cut at the paragraphs" );

section( "READ AGAIN, NOTHING FOUND: THE PHOTO CAN STILL GO" );
ok( await dropPhoto(), "the sheet opens again" );
ok( await readText( "Algo" ), "read" );
await c.evaluate( "window.OCR_TEXT = ''; true" );
await click( c, "dialog.panel[open] .prev-tools .btn:nth-child(3)" );
ok( await c.until( "/No text/.test( document.querySelector( 'dialog.panel[open] .prev-text .hint' ).textContent )" ), "the second read finds nothing, and says so" );
ok( await c.evaluate( "document.querySelector( 'dialog.panel[open] footer button:last-child' ).getAttribute( 'aria-disabled' ) !== 'true'" ), "Send is not dead" );
ok( await c.evaluate( "! document.querySelector( 'dialog.panel[open] input.input' ).closest( '[hidden]' )" ), "the caption box is back" );
const photosR = ( await msgs( "photo" ) ).length;
await send();
ok( await settle( "photo", photosR + 1 ), "the photo goes" );

section( "TWO PHOTOS: ONE TEXT, IN ORDER" );
await c.evaluate( `( async () => {
    const one = async ( n ) => { const cv = document.createElement( "canvas" ); cv.width = 50; cv.height = 50; const b = await new Promise( r => cv.toBlob( r, "image/jpeg" ) ); return new File( [ b ], n + ".jpg", { type: "image/jpeg" } ); };
    let k = 0; const real = NayiveUI.ocr;
    NayiveUI.ocr = () => ( { langs: [ "es" ], lang: "es", setLang() {}, recognize: async () => ( { text: "Página " + ( ++k ), truncated: false } ) } );
    const dt = new DataTransfer(); dt.items.add( await one( "p1" ) ); dt.items.add( await one( "p2" ) );
    document.dispatchEvent( new DragEvent( "drop", { dataTransfer: dt, bubbles: true, cancelable: true } ) ); return true; } )()` );
ok( await c.until( SHEET + " && " + SHEET + ".querySelector( '.prev-grid' )" ), "the sheet shows both" );
await click( c, "dialog.panel[open] .prev-tools .btn:nth-child(1)" );
ok( await c.until( BOX + " && " + BOX + ".value === 'Página 1\\n\\nPágina 2'" ), "Read text joins them, in order", await c.evaluate( BOX + "?.value" ) );
await click( c, "dialog.panel[open] header button[data-close], dialog.panel[open] footer button[data-close]" );
await c.until( "! document.querySelector( 'dialog.panel[open]' )" );

section( "CLOSE SENDS NOTHING" );
ok( await dropPhoto(), "the sheet opens again" );
ok( await readText( "Nada" ), "read" );
const before = ( await msgs( "text" ) ).length + ( await msgs( "photo" ) ).length;
await click( c, "dialog.panel[open] header button[data-close], dialog.panel[open] footer button[data-close]" );
ok( await c.until( "! document.querySelector( 'dialog.panel[open]' )" ), "× closes the sheet" );
await new Promise( r => setTimeout( r, 1500 ) );
ok( ( await msgs( "text" ) ).length + ( await msgs( "photo" ) ).length === before, "nothing was sent" );

await done( c, s );
