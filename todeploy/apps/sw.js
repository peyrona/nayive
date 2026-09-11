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
 *               (vendored lib/, dictionaries, the SuperDoc bundle) is warmed in
 *               the background after activation, so a post-deploy update never
 *               starves the page that triggered it.
 *   - fetch   : HTML          -> stale-while-revalidate (instant, self-updating)
 *               versioned libs -> cache-first (filenames carry the version)
 *               trips/**.pdf    -> served from the "nayive-trips-docs" cache the trips
 *                                 page fills with just the active trip's files
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
var CACHE_VERSION = "nayive-b6fad8afaf6b";
/* @end */

/* @generated:precache */
var PRECACHE_SHELL = [
    "calendar/icons/icon-192.png",
    "calendar/icons/icon-512.png",
    "calendar/index.html",
    "calendar/manifest.json",
    "contact/icons/icon-192.png",
    "contact/icons/icon-512.png",
    "contact/index.html",
    "contact/manifest.json",
    "games/icons/icon-192.png",
    "games/icons/icon-512.png",
    "games/index.html",
    "games/manifest.json",
    "habits/habits.js",
    "habits/icons/icon-192.png",
    "habits/icons/icon-512.png",
    "habits/index.html",
    "habits/manifest.json",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "index.html",
    "login.html",
    "manifest.json",
    "planner/icons/icon-192.png",
    "planner/icons/icon-512.png",
    "planner/index.html",
    "planner/manifest.json",
    "shared/app.css",
    "shared/gum-api.js",
    "shared/i18n.js",
    "shared/i18n/de.json",
    "shared/i18n/en.json",
    "shared/i18n/es.json",
    "shared/i18n/fr.json",
    "shared/i18n/it.json",
    "shared/i18n/la.json",
    "shared/i18n/pt.json",
    "shared/ical.js",
    "shared/media.js",
    "shared/menubar.js",
    "shared/office.js",
    "shared/photo.js",
    "shared/store.js",
    "shared/theme.css",
    "shared/theme.js",
    "shared/ui.js",
    "split/icons/icon-192.png",
    "split/icons/icon-512.png",
    "split/index.html",
    "split/manifest.json",
    "split/money.js",
    "tasks/icons/icon-192.png",
    "tasks/icons/icon-512.png",
    "tasks/index.html",
    "tasks/manifest.json",
    "trips/icons/icon-192.png",
    "trips/icons/icon-512.png",
    "trips/index.html",
    "trips/manifest.json",
    "write/icons/icon-192.png",
    "write/icons/icon-512.png",
    "write/icons/logo.svg",
    "write/index.html",
    "write/manifest.json",
    "write/proofing-worker.js",
    "write/proofing.js",
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
    "calendar/lib/fullcalendar-locale-it_v6.1.21.min.js",
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
    "write/lib/proofing/de.aff",
    "write/lib/proofing/de.dic",
    "write/lib/proofing/en.aff",
    "write/lib/proofing/en.dic",
    "write/lib/proofing/es.aff",
    "write/lib/proofing/es.dic",
    "write/lib/proofing/fr.aff",
    "write/lib/proofing/fr.dic",
    "write/lib/proofing/it.aff",
    "write/lib/proofing/it.dic",
    "write/lib/proofing/pt.aff",
    "write/lib/proofing/pt.dic",
    "write/lib/proofing/typo.js",
    "write/lib/superdoc/@superdoc/docx-engine/style.css",
    "write/lib/superdoc/assets/browser-worker-entry-Jt3Z1Jtz.js",
    "write/lib/superdoc/assets/review-index-worker-entry--TnQQT8x.js",
    "write/lib/superdoc/engine.css",
    "write/lib/superdoc/superdoc.css",
    "write/lib/superdoc/superdoc.min.js"
];
/* @end */

