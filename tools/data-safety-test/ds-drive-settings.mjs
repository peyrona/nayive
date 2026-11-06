// ds-drive-settings.mjs - Drive's Settings (drive/settings.js): "Keep both" on
// upload never replaces a file, an unreadable config is never written over, and
// a special folder changes `folder` alone in the app's config, and follows a
// rename or a move.
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, seed } from "../browser-test/lib.mjs";

const s = await server( { test: "test" } );
seed( s, { "files/same.txt": "OLD", "files/Otra/b.txt": "b", "files/Otra2": null, "data/music/config.json": '{"folder":"files/Otra","playlists":[1]}' } );
const read = rel => fs.readFileSync( path.join( s.home(), rel ), "utf8" );

const c = await browser( s, { mouse: true } );
await c.open( "/nayive/drive/", "/nayive/drive/" );
await c.until( "!! document.querySelector('#listing .row')" );
await c.evaluate( "document.querySelectorAll('dialog[open]').forEach( d => d.close() ); true" );

section( "DRIVE SETTINGS · KEEP BOTH" );
await c.evaluate( "savePref( 'clash', 'keep' ).then( () => true )" );
await c.evaluate( `uploadItems( [ { relPath: 'same.txt', file: new File( [ 'NEW' ], 'same.txt' ) } ] ).then( () => true )` );
ok( read( "files/same.txt" ) === "OLD", "the file there is not touched" );
const copies = fs.readdirSync( path.join( s.home(), "files" ) ).filter( n => n !== "same.txt" && n.startsWith( "same" ) );
ok( copies.length === 1 && read( "files/" + copies[ 0 ] ) === "NEW", "the new one has its own name", copies.join() );

section( "DRIVE SETTINGS · ITS OWN FILE" );
fs.writeFileSync( path.join( s.home(), "data/drive/config.json" ), "[1,2]" );
await c.evaluate( "savePref( 'sort', 'date' ).then( () => true, () => true )" );
ok( read( "data/drive/config.json" ) === "[1,2]", "an unreadable config is never written over" );

section( "DRIVE SETTINGS · A SPECIAL FOLDER" );
await c.evaluate( "openSettings(); true" );
await c.until( "document.getElementById('settingsBackdrop').open" );
await c.evaluate( `document.querySelector( '#setFolders [data-app="music"] button' ).click(); true` );
await c.until( `!! document.querySelector( 'dialog.panel[open] .fp-tree [data-id="files/Otra2"] .ti' )`, 4000 );
await c.evaluate( `document.querySelector( 'dialog.panel[open] .fp-tree [data-id="files/Otra2"] .ti' ).click(); true` );
await c.evaluate( `[ ...document.querySelectorAll( 'dialog.panel[open] footer .btn.primary' ) ].pop().click(); true` );
await c.until( `document.querySelector( '#setFolders [data-app="music"] .set-path' ).textContent === 'Otra2'`, 4000 );
const music = JSON.parse( read( "data/music/config.json" ) );
ok( music.folder === "files/Otra2" && music.playlists?.length === 1, "`folder` changes, the rest stays", JSON.stringify( music ) );
ok( fs.existsSync( path.join( s.home(), "files/Otra/b.txt" ) ), "no file moved" );

section( "DRIVE SETTINGS · A SPECIAL FOLDER FOLLOWS A MOVE" );
const music2 = () => JSON.parse( read( "data/music/config.json" ) );
const remap  = pairs => c.evaluate( `NayiveMedia.remapPaths( ${JSON.stringify( pairs )} ).then( () => true )` );
await remap( [ [ "files/Otra2", "files/Temas" ] ] );
ok( music2().folder === "files/Temas" && music2().playlists?.length === 1, "renamed: `folder` follows, the rest stays", JSON.stringify( music2() ) );
await remap( [ [ "files/Temas", "files/Media/Temas" ] ] );
await remap( [ [ "files/Media", "files/Otros" ] ] );
ok( music2().folder === "files/Otros/Temas", "a folder above it renamed: it follows too", music2().folder );
await remap( [ [ "files/Temas-no", "files/X" ] ] );
ok( music2().folder === "files/Otros/Temas", "a like-named folder leaves it alone", music2().folder );
await remap( [ [ "files/Otros/Temas", "files/Z", true ] ] );
ok( music2().folder === "files/Otros/Temas", "the Undo of a Replace leaves it on the original's path", music2().folder );
const before = fs.statSync( path.join( s.home(), "data/music/config.json" ) ).mtimeMs;
await remap( [ [ "files/Nada", "files/Nunca" ] ] );
ok( fs.statSync( path.join( s.home(), "data/music/config.json" ) ).mtimeMs === before, "nothing to follow: nothing written" );
ok( ! fs.existsSync( path.join( s.home(), "data/movies/config.json" ) ), "no config: none is made" );
await done();
