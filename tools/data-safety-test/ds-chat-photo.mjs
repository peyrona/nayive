// ds-chat-photo.mjs - Chat: "Editar" ✓ on a photo sent from the owner's
// library never writes over the library original - the edit is a new file
// beside it and the message shows that one (data-safety J1); auto-delete
// says how many messages it would delete before it is set, and its Undo
// keeps them (J7).
import fs from "node:fs";
import { server, browser, ok, section, done } from "./lib.mjs";

const s = await server();

// A chat with three messages ~400 days old, on disk before the server reads
// it (the only way to have old messages: the server stamps "now").
const OLD = "a1b2c3d4e5", AT = Date.now() - 400 * 24 * 3600 * 1000;
const month = new Date( AT ).toISOString().slice( 0, 7 );
fs.mkdirSync( `${s.home()}/data/chat/conv/d-${OLD}`, { recursive: true } );
fs.writeFileSync( `${s.home()}/data/chat/chat.json`, JSON.stringify( { me: { name: "Test" },
    contacts: [ { id: OLD, name: "Vieja", token: "f".repeat( 40 ), created: Math.floor( AT / 1000 ) } ], groups: [] } ) );
fs.writeFileSync( `${s.home()}/data/chat/conv/d-${OLD}/${month}.json`, JSON.stringify( { messages: [ 1, 2, 3 ].map( i =>
    ( { id: i, rev: i, at: AT + i, from: "o", kind: "text", text: "viejo " + i } ) ) } ) );

const phone = await s.client();       // the owner on another device: the server's view
const json = async r => JSON.parse( ( await r ).text );
const carmen = await json( phone.post( "/api/chat/contacts", JSON.stringify( { name: "Carmen" } ), { "Content-Type": "application/json" } ) );
const CA = "d-" + carmen.id;

