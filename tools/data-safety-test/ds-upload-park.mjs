// ds-upload-park.mjs - big office saves are PARKED on this device and go up
// only now and then (shared/store.js PARKED SAVES, docs/upload-less-plan.md).
//
// Store side (the real store.js on st.html): over 100 KB going up (Text: once
// gzipped) is kept in the outbox with no PUT; 100 KB or less goes up as
// always; unpark() sends it; another tab never sends it while the page that
// parked it is open, and does once that page is gone; the launcher and the
// desktop send it at boot; the plug stays calm; no Web Locks, create-only and
// replace are never parked; the .bak is made on the server, once, and a
// replacing save keeps it owed.
// Office side (Text): an autosave of a big document parks ("here" floppy),
// Ctrl+S and a closed desktop window send it, a touch screen sends it when
// the page hides.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";
import { stPage, seed, untilNode } from "./store-lib.mjs";

const s = await server();
stPage( s );
const phone = await s.client();
const c = await browser( s );
await c.open( "/nayive/st.html" );

const disk = rel => onDisk( s, rel );
// Text that stays big once gzipped: random hex in 80-column lines.
const big  = ( kb, tag ) => { let o = tag + "\n"; while( o.length < kb * 1024 ) o += crypto.randomBytes( 40 ).toString( "hex" ) + "\n"; return o; };
const puts = ( t, rel ) => t.evaluate( `LOG.filter( function ( l ) { return l.put === ${JSON.stringify( rel )}; } ).length` );
const entry = ( t, rel ) => t.evaluate( `idb( 'outbox', ${JSON.stringify( rel )} ).then( function ( e ) { return e && { park: !! e.park, bak: !! e.bak, marked: !! e.marked, conflict: !! e.conflict }; } )` );
const write = ( t, rel, body, o ) => t.evaluate( `J( SC.write( ${JSON.stringify( rel )}, ${JSON.stringify( body )}, ${JSON.stringify( o || {} )} ) )` ).then( JSON.parse );
const read  = ( t, rel ) => t.evaluate( `SC.read( ${JSON.stringify( rel )} ).then( function () { return true; } )` );
async function closeTab( t ) { await fetch( `http://127.0.0.1:${c.port}/json/close/${t.id}` ).catch( () => {} ); await sleep( 300 ); }

//----------------------------------------------------------------------------//
section( "OVER 100 KB IS PARKED, NOT SENT; 100 KB OR LESS GOES UP" );
{
    const F = "files/big.txt", G = "files/small.txt";
    await seed( phone, F, "old\n" );
    await seed( phone, G, "old\n" );
    await read( c, F );
    await read( c, G );
    const B1 = big( 300, "B1" );
    const r = await write( c, F, B1, { park: true } );
    ok( r.ok && r.parked, "a 300 KB save answers ok + parked", r );
    ok( ( await entry( c, F ) || {} ).park, "it waits in the outbox, flagged park", await entry( c, F ) );
    await sleep( 2000 );                                        // a flush (1.5 s debounce) would have sent it by now
    ok( await puts( c, F ) === 0 && disk( F ) === "old\n", "no PUT: the server still has the old file", { puts: await puts( c, F ) } );
    ok( await c.evaluate( "SC.state" ) === "synced", "the plug stays calm (not 'pending')", await c.evaluate( "SC.state" ) );

    const SMALL = "x".repeat( 300 * 1024 );                     // 300 KB of text, a few hundred bytes gzipped
    const r2 = await write( c, G, SMALL, { park: true } );
    ok( r2.ok && ! r2.parked && disk( G ) === SMALL, "300 KB that gzips small goes up at once (Text measures after gzip)", r2 );

    const r3 = await c.evaluate( `J( SC.unpark( ${JSON.stringify( F )}, { open: true } ) )` ).then( JSON.parse );
    ok( r3.ok && disk( F ) === B1, "unpark() sends it: the server has it", r3 );
    ok( ! await entry( c, F ), "and the outbox is empty" );
}

