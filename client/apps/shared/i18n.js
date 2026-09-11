/*
 * i18n.js - the interface language for every Nayive page.
 *
 * Classic script, one global `NayiveI18n`, no dependencies. Load it FIRST, in
 * <head>, without `defer`, so the dictionary starts downloading before the rest
 * of the page:
 *
 *     <script src="../shared/i18n.js"></script>
 *
 * NO string lives in the source any more - not even the Spanish one. Every
 * interface message is a key in shared/i18n/<lang>.json, one file per language
 * (es en pt fr de it la). es.json is the reference: a key missing from another
 * language falls back to Spanish, and then to the literal key.
 *
 *   - static text:   <span data-i18n="key"></span>
 *   - attributes:    <input data-i18n-attr="placeholder:key, title:key2">
 *   - in JS:         NayiveI18n.t( "key" )  /  NayiveUI.t( "key" )
 *                    NayiveI18n.tf( "key", { n: 3 } )    // "{n}" placeholders
 *
 * Because there is no in-source fallback, nothing may be painted before the
 * dictionary is in: this script hides <html> (a <style> it injects) and shows it
 * again as soon as the JSON has landed and the page has been translated - or
 * after SHOW_MS, so a dead network can never leave a blank screen. An app that
 * builds text from JS should `await NayiveI18n.ready` before its first render.
 *
 * Language = localStorage["balata-lang"] when set, else the first of the
 * browser's languages we translate, else English. The launcher's "Mi cuenta"
 * dialog changes it (NayiveI18n.setLang), which reloads the page - it returns
 * true when that reload is coming, so a caller can leave itself a note to pick
 * up on the other side; a change in
 * another tab reloads this one too (the "storage" event). Its first entry is
 * "por defecto" - setLang("") forgets the choice and hands the decision back to
 * the browser. `saved()` is that stored choice (null when there is none), which
 * `lang()` cannot tell you: with nothing stored lang() still returns a code.
 *
 * That localStorage value is the DEVICE layer, and it is all this file can read
 * on its own: it runs in <head>, before any session is known, and the sign-in
 * screen is translated too. But the language belongs to the PERSON, not to the
 * screen - pick Spanish on the phone and the PC should follow. So there is a
 * second, ACCOUNT layer on the server (homes/<user>/data/config.json "lang"),
 * and it wins: /api/whoami hands it back on every boot and the caller passes it
 * to NayiveI18n.adopt(), which copies it into localStorage and reloads. The
 * device layer stays the one that paints - nothing waits on the network - and
 * from the second boot onwards the two agree, so nothing reloads.
 */

