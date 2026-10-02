/*
 * search.js - eMail's advanced search: the funnel in the search box opens a
 * dialog (From, To, Subject, words, dates, read or not, label, attachments,
 * starred) for the tray on screen.
 *
 * The mail server only searches WORDS (IMAP TEXT, JMAP "text"), so what was
 * typed in From / To / Subject goes to it as words too, each one a phrase:
 * it hands back every mail that holds them anywhere. Each row is then checked
 * here, field by field, together with the rest (dates, read or not, label,
 * attachments, starred), which the server is not asked about at all.
 *
 * A row that fails the check is simply not listed, and the list reads its
 * next page by itself (list.js watchMore) until the screen fills. So a rare
 * match does not read the whole tray without asking, DRY_PAGES pages in a row
 * with no match stop it, and a button offers to keep going. Rows come newest
 * first, so a page reaching past "Since" ends the search.
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S, h = E.h;
    var DRY_PAGES = 10;

    S.words     = "";     // the search box's words
    S.adv       = null;   // the dialog's fields in force (null = none)
    S.searchKey = "";     // words + fields of the list on screen
    S.advDry    = 0;      // pages in a row with no match (the pause above)

    // Case- and accent-blind: "jose" finds "José".
    function plain( s )
    {
        return String( s || "" ).normalize( "NFD" ).replace( /[̀-ͯ]/g, "" ).toLowerCase();
    }
    function phrase( s )
    {
        s = String( s || "" ).replace( /"/g, " " ).trim();
        return /\s/.test( s ) ? '"' + s + '"' : s;
    }
    function addrsHave( list, want )
    {
        return ( list || [] ).some( function ( a ) { return plain( ( a.name || "" ) + " " + ( a.addr || "" ) ).indexOf( want ) >= 0; } );
    }
    function dayStart( iso ) { var p = iso.split( "-" ); return new Date( +p[ 0 ], p[ 1 ] - 1, +p[ 2 ] ).getTime(); }

    // What the server is asked: the box's words, then the fields' words.
    function serverQuery()
    {
        var a = S.adv || {};
        return [ S.words, phrase( a.from ), phrase( a.to ), phrase( a.subject ) ]
            .filter( function ( w ) { return w; } ).join( " " );
    }

    // The search to show: a new list only when it asks something new.
    E.runSearch = function ()
    {
        S.query = serverQuery();
        var key = JSON.stringify( [ S.query, S.adv ] );
        showState();
        if( key === S.searchKey ) return;
        S.searchKey = key;
        E.loadList( false );
    };

    // The box's Enter: its words, the dialog's fields kept.
    E.search = function ( words )
    {
        S.words = ( words || "" ).trim();
        E.runSearch();
    };

    // The box's × and Escape: words and fields both go.
    E.clearSearch = function ()
    {
        S.words = "";
        S.adv = null;
        E.runSearch();
    };

    // Back to no search at all (another account, a label), the box folded:
    // the caller loads the list.
    E.resetSearch = function ()
    {
        S.words = "";
        S.adv = null;
        S.query = "";
        S.searchKey = "";
        if( E.searchFold ) E.searchFold.close( true );
        E.$( "searchInput" ).value = "";
        showState();
    };

    // list.js, for each page: the rows that pass. Also keeps the count of
    // pages in a row that gave none, and ends the list once a page reaches
    // past "Since" (rows come newest first).
    E.advFilter = function ( items, more )
    {
        if( ! more ) S.advDry = 0;
        var a = S.adv;
        if( ! a ) return items;
        var since = a.since ? dayStart( a.since ) : 0;
        var until = a.until ? dayStart( a.until ) + 86400000 : 0;
        var from = plain( a.from ), to = plain( a.to ), subj = plain( a.subject );
        var out = items.filter( function ( m )
        {
            var t = new Date( m.date ).getTime();
            if( since && ! ( t >= since ) ) return false;
            if( until && ! ( t < until ) ) return false;
            if( a.seen === "unread" && m.seen ) return false;
            if( a.seen === "read" && ! m.seen ) return false;
            if( from && ! addrsHave( m.from, from ) ) return false;
            if( to && ! addrsHave( m.to, to ) ) return false;
            if( subj && plain( m.subject ).indexOf( subj ) < 0 ) return false;
            if( a.label && ( m.labels || [] ).indexOf( a.label ) < 0 ) return false;
            if( a.attach && ! m.attach ) return false;
            if( a.starred && ! m.flagged ) return false;
            return true;
        } );
        S.advDry = out.length ? 0 : S.advDry + 1;
        var last = items[ items.length - 1 ];
        if( since && last && new Date( last.date ).getTime() < since ) S.next = "";
        return out;
    };

    // list.js: may the list read its next page by itself?
    E.advPaused = function () { return !! S.adv && S.advDry >= DRY_PAGES; };

    // The funnel lit, and the bar over the list saying what is asked.
    function showState()
    {
        var a = S.adv;
        E.$( "searchWrap" ).classList.toggle( "filter-on", !! a );
        E.$( "advBar" ).hidden = ! a;
        if( ! a ) return;
        var bits = [];
        if( a.from )    bits.push( E.T( "mail.pickFrom" ) + ": " + a.from );
        if( a.to )      bits.push( E.T( "mail.advTo" ) + ": " + a.to );
        if( a.subject ) bits.push( E.T( "mail.pickSubject" ) + ": " + a.subject );
        if( a.since )   bits.push( E.T( "mail.advSince" ) + " " + a.since );
        if( a.until )   bits.push( E.T( "mail.advUntil" ) + " " + a.until );
        if( a.seen )    bits.push( E.T( a.seen === "unread" ? "mail.pickUnread" : "mail.pickRead" ) );
        if( a.label )
        {
            var l = S.labels.filter( function ( x ) { return x.id === a.label; } )[ 0 ];
            if( l ) bits.push( E.T( "mail.pickLabel" ) + ": " + l.name );
        }
        if( a.attach )  bits.push( E.T( "mail.pickAttach" ) );
        if( a.starred ) bits.push( E.T( "mail.pickStarred" ) );
        E.$( "advBarText" ).textContent = bits.join( " · " );
    }

    // ---------------------------------------------------------------------
    // the dialog
    // ---------------------------------------------------------------------

    var FIELDS = [ "from", "to", "subject", "since", "until", "seen", "label" ];
    function el( f ) { return E.$( "adv" + f.charAt( 0 ).toUpperCase() + f.slice( 1 ) ); }

    // The native date text is hidden (.dt-field): the overlay shows yyyy-mm-dd.
    function showDates()
    {
        [ "since", "until" ].forEach( function ( f )
        {
            var inp = el( f );
            inp.parentNode.querySelector( ".dt-display" ).textContent = inp.value;
        } );
    }

    function fill( a )
    {
        a = a || {};
        var sel = E.$( "advLabel" );
        sel.textContent = "";
        sel.appendChild( h( "option", { text: E.T( "mail.pickAny" ), attrs: { value: "" } } ) );
        S.labels.forEach( function ( l ) { sel.appendChild( h( "option", { text: l.name, attrs: { value: l.id } } ) ); } );
        sel.parentNode.hidden = ! S.labels.length;
        FIELDS.forEach( function ( f ) { el( f ).value = a[ f ] || ""; } );
        if( a.label && ! S.labels.some( function ( l ) { return l.id === a.label; } ) ) sel.value = "";
        E.$( "advAttach" ).checked = !! a.attach;
        E.$( "advStarred" ).checked = !! a.starred;
        showDates();
    }

    E.openAdvSearch = function ()
    {
        fill( S.adv );
        E.$( "advWords" ).value = E.$( "searchInput" ).value.trim();
        NayiveUI.open( "advSheet" );
        E.$( "advFrom" ).focus();
    };

    function apply()
    {
        var a = {}, any = false;
        FIELDS.forEach( function ( f )
        {
            var v = el( f ).value.trim();
            if( v ) { a[ f ] = v; any = true; }
        } );
        if( a.since && a.until && a.since > a.until ) { var t = a.since; a.since = a.until; a.until = t; }
        if( E.$( "advAttach" ).checked )  { a.attach = true; any = true; }
        if( E.$( "advStarred" ).checked ) { a.starred = true; any = true; }
        NayiveUI.close( "advSheet" );
        S.adv = any ? a : null;
        S.words = E.$( "advWords" ).value.trim();
        E.$( "searchInput" ).value = S.words;
        if( S.adv || S.words ) E.searchFold.open( true );
        E.runSearch();
    }

    E.$( "advGoBtn" ).addEventListener( "click", apply );
    E.$( "advClearBtn" ).addEventListener( "click", function () { fill( null ); E.$( "advWords" ).value = ""; } );
    [ "since", "until" ].forEach( function ( f ) { el( f ).addEventListener( "input", showDates ); } );
    E.$( "advSheet" ).addEventListener( "keydown", function ( e )
    {
        if( e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "checkbox" ) { e.preventDefault(); apply(); }
    } );
    // "Remove filters": the fields go, the box's words stay.
    E.$( "advOffBtn" ).addEventListener( "click", function ()
    {
        S.adv = null;
        if( ! S.words ) E.searchFold.close();
        else E.runSearch();
    } );
} )();
