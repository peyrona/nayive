// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * info.js - the info screen of a chat (tap its name at the top): a person's
 * link, notifications and groups; a group's members; the photos and files
 * sent there. And the app's help. See core.js.
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h, T = C.T;

    var infoView = null;
    var openKind = null;       // the "Shared" kind shown under its buttons (its key), or null

    C.closeInfoNow = function ()
    {
        if( infoView ) infoView.remove();
        infoView = null;
        var conv = C.$( "#vConv" );
        if( conv && S.open ) conv.hidden = false;
    };

    C.refreshInfo = function ()
    {
        if( infoView && infoView._render ) infoView._render();
    };

    C.openInfo = async function ()
    {
        if( ! S.open ) return;
        if( S.more ) { try { await C.loadAll(); } catch( _ ) {} }
        C.closeInfoNow();
        openKind = null;
        infoView = h( "div", { class: "view" } );
        infoView._render = render;
        C.$( "#vConv" ).hidden = true;
        C.$( ".main" ).appendChild( infoView );
        C.pushNav( "info", C.closeInfoNow );
        render();
    };

    function row( icon, title, sub, onClick, cls, end )
    {
        return h( onClick ? "button" : "div", { class: "irow" + ( cls ? " " + cls : "" ), attrs: onClick ? { type: "button" } : {},
                                               on: onClick ? { click: onClick } : null },
            icon ? C.ic( icon ) : null,
            h( "div", { class: "t" }, title, sub ? h( "small", { text: sub } ) : null ),
            end || null );
    }

    function render()
    {
        var c = C.convOf( S.open );
        if( ! c || ! infoView ) { C.closeInfoNow(); return; }
        var owner = C.owns( c );   // the chat lives in my home (not a person's page, not another user's home)
        var ct = owner && c.kind === "d" ? C.contactOf( C.otherOf( c ) ) : null;
        var w = C.W( c );
        infoView.textContent = "";

        // (A person's link, a new link and Delete live in the chat's bar.)
        infoView.appendChild( h( "div", { class: "bar" }, C.btn( "back", "chat.back", C.back ),
                                 h( "div", { class: "who" }, h( "b", { text: T( "chat.chatOptions" ) } ) ) ) );

        var wallEl = h( "div", { class: "info-wall" } );
        var sub = c.kind === "g" ? C.TF( "chat.groupOf", { n: ( c.members || [] ).length } )
                : ct ? C.personState( ct )[ 1 ] + ( ct.opened ? " · " + C.TF( "chat.openedOn", { day: C.dayKey( ct.opened * 1000 ) } ) : "" )
                : c.via ? T( "chat.nayiveUser" )
                : "";
        // The owner changes a person's or a group's picture by tapping the
        // circle, and the name by tapping the name. (Search and mute live on
        // the chat's own bar - no second copy here.)
        // Another Nayive user (in my home or theirs): the picture is my own
        // for that account, so I change it from either side.
        var editable = owner && ( ct || c.kind === "g" );
        var acct = S.mode === "owner" && c.kind === "d" ? ( ct ? ct.user : c.via ) || "" : "";
        var face = C.ringIfOnline( C.avatar( c.id, c.name, "xl" ), c.id );
        var name = h( "b", { text: c.name } );
        if( editable || acct )
        {
            var cam = h( "span", { class: "cam" }, C.ic( "camera" ) );
            face = h( "button", { class: "face", attrs: { type: "button", title: T( "chat.changePhoto" ), "aria-label": T( "chat.changePhoto" ) },
                                  on: { click: function () { pickPhoto( c, ct, acct ); } } }, face, cam );
        }
        if( editable )
            name = h( "button", { class: "name-btn", attrs: { type: "button", title: T( "chat.rename" ) },
                                  on: { click: function () { rename( c ); } } }, c.name );
        wallEl.appendChild( h( "div", { class: "info-top" }, face, name, sub ? h( "small", { text: sub } ) : null ) );

        // Auto-delete, in words (the list's filters row shows it as a clock + days).
        // The owner changes it from here too.
        if( w.deleteAfter > 0 )
            wallEl.appendChild( h( "div", { class: "info-sec" },
                row( "clock", C.TF( "chat.ttlTitle", { n: w.deleteAfter } ), null, owner ? function () { C.openSettings( "autodel" ); } : null ) ) );

        // What this chat holds, one icon per kind, with how many. Only what the
        // messages already carry - nothing new is stored for it. A tap shows
        // that kind right under the buttons (a second tap hides it).
        var grid = h( "div", { class: "kinds" } );
        var shown = h( "div", { class: "kind-list" } );
        var kinds = sharedKinds();
        kinds.forEach( function ( k )
        {
            var n = k.items.length;
            var b = h( "button", { class: "kind", attrs: { type: "button", disabled: ! n, title: T( k.key ), "aria-pressed": "false" },
                                   data: { k: k.key },
                                   on: { click: function () { openKind = openKind === k.key ? null : k.key; showKind( grid, shown, kinds ); } } },
                h( "span", { class: "ki" }, C.ic( k.icon ), h( "b", { text: String( n ) } ) ),
                h( "span", { class: "kl", text: T( k.key ) } ) );
            grid.appendChild( b );
        } );
        showKind( grid, shown, kinds );
        wallEl.appendChild( h( "div", { class: "info-sec" }, h( "div", { class: "lbl", text: T( "chat.sharedHere" ) } ), grid, shown ) );

        if( ct ) personRows( wallEl, ct );
        if( c.kind === "g" ) groupRows( wallEl, c, owner );
        if( ! owner && c.kind === "d" )
            wallEl.appendChild( h( "p", { class: "list-note", text: C.TF( c.via ? "chat.userAbout" : "chat.guestAbout", { name: w.owner } ) } ) );
        infoView.appendChild( wallEl );
    }

    var VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|mpe?g|wmv)$/i;

    // The kinds a chat's messages carry. A video is a file a camera made (it
    // was sent as a file: only its name tells); a link sits inside a text.
    function sharedKinds()
    {
        var msgs = S.order.map( function ( x ) { return S.msgs.get( x ); } )
                          .filter( function ( m ) { return m && m.id > 0 && ! m.deleted && ! C.msgHidden( m.id ); } ).reverse();
        var of = function ( kind ) { return msgs.filter( function ( m ) { return m.kind === kind; } ); };
        var files = of( "file" );
        var links = [];
        msgs.forEach( function ( m ) { window.NayiveChatMarks.urls( m.text ).forEach( function ( u ) { links.push( { m: m, url: u } ); } ); } );
        return [
            { key: "chat.kPhotos",   icon: "image",   kind: "photo", items: of( "photo" ) },
            { key: "chat.kVideos",   icon: "video",   kind: "file",  items: files.filter( function ( m ) { return VIDEO_EXT.test( m.file.name ); } ) },
            { key: "chat.kFiles",    icon: "file",    kind: "file",  items: files.filter( function ( m ) { return ! VIDEO_EXT.test( m.file.name ); } ) },
            { key: "chat.kPlaces",   icon: "pin-map", kind: "loc",   items: of( "loc" ) },
            { key: "chat.kContacts", icon: "user",    kind: "card",  items: of( "card" ) },
            { key: "chat.kPolls",    icon: "poll",    kind: "poll",  items: of( "poll" ) },
            { key: "chat.kLinks",    icon: "link",    kind: "link",  items: links }
        ];
    }

    // The open kind (openKind), newest first, under the buttons: photos as a
    // grid, the rest as rows. Nothing open, or nothing left of it: empty.
    function showKind( grid, body, kinds )
    {
        var k = kinds.filter( function ( x ) { return x.key === openKind && x.items.length; } )[ 0 ] || null;
        if( ! k ) openKind = null;
        grid.querySelectorAll( ".kind" ).forEach( function ( b )
        {
            var on = !! k && b.dataset.k === k.key;
            b.classList.toggle( "is-active", on );
            b.setAttribute( "aria-pressed", on ? "true" : "false" );
        } );
        body.textContent = "";
        body.hidden = ! k;
        if( ! k ) return;
        var when = function ( m ) { return C.nameOf( m.from ) + " · " + C.dayKey( m.at ); };
        var jump = function ( id ) { C.back(); setTimeout( function () { C.jumpTo( id ); }, 120 ); };

        if( k.kind === "photo" )
        {
            var th = h( "div", { class: "thumbs" } );
            k.items.forEach( function ( m )
            {
                th.appendChild( h( "img", { attrs: { src: C.thumbUrl( m ), alt: "", loading: "lazy", title: when( m ) },
                                            on: { click: function () { C.openPhoto( m.id ); } } } ) );
            } );
            body.appendChild( th );
        }
        else k.items.forEach( function ( it )
        {
            var m = it.m || it;
            switch( k.kind )
            {
                case "file":
                    body.appendChild( row( k.icon, m.file.name, C.fmtBytes( m.file.size ) + " · " + when( m ),
                                           function () { location.href = C.mediaUrl( S.open, m.id, true ); }, null,
                                           h( "span", { class: "end" }, C.ic( "download" ) ) ) );
                    break;
                case "loc":
                    body.appendChild( row( k.icon, m.loc.place || ( m.loc.lat.toFixed( 5 ) + ", " + m.loc.lon.toFixed( 5 ) ), when( m ),
                                           function () { C.openMap( m.loc ); } ) );
                    break;
                case "card":
                    body.appendChild( row( k.icon, m.card.name, ( ( m.card.tels || [] )[ 0 ] || ( m.card.emails || [] )[ 0 ] || "" ) + " · " + when( m ),
                                           function () { jump( m.id ); } ) );
                    break;
                case "poll":
                    body.appendChild( row( k.icon, m.poll.q, when( m ), function () { jump( m.id ); } ) );
                    break;
                case "link":
                    body.appendChild( h( "a", { class: "irow", attrs: { href: it.url, target: "_blank", rel: "noopener noreferrer" } },
                        C.ic( "link" ), h( "div", { class: "t" }, h( "span", { class: "url", text: it.url } ), h( "small", { text: when( m ) } ) ) ) );
                    break;
            }
        } );
    }

    function personRows( wallEl, ct )
    {
        // (Their link and a new link are in the chat's "⋮".)
        var groups = S.convs.filter( function ( c ) { return c.kind === "g" && ( c.members || [] ).indexOf( ct.id ) >= 0; } )
                            .map( function ( c ) { return c.name; } );
        if( groups.length )
            wallEl.appendChild( h( "div", { class: "info-sec" }, row( "users", T( "chat.commonGroups" ), groups.join( ", " ) ) ) );
    }

    function groupRows( wallEl, c, owner )
    {
        var sec = h( "div", { class: "info-sec" } );
        sec.appendChild( h( "div", { class: "lbl", text: C.TF( "chat.nMembers", { n: ( c.members || [] ).length } ) } ) );
        if( owner )
            sec.appendChild( row( "user-plus", T( "chat.addPeople" ), null, function () { C.back(); setTimeout( function () { C.openNewGroup( c ); }, 50 ); } ) );
        ( c.members || [] ).forEach( function ( p )
        {
            var end = null;
            if( owner && p !== "o" )
                end = C.btn( "x", "chat.removeFromGroup", function ( e ) { e.stopPropagation(); removeMember( c, p ); }, "sm" );
            sec.appendChild( h( "div", { class: "irow" }, C.withDot( C.avatar( p, C.nameOf( p ), "sm" ), p ),
                                h( "div", { class: "t" }, p === C.me() ? T( "chat.you" ) : C.nameOf( p ),
                                   p === "o" ? h( "small", { text: T( "chat.admin" ) } ) : null ), end ) );
        } );
        wallEl.appendChild( sec );
    }

    // The chat's ⋮ -> Delete: the ways to delete, each with what it deletes.
    // Picking one does it at once - the dialog is the question (no second one).
    C.deleteDialog = function ( c, ct )
    {
        var body = h( "div" );
        var sh = null;
        function choice( label, what, act )
        {
            var b = h( "button", { class: "text-btn ghost danger", attrs: { type: "button" } }, C.ic( "trash" ), label );
            b.addEventListener( "click", function () { sh.close(); act(); } );
            body.appendChild( h( "div", { class: "del-opt" }, b, h( "p", { class: "hint", text: what } ) ) );
        }
        choice( T( "chat.deleteChat" ), T( "chat.deleteChatAsk" ), function () { C.clearChat( c ); } );
        if( ct ) choice( C.TF( "chat.deletePerson", { name: ct.name } ), T( ct.user ? "chat.deleteUserAsk" : "chat.deletePersonAsk" ),
                         function () { deletePerson( ct ); } );
        if( C.owns( c ) && c.kind === "g" )
            choice( T( "chat.deleteGroup" ), T( "chat.deleteGroupAsk" ), function () { deleteGroup( c ); } );
        sh = C.sheet( T( "chat.delete" ) + " · " + c.name, body );
    };

    // Settings › Auto-delete (the owner): one number of days for every
    // chat. The server applies it at once, then every hour; 0 = never.
    C.pendingTtl = null;       // { days } saved, not sent yet (its "Undo" on show)

    function showTtl( n )
    {
        S.deleteAfter = n;
        C.renderList();        // the clock on the filters row
        C.refreshInfo();       // and Info's line
    }

    function fmtCount( k )
    {
        try { return Number( k ).toLocaleString( document.documentElement.lang || undefined ); }
        catch( _ ) { return String( k ); }
    }
    // What the auto-delete dialog says a number of days would delete now.
    function countText( k )
    {
        return ! k ? T( "chat.autoDeleteNone" ) : k === 1 ? T( "chat.autoDeleteCountOne" ) : C.TF( "chat.autoDeleteCount", { count: fmtCount( k ) } );
    }

    // Settings › Auto-delete (list.js openSettings): the number, what it
    // would delete now, and save() for when the dialog closes.
    C.autoDeletePane = function ()
    {
        var input = h( "input", { attrs: { type: "number", id: "autoDelDays", min: "0", max: "3650", step: "1", inputmode: "numeric" },
                                  value: String( S.deleteAfter || 0 ) } );
        var countEl = h( "p", { class: "days-count", attrs: { "aria-live": "polite" } } );
        var el = h( "div", {},
            h( "p", { class: "dialog-text", text: T( "chat.autoDeleteLead" ) } ),
            // the number, then what it counts - one row
            h( "label", { class: "days-field", attrs: { for: "autoDelDays" } }, input, h( "span", { text: T( "chat.autoDeleteDays" ) } ) ),
            countEl,
            h( "p", { class: "hint", text: T( "chat.autoDeleteHint" ) } ) );

        // How many messages the number typed would delete NOW, in every chat,
        // asked as it is typed (J7): a typo - 1 for 10 - reads "deletes
        // 12 345 messages" before anything is saved. counts: days -> answer.
        var counts = {}, timer = 0;
        function countOf( n )
        {
            if( ! counts[ n ] ) counts[ n ] = C.api( "GET", "autodelete?days=" + n ).then( function ( r ) { return r.n; },
                                                    function () { delete counts[ n ]; return null; } );
            return counts[ n ];
        }
        function days()
        {
            var n = Number( input.value );
            return input.value.trim() !== "" && Number.isInteger( n ) && n > 0 && n <= 3650 ? n : 0;
        }
        function showCount()
        {
            var n = days();
            if( ! n ) { countEl.textContent = ""; return; }
            countOf( n ).then( function ( k )
            {
                if( days() !== n ) return;
                countEl.textContent = k == null ? "" : countText( k );
                countEl.classList.toggle( "none", k === 0 );
            } );
        }
        input.addEventListener( "input", function () { clearTimeout( timer ); countEl.textContent = ""; timer = setTimeout( showCount, 250 ); } );
        showCount();

        // Always a whole number of days, 0 to 3650: a number out of range
        // goes to the nearest end, an empty box back to the saved one.
        function value()
        {
            var raw = input.value.trim(), n = Number( raw );
            n = raw === "" || ! isFinite( n ) ? ( S.deleteAfter || 0 ) : Math.min( 3650, Math.max( 0, Math.round( n ) ) );
            if( input.value !== String( n ) ) { input.value = String( n ); showCount(); }
            return n;
        }
        input.addEventListener( "change", value );
        return {
            el: el,
            input: input,
            focus: function () { input.focus(); input.select(); },
            changed: function () { return value() !== ( S.deleteAfter || 0 ); },
            // The server deletes the old messages (for everyone) the moment
            // it hears: so it hears when the "Undo" is gone (the shared
            // undoToast: 6 s, the next toast, the page closing). Until then
            // the new number shows here only (C.pendingTtl: a summary read
            // meanwhile keeps it). The dialog is closed by now.
            save: async function ()
            {
                var n = value();
                clearTimeout( timer );
                var old  = S.deleteAfter || 0;
                var mine = C.pendingTtl = { days: n };
                showTtl( n );
                // The toast with the Undo says it too (the count, when known).
                var k = n ? await countOf( n ) : null;
                if( C.pendingTtl !== mine ) return;
                NayiveUI.undoToast( ! n ? T( "chat.autoDeleteOff" ) :
                                    k ? C.TF( "chat.autoDeleteOnCount", { n: n, count: fmtCount( k ) } ) : C.TF( "chat.autoDeleteOn", { n: n } ), function ()
                {
                    if( C.pendingTtl === mine ) C.pendingTtl = null;
                    showTtl( old );
                }, { onExpire: function ()
                {
                    C.api( "PUT", "autodelete", { days: n } ).then( function ()
                    {
                        if( C.pendingTtl === mine ) C.pendingTtl = null;
                    }, function ( e )
                    {
                        if( C.pendingTtl === mine ) { C.pendingTtl = null; showTtl( old ); }
                        C.fail( e );
                    } );
                } } );
            }
        };
    };

    C.showLink = function ( ct )
    {
        var body = C.linkBox( ct );
        C.sheet( C.TF( "chat.linkOf", { name: ct.name } ), body );
    };

    C.newLink = async function ( ct )
    {
        var ok = await NayiveUI.confirm( { title: T( "chat.newLink" ), body: C.TF( "chat.newLinkAsk", { name: ct.name } ),
                                           confirm: T( "chat.newLink" ) } );
        if( ! ok ) return;
        try
        {
            var out = await C.api( "POST", "contacts/" + ct.id + "/link" );
            await C.loadSummary();
            C.showLink( out );
        }
        catch( e ) { C.fail( e ); }
    };

    // A person or a group: off the list now, deleted when the "Undo" is gone (list.js deleteConv).
    function deletePerson( ct )
    {
        C.deleteConv( "d-" + ct.id, T( "ui.toast.deleted" ), function () { return C.api( "DELETE", "contacts/" + ct.id ); }, true );
    }

    function deleteGroup( c )
    {
        C.deleteConv( c.id, T( "ui.toast.deleted" ), function () { return C.api( "DELETE", "groups/" + c.id.slice( 2 ) ); }, true );
    }

    // Out at once; "Undo" puts them back in the same place.
    async function removeMember( c, p )
    {
        var gid    = c.id.slice( 2 );
        var before = ( c.members || [] ).filter( function ( x ) { return x !== "o"; } );
        var members = before.filter( function ( x ) { return x !== p; } );
        try { await C.api( "PATCH", "groups/" + gid, { members: members } ); }
        catch( e ) { C.fail( e ); return; }
        NayiveUI.undoToast( T( "ui.toast.removed" ), async function ()
        {
            // Whoever is in the group by now, with them back where they were.
            var now = C.convOf( c.id );
            var list = ( ( now && now.members ) || members ).filter( function ( x ) { return x !== "o" && x !== p; } );
            var at = before.indexOf( p );
            list.splice( at < 0 ? list.length : Math.min( at, list.length ), 0, p );
            try { await C.api( "PATCH", "groups/" + gid, { members: list } ); await C.loadSummary(); }
            catch( e ) { C.fail( e ); }
        } );
        C.loadSummary().catch( function () {} );
    }

    // A new picture: from this device or from Nayive (media.js pickImage),
    // made a JPEG of 300 px at most. A Nayive user's goes to my picture for
    // that account; a person picked from Contacts gives it to their card too.
    async function pickPhoto( c, ct, acct )
    {
        var file = await C.pickImage( T( "chat.changePhoto" ) );
        if( ! file ) return;
        try
        {
            var blob = await C.facePicture( file );
            var path = acct ? "users/" + encodeURIComponent( acct ) + "/photo"
                     : ( ct ? "contacts/" + ct.id : "groups/" + c.id.slice( 2 ) ) + "/photo";
            await C.putPicture( path, blob );
            if( ct && ct.card && ! acct ) await C.cardPicture( ct.card, blob );
            await C.loadSummary();
        }
        catch( e ) { C.fail( e ); }
    }

    async function rename( c )
    {
        var name = await C.askText( { title: T( "chat.rename" ), label: T( "chat.name" ), value: c.name,
                                      hint: c.kind === "d" ? T( "chat.nameSeen" ) : "" } );
        if( ! name || name === c.name ) return;
        try
        {
            if( c.kind === "d" ) await C.api( "PATCH", "contacts/" + c.id.slice( 2 ), { name: name } );
            else await C.api( "PATCH", "groups/" + c.id.slice( 2 ), { name: name } );
            await C.loadSummary();
        }
        catch( e ) { C.fail( e ); }
    }

    // ---------------------------------------------------------------------
    // help: the shared help dialog, one row per thing on screen. Two of
    // them (his call, 2026-09-21): the list's "?" tells the list only, the
    // open chat's "?" (its bar, before the ⋮) that chat only.
    // ---------------------------------------------------------------------

    C.showHelp = function ()
    {
        var owner = S.mode === "owner";
        var rows = [];
        rows.push( { sel: "#listSearch", name: T( "chat.search" ), text: T( "chat.helpSearch" ) } );
        if( owner )
        {
            rows.push( { sel: "#newChatBtn", name: T( "chat.newChat" ), text: T( "chat.helpNewChat" ) } );
            rows.push( { sel: "#settingsBtn", name: T( "ui.settings" ), text: T( "chat.helpSettings" ) } );
        }
        else
        {
            // a person's list keeps these two in its ⋮
            rows.push( { sel: "#listMenu .menu-item:nth-child(1)", name: "⋮ → " + T( "chat.notifications" ), text: T( "chat.helpBell" ) } );
            rows.push( { sel: "#listMenu .menu-item:nth-child(2)", name: "⋮ → " + T( "chat.homeIcon" ), text: T( "chat.helpHomeIcon" ) } );
        }
        NayiveUI.showIntro( { app: "chat", title: "Chat", lead: T( owner ? "chat.introLead" : "chat.introLeadGuest" ), buttons: rows } );
    };

    // The rows are read off the bar's buttons and the ⋮ menu themselves
    // (conv.js gives each its line), so the help always shows exactly what
    // this chat has. A button that did not fit the bar (fitBar) is in the ⋮.
    C.showConvHelp = function ()
    {
        var rows = [];
        [].forEach.call( document.querySelectorAll( "#convBar button[id]" ), function ( b )
        {
            if( ! b._help ) return;
            var name = b.getAttribute( "aria-label" ) || b.title;
            rows.push( { sel: "#" + b.id, name: b.classList.contains( "fit-out" ) ? "⋮ → " + name : name, text: T( b._help ) } );
        } );
        [].forEach.call( document.querySelectorAll( "#convMenu .menu-item" ), function ( b, i )
        {
            rows.push( { sel: "#convMenu .menu-item:nth-child(" + ( i + 1 ) + ")", name: "⋮ → " + b.textContent, text: T( b._help ) } );
        } );
        rows.push( { sel: "#emojiBtn", text: T( "chat.helpEmoji" ) } );
        rows.push( { sel: "#fmtBtn", text: T( "chat.helpFmt" ) } );
        rows.push( { sel: "#composer .later-btn:not([hidden])", text: T( "chat.helpLater" ) } );
        rows.push( { sel: "#attachBtn", text: T( "chat.helpAttach" ) } );
        rows.push( { sel: "#cameraBtn", text: T( "chat.helpCamera" ) } );
        rows.push( { sel: "#composer .send", name: T( "chat.sendMsg" ), text: T( "chat.helpSend" ) } );
        rows.push( { icon: "forward", name: T( "chat.holdName" ), text: T( "chat.helpHold" ) } );
        rows.push( { icon: "check", name: T( "chat.ticksName" ), text: T( "chat.helpTicks" ) } );
        NayiveUI.showIntro( { app: "chat", title: "Chat", buttons: rows } );
    };
} )();
