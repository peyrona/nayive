// ds-drive-upload.mjs - Drive never replaces a file the user did not choose
// to replace (batch C3a).
//
// D1 (drive-files #1): a folder dropped again replaced every same-named file
//     inside it with no question, and rebuilt the Office twins over them.
//     Review: an Office twin that is there is listed on its own, and only a
//     listed one is rebuilt; the user moving to another folder mid-upload
//     never sends anything there.
// D3 (drive-files #2): the clash check read the listing on screen - a file
//     another device put there since was replaced; and a name taken after
//     the check went up blind. Review: a big file of the same size is never
//     taken for this upload's own; Cancel on the question names what was
//     not sent.
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
await seed( "files/Trabajo4/Plan.odt", "plan v1" );
await seed( "files/Trabajo4/Plan.docx", "PLAN EDITED IN WRITE" );
await seed( "files/Trabajo5/Nota.odt", "nota v1" );
await seed( "files/A/IMG_1.jpg", "A OLD" );
await seed( "files/B/IMG_1.jpg", "B PRECIOUS" );

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
    ok( names.includes( "Trabajo/Informe.docx" ), "...and the Office twin that is there, on a line of its own", names );
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

{
    // Both Plan.odt and its twin Plan.docx (edited in Write) are there: the
    // question lists both, and "Replace" then rebuilds the twin it listed.
    await c.evaluate( "window.__twins = []; true" );
    await upload( [ [ "Trabajo4/Plan.odt", "plan v2" ] ] );
    const asked = await replaceAsked();
    const names = asked ? await listed() : [];
    ok( names.includes( "Trabajo4/Plan.odt" ) && names.includes( "Trabajo4/Plan.docx" ), "the .odt AND its .docx are listed", names );
    if( asked ) await c.evaluate( "document.getElementById('replaceConfirmBtn').click(); true" );     // all collide: Replace
    ok( await ended(), "the upload ends" );
    const tw = await c.evaluate( "window.__twins" );
    ok( tw.length === 1 && tw[ 0 ][ 0 ] === "files/Trabajo4/Plan.odt" && tw[ 0 ][ 1 ] === true, "the listed twin is rebuilt (said Replace to it)", tw );
}
{
    // Only Nota.odt is there when asked; its twin Nota.docx appears while the
    // upload runs. Not listed -> asked for without replace -> left as it is
    // (the real server: an existing twin is the answer, no LibreOffice needed).
    await c.evaluate( `( () => { window.__twins = []; window.__toasts = []; window.__stubTwin = window.officeTwin;
        window.officeTwin = async function( p, r )
        { window.__twins.push( [ p, !! r ] ); const q = new URLSearchParams( { file: p } ); if( r ) q.set( 'replace', '1' );
          return JSON.parse( await GumApi.fetchText( '/api/office?' + q.toString(), { method: 'POST' } ) ); };
        const prep = NayivePhoto.prepare; let once = true;
        NayivePhoto.prepare = async function( f, m ) { if( once ) { once = false; await GumApi.writeFileBytes( 'files/Trabajo5/Nota.docx', new TextEncoder().encode( 'APPEARED' ) ); }
                                                       NayivePhoto.prepare = prep; return prep( f, m ); }; return true; } )()` );
    await upload( [ [ "Trabajo5/Nota.odt", "nota v2" ] ] );
    const asked = await replaceAsked();
    const names = asked ? await listed() : [];
    ok( names.length === 1 && names[ 0 ] === "Trabajo5/Nota.odt", "only Nota.odt is listed", names );
    if( asked ) await c.evaluate( "document.getElementById('replaceConfirmBtn').click(); true" );
    ok( await ended(), "the upload ends" );
    const tw = await c.evaluate( "window.__twins" );
    ok( tw.length === 1 && tw[ 0 ][ 1 ] === false, "the twin that was not listed is asked for without replace", tw );
    ok( onDisk( s, "files/Trabajo5/Nota.docx" ) === "APPEARED", "...and stays as it is", onDisk( s, "files/Trabajo5/Nota.docx" ) );
    ok( await c.until( "window.__toasts.some( function( t ) { return /Nota\\.docx/.test( t ); } )" ), "the last message says it was left as it was",
        await c.evaluate( "window.__toasts" ) );
    await c.evaluate( "window.officeTwin = window.__stubTwin; true" );
}
{
    // The user opens folder B while an upload into A runs: "Replace" was said
    // for A/IMG_1.jpg - B/IMG_1.jpg is never touched.
    await c.evaluate( "navigateTo( 'files/A' ); true" );
    ok( await c.until( "currentFolder === 'files/A' && ! listingLoading && curListing.path === 'files/A'" ), "(in folder A)" );
    await c.evaluate( `( () => { const real = NayivePhoto.prepare; let n = 0;
        NayivePhoto.prepare = async function( f, m ) { if( ++n === 2 ) { navigateTo( 'files/B' ); NayivePhoto.prepare = real; } return real( f, m ); }; return true; } )()` );
    await upload( [ [ "x0.txt", "zero" ], [ "IMG_1.jpg", "PC NEW" ] ] );
    ok( await replaceAsked(), "A/IMG_1.jpg gets the question" );
    await c.evaluate( "document.getElementById('replaceOverwrite').checked = true; document.getElementById('replaceConfirmBtn').click(); true" );
    ok( await ended(), "the upload ends" );
    ok( onDisk( s, "files/B/IMG_1.jpg" ) === "B PRECIOUS", "B/IMG_1.jpg, never asked about, is untouched", onDisk( s, "files/B/IMG_1.jpg" ) );
    ok( onDisk( s, "files/A/IMG_1.jpg" ) === "PC NEW" && onDisk( s, "files/A/x0.txt" ) === "zero", "everything went to A, where it was dropped" );
    await c.evaluate( "navigateTo( 'files' ); true" );
    ok( await c.until( READY ), "(back at the root)" );
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
    // the same bytes are there - no question, nothing doubled. The first PUT
    // lands, but its answer is lost (as a dropped connection would): GumApi
    // sends it again (C4b: the check lives in GumApi, after a re-send only).
    await c.evaluate( `( () => { const X = XMLHttpRequest.prototype, send = X.send; let once = true;
        X.send = function( b ) { if( once ) { once = false; X.send = send; const x = this; x.onload = function() { x.onerror(); }; }
                                 return send.apply( this, arguments ); }; return true; } )()` );
    await upload( [ [ "again.jpg", "SAME BYTES" ] ] );
    ok( await ended(), "the upload ends with no question" );
    ok( onDisk( s, "files/again.jpg" ) === "SAME BYTES", "the file is there once" );
    ok( onDisk( s, "files/again (" + await T( "drive.copyWord" ) + ").jpg" ) === null, "no copy of it" );
}
{
    // A DIFFERENT file of the same size (too big to read back) takes the name:
    // it is not taken for this upload's own - the user is asked.
    const N = 9 * 1024 * 1024 + 7;
    await c.evaluate( `( () => { const real = NayivePhoto.prepare; let once = true;
        NayivePhoto.prepare = async function( f, m ) { if( once ) { once = false; await GumApi.writeFileBytes( 'files/big.bin', new Blob( [ 'B'.repeat( ${N} ) ] ) ); }
                                                       NayivePhoto.prepare = real; return real( f, m ); }; return true; } )()` );
    await c.evaluate( `( () => { window.__up = null; uploadItems( [ { relPath: 'big.bin', file: new File( [ 'A'.repeat( ${N} ) ], 'big.bin' ) } ] )
        .then( function() { window.__up = 'done'; }, function( e ) { window.__up = 'error ' + e; } ); return true; } )()` );
    const asked = await sheetUp( 20000 );
    ok( asked, "a big file of the same size gets the question too" );
    if( asked ) await press( await T( "drive.keepBoth" ) );
    ok( await ended(), "the upload ends" );
    ok( ( onDisk( s, "files/big.bin" ) || "" )[ 0 ] === "B", "the other file is untouched" );
    ok( ( onDisk( s, "files/big (" + await T( "drive.copyWord" ) + ").bin" ) || "" )[ 0 ] === "A", "...and this one went up beside it" );
}
{
    // Cancel on that question stops the rest: the last message names what was not sent.
    await c.evaluate( `( () => { window.__toasts = []; const real = NayivePhoto.prepare; let n = 0;
        NayivePhoto.prepare = async function( f, m ) { if( ++n === 2 ) { await GumApi.writeFileBytes( 'files/r2.txt', new TextEncoder().encode( 'OTHER' ) ); NayivePhoto.prepare = real; }
                                                       return real( f, m ); }; return true; } )()` );
    await upload( [ [ "r1.txt", "one" ], [ "r2.txt", "two" ], [ "r3.txt", "three" ] ] );
    ok( await sheetUp(), "r2.txt gets the question" );
    await c.evaluate( "document.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Escape', bubbles: true } ) ); true" );   // = Cancel
    ok( await ended(), "the upload ends" );
    ok( onDisk( s, "files/r1.txt" ) === "one" && onDisk( s, "files/r2.txt" ) === "OTHER" && onDisk( s, "files/r3.txt" ) === null, "r1 went, r2 is untouched, r3 was not sent" );
    ok( await c.until( "window.__toasts.some( function( t ) { return /r2\\.txt/.test( t ) && /r3\\.txt/.test( t ); } )" ),
        "the message names what was not sent", await c.evaluate( "window.__toasts" ) );
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

    // A FOLDER of the twin's name: a 409 every time - said plainly.
    await c.evaluate( `( () => { window.__opened = []; window.__toasts = [];
        window.officeTwin = async function() { const e = new Error( 'HTTP 409: Conflict' ); e.status = 409; throw e; };
        openOffice( { path: 'files/y.odt', nodes: null }, 'write' ); return true; } )()` );
    ok( await c.until( "window.__toasts.some( function( t ) { return t === NayiveUI.tf( 'drive.officeTwinFolder', { name: 'y.docx' } ); } )" ),
        "a folder named like the twin: said so", await c.evaluate( "window.__toasts" ) );
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
