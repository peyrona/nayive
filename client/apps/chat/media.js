/*
 * media.js - what a message can carry besides text: photos, files, a place,
 * a contact card, a poll. How each is drawn in its bubble, how it is sent,
 * and the full-screen photo and map. See core.js.
 *
 * The owner can also do three things with Nayive itself: send a document
 * that is already in their files, KEEP a photo (Copiar: it is also put in
 * their Photos folder, so deleting the message never loses it) and EDIT one
 * with the image editor Drive and Photos use. The edit is always a NEW file
 * beside the photo - never written over it, which may be the camera original
 * in their library (J1) - and ✓ points the message at it, so everybody in
 * the chat sees the edit.
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h, T = C.T;

    var MAX_FILE  = 25 * 1024 * 1024;
    var PHOTO_MAX = 1600;                 // longest side of a sent photo, px
    var OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";   // no {s}. subdomains: OSM asks for the one name
    var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

    // ---------------------------------------------------------------------
    // bubbles
    // ---------------------------------------------------------------------

    // A photo's address. A kept photo gets a new one when it is kept (its rev)
    // and when it is edited here (_v): before, the browser was told to keep
    // the chat's copy for ever, and it would never ask for the edited one.
    function photoUrl( m ) { return C.mediaUrl( S.open, m.id ) + ( m.kept || m._v ? "?v=" + ( m._v || m.rev ) : "" ); }
    C.photoUrl = photoUrl;
    // The bubble's: a kept photo may be a whole camera original, so the server
    // sends Photos' thumbnail of it when there is one.
    C.thumbUrl = function ( m ) { return photoUrl( m ) + ( m.kept ? "&thumb=1" : "" ); };

    C.photoBody = function ( el, m, meta )
    {
        var src = m.localUrl || C.thumbUrl( m );
        var img = h( "img", { class: "ph", attrs: { src: src, alt: "", loading: "lazy", decoding: "async" } } );
        if( m.file && m.file.w && m.file.h )
            img.style.height = Math.round( Math.min( 320, Math.max( 120, 240 * m.file.h / m.file.w ) ) ) + "px";
        if( m.id > 0 ) img.addEventListener( "click", function ( e ) { e.stopPropagation(); C.openPhoto( m.id ); } );
        var wrap = h( "div", { class: "ph-wrap" }, img );
        el.appendChild( wrap );
        if( m.progress != null ) wrap.appendChild( progress( m ) );
        if( m.text )
        {
            var cap = h( "div", { class: "cap" } );
            C.textNodes( cap, m.text );
            cap.appendChild( meta( m ) );
            el.appendChild( cap );
        }
        else wrap.appendChild( meta( m, true ) );
    };

    function progress( m )
    {
        return h( "span", { class: "meta on-media", style: "left:8px;right:auto" }, Math.round( m.progress * 100 ) + " %" );
    }

    C.fileBody = function ( el, m, meta )
    {
        var f = m.file || {};
        var ext = ( f.ext || ( f.name || "" ).split( "." ).pop() || "" ).slice( 0, 4 );
        var card = h( m.id > 0 ? "a" : "div", { class: "filec", data: { c: "3" },
                        attrs: m.id > 0 ? { href: C.mediaUrl( S.open, m.id, true ), download: f.name || "" } : {} },
            h( "span", { class: "fic", text: ext || "?" } ),
            h( "span", { class: "fn" }, h( "b", { text: f.name || "" } ),
                h( "small", { text: C.fmtBytes( f.size || 0 ) + ( m.progress != null ? " · " + Math.round( m.progress * 100 ) + " %" : "" ) } ) ),
            h( "span", { class: "dl" }, C.ic( "download" ) ) );
        el.appendChild( card );
        if( m.text ) C.textNodes( el, "\n" + m.text );
        el.appendChild( meta( m ) );
    };

    C.locBody = function ( el, m, meta )
    {
        var l = m.loc || {};
        var mini = h( "div", { class: "mini" } );
        mini.appendChild( h( "span", { class: "mini-pin", html: '<svg viewBox="0 0 24 24"><path d="M12 2C8 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3-7-7-7z"/><circle cx="12" cy="9" r="2.6" fill="white" stroke="none"/></svg>' } ) );
        mini.addEventListener( "click", function ( e ) { e.stopPropagation(); C.openMap( l ); } );
        el.appendChild( mini );
        lazyMiniMap( mini, l );
        var lt = h( "div", { class: "lt" },
            h( "b", { text: l.place || T( "chat.location" ) } ),
            h( "small", { text: l.lat.toFixed( 5 ) + ", " + l.lon.toFixed( 5 ) } ) );
        lt.appendChild( meta( m ) );
        el.appendChild( lt );
    };

    // A small still map, drawn only once the bubble scrolls into view.
    var io = ( "IntersectionObserver" in window ) ? new IntersectionObserver( function ( entries )
    {
        entries.forEach( function ( e )
        {
            if( ! e.isIntersecting ) return;
            io.unobserve( e.target );
            if( e.target._draw ) e.target._draw();
        } );
    }, { rootMargin: "200px" } ) : null;

    // The maps drawn so far. A re-render (a search key, a send) drops their
    // bubbles, and a Leaflet map is only let go - its window "resize"
    // listener with it - by remove(): so each new one sweeps the dropped ones.
    var miniMaps = [];

    function sweepMiniMaps()
    {
        miniMaps = miniMaps.filter( function ( mm ) { if( mm.getContainer().isConnected ) return true; mm.remove(); return false; } );
    }

    function lazyMiniMap( box, l )
    {
        sweepMiniMaps();
        box._draw = function ()
        {
            if( ! window.L || ! box.isConnected ) return;
            sweepMiniMaps();
            var map = L.map( box, { zoomControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false,
                                    doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false,
                                    attributionControl: true } );
            map.attributionControl.setPrefix( false );
            map.setView( [ l.lat, l.lon ], 15 );
            // strict-origin: the tile server sees our site, never a person's link
            L.tileLayer( OSM, { maxZoom: 19, attribution: OSM_ATTR, referrerPolicy: "strict-origin-when-cross-origin" } ).addTo( map );
            miniMaps.push( map );
        };
        if( io ) setTimeout( function () { if( box.isConnected ) io.observe( box ); }, 0 );
        else setTimeout( box._draw, 0 );
    }

    C.cardBody = function ( el, m, meta )
    {
        var c = m.card || {};
        var tel = ( c.tels || [] )[ 0 ], mail = ( c.emails || [] )[ 0 ];
        el.appendChild( h( "div", { class: "cc" }, C.avatar( "x" + c.name, c.name ),
            h( "div", {}, h( "b", { text: c.name } ), h( "small", { text: tel || mail || "" } ) ) ) );
        var act = h( "div", { class: "cc-act" } );
        if( tel ) act.appendChild( h( "a", { text: T( "chat.call" ), attrs: { href: "tel:" + tel.replace( /[^\d+]/g, "" ) } } ) );
        else if( mail ) act.appendChild( h( "a", { text: T( "chat.mail" ), attrs: { href: "mailto:" + mail } } ) );
        act.appendChild( h( "button", { attrs: { type: "button" }, text: T( "chat.save" ),
                                        on: { click: function ( e ) { e.stopPropagation(); saveVcf( c ); } } } ) );
        el.appendChild( meta( m ) );
        el.appendChild( act );
    };

    // vCard's text escape (shared/vcard.js escapeText): a person's page has
    // no session, and that file is not public (server/go/static.go).
    function vEsc( s ) { return String( s ).replace( /\\/g, "\\\\" ).replace( /[,;]/g, "\\$&" ).replace( /\n/g, "\\n" ); }

    function saveVcf( c )
    {
        var lines = [ "BEGIN:VCARD", "VERSION:3.0", "FN:" + vEsc( c.name ), "N:" + vEsc( c.name ) + ";;;;" ];
        ( c.tels || [] ).forEach( function ( t ) { lines.push( "TEL;TYPE=CELL:" + vEsc( t ) ); } );
        ( c.emails || [] ).forEach( function ( e ) { lines.push( "EMAIL:" + vEsc( e ) ); } );
        lines.push( "END:VCARD" );
        var url = URL.createObjectURL( new Blob( [ lines.join( "\r\n" ) + "\r\n" ], { type: "text/vcard" } ) );
        var a = h( "a", { attrs: { href: url, download: ( c.name || "contacto" ).replace( /[\\/:*?"<>|]/g, "_" ) + ".vcf" } } );
        document.body.appendChild( a );
        a.click();
        a.remove();
        setTimeout( function () { URL.revokeObjectURL( url ); }, 5000 );
    }

    C.pollBody = function ( el, m, meta )
    {
        var p = m.poll || { opts: [] };
        var votes = p.votes || {};
        var counts = p.opts.map( function () { return 0; } );
        var mine = votes[ C.me() ] || [];
        var voters = Object.keys( votes );
        voters.forEach( function ( v ) { ( votes[ v ] || [] ).forEach( function ( i ) { if( counts[ i ] != null ) counts[ i ]++; } ); } );
        var max = Math.max.apply( null, counts.concat( [ 1 ] ) );
        el.appendChild( h( "div", { class: "poll-q", text: p.q } ) );
        el.appendChild( h( "div", { class: "poll-hint", text: T( p.multi ? "chat.pollMany" : "chat.pollOne" ) } ) );
        p.opts.forEach( function ( o, i )
        {
            var on = mine.indexOf( i ) >= 0;
            var chk = h( "span", { class: "chk" + ( on ? " on" : "" ) } );
            if( on ) chk.appendChild( C.ic( "check" ) );
            var bar = h( "span", { class: "barx" }, h( "i", { style: "width:" + Math.round( 100 * counts[ i ] / max ) + "%" } ) );
            el.appendChild( h( "button", { class: "popt", attrs: { type: "button", disabled: m.id < 0 },
                                           on: { click: function ( e ) { e.stopPropagation(); vote( m, i ); } } },
                chk, h( "span", { text: o } ), h( "span", { class: "n", text: String( counts[ i ] ) } ), bar ) );
        } );
        el.appendChild( meta( m ) );
        el.appendChild( h( "div", { class: "poll-foot" },
            h( "button", { attrs: { type: "button" }, text: T( "chat.seeVotes" ),
                           on: { click: function ( e ) { e.stopPropagation(); showVotes( m ); } } } ) ) );
    };

    async function vote( m, i )
    {
        try
        {
            var out = await C.api( "POST", "conv/" + S.open + "/messages/" + m.id + "/vote", { opt: i } );
            S.msgs.set( out.id, out );
            C.redraw( out.id );
        }
        catch( e ) { C.fail( e ); }
    }

    function showVotes( m )
    {
        var p = m.poll, votes = p.votes || {};
        var body = h( "div" );
        p.opts.forEach( function ( o, i )
        {
            var who = Object.keys( votes ).filter( function ( v ) { return ( votes[ v ] || [] ).indexOf( i ) >= 0; } );
            body.appendChild( h( "div", { class: "section-label", text: o + " · " + who.length } ) );
            var ul = h( "ul", { class: "who-list" } );
            who.forEach( function ( v ) { ul.appendChild( h( "li", {}, C.avatar( v, C.nameOf( v ), "sm" ), h( "span", { text: C.nameOf( v ) } ) ) ); } );
            body.appendChild( ul );
        } );
        C.sheet( p.q, body );
    }

    // ---------------------------------------------------------------------
    // choosing photos and files
    // ---------------------------------------------------------------------

    C.pickFiles = function ( how )
    {
        if( ! S.open ) return;
        if( how === "camera" && C.useOwnCamera() ) { C.openCamera(); return; }
        var input = h( "input", { attrs: { type: "file", hidden: true } } );
        if( how === "camera" ) { input.accept = "image/*"; input.setAttribute( "capture", "environment" ); }
        else if( how === "gallery" ) { input.accept = "image/*"; input.multiple = true; }
        else input.multiple = true;
        input.addEventListener( "change", function ()
        {
            var files = Array.prototype.slice.call( input.files || [] );
            input.remove();
            if( ! files.length ) return;
            if( how === "file" ) sendFiles( files );
            else previewPhotos( files );
        } );
        document.body.appendChild( input );
        input.click();
    };

    // Files from this device ("Local doc." or dropped on the chat): a picture
    // goes as a photo - shown in the chat, not as a file icon - the rest as
    // files. upload() still sends a picture this browser cannot draw as a file.
    function isPicture( f ) { return /^image\//.test( f.type || "" ) || IMAGE_EXT.test( f.name || "" ); }

    function sendFiles( files )
    {
        var pics = files.filter( isPicture );
        files.forEach( function ( f ) { if( ! isPicture( f ) ) upload( f, "file", "" ); } );
        if( pics.length ) previewPhotos( pics );
    }

    // Drag and drop onto an open chat. Only files; not while a sheet or the
    // photo editor is on top.
    function dropOk( e )
    {
        var dt = e.dataTransfer;
        return S.open && dt && Array.prototype.indexOf.call( dt.types || [], "Files" ) >= 0 &&
               ! document.querySelector( ".sheet-backdrop.open, .editor-backdrop.open" );
    }
    document.addEventListener( "dragover", function ( e )
    {
        if( ! dropOk( e ) ) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    } );
    document.addEventListener( "drop", function ( e )
    {
        if( ! dropOk( e ) ) return;
        e.preventDefault();
        var files = Array.prototype.slice.call( e.dataTransfer.files || [] );
        if( files.length ) sendFiles( files );
    } );

    // The owner's extras need their session: guest.html has no GumApi.
    // Their own files (the clip's "Nayive doc") serve in any chat; keeping or
    // editing a photo only in a chat of their own home (the server keeps it in
    // the home's owner's files).
    C.canUseNayive  = function () { return S.mode === "owner" && !! window.GumApi; };
    C.canEditPhotos = function () { return C.canUseNayive() && C.owns( S.open ); };

    // Where a file comes from, for the owner: this device or their files in
    // Nayive. Each choice runs inside its own tap (a file input opens only
    // from a tap); closing it runs `none`.
    C.pickSource = function ( title, device, nayive, none )
    {
        var body = h( "div" );
        var sh = null, chosen = null;
        function choice( icon, label, act )
        {
            var b = h( "button", { class: "text-btn ghost", attrs: { type: "button" } }, C.ic( icon ), label );
            b.addEventListener( "click", function () { chosen = act; sh.close(); act(); } );
            body.appendChild( h( "div", { class: "pick-opt" }, b ) );
        }
        choice( "phone2", T( "chat.fromDevice" ), device );
        choice( "folder", T( "chat.fromNayive" ), nayive );
        sh = C.sheet( title, body, null, function () { if( ! chosen && none ) none(); } );
    };

    // A picture (a profile's, a group's): from this device, or - the owner,
    // asked first - from their files in Nayive. Resolves a Blob, or null.
    var IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;   // what a browser can draw (no HEIC)

    C.pickImage = function ( title )
    {
        return new Promise( function ( resolve )
        {
            if( ! C.canUseNayive() ) { deviceImage( resolve ); return; }
            C.pickSource( title, function () { deviceImage( resolve ); },
                          function () { nayiveImage( title ).then( resolve, function ( e ) { C.fail( e ); resolve( null ); } ); },
                          function () { resolve( null ); } );
        } );
    };

    // A picture made ready to send (his rule, 2026-09-27): a JPEG of 300 x
    // 300 px at most (NayivePhoto.face), then PUT raw to `path` of my home.
    C.facePicture = function ( blob ) { return NayivePhoto.face( blob, { jpeg: true } ); };
    C.putPicture = async function ( path, blob )
    {
        var res = await fetch( S.api + "/" + path, { method: "PUT", credentials: "same-origin",
                                                    headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob } );
        if( ! res.ok ) throw { status: res.status };
    };

    // The same picture as the PHOTO of a card of the address book (the
    // Contacts app), for ever. A card deleted there since: nothing to do.
    C.cardPicture = async function ( uid, blob )
    {
        try { await C.putPicture( "cards/photo?uid=" + encodeURIComponent( uid ), blob ); }
        catch( e ) { if( ! e || e.status !== 404 ) throw e; }
        C.forgetBook();
    };

    // A card of the address book as a circle: its picture, or its initials.
    C.cardAvatar = function ( card, size )
    {
        var av = C.avatar( "x" + card.name, card.name, size, null );
        if( card.photo )
        {
            av.textContent = "";
            av.classList.add( "has-photo" );
            av.appendChild( h( "img", { attrs: { src: card.photo, alt: "", loading: "lazy" } } ) );
        }
        return av;
    };

    function deviceImage( resolve )
    {
        var input = h( "input", { attrs: { type: "file", accept: "image/*", hidden: true } } );
        input.addEventListener( "change", function ()
        {
            var file = input.files && input.files[ 0 ];
            input.remove();
            resolve( file || null );
        } );
        input.addEventListener( "cancel", function () { input.remove(); resolve( null ); } );
        document.body.appendChild( input );
        input.click();
    }

    // Opens in the Photos app's folder when there is one; shows only pictures.
    async function nayiveImage( title )
    {
        var dir = "files";
        try { var cfg = await GumApi.readJson( "data/photos/config.json" ); if( cfg && cfg.folder ) dir = cfg.folder; } catch( _ ) {}
        var f = await NayiveUI.pickFile( { title: title, dir: dir, only: function ( name ) { return IMAGE_EXT.test( name ); } } );
        if( ! f ) return null;
        if( ! IMAGE_EXT.test( f.name ) ) { C.toast( "chat.notImage", 3000 ); return null; }
        var bytes = await GumApi.readFileBytes( f.path );
        return new Blob( [ bytes ] );
    }

    // Clip -> "Nayive doc" (the owner): a file from their own files, sent as a
    // document. Its bytes come down and go up again the way a file from this
    // device does (the same limits, the same progress figure). A picture goes
    // as a photo instead - shown in the chat, not as a file icon. A JPEG in a
    // chat of their own home is not even copied: the message points at their
    // file (POST messages {"ref"}), so the chat holds no duplicate.
    C.pickFromNayive = async function ()
    {
        var conv = S.open;
        var f = await NayiveUI.pickFile( { title: T( "chat.nayiveDoc" ), confirm: T( "chat.sendMsg" ) } );
        if( ! f || S.open !== conv ) return;
        var photo = IMAGE_EXT.test( f.name );
        if( ! photo && f.size > MAX_FILE ) { C.toast( "chat.tooBig", 3000 ); return; }
        if( f.size > 2 * 1024 * 1024 ) C.toast( "chat.fetchingFile" );
        try
        {
            var bytes = await GumApi.readFileBytes( f.path );
            if( S.open !== conv ) return;
            var file = new File( [ bytes ], f.name );
            if( ! photo ) upload( file, "file", "" );
            else if( /\.jpe?g$/i.test( f.name ) && C.canEditPhotos() ) previewPhotos( [ file ], function ( caption, reply, url )
            {
                measure( file ).then( function ( dims )
                {
                    C.sendMsg( { kind: "photo", ref: f.path, text: caption, replyTo: reply,
                                 w: dims ? dims[ 0 ] : 0, h: dims ? dims[ 1 ] : 0 }, conv,
                               { localUrl: url, file: { name: f.name, w: dims ? dims[ 0 ] : 0, h: dims ? dims[ 1 ] : 0 } } );
                } );
            } );
            else previewPhotos( [ file ] );
        }
        catch( e ) { C.fail( e ); }
    };

    // WhatsApp's step before sending photos: see them, add a line, send.
    // sendOne( caption, replyTo, previewUrl ): sends a single photo another way.
    function previewPhotos( files, sendOne )
    {
        var body = h( "div" );
        var urls = files.map( function ( f ) { return URL.createObjectURL( f ); } );
        if( files.length === 1 ) body.appendChild( h( "img", { class: "prev-one", attrs: { src: urls[ 0 ], alt: "" } } ) );
        else
        {
            var grid = h( "div", { class: "prev-grid" } );
            urls.forEach( function ( u ) { grid.appendChild( h( "img", { attrs: { src: u, alt: "" } } ) ); } );
            body.appendChild( grid );
        }
        var cap = h( "input", { attrs: { type: "text", placeholder: T( "chat.addCaption" ), "aria-label": T( "chat.addCaption" ) } } );
        body.appendChild( h( "div", { class: "field" }, cap ) );
        var go = h( "button", { attrs: { type: "button", "data-act": "primary:send", title: T( "chat.sendMsg" ) } } );
        var sh = C.sheet( files.length === 1 ? T( "chat.photo" ) : C.TF( "chat.nPhotos", { n: files.length } ), body, go );
        function send()
        {
            // The message box's limit (compose.js send): over it the server refuses
            // the photo's caption. The sheet stays open, the caption in its box.
            if( Array.from( cap.value.trim() ).length > 4000 ) { C.toast( "chat.tooLong", 4000 ); return; }
            sh.close();
            var reply = S.replyTo ? S.replyTo.id : 0;
            C.resetComposer();
            if( sendOne ) { sendOne( cap.value.trim(), reply, urls[ 0 ] ); return; }
            files.forEach( function ( f, i ) { upload( f, "photo", i === 0 ? cap.value.trim() : "", i === 0 ? reply : 0, urls[ i ] ); } );
        }
        go.addEventListener( "click", send );
        cap.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) send(); } );
        setTimeout( function () { cap.focus(); }, 50 );
    }

    // One photo or file: shown at once, then sent with a progress figure.
    async function upload( file, kind, caption, replyTo, localUrl )
    {
        var conv = S.open;
        var blob = file, name = file.name || ( kind === "photo" ? "foto.jpg" : "file" );
        if( kind === "photo" )
        {
            try
            {
                blob = await NayivePhoto.shrinkToJpeg( file, { maxW: PHOTO_MAX, maxH: PHOTO_MAX, quality: 0.82 } );
                name = NayivePhoto.jpegName ? NayivePhoto.jpegName( name ) : name;
            }
            catch( _ ) { kind = "file"; blob = file; }      // a picture this browser cannot draw goes as a file
        }
        var dims = kind === "photo" ? await measure( blob ) : null;
        // The canvas drops the Exif: put the original's back - its date, and
        // its position (his call: the photo keeps its GPS; Photos maps it).
        if( kind === "photo" && dims && NayivePhoto.copyExif && NayivePhoto.isJpeg( file ) )
            blob = await NayivePhoto.copyExif( file, blob, dims[ 0 ], dims[ 1 ] );
        if( blob.size > MAX_FILE ) { C.toast( "chat.tooBig", 3000 ); return; }

        var cid = C.rid();
        var temp = null;
        if( conv === S.open )
            temp = C.addTemp( { kind: kind, text: caption, replyTo: replyTo || 0, cid: cid, progress: 0,
                                localUrl: kind === "photo" ? ( localUrl || URL.createObjectURL( blob ) ) : null,
                                file: { name: name, size: blob.size, w: dims && dims[ 0 ], h: dims && dims[ 1 ] } } );
        var q = "kind=" + kind + "&name=" + encodeURIComponent( name ) + "&cid=" + cid +
                ( caption ? "&text=" + encodeURIComponent( caption ) : "" ) +
                ( replyTo ? "&replyTo=" + replyTo : "" ) +
                ( dims ? "&w=" + dims[ 0 ] + "&h=" + dims[ 1 ] : "" );
        var xhr = new XMLHttpRequest();
        xhr.open( "POST", C.W( conv ).api + "/conv/" + encodeURIComponent( conv ) + "/upload?" + q );
        xhr.setRequestHeader( "Content-Type", "application/octet-stream" );
        var last = 0;
        xhr.upload.onprogress = function ( e )
        {
            if( ! temp || ! e.lengthComputable || Date.now() - last < 300 ) return;
            last = Date.now();
            temp.progress = e.loaded / e.total;
            C.redraw( temp.id );
        };
        xhr.onload = function ()
        {
            var out = null;
            try { out = JSON.parse( xhr.responseText ); } catch( _ ) {}
            if( xhr.status >= 200 && xhr.status < 300 && out && out.id )
            {
                if( temp && S.open === conv ) { temp.progress = null; C.settleTemp( temp, out ); }
            }
            else fail( xhr.status );
        };
        xhr.onerror = function () { fail( 0 ); };
        function fail( status )
        {
            if( temp ) { temp.progress = null; temp._retry = function () { upload( file, kind === "photo" ? "photo" : "file", caption, replyTo, localUrl ); }; C.failTemp( temp ); }
            C.fail( { status: status } );
        }
        xhr.send( blob );
    }

    function measure( blob )
    {
        return new Promise( function ( ok )
        {
            var img = new Image();
            var u = URL.createObjectURL( blob );
            img.onload  = function () { ok( [ img.naturalWidth, img.naturalHeight ] ); URL.revokeObjectURL( u ); };
            img.onerror = function () { ok( null ); URL.revokeObjectURL( u ); };
            img.src = u;
        } );
    }

    // ---------------------------------------------------------------------
    // full screen: photos (with prev/next), a map
    // ---------------------------------------------------------------------

    function fullLayer( title, extra )
    {
        var closeB = h( "button", { class: "editor-btn", attrs: { type: "button", title: T( "ui.close" ), "aria-label": T( "ui.close" ) } } );
        closeB.appendChild( C.ic( "x" ) );
        var actions = h( "div", { class: "editor-actions" }, extra || null, closeB );
        var titleEl = h( "div", { class: "editor-title", text: title } );
        var canvas  = h( "div", { class: "editor-canvas" } );
        var layer = h( "div", { class: "editor-backdrop full open" }, h( "div", { class: "editor-bar" }, titleEl, actions ), canvas );
        document.body.appendChild( layer );
        function close() { layer.remove(); document.removeEventListener( "keydown", key, true ); if( layer._onClose ) layer._onClose(); }
        // Keys belong to whatever is on top: the editor or a sheet opened from
        // here answers its own Escape.
        function onTop()
        {
            for( var n = layer.nextElementSibling; n; n = n.nextElementSibling )
                if( n.matches( ".photo-editor, .full, .sheet-backdrop.open, .ctx" ) ) return false;
            return true;
        }
        function key( e )
        {
            if( ! onTop() ) return;
            if( e.key === "Escape" ) { e.preventDefault(); C.popNav( "full" ); close(); } else if( layer._onKey ) layer._onKey( e );
        }
        closeB.addEventListener( "click", function () { C.popNav( "full" ); close(); } );
        document.addEventListener( "keydown", key, true );
        C.pushNav( "full", close );
        return { layer: layer, canvas: canvas, title: titleEl, close: function () { C.popNav( "full" ); close(); } };
    }

    // ---------------------------------------------------------------------
    // the camera on a computer
    // ---------------------------------------------------------------------

    // A phone's file picker opens its own camera (capture="environment"); a
    // computer's only shows files. So a computer WITH a camera gets one here:
    // a live view and a shutter, then the usual "add a line, send" step.
    // Without a camera, the file picker as before.
    var hasCamera = false;
    function lookForCamera()
    {
        if( ! navigator.mediaDevices || ! navigator.mediaDevices.enumerateDevices ) return;
        navigator.mediaDevices.enumerateDevices().then( function ( list )
        {
            hasCamera = list.some( function ( d ) { return d.kind === "videoinput"; } );
        }, function () {} );
    }
    lookForCamera();
    if( navigator.mediaDevices && navigator.mediaDevices.addEventListener )
        navigator.mediaDevices.addEventListener( "devicechange", lookForCamera );

    // A computer: its main pointer is a mouse (a phone's or a tablet's is a finger).
    function computer() { return ! ( window.matchMedia && matchMedia( "(pointer: coarse)" ).matches ); }

    C.useOwnCamera = function ()
    {
        return computer() && hasCamera && !! ( navigator.mediaDevices && navigator.mediaDevices.getUserMedia );
    };

    C.openCamera = function ()
    {
        var conv = S.open;
        var flip = h( "button", { class: "editor-btn", attrs: { type: "button", title: T( "chat.switchCamera" ), "aria-label": T( "chat.switchCamera" ), hidden: true } },
                      C.ic( "refresh" ) );
        var shutter = h( "button", { class: "icon-btn lg solid-ok", attrs: { type: "button", title: T( "chat.takePhoto" ), "aria-label": T( "chat.takePhoto" ) } },
                         C.ic( "camera" ) );
        var f = fullLayer( T( "chat.camera" ), flip );
        f.layer.classList.add( "camera" );
        var video = h( "video", { attrs: { autoplay: "", playsinline: "", muted: "" } } );
        video.muted = true;
        f.canvas.appendChild( video );
        f.layer.appendChild( h( "div", { class: "cam-bar" }, shutter ) );

        var stream = null, cams = [], at = 0;
        function stop() { if( stream ) stream.getTracks().forEach( function ( t ) { t.stop(); } ); stream = null; }
        f.layer._onClose = stop;

        async function start( deviceId )
        {
            stop();
            shutter.disabled = true;
            try
            {
                stream = await navigator.mediaDevices.getUserMedia( { audio: false,
                    video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1920 }, height: { ideal: 1080 } } } );
            }
            catch( _ ) { if( f.layer.isConnected ) f.close(); C.toast( "chat.noCamera", 3500 ); return; }
            if( ! f.layer.isConnected ) { stop(); return; }                 // closed while it asked
            video.srcObject = stream;
            shutter.disabled = false;
            // With the permission given, every camera is listed: more than one = a switch.
            try { cams = ( await navigator.mediaDevices.enumerateDevices() ).filter( function ( d ) { return d.kind === "videoinput"; } ); }
            catch( _ ) { cams = []; }
            flip.hidden = cams.length < 2;
            var cur = stream.getVideoTracks()[ 0 ].getSettings().deviceId;
            at = Math.max( 0, cams.findIndex( function ( d ) { return d.deviceId === cur; } ) );
        }
        flip.addEventListener( "click", function () { if( cams.length > 1 ) { at = ( at + 1 ) % cams.length; start( cams[ at ].deviceId ); } } );

        shutter.addEventListener( "click", function ()
        {
            if( ! stream || ! video.videoWidth ) return;
            var c = document.createElement( "canvas" );
            c.width = video.videoWidth;
            c.height = video.videoHeight;
            c.getContext( "2d" ).drawImage( video, 0, 0 );
            shutter.disabled = true;
            c.toBlob( function ( b )
            {
                f.close();
                if( ! b || S.open !== conv ) return;
                var stamp = new Date().toISOString().slice( 0, 19 ).replace( /[-:]/g, "" ).replace( "T", "_" );
                previewPhotos( [ new File( [ b ], "foto_" + stamp + ".jpg", { type: "image/jpeg" } ) ] );
            }, "image/jpeg", 0.92 );
        } );
        start( "" );
    };

    C.openPhoto = function ( id )
    {
        var photos = S.order.filter( function ( x ) { var m = S.msgs.get( x ); return x > 0 && m.kind === "photo" && ! m.deleted; } );
        var at = photos.indexOf( id );
        if( at < 0 ) return;
        var dl = h( "a", { class: "editor-btn", attrs: { title: T( "chat.download" ), "aria-label": T( "chat.download" ) } } );
        dl.appendChild( C.ic( "download" ) );
        // The owner: Copiar (into their Photos folder) and Editar.
        var keepB = null, openB = null, editB = null;
        if( C.canEditPhotos() )
        {
            keepB = h( "button", { class: "editor-btn", attrs: { type: "button", title: T( "chat.keepPhoto" ), "aria-label": T( "chat.keepPhoto" ) },
                                   on: { click: function () { C.keepPhoto( S.msgs.get( photos[ at ] ) ).then( show ); } } }, C.ic( "copy" ) );
            // Once kept, Copiar becomes "Abrir en Fotos".
            openB = h( "button", { class: "editor-btn", attrs: { type: "button", title: T( "chat.openInPhotos" ), "aria-label": T( "chat.openInPhotos" ) },
                                   on: { click: function () { C.openInPhotos( S.msgs.get( photos[ at ] ) ); } } }, C.ic( "external" ) );
            editB = h( "button", { class: "editor-btn", attrs: { type: "button", title: T( "chat.editPhoto" ), "aria-label": T( "chat.editPhoto" ) },
                                   on: { click: function () { C.editPhoto( S.msgs.get( photos[ at ] ), show ); } } }, C.ic( "edit" ) );
        }
        var f = fullLayer( "", [ keepB, openB, editB, dl ] );
        var img = h( "img", { attrs: { alt: "" } } );
        var cap = h( "div", { class: "caption" } );
        var prev = h( "button", { class: "editor-btn over-media nav prev", attrs: { type: "button", title: T( "ui.prev" ) } } );
        var next = h( "button", { class: "editor-btn over-media nav next", attrs: { type: "button", title: T( "ui.next" ) } } );
        prev.appendChild( C.ic( "chev-l" ) );
        next.appendChild( C.ic( "chev" ) );
        f.canvas.appendChild( img );
        f.canvas.appendChild( prev );
        f.canvas.appendChild( next );
        f.layer.appendChild( cap );
        function show()
        {
            var m = S.msgs.get( photos[ at ] );
            if( ! m ) return;
            img.src = photoUrl( m );
            if( keepB ) { keepB.hidden = !! m.kept; openB.hidden = ! m.kept; }
            dl.href = C.mediaUrl( S.open, m.id, true );
            dl.setAttribute( "download", ( m.file && m.file.name ) || "foto.jpg" );
            f.title.textContent = C.nameOf( m.from ) + " · " + C.dayLabel( m.at ) + " " + C.time( m.at );
            cap.textContent = m.text || "";
            prev.hidden = at <= 0;
            next.hidden = at >= photos.length - 1;
        }
        prev.addEventListener( "click", function () { if( at > 0 ) { at--; show(); } } );
        next.addEventListener( "click", function () { if( at < photos.length - 1 ) { at++; show(); } } );
        f.layer._onKey = function ( e ) { if( e.key === "ArrowLeft" ) prev.click(); if( e.key === "ArrowRight" ) next.click(); };
        var x0 = null;
        f.canvas.addEventListener( "touchstart", function ( e ) { x0 = e.touches[ 0 ].clientX; }, { passive: true } );
        f.canvas.addEventListener( "touchend", function ( e )
        {
            if( x0 == null ) return;
            var dx = e.changedTouches[ 0 ].clientX - x0;
            x0 = null;
            if( dx > 50 ) prev.click(); else if( dx < -50 ) next.click();
        } );
        show();
    };

    // ---------------------------------------------------------------------
    // the owner: keep a photo in their Photos folder, edit it there
    // ---------------------------------------------------------------------

    // The Photos app's own folder - asked once, the same question Photos
    // asks, and saved for both.
    function photosFolder()
    {
        return NayiveUI.launcherFolder( { app: "photos", allowRoot: true, noRedirect: true,
                                          title: T( "photos.whereFolder" ), note: T( "photos.whereFolderNote" ),
                                          rootLabel: T( "ui.fp.allFiles" ) } );
    }

    // Copiar: the photo is also put in the owner's Photos folder. Resolves
    // where it is in their files now ("files/..."), or null. quiet: no
    // "copied" toast (Editar says what happened itself).
    C.keepPhoto = async function ( m, quiet )
    {
        if( ! m || m.id <= 0 ) return null;
        var conv = S.open;
        var dir = "";
        if( ! m.kept )
        {
            dir = await photosFolder();
            if( ! dir || S.open !== conv ) return null;
        }
        function take( msg )
        {
            if( S.open !== conv || ! msg ) return;
            var cur = S.msgs.get( m.id );
            if( cur && cur._v ) msg._v = cur._v;
            S.msgs.set( msg.id, msg );
            C.redraw( msg.id );
        }
        try
        {
            var out = await C.api( "POST", "conv/" + conv + "/messages/" + m.id + "/keep", { dir: dir } );
            take( out.msg );
            if( ! quiet ) NayiveUI.toast( C.TF( "chat.kept", { path: shortPath( out.path ) } ), { ms: 3500 } );
            return out.path;
        }
        catch( e )
        {
            // Kept once, but no longer in their files (binned, deleted): the
            // chat still has it - it is copied again, to the Photos folder.
            if( e.status === 410 && e.body && e.body.msg && ! e.body.msg.kept && m.kept )
            {
                take( e.body.msg );
                return C.keepPhoto( e.body.msg, quiet );
            }
            C.fail( e );
            return null;
        }
    };

    // "Abrir en Fotos": the Photos app at that photo's folder, the photo open
    // (?photo=), in a tab of its own - the chat stays where it was.
    C.openInPhotos = async function ( m )
    {
        if( ! m || ! m.kept ) return;
        // The tab opens NOW, while the tap still counts (a browser blocks a
        // window opened after a wait); it is sent to the photo once known.
        var tab = window.open( "about:blank", "_blank" );
        var path = await C.keepPhoto( m, true );                            // kept: just says where
        if( ! path ) { if( tab ) tab.close(); return; }
        var url = "../photos/index.html?dir=" + encodeURIComponent( path.slice( 0, path.lastIndexOf( "/" ) ) ) +
                  "&photo=" + encodeURIComponent( path );
        if( tab ) tab.location.href = new URL( url, location.href ).href;
        else location.href = url;
    };

    function shortPath( p ) { return String( p || "" ).replace( /^files\/?/, "" ) || T( "ui.filesRoot" ); }

    // A NEW file beside `path` holding `bytes`: "<name>-editado.jpg" (the
    // word in the user's language), "(2)" and on when taken. Never over a
    // file - not even one another device saved there a moment ago: the
    // server refuses a taken name (412) and the next one is tried. Resolves
    // its path.
    async function saveBeside( path, bytes )
    {
        var dir  = path.slice( 0, path.lastIndexOf( "/" ) );
        var stem = path.slice( dir.length + 1 ).replace( /\.[^.]*$/, "" ) + "-" + T( "ui.editedSuffix" );
        for( var i = 1; i < 1000; i++ )
        {
            var name = dir + "/" + stem + ( i > 1 ? " (" + i + ")" : "" ) + ".jpg";
            try { await GumApi.createFileBytes( name, bytes ); return name; }
            catch( e ) { if( e.status !== 412 ) throw e; }
        }
        throw new Error( T( "chat.failed" ) );
    }

    // Editar foto (TOAST UI Image Editor, as Drive and Photos: shared/photo.js
    // loads and builds it). The photo is kept first, so it is safe in the
    // owner's files. The edit NEVER goes over it (it may be the camera
    // original of their library): both saves write a new file beside it. The
    // bar: save (the chat shows the edit, to everybody), save a copy (the
    // chat does not change), close. onSaved: the caller redraws (the
    // full-screen viewer).
    C.editPhoto = async function ( m, onSaved )
    {
        if( ! m || m.id <= 0 || document.querySelector( ".photo-editor" ) ) return;
        var conv = S.open;
        var path = await C.keepPhoto( m, true );
        if( ! path || S.open !== conv ) return;

        var saveB  = h( "button", { class: "editor-btn", attrs: { type: "button", title: T( "ui.save" ), "aria-label": T( "ui.save" ) } }, C.ic( "check" ) );
        var copyB  = h( "button", { class: "editor-btn", attrs: { type: "button", title: T( "chat.saveCopy" ), "aria-label": T( "chat.saveCopy" ) },
                                    html: NayiveUI.icon( "saveas" ) } );
        var closeB = h( "button", { class: "editor-btn", attrs: { type: "button", title: T( "ui.close" ), "aria-label": T( "ui.close" ) } }, C.ic( "x" ) );
        var host   = h( "div", { class: "editor-canvas" } );
        var layer  = h( "div", { class: "editor-backdrop open photo-editor", attrs: { role: "dialog", "aria-modal": "true", "aria-label": T( "chat.editPhoto" ) } },
            h( "div", { class: "editor-bar" }, h( "span", { class: "editor-title", text: shortPath( path ) } ),
                h( "span", { class: "editor-actions" }, saveB, copyB, closeB ) ),
            host );
        document.body.appendChild( layer );

        var editor = null, dirty = false, busy = false;
        function shut()
        {
            if( editor ) { try { editor.destroy(); } catch( _ ) {} editor = null; }
            layer.remove();
            document.removeEventListener( "keydown", key, true );
        }
        // The phone's Back with unsaved changes: stay, and ask.
        function navClose() { if( dirty && editor ) { C.pushNav( "photo-editor", navClose ); leave(); } else shut(); }
        async function leave()
        {
            if( busy ) return;
            if( dirty && ! await NayiveUI.confirm( { title: T( "chat.unsavedTitle" ), body: T( "chat.unsavedBody" ),
                                                     confirm: T( "chat.closeWithout" ), danger: true } ) ) return;
            C.popNav( "photo-editor" );
            shut();
        }
        function key( e )
        {
            if( e.key !== "Escape" ) return;
            // A sheet asked from here (close without saving?) answers its own.
            for( var el = layer.nextElementSibling; el; el = el.nextElementSibling )
                if( el.matches( ".sheet-backdrop.open" ) ) return;
            e.preventDefault();
            e.stopPropagation();
            leave();
        }
        document.addEventListener( "keydown", key, true );
        C.pushNav( "photo-editor", navClose );
        closeB.addEventListener( "click", leave );

        try { await NayivePhoto.loadEditor(); }
        catch( _ ) { C.popNav( "photo-editor" ); shut(); C.toast( "chat.editorFailed", 3500 ); return; }
        if( ! layer.isConnected ) return;          // closed while the library loaded

        editor = NayivePhoto.newEditor( host, GumApi.fileUrl( path ) + "&v=" + Date.now(), path.split( "/" ).pop() );
        editor.on( "undoStackChanged", function ( n ) { dirty = n > 0; } );

        function pixels()
        {
            try { return NayivePhoto.dataUrlBytes( editor.toDataURL( { format: "jpeg", quality: 0.92 } ) ); }
            catch( _ ) { C.toast( "chat.failed", 3000 ); return null; }
        }
        // The photo's own Exif (its date) put back into the export.
        function withExif( bytes )
        {
            var sz = editor.getCanvasSize();
            return NayivePhoto.keepExif( path, bytes, sz.width, sz.height );
        }

        // ✓: the edit as a new file beside the photo, then the message shows
        // it (the server points it there); the photo itself is not touched.
        saveB.addEventListener( "click", async function ()
        {
            if( busy || ! editor ) return;
            if( ! dirty ) { leave(); return; }
            var bytes = pixels();
            if( ! bytes ) return;
            var sz = editor.getCanvasSize();
            busy = true;
            var made = null;
            try
            {
                bytes = await withExif( bytes );
                made = await saveBeside( path, bytes );
                var out = await C.api( "POST", "conv/" + conv + "/messages/" + m.id + "/edited",
                                       { ref: made, w: Math.round( sz.width ), h: Math.round( sz.height ) } );
                dirty = false;
                busy = false;
                if( out && out.msg && S.open === conv ) { out.msg._v = Date.now(); S.msgs.set( out.msg.id, out.msg ); C.redraw( out.msg.id ); }
                leave();
                if( onSaved ) onSaved();
                NayiveUI.toast( C.TF( "chat.photoSaved", { path: shortPath( made ) } ), { ms: 3500 } );
            }
            catch( e )
            {
                busy = false;
                // Saved, but the chat could not be pointed at it: it is a copy
                // beside the photo, and is said so (the edit is not lost).
                if( made ) { dirty = false; leave(); NayiveUI.toast( C.TF( "chat.copySaved", { path: shortPath( made ) } ), { ms: 6000 } ); }
                else C.fail( e );
            }
        } );

        // A copy beside the photo; the chat does not change.
        copyB.addEventListener( "click", async function ()
        {
            if( busy || ! editor ) return;
            var bytes = pixels();
            if( ! bytes ) return;
            busy = true;
            try
            {
                bytes = await withExif( bytes );
                var copy = await saveBeside( path, bytes );
                dirty = false;
                busy = false;
                leave();
                NayiveUI.toast( C.TF( "chat.copySaved", { path: shortPath( copy ) } ), { ms: 3500 } );
            }
            catch( e ) { busy = false; C.fail( e ); }
        } );
    };

    // The map app of this device, for "open in maps".
    function mapsUrl( l )
    {
        var ua = navigator.userAgent;
        if( /iphone|ipad|ipod|macintosh/i.test( ua ) && "ontouchend" in document )
            return "https://maps.apple.com/?q=" + l.lat + "," + l.lon;
        if( /android/i.test( ua ) ) return "geo:" + l.lat + "," + l.lon + "?q=" + l.lat + "," + l.lon;
        return "https://www.openstreetmap.org/?mlat=" + l.lat + "&mlon=" + l.lon + "#map=17/" + l.lat + "/" + l.lon;
    }

    // Leaflet with Nayive's base map (vector when it can, OSM pictures if not).
    function bigMap( host, lat, lon, zoom )
    {
        var map = L.map( host, { zoomControl: true, attributionControl: true } );
        map.attributionControl.setPrefix( false );
        map.setView( [ lat, lon ], zoom );
        if( window.NayiveBaseMap ) NayiveBaseMap.add( map );
        else L.tileLayer( OSM, { maxZoom: 19, attribution: OSM_ATTR, referrerPolicy: "strict-origin-when-cross-origin" } ).addTo( map );
        setTimeout( function () { map.invalidateSize(); }, 60 );
        return map;
    }

    function pinIcon()
    {
        return L.divIcon( { className: "", iconSize: [ 30, 30 ], iconAnchor: [ 15, 30 ],
                            html: '<span class="mini-pin" style="position:static;transform:none;display:block"><svg viewBox="0 0 24 24"><path d="M12 2C8 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3-7-7-7z"/><circle cx="12" cy="9" r="2.6" fill="white" stroke="none"/></svg></span>' } );
    }

    C.openMap = function ( l )
    {
        if( ! window.L ) { location.href = mapsUrl( l ); return; }
        var open = h( "a", { class: "editor-btn", attrs: { href: mapsUrl( l ), target: "_blank", rel: "noopener noreferrer",
                                                           title: T( "chat.openMaps" ), "aria-label": T( "chat.openMaps" ) } } );
        open.appendChild( C.ic( "external" ) );
        var f = fullLayer( l.place || T( "chat.location" ), open );
        var host = h( "div", { class: "map-host" } );
        f.canvas.appendChild( host );
        var map = bigMap( host, l.lat, l.lon, 16 );
        L.marker( [ l.lat, l.lon ], { icon: pinIcon() } ).addTo( map );
        f.layer._onClose = function () { map.remove(); };
    };

    // ---------------------------------------------------------------------
    // sending where I am
    // ---------------------------------------------------------------------

    C.openLocationPicker = function ()
    {
        if( ! navigator.geolocation ) { C.toast( "chat.noGeo", 3000 ); return; }
        var conv = S.open;
        var sendRow = h( "button", { class: "row", attrs: { type: "button", disabled: true } },
            h( "span", { class: "ring" }, C.ic( "pin-map" ) ),
            h( "div", { class: "body" }, h( "span", { class: "name", text: T( "chat.sendHere" ) } ),
                h( "span", { class: "state", text: T( "chat.locating" ) } ) ) );
        var liveRow = h( "button", { class: "row", attrs: { type: "button", disabled: true } },
            h( "span", { class: "ring", style: "background:var(--text-faint)" }, C.ic( "live" ) ),
            h( "div", { class: "body" }, h( "span", { class: "name", text: T( "chat.liveLoc" ) } ),
                h( "span", { class: "state", text: T( "chat.later" ) } ) ) );
        var host = h( "div", { class: "map-host" } );
        var meBtn = h( "button", { class: "me-btn", attrs: { type: "button", title: T( "chat.myPlace" ), "aria-label": T( "chat.myPlace" ) } } );
        meBtn.appendChild( C.ic( "nav" ) );
        var layer = h( "div", { class: "picker" },
            h( "div", { class: "bar" }, C.btn( "back", "chat.back", function () { C.back(); } ),
                h( "div", { class: "who" }, h( "b", { text: T( "chat.sendLocation" ) } ) ) ),
            h( "div", { class: "map-box" }, host, meBtn ),
            h( "div", { class: "foot" }, sendRow, liveRow ) );
        document.body.appendChild( layer );

        var map = null, dot = null, ring = null, fix = null, watch = null;
        if( window.L ) map = bigMap( host, 40.4, -3.7, 5 );

        function close()
        {
            if( watch != null ) navigator.geolocation.clearWatch( watch );
            if( map ) map.remove();
            layer.remove();
        }
        C.pushNav( "picker", close );

        function onFix( p )
        {
            fix = p.coords;
            sendRow.disabled = false;
            C.$( ".state", sendRow ).textContent = C.TF( "chat.accuracy", { m: Math.round( fix.accuracy ) } );
            if( ! map ) return;
            var ll = [ fix.latitude, fix.longitude ];
            if( ! dot )
            {
                // Leaflet writes SVG attributes, where var() does not work: the live token
                var blue = getComputedStyle( document.documentElement ).getPropertyValue( "--link" ).trim() || "#5B9DF9";
                ring = L.circle( ll, { radius: fix.accuracy, weight: 1, color: blue, fillOpacity: 0.12 } ).addTo( map );
                dot  = L.circleMarker( ll, { radius: 8, weight: 3, color: "white", fillColor: blue, fillOpacity: 1 } ).addTo( map );
                map.setView( ll, 16 );
            }
            else { dot.setLatLng( ll ); ring.setLatLng( ll ).setRadius( fix.accuracy ); }
        }
        watch = navigator.geolocation.watchPosition( onFix, function ()
        {
            C.$( ".state", sendRow ).textContent = T( "chat.noGeo" );
        }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 } );
        meBtn.addEventListener( "click", function () { if( fix && map ) map.setView( [ fix.latitude, fix.longitude ], 16 ); } );

        sendRow.addEventListener( "click", async function ()
        {
            if( ! fix ) return;
            var f = { lat: fix.latitude, lon: fix.longitude, acc: fix.accuracy };
            C.popNav( "picker" );
            close();
            var place = "";
            try { place = await NayiveUI.townName( f.lat, f.lon ); } catch( _ ) {}
            C.sendMsg( { kind: "loc", loc: { lat: f.lat, lon: f.lon, acc: f.acc, place: place } }, conv );
        } );
    };

    // ---------------------------------------------------------------------
    // a contact card
    // ---------------------------------------------------------------------

    // The owner's own address book (the Contacts app), read once - again
    // after C.forgetBook() (a card's picture changed from here). Every card
    // with a name: {name, tels, emails, uid, photo} - photo a data: URL or "".
    var book = null;
    C.ownerBook = async function ()
    {
        if( book ) return book;
        book = [];
        try
        {
            var text = await GumApi.readFile( "data/contacts.vcf" );
            book = parseVcf( text );
        }
        catch( _ ) {}
        return book;
    };
    C.forgetBook = function () { book = null; };

    // Read as Contacts reads it (shared/vcard.js): folds, QUOTED-PRINTABLE
    // names from an Android export, escapes; a PHOTO in its 3.0, 2.1 or 4.0
    // form (a link to the web: ""). A name keeps to one line.
    function parseVcf( text )
    {
        var V = NayiveVCard, out = [];
        V.read( text ).forEach( function ( props )
        {
            var cur = { name: "", tels: [], emails: [], uid: "", photo: "" };
            props.forEach( function ( p )
            {
                var val = V.unescapeText( p.value ).replace( /\n/g, " " ).trim();
                if( p.name === "FN" ) cur.name = val;
                else if( p.name === "TEL" && val ) cur.tels.push( val );
                else if( p.name === "EMAIL" && val ) cur.emails.push( val );
                else if( p.name === "UID" ) cur.uid = val;
                else if( p.name === "PHOTO" && ! cur.photo ) cur.photo = V.photoOf( p.value, p.params );
            } );
            if( cur.name ) out.push( cur );
        } );
        return out.sort( function ( a, b ) { return a.name.localeCompare( b.name ); } );
    }

    // The server's own rules for a card and a poll (api_chat.go checkSend),
    // kept here too: one thing it would refuse costs the whole message, so
    // it is left out before sending instead.
    //
    // oneLine is the server's cleanOneLine: every run of blanks and control
    // characters becomes one space, and the text is cut at `max` characters.
    function oneLine( s, max )
    {
        var t = String( s || "" ).split( /[\s\p{Cc}]+/u ).filter( Boolean ).join( " " );
        return Array.from( t ).slice( 0, max ).join( "" ).trim();
    }

    // A phone is digits and + - ( ) . and blanks, up to 40; an address has an
    // "@", no blank, < > or ", and up to 120 bytes; at most six of each.
    function cardFit( card )
    {
        var bytes = function ( t ) { return new TextEncoder().encode( t ).length; };
        var trim  = function ( t ) { return String( t || "" ).trim(); };
        return {
            name:   oneLine( card.name, 60 ),
            tels:   ( card.tels || [] ).map( trim ).filter( function ( t ) { return t && t.length <= 40 && /^[0-9+\-(). ]+$/.test( t ); } ).slice( 0, 6 ),
            emails: ( card.emails || [] ).map( trim ).filter( function ( e ) { return e && bytes( e ) <= 120 && e.indexOf( "@" ) >= 0 && ! /[ <>"]/.test( e ); } ).slice( 0, 6 )
        };
    }

    C.openCardSheet = function ()
    {
        var conv = S.open;
        var name = h( "input", { attrs: { type: "text", id: "ccName", maxlength: "60" } } );
        var tel  = h( "input", { attrs: { type: "tel", id: "ccTel", maxlength: "40" } } );
        var body = h( "div", {},
            h( "div", { class: "field" }, h( "label", { attrs: { for: "ccName" }, text: T( "chat.name" ) } ), name ),
            h( "div", { class: "field" }, h( "label", { attrs: { for: "ccTel" }, text: T( "chat.phone" ) } ), tel ) );
        var go = h( "button", { attrs: { type: "button", "data-act": "primary:send", title: T( "chat.sendMsg" ) } } );
        var sh = null;

        function send( card )
        {
            card = cardFit( card );
            if( ! card.name || ! ( card.tels.length || card.emails.length ) ) { C.toast( "chat.cardNeeds", 2600 ); return; }
            if( sh ) sh.close();
            C.sendMsg( { kind: "card", card: card }, conv );
        }
        go.addEventListener( "click", function ()
        {
            send( { name: name.value.trim(), tels: tel.value.trim() ? [ tel.value.trim() ] : [] } );
        } );

        // Where to pick from: the owner's Contacts app, or the phone's own
        // contacts (Android's picker - a browser on iPhone has none).
        if( S.mode === "owner" )
        {
            var search = h( "input", { attrs: { type: "search", placeholder: T( "chat.searchContacts" ) } } );
            var list = h( "div", { class: "rows", style: "max-height:40vh;padding-bottom:0" } );
            body.insertBefore( h( "div", { class: "section-label", text: T( "chat.fromContacts" ) } ), body.firstChild );
            body.insertBefore( h( "div", { class: "field" }, search ), body.children[ 1 ] );
            body.insertBefore( list, body.children[ 2 ] );
            body.insertBefore( h( "div", { class: "section-label", style: "margin-top:12px", text: T( "chat.orWrite" ) } ), body.children[ 3 ] );
            var draw = function ( all )
            {
                var q = C.fold( search.value );
                list.textContent = "";
                var shown = all.filter( function ( c ) { return ( c.tels.length || c.emails.length ) && ( ! q || C.fold( c.name ).indexOf( q ) >= 0 ); } ).slice( 0, 80 );
                if( ! shown.length ) list.appendChild( h( "p", { class: "hint", style: "margin:6px 0", text: T( all.length ? "chat.noMatch" : "chat.noContacts" ) } ) );
                shown.forEach( function ( c )
                {
                    list.appendChild( h( "button", { class: "row", attrs: { type: "button" }, on: { click: function () { send( { name: c.name, tels: c.tels, emails: c.emails } ); } } },
                        C.cardAvatar( c, "sm" ),
                        h( "div", { class: "body" }, h( "span", { class: "name", text: c.name } ),
                            h( "span", { class: "state", text: c.tels[ 0 ] || c.emails[ 0 ] } ) ) ) );
                } );
            };
            C.ownerBook().then( function ( all ) { draw( all ); search.addEventListener( "input", function () { draw( all ); } ); } );
        }
        else if( navigator.contacts && navigator.contacts.select )
        {
            var pick = h( "button", { class: "text-btn ghost wide", attrs: { type: "button" }, text: T( "chat.fromPhone" ),
                on: { click: async function ()
                {
                    try
                    {
                        var got = await navigator.contacts.select( [ "name", "tel", "email" ], { multiple: false } );
                        if( got && got[ 0 ] )
                            send( { name: ( got[ 0 ].name || [] )[ 0 ] || "", tels: got[ 0 ].tel || [], emails: got[ 0 ].email || [] } );
                    }
                    catch( _ ) {}
                } } } );
            body.insertBefore( pick, body.firstChild );
            body.insertBefore( h( "div", { class: "section-label", style: "margin-top:12px", text: T( "chat.orWrite" ) } ), body.children[ 1 ] );
        }
        sh = C.sheet( T( "chat.sendContact" ), body, go );
    };

    // ---------------------------------------------------------------------
    // a poll
    // ---------------------------------------------------------------------

    C.openPollSheet = function ()
    {
        var conv = S.open;
        var q = h( "input", { attrs: { type: "text", id: "pollQ", maxlength: "300" } } );
        var opts = h( "div" );
        var multi = h( "input", { attrs: { type: "checkbox", id: "pollMulti" } } );
        multi.checked = true;
        function addOpt( focus )
        {
            if( opts.children.length >= 12 ) return;
            var inp = h( "input", { attrs: { type: "text", maxlength: "100", placeholder: C.TF( "chat.optionN", { n: opts.children.length + 1 } ) } } );
            var rm = C.btn( "x", "chat.remove", function () { if( opts.children.length > 2 ) row.remove(); }, "sm" );
            var row = h( "div", { class: "opt-row" }, inp, rm );
            opts.appendChild( row );
            if( focus ) inp.focus();
        }
        addOpt(); addOpt();
        var body = h( "div", {},
            h( "div", { class: "field" }, h( "label", { attrs: { for: "pollQ" }, text: T( "chat.question" ) } ), q ),
            h( "div", { class: "section-label", text: T( "chat.options" ) } ),
            opts,
            h( "button", { class: "text-btn dashed", attrs: { type: "button" }, text: T( "chat.addOption" ), on: { click: function () { addOpt( true ); } } } ),
            h( "label", { class: "scm-check", style: "display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:14px;cursor:pointer" },
               T( "chat.pollMultiLabel" ), h( "span", { class: "switch sm" }, multi, h( "span", { class: "track" } ) ) ) );
        var go = h( "button", { attrs: { type: "button", "data-act": "primary:send", title: T( "chat.sendMsg" ) } } );
        var sh = C.sheet( T( "chat.newPoll" ), body, go );
        go.addEventListener( "click", function ()
        {
            // Two options the server would read as the same one (see oneLine:
            // it keeps 60 characters of each) are one option here as well.
            var seen = [];
            var list = Array.prototype.map.call( opts.querySelectorAll( "input" ), function ( i ) { return oneLine( i.value, 100 ); } )
                                      .filter( function ( v )
                                      {
                                          var k = oneLine( v, 60 );
                                          if( ! k || seen.indexOf( k ) >= 0 ) return false;
                                          seen.push( k );
                                          return true;
                                      } );
            if( ! q.value.trim() || list.length < 2 ) { C.toast( "chat.pollNeeds", 2600 ); return; }
            sh.close();
            C.sendMsg( { kind: "poll", poll: { q: q.value.trim(), opts: list, multi: multi.checked } }, conv );
        } );
        setTimeout( function () { q.focus(); }, 50 );
    };
} )();
