// run.mjs - the Passwords app in real (headless) browsers, against a real
// scratch server built from server/go. See README.md.
//
//   node tools/passwords-test/run.mjs
//
// Needs Go, Chromium, Node 24 (crypto.argon2Sync: Node opens the vault on its
// own, as a second implementation) and the internet (the leak check).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server, browser, ok, section, done, sleep, disk, onDisk } from "../data-safety-test/lib.mjs";

const SHOTS = fs.mkdtempSync( path.join( os.tmpdir(), "passwords-shots-" ) );
const FILE  = "data/passwords/passwords.json";
const PW    = "correct horse battery staple 42";
const PW2   = "another long master passphrase 7";
const PW3   = "third time lucky master pass 99";
const HINT  = "the comic about four common words";
const CANARY = { title: "Canary Bank", user: "canary-user@example.com", pass: "CANARY-pw-7f3e9!", url: "bank.canary.example", notes: "canary note text" };
const SECRET_BITS = [ "anary", "CANARY", "7f3e9" ];

const s = await server( { test: "test", ana: "ana" } );
const c = await browser( s, { mouse: true } );
const json = () => { try { return JSON.parse( onDisk( s, FILE ) ); } catch { return null; } };
const raw  = () => onDisk( s, FILE );
const live = f => Object.entries( ( f || json() ).items ).filter( ( [ , e ] ) => e.c && e.x !== 1 );
const shot = async ( p, name ) =>
{
    const r = await p.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
};
const noSecret = text => ! SECRET_BITS.some( b => String( text ).indexOf( b ) >= 0 );

async function openApp( p )
{
    await p.evaluate( "localStorage.setItem( 'balata-intro-dismiss:passwords', '1' ); true" );
    await p.send( "Page.navigate", { url: "about:blank" } );
    await p.until( "location.href === 'about:blank'" );
    await p.open( "/nayive/passwords/", "/nayive/passwords/" );
    // Every PUT of the vault file: its checks and the answer.
    await p.evaluate( `( function () { window.__puts = []; var f = window.fetch;
        window.fetch = async function ( u, o ) { var r = await f.apply( this, arguments );
            if( o && o.method === 'PUT' && String( u ).indexOf( 'passwords.json' ) !== -1 ) {
                var h = o.headers || {}; window.__puts.push( { im: h[ 'If-Match' ] || null, inm: h[ 'If-None-Match' ] || null, st: r.status } ); }
            return r; };
        return true; } )()` );
    return p.until( "typeof fileState !== 'undefined' && fileState !== 'unknown' && ! document.getElementById( 'gate' ).hidden || ( typeof isOpen === 'function' && isOpen() )", 20000 );
}

async function unlock( p, pw )
{
    await p.evaluate( `document.getElementById( 'unlockPw' ).value = ${JSON.stringify( pw )}; unlockVault(); true` );
    return p.until( "isOpen() || ! document.getElementById( 'unlockErr' ).hidden", 30000 ).then( () => p.evaluate( "isOpen()" ) );
}

// Clicks the ✓ of the dialog on top (askPassword, alert): types `pw` first when it asks one.
async function answerDialog( p, pw )
{
    await p.until( "!! document.querySelector( '.sheet-backdrop.open #askPw1' ) || !! document.querySelector( '.sheet-backdrop.open .dialog-text' )" );
    return p.evaluate( `( function () {
        var i = document.querySelector( '.sheet-backdrop.open #askPw1' );
        if( i ) i.value = ${JSON.stringify( pw || "" )};
        var backs = document.querySelectorAll( '.sheet-backdrop.open' ), b = backs[ backs.length - 1 ];
        var row = b.querySelectorAll( '.sheet-actions button' );
        var ok = b.querySelector( '.btn.primary' ) || row[ row.length - 1 ] || b.querySelector( 'button' );
        ok.click(); return true; } )()` );
}

// Node opens the file with the password, independently of the page.
async function nodeOpen( file, password )
{
    const { subtle } = crypto.webcrypto;
    const b = x => Buffer.from( x, "base64url" );
    const k = file.kdf;
    const tag = crypto.argon2Sync( "argon2id", { message: Buffer.from( password.normalize( "NFC" ) ), nonce: b( k.salt ),
                                                 parallelism: k.p, tagLength: 32, memory: k.m, passes: k.t } );
    const hk = async ( rawKey, info ) => subtle.deriveKey( { name: "HKDF", hash: "SHA-256", salt: Buffer.from( "nayive-pw" ), info: Buffer.from( info ) },
        await subtle.importKey( "raw", rawKey, "HKDF", false, [ "deriveKey" ] ), { name: "AES-GCM", length: 256 }, false, [ "decrypt" ] );
    const open = async ( key, aad, str ) => { const x = b( str ); return Buffer.from( await subtle.decrypt( { name: "AES-GCM", iv: x.subarray( 0, 12 ), additionalData: Buffer.from( aad ) }, key, x.subarray( 12 ) ) ); };
    const vaultKey = await open( await hk( tag, "kek v1|" + file.vault ), `npw1|pw|${file.vault}|argon2id|${k.m}|${k.t}|${k.p}|${k.salt}`, file.keys.pw );
    const ik = await hk( vaultKey, "items v1|" + file.vault );
    return { item: async id => JSON.parse( await open( ik, `npw1|item|${file.vault}|${id}|${file.items[ id ].r}`, file.items[ id ].c ) ) };
}

// Node opens the reminder phrase with the Nayive password, on its own.
async function nodeHint( file, login )
{
    const { subtle } = crypto.webcrypto;
    const b = x => Buffer.from( x, "base64url" );
    const k = file.hint.kdf;
    const tag = crypto.argon2Sync( "argon2id", { message: Buffer.from( ( "nayive-hint|" + login ).normalize( "NFC" ) ), nonce: b( k.salt ),
                                                 parallelism: k.p, tagLength: 32, memory: k.m, passes: k.t } );
    const key = await subtle.deriveKey( { name: "HKDF", hash: "SHA-256", salt: Buffer.from( "nayive-pw" ), info: Buffer.from( "hint v1|" + file.vault ) },
        await subtle.importKey( "raw", tag, "HKDF", false, [ "deriveKey" ] ), { name: "AES-GCM", length: 256 }, false, [ "decrypt" ] );
    const x = b( file.hint.c );
    return Buffer.from( await subtle.decrypt( { name: "AES-GCM", iv: x.subarray( 0, 12 ), additionalData: Buffer.from( `npw1|hint|${file.vault}|argon2id|${k.m}|${k.t}|${k.p}|${k.salt}` ) },
                                              key, x.subarray( 12 ) ) ).toString( "utf8" );
}