//----------------------------------------------------------------------------//
section( "ANOTHER TAB NEVER SENDS IT WHILE ITS PAGE IS OPEN; DOES ONCE IT IS GONE" );
{
    const F = "files/twotabs.txt";
    await seed( phone, F, "old\n" );
    const t1 = await c.tab();
    await t1.open( "/nayive/st.html" );
    await read( t1, F );
    const B2 = big( 300, "B2" );
    ok( ( await write( t1, F, B2, { park: true } ) ).parked, "tab 1 parks a save" );
    await c.evaluate( "SC.flush().then( function () { return true; } )" );
    ok( disk( F ) === "old\n" && await puts( c, F ) === 0, "a flush in tab 2 leaves it alone (tab 1 holds its park lock)" );
    await closeTab( t1 );
    await c.evaluate( "SC.flush().then( function () { return true; } )" );
    ok( await untilNode( () => disk( F ) === B2 ), "tab 1 closed: the next flush elsewhere sends it" );
}

//----------------------------------------------------------------------------//
section( "THE LAUNCHER AND THE DESKTOP SEND WHAT A CLOSED TAB LEFT" );
for( const [ page, want ] of [ [ "/nayive/index.html", "/nayive/index.html" ], [ "/nayive/desktop/", "/nayive/desktop/" ] ] )
{
    const F = "files/boot" + ( page.indexOf( "desktop" ) !== -1 ? "-desk" : "" ) + ".txt";
    await seed( phone, F, "old\n" );
    const t1 = await c.tab();
    await t1.open( "/nayive/st.html" );
    await read( t1, F );
    const B = big( 300, "boot " + page );
    ok( ( await write( t1, F, B, { park: true } ) ).parked, "parked in a tab (" + page + ")" );
    await closeTab( t1 );
    await sleep( 1500 );
    ok( disk( F ) === "old\n", "nothing sent while no page runs" );
    const t2 = await c.tab();
    await t2.open( page, want );
    ok( await untilNode( () => disk( F ) === B, 20000 ), page + " sends it at boot", { disk: ( disk( F ) || "" ).slice( 0, 12 ) } );
    await closeTab( t2 );
}

//----------------------------------------------------------------------------//
section( "NEVER PARKED: NO WEB LOCKS, CREATE-ONLY, REPLACE" );
{
    const t1 = await c.tab();
    await t1.send( "Page.addScriptToEvaluateOnNewDocument", { source: "try{ Object.defineProperty( navigator, 'locks', { value: undefined, configurable: true } ); }catch(e){}" } );
    await t1.open( "/nayive/st.html" );
    const F = "files/nolocks.txt";
    await seed( phone, F, "old\n" );
    await read( t1, F );
    const B = big( 300, "nolocks" );
    const r = await write( t1, F, B, { park: true } );
    ok( r.ok && ! r.parked && disk( F ) === B, "a browser with no Web Locks sends it as always", r );
    await closeTab( t1 );

    const N = "files/brand-new.txt", R = "files/replace-me.txt";
    const B3 = big( 300, "create" );
    const r2 = await write( c, N, B3, { park: true, createOnly: true } );
    ok( r2.ok && ! r2.parked && disk( N ) === B3, "create-only is never parked", r2 );
    await seed( phone, R, "theirs\n" );
    const r3 = await write( c, R, B3, { park: true, replace: true } );
    ok( r3.ok && ! r3.parked && disk( R ) === B3, "replace is never parked", r3 );
}

