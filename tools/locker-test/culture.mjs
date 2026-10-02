/*
 * culture.mjs - the "Salon" locker (shared/lockers/culture.js) in a real
 * browser, with LIVE data through the server's /api/culture/fetch. Needs a
 * server with the test/test account (a scratch run-root, see run.mjs):
 *
 *     node tools/locker-test/culture.mjs [base] [langs]      langs e.g. es,en,pt
 *
 * Screenshots: <tmp>/culture-*.png. The first run can take a minute: every
 * source is fetched once, one at a time.
 */
import { browser, attach } from "../cdp.mjs";
import os from "node:os";
import fs from "node:fs";
const B = process.argv[ 2 ] || "http://127.0.0.1:4471/nayive/";
const OUT = os.tmpdir() + "/culture-";
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
    await p.evaluate( `fetch('/api/files?file=data/salon.json',{method:'PUT',body:'{}'}).then(r=>r.status)` );   // the defaults
    await p.evaluate( `localStorage.removeItem('nayive-salon');Object.keys(localStorage).filter(k=>k.startsWith('nv-culture:')).forEach(k=>localStorage.removeItem(k));` +
                      `localStorage.setItem('nayive-locker',JSON.stringify({id:'culture',min:15}));localStorage.setItem('nayive-lock','1');1` );
    await go( "desktop/index.html" );
    ok( await p.evaluate( "!!document.querySelector('dialog.lock-dlg[open]')" ), "locked" );

    // Wait until every box has something (or 120 s).
    let st = null;
    for( let i = 0; i < 60; i++ )
    {
        await sleep( 2000 );
        st = JSON.parse( await p.evaluate( `JSON.stringify([...document.querySelectorAll('.lock-host .cl-box')].map(b=>({cls:b.className,lang:b.lang,head:b.querySelector('.cl-head span').textContent,text:b.querySelector('.cl-body').innerText.slice(0,300)})))` ) );
        const n = await p.evaluate( `Object.keys(localStorage).filter(k=>/^nv-culture:(word|quote|days):/.test(k)).length` );
        if( n >= 9 && st.length === 6 && st.every( b => ! /Fetching|Buscando|A procurar/.test( b.text ) ) ) break;
    }
    for( const b of st ) console.log( "--", b.cls, "[" + b.lang + "]", b.head, "\n  ", b.text.replace( /\n/g, " | " ) );
    ok( st.length === 6, "six boxes" );
    ok( st.every( b => b.text && ! /Fetching|Buscando|A procurar|not reachable|no responde/.test( b.text ) ), "every box filled" );
    const img = JSON.parse( await p.evaluate( `JSON.stringify((()=>{var i=document.querySelector('.cl-hang img');if(!i)return null;var r=i.getBoundingClientRect(),b=i.closest('.cl-box').getBoundingClientRect();return {w:r.width,h:r.height,nat:i.naturalWidth,inside:r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom}})())` ) );
    console.log( "painting", img );
    ok( img && img.w > 100 && img.h > 100 && img.inside, "the painting shows, whole, inside its box" );
    ok( await p.evaluate( "document.fonts.check('20px \"Bodoni Moda\"') && document.fonts.check('20px Literata')" ), "fonts loaded" );

    // What each language has (the turns skip the ones with nothing).
    const have = JSON.parse( await p.evaluate( `JSON.stringify(Object.keys(localStorage).filter(k=>k.startsWith('nv-culture:')).map(k=>k.slice(11)).sort())` ) );
    console.log( have.join( "\n" ) );
    for( const l of [ "es", "en", "pt" ] )
        for( const c of [ "word", "quote", "days" ] )
            ok( have.some( k => k.startsWith( c + ":" + l + ":" ) ), c + " in " + l );
    const words = JSON.parse( await p.evaluate( `JSON.stringify(Object.keys(localStorage).filter(k=>/^nv-culture:(word|quote):/.test(k)).map(k=>[k.slice(11),JSON.parse(localStorage.getItem(k)).v]))` ) );
    for( const [ k, v ] of words ) console.log( k, JSON.stringify( v ).slice( 0, 400 ) );

    const links = await p.evaluate( `[...document.querySelectorAll('.lock-host a[href^="https://"][target=_blank]')].map(a=>a.closest('.cl-box').className.split(' ').pop()).join(',')` );
    console.log( "links in", links );
    for( const c of [ "cl-art", "cl-word", "cl-quote", "cl-weather" ] ) ok( links.includes( c ), "a link in " + c );
    await shot( "screen" );
    const errors = p.logs.filter( l => /^(EXCEPTION|LOG-ERROR)/.test( l ) );
    ok( errors.length === 0, "no errors in the console" + ( errors.length ? ":\n  " + errors.join( "\n  " ) : "" ) );
}
finally
{
    await br.kill();
}
console.log( fails ? fails + " FAILED" : "all ok" );
process.exit( fails ? 1 : 0 );
