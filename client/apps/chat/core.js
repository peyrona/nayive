/*
 * core.js - the Chat app's shared basics: state, the server, icons, dates,
 * names, the back button. The other chat/*.js files add to the same object:
 *
 *     core.js     this file
 *     list.js     the list of chats, the live loop, new chat / person / group
 *     conv.js     one conversation: its top bar, loading it, the bubbles
 *     compose.js  writing, holding a message down, searching a conversation
 *     media.js    photos, files, location, contact cards, polls
 *     info.js     a chat's info screen, and the app's help
 *     call.js     voice and video calls (the call screen, its bubble)
 *     guest.js    a person's first visit (notifications, home-screen icon)
 *     chat.js     start()
 *
 * All classic scripts (defer), one global: window.NayiveChat (below: C). A
 * function of one file calls another's as C.name(), at call time - load order
 * only matters for chat.js, which runs last.
 *
 * WORLDS. A chat lives in one home and speaks one "world": who "o" is, my
 * own participant id, the names, pictures, who is online, the live cursor.
 * S itself is the page's own world (/api/chat or a person's /api/c/<token>).
 * A Nayive user also takes part in chats that live in OTHER users' homes
 * (the server's "via": /api/chat/via/<home>); each is a world in S.vias, with
 * the same fields, and its chats carry `via`. S.convs is every world's chats
 * together. C.W(conv) is a chat's world; C.me(conv), C.nameOf(pid, conv) and
 * C.avatar(..., conv) read through it - the open chat when no conv is given.
 * C.api sends "conv/<id>/..." to that chat's world by itself.
 *
 * SAFETY. Everything a person typed (names, messages, file names) goes on
 * screen through textContent, never innerHTML: the owner's page shares its
 * origin with their Nayive session. innerHTML is used for our own icons only.
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat = window.NayiveChat || {};

    // ---------------------------------------------------------------------
    // state
    // ---------------------------------------------------------------------

    C.S = {
        mode:     "owner",      // "owner" | "guest"
        api:      "",           // "/api/chat" | "/api/c/<token>"
        token:    "",
        user:     "",           // the owner's Nayive account (chat.js; C.scope)
        me:       "o",          // my participant id
        owner:    "",           // the owner's name, as people see it
        myName:   "",           // a person's own name (guest)
        people:   {},           // pid -> name
        convs:    [],           // the list, as the server sent it
        contacts: [],           // the owner's people (owner only)
        devices:  0,            // the owner's devices with notifications
        deleteAfter: 0,         // the owner's auto-delete, in days (0 = never)
        vapid:    "",
        v:        -1,
        meta:     -1,
        revs:     {},
        online:   new Set(),
        typing:   {},
        list:     [],           // this world's own chats (S.convs = every world's)
        vias:     {},           // home -> the world of the chats I take part in there
        users:    [],           // every other Nayive account [{user, name}] (owner)

        open:     null,         // the open conversation's id
        msgs:     new Map(),    // its messages, id -> message
        order:    [],           // ...their ids, oldest first
        els:      new Map(),    // id -> bubble element
        openRev:  0,
        read:     {},
        more:     false,
        bandId:   0,            // the "N unread" band sits before this message
        replyTo:  null,
        editing:  null,
        filter:   "all",
        query:    ""
    };

    // ---------------------------------------------------------------------
    // words
    // ---------------------------------------------------------------------

    C.T  = function ( k )    { return Ayni.t( k ); };
    C.TF = function ( k, v ) { return Ayni.tf( k, v ); };

    // ---------------------------------------------------------------------
    // DOM
    // ---------------------------------------------------------------------

    C.$ = function ( sel, root ) { return ( root || document ).querySelector( sel ); };

    // h( "div", { class: "x", text: "…", on: { click: fn }, attrs: {…} }, child, … )
    // Children: elements, strings (text nodes), null (skipped), arrays. Shared
    // with eMail (shared/ui.js).
    C.h = Ayni.h;

    // Feather-style glyphs, 24x24.
    var ICONS = {
        back: "back",
        search: "search-2",
        more: "more-2",
        clip: "clip",
        camera: "camera",
        smile: "smile",
        send: "send",
        tick1: "tick1",
        tick2: "tick2",
        clock: "recent",
        alert: "alert",
        reply: "reply",
        forward: "forward-2",
        copy: "copy-2",
        edit: "edit-2",
        trash: "trash",
        info: "move-to",
        image: "image",
        file: "file-2",
        "pin-map": "pin-map",
        user: "user",
        users: "users",
        "user-plus": "user-plus",
        chat: "chat",
        download: "download",
        bell: "bell",
        "bell-off": "bell-off",
        link: "link",
        share: "share-2",
        "ios-share": "ios-share-2",
        "plus-square": "sheet-add",
        compass: "compass",
        x: "close",
        plus: "plus-thin",
        check: "check",
        ban: "ban",
        pin: "pin",
        chev: "chev",
        "chev-l": "chev-l",
        "chev-up": "chev-up",
        "chev-down": "chev-down",
        minimize: "collapse",
        maximize: "expand",
        nav: "nav",
        live: "live",
        poll: "poll",
        "arrow-right": "forward",
        crop: "crop",
        "rotate-cw": "retry",
        refresh: "refresh-2",
        book: "book",
        tabs: "tabs",
        video: "video-2",
        phone: "phone",
        "video-off": "video-off",
        "phone-off": "phone-off",
        lock: "lock-2",
        mic: "mic",
        "mic-off": "mic-off",
        external: "external",
        gear: "gear",
        help: "help",
        home: "home",
        phone2: "phone2",
        folder: "folder-2",
        play: "play-2",
        stop: "stop-2",
        music: "music",
        volume: "volume-2",
        "volume-x": "volume-x",
        textfmt: "textfmt",
        bold: "bold-2",
        italic: "italic-2",
        strike: "strike",
        list: "list"
    };

    C.icon = function ( name, cls )
    {
        if( name === "nayive" ) return Ayni.icon( name );
        return '<svg class="ic' + ( cls ? " " + cls : "" ) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-' + ( ICONS[ name ] || name ) + '"/></svg>';
    };

    // An element holding just the icon.
    // An info "i" with a sentence or two of help (Ayni's, wired when it is on
    // the page): next to a label, never a grey line under a field.
    C.info = function ( text )
    {
        return C.h( "button", { class: "info-tip", attrs: { type: "button", "data-help": text } } );
    };

    C.ic = function ( name, cls )
    {
        var t = document.createElement( "template" );
        t.innerHTML = C.icon( name, cls );
        return t.content.firstChild;
    };

    // A person's page (no item list) keeps its ⋮ menus: an Ayni menu
    // (shared/ayni/ayni-menus.js) the button opens (popovertarget). Each row
    // carries its own action in _act. C.menuRow( icon, key, act, cls ) makes a row.
    C.menu = function ( id, btn )
    {
        var m = C.h( "div", { class: "panel menu", attrs: { id: id, popover: "", role: "menu" } } );
        document.body.appendChild( m );
        btn.setAttribute( "popovertarget", id );
        m.addEventListener( "ayni:action", function ( e ) { if( e.detail.item._act ) e.detail.item._act(); } );
        Ayni.init( m );
        return m;
    };
    C.menuRow = function ( iconName, titleKey, act, cls )
    {
        var b = C.h( "button", { class: cls || "", attrs: { type: "button", role: "menuitem" } },
                     C.h( "span", { class: "icon" }, C.ic( iconName ) ), C.T( titleKey ) );
        b._act = act;
        return b;
    };

    // A round .btn with a glyph and a translated tooltip.
    C.btn = function ( iconName, titleKey, onClick, extra )
    {
        var b = C.h( "button", { class: "btn" + ( extra ? " " + extra : "" ), attrs: { type: "button",
                     "data-tip": C.T( titleKey ), "aria-label": C.T( titleKey ) }, on: { click: onClick } } );
        b.appendChild( C.ic( iconName ) );
        return b;
    };

    // ---------------------------------------------------------------------
    // the server
    // ---------------------------------------------------------------------

    // opts.base: the world's API to use; by default "conv/<id>/..." goes to
    // that chat's world and anything else to this page's own.
    C.api = async function ( method, path, body, opts )
    {
        opts = opts || {};
        var init = { method: method, headers: { Accept: "application/json" }, signal: opts.signal,
                     credentials: "same-origin" };
        // the page's owner on a change (L5): a tab of another account gets 423
        var who = C.S.mode === "owner" && method !== "GET" && window.AyniNet && AyniNet.owner && AyniNet.owner();
        if( who ) init.headers[ "X-Nayive-User" ] = who;
        if( body !== undefined && body !== null )
        {
            init.headers[ "Content-Type" ] = "application/json";
            init.body = JSON.stringify( body );
        }
        var base = opts.base;
        if( ! base )
        {
            var cv = /^conv\/([^\/?]+)/.exec( path || "" );
            base = cv ? C.W( cv[ 1 ] ).api : C.S.api;
        }
        var res = await fetch( base + ( path ? "/" + path : "" ), init );
        if( res.status === 204 ) return null;
        var data = null;
        try { data = await res.json(); } catch( _ ) {}
        if( ! res.ok )
        {
            if( res.status === 401 && C.S.mode === "owner" && window.NayiveUI ) Ayni.pwa.sessionExpired();
            var err = new Error( ( data && data.error ) || ( "HTTP " + res.status ) );
            err.status = res.status;
            err.body   = data;   // the whole answer: call.js reads its "busy" flag
            throw err;
        }
        return data;
    };

    C.mediaUrl = function ( conv, id, dl )
    {
        return C.W( conv ).api + "/conv/" + encodeURIComponent( conv ) + "/media/" + id + ( dl ? "?dl=1" : "" );
    };

    // Whose are the things this page keeps on the device (compose.js: the
    // outbox, the words being written): the account signed in, or the
    // person's link. "" while not known (the owner's page started offline).
    C.scope = function ()
    {
        if( C.S.mode === "guest" ) return C.S.token ? "t:" + C.S.token : "";
        return C.S.user ? "u:" + C.S.user : "";
    };

    // The owner's account, asked when the boot's probe brought none.
    C.whoami = async function ()
    {
        if( C.S.mode === "owner" && ! C.S.user && window.AyniNet )
        {
            try { var w = await AyniNet.probeAccess(); C.S.user = ( w && w.user ) || ""; } catch( _ ) {}
        }
        return C.S.user;
    };

    // A short random id: the client's name for a message on its way.
    C.rid = function ()
    {
        var a = new Uint8Array( 9 );
        crypto.getRandomValues( a );
        return Array.prototype.map.call( a, function ( b ) { return ( b & 63 ).toString( 36 ); } ).join( "" ) + Date.now().toString( 36 );
    };

    C.toast = function ( kind, key ) { Ayni.toast( kind, C.T( key ) ); };
    C.fail  = function ( e )
    {
        var msg = ( e && e.status === 404 ) ? C.T( "chat.gone" )
                : ( e && e.status === 413 ) ? C.T( "chat.tooBig" )
                : ( e && e.status === 429 ) ? C.T( "chat.tooFast" )
                : ( e && e.status === 507 ) ? C.T( "chat.noRoom" )
                : C.T( "chat.failed" );
        Ayni.toast( "err", msg );
    };

    // ---------------------------------------------------------------------
    // names, colours, dates
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // worlds (see the top of this file)
    // ---------------------------------------------------------------------

    // The world of a chat (its id or the chat itself); this page's own when
    // it has none, or the chat is not known.
    C.W = function ( conv )
    {
        var c = typeof conv === "string" ? C.convOf( conv ) : conv;
        return ( c && c.via && C.S.vias[ c.via ] ) || C.S;
    };

    // My participant id in a chat (the open one by default).
    C.me = function ( conv ) { return C.W( conv === undefined ? C.S.open : conv ).me; };

    // The chat is mine to manage: this page is its home's owner.
    C.owns = function ( conv )
    {
        var c = typeof conv === "string" ? C.convOf( conv ) : conv;
        return C.S.mode === "owner" && !! c && ! c.via;
    };

    // The other side of a 1:1 chat.
    C.otherOf = function ( c ) { return c.with || ( C.W( c ).me === "o" ? c.id.slice( 2 ) : "o" ); };

    // A pid or a chat id as a participant: a 1:1 chat is its other side.
    function pidIn( pidOrConv )
    {
        if( ! /^d-/.test( pidOrConv ) ) return pidOrConv;
        var c = C.convOf( pidOrConv );
        return c ? C.otherOf( c ) : ( C.S.mode === "owner" ? pidOrConv.slice( 2 ) : "o" );
    }

    // conv: the chat whose world names `pid` (the open one by default; null =
    // this page's own world).
    C.nameOf = function ( pid, conv )
    {
        var w = C.W( conv === undefined ? C.S.open : conv );
        if( pid === w.me ) return C.T( "chat.you" );
        return w.people[ pid ] || "?";
    };

    C.initials = function ( name )
    {
        var w = String( name || "?" ).trim().split( /\s+/ );
        var s = ( w[ 0 ] || "?" ).charAt( 0 ) + ( w.length > 1 ? w[ 1 ].charAt( 0 ) : "" );
        return s.toUpperCase();
    };

    C.colorOf = function ( pid )
    {
        if( pid === "o" ) return 0;
        return 1 + Ayni.hash( pid ) % 5;
    };

    // A Nayive user keeps one colour wherever they show: their account's.
    function colorKey( pid, w )
    {
        if( w.via && pid === "o" ) return "u:" + w.via;
        var ct = ! w.via && C.S.mode === "owner" && pid !== "o" ? C.contactOf( pid ) : null;
        return ct && ct.user ? "u:" + ct.user : pid;
    }

    // The Nayive account behind a participant ("u:<account>" in "Nuevo
    // chat"'s rows), or "".
    function accountOf( pid, w )
    {
        var k = /^u:/.test( pid ) ? pid : colorKey( pid, w );
        return /^u:/.test( k ) ? k.slice( 2 ) : "";
    }
    C.accountOf = function ( pid, conv ) { return accountOf( pid, C.W( conv === undefined ? C.S.open : conv ) ); };

    // An avatar: initials in the person's colour, or the group glyph. A chat
    // id brings its own world; a pid is read in `conv`'s (as C.nameOf).
    C.avatar = function ( pidOrConv, name, size, conv )
    {
        var isGroup = /^g-/.test( pidOrConv );
        var pid     = pidIn( pidOrConv );
        var w       = /^[dg]-/.test( pidOrConv ) ? C.W( pidOrConv ) : C.W( conv === undefined ? C.S.open : conv );
        var el = C.h( "span", { class: "av" + ( size ? " " + size : "" ), data: { c: String( isGroup ? 0 : C.colorOf( colorKey( pid, w ) ) ) } } );
        // A picture the owner chose (Options -> tap the circle) wins over the
        // initials; the URL carries its version, so a new one is a new URL.
        // Another Nayive user: the picture I chose for that account, kept in
        // MY home (avatar "u-<account>"), wins over everything, in any home.
        var key = isGroup ? pidOrConv.slice( 2 ) : pid;
        var ver = ( w.avatars || {} )[ key ];
        var api = w.api;
        var acct = isGroup || C.S.mode !== "owner" ? "" : accountOf( pid, w );
        if( acct && ( C.S.avatars || {} )[ "u-" + acct ] )
        {
            key = "u-" + acct;
            ver = C.S.avatars[ key ];
            api = C.S.api;
        }
        if( ver )
        {
            el.classList.add( "has-photo" );
            el.appendChild( C.h( "img", { attrs: { src: api + "/avatar/" + encodeURIComponent( key ) + "?v=" + ver, alt: "", loading: "lazy" } } ) );
        }
        else if( isGroup ) el.appendChild( C.ic( "users" ) );
        else el.textContent = C.initials( name );
        return el;
    };

    // Who is connected, on the pictures (his call, 2026-09-19): a green dot on
    // the list's rows and on a group's members, a green ring on the open
    // chat's own picture. The server tells the owner about their people and a
    // person about the owner - nothing more (onlineFor).
    C.isOnline = function ( pidOrConv, conv )
    {
        if( /^g-/.test( pidOrConv ) ) return false;
        var w = /^d-/.test( pidOrConv ) ? C.W( pidOrConv ) : C.W( conv === undefined ? C.S.open : conv );
        var pid = pidIn( pidOrConv );
        return pid !== w.me && w.online.has( pid );
    };
    C.withDot = function ( av, pidOrConv, conv )
    {
        if( ! C.isOnline( pidOrConv, conv ) ) return av;
        return C.h( "span", { class: "av-on", attrs: { title: C.T( "chat.online" ) } }, av, C.h( "i", { class: "on-dot" } ) );
    };
    C.ringIfOnline = function ( av, pidOrConv )
    {
        if( C.isOnline( pidOrConv ) ) av.classList.add( "on-ring" );
        return av;
    };

    var pad = Ayni.dates.pad;

    C.dayKey = function ( ms )
    {
        var d = new Date( ms );
        return d.getFullYear() + "-" + pad( d.getMonth() + 1 ) + "-" + pad( d.getDate() );
    };
    C.time = function ( ms )
    {
        var d = new Date( ms );
        return pad( d.getHours() ) + ":" + pad( d.getMinutes() );
    };
    function yesterdayKey()
    {
        var d = new Date();
        d.setDate( d.getDate() - 1 );
        return C.dayKey( d.getTime() );
    }
    C.dayLabel = function ( ms )
    {
        var k = C.dayKey( ms );
        if( k === C.dayKey( Date.now() ) ) return C.T( "chat.today" );
        if( k === yesterdayKey() )         return C.T( "chat.yesterday" );
        return k;
    };
    C.listTime = function ( ms )
    {
        var k = C.dayKey( ms );
        if( k === C.dayKey( Date.now() ) ) return C.time( ms );
        if( k === yesterdayKey() )         return C.T( "chat.yesterday" );
        return k;
    };

    C.fmtBytes = function ( n ) { return Ayni.fmtBytes( n ); };

    // ---------------------------------------------------------------------
    // the conversation list's words for a message
    // ---------------------------------------------------------------------

    // [icon name or null, text] - what a message of `conv` (the open chat by
    // default) looks like in one line.
    C.preview = function ( m, conv )
    {
        if( ! m ) return [ null, "" ];
        switch( m.kind )
        {
            case "photo": return [ "camera", C.stripMarks( m.text ) || C.T( "chat.photo" ) ];
            case "file":  return [ "file", C.stripMarks( m.text ) || ( m.file && m.file.name ) || C.T( "chat.file" ) ];
            case "loc":   return [ "pin-map", ( m.loc && m.loc.place ) || C.T( "chat.location" ) ];
            case "card":  return [ "user", ( m.card && m.card.name ) || C.T( "chat.contact" ) ];
            case "poll":  return [ "poll", ( m.poll && m.poll.q ) || C.T( "chat.poll" ) ];
            case "call":  return C.callPreview( m, conv );   // call.js
        }
        return [ null, C.stripMarks( m.text ) ];
    };

    // A text without its marks (marks.js), for one-line places.
    C.stripMarks = function ( text ) { return text ? window.Ayni.marks.strip( text ) : ""; };

    C.convOf = function ( id )
    {
        for( var i = 0; i < C.S.convs.length; i++ ) if( C.S.convs[ i ].id === id ) return C.S.convs[ i ];
        return null;
    };

    // Everyone in a conversation (the owner first).
    C.membersOf = function ( id )
    {
        var c = C.convOf( id );
        if( ! c ) return [];
        if( c.kind === "g" ) return c.members || [ "o" ];
        var other = C.otherOf( c );
        return other === "o" ? [ "o", C.W( c ).me ] : [ "o", other ];
    };

    C.contactOf = function ( id )
    {
        for( var i = 0; i < C.S.contacts.length; i++ ) if( C.S.contacts[ i ].id === id ) return C.S.contacts[ i ];
        return null;
    };

    C.linkOf = function ( contact )
    {
        return location.origin + "/c/" + contact.token + "/";
    };

    // ---------------------------------------------------------------------
    // the back button: every screen or layer that opens pushes one step, so
    // the phone's own "back" closes it, as in WhatsApp.
    // ---------------------------------------------------------------------

    var stack = [];

    C.pushNav = function ( kind, close )
    {
        // A screen replaces one of its own kind (another chat, another side
        // screen), and a chat opened from a side screen takes that screen's
        // place: one "back" always returns to the list.
        var top = stack[ stack.length - 1 ];
        if( top && ( top.kind === kind || ( top.kind === "side" && kind === "conv" ) ) &&
            ( kind === "conv" || kind === "side" ) )
        {
            if( top.kind === "side" && kind === "conv" && C.closeSideNow ) C.closeSideNow();
            top.kind  = kind;
            top.close = close;
            return;
        }
        stack.push( { kind: kind, close: close } );
        try { history.pushState( { chat: stack.length }, "" ); } catch( _ ) {}
    };

    // Close the top layer - through history, so the two stay in step.
    C.back = function ()
    {
        if( stack.length ) history.back();
    };

    // A layer closed by other means (a button inside it): drop its step too.
    // `then` (optional) runs once that step is gone - a layer opened before it
    // would be the one the step closes.
    // A step that only guards (no close: a small call's step under the list)
    // may be buried under layers opened since: its history step cannot be
    // taken out from there, so it is marked and goes with the layer over it -
    // no dead Back press left behind (AA3).
    C.popNav = function ( kind, then )
    {
        var top = stack[ stack.length - 1 ];
        if( ! top || top.kind !== kind )
        {
            stack.forEach( function ( s ) { if( s.kind === kind && ! s.close ) s.dead = true; } );
            if( then ) then();
            return;
        }
        top.close = null;
        top.then  = then;
        history.back();
    };

    var skipPop = false;

    window.addEventListener( "popstate", function ()
    {
        if( skipPop ) { skipPop = false; return; }
        var top = stack.pop();
        if( top && top.close ) top.close();
        if( top && top.then ) top.then();
        // the dead guards now on top go too, in one jump
        var dead = 0;
        while( stack.length && stack[ stack.length - 1 ].dead ) { stack.pop(); dead++; }
        if( dead ) { skipPop = true; history.go( -dead ); }
    } );

    // Forget every open layer at once (the caller has already closed them):
    // one history jump back to where the list was, so "back" stays in step.
    C.resetNav = function ()
    {
        var n = stack.length;
        if( ! n ) return;
        stack.length = 0;
        skipPop = true;
        history.go( -n );
    };

    C.navDepth = function () { return stack.length; };
} )();
