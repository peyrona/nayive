// photo-edit-smoke.mjs - Chat's Crop and Rotate in the "Photo" sheet, before
// sending: node tools/chat-test/photo-edit-smoke.mjs [screenshot.png]
// A 400x300 JPEG (left half red, right blue, with an Exif date) is dropped on
// the chat; Rotate turns it right, Crop cuts it, and the photo that arrives
// is the edited one and still carries its date.
import fs from "node:fs";
import { server, browser, ok, section, done, click, sleep } from "../data-safety-test/lib.mjs";

const shot = process.argv[ 2 ];
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

section( "THE PHOTO SHEET" );
// The test JPEG, made in the page, with an Exif segment spliced in after FFD8:
// IFD0 = Orientation 1 + DateTime "2024:05:06 07:08:09".
await c.evaluate( `( async () => {
    const cv = document.createElement( "canvas" ); cv.width = 400; cv.height = 300;
    const g = cv.getContext( "2d" ); g.fillStyle = "#f00"; g.fillRect( 0, 0, 200, 300 ); g.fillStyle = "#00f"; g.fillRect( 200, 0, 200, 300 );
    const jpg = new Uint8Array( await ( await new Promise( r => cv.toBlob( r, "image/jpeg", 0.95 ) ) ).arrayBuffer() );
    const date = "2024:05:06 07:08:09\\0";
    const t = new Uint8Array( 38 + 20 ); const d = new DataView( t.buffer );
    t.set( [ 0x49, 0x49, 0x2A, 0, 8, 0, 0, 0 ] ); d.setUint16( 8, 2, true );
    d.setUint16( 10, 0x0112, true ); d.setUint16( 12, 3, true ); d.setUint32( 14, 1, true ); d.setUint16( 18, 1, true );
    d.setUint16( 22, 0x0132, true ); d.setUint16( 24, 2, true ); d.setUint32( 26, 20, true ); d.setUint32( 30, 38, true );
    d.setUint32( 34, 0, true );
    for( let i = 0; i < 20; i++ ) t[ 38 + i ] = date.charCodeAt( i );
    const app1 = new Uint8Array( 4 + 6 + t.length );
    app1.set( [ 0xFF, 0xE1, ( app1.length - 2 ) >> 8, ( app1.length - 2 ) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0 ] ); app1.set( t, 10 );
    const out = new Uint8Array( jpg.length + app1.length ); out.set( jpg.subarray( 0, 2 ) ); out.set( app1, 2 ); out.set( jpg.subarray( 2 ), 2 + app1.length );
    const f = new File( [ out ], "test.jpg", { type: "image/jpeg" } );
    const dt = new DataTransfer(); dt.items.add( f );
    document.dispatchEvent( new DragEvent( "drop", { dataTransfer: dt, bubbles: true, cancelable: true } ) );
    return true; } )()` );
const IMG = "document.querySelector( '.sheet-backdrop.open .prev-one' )";
ok( await c.until( IMG + " && " + IMG + ".naturalWidth === 400" ), "the dropped photo shows, 400 wide" );
const tools = await c.evaluate( `[ ...document.querySelectorAll( '.sheet-backdrop.open .prev-tools .btn' ) ].map( b => b.title )` );
ok( tools.length === 2, "two buttons under it", tools );
const mid = await c.evaluate( `( () => { const p = document.querySelector( '.prev-tools' ).getBoundingClientRect(), s = document.querySelector( '.sheet-backdrop.open .sheet' ).getBoundingClientRect();
    return Math.abs( ( p.left + p.right ) / 2 - ( s.left + s.right ) / 2 ) < 2 && document.querySelector( '.prev-tools' ).children[ 0 ].getBoundingClientRect().left > s.left + 40; } )()` );
ok( mid, "they are centred" );

// The colour at (x, y) of the sheet's picture, "r" / "b" / "?".
const colourAt = ( x, y ) => c.evaluate( `( () => { const i = ${IMG}; const cv = document.createElement( "canvas" ); cv.width = i.naturalWidth; cv.height = i.naturalHeight;
    const g = cv.getContext( "2d" ); g.drawImage( i, 0, 0 ); const p = g.getImageData( ${x}, ${y}, 1, 1 ).data;
    return p[ 0 ] > 180 && p[ 2 ] < 80 ? "r" : p[ 2 ] > 180 && p[ 0 ] < 80 ? "b" : "?"; } )()` );

