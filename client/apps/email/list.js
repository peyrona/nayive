/*
 * list.js - the account picker, the five trays, the labels, and the list of
 * whatever is on screen: a tray (pages of 50, newest first, the next one
 * loading by itself when the end of the list comes into view) or a label
 * (every account's messages with it, from Nayive's own memory - one page).
 * Search: the words go to the mail server (Enter), which looks in the
 * senders, subjects and texts of this tray.
 *
 * PICKING AND OPENING is the shared item browser (browse.js): a click picks,
 * a double-click (a tap) opens. The rows here carry a stable id (m._id) for it.
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

    // The account picker, the tree (trays + labels: browse.js) and, on a
    // phone, the name of what is on screen beside the tree's button.
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

        if( E.renderTree ) E.renderTree();
        var l = S.label && E.labelById( S.label );
        E.$( "whereName" ).textContent = l ? l.name : E.T( "mail.tray." + S.tray );
    };

    // a tray's number, short, rounded down: 999, 9700 -> 9K
    E.count = function ( n ) { return n < 1000 ? String( n ) : Math.floor( n / 1000 ) + "K"; };

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
        E.endSelect();
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
        E.resetSearch();
        E.renderSide();
        E.loadList( false );
    };

    E.openAccount = function ( id )
    {
        leaveModes();
        S.acct = id;
        S.trays = [];
        S.label = "";
        E.resetSearch();
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
            S.only = null;
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
            S.next = page.next || "";
            var items = E.advFilter( ( page.items || [] ).filter( shown ), more );   // search.js (may end S.next)
            // split: the message open beside the list keeps its object (the
            // reader and the bar hold it), with what the list says now
            if( S.open ) items = items.map( function ( m ) { return E.acctOf( m ) === E.acctOf( S.open ) && m.ref === S.open.ref ? Object.assign( S.open, m ) : m; } );
            // each row's id for the item browser (the message open keeps its own)
            items.forEach( function ( m ) { if( ! m._id ) m._id = "m" + ( ++rowSeq ); } );
            S.items = S.items.concat( items );
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
                if( S.next && E.advPaused() ) pauseMore();
                else if( S.next ) watchMore();
                E.syncBar();
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
        E.$( "listEmptyText" ).textContent = E.T( S.label ? "mail.labelEmpty" : S.query || S.adv ? "mail.noResults" : "mail.empty" );
    };

    var rowSeq = 0;

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

        // the round tick and the ⋮ are the item browser's (drawn here: the grid places them)
        var el = h( "div", { class: "mail-row" + ( m.seen ? "" : " unread" ) +
                                    ( E.split && S.open === m ? " is-current" : "" ),
                             attrs: { "data-id": m._id, "data-ref": m.ref, role: "option" } },
                    h( "span", { class: "mail-tickbox", html: NayiveUI.tickHtml() } ),
                    h( "div", { class: "who", text: who } ),
                    h( "div", { class: "when", text: E.shortDate( m.date ), attrs: { title: E.longDate( m.date ) } } ),
                    subj,
                    m.snippet ? h( "div", { class: "snip", text: m.snippet } ) : null,
                    h( "span", { class: "mail-morebox", html: NayiveUI.moreHtml() } ) );
        if( S.only && ! S.only.has( m ) ) el.hidden = true;
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
        items.forEach( function ( m ) { if( m._row ) m._row.remove(); } );
        S.items = S.items.filter( function ( m ) { return items.indexOf( m ) < 0; } );
        E.showEmpty();
    };

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
                if( entries.some( function ( e ) { return e.isIntersecting; } ) && E.listShown() ) E.loadList( true );
            }, { root: E.$( "listView" ).parentNode, rootMargin: "300px" } );
        io.disconnect();
        io.observe( E.$( "listMore" ) );
    }

    // An advanced search found nothing in many pages in a row (search.js):
    // the list stops reading by itself, and a button reads on.
    function pauseMore()
    {
        if( io ) io.disconnect();
        var box = E.$( "listMore" );
        box.textContent = "";
        box.appendChild( E.h( "button", { class: "pill", text: E.T( "mail.advKeep" ), attrs: { type: "button" },
            on: { click: function () { S.advDry = 0; E.loadList( true ); } } } ) );
    }
} )();
