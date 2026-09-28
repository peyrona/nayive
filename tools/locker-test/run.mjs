/*
 * locker-test - the screen locker (shared/locker.js) in a real browser.
 * Needs a server with /api/unlock and the test/test account, e.g. a scratch
 * run-root on 4471 (see the verify-harness notes):   node tools/locker-test/run.mjs [base]
 */
import { browser, attach } from "../locktest/cdp.mjs";
import os from "node:os";
import fs from "node:fs";
const B = process.argv[ 2 ] || "http://127.0.0.1:4471/nayive/";
const OUT = os.tmpdir() + "/locker-test-";
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
let fails = 0;
const ok = ( c, m ) => { console.log( ( c ? "ok   " : "FAIL " ) + m ); if( ! c ) fails++; };

const br = await browser( [ "--window-size=1280,800" ] );
async function tab( url )
{
    const t = await br.newTab( "about:blank" );
    const p = await attach( t.webSocketDebuggerUrl );
    await p.send( "Network.enable" );
    await p.send( "Network.setBypassServiceWorker", { bypass: true } );
    await p.send( "Emulation.setFocusEmulationEnabled", { enabled: true } );
    await p.send( "Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false } );
    p.go = async u =>
    {
        const want = new URL( B + u ).pathname;
        await p.send( "Page.navigate", { url: B + u } );
        for( let i = 0; i < 100; i++ )
        {
            await sleep( 150 );
            try { if( await p.evaluate( "location.pathname+'|'+document.readyState" ) === want + "|complete" ) break; } catch {}
        }
        await sleep( 1200 );
    };
    p.shot = async n => fs.writeFileSync( OUT + n + ".png", Buffer.from( ( await p.send( "Page.captureScreenshot" ) ).result.data, "base64" ) );
    p.key = async k => { await p.send( "Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt( 0 ) } ); await p.send( "Input.dispatchKeyEvent", { type: "keyUp", key: k } ); };
    if( url ) await p.go( url );
    return p;
}

try
{
    const a = await tab( "login.html" );
    await a.evaluate( `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    await a.evaluate( `localStorage.setItem('balata-coach-seen','1');localStorage.setItem('nayive-install-snooze','never');localStorage.setItem('balata-intro-dismiss:launcher','1');localStorage.setItem('balata-lang','en');localStorage.removeItem('nayive-locker');localStorage.removeItem('nayive-lock');1` );
    await a.go( "index.html" );
    ok( await a.evaluate( "typeof NayiveLock" ) === "object", "NayiveLock loaded in launcher" );

    // --- My account row
    await a.evaluate( "openAccountDialog(); 1" );
    await sleep( 600 );
    const row = JSON.parse( await a.evaluate( `JSON.stringify((()=>{var s=document.getElementById('lockSel'),m=document.getElementById('lockMin');var a=s.getBoundingClientRect(),b=m.getBoundingClientRect();return {opts:[...s.options].map(o=>o.value+'='+o.textContent),v:s.value,min:m.value,dis:m.disabled,sameRow:Math.abs((a.top+a.height/2)-(b.top+b.height/2))<4,vis:a.width>0&&b.width>0,textHidden:document.getElementById('lockTextWrap').hidden}})())` ) );
    console.log( row );
    ok( row.opts.length === 5 && row.v === "" && row.min === "15" && row.sameRow && row.vis && row.textHidden, "row: none default, 15 min, same row" );
    await a.evaluate( `(()=>{var s=document.getElementById('lockSel');s.value='clock';s.dispatchEvent(new Event('change'));var m=document.getElementById('lockMin');m.value='0';m.dispatchEvent(new Event('change'));var t=document.getElementById('lockText');t.value='Back soon';t.dispatchEvent(new Event('input'));return 1})()` );
    const st = await a.evaluate( "localStorage.getItem('nayive-locker')+'|'+document.getElementById('lockMin').value+'|'+document.getElementById('lockTextWrap').hidden" );
    ok( st === '{"id":"clock","min":1,"text":"Back soon"}|1|false', "saved clock, min clamped to 1, text row shown: " + st );
    await a.shot( "account" );
    await a.evaluate( "NayiveUI.close('pwBackdrop');1" );

    // --- idle lock: pretend the last activity was 61 s ago
    await a.evaluate( "localStorage.setItem('nayive-lock-seen', String(Date.now()-61000));1" );
    await sleep( 5600 );
    ok( await a.evaluate( "!!document.querySelector('dialog.lock-dlg[open]') && localStorage.getItem('nayive-lock')==='1'" ), "locks after the idle minute" );
    await sleep( 800 );
    ok( await a.evaluate( "document.querySelector('.lock-host').textContent.includes('Back soon')" ), "clock shows the user's text" );
    await a.shot( "clock" );

    // --- reload keeps it locked
    await a.go( "index.html" );
    ok( await a.evaluate( "!!document.querySelector('dialog.lock-dlg[open]') && document.documentElement.classList.contains('nv-locked')" ), "still locked after reload" );

    // --- a second tab (Drive) is locked too
    const b = await tab( "drive/index.html" );
    ok( await b.evaluate( "!!document.querySelector('dialog.lock-dlg[open]')" ), "a new tab opens locked" );

    // --- Esc does not close it
    await a.send( "Page.bringToFront" );
    await a.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 } );
    await a.send( "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 } );
    await a.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 } );
    await a.send( "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 } );
    await sleep( 300 );
    ok( await a.evaluate( "!!document.querySelector('dialog.lock-dlg[open]')" ), "Esc x2 does not unlock" );

    // --- a key shows the box, and lands in it
    await a.key( "x" );
    await sleep( 300 );
    ok( await a.evaluate( "!document.querySelector('.lock-card').hidden && document.activeElement.type==='password' && document.activeElement.value==='x'" ), "a key shows the box and is typed into it" );
    await a.send( "Input.insertText", { text: "yz" } );
    await a.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13 } );
    await sleep( 1500 );
    ok( await a.evaluate( "document.querySelector('.lock-msg').textContent==='Wrong password.' && !!document.querySelector('dialog.lock-dlg[open]')" ), "wrong password refused: " + await a.evaluate( "document.querySelector('.lock-msg').textContent" ) );
    await a.shot( "wrong" ); ok( await a.evaluate( "document.querySelector('.lock-card input').placeholder" ) === "Password to unlock", "box is translated after a reload" );

    ok( await a.evaluate( `fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:''})}).then(r=>r.status)` ) === 403, "an empty password is refused" );

    // --- right password in tab A opens tab B too
    await a.send( "Input.insertText", { text: "test" } );
    await a.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13 } );
    await sleep( 1200 );
    ok( await a.evaluate( "!document.querySelector('dialog.lock-dlg') && !document.documentElement.classList.contains('nv-locked') && localStorage.getItem('nayive-lock')===null" ), "right password unlocks" );
    ok( await b.evaluate( "!document.querySelector('dialog.lock-dlg') && !document.documentElement.classList.contains('nv-locked')" ), "the other tab unlocks too" );

    // --- the other two lockers draw something
    for( const id of [ "matrix", "stars", "life" ] )
    {
        await a.evaluate( `NayiveLock.save({id:'${id}'});NayiveLock.lock();1` );
        await sleep( 2500 );
        const lit = await a.evaluate( `(()=>{var c=document.querySelector('.lock-host canvas');if(!c)return -1;var d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,n=0;for(var i=0;i<d.length;i+=4)if(d[i]+d[i+1]+d[i+2]>60)n++;return n})()` );
        ok( lit > 50, id + " draws (" + lit + " lit px)" );
        await a.shot( id );
        await a.evaluate( "fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test'})}).then(r=>r.status)" );
        await a.evaluate( "localStorage.removeItem('nayive-lock');dispatchEvent(new StorageEvent('storage',{key:'nayive-lock'}));1" );
        await sleep( 300 );
    }

    // --- desktop mode: only the top window draws
    await a.evaluate( "NayiveLock.save({id:'stars'});1" );
    await a.go( "desktop/index.html" );
    await sleep( 2000 );
    await a.evaluate( "NayiveLock.lock();1" );
    await sleep( 1500 );
    const frames = await a.evaluate( `[...document.querySelectorAll('iframe')].map(f=>{try{return f.contentDocument.querySelectorAll('dialog.lock-dlg').length+':'+f.contentDocument.documentElement.classList.contains('nv-locked')}catch(e){return 'x'}}).join(',')` );
    ok( await a.evaluate( "document.querySelectorAll('dialog.lock-dlg[open]').length===1" ), "desktop: one locker on top; frames: " + frames );
    await a.shot( "desktop" );

    // --- a playing video counts as activity: covered by code, not driven here
    const errs = [ ...a.logs, ...b.logs ].filter( l => /EXCEPTION|locker/i.test( l ) );
    ok( errs.length === 0, "no exceptions: " + errs.join( " / " ) );
}
catch( e ) { console.log( "CRASH", e ); fails++; }
finally { br.kill(); }
console.log( fails ? fails + " FAILED" : "ALL OK" );
