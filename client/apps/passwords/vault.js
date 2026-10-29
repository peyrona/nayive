// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * vault.js - Passwords: the vault file and every byte of its crypto. No DOM,
 * no store: model.js reads and writes the file, this file says what is in it.
 * The plan and the reasons: docs/passwords-app-plan.md.
 *
 *   THE FILE  (data/passwords/passwords.json)
 *
 *   { "format": "nayive-passwords", "v": 1,
 *     "vault": "<16 random bytes>",
 *     "kdf":   { "alg": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "<16 B>" },
 *     "hint":  { "kdf": { …as above, its own salt }, "c": "<iv|ct>", "v": "<iv|ct>" },  optional
 *     "keys":  { "pw": "<iv|ct>", "rec": "<iv|ct>" },
 *     "items": { "<id>": { "r": 4, "c": "<iv|ct>" },             a live entry
 *                "<id>": { "r": 7, "x": 1, "at": "2026-10-15" } }, a deleted one
 *     "copies": [ { "id", "r", "c" } ] }                           see MERGE
 *
 * Binary values are base64url, no padding; "<iv|ct>" is the 12-byte IV, then
 * the AES-GCM ciphertext with its tag.
 *
 * `hint` is the user's reminder phrase for the master password, sealed twice:
 *   c  under the user's NAYIVE (login) password - the lock screen asks for it
 *      to show the phrase, before the vault is open;
 *   v  under the vault key - read while the vault is open (Settings shows it,
 *      and saves it again after the Nayive password changed).
 * Whoever cracks the Nayive password can read the phrase; that is why
 * lock.js refuses a phrase holding every word of the master password.
 *
 *   KEYS
 *
 *   master password -NFC, Argon2id(kdf)-> 32 B -HKDF "kek v1|<vault>"-> KEK -+
 *   recovery key (20 random B) -------------HKDF "rec v1|<vault>"-> RKEK ----+-> unwrap
 *                                                                            v
 *                                                   vault key (32 random B, never changes)
 *                                                    -HKDF "items v1|<vault>"-> item key
 *                                                    -HKDF "hintv v1|<vault>"-> hint.v key
 *   "nayive-hint|" + Nayive password -NFC, Argon2id(hint.kdf)-> HKDF "hint v1|<vault>"-> hint.c key
 *
 * Every key is a non-extractable WebCrypto key; the raw vault key exists only
 * for a moment, to make or re-wrap a lock, and is wiped right after. Changing
 * the master password re-wraps the vault key (the items are not touched);
 * so does a new recovery key.
 *
 * Every ciphertext is AES-256-GCM with associated data that ties it to its
 * place (docs/passwords-app-plan.md R1, R2):
 *   keys.pw     "npw1|pw|<vault>|argon2id|<m>|<t>|<p>|<salt>"  - a changed KDF fails it
 *   keys.rec    "npw1|rec|<vault>"
 *   items.<id>  "npw1|item|<vault>|<id>|<r>"                    - no swapping, no replaying
 *   hint.c      "npw1|hint|<vault>|argon2id|<m>|<t>|<p>|<salt>"
 *   hint.v      "npw1|hintv|<vault>"
 * A KDF setting below the floor or above the ceiling is refused before any
 * work (no downgrade, no denial of service); an unknown format or version is
 * never read and never rewritten (check()).
 *
 * Who sees what in the file: how many entries, their random ids, their
 * revision numbers, when an entry was deleted, whether there is a reminder
 * phrase. Nothing else - titles, user
 * names, addresses and folder names are all inside the ciphertexts.
 */
"use strict";

