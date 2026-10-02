// ds-00-harness.mjs - the harness itself works: a save from "another device"
// reaches the server, and a signed-in page reads it back.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";

const s = await server();
const c = await browser( s );
section( "HARNESS" );
const phone = await s.client();
const put = await phone.put( "files/a.txt", "hola\n" );
ok( put.status === 200, "a PUT from another session is saved", put.status );
ok( onDisk( s, "files/a.txt" ) === "hola\n", "the file is on disk" );
await c.open( "/nayive/text/?file=files/a.txt", "/nayive/text/" );
ok( await c.until( "document.querySelector('.CodeMirror') && document.querySelector('.CodeMirror').CodeMirror.getValue() === 'hola\\n'" ),
    "the Text app shows it" );
await done( c, s );
