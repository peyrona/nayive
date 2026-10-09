/*
 * watch.js - "Play for everyone": a YouTube video that plays at the same
 * moment on every page with that chat open - a virtual karaoke. See core.js
 * for how the chat/*.js files fit together; the server side is
 * server/go/chat_watch.go.
 *
 * Whoever sent a message with a YouTube link gets "Play for everyone" under
 * it. That page then DRIVES: its player has YouTube's own controls, and each
 * play, pause or jump goes to the server (POST conv/<c>/watch). Every wait
 * carries what plays where ({video, playing, pos, at}) and the server's clock
 * ("now"); every other page FOLLOWS: it works out where the video is now and
 * keeps its player within ~0.4 s of it.
 *
 * To sing together: a call (call.js), made small, with headphones - the
 * video's sound would otherwise reach the other side through the microphone.
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h, T = C.T;

    var OFF_BY = 0.4;          // s the follower may drift before it jumps
    var TICK   = 2000;         // ms between the follower's checks
    var BLOCKED_AFTER = 1500;  // ms: a play that has not started was refused (autoplay)

    // ---------------------------------------------------------------------
    // a YouTube link -> its video id
    // ---------------------------------------------------------------------

    var ID_RE = /^[A-Za-z0-9_-]{11}$/;

    // youtube.com/watch?v=ID, youtu.be/ID, /shorts/ID, /live/ID, /embed/ID,
    // music.youtube.com, m.youtube.com... null for anything else.
    C.ytId = function ( url )
    {
        var u;
        try { u = new URL( url ); } catch( _ ) { return null; }
        var host = u.hostname.toLowerCase().replace( /^(www|m|music)\./, "" );
        var id = null;
        if( host === "youtu.be" ) id = u.pathname.split( "/" )[ 1 ];
        else if( host === "youtube.com" || host === "youtube-nocookie.com" )
        {
            var p = u.pathname.split( "/" );
            if( p[ 1 ] === "watch" ) id = u.searchParams.get( "v" );
            else if( [ "shorts", "live", "embed", "v" ].indexOf( p[ 1 ] ) >= 0 ) id = p[ 2 ];
        }
        return id && ID_RE.test( id ) ? id : null;
    };

    // The first YouTube video in a text, or null.
    C.ytIn = function ( text )
    {
        var re = /https?:\/\/[^\s<>"]+/g, m;
        while( ( m = re.exec( text || "" ) ) )
        {
            var id = C.ytId( m[ 0 ].replace( /[).,;:!?]+$/, "" ) );
            if( id ) return id;
        }
        return null;
    };

    // ---------------------------------------------------------------------
    // the server's clock
    // ---------------------------------------------------------------------

    // Each wait says the server's time as it answered. The reply took a
    // little to arrive, so a sample is a bit LOW: the highest of the last few
    // is the closest one.
    var offsets = [];
    function clockSample( now )
    {
        if( typeof now !== "number" ) return;
        offsets.push( now - Date.now() );
        if( offsets.length > 5 ) offsets.shift();
    }
    function serverNow() { return Date.now() + ( offsets.length ? Math.max.apply( null, offsets ) : 0 ); }

    // Where the video is now, in seconds.
    function target( cw ) { return cw.playing ? cw.pos + Math.max( 0, serverNow() - cw.at ) / 1000 : cw.pos; }

    // ---------------------------------------------------------------------
    // what the server says
    // ---------------------------------------------------------------------

    // Every wait (list.js onWait). True when what plays in this world moved -
    // the list then redraws (its ♪ marks).
    C.onWatch = function ( r, w )
    {
        clockSample( r.now );
        var before = JSON.stringify( w.watch || {} );
        w.watch = r.watch || {};
        var moved = before !== JSON.stringify( w.watch );
        if( moved || ( S.open && C.W( S.open ) === w ) ) C.syncWatch();
        return moved;
    };

    // The video playing in a chat, or null.
    C.watchOf = function ( conv )
    {
        var w = C.W( conv );
        return ( w.watch && w.watch[ conv ] ) || null;
    };

    // ---------------------------------------------------------------------
    // the player
    // ---------------------------------------------------------------------

    var pane = null;       // the box over the messages
    var cur  = null;       // { conv, msg, video, player, ready, driving, mine }
    var hidden = {};       // conv -> "msg:video" the person closed (comes back on "Watch")
    var timer = 0;
    var blockedTimer = 0;
    var apiReady = null;

    // YouTube's IFrame API, loaded on first use.
    function loadApi()
    {
        if( apiReady ) return apiReady;
        apiReady = new Promise( function ( ok, fail )
        {
            if( window.YT && window.YT.Player ) { ok(); return; }
            var prev = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = function () { if( prev ) prev(); ok(); };
            var s = document.createElement( "script" );
            s.src = "https://www.youtube.com/iframe_api";
            s.onerror = function () { apiReady = null; fail( new Error( "youtube" ) ); };
            document.head.appendChild( s );
        } );
        return apiReady;
    }

    function buildPane()
    {
        if( pane ) return pane;
        pane = h( "div", { class: "watch-pane", attrs: { id: "watchPane", hidden: true } },
                  h( "div", { class: "watch-bar" },
                      C.ic( "music" ), h( "span", { class: "watch-title", text: T( "chat.watchTitle" ) } ),
                      h( "div", { class: "watch-acts" } ) ),
                  h( "div", { class: "watch-frame" }, h( "div", { class: "watch-yt" } ),
                      h( "div", { class: "watch-tap", attrs: { hidden: true } }, C.ic( "play" ), h( "span", { text: T( "chat.watchTap" ) } ) ) ) );
        var conv = C.$( "#vConv" ), wall = C.$( "#wall" );
        conv.insertBefore( pane, wall );
        return pane;
    }

    function close()
    {
        clearInterval( timer ); timer = 0;
        clearTimeout( blockedTimer ); blockedTimer = 0;
        if( cur && cur.player ) { try { cur.player.destroy(); } catch( _ ) {} }
        cur = null;
        if( pane )
        {
            // YouTube swapped its box for an iframe: a fresh box for the next one
            var frame = C.$( ".watch-frame", pane );
            [].forEach.call( frame.querySelectorAll( "iframe, .watch-yt" ), function ( el ) { el.remove(); } );
            frame.prepend( h( "div", { class: "watch-yt" } ) );
            C.$( ".watch-tap", pane ).hidden = true;
            pane.hidden = true;
        }
    }

    // The bar's buttons: the driver stops it for everyone; the others mute
    // their own and close it on their own page.
    function renderActs()
    {
        var acts = C.$( ".watch-acts", pane );
        acts.textContent = "";
        if( ! cur ) return;
        if( cur.mine ) acts.appendChild( C.btn( "stop", "chat.watchStop", function () { stop( cur.conv ); } ) );
        else
        {
            var muted = cur.ready && cur.player.isMuted();
            acts.appendChild( C.btn( muted ? "volume-x" : "volume", muted ? "chat.watchUnmute" : "chat.watchMute", function ()
            {
                if( ! cur || ! cur.ready ) return;
                if( cur.player.isMuted() ) cur.player.unMute(); else cur.player.mute();
                renderActs();
            } ) );
            acts.appendChild( C.btn( "x", "chat.watchClose", function ()
            {
                var cw = cur && C.watchOf( cur.conv );
                if( cw ) hidden[ cur.conv ] = cw.msg + ":" + cw.video;
                close();
                markRows();
            } ) );
        }
    }

    // Make the open chat's pane match the server: start, follow, or close.
    C.syncWatch = function ()
    {
        markRows();
        var conv = S.open;
        var cw = conv ? C.watchOf( conv ) : null;
        if( cw && hidden[ conv ] === cw.msg + ":" + cw.video ) cw = null;
        if( ! cw ) { if( cur ) close(); return; }
        if( hidden[ conv ] ) delete hidden[ conv ];
        var mine = cw.by === C.me( conv );
        if( cur && ( cur.conv !== conv || cur.video !== cw.video || cur.msg !== cw.msg ) ) close();
        if( ! cur ) { start( conv, cw, mine, false ); return; }
        if( cur.mine !== mine ) { cur.mine = mine; renderActs(); }
        if( ! cur.driving ) follow();
    };

    // driving: this page pressed "Play for everyone" - its player tells the
    // server. Another page of the same person follows like everybody else.
    function start( conv, cw, mine, driving )
    {
        buildPane();
        cur = { conv: conv, msg: cw.msg, video: cw.video, player: null, ready: false, driving: driving, mine: mine,
                sent: { playing: cw.playing, pos: cw.pos, at: Date.now() } };
        var me = cur;
        pane.hidden = false;
        renderActs();
        loadApi().then( function ()
        {
            if( cur !== me ) return;
            me.player = new YT.Player( C.$( ".watch-yt", pane ), {
                host: "https://www.youtube-nocookie.com",
                videoId: cw.video,
                playerVars: { controls: driving ? 1 : 0, disablekb: driving ? 0 : 1, playsinline: 1, rel: 0,
                              start: Math.floor( target( cw ) ), origin: location.origin },
                events: {
                    onReady: function ()
                    {
                        if( cur !== me ) return;
                        me.ready = true;
                        renderActs();
                        if( me.driving ) { me.player.playVideo(); return; }
                        follow();
                        clearInterval( timer );
                        timer = setInterval( function () { if( cur === me && ! me.driving ) follow(); else if( cur === me ) driveCheck(); }, TICK );
                    },
                    onStateChange: function ( e ) { if( cur === me ) stateChanged( e.data ); },
                    onError: function () { if( cur === me ) C.toast( "chat.watchCannot", 4000 ); }
                }
            } );
            if( driving )
            {
                clearInterval( timer );
                timer = setInterval( function () { if( cur === me && me.driving ) driveCheck(); else if( cur === me ) follow(); }, TICK );
            }
        } ).catch( function () { if( cur === me ) { C.toast( "chat.watchCannot", 4000 ); close(); } } );
    }

    // ---------------------------------------------------------------------
    // following
    // ---------------------------------------------------------------------

    function follow()
    {
        if( ! cur || ! cur.ready ) return;
        var cw = C.watchOf( cur.conv );
        if( ! cw ) return;
        var p = cur.player, at = target( cw );
        var state = p.getPlayerState();
        var off = Math.abs( ( p.getCurrentTime() || 0 ) - at );
        if( cw.playing )
        {
            if( off > OFF_BY ) p.seekTo( at, true );
            if( state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING )
            {
                p.playVideo();
                armBlocked();
            }
        }
        else
        {
            if( state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING ) p.pauseVideo();
            if( off > OFF_BY ) p.seekTo( at, true );
        }
    }

    // A browser may refuse to start a video with sound that nobody tapped
    // (iPhones always do): then a tap on the video itself starts it, and the
    // next check puts it in step.
    function armBlocked()
    {
        if( blockedTimer ) return;
        var me = cur;
        blockedTimer = setTimeout( function ()
        {
            blockedTimer = 0;
            if( cur !== me || ! me.ready ) return;
            var st = me.player.getPlayerState();
            if( st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING ) C.$( ".watch-tap", pane ).hidden = false;
        }, BLOCKED_AFTER );
    }

    // ---------------------------------------------------------------------
    // driving
    // ---------------------------------------------------------------------

    function stateChanged( st )
    {
        if( st === YT.PlayerState.PLAYING ) C.$( ".watch-tap", pane ).hidden = true;
        if( ! cur.driving )
        {
            if( st === YT.PlayerState.PLAYING ) follow();   // started by a tap: into step
            return;
        }
        if( st === YT.PlayerState.PLAYING ) send( "play" );
        else if( st === YT.PlayerState.PAUSED ) send( "pause" );
        else if( st === YT.PlayerState.ENDED ) stop( cur.conv );   // the song is over: off for everyone
    }

    // A jump while playing fires no event of its own: compare where the video
    // is with where the last word sent says it should be.
    function driveCheck()
    {
        if( ! cur || ! cur.ready || ! cur.driving ) return;
        var s = cur.sent, now = cur.player.getCurrentTime() || 0;
        var should = s.playing ? s.pos + ( Date.now() - s.at ) / 1000 : s.pos;
        if( Math.abs( now - should ) > 1 ) send( s.playing ? "play" : "pause" );
    }

    async function send( state )
    {
        var me = cur;
        var pos = me.ready ? me.player.getCurrentTime() || 0 : 0;
        me.sent = { playing: state === "play", pos: pos, at: Date.now() };
        try { await C.api( "POST", "conv/" + me.conv + "/watch", { msg: me.msg, video: me.video, state: state, pos: pos } ); }
        catch( e ) { if( cur === me ) { me.driving = false; failed( e ); } }
    }

    function failed( e )
    {
        if( e && e.status === 409 ) C.toast( "chat.watchBusy", 3000 );
        else C.fail( e );
    }

    // "Play for everyone" under my message. Already playing (this page just
    // came back, say): this page takes the wheel where the video is now.
    async function playForAll( m, video )
    {
        var conv = S.open;
        var cw = C.watchOf( conv );
        var pos = cw && cw.msg === m.id && cw.video === video ? target( cw ) : 0;
        delete hidden[ conv ];
        try { await C.api( "POST", "conv/" + conv + "/watch", { msg: m.id, video: video, state: "play", pos: pos } ); }
        catch( e ) { failed( e ); return; }
        if( S.open !== conv ) return;
        if( cur ) close();
        start( conv, { msg: m.id, video: video, playing: true, pos: pos, at: serverNow() }, true, true );
    }

    async function stop( conv )
    {
        try { await C.api( "POST", "conv/" + conv + "/watch", { state: "stop" } ); }
        catch( e ) { C.fail( e ); return; }
        if( cur && cur.conv === conv ) close();
        markRows();
    }

    // ---------------------------------------------------------------------
    // the row under a message with a YouTube link
    // ---------------------------------------------------------------------

    // conv.js, while it draws a text bubble.
    C.watchRow = function ( el, m )
    {
        if( m.id < 0 ) return;
        var video = C.ytIn( m.text );
        if( ! video ) return;
        var row = h( "div", { class: "watch-row", data: { msg: String( m.id ), video: video } } );
        row.addEventListener( "click", function ( e ) { e.stopPropagation(); } );
        el.appendChild( row );
        fillRow( row, m );
    };

    function fillRow( row, m )
    {
        var conv = S.open;
        var video = row.dataset.video;
        var cw = C.watchOf( conv );
        var live = !! cw && cw.msg === m.id && cw.video === video;
        var mine = m.from === C.me( conv );
        row.textContent = "";
        if( mine && live && cw.by === C.me( conv ) )
            row.appendChild( pill( "stop", "chat.watchStop", function () { stop( conv ); } ) );
        else if( mine && ! cw )
        {
            row.appendChild( pill( "play", "chat.watchPlay", function () { playForAll( m, video ); } ) );
            row.appendChild( C.btn( "help", "chat.watchHow", showHow, "sm" ) );   // the steps, before pressing it
        }
        else if( live && ( ! cur || cur.conv !== conv ) )
            row.appendChild( pill( "play", "chat.watchJoin", function () { delete hidden[ conv ]; C.syncWatch(); } ) );
        row.hidden = ! row.firstChild;
    }

    // The (?) beside "Play for everyone": how to set the karaoke up.
    function showHow()
    {
        NayiveUI.alert( { title: T( "chat.watchHow" ), body: T( "chat.watchHowSteps" ) } );
    }

    function pill( icon, key, fn )
    {
        return h( "button", { class: "pill is-active watch-btn", attrs: { type: "button" }, on: { click: fn } }, C.ic( icon ), T( key ) );
    }

    // Every row of the open chat, after a change.
    function markRows()
    {
        if( ! S.open || ! S.msgs ) return;
        [].forEach.call( document.querySelectorAll( "#wall .watch-row" ), function ( row )
        {
            var m = S.msgs.get( Number( row.dataset.msg ) );
            if( m ) fillRow( row, m );
        } );
    }
} )();
