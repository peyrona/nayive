/*
 * gum-api.js - Talking to the nayive file API, shared by every Nayive single-page app.
 *
 * (The name is historical: the apps were first served by the Gum server. The
 * HMAC request-signing that Gum needed is gone - this is now a thin wrapper
 * over the nayive server's /api/* endpoints.)
 *
 * Every app used to carry its own copy of fetch-with-retry + the file helpers;
 * this module is the single copy. It is a plain classic script exposing one
 * global, loaded BEFORE the app's own script (and before shared/store.js, which
 * is independent of it):
 *
 *     <script src="../shared/gum-api.js"></script>
 *
 * It has no dependencies at all.
 *
 * ---------------------------------------------------------------------------
 * AUTH MODEL
 *
 * All endpoints under /api/ are authenticated by the nayive_session cookie
 * only - a same-origin fetch() sends it automatically, so nothing here adds
 * anything extra.
 *
 * probeAccess() is the initial "am I signed in?" check: GET /api/whoami. The
 * server answers it from its in-memory session table (no disk access at all)
 * and 401s an anonymous visitor. The apps use that to decide "open the app" vs
 * "bounce to /nayive/login.html".
 *
 * WHOSE PAGE (L5). Every PUT carries X-Nayive-User: the account this page
 * belongs to (the "nayive_who" cookie as it was when the page loaded - the
 * name shared/store.js tags its saves with, NayiveStore.me). A tab left open
 * after another account signed in on this browser gets 423 instead of writing
 * into that other person's home (server/go/store_owner.go).
 *
 * VERSIONS (data-safety A, C). The server tags every file with a strong ETag
 * that every write changes (server/go/etag.go). readVersion() hands it back
 * with the body; writeFileBytes( p, b, { ifMatch: tag } ) writes only over
 * THAT version, { createOnly: true } only where there is no file - else 412
 * and nothing is written. updateJson() is the read -> change -> write of a
 * small JSON file that never drops what another device saved in between: on
 * a 412 it reads again and makes its change again.
 */
