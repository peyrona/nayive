/*
 * store.js - Offline-capable persistence for the Nayive single-page apps.
 *
 * The apps used to talk to the file API directly: GET/PUT
 * `/api/files?file=data/<file>`, with the in-memory model as the only
 * copy of the data. That makes them useless with no connection and, worse, a
 * failed load looked exactly like "empty file" so the next save wiped the real
 * server copy.
 *
 * This module puts a local layer in front of that API:
 *
 *   - read(path)   tries the network, falls back to a last-known-good copy kept
 *                  in IndexedDB. It NEVER reports a network failure as "empty";
 *                  only a real HTTP 404 from a reachable server is "empty".
 *   - write(path)  writes the local copy immediately (the cache is now the
 *                  source of truth), queues the PUT in an "outbox", and flushes
 *                  it when it can - now, on reconnect, on tab focus, or on a
 *                  short timer.
 *
 * Single user, one file per app: the outbox holds at most one pending write per
 * path and newer replaces older (last-write-wins). No conflict resolution - if
 * the same file is edited on another device while this one is offline, the
 * offline device wins on reconnect. A mtime guard is a possible follow-up.
 *
 * Auth: /api/files is authenticated by the nayive_session cookie only
 * (same-origin fetch sends it). A 401 while flushing surfaces as the "needs-auth"
 * state and the outbox entry is kept, so nothing is lost across a re-login. It
 * also raises the shared "tu sesión ha caducado" bar (NayiveUI.sessionExpired),
 * because a red dot alone never told the user what to do about it.
 *
 * Service workers / offline shells require a secure context, so offline only
 * actually happens over HTTPS or on http://localhost (which browsers treat as
 * secure). Elsewhere on plain HTTP this module still works, it just never gets
 * to serve from cache because the page always reaches the server.
 *
 * No dependencies. Load as a classic script before the app's module script:
 *     <script src="../shared/store.js"></script>
 * then in the app:
 *     const store = NayiveStore.createStore( { apiBase: origin + '/api/files' } );
 *
 * Bodies are UTF-8 text by default. Pass { binary: true } for a store whose
 * bodies are raw bytes (Uint8Array) instead - write() takes bytes, read()
 * returns bytes. Used by the Write app, whose files are .docx. Everything else
 * (outbox, flush, states, the 404-is-not-a-drop guarantee) is identical.
 *
 * ---------------------------------------------------------------------------
 * GZIP ON THE WAY UP  (2026-09-08)
 *
 * These apps hold one whole document per file, so changing one 200-byte event
 * re-uploads the entire 24 KB calendar.ics. The server has always gzipped its
 * RESPONSES; nothing compressed the REQUEST, because fetch() never does it for
 * you. netPut() now gzips the body itself and sets Content-Encoding: gzip -
 * measured 23410 -> 2455 bytes on a real 108-event calendar, ~9x.
 *
 * It is a transport detail and nothing else: the server inflates the body in
 * lib/handler.py _write_file() and stores exactly the same bytes on disk, so
 * calendar.ics stays a plain .ics the reminder service can read. A body that is
 * small, binary, or on a browser without CompressionStream just goes up raw -
 * see gzipBody().
 *
 * ORDERING RULE, and it matters: the new SERVER must be live before this file
 * reaches a browser. An old server does not know Content-Encoding on a request,
 * so it would store the compressed bytes verbatim AS the file - a corrupt
 * calendar.ics, not a failed save. The new server reads plain and gzipped alike,
 * so server-first is always safe. deploy.sh pushes apps/ BEFORE it restarts the
 * service, which leaves exactly that window open; restart first, or deploy when
 * nobody is saving.
 */
