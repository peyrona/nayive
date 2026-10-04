/*
 * science.mjs - the "Science" locker (shared/lockers/science.js) in a real
 * browser, with LIVE data through the server's /api/culture/fetch. Needs a
 * server with the test/test account (a scratch run-root, see run.mjs):
 *
 *     node tools/locker-test/science.mjs [base]
 *
 * Screenshots: <tmp>/science-*.png. Also opens its settings dialog (desktop
 * "⋮" menu) and checks the News tab.
 */
import { browser, attach } from "../cdp.mjs";
import os from "node:os";
import fs from "node:fs";
const B = process.argv[ 2 ] || "http://127.0.0.1:4471/nayive/";
const OUT = os.tmpdir() + "/science-";
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
let fails = 0;
const ok = ( c, m ) => { console.log( ( c ? "ok   " : "FAIL " ) + m ); if( ! c ) fails++; };

const br = await browser( [ "--window-size=1600,900" ] );
try
{
    const t = await br.newTab( "about:blank" );
    const p = await attach( t.webSocketDebuggerUrl );
    await p.send( "Network.enable" );
    await p.send( "Network.setBypassServiceWorker", { bypass: true } );
    await p.send( "Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false } );
    const go = async u => { await p.send( "Page.navigate", { url: B + u } ); await sleep( 2500 ); };
    const shot = async n => fs.writeFileSync( OUT + n + ".png", Buffer.from( ( await p.send( "Page.captureScreenshot" ) ).result.data, "base64" ) );

    await go( "login.html" );
    await p.evaluate( `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    // No science.json: it starts from Bellas artes' languages (es, en, pt here).
    await p.evaluate( `fetch('/api/files?file=data/salon.json',{method:'PUT',body:JSON.stringify({langs:['es','en','pt']})}).then(r=>r.status)` );
    await p.evaluate( `fetch('/api/files?file=data/science.json',{method:'DELETE'}).then(r=>r.status)` );
    await p.evaluate( `['nayive-salon','nayive-science'].forEach(k=>localStorage.removeItem(k));Object.keys(localStorage).filter(k=>k.startsWith('nv-science:')).forEach(k=>localStorage.removeItem(k));` +
                      `localStorage.setItem('balata-coach-seen','1');localStorage.setItem('nayive-install-snooze','never');` +
                      `localStorage.setItem('nayive-locker',JSON.stringify({v:2,id:'science',min:15}));localStorage.setItem('nayive-lock','1');1` );
    await go( "desktop/index.html" );
    ok( await p.evaluate( "!!document.querySelector('dialog.lock-dlg[open]')" ), "locked" );

    // Wait until every box has something (or 150 s).
    let st = null;
    for( let i = 0; i < 75; i++ )
    {
        await sleep( 2000 );
        st = JSON.parse( await p.evaluate( `JSON.stringify([...document.querySelectorAll('.lock-host .cl-box')].map(b=>({cls:b.className,lang:b.lang,head:b.querySelector('.cl-head span').textContent,text:b.querySelector('.cl-body').innerText.slice(0,400)})))` ) );
        const n = await p.evaluate( `Object.keys(localStorage).filter(k=>/^nv-science:(news2|days):/.test(k)).length` );
        if( n >= 7 && st.length === 6 && st.every( b => ! /Fetching|Buscando|A procurar/.test( b.text ) ) && st.some( b => /sc-sky/.test( b.cls ) && /°/.test( b.text ) ) ) break;
    }
    for( const b of st ) console.log( "--", b.cls, "[" + b.lang + "]", b.head, "\n  ", b.text.replace( /\n/g, " | " ) );
    ok( st.length === 6, "six boxes" );
    ok( st.every( b => b.text && ! /Fetching|Buscando|A procurar|not reachable|no responde/.test( b.text ) ), "every box filled" );
    const img = JSON.parse( await p.evaluate( `JSON.stringify((()=>{var i=document.querySelector('.sc-picture .cl-hang img');if(!i)return null;var r=i.getBoundingClientRect(),b=i.closest('.cl-box').getBoundingClientRect();return {w:r.width,h:r.height,nat:i.naturalWidth,inside:r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1}})())` ) );
    console.log( "picture", img );
    ok( img && img.w > 100 && img.h > 100 && img.inside, "the picture shows, whole, inside its box" );
    ok( await p.evaluate( "!!document.querySelector('.sc-moon svg path')" ), "the Moon is drawn" );
    ok( await p.evaluate( "document.querySelectorAll('.sc-table i').length === 118 && document.querySelectorAll('.sc-table i.on').length === 1" ), "periodic table, one element lit" );
    ok( await p.evaluate( "!!document.querySelector('.sc-news .sc-title') && document.querySelectorAll('.sc-news .sc-list li').length >= 1" ), "news: a headline and more" );
    ok( await p.evaluate( "!document.querySelector('.sc-news img')" ), "news without pictures" );

    // What each source and language has.
    const have = JSON.parse( await p.evaluate( `JSON.stringify(Object.keys(localStorage).filter(k=>k.startsWith('nv-science:')).map(k=>k.slice(11)).sort())` ) );
    console.log( have.join( "\n" ) );
    for( const s of [ "sinc", "tcEs", "tcEn", "nasa", "fapesp" ] ) ok( have.includes( "news2:" + s ), "news from " + s );
    for( const s of [ "nasa", "eso", "esa" ] ) ok( have.includes( "pictures3:" + s ), "pictures from " + s );
    for( const l of [ "es", "en", "pt" ] ) ok( have.some( k => k.startsWith( "days:" + l + ":" ) ), "on this day in " + l );
    ok( ! have.includes( "news2:tcPt" ), "The Conversation Brasil off by default (all topics)" );
    const news = JSON.parse( await p.evaluate( `JSON.stringify(Object.keys(localStorage).filter(k=>/^nv-science:(news2|element|pictures)/.test(k)).map(k=>[k.slice(11),JSON.parse(localStorage.getItem(k)).v]))` ) );
    for( const [ k, v ] of news ) console.log( k, JSON.stringify( Array.isArray( v ) ? v.slice( 0, 2 ) : v ).slice( 0, 500 ) );
    const leads = news.filter( ( [ k ] ) => k.startsWith( "news2:" ) ).map( ( [ k, v ] ) => [ k, v.filter( n => n.lead ).length, v.length ] );
    console.log( "leads", JSON.stringify( leads ) );
    ok( leads.every( ( [ , a, n ] ) => a >= n / 2 ), "most stories have a lead" );
    await shot( "screen" );

    // Links: they open in a new tab, and a press on one does not bring up the password box.
    const links = JSON.parse( await p.evaluate( `JSON.stringify([...document.querySelectorAll('.lock-host a[href]')].map(a=>[a.closest('.cl-box').className.split(' ').pop(),a.href.slice(0,70),a.target,a.rel]))` ) );
    console.log( links.map( l => l.join( " " ) ).join( "\n" ) );
    ok( links.length >= 6 && links.every( l => /^https:\/\//.test( l[ 1 ] ) && l[ 2 ] === "_blank" && /noopener/.test( l[ 3 ] ) ), "links: https, new tab, noopener" );
    for( const c of [ "sc-news", "sc-picture", "sc-element", "cl-days", "sc-sky" ] ) ok( links.some( l => l[ 0 ] === c ), "a link in " + c );
    ok( await p.evaluate( `(()=>{var a=document.querySelector('.sc-news .sc-title');a.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return document.querySelector('.lock-card').hidden})()` ), "a press on a link: no password box" );
    ok( await p.evaluate( `(()=>{document.querySelector('.sc-news .sc-more').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));var h=document.querySelector('.lock-card').hidden;return !h})()` ), "a press elsewhere: the password box" );

    // A real mouse click on a headline: a new tab with its page, still locked here.
    await p.evaluate( "document.querySelector('.lock-dlg').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));1" );   // the box of the check above
    const before = ( await ( await fetch( `http://127.0.0.1:${br.port}/json/list` ) ).json() ).filter( x => x.type === "page" ).length;
    const at = JSON.parse( await p.evaluate( `JSON.stringify((()=>{var r=document.querySelector('.sc-news .sc-title').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})())` ) );
    for( const type of [ "mousePressed", "mouseReleased" ] )
        await p.send( "Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 } );
    await sleep( 2000 );
    const pages = ( await ( await fetch( `http://127.0.0.1:${br.port}/json/list` ) ).json() ).filter( x => x.type === "page" );
    console.log( "tabs:", pages.map( x => x.url.slice( 0, 80 ) ).join( " | " ) );
    ok( pages.length === before + 1 && pages.some( x => /^https:\/\/(theconversation|www\.agenciasinc|www\.nasa|agencia\.fapesp)/.test( x.url ) ), "a click opens the story in a new tab" );
    ok( await p.evaluate( "!!document.querySelector('dialog.lock-dlg[open]')" ), "...the screen stays locked" );
    ok( await p.evaluate( "document.querySelector('.lock-card').hidden" ), "...and no password box" );

    // Without English: nothing in English (NASA's picture alone, no English news).
    await p.evaluate( `fetch('/api/files?file=data/science.json',{method:'PUT',body:JSON.stringify({langs:['es','pt']})}).then(r=>r.status)` );
    await go( "desktop/index.html" );
    for( let i = 0; i < 20; i++ ) { await sleep( 1500 ); if( await p.evaluate( "!!document.querySelector('.sc-picture .cl-hang img') && !!document.querySelector('.sc-news .sc-title')" ) ) break; }
    await sleep( 1000 );
    const noEn = JSON.parse( await p.evaluate( `JSON.stringify({langs:[...document.querySelectorAll('.lock-host .cl-box')].map(b=>b.lang),label:(document.querySelector('.sc-picture .cl-label')||{}).innerText,story:!!document.querySelector('.sc-picture .story'),src:document.querySelector('.sc-news .cl-head .src').textContent})` ) );
    console.log( "no English:", JSON.stringify( noEn ) );
    ok( noEn.langs.every( l => l === "es" || l === "pt" ) && ! noEn.story && ! /Rocket|Space|NASA’s|the /.test( noEn.label ) && ! /^NASA$|UK/.test( noEn.src ), "no English anywhere" );
    await shot( "no-english" );
    await p.evaluate( `fetch('/api/files?file=data/science.json',{method:'DELETE'}).then(r=>r.status)` );

    // The settings dialog, from the desktop's ⋮ menu (unlocked first).
    await p.evaluate( `fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test'})}).then(r=>r.status)` );
    await p.evaluate( `localStorage.removeItem('nayive-lock');1` );
    await go( "desktop/index.html" );
    await sleep( 1000 );
    const btn = await p.evaluate( `(()=>{var b=document.getElementById('salonBtn');return b.hidden+'|'+b.textContent})()` );
    console.log( "menu button", btn );
    ok( /^false\|/.test( btn ) && /Ciencia|Science/.test( btn ), "⋮ menu offers Science's settings" );
    await p.evaluate( `document.getElementById('salonBtn').click();1` );
    await sleep( 2500 );
    const tabs = await p.evaluate( `[...document.querySelectorAll('#salonSettings .salon-tabs button')].map(b=>b.textContent).join('|')` );
    console.log( "tabs", tabs );
    ok( /Noticias|News/.test( tabs ) && ! /Arte\b|\bArt\b/.test( tabs ), "News tab instead of Art" );
    await p.evaluate( `[...document.querySelectorAll('#salonSettings .salon-tabs button')].find(b=>/Noticias|News/.test(b.textContent)).click();1` );
    await sleep( 400 );
    const src = await p.evaluate( `[...document.querySelectorAll('#salonSettings .salon-pane:not([hidden]) .salon-check')].map(l=>(l.querySelector('input').checked?'[x] ':'[ ] ')+l.textContent).join('\\n')` );
    console.log( src );
    ok( src.split( "\n" ).length === 8, "eight sources listed" );
    await p.evaluate( `[...document.querySelectorAll('#salonSettings .salon-tabs button')][1].click();1` );
    await sleep( 400 );
    const pics = await p.evaluate( `[...document.querySelectorAll('#salonSettings .salon-pane:not([hidden]) .salon-check')].filter(l=>/NASA|ESO|ESA/.test(l.textContent)).map(l=>(l.querySelector('input').checked?'[x] ':'[ ] ')+l.textContent).join('\\n')` );
    console.log( pics );
    ok( pics.split( "\n" ).length === 3 && ! /\[ \]/.test( pics ), "three picture sources, all ticked" );
    await shot( "settings" );
    // Untick SINC, save, and read it back from the server.
    await p.evaluate( `[...document.querySelectorAll('#salonSettings .salon-check')].find(l=>/SINC/.test(l.textContent)).querySelector('input').click();document.querySelector('#salonSettings .sheet-close').click();1` );
    await sleep( 1500 );
    const saved = JSON.parse( await p.evaluate( `fetch('/api/files?file=data/science.json').then(r=>r.text())` ) );
    ok( saved.news && ! saved.news.includes( "sinc" ) && saved.news.includes( "tcEs" ) && saved.langs.join() === "es,en,pt", "saved per user in data/science.json" );
    await p.evaluate( `fetch('/api/files?file=data/science.json',{method:'DELETE'}).then(r=>r.status)` );

    const errors = p.logs.filter( l => /^(EXCEPTION|LOG-ERROR)/.test( l ) && ! /404 .*science\.json/.test( l ) );   // never saved: expected
    ok( errors.length === 0, "no errors in the console" + ( errors.length ? ":\n  " + JSON.stringify( errors ).slice( 0, 2000 ) : "" ) );
}
finally
{
    await br.kill();
}
console.log( fails ? fails + " FAILED" : "all ok" );
process.exit( fails ? 1 : 0 );
