// run.mjs - Ayni's fields family in Nayive (text, password, number, date and
// time fields, sliders, errors, hints), in a real (headless) browser: the
// rules on every page, then what moving onto Ayni changed.
//
//   node tools/fields-test/run.mjs            (SHOTS=/some/dir also saves screenshots)
//
// Same scratch server as tools/dialogs-test (its own run-root in /tmp, a copy
// of client/apps, a user "test"); the real store/ is never touched. It saves a
// Calendar event and a contact there.
//
// RULES, every app, phone and desktop width (every dialog of the page opened in
//   turn): Ayni's fields family is loaded; no old field markup or API
//   (.dt-field, .dt-display, .pw-eye, .pw-wrap, .field-error, .field-edit,
//   .tb-input, .tb-num, [data-eye], NayiveUI.pwEye); every text, password and
//   text area field is an Ayni .input (but the few own boxes: an editor, the
//   translator's pane, the image note, Chat's composer); no browser date or time
//   box; every number box is an Ayni .spin with its − and + (Desktop's calendar
//   year waits for the desktop family); every show-password button has its eye
//   and name; no grey hint line under a field; fields 32 px tall (44 on a touch
//   phone); nothing collapsed to 0 px; no error.
// BEHAVIOURS: Calendar's new event (a typed date that is not one is not saved
//   and its field says why; the time popup moves the start and the end with
//   it; a good one saves); Contacts' birthday without a year saved as --MM-DD;
//   the launcher's and the login's password eye; Desktop's countdown boxes
//   inside their dialog and their + steps; Text's margin box steps the margin;
//   Spanish placeholders.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, attach } from "../cdp.mjs";

const HERE = path.dirname( new URL( import.meta.url ).pathname );
const REPO = path.resolve( HERE, "../.." );
const GO   = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const APPS = fs.readdirSync( path.join( REPO, "client/apps" ) )
               .filter( d => fs.existsSync( path.join( REPO, "client/apps", d, "index.html" ) ) ).sort();

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "fields-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
fs.writeFileSync( `${RUN}/homes/test/files/a.txt`, "a" );
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 600 ) ) );
};
const SHOTS = process.env.SHOTS || "";

// Every file under a folder, with its text (to find what an app saved)
const filesUnder = ( dir ) => fs.readdirSync( dir, { withFileTypes: true } ).flatMap( e =>
    e.isDirectory() ? filesUnder( path.join( dir, e.name ) ) : [ path.join( dir, e.name ) ] );

