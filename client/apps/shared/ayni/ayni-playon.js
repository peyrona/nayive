/*
 * play-on.js - the "Play on..." button of Music and Movies.
 *
 *   AyniPlayOn.wire( mediaEl, btn )
 *
 * Its menu lists the speakers this device already paired (mediaEl.setSinkId;
 * Chrome / Edge / Android), then "Cast / AirPlay..." (the Remote Playback API;
 * Chrome / Safari). The button stays hidden when the browser has neither.
 * A browser hides speaker names until the page may use the microphone: one
 * row asks for it, and only that. The picked speaker is remembered per device.
 * Writes no user data.
 */
var AyniPlayOn = ( function ()
{
    "use strict";

    var SINK_KEY = "ayni-sink";
    var VOL_SVG  = Ayni.icon( 'volume' );

    function wire( media, btn )
    {
        var canSink = typeof media.setSinkId === "function" && !! ( navigator.mediaDevices && navigator.mediaDevices.enumerateDevices );
        var canCast = !! media.remote;
        var castAvail = null;                   // true / false once the browser says
        if( ! canSink && ! canCast ) return;
        btn.hidden = false;

        if( canSink )
        {
            var saved = null;
            try { saved = localStorage.getItem( SINK_KEY ); } catch( e ) {}
            if( saved ) media.setSinkId( saved ).catch( function () {} );   // gone: stays on the default
        }
        if( canCast )
        {
            var mark = function () { btn.setAttribute( "aria-pressed", media.remote.state !== "disconnected" ); };
            media.remote.addEventListener( "connect", mark );
            media.remote.addEventListener( "disconnect", mark );
            // Unknown (null) when the browser cannot watch: the row then stays on.
            media.remote.watchAvailability( function ( yes ) { castAvail = yes; } ).catch( function () {} );
        }

        async function openMenu( keyboard )
        {
            var T = Ayni.t, items = [];
            if( canSink )
            {
                var outs = [];
                try { outs = ( await navigator.mediaDevices.enumerateDevices() ).filter( function ( d ) { return d.kind === "audiooutput" && d.deviceId !== "communications"; } ); }
                catch( e ) {}
                if( outs.some( function ( d ) { return d.label; } ) )
                    outs.forEach( function ( d )
                    {
                        var id = d.deviceId === "default" ? "" : d.deviceId;
                        items.push( { label: id ? d.label : T( "ayni.media.outDefault" ), icon: VOL_SVG,
                                      checked: id === ( media.sinkId || "" ),
                                      run: function () { pickSink( id ); } } );
                    } );
                else
                    items.push( { label: T( "ayni.media.outNames" ), icon: VOL_SVG, run: unlockNames } );
            }
            if( canCast )
            {
                if( items.length ) items.push( { sep: true } );
                var none = castAvail === false;
                items.push( { label: T( "ayni.media.outCast" ) + ( none ? " (" + T( "ayni.media.outNoneShort" ) + ")" : "" ),
                              icon: btn.querySelector( ".icon[data-icon]" ) ? btn.querySelector( ".icon[data-icon]" ).dataset.icon : btn.querySelector( "svg" ).outerHTML, run: castPrompt,
                              disabled: none, why: none ? T( "ayni.media.outNone" ) : "" } );
            }
            Ayni.menuAt( items, { anchor: btn, keyboard: keyboard } );
        }

        function pickSink( id )
        {
            media.setSinkId( id ).then( function ()
            {
                try { if( id ) localStorage.setItem( SINK_KEY, id ); else localStorage.removeItem( SINK_KEY ); } catch( e ) {}
            } ).catch( function () { Ayni.toast( "err", Ayni.t( "media.outFail" ) ); } );
        }

        // Names come only with the microphone permission: ask, drop the stream
        // at once, open the menu again.
        function unlockNames()
        {
            navigator.mediaDevices.getUserMedia( { audio: true } ).then( function ( s )
            {
                s.getTracks().forEach( function ( t ) { t.stop(); } );
                openMenu();
            } ).catch( function () { Ayni.toast( "err", Ayni.t( "media.outFail" ) ); } );
        }

        // Chrome answers "dismissed" at once when it has nothing to offer, the
        // same words as when the person closes its picker: a quick "no" is the
        // browser's.
        function castPrompt()
        {
            var t0 = Date.now();
            media.remote.prompt().catch( function ( e )
            {
                if( e && e.name === "NotAllowedError" && Date.now() - t0 > 700 ) return;   // the person closed the picker
                Ayni.toast( "warn", Ayni.t( "media.outNone" ) );
            } );
        }

        btn.addEventListener( "click", function ( e ) { openMenu( e.detail === 0 ); } );
    }

    return { wire: wire };
} )();
