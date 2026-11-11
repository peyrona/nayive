/*
 * ssh/ssh-tab.js - the Admin panel's SSH tab: a terminal on this server.
 *
 * The server part is server/go/ssh_term.go + confirm_passkey.go + confirm_totp.go (/api/ssh/...):
 * Nayive logs in to this server's sshd and relays the bytes over plain
 * requests (a long-poll for output, a POST per burst of keys).
 *
 * The rules this tab keeps (the server will enforce them too):
 *   - admin account only (the panel itself is admin only);
 *   - every connect first asks you to CONFIRM IT IS YOU: a passkey (Face ID,
 *     fingerprint, or the phone via the browser's QR code) or the 6-digit code
 *     of an authenticator app (TOTP) - then the SSH password. Nothing is
 *     stored except the SSH username, in this browser, as a convenience;
 *   - the FIRST passkey or app needs a one-time setup code that the server
 *     writes to a file only a real SSH login can read; later ones need one
 *     you have;
 *   - this server only, one session at a time;
 *   - closes after 15 minutes with no key pressed, after 2 hours in any case,
 *     when the screen locker comes on and when the page goes away.
 *
 * xterm.js (MIT) is loaded only when the tab is first shown: no one else pays
 * for its 290 KB. The QR code library (chat's) only when an app is added.
 */