( function ()
{
    "use strict";

    var LANGS   = [ "es", "en", "pt", "fr", "de", "it", "la" ];  // languages the UI can offer
    // Latin has no CLDR data, so Intl falls back to en-US: month and weekday
    // names, currency names and number formats would all come out English.
    // These borrow Italian instead. Only the browser-formatted bits follow
    // this map - the interface TEXT and <html lang> stay "la".
    var INTL    = { la: "it" };
    var SOURCE  = "es";                               // the reference dictionary
    var KEY     = "balata-lang";
    var SHOW_MS = 2500;                               // never hide the page longer than this

    var dict = {};                                    // active: source merged under the chosen language

    // shared/i18n/ sits next to this script, whatever depth the page is at.
    var URL_BASE = ( function ()
    {
        try { return new URL( "i18n/", ( document.currentScript || {} ).src ).toString(); }
        catch ( e ) { return "/nayive/shared/i18n/"; }
    } )();

    // The language the user PICKED, or null when they never did - which is not
    // the same as the language in use: with nothing stored we follow the
    // browser, and that may well land on the same code.
    function saved()
    {
        try
        {
            var s = localStorage.getItem( KEY );
            if( s && LANGS.indexOf( s ) !== -1 ) return s;
        }
        catch ( e ) {}
        return null;
    }

    function pick()
    {
        var s = saved();
        if( s ) return s;

        var navs = navigator.languages || [ navigator.language || "" ];
        for( var i = 0; i < navs.length; i++ )
        {
            var two = String( navs[ i ] || "" ).slice( 0, 2 ).toLowerCase();
            if( LANGS.indexOf( two ) !== -1 ) return two;
        }
        return "en";                                  // browser locale not one we translate
    }

    var lang = pick();

    // Armed NOW, while this head script runs and the parser is still going, so
    // the listener can never be attached too late. Waiting on readyState later
    // would not do: it flips to "interactive" BEFORE the deferred scripts run,
    // and everything waiting on `ready` expects GumApi / NayiveUI to be there.
    var domReady = new Promise( function ( go )
    {
        if( document.readyState === "interactive" || document.readyState === "complete" ) go();
        else document.addEventListener( "DOMContentLoaded", go, { once: true } );
    } );

    //------------------------------------------------------------------------//
    // HIDE THE PAGE UNTIL THE DICTIONARY IS IN

    var hider = null;
    try
    {
        hider = document.createElement( "style" );
        hider.textContent = "html{visibility:hidden!important}";
        ( document.head || document.documentElement ).appendChild( hider );
    }
    catch ( e ) {}

    function show()
    {
        if( hider && hider.parentNode ) hider.parentNode.removeChild( hider );
        hider = null;
    }
    setTimeout( show, SHOW_MS );

    //------------------------------------------------------------------------//
    // LOOKUP

    function t( key )
    {
        if( key && Object.prototype.hasOwnProperty.call( dict, key ) ) return dict[ key ];
        return key;                                   // dictionary not in yet, or a typo in the key
    }

    // t() with "{name}" placeholders:  tf( "k", { n: 2 } )
    function tf( key, vars )
    {
        return String( t( key ) ).replace( /\{(\w+)\}/g, function ( m, k )
        {
            return vars && vars[ k ] != null ? vars[ k ] : m;
        } );
    }

    function els( scope, sel )
    {
        var list = [].slice.call( scope.querySelectorAll( sel ) );
        if( scope.nodeType === 1 && scope.matches && scope.matches( sel ) ) list.push( scope );
        return list;
    }

    function applyI18n( root )
    {
        var scope = root && root.querySelectorAll ? root : document;

        els( scope, "[data-i18n]" ).forEach( function ( el )
        {
            var key = el.getAttribute( "data-i18n" );
            if( key ) el.textContent = t( key );
        } );

        els( scope, "[data-i18n-attr]" ).forEach( function ( el )
        {
            el.getAttribute( "data-i18n-attr" ).split( "," ).forEach( function ( pair )
            {
                var bits = pair.split( ":" );
                if( bits.length !== 2 ) return;
                var attr = bits[ 0 ].trim(), key = bits[ 1 ].trim();
                if( attr && key ) el.setAttribute( attr, t( key ) );
            } );
        } );
    }

    //------------------------------------------------------------------------//
    // DATE NAMES  -  never a list in a dictionary: the browser knows them all
    //
    //   weekday( 1 )            -> "lunes" / "Monday" / "Montag" ...   (1 = Monday)
    //   weekday( 1, "narrow" )  -> "L" / "M" / "M"
    //   month( 0 )              -> "enero" / "January" ...             (0 = January)

    // The BCP-47 tag for Intl / toLocale*, which is not always the interface
    // language: see INTL above.
    function intlTag() { return INTL[ lang ] || lang; }

    function capitalise( s ) { return s ? s.charAt( 0 ).toUpperCase() + s.slice( 1 ) : s; }

    function weekday( iso, style )
    {
        // 2024-01-01 was a Monday, so 2024-01-<iso> lines the ISO number up.
        var d = new Date( Date.UTC( 2024, 0, iso ) );
        try
        {
            return capitalise( new Intl.DateTimeFormat( intlTag(),
                   { weekday: style || "long", timeZone: "UTC" } ).format( d ) );
        }
        catch ( e ) { return String( iso ); }
    }

    function month( idx, style )
    {
        var d = new Date( Date.UTC( 2024, idx, 1 ) );
        try
        {
            return capitalise( new Intl.DateTimeFormat( intlTag(),
                   { month: style || "long", timeZone: "UTC" } ).format( d ) );
        }
        catch ( e ) { return String( idx + 1 ); }
    }

    //------------------------------------------------------------------------//
    // LOAD

    async function grab( code )
    {
        try
        {
            var r = await fetch( URL_BASE + code + ".json" );
            if( r.ok ) return await r.json();
        }
        catch ( e ) {}
        return null;
    }

    var ready = ( async function ()
    {
        var merged = ( await grab( SOURCE ) ) || {};

        if( lang !== SOURCE )
        {
            var extra = await grab( lang );
            if( extra ) Object.assign( merged, extra );
        }

        dict = merged;
        try { document.documentElement.setAttribute( "lang", lang ); } catch ( e ) {}

        await domReady;

        applyI18n( document );
        show();
        return dict;
    } )();

    // Anything added to the DOM later (a dialog built in JS, a row of a list).
    if( window.MutationObserver )
    {
        var obs = new MutationObserver( function ( muts )
        {
            for( var i = 0; i < muts.length; i++ )
            {
                var added = muts[ i ].addedNodes;
                for( var j = 0; j < added.length; j++ )
                    if( added[ j ] && added[ j ].nodeType === 1 ) applyI18n( added[ j ] );
            }
        } );
        try { obs.observe( document.documentElement, { childList: true, subtree: true } ); }
        catch ( e ) {}
    }

    window.addEventListener( "storage", function ( e )
    {
        if( e && e.key === KEY ) location.reload();
    } );

    window.NayiveI18n = {
        t:         t,
        tf:        tf,
        applyI18n: applyI18n,
        ready:     ready,
        lang:      function () { return lang; },
        saved:     saved,
        // The BCP-47 tag to hand Intl / toLocale*: the interface language, so
        // dates, numbers and currency names follow what the user picked here
        // rather than what the browser is set to. Not always lang() - a
        // language with no CLDR data borrows another's formats (INTL above).
        locale:    function () { return intlTag(); },
        weekday:   weekday,
        month:     month,
        langs:     LANGS.slice(),
        // The language the ACCOUNT chose, as /api/whoami reports it (see
        // lib/users.user_lang). Copies it onto THIS device and reloads, so a
        // choice made on the phone reaches the PC on its next boot.
        //
        //   null / undefined  the account never chose one: leave the device
        //                     alone. Every device that existed before this
        //                     setting did keeps exactly what it had.
        //   ""                "por defecto", asked for on purpose: forget this
        //                     device's choice and follow the browser again.
        //   "es"              a real choice: adopt it here too.
        //
        // Returns true when a reload is on its way, so the caller can stop
        // rendering a frame that is about to be thrown away.
        //
        // Unlike setLang(), which is one deliberate click, this runs on EVERY
        // boot - so it must never reload unless the write really landed. With
        // localStorage blocked (private mode, storage switched off) setItem
        // throws, the stored value never moves, and a blind reload would spin
        // for ever. Hence the re-read before each reload.
        adopt:     function ( code )
        {
            if( code === null || code === undefined ) return false;

            if( code === "" )                         // account says "follow the browser"
            {
                if( ! saved() ) return false;
                try { localStorage.removeItem( KEY ); } catch ( e ) {}
                if( saved() ) return false;           // write refused - do not spin
                location.reload();
                return true;
            }

            if( LANGS.indexOf( code ) === -1 || code === saved() ) return false;
            try { localStorage.setItem( KEY, code ); } catch ( e ) {}
            if( saved() !== code ) return false;      // write refused - do not spin
            location.reload();
            return true;
        },
        // Like adopt(), returns true when a reload is on its way and false when
        // the pick changed nothing - a caller that has to survive the reload
        // (the launcher reopens its settings dialog) needs to know which.
        setLang:   function ( code )
        {
            if( ! code )                              // "por defecto": follow the browser again
            {
                if( ! saved() ) return false;
                try { localStorage.removeItem( KEY ); } catch ( e ) {}
                location.reload();
                return true;
            }
            if( LANGS.indexOf( code ) === -1 || code === saved() ) return false;
            try { localStorage.setItem( KEY, code ); } catch ( e ) {}
            location.reload();
            return true;
        }
    };
} )();
