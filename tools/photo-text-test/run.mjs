// run.mjs - the photo step with Read text (AyniPhoto.review) outside Chat:
// Drive's "Photos" upload, Photos' Read text, the Translator's photo button,
// and once the REAL OCR (NayiveUI.ocr -> language/ocr.js, tesseract):
//
//   node tools/photo-text-test/run.mjs
//
// A scratch server (data-safety-test/lib.mjs: own run-root in /tmp, user
// test/test); the real store/ is never touched. Chat's side is
// tools/chat-test/photo-text-smoke.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import { server, browser, ok, section, done, click, sleep } from "../data-safety-test/lib.mjs";

const s = await server();
const home = s.home();
fs.mkdirSync( `${home}/files/Fotos`, { recursive: true } );
fs.mkdirSync( `${home}/data/photos`, { recursive: true } );
fs.writeFileSync( `${home}/data/photos/config.json`, JSON.stringify( { folder: "files/Fotos" } ) );
const c = await browser( s, { mouse: true } );
for( const app of [ "drive", "photos", "language" ] ) await c.evaluate( `localStorage.setItem( 'balata-intro-dismiss:${app}', '1' ); true` );

const SHEET = "document.querySelector( 'dialog.panel[open].photo-review-sheet' )";
const BOX   = "document.querySelector( 'dialog.panel[open] .prev-text textarea' )";
const sha   = ( p ) => crypto.createHash( "sha256" ).update( fs.readFileSync( p ) ).digest( "hex" );

// A JPEG drawn in the page, kept in window.PIC (and its bytes in window.PIC_SHA).
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

section( "DRIVE: PHOTOS, NOTHING READ" );
await c.open( "/nayive/drive/index.html" );
ok( await c.until( "document.getElementById( 'uploadPhotoInput' ) && window.NayiveUI && window.AyniPhoto" ), "Drive opens" );
await makePic( "foto.jpg" );
await pickInto( "uploadPhotoInput" );
ok( await c.until( SHEET ), "the photo step opens" );
ok( await c.evaluate( "document.querySelectorAll( 'dialog.panel[open] .prev-tools .btn' ).length" ) === 3, "Crop, Rotate, Read text" );
ok( await c.evaluate( `!! document.querySelector( 'dialog.panel[open] .choices' ).hidden` ), "no Photo / Text / Both before reading" );
await go();
ok( await waitFile( `${home}/files/foto.jpg` ), "foto.jpg is uploaded" );
ok( sha( `${home}/files/foto.jpg` ) === await c.evaluate( "window.PIC_SHA" ), "byte for byte the picked file (untouched)" );

section( "DRIVE: READ TEXT, THEN TEXT" );
await stubOcr( "Alquilo piso\n\nTres habitaciones" );
await makePic( "anuncio.jpg" );
await pickInto( "uploadPhotoInput" );
ok( await c.until( SHEET ), "the photo step opens" );
ok( await readAndPick( "text" ), "the text shows; Text picked" );
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

section( "DRIVE: CLOSE UPLOADS NOTHING" );
await makePic( "nada.jpg" );
await pickInto( "uploadPhotoInput" );
ok( await c.until( SHEET ), "the photo step opens" );
await click( c, "dialog.panel[open] header button[data-close], dialog.panel[open] footer button[data-close]" );
ok( await c.until( "! " + SHEET ), "× closes it" );
await sleep( 1500 );
ok( ! fs.existsSync( `${home}/files/nada.jpg` ), "nothing went up" );

section( "PHOTOS: READ TEXT ON A STORED PHOTO" );
fs.copyFileSync( `${home}/files/cartel.jpg`, `${home}/files/Fotos/cartel.jpg` );
await c.open( "/nayive/photos/index.html" );
ok( await c.until( "typeof PHOTOS !== 'undefined' && PHOTOS.length === 1", 20000 ), "Photos lists the photo" );
await stubOcr( "Texto del cartel" );
await c.evaluate( "showText( PHOTOS[ 0 ].id ); true" );
ok( await c.until( SHEET + " && " + BOX + " && " + BOX + ".value === 'Texto del cartel'" ), "the sheet opens and reads at once" );
ok( await c.evaluate( "! document.querySelector( 'dialog.panel[open] .choices' ) || document.querySelector( 'dialog.panel[open] .choices' ).hidden" ), "no Photo / Text / Both (text only)" );
await go();
await sleep( 500 );
ok( await c.evaluate( SHEET + " !== null" ), "Copy keeps the sheet open" );
await click( c, "dialog.panel[open] header button[data-close], dialog.panel[open] footer button[data-close]" );
ok( await c.until( "! " + SHEET ), "× closes it" );
ok( fs.readdirSync( `${home}/files/Fotos` ).join() === "cartel.jpg", "nothing was saved in the album" );

