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
 * MERGE  (opt-in: createStore( { conflicts: true, merge: fn } ) - 2026-09-28)
 * The small list apps (Habits, Split, Contacts, Calendar, Tasks, Trips, Games)
 * save one whole file, so a phone's offline ticks used to overwrite the PC's.
 * With `merge` the store keeps `base` per path - the body this device last
 * read from or saved to the server - and on a 412 it GETs the server copy and
 * calls fn( path, base, mine, theirs ) (base null when unknown). A string back
 * is the merged body: it goes to the cache and the outbox, onMerged( path,
 * body ) listeners reload the app's data, and it goes up with the new
 * If-Unmodified-Since (a few tries). null = the CONFLICTS path above. While a
 * merge is being made, write() waits for it and merges its own body onto the
 * result (fn( path, mine-before, body, merged )): that body was built before
 * the app reloaded, and would otherwise drop the other device's changes.
 * Every page may flush any entry, but only a page whose store claimed the path
 * (read or wrote it with `merge`) can merge it: elsewhere a 412 just leaves it
 * queued for its own app. So a merging store reads and writes only its own
 * app's files; another app's file is read with GumApi (or a plain store).
 * Every store keeps `base` for a text file (a plain store reading or writing a
 * merged path must not wipe it), and a plain store's write over a queued
 * merging save keeps it merge-protected (`mrg`, If-Unmodified-Since). A clean
 * copy cached by an older store.js gets its body as `base` at the next save.
 * A merge that said null is tried again each time its app reads the file. The
 * merge's GET is dropped when another account signed in since (whoNow).
 *
 * A 403 / 409 on a PUT (a read-only share, a protected file) can never succeed:
 * the entry is dropped and the write reports `forbidden`, instead of sitting in
 * the outbox forever looking like an expired session.
 *
 * WHOSE SAVE  (2026-09-28)
 * One browser, two accounts: a save queued while ana was signed in used to go
 * up with whatever session the browser held when it was sent - beto's, after a
 * sign-out, an expired session or a sign-in in another tab - and land in HIS
 * home. So this page reads who it belongs to ONCE, when it loads (the readable
 * "nayive_who" cookie, server/go/store_owner.go), and every record it writes
 * carries that name (`who`). A queued save goes up with it in X-Nayive-User;
 * the server answers 423 when it is not the session's, and the entry stays
 * here until its owner signs in again. Records of another account are never
 * read, sent or counted by this page. No cookie (a page that loaded signed
 * out, or before the cookie existed) = no name: untagged records, taken as
 * before. The key stays the path and DB_VERSION stays 1 - an older store.js in
 * another tab must still read and send every record.
 * Signing out clears the lot (localCount / clearLocal, used by the launcher).
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
 */
