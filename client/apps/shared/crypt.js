/*
 * crypt.js - a document locked with a password.
 *
 * Classic script, one global `NayiveCrypt`. Load it deferred, before office.js:
 *     <script src="../shared/crypt.js" defer></script>
 *     <script src="../shared/office.js" defer></script>
 *
 * Write, Calc and Text save through one pipeline (shared/office.js, AUTOSAVE).
 * A locked document goes through this module on the way out and on the way
 * back: the bytes that leave the browser are AES-256-GCM ciphertext and the
 * password never does. The server, its backups and its logs only ever see the
 * sealed blob - there is no key anywhere but in this tab's memory, so a
 * forgotten password is a lost document. Nobody can recover it, us included.
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
 *   NAYIVE-LOCK-BIN\n | iters | salt | iv | ciphertext+tag     (Uint8Array)
 *          16           4 BE     16    12
 *
 *   NAYIVE-LOCK-B64\n + base64( the whole blob above )         (String)
 *
 * The 48-byte header is the GCM `additionalData`, so a tampered salt, IV or
 * round count fails the tag instead of quietly decrypting to rubbish. Both
 * magics are plain ASCII: looksLocked() recognises a locked file from its
 * first bytes whichever way it was read (Text's .bak is read as bytes), and
 * unseal() gives back a string for B64 and a Uint8Array for BIN - the shape
 * the editor's load() expects.
 *
 *   var lock = await NayiveCrypt.newLock( password );        // a new document
 *   var lock = await NayiveCrypt.lockFrom( password, body ); // an open one: the salt is in it
 *   var out  = await NayiveCrypt.seal( lock, body );
 *   var back = await NayiveCrypt.unseal( lock, out );        // throws on a wrong password
 */
( function ()
{
    "use strict";

    var MAGIC_BIN = "NAYIVE-LOCK-BIN\n";       // 16 bytes, raw bytes follow
    var MAGIC_B64 = "NAYIVE-LOCK-B64\n";       // 16 bytes, base64 of a BIN blob follows

    var ITERS     = 600000;                    // PBKDF2 rounds for a NEW lock
    var MAX_ITERS = 5000000;                   // a header asking for more is refused, not obeyed
    var SALT_LEN  = 16;
    var IV_LEN    = 12;
    var HEAD_LEN  = 48;                        // magic 16 + iters 4 + salt 16 + iv 12

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
        return startsWith( body, MAGIC_BIN ) || startsWith( body, MAGIC_B64 );
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
        if( startsWith( body, MAGIC_B64 ) )
        {
            var text = typeof body === "string" ? body : new TextDecoder().decode( asBytes( body ) );
            return { blob: fromBase64( text.slice( MAGIC_B64.length ) ), text: true };
        }
        if( startsWith( body, MAGIC_BIN ) ) return { blob: asBytes( body ), text: false };

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

    // Bytes in -> the BIN form; a string in -> the B64 form.
    async function seal( lock, body )
    {
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
        var h     = readHead( form.blob );
        var plain = new Uint8Array( await crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: h.iv, additionalData: h.head }, lock.key, h.body ) );

        return form.text ? new TextDecoder().decode( plain ) : plain;
    }

    window.NayiveCrypt = {
        available:   available,
        looksLocked: looksLocked,
        newLock:     newLock,
        lockFrom:    lockFrom,
        seal:        seal,
        unseal:      unseal
    };
} )();
