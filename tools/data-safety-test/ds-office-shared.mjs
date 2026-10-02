// ds-office-shared.mjs - edits to a document someone else shared with you
// (read-only: they live only in the device draft) are never dropped
// silently. E2 (office #6, review #7): New over them keeps their draft and
// says so, with an Undo. Text, in a plain tab (New swaps in place).
import { server, browser, ok, section, done } from "./lib.mjs";
import { put, untilDraft } from "./office-lib.mjs";

const s = await server( { test: "test", ana: "ana-clave" } );
put( s, "files/compartida.txt", "de Ana\n", "ana" );
const ana = await s.client( "ana" );
const share = await ana.post( "/api/shares", JSON.stringify( { to: "test", root: "files/compartida.txt", app: "text" } ),
                              { "Content-Type": "application/json" } );
ok( share.status === 201, "Ana shares compartida.txt with test", share.status );

const c = await browser( s );
const me = await s.client( "test" );
const withMe = JSON.parse( ( await me.call( "GET", "/api/shares" ) ).text ).with_me || [];
const shared = withMe.length ? withMe[ 0 ].path : null;
ok( !! shared, "it is in test's \"shared with me\"", withMe );

const CM = "document.querySelector('.CodeMirror').CodeMirror";

section( "E2 · NEW OVER EDITS TO SOMEONE ELSE'S DOCUMENT" );

await c.open( "/nayive/text/?file=" + encodeURIComponent( shared ), "/nayive/text/" );
ok( await c.until( `document.querySelector('.CodeMirror') && ${CM}.getValue() === 'de Ana\\n'`, 20000 ), "her document is open (read-only for test)" );
await c.evaluate( `${CM}.replaceRange( 'mis notas\\n', { line: 0, ch: 0 } ), true` );
ok( await untilDraft( c, "mis notas" ), "the edits are in a device draft (the 7 s timer)" );

await c.evaluate( "document.getElementById('newBtn').click(), true" );
ok( await c.until( `${CM}.getValue() === ''` ), "New: a blank document" );
ok( await c.until( "document.getElementById('toast').classList.contains('show') && document.getElementById('toast').textContent.indexOf( NayiveUI.t('write.draftSetAside') ) !== -1", 3000 ),
    "the toast says the edits are set aside", await c.evaluate( "document.getElementById('toast').textContent" ) );
ok( await c.evaluate( "!! document.querySelector('#toast .toast-undo')" ), "with an Undo" );
ok( await untilDraft( c, "mis notas", 1000 ), "and their draft is still there" );

await c.evaluate( "( document.querySelector('#toast .toast-undo') || { click: function () {} } ).click(), true" );
ok( await c.until( `${CM}.getValue() === 'mis notas\\nde Ana\\n'` ), "Undo brings them back on screen" );

await done( c, s );
