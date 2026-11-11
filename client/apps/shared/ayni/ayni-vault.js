// DATA: this code decides what reaches the disk. Change it with care, and run your data tests.
/*
 * ayni-vault.js - ONE key for all the account's locked documents.
 *
 * Classic script, one global `AyniVault`. Load it deferred, after ayni-net.js,
 * ayni-crypt.js, ayni-passkey.js and ayni-dialogs.js.
 *
 * The VAULT KEY is 32 random bytes made in this browser. Every locked
 * document (ayni-crypt.js, v2) carries its own file key wrapped under it, so
 * one secret opens them all. The vault key itself never leaves the browser in
 * the clear: the server keeps it in data/vault.json only WRAPPED, three ways -
 *
 *   pw   the account's LOCK PASSWORD (never the sign-in password: the server
 *        sees that one at every sign-in, and could open the documents)
 *   rec  the RECOVERY CODE, shown once at set-up, for a forgotten password
 *   pk   one entry per PASSKEY: its PRF secret (the passkey's own, given only
 *        after the fingerprint/face/PIN) wraps the key. No server check is
 *        needed - without the right passkey there is no secret.
 *
 *   data/vault.json  { v: 1, id, created,
 *                      pw:  { iters, salt, iv, wrapped },
 *                      rec: { iters, salt, iv, wrapped },
 *                      pk:  [ { id, name, added, transports, salt, iv, wrapped } ] }
 *
 * Losing data/vault.json loses every locked document, so each change first
 * copies the version before it to data/vault.prev.json, and every write goes
 * over the version just read (AyniNet.updateJson): two tabs never drop each
 * other's change.
 *
 * The unlocked key lives in this tab's memory only, as a non-extractable
 * CryptoKey, and is never handed to another page: every window unlocks for
 * itself (a passkey makes that one touch). The screen locker (ayni-locked,
 * also when it is the desktop around this window) and "Lock now" make every
 * tab forget it.
 *
 * OFFLINE: the record (wrapped only, as on the server) is also kept in this
 * browser's localStorage, so a locked document opens with no connection.
 * Only unlocking reads that copy; a change always reads the server's.
 *
 * A record that is there but cannot be read (bad JSON, no id) is never written
 * over: set-up refuses, and says so - a new vault would orphan every document.
 * Changing the password, a passkey or the recovery code asks to unlock again:
 * the raw key is needed to wrap it, and is held only for that moment.
 *
 *   AyniVault.exists()        Promise<bool>  the account has a vault
 *   AyniVault.current()       { id, key } or null: unlocked in this tab
 *   AyniVault.unlock( o )     Promise<{ id, key } | null>  asks if needed; null = cancelled;
 *                             throws err.code "noVault" when the account has none.
 *                             o.name: the document asking (said in the dialog)
 *   AyniVault.ensure( o )     as unlock, but sets one up first when there is none
 *   AyniVault.forget()        this tab and the others forget the key
 *   AyniVault.manage()        the "Locked documents" dialog (Account)
 *   AyniVault.config( { path, appName } )
 */
