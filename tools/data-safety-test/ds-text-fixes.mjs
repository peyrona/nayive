// ds-text-fixes.mjs - Text keeps a file's own bytes (docs/audit/text-2026-11-14.md).
//
//   E1  mixed line endings: every untouched line keeps its own ending; lone CR stays CR
//   B1  a UTF-8 BOM is still there after a save
//   R1  Restore over a file that is not UTF-8 swaps the two FILES as bytes:
//       the file's Windows-1252 bytes end up in the .bak, untouched
//   R4  Restore of a .bak that is not text writes nothing (the .bak stays)
//   S2  "Save as" -> Replace onto a not-UTF-8 file this tab read earlier writes it
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, disk } from "./lib.mjs";

const s = await server();
const F = path.join( s.home(), "files" );
const W1252 = Buffer.from( [ 0x63, 0x61, 0xF1, 0x61, 0x0D, 0x0A ] );          // "caña\r\n", Windows-1252
fs.mkdirSync( path.join( F, ".bak" ), { recursive: true } );
fs.writeFileSync( path.join( F, "mixed.txt" ), "one\r\ntwo\nthree\r\nfour" );
fs.writeFileSync( path.join( F, "mac.txt" ), "a\rb\rc" );
fs.writeFileSync( path.join( F, "bom.txt" ), Buffer.concat( [ Buffer.from( [ 0xEF, 0xBB, 0xBF ] ), Buffer.from( "héllo\n" ) ] ) );
fs.writeFileSync( path.join( F, "win.txt" ), W1252 );
fs.writeFileSync( path.join( F, ".bak/win.txt" ), "old utf8 copy\n" );
fs.writeFileSync( path.join( F, "plain.txt" ), "plain now\n" );
fs.writeFileSync( path.join( F, ".bak/plain.txt" ), Buffer.from( [ 0x61, 0x00, 0x62, 0x00 ] ) );
fs.writeFileSync( path.join( F, "other.txt" ), W1252 );

const c  = await browser( s );
const CM = "document.querySelector('.CodeMirror').CodeMirror";
const read = n => fs.readFileSync( path.join( F, n ) );
// Opened = the label names the file (the session has finished), not just text on screen.
const openText = async f => { await c.open( "/nayive/text/?file=files/" + f, "/nayive/text/" ); return c.until( "document.querySelector('.CodeMirror') && " + CM + ".getValue().length && document.getElementById( 'fileLabel' ).textContent.indexOf( " + JSON.stringify( f ) + " ) !== -1" ); };
// Ctrl+S: the autosave waits 15 s of quiet otherwise.
const saveNow = () => c.evaluate( "document.body.dispatchEvent( new KeyboardEvent( 'keydown', { code: 'KeyS', key: 's', ctrlKey: true, bubbles: true, cancelable: true } ) ); true" );
const confirm = () => c.evaluate( `( async () => { for( let i = 0; i < 120; i++ ) { const b = document.querySelector( 'dialog.panel[open]:not(#saveAsBackdrop) footer button:last-child' ); if( b ) { b.click(); return true; } await new Promise( r => setTimeout( r, 50 ) ); } return false; } )()` );

section( "E1 LINE ENDINGS" );
ok( await openText( "mixed.txt" ), "mixed.txt opens" );
await c.evaluate( CM + ".replaceRange( 'X', { line: 0, ch: 3 } ); true" );
await saveNow();
ok( await disk( () => read( "mixed.txt" ).toString() === "oneX\r\ntwo\nthree\r\nfour" ), "each line keeps its own ending", read( "mixed.txt" ).toString() );
ok( await openText( "mac.txt" ), "mac.txt opens" );
await c.evaluate( CM + ".replaceRange( 'Y', { line: 0, ch: 1 } ); true" );
await saveNow();
ok( await disk( () => read( "mac.txt" ).toString() === "aY\rb\rc" ), "lone CR stays CR", read( "mac.txt" ).toString() );

section( "B1 BOM" );
ok( await openText( "bom.txt" ), "bom.txt opens" );
await c.evaluate( CM + ".replaceRange( 'Z', { line: 0, ch: 0 } ); true" );
await saveNow();
ok( await disk( () => read( "bom.txt" ).subarray( 0, 4 ).toString( "hex" ) === "efbbbf5a" ), "the BOM is still first", read( "bom.txt" ).toString( "hex" ) );

section( "R1 RESTORE OVER A NOT-UTF-8 FILE" );
ok( await openText( "win.txt" ), "win.txt opens" );
ok( await c.evaluate( CM + ".getOption( 'readOnly' )" ) === true, "read-only" );
await c.evaluate( "document.getElementById( 'restoreBtn' ).click(); true" );
ok( await confirm(), "Restore asks" );
ok( await disk( () => read( "win.txt" ).toString() === "old utf8 copy\n" ), "the file is the copy" );
ok( read( ".bak/win.txt" ).equals( W1252 ), "the .bak holds the file's own bytes", read( ".bak/win.txt" ).toString( "hex" ) );

section( "R4 A .BAK THAT IS NOT TEXT" );
ok( await openText( "plain.txt" ), "plain.txt opens" );
await c.evaluate( "document.getElementById( 'restoreBtn' ).click(); true" );
ok( await c.until( "( window.__toasts || [] ).length", 8000 ), "it says so" );
ok( read( ".bak/plain.txt" ).toString( "hex" ) === "61006200", "the .bak is untouched" );
ok( read( "plain.txt" ).toString() === "plain now\n", "the file is untouched" );

section( "S2 SAVE AS -> REPLACE ONTO A FILE READ AS NOT UTF-8" );
ok( await openText( "other.txt" ), "other.txt opens (read-only)" );
const saveAs = async name =>
{
    await c.evaluate( "document.getElementById( 'saveAsBtn' ).click(); true" );
    await c.until( "document.querySelector( '#saveAsBackdrop[open]' )" );
    await c.evaluate( `const i = document.getElementById( 'saveName' ); i.value = ${JSON.stringify( name )}; i.dispatchEvent( new Event( 'input' ) ); document.getElementById( 'saveAsConfirmBtn' ).click(); true` );
};
await saveAs( "other-utf8.txt" );
ok( await disk( () => fs.existsSync( path.join( F, "other-utf8.txt" ) ) ), "the UTF-8 copy is written" );
await c.until( "! " + CM + ".getOption( 'readOnly' )" );
await c.evaluate( CM + ".replaceRange( 'Q', { line: 0, ch: 0 } ); true" );
await saveNow();
await disk( () => read( "other-utf8.txt" ).toString().startsWith( "Q" ) );
await saveAs( "other.txt" );
ok( await confirm(), "Replace is asked" );
ok( await disk( () => read( "other.txt" ).toString().startsWith( "Qcaña" ) ), "the old file is replaced", read( "other.txt" ).toString() );

await done( c, s );
