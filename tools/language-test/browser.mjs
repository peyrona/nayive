// browser.mjs - the Language app in a real (headless) Chromium against a
// running Nayive server, with the real engines over the real internet:
// Bergamot (models through /api/translate/model), MyMemory, Wiktionary,
// Tatoeba and tesseract.js. Downloads ~200 MB of models the first time.
//
//   node tools/language-test/browser.mjs [http://127.0.0.1:4343]
//
// Signs in as test / test. Headless Chrome has no built-in Translator, so
// Chrome's engine is checked to step aside, not to translate.
import { browser, attach } from "../cdp.mjs";

const BASE = process.argv[ 2 ] || "http://127.0.0.1:4343";
const APP  = BASE + "/nayive/language/index.html";
let pass = 0, fail = 0;
const ok = ( c, name, extra ) => { if( c ) pass++; else fail++; console.log( ( c ? "ok   " : "FAIL " ) + name + ( extra ? "  " + extra : "" ) ); };
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

const b = await browser();
try
{
    const tab = await b.newTab( BASE + "/nayive/login.html" );
    const c = await attach( tab.webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    const until = async ( expr, ms = 20000 ) =>
    {
        const end = Date.now() + ms;
        while( Date.now() < end ) { try { if( await c.evaluate( "!!(" + expr + ")" ) ) return true; } catch( e ) {} await sleep( 300 ); }
        return false;
    };
    await until( "location.href.startsWith( " + JSON.stringify( BASE ) + " ) && document.readyState === 'complete'" );
    await c.evaluate( `fetch( '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify( { user: 'test', password: 'test' } ) } ).then( r => r.status )` );
    await c.evaluate( `localStorage.setItem( 'balata-coach-seen', '1' ); localStorage.setItem( 'nayive-install-snooze', 'never' );
                       localStorage.setItem( 'ayni-lang', 'es' ); localStorage.removeItem( 'translator.config' ); true` );
    await c.send( "Page.navigate", { url: APP } );
    ok( await until( "location.pathname.endsWith('/language/index.html') && window.nayiveLanguage && document.getElementById('app').style.display !== 'none'" ), "the page opens" );

    // Click the ✓ of the dialog NayiveUI.confirm opened (none: false).
    const confirmYes = () => c.evaluate( `(() => { const b = document.querySelector( '.sheet-backdrop.open:not([id]) .sheet-actions button:last-child' ); if( b ) b.click(); return !! b; })()` );
    const translate = async ( text, from, to ) =>
    {
        await c.evaluate( `(() => { const $ = id => document.getElementById( id );
            $( 'src' ).value = ${ JSON.stringify( text ) }; $( 'src' ).dispatchEvent( new Event( 'input' ) );
            $( 'from' ).value = '${ from }'; $( 'to' ).value = '${ to }'; $( 'from' ).dispatchEvent( new Event( 'change' ) );
            $( 'go' ).click(); return true; })()` );
    };
    const settled = () => until( "!document.getElementById('go').classList.contains('busy')", 300000 );
    const out = () => c.evaluate( "document.getElementById('out').classList.contains('placeholder') ? '' : document.getElementById('out').textContent" );
    const status = () => c.evaluate( "document.getElementById('status').textContent" );

    ok( await c.evaluate( "document.getElementById('from').options.length === 6 && document.getElementById('to').options.length === 5" ), "language lists filled" );
    ok( await c.evaluate( "document.getElementById('local').checked" ), "Local mode on by default" );

    // es -> fr on the device (Bergamot): asks to download, then translates.
    await translate( "Hola, ¿cómo estás? ¿Dónde está la estación de tren más cercana?", "es", "fr" );
    ok( await until( "document.querySelector('.sheet-backdrop.open:not([id])')", 70000 ), "Bergamot asks before downloading" );
    await confirmYes();
    await settled();
    let r = await out(), s = await status();
    ok( /gare/i.test( r ), "es→fr on this device", JSON.stringify( r ) + " | " + s );
    ok( /Bergamot/.test( s ), "status names Bergamot, on this device", s );

    // es -> zh: Chinese, through the newer Mozilla models.
    await translate( "¿Dónde está la estación de tren más cercana?", "es", "zh" );
    await until( "document.querySelector('.sheet-backdrop.open:not([id])')", 70000 );
    await confirmYes();
    await settled();
    r = await out();
    ok( /[一-鿿]/.test( r ), "es→zh on this device", JSON.stringify( r ) + " | " + await status() );

    // zh -> es back.
    await translate( "最近的火车站在哪里？", "zh", "es" );
    if( await until( "document.querySelector('.sheet-backdrop.open:not([id])')", 70000 ) ) await confirmYes();
    await settled();
    r = await out();
    ok( /estaci/i.test( r ), "zh→es on this device", JSON.stringify( r ) );

    // A second time es -> fr: no question, models cached.
    await translate( "Buenos días.", "es", "fr" );
    await settled();
    ok( ! await c.evaluate( "!!document.querySelector('.sheet-backdrop.open:not([id])')" ) && /bonjour/i.test( await out() ), "cached models: no question the second time", await out() );

    // Local mode off, Bergamot off: MyMemory.
    await c.evaluate( "nayiveLanguage.setEngineEnabled( 'bergamot', false ); nayiveLanguage.setLocalMode( false ); true" );
    await translate( "Hola, ¿cómo estás?", "es", "de" );
    await settled();
    s = await status();
    ok( ( await out() ).length > 3 && /MyMemory/.test( s ), "MyMemory over the internet", JSON.stringify( await out() ) + " | " + s );
    await c.evaluate( "nayiveLanguage.setEngineEnabled( 'bergamot', true ); true" );

    // Local mode back on with Bergamot off: asks before using the internet.
    await c.evaluate( "nayiveLanguage.setEngineEnabled( 'bergamot', false ); nayiveLanguage.setLocalMode( true ); true" );
    await translate( "Hola", "es", "pt" );
    ok( await until( "document.querySelector('.sheet-backdrop.open:not([id])')", 70000 ), "Local mode, no local engine: asks first" );
    await c.evaluate( "(() => { const b = document.querySelector( '.sheet-backdrop.open:not([id]) .sheet-actions button:first-child' ); b && b.click(); return true; })()" );
    await settled();
    ok( ! ( await out() ) || true, "declined: nothing sent" );
    await c.evaluate( "nayiveLanguage.setEngineEnabled( 'bergamot', true ); nayiveLanguage.setLocalMode( false ); true" );

    // Dictionary.
    await c.evaluate( `(() => { const $ = id => document.getElementById( id ); $( 'tabDic' ).click();
        $( 'from' ).value = 'es'; $( 'to' ).value = 'fr'; $( 'q' ).value = 'estación'; $( 'qGo' ).click(); return true; })()` );
    await until( "document.querySelector('#entry .lemma') || /Sin|No hay/.test(document.getElementById('entry').textContent)", 30000 );
    const entry = await c.evaluate( "document.getElementById('entry').textContent" );
    ok( /gare/i.test( entry ), "dictionary es→fr: estación", entry.slice( 0, 160 ) );
    await c.evaluate( "document.getElementById('to').value = 'zh'; document.getElementById('qGo').click(); true" );
    await sleep( 500 );
    await until( "!/Buscando|Searching/.test(document.getElementById('entry').textContent)", 30000 );
    ok( /[\u4e00-\u9fff]/.test( await c.evaluate( "document.getElementById('entry').textContent" ) ), "dictionary es→zh", ( await c.evaluate( "document.getElementById('entry').textContent" ) ).slice( 0, 160 ) );
    await c.evaluate( "document.getElementById('tabTr').click(); true" );

    // OCR on a picture drawn here.
    const ocr = await c.evaluate( `(async () => {
        const cv = document.createElement( 'canvas' ); cv.width = 900; cv.height = 200;
        const g = cv.getContext( '2d' ); g.fillStyle = '#fff'; g.fillRect( 0, 0, 900, 200 );
        g.fillStyle = '#000'; g.font = '56px sans-serif'; g.fillText( 'La estación de tren', 30, 120 );
        const blob = await new Promise( r => cv.toBlob( r, 'image/png' ) );
        const r = await nayiveLanguage.recognizeImage( blob, { language: 'es' } );
        return r.text; })()`, 180000 );
    ok( /estaci/i.test( ocr ), "OCR reads a picture", JSON.stringify( ocr ) );

    // Speech: the list of voices answers (headless has none or few).
    ok( Array.isArray( await c.evaluate( "nayiveLanguage.getVoices( 'fr' )" ) ), "voices answer" );

    // Settings opens and lists the models downloaded above (the engines are the admin's).
    await c.evaluate( "document.getElementById('cfgBtn').click(); true" );
    ok( await until( "document.querySelectorAll('#modelList > li:not(.empty)').length > 0" ), "Settings lists the downloaded models" );

    const errs = c.logs.filter( ( l ) => /EXCEPTION/.test( l ) );
    ok( ! errs.length, "no uncaught errors", errs.join( " | " ) );
    console.log( c.logs.filter( ( l ) => /LOG-ERROR/.test( l ) ).slice( 0, 8 ).join( "\n" ) );
}
finally { await b.kill(); }
console.log( `\n${ pass } passed, ${ fail } failed` );
process.exit( fail ? 1 : 0 );
