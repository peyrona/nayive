/*
 * browse.js - eMail on the shared item browser (shared/browser.js): picking
 * rows, the one menu, the keys, drag and drop, and the tree of trays and
 * labels. See docs/item-browser-plan.md.
 *
 * THE LIST. A click picks a row, Ctrl+click adds / removes one, Shift+click
 * a range, a double-click (Enter, a tap) opens it - a draft opens to go on
 * writing it. In the wide (split) view a click also shows the mail on the
 * right; clearing the pick (Esc, a click on empty space, the ×) empties the
 * right side again. Opening a mail over the list (a phone, a narrow window)
 * clears the pick: the reader has its own buttons (#actions).
 *
 * ONE ACTION LIST (actionList): the header group while something is picked,
 * the menu (right-click = a row's ⋮ = the header's ⋮), the keys, and the
 * reader's buttons all read it. `where` hides an action in a tray where it
 * never applies (Not spam outside Spam); `when` greys it for this pick (Reply
 * needs one mail). Each runs the app's own call (actions.js, labels.js,
 * compose.js); nothing here writes on its own.
 *
 * THE TREE. The five trays, then "Labels" with the labels under it. A click
 * opens a tray / a label's list; the badge is how many are not read.
 * Right-click (⋮, a long press) gives a node its own menu: Trash and Spam
 * empty themselves (asked once: no way back), "Labels" makes one, a label is
 * edited or deleted (with Undo). Mail dropped on a label gets that label;
 * on Trash it is deleted (Undo), on Spam it goes there, from Spam onto the
 * Inbox it is "not spam". On a phone the tree slides in from #treeBtn.
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S;
    var ROLES = [ "inbox", "drafts", "sent", "spam", "trash" ];
    var OPEN_KEY = "nayive-mail-tree";      // this device: is "Labels" open

    var browse = null, treeView = null, actions = [];

    // ---------------------------------------------------------------------
    // rows <-> messages
    // ---------------------------------------------------------------------

    function itemOf( id )
    {
        if( S.open && S.open._id === id ) return S.open;
        for( var i = 0; i < S.items.length; i++ ) if( S.items[ i ]._id === id ) return S.items[ i ];
        return null;
    }
    function itemsOf( ids ) { return ids.map( itemOf ).filter( Boolean ); }

    // The rows picked, as messages.
    E.picked = function () { return browse ? itemsOf( browse.ids() ) : []; };

    // Several picked (or picking by touch): the list is not read again under
    // them (email.js refresh, compose.js). One row picked does not hold back
    // new mail: a re-read only loses that one highlight.
    E.picking = function ()
    {
        return !! browse && ( browse.picking() || browse.ids().length > 1 );
    };

    function roleIs( ids, r ) { var ms = itemsOf( ids ); return ms.length > 0 && ms.every( function ( m ) { return E.roleOf( m ) === r; } ); }
    function one( ids ) { return ids.length === 1; }
    function inTray( t ) { return ! S.label && S.tray === t; }

    // ---------------------------------------------------------------------
    // opening
    // ---------------------------------------------------------------------

    // double-click, Enter, a tap: a draft to go on writing it, a mail to read
    function openItem( id )
    {
        var m = itemOf( id );
        if( ! m ) return;
        if( E.roleOf( m ) === "drafts" ) { E.openDraft( m ); return; }
        if( E.split && S.open === m ) return;
        if( ! E.split && browse ) browse.clear();       // the reader has its own buttons
        E.openMessage( m );
    }

    // split: a plain click shows the mail on the right (a draft shows nothing:
    // it opens to be written, on a double-click)
    function preview( id )
    {
        if( ! E.split ) return;
        var m = itemOf( id );
        if( ! m || S.open === m ) return;
        if( E.roleOf( m ) === "drafts" ) { if( S.open ) E.closeMessage( true ); return; }
        E.openMessage( m );
    }

    // Reply, Reply all, Forward: from the mail open, or fetched first (a row
    // picked in the list; reading it marks it read, as opening it does).
    async function replyTo( m, mode )
    {
        if( S.open === m && S.msg ) { E.compose( { mode: mode, msg: S.msg } ); return; }
        var acct = E.acctOf( m );
        E.plug( "loading" );
        try
        {
            var msg = await E.api( "GET", encodeURIComponent( acct ) + "/msg/" + encodeURIComponent( m.ref ) +
                                          "?mid=" + encodeURIComponent( m.mid || "" ) );
            msg.acct = acct;
            E.plug( "synced" );
            E.markRowSeen( m );
            E.compose( { mode: mode, msg: msg } );
        }
        catch( err ) { E.plug( err.code === "gone" ? "synced" : "offline" ); NayiveUI.toast( E.errText( err ), { ms: 3500 } ); }
    }

    // ---------------------------------------------------------------------
    // the one action list (built once the dictionary is in)
    // ---------------------------------------------------------------------

    function actionList()
    {
        var T = E.T;
        var notDrafts = function () { return S.label || S.tray !== "drafts"; };
        return [
            { id: "open", label: T( "ui.open" ), icon: "external", key: "Enter", group: 0, when: one,
              run: function ( ids ) { openItem( ids[ 0 ] ); } },
            { id: "reply", label: T( "mail.reply" ), icon: E.icon( "reply" ), key: "R", bar: 1, group: 0, where: notDrafts,
              when: function ( ids ) { return one( ids ) && ! roleIs( ids, "drafts" ); },
              run: function ( ids ) { replyTo( itemOf( ids[ 0 ] ), "reply" ); } },
            { id: "replyAll", label: T( "mail.replyAll" ), icon: E.icon( "replyAll" ), key: "Shift+R", group: 0, where: notDrafts,
              when: function ( ids ) { return one( ids ) && ! roleIs( ids, "drafts" ); },
              run: function ( ids ) { replyTo( itemOf( ids[ 0 ] ), "all" ); } },
            { id: "forward", label: T( "mail.forward" ), icon: E.icon( "forward" ), key: "F", bar: 2, group: 0, where: notDrafts,
              when: function ( ids ) { return one( ids ) && ! roleIs( ids, "drafts" ); },
              run: function ( ids ) { replyTo( itemOf( ids[ 0 ] ), "fwd" ); } },
            // one key, both ways: some not read -> read; all read -> not read
            { id: "read", icon: E.icon( "unread" ), key: "U", bar: 3, phone: 1, group: 1,
              label: function ( ids ) { return T( anyUnread( ids ) ? "mail.markRead" : "mail.markUnread" ); },
              run: function ( ids ) { var ms = itemsOf( ids ); if( anyUnread( ids ) ) E.act.read( ms ); else E.act.unread( ms ); } },
            { id: "star", icon: E.icon( "star" ), key: "S", bar: 4, group: 1,
              label: function ( ids ) { return T( allStarred( ids ) ? "mail.unstar" : "mail.star" ); },
              run: function ( ids ) { E.act.star( itemsOf( ids ) ); } },
            { id: "label", label: T( "mail.labelsBtn" ), icon: E.icon( "tag" ), key: "L", bar: 5, phone: 1, group: 1,
              run: function ( ids ) { E.act.label( itemsOf( ids ) ); } },
            { id: "spam", label: T( "mail.toSpam" ), icon: E.icon( "spam" ), bar: 6, group: 2,
              where: function () { return ! inTray( "spam" ) && ! inTray( "trash" ); },
              when: function ( ids ) { return ! roleIs( ids, "spam" ) && ! roleIs( ids, "trash" ); },
              run: function ( ids ) { E.act.spam( itemsOf( ids ) ); } },
            { id: "notSpam", label: T( "mail.notSpam" ), icon: E.icon( "inbox" ), bar: 6, group: 2,
              where: function () { return S.label || S.tray === "spam"; },
              when: function ( ids ) { return roleIs( ids, "spam" ); },
              run: function ( ids ) { E.act.notSpam( itemsOf( ids ) ); } },
            { id: "restore", label: T( "mail.restore" ), icon: E.icon( "restore" ), bar: 7, group: 2,
              where: function () { return S.label || S.tray === "trash"; },
              when: function ( ids ) { return roleIs( ids, "trash" ); },
              run: function ( ids ) { E.act.restore( itemsOf( ids ) ); } },
            // to the Trash, with Undo; in the Trash: for good, with Undo (it
            // goes only when the Undo is gone)
            { id: "del", label: T( "mail.delete" ), icon: E.icon( "trash" ), key: [ "Del", "Backspace" ], bar: 8, phone: 1, group: 3, danger: true,
              where: function () { return ! inTray( "trash" ); },
              when: function ( ids ) { return ! roleIs( ids, "trash" ); },
              run: function ( ids ) { E.act.del( itemsOf( ids ) ); } },
            { id: "forget", label: T( "mail.forget" ), icon: E.icon( "forget" ), key: "Shift+Del", bar: 9, group: 3, danger: true,
              where: function () { return S.label || S.tray === "trash"; },
              when: function ( ids ) { return roleIs( ids, "trash" ); },
              run: function ( ids ) { E.act.forget( itemsOf( ids ) ); } }
        ];
    }

    function anyUnread( ids ) { return itemsOf( ids ).some( function ( m ) { return ! m.seen; } ); }
    function allStarred( ids ) { var ms = itemsOf( ids ); return ms.length > 0 && ms.every( function ( m ) { return m.flagged; } ); }

    // Right-click on empty space in the list: write one, pick by fields.
    function areaList()
    {
        return [
            { id: "compose", label: E.T( "mail.compose" ), icon: E.icon( "compose" ), key: "C",
              run: function () { E.compose( { mode: "new" } ); } },
            { id: "pick", label: E.T( "mail.pickGo" ) + "…", icon: E.icon( "selectAll" ),
              when: function () { return S.items.length > 0; },
              run: function () { E.openPick(); } }
        ];
    }

    function actionById( id ) { return actions.filter( function ( a ) { return a.id === id; } )[ 0 ] || null; }
    function here( a ) { return ! a.where || a.where(); }
    function fits( a, ids ) { return here( a ) && ( ! a.when || a.when( ids ) ); }

    // ---------------------------------------------------------------------
    // THE READER'S BUTTONS (a mail open over the list): the same actions,
    // on that one mail. Hidden where they do not apply to it.
    // ---------------------------------------------------------------------

    var READER = [ [ "actReply", "reply" ], [ "actReplyAll", "replyAll" ], [ "actForward", "forward" ], [ "actRead", "read" ],
                   [ "actUnread", "read" ], [ "actStar", "star" ], [ "actLabel", "label" ], [ "actSpam", "spam" ],
                   [ "actNotSpam", "notSpam" ], [ "actRestore", "restore" ], [ "actDelete", "del" ], [ "actForget", "forget" ] ];

    E.syncBar = function ()
    {
        var writing = E.isComposing && E.isComposing();
        var reading = !! S.open && ! writing && ! E.split;          // split: the list's pick has the buttons
        E.$( "backBtn" ).hidden = ! reading && ! writing;
        E.$( "actions" ).hidden = ! reading;
        if( browse )
        {
            // over the list (a window narrowed): the reader's buttons, no pick;
            // beside it (split): the mail on the right is the pick
            if( reading && browse.ids().length ) browse.clear();
            else if( E.split && S.open && ! writing && ! browse.ids().length && S.open._row && S.open._row.isConnected ) browse.set( [ S.open._id ] );
        }
        if( reading && S.open._id )
        {
            var ids = [ S.open._id ], m = S.open;
            READER.forEach( function ( b )
            {
                var a = actionById( b[ 1 ] ), btn = E.$( b[ 0 ] );
                var on = !! a && fits( a, ids );
                if( b[ 0 ] === "actRead" ) on = on && ! m.seen;
                if( b[ 0 ] === "actUnread" ) on = on && !! m.seen;
                btn.hidden = ! on;
                btn.disabled = false;
                if( ! a ) return;
                var l = typeof a.label === "function" ? a.label( ids ) : a.label;
                var k = a.key ? " (" + NayiveUI.keyLabel( a.key ) + ")" : "";
                btn.title = l + k;
                btn.setAttribute( "aria-label", l );
            } );
            E.$( "actStar" ).classList.toggle( "is-on", !! m.flagged );
        }
        if( browse ) browse.redraw();
    };

    function wireReader()
    {
        READER.forEach( function ( b )
        {
            E.$( b[ 0 ] ).addEventListener( "click", function () { runOnOpen( b[ 1 ] ); } );
        } );
        // the reader's keys: R, Shift+R, F, U, S, L, Del... on the mail open
        document.addEventListener( "keydown", function ( e )
        {
            if( e.defaultPrevented || ! S.open || E.split || E.isComposing() ) return;
            if( document.querySelector( ".sheet-backdrop.open" ) || NayiveUI.menuOpen() ) return;
            if( e.key === "Backspace" ) return;         // in the reader it is no "delete"
            var t = document.activeElement;
            if( t && t.closest && t.closest( "input, textarea, select, [contenteditable]" ) ) return;
            for( var i = 0; i < actions.length; i++ )
            {
                var a = actions[ i ];
                if( a.id === "open" || ! a.key || ! NayiveUI.keyMatches( a.key, e ) ) continue;
                if( ! fits( a, [ S.open._id ] ) ) return;
                e.preventDefault();
                runOnOpen( a.id );
                return;
            }
        } );
    }

    function runOnOpen( id )
    {
        var a = actionById( id );
        if( ! a || ! S.open || ! S.open._id ) return;
        var ids = [ S.open._id ];
        if( fits( a, ids ) ) a.run( ids );
    }

    // ---------------------------------------------------------------------
    // THE TREE: trays, then "Labels" and the labels
    // ---------------------------------------------------------------------

    function labelsOpen()
    {
        try { return localStorage.getItem( OPEN_KEY ) !== "closed"; } catch( e ) { return true; }
    }

    // a label's colour, as its tree icon (only a colour of the eight passes)
    function dot( c )
    {
        var col = /^#[0-9a-f]{3,8}$/i.test( c || "" ) || /^[a-z]+$/i.test( c || "" ) ? c : "currentColor";
        return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="' + col + '"></circle></svg>';
    }

    function treeRoots()
    {
        var out = ROLES.map( function ( role )
        {
            var t = S.trays.filter( function ( x ) { return x.role === role; } )[ 0 ] || { role: role };
            var unread = t.unread || 0, total = t.total || 0;
            return { id: role, name: E.T( "mail.tray." + role ), icon: E.icon( role ),
                     badge: unread ? E.count( unread ) : "",
                     title: t.missing ? E.T( "mail.missingTray" ) : E.TF( "mail.trayCount", { unread: unread, total: total } ),
                     cls: "mail-node-" + role + ( t.missing ? " is-missing" : "" ),
                     noMenu: role !== "trash" && role !== "spam" };
        } );
        out.push( { id: "labels", name: E.T( "mail.labels" ), icon: E.icon( "tag" ), cls: "mail-node-labels",
                    kids: S.labels.map( function ( l ) { return { id: "l:" + l.id, name: l.name, icon: dot( l.color ) }; } ) } );
        return out;
    }

    function labelOfNode( id ) { return id.indexOf( "l:" ) === 0 ? E.labelById( id.slice( 2 ) ) : null; }

    function go( id )
    {
        if( ROLES.indexOf( id ) >= 0 ) { E.openTray( id ); return; }
        var l = labelOfNode( id );
        if( l ) { E.openLabel( l.id ); return; }
        if( id === "labels" )
        {
            treeView.toggle( "labels" );
            // on a phone the sheet stays: a tap on "Labels" only opens / closes it
            if( window.matchMedia( "(max-width: 640px)" ).matches ) Promise.resolve().then( treeView.openSheet );
        }
    }

    // A node's own menu: what that tray or label can do.
    function nodeMenu( id, x, y, anchor )
    {
        var items = [];
        var T = E.T;
        if( id === "trash" || id === "spam" )
        {
            var spam = id === "spam";
            // it opens the tray first: you see what goes before saying yes
            items.push( { id: "empty", label: T( spam ? "mail.emptySpam" : "mail.emptyTrash" ), icon: E.icon( "forget" ), danger: true,
                          run: function () { if( ! inTray( id ) ) E.openTray( id ); E.act.emptyTray(); } } );
        }
        else if( id === "labels" )
            items.push( { id: "newLabel", label: T( "mail.newLabel" ), icon: "plus", run: function () { E.openLabelDialog( null ); } } );
        else
        {
            var l = labelOfNode( id );
            if( ! l ) return;
            items.push( { id: "editLabel", label: T( "mail.editLabel" ), icon: "edit", run: function () { E.openLabelDialog( l ); } } );
            items.push( { sep: true } );
            items.push( { id: "deleteLabel", label: T( "mail.removeLabel" ), icon: E.icon( "trash" ), danger: true,
                          run: function () { E.deleteLabel( l ); } } );
        }
        NayiveUI.menuAt( x, y, items, { anchor: anchor } );
    }

    // What dropped mail does on a node: a label adds it; Trash deletes (Undo);
    // Spam moves there; the Inbox takes mail out of Spam. false: no drop here.
    function dropVerb( ids, id )
    {
        var ms = itemsOf( ids || [] );
        if( ! ms.length ) return null;
        var roles = ms.map( E.roleOf );
        var all = function ( r ) { return roles.every( function ( x ) { return x === r; } ); };
        var none = function ( r ) { return roles.indexOf( r ) < 0; };
        if( labelOfNode( id ) ) return "label";
        if( id === "trash" && none( "trash" ) ) return "trash";
        if( id === "spam" && none( "spam" ) && none( "trash" ) ) return "spam";
        if( id === "inbox" && all( "spam" ) ) return "inbox";
        return null;
    }

    async function dropOn( ids, id )
    {
        var verb = dropVerb( ids, id ), ms = itemsOf( ids );
        if( ! verb ) return;
        if( verb === "trash" ) E.act.del( ms );
        else if( verb === "spam" ) E.act.spam( ms );
        else if( verb === "inbox" ) E.act.notSpam( ms );
        else
        {
            var l = labelOfNode( id );
            var n = await E.labelAdd( ms, l );
            if( n ) NayiveUI.toast( E.TF( "mail.labelAddedN", { name: l.name, n: n } ) );
        }
    }

    E.renderTree = function () { if( treeView ) treeView.render(); };

    // ---------------------------------------------------------------------
    // wiring (email.js start(), after the dictionary)
    // ---------------------------------------------------------------------

    E.wireBrowse = function ()
    {
        actions = actionList();
        treeView = NayiveUI.tree( {
            host:    E.$( "tree" ),
            pane:    E.$( "side" ),
            roots:   treeRoots,
            isOpen:  function ( id ) { return id === "labels" ? labelsOpen() : false; },
            setOpen: function ( id, v ) { try { localStorage.setItem( OPEN_KEY, v ? "open" : "closed" ); } catch( e ) {} },
            current: function () { return S.label ? "l:" + S.label : S.tray; },
            go:      go,
            menu:    nodeMenu,
            drop:    { can: function ( ids, id ) { return dropVerb( ids, id ) ? "inside" : false; }, drop: function ( ids, id ) { dropOn( ids, id ); } }
        } );
        E.browse = browse = NayiveUI.browser( {
            list:     E.$( "list" ),
            row:      ".mail-row",
            bar:      E.$( "selActions" ),
            actions:  actions,
            area:     areaList(),
            tree:     treeView,
            open:     openItem,
            preview:  preview,
            active:   function () { return S.accounts.length > 0 && E.listShown() && ! E.isComposing(); },
            pickable: function ( id ) { var m = itemOf( id ); return !! m && ( ! S.only || S.only.has( m ) ); },
            search:   function () { if( E.searchFold ) E.searchFold.open(); },
            drag:     { text: function ( ids ) { var m = itemOf( ids[ 0 ] ); return m ? m.subject || "" : ""; } },
            onSelect: function ( ids )
            {
                if( ! ids.length )
                {
                    E.showAll();
                    // split: the pick cleared by hand (its row still here) empties the right side
                    if( E.split && S.open && S.open._row && S.open._row.isConnected && ! E.isComposing() ) E.closeMessage( true );
                }
            }
        } );
        wireReader();
        E.$( "treeBtn" ).addEventListener( "click", function () { treeView.openSheet(); } );
    };
} )();
