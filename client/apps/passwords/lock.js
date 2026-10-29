// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * lock.js - Passwords: everything before the vault is open, and closing it
 * again. The gate (set-up, unlock, the recovery key, what to say when the
 * file cannot be used), a new master password, a new recovery key, and the
 * automatic lock.
 *
 * The master password is read from its box, handed to vault.js and the box
 * emptied; it is never kept. The open vault's keys live in model.js `keys`
 * until lock().
 *
 * LOCKS BY ITSELF after ui.lockMin idle minutes (Settings; 5 by default),
 * when Nayive's screen locker comes on (the "nayive-lock" mark,
 * shared/locker.js), and on the toolbar's lock. A reload or a closed tab
 * forgets the keys anyway.
 */
"use strict";

let gateStep     = null;    // 'recovery' = the new vault's recovery key is on show
let recoveryCode = '';      // that key, until "I have written it down"
let gateBusy     = false;   // a derivation is running: no re-read now
let failures     = 0;       // wrong master passwords in a row
let waitUntil    = 0;       // ms: no try before this (after 5 wrong ones)
let lastActive   = Date.now();
let rawAfterRec  = null;    // the vault key, after the recovery key opened it, until a new master password is set
let recShown     = '';      // a new recovery key on show (recShowBackdrop), for Copy and Print
let hintPlain    = '';      // the reminder phrase, opened on this lock screen with the Nayive password
let chpwPhrase   = '';      // the reminder phrase, while the new-master-password sheet is open

const MIN_MASTER = 15;      // NIST SP 800-63B-4: a password that is the only factor
const MAX_MASTER = 256;
const MAX_HINT   = 120;

function screenLocked() { try { return localStorage.getItem( 'nayive-lock' ) === '1'; } catch( e ) { return false; } }

//------------------------------------------------------------------------//
// THE GATE

function renderGate()
{
    const show = function( id, on ) { $( id ).hidden = ! on; };
    let title = '', lead = '', box = null;

    if( ! PwVault.available() )
    {
        title = T( 'passwords.noCryptoTitle' );
        lead  = T( 'passwords.noCrypto' );
    }
    else if( fileState === 'unknown' ) { title = T( 'passwords.notReadTitle' ); lead = T( 'passwords.notRead' ); }
    else if( fileState === 'bad' )     { title = T( 'passwords.badTitle' );     lead = T( 'passwords.bad' ); }
    else if( fileState === 'newer' )   { title = T( 'passwords.newerTitle' );   lead = T( 'passwords.newer' ); }
    else if( gateStep === 'recovery' )
    {
        title = T( 'passwords.recTitle' );
        lead  = T( 'passwords.recLead' );
        box   = 'recoveryBox';
        showCode( $( 'recoveryCode' ), recoveryCode );
    }
    else if( fileState === 'empty' )
    {
        title = T( 'passwords.setupTitle' );
        lead  = T( 'passwords.setupLead' );
        box   = 'setupBox';
    }
    else
    {
        title = T( 'passwords.lockedTitle' );
        lead  = T( 'passwords.lockedLead' );
        box   = 'unlockBox';
        // The reminder phrase: behind its button, which asks for the Nayive
        // password that seals it (showPhrase).
        const has = PwVault.hintValid( env && env.hint );
        $( 'hintBtn' ).hidden  = ! has || !! hintPlain;
        $( 'hintText' ).hidden = ! has || ! hintPlain;
        $( 'hintText' ).textContent = has && hintPlain ? TF( 'passwords.hintIs', { hint: hintPlain } ) : '';
    }

    $( 'gateTitle' ).textContent = title;
    $( 'gateLead' ).textContent  = lead;
    show( 'unlockBox', box === 'unlockBox' );
    show( 'setupBox', box === 'setupBox' );
    show( 'recoveryBox', box === 'recoveryBox' );
    if( box === 'setupBox' ) drawChecks( 'setupChecks', $( 'setupPw' ).value, $( 'setupPw2' ).value );
    if( box === 'unlockBox' && ! gateBusy && ! NayiveUI.menuOpen() && ! document.querySelector( '.sheet-backdrop.open' ) )
        setTimeout( function() { if( ! $( 'unlockBox' ).hidden ) $( 'unlockPw' ).focus(); }, 0 );
}

