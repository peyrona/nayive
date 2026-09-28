/*
 * list.js - the account picker, the five trays, the labels, and the list of
 * whatever is on screen: a tray (pages of 50, newest first, the next one
 * loading by itself when the end of the list comes into view) or a label
 * (every account's messages with it, from Nayive's own memory - one page).
 * Search: the words go to the mail server (Enter), which looks in the
 * senders, subjects and texts of this tray.
 *
 * PICKING SEVERAL (actions.js does the rest): a long press on a row, a right
 * click, Ctrl/Cmd + click, or the "select" button, and then a tap ticks or
 * unticks. A plain tap otherwise opens the message.
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S, h = E.h;

    var ROLES = [ "inbox", "drafts", "sent", "spam", "trash" ];

    // ---------------------------------------------------------------------
    // accounts, trays, labels
    // ---------------------------------------------------------------------

    E.loadAccounts = async function ()
    {
        var r = await E.api( "GET", "accounts" );
        S.accounts = ( r.accounts || [] ).filter( function ( a ) { return ! S.goneAccts.has( a.id ); } );
        if( S.accounts.length && ! E.account( S.acct ) ) S.acct = S.accounts[ 0 ].id;
        if( ! S.accounts.length ) S.acct = "";
        return S.accounts;
    };

    E.renderSide = function ()
    {
        var sel = E.$( "acctSel" );
        sel.hidden = S.accounts.length < 2;
        sel.textContent = "";
        S.accounts.forEach( function ( a )
        {
            var o = h( "option", { text: a.email + ( a.unread ? "  (" + a.unread + ")" : "" ), attrs: { value: a.id } } );
            if( a.id === S.acct ) o.selected = true;
            sel.appendChild( o );
        } );

        var box = E.$( "trays" );
        box.textContent = "";
        ROLES.forEach( function ( role )
        {
            var t = S.trays.filter( function ( x ) { return x.role === role; } )[ 0 ] || { role: role };
            // not read / all of them, on every tray ("3/7", "0/0")
            var unread = t.unread || 0, total = t.total || 0;
            var b = h( "button", { class: "pill mail-tray" + ( ! S.label && role === S.tray ? " is-active" : "" ) + ( t.missing ? " is-missing" : "" ),
                                   attrs: { type: "button", "data-tray": role,
                                            title: t.missing ? E.T( "mail.missingTray" ) : E.TF( "mail.trayCount", { unread: unread, total: total } ) },
                                   html: E.icon( role ),
                                   on: { click: function () { E.openTray( role ); } } },
                       h( "span", { text: E.T( "mail.tray." + role ) } ),
                       h( "span", { class: "mail-tray-n" + ( unread ? " has-new" : "" ) },
                          h( "b", { text: count( unread ) } ), h( "small", { text: "/" + count( total ) } ) ) );
            box.appendChild( b );
        } );

        // the labels' panel: each a pill, and a pencil to edit it (a long press
        // or a right click on the pill does the same)
        var lab = E.$( "labelsSide" );
        lab.textContent = "";
        S.labels.forEach( function ( l )
        {
            var pill = h( "button", { class: "pill mail-tray mail-label" + ( S.label === l.id ? " is-active" : "" ),
                                      attrs: { type: "button", "data-label": l.id } },
                          h( "i", { class: "mail-dot" } ), h( "span", { text: l.name } ) );
            pill.firstChild.style.setProperty( "--c", l.color );
            wireLabelPress( pill, l );
            var pen = h( "button", { class: "icon-btn sm mail-label-pen", html: NayiveUI.icon( "edit" ),
                                     attrs: { type: "button", title: E.T( "mail.editLabel" ), "aria-label": E.T( "mail.editLabel" ) },
                                     on: { click: function () { E.openLabelDialog( l ); } } } );
            lab.appendChild( h( "div", { class: "mail-label-line" + ( S.label === l.id ? " is-active" : "" ) }, pill, pen ) );
        } );
    };

    // a tray's number, short, rounded down: 999, 9700 -> 9K
    function count( n ) { return n < 1000 ? String( n ) : Math.floor( n / 1000 ) + "K"; }

    function wireLabelPress( el, l )
    {
        var timer = 0, long = false;
        el.addEventListener( "pointerdown", function ( e )
        {
            if( e.pointerType === "mouse" ) return;
            long = false;
            timer = setTimeout( function () { long = true; E.openLabelDialog( l ); }, 500 );
        } );
        [ "pointerup", "pointercancel", "pointerleave", "pointermove" ].forEach( function ( ev ) { el.addEventListener( ev, function () { clearTimeout( timer ); } ); } );
        el.addEventListener( "contextmenu", function ( e ) { e.preventDefault(); if( ! long ) E.openLabelDialog( l ); } );
        el.addEventListener( "click", function () { if( long ) { long = false; return; } E.openLabel( l.id ); } );
    }

    E.loadTrays = async function ()
    {
        if( ! S.acct ) return;
        var acct = S.acct;
        var r = await E.api( "GET", encodeURIComponent( acct ) + "/trays" );
        if( acct !== S.acct ) return;
        S.trays = r.trays || [];
        var inbox = S.trays.filter( function ( t ) { return t.role === "inbox"; } )[ 0 ];
        var a = E.account( acct );
        if( a && inbox ) a.unread = inbox.unread;
        E.renderSide();
    };

    // The account's trouble, over its list: a refused password, no answer.
    E.showProblem = function ( err )
    {
        var box = E.$( "acctProblem" );
        box.hidden = ! err;
        box.textContent = err ? E.errText( err ) : "";
    };

    function leaveModes()
    {
        if( E.isComposing() ) E.closeCompose( true );
        if( S.open ) E.closeMessage( true );
        if( S.selecting ) E.endSelect();
    }

    E.openTray = function ( role )
    {
        leaveModes();
        S.tray = role;
        S.label = "";
        E.remember();
        E.renderSide();
        E.loadList( false );
    };

    E.openLabel = function ( id )
    {
        leaveModes();
        S.label = id;
        S.query = "";
        E.$( "searchInput" ).value = "";
        E.$( "searchClear" ).hidden = true;
        E.renderSide();
        E.loadList( false );
    };

    E.openAccount = function ( id )
    {
        leaveModes();
        S.acct = id;
        S.trays = [];
        S.query = "";
        S.label = "";
        E.$( "searchInput" ).value = "";
        E.$( "searchClear" ).hidden = true;
        E.remember();
        E.renderSide();
        E.loadList( false );
        E.loadTrays().catch( function () {} );
    };

    // ---------------------------------------------------------------------
    // the list
    // ---------------------------------------------------------------------

    // loadList( false ): the first page, from scratch; ( true ): the next one.
    E.loadList = async function ( more )
    {
        if( ! S.acct ) return;
        if( more && ( S.loading || ! S.next || S.label ) ) return;
        var gen = more ? S.gen : ++S.gen;
        if( ! more )
        {
            S.items = [];
            S.next = "";
            S.sel.clear();
            E.$( "list" ).textContent = "";
            E.$( "listEmpty" ).hidden = true;
            E.$( "listView" ).parentNode.scrollTop = 0;
        }
        document.body.classList.toggle( "in-label", !! S.label );
        var bin = ! S.label && ( S.tray === "trash" || S.tray === "spam" ) ? S.tray : "";
        E.$( "trashBar" ).hidden = ! bin;
        if( bin === "trash" ) E.$( "trashBarText" ).textContent = E.TF( "mail.trashBar", { n: S.settings.trashDays } );
        if( bin === "spam" )  E.$( "trashBarText" ).textContent = E.T( "mail.spamBar" );
        if( bin )     // a red bin, as every "delete" in Nayive; its name in the tooltip
        {
            var tip = E.T( bin === "spam" ? "mail.emptySpam" : "mail.emptyTrash" );
            E.$( "emptyTrashBtn" ).title = tip;
            E.$( "emptyTrashBtn" ).setAttribute( "aria-label", tip );
        }

        S.loading = true;
        var moreBox = E.$( "listMore" );
        moreBox.hidden = false;
        moreBox.textContent = E.T( "mail.loading" );
        E.plug( "loading" );

        var path = S.label ? "label/" + encodeURIComponent( S.label )
                 : encodeURIComponent( S.acct ) + "/list?tray=" + encodeURIComponent( S.tray ) +
                   ( S.query ? "&q=" + encodeURIComponent( S.query ) : "" ) +
                   ( more ? "&cursor=" + encodeURIComponent( S.next ) : "" );
        try
        {
            var page = await E.api( "GET", path );
            if( gen !== S.gen ) return;
            var items = ( page.items || [] ).filter( shown );
            S.items = S.items.concat( items );
            S.next = page.next || "";
            E.showProblem( null );
            E.plug( "synced" );
            appendRows( items );
        }
        catch( err )
        {
            if( gen !== S.gen ) return;
            E.plug( "offline" );
            if( ! more ) E.showProblem( err );
            else NayiveUI.toast( E.errText( err ) );
        }
        finally
        {
            if( gen === S.gen )
            {
                S.loading = false;
                moreBox.hidden = ! S.next;
                moreBox.textContent = S.next ? E.T( "mail.loading" ) : "";
                E.showEmpty();
                if( S.next ) watchMore();
                if( S.selecting ) E.syncBar();
            }
        }
    };

    // A row whose going waits on its Undo (deleted for good, its account
    // being removed): a re-read of the list does not bring it back.
    function shown( m )
    {
        var acct = E.acctOf( m );
        return ! S.goneAccts.has( acct ) && ! S.goneRows.has( acct + "|" + m.ref );
    }

    E.showEmpty = function ()
    {
        var empty = ! S.items.length && E.$( "acctProblem" ).hidden;
        E.$( "listEmpty" ).hidden = ! empty;
        E.$( "listEmptyText" ).textContent = E.T( S.label ? "mail.labelEmpty" : S.query ? "mail.noResults" : "mail.empty" );
    };

    function appendRows( items )
    {
        var list = E.$( "list" );
        items.forEach( function ( m ) { list.appendChild( row( m ) ); } );
    }

    // Sent and Drafts show whom it went to; the rest, who sent it. A label's
    // list says which account a row is from, when there are several.
    function row( m )
    {
        var role = E.roleOf( m );
        var outgoing = role === "sent" || role === "drafts";
        var who = outgoing ? E.TF( "mail.toPrefix", { who: E.who( m.to ) || "—" } )
                           : ( E.who( m.from ) || E.T( "mail.noSender" ) );
        if( S.label && S.accounts.length > 1 && E.account( m.acct ) ) who = E.account( m.acct ).email + " · " + who;
        var subj = h( "div", { class: "subj" }, h( "span", { text: m.subject || E.T( "mail.noSubject" ) } ) );
        if( m.attach )  subj.insertAdjacentHTML( "beforeend", E.icon( "clip" ) );
        if( m.flagged ) subj.insertAdjacentHTML( "beforeend", E.icon( "star", "star" ) );
        subj.appendChild( E.chips( m.labels ) );

        var el = h( "button", { class: "mail-row" + ( m.seen ? "" : " unread" ) + ( S.sel.has( m ) ? " is-picked" : "" ),
                                attrs: { type: "button", "data-ref": m.ref } },
                    h( "i", { class: "mail-tick", html: NayiveUI.icon( "check" ) } ),
                    h( "div", { class: "who", text: who } ),
                    h( "div", { class: "when", text: E.shortDate( m.date ), attrs: { title: E.longDate( m.date ) } } ),
                    subj,
                    m.snippet ? h( "div", { class: "snip", text: m.snippet } ) : null );
        wirePress( el, m );
        m._row = el;
        return el;
    }

    // A row drawn again (its state changed), in place.
    E.redrawRow = function ( m )
    {
        if( ! m._row || ! m._row.parentNode ) return;
        var old = m._row;
        old.parentNode.replaceChild( row( m ), old );
    };

    // Rows that left this list (moved, deleted): gone from it at once.
    E.dropRows = function ( items )
    {
        items.forEach( function ( m )
        {
            if( m._row ) m._row.remove();
            S.sel.delete( m );
        } );
        S.items = S.items.filter( function ( m ) { return items.indexOf( m ) < 0; } );
        E.showEmpty();
    };

    // tap = open (or tick, while picking); long press / right click / Ctrl-click = start picking
    function wirePress( el, m )
    {
        var timer = 0, startX = 0, startY = 0, long = false;
        el.addEventListener( "pointerdown", function ( e )
        {
            if( e.pointerType === "mouse" ) return;
            long = false;
            startX = e.clientX; startY = e.clientY;
            clearTimeout( timer );
            timer = setTimeout( function () { long = true; E.pick( m, true ); }, 500 );
        } );
        el.addEventListener( "pointermove", function ( e )
        {
            if( Math.abs( e.clientX - startX ) > 10 || Math.abs( e.clientY - startY ) > 10 ) clearTimeout( timer );
        } );
        [ "pointerup", "pointercancel", "pointerleave" ].forEach( function ( ev ) { el.addEventListener( ev, function () { clearTimeout( timer ); } ); } );
        el.addEventListener( "contextmenu", function ( e ) { e.preventDefault(); if( ! long ) E.pick( m, true ); } );
        el.addEventListener( "click", function ( e )
        {
            if( long ) { long = false; return; }
            if( S.selecting || e.ctrlKey || e.metaKey ) E.pick( m );
            else if( E.roleOf( m ) === "drafts" ) E.openDraft( m );     // a draft opens to go on writing it
            else E.openMessage( m );
        } );
    }

    // A message was opened: its row turns read, the tray's count follows.
    E.markRowSeen = function ( m )
    {
        if( m.seen ) return;
        m.seen = true;
        if( m._row ) m._row.classList.remove( "unread" );
        if( S.label ) return;
        var t = S.trays.filter( function ( x ) { return x.role === S.tray; } )[ 0 ];
        if( t && t.unread > 0 ) t.unread--;
        var a = E.account( S.acct );
        if( a && S.tray === "inbox" && a.unread > 0 ) a.unread--;
        E.renderSide();
    };

    // The next page loads when the "Loading…" line under the list scrolls in.
    var io = null;
    function watchMore()
    {
        if( ! ( "IntersectionObserver" in window ) ) return;
        if( ! io )
            io = new IntersectionObserver( function ( entries )
            {
                if( entries.some( function ( e ) { return e.isIntersecting; } ) && ! S.open ) E.loadList( true );
            }, { root: E.$( "listView" ).parentNode, rootMargin: "300px" } );
        io.disconnect();
        io.observe( E.$( "listMore" ) );
    }

    // ---------------------------------------------------------------------
    // search
    // ---------------------------------------------------------------------

    E.search = function ( words )
    {
        words = ( words || "" ).trim();
        E.$( "searchClear" ).hidden = ! words;
        if( words === S.query ) return;
        S.query = words;
        E.loadList( false );
    };
} )();
