/*
 * call.js - voice and video calls: one to one (the owner and one person), and
 * a group's (up to four people - GROUP CALLS below).
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
 * The "small" button turns the layer into a box over the chat, dragged
 * anywhere; a tap on it brings the whole screen back.
 *
 * This page's id (S.dev) goes on every wait: signals are addressed to a page,
 * so the owner's second tab never reads the answer meant for the first one.
 *
 * GROUP CALLS: one connection to each other page in the call (a mesh). The
 * server says who is in it (c.in: participant + page); whoever JOINS makes an
 * offer to each page already in, so two offers never cross. Signals name the
 * page they are for (`to`) and come with the page they are from. A page that
 * drops out leaves only its own connection; the others talk on. The 1:1 code
 * above is left as it was - a group call takes its own branch at each step.
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
    // tz: this page's time zone - the others are offered "without sound" when
    // it is night here (compose.js nightAsk; the server's zonesFor).
    var myZone = "";
    try { myZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch( _ ) {}
    C.waitQuery = function ( w ) { return "&dev=" + S.dev + "&s=" + ( w || S ).sigSeen + ( myZone ? "&tz=" + encodeURIComponent( myZone ) : "" ); };

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
            else if( ! call && c.group && c.ring ) incoming( c, w );   // a group rings everybody not in it
        } );
        w.calls = list;
        // Gone from the server altogether (it restarted): nothing to wait for.
        // Only once it was seen there: a reply sent just before our call
        // existed would not list it yet.
        if( ours && call.known && ! seen && Array.isArray( r.calls ) && call.state !== "ended" ) finish( "lost" );

        ( r.sig || [] ).forEach( function ( g )
        {
            if( g.seq <= w.sigSeen ) return;
            w.sigSeen = g.seq;
            if( call && call.w === w && g.call === call.id ) onSig( g.data, g.from );
        } );
        C.renderCallBar();
    };

    // A change of the call as the server sees it.
    function update( c )
    {
        if( c.state === "ended" ) { finish( c.reason ); return; }
        if( call.group ) { groupUpdate( c ); return; }
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

    // The phone / video button of a chat (1:1 or a group).
    C.startCall = async function ( video )
    {
        var conv = S.open;
        if( call ) { if( call.el ) call.el.hidden = false; return; }
        if( ! conv || ( conv.indexOf( "d-" ) !== 0 && conv.indexOf( "g-" ) !== 0 ) ) return;
        var mine = call = newCall( { conv: conv, video: !! video, dir: "out", state: "calling", w: C.W( conv ), from: C.W( conv ).me } );
        show();
        // false also when it was hung up while the phone asked for the mic
        if( ! await getMedia() ) { if( ! gone( mine ) ) drop(); return; }
        try
        {
            var r = await C.api( "POST", "conv/" + conv + "/call", { video: !! video, dev: S.dev } );
            if( gone( mine ) )
            {
                // Hung up before the server answered: there was no id to end
                // then - end it now, or the other phone rings on (AA1).
                C.api( "POST", "call/" + r.id + "/end", {}, { base: mine.w.api } ).catch( function () {} );
                return;
            }
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
            if( call.group ) call.joined = true;   // in it from the start: the others' offers come
            tone( "back" );
            render();
        }
        catch( e )
        {
            if( gone( mine ) ) return;
            if( e.status === 409 && e.body && e.body.busy ) { finish( "busy" ); return; }   // chat_call.go: {"busy": true}
            drop();
            if( e.status === 409 ) C.toast( "chat.inCall", 2600 );
            else C.fail( e );
        }
    };

    function incoming( c, w )
    {
        call = newCall( { id: c.id, conv: c.conv, video: !! c.video, dir: "in", state: "incoming", w: w, from: c.from } );
        show();
        tone( "ring" );
    }

    C.answerCall = async function ()
    {
        if( ! call || call.state !== "incoming" ) return;
        var mine = call;
        tone( null );
        call.state = "connecting";
        render();
        // Answer FIRST, then the microphone: an iPhone asks for it every time,
        // and the other devices must stop ringing while it asks.
        try
        {
            var r = await C.api( "POST", "call/" + call.id + "/answer", { dev: S.dev }, { base: call.w.api } );
            if( gone( mine ) ) return;            // hung up meanwhile: its /end went with the id
            call.ice = r.ice;
            // joinedWith: who was in at the moment I came - mine to offer to.
            // The others (later) offer to me, so two offers never cross.
            if( call.group ) { call.inList = call.joinedWith = r.in || []; call.joined = true; }
        }
        catch( e )
        {
            if( gone( mine ) ) return;
            if( e.status === 409 ) { finish( e.body && e.body.full ? "full" : "elsewhere" ); return; }
            finish( "lost" );
            return;
        }
        if( ! call.local && ! await getMedia() ) { if( ! gone( mine ) ) hangUp( "fail" ); return; }
        if( gone( mine ) ) return;
        if( call.group ) { armConnect(); joinPeers(); return; }
        makePeer();
        armConnect();
        // The offer comes as a signal (onSig) - or it already came, while the
        // phone was still asking for the microphone.
        if( call.pendingOffer ) { var d = call.pendingOffer; call.pendingOffer = null; onSig( d ); }
    };

    C.declineCall = function () { hangUp(); };

    function newCall( o )
    {
        o.group = o.conv.indexOf( "g-" ) === 0;
        o.peer = o.group ? null : o.w.me === "o" ? o.conv.slice( 2 ) : "o";   // the other side of the 1:1 chat
        o.peers = {};                                                      // a group call: page -> connection
        o.inList = [];
        o.mic = true;
        o.cam = !! o.video;
        o.peerMic = true;
        o.peerCam = !! o.video;
        return o;
    }

    // ---------------------------------------------------------------------
    // the media
    // ---------------------------------------------------------------------

    // A call that ended (or was replaced) while we waited on something: what
    // comes back after an await must not start anything on it (AA1).
    function gone( mine ) { return call !== mine || mine.state === "ended"; }

    // The mic (and camera) for the call on screen. False when there is none -
    // or when that call ended while the phone asked: what it gave is stopped.
    async function getMedia()
    {
        var mine = call;
        var want = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
        if( mine.video ) want.video = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };
        // A group: the picture goes to up to three people - smaller.
        if( mine.video && mine.group ) want.video = { facingMode: "user", width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } };
        var local = null;
        try { local = await navigator.mediaDevices.getUserMedia( want ); }
        catch( e )
        {
            if( mine.video && e && e.name !== "NotAllowedError" && ! gone( mine ) )
            {
                // No camera (or it is busy): the call still works as voice.
                try
                {
                    local = await navigator.mediaDevices.getUserMedia( { audio: want.audio } );
                    mine.cam = false;
                }
                catch( _ ) {}
            }
            if( ! local && ! gone( mine ) )
            {
                C.toast( mine.video ? "chat.camBlocked" : "chat.micBlocked", 3600 );
                return false;
            }
        }
        if( gone( mine ) )
        {
            if( local ) local.getTracks().forEach( function ( t ) { t.stop(); } );
            return false;
        }
        call.local = local;
        call.facing = "user";
        if( call.el ) render();
        try
        {
            var devs = await navigator.mediaDevices.enumerateDevices();
            mine.cams = devs.filter( function ( d ) { return d.kind === "videoinput"; } ).length;
        }
        catch( _ ) { mine.cams = 0; }
        if( gone( mine ) ) return false;          // stopAll() stopped call.local
        if( call.el ) render();
        return true;
    }

    function makePeer()
    {
        var pc = call.pc = new RTCPeerConnection( iceCfg() );
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

    // The RTCPeerConnection settings: the call's STUN/TURN servers.
    function iceCfg()
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
        return cfg;
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

    async function onSig( d, from )
    {
        if( ! d || ! call ) return;
        if( call.group ) { groupSig( d, from ); return; }
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

    function sendState()
    {
        if( ! call ) return;
        if( call.group ) { Object.keys( call.peers ).forEach( function ( d ) { sendSigTo( d, stateSig() ); } ); return; }
        sendSig( stateSig() );
    }

    function stateSig() { return { t: "state", mic: call.mic, cam: call.cam }; }

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
        if( call && call.group ) { playTiles(); return; }
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
        var mine = call;
        var old = call.local.getVideoTracks()[ 0 ];
        var next = call.facing === "user" ? "environment" : "user";
        if( old ) old.stop();
        try
        {
            var s = await navigator.mediaDevices.getUserMedia( { video: { facingMode: next } } );
            if( gone( mine ) ) { s.getTracks().forEach( function ( t ) { t.stop(); } ); return; }   // ended meanwhile
            var track = s.getVideoTracks()[ 0 ];
            track.enabled = call.cam;
            if( old ) call.local.removeTrack( old );
            call.local.addTrack( track );
            // Every connection (a group call has one per page) sends the new one.
            var pcs = call.group ? Object.keys( call.peers ).map( function ( d ) { return call.peers[ d ].pc; } ) : [ call.pc ];
            for( var i = 0; i < pcs.length; i++ )
            {
                var sender = pcs[ i ] && pcs[ i ].getSenders().filter( function ( x ) { return x.track === old || ( x.track && x.track.kind === "video" ); } )[ 0 ];
                if( sender ) await sender.replaceTrack( track );
            }
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
        Object.keys( call.peers || {} ).forEach( function ( d )
        {
            clearTimeout( call.peers[ d ].failTimer );
            try { call.peers[ d ].pc.close(); } catch( _ ) {}
        } );
        if( call.local ) call.local.getTracks().forEach( function ( t ) { t.stop(); } );
        wakeLock( false );
    }

    // Close the screen and forget the call.
    function drop()
    {
        if( ! call ) return;
        if( call.state !== "ended" ) stopAll();
        tone( null );                             // whatever started after the end, too
        var el = call.el;
        call = null;
        atEar();
        if( el ) { el.remove(); C.popNav( isSmall( el ) ? "callguard" : "call" ); }
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
        // data-win-drag: in a desktop window this screen covers Chat's top row
        // (the window's title bar), so any empty spot of it drags the window.
        var el = call.el = h( "div", { class: "call-screen" + ( call.video ? " video" : "" ), attrs: { role: "dialog", "aria-modal": "true", "data-win-drag": "" } } );
        el.appendChild( h( "video", { class: "call-remote", attrs: { playsinline: "", autoplay: "" } } ) );
        el.appendChild( h( "div", { class: "call-grid" } ) );   // a group call's people
        el.appendChild( h( "audio", { attrs: { autoplay: "" } } ) );
        el.appendChild( h( "div", { class: "call-top" } ) );
        el.appendChild( pip() );
        el.appendChild( h( "button", { class: "text-btn call-hear", attrs: { type: "button", hidden: true }, text: T( "chat.tapToHear" ),
                                       on: { click: function () { this.hidden = true; attachRemote(); } } } ) );
        el.appendChild( h( "div", { class: "call-btns" } ) );
        document.body.appendChild( el );
        // Back must not end a call: the step is put back each time it is used.
        var stay = call.stay = function () { if( call && call.el === el && ! isSmall( el ) ) C.pushNav( "call", stay ); };
        C.pushNav( "call", stay );
        boxMoves( el );
        render();
    }

    // ---------------------------------------------------------------------
    // the small box: the call over the chat, which stays usable
    // ---------------------------------------------------------------------

    var BOX_KEY = "nayive.chat.callBox", GAP = 8;

    function isSmall( el ) { return el.classList.contains( "small" ); }

    function setSmall( on )
    {
        var el = call && call.el;
        if( ! el || isSmall( el ) === on ) return;
        el.classList.toggle( "small", on );
        // Big, it covers Chat's top row, so it drags the desktop window; small,
        // it drags itself. Back works in the chat while it is small.
        if( on )
        {
            el.removeAttribute( "data-win-drag" );
            el.setAttribute( "role", "button" );
            el.setAttribute( "tabindex", "0" );
            el.setAttribute( "title", T( "chat.openCall" ) );
            el.setAttribute( "aria-label", T( "chat.openCall" ) );
            el.removeAttribute( "aria-modal" );
            C.popNav( "call", guard );
        }
        else
        {
            el.setAttribute( "data-win-drag", "" );
            el.setAttribute( "role", "dialog" );
            el.setAttribute( "aria-modal", "true" );
            [ "tabindex", "title", "aria-label", "style" ].forEach( function ( a ) { el.removeAttribute( a ); } );
            C.popNav( "callguard", function () { if( call && call.el === el ) C.pushNav( "call", call.stay ); } );
        }
        render();
        if( on ) place( savedBox() );
    }

    // Small, Back works in the chat - but not past the list: leaving the page
    // would end the call. One last step stays under the list for that.
    function guard()
    {
        if( call && call.el && isSmall( call.el ) && ! C.navDepth() ) C.pushNav( "callguard", null );
    }
    window.addEventListener( "popstate", function () { setTimeout( guard, 0 ); } );

    function savedBox()
    {
        try { var b = JSON.parse( localStorage.getItem( BOX_KEY ) || "null" ); if( b && isFinite( b.x ) && isFinite( b.y ) ) return b; } catch( _ ) {}
        return { x: 1e6, y: 64 };     // top right, under Chat's top row
    }

    // Keep the box inside the page: the window may have been made smaller.
    function place( at )
    {
        var el = call && call.el;
        if( ! el || ! isSmall( el ) ) return;
        var x = Math.max( GAP, Math.min( at.x, innerWidth  - el.offsetWidth  - GAP ) );
        var y = Math.max( GAP, Math.min( at.y, innerHeight - el.offsetHeight - GAP ) );
        el.style.left = x + "px";
        el.style.top  = y + "px";
        return { x: x, y: y };
    }

    window.addEventListener( "resize", function () { if( call && call.el ) place( { x: call.el.offsetLeft, y: call.el.offsetTop } ); } );

    // Small: a drag moves it, a tap (or Enter) opens the whole screen again.
    function boxMoves( el )
    {
        // Its size changes with the call (connected, camera off): stay inside.
        if( window.ResizeObserver ) new ResizeObserver( function () { if( isSmall( el ) ) place( { x: el.offsetLeft, y: el.offsetTop } ); } ).observe( el );
        el.addEventListener( "pointerdown", function ( e )
        {
            if( ! isSmall( el ) || e.button !== 0 || e.target.closest( "button" ) ) return;
            e.stopPropagation();                  // not the desktop window's drag
            var x0 = e.clientX, y0 = e.clientY, left = el.offsetLeft, top = el.offsetTop, moved = false, at = null;
            el.setPointerCapture( e.pointerId );
            function move( ev )
            {
                if( ! moved && Math.abs( ev.clientX - x0 ) + Math.abs( ev.clientY - y0 ) < 4 ) return;
                moved = true;
                at = place( { x: left + ev.clientX - x0, y: top + ev.clientY - y0 } );
            }
            function up()
            {
                el.removeEventListener( "pointermove", move );
                el.removeEventListener( "pointerup", up );
                el.removeEventListener( "pointercancel", up );
                if( ! moved ) setSmall( false );
                else if( at ) try { localStorage.setItem( BOX_KEY, JSON.stringify( at ) ); } catch( _ ) {}
            }
            el.addEventListener( "pointermove", move );
            el.addEventListener( "pointerup", up );
            el.addEventListener( "pointercancel", up );
        } );
        el.addEventListener( "keydown", function ( e )
        {
            if( isSmall( el ) && e.target === el && ( e.key === "Enter" || e.key === " " ) ) { e.preventDefault(); setSmall( false ); }
        } );
    }

    // My own picture, small, in a corner of theirs. A triangle in each of its
    // corners moves it to that corner of the screen (the one it is in hides);
    // the choice is kept for the next call.
    var PIP_KEY = "nayive.chat.pip", CORNERS = { tl: "chat.pipTopLeft", tr: "chat.pipTopRight", bl: "chat.pipBottomLeft", br: "chat.pipBottomRight" };

    function pipCorner()
    {
        var c = "";
        try { c = localStorage.getItem( PIP_KEY ) || ""; } catch( _ ) {}
        return CORNERS[ c ] ? c : "br";
    }

    function pip()
    {
        var box = h( "div", { class: "call-pip at-" + pipCorner(), attrs: { "data-win-nodrag": "" } } );
        box.appendChild( h( "video", { class: "call-self", attrs: { playsinline: "", autoplay: "", muted: "" } } ) );
        Object.keys( CORNERS ).forEach( function ( c )
        {
            box.appendChild( h( "button", { class: "call-corner " + c, attrs: { type: "button", title: T( CORNERS[ c ] ), "aria-label": T( CORNERS[ c ] ) },
                                            on: { click: function () { box.className = "call-pip at-" + c; try { localStorage.setItem( PIP_KEY, c ); } catch( _ ) {} } } } ) );
        } );
        return box;
    }

    function render()
    {
        if( ! call || ! call.el ) return;
        atEar();
        var el = call.el;
        var name = call.group ? groupName() : C.nameOf( call.peer, call.conv );
        el.classList.toggle( "video", !! call.video );
        el.classList.toggle( "live", call.state === "talking" || call.state === "reconnecting" );
        // A group: the tiles carry the pictures, the 1:1 full-screen one never shows.
        el.classList.toggle( "group", !! call.group );
        el.classList.toggle( "peer-cam-off", !! call.group || ! call.peerCam );

        var top = el.querySelector( ".call-top" );
        top.textContent = "";
        top.appendChild( C.avatar( call.conv, name, "xl" ) );
        top.appendChild( h( "b", { text: name } ) );
        top.appendChild( h( "small", { class: "call-state", text: stateWords() } ) );
        if( ! call.group && ! call.peerMic && call.state === "talking" )
            top.appendChild( h( "small", { class: "call-note" }, C.ic( "mic-off" ), T( "chat.peerMuted" ) ) );
        if( call.group ) renderTiles( el );

        var self = el.querySelector( ".call-self" );
        self.muted = true;
        if( call.local && call.video && self.srcObject !== call.local ) { self.srcObject = call.local; self.play().catch( function () {} ); }
        self.parentNode.hidden = ! ( call.video && call.local && call.cam );
        self.classList.toggle( "mirror", call.facing !== "environment" );

        // Small: only the red and green buttons, at the normal size.
        var small = isSmall( el ), lg = small ? "" : "lg";
        var btns = el.querySelector( ".call-btns" );
        btns.textContent = "";
        if( call.state === "ended" ) return;
        if( ! small ) btns.appendChild( C.btn( "minimize", "chat.shrinkCall", function () { setSmall( true ); }, "lg" ) );
        if( call.state === "incoming" )
        {
            btns.appendChild( C.btn( "phone-off", "chat.decline", C.declineCall, lg + " solid-danger" ) );
            btns.appendChild( C.btn( call.video ? "video" : "phone", "chat.answer", C.answerCall, lg + " solid-ok" ) );
            return;
        }
        if( small )
        {
            // The way back to the whole screen first (a tap on the box does it too).
            btns.appendChild( C.btn( "maximize", "chat.growCall", function () { setSmall( false ); } ) );
            btns.appendChild( C.btn( "phone-off", "chat.hangUp", function () { hangUp(); }, "solid-danger" ) );
            return;
        }
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

    // A voice call may be at the ear: the phone's sensor, or a padlock (ear.js).
    function atEar()
    {
        var on = !! call && ! call.video && /^(calling|connecting|talking|reconnecting)$/.test( call.state );
        if( C.ear ) C.ear( on, on && call.el && ! isSmall( call.el ) );
    }

    function stateWords()
    {
        switch( call.state )
        {
            case "calling":      return call.group ? T( "chat.callingGroup" ) : T( call.w.online.has( call.peer ) ? "chat.ringing" : "chat.calling" );
            case "incoming":
                var kind = T( call.video ? "chat.incomingVideo" : "chat.incomingVoice" );
                return call.group && call.from ? C.nameOf( call.from, call.conv ) + " · " + kind : kind;
            case "connecting":   return T( "chat.connecting" );
            case "reconnecting": return T( "chat.reconnecting" );
            case "talking":      return clock( Date.now() - call.since ) + ( call.group ? " · " + C.TF( "chat.nInCall", { n: call.inList.length } ) : "" );
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
            case "full":      return T( "chat.callFull" );
        }
        return T( "chat.callEnded" );
    }

    function renderTime()
    {
        if( ! call || ! call.el || call.state !== "talking" ) return;
        var s = call.el.querySelector( ".call-state" );
        if( s ) s.textContent = stateWords();
    }

    function clock( ms )
    {
        var s = Math.max( 0, Math.floor( ms / 1000 ) );
        var m = Math.floor( s / 60 ), hh = Math.floor( m / 60 );
        var two = function ( n ) { return ( n < 10 ? "0" : "" ) + n; };
        return ( hh ? hh + ":" + two( m % 60 ) : m ) + ":" + two( s % 60 );
    }

    // ---------------------------------------------------------------------
    // GROUP CALLS: one connection to each other page (a mesh, at most four)
    // ---------------------------------------------------------------------

    function groupName()
    {
        var c = C.convOf( call.conv );
        return c ? c.name : "";
    }

    // The participant on page `dev` (the server's list of who is in).
    function pidOf( dev )
    {
        var x = call.inList.filter( function ( i ) { return i.dev === dev; } )[ 0 ];
        return x ? x.pid : "";
    }

    // The server's view of the group call changed: who is in it.
    function groupUpdate( c )
    {
        call.inList = c.in || [];
        if( c.from ) call.from = c.from;
        if( call.state === "incoming" )
        {
            // Another page of mine went in; or the ringing time is over.
            if( call.inList.some( function ( i ) { return i.pid === call.w.me; } ) ) { finish( "elsewhere" ); return; }
            if( ! c.ring ) { finish( "noanswer" ); return; }
            render();
            return;
        }
        if( ! call.joined ) return;               // the server has not answered us yet
        if( ! call.inList.some( function ( i ) { return i.dev === S.dev; } ) ) { finish( "lost" ); return; }
        if( call.state === "calling" && call.inList.length > 1 )
        {
            // Somebody came: their offer is on its way.
            tone( null );
            call.state = "connecting";
            armConnect();
        }
        Object.keys( call.peers ).forEach( function ( dev ) { if( ! pidOf( dev ) ) closePeer( dev ); } );   // gone from the call
        render();
    }

    // Just joined: an offer to each page that was in when I came. Not
    // call.inList: a wait read while the phone asked for the microphone may
    // already list someone who came after me - they offer to me.
    function joinPeers()
    {
        ( call.joinedWith || [] ).forEach( function ( i ) { if( i.dev !== S.dev ) groupOffer( makeGroupPeer( i.dev, i.pid ), false ); } );
        ( call.pendingOffers || [] ).splice( 0 ).forEach( function ( q ) { groupSig( q[ 0 ], q[ 1 ] ); } );
        render();
    }

    // A fresh connection to page `dev`. `gen` counts the fresh ones: an offer
    // with a new number replaces the connection on the other side too.
    function makeGroupPeer( dev, pid, gen )
    {
        var old = call.peers[ dev ];
        closePeer( dev );
        var mine = call;
        var p = { dev: dev, pid: pid, mic: true, cam: !! call.video, remote: null, tile: null,
                  gen: gen || ( old ? old.gen + 1 : 1 ) };
        var pc = p.pc = new RTCPeerConnection( iceCfg() );
        call.local.getTracks().forEach( function ( t ) { pc.addTrack( t, call.local ); } );
        pc.ontrack = function ( e )
        {
            if( call !== mine || call.peers[ dev ] !== p ) return;
            p.remote = e.streams[ 0 ] || new MediaStream( [ e.track ] );
            render();
        };
        pc.onconnectionstatechange = function () { if( call === mine && call.peers[ dev ] === p ) groupConn( p ); };
        call.peers[ dev ] = p;
        return p;
    }

    function closePeer( dev )
    {
        var p = call && call.peers[ dev ];
        if( ! p ) return;
        clearTimeout( p.failTimer );
        try { p.pc.close(); } catch( _ ) {}
        delete call.peers[ dev ];
        if( p.tile ) p.tile.remove();
    }

    // Each picture goes to up to three people: kept small (~300 kbit/s, 15 fps).
    function capVideo( pc )
    {
        pc.getSenders().forEach( function ( s )
        {
            if( ! s.track || s.track.kind !== "video" || ! s.getParameters ) return;
            var prm = s.getParameters();
            if( ! prm.encodings || ! prm.encodings.length ) return;
            prm.encodings[ 0 ].maxBitrate = 300000;
            prm.encodings[ 0 ].maxFramerate = 15;
            s.setParameters( prm ).catch( function () {} );
        } );
    }

    async function groupOffer( p, restart )
    {
        var mine = call;
        p.offerer = true;
        try
        {
            // A video call where I have no camera: their picture must still come.
            if( ! restart && call.video && ! call.local.getVideoTracks().length ) p.pc.addTransceiver( "video", { direction: "recvonly" } );
            await p.pc.setLocalDescription( await p.pc.createOffer( restart ? { iceRestart: true } : undefined ) );
            capVideo( p.pc );
            await gathered( p.pc );
            if( call === mine && call.peers[ p.dev ] === p ) sendSigTo( p.dev, { t: "offer", sdp: p.pc.localDescription.sdp, gen: p.gen } );
        }
        catch( e ) { if( call === mine && call.peers[ p.dev ] === p ) closePeer( p.dev ); }
    }

    async function groupSig( d, from )
    {
        if( ! from || ! call ) return;
        // An offer while the phone still asks for the microphone: kept for joinPeers.
        if( d.t === "offer" && ! call.local ) { ( call.pendingOffers = call.pendingOffers || [] ).push( [ d, from ] ); return; }
        var mine = call;
        var p = call.peers[ from ];
        try
        {
            if( d.t === "offer" )
            {
                // Both offered at once (should not happen - joinPeers): the
                // lower page id keeps its offer, the other answers it.
                if( p && p.offerer && p.pc.signalingState === "have-local-offer" )
                {
                    if( S.dev < from ) return;
                    p = makeGroupPeer( from, pidOf( from ), d.gen );
                }
                // A page that just came, or one starting over (a new gen);
                // the same gen is an ICE restart on the connection we have.
                if( ! p || p.gen !== d.gen ) p = makeGroupPeer( from, pidOf( from ), d.gen );
                await p.pc.setRemoteDescription( { type: "offer", sdp: d.sdp } );
                await p.pc.setLocalDescription( await p.pc.createAnswer() );
                capVideo( p.pc );
                await gathered( p.pc );
                if( call !== mine || call.peers[ from ] !== p ) return;
                sendSigTo( from, { t: "answer", sdp: p.pc.localDescription.sdp } );
                sendSigTo( from, stateSig() );
                render();
            }
            else if( d.t === "answer" && p && p.offerer )
            {
                await p.pc.setRemoteDescription( { type: "answer", sdp: d.sdp } );
                sendSigTo( from, stateSig() );
            }
            else if( d.t === "state" && p )
            {
                p.mic = d.mic !== false;
                p.cam = d.cam !== false;
                render();
            }
        }
        catch( e ) { if( call === mine && call.peers[ from ] === p ) closePeer( from ); render(); }
    }

    function sendSigTo( dev, data )
    {
        if( ! call || ! call.id ) return;
        C.api( "POST", "call/" + call.id + "/sig", { dev: S.dev, to: dev, data: data }, { base: call.w.api } ).catch( function () {} );
    }

    // One connection's state. Down: the side that offered offers again (an
    // ICE restart), and starts over with a fresh connection if that does not
    // bring it back. The rest of the call talks on meanwhile.
    function groupConn( p )
    {
        var st = p.pc.connectionState;
        if( st === "connected" )
        {
            clearTimeout( p.failTimer );
            p.failTimer = null;
            clearTimeout( call.connectTimer );
            if( ! call.since ) call.since = Date.now();
            if( call.state !== "talking" ) { call.state = "talking"; tone( null ); wakeLock( true ); }
            if( ! call.tick ) call.tick = setInterval( renderTime, 1000 );
            render();
            return;
        }
        if( st !== "disconnected" && st !== "failed" ) return;
        var dev = p.dev;
        var still = function () { return call && call.peers[ dev ] === p && p.pc.connectionState !== "connected"; };
        if( p.offerer && ! p.restarting )
        {
            p.restarting = true;
            setTimeout( function () { p.restarting = false; if( still() ) groupOffer( p, true ); }, st === "failed" ? 0 : RESTART_AFTER );
        }
        if( ! p.failTimer ) p.failTimer = setTimeout( function ()
        {
            p.failTimer = null;
            if( ! still() ) return;
            if( p.offerer && pidOf( dev ) ) groupOffer( makeGroupPeer( dev, p.pid ), false );
        }, FAIL_AFTER );
        render();
    }

    // A tile for each of the others: their picture, or their circle.
    function renderTiles( el )
    {
        var grid = el.querySelector( ".call-grid" );
        var devs = Object.keys( call.peers );
        grid.dataset.n = String( devs.length );
        devs.forEach( function ( dev )
        {
            var p = call.peers[ dev ];
            p.pid = p.pid || pidOf( dev );
            if( ! p.tile )
            {
                p.tile = h( "div", { class: "call-tile" },
                            h( "video", { attrs: { playsinline: "", autoplay: "" } } ),
                            h( "span", { class: "call-tile-av" } ),
                            h( "span", { class: "call-tile-name" } ) );
                grid.appendChild( p.tile );
            }
            var media = p.tile.querySelector( "video" );
            if( p.remote && media.srcObject !== p.remote )
            {
                media.srcObject = p.remote;
                playOne( media );
            }
            var pic = call.video && p.cam && p.remote && p.remote.getVideoTracks().length > 0;
            p.tile.classList.toggle( "cam-off", ! pic );
            p.tile.classList.toggle( "waiting", p.pc.connectionState !== "connected" );
            var name = C.nameOf( p.pid, call.conv );
            var av = p.tile.querySelector( ".call-tile-av" );
            if( av.dataset.pid !== p.pid ) { av.textContent = ""; av.appendChild( C.avatar( p.pid, name, "xl", call.conv ) ); av.dataset.pid = p.pid; }
            var nm = p.tile.querySelector( ".call-tile-name" );
            nm.textContent = "";
            if( ! p.mic ) nm.appendChild( C.ic( "mic-off" ) );
            nm.appendChild( document.createTextNode( name ) );
        } );
    }

    function playOne( media )
    {
        var pr = media.play();
        if( pr && pr.catch ) pr.catch( function () { if( call && call.el ) call.el.querySelector( ".call-hear" ).hidden = false; } );
    }

    function playTiles()
    {
        if( ! call || ! call.el ) return;
        [].forEach.call( call.el.querySelectorAll( ".call-tile video" ), playOne );
    }

    // A group call on in the open chat that this page is not in: a bar over
    // the messages, with "Join" while there is room.
    C.renderCallBar = function ()
    {
        var conv = S.open, host = C.$( "#vConv" ), wall = C.$( "#wall" );
        var bar = C.$( "#callBar" );
        var w = conv ? C.W( conv ) : null;
        var c = w && ( w.calls || [] ).filter( function ( x ) { return x.group && x.conv === conv && x.state !== "ended" && ! x.mine; } )[ 0 ];
        if( ! c || ! host || ! wall || ( call && call.id === c.id ) ) { if( bar ) bar.remove(); return; }
        var n = ( c.in || [] ).length;
        if( ! bar ) { bar = h( "div", { class: "call-bar", attrs: { id: "callBar" } } ); host.insertBefore( bar, wall ); }
        bar.textContent = "";
        bar.appendChild( C.ic( c.video ? "video" : "phone" ) );
        bar.appendChild( h( "span", { text: C.TF( "chat.groupCallOn", { n: n, max: 4 } ) } ) );
        if( ! call && n < 4 )
            bar.appendChild( h( "button", { class: "pill is-active", attrs: { type: "button" }, text: T( "chat.join" ),
                                            on: { click: function () { joinFromBar( c, w ); } } } ) );
    };

    function joinFromBar( c, w )
    {
        if( call ) return;
        call = newCall( { id: c.id, conv: c.conv, video: !! c.video, dir: "in", state: "incoming", w: w, from: c.from } );
        call.inList = c.in || [];
        show();
        C.answerCall();
    }

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
        return kind + " · " + clock( ( c.secs || 0 ) * 1000 ) + ( c.n ? " · " + C.TF( "chat.nPeople", { n: c.n } ) : "" );
    }

    C.callBody = function ( el, m, meta )
    {
        var c = m.call || {};
        var missed = m.from !== C.me() && ( c.end === "missed" || c.end === "busy" );
        if( missed ) el.classList.add( "missed" );
        var back = S.callsOn && S.open && ( S.open.indexOf( "d-" ) === 0 || S.open.indexOf( "g-" ) === 0 )
            ? C.btn( c.video ? "video" : "phone", "chat.callBack", function ( e ) { e.stopPropagation(); C.startCall( !! c.video ); }, "sm" )
            : null;
        el.appendChild( h( "div", { class: "call-line" },
            h( "span", { class: "call-ic" }, C.ic( c.video ? "video" : "phone" ) ),
            h( "span", { class: "call-words", text: callWords( m ) } ),
            back ) );
        el.appendChild( meta( m ) );
    };
} )();
