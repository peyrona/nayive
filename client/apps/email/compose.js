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
 * ADDRESSES: typed freely ("Ana <ana@x.es>, bob@y.com"); the Contacts app's
 * addresses that fit the word being typed show under the field (arrows +
 * Enter, or a tap). The server checks them all before sending.
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
        return { acct: S.acct, mid: "", draftRef: "", draftAcct: "", staleDraft: null,
                 inReplyTo: "", references: [], sig: "",
                 files: [],     // { kind: "keep"|"drive"|"up", name, size, acct?, ref?, part?, path?, file? }
                 dirty: false, typed: false, saving: null, timer: 0, again: false, sending: false };
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
        var fromRead = !! S.open;
        if( S.open ) E.closeMessage( false );
        if( S.selecting ) E.endSelect();
        C = blank();
        if( msg ) C.acct = msg.acct || S.acct;
        var sig = String( S.settings.signature || "" ).replace( /\s+$/, "" );
        C.sig = sig.trim() ? "\n\n-- \n" + sig : "";
        var f = { to: "", cc: "", bcc: "", subject: "", text: C.sig };

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
            f.text = C.sig + "\n\n" + E.TF( "mail.wrote", { date: E.longDate( msg.date ), who: E.whoFull( msg.from ) } ) + "\n" +
                     quote( bodyText( msg ) );
            C.inReplyTo = msg.mid || "";
            C.references = ( msg.references || [] ).concat( msg.mid ? [ msg.mid ] : [] );
        }
        else if( msg )   // forward: the text under a header, and its files
        {
            f.subject = /^(fwd?|rv):/i.test( msg.subject || "" ) ? msg.subject : "Fwd: " + ( msg.subject || "" );
            f.text = C.sig + "\n\n" + E.T( "mail.fwdHeader" ) + "\n" +
                     E.T( "mail.from" ) + ": " + E.whoFull( msg.from ) + "\n" +
                     E.T( "mail.date" ) + ": " + E.longDate( msg.date ) + "\n" +
                     E.T( "mail.subject" ) + ": " + ( msg.subject || "" ) + "\n" +
                     E.T( "mail.to" ) + ": " + E.whoFull( msg.to ) + "\n\n" + bodyText( msg );
            ( msg.parts || [] ).filter( function ( p ) { return ! p.inline; } ).forEach( function ( p )
            {
                C.files.push( { kind: "keep", acct: msg.acct || S.acct, ref: msg.ref, part: p.id, name: p.name, size: p.size } );
            } );
        }
        show( f, fromRead );
        var focus = msg && opts.mode !== "fwd" ? "cText" : "cTo";
        E.$( "cText" ).setSelectionRange( 0, 0 );      // over the signature, not under it
        setTimeout( function ()
        {
            var el = E.$( focus );
            el.focus();
            if( focus === "cText" ) { el.setSelectionRange( 0, 0 ); el.scrollTop = 0; }
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
            // a draft made elsewhere may be HTML only: its words, not nothing
            show( { to: addrs( msg.to ), cc: addrs( msg.cc ), bcc: addrs( msg.bcc ),
                    subject: msg.subject || "", text: msg.text || bodyText( msg ) } );
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
    function quote( text ) { return text.split( "\n" ).map( function ( l ) { return "> " + l; } ).join( "\n" ); }

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
        E.$( "cText" ).value = f.text;
        var cc = !! ( f.cc || f.bcc );
        E.$( "cCcRow" ).hidden = ! cc;
        E.$( "cBccRow" ).hidden = ! cc;
        E.$( "cCcBtn" ).hidden = cc;
        E.$( "cStatus" ).textContent = "";
        renderFiles();
        setWriting( true );
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
        E.$( "backBtn" ).hidden = ! on && ! S.open && ! S.selecting;
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
        var sig = C.sig.trim();
        return ! C.files.length && [ "cTo", "cCc", "cBcc", "cSubject", "cText" ].every( function ( id )
        {
            var v = E.$( id ).value.trim();
            return ! v || ( id === "cText" && v === sig );
        } );
    }

    // What the writer's fields hold now.
    function fieldsNow()
    {
        return { to: E.$( "cTo" ).value, cc: E.$( "cCc" ).value, bcc: E.$( "cBcc" ).value,
                 subject: E.$( "cSubject" ).value, text: E.$( "cText" ).value };
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
            to: fl.to, cc: fl.cc, bcc: fl.bcc, subject: fl.subject, text: fl.text,
            inReplyTo: mine.inReplyTo, references: mine.references, mid: mine.mid,
            draftRef: mine.draftAcct === forDraftIn ? mine.draftRef : "",
            keep: [], drive: []
        };
        var fd = new FormData(), keep = [], drive = [], up = [];
        mine.files.forEach( function ( f )
        {
            if( f.kind === "keep" )  { out.keep.push( { acct: f.acct, ref: f.ref, part: f.part } ); keep.push( f ); }
            if( f.kind === "drive" ) { out.drive.push( f.path ); drive.push( f ); }
            if( f.kind === "up" )    { fd.append( "file", f.file, f.name ); up.push( f ); }
        } );
        var json = JSON.stringify( out );
        fd.append( "json", json );
        fd.sent = keep.concat( drive, up );
        // small, no files: it may outlive the page (a save on leaving)
        fd.small = ! up.length && json.length < 60000;
        return fd;
    }

    async function post( acct, path, fd )
    {
        var res;
        try { res = await fetch( "/api/mail/" + encodeURIComponent( acct ) + "/" + path, { method: "POST", credentials: "same-origin", body: fd, keepalive: !! fd.small } ); }
        catch( e ) { var off = new Error( "offline" ); off.code = "offline"; throw off; }
        var data = null;
        try { data = await res.json(); } catch( e ) {}
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
            }
            catch( err )
            {
                mine.dirty = true;
                mine.failed = err;
                if( C === mine ) E.$( "cStatus" ).textContent = E.errText( err );
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

    function leave( fromCode )
    {
        closeAttach();
        if( C ) clearTimeout( C.timer );
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
        var fromRead = !! S.open;
        if( S.open ) E.closeMessage( false );
        if( S.selecting ) E.endSelect();
        C = mine;
        C.closing = false;
        C.sending = false;
        show( fields, fromRead );
        if( C.dirty ) schedule();
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
            await post( mine.acct, "send", form( mine.acct, mine ) );
            if( mine.draftAcct && mine.draftAcct !== mine.acct ) dropDraft( mine.draftAcct, mine.draftRef );   // written in the other account
            if( mine.staleDraft ) dropDraft( mine.staleDraft.acct, mine.staleDraft.ref );
            E.plug( "synced" );
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
    // place of another Undo on show); when it failed, the writer comes back
    // saying why - its draft is still in Drafts - or, while another one is
    // being written, a toast says so.
    function sendNow( mine, fields )
    {
        E.plug( "saving" );
        post( mine.acct, "send", form( mine.acct, mine, fields ) ).then( function ()
        {
            mine.sending = false;
            E.plug( "synced" );
            if( ! C && ! S.label && ( S.tray === "drafts" || S.tray === "sent" ) && ! S.open && ! S.selecting ) E.loadList( false );
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

    document.addEventListener( "DOMContentLoaded", function ()
    {
        E.$( "composeBtn" ).addEventListener( "click", function () { E.compose( { mode: "new" } ); } );
        E.$( "actReply" ).addEventListener( "click", function () { if( S.msg ) E.compose( { mode: "reply", msg: S.msg } ); } );
        E.$( "actReplyAll" ).addEventListener( "click", function () { if( S.msg ) E.compose( { mode: "all", msg: S.msg } ); } );
        E.$( "actForward" ).addEventListener( "click", function () { if( S.msg ) E.compose( { mode: "fwd", msg: S.msg } ); } );
        E.$( "cSend" ).addEventListener( "click", send );
        E.$( "cDiscard" ).addEventListener( "click", discard );
        E.$( "cAttach" ).addEventListener( "click", function ( e ) { e.stopPropagation(); toggleAttach(); } );
        E.$( "cFileInput" ).addEventListener( "change", function ( e )
        {
            addFiles( [].map.call( e.target.files || [], function ( f ) { return { kind: "up", file: f, name: f.name, size: f.size }; } ) );
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
        [ "cTo", "cCc", "cBcc", "cSubject", "cText" ].forEach( function ( id )
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
        document.addEventListener( "visibilitychange", function () { if( document.hidden && C && C.dirty && ! C.sending ) saveDraft(); } );
        window.addEventListener( "pagehide", function () { if( C && C.dirty && ! C.sending ) saveDraft(); } );
    } );
} )();
