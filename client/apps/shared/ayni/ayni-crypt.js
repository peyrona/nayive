/*
 * crypt.js - a document locked with a password.
 *
 * Classic script, one global `AyniCrypt`. Load it deferred, before office.js:
 *     <script src="../ayni-crypt.js" defer></script>
 *     <script src="../shared/office.js" defer></script>
 *
 * Write, Calc and Text save through one pipeline (shared/office.js, AUTOSAVE).
 * A locked document goes through this module on the way out and on the way
 * back: the bytes that leave the browser are AES-256-GCM ciphertext and the
 * password never does. The server, its backups and its logs only ever see the
 * sealed blob - there is no key anywhere but in this tab's memory.
 *
 *   TWO VERSIONS
 *
 * v1 (below): the key comes from the document's OWN password. Forgotten
 * password = lost document. Still read; no longer written for a new lock.
 *
 * v2: the document has its own random FILE KEY, and the header carries it
 * wrapped (AES-GCM) under the account's VAULT KEY (ayni-vault.js). The vault
 * key opens with the account's lock password, a passkey or the recovery code,
 * so one secret opens every locked document and a forgotten password is not a
 * lost document. The file key stays the same for the document's life; the IV
 * is fresh on every save.
 *
 *   AYNI-LOCKED-BI2\n | vaultId | wrapIv | wrapped file key | iv | ciphertext+tag
 *          16             16        12        32 + 16 tag     12
 *
 *   AYNI-LOCKED-B62\n + base64( the whole blob above )
 *
 * The 104-byte header is the GCM `additionalData` of the body; the wrap's own
 * additionalData is "ayni-file-key-v2" + vaultId. A document of another vault
 * (another account) says so (err.code "otherVault") instead of "damaged".
 *
 *   var lock = await AyniCrypt.newDocLock( vault );         // vault = { id, key } (ayni-vault.js)
 *   var lock = await AyniCrypt.docLockFrom( vault, body );  // an open one: its file key
 *   seal( lock, body ) / unseal( lock, body ) as below; unseal of a v2 body
 *   with a v2 lock opens it whatever file key it has, as long as the vault is the same
 *   (a .bak from before the padlock went off and on again). A v2 lock with
 *   `v1` (the document's old password lock) also opens that one's v1 bodies.
 *
 * The key comes from the password with PBKDF2-SHA-256 and a random 16-byte
 * salt, one derivation per document (not per save: at 600 000 rounds that is
 * about a second of CPU, and autosave runs every 7 s). The salt stays with the
 * document for its whole life; the 12-byte IV is fresh on every single save,
 * which is what GCM actually requires.
 *
 *   TWO FORMS, one per kind of body
 *
 * Write and Calc hand the pipeline bytes; Text hands it a string, and its
 * store keeps text, not bytes. So a sealed body comes back in the shape it
 * went in:
 *
 *   AYNI-LOCKED-BIN\n | iters | salt | iv | ciphertext+tag     (Uint8Array)
 *          16           4 BE     16    12
 *
 *   AYNI-LOCKED-B64\n + base64( the whole blob above )         (String)
 *
 * The 48-byte header is the GCM `additionalData`, so a tampered salt, IV or
 * round count fails the tag instead of quietly decrypting to rubbish. Both
 * magics are plain ASCII: looksLocked() recognises a locked file from its
 * first bytes whichever way it was read (Text's .bak is read as bytes), and
 * unseal() gives back a string for B64 and a Uint8Array for BIN - the shape
 * the editor's load() expects.
 *
 *   var lock = await AyniCrypt.newLock( password );        // a new document
 *   var lock = await AyniCrypt.lockFrom( password, body ); // an open one: the salt is in it
 *   var out  = await AyniCrypt.seal( lock, body );
 *   var back = await AyniCrypt.unseal( lock, out );        // throws on a wrong password
 */
