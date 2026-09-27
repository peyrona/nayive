/*
 * core.js - the eMail app's shared basics: state, the server, icons, dates,
 * names. The other email/*.js files add to the same object:
 *
 *     core.js      this file
 *     list.js      the trays and the list of a tray (pages, search)
 *     read.js      one message (header, attachments, the body frame)
 *     accounts.js  the accounts dialog (add, remove)
 *     labels.js    Nayive's labels: the picker, the settings dialog
 *     actions.js   picking several, and what can be done to messages
 *     email.js     start()
 *
 * All classic scripts (defer), one global: window.NayiveMail (below: E). A
 * function of one file calls another's as E.name(), at call time.
 *
 * SAFETY. Everything that came in a message (names, subjects, snippets, file
 * names, plain text) goes on screen through textContent, never innerHTML. The
 * one exception is the message's HTML, and that only inside the sandboxed
 * frame of read.js. innerHTML is used for our own icons only.
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail = window.NayiveMail || {};
    var S;

    S = E.S = {
        accounts: [],      // [{ id, email, name, unread, error }]
        acct:     "",      // the account on screen
        tray:     "inbox",
        trays:    [],      // the account's five, with counts
        items:    [],      // the rows of the tray on screen
        next:     "",      // the cursor of the page after them
        query:    "",      // the search in force
        loading:  false,
        gen:      0,       // bumps on every new list: an old answer is dropped
        open:     null,    // the message on screen (read.js), or null
        label:    "",      // a label's list on screen instead of a tray ("" = a tray)
        labels:   [],      // [{ id, name, color }] - Nayive's own, every account's
        colors:   [],      // the eight a label can have
        settings: { trashDays: 30, showImages: false },
        selecting: false,  // picking several (actions.js)
        sel:      new Set(),  // the rows picked (items of S.items)
        // out of sight while their Undo is on show - a re-read never brings
        // them back: accounts being removed (accounts.js), labels being
        // deleted (labels.js), rows deleted for good ("acct|ref", actions.js)
        goneAccts:  new Set(),
        goneLabels: new Set(),
        goneRows:   new Set()
    };

    // The account a row belongs to: a label's list mixes them.
    E.acctOf = function ( m ) { return ( m && m.acct ) || S.acct; };
    E.roleOf = function ( m ) { return String( ( m && m.ref ) || "" ).split( "." )[ 0 ]; };

    E.T  = function ( k ) { return NayiveUI.t( k ); };
    E.TF = function ( k, v ) { return NayiveUI.tf( k, v ); };
    E.$  = function ( id ) { return document.getElementById( id ); };

    // ---------------------------------------------------------------------
    // the server
    // ---------------------------------------------------------------------

    // E.api( "GET", "a1/list?tray=inbox" ) -> the JSON answer. A failure
    // throws an Error with .status and .code ("auth", "down", "gone"...).
    E.api = async function ( method, path, body )
    {
        var opts = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
        if( body !== undefined )
        {
            opts.headers[ "Content-Type" ] = "application/json";
            opts.body = JSON.stringify( body );
        }
        var res;
        try { res = await fetch( "/api/mail/" + path, opts ); }
        catch( e )
        {
            var off = new Error( "offline" );
            off.status = 0;
            off.code = "offline";
            throw off;
        }
        var data = null;
        try { data = await res.json(); } catch( e ) {}
        if( ! res.ok )
        {
            if( res.status === 401 && window.NayiveUI ) NayiveUI.sessionExpired();
            var err = new Error( ( data && data.error ) || ( "HTTP " + res.status ) );
            err.status = res.status;
            err.code = ( data && data.code ) || ( res.status === 401 ? "session" : "down" );
            err.text = ( data && data.text ) || "";      // a refusal: the mail server's own words
            throw err;
        }
        return data;
    };

    // What to tell the user about a failed call, in their language. A
    // refusal carries the mail server's own words ("550 no such user…").
    E.errText = function ( err )
    {
        var code = err && err.code;
        var words = err && err.text ? ": " + err.text : "";
        if( code === "rejected" || code === "smtp" ) return E.T( "mail.err." + code ) + words;
        if( [ "auth", "gone", "dup", "bad", "hosts", "blocked", "notray", "addr", "big", "norcpt", "url", "offline",
              "toobig", "private", "key" ].indexOf( code ) >= 0 )
            return E.T( "mail.err." + code );
        return E.T( "mail.err.down" );
    };

    // The header plug: busy while asking, green when the server answered,
    // gold when it did not. Its click re-reads (email.js).
    E.plug = function ( state )
    {
        NayiveUI.applySyncState( "syncIndicator", state );
    };

    // ---------------------------------------------------------------------
    // what is remembered on this device: the account and tray last open
    // ---------------------------------------------------------------------

    E.remember = function ()
    {
        try { localStorage.setItem( "nayive-mail-last", JSON.stringify( { acct: E.S.acct, tray: E.S.tray } ) ); } catch( e ) {}
    };
    E.recall = function ()
    {
        try { return JSON.parse( localStorage.getItem( "nayive-mail-last" ) || "null" ) || {}; } catch( e ) { return {}; }
    };

    // ---------------------------------------------------------------------
    // building DOM
    // ---------------------------------------------------------------------

    // h( "div", { class, text, attrs, on }, child... )
    E.h = function ( tag, o )
    {
        var el = document.createElement( tag );
        o = o || {};
        if( o.class ) el.className = o.class;
        if( o.text != null ) el.textContent = o.text;
        if( o.html != null ) el.innerHTML = o.html;          // our own icons only
        if( o.attrs ) Object.keys( o.attrs ).forEach( function ( k ) { if( o.attrs[ k ] != null ) el.setAttribute( k, o.attrs[ k ] ); } );
        if( o.on ) Object.keys( o.on ).forEach( function ( k ) { el.addEventListener( k, o.on[ k ] ); } );
        for( var i = 2; i < arguments.length; i++ )
        {
            var c = arguments[ i ];
            if( c == null || c === false ) continue;
            el.appendChild( typeof c === "string" ? document.createTextNode( c ) : c );
        }
        return el;
    };

    var ICONS = {
        inbox:  '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>',
        drafts: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
        sent:   '<line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>',
        spam:   '<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
        trash:  '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>',
        clip:   '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>',
        star:   '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
        file:   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
        // the clip's panel: Chat's own glyphs (chat/core.js), so it looks the same
        folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',
        image:  '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>',
        key:    '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>',
        save:   '<path d="M12 3v12"></path><polyline points="7 10 12 15 17 10"></polyline><path d="M5 21h14"></path>',
        read:   '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"></path><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"></path>',
        unread: '<rect x="2" y="4" width="20" height="16" rx="2"></rect><polyline points="22 6 12 13 2 6"></polyline>',
        tag:    '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r="1"></circle>',
        restore:'<path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>',
        forget: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="14" y2="16"></line><line x1="14" y1="11" x2="10" y2="16"></line><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>',
        select: '<polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>',
        selectAll:'<rect x="3" y="3" width="18" height="18" rx="2"></rect><polyline points="7 12 10.5 15.5 17 9"></polyline>',
        compose:'<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85z"></path>',
        reply:  '<polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>',
        replyAll:'<polyline points="7 17 2 12 7 7"></polyline><polyline points="12 17 7 12 12 7"></polyline><path d="M22 18v-2a4 4 0 0 0-4-4H7"></path>',
        forward:'<polyline points="15 17 20 12 15 7"></polyline><path d="M4 18v-2a4 4 0 0 1 4-4h12"></path>'
    };

    // Every [data-icon] button of the page gets its glyph: ours, or the shared one.
    E.fillIcons = function ( root )
    {
        ( root || document ).querySelectorAll( "[data-icon]" ).forEach( function ( el )
        {
            var n = el.getAttribute( "data-icon" );
            el.innerHTML = ICONS[ n ] ? E.icon( n ) : NayiveUI.icon( n );
        } );
    };
    E.icon = function ( name, cls )
    {
        return '<svg class="' + ( cls || "" ) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ( ICONS[ name ] || "" ) + '</svg>';
    };

    // ---------------------------------------------------------------------
    // names and dates
    // ---------------------------------------------------------------------

    E.who = function ( list )
    {
        if( ! list || ! list.length ) return "";
        return list.map( function ( a ) { return a.name || a.addr; } ).join( ", " );
    };
    E.whoFull = function ( list )
    {
        return ( list || [] ).map( function ( a ) { return a.name ? a.name + " <" + a.addr + ">" : a.addr; } ).join( ", " );
    };

    // A row's date: the time today, day + month this year, the full date before.
    E.shortDate = function ( iso )
    {
        var d = new Date( iso );
        if( isNaN( d ) ) return "";
        var now = new Date(), loc = NayiveUI.locale();
        if( d.toDateString() === now.toDateString() )
            return d.toLocaleTimeString( loc, { hour: "2-digit", minute: "2-digit" } );
        if( d.getFullYear() === now.getFullYear() )
            return d.toLocaleDateString( loc, { day: "numeric", month: "short" } );
        return d.toLocaleDateString( loc, { day: "numeric", month: "numeric", year: "2-digit" } );
    };
    E.longDate = function ( iso )
    {
        var d = new Date( iso );
        if( isNaN( d ) ) return "";
        return d.toLocaleString( NayiveUI.locale(), { weekday: "short", day: "numeric", month: "long", year: "numeric",
                                                      hour: "2-digit", minute: "2-digit" } );
    };

    E.account = function ( id ) { return E.S.accounts.filter( function ( a ) { return a.id === id; } )[ 0 ] || null; };
    E.labelById = function ( id ) { return S.labels.filter( function ( l ) { return l.id === id; } )[ 0 ] || null; };

    // A row's labels as small chips: a coloured dot and the name.
    E.chips = function ( ids )
    {
        var box = document.createDocumentFragment();
        ( ids || [] ).forEach( function ( id )
        {
            var l = E.labelById( id );
            if( ! l ) return;
            var chip = E.h( "span", { class: "tag mail-chip", text: l.name } );
            chip.style.setProperty( "--c", l.color );
            box.appendChild( chip );
        } );
        return box;
    };
} )();
