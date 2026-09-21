/*
 * call.js - voice and video calls, one to one (the owner and one person).
 * Server side: server/go/chat_call.go. Plan and decisions: docs/chat-calls-plan.md.
 *
 * The sound and the picture go browser to browser (WebRTC, always encrypted).
 * The server only carries the setup: this page POSTs a "signal", the other
 * page reads it in its wait (list.js). One whole offer and one whole answer -
 * no trickle: every signal wakes every page of this owner, so few is better.
 * The caller always makes the offer, also to reconnect after a network change.
 *
 * On screen (a full-screen layer, no ×): calling / ringing, incoming,
 * connecting, the talk timer, reconnecting, and how it ended (2 s). The phone's
 * Back does nothing while a call is on - leaving is hanging up (his call, D3).
 *
 * This page's id (S.dev) goes on every wait: signals are addressed to a page,
 * so the owner's second tab never reads the answer meant for the first one.
 *
 * A call belongs to the world (core.js) of its chat: a chat in another user's
 * home rings, signals and ends through that home (call.w.api), and every
 * world counts its own signals (w.sigSeen).
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h, T = C.T;

    S.dev     = C.rid();   // this page, for the server (8-40 URL-safe chars)
    S.sigSeen = 0;         // the last call signal read (this page's own world; a via world has its own)
    S.callsOn = false;     // the server has coturn: the buttons show

    var call = null;       // the one call on this page, or null
    var ENDED_FOR = 2200;  // ms the "how it ended" words stay up
    var CONNECT_MAX = 25000, RESTART_AFTER = 3000, FAIL_AFTER = 20000;

    C.inCall    = function () { return !! call; };
    C.waitQuery = function ( w ) { return "&dev=" + S.dev + "&s=" + ( w || S ).sigSeen; };

    // ---------------------------------------------------------------------
    // what the server says: the calls (summary and every wait) and signals
    // ---------------------------------------------------------------------

    // `w`: the world the answer came from (S by default).
    C.onCalls = function ( r, w )
    {
        if( ! r ) return;
        w = w || S;
        if( r.callsOn !== undefined ) S.callsOn = !! r.callsOn;
        var list = r.calls || [];
        var seen = false;
        var ours = call && call.w === w;   // our call lives in this world
        list.forEach( function ( c )
        {
            if( ours && c.id === call.id ) { seen = call.known = true; update( c ); return; }
            if( ! call && c.state === "ringing" && c.to === w.me ) incoming( c, w );
        } );
        // Gone from the server altogether (it restarted): nothing to wait for.
        // Only once it was seen there: a reply sent just before our call
        // existed would not list it yet.
        if( ours && call.known && ! seen && Array.isArray( r.calls ) && call.state !== "ended" ) finish( "lost" );

        ( r.sig || [] ).forEach( function ( g )
        {
            if( g.seq <= w.sigSeen ) return;
            w.sigSeen = g.seq;
            if( call && call.w === w && g.call === call.id ) onSig( g.data );
        } );
    };

    // A change of the call as the server sees it.
    function update( c )
    {
        if( c.state === "ended" ) { finish( c.reason ); return; }
        if( call.dir === "in" && call.state === "incoming" && c.state === "active" && ! c.mine )
        {
            // Another page (or device) of mine took it.
            call.answeredElsewhere = true;
            finish( "elsewhere" );
            return;
        }
        if( call.dir === "out" && call.state === "calling" && c.state === "active" ) startOffer();
    }

    // ---------------------------------------------------------------------
    // starting and answering
    // ---------------------------------------------------------------------

    // The phone / video button of a 1:1 chat.
    C.startCall = async function ( video )
    {
        var conv = S.open;
        if( call ) { if( call.el ) call.el.hidden = false; return; }
        if( ! conv || conv.indexOf( "d-" ) !== 0 ) return;
        call = newCall( { conv: conv, video: !! video, dir: "out", state: "calling", w: C.W( conv ) } );
        show();
        if( ! await getMedia() ) { drop(); return; }
        try
        {
            var r = await C.api( "POST", "conv/" + conv + "/call", { video: !! video, dev: S.dev } );
            if( ! call ) return;
            call.id  = r.id;
            call.ice = r.ice;
            if( r.incoming )
            {
                // They called me at the same moment: answer theirs.
                call.dir = "in";
                call.video = !! r.video;
                call.state = "incoming";
                await C.answerCall();
                return;
            }
            tone( "back" );
            render();
        }
        catch( e )
        {
            if( ! call ) return;
            if( e.status === 409 && /ocupado/.test( e.message ) ) { finish( "busy" ); return; }
            drop();
            if( e.status === 409 ) C.toast( "chat.inCall", 2600 );
            else C.fail( e );
        }
    };

    function incoming( c, w )
    {
        call = newCall( { id: c.id, conv: c.conv, video: !! c.video, dir: "in", state: "incoming", w: w } );
        show();
        tone( "ring" );
    }

    C.answerCall = async function ()
    {
        if( ! call || call.state !== "incoming" ) return;
        tone( null );
        call.state = "connecting";
        render();
        // Answer FIRST, then the microphone: an iPhone asks for it every time,
        // and the other devices must stop ringing while it asks.
        try
        {
            var r = await C.api( "POST", "call/" + call.id + "/answer", { dev: S.dev }, { base: call.w.api } );
            call.ice = r.ice;
        }
        catch( e )
        {
            if( e.status === 409 ) { finish( "elsewhere" ); return; }
            finish( "lost" );
            return;
        }
        if( ! call.local && ! await getMedia() ) { hangUp( "fail" ); return; }
        makePeer();
        armConnect();
        // The offer comes as a signal (onSig) - or it already came, while the
        // phone was still asking for the microphone.
        if( call.pendingOffer ) { var d = call.pendingOffer; call.pendingOffer = null; onSig( d ); }
    };

    C.declineCall = function () { hangUp(); };

    function newCall( o )
    {
        o.peer = o.w.me === "o" ? o.conv.slice( 2 ) : "o";   // the other side of the 1:1 chat
        o.mic = true;
        o.cam = !! o.video;
        o.peerMic = true;
        o.peerCam = !! o.video;
        return o;
    }

    // ---------------------------------------------------------------------
    // the media
    // ---------------------------------------------------------------------

    async function getMedia()
    {
        var want = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
        if( call.video ) want.video = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };
        try { call.local = await navigator.mediaDevices.getUserMedia( want ); }
        catch( e )
        {
            if( call.video && e && e.name !== "NotAllowedError" )
            {
                // No camera (or it is busy): the call still works as voice.
                try
                {
                    call.local = await navigator.mediaDevices.getUserMedia( { audio: want.audio } );
                    call.cam = false;
                }
                catch( _ ) {}
            }
            if( ! call.local )
            {
                C.toast( call.video ? "chat.camBlocked" : "chat.micBlocked", 3600 );
                return false;
            }
        }
        call.facing = "user";
        if( call.el ) render();
        try
        {
            var devs = await navigator.mediaDevices.enumerateDevices();
            call.cams = devs.filter( function ( d ) { return d.kind === "videoinput"; } ).length;
        }
        catch( _ ) { call.cams = 0; }
        if( call.el ) render();
        return true;
    }

    function makePeer()
    {
        var cfg = { iceServers: call.ice || [] };
        // Debug only (proves coturn): localStorage "nayive.chat.relay" = "udp" | "tcp".
        var relay = "";
        try { relay = localStorage.getItem( "nayive.chat.relay" ) || ""; } catch( _ ) {}
        if( relay )
        {
            cfg.iceTransportPolicy = "relay";
            cfg.iceServers = cfg.iceServers.filter( function ( s ) { return s.username; } ).map( function ( s )
            {
                var urls = [].concat( s.urls ).filter( function ( u ) { return u.indexOf( "transport=" + relay ) > 0; } );
                return { urls: urls, username: s.username, credential: s.credential };
            } );
        }
        var pc = call.pc = new RTCPeerConnection( cfg );
        call.local.getTracks().forEach( function ( t ) { pc.addTrack( t, call.local ); } );
        pc.ontrack = function ( e )
        {
            if( ! call || call.pc !== pc ) return;
            call.remote = e.streams[ 0 ] || new MediaStream( [ e.track ] );
            attachRemote();
        };
        pc.onconnectionstatechange = function () { if( call && call.pc === pc ) onConn(); };
        pc.oniceconnectionstatechange = function () { if( call && call.pc === pc ) onIce(); };
    }

    // Wait for the address search to finish - at most 2 s (a whole offer, no trickle).
    function gathered( pc )
    {
        return new Promise( function ( ok )
        {
            if( pc.iceGatheringState === "complete" ) { ok(); return; }
            var t = setTimeout( done, 2000 );
            function done() { clearTimeout( t ); pc.removeEventListener( "icegatheringstatechange", check ); ok(); }
            function check() { if( pc.iceGatheringState === "complete" ) done(); }
            pc.addEventListener( "icegatheringstatechange", check );
        } );
    }

    async function startOffer( restart )
    {
        if( ! call ) return;
        tone( null );
        if( ! restart )
        {
            call.state = "connecting";
            render();
            makePeer();
            armConnect();
        }
        var pc = call.pc;
        try
        {
            await pc.setLocalDescription( await pc.createOffer( restart ? { iceRestart: true } : undefined ) );
            await gathered( pc );
            if( call && call.pc === pc ) sendSig( { t: "offer", sdp: pc.localDescription.sdp } );
        }
        catch( e ) { hangUp( "fail" ); }
    }

    async function onSig( d )
    {
        if( ! d || ! call ) return;
        var pc = call.pc;
        try
        {
            // The offer can beat the microphone prompt: keep it for answerCall.
            if( d.t === "offer" && ! pc && call.dir === "in" ) { call.pendingOffer = d; return; }
            if( d.t === "offer" && pc && call.dir === "in" )
            {
                await pc.setRemoteDescription( { type: "offer", sdp: d.sdp } );
                await pc.setLocalDescription( await pc.createAnswer() );
                await gathered( pc );
                if( call && call.pc === pc ) sendSig( { t: "answer", sdp: pc.localDescription.sdp } );
                sendState();
            }
            else if( d.t === "answer" && pc && call.dir === "out" )
            {
                await pc.setRemoteDescription( { type: "answer", sdp: d.sdp } );
                sendState();
            }
            else if( d.t === "state" )
            {
                call.peerMic = d.mic !== false;
                call.peerCam = d.cam !== false;
                render();
            }
        }
        catch( e ) { hangUp( "fail" ); }
    }

    function sendSig( data )
    {
        if( ! call || ! call.id ) return;
        C.api( "POST", "call/" + call.id + "/sig", { dev: S.dev, data: data }, { base: call.w.api } ).catch( function () {} );
    }

    function sendState() { if( call ) sendSig( { t: "state", mic: call.mic, cam: call.cam } ); }

    function onConn()
    {
        var st = call.pc.connectionState;
        if( st === "connected" )
        {
            clearTimeout( call.connectTimer );
            clearTimeout( call.failTimer );
            call.failTimer = null;
            if( ! call.since ) call.since = Date.now();
            call.state = "talking";
            wakeLock( true );
            render();
            if( ! call.tick ) call.tick = setInterval( renderTime, 1000 );
        }
        else if( st === "failed" && call.state === "talking" ) reconnecting();
        else if( st === "failed" && call.state === "connecting" ) hangUp( "fail" );
    }

    function onIce()
    {
        var st = call.pc.iceConnectionState;
        if( st === "disconnected" || st === "failed" )
        {
            if( call.state !== "talking" && call.state !== "reconnecting" ) return;
            if( st === "disconnected" && ! call.discTimer )
                call.discTimer = setTimeout( function () { call.discTimer = null; reconnecting(); }, RESTART_AFTER );
            if( st === "failed" ) reconnecting();
        }
        else if( st === "connected" || st === "completed" )
        {
            clearTimeout( call.discTimer );
            call.discTimer = null;
            if( call.state === "reconnecting" ) { clearTimeout( call.failTimer ); call.failTimer = null; call.state = "talking"; render(); }
        }
    }

    // The network changed (Wi-Fi to mobile data...): the caller offers again.
    function reconnecting()
    {
        if( ! call || call.state === "ended" ) return;
        if( call.state !== "reconnecting" )
        {
            call.state = "reconnecting";
            render();
        }
        if( ! call.failTimer ) call.failTimer = setTimeout( function () { hangUp( "fail" ); }, FAIL_AFTER );
        if( call.dir === "out" ) startOffer( true );
    }

    // Answered but never connected (the offer never came, no route at all).
    function armConnect()
    {
        clearTimeout( call.connectTimer );
        call.connectTimer = setTimeout( function () { if( call && call.state === "connecting" ) hangUp( "fail" ); }, CONNECT_MAX );
    }

    function attachRemote()
    {
        if( ! call || ! call.el || ! call.remote ) return;
        var el = call.video ? call.el.querySelector( ".call-remote" ) : call.el.querySelector( "audio" );
        if( el.srcObject !== call.remote ) el.srcObject = call.remote;
        var p = el.play();
        if( p && p.catch ) p.catch( function () { call.el.querySelector( ".call-hear" ).hidden = false; } );
    }

    // ---------------------------------------------------------------------
    // the buttons
    // ---------------------------------------------------------------------

    function toggleMic()
    {
        call.mic = ! call.mic;
        call.local.getAudioTracks().forEach( function ( t ) { t.enabled = call.mic; } );
        sendState();
        render();
    }

    function toggleCam()
    {
        call.cam = ! call.cam;
        call.local.getVideoTracks().forEach( function ( t ) { t.enabled = call.cam; } );
        sendState();
        render();
    }

    // Front <-> back camera: the old one stops first (many phones cannot hold
    // two open), then the new track takes its place without a new offer.
    async function flip()
    {
        var old = call.local.getVideoTracks()[ 0 ];
        var next = call.facing === "user" ? "environment" : "user";
        if( old ) old.stop();
        try
        {
            var s = await navigator.mediaDevices.getUserMedia( { video: { facingMode: next } } );
            var track = s.getVideoTracks()[ 0 ];
            track.enabled = call.cam;
            if( old ) call.local.removeTrack( old );
            call.local.addTrack( track );
            var sender = call.pc && call.pc.getSenders().filter( function ( x ) { return x.track === old || ( x.track && x.track.kind === "video" ); } )[ 0 ];
            if( sender ) await sender.replaceTrack( track );
            call.facing = next;
            call.el.querySelector( ".call-self" ).srcObject = null;   // render() hangs the new one
            render();
        }
        catch( e ) { C.toast( "chat.camBlocked", 2600 ); }
    }

    // Hang up, cancel, decline - the server tells which from the state.
    function hangUp( reason )
    {
        if( ! call ) return;
        var id = call.id;
        if( id ) C.api( "POST", "call/" + id + "/end", reason ? { reason: reason } : {}, { base: call.w.api } ).catch( function () {} );
        finish( reason === "fail" ? "fail" : "hangup" );
    }

    // A page closing mid-call ends it at once, not a minute later.
    window.addEventListener( "pagehide", function ()
    {
        if( ! call || ! call.id || call.state === "ended" ) return;
        try
        {
            navigator.sendBeacon( call.w.api + "/call/" + call.id + "/end",
                                  new Blob( [ "{}" ], { type: "text/plain" } ) );
        }
        catch( _ ) {}
    } );

    // ---------------------------------------------------------------------
    // the end
    // ---------------------------------------------------------------------

    // Say how it ended for a moment, then close. `why` is the server's reason
    // (hangup, decline, cancel, noanswer, busy, fail, lost) or "elsewhere".
    function finish( why )
    {
        if( ! call || call.state === "ended" ) return;
        var wasTalking = !! call.since;
        call.state = "ended";
        call.why = wasTalking && why !== "fail" && why !== "lost" ? "hangup" : why;
        stopAll();
        render();
        var c = call;
        setTimeout( function () { if( call === c ) drop(); }, ENDED_FOR );
    }

    function stopAll()
    {
        tone( null );
        clearTimeout( call.connectTimer );
        clearTimeout( call.discTimer );
        clearTimeout( call.failTimer );
        clearInterval( call.tick );
        if( call.pc ) try { call.pc.close(); } catch( _ ) {}
        if( call.local ) call.local.getTracks().forEach( function ( t ) { t.stop(); } );
        wakeLock( false );
    }

    // Close the screen and forget the call.
    function drop()
    {
        if( ! call ) return;
        if( call.state !== "ended" ) stopAll();
        var el = call.el;
        call = null;
        if( el ) { el.remove(); C.popNav( "call" ); }
        if( S.open && C.renderConvHead ) C.renderConvHead();
    }

    // ---------------------------------------------------------------------
    // sounds, vibration, the screen staying on
    // ---------------------------------------------------------------------

    var audio = null;
    var toneTimer = null;

    // "ring": an incoming call. "back": ours is ringing over there. null: quiet.
    // Made here (no sound files); a browser only lets it sound after the page
    // was touched once - without that, the screen and the vibration remain.
    function tone( kind )
    {
        clearInterval( toneTimer );
        toneTimer = null;
        buzz( 0 );
        if( ! kind ) return;
        try
        {
            audio = audio || new ( window.AudioContext || window.webkitAudioContext )();
            if( audio.state === "suspended" ) audio.resume().catch( function () {} );
        }
        catch( _ ) { audio = null; }
        var beat = function ()
        {
            if( kind === "ring" )
            {
                beep( 660, 0, 0.35 ); beep( 880, 0.45, 0.35 );
                buzz( [ 500, 250, 500 ] );
            }
            else beep( 425, 0, 1.0 );
        };
        beat();
        toneTimer = setInterval( beat, kind === "ring" ? 2500 : 4000 );
    }

    // The phone buzzes too - where it can (not an iPhone), and only once the
    // page was touched: before that the browser refuses (and says so).
    function buzz( pattern )
    {
        if( ! navigator.vibrate ) return;
        if( navigator.userActivation && ! navigator.userActivation.hasBeenActive ) return;
        try { navigator.vibrate( pattern ); } catch( _ ) {}
    }

    function beep( freq, at, len )
    {
        if( ! audio || audio.state !== "running" ) return;
        var t0 = audio.currentTime + at;
        var o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = freq;
        g.gain.setValueAtTime( 0, t0 );
        g.gain.linearRampToValueAtTime( 0.18, t0 + 0.03 );
        g.gain.setValueAtTime( 0.18, t0 + len - 0.05 );
        g.gain.linearRampToValueAtTime( 0, t0 + len );
        o.connect( g ).connect( audio.destination );
        o.start( t0 );
        o.stop( t0 + len + 0.02 );
    }

    var lock = null;
    async function wakeLock( on )
    {
        try
        {
            if( on && ! lock && navigator.wakeLock ) lock = await navigator.wakeLock.request( "screen" );
            if( ! on && lock ) { lock.release(); lock = null; }
        }
        catch( _ ) { lock = null; }
    }
    // The browser lets go of it when the page hides: take it again on return.
    document.addEventListener( "visibilitychange", function ()
    {
        if( ! document.hidden && call && call.state === "talking" ) { lock = null; wakeLock( true ); }
    } );

    // ---------------------------------------------------------------------
    // the screen
    // ---------------------------------------------------------------------

    function show()
    {
        var el = call.el = h( "div", { class: "call-screen" + ( call.video ? " video" : "" ), attrs: { role: "dialog", "aria-modal": "true" } } );
        el.appendChild( h( "video", { class: "call-remote", attrs: { playsinline: "", autoplay: "" } } ) );
        el.appendChild( h( "audio", { attrs: { autoplay: "" } } ) );
        el.appendChild( h( "div", { class: "call-top" } ) );
        el.appendChild( h( "video", { class: "call-self", attrs: { playsinline: "", autoplay: "", muted: "" } } ) );
        el.appendChild( h( "button", { class: "text-btn call-hear", attrs: { type: "button", hidden: true }, text: T( "chat.tapToHear" ),
                                       on: { click: function () { this.hidden = true; attachRemote(); } } } ) );
        el.appendChild( h( "div", { class: "call-btns" } ) );
        document.body.appendChild( el );
        // Back must not end a call: the step is put back each time it is used.
        var stay = function () { if( call && call.el === el ) C.pushNav( "call", stay ); };
        C.pushNav( "call", stay );
        render();
    }

    function render()
    {
        if( ! call || ! call.el ) return;
        var el = call.el;
        var name = C.nameOf( call.peer, call.conv );
        el.classList.toggle( "video", !! call.video );
        el.classList.toggle( "live", call.state === "talking" || call.state === "reconnecting" );
        el.classList.toggle( "peer-cam-off", ! call.peerCam );

        var top = el.querySelector( ".call-top" );
        top.textContent = "";
        top.appendChild( C.avatar( call.conv, name, "xl" ) );
        top.appendChild( h( "b", { text: name } ) );
        top.appendChild( h( "small", { class: "call-state", text: stateWords() } ) );
        if( ! call.peerMic && call.state === "talking" )
            top.appendChild( h( "small", { class: "call-note" }, C.ic( "mic-off" ), T( "chat.peerMuted" ) ) );

        var self = el.querySelector( ".call-self" );
        self.muted = true;
        if( call.local && call.video && self.srcObject !== call.local ) { self.srcObject = call.local; self.play().catch( function () {} ); }
        self.hidden = ! ( call.video && call.local && call.cam );
        self.classList.toggle( "mirror", call.facing !== "environment" );

        var btns = el.querySelector( ".call-btns" );
        btns.textContent = "";
        if( call.state === "incoming" )
        {
            btns.appendChild( C.btn( "phone-off", "chat.decline", C.declineCall, "lg solid-danger" ) );
            btns.appendChild( C.btn( call.video ? "video" : "phone", "chat.answer", C.answerCall, "lg solid-ok" ) );
            return;
        }
        if( call.state === "ended" ) return;
        var mic = C.btn( call.mic ? "mic" : "mic-off", call.mic ? "chat.muteMic" : "chat.unmuteMic", toggleMic, "lg" + ( call.mic ? "" : " is-active" ) );
        mic.disabled = ! call.local;
        btns.appendChild( mic );
        if( call.video )
        {
            var cam = C.btn( call.cam ? "video" : "video-off", call.cam ? "chat.cameraOff" : "chat.cameraOn", toggleCam, "lg" + ( call.cam ? "" : " is-active" ) );
            cam.disabled = ! call.local || ! call.local.getVideoTracks().length;
            btns.appendChild( cam );
            if( call.cams > 1 ) btns.appendChild( C.btn( "refresh", "chat.flipCamera", flip, "lg" ) );
        }
        btns.appendChild( C.btn( "phone-off", "chat.hangUp", function () { hangUp(); }, "lg solid-danger" ) );
    }

    function stateWords()
    {
        switch( call.state )
        {
            case "calling":      return T( call.w.online.has( call.peer ) ? "chat.ringing" : "chat.calling" );
            case "incoming":     return T( call.video ? "chat.incomingVideo" : "chat.incomingVoice" );
            case "connecting":   return T( "chat.connecting" );
            case "reconnecting": return T( "chat.reconnecting" );
            case "talking":      return clock( Date.now() - call.since );
        }
        switch( call.why )
        {
            case "busy":      return T( "chat.busy" );
            case "decline":   return T( call.dir === "out" ? "chat.declined" : "chat.callEnded" );
            case "noanswer":  return T( call.dir === "out" ? "chat.noAnswer" : "chat.missed" );
            case "cancel":    return T( call.dir === "in" ? "chat.missed" : "chat.callEnded" );
            case "elsewhere": return T( "chat.answeredElsewhere" );
            case "fail":      return T( "chat.callFailed" );
            case "lost":      return T( "chat.callLost" );
        }
        return T( "chat.callEnded" );
    }

    function renderTime()
    {
        if( ! call || ! call.el || call.state !== "talking" ) return;
        var s = call.el.querySelector( ".call-state" );
        if( s ) s.textContent = clock( Date.now() - call.since );
    }

    function clock( ms )
    {
        var s = Math.max( 0, Math.floor( ms / 1000 ) );
        var m = Math.floor( s / 60 ), hh = Math.floor( m / 60 );
        var two = function ( n ) { return ( n < 10 ? "0" : "" ) + n; };
        return ( hh ? hh + ":" + two( m % 60 ) : m ) + ":" + two( s % 60 );
    }
    C.callClock = clock;

    // ---------------------------------------------------------------------
    // the call bubble and its line in the list
    // ---------------------------------------------------------------------

    // [icon, words] for C.preview.
    C.callPreview = function ( m, conv )
    {
        var c = m.call || {};
        return [ c.video ? "video" : "phone", callWords( m, conv ) ];
    };

    // conv: the chat the bubble is in (the open one by default).
    function callWords( m, conv )
    {
        var c = m.call || {};
        var mine = m.from === C.me( conv );
        var kind = T( c.video ? "chat.videoCall" : "chat.voiceCall" );
        switch( c.end )
        {
            case "missed":   return mine ? kind + " · " + T( "chat.noAnswer" ) : T( c.video ? "chat.missedVideo" : "chat.missedVoice" );
            case "declined": return kind + " · " + T( "chat.declined" );
            case "busy":     return mine ? kind + " · " + T( "chat.busy" ) : T( c.video ? "chat.missedVideo" : "chat.missedVoice" );
            case "failed":   return kind + " · " + T( "chat.callFailed" );
        }
        return kind + " · " + clock( ( c.secs || 0 ) * 1000 );
    }

    C.callBody = function ( el, m, meta )
    {
        var c = m.call || {};
        var missed = m.from !== C.me() && ( c.end === "missed" || c.end === "busy" );
        if( missed ) el.classList.add( "missed" );
        var back = S.callsOn && S.open && S.open.indexOf( "d-" ) === 0
            ? C.btn( c.video ? "video" : "phone", "chat.callBack", function ( e ) { e.stopPropagation(); C.startCall( !! c.video ); }, "sm" )
            : null;
        el.appendChild( h( "div", { class: "call-line" },
            h( "span", { class: "call-ic" }, C.ic( c.video ? "video" : "phone" ) ),
            h( "span", { class: "call-words", text: callWords( m ) } ),
            back ) );
        el.appendChild( meta( m ) );
    };
} )();