( function ()
{
    "use strict";

    var DB_NAME    = "nube-store";   // kept from the old name on purpose: renaming the IndexedDB would drop pending offline writes
    var DB_VERSION = 1;
    var DOCS       = "docs";      // last-known-good file bodies, keyPath "path"
    var OUTBOX     = "outbox";    // pending writes,             keyPath "path"

    var FLUSH_DEBOUNCE_MS = 1500;
    var GZIP_MIN          = 1400;   // same cutoff the server uses on the way down:
                                    // below ~one packet, compression is a net loss

    //------------------------------------------------------------------------//
    // TINY INDEXEDDB PROMISE WRAPPER
    //
    // Every call resolves even when IndexedDB is missing or blocked (private
    // mode, storage disabled): openDb() resolves to null and the helpers below
    // no-op, so the store falls back to plain online-only behaviour.

    function openDb()
    {
        return new Promise( function ( resolve )
        {
            var req;

            try
            {
                req = indexedDB.open( DB_NAME, DB_VERSION );
            }
            catch ( e )
            {
                resolve( null );
                return;
            }

            req.onupgradeneeded = function ()
            {
                var db = req.result;

                if( ! db.objectStoreNames.contains( DOCS ) )
                    db.createObjectStore( DOCS, { keyPath: "path" } );

                if( ! db.objectStoreNames.contains( OUTBOX ) )
                    db.createObjectStore( OUTBOX, { keyPath: "path" } );
            };

            req.onsuccess = function () { resolve( req.result ); };
            req.onerror   = function () { resolve( null ); };
            req.onblocked = function () { resolve( null ); };
        } );
    }

    function idbReq( request )
    {
        return new Promise( function ( resolve, reject )
        {
            request.onsuccess = function () { resolve( request.result ); };
            request.onerror   = function () { reject( request.error ); };
        } );
    }

    function idbGet( db, storeName, key )
    {
        if( ! db ) return Promise.resolve( undefined );

        try
        {
            return idbReq( db.transaction( storeName, "readonly" ).objectStore( storeName ).get( key ) );
        }
        catch ( e ) { return Promise.resolve( undefined ); }
    }

    function idbGetAll( db, storeName )
    {
        if( ! db ) return Promise.resolve( [] );

        try
        {
            return idbReq( db.transaction( storeName, "readonly" ).objectStore( storeName ).getAll() );
        }
        catch ( e ) { return Promise.resolve( [] ); }
    }

    function idbPut( db, storeName, record )
    {
        if( ! db ) return Promise.resolve();

        try
        {
            return idbReq( db.transaction( storeName, "readwrite" ).objectStore( storeName ).put( record ) );
        }
        catch ( e ) { return Promise.resolve(); }
    }

    function idbDelete( db, storeName, key )
    {
        if( ! db ) return Promise.resolve();

        try
        {
            return idbReq( db.transaction( storeName, "readwrite" ).objectStore( storeName ).delete( key ) );
        }
        catch ( e ) { return Promise.resolve(); }
    }

    //------------------------------------------------------------------------//
    // THE STORE

    function createStore( opts )
    {
        opts = opts || {};

        var api       = opts.apiBase || ( window.location.origin + "/api/files" );
        var binary    = !! opts.binary;   // body is raw bytes (Uint8Array), not text
        var listeners = [];
        var state     = "init";
        var flushTimer = null;
        var flushing   = false;

        var dbPromise = openDb();

        // Best-effort: ask the browser not to evict our cache. Harmless where
        // unsupported; on iOS this is what keeps an installed app's data past a
        // week of not opening it.
        if( navigator.storage && navigator.storage.persist )
        {
            try
            {
                navigator.storage.persisted().then( function ( already )
                {
                    if( ! already ) navigator.storage.persist();
                } );
            }
            catch ( e ) { /* ignore */ }
        }

        window.addEventListener( "online",  function () { flushAll(); } );
        window.addEventListener( "offline", function () { emit( "offline" ); } );
        document.addEventListener( "visibilitychange", function ()
        {
            if( document.visibilityState === "visible" ) flushAll();
        } );

        //--------------------------------------------------------------------//
        // STATE / LISTENERS
        //
        // States: init | loading | synced | saving | offline | pending | error | needs-auth
        //   loading     a GET is in flight (online) - data is being retrieved
        //   synced      server has the latest
        //   saving      a PUT is in flight (online)
        //   offline     no connection - edits are safe in the local cache
        //   pending     online but one or more queued writes have not gone through
        //   error       a write failed for a reason other than being offline
        //   needs-auth  the session expired - re-login needed, buffer kept

        function emit( s )
        {
            state = s;

            for( var i = 0; i < listeners.length; i++ )
            {
                try { listeners[ i ]( s ); }
                catch ( e ) { /* a listener throwing must not break the store */ }
            }
        }

        function onState( fn )
        {
            listeners.push( fn );
            return function off()
            {
                var i = listeners.indexOf( fn );
                if( i !== -1 ) listeners.splice( i, 1 );
            };
        }

        // Recompute a resting state from what is still queued. Exposed as
        // `resting()` for NayiveUI.bootWithStore, which calls it for an app that
        // opened without touching the store (a blank sheet, a new document) -
        // the plug would otherwise sit on its red "no state yet" resting class.
        async function settle()
        {
            var db      = await dbPromise;
            var pending = await idbGetAll( db, OUTBOX );

            if( pending.length === 0 ) emit( navigator.onLine ? "synced"  : "offline" );
            else                       emit( navigator.onLine ? "pending" : "offline" );
        }

        //--------------------------------------------------------------------//
        // NETWORK

        // Same retry shape as the apps' old fetchIt(): two retries, only for a
        // thrown "Failed to fetch" (a genuine connectivity drop), never for an
        // HTTP error status.
        // A 401 means the session is gone (idle timeout, or a server restart -
        // the session table is in RAM). Raise the shared bar so the user learns
        // why the red dot appeared. Only 401: the "needs-auth" state below also
        // covers 403 ("not yours / read-only"), which is not a session problem.
        function authLost( status )
        {
            if( status !== 401 ) return;
            if( window.NayiveUI && NayiveUI.sessionExpired ) NayiveUI.sessionExpired();
        }

        async function netFetch( url, options, retry )
        {
            retry = retry || 0;

            try
            {
                return await fetch( url, options );
            }
            catch ( err )
            {
                if( retry < 2 && String( err && err.message ).indexOf( "Failed to fetch" ) !== -1 )
                {
                    await new Promise( function ( r ) { setTimeout( r, 500 * Math.pow( 2, retry ) ); } );
                    return netFetch( url, options, retry + 1 );
                }

                throw err;
            }
        }

        async function netGet( path )
        {
            try
            {
                var r = await netFetch( api + "?file=" + encodeURIComponent( path ), { method: "GET" } );

                if( r.ok )
                {
                    var body  = binary ? new Uint8Array( await r.arrayBuffer() ) : await r.text();
                    var mtime = Date.parse( r.headers.get( "Last-Modified" ) ) || Date.now();

                    return { ok: true, status: r.status, body: body, mtime: mtime };
                }

                var errBody = await r.text().catch( function () { return ""; } );

                // Gum answers a GET for a file that does not exist with 500 and a
                // "File does not exist: ..." body. Treat that (and a plain 404) as
                // "no file yet" - a reachable server with nothing there - which is
                // very different from not reaching the server at all.
                if( r.status === 404 || ( r.status === 500 && /does not exist/i.test( errBody ) ) )
                    return { ok: false, status: 404, missing: true };

                authLost( r.status );
                return { ok: false, status: r.status, needsAuth: ( r.status === 401 || r.status === 403 ) };
            }
            catch ( e )
            {
                return { ok: false, status: 0, netError: true };
            }
        }

        // Request-side gzip. The server has always gzipped its RESPONSES, but a PUT
        // body went up raw - changing one 200-byte event re-uploaded the whole
        // 24 KB calendar.ics. Text shrinks ~9x here for a millisecond of CPU.
        //
        // The compressed bytes are MATERIALISED into a Uint8Array instead of being
        // piped as a stream: a streaming body goes out chunked, and the server
        // refuses chunked requests outright (it sizes every body from
        // Content-Length). A Uint8Array lets fetch set that header itself.
        //
        // Returns null - meaning "send it raw" - for a binary store (.docx is
        // already a zip), for a body too small to be worth a packet's overhead,
        // on a browser with no CompressionStream, and on any unexpected error.
        // A save must never be lost just because compressing it failed.
        async function gzipBody( body )
        {
            if( binary || typeof CompressionStream !== "function" ) return null;

            try
            {
                var bytes = new TextEncoder().encode( body );

                if( bytes.length < GZIP_MIN ) return null;

                var packed = new Blob( [ bytes ] ).stream()
                                                  .pipeThrough( new CompressionStream( "gzip" ) );

                return new Uint8Array( await new Response( packed ).arrayBuffer() );
            }
            catch ( e )
            {
                return null;
            }
        }

        async function netPut( path, body )
        {
            try
            {
                var packed = await gzipBody( body );

                var r = await netFetch( api + "?file=" + encodeURIComponent( path ),
                                        { method: "PUT",
                                          headers: packed ? { "Content-Encoding": "gzip" } : undefined,
                                          body: packed || body } );

                if( r.ok )
                    return { ok: true, status: r.status };

                authLost( r.status );
                return { ok: false, status: r.status, needsAuth: ( r.status === 401 || r.status === 403 ) };
            }
            catch ( e )
            {
                return { ok: false, status: 0, netError: true };
            }
        }

        //--------------------------------------------------------------------//
        // READ

        // Returns { body, source, mtime }
        //   source: 'network' | 'cache' | 'empty' | 'unknown' | 'unauth'
        //   body is null only for 'empty' / 'unknown' / 'unauth'
        //
        // 'empty'   real 404 from a reachable server - safe to treat as first run
        // 'unknown' fetch failed and there is nothing cached - caller MUST NOT
        //           treat this as empty (that is the old data-loss bug)
        async function read( path )
        {
            var db     = await dbPromise;
            var cached = await idbGet( db, DOCS, path );
            var queued = await idbGet( db, OUTBOX, path );

            // A not-yet-flushed local write is the truth - never let a network
            // GET clobber the user's pending edit on screen.
            if( queued )
            {
                scheduleFlush();

                if( cached )
                {
                    emit( navigator.onLine ? "pending" : "offline" );
                    return { body: cached.body, source: "cache", mtime: cached.mtime };
                }

                return { body: queued.body, source: "cache", mtime: queued.queuedAt };
            }

            if( navigator.onLine )
            {
                emit( "loading" );                 // a GET is in flight - retrieving data
                var res = await netGet( path );

                if( res.ok )
                {
                    await idbPut( db, DOCS,
                                  { path: path, body: res.body, mtime: res.mtime, cachedAt: Date.now(), dirty: false } );
                    scheduleFlush();               // other paths may still be queued
                    emit( "synced" );
                    return { body: res.body, source: "network", mtime: res.mtime };
                }

                if( res.status === 404 || res.missing )
                {
                    // Reachable server, file absent - safe first run. The cache
                    // (if any) is left in place rather than wiped on the server's
                    // say-so.
                    emit( "synced" );
                    return { body: null, source: "empty" };
                }

                if( res.needsAuth )
                {
                    emit( "needs-auth" );

                    if( cached )
                        return { body: cached.body, source: "cache", mtime: cached.mtime };

                    return { body: null, source: "unauth" };
                }

                // some other HTTP error, or the fetch threw
                if( cached )
                {
                    emit( res.netError ? "offline" : "error" );
                    return { body: cached.body, source: "cache", mtime: cached.mtime };
                }

                emit( res.netError ? "offline" : "error" );
                return { body: null, source: "unknown" };
            }

            // offline
            if( cached )
            {
                emit( "offline" );
                return { body: cached.body, source: "cache", mtime: cached.mtime };
            }

            emit( "offline" );
            return { body: null, source: "unknown" };
        }

        //--------------------------------------------------------------------//
        // WRITE

        // Caches the body, queues the PUT, tries to flush now. Resolves after the
        // attempt with { ok, offline?, needsAuth? }. The caller does not need to
        // await it - the local copy is already safe once this returns or not.
        async function write( path, body )
        {
            var db  = await dbPromise;
            var now = Date.now();

            await idbPut( db, DOCS,   { path: path, body: body, mtime: now, cachedAt: now, dirty: true } );
            await idbPut( db, OUTBOX, { path: path, body: body, queuedAt: now } );

            emit( "saving" );
            return flushPath( path );
        }

        //--------------------------------------------------------------------//
        // FLUSH

        async function flushPath( path )
        {
            var db    = await dbPromise;
            var entry = await idbGet( db, OUTBOX, path );

            if( ! entry ) return { ok: true };

            if( ! navigator.onLine )
            {
                emit( "offline" );
                return { ok: false, offline: true };
            }

            emit( "saving" );                      // a PUT is in flight - sending data
            var res = await netPut( path, entry.body );

            if( res.ok )
            {
                // Clear the queue entry only if nothing newer was queued while
                // the PUT was in flight.
                var current = await idbGet( db, OUTBOX, path );

                if( current && current.queuedAt === entry.queuedAt )
                {
                    await idbDelete( db, OUTBOX, path );

                    var doc = await idbGet( db, DOCS, path );
                    if( doc ) { doc.dirty = false; await idbPut( db, DOCS, doc ); }
                }

                await settle();
                return { ok: true };
            }

            if( res.needsAuth )
            {
                emit( "needs-auth" );
                return { ok: false, needsAuth: true };
            }

            emit( res.netError ? "offline" : "error" );
            return { ok: false, offline: !! res.netError };
        }

        async function flushAll()
        {
            if( flushing ) return;
            flushing = true;

            try
            {
                var db      = await dbPromise;
                var pending = await idbGetAll( db, OUTBOX );

                for( var i = 0; i < pending.length; i++ )
                {
                    var r = await flushPath( pending[ i ].path );

                    if( r && ( r.needsAuth || r.offline ) )
                        break;                     // stop early; a later trigger retries
                }

                await settle();
            }
            finally
            {
                flushing = false;
            }
        }

        function scheduleFlush()
        {
            if( flushTimer ) return;

            flushTimer = setTimeout( function ()
            {
                flushTimer = null;
                flushAll();
            }, FLUSH_DEBOUNCE_MS );
        }

        //--------------------------------------------------------------------//
        // INTROSPECTION

        async function hasAnyCache()
        {
            var db = await dbPromise;
            return ( await idbGetAll( db, DOCS ) ).length > 0;
        }

        async function hasCache( path )
        {
            var db = await dbPromise;
            return !! ( await idbGet( db, DOCS, path ) );
        }

        // Paths of every doc currently in the cache, optionally filtered to those
        // starting with `prefix`. Lets a multi-file app (trip) rebuild its list
        // offline without the server's file-tree call.
        async function listCached( prefix )
        {
            var db  = await dbPromise;
            var all = await idbGetAll( db, DOCS );

            return all.map( function ( r ) { return r.path; } )
                      .filter( function ( p ) { return ! prefix || p.indexOf( prefix ) === 0; } );
        }

        // Drop a path from the cache and the outbox (e.g. its file was deleted
        // on the server).
        async function forget( path )
        {
            var db = await dbPromise;
            await idbDelete( db, DOCS, path );
            await idbDelete( db, OUTBOX, path );
        }

        async function pendingCount()
        {
            var db = await dbPromise;
            return ( await idbGetAll( db, OUTBOX ) ).length;
        }

        //--------------------------------------------------------------------//

        return {
            read:         read,
            write:        write,
            flush:        flushAll,
            hasAnyCache:  hasAnyCache,
            hasCache:     hasCache,
            listCached:   listCached,
            forget:       forget,
            pendingCount: pendingCount,
            onState:      onState,
            resting:      settle,
            get state() { return state; }
        };
    }

    window.NayiveStore = { createStore: createStore };
} )();
