/*
 * email.js - start(): wire the bar, read the accounts, open the last tray.
 * Runs last (deferred scripts run in order).
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S;

    // Accounts or none: the page's two faces. Opens S.acct / S.tray.
    E.showAccounts = function ()
    {
        var any = S.accounts.length > 0;
        E.$( "noAcct" ).hidden = any;
        E.$( "side" ).hidden = ! any;
        E.$( "listView" ).hidden = ! any || ( !! S.open && ! E.split );
        E.showPane();
        E.$( "searchWrap" ).hidden = ! any;
        E.$( "searchBtn" ).hidden = ! any;
        if( ! any ) { E.plug( "synced" ); return; }
        E.openAccount( S.acct );
    };

    // The account and tray to open: the last ones on this device, or those a
    // notification's link names.
    function applyLast( last )
    {
        if( last.acct && E.account( last.acct ) ) S.acct = last.acct;
        if( last.tray && [ "inbox", "drafts", "sent", "spam", "trash" ].indexOf( last.tray ) >= 0 ) S.tray = last.tray;
    }

    // The plug, coming back to the page, and every few minutes on screen:
    // the counts again, and the list when it is at its top (never under the
    // reader's thumb). After a start that could not reach the server (the
    // phone just woken by a push), the first answer opens the page for real.
    E.refresh = async function ( force )
    {
        if( ! S.accounts.length && ! force && ! S.bootFailed ) return;
        if( S.selecting || E.isComposing() ) return;    // never under the user's ticks or pen
        try
        {
            var before = S.acct;
            await Promise.all( [ E.loadAccounts(), E.loadLabels() ] );
            if( S.bootFailed )
            {
                S.bootFailed = false;
                await E.loadSettings();
                applyLast( S.last || {} );
                E.showAccounts();
                return;
            }
            if( ! S.accounts.length ) { E.showAccounts(); return; }
            // the account on screen was removed elsewhere (or the first one was
            // added elsewhere): the page drawn again for the one there is
            if( S.acct !== before ) { E.showAccounts(); return; }
            await E.loadTrays();
            var main = E.$( "listView" ).parentNode;
            if( E.listShown() && ! S.label && ( force || main.scrollTop < 40 ) ) await E.loadList( false );
            else E.plug( "synced" );
        }
        catch( err ) { E.plug( "offline" ); }
    };

    function intro()
    {
        var T = E.T;
        NayiveUI.firstRun( {
            app:   "email",
            title: "eMail",
            lead:  T( "mail.introLead" ),
            buttons: [
                { svg: E.icon( "inbox" ), name: T( "mail.tray.inbox" ) + " · " + T( "mail.tray.trash" ), text: T( "mail.introTrays" ) },
                { icon: "forward", name: T( "mail.introReadName" ), text: T( "mail.introRead" ) },
                { icon: "search", name: T( "mail.search" ), text: T( "mail.introSearch" ) },
                { sel: "#composeBtn", text: T( "mail.introCompose" ) },
                { icon: "back", name: T( "mail.reply" ) + " \u00b7 " + T( "mail.forward" ), text: T( "mail.introReply" ) },
                { sel: "#fBold", name: T( "mail.format" ), text: T( "mail.introFormat" ) },
                { sel: "#selectBtn", text: T( "mail.introSelect" ) },
                { sel: "#actDelete", text: T( "mail.introDelete" ) },
                { sel: "#actLabel", text: T( "mail.introLabels" ) },
                { sel: "#labelAddBtn", text: T( "mail.introLabelAdd" ) },
                { sel: "#setBtn", text: T( "mail.introSettings" ) },
                { sel: "#syncIndicator", name: T( "ui.syncName" ), text: T( "mail.introSync" ) }
            ]
        } );
    }

    E.start = async function ()
    {
        E.fillIcons();
        intro();

        E.$( "backBtn" ).addEventListener( "click", function ()
        {
            if( E.isComposing() ) E.closeCompose( true );
            else if( S.open ) E.closeMessage( true );
            else if( S.selecting ) E.endSelect();
        } );
        E.$( "selectBtn" ).addEventListener( "click", function () { if( S.selecting ) E.endSelect(); else E.startSelect(); } );
        E.$( "setBtn" ).addEventListener( "click", function () { E.openSettings( "accounts" ); } );
        E.$( "emptyTrashBtn" ).addEventListener( "click", function () { E.act.emptyTray(); } );
        [ [ "actAll", "all" ], [ "actRead", "read" ], [ "actUnread", "unread" ], [ "actStar", "star" ], [ "actLabel", "label" ],
          [ "actSpam", "spam" ], [ "actNotSpam", "notSpam" ], [ "actDelete", "del" ], [ "actRestore", "restore" ],
          [ "actForget", "forget" ] ].forEach( function ( b ) { E.$( b[ 0 ] ).addEventListener( "click", function () { E.act[ b[ 1 ] ](); } ); } );
        document.addEventListener( "keydown", function ( e )
        {
            if( e.key === "Escape" && S.selecting && ! document.querySelector( ".sheet-backdrop.open" ) ) E.endSelect();
        } );
        E.$( "noAcctAdd" ).addEventListener( "click", function () { E.openSettings( "accounts" ); } );
        E.$( "addBtn" ).addEventListener( "click", E.addAccount );
        E.$( "imagesBtn" ).addEventListener( "click", E.showImages );
        E.$( "metaBtn" ).addEventListener( "click", E.toggleMeta );
        E.$( "readSubject" ).addEventListener( "click", function ()
        {
            if( ! String( getSelection() ) ) E.toggleMeta();     // not while its words are being selected
        } );
        E.$( "acctSel" ).addEventListener( "change", function ( e ) { E.openAccount( e.target.value ); } );
        E.$( "syncIndicator" ).addEventListener( "click", function () { E.refresh( true ); } );

        // The magnifier opens the field; its × and Escape clear the search and fold it.
        var input = E.$( "searchInput" );
        input.addEventListener( "keydown", function ( e )
        {
            if( e.key === "Enter" ) { e.preventDefault(); E.search( input.value ); }
        } );
        input.addEventListener( "input", function () { if( ! input.value ) E.search( "" ); } );
        // The funnel inside opens the advanced search (search.js).
        E.searchFold = NayiveUI.searchFold( { box: E.$( "searchWrap" ), input: input, toggle: E.$( "searchBtn" ),
                                              filter: E.openAdvSearch, filterTitle: "mail.advTitle",
                                              onClose: E.clearSearch } );

        // the phone's Back closes a message instead of leaving the app
        window.addEventListener( "popstate", function () { if( S.open ) E.closeMessage( false ); } );

        document.addEventListener( "visibilitychange", function () { if( ! document.hidden ) E.refresh( false ); } );
        // new mail pushed to this device (sw.js): the counts at once
        if( navigator.serviceWorker )
            navigator.serviceWorker.addEventListener( "message", function ( e ) { if( e.data && e.data.mail === "new" ) E.refresh( false ); } );
        setInterval( function () { if( ! document.hidden ) E.refresh( false ); }, 3 * 60 * 1000 );

        var last = E.recall();
        // a notification's link: that account's Inbox (sw.js opens email/?a=<id>)
        var want = new URLSearchParams( location.search ).get( "a" );
        if( want ) { last = { acct: want, tray: "inbox" }; try { history.replaceState( null, "", location.pathname ); } catch( e ) {} }
        E.plug( "loading" );
        try { await Promise.all( [ E.loadAccounts(), E.loadLabels(), E.loadSettings() ] ); }
        catch( err )
        {
            // no answer: the plug, coming back, or the next minutes try again
            // (E.refresh), and then open what was asked
            S.bootFailed = true;
            S.last = last;
            E.plug( "offline" );
            NayiveUI.toast( E.errText( err ), { ms: 4000 } );
            return;
        }
        applyLast( last );
        E.showAccounts();
    };

    document.addEventListener( "DOMContentLoaded", function ()
    {
        NayiveI18n.ready.then( function ()
        {
            NayiveUI.bootWithStore( null, function () { return E.start(); } );
        } );
    } );
} )();
