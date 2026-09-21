/*
 * list.js - the list of chats, the live loop, and the owner's side screens:
 * new chat, new person (their link + QR), new group, adding people.
 * See core.js for how the chat/*.js files fit together.
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h, T = C.T;

    // ---------------------------------------------------------------------
    // the summary: names, the list, who is online
    // ---------------------------------------------------------------------

    // One world's summary into that world (S, or one of S.vias).
    function take( w, r )
    {
        w.me      = r.me;
        w.owner   = r.owner;
        w.people  = r.people || {};
        w.list    = ( r.convs || [] ).map( function ( c ) { if( w.via ) c.via = w.via; return c; } );
        w.deleteAfter = r.deleteAfter || 0;   // the home's auto-delete after N days (0 = never)
        w.meta    = r.meta;
        if( w.v < 0 ) w.v = r.v;
        w.revs = {};
        w.list.forEach( function ( c ) { w.revs[ c.id ] = c.rev; } );
        w.online  = new Set( r.online || [] );
        w.typing  = r.typing || {};
        w.avatars = r.avatars || {};
    }

    C.loadSummary = async function ()
    {
        var r = await C.api( "GET", "" );
        take( S, r );
        S.contacts = r.contacts || [];
        S.devices  = r.devices || 0;
        S.vapid    = r.vapid || S.vapid;
        S.myName   = r.name || "";
        S.motto    = r.motto || "";
        S.users    = r.users || [];
        C.onCalls( r, S );   // call.js: calls on or off, a call ringing for me

        // The chats I take part in that live in other users' homes.
        var via = r.via || [];
        Object.keys( S.vias ).forEach( function ( u ) { if( via.indexOf( u ) < 0 ) dropVia( u ); } );
        await Promise.all( via.map( function ( u )
        {
            if( ! S.vias[ u ] ) S.vias[ u ] = newWorld( u );
            return loadVia( S.vias[ u ] );
        } ) );
        if( live ) C.startLoop();   // a home that is new here gets its loop
        afterLoad();
        return r;
    };

    // A world for the chats in another user's home (the server's "via").
    function newWorld( home )
    {
        return { via: home, api: "/api/chat/via/" + encodeURIComponent( home ), me: "", owner: "", people: {},
                 list: [], deleteAfter: 0, v: -1, meta: -1, revs: {}, online: new Set(), typing: {}, avatars: {},
                 sigSeen: 0, running: false, ctl: null };
    }

    async function loadVia( w )
    {
        try
        {
            var r = await C.api( "GET", "", null, { base: w.api } );
            if( S.vias[ w.via ] !== w ) return;
            take( w, r );
            C.onCalls( r, w );
        }
        catch( e ) { if( e && e.status === 404 ) dropVia( w.via ); }
    }

    // That home no longer holds me (deleted, or the account went): its chats
    // leave the list, and I am told.
    function dropVia( home )
    {
        var w = S.vias[ home ];
        if( ! w ) return;
        delete S.vias[ home ];
        w.running = false;
        if( w.ctl ) w.ctl.abort();
        if( w.owner && w.list.length ) NayiveUI.toast( C.TF( "chat.viaGone", { name: w.owner } ), { ms: 3500 } );
        afterLoad();
    }

    // Every world's chats as one list, and the screens that show them.
    function afterLoad()
    {
        var all = S.list.slice();
        Object.keys( S.vias ).forEach( function ( u ) { all = all.concat( S.vias[ u ].list ); } );
        S.convs = all;
        C.renderList();
        if( S.open )
        {
            if( ! C.convOf( S.open ) ) { C.closeConv( true ); return; }
            C.renderConvHead();
            if( C.W( S.open ).revs[ S.open ] !== S.openRev ) C.loadSince();
        }
        if( C.refreshSide ) C.refreshSide();
        if( C.refreshInfo ) C.refreshInfo();
    }

    // ---------------------------------------------------------------------
    // the live loop: one long-poll at a time per world, only while the page
    // is seen
    // ---------------------------------------------------------------------

    var live = false;   // the loops should run (the page is seen)

    function setConn( state )
    {
        var dot = document.getElementById( "syncIndicator" );
        if( dot && NayiveUI.applySyncState ) NayiveUI.applySyncState( dot, state, { tapHint: false } );
    }
    C.setConn = setConn;

    function sleep( ms ) { return new Promise( function ( ok ) { setTimeout( ok, ms ); } ); }

    // One loop per world: this page's own, and every other home I read.
    C.startLoop = function ()
    {
        live = true;
        [ S ].concat( Object.keys( S.vias ).map( function ( u ) { return S.vias[ u ]; } ) ).forEach( function ( w )
        {
            if( w.running ) return;
            w.running = true;
            loop( w );
        } );
    };

    async function loop( w )
    {
        var pause = 1000;
        while( w.running )
        {
            // Hidden: let go (the server then notifies) - unless a call is on:
            // its signals and its end come through here.
            if( document.hidden && ! C.inCall() ) { w.running = false; return; }
            w.ctl = new AbortController();
            try
            {
                var r = await C.api( "GET", "wait?v=" + w.v + C.waitQuery( w ), null, { signal: w.ctl.signal, base: w.api } );
                pause = 1000;
                if( w === S ) setConn( "synced" );
                await onWait( r, w );
            }
            catch( e )
            {
                if( e && e.name === "AbortError" ) continue;
                if( e && e.status === 404 && w === S && S.mode === "guest" ) { C.showGone(); w.running = false; return; }
                if( e && e.status === 404 && w !== S ) { dropVia( w.via ); return; }
                if( w === S ) setConn( "offline" );
                await sleep( pause );
                pause = Math.min( pause * 2, C.inCall() ? 2000 : 20000 );   // a call cannot wait 20 s
            }
        }
    }

    async function onWait( r, w )
    {
        w.v = r.v;
        var onlineBefore = Array.from( w.online ).sort().join();
        w.online = new Set( r.online || [] );
        C.onCalls( r, w );   // first: a call must not wait for the list to reload
        var typingBefore = JSON.stringify( w.typing );
        w.typing = r.typing || {};

        var stale = r.meta !== w.meta;
        var revs  = r.revs || {};
        for( var id in revs ) if( revs[ id ] !== w.revs[ id ] ) stale = true;
        for( var old in w.revs ) if( ! ( old in revs ) ) stale = true;
        var mine = S.open && C.W( S.open ) === w;   // the open chat lives in this world

        if( stale && w === S ) await C.loadSummary();
        else if( stale ) { await loadVia( w ); if( S.vias[ w.via ] === w ) afterLoad(); }
        else
        {
            var moved = onlineBefore !== Array.from( w.online ).sort().join();   // the green dots
            if( moved || typingBefore !== JSON.stringify( w.typing ) ) C.renderList();
            if( mine ) C.renderConvHead();
            if( moved && C.refreshInfo ) C.refreshInfo();
        }
        if( mine && revs[ S.open ] !== undefined && revs[ S.open ] !== S.openRev ) await C.loadSince();
    }

    C.stopLoop = function ()
    {
        live = false;
        [ S ].concat( Object.keys( S.vias ).map( function ( u ) { return S.vias[ u ]; } ) ).forEach( function ( w )
        {
            w.running = false;
            if( w.ctl ) w.ctl.abort();
        } );
    };

    // Back on screen: catch up at once, then wait again. Hidden: let go, so the
    // server knows we are away and notifies instead.
    document.addEventListener( "visibilitychange", function ()
    {
        if( ! S.api ) return;
        if( document.hidden ) { if( ! C.inCall() ) C.stopLoop(); return; }
        C.loadSummary().then( C.startLoop, C.startLoop );
    } );

    // ---------------------------------------------------------------------
    // the list of chats
    // ---------------------------------------------------------------------

    C.buildList = function ( side )
    {
        var owner = S.mode === "owner";

        // The Nayive header. The owner: [icon] Chat ... [search] [new chat]
        // [profile] [auto-delete] [help] [plug] - no "+", no ⋮ (his call,
        // 2026-09-19: the menu's options sit in the bar; "new chat" holds new
        // group, new person and everybody - also how a chat deleted "for me"
        // is opened again). A person:
        // Chat ... [search] [⋮] [plug]. The magnifier opens the search field
        // in the bar itself, and while it is open every button but the plug
        // steps aside (its × closes it again).
        var head = h( "div", { class: "topbar list-head", attrs: { id: "listHead" } } );
        if( owner )
        {
            // The icon + "Chat", and under both - when the owner wrote one in
            // "Your profile" - their motto, in small print (renderList paints it).
            head.appendChild( h( "div", { class: "brand" },
                h( "div", { class: "brand-row" }, C.ic( "chat", "app-icon" ), h( "h1", { class: "app-title", text: "Chat" } ) ),
                h( "div", { class: "app-motto", attrs: { id: "listMotto", hidden: true } } ) ) );
        }
        else head.appendChild( h( "h1", { class: "app-title-guest", text: "Chat" } ) );

        // type=text, not search: the browser's own clear cross would sit next to ours
        var search = h( "input", { class: "topbar-search", attrs: { type: "text", enterkeyhint: "search", id: "listSearchInput",
                                   placeholder: T( "chat.search" ), "aria-label": T( "chat.search" ), autocomplete: "off" },
                                   on: { input: function () { S.query = search.value; C.renderList(); },
                                         keydown: function ( e ) { if( e.key === "Escape" ) { e.preventDefault(); endSearch(); } } } } );
        var box = h( "div", { class: "search-wrap" }, search, C.btn( "x", "chat.closeSearch", endSearch, "sm" ) );
        var searchBtn = C.btn( "search", "chat.search", startSearch );
        searchBtn.id = "listSearch";
        var moreBtn = C.btn( "more", "chat.menu", null );
        moreBtn.id = "listMore";

        var actions = h( "div", { class: "topbar-actions" }, box, searchBtn );
        if( owner )
            [ [ "plus", "chat.newChat", function () { C.openNewChat(); }, "newChatBtn" ],
              [ "user", "chat.editProfile", function () { C.editMyName(); }, "profileBtn" ],
              [ "clock", "chat.autoDelete", function () { C.openAutoDelete(); }, "autoDelBtn" ],
              [ "help", "chat.help", function () { C.showHelp(); }, "helpBtn" ]
            ].forEach( function ( b )
            {
                var el = C.btn( b[ 0 ], b[ 1 ], b[ 2 ] );
                el.id = b[ 3 ];
                actions.appendChild( el );
            } );
        else actions.appendChild( moreBtn );
        actions.appendChild( h( "div", { class: "sync-indicator", attrs: { id: "syncIndicator" } } ) );   // the plug, last
        head.appendChild( actions );

        function startSearch()
        {
            head.classList.add( "searching" );
            search.focus();
        }
        function endSearch()
        {
            head.classList.remove( "searching" );
            if( search.value ) { search.value = ""; S.query = ""; C.renderList(); }
        }

        var hint = h( "div", { class: "hint-bar", attrs: { id: "listHint", hidden: true } } );

        var filters = h( "div", { class: "filters", attrs: { id: "filters" } } );
        [ [ "all", "chat.fAll" ], [ "unread", "chat.fUnread" ], [ "groups", "chat.fGroups" ] ].forEach( function ( f )
        {
            filters.appendChild( h( "button", { class: "pill" + ( S.filter === f[ 0 ] ? " is-active" : "" ), text: T( f[ 1 ] ),
                attrs: { type: "button" }, data: { f: f[ 0 ] },
                on: { click: function () { S.filter = f[ 0 ]; C.renderList(); } } } ) );
        } );
        // Auto-delete: one number of days for every chat of the home, so it
        // sits once, at the right end of the filters (his call, 2026-09-19),
        // not on each chat. It only tells: the clock in the bar changes it
        // (his call, 2026-09-20: never two buttons for the same thing).
        var ttl = h( "span", { class: "ttl", attrs: { id: "listTtl", hidden: true } } );
        filters.appendChild( ttl );

        var rows = h( "div", { class: "rows", attrs: { id: "rows" } } );
        side.appendChild( h( "div", { class: "view", attrs: { id: "vList" } }, head, hint, filters, rows ) );

        if( owner ) return;
        var menu = h( "div", { class: "top-menu", attrs: { id: "listMenu", hidden: true } } );
        [ [ "bell", "chat.notifications", function () { C.guestNotifications(); } ],
          [ "home", "chat.homeIcon", function () { C.guestHomeIcon(); } ],
          [ "help", "chat.help", C.showHelp ]
        ].forEach( function ( it )
        {
            var b = h( "button", { class: "menu-item", attrs: { type: "button" } }, C.ic( it[ 0 ] ), T( it[ 1 ] ) );
            b._act = it[ 2 ];
            menu.appendChild( b );
        } );
        document.body.appendChild( menu );
        NayiveUI.wireMenu( { btn: moreBtn, menu: menu, onPick: function ( item ) { if( item._act ) item._act(); } } );
    };

    function matches( c )
    {
        if( c.hidden && c.id !== S.open ) return false;    // deleted by me, nothing new since
        if( S.filter === "unread" && ! c.unread ) return false;
        if( S.filter === "groups" && c.kind !== "g" ) return false;
        if( ! S.query ) return true;
        var q = C.fold( S.query );
        return C.fold( c.name ).indexOf( q ) >= 0 || ( c.last && C.fold( c.last.text ).indexOf( q ) >= 0 );
    }

    function sortKey( c ) { return c.last ? c.last.at : c.created * 1000; }

    C.sortedConvs = function ()
    {
        return S.convs.slice().sort( function ( a, b )
        {
            if( !! a.pin !== !! b.pin ) return a.pin ? -1 : 1;
            return sortKey( b ) - sortKey( a );
        } );
    };

    C.renderList = function ()
    {
        var rows = document.getElementById( "rows" );
        if( ! rows ) return;
        rows.textContent = "";

        var pills = document.querySelectorAll( "#filters .pill" );
        pills.forEach( function ( p ) { p.classList.toggle( "is-active", p.dataset.f === S.filter ); } );
        var motto = document.getElementById( "listMotto" );
        if( motto )
        {
            motto.textContent = S.motto || "";
            motto.title = S.motto || "";        // the long ones are cut with an ellipsis
            motto.hidden = ! S.motto;
        }

        var ttl = document.getElementById( "listTtl" );
        if( ttl )
        {
            var days = S.deleteAfter;
            ttl.hidden = ! ( days > 0 );
            ttl.title = days > 0 ? C.TF( "chat.ttlTitle", { n: days } ) : "";
            ttl.replaceChildren( C.ic( "clock" ), String( days ) );
        }

        var list = C.sortedConvs().filter( matches );
        list.forEach( function ( c ) { rows.appendChild( row( c ) ); } );

        if( ! list.length )
        {
            var key = S.query || S.filter !== "all" ? "chat.noMatch"
                    : S.mode === "owner" ? "chat.emptyOwner" : "chat.emptyGuest";
            rows.appendChild( h( "p", { class: "list-note", text: T( key ) } ) );
        }

        var hint = document.getElementById( "listHint" );
        if( hint ) C.renderHint( hint );
        C.updateTitle();
    };

    function row( c )
    {
        var w      = C.W( c );
        var typers = w.typing[ c.id ] || [];
        var typing = typers.length > 0;
        var last   = c.last;
        var pv     = C.preview( last, c.id );
        var prev   = h( "span", { class: "prev" + ( typing ? " typing" : "" ) } );
        if( typing )
            prev.appendChild( h( "span", { text: c.kind === "g" ? C.TF( "chat.isTyping", { name: C.nameOf( typers[ 0 ], c.id ) } ) : T( "chat.typing" ) } ) );
        else if( last )
        {
            if( last.from === w.me && ! last.deleted ) prev.appendChild( C.tickEl( c.id, last ) );
            if( pv[ 0 ] ) prev.appendChild( C.ic( pv[ 0 ] ) );
            var who = ( c.kind === "g" && last.from !== w.me && ! last.deleted ) ? C.nameOf( last.from, c.id ) + ": " : "";
            prev.appendChild( h( "span", { text: who + pv[ 1 ] } ) );
        }
        else if( C.owns( c ) && c.kind === "d" )
        {
            var ct = C.contactOf( C.otherOf( c ) );
            prev.appendChild( h( "span", { text: T( ct && ( ct.opened || ct.user ) ? "chat.sayHello" : "chat.notOpened" ) } ) );
        }
        else if( c.via && c.kind === "d" ) prev.appendChild( h( "span", { text: T( "chat.sayHello" ) } ) );

        var l2 = h( "div", { class: "l2" }, prev );
        if( c.pin )  l2.appendChild( h( "span", { class: "flag" }, C.ic( "pin" ) ) );
        if( c.mute ) l2.appendChild( h( "span", { class: "flag" }, C.ic( "bell-off" ) ) );
        if( c.unread ) l2.appendChild( h( "span", { class: "badge", text: String( c.unread ) } ) );

        return h( "div", { class: "row" + ( c.unread ? " unread" : "" ) + ( S.open === c.id ? " is-open" : "" ),
                           attrs: { role: "button", tabindex: "0" }, data: { conv: c.id },
                           on: { click: function () { C.openConv( c.id ); },
                                 keydown: function ( e ) { if( e.target === this && ( e.key === "Enter" || e.key === " " ) ) { e.preventDefault(); C.openConv( c.id ); } } } },
            C.withDot( C.avatar( c.id, c.name, "lg" ), c.id ),
            h( "div", { class: "body" },
                h( "div", { class: "l1" }, h( "span", { class: "name", text: c.name } ),
                    h( "time", { text: last ? C.listTime( last.at ) : "" } ) ),
                l2 ) );
    }

    // Delete a chat - for me only, as in WhatsApp: its messages go from my
    // side, and it leaves the list until somebody writes again. Asked from
    // The chat's ⋮ -> Delete (info.js), whose dialog already said what it does.
    C.clearChat = async function ( c )
    {
        try
        {
            await C.api( "POST", "conv/" + c.id + "/clear" );
            C.leaveToList();
            await C.loadSummary();
            C.toast( "chat.chatDeleted" );
        }
        catch( e ) { C.fail( e ); }
    };

    // The page title carries the unread count, like WhatsApp Web.
    C.updateTitle = function ()
    {
        var n = 0;
        S.convs.forEach( function ( c ) { if( ! c.mute ) n += c.unread; } );
        document.title = ( n ? "(" + n + ") " : "" ) + ( S.mode === "owner" ? "Chat" : ( S.owner || "Chat" ) );
    };

    // The owner with no device taking notifications is told where to turn them on.
    C.renderHint = function ( hint )
    {
        hint.textContent = "";
        var off = false;
        try { off = localStorage.getItem( "chat-hint-push" ) === "off"; } catch( _ ) {}
        if( S.mode !== "owner" || S.devices > 0 || off ) { hint.hidden = true; return; }
        hint.appendChild( C.ic( "bell-off" ) );
        hint.appendChild( h( "span", { text: T( "chat.ownerNoPush" ) } ) );
        hint.appendChild( C.btn( "x", "ui.close", function ()
        {
            try { localStorage.setItem( "chat-hint-push", "off" ); } catch( _ ) {}
            hint.hidden = true;
        }, "sm" ) );
        hint.hidden = false;
    };

    // ---------------------------------------------------------------------
    // side screens (owner): one at a time over the list
    // ---------------------------------------------------------------------

    var sideView = null;     // the open side screen's element
    var sideRender = null;   // redraws it when the summary changes

    C.openSide = function ( el, render )
    {
        C.closeSideNow();
        var side = C.$( ".side" );
        C.$( "#vList" ).hidden = true;
        side.appendChild( el );
        sideView = el;
        sideRender = render || null;
        C.$( "#chat" ).classList.remove( "in-main" );
        C.pushNav( "side", C.closeSideNow );
    };

    C.closeSideNow = function ()
    {
        if( sideView ) sideView.remove();
        sideView = null;
        sideRender = null;
        var list = C.$( "#vList" );
        if( list ) list.hidden = false;
    };

    C.refreshSide = function () { if( sideRender ) sideRender(); };

    // A side screen's top bar: ← title (subtitle) [extra buttons]
    C.sideBar = function ( title, sub, extra )
    {
        var who = h( "div", { class: "who" }, h( "b", { text: title } ), sub ? h( "small", { text: sub } ) : null );
        return h( "div", { class: "bar" }, C.btn( "back", "chat.back", C.back ), who, extra || null );
    };

    // A person's line: has the link been opened, are notifications on. A
    // Nayive user has no link: they are just that, with or without notifications.
    function personState( ct )
    {
        if( ct.user ) return [ ct.push ? "ok" : "", T( "chat.nayiveUser" ) + " · " + T( ct.push ? "chat.withPush" : "chat.withoutPush" ) ];
        if( ! ct.opened ) return [ "warn", T( "chat.notOpened" ) ];
        return ct.push ? [ "ok", T( "chat.withPush" ) ] : [ "", T( "chat.withoutPush" ) ];
    }
    C.personState = personState;

    // One of my own people (this page's world, whatever chat is open).
    function personRow( ct, onClick, end )
    {
        var st = personState( ct );
        return h( "button", { class: "row", attrs: { type: "button" }, on: { click: onClick } },
            C.withDot( C.avatar( ct.id, ct.name, null, null ), ct.id, null ),
            h( "div", { class: "body" }, h( "span", { class: "name", text: ct.name } ),
                h( "span", { class: "state " + st[ 0 ], text: st[ 1 ] } ) ),
            end || null );
    }

    // "New chat": new group, new person, then everybody and every group -
    // also the way back into a chat deleted "for me" - and every other Nayive
    // user: no link for them, the chat shows in their own Chat.
    C.openNewChat = function ()
    {
        var view = h( "div", { class: "view" } );
        function render()
        {
            view.textContent = "";
            var people = S.contacts.filter( function ( ct ) { return ! ct.user; } );
            view.appendChild( C.sideBar( T( "chat.newChat" ), C.TF( "chat.nPeople", { n: people.length + S.users.length } ) ) );
            var rows = h( "div", { class: "rows" } );
            rows.appendChild( h( "button", { class: "row", attrs: { type: "button" }, on: { click: function () { C.openNewGroup(); } } },
                h( "span", { class: "ring" }, C.ic( "users" ) ),
                h( "div", { class: "body" }, h( "span", { class: "name", text: T( "chat.newGroup" ) } ) ) ) );
            rows.appendChild( h( "button", { class: "row", attrs: { type: "button" }, on: { click: function () { C.openNewPerson(); } } },
                h( "span", { class: "ring" }, C.ic( "user-plus" ) ),
                h( "div", { class: "body" }, h( "span", { class: "name", text: T( "chat.newPerson" ) } ),
                    h( "span", { class: "state", text: T( "chat.newPersonSub" ) } ) ) ) );
            if( S.users.length ) rows.appendChild( h( "div", { class: "lbl", text: T( "chat.nayiveUsers" ) } ) );
            S.users.slice().sort( byName ).forEach( function ( u )
            {
                rows.appendChild( userRow( u ) );
            } );
            if( people.length ) rows.appendChild( h( "div", { class: "lbl", text: T( "chat.yourPeople" ) } ) );
            people.sort( byName ).forEach( function ( ct )
            {
                rows.appendChild( personRow( ct, function () { C.openConv( "d-" + ct.id ); } ) );
            } );
            // The groups too: a group's chat deleted "for me" opens again here.
            var groups = S.convs.filter( function ( c ) { return c.kind === "g"; } ).sort( byName );
            if( groups.length ) rows.appendChild( h( "div", { class: "lbl", text: T( "chat.yourGroups" ) } ) );
            groups.forEach( function ( g )
            {
                rows.appendChild( h( "button", { class: "row", attrs: { type: "button" }, on: { click: function () { C.openConv( g.id ); } } },
                    C.avatar( g.id, g.name ),
                    h( "div", { class: "body" }, h( "span", { class: "name", text: g.name } ),
                        h( "span", { class: "state", text: C.TF( "chat.groupOf", { n: ( g.members || [] ).length } ) } ) ) ) );
            } );
            view.appendChild( rows );
        }
        render();
        C.openSide( view, render );
    };

    function byName( a, b ) { return a.name.localeCompare( b.name ); }

    // Another Nayive user: tap = the chat the two of us already have (whoever
    // started it), or a new one in my home. Their dot: online in our chat.
    function userRow( u )
    {
        var c = userConv( u.user );
        var av = c ? C.withDot( C.avatar( c.id, u.name ), c.id ) : C.avatar( "u:" + u.user, u.name, null, null );
        return h( "button", { class: "row", attrs: { type: "button" }, on: { click: function () { C.chatWithUser( u.user ); } } },
            av, h( "div", { class: "body" }, h( "span", { class: "name", text: u.name } ) ) );
    }

    // The 1:1 chat with a Nayive account, in my home or in theirs.
    function userConv( user )
    {
        var ct = S.contacts.filter( function ( x ) { return x.user === user; } )[ 0 ];
        if( ct ) return C.convOf( "d-" + ct.id );
        var w = S.vias[ user ];
        return w ? w.list.filter( function ( c ) { return c.kind === "d"; } )[ 0 ] || null : null;
    }

    C.chatWithUser = async function ( user )
    {
        try
        {
            var r = await C.api( "POST", "contacts", { user: user } );
            if( ! C.convOf( r.conv ) ) await C.loadSummary();
            C.openConv( r.conv );
        }
        catch( e ) { C.fail( e ); }
    };

    // "New person": a name, then their link, to send or to scan.
    C.openNewPerson = function ()
    {
        var view = h( "div", { class: "view" } );
        view.appendChild( C.sideBar( T( "chat.newPerson" ) ) );
        var pane = h( "div", { class: "pane" } );
        var input = h( "input", { attrs: { type: "text", id: "npName", maxlength: "60", autocomplete: "off" } } );
        var create = h( "button", { class: "text-btn wide", attrs: { type: "button" }, text: T( "chat.makeLink" ) } );
        var form = h( "div", {},
            h( "div", { class: "field" }, h( "label", { attrs: { for: "npName" }, text: T( "chat.name" ) } ), input ),
            h( "p", { class: "hint", text: T( "chat.nameSeen" ) } ),
            create );
        pane.appendChild( form );
        view.appendChild( pane );

        async function go()
        {
            var name = input.value.trim();
            if( ! name ) { input.focus(); return; }
            create.disabled = true;
            try
            {
                var ct = await C.api( "POST", "contacts", { name: name } );
                S.contacts.push( ct );
                form.remove();
                pane.appendChild( C.linkBox( ct ) );
                C.loadSummary().catch( function () {} );
            }
            catch( e ) { C.fail( e ); create.disabled = false; }
        }
        create.addEventListener( "click", go );
        input.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) go(); } );
        C.openSide( view );
        setTimeout( function () { input.focus(); }, 50 );
    };

    // A person's link: Send (the phone's share menu), Copy, and a QR code.
    // No share menu (a PC: Chrome on Linux has none) -> no Send: it could only
    // copy, the same as the button beside it (2026-09-19).
    C.linkBox = function ( ct )
    {
        var url = C.linkOf( ct );
        var canSend = !! navigator.share;
        var send = canSend ? h( "button", { class: "text-btn", attrs: { type: "button" } }, C.ic( "share" ), T( "chat.send" ) ) : null;
        var copy = h( "button", { class: "text-btn" + ( canSend ? " ghost" : "" ), attrs: { type: "button" } }, C.ic( "copy" ), T( "chat.copy" ) );
        if( send ) send.addEventListener( "click", function () { C.shareLink( ct ); } );
        copy.addEventListener( "click", function () { C.copyText( url ); } );
        var box = h( "div", {},
            h( "div", { class: "linkbox" },
                h( "b", { text: C.TF( "chat.linkOf", { name: ct.name } ) } ),
                h( "code", { text: url } ),
                h( "div", { class: "btns" }, send, copy ) ) );
        var qr = C.qrCanvas( url );
        if( qr ) box.appendChild( h( "div", { class: "qr" }, qr, h( "span", { text: T( "chat.qrHint" ) } ) ) );
        box.appendChild( h( "p", { class: "hint", style: "margin-top:14px", text: C.TF( "chat.linkWarn", { name: ct.name } ) } ) );
        box.appendChild( h( "button", { class: "text-btn ghost wide", attrs: { type: "button" }, text: T( "chat.openChat" ),
                                        on: { click: function () { C.openConv( "d-" + ct.id ); } } } ) );
        return box;
    };

    C.shareLink = function ( ct )
    {
        var url  = C.linkOf( ct );
        var text = C.TF( "chat.shareText", { name: S.owner } );
        // Closing the menu is an AbortError: nothing to do. Any other failure
        // copies instead, so the tap never does nothing.
        if( navigator.share )
            navigator.share( { title: S.owner, text: text, url: url } )
                     .catch( function ( e ) { if( ! e || e.name !== "AbortError" ) C.copyText( url ); } );
        else C.copyText( url );
    };

    C.copyText = function ( text )
    {
        var done = function () { C.toast( "chat.copied" ); };
        if( navigator.clipboard && navigator.clipboard.writeText )
            navigator.clipboard.writeText( text ).then( done, function () { legacyCopy( text ); done(); } );
        else { legacyCopy( text ); done(); }
    };

    function legacyCopy( text )
    {
        var ta = h( "textarea", { value: text, attrs: { readonly: "" }, style: "position:fixed;left:-999px" } );
        document.body.appendChild( ta );
        ta.select();
        try { document.execCommand( "copy" ); } catch( _ ) {}
        ta.remove();
    }

    // The QR code of a link (lib/qrcode, owner page only). Null without it.
    C.qrCanvas = function ( text )
    {
        if( ! window.NayiveQR ) return null;
        var m;
        try { m = NayiveQR.matrix( text ); } catch( _ ) { return null; }
        var n = m.length, q = 4, px = 4;
        var cv = h( "canvas", { width: ( n + 2 * q ) * px, height: ( n + 2 * q ) * px } );
        var x = cv.getContext( "2d" );
        x.fillStyle = "#fff";
        x.fillRect( 0, 0, cv.width, cv.height );
        x.fillStyle = "#000";
        for( var r = 0; r < n; r++ )
            for( var c = 0; c < n; c++ )
                if( m[ r ][ c ] ) x.fillRect( ( c + q ) * px, ( r + q ) * px, px, px );
        return cv;
    };

    // "New group" / "Add people": pick people, then (new) a name.
    C.openNewGroup = function ( group )
    {
        var picked = group ? ( group.members || [] ).filter( function ( p ) { return p !== "o"; } ) : [];
        var view   = h( "div", { class: "view" } );

        function render()
        {
            view.textContent = "";
            var go = C.btn( group ? "check" : "arrow-right", group ? "ui.save" : "chat.next", next );
            view.appendChild( C.sideBar( T( group ? "chat.addPeople" : "chat.newGroup" ),
                                         C.TF( "chat.nChosen", { n: picked.length } ), go ) );
            var chips = h( "div", { class: "sel-chips" } );
            picked.forEach( function ( id )
            {
                var ct = C.contactOf( id );
                if( ! ct ) return;
                var x = h( "span", { class: "x" }, C.ic( "x" ) );
                chips.appendChild( h( "button", { attrs: { type: "button", title: T( "chat.remove" ) },
                                                  on: { click: function () { toggle( id ); } } },
                    C.avatar( id, ct.name, null, null ), x, h( "span", { class: "nm", text: ct.name } ) ) );
            } );
            view.appendChild( chips );
            var rows = h( "div", { class: "rows" } );
            if( ! S.contacts.length ) rows.appendChild( h( "p", { class: "list-note", text: T( "chat.noPeopleYet" ) } ) );
            S.contacts.slice().sort( byName ).forEach( function ( ct )
            {
                var on  = picked.indexOf( ct.id ) >= 0;
                var chk = h( "span", { class: "chk" + ( on ? " on" : "" ) } );
                if( on ) chk.appendChild( C.ic( "check" ) );
                rows.appendChild( personRow( ct, function () { toggle( ct.id ); }, chk ) );
            } );
            view.appendChild( rows );
        }
        function toggle( id )
        {
            var i = picked.indexOf( id );
            if( i >= 0 ) picked.splice( i, 1 ); else picked.push( id );
            render();
        }
        async function next()
        {
            if( group )
            {
                try
                {
                    await C.api( "PATCH", "groups/" + group.id.slice( 2 ), { members: picked } );
                    C.back();
                    C.loadSummary().catch( function () {} );
                }
                catch( e ) { C.fail( e ); }
                return;
            }
            if( ! picked.length ) { C.toast( "chat.pickSomeone" ); return; }
            var name = await C.askText( { title: T( "chat.groupName" ), label: T( "chat.name" ), hint: T( "chat.groupNameHint" ) } );
            if( ! name ) return;
            try
            {
                var g = await C.api( "POST", "groups", { name: name, members: picked } );
                await C.loadSummary();
                C.openConv( "g-" + g.id );
            }
            catch( e ) { C.fail( e ); }
        }
        render();
        C.openSide( view, render );
    };

    // ---------------------------------------------------------------------
    // small dialogs
    // ---------------------------------------------------------------------

    // One text field in a dialog. Resolves to the text, or "" when cancelled.
    // o.more: an extra field the caller builds and reads itself afterwards
    // (editMyName's motto) - what this resolves to is still the one text.
    C.askText = function ( o )
    {
        return new Promise( function ( resolve )
        {
            var input = h( "input", { attrs: { type: "text", id: "askText", maxlength: String( o.max || 60 ), autocomplete: "off" },
                                      value: o.value || "" } );
            var ok = h( "button", { attrs: { type: "button", "data-act": "primary", title: T( "ui.accept" ) } } );
            var no = h( "button", { attrs: { type: "button", "data-act": "close", title: T( "ui.cancel" ) } } );
            var back = h( "div", { class: "sheet-backdrop open", attrs: { role: "dialog", "aria-modal": "true" } },
                h( "div", { class: "sheet sheet--pack" },
                    h( "h2", { text: o.title } ),
                    o.top || null,
                    h( "div", { class: "field" }, h( "label", { attrs: { for: "askText" }, text: o.label || "" } ), input ),
                    o.more || null,
                    o.hint ? h( "p", { class: "hint", text: o.hint } ) : null,
                    h( "div", { class: "sheet-actions" }, no, ok ) ) );
            document.body.appendChild( back );
            NayiveUI.applySheetButtons( back );
            function done( v ) { back.remove(); document.removeEventListener( "keydown", esc, true ); resolve( v ); }
            function esc( e ) { if( e.key === "Escape" ) { e.stopPropagation(); done( "" ); } }
            ok.addEventListener( "click", function () { var v = input.value.trim(); if( v ) done( v ); else input.focus(); } );
            no.addEventListener( "click", function () { done( "" ); } );
            input.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) ok.click(); } );
            if( o.more )
                o.more.querySelectorAll( "input" ).forEach( function ( el )
                {
                    el.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) ok.click(); } );
                } );
            document.addEventListener( "keydown", esc, true );
            setTimeout( function () { input.focus(); input.select(); }, 30 );
        } );
    };

    // Your name, your picture and your motto. The circle on top picks a
    // picture (or the bin under it drops it); the motto is optional and shows
    // under "Chat" in the bar. Nothing is sent until Accept.
    C.editMyName = async function ()
    {
        var pick = null, drop = false, url = "";
        var was   = S.motto || "";
        var motto = h( "input", { attrs: { type: "text", id: "askMotto", maxlength: "100", autocomplete: "off",
                                           placeholder: T( "chat.mottoPh" ) }, value: was } );
        var mottoField = h( "div", { class: "field" },
                            h( "label", { attrs: { for: "askMotto" }, text: T( "chat.motto" ) } ), motto );
        var face = h( "button", { class: "face", attrs: { type: "button", title: T( "chat.changePhoto" ), "aria-label": T( "chat.changePhoto" ) },
                                  on: { click: choose } } );
        var bin = h( "button", { class: "text-btn ghost danger", attrs: { type: "button" },
                                 on: { click: function () { pick = null; drop = true; show(); } } }, C.ic( "trash" ), T( "chat.removePhoto" ) );
        function show()
        {
            var av = C.avatar( "o", S.owner, "xl", null );
            if( pick || drop )
            {
                av.classList.remove( "has-photo" );
                av.textContent = "";
                if( pick ) { av.classList.add( "has-photo" ); av.appendChild( h( "img", { attrs: { src: url, alt: "" } } ) ); }
                else av.textContent = C.initials( S.owner );
            }
            face.replaceChildren( av, h( "span", { class: "cam" }, C.ic( "camera" ) ) );
            bin.hidden = ! ( pick || ( ! drop && ( S.avatars || {} ).o ) );
        }
        // From this device or from Nayive (media.js pickImage).
        async function choose()
        {
            var file = await C.pickImage( T( "chat.changePhoto" ) );
            if( ! file ) return;
            try
            {
                pick = await NayivePhoto.shrinkToJpeg( file, { maxW: 512, maxH: 512, quality: 0.85 } );
                if( url ) URL.revokeObjectURL( url );
                url = URL.createObjectURL( pick );
                drop = false;
                show();
            }
            catch( e ) { C.fail( e ); }
        }
        show();

        var name = await C.askText( { title: T( "chat.yourProfile" ), label: T( "chat.name" ), value: S.owner, hint: T( "chat.myNameHint" ),
                                      top: h( "div", { class: "me-photo" }, face, bin ), more: mottoField } );
        if( url ) URL.revokeObjectURL( url );
        if( ! name ) return;
        var mot = motto.value.trim();
        try
        {
            if( pick )
            {
                var res = await fetch( S.api + "/me/photo", { method: "PUT", credentials: "same-origin",
                                                               headers: { "Content-Type": "image/jpeg" }, body: pick } );
                if( ! res.ok ) throw { status: res.status };
            }
            else if( drop ) await C.api( "DELETE", "me/photo" );
            if( name !== S.owner || mot !== was ) await C.api( "PUT", "me", { name: name, motto: mot } );
            if( pick || drop || name !== S.owner || mot !== was ) await C.loadSummary();
        }
        catch( e ) { C.fail( e ); }
    };
} )();
