// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * sw.js - Offline shell cache for the Nayive apps.
 *
 * Served at /nayive/sw.js, so its default scope is /nayive/ - it covers every
 * app and the planner iframes. (The scope is read live from
 * self.registration.scope below, so this file has no hardcoded prefix.)
 *
 * What it does:
 *   - install : precache the SHELL (each app's HTML + shared/ + icons) so the
 *               pages load with no connection. The heavier PRECACHE_REST
 *               (vendored lib/, dictionaries, the editor bundle) is warmed in
 *               the background after activation, so a post-deploy update never
 *               starves the page that triggered it.
 *   - fetch   : HTML          -> cache-first (every page is precached: a deploy
 *                                 changes CACHE_VERSION and brings the new one)
 *               versioned libs -> cache-first (filenames carry the version)
 *               a file GET      -> the network first, untouched; the "nayive-trips-docs"
 *               (/api/files?file=)  copy (the trips page fills it with just the active
 *                                 trip's files) only when the network fails or is slow
 *               /api/*          -> passed straight through; the app and
 *                                 shared/store.js own the data path, never cached.
 *
 * The PRECACHE_SHELL / PRECACHE_REST lists and CACHE_VERSION between the
 * @generated markers are written by tools/build-precache - run it before
 * ./deploy.sh, do not hand-edit them.
 *
 * Service workers need a secure context, so this only runs over HTTPS or on
 * http://localhost - elsewhere on plain HTTP the page skips registration.
 */

/* @generated:cache-version */
var CACHE_VERSION = "nayive-117ba8b970b4";
/* @end */

/* @generated:precache */
var PRECACHE_SHELL = [
    "admin.html",
    "bookmarks/bookmarks.css",
    "bookmarks/boot.js",
    "bookmarks/icons/icon-192.png",
    "bookmarks/icons/icon-512.png",
    "bookmarks/index.html",
    "bookmarks/input.js",
    "bookmarks/io.js",
    "bookmarks/manifest.json",
    "bookmarks/model.js",
    "bookmarks/render.js",
    "bookmarks/sheets.js",
    "calc/calc.css",
    "calc/calc.js",
    "calc/codec.js",
    "calc/format.js",
    "calc/grid.js",
    "calc/index.html",
    "calendar/icons/icon-192.png",
    "calendar/icons/icon-512.png",
    "calendar/index.html",
    "calendar/manifest.json",
    "chat/call.js",
    "chat/chat.css",
    "chat/chat.js",
    "chat/compose.js",
    "chat/conv.js",
    "chat/core.js",
    "chat/guest-sw.js",
    "chat/guest.js",
    "chat/index.html",
    "chat/info.js",
    "chat/list.js",
    "chat/marks.js",
    "chat/media.js",
    "chat/push-notice.js",
    "contact/icons/icon-192.png",
    "contact/icons/icon-512.png",
    "contact/index.html",
    "contact/manifest.json",
    "desktop/index.html",
    "desktop/tiling.js",
    "device.html",
    "drive/actions.js",
    "drive/advsearch.js",
    "drive/dragdrop.js",
    "drive/drive.css",
    "drive/index.html",
    "drive/init.js",
    "drive/keyboard.js",
    "drive/listing.js",
    "drive/menus.js",
    "drive/move-copy.js",
    "drive/navigate.js",
    "drive/open.js",
    "drive/state.js",
    "drive/toolbar.js",
    "drive/trash.js",
    "drive/tree.js",
    "drive/upload.js",
    "drive/viewers.js",
    "drive/zip.js",
    "email/accounts.js",
    "email/actions.js",
    "email/browse.js",
    "email/compose.js",
    "email/core.js",
    "email/email.css",
    "email/email.js",
    "email/index.html",
    "email/labels.js",
    "email/list.js",
    "email/read.js",
    "email/search.js",
    "games/asteroids.html",
    "games/checkers.html",
    "games/chess.html",
    "games/g2048.html",
    "games/icons/icon-192.png",
    "games/icons/icon-512.png",
    "games/index.html",
    "games/invaders.html",
    "games/manifest.json",
    "games/mines.html",
    "games/solitaire.html",
    "games/sudoku.html",
    "games/tetris.html",
    "habits/habits.js",
    "habits/icons/icon-192.png",
    "habits/icons/icon-512.png",
    "habits/index.html",
    "habits/manifest.json",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/logo-lines.svg",
    "image/image.css",
    "image/image.js",
    "image/index.html",
    "index.html",
    "login.html",
    "manifest.json",
    "movies/index.html",
    "music/index.html",
    "photos/index.html",
    "planner/icons/icon-192.png",
    "planner/icons/icon-512.png",
    "planner/index.html",
    "planner/manifest.json",
    "share-target/index.html",
    "shared/app.css",
    "shared/basemap.js",
    "shared/browser.js",
    "shared/crypt.js",
    "shared/gum-api.js",
    "shared/i18n.js",
    "shared/i18n/de.json",
    "shared/i18n/en.json",
    "shared/i18n/es.json",
    "shared/i18n/fr.json",
    "shared/i18n/pt.json",
    "shared/ical.js",
    "shared/locker.js",
    "shared/lockers/clock.js",
    "shared/lockers/culture-settings.js",
    "shared/lockers/culture.js",
    "shared/lockers/life.js",
    "shared/lockers/matrix.js",
    "shared/lockers/science.js",
    "shared/media.js",
    "shared/menubar.js",
    "shared/office.js",
    "shared/photo.js",
    "shared/store.js",
    "shared/theme.css",
    "shared/theme.js",
    "shared/tz-geo.json",
    "shared/ui.js",
    "shared/vcard.js",
    "split/icons/icon-192.png",
    "split/icons/icon-512.png",
    "split/index.html",
    "split/manifest.json",
    "split/money.js",
    "tasks/icons/icon-192.png",
    "tasks/icons/icon-512.png",
    "tasks/index.html",
    "tasks/manifest.json",
    "text/index.html",
    "trips/actions.js",
    "trips/converter.js",
    "trips/currency-sheet.js",
    "trips/currency.js",
    "trips/discover.js",
    "trips/drag.js",
    "trips/fields.js",
    "trips/file-picker.js",
    "trips/helpers.js",
    "trips/icons/icon-192.png",
    "trips/icons/icon-512.png",
    "trips/index.html",
    "trips/init.js",
    "trips/intro.js",
    "trips/journey.js",
    "trips/location.js",
    "trips/manifest.json",
    "trips/map.js",
    "trips/my-location.js",
    "trips/pdf.js",
    "trips/persistence.js",
    "trips/public.html",
    "trips/render.js",
    "trips/route.js",
    "trips/sheets.js",
    "trips/state.js",
    "trips/trips.css",
    "write/docx-patch.js",
    "write/find.js",
    "write/icons/icon-192.png",
    "write/icons/icon-512.png",
    "write/icons/logo.svg",
    "write/index.html",
    "write/manifest.json",
    "write/proofing-overlay.js",
    "write/proofing-worker.js",
    "write/proofing.js",
    "write/quirks.js",
    "write/toolbar.js",
    "write/write.js"
];

var PRECACHE_REST = [
    "calendar/lib/fullcalendar-core_v6.1.21.min.js",
    "calendar/lib/fullcalendar-daygrid_v6.1.21.min.js",
    "calendar/lib/fullcalendar-interaction_v6.1.21.min.js",
    "calendar/lib/fullcalendar-list_v6.1.21.min.js",
    "calendar/lib/fullcalendar-locale-de_v6.1.21.min.js",
    "calendar/lib/fullcalendar-locale-es_v6.1.21.min.js",
    "calendar/lib/fullcalendar-locale-fr_v6.1.21.min.js",
    "calendar/lib/fullcalendar-locale-pt_v6.1.21.min.js",
    "calendar/lib/fullcalendar-timegrid_v6.1.21.min.js",
    "shared/lib/ical_v2.2.1.esm.min.js",
    "shared/lib/luxon_v3.7.2.min.js",
    "shared/lib/rrule_v2.8.1.min.js",
    "trips/lib/leaflet_v1.9.4/images/layers-2x.png",
    "trips/lib/leaflet_v1.9.4/images/layers.png",
    "trips/lib/leaflet_v1.9.4/images/marker-icon-2x.png",
    "trips/lib/leaflet_v1.9.4/images/marker-icon.png",
    "trips/lib/leaflet_v1.9.4/images/marker-shadow.png",
    "trips/lib/leaflet_v1.9.4/leaflet.css",
    "trips/lib/leaflet_v1.9.4/leaflet.js",
    "trips/lib/maplibre-gl-leaflet_v0.1.4/LICENSE.txt",
    "trips/lib/maplibre-gl-leaflet_v0.1.4/leaflet-maplibre-gl.js",
    "trips/lib/maplibre-gl_v5.24.0/LICENSE.txt",
    "trips/lib/maplibre-gl_v5.24.0/maplibre-gl.css",
    "trips/lib/maplibre-gl_v5.24.0/maplibre-gl.js",
    "write/lib/docx-editor/docx-editor_v2.21.0.css",
    "write/lib/docx-editor/docx-editor_v2.21.0.min.js",
    "write/lib/docx-editor/harfbuzz_v2.21.0.wasm",
    "write/lib/proofing/de.aff",
    "write/lib/proofing/de.dic",
    "write/lib/proofing/en.aff",
    "write/lib/proofing/en.dic",
    "write/lib/proofing/es.aff",
    "write/lib/proofing/es.dic",
    "write/lib/proofing/fr.aff",
    "write/lib/proofing/fr.dic",
    "write/lib/proofing/pt.aff",
    "write/lib/proofing/pt.dic",
    "write/lib/proofing/typo.js"
];
/* @end */

var CACHE_NAME = CACHE_VERSION;
var SCOPE_PATH = new URL( self.registration.scope ).pathname;   // e.g. /nayive/

// pushNotice(): a notification's options, shared with chat/guest-sw.js.
importScripts( "chat/push-notice.js" );

// Trips keeps only the ACTIVE trip's PDFs here, managed from the page (not this
// SW). Kept across SW updates - never precached, never version-scoped.
var TRIP_DOCS = "nayive-trips-docs";

// Web Share Target hand-off: a POST of shared images (from the phone's gallery
// "Share" sheet) can't reach a page directly, so this SW catches it, stashes
// the files here, and redirects to apps/share-target/ which reads them back and
// uploads them. Kept across SW updates like TRIP_DOCS.
var SHARE_INBOX = "nayive-share-inbox";

//----------------------------------------------------------------------------//
// PRECACHE - fetch a list of assets into CACHE_NAME, skipping anything that does
// not come back as a clean 200 (an expired session would answer with a redirect
// / login page and poison the cache; a not-yet-deployed asset just gets retried
// at runtime). "no-cache" (not "no-store") lets a 304 short-circuit the body
// when the file is unchanged from a previous version's cache.
//
// Anything already in CACHE_NAME is skipped: carryOverImmutable() (below)
// copies the never-changing files straight out of the previous version's
// cache first, so a deploy does not re-download ~10 MB of vendored libraries
// and dictionaries that did not change.

async function precacheList( rels )
{
    var cache = await caches.open( CACHE_NAME );

    await Promise.all( rels.map( async function ( rel )
    {
        var url = new URL( rel, self.registration.scope ).toString();

        if( await cache.match( url ) ) return;     // carried over, or warmed already

        try
        {
            var res = await fetch( url, { cache: "no-cache", credentials: "same-origin" } );

            if( res.ok && res.type === "basic" && ! res.redirected )
                await cache.put( url, res.clone() );
        }
        catch ( e ) { /* leave it out; assetStrategy will fetch it later */ }
    } ) );
}

// Stricter than the server's Cache-Control rule on purpose: only a path with
// a version in it (luxon_v3.7.2.min.js, trips/lib/leaflet_v1.9.4/...,
// write/lib/docx-editor/docx-editor_v<ver>.min.js) is copied over - a change
// there means a new name, so the 2.5 MB editor bundle is carried cache-to-cache
// instead of being re-fetched on every install. Everything else - an
// unversioned lib file (the proofing dictionaries), an icon redrawn under the
// same name - is re-validated with the server on every install (a 304 =
// headers only), so an in-place change is picked up.
function isImmutable( rel )
{
    return rel.split( "/" ).some( function ( seg ) { return /_v\d/.test( seg ); } );
}

// On install, before anything is fetched: copy every immutable precache entry
// the previous version's cache still holds into the new cache. Cache-to-cache,
// no network. Runs while the old cache is still there (activate deletes it).
async function carryOverImmutable()
{
    var keys  = await caches.keys();
    var olds  = keys.filter( function ( k )
    {
        return k !== CACHE_NAME && k !== TRIP_DOCS && k !== SHARE_INBOX &&
               ( k.indexOf( "nayive-" ) === 0 || k.indexOf( "nube-" ) === 0 );
    } );
    if( ! olds.length ) return;

    var cache = await caches.open( CACHE_NAME );
    var rels  = PRECACHE_SHELL.concat( PRECACHE_REST ).filter( isImmutable );

    for( var i = 0; i < olds.length; i++ )
    {
        var old = await caches.open( olds[ i ] );
        await Promise.all( rels.map( async function ( rel )
        {
            var url = new URL( rel, self.registration.scope ).toString();
            if( await cache.match( url ) ) return;
            var hit = await old.match( url );
            if( hit ) await cache.put( url, hit );
        } ) );
    }
}

// A deploy seen on a weak signal: whatever of the shell did not come down is
// copied from the previous version's cache, still there during install (the
// activate below deletes it) - an app with an old file still opens offline,
// one with no file does not (Trips abroad). The copy is marked STALE_HDR, and
// refreshStale() fetches it again at the first chance, so an old file is not
// served cache-first online until the next deploy.
var STALE_HDR = "X-Nayive-Stale";

async function fillShellGaps()
{
    var keys = await caches.keys();
    var olds = keys.filter( function ( k )
    {
        return k !== CACHE_NAME && k !== TRIP_DOCS && k !== SHARE_INBOX &&
               ( k.indexOf( "nayive-" ) === 0 || k.indexOf( "nube-" ) === 0 );
    } );
    if( ! olds.length ) return;

    var cache = await caches.open( CACHE_NAME );

    await Promise.all( PRECACHE_SHELL.map( async function ( rel )
    {
        var url = new URL( rel, self.registration.scope ).toString();
        if( await cache.match( url ) ) return;

        for( var i = 0; i < olds.length; i++ )
        {
            var hit = await ( await caches.open( olds[ i ] ) ).match( url );
            if( ! hit ) continue;
            var h = new Headers( hit.headers );
            h.set( STALE_HDR, "1" );
            await cache.put( url, new Response( await hit.blob(),
                                                { status: hit.status, statusText: hit.statusText, headers: h } ) );
            return;
        }
    } ) );
}

async function refreshStale()
{
    var cache = await caches.open( CACHE_NAME );

    await Promise.all( PRECACHE_SHELL.map( async function ( rel )
    {
        var url = new URL( rel, self.registration.scope ).toString();
        var hit = await cache.match( url );
        if( ! hit || ! hit.headers.has( STALE_HDR ) ) return;

        try
        {
            var res = await fetch( url, { cache: "no-cache", credentials: "same-origin" } );
            if( res.ok && res.type === "basic" && ! res.redirected ) await cache.put( url, res );
        }
        catch ( e ) { /* still no signal: the old copy stays until the next try */ }
    } ) );
}

// The heavy libs are warmed once, lazily, off the first fetch the SW handles -
// by then the page that triggered the update already has its shell and is
// running, so this no longer competes for its first connections. The stale
// shell copies (above) get their second chance here too.
var restWarmed = false;
function warmRestOnce()
{
    if( restWarmed ) return;
    restWarmed = true;
    precacheList( PRECACHE_REST );
    refreshStale().catch( function () {} );
}

//----------------------------------------------------------------------------//
// INSTALL - only the shell blocks activation; it is small and it is what a cold
// page needs to paint.

self.addEventListener( "install", function ( event )
{
    event.waitUntil( carryOverImmutable()
        .catch( function () {} )
        .then( function () { return precacheList( PRECACHE_SHELL ); } )
        .then( function () { return fillShellGaps().catch( function () {} ); } )
        .then( function () { self.skipWaiting(); } ) );
} );

//----------------------------------------------------------------------------//
// ACTIVATE - drop old versions of our cache, take control of open pages.

self.addEventListener( "activate", function ( event )
{
    event.waitUntil( ( async function ()
    {
        var keys = await caches.keys();

        await Promise.all( keys.map( function ( k )
        {
            if( k !== CACHE_NAME && k !== TRIP_DOCS && k !== SHARE_INBOX && ( k.indexOf( "nayive-" ) === 0 || k.indexOf( "nube-" ) === 0 ) )
                return caches.delete( k );
        } ) );

        await self.clients.claim();
    } )() );
} );

//----------------------------------------------------------------------------//
// FETCH

self.addEventListener( "fetch", function ( event )
{
    warmRestOnce();

    var req = event.request;

    // Web Share Target: a POST of shared files to apps/share-target/. Stash the
    // images, then redirect (303 -> GET) to the page that uploads them.
    if( req.method === "POST" &&
        new URL( req.url ).pathname === SCOPE_PATH + "share-target/" )
    {
        event.respondWith( handleShare( req ) );
        return;
    }

    if( req.method !== "GET" ) return;

    var url = new URL( req.url );

    if( url.origin !== self.location.origin ) return;          // cross-origin: leave alone

    // A trip's documents are /api/files?file=... URLs (trips/helpers.js
    // docHref), kept per exact URL in TRIP_DOCS for the active trip: the
    // network first, that copy only when it fails (tripDocOrNetwork). Not a Range
    // request (music, a film): those never go through here. No other method
    // either (above): a PUT and its If-Match go straight to the server.
    if( url.pathname === "/api/files" && url.searchParams.has( "file" ) &&
        ! req.headers.has( "range" ) )
    {
        event.respondWith( tripDocOrNetwork( req ) );
        return;
    }

    // The data API and every auth endpoint stay on the network, always.
    if( url.pathname.indexOf( "/api/" ) === 0 ) return;

    if( url.pathname.indexOf( SCOPE_PATH ) !== 0 ) return;     // outside our scope

    // Trips documents: answered from the trips-managed cache (active trip only).
    if( url.pathname.indexOf( SCOPE_PATH + "trips/" ) === 0 && /\.pdf$/i.test( url.pathname ) )
        event.respondWith( tripDocStrategy( req ) );
    // ...and a page's own fetch() of an .html file: Games loads its nine games that
    // way. Each is precached like every page: a deploy's new CACHE_VERSION brings an edit.
    else if( req.mode === "navigate" || req.destination === "document" || /\.html$/i.test( url.pathname ) )
        event.respondWith( htmlStrategy( req, url ) );
    else
        event.respondWith( assetStrategy( req ) );
} );

// Web Share Target POST -> stash images in SHARE_INBOX, redirect to the page
// (or, for a shared link/text, to Chat).
async function handleShare( req )
{
    var base = new URL( "share-target/", self.registration.scope ).toString();

    try
    {
        var form  = await req.formData();
        var files = form.getAll( "photos" ).filter( function ( f )
        {
            return f && typeof f === "object" && f.size > 0 &&
                   ( /^image\//.test( f.type ) || /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i.test( f.name || "" ) );
        } );

        // No photos, only a link or text (YouTube's "Share"): Chat opens with
        // it in the box, to pick who gets it.
        if( ! files.length )
        {
            var text  = String( form.get( "text" )  || "" ).trim();
            var link  = String( form.get( "url" )   || "" ).trim();
            var title = String( form.get( "title" ) || "" ).trim();
            if( link && text.indexOf( link ) < 0 ) text = text ? text + "\n" + link : link;
            if( ! text ) text = title;
            if( text )
                return Response.redirect( new URL( "chat/?text=" + encodeURIComponent( text ),
                                                   self.registration.scope ).toString(), 303 );
        }

        var cache = await caches.open( SHARE_INBOX );

        // Photos kept after a failed upload (share-target marks them `kept`)
        // stay, and the new ones go AFTER them. Anything else left from an
        // earlier share - a page closed without Upload or Cancel - is cleared.
        var names = [];
        var start = 0;
        try
        {
            var prev = await cache.match( base + "inbox/manifest.json" );
            prev = prev ? await prev.json() : null;
            if( prev && prev.kept )
            {
                start = prev.count || 0;
                names = ( prev.names || [] ).slice( 0, start );
            }
        }
        catch ( e ) { start = 0; names = []; }

        if( ! start )
        {
            var old = await cache.keys();
            await Promise.all( old.map( function ( k ) { return cache.delete( k ); } ) );
        }

        while( names.length < start ) names.push( "" );

        for( var j = 0; j < files.length; j++ )
        {
            var f = files[ j ];
            var i = start + j;
            names.push( f.name || ( "foto-" + ( j + 1 ) + ".jpg" ) );
            await cache.put(
                new Request( base + "inbox/" + i ),
                new Response( f, { headers: {
                    "Content-Type":  f.type || "application/octet-stream",
                    "X-File-Name":   encodeURIComponent( f.name || ( "foto-" + ( j + 1 ) + ".jpg" ) )
                } } )
            );
        }

        await cache.put(
            new Request( base + "inbox/manifest.json" ),
            new Response( JSON.stringify( { count: start + files.length, names: names, at: Date.now() } ),
                          { headers: { "Content-Type": "application/json" } } )
        );

        return Response.redirect( base + "?n=" + ( start + files.length ), 303 );
    }
    catch ( e )
    {
        return Response.redirect( base + "?n=0", 303 );
    }
}

// The service worker has no localStorage, so it cannot know the language the
// user picked in the launcher. It reads the request's Accept-Language instead
// and looks the key up in the dictionary it already precached (falling back to
// English, then to the key). This is the only text the worker itself produces.
async function swText( req, key )
{
    var want = [ "en" ];
    try
    {
        var al = ( req && req.headers && req.headers.get( "Accept-Language" ) ) || "";
        want = al.split( "," )
                 .map( function ( p ){ return p.split( ";" )[ 0 ].trim().slice( 0, 2 ).toLowerCase(); } )
                 .filter( Boolean )
                 .concat( [ "en" ] );
    }
    catch ( e ) {}

    var cache = await caches.open( CACHE_NAME );
    for( var i = 0; i < want.length; i++ )
    {
        try
        {
            var r = await cache.match( new URL( "shared/i18n/" + want[ i ] + ".json",
                                                self.registration.scope ).toString() );
            if( ! r ) continue;
            var d = await r.json();
            if( d && d[ key ] ) return d[ key ];
        }
        catch ( e ) {}
    }
    return key;
}

// A file GET: the network FIRST - the request as the page made it
// (If-None-Match and all) and the answer as the server gave it (ETag and
// all). The active trip's copy in TRIP_DOCS used to answer every app first,
// never refreshed, so an editor showed an old copy as the server's and the
// Image editor saved over the newer file (data-safety B6). Now that copy
// answers only when the network fails: no connection, a gateway's 5xx, or no
// answer within TRIP_WAIT_MS (an airport's Wi-Fi - the boarding pass must
// open at the gate). It says what it is (X-Nayive-Copy: offline):
// shared/store.js reads it as "offline", not as the file's current version.
// Not a trip document: the network alone, and a failure stays a failure (a
// rejected fetch), which is what shared/store.js reads as "offline" too.
var TRIP_WAIT_MS = 4000;

async function tripDocOrNetwork( req )
{
    var net = fetch( req );
    var hit = null;
    try { hit = await ( await caches.open( TRIP_DOCS ) ).match( req ); }
    catch ( e ) {}
    if( ! hit ) return net;

    var timer = null;
    var late  = new Promise( function ( r ) { timer = setTimeout( function () { r( null ); }, TRIP_WAIT_MS ); } );
    try
    {
        var res = await Promise.race( [ net, late ] );
        if( res && res.status < 500 ) return res;
    }
    catch ( e ) {}
    finally { clearTimeout( timer ); }
    net.catch( function () {} );   // an answer that comes too late is not waited for

    var headers = new Headers( hit.headers );
    headers.set( "X-Nayive-Copy", "offline" );
    return new Response( hit.body, { status: hit.status, statusText: hit.statusText, headers: headers } );
}

// Trips PDFs - cache-first against the trips-managed store; never populated here
// (trips decides which trip's docs are worth the phone space). Matched by the
// whole URL: the documents differ only in their ?file=.
async function tripDocStrategy( req )
{
    var cache  = await caches.open( TRIP_DOCS );
    var cached = await cache.match( req );

    if( cached ) return cached;

    try
    {
        return await fetch( req );
    }
    catch ( e )
    {
        return new Response( await swText( req, "sw.docOffline" ),
                             { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } } );
    }
}

// HTML - serve this version's cached copy when present; otherwise go to the
// network (and keep what it sends) and fall back to the launcher.
async function htmlStrategy( req, url )
{
    var cache = await caches.open( CACHE_NAME );

    // A navigation to ".../tasks/" resolves to ".../tasks/index.html" on the
    // server (welcome file); match that key too. Stored without the query:
    // the page is the same for every ?file=, ?sel=, ?c=, so one copy is kept.
    var key = url.pathname.charAt( url.pathname.length - 1 ) === "/"
              ? new URL( "index.html", url.href ).toString()
              : url.origin + url.pathname;

    // A cached page is served as it is, never re-saved from the network in
    // the background: that stored a NEW page in this OLD version's cache,
    // beside its old shared/*.js (calls such as NayiveUI.pwEye then threw).
    // Every page is precached, so a deploy brings the new one with the new
    // worker's cache.
    var cached  = await cache.match( key, { ignoreSearch: true } );
    if( cached ) return cached;

    var res = await fetch( req ).then( function ( res )
    {
        if( res && res.ok && res.type === "basic" && ! res.redirected )
            cache.put( key, res.clone() );

        return res;
    } ).catch( function () { return null; } );

    if( res ) return res;

    // Offline and never opened here: the launcher instead - by a redirect to
    // the scope's root, so its relative shared/* links resolve (the
    // launcher's HTML served under share-target/ was a blank page).
    var root = new URL( "index.html", self.registration.scope ).toString();
    if( url.pathname !== SCOPE_PATH && url.pathname !== SCOPE_PATH + "index.html" &&
        req.mode === "navigate" && await cache.match( root ) )
        return Response.redirect( self.registration.scope, 302 );

    return ( await cache.match( root ) ) ||
           new Response( await swText( req, "sw.appOffline" ),
                         { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } } );
}

// Versioned assets (lib/*, icons/*, shared/*) - cache-first; their names carry
// the version so a given name never changes content.
async function assetStrategy( req )
{
    var cache  = await caches.open( CACHE_NAME );
    var cached = await cache.match( req, { ignoreSearch: true } );

    if( cached ) return cached;

    try
    {
        var res = await fetch( req );

        if( res && res.ok && res.type === "basic" && ! res.redirected )
            cache.put( req, res.clone() );

        return res;
    }
    catch ( e )
    {
        return cached || new Response( "", { status: 504 } );
    }
}

/* ==========================================================================
   NATIVE OS NOTIFICATIONS  (Web Push)

   The server encrypts a small JSON message and hands it to the push service
   (Google / Apple / Mozilla); the device wakes this worker even with every
   Nayive window closed, and showNotification puts it in the OS notification
   centre. See server/go/webpush.go + reminders.go for the sending half.

   Everything here lives BELOW the @generated blocks on purpose -
   tools/build-precache rewrites those wholesale and would eat it.
   ========================================================================== */

self.addEventListener( "push", function ( event )
{
    event.waitUntil( showPush( event ) );
} );

async function showPush( event )
{
    var d = {};

    try { d = event.data ? event.data.json() : {}; }
    catch ( e ) { d = {}; }

    // A push MUST always produce a visible notification. iOS revokes the
    // site's permission after a few "silent" ones - userVisibleOnly:true is a
    // promise we made to the browser, not a hint. So even a corrupt payload
    // shows something rather than returning quietly.
    var title = d.title || "Nayive";
    var body  = d.body  || await swText( null, "push.eventTitle" ) || "";
    var icon  = new URL( "icons/icon-192.png", self.registration.scope ).toString();

    // A Chat call's ringing, "quiet" and "missed" rules live in
    // chat/push-notice.js, shared with chat/guest-sw.js.
    var opts = pushNotice( d, { body: body, icon: icon, tag: "nayive-event", url: SCOPE_PATH } );

    // A chat message: tell every open Nayive page, so the one on screen puts
    // its red Chat dot on at once (shared/ui.js, CHAT DOT). New mail the same
    // way: the launcher's eMail count and an open eMail follow at once.
    var news = String( d.tag || "" ).indexOf( "chat-" ) === 0 ? { chat: "new" }
             : String( d.tag || "" ).indexOf( "mail-" ) === 0 ? { mail: "new" } : null;
    if( news )
    {
        var wins = await clients.matchAll( { type: "window", includeUncontrolled: true } );
        for( var w = 0; w < wins.length; w++ ) wins[ w ].postMessage( news );
    }

    return self.registration.showNotification( title, opts );
}

self.addEventListener( "notificationclick", function ( event )
{
    event.notification.close();
    event.waitUntil( openTarget( ( event.notification.data || {} ).url || SCOPE_PATH ) );
} );

async function openTarget( url )
{
    var target = new URL( url, self.registration.scope ).toString();

    // includeUncontrolled matters: an installed PWA window may not be
    // controlled by THIS worker generation, and we still want to focus it
    // instead of opening a second copy of the app.
    var all = await clients.matchAll( { type: "window", includeUncontrolled: true } );

    // Frames are clients too (Planner's panes, the desktop's windows): only a
    // whole browser window may be focused or navigated.
    all = all.filter( function ( c ) { return c.frameType !== "nested"; } );

    // The desktop (desktop/index.html) shows every app in a window of its own:
    // it opens the page there - an open Chat is told which chat to show.
    for( var d = 0; d < all.length; d++ )
    {
        if( new URL( all[ d ].url ).pathname.indexOf( SCOPE_PATH + "desktop/" ) === 0 )
        {
            all[ d ].postMessage( { desktopOpen: target } );
            return all[ d ].focus();
        }
    }

    for( var i = 0; i < all.length; i++ )
    {
        if( all[ i ].url === target )   return all[ i ].focus();
    }

    // The Chat page is never navigated away: it may be in a call. A chat
    // notification tells it which chat to show (chat/chat.js); any other one
    // uses another window, or a new one. Nor is an open document (Write,
    // Calc, Text): it would be left mid-edit.
    var chat = SCOPE_PATH + "chat/";
    var isChat = function ( u ) { return new URL( u ).pathname.indexOf( chat ) === 0; };
    var isEditor = function ( u )
    {
        var p = new URL( u ).pathname;
        return [ "write/", "calc/", "text/" ].some( function ( a ) { return p.indexOf( SCOPE_PATH + a ) === 0; } );
    };
    if( isChat( target ) )
    {
        for( var k = 0; k < all.length; k++ )
        {
            if( isChat( all[ k ].url ) )
            {
                all[ k ].postMessage( { open: target } );
                return all[ k ].focus();
            }
        }
    }

    for( var j = 0; j < all.length; j++ )
    {
        if( all[ j ].url.indexOf( SCOPE_PATH ) !== -1 && ! isChat( all[ j ].url ) && ! isEditor( all[ j ].url ) &&
            "navigate" in all[ j ] )
        {
            // A tab this worker does not control (opened with Shift+Reload)
            // refuses navigate(): try the next one, else a new window.
            try { await all[ j ].navigate( target ); }
            catch( e ) { continue; }
            return all[ j ].focus();
        }
    }

    return clients.openWindow( target );
}

/* Browsers rotate a subscription on their own schedule. Without this the
   device simply goes quiet one day, with nothing in any log to explain it. */
self.addEventListener( "pushsubscriptionchange", function ( event )
{
    event.waitUntil( resubscribe( event ) );
} );

async function resubscribe( event )
{
    var old = event.oldSubscription;
    var key = old && old.options && old.options.applicationServerKey;

    if( ! key ) return;   // nothing to re-subscribe WITH; the launcher heals it on its next load

    try
    {
        var sub = await self.registration.pushManager.subscribe(
                        { userVisibleOnly: true, applicationServerKey: key } );

        // Best effort: the session cookie may already have expired, in which
        // case this 401s and the device stays silent until the user next opens
        // the launcher - which re-posts the subscription (healPush() there: a
        // new endpoint, or none left at all). The worker cannot know the
        // language picked in Nayive: the browser's is the best guess, and the
        // launcher's next load puts the right one.
        await fetch( "/api/push", {
            method:      "POST",
            credentials: "same-origin",
            headers:     { "Content-Type": "application/json" },
            // old_endpoint: the server moves that device's language and
            // label over to the new one (users.go RenewPushSub).
            body:        JSON.stringify( { subscription: sub.toJSON(),
                                           old_endpoint: ( old && old.endpoint ) || "",
                                           lang:  String( self.navigator.language || "" ).slice( 0, 2 ).toLowerCase(),
                                           label: self.navigator.platform || "",
                                           tz:    Intl.DateTimeFormat().resolvedOptions().timeZone || "" } )
        } );

        if( old && old.endpoint )
            await fetch( "/api/push?endpoint=" + encodeURIComponent( old.endpoint ),
                         { method: "DELETE", credentials: "same-origin" } );
    }
    catch ( e ) {}
}
