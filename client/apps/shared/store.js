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
 * path and newer replaces older (last-write-wins). By default there is no
 * conflict resolution - if the same file is edited on another device while this
 * one is offline, the offline device wins on reconnect. The outbox is shared by
 * every store on the origin, so each entry records how it must be sent (bytes
 * or text, with or without If-Unmodified-Since) and any page can flush it.
 *
 * CONFLICTS  (opt-in: createStore( { conflicts: true } ) - the office editors)
 * The store remembers the server's own time for each file (`srv`, taken ONLY
 * from a GET's or a PUT's Last-Modified - never this device's clock) and sends
 * it as If-Unmodified-Since. A file saved from another device since answers 412:
 * the outbox entry is flagged `conflict`, is never sent again (so no flush can
 * overwrite theirs), and onConflict listeners hear about it. The app resolves it
 * by saving elsewhere and forget()-ing the old path.
 *
 * A 403 / 409 on a PUT (a read-only share, a protected file) can never succeed:
 * the entry is dropped and the write reports `forbidden`, instead of sitting in
 * the outbox forever looking like an expired session.
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
 * It is a transport detail and nothing else: the server inflates the body
 * (server/go/upload.go) and stores exactly the same bytes on disk, so
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

    // Page-wide, shared by every store on the page (the outbox is shared too):
    var inflight = {};   // path -> the PUT being sent for it; one at a time per path
    var writeSeq = {};   // path -> count of write() calls, so a read can see one land mid-GET
    var writing  = {};   // path -> the cache/outbox update of the latest write()
    var blocked  = {};   // path -> "unread" | "bad": writes refused (see block())
    var loaded   = {};   // path -> a read() of it has succeeded on this page
    var firstOut = {};   // path -> reads out before the first success: writes refused
    var toastAt  = 0;

    //------------------------------------------------------------------------//
    // TINY INDEXEDDB PROMISE WRAPPER
    //
    // Every call resolves even when IndexedDB is missing or blocked (private
    // mode, storage disabled): openDb() resolves to null and the helpers below
    // keep the records in memory instead, for this page only. (They used to
    // no-op, and a write then found no outbox entry to send: it was dropped.)

    var mem = {};   // storeName -> Map( key -> record ), when there is no IndexedDB

    function memStore( storeName )
    {
        return mem[ storeName ] || ( mem[ storeName ] = new Map() );
    }

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
        if( ! db ) return Promise.resolve( memStore( storeName ).get( key ) );

        try
        {
            return idbReq( db.transaction( storeName, "readonly" ).objectStore( storeName ).get( key ) );
        }
        catch ( e ) { return Promise.resolve( undefined ); }
    }

    function idbGetAll( db, storeName )
    {
        if( ! db ) return Promise.resolve( Array.from( memStore( storeName ).values() ) );

        try
        {
            return idbReq( db.transaction( storeName, "readonly" ).objectStore( storeName ).getAll() );
        }
        catch ( e ) { return Promise.resolve( [] ); }
    }

    function idbPut( db, storeName, record )
    {
        if( ! db ) { memStore( storeName ).set( record.path, record ); return Promise.resolve(); }

        try
        {
            return idbReq( db.transaction( storeName, "readwrite" ).objectStore( storeName ).put( record ) );
        }
        catch ( e ) { return Promise.resolve(); }
    }

    // Read-modify-write of one record in ONE readwrite transaction, so it cannot
    // interleave with another one on the same store (a save arriving while the
    // previous PUT's answer is being recorded). fn( current ) returns the record
    // to put, null to delete it, or undefined to leave it alone.
    function idbUpdate( db, storeName, key, fn )
    {
        if( ! db )
        {
            var m    = memStore( storeName );
            var next = fn( m.get( key ) );
            if( next === null ) m.delete( key );
            else if( next )     m.set( key, next );
            return Promise.resolve();
        }

        return new Promise( function ( resolve )
        {
            try
            {
                var tx = db.transaction( storeName, "readwrite" );
                var os = tx.objectStore( storeName );
                var rq = os.get( key );

                rq.onsuccess = function ()
                {
                    var next = fn( rq.result );
                    if( next === null )    os.delete( key );
                    else if( next )        os.put( next );
                };
                tx.oncomplete = function () { resolve(); };
                tx.onerror = tx.onabort = function () { resolve(); };
            }
            catch ( e ) { resolve(); }
        } );
    }

    function idbDelete( db, storeName, key )
    {
        if( ! db ) { memStore( storeName ).delete( key ); return Promise.resolve(); }

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
        var conflicts = !! opts.conflicts; // send If-Unmodified-Since (see CONFLICTS above)
        var listeners = [];
        var conflictFns = [];
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
        //   conflict    a queued write was refused: saved from another device since

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

            if( pending.some( function ( e ) { return e.conflict; } ) ) emit( "conflict" );
            else if( pending.length === 0 ) emit( navigator.onLine ? "synced"  : "offline" );
            else                            emit( navigator.onLine ? "pending" : "offline" );
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
                    var srv   = Date.parse( r.headers.get( "Last-Modified" ) ) || null;
                    var mtime = srv || Date.now();

                    return { ok: true, status: r.status, body: body, mtime: mtime, srv: srv };
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
        // Returns null - meaning "send it raw" - for a binary body (.docx is
        // already a zip), for a body too small to be worth a packet's overhead,
        // on a browser with no CompressionStream, and on any unexpected error.
        // A save must never be lost just because compressing it failed.
        async function gzipBody( body, bin )
        {
            if( bin || typeof body !== "string" || typeof CompressionStream !== "function" ) return null;

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

        // `since` (ms, the server's own time for this file) becomes
        // If-Unmodified-Since - see CONFLICTS above. The answer's Last-Modified
        // comes back as `srv`, the base for the next save.
        async function netPut( path, body, since, bin )
        {
            try
            {
                var packed  = await gzipBody( body, bin );
                var headers = {};

                if( packed ) headers[ "Content-Encoding" ] = "gzip";
                if( since )  headers[ "If-Unmodified-Since" ] = new Date( since ).toUTCString();

                var r = await netFetch( api + "?file=" + encodeURIComponent( path ),
                                        { method: "PUT", headers: headers, body: packed || body } );

                if( r.ok )
                    return { ok: true, status: r.status, srv: Date.parse( r.headers.get( "Last-Modified" ) ) || null };

                if( r.status === 412 )
                    return { ok: false, status: 412, conflict: true };

                // Not this user's to write (a read-only share, a protected file) or
                // a shared folder that only takes NEW names. Retrying never helps.
                if( r.status === 403 || r.status === 409 )
                    return { ok: false, status: r.status, forbidden: true };

                authLost( r.status );
                return { ok: false, status: r.status, needsAuth: r.status === 401 };
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
        //
        // An 'unknown' or 'unauth' answer also BLOCKS the path: write() refuses
        // it until a later read succeeds, so an app that shows the empty view
        // anyway can never save that emptiness over the real file.
        //
        // Until the FIRST read of a path on this page has answered, write()
        // refuses it too ("loading"): whatever the app would save then was built
        // before it knew the file - an add pressed during a slow first GET would
        // otherwise replace a 716-card address book with the one new card.
        async function read( path )
        {
            var first = ! loaded[ path ];
            var res;

            if( first ) firstOut[ path ] = ( firstOut[ path ] || 0 ) + 1;

            try { res = await readNow( path ); }
            finally
            {
                if( first && --firstOut[ path ] <= 0 ) delete firstOut[ path ];
            }

            if( res.source === "unknown" || res.source === "unauth" ) blocked[ path ] = "unread";
            else
            {
                delete blocked[ path ];
                loaded[ path ] = true;
            }

            return res;
        }

        async function readNow( path )
        {
            // A write() from here on is seen after the GET (writeSeq); one that
            // started just before is waited for, so its outbox entry is found.
            var seq    = writeSeq[ path ] || 0;
            if( writing[ path ] ) { try { await writing[ path ]; } catch ( e ) {} }
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

                // A write() landed while the GET was out: the user's edit is the
                // truth, not the older server body that just came back.
                if( ( writeSeq[ path ] || 0 ) !== seq )
                {
                    try { await writing[ path ]; } catch ( e ) {}
                    var mine = await idbGet( db, DOCS, path );
                    scheduleFlush();
                    if( mine ) return { body: mine.body, source: "cache", mtime: mine.mtime };
                }

                if( res.ok )
                {
                    // Checked again INSIDE the cache transaction: a write() that
                    // lands now must not have its edit replaced by this body.
                    await idbUpdate( db, DOCS, path, function ()
                    {
                        if( ( writeSeq[ path ] || 0 ) !== seq ) return undefined;
                        return { path: path, body: res.body, mtime: res.mtime, cachedAt: Date.now(), dirty: false,
                                 srv: res.srv };
                    } );

                    if( ( writeSeq[ path ] || 0 ) !== seq )
                    {
                        try { await writing[ path ]; } catch ( e ) {}
                        var newer = await idbGet( db, DOCS, path );
                        scheduleFlush();
                        if( newer ) return { body: newer.body, source: "cache", mtime: newer.mtime };
                    }

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
        // attempt with { ok, offline?, needsAuth?, forbidden?, conflict? }. The
        // caller does not need to await it - the local copy is already safe once
        // this returns or not.
        //
        // The server time (`srv`) and a conflict flag survive the rewrite: a
        // conflicted file keeps collecting the user's edits locally, and none of
        // them goes up until the app has resolved it.
        async function write( path, body )
        {
            var refused = isBlocked( path );

            if( refused )
            {
                refusedToast( refused );
                emit( "error" );
                return { ok: false, blocked: refused };
            }

            loaded[ path ] = true;   // this page now holds the file's content: later reads are RE-reads

            var now = Date.now();
            var conflicted = false;

            // Each entry says how it must be sent (bytes or text, with or without
            // If-Unmodified-Since): the outbox is shared by every store, and a
            // Calendar page flushing Write's queued .docx must send it as Write would.
            // Counted and started in the same tick, so a read() whose GET is out
            // sees this write and waits for it (see readNow).
            writeSeq[ path ] = ( writeSeq[ path ] || 0 ) + 1;
            var queued = ( async function ()
            {
                var db = await dbPromise;
                await idbUpdate( db, DOCS, path, function ( old )
                {
                    return { path: path, body: body, mtime: now, cachedAt: now, dirty: true, srv: old ? old.srv : null };
                } );
                await idbUpdate( db, OUTBOX, path, function ( old )
                {
                    conflicted = !! ( old && old.conflict );
                    return { path: path, body: body, queuedAt: now, conflict: conflicted,
                             bin: binary || body instanceof Uint8Array, ius: conflicts };
                } );
            } )();

            writing[ path ] = queued;
            await queued;

            if( conflicted )
            {
                emit( "conflict" );
                return { ok: false, conflict: true };
            }

            emit( "saving" );
            return flushPath( path );
        }

        //--------------------------------------------------------------------//
        // FLUSH

        // One PUT per path at a time on this page: two in flight would both carry
        // the same If-Unmodified-Since, and the second would come back 412 - a
        // false "saved on another device". The next one waits, then re-reads the
        // outbox and the new server time.
        async function flushPath( path )
        {
            while( inflight[ path ] )
            {
                try { await inflight[ path ]; } catch ( e ) {}
            }

            var p = flushPathNow( path );
            inflight[ path ] = p;

            try { return await p; }
            finally { if( inflight[ path ] === p ) delete inflight[ path ]; }
        }

        async function flushPathNow( path )
        {
            var db    = await dbPromise;
            var entry = await idbGet( db, OUTBOX, path );

            if( ! entry ) return { ok: true };
            if( entry.conflict ) return { ok: false, conflict: true };   // waits for the app, never re-sent

            if( ! navigator.onLine )
            {
                emit( "offline" );
                return { ok: false, offline: true };
            }

            // Sent the way the store that queued it would send it. Entries from
            // before `bin`/`ius` existed: bytes are Write/Calc's, which use
            // If-Unmodified-Since; text never did, bar Text's own.
            var bin   = entry.bin != null ? !! entry.bin : ( entry.body instanceof Uint8Array );
            var ius   = entry.ius != null ? !! entry.ius : bin;
            var known = ius ? await idbGet( db, DOCS, path ) : null;

            emit( "saving" );                      // a PUT is in flight - sending data
            var res = await netPut( path, entry.body, known && known.srv, bin );

            // Only the entry that was sent is settled: a newer one queued while
            // the PUT was in flight stays for the next flush.
            function sameEntry( cur ) { return cur && cur.queuedAt === entry.queuedAt; }

            if( res.ok )
            {
                var cleared = false;

                await idbUpdate( db, OUTBOX, path, function ( cur )
                {
                    if( ! sameEntry( cur ) ) return undefined;
                    cleared = true;
                    return null;
                } );
                await idbUpdate( db, DOCS, path, function ( doc )
                {
                    if( ! doc ) return undefined;
                    if( res.srv ) doc.srv   = res.srv;   // the base for the next save
                    if( cleared ) doc.dirty = false;
                    return doc;
                } );

                await settle();
                return { ok: true };
            }

            if( res.conflict )
            {
                await idbUpdate( db, OUTBOX, path, function ( cur )
                {
                    if( ! cur ) return undefined;
                    cur.conflict = true;
                    return cur;
                } );
                emit( "conflict" );
                conflictFns.forEach( function ( fn ) { try { fn( path ); } catch ( e ) {} } );
                return { ok: false, conflict: true };
            }

            if( res.forbidden )
            {
                await idbUpdate( db, OUTBOX, path, function ( cur ) { return sameEntry( cur ) ? null : undefined; } );
                emit( "error" );
                return { ok: false, forbidden: true };
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

        // A write to `path` is held back as a conflict (see CONFLICTS above).
        async function conflicted( path )
        {
            var db    = await dbPromise;
            var entry = await idbGet( db, OUTBOX, path );
            return !! ( entry && entry.conflict );
        }

        // fn( path ) - a flush found `path` saved from another device since.
        function onConflict( fn ) { conflictFns.push( fn ); }

        // BLOCKED PATHS - "never save over what we could not read".
        // read() blocks a path it could not read ('unknown' / 'unauth'); an app
        // blocks one it read but cannot understand (a bad line in an .ics, JSON
        // that does not parse): block( path ), reason "bad". write() then
        // refuses that path, says why in a toast, and changes nothing - not the
        // cache, not the outbox. The next read() that succeeds lifts it; the app
        // blocks again if the file is still bad.
        function block( path, reason ) { blocked[ path ] = reason || "bad"; }
        function unblock( path )       { delete blocked[ path ]; }
        function isBlocked( path )     { return blocked[ path ] || ( firstOut[ path ] && ! loaded[ path ] ? "loading" : "" ); }

        function refusedToast( reason )
        {
            var now = Date.now();
            if( now - toastAt < 4000 || ! window.NayiveUI || ! NayiveUI.toast || ! NayiveUI.t ) return;
            toastAt = now;
            NayiveUI.toast( NayiveUI.t( reason === "bad"     ? "ui.store.badFile"
                                      : reason === "loading" ? "ui.store.loading" : "ui.store.notRead" ), { ms: 6000 } );
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
            conflicted:   conflicted,
            onConflict:   onConflict,
            block:        block,
            unblock:      unblock,
            isBlocked:    isBlocked,
            onState:      onState,
            resting:      settle,
            get state() { return state; }
        };
    }

    window.NayiveStore = { createStore: createStore };
} )();
