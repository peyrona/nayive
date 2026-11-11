// ds-share-target-kinds.mjs - "Share -> Nayive" for any file, video or link
// (docs/share-target-plan.md, 2026-11-10).
//
// The service worker keeps every shared file (not only photos) and says what
// they are: "media" (photos/videos -> a Photos album) or "files" (anything
// else, or a mix -> a Drive folder). A link opens a choice (Bookmarks / Chat)
// and writes nothing. Files go up as NEW files only: a name already in the
// folder gets the next free one, never written over; a folder that cannot be
// read sends nothing. The service worker is ON for the first section only.
import { server, browser, ok, section, done, onDisk, disk } from "./lib.mjs";

const s = await server();
const phone = await s.client();
const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };
const json = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
const c = await browser( s );
const PAGE = "/nayive/share-target/index.html";

// What the inbox holds now: { m: manifest, files: [ { name, body } ] }.
const inbox = () => c.evaluate( `( async () => {
    const cache = await caches.open( 'nayive-share-inbox' );
    const base  = new URL( '/nayive/share-target/', location.href ).toString();
    const r = await cache.match( base + 'inbox/manifest.json' );
    const m = r ? await r.json() : null;
    const files = [];
    for( let i = 0; m && i < m.count; i++ ) { const f = await cache.match( base + 'inbox/' + i ); files.push( f ? await f.text() : null ); }
    return { m, files };
} )()` );

// The OS's share POST, as a form the page submits (a navigation, like the
// real one): the service worker answers it; where the browser lands is
// returned. (A fetch() would not do: the redirected page comes from the
// service worker's cache, under the URL it was cached with.)
// parts: [ [ field, value ] | [ field, body, type, name ] ]
const share = async parts =>
{
    await c.evaluate( `( () => {
        const f = document.createElement( 'form' );
        f.method = 'post'; f.enctype = 'multipart/form-data'; f.action = '/nayive/share-target/';
        for( const [ k, v, type, name ] of ${JSON.stringify( parts )} )
        {
            const i = document.createElement( 'input' );
            i.name = k;
            if( type ) { i.type = 'file'; const dt = new DataTransfer(); dt.items.add( new File( [ v ], name, { type } ) ); i.files = dt.files; }
            else       { i.type = 'hidden'; i.value = v; }
            f.appendChild( i );
        }
        document.body.appendChild( f );
        window.__leaving = true;
        f.submit();
        return true; } )()` );
    await c.until( "! window.__leaving && document.readyState === 'complete'" );
    return c.evaluate( "window.__arrived || location.href" );
};

// The same POST as a fetch, for a file with no name (a form cannot send one).
const shareFetch = parts => c.evaluate( `( async () => {
    const f = new FormData();
    for( const [ k, v, type, name ] of ${JSON.stringify( parts )} ) f.append( k, new File( [ v ], name, { type } ) );
    await fetch( '/nayive/share-target/', { method: 'POST', body: f } );
    return true;
} )()` );

const putInbox = ( m, bodies ) => c.evaluate( `( async () => {
    const cache = await caches.open( 'nayive-share-inbox' );
    for( const k of await cache.keys() ) await cache.delete( k );
    await cache.put( new URL( 'inbox/manifest.json', location.href ).toString(),
                     new Response( JSON.stringify( ${JSON.stringify( m )} ), { headers: { 'Content-Type': 'application/json' } } ) );
    const b = ${JSON.stringify( bodies )};
    for( let i = 0; i < b.length; i++ )
        await cache.put( new URL( 'inbox/' + i, location.href ).toString(), new Response( new Blob( [ b[ i ][ 0 ] ], { type: b[ i ][ 1 ] } ) ) );
    return true; } )()` );

