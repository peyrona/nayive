// camera-smoke.mjs - Chat's computer camera, now AyniPhoto.camera:
// node tools/chat-test/camera-smoke.mjs
// A canvas stands in for the camera. Open, close, Back, and the shutter leading
// to the usual "Photo" sheet with the picture in it.
import { server, browser, ok, section, done, sleep } from "../data-safety-test/lib.mjs";

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
await c.evaluate( `navigator.mediaDevices.getUserMedia = async () =>
    { const v = document.createElement( "canvas" ); v.width = 320; v.height = 240; const g = v.getContext( "2d" );
      setInterval( () => { g.fillStyle = "#" + ( Math.random() * 0xFFFFFF | 0 ).toString( 16 ).padStart( 6, "0" ); g.fillRect( 0, 0, 320, 240 ); }, 50 );
      return v.captureStream( 20 ); }; true` );

const live = `!! document.querySelector( ".camera-view video" )?.videoWidth`;
const gone = `! document.querySelector( ".camera-view" )`;

section( "OPEN AND LEAVE" );
await c.evaluate( "NayiveChat.openCamera(); true" );
ok( await c.until( live ), "the live view opens" );
await c.evaluate( `document.querySelector( ".camera-view .editor-actions .btn:last-child" ).click(); true` );
ok( await c.until( gone ), "× closes it" );
await sleep( 300 );
ok( await c.evaluate( `NayiveChat.S.open === "${CA}"` ), "the chat stays open" );

await c.evaluate( "NayiveChat.openCamera(); true" );
await c.until( live );
await c.evaluate( "history.back(); true" );
ok( await c.until( gone ), "Back closes it" );
await sleep( 300 );
ok( await c.evaluate( `NayiveChat.S.open === "${CA}"` ), "and only it: the chat stays open" );

section( "THE SHUTTER" );
await c.evaluate( "NayiveChat.openCamera(); true" );
await c.until( live );
await c.until( `document.querySelector( ".camera-view .cam-bar .btn" ).getAttribute( "aria-disabled" ) !== "true"` );
await c.evaluate( `document.querySelector( ".camera-view .cam-bar .btn" ).click(); true` );
ok( await c.until( gone ), "it closes" );
ok( await c.until( `[ ...document.querySelectorAll( "dialog.panel[open]" ) ].some( d => d.querySelector( "img" ) )` ), "the Photo sheet opens with the picture" );
await done( c, s );
