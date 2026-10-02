// run.mjs - the eMail app in a real (headless) browser, against a real
// Nayive built from server/go with a mail account on an in-memory IMAP
// server (TestMailE2EServe in server/go/mail_e2e_test.go). See README.md.
//
//   node tools/email-test/run.mjs
//
// Needs Go (GO=/path/to/go, default ~/sdk/go1.27.1/bin/go) and Chromium.
// Nothing of the real store/ is touched; screenshots go to a temp folder.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || path.join( os.homedir(), "sdk/go1.27.1/bin/go" );

let pass = 0, fail = 0;
// the writer's text: Squire's box takes HTML; a change reaches it by its
// MutationObserver (a moment later, hence the pause); read back as plain text
const TYPE = html => `( async () => { document.getElementById('cText').innerHTML = ${ JSON.stringify( html ) }; await new Promise( r => setTimeout( r, 80 ) ); } )()`;
const TEXT = "NayiveMail.composeText()";
function ok( cond, what, extra ) { if( cond ) { pass++; console.log( "  ok  " + what ); } else { fail++; console.log( "  FAIL " + what + ( extra !== undefined ? "  -> " + JSON.stringify( extra ) : "" ) ); } }
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

// ---------------------------------------------------------------------------
// the server: TestMailE2EServe on a free port, until the stop file appears
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;
const TMP  = fs.mkdtempSync( path.join( os.tmpdir(), "email-test-" ) );
const STOP = path.join( TMP, "stop" );
const SHOTS = path.join( TMP, "shots" );
fs.mkdirSync( SHOTS );
const server = spawn( GO, [ "test", "-v", "-count=1", "-timeout", "20m", "-run", "^TestMailE2EServe$", "." ],
                      { cwd: path.join( REPO, "server/go" ), env: { ...process.env, NAYIVE_MAIL_E2E: "127.0.0.1:" + PORT, NAYIVE_MAIL_E2E_STOP: STOP },
                        stdio: [ "ignore", "pipe", "inherit" ] } );
await new Promise( ( res, rej ) =>
{
    let buf = "";
    const t = setTimeout( () => rej( new Error( "the test server did not start: " + buf ) ), 180000 );
    server.stdout.on( "data", d => { buf += d; if( buf.includes( "E2E READY" ) ) { clearTimeout( t ); res(); } } );
    server.on( "exit", code => rej( new Error( "the test server stopped: " + code + " " + buf ) ) );
} );

function cleanup()
{
    try { fs.writeFileSync( STOP, "" ); } catch {}
    setTimeout( () => { try { server.kill(); } catch {} }, 1500 );
}

const MOUSE = [ "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4" ];
async function launch()
{
    const b = await browser( MOUSE );
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    c.kill = b.kill;
    c.port = b.port;
    return c;
}
async function waitFor( c, expr, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( await c.evaluate( "!!(" + expr + ")" ) ) return true; } catch {} await sleep( 100 ); }
    return false;
}
async function nav( c, url, pathWant )
{
    await c.send( "Page.navigate", { url } );
    await waitFor( c, `location.pathname === ${JSON.stringify( pathWant )} && document.readyState === 'complete'` );
}
async function shot( c, name )
{
    const r = await c.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( `${SHOTS}/${name}.png`, Buffer.from( r.result.data, "base64" ) );
}
const get = async p => ( await fetch( BASE + p ) ).json();
const TOASTS = `window.__toasts = []; new MutationObserver( () => { const t = document.getElementById('toast'); if( t.classList.contains('show') ) window.__toasts.push( t.firstChild ? t.firstChild.textContent : t.textContent ); } ).observe( document.getElementById('toast'), { attributes: true, childList: true, characterData: true, subtree: true } ); true`;
const lastToast = c => c.evaluate( "window.__toasts[ window.__toasts.length - 1 ] || ''" );

async function openMail( c, extra = "" )
{
    await nav( c, `${BASE}/nayive/email/index.html${extra}`, "/nayive/email/index.html" );
    const up = await waitFor( c, "document.getElementById('app').style.display !== 'none' && document.querySelectorAll('#list .mail-row').length > 0" );
    await c.evaluate( TOASTS );
    return up;
}
const row = subject => `[...document.querySelectorAll('#list .mail-row')].find( r => r.querySelector('.subj span').textContent === ${JSON.stringify( subject )} )`;

