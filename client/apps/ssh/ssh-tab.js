/*
 * ssh/ssh-tab.js - the Admin panel's SSH tab: a terminal on this server.
 *
 * UI ONLY for now: there is no server part yet, so "Connect" opens a local
 * demo shell that echoes what you type. The real link plugs in at SERVER below
 * (passkey check + a WebSocket to the Go server, which talks to localhost:22).
 *
 * The rules this tab keeps (the server will enforce them too):
 *   - admin account only (the panel itself is admin only);
 *   - this server only, one session at a time;
 *   - every connect asks a passkey (Face ID, fingerprint, or the phone via the
 *     browser's QR code) and then the SSH password - nothing is stored except
 *     the SSH username, in this browser, as a convenience;
 *   - closes after 15 minutes with no key pressed, after 2 hours in any case,
 *     when the screen locker comes on and when the page goes away.
 *
 * xterm.js (MIT) is loaded only when the tab is first shown: no one else pays
 * for its 290 KB.
 */
( function ()
{
    'use strict';

    var IDLE_MS   = 15 * 60 * 1000;   // no key pressed for this long -> close
    var MAX_MS    = 2 * 60 * 60 * 1000;
    var WARN_MS   = 60 * 1000;        // the warning shows this long before
    var USER_KEY  = 'nayive-ssh-user';
    var LIB       = 'ssh/lib/';

    var $ = function ( id ) { return document.getElementById( id ); };

    // -- SERVER -------------------------------------------------------------
    // The two calls the server part will answer. Until it exists they are a
    // demo, so the whole UI can be tried.
    var SERVER =
    {
        demo: true,

        // The passkey check (WebAuthn). Resolves when the person proved it is
        // them, rejects with a message otherwise.
        passkey: function ()
        {
            return new Promise( function ( ok ) { setTimeout( ok, 700 ); } );
        },

        // Opens the SSH session. Resolves to { send(text), resize(cols, rows),
        // close() } and calls on.data(text) / on.close(reason) later.
        open: function ( login, size, on )
        {
            return new Promise( function ( ok, fail )
            {
                setTimeout( function ()
                {
                    if ( ! login.password ) { fail( new Error( 'Wrong username or password.' ) ); return; }
                    ok( demoShell( login, on ) );
                }, 500 );
            } );
        }
    };

    // A local echo shell: Enter, Backspace and Ctrl+C work; nothing runs.
    function demoShell( login, on )
    {
        var line = '', prompt = '\x1b[1;32m' + login.user + '@nayive\x1b[0m:\x1b[1;34m~\x1b[0m$ ';
        var gone = false;
        setTimeout( function ()
        {
            on.data( '\x1b[33mDemo: the server part is not built yet. What you type is only echoed.\x1b[0m\r\n' +
                     'Type "exit" to close.\r\n\r\n' + prompt );
        }, 0 );
        return {
            send: function ( s )
            {
                if ( gone ) return;
                for ( var i = 0; i < s.length; i++ )
                {
                    var c = s[ i ];
                    if ( c === '\r' )
                    {
                        var cmd = line.trim(); line = '';
                        if ( cmd === 'exit' ) { gone = true; on.data( '\r\nlogout\r\n' ); on.close( 'Session closed.' ); return; }
                        on.data( '\r\n' + ( cmd ? 'demo: ' + cmd + ': not run (no server yet)\r\n' : '' ) + prompt );
                    }
                    else if ( c === '\x7f' ) { if ( line ) { line = line.slice( 0, -1 ); on.data( '\b \b' ); } }
                    else if ( c === '\x03' ) { line = ''; on.data( '^C\r\n' + prompt ); }
                    else if ( c === '\x1b' ) { i = s.length; }          // arrows, Esc: ignored here
                    else if ( c >= ' ' )     { line += c; on.data( c ); }
                }
            },
            resize: function () {},
            close:  function () { gone = true; }
        };
    }

    // -- loading xterm ------------------------------------------------------
    var libs = null;
    function loadLibs()
    {
        if ( libs ) return libs;
        function script( src )
        {
            return new Promise( function ( ok, fail )
            {
                var s = document.createElement( 'script' );
                s.src = src; s.onload = ok; s.onerror = function () { fail( new Error( "Can't load " + src ) ); };
                document.head.appendChild( s );
            } );
        }
        var css = document.createElement( 'link' );
        css.rel = 'stylesheet'; css.href = LIB + 'xterm_v5.5.0.css';
        document.head.appendChild( css );
        libs = script( LIB + 'xterm_v5.5.0.min.js' )
            .then( function () { return script( LIB + 'xterm-addon-fit_v0.10.0.min.js' ); } )
            .catch( function ( e ) { libs = null; throw e; } );
        return libs;
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

    // -- connect dialog -----------------------------------------------------
    // Step 1: the passkey. Step 2: the SSH username + password.
    function connect()
    {
        if ( sess ) return;
        var d = Ayni.dialog( { title: 'Connect to this server' } );
        var close = document.createElement( 'button' );
        close.type = 'button'; close.className = 'btn'; close.setAttribute( 'data-close', '' );
        close.setAttribute( 'aria-label', 'Cancel' ); close.dataset.tip = 'Cancel';
        close.innerHTML = Ayni.icon( 'close' );

        function stepPasskey()
        {
            d.body.innerHTML =
                '<div class="ssh-step">' +
                    '<div class="ssh-big-icon">' + Ayni.icon( 'key' ) + '</div>' +
                    '<p><strong>First, confirm it is you.</strong></p>' +
                    '<p class="hint">Use Face ID, a fingerprint or your device PIN. On a PC without a reader, ' +
                    'the browser shows a QR code: scan it with your phone and confirm there ' +
                    '(Bluetooth must be on, on both).</p>' +
                    '<button type="button" class="btn text primary" id="sshPasskeyBtn">' + Ayni.icon( 'key' ) +
                        '<span class="label">Use passkey</span></button>' +
                    '<p class="form-error" id="sshPkErr" hidden></p>' +
                '</div>';
            var btn = $( 'sshPasskeyBtn' );
            btn.addEventListener( 'click', function ()
            {
                btn.disabled = true;
                $( 'sshPkErr' ).hidden = true;
                SERVER.passkey().then( stepLogin, function ( e )
                {
                    btn.disabled = false;
                    $( 'sshPkErr' ).textContent = ( e && e.message ) || 'Not confirmed.';
                    $( 'sshPkErr' ).hidden = false;
                } );
            } );
            Ayni.init( d.body );
            setTimeout( function () { btn.focus(); }, 0 );
        }

        function stepLogin()
        {
            var user = '';
            try { user = localStorage.getItem( USER_KEY ) || ''; } catch ( e ) {}
            d.body.innerHTML =
                '<p class="hint lead">Passkey confirmed. Now the SSH login of this server ' +
                '(<code>localhost:22</code>). The password is never stored.</p>' +
                '<div class="field"><label for="sshUser">Username</label>' +
                    '<input class="input" id="sshUser" type="text" autocomplete="off" autocapitalize="none" ' +
                    'autocorrect="off" spellcheck="false"></div>' +
                '<div class="field"><label for="sshPass">Password</label>' +
                    '<div class="input-group"><input class="input" id="sshPass" type="password" autocomplete="off">' +
                    '<button type="button" class="btn" data-reveal></button></div></div>' +
                '<p class="form-error" id="sshLoginErr" hidden></p>';
            $( 'sshUser' ).value = user;

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
                var u = $( 'sshUser' ).value.trim(), p = $( 'sshPass' ).value;
                var err = $( 'sshLoginErr' );
                if ( ! u ) { err.textContent = 'Type the username.'; err.hidden = false; $( 'sshUser' ).focus(); return; }
                err.hidden = true;
                ok.disabled = true;
                try { localStorage.setItem( USER_KEY, u ); } catch ( e ) {}
                open( { user: u, password: p } ).then( function () { d.close(); }, function ( e )
                {
                    ok.disabled = false;
                    $( 'sshPass' ).value = '';
                    err.textContent = ( e && e.message ) || "Can't connect.";
                    err.hidden = false;
                    $( 'sshPass' ).focus();
                } );
                p = null;
            }
            ok.addEventListener( 'click', go );
            d.body.addEventListener( 'keydown', function ( e ) { if ( e.key === 'Enter' ) { e.preventDefault(); go(); } } );
            setTimeout( function () { ( user ? $( 'sshPass' ) : $( 'sshUser' ) ).focus(); }, 0 );
        }

        d.place( [ close ] );
        d.show();           // first: the steps find their fields by id
        stepPasskey();
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
            login.password = null;
            sess = s; who = login.user + '@localhost';
            startedAt = lastKey = Date.now();
            term.clear();
            setStatus( 'on', 'Connected · ' + who + ( SERVER.demo ? ' (demo)' : '' ) );
            tick = setInterval( onTick, 1000 );
            term.focus();
        }, function ( e )
        {
            login.password = null;
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
