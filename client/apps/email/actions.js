/*
 * actions.js - what can be done to messages, and picking several.
 *
 * TARGETS: the message open (reading), or the rows ticked (picking). The
 * same buttons serve both, in the top bar; syncBar shows the ones that fit
 * where the targets are: Spam in the Spam tray becomes "Not spam", Delete in
 * the Trash becomes Restore + Delete for good. A label's list mixes trays and
 * accounts: every call goes per account, and the server sorts out the trays.
 *
 * Delete moves to the account's own Trash (its clock starts on the server,
 * mail_labels.go) and offers Undo, which puts it back where it was. Spam
 * offers Undo too: each goes back to the tray it came from. Delete for good
 * hides the rows at once and offers Undo too: the server deletes them only
 * when the Undo is gone (or the page closes). Empty Trash asks once.
 *
 * PARTLY DONE. Every call goes account by account, and a server may refuse
 * some messages one by one ("failed"): what went through leaves the list,
 * what did not stays, and the toast says how many.
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S;

    // ---------------------------------------------------------------------
    // picking several
    // ---------------------------------------------------------------------

    // pick( m ): tick or untick a row; start: also start picking
    E.pick = function ( m, start )
    {
        if( ! S.selecting ) E.startSelect();
        if( S.sel.has( m ) && ! start ) S.sel.delete( m );
        else S.sel.add( m );
        if( m._row ) m._row.classList.toggle( "is-picked", S.sel.has( m ) );
        E.syncBar();
    };

    E.startSelect = function ()
    {
        if( S.open ) E.closeMessage( true );
        S.selecting = true;
        document.body.classList.add( "selecting" );
        E.syncBar();
    };

    E.endSelect = function ()
    {
        S.selecting = false;
        S.sel.forEach( function ( m ) { if( m._row ) m._row.classList.remove( "is-picked" ); } );
        S.sel.clear();
        document.body.classList.remove( "selecting" );
        E.syncBar();
    };

    function targets()
    {
        if( S.open ) return [ S.open ];
        if( S.selecting ) return Array.from( S.sel );
        return [];
    }

    // The bar for the targets: which buttons, and which way the star points.
    E.syncBar = function ()
    {
        var writing = E.isComposing && E.isComposing();
        var reading = !! S.open && ! writing, picking = S.selecting && ! reading && ! writing;
        var list = targets(), n = list.length;
        E.$( "backBtn" ).hidden = ! reading && ! picking && ! writing;
        E.$( "actions" ).hidden = ! reading && ! picking;
        var count = E.$( "selCount" );
        count.hidden = ! picking;
        count.textContent = picking ? String( n ) : "";

        var roles = new Set( list.map( E.roleOf ) );
        var all = function ( r ) { return roles.size === 1 && roles.has( r ); };
        var inTrash = all( "trash" ), inSpam = all( "spam" );
        var flagged = n > 0 && list.every( function ( m ) { return m.flagged; } );
        function show( id, on ) { E.$( id ).hidden = ! on; E.$( id ).disabled = n === 0; }
        show( "actAll",      picking && S.items.length > 0 );
        E.$( "actAll" ).disabled = false;
        E.$( "actAll" ).classList.toggle( "is-on", picking && S.items.length > 0 && S.items.every( function ( m ) { return S.sel.has( m ); } ) );
        show( "actReply",    reading );
        show( "actReplyAll", reading );
        show( "actForward",  reading );
        show( "actRead",    picking );
        show( "actUnread",  true );
        show( "actStar",    true );
        show( "actLabel",   true );
        show( "actSpam",    ! inTrash && ! inSpam );
        show( "actNotSpam", inSpam );
        show( "actDelete",  ! inTrash );
        show( "actRestore", inTrash );
        show( "actForget",  inTrash );
        var star = E.$( "actStar" );
        star.classList.toggle( "is-on", flagged );
        star.title = E.T( flagged ? "mail.unstar" : "mail.star" );
        star.setAttribute( "aria-label", star.title );
    };

    // ---------------------------------------------------------------------
    // the calls
    // ---------------------------------------------------------------------

    // One POST per account the targets belong to. Answers `done` - the
    // targets that went through (not those of an account that failed, nor
    // those its server refused one by one) - and what went wrong, if anything.
    // A move also answers `moved`: target -> its new ref, where the server
    // told it.
    async function perAccount( list, path, body )
    {
        var groups = {}, out = { done: [], err: null, refused: 0, moved: new Map() };
        list.forEach( function ( m ) { ( groups[ E.acctOf( m ) ] = groups[ E.acctOf( m ) ] || [] ).push( m ); } );
        for( var acct in groups )
        {
            var b = Object.assign( { refs: groups[ acct ].map( function ( m ) { return m.ref; } ) }, body || {} );
            try
            {
                var data = await E.api( "POST", encodeURIComponent( acct ) + "/" + path, b );
                var failed = {};
                ( ( data && data.failed ) || [] ).forEach( function ( r ) { failed[ r ] = true; } );
                groups[ acct ].forEach( function ( m )
                {
                    if( failed[ m.ref ] ) { out.refused++; return; }
                    out.done.push( m );
                    if( data && data.moved && data.moved[ m.ref ] ) out.moved.set( m, data.moved[ m.ref ] );
                } );
            }
            catch( err ) { out.err = out.err || err; }
        }
        return out;
    }

    // What did not go through, told once the rest is done.
    function tell( r )
    {
        if( r.err ) throw r.err;
        if( r.refused ) NayiveUI.toast( E.TF( "mail.failedN", { n: r.refused } ), { ms: 4000 } );
    }

    async function run( fn )
    {
        E.plug( "saving" );
        try { await fn(); E.plug( "synced" ); }
        catch( err ) { E.plug( "offline" ); NayiveUI.toast( E.errText( err ), { ms: 3500 } ); }
        E.loadTrays().catch( function () {} );
    }

    // After a move: the targets leave this list (a label's list keeps them,
    // at their new place - it is read again).
    function gone( list )
    {
        if( S.open && list.indexOf( S.open ) >= 0 ) E.closeMessage( true );
        if( S.label ) { E.loadList( false ); return; }
        E.dropRows( list );
        if( S.selecting ) E.endSelect();
    }

    function setFlags( list, change )
    {
        return run( async function ()
        {
            var r = await perAccount( list, "set", change );
            r.done.forEach( function ( m )
            {
                if( change.seen !== undefined ) m.seen = change.seen;
                if( change.flagged !== undefined ) m.flagged = change.flagged;
                E.redrawRow( m );
            } );
            if( S.open && change.seen === false && r.done.indexOf( S.open ) >= 0 ) E.closeMessage( true );   // "unread" = I'll read it later
            E.syncBar();
            tell( r );
        } );
    }

    function moveTo( list, tray, done )
    {
        return run( async function ()
        {
            var r = await perAccount( list, "set", { tray: tray } );
            if( r.done.length ) gone( r.done );
            if( done && r.done.length ) done( r.done );
            tell( r );
        } );
    }

    // Spam's Undo: each back to its tray (`back`: { acct, ref in Spam, from }),
    // then the list read again.
    function unspam( back )
    {
        run( async function ()
        {
            var byTray = {}, out = { err: null, refused: 0 };
            back.forEach( function ( b ) { ( byTray[ b.from ] = byTray[ b.from ] || [] ).push( b ); } );
            for( var tray in byTray )
            {
                var r = await perAccount( byTray[ tray ], "set", { tray: tray } );
                out.err = out.err || r.err;
                out.refused += r.refused;
            }
            E.loadList( false );
            tell( out );
        } );
    }

    E.act = {
        read:    function () { setFlags( targets(), { seen: true } ); },
        unread:  function () { setFlags( targets(), { seen: false } ); },
        star:    function ()
        {
            var list = targets();
            setFlags( list, { flagged: ! list.every( function ( m ) { return m.flagged; } ) } );
        },
        // picking: every row loaded ticks (or, all ticked, none)
        all:     function ()
        {
            var every = S.items.length > 0 && S.items.every( function ( m ) { return S.sel.has( m ); } );
            S.items.forEach( function ( m )
            {
                if( every ) S.sel.delete( m ); else S.sel.add( m );
                if( m._row ) m._row.classList.toggle( "is-picked", ! every );
            } );
            E.syncBar();
        },
        // to Spam, with Undo: each back to the tray it came from, by the new
        // ref the server answered for it (a server that does not tell it - an
        // IMAP one without UIDPLUS - gets no Undo; "Not spam" still works)
        spam:    function ()
        {
            var list = targets();
            // whose each is and where from, taken now: a tray's rows do not
            // carry their account, and another may be on screen by the Undo
            var was = new Map( list.map( function ( m ) { return [ m, { acct: E.acctOf( m ), from: E.roleOf( m ) } ]; } ) );
            run( async function ()
            {
                var r = await perAccount( list, "set", { tray: "spam" } );
                if( ! r.done.length ) { tell( r ); return; }
                var back = r.done.map( function ( m ) { return { acct: was.get( m ).acct, from: was.get( m ).from, ref: r.moved.get( m ) }; } );
                gone( r.done );
                // a refusal's toast would take the Undo's place at once: no Undo then
                if( ! r.err && ! r.refused && back.every( function ( b ) { return b.ref; } ) )
                    NayiveUI.undoToast( E.T( "mail.movedSpam" ), function () { unspam( back ); } );
                else NayiveUI.toast( E.T( "mail.movedSpam" ) );
                tell( r );
            } );
        },
        notSpam: function () { moveTo( targets(), "inbox", function () { NayiveUI.toast( E.T( "mail.movedInbox" ) ); } ); },
        label:   function () { E.openLabelPicker( targets() ); },

        // to the Trash, with Undo: back to where each came from, by Message-ID
        del: function ()
        {
            moveTo( targets(), "trash", function ( list )
            {
                NayiveUI.undoToast( E.TF( "mail.deletedN", { n: list.length } ), function ()
                {
                    run( async function ()
                    {
                        var groups = {};
                        list.forEach( function ( m ) { ( groups[ E.acctOf( m ) ] = groups[ E.acctOf( m ) ] || [] ).push( m.mid ); } );
                        for( var acct in groups ) await E.api( "POST", encodeURIComponent( acct ) + "/restore", { mids: groups[ acct ] } );
                        E.loadList( false );
                    } );
                } );
            } );
        },
        restore: function ()
        {
            var list = targets();
            run( async function ()
            {
                var r = await perAccount( list, "restore" );
                if( r.done.length ) { gone( r.done ); NayiveUI.toast( E.T( "mail.restored" ) ); }
                tell( r );
            } );
        },
        // for good: out of sight at once (and kept out of a re-read:
        // S.goneRows), deleted when the Undo is gone - a page closed before
        // that deletes them too. Each row's account is taken now: a tray's
        // rows do not carry it, and another may be on screen by then.
        forget: function ()
        {
            var list = targets().filter( function ( m ) { return E.roleOf( m ) === "trash"; } );
            if( ! list.length ) return;
            var pinned = list.map( function ( m ) { return { acct: E.acctOf( m ), ref: m.ref }; } );
            var keys = pinned.map( function ( p ) { return p.acct + "|" + p.ref; } );
            var where = S.acct + "|" + S.tray + "|" + S.label;
            var here = function () { return where === S.acct + "|" + S.tray + "|" + S.label && ! S.open; };
            keys.forEach( function ( k ) { S.goneRows.add( k ); } );
            if( S.open ) E.closeMessage( true );
            E.dropRows( list );
            if( S.selecting ) E.endSelect();
            NayiveUI.undoToast( E.T( "mail.forgotten" ), function ()
            {
                keys.forEach( function ( k ) { S.goneRows.delete( k ); } );
                if( here() ) E.loadList( false );
            }, { onExpire: function ()
            {
                run( async function ()
                {
                    var r = await perAccount( pinned, "forget" );
                    // what the server kept comes back in sight (a deleted
                    // one's ref never comes again: it may stay in the set)
                    pinned.forEach( function ( p, i ) { if( r.done.indexOf( p ) < 0 ) S.goneRows.delete( keys[ i ] ); } );
                    // some stayed: the list shows them again
                    if( ( r.err || r.refused ) && here() ) E.loadList( false );
                    tell( r );
                } );
            } } );
        },
        // the Trash's or Spam's bar: everything there, for good (asks once)
        emptyTray: async function ()
        {
            var spam = S.tray === "spam";
            var yes = await NayiveUI.confirm( { title: E.T( spam ? "mail.emptySpamAsk" : "mail.emptyTrashAsk" ), body: E.T( "mail.cannotUndo" ),
                                                confirm: E.T( spam ? "mail.emptySpam" : "mail.emptyTrash" ), danger: true } );
            if( ! yes ) return;
            run( async function ()
            {
                var r = await E.api( "POST", encodeURIComponent( S.acct ) + ( spam ? "/spam/empty" : "/trash/empty" ), {} );
                NayiveUI.toast( E.TF( spam ? "mail.emptiedSpam" : "mail.emptied", { n: r.deleted || 0 } ) );
                E.loadList( false );
            } );
        }
    };

    // After labels changed on some rows (labels.js): their chips follow, and
    // a label's list drops what no longer carries it.
    E.labelsChanged = function ( list )
    {
        list.forEach( function ( m ) { E.redrawRow( m ); } );
        if( S.open ) E.renderReadLabels( S.open.labels );
        if( S.label )
        {
            var off = list.filter( function ( m ) { return ( m.labels || [] ).indexOf( S.label ) < 0; } );
            if( off.length && ! S.open ) E.dropRows( off );
        }
        E.syncBar();
    };
} )();
