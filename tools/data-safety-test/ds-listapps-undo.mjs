// ds-listapps-undo.mjs - an Undo never puts back a WHOLE old copy over what
// another device saved meanwhile, and the Bookmarks merge starts from the
// right copy. Real apps in Chromium, a second "device" over plain HTTP.
//
// H3 (list-apps #7, #15, #16, #21): Split's "delete expense", Contacts'
//     "Merged" (duplicates) and "Imported", Bookmarks' "Replace all" - each
//     Undo undoes only what its action did, on the list as it is NOW.
// H4 (list-apps #13): Calendar: a delete whose save met another device's
//     (412 -> merge) keeps its Undo, and the Undo brings the event back.
// H5 (list-apps #19): Bookmarks: the merge's base is this file's own last
//     save even while another save waits in the outbox.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server, browser, ok, section, done, onDisk, click, sleep } from "./lib.mjs";

const s = await server();
const c = await browser( s );
const phone = await s.client();
await c.evaluate( "['split','contact','bookmarks','calendar'].forEach( a => localStorage.setItem( 'balata-intro-dismiss:' + a, '1' ) ); true" );

// A file set up for a case, through the server (a PUT): written straight to disk
// it could carry an older time than the copy the browser holds, and its cache
// would keep showing that one.
const write = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };
const json  = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
// Waits for a condition on the server's disk (never a fixed time).
async function disk( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}
// The other device: read, change, save with its If-Unmodified-Since.
async function phoneEdit( rel, change )
{
    const r = await phone.get( rel );
    const body = change( r.text );
    return ( await phone.put( rel, body, { "If-Unmodified-Since": r.headers.get( "last-modified" ) } ) ).status;
}
async function setFile( selector, file )
{
    const doc = await c.send( "DOM.getDocument", {} );
    const q   = await c.send( "DOM.querySelector", { nodeId: doc.result.root.nodeId, selector } );
    await c.send( "DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [ file ] } );
}
// A fresh page of the app: by way of a blank page, as the same address would
// answer "loaded" from the old document before the new one starts.
async function reopen( p, want )
{
    await c.send( "Page.navigate", { url: "about:blank" } );
    await c.until( "location.href === 'about:blank'" );
    return c.open( p, want );
}
const TMP = fs.mkdtempSync( path.join( os.tmpdir(), "ds-undo-" ) );
const undo = () => c.evaluate( "( () => { const b = document.querySelector( '#toast .toast-undo' ); if( b ) b.click(); return !! b; } )()" );

//------------------------------------------------------------------------//
section( "H3 · SPLIT: delete an expense, a re-read brings the phone's, Undo" );
{
    const mem = [ { id: "m1", name: "Ana", me: true }, { id: "m2", name: "Luis" } ];
    const ex  = ( id, text ) => ( { id, type: "expense", date: "2026-10-01", amount: 1000, currency: "EUR", rate: 1, created: 1, text, paidBy: "m1", split: { among: [ "m1", "m2" ] } } );
    const F   = "data/split/g1/group.json";
    await write( F, JSON.stringify( { id: "g1", name: "Trip", currency: "EUR", created: "2026-09-01", archived: false, members: mem, rates: {}, entries: [ ex( "e1", "Taxi" ), ex( "e2", "Dinner" ) ] }, null, 2 ) );
    const texts = () => ( json( F ) || { entries: [] } ).entries.map( e => e.text ).sort().join( "," );

    await reopen( "/nayive/split/" );
    await c.until( "document.querySelector('#groupList .card-row')" );
    await c.evaluate( "document.querySelector('#groupList .card-row').click(); true" );
    ok( await c.until( "document.querySelectorAll('#entryList .card-row').length === 2" ), "the group is open" );
    await c.evaluate( "[...document.querySelectorAll('#entryList .card-row')].find( r => r.textContent.includes( 'Dinner' ) ).click(); true" );
    await c.until( "! document.getElementById('entryDelBtn').hidden" );
    await c.evaluate( "document.getElementById('entryDelBtn').click(); true" );
    ok( await disk( () => texts() === "Taxi" ), "deleted: the file holds Taxi only", texts() );

    const st = await phoneEdit( F, t => { const g = JSON.parse( t ); g.entries.push( ex( "e4", "Hotel" ) ); return JSON.stringify( g, null, 2 ); } );
    ok( st === 200, "the phone adds Hotel", st );
    await c.evaluate( "document.dispatchEvent( new Event( 'visibilitychange' ) ); true" );   // back to the tab: a re-read
    ok( await c.until( "[...document.querySelectorAll('#entryList .card-row')].some( r => r.textContent.includes( 'Hotel' ) )" ), "the re-read shows Hotel" );
    ok( await undo(), "Undo is there" );
    ok( await disk( () => texts() === "Dinner,Hotel,Taxi" ), "Undo: Dinner back, the phone's Hotel kept", texts() );
    ok( await c.until( "[...document.querySelectorAll('#entryList .card-row')].some( r => r.textContent.includes( 'Dinner' ) )" ), "...and Dinner is on screen" );
}

//------------------------------------------------------------------------//
section( "H3 · CONTACTS: merge two duplicates over a stale book, Undo" );
{
    const F = "data/contacts.vcf";
    const card = ( uid, fn, extra = [] ) => [ "BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + fn, "N:López;Ana;;;", ...extra, "END:VCARD" ].join( "\r\n" );
    await write( F, [ card( "a1", "Ana López", [ "TEL;TYPE=CELL:600111111" ] ), card( "a2", "Ana López", [ "TEL;TYPE=CELL:600222222" ] ) ].join( "\r\n" ) + "\r\n" );
    const uids = () => ( onDisk( s, F ) || "" ).match( /^UID:.*$/mg ).map( l => l.slice( 4 ).trim() ).sort().join( "," );

    await reopen( "/nayive/contact/" );
    ok( await c.until( "typeof contacts !== 'undefined' && contacts.length === 2" ), "the book is read" );
    const st = await phoneEdit( F, t => t + [ "BEGIN:VCARD", "VERSION:3.0", "UID:p", "FN:Pepe", "END:VCARD", "" ].join( "\r\n" ) );
    ok( st === 200, "the phone adds Pepe", st );

    await c.evaluate( "openMergeFor( contacts.filter( c => c.uid === 'a1' || c.uid === 'a2' ) ); true" );
    await c.until( "document.getElementById('mergeBackdrop').classList.contains('open')" );
    await c.evaluate( "document.getElementById('mergeConfirmBtn').click(); true" );
    ok( await disk( () => uids() === "a1,p" ), "merged; the save met the phone's and kept Pepe", uids() );
    ok( await undo(), "Undo is there" );
    ok( await disk( () => uids() === "a1,a2,p" ), "Undo: both Anas back, the phone's Pepe kept", uids() );
    ok( /UID:a1[\s\S]*600111111/.test( onDisk( s, F ) ) && ! /UID:a1[^]*?END:VCARD/.exec( onDisk( s, F ) )[ 0 ].includes( "600222222" ), "the first Ana is as she was" );
}

section( "H3 · CONTACTS: import over a stale book, Undo" );
{
    const F = "data/contacts.vcf";
    const card = ( uid, fn, extra = [] ) => [ "BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + fn, ...extra, "END:VCARD" ].join( "\r\n" );
    await write( F, card( "a", "Ana", [ "TEL;TYPE=CELL:600111111", "REV:20260101T000000Z" ] ) + "\r\n" );
    const uids = () => ( onDisk( s, F ) || "" ).match( /^UID:.*$/mg ).map( l => l.slice( 4 ).trim() ).sort().join( "," );

    await reopen( "/nayive/contact/" );
    ok( await c.until( "typeof contacts !== 'undefined' && contacts.length === 1 && contacts[ 0 ].uid === 'a'" ), "the book is read", await c.evaluate( "JSON.stringify( [ typeof contacts !== 'undefined' && contacts.map( c => c.uid ), location.href ] )" ).catch( e => String( e ) ) );
    const st = await phoneEdit( F, t => t + card( "p", "Pepe" ) + "\r\n" );
    ok( st === 200, "the phone adds Pepe", st );

    const file = path.join( TMP, "import.vcf" );
    fs.writeFileSync( file, [ card( "a", "Ana", [ "TEL;TYPE=CELL:600111111", "EMAIL;TYPE=HOME:ana@new.es", "REV:20261001T000000Z" ] ), card( "i", "Inés" ) ].join( "\r\n" ) + "\r\n" );
    await c.evaluate( "document.getElementById('importInput').value = ''; true" );
    await setFile( "#importInput", file );
    ok( await disk( () => uids() === "a,i,p" && /ana@new\.es/.test( onDisk( s, F ) ) ), "imported (Ana replaced, Inés added); Pepe kept", uids() );
    ok( await undo(), "Undo is there" );
    ok( await disk( () => uids() === "a,p" && ! /ana@new\.es/.test( onDisk( s, F ) ) ), "Undo: Inés out, Ana as she was, the phone's Pepe kept", uids() );
}

//------------------------------------------------------------------------//
const BF = "data/bookmarks/bookmarks.json";
const bm = ( id, title ) => ( { id, title, type: "bookmark", parentId: "root", url: "https://" + id + ".example/", tags: [], notes: "", favorite: false, createdAt: "2026-01-01T00:00:00Z" } );
const tree = ( ...nodes ) => JSON.stringify( { version: 1, rootId: "root", nodes: Object.assign(
    { root: { id: "root", title: "", type: "folder", parentId: null, children: nodes.map( n => n.id ), createdAt: "2026-01-01T00:00:00Z" } },
    ...nodes.map( n => ( { [ n.id ]: n } ) ) ) }, null, 2 );
const titles = () => { const d = json( BF ); return d ? Object.values( d.nodes ).filter( n => n.type === "bookmark" ).map( n => n.title ).sort().join( "," ) : ""; };

section( "H3 · BOOKMARKS: Replace all, a re-read brings the phone's, Undo" );
{
    await write( BF, tree( bm( "x", "X" ) ) );
    await reopen( "/nayive/bookmarks/" );
    ok( await c.until( "loaded && !! node( 'x' )" ), "the bookmarks are read" );

    const file = path.join( TMP, "z.html" );
    fs.writeFileSync( file, '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><A HREF="https://z.example/">Z</A>\n</DL><p>\n' );
    await c.evaluate( "NayiveUI.open( 'importBackdrop' ); document.getElementById( 'importInput' ).value = ''; document.querySelector( 'input[name=importMode][value=replace]' ).checked = true; true" );
    await setFile( "#importInput", file );
    await c.until( "document.querySelector( '.sheet-backdrop.open:not([id]) .sheet-actions button:last-child' )" );
    await c.evaluate( "document.querySelector( '.sheet-backdrop.open:not([id]) .sheet-actions button:last-child' ).click(); true" );
    ok( await disk( () => titles() === "Z" ), "Replace all: the file holds Z only", titles() );

    const st = await phoneEdit( BF, t => { const d = JSON.parse( t ); const y = bm( "y", "Y" ); d.nodes.y = y; d.nodes.root.children.push( "y" ); return JSON.stringify( d, null, 2 ); } );
    ok( st === 200, "the phone adds Y", st );
    await c.evaluate( "document.dispatchEvent( new Event( 'visibilitychange' ) ); true" );   // back to the tab: a re-read
    ok( await c.until( "!! node( 'y' )" ), "the re-read brings Y" );
    ok( await undo(), "Undo is there" );
    ok( await disk( () => titles() === "X,Y" ), "Undo: X back, Z out, the phone's Y kept", titles() );
}

section( "H5 · BOOKMARKS: the merge starts from this file's own last save" );
{
    await write( BF, tree( bm( "x", "A" ) ) );
    await reopen( "/nayive/bookmarks/" );
    ok( await c.until( "loaded && node( 'x' ) && node( 'x' ).title === 'A'" ), "the bookmarks are read", await c.evaluate( "JSON.stringify( [ loaded, node( 'x' ), location.href ] )" ).catch( e => String( e ) ) );

    // Another save waiting in the outbox (an office document held back): the
    // store never says "synced" while it is there.
    await c.evaluate( `new Promise( res => { const r = indexedDB.open( 'nube-store' ); r.onsuccess = () => {
        const tx = r.result.transaction( 'outbox', 'readwrite' );
        tx.objectStore( 'outbox' ).put( { path: 'files/held.docx', body: 'x', queuedAt: Date.now(), conflict: true, bin: false, ius: true, mrg: false } );
        tx.oncomplete = () => res( true ); }; } )` );

    await c.evaluate( "node( 'x' ).title = 'B'; save(); true" );
    ok( await disk( () => json( BF ).nodes.x.title === "B" ), "renamed here A -> B (saved)" );
    await c.until( "base && JSON.parse( base ).nodes.x.title === 'B'", 3000 );   // the page has taken its save as the base (the old build never does)
    const st = await phoneEdit( BF, t => { const d = JSON.parse( t ); d.nodes.x.title = "C"; return JSON.stringify( d, null, 2 ); } );
    ok( st === 200, "the phone renames it B -> C", st );

    await c.evaluate( "makeBookmark( { title: 'N', url: 'https://n.example/' }, ROOT ); save(); true" );
    ok( await disk( () => { const d = json( BF ); return d && Object.values( d.nodes ).some( n => n.title === "N" ); } ), "a bookmark added here goes up (merged)" );
    ok( json( BF ).nodes.x.title === "C", "the phone's later rename stays (C), not undone back to B", json( BF ).nodes.x.title );
    await c.evaluate( `new Promise( res => { const r = indexedDB.open( 'nube-store' ); r.onsuccess = () => {
        const tx = r.result.transaction( 'outbox', 'readwrite' ); tx.objectStore( 'outbox' ).delete( 'files/held.docx' ); tx.oncomplete = () => res( true ); }; } )` );
}

//------------------------------------------------------------------------//
section( "H4 · CALENDAR: delete on a stale copy (412 -> merge), the Undo stays and works" );
{
    const F = "data/calendar.ics";
    const ev = ( uid, sum, h ) => [ "BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:20260901T100000Z", "DTSTART:20261005T" + h + "0000",
                                    "DTEND:20261005T" + String( +h + 1 ).padStart( 2, "0" ) + "0000", "SUMMARY:" + sum, "END:VEVENT" ];
    const cal = ( ...evs ) => [ "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:x", ...evs.flat(), "END:VCALENDAR", "" ].join( "\r\n" );
    await write( F, cal( ev( "a", "Alpha", "10" ), ev( "b", "Bravo", "12" ) ) );
    const sums = () => ( ( onDisk( s, F ) || "" ).match( /^SUMMARY:.*$/mg ) || [] ).map( l => l.slice( 8 ).trim() ).sort().join( "," );

    await reopen( "/nayive/calendar/?date=2026-10-05", "/nayive/calendar/" );
    ok( await c.until( "[...document.querySelectorAll('.fc-event')].some( e => e.textContent.includes( 'Bravo' ) )" ), "the day shows Bravo" );
    const st = await phoneEdit( F, t => t.replace( "END:VCALENDAR", ev( "c", "Charlie", "15" ).join( "\r\n" ) + "\r\nEND:VCALENDAR" ) );
    ok( st === 200, "the phone adds Charlie", st );

    await c.evaluate( "( () => { const e = [...document.querySelectorAll('.fc-event')].find( e => e.textContent.includes( 'Bravo' ) ); e.setAttribute( 'data-ds', 'b' ); e.scrollIntoView( { block: 'center' } ); return true; } )()" );
    await click( c, "[data-ds=b]" );
    ok( await c.until( "getComputedStyle( document.getElementById('deleteBtn') ).display !== 'none'" ), "Bravo's sheet is open" );
    await c.evaluate( "document.getElementById('deleteBtn').click(); true" );
    ok( await disk( () => sums() === "Alpha,Charlie" ), "deleted; the save met the phone's and kept Charlie", sums() );
    ok( await c.evaluate( "document.getElementById('toast').classList.contains('actionable') && document.getElementById('toast').classList.contains('show')" ),
        "the Undo is still on show after the merge" );
    await undo();
    ok( await disk( () => sums() === "Alpha,Bravo,Charlie" ), "Undo: Bravo back, Charlie kept", sums() );
}

fs.rmSync( TMP, { recursive: true, force: true } );
await done( c, s );
