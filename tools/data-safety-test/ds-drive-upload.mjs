// ds-drive-upload.mjs - Drive never replaces a file the user did not choose
// to replace (batch C3a).
//
// D1 (drive-files #1): a folder dropped again replaced every same-named file
//     inside it with no question, and rebuilt the Office twins over them.
// D3 (drive-files #2): the clash check read the listing on screen - a file
//     another device put there since was replaced; and a name taken after
//     the check went up blind.
// A1 part (office #1): Drive's Office-twin open made a blank desktop window
//     first, a second editor beside the one already showing that document.
// open.js: a 409 from /api/office (the twin's name taken during the
//     conversion) said "could not be converted" instead of opening it.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { xlsx } from "./office-lib.mjs";

const s = await server();
const phone = await s.client();
const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };

await seed( "files/Trabajo/foto.jpg", "EDITED PHOTO" );
await seed( "files/Trabajo/Informe.odt", "odt v1" );
await seed( "files/Trabajo/Informe.docx", "TWIN EDITED IN WRITE" );
await seed( "files/Trabajo2/a.txt", "old a" );

const c = await browser( s, { width: 1280, height: 800 } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:drive', '1' ); true" );
const READY = "typeof uploadItems === 'function' && FS_ROOT === 'files' && currentFolder === 'files' && ! listingLoading && curListing.path === 'files'";
ok( await c.open( "/nayive/drive/", "/nayive/drive/" ) && await c.until( READY, 20000 ), "Drive is open on its root" );

// The Office twin is made by LibreOffice, which the scratch server lacks:
// officeTwin is recorded instead - its `replace` flag is what rebuilt a twin.
await c.evaluate( `window.__twins = []; window.officeTwin = async function( p, r )
    { window.__twins.push( [ p, !! r ] ); return { path: p.replace( /\\.od[ts]$/, '.docx' ), converted: false }; }; true` );

// Starts an upload (not awaited: it may stop on a question). window.__up says when it ended.
const upload = items => c.evaluate( `( () => { window.__up = null;
    uploadItems( ${JSON.stringify( items )}.map( function( it ) { return { relPath: it[ 0 ], file: new File( [ it[ 1 ] ], it[ 0 ].split( '/' ).pop() ) }; } ) )
        .then( function() { window.__up = 'done'; }, function( e ) { window.__up = 'error ' + e; } ); return true; } )()` );
const ended = () => c.until( "window.__up !== null", 15000 );
const replaceAsked = () => c.until( "document.getElementById('replaceBackdrop').classList.contains('open')", 5000 );
const listed = () => c.evaluate( "Array.from( document.querySelectorAll( '#replaceList li' ) ).map( function( li ) { return li.textContent; } )" );
// The shared NayiveUI.confirm sheet: its buttons, by title.
const sheetUp = ( ms = 5000 ) => c.until( "document.querySelector( '.sheet-backdrop.open:not([id]) .sheet-actions button' )", ms );
const press = title => c.evaluate( `( () => { const b = Array.from( document.querySelectorAll( '.sheet-backdrop.open:not([id]) .sheet-actions button' ) )
    .find( function( x ) { return x.title === ${JSON.stringify( title )}; } ); if( ! b ) return false; b.click(); return true; } )()` );
const T = k => c.evaluate( `NayiveUI.t( ${JSON.stringify( k )} )` );

//------------------------------------------------------------------------//
section( "D1 · A FOLDER DROPPED AGAIN" );
{
    await upload( [ [ "Trabajo/foto.jpg", "PC PHOTO" ], [ "Trabajo/Informe.odt", "odt v2" ], [ "Trabajo/nueva.txt", "new file" ] ] );
    const asked = await replaceAsked();
    ok( asked, "the files already inside the folder get the question" );
    const names = asked ? await listed() : [];
    ok( names.includes( "Trabajo/foto.jpg" ) && names.includes( "Trabajo/Informe.odt" ) && ! names.includes( "Trabajo/nueva.txt" ),
        "it lists the same-named files in the folder, not the new one", names );
    if( asked )     // "Replace the ones that exist" off -> skip them
        await c.evaluate( "document.getElementById('replaceOverwrite').checked = false; document.getElementById('replaceConfirmBtn').click(); true" );
    ok( await ended(), "the upload ends" );
    ok( onDisk( s, "files/Trabajo/foto.jpg" ) === "EDITED PHOTO", "Skip: the photo in the folder is untouched", onDisk( s, "files/Trabajo/foto.jpg" ) );
    ok( onDisk( s, "files/Trabajo/Informe.odt" ) === "odt v1", "...and the LibreOffice document too" );
    ok( onDisk( s, "files/Trabajo/nueva.txt" ) === "new file", "...while the new file went up" );
    const tw = await c.evaluate( "window.__twins" );
    ok( ! tw.some( t => t[ 1 ] ), "no twin is rebuilt with replace", tw );
}
{
    // "Replace" replaces what was listed - a.txt - and nothing it did not list:
    // b.odt's twin was not there when asked, so it is never made with replace.
    await c.evaluate( "window.__twins = []; true" );
    await upload( [ [ "Trabajo2/a.txt", "new a" ], [ "Trabajo2/b.odt", "b" ] ] );
    const asked = await replaceAsked();
    ok( asked, "Trabajo2/a.txt gets the question" );
    if( asked )
        await c.evaluate( "document.getElementById('replaceOverwrite').checked = true; document.getElementById('replaceConfirmBtn').click(); true" );
    ok( await ended(), "the upload ends" );
    ok( onDisk( s, "files/Trabajo2/a.txt" ) === "new a", "Replace: the listed file is replaced (asked and said yes)" );
    const tw = await c.evaluate( "window.__twins" );
    ok( tw.length === 1 && tw[ 0 ][ 0 ] === "files/Trabajo2/b.odt" && tw[ 0 ][ 1 ] === false,
        "the twin nobody was asked about is made without replace (an existing one is kept)", tw );
}

//------------------------------------------------------------------------//
section( "D3 · A FILE ANOTHER DEVICE PUT THERE AFTER DRIVE LOOKED" );
{
    await seed( "files/IMG_1234.jpg", "BETO'S PHOTO" );     // the listing on screen does not know it
    ok( await c.evaluate( "! curListing.nodes.some( function( n ) { return n.path === 'files/IMG_1234.jpg'; } )" ), "(the listing on screen does not show it)" );
    await upload( [ [ "IMG_1234.jpg", "ANA'S PHOTO" ] ] );
    const asked = await replaceAsked();
    ok( asked, "the upload asks: the name is taken on the server" );
    if( asked ) await c.evaluate( "document.getElementById('replaceCancelBtn').click(); true" );
    ok( await ended(), "the upload ends" );
    ok( onDisk( s, "files/IMG_1234.jpg" ) === "BETO'S PHOTO", "Cancel: the other device's photo is untouched" );
}
{
    // The name is taken between the check and the PUT (another window saves
    // it while this one prepares the photo): create-only gets a 412 -> asked.
    await c.evaluate( `( () => { const real = NayivePhoto.prepare; let once = true;
        NayivePhoto.prepare = async function( f, m ) { if( once ) { once = false; await GumApi.writeFileBytes( 'files/race.jpg', new TextEncoder().encode( 'OTHER WINDOW' ) ); }
                                                       NayivePhoto.prepare = real; return real( f, m ); }; return true; } )()` );
    await upload( [ [ "race.jpg", "THIS WINDOW" ] ] );
    const asked = await sheetUp();
    const body  = asked ? await c.evaluate( "document.querySelector( '.sheet-backdrop.open:not([id]) .dialog-text' ).textContent" ) : "";
    ok( asked && /race\.jpg/.test( body ), "a name taken after the check gets its own question", body );
    if( asked ) ok( await press( await T( "drive.keepBoth" ) ), "Keep both" );
    ok( await ended(), "the upload ends" );
    ok( onDisk( s, "files/race.jpg" ) === "OTHER WINDOW", "the file that took the name is untouched", onDisk( s, "files/race.jpg" ) );
    const copy = "files/race (" + await T( "drive.copyWord" ) + ").jpg";
    ok( onDisk( s, copy ) === "THIS WINDOW", "...and this one went up beside it", copy );
}
{
    // A 412 against this very upload's first try (a re-sent PUT after a drop):
    // the same bytes are there - no question, nothing doubled.
    await c.evaluate( `( () => { const real = NayivePhoto.prepare; let once = true;
        NayivePhoto.prepare = async function( f, m ) { if( once ) { once = false; await GumApi.writeFileBytes( 'files/again.jpg', new TextEncoder().encode( 'SAME BYTES' ) ); }
                                                       NayivePhoto.prepare = real; return real( f, m ); }; return true; } )()` );
    await upload( [ [ "again.jpg", "SAME BYTES" ] ] );
    ok( await ended(), "the upload ends with no question" );
    ok( onDisk( s, "files/again.jpg" ) === "SAME BYTES", "the file is there once" );
    ok( onDisk( s, "files/again (" + await T( "drive.copyWord" ) + ").jpg" ) === null, "no copy of it" );
}

//------------------------------------------------------------------------//
section( "OPEN · THE TWIN'S NAME TAKEN DURING THE CONVERSION (409)" );
{
    // A plain tab: window.open is recorded, officeTwin answers 409 then the twin.
    await c.evaluate( `( () => { window.__opened = []; window.__toasts = [];
        window.open = function( url ) { const w = { document: { body: {} }, location: {}, close: function() { w.closed = true; } }; window.__opened.push( w ); return w; };
        let n = 0; window.officeTwin = async function( p, r )
        { if( n++ === 0 ) { const e = new Error( 'HTTP 409: Conflict' ); e.status = 409; throw e; } return { path: 'files/z.docx', converted: false }; };
        openOffice( { path: 'files/z.odt', nodes: null }, 'write' ); return true; } )()` );
    ok( await c.until( "window.__opened.length && /write\\/index\\.html\\?file=files%2Fz\\.docx$/.test( window.__opened[ 0 ].location.href || '' )" ),
        "the twin that took the name is opened", await c.evaluate( "window.__opened.map( function( w ) { return w.location.href || ''; } )" ) );
    ok( await c.evaluate( `window.__toasts.some( function( t ) { return t === NayiveUI.tf( 'drive.officeTwinExists', { name: 'z.docx' } ); } )` ),
        "...saying it already exists", await c.evaluate( "window.__toasts" ) );
}
await c.stop();

//------------------------------------------------------------------------//
section( "A1 · THE TWIN ALREADY OPEN IN A DESKTOP WINDOW" );
{
    await seed( "files/hoja.ods", "ods" );
    await seed( "files/hoja.xlsx", xlsx( { a1: "NOW" } ) );
    const d = await browser( s, { width: 1600, height: 1000 } );
    await d.evaluate( `localStorage.setItem( 'balata-desktop', JSON.stringify( { mode: 'always' } ) );
        localStorage.setItem( 'balata-intro-dismiss:drive', '1' ); localStorage.setItem( 'balata-intro-dismiss:calc', '1' );
        localStorage.setItem( 'balata-intro-dismiss:desktop', '1' ); true` );
    await d.open( "/nayive/desktop/", "/nayive/desktop/" );
    ok( await d.until( "window.NayiveDesktop && typeof NayiveDesktop.open === 'function'", 20000 ), "the desktop is up" );
    const WINS  = "document.querySelectorAll('#desk > .win').length";
    const frame = app => `Array.from( document.querySelectorAll('#desk > .win iframe') ).map( function( f ) { return f.contentWindow; } )
        .find( function( w ) { try { return w.location.pathname.indexOf( '/nayive/${app}/' ) === 0; } catch( e ) { return false; } } )`;

    await d.evaluate( "NayiveDesktop.open( '/nayive/calc/index.html?file=files/hoja.xlsx' ), true" );
    ok( await d.until( `${WINS} === 1 && ${frame( "calc" )}`, 20000 ), "hoja.xlsx open in a Calc window" );
    await d.evaluate( "NayiveDesktop.open( '/nayive/drive/' ), true" );
    const DRIVE = frame( "drive" );
    ok( await d.until( `${WINS} === 2 && ${DRIVE} && ${DRIVE}.eval( "FS_ROOT" ) === 'files' && typeof ${DRIVE}.openOffice === 'function'`, 20000 ), "Drive in a window" );
    ok( await d.evaluate( `${DRIVE}.NayiveUI.windowed && ! ${DRIVE}.isPhone()` ), "(Drive's window is a wide desktop window)" );

    // Double-click hoja.ods: its twin hoja.xlsx is the answer (already made,
    // no LibreOffice needed). openOffice resolves once the window is opened.
    ok( await d.evaluate( `${DRIVE}.openOffice( { path: 'files/hoja.ods', nodes: null }, 'calc' ).then( function() { return true; } )` ), "the twin is opened" );
    ok( await d.evaluate( WINS ) === 2, "no second window: the Calc window already showing hoja.xlsx is used", await d.evaluate( WINS ) );
    await d.stop();
}

await done( s );