( function ()
{
    'use strict';

    var IDLE_MS   = 15 * 60 * 1000;   // no key pressed for this long -> close
    var MAX_MS    = 2 * 60 * 60 * 1000;
    var WARN_MS   = 60 * 1000;        // the warning shows this long before
    var USER_KEY  = 'nayive-ssh-user';
    var LIB       = 'ssh/lib/';
    var QR_LIB    = 'chat/lib/qrcode_v0.12.0/qrcode.js';

    var $ = function ( id ) { return document.getElementById( id ); };

    // -- SERVER -------------------------------------------------------------
    function api( what, body, opts )
    {
        var o = { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store' };
        if ( body ) { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify( body ); }
        if ( opts && opts.keepalive ) o.keepalive = true;
        return fetch( '/api/ssh/' + what, o ).then( function ( r )
        {
            return r.json().catch( function () { return {}; } ).then( function ( j )
            {
                if ( ! r.ok ) { var e = new Error( j.error || ( 'Error ' + r.status ) ); e.status = r.status; throw e; }
                return j;
            } );
        } );
    }

    // base64 / base64url -> bytes (the passkey helpers live in shared/ayni/ayni-passkey.js).
    function fromB64( txt ) { return AyniPasskey.bytes( txt ); }

    var SERVER =
    {
        // Confirms a passkey. Resolves to a ticket (good for one action), or
        // to { none: true } when no passkey exists yet.
        passkey: function ()
        {
            if ( ! AyniPasskey.supported() ) return Promise.reject( new Error( 'This browser has no passkeys.' ) );
            return api( 'begin', { mode: 'get' } ).then( function ( b )
            {
                if ( b.none ) return { none: true };
                return AyniPasskey.get( { challenge: fromB64( b.challenge ), rpId: b.rp_id, allow: b.allow } ).then( function ( got )
                {
                    var r = got.cred.response;
                    return api( 'confirm',
                    {
                        id: got.id,
                        client_data: AyniPasskey.b64u( r.clientDataJSON ),
                        auth_data: AyniPasskey.b64u( r.authenticatorData ),
                        signature: AyniPasskey.b64u( r.signature )
                    } );
                } ).then( function ( j ) { return j.ticket; } );
            } );
        },

        // Adds a passkey: the setup code for the first, a ticket for the next.
        // Resolves to a ticket (making it asked for the fingerprint/face/PIN).
        addPasskey: function ( gate, name )
        {
            if ( ! AyniPasskey.supported() ) return Promise.reject( new Error( 'This browser has no passkeys.' ) );
            var body = { mode: 'create', code: gate.code || '', ticket: gate.ticket || '' };
            return api( 'begin', body ).then( function ( b )
            {
                return AyniPasskey.create(
                {
                    challenge: fromB64( b.challenge ),
                    rpId: b.rp_id, rpName: 'Nayive SSH',
                    userId: fromB64( b.user_id ), userName: 'Nayive SSH · ' + b.rp_id, displayName: 'Nayive SSH',
                    exclude: b.exclude || []
                } ).then( function ( made )
                {
                    var r = made.cred.response;
                    var key = r.getPublicKey && r.getPublicKey();
                    if ( ! key || ! r.getAuthenticatorData ) throw new Error( 'This browser is too old to add a passkey. Update it.' );
                    return api( 'register',
                    {
                        code: body.code, ticket: body.ticket, name: name,
                        id: made.id,
                        client_data: AyniPasskey.b64u( r.clientDataJSON ),
                        auth_data: AyniPasskey.b64u( r.getAuthenticatorData() ),
                        key: AyniPasskey.b64u( key ),
                        alg: r.getPublicKeyAlgorithm(),
                        transports: r.getTransports ? r.getTransports() : []
                    } );
                } ).then( function ( j ) { return j.ticket; } );
            } );
        },

        // Which ways to confirm work here: { none, passkeys, others, app, locked }.
        status: function () { return api( 'status' ); },

        // Confirms with the app's 6-digit code. Resolves to a ticket.
        appConfirm: function ( otp )
        {
            return api( 'totp', { otp: otp } ).then( function ( j ) { return j.ticket; } );
        },

        // Adds the app, step 1: a new key, { secret, uri }. `gate`: the setup
        // code (nothing set up yet) or a ticket (spent here).
        appBegin: function ( gate )
        {
            return api( 'totp-begin', { code: gate.code || '', ticket: gate.ticket || '' } );
        },

        // Step 2: the app's first code (and the setup code again, if it was
        // the gate). Resolves to a ticket.
        appAdd: function ( gate, otp, name )
        {
            return api( 'totp-add', { code: gate.code || '', otp: otp, name: name } ).then( function ( j ) { return j.ticket; } );
        },

        // Opens the SSH session. Resolves to { send(text), resize(cols, rows),
        // close() } and calls on.data(bytes) / on.close(reason) later.
        open: function ( login, size, on )
        {
            return api( 'open', { ticket: login.ticket, user: login.user, password: login.password, cols: size.cols, rows: size.rows } )
                .then( function ( j ) { return remoteShell( j.id, on ); } );
        }
    };

    // The open session: a long-poll for what the shell prints, one POST at a
    // time for what is typed (in order), a POST on resize.
    function remoteShell( id, on )
    {
        var alive = true, from = 0, misses = 0;
        var pending = '', busy = false, resizeT = null;
        var q = '?id=' + encodeURIComponent( id ) + '&from=';

        function stop( reason )
        {
            if ( ! alive ) return;
            alive = false;
            on.close( reason );
        }

        function poll()
        {
            if ( ! alive ) return;
            api( 'read' + q + from ).then( function ( r )
            {
                if ( ! alive ) return;
                misses = 0;
                if ( r.data ) on.data( fromB64( r.data ) );
                from = r.next;
                if ( r.ended ) { stop( r.ended ); return; }
                poll();
            }, function ( e )
            {
                if ( ! alive ) return;
                // A short network hiccup: try again. Signed out, or gone: stop.
                if ( e.status === 401 || e.status === 403 || ++misses > 5 ) { stop( 'Connection lost.' ); return; }
                setTimeout( poll, 1500 * misses );
            } );
        }

        function flush()
        {
            if ( busy || ! pending || ! alive ) return;
            var d = pending.slice( 0, 16000 );      // under the server's 64 KB per POST
            pending = pending.slice( d.length );
            busy = true;
            api( 'write', { id: id, data: d } ).then( function () { busy = false; flush(); },
                function ( e ) { busy = false; stop( e.message || 'Connection lost.' ); } );
        }

        poll();
        return {
            send: function ( s ) { pending += s; flush(); },
            resize: function ( cols, rows )
            {
                clearTimeout( resizeT );
                resizeT = setTimeout( function ()
                {
                    if ( alive ) api( 'resize', { id: id, cols: cols, rows: rows } ).catch( function () {} );
                }, 200 );
            },
            close: function ()
            {
                if ( ! alive ) return;
                alive = false;
                api( 'close', { id: id }, { keepalive: true } ).catch( function () {} );
            }
        };
    }

    // -- loading xterm ------------------------------------------------------
    function script( src )
    {
        return new Promise( function ( ok, fail )
        {
            var s = document.createElement( 'script' );
            s.src = src; s.onload = ok; s.onerror = function () { fail( new Error( "Can't load " + src ) ); };
            document.head.appendChild( s );
        } );
    }

    var libs = null;
    function loadLibs()
    {
        if ( libs ) return libs;
        var css = document.createElement( 'link' );
        css.rel = 'stylesheet'; css.href = LIB + 'xterm_v5.5.0.css';
        document.head.appendChild( css );
        libs = script( LIB + 'xterm_v5.5.0.min.js' )
            .then( function () { return script( LIB + 'xterm-addon-fit_v0.10.0.min.js' ); } )
            .catch( function ( e ) { libs = null; throw e; } );
        return libs;
    }

    // The QR code library is Chat's (NayiveQR.matrix); loaded when an app is added.
    var qrLib = null;
    function loadQR()
    {
        if ( window.NayiveQR ) return Promise.resolve();
        if ( ! qrLib ) qrLib = script( QR_LIB ).catch( function ( e ) { qrLib = null; throw e; } );
        return qrLib;
    }

    // A QR code as a canvas: black on white with a quiet border (as chat/list.js).
    function qrCanvas( text )
    {
        if ( ! window.NayiveQR ) return null;
        var m;
        try { m = NayiveQR.matrix( text ); } catch ( e ) { return null; }
        var n = m.length, q = 4, px = 4;
        var cv = document.createElement( 'canvas' );
        cv.width = cv.height = ( n + 2 * q ) * px;
        var x = cv.getContext( '2d' );
        x.fillStyle = '#fff';
        x.fillRect( 0, 0, cv.width, cv.height );
        x.fillStyle = '#000';
        for ( var r = 0; r < n; r++ )
            for ( var c = 0; c < n; c++ )
                if ( m[ r ][ c ] ) x.fillRect( ( c + q ) * px, ( r + q ) * px, px, px );
        return cv;
    }

    // -- state --------------------------------------------------------------
    var term = null, fit = null;
    var sess = null;            // the open session, or null
    var who  = '';              // "user@host" while connected
    var startedAt = 0, lastKey = 0, tick = null;
    var ctrlNext = false;       // the key bar's Ctrl: the next key is a control key

    function setStatus( state, text )
    {
        var st = $( 'sshStatus' );
        st.dataset.state = state;
        $( 'sshStatusText' ).textContent = text;
        var on = state === 'on';
        $( 'sshConnect' ).hidden    = on || state === 'busy';
        $( 'sshDisconnect' ).hidden = ! on;
        $( 'sshKeys' ).hidden       = ! on;
        $( 'sshBox' ).classList.toggle( 'live', on );
    }

    function fmtLeft( ms )
    {
        var s = Math.max( 0, Math.ceil( ms / 1000 ) );
        return Math.floor( s / 60 ) + ':' + String( s % 60 ).padStart( 2, '0' );
    }

    // Once a second while connected: the idle and the 2-hour limits.
    function onTick()
    {
        if ( ! sess ) return;
        var now = Date.now();
        var idleLeft = IDLE_MS - ( now - lastKey );
        var maxLeft  = MAX_MS  - ( now - startedAt );
        if ( idleLeft <= 0 ) { end( 'Closed after 15 minutes with no key pressed.' ); return; }
        if ( maxLeft  <= 0 ) { end( 'Closed: a session lasts 2 hours at most.' ); return; }

        var warn = $( 'sshWarn' );
        if ( idleLeft <= WARN_MS )
        {
            warn.hidden = false;
            warn.textContent = 'No key pressed: closing in ' + fmtLeft( idleLeft ) + '. Press any key to stay.';
        }
        else if ( maxLeft <= 5 * WARN_MS )
        {
            warn.hidden = false;
            warn.textContent = 'The 2-hour limit: closing in ' + fmtLeft( maxLeft ) + '.';
        }
        else warn.hidden = true;
    }

    function end( reason )
    {
        var s = sess;
        sess = null; who = '';
        clearInterval( tick ); tick = null;
        if ( s ) try { s.close(); } catch ( e ) {}
        $( 'sshWarn' ).hidden = true;
        setCtrl( false );
        if ( term ) term.write( '\r\n\x1b[2m[' + ( reason || 'Disconnected.' ) + ']\x1b[0m\r\n' );
        setStatus( 'off', reason || 'Not connected' );
    }

    // -- typing -------------------------------------------------------------
    function send( text )
    {
        if ( ! sess ) return;
        lastKey = Date.now();
        if ( ctrlNext && text.length === 1 )
        {
            var c = text.toUpperCase().charCodeAt( 0 );
            if ( c >= 64 && c <= 95 ) text = String.fromCharCode( c - 64 );   // Ctrl+A..Ctrl+_
            setCtrl( false );
        }
        sess.send( text );
        onTick();       // a key hides the idle warning at once
    }

    function setCtrl( on )
    {
        ctrlNext = on;
        var b = $( 'sshCtrl' );
        if ( b ) b.setAttribute( 'aria-pressed', on ? 'true' : 'false' );
    }

    // The key bar: what a phone keyboard lacks.
    var KEYS =
    [
        { label: 'Esc', send: '\x1b' },
        { label: 'Tab', send: '\t' },
        { label: 'Ctrl', id: 'sshCtrl' },
        { label: '↑', send: '\x1b[A', tip: 'Up' },
        { label: '↓', send: '\x1b[B', tip: 'Down' },
        { label: '←', send: '\x1b[D', tip: 'Left' },
        { label: '→', send: '\x1b[C', tip: 'Right' },
        { label: '|', send: '|' },
        { label: '/', send: '/' },
        { label: '-', send: '-' },
        { label: '~', send: '~' }
    ];

    function buildKeys()
    {
        var bar = $( 'sshKeys' );
        KEYS.forEach( function ( k )
        {
            var b = document.createElement( 'button' );
            b.type = 'button';
            b.className = 'btn text sm bordered';
            b.textContent = k.label;
            if ( k.tip ) { b.setAttribute( 'aria-label', k.tip ); }
            if ( k.id )  { b.id = k.id; b.setAttribute( 'aria-pressed', 'false' ); }
            // keep the focus (and the phone keyboard) in the terminal
            b.addEventListener( 'pointerdown', function ( e ) { e.preventDefault(); } );
            b.addEventListener( 'click', function ()
            {
                if ( k.id === 'sshCtrl' ) setCtrl( ! ctrlNext );
                else send( k.send );
                if ( term ) term.focus();
            } );
            bar.appendChild( b );
        } );
    }

    // -- the terminal -------------------------------------------------------
    function makeTerm()
    {
        if ( term ) return;
        term = new window.Terminal(
        {
            cursorBlink: true, fontSize: 14, scrollback: 3000,
            fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
            theme: { background: '#16181d', foreground: '#e6e6e6', cursor: '#16a085', selectionBackground: '#16a08566' }
        } );
        fit = new window.FitAddon.FitAddon();
        term.loadAddon( fit );
        term.open( $( 'sshTerm' ) );
        term.onData( send );
        term.onResize( function ( s ) { if ( sess ) sess.resize( s.cols, s.rows ); } );
        new ResizeObserver( function () { try { fit.fit(); } catch ( e ) {} } ).observe( $( 'sshTerm' ) );
        fit.fit();
        term.write( '\x1b[2mNot connected. Press Connect.\x1b[0m\r\n' );
    }

    // -- "confirm it is you" ------------------------------------------------
    // A passkey, or the 6-digit code of an authenticator app. The server says
    // which exist (status); the device says which to suggest.

    // A passkey where the device itself keeps one (phones, Mac, Windows
    // Hello); the app where it cannot (Linux, old browsers).
    var recommended = null;
    function recommend()
    {
        if ( recommended ) return recommended;
        var pkc = window.PublicKeyCredential;
        recommended = ( AyniPasskey.supported() && pkc && pkc.isUserVerifyingPlatformAuthenticatorAvailable
            ? pkc.isUserVerifyingPlatformAuthenticatorAvailable().catch( function () { return false; } )
            : Promise.resolve( false ) ).then( function ( yes ) { return yes ? 'passkey' : 'app'; } );
        return recommended;
    }

    function closeButton( tip )
    {
        var b = document.createElement( 'button' );
        b.type = 'button'; b.className = 'btn'; b.setAttribute( 'data-close', '' );
        b.setAttribute( 'aria-label', tip ); b.dataset.tip = tip;
        b.innerHTML = Ayni.icon( 'close' );
        return b;
    }

    // The 6 digits of a typed code, or ''.
    function sixDigits( v )
    {
        v = String( v || '' ).replace( /\D/g, '' );
        return v.length === 6 ? v : '';
    }

    // Draws the confirm step into `box`. o.why: an error to show first, and
    // o.tip: what to do about it; o.step: "Step 1 of 2"; o.done( ticket, how ):
    // how is 'passkey' or 'app'; o.none(): nothing is set up yet.
    function confirmInto( box, o )
    {
        box.innerHTML = '<p class="hint">Loading…</p>';
        Promise.all( [ SERVER.status(), recommend() ] ).then( function ( r )
        {
            var st = r[ 0 ], rec = r[ 1 ];
            if ( st.none ) { o.none(); return; }
            var canPk   = st.passkeys > 0 && AyniPasskey.supported();
            var pkFirst = canPk && ( ! st.app || rec === 'passkey' );

            var pkPart = ! canPk ? '' :
                '<div class="ssh-way">' +
                    '<p class="hint">Use Face ID, a fingerprint or your device PIN. On a PC without a reader, ' +
                    'the browser shows a QR code: scan it with your phone and confirm there ' +
                    '(Bluetooth must be on, on both).</p>' +
                    '<button type="button" class="btn text ' + ( pkFirst ? 'primary' : 'bordered' ) + '" id="sshPasskeyBtn">' +
                        Ayni.icon( 'key' ) + '<span class="label">Use passkey</span></button>' +
                '</div>';
            var appPart = ! st.app ? '' :
                '<div class="ssh-way">' +
                    '<p class="hint">' + ( canPk ? 'Or type' : 'Type' ) + ' the 6-digit code that your authenticator app ' +
                    'shows for <em>Nayive SSH</em>.</p>' +
                    '<div class="ssh-otp-row">' +
                        '<input class="input ssh-otp" id="sshOtp" type="text" inputmode="numeric" autocomplete="one-time-code" ' +
                        'maxlength="7" placeholder="123456" aria-label="6-digit code">' +
                        '<button type="button" class="btn text ' + ( pkFirst ? 'bordered' : 'primary' ) + '" id="sshOtpBtn">' +
                            Ayni.icon( 'check' ) + '<span class="label">Confirm</span></button>' +
                    '</div>' +
                '</div>';

            // Why nothing (or less) can be used here.
            var note = '';
            if ( ! canPk && st.passkeys > 0 && ! st.app )
                note = 'This browser has no passkeys. Use an up-to-date Chrome, Edge, Safari or Firefox.';
            else if ( st.passkeys === 0 && st.others > 0 )
                note = st.app ? 'Your passkeys were made for another address of Nayive’s server: here, use the app.'
                              : 'Your passkeys were made for another address of Nayive’s server. Open Nayive at the address you used to add them.';
            if ( note && ! st.app && ! canPk )
                note += ' Tip: add an authenticator app there too (Passkeys & app › Add app): it works at any address and in any browser.';

            box.innerHTML =
                '<div class="ssh-step">' +
                    ( o.step ? '<p class="ssh-stepno">' + o.step + '</p>' : '' ) +
                    '<div class="ssh-big-icon">' + Ayni.icon( 'key' ) + '</div>' +
                    '<p><strong>First, confirm it is you.</strong></p>' +
                    ( pkFirst ? pkPart + appPart : appPart + pkPart ) +
                    ( note ? '<p class="hint ssh-note"></p>' : '' ) +
                    '<p class="form-error" id="sshPkErr" hidden></p>' +
                    '<p class="ssh-tip" id="sshPkTip" hidden></p>' +
                    ( st.locked || ( ! canPk && ! st.app ) ?
                        '<button type="button" class="btn text bordered" id="sshRetry">' + Ayni.icon( 'refresh' ) +
                        '<span class="label">Try again</span></button>' : '' ) +
                '</div>';
            if ( note ) box.querySelector( '.ssh-note' ).textContent = note;

            var pkBtn = $( 'sshPasskeyBtn' ), otp = $( 'sshOtp' ), otpBtn = $( 'sshOtpBtn' ), errEl = $( 'sshPkErr' );
            function busy( on ) { [ pkBtn, otpBtn, otp ].forEach( function ( b ) { if ( b ) b.disabled = on; } ); }
            function fail( e )
            {
                busy( false );
                errEl.textContent = ( e && e.message ) || 'Not confirmed.';
                errEl.hidden = false;
            }
            if ( st.locked ) fail( new Error( st.lock || 'Too many wrong tries. Wait, then try again.' ) );
            else if ( o.why ) fail( new Error( o.why ) );
            if ( o.tip && ! st.locked ) { $( 'sshPkTip' ).textContent = o.tip; $( 'sshPkTip' ).hidden = false; }

            if ( pkBtn ) pkBtn.addEventListener( 'click', function ()
            {
                busy( true );
                errEl.hidden = true;
                SERVER.passkey().then( function ( r )
                {
                    if ( r && r.none ) o.none();
                    else o.done( r, 'passkey' );
                }, fail );
            } );
            function sendCode()
            {
                var v = sixDigits( otp.value );
                if ( ! v ) { fail( new Error( 'Type the 6 digits the app shows.' ) ); otp.focus(); return; }
                busy( true );
                errEl.hidden = true;
                SERVER.appConfirm( v ).then( function ( t ) { o.done( t, 'app' ); }, function ( e )
                {
                    fail( e );
                    otp.value = '';
                    otp.focus();
                } );
            }
            if ( otp )
            {
                otpBtn.addEventListener( 'click', sendCode );
                otp.addEventListener( 'keydown', function ( e ) { if ( e.key === 'Enter' ) { e.preventDefault(); sendCode(); } } );
                // The 6th digit sends it: one step less.
                otp.addEventListener( 'input', function () { if ( sixDigits( otp.value ) && ! otpBtn.disabled ) sendCode(); } );
            }
            if ( $( 'sshRetry' ) ) $( 'sshRetry' ).addEventListener( 'click', function () { confirmInto( box, { done: o.done, none: o.none, step: o.step } ); } );
            Ayni.init( box );
            setTimeout( function () { var f = pkFirst ? pkBtn : ( otp || pkBtn ); if ( f && ! f.disabled ) f.focus(); }, 0 );
        }, function ( e )
        {
            box.innerHTML = '<p class="form-error"></p>';
            box.firstChild.textContent = ( e && e.message ) || "Can't reach the server.";
        } );
    }

    // A ticket for one change in the list (add, remove). Only passkeys here
    // and a browser that has them: straight to the browser's prompt, as
    // always. Else a small dialog with the choice.
    function confirmTicket()
    {
        return SERVER.status().then( function ( st )
        {
            if ( st.passkeys > 0 && ! st.app && AyniPasskey.supported() ) return SERVER.passkey();
            return new Promise( function ( ok, no )
            {
                var d = Ayni.dialog( { title: 'Confirm it is you' } ), settled = false;
                d.place( [ closeButton( 'Cancel' ) ] );
                d.show();
                d.dialog.addEventListener( 'close', function () { if ( ! settled ) no( new Error( 'Not confirmed.' ) ); } );
                confirmInto( d.body,
                {
                    done: function ( t ) { settled = true; d.close(); ok( t ); },
                    none: function () { settled = true; d.close(); no( new Error( 'Nothing is set up yet.' ) ); }
                } );
            } );
        } );
    }

    // -- connect dialog -----------------------------------------------------
    // Step 1: confirm it is you. Step 2: the server's own login (a Linux
    // account of this computer, NOT the Nayive login).

    // The server's accounts, its name, the one Nayive runs as (once a page).
    var accountsP = null;
    function loadAccounts()
    {
        if ( ! accountsP ) accountsP = api( 'accounts' ).catch( function () { accountsP = null; return {}; } );
        return accountsP;
    }

    function connect()
    {
        if ( sess ) return;
        var d = Ayni.dialog( { title: 'Connect to Nayive’s server' } );
        var lastErr = '', lastUser = '';      // the refused try, shown again at step 2

        function stepConfirm( why, tip )
        {
            d.footer.innerHTML = '';
            d.footer.remove();
            confirmInto( d.body, { why: why, tip: tip, step: 'Step 1 of 2', done: stepLogin,
                none: function () { setupInto( d.body, stepLogin ); } } );
        }

        // `ticket`: what the confirm gave; good for ONE try. `how`: 'passkey' or 'app'.
        function stepLogin( ticket, how )
        {
            d.body.innerHTML = '<p class="hint">Loading…</p>';
            loadAccounts().then( function ( acc ) { drawLogin( ticket, how, acc || {} ); } );
        }

        function drawLogin( ticket, how, acc )
        {
            var list  = acc.accounts || [];
            var mine  = list.indexOf( acc.runs_as ) !== -1 ? acc.runs_as : '';
            var saved = '';
            try { saved = localStorage.getItem( USER_KEY ) || ''; } catch ( e ) {}
            var user  = lastUser || saved || mine || ( list.length === 1 ? list[ 0 ] : '' );
            var inList = list.indexOf( user ) !== -1;

            d.body.innerHTML =
                '<div id="sshLoginBox">' +
                '<p class="ssh-stepno">Step 2 of 2 · confirmed ' + Ayni.icon( 'check' ) + '</p>' +
                '<p><strong>Now log in to the server itself</strong></p>' +
                '<div class="ssh-explain">' +
                    '<p>This is <strong>not</strong> your Nayive login. It is an account of the Linux computer ' +
                    'that Nayive runs on (<code class="ssh-host"></code>):</p>' +
                    '<ul>' +
                        '<li>the name and password you would type for <code>ssh <span class="ssh-name">name</span>@<span class="ssh-host"></span></code> in a terminal;</li>' +
                        '<li>its password is the one that <code>sudo</code> asks for on that computer.</li>' +
                    '</ul>' +
                '</div>' +
                '<p class="form-error" id="sshLastErr" hidden></p>' +
                '<div class="field"><label for="' + ( list.length ? 'sshUserPick' : 'sshUser' ) + '">Account on <span class="ssh-host"></span></label>' +
                    ( list.length ? '<select class="input" id="sshUserPick"></select>' : '' ) +
                    '<input class="input" id="sshUser" type="text" autocomplete="off" autocapitalize="none" ' +
                    'autocorrect="off" spellcheck="false" placeholder="Account name" aria-label="Account name">' +
                    '<p class="hint" id="sshUserHint"></p>' +
                '</div>' +
                '<div class="field"><label for="sshPass">Password of <span class="ssh-name">that account</span></label>' +
                    '<div class="input-group"><input class="input" id="sshPass" type="password" autocomplete="off">' +
                    '<button type="button" class="btn" data-reveal></button></div>' +
                    '<p class="hint">Never stored. A wrong one sends you back to step 1.</p>' +
                '</div>' +
                '<p class="form-error" id="sshLoginErr" hidden></p>' +
                '</div>';

            var host = acc.host || 'Nayive’s server';
            d.body.querySelectorAll( '.ssh-host' ).forEach( function ( el ) { el.textContent = host; } );
            if ( lastErr ) { $( 'sshLastErr' ).textContent = 'Last try: ' + lastErr; $( 'sshLastErr' ).hidden = false; }

            var pick = $( 'sshUserPick' ), field = $( 'sshUser' ), hint = $( 'sshUserHint' );
            if ( pick )
            {
                list.forEach( function ( a )
                {
                    var o = document.createElement( 'option' );
                    o.value = a;
                    o.textContent = a + ( a === mine ? '  (Nayive runs as this one)' : '' );
                    pick.appendChild( o );
                } );
                var other = document.createElement( 'option' );
                other.value = ''; other.textContent = 'Another account…';
                pick.appendChild( other );
                pick.value = inList ? user : '';
            }
            field.value = inList ? '' : user;

            function chosen() { return pick && pick.value ? pick.value : field.value.trim(); }
            function sync()
            {
                field.hidden = !! ( pick && pick.value );
                var u = chosen();
                d.body.querySelectorAll( '.ssh-name' ).forEach( function ( el ) { el.textContent = u || ( el.closest( 'label' ) ? 'that account' : 'name' ); } );
                hint.textContent = ! list.length
                    ? 'Type the name you use for ssh on Nayive’s server.'
                    : mine && u !== mine
                        ? 'Not sure? Pick “' + mine + '”: Nayive itself runs as that account, so it is most likely yours.'
                        : mine ? 'Nayive itself runs as this account, so it is most likely yours.'
                               : 'The accounts on Nayive’s server that can log in.';
            }
            if ( pick ) pick.addEventListener( 'change', function () { sync(); ( pick.value ? $( 'sshPass' ) : field ).focus(); } );
            field.addEventListener( 'input', sync );
            sync();

            var ok = document.createElement( 'button' );
            ok.type = 'button'; ok.className = 'btn primary';
            ok.setAttribute( 'aria-label', 'Connect' ); ok.dataset.tip = 'Connect';
            ok.innerHTML = Ayni.icon( 'check' );
            d.footer.innerHTML = '';
            d.footer.appendChild( ok );
            if ( ! d.dialog.contains( d.footer ) ) d.dialog.appendChild( d.footer );
            Ayni.init( d.dialog );

            function go()
            {
                var u = chosen(), p = $( 'sshPass' ).value;
                var err = $( 'sshLoginErr' );
                if ( ! u ) { err.textContent = 'Pick or type the account name.'; err.hidden = false; ( field.hidden ? pick : field ).focus(); return; }
                if ( ! p ) { err.textContent = 'Type the password of “' + u + '”.'; err.hidden = false; $( 'sshPass' ).focus(); return; }
                if ( ok.disabled ) return;
                err.hidden = true;
                ok.disabled = true;
                try { localStorage.setItem( USER_KEY, u ); } catch ( e ) {}
                open( { user: u, password: p, ticket: ticket } ).then( function () { d.close(); }, function ( e )
                {
                    // The ticket is spent: one password try per confirm. A
                    // code works once, so the app's NEXT code is needed.
                    lastErr = ( e && e.message ) || "Can't connect.";
                    lastUser = u;
                    stepConfirm( 'Not connected. ' + lastErr, how === 'app'
                        ? 'To try again, confirm once more. Each code works only once: wait until your app shows a NEW code (at most 30 seconds), then type it.'
                        : 'To try again, confirm once more.' );
                } );
                p = null;
            }
            ok.addEventListener( 'click', go );
            // On this step's own box: the dialog body outlives the step.
            $( 'sshLoginBox' ).addEventListener( 'keydown', function ( e ) { if ( e.key === 'Enter' && e.target.tagName !== 'SELECT' ) { e.preventDefault(); go(); } } );
            setTimeout( function () { ( chosen() ? $( 'sshPass' ) : ( field.hidden ? pick : field ) ).focus(); }, 0 );
        }

        d.place( [ closeButton( 'Cancel' ) ] );
        d.show();           // first: the steps find their fields by id
        stepConfirm();
    }

    // -- the first way to confirm: the setup code ---------------------------
    // Draws the setup steps into `box`; calls done(ticket, how) once a
    // passkey or the app is in.
    function setupInto( box, done )
    {
        box.innerHTML =
            '<div class="ssh-setup">' +
                '<p><strong>Nothing set up yet: first add a way to confirm it is you.</strong> You do this once.</p>' +
                '<ol class="hint">' +
                    '<li>Press <em>Make setup code</em>. The server writes a one-time code into a file.</li>' +
                    '<li>Read that file in a real SSH login on Nayive’s server (the command shows below).</li>' +
                    '<li>Type the code here, then add a passkey (your fingerprint, face or phone) or an authenticator app.</li>' +
                '</ol>' +
                '<button type="button" class="btn text bordered" id="sshMakeCode">' + Ayni.icon( 'key' ) +
                    '<span class="label">Make setup code</span></button>' +
                '<div id="sshCodeBox" hidden>' +
                    '<p class="hint">In your SSH login, run:</p>' +
                    '<pre class="ssh-cmd" id="sshCmd"></pre>' +
                    '<p class="hint">The code works once, for 15 minutes.</p>' +
                    '<div class="field"><label for="sshCode">Setup code</label>' +
                        '<input class="input" id="sshCode" type="text" autocomplete="off" autocapitalize="characters" ' +
                        'spellcheck="false" placeholder="XXXX-XXXX-XXXX"></div>' +
                    '<div class="field"><label for="sshPkName">Name ' +
                        '<button class="info-tip" type="button" data-help="Only a label for you, so you can tell them apart later in the Passkeys &amp; app list (for example &quot;My phone&quot; or &quot;Office laptop&quot;). It does not change how it works. You may leave it empty."></button></label>' +
                        '<input class="input" id="sshPkName" type="text" maxlength="60" placeholder="e.g. My phone"></div>' +
                    '<p class="ssh-sub"><strong>How will you confirm it is you?</strong></p>' +
                    '<div class="ssh-ways">' +
                        '<div class="ssh-way-row" data-way="passkey">' +
                            '<button type="button" class="btn text bordered" id="sshAddFirst">' + Ayni.icon( 'key' ) +
                                '<span class="label">Add passkey</span></button>' +
                            '<span class="hint">Face ID, a fingerprint or a PIN on this device, or your phone. ' +
                                '<strong class="ssh-rec" hidden>Best on this device.</strong></span>' +
                        '</div>' +
                        '<div class="ssh-way-row" data-way="app">' +
                            '<button type="button" class="btn text bordered" id="sshAddApp">' + Ayni.icon( 'clock' ) +
                                '<span class="label">Add authenticator app</span></button>' +
                            '<span class="hint">A 6-digit code from an app on your phone. Works in any browser. ' +
                                '<strong class="ssh-rec" hidden>Best on this device.</strong></span>' +
                        '</div>' +
                    '</div>' +
                    '<details class="ssh-keyhelp">' +
                        '<summary>Your browser asks for a <strong>USB security key</strong>?</summary>' +
                        '<p>A passkey must live in something that can keep it safe.</p>' +
                        '<ul>' +
                            '<li><strong>Phones</strong> (iPhone, Android) keep it themselves and unlock it with your face or fingerprint. No USB key is asked.</li>' +
                            '<li><strong>Mac and Windows</strong> keep it too (Touch ID, iCloud Keychain, Windows Hello). No USB key is asked.</li>' +
                            '<li><strong>Linux</strong> has no such place built in, so the browser asks for a USB key. Pick one of these instead:</li>' +
                        '</ul>' +
                        '<h4>On Linux</h4>' +
                        '<ol type="a">' +
                            '<li><strong>Use an authenticator app</strong> instead of a passkey: press <em>Add authenticator app</em> above. The simplest way.</li>' +
                            '<li><strong>Use your phone.</strong> Turn on Bluetooth on this PC, press <em>Cancel</em> in the browser&#39;s box and try again: ' +
                                'it now offers <em>Use a phone or tablet</em> with a QR code. Scan it with the phone; the phone keeps the passkey.</li>' +
                            '<li><strong>Sign in to Chrome</strong> with your Google account and turn on sync. ' +
                                'Chrome then keeps the passkey in Google Password Manager.</li>' +
                            '<li><strong>Use a password manager that keeps passkeys</strong>, such as Bitwarden or KeePassXC with its browser add-on.</li>' +
                            '<li><strong>Buy a USB security key</strong> (for example a YubiKey), plug it in and touch it when asked.</li>' +
                        '</ol>' +
                    '</details>' +
                '</div>' +
                '<p class="form-error" id="sshSetupErr" hidden></p>' +
            '</div>';
        var err = $( 'sshSetupErr' );
        function fail( e ) { err.textContent = ( e && e.message ) || 'Failed.'; err.hidden = false; }

        // The suggested way first, as the main button; no passkeys here: the app only.
        recommend().then( function ( rec )
        {
            var ways = box.querySelector( '.ssh-ways' );
            if ( ! ways ) return;
            var row = ways.querySelector( '[data-way="' + rec + '"]' );
            ways.insertBefore( row, ways.firstChild );
            row.querySelector( '.btn' ).classList.replace( 'bordered', 'primary' );
            row.querySelector( '.ssh-rec' ).hidden = false;
            if ( ! AyniPasskey.supported() ) ways.querySelector( '[data-way="passkey"]' ).hidden = true;
        } );

        function typedCode()
        {
            var code = $( 'sshCode' ).value.trim();
            if ( ! code ) { fail( new Error( 'Type the setup code.' ) ); $( 'sshCode' ).focus(); }
            return code;
        }

        $( 'sshMakeCode' ).addEventListener( 'click', function ()
        {
            var b = this;
            b.disabled = true; err.hidden = true;
            api( 'setup', {} ).then( function ( j )
            {
                b.disabled = false;
                $( 'sshCmd' ).textContent = 'cat ' + j.file;
                $( 'sshCodeBox' ).hidden = false;
                $( 'sshCode' ).focus();
            }, function ( e ) { b.disabled = false; fail( e ); } );
        } );
        $( 'sshAddFirst' ).addEventListener( 'click', function ()
        {
            var b = this, code = typedCode();
            if ( ! code ) return;
            b.disabled = true; err.hidden = true;
            SERVER.addPasskey( { code: code }, $( 'sshPkName' ).value.trim() ).then( function ( t ) { done( t, 'passkey' ); }, function ( e )
            {
                b.disabled = false; fail( e );
            } );
        } );
        $( 'sshAddApp' ).addEventListener( 'click', function ()
        {
            var b = this, code = typedCode();
            if ( ! code ) return;
            b.disabled = true; err.hidden = true;
            var gate = { code: code }, name = $( 'sshPkName' ).value.trim();
            SERVER.appBegin( gate ).then( function ( offer )
            {
                appEnrolInto( box, gate, offer, name, function ( t ) { done( t, 'app' ); } );
            }, function ( e ) { b.disabled = false; fail( e ); } );
        } );
        Ayni.init( box );
    }

    // -- adding the authenticator app ---------------------------------------
    // `offer` is SERVER.appBegin's { secret, uri }. Shows the QR code, the
    // key as text and the otpauth:// link; the app's first code adds it and
    // calls done(ticket).
    function appEnrolInto( box, gate, offer, name, done )
    {
        box.innerHTML =
            '<div class="ssh-app">' +
                '<p><strong>Add an authenticator app</strong></p>' +
                '<ol class="ssh-app-steps">' +
                    '<li><strong>Get the app.</strong> On your phone, install an authenticator app if you have none: ' +
                        'Google Authenticator, Microsoft Authenticator, Aegis or 2FAS (all free).</li>' +
                    '<li><strong>Scan this QR code</strong> with the app: tap <em>+</em> or <em>Add account</em>, then <em>Scan a QR code</em>.' +
                        '<div class="ssh-qr" id="sshQr"></div>' +
                        '<p class="hint">Is the app on this phone? Then tap:</p>' +
                        '<a class="btn text bordered" id="sshOtpLink">' + Ayni.icon( 'external' ) + '<span class="label">Open in the app</span></a>' +
                        '<p class="hint">Can&#39;t scan? In the app choose <em>Enter a setup key</em>, type the name ' +
                        '<em>Nayive SSH</em> and this key (time-based):</p>' +
                        '<div class="ssh-secret-row"><pre class="ssh-cmd" id="sshSecret"></pre>' +
                            '<button type="button" class="btn" id="sshCopySecret" aria-label="Copy the key" data-tip="Copy the key">' +
                            Ayni.icon( 'copy' ) + '</button></div>' +
                    '</li>' +
                    '<li><strong>Type the 6-digit code</strong> the app now shows for <em>Nayive SSH</em>.' +
                        '<div class="ssh-otp-row">' +
                            '<input class="input ssh-otp" id="sshOtpNew" type="text" inputmode="numeric" autocomplete="one-time-code" ' +
                            'maxlength="7" placeholder="123456" aria-label="6-digit code">' +
                            '<button type="button" class="btn text primary" id="sshAddAppOk">' + Ayni.icon( 'check' ) +
                                '<span class="label">Add app</span></button>' +
                        '</div>' +
                    '</li>' +
                '</ol>' +
                '<p class="hint">Keep the app: from now on, each connection can ask for its code. ' +
                'This key is shown only now.</p>' +
                '<p class="form-error" id="sshAppErr" hidden></p>' +
            '</div>';
        $( 'sshSecret' ).textContent = offer.secret.match( /.{1,4}/g ).join( ' ' );
        $( 'sshOtpLink' ).href = offer.uri;
        $( 'sshCopySecret' ).addEventListener( 'click', function ()
        {
            Ayni.copyText( offer.secret ).then( function () { Ayni.toast( 'ok', 'Key copied.' ); }, function () {} );
        } );
        loadQR().then( function ()
        {
            var cv = qrCanvas( offer.uri ), host = $( 'sshQr' );
            if ( cv && host ) { cv.setAttribute( 'role', 'img' ); cv.setAttribute( 'aria-label', 'QR code for the authenticator app' ); host.appendChild( cv ); }
            else if ( host ) host.textContent = "Can't draw the QR code: type the key below instead.";
        }, function ()
        {
            if ( $( 'sshQr' ) ) $( 'sshQr' ).textContent = "Can't draw the QR code: type the key below instead.";
        } );

        var otp = $( 'sshOtpNew' ), ok = $( 'sshAddAppOk' ), err = $( 'sshAppErr' );
        function add()
        {
            var v = sixDigits( otp.value );
            if ( ! v ) { err.textContent = 'Type the 6 digits the app shows.'; err.hidden = false; otp.focus(); return; }
            if ( ok.disabled ) return;
            ok.disabled = true; err.hidden = true;
            SERVER.appAdd( gate, v, name ).then( done, function ( e )
            {
                ok.disabled = false;
                err.textContent = ( e && e.message ) || 'Failed.';
                err.hidden = false;
                otp.value = '';
                otp.focus();
            } );
        }
        ok.addEventListener( 'click', add );
        otp.addEventListener( 'keydown', function ( e ) { if ( e.key === 'Enter' ) { e.preventDefault(); add(); } } );
        otp.addEventListener( 'input', function () { if ( sixDigits( otp.value ) ) add(); } );
        Ayni.init( box );
    }

    // -- the list: passkeys and the app, add, remove ------------------------
    // The dialog is Ayni's (AyniPasskey.listDialog); the SSH rules are here:
    // adding or removing one asks you to confirm with one you have (a ticket).
    function passkeysDialog()
    {
        // "Add app": confirm, then the app's own small dialog.
        function addApp( name )
        {
            return confirmTicket().then( function ( ticket )
            {
                return SERVER.appBegin( { ticket: ticket } );
            } ).then( function ( offer )
            {
                return new Promise( function ( ok )
                {
                    var d = Ayni.dialog( { title: 'Add an authenticator app' } ), added = false;
                    d.place( [ closeButton( 'Cancel' ) ] );
                    d.show();
                    d.dialog.addEventListener( 'close', function () { if ( ! added ) ok( false ); } );
                    appEnrolInto( d.body, {}, offer, name, function () { added = true; d.close(); ok( 'Authenticator app added.' ); } );
                } );
            } );
        }

        AyniPasskey.listDialog(
        {
            title: 'Passkeys & app',
            lead: 'Each SSH connection asks for one of these: a passkey, or the code of your authenticator app. ' +
                  'Adding or removing one asks for one you have. Keep two, so a lost phone does not lock you out.',
            addLabel: 'Add passkey',
            load: function () { return api( 'keys' ).then( function ( j ) { return j.keys || []; } ); },
            note: function ( k ) { return k.kind === 'app' ? 'Authenticator app' : 'Passkey'; },
            extra: function ( keys )
            {
                var has = keys.some( function ( k ) { return k.kind === 'app'; } );
                return has ? [] : [ { label: 'Add app', icon: 'clock', run: addApp } ];
            },
            empty: function ( box, reload )
            {
                setupInto( box, function ( t, how ) { reload( how === 'app' ? 'Authenticator app added.' : '' ); } );
            },
            add: function ( name )
            {
                return confirmTicket().then( function ( ticket ) { return SERVER.addPasskey( { ticket: ticket }, name ); } );
            },
            remove: function ( k )
            {
                return confirmTicket().then( function ( ticket ) { return api( 'remove', { ticket: ticket, id: k.id } ); } );
            }
        } );
    }

    function open( login )
    {
        setStatus( 'busy', 'Connecting…' );
        var size = { cols: term.cols, rows: term.rows };
        var on =
        {
            data:  function ( s ) { if ( term ) term.write( s ); },
            close: function ( reason ) { if ( sess ) end( reason ); }
        };
        return SERVER.open( login, size, on ).then( function ( s )
        {
            login.password = login.ticket = null;
            sess = s; who = login.user + '@localhost';
            startedAt = lastKey = Date.now();
            term.clear();
            setStatus( 'on', 'Connected · ' + who );
            tick = setInterval( onTick, 1000 );
            term.focus();
        }, function ( e )
        {
            login.password = login.ticket = null;
            setStatus( 'off', 'Not connected' );
            throw e;
        } );
    }

    // -- full screen --------------------------------------------------------
    function toggleFull()
    {
        var box = $( 'sshBox' );
        if ( document.fullscreenElement ) document.exitFullscreen();
        else if ( box.requestFullscreen ) box.requestFullscreen().catch( function () {} );
    }

    // -- start --------------------------------------------------------------
    var started = false;
    function shown()
    {
        if ( started ) return;
        started = true;
        setStatus( 'busy', 'Loading the terminal…' );
        loadLibs().then( function ()
        {
            makeTerm();
            setStatus( 'off', 'Not connected' );
        }, function ( e )
        {
            started = false;
            setStatus( 'off', e.message );
        } );
    }

    document.addEventListener( 'DOMContentLoaded', function ()
    {
        var sec = $( 'sshSec' );
        if ( ! sec ) return;

        $( 'sshConnect' ).innerHTML    = Ayni.icon( 'key' ) + '<span class="label">Connect</span>';
        $( 'sshDisconnect' ).innerHTML = Ayni.icon( 'sign-out' ) + '<span class="label">Disconnect</span>';
        $( 'sshFull' ).innerHTML       = Ayni.icon( 'fullscreen' );
        $( 'sshPasskeys' ).innerHTML   = Ayni.icon( 'lock' ) + '<span class="label">Passkeys &amp; app</span>';
        $( 'sshPasskeys' ).addEventListener( 'click', passkeysDialog );
        $( 'sshFull' ).hidden          = ! document.fullscreenEnabled;
        $( 'sshConnect' ).addEventListener( 'click', function () { if ( term ) connect(); } );
        $( 'sshDisconnect' ).addEventListener( 'click', function () { end( 'Disconnected.' ); } );
        $( 'sshFull' ).addEventListener( 'click', toggleFull );
        buildKeys();

        // The tab shows by Ayni.tabs un-hiding the section: start then.
        var check = function () { if ( ! sec.hidden ) shown(); };
        new MutationObserver( check ).observe( sec, { attributes: true, attributeFilter: [ 'hidden' ] } );
        check();

        // The screen locker comes on -> the session ends.
        new MutationObserver( function ()
        {
            if ( sess && document.documentElement.classList.contains( 'ayni-locked' ) ) end( 'Closed: the screen was locked.' );
        } ).observe( document.documentElement, { attributes: true, attributeFilter: [ 'class' ] } );

        // Leaving the page (sign-out, reload, close) ends it too.
        window.addEventListener( 'pagehide', function () { if ( sess ) end( 'Page closed.' ); } );
    } );
} )();
