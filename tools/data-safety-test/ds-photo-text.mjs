// ds-photo-text.mjs - the photo step (AyniPhoto.review: Crop, Rotate, Read
// text, then Photo / Text / Both) writes only what was chosen:
//   Drive "Photos": an untouched photo goes up byte for byte; Text = only
//     <photo>.txt; Both = the photo and the .txt; × = nothing at all.
//   Chat: Text = only text messages (a long text in parts of <= 4000, in
//     order); Both = the photo with the text as its caption.
// The OCR is stubbed (NayiveUI.ocr): this is about what reaches the server.
import crypto from "node:crypto";
import fs from "node:fs";
import { server, browser, ok, section, done, click, sleep } from "./lib.mjs";

const s = await server();
const home = s.home();
const phone = await s.client();
const CA = "d-" + JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name: "Carmen" } ),
                                                  { "Content-Type": "application/json" } ) ).text ).id;
const c = await browser( s, { mouse: true } );
for( const app of [ "drive", "chat" ] ) await c.evaluate( `localStorage.setItem( 'balata-intro-dismiss:${app}', '1' ); true` );

const SHEET = "document.querySelector( 'dialog.panel[open].photo-review-sheet' )";
const BOX   = "document.querySelector( 'dialog.panel[open] .prev-text textarea' )";
const sha   = ( p ) => crypto.createHash( "sha256" ).update( fs.readFileSync( p ) ).digest( "hex" );

const makePic = ( name ) => c.evaluate( `( async () => {
    const cv = document.createElement( "canvas" ); cv.width = 320; cv.height = 120;
    const g = cv.getContext( "2d" ); g.fillStyle = "#fff"; g.fillRect( 0, 0, 320, 120 ); g.fillStyle = "#000"; g.font = "32px sans-serif"; g.fillText( "Alquilo piso", 20, 70 );
    const b = await new Promise( r => cv.toBlob( r, "image/jpeg", 0.9 ) );
    window.PIC = new File( [ b ], ${JSON.stringify( name )}, { type: "image/jpeg" } );
    const d = await crypto.subtle.digest( "SHA-256", await b.arrayBuffer() );
    window.PIC_SHA = [ ...new Uint8Array( d ) ].map( x => x.toString( 16 ).padStart( 2, "0" ) ).join( "" );
    return true; } )()` );
const pickInto = ( id ) => c.evaluate( `( () => { const i = document.getElementById( ${JSON.stringify( id )} ); const dt = new DataTransfer(); dt.items.add( window.PIC );
    i.files = dt.files; i.dispatchEvent( new Event( "change", { bubbles: true } ) ); return true; } )()` );
const dropPic = () => c.evaluate( `( () => { const dt = new DataTransfer(); dt.items.add( window.PIC );
    document.dispatchEvent( new DragEvent( "drop", { dataTransfer: dt, bubbles: true, cancelable: true } ) ); return true; } )()` );
const stubOcr = ( text ) => c.evaluate( `window.OCR_TEXT = ${JSON.stringify( text )};
    NayiveUI.ocr = () => ( { langs: [ "es", "en" ], lang: "es", setLang() {},
        recognize: async ( b, o ) => { if( o.onProgress ) o.onProgress( 1 ); return { text: window.OCR_TEXT, truncated: false }; } } ); true` );
async function readAndPick( pick )
{
    await click( c, "dialog.panel[open] .prev-tools .btn:nth-child(3)" );
    const shown = await c.until( BOX + " && ! " + BOX + ".hidden && " + BOX + ".value.length > 0" );
    if( pick ) await click( c, `dialog.panel[open] .choices [data-pick="${pick}"]` );
    return shown;
}
const go = () => click( c, "dialog.panel[open] footer button:last-child" );
const waitFile = async ( p, ms = 15000 ) => { const end = Date.now() + ms; while( Date.now() < end ) { if( fs.existsSync( p ) ) { await sleep( 300 ); return true; } await sleep( 200 ); } return false; };

section( "DRIVE: PHOTOS, NOTHING READ - THE SAME BYTES" );
await c.open( "/nayive/drive/index.html" );
ok( await c.until( "document.getElementById( 'uploadPhotoInput' ) && window.NayiveUI && window.AyniPhoto" ), "Drive opens" );
await makePic( "foto.jpg" );
await pickInto( "uploadPhotoInput" );
ok( await c.until( SHEET ), "the photo step opens" );
await go();
ok( await waitFile( `${home}/files/foto.jpg` ), "foto.jpg is uploaded" );
ok( sha( `${home}/files/foto.jpg` ) === await c.evaluate( "window.PIC_SHA" ), "byte for byte the picked file" );

