// ds-bookmarks-merge.mjs - Bookmarks' merge with another device's save, and
// its export into Nayive (batch C4c).
//
// C5 (lead L-b, list-apps #20): the page merged by itself: it dropped the
//     held-back save (forget) BEFORE writing the merged one - a tab closed in
//     between lost every edit since the last sync - and the merged save went
//     up with no check. Now the STORE merges (the app's `merge`), in one
//     step, and every save of the file carries its version.
// Item 8: the "Merged" toast took the place of a pending Undo, which became
//     final - a delete the user wanted back was gone. Now it waits.
// io.js export (S6 review): a folder listing that failed counted as "no
//     names taken", and the export replaced a file of that name. Now
//     create-only, the next free name on 412.
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";

const s = await server();
const c = await browser( s );
const phone = await s.client();
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:bookmarks', '1' ); true" );

const BF = "data/bookmarks/bookmarks.json";
const bm = ( id, title ) => ( { id, title, type: "bookmark", parentId: "root", url: "https://" + id + ".example/", tags: [], notes: "", favorite: false, createdAt: "2026-01-01T00:00:00Z" } );
const tree = ( ...nodes ) => JSON.stringify( { version: 1, rootId: "root", nodes: Object.assign(
    { root: { id: "root", title: "", type: "folder", parentId: null, children: nodes.map( n => n.id ), createdAt: "2026-01-01T00:00:00Z" } },
    ...nodes.map( n => ( { [ n.id ]: n } ) ) ) }, null, 2 );
const json   = () => { try { return JSON.parse( onDisk( s, BF ) ); } catch { return null; } };
const titles = () => { const d = json(); return d ? Object.values( d.nodes ).filter( n => n.type === "bookmark" ).map( n => n.title ).sort().join( "," ) : ""; };
const write  = async body => { const r = await phone.put( BF, body ); if( r.status !== 200 && r.status !== 201 ) throw new Error( "seed: " + r.status ); };
// The phone adds a bookmark to the file as the server has it now.
async function phoneAdds( id, title )
{
    const d = JSON.parse( ( await phone.get( BF ) ).text );
    d.nodes[ id ] = bm( id, title );
    d.nodes.root.children.push( id );
    await write( JSON.stringify( d, null, 2 ) );
}
async function disk( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}
async function reopen()
{
    await c.send( "Page.navigate", { url: "about:blank" } );
    await c.until( "location.href === 'about:blank'" );
    await c.open( "/nayive/bookmarks/", "/nayive/bookmarks/" );
    const up = await c.until( "typeof loaded !== 'undefined' && loaded && typeof node === 'function'" );
    // Every PUT of the file: its checks and the answer.
    await c.evaluate( `( function () { window.__puts = []; var f = window.fetch;
        window.fetch = async function ( u, o ) { var r = await f.apply( this, arguments );
            if( o && o.method === 'PUT' && String( u ).indexOf( 'bookmarks.json' ) !== -1 ) {
                var h = o.headers || {}; window.__puts.push( { im: h[ 'If-Match' ] || null, inm: h[ 'If-None-Match' ] || null, st: r.status } ); }
            return r; };
        return true; } )()` );
    return up;
}

//----------------------------------------------------------------------------//
section( "C5 · A SAVE OVER THE PHONE'S: MERGED BY THE STORE, NEVER SENT BLIND" );
{
    await write( tree( bm( "x", "X" ) ) );
    ok( await reopen(), "Bookmarks is open" );
    await phoneAdds( "p", "From the phone" );
    await c.evaluate( "window.__toasts = []; makeBookmark( { title: 'Here', url: 'https://here.example/' }, ROOT ); save(); true" );
    ok( await disk( () => titles() === "From the phone,Here,X" ), "the file has both: the phone's and this page's", titles() );
    const puts = await c.evaluate( "window.__puts" );
    ok( puts.some( p => p.st === 412 ), "(the save met the phone's: 412)", puts );
    ok( puts.length && puts.every( p => p.im || p.inm ), "every save of the file carried its version - the merged one too", puts );
    ok( await c.until( "!! node( 'p' ) && window.__toasts.some( function ( t ) { return t.indexOf( NayiveUI.t( 'bookmarks.merged' ) ) !== -1; } )" ),
        "the screen shows the phone's bookmark, and says \"Merged\"", await c.toasts() );
}

//----------------------------------------------------------------------------//
section( "ITEM 8 · \"MERGED\" WAITS FOR A PENDING UNDO" );
{
    await write( tree( bm( "x", "X" ), bm( "y", "Y" ) ) );
    ok( await reopen(), "Bookmarks is open" );
    await phoneAdds( "q", "Phone again" );
    // Delete Y (Undo on show); its save meets the phone's and is merged.
    await c.evaluate( "window.__toasts = []; deleteNodes( [ 'y' ] ); true" );
    ok( await disk( () => titles() === "Phone again,X" ), "the delete went up, merged with the phone's", titles() );
    ok( await c.until( "!! node( 'q' )" ), "the merge is on screen" );
    ok( await c.evaluate( "!! document.querySelector( '#toast .toast-undo' )" ), "the delete's Undo is still there" );
    await c.evaluate( "( document.querySelector( '#toast .toast-undo' ) || { click: function () {} } ).click(), true" );
    ok( await disk( () => titles() === "Phone again,X,Y" ), "Undo: Y is back (and the phone's stays)", titles() );
    ok( await c.until( "window.__toasts.some( function ( t ) { return t.indexOf( NayiveUI.t( 'bookmarks.merged' ) ) !== -1; } )" ),
        "\"Merged\" is said once the Undo is gone", await c.toasts() );
}

//----------------------------------------------------------------------------//
section( "EXPORT INTO NAYIVE WHEN THE FOLDER'S LISTING FAILS" );
{
    ok( await reopen(), "Bookmarks is open" );
    const name = await c.evaluate( "'bookmarks-' + NayiveUI.todayIso() + '.json'" );
    const r = await phone.put( "files/" + name, "PRECIOUS - another file of that name" );
    ok( r.status === 200 || r.status === 201, "a file of the export's name is in Files" );
    await c.evaluate( `GumApi.listDir = function () { var e = new Error( 'HTTP 500' ); e.status = 500; return Promise.reject( e ); };
        NayiveUI.pickFolder = function () { return Promise.resolve( 'files' ); };
        document.querySelector( 'input[name=exportWhere][value=nayive]' ).checked = true;
        NayiveUI.open( 'exportBackdrop' ); document.getElementById( 'exportJsonBtn' ).click(); true` );
    const two = name.replace( /\.json$/, " (2).json" );
    ok( await disk( () => onDisk( s, "files/" + two ) !== null ), "the export is saved under the next free name", two );
    ok( onDisk( s, "files/" + name ) === "PRECIOUS - another file of that name", "the file that was there is untouched", onDisk( s, "files/" + name ) );
}

await done( c, s );