//------------------------------------------------------------------------//
section( "SW · WHAT A SHARE LEAVES IN THE INBOX" );
{
    await c.send( "Network.setBypassServiceWorker", { bypass: false } );
    // Where each page landed, read before the page tidies its own address
    // (Chat drops ?text= at once, so a reload does not share it twice).
    const arrived = await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: "window.__arrived = location.href;" } );
    await c.open( PAGE );
    await c.evaluate( "navigator.serviceWorker.ready.then( () => true )" );
    await c.open( PAGE );
    ok( await c.until( "!! navigator.serviceWorker.controller", 30000 ), "the page is controlled by the service worker" );

    let url = await share( [ [ "photos", "PHOTO", "image/jpeg", "IMG_1.jpg" ], [ "photos", "VIDEO", "video/mp4", "VID_1.mp4" ] ] );
    let got = await inbox();
    ok( /\/nayive\/share-target\/\?n=2$/.test( url ), "a photo + a video: to the share page", url );
    ok( got.m && got.m.kind === "media" && got.m.count === 2 && got.files.join() === "PHOTO,VIDEO", "...both kept, kind media", got );

    url = await share( [ [ "photos", "PDF", "application/pdf", "report.pdf" ], [ "photos", "PHOTO2", "image/png", "shot.png" ] ] );
    got = await inbox();
    ok( /\?n=2$/.test( url ) && got.m.kind === "files" && got.files.join() === "PDF,PHOTO2", "a PDF + a photo: kind files, the earlier share (not kept) cleared", got );
    ok( got.m.names.join() === "report.pdf,shot.png", "...under their own names", got.m.names );

    await shareFetch( [ [ "photos", "NONAME", "application/zip", "" ] ] );
    got = await inbox();
    ok( got.m.kind === "files" && /^file-1(\.zip)?$/.test( got.m.names[ 0 ] ), "a file with no name gets one", got.m.names );

    // Photos kept after a failed upload, then a PDF shared: all of it, to Drive.
    await c.evaluate( `( async () => { const cache = await caches.open( 'nayive-share-inbox' ); const key = new URL( '/nayive/share-target/inbox/manifest.json', location.href ).toString();
        await cache.put( key, new Response( JSON.stringify( { count: 1, names: [ 'kept.jpg' ], kind: 'media', kept: true } ) ) );
        await cache.put( new URL( '/nayive/share-target/inbox/0', location.href ).toString(), new Response( 'KEPT' ) ); return true; } )()` );
    url = await share( [ [ "photos", "PDF2", "application/pdf", "b.pdf" ] ] );
    got = await inbox();
    ok( /\?n=2$/.test( url ) && got.m.kind === "files" && got.files.join() === "KEPT,PDF2", "kept photos + a new PDF: both kept, kind files", got );

    const before = JSON.stringify( await inbox() );
    url = await share( [ [ "title", "Example" ], [ "url", "https://example.org/a?b=1" ] ] );
    const q = new URL( url ).searchParams;
    ok( new URL( url ).pathname === "/nayive/share-target/" && q.get( "link" ) === "https://example.org/a?b=1" && q.get( "title" ) === "Example",
        "a link: the share page asks where it goes", url );
    ok( JSON.stringify( await inbox() ) === before, "...and the inbox is not touched" );

    url = await share( [ [ "text", "Look at this https://youtu.be/xyz" ] ] );
    ok( new URL( url ).searchParams.get( "link" ) === "https://youtu.be/xyz" &&
        new URL( url ).searchParams.get( "text" ) === "Look at this https://youtu.be/xyz", "a link inside the text (YouTube's Share): the same choice", url );

    url = await share( [ [ "text", "Just some words" ] ] );
    ok( new URL( url ).pathname === "/nayive/chat/" && new URL( url ).searchParams.get( "text" ) === "Just some words", "plain text: straight to Chat", url );

    await c.send( "Page.removeScriptToEvaluateOnNewDocument", { identifier: arrived.result.identifier } );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
}