// A recovery key on two lines of four groups: non-breaking hyphens inside a
// line (a browser breaks a line after a plain one), a break point between.
function showCode( el, code )
{
    const g = String( code || '' ).split( '-' );
    el.innerHTML = esc( g.slice( 0, 4 ).join( '\u2011' ) ) + ( g.length > 4 ? '\u2011<wbr>' + esc( g.slice( 4 ).join( '\u2011' ) ) : '' );
}

// "Opening…" under the boxes; their buttons wait meanwhile.
function setBusy( text, id )
{
    gateBusy = !! text;
    const p = $( id || 'gateBusy' );
    p.textContent = text || '';
    p.hidden = ! text;
    [ 'unlockBtn', 'createBtn', 'hintBtn', 'useRecoveryBtn', 'recGoBtn', 'chpwSaveBtn', 'hintSaveBtn' ].forEach( function( b ) { $( b ).ariaDisabled = !! text; } );
}

function sayError( id, text )
{
    const p = $( id );
    p.textContent = text || '';
    p.hidden = ! text;
}

//------------------------------------------------------------------------//
// A NEW MASTER PASSWORD  -  the rules (NIST): long enough, the same twice,
// not a pattern, not in a known leak. No "one capital, one symbol".

// -> [ { ok, text } ] for the list under the boxes.
function masterChecks( pw, pw2 )
{
    const len = Array.from( pw ).length;
    return [
        { ok: len >= MIN_MASTER && len <= MAX_MASTER, text: TF( 'passwords.ruleLength', { n: MIN_MASTER } ) },
        { ok: !! pw && ! predictable( pw ),           text: T( 'passwords.rulePattern' ) },
        { ok: !! pw && pw === pw2,                    text: T( 'passwords.ruleSame' ) }
    ];
}

function drawChecks( listId, pw, pw2 )
{
    $( listId ).innerHTML = masterChecks( pw, pw2 ).map( function( c )
    {
        return '<li class="' + ( c.ok ? 'ok' : '' ) + '">' + Ayni.icon( c.ok ? 'check' : 'close' ) + '<span>' + esc( c.text ) + '</span></li>';
    } ).join( '' );
}

//------------------------------------------------------------------------//
// THE REMINDER PHRASE  -  optional, sealed with the user's NAYIVE password
// (vault.js). Refused when it holds EVERY word AND every sign of the master
// password (case, accents and order aside); a warning when it holds some of
// its words - whoever cracks the Nayive password reads the phrase.
//   words = runs of letters / digits (folded); signs = every other character
//   but spaces, each found anywhere in the phrase.

function words( s ) { return NayiveUI.fold( s ).split( /[^\p{L}\p{N}]+/u ).filter( Boolean ); }
function signs( s ) { return String( s ).match( /[^\p{L}\p{N}\s]/gu ) || []; }

function readPhrase( id ) { return $( id ).value.trim().slice( 0, MAX_HINT ); }

// -> { bad: every word and sign of the password is in the phrase,
//      allWords: every word is (only signs are missing), shared: how many words are }
function phraseCheck( pw, phrase )
{
    const p = Array.from( new Set( words( pw ) ) ), h = new Set( words( phrase ) );
    const shared = phrase ? p.filter( function( w ) { return h.has( w ); } ).length : 0;
    const allWords = !! phrase && p.length > 0 && shared === p.length;
    const allSigns = signs( pw ).every( function( c ) { return phrase.indexOf( c ) >= 0; } );
    return { bad: allWords && allSigns, allWords: allWords, shared: shared };
}

// The line under a phrase box: the refusal, the warning, or nothing.
function drawPhraseWarn( id, pw, phrase )
{
    const c = phraseCheck( pw, phrase ), p = $( id );
    p.textContent = c.bad ? T( 'passwords.hintBad' ) : c.allWords ? T( 'passwords.hintAllWords' )
                  : c.shared ? TF( 'passwords.hintShared', { n: c.shared } ) : '';
    p.classList.toggle( 'is-bad', c.bad );
    p.hidden = ! c.bad && ! c.shared;
}

