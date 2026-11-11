/*
 * i18n.js - the first script of every Nayive page. Load it FIRST, in <head>,
 * without `defer`, right before Ayni's language script:
 *
 *     <script src="../shared/i18n.js"></script>
 *     <script src="../shared/ayni/ayni-i18n.js" data-dict="../shared/i18n/" data-langs="es en pt fr de"></script>
 *
 * The texts themselves are Ayni's job now (shared/ayni/ayni-i18n.js): keys in
 * shared/i18n/<lang>.json, es.json the reference, data-i18n / data-i18n-attr in
 * the page, Ayni.t() / Ayni.tf() in code, Ayni.i18n.ready before a render that
 * builds text. This file keeps what is Nayive's own:
 *
 *   - OLD SETTINGS: the choices this device saved under Nayive's old names move,
 *     once, to Ayni's (language, light / dark, automatic = Sun mode, the place
 *     for the sun, the colour schemes), so nobody loses them. It runs before
 *     Ayni reads them, which is why it is the first script.
 *   - WHOSE PAGE: AyniWho.now() / AyniWho.atLoad (data-safety L5, below).
 *   - ERROR REPORTS: at the end of the file.
 *
 * The language belongs to the PERSON, not to the screen: the account's choice
 * (homes/<user>/data/config.json "lang", from /api/whoami on every boot) is
 * handed to Ayni.i18n.setLang(), which copies it onto this device and reloads
 * when it differs. The device layer stays the one that paints.
 */

( function ()
{
    "use strict";

    // The names Ayni uses for what it keeps: Nayive's, so nothing stored is lost.
    window.AyniNames = { key: "nayive-", cookie: "nayive_", deskKey: "balata-", api: "/api/", home: "/nayive/", header: "X-Nayive-", upload: "nayive:upload",
                         mergingApps: [ [ "data/tasks.json", "Planner \u203a Tasks" ], [ "data/calendar.ics", "Planner \u203a Calendar" ], [ "data/contacts.vcf", "Contacts" ],
                                       [ "data/habits/", "Planner \u203a Habits" ], [ "data/split/", "Split" ], [ "data/trips/", "Trips" ],
                                       [ "data/games/", "Games" ], [ "data/bookmarks/", "Bookmarks" ] ] };

    // What Ayni writes into files, as Nayive's files have always said it.
    window.AyniCryptMagic = [ "NAYIVE-LOCK-BIN\n", "NAYIVE-LOCK-B64\n", "NAYIVE-LOCK-BI2\n", "NAYIVE-LOCK-B62\n" ];
    window.AyniIcalProdid = "-//Nayive//Personal Calendar//EN";
    window.AyniVaultConfig = { appName: "Nayive" };      // the name a passkey shows (shared/ayni/ayni-vault.js)

    // OLD SETTINGS - Nayive's old localStorage names -> Ayni's. Each is copied
    // only while Ayni's is still empty, then the old one goes, so this does its
    // work once per device and is a few reads after that.
    //   balata-theme       "light" / "dark"  -> ayni-theme (same values)
    //   balata-theme-auto  "1"               -> ayni-theme-sun "1"
    //   balata-geo         { lat, lon }      -> ayni-place
    //   balata-schemes     the schemes JSON  -> ayni-schemes (same shape)
    //   balata-lang        "es" ...          -> ayni-lang
    var OLD = [ [ "balata-theme", "ayni-theme" ], [ "balata-theme-auto", "ayni-theme-sun" ],
                [ "balata-geo", "ayni-place" ], [ "balata-schemes", "ayni-schemes" ],
                [ "balata-lang", "ayni-lang" ], [ "balata-fx", "ayni-fx" ], [ "nayive-sink", "ayni-sink" ] ];
    try
    {
        OLD.forEach( function ( p )
        {
            var v = localStorage.getItem( p[ 0 ] );
            if( v === null ) return;
            if( p[ 0 ] === "balata-theme-auto" && v !== "1" ) v = null;    // "0" = off: nothing to carry
            if( v !== null && localStorage.getItem( p[ 1 ] ) === null ) localStorage.setItem( p[ 1 ], v );
            localStorage.removeItem( p[ 0 ] );
        } );
        localStorage.removeItem( "balata-theme-auto-offered" );   // the old "automatic starts on once" mark: gone
    }
    catch ( e ) {}

    // WHOSE PAGE: the "nayive_who" cookie (server/go/store_owner.go), the
    // account signed in on this browser. whoNow() reads it as it is NOW;
    // whoAtLoad is what it was as this page LOADED - this script runs first,
    // before gum-api / store / locker / office - so a tab left open across
    // another account's sign-in still names its own owner (data-safety L5).
    // "" = unknown. shared/ayni/ayni-store.js keeps its own copy of the read: the
    // data-safety harness loads it alone.
    function whoNow()
    {
        try { var m = document.cookie.match( /(?:^|;\s*)nayive_who=([^;]*)/ ); return m ? m[ 1 ] : ""; }
        catch ( e ) { return ""; }
    }
    var WHO_AT_LOAD = whoNow();

    window.AyniWho = {
        now:    whoNow,
        atLoad: WHO_AT_LOAD
    };
} )();