// The rules, read off the page as it stands, every dialog opened in turn.
const RULES = `( async () => { const o = [];
    if( typeof Ayni.dateField !== 'function' || typeof Ayni.timeField !== 'function' || ! document.querySelector( 'link[href*="ayni-fields.css"]' ) ) return [ 'no Ayni fields family' ];
    const OLD = '.dt-field, .dt-display, .pw-eye, .pw-wrap, .field-error, .field-edit, .field-edit-text, .tb-input, .tb-num, [data-eye]';
    if( document.querySelector( OLD ) ) o.push( 'old field markup: ' + document.querySelector( OLD ).outerHTML.slice( 0, 80 ) );
    if( window.NayiveUI && NayiveUI.pwEye ) o.push( 'NayiveUI.pwEye is back' );
    const OWN = '#editor, #src, #editorComment, .htCommentTextArea, .cbox textarea, .handsontable textarea, .handsontableInputHolder textarea, .CodeMirror textarea, .cm-content, .ie textarea, .docx-editor input, .docx-editor textarea';
    const name = ( i ) => i.id || i.className || i.type;
    const look = () =>
    {
        for( const i of document.querySelectorAll( 'input, textarea' ) )
        {
            if( i.closest( OWN ) || i.matches( OWN ) || i.closest( '#ayni-iconset' ) ) continue;
            const t = i.type;
            if( /^(date|time|datetime-local|month|week)$/.test( t ) ) o.push( 'browser date box: ' + name( i ) );
            if( t === 'number' ) o.push( 'number box outside a .spin: ' + name( i ) );
            if( /^(text|password|email|url|tel|search|textarea)$/.test( t ) && ! i.classList.contains( 'input' ) ) o.push( 'not an Ayni .input: ' + name( i ) );
            if( i.checkVisibility() && i.type !== 'hidden' && i.type !== 'file' )
            {
                const r = i.getBoundingClientRect();
                if( ( r.width < 4 || r.height < 4 ) && ! /^fmt(Font|Fill)Color$/.test( i.id ) ) o.push( 'collapsed: ' + name( i ) + ' ' + Math.round( r.width ) + 'x' + Math.round( r.height ) );
            }
        }
        for( const g of document.querySelectorAll( '.spin' ) )
            if( g.querySelectorAll( ':scope > button[data-step]' ).length !== 2 || g.querySelector( '.input' )?.type === 'number' ) o.push( 'a .spin without its − + or still type=number: ' + g.id );
        for( const b of document.querySelectorAll( '[data-reveal]' ) )
            if( ! b.querySelector( 'svg' ) || ! b.getAttribute( 'aria-label' ) || ! b.hasAttribute( 'aria-pressed' ) ) o.push( 'an eye without its icon, name or state: ' + ( b.id || b.closest( '[id]' )?.id ) );
        for( const h of document.querySelectorAll( '.field .hint, .field + p.hint, .field + small.hint' ) ) o.push( 'a hint line under a field: ' + h.textContent.slice( 0, 40 ) );
        for( const i of document.querySelectorAll( '.input:not(textarea):not(.inline)' ) )
        {
            if( ! i.checkVisibility() || i.closest( '[role="toolbar"], .search-field, .input-group' ) ) continue;
            const h = Math.round( i.getBoundingClientRect().height ), want = document.documentElement.classList.contains( 'touch' ) ? 44 : 32;
            if( h !== want && ! i.matches( '.amount-input' ) ) o.push( 'field ' + name( i ) + ' is ' + h + ' px, not ' + want );
        }
    };
    look();
    for( const d of document.querySelectorAll( 'dialog.panel' ) )
    {
        if( d.open || d.classList.contains( 'lock' ) || d.classList.contains( 'lock-dlg' ) ) continue;
        try { d.showModal(); } catch { continue; }
        look();
        d.close();
    }
    return [ ...new Set( o ) ]; } )()`;

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    const size = ( w, h = 800 ) => c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 } );
    const touch = ( on ) => c.send( "Emulation.setEmulatedMedia", { features: [ { name: "pointer", value: on ? "coarse" : "fine" }, { name: "any-pointer", value: on ? "coarse" : "fine" } ] } );
    const ev = ( s ) => c.evaluate( s );
    const until = async ( s, ms = 4000 ) => { for( let t = 0; t < ms; t += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const open = async ( app, w, h, query = "" ) =>
    {
        await size( w, h );
        await c.send( "Page.navigate", { url: BASE + "/nayive/" + ( app ? app + "/" : "" ) + query } );
        await until( "window.Ayni && Ayni.ready && document.readyState === 'complete'", 8000 );
        await ev( "Ayni.ready.then( () => true )" );
        await sleep( app === "write" ? 4000 : 1500 );
    };
    const mouse = async ( type, x, y ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( r => JSON.stringify( [ r.left + r.width / 2, r.top + r.height / 2 ] ) )( document.querySelector( ${JSON.stringify( sel )} ).getBoundingClientRect() )` ) );
    const press = async ( sel ) => { const [ x, y ] = await centre( sel ); await mouse( "mouseMoved", x, y ); await mouse( "mousePressed", x, y ); await mouse( "mouseReleased", x, y ); await sleep( 150 ); };
    const key = async ( k, code, vk ) => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, ...( k === "Enter" && type === "keyDown" ? { text: "\r" } : {} ) } ); await sleep( 80 ); };
    const type = async ( s ) => { await c.send( "Input.insertText", { text: s } ); await sleep( 60 ); };
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        await sleep( 300 );
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    };
    const errors = () => c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]/.test( l ) );
    const btnOf = ( id ) => `#${id} ~ button:not(.err-mark)`;

    await size( 390 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    // The login's eye, before signing in
    await press( "#pwEye" );
    ok( await ev( "document.getElementById('password').type === 'text' && document.getElementById('pwEye').getAttribute('aria-pressed') === 'true' && document.activeElement.id === 'password'" ),
        "login: the eye shows the password and leaves the cursor in it" );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "RULES - every app, phone and desktop" );
    for( const [ w, t ] of [ [ 390, true ], [ 1280, false ] ] )
    {
        await touch( t );
        for( const app of [ "", ...APPS ] )
        {
            if( app === "desktop" && w < 600 ) continue;     // a phone is sent back to the launcher
            c.logs.length = 0;
            await open( app, w );
            if( t ) await ev( "( Ayni.setTouchPreview( true ), true )" );
            const found = await ev( RULES );
            const errs = errors();
            ok( ! found.length && ! errs.length, `${w}px ${app || "launcher"}`, found.concat( errs ) );
        }
    }
    await touch( false );
    await ev( "( Ayni.setTouchPreview( false ), true )" );

    console.log( "BEHAVIOURS" );

    // Calendar: a new event from a click on 09:00 in the day view
    await open( "calendar", 1280, 900 );
    await ev( "( document.querySelector('.topbar [data-view=\"timeGridDay\"]').click(), true )" );      // the phone pass left Month
    const SLOT = 'td.fc-timegrid-slot-lane[data-time="09:00:00"]';
    ok( await until( `!! document.querySelector( ${JSON.stringify( SLOT )} )`, 5000 ), "Calendar: the day view", await ev( "document.querySelector('.fc-view')?.className" ) );
    await ev( `( document.querySelector( ${JSON.stringify( SLOT )} ).scrollIntoView( { block: 'center' } ), true )` );
    await sleep( 300 );
    await press( SLOT );
    const sheetOpen = await until( "document.getElementById('sheetBackdrop').open", 3000 );
    ok( sheetOpen, "Calendar: a click on 09:00 opens the new event" );
    ok( await ev( "/^\\d{4}-\\d{2}-\\d{2}$/.test( document.getElementById('fStartDate').value ) && document.getElementById('fStartTime').value === '09:00' && document.getElementById('fEndTime').value === '09:30'" ),
        "…with Ayni's date and time fields filled (YYYY-MM-DD, 09:00 - 09:30)",
        await ev( "[ 'fStartDate', 'fStartTime', 'fEndDate', 'fEndTime' ].map( i => document.getElementById( i ).value )" ) );
    ok( await ev( "[ 'fStartDate', 'fEndDate' ].every( i => document.getElementById( i ).closest( '.input-group' ).classList.contains( 'date-field' ) ) && [ 'fStartTime', 'fEndTime' ].every( i => document.getElementById( i ).closest( '.input-group' ).classList.contains( 'time-field' ) )" ),
        "…made by Ayni (date-field, time-field)" );
    await ev( "( document.getElementById('moreToggle').click(), true )" );
    await sleep( 200 );
    const day0 = await ev( "document.getElementById('fStartDate').value" );
    await press( btnOf( "fStartTime" ) );
    ok( await until( "!! document.querySelector('.panel.popup:popover-open .time-row')", 2000 ), "the time button opens the hour / minute popup" );
    await press( ".panel.popup:popover-open [data-tstep='h,1']" );
    ok( await ev( "document.getElementById('fStartTime').value === '10:00' && document.getElementById('fEndTime').value === '10:30'" ),
        "an hour later in the popup moves the start, and the end with it (the event keeps its length)",
        await ev( "[ document.getElementById('fStartTime').value, document.getElementById('fEndTime').value ]" ) );
    await key( "Escape", "Escape", 27 );
    await ev( "( document.getElementById('fStartDate').value = '', document.getElementById('fStartDate').focus(), true )" );
    await type( "2026-02-30" );
    await ev( "( document.getElementById('fTitle').focus(), document.getElementById('fTitle').value = '', true )" );
    await type( "Dentist" );
    const before = await ev( "document.querySelectorAll('.fc-event').length" );
    await ev( "( document.getElementById('fStartDate').focus(), true )" );
    await key( "Enter", "Enter", 13 );
    await sleep( 300 );
    ok( await ev( "document.getElementById('sheetBackdrop').open && document.getElementById('fStartDate').getAttribute('aria-invalid') === 'true'" ),
        "a typed 2026-02-30 is not saved: the dialog stays, the field has the red \"!\"" );
    ok( await ev( "document.getElementById('ayni-err')?.matches(':popover-open') && /YYYY-MM-DD/.test( document.getElementById('ayni-err').textContent )" ),
        "…and its message says how to write it" );
    await shot( "calendar-bad-date" );
    await ev( `( document.getElementById('fStartDate').value = ${JSON.stringify( day0 )}, true )` );
    ok( await ev( "document.getElementById('fStartDate').getAttribute('aria-invalid') === 'false'" ), "put right, the \"!\" goes" );
    await ev( "( document.getElementById('fTitle').focus(), true )" );
    await key( "Enter", "Enter", 13 );
    ok( await until( "! document.getElementById('sheetBackdrop').open", 3000 ) && await until( `document.querySelectorAll('.fc-event').length > ${before}`, 4000 ),
        "a good date saves the event" );
    await sleep( 1500 );
    const ics = filesUnder( `${RUN}/homes/test` ).filter( f => f.endsWith( ".ics" ) ).map( f => fs.readFileSync( f, "utf8" ) ).join( "\n" );
    ok( /SUMMARY:Dentist/.test( ics ) && /DTSTART[^\n]*T1000/.test( ics ) && /DTEND[^\n]*T1030/.test( ics ), "…saved at 10:00 - 10:30", ics.slice( 0, 400 ) );

    // Contacts: a birthday without a year
    await open( "contact", 1280, 900, "?new=Ana%20Ruiz" );
    ok( await until( "document.getElementById('editBackdrop').open", 3000 ), "Contacts: a new contact" );
    await ev( "( document.getElementById('moreToggle')?.click(), true )" );
    await sleep( 200 );
    ok( await ev( "document.getElementById('fBday').placeholder === 'YYYY-MM-DD or MM-DD'" ), "the birthday may go without a year (its placeholder says so)" );
    await ev( "( document.getElementById('fBday').focus(), true )" );
    await type( "--05-14" );
    await press( "#editSaveBtn" );
    ok( await until( "! document.getElementById('editBackdrop').open", 3000 ), "…saved" );
    await sleep( 1500 );
    const vcf = filesUnder( `${RUN}/homes/test` ).filter( f => f.endsWith( ".vcf" ) ).map( f => fs.readFileSync( f, "utf8" ) ).join( "\n" );
    ok( /BDAY:--05-14/.test( vcf ) && /Ana/.test( vcf ), "…as BDAY:--05-14 in the file", vcf.slice( 0, 300 ) );

    // The launcher's account: its password eyes
    await open( "", 1280, 900 );
    await ev( "( document.getElementById('pwCurrent').closest('dialog').showModal(), true )" );
    await press( "#pwNew ~ [data-reveal]" );
    ok( await ev( "document.getElementById('pwNew').type === 'text' && document.querySelector('#pwNew ~ [data-reveal]').dataset.tip === 'Hide password'" ),
        "launcher: Change password's eye shows the text, its tooltip says Hide" );
    await ev( "( document.querySelectorAll('dialog[open]').forEach( d => d.close() ), true )" );

    // Desktop: the countdown's three number boxes
    await open( "desktop", 1280, 900 );
    await ev( "( document.querySelector('dialog:has(#cdH)').showModal(), true )" );
    await sleep( 200 );
    ok( await ev( "( () => { const d = document.querySelector('dialog:has(#cdH)').getBoundingClientRect(); return [ 'cdHSpin', 'cdMSpin', 'cdSSpin' ].every( i => { const r = document.getElementById( i ).getBoundingClientRect(); return r.left >= d.left && r.right <= d.right; } ); } )()" ),
        "Desktop: the countdown's hours, minutes and seconds fit in their dialog" );
    await press( "#cdMSpin button[data-step='1']" );
    ok( await ev( "document.getElementById('cdM').value === '1'" ), "…and + steps the minutes", await ev( "document.getElementById('cdM').value" ) );
    await shot( "desktop-countdown" );
    await ev( "( document.querySelectorAll('dialog[open]').forEach( d => d.close() ), true )" );

    // Text: the right margin is a number field in its toolbar
    await open( "text", 1280, 900 );
    const m0 = Number( await ev( "document.getElementById('marginInput').value" ) );
    await press( "#marginInputSpin button[data-step='1']" );
    ok( Number( await ev( "document.getElementById('marginInput').value" ) ) === m0 + 1, "Text: + in the margin box steps the margin", [ m0, await ev( "document.getElementById('marginInput').value" ) ] );

    // In Spanish
    await ev( "( localStorage.setItem( 'ayni-lang', 'es' ), true )" );
    await open( "calendar", 1280, 900 );
    ok( await ev( "document.getElementById('fStartDate').placeholder === 'AAAA-MM-DD' && document.querySelector('" + btnOf( "fStartTime" ) + "').dataset.tip === 'Elegir hora'" ),
        "es: AAAA-MM-DD, Elegir hora", await ev( "[ document.getElementById('fStartDate').placeholder, document.querySelector('" + btnOf( "fStartTime" ) + "')?.dataset.tip ]" ) );
    await ev( "( localStorage.setItem( 'ayni-lang', 'en' ), true )" );
}
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "FAILED" : "ALL GREEN" );
process.exit( fail ? 1 : 0 );
