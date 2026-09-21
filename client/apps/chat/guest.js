/*
 * guest.js - a person on their link (chat/guest.html): the first-visit
 * screens (put it on the home screen, turn notifications on), the push
 * subscription, and "this link no longer works". See core.js.
 *
 * iPHONE. Safari only lets a web page notify once it is on the home screen
 * (iOS 16.4+), and a link opened from WhatsApp opens in a view that cannot
 * even do that - so on an iPhone that is not yet "installed" the steps start
 * with "open it in Safari". Nothing here reads the user agent to guess the
 * in-app browser: the steps are the same either way.
 *
 * ANDROID. Notifications work straight from the browser: one button.
 *
 * The permission is asked ONLY from a tap, and requestPermission is the first
 * thing that tap awaits (Safari forgets the tap after the first await).
 */
( function ()
{
    "use strict";

    var C = window.NayiveChat;
    var S = C.S, h = C.h, T = C.T;

    var SKIP_KEY = "chat-guest-skip";
    var reg = null;
    var installEvt = null;

    window.addEventListener( "beforeinstallprompt", function ( e ) { e.preventDefault(); installEvt = e; } );

    function isIOS()
    {
        return /iphone|ipad|ipod/i.test( navigator.userAgent ) ||
               ( navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1 );
    }
    function standalone()
    {
        return ( window.matchMedia && matchMedia( "(display-mode: standalone)" ).matches ) || navigator.standalone === true;
    }
    function pushable() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
    function skipped()  { try { return localStorage.getItem( SKIP_KEY ) === "1"; } catch( _ ) { return false; } }
    function skip()     { try { localStorage.setItem( SKIP_KEY, "1" ); } catch( _ ) {} }

    // The worker lives at /c/<token>/sw.js: the token is in its scope, so a
    // subscription renewed with no page open still knows whose it is.
    C.guestWorker = function ()
    {
        if( ! ( "serviceWorker" in navigator ) ) return Promise.resolve( null );
        return navigator.serviceWorker.register( "sw.js" ).then( function ( r ) { reg = r; return r; },
                                                                 function () { return null; } );
    };

    function b64ToU8( s )
    {
        var pad = "=".repeat( ( 4 - s.length % 4 ) % 4 );
        var raw = atob( ( s + pad ).replace( /-/g, "+" ).replace( /_/g, "/" ) );
        var out = new Uint8Array( raw.length );
        for( var i = 0; i < raw.length; i++ ) out[ i ] = raw.charCodeAt( i );
        return out;
    }

    function sameKey( sub, key )
    {
        try
        {
            var a = new Uint8Array( sub.options.applicationServerKey ), b = b64ToU8( key );
            if( a.length !== b.length ) return false;
            for( var i = 0; i < a.length; i++ ) if( a[ i ] !== b[ i ] ) return false;
            return true;
        }
        catch( _ ) { return true; }
    }

    // Subscribe this device (permission already granted) and tell the server.
    async function subscribe()
    {
        var r = reg || await C.guestWorker();
        if( ! r || ! S.vapid ) return false;
        r = await navigator.serviceWorker.ready;
        var sub = await r.pushManager.getSubscription();
        if( sub && ! sameKey( sub, S.vapid ) ) { try { await sub.unsubscribe(); } catch( _ ) {} sub = null; }
        if( ! sub ) sub = await r.pushManager.subscribe( { userVisibleOnly: true, applicationServerKey: b64ToU8( S.vapid ) } );
        await C.api( "POST", "push", { subscription: sub.toJSON(), lang: NayiveUI.lang() } );
        return true;
    }

    // Brave keeps its push service off until "Use Google services for push
    // messaging" is switched on (brave://settings/privacy): subscribe() then
    // fails with an AbortError, and "check your connection" would mislead.
    function failPush( e )
    {
        if( e && e.name === "AbortError" && navigator.brave )
            NayiveUI.alert( { title: T( "chat.notifications" ), body: T( "chat.pushBrave" ) } );
        else C.fail( e );
    }

    // Already allowed: make sure the server still has this device (quietly,
    // unless loud). True when this device gets the notifications.
    C.guestEnsurePush = async function ( loud )
    {
        if( ! pushable() || Notification.permission !== "granted" ) return false;
        try
        {
            var r = reg || await C.guestWorker();
            if( ! r ) return false;
            r = await navigator.serviceWorker.ready;
            var sub = await r.pushManager.getSubscription();
            if( sub )
            {
                var st = await C.api( "GET", "push?endpoint=" + encodeURIComponent( sub.endpoint ) );
                if( st && st.subscribed && sameKey( sub, S.vapid ) ) return true;
            }
            return await subscribe();
        }
        catch( e ) { if( loud ) failPush( e ); return false; }
    };

    // From a tap: ask, then subscribe.
    async function enable()
    {
        if( ! pushable() ) { C.toast( isIOS() ? "chat.iosTooOld" : "chat.noPushHere", 4000 ); return false; }
        var perm = await Notification.requestPermission();
        if( perm !== "granted" ) { C.toast( "chat.pushDenied", 4500 ); return false; }
        try { await subscribe(); C.toast( "chat.pushOn" ); return true; }
        catch( e ) { failPush( e ); return false; }
    }

    // ---------------------------------------------------------------------
    // the first-visit screens
    // ---------------------------------------------------------------------

    function screen( kids )
    {
        var el = h( "div", { class: "onb" }, h( "div", { class: "onb-in" }, kids ) );
        document.body.appendChild( el );
        return el;
    }

    function step( icon, html )
    {
        var li = h( "li" );
        if( icon ) li.appendChild( typeof icon === "string" ? C.ic( icon ) : icon );
        var span = h( "span" );
        // The step texts carry <b>…</b> from our own dictionary - never a person's text.
        span.innerHTML = html;
        li.appendChild( span );
        return li;
    }

    function iosSteps( done )
    {
        var safari = h( "div", { class: "safari" }, C.ic( "chev-l" ), C.ic( "chev" ),
                        h( "span", { class: "hot" }, C.ic( "ios-share" ) ), C.ic( "book" ), C.ic( "tabs" ) );
        var home = h( "span", { class: "homeicon" }, h( "span", { class: "sq" }, C.ic( "chat" ) ), S.owner );
        var el = screen( [
            C.avatar( "o", S.owner, "xl" ),
            h( "h3", { text: C.TF( "chat.invites", { name: S.owner } ) } ),
            h( "p", { text: T( "chat.iosLead" ) } ),
            h( "ol", { class: "install-steps" },
                step( "compass", NayiveUI.escapeHtml( T( "chat.iosStep1a" ) ) + " <b>" + NayiveUI.escapeHtml( T( "chat.iosStep1b" ) ) + "</b> " + NayiveUI.escapeHtml( T( "chat.iosStep1c" ) ) ),
                step( "ios-share", NayiveUI.escapeHtml( T( "chat.iosStep2a" ) ) + " <b>" + NayiveUI.escapeHtml( T( "chat.iosStep2b" ) ) + "</b>" ) ),
            safari,
            h( "ol", { class: "install-steps", start: 3, style: "counter-reset: install-step 2" },
                step( "plus-square", NayiveUI.escapeHtml( T( "chat.iosStep3a" ) ) + " <b>" + NayiveUI.escapeHtml( T( "chat.iosStep3b" ) ) + "</b>" ),
                step( home, NayiveUI.escapeHtml( T( "chat.iosStep4" ) ) + " <b>" + NayiveUI.escapeHtml( S.owner ) + "</b>." ) ),
            h( "button", { class: "quiet", attrs: { type: "button" }, text: T( "chat.withoutPush2" ),
                           on: { click: function () { skip(); el.remove(); done(); } } } )
        ] );
    }

    function askScreen( done, android )
    {
        var el;
        var go = h( "button", { class: "text-btn", attrs: { type: "button" }, text: T( "chat.enablePush" ),
            on: { click: async function () { var ok = await enable(); if( ok ) { el.remove(); done(); } } } } );
        var kids = android
            ? [ C.avatar( "o", S.owner, "xl" ), h( "h3", { text: C.TF( "chat.invites", { name: S.owner } ) } ),
                h( "p", { text: T( "chat.pushLead" ) } ), go, h( "span", { class: "small", text: T( "chat.allowHint" ) } ) ]
            : [ h( "span", { class: "bigbell" }, C.ic( "bell" ) ), h( "h3", { text: T( "chat.lastStep" ) } ),
                h( "p", { text: C.TF( "chat.pushLeadIos", { name: S.owner } ) } ), go,
                h( "span", { class: "small", text: T( "chat.allowHintIos" ) } ) ];
        kids.push( h( "button", { class: "quiet", attrs: { type: "button" }, text: T( "chat.notNow" ),
                                  on: { click: function () { skip(); el.remove(); done(); } } } ) );
        el = screen( kids );
    }

    // Decide what a person sees before the chat. Resolves when they are in.
    C.guestWelcome = function ()
    {
        return new Promise( function ( done )
        {
            var perm = ( "Notification" in window ) ? Notification.permission : "denied";
            if( perm === "granted" ) { C.guestEnsurePush(); done(); return; }
            if( skipped() ) { done(); return; }
            if( isIOS() && ! standalone() )
            {
                // the saved icon must open THIS page, not ?c=... of a notification
                try { history.replaceState( history.state, "", location.pathname ); } catch( _ ) {}
                iosSteps( done );
                return;
            }
            if( pushable() && perm === "default" ) { askScreen( done, ! isIOS() ); return; }
            done();
        } );
    };

    // The ⋮ menu's "Notifications".
    C.guestNotifications = async function ()
    {
        var perm = ( "Notification" in window ) ? Notification.permission : "denied";
        if( perm === "granted" ) { if( await C.guestEnsurePush( true ) ) C.toast( "chat.pushOn" ); return; }
        if( isIOS() && ! standalone() ) { iosSteps( function () {} ); return; }
        if( perm === "denied" ) { C.toast( "chat.pushDenied", 5000 ); return; }
        enable();
    };

    // The ⋮ menu's "Put an icon on the home screen".
    C.guestHomeIcon = function ()
    {
        if( standalone() ) { C.toast( "chat.alreadyHome" ); return; }
        if( installEvt ) { installEvt.prompt(); installEvt = null; return; }
        if( isIOS() ) { iosSteps( function () {} ); return; }
        NayiveUI.alert( { title: T( "chat.homeIcon" ), body: T( "chat.androidHomeSteps" ) } );
    };

    // The link was deleted or replaced.
    C.showGone = function ()
    {
        document.body.textContent = "";
        document.body.appendChild( h( "div", { class: "gone-page" }, h( "p", { text: T( "chat.linkGone" ) } ) ) );
        document.title = "Chat";
    };
} )();
