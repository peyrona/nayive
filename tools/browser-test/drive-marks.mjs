// drive-marks.mjs - the badges on Drive's folders: the Photos, Music and Movies
// folders (data/<app>/config.json), a folder shared with some users and one
// shared with everybody (/api/shares). SHOTS=<dir> also saves screenshots.
import fs from "node:fs";
import { server, browser, ok, section, done, mouse, key, seed } from "./lib.mjs";

const s = await server( { test: "test", ana: "ana", bea: "bea" } );
seed( s, { "files/Fotos/a.txt": "a", "files/Temas": null, "files/Pelis": null, "files/Amigos": null, "files/Todos": null,
           "files/Ambos": null, "files/Lista": null, "files/Plain": null, "files/note.txt": "n",
           "data/photos/config.json": '{"folder":"files/Fotos"}', "data/music/config.json": '{"folder":"files/Temas/"}',
           "data/movies/config.json": '{"folder":"files/Pelis"}' } );

const c = await browser( s, { mouse: true } );
const share = ( to, root ) => c.evaluate( `fetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({to:${JSON.stringify( to )},root:${JSON.stringify( root )},app:'folder',title:'x',mode:'ro'})}).then(r=>r.status)` );
await c.open( "/nayive/drive/", "/nayive/drive/" );
ok( await share( "ana", "files/Amigos" ) < 300, "shared one folder with a user" );
ok( await share( "*", "files/Todos" ) < 300, "shared one folder with everybody" );
ok( await share( "ana", "files/Fotos" ) < 300, "shared the Photos folder too" );
ok( await share( "ana", "files/Ambos" ) < 300 && await share( "*", "files/Ambos" ) < 300, "one folder both ways" );
ok( await share( "bea", "files/Lista" ) < 300 && await share( "ana", "files/Lista" ) < 300, "one folder with two users" );

const marks = p => c.evaluate( `[ ...document.querySelectorAll( '#listing .row[data-path="${p}"] .folder-mark' ) ].map( e => e.className.replace( 'folder-mark ', '' ) ).sort().join()` );
const shot  = async name =>
{
    if( ! process.env.SHOTS ) return;
    const r = await c.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( `${process.env.SHOTS}/${name}.png`, Buffer.from( r.data || r.result.data, "base64" ) );
};
const check = async () =>
{
    ok( await marks( "files/Fotos" ) === "mark-photos mark-logo,mark-shared mark-chip", "Photos folder + shared: both badges", await marks( "files/Fotos" ) );
    ok( await marks( "files/Temas" ) === "mark-media mark-logo", "Music folder (a trailing / in the config)", await marks( "files/Temas" ) );
    ok( await marks( "files/Pelis" ) === "mark-media mark-logo", "Movies folder" );
    ok( await marks( "files/Amigos" ) === "mark-shared mark-chip", "shared with a user" );
    ok( await marks( "files/Todos" ) === "mark-public mark-chip", "shared with everybody" );
    ok( await marks( "files/Ambos" ) === "mark-public mark-chip", "both ways: public wins", await marks( "files/Ambos" ) );
    ok( await marks( "files/Plain" ) === "" && await marks( "files/note.txt" ) === "", "a plain folder and a file: none" );
};

section( "DRIVE · FOLDER BADGES" );
await c.open( "/nayive/drive/", "/nayive/drive/" );
ok( await c.until( "!! document.querySelector('#listing .folder-mark')" ), "the badges come" );
await c.evaluate( "document.querySelectorAll('dialog[open]').forEach( d => d.close() ); true" );
await check();
const box = await c.evaluate( `( () => { const m = document.querySelector( '#listing .row[data-path="files/Fotos"] .folder-mark svg' ).getBoundingClientRect(); return m.width; } )()` );
ok( box < 30, "icons view: the logo stays smaller than the folder", box );
ok( await c.evaluate( `document.querySelector( '#listing .row[data-path="files/Todos"] .folder-mark' ).title === 'Shared with all Nayive users'` ), "the tooltip says what it means" );
await c.evaluate( "document.documentElement.dataset.theme = 'dark'; true" );
await shot( "icons-dark" );
await c.evaluate( "document.documentElement.dataset.theme = 'light'; true" );
await shot( "icons-light" );
await mouse( c, "#listBtn" );
await c.until( "! document.querySelector('#listing .list-rows.is-grid')" );
await check();
await shot( "list-light" );
const centred = await c.evaluate( `( () => { const r = document.querySelector( '#listing .row[data-path="files/Pelis"]' );
    const f = r.querySelector( '.row-ic > :not(.folder-mark)' ).getBoundingClientRect(), m = r.querySelector( '.mark-logo svg' ).getBoundingClientRect();
    return Math.abs( ( f.left + f.right ) - ( m.left + m.right ) ) / 2; } )()` );
