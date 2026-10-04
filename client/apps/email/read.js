// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * read.js - one message: its header, its attachments and its body.
 *
 * THE BODY FRAME. HTML mail is drawn in an <iframe sandbox="allow-scripts
 * allow-popups allow-popups-to-escape-sandbox"> - WITHOUT allow-same-origin,
 * so the frame is an origin of its own: nothing it loads carries Nayive's
 * session cookie (a picture pointing at one of our URLs is a stranger's
 * request, signed in as nobody), and it cannot touch this page. The one
 * script in it is ours, let in by a nonce (the frame's CSP runs no other): it
 * tells this page the frame's height, and opens links in a new tab.
 *
 * THE HEAD: the subject, a chevron, the labels. From, To and Date fold away
 * under it (closed each time a message opens); the subject or the chevron
 * shows them.
 *
 * PICTURES. This message's own (cid:) come in as data: urls, fetched here
 * with the session. The internet's only after the head's "Show pictures" button
 * (they tell a sender the message was opened); it hides them again too.
 * The server has already cut scripts, handlers and forms out (mail_mime.go);
 * cleanMessage below drops the rest, and every url that is not http(s),
 * mailto, tel, #, a data: picture or this message's own attachment.
 *
 * Links open in a new tab, and only http(s), mailto and tel ones.
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S, h = E.h;

    E.openMessage = async function ( m )
    {
        S.open = m;
        S.openScroll = E.$( "listView" ).parentNode.scrollTop;
        S.showImages = false;
        setReading( true );
        if( ! E.split ) try { history.pushState( { mailRead: 1 }, "" ); } catch( e ) {}

        // what the row already knows, at once
        E.$( "readSubject" ).textContent = m.subject || E.T( "mail.noSubject" );
        E.renderReadLabels( m.labels );
        renderMeta( m );
        showMeta( false );
        E.$( "readParts" ).hidden = true;
        E.$( "imagesBtn" ).hidden = true;
        E.$( "readBody" ).textContent = "";
        E.$( "readBody" ).appendChild( h( "p", { class: "mail-more", text: E.T( "mail.loading" ) } ) );
        E.$( "readView" ).parentNode.scrollTop = 0;

        var acct = E.acctOf( m );
        E.syncBar();
        E.plug( "loading" );
        try
        {
            // ?mid: a label's row may point where the message USED to be
            var msg = await E.api( "GET", encodeURIComponent( acct ) + "/msg/" + encodeURIComponent( m.ref ) +
                                          "?mid=" + encodeURIComponent( m.mid || "" ) );
            if( S.open !== m ) return;
            E.plug( "synced" );
            msg.acct = acct;
            S.msg = msg;
            m.ref = msg.ref;                 // found elsewhere: the row follows
            m.flagged = msg.flagged;
            m.labels = msg.labels;
            E.markRowSeen( m );
            E.renderReadLabels( msg.labels );
            renderMeta( msg );
            renderParts( msg, acct );
            renderBody( msg );
            E.syncBar();
        }
        catch( err )
        {
            if( S.open !== m ) return;
            E.plug( err.code === "gone" || err.code === "elsewhere" ? "synced" : "offline" );
            E.$( "readBody" ).textContent = "";
            E.$( "readBody" ).appendChild( h( "p", { class: "mail-problem", text: E.errText( err ) } ) );
            // a label's row whose message is nowhere any more: the server
            // dropped its tag, the row goes too
            if( err.code === "gone" && S.label ) E.dropRows( [ m ] );
        }
    };

    // back to the list, where it was. fromCode: not the browser's Back.
    E.closeMessage = function ( fromCode )
    {
        if( ! S.open ) return;
        S.open = null;
        S.msg = null;
        setReading( false );
        E.$( "readBody" ).textContent = "";
        if( ! E.split ) E.$( "listView" ).parentNode.scrollTop = S.openScroll || 0;
        if( fromCode ) { try { if( history.state && history.state.mailRead ) history.back(); } catch( e ) {} }
        E.syncBar();
    };

    // The open message's labels, under its subject.
    E.renderReadLabels = function ( ids )
    {
        var box = E.$( "readLabels" );
        box.textContent = "";
        box.appendChild( E.chips( ids ) );
        box.hidden = ! box.childNodes.length;
    };

    // From, To, Date: shown or folded away (on: true / false; none: the other)
    function showMeta( on )
    {
        var box = E.$( "readMeta" );
        if( on === undefined ) on = box.hidden;
        box.hidden = ! on;
        E.$( "metaBtn" ).classList.toggle( "open", on );
        E.$( "metaBtn" ).setAttribute( "aria-expanded", on ? "true" : "false" );
    }
    E.toggleMeta = function () { showMeta(); };

    // full: the message over the list (a phone, a narrow window); split: beside it
    function setReading( on )
    {
        var full = on && ! E.split;
        document.body.classList.toggle( "reading", full );
        E.$( "backBtn" ).hidden = ! full;
        E.$( "listView" ).hidden = full;
        E.$( "readView" ).hidden = ! on;
        E.$( "readNone" ).hidden = on;
        if( ! on ) E.$( "imagesBtn" ).hidden = true;
        E.markCurrent();
    }

    // ---------------------------------------------------------------------
    // SPLIT: in a desktop window wide enough the message shows on the right
    // of the list, not over it. #readView moves into #readPane (and back into
    // .mail-main when the window narrows); the list keeps its tools, and the
    // open message's row is marked. No history entry and no ←: nothing to go
    // back to. E.listShown(): the list is on screen (refresh, next page...).
    // ---------------------------------------------------------------------

    var wide = window.matchMedia( "(min-width: 1080px)" );
    E.split = false;
    E.listShown = function () { return ! S.open || E.split; };

    // the open message's row, marked (split only)
    E.markCurrent = function ()
    {
        document.querySelectorAll( ".mail-row.is-current" ).forEach( function ( r ) { r.classList.remove( "is-current" ); } );
        if( E.split && S.open && S.open._row ) S.open._row.classList.add( "is-current" );
    };

    // the pane and its handle: split, with an account to read
    E.showPane = function ()
    {
        var on = E.split && S.accounts.length > 0;
        document.body.classList.toggle( "split", on );
        E.$( "readRz" ).hidden = ! on;
        E.$( "readPane" ).hidden = ! on;
    };

    function syncSplit()
    {
        var on = !! NayiveUI.windowed && wide.matches;
        if( on === E.split ) return;
        E.split = on;
        var view = E.$( "readView" );
        if( on ) E.$( "readPane" ).appendChild( view );
        else E.$( "composeView" ).parentNode.insertBefore( view, E.$( "composeView" ) );
        E.showPane();
        if( S.open ) { setReading( true ); E.syncBar(); }
    }

    NayiveUI.paneResizer( E.$( "readRz" ), E.$( "composeView" ).parentNode, {
        key: "email-list-width", min: 280, max: 700, def: 380,
        off: function () { return ! E.split; },
        set: function ( w ) { document.documentElement.style.setProperty( "--mail-list-w", w + "px" ); } } );
    syncSplit();
    // the desktop resizes this window's frame: each resize asks again
    window.addEventListener( "resize", syncSplit );

    function renderMeta( m )
    {
        var dl = h( "dl", { class: "mail-meta" } );
        function line( key, value )
        {
            if( ! value ) return;
            dl.appendChild( h( "dt", { text: E.T( key ) } ) );
            dl.appendChild( h( "dd", { text: value } ) );
        }
        line( "mail.from", E.whoFull( m.from ) || E.T( "mail.noSender" ) );
        line( "mail.to", E.whoFull( m.to ) );
        line( "mail.cc", E.whoFull( m.cc ) );
        line( "mail.date", E.longDate( m.date ) );
        var box = E.$( "readMeta" );
        box.textContent = "";
        box.appendChild( dl );
    }

    // Each file: a tap downloads it; its arrow keeps it in Nayive (a folder
    // picked there). The size is the file's own (the server's estimate).
    function renderParts( msg, acct )
    {
        var box = E.$( "readParts" );
        box.textContent = "";
        var files = ( msg.parts || [] ).filter( function ( p ) { return ! p.inline; } );
        files.forEach( function ( p )
        {
            var url = "/api/mail/" + encodeURIComponent( acct ) + "/att/" + encodeURIComponent( msg.ref ) + "/" + encodeURIComponent( p.id );
            var save = h( "button", { class: "icon-btn sm", html: E.icon( "save" ),
                                      attrs: { type: "button", title: E.T( "mail.saveToDrive" ) + ": " + p.name, "aria-label": E.T( "mail.saveToDrive" ) },
                                      on: { click: function () { saveToDrive( p, url, save ); } } } );
            box.appendChild( h( "span", { class: "mail-part-line" },
                                h( "a", { class: "mail-part", html: E.icon( "file" ),
                                          attrs: { href: url, download: p.name, title: E.T( "mail.download" ) + ": " + p.name } },
                                   h( "span", { text: p.name } ),
                                   p.size ? h( "small", { text: NayiveUI.fmtBytes( p.size ) } ) : null ),
                                save ) );
        } );
        box.hidden = ! files.length;
    }

    // A name Drive can take, and one not already in that folder: "f.pdf",
    // then "f (2).pdf"... A listing that fails stops the save (D5, mail-chat
    // #9): read as "folder empty", it sent "factura.pdf" over last month's.
    // A 404 is a folder that is not there (any more): it holds no names.
    // `also`: names found taken since (a 412 in saveToDrive).
    function fileName( name )
    {
        name = String( name || "" ).replace( /[\\/\u0000-\u001f]/g, "_" ).trim().replace( /^\.+/, "" );
        return name || "file";
    }
    async function freeName( dir, name, also )
    {
        var taken = {};
        try
        {
            ( ( await GumApi.listDir( dir ) ).nodes || [] ).forEach( function ( n )
            {
                taken[ String( n.name || String( n.path || "" ).split( "/" ).pop() ).toLowerCase() ] = true;
            } );
        }
        catch( e ) { if( ! e || e.status !== 404 ) throw e; }
        ( also || [] ).forEach( function ( n ) { taken[ n.toLowerCase() ] = true; } );
        if( ! taken[ name.toLowerCase() ] ) return name;
        var dot = name.lastIndexOf( "." ), stem = dot > 0 ? name.slice( 0, dot ) : name, ext = dot > 0 ? name.slice( dot ) : "";
        for( var i = 2; ; i++ )
        {
            var n = stem + " (" + i + ")" + ext;
            if( ! taken[ n.toLowerCase() ] ) return n;
        }
    }

    // The attachment goes up as a NEW file only (create-only PUT): a name
    // another device took after the listing answers 412 and the next free one
    // is used, never written over. (A 412 that is this very save's first try,
    // landed before a dropped connection made the PUT go again, is a success
    // already: GumApi's "our own first try".) 50 names in a row taken: an error.
    async function saveNew( dir, want, bytes )
    {
        var also = [];
        for( var tries = 0; ; tries++ )
        {
            var name = await freeName( dir, want, also );
            try { await GumApi.createFileBytes( dir + "/" + name, bytes ); return name; }
            catch( e ) { if( ! e || e.status !== 412 || tries >= 50 ) throw e; }
            also.push( name );
        }
    }

    async function saveToDrive( p, url, btn )
    {
        var dir = await NayiveUI.pickFolder( { title: E.T( "mail.saveToDrive" ), allowRoot: true, rootLabel: E.T( "ui.filesFolder" ) } );
        if( ! dir ) return;
        btn.disabled = true;
        E.plug( "saving" );
        try
        {
            var res = await fetch( url, { credentials: "same-origin" } );
            if( ! res.ok ) { var e = new Error( "HTTP " + res.status ); e.status = res.status; throw e; }
            var bytes = new Uint8Array( await res.arrayBuffer() );
            await saveNew( dir, fileName( p.name ), bytes );
            E.plug( "synced" );
            NayiveUI.toast( E.TF( "mail.savedToDrive", { folder: dir.replace( /^files\/?/, "" ) || E.T( "ui.filesFolder" ) } ), { ms: 3500 } );
        }
        catch( err )
        {
            E.plug( "offline" );
            NayiveUI.toast( E.T( "ui.saveFailed" ), { ms: 3500 } );
        }
        finally { btn.disabled = false; }
    }

    var renderGen = 0;

    async function renderBody( msg )
    {
        var gen = ++renderGen;
        var box = E.$( "readBody" );
        var cut = msg.cut ? h( "p", { class: "mail-cut", text: E.T( "mail.cut" ) } ) : null;
        if( ! msg.html )
        {
            box.textContent = "";
            if( cut ) box.appendChild( cut );
            box.appendChild( plainText( msg.text || "" ) );
            return;
        }
        var doc = cleanMessage( msg.html, msg.acct );
        var remote = hasRemote( doc, msg.acct );
        imagesButton( remote );
        await ownPictures( doc, msg.acct );
        if( gen !== renderGen || S.msg !== msg ) return;
        box.textContent = "";
        if( cut ) box.appendChild( cut );
        box.appendChild( frame( doc, S.showImages ) );
    }

    // The head's picture button: this message's pictures shown or hidden
    // (every message opens with them hidden).
    E.showImages = function ()
    {
        if( ! S.msg ) return;
        S.showImages = ! S.showImages;
        renderBody( S.msg );
    };
    function imagesButton( remote )
    {
        var b = E.$( "imagesBtn" ), word = E.T( S.showImages ? "mail.hideImages" : "mail.showImages" );
        b.hidden = ! remote;
        b.textContent = word;
        b.setAttribute( "aria-pressed", S.showImages ? "true" : "false" );
        b.classList.toggle( "is-active", S.showImages );
    }

    // plain text, with its web addresses as links (built as nodes, never HTML)
    function plainText( text )
    {
        var pre = h( "div", { class: "mail-text" } );
        var re = /\bhttps?:\/\/[^\s<>"')\]]+/gi, last = 0, m;
        while( ( m = re.exec( text ) ) )
        {
            if( m.index > last ) pre.appendChild( document.createTextNode( text.slice( last, m.index ) ) );
            pre.appendChild( h( "a", { text: m[ 0 ], attrs: { href: m[ 0 ], target: "_blank", rel: "noopener noreferrer" } } ) );
            last = m.index + m[ 0 ].length;
        }
        pre.appendChild( document.createTextNode( text.slice( last ) ) );
        return pre;
    }

    // CLEANING. The message is parsed in an inert document (DOMParser loads
    // nothing) and every url in it - attributes, inline styles, <style>
    // sheets - that is not http(s) to ANOTHER site, data:image, mailto/tel/#,
    // or this message's own attachments, is dropped. Relative urls go too: a
    // mail has no base of its own, so they could only ever point here. (The
    // frame has no cookie anyway; this keeps it from even asking.)
    function attPrefix( acct ) { return location.origin + "/api/mail/" + encodeURIComponent( acct ) + "/att/"; }

    function cleanMessage( html, acct )
    {
        var att = attPrefix( acct );
        function ok( u )
        {
            u = ( u || "" ).trim();
            if( ! u || /^(#|mailto:|tel:|data:image\/(png|gif|jpe?g|webp);)/i.test( u ) ) return true;
            var abs;
            try { abs = new URL( u, location.href ); } catch( e ) { return false; }
            if( abs.href.indexOf( att ) === 0 ) return true;
            return ( abs.protocol === "https:" || abs.protocol === "http:" ) && abs.origin !== location.origin;
        }
        function css( text )
        {
            return String( text ).replace( /@import[^;]*;?/gi, "" )
                .replace( /url\(\s*(['"]?)(.*?)\1\s*\)/gi, function ( m, q, u ) { return ok( u ) ? m : "none"; } );
        }
        var doc = new DOMParser().parseFromString( html, "text/html" );
        doc.querySelectorAll( "script,iframe,frame,object,embed,base,link,meta,form" ).forEach( function ( el ) { el.remove(); } );
        doc.querySelectorAll( "style" ).forEach( function ( el ) { el.textContent = css( el.textContent ); } );
        doc.querySelectorAll( "*" ).forEach( function ( el )
        {
            [].slice.call( el.attributes ).forEach( function ( a )
            {
                var n = a.name.toLowerCase();
                if( n.indexOf( "on" ) === 0 ) el.removeAttribute( a.name );
                else if( n === "style" ) el.setAttribute( "style", css( a.value ) );
                else if( n === "srcset" )
                {
                    var all = a.value.split( "," ).every( function ( c ) { return ok( c.trim().split( /\s+/ )[ 0 ] ); } );
                    if( ! all ) el.removeAttribute( a.name );
                }
                else if( /^(src|href|background|poster|action|formaction|lowsrc|dynsrc|longdesc|data|xlink:href|cite|ping)$/.test( n ) &&
                         ! ok( a.value ) )
                    el.removeAttribute( a.name );
            } );
        } );
        return doc;
    }

    // Pictures from the internet left in the cleaned message: anything that
    // LOADS (not a link's href) naming http(s) or "//", in an attribute or a
    // style - escapes and image-set() included, since this looks at the text.
    function hasRemote( doc, acct )
    {
        var own = attPrefix( acct ).toLowerCase();
        var net = /(^|[^a-z0-9+.-])(https?:)?\/\/[^\s"')]/i;
        function remote( text )
        {
            text = String( text || "" ).toLowerCase().split( own ).join( "" ).replace( /\\/g, "" );
            return net.test( text );
        }
        var found = false;
        doc.querySelectorAll( "*" ).forEach( function ( el )
        {
            if( found ) return;
            var tag = el.localName;
            if( tag === "style" && remote( el.textContent ) ) { found = true; return; }
            [].forEach.call( el.attributes, function ( a )
            {
                var n = a.name.toLowerCase();
                if( ( tag === "a" || tag === "area" ) && ( n === "href" || n === "xlink:href" ) ) return;
                if( n.indexOf( "data-" ) === 0 || n === "cite" || n === "title" || n === "alt" ) return;
                if( remote( a.value ) ) found = true;
            } );
        } );
        return found;
    }

    // This message's own pictures (cid:, which the server turned into its
    // attachment urls) come in as data: urls: the frame has no session to
    // fetch them with. In src, background and style url(); a picture over
    // 8 MB, or one that fails, is left out.
    async function ownPictures( doc, acct )
    {
        var att = attPrefix( acct ), jobs = {};
        function own( v )
        {
            var abs;
            try { abs = new URL( String( v || "" ).trim(), location.href ).href; } catch( e ) { return ""; }
            return abs.indexOf( att ) === 0 ? abs : "";
        }
        doc.querySelectorAll( "img[src], [background]" ).forEach( function ( el )
        {
            [ "src", "background" ].forEach( function ( n )
            {
                var abs = own( el.getAttribute( n ) );
                if( abs ) ( jobs[ abs ] = jobs[ abs ] || [] ).push( { el: el, n: n } );
            } );
        } );
        var URLS = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
        doc.querySelectorAll( "[style], style" ).forEach( function ( el )
        {
            var text = el.localName === "style" ? el.textContent : el.getAttribute( "style" );
            ( String( text || "" ).match( URLS ) || [] ).forEach( function ( m )
            {
                var abs = own( m.replace( URLS, "$2" ) );
                if( abs ) ( jobs[ abs ] = jobs[ abs ] || [] ).push( { el: el, css: m } );
            } );
        } );
        await Promise.all( Object.keys( jobs ).map( async function ( url )
        {
            var data = "";
            try
            {
                var res = await fetch( url, { credentials: "same-origin" } );
                var blob = res.ok ? await res.blob() : null;
                if( blob && blob.size <= 8 * 1024 * 1024 && /^image\//.test( blob.type ) )
                    data = await new Promise( function ( ok )
                    {
                        var r = new FileReader();
                        r.onload = function () { ok( String( r.result ) ); };
                        r.onerror = function () { ok( "" ); };
                        r.readAsDataURL( blob );
                    } );
            }
            catch( e ) {}
            jobs[ url ].forEach( function ( j )
            {
                if( j.css )             // a style: that url() swapped (or emptied)
                {
                    var put = data ? 'url("' + data + '")' : "none";
                    if( j.el.localName === "style" ) j.el.textContent = j.el.textContent.split( j.css ).join( put );
                    else j.el.setAttribute( "style", j.el.getAttribute( "style" ).split( j.css ).join( put ) );
                }
                else if( data ) j.el.setAttribute( j.n, data );
                else j.el.removeAttribute( j.n );
            } );
        } ) );
    }

    // The frame's one script: its height to this page, and links in a new tab
    // (http, https, mailto, tel - any other does nothing; # scrolls within).
    function frameScript( id )
    {
        return '(function(){"use strict";var id=' + JSON.stringify( id ) + ';' +
            'function h(){var d=document.documentElement,b=document.body;' +
            'parent.postMessage({nayiveMail:id,h:Math.max(d.scrollHeight,b?b.scrollHeight:0)},"*");}' +
            'addEventListener("load",h);' +
            'if(window.ResizeObserver)new ResizeObserver(h).observe(document.documentElement);' +
            'document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a)return;' +
            'var raw=a.getAttribute("href")||"";' +
            'if(raw.charAt(0)==="#"){e.preventDefault();var t=raw.length>1&&(document.getElementById(raw.slice(1))||document.getElementsByName(raw.slice(1))[0]);if(t)t.scrollIntoView();return;}' +
            'if(!/^(https?:|mailto:|tel:)/i.test(a.href)){e.preventDefault();return;}' +
            'a.target="_blank";a.rel="noopener noreferrer";},true);' +
            'h();})();';
    }

    var frames = {};      // id -> the frame, for its height messages
    window.addEventListener( "message", function ( e )
    {
        var d = e.data, f = d && typeof d.nayiveMail === "string" && frames[ d.nayiveMail ];
        if( ! f || e.source !== f.contentWindow ) return;
        if( typeof d.h === "number" && isFinite( d.h ) ) f.style.height = Math.max( 60, Math.min( d.h, 200000 ) ) + "px";
    } );

    function randomId()
    {
        var b = new Uint8Array( 16 );
        crypto.getRandomValues( b );
        return Array.prototype.map.call( b, function ( x ) { return ( x + 256 ).toString( 16 ).slice( 1 ); } ).join( "" );
    }

    function frame( doc, images )
    {
        var net = images ? " https: http:" : "";
        var nonce = randomId(), id = randomId();
        var csp = "default-src 'none'; script-src 'nonce-" + nonce + "'; img-src data:" + net +
                  "; style-src 'unsafe-inline'" + net + "; font-src data:" + net +
                  "; media-src 'none'; form-action 'none'; base-uri 'none'";

        var head = doc.head;
        var style = doc.createElement( "style" );
        style.textContent = 'html,body{margin:0;background:#fff;color:#202124}' +
                            'body{padding:14px;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}' +
                            'img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}';
        head.insertBefore( style, head.firstChild );
        var ref = doc.createElement( "meta" );
        ref.setAttribute( "name", "referrer" );
        ref.setAttribute( "content", "no-referrer" );
        head.insertBefore( ref, head.firstChild );
        var policy = doc.createElement( "meta" );
        policy.setAttribute( "http-equiv", "Content-Security-Policy" );
        policy.setAttribute( "content", csp );
        head.insertBefore( policy, head.firstChild );
        var charset = doc.createElement( "meta" );
        charset.setAttribute( "charset", "utf-8" );
        head.insertBefore( charset, head.firstChild );
        var script = doc.createElement( "script" );
        script.setAttribute( "nonce", nonce );
        script.textContent = frameScript( id );
        ( doc.body || doc.documentElement ).appendChild( script );

        var f = h( "iframe", { attrs: { sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox",
                                        referrerpolicy: "no-referrer", title: E.T( "mail.bodyTitle" ) } } );
        f.style.height = "60px";
        f.srcdoc = "<!doctype html>" + doc.documentElement.outerHTML;
        // forget frames that left the page (a message closed, drawn again)
        Object.keys( frames ).forEach( function ( k ) { if( ! frames[ k ].isConnected ) delete frames[ k ]; } );
        frames[ id ] = f;
        return f;
    }
} )();
