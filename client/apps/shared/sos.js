/* SOS (2026-11-12, server/go/sos.go) - for someone who lives alone.

   - The red SOS button, first in the launcher's top row, shown once there is at
     least one SOS contact. Pressed: a 5-second red screen (Cancel / Send now),
     then the contacts are told, with this device's position if it gives one.
   - "SOS" in My account's header opens the settings: contacts (other Nayive
     users), "phone silent" and "not used" hours, quiet hours, a Test button.
     Close-only: every change saves itself.
   - ?sos=<id>   a contact tapped the alert: who, when, the last position.
   - ?sosok=1    the user tapped "Are you OK?": answered.
   Opening the launcher at all tells the server "alive" (GET /api/sos). */
( function ()
{
    'use strict';

    var COUNT = 5;   // seconds before an SOS goes
    var T  = function ( k ) { return Ayni.t( k ); };
    var TF = function ( k, o ) { return Ayni.tf( k, o ); };
    var $  = function ( id ) { return document.getElementById( id ); };
    var settings = null;

    function api( method, path, body )
    {
        var o = { method: method, credentials: 'same-origin', headers: {} };
        if( body !== undefined ) { o.headers[ 'Content-Type' ] = 'application/json'; o.body = JSON.stringify( body ); }
        return fetch( '/api/sos' + path, o ).then( function ( r )
        {
            return r.json().catch( function () { return {}; } ).then( function ( j ) { j._status = r.status; return j; } );
        } );
    }

    function el( tag, cls, text )
    {
        var e = document.createElement( tag );
        if( cls )  e.className = cls;
        if( text ) e.textContent = text;
        return e;
    }

    function when( sec )
    {
        return new Date( sec * 1000 ).toLocaleString( undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } );
    }

    // ---- the button --------------------------------------------------------

    function showButton()
    {
        var box = $( 'lsBox' ), b = $( 'sosBtn' );
        if( ! box ) return;
        var on = !! ( settings && settings.contacts && settings.contacts.length );
        if( ! b && on )
        {
            b = el( 'button', 'btn sos-btn', 'SOS' );
            b.id = 'sosBtn';
            b.type = 'button';
            b.setAttribute( 'aria-label', T( 'sos.press' ) );
            b.setAttribute( 'data-tip', T( 'sos.press' ) );
            b.addEventListener( 'click', countdown );
            box.insertBefore( b, box.firstChild );
        }
        if( b ) b.hidden = ! on;
    }

    // ---- the red screen ----------------------------------------------------

    function countdown()
    {
        var left = COUNT, pos = null, timer, done = false;
        var o = el( 'div', 'sos-screen' );
        o.setAttribute( 'role', 'alertdialog' );
        o.setAttribute( 'aria-modal', 'true' );
        var h = el( 'h2', '', T( 'sos.sending' ) );
        var n = el( 'div', 'sos-count', String( left ) );
        var msg = el( 'p', 'sos-msg', T( 'sos.sendingHint' ) );
        var acts = el( 'div', 'sos-acts' );
        var cancel = el( 'button', 'btn sos-cancel', T( 'sos.cancel' ) );
        var now = el( 'button', 'btn sos-now', T( 'sos.sendNow' ) );
        cancel.type = now.type = 'button';
        acts.append( cancel, now );
        o.append( h, n, msg, acts );
        document.body.appendChild( o );
        cancel.focus();

        if( navigator.geolocation )
        {
            navigator.geolocation.getCurrentPosition( function ( p ) { pos = p.coords; }, function () {},
                { enableHighAccuracy: true, timeout: COUNT * 1000, maximumAge: 120000 } );
        }

        function close() { clearInterval( timer ); done = true; o.remove(); }
        cancel.addEventListener( 'click', close );
        o.addEventListener( 'keydown', function ( e ) { if( e.key === 'Escape' && ! done ) close(); } );
        now.addEventListener( 'click', send );
        timer = setInterval( function ()
        {
            left--;
            n.textContent = String( Math.max( left, 0 ) );
            if( left <= 0 ) send();
        }, 1000 );

        function send()
        {
            if( done ) return;
            done = true;
            clearInterval( timer );
            h.textContent = T( 'sos.sendingNow' );
            n.remove();
            acts.replaceChildren();
            var body = pos ? { lat: pos.latitude, lon: pos.longitude, acc: pos.accuracy } : {};
            api( 'POST', '/send', body ).then( function ( j ) { result( j, o, h, msg, acts, false ); },
                function () { result( { _status: 0 }, o, h, msg, acts, false ); } );
        }
    }

    // What the server did - never "sent" unless a device took it.
    function result( j, o, h, msg, acts, test )
    {
        var ok = j._status === 200 && ( j.to || [] ).some( function ( t ) { return t.sent > 0; } );
        h.textContent = j._status !== 200 ? T( 'sos.failed' ) : ok ? T( test ? 'sos.testSent' : 'sos.sent' ) : T( 'sos.noneReached' );
        msg.replaceChildren();
        ( j.to || [] ).forEach( function ( t )
        {
            msg.appendChild( el( 'div', 'sos-to', ( t.sent > 0 ? '✓ ' : '✗ ' ) + t.user + ' - ' +
                ( t.sent > 0 ? TF( 'sos.devices', { n: t.sent } ) : T( 'sos.notReached' ) ) ) );
        } );
        if( j._status !== 200 ) msg.textContent = T( 'sos.failedHint' );
        else if( ! ok ) msg.appendChild( el( 'p', '', T( 'sos.callHint' ) ) );
        var close = el( 'button', 'btn sos-cancel', T( 'sos.close' ) );
        close.type = 'button';
        close.addEventListener( 'click', function () { o.remove(); } );
        acts.replaceChildren( close );
        close.focus();
    }

    // ---- settings ----------------------------------------------------------

    function addSettingsButton()
    {
        var head = document.querySelector( '#pwBackdrop > header' ), close = $( 'acctClose' );
        if( ! head || ! close || $( 'sosSetBtn' ) ) return;
        var b = el( 'button', 'btn sos-set', 'SOS' );
        b.id = 'sosSetBtn';
        b.type = 'button';
        b.setAttribute( 'data-tip', T( 'sos.title' ) );
        b.setAttribute( 'aria-label', T( 'sos.title' ) );
        b.addEventListener( 'click', openSettings );
        head.insertBefore( b, close );
    }

    function switchRow( label, help, on, onChange )
    {
        var r = el( 'div', 'acct-check-row' );
        r.appendChild( el( 'span', 'acct-check', label ) );
        if( help )
        {
            var i = el( 'button', 'info-tip' );
            i.type = 'button';
            i.setAttribute( 'data-help', help );
            r.appendChild( i );
        }
        var sw = el( 'label', 'switch sm' ), inp = el( 'input' );
        inp.type = 'checkbox';
        inp.setAttribute( 'role', 'switch' );
        inp.setAttribute( 'aria-label', label );
        inp.checked = on;
        inp.addEventListener( 'change', function () { onChange( inp.checked ); } );
        sw.appendChild( inp );
        r.appendChild( sw );
        return r;
    }

    function hoursRow( label, value, onChange )
    {
        var r = el( 'div', 'acct-assign' );
        r.appendChild( el( 'span', '', label ) );
        var inp = el( 'input', 'input sos-hours' );
        inp.type = 'number';
        inp.min = 1;
        inp.max = 72;
        inp.value = value;
        inp.setAttribute( 'aria-label', label );
        inp.addEventListener( 'change', function ()
        {
            var v = Math.min( 72, Math.max( 1, parseInt( inp.value, 10 ) || 1 ) );
            inp.value = v;
            onChange( v );
        } );
        r.appendChild( inp );
        return r;
    }

    function openSettings()
    {
        var d = $( 'sosBackdrop' );
        if( ! d )
        {
            d = el( 'dialog', 'panel' );
            d.id = 'sosBackdrop';
            d.setAttribute( 'aria-label', T( 'sos.title' ) );
            var head = el( 'header' );
            head.appendChild( el( 'h2', '', T( 'sos.title' ) ) );
            var info = el( 'button', 'info-tip' );
            info.type = 'button';
            info.setAttribute( 'data-help', T( 'sos.info' ) );
            head.appendChild( info );
            var x = el( 'button', 'btn' );
            x.type = 'button';
            x.setAttribute( 'data-close', '' );
            x.setAttribute( 'data-tip', T( 'ui.close' ) );
            x.setAttribute( 'aria-label', T( 'ui.close' ) );
            x.innerHTML = Ayni.icon( 'close' );
            x.addEventListener( 'click', function () { d.close(); } );
            head.appendChild( x );
            d.appendChild( head );
            d.appendChild( el( 'div', 'body' ) );
            document.body.appendChild( d );
        }
        api( 'GET', '' ).then( function ( j )
        {
            if( j._status !== 200 ) { Ayni.toast( 'err', T( 'sos.failed' ) ); return; }
            settings = j;
            drawSettings( d.querySelector( '.body' ) );
            if( ! d.open ) d.showModal();
        } );
    }

    function save()
    {
        var s = settings;
        return api( 'PUT', '', { contacts: s.contacts, silent: s.silent, idle: s.idle, quietFrom: s.quietFrom, quietTo: s.quietTo } )
            .then( function ( j )
            {
                if( j._status !== 200 ) { Ayni.toast( 'err', j.error || T( 'sos.failed' ) ); return; }
                s.contacts = j.contacts;
                showButton();
            } );
    }

    function drawSettings( body )
    {
        var s = settings;
        body.replaceChildren();

        // contacts: tick the people to tell
        body.appendChild( el( 'p', 'acct-h', T( 'sos.contacts' ) ) );
        if( ! s.users.length ) body.appendChild( el( 'p', 'find-note', T( 'sos.noUsers' ) ) );
        var list = el( 'div', 'acct-list' );
        s.users.forEach( function ( u )
        {
            var lab = el( 'label', 'sos-contact' ), c = el( 'input' );
            c.type = 'checkbox';
            c.checked = s.contacts.indexOf( u ) >= 0;
            c.addEventListener( 'change', function ()
            {
                s.contacts = s.contacts.filter( function ( x ) { return x !== u; } );
                if( c.checked ) s.contacts.push( u );
                save();
            } );
            lab.append( c, el( 'span', '', u ) );
            list.appendChild( lab );
        } );
        body.appendChild( list );

        // phone silent
        body.appendChild( el( 'p', 'acct-h', T( 'sos.checks' ) ) );
        var silentH = hoursRow( T( 'sos.hours' ), s.silent || 6, function ( v ) { s.silent = v; save(); } );
        body.appendChild( switchRow( T( 'sos.silent' ), T( 'sos.silentInfo' ), s.silent > 0, function ( on )
        {
            s.silent = on ? ( parseInt( silentH.querySelector( 'input' ).value, 10 ) || 6 ) : 0;
            silentH.hidden = ! on;
            save();
        } ) );
        silentH.hidden = ! ( s.silent > 0 );
        body.appendChild( silentH );
        if( ! s.phone ) body.appendChild( el( 'p', 'find-note', T( 'sos.noPhone' ) ) );

        // not used
        var idleH = hoursRow( T( 'sos.hours' ), s.idle || 12, function ( v ) { s.idle = v; save(); } );
        body.appendChild( switchRow( T( 'sos.idle' ), T( 'sos.idleInfo' ), s.idle > 0, function ( on )
        {
            s.idle = on ? ( parseInt( idleH.querySelector( 'input' ).value, 10 ) || 12 ) : 0;
            idleH.hidden = ! on;
            save();
        } ) );
        idleH.hidden = ! ( s.idle > 0 );
        body.appendChild( idleH );

        // quiet hours
        var q = el( 'div', 'acct-assign' );
        q.appendChild( el( 'span', '', T( 'sos.quiet' ) ) );
        var span = el( 'span', 'sos-quiet' );
        [ 'quietFrom', 'quietTo' ].forEach( function ( k, i )
        {
            var t = el( 'input', 'input' );
            t.type = 'time';
            t.value = s[ k ] || ( i ? '08:00' : '23:00' );
            if( ! s[ k ] ) s[ k ] = t.value;
            t.setAttribute( 'aria-label', T( i ? 'sos.quietTo' : 'sos.quietFrom' ) );
            t.addEventListener( 'change', function () { s[ k ] = t.value; save(); } );
            if( i ) span.appendChild( el( 'span', '', '-' ) );
            span.appendChild( t );
        } );
        q.appendChild( span );
        body.appendChild( q );

        // test
        var tr = el( 'div', 'acct-assign' );
        tr.appendChild( el( 'span' ) );
        var test = el( 'button', 'btn text bordered sm', T( 'sos.test' ) );
        test.type = 'button';
        test.addEventListener( 'click', function ()
        {
            if( ! s.contacts.length ) { Ayni.toast( 'warn', T( 'sos.noContacts' ) ); return; }
            api( 'POST', '/send', { test: true } ).then( function ( j )
            {
                var reached = ( j.to || [] ).filter( function ( t ) { return t.sent > 0; } ).map( function ( t ) { return t.user; } );
                Ayni.toast( reached.length ? 'ok' : 'warn',
                    j._status !== 200 ? T( 'sos.failed' ) : reached.length ? T( 'sos.testSent' ) + ': ' + reached.join( ', ' ) : T( 'sos.noneReached' ) );
            } );
        } );
        tr.appendChild( test );
        body.appendChild( tr );
    }

    // ---- a contact opens an alert (?sos=<id>), or "Are you OK?" (?sosok=1) ----

    function fromUrl()
    {
        var q = new URLSearchParams( location.search );
        var id = q.get( 'sos' ), ok = q.get( 'sosok' );
        if( ! id && ! ok ) return;
        q.delete( 'sos' );
        q.delete( 'sosok' );
        var rest = q.toString();
        history.replaceState( null, '', location.pathname + ( rest ? '?' + rest : '' ) + location.hash );
        if( ok ) api( 'POST', '/ok' ).then( function ( j ) { if( j._status === 200 ) Ayni.toast( 'ok', T( 'sos.okThanks' ) ); } );
        if( id ) api( 'GET', '/alert/' + encodeURIComponent( id ) ).then( showAlert );
    }

    function showAlert( a )
    {
        if( a._status !== 200 ) { Ayni.toast( 'warn', T( 'sos.gone' ) ); return; }
        var o = el( 'div', 'sos-screen' + ( a.kind === 'test' ? ' test' : '' ) );
        o.setAttribute( 'role', 'alertdialog' );
        o.setAttribute( 'aria-modal', 'true' );
        o.appendChild( el( 'h2', '', ( a.kind === 'test' ? 'TEST - ' : '' ) + 'SOS - ' + a.from ) );
        var kinds = { sos: 'sos.kSos', silent: 'sos.kSilent', idle: 'sos.kIdle', test: 'sos.kTest' };
        o.appendChild( el( 'p', 'sos-msg', T( kinds[ a.kind ] || 'sos.kSos' ) ) );
        o.appendChild( el( 'p', 'sos-msg', TF( 'sos.at', { t: when( a.at ) } ) ) );
        if( a.since ) o.appendChild( el( 'p', 'sos-msg', TF( 'sos.since', { t: when( a.since ) } ) ) );
        var acts = el( 'div', 'sos-acts' );
        if( a.pos )
        {
            var p = a.pos;
            o.appendChild( el( 'p', 'sos-msg', TF( 'sos.pos', { t: when( p.at ), m: Math.round( p.acc || 0 ) } ) ) );
            var map = el( 'a', 'btn sos-now', T( 'sos.map' ) );
            map.href = 'https://www.openstreetmap.org/?mlat=' + p.lat + '&mlon=' + p.lon + '#map=17/' + p.lat + '/' + p.lon;
            map.target = '_blank';
            map.rel = 'noopener noreferrer';
            acts.appendChild( map );
        }
        else o.appendChild( el( 'p', 'sos-msg', T( 'sos.noPos' ) ) );
        var close = el( 'button', 'btn sos-cancel', T( 'sos.close' ) );
        close.type = 'button';
        close.addEventListener( 'click', function () { o.remove(); } );
        acts.appendChild( close );
        o.appendChild( acts );
        document.body.appendChild( o );
        close.focus();
    }

    // ---- start -------------------------------------------------------------

    document.addEventListener( 'DOMContentLoaded', function ()
    {
        Ayni.i18n.ready.then( function ()
        {
            fromUrl();
            api( 'GET', '' ).then( function ( j )
            {
                if( j._status !== 200 ) return;   // the admin, signed out...
                settings = j;
                showButton();
                addSettingsButton();
            } ).catch( function () {} );
        } );
    } );
} )();