ok( centred < 1, "the logo sits in the middle of the folder", centred );
ok( await c.evaluate( `getComputedStyle( document.querySelector( '#listing .mark-logo' ) ).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle( document.querySelector( '#listing .mark-logo' ) ).boxShadow === 'none'` ), "…with no circle around it" );

section( "DRIVE · PROPERTIES" );
const propRows = () => c.evaluate( `Object.fromEntries( [ ...document.querySelectorAll( '#propsBody dt' ) ].map( d => [ d.textContent, d.nextElementSibling.textContent ] ) )` );
const closeProps = () => c.evaluate( "document.getElementById('propsCloseBtn').click(); true" );
const sharedWith = async p =>
{
    await key( c, "Escape" );
    await mouse( c, `#listing .row[data-path="${p}"]`, { dx: 120 } );
    await mouse( c, "#propsBtn" );
    await c.until( "!! document.querySelector('#propsBody dt')" );
    const r = await propRows();
    await closeProps();
    return r;
};
ok( await c.evaluate( `( () => { const b = document.getElementById( 'propsBtn' ); return b.parentElement.classList.contains( 'tb-sys' ) && b.nextElementSibling.matches( '[data-help-open]' ); } )()` ), "the (i) sits just before the (?)" );
ok( ( await sharedWith( "files/Amigos" ) )[ "Shared with" ] === "ana", "Properties: the user it is shared with" );
ok( ( await sharedWith( "files/Lista" ) )[ "Shared with" ] === "ana, bea", "Properties: every user", await sharedWith( "files/Lista" ) );
ok( ( await sharedWith( "files/Todos" ) )[ "Shared with" ] === "All Nayive users", "Properties: everybody" );
ok( ( await sharedWith( "files/Ambos" ) )[ "Shared with" ] === "All Nayive users", "Properties: both ways says everybody" );
ok( ! ( "Shared with" in await sharedWith( "files/Plain" ) ), "Properties: not shared, no row" );
ok( await c.evaluate( "! document.querySelector('#selActions [data-pick-act=props]')" ), "no second (i) in the selection group" );
await key( c, "Escape" );
await c.evaluate( "browse.clear ? browse.clear() : 0; true" );
await c.open( "/nayive/drive/?open=files/Todos", "/nayive/drive/" );
await c.until( "currentFolder === 'files/Todos'" );
await c.until( "!! document.getElementById('propsBtn').offsetWidth" );
await c.evaluate( "document.querySelectorAll('dialog[open]').forEach( d => d.close() ); true" );
await c.until( "myShares.length > 0" );
await mouse( c, "#propsBtn" );
await c.until( "!! document.querySelector('#propsBody dt')" );
const here = await propRows();
ok( here[ "Shared with" ] === "All Nayive users" && here.Name === "Todos", "nothing picked: the open folder's details", here );
await shot( "props" );
await closeProps();
await c.evaluate( "openTrash(); true" );
ok( await c.until( "document.getElementById('propsBtn').hidden" ), "the bin has no (i)" );
await c.evaluate( "closeTrash(); true" );
await c.open( "/nayive/drive/", "/nayive/drive/" );
await c.until( "!! document.querySelector('#listing .folder-mark')" );
await c.evaluate( "document.querySelectorAll('dialog[open]').forEach( d => d.close() ); true" );
await c.evaluate( "document.documentElement.dataset.theme = 'light'; true" );
await mouse( c, "#propsBtn" );
ok( await c.until( "!! document.querySelector('#propsBody dt')" ), "at Home too" );
const home = await propRows();
ok( home.Name === "Home" && ! ( "Location" in home ), "…named Home, with no location", home );
await shot( "props-home" );
await closeProps();
if( ! await c.evaluate( "! document.querySelector('#listing .list-rows.is-grid')" ) ) await mouse( c, "#listBtn" );

