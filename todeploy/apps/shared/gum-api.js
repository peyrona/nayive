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
 */
( function ()
{
    "use strict";

    var API_FILES  = window.location.origin + "/api/files";
    var API_WHOAMI = window.location.origin + "/api/whoami";

    var MAX_RETRIES = 2;
    var BASE_DELAY  = 500;   // ms; doubles each retry (500, 1000)

    //------------------------------------------------------------------------//
    // FETCH WITH RETRY
    //
    // Two retries with exponential backoff, but ONLY for a thrown "Failed to
    // fetch" - a genuine connectivity drop. A non-2xx response is turned into a
    // thrown Error and passed straight through, never retried.

    function sleep( ms )
    {
        return new Promise( function ( r ) { setTimeout( r, ms ); } );
    }

    async function withRetry( attempt, tries )
    {
        tries = tries || 0;

        try
        {
            return await attempt();
        }
        catch ( err )
        {
            if( tries < MAX_RETRIES && String( err && err.message ).indexOf( "Failed to fetch" ) !== -1 )
            {
                await sleep( BASE_DELAY * Math.pow( 2, tries ) );
                return withRetry( attempt, tries + 1 );
            }

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
            // Message format is load-bearing: share-target, ui.launcherFolder and
            // media.js sniff it for "401". Keep it as it is.
            throw new Error( "HTTP " + res.status + ": " + res.statusText );
        }

        return res;
    }

    // GET (or any method via `options`) -> response body as text.
    function fetchText( url, options )
    {
        return withRetry( function ()
        {
            return fetch( url, options || {} ).then( assertOk ).then( function ( r ) { return r.text(); } );
        } );
    }

    // GET -> response body as a Uint8Array.
    function fetchBinary( url, options )
    {
        return withRetry( function ()
        {
            return fetch( url, options || {} ).then( assertOk )
                   .then( function ( r ) { return r.arrayBuffer(); } )
                   .then( function ( buf ) { return new Uint8Array( buf ); } );
        } );
    }

    // PUT raw bytes (a Uint8Array or a Blob). Resolves with nothing; rejects
    // on a non-2xx or a drop that outlasts the retries.
    //
    // XMLHttpRequest rather than fetch(), because only XHR reports UPLOAD
    // progress. Every attempt is announced as "nayive:upload" events on the
    // document - { id, loaded, total } while it runs, { id, done: true } when it
    // ends, however it ends - and shared/ui.js draws the progress bar from them.
    // Nothing here depends on ui.js: with no listener the events go nowhere.
    //
    // The two contracts fetch() had are kept exactly: a non-2xx goes through
    // assertOk (same "HTTP <status>: <text>" message, sniffed for "401"
    // downstream), and a dropped connection throws "Failed to fetch" - the one
    // message withRetry retries on. A retry is a new attempt, with a new id.
    var uploadSeq = 0;

    function announceUpload( detail )
    {
        try { document.dispatchEvent( new CustomEvent( "nayive:upload", { detail: detail } ) ); }
        catch ( e ) {}
    }

    function putBinary( url, bytes )
    {
        var size = ( bytes && ( bytes.size !== undefined ? bytes.size : bytes.byteLength ) ) || 0;

        return withRetry( function ()
        {
            return new Promise( function ( resolve, reject )
            {
                var id  = ++uploadSeq;
                var xhr = new XMLHttpRequest();

                function end() { announceUpload( { id: id, done: true } ); }

                xhr.open( "PUT", url );
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
                               statusText: xhr.statusText, url: xhr.responseURL || url } );
                };
                xhr.onerror = xhr.onabort = xhr.ontimeout = function ()
                {
                    end();
                    reject( new TypeError( "Failed to fetch" ) );
                };

                announceUpload( { id: id, loaded: 0, total: size } );
                xhr.send( bytes );
            } ).then( assertOk ).then( function () {} );
        } );
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
    // opts.convert = "mp4": the server also queues the file for conversion
    // (Drive's "Subir y convertir" - server/go/convert.go). Anything else, or
    // no opts, is a plain upload.
    function writeFileBytes( path, bytes, opts )
    {
        var url = fileUrl( path );
        if( opts && opts.convert ) url += "&convert=" + encodeURIComponent( opts.convert );
        return putBinary( url, bytes );
    }

    // Small JSON sidecar helpers (data/<app>/config.json and friends). readJson
    // resolves null when the file isn't there yet (a fresh account); any other
    // failure - including a 401 - is thrown so the caller can react. writeJson
    // creates missing parent folders, same as a plain PUT.
    async function readJson( path )
    {
        try { return JSON.parse( await readFile( path ) ); }
        catch ( e )
        {
            if( String( e && e.message ).indexOf( "HTTP 404" ) !== -1 ) return null;
            throw e;
        }
    }

    function writeJson( path, obj )
    {
        return writeFileBytes( path, new TextEncoder().encode( JSON.stringify( obj, null, 1 ) ) );
    }

    // The whole recursive file tree (a GET with no ?file= param), parsed.
    // EXPENSIVE on the server (it walks every folder of the account) - prefer
    // listDir() / listDirRecursive() / dirTree() below. Kept for completeness.
    async function readTree()
    {
        return JSON.parse( await fetchText( API_FILES ) );
    }

    // ONE level of the tree: the files AND sub-folders directly inside `path`
    // (a virtual path like "files/photos"; "" or omitted = the virtual root).
    // GET ?dir=<path>  -> { path, role, user, nodes: [...] } where each node is
    // the same shape readTree() uses: a file has nodes:null + size + mtime, a
    // sub-folder has nodes:[] and is not expanded. Cheap even when the folder
    // holds thousands of files - use this instead of readTree() when you only
    // need one folder.
    async function listDir( path )
    {
        // "/" (not "") for the root: an empty query value gets dropped before it
        // reaches the handler; the server strips the slash back off.
        var q = new URLSearchParams( { dir: path || "/" } ).toString();
        return JSON.parse( await fetchText( API_FILES + "?" + q ) );
    }

    // The whole subtree under ONE folder (that folder's files and sub-folders,
    // sub-folders' files, ...), in one call. `path` must not be "" (the virtual
    // root). Same node shape as readTree()/listDir(); a sub-folder's `nodes` is
    // fully expanded, not the empty-array stub listDir() gives you. Rejects
    // with "HTTP 404" when the folder does not exist yet.
    async function listDirRecursive( path )
    {
        var q = new URLSearchParams( { dir: path, recursive: "1" } ).toString();
        return JSON.parse( await fetchText( API_FILES + "?" + q ) );
    }

    // The whole virtual root as a FOLDERS-ONLY recursive tree (no file nodes).
    // GET ?tree=dirs  -> { path, role, user, nodes } - same wrapper shape as
    // readTree(), but a folder that holds thousands of files still adds just one
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

    // Create a directory `name` under `parent` (a path relative to the served
    // root). PUT ?type=dir&name=&parent=
    function makeDir( parent, name )
    {
        var q = new URLSearchParams( { type: "dir", name: name, parent: parent } ).toString();
        return fetchText( API_FILES + "?" + q, { method: "PUT" } );
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
        return fetchText( API_FILES + "?" + pathsQuery( paths ), { method: "DELETE" } );
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
        return fetchText( API_FILES + "?" + q, { method: "POST" } );
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

    // Send the browser to the sign-in page, returning here afterwards.
    // Framed (Planner's iframes): navigate the TOP window, or the sign-in form
    // would render inside the frame. A cross-origin `top.location` throws;
    // then we fall back to ourselves.
    function loginRedirect()
    {
        var win = window;
        try { if( window.top !== window && window.top.location.pathname ) win = window.top; } catch ( e ) {}
        win.location.href = "/nayive/login.html?return=" +
            encodeURIComponent( win.location.pathname + win.location.search );
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
        writeFileBytes:  writeFileBytes,
        readJson:        readJson,
        writeJson:       writeJson,
        readTree:        readTree,
        listDir:         listDir,
        listDirRecursive: listDirRecursive,
        dirTree:         dirTree,
        find:            find,
        makeDir:         makeDir,
        deletePaths:     deletePaths,
        purgePaths:      purgePaths,
        rename:          rename,

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