//----------------------------------------------------------------------------//
section( "ARGON2ID · THE VENDORED LIBRARY AGAINST RFC 9106" );
{
    // On a page with no Content-Security-Policy (login.html): WebAssembly on the page itself.
    await c.open( "/nayive/login.html", "/nayive/login.html" );
    const kat = `( async function ( v ) {
        var m = await import( '/nayive/passwords/lib/argon2id_v1.0.1/setup.js?' + v );
        var load = function ( n ) { return async function ( io ) { return WebAssembly.instantiate( await ( await fetch( '/nayive/passwords/lib/argon2id_v1.0.1/' + n ) ).arrayBuffer(), io ); }; };
        var h = await m.default( v === 'plain' ? function () { throw new Error( 'no simd' ); } : load( 'simd.wasm' ), load( 'no-simd.wasm' ) );
        var t = h( { password: new Uint8Array( 32 ).fill( 1 ), salt: new Uint8Array( 16 ).fill( 2 ), secret: new Uint8Array( 8 ).fill( 3 ),
                     ad: new Uint8Array( 12 ).fill( 4 ), parallelism: 4, passes: 3, memorySize: 32, tagLength: 32 } );
        return Array.from( t ).map( function ( x ) { return x.toString( 16 ).padStart( 2, '0' ); } ).join( '' ); } )`;
    const want = "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";
    ok( await c.evaluate( kat + "( 'simd' )" ) === want, "the SIMD build gives RFC 9106's Argon2id tag" );
    ok( await c.evaluate( kat + "( 'plain' )" ) === want, "the plain build (Safari) gives it too" );
}

//----------------------------------------------------------------------------//
section( "SET-UP · RULES, LEAK CHECK, RECOVERY KEY" );
let recovery;
{
    ok( await openApp( c ), "Passwords opens" );
    ok( await c.evaluate( "fileState === 'empty' && ! document.getElementById( 'setupBox' ).hidden" ), "no file: the set-up shows" );
    await shot( c, "01-setup" );

    // Too short / a pattern / not the same: refused, nothing written.
    for( const [ a, b, why ] of [ [ "short one", "short one", "too short" ], [ "aaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaa", "a pattern" ],
                                  [ PW, PW + "x", "typed differently" ] ] )
    {
        await c.evaluate( `document.getElementById( 'setupPw' ).value = ${JSON.stringify( a )}; document.getElementById( 'setupPw2' ).value = ${JSON.stringify( b )}; createVault(); true` );
        ok( await c.until( "! document.getElementById( 'setupErr' ).hidden" ) && raw() === null, "refused: " + why + " (nothing written)" );
    }
    // A leaked one: "passwordpassword" (two words, 16 characters) is in every leak list.
    await c.evaluate( "document.getElementById( 'setupPw' ).value = document.getElementById( 'setupPw2' ).value = 'passwordpassword'; createVault(); true" );
    ok( await c.until( "/leak|filtr/i.test( document.getElementById( 'setupErr' ).textContent )", 20000 ), "refused: found in known leaks (HIBP)",
        await c.evaluate( "document.getElementById( 'setupErr' ).textContent" ) );

    // The reminder phrase: every word of the password (any order, any case) refused;
    // some of them: a warning; it needs the right Nayive password.
    const typeIn = ( phrase, login ) => c.evaluate( `( function () {
        document.getElementById( 'setupErr' ).hidden = true;
        document.getElementById( 'setupPw' ).value = document.getElementById( 'setupPw2' ).value = ${JSON.stringify( PW )};
        document.getElementById( 'setupHint' ).value = ${JSON.stringify( phrase )};
        document.getElementById( 'setupLogin' ).value = ${JSON.stringify( login )};
        document.getElementById( 'setupHint' ).dispatchEvent( new Event( 'input' ) ); return true; } )()` );
    await typeIn( "STAPLE 42 battery, horse - Correct", "" );
    ok( await c.evaluate( "! document.getElementById( 'setupHintWarn' ).hidden && document.getElementById( 'setupHintWarn' ).classList.contains( 'is-bad' )" ),
        "a phrase with every word of the password (another order, other case): said at once" );
    await c.evaluate( "createVault(); true" );
    ok( await c.until( "/all the words|todas las palabras/i.test( document.getElementById( 'setupErr' ).textContent )" ) && raw() === null, "…and refused (nothing written)" );
    // Signs count too: refused only with every word AND every sign.
    ok( await c.evaluate( `( function () {
        var pw = 'Correct.Horse!Battery#42';
        var all = phraseCheck( pw, '42 battery! horse. #CORRECT' ), noSign = phraseCheck( pw, 'correct horse battery 42' ), some = phraseCheck( pw, 'a horse!' );
        return all.bad && ! noSign.bad && noSign.allWords && ! some.bad && ! some.allWords && some.shared === 1;
    } )()` ), "with signs: every word and sign refused; every word but a sign missing allowed; some words: counted" );
    // His example (2026-10-15): "To B or ! to b" and "To B or not to b" are different.
    ok( await c.evaluate( `( function () {
        var a = 'To B or ! to b', b = 'To B or not to b';
        return ! phraseCheck( a, b ).bad && phraseCheck( a, b ).allWords && ! phraseCheck( b, a ).bad && phraseCheck( a, 'b TO ! or' ).bad;
    } )()` ), "\"To B or ! to b\" vs \"To B or not to b\": different either way; \"b TO ! or\" is the same as the first" );
    ok( await c.evaluate( "drawPhraseWarn( 'setupHintWarn', 'Correct.Horse!Battery#42', 'correct horse battery 42' ), /only its signs are missing/.test( document.getElementById( 'setupHintWarn' ).textContent ) && ! document.getElementById( 'setupHintWarn' ).classList.contains( 'is-bad' )" ),
        "…every word but not every sign: the strong warning, not a refusal" );
    await typeIn( "my old battery and the horse", "" );
    ok( await c.evaluate( "! document.getElementById( 'setupHintWarn' ).hidden && ! document.getElementById( 'setupHintWarn' ).classList.contains( 'is-bad' ) && /\\b2\\b/.test( document.getElementById( 'setupHintWarn' ).textContent )" ),
        "some of its words (2): a warning only", await c.evaluate( "document.getElementById( 'setupHintWarn' ).textContent" ) );
    ok( await c.evaluate( "! document.getElementById( 'setupLoginRow' ).hidden" ), "with a phrase, the Nayive password box shows" );
    await c.evaluate( "createVault(); true" );
    ok( await c.until( "/Nayive/.test( document.getElementById( 'setupErr' ).textContent )", 20000 ) && raw() === null, "no Nayive password: refused" );
    await typeIn( HINT, "not my login" );
    await c.evaluate( "createVault(); true" );
    ok( await c.until( "/wrong|incorrect/i.test( document.getElementById( 'setupErr' ).textContent )", 20000 ) && raw() === null, "a wrong Nayive password: refused (the server says)" );
    ok( await c.evaluate( "! document.getElementById( 'suggestBtn' )" ), "no \"Suggest a passphrase\" button any more" );

    await typeIn( HINT, "test" );
    await c.evaluate( "createVault(); true" );
    ok( await c.until( "! document.getElementById( 'recoveryBox' ).hidden", 30000 ), "the recovery key shows" );
    recovery = await c.evaluate( "recoveryCode" );
    ok( /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/.test( recovery ), "32 letters in 8 groups, Crockford's alphabet", recovery );
    ok( await c.evaluate( "document.getElementById( 'vaultRow' ).hidden" ), "the vault stays hidden behind it" );
    await shot( c, "02-recovery" );
    await c.evaluate( "recoveryDone(); true" );
    ok( await c.until( "vaultShown()" ), "\"I have written it down\" opens the empty vault" );
    ok( await disk( () => raw() !== null ), "the vault file is on disk" );
    await c.until( "window.__puts.length > 0" );
    const puts0 = await c.evaluate( "window.__puts" );
    ok( puts0.length && puts0[ 0 ].inm === "*", "the first save is create-only (If-None-Match: *)", puts0 );
    const f = json();
    ok( f && f.format === "nayive-passwords" && f.v === 1 && f.kdf.alg === "argon2id" && f.kdf.m === 65536 && f.kdf.t === 3 && f.kdf.p === 1,
        "the file: format, version, Argon2id 64 MiB / 3 passes / 1 lane", f && f.kdf );
    ok( f && f.hint && f.hint.kdf && f.hint.c && f.hint.v && raw().indexOf( "comic" ) < 0, "the reminder phrase is in the file - encrypted", f && f.hint );
    ok( await nodeHint( f, "test" ) === HINT, "Node opens it with the Nayive password, on its own" );
    ok( await c.evaluate( "document.getElementById( 'setupHint' ).value === '' && document.getElementById( 'setupLogin' ).value === ''" ), "…and its boxes emptied" );
}