( function ()
{
    "use strict";

    var DB_NAME    = "nube-store";   // kept from the old name on purpose: renaming the IndexedDB would drop pending offline writes
    var DB_VERSION = 1;
    var DOCS       = "docs";      // last-known-good file bodies, keyPath "path"
    var OUTBOX     = "outbox";    // pending writes,             keyPath "path"

    var FLUSH_DEBOUNCE_MS = 1500;
    var MERGE_TRIES       = 4;      // 412 -> merge -> PUT rounds before waiting for the next flush
    var GZIP_MIN          = 1400;   // same cutoff the server uses on the way down:
                                    // below ~one packet, compression is a net loss

    // Page-wide, shared by every store on the page (the outbox is shared too):
    var inflight = {};   // path -> the PUT being sent for it; one at a time per path
    var writeSeq = {};   // path -> count of write() calls, so a read can see one land mid-GET
    var writing  = {};   // path -> the cache/outbox update of the latest write()
    var blocked  = {};   // path -> "unread" | "bad": writes refused (see block())
    var loaded   = {};   // path -> a read() of it has succeeded on this page
    var firstOut = {};   // path -> reads out before the first success: writes refused
    var mergers  = {};   // path -> { fn, fire, get } of the store that merges it (see MERGE)
    var merging  = {};   // path -> a merge being made: resolves { mine, merged } | null
    var toastAt  = 0;

    // Who this page belongs to: the "nayive_who" cookie AS IT WAS WHEN THE PAGE
    // LOADED - never read again, so a tab left open across another account's
    // sign-in still tags its saves with its own owner. "" = unknown.
    var ME = ( function ()
    {
        try
        {
            var m = document.cookie.match( /(?:^|;\s*)nayive_who=([^;]*)/ );
            return m ? m[ 1 ] : "";
        }
        catch ( e ) { return ""; }
    } )();

    // Who is signed in on this browser NOW (the cookie as it is at this moment,
    // unlike ME): "" = unknown.
    function whoNow()
    {
        try
        {
            var m = document.cookie.match( /(?:^|;\s*)nayive_who=([^;]*)/ );
            return m ? m[ 1 ] : "";
        }
        catch ( e ) { return ""; }
    }

    // A record this page may use: untagged, or this page's own account. Only a
    // record KNOWN to be another account's is skipped.
    function ours( rec ) { return ! rec || ! rec.who || ! ME || rec.who === ME; }

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
        var mergeFn   = typeof opts.merge === "function" ? opts.merge : null;   // see MERGE above
        var conflicts = !! opts.conflicts || !! mergeFn; // send If-Unmodified-Since (see CONFLICTS above)
        var listeners = [];
        var conflictFns = [];
        var mergedFns   = [];
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
            var pending = ( await idbGetAll( db, OUTBOX ) ).filter( ours );

            if( pending.some( function ( e ) { return e.conflict; } ) ) emit( "conflict" );
            else if( pending.length === 0 ) emit( navigator.onLine ? "synced"  : "offline" );
            else                            emit( navigator.onLine ? "pending" : "offline" );
        }

        //--------------------------------------------------------------------//
        // NETWORK

        // Same retry shape as the apps' old fetchIt(): two retries, only for a
        // thrown TypeError - a genuine connectivity drop, whatever the browser
        // calls it (Chrome "Failed to fetch", Safari "Load failed", Firefox
        // "NetworkError...") - never for an HTTP error status. Only GET and PUT
        // come through here, and both are safe to send twice.
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
                if( retry < 2 && err instanceof TypeError )
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

                // A 404 is "no file yet" - a reachable server with nothing there -
                // which is very different from not reaching the server at all.
                if( r.status === 404 )
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
        async function netPut( path, body, since, bin, who )
        {
            try
            {
                var packed  = await gzipBody( body, bin );
                var headers = {};

                if( packed ) headers[ "Content-Encoding" ] = "gzip";
                if( since )  headers[ "If-Unmodified-Since" ] = new Date( since ).toUTCString();
                if( who )    headers[ "X-Nayive-User" ] = who;

                var r = await netFetch( api + "?file=" + encodeURIComponent( path ),
                                        { method: "PUT", headers: headers, body: packed || body } );

                if( r.ok )
                    return { ok: true, status: r.status, srv: Date.parse( r.headers.get( "Last-Modified" ) ) || null };

                if( r.status === 412 )
                    return { ok: false, status: 412, conflict: true };

                // Queued under another account than the one signed in now
                // (WHOSE SAVE above): kept for its owner, no "session expired" bar.
                if( r.status === 423 )
                    return { ok: false, status: 423, otherAccount: true };

                // No password yet (the server's must_set_password gate): the save is
                // fine, the account is not - kept like a lost session, never dropped.
                if( r.status === 403 )
                {
                    var why = await r.clone().json().catch( function () { return null; } );
                    if( why && why.must_set_password )
                        return { ok: false, status: 403, needsAuth: true };
                }

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

            claim( path );

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

            // Another account's copy is not this person's file: as if absent.
            if( ! ours( cached ) ) cached = null;
            if( ! ours( queued ) ) queued = null;

            // A not-yet-flushed local write is the truth - never let a network
            // GET clobber the user's pending edit on screen.
            if( queued )
            {
                // A merge that said null (MERGE) is tried again each time its
                // app opens the file: the other side may be fine by now.
                if( queued.conflict && queued.mrg && mergeFn )
                    await idbUpdate( db, OUTBOX, path, function ( c ) { if( ! c || ! c.conflict ) return undefined; c.conflict = false; return c; } );

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
                        // `base` for every text file, merging store or not: a
                        // plain store (Drive's import) reading a merged path must
                        // not leave it without one (see MERGE).
                        return { path: path, body: res.body, mtime: res.mtime, cachedAt: Date.now(), dirty: false,
                                 srv: res.srv, who: ME, base: typeof res.body === "string" ? res.body : undefined };
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
            claim( path );

            var now = Date.now();
            var conflicted = false;
            var held = merging[ path ];   // a merge is being made: this body predates it (see MERGE)

            // Each entry says how it must be sent (bytes or text, with or without
            // If-Unmodified-Since): the outbox is shared by every store, and a
            // Calendar page flushing Write's queued .docx must send it as Write would.
            // Counted and started in the same tick, so a read() whose GET is out
            // sees this write and waits for it (see readNow).
            writeSeq[ path ] = ( writeSeq[ path ] || 0 ) + 1;
            var queued = ( async function ()
            {
                if( held )
                {
                    var mr = await held;
                    if( mr && mergeFn )
                    {
                        try
                        {
                            var again = mergeFn( path, mr.mine, body, mr.merged );
                            if( typeof again === "string" ) body = again;
                        }
                        catch ( e ) { /* keep the body as the app built it */ }
                    }
                }

                var db = await dbPromise;
                // Another account's record under the same path gives nothing
                // to this one - not its server time, not its conflict.
                // `base` is kept whatever store writes. A clean copy cached by an
                // older store.js has none: its body IS what the server had.
                await idbUpdate( db, DOCS, path, function ( old )
                {
                    var mineOld = old && ours( old );
                    var base    = mineOld ? old.base : undefined;
                    if( mineOld && base === undefined && old.dirty === false && typeof old.body === "string" ) base = old.body;
                    return { path: path, body: body, mtime: now, cachedAt: now, dirty: true,
                             srv: mineOld ? old.srv : null, who: ME, base: base };
                } );
                // A save queued by a merging store stays merge-protected when a
                // plain store (Drive's import) writes the same path: it keeps
                // If-Unmodified-Since and `mrg`, and waits for its own app to
                // merge it. A merging entry's next save merges again instead of
                // staying held: whatever the last merge refused may be fine now.
                await idbUpdate( db, OUTBOX, path, function ( old )
                {
                    var was = old && ours( old ) ? old : null;
                    var mrg = !! mergeFn || !! ( was && was.mrg );
                    conflicted = ! mrg && !! ( was && was.conflict );
                    return { path: path, body: body, queuedAt: now, conflict: conflicted,
                             bin: binary || body instanceof Uint8Array, ius: conflicts || !! ( was && was.ius ), who: ME,
                             mrg: mrg };
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
            if( ! ours( entry ) ) return { ok: false, otherAccount: true };  // waits for its owner
            if( entry.conflict ) return { ok: false, conflict: true };   // waits for the app, never re-sent

            var merger = entry.mrg ? mergers[ path ] : null;   // see MERGE above

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
            var who   = entry.who || ME;
            if( known && known.who && entry.who && known.who !== entry.who ) known = null;

            emit( "saving" );                      // a PUT is in flight - sending data
            var res = await netPut( path, entry.body, known && known.srv, bin, who );

            // Saved from another device since: merge both (see MERGE above).
            // `entry` is then the merged one, and `res` the answer to it.
            if( res.conflict && entry.mrg )
            {
                if( ! merger )
                {
                    // Not this page's app: it stays queued, as it was, for the
                    // page that can merge it.
                    emit( "pending" );
                    return { ok: false, deferred: true };
                }

                var m = await mergeAndPut( db, path, entry, merger, bin, who );
                if( m.done ) return m.done;
                res   = m.res;
                entry = m.entry;
            }

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
                    if( typeof entry.body === "string" ) doc.base = entry.body;   // what the server holds now
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

            // Another account is signed in: this page's saves wait for their
            // owner (a sign-in again) - and the next entry may still go.
            if( res.otherAccount )
            {
                emit( "needs-auth" );
                return { ok: false, otherAccount: true };
            }

            emit( res.netError ? "offline" : "error" );
            return { ok: false, offline: !! res.netError };
        }

        // MERGE (see above): this page's merging store for `path` from now on.
        function claim( path )
        {
            if( mergeFn ) mergers[ path ] = { fn: mergeFn, fire: fireMerged, get: netGet };
        }

        function fireMerged( path, body )
        {
            mergedFns.forEach( function ( fn ) { try { fn( path, body ); } catch ( e ) {} } );
        }

        // A PUT of `entry` came back 412. Up to MERGE_TRIES times: GET the
        // server's copy, merge the queued body onto it, put the result in the
        // cache and the outbox, tell the app, PUT it with the server's new time.
        // Returns { res, entry } - the last answer (never a 412 unless the merge
        // said null: the CONFLICTS path) and the entry it answers - or { done }
        // when there is nothing more to do here.
        async function mergeAndPut( db, path, entry, merger, bin, who )
        {
            var res = { ok: false, status: 412, conflict: true };

            for( var tries = 0; tries < MERGE_TRIES; tries++ )
            {
                // From the GET until the app has the merged body, write() waits
                // and merges its own body onto ours: whatever it brings was
                // built from the list before the merge.
                var open = null;
                merging[ path ] = new Promise( function ( r ) { open = r; } );
                var result = null;
                var theirs, gone = false;

                try
                {
                    theirs = await merger.get( path );

                    // Another account signed in on this browser since the save
                    // was queued (WHOSE SAVE): that GET brought THEIR file, which
                    // must not be merged into this one. It waits for its owner.
                    if( who && whoNow() && whoNow() !== who )
                        return { res: { ok: false, status: 423, otherAccount: true }, entry: entry };

                    if( ! theirs.ok )
                    {
                        // Gone from the server since: nothing to merge with, it
                        // goes up as it is (below; what every save did before).
                        if( theirs.missing ) gone = true;
                        else return { res: { ok: false, status: theirs.status, netError: theirs.netError,
                                             needsAuth: theirs.status === 401 }, entry: entry };
                    }
                    else
                    {
                        var cur = await idbGet( db, OUTBOX, path );
                        var doc = await idbGet( db, DOCS, path );

                        if( ! cur || ! ours( cur ) ) return { done: { ok: true } };   // nothing queued any more

                        var base   = doc && ours( doc ) && typeof doc.base === "string" ? doc.base : null;
                        var merged = null;

                        try { merged = merger.fn( path, base, cur.body, theirs.body ); }
                        catch ( e ) { merged = null; }

                        if( typeof merged !== "string" ) return { res: res, entry: cur };   // -> CONFLICTS

                        var kept = false;
                        await idbUpdate( db, OUTBOX, path, function ( c )
                        {
                            if( ! c || c.queuedAt !== cur.queuedAt ) return undefined;
                            kept = true;
                            c.body = merged;
                            c.conflict = false;
                            return c;
                        } );

                        if( ! kept ) continue;   // a newer save landed meanwhile: merge that one

                        await idbUpdate( db, DOCS, path, function ( d )
                        {
                            d = d && ours( d ) ? d : { path: path, cachedAt: Date.now(), who: ME };
                            d.body  = merged;
                            d.mtime = Date.now();
                            d.dirty = true;
                            d.base  = theirs.body;   // what the server holds - until the PUT below lands
                            d.srv   = theirs.srv;
                            return d;
                        } );

                        merger.fire( path, merged );
                        result = { mine: cur.body, merged: merged };
                        entry  = Object.assign( {}, cur, { body: merged, conflict: false } );
                    }
                }
                finally
                {
                    delete merging[ path ];
                    open( result );
                }

                if( gone ) return { res: await netPut( path, entry.body, null, bin, who ), entry: entry };

                emit( "saving" );
                res = await netPut( path, entry.body, theirs.srv, bin, who );
                if( ! res.conflict ) return { res: res, entry: entry };
            }

            // Saved elsewhere again and again: it stays queued, merged, for the
            // next flush.
            emit( "pending" );
            return { done: { ok: false } };
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
            return ( await idbGetAll( db, DOCS ) ).some( ours );
        }

        async function hasCache( path )
        {
            var db  = await dbPromise;
            var rec = await idbGet( db, DOCS, path );
            return !! rec && ours( rec );
        }

        // Paths of every doc currently in the cache, optionally filtered to those
        // starting with `prefix`. Lets a multi-file app (trip) rebuild its list
        // offline without the server's file-tree call.
        async function listCached( prefix )
        {
            var db  = await dbPromise;
            var all = ( await idbGetAll( db, DOCS ) ).filter( ours );

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

        // A write to `path` is held back as a conflict (see CONFLICTS above).
        async function conflicted( path )
        {
            var db    = await dbPromise;
            var entry = await idbGet( db, OUTBOX, path );
            return !! ( entry && ours( entry ) && entry.conflict );
        }

        // fn( path ) - a flush found `path` saved from another device since.
        function onConflict( fn ) { conflictFns.push( fn ); }

        // fn( path, body ) - a flush merged `path` with another device's save
        // (see MERGE above): the app reloads its data from `body`.
        function onMerged( fn ) { mergedFns.push( fn ); }

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
            conflicted:   conflicted,
            onConflict:   onConflict,
            onMerged:     onMerged,
            block:        block,
            unblock:      unblock,
            isBlocked:    isBlocked,
            onState:      onState,
            resting:      settle,
            get state() { return state; }
        };
    }

    //------------------------------------------------------------------------//
    // SIGNING OUT  (the launcher's button, and admin.html's)
    //
    // What this browser keeps must not outlive the session: the next person to
    // sign in here would be offered it. localCount() is how many saves and
    // untitled drafts are still only here - EVERY account's, since they all go -
    // so the button can ask first; clearLocal() empties the store's database
    // and shared/office.js's "nayive-drafts". Each store is emptied with clear()
    // in place: deleteDatabase() waits for every other open tab and, meanwhile,
    // does nothing.

    // "nayive-drafts" as shared/office.js opens it - the same upgrade, so
    // opening it here first never leaves a database with no "drafts" store.
    function openDraftsDb()
    {
        return new Promise( function ( resolve )
        {
            var rq;
            try { rq = indexedDB.open( "nayive-drafts", 1 ); }
            catch ( e ) { resolve( null ); return; }
            rq.onupgradeneeded = function () { rq.result.createObjectStore( "drafts", { keyPath: "app" } ); };
            rq.onsuccess = function () { resolve( rq.result ); };
            rq.onerror = rq.onblocked = function () { resolve( null ); };
        } );
    }

    // fn( objectStore ) -> request, in one transaction; its result, or null.
    function oneTx( db, name, mode, fn )
    {
        if( ! db ) return Promise.resolve( null );
        return new Promise( function ( resolve )
        {
            try
            {
                var tx = db.transaction( name, mode );
                var rq = fn( tx.objectStore( name ) );
                tx.oncomplete = function () { resolve( rq.result === undefined ? null : rq.result ); };
                tx.onerror = tx.onabort = function () { resolve( null ); };
            }
            catch ( e ) { resolve( null ); }
        } );
    }

    async function localCount()
    {
        var store  = await openDb();
        var drafts = await openDraftsDb();
        var n = ( await oneTx( store,  OUTBOX,   "readonly", function ( os ) { return os.count(); } ) ) || 0;
        n    += ( await oneTx( drafts, "drafts", "readonly", function ( os ) { return os.count(); } ) ) || 0;
        if( store )  store.close();
        if( drafts ) drafts.close();
        return n;
    }

    // The saves still waiting here get one more chance to go up before the
    // count: as long as one is actually being sent, up to `ms` (10 s), never
    // longer - flush() comes back at once when nothing is queued, and stops
    // at the first "offline" or "signed out". Offline, no wait at all.
    function sendWaiting( ms )
    {
        if( ! navigator.onLine ) return Promise.resolve();
        return Promise.race( [ createStore().flush().catch( function () {} ),
                               new Promise( function ( r ) { setTimeout( r, ms || 10000 ); } ) ] );
    }

    async function clearLocal()
    {
        var store  = await openDb();
        var drafts = await openDraftsDb();
        await oneTx( store,  OUTBOX,   "readwrite", function ( os ) { return os.clear(); } );
        await oneTx( store,  DOCS,     "readwrite", function ( os ) { return os.clear(); } );
        await oneTx( drafts, "drafts", "readwrite", function ( os ) { return os.clear(); } );
        if( store )  store.close();
        if( drafts ) drafts.close();
    }

    //------------------------------------------------------------------------//
    // THREE-WAY MERGE HELPERS  (for the apps' `merge` - see MERGE above)
    //
    // mergeLists( base, mine, theirs, o ) merges three arrays of items BY ID:
    //   o.id( item )       -> the item's key ("" / null = no key: see below)
    //   o.both( b, m, t )  -> the item when both sides changed it (b undefined:
    //                         not in base); default: the newer by o.stamp( item );
    //                         with no stamps, mine - or theirs when b is unknown
    // Added on either side = kept; deleted on one side and untouched on the
    // other = deleted; deleted on one side and CHANGED on the other = kept, the
    // changed copy (an edit is never lost to a delete). Two items sharing an id
    // on one side are both kept: the second is "id #2", and so on.
    //
    // base null (unknown - a copy cached by an older store.js): nothing can be
    // told deleted, so every item of both sides is kept, and an item the two
    // sides hold differently is THEIRS (or the newer by stamp). A guess either
    // way loses one edit; this one loses it on THIS device, whose screen shows
    // the merged list at once (onMerged), rather than silently undoing what the
    // other device saved.
    //
    // Items with no key are told apart by their whole content, as a set: kept
    // unless the other side dropped one that base had. Order: mine's, each item
    // only theirs has placed after its neighbour in theirs.

    function same( a, b ) { return JSON.stringify( a ) === JSON.stringify( b ); }

    // m or t by their stamps; `fallback` when they do not say.
    function newerOf( o, m, t, fallback )
    {
        var sm = o && o.stamp ? o.stamp( m ) : null;
        var st = o && o.stamp ? o.stamp( t ) : null;
        if( sm != null && st != null && sm !== st ) return st > sm ? t : m;
        return fallback;
    }

    function mergeLists( base, mine, theirs, o )
    {
        o      = o || {};
        mine   = mine   || [];
        theirs = theirs || [];

        var id = function ( x ) { var k = o.id ? o.id( x ) : null; return k == null || k === "" ? null : String( k ); };
        var both = o.both || function ( b, m, t ) { return newerOf( o, m, t, b === undefined ? t : m ); };

        // Each item's key in its list: its id, "id\u0001#2" for the second one
        // with that id, and so on; null = no id.
        var keysOf = function ( list )
        {
            var n = {};
            return ( list || [] ).map( function ( x )
            {
                var k = id( x );
                if( k === null ) return null;
                n[ k ] = ( n[ k ] || 0 ) + 1;
                return n[ k ] === 1 ? k : k + "\u0001#" + n[ k ];
            } );
        };
        var kB = keysOf( base ), kM = keysOf( mine ), kT = keysOf( theirs );
        var B = {}, M = {}, T = {}, i, k;
        var own = function ( map, key ) { return Object.prototype.hasOwnProperty.call( map, key ); };

        if( base ) for( i = 0; i < base.length; i++ ) if( kB[ i ] !== null ) B[ kB[ i ] ] = base[ i ];
        for( i = 0; i < mine.length;   i++ ) if( kM[ i ] !== null ) M[ kM[ i ] ] = mine[ i ];
        for( i = 0; i < theirs.length; i++ ) if( kT[ i ] !== null ) T[ kT[ i ] ] = theirs[ i ];

        // One key -> the item to keep, or undefined to drop it.
        function pick( k )
        {
            var b = own( B, k ) ? B[ k ] : undefined;
            if( own( M, k ) && own( T, k ) )
            {
                var m = M[ k ], t = T[ k ];
                if( same( m, t ) )                    return m;
                if( b !== undefined && same( b, m ) ) return t;
                if( b !== undefined && same( b, t ) ) return m;
                return both( b, m, t );
            }
            if( own( M, k ) ) return b !== undefined && same( b, M[ k ] ) ? undefined : M[ k ];   // theirs deleted it
            return b !== undefined && same( b, T[ k ] ) ? undefined : T[ k ];                    // mine deleted it
        }

        // Keyless items, by content: in base = "untouched" on a side that has it.
        var had = function ( list, keys, x )
        {
            return !! list && list.some( function ( y, j ) { return keys[ j ] === null && same( x, y ); } );
        };

        var out = [], placed = {};   // out: [ { k, v } ], k null for a keyless item
        for( i = 0; i < mine.length; i++ )
        {
            k = kM[ i ];
            if( k === null )
            {
                if( ! ( had( base, kB, mine[ i ] ) && ! had( theirs, kT, mine[ i ] ) ) ) out.push( { k: null, v: mine[ i ] } );   // else theirs dropped it
                continue;
            }
            placed[ k ] = true;
            var v = pick( k );
            if( v !== undefined ) out.push( { k: k, v: v } );
        }

        // What only theirs has, after its left neighbour in theirs.
        var after = -1;   // index in `out` of the last item of theirs found there
        for( i = 0; i < theirs.length; i++ )
        {
            var t = theirs[ i ], j;
            k = kT[ i ];
            if( k === null )
            {
                j = out.findIndex( function ( x ) { return x.k === null && same( x.v, t ); } );
                if( j !== -1 ) { after = j; continue; }
                if( had( mine, kM, t ) || had( base, kB, t ) ) continue;   // mine dropped it
                out.splice( after + 1, 0, { k: null, v: t } );
                after++;
                continue;
            }
            if( placed[ k ] ) { j = out.findIndex( function ( x ) { return x.k === k; } ); if( j !== -1 ) after = j; continue; }
            placed[ k ] = true;
            var w = pick( k );
            if( w === undefined ) continue;
            out.splice( after + 1, 0, { k: k, v: w } );
            after++;
        }

        return out.map( function ( x ) { return x.v; } );
    }

    // mergeFields( b, m, t, deep ) - one item changed on both sides, key by
    // key: a key only one side changed takes that side; both changed = mine,
    // or deep[ key ]( b[ key ], m[ key ], t[ key ] ) when given. b unknown
    // (null / undefined) = theirs for every key the two hold differently (see
    // "base null" above), deep[ key ] still merging its own.
    function mergeFields( b, m, t, deep )
    {
        var out = {}, keys = {}, k;
        b = b || null;
        for( k in m ) keys[ k ] = true;
        for( k in t ) keys[ k ] = true;

        for( k in keys )
        {
            var hasM = Object.prototype.hasOwnProperty.call( m, k );
            var hasT = Object.prototype.hasOwnProperty.call( t, k );
            var bv   = b ? b[ k ] : undefined;
            if( ! hasT )      { if( ! b || ! same( bv, m[ k ] ) ) out[ k ] = m[ k ]; continue; }
            if( ! hasM )      { if( ! b || ! same( bv, t[ k ] ) ) out[ k ] = t[ k ]; continue; }
            if( same( m[ k ], t[ k ] ) )        out[ k ] = m[ k ];
            else if( b && same( bv, m[ k ] ) )  out[ k ] = t[ k ];
            else if( b && same( bv, t[ k ] ) )  out[ k ] = m[ k ];
            else if( deep && deep[ k ] )        out[ k ] = deep[ k ]( bv, m[ k ], t[ k ] );
            else                                out[ k ] = b ? m[ k ] : t[ k ];
        }
        return out;
    }

    // mergeSets( b, m, t ) - three arrays of plain values (strings, numbers) as
    // sets: added on either side kept, removed on either side removed. Sorted
    // when both sides were.
    function mergeSets( b, m, t )
    {
        b = b || []; m = m || []; t = t || [];
        var out = [], seen = {};
        function key( v ) { return typeof v + ":" + v; }
        var inB = {}, inM = {}, inT = {};
        b.forEach( function ( v ) { inB[ key( v ) ] = true; } );
        m.forEach( function ( v ) { inM[ key( v ) ] = true; } );
        t.forEach( function ( v ) { inT[ key( v ) ] = true; } );
        m.concat( t ).forEach( function ( v )
        {
            var k = key( v );
            if( seen[ k ] ) return;
            seen[ k ] = true;
            if( inM[ k ] && inT[ k ] ) out.push( v );          // on both
            else if( ! inB[ k ] ) out.push( v );              // added by one side
            // else: in base and removed by one side
        } );
        var sorted = function ( a ) { for( var i = 1; i < a.length; i++ ) if( a[ i - 1 ] > a[ i ] ) return false; return true; };
        if( sorted( m ) && sorted( t ) ) out.sort( function ( x, y ) { return x < y ? -1 : x > y ? 1 : 0; } );
        return out;
    }

    // hashText( text ) - a short stable name for a text (two 32-bit FNV-1a
    // hashes, 16 hex digits): a key for an item that has none, the same on
    // every device (shared/ical.js has its own copy, for Node).
    function hashText( text )
    {
        var a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
        text = String( text );
        for( var i = 0; i < text.length; i++ )
        {
            var c = text.charCodeAt( i );
            a = Math.imul( a ^ c, 0x01000193 ) >>> 0;
            b = Math.imul( b ^ c, 0x5bd1e995 ) >>> 0;
        }
        return ( "0000000" + a.toString( 16 ) ).slice( -8 ) + ( "0000000" + b.toString( 16 ) ).slice( -8 );
    }

    window.NayiveStore = { createStore: createStore, me: ME, sendWaiting: sendWaiting,
                           localCount: localCount, clearLocal: clearLocal,
                           mergeLists: mergeLists, mergeFields: mergeFields, mergeSets: mergeSets,
                           hashText: hashText };
} )();