//----------------------------------------------------------------------------//
section( ".BAK ON THE SERVER: MADE BY WHOEVER SENDS IT, KEPT THROUGH A REPLACE" );
{
    const F = "files/Cartas/con-bak.txt";
    await seed( phone, F, "the version before this session\n" );
    await read( c, F );
    ok( ( await write( c, F, big( 300, "first" ), { park: true, bak: true } ) ).parked, "a parked save that owes the .bak" );
    const B5 = big( 300, "second" );
    ok( ( await write( c, F, B5, { park: true, bak: false } ) ).parked, "a later save of the page (bak: false) replaces it" );
    ok( ( await entry( c, F ) || {} ).bak, "the replacing entry still owes the .bak", await entry( c, F ) );
    ok( disk( "files/Cartas/.bak/con-bak.txt" ) === null, "no .bak before it goes up" );
    await c.evaluate( `SC.unpark( ${JSON.stringify( F )}, { open: true } ).then( function () { return true; } )` );
    ok( disk( "files/Cartas/.bak/con-bak.txt" ) === "the version before this session\n", "sent: the .bak is the copy from before (made on the server)" );
    ok( disk( F ) === B5, "and the file is the last save" );
    const B6 = big( 300, "third" );
    await c.evaluate( `J( SC.write( ${JSON.stringify( F )}, ${JSON.stringify( B6 )}, { bak: false } ) )` );
    ok( await untilNode( () => disk( F ) === B6 ) && disk( "files/Cartas/.bak/con-bak.txt" ) === "the version before this session\n",
        "the next save leaves the .bak alone" );
}

//----------------------------------------------------------------------------//
section( "BYTES (WRITE / CALC): PARKED, SENT WHOLE, SET ASIDE WHOLE" );
{
    // A binary store, as Write's and Calc's; 300 KB of random bytes (a .docx
    // with pictures does not shrink either). Its sum, to compare with the disk.
    const SB = `( window.SB = window.SB || NayiveStore.createStore( { apiBase: location.origin + '/api/files', binary: true, conflicts: true } ) )`;
    const BYTES = `( function () { var b = new Uint8Array( 300 * 1024 ); for( var i = 0; i < b.length; i += 65536 ) crypto.getRandomValues( b.subarray( i, i + 65536 ) );
        var sum = 0; for( var j = 0; j < b.length; j++ ) sum = ( sum * 31 + b[ j ] ) >>> 0; window.__bytes = b; return sum; } )()`;
    const sumOf = buf => { let x = 0; for( const v of buf ) x = ( x * 31 + v ) >>> 0; return x; };
    const onDiskBytes = rel => { try { return fs.readFileSync( path.join( s.home(), rel ) ); } catch { return null; } };
    const F = "files/doc.docx";
    await seed( phone, F, "old" );
    await c.evaluate( `${SB}.read( ${JSON.stringify( F )} ).then( function () { return true; } )` );
    const sum = await c.evaluate( BYTES );
    const r = JSON.parse( await c.evaluate( `J( SB.write( ${JSON.stringify( F )}, window.__bytes, { park: true } ) )` ) );
    await sleep( 2000 );
    ok( r.parked && disk( F ) === "old", "300 KB of bytes is parked, nothing sent", r );
    await c.evaluate( `SB.unpark( ${JSON.stringify( F )}, { open: true } ).then( function () { return true; } )` );
    const got = onDiskBytes( F );
    ok( got && got.length === 300 * 1024 && sumOf( got ) === sum, "unpark sends the bytes whole" );

    // A tab parks bytes, the phone saves over the file, the tab goes: beside it.
    // (Another file: this page still holds doc.docx's park lock - it is open here.)
    const G = "files/hoja.xlsx";
    await seed( phone, G, "old" );
    const t1 = await c.tab();
    await t1.open( "/nayive/st.html" );
    await t1.evaluate( `${SB}.read( ${JSON.stringify( G )} ).then( function () { return true; } )` );
    const sum2 = await t1.evaluate( BYTES );
    ok( JSON.parse( await t1.evaluate( `J( SB.write( ${JSON.stringify( G )}, window.__bytes, { park: true } ) )` ) ).parked, "a tab parks new bytes" );
    ok( await t1.until( "idb( 'outbox', 'files/hoja.xlsx' ).then( function ( e ) { return !! e && !! e.marked; } )" ), "and its mark is up" );
    await seed( phone, G, "the phone's" );
    await closeTab( t1 );
    await c.evaluate( "SC.flush().then( function () { return true; } )" );
    let aside = null;
    await untilNode( () => ( aside = fs.readdirSync( path.join( s.home(), "files" ) ).find( n => n.indexOf( "hoja (" ) === 0 && n.endsWith( ".xlsx" ) ) ) );
    const ab = aside ? onDiskBytes( "files/" + aside ) : null;
    ok( disk( G ) === "the phone's" && ab && ab.length === 300 * 1024 && sumOf( ab ) === sum2, "the phone's file stays; the parked bytes are whole beside it", aside );
}

