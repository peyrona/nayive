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

    function esc( s )
    {
        return String( s == null ? "" : s ).replace( /[&<>"']/g, function ( c )
        { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ c ]; } );
    }
    function cssEsc( s ) { return String( s ).replace( /["\\]/g, "\\$&" ); }
    function cssUrl( u ) { return "url(\"" + cssEsc( u ) + "\")"; }

    function extOf( name )
    {
        var m = /\.([a-z0-9]+)$/i.exec( String( name ) );
        return m ? m[ 1 ].toLowerCase() : "";
    }
    function baseName( path ) { return String( path ).slice( String( path ).lastIndexOf( "/" ) + 1 ); }
    function dirOf( path )    { var i = String( path ).lastIndexOf( "/" ); return i < 0 ? "" : String( path ).slice( 0, i ); }
    function stripExt( name ) { return String( name ).replace( /\.[a-z0-9]+$/i, "" ); }
    function norm( s )        { return String( s || "" ).toLowerCase().replace( /[^a-z0-9]+/g, "" ); }

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
    function fmtSize( b )
    {
        if( ! b ) return "";
        if( b < 1024 )    return b + " B";
        if( b < 1048576 ) return Math.round( b / 1024 ) + " KB";
        return ( b / 1048576 ).toFixed( 1 ) + " MB";
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
    // page), or no connection. Resolves with the listing, or null after
    // having reported.
    async function loadFolderTree( dir, onMsg, recursive )
    {
        try { return await ( recursive ? GumApi.listDirRecursive( dir ) : GumApi.listDir( dir ) ); }
        catch( err )
        {
            var msg = String( err && err.message );
            // 403 = a share that was taken back (or never ours). NOT a sign-in
            // problem, so it must never bounce the page to the login page.
            if( msg.indexOf( "HTTP 404" ) !== -1 ) onMsg( NayiveUI.t( 'media.folderGone' ) );
            else if( msg.indexOf( "HTTP 403" ) !== -1 ) onMsg( NayiveUI.t( 'media.noAccess' ) );
            else if( navigator.onLine ) GumApi.loginRedirect();
            else onMsg( NayiveUI.t( 'media.offlineRetry' ) );
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

    // The header crumb: folder icon + the label.
    function setCrumb( label )
    {
        var el = document.getElementById( "crumb" );
        if( el ) el.innerHTML = NayiveUI.icon( "folder" ) + "<span>" + esc( label ) + "</span>";
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

    // Phone only: the magnifier (#searchToggle) folds the search field
    // (#searchInput) open / closed; closing it clears the search.
    function wireSearchToggle()
    {
        var btn = document.getElementById( "searchToggle" ), box = document.getElementById( "searchInput" );
        if( ! btn || ! box ) return;
        btn.addEventListener( "click", function ()
        {
            box.classList.toggle( "show" );
            if( box.classList.contains( "show" ) ) box.focus();
            else if( box.value ) { box.value = ""; box.dispatchEvent( new Event( "input" ) ); }
        } );
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
    //   cache.set( item, { title: ... } );     // record + schedule a save
    //   cache.prune( alivePaths, inScope );    // drop dead entries; true if any
    //   cache.save() / cache.saveNow()         // debounced / immediate write
    //   cache.map                              // the raw { path: entry } object
    function scanCache( path )
    {
        var timer = null;
        var self = {
            map: {},
            loaded: false,
            load: async function ()
            {
                try { self.map = ( await GumApi.readJson( path ) ) || {}; self.loaded = true; }
                catch( e ) { self.map = {}; self.loaded = false; }
                return self.map;
            },
            hit: function ( item )
            {
                var e = self.map[ item.path ];
                return e && e.size === item.size && e.mtime === item.mtime ? e : null;
            },
            set: function ( item, fields )
            {
                self.map[ item.path ] = Object.assign( self.map[ item.path ] || {},
                                                       { size: item.size, mtime: item.mtime }, fields );
                self.save();
            },
            // `alive`: a Set (or array) of the paths still present. `inScope(key)`
            // (optional) limits the sweep - Photos lists one folder at a time,
            // so it may only judge that folder's entries.
            prune: function ( alive, inScope )
            {
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
                if( timer ) return;
                timer = setTimeout( function () { timer = null; self.saveNow(); }, 2500 );
            },
            saveNow: function ()
            {
                if( timer ) { clearTimeout( timer ); timer = null; }
                return GumApi.writeJson( path, self.map ).catch( function () {} );
            }
        };
        return self;
    }

    //------------------------------------------------------------------------//
    // PATH-KEYED SIDECARS
    //
    // Two of our files are keyed by the file's own path: the per-photo comments
    // (data/photos/comments.json, written by Photos and by Drive's image editor)
    // and the scan caches above (data/<app>/scan-cache.json). Whoever moves,
    // renames, copies or trashes a file has to keep them in step, or a note
    // ends up on the wrong photo and a shuffled folder is re-scanned from
    // scratch. Drive is the only app that moves files, so it is the only caller
    // today - but the layout of these files is ours, not Drive's, which is why
    // the code lives here (moved out of drive/index.html 2026-09-07).
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
    var SCAN_CACHES   = [ PHOTOS_SCAN, "data/music/scan-cache.json" ];

    var commentsMap = null;              // the whole map, loaded once per session

    // The comment map, cached for the session. A file that is not there yet, or
    // that we may not read (a shared album), is an empty map; ANY other error is
    // thrown, because a network hiccup must not masquerade as "no comments" -
    // the next write would wipe every one of them.
    async function readComments()
    {
        if( ! commentsMap )
        {
            try { commentsMap = JSON.parse( await GumApi.readFile( COMMENTS_PATH ) ) || {}; }
            catch( e )
            {
                if( ! /HTTP 40[34]/.test( String( e && e.message ) ) ) throw e;
                commentsMap = {};
            }
        }
        return commentsMap;
    }

    function writeComments( map ) { return GumApi.writeJson( COMMENTS_PATH, map ); }

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
    // true. A missing or unreadable file is simply left alone.
    async function editSidecar( path, mutate )
    {
        var map;
        try { map = ( await GumApi.readJson( path ) ) || {}; }
        catch( e ) { return; }
        if( typeof map !== "object" || Array.isArray( map ) ) return;
        if( mutate( map ) ) try { await GumApi.writeJson( path, map ); } catch( e ) {}
    }

    async function remapComments( pairs, keep )
    {
        var map;
        try { map = await readComments(); }
        catch( e ) { return; }
        if( rekey( map, pairs, keep ) )
            try { await writeComments( map ); } catch( e ) {}
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
        for( var j = 0; j < thumbs.length; j += 100 )      // keep each URL a sane length
            try { await GumApi.purgePaths( thumbs.slice( j, j + 100 ) ); } catch( e ) {}
    }

    //------------------------------------------------------------------------//
    // DURATION PROBE - a throwaway <audio> / <video> with preload=metadata.
    // Cheap: the server supports Range, so the browser only pulls the header.
    // Resolves with the length in seconds, or null.
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
                probe.removeAttribute( "src" );
                if( kind === "video" ) probe.load();
                resolve( isFinite( d ) && d > 0 ? d : null );
            }
            probe.addEventListener( "loadedmetadata", function () { finish( probe.duration ); } );
            probe.addEventListener( "error", function () { finish( null ); } );
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

    function emptyHint( text, iconSvg )
    {
        return '<div class="empty-hint">' + ( iconSvg || "" ) + '<p>' + esc( text ) + '</p></div>';
    }

    // The "filtered by X" strip with its clear button (#clearScopeBtn).
    function scopeBarHtml( label, clearTitle )
    {
        var t = esc( clearTitle || NayiveUI.t( 'media.clearFilter' ) );
        return '<div class="scope-bar"><span class="scope-chip">' + esc( label ) +
            '<button id="clearScopeBtn" title="' + t + '" aria-label="' + t + '">' + ICONS.x + '</button></span></div>';
    }

    // The folders-only tree of a listDirRecursive() result as indented rows
    // (button.folder-row[data-folder]); `selected` is the active folder path.
    function folderTreeHtml( node, selected, depth )
    {
        depth = depth || 0;
        if( ! node || ! node.nodes ) return "";
        var html = "";
        node.nodes.forEach( function ( n )
        {
            if( n.nodes === undefined || n.nodes === null ) return;   // a file, not a folder
            html += '<button class="folder-row' + ( selected === n.path ? ' is-active' : '' ) +
                '" style="padding-left:' + ( 10 + depth * 22 ) + 'px" data-folder="' + esc( n.path ) + '">' +
                ICONS.folder + esc( baseName( n.path ) ) + '</button>';
            html += folderTreeHtml( n, selected, depth + 1 );
        } );
        return html;
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

    //------------------------------------------------------------------------//

    window.NayiveMedia =
    {
        esc: esc, cssEsc: cssEsc, cssUrl: cssUrl,
        extOf: extOf, baseName: baseName, dirOf: dirOf, stripExt: stripExt, norm: norm,
        PALETTE: PALETTE, colorFor: colorFor,
        fmtClock: fmtClock, fmtRuntime: fmtRuntime, fmtSize: fmtSize,
        sleep: sleep, pool: pool,
        flattenFiles: flattenFiles, loadFolderTree: loadFolderTree,
        dirLabel: dirLabel, setCrumb: setCrumb, wireCrumbPicker: wireCrumbPicker, wireSearchToggle: wireSearchToggle,
        scanCache: scanCache, probeDuration: probeDuration,
        readComments: readComments, writeComments: writeComments,
        remapPaths: remapPaths, copyPaths: copyPaths, purgePaths: purgePaths,
        ICONS: ICONS, emptyHint: emptyHint, scopeBarHtml: scopeBarHtml, folderTreeHtml: folderTreeHtml,
        setPlayIcon: setPlayIcon, mediaSession: mediaSession
    };
} )();