( function ()
{
    "use strict";

    var CFG      = window.AyniVaultConfig || {};      // set before this loads, or later with config()
    var PATH     = CFG.path || "data/vault.json";
    var APP_NAME = CFG.appName || "Ayni";
    var ITERS    = 600000;           // PBKDF2 rounds, as ayni-crypt.js's
    var MIN_PW   = 10;               // the lock password opens everything: a bit longer than the usual 8
    var B32      = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // Crockford: no I, L, O, U

    var vault = null;                // { id: Uint8Array, key: CryptoKey } while unlocked in this tab
    var chan  = null;

    function t( k ) { return Ayni.t( k ); }
    function tf( k, v ) { return Ayni.t( k ).replace( /\{(\w+)\}/g, function ( m, n ) { return n in v ? v[ n ] : m; } ); }
    function b64u( x ) { return AyniPasskey.b64u( x ); }
    function bytes( x ) { return AyniPasskey.bytes( x ); }
    function prevPath() { return PATH.replace( /\.json$/, "" ) + ".prev.json"; }

    function config( o )
    {
        if( o && o.path )    PATH = o.path;
        if( o && o.appName ) APP_NAME = o.appName;
    }

    // ---- the record ------------------------------------------------------

    function damaged()
    {
        var e = new Error( t( "ayni.vault.damaged" ) );
        e.code = "damaged";
        return e;
    }

    // The account's record from the server: null = there is none. A record
    // that is there but is not one throws (code "damaged").
    async function readServer()
    {
        var r = await AyniNet.readJson( PATH );
        if( r === null ) return null;
        if( ! r || typeof r !== "object" || ! r.id || ! r.pw || ! r.rec ) throw damaged();
        keepCopy( r );
        return r;
    }

    // The copy in this browser, for unlocking with no connection.
    function copyKey()
    {
        var names = window.AyniNames || {};
        var who = ( window.AyniWho && AyniWho.atLoad ) || "";
        return ( names.key || "ayni-" ) + "vault:" + who + ":" + PATH;
    }
    function keepCopy( r ) { try { localStorage.setItem( copyKey(), JSON.stringify( r ) ); } catch ( e ) {} }
    function readCopy()
    {
        try { var r = JSON.parse( localStorage.getItem( copyKey() ) || "null" ); return r && r.id && r.pw && r.rec ? r : null; }
        catch ( e ) { return null; }
    }

    // For unlocking only: the server's, or - offline - this browser's copy.
    async function readRecord()
    {
        try { return await readServer(); }
        catch ( e )
        {
            if( e && e.code === "damaged" ) throw e;
            var c = readCopy();
            if( c ) return c;
            throw e;
        }
    }

    async function exists() { return !! await readRecord(); }

    function aad( id, kind )
    {
        return new TextEncoder().encode( "ayni-vault-v1:" + id + ":" + kind );
    }

    async function wrapWith( wrapKey, raw, id, kind )
    {
        var iv = crypto.getRandomValues( new Uint8Array( 12 ) );
        var w  = await crypto.subtle.encrypt( { name: "AES-GCM", iv: iv, additionalData: aad( id, kind ) }, wrapKey, raw );
        return { iv: b64u( iv ), wrapped: b64u( w ) };
    }

    async function unwrapWith( wrapKey, entry, id, kind )
    {
        return new Uint8Array( await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes( entry.iv ), additionalData: aad( id, kind ) }, wrapKey, bytes( entry.wrapped ) ) );
    }

    // A password (or a recovery code) -> a wrapping entry.
    async function wrapSecret( secret, raw, id, kind )
    {
        var salt = crypto.getRandomValues( new Uint8Array( 16 ) );
        var key  = await AyniCrypt.deriveKey( secret, salt, ITERS );
        var w    = await wrapWith( key, raw, id, kind );
        return { iters: ITERS, salt: b64u( salt ), iv: w.iv, wrapped: w.wrapped };
    }

    async function unwrapSecret( secret, entry, id, kind )
    {
        if( ! entry || entry.iters < 1000 || entry.iters > 5000000 ) throw new Error( "bad vault entry" );
        var key = await AyniCrypt.deriveKey( secret, bytes( entry.salt ), entry.iters );
        return unwrapWith( key, entry, id, kind );
    }

    // A passkey's PRF secret -> an AES key (HKDF: the PRF output is not used as a key as it is).
    async function prfKey( secret )
    {
        var base = await crypto.subtle.importKey( "raw", secret, "HKDF", false, [ "deriveKey" ] );
        return crypto.subtle.deriveKey(
            { name: "HKDF", hash: "SHA-256", salt: new Uint8Array( 0 ), info: new TextEncoder().encode( "ayni-vault-pk-v1" ) },
            base, { name: "AES-GCM", length: 256 }, false, [ "encrypt", "decrypt" ] );
    }

    // The recovery code: 120 random bits as 24 Crockford base32 characters, in sixes of four.
    function newCode()
    {
        var b = crypto.getRandomValues( new Uint8Array( 15 ) ), bits = 0, val = 0, out = "";
        for( var i = 0; i < b.length; i++ )
        {
            val = ( val << 8 ) | b[ i ]; bits += 8;
            while( bits >= 5 ) { out += B32[ ( val >>> ( bits - 5 ) ) & 31 ]; bits -= 5; }
        }
        return out.match( /.{4}/g ).join( "-" );
    }

    // What was typed -> the canonical code: case, spaces, dashes and the look-alikes do not matter.
    function normCode( s )
    {
        return String( s || "" ).toUpperCase().replace( /O/g, "0" ).replace( /[IL]/g, "1" ).replace( /[^0-9A-Z]/g, "" );
    }

    async function useRaw( raw, id )
    {
        var key = await crypto.subtle.importKey( "raw", raw, { name: "AES-GCM", length: 256 }, false, [ "encrypt", "decrypt" ] );
        return { id: bytes( id ), key: key };
    }

    // One change to the record: the version before it is copied aside first,
    // and the change goes over the version just read. `fn( rec )` changes rec
    // and returns nothing; it must only make its own change.
    async function change( id, fn )
    {
        var before = await AyniNet.readJson( PATH );
        if( ! before || before.id !== id ) throw new Error( t( "ayni.vault.changedElsewhere" ) );
        await AyniNet.writeJson( prevPath(), before );
        var out = await AyniNet.updateJson( PATH, function ( cur )
        {
            if( ! cur || cur.id !== id ) throw new Error( t( "ayni.vault.changedElsewhere" ) );
            fn( cur );
            return cur;
        } );
        keepCopy( out );
        return out;
    }

    // ---- other tabs: "Lock now" reaches them -------------------------------
    //
    // Only the order to forget travels; the key itself never does (any page of
    // this origin - a static site served beside the apps too - could ask for it).

    function channel()
    {
        if( chan || ! window.BroadcastChannel ) return chan;
        chan = new BroadcastChannel( "ayni-vault" );
        chan.onmessage = function ( e ) { if( e.data && e.data.forget ) vault = null; };
        return chan;
    }

    function forget()
    {
        vault = null;
        var c = channel();
        if( c ) try { c.postMessage( { forget: true } ); } catch ( e ) {}
    }

    // ---- the unlock dialog -----------------------------------------------
    //
    // ask( rec, o ) -> Promise<raw | null>. A passkey (if the record has any and
    // this browser can), the lock password, or - "Forgot it?" - the recovery
    // code, which then offers to set a new password.
    // o.lead: the words on top; o.title.

    function field( id, label, type )
    {
        return '<div class="field"><label for="' + id + '"></label>' +
               '<div class="input-group"><input class="input" id="' + id + '" type="' + type + '" autocomplete="' +
               ( type === "password" ? "current-password" : "off" ) + '" spellcheck="false" autocapitalize="none">' +
               ( type === "password" ? '<button type="button" class="btn" data-reveal></button>' : "" ) + "</div></div>";
    }

    function ask( rec, o )
    {
        return new Promise( function ( resolve )
        {
            var d = Ayni.dialog( { title: o.title || t( "ayni.vault.unlockTitle" ) } );
            var mode = "pw", busy = false, settled = false;
            var pks  = ( rec.pk || [] ).filter( function ( k ) { return k.id && k.salt; } );
            var canPk = pks.length && AyniPasskey.supported();

            function finish( v ) { if( settled ) return; settled = true; d.close(); resolve( v ); }

            var no = document.createElement( "button" ), ok = document.createElement( "button" );
            no.type = ok.type = "button";
            no.className = "btn"; no.setAttribute( "data-close", "" );
            no.innerHTML = Ayni.icon( "close" ); no.dataset.tip = t( "ayni.cancel" ); no.setAttribute( "aria-label", t( "ayni.cancel" ) );
            ok.className = "btn primary";
            ok.innerHTML = Ayni.icon( "check" ); ok.dataset.tip = t( "ayni.vault.open" ); ok.setAttribute( "aria-label", t( "ayni.vault.open" ) );
            d.place( [ no, ok ] );

            function q( id ) { return d.body.querySelector( "#" + id ); }
            function say( msg ) { var e = q( "ayniVaultErr" ); e.textContent = msg || ""; e.hidden = ! msg; }

            function draw()
            {
                var html = '<p class="hint" id="ayniVaultLead"></p>';
                if( mode === "pw" )
                {
                    if( canPk ) html += '<p><button type="button" class="btn text primary" id="ayniVaultPk">' + Ayni.icon( "key" ) +
                                        '<span class="label"></span></button></p>';
                    html += field( "ayniVaultPw", "", "password" ) +
                            '<p><button type="button" class="btn text sm" id="ayniVaultForgot"><span class="label"></span></button></p>';
                }
                else html += field( "ayniVaultCode", "", "text" );
                html += '<p class="form-error" id="ayniVaultErr" hidden></p>';
                d.body.innerHTML = html;

                q( "ayniVaultLead" ).textContent = mode === "pw" ? ( o.lead || t( "ayni.vault.unlockLead" ) ) : t( "ayni.vault.codeLead" );
                if( mode === "pw" )
                {
                    d.body.querySelector( 'label[for="ayniVaultPw"]' ).textContent = t( "ayni.vault.password" );
                    q( "ayniVaultForgot" ).querySelector( ".label" ).textContent = t( "ayni.vault.forgot" );
                    q( "ayniVaultForgot" ).addEventListener( "click", function () { mode = "code"; draw(); } );
                    if( canPk )
                    {
                        q( "ayniVaultPk" ).querySelector( ".label" ).textContent = t( "ayni.vault.usePasskey" );
                        q( "ayniVaultPk" ).addEventListener( "click", byPasskey );
                    }
                }
                else
                {
                    d.body.querySelector( 'label[for="ayniVaultCode"]' ).textContent = t( "ayni.vault.code" );
                    q( "ayniVaultCode" ).placeholder = "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX";
                }
                Ayni.init( d.body );
                setTimeout( function ()
                {
                    var f = canPk && mode === "pw" ? q( "ayniVaultPk" ) : q( mode === "pw" ? "ayniVaultPw" : "ayniVaultCode" );
                    if( f ) f.focus();
                }, 0 );
            }

            function setBusy( on )
            {
                busy = on;
                ok.disabled = on;
                d.body.querySelectorAll( "button, input" ).forEach( function ( b ) { b.disabled = on; } );
            }

            async function byPasskey()
            {
                if( busy ) return;
                setBusy( true ); say( "" );
                try
                {
                    var salts = {};
                    pks.forEach( function ( k ) { salts[ k.id ] = bytes( k.salt ); } );
                    var got = await AyniPasskey.get( { challenge: crypto.getRandomValues( new Uint8Array( 32 ) ),
                                                       allow: pks.map( function ( k ) { return { id: k.id, transports: k.transports }; } ),
                                                       prfSalts: salts } );
                    var k = pks.find( function ( x ) { return x.id === got.id; } );
                    if( ! k ) throw new Error( t( "ayni.vault.pkUnknown" ) );
                    if( ! got.prf ) throw new Error( t( "ayni.vault.pkNoPrf" ) );
                    var raw = await unwrapWith( await prfKey( got.prf ), k, rec.id, "pk:" + k.id );
                    finish( raw );
                }
                catch ( e )
                {
                    setBusy( false );
                    say( e && e.name === "OperationError" ? t( "ayni.vault.pkNoPrf" ) : ( ( e && e.message ) || t( "ayni.pk.notConfirmed" ) ) );
                }
            }

            async function submit()
            {
                if( busy ) return;
                var pw = mode === "pw" ? q( "ayniVaultPw" ).value : normCode( q( "ayniVaultCode" ).value );
                if( ! pw ) { q( mode === "pw" ? "ayniVaultPw" : "ayniVaultCode" ).focus(); return; }
                setBusy( true ); say( "" );
                try
                {
                    var raw = mode === "pw" ? await unwrapSecret( pw, rec.pw, rec.id, "pw" )
                                            : await unwrapSecret( pw, rec.rec, rec.id, "rec" );
                    if( mode === "code" ) raw.fromCode = true;
                    finish( raw );
                }
                catch ( e )
                {
                    setBusy( false );
                    say( t( mode === "pw" ? "ayni.vault.wrongPw" : "ayni.vault.wrongCode" ) );
                    var f = q( mode === "pw" ? "ayniVaultPw" : "ayniVaultCode" );
                    f.select(); f.focus();
                }
            }

            ok.addEventListener( "click", submit );
            no.addEventListener( "click", function () { finish( null ); } );
            d.dialog.addEventListener( "close", function () { finish( null ); } );
            d.body.addEventListener( "keydown", function ( e )
            {
                if( e.key === "Enter" && e.target.tagName === "INPUT" ) { e.preventDefault(); submit(); }
            } );
            d.show();
            draw();
        } );
    }

    // After the recovery code: a new lock password, now (cancel = keep the old one).
    async function offerNewPassword( rec, raw )
    {
        var pw = await Ayni.ask( { password: true, verify: true, min: MIN_PW,
                                   title: t( "ayni.vault.newPwTitle" ), lead: t( "ayni.vault.newPwLead" ),
                                   okTip: t( "ayni.vault.save" ) } );
        if( pw === null ) return;
        try
        {
            var w = await wrapSecret( pw, raw, rec.id, "pw" );
            await change( rec.id, function ( cur ) { cur.pw = w; } );
            Ayni.toast( "ok", t( "ayni.vault.pwChanged" ) );
        }
        catch ( e ) { Ayni.toast( "err", ( e && e.message ) || t( "ayni.vault.saveFailed" ) ); }
    }

    // ---- unlock / set up -------------------------------------------------

    async function unlock( o )
    {
        o = o || {};
        if( vault ) return vault;
        var rec = await readRecord();
        if( ! rec ) { var none = new Error( t( "ayni.vault.none" ) ); none.code = "noVault"; throw none; }

        var raw = await ask( rec, { lead: o.name ? tf( "ayni.vault.unlockFor", { name: o.name } ) : null } );
        if( ! raw ) return null;
        try
        {
            vault = await useRaw( raw, rec.id );
            if( raw.fromCode ) await offerNewPassword( rec, raw );
        }
        finally { raw.fill( 0 ); }
        channel();
        return vault;
    }

    // Asks again even when unlocked: the raw key, for a change to the record.
    // fn( rec, raw ) -> Promise. False = cancelled.
    async function withRaw( fn )
    {
        var rec = await readServer();
        if( ! rec ) throw new Error( t( "ayni.vault.none" ) );
        var raw = await ask( rec, { title: t( "ayni.vault.confirmTitle" ), lead: t( "ayni.vault.confirmLead" ) } );
        if( ! raw ) return false;
        try
        {
            if( ! vault ) { vault = await useRaw( raw, rec.id ); channel(); }
            await fn( rec, raw );
            return true;
        }
        finally { raw.fill( 0 ); }
    }

    // The recovery code, once: copy it, print it, or write it down.
    function showCode( code, again )
    {
        return new Promise( function ( resolve )
        {
            var d = Ayni.dialog( { title: t( again ? "ayni.vault.newCodeTitle" : "ayni.vault.codeTitle" ) } );
            d.body.innerHTML = '<p class="hint"></p><pre class="ayni-vault-code"></pre>' +
                '<p><button type="button" class="btn text bordered sm" id="ayniVaultCopy">' + Ayni.icon( "copy" ) + '<span class="label"></span></button></p>';
            d.body.querySelector( "p.hint" ).textContent = t( "ayni.vault.codeBody" );
            d.body.querySelector( "pre" ).textContent = code;
            d.body.querySelector( "#ayniVaultCopy .label" ).textContent = t( "ayni.vault.copy" );

            // One way out, and it says what it means: the code is never shown again.
            var ok = document.createElement( "button" );
            ok.type = "button"; ok.className = "btn text primary";
            ok.innerHTML = Ayni.icon( "check" ) + '<span class="label"></span>';
            ok.querySelector( ".label" ).textContent = t( "ayni.vault.codeSaved" );
            d.place( [ ok ] );

            d.body.querySelector( "#ayniVaultCopy" ).addEventListener( "click", function ()
            {
                navigator.clipboard.writeText( code ).then( function () { Ayni.toast( "ok", t( "ayni.vault.copied" ) ); }, function () {} );
            } );
            // No Esc: the code is never shown again.
            d.dialog.addEventListener( "cancel", function ( e ) { e.preventDefault(); } );
            ok.addEventListener( "click", function () { if( d.close() ) resolve(); } );
            d.show();
        } );
    }

    async function setUp()
    {
        var go = await Ayni.ask( { password: true, verify: true, min: MIN_PW,
                                   title: t( "ayni.vault.setupTitle" ), lead: t( "ayni.vault.setupLead" ),
                                   okTip: t( "ayni.vault.next" ) } );
        if( go === null ) return null;

        var raw  = crypto.getRandomValues( new Uint8Array( 32 ) );
        var id   = b64u( crypto.getRandomValues( new Uint8Array( 16 ) ) );
        var code = newCode();
        try
        {
            var rec = { v: 1, id: id, created: new Date().toISOString(),
                        pw:  await wrapSecret( go, raw, id, "pw" ),
                        rec: await wrapSecret( normCode( code ), raw, id, "rec" ),
                        pk:  [] };
            go = null;

            // Only where there is none: a vault made a moment ago by another
            // tab or device is never written over (its documents would be lost).
            // A file that is there but is not a vault is not ours to replace either.
            var won = true;
            await AyniNet.updateJson( PATH, function ( cur )
            {
                if( cur !== null ) { won = false; return false; }
                return rec;
            } );
            if( ! won )
            {
                var there = await readServer();          // throws "damaged" for a file that is not a vault
                if( ! there ) throw damaged();
                Ayni.toast( "warn", t( "ayni.vault.madeElsewhere" ) );
                return unlock();
            }
            keepCopy( rec );

            vault = await useRaw( raw, id );
            channel();
            await showCode( code );

            if( AyniPasskey.supported() && await AyniPasskey.prfMaybe() &&
                await Ayni.confirm( { title: t( "ayni.vault.pkOfferTitle" ), body: t( "ayni.vault.pkOfferBody" ),
                                      confirm: t( "ayni.vault.addPasskey" ), cancel: t( "ayni.vault.later" ) } ) )
            {
                try { await addPasskey( rec, raw, "" ); Ayni.toast( "ok", t( "ayni.pk.added" ) ); }
                catch ( e ) { Ayni.toast( "warn", ( e && e.message ) || t( "ayni.pk.failed" ) ); }
            }
            return vault;
        }
        finally { raw.fill( 0 ); }
    }

    async function ensure( o )
    {
        if( vault ) return vault;
        // exists() is false only when the SERVER said there is none (the
        // offline copy never says that): only then is one made.
        if( await exists() ) return unlock( o );
        return setUp();
    }

    // ---- passkeys ----------------------------------------------------------

    async function addPasskey( rec, raw, name )
    {
        var salt = crypto.getRandomValues( new Uint8Array( 32 ) );
        var uid  = new Uint8Array( await crypto.subtle.digest( "SHA-256", new TextEncoder().encode( "ayni-vault:" + rec.id ) ) ).slice( 0, 16 );
        var who  = ( window.AyniWho && AyniWho.atLoad ) || "";
        var made = await AyniPasskey.create(
        {
            challenge: crypto.getRandomValues( new Uint8Array( 32 ) ),
            rpName: APP_NAME, userId: uid,
            userName: ( who ? who + " · " : "" ) + t( "ayni.vault.pkUser" ),
            displayName: ( who ? who + " · " : "" ) + t( "ayni.vault.pkUser" ),
            exclude: ( rec.pk || [] ).map( function ( k ) { return k.id; } ),
            prf: true, prfSalt: salt
        } );
        if( made.prf === false ) throw new Error( t( "ayni.vault.pkNoPrf" ) );

        // The secret: given at creation by some authenticators, by a first use by the others.
        var secret = made.prfSecret;
        if( ! secret )
        {
            var s = {}; s[ made.id ] = salt;
            var got = await AyniPasskey.get( { challenge: crypto.getRandomValues( new Uint8Array( 32 ) ),
                                               allow: [ { id: made.id, transports: made.transports } ], prfSalts: s } );
            if( ! got.prf ) throw new Error( t( "ayni.vault.pkNoPrf" ) );
            secret = got.prf;
        }

        var w = await wrapWith( await prfKey( secret ), raw, rec.id, "pk:" + made.id );
        var entry = { id: made.id, name: name || defaultPkName(), added: new Date().toISOString(),
                      transports: made.transports || [], salt: b64u( salt ), iv: w.iv, wrapped: w.wrapped };
        await change( rec.id, function ( cur ) { cur.pk = ( cur.pk || [] ).filter( function ( k ) { return k.id !== entry.id; } ).concat( [ entry ] ); } );
    }

    function defaultPkName()
    {
        var ua = navigator.userAgent;
        var dev = /iPhone/.test( ua ) ? "iPhone" : /iPad/.test( ua ) ? "iPad" : /Android/.test( ua ) ? "Android" :
                  /Mac/.test( ua ) ? "Mac" : /Windows/.test( ua ) ? "Windows" : /Linux/.test( ua ) ? "Linux" : t( "ayni.vault.pkUser" );
        return dev + " · " + new Date().toLocaleDateString();
    }

    function passkeysDialog()
    {
        AyniPasskey.listDialog(
        {
            lead: t( "ayni.vault.pkLead" ),
            load: function () { return readServer().then( function ( r ) { return r ? r.pk || [] : []; } ); },
            add: function ( name )
            {
                return withRaw( function ( rec, raw ) { return addPasskey( rec, raw, name ); } )
                    .then( function ( done ) { if( ! done ) throw new Error( t( "ayni.pk.cancelled" ) ); } );
            },
            remove: function ( k )
            {
                return readServer().then( function ( rec )
                {
                    if( ! rec ) throw new Error( t( "ayni.vault.none" ) );
                    return change( rec.id, function ( cur ) { cur.pk = ( cur.pk || [] ).filter( function ( x ) { return x.id !== k.id; } ); } );
                } );
            }
        } );
    }

    // ---- the "Locked documents" dialog (Account) ---------------------------

    function manage()
    {
        var d = Ayni.dialog( { title: t( "ayni.vault.title" ) } );
        var x = document.createElement( "button" );
        x.type = "button"; x.className = "btn"; x.setAttribute( "data-close", "" );
        x.innerHTML = Ayni.icon( "close" ); x.dataset.tip = t( "ayni.close" ); x.setAttribute( "aria-label", t( "ayni.close" ) );
        d.place( [ x ] );
        d.show();

        // label and btn are escaped already (esc).
        function row( id, label, btn )
        {
            return '<div class="ayni-vault-row"><span>' + label + '</span>' +
                   '<button type="button" class="btn text bordered sm" id="' + id + '">' + btn + "</button></div>";
        }

        function esc( s ) { var e = document.createElement( "span" ); e.textContent = s; return e.innerHTML; }

        async function draw()
        {
            d.body.innerHTML = '<p class="hint">' + esc( t( "ayni.loading" ) ) + "</p>";
            var rec;
            try { rec = await readServer(); }
            catch ( e ) { d.body.innerHTML = '<p class="form-error"></p>'; d.body.firstChild.textContent = t( e && e.code === "damaged" ? "ayni.vault.damaged" : "ayni.vault.readFailed" ); return; }

            if( ! rec )
            {
                d.body.innerHTML = '<p class="hint">' + esc( t( "ayni.vault.noneLead" ) ) + "</p>" +
                                   row( "ayniVaultSetup", esc( t( "ayni.vault.title" ) ), esc( t( "ayni.vault.setup" ) ) );
                d.body.querySelector( "#ayniVaultSetup" ).addEventListener( "click", function ()
                {
                    setUp().then( draw, function ( e ) { Ayni.toast( "err", ( e && e.message ) || t( "ayni.vault.saveFailed" ) ); } );
                } );
                return;
            }

            d.body.innerHTML = '<p class="hint">' + esc( t( "ayni.vault.lead" ) ) + "</p>" +
                row( "ayniVaultPwBtn",   esc( t( "ayni.vault.password" ) ), esc( t( "ayni.vault.change" ) ) ) +
                row( "ayniVaultPkBtn",   esc( t( "ayni.pk.title" ) ) + " (" + ( rec.pk || [] ).length + ")", esc( t( "ayni.vault.manage" ) ) ) +
                row( "ayniVaultCodeBtn", esc( t( "ayni.vault.code" ) ), esc( t( "ayni.vault.newCode" ) ) ) +
                row( "ayniVaultLockBtn", esc( vault ? t( "ayni.vault.isOpen" ) : t( "ayni.vault.isShut" ) ), esc( t( "ayni.vault.lockNow" ) ) );
            var lockBtn = d.body.querySelector( "#ayniVaultLockBtn" );
            lockBtn.disabled = ! vault;

            function fail( e ) { if( e ) Ayni.toast( "err", ( e && e.message ) || t( "ayni.vault.saveFailed" ) ); }

            d.body.querySelector( "#ayniVaultPwBtn" ).addEventListener( "click", function ()
            {
                withRaw( async function ( r, raw )
                {
                    var pw = await Ayni.ask( { password: true, verify: true, min: MIN_PW, title: t( "ayni.vault.newPwTitle" ),
                                               lead: t( "ayni.vault.setupLead" ), okTip: t( "ayni.vault.save" ) } );
                    if( pw === null ) return;
                    var w = await wrapSecret( pw, raw, r.id, "pw" );
                    await change( r.id, function ( cur ) { cur.pw = w; } );
                    Ayni.toast( "ok", t( "ayni.vault.pwChanged" ) );
                } ).then( draw, fail );
            } );
            d.body.querySelector( "#ayniVaultPkBtn" ).addEventListener( "click", function ()
            {
                if( ! AyniPasskey.supported() ) { Ayni.toast( "warn", t( "ayni.pk.none" ) ); return; }
                passkeysDialog();
            } );
            d.body.querySelector( "#ayniVaultCodeBtn" ).addEventListener( "click", function ()
            {
                withRaw( async function ( r, raw )
                {
                    var code = newCode();
                    var w = await wrapSecret( normCode( code ), raw, r.id, "rec" );
                    await change( r.id, function ( cur ) { cur.rec = w; } );
                    await showCode( code, true );
                } ).then( draw, fail );
            } );
            lockBtn.addEventListener( "click", function ()
            {
                forget();
                Ayni.toast( "ok", t( "ayni.vault.locked" ) );
                draw();
            } );
            Ayni.init( d.body );
        }
        draw();
    }

    // ---- the screen locker: forget the key -----------------------------------

    function watchLocker()
    {
        var pages = [ document.documentElement ];
        try { if( window.top !== window && window.top.document ) pages.push( window.top.document.documentElement ); } catch ( e ) {}
        pages.forEach( function ( html )
        {
            new MutationObserver( function ()
            {
                if( vault && html.classList.contains( "ayni-locked" ) ) forget();
            } ).observe( html, { attributes: true, attributeFilter: [ "class" ] } );
        } );
    }
    if( document.readyState === "loading" ) document.addEventListener( "DOMContentLoaded", watchLocker );
    else watchLocker();
    channel();

    window.AyniVault =
    {
        config:  config,
        exists:  exists,
        current: function () { return vault; },
        unlock:  unlock,
        ensure:  ensure,
        forget:  forget,
        manage:  manage,
        _code:   { make: newCode, norm: normCode }      // for the tests
    };
} )();