( function ()
{
    "use strict";

    var API_FILES  = window.location.origin + "/api/files";
    var API_WHOAMI = window.location.origin + "/api/whoami";

    var MAX_RETRIES = 2;
    var BASE_DELAY  = 500;   // ms; doubles each retry (500, 1000)

    // Who this page belongs to (WHOSE PAGE above): read ONCE, as the page
    // loads - never again, so a tab left open across another account's
    // sign-in still names its own. "" = unknown: no header, taken as before.
    var ME_AT_LOAD = ( function ()
    {
        try
        {
            var m = document.cookie.match( /(?:^|;\s*)nayive_who=([^;]*)/ );
            return m ? m[ 1 ] : "";
        }
        catch ( e ) { return ""; }
    } )();

    function owner()
    {
        var me = window.NayiveStore && NayiveStore.me;
        return typeof me === "string" && me ? me : ME_AT_LOAD;
    }

    // The headers of one PUT: `extra` plus the owner's name.
    function putHeaders( extra )
    {
        var h = {};
        for( var k in ( extra || {} ) ) h[ k ] = extra[ k ];
        if( owner() ) h[ "X-Nayive-User" ] = owner();
        return h;
    }

    //------------------------------------------------------------------------//
    // FETCH WITH RETRY
    //
    // Two retries with exponential backoff, but ONLY for a thrown TypeError - a
    // genuine connectivity drop, whatever the browser calls it (Chrome "Failed
    // to fetch", Safari "Load failed", Firefox "NetworkError..."). A non-2xx
    // response is turned into a thrown Error and passed straight through, never
    // retried. And only a GET or a PUT: sending one twice changes nothing, while
    // a POST or DELETE that did land (a rename, a trip to the papelera) would
    // come back from its retry as a false error.
    //
    // A PUT whose answer came back is never sent again, whatever the answer:
    // a conditional one (If-Match, If-None-Match) answered 412 means "not over
    // that file", and only the user or the caller's merge may decide what next.
    // An error thrown after a re-send says so (err.retried): the first try may
    // have landed before the connection dropped (ownFirstTry below).

    function sleep( ms )
    {
        return new Promise( function ( r ) { setTimeout( r, ms ); } );
    }

    function mayRetry( options )
    {
        var m = String( ( options && options.method ) || "GET" ).toUpperCase();
        return m === "GET" || m === "PUT";
    }

    async function withRetry( attempt, tries, once )
    {
        tries = tries || 0;

        try
        {
            return await attempt();
        }
        catch ( err )
        {
            if( ! once && tries < MAX_RETRIES && err instanceof TypeError )
            {
                await sleep( BASE_DELAY * Math.pow( 2, tries ) );
                return withRetry( attempt, tries + 1 );
            }

            if( tries > 0 && err && typeof err === "object" ) err.retried = true;
            throw err;
        }
    }

    // A 401 means the session is gone (idle timeout, or the server restarted -
    // its session table is in RAM). Raise the shared bar once so the user sees
    // WHY the action failed instead of the app's generic "no se pudo ..." toast.
    // Only 401: a 403 here is "not yours / read-only", nothing to do with the
    // session. /api/whoami is skipped because its 401 is the boot probe's
    // ANSWER - every app already reacts to it (redirect, or open from cache).
    function authLost( res )
    {
        if( res.status !== 401 ) return;
        if( String( res.url || "" ).indexOf( "/api/whoami" ) !== -1 ) return;
        if( window.NayiveUI && NayiveUI.sessionExpired ) NayiveUI.sessionExpired();
    }

    function assertOk( res )
    {
        if( ! res.ok )
        {
            authLost( res );
            // Message format is load-bearing: readJson (below) still sniffs it
            // for "HTTP 404", and toasts show it. New code reads err.status.
            var err = new Error( "HTTP " + res.status + ": " + res.statusText );
            err.status = res.status;
            throw err;
        }

        return res;
    }

    // GET (or any method via `options`) -> response body as text.
    function fetchText( url, options )
    {
        return withRetry( function ()
        {
            return fetch( url, options || {} ).then( assertOk ).then( function ( r ) { return r.text(); } );
        }, 0, ! mayRetry( options ) );
    }

    // GET -> response body as a Uint8Array.
    function fetchBinary( url, options )
    {
        return withRetry( function ()
        {
            return fetch( url, options || {} ).then( assertOk )
                   .then( function ( r ) { return r.arrayBuffer(); } )
                   .then( function ( buf ) { return new Uint8Array( buf ); } );
        }, 0, ! mayRetry( options ) );
    }

    // PUT raw bytes (a Uint8Array or a Blob). Resolves { tag }: the new file's
    // version (its ETag; null from a server that sends none). Rejects on a
    // non-2xx or a drop that outlasts the retries. Sent with the page's owner
    // (X-Nayive-User, WHOSE PAGE above).
    //
    // XMLHttpRequest rather than fetch(), because only XHR reports UPLOAD
    // progress. Every attempt is announced as "nayive:upload" events on the
    // document - { id, loaded, total } while it runs, { id, done: true } when it
    // ends, however it ends - and shared/ui.js draws the progress bar from them.
    // Nothing here depends on ui.js: with no listener the events go nowhere.
    //
    // The two contracts fetch() had are kept exactly: a non-2xx goes through
    // assertOk (same "HTTP <status>: <text>" message and err.status), and a
    // dropped connection throws a TypeError("Failed to fetch") -
    // what withRetry retries on. A retry is a new attempt, with a new id.
    var uploadSeq = 0;

    function announceUpload( detail )
    {
        try { document.dispatchEvent( new CustomEvent( "nayive:upload", { detail: detail } ) ); }
        catch ( e ) {}
    }

    // `headers` (optional): extra request headers, { name: value }.
    function putBinary( url, bytes, headers )
    {
        var size = ( bytes && ( bytes.size !== undefined ? bytes.size : bytes.byteLength ) ) || 0;
        var sent = putHeaders( headers );

        return withRetry( function ()
        {
            return new Promise( function ( resolve, reject )
            {
                var id  = ++uploadSeq;
                var xhr = new XMLHttpRequest();

                function end() { announceUpload( { id: id, done: true } ); }

                xhr.open( "PUT", url );
                for( var h in sent ) xhr.setRequestHeader( h, sent[ h ] );
                xhr.upload.onprogress = function ( e )
                {
                    announceUpload( { id: id, loaded: e.loaded,
                                      total: e.lengthComputable ? e.total : size } );
                };
                xhr.onload = function ()
                {
                    end();
                    // The shape assertOk (and authLost) read off a fetch Response.
                    resolve( { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status,
                               statusText: xhr.statusText, url: xhr.responseURL || url,
                               tag: strongTag( xhr.getResponseHeader( "ETag" ) ) } );
                };
                xhr.onerror = xhr.onabort = xhr.ontimeout = function ()
                {
                    end();
                    reject( new TypeError( "Failed to fetch" ) );
                };

                announceUpload( { id: id, loaded: 0, total: size } );
                xhr.send( bytes );
            } ).then( assertOk ).then( function ( r ) { return { tag: r.tag }; } );
        } );
    }

    // Only a strong tag ("...") goes back as If-Match: the server refuses a
    // write whose If-Match it cannot match exactly, a weak W/"..." included.
    function strongTag( t ) { return typeof t === "string" && /^"[^"]*"$/.test( t ) ? t : null; }

    //------------------------------------------------------------------------//
    // CHANGE NEWS
    //
    // Every page tells the others (Drive in another tab or desktop window)
    // what it changed, so they show it without a manual reload: a "Save as"
    // in Write appears in the Drive listing at once. { paths, folders } -
    // folders:true when the folder tree may have changed too (new folder,
    // rename, delete). A page never hears its own news.
    var newsChannel = null;
    try { newsChannel = new BroadcastChannel( "nayive-files" ); } catch ( e ) {}

    // A .then() step: announce, then pass the result through untouched.
    function changed( paths, folders )
    {
        return function ( result )
        {
            try { if( newsChannel ) newsChannel.postMessage( { paths: paths, folders: folders } ); }
            catch ( e ) {}
            return result;
        };
    }

    // News of a change this page made some other way (a bin restore names
    // nothing it brought back).
    function announce( paths, folders ) { changed( paths, folders )(); }

    function onFilesChanged( fn )
    {
        if( newsChannel ) newsChannel.addEventListener( "message", function ( e ) { fn( e.data || {} ); } );
    }

    //------------------------------------------------------------------------//
    // FILE HELPERS

    // The URL for one file: API_FILES + '?file=' + encodeURIComponent( path )
    function fileUrl( path )
    {
        return API_FILES + "?file=" + encodeURIComponent( path );
    }

    function readFile( path )               { return fetchText( fileUrl( path ) ); }
    function readFileBytes( path )           { return fetchBinary( fileUrl( path ) ); }

    function isMissing( e ) { return !! e && ( e.status === 404 || String( e.message ).indexOf( "HTTP 404" ) !== -1 ); }

    // A file WITH its version: { body, tag, offline } - body as text, or a
    // Uint8Array with opts.bytes; tag = its strong ETag (null when none came);
    // offline = the service worker answered from its offline copy (a trip's
    // document with no network, "X-Nayive-Copy: offline"): an OLD copy, never
    // the file's current version - nothing may be written from it as if it
    // were. Throws like readFile (err.status 404: no file). The browser checks
    // its cached copy with the server first (no-cache): the tag is the bytes'.
    function readVersion( path, opts )
    {
        var bytes = !! ( opts && opts.bytes );
        return withRetry( function ()
        {
            return fetch( fileUrl( path ), { cache: "no-cache" } ).then( assertOk ).then( function ( r )
            {
                var tag     = strongTag( r.headers.get( "ETag" ) );
                var offline = !! r.headers.get( "X-Nayive-Copy" );
                return ( bytes ? r.arrayBuffer().then( function ( b ) { return new Uint8Array( b ); } ) : r.text() )
                       .then( function ( body ) { return { body: body, tag: tag, offline: offline }; } );
            } );
        } );
    }

    // The version a file has NOW, without its bytes (HEAD - never an offline
    // copy: the service worker answers only GETs): { tag, exists }.
    function versionOf( path )
    {
        return withRetry( function ()
        {
            return fetch( fileUrl( path ), { method: "HEAD", cache: "no-store" } ).then( function ( r )
            {
                if( r.status === 404 ) return { tag: null, exists: false };
                assertOk( r );
                return { tag: strongTag( r.headers.get( "ETag" ) ), exists: true };
            } );
        } );
    }

    // PUT one file. Resolves { tag } (its new version). `opts`, all optional:
    //   convert: "mp4"   the server also queues it for conversion (Drive's
    //                    "Subir y convertir" - server/go/convert.go)
    //   ifMatch: tag     only over THAT version of the file (readVersion's
    //                    tag, or a previous write's): a file changed since -
    //                    or gone - answers 412 and nothing is written
    //   createOnly: true only where there is no file (If-None-Match: *): a
    //                    name taken - even a moment ago, by another device -
    //                    answers 412 (409 in a folder shared with us, which
    //                    only ever gains files) and nothing is written
    // No opts: a plain upload that replaces whatever is there.
    function writeFileBytes( path, bytes, opts )
    {
        opts = opts || {};
        var url = fileUrl( path ), headers = {};
        if( opts.convert ) url += "&convert=" + encodeURIComponent( opts.convert );
        if( opts.createOnly )    headers[ "If-None-Match" ] = "*";
        else if( opts.ifMatch )  headers[ "If-Match" ] = opts.ifMatch;
        else if( "ifMatch" in opts ) return Promise.reject( noTag() );   // conditional, but no tag held

        var put = putBinary( url, bytes, headers );
        if( opts.createOnly || opts.ifMatch )
            put = put.catch( function ( err ) { return ownFirstTry( err, path, bytes, !! opts.createOnly ); } );
        return put.then( changed( [ path ], false ) );
    }

    // An If-Match with no tag would be refused by the server anyway (etag.go):
    // the same 412, without the round trip.
    function noTag()
    {
        var err = new Error( "HTTP 412: no version to write over" );
        err.status = 412;
        return err;
    }

    // OUR OWN FIRST TRY. A conditional PUT re-sent after a dropped connection
    // (err.retried) may meet the file its own first try made - that try landed,
    // only its answer was lost - and get 412 (409 for a create in a folder
    // shared with us). The same bytes there ARE that: saved, with the version
    // read back. Only a file small enough to read back is judged so; a bigger
    // one may still be another file of the same size - the 412 stands, and
    // the caller asks. An offline copy proves nothing.
    var SAME_CHECK_MAX = 8 * 1024 * 1024;

    async function ownFirstTry( err, path, bytes, create )
    {
        if( ! err || ! err.retried ) throw err;
        if( err.status !== 412 && ! ( create && err.status === 409 ) ) throw err;
        var size = bytes && ( bytes.size !== undefined ? bytes.size : bytes.byteLength );
        if( ! ( size <= SAME_CHECK_MAX ) ) throw err;
        try
        {
            var have = await readVersion( path, { bytes: true } );
            var mine = bytes instanceof Uint8Array ? bytes
                     : new Uint8Array( bytes.arrayBuffer ? await bytes.arrayBuffer() : bytes );
            if( sameBytes( have.body, mine ) && ! have.offline ) return { tag: have.tag };
        }
        catch ( e ) {}
        throw err;
    }

    function sameBytes( a, b )
    {
        if( a.length !== b.length ) return false;
        for( var i = 0; i < a.length; i++ ) if( a[ i ] !== b[ i ] ) return false;
        return true;
    }

    // writeFileBytes for a NEW file only: it never replaces one (createOnly
    // above). The caller asks the user (replace / keep both) on err.status
    // 412, instead of overwriting blind. opts.convert as writeFileBytes.
    function createFileBytes( path, bytes, opts )
    {
        return writeFileBytes( path, bytes, { createOnly: true, convert: opts && opts.convert } );
    }

    // Small JSON sidecar helpers (data/<app>/config.json and friends). readJson
    // resolves null when the file isn't there yet (a fresh account); any other
    // failure - including a 401 - is thrown so the caller can react. writeJson
    // creates missing parent folders, same as a plain PUT; `opts` as
    // writeFileBytes (ifMatch / createOnly).
    async function readJson( path )
    {
        try { return JSON.parse( await readFile( path ) ); }
        catch ( e )
        {
            if( isMissing( e ) ) return null;
            throw e;
        }
    }

    function writeJson( path, obj, opts )
    {
        return writeFileBytes( path, new TextEncoder().encode( JSON.stringify( obj, null, 1 ) ), opts );
    }

    // READ -> CHANGE -> WRITE of a small JSON file shared with other devices
    // and windows (playlists, notes, a dictionary...), with nothing lost in
    // between: `fn( value )` gets the file as it is NOW (null: no file yet) and
    // returns what to write - or false: nothing to write. That goes up only
    // over the version just read (If-Match; create-only when there was no
    // file): a save made elsewhere in between answers 412, and the file is
    // read again and `fn` runs again on it - so `fn` must make ONLY its own
    // change, on whatever it is given, and keep its side effects for after.
    // Resolves what was written (or read, when nothing was). A `fn` that
    // returns nothing (undefined, null) throws, writing nothing: written, it
    // would have emptied the file.
    //
    // A file that cannot be read - a network error, a 5xx, a 401, JSON that
    // does not parse, an offline copy - is never written over: thrown with
    // err.notRead = true (a JSON error stays a SyntaxError). What `fn` throws
    // passes through untouched; so does a write's failure, a 412 too after
    // UPDATE_TRIES rounds (another device saving that often is not a race).
    var UPDATE_TRIES = 4;

    async function updateJson( path, fn )
    {
        for( var round = 1; ; round++ )
        {
            var got;
            try
            {
                try { got = await readVersion( path ); }
                catch ( e ) { if( ! isMissing( e ) ) throw e; got = null; }
                if( got && got.offline )
                {
                    var off = new Error( path + ": only an offline copy could be read" );
                    off.offline = true;
                    throw off;
                }
                var value = got ? JSON.parse( got.body ) : null;
            }
            catch ( e ) { if( e && typeof e === "object" ) e.notRead = true; throw e; }

            var out = fn( value );
            if( out === false ) return value;
            if( out === undefined || out === null ) throw new TypeError( path + ": updateJson's change returned nothing to write" );

            try
            {
                await writeJson( path, out, got ? { ifMatch: got.tag } : { createOnly: true } );
                return out;
            }
            catch ( e )
            {
                if( ! e || e.status !== 412 || round >= UPDATE_TRIES ) throw e;
            }
        }
    }

    // ONE level of the tree: the files AND sub-folders directly inside `path`
    // (a virtual path like "files/photos"; "" or omitted = the virtual root).
    // GET ?dir=<path>  -> { path, role, user, nodes: [...] } where each node is
    // a file with nodes:null + size + mtime or a sub-folder with nodes:[] (not
    // expanded). Cheap even when the folder holds thousands of files.
    async function listDir( path )
    {
        // "/" (not "") for the root: an empty query value gets dropped before it
        // reaches the handler; the server strips the slash back off.
        var q = new URLSearchParams( { dir: path || "/" } ).toString();
        return JSON.parse( await fetchText( API_FILES + "?" + q ) );
    }

    // The whole subtree under ONE folder (that folder's files and sub-folders,
    // sub-folders' files, ...), in one call. `path` must not be "" (the virtual
    // root). Same node shape as listDir(); a sub-folder's `nodes` is
    // fully expanded, not the empty-array stub listDir() gives you. Rejects
    // with "HTTP 404" when the folder does not exist yet.
    async function listDirRecursive( path )
    {
        var q = new URLSearchParams( { dir: path, recursive: "1" } ).toString();
        return JSON.parse( await fetchText( API_FILES + "?" + q ) );
    }

    // The whole virtual root as a FOLDERS-ONLY recursive tree (no file nodes).
    // GET ?tree=dirs  -> { path, role, user, nodes } - same wrapper shape as
    // listDir(), and a folder that holds thousands of files still adds just one
    // node. The Drive left pane loads this and fetches each folder's file list
    // separately with listDir().
    async function dirTree()
    {
        return JSON.parse( await fetchText( API_FILES + "?tree=dirs" ) );
    }

    // Flat name search across the whole virtual root. `pattern` is a shell glob
    // (`*`, `?`, `[seq]`) matched against each basename, case-insensitive.
    // GET ?find=<pattern>  -> { pattern, nodes:[...], truncated, role, user };
    // `nodes` is capped at 500 (same node shape as listDir()), `truncated` is
    // true when there were more.
    async function find( pattern )
    {
        var q = new URLSearchParams( { find: pattern } ).toString();
        return JSON.parse( await fetchText( API_FILES + "?" + q ) );
    }

    // Drive's advanced search. `spec` = { rules: [ { op, text } ], any,
    // folders, exts: [ ... ], since, until }, every part optional: op is
    // has | not | starts | ends | is on the basename, `any` = one rule is
    // enough, `folders` / `exts` = the kinds wanted, since / until = modified
    // in [since, until) in Unix seconds. Same answer as find().
    // GET ?search=1&name=<op>:<text>&any=1&folders=1&ext=pdf&since=&until=
    async function search( spec )
    {
        var q = new URLSearchParams( { search: "1" } );
        ( spec.rules || [] ).forEach( function ( r ) { q.append( "name", r.op + ":" + r.text ); } );
        if( spec.any )     q.append( "any", "1" );
        if( spec.folders ) q.append( "folders", "1" );
        ( spec.exts || [] ).forEach( function ( e ) { q.append( "ext", e ); } );
        if( spec.since )   q.append( "since", String( spec.since ) );
        if( spec.until )   q.append( "until", String( spec.until ) );
        return JSON.parse( await fetchText( API_FILES + "?" + q.toString() ) );
    }

    // The `n` biggest files, biggest first (Drive's "Biggest files", which the
    // "space almost full" warning opens). Same answer as find(). GET ?big=<n>
    async function biggest( n )
    {
        return JSON.parse( await fetchText( API_FILES + "?big=" + ( n || 50 ) ) );
    }

    // Create a directory `name` under `parent` (a path relative to the served
    // root). PUT ?type=dir&name=&parent=
    function makeDir( parent, name )
    {
        var q = new URLSearchParams( { type: "dir", name: name, parent: parent } ).toString();
        return fetchText( API_FILES + "?" + q, { method: "PUT", headers: putHeaders() } )
               .then( changed( [ parent ? parent + "/" + name : name ], true ) );
    }

    // ONE "paths" parameter per path - repeated, never joined by a separator.
    // A filename may contain any character but "/", so a joined list is
    // ambiguous: a name holding the separator gets split into two wrong paths.
    // (It used to be ";" - deleting "my;file.txt" trashed the sibling "my/".)
    function pathsQuery( paths, extra )
    {
        var list = Array.isArray( paths ) ? paths : [ paths ];
        var q    = new URLSearchParams();

        list.forEach( function ( p ) { if( p ) q.append( "paths", String( p ) ); } );
        if( extra ) Object.keys( extra ).forEach( function ( k ) { q.set( k, extra[ k ] ); } );

        return q.toString();
    }

    // Delete one path (string) or several (array): DELETE ?paths=a&paths=b
    // Items go to the trash can (papelera), not away for good.
    function deletePaths( paths )
    {
        return fetchText( API_FILES + "?" + pathsQuery( paths ), { method: "DELETE" } )
               .then( changed( [].concat( paths ), true ) );
    }

    // The same delete, for an Undo: resolves to the bin ids of what went in
    // (trashRestore( ids ) puts them back), or null from a server too old to
    // say - the caller then shows a plain toast, no Undo.
    function binPaths( paths )
    {
        return deletePaths( paths ).then( function ( text )
        {
            var ids = null;
            try { ids = JSON.parse( text ).ids; } catch ( e ) {}
            return Array.isArray( ids ) ? ids : null;
        } );
    }

    // Delete for good, skipping the trash: DELETE ?paths=a&paths=b&purge=1
    // Only allowed under data/ (the app-owned sidecars the user never sees in
    // Drive - scan caches, thumbnails); anything else is refused with 403. Use
    // it for derived files that can be rebuilt, never for the user's own stuff.
    function purgePaths( paths )
    {
        return fetchText( API_FILES + "?" + pathsQuery( paths, { purge: "1" } ),
                          { method: "DELETE" } );
    }

    // Move / rename a path. POST ?old=&new=
    function rename( oldPath, newPath )
    {
        var q = new URLSearchParams( { old: oldPath, "new": newPath } ).toString();
        return fetchText( API_FILES + "?" + q, { method: "POST" } )
               .then( changed( [ oldPath, newPath ], true ) );
    }

    //------------------------------------------------------------------------//
    // TRASH CAN (papelera)
    //
    // deletePaths() moves items into the server-side trash instead of deleting
    // them. These drive the "Papelera" view: list / restore / empty /
    // permanently delete. `ids` are the entryIds returned by trashList().

    function trashList()
    {
        return fetchText( API_FILES + "?trash=list" ).then( function ( t )
        {
            return ( JSON.parse( t ).items ) || [];
        } );
    }

    function trashRestore( ids )
    {
        var q = new URLSearchParams( { trash: "restore", ids: ids.join( ";" ) } ).toString();
        return fetchText( API_FILES + "?" + q, { method: "POST" } ).then( JSON.parse );
    }

    function trashEmpty()
    {
        return fetchText( API_FILES + "?trash=empty", { method: "POST" } ).then( JSON.parse );
    }

    function trashDelete( ids )
    {
        var q = new URLSearchParams( { trash: "1", ids: ids.join( ";" ) } ).toString();
        return fetchText( API_FILES + "?" + q, { method: "DELETE" } ).then( JSON.parse );
    }

    // How many days an item stays in the trash before it is purged for good.
    // trashDays() -> { days, default }; setTrashDays(n) -> { days }.
    function trashDays()
    {
        return fetchText( API_FILES + "?trash=days" ).then( JSON.parse );
    }

    function setTrashDays( n )
    {
        var q = new URLSearchParams( { trash: "days", value: String( n ) } ).toString();
        return fetchText( API_FILES + "?" + q, { method: "POST" } ).then( JSON.parse );
    }

    //------------------------------------------------------------------------//
    // ACCESS PROBE
    //
    // GET /api/whoami: 200 + { user, role } for a signed-in visitor, 401 for an
    // anonymous one. Answered from the server's session table - it never
    // touches the disk (the old probe fetched the whole file tree just to
    // check the cookie). Rejects on any failure; the caller decides whether
    // that means "go to login" or "open from the offline cache".

    function probeAccess()
    {
        return fetchText( API_WHOAMI ).then( JSON.parse );
    }

    // Send the browser to the sign-in page, returning here afterwards. The one
    // copy is NayiveUI.loginRedirect (shared/ui.js, loaded by every page that
    // loads this file); called only after boot, never while scripts load.
    function loginRedirect()
    {
        NayiveUI.loginRedirect();
    }

    //------------------------------------------------------------------------//

    window.GumApi =
    {
        API_FILES:       API_FILES,

        // fetch (retry transient drops)
        fetchText:       fetchText,
        fetchBinary:     fetchBinary,
        putBinary:       putBinary,

        // files
        fileUrl:         fileUrl,
        readFile:        readFile,
        readFileBytes:   readFileBytes,
        readVersion:     readVersion,
        versionOf:       versionOf,
        writeFileBytes:  writeFileBytes,
        createFileBytes: createFileBytes,
        readJson:        readJson,
        writeJson:       writeJson,
        updateJson:      updateJson,
        listDir:         listDir,
        listDirRecursive: listDirRecursive,
        dirTree:         dirTree,
        find:            find,
        search:          search,
        biggest:         biggest,
        makeDir:         makeDir,
        deletePaths:     deletePaths,
        binPaths:        binPaths,
        purgePaths:      purgePaths,
        rename:          rename,
        onFilesChanged:  onFilesChanged,
        announce:        announce,

        // trash can
        trashList:       trashList,
        trashRestore:    trashRestore,
        trashEmpty:      trashEmpty,
        trashDelete:     trashDelete,
        trashDays:       trashDays,
        setTrashDays:    setTrashDays,

        // access
        probeAccess:     probeAccess,
        loginRedirect:   loginRedirect
    };
} )();
