/*
 * login-passkeys.js - "Sign-in passkeys": the list, add, remove, for the
 * account signed in (server/go/login_passkey.go). The launcher's My account
 * and the admin panel open it.
 *
 * Classic script, one global `NayiveLoginPasskeys`. Needs ayni-dialogs.js and
 * ayni-passkey.js (the launcher loads both on the first tap).
 *
 *   NayiveLoginPasskeys.manage()   opens the dialog
 *
 * The passkeys are "discoverable", so the login page needs no name typed.
 * Add and remove ask the password: a session left open on another PC is not
 * enough to add a way into the account.
 */
( function ()
{
    "use strict";

    function t( k ) { return Ayni.t( k ); }

    function api( method, what, body )
    {
        return fetch( "/api/passkey/" + what, { method: method, credentials: "same-origin",
            headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify( body ) : undefined } )
            .then( function ( r )
            {
                return r.json().catch( function () { return {}; } ).then( function ( j )
                {
                    if( r.ok ) return j;
                    throw new Error( r.status === 403 ? t( "acct.pkWrongPw" ) : ( j.error || t( "login.failed" ) ) );
                } );
            } );
    }

    function askPassword()
    {
        return Ayni.ask( { password: true, title: t( "acct.pkTitle" ), lead: t( "acct.pkAskPw" ) } )
            .then( function ( pw ) { if( pw === null ) throw new Error( t( "ayni.pk.cancelled" ) ); return pw; } );
    }

    function manage()
    {
        var b64u = AyniPasskey.b64u;
        return AyniPasskey.listDialog(
        {
            title: t( "acct.pkTitle" ),
            lead:  t( "acct.pkLead" ),
            load:  function () { return api( "GET", "keys" ).then( function ( j ) { return j.keys; } ); },
            add: async function ( name )
            {
                if( ! AyniPasskey.supported() ) throw new Error( t( "ayni.pk.none" ) );
                var b = await api( "POST", "add-begin", { password: await askPassword() } );
                var made = await AyniPasskey.create( { challenge: AyniPasskey.bytes( b.challenge ), rpId: b.rp_id,
                    rpName: "Nayive", userId: AyniPasskey.bytes( b.user_id ), userName: b.user_name,
                    displayName: b.user_name, exclude: b.exclude, resident: true } );
                var r = made.cred.response, key = r.getPublicKey && r.getPublicKey();
                if( ! key ) throw new Error( t( "ayni.pk.none" ) );
                await api( "POST", "add", { name: name, id: made.id, transports: made.transports,
                    client_data: b64u( r.clientDataJSON ), auth_data: b64u( r.getAuthenticatorData() ),
                    key: b64u( key ), alg: r.getPublicKeyAlgorithm() } );
            },
            remove: async function ( k )
            {
                await api( "POST", "remove", { password: await askPassword(), id: k.id } );
            }
        } );
    }

    window.NayiveLoginPasskeys = { manage: manage };
} )();