// ---------------------------------------------------------------------------
// ERROR REPORTS
//
// Lives here, not in ui.js, because this is the one script every page loads
// first and without `defer`: an error in the app's own scripts is caught even
// when it happens before ui.js runs.
//
// An uncaught error or rejected promise is sent to POST /api/clientlog with the
// browser, its version and the device shape (mouse / finger, window size), so
// a page that breaks on someone's phone no longer breaks in silence. The server
// keeps it in <run-root>/logs/client-errors.log (server/go/api_clientlog.go).
//
// Only pages under /nayive/ (a session exists there); guest and public pages
// (/c/..., /s/...) and the sign-in page send nothing. At most MAX_SENDS a page;
// noise nobody can act on (extensions, cross-origin "Script error.", aborted
// fetches, the harmless ResizeObserver warning) is dropped here.
// ---------------------------------------------------------------------------
( function ()
{
    "use strict";

    var BASE = "/nayive/", MAX_SENDS = 10;

    if( location.pathname.indexOf( BASE ) !== 0 ) return;
    var app = location.pathname.slice( BASE.length ).split( "/" )[ 0 ].replace( /\.html$/, "" ) || "launcher";
    if( app === "login" ) return;

    var left = MAX_SENDS;

    // "Firefox 131.0 (Android)". On iPhone every browser is Safari's engine
    // underneath: the "(iOS)" says so whatever name comes first.
    function browserName()
    {
        var ua = navigator.userAgent || "", m;
        var names = [ [ "Edge",             /Edg(?:A|iOS)?\/([\d.]+)/ ],
                      [ "Opera",            /OPR\/([\d.]+)/ ],
                      [ "Samsung Internet", /SamsungBrowser\/([\d.]+)/ ],
                      [ "Firefox",          /(?:Firefox|FxiOS)\/([\d.]+)/ ],
                      [ "Chrome",           /(?:Chrome|CriOS)\/([\d.]+)/ ],
                      [ "Safari",           /Version\/([\d.]+).*Safari/ ] ];
        var os = /iPhone|iPad|iPod/.test( ua ) || ( /Macintosh/.test( ua ) && navigator.maxTouchPoints > 1 ) ? " (iOS)"
               : /Android/.test( ua ) ? " (Android)" : "";
        for( var i = 0; i < names.length; i++ )
            if( ( m = names[ i ][ 1 ].exec( ua ) ) )
                return names[ i ][ 0 ] + " " + m[ 1 ].split( "." ).slice( 0, 2 ).join( "." ) + os;
        return "?" + os;
    }

    function noise( msg, src )
    {
        return /^(chrome|moz|safari(-web)?)-extension:/.test( src || "" ) ||
               ( msg === "Script error." && ! src ) ||
               /ResizeObserver loop/.test( msg );
    }

    function send( rep )
    {
        if( left <= 0 || noise( rep.message, rep.source ) ) return;
        left--;
        try
        {
            rep.app     = app;
            rep.browser = browserName();
            rep.ua      = navigator.userAgent;
            rep.touch   = !! ( window.matchMedia && matchMedia( "(pointer: coarse)" ).matches );
            rep.w       = window.innerWidth;
            rep.h       = window.innerHeight;
            fetch( "/api/clientlog", { method: "POST", keepalive: true, credentials: "same-origin",
                                       headers: { "Content-Type": "application/json" },
                                       body: JSON.stringify( rep ) } ).catch( function () {} );
        }
        catch ( _ ) {}                      // a report must never become an error of its own
    }

    window.addEventListener( "error", function ( e )
    {
        if( ! ( e instanceof ErrorEvent ) ) return;     // a broken <img> or <script> load, not a script error
        send( { kind: "error", message: String( e.message || "" ), source: e.filename || "",
                line: e.lineno || 0, col: e.colno || 0, stack: ( e.error && e.error.stack ) || "" } );
    } );

    window.addEventListener( "unhandledrejection", function ( e )
    {
        var r = e.reason;
        if( r && r.name === "AbortError" ) return;     // a fetch we cancelled on purpose
        send( { kind: "rejection", message: String( ( r && r.message ) || r ), source: "",
                line: 0, col: 0, stack: ( r && r.stack ) || "" } );
    } );
} )();