const c = await launch();
try
{
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false } );
    await nav( c, `${BASE}/nayive/login.html`, "/nayive/login.html" );
    await c.evaluate( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        ['launcher','email','chat'].forEach( a => localStorage.setItem('balata-intro-dismiss:' + a, '1') );
        localStorage.setItem('balata-lang','es');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'ana',password:'abc'})}).then(r=>r.status)` );

    console.log( "BOOT" );
    ok( await openMail( c ), "eMail opens with the account's Inbox" );
    await shot( c, "01-inbox" );
    const trays = await c.evaluate( "[...document.querySelectorAll('#trays .mail-tray')].map( b => b.getAttribute('data-tray') + '=' + b.querySelector('.mail-tray-n').textContent )" );
    ok( trays.length === 5 && trays.every( t => /=\d+\/\d+$/.test( t ) ), "every tray shows not read / all", trays );
    const srv = await c.evaluate( "fetch('/api/mail/' + encodeURIComponent( NayiveMail.S.acct ) + '/trays').then( r => r.json() ).then( j => j.trays.find( t => t.role === 'inbox' ) )" );
    ok( trays.includes( `inbox=${srv.unread}/${srv.total}` ) && srv.total > 0, "the Inbox's numbers are the server's", { trays, srv } );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: true } );
    await sleep( 300 );
    ok( await c.evaluate( "document.documentElement.scrollWidth <= innerWidth" ), "phone: the trays fit (no side scroll)" );
    await shot( c, "01b-trays-phone" );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false } );

    // -----------------------------------------------------------------------
    console.log( "THE CLIP (Chat's panel)" );
    await c.evaluate( "document.getElementById('composeBtn').click(); true" );
    await waitFor( c, "!document.getElementById('composeView').hidden" );
    ok( await c.evaluate( "!document.getElementById('cDrive')" ), "no folder button any more" );
    ok( await c.evaluate( "document.getElementById('cTo').placeholder === 'Una o más direcciones, separadas por comas'" ), "To says more than one address fits",
        await c.evaluate( "document.getElementById('cTo').placeholder" ) );
    ok( await c.evaluate( "document.getElementById('cAttach').title === 'Adjuntar'" ), "the clip's tooltip is 'Adjuntar'",
        await c.evaluate( "document.getElementById('cAttach').title" ) );
    await c.evaluate( "document.getElementById('cAttach').click(); true" );
    const panel = await c.evaluate( `( () => { const p = document.querySelector('.attach.mail-attach'); if( ! p ) return null;
        const b = p.querySelectorAll('.att'), cs = getComputedStyle( p ), ai = getComputedStyle( b[0].querySelector('.ai') );
        const r = p.getBoundingClientRect(), clip = document.getElementById('cAttach').getBoundingClientRect();
        return { n: b.length, labels: [...b].map( x => x.textContent.trim() ), colors: [...b].map( x => getComputedStyle( x.querySelector('.ai') ).backgroundColor ),
                 display: cs.display, cols: cs.gridTemplateColumns.split(' ').length, ai: ai.width + 'x' + ai.height, round: ai.borderRadius,
                 under: r.top >= clip.bottom && r.top - clip.bottom < 20, inside: r.left >= 0 && r.right <= innerWidth }; } )()` );
    ok( panel && panel.n === 3 && panel.labels.join( "|" ) === "Doc. local|Doc. de Nayive|Galería", "the panel: this device, Nayive, gallery", panel );
    ok( panel && panel.display === "grid" && panel.cols === 3 && panel.ai === "54px x 54px".replace( / x /, "x" ) && panel.round === "50%", "Chat's look: 3 columns, round 54px buttons", panel );
    ok( panel && new Set( panel.colors ).size === 3, "each choice its own colour", panel && panel.colors );
    ok( panel && panel.under && panel.inside, "under the clip, on screen", panel );
    await shot( c, "02-clip-panel" );
    await c.evaluate( "document.body.click(); true" );
    ok( await c.evaluate( "!document.querySelector('.attach.mail-attach')" ), "a tap elsewhere closes it" );
    await c.evaluate( "document.getElementById('cAttach').click(); true" );
    await c.send( "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } );
    ok( await c.evaluate( "!document.querySelector('.attach.mail-attach') && !document.getElementById('composeView').hidden" ), "Escape closes it (the writer stays)" );
    // Doc. de Nayive: the file picker, and the file goes on the message
    await c.evaluate( "document.getElementById('cAttach').click(); [...document.querySelectorAll('.attach .att')][1].click(); true" );
    ok( await waitFor( c, "document.querySelector('.sheet-backdrop.open')" ), "Doc. de Nayive opens Nayive's file picker" );
    await shot( c, "03-nayive-picker" );
    await waitFor( c, "[...document.querySelectorAll('.sheet-backdrop.open .fp-row')].some( r => /Docs/.test( r.textContent ) )" );
    await c.evaluate( "[...document.querySelectorAll('.sheet-backdrop.open .fp-row')].find( r => /Docs/.test( r.textContent ) ).click(); true" );
    await waitFor( c, "[...document.querySelectorAll('.sheet-backdrop.open .fp-row')].some( r => /nota\\.txt/.test( r.textContent ) )" );
    await c.evaluate( "[...document.querySelectorAll('.sheet-backdrop.open .fp-row')].find( r => /nota\\.txt/.test( r.textContent ) ).dispatchEvent( new MouseEvent( 'dblclick', { bubbles: true } ) ); true" );
    ok( await waitFor( c, "/nota\\.txt/.test( document.getElementById('cFiles').textContent )", 5000 ), "the Nayive file is on the message",
        await c.evaluate( "document.getElementById('cFiles').textContent + ' | ' + ( document.querySelector('.sheet-backdrop.open') ? document.querySelector('.sheet-backdrop.open').textContent.slice( 0, 200 ) : '' )" ) );
    // Galería: a file input for pictures
    await c.evaluate( `window.__clicked = null; ( () => { const i = document.getElementById('cFileInput'); i.click = function () { window.__clicked = i.accept; }; } )(); true` );
    await c.evaluate( "document.getElementById('cAttach').click(); [...document.querySelectorAll('.attach .att')][2].click(); true" );
    ok( await c.evaluate( "window.__clicked === 'image/*'" ), "Galería asks for pictures" );
    await c.evaluate( "document.getElementById('cAttach').click(); [...document.querySelectorAll('.attach .att')][0].click(); true" );
    ok( await c.evaluate( "window.__clicked === ''" ), "Doc. local asks for any file" );

    // -----------------------------------------------------------------------
    console.log( "WRITING" );
    // #9: a file added while a save is on its way stays (a fresh writer: no
    // files yet, so it saves 4 s after typing)
    await c.evaluate( "document.getElementById('backBtn').click(); true" );
    await waitFor( c, "document.getElementById('composeView').hidden", 8000 );
    await c.evaluate( "document.getElementById('composeBtn').click(); true" );
    await fetch( BASE + "/e2e/draft?slow=2500" );
    await c.evaluate( "var t = document.getElementById('cTo'); t.value = 'bob@example.com'; t.dispatchEvent( new Event('input') ); var s = document.getElementById('cSubject'); s.value = 'Race'; s.dispatchEvent( new Event('input') ); true" );
    ok( await waitFor( c, "/Guardando/.test( document.getElementById('cStatus').textContent )", 8000 ), "a save starts" );
    const { root } = await c.send( "DOM.getDocument", {} ).then( r => r.result );
    const fin = await c.send( "DOM.querySelector", { nodeId: root.nodeId, selector: "#cFileInput" } );
    const upFile = path.join( TMP, "added-during-save.txt" );
    fs.writeFileSync( upFile, "hola\n" );
    await c.evaluate( "delete document.getElementById('cFileInput').click; true" );
    await c.send( "DOM.setFileInputFiles", { nodeId: fin.result.nodeId, files: [ upFile ] } );
    ok( await waitFor( c, "/Borrador guardado/.test( document.getElementById('cStatus').textContent )", 10000 ), "the slow save ends",
        await c.evaluate( "document.getElementById('cStatus').textContent" ) );
    ok( await c.evaluate( "/added-during-save/.test( document.getElementById('cFiles').textContent )" ),
        "a file added during the save is still there", await c.evaluate( "document.getElementById('cFiles').textContent" ) );
    await fetch( BASE + "/e2e/draft?slow=0" );

    // #8: leaving while saves fail keeps the writer
    await fetch( BASE + "/e2e/draft?fail=1" );
    await c.evaluate( TYPE( "<div>Texto que no se pierde</div>" ) );
    await c.evaluate( "document.getElementById('backBtn').click(); true" );
    await sleep( 1500 );
    ok( await c.evaluate( "!document.getElementById('composeView').hidden && " + TEXT + " === 'Texto que no se pierde'" ),
        "a failed save keeps the writer and the text" );
    ok( /No se pudo guardar/.test( await lastToast( c ) ), "and says so", await lastToast( c ) );
    await fetch( BASE + "/e2e/draft?fail=0" );
    await c.evaluate( "document.getElementById('backBtn').click(); true" );
    ok( await waitFor( c, "document.getElementById('composeView').hidden", 8000 ), "with saves working again, ← leaves" );
    ok( /Guardado en Borradores/.test( await lastToast( c ) ), "…saved to Drafts", await lastToast( c ) );

    // #75: Discard, then Undo
    await c.evaluate( "document.getElementById('composeBtn').click(); true" );
    await c.evaluate( TYPE( "<div>Casi lo pierdo</div>" ) );
    await c.evaluate( "document.getElementById('cDiscard').click(); true" );
    ok( await waitFor( c, "document.getElementById('composeView').hidden" ), "Discard leaves at once" );
    ok( await c.evaluate( "!!document.querySelector('#toast .toast-undo')" ), "…with an Undo" );
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    ok( await waitFor( c, "!document.getElementById('composeView').hidden && " + TEXT + " === 'Casi lo pierdo'" ), "Undo brings the text back" );

    // the format bar: bold on the words picked, a list, a link; the placeholder
    await c.evaluate( TYPE( "<div><br></div>" ) );
    ok( await c.evaluate( "document.querySelector('.mail-cbox').classList.contains('is-empty')" ), "empty: the placeholder shows" );
    await shot( c, "02a-placeholder" );
    await c.evaluate( TYPE( "<div>Hola negrita</div><div>uno</div>" ) );
    ok( await c.evaluate( "!document.querySelector('.mail-cbox').classList.contains('is-empty')" ), "with words, no placeholder" );
    await c.evaluate( `( async () => { const t = document.getElementById('cText'); t.focus();
        const n = t.firstChild.firstChild, r = document.createRange(); r.setStart( n, 5 ); r.setEnd( n, 12 );
        const s = getSelection(); s.removeAllRanges(); s.addRange( r );
        await new Promise( r => setTimeout( r, 80 ) );
        document.getElementById('fBold').click();
        await new Promise( r => setTimeout( r, 80 ) );
        const n2 = t.children[ 1 ].firstChild, r2 = document.createRange(); r2.setStart( n2, 1 ); r2.collapse( true );
        s.removeAllRanges(); s.addRange( r2 );
        await new Promise( r => setTimeout( r, 80 ) );
        document.getElementById('fBullet').click();
        await new Promise( r => setTimeout( r, 80 ) ); } )()` );
    const fmt = await c.evaluate( "document.getElementById('cText').innerHTML" );
    ok( /<b>negrita<\/b>/.test( fmt ) && /<ul><li>uno/.test( fmt ), "Bold and the list button format the text", fmt );
    ok( await c.evaluate( "document.getElementById('fBullet').classList.contains('is-active')" ), "…the list button lit in the list" );
    ok( await c.evaluate( TEXT ) === "Hola negrita\n- uno", "…the plain text has the list as '- '", await c.evaluate( TEXT ) );
    await c.evaluate( `( async () => { const t = document.getElementById('cText'); t.focus();
        const n = t.querySelector('b').firstChild, r = document.createRange(); r.setStart( n, 0 ); r.setEnd( n, n.length );
        const s = getSelection(); s.removeAllRanges(); s.addRange( r );
        await new Promise( r => setTimeout( r, 80 ) );
        document.getElementById('fLink').click();
        await new Promise( r => setTimeout( r, 150 ) );
        document.getElementById('linkHref').value = 'x.es';
        document.getElementById('linkOkBtn').click();
        await new Promise( r => setTimeout( r, 150 ) ); } )()` );
    const lnk = await c.evaluate( "document.getElementById('cText').innerHTML" );
    ok( /<a href="https:\/\/x\.es">negrita<\/a>/.test( lnk ), "the link sheet links the words picked", lnk );
    ok( await c.evaluate( TEXT ) === "Hola negrita <https://x.es>\n- uno", "…its address after them in plain text", await c.evaluate( TEXT ) );
    await shot( c, "02b-format-bar" );

    // send, with Bcc: fresh Message-ID, no Bcc on the wire. The send waits for
    // its Undo (6 s): Undo first brings the writer back with nothing sent.
    const sentBefore = ( await get( "/e2e/sent" ) || [] ).length;
    await c.evaluate( `document.getElementById('cCcBtn').click();
        var set = ( id, v ) => { var e = document.getElementById( id ); e.value = v; e.dispatchEvent( new Event('input') ); };
        set( 'cTo', '"Pérez, Ana" <perez@example.com>' ); set( 'cBcc', 'carol@example.com' ); set( 'cSubject', 'Hola' );
        document.getElementById('cSend').click(); true` );
    ok( await waitFor( c, "document.getElementById('composeView').hidden && document.querySelector('#toast .toast-undo')", 10000 ), "Send leaves at once, with an Undo" );
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    ok( await waitFor( c, "!document.getElementById('composeView').hidden && document.getElementById('cBcc').value === 'carol@example.com'" ), "Undo: the writer is back, all fields" );
    await sleep( 7000 );
    ok( ( await get( "/e2e/sent" ) || [] ).length === sentBefore, "…and nothing was sent" );
    await c.evaluate( "document.getElementById('cSend').click(); true" );
    ok( await waitFor( c, "document.getElementById('composeView').hidden && document.querySelector('#toast .toast-undo')", 10000 ), "sent (Undo on show)" );
    await c.evaluate( "NayiveUI.undoSettle(); true" );
    let out = false;
    for( let i = 0; i < 100 && ! out; i++ ) { out = ( await get( "/e2e/sent" ) || [] ).length > sentBefore; if( ! out ) await sleep( 100 ); }
    ok( out, "no Undo: it goes out" );
    const sent = await get( "/e2e/sent" );
    const last = sent && sent[ sent.length - 1 ];
    ok( last && last.rcpts.includes( "carol@example.com" ) && last.rcpts.includes( "perez@example.com" ) && ! /\nBcc:/i.test( last.raw ), "Bcc gets it, and is not in the mail", last && last.rcpts );
    const body = last ? last.raw.replace( /=\r?\n/g, "" ) : "";
    ok( /multipart\/alternative/.test( body ) && /<b><a href=3D"https:\/\/x\.es">negrita<\/a><\/b>/.test( body ) && /\n- uno/.test( body ), "it goes as HTML and plain text", body.slice( -900 ) );

    // -----------------------------------------------------------------------
    console.log( "READING: the frame" );
    await c.evaluate( row( "Pictures" ) + ".click(); true" );
    ok( await waitFor( c, "document.querySelector('#readBody iframe')" ), "the HTML message opens in a frame" );
    const fr = await c.evaluate( "( () => { const f = document.querySelector('#readBody iframe'); return { sandbox: f.getAttribute('sandbox'), h: f.style.height }; } )()" );
    ok( fr.sandbox === "allow-scripts allow-popups allow-popups-to-escape-sandbox", "sandboxed without allow-same-origin", fr );
    ok( await waitFor( c, "parseInt( document.querySelector('#readBody iframe').style.height ) > 300", 5000 ), "the frame sizes itself (its script's message)",
        await c.evaluate( "document.querySelector('#readBody iframe').style.height" ) );
    ok( await c.evaluate( "/src=\"data:image\\/png;base64/.test( document.querySelector('#readBody iframe').srcdoc )" ), "its own picture (cid:) comes in as data:" );
    ok( await c.evaluate( "/url\\(&quot;data:image\\/png;base64/.test( document.querySelector('#readBody iframe').srcdoc )" ), "…in a style's url() too",
        await c.evaluate( "( document.querySelector('#readBody iframe').srcdoc.match( /id=\"bg\"[^>]*/ ) || [''] )[0].slice( 0, 160 )" ) );
    ok( await c.evaluate( "!document.getElementById('imagesBar') && !document.getElementById('imagesBtn').hidden" ), "no 'pictures are hidden' bar: the toolbar's button shows" );
    // the head: subject, chevron, labels; From/To/Date folded away
    const head = await c.evaluate( `( () => { const s = document.getElementById('readSubject').getClientRects(), b = document.getElementById('metaBtn').getBoundingClientRect();
        const last = s[ s.length - 1 ];
        return { meta: document.getElementById('readMeta').hidden, exp: document.getElementById('metaBtn').getAttribute('aria-expanded'),
                 beside: b.left >= last.right - 1 && b.left - last.right < 16 && b.top < last.bottom && b.bottom > last.top }; } )()` );
    ok( head.meta && head.exp === "false", "From/To/Date start folded", head );
    ok( head.beside, "the chevron sits right after the subject", head );
    await shot( c, "04a-head-closed" );
    // a phone, a long subject and a label: the chevron still after the last word
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: true } );
    await c.evaluate( `document.getElementById('readSubject').textContent = 'A rather long subject line that has to wrap over two or three lines on a phone';
        NayiveMail.S.labels = ( NayiveMail.S.labels || [] ).concat( [ { id: 'lt', name: 'Trabajo', color: 'blue' } ] ); NayiveMail.renderReadLabels( [ 'lt' ] ); true` );
    await sleep( 300 );
    const phone = await c.evaluate( `( () => { const s = document.getElementById('readSubject').getClientRects(), b = document.getElementById('metaBtn').getBoundingClientRect();
        const last = s[ s.length - 1 ], l = document.getElementById('readLabels');
        return { lines: s.length, beside: b.left >= last.right - 1 && b.left - last.right < 16 && b.top < last.bottom && b.bottom > last.top,
                 label: !l.hidden && l.textContent, fits: document.documentElement.scrollWidth <= innerWidth }; } )()` );
    ok( phone.lines > 1 && phone.beside && phone.fits, "phone, long subject: chevron after the last word, no side scroll", phone );
    await shot( c, "04b-head-phone" );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false } );
    await c.evaluate( "document.getElementById('metaBtn').click(); true" );
    await sleep( 400 );
    ok( await c.evaluate( "!document.getElementById('readMeta').hidden && document.querySelectorAll('#readMeta dt').length >= 3 && document.getElementById('metaBtn').classList.contains('open')" ), "the chevron shows them" );
    await shot( c, "04a-head-open" );
    await c.evaluate( "document.getElementById('readSubject').click(); true" );
    ok( await c.evaluate( "document.getElementById('readMeta').hidden && document.getElementById('metaBtn').getAttribute('aria-expanded') === 'false'" ), "the subject folds them again" );
    await sleep( 800 );
    let hits = await get( "/e2e/hits" );
    ok( ( hits || [] ).length === 0, "pictures hidden: nothing loads", hits );
    await c.evaluate( "document.getElementById('imagesBtn').click(); true" );
    await sleep( 1500 );
    hits = await get( "/e2e/hits" ) || [];
    ok( hits.every( h => ! h.cookie ), "shown: whatever loads carries NO session cookie", hits );
    ok( await c.evaluate( "fetch('/api/whoami').then( r => r.status )" ) === 200, "…and the reader is still signed in" );
    ok( await c.evaluate( "( b => !b.hidden && b.classList.contains('is-active') && b.title === 'Ocultar imágenes' )( document.getElementById('imagesBtn') )" ),
        "the picture button stays, now to hide them", await c.evaluate( "document.getElementById('imagesBtn').title" ) );
    await shot( c, "04-pictures" );
    await c.evaluate( "document.getElementById('imagesBtn').click(); true" );
    ok( await waitFor( c, "/img-src data:;/.test( document.querySelector('#readBody iframe').srcdoc ) && document.getElementById('imagesBtn').title === 'Mostrar imágenes'", 5000 ),
        "pressed again: hidden again" );
    // a link opens a new tab: the frame is another origin (its own target):
    // the link's box from inside it, the click on the page, where it is drawn
    const before = ( await ( await fetch( `http://127.0.0.1:${c.port}/json` ) ).json() ).length;
    const srcdoc = ( await ( await fetch( `http://127.0.0.1:${c.port}/json` ) ).json() ).find( t => t.url === "about:srcdoc" );
    let link = null;
    if( srcdoc )
    {
        const fc = await attach( srcdoc.webSocketDebuggerUrl );
        link = await fc.evaluate( "( () => { const r = document.getElementById('out').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; } )()" );
    }
    else
    {
        // the same process: the page reaches it
        link = await c.evaluate( "( () => { const d = document.querySelector('#readBody iframe').contentDocument; if( ! d ) return null; const r = d.getElementById('out').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; } )()" );
    }
    if( link )
    {
        const off = await c.evaluate( "( () => { const r = document.querySelector('#readBody iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; } )()" );
        const x = off.x + link.x, y = off.y + link.y;
        await c.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x, y } );
        await c.send( "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 } );
        await c.send( "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 } );
        await sleep( 1200 );
    }
    const tabs = await ( await fetch( `http://127.0.0.1:${c.port}/json` ) ).json();
    ok( !! link && tabs.length > before && tabs.some( t => /example\.org/.test( t.url ) ), "a link opens in a new tab", { link, urls: tabs.map( t => t.url ) } );
    await c.evaluate( "document.getElementById('backBtn').click(); true" );

    // -----------------------------------------------------------------------
    console.log( "READING: files" );
    await c.evaluate( row( "With a file" ) + ".click(); true" );
    ok( await waitFor( c, "document.querySelector('#readParts .mail-part-line')" ), "the file shows" );
    const size = await c.evaluate( "document.querySelector('#readParts small').textContent" );
    ok( /^\d+\s*B/.test( size ) && parseInt( size ) >= 25 && parseInt( size ) <= 45, "its size is the file's own (not the base64's)", size );
    await c.evaluate( "window.__toasts = []; document.querySelector('#readParts .mail-part-line .icon-btn').click(); true" );
    ok( await waitFor( c, "document.querySelector('.sheet-backdrop.open .fp-row')" ), "Save to Nayive asks for a folder" );
    await c.evaluate( "document.querySelector('.sheet-backdrop.open .fp-row').click(); true" );     // the root: Archivos
    await waitFor( c, "! document.querySelector('.sheet-backdrop.open .btn-primary').disabled" );
    await c.evaluate( "document.querySelector('.sheet-backdrop.open .btn-primary').click(); true" );
    ok( await waitFor( c, "window.__toasts.some( t => /^Guardado en (?!Borradores)/.test( t ) )", 8000 ), "saved in Nayive", await lastToast( c ) );
    const saved = ( await c.evaluate( "window.__toasts.filter( t => /^Guardado en (?!Borradores)/.test( t ) ).pop()" ) ).replace( /^Guardado en /, "" );
    const folder = saved === "Carpeta Archivos" ? "files" : "files/" + saved;
    const tree = await c.evaluate( `fetch('/api/files?dir=' + encodeURIComponent( ${JSON.stringify( folder )} ) ).then( r => r.json() ).then( j => ( j.nodes || [] ).map( n => n.path.split('/').pop() ) )` );
    ok( tree.includes( "informe.pdf" ), "the file is in the folder (" + folder + ")", tree );
    await c.evaluate( "document.getElementById('backBtn').click(); true" );

    // -----------------------------------------------------------------------
    console.log( "PICKING" );
    await c.evaluate( "document.getElementById('selectBtn').click(); true" );
    ok( await c.evaluate( "!document.getElementById('actAll').hidden" ), "select-all shows while picking" );
    await c.evaluate( "document.getElementById('actAll').click(); document.getElementById('pickAllBtn').click(); true" );
    ok( await c.evaluate( "document.querySelectorAll('#list .mail-row.is-picked').length === document.querySelectorAll('#list .mail-row').length" ), "every row ticked" );
    await c.evaluate( "document.getElementById('actAll').click(); document.getElementById('pickAllBtn').click(); true" );
    ok( await c.evaluate( "document.querySelectorAll('#list .mail-row.is-picked').length === 0" ), "again: none" );
    await c.evaluate( "document.getElementById('backBtn').click(); true" );

    // delete for good, with Undo
    await c.evaluate( `document.getElementById('selectBtn').click(); ${row( "Hello 8" )}.click(); document.getElementById('actDelete').click(); true` );
    await sleep( 800 );
    await c.evaluate( "document.querySelector('[data-tray=trash]').click(); true" );
    await waitFor( c, row( "Hello 8" ) );
    await c.evaluate( `document.getElementById('selectBtn').click(); ${row( "Hello 8" )}.click(); document.getElementById('actForget').click(); true` );
    ok( await c.evaluate( "!" + row( "Hello 8" ) ), "delete for good: the row goes at once" );
    ok( await c.evaluate( "!!document.querySelector('#toast .toast-undo')" ), "…with an Undo" );
    await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
    ok( await waitFor( c, row( "Hello 8" ), 5000 ), "Undo: it is back" );
    await c.evaluate( `document.getElementById('selectBtn').click(); ${row( "Hello 8" )}.click(); document.getElementById('actForget').click(); true` );
    await sleep( 7500 );
    await c.evaluate( "document.querySelector('[data-tray=trash]').click(); true" );
    await sleep( 1200 );
    ok( await c.evaluate( "!" + row( "Hello 8" ) ), "no Undo: deleted for good" );
    await c.evaluate( "document.querySelector('[data-tray=inbox]').click(); true" );

    // -----------------------------------------------------------------------
    console.log( "SETTINGS" );
    await c.evaluate( "document.getElementById('setBtn').click(); true" );
    await waitFor( c, "document.getElementById('setSheet').classList.contains('open')" );
    ok( await c.evaluate( "document.querySelectorAll('#acctList .card-row .icon-btn').length === 2" ), "each account: a key and a bin" );
    await c.evaluate( "document.querySelector('#acctList .card-row .icon-btn').click(); document.querySelector('.mail-newpass input').value = 'wrong'; document.querySelector('.mail-newpass .text-btn').click(); true" );
    ok( await waitFor( c, "!document.querySelector('.mail-newpass .field-error').hidden", 8000 ), "a wrong new password is refused",
        await c.evaluate( "document.querySelector('.mail-newpass .field-error').textContent" ) );
    await c.evaluate( "document.querySelector('.mail-newpass input').value = 'abcdefghijklmnop'; document.querySelector('.mail-newpass .text-btn').click(); true" );
    ok( await waitFor( c, "window.__toasts.some( t => /Contraseña cambiada/.test( t ) )", 8000 ), "the right one is kept", await lastToast( c ) );
    await shot( c, "05-settings" );
    const pick = v => c.evaluate( `( () => { const s = document.getElementById('imagesDefault'); s.value = '${v}'; s.dispatchEvent( new Event('change') ); return true; } )()` );
    await c.evaluate( "document.querySelector('#setSheet [data-tab=general]').click(); true" );
    ok( await c.evaluate( "document.getElementById('imagesDefault').value === 'hide' && /no sabe/.test( document.getElementById('imagesHint').textContent )" ),
        "pictures: Hidden, and why", await c.evaluate( "document.getElementById('imagesHint').textContent" ) );
    await pick( "show" );
    await sleep( 600 );
    ok( ( await c.evaluate( "fetch('/api/mail/settings').then( r => r.json() )" ) ).showImages === true, "'Shown' is saved" );
    ok( await c.evaluate( "/puede saber/.test( document.getElementById('imagesHint').textContent )" ), "…and its hint says what it means" );
    await pick( "hide" );
    await sleep( 400 );
    await c.evaluate( "var x = document.getElementById('signature'); x.value = 'Ana  \\nTel 1\\n'; x.dispatchEvent( new Event('input') ); true" );
    await shot( c, "05a-general" );
    await sleep( 1400 );
    const st = await c.evaluate( "fetch('/api/mail/settings').then( r => r.json() )" );
    ok( st.signature === "Ana\nTel 1" && st.showImages === false, "the signature is saved (cleaned)", st );
    await c.evaluate( "NayiveUI.close('setSheet'); true" );

    // -----------------------------------------------------------------------
    console.log( "SIGNATURE" );
    await c.evaluate( "window.__toasts = []; document.getElementById('composeBtn').click(); true" );
    await waitFor( c, "!document.getElementById('composeView').hidden" );
    ok( await c.evaluate( TEXT ) === "\n\n-- \nAna\nTel 1", "a new message has it, under a '-- ' line", await c.evaluate( TEXT ) );
    await c.evaluate( "var t = document.getElementById('cTo'); t.value = 'x'; t.dispatchEvent( new Event('input') ); t.value = ''; t.dispatchEvent( new Event('input') ); document.getElementById('backBtn').click(); true" );
    ok( await waitFor( c, "document.getElementById('composeView').hidden", 5000 ), "only the signature: ← leaves" );
    await sleep( 800 );
    ok( ! ( await c.evaluate( "window.__toasts.join('|')" ) ).includes( "Borradores" ), "…and keeps no draft", await c.evaluate( "window.__toasts" ) );
    await c.evaluate( row( "Pictures" ) + ".click(); true" );
    await waitFor( c, "document.querySelector('#readBody iframe')" );
    await c.evaluate( "document.getElementById('actReply').click(); true" );
    await waitFor( c, "!document.getElementById('composeView').hidden" );
    const rtext = await c.evaluate( TEXT );
    ok( /^\n\n-- \nAna\nTel 1\n\n.*\n> /.test( rtext ), "a reply: the signature above the quote", rtext.slice( 0, 120 ) );
    const AT = "( () => { const s = getSelection(); if( ! s.rangeCount ) return -1; const r = document.createRange(); r.setStart( document.getElementById('cText'), 0 ); r.setEnd( s.anchorNode, s.anchorOffset ); return r.toString().length; } )()";
    ok( await waitFor( c, "document.activeElement.id === 'cText' && " + AT + " === 0", 3000 ), "…the caret over it",
        await c.evaluate( "document.activeElement.id + ' ' + " + AT ) );
    await c.evaluate( "document.getElementById('cDiscard').click(); true" );
    await waitFor( c, "document.getElementById('composeView').hidden" );
    await c.evaluate( "NayiveUI.undoSettle(); true" );
    await c.evaluate( "fetch('/api/mail/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({signature:''})}).then( r => r.status )" );

    // -----------------------------------------------------------------------
    console.log( "ADVANCED SEARCH (the funnel in the search box)" );
    await openMail( c );
    const SUBJS = "[...document.querySelectorAll('#list .mail-row .subj span')].map( s => s.textContent )";
    const ROWS = "document.querySelectorAll('#list .mail-row').length";
    const all = await c.evaluate( ROWS );
    const idle = () => waitFor( c, "!NayiveMail.S.loading", 8000 );
    await c.evaluate( "document.getElementById('searchBtn').click(); true" );
    ok( await c.evaluate( "document.getElementById('searchWrap').classList.contains('is-open') && !!document.querySelector('#searchWrap .search-ends button.search-mark') && !document.querySelector('#searchWrap span.search-mark')" ),
        "the magnifier opens the box: a funnel inside, no dead magnifier" );
    await c.evaluate( "document.querySelector('#searchWrap .search-mark').click(); true" );
    ok( await waitFor( c, "document.getElementById('advSheet').classList.contains('open')", 3000 ), "the funnel opens the dialog" );
    await c.evaluate( "document.getElementById('advFrom').value = 'bob'; document.getElementById('advAttach').checked = true; document.getElementById('advGoBtn').click(); true" );
    await sleep( 300 ); await idle();
    ok( JSON.stringify( await c.evaluate( SUBJS ) ) === JSON.stringify( [ "With a file" ] ), "From bob + attachments: the one mail", await c.evaluate( SUBJS ) );
    ok( await c.evaluate( "!document.getElementById('advBar').hidden && /bob/.test( document.getElementById('advBarText').textContent ) && document.getElementById('searchWrap').classList.contains('filter-on')" ),
        "the bar says what is asked; the funnel is lit" );
    await c.evaluate( "NayiveMail.openAdvSearch(); document.getElementById('advClearBtn').click(); const d = document.getElementById('advSince'); d.value = '2026-09-02'; d.dispatchEvent( new Event('input') ); document.getElementById('advGoBtn').click(); true" );
    await sleep( 300 ); await idle();
    const since = await c.evaluate( SUBJS );
    ok( since.includes( "With a file" ) && since.includes( "Pictures" ) && ! since.some( s => /^Hello/.test( s ) ), "Since 2026-09-02: only the newer mails", since );
    ok( await c.evaluate( "document.querySelector('#advSince + .dt-display').textContent === '2026-09-02'" ), "the date shows as yyyy-mm-dd" );
    await c.evaluate( "NayiveMail.openAdvSearch(); document.getElementById('advClearBtn').click(); document.getElementById('advFrom').value = 'eve'; document.getElementById('advWords').value = 'file'; document.getElementById('advGoBtn').click(); true" );
    await sleep( 300 ); await idle();
    ok( await c.evaluate( ROWS ) === 0 && await c.evaluate( "!document.getElementById('listEmpty').hidden && document.getElementById('searchInput').value === 'file'" ),
        "From eve + the word file: nothing, and the word is in the box" );
    await c.evaluate( "document.getElementById('advOffBtn').click(); true" );
    await sleep( 300 ); await idle();
    ok( await c.evaluate( "document.getElementById('advBar').hidden && document.getElementById('searchInput').value === 'file' && !document.getElementById('searchWrap').classList.contains('filter-on')" ),
        "Remove filters: the fields go, the word stays" );
    await c.evaluate( "document.querySelector('#searchWrap .search-shut').click(); true" );
    await sleep( 300 ); await idle();
    ok( await c.evaluate( ROWS ) === all && await c.evaluate( "!document.getElementById('searchWrap').classList.contains('is-open') && NayiveMail.S.query === '' && !NayiveMail.S.adv" ),
        "the × folds the box and the whole tray is back", await c.evaluate( ROWS ) );
    await shot( c, "20-adv-search" );

    // -----------------------------------------------------------------------
    // A desktop window (html.is-windowed: the top page is under /nayive/desktop/)
    // wide enough: the open message on the right of the list (read.js, SPLIT).
    console.log( "SPLIT (desktop window, wide)" );
    await c.send( "Page.bringToFront" );          // a tab in the back draws nothing: no resize events
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false } );
    await nav( c, `${BASE}/nayive/manifest.json`, "/nayive/manifest.json" );
    await c.evaluate( `history.replaceState( null, '', '/nayive/desktop/split-host.html' );
        document.body.innerHTML = '<iframe id="f" src="/nayive/email/index.html" style="border:0;width:1300px;height:800px"></iframe>'; true` );
    const W = "document.getElementById('f').contentWindow", D = W + ".document", $ = id => `${D}.getElementById('${id}')`;
    const FROWS = `${D}.querySelectorAll('#list .mail-row')`;
    await waitFor( c, `${W}.NayiveMail && ${FROWS}.length > 1` );
    ok( await c.evaluate( `${D}.documentElement.classList.contains('is-windowed') && ${D}.body.classList.contains('split')` ), "a wide desktop window splits" );
    ok( await c.evaluate( `!${$( "readPane" )}.hidden && !${$( "readNone" )}.hidden && ${$( "readView" )}.parentNode.id === 'readPane'` ), "the right side waits, empty" );
    await c.evaluate( `${FROWS}[0].click(); true` );
    await waitFor( c, `!${$( "readView" )}.hidden && ${W}.NayiveMail.S.msg` );
    const sp = await c.evaluate( `( () => { const d = ${D}, g = id => d.getElementById( id );
        const L = g('listView').getBoundingClientRect(), R = g('readView').getBoundingClientRect();
        return { list: !g('listView').hidden, side: R.left >= L.right, cur: d.querySelectorAll('#list .mail-row.is-current').length,
                 first: d.querySelectorAll('#list .mail-row')[0].classList.contains('is-current'), back: g('backBtn').hidden,
                 tools: !g('composeBtn').hidden && getComputedStyle( g('listTools') ).display !== 'none', acts: !g('actions').hidden && !g('actReply').hidden,
                 reading: d.body.classList.contains('reading'), hist: ${W}.history.state }; } )()` );
    ok( sp.list && sp.side, "the message shows on the right of the list", sp );
    ok( sp.cur === 1 && sp.first, "its row is marked", sp );
    ok( sp.back && sp.tools && sp.acts && ! sp.reading, "no ←; the list's tools and the message's actions both there", sp );
    ok( ! ( sp.hist && sp.hist.mailRead ), "no history entry", sp.hist );
    await shot( c, "21-split" );
    const subj1 = await c.evaluate( `${$( "readSubject" )}.textContent` );
    await c.evaluate( `${FROWS}[1].click(); true` );
    await waitFor( c, `${$( "readSubject" )}.textContent !== ${JSON.stringify( subj1 )} && ${W}.NayiveMail.S.msg` );
    ok( await c.evaluate( `${FROWS}[1].classList.contains('is-current') && ${D}.querySelectorAll('#list .mail-row.is-current').length === 1` ), "another row: the mark follows" );
    await c.evaluate( `document.getElementById('f').style.width = '900px'; true` );
    await waitFor( c, `!${D}.body.classList.contains('split')`, 3000 );
    const nar = await c.evaluate( `( () => { const d = ${D}, g = id => d.getElementById( id );
        return { split: d.body.classList.contains('split'), inMain: g('readView').parentNode.classList.contains('mail-main'),
                 list: g('listView').hidden, back: !g('backBtn').hidden, reading: d.body.classList.contains('reading'), pane: g('readPane').hidden }; } )()` );
    ok( ! nar.split && nar.inMain && nar.list && nar.back && nar.reading && nar.pane, "narrowed: the message over the list, with ←", nar );
    await c.evaluate( `document.getElementById('f').style.width = '1300px'; true` );
    await waitFor( c, `${D}.body.classList.contains('split')`, 3000 );
    ok( await c.evaluate( `${D}.body.classList.contains('split') && !${$( "listView" )}.hidden && ${$( "readView" )}.parentNode.id === 'readPane' && !${$( "readView" )}.hidden` ),
        "wide again: side by side, still open" );
    // opened side by side (no history entry), then narrowed: Reply and back
    // must not leave the page (the writer takes no entry it does not own)
    await c.evaluate( `document.getElementById('f').style.width = '900px'; true` );
    await waitFor( c, `!${D}.body.classList.contains('split')`, 3000 );
    await c.evaluate( `${$( "actReply" )}.click(); true` );
    await waitFor( c, `!${$( "composeView" )}.hidden` );
    await c.evaluate( `${$( "backBtn" )}.click(); true` );
    await sleep( 800 );
    ok( await c.evaluate( `location.pathname === '/nayive/desktop/split-host.html' && ${W}.location.pathname === '/nayive/email/index.html' && ${$( "composeView" )}.hidden` ),
        "narrowed, Reply then ←: still in eMail" );
    await c.evaluate( `document.getElementById('f').style.width = '1300px'; true` );
    await waitFor( c, `${D}.body.classList.contains('split')`, 3000 );
    await c.evaluate( `${$( "composeBtn" )}.click(); true` );
    await waitFor( c, `!${$( "composeView" )}.hidden` );
    ok( await c.evaluate( `getComputedStyle( ${$( "readPane" )} ).display === 'none' && ${$( "composeView" )}.getBoundingClientRect().width > 700` ), "writing takes the whole width" );
    await c.evaluate( `${$( "backBtn" )}.click(); true` );
    await waitFor( c, `${$( "composeView" )}.hidden` );
    ok( await c.evaluate( `!${$( "readNone" )}.hidden && ${D}.querySelectorAll('#list .mail-row.is-current').length === 0` ), "back from writing: the right side empty" );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false } );

    // -----------------------------------------------------------------------
    console.log( "START WITHOUT THE SERVER" );
    await c.send( "Network.setBlockedURLs", { urls: [ "*/api/mail/accounts*" ] } );
    await nav( c, `${BASE}/nayive/email/index.html`, "/nayive/email/index.html" );
    await sleep( 1500 );
    ok( await c.evaluate( "document.getElementById('side').hidden && document.getElementById('listView').hidden" ), "no answer at start: nothing shown yet" );
    await c.send( "Network.setBlockedURLs", { urls: [] } );
    await c.evaluate( "document.getElementById('syncIndicator').click(); true" );
    ok( await waitFor( c, "!document.getElementById('side').hidden && document.querySelectorAll('#list .mail-row').length > 0", 8000 ), "the plug then opens the page for real" );

    // -----------------------------------------------------------------------
    console.log( "SIGN OUT (POST)" );
    ok( ( await fetch( BASE + "/api/logout", { redirect: "manual" } ) ).status === 303, "GET /api/logout no longer signs out (it goes to the launcher)" );
    // a phone: a big screen with a mouse opens the desktop instead
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: true } );
    await nav( c, `${BASE}/nayive/index.html`, "/nayive/index.html" );
    await waitFor( c, "document.getElementById('logoutBtn')" );
    await c.evaluate( "document.getElementById('logoutBtn').click(); true" );
    ok( await waitFor( c, "location.pathname === '/nayive/login.html'", 8000 ), "the launcher's sign-out lands on the login page" );
    ok( await c.evaluate( "fetch('/api/whoami').then( r => r.status )" ) === 401, "…signed out" );

    const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
    ok( errs.length === 0, "no script errors", errs );
}
catch( e ) { fail++; console.log( "  FAIL (threw) " + ( e && e.stack || e ) ); }
finally
{
    c.kill();
    cleanup();
    console.log( `\n${pass} passed, ${fail} failed. Screenshots: ${SHOTS}` );
    setTimeout( () => process.exit( fail ? 1 : 0 ), 2000 );
}
