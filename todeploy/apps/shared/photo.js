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
 * share target (photos shared into Nayive from another Android app):
 *
 *     <script src="../shared/photo.js"></script>
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
        return GumApi.probeAccess().then( function ( me )
        {
            var px = me && me.photo_max;
            LIMIT = ( typeof px === "number" && px > 0 ) ? px : null;
            return LIMIT;
        } ).catch( function () { return null; } );
    }

    //------------------------------------------------------------------------//
    //  What is a photo
    //------------------------------------------------------------------------//

    function extOf( name )
    {
        var m = /\.([a-z0-9]+)$/i.exec( String( name || "" ) );
        return m ? m[ 1 ].toLowerCase() : "";
    }

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

    function isJpeg( file )
    {
        var type = String( ( file && file.type ) || "" ).toLowerCase();
        if ( type === "image/jpeg" || type === "image/jpg" ) return true;
        var e = extOf( file && file.name );
        return ! type && ( e === "jpg" || e === "jpeg" );
    }

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

    /* The Exif APP1 segment of a JPEG, as a Uint8Array copy (marker bytes and
     * all), or null. A JPEG is a chain of segments: 0xFFD8 (start of image),
     * then FF <marker> <2-byte length> <payload>..., until FFDA starts the
     * compressed pixels. Exif is the APP1 (0xFFE1) whose payload begins with
     * "Exif\0\0". */
    function exifSegment( u8 )
    {
        if ( ! u8 || u8.length < 4 || u8[ 0 ] !== 0xFF || u8[ 1 ] !== 0xD8 ) return null;
        var i = 2;
        while ( i + 4 <= u8.length && u8[ i ] === 0xFF )
        {
            var marker = u8[ i + 1 ];
            if ( marker === 0xDA || marker === 0xD9 ) break;       // pixels / end
            var len = ( u8[ i + 2 ] << 8 ) | u8[ i + 3 ];
            if ( len < 2 || i + 2 + len > u8.length ) break;
            if ( marker === 0xE1 && i + 10 <= u8.length &&
                 u8[ i + 4 ] === 0x45 && u8[ i + 5 ] === 0x78 &&    // "Ex"
                 u8[ i + 6 ] === 0x69 && u8[ i + 7 ] === 0x66 &&    // "if"
                 u8[ i + 8 ] === 0x00 )
                return u8.slice( i, i + 2 + len );                  // py-ish: a copy, not a view
            i += 2 + len;
        }
        return null;
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
        // throw quality away for nothing.
        if ( w <= max && h <= max && isJpeg( file ) ) { closeBitmap( bmp ); return out; }

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

    //------------------------------------------------------------------------//

    window.NayivePhoto =
    {
        limit:        limit,
        prepare:      prepare,
        shrinkToJpeg: shrinkToJpeg,
        jpegName:     jpegName,
        isImage:      isImage,
        isJpeg:       isJpeg
    };
} )();