//----------------------------------------------------------------------------//
section( "ENTRIES · ADD THROUGH THE SHEET, CIPHERTEXT ONLY ON DISK" );
let canaryId;
{
    // Typed into the real sheet, saved with its ✓.
    await c.evaluate( "document.getElementById( 'addBtn' ).click(); true" );
    ok( await c.until( "document.getElementById( 'itemBackdrop' ).classList.contains( 'open' )" ), "+ opens the entry sheet" );
    await c.evaluate( `( function () {
        var v = ${JSON.stringify( CANARY )};
        document.getElementById( 'itName' ).value = v.title; document.getElementById( 'itUser' ).value = v.user;
        document.getElementById( 'itPass' ).value = v.pass; document.getElementById( 'itUrls' ).value = v.url;
        document.getElementById( 'itNotes' ).value = v.notes; return true; } )()` );
    ok( await c.evaluate( "[ 'itName', 'itUser', 'itPass', 'itUrls', 'itNotes' ].every( function ( id ) { return document.getElementById( id ).spellcheck === false; } )" ),
        "no spell check on any box (no text sent to a spelling service)" );
    ok( await c.evaluate( "document.getElementById( 'itPass' ).type === 'password'" ), "the password box starts hidden" );
    await shot( c, "03-sheet" );
    await c.evaluate( "document.getElementById( 'itSaveBtn' ).click(); true" );
    ok( await disk( () => live().length === 1 ), "saved: one entry in the file" );
    canaryId = live()[ 0 ][ 0 ];
    ok( noSecret( raw() ), "the file holds none of it in the clear (title, user, password, site, notes)" );
    const opened = await nodeOpen( json(), PW );
    const n = await opened.item( canaryId );
    ok( n.title === CANARY.title && n.user === CANARY.user && n.pass === CANARY.pass && n.urls[ 0 ] === CANARY.url && n.notes === CANARY.notes,
        "Node, on its own (Argon2id + HKDF + AES-GCM), opens the file and reads the entry", n );

    // A few more, a folder, a note - through the model (same path the sheets take).
    await c.evaluate( `( function () {
        var now = nowIso(), f = { id: PwVault.newId(), type: 'folder', title: 'Bank', folder: '', created: now, updated: now };
        var e = function ( t, u, p, url, folder, fav ) { return { id: PwVault.newId(), type: 'login', title: t, user: u, pass: p, urls: url ? [ url ] : [], notes: '', totp: '', fields: [], folder: folder || '', fav: !! fav, history: [], created: now, updated: now }; };
        var note = { id: PwVault.newId(), type: 'note', title: 'Wifi', user: '', pass: '', urls: [], notes: 'router pin 1234', totp: '', fields: [], folder: '', fav: false, history: [], created: now, updated: now };
        window.__ids = { folder: f.id };
        var list = [ f, e( 'Mail', 'me@mail.example', 'mail-pass-1', 'mail.example', '', true ), e( 'Card PIN', 'x', 'pin-9', '', f.id ), note ];
        list.forEach( function ( n ) { window.__ids[ n.title ] = n.id; } );
        return putItems( list ).then( function () { render(); return true; } ); } )()` );
    ok( await disk( () => live().length === 5 ), "4 more (a folder, a favourite, one in the folder, a note): 5 in the file" );
    ok( await c.evaluate( "document.querySelectorAll( '#items .pw-item' ).length === 4" ), "the top level shows the folder + 3 entries" );
    ok( await c.evaluate( "document.querySelector( '#filterRow [data-filter=\"all\"]' ).textContent.indexOf( '4' ) >= 0" ), "All (4): folders are not counted" );
    ok( await c.evaluate( "document.getElementById( 'items' ).innerHTML.indexOf( 'CANARY-pw' ) < 0 && document.getElementById( 'items' ).innerHTML.indexOf( 'mail-pass-1' ) < 0" ),
        "no password is ever drawn in the list" );
    await shot( c, "04-list" );

    // Search: by user name and site, never by password.
    await c.evaluate( "setQuery( 'canary-user' ); true" );
    ok( await c.evaluate( "document.querySelectorAll( '#items .pw-item' ).length === 1" ), "search finds the user name" );
    await c.evaluate( "setQuery( 'CANARY-pw' ); true" );
    ok( await c.evaluate( "document.querySelectorAll( '#items .pw-item' ).length === 0" ), "search does not look inside passwords" );
    await c.evaluate( "setQuery( '' ); goFolder( __ids.folder ); true" );
    ok( await c.evaluate( "document.querySelectorAll( '#items .pw-item' ).length === 1" ), "the folder shows its entry" );
    await c.evaluate( "goFolder( ROOT ); true" );
}

//----------------------------------------------------------------------------//
section( "EDIT · HISTORY, NO-OP SAVES, DELETE + UNDO, FAVOURITES, MOVE" );
{
    const before = json().items[ canaryId ].r;
    await c.evaluate( `openItemSheet( ${JSON.stringify( canaryId )} ); true` );
    await c.evaluate( "saveItemSheet(); true" );
    await sleep( 800 );
    ok( json().items[ canaryId ].r === before, "saved with no change: nothing written (same revision)" );

    await c.evaluate( `openItemSheet( ${JSON.stringify( canaryId )} ); document.getElementById( 'itPass' ).value = 'new-pass-2'; saveItemSheet(); true` );
    ok( await disk( () => json().items[ canaryId ].r === before + 1 ), "a new password: one new revision" );
    ok( await c.evaluate( `item( ${JSON.stringify( canaryId )} ).history[ 0 ].pass === ${JSON.stringify( CANARY.pass )}` ), "the old password went to the history" );

    await c.evaluate( "deleteNodes( [ __ids.folder ] ); true" );
    ok( await disk( () => live().length === 3 && Object.values( json().items ).filter( e => e.x === 1 ).length === 2 ),
        "deleting a folder takes its entry too: both marked deleted (no content kept)" );
    await c.evaluate( "( document.querySelector( '#toast .toast-undo' ) || { click: function () {} } ).click(); true" );
    ok( await disk( () => live().length === 5 ), "Undo: both back" );
    ok( await c.until( "!! item( __ids[ 'Card PIN' ] ) && parentOf[ __ids[ 'Card PIN' ] ] === __ids.folder" ), "…the entry inside its folder again" );

    await c.evaluate( "setFavourite( [ __ids.Wifi ] ); true" );
    ok( await c.until( "item( __ids.Wifi ).fav" ), "favourite on" );
    await c.evaluate( "doMove( [ __ids.Mail ], __ids.folder ); true" );
    ok( await c.until( "parentOf[ __ids.Mail ] === __ids.folder" ), "moved into the folder" );
    await c.evaluate( "doMove( [ __ids.folder ], __ids.folder ); true" );
    ok( await c.until( "( window.__toasts || [] ).some( function ( t ) { return t.indexOf( Ayni.t( 'passwords.cycle' ) ) >= 0; } )" ), "a folder into itself: refused" );
}

