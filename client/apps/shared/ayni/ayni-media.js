/* Ayni library 0.2.0, media: what a player and a library view share. Ayni.media.wirePlayer(el, hooks) (a seek slider #seekRange, #elapsedLabel,
   #totalLabel, #volumeRange), setPlayIcon(playing) (#playBtn, #playIcon), mediaSession(meta, handlers), positionState(el), probeDuration(kind, url),
   scopeBarHtml(label, clearTitle), ICONS. Plain JavaScript, no build step, evergreen browsers 2024+. Optional, with ayni-media.css. */
( function ()
{
    "use strict";

    var esc = Ayni.esc;

    // DURATION PROBE - a throwaway <audio> / <video> with preload=metadata.
    // Cheap: the server supports Range, so the browser only pulls the header.
    // Resolves with the length in seconds, or null - after PROBE_MS at most: a
    // file that stalls (neither metadata nor an error) must not hold its place
    // in the scan pool for ever.
    var PROBE_MS = 15000;

    function probeDuration( kind, url )
    {
        return new Promise( function ( resolve )
        {
            var probe = document.createElement( kind === "video" ? "video" : "audio" );
            var done = false;
            function finish( d )
            {
                if( done ) return;
                done = true;
                // load() with no src lets the player go: past Chrome's ~1000
                // live media players every new <audio> fails, not only <video>.
                probe.removeAttribute( "src" );
                probe.load();
                resolve( isFinite( d ) && d > 0 ? d : null );
            }
            probe.addEventListener( "loadedmetadata", function () { finish( probe.duration ); } );
            probe.addEventListener( "error", function () { finish( null ); } );
            setTimeout( function () { finish( null ); }, PROBE_MS );
            probe.preload = "metadata";
            probe.muted   = true;
            probe.src     = url;
        } );
    }

    var ICONS = {
        folder: Ayni.icon( 'folder-plain' ),
        x:      Ayni.icon( 'x-thin' )
    };

    // The "filtered by X" strip with its clear button (#clearScopeBtn).
    function scopeBarHtml( label, clearTitle )
    {
        var t = esc( clearTitle || Ayni.t( 'ayni.media.clearFilter' ) );
        return '<div class="scope-bar"><span class="scope-chip">' + esc( label ) +
            '<button id="clearScopeBtn" data-tip="' + t + '" aria-label="' + t + '">' + ICONS.x + '</button></span></div>';
    }

    // PLAYER BITS

    // The transport button (#playBtn / #playIcon): pause glyph while playing.
    function setPlayIcon( playing )
    {
        var btn = document.getElementById( "playBtn" ), ico = document.getElementById( "playIcon" );
        if( ! btn || ! ico ) return;
        Ayni.setTip( btn, playing ? Ayni.t( 'ayni.media.pause' ) : Ayni.t( 'ayni.media.play' ) );
        btn.setAttribute( "aria-label", btn.dataset.tip );
        ico.outerHTML = playing
            ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" id="playIcon"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" id="playIcon"><path d="M8 5v14l11-7-11-7Z"/></svg>';
    }

    // Lock-screen / notification controls, when the browser has them. Purely
    // additive. `meta` = { title, artist, album, artwork }; `handlers` = an
    // object of MediaSession action name -> function; each is set on its own
    // so one unsupported action never blocks the rest.
    function mediaSession( meta, handlers )
    {
        if( ! ( "mediaSession" in navigator ) ) return;
        try { navigator.mediaSession.metadata = new MediaMetadata( meta ); } catch( e ) { return; }
        Object.keys( handlers || {} ).forEach( function ( action )
        {
            try { navigator.mediaSession.setActionHandler( action, handlers[ action ] ); } catch( e ) {}
        } );
    }

    // The lock screen's progress bar: where `el` (the <audio> / <video>) is now.
    // Nothing until the length is known.
    function positionState( el )
    {
        if( ! ( "mediaSession" in navigator ) || ! navigator.mediaSession.setPositionState ) return;
        if( ! isFinite( el.duration ) || el.duration <= 0 ) return;
        try
        {
            navigator.mediaSession.setPositionState( {
                duration: el.duration,
                position: Math.min( el.currentTime, el.duration ),
                playbackRate: el.playbackRate || 1
            } );
        }
        catch( e ) {}
    }

    // The player bar's own wiring, the same in Music and Movies: the seek
    // slider (#seekRange; #elapsedLabel follows it while dragged), the volume
    // (#volumeRange), the length (#totalLabel), the time as it plays, the
    // play icon and the lock screen's playing / paused. `el`: the <audio> or
    // <video>. Hooks, each optional: loaded() once the length is shown, tick()
    // on every timeupdate, play() / pause() before the lock screen is told;
    // finiteSeek: a seek only once the length is known (Movies).
    function wirePlayer( el, hooks )
    {
        var seekRange = document.getElementById( "seekRange" ), seeking = false;
        seekRange.addEventListener( "input", function () { seeking = true; document.getElementById( "elapsedLabel" ).textContent = Ayni.fmtClock( Number( seekRange.value ) ); } );
        seekRange.addEventListener( "change", function () { if( ! hooks.finiteSeek || isFinite( el.duration ) ) el.currentTime = Number( seekRange.value ); seeking = false; } );

        var volumeRange = document.getElementById( "volumeRange" );
        el.volume = Number( volumeRange.value ) / 100;
        volumeRange.addEventListener( "input", function () { el.volume = Number( volumeRange.value ) / 100; } );

        el.addEventListener( "loadedmetadata", function ()
        {
            seekRange.max = Math.floor( el.duration ) || 1;
            document.getElementById( "totalLabel" ).textContent = Ayni.fmtClock( el.duration );
            if( hooks.loaded ) hooks.loaded();
        } );
        el.addEventListener( "timeupdate", function ()
        {
            if( ! seeking )
            {
                seekRange.value = Math.floor( el.currentTime );
                document.getElementById( "elapsedLabel" ).textContent = Ayni.fmtClock( el.currentTime );
            }
            if( hooks.tick ) hooks.tick();
        } );
        function played( on, hook )
        {
            setPlayIcon( on );
            if( hook ) hook();
            if( "mediaSession" in navigator ) navigator.mediaSession.playbackState = on ? "playing" : "paused";
        }
        el.addEventListener( "play",  function () { played( true,  hooks.play  ); } );
        el.addEventListener( "pause", function () { played( false, hooks.pause ); } );
    }


    Ayni.media = { ICONS: ICONS, scopeBarHtml: scopeBarHtml, probeDuration: probeDuration, setPlayIcon: setPlayIcon,
                   mediaSession: mediaSession, positionState: positionState, wirePlayer: wirePlayer };
} )();
