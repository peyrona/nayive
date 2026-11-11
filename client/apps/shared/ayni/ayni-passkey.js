/*
 * ayni-passkey.js - passkeys (WebAuthn) in the browser: make one, confirm one,
 * and the dialog that lists them.
 *
 * Classic script, one global `AyniPasskey`. Load it deferred, after
 * ayni-dialogs.js. It talks to no server: the caller hands it the challenge
 * and the key list, and gets the browser's answer back.
 *
 * Two users today:
 *   - the Admin SSH tab (ssh/ssh-tab.js): the SERVER checks the signature
 *     (server/go/confirm_passkey.go; the authenticator-app code beside it is the tab's own);
 *   - the document vault (ayni-vault.js): nothing is checked anywhere - the
 *     passkey's PRF secret is itself what unwraps the key.
 *
 *   AyniPasskey.supported()                   this browser can do passkeys
 *   AyniPasskey.prfMaybe()                    Promise<bool> - it says it can do PRF (false = it says no;
 *                                             true = it says yes, or does not say)
 *   AyniPasskey.b64u( bytes ) / bytes( txt )  base64url <-> Uint8Array
 *   AyniPasskey.create( o ) -> Promise<{ cred, id, transports, prf, prfSecret }>
 *       o: challenge (bytes), rpId?, rpName, userId (bytes), userName, displayName,
 *          exclude [ b64u ids ], prf: true (ask for the PRF extension; prf = true/false/null: unknown),
 *          prfSalt (bytes): also ask for the secret now (prfSecret; null when the authenticator gives it only on use)
 *   AyniPasskey.get( o ) -> Promise<{ cred, id, prf }>
 *       o: challenge (bytes), rpId?, allow [ { id: b64u, transports? } ],
 *          prfSalts { <b64u id>: bytes } (prf = the 32-byte secret of the key used, or null)
 *   AyniPasskey.error( e )                    the browser's error -> one short, translated Error
 *   AyniPasskey.listDialog( o )               the "Passkeys" dialog (see there)
 */
