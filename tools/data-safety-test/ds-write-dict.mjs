// ds-write-dict.mjs - A5 (office #8): "Add to dictionary" in one Write window
// keeps the words another window added meanwhile (data/write/dict.json is
// read again right before each change, and merged as a set).
import { server, browser, ok, section, done } from "./lib.mjs";

const s = await server();
const c = await browser( s, { width: 1280, height: 900 } );
const phone = await s.client();
const WORD = "Xqzwvbkt";

section( "A5 · ADD TO DICTIONARY IN TWO WINDOWS" );

await c.open( "/nayive/write/?new=1", "/nayive/write/" );
ok( await c.until( "document.getElementById('editor').classList.contains('is-ready') && document.querySelector('.docx-page')", 30000 ), "Write is up with a blank document" );

// Another Write window adds "Nayive" after this one read the list at start-up.
const other = await phone.put( "data/write/dict.json", JSON.stringify( { words: [ "Nayive" ] } ) );
ok( other.status === 200, "another window added a word", other.status );

// A word the spell check flags, typed into the page.
const page = await c.evaluate( "( function () { var r = document.querySelector('.docx-page').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 120 }; } )()" );
for( const type of [ "mouseMoved", "mousePressed", "mouseReleased" ] )
    await c.send( "Input.dispatchMouseEvent", { type, x: page.x, y: page.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } );
await c.send( "Input.insertText", { text: WORD + " " } );
ok( await c.until( "document.querySelector('.spell-squiggle')", 30000 ), "the spell check flags it" );

// Right-click on it, then "Add to dictionary".
const at = await c.evaluate( "( function () { var r = document.querySelector('.spell-squiggle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top - 4 }; } )()" );
await c.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y } );
await c.send( "Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "right", buttons: 2, clickCount: 1 } );
await c.send( "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "right", buttons: 0, clickCount: 1 } );
const addText = await c.evaluate( `NayiveUI.tf( 'write.addToDict', { word: ${JSON.stringify( WORD )} } )` );
const ITEM = `Array.prototype.find.call( document.querySelectorAll( 'button.menu-item' ), function ( e ) { return e.offsetParent && e.textContent.indexOf( ${JSON.stringify( addText )} ) !== -1; } )`;
ok( await c.until( ITEM, 10000 ), "its menu offers \"" + addText + "\"" );
await c.evaluate( `${ITEM}.click(), true` );

let dict = null;
for( let i = 0; i < 50; i++ )
{
    try { dict = JSON.parse( ( await phone.get( "data/write/dict.json" ) ).text ).words; } catch { dict = null; }
    if( dict && dict.indexOf( WORD ) !== -1 ) break;
    await new Promise( r => setTimeout( r, 200 ) );
}
ok( dict && dict.indexOf( WORD ) !== -1, "the word is in the dictionary", dict );
ok( dict && dict.indexOf( "Nayive" ) !== -1, "and the other window's word is still there", dict );

await done( c, s );
