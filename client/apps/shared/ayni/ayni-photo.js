/*
 * photo.js - shrink a photo in the browser before it is uploaded.
 *
 * The admin can give a user a "max photo size" (the longest side, in pixels;
 * see the admin panel). When that limit is set, every photo this user uploads
 * is re-drawn on a canvas to fit inside it - the aspect ratio is kept, so
 * nothing is squashed - and saved as JPEG, which is by far the smallest format
 * for a photograph. A 12 MP phone photo of 5 MB becomes ~400 KB at 2048 px.
 *
 * The whole job happens here, in the browser: the server only stores the bytes
 * it is given. Three places use it - the Photos app, the Drive app and the
 * share target (photos shared into the app from another Android app):
 *
 *     <script src="../ayni-photo.js"></script>
 *
 * What it does NOT touch:
 *   - a user with no limit set (the file is uploaded exactly as it is);
 *   - a JPEG that already fits (re-encoding it would only lose quality);
 *   - anything that is not a photo: GIFs (a canvas keeps one frame only,
 *     which would silently kill an animation), SVGs (drawings) and .ico;
 *   - a file the browser cannot decode (some Androids and HEIC): the original
 *     is uploaded instead of failing.
 *
 * Exif: a shrunk JPEG made by a canvas has NO Exif block, so the date and the
 * GPS position - which the Photos app needs for its Map view and its timeline -
 * would be lost. copyExif() splices the original Exif back into the new file.
 * That is only possible when the source is itself a JPEG; a PNG or a HEIC has
 * no Exif to copy, and those photos arrive without a position.
 *
 * review() is the step before a photo goes (Chat, Drive, Write, eMail,
 * Translator...): see it, Crop, Rotate, Read text - it writes nothing.
 *
 * It also holds what the image editors (Image, Chat) share: loading and
 * building the editor (loadEditor, newEditor - the editor itself is
 * ayni-image-editor.js), dataUrlBytes, keepExif() and the thumbnail an
 * edit leaves behind (thumbOf, dropThumb).
 */