( function ()
{
    "use strict";

    var MAGIC_BIN = ( window.AyniCryptMagic && window.AyniCryptMagic[ 0 ] ) || "AYNI-LOCKED-BIN\n";       // 16 bytes, raw bytes follow
    var MAGIC_B64 = ( window.AyniCryptMagic && window.AyniCryptMagic[ 1 ] ) || "AYNI-LOCKED-B64\n";       // 16 bytes, base64 of a BIN blob follows
    var MAGIC_BI2 = ( window.AyniCryptMagic && window.AyniCryptMagic[ 2 ] ) || "AYNI-LOCKED-BI2\n";       // v2: 16 bytes, raw bytes follow
    var MAGIC_B62 = ( window.AyniCryptMagic && window.AyniCryptMagic[ 3 ] ) || "AYNI-LOCKED-B62\n";       // v2: base64 of a BI2 blob follows

    var ITERS     = 600000;                    // PBKDF2 rounds for a NEW lock
    var MAX_ITERS = 5000000;                   // a header asking for more is refused, not obeyed
    var SALT_LEN  = 16;
    var IV_LEN    = 12;
    var HEAD_LEN  = 48;                        // magic 16 + iters 4 + salt 16 + iv 12
    var ID_LEN    = 16;                        // v2: the vault's id
    var WRAP_LEN  = 48;                        // v2: the file key (32) + its GCM tag (16)
    var HEAD2_LEN = 104;                       // v2: magic 16 + vaultId 16 + wrapIv 12 + wrapped 48 + iv 12
    var KEY_HEAD2 = HEAD2_LEN - IV_LEN;        // v2: the part of the header that is the same on every save
    var WRAP_AAD  = "ayni-file-key-v2";

    function available()
    {
        return !! ( window.crypto && window.crypto.subtle && window.crypto.getRandomValues );
    }

    // Both magics are ASCII, so one comparison covers a string and its bytes.
    function startsWith( body, magic )
    {
        if( typeof body === "string" ) return body.lastIndexOf( magic, 0 ) === 0;
        if( ! body || body.length < magic.length ) return false;

        for( var i = 0; i < magic.length; i++ )
            if( body[ i ] !== magic.charCodeAt( i ) ) return false;
        return true;
    }

    function looksLocked( body )
    {
        return startsWith( body, MAGIC_BIN ) || startsWith( body, MAGIC_B64 ) || isV2( body );
    }

    // Sealed under a vault (v2), not a password of its own (v1).
    function isV2( body )
    {
        return startsWith( body, MAGIC_BI2 ) || startsWith( body, MAGIC_B62 );
    }

    function asBytes( x )
    {
        if( typeof x === "string" )      return new TextEncoder().encode( x );
        if( x instanceof Uint8Array )    return x;
        if( x instanceof ArrayBuffer )   return new Uint8Array( x );
        if( x && x.buffer )              return new Uint8Array( x.buffer, x.byteOffset, x.byteLength );
        return new Uint8Array( 0 );
    }

    // btoa() takes a binary string, and String.fromCharCode.apply blows the
    // call stack on a big one - so it goes in chunks.
    function toBase64( bytes )
    {
        var out = "", CH = 0x8000;
        for( var i = 0; i < bytes.length; i += CH )
            out += String.fromCharCode.apply( null, bytes.subarray( i, i + CH ) );
        return btoa( out );
    }

    function fromBase64( text )
    {
        var bin = atob( String( text ).replace( /\s+/g, "" ) );
        var out = new Uint8Array( bin.length );
        for( var i = 0; i < bin.length; i++ ) out[ i ] = bin.charCodeAt( i );
        return out;
    }

    // Whatever form came in -> the BIN blob, plus which form it was.
    function toBlob( body )
    {
        if( startsWith( body, MAGIC_B64 ) || startsWith( body, MAGIC_B62 ) )
        {
            var text = typeof body === "string" ? body : new TextDecoder().decode( asBytes( body ) );
            return { blob: fromBase64( text.slice( MAGIC_B64.length ) ), text: true };
        }
        if( startsWith( body, MAGIC_BIN ) || startsWith( body, MAGIC_BI2 ) ) return { blob: asBytes( body ), text: false };

        throw new Error( "not a locked document" );
    }

    // The salt, the round count and the IV of a sealed blob.
    function readHead( blob )
    {
        if( blob.length < HEAD_LEN ) throw new Error( "locked document is truncated" );

        var view  = new DataView( blob.buffer, blob.byteOffset, blob.byteLength );
        var iters = view.getUint32( MAGIC_BIN.length, false );

        // A forged header could otherwise ask for 4 000 million rounds and hang
        // the tab for hours. Nothing we write needs more than MAX_ITERS.
        if( iters < 1000 || iters > MAX_ITERS ) throw new Error( "locked document header is not ours" );

        return {
            iters: iters,
            salt:  blob.slice( 20, 20 + SALT_LEN ),
            iv:    blob.slice( 36, 36 + IV_LEN ),
            head:  blob.slice( 0, HEAD_LEN ),
            body:  blob.subarray( HEAD_LEN )
        };
    }

    // v2: the vault id, the wrapped file key and this save's IV.
    function readHead2( blob )
    {
        if( blob.length < HEAD2_LEN ) throw new Error( "locked document is truncated" );
        for( var i = 0; i < MAGIC_BI2.length; i++ )
            if( blob[ i ] !== MAGIC_BI2.charCodeAt( i ) ) throw new Error( "locked document header is not ours" );

        var at = MAGIC_BI2.length;
        return {
            vaultId: blob.slice( at, at + ID_LEN ),
            wrapIv:  blob.slice( at + ID_LEN, at + ID_LEN + IV_LEN ),
            wrapped: blob.slice( at + ID_LEN + IV_LEN, KEY_HEAD2 ),
            keyHead: blob.slice( 0, KEY_HEAD2 ),
            iv:      blob.slice( KEY_HEAD2, HEAD2_LEN ),
            head:    blob.slice( 0, HEAD2_LEN ),
            body:    blob.subarray( HEAD2_LEN )
        };
    }

    function sameBytes( a, b )
    {
        if( ! a || ! b || a.length !== b.length ) return false;
        for( var i = 0; i < a.length; i++ ) if( a[ i ] !== b[ i ] ) return false;
        return true;
    }

    function wrapAad( vaultId )
    {
        var tag = new TextEncoder().encode( WRAP_AAD ), out = new Uint8Array( tag.length + vaultId.length );
        out.set( tag, 0 );
        out.set( vaultId, tag.length );
        return out;
    }

    function otherVault()
    {
        var e = new Error( "locked with another account's key" );
        e.code = "otherVault";
        return e;
    }

    async function deriveKey( password, salt, iters )
    {
        var base = await crypto.subtle.importKey( "raw", new TextEncoder().encode( String( password ) ),
                                                  "PBKDF2", false, [ "deriveKey" ] );

        return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt: salt, iterations: iters, hash: "SHA-256" },
            base,
            { name: "AES-GCM", length: 256 },
            false,
            [ "encrypt", "decrypt" ] );
    }

    // A lock for a document that has none yet: its own random salt.
    async function newLock( password )
    {
        var salt = crypto.getRandomValues( new Uint8Array( SALT_LEN ) );
        return { key: await deriveKey( password, salt, ITERS ), salt: salt, iters: ITERS };
    }

    // The lock of a document we just read: its salt and round count, our
    // password. A wrong password derives a wrong key and unseal() throws.
    async function lockFrom( password, body )
    {
        var h = readHead( toBlob( body ).blob );
        return { key: await deriveKey( password, h.salt, h.iters ), salt: h.salt, iters: h.iters };
    }

    // ---- v2: a file key wrapped under the vault --------------------------

    // A new document's lock: a fresh random file key, wrapped once.
    async function newDocLock( vault )
    {
        var raw = crypto.getRandomValues( new Uint8Array( 32 ) );
        try
        {
            var wrapIv  = crypto.getRandomValues( new Uint8Array( IV_LEN ) );
            var wrapped = new Uint8Array( await crypto.subtle.encrypt(
                              { name: "AES-GCM", iv: wrapIv, additionalData: wrapAad( vault.id ) }, vault.key, raw ) );
            var fileKey = await crypto.subtle.importKey( "raw", raw, { name: "AES-GCM", length: 256 }, false, [ "encrypt", "decrypt" ] );

            var keyHead = new Uint8Array( KEY_HEAD2 ), at = 0;
            for( var i = 0; i < MAGIC_BI2.length; i++ ) keyHead[ i ] = MAGIC_BI2.charCodeAt( i );
            at = MAGIC_BI2.length;
            keyHead.set( vault.id, at );           at += ID_LEN;
            keyHead.set( wrapIv, at );             at += IV_LEN;
            keyHead.set( wrapped, at );

            return { v: 2, vault: vault, fileKey: fileKey, keyHead: keyHead };
        }
        finally { raw.fill( 0 ); }
    }

    // The lock of a v2 document we just read: its own file key, unwrapped
    // with the vault. Throws err.code "otherVault" for another vault's file,
    // and a plain error for a damaged or tampered one.
    async function docLockFrom( vault, body ) { return lockFromBlob( vault, toBlob( body ).blob ); }

    async function lockFromBlob( vault, blob )
    {
        var h = readHead2( blob );
        if( ! sameBytes( h.vaultId, vault.id ) ) throw otherVault();

        var raw = new Uint8Array( await crypto.subtle.decrypt(
                      { name: "AES-GCM", iv: h.wrapIv, additionalData: wrapAad( vault.id ) }, vault.key, h.wrapped ) );
        try
        {
            var fileKey = await crypto.subtle.importKey( "raw", raw, { name: "AES-GCM", length: 256 }, false, [ "encrypt", "decrypt" ] );
            return { v: 2, vault: vault, fileKey: fileKey, keyHead: h.keyHead };
        }
        finally { raw.fill( 0 ); }
    }

    // The vault id a v2 document was sealed under (Uint8Array), or null.
    function vaultIdOf( body )
    {
        if( ! isV2( body ) ) return null;
        try { return readHead2( toBlob( body ).blob ).vaultId; } catch ( e ) { return null; }
    }

    async function seal2( lock, body )
    {
        var plain = asBytes( body );
        var iv    = crypto.getRandomValues( new Uint8Array( IV_LEN ) );
        var head  = new Uint8Array( HEAD2_LEN );
        head.set( lock.keyHead, 0 );
        head.set( iv, KEY_HEAD2 );

        var ct   = new Uint8Array( await crypto.subtle.encrypt(
                       { name: "AES-GCM", iv: iv, additionalData: head }, lock.fileKey, plain ) );
        var blob = new Uint8Array( HEAD2_LEN + ct.length );
        blob.set( head, 0 );
        blob.set( ct, HEAD2_LEN );

        return typeof body === "string" ? MAGIC_B62 + toBase64( blob ) : blob;
    }

    async function unseal2( lock, form )
    {
        var h = readHead2( form.blob );
        if( ! lock || lock.v !== 2 ) throw new Error( "a vault document needs the vault" );

        // Its own file key, or - a copy from an earlier lock of the same
        // document - the one in its header, opened with the same vault.
        var key = sameBytes( h.keyHead, lock.keyHead ) ? lock.fileKey
                                                       : ( await lockFromBlob( lock.vault, form.blob ) ).fileKey;
        var plain = new Uint8Array( await crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: h.iv, additionalData: h.head }, key, h.body ) );

        return form.text ? new TextDecoder().decode( plain ) : plain;
    }

    // Bytes in -> the BIN form; a string in -> the B64 form.
    // A v2 lock writes v2 (BI2 / B62).
    async function seal( lock, body )
    {
        if( lock && lock.v === 2 ) return seal2( lock, body );

        var plain = asBytes( body );
        var iv    = crypto.getRandomValues( new Uint8Array( IV_LEN ) );
        var head  = new Uint8Array( HEAD_LEN );

        for( var i = 0; i < MAGIC_BIN.length; i++ ) head[ i ] = MAGIC_BIN.charCodeAt( i );
        new DataView( head.buffer ).setUint32( MAGIC_BIN.length, lock.iters, false );
        head.set( lock.salt, 20 );
        head.set( iv, 36 );

        var ct   = new Uint8Array( await crypto.subtle.encrypt(
                       { name: "AES-GCM", iv: iv, additionalData: head }, lock.key, plain ) );
        var blob = new Uint8Array( HEAD_LEN + ct.length );
        blob.set( head, 0 );
        blob.set( ct, HEAD_LEN );

        return typeof body === "string" ? MAGIC_B64 + toBase64( blob ) : blob;
    }

    // The BIN form -> bytes; the B64 form -> a string. Throws on a wrong
    // password, a damaged file or a tampered header - the caller cannot tell
    // them apart, and neither can anyone else: that is what the tag is for.
    async function unseal( lock, body )
    {
        var form  = toBlob( body );
        if( isV2( body ) ) return unseal2( lock, form );
        // A document that moved from its own password to the vault keeps the
        // old key beside the new one (lock.v1) for this session: its .bak from
        // before the move still opens, and the padlock off can put it back plain.
        if( lock && lock.v === 2 )
        {
            if( ! lock.v1 ) throw new Error( "a password document needs its password" );
            lock = lock.v1;
        }
        var h     = readHead( form.blob );
        var plain = new Uint8Array( await crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: h.iv, additionalData: h.head }, lock.key, h.body ) );

        return form.text ? new TextDecoder().decode( plain ) : plain;
    }

    window.AyniCrypt = {
        available:   available,
        looksLocked: looksLocked,
        isV2:        isV2,
        newLock:     newLock,
        lockFrom:    lockFrom,
        newDocLock:  newDocLock,
        docLockFrom: docLockFrom,
        vaultIdOf:   vaultIdOf,
        seal:        seal,
        unseal:      unseal,
        deriveKey:   deriveKey          // the vault's password key (ayni-vault.js): same rounds, same KDF
    };
} )();