//----------------------------------------------------------------------------//
section( "TEXT: AN AUTOSAVE PARKS, CTRL+S / A CLOSED WINDOW / A HIDDEN TOUCH PAGE SEND IT" );
{
    const F = "files/libro.txt";
    const BODY = big( 300, "libro" );
    await seed( phone, F, BODY );
    const t = await c.tab();
    await t.open( "/nayive/text/?file=" + F, "/nayive/text/" );
    const CM = "document.querySelector('.CodeMirror').CodeMirror";
    ok( await t.until( `document.querySelector('.CodeMirror') && ${CM}.getValue().length > 1000`, 20000 ), "Text shows the big file" );
    await t.evaluate( `( function () { if( window.__puts ) return true; window.__puts = []; var f = window.fetch;
        window.fetch = async function ( u, o ) { var r = await f.apply( this, arguments );
            if( o && o.method === 'PUT' ) window.__puts.push( decodeURIComponent( String( u ).replace( /^.*file=/, '' ).replace( /&.*$/, '' ) ) );
            return r; }; return true; } )()` );
    const tput  = () => t.evaluate( `window.__puts.filter( function ( p ) { return p === ${JSON.stringify( F )}; } ).length` );
    const typeIn = text => t.evaluate( `${CM}.replaceRange( ${JSON.stringify( text )}, { line: 0, ch: 0 } ), true` );
    // The desktop hides the tab: the waiting autosave runs now (no 15 s wait).
    const hide = () => t.evaluate( `( function () { Object.defineProperty( document, 'visibilityState', { get: function () { return 'hidden'; }, configurable: true } );
        document.dispatchEvent( new Event( 'visibilitychange' ) ); delete document.visibilityState; return true; } )()` );
    const floppy = () => t.evaluate( "( document.getElementById('savedAt') || {} ).dataset.state" );

    await typeIn( "UNO " );
    await hide();
    ok( await t.until( "document.getElementById('savedAt').dataset.state === 'here'", 10000 ), "the autosave parks: the floppy says 'here'", await floppy() );
    ok( await tput() === 0 && disk( F ) === BODY, "and nothing went up" );

    await t.evaluate( `${CM}.triggerOnKeyDown( { type: 'keydown', keyCode: 83, ctrlKey: true, preventDefault: function () {}, stopPropagation: function () {} } ), true` );
    ok( await untilNode( () => ( disk( F ) || "" ).indexOf( "UNO " ) === 0 ), "Ctrl+S sends it" );
    ok( await t.until( "document.getElementById('savedAt').dataset.state === 'saved'" ), "the floppy is green again" );

    await typeIn( "DOS " );
    await hide();
    ok( await t.until( "document.getElementById('savedAt').dataset.state === 'here'", 10000 ), "parked again" );
    ok( await t.evaluate( "window.nayiveBeforeClose().then( function ( r ) { return r === true; } )" ), "a desktop window's close is let through" );
    ok( ( disk( F ) || "" ).indexOf( "DOS UNO " ) === 0, "and the save went up before it" );

    // A touch screen: hidden = it may be killed, so the parked save goes up.
    await t.evaluate( `( function () { var m = window.matchMedia; window.matchMedia = function ( q ) {
        return q === '(pointer: coarse)' ? { matches: true, media: q, addListener: function () {}, removeListener: function () {},
                                             addEventListener: function () {}, removeEventListener: function () {} } : m.call( window, q ); }; return true; } )()` );
    await typeIn( "TRES " );
    await hide();
    ok( await untilNode( () => ( disk( F ) || "" ).indexOf( "TRES DOS UNO " ) === 0 ), "a touch page that hides sends it" );
    ok( await t.until( "document.getElementById('savedAt').dataset.state === 'saved'" ), "and says 'saved'", await floppy() );
    await closeTab( t );
}

await done( c, s );
