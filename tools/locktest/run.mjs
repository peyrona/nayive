/*
 * run.mjs - the locked-document tests (shared/crypt.js + office.js's padlock).
 *
 *     node tools/locktest/run.mjs          # from the repo root
 *
 * It serves client/apps over 127.0.0.1, drops page.html in as _locktest.html
 * (a real app origin is the only place shared/ resolves and crypto.subtle
 * exists), drives a headless Chromium, and takes the page away again.
 *
 * The page stubs GumApi and NayiveStore with an in-memory server and papelera;
 * everything else is the REAL shared module. So the assertions are about the
 * bytes that would have left the browser: what lands in the "server", in the
 * .bak beside it, in the papelera and in the device draft.
 */
import { browser, attach } from "../cdp.mjs";
import { serve } from "./serve.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname( fileURLToPath( import.meta.url ) );
const APPS = path.resolve( HERE, "..", "..", "client", "apps" );
const PAGE = path.join( APPS, "_locktest.html" );

let pass = 0, fail = 0;
const ok = ( name, cond, extra ) =>
{
    if( cond ) { pass++; console.log( "  PASS " + name ); }
    else       { fail++; console.log( "  FAIL " + name + ( extra !== undefined ? " -> " + JSON.stringify( extra ) : "" ) ); }
};

fs.copyFileSync( path.join( HERE, "page.html" ), PAGE );

const site = await serve( APPS );
const b    = await browser();
let   p;

