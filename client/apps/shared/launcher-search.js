/*
 * launcher-search.js - the launcher's search: one field over every app.
 *
 * THE FIELD (quick): as you type, a list drops under it with up to four of
 * each - Apps (the launcher's own tiles), Contacts, Files (by name) and
 * Events. Arrow keys move, Enter opens, Esc clears. Mail and chats are not
 * asked here: mail goes to the mail server, which is slow for every key.
 *
 * THE FUNNEL inside the field opens the dialog (full): the same words, plus
 * "Search in" (Files, Mail, Contacts, Events, Chats), "From" (a mail's or a
 * chat's sender), "Date", "Type" (files) and mail's "Trays" and "With
 * attachment". Results come grouped, newest or nearest first, each group
 * with "Show more".
 *
 * WORDS, in both: words in any order, "a phrase", -word (Ayni.matcher), and
 * shortcuts that fill the dialog's choices:
 *   from:ana  in:mail (files, mail, contacts, events, chats)  type:pdf
 *   after:2026-01-31  before:2026-03-01  has:attachment
 * In the field, a shortcut makes Enter open the dialog.
 *
 * A filter one kind cannot test leaves that kind out (a date on contacts,
 * "From" on files...), so nothing shows unfiltered.
 *
 * Where each answer comes from - all read only:
 *   files     Drive's search (AyniNet.search -> /api/files?search=1)
 *   contacts, events, chats   /api/search (server/go/search_all.go)
 *   mail      eMail's tray search (/api/mail/<a>/list?tray=&q=), the same way
 *             eMail's own advanced search works: the words go to the server,
 *             From / dates / attachment / -word are checked here, row by row.
 * Every result is a real link (<a href>), so the desktop opens it as a window.
 */
