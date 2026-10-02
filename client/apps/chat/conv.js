/*
 * conv.js - one open conversation: its top bar, loading its messages, and
 * drawing them as bubbles. Writing and holding a message down are in
 * compose.js. See core.js for how the chat/*.js files fit together.
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h, T = C.T;

    var wall, wallIn, head, downBtn, convMenu, convMore;
    var loadingOlder = false;
    var newBelow = 0;          // messages that came in while scrolled up
    var tempSeq = -1;          // ids of messages still on their way (negative)

    // ---------------------------------------------------------------------
    // the main pane: an empty screen, or the conversation
    // ---------------------------------------------------------------------

    C.buildMain = function ( main )
    {
        var empty = h( "div", { class: "main-empty", attrs: { id: "vEmpty" } }, C.ic( "chat" ),
                       h( "p", { text: T( S.mode === "owner" ? "chat.pickChat" : "chat.pickChatGuest" ) } ) );
        head   = h( "div", { class: "bar", attrs: { id: "convBar" } } );
        wallIn = h( "div", { class: "wall-in" } );
        wall   = h( "div", { class: "wall", attrs: { id: "wall" } }, wallIn );
        downBtn = h( "button", { class: "down", attrs: { type: "button", hidden: true, title: T( "chat.toBottom" ),
                                  "aria-label": T( "chat.toBottom" ) }, on: { click: function () { C.toBottom( true ); } } },
                     C.ic( "chev-down" ) );
        // In a desktop window as narrow as a phone the list's header is gone
        // while a chat is open: this bar is then the top row, and its empty
        // room drags the window (desktop/index.html, data-win-drag).
        if( NayiveUI.windowed )
        {
            var narrow = window.matchMedia( "(max-width: 640px)" );
            var mark = function () { head.toggleAttribute( "data-win-drag", narrow.matches ); };
            narrow.addEventListener( "change", mark );
            mark();
        }
        var conv = h( "div", { class: "view", attrs: { id: "vConv", hidden: true } }, head, wall, downBtn );
        main.appendChild( empty );
        main.appendChild( conv );
        conv.appendChild( C.buildComposer() );

        wall.addEventListener( "scroll", onScroll, { passive: true } );

        // The chat's "⋮" menu: built once and wired once (the bar is redrawn
        // often; its items are refilled by renderConvHead).
        convMenu = h( "div", { class: "top-menu", attrs: { id: "convMenu", hidden: true } } );
        document.body.appendChild( convMenu );
        convMore = C.btn( "more", "chat.menu", null );
        convMore.id = "convMoreBtn";
        NayiveUI.wireMenu( { btn: convMore, menu: convMenu, onPick: function ( item ) { if( item._act ) item._act(); } } );
    };

    // ---------------------------------------------------------------------
    // opening and closing
    // ---------------------------------------------------------------------

    C.openConv = async function ( id )
    {
        if( ! C.convOf( id ) ) { await C.loadSummary().catch( function () {} ); if( ! C.convOf( id ) ) return; }
        if( C.closeInfoNow ) C.closeInfoNow();
        if( S.open !== id ) C.flushDeletes();
        C.settleConv( id );   // opening a chat just deleted (its "Undo" on show) makes the delete final
        S.open = id;
        S.msgs = new Map();
        S.order = [];
        S.els = new Map();
        S.openRev = 0;
        S.read = {};
        S.more = false;
        S.bandId = 0;
        S.replyTo = null;
        S.editing = null;
        S.searching = null;
        newBelow = 0;
        C.resetComposer();

        C.$( "#vEmpty" ).hidden = true;
        C.$( "#vConv" ).hidden = false;
        C.$( "#chat" ).classList.add( "in-main" );
        C.pushNav( "conv", function () { C.closeConv( false ); } );
        C.renderConvHead();
        C.renderList();
        wallIn.textContent = "";
        if( S.shared ) { C.fillComposer( S.shared ); S.shared = null; }

        try
        {
            var r = await C.api( "GET", "conv/" + id + "/messages" );
            if( S.open !== id ) return;
            ingest( r );
            S.more = !! r.more;
            var me = C.me( id );
            var seen = S.read[ me ] || 0;
            for( var i = 0; i < S.order.length; i++ )
            {
                var m = S.msgs.get( S.order[ i ] );
                if( m.id > seen && m.from !== me ) { S.bandId = m.id; break; }
            }
            C.renderAll();
            if( C.refreshInfo ) C.refreshInfo();     // Info opened before the messages came
            var band = C.$( ".band", wallIn );
            if( band ) band.scrollIntoView( { block: "center" } );
            else C.toBottom( false );
            C.markRead();
        }
        catch( e ) { C.fail( e ); }
        if( ! matchMedia( "(pointer: coarse)" ).matches ) C.focusComposer();
    };

    // Back to the list after a delete from the ⋮: shut the Info screen and
    // the chat, and drop their history steps in one go.
    C.leaveToList = function ()
    {
        if( C.closeInfoNow ) C.closeInfoNow();
        if( S.open ) C.closeConv( false );
        C.resetNav();
    };

    // silent: the conversation went away (deleted), no history step to undo.
    C.closeConv = function ( silent )
    {
        if( ! S.open ) return;
        C.flushDeletes();
        if( silent ) C.popNav( "conv" );
        S.open = null;
        S.msgs = new Map();
        S.order = [];
        S.els = new Map();
        C.$( "#vConv" ).hidden = true;
        C.$( "#vEmpty" ).hidden = false;
        C.$( "#chat" ).classList.remove( "in-main" );
        if( C.closeInfoNow ) C.closeInfoNow();
        C.renderList();
    };

    // ---------------------------------------------------------------------
    // the top bar
    // ---------------------------------------------------------------------

    C.convSubtitle = function ( c )
    {
        var w = C.W( c );
        var typing = w.typing[ c.id ] || [];
        if( c.kind === "d" )
        {
            var other = C.otherOf( c );
            if( typing.length ) return [ "typing", T( "chat.typing" ) ];
            if( w.online.has( other ) ) return [ "", T( "chat.online" ) ];
            if( C.owns( c ) )
            {
                var ct = C.contactOf( other );
                if( ct ) return [ "", C.personState( ct )[ 1 ] ];
            }
            return [ "", "" ];
        }
        if( typing.length ) return [ "typing", C.TF( "chat.isTyping", { name: C.nameOf( typing[ 0 ], c.id ) } ) ];
        // The owner sees how many of the group are connected (a person only
        // ever learns about the owner).
        var on = ( c.members || [] ).filter( function ( p ) { return C.isOnline( p, c.id ); } ).length;
        if( C.owns( c ) && on ) return [ "", C.TF( "chat.nOnline", { n: on } ) ];
        var names = ( c.members || [] ).filter( function ( p ) { return p !== w.me; } )
                                       .map( function ( p ) { return C.nameOf( p, c.id ); } ).concat( [ T( "chat.you" ) ] );
        return [ "", names.join( ", " ) ];
    };

    C.renderConvHead = function ()
    {
        C.renderLater();   // compose.js: the clock of my scheduled texts
        var c = C.convOf( S.open );
        if( ! c || S.searching ) return;
        head.textContent = "";
        var sub = C.convSubtitle( c );
        head.appendChild( C.btn( "back", "chat.back", C.back, "back-btn" ) );
        var av = C.ringIfOnline( C.avatar( c.id, c.name ), c.id );
        av.style.cursor = "pointer";
        av.addEventListener( "click", function () { C.openInfo(); } );   // the picture opens Info too, like the name
        head.appendChild( av );
        // (Auto-delete - one number for every chat - sits on the list's
        // filters row; Info says it in words.)
        head.appendChild( h( "button", { class: "who", attrs: { type: "button", title: T( "chat.chatOptions" ) },
                                         on: { click: function () { C.openInfo(); } } },
            h( "span", { class: "who-top" }, h( "b", { text: c.name } ) ),
            sub[ 1 ] ? h( "small", { class: sub[ 0 ], text: sub[ 1 ] } ) : null ) );
        // [phone] [video] | [⋮] [?] - search, options, mute, pin, a person's link
        // and delete live in the menu. Calls are one to one (call.js): a group
        // has no phone, and neither does a server without coturn. This "?"
        // explains this side only; the list's help explains the list (his
        // call, 2026-09-21).
        // The two groups of every header (shared/app.css HEADER).
        var calls = h( "div", { class: "tb-group" } );
        if( c.kind === "d" && S.callsOn )
        {
            var call  = C.btn( "phone", "chat.voiceCall", function () { C.startCall( false ); } );
            call.id = "convCallBtn";
            var video = C.btn( "video", "chat.videoCall", function () { C.startCall( true ); } );
            video.id = "convVideoBtn";
            calls.appendChild( call );
            calls.appendChild( video );
        }
        var help = C.btn( "help", "chat.help", function () { C.showConvHelp(); } );
        help.id = "convHelpBtn";
        head.appendChild( h( "div", { class: "topbar-actions" }, calls, h( "div", { class: "tb-group tb-sys" }, convMore, help ) ) );

        // [icon, label, action, its line in the "?" help, class]
        convMenu.textContent = "";
        var ct = C.owns( c ) && c.kind === "d" ? C.contactOf( C.otherOf( c ) ) : null;
        [ [ "search", "chat.searchIn", function () { C.startSearch(); }, "chat.helpSearchIn" ],
          [ "info", "chat.chatOptions", function () { C.openInfo(); }, C.owns( c ) ? "chat.helpInfo" : "chat.helpInfoGuest" ],
          [ c.mute ? "bell" : "bell-off", c.mute ? "chat.unmute" : "chat.mute", function () { C.setPref( { mute: ! c.mute } ); }, "chat.helpMute" ],
          [ "pin", c.pin ? "chat.unpin" : "chat.pin", function () { C.setPref( { pin: ! c.pin } ); }, "chat.helpPin" ]
        ].concat( ct && ! ct.user ? [ [ "link", "chat.theirLink", function () { C.showLink( ct ); }, "chat.helpTheirLink" ],   // a Nayive user has no link
                                      [ "refresh", "chat.newLink", function () { C.newLink( ct ); }, "chat.helpNewLink" ] ] : [],
                  [ [ "trash", "chat.delete", function () { C.deleteDialog( c, ct ); },
                      C.owns( c ) ? "chat.helpDelete" : "chat.deleteChatAsk", "danger" ] ] ).forEach( function ( it )
        {
            var b = h( "button", { class: "menu-item" + ( it[ 4 ] ? " " + it[ 4 ] : "" ), attrs: { type: "button" } }, C.ic( it[ 0 ] ), T( it[ 1 ] ) );
            b._act = it[ 2 ];
            b._help = it[ 3 ];
            convMenu.appendChild( b );
        } );
    };

    C.setPref = async function ( pref )
    {
        try
        {
            await C.api( "POST", "conv/" + S.open + "/prefs", pref );
            if( pref.mute !== undefined ) C.toast( pref.mute ? "chat.muted" : "chat.unmuted" );
            await C.loadSummary();
        }
        catch( e ) { C.fail( e ); }
    };

    // ---------------------------------------------------------------------
    // loading
    // ---------------------------------------------------------------------

    function ingest( r )
    {
        ( r.msgs || [] ).forEach( function ( m )
        {
            // a message of ours on its way comes back with its client id
            if( m.cid ) dropTempByCid( m.cid );
            S.msgs.set( m.id, m );
        } );
        S.openRev = Math.max( S.openRev, r.rev || 0 );
        S.read = r.read || S.read;
        var pruned = prune( r.gone || 0 );
        reorder();
        return pruned;
    }

    // The server deleted every message up to `gone` for its age (the owner's
    // auto-delete): they leave the screen too. True when some did.
    function prune( gone )
    {
        var n = 0;
        S.msgs.forEach( function ( m, id )
        {
            if( id > 0 && id <= gone )
            {
                S.msgs.delete( id );
                var el = S.els.get( id );
                if( el ) el.remove();
                S.els.delete( id );
                n++;
            }
        } );
        return n > 0;
    }

    function reorder()
    {
        var real = [], temp = [];
        S.msgs.forEach( function ( m, id ) { ( id > 0 ? real : temp ).push( id ); } );
        real.sort( function ( a, b ) { return a - b; } );
        temp.sort( function ( a, b ) { return b - a; } );          // -1, -2, ... in the order they were made
        S.order = real.concat( temp );
    }

    function dropTempByCid( cid )
    {
        S.msgs.forEach( function ( m, id )
        {
            if( id < 0 && m.cid === cid )
            {
                S.msgs.delete( id );
                var el = S.els.get( id );
                if( el ) el.remove();
                S.els.delete( id );
            }
        } );
    }

    // Everything that changed since the rev we have.
    C.loadSince = async function ()
    {
        var id = S.open;
        if( ! id ) return;
        var since = S.openRev;
        try
        {
            var r = await C.api( "GET", "conv/" + id + "/messages?since=" + since );
            if( S.open !== id ) return;
            var bottom = atBottom();
            var known  = new Set( S.msgs.keys() );
            var temps  = S.order.some( function ( x ) { return x < 0; } );
            var readBefore = JSON.stringify( S.read );
            var pruned = ingest( r );
            var fresh = ( r.msgs || [] ).filter( function ( m ) { return ! known.has( m.id ); } );
            var changed = ( r.msgs || [] ).filter( function ( m ) { return known.has( m.id ); } );

            if( pruned || ( fresh.length && temps ) ) C.renderAll();
            else
            {
                changed.forEach( function ( m ) { C.redraw( m.id ); } );
                fresh.forEach( function ( m ) { appendOne( m ); } );
                // a reply shows its original: redraw the replies to what changed
                changed.forEach( function ( m )
                {
                    S.order.forEach( function ( x ) { var y = S.msgs.get( x ); if( y && y.replyTo === m.id ) C.redraw( x ); } );
                } );
            }
            if( readBefore !== JSON.stringify( S.read ) ) { C.updateTicks(); C.renderList(); }

            var others = fresh.filter( function ( m ) { return m.from !== C.me( id ); } ).length;
            if( bottom || ! others ) C.toBottom( false );
            else { newBelow += others; showDown(); }
            C.markRead();
        }
        catch( e ) { if( e.status === 403 || e.status === 404 ) C.loadSummary().catch( function () {} ); }
    };

    // The page before the oldest one on screen.
    async function loadOlder()
    {
        if( loadingOlder || ! S.more || ! S.open ) return;
        loadingOlder = true;
        var id = S.open;
        var first = S.order.find( function ( x ) { return x > 0; } ) || 0;
        try
        {
            var r = await C.api( "GET", "conv/" + id + "/messages?before=" + first );
            if( S.open !== id ) return;
            var h0 = wall.scrollHeight, t0 = wall.scrollTop;
            ( r.msgs || [] ).forEach( function ( m ) { S.msgs.set( m.id, m ); } );
            S.more = !! r.more;
            reorder();
            C.renderAll();
            wall.scrollTop = t0 + ( wall.scrollHeight - h0 );
        }
        catch( e ) { C.fail( e ); }
        loadingOlder = false;
    }

    // Every message (search, the media of an info screen).
    C.loadAll = async function ()
    {
        if( ! S.more || ! S.open ) return;
        var id = S.open;
        var r = await C.api( "GET", "conv/" + id + "/messages?all=1" );
        if( S.open !== id ) return;
        ( r.msgs || [] ).forEach( function ( m ) { S.msgs.set( m.id, m ); } );
        S.more = false;
        reorder();
        C.renderAll();
    };

    // ---------------------------------------------------------------------
    // scrolling and reading
    // ---------------------------------------------------------------------

    function atBottom() { return wall.scrollHeight - wall.scrollTop - wall.clientHeight < 90; }
    C.atBottom = atBottom;

    C.toBottom = function ( smooth )
    {
        requestAnimationFrame( function ()
        {
            wall.scrollTo( { top: wall.scrollHeight, behavior: smooth ? "smooth" : "auto" } );
        } );
        newBelow = 0;
        showDown();
    };

    function showDown()
    {
        downBtn.hidden = atBottom() && ! newBelow;
        var b = C.$( ".badge", downBtn );
        if( b ) b.remove();
        if( newBelow ) downBtn.appendChild( h( "span", { class: "badge", text: String( newBelow ) } ) );
    }

    function onScroll()
    {
        if( wall.scrollTop < 80 && S.more ) loadOlder();
        if( atBottom() ) { newBelow = 0; C.markRead(); }
        showDown();
    }

    var readTimer = null;
    C.markRead = function ()
    {
        if( ! S.open || document.hidden || ! atBottom() ) return;
        clearTimeout( readTimer );
        readTimer = setTimeout( async function ()
        {
            var last = 0;
            S.order.forEach( function ( x ) { if( x > last ) last = x; } );
            var me = C.me();
            if( ! last || ( S.read[ me ] || 0 ) >= last ) return;
            S.read[ me ] = last;
            var c = C.convOf( S.open );
            if( c && c.unread ) { c.unread = 0; C.renderList(); }
            try { await C.api( "POST", "conv/" + S.open + "/read", { id: last } ); } catch( _ ) {}
        }, 250 );
    };

    // ---------------------------------------------------------------------
    // drawing
    // ---------------------------------------------------------------------

    function prevOf( id )
    {
        var i = S.order.indexOf( id );
        if( i <= 0 ) return null;
        var p = S.msgs.get( S.order[ i - 1 ] );
        var m = S.msgs.get( id );
        return p && m && C.dayKey( p.at ) === C.dayKey( m.at ) ? p : null;
    }

    C.renderAll = function ()
    {
        wallIn.textContent = "";
        S.els = new Map();
        if( S.more )
            wallIn.appendChild( h( "button", { class: "text-btn ghost older", attrs: { type: "button" }, text: T( "chat.older" ),
                                               on: { click: loadOlder } } ) );
        var prevDay = null, prev = null;
        S.order.forEach( function ( id )
        {
            var m = S.msgs.get( id );
            var day = C.dayKey( m.at );
            if( day !== prevDay ) { wallIn.appendChild( h( "span", { class: "chip", text: C.dayLabel( m.at ) } ) ); prev = null; }
            if( S.bandId && id === S.bandId ) wallIn.appendChild( bandEl() );
            var el = C.bubble( m, prev );
            wallIn.appendChild( el );
            S.els.set( id, el );
            prev = m;
            prevDay = day;
        } );
        if( C.afterRender ) C.afterRender();
    };

    function bandEl()
    {
        var n = 0;
        var me = C.me();
        S.order.forEach( function ( x ) { var m = S.msgs.get( x ); if( x >= S.bandId && m.from !== me && ! m.deleted ) n++; } );
        return h( "div", { class: "band", text: C.TF( n === 1 ? "chat.unreadOne" : "chat.unreadN", { n: n } ) } );
    }

    function appendOne( m )
    {
        var p = prevOf( m.id );
        if( ! p )
        {
            var i = S.order.indexOf( m.id );
            var before = i > 0 ? S.msgs.get( S.order[ i - 1 ] ) : null;
            if( ! before || C.dayKey( before.at ) !== C.dayKey( m.at ) )
                wallIn.appendChild( h( "span", { class: "chip", text: C.dayLabel( m.at ) } ) );
        }
        var el = C.bubble( m, p );
        wallIn.appendChild( el );
        S.els.set( m.id, el );
        if( C.afterRender ) C.afterRender();
    }

    C.redraw = function ( id )
    {
        var old = S.els.get( id );
        var m = S.msgs.get( id );
        if( ! old || ! m ) return;
        var el = C.bubble( m, prevOf( id ) );
        old.replaceWith( el );
        S.els.set( id, el );
        if( C.afterRender ) C.afterRender();
    };

    // A message on its way: shown at once, replaced when the server answers.
    C.addTemp = function ( m )
    {
        m.id = tempSeq--;
        m.pending = true;
        m.from = C.me();
        m.at = Date.now();
        S.msgs.set( m.id, m );
        reorder();
        appendOne( m );
        C.toBottom( false );
        return m;
    };

    C.settleTemp = function ( temp, real )
    {
        S.msgs.delete( temp.id );
        var el = S.els.get( temp.id );
        S.els.delete( temp.id );
        if( S.msgs.has( real.id ) ) { if( el ) el.remove(); return; }   // the live loop was first
        S.msgs.set( real.id, real );
        reorder();
        if( el )
        {
            var nel = C.bubble( real, prevOf( real.id ) );
            el.replaceWith( nel );
            S.els.set( real.id, nel );
        }
        if( C.afterRender ) C.afterRender();
    };

    C.failTemp = function ( temp )
    {
        temp.pending = false;
        temp.failed = true;
        C.redraw( temp.id );
    };

    C.dropTemp = function ( temp )
    {
        S.msgs.delete( temp.id );
        var el = S.els.get( temp.id );
        if( el ) el.remove();
        S.els.delete( temp.id );
        reorder();
    };

    // Have all the others read message `m`?
    function seenByAll( conv, m )
    {
        var others = C.membersOf( conv ).filter( function ( p ) { return p !== m.from; } );
        return others.length > 0 && others.every( function ( p ) { return ( S.read[ p ] || 0 ) >= m.id; } );
    }

    // The ticks of one of my messages. In the list (not the open chat) the
    // conversation's `seen` flag says it for its last message.
    C.tickEl = function ( conv, m )
    {
        if( m.pending ) return C.ic( "clock" );
        if( m.failed )  return C.ic( "alert", "failed-ic" );
        var seen = conv === S.open && S.msgs.has( m.id ) ? seenByAll( conv, m ) : !! ( C.convOf( conv ) || {} ).seen;
        return seen ? C.ic( "tick2", "read" ) : C.ic( "tick1" );
    };

    C.updateTicks = function ()
    {
        S.els.forEach( function ( el, id )
        {
            var m = S.msgs.get( id );
            if( ! m || m.from !== C.me() || m.deleted ) return;
            var slot = C.$( ".tick", el );
            if( ! slot ) return;
            slot.textContent = "";
            slot.appendChild( C.tickEl( S.open, m ) );
        } );
    };

    // ---------------------------------------------------------------------
    // one bubble
    // ---------------------------------------------------------------------

    var URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/gi;

    // Text with its links made clickable, and a search hit marked.
    C.textNodes = function ( el, text )
    {
        var q = S.searching && S.searching.q ? S.searching.q.toLowerCase() : "";
        var last = 0, m;
        URL_RE.lastIndex = 0;
        while( ( m = URL_RE.exec( text ) ) )
        {
            plain( el, text.slice( last, m.index ), q );
            el.appendChild( h( "a", { text: m[ 0 ], attrs: { href: m[ 0 ], target: "_blank", rel: "noopener noreferrer" } } ) );
            last = m.index + m[ 0 ].length;
        }
        plain( el, text.slice( last ), q );
    };

    // 1 to 3 emojis and nothing else (spaces aside): shown big, with no bubble.
    // One emoji is one grapheme, so a flag, a skin tone or a family counts once.
    var GRAPHEMES = window.Intl && Intl.Segmenter ? new Intl.Segmenter( undefined, { granularity: "grapheme" } ) : null;
    var EMOJI_RE  = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

    C.fewEmojis = function ( text )
    {
        var s = ( text || "" ).replace( /\s+/g, "" );
        if( ! s ) return false;
        var parts = GRAPHEMES ? Array.from( GRAPHEMES.segment( s ), function ( g ) { return g.segment; } ) : Array.from( s );
        return parts.length <= 3 && parts.every( function ( g ) { return EMOJI_RE.test( g ); } );
    };

    function plain( el, s, q )
    {
        if( ! s ) return;
        if( ! q ) { el.appendChild( document.createTextNode( s ) ); return; }
        var low = s.toLowerCase(), at = 0, i;
        while( ( i = low.indexOf( q, at ) ) >= 0 )
        {
            if( i > at ) el.appendChild( document.createTextNode( s.slice( at, i ) ) );
            el.appendChild( h( "mark", { text: s.slice( i, i + q.length ) } ) );
            at = i + q.length;
        }
        if( at < s.length ) el.appendChild( document.createTextNode( s.slice( at ) ) );
    }

    function meta( m, onMedia )
    {
        var el = h( "span", { class: "meta" + ( onMedia ? " on-media" : "" ) } );
        if( m.edited && ! m.deleted ) el.appendChild( h( "span", { class: "edited", text: T( "chat.edited" ) } ) );
        el.appendChild( document.createTextNode( C.time( m.at ) ) );
        if( m.from === C.me() && ! m.deleted )
        {
            var slot = h( "span", { class: "tick" } );
            slot.appendChild( C.tickEl( S.open, m ) );
            el.appendChild( slot );
        }
        return el;
    }

    function quoteEl( m )
    {
        var orig = S.msgs.get( m.replyTo );
        var q = orig ? { id: orig.id, from: orig.from, kind: orig.kind, text: C.preview( orig )[ 1 ], deleted: orig.deleted } : m.quote;
        if( ! q ) return null;
        var text = q.deleted ? T( "chat.deleted" ) : ( orig ? C.preview( orig )[ 1 ] : ( q.text || C.preview( q )[ 1 ] ) );
        return h( "span", { class: "quote", data: { c: String( C.colorOf( q.from ) ) },
                            on: { click: function ( e ) { e.stopPropagation(); C.jumpTo( q.id ); } } },
                  h( "b", { text: C.nameOf( q.from ) } ), h( "span", { text: text } ) );
    }

    C.jumpTo = async function ( id )
    {
        if( ! S.els.has( id ) ) { try { await C.loadAll(); } catch( _ ) {} }
        var el = S.els.get( id );
        if( ! el ) return;
        el.scrollIntoView( { block: "center", behavior: "smooth" } );
        el.classList.add( "flash" );
        setTimeout( function () { el.classList.remove( "flash" ); }, 1400 );
    };

    C.bubble = function ( m, prev )
    {
        var mine  = m.from === C.me();
        var conv  = C.convOf( S.open );
        var group = conv && conv.kind === "g";
        var tail  = ! prev || prev.from !== m.from;
        // "card" is app.css's page card: a contact card bubble is "vcard"
        var kind  = m.deleted ? "gone" : m.kind === "card" ? "vcard" : m.kind;
        var el = h( "div", { class: "msg " + ( mine ? "out" : "in" ) + ( tail ? " tail" : "" ) + " " + kind +
                                      ( m.failed ? " failed" : "" ),
                             data: { id: String( m.id ) } } );
        if( C.msgHidden( m.id ) ) el.hidden = true;   // deleted, its "Undo" still on show (compose.js)

        if( group && ! mine && tail )
            el.appendChild( h( "span", { class: "from", text: C.nameOf( m.from ), data: { c: String( C.colorOf( m.from ) ) } } ) );

        if( m.deleted )
        {
            el.appendChild( C.ic( "ban" ) );
            el.appendChild( document.createTextNode( T( mine ? "chat.youDeleted" : "chat.deleted" ) ) );
            el.appendChild( meta( m ) );
            return el;
        }
        if( m.fwd ) el.appendChild( h( "span", { class: "fwd" }, C.ic( "forward" ), T( "chat.forwarded" ) ) );
        if( m.replyTo ) el.appendChild( quoteEl( m ) );

        switch( m.kind )
        {
            case "photo": C.photoBody( el, m, meta ); break;
            case "file":  C.fileBody( el, m, meta ); break;
            case "loc":   C.locBody( el, m, meta ); break;
            case "card":  C.cardBody( el, m, meta ); break;
            case "poll":  C.pollBody( el, m, meta ); break;
            case "call":  C.callBody( el, m, meta ); break;
            default:
                // a reply or a forward keeps its bubble: the quote needs it
                if( ! m.replyTo && ! m.fwd && C.fewEmojis( m.text ) ) el.classList.add( "jumbo" );
                C.textNodes( el, m.text || "" );
                el.appendChild( meta( m ) );
        }

        if( m.reacts && Object.keys( m.reacts ).length )
        {
            var count = {}, order = [];
            for( var p in m.reacts )
            {
                var e = m.reacts[ p ];
                if( ! count[ e ] ) { count[ e ] = 0; order.push( e ); }
                count[ e ]++;
            }
            var total = Object.keys( m.reacts ).length;
            el.classList.add( "has-reac" );
            el.appendChild( h( "span", { class: "reac", attrs: { role: "button", tabindex: "0" },
                                         on: { click: function ( ev ) { ev.stopPropagation(); C.showReactions( m ); } } },
                               order.slice( 0, 3 ).join( "" ) + ( total > 1 ? " " + total : "" ) ) );
        }

        if( m.failed )
            el.addEventListener( "click", function () { C.retry( m ); } );
        else if( m.id > 0 ) C.wireBubble( el, m );
        return el;
    };
} )();