//------------------------------------------------------------------------//
section( "DRIVE · SHARED FILES GO UP AS NEW FILES ONLY" );
{
    await seed( "files/Docs/report.pdf", "THE FOLDER'S REPORT" );
    await seed( "data/drive/config.json", JSON.stringify( { shareFolder: "files/Docs", sort: "name" } ) );
    await c.open( PAGE, PAGE );
    await putInbox( { count: 2, names: [ "report.pdf", "clip.mp4" ], kind: "files" },
                    [ [ "THE SHARED REPORT", "application/pdf" ], [ "THE SHARED CLIP", "video/mp4" ] ] );
    await c.open( PAGE + "?n=2", PAGE );
    ok( await c.until( "ITEMS.length === 2 && KIND === 'files' && DEST === 'files/Docs' && document.getElementById('goBtn').ariaDisabled !== 'true'" ),
        "the page shows them, the last share folder chosen" );
    ok( await c.evaluate( "document.getElementById('destLbl').textContent === Ayni.t( 'st.folder' ) && document.querySelectorAll( '#strip .tile' ).length === 2" ),
        "...labelled Folder, a tile per file" );

    // The listing fails: nothing is sent, the files stay.
    await c.evaluate( `window.__realList = AyniNet.listDir; AyniNet.listDir = function() { const e = new Error( 'HTTP 502' ); e.status = 502; return Promise.reject( e ); }; true` );
    await c.evaluate( "document.getElementById('goBtn').click(); true" );
    ok( await c.until( "document.querySelector( 'dialog.panel[open] .body > p.text' )" ), "it says so" );
    const said = await c.evaluate( "document.querySelector( 'dialog.panel[open] .body > p.text' ).textContent" );
    ok( said.includes( await c.evaluate( "Ayni.t( 'st.folderUnread' )" ) ), "...that the folder could not be read and nothing was sent", said );
    ok( onDisk( s, "files/Docs/report.pdf" ) === "THE FOLDER'S REPORT", "the folder's report is untouched" );
    ok( onDisk( s, "files/Docs/clip.mp4" ) === null, "nothing was written" );
    await c.evaluate( "document.querySelector( 'dialog.panel[open] header [data-close]' )?.click(); AyniNet.listDir = window.__realList; true" );

    await c.until( "document.getElementById('goBtn').ariaDisabled !== 'true'" );
    await c.evaluate( "document.getElementById('goBtn').click(); true" );
    ok( await disk( () => onDisk( s, "files/Docs/report (2).pdf" ) === "THE SHARED REPORT" ), "the shared report goes up under the next free name",
        onDisk( s, "files/Docs/report (2).pdf" ) );
    ok( onDisk( s, "files/Docs/report.pdf" ) === "THE FOLDER'S REPORT", "the folder's report is untouched" );
    ok( await disk( () => onDisk( s, "files/Docs/clip.mp4" ) === "THE SHARED CLIP" ), "the clip goes up as it is" );
    ok( await c.until( "location.pathname === '/nayive/drive/' && new URLSearchParams( location.search ).get( 'open' ) === 'files/Docs'" ),
        "Drive opens on that folder" );
    const cfg = json( "data/drive/config.json" );
    ok( cfg && cfg.shareFolder === "files/Docs" && cfg.sort === "name", "Drive's config keeps its other keys", cfg );
}

//------------------------------------------------------------------------//
section( "PHOTOS · A SHARED VIDEO GOES TO THE ALBUM UNTOUCHED" );
{
    await seed( "data/photos/config.json", JSON.stringify( { folder: "files/Album" } ) );
    await seed( "files/Album/keep.txt", "x" );
    await c.open( PAGE, PAGE );
    await putInbox( { count: 1, names: [ "VID_9.mp4" ], kind: "media" }, [ [ "THE VIDEO", "video/mp4" ] ] );
    await c.open( PAGE + "?n=1", PAGE );
    ok( await c.until( "ITEMS.length === 1 && KIND === 'media' && DEST === 'files/Album' && document.getElementById('goBtn').ariaDisabled !== 'true'" ), "the album is chosen" );
    await c.evaluate( "document.getElementById('goBtn').click(); true" );
    ok( await disk( () => onDisk( s, "files/Album/VID_9.mp4" ) === "THE VIDEO" ), "the video is in the album, as it was" );
    ok( await c.until( "location.pathname === '/nayive/photos/'" ), "Photos opens" );
}

//------------------------------------------------------------------------//
section( "LINK · A CHOICE, NOTHING WRITTEN" );
{
    await c.open( PAGE, PAGE );
    await putInbox( { count: 1, names: [ "a.pdf" ], kind: "files" }, [ [ "A", "application/pdf" ] ] );
    await c.open( PAGE + "?link=" + encodeURIComponent( "https://example.org/x" ) + "&title=Ex", PAGE );
    ok( await c.until( "! document.getElementById('linkCard').hidden && document.getElementById('review').hidden" ), "the link card, no upload card" );
    ok( ( await inbox() ).files.join() === "A", "the inbox is left as it was" );
    await c.evaluate( "document.getElementById('toBookmarks').click(); true" );
    ok( await c.until( "location.pathname === '/nayive/bookmarks/' && new URLSearchParams( location.search ).get( 'add' ) === 'https://example.org/x'" ),
        "Bookmarks opens with the link to add" );
}

//------------------------------------------------------------------------//
section( "ERR · WHAT WAS SHARED COULD NOT BE KEPT" );
{
    await c.open( PAGE, PAGE );
    await c.evaluate( "caches.delete( 'nayive-share-inbox' ).then( () => true )" );
    await c.open( PAGE + "?n=0&err=1", PAGE );
    ok( await c.until( "! document.getElementById('empty').hidden && document.getElementById('emptyText').textContent === Ayni.t( 'st.tooBig' )" ),
        "the page says it could not keep it" );
}

await done( c, s );