( function ()
{
    "use strict";

    function t( k ) { return Ayni.t( k ); }

    function supported()
    {
        return !! ( window.PublicKeyCredential && navigator.credentials && navigator.credentials.create );
    }

    // getClientCapabilities is new (2025): where it is missing, we cannot tell.
    async function prfMaybe()
    {
        if( ! supported() ) return false;
        try
        {
            if( PublicKeyCredential.getClientCapabilities )
            {
                var caps = await PublicKeyCredential.getClientCapabilities();
                if( caps && "extension:prf" in caps ) return !! caps[ "extension:prf" ];
            }
        }
        catch ( e ) {}
        return true;
    }

    // base64url <-> bytes, as WebAuthn wants them.
    function b64u( buf )
    {
        var b = buf instanceof Uint8Array ? buf : new Uint8Array( buf ), s = "";
        for( var i = 0; i < b.length; i++ ) s += String.fromCharCode( b[ i ] );
        return btoa( s ).replace( /\+/g, "-" ).replace( /\//g, "_" ).replace( /=+$/, "" );
    }

    function bytes( txt )          // base64 or base64url
    {
        txt = String( txt ).replace( /-/g, "+" ).replace( /_/g, "/" );
        while( txt.length % 4 ) txt += "=";
        var s = atob( txt ), b = new Uint8Array( s.length );
        for( var i = 0; i < s.length; i++ ) b[ i ] = s.charCodeAt( i );
        return b;
    }

    // The browser's own words for a cancelled or failed passkey are long and odd.
    function error( e )
    {
        if( e && e.name === "NotAllowedError" )   return new Error( t( "ayni.pk.cancelled" ) );
        if( e && e.name === "InvalidStateError" ) return new Error( t( "ayni.pk.already" ) );
        if( e && e.name === "SecurityError" )     return new Error( t( "ayni.pk.https" ) );
        return e instanceof Error ? e : new Error( t( "ayni.pk.notConfirmed" ) );
    }

    function create( o )
    {
        if( ! supported() ) return Promise.reject( new Error( t( "ayni.pk.none" ) ) );

        var pk =
        {
            challenge: o.challenge,
            rp: { name: o.rpName },
            user: { id: o.userId, name: o.userName, displayName: o.displayName },
            pubKeyCredParams: [ { type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 } ],
            excludeCredentials: ( o.exclude || [] ).map( function ( id ) { return { type: "public-key", id: bytes( id ) }; } ),
            authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
            attestation: "none",
            timeout: 120000
        };
        if( o.rpId ) pk.rp.id = o.rpId;
        if( o.prf )  pk.extensions = { prf: o.prfSalt ? { eval: { first: o.prfSalt } } : {} };

        return navigator.credentials.create( { publicKey: pk } ).catch( function ( e ) { throw error( e ); } ).then( function ( cred )
        {
            var ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
            var prf = ext && ext.prf && "enabled" in ext.prf ? !! ext.prf.enabled : null;
            var out = ext && ext.prf && ext.prf.results && ext.prf.results.first;
            var tr  = cred.response && cred.response.getTransports ? cred.response.getTransports() : [];
            return { cred: cred, id: cred.id, transports: tr, prf: o.prf ? prf : null,
                     prfSecret: out ? new Uint8Array( out ) : null };
        } );
    }

    function get( o )
    {
        if( ! supported() ) return Promise.reject( new Error( t( "ayni.pk.none" ) ) );

        var pk =
        {
            challenge: o.challenge,
            allowCredentials: ( o.allow || [] ).map( function ( k )
            {
                var c = { type: "public-key", id: bytes( k.id ) };
                if( k.transports && k.transports.length ) c.transports = k.transports;
                return c;
            } ),
            userVerification: "required",
            timeout: 120000
        };
        if( o.rpId ) pk.rpId = o.rpId;
        if( o.prfSalts )
        {
            var by = {};
            Object.keys( o.prfSalts ).forEach( function ( id ) { by[ id ] = { first: o.prfSalts[ id ] }; } );
            pk.extensions = { prf: { evalByCredential: by } };
        }

        return navigator.credentials.get( { publicKey: pk } ).catch( function ( e ) { throw error( e ); } ).then( function ( cred )
        {
            var ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
            var out = ext && ext.prf && ext.prf.results && ext.prf.results.first;
            return { cred: cred, id: cred.id, prf: out ? new Uint8Array( out ) : null };
        } );
    }

    // -- the Passkeys dialog: list, add, remove ----------------------------
    //
    //   AyniPasskey.listDialog( {
    //       title,                       the dialog's title (default "Passkeys")
    //       lead,                        the hint above the list
    //       load()     -> Promise<[ { id, name, added, used } ]>
    //       add( name )   -> Promise     make one and keep it (the caller asks what it must)
    //       remove( key ) -> Promise     drop one
    //       empty( box, reload )         optional: draws what shows when there are none
    //                                    (default: the same list, empty, with Add);
    //                                    reload( note? ) shows the list, with that note
    //     The next ones are optional too; without them the dialog is as it always was:
    //       addLabel                     the Add button's label (default "Add")
    //       note( key ) -> text          shown before the dates of that row (e.g. its kind)
    //       extra( keys ) -> [ { label, icon, run( name ) -> Promise } ]
    //                                    more add buttons beside Add (e.g. another kind);
    //                                    run resolves to a note, or false (cancelled: no note)
    //   } )
    //
    // The caller's errors show under the list, as they are.

    function fmtDay( iso )
    {
        if( ! iso ) return "";
        var d = new Date( iso );
        return isNaN( d ) ? "" : d.toLocaleDateString( undefined, { year: "numeric", month: "short", day: "numeric" } );
    }

    function listDialog( o )
    {
        var d = Ayni.dialog( { title: o.title || t( "ayni.pk.title" ) } );
        var close = document.createElement( "button" );
        close.type = "button"; close.className = "btn"; close.setAttribute( "data-close", "" );
        close.setAttribute( "aria-label", t( "ayni.close" ) ); close.dataset.tip = t( "ayni.close" );
        close.innerHTML = Ayni.icon( "close" );
        d.place( [ close ] );
        d.show();

        function byId( id ) { return d.body.querySelector( "#" + id ); }

        function show( note )
        {
            d.body.innerHTML = '<p class="hint">' + t( "ayni.loading" ) + "</p>";
            o.load().then( function ( keys )
            {
                keys = keys || [];
                if( ! keys.length && o.empty )
                {
                    o.empty( d.body, function ( n ) { show( typeof n === "string" && n ? n : t( "ayni.pk.added" ) ); } );
                    return;
                }
                var extra = o.extra ? o.extra( keys ) || [] : [];

                var html = ( o.lead ? '<p class="hint"></p>' : "" ) + '<ul class="ayni-pk-list">';
                keys.forEach( function ( k, i )
                {
                    var when = fmtDay( k.added ) ? t( "ayni.pk.addedOn" ).replace( "{day}", fmtDay( k.added ) ) : "";
                    if( k.used ) when += ( when ? " · " : "" ) + t( "ayni.pk.usedOn" ).replace( "{day}", fmtDay( k.used ) );
                    html += '<li><span class="ayni-pk-name"></span>' +
                        '<span class="hint">' + when + "</span>" +
                        '<button type="button" class="btn" data-del="' + i + '">' + Ayni.icon( "trash" ) + "</button></li>";
                } );
                html += "</ul>" +
                    '<div class="ayni-pk-add">' +
                        '<input class="input" id="ayniPkNew" type="text" maxlength="60">' +
                        '<button type="button" class="btn text bordered" id="ayniPkAdd">' + Ayni.icon( "plus" ) +
                            '<span class="label"></span></button>' +
                        extra.map( function ( x, i )
                        {
                            return '<button type="button" class="btn text bordered" data-extra="' + i + '">' +
                                Ayni.icon( x.icon || "plus" ) + '<span class="label"></span></button>';
                        } ).join( "" ) +
                    "</div>" +
                    '<p class="hint" id="ayniPkNote"' + ( note ? "" : " hidden" ) + "></p>" +
                    '<p class="form-error" id="ayniPkErr" hidden></p>';
                d.body.innerHTML = html;

                if( o.lead ) d.body.querySelector( "p.hint" ).textContent = o.lead;
                d.body.querySelectorAll( ".ayni-pk-name" ).forEach( function ( el, i ) { el.textContent = keys[ i ].name; } );
                if( o.note ) d.body.querySelectorAll( ".ayni-pk-list li > .hint" ).forEach( function ( el, i )
                {
                    var n = o.note( keys[ i ] );
                    if( n ) el.textContent = n + ( el.textContent ? " · " + el.textContent : "" );
                } );
                d.body.querySelectorAll( "[data-del]" ).forEach( function ( b )
                {
                    b.setAttribute( "aria-label", t( "ayni.pk.remove" ) ); b.dataset.tip = t( "ayni.pk.remove" );
                } );
                var input = byId( "ayniPkNew" );
                input.placeholder = t( "ayni.pk.namePh" );
                input.setAttribute( "aria-label", t( "ayni.pk.nameLabel" ) );
                byId( "ayniPkAdd" ).querySelector( ".label" ).textContent = o.addLabel || t( "ayni.pk.add" );
                if( note ) byId( "ayniPkNote" ).textContent = note;

                function fail( e )
                {
                    d.body.querySelectorAll( "button" ).forEach( function ( b ) { b.disabled = false; } );
                    byId( "ayniPkErr" ).textContent = ( e && e.message ) || t( "ayni.pk.failed" );
                    byId( "ayniPkErr" ).hidden = false;
                }
                function busy()
                {
                    byId( "ayniPkErr" ).hidden = true;
                    d.body.querySelectorAll( "button" ).forEach( function ( b ) { b.disabled = true; } );
                }
                d.body.querySelectorAll( "[data-del]" ).forEach( function ( b )
                {
                    b.addEventListener( "click", function ()
                    {
                        var k = keys[ +b.dataset.del ];
                        busy();
                        Promise.resolve().then( function () { return o.remove( k ); } )
                            .then( function () { show( t( "ayni.pk.removed" ).replace( "{name}", k.name ) ); }, fail );
                    } );
                } );
                byId( "ayniPkAdd" ).addEventListener( "click", function ()
                {
                    var name = input.value.trim();
                    busy();
                    Promise.resolve().then( function () { return o.add( name ); } )
                        .then( function () { show( t( "ayni.pk.added" ) ); }, fail );
                } );
                d.body.querySelectorAll( "[data-extra]" ).forEach( function ( b )
                {
                    var x = extra[ +b.dataset.extra ];
                    b.querySelector( ".label" ).textContent = x.label;
                    b.addEventListener( "click", function ()
                    {
                        var name = input.value.trim();
                        busy();
                        Promise.resolve().then( function () { return x.run( name ); } )
                            .then( function ( n ) { show( typeof n === "string" ? n : "" ); }, fail );
                    } );
                } );
                Ayni.init( d.body );
            }, function ( e )
            {
                d.body.innerHTML = '<p class="form-error"></p>';
                d.body.firstChild.textContent = ( e && e.message ) || t( "ayni.pk.failed" );
            } );
        }
        show();
        return { close: function () { d.close(); }, reload: show };
    }

    window.AyniPasskey =
    {
        supported:  supported,
        prfMaybe:   prfMaybe,
        b64u:       b64u,
        bytes:      bytes,
        error:      error,
        create:     create,
        get:        get,
        listDialog: listDialog
    };
} )();
