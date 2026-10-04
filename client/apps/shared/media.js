// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * media.js - the code the three media apps (photos, music, movies) share.
 *
 * Each of them used to carry its own copy of the same small helpers (HTML
 * escaping, path / extension utils, the hash-to-colour, time formats), the
 * same "scan cache" (data/<app>/scan-cache.json keyed by path + size + mtime),
 * the same duration probe, the same crumb / scope bar / folder tree markup,
 * the same play icon, MediaSession wrapper, folder-load error handling and
 * phone search toggle. This is the single copy. Plain classic script, one
 * global:
 *
 *     <script src="../shared/media.js"></script>     <- NOT deferred, placed
 *                                                       right before the app's
 *                                                       own inline script
 *
 * It must not be deferred: the apps' inline scripts run at parse time and
 * take what they need from NayiveMedia on their first line. Nothing here
 * touches the DOM or GumApi / NayiveUI at load time - only inside functions,
 * which the apps call after DOMContentLoaded.
 *
 * Drive loads it too, deferred, for one block only: PATH-KEYED SIDECARS, the
 * upkeep of data/photos/comments.json and the scan caches when a file is moved,
 * renamed, copied or trashed. Drive is the only app that moves files, but the
 * layout of those files belongs to the media apps, so it lives here rather than
 * in drive/index.html (moved 2026-09-07).
 */