// Is `login` the signed-in account's Nayive password? The server says (the
// screen locker's /api/unlock, throttled like a sign-in): a typo would seal
// the phrase where nobody could open it. -> true, or false with the error said.
async function loginOk( login, errId, busyId )
{
    if( ! login ) { sayError( errId, T( 'passwords.loginNeeded' ) ); return false; }
    setBusy( T( 'passwords.checkingLogin' ), busyId );
    let right = null;
    try
    {
        const r = await fetch( '/api/unlock', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify( { password: login } ) } );
        right = r.status === 200 ? true : r.status === 403 ? false : null;
    }
    catch( e ) { right = null; }
    setBusy( '', busyId );
    if( right !== true ) sayError( errId, T( right === false ? 'passwords.loginWrong' : 'passwords.loginOffline' ) );
    return right === true;
}

// The lock screen's "Show my reminder phrase": the Nayive password opens it.
async function showPhrase()
{
    if( gateBusy || ! env || ! PwVault.hintValid( env.hint ) ) return;
    const login = await NayiveUI.askPassword( { title: T( 'passwords.hintShow' ), body: T( 'passwords.hintAsk' ), confirm: T( 'passwords.continue' ) } );
    if( login === null ) return;
    sayError( 'unlockErr', '' );
    setBusy( T( 'passwords.opening' ) );
    try { hintPlain = await PwVault.openHint( env, login ); }
    catch( e ) { sayError( 'unlockErr', T( e && e.message === 'kdf' ? 'passwords.kdfFailed' : 'passwords.hintWrong' ) ); }
    finally { setBusy( '' ); }
    renderGate();
}

// SETTINGS › REMINDER PHRASE  -  change it, remove it (empty), or seal it
// again after the Nayive password changed. A phrase needs the master password
// (the rule is checked against the real one) and the Nayive password.

function openPhraseSheet()
{
    if( ! isOpen() ) return;
    NayiveUI.close( 'settingsBackdrop' );
    [ 'hintEdit', 'hintMaster', 'hintLogin' ].forEach( function( id ) { $( id ).value = ''; } );
    hideSecrets( $( 'hintBackdrop' ) );
    sayError( 'hintErr', '' );
    phraseRows();
    NayiveUI.open( 'hintBackdrop' );
    PwVault.readHint( keys, env ).then( function( p ) { if( p && ! $( 'hintEdit' ).value ) { $( 'hintEdit' ).value = p; phraseRows(); } } );
}

// The password boxes show only while there is a phrase to seal.
function phraseRows()
{
    const phrase = readPhrase( 'hintEdit' );
    $( 'hintPwRows' ).hidden = ! phrase;
    drawPhraseWarn( 'hintEditWarn', $( 'hintMaster' ).value, phrase );
}

async function savePhrase()
{
    if( gateBusy || ! isOpen() ) return;
    const phrase = readPhrase( 'hintEdit' ), master = $( 'hintMaster' ).value, login = $( 'hintLogin' ).value;
    sayError( 'hintErr', '' );
    if( ! phrase )
    {
        if( env.hint ) try { await putHeader( async function() { return { hint: null }; } ); NayiveUI.toast( T( 'passwords.hintRemoved' ) ); } catch( e ) { return; }
        NayiveUI.close( 'hintBackdrop' );
        return;
    }
    if( ! master ) { $( 'hintMaster' ).focus(); return; }
    if( phraseCheck( master, phrase ).bad ) { sayError( 'hintErr', T( 'passwords.hintBad' ) ); return; }
    setBusy( T( 'passwords.opening' ), 'hintBusy' );
    try { ( await PwVault.openRaw( env, { password: master } ) ).fill( 0 ); }
    catch( e ) { setBusy( '', 'hintBusy' ); sayError( 'hintErr', T( e && e.message === 'wrong' ? 'passwords.wrongPw' : 'passwords.kdfFailed' ) ); return; }
    setBusy( '', 'hintBusy' );
    if( ! await loginOk( login, 'hintErr', 'hintBusy' ) ) return;
    setBusy( T( 'passwords.changing' ), 'hintBusy' );
    try
    {
        const k = keys;
        await putHeader( async function() { return { hint: await PwVault.sealHint( k, phrase, login ) }; } );
        NayiveUI.close( 'hintBackdrop' );
        NayiveUI.toast( T( 'passwords.hintSaved' ) );
    }
    catch( e ) { sayError( 'hintErr', T( 'passwords.saveFailed' ) ); }
    finally { setBusy( '', 'hintBusy' ); }
}

