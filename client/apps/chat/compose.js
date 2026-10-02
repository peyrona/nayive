/*
 * compose.js - writing (the bar at the bottom, emoji, the clip's panel, the
 * Send button held down: without sound, or scheduled), holding a message down
 * (react, reply, forward, copy, edit, info, delete), and searching inside a
 * conversation. See core.js.
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h, T = C.T;

    var ta, cbox, quoteSlot, sendBtn, laterBtn, composer, panel = null;
    var laterSheet = null;     // the open list of scheduled texts: { render, close }
    var lastTyping = 0;

    var EMOJIS = ( "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😜 🤪 🤗 🤔 🤐 😐 😏 😒 🙄 😬 😌 😔 😴 😷 🤒 🥳 " +
                   "😎 🤓 😕 😟 😮 😲 😳 🥺 😢 😭 😱 😤 😡 👍 👎 👌 ✌️ 🤞 🤝 🙏 👏 🙌 💪 👋 ❤️ 🧡 💛 💚 💙 💜 " +
                   "🖤 💔 💯 ✨ 🔥 🎉 🎂 🎁 ☀️ 🌧️ ⛄ 🌹 🍷 🍺 ☕ 🍕 🚗 ✈️ 🏠 ⚽ 📷 ⏰ ✅ ❌ ❓ ❗" ).split( " " );
    var QUICK = [ "👍", "❤️", "😂", "😮", "😢", "🙏" ];

    // ---------------------------------------------------------------------
    // the bar at the bottom
    // ---------------------------------------------------------------------

    C.buildComposer = function ()
    {
        ta = h( "textarea", { attrs: { rows: "1", placeholder: T( "chat.message" ), "aria-label": T( "chat.message" ),
                                       enterkeyhint: "send" } } );
        quoteSlot = h( "div" );
        // The clock shows only while this chat has texts of mine scheduled
        // (Telegram's place for it); a tap lists them.
        laterBtn = C.btn( "clock", "chat.scheduledList", openLaterList, "later-btn" );
        laterBtn.hidden = true;
        // (the ids: the chat's "?" help finds them)
        var emojiBtn  = C.btn( "smile", "chat.emoji", function () { togglePanel( "emoji" ); } );
        var attachBtn = C.btn( "clip", "chat.attach", function () { togglePanel( "attach" ); } );
        var camBtn    = C.btn( "camera", "chat.camera", function () { C.pickFiles( "camera" ); } );
        emojiBtn.id  = "emojiBtn";
        attachBtn.id = "attachBtn";
        camBtn.id    = "cameraBtn";
        var row1 = h( "div", { class: "row1" }, emojiBtn, ta, laterBtn, attachBtn, camBtn );
        cbox = h( "div", { class: "cbox" }, quoteSlot, row1 );
        sendBtn = h( "button", { class: "send", attrs: { type: "button", title: T( "chat.sendMsg" ), "aria-label": T( "chat.sendMsg" ) },
                                 on: { click: function () { send(); } } } );
        sendBtn.appendChild( C.ic( "send" ) );
        composer = h( "div", { class: "composer", attrs: { id: "composer" } }, cbox, sendBtn );
        wireSendHold();

        ta.addEventListener( "input", function ( e ) { smiley( e ); grow(); typing(); C.keepDraft(); } );
        ta.addEventListener( "keydown", function ( e )
        {
            if( e.key === "Backspace" && unSmiley() ) { e.preventDefault(); grow(); return; }
            if( e.key === "Enter" && ! e.shiftKey && ! e.isComposing && matchMedia( "(pointer: fine)" ).matches )
            {
                e.preventDefault();
                send();
            }
            else if( e.key === "Escape" && ( S.replyTo || S.editing ) ) { e.preventDefault(); C.resetComposer(); }
        } );
        document.addEventListener( "click", function ( e )
        {
            if( panel && ! panel.contains( e.target ) && ! e.target.closest( ".cbox .icon-btn" ) ) closePanel();
        } );
        return composer;
    };

    function grow()
    {
        // Hidden (the chat is not on screen yet) there is nothing to measure:
        // leave it to its one-row CSS size.
        if( ! ta.offsetParent ) { ta.style.height = ""; return; }
        ta.style.height = "auto";
        ta.style.height = Math.min( ta.scrollHeight, 140 ) + "px";
    }

    function typing()
    {
        if( ! S.open || ! ta.value.trim() || S.editing ) return;
        if( Date.now() - lastTyping < 4000 ) return;
        lastTyping = Date.now();
        C.api( "POST", "conv/" + S.open + "/typing" ).catch( function () {} );
    }

    // Emoticons become emoji as you write: ":-) " turns into "🙂 " once the
    // space (or a new line) after it is typed, and a trailing one on Send.
    // Only a whole word counts, so "http://x" or "a:)b" stay as they are.
    // A Backspace right after the swap gives the emoticon back.
    var SMILEYS = { ":)": "🙂", ":-)": "🙂", ":(": "🙁", ":-(": "🙁", ":D": "😃", ":-D": "😃",
                    ";)": "😉", ";-)": "😉", ":P": "😛", ":-P": "😛", ":p": "😛", ":-p": "😛",
                    ":O": "😮", ":-O": "😮", ":o": "😮", ":-o": "😮", ":'(": "😢", ":'-(": "😢",
                    ":*": "😘", ":-*": "😘", ":|": "😐", ":-|": "😐", ":/": "😕", ":-/": "😕",
                    "B-)": "😎", "8-)": "😎", "XD": "😆", "xD": "😆", ">:(": "😠", ">:-(": "😠",
                    "O:)": "😇", "O:-)": "😇", "^^": "😊", "^_^": "😊", "<3": "❤️", "</3": "💔" };
    var lastSwap = null;       // { at: caret after the swap, emoji, word }

    function smiley( e )
    {
        lastSwap = null;
        if( ! e || ! e.inputType || e.inputType.indexOf( "insert" ) !== 0 || e.inputType === "insertFromPaste" ) return;
        var pos = ta.selectionStart;
        if( pos !== ta.selectionEnd || pos < 2 || ! /\s/.test( ta.value.charAt( pos - 1 ) ) ) return;
        var m = /(^|\s)(\S+)$/.exec( ta.value.slice( 0, pos - 1 ) );
        if( ! m || ! SMILEYS[ m[ 2 ] ] ) return;
        var start = pos - 1 - m[ 2 ].length, emoji = SMILEYS[ m[ 2 ] ];
        ta.setRangeText( emoji, start, pos - 1, "end" );
        var at = start + emoji.length + 1;
        ta.setSelectionRange( at, at );
        lastSwap = { at: at, emoji: emoji, word: m[ 2 ] };
    }

    function unSmiley()
    {
        var s = lastSwap;
        lastSwap = null;
        if( ! s || ta.selectionStart !== s.at || ta.selectionEnd !== s.at ) return false;
        var from = s.at - 1 - s.emoji.length;
        if( ta.value.slice( from, s.at - 1 ) !== s.emoji ) return false;
        ta.setRangeText( s.word, from, s.at - 1, "end" );
        ta.setSelectionRange( from + s.word.length + 1, from + s.word.length + 1 );
        return true;
    }

    function smileyTail( text )
    {
        var m = /(^|\s)(\S+)$/.exec( text );
        return m && SMILEYS[ m[ 2 ] ] ? text.slice( 0, text.length - m[ 2 ].length ) + SMILEYS[ m[ 2 ] ] : text;
    }

    C.focusComposer = function () { try { ta.focus(); } catch( _ ) {} };

    // A shared link, ready to send (chat.js ?text=). After the words already
    // written in that chat, never over them (J3).
    C.fillComposer = function ( text )
    {
        ta.value = ta.value.trim() ? ta.value.replace( /\s+$/, "" ) + " " + text : text;
        grow();
        C.keepDraft();
    };

    // keep: the box only (another chat opening) - that chat's kept words
    // stay. Otherwise they go too: sent, scheduled, the edit or the reply
    // given up.
    C.resetComposer = function ( keep )
    {
        S.replyTo = null;
        S.editing = null;
        if( quoteSlot ) quoteSlot.textContent = "";
        if( ta ) { ta.value = ""; grow(); }
        closePanel();
        if( ! keep ) C.keepDraft();
    };

    // ---------------------------------------------------------------------
    // WHAT IS BEING WRITTEN, per chat (data-safety J3, mail-chat #26)
    //
    // The box's words - and the message they edit, while it is an edit -
    // are kept per chat as they are typed: in memory, and in localStorage
    // ("nayive-chat-draft:<whose>|<world>|<chat>", one item per chat, so two
    // windows never write over each other's). Opening another chat - a click
    // in the list, a notification tapped while writing, a shared link -
    // leaves them there; they come back when that chat opens again, also
    // after a reload. Sent, scheduled, or the box emptied: they go.
    // ---------------------------------------------------------------------

    var drafts = {};          // key -> { text, edit }: this page's own copy (localStorage may refuse)

    function draftKey( conv ) { return "nayive-chat-draft:" + ( C.scope() || "?" ) + "|" + C.W( conv ).api + "|" + conv; }

    C.keepDraft = function ()
    {
        if( ! S.open || ! ta ) return;
        var k = draftKey( S.open );
        var d = ta.value.trim() || S.editing ? { text: ta.value, edit: S.editing ? S.editing.id : 0 } : null;
        if( d ) drafts[ k ] = d;
        else delete drafts[ k ];
        if( ! C.scope() ) return;          // whose is not known yet: this page only
        try { if( d ) localStorage.setItem( k, JSON.stringify( d ) ); else localStorage.removeItem( k ); } catch( _ ) {}
    };

    function draftOf( conv )
    {
        var k = draftKey( conv );
        if( drafts[ k ] ) return drafts[ k ];
        try { return JSON.parse( localStorage.getItem( k ) || "null" ); } catch( _ ) { return null; }
    }

    // A chat's kept words, back in the box (conv.js openConv). Its edit, if
    // it was one, once the messages are in: C.restoreEdit.
    C.restoreDraft = function ( conv )
    {
        var d = draftOf( conv );
        if( ! d || ! ta ) return null;
        ta.value = d.text || "";
        grow();
        return d;
    };

    C.restoreEdit = function ( conv, d )
    {
        if( ! d || ! d.edit || S.open !== conv || S.editing ) return;
        var m = S.msgs.get( d.edit );
        if( ! m || m.deleted || m.from !== C.me() ) return;     // gone (or not loaded): the words stay, as a new message
        var text = ta.value;
        C.editMsg( m );
        ta.value = text;
        grow();
        C.keepDraft();
    };

    // A text scheduled from a chat no longer on screen: its kept copy goes
    // (or it would come back, ready to go a second time).
    function dropDraftIf( conv, text )
    {
        var d = draftOf( conv );
        if( ! d || String( d.text || "" ).trim() !== text ) return;
        var k = draftKey( conv );
        delete drafts[ k ];
        try { localStorage.removeItem( k ); } catch( _ ) {}
    }

    function quoteBar( title, text, color )
    {
        quoteSlot.textContent = "";
        var x = C.btn( "x", "ui.cancel", function () { C.resetComposer(); }, "x" );
        quoteSlot.appendChild( h( "span", { class: "quote", data: { c: String( color ) } },
                                  h( "b", { text: title } ), h( "span", { text: text } ), x ) );
    }

    C.replyTo = function ( m )
    {
        S.editing = null;
        S.replyTo = m;
        quoteBar( C.nameOf( m.from ), C.preview( m )[ 1 ], C.colorOf( m.from ) );
        C.focusComposer();
    };

    C.editMsg = function ( m )
    {
        S.replyTo = null;
        S.editing = m;
        quoteBar( T( "chat.editing" ), C.preview( m )[ 1 ], 0 );
        ta.value = m.text || "";
        grow();
        C.keepDraft();
        C.focusComposer();
    };

    // opts.silent: "Send without sound" (the Send button held down).
    async function send( opts )
    {
        var text = smileyTail( ta.value.trim() );
        if( ! S.open ) return;
        // The server's limit (chat.go chatMaxText, in runes): over it, a send
        // is refused and its retry fails for ever. The text stays in the box.
        if( Array.from( text ).length > 4000 ) { C.toast( "chat.tooLong", 4000 ); return; }
        if( S.editing )
        {
            var m = S.editing, conv = S.open;
            if( ! text && m.kind === "text" ) return;
            C.resetComposer();
            try
            {
                var out = await C.api( "PATCH", "conv/" + conv + "/messages/" + m.id, { text: text } );
                S.msgs.set( out.id, out );
                C.redraw( out.id );
            }
            catch( e )
            {
                C.fail( e );
                // The edit is not lost: it goes back in the box, still an
                // edit - unless the box was used for something else meanwhile.
                if( S.open === conv && ! S.editing && ! S.replyTo && ! ta.value )
                {
                    C.editMsg( m );
                    ta.value = text;
                    grow();
                    C.keepDraft();
                }
            }
            return;
        }
        if( ! text ) { C.focusComposer(); return; }
        var reply = S.replyTo ? S.replyTo.id : 0;
        C.resetComposer();
        C.focusComposer();
        var body = { kind: "text", text: text, replyTo: reply };
        if( opts && opts.silent ) body.silent = true;
        C.sendMsg( body );
    }

    // ---------------------------------------------------------------------
    // the Send button held down (or right-clicked): send without sound, or
    // schedule it - Telegram's two, with something written and not while
    // editing a message
    // ---------------------------------------------------------------------

    function wireSendHold()
    {
        var timer = null, held = false;
        sendBtn.addEventListener( "contextmenu", function ( e ) { e.preventDefault(); openSendMenu(); } );
        sendBtn.addEventListener( "pointerdown", function ( e )
        {
            held = false;
            if( e.pointerType === "mouse" ) return;
            timer = setTimeout( function () { timer = null; held = true; openSendMenu(); }, 480 );
        } );
        function stop() { clearTimeout( timer ); timer = null; }
        sendBtn.addEventListener( "pointerup", stop );
        sendBtn.addEventListener( "pointercancel", stop );
        sendBtn.addEventListener( "pointerleave", stop );
        // The tap that ends a hold is not a send (capture: before the send itself).
        sendBtn.addEventListener( "click", function ( e )
        {
            if( ! held ) return;
            held = false;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true );
    }

    // A small menu over the button; it lives in the composer like the clip's
    // panel, so a click elsewhere (or a new chat) closes it the same way.
    function openSendMenu()
    {
        if( ( panel && panel.dataset.which === "send" ) || ! S.open || S.editing || ! ta.value.trim() ) return;
        closePanel();
        var menu = h( "div", { class: "top-menu send-menu", attrs: { role: "menu" } } );
        function item( icon, key, fn )
        {
            menu.appendChild( h( "button", { class: "menu-item", attrs: { type: "button", role: "menuitem" },
                                             on: { click: function () { closePanel(); fn(); } } }, C.ic( icon ), T( key ) ) );
        }
        item( "bell-off", "chat.sendSilent", function () { send( { silent: true } ); } );
        item( "clock", "chat.schedule", schedule );
        panel = menu;
        panel.dataset.which = "send";
        composer.appendChild( panel );
        if( navigator.vibrate ) try { navigator.vibrate( 15 ); } catch( _ ) {}
    }

    // A date input's value ("2026-09-19T21:30") for a moment, in local time.
    function localValue( d )
    {
        function p( n ) { return ( n < 10 ? "0" : "" ) + n; }
        return d.getFullYear() + "-" + p( d.getMonth() + 1 ) + "-" + p( d.getDate() ) + "T" + p( d.getHours() ) + ":" + p( d.getMinutes() );
    }

    function whenLabel( ms ) { return C.dayLabel( ms ) + " " + C.time( ms ); }

    // "Schedule message": the day and time, then the server keeps it and
    // sends it then - this page may be closed by that time.
    function schedule()
    {
        var text = ta.value.trim();
        var conv = S.open;
        if( ! text || ! conv ) return;
        var reply = S.replyTo ? S.replyTo.id : 0;
        var cid = C.rid();                         // one scheduled text, however many taps
        var start = new Date( Date.now() + 60 * 60 * 1000 );
        var input = h( "input", { attrs: { type: "datetime-local", id: "laterAt", step: "60", min: localValue( new Date() ) },
                                  value: localValue( start ) } );
        var ok = h( "button", { attrs: { type: "button", "data-act": "primary", title: T( "chat.schedule" ) } } );
        var sh = C.sheet( T( "chat.schedule" ), h( "div", {},
            h( "div", { class: "field" }, h( "label", { attrs: { for: "laterAt" }, text: T( "chat.scheduleWhen" ) } ), input ),
            h( "p", { class: "hint", text: T( "chat.scheduleHint" ) } ) ), ok, null, "later-sheet" );
        ok.addEventListener( "click", async function ()
        {
            var at = input.value ? new Date( input.value ).getTime() : NaN;   // no zone: local time
            if( ! ( at > Date.now() ) ) { C.toast( "chat.whenPast", 3000 ); input.focus(); return; }
            ok.disabled = true;
            try
            {
                var l = await C.api( "POST", "conv/" + conv + "/later", { text: text, at: at, replyTo: reply, cid: cid } );
                sh.close();
                if( S.open === conv && ta.value.trim() === text ) C.resetComposer();
                else dropDraftIf( conv, text );
                NayiveUI.toast( C.TF( "chat.scheduledFor", { when: whenLabel( l.at ) } ), { ms: 3000 } );
                var c = C.convOf( conv );
                if( c && ! ( c.later || [] ).some( function ( x ) { return x.id === l.id; } ) )
                {
                    c.later = ( c.later || [] ).concat( [ l ] ).sort( function ( a, b ) { return a.at - b.at; } );
                    C.renderLater();
                }
            }
            catch( e ) { ok.disabled = false; C.fail( e ); }
        } );
        input.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); ok.click(); } } );
    }

    // The clock in the bar: shown while the open chat has texts of mine
    // waiting (the summary's "later"), with how many.
    C.renderLater = function ()
    {
        if( ! laterBtn ) return;
        var c = S.open ? C.convOf( S.open ) : null;
        var n = c && c.later ? c.later.length : 0;
        laterBtn.hidden = ! n;
        var b = laterBtn.querySelector( ".badge" );
        if( ! b ) { b = h( "span", { class: "badge" } ); laterBtn.appendChild( b ); }
        b.textContent = String( n );
        if( laterSheet ) laterSheet.render();
    };

    // The list: when each goes, its text, [send now] [delete]. Delete acts at
    // once - the list itself is the question - and "Undo" schedules it again.
    function openLaterList()
    {
        var conv = S.open;
        var body = h( "div", { class: "later-list" } );
        var sh = null;
        function render()
        {
            var c = C.convOf( conv );
            var list = ( c && S.open === conv && c.later ) || [];
            if( ! list.length ) { if( sh ) sh.close(); return; }
            body.textContent = "";
            list.forEach( function ( l )
            {
                body.appendChild( h( "div", { class: "later-row" },
                    h( "div", { class: "t" }, h( "small", { text: whenLabel( l.at ) } ), h( "span", { text: l.text } ) ),
                    C.btn( "send", "chat.sendNow", function () { act( l, true ); } ),
                    C.btn( "trash", "chat.delete", function () { act( l, false ); }, "danger" ) ) );
            } );
        }
        async function act( l, now )
        {
            var went = false;
            try
            {
                if( now ) await C.api( "POST", "conv/" + conv + "/later/" + l.id + "/send" );
                else await C.api( "DELETE", "conv/" + conv + "/later/" + l.id );
            }
            catch( e ) { if( ! e || e.status !== 404 ) { C.fail( e ); return; } went = true; }   // 404: it already went
            var c = C.convOf( conv );
            if( c && c.later ) c.later = c.later.filter( function ( x ) { return x.id !== l.id; } );
            C.renderLater();
            if( now && S.open === conv ) C.loadSince();
            if( ! now && ! went ) NayiveUI.undoToast( T( "ui.toast.deleted" ), function () { reschedule( conv, l ); } );
        }
        render();
        sh = C.sheet( T( "chat.scheduledList" ), body, null, function () { laterSheet = null; } );
        laterSheet = { render: render, close: sh.close };
    }

    // Undo of a deleted scheduled text: the same text, time and reply again
    // (texts only - a scheduled message has no attachments).
    async function reschedule( conv, l )
    {
        try
        {
            var out = await C.api( "POST", "conv/" + conv + "/later", { text: l.text, at: l.at, replyTo: l.replyTo || 0, cid: l.cid || C.rid() } );
            var c = C.convOf( conv );
            if( c && ! ( c.later || [] ).some( function ( x ) { return x.id === out.id; } ) )
            {
                c.later = ( c.later || [] ).concat( [ out ] ).sort( function ( a, b ) { return a.at - b.at; } );
                C.renderLater();
            }
        }
        catch( e ) { C.fail( e ); }
    }

    // Send any JSON message (text, place, contact, poll, a forward) to `conv`
    // (the open one by default), shown at once as "on its way".
    // extra: what only the waiting bubble shows (a photo's local preview).
    // It goes through THE OUTBOX (below) - but a forward (nothing typed in
    // it, its original stays), or a page that cannot keep it (no IndexedDB,
    // whose not known yet), sends it straight, as before.
    C.sendMsg = async function ( body, conv, extra )
    {
        conv = conv || S.open;
        body.cid = body.cid || C.rid();
        if( body.fwdConv || ! C.scope() || ! window.indexedDB ) return sendNow( body, conv, extra );
        var r = { app: "chat:" + body.cid, cid: body.cid, who: C.scope(), api: C.W( conv ).api, conv: conv, body: body,
                  extra: extra && extra.file ? { file: extra.file } : null, at: Date.now(), dead: false };
        outbox.set( r.cid, r );
        outPut( r );
        if( conv === S.open ) unsentTemp( r, extra );
        C.renderList();
        await flow( r.api + "|" + conv, true );
        return null;
    };

    async function sendNow( body, conv, extra )
    {
        var temp = null;
        if( conv === S.open && ! body.fwdConv )
            temp = C.addTemp( Object.assign( {}, body, extra || {}, { cid: body.cid } ) );
        try
        {
            var m = await C.api( "POST", "conv/" + conv + "/messages", body );
            if( temp && S.open === conv ) C.settleTemp( temp, m );
            else if( conv === S.open ) C.loadSince();
            return m;
        }
        catch( e )
        {
            if( temp )
            {
                temp._body = body;
                if( extra ) temp._retry = function () { sendNow( body, conv, extra ); };
                C.failTemp( temp );
            }
            C.fail( e );
            return null;
        }
    }

    C.retry = function ( m )
    {
        if( m._retry ) { C.dropTemp( m ); m._retry(); return; }
        var r = outbox.get( m.cid );
        if( r )
        {
            if( r.dead ) { r.dead = false; outPut( r ); }
            flow( r.api + "|" + r.conv, true );
            return;
        }
        if( ! m._body ) return;
        C.dropTemp( m );
        C.sendMsg( m._body );
    };

    // ---------------------------------------------------------------------
    // THE OUTBOX (data-safety J2, mail-chat #18)
    //
    // A message is kept on this device from the moment Send is pressed until
    // the server has it: IndexedDB "nayive-drafts" (shared/office.js's
    // database of device drafts - sign-out counts what still waits there,
    // asks, and empties it), one record per message, "chat:<cid>". With no
    // network (a lift, a tunnel) or a failing server it waits there, shown
    // in its chat (the clock; the red mark once a try failed - a tap tries
    // again) and in the list, and goes again by itself: when the network is
    // back ("online"), when its chat opens, when the page is seen again, and
    // on the next load. Leaving the chat or reloading never loses it, and it
    // never arrives twice: the server answers a cid it already has with
    // that same message (api_chat.go chatSend). In each chat they go one
    // after the other, in the order written. One the server refuses for good
    // (a 4xx: the chat is gone, I am no longer in it) is "dead": it stops
    // going by itself and no longer holds the others back; its menu (hold
    // it, or right-click) copies or deletes it. Records are this account's
    // (or this link's) only: { app, cid, who, api, conv, body, extra, at,
    // dead }. Not here: a photo or file from this device (media.js upload,
    // its bytes).
    // ---------------------------------------------------------------------

    var outbox = new Map();     // cid -> record: mine, not on the server yet
    var flows  = {};            // "<world api>|<chat>" -> the run sending that chat's, while one is on

    var odb = null;
    function outDb()
    {
        if( odb ) return odb;
        odb = new Promise( function ( resolve )
        {
            var rq;
            try { rq = indexedDB.open( "nayive-drafts", 1 ); }
            catch( _ ) { resolve( null ); return; }
            // the same upgrade as shared/office.js: whoever opens it first makes it
            rq.onupgradeneeded = function () { rq.result.createObjectStore( "drafts", { keyPath: "app" } ); };
            rq.onsuccess = function () { resolve( rq.result ); };
            rq.onerror = rq.onblocked = function () { resolve( null ); };
        } );
        return odb;
    }

    // fn( objectStore ) -> request: its result once the transaction is done (null on any failure).
    function outTx( mode, fn )
    {
        return outDb().then( function ( db )
        {
            if( ! db ) return null;
            return new Promise( function ( resolve )
            {
                try
                {
                    var tx = db.transaction( "drafts", mode );
                    var rq = fn( tx.objectStore( "drafts" ) );
                    tx.oncomplete = function () { resolve( rq && rq.result !== undefined ? rq.result : null ); };
                    tx.onerror = tx.onabort = function () { resolve( null ); };
                }
                catch( _ ) { resolve( null ); }
            } );
        } );
    }

    function outPut( r )
    {
        var rec = { app: r.app, cid: r.cid, who: r.who, api: r.api, conv: r.conv, body: r.body, extra: r.extra, at: r.at, dead: r.dead };
        return outTx( "readwrite", function ( os ) { return os.put( rec ); } );
    }
    function outDel( cid ) { return outTx( "readwrite", function ( os ) { return os.delete( "chat:" + cid ); } ); }

    // What an earlier page left waiting (chat.js, once the list is in).
    C.loadOutbox = async function ()
    {
        if( ! window.indexedDB ) return;
        await C.whoami();
        var who = C.scope();
        if( ! who ) return;
        var all = await outTx( "readonly", function ( os ) { return os.getAll( IDBKeyRange.bound( "chat:", "chat:\uffff" ) ); } ) || [];
        all.forEach( function ( r ) { if( r.who === who && r.cid && ! outbox.has( r.cid ) ) outbox.set( r.cid, r ); } );
        if( S.v >= 0 ) C.checkOutbox();    // the list is in: some waiting for a chat that is gone?
        if( ! outbox.size ) return;
        C.renderList();
        if( S.open ) C.showUnsent( S.open );
        C.flushOutbox();
    };

    // Waiting messages of a chat that is gone - deleted, or I am no longer
    // in it (a world that has loaded - v >= 0 - no longer lists it): they
    // can never go, but they are never thrown away for that - they stay
    // here (sign-out counts them) and a toast says so, once per page. A
    // world that has not loaded (a first try that failed) says nothing.
    // Run once a list has come in (list.js afterLoad).
    var toldGone = false;
    C.checkOutbox = function ()
    {
        if( toldGone ) return;
        var worlds = {};
        [ S ].concat( Object.keys( S.vias ).map( function ( u ) { return S.vias[ u ]; } ) ).forEach( function ( w )
        {
            if( w.v >= 0 && w.api ) worlds[ w.api ] = w.list || [];
        } );
        var n = 0;
        outbox.forEach( function ( r )
        {
            var list = worlds[ r.api ];
            if( list && ! list.some( function ( c ) { return c.id === r.conv; } ) ) n++;
        } );
        if( ! n ) return;
        toldGone = true;
        NayiveUI.toast( C.TF( "chat.waitingGone", { n: n } ), { ms: 6000 } );
    };

    // Every chat's waiting messages on their way again (conv: that chat's only).
    C.flushOutbox = function ( conv )
    {
        var keys = {};
        outbox.forEach( function ( r ) { if( ! r.dead && ( ! conv || r.conv === conv ) ) keys[ r.api + "|" + r.conv ] = true; } );
        return Promise.all( Object.keys( keys ).map( function ( k ) { return flow( k, false ); } ) );
    };

    // One chat's, in the order written. loud: a send just made (or a tap on
    // "try again") - its failure is told; the quiet ones (a reconnect, a
    // load) only change the marks.
    function flow( key, loud )
    {
        var f = flows[ key ];
        if( f ) { f.again = true; f.loud = f.loud || !! loud; return f.done; }
        f = flows[ key ] = { again: true, loud: !! loud };
        f.done = ( async function ()
        {
            try
            {
                while( f.again )
                {
                    f.again = false;
                    var list = waitingIn( key );
                    for( var i = 0; i < list.length; i++ )
                    {
                        if( ! outbox.has( list[ i ].cid ) ) continue;            // deleted meanwhile
                        if( await sendOne( list[ i ], f ) ) continue;
                        list.slice( i + 1 ).forEach( function ( r ) { mark( r, "failed" ); } );   // behind it: they wait too
                        break;
                    }
                }
            }
            finally { delete flows[ key ]; }
        } )();
        return f.done;
    }

    function waitingIn( key )
    {
        return Array.from( outbox.values() ).filter( function ( r ) { return ! r.dead && r.api + "|" + r.conv === key; } )
                    .sort( function ( a, b ) { return a.at - b.at; } );
    }

    // True: sent - or refused for good (the next may go).
    async function sendOne( r, f )
    {
        mark( r, "pending" );
        try
        {
            var m = await C.api( "POST", "conv/" + r.conv + "/messages", r.body, { base: r.api } );
            outbox.delete( r.cid );
            outDel( r.cid );
            var t = tempOf( r );
            if( t ) C.settleTemp( t, m );
            else if( openHere( r ) ) C.loadSince();
            C.renderList();
            return true;
        }
        catch( e )
        {
            var st = e && e.status;
            if( st >= 400 && st < 500 && st !== 401 && st !== 408 && st !== 429 ) { r.dead = true; outPut( r ); }
            mark( r, "failed" );
            if( f.loud ) { f.loud = false; C.fail( e ); }
            return r.dead;
        }
    }

    function openHere( r ) { return S.open === r.conv && C.W( S.open ).api === r.api; }

    // Its bubble in the open chat, if it is that one's.
    function tempOf( r )
    {
        if( ! openHere( r ) ) return null;
        var found = null;
        S.msgs.forEach( function ( m, id ) { if( id < 0 && m.cid === r.cid ) found = m; } );
        return found;
    }

    function mark( r, state )
    {
        var was = r.state;
        r.state = state;
        var t = tempOf( r );
        if( t && ( t.pending !== ( state === "pending" ) || t.failed !== ( state === "failed" ) ) )
        {
            t.pending = state === "pending";
            t.failed  = state === "failed";
            C.redraw( t.id );
        }
        if( was !== state ) C.renderList();
    }

    function unsentTemp( r, extra )
    {
        var look = extra || r.extra || {};
        // a photo from the owner's files ("ref"): its picture, from there
        if( r.body.ref && ! look.localUrl ) look = Object.assign( {}, look, { localUrl: "/api/files?file=" + encodeURIComponent( r.body.ref ) } );
        var t = C.addTemp( Object.assign( {}, r.body, look, { cid: r.cid, at: r.at } ) );
        if( r.state === "failed" || r.dead ) { t.pending = false; t.failed = true; C.redraw( t.id ); }
        return t;
    }

    // The open chat's waiting messages, as bubbles (conv.js openConv).
    C.showUnsent = function ( conv )
    {
        Array.from( outbox.values() ).filter( function ( r ) { return openHere( r ) && r.conv === conv && ! tempOf( r ); } )
             .sort( function ( a, b ) { return a.at - b.at; } )
             .forEach( function ( r ) { unsentTemp( r, null ); } );
    };

    // A chat's newest waiting message, for its row in the list (list.js),
    // and whether one of them failed.
    C.unsentOf = function ( c )
    {
        var api = C.W( c ).api, last = null, failed = false;
        outbox.forEach( function ( r )
        {
            if( r.conv !== c.id || r.api !== api ) return;
            if( ! last || r.at > last.at ) last = r;
            if( r.dead || r.state === "failed" ) failed = true;
        } );
        return last ? { r: last, failed: failed } : null;
    };

    C.isUnsent = function ( m ) { return !! m && m.id < 0 && outbox.has( m.cid ); };

    // Delete one still here (its menu), with "Undo".
    C.dropUnsent = function ( m )
    {
        var r = outbox.get( m.cid );
        C.dropTemp( m );
        if( ! r ) return;               // a failed upload's bubble (media.js): just that
        outbox.delete( r.cid );
        C.renderList();
        NayiveUI.undoToast( T( "chat.deletedToast" ), function ()
        {
            outbox.set( r.cid, r );
            if( S.open === r.conv ) C.showUnsent( r.conv );
            C.renderList();
        }, { onExpire: function () { outDel( r.cid ); } } );
    };

    window.addEventListener( "online", function () { C.flushOutbox(); } );

    // ---------------------------------------------------------------------
    // the emoji and clip panels
    // ---------------------------------------------------------------------

    function closePanel()
    {
        if( panel ) panel.remove();
        panel = null;
    }

    function togglePanel( which )
    {
        var was = panel && panel.dataset.which;
        closePanel();
        if( was === which ) return;
        panel = which === "emoji" ? emojiPanel( function ( e ) { insert( e ); } ) : attachPanel();
        panel.dataset.which = which;
        composer.appendChild( panel );
    }

    function insert( text )
    {
        var a = ta.selectionStart, b = ta.selectionEnd;
        ta.value = ta.value.slice( 0, a ) + text + ta.value.slice( b );
        ta.selectionStart = ta.selectionEnd = a + text.length;
        grow();
        C.keepDraft();
        ta.focus();
    }

    function emojiPanel( pick )
    {
        var el = h( "div", { class: "emojis" } );
        EMOJIS.forEach( function ( e )
        {
            el.appendChild( h( "button", { attrs: { type: "button" }, text: e,
                                           on: { click: function ( ev ) { ev.stopPropagation(); pick( e ); } } } ) );
        } );
        return el;
    }

    function attachPanel()
    {
        // No camera here: it sits beside the clip already (his call,
        // 2026-09-19). A document from this device, or (the owner, who has
        // their files) one already in Nayive - two buttons, no chooser.
        return NayiveUI.attachPanel( [
            [ "file", "chat.localDoc", 4, function () { C.pickFiles( "file" ); } ],
            C.canUseNayive() ? [ "folder", "chat.nayiveDoc", 3, function () { C.pickFromNayive(); } ] : null,
            [ "image", "chat.gallery", 1, function () { C.pickFiles( "gallery" ); } ],
            [ "pin-map", "chat.location", 5, function () { C.openLocationPicker(); } ],
            [ "user", "chat.contact", 2, function () { C.openCardSheet(); } ],
            [ "poll", "chat.poll", 0, function () { C.openPollSheet(); } ]
        ].filter( Boolean ).map( function ( a )
        {
            return { icon: C.ic( a[ 0 ] ), label: T( a[ 1 ] ), color: a[ 2 ], act: a[ 3 ] };
        } ), closePanel );
    }

    // ---------------------------------------------------------------------
    // a bubble's gestures: hold (or right-click, or its caret) = the menu,
    // swipe right = reply
    // ---------------------------------------------------------------------

    C.wireBubble = function ( el, m )
    {
        var caret = h( "button", { class: "caret", attrs: { type: "button", title: T( "chat.menu" ), "aria-label": T( "chat.menu" ) },
                                   on: { click: function ( e ) { e.stopPropagation(); C.openCtx( m ); } } } );
        caret.appendChild( C.ic( "chev-down" ) );
        el.appendChild( caret );

        var timer = null, x0 = 0, y0 = 0, dx = 0, held = false, swiping = false;
        el.addEventListener( "contextmenu", function ( e )
        {
            if( e.target.closest( "a" ) ) return;
            e.preventDefault();
            if( ! held ) C.openCtx( m );
        } );
        el.addEventListener( "pointerdown", function ( e )
        {
            if( e.pointerType === "mouse" ) return;
            x0 = e.clientX; y0 = e.clientY; dx = 0; held = false; swiping = false;
            timer = setTimeout( function ()
            {
                held = true; timer = null;
                var sel = window.getSelection && window.getSelection();   // what the press selected, if anything
                if( sel ) sel.removeAllRanges();
                C.openCtx( m );
            }, 480 );
        } );
        el.addEventListener( "pointermove", function ( e )
        {
            if( e.pointerType === "mouse" || ( ! timer && ! swiping ) ) return;
            var mx = e.clientX - x0, my = e.clientY - y0;
            if( Math.abs( mx ) > 10 || Math.abs( my ) > 10 ) { clearTimeout( timer ); timer = null; }
            if( mx > 12 && Math.abs( my ) < 30 ) swiping = true;
            if( swiping ) { dx = Math.max( 0, Math.min( mx, 90 ) ); el.style.transform = "translateX(" + dx + "px)"; }
        } );
        function up()
        {
            clearTimeout( timer ); timer = null;
            if( swiping ) { el.style.transform = ""; if( dx > 60 ) C.replyTo( m ); }
            swiping = false;
            setTimeout( function () { held = false; }, 400 );
        }
        el.addEventListener( "pointerup", up );
        el.addEventListener( "pointercancel", up );
        el.addEventListener( "dblclick", function ( e ) { if( ! e.target.closest( "a, img, .quote" ) && matchMedia( "(pointer: fine)" ).matches ) C.replyTo( m ); } );
    };

    // A bubble not on the server yet (THE OUTBOX, or a failed upload): a tap
    // on a failed one tries again; held (or right-clicked) - its menu: try
    // again, copy, delete. One still going up (its percent) has neither.
    C.wireUnsent = function ( el, m )
    {
        var timer = null, held = false;
        function menu() { return C.isUnsent( m ) || m.failed; }
        el.addEventListener( "click", function ()
        {
            if( held ) { held = false; return; }      // the end of a hold
            if( m.failed ) C.retry( m );
        } );
        el.addEventListener( "contextmenu", function ( e ) { e.preventDefault(); if( menu() ) C.openCtx( m ); } );
        el.addEventListener( "pointerdown", function ( e )
        {
            held = false;
            if( e.pointerType === "mouse" || ! menu() ) return;
            timer = setTimeout( function () { timer = null; held = true; C.openCtx( m ); }, 480 );
        } );
        function stop() { clearTimeout( timer ); timer = null; }
        el.addEventListener( "pointerup", stop );
        el.addEventListener( "pointercancel", stop );
        el.addEventListener( "pointerleave", stop );
    };

    // ---------------------------------------------------------------------
    // the menu of one message
    // ---------------------------------------------------------------------

    C.openCtx = function ( m )
    {
        if( document.querySelector( ".ctx" ) ) return;
        var mine = m.from === C.me();
        var unsent = m.id < 0;     // still on this device (THE OUTBOX, a failed upload): no reactions, its own three
        var layer = h( "div", { class: "ctx " + ( mine ? "out" : "in" ) } );
        var box = h( "div", { class: "ctx-box" } );
        layer.appendChild( box );

        function close() { layer.remove(); document.removeEventListener( "keydown", esc, true ); }
        function done()  { C.popNav( "ctx" ); close(); }
        function esc( e ) { if( e.key === "Escape" ) { e.preventDefault(); done(); } }

        var reacts = h( "div", { class: "reacts" } );
        var mineReact = ( m.reacts || {} )[ C.me() ];
        QUICK.forEach( function ( e )
        {
            reacts.appendChild( h( "button", { class: e === mineReact ? "on" : "", attrs: { type: "button" }, text: e,
                                               on: { click: function () { done(); C.react( m, e === mineReact ? "" : e ); } } } ) );
        } );
        var moreB = h( "button", { class: "more", attrs: { type: "button", title: T( "chat.moreEmoji" ) },
                                   on: { click: function ( ev )
                                   {
                                       ev.stopPropagation();
                                       reacts.replaceWith( emojiPanel( function ( e ) { done(); C.react( m, e ); } ) );
                                   } } } );
        moreB.appendChild( C.ic( "plus" ) );
        reacts.appendChild( moreB );
        if( ! unsent ) box.appendChild( reacts );

        var copy = C.bubble( m, null );
        copy.querySelectorAll( ".caret" ).forEach( function ( x ) { x.remove(); } );
        box.appendChild( copy );

        var menu = h( "div", { class: "top-menu" } );
        // opensLayer: fn opens a screen with its own "back" step, so it waits
        // until the menu's step is gone (or that step would close it).
        function item( icon, key, fn, danger, opensLayer )
        {
            menu.appendChild( h( "button", { class: "menu-item" + ( danger ? " danger" : "" ), attrs: { type: "button" },
                                             on: { click: function ()
                                             {
                                                 if( opensLayer ) { C.popNav( "ctx", fn ); close(); } else { done(); fn(); }
                                             } } }, C.ic( icon ), T( key ) ) );
        }
        if( unsent )
        {
            if( m.failed ) item( "refresh", "chat.retry", function () { C.retry( m ); } );
            if( m.text || ( m.card && m.card.name ) )
                item( "copy", "chat.copy", function () { C.copyText( m.text || m.card.name ); } );
            menu.appendChild( h( "div", { class: "menu-sep" } ) );
            item( "trash", "chat.delete", function () { C.dropUnsent( m ); }, true );
        }
        else
        {
            item( "reply", "chat.reply", function () { C.replyTo( m ); } );
            item( "forward", "chat.forward", function () { C.openForward( m ); } );
            if( m.text || ( m.card && m.card.name ) )
                item( "copy", "chat.copy", function () { C.copyText( m.text || m.card.name ); } );
            if( mine && ( m.kind === "text" || m.kind === "file" ) )
                item( "edit", "chat.edit", function () { C.editMsg( m ); } );
            // A photo has two: its caption, and (the owner) the picture itself.
            if( m.kind === "photo" && mine ) item( "edit", "chat.editMsg", function () { C.editMsg( m ); } );
            if( m.kind === "photo" && m.id > 0 && C.canEditPhotos() ) item( "image", "chat.editPhoto", function () { C.editPhoto( m ); } );
            // Where it was taken: the server reads it from the photo's GPS.
            if( m.kind === "photo" && m.file && m.file.pos ) item( "pin-map", "photos.seeOnMap", function () { C.openMap( m.file.pos ); }, false, true );
            if( mine ) item( "info", "chat.info", function () { C.msgInfo( m ); } );
            if( mine )
            {
                menu.appendChild( h( "div", { class: "menu-sep" } ) );
                item( "trash", "chat.delete", function () { C.deleteMsg( m ); }, true );
            }
        }
        box.appendChild( menu );

        layer.addEventListener( "click", function ( e ) { if( e.target === layer ) done(); } );
        document.addEventListener( "keydown", esc, true );
        document.body.appendChild( layer );
        C.pushNav( "ctx", close );
        if( navigator.vibrate ) try { navigator.vibrate( 15 ); } catch( _ ) {}
    };

    C.react = async function ( m, emoji )
    {
        try
        {
            var out = await C.api( "POST", "conv/" + S.open + "/messages/" + m.id + "/react", { emoji: emoji } );
            S.msgs.set( out.id, out );
            C.redraw( out.id );
        }
        catch( e ) { C.fail( e ); }
    };

    // Delete for everyone - with "Undo", never a second question. The bubble
    // hides now (by state: a redraw keeps it hidden, conv.js bubble) and the
    // server is told when the Undo is gone (the shared undoToast: 6 s, the
    // next toast, leaving the chat, the page closing).
    var hiding  = new Set();      // "conv:id" of the messages on their way out
    var msgUndo = null;           // the delete whose Undo is on show

    C.msgHidden = function ( id ) { return hiding.has( S.open + ":" + id ); };

    function unhideMsg( conv, id )
    {
        hiding.delete( conv + ":" + id );
        var el = S.open === conv ? S.els.get( id ) : null;
        if( el ) el.hidden = false;
    }

    C.deleteMsg = function ( m )
    {
        var conv = S.open;
        var mine = msgUndo = { id: m.id };
        hiding.add( conv + ":" + m.id );
        var el = S.els.get( m.id );
        if( el ) el.hidden = true;
        NayiveUI.undoToast( T( "chat.deletedToast" ), function ()
        {
            if( msgUndo === mine ) msgUndo = null;
            unhideMsg( conv, m.id );
        }, { onExpire: function ()
        {
            if( msgUndo === mine ) msgUndo = null;
            C.api( "DELETE", "conv/" + conv + "/messages/" + m.id ).then( function ( out )
            {
                hiding.delete( conv + ":" + m.id );
                if( S.open === conv ) { S.msgs.set( out.id, out ); C.redraw( out.id ); }
            }, function ( e ) { unhideMsg( conv, m.id ); C.fail( e ); } );
        } } );
    };

    // Leaving the chat makes a message's delete final now (only that Undo:
    // another one on show - a chat's, the auto-delete - keeps its time).
    C.flushDeletes = function ()
    {
        if( msgUndo ) NayiveUI.undoSettle();
    };

    // ---------------------------------------------------------------------
    // sheets: who reacted, who read it, forward to
    // ---------------------------------------------------------------------

    // A sheet with a title and a body; closes on its × or Escape (and then
    // calls onClose, when given). Escape only while it is the last thing on
    // the page: a sheet or a full-screen layer opened from it goes first.
    C.sheet = function ( title, body, actions, onClose, cls )
    {
        var close = h( "button", { attrs: { type: "button", "data-act": "close", title: T( "ui.close" ) } } );
        var row = h( "div", { class: "sheet-actions" }, close, actions || null );
        var d = NayiveUI.modal( { cls: cls, title: title, escape: done, top: function () { return document.body.lastElementChild === d.back; } } );
        d.sheet.appendChild( body );
        d.sheet.appendChild( row );
        d.show( function () { NayiveUI.applySheetButtons( d.back ); } );
        function done()
        {
            if( d.close() && onClose ) onClose();
        }
        d.back.querySelectorAll( ".sheet-close, .btn-secondary" ).forEach( function ( b ) { b.addEventListener( "click", done ); } );
        return { el: d.back, close: done };
    };

    C.showReactions = function ( m )
    {
        var list = h( "ul", { class: "who-list" } );
        var sh;
        Object.keys( m.reacts || {} ).forEach( function ( p )
        {
            var li = h( "li", {}, C.avatar( p, C.nameOf( p ), "sm" ), h( "span", { text: C.nameOf( p ) } ),
                        h( "span", { class: "em", text: m.reacts[ p ] } ) );
            if( p === C.me() )
            {
                li.appendChild( h( "button", { class: "text-btn ghost", attrs: { type: "button" }, text: T( "chat.remove" ),
                                               on: { click: function () { sh.close(); C.react( m, "" ); } } } ) );
            }
            list.appendChild( li );
        } );
        sh = C.sheet( T( "chat.reactions" ), list );
    };

    C.msgInfo = function ( m )
    {
        var body = h( "div" );
        var me = C.me();
        var others = C.membersOf( S.open ).filter( function ( p ) { return p !== me; } );
        var read = others.filter( function ( p ) { return ( S.read[ p ] || 0 ) >= m.id; } );
        var not  = others.filter( function ( p ) { return ( S.read[ p ] || 0 ) < m.id; } );
        [ [ "chat.readBy", read ], [ "chat.notRead", not ] ].forEach( function ( part )
        {
            if( ! part[ 1 ].length ) return;
            body.appendChild( h( "div", { class: "section-label", text: T( part[ 0 ] ) } ) );
            var ul = h( "ul", { class: "who-list" } );
            part[ 1 ].forEach( function ( p ) { ul.appendChild( h( "li", {}, C.avatar( p, C.nameOf( p ), "sm" ), h( "span", { text: C.nameOf( p ) } ) ) ); } );
            body.appendChild( ul );
        } );
        body.appendChild( h( "p", { class: "hint", style: "margin-top:12px", text: C.TF( "chat.sentAt", { day: C.dayLabel( m.at ), time: C.time( m.at ) } ) } ) );
        C.sheet( T( "chat.msgInfo" ), body );
    };

    C.openForward = function ( m )
    {
        var rows = h( "div", { class: "rows", style: "max-height:60vh;padding-bottom:0" } );
        var sh;
        // Only to chats of the same home: the server copies a message within
        // one home (a chat in another user's home is another world).
        var world = C.W( S.open );
        C.sortedConvs().filter( function ( c ) { return C.W( c ) === world; } ).forEach( function ( c )
        {
            rows.appendChild( h( "button", { class: "row", attrs: { type: "button" },
                on: { click: async function ()
                {
                    sh.close();
                    var out = await C.sendMsg( { fwdConv: S.open, fwdId: m.id }, c.id );
                    if( out ) NayiveUI.toast( C.TF( "chat.forwardedTo", { name: c.name } ), { ms: 2200 } );
                } } },
                C.avatar( c.id, c.name ), h( "div", { class: "body" }, h( "span", { class: "name", text: c.name } ) ) ) );
        } );
        sh = C.sheet( T( "chat.forwardTo" ), rows );
    };

    // ---------------------------------------------------------------------
    // searching inside the open conversation
    // ---------------------------------------------------------------------

    C.startSearch = async function ()
    {
        if( ! S.open ) return;
        try { await C.loadAll(); } catch( _ ) {}
        S.searching = { q: "", hits: [], at: -1 };
        var bar = C.$( "#convBar" );
        bar.textContent = "";
        var input = h( "input", { class: "search-in", attrs: { type: "search", placeholder: T( "chat.searchIn" ), "aria-label": T( "chat.searchIn" ) } } );
        var count = h( "span", { class: "count" } );
        bar.appendChild( C.btn( "back", "ui.close", stopSearch ) );
        bar.appendChild( input );
        bar.appendChild( count );
        bar.appendChild( C.btn( "chev-up", "chat.prevHit", function () { step( -1 ); } ) );
        bar.appendChild( C.btn( "chev-down", "chat.nextHit", function () { step( 1 ); } ) );
        C.pushNav( "search", endSearch );

        function run()
        {
            var q = input.value.trim();
            S.searching.q = q;
            var f = C.fold( q );
            S.searching.hits = ! q ? [] : S.order.filter( function ( id )
            {
                var m = S.msgs.get( id );
                return m && ! m.deleted && ! C.msgHidden( id ) && C.fold( m.text || ( m.file && m.file.name ) || "" ).indexOf( f ) >= 0;
            } );
            S.searching.at = S.searching.hits.length;
            C.renderAll();
            step( -1 );
        }
        function step( d )
        {
            var s = S.searching;
            if( ! s || ! s.hits.length ) { count.textContent = s && s.q ? "0" : ""; return; }
            s.at = Math.max( 0, Math.min( s.hits.length - 1, s.at + d ) );
            count.textContent = ( s.at + 1 ) + "/" + s.hits.length;
            S.els.forEach( function ( el ) { el.classList.remove( "hit" ); } );
            var el = S.els.get( s.hits[ s.at ] );
            if( el ) { el.classList.add( "hit" ); el.scrollIntoView( { block: "center" } ); }
        }
        var t = null;
        input.addEventListener( "input", function () { clearTimeout( t ); t = setTimeout( run, 200 ); } );
        input.addEventListener( "keydown", function ( e )
        {
            if( e.key === "Enter" ) { e.preventDefault(); step( e.shiftKey ? 1 : -1 ); }
        } );
        setTimeout( function () { input.focus(); }, 30 );
    };

    function stopSearch() { C.popNav( "search" ); endSearch(); }

    function endSearch()
    {
        if( ! S.searching ) return;
        S.searching = null;
        C.renderConvHead();
        C.renderAll();
        C.toBottom( false );
    }
} )();