const PwVault = ( function()
{
    const FORMAT  = 'nayive-passwords';
    const VERSION = 1;
    const KDF_NEW = { alg: 'argon2id', m: 65536, t: 3, p: 1 };   // RFC 9106's second choice, one lane
    const KDF_MIN = { m: 19456,   t: 2,  p: 1 };                 // OWASP's floor
    const KDF_MAX = { m: 1048576, t: 10, p: 4 };                 // more is refused, not obeyed
    const SALT_LEN = 16, IV_LEN = 12, ID_LEN = 16, KEY_LEN = 32, REC_LEN = 20;
    const KDF_MS   = 120000;                                     // a derivation that takes longer has hung

    // Crockford's base32: no I, L, O, U - nothing to misread on paper.
    const REC_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

    const enc = new TextEncoder();
    const dec = new TextDecoder( 'utf-8', { fatal: true } );
    const subtle = window.crypto && window.crypto.subtle;

    function available() { return !! ( subtle && window.crypto.getRandomValues && window.Worker && window.WebAssembly ); }

    //------------------------------------------------------------------------//
    // BYTES

    function rand( n ) { return window.crypto.getRandomValues( new Uint8Array( n ) ); }

    function b64u( bytes )
    {
        let s = '';
        for( let i = 0; i < bytes.length; i++ ) s += String.fromCharCode( bytes[ i ] );
        return btoa( s ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );
    }

    // -> bytes, or null for anything that is not clean base64url.
    function unb64u( str )
    {
        if( typeof str !== 'string' || ! /^[A-Za-z0-9_-]*$/.test( str ) || str.length % 4 === 1 ) return null;
        try
        {
            const s = atob( str.replace( /-/g, '+' ).replace( /_/g, '/' ) + '==='.slice( ( str.length + 3 ) % 4 ) );
            const out = new Uint8Array( s.length );
            for( let i = 0; i < s.length; i++ ) out[ i ] = s.charCodeAt( i );
            return out;
        }
        catch( e ) { return null; }
    }

    function newId() { return b64u( rand( ID_LEN ) ); }

    //------------------------------------------------------------------------//
    // KEYS

    // 32 bytes -> one AES-256-GCM key for one purpose (`info`).
    async function hkdfAes( raw, info )
    {
        const base = await subtle.importKey( 'raw', raw, 'HKDF', false, [ 'deriveKey' ] );
        return subtle.deriveKey( { name: 'HKDF', hash: 'SHA-256', salt: enc.encode( 'nayive-pw' ), info: enc.encode( info ) },
                                 base, { name: 'AES-GCM', length: 256 }, false, [ 'encrypt', 'decrypt' ] );
    }

    async function seal( key, aad, bytes )
    {
        const iv = rand( IV_LEN );
        const ct = new Uint8Array( await subtle.encrypt( { name: 'AES-GCM', iv: iv, additionalData: aad }, key, bytes ) );
        const out = new Uint8Array( IV_LEN + ct.length );
        out.set( iv );
        out.set( ct, IV_LEN );
        return b64u( out );
    }

    // -> the bytes; throws on a wrong key or any changed byte.
    async function open( key, aad, str )
    {
        const all = unb64u( str );
        if( ! all || all.length < IV_LEN + 16 ) throw new Error( 'bad' );
        return new Uint8Array( await subtle.decrypt( { name: 'AES-GCM', iv: all.subarray( 0, IV_LEN ), additionalData: aad },
                                                     key, all.subarray( IV_LEN ) ) );
    }

    function pwAad( vault, k )  { return enc.encode( 'npw1|pw|' + vault + '|' + k.alg + '|' + k.m + '|' + k.t + '|' + k.p + '|' + k.salt ); }
    function recAad( vault )    { return enc.encode( 'npw1|rec|' + vault ); }
    function itemAad( vault, id, r ) { return enc.encode( 'npw1|item|' + vault + '|' + id + '|' + r ); }

    function int( n, lo, hi ) { return Number.isInteger( n ) && n >= lo && n <= hi; }

    // A KDF block we are willing to run: Argon2id, inside the floor and the ceiling.
    function kdfOk( k )
    {
        if( ! k || typeof k !== 'object' || k.alg !== 'argon2id' ) return false;
        const salt = unb64u( k.salt );
        return int( k.m, KDF_MIN.m, KDF_MAX.m ) && int( k.t, KDF_MIN.t, KDF_MAX.t ) &&
               int( k.p, KDF_MIN.p, KDF_MAX.p ) && k.m >= 8 * k.p && !! salt && salt.length === SALT_LEN;
    }

    // Argon2id in a worker of its own (argon2-worker.js), thrown away after.
    function argon2( password, k )
    {
        return new Promise( function( resolve, reject )
        {
            let w;
            try { w = new Worker( 'argon2-worker.js', { type: 'module' } ); }
            catch( e ) { reject( e ); return; }
            const timer = setTimeout( function() { w.terminate(); reject( new Error( 'timeout' ) ); }, KDF_MS );
            const end = function() { clearTimeout( timer ); w.terminate(); };
            w.onmessage = function( e )
            {
                end();
                const d = e.data || {};
                if( d.ok && d.tag && d.tag.length === KEY_LEN ) resolve( d.tag ); else reject( new Error( d.error || 'argon2' ) );
            };
            w.onerror = function( e ) { end(); reject( new Error( ( e && e.message ) || 'argon2 worker' ) ); };
            // The same password typed on a Mac and on a PC can be different
            // Unicode: one form for all.
            const pw = enc.encode( String( password ).normalize( 'NFC' ) );
            w.postMessage( { password: pw, salt: unb64u( k.salt ), m: k.m, t: k.t, p: k.p }, [ pw.buffer ] );
        } );
    }

    async function masterKek( password, vault, k )
    {
        const tag = await argon2( password, k );
        try { return await hkdfAes( tag, 'kek v1|' + vault ); }
        finally { tag.fill( 0 ); }
    }

    function recKek( recBytes, vault ) { return hkdfAes( recBytes, 'rec v1|' + vault ); }

    // The raw vault key -> what an open vault keeps: the item key.
    async function keysFor( raw, vault )
    {
        return { vault: vault, item: await hkdfAes( raw, 'items v1|' + vault ), hint: await hkdfAes( raw, 'hintv v1|' + vault ) };
    }

    //------------------------------------------------------------------------//
    // RECOVERY KEY  -  20 bytes = 32 base32 letters, shown in 8 groups of 4.

    function recCode( bytes )
    {
        let bits = 0, val = 0, out = '';
        for( let i = 0; i < bytes.length; i++ )
        {
            val = ( val << 8 ) | bytes[ i ];
            bits += 8;
            while( bits >= 5 ) { out += REC_ABC[ ( val >>> ( bits - 5 ) ) & 31 ]; bits -= 5; }
            val &= ( 1 << bits ) - 1;
        }
        return out.match( /.{4}/g ).join( '-' );
    }

    // What was typed (any case, spaces or dashes, O for 0, I or L for 1) ->
    // the 20 bytes, or null when it is not 32 letters of the alphabet.
    function recBytes( code )
    {
        const s = String( code || '' ).toUpperCase().replace( /[\s\u2010-\u2015-]+/g, '' ).replace( /O/g, '0' ).replace( /[IL]/g, '1' );
        if( s.length !== 32 ) return null;
        const out = new Uint8Array( REC_LEN );
        let bits = 0, val = 0, n = 0;
        for( const ch of s )
        {
            const v = REC_ABC.indexOf( ch );
            if( v < 0 ) return null;
            val = ( val << 5 ) | v;
            bits += 5;
            if( bits >= 8 ) { out[ n++ ] = ( val >>> ( bits - 8 ) ) & 255; bits -= 8; val &= ( 1 << bits ) - 1; }
        }
        return out;
    }

    //------------------------------------------------------------------------//
    // THE FILE

    function isLive( e ) { return !! e && typeof e === 'object' && int( e.r, 1, Number.MAX_SAFE_INTEGER ) && typeof e.c === 'string' && e.x !== 1; }
    function isGone( e ) { return !! e && typeof e === 'object' && int( e.r, 1, Number.MAX_SAFE_INTEGER ) && e.x === 1; }

    // 'ok' | 'newer' (another format or a later version: never read, never
    // written) | 'bad' (damaged, or settings we refuse to run).
    function check( f )
    {
        if( ! f || typeof f !== 'object' || f.format !== FORMAT ) return f && typeof f === 'object' && typeof f.format === 'string' && f.format !== FORMAT ? 'newer' : 'bad';
        if( f.v !== VERSION ) return int( f.v, VERSION + 1, 1e6 ) ? 'newer' : 'bad';
        const id = unb64u( f.vault );
        if( ! id || id.length !== ID_LEN || ! kdfOk( f.kdf ) ) return 'bad';
        if( ! f.keys || typeof f.keys.pw !== 'string' || typeof f.keys.rec !== 'string' ) return 'bad';
        if( ! f.items || typeof f.items !== 'object' || Array.isArray( f.items ) ) return 'bad';
        if( f.copies != null && ! Array.isArray( f.copies ) ) return 'bad';
        return 'ok';
    }

    // A new, empty vault. -> { file, keys, recovery } (the recovery key as
    // shown to the user, once).
    async function create( password )
    {
        const vault = newId();
        const kdf   = Object.assign( {}, KDF_NEW, { salt: b64u( rand( SALT_LEN ) ) } );
        const raw   = rand( KEY_LEN );
        try
        {
            const pw  = await seal( await masterKek( password, vault, kdf ), pwAad( vault, kdf ), raw );
            const rb  = rand( REC_LEN );
            const rec = await seal( await recKek( rb, vault ), recAad( vault ), raw );
            const file = { format: FORMAT, v: VERSION, vault: vault, kdf: kdf, keys: { pw: pw, rec: rec }, items: {} };
            const keys = await keysFor( raw, vault );
            const code = recCode( rb );
            rb.fill( 0 );
            return { file: file, keys: keys, recovery: code };
        }
        finally { raw.fill( 0 ); }
    }

    // The raw vault key, from the master password ({ password }) or the
    // recovery key ({ recovery }). Throws Error( 'wrong' ) for a password or
    // key that does not open it - or a header someone changed: the two look
    // the same, on purpose. The caller wipes what it gets.
    // Error( 'kdf' ) = Argon2id could not run in this browser (no wrong
    // password said for that).
    async function openRaw( file, how )
    {
        if( check( file ) !== 'ok' ) throw new Error( 'bad' );
        let kek, aad, ct;
        if( how.recovery != null )
        {
            const rb = recBytes( how.recovery );
            if( ! rb ) throw new Error( 'wrong' );
            try { kek = await recKek( rb, file.vault ); }
            finally { rb.fill( 0 ); }
            aad = recAad( file.vault );
            ct  = file.keys.rec;
        }
        else
        {
            // No master password is that short (8 bytes is Argon2's own minimum).
            if( enc.encode( String( how.password || '' ).normalize( 'NFC' ) ).length < 8 ) throw new Error( 'wrong' );
            try { kek = await masterKek( how.password, file.vault, file.kdf ); }
            catch( e ) { throw new Error( 'kdf' ); }
            aad = pwAad( file.vault, file.kdf );
            ct  = file.keys.pw;
        }
        try { return await open( kek, aad, ct ); }
        catch( e ) { throw new Error( 'wrong' ); }
    }

    async function unlock( file, how )
    {
        const raw = await openRaw( file, how );
        if( raw.length !== KEY_LEN ) { raw.fill( 0 ); throw new Error( 'wrong' ); }
        try { return await keysFor( raw, file.vault ); }
        finally { raw.fill( 0 ); }
    }

    // A new master password on the same vault key -> { kdf, pw } for the header.
    async function wrapPassword( raw, vault, password )
    {
        const kdf = Object.assign( {}, KDF_NEW, { salt: b64u( rand( SALT_LEN ) ) } );
        return { kdf: kdf, pw: await seal( await masterKek( password, vault, kdf ), pwAad( vault, kdf ), raw ) };
    }

    // A new recovery key on the same vault key -> { rec, code }.
    async function wrapRecovery( raw, vault )
    {
        const rb = rand( REC_LEN );
        try { return { rec: await seal( await recKek( rb, vault ), recAad( vault ), raw ), code: recCode( rb ) }; }
        finally { rb.fill( 0 ); }
    }

    // One entry: a plain object <-> its ciphertext at (id, r).
    async function sealItem( keys, id, r, obj )
    {
        return seal( keys.item, itemAad( keys.vault, id, r ), enc.encode( JSON.stringify( obj ) ) );
    }

    async function openItem( keys, id, r, c )
    {
        const obj = JSON.parse( dec.decode( await open( keys.item, itemAad( keys.vault, id, r ), c ) ) );
        if( ! obj || typeof obj !== 'object' || Array.isArray( obj ) ) throw new Error( 'bad' );
        return obj;
    }

    //------------------------------------------------------------------------//
    // THE REMINDER PHRASE  (see THE FILE)

    function hintAad( vault, k ) { return enc.encode( 'npw1|hint|' + vault + '|' + k.alg + '|' + k.m + '|' + k.t + '|' + k.p + '|' + k.salt ); }
    function hintVAad( vault )   { return enc.encode( 'npw1|hintv|' + vault ); }

    // A hint block this version can use (anything else counts as none).
    function hintValid( h ) { return !! h && typeof h === 'object' && kdfOk( h.kdf ) && typeof h.c === 'string' && typeof h.v === 'string'; }

    // The prefix: Argon2 wants 8 bytes at least, and a Nayive password may be shorter.
    async function hintKey( login, vault, k )
    {
        const tag = await argon2( 'nayive-hint|' + String( login ), k );
        try { return await hkdfAes( tag, 'hint v1|' + vault ); }
        finally { tag.fill( 0 ); }
    }

    // The phrase, sealed for the file (the vault open: keys). -> the hint block.
    async function sealHint( keys, phrase, login )
    {
        const kdf = Object.assign( {}, KDF_NEW, { salt: b64u( rand( SALT_LEN ) ) } );
        const bytes = enc.encode( phrase );
        return { kdf: kdf,
                 c: await seal( await hintKey( login, keys.vault, kdf ), hintAad( keys.vault, kdf ), bytes ),
                 v: await seal( keys.hint, hintVAad( keys.vault ), bytes ) };
    }

    // The lock screen: the phrase from the Nayive password. Throws 'none',
    // 'kdf' (Argon2id could not run) or 'wrong'.
    async function openHint( file, login )
    {
        if( check( file ) !== 'ok' || ! hintValid( file.hint ) ) throw new Error( 'none' );
        let k;
        try { k = await hintKey( login, file.vault, file.hint.kdf ); }
        catch( e ) { throw new Error( 'kdf' ); }
        try { return dec.decode( await open( k, hintAad( file.vault, file.hint.kdf ), file.hint.c ) ); }
        catch( e ) { throw new Error( 'wrong' ); }
    }

    // The vault open: the phrase, or "" (none, or it will not open).
    async function readHint( keys, file )
    {
        if( ! file || ! hintValid( file.hint ) ) return '';
        try { return dec.decode( await open( keys.hint, hintVAad( file.vault ), file.hint.v ) ); }
        catch( e ) { return ''; }
    }

    //------------------------------------------------------------------------//
    // MERGE  -  two devices saved the same file (the store's `merge`, model.js).
    // It runs WITHOUT the key - it only moves sealed entries, so it cannot
    // read, mix or change one (and the store needs an answer at once).
    //
    //   - The parts of the header go apart: the master-password lock (kdf +
    //     keys.pw, they belong together), the recovery lock and the reminder
    //     phrase. Each: the side that changed it; both did: ours.
    //   - An entry: the side that did not touch it takes the other's. Both
    //     changed it:
    //       two edits - the higher revision stays (a tie: ours), the other is
    //         kept whole in `copies`: the app, once it holds the key, makes it
    //         an entry of its own (model.js takeCopies);
    //       an edit and a deletion - the edit stays, unless the deletion is
    //         newer: then the edit goes to `copies`;
    //       two deletions - the newer mark.
    //     No password is ever dropped in silence.
    //   - An entry only one side has: kept, unless the other side had it as
    //     it is in `base` and took it away (an old deletion purged).
    //   - Two different vaults (made at the same time on two devices): no
    //     merge - null, and the store keeps the save held back.
    // base = the file this side's save was made from (null when unknown:
    // then nothing counts as taken away).

    function same( a, b ) { return JSON.stringify( a ) === JSON.stringify( b ); }

    function pick( b, m, t ) { return same( m, t ) ? m : b !== undefined && same( b, m ) ? t : m; }

    function merge( baseS, mineS, theirsS )
    {
        let b = null, m, t;
        try { m = JSON.parse( mineS ); t = JSON.parse( theirsS ); } catch( e ) { return null; }
        if( check( m ) !== 'ok' || check( t ) !== 'ok' || m.vault !== t.vault ) return null;
        try { b = typeof baseS === 'string' ? JSON.parse( baseS ) : null; } catch( e ) { b = null; }
        if( b && ( check( b ) !== 'ok' || b.vault !== m.vault ) ) b = null;

        const out = { format: FORMAT, v: VERSION, vault: m.vault };
        const lockOf = function( f ) { return f ? { kdf: f.kdf, pw: f.keys.pw } : undefined; };
        const lk = pick( lockOf( b ), lockOf( m ), lockOf( t ) );
        out.kdf  = lk.kdf;
        out.keys = { pw: lk.pw, rec: pick( b ? b.keys.rec : undefined, m.keys.rec, t.keys.rec ) };
        // null = no phrase (so "the base had none" is not "no base").
        const hint = pick( b ? b.hint || null : undefined, m.hint || null, t.hint || null );
        if( hint ) out.hint = hint;
        out.items = {};

        const copies = [];
        const ids = new Set( Object.keys( m.items ).concat( Object.keys( t.items ) ) );
        for( const id of ids )
        {
            const bi = b ? b.items[ id ] : undefined, mi = m.items[ id ], ti = t.items[ id ];
            if( mi && ti )
            {
                if( same( mi, ti ) || ( bi && same( bi, ti ) ) ) out.items[ id ] = mi;
                else if( bi && same( bi, mi ) ) out.items[ id ] = ti;
                else if( isLive( mi ) && isLive( ti ) )
                {
                    const win = ti.r > mi.r ? ti : mi;
                    out.items[ id ] = win;
                    copies.push( { id: id, r: ( win === mi ? ti : mi ).r, c: ( win === mi ? ti : mi ).c } );
                }
                else if( isLive( mi ) !== isLive( ti ) )
                {
                    // Edited on one side, deleted on the other: the edit stays
                    // unless the deletion is newer - then the edit is a copy.
                    const live = isLive( mi ) ? mi : ti, gone = live === mi ? ti : mi;
                    out.items[ id ] = gone.r > live.r ? gone : live;
                    if( gone.r > live.r ) copies.push( { id: id, r: live.r, c: live.c } );
                }
                else out.items[ id ] = ( ti.r > mi.r ? ti : mi );
            }
            else
            {
                const only = mi || ti;
                if( bi && same( bi, only ) ) continue;
                out.items[ id ] = only;
            }
        }

        // The copies waiting to become entries: both sides', plus the new ones;
        // one a side has dropped since base (the app took it in) stays dropped.
        const key = function( x ) { return x && x.id + '|' + x.r + '|' + x.c; };
        const had = new Set( ( b && b.copies || [] ).map( key ) );
        const mk  = new Set( ( m.copies || [] ).map( key ) ), tk = new Set( ( t.copies || [] ).map( key ) );
        const seen = new Set();
        for( const x of ( m.copies || [] ).concat( t.copies || [], copies ) )
        {
            const k = key( x );
            if( ! x || typeof x.id !== 'string' || typeof x.c !== 'string' || ! int( x.r, 1, Number.MAX_SAFE_INTEGER ) || seen.has( k ) ) continue;
            if( had.has( k ) && ( ! mk.has( k ) || ! tk.has( k ) ) ) continue;
            seen.add( k );
            ( out.copies = out.copies || [] ).push( { id: x.id, r: x.r, c: x.c } );
        }
        return JSON.stringify( out, null, 2 );
    }

    return {
        FORMAT: FORMAT, VERSION: VERSION, KDF_NEW: KDF_NEW, KDF_MIN: KDF_MIN, KDF_MAX: KDF_MAX,
        available: available, newId: newId, check: check, isLive: isLive, isGone: isGone,
        create: create, unlock: unlock, openRaw: openRaw, keysFor: keysFor,
        wrapPassword: wrapPassword, wrapRecovery: wrapRecovery,
        sealItem: sealItem, openItem: openItem, recBytes: recBytes, merge: merge,
        hintValid: hintValid, sealHint: sealHint, openHint: openHint, readHint: readHint
    };
} )();
