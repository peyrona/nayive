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

        // (A person's link, a new link and Delete live in the chat's "⋮".)
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
        var editable = owner && ( ct || c.kind === "g" );
        var face = C.ringIfOnline( C.avatar( c.id, c.name, "xl" ), c.id );
        var name = h( "b", { text: c.name } );
        if( editable )
        {
            var cam = h( "span", { class: "cam" }, C.ic( "camera" ) );
            face = h( "button", { class: "face", attrs: { type: "button", title: T( "chat.changePhoto" ), "aria-label": T( "chat.changePhoto" ) },
                                  on: { click: function () { pickPhoto( c, ct ); } } }, face, cam );
            name = h( "button", { class: "name-btn", attrs: { type: "button", title: T( "chat.rename" ) },
                                  on: { click: function () { rename( c ); } } }, c.name );
        }
        wallEl.appendChild( h( "div", { class: "info-top" }, face, name, sub ? h( "small", { text: sub } ) : null ) );

        // Auto-delete, in words (the list's filters row shows it as a clock + days).
        // The owner changes it from here too.
        if( w.deleteAfter > 0 )
            wallEl.appendChild( h( "div", { class: "info-sec" },
                row( "clock", C.TF( "chat.ttlTitle", { n: w.deleteAfter } ), null, owner ? function () { C.openAutoDelete(); } : null ) ) );

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
    var URL_RE    = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/gi;

    // The kinds a chat's messages carry. A video is a file a camera made (it
    // was sent as a file: only its name tells); a link sits inside a text.
    function sharedKinds()
    {
        var msgs = S.order.map( function ( x ) { return S.msgs.get( x ); } )
                          .filter( function ( m ) { return m && m.id > 0 && ! m.deleted; } ).reverse();
        var of = function ( kind ) { return msgs.filter( function ( m ) { return m.kind === kind; } ); };
        var files = of( "file" );
        var links = [];
        msgs.forEach( function ( m ) { ( String( m.text || "" ).match( URL_RE ) || [] ).forEach( function ( u ) { links.push( { m: m, url: u } ); } ); } );
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

    // The list's ⋮ -> Auto-delete (the owner): one number of days for every
    // chat. The server applies it at once, then every hour; 0 = never.
    C.openAutoDelete = function ()
    {
        var input = h( "input", { attrs: { type: "number", id: "autoDelDays", min: "0", max: "3650", step: "1", inputmode: "numeric" },
                                  value: String( S.deleteAfter || 0 ) } );
        var ok = h( "button", { attrs: { type: "button", "data-act": "primary", title: T( "ui.save" ) } } );
        var no = h( "button", { attrs: { type: "button", "data-act": "close", title: T( "ui.cancel" ) } } );
        var back = h( "div", { class: "sheet-backdrop open", attrs: { role: "dialog", "aria-modal": "true" } },
            h( "div", { class: "sheet sheet--pack" },
                h( "h2", { text: T( "chat.autoDelete" ) } ),
                h( "p", { class: "dialog-text", text: T( "chat.autoDeleteLead" ) } ),
                // the number, then what it counts - one row
                h( "label", { class: "days-field", attrs: { for: "autoDelDays" } }, input, h( "span", { text: T( "chat.autoDeleteDays" ) } ) ),
                h( "p", { class: "hint", text: T( "chat.autoDeleteHint" ) } ),
                h( "div", { class: "sheet-actions" }, no, ok ) ) );
        document.body.appendChild( back );
        NayiveUI.applySheetButtons( back );
        function done() { back.remove(); document.removeEventListener( "keydown", esc, true ); }
        function esc( e ) { if( e.key === "Escape" && document.body.lastElementChild === back ) { e.stopPropagation(); done(); } }
        async function save()
        {
            var n = Number( input.value );
            if( input.value.trim() === "" || ! Number.isInteger( n ) || n < 0 || n > 3650 ) { input.focus(); input.select(); return; }
            ok.disabled = true;
            try
            {
                await C.api( "PUT", "autodelete", { days: n } );
                S.deleteAfter = n;
                C.renderList();   // the clock on the filters row
                done();
                NayiveUI.toast( n ? C.TF( "chat.autoDeleteOn", { n: n } ) : T( "chat.autoDeleteOff" ), { ms: 3000 } );
            }
            catch( e ) { ok.disabled = false; C.fail( e ); }
        }
        ok.addEventListener( "click", save );
        no.addEventListener( "click", done );
        input.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); save(); } } );
        document.addEventListener( "keydown", esc, true );
        setTimeout( function () { input.focus(); input.select(); }, 30 );
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

    async function deletePerson( ct )
    {
        try { await C.api( "DELETE", "contacts/" + ct.id ); C.leaveToList(); await C.loadSummary(); }
        catch( e ) { C.fail( e ); }
    }

    async function deleteGroup( c )
    {
        try { await C.api( "DELETE", "groups/" + c.id.slice( 2 ) ); C.leaveToList(); await C.loadSummary(); }
        catch( e ) { C.fail( e ); }
    }

    async function removeMember( c, p )
    {
        var members = ( c.members || [] ).filter( function ( x ) { return x !== "o" && x !== p; } );
        try { await C.api( "PATCH", "groups/" + c.id.slice( 2 ), { members: members } ); await C.loadSummary(); }
        catch( e ) { C.fail( e ); }
    }

    // A new picture: the camera or the gallery, shrunk here to 512 px.
    // From this device or from Nayive (media.js pickImage).
    async function pickPhoto( c, ct )
    {
        var file = await C.pickImage( T( "chat.changePhoto" ) );
        if( ! file ) return;
        try
        {
            var blob = await NayivePhoto.shrinkToJpeg( file, { maxW: 512, maxH: 512, quality: 0.85 } );
            var path = ( ct ? "contacts/" + ct.id : "groups/" + c.id.slice( 2 ) ) + "/photo";
            var res = await fetch( S.api + "/" + path, { method: "PUT", credentials: "same-origin",
                                                        headers: { "Content-Type": "image/jpeg" }, body: blob } );
            if( ! res.ok ) throw { status: res.status };
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
            rows.push( { sel: "#profileBtn", name: T( "chat.editProfile" ), text: T( "chat.helpProfile" ) } );
            rows.push( { sel: "#autoDelBtn", name: T( "chat.autoDelete" ), text: T( "chat.helpAutoDelete" ) } );
        }
        else
        {
            // a person's list keeps these two in its ⋮
            rows.push( { sel: "#listMenu .menu-item:nth-child(1)", name: "⋮ → " + T( "chat.notifications" ), text: T( "chat.helpBell" ) } );
            rows.push( { sel: "#listMenu .menu-item:nth-child(2)", name: "⋮ → " + T( "chat.homeIcon" ), text: T( "chat.helpHomeIcon" ) } );
        }
        NayiveUI.showIntro( { app: "chat", title: "Chat", lead: T( owner ? "chat.introLead" : "chat.introLeadGuest" ), buttons: rows } );
    };

    // The ⋮'s rows are read off the menu itself (conv.js gives each item its
    // line), so the help always shows exactly the items this chat has. A
    // button not on screen (a group has no phone) is skipped by showIntro.
    C.showConvHelp = function ()
    {
        var rows = [];
        rows.push( { sel: "#convCallBtn", text: T( "chat.helpVoiceCall" ) } );
        rows.push( { sel: "#convVideoBtn", text: T( "chat.helpVideoCall" ) } );
        [].forEach.call( document.querySelectorAll( "#convMenu .menu-item" ), function ( b, i )
        {
            rows.push( { sel: "#convMenu .menu-item:nth-child(" + ( i + 1 ) + ")", name: "⋮ → " + b.textContent, text: T( b._help ) } );
        } );
        rows.push( { sel: "#emojiBtn", text: T( "chat.helpEmoji" ) } );
        rows.push( { sel: "#composer .later-btn:not([hidden])", text: T( "chat.helpLater" ) } );
        rows.push( { sel: "#attachBtn", text: T( "chat.helpAttach" ) } );
        rows.push( { sel: "#cameraBtn", text: T( "chat.helpCamera" ) } );
        rows.push( { sel: "#composer .send", name: T( "chat.sendMsg" ), text: T( "chat.helpSend" ) } );
        rows.push( { icon: "forward", name: T( "chat.holdName" ), text: T( "chat.helpHold" ) } );
        rows.push( { icon: "check", name: T( "chat.ticksName" ), text: T( "chat.helpTicks" ) } );
        NayiveUI.showIntro( { app: "chat", title: "Chat", buttons: rows } );
    };
} )();
