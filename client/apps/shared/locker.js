/* locker.js - Nayive's settings for Ayni's screen locker (shared/ayni/ayni-locker.js, the next script on every page). Only the desktop page locks,
 * so a phone never does. The who-cookie (server: store_owner.go) lives as long as the session cookie. */
window.AyniLockerConfig =
{
    keys:     { set: "nayive-locker", lock: "nayive-lock", seen: "nayive-lock-seen" },
    lockers:  [ "culture", "science", "clock", "matrix", "life" ],     // name = i18n "scrlock.<id>"
    isDesk:   function () { return /\/desktop\/(index\.html)?$/.test( location.pathname ); },
    signedIn: function () { return /(?:^|;\s*)nayive_who=[^;]/.test( document.cookie ); },
    who:      ( window.AyniWho && AyniWho.atLoad ) || "",           // shared/i18n.js WHOSE PAGE
    signIn:   function () { location.href = "/nayive/login.html"; },
    // Culture and Science are Nayive's own; the rest come with Ayni.
    lockerUrl: function ( id, base ) { return base + ( /^(culture|science)$/.test( id ) ? "../lockers/" : "lockers/" ) + id + ".js"; },
    unlock:   function ( password )
    {
        return fetch( "/api/unlock",
        {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify( { password: password } )
        } ).then( function ( r ) { return r.status; } );
    }
};
