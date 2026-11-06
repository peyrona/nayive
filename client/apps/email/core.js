/*
 * core.js - the eMail app's shared basics: state, the server, icons, dates,
 * names. The other email/*.js files add to the same object:
 *
 *     core.js      this file
 *     list.js      the trays and the list of a tray (pages, search)
 *     read.js      one message (header, attachments, the body frame)
 *     accounts.js  the accounts dialog (add, remove)
 *     labels.js    Nayive's labels: the picker, the settings dialog
 *     actions.js   what can be done to messages, the pick dialog
 *     search.js    the advanced search
 *     browse.js    the shared item list on the list, the tree of trays
 *                  and labels, the one action list
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
        user:     "",      // the account signed in here (email.js)
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
        settings: { trashDays: 30, showImages: false, signature: "" },
        only:     null,       // the pick dialog's matches: the rest out of sight (null = every row)
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

    E.T  = function ( k ) { return Ayni.t( k ); };
    E.TF = function ( k, v ) { return Ayni.tf( k, v ); };
    E.$  = function ( id ) { return document.getElementById( id ); };

    // ---------------------------------------------------------------------
    // the server
    // ---------------------------------------------------------------------

    // `h` plus the page's owner (X-Nayive-User): a change made from a tab left
    // open after another account signed in gets 423, never acts on that
    // account's mail (data-safety L5).
    E.owned = function ( h )
    {
        var who = window.AyniNet && AyniNet.owner && AyniNet.owner();
        if( who ) h[ "X-Nayive-User" ] = who;
        return h;
    };

    // E.api( "GET", "a1/list?tray=inbox" ) -> the JSON answer. A failure
    // throws an Error with .status and .code ("auth", "down", "gone"...).
    // o.keepalive: it outlives a closing page (actions.js, forget).
    // No busy line for a refresh in the background (E.hush, email.js) nor a
    // call that outlives the page.
    E.hush = false;
    E.api = async function ( method, path, body, o )
    {
        var quiet = E.hush || !! ( o && o.keepalive );
        if( ! quiet ) E.busy( true );
        try { return await call( method, path, body, o ); }
        finally { if( ! quiet ) E.busy( false ); }
    };
    async function call( method, path, body, o )
    {
        var opts = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
        if( o && o.keepalive ) opts.keepalive = true;
        if( method !== "GET" ) E.owned( opts.headers );
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
            if( res.status === 401 && window.NayiveUI ) Ayni.pwa.sessionExpired();
            var err = new Error( ( data && data.error ) || ( "HTTP " + res.status ) );
            err.status = res.status;
            err.code = ( data && data.code ) || ( res.status === 401 ? "session" : "down" );
            err.text = ( data && data.text ) || "";      // a refusal: the mail server's own words
            throw err;
        }
        return data;
    }

    // THE BUSY LINE: a thin line running under the header while the mail
    // server is being asked (it is slow: IMAP). On after 300 ms - a quick
    // answer never flashes it -, off when the last call is back.
    var busyN = 0, busyTimer = 0;
    E.busy = function ( on )
    {
        busyN = Math.max( 0, busyN + ( on ? 1 : -1 ) );
        var line = E.$( "busyLine" );
        if( ! busyN ) { clearTimeout( busyTimer ); busyTimer = 0; line.hidden = true; return; }
        if( line.hidden && ! busyTimer ) busyTimer = setTimeout( function () { busyTimer = 0; if( busyN ) line.hidden = false; }, 300 );
    };

    // What to tell the user about a failed call, in their language. A
    // refusal carries the mail server's own words ("550 no such user…").
    E.errText = function ( err )
    {
        var code = err && err.code;
        var words = err && err.text ? ": " + err.text : "";
        if( code === "rejected" || code === "smtp" ) return E.T( "mail.err." + code ) + words;
        // damaged: a mail file the server never writes over; elsewhere: in no tray, its labels
        // kept; unsure / sent: a mail that may have gone, never sent twice (data-safety I3, I6)
        if( [ "auth", "gone", "dup", "bad", "hosts", "blocked", "notray", "addr", "big", "norcpt", "url", "offline",
              "toobig", "private", "key", "damaged", "elsewhere", "unsure", "sent" ].indexOf( code ) >= 0 )
            return E.T( "mail.err." + code );
        return E.T( "mail.err.down" );
    };

    // The long jobs' progress notification (Ayni.progress, in the toast
    // stack): bar( text, pct, onStop ) draws it (a Stop button only with
    // onStop), bar( null ) takes it away. pct null: no end known - the fill slides.
    var barJob = null, barStop = null;
    E.bar = function ( text, pct, onStop )
    {
        if( text == null ) { if( barJob ) barJob.end(); barJob = barStop = null; return; }
        barStop = onStop || null;
        if( barJob ) { barJob.set( text, pct ); return; }
        barJob = Ayni.progress( text, { pct: pct, onStop: onStop && function () { var f = barStop; E.bar( null ); if( f ) f(); } } );
    };

    // A job on `total` emails (E.MANY or more): the bar, which Ayni shows
    // once it has run 600 ms (a quick one never flashes it). In pieces (more
    // than E.CHUNK) step( sent ) moves it; one call for all of them leaves it
    // sliding, saying "Working… N emails" - or `text`, which always slides
    // (one call the server works through: Empty Trash). end() takes it away.
    E.MANY = 10;
    E.job = function ( total, text )
    {
        if( total < E.MANY ) return { step: function () {}, end: function () {} };
        var pieces = ! text && total > E.CHUNK, sent = 0, ended = false;
        function draw()
        {
            if( pieces ) E.bar( E.TF( "mail.workingN", { n: sent, total: total } ), sent * 100 / total );
            else E.bar( text || E.TF( "mail.workingAll", { n: total } ), null );
        }
        draw();
        return {
            step: function ( n ) { if( ended ) return; sent = n; if( pieces ) draw(); },
            end:  function () { if( ended ) return; ended = true; E.bar( null ); }
        };
    };

    // A big pick goes in pieces of CHUNK: Nayive takes up to 1000 refs +
    // mids a call (api_mail.go), but a mail server may take far fewer.
    E.CHUNK = 100;
    E.chunks = function ( list )
    {
        var out = [];
        for( var i = 0; i < list.length; i += E.CHUNK ) out.push( list.slice( i, i + E.CHUNK ) );
        return out;
    };

    // The header plug: busy while asking, green when the server answered,
    // gold when it did not. Its click re-reads (email.js).
    E.plug = function ( state )
    {
        Ayni.plug.set( "syncIndicator", state );
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

    // h( "div", { class, text, attrs, on }, child... ) - shared with Chat (shared/ui.js)
    E.h = Ayni.h;

    var ICONS = {
        inbox: "inbox",
        drafts: "edit",
        sent: "send",
        spam: "spam",
        trash: "trash",
        clip: "clip-2",
        star: "star-2",
        file: "file-2",
        folder: "folder-2",
        image: "image",
        key: "key-2",
        save: "save-2",
        read: "read",
        unread: "mail",
        tag: "tag-2",
        restore: "undo",
        forget: "forget",
        selectAll: "select-all",
        compose: "compose",
        reply: "reply",
        replyAll: "reply-all",
        forward: "forward-2",
        chevron: "chev-down"
    };

    // Every [data-icon] button of the page gets its glyph: ours, or the shared one.
    E.fillIcons = function ( root )
    {
        ( root || document ).querySelectorAll( "[data-icon]" ).forEach( function ( el )
        {
            var n = el.getAttribute( "data-icon" );
            el.innerHTML = ICONS[ n ] ? E.icon( n ) : Ayni.icon( n );
        } );
    };
    E.icon = function ( name, cls )
    {
        if( name === "nayive" ) return Ayni.icon( name, cls || "" );
        return '<svg class="' + ( cls || "" ) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-' + ( ICONS[ name ] || name ) + '"/></svg>';
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
        var now = new Date(), loc = Ayni.i18n.lang();
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
        return d.toLocaleString( Ayni.i18n.lang(), { weekday: "short", day: "numeric", month: "long", year: "numeric",
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