try
{
    const tab = await b.newTab( `http://127.0.0.1:${site.port}/_locktest.html` );
    p = await attach( tab.webSocketDebuggerUrl );

    // The first execution context is thrown away by the navigation.
    await new Promise( r => setTimeout( r, 2000 ) );
    for( let i = 0; i < 200; i++ )
    {
        let up = false;
        try { up = await p.evaluate( "!!(window.NayiveOffice && window.NayiveCrypt && window.HARNESS)" ); } catch {}
        if( up ) break;
        await new Promise( r => setTimeout( r, 50 ) );
    }
    await p.evaluate( "NayiveI18n.ready" );

    // Two helpers the tests drive the REAL sheets with.
    await p.evaluate( `window.pressTitled = async function ( title ) {
      for( var i = 0; i < 80; i++ ) {
        var s = document.querySelector( '.sheet-backdrop.open .sheet' );
        var b = s && Array.prototype.find.call( s.querySelectorAll( '.sheet-actions button' ),
                  function ( x ) { return ( x.title || '' ) === title; } );
        if( b ) { b.click(); return true; }
        await new Promise( function ( r ) { setTimeout( r, 25 ); } );
      }
      return false;
    };
    window.sheetText = function () { var s = document.querySelector('.sheet-backdrop.open .sheet'); return s ? s.textContent : null; };
    window.T = function ( k ) { return NayiveUI.t( k ); };` );

    console.log('\n--- crypto in the page ---');
    ok('subtle available', await p.evaluate('NayiveCrypt.available()'));

    //--------------------------------------------------------------------------
    console.log('\n--- Write/Calc: lock, save, reopen ---');
    const r1 = await p.evaluate(`(async()=>{
      await dropDrafts();
      SRV = {}; CALLS = [];
      const s = newSession('write', true);
      DOC = { body: new TextEncoder().encode('PK\\x03\\x04 el secreto del informe') };
      await s.untitled('informe.docx', { dirty: true });

      // save it plain first, so there is a server copy AND a plaintext .bak later
      s.__path = null;
      document.getElementById('saveName').value = 'informe.docx';
      document.getElementById('saveAsConfirmBtn').click();
      await new Promise(r=>setTimeout(r,200));

      const plainOnServer = new TextDecoder().decode(SRV['files/informe.docx']);

      // now put a password on it
      document.getElementById('lockBtn').click();
      await pressTitled( T('lock.lockAnyway') );          // it warns first now: seal it in place
      await typePassword('contrasena-larga');
      await untilSealed('files/informe.docx');

      return {
        plainOnServer,
        locked:      s.locked(),
        btnActive:   document.getElementById('lockBtn').classList.contains('is-active'),
        serverHead:  new TextDecoder().decode(SRV['files/informe.docx'].slice(0,16)),
        serverPlain: new TextDecoder('utf-8',{fatal:false}).decode(SRV['files/informe.docx']).includes('secreto'),
        bakHead:     SRV['files/.bak/informe.docx'] ? new TextDecoder().decode(SRV['files/.bak/informe.docx'].slice(0,16)) : null,
        bakPlain:    SRV['files/.bak/informe.docx'] ? new TextDecoder('utf-8',{fatal:false}).decode(SRV['files/.bak/informe.docx']).includes('secreto') : null,
        paths: Object.keys(SRV)
      };
    })()`);
    ok('saved plain before the lock', r1.plainOnServer.includes('secreto'), r1.plainOnServer);
    ok('session reports locked', r1.locked);
    ok('padlock lit', r1.btnActive);
    ok('server copy is sealed', r1.serverHead === 'NAYIVE-LOCK-BIN\n', r1.serverHead);
    ok('server copy has no plaintext', r1.serverPlain === false);
    ok('.bak is sealed too', r1.bakHead === 'NAYIVE-LOCK-BIN\n', r1.bakHead);
    ok('.bak has no plaintext', r1.bakPlain === false, r1.paths);

    //--------------------------------------------------------------------------
    console.log('\n--- reopening asks, and a wrong password is refused ---');
    const r2 = await p.evaluate(`(async()=>{
      const s = newSession('write', true);
      DOC = { body: null };
      const opening = s.open('files/informe.docx');
      await typePassword('EQUIVOCADA');           // first try: wrong
      await new Promise(r=>setTimeout(r,400));
      const asksAgain = !!document.getElementById('askPw1');
      await typePassword('contrasena-larga');     // second try: right
      const opened = await opening;
      return { asksAgain, opened, text: DOC.body ? new TextDecoder().decode(DOC.body) : null, locked: s.locked() };
    })()`);
    ok('a wrong password asks again', r2.asksAgain);
    ok('the right one opens it', r2.opened === true);
    ok('the content is back, exactly', r2.text === 'PK\x03\x04 el secreto del informe', r2.text);
    ok('still locked after opening', r2.locked);

    //--------------------------------------------------------------------------
    console.log('\n--- cancelling the password does NOT open the document ---');
    const r3 = await p.evaluate(`(async()=>{
      const s = newSession('write', true);
      DOC = { body: 'untouched' };
      const opening = s.open('files/informe.docx');
      await cancelSheet();
      const opened = await opening;
      return { opened, doc: DOC.body, path: s.path() };
    })()`);
    ok('open() refuses', r3.opened === false);
    ok('the editor was not touched', r3.doc === 'untouched', r3.doc);
    ok('no document is open', r3.path === null);

    //--------------------------------------------------------------------------
    console.log('\n--- Text: the body stays TEXT (its store keeps text) ---');
    const r4 = await p.evaluate(`(async()=>{
      await dropDrafts();
      SRV = {};
      const s = newSession('text', false);
      DOC = { body: 'hola\\nsegunda línea con ñ y €' };
      await s.untitled('nota.txt', { dirty: true });
      document.getElementById('saveName').value = 'nota.txt';
      document.getElementById('saveAsConfirmBtn').click();
      await new Promise(r=>setTimeout(r,200));

      document.getElementById('lockBtn').click();
      await pressTitled( T('lock.lockAnyway') );          // it warns first now: seal it in place
      await typePassword('otra-contrasena');
      await untilSealed('files/nota.txt');

      const stored = SRV['files/nota.txt'];

      const s2 = newSession('text', false);
      DOC = { body: null };
      const opening = s2.open('files/nota.txt');
      await typePassword('otra-contrasena');
      const opened = await opening;

      return {
        storedIsString: typeof stored === 'string',
        head: typeof stored === 'string' ? stored.slice(0,16) : null,
        hasPlain: typeof stored === 'string' && stored.includes('segunda'),
        opened, back: DOC.body, backIsString: typeof DOC.body === 'string'
      };
    })()`);
    ok('a locked text file is still text', r4.storedIsString);
    ok('armoured with the B64 magic', r4.head === 'NAYIVE-LOCK-B64\n', r4.head);
    ok('no plaintext in it', r4.hasPlain === false);
    ok('it reopens', r4.opened === true);
    ok('and comes back AS A STRING', r4.backIsString);
    ok('with every character intact', r4.back === 'hola\nsegunda línea con ñ y €', r4.back);

    //--------------------------------------------------------------------------
    console.log('\n--- taking the password off ---');
    const r5 = await p.evaluate(`(async()=>{
      await dropDrafts();
      SRV = {};
      const s = newSession('write', true);
      DOC = { body: new TextEncoder().encode('el secreto') };
      await s.untitled('a.docx', { dirty: true });
      document.getElementById('saveName').value = 'a.docx';
      document.getElementById('saveAsConfirmBtn').click();
      await new Promise(r=>setTimeout(r,200));

      document.getElementById('lockBtn').click();
      await pressTitled( T('lock.lockAnyway') );          // it warns first now: seal it in place
      await typePassword('una-contrasena');
      await untilSealed('files/a.docx');
      await until(()=> !!SRV['files/.bak/a.docx']);
      const sealedBak = new TextDecoder().decode(SRV['files/.bak/a.docx'].slice(0,16));

      document.getElementById('lockBtn').click();          // take it off
      await clickConfirm('primary');
      await until(()=> new TextDecoder().decode(SRV['files/a.docx']) === 'el secreto');

      return {
        sealedBak,
        locked:   s.locked(),
        btn:      document.getElementById('lockBtn').classList.contains('is-active'),
        server:   new TextDecoder().decode(SRV['files/a.docx']),
        bakPlain: new TextDecoder().decode(SRV['files/.bak/a.docx'])
      };
    })()`);
    ok('the .bak was sealed while locked', r5.sealedBak === 'NAYIVE-LOCK-BIN\n', r5.sealedBak);
    ok('unlocked', r5.locked === false);
    ok('padlock off', r5.btn === false);
    ok('the server copy is plain again', r5.server === 'el secreto', r5.server);
    ok('the .bak was put back in the clear', r5.bakPlain === 'el secreto', r5.bakPlain.slice(0, 30));

    //--------------------------------------------------------------------------
    console.log('\n--- the device draft ---');
    const r6 = await p.evaluate(`(async()=>{
      await dropDrafts();
      SRV = {};
      const s = newSession('calc', true);
      DOC = { body: new TextEncoder().encode('celdas secretas') };
      await s.untitled('hoja.xlsx', { dirty: true });
      document.getElementById('lockBtn').click();         // nothing written yet: no warning
      await typePassword('clave-del-borrador');
      await until(()=> s.locked());
      await new Promise(r=>setTimeout(r,800));            // let the sealed draft reach IndexedDB

      const raw = await new Promise(r=>{ const q=indexedDB.open('nayive-drafts',1);
          q.onsuccess=()=>{ const tx=q.result.transaction('drafts','readonly');
          const g=tx.objectStore('drafts').getAll(); g.onsuccess=()=>r(g.result.find(x=>String(x.app).indexOf('calc:')===0)); }; });

      return {
        kept:     !!raw,
        head:     raw ? new TextDecoder().decode(raw.body.slice(0,16)) : null,
        hasPlain: raw ? new TextDecoder('utf-8',{fatal:false}).decode(raw.body).includes('secretas') : null,
        onServer: Object.keys(SRV)
      };
    })()`);
    ok('the draft was kept', r6.kept);
    ok('and it is sealed', r6.head === 'NAYIVE-LOCK-BIN\n', r6.head);
    ok('no plaintext in IndexedDB', r6.hasPlain === false);
    ok('nothing went to the server', r6.onServer.length === 0, r6.onServer);

    const r7 = await p.evaluate(`(async()=>{
      const s = newSession('calc', true);        // a fresh visit: the draft is asked for
      DOC = { body: null };
      const booting = s.boot();
      await typePassword('clave-del-borrador');
      await booting;
      return { text: DOC.body ? new TextDecoder().decode(DOC.body) : null, how: DOC.how, locked: s.locked() };
    })()`);
    ok('the draft comes back', r7.text === 'celdas secretas', r7.text);
    ok('as a draft', r7.how === 'draft', r7.how);
    ok('still locked', r7.locked);

    console.log('\n--- a cancelled draft password must not silently vanish ---');
    const r8 = await p.evaluate(`(async()=>{
      const s = newSession('calc', true);
      DOC = { body: null };
      const booting = s.boot();
      await cancelSheet();                       // give up on the password
      await new Promise(r=>setTimeout(r,200));
      const asked = !!document.querySelector('.sheet-backdrop.open');   // "throw it away?"
      await clickConfirm('cancel');              // no: try again
      await new Promise(r=>setTimeout(r,200));
      const backToPassword = !!document.getElementById('askPw1');
      await typePassword('clave-del-borrador');
      await booting;
      return { asked, backToPassword, text: DOC.body ? new TextDecoder().decode(DOC.body) : null };
    })()`);
    ok('cancelling asks what to do', r8.asked);
    ok('"try again" asks for the password again', r8.backToPassword);
    ok('and it still opens', r8.text === 'celdas secretas', r8.text);

    console.log('\n--- importing a locked file ---');
    const r9 = await p.evaluate(`(async()=>{
      await dropDrafts();
      SRV = {};
      const lock = await NayiveCrypt.newLock('importada');
      SRV['files/otro.docx'] = await NayiveCrypt.seal(lock, new TextEncoder().encode('viene de fuera'));
      const s = newSession('write', true);
      DOC = { body: null };
      const imp = s.boot.call(null);            // not used; import directly
      return { ready: true };
    })()`);

    const r10 = await p.evaluate(`(async()=>{
      const s = newSession('write', true);
      DOC = { body: null };
      history.replaceState(null,'','?import=files/otro.docx');
      const booting = s.boot();
      await typePassword('importada');
      await booting;
      history.replaceState(null,'','/_locktest.html');
      return { text: DOC.body ? new TextDecoder().decode(DOC.body) : null, how: DOC.how, locked: s.locked(), path: s.path() };
    })()`);
    ok('an imported locked file opens', r10.text === 'viene de fuera', r10.text);
    ok('as an import', r10.how === 'import', r10.how);
    ok('and it stays locked', r10.locked);
    ok('untitled, so its first save asks where', r10.path === null);

    console.log('\n--- a brand-new document is NOT warned (nothing written yet) ---');
    const w1 = await p.evaluate(`(async()=>{
      await dropDrafts(); SRV = {}; BIN = [];
      window.s = newSession('write', true);
      DOC = { body: new TextEncoder().encode('recien empezado') };
      s.untitled( null, {} );
      document.getElementById('lockBtn').click();
      await new Promise(r=>setTimeout(r,400));
      return { pwStraightAway: !!document.getElementById('askPw1'), sheet: sheetText() };
    })()`);
    ok('the password sheet opens straight away', w1.pwStraightAway, w1.sheet);
    await p.evaluate(`typePassword('sin-pasado-123')`);

    console.log('\n--- a document already on the server IS warned, and offers a clean copy ---');
    const w2 = await p.evaluate(`(async()=>{
      await dropDrafts(); SRV = {}; BIN = [];
      window.s = newSession('write', true);
      DOC = { body: new TextEncoder().encode('quince minutos de texto claro') };
      s.untitled('carta.docx', { dirty: true });
      document.getElementById('saveName').value = 'carta.docx';
      document.getElementById('saveAsConfirmBtn').click();
      await new Promise(r=>setTimeout(r,300));
      SRV['files/.bak/carta.docx'] = new TextEncoder().encode('quince minutos de texto claro');  // a plain .bak from before

      document.getElementById('lockBtn').click();
      await new Promise(r=>setTimeout(r,400));
      return { warned: !!document.querySelector('.sheet-backdrop.open'),
               text: sheetText(), plainUp: new TextDecoder().decode(SRV['files/carta.docx']) };
    })()`);
    ok('the plain original is on the server', w2.plainUp.includes('quince minutos'));
    ok('pressing the padlock warns first', w2.warned);
    ok('the warning names the file', (w2.text || '').includes('carta.docx'), w2.text);
    ok('it says a password does not erase the past', /NO|not/.test(w2.text || ''));
    ok('it offers the three answers', ['lock.cleanCopy','lock.lockAnyway','ui.cancel'].length === 3);

    const wLabels = await p.evaluate(`(()=>{ var s=document.querySelector('.sheet-backdrop.open .sheet');
      return Array.prototype.map.call(s.querySelectorAll('.sheet-actions button'), b=>b.title); })()`);
    ok('cancel / just protect / clean copy', wLabels.length === 3, wLabels);

    console.log('\n--- "Clean copy" -> new name, old file wiped out of the Bin too ---');
    const w3 = await p.evaluate(`(async()=>{
      await pressTitled( T('lock.cleanCopy') );
      await typePassword('clave-de-verdad');
      const askedName = await until(()=> document.getElementById('saveAsBackdrop').classList.contains('open'));

      document.getElementById('saveName').value = 'carta-protegida.docx';
      document.getElementById('saveAsConfirmBtn').click();
      await untilSealed('files/carta-protegida.docx');
      await until(()=> !( 'files/carta.docx' in SRV ) && BIN.length === 0);

      return {
        askedName,
        path:     s.path(),
        locked:   s.locked(),
        newHead:  SRV['files/carta-protegida.docx'] ? new TextDecoder().decode(SRV['files/carta-protegida.docx'].slice(0,16)) : null,
        newPlain: SRV['files/carta-protegida.docx'] ? new TextDecoder('utf-8',{fatal:false}).decode(SRV['files/carta-protegida.docx']).includes('quince') : null,
        oldGone:  !( 'files/carta.docx' in SRV ),
        bakGone:  !( 'files/.bak/carta.docx' in SRV ),
        bin:      BIN.map(x=>x.orig),
        forgot:   CALLS.filter(c=>c[0]==='forget').map(c=>c[1]),
        left:     Object.keys(SRV)
      };
    })()`);
    ok('it asks for a new name', w3.askedName);
    ok('the protected copy is there, sealed', w3.newHead === 'NAYIVE-LOCK-BIN\n', w3.newHead);
    ok('with no plaintext in it', w3.newPlain === false);
    ok('the old file is gone from Drive', w3.oldGone, w3.left);
    ok('its plain .bak is gone too', w3.bakGone, w3.left);
    ok('and BOTH are out of the Bin', w3.bin.length === 0, w3.bin);
    ok('the device cache entry was dropped', w3.forgot.includes('files/carta.docx'), w3.forgot);
    ok('the session now points at the new file', w3.path === 'files/carta-protegida.docx', w3.path);

    console.log('\n--- "Just protect it" leaves the old name alone ---');
    const w4 = await p.evaluate(`(async()=>{
      await dropDrafts(); SRV = {}; BIN = []; CALLS = [];
      window.s = newSession('write', true);
      DOC = { body: new TextEncoder().encode('otro texto') };
      s.untitled('nota.docx', { dirty: true });
      document.getElementById('saveName').value = 'nota.docx';
      document.getElementById('saveAsConfirmBtn').click();
      await new Promise(r=>setTimeout(r,300));

      document.getElementById('lockBtn').click();
      await pressTitled( T('lock.lockAnyway') );
      await typePassword('otra-clave-mas');
      await untilSealed('files/nota.docx');

      return { path: s.path(), locked: s.locked(),
               head: new TextDecoder().decode(SRV['files/nota.docx'].slice(0,16)),
               bin: BIN.map(x=>x.orig), keys: Object.keys(SRV) };
    })()`);
    ok('it stays under the same name', w4.path === 'files/nota.docx', w4.path);
    ok('sealed in place', w4.head === 'NAYIVE-LOCK-BIN\n', w4.head);
    ok('nothing was deleted', w4.bin.length === 0, w4.bin);

    console.log('\n--- cancelling the warning does nothing at all ---');
    const st = async (l, e, ms = 9000) => { try { return await p.evaluate(e, ms); } catch (x) { console.log('    [' + l + '] ' + x.message.split('\n')[0]); throw x; } };
    await st('drafts', `dropDrafts().then(()=>'ok')`);
    await st('setup', `(()=>{ SRV={}; BIN=[]; window.s=newSession('write',true);
      DOC={body:new TextEncoder().encode('intacto')}; s.untitled('x.docx',{dirty:true}); return 'ok'; })()`);
    await st('saveas', `(async()=>{ document.getElementById('saveName').value='x.docx';
      document.getElementById('saveAsConfirmBtn').click(); await new Promise(r=>setTimeout(r,400)); return s.path(); })()`);
    await st('lock', `(()=>{ document.getElementById('lockBtn').click(); return 'ok'; })()`);
    await st('cancel', `pressTitled( T('ui.cancel') )`);
    const w5 = await st('read', `(async()=>{ await new Promise(r=>setTimeout(r,400));
      return { locked: s.locked(), pw: !!document.getElementById('askPw1'),
               body: SRV['files/x.docx'] ? new TextDecoder().decode(SRV['files/x.docx']) : null, bin: BIN.length }; })()`);
    ok('no password is asked', w5.pw === false);
    ok('not locked', w5.locked === false);
    ok('the file is untouched', w5.body === 'intacto', w5.body);
    ok('nothing deleted', w5.bin === 0);

    console.log('\n--- a cancelled clean copy must not wipe on the NEXT save-as ---');
    const w6 = await p.evaluate(`(async()=>{
      await dropDrafts(); SRV = {}; BIN = [];
      window.s = newSession('write', true);
      DOC = { body: new TextEncoder().encode('mio') };
      s.untitled('y.docx', { dirty: true });
      document.getElementById('saveName').value = 'y.docx';
      document.getElementById('saveAsConfirmBtn').click();
      await new Promise(r=>setTimeout(r,300));

      document.getElementById('lockBtn').click();
      await pressTitled( T('lock.cleanCopy') );
      await typePassword('clave-abandonada');
      await until(()=> document.getElementById('saveAsBackdrop').classList.contains('open'));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));   // back out of the name sheet
      await new Promise(r=>setTimeout(r,300));

      document.getElementById('saveAsBtn').click();          // a plain save-as later on
      await new Promise(r=>setTimeout(r,200));
      document.getElementById('saveName').value = 'z.docx';
      document.getElementById('saveAsConfirmBtn').click();
      await new Promise(r=>setTimeout(r,800));

      return { yStillThere: 'files/y.docx' in SRV, z: 'files/z.docx' in SRV, bin: BIN.map(x=>x.orig) };
    })()`);
    ok('the original survives an abandoned clean copy', w6.yStillThere, w6);
    ok('the later save-as still works', w6.z);
    ok('and it wiped nothing', w6.bin.length === 0, w6.bin);

    console.log('\n--- an untitled document with a draft gets the shorter warning ---');
    const w7 = await p.evaluate(`(async()=>{
      await dropDrafts(); SRV = {}; BIN = [];
      window.s = newSession('calc', true);
      DOC = { body: new TextEncoder().encode('borrador en claro') };
      s.untitled(null, {});
      s.edited();
      await new Promise(r=>setTimeout(r,8200));           // let the 7 s autosave keep a PLAIN draft
      document.getElementById('lockBtn').click();
      await new Promise(r=>setTimeout(r,400));
      const txt = sheetText();
      const btns = Array.prototype.map.call(document.querySelectorAll('.sheet-backdrop.open .sheet-actions button'), b=>b.title);
      return { txt, btns };
    })()`);
    ok('the draft case warns too', (w7.txt || '').length > 0, w7.txt);
    ok('with two answers, no clean copy', w7.btns.length === 2, w7.btns);

    console.log( "\n--- page errors ---" );
    const bad = p.logs.filter( l => /EXCEPTION|Uncaught/.test( l ) );
    ok( "no uncaught exceptions", bad.length === 0, bad.slice( 0, 5 ) );
}
finally
{
    b.kill();
    site.close();
    try { fs.unlinkSync( PAGE ); } catch {}     // never leave a test page in client/apps
}

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