( function ()
{
    "use strict";

    var KINDS   = [ 'files', 'mail', 'contacts', 'events', 'chats' ];
    var TRAYS   = [ 'inbox', 'sent', 'drafts', 'spam', 'trash' ];
    var WHEN    = [ 'any', 'today', 'd7', 'd30', 'year', 'range' ];
    var QUICK_N = 4;          // rows per group in the field's list
    var FULL_N  = 20;         // rows per group in the dialog, before "Show more"
    var KEYS    = { from: 1, 'in': 1, type: 1, after: 1, before: 1, has: 1 };

    var T  = function ( k ) { return Ayni.t( k ); };
    var TF = function ( k, v ) { return Ayni.tf( k, v ); };
    var $  = function ( id ) { return document.getElementById( id ); };

    function h( tag, cls, text )
    {
        var e = document.createElement( tag );
        if( cls ) e.className = cls;
        if( text != null ) e.textContent = text;
        return e;
    }

    // -------------------------------------------------------------------------
    // the words
    // -------------------------------------------------------------------------

    function blank()
    {
        return { words: '', kinds: KINDS.slice(), from: '', when: 'any', since: '', until: '',
                 types: [], attach: false, trays: [ 'inbox', 'sent' ] };
    }

    function isDay( s ) { return /^\d{4}-\d{2}-\d{2}$/.test( s ); }

    // parse( "factura from:ana after:2026-01-01" ) -> the shortcuts as a
    // query's fields (q, a blank() to fill), and the rest as its words.
    // Returns how many shortcuts were found.
    function parse( raw, q )
    {
        var n = 0;
        q.words = String( raw || '' ).replace( /(^|\s)([a-z]+):("[^"]*"|\S+)/gi, function ( all, sp, key, val )
        {
            key = key.toLowerCase();
            if( ! KEYS[ key ] ) return all;
            val = val.replace( /^"|"$/g, '' ).trim();
            var v = val.toLowerCase();
            switch( key )
            {
                case 'from':   q.from = val; break;
                case 'in':
                    var kinds = v.split( ',' ).filter( function ( k ) { return KINDS.indexOf( k ) >= 0; } );
                    if( ! kinds.length ) return all;
                    q.kinds = ( n && q.kindsSet ? q.kinds : [] ).concat( kinds );
                    q.kindsSet = true;
                    break;
                case 'type':
                    var ids = NayiveKinds.kinds().map( function ( k ) { return k.id; } );
                    var t = v === 'folder' ? 'dir' : v;
                    if( ids.indexOf( t ) < 0 ) return all;
                    if( q.types.indexOf( t ) < 0 ) q.types.push( t );
                    break;
                case 'after':  if( ! isDay( v ) ) return all; q.when = 'range'; q.since = v; break;
                // the range's "To" day is in: "before" a day ends the day before it
                case 'before': if( ! isDay( v ) ) return all; q.when = 'range'; q.until = dayIso( v, -1 ); break;
                case 'has':    if( v !== 'attachment' ) return all; q.attach = true; break;
            }
            n++;
            return sp;
        } ).replace( /\s+/g, ' ' ).trim();
        delete q.kindsSet;
        return n;
    }

    // The date window as unix seconds: the user's own midnights. `until` is
    // exclusive: the range's "To" day is in.
    function dayDate( iso, plus )
    {
        var p = iso.split( '-' );
        return new Date( +p[ 0 ], p[ 1 ] - 1, +p[ 2 ] + ( plus || 0 ) );
    }
    function dayAt( iso, plus ) { return Math.floor( dayDate( iso, plus ).getTime() / 1000 ); }
    function dayIso( iso, plus )
    {
        var d = dayDate( iso, plus ), pad = function ( n ) { return ( n < 10 ? '0' : '' ) + n; };
        return d.getFullYear() + '-' + pad( d.getMonth() + 1 ) + '-' + pad( d.getDate() );
    }
    function windowOf( q )
    {
        var today = new Date(); today.setHours( 0, 0, 0, 0 );
        var back = function ( n ) { var x = new Date( today ); x.setDate( x.getDate() - n ); return Math.floor( x / 1000 ); };
        switch( q.when )
        {
            case 'today': return { since: back( 0 ) };
            case 'd7':    return { since: back( 6 ) };
            case 'd30':   return { since: back( 29 ) };
            case 'year':  return { since: Math.floor( new Date( today.getFullYear(), 0, 1 ) / 1000 ) };
            case 'range': return { since: q.since ? dayAt( q.since ) : 0, until: q.until ? dayAt( q.until, 1 ) : 0 };
        }
        return {};
    }

    // What a query asks of each kind: null when that kind is not searched
    // (switched off, or a filter it cannot test, or nothing to look for).
    function plan( q )
    {
        var m = Ayni.matcher( q.words );
        var rules = m ? m.terms.map( function ( t ) { return { op: 'has', text: t }; } )
                          .concat( m.not.map( function ( t ) { return { op: 'not', text: t }; } ) ) : [];
        var w = windowOf( q ), dated = !! ( w.since || w.until ), from = q.from.trim();
        var on = function ( k ) { return q.kinds.indexOf( k ) >= 0; };
        var p = { rules: rules, m: m, w: w, from: from };
        var words = !! ( m && m.terms.length );
        p.files    = on( 'files' )    && ! from && ! q.attach && ( words || q.types.length || dated );
        p.mail     = on( 'mail' )     && ! q.types.length && ( words || from || q.attach || dated );
        p.contacts = on( 'contacts' ) && ! from && ! dated && ! q.types.length && ! q.attach && words;
        p.events   = on( 'events' )   && ! from && ! q.types.length && ! q.attach && ( words || dated );
        p.chats    = on( 'chats' )    && ! q.types.length && ! q.attach && ( words || from || dated );
        return p;
    }

    // -------------------------------------------------------------------------
    // asking
    // -------------------------------------------------------------------------

    var netLoad = null;
    function needNet()
    {
        if( window.AyniNet ) return Promise.resolve();
        return netLoad || ( netLoad = new Promise( function ( ok, ko )
        {
            var sc = document.createElement( 'script' );
            sc.src = 'shared/ayni/ayni-net.js';
            sc.onload = ok;
            sc.onerror = function () { netLoad = null; ko( new Error( 'net' ) ); };
            document.head.appendChild( sc );
        } ) );
    }

    async function getJSON( url )
    {
        var r = await fetch( url, { credentials: 'same-origin' } );
        if( ! r.ok ) throw new Error( r.status );
        return r.json();
    }

    async function askFiles( p, q, limit )
    {
        await needNet();
        var spec = { rules: p.rules };
        if( q.types.length )
        {
            spec.folders = q.types.indexOf( 'dir' ) >= 0;
            spec.exts = [];
            NayiveKinds.kinds().forEach( function ( k ) { if( k.exts && q.types.indexOf( k.id ) >= 0 ) spec.exts = spec.exts.concat( k.exts ); } );
        }
        if( p.w.since ) spec.since = p.w.since;
        if( p.w.until ) spec.until = p.w.until;
        var r = await AyniNet.search( spec, false );
        // what Drive leaves out of its own answers too (drive/state.js pruneNodes):
        // dot-files and the apps' data/ folder
        var nodes = ( r.nodes || [] ).filter( function ( n )
        {
            return baseName( n.path ).charAt( 0 ) !== '.' && n.path !== 'data' && n.path.indexOf( 'data/' ) !== 0;
        } ).sort( function ( a, b ) { return ( b.mtime || 0 ) - ( a.mtime || 0 ); } );
        return { items: nodes.slice( 0, limit ), more: nodes.length > limit || !! r.truncated };
    }

    async function askServer( p, kinds, limit )
    {
        var u = new URLSearchParams( { 'in': kinds.join( ',' ), limit: String( limit + 1 ) } );
        p.rules.forEach( function ( r ) { u.append( 'name', r.op + ':' + r.text ); } );
        if( p.from ) u.set( 'from', p.from );
        if( p.w.since ) u.set( 'since', String( p.w.since ) );
        if( p.w.until ) u.set( 'until', String( p.w.until ) );
        try { u.set( 'tz', Intl.DateTimeFormat().resolvedOptions().timeZone ); } catch( e ) {}
        var r = await getJSON( '/api/search?' + u );
        var out = {};
        kinds.forEach( function ( k )
        {
            var list = r[ k ] || [];
            out[ k ] = { items: list.slice( 0, limit ), more: list.length > limit || !! ( r.more && r.more[ k ] ) };
        } );
        return out;
    }

    var mailAccts = null;      // the accounts, asked once; false: none can be (the admin)
    function phrase( t ) { return /\s/.test( t ) ? '"' + t + '"' : t; }
    // The words a mail server can search: no -word (IMAP has no NOT in TEXT).
    function mailWords( p ) { return p.m ? p.m.terms.map( phrase ).join( ' ' ) : ''; }
    async function askMail( p, q, limit )
    {
        if( ! mailAccts )
        {
            var acc = await fetch( '/api/mail/accounts', { credentials: 'same-origin' } );
            if( acc.status === 403 ) mailAccts = false;           // the admin: mail is per user
            else if( ! acc.ok ) throw new Error( acc.status );
            else mailAccts = ( await acc.json() ).accounts || [];
        }
        if( mailAccts === false ) return { items: [], more: false, failed: [], accounts: -1 };
        // the words the server is asked: the box's, and the sender's (eMail's search.js does the same)
        var words = [ mailWords( p ) ];
        if( p.from ) words.push( phrase( p.from ) );
        var trays = q.trays.length ? q.trays : [ 'inbox' ];
        var asks = [], failed = [], next = false;
        mailAccts.forEach( function ( a )
        {
            trays.forEach( function ( tray )
            {
                var u = encodeURIComponent( a.id ) + '/list?' + new URLSearchParams( { tray: tray, q: words.join( ' ' ).trim() } );
                asks.push( getJSON( '/api/mail/' + u ).then( function ( r )
                {
                    if( r.next ) next = true;        // that tray has more: only its newest page is looked at
                    return ( r.items || [] ).map( function ( m ) { m.acct = a.id; m.acctName = a.email; m.tray = tray; return m; } );
                }, function () { failed.push( a.email ); return []; } ) );
            } );
        } );
        var all = [].concat.apply( [], await Promise.all( asks ) );
        var from = Ayni.fold( p.from ), not = p.m ? p.m.not.map( Ayni.fold ) : [];
        var since = ( p.w.since || 0 ) * 1000, until = ( p.w.until || 0 ) * 1000;
        var seen = {};
        var items = all.filter( function ( m )
        {
            var t = new Date( m.date ).getTime();
            if( since && ! ( t >= since ) ) return false;
            if( until && ! ( t < until ) ) return false;
            if( q.attach && ! m.attach ) return false;
            var who = ( m.from || [] ).map( function ( x ) { return ( x.name || '' ) + ' ' + ( x.addr || '' ); } ).join( ' ' );
            if( from && Ayni.fold( who ).indexOf( from ) < 0 ) return false;
            var text = Ayni.fold( who + ' ' + ( m.subject || '' ) + ' ' + ( m.snippet || '' ) );
            if( not.some( function ( n ) { return text.indexOf( n ) >= 0; } ) ) return false;
            var key = m.acct + '|' + ( m.mid || m.ref );          // one mail in two trays (to myself): once
            if( seen[ key ] ) return false;
            return ( seen[ key ] = true );
        } ).sort( function ( a, b ) { return new Date( b.date ) - new Date( a.date ); } );
        return { items: items.slice( 0, limit ), more: items.length > limit || next, failed: failed, accounts: mailAccts.length };
    }

    // -------------------------------------------------------------------------
    // rows
    // -------------------------------------------------------------------------

    function fmtDay( d ) { return d.toLocaleDateString( Ayni.i18n.lang(), { day: 'numeric', month: 'short', year: 'numeric' } ); }
    function fmtTime( d ) { return d.toLocaleTimeString( Ayni.i18n.lang(), { hour: '2-digit', minute: '2-digit' } ); }
    function baseName( p ) { return p.split( '/' ).pop(); }
    function dirOf( p ) { var i = p.lastIndexOf( '/' ); return i < 0 ? '' : p.slice( 0, i ); }
    function extOf( p ) { var b = baseName( p ), i = b.lastIndexOf( '.' ); return i <= 0 ? '' : b.slice( i + 1 ).toLowerCase(); }

    // A file found: Write / Calc / Text open their own kinds at once, as a
    // double-click in Drive does; anything else is shown in its folder in
    // Drive (?open=), whose own opener takes it from there.
    function fileHref( n )
    {
        var isDir = !! n.nodes, ext = extOf( n.path ), K = NayiveKinds, f = encodeURIComponent( n.path );
        if( ! isDir && K.WRITE_IMPORT.indexOf( ext ) >= 0 ) return 'write/index.html?file=' + f;
        if( ! isDir && K.CALC_IMPORT.indexOf( ext ) >= 0 )  return 'calc/index.html?file=' + f;
        if( ! isDir && K.TEXT_IMPORT.indexOf( ext ) >= 0 )  return 'text/index.html?file=' + f;
        return 'drive/index.html?open=' + f;
    }

    function fileIcon( n )
    {
        if( n.nodes ) return 'folder';
        var ext = extOf( n.path ), K = NayiveKinds;
        if( ext === 'pdf' ) return 'pdf';
        if( K.IMAGE_VIEW.indexOf( ext ) >= 0 ) return 'image';
        if( K.VIDEO_VIEW.indexOf( ext ) >= 0 || K.CONVERT_EXT.indexOf( ext ) >= 0 ) return 'video';
        if( K.AUDIO_VIEW.indexOf( ext ) >= 0 ) return 'music';
        if( K.ARCHIVE_EXT.indexOf( ext ) >= 0 ) return 'zip';
        if( K.TEXT_IMPORT.indexOf( ext ) >= 0 ) return 'code';
        return 'file';
    }

    // The folder a path lives in, as the person sees it: "files/" is Home.
    function where( p )
    {
        var d = dirOf( p );
        if( d === 'files' ) return T( 'ui.filesRoot' );
        return d.replace( /^files\//, '' );
    }

    var ROW = {
        apps: function ( a ) { return { href: a.href, icon: null, svg: a.svg, title: a.name, sub: T( 'search.app' ) }; },
        files: function ( n )
        {
            var sub = where( n.path );
            if( n.mtime ) sub += ( sub ? ' · ' : '' ) + fmtDay( new Date( n.mtime * 1000 ) );
            return { href: fileHref( n ), icon: fileIcon( n ), title: baseName( n.path ), sub: sub };
        },
        contacts: function ( c )
        {
            return { href: 'contact/index.html?uid=' + encodeURIComponent( c.uid ), icon: 'user', title: c.name,
                     sub: [ c.email, c.tel, c.org ].filter( Boolean ).join( ' · ' ) };
        },
        events: function ( e )
        {
            var d = e.at ? new Date( e.at * 1000 ) : new Date( e.day + 'T00:00:00' );
            var when = fmtDay( d ) + ( e.at ? ' ' + fmtTime( d ) : ' · ' + T( 'search.allDay' ) );
            return { href: 'planner/index.html?date=' + e.day, icon: 'calendar', title: e.title || T( 'search.noTitle' ),
                     sub: [ when, e.where, e.rep ? T( 'search.repeats' ) : '' ].filter( Boolean ).join( ' · ' ) };
        },
        chats: function ( c )
        {
            var d = new Date( c.at );
            return { href: 'chat/index.html?c=' + encodeURIComponent( c.conv ), icon: 'chat',
                     title: c.text, sub: [ c.from === c.name ? c.name : c.from + ' → ' + c.name, fmtDay( d ) + ' ' + fmtTime( d ) ].join( ' · ' ) };
        },
        mail: function ( m )
        {
            var who = ( m.from || [] ).map( function ( a ) { return a.name || a.addr; } ).join( ', ' );
            var u = new URLSearchParams( { a: m.acct, t: m.tray, m: m.ref, mid: m.mid || '', s: m.subject || '' } );
            if( m.q ) u.set( 'q', m.q );
            var sub = [ who, fmtDay( new Date( m.date ) ), T( 'mail.tray.' + m.tray ) ];
            if( mailAccts && mailAccts.length > 1 ) sub.push( m.acctName );
            return { href: 'email/index.html?' + u, icon: 'mail', title: m.subject || T( 'search.noSubject' ),
                     sub: sub.filter( Boolean ).join( ' · ' ), clip: m.attach };
        }
    };

    function rowEl( r )
    {
        var a = h( 'a', 'ls-row' );
        a.href = r.href;
        a.setAttribute( 'role', 'option' );
        a.tabIndex = -1;
        var ic = h( 'span', 'ls-ic' );
        ic.innerHTML = r.svg || Ayni.icon( r.icon );
        var txt = h( 'span', 'ls-txt' );
        txt.appendChild( h( 'span', 'ls-title', r.title ) );
        if( r.sub ) txt.appendChild( h( 'span', 'ls-sub', r.sub ) );
        a.appendChild( ic );
        a.appendChild( txt );
        if( r.clip ) { var c = h( 'span', 'ls-clip' ); c.innerHTML = Ayni.icon( 'clip' ); a.appendChild( c ); }
        return a;
    }

    function groupEl( kind, count )
    {
        var g = h( 'div', 'ls-group' );
        g.dataset.kind = kind;
        var head = h( 'div', 'ls-head' );
        head.appendChild( h( 'span', null, T( 'search.kind.' + kind ) ) );
        if( count != null ) head.appendChild( h( 'span', 'ls-count', count ) );
        g.appendChild( head );
        return g;
    }

    // -------------------------------------------------------------------------
    // keys over a list of rows (the field's list, the dialog's results)
    // -------------------------------------------------------------------------

    function rowsIn( box ) { return Array.prototype.slice.call( box.querySelectorAll( '.ls-row' ) ); }

    function moveActive( box, d )
    {
        var rows = rowsIn( box );
        if( ! rows.length ) return;
        var i = rows.findIndex( function ( r ) { return r.classList.contains( 'active' ); } );
        if( i >= 0 ) rows[ i ].classList.remove( 'active' );
        i = i < 0 ? ( d > 0 ? 0 : rows.length - 1 ) : ( i + d + rows.length ) % rows.length;
        rows[ i ].classList.add( 'active' );
        rows[ i ].scrollIntoView( { block: 'nearest' } );
    }

    function activeRow( box ) { return box.querySelector( '.ls-row.active' ) || box.querySelector( '.ls-row' ); }

    // -------------------------------------------------------------------------
    // the field (quick)
    // -------------------------------------------------------------------------

    var input, quick, fieldCtl, quickSeq = 0, quickTimer = null, apps = null;

    // The launcher's own tiles: the grid's and its groups' (Office, Records, Tools).
    function appList()
    {
        if( apps ) return apps;
        apps = [];
        document.querySelectorAll( '.apps-panel a.btn.large[href]' ).forEach( function ( a )
        {
            var name = ( a.querySelector( 'span:not(.icon)' ) || a ).textContent.trim();
            var svg = a.querySelector( 'svg' );
            if( name && ! a.closest( '[hidden]' ) ) apps.push( { name: name, href: a.getAttribute( 'href' ), svg: svg ? svg.outerHTML : '' } );
        } );
        return apps;
    }

    function hideQuick()
    {
        quick.hidden = true;
        quick.textContent = '';
        input.setAttribute( 'aria-expanded', 'false' );
        ++quickSeq;
    }

    function quickChanged()
    {
        clearTimeout( quickTimer );
        var raw = input.value.trim();
        if( ! raw ) { hideQuick(); return; }
        quickTimer = setTimeout( runQuick, 180 );
    }

    async function runQuick()
    {
        var seq = ++quickSeq, raw = input.value.trim();
        var q = blank();
        var shortcuts = parse( raw, q );
        var p = plan( q );
        var groups = {};

        var m = Ayni.matcher( q.words );
        if( m && ! shortcuts ) groups.apps = { items: appList().filter( function ( a ) { return m( a.name ); } ).slice( 0, QUICK_N ) };

        // two letters at least before asking the server: one finds half the disk
        var enough = q.words.replace( /[\s"-]/g, '' ).length >= 2;
        if( ! shortcuts && enough )
        {
            var asks = [];
            var server = [ 'contacts', 'events' ].filter( function ( k ) { return p[ k ]; } );
            if( server.length ) asks.push( askServer( p, server, QUICK_N ).then( function ( r ) { Object.assign( groups, r ); }, function () {} ) );
            if( p.files ) asks.push( askFiles( p, q, QUICK_N ).then( function ( r ) { groups.files = r; }, function () {} ) );
            showQuick( groups, false, seq );            // the apps at once; the rest as it comes
            await Promise.all( asks );
        }
        if( seq !== quickSeq ) return;
        showQuick( groups, shortcuts > 0, seq );
    }

    function showQuick( groups, shortcuts, seq )
    {
        if( seq !== quickSeq ) return;
        var keep = quick.querySelector( '.ls-row.active' ), keepHref = keep && keep.getAttribute( 'href' );
        quick.textContent = '';
        var any = false;
        [ 'apps', 'contacts', 'files', 'events' ].forEach( function ( k )
        {
            var r = groups[ k ];
            if( ! r || ! r.items.length ) return;
            any = true;
            var g = groupEl( k );
            r.items.slice( 0, QUICK_N ).forEach( function ( it ) { g.appendChild( rowEl( ROW[ k ]( it ) ) ); } );
            quick.appendChild( g );
        } );
        if( shortcuts ) quick.appendChild( h( 'p', 'ls-note', T( 'search.enterOptions' ) ) );
        else if( ! any ) quick.appendChild( h( 'p', 'ls-note', T( 'search.noneQuick' ) ) );
        // the first row is the one Enter opens, unless the arrows picked another
        var rows = rowsIn( quick );
        var again = keepHref && rows.find( function ( r ) { return r.getAttribute( 'href' ) === keepHref; } );
        if( again || rows[ 0 ] ) ( again || rows[ 0 ] ).classList.add( 'active' );
        quick.hidden = false;
        input.setAttribute( 'aria-expanded', 'true' );
    }

    function onFieldKey( e )
    {
        if( e.isComposing ) return;
        if( e.key === 'ArrowDown' || e.key === 'ArrowUp' )
        {
            if( quick.hidden ) return;
            e.preventDefault();
            moveActive( quick, e.key === 'ArrowDown' ? 1 : -1 );
        }
        else if( e.key === 'Enter' )
        {
            e.preventDefault();
            var raw = input.value.trim();
            if( ! raw ) return;
            if( parse( raw, blank() ) ) { openDialog(); return; }
            var row = activeRow( quick );
            if( row ) row.click();
        }
    }

    // -------------------------------------------------------------------------
    // the dialog (full)
    // -------------------------------------------------------------------------

    var dlg, draft = null, fullSeq = 0, fullTimer = null, limits = {};

    function pills( host, ids, label, on, pick )
    {
        host.textContent = '';
        ids.forEach( function ( id )
        {
            var b = h( 'button', 'btn text sm bordered', label( id ) );
            b.type = 'button';
            b.setAttribute( 'aria-pressed', on( id ) ? 'true' : 'false' );
            b.addEventListener( 'click', function () { readFields(); pick( id ); render(); changed( true ); } );
            host.appendChild( b );
        } );
    }

    function toggleIn( list, id ) { var i = list.indexOf( id ); if( i >= 0 ) list.splice( i, 1 ); else list.push( id ); }

    function render()
    {
        var d = draft;
        // a kind switched off takes its own choices with it: nothing is left
        // filtering out every other kind unseen
        if( d.kinds.indexOf( 'files' ) < 0 ) d.types = [];
        if( d.kinds.indexOf( 'mail' ) < 0 ) d.attach = false;
        pills( $( 'lsKinds' ), KINDS, function ( k ) { return T( 'search.kind.' + k ); },
               function ( k ) { return d.kinds.indexOf( k ) >= 0; },
               function ( k ) { toggleIn( d.kinds, k ); if( ! d.kinds.length ) d.kinds = KINDS.slice(); } );
        pills( $( 'lsWhen' ), WHEN, function ( k ) { return T( 'drive.when.' + k ); },
               function ( k ) { return d.when === k; }, function ( k ) { d.when = k; } );
        $( 'lsRange' ).hidden = d.when !== 'range';
        $( 'lsSince' ).value = d.since;
        $( 'lsUntil' ).value = d.until;
        var types = NayiveKinds.kinds().map( function ( k ) { return k.id; } );
        pills( $( 'lsTypes' ), types, function ( k ) { return T( 'drive.kind.' + k ); },
               function ( k ) { return d.types.indexOf( k ) >= 0; }, function ( k ) { toggleIn( d.types, k ); } );
        pills( $( 'lsTrays' ), TRAYS, function ( k ) { return T( 'mail.tray.' + k ); },
               function ( k ) { return d.trays.indexOf( k ) >= 0; },
               function ( k ) { toggleIn( d.trays, k ); if( ! d.trays.length ) d.trays = [ 'inbox' ]; } );
        $( 'lsAttach' ).checked = d.attach;
        $( 'lsFrom' ).value = d.from;
        // the choices for one kind only show while that kind is searched
        $( 'lsTypesRow' ).hidden = d.kinds.indexOf( 'files' ) < 0;
        $( 'lsMailRow' ).hidden = d.kinds.indexOf( 'mail' ) < 0;
        var n = ( d.kinds.length < KINDS.length ? 1 : 0 ) + ( d.from ? 1 : 0 ) + ( d.when !== 'any' ? 1 : 0 )
              + ( d.types.length ? 1 : 0 ) + ( d.attach ? 1 : 0 );
        $( 'lsReset' ).hidden = ! n;
    }

    // Opens with what the field holds: its shortcuts become the choices.
    function openDialog()
    {
        draft = blank();
        parse( input.value, draft );
        hideQuick();
        limits = {};
        render();
        $( 'lsWords' ).value = draft.words;
        dlg.showModal();
        $( 'lsWords' ).focus();
        changed( false );
    }

    function readFields()
    {
        draft.words = $( 'lsWords' ).value.trim();
        draft.from = $( 'lsFrom' ).value.trim();
        draft.since = $( 'lsSince' ).value.trim();
        draft.until = $( 'lsUntil' ).value.trim();
        draft.attach = $( 'lsAttach' ).checked;
        // shortcuts typed in the dialog's own field go to the choices too
        var more = blank();
        more.kinds = draft.kinds; more.types = draft.types; more.trays = draft.trays;
        if( parse( draft.words, more ) )
        {
            draft.words = more.words;
            [ 'kinds', 'from', 'when', 'since', 'until', 'types', 'attach' ].forEach( function ( k ) { draft[ k ] = more[ k ]; } );
            $( 'lsWords' ).value = draft.words;
            render();
        }
    }

    function changed( now )
    {
        clearTimeout( fullTimer );
        fullTimer = setTimeout( runFull, now ? 0 : 350 );
    }

    async function runFull()
    {
        if( ! dlg.open ) return;
        readFields();
        var seq = ++fullSeq, q = draft, p = plan( q ), box = $( 'lsResults' );
        var kinds = KINDS.filter( function ( k ) { return p[ k ]; } );
        box.textContent = '';
        if( ! kinds.length )
        {
            box.appendChild( h( 'p', 'ls-note', T( q.kinds.length ? 'search.typeSomething' : 'search.noKind' ) ) );
            return;
        }
        // a group per kind, in this order, each filled as its answer comes
        var order = [ 'contacts', 'events', 'files', 'mail', 'chats' ].filter( function ( k ) { return p[ k ]; } );
        var slots = {};
        order.forEach( function ( k )
        {
            var g = groupEl( k, '…' );
            g.appendChild( h( 'p', 'ls-note', T( 'search.searching' ) ) );
            box.appendChild( g );
            slots[ k ] = g;
        } );
        var limit = function ( k ) { return limits[ k ] || FULL_N; };
        var pending = order.length;
        // a group that found nothing goes; when none found anything, one line says so
        var done = function ()
        {
            if( --pending || box.querySelector( '.ls-group' ) ) return;
            box.appendChild( h( 'p', 'ls-note', T( 'search.none' ) ) );
        };
        var fill = function ( k, r )
        {
            if( seq !== fullSeq ) return;
            var g = slots[ k ], fresh = groupEl( k, r.items.length + ( r.more ? '+' : '' ) );
            var noAcct = k === 'mail' && r.accounts === 0, bad = r.failed && r.failed.length;
            if( ! r.items.length && ! noAcct && ! bad ) { g.remove(); delete slots[ k ]; done(); return; }
            if( noAcct ) fresh.appendChild( h( 'p', 'ls-note', T( 'search.noMailAcct' ) ) );
            r.items.forEach( function ( it ) { if( k === 'mail' ) it.q = mailWords( p ); fresh.appendChild( rowEl( ROW[ k ]( it ) ) ); } );
            if( r.failed && r.failed.length ) fresh.appendChild( h( 'p', 'ls-note ls-bad', TF( 'search.mailFailed', { acct: r.failed.join( ', ' ) } ) ) );
            if( r.more )
            {
                var more = h( 'button', 'btn text sm', T( 'search.showMore' ) );
                more.type = 'button';
                more.addEventListener( 'click', function () { limits[ k ] = limit( k ) + FULL_N * 2; changed( true ); } );
                fresh.appendChild( more );
            }
            g.replaceWith( fresh );
            slots[ k ] = fresh;
            done();
        };
        var fail = function ( k ) { return function () { fill( k, { items: [], more: false, failed: [ T( 'search.failed' ) ] } ); }; };
        var server = [ 'contacts', 'events', 'chats' ].filter( function ( k ) { return p[ k ]; } );
        if( server.length )
        {
            // one call for the three; "Show more" on one asks again with its new size for all
            var lim = Math.max.apply( null, server.map( limit ) );
            askServer( p, server, lim ).then( function ( r ) { server.forEach( function ( k ) { fill( k, cut( r[ k ], limit( k ) ) ); } ); },
                                              function () { server.forEach( function ( k ) { fail( k )(); } ); } );
        }
        if( p.files ) askFiles( p, q, limit( 'files' ) ).then( function ( r ) { fill( 'files', r ); }, fail( 'files' ) );
        if( p.mail ) askMail( p, q, limit( 'mail' ) ).then( function ( r ) { fill( 'mail', r ); }, fail( 'mail' ) );
    }

    function cut( r, n ) { return r.items.length > n ? { items: r.items.slice( 0, n ), more: true } : r; }

    function resetChoices()
    {
        var words = $( 'lsWords' ).value;
        draft = blank();
        draft.words = words;
        limits = {};
        render();
        changed( true );
    }

    // -------------------------------------------------------------------------
    // start
    // -------------------------------------------------------------------------

    function start()
    {
        input = $( 'lsInput' );
        quick = $( 'lsQuick' );
        dlg   = $( 'lsDialog' );
        if( ! input || ! quick || ! dlg || ! window.NayiveKinds ) return;

        fieldCtl = Ayni.searchField( $( 'lsField' ), { filter: openDialog, filterTip: T( 'search.options' ), onClose: hideQuick } );
        fieldCtl.filtered( 0 );           // the funnel's tooltip from the start
        input.addEventListener( 'input', quickChanged );
        input.addEventListener( 'keydown', onFieldKey );
        input.addEventListener( 'focus', function () { if( input.value.trim() && quick.hidden ) runQuick(); } );
        // a press outside the field and its list closes the list
        document.addEventListener( 'pointerdown', function ( e )
        {
            if( ! quick.hidden && ! e.target.closest( '#lsBox' ) ) hideQuick();
        } );
        quick.addEventListener( 'mousedown', function ( e ) { e.preventDefault(); } );   // the cursor stays in the field
        // A result picked: the list (or the dialog) goes. On the window, in the
        // capture phase: the desktop's menu stops link clicks on the document.
        window.addEventListener( 'click', function ( e )
        {
            var row = e.target.closest && e.target.closest( '.ls-row' );
            if( ! row ) return;
            if( quick.contains( row ) ) setTimeout( hideQuick, 0 );     // after the click: a link taken out of the page goes nowhere
            else if( dlg.contains( row ) ) dlg.close();
        }, true );

        $( 'lsWords' ).addEventListener( 'input', function () { changed( false ); } );
        $( 'lsFrom' ).addEventListener( 'input', function () { changed( false ); } );
        $( 'lsAttach' ).addEventListener( 'change', function () { readFields(); render(); changed( true ); } );
        Ayni.dateField( $( 'lsSince' ), { onChange: function () { changed( true ); } } );
        Ayni.dateField( $( 'lsUntil' ), { onChange: function () { changed( true ); } } );
        $( 'lsReset' ).addEventListener( 'click', resetChoices );
        [ 'lsWords', 'lsFrom' ].forEach( function ( id )
        {
            $( id ).addEventListener( 'keydown', function ( e )
            {
                var box = $( 'lsResults' );
                if( e.isComposing ) return;
                if( e.key === 'ArrowDown' || e.key === 'ArrowUp' ) { e.preventDefault(); moveActive( box, e.key === 'ArrowDown' ? 1 : -1 ); }
                else if( e.key === 'Enter' )
                {
                    e.preventDefault();
                    var row = box.querySelector( '.ls-row.active' );
                    if( row ) row.click(); else changed( true );
                }
            } );
        } );
        // what was typed in the dialog comes back to the field
        dlg.addEventListener( 'close', function ()
        {
            ++fullSeq;
            if( draft ) input.value = $( 'lsWords' ).value;
        } );
        // the desktop shuts its menu: the list goes too
        document.addEventListener( 'visibilitychange', function () { if( document.hidden ) hideQuick(); } );
    }

    Ayni.i18n.ready.then( function () { if( document.readyState === 'loading' ) document.addEventListener( 'DOMContentLoaded', start ); else start(); } );

    // close(): the desktop shut its menu (the launcher's closePopups)
    window.NayiveSearch = { parse: parse, plan: plan, blank: blank, close: function () { if( quick ) hideQuick(); } };
} )();
