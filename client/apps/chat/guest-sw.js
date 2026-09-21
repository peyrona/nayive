/*
 * guest-sw.js - the service worker of a person's Chat link.
 *
 * Served at /c/<token>/sw.js (server/go/api_chat.go), so its scope is the
 * link itself: /c/<token>/. That is on purpose - when the browser renews a
 * subscription with no page open, the worker still knows which link to tell,
 * from its own scope. It only does notifications: no cache, no offline copy
 * (a chat needs the network anyway).
 *
 * The notification text arrives in the push (server side: chat.go pushBody),
 * encrypted end to end for this device - the push service cannot read it.
 */
"use strict";

var SCOPE = self.registration.scope;              // https://<site>/c/<token>/
var API   = SCOPE.replace( /\/c\/([^/]+)\/$/, "/api/c/$1" );

self.addEventListener( "install",  function () { self.skipWaiting(); } );
self.addEventListener( "activate", function ( e ) { e.waitUntil( self.clients.claim() ); } );

self.addEventListener( "push", function ( event )
{
    var d = {};
    try { d = event.data ? event.data.json() : {}; } catch( e ) { d = {}; }
    var icon = new URL( "/nayive/chat/icons/icon-192.png", SCOPE ).toString();
    // A push must ALWAYS show something: iPhone takes the permission away
    // after a few silent ones.
    event.waitUntil( self.registration.showNotification( d.title || "Chat", notice( d, icon, SCOPE ) ) );
} );

// The options of one notification. A call (chat_call.go) rings until it is
// answered; "quiet" replaces the ringing one without a sound (answered or
// declined on another device); a ring that arrives after its deadline (push
// order is not guaranteed) says "missed" instead. Same code in ../sw.js.
function notice( d, icon, home )
{
    var late = d.kind === "call" && d.until && Date.now() > d.until;
    var o = {
        body:     ( late && d.late ) || d.body || "",
        icon:     icon,
        badge:    icon,
        tag:      d.tag || "chat",
        renotify: ! d.quiet,
        data:     { url: d.url || home }
    };
    if( d.kind === "call" && ! d.quiet && ! late && d.until )
    {
        o.requireInteraction = true;
        o.vibrate = [ 500, 250, 500, 250, 500 ];
    }
    if( d.quiet ) o.silent = true;
    return o;
}

self.addEventListener( "notificationclick", function ( event )
{
    event.notification.close();
    var url = new URL( ( event.notification.data || {} ).url || SCOPE, SCOPE ).toString();
    event.waitUntil( ( async function ()
    {
        var all = await clients.matchAll( { type: "window", includeUncontrolled: true } );
        for( var i = 0; i < all.length; i++ )
        {
            if( all[ i ].url.indexOf( SCOPE ) === 0 )
            {
                // Never reload the open page: it may be in a call. It is told
                // which chat to show instead (chat.js).
                all[ i ].postMessage( { open: url } );
                return all[ i ].focus();
            }
        }
        return clients.openWindow( url );
    } )() );
} );

self.addEventListener( "pushsubscriptionchange", function ( event )
{
    var old = event.oldSubscription;
    var key = old && old.options && old.options.applicationServerKey;
    if( ! key ) return;
    event.waitUntil( ( async function ()
    {
        try
        {
            var sub = await self.registration.pushManager.subscribe( { userVisibleOnly: true, applicationServerKey: key } );
            await fetch( API + "/push", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify( { subscription: sub.toJSON() } )
            } );
        }
        catch( e ) {}
    } )() );
} );