//----------------------------------------------------------------------------//
section( "LOCK · NOTHING LEFT ON THE PAGE; WRONG PASSWORDS NEVER WRITE" );
{
    await c.evaluate( `openItemSheet( ${JSON.stringify( canaryId )} ); true` );
    await c.evaluate( "lock(); true" );
    ok( await c.evaluate( "! isOpen() && ! document.getElementById( 'unlockBox' ).hidden" ), "locked: the unlock box shows" );
    const page = await c.evaluate( "document.body.innerHTML + Array.from( document.querySelectorAll( 'input, textarea' ) ).map( function ( i ) { return i.value; } ).join( '|' )" );
    ok( noSecret( page ) && page.indexOf( "new-pass-2" ) < 0 && page.indexOf( "mail-pass-1" ) < 0, "no title, user, password or note left in the page or its boxes" );
    ok( await c.evaluate( "Object.keys( items ).length === 0 && opened.size === 0 && keys === null" ), "the model and the keys are gone" );
    ok( await c.evaluate( "! document.querySelector( '.sheet-backdrop.open' )" ), "the open sheet closed with it" );
    ok( await c.evaluate( "! document.getElementById( 'hintBtn' ).hidden && document.getElementById( 'hintText' ).hidden" ),
        "the reminder phrase waits behind its button" );
    await c.evaluate( "document.getElementById( 'hintBtn' ).click(); true" );
    await answerDialog( c, "not my login" );
    ok( await c.until( "/does not open|no abre/i.test( document.getElementById( 'unlockErr' ).textContent )", 20000 ) && await c.evaluate( "document.getElementById( 'hintText' ).hidden" ),
        "\"Show my reminder phrase\" with a wrong Nayive password: not shown" );
    await c.evaluate( "document.getElementById( 'hintBtn' ).click(); true" );
    await answerDialog( c, "test" );
    ok( await c.until( `! document.getElementById( 'hintText' ).hidden && document.getElementById( 'hintText' ).textContent.indexOf( ${JSON.stringify( HINT )} ) >= 0
                        && document.getElementById( 'hintBtn' ).hidden`, 20000 ), "with the right one: shown" );
    await shot( c, "05b-hint" );

    await sleep( 2500 );                    // the saves made before the lock are on disk
    const stamp = fs.statSync( path.join( s.home(), FILE ) ).mtimeMs;
    ok( ! await unlock( c, "not the master password at all" ), "a wrong master password: refused" );
    ok( await c.evaluate( "/wrong|incorrect/i.test( document.getElementById( 'unlockErr' ).textContent )" ), "…and said" );
    for( let i = 0; i < 4; i++ ) await unlock( c, "still not the master password " + i );
    ok( await c.evaluate( "document.getElementById( 'unlockBtn' ).ariaDisabled === 'true'" ), "five wrong ones: a wait before the next try" );
    ok( fs.statSync( path.join( s.home(), FILE ) ).mtimeMs === stamp, "no wrong password wrote anything" );
    await c.evaluate( "waitUntil = 0; failures = 0; document.getElementById( 'unlockBtn' ).ariaDisabled = false; true" );
    await shot( c, "05-locked" );
    ok( await unlock( c, PW ), "the right one opens it" );
    ok( await c.until( "Object.keys( items ).length === 5" ), "all 5 back" );
}

//----------------------------------------------------------------------------//
section( "AUTO-LOCK · IDLE TIME AND NAYIVE'S SCREEN LOCKER" );
{
    await c.evaluate( "lastActive = Date.now() - ( ui.lockMin + 1 ) * 60000; true" );
    ok( await c.until( "! isOpen()", 15000 ), "idle longer than the setting: locked by itself" );
    ok( await unlock( c, PW ), "unlocked again" );
    await c.evaluate( "localStorage.setItem( 'nayive-lock', '1' ); true" );
    ok( await c.until( "! isOpen()", 15000 ), "the screen locker comes on: locked" );
    await c.evaluate( "localStorage.removeItem( 'nayive-lock' ); true" );
    ok( await unlock( c, PW ), "unlocked again" );
}

//----------------------------------------------------------------------------//
section( "CLIPBOARD · A COPIED PASSWORD IS WIPED" );
{
    await c.send( "Browser.grantPermissions", { origin: s.base, permissions: [ "clipboardReadWrite", "clipboardSanitizedWrite" ] } ).catch( () => {} );
    await c.send( "Emulation.setFocusEmulationEnabled", { enabled: true } ).catch( () => {} );
    const works = await c.evaluate( "navigator.clipboard.writeText( 'probe' ).then( function () { return navigator.clipboard.readText(); } ).then( function ( t ) { return t === 'probe'; }, function () { return false; } )" );
    await c.evaluate( `ui.clipSec = 1; copyFromItem( ${JSON.stringify( canaryId )}, 'pass' ); true` );
    const got = works ? await c.evaluate( "new Promise( function ( r ) { setTimeout( function () { navigator.clipboard.readText().then( r, function () { r( null ); } ); }, 300 ); } )" ) : null;
    ok( await c.until( "( window.__toasts || [] ).some( function ( t ) { return /cleared in 1 s|vacía en 1 s/.test( t ); } )" ), "Copy password says when the clipboard is wiped" );
    if( got === null ) console.log( "  (skip: headless Chromium has no real clipboard to read back)" );
    else
    {
        ok( got === "new-pass-2", "Copy password puts it on the clipboard", got );
        const after = await c.evaluate( "new Promise( function ( r ) { setTimeout( function () { navigator.clipboard.readText().then( r, function () { r( null ); } ); }, 1600 ); } )" );
        ok( after === "", "…and it is wiped after the time set", after );
    }
    await c.evaluate( "ui.clipSec = 30; true" );
}

//----------------------------------------------------------------------------//
section( "STORAGE · NO SECRET IN INDEXEDDB, LOCALSTORAGE OR ANY URL" );
{
    const idb = await c.evaluate( `new Promise( function ( res ) {
        var rq = indexedDB.open( 'nube-store' );
        rq.onsuccess = function () {
            var db = rq.result, out = [], names = Array.from( db.objectStoreNames ), left = names.length;
            if( ! left ) return res( '' );
            names.forEach( function ( n ) {
                var all = db.transaction( n ).objectStore( n ).getAll();
                all.onsuccess = function () { out.push( JSON.stringify( all.result, function ( k, v ) { return v instanceof Uint8Array ? new TextDecoder().decode( v ) : v; } ) ); if( ! --left ) res( out.join( '\\n' ) ); };
                all.onerror = function () { if( ! --left ) res( out.join( '\\n' ) ); };
            } );
        };
        rq.onerror = function () { res( '' ); };
    } )` );
    ok( idb.length > 100 && noSecret( idb ) && idb.indexOf( "new-pass-2" ) < 0, "the offline cache and outbox hold the vault - ciphertext only" );
    const ls = await c.evaluate( "JSON.stringify( Object.assign( {}, localStorage ) )" );
    ok( noSecret( ls ) && ls.indexOf( "new-pass-2" ) < 0, "localStorage: nothing secret" );
    ok( noSecret( await c.evaluate( "document.title + location.href" ) ), "title and address: nothing secret" );
    const bak = onDisk( s, "data/passwords/.bak/passwords.json" );
    ok( bak === null || noSecret( bak ), "the server's .bak (if made) is ciphertext too" );
}

