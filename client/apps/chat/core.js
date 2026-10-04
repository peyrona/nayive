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

    C.T  = function ( k )    { return NayiveUI.t( k ); };
    C.TF = function ( k, v ) { return NayiveUI.tf( k, v ); };

    // ---------------------------------------------------------------------
    // DOM
    // ---------------------------------------------------------------------

    C.$ = function ( sel, root ) { return ( root || document ).querySelector( sel ); };

    // h( "div", { class: "x", text: "…", on: { click: fn }, attrs: {…} }, child, … )
    // Children: elements, strings (text nodes), null (skipped), arrays. Shared
    // with eMail (shared/ui.js).
    C.h = NayiveUI.h;

    // Feather-style glyphs, 24x24.
    var ICONS = {
        back:        '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
        search:      '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/>',
        more:        '<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>',
        clip:        '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
        camera:      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
        smile:       '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
        send:        '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
        tick1:       '<polyline points="4 12.5 9 17.5 20 6.5"/>',
        tick2:       '<polyline points="1.5 12.5 6.5 17.5 17 7"/><polyline points="11.5 16.5 12.5 17.5 23 7"/>',
        clock:       '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
        alert:       '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
        reply:       '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
        forward:     '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
        copy:        '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        edit:        '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
        trash:       '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
        info:        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
        image:       '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
        file:        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
        "pin-map":   '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
        user:        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        users:       '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        "user-plus": '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
        chat:        '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
        download:    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
        bell:        '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
        "bell-off":  '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>',
        link:        '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        share:       '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
        "ios-share": '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
        "plus-square":'<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
        compass:     '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
        x:           '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        plus:        '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
        check:       '<polyline points="20 6 9 17 4 12"/>',
        ban:         '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
        pin:         '<path d="M9 3h6l-1 7 3 3H7l3-3z"/><line x1="12" y1="13" x2="12" y2="21"/>',
        chev:        '<polyline points="9 18 15 12 9 6"/>',
        "chev-l":    '<polyline points="15 18 9 12 15 6"/>',
        "chev-up":   '<polyline points="18 15 12 9 6 15"/>',
        "chev-down": '<polyline points="6 9 12 15 18 9"/>',
        minimize:    '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
        nav:         '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
        live:        '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/>',
        poll:        '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
        "arrow-right":'<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
        refresh:     '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
        book:        '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
        tabs:        '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
        video:       '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
        phone:       '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
        "video-off": '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>',
        "phone-off": '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/>',
        mic:         '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
        "mic-off":   '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
        external:    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
        gear:        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        help:        '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        home:        '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
        phone2:      '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
        folder:      '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
        textfmt:     '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
        bold:        '<path d="M6 4h8a4 4 0 0 1 0 8H6z"/><path d="M6 12h9a4 4 0 0 1 0 8H6z"/>',
        italic:      '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
        strike:      '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>',
        list:        '<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/>' +
                     '<circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>'
    };

    C.icon = function ( name, cls )
    {
        return '<svg class="ic' + ( cls ? " " + cls : "" ) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ( ICONS[ name ] || "" ) + '</svg>';
    };

    // An element holding just the icon.
    C.ic = function ( name, cls )
    {
        var t = document.createElement( "template" );
        t.innerHTML = C.icon( name, cls );
        return t.content.firstChild;
    };

    // A round .icon-btn with a glyph and a translated title.
    C.btn = function ( iconName, titleKey, onClick, extra )
    {
        var b = C.h( "button", { class: "icon-btn" + ( extra ? " " + extra : "" ), attrs: { type: "button",
                     title: C.T( titleKey ), "aria-label": C.T( titleKey ) }, on: { click: onClick } } );
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
        var who = C.S.mode === "owner" && method !== "GET" && window.GumApi && GumApi.owner && GumApi.owner();
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
            if( res.status === 401 && C.S.mode === "owner" && window.NayiveUI ) NayiveUI.sessionExpired();
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
        if( C.S.mode === "owner" && ! C.S.user && window.GumApi )
        {
            try { var w = await GumApi.probeAccess(); C.S.user = ( w && w.user ) || ""; } catch( _ ) {}
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

    C.toast = function ( key, ms ) { NayiveUI.toast( C.T( key ), { ms: ms || 2200 } ); };
    C.fail  = function ( e )
    {
        var msg = ( e && e.status === 404 ) ? C.T( "chat.gone" )
                : ( e && e.status === 413 ) ? C.T( "chat.tooBig" )
                : ( e && e.status === 429 ) ? C.T( "chat.tooFast" )
                : ( e && e.status === 507 ) ? C.T( "chat.noRoom" )
                : C.T( "chat.failed" );
        NayiveUI.toast( msg, { ms: 3000 } );
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
        var n = 0;
        for( var i = 0; i < pid.length; i++ ) n = ( n * 31 + pid.charCodeAt( i ) ) >>> 0;
        return 1 + ( n % 5 );
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

    var pad = NayiveUI.pad2;

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

    C.fmtBytes = function ( n ) { return NayiveUI.fmtBytes( n ); };

    // Accent- and case-blind, for searching.
    C.fold = function ( s )
    {
        return String( s || "" ).normalize( "NFD" ).replace( /[̀-ͯ]/g, "" ).toLowerCase();
    };

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
    C.stripMarks = function ( text ) { return text ? window.NayiveChatMarks.strip( text ) : ""; };

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
