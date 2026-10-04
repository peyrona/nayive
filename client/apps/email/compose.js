// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * compose.js - writing: a new message, a reply, reply to all, a forward, or a
 * draft opened again from the Drafts tray.
 *
 * DRAFTS. A few seconds after each change the message is saved to the
 * account's Drafts tray (POST <a>/draft): the server builds it, puts it there
 * and deletes the one it replaces. It answers the draft's place and the ids
 * its files have in it, so from then on those files travel as "keep this part
 * of the draft" instead of being uploaded again. With files, a save moves
 * them all again (the server reads them back and stores the whole message),
 * so it waits longer: a minute. Leaving (←, the phone's Back, the page going
 * to the background) saves at once; when that save fails the writer STAYS,
 * saying so - what was written is never thrown away. The bin discards, with
 * Undo: the draft is deleted only when the Undo is gone (or the page closes).
 *
 * SENDING, with Undo: the draft is saved first, then the writer closes and
 * the mail waits for its Undo ("Sending…"). It goes out when the Undo is
 * gone; Undo - or opening its draft in the Drafts tray meanwhile - brings
 * the writer back as it was. A page closed before that sends NOTHING: the
 * mail stays in Drafts. When the draft cannot be saved first (offline, a
 * change typed during that save), it is sent at once, as before, no Undo.
 * One draft goes once: a Send again of it in the next minutes (its answer
 * lost on the way) is refused by the server ("sent"); sent with no copy in
 * Sent, its draft stays and a toast says so (data-safety I5, I6).
 *
 * FILES: the clip opens Chat's panel - a document from this device, one from
 * Nayive (a Drive path - the server reads it), or pictures from the gallery -
 * and a forward carries the original's own. Device files go up with the next
 * save or the send. 25 MB in all, Gmail's limit.
 *
 * SIGNATURE (Settings, General): under a new message, and above what a reply
 * quotes or a forward carries, after the usual "-- " line. A draft opened
 * again already has it. A message holding nothing but it counts as empty.
 *
 * THE TEXT is formatted: Squire (lib/, Fastmail's editor) in #cText, with
 * a bar on top - bold, italic, underline, lists, a link, clear. What gets
 * in (a paste, a draft made elsewhere) goes through DOMPurify first, down to
 * those few tags and a link's href: no styles, no pictures. The mail goes out
 * as HTML and as plain text (plainText: lists as "- " / "1. ", a quote as
 * "> ", a link's address after its words); the server cleans the HTML again.
 * A reply quotes the original's words in a <blockquote>. A file dropped or a
 * picture pasted into the text is attached, not put in the text.
 *
 * ADDRESSES: typed freely ("Ana <ana@x.es>, bob@y.com"); the Contacts app's
 * addresses that fit the word being typed show under the field (arrows +
 * Enter, or a tap). The server checks them all before sending; a draft
 * keeps them as typed, also "juan" (msg.toRest - data-safety I1).
 *
 * NEVER LOST (data-safety I1, I4): what the writer holds is also kept on
 * this device as it is typed (THE COPY ON THIS DEVICE, below) until the
 * server has it; it comes back the next time eMail opens. Closing with
 * something not in Drafts yet asks first (THE CLOSE GUARD).
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S, h = E.h;

    var MAX = 25 * 1024 * 1024;
    var SAVE_AFTER = 4000;
    var SAVE_AFTER_FILES = 60000;   // with files, each save moves them all: less often

    var C = null;       // the message being written (null: not writing)
    var waiting = null; // the mail sent, waiting for its Undo: { mine, fields, off }
    var book = null;    // the address book, once

    function blank()
    {
        return { acct: S.acct, mid: newMid( S.acct ), draftRef: "", draftAcct: "", staleDraft: null,
                 inReplyTo: "", references: [], sig: "",
                 files: [],     // { kind: "keep"|"drive"|"up", name, size, acct?, ref?, part?, path?, file?, fid? }
                 dirty: false, typed: false, saving: null, timer: 0, again: false, sending: false,
                 lid: newLid(), // its copy on this device ("email:<lid>"), and its Web Lock
                 failed: null, warned: "" };
    }

    function newLid() { return Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 8 ); }

    // A new writer's Message-ID, made here: every save carries it (the
    // server keeps a draft's own across saves), so a copy left on this
    // device finds its draft on the server even when the first save's
    // answer never came (serverDraft). The mail SENT gets a fresh one from
    // the server (api_mail.go).
    function newMid( acct )
    {
        var a = E.account( acct ), host = a && /@([^@\s<>]+)$/.exec( a.email || "" );
        return "nayive." + newLid() + newLid() + "@" + ( host ? host[ 1 ] : "nayive.local" );
    }

    // ---------------------------------------------------------------------
    // opening
    // ---------------------------------------------------------------------

    // E.compose( { mode: "new"|"reply"|"all"|"fwd", msg } )
    E.compose = function ( opts )
    {
        opts = opts || {};
        var msg = opts.msg || null;
        // from a message on screen: this view takes its history entry (a Back
        // here would arrive late and close what was just opened)
        var fromRead = !! S.open && !! ( history.state && history.state.mailRead );     // split pushes none
        if( S.open ) E.closeMessage( false );
        E.endSelect();
        C = blank();
        if( msg ) C.acct = msg.acct || S.acct;
        var sig = String( S.settings.signature || "" ).replace( /\s+$/, "" );
        C.sig = sig.trim() ? "\n\n-- \n" + sig : "";
        var f = { to: "", cc: "", bcc: "", subject: "", html: textHTML( C.sig ) };

        if( msg && opts.mode !== "fwd" )
        {
            var own = S.accounts.map( function ( a ) { return a.email.toLowerCase(); } );
            var mine = function ( a ) { return own.indexOf( ( a.addr || "" ).toLowerCase() ) >= 0; };
            var to = ( msg.replyTo && msg.replyTo.length ? msg.replyTo : msg.from ) || [];
            if( opts.mode === "all" )
            {
                var seen = {};
                var fresh = function ( a ) { var k = ( a.addr || "" ).toLowerCase(); if( seen[ k ] || mine( a ) ) return false; seen[ k ] = true; return true; };
                var others = to.concat( msg.to || [] ).filter( fresh );
                f.to = list( others.length ? others : to );
                f.cc = list( ( msg.cc || [] ).filter( fresh ) );
            }
            else f.to = list( to );
            f.subject = /^re:/i.test( msg.subject || "" ) ? msg.subject : "Re: " + ( msg.subject || "" );
            f.html = textHTML( C.sig + "\n\n" + E.TF( "mail.wrote", { date: E.longDate( msg.date ), who: E.whoFull( msg.from ) } ) ) +
                     "<blockquote>" + textHTML( bodyText( msg ) ) + "</blockquote>";
            C.inReplyTo = msg.mid || "";
            C.references = ( msg.references || [] ).concat( msg.mid ? [ msg.mid ] : [] );
        }
        else if( msg )   // forward: the text under a header, and its files
        {
            f.subject = /^(fwd?|rv):/i.test( msg.subject || "" ) ? msg.subject : "Fwd: " + ( msg.subject || "" );
            f.html = textHTML( C.sig + "\n\n" + E.T( "mail.fwdHeader" ) + "\n" +
                     E.T( "mail.from" ) + ": " + E.whoFull( msg.from ) + "\n" +
                     E.T( "mail.date" ) + ": " + E.longDate( msg.date ) + "\n" +
                     E.T( "mail.subject" ) + ": " + ( msg.subject || "" ) + "\n" +
                     E.T( "mail.to" ) + ": " + E.whoFull( msg.to ) + "\n\n" + bodyText( msg ) );
            ( msg.parts || [] ).filter( function ( p ) { return ! p.inline; } ).forEach( function ( p )
            {
                C.files.push( { kind: "keep", acct: msg.acct || S.acct, ref: msg.ref, part: p.id, name: p.name, size: p.size } );
            } );
        }
        show( f, fromRead );
        var focus = msg && opts.mode !== "fwd" ? "cText" : "cTo";
        ed.moveCursorToStart();                         // over the signature, not under it
        setTimeout( function ()
        {
            if( focus !== "cText" ) { E.$( focus ).focus(); return; }
            ed.focus();
            ed.moveCursorToStart();
            E.$( "composeView" ).parentNode.scrollTop = 0;
        }, 50 );
    };

    // A draft of the Drafts tray, to go on with.
    E.openDraft = async function ( m )
    {
        var acct = E.acctOf( m );
        // the mail sent and waiting for its Undo: opening its draft is that Undo
        var w = waiting;
        if( w && w.mine.draftAcct === acct && ( w.mine.draftRef === m.ref || ( m.mid && m.mid === w.mine.mid ) ) )
        {
            w.off = true;
            NayiveUI.undoSettle();          // its toast goes; its onExpire sends nothing
            reopen( w.mine, w.fields );
            return;
        }
        E.plug( "loading" );
        try
        {
            var msg = await E.api( "GET", encodeURIComponent( acct ) + "/msg/" + encodeURIComponent( m.ref ) + "?mid=" + encodeURIComponent( m.mid || "" ) );
            E.plug( "synced" );
            // words of it that never reached the server (a closed page, saves
            // refused): those are newer than the draft - they come back instead
            if( await reopenLocal( acct, msg ) ) return;
            C = blank();
            C.acct = acct;
            C.mid = msg.mid || "";
            C.draftRef = msg.ref;
            C.draftAcct = acct;
            C.references = msg.references || [];
            C.inReplyTo = C.references.length ? C.references[ C.references.length - 1 ] : "";
            ( msg.parts || [] ).filter( function ( p ) { return ! p.inline; } ).forEach( function ( p )
            {
                C.files.push( { kind: "keep", acct: acct, ref: msg.ref, part: p.id, name: p.name, size: p.size } );
            } );
            // its HTML (ours, or one made elsewhere - cleaned down to what
            // the editor keeps), else its plain text. What its fields held that
            // was no address yet ("juan": a draft keeps it, I1) comes after them
            var field = function ( list, rest ) { return [ addrs( list ), rest || "" ].filter( Boolean ).join( ", " ); };
            show( { to: field( msg.to, msg.toRest ), cc: field( msg.cc, msg.ccRest ), bcc: field( msg.bcc, msg.bccRest ),
                    subject: msg.subject || "",
                    html: msg.html ? bodyOf( msg.html ) : null, text: msg.text || "" } );
            C.typed = true;
        }
        catch( err ) { E.plug( "offline" ); NayiveUI.toast( E.errText( err ) ); }
    };

    // An address as the To field takes it back: a name with anything but
    // letters, digits and spaces goes in quotes ("Pérez, Ana" <a@x.es>), or
    // the server would read its comma as two addresses.
    function nameText( name )
    {
        name = String( name || "" ).replace( /["\\\r\n]/g, "" ).trim();
        if( ! name ) return "";
        return /^[\p{L}\p{N} ]+$/u.test( name ) ? name : '"' + name + '"';
    }
    function addrText( a ) { var n = nameText( a.name ); return n ? n + " <" + a.addr + ">" : a.addr; }
    function addrs( list ) { return ( list || [] ).map( addrText ).join( ", " ); }
    function list( l ) { return addrs( l ) + ( l.length ? ", " : "" ); }

    // The text to quote or forward: the plain one, or the HTML's words.
    function bodyText( msg )
    {
        if( msg.text ) return msg.text.replace( /\r\n/g, "\n" ).trim();
        if( ! msg.html ) return "";
        var html = msg.html.replace( /<(br|\/p|\/div|\/tr|\/h[1-6]|\/li)\b[^>]*>/gi, "$&\n" );
        var doc = new DOMParser().parseFromString( html, "text/html" );      // inert: loads nothing
        return ( doc.body ? doc.body.textContent : "" ).replace( /\n{3,}/g, "\n\n" ).trim();
    }

    // ---------------------------------------------------------------------
    // the text: Squire
    // ---------------------------------------------------------------------

    var ed = null;      // the editor on #cText
    var linkAt = null;  // the words the link sheet is for (their range)

    // What may come into the text: these tags, a link's address - nothing
    // else (no style, no class, no picture). A tag not listed goes, its words
    // stay. DOMPurify, then into the editor's own document (Squire asks that).
    var PURE = { ALLOWED_TAGS: [ "b", "strong", "i", "em", "u", "a", "div", "p", "br", "ul", "ol", "li", "blockquote", "span" ],
                 ALLOWED_ATTR: [ "href" ], RETURN_DOM_FRAGMENT: true };
    function toFragment( html )
    {
        return document.importNode( DOMPurify.sanitize( html, PURE ), true );
    }

    function esc( t ) { return t.replace( /&/g, "&amp;" ).replace( /</g, "&lt;" ).replace( />/g, "&gt;" ); }

    // Plain text as the editor's lines: one <div> each. Spaces the editor
    // would drop - at a line's ends (the signature's "-- "), or in a row -
    // go in as no-break spaces (plainText turns them back).
    function textHTML( text )
    {
        return String( text || "" ).split( "\n" ).map( function ( l )
        {
            l = l.replace( /^ | $/g, "\u00a0" ).replace( / {2}/g, " \u00a0" );
            return "<div>" + ( l ? esc( l ) : "<br>" ) + "</div>";
        } ).join( "" );
    }

    // A whole HTML page's body (a draft's HTML part), read inertly.
    function bodyOf( html )
    {
        var doc = new DOMParser().parseFromString( html, "text/html" );
        return doc.body ? doc.body.innerHTML : "";
    }

    // The editor's text as plain text: a line per block or <br>, a list's
    // items as "- " / "1. " (two spaces more per level), a quote's lines
    // after "> ", a link's address after its words (when they differ).
    function plainText( root )
    {
        var lines = [], cur = null;
        function line( pre ) { cur = { pre: pre, text: "" }; lines.push( cur ); }
        function walk( n, pre, depth )
        {
            if( n.nodeType === 3 )
            {
                var v = n.nodeValue.replace( /\u200b/g, "" ).replace( /[\r\n]+/g, " " );
                if( ! cur && ! /[^ \t]/.test( v ) ) return;   // the gap between two blocks
                if( ! cur ) line( pre );
                cur.text += v;
                cur.fresh = false;
                return;
            }
            if( n.nodeType !== 1 ) return;
            var tag = n.nodeName;
            if( tag === "BR" )
            {
                // the <br> that ends a block's words only holds the line open
                if( cur && ! n.nextSibling ) return;
                if( ! cur ) line( pre );
                cur = null;
                return;
            }
            var block = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|H[1-6]|PRE|TABLE|TR)$/.test( tag );
            if( block && ! ( cur && cur.fresh ) ) cur = null;   // an item's first block stays on its "- " line
            if( tag === "BLOCKQUOTE" ) pre += "> ";
            if( tag === "LI" )
            {
                var mark = n.parentNode && n.parentNode.nodeName === "OL"
                         ? ( [].indexOf.call( n.parentNode.children, n ) + 1 ) + ". " : "- ";
                line( pre );
                cur.text = new Array( depth ).join( "  " ) + mark;
                cur.fresh = true;
            }
            var inner = tag === "UL" || tag === "OL" ? depth + 1 : depth;
            for( var c = n.firstChild; c; c = c.nextSibling ) walk( c, pre, inner );
            if( tag === "A" && cur )
            {
                var href = n.getAttribute( "href" ) || "", words = n.textContent.trim();
                var bare = href.replace( /^mailto:/i, "" );
                if( href && bare !== words && href !== words ) cur.text += " <" + bare + ">";
            }
            if( block ) cur = null;
        }
        walk( root, "", 0 );
        return lines.map( function ( l ) { return ( l.text ? l.pre + l.text : l.pre.replace( / +$/, "" ) ); } )
                    .join( "\n" ).replace( /\u00a0/g, " " );
    }

    function setBody( html )
    {
        ed.setHTML( html );
        paintEmpty();
        paintFormat();
    }

    // The placeholder: shown while the box holds no words at all. The mark
    // goes on the box around, not on the editor (Squire takes any change in
    // there, an attribute too, for typing).
    function paintEmpty()
    {
        var root = E.$( "cText" );
        root.parentNode.classList.toggle( "is-empty", ! root.textContent.trim() && ! root.querySelector( "li, blockquote" ) );
    }

    // The bar's buttons lit for what the cursor is in.
    function paintFormat()
    {
        var path = ed.getPath() || "";
        var on = { bold: ed.hasFormat( "B" ), italic: ed.hasFormat( "I" ), underline: ed.hasFormat( "U" ),
                   ul: /(^|>)UL\b/.test( path ), ol: /(^|>)OL\b/.test( path ), link: ed.hasFormat( "A" ) };
        document.querySelectorAll( "#cFormat [aria-pressed]" ).forEach( function ( b )
        {
            var v = !! on[ b.getAttribute( "data-fmt" ) ];
            b.classList.toggle( "is-active", v );
            b.setAttribute( "aria-pressed", v ? "true" : "false" );
        } );
    }

    function format( what )
    {
        if( ! ed ) return;
        var on = function ( tag ) { return ed.hasFormat( tag ); };
        switch( what )
        {
            case "bold":      on( "B" ) ? ed.removeBold()      : ed.bold();      break;
            case "italic":    on( "I" ) ? ed.removeItalic()    : ed.italic();    break;
            case "underline": on( "U" ) ? ed.removeUnderline() : ed.underline(); break;
            case "ul":        on( "UL" ) ? ed.removeList() : ed.makeUnorderedList(); break;
            case "ol":        on( "OL" ) ? ed.removeList() : ed.makeOrderedList();   break;
            case "clear":     ed.removeAllFormatting(); break;
            case "link":      askLink(); return;
        }
        ed.focus();
        paintFormat();
    }

    // The link sheet: the address for the words picked (or, with none, the
    // address goes in as its own words); empty takes the link off.
    function askLink()
    {
        linkAt = ed.getSelection();
        var a = linkAt && linkAt.startContainer;
        a = a && ( a.nodeType === 1 ? a : a.parentNode ).closest( "a" );
        E.$( "linkHref" ).value = a && E.$( "cText" ).contains( a ) ? a.getAttribute( "href" ) || "" : "";
        NayiveUI.open( "linkSheet" );
        setTimeout( function () { E.$( "linkHref" ).focus(); }, 50 );
    }

    function applyLink()
    {
        var href = E.$( "linkHref" ).value.trim();
        NayiveUI.close( "linkSheet" );
        if( ! ed || ! linkAt ) return;
        ed.focus();
        ed.setSelection( linkAt );
        linkAt = null;
        if( ! href ) ed.removeLink();
        else
        {
            if( ! /^(https?|mailto|tel):/i.test( href ) ) href = /^[^\s@\/]+@[^\s@\/]+$/.test( href ) ? "mailto:" + href : "https://" + href;
            ed.makeLink( href );
        }
        paintFormat();
    }

    function startEditor()
    {
        ed = new Squire( E.$( "cText" ), { sanitizeToDOMFragment: toFragment } );
        ed.addEventListener( "input", function () { paintEmpty(); changed(); } );
        ed.addEventListener( "pathChange", paintFormat );
        // a picture pasted, a file dropped: attached, not put in the text
        ed.addEventListener( "pasteImage", function ( e )
        {
            var files = e.detail && e.detail.clipboardData ? e.detail.clipboardData.files : [];
            if( C ) addFiles( [].map.call( files || [], upFile ) );
        } );
        E.$( "cText" ).addEventListener( "drop", function ( e )
        {
            var files = e.dataTransfer && e.dataTransfer.files;
            if( ! files || ! files.length ) return;
            e.preventDefault();
            e.stopPropagation();
            if( C ) addFiles( [].map.call( files, upFile ) );
        }, true );
        // the bar keeps the text's selection: a press there does not take the focus
        E.$( "cFormat" ).addEventListener( "mousedown", function ( e ) { if( e.target.closest( "button" ) ) e.preventDefault(); } );
        E.$( "cFormat" ).addEventListener( "click", function ( e )
        {
            var b = e.target.closest( "button[data-fmt]" );
            if( b ) format( b.getAttribute( "data-fmt" ) );
        } );
        E.$( "linkOkBtn" ).addEventListener( "click", applyLink );
        E.$( "linkHref" ).addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); applyLink(); } } );
    }

    function upFile( f ) { return { kind: "up", file: f, name: f.name || "image.png", size: f.size }; }

    function show( f, replaceHistory )
    {
        var sel = E.$( "cFrom" );
        sel.textContent = "";
        S.accounts.forEach( function ( a ) { sel.appendChild( h( "option", { text: ( a.name ? a.name + " <" + a.email + ">" : a.email ), attrs: { value: a.id } } ) ); } );
        sel.value = C.acct;
        E.$( "cFromRow" ).hidden = S.accounts.length < 2;
        E.$( "cTo" ).value = f.to;
        E.$( "cCc" ).value = f.cc;
        E.$( "cBcc" ).value = f.bcc;
        E.$( "cSubject" ).value = f.subject;
        setBody( f.html != null ? f.html : textHTML( f.text ) );
        var cc = !! ( f.cc || f.bcc );
        E.$( "cCcRow" ).hidden = ! cc;
        E.$( "cBccRow" ).hidden = ! cc;
        E.$( "cCcBtn" ).hidden = cc;
        E.$( "cStatus" ).textContent = "";
        renderFiles();
        setWriting( true );
        holdLid( C );
        try
        {
            if( replaceHistory ) history.replaceState( { mailWrite: 1 }, "" );
            else history.pushState( { mailWrite: 1 }, "" );
        }
        catch( e ) {}
        if( ! book ) E.api( "GET", "contacts" ).then( function ( r ) { book = r.contacts || []; } ).catch( function () { book = []; } );
    }

    function setWriting( on )
    {
        document.body.classList.toggle( "composing", on );
        E.$( "composeView" ).hidden = ! on;
        E.$( "listView" ).hidden = on || ! S.accounts.length;
        E.$( "writeActions" ).hidden = ! on;
        E.$( "backBtn" ).hidden = ! on && ! S.open;
        E.$( "composeView" ).parentNode.scrollTop = 0;
        E.syncBar();
    }

    // ---------------------------------------------------------------------
    // the files
    // ---------------------------------------------------------------------

    function totalSize() { return C.files.reduce( function ( n, f ) { return n + ( f.size || 0 ); }, 0 ); }

    function renderFiles()
    {
        var box = E.$( "cFiles" );
        box.textContent = "";
        C.files.forEach( function ( f, i )
        {
            var x = h( "button", { class: "icon-btn sm", html: NayiveUI.icon( "x" ),
                                   attrs: { type: "button", title: E.T( "mail.removeFile" ), "aria-label": E.T( "mail.removeFile" ) },
                                   on: { click: function () { C.files.splice( i, 1 ); renderFiles(); changed(); } } } );
            box.appendChild( h( "span", { class: "mail-part mail-cfile", html: E.icon( "file" ) },
                                h( "span", { text: f.name } ),
                                f.size ? h( "small", { text: NayiveUI.fmtBytes( f.size ) } ) : null, x ) );
        } );
        box.hidden = ! C.files.length;
    }

    // THE CLIP: Chat's panel (NayiveUI.attachPanel), the three kinds of file
    // a mail can carry - a document from this device, one from Nayive, and
    // pictures from the gallery. Under the clip, right-aligned to it.
    var attach = null;

    function closeAttach()
    {
        if( attach ) attach.remove();
        attach = null;
    }

    function pickDevice( pictures )
    {
        var input = E.$( "cFileInput" );
        input.accept = pictures ? "image/*" : "";
        input.click();
    }

    async function pickNayive()
    {
        var f = await NayiveUI.pickFile( { title: E.T( "mail.attachDrive" ) } );
        if( f && C ) addFiles( [ { kind: "drive", path: f.path, name: f.name, size: f.size } ] );
    }

    function toggleAttach()
    {
        if( attach ) { closeAttach(); return; }
        if( ! C ) return;
        var ic = function ( name ) { var t = document.createElement( "template" ); t.innerHTML = E.icon( name ); return t.content.firstChild; };
        attach = NayiveUI.attachPanel( [
            { icon: ic( "file" ),   label: E.T( "chat.localDoc" ),  color: 4, act: function () { pickDevice( false ); } },
            { icon: ic( "folder" ), label: E.T( "chat.nayiveDoc" ), color: 3, act: pickNayive },
            { icon: ic( "image" ),  label: E.T( "chat.gallery" ),   color: 1, act: function () { pickDevice( true ); } }
        ], closeAttach );
        attach.classList.add( "mail-attach" );
        document.body.appendChild( attach );
        var r = E.$( "cAttach" ).getBoundingClientRect(), w = attach.offsetWidth;
        var left = Math.max( 10, Math.min( r.right - w, window.innerWidth - w - 10 ) );
        attach.style.left = left + "px";
        attach.style.top = ( r.bottom + 6 ) + "px";
    }

    function addFiles( list )
    {
        var added = 0;
        list.forEach( function ( f )
        {
            if( totalSize() + ( f.size || 0 ) > MAX ) { NayiveUI.toast( E.T( "mail.err.big" ), { ms: 3500 } ); return; }
            C.files.push( f );
            if( f.kind === "up" ) localFile( C, f );     // its bytes, once (not on every keystroke)
            added++;
        } );
        if( added ) { renderFiles(); changed(); }
    }

    // ---------------------------------------------------------------------
    // saving and sending
    // ---------------------------------------------------------------------

    function changed()
    {
        if( ! C ) return;
        C.dirty = true;
        C.typed = true;
        schedule();
        localSoon( C );
    }

    // The next save: a few seconds after the last change - a minute with
    // files - and none while the message is being sent (a save then would
    // make a new draft after Send deleted the old one).
    function schedule()
    {
        clearTimeout( C.timer );
        if( C.sending ) return;
        C.timer = setTimeout( function () { saveDraft(); }, C.files.length ? SAVE_AFTER_FILES : SAVE_AFTER );
    }

    function empty()
    {
        var text = plainText( E.$( "cText" ) ).trim();
        return ! C.files.length && ( ! text || text === C.sig.trim() ) &&
               [ "cTo", "cCc", "cBcc", "cSubject" ].every( function ( id ) { return ! E.$( id ).value.trim(); } );
    }

    // What the writer's fields hold now: the text twice, formatted and plain.
    function fieldsNow()
    {
        return { to: E.$( "cTo" ).value, cc: E.$( "cCc" ).value, bcc: E.$( "cBcc" ).value,
                 subject: E.$( "cSubject" ).value, html: ed.getHTML(), text: plainText( E.$( "cText" ) ) };
    }

    // The request both share: the message as JSON, the uploads as files.
    // fd.sent: the files in the order the server keeps them (kept parts,
    // Nayive files, uploads - api_mail.go), for the answer's part ids.
    // `mine` / `fields`: the message and its words (a send waiting for its
    // Undo is no longer in the writer); by default the one in the writer.
    function form( forDraftIn, mine, fields )
    {
        mine = mine || C;
        var fl = fields || fieldsNow();
        var out = {
            to: fl.to, cc: fl.cc, bcc: fl.bcc, subject: fl.subject, text: fl.text, html: fl.html,
            inReplyTo: mine.inReplyTo, references: mine.references, mid: mine.mid,
            draftRef: mine.draftAcct === forDraftIn ? mine.draftRef : "",
            keep: [], drive: []
        };
        var fd = new FormData(), keep = [], drive = [], up = [];
        mine.files.forEach( function ( f )
        {
            // its name and size: the server finds it again in the newest draft when another
            // device replaced the one it is kept from (api_mail.go mailKeptAgain)
            if( f.kind === "keep" )  { out.keep.push( { acct: f.acct, ref: f.ref, part: f.part, name: f.name, size: f.size } ); keep.push( f ); }
            if( f.kind === "drive" ) { out.drive.push( f.path ); drive.push( f ); }
            if( f.kind === "up" )    { fd.append( "file", f.file, f.name ); up.push( f ); }
        } );
        var json = JSON.stringify( out );
        fd.append( "json", json );
        fd.sent = keep.concat( drive, up );
        // small, no files: it may outlive the page (a save on leaving). The
        // browser refuses a keepalive body over 64 KiB of BYTES (and counts
        // every keepalive request on its way together): the JSON's UTF-8
        // size, with room for the form's own envelope - a string's length
        // counts UTF-16 units, and Cyrillic or Chinese text takes two or
        // three bytes each, so `json.length` let such a draft fail every
        // save as "offline" (mail-chat #11)
        fd.small = ! up.length && new Blob( [ json ] ).size < 60000;
        return fd;
    }

    async function post( acct, path, fd )
    {
        var url = "/api/mail/" + encodeURIComponent( acct ) + "/" + path, res;
        try
        {
            if( fd.small )
            {
                var r = await fetch( url, { method: "POST", credentials: "same-origin", body: fd, keepalive: true, headers: E.owned( {} ) } );
                res = { ok: r.ok, status: r.status, body: await r.text() };
            }
            else res = await upload( url, fd );
        }
        catch( e ) { var off = new Error( "offline" ); off.code = "offline"; throw off; }
        var data = null;
        try { data = JSON.parse( res.body ); } catch( e ) {}
        if( ! res.ok )
        {
            if( res.status === 401 ) NayiveUI.sessionExpired();
            var err = new Error( ( data && data.error ) || "HTTP " + res.status );
            err.status = res.status;
            err.code = ( data && data.code ) || "down";
            err.text = ( data && data.text ) || "";
            throw err;
        }
        return data;
    }

    // With files: XMLHttpRequest, the one that tells how much went up, told
    // as GumApi's "nayive:upload" events - the shared bar (ui.js) shows a big
    // attachment going up. Answers fetch's { ok, status }, the body as text.
    var upSeq = 0;
    function upload( url, fd )
    {
        var id = "mail-" + ( ++upSeq );
        function tell( d ) { try { document.dispatchEvent( new CustomEvent( "nayive:upload", { detail: d } ) ); } catch( e ) {} }
        return new Promise( function ( ok, fail )
        {
            var x = new XMLHttpRequest();
            x.open( "POST", url );
            var h = E.owned( {} );
            for( var k in h ) x.setRequestHeader( k, h[ k ] );
            x.upload.onprogress = function ( e ) { if( e.lengthComputable ) tell( { id: id, loaded: e.loaded, total: e.total } ); };
            x.onload = function () { tell( { id: id, done: true } ); ok( { ok: x.status >= 200 && x.status < 300, status: x.status, body: x.responseText } ); };
            x.onerror = x.onabort = x.ontimeout = function () { tell( { id: id, done: true } ); fail( new TypeError( "Failed to fetch" ) ); };
            x.send( fd );
        } );
    }

    function stamp( key )
    {
        var t = new Date().toLocaleTimeString( NayiveUI.locale(), { hour: "2-digit", minute: "2-digit" } );
        E.$( "cStatus" ).textContent = E.TF( key, { time: t } );
    }

    // Save now; one at a time (a change during a save saves again after it).
    function saveDraft()
    {
        if( ! C ) return Promise.resolve();
        clearTimeout( C.timer );
        if( C.saving ) { C.again = true; return C.saving; }
        if( ! C.dirty ) return Promise.resolve();
        var mine = C, acct = C.acct;
        mine.dirty = false;
        E.$( "cStatus" ).textContent = E.T( "mail.draftSaving" );
        mine.saving = ( async function ()
        {
            try
            {
                var fd = form( acct, mine );
                var r = await post( acct, "draft", fd );
                if( mine.staleDraft ) { dropDraft( mine.staleDraft.acct, mine.staleDraft.ref ); mine.staleDraft = null; }
                if( mine.acct === acct )
                {
                    mine.draftRef = r.ref;
                    mine.draftAcct = acct;
                    mine.mid = r.mid;
                }
                // "From" changed while this save was on its way: this draft
                // is in the old account - it goes after the next save
                else mine.staleDraft = { acct: acct, ref: r.ref };
                // the files SENT now live in the draft: from now on, "keep"
                // them. One added meanwhile stays as it is (it goes up with
                // the next save), one removed meanwhile stays removed.
                var parts = r.parts || [];
                if( parts.length === fd.sent.length )
                {
                    var now = {};
                    fd.sent.forEach( function ( f, i )
                    {
                        var p = parts[ i ];
                        now[ i ] = { kind: "keep", acct: acct, ref: r.ref, part: p.id, name: p.name || f.name, size: p.size || f.size };
                    } );
                    mine.files = mine.files.map( function ( f ) { var i = fd.sent.indexOf( f ); return i >= 0 ? now[ i ] : f; } );
                }
                else mine.dirty = true;     // cannot tell which is which: send them all again
                if( C === mine ) { renderFiles(); stamp( "mail.draftSaved" ); }
                if( ! S.label && S.tray === "drafts" && ! S.open ) E.loadList( false );
                mine.warned = "";
                // the server has the newest words: the copy here goes; typed
                // during the save: it stays, now pointing at the new draft
                if( mine.dirty ) localSoon( mine );
                else localDrop( mine );
            }
            catch( err )
            {
                mine.dirty = true;
                mine.failed = err;
                if( C === mine ) E.$( "cStatus" ).textContent = E.errText( err );
                localNow( mine );
                // a kept file that is gone: mended, and saved again (heal) -
                // said only when that cannot be done
                if( err.code === "gone" ) heal( mine, acct ).then( function ( mended ) { if( ! mended ) warn( mine, err ); } );
                else warn( mine, err );
                return;
            }
            finally
            {
                mine.saving = null;
                if( mine.again ) { mine.again = false; if( C === mine ) saveDraft(); }
            }
            mine.failed = null;
        } )();
        return mine.saving;
    }

    // A save that failed, said out loud - not only in the small line under
    // the fields (a To like "juan" refused, no network: every save fails the
    // same way) - once per reason, and not when ← or Send is about to say
    // it. Any toast ends a pending Undo, so never one every 4 s.
    function warn( mine, err )
    {
        if( C !== mine || mine.closing || mine.sending || mine.warned === err.code ) return;
        mine.warned = err.code;
        NayiveUI.toast( E.TF( "mail.draftNotSaved", { why: E.errText( err ) } ), { ms: 6000 } );
    }

    function dropDraft( acct, ref )
    {
        if( ! ref ) return Promise.resolve();
        return E.api( "POST", encodeURIComponent( acct ) + "/draft/delete", { ref: ref } ).catch( function () {} );
    }

    // ← (or Back): keep what was written as a draft, then back to the list.
    // A save that fails keeps the writer open - nothing written is lost.
    E.closeCompose = async function ( fromCode )
    {
        if( ! C ) return;
        var mine = C;
        if( mine.closing ) return;
        if( mine.typed && ! empty() )
        {
            mine.closing = true;
            mine.dirty = mine.dirty || ! mine.draftRef;
            await saveDraft();
            while( mine.saving ) await mine.saving;
            mine.closing = false;
            if( C !== mine ) return;
            if( mine.dirty )
            {
                E.$( "cStatus" ).textContent = E.errText( mine.failed );
                NayiveUI.toast( E.T( "mail.notSaved" ), { ms: 4000 } );
                // the phone's Back already took its step: put it back, so the
                // next Back tries again instead of leaving the app
                if( ! fromCode ) { try { history.pushState( { mailWrite: 1 }, "" ); } catch( e ) {} }
                return;
            }
            NayiveUI.toast( E.T( "mail.savedToDrafts" ) );
        }
        else if( mine.draftRef ) dropDraft( mine.draftAcct, mine.draftRef );    // emptied: nothing to keep
        leave( fromCode );
    };

    // Out of the writer: every way here leaves its words safe elsewhere (in
    // Drafts, sent, or binned by the user with an Undo that brings them back
    // through reopen) - the copy on this device goes. Except keepLocal: its
    // words are nowhere else (sent, with no copy in Sent nor in Drafts - I5):
    // the copy here stays, its lock let go so the next opening offers it.
    function leave( fromCode, keepLocal )
    {
        closeAttach();
        if( C ) { clearTimeout( C.timer ); if( ! keepLocal ) localDrop( C ); dropLid( C ); }
        C = null;
        hideSuggest();
        setWriting( false );
        E.syncBar();
        if( fromCode ) { try { if( history.state && history.state.mailWrite ) history.back(); } catch( e ) {} }
        if( ! S.label && ( S.tray === "drafts" || S.tray === "sent" ) ) E.loadList( false );
    }

    // The writer again, for a message that had left it: the Undo of the bin
    // or of Send, or a send that failed after its Undo. Over a message on
    // screen it takes that one's history entry (as E.compose does).
    function reopen( mine, fields )
    {
        var fromRead = !! S.open && !! ( history.state && history.state.mailRead );     // split pushes none
        if( S.open ) E.closeMessage( false );
        E.endSelect();
        C = mine;
        C.closing = false;
        C.sending = false;
        show( fields, fromRead );
        if( C.dirty ) schedule();
        localSoon( C );
    }

    // The bin: out of the writer at once, with Undo; the draft is deleted
    // when the Undo is gone - a page closed before that deletes it too
    // (unless a save was still on its way then: that draft stays).
    function discard()
    {
        if( ! C ) return;
        var mine = C;
        clearTimeout( mine.timer );
        var fields = fieldsNow();
        leave( true );
        NayiveUI.undoToast( E.T( "mail.discarded" ), function ()
        {
            if( C ) return;                 // already writing another one
            reopen( mine, fields );
        }, { onExpire: function ()
        {
            var drop = function ()
            {
                dropDraft( mine.draftAcct, mine.draftRef );
                if( mine.staleDraft ) dropDraft( mine.staleDraft.acct, mine.staleDraft.ref );
            };
            // no save on its way: the delete starts now (a closing page sends it too)
            if( mine.saving ) mine.saving.then( drop );
            else drop();
        } } );
    }

    // Send: the draft is saved first - it is what a page closed during the
    // Undo leaves - then the mail leaves the writer and waits for its Undo
    // (later). A draft that could not be saved: sent at once, no Undo.
    async function send()
    {
        if( ! C ) return;
        var mine = C, btn = E.$( "cSend" );
        if( ! E.$( "cTo" ).value.trim() && ! E.$( "cCc" ).value.trim() && ! E.$( "cBcc" ).value.trim() )
        {
            NayiveUI.toast( E.T( "mail.err.norcpt" ), { ms: 3000 } );
            E.$( "cTo" ).focus();
            return;
        }
        clearTimeout( mine.timer );
        mine.sending = true;
        btn.disabled = true;
        E.plug( "saving" );
        mine.dirty = mine.dirty || ! mine.draftRef;
        await saveDraft();
        while( mine.saving ) await mine.saving;
        // left meanwhile (←: it stays a draft; the bin, even undone): not sent
        if( C !== mine || ! mine.sending ) { mine.sending = false; btn.disabled = false; E.plug( "synced" ); return; }
        if( ! mine.dirty && mine.draftRef && mine.draftAcct === mine.acct && ! mine.staleDraft )
        {
            btn.disabled = false;
            later( mine );
            return;
        }
        // not saved (offline, refused, or typed during the save): as before
        E.$( "cStatus" ).textContent = E.T( "mail.sending" );
        try
        {
            var r = await post( mine.acct, "send", form( mine.acct, mine ) );
            E.plug( "synced" );
            if( r && r.noCopy )
            {
                // Sent, but no copy in Sent: no draft of it is deleted. Its
                // words not in Drafts as they went (a save refused - a full
                // mailbox -, or typed during it): the copy on this device is
                // now their ONLY copy - it stays, and comes back the next
                // time eMail opens (restoreLocal) (data-safety I5).
                if( ! mine.dirty && mine.draftRef && mine.draftAcct === mine.acct )
                {
                    NayiveUI.toast( E.T( "mail.sentNoCopy" ), { ms: 8000 } );
                    leave( true );
                    return;
                }
                mine.dirty = true;
                localNow( mine );
                NayiveUI.toast( E.T( "mail.sentNoCopyHere" ), { ms: 10000 } );
                leave( true, true );
                return;
            }
            if( mine.draftAcct && mine.draftAcct !== mine.acct ) dropDraft( mine.draftAcct, mine.draftRef );   // written in the other account
            if( mine.staleDraft ) dropDraft( mine.staleDraft.acct, mine.staleDraft.ref );
            NayiveUI.toast( E.T( "mail.sent" ) );
            leave( true );
        }
        catch( err )
        {
            E.plug( err.code === "offline" ? "offline" : "synced" );
            E.$( "cStatus" ).textContent = E.errText( err );
            NayiveUI.toast( E.errText( err ), { ms: 4000 } );
            mine.sending = false;
            if( C === mine && mine.dirty ) schedule();      // what was typed meanwhile
        }
        finally { btn.disabled = false; mine.sending = false; }
    }

    // Its draft saved, the mail leaves the writer and waits for its Undo. It
    // goes out when the Undo is gone; a page closed first sends nothing
    // (keepOnLeave): the draft keeps it. The toast says "Sending…", not
    // "Sent" - until then it is not.
    function later( mine )
    {
        var fields = fieldsNow();
        var w = { mine: mine, fields: fields, off: false };
        waiting = w;
        E.plug( "synced" );
        leave( true );
        NayiveUI.undoToast( E.T( "mail.sending" ), function ()
        {
            if( waiting === w ) waiting = null;
            mine.sending = false;
            if( C ) { NayiveUI.toast( E.T( "mail.savedToDrafts" ) ); return; }     // writing another one: this one waits in Drafts
            reopen( mine, fields );
        }, { keepOnLeave: true, onExpire: function ()
        {
            if( waiting === w ) waiting = null;
            if( ! w.off ) sendNow( mine, fields );       // off: its draft was opened meanwhile
        } } );
    }

    // The real send, the Undo gone. No toast when it went (one would take the
    // place of another Undo on show) - but when its copy in Sent failed, the
    // server kept its draft (the only copy of the words) and that IS said
    // (data-safety I5). When it failed, the writer comes back saying why -
    // its draft is still in Drafts - or, while another one is being written,
    // a toast says so.
    function sendNow( mine, fields )
    {
        E.plug( "saving" );
        post( mine.acct, "send", form( mine.acct, mine, fields ) ).then( function ( r )
        {
            mine.sending = false;
            E.plug( "synced" );
            if( r && r.noCopy ) NayiveUI.toast( E.T( "mail.sentNoCopy" ), { ms: 8000 } );
            if( ! C && ! S.label && ( S.tray === "drafts" || S.tray === "sent" ) && E.listShown() && ! E.picking() ) E.loadList( false );
        }, function ( err )
        {
            mine.sending = false;
            E.plug( err.code === "offline" ? "offline" : "synced" );
            if( C ) { NayiveUI.toast( E.T( "mail.notSent" ) + " " + E.errText( err ), { ms: 5000 } ); return; }
            reopen( mine, fields );
            E.$( "cStatus" ).textContent = E.errText( err );
            NayiveUI.toast( E.errText( err ), { ms: 4000 } );
        } );
    }

    // Another "From": the draft moves to that account (the old one goes after
    // the next save there - its files are still read from it until then).
    function fromChanged()
    {
        var to = E.$( "cFrom" ).value;
        if( ! C || to === C.acct ) return;
        if( C.draftRef && C.draftAcct !== to ) { C.staleDraft = { acct: C.draftAcct, ref: C.draftRef }; C.draftRef = ""; C.draftAcct = ""; }
        C.acct = to;
        changed();
    }

    // ---------------------------------------------------------------------
    // THE COPY ON THIS DEVICE (data-safety I1, I4 - mail-chat #1 #2 #10 #11
    // #15 #16)
    //
    // A save to Drafts can fail for a long time - a To like "juan" refused,
    // a file kept from a draft another device re-saved now "gone", no
    // network, the session over - and a tab closed, a desktop window's ×, a
    // phone killing the page or the session bar's "Sign in" would then lose
    // everything since the last good save. So the writer is also kept HERE:
    // a moment after a change, and at least every second while typing goes
    // on. IndexedDB "nayive-drafts" (shared/office.js's database of device
    // drafts - sign-out counts it, asks, and empties it), one record per
    // writer, "email:<lid>"; the bytes of each file from this device once,
    // in a database of their own ("nayive-mail-files": they are this
    // device's files already, a Blob is never re-written per keystroke, and
    // sign-out counts mails, not files - bytes whose mail is gone are swept
    // at the next opening). The copy goes when the server has the newest
    // words (a save, the writer closed, sent or binned).
    //
    // It comes back - the next time eMail opens (restoreLocal), or when its
    // draft is opened (reopenLocal) - by what the server holds now (verdict):
    // a draft with its words already: the copy only goes; the very draft it
    // was written on: the copy takes its place; a draft of it changed
    // elsewhere since: BOTH stay, the copy as a draft of its own; no draft of
    // it at all (never saved - or sent, discarded elsewhere): the user says,
    // nothing is saved on its own. Each writer on screen holds the Web Lock
    // "nayive-mail-writer:<lid>": a copy whose lock is held is being written
    // in another tab or window - left alone. Every step here may fail
    // quietly (private mode, no IndexedDB): the writer then works as before.
    // ---------------------------------------------------------------------

    var KEEP_AFTER = 300;    // ms after the last change: the copy here...
    var KEEP_EVERY = 1000;   // ...and while typing goes on, at least this often

    // One IndexedDB database, opened once; null when it cannot be.
    function opener( name, store, keyPath )
    {
        var db = null;
        return function ()
        {
            if( db ) return db;
            db = new Promise( function ( resolve )
            {
                var rq;
                try { rq = indexedDB.open( name, 1 ); }
                catch( e ) { resolve( null ); return; }
                rq.onupgradeneeded = function () { rq.result.createObjectStore( store, { keyPath: keyPath } ); };
                rq.onsuccess = function () { resolve( rq.result ); };
                rq.onerror = rq.onblocked = function () { resolve( null ); };
            } );
            return db;
        };
    }
    // "nayive-drafts": the same upgrade as shared/office.js - whoever opens it first makes it
    var openLocal = opener( "nayive-drafts", "drafts", "app" );
    var openBytes = opener( "nayive-mail-files", "files", "key" );

    // fn( objectStore ) -> request: its result once the transaction is done (null on any failure).
    function tx( open, store, mode, fn )
    {
        return open().then( function ( db )
        {
            if( ! db ) return null;
            return new Promise( function ( resolve )
            {
                try
                {
                    var t = db.transaction( store, mode );
                    var rq = fn( t.objectStore( store ) );
                    t.oncomplete = function () { resolve( rq && rq.result !== undefined ? rq.result : null ); };
                    t.onerror = t.onabort = function () { resolve( null ); };
                }
                catch( e ) { resolve( null ); }
            } );
        } );
    }
    function localTx( mode, fn ) { return tx( openLocal, "drafts", mode, fn ); }
    function bytesTx( mode, fn ) { return tx( openBytes, "files", mode, fn ); }

    function localKey( lid ) { return "email:" + lid; }
    function bytesOf( lid ) { return IDBKeyRange.bound( lid + "#", lid + "#￿" ); }

    // Something of this writer is not in Drafts yet.
    function pending( mine ) { return !! mine && mine.typed && ( mine.dirty || !! mine.saving || !! mine.failed ); }

    function localSoon( mine )
    {
        if( ! mine ) return;
        clearTimeout( mine.ltimer );
        if( ! mine.lsince ) mine.lsince = Date.now();           // the oldest change not kept yet
        if( Date.now() - mine.lsince >= KEEP_EVERY ) { localNow( mine ); return; }
        mine.ltimer = setTimeout( function () { localNow( mine ); }, KEEP_AFTER );
    }

    // The writer on screen, as it is now (only that one: its words are read
    // from the fields).
    var whoAsked = null;
    function localNow( mine )
    {
        if( ! mine ) return;
        clearTimeout( mine.ltimer );
        mine.lsince = 0;
        if( mine !== C || ! pending( mine ) || empty() ) return;
        // whose is not known yet (a start with no answer): asked, and the
        // copy written again once it is - one with no owner is never offered back
        if( ! S.user && ! whoAsked )
            whoAsked = E.whoami().then( function ( u ) { whoAsked = null; if( u && C === mine ) localSoon( mine ); } );
        var f = fieldsNow();
        var rec = {
            app: localKey( mine.lid ), who: S.user || "", at: Date.now(), lid: mine.lid,
            acct: mine.acct, mid: mine.mid, draftRef: mine.draftRef, draftAcct: mine.draftAcct, staleDraft: mine.staleDraft,
            inReplyTo: mine.inReplyTo, references: mine.references, sig: mine.sig,
            fields: { to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, html: f.html },
            files: mine.files.map( function ( x )
            {
                return { kind: x.kind, name: x.name, size: x.size, acct: x.acct, ref: x.ref, part: x.part, path: x.path, fid: x.fid };
            } )
        };
        localTx( "readwrite", function ( os ) { return os.put( rec ); } );
    }

    // A file from this device: its bytes, once.
    function localFile( mine, f )
    {
        f.fid = newLid();
        bytesTx( "readwrite", function ( os ) { return os.put( { key: mine.lid + "#" + f.fid, at: Date.now(), blob: f.file } ); } );
    }

    function localDrop( mine )
    {
        if( ! mine ) return;
        clearTimeout( mine.ltimer );
        mine.lsince = 0;
        localTx( "readwrite", function ( os ) { return os.delete( localKey( mine.lid ) ); } );
        bytesTx( "readwrite", function ( os ) { return os.delete( bytesOf( mine.lid ) ); } );
    }

    // This account's copies, newest first.
    async function localAll()
    {
        var all = await localTx( "readonly", function ( os ) { return os.getAll( IDBKeyRange.bound( "email:", "email:￿" ) ); } ) || [];
        return all.filter( function ( r ) { return r.lid && r.app === localKey( r.lid ) && r.who && r.who === S.user; } )
                  .sort( function ( a, b ) { return b.at - a.at; } );
    }

    // The lids of the writers on screen now, in this browser (their locks).
    async function liveLids()
    {
        var out = new Set();
        if( ! ( navigator.locks && navigator.locks.query ) ) return out;
        try
        {
            ( ( await navigator.locks.query() ).held || [] ).forEach( function ( l )
            {
                if( l.name && l.name.indexOf( "nayive-mail-writer:" ) === 0 ) out.add( l.name.slice( 19 ) );
            } );
        }
        catch( e ) {}
        return out;
    }

    // File bytes whose copy is gone (sent, binned, sign-out emptied the
    // copies) and whose writer is on screen nowhere.
    async function sweepBytes()
    {
        if( ! ( navigator.locks && navigator.locks.query ) ) return;     // no way to tell a writer on screen: leave them
        var keys = await bytesTx( "readonly", function ( os ) { return os.getAllKeys(); } ) || [];
        if( ! keys.length ) return;
        var have = new Set( ( await localTx( "readonly", function ( os ) { return os.getAllKeys( IDBKeyRange.bound( "email:", "email:￿" ) ); } ) || [] )
                            .map( function ( k ) { return String( k ).slice( 6 ); } ) );
        var live = await liveLids();
        keys.forEach( function ( k )
        {
            var lid = String( k ).split( "#" )[ 0 ];
            if( ! have.has( lid ) && ! live.has( lid ) ) bytesTx( "readwrite", function ( os ) { return os.delete( k ); } );
        } );
    }

    // The Web Lock of a writer on screen: taken when it shows, let go when it
    // leaves. claim: only if nobody holds it (a copy another tab may be
    // restoring at the same moment) - false then.
    function holdLid( mine, claim )
    {
        if( mine.lock ) return Promise.resolve( true );
        if( ! ( navigator.locks && navigator.locks.request ) ) return Promise.resolve( true );   // no locks here: never known taken
        var lock = new Promise( function ( resolve )
        {
            navigator.locks.request( "nayive-mail-writer:" + mine.lid, { ifAvailable: !! claim }, function ( l )
            {
                if( ! l ) { resolve( null ); return null; }
                return new Promise( function ( release ) { resolve( release ); } );
            } ).catch( function () { resolve( null ); } );
        } );
        mine.lock = lock;
        return lock.then( function ( release )
        {
            if( ! release && mine.lock === lock ) mine.lock = null;
            return !! release;
        } );
    }

    function dropLid( mine )
    {
        var l = mine.lock;
        mine.lock = null;
        if( l ) l.then( function ( release ) { if( release ) release(); } );
    }

    // A record back into a writer (not shown yet: its words are d.fields, for
    // reopen); the files from this device come with their bytes (one whose
    // bytes are not here is left out).
    async function fromLocal( d )
    {
        var mine = blank();
        [ "acct", "mid", "draftRef", "draftAcct", "staleDraft", "inReplyTo", "references", "sig" ].forEach( function ( k )
        {
            if( d[ k ] !== undefined ) mine[ k ] = d[ k ];
        } );
        mine.lid = d.lid;
        if( ! E.account( mine.acct ) ) { mine.acct = S.acct; mine.draftRef = ""; mine.draftAcct = ""; }   // its account was removed
        var blobs = {};
        ( await bytesTx( "readonly", function ( os ) { return os.getAll( bytesOf( d.lid ) ); } ) || [] ).forEach( function ( r )
        {
            blobs[ String( r.key ).split( "#" )[ 1 ] ] = r.blob;
        } );
        mine.files = ( d.files || [] ).filter( function ( f ) { return f.kind !== "up" || blobs[ f.fid ]; } ).map( function ( f )
        {
            var x = Object.assign( {}, f );
            if( x.kind === "up" ) x.file = blobs[ x.fid ];
            return x;
        } );
        mine.typed = true;
        mine.dirty = true;          // not in Drafts as it is: saved again
        return mine;
    }

    // ---------------------------------------------------------------------
    // what the server holds of a draft
    // ---------------------------------------------------------------------

    function words( t ) { return String( t || "" ).replace( /\s+/g, " " ).trim(); }
    function htmlText( html )
    {
        var doc = new DOMParser().parseFromString( html || "", "text/html" );        // inert: loads nothing
        return doc.body ? plainText( doc.body ) : "";
    }

    // The drafts with this Message-ID in the Drafts tray - every page of it,
    // read whole, newest first: { all: [] } when there is none; null when
    // the server did not answer (nothing is decided then). Two of them (two
    // saves of one writer that both landed, two devices on one draft) both
    // stay: a duplicate is not a loss, and nothing here ever moves or
    // deletes a draft on its own.
    async function serverDrafts( acct, mid )
    {
        if( ! mid || ! E.account( acct ) ) return { all: [] };
        try
        {
            var rows = [], cursor = "";
            do
            {
                var l = await E.api( "GET", encodeURIComponent( acct ) + "/list?tray=drafts" + ( cursor ? "&cursor=" + encodeURIComponent( cursor ) : "" ) );
                rows = rows.concat( ( l.items || [] ).filter( function ( m ) { return m.mid === mid; } ) );
                cursor = l.next || "";
            }
            while( cursor );
            var all = [];
            for( var i = 0; i < rows.length; i++ ) all.push( await E.api( "GET", encodeURIComponent( acct ) + "/msg/" + encodeURIComponent( rows[ i ].ref ) ) );
            all.sort( function ( x, y ) { return ( Date.parse( y.date ) || 0 ) - ( Date.parse( x.date ) || 0 ); } );
            return { all: all };
        }
        catch( e ) { return null; }
    }

    // That draft already holds the copy's words (the save sent as the page
    // went did arrive): the same subject, addresses, text and number of
    // files. Anything that differs (or cannot be told) counts as different.
    function sameWords( d, msg )
    {
        var f = d.fields || {};
        var who = function ( t ) { return ( String( t || "" ).toLowerCase().match( /[^\s<>,;"]+@[^\s<>,;"]+/g ) || [] ).sort().join( "," ); };
        var addrs = function ( l ) { return ( l || [] ).map( function ( a ) { return a.addr; } ).join( "," ); };
        return words( msg.subject ) === words( f.subject ) &&
               who( f.to ) === who( addrs( msg.to ) ) && who( f.cc ) === who( addrs( msg.cc ) ) && who( f.bcc ) === who( addrs( msg.bcc ) ) &&
               ( d.files || [] ).length === ( msg.parts || [] ).filter( function ( p ) { return ! p.inline; } ).length &&
               words( msg.text ) === words( htmlText( f.html ) );
    }

    // What a copy is, against the drafts of it the server holds (`all`,
    // newest first):
    //   "drop"     one holds its words already: the copy only goes
    //   "replace"  the very draft it was written on is still there (a ref
    //              never changes: that draft is as the copy knew it) -
    //              newer, the copy takes its place; another of it (a twin)
    //              stays as it is
    //   "apart"    the draft changed elsewhere since (another device, the
    //              save as the page went): both stay - the copy as a draft
    //              of its own
    //   "ask"      no draft of it: never saved - or sent, discarded, moved
    //              elsewhere: the user says (nothing is saved on its own)
    function verdict( d, all )
    {
        if( ! all.length ) return "ask";
        if( all.some( function ( m ) { return sameWords( d, m ); } ) ) return "drop";
        if( d.draftRef && ( d.draftAcct || d.acct ) === d.acct && all.some( function ( m ) { return m.ref === d.draftRef; } ) ) return "replace";
        return "apart";
    }

    // Kept files whose source is gone (stale( f )), read from `msg` (the
    // newest draft with this Message-ID) instead: a part of the same name
    // AND size, each part once. When as many of mine as of its parts share
    // a name and size, they pair up (the same files, whichever order);
    // otherwise none of that name and size is guessed - never a wrong file
    // (pasted pictures are all "image.png"). Returns the names of those not
    // found - they leave the writer, unless `keep` (heal then tells, when a
    // save meets them).
    function repoint( mine, acct, msg, stale, keep )
    {
        var key = function ( name, size ) { return name + "\u0000" + ( size || 0 ); };
        var free = {}, lost = [];
        ( ( msg && msg.parts ) || [] ).forEach( function ( p ) { if( ! p.inline ) ( free[ key( p.name, p.size ) ] = free[ key( p.name, p.size ) ] || [] ).push( p ); } );
        var want = {};
        mine.files.forEach( function ( f ) { if( f.kind === "keep" && stale( f ) ) want[ key( f.name, f.size ) ] = ( want[ key( f.name, f.size ) ] || 0 ) + 1; } );
        mine.files = mine.files.filter( function ( f )
        {
            if( f.kind !== "keep" || ! stale( f ) ) return true;
            var k = key( f.name, f.size ), ps = free[ k ] || [];
            if( ps.length && ps.length === want[ k ] )
            {
                var p = ps.shift();
                want[ k ]--;
                f.acct = acct; f.ref = msg.ref; f.part = p.id;
                return true;
            }
            lost.push( f.name );
            return !! keep;
        } );
        return lost;
    }

    // A copy back in the writer, as verdict says. Not "replace": a draft of
    // its own (a new Message-ID, nothing to take the place of), its kept
    // files read from the server's newest draft when theirs is gone.
    async function resume( d, all, how )
    {
        var mine = await fromLocal( d );
        if( C || ! await holdLid( mine, true ) ) return false;     // another tab has it on screen
        if( C ) { dropLid( mine ); return false; }
        if( how !== "replace" )
        {
            mine.mid = newMid( mine.acct );
            mine.draftRef = mine.draftAcct = "";
            mine.staleDraft = null;
            if( all.length ) repoint( mine, d.acct, all[ 0 ], function ( f ) { return E.roleOf( f ) === "drafts" && f.ref !== all[ 0 ].ref; }, true );
        }
        reopen( mine, d.fields );
        NayiveUI.toast( E.T( how === "apart" ? "mail.restoredApart" : "mail.restoredLocal" ), { ms: 6000 } );
        return true;
    }

    // No draft of it on the server: kept as a new draft, discarded (the
    // dialog is the question - no second one), or later (it stays here).
    function askOrphan( d )
    {
        var f = d.fields || {};
        var what = words( f.subject ) || words( htmlText( f.html ) ).slice( 0, 60 ) || E.T( "mail.noSubject" );
        return NayiveUI.confirm( { title: E.T( "mail.orphanTitle" ), body: E.TF( "mail.orphanBody", { what: what } ),
                                   confirm: E.T( "mail.orphanKeep" ), other: E.T( "mail.orphanDrop" ), otherIcon: "trash",
                                   cancel: E.T( "mail.orphanLater" ) } );
    }

    // eMail opening: the newest copy left by a writer that is gone (a tab
    // closed, a window's ×, a page the phone killed, a sign-in), by its
    // verdict. One comes back per opening; those whose words reached Drafts
    // after all only go.
    var restoring = false;
    E.restoreLocal = async function ()
    {
        if( C || restoring || ! S.accounts.length ) return;
        restoring = true;
        try
        {
            if( ! S.user ) await E.whoami();
            if( ! S.user ) return;
            sweepBytes();
            var all = await localAll(), live = await liveLids();
            for( var i = 0; i < all.length && ! C; i++ )
            {
                var d = all[ i ];
                if( live.has( d.lid ) ) continue;             // on screen in another tab
                var got = await serverDrafts( d.acct, d.mid );
                if( ! got || C ) return;                     // no answer: another time
                var how = verdict( d, got.all );
                if( how === "drop" ) { localDrop( { lid: d.lid } ); continue; }
                if( how === "ask" )
                {
                    var a = await askOrphan( d );
                    if( a === "other" ) { localDrop( { lid: d.lid } ); continue; }
                    if( a !== true ) return;                 // later: it stays here
                }
                await resume( d, got.all, how );
            }
        }
        finally { restoring = false; }
    };

    // A draft opened from the tray that has a copy here (written on it, or
    // with its Message-ID - also one whose first save never answered): by
    // its verdict; "drop" opens the draft as it is.
    async function reopenLocal( acct, msg )
    {
        if( ! S.user ) return false;
        var all = await localAll(), live = await liveLids();
        var d = all.filter( function ( r )
        {
            return ! live.has( r.lid ) && ( r.draftAcct || r.acct ) === acct && ( r.draftRef === msg.ref || ( msg.mid && r.mid === msg.mid ) );
        } )[ 0 ];
        if( ! d ) return false;
        var how = verdict( d, [ msg ] );
        if( how === "drop" ) { localDrop( { lid: d.lid } ); return false; }
        return resume( d, [ msg ], how );
    }

    // A save answered "gone" (mail-chat #2, #15): a file it keeps is read
    // from a draft - or a mail - that is no longer there (another device
    // re-saved or sent that draft; a forward's original moved; the parts of
    // a new draft did not add up). Each kept file's source is asked for; a
    // gone one is read from the newest draft with this writer's Message-ID
    // instead (by name), or - with none - left out, saying which to add
    // again. A newest draft that is not this writer's own (another device's)
    // is never replaced: this writer goes on as a draft of its own (a new
    // Message-ID). Then it saves again: a writer is never left where no save
    // can succeed. True when it changed something.
    async function heal( mine, acct )
    {
        if( mine.healing ) return false;
        mine.healing = true;
        try
        {
            var srcs = {}, gone = {};
            mine.files.forEach( function ( f ) { if( f.kind === "keep" ) srcs[ f.acct + "|" + f.ref ] = f; } );
            for( var k in srcs )
            {
                try { await E.api( "GET", encodeURIComponent( srcs[ k ].acct ) + "/msg/" + encodeURIComponent( srcs[ k ].ref ) ); }
                catch( e ) { if( e.code !== "gone" ) return false; gone[ k ] = true; }      // no answer: the next save tries again
            }
            if( ! Object.keys( gone ).length ) return false;
            var got = await serverDrafts( acct, mine.mid );
            if( ! got ) return false;
            var msg = got.all[ 0 ] || null;
            if( msg && msg.ref !== mine.draftRef ) mine.mid = newMid( acct );
            var lost = repoint( mine, acct, msg, function ( f ) { return gone[ f.acct + "|" + f.ref ]; } );
            // a file left out that this writer's own draft still holds: that
            // draft stays as it is (the next save would replace it, and the
            // file with it) - the writer goes on as a draft of its own
            if( lost.length && msg && msg.ref === mine.draftRef )
            {
                mine.mid = newMid( acct );
                mine.draftRef = mine.draftAcct = "";
            }
            if( C === mine ) { renderFiles(); E.$( "cStatus" ).textContent = ""; }
            if( lost.length ) NayiveUI.toast( E.TF( "mail.filesGone", { names: lost.join( ", " ) } ), { ms: 8000 } );
            mine.dirty = true;
            // now (with files the next save would wait a minute) - not while
            // Send is on: it saves by itself
            if( C === mine && ! mine.sending ) { localSoon( mine ); saveDraft(); }
            return true;
        }
        catch( e ) { return false; }
        finally { mine.healing = false; }
    }

    // ---------------------------------------------------------------------
    // THE CLOSE GUARD (data-safety I1, I4)
    //
    // The desktop asks window.nayiveBeforeClose before its × closes this
    // window (desktop/index.html close): what is not in Drafts goes now, and
    // when it cannot, the user is asked - the copy on this device stays
    // either way. A tab closed or reloaded: beforeunload, while something is
    // not in Drafts. The page going (pagehide): the copy here now, and the
    // newest words to the server - when a save is still on its way, they
    // go in a keepalive request of their own (that save's `again` would run
    // after the page is gone, mail-chat #10).
    // ---------------------------------------------------------------------

    window.nayiveBeforeClose = async function ()
    {
        var mine = C;
        if( ! mine || mine.sending || mine.closing || ! mine.typed || empty() ) return true;
        mine.closing = true;
        try
        {
            mine.dirty = mine.dirty || ! mine.draftRef;
            if( mine.dirty || mine.saving )
            {
                await saveDraft();
                while( mine.saving ) await mine.saving;
            }
            if( C !== mine || ! pending( mine ) ) return true;
            localNow( mine );
            return await NayiveUI.confirm( { title: E.T( "mail.unsavedTitle" ),
                                             body: E.TF( "mail.unsavedBody", { why: E.errText( mine.failed ) } ),
                                             confirm: E.T( "mail.closeAnyway" ) } );
        }
        finally { mine.closing = false; }
    };

    function leavingSave( mine )
    {
        var acct = mine.acct, fd = form( acct, mine );
        if( ! fd.small ) return;            // the copy here keeps it
        try
        {
            fetch( "/api/mail/" + encodeURIComponent( acct ) + "/draft",
                   { method: "POST", credentials: "same-origin", body: fd, keepalive: true, headers: E.owned( {} ) } ).catch( function () {} );
        }
        catch( e ) {}
    }

    // gone: the page itself is going (pagehide), not only out of sight -
    // only then does a save on its way get a second, keepalive one (out of
    // sight the page lives on, and its own `again` follows; two saves from
    // the same draft would leave two drafts).
    function goingAway( gone )
    {
        if( ! C || C.sending ) return;
        if( pending( C ) ) localNow( C );
        if( ! C.dirty ) return;
        if( ! C.saving ) saveDraft();
        else if( gone === true ) leavingSave( C );
    }

    // ---------------------------------------------------------------------
    // address suggestions
    // ---------------------------------------------------------------------

    var sugField = null, sugItems = [], sugAt = -1;

    function norm( s ) { return String( s || "" ).toLowerCase().normalize( "NFD" ).replace( /[̀-ͯ]/g, "" ); }

    function suggest( input )
    {
        var v = input.value, cut = Math.max( v.lastIndexOf( "," ), v.lastIndexOf( ";" ) );
        var word = norm( v.slice( cut + 1 ).trim() );
        if( ! book || word.length < 1 ) { hideSuggest(); return; }
        var have = norm( v );
        sugItems = book.filter( function ( c )
        {
            return ( norm( c.name ).indexOf( word ) >= 0 || norm( c.email ).indexOf( word ) >= 0 ) && have.indexOf( norm( c.email ) ) < 0;
        } ).slice( 0, 6 );
        if( ! sugItems.length ) { hideSuggest(); return; }
        sugField = input;
        sugAt = 0;
        var box = E.$( "cSuggest" );
        box.textContent = "";
        sugItems.forEach( function ( c, i )
        {
            box.appendChild( h( "button", { class: "mail-sug" + ( i === 0 ? " is-at" : "" ), attrs: { type: "button", role: "option" },
                                            on: { mousedown: function ( e ) { e.preventDefault(); pick( i ); } } },
                                h( "b", { text: c.name || c.email } ), c.name ? h( "small", { text: c.email } ) : null ) );
        } );
        var r = input.getBoundingClientRect(), host = E.$( "composeView" ).getBoundingClientRect();
        box.style.left = ( r.left - host.left ) + "px";
        box.style.top = ( r.bottom - host.top + 4 ) + "px";
        box.style.width = r.width + "px";
        box.hidden = false;
    }

    function hideSuggest() { E.$( "cSuggest" ).hidden = true; sugField = null; sugItems = []; }

    function pick( i )
    {
        var c = sugItems[ i ], input = sugField;
        if( ! c || ! input ) return;
        var v = input.value, cut = Math.max( v.lastIndexOf( "," ), v.lastIndexOf( ";" ) );
        input.value = ( cut >= 0 ? v.slice( 0, cut + 1 ) + " " : "" ) + addrText( { name: c.name, addr: c.email } ) + ", ";
        hideSuggest();
        input.focus();
        changed();
    }

    function suggestKeys( e )
    {
        if( E.$( "cSuggest" ).hidden ) return;
        var rows = E.$( "cSuggest" ).children;
        if( e.key === "ArrowDown" || e.key === "ArrowUp" )
        {
            e.preventDefault();
            sugAt = ( sugAt + ( e.key === "ArrowDown" ? 1 : -1 ) + rows.length ) % rows.length;
            [].forEach.call( rows, function ( r, i ) { r.classList.toggle( "is-at", i === sugAt ); } );
        }
        else if( e.key === "Enter" || e.key === "Tab" ) { e.preventDefault(); pick( sugAt ); }
        else if( e.key === "Escape" ) { e.stopPropagation(); hideSuggest(); }
    }

    // ---------------------------------------------------------------------
    // wiring
    // ---------------------------------------------------------------------

    E.isComposing = function () { return !! C; };
    // the text as it goes out, plain (tools/email-test reads it)
    E.composeText = function () { return C ? plainText( E.$( "cText" ) ) : ""; };

    document.addEventListener( "DOMContentLoaded", function ()
    {
        E.$( "composeBtn" ).addEventListener( "click", function () { E.compose( { mode: "new" } ); } );
        E.$( "cSend" ).addEventListener( "click", send );
        E.$( "cDiscard" ).addEventListener( "click", discard );
        E.$( "cAttach" ).addEventListener( "click", function ( e ) { e.stopPropagation(); toggleAttach(); } );
        E.$( "cFileInput" ).addEventListener( "change", function ( e )
        {
            addFiles( [].map.call( e.target.files || [], upFile ) );
            e.target.value = "";
        } );
        // the clip's panel closes on a tap elsewhere, Escape, or a resize
        document.addEventListener( "click", function ( e ) { if( attach && ! attach.contains( e.target ) ) closeAttach(); } );
        document.addEventListener( "keydown", function ( e ) { if( attach && e.key === "Escape" ) { e.stopPropagation(); closeAttach(); } }, true );
        window.addEventListener( "resize", closeAttach );
        E.$( "cCcBtn" ).addEventListener( "click", function ()
        {
            E.$( "cCcRow" ).hidden = false;
            E.$( "cBccRow" ).hidden = false;
            E.$( "cCcBtn" ).hidden = true;
            E.$( "cCc" ).focus();
        } );
        E.$( "cFrom" ).addEventListener( "change", fromChanged );
        startEditor();
        [ "cTo", "cCc", "cBcc", "cSubject" ].forEach( function ( id )
        {
            E.$( id ).addEventListener( "input", changed );
        } );
        document.querySelectorAll( "#composeView [data-addr]" ).forEach( function ( input )
        {
            input.addEventListener( "input", function () { suggest( input ); } );
            input.addEventListener( "keydown", suggestKeys );
            input.addEventListener( "blur", function () { setTimeout( hideSuggest, 150 ); } );
        } );
        // the phone's Back leaves the message being written (saved)
        window.addEventListener( "popstate", function () { if( C ) E.closeCompose( false ); } );
        // the page going to the background (another app, the phone locked) or
        // closing: whatever is pending goes out now - timers stop back there
        // (THE CLOSE GUARD)
        document.addEventListener( "visibilitychange", function () { if( document.hidden ) goingAway( false ); } );
        window.addEventListener( "pagehide", function () { goingAway( true ); } );
        window.addEventListener( "beforeunload", function ( e )
        {
            if( ! C || C.sending || ! pending( C ) || empty() ) return;
            e.preventDefault();
            e.returnValue = "";
        } );
    } );
} )();