section( "ROTATE" );
await click( c, ".sheet-backdrop.open .prev-tools .btn:nth-child(2)" );
ok( await c.until( IMG + ".naturalWidth === 300 && " + IMG + ".naturalHeight === 400" ), "turned: 300 x 400" );
ok( await colourAt( 150, 20 ) === "r" && await colourAt( 150, 380 ) === "b", "turned RIGHT: red on top, blue below" );

section( "CROP" );
await click( c, ".sheet-backdrop.open .prev-tools .btn:nth-child(1)" );
ok( await c.until( "document.querySelector( '.cropper .crop-box:not([hidden])' )" ), "the crop screen opens with its box" );
const se = await c.evaluate( `( () => { const r = document.querySelector( '.crop-box .se' ).getBoundingClientRect(), i = document.querySelector( '.cropper img' ).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, ih: i.height }; } )()` );
ok( await c.evaluate( "( () => { const b = document.querySelector( '.crop-box' ).getBoundingClientRect(), i = document.querySelector( '.cropper img' ).getBoundingClientRect(); return Math.abs( b.width - i.width ) < 2 && Math.abs( b.height - i.height ) < 2; } )()" ),
    "the box starts on the whole photo" );
// Drag the bottom-right corner up to half the height.
await c.send( "Page.bringToFront" );
await c.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: se.x, y: se.y, button: "none", buttons: 0 } );
await c.send( "Input.dispatchMouseEvent", { type: "mousePressed", x: se.x, y: se.y, button: "left", buttons: 1, clickCount: 1 } );
for( let k = 1; k <= 5; k++ )
    await c.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: se.x, y: se.y - se.ih / 2 * k / 5, button: "left", buttons: 1 } );
await c.send( "Input.dispatchMouseEvent", { type: "mouseReleased", x: se.x, y: se.y - se.ih / 2, button: "left", buttons: 0, clickCount: 1 } );
const half = await c.evaluate( "( () => { const b = document.querySelector( '.crop-box' ).getBoundingClientRect(), i = document.querySelector( '.cropper img' ).getBoundingClientRect(); return b.height / i.height; } )()" );
ok( Math.abs( half - 0.5 ) < 0.03, "dragging the corner halves the box", half );
if( shot )
{
    const p = await c.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( shot.replace( /\.png$/, "-crop.png" ), Buffer.from( p.data ?? p.result?.data, "base64" ) );
}
await click( c, ".cropper .editor-actions .btn.on-media:first-child" );
ok( await c.until( "! document.querySelector( '.cropper' )" ), "✓ closes the crop screen" );
ok( await c.until( IMG + ".naturalWidth === 300 && Math.abs( " + IMG + ".naturalHeight - 200 ) <= 1" ), "the sheet shows the cut: 300 x 200" );
ok( await colourAt( 150, 100 ) === "r", "the kept half is the red top" );
if( shot )
{
    const p = await c.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( shot, Buffer.from( p.data ?? p.result?.data, "base64" ) );
}

section( "CROP, LEFT WITH ×" );
await click( c, ".sheet-backdrop.open .prev-tools .btn:nth-child(1)" );
ok( await c.until( "document.querySelector( '.cropper .crop-box:not([hidden])' )" ), "opens again" );
await click( c, ".cropper .editor-actions .btn.on-media:last-child" );
ok( await c.until( "! document.querySelector( '.cropper' )" ), "× closes it" );
ok( await c.until( "document.querySelector( '.sheet-backdrop.open' )" ), "the sheet is still open" );
ok( await c.evaluate( IMG + ".naturalHeight" ) <= 201, "the photo is as it was" );

section( "SEND" );
await click( c, ".sheet-backdrop.open .sheet-actions button:last-child" );
const LAST = "[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === 'photo' && m.id > 0 ).pop()";
ok( await c.until( LAST, 20000 ), "the photo message arrives" );
const got = await c.evaluate( `( async () => { const m = ${LAST};
    const b = new Uint8Array( await ( await fetch( NayiveChat.mediaUrl( NayiveChat.S.open, m.id, true ), { credentials: "same-origin" } ) ).arrayBuffer() );
    const txt = Array.from( b.subarray( 0, 400 ), x => String.fromCharCode( x ) ).join( "" );
    const img = await createImageBitmap( new Blob( [ b ] ) );
    return { w: img.width, h: img.height, exif: txt.includes( "Exif" ), date: txt.includes( "2024:05:06 07:08:09" ), name: m.file && m.file.name }; } )()` );
ok( got.w === 300 && Math.abs( got.h - 200 ) <= 1, "the server has the edited photo, 300 x 200", got );
ok( got.exif && got.date, "with the original's Exif date", got );

await done( c, s );