section( "DRIVE · BADGES FOLLOW" );
const id = await c.evaluate( `fetch('/api/shares').then(r=>r.json()).then( j => j.mine.find( g => g.root === 'files/Amigos' ).id )` );
await c.evaluate( `fetch('/api/shares?id=${id}',{method:'DELETE'}).then( () => loadFolderMarks() ).then( () => true )` );
ok( await c.until( `! document.querySelector( '#listing .row[data-path="files/Amigos"] .folder-mark' )` ), "share taken back: the badge goes, no reload" );
ok( await c.evaluate( `! document.querySelector( '#listing .row[data-path="files/Amigos"]' ).classList.contains( 'has-mark' )` ), "…and the row is plain again" );
await mouse( c, `#listing .row[data-path="files/Fotos"]`, { dx: 120 } );
ok( await c.evaluate( "browse.ids().join()" ) === "files/Fotos", "a click on a marked row still picks it" );

section( "DRIVE · A SPECIAL FOLDER RENAMED" );
const cfgFolder = app => JSON.parse( fs.readFileSync( `${s.home()}/data/${app}/config.json`, "utf8" ) ).folder;
const rename = ( from, name ) => c.evaluate( `( renameTarget = ${JSON.stringify( from )}, document.getElementById( 'renameName' ).value = ${JSON.stringify( name )}, confirmRename().then( () => true ) )` );
const undo   = step => c.evaluate( `undoMoves( [ ${JSON.stringify( step )} ] ).then( () => true )` );
await rename( "files/Fotos", "Imagenes" );
ok( cfgFolder( "photos" ) === "files/Imagenes", "the app's folder follows the rename", cfgFolder( "photos" ) );
ok( ( await marks( "files/Imagenes" ) ).includes( "mark-photos" ), "…and the badge stays on it", await marks( "files/Imagenes" ) );
await undo( { from: "files/Fotos", to: "files/Imagenes", moved: true, bin: null } );
ok( cfgFolder( "photos" ) === "files/Fotos", "its Undo brings the folder back", cfgFolder( "photos" ) );
ok( ( await marks( "files/Fotos" ) ).includes( "mark-photos" ), "…and the badge" );
await c.evaluate( `AyniNet.rename( 'files/Plain', 'files/Temas/Sub' ).then( () => NayiveMedia.remapPaths( [ [ 'files/Temas', 'files/Canciones' ] ] ).then( () => AyniNet.rename( 'files/Temas', 'files/Canciones' ) ) ).then( () => reload() ).then( () => true )` );
ok( cfgFolder( "music" ) === "files/Canciones", "a trailing / in the config does not stop it", cfgFolder( "music" ) );
const bin = await c.evaluate( `AyniNet.binPaths( [ 'files/Pelis' ] ).then( async ids => { await AyniNet.rename( 'files/Lista', 'files/Pelis' ); await NayiveMedia.remapPaths( [ [ 'files/Lista', 'files/Pelis' ] ] ); return ids; } )` );
await undo( { from: "files/Lista", to: "files/Pelis", moved: true, bin } );
ok( cfgFolder( "movies" ) === "files/Pelis", "the Undo of a Replace stays on the restored original", cfgFolder( "movies" ) );
ok( ( await marks( "files/Pelis" ) ).includes( "mark-media" ), "…with its badge", await marks( "files/Pelis" ) );

section( "DRIVE · PHONE" );
const p = await browser( s, { width: 390, height: 800 } );
await p.open( "/nayive/drive/", "/nayive/drive/" );
ok( await p.until( "!! document.querySelector('#listing .folder-mark')" ), "the badges come on a phone" );
await p.evaluate( "document.querySelectorAll('dialog[open]').forEach( d => d.close() ); true" );
const small = await p.evaluate( `document.querySelector( '#listing .folder-mark svg' ).getBoundingClientRect().width` );
ok( small < 30, "…the logo stays smaller than the folder", small );
if( process.env.SHOTS )
{
    const r = await p.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( `${process.env.SHOTS}/phone.png`, Buffer.from( r.data || r.result.data, "base64" ) );
}

await done( c, p );