//----------------------------------------------------------------------------//
section( "TAMPERING · A CHANGED BYTE, SWAPPED ENTRIES, A WEAKER KDF, A NEWER FORMAT" );
{
    await sleep( 1500 );                    // every save of the page is on disk
    const good = raw();
    const put  = f => fs.writeFileSync( path.join( s.home(), FILE ), typeof f === "string" ? f : JSON.stringify( f, null, 2 ) );
    const flip = str => { const i = 40; return str.slice( 0, i ) + ( str[ i ] === "A" ? "B" : "A" ) + str.slice( i + 1 ); };

    // One entry's ciphertext changed: that one will not open, the others do; it is kept as it was.
    let f = JSON.parse( good );
    const ids = Object.keys( f.items ).filter( id => f.items[ id ].c );
    const hurt = ids.find( id => id !== canaryId );
    f.items[ hurt ].c = flip( f.items[ hurt ].c );
    put( f );
    await c.evaluate( "lock(); true" );
    ok( await openApp( c ), "reopened" );
    ok( await unlock( c, PW ), "unlocks" );
    ok( await c.until( "Object.keys( items ).length === 4 && damaged === 1" ), "4 open, 1 damaged (not shown)" );
    ok( await c.until( "( window.__toasts || [] ).some( function ( t ) { return /damaged|dañad/i.test( t ); } )" ), "…and said" );
    const rBefore = f.items[ canaryId ].r;
    await c.evaluate( `( function () { var n = Object.assign( {}, item( ${JSON.stringify( canaryId )} ), { notes: 'edited after damage' } ); return putItems( [ n ] ).then( function () { return true; } ); } )()` );
    ok( await disk( () => json().items[ canaryId ].r === rBefore + 1 ) && json().items[ hurt ].c === f.items[ hurt ].c,
        "a save after it keeps the damaged entry byte for byte" );
    await sleep( 1000 );

    // Two entries' ciphertexts swapped: neither opens (each is bound to its id).
    f = JSON.parse( raw() );
    const [ a, b ] = Object.keys( f.items ).filter( id => f.items[ id ].c && id !== hurt ).slice( 0, 2 );
    [ f.items[ a ], f.items[ b ] ] = [ f.items[ b ], f.items[ a ] ];
    put( f );
    await c.evaluate( "lock(); true" );
    await openApp( c );
    await unlock( c, PW );
    ok( await c.until( "damaged === 3" ), "swapped entries: both refused (3 damaged now)" );

    // A lower KDF setting (still allowed): the lock no longer opens - the header is bound.
    f = JSON.parse( good );
    f.kdf.t = 2;
    put( f );
    await c.evaluate( "lock(); true" );
    await openApp( c );
    ok( ! await unlock( c, PW ), "kdf.t 3 -> 2 in the file: the right password no longer opens it (no downgrade)" );

    // Below the floor: refused before any work, shown as damaged, never written.
    f = JSON.parse( good );
    f.kdf.m = 1024;
    put( f );
    await openApp( c );
    ok( await c.evaluate( "fileState === 'bad' && /damaged|dañado/i.test( document.getElementById( 'gateTitle' ).textContent )" ), "64 MiB -> 1 MiB: refused as damaged" );

    // A newer version: not read, not written.
    f = JSON.parse( good );
    f.v = 2;
    put( f );
    await openApp( c );
    ok( await c.evaluate( "fileState === 'newer'" ), "v 2: \"made by a newer Nayive\"" );
    const t0 = fs.statSync( path.join( s.home(), FILE ) ).mtimeMs;
    await sleep( 1500 );
    ok( fs.statSync( path.join( s.home(), FILE ) ).mtimeMs === t0, "…and left alone" );

    put( good );
    await openApp( c );
    ok( await unlock( c, PW ), "the good file back: opens" );
    ok( await c.until( "Object.keys( items ).length === 5 && damaged === 0" ), "all 5" );
}