( function ()
{
    "use strict";

    //------------------------------------------------------------------------//
    // TEXT / PATH HELPERS

    // The shared copies (shared/ui.js). ui.js loads deferred, after this file
    // in Movies / Music / Photos, so these look NayiveUI up when called.
    function esc( s )         { return NayiveUI.escapeHtml( s ); }
    function cssEsc( s ) { return String( s ).replace( /["\\]/g, "\\$&" ); }
    function cssUrl( u ) { return "url(\"" + cssEsc( u ) + "\")"; }

    function extOf( name )    { return NayiveUI.extOf( name ); }
    function baseName( path ) { return NayiveUI.baseName( path ); }
    function dirOf( path )    { var i = String( path ).lastIndexOf( "/" ); return i < 0 ? "" : String( path ).slice( 0, i ); }
    function stripExt( name ) { return String( name ).replace( /\.[a-z0-9]+$/i, "" ); }
    // Letters and digits of every script, so "Alién" is not "Alin" and two
    // Cyrillic titles are not both "". NFC first: a macOS file name spells
    // "é" as "e" + an accent mark, which would drop the accent.
    function norm( s )        { return String( s || "" ).normalize( "NFC" ).toLowerCase().replace( /[^\p{L}\p{N}]+/gu, "" ); }

    // Tile colour cycled by a stable hash of a name, so the same album / film
    // gets the same colour across reloads.
    var PALETTE = [ "#2E6B8A", "#3E86AE", "#6B5B95", "#8A3E3E", "#2E8A78", "#8A6A2E", "#5E4B8A", "#3E6B4A" ];
    function colorFor( key )
    {
        var h = 0;
        key = String( key || "" );
        for( var i = 0; i < key.length; i++ ) h = ( h * 31 + key.charCodeAt( i ) ) | 0;
        return PALETTE[ Math.abs( h ) % PALETTE.length ];
    }

    // 65 -> "1:05", 3725 -> "1:02:05"
    function fmtClock( totalSeconds )
    {
        if( ! isFinite( totalSeconds ) || totalSeconds < 0 ) return "0:00";
        var s = Math.floor( totalSeconds );
        var h = Math.floor( s / 3600 );
        var m = Math.floor( ( s % 3600 ) / 60 );
        var r = s % 60;
        var rr = r < 10 ? "0" + r : "" + r;
        if( h > 0 ) return h + ":" + ( m < 10 ? "0" + m : m ) + ":" + rr;
        return m + ":" + rr;
    }
    // 5400 -> "1 h 30 min"
    function fmtRuntime( totalSeconds )
    {
        if( ! isFinite( totalSeconds ) || totalSeconds <= 0 ) return "";
        var mins = Math.round( totalSeconds / 60 );
        var h = Math.floor( mins / 60 );
        var m = mins % 60;
        return h > 0 ? ( h + " h " + m + " min" ) : ( m + " min" );
    }
    // Photos' own look ("1 KB", "15.3 MB"), not NayiveUI.fmtBytes ("1.5 KB",
    // "15 MB"): the info panel keeps what it always showed, but a big video
    // reads "5.0 GB", not "5120.0 MB".
    function fmtSize( b )
    {
        if( ! b ) return "";
        if( b < 1024 )    return b + " B";
        if( b < 1048576 ) return Math.round( b / 1024 ) + " KB";
        if( b < 1073741824 ) return ( b / 1048576 ).toFixed( 1 ) + " MB";
        if( b < 1099511627776 ) return ( b / 1073741824 ).toFixed( 1 ) + " GB";
        return ( b / 1099511627776 ).toFixed( 1 ) + " TB";
    }

    function sleep( ms ) { return new Promise( function ( r ) { setTimeout( r, ms ); } ); }

    // Run `worker(item)` over `items`, at most `n` at a time.
    async function pool( items, n, worker )
    {
        var i = 0;
        async function run() { while( i < items.length ) { var k = i++; await worker( items[ k ] ); } }
        var runners = [];
        for( var w = 0; w < Math.min( n, items.length ); w++ ) runners.push( run() );
        await Promise.all( runners );
    }

    //------------------------------------------------------------------------//
    // THE FOLDER

    // Every file node under a listDirRecursive() tree, flattened; `exts` (an
    // array of lower-case extensions) keeps only those types.
    function flattenFiles( node, exts )
    {
        var out = [];
        ( function walk( n )
        {
            if( ! n || ! n.nodes ) return;
            n.nodes.forEach( function ( c )
            {
                if( c.nodes === null || c.nodes === undefined )
                {
                    if( ! exts || exts.indexOf( extOf( c.path ) ) !== -1 ) out.push( c );
                }
                else walk( c );
            } );
        } )( node );
        return out;
    }

    // List the app's folder - one level (listDir) or the whole subtree
    // (listDirRecursive) - and explain the failure in the app's own message
    // slot when it can't: a missing folder, an expired session (-> the sign-in
    // page), or no answer. Resolves with the listing, or null after having
    // reported.
    async function loadFolderTree( dir, onMsg, recursive )
    {
        try { return await ( recursive ? GumApi.listDirRecursive( dir ) : GumApi.listDir( dir ) ); }
        catch( err )
        {
            var st = err && err.status;
            // 403 = a share that was taken back (or never ours). NOT a sign-in
            // problem, so it must never bounce the page to the login page. Only
            // a 401 does: a server restarting, or Wi-Fi with no internet
            // behind it, is "try again", not "sign in".
            if( st === 404 )      onMsg( NayiveUI.t( 'media.folderGone' ) );
            else if( st === 403 ) onMsg( NayiveUI.t( 'media.noAccess' ) );
            else if( st === 401 ) GumApi.loginRedirect();
            else onMsg( NayiveUI.t( navigator.onLine ? 'ui.loadFailed' : 'media.offlineRetry' ) );
            return null;
        }
    }

    // "files/viajes/lisboa" -> "viajes/lisboa"; the root -> "Archivos".
    // "shared/<slug>" is a folder another user shared with us - say so.
    // "shared/<slug>/~/files/a/b" is a folder a shared TRIP lends (its photos);
    // the "~" plumbing means nothing to the reader, so only the name is shown.
    function dirLabel( dir )
    {
        var s = String( dir || "" );
        if( s.indexOf( "shared/" ) === 0 )
        {
            var ext = s.indexOf( "/~/" );
            return NayiveUI.tf( "media.sharedBy", { what: ext === -1 ? s.slice( 7 ) : s.split( "/" ).pop() } );
        }
        return s.replace( /^files\//, "" ).replace( /^data\//, "" ) || NayiveUI.t( "ui.filesRoot" );
    }

    // The crumb (first row of the folder-? menu): folder icon + the label.
    function setCrumb( label )
    {
        var el = document.getElementById( "crumb" );
        if( el ) el.innerHTML = NayiveUI.icon( "folder" ) + "<span>" + esc( label ) + "</span>";
    }

    // The folder-? button (#folderInfoBtn) opens its menu (#folderMenu): the
    // crumb, then the counts line (#subStrip). See FOLDER-BACKED VIEWERS in
    // shared/app.css. Photos calls this before the deferred ui.js has run.
    function wireFolderInfo()
    {
        var wire = function () { NayiveUI.wireMenu( { btn: "folderInfoBtn", menu: "folderMenu" } ); };
        if( window.NayiveUI ) wire();
        else document.addEventListener( "DOMContentLoaded", wire );
    }

    // The crumb re-opens the folder picker; a new choice reloads the app on
    // it. `opts` go to NayiveUI.changeLauncherFolder ({ app, allowRoot,
    // rootLabel }); `opts.when()` (optional) can veto, e.g. Photos' demo mode.
    function wireCrumbPicker( opts )
    {
        var el = document.getElementById( "crumb" );
        if( ! el ) return;
        el.addEventListener( "click", async function ()
        {
            if( opts.when && ! opts.when() ) return;
            var f = await NayiveUI.changeLauncherFolder( opts );
            if( f ) location.href = "?dir=" + encodeURIComponent( f );
        } );
    }

    // The magnifier (#searchToggle) unfolds the search field (#searchInput,
    // in its .search-wrap) - the shared fold (NayiveUI.searchFold); its × and
    // Escape clear the search (an "input" event) and fold it away. Photos
    // calls this before the deferred ui.js has run: it then waits for it.
    var searchFold = null;
    function wireSearchToggle()
    {
        var btn = document.getElementById( "searchToggle" ), box = document.getElementById( "searchInput" );
        if( ! btn || ! box ) return;
        var wire = function () { searchFold = NayiveUI.searchFold( { box: box.parentElement, input: box, toggle: btn } ); };
        if( window.NayiveUI ) wire();
        else document.addEventListener( "DOMContentLoaded", wire );
    }

    // "12 / 300" inside the search field while it holds text; nothing else.
    function searchCount( shown, total )
    {
        var box = document.getElementById( "searchInput" );
        if( ! searchFold || ! box ) return;
        searchFold.count( box.value.trim() ? shown + " / " + total : "" );
    }

    //------------------------------------------------------------------------//
    // SCAN CACHE  -  data/<app>/scan-cache.json
    //
    // Reading a file's metadata (EXIF, ID3, a track's length) costs a network
    // round trip per file, so the result is remembered here keyed by path,
    // next to the file's size + mtime. A file that still matches its entry is
    // taken from the cache; only new or changed files are read again. A move /
    // rename / trash in Drive goes through the PATH-KEYED SIDECARS block below,
    // which re-keys or drops entries; prune() is the app's own sweep of what is
    // left.
    //
    //   var cache = NayiveMedia.scanCache( "data/music/scan-cache.json" );
    //   await cache.load();                    // cache.loaded says if it worked
    //   var e = cache.hit( item );             // entry when size+mtime match, else null
    //   cache.set( item, { title: ... } );     // record + a save: every SCAN_BATCH
    //                                          // new entries, or 2.5 s after the last
    //   cache.prune( alivePaths, inScope );    // drop dead entries; true if any
    //   cache.save() / cache.saveNow()         // debounced / immediate write
    //   cache.flush()                          // saveNow, only if set() ran since the last flush
    //   cache.map                              // the raw { path: entry } object
    //
    // A cache that could not be read (cache.loaded false) is never written:
    // set, prune and the saves do nothing then - its empty map would be
    // merged over the real file (the trap the apps each guarded by hand).
    //
    // A save is MERGED over the file as it is at that moment, never written
    // whole from memory: Drive's re-keys (remapPaths below) and another
    // device's scans since our load stay. What this page removed from `map`
    // (prune, or a plain delete) since its load or last save goes from the
    // file too; a file that cannot be read then is not written at all.
    var SCAN_BATCH = 500;

    function scanCache( path )
    {
        var timer   = null;
        var unsaved = 0;          // set() calls since the last save
        var known   = {};         // the keys the file had at our last load / save
        var dirty   = false;      // set() since the last flush()
        var self = {
            map: {},
            loaded: false,
            load: async function ()
            {
                try { self.map = ( await GumApi.readJson( path ) ) || {}; self.loaded = true; }
                catch( e ) { self.map = {}; self.loaded = false; }
                known = {};
                Object.keys( self.map ).forEach( function ( k ) { known[ k ] = true; } );
                return self.map;
            },
            hit: function ( item )
            {
                var e = self.map[ item.path ];
                return e && e.size === item.size && e.mtime === item.mtime ? e : null;
            },
            set: function ( item, fields )
            {
                if( ! self.loaded ) return;
                dirty = true;
                self.map[ item.path ] = Object.assign( self.map[ item.path ] || {},
                                                       { size: item.size, mtime: item.mtime }, fields );
                // A first scan of 20 000 photos sets as fast as it reads: the
                // whole file went up every 2.5 s. Now once per SCAN_BATCH, and
                // the tail 2.5 s after the last one.
                if( ++unsaved >= SCAN_BATCH ) self.saveNow();
                else
                {
                    clearTimeout( timer );
                    timer = setTimeout( function () { timer = null; self.saveNow(); }, 2500 );
                }
            },
            // `alive`: a Set (or array) of the paths still present. `inScope(key)`
            // (optional) limits the sweep - Photos lists one folder at a time,
            // so it may only judge that folder's entries.
            prune: function ( alive, inScope )
            {
                if( ! self.loaded ) return false;
                var has = alive instanceof Set ? function ( k ) { return alive.has( k ); }
                                               : function ( k ) { return alive.indexOf( k ) !== -1; };
                var dropped = false;
                Object.keys( self.map ).forEach( function ( k )
                {
                    if( inScope && ! inScope( k ) ) return;
                    if( ! has( k ) ) { delete self.map[ k ]; dropped = true; }
                } );
                return dropped;
            },
            save: function ()
            {
                if( timer || ! self.loaded ) return;
                timer = setTimeout( function () { timer = null; self.saveNow(); }, 2500 );
            },
            saveNow: async function ()
            {
                if( timer ) { clearTimeout( timer ); timer = null; }
                if( ! self.loaded ) return;
                unsaved = 0;

                // Version-checked (GumApi.updateJson): a re-key or a scan saved
                // elsewhere between the read and the write makes it read again
                // and merge again, never write over it. `out` is made afresh on
                // each round, from this page's map and the file as it is then.
                var map = self.map, out, fresh;
                try
                {
                    out = await GumApi.updateJson( path, function ( disk )
                    {
                        if( ! disk || typeof disk !== "object" || Array.isArray( disk ) ) disk = {};
                        var next = Object.assign( {}, map );
                        fresh = {};
                        Object.keys( disk ).forEach( function ( k )
                        {
                            if( ! ( k in map ) && ! known[ k ] ) next[ k ] = fresh[ k ] = disk[ k ];   // new there since
                        } );
                        return next;
                    } );
                }
                catch( e ) { return; }

                // Into self.map in place: callers hold it and write to it.
                Object.keys( fresh ).forEach( function ( k ) { if( ! ( k in map ) ) map[ k ] = fresh[ k ]; } );
                known = {};
                Object.keys( out ).forEach( function ( k ) { known[ k ] = true; } );
            },
            flush: function ()
            {
                if( ! dirty ) return;
                dirty = false;
                return self.saveNow();
            }
        };
        return self;
    }

    //------------------------------------------------------------------------//
    // PATH-KEYED SIDECARS
    //
    // Two of our files are keyed by the file's own path: the per-photo comments
    // (data/photos/comments.json, written by Photos and by the image editor (apps/image))
    // and the scan caches above (data/<app>/scan-cache.json). Whoever moves,
    // renames, copies or trashes a file has to keep them in step, or a note
    // ends up on the wrong photo and a shuffled folder is re-scanned from
    // scratch. Two callers move things: Drive, and the folder picker in
    // shared/ui.js (rename / trash a folder), which loads this file on demand
    // in the apps that do not have it. The layout of these files is ours, not
    // theirs, which is why the code lives here (moved out of drive/index.html
    // 2026-09-07).
    //
    //   await NayiveMedia.remapPaths( [ [ old, new ], ... ] );  // move / rename
    //   await NayiveMedia.copyPaths ( [ [ src, dst ], ... ] );  // copy
    //   await NayiveMedia.purgePaths( [ path, ... ] );          // to the papelera
    //
    // All three are best-effort and never throw: a failure here must not undo
    // or block the file operation that triggered it, and the worst it costs is
    // a re-probe. Nothing is done at load time.

    var COMMENTS_PATH = "data/photos/comments.json";
    var PHOTOS_SCAN   = "data/photos/scan-cache.json";
    var SCAN_CACHES   = [ PHOTOS_SCAN, "data/music/scan-cache.json", "data/movies/scan-cache.json" ];

    // Movies' resume points and "watched" marks: two path-keyed maps inside
    // one file ({ version, watched: {}, resume: {} }).
    var MOVIES_PROGRESS = "data/movies/progress.json";

    // The comment map, read afresh on every call - never cached: a Drive left
    // open all day would otherwise write its old copy back and wipe the notes
    // Photos added meanwhile, so every read-modify-write starts from the file.
    // A file that is not there yet (404) is an empty map; ANY other error, or a
    // file that is not a map, is thrown, because a network hiccup must not
    // masquerade as "no comments" - the next write would wipe every one of them.
    async function readComments()
    {
        return notesMap( await GumApi.readJson( COMMENTS_PATH ) );
    }

    function notesMap( map )
    {
        map = map || {};
        if( typeof map !== "object" || Array.isArray( map ) ) throw new Error( "comments.json is not a map" );
        return map;
    }

    // The ONLY way the notes are written: `change( map )` gets the notes as
    // they are on the server now and changes them in place - false: nothing
    // to write. Version-checked (GumApi.updateJson): a note saved elsewhere
    // between the read and the write makes the read and `change` happen
    // again, so `change` must be its own edit only, made again on what it is
    // given. Resolves the map as written (or read); throws, writing nothing,
    // when the notes cannot be read (readComments' rule) or the write fails.
    function updateComments( change )
    {
        return GumApi.updateJson( COMMENTS_PATH, function ( raw )
        {
            var map = notesMap( raw );
            return change( map ) === false ? false : map;
        } );
    }

    // PARKED NOTES. A binned photo keeps its note at its old path (purgePaths
    // below), so a restore brings it back. But when another item then takes
    // that path - a move or rename with "Replace", or onto the name of
    // something binned earlier - the note there belongs to the binned item,
    // not to the newcomer: written over, it was lost for good; left alone, it
    // showed on the wrong photo. So it is parked under this one reserved key,
    // { "<path>": [ note, ..., newest last ] }, and goes back to its path the
    // moment that path is left again (moveNotes): Drive's Undo moves the
    // newcomer away BEFORE it restores the binned item, so both notes come
    // back. "#" can never start a path, and every reader looks notes up by
    // path (Photos' sweep skips this key on purpose). The image editor's
    // "Save a copy" writes a NEW file at a path, so it parks too
    // (parkNotes / unparkNotes, synchronous, on a map it has just read).
    var ASIDE = "#aside";

    // Re-key `map` in place: the entry at oldPath, and everything under
    // "oldPath/", moves to the new location - so a whole folder follows in one
    // pass. `keep` leaves the originals behind (a copy). True if anything moved.
    function rekey( map, pairs, keep )
    {
        var changed = false;
        pairs.forEach( function ( pair )
        {
            var oldPath = pair[ 0 ], newPath = pair[ 1 ];
            var oldPre  = oldPath + "/", newPre = newPath + "/";
            Object.keys( map ).forEach( function ( key )
            {
                var dst = null;
                if( key === oldPath )                  dst = newPath;
                else if( key.indexOf( oldPre ) === 0 ) dst = newPre + key.slice( oldPre.length );
                if( dst === null || dst === key ) return;   // dst === key would delete it below
                map[ dst ] = map[ key ];
                if( ! keep ) delete map[ key ];
                changed = true;
            } );
        } );
        return changed;
    }

    // Read one sidecar, hand the map to `mutate`, write it back if that returns
    // true. A missing or unreadable file is simply left alone. Version-checked
    // (C7, GumApi.updateJson): Movies' resume points and the scan caches are
    // saved by other devices too, and one saved between this read and this
    // write makes it read again and `mutate` again - never written over.
    async function editSidecar( path, mutate )
    {
        try
        {
            await GumApi.updateJson( path, function ( map )
            {
                map = map || {};
                if( typeof map !== "object" || Array.isArray( map ) ) return false;
                return mutate( map ) ? map : false;
            } );
        }
        catch( e ) {}
    }

    // rekey() for the notes, one pair at a time and in order: first whatever
    // sits at the destination (or inside it) is parked - the server never
    // moves or copies over an existing item (409), so a note there is a binned
    // item's - then the notes move, then (a move only: a copy leaves the
    // source where it was) the notes parked for the path just left come back.
    function moveNotes( map, pairs, keep )
    {
        var changed = false;
        pairs.forEach( function ( pair )
        {
            var oldPath = pair[ 0 ], newPath = pair[ 1 ];
            if( oldPath === newPath ) return;
            if( park( map, newPath, oldPath ) ) changed = true;
            if( rekey( map, [ pair ], keep ) ) changed = true;
            if( ! keep && unpark( map, oldPath, false ) ) changed = true;
        } );
        return changed;
    }

    // `map`'s parked notes ({} when none), and storing them back (the key goes
    // when nothing is parked any more).
    function asideOf( map )
    {
        var a = map[ ASIDE ];
        return a && typeof a === "object" && ! Array.isArray( a ) ? a : {};
    }
    function setAside( map, aside )
    {
        if( Object.keys( aside ).length ) map[ ASIDE ] = aside;
        else delete map[ ASIDE ];
    }
    function under( key, path ) { return key === path || key.indexOf( path + "/" ) === 0; }

    // Park the notes at `path` and inside it - except those under `except`
    // (what is moving there right now). True if anything was parked.
    function park( map, path, except )
    {
        var aside = asideOf( map ), changed = false;
        Object.keys( map ).forEach( function ( key )
        {
            if( key === ASIDE || ! under( key, path ) ) return;
            if( except != null && under( key, except ) ) return;
            if( ! Array.isArray( aside[ key ] ) ) aside[ key ] = [];
            aside[ key ].push( map[ key ] );
            delete map[ key ];
            changed = true;
        } );
        setAside( map, aside );
        return changed;
    }

    // The newest note parked for `path` and for everything inside it goes back
    // to its key. A key that holds a note stays as it is (the note stays
    // parked) unless `over`: the caller has just put the parked item itself
    // back at its path. True if anything changed.
    function unpark( map, path, over )
    {
        var aside = asideOf( map ), changed = false;
        Object.keys( aside ).forEach( function ( key )
        {
            if( ! under( key, path ) ) return;
            var list = aside[ key ];
            if( ! Array.isArray( list ) || ! list.length ) { delete aside[ key ]; changed = true; return; }
            if( key in map && ! over ) return;      // taken after all: it stays parked
            map[ key ] = list.pop();
            if( ! list.length ) delete aside[ key ];
            changed = true;
        } );
        setAside( map, aside );
        return changed;
    }

    // C7: the notes file is shared with Photos, the image editor and every
    // other device. Only this operation's keys move, and the write is
    // version-checked (updateComments): a note saved elsewhere meanwhile
    // makes the move be worked out again on the fresh copy.
    //
    // A move whose notes could NOT follow (no connection, the file busy round
    // after round) is not dropped: the notes would stay at the old path, and
    // Photos' sweep would delete them there - its photo is gone from that
    // folder. The move waits on this device (localStorage, per account) and
    // is made again before the next one, and before Photos sweeps (which
    // leaves alone what still waits); the user is told.
    async function remapComments( pairs, keep )
    {
        var waiting = waitingMoves();
        waiting.push( { pairs: pairs, keep: !! keep } );
        storeMoves( waiting );
        if( ! await settleNoteMoves() && window.NayiveUI ) NayiveUI.toast( NayiveUI.t( 'media.notesMoveFailed' ), { ms: 8000 } );
    }

    // The note moves still to be made on this device, oldest first.
    function movesKey() { return "nayive-notes-moves:" + ( ( window.GumApi && GumApi.owner && GumApi.owner() ) || "" ); }
    function waitingMoves()
    {
        try { var l = JSON.parse( localStorage.getItem( movesKey() ) || "[]" ); return Array.isArray( l ) ? l : []; }
        catch( e ) { return []; }
    }
    function storeMoves( list )
    {
        try { if( list.length ) localStorage.setItem( movesKey(), JSON.stringify( list ) ); else localStorage.removeItem( movesKey() ); }
        catch( e ) {}
    }

    // Makes the waiting note moves, in order, each one version-checked; one
    // that fails stops the rest (they must not overtake it). True when none
    // waits any more.
    // The list is shared by every tab: one tab at a time makes it (a Web
    // Lock), so the same move is never made twice - a second run parked the
    // note the first had just moved. A tab stuck holding it 30 s: this round
    // is skipped (false: the moves stay queued, the user is told).
    var settling = null;     // the run in progress: a second caller waits for it
    function settleNoteMoves()
    {
        if( ! settling )
            settling = ( navigator.locks && window.AbortSignal && AbortSignal.timeout
                         ? navigator.locks.request( movesKey(), { signal: AbortSignal.timeout( 30000 ) }, makeMoves )
                                          .catch( function () { return false; } )
                         : makeMoves() )
                       .finally( function () { settling = null; } );
        return settling;
    }

    async function makeMoves()
    {
        var list = waitingMoves();
        while( list.length )
        {
            var m = list[ 0 ];
            try { await updateComments( function ( map ) { return moveNotes( map, m.pairs, m.keep ); } ); }
            catch( e ) { return false; }
            list = waitingMoves();
            if( list.length && JSON.stringify( list[ 0 ] ) === JSON.stringify( m ) ) list.shift();
            storeMoves( list );
        }
        return true;
    }

    // True when the note at `key` belongs to a move still waiting (its old
    // path, or inside it): Photos' sweep must leave it alone.
    function noteMoveWaits( key )
    {
        return waitingMoves().some( function ( m )
        {
            return ( m.pairs || [] ).some( function ( p ) { return under( key, p[ 0 ] ); } );
        } );
    }

    // A move / rename: both sidecars follow the file. os.rename keeps the size
    // and the mtime, so the scan entry is still valid at its new key - re-keying
    // it is what stops a shuffled folder being re-scanned from scratch.
    async function remapPaths( pairs )
    {
        if( ! pairs || ! pairs.length ) return;
        await remapComments( pairs, false );
        for( var i = 0; i < SCAN_CACHES.length; i++ )
            await editSidecar( SCAN_CACHES[ i ], function ( map ) { return rekey( map, pairs, false ); } );
        await editSidecar( MOVIES_PROGRESS, function ( prog )
        {
            var a = !! prog.watched && typeof prog.watched === "object" && rekey( prog.watched, pairs, false );
            var b = !! prog.resume  && typeof prog.resume  === "object" && rekey( prog.resume,  pairs, false );
            return a || b;
        } );
    }

    // A copy: the note is worth copying with the photo, the scan entry is not -
    // the copy has a fresh mtime, so it misses the cache and is re-read on first
    // view anyway.
    function copyPaths( pairs )
    {
        if( ! pairs || ! pairs.length ) return Promise.resolve();
        return remapComments( pairs, true );
    }

    // One sidecar's share of purgePaths(): drop every entry at (or under) one of
    // `paths`, collecting the Photos thumbnails that go with them.
    function purgeFrom( sc, paths, thumbs )
    {
        return editSidecar( sc, function ( map )
        {
            var changed = false;
            paths.forEach( function ( del )
            {
                var pre = del + "/";
                Object.keys( map ).forEach( function ( key )
                {
                    if( key !== del && key.indexOf( pre ) !== 0 ) return;
                    var e = map[ key ];
                    if( sc === PHOTOS_SCAN && e && e.size && e.mtime )
                        thumbs.push( "data/photos/thumbs/" + e.size + "_" + e.mtime + ".jpg" );
                    delete map[ key ];
                    changed = true;
                } );
            } );
            return changed;
        } );
    }

    // Paths just moved to the papelera. Their scan entries go, and so do the
    // Photos thumbnails made from them (the browser-made
    // data/photos/thumbs/<size>_<mtime>.jpg files - derived data, purged for
    // good rather than cluttering the papelera; Photos remakes one if the photo
    // is ever restored). Comments are deliberately NOT dropped: restoring the
    // photo should bring its note back with it.
    async function purgePaths( paths )
    {
        if( ! paths || ! paths.length ) return;
        var thumbs = [];
        for( var i = 0; i < SCAN_CACHES.length; i++ )
            await purgeFrom( SCAN_CACHES[ i ], paths, thumbs );
        // A cache read again after a 412 (editSidecar) collects its thumbnails again.
        thumbs = Array.from( new Set( thumbs ) );
        for( var j = 0; j < thumbs.length; j += 100 )      // keep each URL a sane length
            try { await GumApi.purgePaths( thumbs.slice( j, j + 100 ) ); } catch( e ) {}
    }

    //------------------------------------------------------------------------//
    // BIG PICKS (Drive and Photos)
    //
    // The paths of a move to the bin and the ids of its Undo ride in the
    // address, and Ctrl+A in a folder of 1,300 photos made one the server
    // refuses (431, AB1). So both go in batches - the bin ids of all of them
    // make ONE Undo - and Download / Compress send the list in a body.
    var BIN_BATCH = 200;

    // To the bin in batches, each batch's scan entries and thumbnails purged
    // as it lands (the notes stay, for a restore). `wrap( promise )`
    // (optional) wraps each call: Drive's busy mark. Never throws; resolves
    //   { ids, sent, went, failed }
    // `ids`: the bin ids of what went, for the Undo (null when an old server
    // does not say them); `sent`: how many paths were asked before a batch
    // failed (a half-done batch counts whole); `went`: the paths that did go;
    // `failed`: a batch failed, so what came after it was never asked.
    async function binInBatches( paths, wrap )
    {
        var ids = [], sent = 0, went = [], failed = false;
        try
        {
            while( sent < paths.length )
            {
                var batch = paths.slice( sent, sent + BIN_BATCH ), got;
                try { got = await ( wrap ? wrap( GumApi.binPaths( batch ) ) : GumApi.binPaths( batch ) ); }
                catch( err )
                {
                    // Half done: some of this batch went (err.ids), the rest stayed (err.failed).
                    if( err && err.ids && err.ids.length )
                    {
                        sent += batch.length;
                        if( ids ) ids = ids.concat( err.ids );
                        var stayed = err.failed || [];
                        var gone = batch.filter( function ( p ) { return stayed.indexOf( p ) === -1; } );
                        went = went.concat( gone );
                        await purgePaths( gone );
                    }
                    throw err;
                }
                sent += batch.length;
                ids = ids && got ? ids.concat( got ) : null;     // an old server does not say them
                went = went.concat( batch );
                await purgePaths( batch );
            }
        }
        catch( e ) { failed = true; }
        return { ids: ids, sent: sent, went: went, failed: failed };
    }

    // The Undo: those bin ids back, in batches too. Resolves { renamed: [the
    // names one landed under, its old one taken meanwhile] }; throws when a
    // batch fails (the ones before it are back).
    async function restoreInBatches( ids, wrap )
    {
        var res = { renamed: [] };
        for( var i = 0; i < ids.length; i += BIN_BATCH )
        {
            var call = GumApi.trashRestore( ids.slice( i, i + BIN_BATCH ) );
            var r = await ( wrap ? wrap( call ) : call );
            if( r && r.renamed ) res.renamed = res.renamed.concat( r.renamed );
        }
        return res;
    }

    // The POST of a Download or a Compress of `paths`: in the address while
    // they fit - any server takes that - and in a JSON body past that.
    // Resolves to the answer's text, as GumApi.fetchText. The server reads a
    // body of 1 MiB at most (413 past it): a pick that big is refused here,
    // as "too many items at once" (err.tooMany).
    var PATHS_IN_URL  = 8000;
    var PATHS_IN_BODY = 1 << 20;    // server/go/response.go, maxBody

    function postPaths( url, paths )
    {
        var q = new URLSearchParams();
        paths.forEach( function ( p ) { q.append( "paths", p ); } );
        var query = q.toString();

        if( query.length <= PATHS_IN_URL ) return GumApi.fetchText( url + "?" + query, { method: "POST" } );

        var body = JSON.stringify( { paths: paths } );
        if( new TextEncoder().encode( body ).length > PATHS_IN_BODY )
        {
            var err = new Error( "too many items at once" );
            err.tooMany = true;
            return Promise.reject( err );
        }
        return GumApi.fetchText( url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body } );
    }

    //------------------------------------------------------------------------//
    // DURATION PROBE - a throwaway <audio> / <video> with preload=metadata.
    // Cheap: the server supports Range, so the browser only pulls the header.
    // Resolves with the length in seconds, or null - after PROBE_MS at most: a
    // file that stalls (neither metadata nor an error) must not hold its place
    // in the scan pool for ever.
    var PROBE_MS = 15000;

    function probeDuration( kind, url )
    {
        return new Promise( function ( resolve )
        {
            var probe = document.createElement( kind === "video" ? "video" : "audio" );
            var done = false;
            function finish( d )
            {
                if( done ) return;
                done = true;
                // load() with no src lets the player go: past Chrome's ~1000
                // live media players every new <audio> fails, not only <video>.
                probe.removeAttribute( "src" );
                probe.load();
                resolve( isFinite( d ) && d > 0 ? d : null );
            }
            probe.addEventListener( "loadedmetadata", function () { finish( probe.duration ); } );
            probe.addEventListener( "error", function () { finish( null ); } );
            setTimeout( function () { finish( null ); }, PROBE_MS );
            probe.preload = "metadata";
            probe.muted   = true;
            probe.src     = url;
        } );
    }

    //------------------------------------------------------------------------//
    // MARKUP BITS shared by the library views

    var ICONS = {
        folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5C3 6.12 4.12 5 5.5 5h4l2 2h7C19.88 7 21 8.12 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>',
        x:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>'
    };

    // The "filtered by X" strip with its clear button (#clearScopeBtn).
    function scopeBarHtml( label, clearTitle )
    {
        var t = esc( clearTitle || NayiveUI.t( 'media.clearFilter' ) );
        return '<div class="scope-bar"><span class="scope-chip">' + esc( label ) +
            '<button id="clearScopeBtn" title="' + t + '" aria-label="' + t + '">' + ICONS.x + '</button></span></div>';
    }

    //------------------------------------------------------------------------//
    // PLAYER BITS

    // The transport button (#playBtn / #playIcon): pause glyph while playing.
    function setPlayIcon( playing )
    {
        var btn = document.getElementById( "playBtn" ), ico = document.getElementById( "playIcon" );
        if( ! btn || ! ico ) return;
        btn.title = playing ? NayiveUI.t( 'media.pause' ) : NayiveUI.t( 'media.play' );
        btn.setAttribute( "aria-label", btn.title );
        ico.outerHTML = playing
            ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" id="playIcon"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" id="playIcon"><path d="M8 5v14l11-7-11-7Z"/></svg>';
    }

    // Lock-screen / notification controls, when the browser has them. Purely
    // additive. `meta` = { title, artist, album, artwork }; `handlers` = an
    // object of MediaSession action name -> function; each is set on its own
    // so one unsupported action never blocks the rest.
    function mediaSession( meta, handlers )
    {
        if( ! ( "mediaSession" in navigator ) ) return;
        try { navigator.mediaSession.metadata = new MediaMetadata( meta ); } catch( e ) { return; }
        Object.keys( handlers || {} ).forEach( function ( action )
        {
            try { navigator.mediaSession.setActionHandler( action, handlers[ action ] ); } catch( e ) {}
        } );
    }

    // The lock screen's progress bar: where `el` (the <audio> / <video>) is now.
    // Nothing until the length is known.
    function positionState( el )
    {
        if( ! ( "mediaSession" in navigator ) || ! navigator.mediaSession.setPositionState ) return;
        if( ! isFinite( el.duration ) || el.duration <= 0 ) return;
        try
        {
            navigator.mediaSession.setPositionState( {
                duration: el.duration,
                position: Math.min( el.currentTime, el.duration ),
                playbackRate: el.playbackRate || 1
            } );
        }
        catch( e ) {}
    }

    //------------------------------------------------------------------------//

    window.NayiveMedia =
    {
        esc: esc, cssEsc: cssEsc, cssUrl: cssUrl,
        extOf: extOf, baseName: baseName, dirOf: dirOf, stripExt: stripExt, norm: norm,
        PALETTE: PALETTE, colorFor: colorFor,
        fmtClock: fmtClock, fmtRuntime: fmtRuntime, fmtSize: fmtSize,
        sleep: sleep, pool: pool,
        flattenFiles: flattenFiles, loadFolderTree: loadFolderTree,
        dirLabel: dirLabel, setCrumb: setCrumb, wireFolderInfo: wireFolderInfo, wireCrumbPicker: wireCrumbPicker, wireSearchToggle: wireSearchToggle, searchCount: searchCount,
        scanCache: scanCache, probeDuration: probeDuration,
        readComments: readComments, updateComments: updateComments, NOTES_ASIDE: ASIDE,
        parkNotes:   function ( map, path ) { return park( map, path, null ); },
        unparkNotes: function ( map, path ) { return unpark( map, path, true ); },
        remapPaths: remapPaths, copyPaths: copyPaths, purgePaths: purgePaths,
        binInBatches: binInBatches, restoreInBatches: restoreInBatches, postPaths: postPaths,
        settleNoteMoves: settleNoteMoves, noteMoveWaits: noteMoveWaits,
        ICONS: ICONS, scopeBarHtml: scopeBarHtml,
        setPlayIcon: setPlayIcon, mediaSession: mediaSession, positionState: positionState
    };
} )();