section( "TRANSLATOR: THE PHOTO BUTTON" );
await c.open( "/nayive/language/index.html" );
ok( await c.until( "window.nayiveLanguage && document.getElementById( 'ocr-file' ) && window.AyniPhoto", 20000 ), "Translator opens" );
await c.evaluate( "nayiveLanguage.recognizeImage = async ( b, o ) => { if( o.onProgress ) o.onProgress( 1 ); return { text: 'Hola mundo', truncated: false }; }; document.getElementById( 'src' ).value = ''; true" );
await makePic( "texto.jpg" );
await pickInto( "ocr-file" );
ok( await c.until( SHEET + " && " + BOX + " && " + BOX + ".value === 'Hola mundo'" ), "the sheet opens and reads at once" );
await go();
ok( await c.until( "! " + SHEET + " && document.getElementById( 'src' ).value === 'Hola mundo'" ), "the text goes into the box" );

section( "THE REAL OCR (tesseract; its language data comes from the internet)" );
await c.open( "/nayive/drive/index.html" );
await c.until( "window.NayiveUI && NayiveUI.ocr" );
const real = await c.evaluate( `( async () => {
    const cv = document.createElement( "canvas" ); cv.width = 900; cv.height = 200;
    const g = cv.getContext( "2d" ); g.fillStyle = "#fff"; g.fillRect( 0, 0, 900, 200 ); g.fillStyle = "#000"; g.font = "56px sans-serif"; g.fillText( "Alquilo piso grande", 30, 120 );
    const b = await new Promise( r => cv.toBlob( r, "image/png" ) );
    try { const r = await NayiveUI.ocr().recognize( b, { language: "es", maxLength: 50000 } ); return { text: r.text }; }
    catch( e ) { return { err: String( e && ( e.category || e.message ) || e ) }; } } )()`, 180000 );
if( real && real.err === "network" ) console.log( "  skip the OCR data could not be downloaded here" );
else ok( real && /alquilo/i.test( real.text || "" ), "NayiveUI.ocr reads a picture", real );

// Last: once a document is edited, leaving the page asks "Leave site?".
section( "WRITE: INSERT IMAGE, THEN TEXT / BOTH" );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:write', '1' ); true" );
await c.open( "/nayive/write/index.html" );
ok( await c.until( "document.getElementById( 'editor' ).classList.contains( 'is-ready' ) && document.querySelector( '.docx-page' )", 40000 ), "Write is up with a blank document" );
await stubOcr( "Alquilo piso\n\nSegunda línea" );
await makePic( "anuncio.jpg" );
await pickInto( "imgInput" );
ok( await c.until( SHEET ), "the photo step opens" );
ok( await readAndPick( "text" ), "read; Text picked" );
await go();
ok( await c.until( "! " + SHEET + " && /Alquilo piso/.test( document.querySelector( '.docx-page' ).textContent ) && /Segunda línea/.test( document.querySelector( '.docx-page' ).textContent )", 10000 ), "the text is in the document" );
ok( await c.evaluate( "document.querySelectorAll( '.docx-page img' ).length" ) === 0, "and no picture" );
await stubOcr( "Se vende coche" );
await pickInto( "imgInput" );
ok( await c.until( SHEET ), "the photo step opens again" );
ok( await readAndPick( "both" ), "read; Both picked" );
await go();
ok( await c.until( "! " + SHEET + " && document.querySelectorAll( '.docx-page img' ).length === 1 && /Se vende coche/.test( document.querySelector( '.docx-page' ).textContent )", 10000 ), "the picture and the text are in" );

await done( c, s );
