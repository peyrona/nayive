/* SOS (2026-11-12, server/go/sos.go) - for someone who lives alone.

   - The red SOS button, first in the launcher's top row. With no SOS contact it
     looks the same, but a tap shows how to turn it on. Pressed: a 5-second red screen (Cancel / Send now),
     then the contacts are told, with this device's position if it gives one.
     Held down: a 90-second danger watch, counted by the SERVER (2026-11-13).
     With a danger PIN set (2026-11-14), "I'm safe" asks for it. A wrong one
     looks just the same here - the server tells the contacts "may be forced".
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
    var WATCH = 90;  // seconds a danger watch runs (the server's sosWatchFor)
    var HOLD  = 700; // ms a press must last to start one
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
        if( ! b )
        {
            b = el( 'button', 'btn sos-btn', 'SOS' );
            b.id = 'sosBtn';
            b.type = 'button';
            press( b );
            box.insertBefore( b, box.firstChild );
        }
        // Not set (no contacts): same look, but a tap shows how to turn it on.
        b.classList.toggle( 'off', ! on );
        b.setAttribute( 'aria-label', on ? T( 'sos.press' ) : 'SOS' );
        if( on ) { b.setAttribute( 'data-tip', T( 'sos.press' ) ); b.removeAttribute( 'data-help' ); }
        else     { b.removeAttribute( 'data-tip' ); b.setAttribute( 'data-help', T( 'sos.helpOff' ) ); }

        // (?) at the row's far right end: the top bar's help (one top row only).
        var q = $( 'sosHelp' ), top = document.documentElement.classList.contains( 'ls-top' );
        if( ! q && top )
        {
            q = el( 'button', 'info-tip sos-help' );
            q.id = 'sosHelp';
            q.type = 'button';
            q.innerHTML = Ayni.icon( 'help' );   // (?) - not the "i" an info-tip draws
            q.setAttribute( 'data-help', T( 'sos.helpBar' ) );
            box.appendChild( q );
            Ayni.init( q );
        }
    }

    // A tap: the red screen. Held down: the danger watch.
    function press( b )
    {
        var t = 0, held = false;
        b.setAttribute( 'data-hold', '' );              // Ayni's long-press dot + fill ring
        b.style.setProperty( '--hold-ms', HOLD + 'ms' );
        function off() { clearTimeout( t ); b.classList.remove( 'holding' ); }
        b.addEventListener( 'pointerdown', function ( e )
        {
            if( e.button || b.classList.contains( 'off' ) ) return;
            held = false;
            off();
            b.classList.add( 'holding' );
            t = setTimeout( function ()
            {
                held = true;
                b.classList.remove( 'holding' );
                if( navigator.vibrate ) navigator.vibrate( 80 );
                watch( 0 );
            }, HOLD );
        } );
        [ 'pointerup', 'pointerleave', 'pointercancel' ].forEach( function ( k ) { b.addEventListener( k, off ); } );
        b.addEventListener( 'contextmenu', function ( e ) { e.preventDefault(); } );
        b.addEventListener( 'click', function ()
        {
            if( b.classList.contains( 'off' ) ) Ayni.infoTip( b );   // not set: how to turn it on
            else if( held ) held = false;
            else countdown();
        } );
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

    // ---- the danger watch --------------------------------------------------
    //
    // The SERVER counts: a phone taken or switched off cannot stop it. This
    // screen shows the count, sends better positions, and stops it ("I'm safe").
    // `left` > 0: the page was opened again while one runs.

    function clock( s ) { return Math.floor( s / 60 ) + ':' + String( s % 60 ).padStart( 2, '0' ); }

    function watch( left )
    {
        var running = left > 0;
        left = running ? left : WATCH;
        var done = false, stopping = false, starting = null, timer, geo = null, lock = null;
        var cur = null, sentAcc = Infinity, sentAt = 0;
        var o = el( 'div', 'sos-screen watch' );
        o.setAttribute( 'role', 'alertdialog' );
        o.setAttribute( 'aria-modal', 'true' );
        var h = el( 'h2', '', T( 'sos.watch' ) );
        var n = el( 'div', 'sos-count', clock( left ) );
        var msg = el( 'p', 'sos-msg', T( 'sos.watchHint' ) );
        var acts = el( 'div', 'sos-acts' );
        var safe = el( 'button', 'btn sos-cancel', T( 'sos.safe' ) );
        var now = el( 'button', 'btn sos-now', T( 'sos.sendNow' ) );
        safe.type = now.type = 'button';
        acts.append( safe, now );
        if( matchMedia( '(pointer: coarse)' ).matches )
        {
            var call = el( 'a', 'btn sos-now', T( 'sos.call' ) );
            call.href = 'tel:112';
            acts.appendChild( call );
        }
        o.append( h, n, msg, acts );
        document.body.appendChild( o );
        safe.focus();
        try { navigator.wakeLock.request( 'screen' ).then( function ( l ) { lock = l; }, function () {} ); } catch( e ) {}

        function posBody() { return cur ? { lat: cur.latitude, lon: cur.longitude, acc: cur.accuracy } : {}; }

        function start()
        {
            if( starting ) return starting;
            if( cur ) { sentAcc = cur.accuracy; sentAt = Date.now(); }
            starting = api( 'POST', '/watch', posBody() ).then( function ( j )
            {
                running = running || j._status === 200;
                msg.textContent = T( running ? 'sos.watchHint' : 'sos.watchOffline' );
            }, function () { msg.textContent = T( 'sos.watchOffline' ); } ).then( function () { starting = null; } );
            return starting;
        }
        if( ! running ) start();

        // A better fix, or one every 30 s on the move. Kept up after it went
        // out: the contacts see where now.
        if( navigator.geolocation )
        {
            geo = navigator.geolocation.watchPosition( function ( p )
            {
                cur = p.coords;
                if( running && ( cur.accuracy < sentAcc - 5 || Date.now() - sentAt > 30000 ) )
                {
                    sentAcc = cur.accuracy;
                    sentAt = Date.now();
                    api( 'POST', '/watch/pos', posBody() ).catch( function () {} );
                }
            }, function () {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 } );
        }

        function close()
        {
            done = true;
            clearInterval( timer );
            if( geo !== null ) navigator.geolocation.clearWatch( geo );
            if( lock ) lock.release().catch( function () {} );
            o.remove();
        }

        // The danger PIN: the same screen whatever is typed (the server decides).
        var pinBox = null;
        function askPin()
        {
            if( pinBox ) { pinBox.querySelector( 'input' ).focus(); return; }
            pinBox = el( 'form', 'sos-acts sos-pin' );
            var inp = el( 'input', 'input' );
            inp.type = 'text';   // not "password": no password manager may keep it, nor fill it in
            inp.className = 'input sos-mask';
            inp.inputMode = 'numeric';
            inp.autocomplete = 'off';
            inp.maxLength = 8;
            inp.placeholder = T( 'sos.pinAsk' );
            inp.setAttribute( 'aria-label', T( 'sos.pinAsk' ) );
            var go = el( 'button', 'btn sos-cancel', T( 'sos.safe' ) );
            go.type = 'submit';
            pinBox.append( inp, go );
            pinBox.addEventListener( 'submit', function ( e )
            {
                e.preventDefault();
                if( inp.value.length < 4 ) { inp.focus(); return; }   // a slip of the finger is not a "forced"
                stop( inp.value );
            } );
            safe.style.display = 'none';
            o.insertBefore( pinBox, acts );
            inp.focus();
        }

        // "I'm safe": the server must hear it, or the watch still goes out.
        function stop( pin )
        {
            if( stopping ) return;
            if( typeof pin !== 'string' && running && settings && settings.pin ) { askPin(); return; }
            stopping = safe.disabled = true;
            ( starting || Promise.resolve() ).then( function () { return api( 'POST', '/watch/stop', { pin: typeof pin === 'string' ? pin : '' } ); } ).then( function ( j )
            {
                if( j._status !== 200 ) throw j;
                close();
                if( j.safe ) Ayni.toast( 'ok', T( 'sos.safeSent' ) );
            } ).catch( function ()
            {
                stopping = safe.disabled = false;
                if( ! running ) { close(); return; }   // it never reached the server
                msg.textContent = T( 'sos.stopFailed' );
            } );
        }

        function send()
        {
            if( done || stopping ) return;
            done = true;
            clearInterval( timer );
            h.textContent = T( 'sos.sendingNow' );
            n.remove();
            acts.replaceChildren();
            ( starting || Promise.resolve() ).then( function ()
            {
                return api( 'POST', running ? '/watch/send' : '/send', posBody() );   // never reached the server: a plain SOS
            } ).then( function ( j )
            {
                result( j, o, h, msg, acts, false );
                acts.firstChild.addEventListener( 'click', close );
                if( j._status === 200 && running ) acts.insertBefore( safe, acts.firstChild );
            }, function ()
            {
                result( { _status: 0 }, o, h, msg, acts, false );
                acts.firstChild.addEventListener( 'click', close );
            } );
        }

        safe.addEventListener( 'click', function () { stop(); } );
        now.addEventListener( 'click', send );
        o.addEventListener( 'keydown', function ( e ) { if( e.key === 'Escape' && ! done ) stop(); } );
        timer = setInterval( function ()
        {
            left--;
            n.textContent = clock( Math.max( left, 0 ) );
            if( ! running && left % 5 === 0 ) start();
            if( left <= 0 ) send();
        }, 1000 );
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

    // The danger PIN: only it stops a danger watch. Changing it needs the old one.
    function pinRow()
    {
        var s = settings, box = el( 'div' );
        var r = el( 'div', 'acct-check-row' );
        r.appendChild( el( 'span', 'acct-check', T( 'sos.pin' ) ) );
        var i = el( 'button', 'info-tip' );
        i.type = 'button';
        i.setAttribute( 'data-help', T( 'sos.pinInfo' ) );
        r.appendChild( i );
        box.appendChild( r );
        var f = el( 'form', 'sos-pin-set' );
        function field( key )
        {
            var t = el( 'input', 'input sos-pin-in sos-mask' );
            t.type = 'text';   // see askPin
            t.inputMode = 'numeric';
            t.autocomplete = 'off';
            t.maxLength = 8;
            t.placeholder = T( key );
            t.setAttribute( 'aria-label', T( key ) );
            f.appendChild( t );
            return t;
        }
        var old = s.pin ? field( 'sos.pinOld' ) : null, nu = field( 'sos.pinNew' );
        var go = el( 'button', 'btn text bordered sm', T( 'sos.pinSave' ) );
        go.type = 'submit';
        f.appendChild( go );
        f.addEventListener( 'submit', function ( e )
        {
            e.preventDefault();
            if( nu.value && ! /^[0-9]{4,8}$/.test( nu.value ) ) { Ayni.toast( 'warn', T( 'sos.pinBad' ) ); nu.focus(); return; }
            api( 'PUT', '/pin', { old: old ? old.value : '', pin: nu.value } ).then( function ( j )
            {
                if( j._status !== 200 ) { Ayni.toast( 'err', j.error || T( 'sos.failed' ) ); return; }
                s.pin = j.pin;
                Ayni.toast( 'ok', T( 'sos.pinSaved' ) );
                box.replaceWith( pinRow() );
            } );
        } );
        box.appendChild( f );
        return box;
    }

    function drawSettings( body )
    {
        var s = settings;
        body.replaceChildren();

        // contacts: tick the people to tell
        body.appendChild( el( 'p', 'acct-h', T( 'sos.contacts' ) ) );
        if( ! s.users.length ) body.appendChild( el( 'p', 'find-note', T( 'sos.noUsers' ) ) );
        var list = el( 'ul', 'lb' );
        list.id = 'sosContacts';
        list.tabIndex = 0;
        list.setAttribute( 'role', 'listbox' );
        list.setAttribute( 'aria-multiselectable', 'true' );
        list.setAttribute( 'aria-label', T( 'sos.contacts' ) );
        s.users.forEach( function ( u )
        {
            var o = el( 'li', '', u );
            o.setAttribute( 'role', 'option' );
            o.setAttribute( 'aria-selected', s.contacts.indexOf( u ) >= 0 );
            list.appendChild( o );
        } );
        list.addEventListener( 'ayni:change', function ( e )
        {
            s.contacts = e.detail.selected;
            save();
        } );
        if( s.users.length ) { body.appendChild( list ); Ayni.init( list ); }

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
            var g = el( 'div', 'input-group' ), t = el( 'input', 'input' );
            t.value = s[ k ] || ( i ? '08:00' : '23:00' );
            if( ! s[ k ] ) s[ k ] = t.value;
            t.setAttribute( 'aria-label', T( i ? 'sos.quietTo' : 'sos.quietFrom' ) );
            g.appendChild( t );
            Ayni.timeField( t, { onChange: function ( v ) { s[ k ] = v; save(); } } );
            if( i ) span.appendChild( el( 'span', '', '-' ) );
            span.appendChild( g );
        } );
        q.appendChild( span );
        body.appendChild( q );

        body.appendChild( pinRow() );

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
        var calm = a.kind === 'test' || a.kind === 'safe' || a.kind === 'ended';
        var o = el( 'div', 'sos-screen' + ( calm ? ' test' : '' ) );
        o.setAttribute( 'role', 'alertdialog' );
        o.setAttribute( 'aria-modal', 'true' );
        o.appendChild( el( 'h2', '', ( a.kind === 'test' ? 'TEST - ' : '' ) + 'SOS - ' + a.from ) );
        var kinds = { sos: 'sos.kSos', silent: 'sos.kSilent', idle: 'sos.kIdle', test: 'sos.kTest', watch: 'sos.kWatch', safe: 'sos.kSafe',
                      forced: 'sos.kForced', ended: 'sos.kEnded' };
        o.appendChild( el( 'p', 'sos-msg', TF( kinds[ a.kind ] || 'sos.kSos', { by: a.by || '' } ) ) );
        o.appendChild( el( 'p', 'sos-msg', TF( 'sos.at', { t: when( a.at ) } ) ) );
        if( a.since ) o.appendChild( el( 'p', 'sos-msg', TF( 'sos.since', { t: when( a.since ) } ) ) );
        var acts = el( 'div', 'sos-acts' );
        var where = el( 'p', 'sos-msg' ), map = el( 'a', 'btn sos-now', T( 'sos.map' ) );
        map.target = '_blank';
        map.rel = 'noopener noreferrer';
        o.appendChild( where );
        acts.appendChild( map );
        function place( p )
        {
            where.textContent = p ? TF( 'sos.pos', { t: when( p.at ), m: Math.round( p.acc || 0 ) } ) : T( 'sos.noPos' );
            map.style.display = p ? '' : 'none';
            if( p ) map.href = 'https://www.openstreetmap.org/?mlat=' + p.lat + '&mlon=' + p.lon + '#map=17/' + p.lat + '/' + p.lon;
        }
        place( a.pos );
        // Still open: the phone sends where it is every 3 minutes - follow it.
        if( a.live )
        {
            var follow = setInterval( function ()
            {
                if( ! o.isConnected ) { clearInterval( follow ); return; }
                api( 'GET', '/alert/' + encodeURIComponent( a.id ) ).then( function ( n )
                {
                    if( n._status === 200 && n.pos ) place( n.pos );
                    if( n._status === 200 && ! n.live ) clearInterval( follow );
                } ).catch( function () {} );
            }, 60000 );
        }
        if( a.live )   // a danger watch still open: a contact who knows it is over ends it
        {
            var end = el( 'button', 'btn sos-now', T( 'sos.end' ) );
            end.type = 'button';
            end.addEventListener( 'click', function ()
            {
                end.disabled = true;
                api( 'POST', '/alert/' + encodeURIComponent( a.id ) + '/end', {} ).then( function ( j )
                {
                    if( j._status !== 200 ) { end.disabled = false; Ayni.toast( 'err', j.error || T( 'sos.failed' ) ); return; }
                    Ayni.toast( 'ok', T( 'sos.endedOk' ) );
                    o.remove();
                } );
            } );
            acts.appendChild( end );
        }
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
                if( j.watch > 0 && ! document.querySelector( '.sos-screen' ) ) watch( j.watch );
            } ).catch( function () {} );
        } );
    } );
} )();
