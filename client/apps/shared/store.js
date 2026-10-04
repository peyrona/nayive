// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
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
 * path. A newer save from the same page replaces the older one (it holds it);
 * a save from ANOTHER page never does (see VERSIONS). A plain store (no
 * `conflicts`) has no conflict resolution: if the same file is edited on
 * another device while this one is offline, the offline device wins on
 * reconnect. The outbox is shared by every store on the origin, so each entry
 * records how it must be sent (bytes or text, with or without its version
 * check) and any page can flush it.
 *
 * CONFLICTS  (opt-in: createStore( { conflicts: true } ) - the office editors)
 * Every save says which version of the file it was made from (VERSIONS below):
 * If-Match with the server's own tag for it, and If-Unmodified-Since with the
 * server's own time (`srv`, taken ONLY from a GET's or a PUT's Last-Modified -
 * never this device's clock; kept for a server from before the tag). A file
 * saved from another device since answers 412: the outbox entry is flagged
 * `conflict`, is never sent again (so no flush can overwrite theirs), and
 * onConflict listeners hear about it. The app resolves it by saving elsewhere
 * and forget()-ing the old path. A file deleted since (also a 412 under
 * If-Match) is made again, create-only - what every save did before the tag.
 *
 * MERGE  (opt-in: createStore( { conflicts: true, merge: fn } ) - 2026-09-28)
 * The small list apps (Habits, Split, Contacts, Calendar, Tasks, Trips, Games)
 * save one whole file, so a phone's offline ticks used to overwrite the PC's.
 * With `merge`, on a 412 the store GETs the server copy and calls
 * fn( path, base, mine, theirs ) - base = the body of the version the queued
 * save was made from (null when unknown). A string back is the merged body: it
 * goes to the cache and the outbox, onMerged( path, body ) listeners reload the
 * app's data, and it goes up checked against the version just read (a few
 * tries). null = the CONFLICTS path above. Every page may flush any entry, but
 * only a page whose store claimed the path (read or wrote it with `merge`) can
 * merge it: elsewhere a 412 just leaves it queued for its own app. So a merging
 * store reads and writes only its own app's files; another app's file is read
 * with GumApi (or a plain store). A plain store's write over a queued merging
 * save keeps it merge-protected (`mrg`, its version check). A merge that said
 * null is tried again each time its app reads the file. The merge's GET is
 * dropped when another account signed in since (whoNow).
 *
 * VERSIONS  (2026-10-02, data-safety A1 A2 E6 K2-K5 L4)
 * The cache and the outbox are shared by every page of the browser, but each
 * page has its OWN model of a file: two tabs, two desktop windows, Planner's
 * pane beside the app itself. The version a save was checked against used to
 * be read from the shared cache at send time - the last version ANY page
 * saved - so the second page's save passed the server's check and silently
 * replaced the first page's work. Now:
 *
 *   - Each page keeps, per path, the version its model came from (`held`):
 *     the server's strong ETag + time + body of its own last read, its own
 *     last good save, or the merge it took in - never another page's.
 *   - write() puts that version ON THE OUTBOX ENTRY, taken when it is called
 *     (a merge landing before the entry is stored must not pass for the
 *     version this body was built from). Whoever sends the entry sends ITS
 *     version. The cache's version is only the fallback for an entry queued by
 *     an older store.js (no version of its own).
 *   - Every entry has an `id`; `inc` lists the entries it took the place of
 *     (it holds their content) and `anc` the versions its body descends from.
 *     A page's next save replaces the queued entry only when that page holds
 *     it (wrote it, or read it). A save sent OK moves the version of the page
 *     that holds it, of a later save of the same page queued meanwhile, and
 *     the cache (`sent` = the ids it took to the server, `last` = the ONE
 *     save the cache's version answers - never one it took in from another
 *     page); other pages keep theirs, so their next save gets 412 -> merge,
 *     or the conflict question.
 *   - Another page's save waiting in the outbox is never replaced: a merging
 *     store merges this page's body into it (from the older of the two bases
 *     when one descends from the other, else with no base, which keeps every
 *     item) and its app reloads (onMerged) - and so does the app of the page
 *     whose save it took in (a "took" message), though that page's next save
 *     stays checked against its own version; a conflicts store
 *     sends this page's save on its own, kept in this page until it is sent
 *     (`direct`), and whichever of the two reaches the server second gets the
 *     conflict question; a plain store replaces it, as it always did. A
 *     refused save is told to the page holding it (onConflict there only), and
 *     conflicted() / forget() mean this page's save, not another window's.
 *   - The cache and the outbox change in ONE transaction (K4): a read never
 *     replaces a cached copy that holds a save still waiting - this page's,
 *     another page's or another account's (K3, L4); a cached copy left dirty
 *     with nothing queued is queued again when its app reads it.
 *   - When the browser's storage fails (full disk, iPhone after resume) the
 *     save goes up directly and is kept in this page only (`pageOnly`) until it
 *     does: write() then answers { ok: false, pageOnly: true } - never "saved"
 *     with nothing kept (K2). The same for a `direct` save not sent yet.
 *   - A save that vanished before it was sent (cleared by a sign-out in another
 *     tab) answers { ok: false, unknown: true } (K5).
 * A page that never read a path (a new name, a path forget()-ten) saves with no
 * check, as before; one whose read found no file saves create-only.
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
 * another tab must still read and send every record. When the path's record
 * holds ANOTHER account's waiting save, this account's goes beside it, under
 * "\u0001<who>\u0001<path>" (altKey), flagged `conflict` for an older store.js
 * so it never sends that key as a file name; its real path and flag are
 * `file` and `xc` (L4).
 * Signing out clears what was counted (localCount / clearLocal / leaveDevice,
 * used by the launcher).
 *
 * AN ADMIN RENAME  (2026-10-02, data-safety L3)
 * Saves queued here before the admin renamed ana to ana2 carry "user:ana":
 * nobody's any more, so a page of ana2 never sent or showed them, and the
 * sign-out deleted them. The server hands the account's old names in the
 * readable "nayive_was" cookie ("user:ana2/user:ana", server/go/
 * store_owner.go). When its first name is THIS page's owner (ME), the
 * records of those old names - queued saves, cached copies, device drafts -
 * are re-tagged to ME once, before this page touches any of them. Never for
 * another account: a cookie that does not start with ME changes nothing.
 *
 * CREATE-ONLY AND REPLACE  (2026-10-02, data-safety D6)
 * write( path, body, { createOnly: true } ) is made from "no file there"
 * (If-None-Match: *) whatever this page held: a new name the page could not
 * check (offline, the listing failed) is never written over a file another
 * device put there - the server answers 412 and it is held back as a
 * conflict, for the app to ask. { replace: true } is the user's answer
 * "replace it": no check, and a held-back save goes again.
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
    var KEEP_IDS          = 50;     // ids an entry remembers it took the place of (VERSIONS)
    var KEEP_ANC          = 20;     // versions an entry remembers its body descends from

    // Page-wide, shared by every store on the page (the outbox is shared too):
    var inflight = {};   // path -> the PUT being sent for it; one at a time per path
    var writeSeq = {};   // path -> count of write() calls, so a read can see one land mid-GET
    var writing  = {};   // path -> the cache/outbox update of the latest write()
    var blocked  = {};   // path -> "unread" | "bad": writes refused (see block())
    var loaded   = {};   // path -> a read() of it has succeeded on this page
    var firstOut = {};   // path -> reads out before the first success: writes refused
    var mergers  = {};   // path -> { fn, fire, get } of the store that merges it (see MERGE)
    var held     = {};   // path -> the version THIS page's model came from (VERSIONS)
    var seen     = {};   // path -> count of changes to this page's model (a read, a write, a merge taken in)
    var pageOnly = {};   // path -> a save kept only in this page: the browser's storage failed (K2)
    var savedFns = [];   // onSaved listeners of every store on the page
    var needsApp = {};   // path -> a merging save this page could not merge (412, no merger): its app must (L6)
    var toastAt  = 0;
    var lastQ    = 0;

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

    // The names an admin rename took from THIS page's owner (AN ADMIN RENAME):
    // the "nayive_was" cookie's names after its first, only when that first
    // one is ME. [] = none (no cookie, or another account's).
    var WAS = ( function ()
    {
        try
        {
            var m = document.cookie.match( /(?:^|;\s*)nayive_was=([^;]*)/ );
            var l = m && m[ 1 ] ? m[ 1 ].split( "/" ) : [];
            return ME && l.length > 1 && l[ 0 ] === ME ? l.slice( 1 ).filter( function ( w ) { return w && w !== ME; } ) : [];
        }
        catch ( e ) { return []; }
    } )();

    //------------------------------------------------------------------------//
    // VERSIONS AND ENTRIES  (see VERSIONS above)
    //
    // A version: { tag, srv, base, none } - the server's strong ETag, its
    // Last-Modified (ms), the text the server held then (null = unknown), and
    // `none` = there was no file. Records keep them as fields of their own.

    function newId() { return Date.now().toString( 36 ) + "-" + Math.random().toString( 36 ).slice( 2, 10 ); }

    // A queuedAt no other save of this page shares: an older store.js tells
    // entries apart by it.
    function nextQueuedAt()
    {
        var t = Date.now();
        lastQ = t > lastQ ? t : lastQ + 1;
        return lastQ;
    }

    // Only a strong tag goes back as If-Match: the server refuses every save
    // whose If-Match it cannot match exactly (a weak one included).
    function strongTag( t ) { return typeof t === "string" && /^"[^"]*"$/.test( t ) ? t : null; }

    function verOf( r )
    {
        r = r || {};
        return { tag: strongTag( r.tag ), srv: r.srv || null, base: typeof r.base === "string" ? r.base : null, none: !! r.none };
    }

    // The version's name, to compare two ("" = unknown).
    function vkey( v ) { return ! v ? "" : v.tag ? "t" + v.tag : v.srv ? "s" + v.srv : v.none ? "none" : ""; }

    function setVer( rec, v )
    {
        rec.tag  = v.tag || null;
        rec.srv  = v.srv || null;
        rec.tsrv = v.srv || null;   // the time the tag came with (docVer)
        rec.base = v.base == null ? undefined : v.base;
        rec.none = !! v.none;
        return rec;
    }

    // The version a cached copy holds. Its tag only while its time is the one
    // the tag came with: an older store.js moves `srv` alone, and the tag then
    // names a version that is not the copy's any more.
    function docVer( d )
    {
        var base = typeof d.base === "string" ? d.base
                 : d.dirty === false && typeof d.body === "string" ? d.body : null;   // a clean copy of an older store.js: its body IS what the server had
        return { tag: d.tsrv === d.srv ? strongTag( d.tag ) : null, srv: d.srv || null, base: base, none: !! d.none };
    }

    // The version an entry was made from. One queued by an older store.js has
    // none of its own: then the cached copy's, as that store.js sent it.
    function entryVer( e, doc )
    {
        if( e.ver ) return verOf( e );
        if( doc && ( ! doc.who || ! e.who || doc.who === e.who ) ) return docVer( doc );
        return verOf( null );
    }

    function idOf( e ) { return e.id || "q" + e.queuedAt; }
    function sameEntry( a, b ) { return !! a && !! b && idOf( a ) === idOf( b ); }

    // This page's model holds the queued entry `e`: it wrote or read it, or a
    // save of its own took its place.
    function holds( h, e ) { return !! h && !! h.id && !! e && ( h.id === idOf( e ) || ( h.inc || [] ).indexOf( idOf( e ) ) !== -1 ); }

    function keepIds( e ) { return ( e.inc || [] ).concat( [ idOf( e ) ] ).slice( -KEEP_IDS ); }

    function addKeys( list, more )
    {
        var out = ( list || [] ).slice();
        more.forEach( function ( k ) { if( k && out.indexOf( k ) === -1 ) out.push( k ); } );
        return out.slice( -KEEP_ANC );
    }

    // What this page holds once its model is entry `e` (its body kept by
    // reference, to know a cached copy of it again: freshEntry).
    function heldOf( e ) { return Object.assign( verOf( e ), { id: idOf( e ), inc: e.inc || [], anc: e.anc || [], body: e.body } ); }

    // Two bodies, text or bytes, the same.
    function sameBody( a, b )
    {
        if( typeof a === "string" || typeof b === "string" ) return a === b;
        if( ! ( a instanceof Uint8Array ) || ! ( b instanceof Uint8Array ) || a.length !== b.length ) return false;
        for( var i = 0; i < a.length; i++ ) if( a[ i ] !== b[ i ] ) return false;
        return true;
    }

    // This page's model of `path` changed (a read handed it, a merge was
    // taken in): `h` is what it holds now.
    function setHeld( path, h )
    {
        held[ path ] = h;
        seen[ path ] = ( seen[ path ] || 0 ) + 1;
    }

    // The cached copy knows `id` went to the server: `sent` = every save it
    // saw go up, with the saves each one held (their content went up too);
    // `last` = the ONE save its version is the answer to, exactly as it went
    // up. Never a save it held: a save that took another page's place (a
    // merge, a page that read it and added) holds content that page never saw
    // - that page's next save must be checked against its own version, or it
    // passes and drops it.
    function wasSent( doc, id ) { return !! doc && ours( doc ) && ( doc.sent || [] ).indexOf( id ) !== -1; }
    function lastSent( doc, id ) { return !! doc && ours( doc ) && ! doc.dirty && ( doc.last || [] ).indexOf( id ) !== -1; }

    // The cached copy is clean and what the server got last is exactly
    // `body`: it went up (sent by a page that keeps no `sent` - an older
    // store.js, open across a deploy). Its `base`, not its body: an older
    // store.js that sends a save moves the copy's time and base, and leaves a
    // body its own read may have put there - an older one.
    function upAsIs( doc, body )
    {
        return !! doc && ours( doc ) && doc.dirty === false && body != null &&
               sameBody( typeof doc.base === "string" ? doc.base : doc.body, body );
    }

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
            return idbReq( db.transaction( storeName, "readonly" ).objectStore( storeName ).getAll() ).catch( function () { return []; } );
        }
        catch ( e ) { return Promise.resolve( [] ); }
    }

    // ANOTHER ACCOUNT'S SLOT (WHOSE SAVE, L4): where this account's record goes
    // when the path's own record holds another account's waiting save.
    function altKey( path ) { return "\u0001" + ME + "\u0001" + path; }

    // A record as stored -> as the code uses it (its real path and conflict
    // flag), always a copy: the in-memory stores hand out their own objects.
    function norm( raw )
    {
        if( ! raw ) return raw;
        var e = Object.assign( {}, raw );
        if( raw.file )
        {
            e.path     = raw.file;
            e.conflict = !! raw.xc;
            delete e.file;
            delete e.xc;
        }
        return e;
    }

    // ...and back, to be stored at `key`.
    function denorm( e, key )
    {
        var r = Object.assign( {}, e );
        if( key === e.path ) { delete r.file; delete r.xc; return r; }
        r.path     = key;
        r.file     = e.path;
        r.xc       = !! e.conflict;
        r.conflict = true;   // an older store.js never sends an entry held back as a conflict
        return r;
    }

    // ONE TRANSACTION over the cache and the outbox for one path (K3, K4): the
    // cached copy and this account's queued save are read, fn( c ) decides, and
    // both change together or not at all.
    //   c.doc   the cached copy (any account's), c.out this account's queued
    //           save (normalised), c.slot the record in the path's own slot
    //           (any account's)
    //   fn returns { doc, out, ret }: a record to put, null to delete,
    //   undefined to leave; `ret` is what the promise gives back.
    // Resolves { ok: true, ret } once committed, { ok: false } when the
    // browser's storage failed (a throw, an abort, a full disk) - never
    // "nothing there" for "could not read" (K2).
    function pathTx( db, path, mode, fn )
    {
        var alt = ME ? altKey( path ) : null;

        function apply( doc, slot, altRec, writer )
        {
            var own = slot && ours( slot ) ? slot : ( altRec && ours( altRec ) ? altRec : undefined );
            var r   = fn( { doc: doc ? Object.assign( {}, doc ) : doc, out: norm( own ), slot: slot } ) || {};

            if( writer )
            {
                if( r.doc === null ) writer.del( DOCS, path );
                else if( r.doc )     writer.put( DOCS, r.doc );

                if( r.out !== undefined )
                {
                    // Its own record's place; the path's slot when that is free.
                    var key = own ? own.path : ( slot && ! ours( slot ) && alt ? alt : path );
                    if( r.out === null ) writer.del( OUTBOX, key );
                    else                 writer.put( OUTBOX, denorm( r.out, key ) );
                }
            }
            return r.ret;
        }

        if( ! db )
        {
            try
            {
                var mo  = memStore( OUTBOX );
                var ret = apply( memStore( DOCS ).get( path ), mo.get( path ), alt ? mo.get( alt ) : undefined,
                                 mode === "readwrite" ? { put: function ( s, r ) { memStore( s ).set( r.path, r ); },
                                                          del: function ( s, k ) { memStore( s ).delete( k ); } } : null );
                return Promise.resolve( { ok: true, ret: ret } );
            }
            catch ( e ) { return Promise.resolve( { ok: false } ); }
        }

        return new Promise( function ( resolve )
        {
            var over = false, bad = false, ret;
            function end( v ) { if( ! over ) { over = true; resolve( v ); } }

            try
            {
                var tx = db.transaction( [ DOCS, OUTBOX ], mode );
                var ds = tx.objectStore( DOCS ), os = tx.objectStore( OUTBOX );
                var rD = ds.get( path ), rP = os.get( path ), rA = alt ? os.get( alt ) : null;
                var left = rA ? 3 : 2;
                var step = function ()
                {
                    if( --left ) return;
                    try
                    {
                        ret = apply( rD.result, rP.result, rA ? rA.result : undefined,
                                     mode === "readwrite" ? { put: function ( s, r ) { tx.objectStore( s ).put( r ); },
                                                              del: function ( s, k ) { tx.objectStore( s ).delete( k ); } } : null );
                    }
                    catch ( e )
                    {
                        bad = true;
                        try { tx.abort(); } catch ( e2 ) {}
                    }
                };
                rD.onsuccess = rP.onsuccess = step;
                if( rA ) rA.onsuccess = step;
                tx.oncomplete = function () { end( bad ? { ok: false } : { ok: true, ret: ret } ); };
                tx.onerror = tx.onabort = function () { end( { ok: false } ); };
            }
            catch ( e ) { end( { ok: false } ); }
        } );
    }

    // This account's queued saves (normalised), every path.
    async function ownEntries( db )
    {
        return ( await idbGetAll( db, OUTBOX ) ).filter( ours ).map( norm );
    }

    //------------------------------------------------------------------------//
    // AN ADMIN RENAME  (see the top): the old names' records become ME's -
    // once per page, before this page reads any of them (createStore's
    // database and the sign-out's count wait for it). Re-run on every load
    // that has the cookie: it finds nothing left to change.

    var retagged = WAS.length ? retag() : Promise.resolve();

    // "user:ana" -> "ana": the account's name itself, which Chat ("u:ana")
    // and eMail ("ana") tag their device drafts with.
    function rawName( who )
    {
        try { return decodeURIComponent( who ).replace( /^user:/, "" ); }
        catch ( e ) { return ""; }
    }

    async function retag()
    {
        try
        {
            var db = await openDb();
            if( db )
            {
                await new Promise( function ( resolve )
                {
                    try
                    {
                        var tx = db.transaction( [ DOCS, OUTBOX ], "readwrite" );
                        var os = tx.objectStore( OUTBOX ), ds = tx.objectStore( DOCS );
                        var oq = os.getAll(), dq = ds.getAll();
                        oq.onsuccess = function ()
                        {
                            var all = oq.result || [], keys = {}, mine = {};
                            all.forEach( function ( r ) { keys[ r.path ] = true; if( r.who === ME ) mine[ r.file || r.path ] = true; } );
                            all.forEach( function ( r )
                            {
                                if( WAS.indexOf( r.who ) === -1 ) return;
                                var real = r.file || r.path;
                                // ME's own save of that file waits already: one
                                // account keeps one save per file, and the two
                                // cannot be merged here - the old one stays as it
                                // is (the sign-out still counts it).
                                if( mine[ real ] ) return;
                                mine[ real ] = true;
                                var e = norm( r );
                                e.who = ME;
                                if( r.path === real ) { os.put( denorm( e, real ) ); return; }
                                // It waited beside another account's save (L4):
                                // ME's own place now - the path's slot once that is free.
                                os.delete( r.path );
                                os.put( denorm( e, keys[ real ] ? altKey( real ) : real ) );
                            } );
                        };
                        dq.onsuccess = function ()
                        {
                            ( dq.result || [] ).forEach( function ( d ) { if( WAS.indexOf( d.who ) !== -1 ) { d.who = ME; ds.put( d ); } } );
                        };
                        tx.oncomplete = tx.onerror = tx.onabort = function () { resolve(); };
                    }
                    catch ( e ) { resolve(); }
                } );
                db.close();
            }

            // The device drafts: the office editors' (tagged like the saves),
            // Chat's outbox ("u:<name>") and eMail's ("<name>").
            var olds = WAS.map( rawName ), me = rawName( ME );
            var drafts = await openDraftsDb();
            await oneTx( drafts, "drafts", "readwrite", function ( os )
            {
                var rq = os.getAll();
                rq.onsuccess = function ()
                {
                    ( rq.result || [] ).forEach( function ( r )
                    {
                        var app = String( r.app || "" ), who = r.who;
                        if( WAS.indexOf( who ) !== -1 )                                                  r.who = ME;
                        else if( app.indexOf( "chat:" ) === 0 && olds.indexOf( String( who ).slice( 2 ) ) !== -1 &&
                                 String( who ).indexOf( "u:" ) === 0 )                                    r.who = "u:" + me;
                        else if( app.indexOf( "email:" ) === 0 && olds.indexOf( who ) !== -1 )           r.who = me;
                        else return;
                        os.put( r );
                    } );
                };
                return rq;
            } );
            if( drafts ) drafts.close();
        }
        catch ( e ) {}
    }

    //------------------------------------------------------------------------//
    // "SAVED" FROM ANY PAGE  (onSaved, and the version of the page that holds it)
    //
    // A save sent OK by any page of this browser is told to every page: the
    // one holding it (it wrote it, or a save of its own was built on it - also
    // one still being stored) and made from the same version takes the
    // server's new version; onSaved listeners hear about it.
    // m = { path, who, id, rebased, prev, tag, srv, body } - prev = the version
    // the save was made from, body null for bytes (not shipped across pages).

    var lastSaved = {};   // path -> the last save heard of: { id, prev, tag, srv, base } (write()'s page-only race)

    var channel = null;
    try { if( typeof BroadcastChannel === "function" ) channel = new BroadcastChannel( "nayive-store" ); }
    catch ( e ) { channel = null; }
    if( channel ) channel.onmessage = function ( ev )
    {
        var m = ev.data || {};
        if( m.t === "saved" )    heardSaved( m, m.body );
        if( m.t === "conflict" ) heardConflict( m );
        if( m.t === "took" )     heardTook( m );
    };

    // A save kept only in this page (`pageOnly`: the browser's storage failed,
    // or another page's save held the outbox, and the server was not reached)
    // is lost with the page: leaving it asks first - in every app, not only
    // the office editors, which ask on their own.
    try
    {
        window.addEventListener( "beforeunload", function ( e )
        {
            if( ! Object.keys( pageOnly ).length ) return;
            e.preventDefault();
            e.returnValue = "";
        } );

        // A desktop window's (x) removes its frame with no beforeunload: the
        // desktop asks window.nayiveBeforeClose instead (desktop/index.html,
        // close). This one answers for every app that has none of its own -
        // the office editors, Image and eMail set theirs later, over it.
        if( typeof window.nayiveBeforeClose !== "function" )
            window.nayiveBeforeClose = function ()
            {
                if( ! Object.keys( pageOnly ).length ) return true;
                if( ! window.NayiveUI || ! NayiveUI.confirm || ! NayiveUI.t ) return false;
                return NayiveUI.confirm( { title: NayiveUI.t( "drive.unsavedTitle" ), body: NayiveUI.t( "ui.store.pageOnly" ),
                                           confirm: NayiveUI.t( "drive.closeWithout" ), danger: true } );
            };
    }
    catch ( e ) {}

    function heardSaved( m, body )
    {
        if( m.who && ME && m.who !== ME ) return;
        var h    = held[ m.path ];
        var base = typeof body === "string" ? body : null;
        var mine = !! h && ( holds( h, { id: m.id } ) || ( !! m.rebased && holds( h, { id: m.rebased } ) ) );

        if( mine && vkey( h ) === m.prev )
            held[ m.path ] = Object.assign( {}, h, verOf( { tag: m.tag, srv: m.srv, base: base } ), { anc: addKeys( h.anc, [ m.prev ] ) } );
        // A save of this page kept here and built on that one, from the same
        // version: made from the answer now (as saved() does for a queued one).
        var po = pageOnly[ m.path ];
        if( po && idOf( po ) !== m.id && ( po.inc || [] ).indexOf( m.id ) !== -1 && vkey( po ) === m.prev )
            pageOnly[ m.path ] = setVer( Object.assign( {}, po, { anc: addKeys( po.anc, [ m.prev ] ) } ), { tag: m.tag, srv: m.srv, base: base } );
        lastSaved[ m.path ] = { id: m.id, rebased: m.rebased, prev: m.prev, tag: m.tag, srv: m.srv, base: base };
        savedFns.forEach( function ( fn ) { try { fn( m.path, body, m.tag, mine ); } catch ( e ) {} } );
    }

    function toldSaved( m, body )
    {
        heardSaved( m, body );
        if( ! channel ) return;
        try { channel.postMessage( Object.assign( { t: "saved" }, m, { body: typeof body === "string" ? body : null } ) ); }
        catch ( e ) {}
    }

    // A save refused as changed elsewhere (CONFLICTS) is told to the page
    // whose model holds it - this one or another: any page may have sent it.
    // Only there do onConflict listeners hear it (a Write window must not ask
    // about another window's save).
    var conflictHub = [];   // each store's onConflict listeners

    function heardConflict( m )
    {
        if( m.who && ME && m.who !== ME ) return;
        if( ! holds( held[ m.path ], { id: m.id } ) ) return;
        conflictHub.forEach( function ( fn ) { try { fn( m.path ); } catch ( e ) {} } );
    }

    function toldConflict( path, entry )
    {
        var m = { path: path, who: entry.who || ME, id: idOf( entry ) };
        heardConflict( m );
        if( ! channel ) return;
        try { channel.postMessage( Object.assign( { t: "conflict" }, m ) ); }
        catch ( e ) {}
    }

    // A queued save took the place of saves it holds - another page's save
    // merged in, or one this page read and added to. A page whose model is
    // one of those (and whose app merges this file) is handed the new body
    // (onMerged): its screen shows what the other page added. Its version
    // stays the one its model came from - its next save is checked against
    // that and merged, so nothing is lost even where an app takes a merged
    // body in only in part.
    function heardTook( m )
    {
        if( m.who && ME && m.who !== ME ) return;
        var h  = held[ m.path ];
        var mg = mergers[ m.path ];
        if( ! mg || typeof m.body !== "string" || ! h || ! h.id || h.id === m.id || ( m.inc || [] ).indexOf( h.id ) === -1 ) return;
        mg.fire( m.path, m.body );
    }

    function toldTook( path, e )
    {
        if( ! channel || typeof e.body !== "string" || ! ( e.inc || [] ).length ) return;
        try { channel.postMessage( { t: "took", path: path, who: e.who || ME, id: idOf( e ), inc: e.inc, body: e.body } ); }
        catch ( err ) {}
    }

    //------------------------------------------------------------------------//
    // THE STORE

    function createStore( opts )
    {
        opts = opts || {};

        var api       = opts.apiBase || ( window.location.origin + "/api/files" );
        var binary    = !! opts.binary;   // body is raw bytes (Uint8Array), not text
        var mergeFn   = typeof opts.merge === "function" ? opts.merge : null;   // see MERGE above
        var conflicts = !! opts.conflicts || !! mergeFn; // send the version check (see CONFLICTS above)
        var listeners = [];
        var conflictFns = [];
        var mergedFns   = [];
        var state     = "init";
        var flushTimer = null;
        var flushing   = false;

        // After the re-tag of an admin rename (AN ADMIN RENAME): this page's
        // saves of the old name are its own before it reads anything.
        var dbPromise = retagged.then( openDb );

        conflictHub.push( function ( p ) { conflictFns.forEach( function ( fn ) { try { fn( p ); } catch ( e ) {} } ); } );

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
            var here    = Object.keys( pageOnly ).map( function ( k ) { return pageOnly[ k ]; } );
            // Another window's save held back as a conflict waits for THAT
            // window: not this page's conflict, nor anything to send.
            var pending = ( await ownEntries( db ) ).filter( function ( e ) { return ! e.conflict || holds( held[ e.path ], e ); } )
                                                     .concat( here );

            if( pending.some( function ( e ) { return e.conflict; } ) ) emit( "conflict" );
            else if( here.length )          emit( "error" );   // kept only in this page (K2): not safe, never "offline"
            else if( pending.length === 0 ) emit( navigator.onLine ? "synced"  : "offline" );
            else                            emit( navigator.onLine ? "pending" : "offline" );
        }

        //--------------------------------------------------------------------//
        // NETWORK

        // Same retry shape as the apps' old fetchIt(): two retries, only for a
        // thrown TypeError - a genuine connectivity drop, whatever the browser
        // calls it (Chrome "Failed to fetch", Safari "Load failed", Firefox
        // "NetworkError...") - never for an HTTP error status. Only GET, HEAD
        // and PUT come through here, and all are safe to send twice.
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

                // The service worker's offline copy of a trip document (sw.js,
                // tripDocOrNetwork) is not the server's version: as offline (B6).
                if( r.headers.get( "X-Nayive-Copy" ) ) return { ok: false, status: 0, netError: true };

                if( r.ok )
                {
                    var body  = binary ? new Uint8Array( await r.arrayBuffer() ) : await r.text();
                    var srv   = Date.parse( r.headers.get( "Last-Modified" ) ) || null;
                    var mtime = srv || Date.now();

                    return { ok: true, status: r.status, body: body, mtime: mtime, srv: srv, tag: strongTag( r.headers.get( "ETag" ) ) };
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

        // Is the file there? The status of a HEAD (0 = not reached).
        async function netHead( path )
        {
            try { return ( await netFetch( api + "?file=" + encodeURIComponent( path ), { method: "HEAD" } ) ).status; }
            catch ( e ) { return 0; }
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

        // `v` (a version, or null = no check) is what the save was made from:
        // If-Match = its tag, If-Unmodified-Since = its time (a server from
        // before the tag judges by that; with both, If-Match decides), and
        // If-None-Match: * when it was made from no file (create only). The
        // answer's ETag and Last-Modified come back as the NEW version.
        async function netPut( path, body, v, bin, who )
        {
            try
            {
                var packed  = await gzipBody( body, bin );
                var headers = {};

                if( packed ) headers[ "Content-Encoding" ] = "gzip";
                if( v && v.tag )  headers[ "If-Match" ] = v.tag;
                if( v && v.srv )  headers[ "If-Unmodified-Since" ] = new Date( v.srv ).toUTCString();
                if( v && v.none ) headers[ "If-None-Match" ] = "*";
                if( who )    headers[ "X-Nayive-User" ] = who;

                var r = await netFetch( api + "?file=" + encodeURIComponent( path ),
                                        { method: "PUT", headers: headers, body: packed || body } );

                if( r.ok )
                    return { ok: true, status: r.status, srv: Date.parse( r.headers.get( "Last-Modified" ) ) || null,
                             tag: strongTag( r.headers.get( "ETag" ) ) };

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
        //
        // What a read hands back becomes this page's model, so its version is
        // what this page's next save is made from (`held`, VERSIONS).
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

        // A save that waits to go up is this page's model from now on - and the
        // version it was made from is this page's: one queued by an older
        // store.js carries none of its own, so the cached copy's, as that
        // store.js would send it (a page holding no version saves unchecked).
        function adopt( path, e, doc )
        {
            var h = heldOf( e );
            if( ! e.ver ) Object.assign( h, entryVer( e, doc ) );
            setHeld( path, h );
        }

        // A cached copy is this page's model: its version, no queued save held.
        function fromCache( path, d ) { setHeld( path, Object.assign( docVer( d ), { id: null, inc: [], anc: [] } ) ); }

        // This page's own latest copy of `path`: a save kept here, its queued
        // save, or the cached copy.
        async function ownCopy( db, path )
        {
            if( pageOnly[ path ] ) return pageOnly[ path ];
            var r = await pathTx( db, path, "readonly", function ( c )
            {
                return { ret: c.out || ( c.doc && ours( c.doc ) ? c.doc : null ) };
            } );
            return r.ok ? r.ret : null;
        }

        // A cached copy left dirty with nothing queued (a save an older store.js
        // stored in two steps, cut in between): queued again, from the version
        // it was made from (K4).
        function requeued( doc )
        {
            var e = { path: doc.path, body: doc.body, queuedAt: nextQueuedAt(), conflict: false,
                      bin: doc.body instanceof Uint8Array, ius: conflicts || !! ( doc.tag || doc.srv ), who: doc.who || ME,
                      mrg: !! mergeFn, ver: 1, id: newId(), inc: [], anc: [] };
            return setVer( e, docVer( doc ) );
        }

        async function readNow( path )
        {
            // A write() from here on is seen after the GET (writeSeq); one that
            // started just before is waited for, so its outbox entry is found.
            var seq    = writeSeq[ path ] || 0;
            if( writing[ path ] ) { try { await writing[ path ]; } catch ( e ) {} }
            var db     = await dbPromise;

            // The cached copy and the queued save, in one look. A merge that said
            // null (MERGE) is tried again each time its app opens the file: the
            // other side may be fine by now.
            var look = await pathTx( db, path, "readwrite", function ( c )
            {
                var doc = c.doc && ours( c.doc ) ? c.doc : null;
                var out = c.out;

                if( ! out && doc && doc.dirty && ! doc.refused )
                {
                    out = requeued( doc );
                    return { out: out, ret: { doc: doc, out: out } };
                }
                if( out && out.conflict && out.mrg && mergeFn )
                {
                    out = Object.assign( {}, out, { conflict: false } );
                    return { out: out, ret: { doc: doc, out: out } };
                }
                return { ret: { doc: doc, out: out } };
            } );
            var cached = look.ok ? look.ret.doc : null;
            var queued = pageOnly[ path ] || ( look.ok ? look.ret.out : null );

            // A not-yet-flushed local write is the truth - never let a network
            // GET clobber the user's pending edit on screen. Its body, not the
            // cached one: the two differ when another page cached a read over it.
            if( queued )
            {
                scheduleFlush();
                adopt( path, queued, cached );
                emit( navigator.onLine ? "pending" : "offline" );
                return { body: queued.body, source: "cache",
                         mtime: cached && cached.body === queued.body ? cached.mtime : queued.queuedAt };
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
                    var mine = await ownCopy( db, path );
                    scheduleFlush();
                    if( mine ) return { body: mine.body, source: "cache", mtime: mine.mtime || mine.queuedAt };
                }

                if( res.ok )
                {
                    // Checked again INSIDE the transaction: a write() that lands
                    // now must not have its edit replaced by this body. Nor may a
                    // save another page - or another account - queued meanwhile:
                    // its cached copy stays, and a save of this account's is what
                    // this page shows (K3, L4).
                    var put = await pathTx( db, path, "readwrite", function ( c )
                    {
                        if( ( writeSeq[ path ] || 0 ) !== seq ) return { ret: {} };
                        if( c.out ) return { ret: { queued: c.out, doc: c.doc && ours( c.doc ) ? c.doc : null } };
                        if( c.slot || ( c.doc && c.doc.dirty ) ) return { ret: {} };

                        // `base` for every text file, merging store or not: a
                        // plain store (Drive's import) reading a merged path must
                        // not leave it without one (see MERGE).
                        var d = setVer( { path: path, body: res.body, mtime: res.mtime, cachedAt: Date.now(), dirty: false, who: ME },
                                        { tag: res.tag, srv: res.srv, base: typeof res.body === "string" ? res.body : null } );
                        // What the cache knows went up stays known; the save its
                        // version answers, while it is the same version.
                        if( c.doc && ours( c.doc ) )
                        {
                            d.sent = c.doc.sent;
                            if( vkey( docVer( c.doc ) ) === vkey( docVer( d ) ) ) d.last = c.doc.last;
                        }
                        return { doc: d, ret: {} };
                    } );

                    if( ( writeSeq[ path ] || 0 ) !== seq )
                    {
                        try { await writing[ path ]; } catch ( e ) {}
                        var newer = await ownCopy( db, path );
                        scheduleFlush();
                        if( newer ) return { body: newer.body, source: "cache", mtime: newer.mtime || newer.queuedAt };
                    }

                    if( put.ok && put.ret.queued )
                    {
                        var q = put.ret.queued;
                        adopt( path, q, put.ret.doc );
                        scheduleFlush();
                        emit( navigator.onLine ? "pending" : "offline" );
                        return { body: q.body, source: "cache", mtime: q.queuedAt };
                    }

                    setHeld( path, { id: null, inc: [], anc: [], tag: res.tag, srv: res.srv,
                                     base: typeof res.body === "string" ? res.body : null, none: false } );
                    scheduleFlush();               // other paths may still be queued
                    emit( "synced" );
                    return { body: res.body, source: "network", mtime: res.mtime };
                }

                if( res.status === 404 || res.missing )
                {
                    // Reachable server, file absent - safe first run. The cache
                    // (if any) is left in place rather than wiped on the server's
                    // say-so. This page's next save makes it, create-only.
                    if( ( writeSeq[ path ] || 0 ) === seq )
                        setHeld( path, { id: null, inc: [], anc: [], tag: null, srv: null, base: null, none: true } );
                    emit( "synced" );
                    return { body: null, source: "empty" };
                }

                if( res.needsAuth )
                {
                    emit( "needs-auth" );

                    if( cached )
                    {
                        fromCache( path, cached );
                        return { body: cached.body, source: "cache", mtime: cached.mtime };
                    }

                    return { body: null, source: "unauth" };
                }

                // some other HTTP error, or the fetch threw
                if( cached )
                {
                    fromCache( path, cached );
                    emit( res.netError ? "offline" : "error" );
                    return { body: cached.body, source: "cache", mtime: cached.mtime };
                }

                emit( res.netError ? "offline" : "error" );
                return { body: null, source: "unknown" };
            }

            // offline
            if( cached )
            {
                fromCache( path, cached );
                emit( "offline" );
                return { body: cached.body, source: "cache", mtime: cached.mtime };
            }

            emit( "offline" );
            return { body: null, source: "unknown" };
        }

        //--------------------------------------------------------------------//
        // WRITE

        // Caches the body, queues the PUT, tries to flush now. Resolves after the
        // attempt with { ok, offline?, needsAuth?, forbidden?, conflict?,
        // pageOnly?, unknown? }. The caller does not need to await it - the local
        // copy is already safe once this returns or not; `pageOnly` (the
        // browser's storage failed and the server was not reached: the save is
        // only in this page) and `unknown` (it vanished before it was sent) are
        // NOT safe, and say so by setting none of offline / needsAuth.
        //
        // The version check and a conflict flag survive the rewrite: a
        // conflicted file keeps collecting the user's edits locally, and none of
        // them goes up until the app has resolved it.
        //
        // opts.createOnly / opts.replace: see CREATE-ONLY AND REPLACE above.
        async function write( path, body, opts )
        {
            var how     = opts && opts.createOnly ? "create" : opts && opts.replace ? "replace" : "";
            var refused = isBlocked( path );

            if( refused )
            {
                refusedToast( refused );
                emit( "error" );
                return { ok: false, blocked: refused };
            }

            loaded[ path ] = true;   // this page now holds the file's content: later reads are RE-reads
            claim( path );

            // What this body was built from, taken NOW (VERSIONS): a merge that
            // lands before the outbox is updated moves `held`, not this body. From
            // here on this page's model is this body, whatever the outbox says:
            // the next write() is built on it - and holds what this one held (a
            // save of it sent meanwhile moves this page's version: heardSaved).
            var basis = held[ path ] || null;
            var id    = newId();
            var now   = nextQueuedAt();
            var b0    = basis || { id: null, inc: [], anc: [] };
            setHeld( path, Object.assign( {}, b0, { id: id, body: body,
                                                    inc: b0.id ? [ b0.id ].concat( b0.inc || [] ).slice( -KEEP_IDS ) : ( b0.inc || [] ) } ) );
            var mark  = seen[ path ];

            // Counted and started in the same tick, so a read() whose GET is out
            // sees this write and waits for it (see readNow). The body goes to
            // the browser's storage at once - also while a merge waits for a
            // slow network (E6): a page closed meanwhile keeps it.
            writeSeq[ path ] = ( writeSeq[ path ] || 0 ) + 1;
            var queued = ( async function ()
            {
                var db   = await dbPromise;
                var made = null;
                var r    = await pathTx( db, path, "readwrite", function ( c )
                {
                    made = queueIn( c, path, body, basis, id, now, how );
                    return made.tx;
                } );
                // The browser's storage failed (K2): the save is kept in this page.
                if( ! r.ok ) made = queueIn( {}, path, body, basis, id, now, how );
                return { made: made, stored: r.ok };
            } )();

            writing[ path ] = queued;
            var q = await queued;
            var m = q.made;
            var e = m.entry;

            // Kept in this page until it is sent: the browser's storage failed
            // (K2), or another page's save holds the outbox (`direct`). Queued:
            // it holds whatever this page kept before.
            var here = ! q.stored || !! m.direct;
            if( here )
            {
                // A save this one holds went up while it was being made, from the
                // same version: this one is made from the answer (as saved() does
                // for a queued one), or it would meet a 412 against itself.
                var ls = lastSaved[ path ];
                if( ls && ( e.inc || [] ).indexOf( ls.id ) !== -1 && vkey( e ) === ls.prev )
                    setVer( Object.assign( e, { anc: addKeys( e.anc, [ ls.prev ] ) } ), { tag: ls.tag, srv: ls.srv, base: ls.base } );
                pageOnly[ path ] = e;
            }
            else
            {
                delete pageOnly[ path ];
                toldTook( path, e );   // the pages whose save this one holds are handed it
            }

            if( m.merged != null )
            {
                // Another page's save, taken in: the app shows both - and, when a
                // merge of this page's landed meanwhile, this body's edits again.
                setHeld( path, heldOf( e ) );
                fireMerged( path, m.merged );
            }
            else if( seen[ path ] === mark ) held[ path ] = heldOf( e );   // nothing newer on this page: its model is this save

            if( e.conflict )
            {
                emit( "conflict" );
                return { ok: false, conflict: true };
            }

            emit( "saving" );
            var res = await flushPath( path, { id: idOf( e ), body: e.body } );

            // Not sent and kept nowhere but here: never "saved" (none of
            // offline / needsAuth, which the apps take as "safe on this device"),
            // and the plug never says "offline - saved when you reconnect".
            if( here && ! res.ok )
            {
                if( res.superseded ) return { ok: false, pageOnly: true };   // a newer save of this page goes next: its answer tells
                if( res.conflict ) emit( "conflict" );
                else { pageOnlyToast(); emit( "error" ); }
                return { ok: false, pageOnly: true, conflict: !! res.conflict };
            }
            return res;
        }

        // The outbox entry (and cached copy) a write() makes, inside its
        // transaction - see VERSIONS. Returns { tx, entry, merged, direct }:
        // `direct` = not queued (tx changes nothing), sent from this page.
        // how: "create" / "replace" (CREATE-ONLY AND REPLACE) - the version is
        // that, whatever this page held, and a held-back save goes again.
        function queueIn( c, path, body, basis, id, now, how )
        {
            if( how )
            {
                // Another page's save waiting there is never merged into or
                // replaced by it: this one goes on its own (`direct`).
                var other = !! c.out && ! holds( basis, c.out ) && conflicts;
                var made  = queueIn( other ? { doc: c.doc, slot: c.slot } : c, path, body, basis, id, now, "" );
                if( other ) made = { entry: made.entry, direct: true, merged: null, tx: {} };
                setVer( made.entry, how === "create" ? { none: true } : {} );   // tx.out is this same entry
                made.entry.conflict = false;
                made.entry.ius      = true;
                if( made.tx.doc ) setVer( made.tx.doc, verOf( made.entry ) );
                return made;
            }

            var old     = c.out;
            var docMine = c.doc && ours( c.doc ) ? c.doc : null;
            var v, inc, anc, merged = null;
            var ius = conflicts || !! ( old && old.ius );
            var mrg = !! mergeFn || !! ( old && old.mrg );

            if( old && holds( basis, old ) )
            {
                // This page's own save (or one it read): replaced, from its version.
                v   = entryVer( old, docMine );
                inc = keepIds( old );
                anc = old.anc || [];
            }
            else if( old && conflicts && ! ( mergeFn && typeof body === "string" && typeof old.body === "string" ) )
            {
                // Another page's save, not in this page's model, and no merging
                // here: both stay. This one goes up on its own, checked against
                // this page's version, and is kept in this page until it has
                // (`direct`); the other is checked against its own - whichever
                // reaches the server second gets the conflict question.
                return { entry: freshEntry(), direct: true, merged: null, tx: {} };
            }
            else if( old && mergeFn && typeof body === "string" && typeof old.body === "string" )
            {
                // Another page's save, not in this page's model: merged into it,
                // from the older of the two bases when one descends from the
                // other (this page's version is, or came before, the queued
                // one's - or the other way round); else with no base - every
                // item of both is kept.
                var ov    = entryVer( old, docMine );
                var bk    = vkey( basis ), qk = vkey( ov );
                var mine  = !! basis && ( bk === qk || ( !! bk && ( old.anc || [] ).indexOf( bk ) !== -1 ) );   // the queued body descends from this page's base
                var later = ! mine && !! basis && !! qk && ( basis.anc || [] ).indexOf( qk ) !== -1;          // this page's descends from the queued one's
                // The queued one took this page's last save in: that body is
                // the base - what this page deleted or undid since stays so.
                var tookMe = !! basis && !! basis.id && typeof basis.body === "string" && ( old.inc || [] ).indexOf( basis.id ) !== -1;
                try { merged = mergeFn( path, tookMe ? basis.body : mine ? verOf( basis ).base : later ? ov.base : null, body, old.body ); }
                catch ( e ) { merged = null; }
                if( typeof merged !== "string" ) return { entry: freshEntry(), direct: true, merged: null, tx: {} };
                body = merged;
                id   = newId();   // a new save: no page holds it until its app has taken it in
                v    = later ? verOf( basis ) : ov;   // the newer of the two versions it holds
                inc  = keepIds( old );
                anc  = addKeys( addKeys( old.anc, basis ? basis.anc || [] : [] ), mine ? [] : [ later ? qk : bk ] );
            }
            else if( old )
            {
                // A plain store: the newer save wins (see the top). It does not
                // hold the other one's content: no `inc`.
                v   = entryVer( old, docMine );
                inc = [];
                anc = old.anc || [];
            }
            else
            {
                var f = freshEntry();
                return { entry: f, merged: null, tx: { out: f, doc: cached( f ) } };
            }

            var e = setVer( { path: path, body: body, queuedAt: now,
                              conflict: ! mrg && !! old.conflict,   // a merging save merges again instead of staying held
                              bin: binary || body instanceof Uint8Array, ius: ius, who: ME || old.who || "", mrg: mrg,
                              ver: 1, id: id, inc: inc, anc: anc }, v );

            return { entry: e, merged: merged, tx: { out: e, doc: cached( e ) } };

            // A save of this page's alone: from the version its model came from -
            // or, when the save it holds was sent a moment ago by another page,
            // that save's answer (in the cache before it reaches this page; one
            // sent by an older store.js left only its body there, clean).
            function freshEntry()
            {
                var up = basis && basis.id && ( lastSent( docMine, basis.id ) || upAsIs( docMine, basis.body ) );
                var fv = up ? docVer( docMine ) : verOf( basis );
                // This page's last save went up inside another one (a merge): the
                // check stays its old version, but the merge that follows starts
                // from that body - what this page deleted or undid since stays so.
                if( ! up && basis && basis.id && typeof basis.body === "string" && wasSent( docMine, basis.id ) ) fv.base = basis.body;
                return setVer( { path: path, body: body, queuedAt: now, conflict: false,
                                 bin: binary || body instanceof Uint8Array, ius: conflicts, who: ME, mrg: !! mergeFn,
                                 ver: 1, id: id, inc: basis && basis.id ? [ basis.id ].concat( basis.inc || [] ).slice( -KEEP_IDS ) : [],
                                 anc: basis && basis.anc ? basis.anc : [] }, fv );
            }

            // The cached copy follows the queued save - unless it holds another
            // account's save still waiting (L4): that one stays as it is.
            function cached( q )
            {
                if( c.doc && ! ours( c.doc ) && ( c.doc.dirty || ( c.slot && ! ours( c.slot ) ) ) ) return undefined;
                var d = setVer( { path: path, body: q.body, mtime: now, cachedAt: now, dirty: true, who: q.who }, verOf( q ) );
                if( docMine && docMine.sent ) d.sent = docMine.sent;
                return d;
            }
        }

        //--------------------------------------------------------------------//
        // FLUSH

        // One PUT per path at a time on this page: two in flight would both carry
        // the same version check, and the second would come back 412 - a false
        // "saved on another device". The next one waits, then re-reads the
        // outbox. `mine` = { id } of the entry a write() just queued.
        async function flushPath( path, mine )
        {
            while( inflight[ path ] )
            {
                try { await inflight[ path ]; } catch ( e ) {}
            }

            var p = flushPathNow( path, mine, 0 );
            inflight[ path ] = p;

            try { return await p; }
            finally { if( inflight[ path ] === p ) delete inflight[ path ]; }
        }

        async function flushPathNow( path, mine, again )
        {
            var db = await dbPromise;

            // This page's own save kept here goes first; once it is up, what the
            // outbox holds for the path is another page's, sent later (its page,
            // or the next flush): this answer is this page's.
            if( pageOnly[ path ] )
            {
                var pr = await sendPageOnly( db, path, pageOnly[ path ] );
                if( pr.ok ) { scheduleFlush(); await settle(); }
                return pr;
            }

            var look = await pathTx( db, path, "readonly", function ( c ) { return { ret: { out: c.out, doc: c.doc } }; } );

            // Not "nothing to send": the browser's storage could not be read (K2).
            if( ! look.ok )
            {
                emit( "error" );
                return { ok: false, unknown: true };
            }

            var entry = look.ret.out;
            var doc   = look.ret.doc;

            // Nothing queued. For the save a write() just queued that is fine only
            // when it went up (another page sent it, or a later save holding it):
            // gone without that - cleared by a sign-out - it is NOT saved (K5).
            if( ! entry )
            {
                if( ! mine || wasSent( doc, mine.id ) || upAsIs( doc, mine.body ) ) return { ok: true };
                emit( "error" );
                return { ok: false, unknown: true };
            }
            if( entry.conflict ) return { ok: false, conflict: true };   // waits for the app, never re-sent

            var merger = entry.mrg ? mergers[ path ] : null;   // see MERGE above

            if( ! navigator.onLine )
            {
                emit( "offline" );
                return { ok: false, offline: true };
            }
            delete needsApp[ path ];               // tried again now: said again below if it still needs its app

            // Sent the way the store that queued it would send it, checked against
            // ITS version (VERSIONS). Entries from before `bin`/`ius` existed:
            // bytes are Write/Calc's, which use the check; text never did, bar
            // Text's own.
            var bin = entry.bin != null ? !! entry.bin : ( entry.body instanceof Uint8Array );
            var ius = entry.ius != null ? !! entry.ius : bin;
            var who = entry.who || ME;

            emit( "saving" );                      // a PUT is in flight - sending data
            var res = await netPut( path, entry.body, ius ? entryVer( entry, doc ) : null, bin, who );

            if( res.conflict )
            {
                if( entry.mrg )
                {
                    // Saved from another device since: merge both (see MERGE above).
                    // `entry` is then the merged one, and `res` the answer to it.
                    if( ! merger )
                    {
                        // Not this page's app: it stays queued, as it was, for the
                        // page that can merge it - and the sign-out names that
                        // app (L6: "go online" was wrong advice, it IS online).
                        needsApp[ path ] = true;
                        emit( "pending" );
                        return { ok: false, deferred: true };
                    }

                    var m = await mergeAndPut( db, path, entry, merger, bin, who, mine );
                    if( m.done ) return m.done;
                    res   = m.res;
                    entry = m.entry;
                }
                else
                {
                    // Changed since - or gone (also a 412 under If-Match), or sent
                    // by another page this very moment (two pages flush one save at
                    // once), or the save before it was, which moved its version.
                    // Looked at AFTER the HEAD's round trip: the other page's answer
                    // is in by then.
                    var head  = await netHead( path );
                    var since = await since412( db, path, entry );
                    if( since === "sent" ) { await settle(); return { ok: true }; }
                    if( since === "again" && again < 3 ) return flushPathNow( path, mine, again + 1 );
                    if( head === 404 ) res = await netPut( path, entry.body, { none: true }, bin, who );   // made again - never over a file put there since
                    else if( entryVer( entry, doc ).none )
                    {
                        // A create-only save (D6) whose answer was lost and that
                        // netFetch sent again: the file there may be its own
                        // first try. Exactly its bytes there = saved, not "taken".
                        var there = await netGet( path );
                        if( there.ok && sameBody( there.body, entry.body ) ) res = { ok: true, status: 200, srv: there.srv, tag: there.tag };
                    }
                }
            }

            if( res.ok ) return saved( db, path, entry, res );

            if( res.conflict )
            {
                // Only the entry that was refused: a newer one is checked on its own.
                await pathTx( db, path, "readwrite", function ( c )
                {
                    return sameEntry( c.out, entry ) ? { out: Object.assign( {}, c.out, { conflict: true } ) } : {};
                } );
                // This page's plug says so only for its own save (another
                // window's waits for that window).
                if( holds( held[ path ], entry ) ) emit( "conflict" );
                else await settle();
                toldConflict( path, entry );
                return { ok: false, conflict: true };
            }

            if( res.forbidden )
            {
                // Dropped; its body stays in the cached copy, never queued again
                // by a read (`refused`).
                await pathTx( db, path, "readwrite", function ( c )
                {
                    if( ! sameEntry( c.out, entry ) ) return {};
                    return { out: null, doc: c.doc && ours( c.doc ) ? Object.assign( c.doc, { refused: true } ) : undefined };
                } );
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

        // After a 412 on `entry`: "sent" (another page sent it, or a save
        // holding it), "again" (still queued, its version moved: the save
        // before it went up meanwhile), or "same".
        async function since412( db, path, entry )
        {
            var r = await pathTx( db, path, "readonly", function ( c ) { return { ret: c }; } );
            if( ! r.ok ) return "same";
            var cur = r.ret.out, doc = r.ret.doc;
            if( wasSent( doc, idOf( entry ) ) ) return "sent";
            if( ! sameEntry( cur, entry ) && upAsIs( doc, entry.body ) ) return "sent";   // sent by an older store.js
            if( sameEntry( cur, entry ) && vkey( entryVer( cur, doc ) ) !== vkey( entryVer( entry, doc ) ) ) return "again";
            return "same";
        }

        // `entry` went up: the server's file is its body, at version res.
        // Dropped from the outbox (only that entry: a newer one queued while
        // the PUT was in flight stays for the next flush, and when it holds this
        // one and was made from the same version, it is made from the new one
        // now); the cached copy knows it was sent; the page holding it takes the
        // new version, and every page hears it (onSaved).
        async function saved( db, path, entry, res )
        {
            delete needsApp[ path ];
            var ver = { tag: res.tag, srv: res.srv, base: typeof entry.body === "string" ? entry.body : null, none: false };
            var eid = idOf( entry );
            var sentKey = vkey( entryVer( entry ) );

            var r = await pathTx( db, path, "readwrite", function ( c )
            {
                var cur = c.out, out, rebased = null, d;
                var sent = entryVer( entry, c.doc );
                sentKey  = vkey( sent );

                if( sameEntry( cur, entry ) ) out = null;
                else if( cur && ( cur.inc || [] ).indexOf( eid ) !== -1 && vkey( entryVer( cur, c.doc ) ) === vkey( sent ) )
                {
                    out     = setVer( Object.assign( {}, cur, { ver: 1, anc: addKeys( cur.anc, [ vkey( sent ) ] ) } ), ver );
                    rebased = idOf( cur );
                }

                if( c.doc && ours( c.doc ) )
                {
                    var took = ( entry.inc || [] ).concat( [ eid ] );
                    d = c.doc;
                    if( out === null ) { d.body = entry.body; d.dirty = false; setVer( d, ver ); d.last = [ eid ]; }
                    else if( rebased ) setVer( d, ver );   // still dirty: the queued save's new version
                    d.sent = ( d.sent || [] ).concat( took ).slice( -KEEP_IDS );
                    delete d.refused;
                }
                return { out: out, doc: d, ret: rebased };
            } );

            toldSaved( { path: path, who: entry.who || ME, id: eid, rebased: r.ok ? r.ret : null, prev: sentKey, tag: ver.tag, srv: ver.srv }, entry.body );
            await settle();
            return { ok: true };
        }

        // A save kept only in this page (K2) goes up directly, checked against
        // its version; a 412 merges it here once (MERGE) or, when the file is
        // gone, makes it again create-only. Sent: forgotten here, and an older
        // queued save of this page it holds leaves the outbox too.
        async function sendPageOnly( db, path, po )
        {
            if( po.conflict ) return { ok: false, conflict: true };
            if( ! navigator.onLine ) { emit( "offline" ); return { ok: false, offline: true }; }

            var who    = po.who || ME;
            var merger = po.mrg ? mergers[ path ] : null;
            emit( "saving" );
            var res = await netPut( path, po.body, po.ius ? entryVer( po ) : null, po.bin, who );

            // A newer save of this page came meanwhile: it goes next, and meets
            // this answer on its own.
            var orig = po;
            if( res.conflict && pageOnly[ path ] !== orig ) return { ok: false, superseded: true };

            if( res.conflict && merger )
            {
                var theirs = await merger.get( path );
                var merged = null;
                if( pageOnly[ path ] !== orig ) return { ok: false, superseded: true };
                if( theirs.ok )
                {
                    try { merged = merger.fn( path, entryVer( po ).base, po.body, theirs.body ); }
                    catch ( e ) { merged = null; }
                }
                if( typeof merged === "string" )
                {
                    po = setVer( Object.assign( {}, po, { body: merged, id: newId(), inc: keepIds( po ), anc: addKeys( po.anc, [ vkey( entryVer( po ) ) ] ) } ),
                                 { tag: theirs.tag, srv: theirs.srv, base: theirs.body } );
                    pageOnly[ path ] = po;
                    setHeld( path, heldOf( po ) );
                    merger.fire( path, merged );
                    res = await netPut( path, po.body, entryVer( po ), po.bin, who );
                }
                else if( theirs.missing ) res = await netPut( path, po.body, { none: true }, po.bin, who );
            }
            else if( res.conflict && await netHead( path ) === 404 )
                res = await netPut( path, po.body, { none: true }, po.bin, who );

            if( res.ok )
            {
                // A newer save of this page made while this one was out is made
                // from the version this one moved to now (as in saved()).
                var next = pageOnly[ path ];
                if( next === po ) delete pageOnly[ path ];
                else if( next && ( next.inc || [] ).indexOf( idOf( po ) ) !== -1 && vkey( entryVer( next ) ) === vkey( entryVer( po ) ) )
                    pageOnly[ path ] = setVer( Object.assign( {}, next, { anc: addKeys( next.anc, [ vkey( entryVer( po ) ) ] ) } ),
                                               { tag: res.tag, srv: res.srv, base: typeof po.body === "string" ? po.body : null } );
                await pathTx( db, path, "readwrite", function ( c )
                {
                    var drop = !! c.out && ( po.inc || [] ).indexOf( idOf( c.out ) ) !== -1;
                    if( ! c.doc || ! ours( c.doc ) ) return drop ? { out: null } : {};
                    var d    = c.doc;
                    var took = ( po.inc || [] ).concat( [ idOf( po ) ] );
                    d.sent = ( d.sent || [] ).concat( took ).slice( -KEEP_IDS );
                    if( drop || ( ! c.out && ! d.dirty ) )
                    {
                        setVer( Object.assign( d, { body: po.body, dirty: false, last: [ idOf( po ) ] } ),
                                { tag: res.tag, srv: res.srv, base: typeof po.body === "string" ? po.body : null } );
                        delete d.refused;
                    }
                    return { out: drop ? null : undefined, doc: d };
                } );
                toldSaved( { path: path, who: who, id: idOf( po ), rebased: next && next !== po ? idOf( next ) : null,
                             prev: vkey( entryVer( po ) ), tag: res.tag, srv: res.srv }, po.body );
                return { ok: true };
            }

            if( res.conflict )
            {
                if( pageOnly[ path ] === po ) pageOnly[ path ] = Object.assign( {}, po, { conflict: true } );
                emit( "conflict" );
                toldConflict( path, po );
                return { ok: false, conflict: true };
            }
            emit( res.netError ? "offline" : "error" );
            return { ok: false, offline: !! res.netError, needsAuth: !! res.needsAuth };
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
        // server's copy, merge the queued save (whichever is queued NOW - one
        // made while the GET was out included) onto it from that save's own
        // base, put the result in the cache and the outbox in one step, tell the
        // app, PUT it checked against the version just read. Returns
        // { res, entry } - the last answer (never a 412 unless the merge said
        // null: the CONFLICTS path) and the entry it answers - or { done } when
        // there is nothing more to do here.
        async function mergeAndPut( db, path, entry, merger, bin, who, mine )
        {
            var res = { ok: false, status: 412, conflict: true };

            for( var tries = 0; tries < MERGE_TRIES; tries++ )
            {
                var theirs = await merger.get( path );

                // Another account signed in on this browser since the save
                // was queued (WHOSE SAVE): that GET brought THEIR file, which
                // must not be merged into this one. It waits for its owner.
                if( who && whoNow() && whoNow() !== who )
                    return { res: { ok: false, status: 423, otherAccount: true }, entry: entry };

                // Gone from the server since: nothing to merge with, it goes up
                // as it is, create-only (below).
                if( ! theirs.ok && ! theirs.missing )
                    return { res: { ok: false, status: theirs.status, netError: theirs.netError,
                                    needsAuth: theirs.status === 401 }, entry: entry };

                var r = await pathTx( db, path, "readwrite", function ( c )
                {
                    var cur = c.out;
                    if( ! cur ) return { ret: { none: true, sent: wasSent( c.doc, idOf( entry ) ) || upAsIs( c.doc, entry.body ) } };
                    if( cur.conflict ) return { ret: { held: true } };
                    if( theirs.missing ) return { ret: { gone: cur } };

                    var cv     = entryVer( cur, c.doc );
                    var merged = null;
                    try { merged = merger.fn( path, cv.base, cur.body, theirs.body ); }
                    catch ( e ) { merged = null; }
                    if( typeof merged !== "string" ) return { ret: { refused: cur } };   // -> CONFLICTS

                    var tv = { tag: theirs.tag, srv: theirs.srv, base: theirs.body, none: false };
                    var mm = setVer( Object.assign( {}, cur, { body: merged, conflict: false, queuedAt: nextQueuedAt(), ver: 1, id: newId(),
                                                              inc: keepIds( cur ), anc: addKeys( cur.anc, [ vkey( cv ) ] ) } ), tv );
                    var d  = c.doc && ours( c.doc ) ? c.doc
                           : c.doc && c.doc.dirty ? null : { path: path, cachedAt: Date.now(), who: mm.who };
                    if( d ) { d.body = merged; d.mtime = Date.now(); d.dirty = true; setVer( d, tv ); }
                    return { out: mm, doc: d || undefined, ret: { merged: mm } };
                } );

                if( ! r.ok ) return { res: { ok: false, status: 0, netError: true }, entry: entry };   // storage failed: tried again later
                var t = r.ret;

                if( t.none )   return { done: t.sent || ! mine ? { ok: true } : { ok: false, unknown: true } };   // nothing queued any more (K5)
                if( t.held )   return { done: { ok: false, conflict: true } };
                if( t.refused ) return { res: res, entry: t.refused };

                if( t.gone )
                {
                    entry = t.gone;
                    emit( "saving" );
                    res = await netPut( path, entry.body, { none: true }, bin, who );
                    if( ! res.conflict ) return { res: res, entry: entry };
                    continue;   // made there meanwhile: merge with it
                }

                // This page's app takes the merged body (onMerged): its model,
                // and the version its next save is made from. A page whose save
                // was merged here is handed it too (toldTook).
                entry = t.merged;
                setHeld( path, heldOf( entry ) );
                merger.fire( path, entry.body );
                toldTook( path, entry );

                emit( "saving" );
                res = await netPut( path, entry.body, entryVer( entry ), bin, who );
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
                var db    = await dbPromise;
                var paths = [];
                ( await ownEntries( db ) ).map( function ( e ) { return e.path; } ).concat( Object.keys( pageOnly ) )
                    .forEach( function ( p ) { if( paths.indexOf( p ) === -1 ) paths.push( p ); } );

                for( var i = 0; i < paths.length; i++ )
                {
                    var r = await flushPath( paths[ i ] );

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
            var rec = await idbGet( db, DOCS, path ).catch( function () { return null; } );
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
        // on the server) - this account's records only, and a save another page
        // queued after this one read the file stays (that page's work) - and
        // the version this page held for it: a save to it from now on is
        // unchecked, as for a path never read.
        async function forget( path )
        {
            var db = await dbPromise;
            var h  = held[ path ];
            delete held[ path ];
            delete pageOnly[ path ];
            seen[ path ] = ( seen[ path ] || 0 ) + 1;
            await pathTx( db, path, "readwrite", function ( c )
            {
                if( c.out && h && ! holds( h, c.out ) ) return {};
                return { out: c.out ? null : undefined, doc: c.doc && ours( c.doc ) ? null : undefined };
            } );
        }

        // The file at `from` was moved to `to` on the server (a rename, C6):
        // this page's model of it is `to`'s now, made from the SAME version -
        // the server keeps a file's version tag across a move - so the first
        // save to the new name is checked against it, never sent blind (a
        // save another device made there meanwhile gets the conflict
        // question). `from` is dropped as forget() drops it. The caller moves
        // it only with nothing of this page waiting for `from` (pending()).
        async function renamed( from, to )
        {
            var h = held[ from ];
            await forget( from );
            if( h )
                setHeld( to, { id: null, inc: [], anc: h.anc || [], tag: h.tag || null, srv: h.srv || null,
                               base: typeof h.base === "string" ? h.base : null, none: !! h.none } );
        }

        // THIS page's write to `path` is held back as a conflict (see
        // CONFLICTS above) - not another window's.
        async function conflicted( path )
        {
            var e = await pending( path );
            return !! ( e && e.conflict && e.mine );
        }

        // What waits to go up for `path` from this account: null when nothing
        // does, else { conflict, mine, page, at } - conflict: held back as
        // changed elsewhere (CONFLICTS); mine: this page's model holds it; page:
        // kept only in this page (K2); at: when it was queued. { unknown: true }
        // when the browser's storage cannot be read.
        async function pending( path )
        {
            var po = pageOnly[ path ];
            if( po ) return { conflict: !! po.conflict, mine: true, page: true, at: po.queuedAt };

            var db = await dbPromise;
            var r  = await pathTx( db, path, "readonly", function ( c ) { return { ret: c.out }; } );
            if( ! r.ok ) return { unknown: true };
            var e = r.ret;
            return e ? { conflict: !! e.conflict, mine: holds( held[ path ], e ), page: false, at: e.queuedAt } : null;
        }

        // fn( path ) - a flush found `path` saved from another device since.
        function onConflict( fn ) { conflictFns.push( fn ); }

        // fn( path, body ) - a flush merged `path` with another device's save
        // (see MERGE above): the app reloads its data from `body`.
        function onMerged( fn ) { mergedFns.push( fn ); }

        // fn( path, body, tag, mine ) - a save of `path` went up, sent by ANY
        // page of this browser for this account: body = what the server holds
        // now (null for bytes saved by another page), tag its version, mine =
        // this page's model holds that save. Returns off().
        function onSaved( fn )
        {
            savedFns.push( fn );
            return function off()
            {
                var i = savedFns.indexOf( fn );
                if( i !== -1 ) savedFns.splice( i, 1 );
            };
        }

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

        // The save could not be sent and is only in this page (the browser's
        // storage failed: K2, or another page's save holds the outbox and the
        // server was not reached). Said once in a while, not per keystroke -
        // and after an Undo on show, never over it (the save of a delete
        // would make the delete's Undo final: keepUndo, shared/ui.js).
        function pageOnlyToast()
        {
            var now = Date.now();
            if( now - toastAt < 4000 || ! window.NayiveUI || ! NayiveUI.toast || ! NayiveUI.t ) return;
            toastAt = now;
            NayiveUI.toast( NayiveUI.t( "ui.store.pageOnly" ), { ms: 8000, keepUndo: true } );
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
            renamed:      renamed,
            conflicted:   conflicted,
            pending:      pending,
            onConflict:   onConflict,
            onMerged:     onMerged,
            onSaved:      onSaved,
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
    // sign in here would be offered it. localCount() is how many saves,
    // untitled drafts and Chat's typed messages are still only here - EVERY
    // account's, since they all go - so the button can ask first; clearLocal()
    // then deletes EXACTLY what was counted (a save or draft made while the
    // question was up is not: K5), the cached copies of every path with nothing
    // left to send, and eMail's files. leaveDevice( ask ) does the lot: send, count, ask,
    // clear - and counts and asks again when something came in meanwhile. Each
    // store is emptied in place: deleteDatabase() waits for every other open
    // tab and, meanwhile, does nothing.

    var counted = null;   // what the last localCount() counted: outbox "path\0id", drafts "app\0at", chat "key\0text"
    var waitStore = null; // sendWaiting's store: one per page (each store listens to the page's events)

    // A database as its owner opens it - the same upgrade, so opening it here
    // first never leaves one with no store: "nayive-drafts" (shared/office.js),
    // "nayive-mail-files" (email/compose.js).
    function openSide( name, store, keyPath )
    {
        return new Promise( function ( resolve )
        {
            var rq;
            try { rq = indexedDB.open( name, 1 ); }
            catch ( e ) { resolve( null ); return; }
            rq.onupgradeneeded = function () { rq.result.createObjectStore( store, { keyPath: keyPath } ); };
            rq.onsuccess = function () { resolve( rq.result ); };
            rq.onerror = rq.onblocked = function () { resolve( null ); };
        } );
    }

    function openDraftsDb() { return openSide( "nayive-drafts", "drafts", "app" ); }

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

    function outName( r )   { return r.path + "\u0000" + idOf( r ); }
    function draftName( r ) { return r.app + "\u0000" + ( r.at || "" ); }

    // How many saves and drafts are only here. What could not be read counts
    // as nothing - and is then never deleted either. `counted.apps`: the apps
    // whose saves only that app can finish (a merge it must make: L6).
    async function localCount()
    {
        await retagged;   // an admin rename's saves are counted as the account's own
        var store  = await openDb();
        var drafts = await openDraftsDb();
        var outs   = ( await oneTx( store,  OUTBOX,   "readonly", function ( os ) { return os.getAll(); } ) ) || [];
        var drs    = ( await oneTx( drafts, "drafts", "readonly", function ( os ) { return os.getAll(); } ) ) || [];
        if( store )  store.close();
        if( drafts ) drafts.close();
        var chat = chatDrafts();
        var apps = [];
        outs.forEach( function ( r )
        {
            // Met a 412 here that only its own app can merge, or its app's
            // merge said "no" before (flagged; `xc` beside another account's).
            var p = r.file || r.path;
            if( ! r.mrg || ! ( needsApp[ p ] || ( r.file ? r.xc : r.conflict ) ) ) return;
            var a = appOf( p );
            if( apps.indexOf( a ) === -1 ) apps.push( a );
        } );
        counted = { out: outs.map( outName ), drafts: drs.map( draftName ), chat: chat, apps: apps };
        return outs.length + drs.length + chat.length;
    }

    // The app that merges a list file's saves, by name, for the sign-out's
    // advice ("open Planner › Tasks to finish saving": Tasks, Calendar and
    // Habits live in Planner). Anything else: its file name.
    var MERGING_APPS = [ [ "data/tasks.json", "Planner \u203a Tasks" ], [ "data/calendar.ics", "Planner \u203a Calendar" ], [ "data/contacts.vcf", "Contacts" ],
                         [ "data/habits/", "Planner \u203a Habits" ], [ "data/split/", "Split" ], [ "data/trips/", "Trips" ],
                         [ "data/games/", "Games" ], [ "data/bookmarks/", "Bookmarks" ] ];

    function appOf( p )
    {
        for( var i = 0; i < MERGING_APPS.length; i++ )
        {
            var k = MERGING_APPS[ i ][ 0 ];
            if( p === k || ( k.slice( -1 ) === "/" && p.indexOf( k ) === 0 ) ) return MERGING_APPS[ i ][ 1 ];
        }
        return String( p ).split( "/" ).pop();
    }

    // Chat's typed, unsent text (chat/compose.js: localStorage
    // "nayive-chat-draft:<whose>|<world>|<chat>"), as "key\0text": counted and
    // asked about like every other unsaved thing.
    function chatDrafts()
    {
        var out = [];
        try
        {
            for( var i = 0; i < localStorage.length; i++ )
            {
                var k = localStorage.key( i );
                var v = k && k.indexOf( "nayive-chat-draft:" ) === 0 ? localStorage.getItem( k ) : null;
                if( v ) out.push( k + "\u0000" + v );
            }
        }
        catch ( e ) {}
        return out;
    }

    // The saves still waiting here get one more chance to go up before the
    // count: as long as one is actually being sent, up to `ms` (10 s), never
    // longer - flush() comes back at once when nothing is queued, and stops
    // at the first "offline" or "signed out". Offline, no wait at all.
    function sendWaiting( ms )
    {
        if( ! navigator.onLine ) return Promise.resolve();
        waitStore = waitStore || createStore();
        return Promise.race( [ waitStore.flush().catch( function () {} ),
                               new Promise( function ( r ) { setTimeout( r, ms || 10000 ); } ) ] );
    }

    // Deletes what localCount() counted (with no count before it: what is here
    // now). Resolves how many saves and drafts came in since and were kept.
    async function clearLocal()
    {
        await retagged;
        var seen = counted;
        if( ! seen ) { await localCount(); seen = counted; }
        counted = null;

        var left  = 0;
        var store = await openDb();
        if( store )
        {
            // One transaction: a save is kept with its cached copy, or both go.
            left += await new Promise( function ( resolve )
            {
                var kept = 0, keep = {};
                try
                {
                    var tx = store.transaction( [ DOCS, OUTBOX ], "readwrite" );
                    var os = tx.objectStore( OUTBOX ), ds = tx.objectStore( DOCS );
                    var rq = os.getAll();
                    rq.onsuccess = function ()
                    {
                        rq.result.forEach( function ( r )
                        {
                            if( seen.out.indexOf( outName( r ) ) !== -1 ) os.delete( r.path );
                            else { kept++; keep[ r.file || r.path ] = true; }
                        } );
                        var kq = ds.getAllKeys();
                        kq.onsuccess = function () { kq.result.forEach( function ( k ) { if( ! keep[ k ] ) ds.delete( k ); } ); };
                    };
                    tx.oncomplete = function () { resolve( kept ); };
                    tx.onerror = tx.onabort = function () { resolve( kept ); };
                }
                catch ( e ) { resolve( 0 ); }
            } );
            store.close();
        }

        var mailKept = false;
        var drafts   = await openDraftsDb();
        if( drafts )
        {
            left += await new Promise( function ( resolve )
            {
                var kept = 0;
                try
                {
                    var tx = drafts.transaction( "drafts", "readwrite" );
                    var os = tx.objectStore( "drafts" );
                    var rq = os.getAll();
                    rq.onsuccess = function ()
                    {
                        rq.result.forEach( function ( r )
                        {
                            if( seen.drafts.indexOf( draftName( r ) ) !== -1 ) os.delete( r.app );
                            else { kept++; if( String( r.app ).indexOf( "email:" ) === 0 ) mailKept = true; }
                        } );
                    };
                    tx.oncomplete = function () { resolve( kept ); };
                    tx.onerror = tx.onabort = function () { resolve( kept ); };
                }
                catch ( e ) { resolve( 0 ); }
            } );
            drafts.close();
        }

        // eMail's files go with its drafts - unless a draft was kept: its files
        // stay (eMail sweeps the ones no draft needs when it next opens).
        if( ! mailKept )
        {
            var files = await openSide( "nayive-mail-files", "files", "key" );
            await oneTx( files, "files", "readwrite", function ( os ) { return os.clear(); } );
            if( files ) files.close();
        }

        // Chat's typed text: what was counted, as it was then (one typed on
        // since is kept, and counted as left).
        chatDrafts().forEach( function ( d )
        {
            var k = d.slice( 0, d.indexOf( "\u0000" ) );
            if( ( seen.chat || [] ).indexOf( d ) !== -1 ) { try { localStorage.removeItem( k ); } catch ( e ) {} }
            else left++;
        } );

        return left;
    }

    // The sign-out, in one call: send, count, ask( n, { apps } ) (resolves
    // true = sign out) when anything is left, clear what was counted. apps:
    // the apps that must be opened to finish saving (L6) - going online is
    // not enough for those. What came in while asking is counted and asked
    // about again - twice at most; after that it stays here, kept for its
    // owner's next sign-in. Resolves false when the user chose to stay.
    async function leaveDevice( ask )
    {
        for( var round = 0; round < 3; round++ )
        {
            try { await sendWaiting( round ? 3000 : 10000 ); } catch ( e ) {}
            var n = await localCount();
            if( n > 0 && ! await ask( n, { apps: ( counted && counted.apps ) || [] } ) ) { counted = null; return false; }
            if( ! await clearLocal() ) return true;
        }
        return true;
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
                           localCount: localCount, clearLocal: clearLocal, leaveDevice: leaveDevice,
                           mergeLists: mergeLists, mergeFields: mergeFields, mergeSets: mergeSets,
                           hashText: hashText };
} )();