function phraseClosed() { [ 'hintEdit', 'hintMaster', 'hintLogin' ].forEach( function( id ) { $( id ).value = ''; } ); }

//------------------------------------------------------------------------//

// The checks, then the leak check. -> true when the password may be used;
// else the error is said under the boxes (errId).
async function masterOk( pw, pw2, errId, busyId )
{
    if( ! masterChecks( pw, pw2 ).every( function( c ) { return c.ok; } ) )
    {
        sayError( errId, T( pw !== pw2 && pw2 ? 'passwords.ruleSameErr' : 'passwords.ruleErr' ) );
        return false;
    }
    setBusy( T( 'passwords.checkingLeaks' ), busyId );
    const n = await leakCount( pw );
    setBusy( '', busyId );
    if( n > 0 ) { sayError( errId, TF( 'passwords.leaked', { n: n.toLocaleString( Ayni.i18n.lang() ) } ) ); return false; }
    return true;
}

//------------------------------------------------------------------------//
// SET-UP

async function createVault()
{
    if( gateBusy || fileState !== 'empty' ) return;
    const pw = $( 'setupPw' ).value, pw2 = $( 'setupPw2' ).value, phrase = readPhrase( 'setupHint' ), login = $( 'setupLogin' ).value;
    sayError( 'setupErr', '' );
    if( phraseCheck( pw, phrase ).bad ) { sayError( 'setupErr', T( 'passwords.hintBad' ) ); return; }
    if( ! await masterOk( pw, pw2, 'setupErr' ) ) return;
    if( phrase && ! await loginOk( login, 'setupErr' ) ) return;

    setBusy( T( 'passwords.creating' ) );
    let made;
    try
    {
        made = await PwVault.create( pw );
        if( phrase ) made.file.hint = await PwVault.sealHint( made.keys, phrase, login );
    }
    catch( e ) { setBusy( '' ); sayError( 'setupErr', T( 'passwords.kdfFailed' ) ); return; }
    setBusy( '' );
    if( fileState !== 'empty' ) return;               // another device made one meanwhile: that one shows

    $( 'setupPw' ).value = $( 'setupPw2' ).value = $( 'setupHint' ).value = $( 'setupLogin' ).value = '';
    $( 'setupHintWarn' ).hidden = $( 'setupLoginRow' ).hidden = true;
    env = made.file;
    fileState = 'ok';
    keys = made.keys;
    items = {};
    opened.clear();
    reindex();
    save();
    recoveryCode = made.recovery;
    gateStep = 'recovery';
    markActive();
    render();
}

function recoveryDone()
{
    gateStep = null;
    recoveryCode = '';
    $( 'recoveryCode' ).textContent = '';
    render();
}

function printRecovery( code )
{
    NayiveUI.printPage( '<h1>Nayive · ' + esc( T( 'passwords.recKey' ) ) + '</h1>' +
                        '<p style="font: 600 20px/1.6 monospace; letter-spacing: 1px">' + esc( code ) + '</p>' +
                        '<p>' + esc( T( 'passwords.recPrintNote' ) ) + '</p>' +
                        '<p class="pr-foot">' + esc( new Date().toLocaleDateString( Ayni.i18n.lang() ) ) + '</p>',
                        'Nayive recovery key', 'passwords.printHint' );
}

//------------------------------------------------------------------------//
// UNLOCK

