// drive-settings.mjs - Drive's Settings dialog (drive/settings.js): each option
// is kept across a reload, the special folders change the app's config and
// nothing else in it, and the upload options do what they say on disk.
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, mouse, seed, exists } from "./lib.mjs";

const s = await server( { test: "test" } );
seed( s, { "files/Fotos/a.txt": "a", "files/Otra/b.txt": "b", "files/zeta.txt": "1", "files/alfa.txt": "22222", "files/same.txt": "OLD",
           "data/photos/config.json": '{"folder":"files/Fotos","keep":"me"}' } );
const read = rel => fs.readFileSync( path.join( s.home(), rel ), "utf8" );
const cfg  = () => JSON.parse( read( "data/drive/config.json" ) );

const c = await browser( s, { mouse: true } );
const ready = async () =>
{
    await c.open( "/nayive/drive/", "/nayive/drive/" );
    await c.until( "!! document.querySelector('#listing .row')" );
    await c.evaluate( "document.querySelectorAll('dialog[open]').forEach( d => d.close() ); true" );
};
const open  = async () => { await mouse( c, "#settingsBtn" ); await c.until( "document.getElementById('settingsBackdrop').open" ); };
const pick  = async ( id, v ) => { await c.evaluate( `( () => { const p = Ayni.picker( document.getElementById( '${id}' ) ); p.set( '${v}' ); document.getElementById( '${id}' ).dispatchEvent( new CustomEvent( 'ayni:change', { bubbles: true } ) ); return true; } )()` ); };
const order = () => c.evaluate( `[ ...document.querySelectorAll( '#listing .row[data-path$=".txt"]' ) ].map( r => r.dataset.path.split( '/' ).pop() ).join()` );
const send  = ( name, text ) => c.evaluate( `( () => { window.__up = null; uploadItems( [ { relPath: ${JSON.stringify( name )}, file: new File( [ ${JSON.stringify( text )} ], ${JSON.stringify( name )} ) } ] ).then( () => { window.__up = 'done'; } ); return true; } )()` );
const sent  = () => c.until( "window.__up === 'done'", 8000 );

const shot = async name =>
{
    if( ! process.env.SHOTS ) return;
    const r = await c.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( `${process.env.SHOTS}/${name}.png`, Buffer.from( r.data || r.result.data, "base64" ) );
};

section( "DRIVE SETTINGS · THE DIALOG" );
await ready();
await open();
ok( await c.until( `document.querySelector( '#setFolders [data-app="photos"] .set-path' ).textContent === 'Fotos'` ), "Photos shows its folder" );
ok( await c.until( `document.querySelector( '#setFolders [data-app="music"] .set-path' ).textContent === 'Not set'` ), "Music: not set" );
ok( await c.until( "! document.getElementById('setDaysField').hidden" ), "the bin's days are here" );
await c.evaluate( "( () => { const d = document.getElementById('setDays'); d.value = '45'; d.dispatchEvent( new Event( 'change', { bubbles: true } ) ); return true; } )()" );
ok( await c.until( "AyniNet.trashDays().then( r => r.days === 45 )" ), "the days are saved on the server" );

section( "DRIVE SETTINGS · SORT, PREVIEWS" );
ok( await order() === "alfa.txt,same.txt,zeta.txt", "by name at first", await order() );
await pick( "setSort", "size" );
ok( await c.until( "drivePrefs.sort === 'size'" ), "the sort takes" );
ok( cfg().sort === "size", "the sort is saved", JSON.stringify( cfg() ) );
await c.evaluate( "document.getElementById('setThumbs').click(); true" );
ok( await c.until( "drivePrefs.thumbs === false" ) && cfg().thumbs === false, "previews off is saved" );
await ready();
ok( await c.evaluate( "drivePrefs.sort === 'size' && drivePrefs.thumbs === false" ), "both survive a reload" );
ok( ( await order() ).startsWith( "alfa.txt" ), "the listing follows it", await order() );

section( "DRIVE SETTINGS · SPECIAL FOLDERS" );
await open();
await c.until( `document.querySelector( '#setFolders [data-app="photos"] .set-path' ).textContent === 'Fotos'` );
await c.evaluate( `document.querySelector( '#setFolders [data-app="photos"] button' ).click(); true` );
ok( await c.until( "document.querySelectorAll('dialog[open]').length === 2", 4000 ), "the folder picker opens over the dialog" );
await c.until( `!! document.querySelector( 'dialog.panel[open] .fp-tree [data-id="files/Otra"] .ti' )`, 4000 );
await c.evaluate( `document.querySelector( 'dialog.panel[open] .fp-tree [data-id="files/Otra"] .ti' ).click(); true` );
await c.evaluate( `[ ...document.querySelectorAll( 'dialog.panel[open] footer .btn.primary' ) ].pop().click(); true` );
ok( await c.until( `document.querySelector( '#setFolders [data-app="photos"] .set-path' ).textContent === 'Otra'`, 4000 ), "the row shows the new folder" );
const photos = JSON.parse( read( "data/photos/config.json" ) );
ok( photos.folder === "files/Otra" && photos.keep === "me", "only `folder` changed in its config", JSON.stringify( photos ) );
ok( await c.until( `!! document.querySelector( '#listing .row[data-path="files/Otra"] .mark-photos' ) && ! document.querySelector( '#listing .row[data-path="files/Fotos"] .mark-photos' )` ), "the badge moved" );
ok( exists( s, "files/Fotos/a.txt" ) && exists( s, "files/Otra/b.txt" ), "no file moved" );
await shot( "dialog" );
await c.evaluate( "document.getElementById('settingsCloseBtn').click(); true" );