section( "DRIVE: TEXT = ONLY THE .txt" );
await stubOcr( "Alquilo piso\n\nTres habitaciones" );
await makePic( "anuncio.jpg" );
await pickInto( "uploadPhotoInput" );
ok( await c.until( SHEET ), "the photo step opens" );
ok( await readAndPick( "text" ), "read; Text picked" );
await go();
ok( await waitFile( `${home}/files/anuncio.txt` ), "anuncio.txt is uploaded" );
ok( fs.readFileSync( `${home}/files/anuncio.txt`, "utf8" ) === "Alquilo piso\n\nTres habitaciones\n", "with the text" );
await sleep( 1000 );
ok( ! fs.existsSync( `${home}/files/anuncio.jpg` ), "and NOT the photo" );

section( "DRIVE: BOTH" );
await stubOcr( "Se vende coche" );
await makePic( "cartel.jpg" );
await pickInto( "uploadPhotoInput" );
ok( await c.until( SHEET ), "the photo step opens" );
ok( await readAndPick( "both" ), "read; Both picked" );
await go();
ok( await waitFile( `${home}/files/cartel.jpg` ) && await waitFile( `${home}/files/cartel.txt` ), "cartel.jpg and cartel.txt are uploaded" );
ok( fs.readFileSync( `${home}/files/cartel.txt`, "utf8" ) === "Se vende coche\n", "the .txt holds the text" );

section( "DRIVE: × UPLOADS NOTHING" );
const before = fs.readdirSync( `${home}/files` ).sort().join();
await makePic( "nada.jpg" );
await pickInto( "uploadPhotoInput" );
ok( await c.until( SHEET ), "the photo step opens" );
await readAndPick( "both" );
await click( c, "dialog.panel[open] header button[data-close], dialog.panel[open] footer button[data-close]" );
ok( await c.until( "! " + SHEET ), "× closes it" );
await sleep( 1500 );
ok( fs.readdirSync( `${home}/files` ).sort().join() === before, "nothing went up" );

section( "CHAT: TEXT = ONLY TEXT MESSAGES" );
await c.open( "/nayive/chat/index.html" );
ok( await c.until( `document.querySelector( '[data-conv="${CA}"]' )` ), "Chat opens" );
await c.evaluate( `document.querySelector( '[data-conv="${CA}"]' ).click(); true` );
ok( await c.until( `NayiveChat.S.open === "${CA}"` ), "Carmen's chat opens" );
const msgs   = ( kind ) => c.evaluate( `[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === "${kind}" && m.id > 0 ).map( m => ( { id: m.id, text: m.text || "" } ) )` );
const settle = ( kind, n ) => c.until( `[ ...NayiveChat.S.msgs.values() ].filter( m => m.kind === "${kind}" && m.id > 0 ).length >= ${n}`, 20000 );
const para = ( ch ) => Array.from( { length: 600 }, () => ch.repeat( 4 ) ).join( " " );    // 2999 characters
await stubOcr( para( "a" ) + "\n\n" + para( "b" ) );
await makePic( "carta.jpg" );
await dropPic();
ok( await c.until( SHEET ), "the photo step opens" );
ok( await readAndPick( "text" ), "read; Text picked" );
await go();
ok( await settle( "text", 2 ), "two text messages arrive" );
let texts = await msgs( "text" );
ok( texts.length === 2 && texts[ 0 ].text === para( "a" ) && texts[ 1 ].text === para( "b" ), "the text, in order, cut at the paragraph" );
ok( ( await msgs( "photo" ) ).length === 0, "no photo went" );

section( "CHAT: BOTH = THE PHOTO WITH ITS CAPTION" );
await stubOcr( "Se vende coche" );
await makePic( "cartel.jpg" );
await dropPic();
ok( await c.until( SHEET ), "the photo step opens" );
ok( await readAndPick( "both" ), "read; Both picked" );
await go();
ok( await settle( "photo", 1 ), "a photo arrives" );
ok( ( await msgs( "photo" ) )[ 0 ].text === "Se vende coche", "with the text as its caption" );
ok( ( await msgs( "text" ) ).length === 2, "and no extra text message" );

await done( c, s );
