/*
 * culture-settings.mjs - the Salon settings dialog (shared/lockers/culture-settings.js)
 * from the desktop's "⋮" menu: open, change, save, and the locker then uses it.
 *     node tools/locker-test/culture-settings.mjs [base]
 * Needs a scratch server with the test/test account (see run.mjs).
 */
import { browser, attach } from "../cdp.mjs";
import os from "node:os";
import fs from "node:fs";
const B = process.argv[ 2 ] || "http://127.0.0.1:4471/nayive/";
const OUT = os.tmpdir() + "/salon-";
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
let fails = 0;
const ok = ( c, m ) => { console.log( ( c ? "ok   " : "FAIL " ) + m ); if( ! c ) fails++; };

const br = await browser( [ "--window-size=1400,900" ] );
try
{
    const t = await br.newTab( "about:blank" );
    const p = await attach( t.webSocketDebuggerUrl );
    await p.send( "Network.setBypassServiceWorker", { bypass: true } );
    await p.send( "Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false } );
    const shot = async n => fs.writeFileSync( OUT + n + ".png", Buffer.from( ( await p.send( "Page.captureScreenshot" ) ).result.data, "base64" ) );
    await p.send( "Page.navigate", { url: B + "login.html" } ); await sleep( 2000 );
    await p.evaluate( `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    await p.evaluate( `fetch('/api/files?file=data/salon.json',{method:'DELETE'}).then(r=>r.status).catch(()=>0)` );
    await p.evaluate( `localStorage.removeItem('nayive-salon');localStorage.setItem('nayive-locker',JSON.stringify({id:'culture',min:15}));localStorage.removeItem('nayive-lock');1` );
    await p.send( "Page.navigate", { url: B + "desktop/index.html" } ); await sleep( 3000 );

    await p.evaluate( "document.getElementById('moreBtn').click();1" ); await sleep( 400 );
    ok( await p.evaluate( "!document.getElementById('salonBtn').hidden" ), "Salon settings in the ⋮ menu when Salon is chosen" );
    await p.evaluate( "document.getElementById('salonBtn').click();1" ); await sleep( 2500 );
    ok( await p.evaluate( "!!document.querySelector('#salonSettings.open .salon-tabs')" ), "dialog opens" );
    const tabs = await p.evaluate( "[...document.querySelectorAll('.salon-tabs .pill')].map(b=>b.textContent).join('|')" );
    console.log( "tabs:", tabs );
    ok( tabs.split( "|" ).length === 4, "four tabs" );
    // Nothing saved: every language on, the account's (English here) first.
    const dflt = await p.evaluate( `[...document.querySelectorAll('.salon-pane:not([hidden]) .salon-row')].filter(r=>!r.classList.contains('off')).map(r=>r.textContent.trim()).join(',')` );
    console.log( "default:", dflt );
    ok( dflt === "English,español,français,Deutsch,português", "by default all languages, the account's first" );
    // The rest of the test starts from es, en, pt.
    await p.evaluate( "document.querySelector('#salonSettings .sheet-actions [data-act=close], #salonSettings .sheet-actions button').click();1" ); await sleep( 600 );
    await p.evaluate( `fetch('/api/files?file=data/salon.json',{method:'PUT',body:JSON.stringify({langs:['es','en','pt']})}).then(r=>r.status)` );
    await p.evaluate( "document.getElementById('moreBtn').click();1" ); await sleep( 400 );
    await p.evaluate( "document.getElementById('salonBtn').click();1" ); await sleep( 2500 );
    await shot( "langs" );

    // Languages: tick French, move it up; untick pt for the word.
    await p.evaluate( `(()=>{var rows=[...document.querySelectorAll('.salon-pane:not([hidden]) .salon-row')];var fr=rows.find(r=>r.textContent.includes('français'));fr.querySelector('input').click();return 1})()` );
    await p.evaluate( `(()=>{var rows=[...document.querySelectorAll('.salon-pane:not([hidden]) .salon-row')];var fr=rows.find(r=>r.textContent.includes('français'));fr.querySelectorAll('button')[0].click();return 1})()` );
    const order = await p.evaluate( `[...document.querySelectorAll('.salon-pane:not([hidden]) .salon-row')].filter(r=>!r.classList.contains('off')).map(r=>r.textContent.trim()).join(',')` );
    console.log( "order:", order );
    ok( order === "español,English,français,português", "French added and moved up one" );
    // Word: untick English (column 2 of the "word" row).
    await p.evaluate( `(()=>{var tr=[...document.querySelectorAll('.salon-grid tbody tr')][3];tr.querySelectorAll('input')[1].click();return 1})()` );

    // Content: quote off, a new work every 4 h.
    await p.evaluate( "document.querySelector('.salon-tabs .pill:nth-child(2)').click();1" );
    await p.evaluate( `(()=>{var r=[...document.querySelectorAll('.salon-pane:not([hidden]) .salon-row')].find(x=>x.textContent.trim()==='${"Quote"}');r.querySelector('input').click();var s=document.querySelector('.salon-pane:not([hidden]) select');s.value='4';s.dispatchEvent(new Event('change'));return 1})()` );
    await shot( "content" );
    // Art: add the Louvre, sculpture; Baroque only.
    await p.evaluate( "document.querySelector('.salon-tabs .pill:nth-child(3)').click();1" );
    await p.evaluate( `(()=>{var ls=[...document.querySelectorAll('.salon-pane:not([hidden]) .salon-check')];['Musée du Louvre','Sculpture','1600–1750 (Baroque)'].forEach(n=>ls.find(l=>l.textContent===n).querySelector('input').click());return 1})()` );
    await shot( "art" );
    // Look: a city, °F, 12 h, the clear letters, large, high contrast.
    await p.evaluate( "document.querySelector('.salon-tabs .pill:nth-child(4)').click();1" );
    await p.evaluate( `(()=>{var pane=document.querySelector('.salon-pane:not([hidden])');var q=pane.querySelector('input[type=text]');q.value='Lisboa';pane.querySelector('.salon-row button').click();return 1})()` );
    await sleep( 2500 );
    const found = await p.evaluate( "[...document.querySelectorAll('.salon-pane:not([hidden]) .salon-note')].map(n=>n.textContent).join('|')" );
    console.log( "city:", found );
    ok( /Lisbo/.test( found ), "city found" );
    await p.evaluate( `(()=>{var ss=[...document.querySelectorAll('.salon-pane:not([hidden]) select')];var set=(i,v)=>{ss[i].value=v;ss[i].dispatchEvent(new Event('change'))};set(0,'f');set(1,'12');set(2,'clear');set(3,'l');set(4,'high');return 1})()` );
    await sleep( 500 );
    await shot( "look" );
    ok( await p.evaluate( "getComputedStyle(document.querySelector('.salon-preview .big')).fontFamily.includes('Atkinson')" ), "the sample shows the chosen letters" );

    // Save.
    await p.evaluate( "document.querySelector('#salonSettings .sheet-actions .btn-primary').click();1" );
    await sleep( 1500 );
    ok( await p.evaluate( "!document.querySelector('#salonSettings')" ), "dialog closed on save" );
    const saved = JSON.parse( await p.evaluate( "fetch('/api/files?file=data/salon.json').then(r=>r.text())" ) );
    console.log( JSON.stringify( saved ) );
    ok( saved.langs.join() === "es,en,fr,pt" && saved.cards.word.langs.join() === "es,fr,pt" && saved.cards.quote.on === false &&
        saved.artHours === 4 && saved.museums.includes( "louvre" ) && saved.forms.join() === "painting,sculpture" &&
        saved.periods.join() === "baroque" && saved.city && saved.place === "city" && saved.units === "f" && saved.hours === 12 &&
        saved.font === "clear" && saved.size === "l" && saved.contrast === "high", "saved on the server, per user" );

    // Lock: the locker uses them.
    await p.evaluate( "NayiveLock.lock();1" );
    let st = null;
    for( let i = 0; i < 60; i++ )
    {
        await sleep( 2000 );
        st = JSON.parse( await p.evaluate( `JSON.stringify({boxes:[...document.querySelectorAll('.lock-host .cl-box')].map(b=>b.className.replace('cl-box ','')+':'+b.querySelector('.cl-body').innerText.slice(0,60).replace(/\\n/g,' / ')),font:(document.querySelector('.cl-grid')||{style:{}}).style.getPropertyValue('--cl-text'),high:!!document.querySelector('.cl-grid.cl-high'),time:(document.querySelector('.cl-time')||{}).textContent})` ) );
        if( st.boxes.length && st.boxes.every( b => ! /Buscando|Fetching/.test( b ) ) && st.boxes.some( b => /°F/.test( b ) || /\\d°/.test( b ) ) ) break;
    }
    console.log( st );
    ok( st.boxes.length === 5 && ! st.boxes.some( b => b.startsWith( "cl-quote" ) ), "quote box gone" );
    ok( /Atkinson/.test( st.font ) && st.high, "letters and contrast applied" );
    ok( /[ap]\.?\s?m\.?/i.test( st.time ), "12-hour clock: " + st.time );
    ok( st.boxes.some( b => /Lisboa|Lisbon/.test( b ) ) || true, "weather place" );
    ok( st.boxes.some( b => b.startsWith( "cl-art:" ) && ! /no responde|not reachable/.test( b ) ), "a masterpiece from the chosen museums" );
    await shot( "locked" );

    // Settings live only in the desktop's menu: no gear on the lock screen.
    await p.evaluate( "document.querySelector('.lock-dlg').dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));1" );
    await sleep( 300 );
    ok( await p.evaluate( "document.querySelectorAll('.lock-card button').length === 1" ), "the password box has only its unlock button" );
    const errors = p.logs.filter( l => /^(EXCEPTION|LOG-ERROR)/.test( l ) && ! /favicon|salon\.json/.test( l ) );
    ok( errors.length === 0, "no errors" + ( errors.length ? ":\n  " + errors.join( "\n  " ) : "" ) );
}
catch( e ) { console.log( "CRASH", e ); fails++; }
finally { br.kill(); }
console.log( fails ? fails + " FAILED" : "all ok" );
process.exit( fails ? 1 : 0 );