const c = await browser( s, { lang: "es", width: 1280, height: 900 } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
const PAGE = "/nayive/chat/index.html";
const load = async () => { await c.open( PAGE ); return c.until( `document.querySelector( '[data-conv="${CA}"]' )` ); };
const openChat = async id => { await c.evaluate( `document.querySelector( '[data-conv="${id}"]' ).click(); true` );
                               return c.until( `NayiveChat.S.open === ${JSON.stringify( id )} && ! document.getElementById( 'vConv' ).hidden` ); };
const disk = rel => { try { return fs.readFileSync( `${s.home()}/${rel}` ); } catch { return null; } };
async function untilDisk( rel, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { const b = disk( rel ); if( b ) return b; await new Promise( r => setTimeout( r, 150 ) ); }
    return null;
}

ok( await load(), "Chat opens" );

section( "J1 - EDITAR ✓ NEVER WRITES OVER THE LIBRARY ORIGINAL" );
// A real JPEG in the owner's library (the editor must be able to open it).
const put = await c.evaluate( `( async () => {
    const cv = document.createElement( 'canvas' ); cv.width = 64; cv.height = 48;
    const g = cv.getContext( '2d' ); g.fillStyle = '#c00'; g.fillRect( 0, 0, 64, 48 ); g.fillStyle = '#00c'; g.fillRect( 0, 0, 20, 48 );
    const b = await new Promise( r => cv.toBlob( r, 'image/jpeg', 0.9 ) );
    const r = await fetch( '/api/files?file=' + encodeURIComponent( 'files/Fotos/IMG_7.jpg' ), { method: 'PUT', body: b } );
    return r.status; } )()` );
ok( put === 200, "a photo in the library: files/Fotos/IMG_7.jpg", put );
const ORIG = disk( "files/Fotos/IMG_7.jpg" );
const sent = await json( phone.post( "/api/chat/conv/" + CA + "/messages", JSON.stringify( { ref: "files/Fotos/IMG_7.jpg", w: 64, h: 48 } ),
                                     { "Content-Type": "application/json" } ) );
ok( sent.id > 0 && sent.kept, "sent to Carmen from the library (linked)", sent );

// The editor on screen has the photo in (its canvas holds the photo's own
// 64x48): before that its ✓ / "save a copy" would export an empty canvas,
// and a flip made then is wiped by the editor's own end of loading.
const LOADED = "( cv => !! cv && cv.width === 64 && cv.height === 48 )( document.querySelector( '.photo-editor canvas.lower-canvas' ) )";
// Something to undo: the editor's undo button lights up on the very event
// that makes Chat's editor "dirty" - ✓ with nothing changed only closes.
const CHANGED = "!! document.querySelector( '.photo-editor .tie-btn-undo.enabled' )";
ok( await load() && await openChat( CA ) && await c.until( `NayiveChat.S.msgs.get( ${sent.id} )` ), "Carmen's chat shows it" );
await c.evaluate( `NayiveChat.editPhoto( NayiveChat.S.msgs.get( ${sent.id} ) ); true` );
ok( await c.until( "document.querySelector( '.photo-editor .tie-btn-flip' )", 30000 ) && await c.until( LOADED, 30000 ), "Editar opens the editor on it" );
await c.evaluate( "document.querySelector( '.photo-editor .tie-btn-flip' ).click(), true" );
await c.until( "document.querySelector( '.photo-editor .tie-flip-button .tui-image-editor-button.flipX' )" );
// The flip, until the editor has it (a loaded machine: a click may come
// before the editor is ready for it) - then ✓, only while it is there.
let saved = false;
for( const end = Date.now() + 60000; ! saved && Date.now() < end; )
{
    if( ! await c.evaluate( CHANGED ) )
        await c.evaluate( "document.querySelector( '.photo-editor .tie-flip-button .tui-image-editor-button.flipX' ).click(), true" );
    await c.until( CHANGED, 5000 );
    saved = await c.evaluate( `${CHANGED} && ( document.querySelector( '.photo-editor .editor-actions .editor-btn' ).click(), true )` );   // ✓
}
const EDIT = await untilDisk( "files/Fotos/IMG_7-editado.jpg", 60000 );
ok( !! EDIT, "✓ saved the edit as a new file beside it: IMG_7-editado.jpg" );
ok( await c.until( "! document.querySelector( '.photo-editor' )", 30000 ), "…and the editor closed" );
ok( disk( "files/Fotos/IMG_7.jpg" )?.equals( ORIG ), "the library original keeps its bytes" );
let shown = null;
for( const end = Date.now() + 30000; Date.now() < end; )
{
    const r = await fetch( s.base + "/api/chat/conv/" + CA + "/media/" + sent.id, { headers: { Cookie: phone.cookie } } );
    shown = Buffer.from( await r.arrayBuffer() );
    if( EDIT && shown.equals( EDIT ) ) break;
    await new Promise( r => setTimeout( r, 100 ) );
}
ok( EDIT && shown.equals( EDIT ), "the message now shows the edit, to everybody" );

section( "J1 - SAVE A COPY: NEVER OVER A NAME THAT IS TAKEN" );
const taken = await phone.put( "files/Fotos/IMG_7-editado-editado.jpg", "otra foto" );
ok( taken.status === 200, "a file already has the copy's name", taken.status );
await c.evaluate( `NayiveChat.editPhoto( NayiveChat.S.msgs.get( ${sent.id} ) ); true` );
ok( await c.until( "document.querySelector( '.photo-editor .tie-btn-flip' )", 30000 ) && await c.until( LOADED, 30000 ), "Editar again (now on the edit)" );
await c.evaluate( "document.querySelectorAll( '.photo-editor .editor-actions .editor-btn' )[ 1 ].click(), true" );   // save a copy
ok( !! await untilDisk( "files/Fotos/IMG_7-editado-editado (2).jpg", 60000 ), "the copy took the next free name" );
ok( String( disk( "files/Fotos/IMG_7-editado-editado.jpg" ) ) === "otra foto", "the file that had the name is untouched" );
ok( disk( "files/Fotos/IMG_7.jpg" )?.equals( ORIG ), "the library original still keeps its bytes" );

section( "J7 - AUTO-DELETE SAYS WHAT IT WOULD DELETE" );
ok( await load(), "Chat again" );
await c.evaluate( "NayiveChat.openSettings( 'autodel' ); true" );
ok( await c.until( "document.getElementById( 'autoDelDays' )" ), "the auto-delete dialog" );
await c.evaluate( `( () => { const i = document.getElementById( 'autoDelDays' ); i.value = '1'; i.dispatchEvent( new InputEvent( 'input' ) ); return true; } )()` );
ok( await c.until( "/3 mensajes/.test( document.querySelector( '.days-count' )?.textContent || '' )" ),
    "1 day (a typo for 10?): it says it deletes 3 messages now", await c.evaluate( "document.querySelector( '.days-count' )?.textContent" ) );
await c.evaluate( `( () => { const i = document.getElementById( 'autoDelDays' ); i.value = '1000'; i.dispatchEvent( new InputEvent( 'input' ) ); return true; } )()` );
ok( await c.until( "/ningún mensaje/.test( document.querySelector( '.days-count' )?.textContent || '' )" ),
    "1000 days: none", await c.evaluate( "document.querySelector( '.days-count' )?.textContent" ) );
await c.evaluate( `( () => { const i = document.getElementById( 'autoDelDays' ); i.value = '1'; i.dispatchEvent( new InputEvent( 'input' ) ); return true; } )()` );
await c.until( "/3 mensajes/.test( document.querySelector( '.days-count' )?.textContent || '' )" );
const SAVE = "document.getElementById( 'autoDelDays' )?.closest( '.sheet' )?.querySelector( '.sheet-actions .btn-primary' )";
ok( await c.until( SAVE ), "its Save button" );
await c.evaluate( SAVE + ".click(), true" );
ok( await c.until( "/3 ahora/.test( document.getElementById( 'toast' ).textContent )" ),
    "Save: the toast says it too", await c.evaluate( "document.getElementById( 'toast' ).textContent" ) );
await c.evaluate( "document.querySelector( '#toast .toast-undo' ).click(), true" );
const after = await json( phone.call( "GET", "/api/chat/autodelete?days=1" ) );
const sum = await json( phone.call( "GET", "/api/chat" ) );
ok( after.n === 3 && ! sum.deleteAfter, "Undo: nothing was set, the 3 messages are there", { after, deleteAfter: sum.deleteAfter } );

await done( c, s );