async function unlockVault()
{
    if( gateBusy || fileState !== 'ok' || ! env ) return;
    if( Date.now() < waitUntil ) return;
    const input = $( 'unlockPw' );
    const pw = input.value;
    if( ! pw ) { input.focus(); return; }
    sayError( 'unlockErr', '' );
    setBusy( T( 'passwords.opening' ) );
    try
    {
        const k = await PwVault.unlock( env, { password: pw } );
        setBusy( '' );
        input.value = '';
        input.type = 'password';
        await enterVault( k );
    }
    catch( e )
    {
        setBusy( '' );
        if( e && e.message === 'wrong' )
        {
            failures++;
            input.select();
            sayError( 'unlockErr', T( 'passwords.wrongPw' ) );
            if( failures >= 5 ) waitAfterFailures();
        }
        else if( e && e.message === 'bad' ) render();
        else sayError( 'unlockErr', T( 'passwords.kdfFailed' ) );
    }
}

// After the 5th wrong try: 2 s, 4 s, 8 s… up to a minute before the next.
function waitAfterFailures()
{
    const secs = Math.min( 60, Math.pow( 2, failures - 4 ) );
    waitUntil = Date.now() + secs * 1000;
    const btn = $( 'unlockBtn' );
    btn.ariaDisabled = true;
    const tick = function()
    {
        const left = Math.ceil( ( waitUntil - Date.now() ) / 1000 );
        if( left > 0 ) { sayError( 'unlockErr', TF( 'passwords.waitN', { n: left } ) ); setTimeout( tick, 500 ); }
        else { btn.ariaDisabled = false; sayError( 'unlockErr', T( 'passwords.wrongPw' ) ); }
    };
    tick();
}

// The keys are in: open every entry and show the vault.
async function enterVault( k )
{
    keys = k;
    failures = 0;
    hintPlain = '';
    opened.clear();
    markActive();
    await openAll();
    render();
}

//------------------------------------------------------------------------//
// THE RECOVERY KEY  -  opens the vault, then a new master password is set.

function openRecoverySheet()
{
    if( fileState !== 'ok' ) return;
    $( 'recInput' ).value = '';
    sayError( 'recErr', '' );
    NayiveUI.open( 'recBackdrop' );
    setTimeout( function() { $( 'recInput' ).focus(); }, 0 );
}

async function useRecovery()
{
    if( gateBusy || fileState !== 'ok' || ! env ) return;
    const code = $( 'recInput' ).value;
    if( ! PwVault.recBytes( code ) ) { sayError( 'recErr', T( 'passwords.recBadShape' ) ); return; }
    sayError( 'recErr', '' );
    setBusy( T( 'passwords.opening' ), 'recBusy' );
    let raw;
    try { raw = await PwVault.openRaw( env, { recovery: code } ); }
    catch( e ) { setBusy( '', 'recBusy' ); sayError( 'recErr', T( 'passwords.recWrong' ) ); return; }
    setBusy( '', 'recBusy' );
    $( 'recInput' ).value = '';
    NayiveUI.close( 'recBackdrop' );
    try { await enterVault( await PwVault.keysFor( raw, env.vault ) ); }
    catch( e ) { raw.fill( 0 ); return; }
    rawAfterRec = raw;
    openChangePw( true );
}

//------------------------------------------------------------------------//
// A NEW MASTER PASSWORD  -  from Settings (the current one is asked), or
// right after the recovery key (`afterRec`: it is not).

let chpwAfterRec = false;
let chpwSaved    = false;   // the sheet's new master password was saved (vs closed without)

