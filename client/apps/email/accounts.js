// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * accounts.js - the Settings dialog, two tabs.
 *
 * ACCOUNTS: the ones there are and the form that adds one. Each account's
 * key gives it a new password (Google revokes app passwords when the Google
 * password changes; a restored backup has none): tried on its server first,
 * the account and its labels stay. The bin removes one, with Undo (out of
 * sight at once, removed when the Undo is gone) - its mail stays on its
 * server; Nayive's labels on it go (the toast says so).
 * GENERAL: how many days mail stays in the Trash and the signature (both
 * saved as they are typed).
 *
 * THE FORM. The provider, and beside it the address: a drop-down filled from
 * the server's list (/api/mail/providers, mail_presets.go) plus "Other". It
 * follows the domain being typed until the user picks one by hand (Google
 * Workspace on one's own domain is "Gmail" picked by hand). Under it, what
 * that provider needs, in steps, and a link to the page where its app
 * password is made. A provider that lets no app in with a password at all
 * (Microsoft) says why and what to do instead, and Add stays off.
 * "Other" shows the two server fields. The server tries the login before it
 * keeps anything.
 */
( function ()
{
    "use strict";

    var E = window.NayiveMail, S = E.S, h = E.h;

    var providers = [];      // from the server, once
    var picked    = false;   // the user chose the provider by hand

    var EYE     = NayiveUI.icon( "eye" );
    var EYE_OFF = NayiveUI.icon( "eyeoff" );

    function prov() { return providers.filter( function ( p ) { return p.id === E.$( "addProv" ).value; } )[ 0 ] || null; }

    async function loadProviders()
    {
        if( providers.length ) return;
        var r = await E.api( "GET", "providers" );
        providers = r.providers || [];
        var sel = E.$( "addProv" );
        sel.textContent = "";
        providers.forEach( function ( p )
        {
            sel.appendChild( h( "option", { text: p.name, attrs: { value: p.id } } ) );
        } );
        sel.appendChild( h( "option", { text: E.T( "mail.prov.other" ), attrs: { value: "other" } } ) );
    }

    // openSettings( "accounts" | "general" ): the dialog, on that tab.
    E.openSettings = async function ( tab )
    {
        showTab( tab || "accounts" );
        E.$( "trashDays" ).value = S.settings.trashDays;
        E.$( "signature" ).value = S.settings.signature || "";
        E.$( "trashDaysHint" ).hidden = ! S.accounts.some( function ( a ) { return a.provider === "gmail" || /gmail\.com$/.test( a.imapHost || "" ); } );
        renderList();
        [ "addEmail", "addPass", "addName", "imapHost", "smtpHost", "jmapUrl" ].forEach( function ( id ) { E.$( id ).value = ""; } );
        E.$( "imapPort" ).value = "993";
        E.$( "smtpPort" ).value = "465";
        E.$( "addError" ).hidden = true;
        E.$( "addStatus" ).hidden = true;
        showPass( false );
        picked = false;
        try { await loadProviders(); }
        catch( err ) { NayiveUI.toast( E.errText( err ) ); }
        E.$( "addProv" ).value = providers.length ? providers[ 0 ].id : "other";
        renderProvider();
        NayiveUI.open( "setSheet" );
        if( ! S.accounts.length && tab !== "general" ) setTimeout( function () { E.$( "addEmail" ).focus(); }, 50 );
    };

    function showTab( tab )
    {
        document.querySelectorAll( "#setSheet .mail-tabs .pill" ).forEach( function ( b )
        {
            var on = b.getAttribute( "data-tab" ) === tab;
            b.classList.toggle( "is-active", on );
            b.setAttribute( "aria-selected", on ? "true" : "false" );
        } );
        document.querySelectorAll( "#setSheet [data-pane]" ).forEach( function ( p ) { p.hidden = p.getAttribute( "data-pane" ) !== tab; } );
    }

    var daysTimer = 0;
    function saveDays()
    {
        clearTimeout( daysTimer );
        daysTimer = setTimeout( async function ()
        {
            var n = parseInt( E.$( "trashDays" ).value, 10 );
            if( ! ( n >= 1 && n <= 365 ) ) return;
            try
            {
                S.settings = Object.assign( S.settings, await E.api( "PUT", "settings", { trashDays: n } ) );
                if( ! S.label && S.tray === "trash" ) E.$( "trashBarText" ).textContent = E.TF( "mail.trashBar", { n: S.settings.trashDays } );
            }
            catch( err ) { NayiveUI.toast( E.errText( err ) ); }
        }, 500 );
    }

    // The signature: in use at once (a message written right away has it),
    // saved a moment after the typing stops - or at once when the box is left.
    // One that failed goes again at the next key, when the box is left, or
    // when the dialog closes - even with the same text (OL5).
    var sigTimer = 0, sigFailed = false;
    function saveSignature( now )
    {
        clearTimeout( sigTimer );
        var text = E.$( "signature" ).value;
        if( text === S.settings.signature && now !== true && ! sigFailed ) return;
        S.settings.signature = text;
        sigTimer = setTimeout( async function ()
        {
            sigTimer = 0;
            try { S.settings = Object.assign( S.settings, await E.api( "PUT", "settings", { signature: text } ) ); sigFailed = false; }
            catch( err ) { sigFailed = true; NayiveUI.toast( E.errText( err ) ); }
        }, now === true ? 0 : 800 );
    }
    function retrySignature() { if( sigTimer || sigFailed ) saveSignature( true ); }

    // The domain being typed picks the provider - until the user picks one.
    function followDomain()
    {
        if( picked ) return;
        var v = E.$( "addEmail" ).value.trim().toLowerCase(), at = v.lastIndexOf( "@" );
        if( at < 0 ) return;
        var domain = v.slice( at + 1 );
        var p = providers.filter( function ( x ) { return x.domains.indexOf( domain ) >= 0; } )[ 0 ];
        var want = p ? p.id : ( /\.[a-z]{2,}$/.test( domain ) ? "other" : null );
        if( want && want !== E.$( "addProv" ).value )
        {
            E.$( "addProv" ).value = want;
            renderProvider();
        }
    }

    // What the provider picked needs: its steps, its link, its fields.
    function renderProvider()
    {
        var p = prov(), id = p ? p.id : "other";
        E.$( "provWhat" ).textContent = E.T( "mail.prov." + id + ".what" );
        var ol = E.$( "provSteps" );
        ol.textContent = "";
        E.T( "mail.prov." + id + ".steps" ).split( "\n" ).forEach( function ( s ) { if( s.trim() ) ol.appendChild( h( "li", { text: s } ) ); } );

        var link = E.$( "provLink" );
        link.hidden = ! ( p && p.help && ! p.blocked );
        if( ! link.hidden )
        {
            link.href = p.help;
            E.$( "provLinkText" ).textContent = E.TF( "mail.prov.link", { name: p.name } );
        }

        var blocked = !! ( p && p.blocked );
        E.$( "provHelp" ).classList.toggle( "is-blocked", blocked );
        E.$( "addFields" ).hidden = blocked;
        E.$( "addBtn" ).disabled = blocked;
        var jmap = !! ( p && p.kind === "jmap" );
        E.$( "hostFields" ).hidden = !! p;
        E.$( "jmapField" ).hidden = ! jmap || !! p.jmapUrl;
        E.$( "addPassLabel" ).textContent = E.T( ! p ? "mail.password" : p.pass === "app" ? "mail.appPass"
                                               : p.pass === "token" ? "mail.token" : jmap ? "mail.passOrToken" : "mail.password" );
        var domain = p && p.domains && p.domains.length ? p.domains[ 0 ] : "example.com";
        E.$( "addEmail" ).placeholder = E.T( "mail.emailPhName" ) + "@" + domain;
        E.$( "addError" ).hidden = true;
    }

    function showPass( on )
    {
        var pw = E.$( "addPass" ), eye = E.$( "passEye" );
        pw.type = on ? "text" : "password";
        eye.innerHTML = on ? EYE_OFF : EYE;
        var tip = E.T( on ? "ui.hidePassword" : "ui.showPassword" );
        eye.title = tip;
        eye.setAttribute( "aria-label", tip );
    }

    function hostOf( u ) { try { return new URL( u ).host; } catch( e ) { return u; } }

    function renderList()
    {
        var box = E.$( "acctList" );
        box.textContent = "";
        box.hidden = ! S.accounts.length;
        S.accounts.forEach( function ( a )
        {
            var p = providers.filter( function ( x ) { return x.id === a.provider; } )[ 0 ];
            var sub = a.error === "auth" ? E.T( "mail.acctErrAuth" )
                    : a.error === "key" ? E.T( "mail.acctErrKey" )
                    : a.error === "down" ? E.T( "mail.acctErrDown" )
                    : ( p ? p.name : a.imapHost ) + ( p && p.id === "jmap" && a.jmapUrl ? " · " + hostOf( a.jmapUrl ) : "" ) +
                      ( a.name ? " · " + a.name : "" );
            var form = newPassForm( a );
            var key = h( "button", { class: "icon-btn" + ( a.error === "auth" || a.error === "key" ? " is-on" : "" ), html: E.icon( "key" ),
                                     attrs: { type: "button", title: E.T( "mail.newPass" ), "aria-label": E.T( "mail.newPass" ), "aria-expanded": "false" },
                                     on: { click: function ()
                                     {
                                         form.hidden = ! form.hidden;
                                         key.setAttribute( "aria-expanded", form.hidden ? "false" : "true" );
                                         if( ! form.hidden ) form.querySelector( "input" ).focus();
                                     } } } );
            var bin = h( "button", { class: "icon-btn danger", html: NayiveUI.icon( "trash" ),
                                     attrs: { type: "button", title: E.T( "mail.removeAccount" ), "aria-label": E.T( "mail.removeAccount" ) },
                                     on: { click: function () { remove( a ); } } } );
            box.appendChild( h( "div", { class: "card-row" },
                h( "div", null, h( "b", { text: a.email } ), h( "small", { class: a.error ? "bad" : null, text: sub } ) ),
                key, bin ) );
            box.appendChild( form );
        } );
    }

    // An account's new password: typed, tried on its server, kept.
    function newPassForm( a )
    {
        var input = h( "input", { attrs: { type: "password", autocomplete: "new-password", spellcheck: "false", autocapitalize: "none",
                                           "aria-label": E.T( "mail.newPass" ), placeholder: E.T( "mail.newPass" ) } } );
        var status = h( "p", { class: "mail-add-status" } );
        status.hidden = true;
        var errBox = h( "p", { class: "field-error" } );
        errBox.hidden = true;
        var save = h( "button", { class: "text-btn", text: E.T( "ui.save" ), attrs: { type: "button" } } );
        async function go()
        {
            var pass = input.value;
            if( ! pass.trim() ) { input.focus(); return; }
            save.disabled = true;
            errBox.hidden = true;
            status.textContent = E.TF( "mail.checkingWith", { name: a.email } );
            status.hidden = false;
            try
            {
                await E.api( "PATCH", "accounts/" + encodeURIComponent( a.id ), { pass: pass } );
                NayiveUI.toast( E.T( "mail.passSaved" ) );
                await E.loadAccounts();
                renderList();
                if( a.id === S.acct ) { E.showProblem( null ); E.refresh( true ); }
            }
            catch( err )
            {
                errBox.textContent = E.errText( err );
                errBox.hidden = false;
            }
            finally { status.hidden = true; save.disabled = false; }
        }
        save.addEventListener( "click", go );
        input.addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); go(); } } );
        input.addEventListener( "input", function () { errBox.hidden = true; } );
        var box = h( "div", { class: "mail-newpass" }, h( "div", { class: "mail-pass" }, input ), save, status, errBox );
        box.hidden = true;
        return box;
    }

    // The bin: out of sight at once, with Undo. The server removes it only
    // when the Undo is gone - a page closed meanwhile removes it too. Until
    // then no re-read shows it (S.goneAccts: list.js) and nothing uses it.
    function remove( a )
    {
        var at = S.accounts.findIndex( function ( x ) { return x.id === a.id; } );
        var wasOn = S.acct === a.id;
        S.goneAccts.add( a.id );
        S.accounts = S.accounts.filter( function ( x ) { return x.id !== a.id; } );
        if( wasOn ) S.acct = S.accounts.length ? S.accounts[ 0 ].id : "";
        renderList();
        E.showAccounts();
        var landed = S.acct;

        function back()
        {
            S.goneAccts.delete( a.id );
            if( ! E.account( a.id ) ) S.accounts.splice( at < 0 ? S.accounts.length : Math.min( at, S.accounts.length ), 0, a );
            renderList();
        }
        NayiveUI.undoToast( E.T( "mail.removed" ), function ()
        {
            var here = S.acct === landed;
            back();
            if( wasOn && here ) { S.acct = a.id; E.showAccounts(); }      // still where it sent us: back to it
            else E.renderSide();
        }, { onExpire: function ()
        {
            E.api( "DELETE", "accounts/" + encodeURIComponent( a.id ) ).catch( function ( err )
            {
                if( err.status === 404 ) return;                             // removed already (another device)
                back();
                if( ! S.acct ) { S.acct = a.id; E.showAccounts(); }          // it was the only one
                else E.renderSide();
                NayiveUI.toast( E.errText( err ) );
            } );
        } } );
    }

    E.addAccount = async function ()
    {
        var p = prov(), btn = E.$( "addBtn" ), errBox = E.$( "addError" ), status = E.$( "addStatus" );
        var body = {
            email:    E.$( "addEmail" ).value.trim(),
            pass:     E.$( "addPass" ).value,
            name:     E.$( "addName" ).value.trim(),
            provider: p ? p.id : "other"
        };
        if( p && p.kind === "jmap" && ! p.jmapUrl ) body.jmapUrl = E.$( "jmapUrl" ).value.trim();
        if( ! p )
        {
            body.imapHost = E.$( "imapHost" ).value.trim();
            body.imapPort = parseInt( E.$( "imapPort" ).value, 10 ) || 993;
            body.smtpHost = E.$( "smtpHost" ).value.trim();
            body.smtpPort = parseInt( E.$( "smtpPort" ).value, 10 ) || 465;
        }
        var miss = ! body.email || body.email.indexOf( "@" ) < 1 ? "addEmail" : ! body.pass ? "addPass"
                 : ( ! p && ! body.imapHost ) ? "imapHost" : ( body.jmapUrl === "" ) ? "jmapUrl" : "";
        if( miss )
        {
            errBox.textContent = E.T( miss === "imapHost" ? "mail.err.hosts" : miss === "jmapUrl" ? "mail.err.url" : "mail.err.bad" );
            errBox.hidden = false;
            E.$( miss ).focus();
            return;
        }
        errBox.hidden = true;
        btn.disabled = true;
        status.textContent = E.TF( "mail.checkingWith", { name: body.jmapUrl || ( p ? p.name : body.imapHost ) } );
        status.hidden = false;
        try
        {
            var a = await E.api( "POST", "accounts", body );
            NayiveUI.toast( E.T( "mail.added" ) );
            NayiveUI.close( "setSheet" );
            await E.loadAccounts();
            S.acct = a.id;
            S.tray = "inbox";
            E.showAccounts();
        }
        catch( err )
        {
            if( err.code === "hosts" ) { E.$( "addProv" ).value = "other"; picked = true; renderProvider(); }
            errBox.textContent = E.errText( err );
            errBox.hidden = false;
        }
        finally
        {
            status.hidden = true;
            btn.disabled = !! ( prov() && prov().blocked );
        }
    };

    document.addEventListener( "DOMContentLoaded", function ()
    {
        E.$( "addEmail" ).addEventListener( "input", followDomain );
        [ "addEmail", "addPass", "jmapUrl", "imapHost", "smtpHost" ].forEach( function ( id )
        {
            E.$( id ).addEventListener( "input", function () { E.$( "addError" ).hidden = true; } );   // fixed: the old complaint goes
        } );
        E.$( "addProv" ).addEventListener( "change", function () { picked = true; renderProvider(); } );
        E.$( "passEye" ).addEventListener( "click", function ()
        {
            showPass( E.$( "addPass" ).type === "password" );
            E.$( "addPass" ).focus();
        } );
        E.$( "addPass" ).addEventListener( "keydown", function ( e ) { if( e.key === "Enter" ) { e.preventDefault(); E.addAccount(); } } );
        E.$( "trashDays" ).addEventListener( "input", saveDays );
        E.$( "signature" ).addEventListener( "input", saveSignature );
        E.$( "signature" ).addEventListener( "change", retrySignature );
        NayiveUI.onSheetClose( "setSheet", retrySignature );
        document.querySelector( "#setSheet .mail-tabs" ).addEventListener( "click", function ( e )
        {
            var b = e.target.closest( "[data-tab]" );
            if( b ) showTab( b.getAttribute( "data-tab" ) );
        } );
    } );
} )();
