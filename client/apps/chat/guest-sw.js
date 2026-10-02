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

// The options of a notification (call rules included), shared with ../sw.js.
// Absolute: this worker is served at /c/<token>/sw.js.
importScripts( "/nayive/chat/push-notice.js" );

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
    event.waitUntil( self.registration.showNotification( d.title || "Chat",
        pushNotice( d, { body: d.body || "", icon: icon, tag: "chat", url: SCOPE } ) ) );
} );

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

// The browser renewed (or dropped) the subscription with no page open. Firefox
// hands over no old subscription at all, so the key comes from the server when
// the old one cannot say it. The language goes with it, or the server takes
// the renewed device for a Spanish one: the page's own choice (balata-lang) is
// out of a worker's reach, so it is the browser's - which is also what the page
// uses until the person picks another.
self.addEventListener( "pushsubscriptionchange", function ( event )
{
    var old = event.oldSubscription;
    var key = old && old.options && old.options.applicationServerKey;
    event.waitUntil( ( async function ()
    {
        try
        {
            if( ! key )
            {
                var got = await ( await fetch( API + "/push" ) ).json();
                if( ! got || ! got.vapid_public ) return;
                key = b64ToU8( got.vapid_public );
            }
            var sub = await self.registration.pushManager.subscribe( { userVisibleOnly: true, applicationServerKey: key } );
            await fetch( API + "/push", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify( { subscription: sub.toJSON(),
                                           lang: String( self.navigator.language || "" ).slice( 0, 2 ).toLowerCase() } )
            } );
        }
        catch( e ) {}
    } )() );
} );

// base64url (the server's VAPID key) -> the bytes subscribe() wants.
function b64ToU8( s )
{
    var pad = "=".repeat( ( 4 - s.length % 4 ) % 4 );
    var raw = atob( ( s + pad ).replace( /-/g, "+" ).replace( /_/g, "/" ) );
    var out = new Uint8Array( raw.length );
    for( var i = 0; i < raw.length; i++ ) out[ i ] = raw.charCodeAt( i );
    return out;
}