function openChangePw( afterRec )
{
    if( ! isOpen() ) return;
    chpwAfterRec = !! afterRec;
    chpwSaved    = false;
    $( 'chpwTitle' ).textContent = T( afterRec ? 'passwords.newPwTitle' : 'passwords.changePw' );
    $( 'chpwLead' ).textContent  = T( afterRec ? 'passwords.newPwLead' : 'passwords.changePwLead' );
    $( 'chpwCurRow' ).hidden = !! afterRec;
    [ 'chpwCur', 'chpwNew', 'chpwNew2' ].forEach( function( id ) { $( id ).value = ''; } );
    hideSecrets( $( 'chpwBackdrop' ) );
    // The reminder phrase may not hold every word of the NEW password.
    chpwPhrase = '';
    $( 'chpwHintWarn' ).hidden = true;
    PwVault.readHint( keys, env ).then( function( p ) { chpwPhrase = p; drawPhraseWarn( 'chpwHintWarn', $( 'chpwNew' ).value, p ); } );
    drawChecks( 'chpwChecks', '', '' );
    sayError( 'chpwErr', '' );
    NayiveUI.open( 'chpwBackdrop' );
    setTimeout( function() { $( afterRec ? 'chpwNew' : 'chpwCur' ).focus(); }, 0 );
}

// The sheet closed, saved or not: the vault key from the recovery goes.
function chpwClosed()
{
    [ 'chpwCur', 'chpwNew', 'chpwNew2' ].forEach( function( id ) { $( id ).value = ''; } );
    chpwPhrase = '';
    if( ! rawAfterRec ) return;
    const raw = rawAfterRec;
    const forget = function() { if( rawAfterRec === raw ) { raw.fill( 0 ); rawAfterRec = null; } };
    if( chpwSaved || ! isOpen() ) { forget(); return; }
    // Closed after the recovery key with no new master password: the old one
    // still opens the vault - and whoever came in by the recovery key has
    // most likely forgotten it. Say so, and offer the sheet again.
    NayiveUI.confirm( { title: T( 'passwords.pwKeptTitle' ), body: T( 'passwords.pwKeptBody' ),
                        confirm: T( 'passwords.pwKeptNew' ), cancel: T( 'passwords.pwKeptOld' ) } ).then( function( again )
    {
        if( again && isOpen() && rawAfterRec === raw ) openChangePw( true );
        else forget();
    } );
}

async function saveChangePw()
{
    if( gateBusy || ! isOpen() ) return;
    const cur = $( 'chpwCur' ).value, pw = $( 'chpwNew' ).value, pw2 = $( 'chpwNew2' ).value;
    sayError( 'chpwErr', '' );
    if( ! chpwAfterRec && ! cur ) { $( 'chpwCur' ).focus(); return; }
    if( ! chpwAfterRec && cur === pw ) { sayError( 'chpwErr', T( 'passwords.samePwErr' ) ); return; }
    if( phraseCheck( pw, chpwPhrase ).bad ) { sayError( 'chpwErr', T( 'passwords.hintNewPwBad' ) ); return; }
    if( ! await masterOk( pw, pw2, 'chpwErr', 'chpwBusy' ) ) return;

    setBusy( T( 'passwords.changing' ), 'chpwBusy' );
    let raw = rawAfterRec;
    try
    {
        if( ! raw )
        {
            try { raw = await PwVault.openRaw( env, { password: cur } ); }
            catch( e ) { setBusy( '', 'chpwBusy' ); sayError( 'chpwErr', T( e && e.message === 'wrong' ? 'passwords.wrongPw' : 'passwords.kdfFailed' ) ); return; }
        }
        const vault = env.vault, mine = raw;
        await putHeader( function() { return PwVault.wrapPassword( mine, vault, pw ); } );
        if( raw !== rawAfterRec ) raw.fill( 0 );
        setBusy( '', 'chpwBusy' );
        chpwSaved = true;
        NayiveUI.close( 'chpwBackdrop' );
        NayiveUI.toast( T( 'passwords.pwChanged' ), { ms: 7000 } );
    }
    catch( e )
    {
        setBusy( '', 'chpwBusy' );
        if( raw && raw !== rawAfterRec ) raw.fill( 0 );
        sayError( 'chpwErr', T( 'passwords.saveFailed' ) );
    }
}

//------------------------------------------------------------------------//
// A NEW RECOVERY KEY  -  the master password first; the old key stops
// working once the new one is saved.