section( "DRIVE SETTINGS · PHONE" );
const p = await browser( s, { width: 390, height: 700 } );
await p.open( "/nayive/drive/", "/nayive/drive/" );
await p.until( "!! document.querySelector('#listing .row')" );
await p.evaluate( "document.querySelectorAll('dialog[open]').forEach( d => d.close() ); openSettings(); true" );
ok( await p.until( "document.getElementById('settingsBackdrop').open" ), "it opens on a phone" );
const fit = await p.evaluate( `( () => { const d = document.getElementById( 'settingsBackdrop' ), b = d.querySelector( '.body' ), r = d.getBoundingClientRect();
    return { w: innerWidth, h: innerHeight, right: r.right, bottom: r.bottom, scrolls: b.scrollHeight <= b.clientHeight || getComputedStyle( b ).overflowY !== 'visible', side: b.scrollWidth <= b.clientWidth + 1 }; } )()` );
ok( fit.right <= fit.w && fit.bottom <= fit.h && fit.scrolls && fit.side, "it fits: no sideways scroll, the rest scrolls", JSON.stringify( fit ) );

section( "DRIVE SETTINGS · NAME ALREADY THERE" );
await ready();
await c.evaluate( `window.__twins = []; window.officeTwin = async function( p, r ) { window.__twins.push( p ); return { path: p, converted: false }; }; true` );
await send( "same.txt", "NEW" );
ok( await c.until( "document.getElementById('replaceBackdrop').open", 5000 ), "Ask: the question comes" );
await c.evaluate( "document.getElementById('replaceCancelBtn').click(); true" );
await sent();
ok( read( "files/same.txt" ) === "OLD", "Ask + Cancel: nothing changed" );

await c.evaluate( "savePref( 'clash', 'keep' ).then( () => true )" );
await send( "same.txt", "NEW" );
await sent();
ok( read( "files/same.txt" ) === "OLD", "Keep both: the old file is untouched" );
const copies = fs.readdirSync( path.join( s.home(), "files" ) ).filter( n => n !== "same.txt" && n.startsWith( "same" ) );
ok( copies.length === 1 && read( "files/" + copies[ 0 ] ) === "NEW", "Keep both: the new one sits beside it", copies.join() );
ok( await c.evaluate( "! document.getElementById('replaceBackdrop').open" ), "…with no question" );

section( "DRIVE SETTINGS · OFFICE COPY" );
await send( "uno.odt", "x" );
await sent();
ok( ( await c.evaluate( "window.__twins.length" ) ) === 1, "on: the twin is asked for" );
await c.evaluate( "savePref( 'officeTwin', false ).then( () => true )" );
await send( "dos.odt", "x" );
await sent();
ok( exists( s, "files/dos.odt" ) && ( await c.evaluate( "window.__twins.length" ) ) === 1, "off: uploaded, no twin" );

section( "DRIVE SETTINGS · VIDEOS" );
const answer = c.evaluate( `( async () => { window.getJson = async u => /convert/.test( u ) ? { available: true } : { count: 1 }; return true; } )()` );
await answer;
await c.evaluate( "savePref( 'convert', 'always' ).then( () => true )" );
ok( await c.evaluate( "askConvert( [ { relPath: 'a.avi' } ] )" ) === "convert", "Always: converts, no question" );
await c.evaluate( "savePref( 'convert', 'never' ).then( () => true )" );
ok( await c.evaluate( "askConvert( [ { relPath: 'a.avi' } ] )" ) === "plain", "Never: uploads as it is" );

section( "DRIVE SETTINGS · A DAMAGED CONFIG" );
fs.writeFileSync( path.join( s.home(), "data/drive/config.json" ), "[1,2]" );
await ready();
ok( await c.evaluate( "drivePrefs.sort === 'name' && drivePrefs.clash === 'ask'" ), "defaults: it asks" );
await c.evaluate( "savePref( 'sort', 'date' ).then( () => 'saved', () => 'refused' )" );
ok( read( "data/drive/config.json" ) === "[1,2]", "never written over" );
await done();