( function ()
{
    "use strict";

    var QUALITY = 0.85;          // JPEG quality of the shrunk copy (0..1)

    // The user's limit, asked once and remembered:
    //   undefined = not asked yet | null = no limit | number = pixels
    var LIMIT = undefined;

    //------------------------------------------------------------------------//
    //  The user's limit
    //------------------------------------------------------------------------//

    /* The signed-in user's max photo size in pixels, or null when there is no
     * limit. Asked once per page load (GET /api/whoami). A failed request is
     * NOT cached: it answers "no limit" for now and the next call asks again,
     * so a hiccup never silently disables shrinking for the whole session. */
    function limit()
    {
        if ( LIMIT !== undefined ) return Promise.resolve( LIMIT );
        return AyniPhotoBackend.probeAccess().then( function ( me )
        {
            var px = me && me.photo_max;
            LIMIT = ( typeof px === "number" && px > 0 ) ? px : null;
            return LIMIT;
        } ).catch( function () { return null; } );
    }

    //------------------------------------------------------------------------//
    //  What is a photo
    //------------------------------------------------------------------------//

    function extOf( name ) { return Ayni.extOf( name ); }

    var IMG_EXT = [ "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff" ];

    function isImage( file )
    {
        var type = String( ( file && file.type ) || "" ).toLowerCase();
        var e    = extOf( file && file.name );
        // Not photos, even though the browser files them under image/*: a GIF
        // may be animated (a canvas keeps one frame), an SVG is a drawing that
        // must stay a drawing, an .ico is a bundle of tiny icons.
        if ( type === "image/gif" || type === "image/svg+xml" || type === "image/x-icon" ||
             e === "gif" || e === "svg" || e === "ico" ) return false;
        if ( type.indexOf( "image/" ) === 0 ) return true;
        return IMG_EXT.indexOf( e ) !== -1;
    }

    // PNG, WebP, AVIF: shown by every browser, and may be see-through.
    function keepsAlpha( file )
    {
        var type = String( ( file && file.type ) || "" ).toLowerCase();
        if ( type === "image/png" || type === "image/webp" || type === "image/avif" ) return true;
        var e = extOf( file && file.name );
        return ! type && ( e === "png" || e === "webp" || e === "avif" );
    }

    function isJpeg( file )
    {
        var type = String( ( file && file.type ) || "" ).toLowerCase();
        if ( type === "image/jpeg" || type === "image/jpg" ) return true;
        var e = extOf( file && file.name );
        return ! type && ( e === "jpg" || e === "jpeg" );
    }

    // The formats the photo editor (apps/image) can load AND re-encode
    // (canvas.toDataURL): Drive opens these in it, and Image refuses the rest.
    var EDIT_EXT = [ "png", "jpg", "jpeg", "webp" ];

    /* "vacaciones.HEIC" -> "vacaciones.jpg" (the bytes really are JPEG now, so
     * the name has to say so or every viewer is misled). */
    function jpegName( name )
    {
        name = String( name || "foto" );
        return ( /\.[a-z0-9]+$/i.test( name ) ? name.replace( /\.[a-z0-9]+$/i, "" ) : name ) + ".jpg";
    }

    //------------------------------------------------------------------------//
    //  Decode + re-draw
    //------------------------------------------------------------------------//

    function decode( source )
    {
        // imageOrientation: "from-image" applies the Exif rotation while
        // decoding, so a portrait phone photo is not drawn on its side. Some
        // older browsers reject the option - retry without it.
        return createImageBitmap( source, { imageOrientation: "from-image" } )
            .catch( function () { return createImageBitmap( source ); } );
    }

    function closeBitmap( bmp )
    {
        // ImageBitmap holds decoded pixels (tens of MB for a phone photo);
        // close() frees them at once instead of waiting for the collector.
        if ( bmp && bmp.close ) { try { bmp.close(); } catch ( e ) {} }
    }

    /* Draw `source` (an ImageBitmap, an <img>, a File or a Blob) into a JPEG
     * that fits inside opts.maxW x opts.maxH, keeping the aspect ratio.
     * Returns a Blob. Never enlarges: the scale is capped at 1.
     *
     *     shrinkToJpeg( file, { maxW: 2048, maxH: 2048 } )
     *     shrinkToJpeg( img,  { maxW: 400 } )              <- thumbnails
     */
    async function shrinkToJpeg( source, opts )
    {
        opts = opts || {};
        var maxW  = opts.maxW || Infinity;
        var maxH  = opts.maxH || Infinity;
        var q     = ( opts.quality == null ) ? QUALITY : opts.quality;
        var owned = false;                       // did WE create the bitmap?
        var bmp   = null, w, h;

        if ( typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap )
        {
            bmp = source; w = bmp.width; h = bmp.height;
        }
        else if ( window.createImageBitmap )
        {
            bmp = await decode( source );
            owned = true;
            w = bmp.width; h = bmp.height;
        }
        else
        {
            // No createImageBitmap (old Safari): only an already-loaded <img>
            // can be drawn, everything else has nothing to measure.
            if ( ! ( source instanceof HTMLImageElement ) ) throw new Error( "no createImageBitmap" );
            w = source.naturalWidth; h = source.naturalHeight;
        }

        if ( ! w || ! h ) { if ( owned ) closeBitmap( bmp ); throw new Error( "empty image" ); }

        var scale = Math.min( 1, maxW / w, maxH / h );
        var c = document.createElement( "canvas" );
        c.width  = Math.max( 1, Math.round( w * scale ) );
        c.height = Math.max( 1, Math.round( h * scale ) );
        var x = c.getContext( "2d" );
        // JPEG has no transparency: whatever was see-through in a PNG would
        // come out BLACK. Paint white first, the way every viewer shows it.
        x.fillStyle = "#fff";
        x.fillRect( 0, 0, c.width, c.height );
        x.imageSmoothingQuality = "high";
        x.drawImage( bmp || source, 0, 0, c.width, c.height );
        if ( owned ) closeBitmap( bmp );

        return new Promise( function ( res, rej )
        {
            c.toBlob( function ( b ) { b ? res( b ) : rej( new Error( "toBlob failed" ) ); },
                      "image/jpeg", q );
        } );
    }

    //------------------------------------------------------------------------//
    //  Exif carried over to the shrunk copy
    //------------------------------------------------------------------------//

    /* Where a JPEG's Exif block is. A JPEG is a chain of segments: 0xFFD8
     * (start of image), then FF <marker> <2-byte length> <payload>..., until
     * FFDA starts the compressed pixels. Exif is the APP1 (0xFFE1) whose
     * payload begins with "Exif\0\0". Answers { tiff, end } (its TIFF header;
     * where the block ends, maybe past `u8` - Photos then reads more),
     * { past: true } when the blocks before it run past `u8`, or null (not a
     * JPEG, or the picture data starts first). Photos reads dates and places
     * with it too. */
    function exifAt( u8 )
    {
        if ( ! u8 || u8.length < 4 || u8[ 0 ] !== 0xFF || u8[ 1 ] !== 0xD8 ) return null;
        var i = 2;
        while ( i + 4 <= u8.length )
        {
            if ( u8[ i ] !== 0xFF ) return null;
            var marker = u8[ i + 1 ];
            if ( marker === 0xD9 || marker === 0xDA ) return null;   // end / pixels
            var len = ( u8[ i + 2 ] << 8 ) | u8[ i + 3 ];
            if ( len < 2 ) return null;
            if ( marker === 0xE1 && i + 10 <= u8.length &&
                 u8[ i + 4 ] === 0x45 && u8[ i + 5 ] === 0x78 &&    // "Ex"
                 u8[ i + 6 ] === 0x69 && u8[ i + 7 ] === 0x66 &&    // "if"
                 u8[ i + 8 ] === 0x00 )
                return { tiff: i + 10, end: i + 2 + len };
            i += 2 + len;
        }
        return { past: true };
    }

    /* The Exif APP1 segment of a JPEG, as a Uint8Array copy (marker bytes and
     * all), or null - also when a block up to its end runs past `u8`. */
    function exifSegment( u8 )
    {
        var at = exifAt( u8 );
        if ( ! at || at.past || at.end > u8.length ) return null;
        return u8.slice( at.tiff - 10, at.end );                    // py-ish: a copy, not a view
    }

    /* Fix the copied Exif so it describes the NEW image:
     *   - Orientation (tag 0x0112) = 1. The canvas already applied the
     *     rotation, so leaving the old value would rotate it a second time.
     *   - PixelXDimension / PixelYDimension (0xA002 / 0xA003) = the new size.
     *   - the pointer to IFD1 = 0, dropping the embedded thumbnail, which
     *     still shows the old orientation and is no longer needed.
     * Everything else - date, camera, GPS - is left exactly as it was. */
    function fixExif( seg, newW, newH )
    {
        var tiff = 10;                                   // FFE1 len len "Exif\0\0"
        if ( seg.length < tiff + 8 ) return;
        var le = seg[ tiff ] === 0x49;                   // 'II' little-endian / 'MM' big
        var dv = new DataView( seg.buffer, seg.byteOffset, seg.byteLength );

        function u16( o ) { return dv.getUint16( o, le ); }
        function u32( o ) { return dv.getUint32( o, le ); }

        if ( u16( tiff + 2 ) !== 0x002A ) return;        // not a TIFF header after all

        function walk( ifd, onEntry, dropNext )
        {
            if ( ifd <= 0 || ifd + 2 > seg.length ) return;
            var n = u16( ifd );
            for ( var k = 0; k < n; k++ )
            {
                var e = ifd + 2 + k * 12;
                if ( e + 12 > seg.length ) return;
                onEntry( u16( e ), u16( e + 2 ), e );    // tag, type, entry offset
            }
            if ( ! dropNext ) return;
            // 4 bytes after the last entry of IFD0: the offset of IFD1, which
            // holds the embedded thumbnail. Zero = "there is none".
            var nextAt = ifd + 2 + n * 12;
            if ( nextAt + 4 <= seg.length ) dv.setUint32( nextAt, 0, le );
        }

        // The value of a tag lives inside the entry when it fits in 4 bytes
        // (which SHORT and LONG always do), otherwise at an offset. Only
        // in-entry values are written here - the three tags below are all
        // single numbers.
        function setNumber( type, entry, value )
        {
            if ( type === 3 ) dv.setUint16( entry + 8, value, le );        // SHORT
            else if ( type === 4 ) dv.setUint32( entry + 8, value, le );   // LONG
        }

        var exifIfd = 0;
        walk( tiff + u32( tiff + 4 ), function ( tag, type, e )
        {
            if ( tag === 0x0112 ) setNumber( type, e, 1 );                 // Orientation
            else if ( tag === 0x8769 ) exifIfd = tiff + u32( e + 8 );      // -> the Exif sub-IFD
        }, true );

        if ( exifIfd > 0 && exifIfd + 2 < seg.length )
        {
            walk( exifIfd, function ( tag, type, e )
            {
                if ( tag === 0xA002 ) setNumber( type, e, newW );
                else if ( tag === 0xA003 ) setNumber( type, e, newH );
            } );
        }
    }

    /* A copy of `jpegBlob` carrying the Exif of `srcFile`. Best effort: any
     * problem returns the blob untouched (a photo with no date beats no photo). */
    async function copyExif( srcFile, jpegBlob, newW, newH )
    {
        try
        {
            var seg = exifSegment( new Uint8Array( await srcFile.arrayBuffer() ) );
            if ( ! seg ) return jpegBlob;
            fixExif( seg, newW, newH );

            var made = new Uint8Array( await jpegBlob.arrayBuffer() );
            if ( made[ 0 ] !== 0xFF || made[ 1 ] !== 0xD8 ) return jpegBlob;

            // FFD8 + the Exif segment + everything the canvas produced after
            // its own FFD8. Exif must be the first segment of the file.
            var out = new Uint8Array( 2 + seg.length + made.length - 2 );
            out.set( made.subarray( 0, 2 ), 0 );
            out.set( seg, 2 );
            out.set( made.subarray( 2 ), 2 + seg.length );
            return new Blob( [ out ], { type: "image/jpeg" } );
        }
        catch ( e ) { return jpegBlob; }
    }

    /* The image editors (Drive, Photos, Chat) save what their canvas holds,
     * and a canvas export has no Exif either: an edited photo would lose its
     * date and GPS, so Photos would move it to today and off the map.
     * `srcPath` is the file the editor opened - read it BEFORE it is
     * overwritten; `bytes` is the export. When both are JPEG the original's
     * Exif goes into the export. Best effort: any problem hands `bytes` back
     * untouched. */
    async function keepExif( srcPath, bytes, newW, newH )
    {
        if ( ! /\.jpe?g$/i.test( srcPath ) ) return bytes;
        try
        {
            var src = new Blob( [ await AyniPhotoBackend.readFileBytes( srcPath ) ] );
            var out = await copyExif( src, new Blob( [ bytes ], { type: "image/jpeg" } ), newW, newH );
            return new Uint8Array( await out.arrayBuffer() );
        }
        catch ( e ) { return bytes; }
    }

    /* The editor (ayni-image-editor.js, on Fabric.js), loaded once, on the
     * first edit - found from this file's own address, so every app asks for
     * the same URLs. Fabric must be in before the editor. A load that failed
     * is tried again next time. */
    var HERE = document.currentScript ? new URL( "./", document.currentScript.src ).href : "../shared/";
    var editorLib = null;

    function loadEditor()
    {
        if ( editorLib ) return editorLib;

        function add( src )
        {
            return new Promise( function ( ok, fail )
            {
                var el = document.createElement( "script" );
                el.src = src;
                el.onload  = ok;
                el.onerror = function () { fail( new Error( "load " + src ) ); };
                document.head.appendChild( el );
            } );
        }

        editorLib = add( ( window.AyniFabricUrl || HERE + "lib/fabric.min.js" ) )
            .then( function () { return add( HERE + "ayni-image-editor.js" ); } )
            .catch( function ( err ) { editorLib = null; throw err; } );
        return editorLib;
    }

    /* A new editor in `host` on the picture at `url`, called `name`: the same
     * tools in every app, in the user's language. Call it once loadEditor()
     * is done. opts.tools / opts.head: where its tools / its undo / redo go
     * (the app's header); opts.btnClass: their class there. */
    function newEditor( host, url, name, opts )
    {
        return AyniImageEditor.create( host, url, name, opts );
    }

    /* An editor's toDataURL() as bytes to write. "data:," is a canvas with
     * no picture - what a device hands back for a canvas bigger than it
     * allows (an iPhone stops near 16.7 MP): saving it would leave an empty
     * file where the photo was, so it throws instead. */
    function dataUrlBytes( u )
    {
        if ( ! /^data:image\//.test( u ) ) throw new Error( "empty render" );
        var bin = atob( u.slice( u.indexOf( "," ) + 1 ) );
        var out = new Uint8Array( bin.length );
        for ( var i = 0; i < bin.length; i++ ) out[ i ] = bin.charCodeAt( i );
        return out;
    }

    /* Photos keeps a thumbnail of each picture, named after the file's size
     * and mtime (data/photos/thumbs/<size>_<mtime>.jpg). When an editor
     * rewrites a file, nothing asks for the old one again. thumbOf() names
     * it - call it BEFORE the write, while the listing still shows the old
     * file - and dropThumb() deletes it after. Best effort both: a leftover
     * only costs disk, and Photos' daily sweep would take it in the end. */
    // The thumbnail's name: Photos and Drive both make and read it.
    function thumbPath( size, mtime ) { return "data/photos/thumbs/" + size + "_" + mtime + ".jpg"; }

    async function thumbOf( path )
    {
        try
        {
            var dir = path.slice( 0, path.lastIndexOf( "/" ) );
            var n = ( ( await AyniPhotoBackend.listDir( dir ) ).nodes || [] ).filter( function ( x ) { return x.path === path; } )[ 0 ];
            return n && n.size && n.mtime ? thumbPath( n.size, n.mtime ) : null;
        }
        catch ( e ) { return null; }
    }

    function dropThumb( thumb )
    {
        if ( ! thumb ) return Promise.resolve();
        return AyniPhotoBackend.purgePaths( [ thumb ] ).catch( function () {} );
    }

    //------------------------------------------------------------------------//
    //  The one call the apps make
    //------------------------------------------------------------------------//

    /* Get `file` ready to be uploaded. Resolves to
     *
     *     { blob, name, changed }
     *
     * where `blob` is what to send and `name` what to call it. `changed` is
     * false when the original is being sent untouched, which is the answer for
     * a user with no limit, a non-photo, a JPEG that already fits, or anything
     * the browser could not decode.
     *
     * `max` is optional: without it the user's own limit is used. */
    async function prepare( file, max )
    {
        var out = { blob: file, name: ( file && file.name ) || "foto.jpg", changed: false };

        if ( max === undefined || max === null ) max = await limit();
        if ( ! max || ! file || ! isImage( file ) ) return out;

        var bmp;
        try { bmp = await decode( file ); }
        catch ( e ) { return out; }                    // undecodable (HEIC on some Androids)

        var w = bmp.width, h = bmp.height;
        if ( ! w || ! h ) { closeBitmap( bmp ); return out; }

        // Already small enough AND already a JPEG: re-encoding would only
        // throw quality away for nothing. A PNG, WebP or AVIF that fits stays
        // as it is too: every browser shows it, and a JPEG would lose its
        // transparency and its name. (A fitting BMP, TIFF or HEIC still
        // becomes a JPEG: less disk, and one every browser can show.)
        if ( w <= max && h <= max && ( isJpeg( file ) || keepsAlpha( file ) ) ) { closeBitmap( bmp ); return out; }

        var blob;
        try { blob = await shrinkToJpeg( bmp, { maxW: max, maxH: max } ); }
        catch ( e ) { closeBitmap( bmp ); return out; }

        var scale = Math.min( 1, max / w, max / h );
        var newW  = Math.max( 1, Math.round( w * scale ) );
        var newH  = Math.max( 1, Math.round( h * scale ) );
        closeBitmap( bmp );

        if ( isJpeg( file ) ) blob = await copyExif( file, blob, newW, newH );

        // A small PNG screenshot can come out BIGGER as a JPEG. When it does
        // and the original already fitted, keep the original: the point of all
        // this is to use less disk.
        if ( file.size && blob.size >= file.size && w <= max && h <= max ) return out;

        out.blob    = blob;
        out.name    = jpegName( out.name );
        out.changed = true;
        return out;
    }

    /* A face: a person's or a contact's picture (his rule, 2026-09-27): a PNG
     * or a JPEG of at most 300 x 300 px. One that already is goes as it is;
     * anything else (bigger, WebP, GIF...) is drawn into a JPEG that fits.
     * opts.jpeg: a JPEG always (the chat server takes nothing else).
     * Returns a Blob whose type is "image/png" or "image/jpeg". */
    var FACE = 300;

    async function face( blob, opts )
    {
        opts = opts || {};
        var head = new Uint8Array( await blob.slice( 0, 8 ).arrayBuffer() );
        var png  = head[ 0 ] === 0x89 && head[ 1 ] === 0x50 && head[ 2 ] === 0x4E && head[ 3 ] === 0x47;
        var jpg  = head[ 0 ] === 0xFF && head[ 1 ] === 0xD8;
        if ( ( jpg || ( png && ! opts.jpeg ) ) && window.createImageBitmap )
        {
            var bmp = null;
            try { bmp = await decode( blob ); } catch ( e ) {}
            var fits = bmp && bmp.width <= FACE && bmp.height <= FACE;
            closeBitmap( bmp );
            if ( fits ) return new Blob( [ blob ], { type: png ? "image/png" : "image/jpeg" } );
        }
        return shrinkToJpeg( blob, { maxW: FACE, maxH: FACE, quality: 0.85 } );
    }

    //------------------------------------------------------------------------//

    // ---- THE CAMERA ON A COMPUTER ----
    // A phone's file picker opens its own camera (<input capture="environment">);
    // a computer's only shows files. So a computer WITH a camera gets one here:
    // a live view and a shutter.

    var hasCamera = false, cameraWatchers = [];

    function lookForCamera()
    {
        if( ! navigator.mediaDevices || ! navigator.mediaDevices.enumerateDevices ) return;
        navigator.mediaDevices.enumerateDevices().then( function ( list )
        {
            hasCamera = list.some( function ( d ) { return d.kind === "videoinput"; } );
            cameraWatchers.forEach( function ( fn ) { fn(); } );
        }, function () {} );
    }
    lookForCamera();
    if( navigator.mediaDevices && navigator.mediaDevices.addEventListener )
        navigator.mediaDevices.addEventListener( "devicechange", lookForCamera );

    // A computer: its main pointer is a mouse (a phone's or a tablet's is a finger).
    function computer() { return ! ( window.matchMedia && matchMedia( "(pointer: coarse)" ).matches ); }

    // True: use camera() below. False: a phone's picker, or no camera at all.
    function ownCamera()
    {
        return computer() && hasCamera && !! ( navigator.mediaDevices && navigator.mediaDevices.getUserMedia );
    }

    // A photo can be taken here, one way or the other.
    function canTakePhoto() { return ! computer() || ownCamera(); }

    // fn() now, and again whenever a camera comes or goes.
    function cameraWatch( fn ) { cameraWatchers.push( fn ); fn(); }

    function camButton( cls, tip, icon )
    {
        var b = document.createElement( "button" );
        b.type = "button";
        b.className = cls;
        b.setAttribute( "data-tip", tip );
        b.setAttribute( "aria-label", tip );
        b.innerHTML = Ayni.icon( icon );
        return b;
    }

    // The live view, full screen. done( File ) on the shutter, done( null ) when
    // closed. Returns a function that closes it WITHOUT calling done (for a
    // page's own Back).
    function camera( done )
    {
        var flip    = camButton( "btn on-media", Ayni.t( "ayni.camera.switch" ), "refresh" );
        var closeB  = camButton( "btn on-media", Ayni.t( "ayni.close" ), "x" );
        var shutter = camButton( "btn lg solid-ok", Ayni.t( "ayni.camera.shoot" ), "camera" );
        flip.hidden = true;

        var layer = document.createElement( "div" );
        layer.className = "editor-backdrop open camera-view";
        layer.setAttribute( "role", "dialog" );
        layer.setAttribute( "aria-modal", "true" );
        layer.innerHTML = '<div class="editor-bar"><div class="editor-title"></div><div class="editor-actions"></div></div>' +
                          '<div class="editor-canvas"><video autoplay playsinline muted></video></div><div class="cam-bar"></div>';
        layer.querySelector( ".editor-title" ).textContent = Ayni.t( "ayni.camera.title" );
        layer.querySelector( ".editor-actions" ).append( flip, closeB );
        layer.querySelector( ".cam-bar" ).appendChild( shutter );
        var video = layer.querySelector( "video" );
        video.muted = true;
        var back = document.activeElement;   // the focus goes back there on close
        document.body.appendChild( layer );

        var stream = null, cams = [], at = 0;
        var starts = 0;          // bumped by every start(): a switch clicked twice must not leave the first camera on

        function stop() { if( stream ) stream.getTracks().forEach( function ( t ) { t.stop(); } ); stream = null; }
        function cancel()
        {
            var had = layer.contains( document.activeElement );
            layer.remove(); document.removeEventListener( "keydown", key, true ); stop();
            if( had && back && back.isConnected && back.focus ) back.focus();
        }
        function finish( file ) { cancel(); done( file ); }

        // The page behind gets no keys while this is up: none reaches its listeners, and none does there what it
        // would do (Space or Enter on its focused button opened a second camera). The focus is on the layer, and Tab
        // goes round its buttons.
        function key( e )
        {
            e.stopPropagation();
            if( e.key === "Escape" ) { e.preventDefault(); finish( null ); return; }
            if( e.key === "Tab" )
            {
                var bs = [].filter.call( layer.querySelectorAll( "button" ), function ( b ) { return ! b.hidden; } );
                var i = bs.indexOf( document.activeElement ), n = bs.length;
                e.preventDefault();
                if( n ) bs[ i < 0 ? ( e.shiftKey ? n - 1 : 0 ) : ( i + ( e.shiftKey ? n - 1 : 1 ) ) % n ].focus();
                return;
            }
            // Only what would press the page's focused button: F5, Ctrl+R or zoom still work
            if( ! layer.contains( e.target ) && ( e.key === "Enter" || e.key === " " ) ) e.preventDefault();
        }

        async function start( deviceId )
        {
            var my = ++starts, got;
            stop();
            shutter.ariaDisabled = true;
            try
            {
                got = await navigator.mediaDevices.getUserMedia( { audio: false,
                    video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1920 }, height: { ideal: 1080 } } } );
            }
            catch( _ )
            {
                if( my !== starts ) return;                                // a newer start took over: it decides
                if( layer.isConnected ) { finish( null ); Ayni.toast( "err", Ayni.t( "ayni.camera.failed" ) ); }
                return;
            }
            // Closed while it asked, or a newer start asked meanwhile: this
            // stream is nobody's - stopped here, or the camera light stays on.
            if( my !== starts || ! layer.isConnected ) { got.getTracks().forEach( function ( t ) { t.stop(); } ); return; }
            stream = got;
            video.srcObject = stream;
            shutter.ariaDisabled = false;
            // With the permission given, every camera is listed: more than one = a switch.
            try { cams = ( await navigator.mediaDevices.enumerateDevices() ).filter( function ( d ) { return d.kind === "videoinput"; } ); }
            catch( _ ) { cams = []; }
            if( my !== starts || ! stream ) return;
            flip.hidden = cams.length < 2;
            var cur = stream.getVideoTracks()[ 0 ].getSettings().deviceId;
            at = Math.max( 0, cams.findIndex( function ( d ) { return d.deviceId === cur; } ) );
        }

        flip.addEventListener( "click", function () { if( cams.length > 1 ) { at = ( at + 1 ) % cams.length; start( cams[ at ].deviceId ); } } );
        closeB.addEventListener( "click", function () { finish( null ); } );
        shutter.addEventListener( "click", function ()
        {
            if( ! stream || ! video.videoWidth ) return;
            var c = document.createElement( "canvas" );
            c.width = video.videoWidth;
            c.height = video.videoHeight;
            c.getContext( "2d" ).drawImage( video, 0, 0 );
            shutter.ariaDisabled = true;
            c.toBlob( function ( b )
            {
                if( ! b ) { finish( null ); return; }
                var stamp = new Date().toISOString().slice( 0, 19 ).replace( /[-:]/g, "" ).replace( "T", "_" );
                finish( new File( [ b ], "foto_" + stamp + ".jpg", { type: "image/jpeg" } ) );
            }, "image/jpeg", 0.92 );
        } );

        document.addEventListener( "keydown", key, true );
        shutter.focus();          // off (aria-disabled) until the camera starts: Enter does nothing till then
        start( "" );
        return cancel;
    }

    //------------------------------------------------------------------------//
    //  Before a photo goes: see it, Crop, Rotate, Read text  (review)
    //------------------------------------------------------------------------//
    //
    // The crop, the turn and the full screen they use came from Chat
    // (chat/media.js, 2026-11-18): every app that sends or uploads a photo
    // now shows the same step. It writes NOTHING: review() resolves what the
    // user chose and the app sends it its own way. A photo nobody touched is
    // the very same File (its bytes go as they are); only an edit is drawn
    // again (a JPEG with the original's Exif).

    function h() { return Ayni.h.apply( null, arguments ); }
    function ic( name )
    {
        var t = document.createElement( "template" );
        t.innerHTML = Ayni.icon( name );
        return t.content.firstChild;
    }

    var EDIT_MAX = 4096;                  // longest side of an edit: an upload shrinks it later; an iPhone canvas stops near 16.7 MP

    // A picture, drawn the way it is seen (the browser applies its Exif turn).
    function loadImg( blob )
    {
        return new Promise( function ( ok, no )
        {
            var img = new Image();
            var u = URL.createObjectURL( blob );
            img.onload  = function () { URL.revokeObjectURL( u ); ok( img ); };
            img.onerror = function () { URL.revokeObjectURL( u ); no( new Error( "load" ) ); };
            img.src = u;
        } );
    }

    // The part `box` of `img` (all of it when null), a quarter turn right when
    // `turn`, as a new JPEG File - with `file`'s Exif (its date, its place).
    async function redrawPhoto( file, img, box, turn )
    {
        box = box || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
        var k = Math.min( 1, EDIT_MAX / Math.max( box.w, box.h ) );
        var w = Math.max( 1, Math.round( box.w * k ) ), ht = Math.max( 1, Math.round( box.h * k ) );
        var c = document.createElement( "canvas" );
        c.width  = turn ? ht : w;
        c.height = turn ? w : ht;
        var g = c.getContext( "2d" );
        if( turn ) { g.translate( ht, 0 ); g.rotate( Math.PI / 2 ); }
        g.drawImage( img, box.x, box.y, box.w, box.h, 0, 0, w, ht );
        var blob = await new Promise( function ( ok ) { c.toBlob( ok, "image/jpeg", 0.92 ); } );
        if( ! blob ) throw new Error( "render" );
        if( isJpeg( file ) ) blob = await copyExif( file, blob, c.width, c.height );
        return new File( [ blob ], jpegName( file.name || "foto" ), { type: "image/jpeg" } );
    }

    // Recortar: the photo full screen, a box over it - a corner sizes it,
    // inside it moves it. ✓ keeps what is in the box: done( file ); × leaves
    // the photo as it was.
    function cropPhoto( file, done, nav )
    {
        var okB = h( "button", { class: "btn on-media", attrs: { type: "button", "data-tip": Ayni.t( "imgEd.crop" ), "aria-label": Ayni.t( "imgEd.crop" ) } }, ic( "check" ) );
        var f = fullLayer( Ayni.t( "imgEd.crop" ), okB, nav );
        f.layer.classList.add( "cropper" );
        var url = URL.createObjectURL( file );
        var img = h( "img", { attrs: { src: url, alt: "", draggable: "false" } } );
        var box = h( "div", { class: "crop-box" }, [ "nw", "ne", "sw", "se" ].map( function ( c ) { return h( "span", { class: c, attrs: { "data-c": c } } ); } ) );
        box.hidden = true;
        f.canvas.appendChild( img );
        f.canvas.appendChild( box );

        var r = { x: 0, y: 0, w: 1, h: 1 };        // the box, as parts of the picture
        var MIN = 48;                               // px on screen: the box never smaller
        function place()
        {
            var ib = img.getBoundingClientRect(), cb = f.canvas.getBoundingClientRect();
            if( ! ib.width ) return;
            box.style.left   = ( ib.left - cb.left + r.x * ib.width ) + "px";
            box.style.top    = ( ib.top - cb.top + r.y * ib.height ) + "px";
            box.style.width  = ( r.w * ib.width ) + "px";
            box.style.height = ( r.h * ib.height ) + "px";
            box.hidden = false;
        }
        img.onload  = place;
        img.onerror = function () { f.close(); Ayni.toast( "err", Ayni.t( "ayni.photo.failed" ) ); };
        window.addEventListener( "resize", place );
        f.layer._onClose = function () { window.removeEventListener( "resize", place ); URL.revokeObjectURL( url ); };

        function clamp( v, lo, hi ) { return Math.max( lo, Math.min( hi, v ) ); }
        var drag = null;
        box.addEventListener( "pointerdown", function ( e )
        {
            if( e.button > 0 || drag ) return;
            e.preventDefault();
            drag = { id: e.pointerId, c: e.target.getAttribute( "data-c" ) || "", x0: e.clientX, y0: e.clientY,
                     r: { x: r.x, y: r.y, w: r.w, h: r.h }, ib: img.getBoundingClientRect() };
            box.setPointerCapture( e.pointerId );
        } );
        box.addEventListener( "pointermove", function ( e )
        {
            if( ! drag || e.pointerId !== drag.id ) return;
            var o = drag.r;
            var dx = ( e.clientX - drag.x0 ) / drag.ib.width, dy = ( e.clientY - drag.y0 ) / drag.ib.height;
            var mw = Math.min( 1, MIN / drag.ib.width ), mh = Math.min( 1, MIN / drag.ib.height );
            if( ! drag.c ) r = { x: clamp( o.x + dx, 0, 1 - o.w ), y: clamp( o.y + dy, 0, 1 - o.h ), w: o.w, h: o.h };
            else
            {
                var x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
                if( drag.c.indexOf( "w" ) >= 0 ) x1 = clamp( x1 + dx, 0, x2 - mw ); else x2 = clamp( x2 + dx, x1 + mw, 1 );
                if( drag.c.indexOf( "n" ) >= 0 ) y1 = clamp( y1 + dy, 0, y2 - mh ); else y2 = clamp( y2 + dy, y1 + mh, 1 );
                r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
            }
            place();
        } );
        function end( e ) { if( drag && e.pointerId === drag.id ) drag = null; }
        box.addEventListener( "pointerup", end );
        box.addEventListener( "pointercancel", end );

        var busy = false;
        okB.addEventListener( "click", function ()
        {
            if( busy || ! img.naturalWidth ) return;
            if( ! r.x && ! r.y && r.w === 1 && r.h === 1 ) { f.close(); return; }     // the box not moved: nothing to cut
            busy = true;
            var W = img.naturalWidth, H = img.naturalHeight;
            var cut = { x: Math.round( r.x * W ), y: Math.round( r.y * H ) };
            cut.w = Math.max( 1, Math.min( W - cut.x, Math.round( r.w * W ) ) );
            cut.h = Math.max( 1, Math.min( H - cut.y, Math.round( r.h * H ) ) );
            redrawPhoto( file, img, cut, false ).then( function ( out ) { f.close(); done( out ); },
                                                       function () { busy = false; Ayni.toast( "err", Ayni.t( "ayni.photo.failed" ) ); } );
        } );
    }

    // A full screen (a dark layer, its title and buttons on top) over the page,
    // or inside the open dialog. nav: the page's own Back, if it has one.

    // A full screen opened from a dialog (the photo sheet's crop) lives in
    // it, as a popover in the top layer: outside it, the modal dialog would
    // cover it and keep its presses.
    function onTopOfDialog( layer )
    {
        var dlg = [].slice.call( document.querySelectorAll( "dialog.panel[open]" ) ).pop();
        if( ! dlg ) { document.body.appendChild( layer ); return; }
        layer.popover = "manual";
        dlg.appendChild( layer );
        layer.showPopover();
    }

    function fullLayer( title, extra, nav )
    {
        var closeB = h( "button", { class: "btn on-media", attrs: { type: "button", "data-tip": Ayni.t( "ayni.close" ), "aria-label": Ayni.t( "ayni.close" ) } } );
        closeB.appendChild( ic( "close" ) );
        var actions = h( "div", { class: "editor-actions" }, extra || null, closeB );
        var titleEl = h( "div", { class: "editor-title", text: title } );
        var canvas  = h( "div", { class: "editor-canvas" } );
        var layer = h( "div", { class: "editor-backdrop full open", attrs: { role: "dialog", "aria-modal": "true" } }, h( "div", { class: "editor-bar" }, titleEl, actions ), canvas );
        onTopOfDialog( layer );
        function close() { layer.remove(); document.removeEventListener( "keydown", key, true ); if( layer._onClose ) layer._onClose(); }
        // Keys belong to whatever is on top: the editor or a sheet opened from
        // here answers its own Escape.
        function onTop()
        {
            for( var n = layer.nextElementSibling; n; n = n.nextElementSibling )
                if( n.matches( ".photo-editor, .full, dialog.panel[open], .ctx" ) ) return false;
            return true;
        }
        function key( e )
        {
            if( ! onTop() ) return;
            if( e.key === "Escape" ) { e.preventDefault(); if( nav ) nav.pop( "full" ); close(); } else if( layer._onKey ) layer._onKey( e );
        }
        closeB.addEventListener( "click", function () { if( nav ) nav.pop( "full" ); close(); } );
        document.addEventListener( "keydown", key, true );
        if( nav ) nav.push( "full", close );
        return { layer: layer, canvas: canvas, title: titleEl, close: function () { if( nav ) nav.pop( "full" ); close(); } };
    }

    /* A photo turned a quarter right, as a new JPEG File (with its Exif). */
    function turn( file )
    {
        return loadImg( file ).then( function ( img ) { return redrawPhoto( file, img, null, true ); } );
    }

    /* The crop on its own: resolves the cut File, or null when closed. */
    function crop( file, opts )
    {
        return new Promise( function ( ok )
        {
            cropPhoto( file, ok, opts && opts.nav );
        } );
    }

    var TEXT_MAX = 50000;                 // characters Read text keeps (a long letter); ocr.recognize's own default is 5000

    /* await AyniPhoto.review( files, opts ): the step before photos go - see
     * them, and for one photo Crop and Rotate under it; Read text for one or
     * several (several: read in turn, joined by a blank line, as the pages
     * of one letter). Resolves null when closed, else
     *   { files, urls, text, caption, edited }
     *   files    what goes: the same File objects unless edited; [] when the
     *            user chose Text
     *   urls     an object URL of each (a bubble can show it at once)
     *   text     the text read and checked by the user; "" unless Text or
     *            Both was chosen
     *   caption  the caption box's words (opts.caption)
     * opts:
     *   title     the sheet's title
     *   go        { tip, icon }: the main button (default: Accept, check)
     *   ocr       { recognize( blob, { language, signal, onProgress, maxLength } ) -> { text, truncated },
     *               langs: [ "es", ... ], lang: "es", setLang( code ) }; without it, no Read text
     *   textOnly  only the text counts - no Photo / Text / Both (Translator, a stored photo)
     *   autoRead  read at once
     *   noCrop    no Crop / Rotate (they would change nothing that is kept)
     *   caption   a placeholder: shows a caption box (Chat); it goes once the text is read
     *   nav       { push( name, close ), pop( name ) }: the page's own Back (Chat)
     *   track     fn( close ) -> fn: the page may close the sheet itself; the
     *             returned function is called once it is closed
     *   onGo      fn( result ) -> false keeps the sheet open (a check failed, or Copy) */
    function review( files, opts )
    {
        opts = opts || {};
        return new Promise( function ( resolve )
        {
            var T = Ayni.t;
            var body = h( "div", { class: "photo-review" } );
            files = files.slice();
            var urls = files.map( function ( f ) { return URL.createObjectURL( f ); } );
            var edited = false, busy = false;
            var tools = h( "div", { class: "prev-tools" } );
            if( files.length === 1 )
            {
                var one = h( "img", { class: "prev-one", attrs: { src: urls[ 0 ], alt: "" } } );
                // The edit replaces the photo here; it is what goes.
                var take = function ( f )
                {
                    busy = false;
                    if( ! f ) return;
                    files[ 0 ] = f;
                    edited = true;
                    URL.revokeObjectURL( urls[ 0 ] );
                    urls[ 0 ] = URL.createObjectURL( f );
                    one.src = urls[ 0 ];
                };
                var failed = function () { busy = false; Ayni.toast( "err", T( "ayni.photo.failed" ) ); };
                body.appendChild( one );
                if( ! opts.noCrop )
                {
                    tools.appendChild( btn( "crop", T( "imgEd.crop" ), function () { if( ! busy ) cropPhoto( files[ 0 ], take, opts.nav ); } ) );
                    tools.appendChild( btn( "retry", T( "imgEd.rotate" ), function ()
                    {
                        if( busy ) return;
                        busy = true;
                        turn( files[ 0 ] ).then( take, failed );
                    } ) );
                }
            }
            else
            {
                var grid = h( "div", { class: "prev-grid" } );
                urls.forEach( function ( u ) { grid.appendChild( h( "img", { attrs: { src: u, alt: "" } } ) ); } );
                body.appendChild( grid );
            }

            // Read text: the language, the bar, the text to check, then what goes.
            var ocr = opts.ocr, lang = ocr && ( ocr.langs.indexOf( ocr.lang ) !== -1 ? ocr.lang : ocr.langs[ 0 ] );
            var panel, status, bar, box, choices, pick = "photo", read = null;
            if( ocr )
            {
                tools.appendChild( btn( "ocr", T( "ayni.photo.readText" ), function () { read(); } ) );
                var ui = Ayni.i18n.lang();
                var name = function ( code )
                {
                    try { var n = new Intl.DisplayNames( [ ui ], { type: "language" } ).of( code ); return n.charAt( 0 ).toLocaleUpperCase( ui ) + n.slice( 1 ); }
                    catch( _ ) { return code; }
                };
                panel = h( "div", { class: "prev-text" } );
                panel.hidden = true;
                var pk = h( "div" );
                var field = h( "div", { class: "field" }, h( "label", { text: T( "ayni.photo.textLang" ) } ), pk );
                status = h( "p", { class: "hint" } );
                bar = h( "progress", { max: 1 } );
                box = h( "textarea", { class: "input", rows: 8, attrs: { "aria-label": T( "ayni.photo.readText" ) } } );
                box.hidden = true;
                choices = h( "div", { class: "choices", attrs: { role: "group", "aria-label": T( "ayni.photo.whatGoes" ) } } );
                choices.hidden = true;
                [ [ "photo", "ayni.photo.pickPhoto" ], [ "text", "ayni.photo.pickText" ], [ "both", "ayni.photo.pickBoth" ] ].forEach( function ( c )
                {
                    choices.appendChild( h( "button", { class: "btn text sm bordered", text: T( c[ 1 ] ),
                                                        attrs: { type: "button", "aria-pressed": "false", "data-pick": c[ 0 ] },
                                                        on: { click: function () { choose( c[ 0 ] ); } } } ) );
                } );
                panel.append( field, status, bar, box, choices );
                body.appendChild( panel );
                Ayni.picker( pk, { options: ocr.langs.map( function ( c ) { return { value: c, text: name( c ) }; } ), value: lang, onChange: function ( v )
                {
                    if( ocr.langs.indexOf( v ) === -1 || v === lang ) return;
                    lang = v;
                    if( ocr.setLang ) ocr.setLang( v );
                    if( ! panel.hidden ) read();
                } } );

                var run = null;
                read = async function ()
                {
                    if( run ) run.abort();
                    var ctl = run = new AbortController();
                    var live = function () { return run === ctl && dl.dialog.isConnected; };
                    panel.hidden = false; box.hidden = true; choices.hidden = true; bar.hidden = false; bar.value = 0;
                    body.classList.remove( "has-text" );
                    // Until this read finds text, the photo is what goes (a read
                    // again that finds nothing must not leave Send dead).
                    if( ! opts.textOnly ) choose( "photo" );
                    if( cap ) cap.parentNode.hidden = false;
                    syncGo();
                    var say = function ( pct ) { status.textContent = Ayni.tf( "ayni.photo.reading", { lang: name( lang ), pct: pct } ); };
                    say( 0 );
                    try
                    {
                        var parts = [], cut = false;
                        for( var i = 0; i < files.length; i++ )
                        {
                            var at = i;
                            var r = await ocr.recognize( files[ i ], { language: lang, maxLength: TEXT_MAX, signal: ctl.signal,
                                onProgress: function ( f ) { if( live() ) { var p = ( at + f ) / files.length; bar.value = p; say( Math.round( p * 100 ) ); } } } );
                            if( ! live() ) return;
                            if( r.text.trim() ) parts.push( r.text.trim() );
                            cut = cut || r.truncated;
                        }
                        bar.hidden = true;
                        if( ! parts.length ) { status.textContent = T( "ayni.photo.noText" ); return; }
                        status.textContent = cut ? T( "ayni.photo.textCut" ) : "";
                        box.value = parts.join( "\n\n" );
                        box.hidden = false;
                        body.classList.add( "has-text" );              // the photo gets small: the text is what to check now
                        if( cap ) cap.parentNode.hidden = true;        // the text says it all
                        if( ! opts.textOnly ) { choices.hidden = false; choose( "text" ); }
                        syncGo();
                    }
                    catch( e )
                    {
                        if( ! live() || ( e && ( e.name === "AbortError" || e.category === "aborted" ) ) ) return;
                        bar.hidden = true;
                        status.textContent = T( e && e.category === "invalid-input" ? "ayni.photo.notImage"
                                              : e && e.category === "network" ? "ayni.photo.noNet" : "ayni.photo.readFailed" );
                    }
                };
            }
            if( tools.children.length ) body.insertBefore( tools, panel || null );

            var cap = null;
            if( opts.caption != null )
            {
                cap = h( "input", { class: "input", attrs: { type: "text", placeholder: opts.caption, "aria-label": opts.caption } } );
                body.appendChild( h( "div", { class: "field" }, cap ) );
            }

            var dl = Ayni.dialog( { cls: "photo-review-sheet", title: opts.title ||
                                    ( files.length === 1 ? T( "ayni.photo.one" ) : Ayni.tf( "ayni.photo.n", { n: files.length } ) ) } );
            dl.body.appendChild( body );
            var close = Ayni.dialogButton( "close", T( "ayni.close" ) );
            var go = Ayni.dialogButton( "primary", ( opts.go && opts.go.tip ) || T( "ayni.accept" ), opts.go && opts.go.icon );
            dl.place( [ close, go ] );

            function hasText() { return !! ( box && ! box.hidden && box.value.trim() ); }
            function wanted() { return opts.textOnly ? "text" : pick; }
            function syncGo() { go.ariaDisabled = wanted() !== "photo" && ! hasText() ? "true" : null; }
            function choose( p )
            {
                pick = p;
                [].forEach.call( choices.children, function ( b ) { b.setAttribute( "aria-pressed", String( b.getAttribute( "data-pick" ) === p ) ); } );
                syncGo();
            }
            if( box ) box.addEventListener( "input", syncGo );
            syncGo();

            var untrack = null, ended = false;
            function finish( out )
            {
                if( ended ) return;
                ended = true;
                if( run ) run.abort();
                dl.close();
                if( untrack ) untrack();
                if( ! out ) urls.forEach( function ( u ) { URL.revokeObjectURL( u ); } );
                resolve( out );
            }
            function send()
            {
                if( busy ) return;                                   // a turn still being drawn
                var w = wanted();
                if( w !== "photo" && ! hasText() ) return;
                var out = { files: w === "text" ? [] : files.slice(), urls: w === "text" ? [] : urls.slice(),
                            text: w === "photo" ? "" : box.value.trim(),
                            caption: cap && ! cap.parentNode.hidden ? cap.value.trim() : "", edited: edited };
                if( opts.onGo && opts.onGo( out ) === false ) return;
                if( w === "text" ) urls.forEach( function ( u ) { URL.revokeObjectURL( u ); } );
                finish( out );
            }
            go.addEventListener( "click", send );
            close.addEventListener( "click", function () { finish( null ); } );
            dl.dialog.addEventListener( "close", function () { finish( null ); } );
            if( cap ) cap.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); send(); } } );
            if( opts.track ) untrack = opts.track( function () { finish( null ); } );
            dl.show();
            if( cap ) setTimeout( function () { cap.focus(); }, 50 );
            if( ocr && opts.autoRead ) read();
        } );
    }

    function btn( icon, tip, onClick )
    {
        var b = h( "button", { class: "btn", attrs: { type: "button", "data-tip": tip, "aria-label": tip }, on: { click: onClick } } );
        b.appendChild( ic( icon ) );
        return b;
    }

    window.AyniPhoto =
    {
        face:         face,
        limit:        limit,
        prepare:      prepare,
        shrinkToJpeg: shrinkToJpeg,
        keepExif:     keepExif,
        loadEditor:   loadEditor,
        newEditor:    newEditor,
        dataUrlBytes: dataUrlBytes,
        thumbOf:      thumbOf,
        thumbPath:    thumbPath,
        dropThumb:    dropThumb,
        copyExif:     copyExif,
        exifAt:       exifAt,       // where a JPEG's Exif block is (Photos reads dates and places)
        jpegName:     jpegName,
        EDIT_EXT:     EDIT_EXT,     // what Image can edit (Drive opens these there)
        isJpeg:       isJpeg,
        ownCamera:    ownCamera,
        canTakePhoto: canTakePhoto,
        cameraWatch:  cameraWatch,
        camera:       camera,
        review:       review,       // the step before a photo goes: Crop, Rotate, Read text
        crop:         crop,
        turn:         turn,
        fullLayer:    fullLayer     // a dark full screen (Chat's photo and map viewers)
    };
} )();