async function newRecoveryKey()
{
    if( ! isOpen() ) return;
    const pw = await NayiveUI.askPassword( { title: T( 'passwords.newRecovery' ), body: T( 'passwords.newRecoveryAsk' ),
                                             confirm: T( 'passwords.continue' ) } );
    if( pw === null || ! isOpen() ) return;
    let raw;
    try { raw = await PwVault.openRaw( env, { password: pw } ); }
    catch( e ) { NayiveUI.toast( T( e && e.message === 'wrong' ? 'passwords.wrongPw' : 'passwords.kdfFailed' ) ); return; }
    let code = '';
    try
    {
        const vault = env.vault;
        await putHeader( async function()
        {
            const w = await PwVault.wrapRecovery( raw, vault );
            code = w.code;
            return { rec: w.rec };
        } );
    }
    catch( e ) { return; }
    finally { raw.fill( 0 ); }
    NayiveUI.close( 'settingsBackdrop' );
    recShown = code;
    showCode( $( 'recShowCode' ), code );
    NayiveUI.open( 'recShowBackdrop' );
}

// The master password again, for something that shows every secret (the
// plain export). -> true when it is right.
async function confirmMaster( title, body )
{
    const pw = await NayiveUI.askPassword( { title: title, body: body, confirm: T( 'passwords.continue' ) } );
    if( pw === null || ! isOpen() ) return false;
    try
    {
        const raw = await PwVault.openRaw( env, { password: pw } );
        raw.fill( 0 );
        return true;
    }
    catch( e ) { NayiveUI.toast( T( e && e.message === 'wrong' ? 'passwords.wrongPw' : 'passwords.kdfFailed' ) ); return false; }
}

//------------------------------------------------------------------------//
// LOCK

function lock()
{
    keys = null;
    items = {};
    parentOf = {};
    opened.clear();
    damaged = 0;
    gateStep = null;
    recoveryCode = '';
    recShown = '';
    hintPlain = '';
    chpwPhrase = '';
    if( rawAfterRec ) { rawAfterRec.fill( 0 ); rawAfterRec = null; }
    editId = null;
    // Every open sheet shows (or holds) something of the vault.
    document.querySelectorAll( '.sheet-backdrop.open' ).forEach( function( b ) { if( b.id ) NayiveUI.close( b.id ); } );
    [ 'itName', 'itUser', 'itPass', 'itUrls', 'itNotes', 'itTotp', 'genOut', 'recShowCode', 'chpwCur', 'chpwNew', 'chpwNew2',
      'hintEdit', 'hintMaster', 'hintLogin', 'hintText' ].forEach( function( id )
    {
        const el = $( id );
        if( el ) { if( el.tagName === 'P' ) el.textContent = ''; else el.value = ''; }
    } );
    // Nor anything the hidden vault screen still holds: names in the lists,
    // the sheet's heading, the folder pickers, the tree and the crumbs.
    [ 'itFields', 'itHistoryList', 'items', 'tree', 'crumbs', 'itFolder', 'folderParent', 'itemTitle', 'printRoot' ].forEach( function( id )
    {
        $( id ).innerHTML = '';
    } );
    $( 'folderName' ).value = '';
    document.querySelectorAll( '#filterRow .pill' ).forEach( function( p ) { p.textContent = ''; } );
    if( query ) { query = ''; $( 'searchInput' ).value = ''; if( searchFold ) searchFold.close(); }
    if( clipTimer ) wipeClipboard();
    render();
}

function markActive() { lastActive = Date.now(); }

function wireAutoLock()
{
    [ 'pointerdown', 'keydown', 'wheel', 'touchstart' ].forEach( function( ev )
    {
        document.addEventListener( ev, markActive, { capture: true, passive: true } );
    } );
    const check = function()
    {
        if( ! isOpen() ) return;
        if( screenLocked() || Date.now() - lastActive > ui.lockMin * 60000 ) lock();
    };
    setInterval( check, 10000 );
    document.addEventListener( 'visibilitychange', check );
    window.addEventListener( 'storage', function( e ) { if( e.key === 'nayive-lock' && e.newValue === '1' && isOpen() ) lock(); } );
}
