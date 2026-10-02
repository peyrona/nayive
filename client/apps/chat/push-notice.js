/*
 * push-notice.js - the options of one push notification, shared by the two
 * service workers that show them: ../sw.js (Nayive) and guest-sw.js (a
 * person's Chat link). Both load it with importScripts, so it is a plain
 * script that only defines one function - no listeners, no state.
 *
 * Public on purpose (server/go/static.go, chat/*.js): a Chat link's worker
 * runs with no session.
 */
"use strict";

// d is the push's JSON; def holds each worker's own defaults: { body, icon,
// tag, url }. A Chat call (server/go/chat_call.go) rings until it is answered;
// "quiet" replaces the ringing one without a sound (answered or declined on
// another device); a ring that arrives after its deadline (push order is not
// guaranteed) says "missed" instead.
function pushNotice( d, def )
{
    var late = d.kind === "call" && d.until && Date.now() > d.until;
    var o = {
        body:     ( late && d.late ) || def.body,
        icon:     def.icon,
        badge:    def.icon,
        tag:      d.tag || def.tag,   // same event re-sent -> replace, don't stack
        renotify: ! d.quiet,          // ...but still buzz for the replacement
        data:     { url: d.url || def.url }
    };
    if( d.kind === "call" && ! d.quiet && ! late && d.until )
    {
        o.requireInteraction = true;
        o.vibrate = [ 500, 250, 500, 250, 500 ];
    }
    if( d.quiet ) o.silent = true;
    return o;
}