var CACHE_NAME = CACHE_VERSION;
var SCOPE_PATH = new URL( self.registration.scope ).pathname;   // e.g. /nayive/

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
// a version in it (luxon_v3.7.2.min.js, trips/lib/leaflet_v1.9.4/...) or an
// icon is copied over - a change there means a new name. An unversioned lib
// file (write/lib/superdoc/superdoc.min.js, the proofing dictionaries) is
// still re-validated with the server on every install (a 304 = headers only),
// so an in-place upgrade of one of those is picked up as before.
function isImmutable( rel )
{
    var parts = rel.split( "/" );
    return parts.some( function ( seg ) { return /_v\d/.test( seg ); } ) || parts.indexOf( "icons" ) !== -1;
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

// The heavy libs are warmed once, lazily, off the first fetch the SW handles -
// by then the page that triggered the update already has its shell and is
// running, so this no longer competes for its first connections.
var restWarmed = false;
function warmRestOnce()
{
    if( restWarmed ) return;
    restWarmed = true;
    precacheList( PRECACHE_REST );
}

//----------------------------------------------------------------------------//
// INSTALL - only the shell blocks activation; it is small and it is what a cold
// page needs to paint.

self.addEventListener( "install", function ( event )
{
    event.waitUntil( carryOverImmutable()
        .catch( function () {} )
        .then( function () { return precacheList( PRECACHE_SHELL ); } )
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

    // The data API and every auth endpoint stay on the network, always.
    if( url.pathname.indexOf( "/api/" ) === 0 ) return;

    if( url.pathname.indexOf( SCOPE_PATH ) !== 0 ) return;     // outside our scope

    // Trips documents: answered from the trips-managed cache (active trip only).
    if( url.pathname.indexOf( SCOPE_PATH + "trips/" ) === 0 && /\.pdf$/i.test( url.pathname ) )
        event.respondWith( tripDocStrategy( req ) );
    else if( req.mode === "navigate" || req.destination === "document" )
        event.respondWith( htmlStrategy( req, url ) );
    else
        event.respondWith( assetStrategy( req ) );
} );

// Web Share Target POST -> stash images in SHARE_INBOX, redirect to the page.
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

        var cache = await caches.open( SHARE_INBOX );

        // clear anything left from a previous share
        var old = await cache.keys();
        await Promise.all( old.map( function ( k ) { return cache.delete( k ); } ) );

        var names = [];
        for( var i = 0; i < files.length; i++ )
        {
            var f = files[ i ];
            names.push( f.name || ( "foto-" + ( i + 1 ) + ".jpg" ) );
            await cache.put(
                new Request( base + "inbox/" + i ),
                new Response( f, { headers: {
                    "Content-Type":  f.type || "application/octet-stream",
                    "X-File-Name":   encodeURIComponent( f.name || ( "foto-" + ( i + 1 ) + ".jpg" ) )
                } } )
            );
        }

        await cache.put(
            new Request( base + "inbox/manifest.json" ),
            new Response( JSON.stringify( { count: files.length, names: names, at: Date.now() } ),
                          { headers: { "Content-Type": "application/json" } } )
        );

        return Response.redirect( base + "?n=" + files.length, 303 );
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

// Trips PDFs - cache-first against the trips-managed store; never populated here
// (trips decides which trip's docs are worth the phone space).
async function tripDocStrategy( req )
{
    var cache  = await caches.open( TRIP_DOCS );
    var cached = await cache.match( req, { ignoreSearch: true } );

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

// HTML - serve cache immediately when present and refresh it in the background;
// otherwise go to the network and fall back to any cached copy.
async function htmlStrategy( req, url )
{
    var cache = await caches.open( CACHE_NAME );

    // A navigation to ".../tasks/" resolves to ".../tasks/index.html" on the
    // server (welcome file); match that key too.
    var key = url.pathname.charAt( url.pathname.length - 1 ) === "/"
              ? new URL( "index.html", url.href ).toString()
              : req;

    var cached  = await cache.match( key, { ignoreSearch: true } );
    var network = fetch( req ).then( function ( res )
    {
        if( res && res.ok && res.type === "basic" && ! res.redirected )
            cache.put( key, res.clone() );

        return res;
    } ).catch( function () { return null; } );

    if( cached ) return cached;

    var res = await network;

    if( res ) return res;

    return ( await cache.match( new URL( "index.html", self.registration.scope ).toString() ) ) ||
           new Response( "Offline - open this app once with a connection first.",
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

    return self.registration.showNotification( title, {
        body:     body,
        icon:     icon,
        badge:    icon,
        tag:      d.tag || "nayive-event",   // same event re-sent -> replace, don't stack
        renotify: true,                      // ...but still buzz for the replacement
        data:     { url: d.url || SCOPE_PATH }
    } );
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

    for( var i = 0; i < all.length; i++ )
    {
        if( all[ i ].url === target )   return all[ i ].focus();
    }

    for( var j = 0; j < all.length; j++ )
    {
        if( all[ j ].url.indexOf( SCOPE_PATH ) !== -1 && "navigate" in all[ j ] )
        {
            await all[ j ].navigate( target );
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

    if( ! key ) return;   // nothing to re-subscribe WITH; the page heals it on next open

    try
    {
        var sub = await self.registration.pushManager.subscribe(
                        { userVisibleOnly: true, applicationServerKey: key } );

        // Best effort: the session cookie may already have expired, in which
        // case this 401s and the device stays silent until the user next opens
        // the launcher - which re-posts the subscription. See loadPush().
        await fetch( "/api/push", {
            method:      "POST",
            credentials: "same-origin",
            headers:     { "Content-Type": "application/json" },
            body:        JSON.stringify( { subscription: sub.toJSON() } )
        } );

        if( old && old.endpoint )
            await fetch( "/api/push?endpoint=" + encodeURIComponent( old.endpoint ),
                         { method: "DELETE", credentials: "same-origin" } );
    }
    catch ( e ) {}
}