//----------------------------------------------------------------------------//
section( "TWO DEVICES · MERGED WITHOUT THE KEY, NOTHING LOST" );
{
    const d = await browser( s, { mouse: true } );
    ok( await openApp( d ), "a second device opens Passwords" );
    ok( await unlock( d, PW ), "…and unlocks" );
    await d.evaluate( "window.__ids = {}; Object.keys( items ).forEach( function ( id ) { window.__ids[ items[ id ].title ] = id; } ); true" );
    await c.evaluate( "window.__ids = {}; Object.keys( items ).forEach( function ( id ) { window.__ids[ items[ id ].title ] = id; } ); true" );

    const add = ( p, title ) => p.evaluate( `( function () { var now = nowIso(); return putItems( [ { id: PwVault.newId(), type: 'login', title: ${JSON.stringify( title )}, user: 'u', pass: 'p', urls: [], notes: '', totp: '', fields: [], folder: '', fav: false, history: [], created: now, updated: now } ] ).then( function () { return true; } ); } )()` );
    const titles = async () => { const o = await nodeOpen( json(), PW ); const out = []; for( const [ id ] of live() ) out.push( ( await o.item( id ) ).title ); return out.sort(); };

    await add( c, "From PC" );
    ok( await disk( () => live().length === 6 ), "the PC adds one" );
    await add( d, "From phone" );          // the phone's page still has the file from before
    ok( await disk( () => live().length === 7 ), "the phone adds one over it: merged, 7 in the file" );
    const t1 = await titles();
    ok( t1.indexOf( "From PC" ) >= 0 && t1.indexOf( "From phone" ) >= 0, "both are there", t1 );

    // Both change the same entry: one stays, the other becomes an entry of its own.
    await c.evaluate( "loadData().then( function () { return true; } )" );
    await d.evaluate( "loadData().then( function () { return true; } )" );
    const edit = ( p, t ) => p.evaluate( `putItems( [ Object.assign( {}, item( __ids.Wifi ), { notes: ${JSON.stringify( t )} } ) ] ).then( function () { return true; } )` );
    await edit( c, "PC's wifi note" );
    await sleep( 800 );
    await edit( d, "phone's wifi note" );
    ok( await disk( () => live().length === 8 ), "both edited the same entry: 8 entries (the other version kept)" );
    const o = await nodeOpen( json(), PW );
    const notes = [];
    for( const [ id ] of live() ) { const n = await o.item( id ); if( /wifi/i.test( n.title ) ) notes.push( n.title + ": " + n.notes ); }
    ok( notes.some( n => /phone's wifi note/.test( n ) ) && notes.some( n => /PC's wifi note/.test( n ) && /\(/.test( n ) ),
        "one keeps its place, the other is \"Wifi (other device)\"", notes );
    ok( ! json().copies, "no copies left waiting in the file" );

    // Deleted on one, edited on the other: the edit is not lost.
    await c.evaluate( "loadData().then( function () { return true; } )" );
    await d.evaluate( "loadData().then( function () { return true; } )" );
    await c.evaluate( "deleteItems( [ __ids[ 'Card PIN' ] ] ).then( function () { return true; } )" );
    await sleep( 800 );
    await d.evaluate( "putItems( [ Object.assign( {}, item( __ids[ 'Card PIN' ] ), { pass: 'pin-changed' } ) ] ).then( function () { return true; } )" );
    await sleep( 2500 );
    const o2 = await nodeOpen( json(), PW );
    let kept = false;
    for( const [ id ] of live() ) { const n = await o2.item( id ); if( n.pass === "pin-changed" ) kept = true; }
    ok( kept, "deleted on the PC, changed on the phone: the change is kept" );

    // The PC sees the phone's work after a re-read.
    await c.evaluate( "loadData().then( function () { return true; } )" );
    ok( await c.until( "Object.keys( items ).map( function ( id ) { return items[ id ].title; } ).indexOf( 'From phone' ) >= 0" ), "the PC shows the phone's entries" );
    await d.stop();
}

//----------------------------------------------------------------------------//
section( "TWO VAULTS AT ONCE · THE SERVER'S IS NEVER WRITTEN OVER" );
{
    const puts = await c.evaluate( "window.__puts" );
    ok( puts.length && puts.every( x => x.im || x.inm ), "every PUT of the vault carried its version", puts );

    const a = await browser( s, { user: "ana", password: "ana" } );
    ok( await openApp( a ), "ana opens Passwords" );
    ok( await a.evaluate( "fileState === 'empty'" ), "…no vault yet: the set-up" );
    const phone = await s.client( "ana", "ana" );
    const theirs = raw();
    const r = await phone.put( FILE, theirs );
    ok( r.status === 200 || r.status === 201, "meanwhile her phone puts a vault on the server" );
    await a.evaluate( `document.getElementById( 'setupPw' ).value = document.getElementById( 'setupPw2' ).value = ${JSON.stringify( PW2 )}; createVault(); true` );
    await a.until( "! document.getElementById( 'recoveryBox' ).hidden", 30000 );
    await a.evaluate( "recoveryDone(); true" );
    await sleep( 4000 );
    ok( onDisk( s, FILE, "ana" ) === theirs, "this page's new vault did not write over the phone's" );
    const ap = await a.evaluate( "window.__puts" );
    ok( ap.some( x => x.st === 412 ) && ap.every( x => x.st !== 200 && x.st !== 201 ), "its save was refused (412), never sent blind", ap );
    await a.stop();
}

//----------------------------------------------------------------------------//
section( "MASTER PASSWORD · CHANGE, RECOVERY KEY, NEW RECOVERY KEY" );
{
    const hint0 = JSON.stringify( json().hint );
    await c.evaluate( "openChangePw( false ); true" );
    await c.until( "chpwPhrase !== ''" );
    await c.evaluate( `document.getElementById( 'chpwCur' ).value = ${JSON.stringify( PW )};
                       document.getElementById( 'chpwNew' ).value = document.getElementById( 'chpwNew2' ).value = 'Common WORDS about the comic';
                       document.getElementById( 'chpwNew' ).dispatchEvent( new Event( 'input' ) ); saveChangePw(); true` );
    ok( await c.until( "/reminder phrase has every word|todas las palabras y signos de esta/i.test( document.getElementById( 'chpwErr' ).textContent )" ),
        "a new master password whose every word is in the phrase: refused" );
    await c.evaluate( `document.getElementById( 'chpwNew' ).value = document.getElementById( 'chpwNew2' ).value = ${JSON.stringify( PW2 )}; saveChangePw(); true` );
    ok( await c.until( "! document.getElementById( 'chpwBackdrop' ).classList.contains( 'open' )", 30000 ), "Change master password: saved" );
    await sleep( 1500 );
    ok( JSON.stringify( json().hint ) === hint0, "the reminder phrase stays as it was" );
    await sleep( 500 );
    await c.evaluate( "lock(); true" );
    ok( ! await unlock( c, PW ), "the old one no longer opens it" );
    ok( await unlock( c, PW2 ), "the new one does" );
    ok( await nodeOpen( json(), PW2 ).then( () => true, () => false ), "…and so does Node, with the new one" );

    await c.evaluate( "lock(); true" );
    await c.evaluate( "openRecoverySheet(); document.getElementById( 'recInput' ).value = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789'; useRecovery(); true" );
    ok( await c.until( "! document.getElementById( 'recErr' ).hidden", 15000 ), "a wrong recovery key: refused" );
    await c.evaluate( `document.getElementById( 'recInput' ).value = ${JSON.stringify( recovery.toLowerCase().replace( /-/g, " " ) )}; useRecovery(); true` );
    ok( await c.until( "isOpen() && document.getElementById( 'chpwBackdrop' ).classList.contains( 'open' ) && document.getElementById( 'chpwCurRow' ).hidden", 15000 ),
        "the recovery key (typed in lower case, with spaces) opens it and asks for a new master password" );

    // His bug (2026-10-15): that sheet cancelled = in the vault, old password kept, nothing said.
    const unchanged = "Array.from( document.querySelectorAll( '.sheet-backdrop.open h2' ) ).some( function ( h ) { return /unchanged|no ha cambiado/i.test( h.textContent ); } )";
    const pressInDialog = cls => c.evaluate( `( function () { var backs = document.querySelectorAll( '.sheet-backdrop.open' ), b = backs[ backs.length - 1 ];
        b.querySelector( '${cls}' ).click(); return true; } )()` );
    await c.evaluate( "NayiveUI.close( 'chpwBackdrop' ); true" );
    ok( await c.until( unchanged ), "cancelled with no new password: \"Master password unchanged\" says the old one still opens it" );
    await pressInDialog( ".btn.primary" );
    ok( await c.until( "document.getElementById( 'chpwBackdrop' ).classList.contains( 'open' ) && document.getElementById( 'chpwCurRow' ).hidden && !! rawAfterRec" ),
        "✓ \"Set a new one\": the sheet again, no current password asked" );
    await c.evaluate( "NayiveUI.close( 'chpwBackdrop' ); true" );
    await c.until( unchanged );
    await pressInDialog( "[data-close]" );
    ok( await c.until( "rawAfterRec === null && isOpen() && ! document.querySelector( '.sheet-backdrop.open' )" ), "× \"Keep the old one\": the vault stays open, the recovery's key is wiped" );
    await c.evaluate( "lock(); true" );
    ok( await unlock( c, PW2 ), "…and the old master password still opens it" );
    await c.evaluate( "lock(); true" );
    await c.evaluate( `openRecoverySheet(); document.getElementById( 'recInput' ).value = ${JSON.stringify( recovery )}; useRecovery(); true` );
    ok( await c.until( "isOpen() && document.getElementById( 'chpwBackdrop' ).classList.contains( 'open' )", 15000 ), "the recovery key again" );
    await c.evaluate( `document.getElementById( 'chpwNew' ).value = document.getElementById( 'chpwNew2' ).value = ${JSON.stringify( PW3 )}; saveChangePw(); true` );
    ok( await c.until( "! document.getElementById( 'chpwBackdrop' ).classList.contains( 'open' )", 30000 ), "new master password set" );
    ok( await c.until( "rawAfterRec === null" ) && await c.evaluate( `! ( ${unchanged} )` ), "…and saved: no \"unchanged\" question" );
    await sleep( 500 );
    await c.evaluate( "lock(); true" );
    ok( await unlock( c, PW3 ), "it opens with the new one" );

    // Merge: the phrase is a header part of its own.
    ok( await c.evaluate( `( function () {
        var base = JSON.parse( serialize() ); delete base.hint; base = JSON.stringify( base );
        var t = JSON.parse( base ); t.hint = JSON.parse( serialize() ).hint;
        var added = JSON.parse( PwVault.merge( base, base, JSON.stringify( t ) ) );
        var gone  = JSON.parse( PwVault.merge( JSON.stringify( t ), base, JSON.stringify( t ) ) );
        return !! added.hint && added.hint.c === t.hint.c && gone.hint === undefined;
    } )()` ), "merge: a phrase added on the other device arrives; one removed here stays removed" );

    await c.evaluate( "newRecoveryKey(); true" );
    await answerDialog( c, PW3 );
    ok( await c.until( "document.getElementById( 'recShowBackdrop' ).classList.contains( 'open' ) && recShown.length === 39", 30000 ), "New recovery key: shown once" );
    const recovery2 = await c.evaluate( "recShown" );
    await c.evaluate( "NayiveUI.close( 'recShowBackdrop' ); true" );
    await sleep( 500 );
    await c.evaluate( "lock(); true" );
    await c.evaluate( `openRecoverySheet(); document.getElementById( 'recInput' ).value = ${JSON.stringify( recovery )}; useRecovery(); true` );
    ok( await c.until( "! document.getElementById( 'recErr' ).hidden", 15000 ), "the old recovery key stopped working" );
    await c.evaluate( `document.getElementById( 'recInput' ).value = ${JSON.stringify( recovery2 )}; useRecovery(); true` );
    ok( await c.until( "isOpen()", 15000 ), "the new one works" );
    await c.evaluate( "NayiveUI.close( 'chpwBackdrop' ); true" );
}

//----------------------------------------------------------------------------//
section( "REMINDER PHRASE · SETTINGS, A NEW NAYIVE PASSWORD, REMOVED" );
{
    const fill = ( phrase, master, login ) => c.evaluate( `( function () {
        document.getElementById( 'hintEdit' ).value = ${JSON.stringify( phrase )}; document.getElementById( 'hintMaster' ).value = ${JSON.stringify( master )};
        document.getElementById( 'hintLogin' ).value = ${JSON.stringify( login )}; document.getElementById( 'hintEdit' ).dispatchEvent( new Event( 'input' ) );
        savePhrase(); return true; } )()` );
    await c.evaluate( "openPhraseSheet(); true" );
    ok( await c.until( `document.getElementById( 'hintEdit' ).value === ${JSON.stringify( HINT )}` ), "Settings › Reminder phrase: it shows the current one" );
    await fill( "my new reminder", "not the master password", "test" );
    ok( await c.until( "/wrong master|maestra incorrecta/i.test( document.getElementById( 'hintErr' ).textContent )", 20000 ), "a wrong master password: refused" );
    await fill( "third time lucky master pass 99", PW3, "test" );
    ok( await c.until( "/all the words|todas las palabras/i.test( document.getElementById( 'hintErr' ).textContent )" ), "every word of the master password: refused" );
    await fill( "my new reminder", PW3, "wrong login" );
    ok( await c.until( "/wrong nayive|nayive incorrecta/i.test( document.getElementById( 'hintErr' ).textContent )", 20000 ), "a wrong Nayive password: refused" );
    const before = JSON.stringify( json().hint );
    await fill( "my new reminder", PW3, "test" );
    ok( await c.until( "! document.getElementById( 'hintBackdrop' ).classList.contains( 'open' )", 30000 ), "saved" );
    ok( await disk( () => JSON.stringify( json().hint ) !== before ) && await nodeHint( json(), "test" ) === "my new reminder", "the file holds the new one (Node opens it)" );

    // The Nayive password changes: the phrase opens with the OLD one until it is saved again.
    ok( await c.evaluate( "fetch( '/api/password', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { current: 'test', new: 'test-two-longer' } ) } ).then( function ( r ) { return r.status; } )" ) === 200,
        "(the Nayive password changes)" );
    await c.evaluate( "lock(); true" );
    await c.evaluate( "document.getElementById( 'hintBtn' ).click(); true" );
    await answerDialog( c, "test-two-longer" );
    ok( await c.until( "/does not open|no abre/i.test( document.getElementById( 'unlockErr' ).textContent )", 20000 ), "the new Nayive password does not open the old phrase - and says to type the old one" );
    await c.evaluate( "document.getElementById( 'hintBtn' ).click(); true" );
    await answerDialog( c, "test" );
    ok( await c.until( "document.getElementById( 'hintText' ).textContent.indexOf( 'my new reminder' ) >= 0", 20000 ), "the old one still does" );
    ok( await unlock( c, PW3 ), "unlocked" );
    await c.evaluate( "openPhraseSheet(); true" );
    await c.until( "document.getElementById( 'hintEdit' ).value === 'my new reminder'" );
    const sealedOld = json().hint.c;
    await fill( "my new reminder", PW3, "test-two-longer" );
    ok( await c.until( "! document.getElementById( 'hintBackdrop' ).classList.contains( 'open' )", 30000 ), "saved again with the new Nayive password" );
    ok( await disk( () => json().hint.c !== sealedOld ) && await nodeHint( json(), "test-two-longer" ).then( h => h === "my new reminder", () => false ), "now it opens with the new one" );

    // Removed: empty box, nothing asked.
    await c.evaluate( "openPhraseSheet(); true" );
    await c.until( "document.getElementById( 'hintEdit' ).value === 'my new reminder'" );
    await c.evaluate( "document.getElementById( 'hintEdit' ).value = ''; document.getElementById( 'hintEdit' ).dispatchEvent( new Event( 'input' ) ); true" );
    ok( await c.evaluate( "document.getElementById( 'hintPwRows' ).hidden" ), "an empty phrase asks for no password" );
    await c.evaluate( "savePhrase(); true" );
    ok( await disk( () => json().hint === undefined ), "removed from the file" );
    await c.evaluate( "lock(); true" );
    ok( await c.evaluate( "document.getElementById( 'hintBtn' ).hidden" ), "…and no reminder button on the lock screen" );
    ok( await unlock( c, PW3 ), "unlocked" );
    await c.evaluate( "fetch( '/api/password', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { current: 'test-two-longer', new: 'test' } ) } ).then( function () { return true; } )" );
}

//----------------------------------------------------------------------------//
section( "IMPORT · CSV FROM CHROME, KEEPASSXC, BITWARDEN; AN ENCRYPTED BACKUP" );
{
    const n0 = await c.evaluate( "allEntries().length" );
    const chrome = "name,url,username,password,note\nexample.com,https://example.com/login,ana,ana-pass,\nshop,https://shop.example/,ana@x,\"pa,ss\"\"word\",line1\n";
    await c.evaluate( `importCsv( ${JSON.stringify( chrome )} ); true` );
    await answerDialog( c );
    ok( await c.until( `allEntries().length === ${n0 + 2}` ), "Chrome: 2 entries" );
    ok( await c.evaluate( "allEntries().some( function ( n ) { return n.pass === 'pa,ss\"word' && n.notes === 'line1'; } )" ), "quotes and commas inside a field survive" );
    await c.evaluate( `importCsv( ${JSON.stringify( chrome )} ); true` );
    ok( await c.until( "( window.__toasts || [] ).some( function ( t ) { return /already|ya est/i.test( t ); } )" ), "the same file again: nothing added twice" );

    const keepass = '"Group","Title","Username","Password","URL","Notes","TOTP"\n"Root/Work/Servers","ssh box","root","s3cr3t","ssh.example","multi\nline","JBSWY3DPEHPK3PXP"\n';
    await c.evaluate( `importCsv( ${JSON.stringify( keepass )} ); true` );
    await answerDialog( c );
    ok( await c.until( "allEntries().some( function ( n ) { return n.title === 'ssh box' && n.notes === 'multi\\nline' && n.totp === 'JBSWY3DPEHPK3PXP'; } )" ), "KeePassXC: line breaks and the TOTP key kept" );
    ok( await c.evaluate( "( function () { var n = allEntries().filter( function ( x ) { return x.title === 'ssh box'; } )[ 0 ]; return pathText( parentOf[ n.id ] ) === 'Work › Servers'; } )()" ),
        "\"Root/Work/Servers\" -> folders Work › Servers" );

    const bw = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nWork,1,login,gitlab,,\"pin: 1234\",0,https://gitlab.example,dev,gl-pass,\n,,note,a secure note,the note body,,0,,,,\n";
    await c.evaluate( `importCsv( ${JSON.stringify( bw )} ); true` );
    await answerDialog( c );
    ok( await c.until( "allEntries().some( function ( n ) { return n.title === 'gitlab' && n.fav && n.fields[ 0 ] && n.fields[ 0 ].name === 'pin'; } )" ), "Bitwarden: favourite and custom field" );
    ok( await c.evaluate( "allEntries().some( function ( n ) { return n.type === 'note' && n.notes === 'the note body'; } )" ), "…and a secure note" );
    ok( await c.evaluate( "Object.keys( items ).map( item ).filter( function ( f ) { return isFolder( f ) && f.title === 'Work'; } ).length === 1" ),
        "\"Work\" from two files is one folder" );
    ok( noSecret( raw() ) && raw().indexOf( "gl-pass" ) < 0 && raw().indexOf( "s3cr3t" ) < 0, "the file still holds no secret in the clear" );

    // Encrypted backup: export, delete two, import it back (its master password asked).
    const backup = await c.evaluate( "serialize()" );
    const total = await c.evaluate( "Object.keys( items ).length" );
    await c.evaluate( "deleteItems( allEntries().slice( 0, 2 ).map( function ( n ) { return n.id; } ) ).then( function () { return true; } )" );
    ok( await c.until( `Object.keys( items ).length === ${total - 2}` ), "two deleted" );
    await c.evaluate( `importBackup( JSON.parse( ${JSON.stringify( backup )} ) ); true` );
    await answerDialog( c, PW3 );
    ok( await c.until( `Object.keys( items ).length === ${total}`, 30000 ), "the backup brings back exactly what is missing" );

    // Plain CSV export: master password first; a Bitwarden-shaped file.
    await c.evaluate( "window.__saved = null; NayiveUI.saveFile = function ( d, n, t ) { window.__saved = { d: d, n: n, t: t }; }; exportCsv(); true" );
    await answerDialog( c, "wrong master password here" );
    await sleep( 2500 );
    ok( await c.evaluate( "window.__saved === null" ), "plain export with a wrong master password: nothing made" );
    await c.evaluate( "exportCsv(); true" );
    await answerDialog( c, PW3 );
    ok( await c.until( "!! window.__saved", 20000 ), "with the right one: a CSV" );
    const csv = await c.evaluate( "window.__saved.d" );
    ok( csv.split( "\r\n" )[ 0 ] === "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp" && csv.indexOf( "gl-pass" ) >= 0,
        "Bitwarden's columns, every password" );
    await answerDialog( c );
}

//----------------------------------------------------------------------------//
section( "GENERATOR · UNIFORM, EVERY SET, WORDS FROM THE LIST" );
{
    const r = await c.evaluate( `( function () {
        var counts = {}, n = 0;
        for( var i = 0; i < 2000; i++ ) { var p = genChars( { len: 20, lower: true } ).text; for( var ch of p ) { counts[ ch ] = ( counts[ ch ] || 0 ) + 1; n++; } }
        var keys = Object.keys( counts ), mean = n / 26, worst = 0;
        keys.forEach( function ( k ) { worst = Math.max( worst, Math.abs( counts[ k ] - mean ) / mean ); } );
        var all = true;
        for( var j = 0; j < 300; j++ ) { var q = genChars( { len: 8, lower: true, upper: true, digits: true, symbols: true } ).text;
            all = all && /[a-z]/.test( q ) && /[A-Z]/.test( q ) && /[0-9]/.test( q ) && /[^a-zA-Z0-9]/.test( q ) && q.length === 8; }
        var look = true;
        for( var k = 0; k < 300; k++ ) look = look && ! /[0Oo1lI|]/.test( genChars( { len: 32, lower: true, upper: true, digits: true, noLook: true } ).text );
        return { letters: keys.length, worst: worst, all: all, look: look };
    } )()` );
    ok( r.letters === 26 && r.worst < 0.1, "40 000 letters: all 26, each within 10 % of the mean", r );
    ok( r.all, "8 characters, four sets asked: every set in every password" );
    ok( r.look, "\"avoid look-alikes\": no 0 O o 1 l I |" );
    const w = await c.evaluate( "genWords( { count: 6, sep: '.', caps: true, num: true } ).then( function ( x ) { return loadWords().then( function ( list ) { var parts = x.text.split( '.' ); return { n: parts.length, inList: parts.every( function ( p ) { return list.indexOf( p.replace( /\\d$/, '' ).toLowerCase() ) >= 0; } ), digit: /\\d/.test( x.text ), bits: x.bits }; } ); } )" );
    ok( w.n === 6 && w.inList && w.digit && w.bits >= 77, "6 words from the EFF list, capitals, a number, ≥ 77 bits", w );
    await c.evaluate( "openGenerator( null ); true" );
    ok( await c.until( "document.getElementById( 'genOut' ).value.length >= 8" ), "the generator sheet makes one at once" );
    await shot( c, "06-generator" );
    await c.evaluate( "NayiveUI.close( 'genBackdrop' ); true" );
}

//----------------------------------------------------------------------------//
section( "PAGE · NO SCRIPT ERRORS, NO POLICY VIOLATIONS, ONLY ITS OWN SERVER + HIBP" );
{
    const bad = c.logs.filter( l => /EXCEPTION|Content Security Policy|Refused to/i.test( l ) );
    ok( ! bad.length, "no exception and no blocked script / style / connection", bad );
    const urls = await c.evaluate( "performance.getEntriesByType( 'resource' ).map( function ( e ) { return e.name; } )" );
    const out = urls.filter( u => ! u.startsWith( s.base ) && ! u.startsWith( "https://api.pwnedpasswords.com/range/" ) );
    ok( ! out.length, "no request anywhere else", out );
    ok( urls.every( u => noSecret( u ) ), "no secret in any address asked for" );
}

//----------------------------------------------------------------------------//
section( "LOOK · PHONE, DARK" );
{
    const p = await browser( s, { width: 375, height: 760 } );
    await openApp( p );
    await unlock( p, PW3 );
    await p.until( "document.querySelectorAll( '#items .pw-item' ).length > 0" );
    await shot( p, "07-phone-list" );
    await p.evaluate( `openItemSheet( Object.keys( items ).filter( function ( id ) { return items[ id ].type === 'login'; } )[ 0 ] ); true` );
    await sleep( 400 );
    await shot( p, "08-phone-sheet" );
    await p.evaluate( "NayiveUI.close( 'itemBackdrop' ); lock(); true" );
    await shot( p, "09-phone-locked" );
    await p.evaluate( "localStorage.setItem( 'ayni-theme', 'dark' ); true" );
    await openApp( p );
    await shot( p, "10-phone-dark" );
    await p.stop();
    console.log( "  screenshots: " + SHOTS );
}

await done( s, c );
