// run.mjs - Ayni's list picker in Nayive (drop-down lists, filtered lists, combo
// boxes), in a real (headless) browser: the rules on every page, then what
// moving every <select> onto Ayni changed.
//
//   node tools/pickers-test/run.mjs            (SHOTS=/some/dir also saves screenshots;
//                                               ONLY=calc,write runs those sections alone, ONLY=rules
//                                               the rules too; APPS=drive,text limits the rules' apps)
//
// Same scratch server as tools/fields-test (its own run-root in /tmp, a copy of
// client/apps, a user "test"); the real store/ is never touched. It saves a
// Calendar event, a contact, a Split group and the account's time zone there.
//
// RULES, every app, phone and desktop width (every dialog of the page opened in
//   turn): Ayni's pickers family is loaded; no <select>, <datalist> or
//   .tb-select; every list picker Ayni has made has its field (role combobox)
//   with a name, 32 px tall (44 on a touch phone, 30 in a toolbar, where it has
//   no fill), and its "nothing matches" line in words; no error.
// BEHAVIOURS: Calendar's new event with a weekly repeat and a time zone typed in
//   the filtered list, saved in the .ics; the launcher's time zone typed in the
//   filtered list and saved on the account (and the list as a sheet on a phone);
//   Calculator's currency filtered list (the code when closed); Split's currency
//   with headings and the short code, saved with the group; Contacts' phone type;
//   Desktop's ⋮ menu row (a pick leaves the menu open, the bar moves); Text's
//   language (Markdown lights the preview) and Save as's format renaming the
//   file; Calc's number format (the same category reopens its dialog) and its
//   font size box refusing a non-size; Write's toolbar font list (the document
//   keeps the focus) and size box; Drive's rule condition; Spanish.
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

const APPS = process.env.APPS ? process.env.APPS.split( "," ) : fs.readdirSync( path.join( REPO, "client/apps" ) )
               .filter( d => fs.existsSync( path.join( REPO, "client/apps", d, "index.html" ) ) ).sort();

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "pickers-test-" ) );
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
// ONLY=calc,write runs those behaviour sections alone (no rules pass)
const ONLY = process.env.ONLY ? process.env.ONLY.split( "," ) : null;
const want = ( n ) => ! ONLY || ONLY.includes( n );

// Every file under a folder, with its text (to find what an app saved)
const filesUnder = ( dir ) => fs.readdirSync( dir, { withFileTypes: true } ).flatMap( e =>
    e.isDirectory() ? filesUnder( path.join( dir, e.name ) ) : [ path.join( dir, e.name ) ] );

// The rules, read off the page as it stands, every dialog opened in turn.
const RULES = `( async () => { const o = [];
    if( typeof Ayni.picker !== 'function' || ! document.querySelector( 'link[href*="ayni-pickers.css"]' ) ) return [ 'no Ayni pickers family' ];
    const OLD = 'select, datalist, .tb-select';
    const look = () =>
    {
        for( const x of document.querySelectorAll( OLD ) ) o.push( 'old drop-down: ' + x.outerHTML.slice( 0, 80 ) );
        const touch = document.documentElement.classList.contains( 'touch' );
        for( const p of document.querySelectorAll( '.picker' ) )
        {
            const f = p.querySelector( ':scope > [role="combobox"]' );
            if( ! f ) { if( p.querySelector( '[role="listbox"]' ) ) o.push( 'a written picker Ayni did not wire: ' + p.id ); continue; }
            const lb = f.getAttribute( 'aria-labelledby' ), name = ( lb && document.getElementById( lb )?.textContent.trim() ) || f.getAttribute( 'aria-label' ) || '';
            if( ! name || /\bayni\./.test( name ) ) o.push( 'a picker with no name: ' + ( p.id || p.className ) );
            const e = p.querySelector( '.picker-empty' );
            if( e && ( ! e.textContent.trim() || /ayni\./.test( e.textContent ) ) ) o.push( 'a "nothing matches" line not in words: ' + p.id );
            if( ! f.checkVisibility() || p.closest( '[hidden]' ) ) continue;
            const h = Math.round( f.getBoundingClientRect().height ), bar = p.closest( '[role="toolbar"]' );
            const want = bar ? 30 : touch ? 44 : 32;
            if( h !== want && ! p.closest( '.amount-row' ) ) o.push( 'picker ' + ( p.id || p.className ) + ' is ' + h + ' px, not ' + want );
            if( bar && getComputedStyle( f ).backgroundColor !== 'rgba(0, 0, 0, 0)' ) o.push( 'a toolbar picker with a fill: ' + p.id );
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
        // A page with an edit would ask before leaving, and the question blocks the navigation
        await ev( "( addEventListener( 'beforeunload', e => e.stopImmediatePropagation(), true ), true )" ).catch( () => {} );
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

    // A picker's parts, by its id
    const fieldOf = ( id ) => `#${id} > [role="combobox"]`;
    const isOpen  = ( id ) => ev( `!! document.querySelector( '#${id} .picker-pop' )?.matches( ':popover-open' )` );
    const val     = ( id ) => ev( `Ayni.picker( document.getElementById( '${id}' ) ).value` );
    const shown   = ( id ) => ev( `( f => f.tagName === 'INPUT' ? f.value : f.textContent )( document.querySelector( '${fieldOf( id )}' ) )` );
    // A click on the item whose text (or value) is `t`
    const pickItem = async ( id, t ) =>
    {
        const oid = await ev( `( o => o ? ( o.scrollIntoView( { block: 'nearest' } ), o.id ) : '' )( [ ...document.querySelectorAll( '#${id} [role="option"]' ) ].find( o => o.textContent.trim() === ${JSON.stringify( t )} || o.dataset.value === ${JSON.stringify( t )} ) )` );
        if( ! oid ) return false;
        await press( "#" + oid.replace( /([^\w-])/g, "\\$1" ) );
        return true;
    };
    // Type into a typing picker (filtered list, combo box) from empty, then Enter
    const typeIn = async ( id, text ) =>
    {
        await ev( `( f => { f.scrollIntoView( { block: 'center' } ); f.focus(); f.select?.(); } )( document.querySelector( '${fieldOf( id )}' ) ), true` );
        await sleep( 150 );
        await type( text );
        await key( "Enter", "Enter", 13 );
        await sleep( 200 );
    };

    await size( 390 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "RULES - every app, phone and desktop" );
    for( const [ w, t ] of ONLY && ! ONLY.includes( "rules" ) ? [] : [ [ 390, true ], [ 1280, false ] ] )
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

    if( want( "calendar" ) )
    {
        // Calendar: a weekly event in Lisbon's time
        await open( "calendar", 1280, 900 );
        await ev( "( document.querySelector('.topbar [data-view=\"timeGridDay\"]').click(), true )" );
        const SLOT = 'td.fc-timegrid-slot-lane[data-time="09:00:00"]';
        await until( `!! document.querySelector( ${JSON.stringify( SLOT )} )`, 5000 );
        await ev( `( document.querySelector( ${JSON.stringify( SLOT )} ).scrollIntoView( { block: 'center' } ), true )` );
        await sleep( 300 );
        await press( SLOT );
        ok( await until( "document.getElementById('sheetBackdrop').open", 3000 ), "Calendar: a click on 09:00 opens the new event" );
        await ev( "( document.getElementById('moreToggle').click(), true )" );
        await sleep( 200 );
        ok( await val( "fRepeat" ) === "none" && await shown( "fRepeat" ) === "Does not repeat", "Repeat is a list picker, on its first item", [ await val( "fRepeat" ), await shown( "fRepeat" ) ] );
        await press( fieldOf( "fRepeat" ) );
        ok( await isOpen( "fRepeat" ), "…a click opens its list" );
        await pickItem( "fRepeat", "weekly" );
        ok( await val( "fRepeat" ) === "weekly" && ! await isOpen( "fRepeat" ) && await ev( "getComputedStyle( document.getElementById('repeatDetails') ).display !== 'none'" ),
            "…Weekly picked: the list closes and the repeat details show" );
        ok( await ev( "document.getElementById('fTzid-field').tagName === 'INPUT' && document.querySelectorAll('#fTzid [role=option]').length > 100" ), "the time zone is a filtered list of every zone" );
        await typeIn( "fTzid", "lisb" );
        ok( await val( "fTzid" ) === "Europe/Lisbon", "…typing lisb + Enter takes Europe/Lisbon", await val( "fTzid" ) );
        await typeIn( "fTzid", "Atlantis" );
        ok( await ev( "document.getElementById('fTzid-field').getAttribute('aria-invalid') === 'true'" ) && await val( "fTzid" ) === "Europe/Lisbon",
            "…a zone that does not exist gets the red \"!\", and the value stays" );
        await shot( "calendar-tz-refused" );
        await typeIn( "fTzid", "Europe/Lisbon" );
        await ev( "( document.getElementById('fTitle').focus(), document.getElementById('fTitle').value = '', true )" );
        await type( "Swim" );
        await key( "Enter", "Enter", 13 );
        ok( await until( "! document.getElementById('sheetBackdrop').open", 3000 ), "…saved" );
        await sleep( 1500 );
        const ics = filesUnder( `${RUN}/homes/test` ).filter( f => f.endsWith( ".ics" ) ).map( f => fs.readFileSync( f, "utf8" ) ).join( "\n" );
        ok( /SUMMARY:Swim/.test( ics ) && /RRULE:FREQ=WEEKLY/.test( ics ) && /TZID=Europe\/Lisbon/.test( ics ), "…with RRULE:FREQ=WEEKLY and TZID=Europe/Lisbon in the file", ics.slice( 0, 500 ) );

    }
    if( want( "launcher" ) )
    {
        // The launcher's account: the time zone, saved on the account
        await open( "", 1280, 900 );
        await ev( "( window.openAccountDialog(), true )" );
        ok( await until( "!! document.querySelector('#tzSel > [role=combobox]') && Ayni.picker( document.getElementById('tzSel') ).options.length > 100", 5000 ), "launcher: the time zone is a filtered list of every zone" );
        await typeIn( "tzSel", "tokyo" );
        await sleep( 800 );
        ok( await ev( "fetch('/api/tz').then( r => r.json() ).then( d => d.tz )" ) === "Asia/Tokyo", "…tokyo + Enter saves Asia/Tokyo on the account", await ev( "fetch('/api/tz').then( r => r.json() )" ) );
        ok( await ev( "Ayni.picker( document.getElementById('langSel') ).options.length === 6 && document.querySelector('label[for=\"langSel-field\"]')?.textContent.length > 0" ), "…the language list has its 6 items and its label" );
        await size( 390 ); await touch( true ); await ev( "( Ayni.setTouchPreview( true ), true )" );
        await sleep( 300 );
        await press( "#tzSel-field" );
        ok( await ev( "( p => p.matches(':popover-open') && p.classList.contains('sheet') && Math.round( p.getBoundingClientRect().bottom ) === innerHeight )( document.querySelector('#tzSel .picker-pop') )" ),
            "…on a phone its list is a sheet at the bottom" );
        await shot( "launcher-tz-sheet" );
        await key( "Escape", "Escape", 27 );
        await touch( false ); await ev( "( Ayni.setTouchPreview( false ), true )" );

    }
    if( want( "calculator" ) )
    {
        // Calculator: currencies
        await open( "calculator", 1280, 900, "?mode=fx&from=EUR&to=USD" );
        ok( await shown( "fxTo" ) === "USD" && await ev( "Ayni.picker( document.getElementById('fxTo') ).text.startsWith( 'USD · ' )" ), "Calculator: the closed currency shows its code, the list the name too" );
        await typeIn( "fxTo", "yen" );
        ok( await val( "fxTo" ) === "JPY" && await shown( "fxTo" ) === "JPY", "…yen + Enter takes JPY", [ await val( "fxTo" ), await shown( "fxTo" ), await ev( "[ document.activeElement.id, document.querySelector('#fxTo-field')?.value, [ ...document.querySelectorAll('#fxTo [role=option]') ].filter( o => ! o.hidden ).map( o => o.textContent ).slice( 0, 4 ), Ayni.picker( document.getElementById('fxTo') ).options.find( o => o.value === 'JPY' ) ]" ) ] );

    }
    if( want( "split" ) )
    {
        // Split: a new group in dollars
        await open( "split", 1280, 900 );
        await press( "#addBtn" );
        ok( await until( "document.getElementById('groupSheetBackdrop').open", 3000 ), "Split: a new group" );
        ok( await shown( "groupCurSel" ) === "EUR" && await ev( "document.querySelectorAll('#groupCurSel li.heading').length" ) === 2, "…its currency shows EUR, its list has Frequent and All" );
        await press( fieldOf( "groupCurSel" ) );
        ok( await ev( "document.querySelector('#groupCurSel [aria-selected=true]')?.textContent.startsWith( 'EUR · ' )" ), "…open, the list shows code and name" );
        await key( "Escape", "Escape", 27 );
        await typeIn( "groupCurSel", "USD" );
        ok( await val( "groupCurSel" ) === "USD" && await shown( "groupCurSel" ) === "USD", "…USD typed + Enter" );
        await ev( "( document.getElementById('groupNameInput').value = 'Trip', document.getElementById('othersInput').value = 'Ana', true )" );
        await press( "#groupSaveBtn" );
        await sleep( 1500 );
        const split = filesUnder( `${RUN}/homes/test` ).filter( f => /split/i.test( f ) && f.endsWith( ".json" ) ).map( f => fs.readFileSync( f, "utf8" ) ).join( "\n" );
        ok( /"currency"\s*:\s*"USD"/.test( split ) && /Trip/.test( split ), "…saved with the group in dollars", split.slice( 0, 300 ) );

    }
    if( want( "contact" ) )
    {
        // Contacts: a work phone
        await open( "contact", 1280, 900, "?new=Bea%20Gil" );
        ok( await until( "document.getElementById('editBackdrop').open", 3000 ), "Contacts: a new contact" );
        const telType = await ev( "( p => p.id ||= 'telType0' )( document.querySelector('#telRows .picker') )" );
        await press( fieldOf( telType ) );
        await pickItem( telType, "WORK" );
        await ev( "( i => { i.value = '600111222'; i.dispatchEvent( new Event( 'input', { bubbles: true } ) ); } )( document.querySelector('#telRows .multi-fields input') ), true" );
        await press( "#editSaveBtn" );
        ok( await until( "! document.getElementById('editBackdrop').open", 3000 ), "…saved" );
        await sleep( 1500 );
        const vcf = filesUnder( `${RUN}/homes/test` ).filter( f => f.endsWith( ".vcf" ) ).map( f => fs.readFileSync( f, "utf8" ) ).join( "\n" );
        ok( /TEL;TYPE=WORK:600111222/.test( vcf ), "…the phone saved as a work one (TEL;TYPE=WORK)", vcf.slice( 0, 300 ) );

    }
    if( want( "desktop" ) )
    {
        // Desktop: the bar's side, from a row of the ⋮ menu
        await open( "desktop", 1280, 900 );
        await press( "#moreBtn" );
        ok( await until( "! document.getElementById('moreMenu').hidden", 2000 ), "Desktop: the ⋮ menu" );
        await press( fieldOf( "setBar" ) );
        ok( await isOpen( "setBar" ), "…the bar's side opens its list over the menu" );
        await pickItem( "setBar", "top" );
        ok( await ev( "! document.getElementById('moreMenu').hidden && ( JSON.parse( localStorage.getItem('balata-desktop') ) || {} ).bar === 'top'" ), "…a pick moves the bar to the top and leaves the menu open" );
        await shot( "desktop-menu-row" );
        await press( fieldOf( "setBar" ) );
        await pickItem( "setBar", "bottom" );
        await ev( "( document.getElementById('moreBtn').click(), true )" );

    }
    if( want( "text" ) )
    {
        // Text: the language, and Save as's format
        await open( "text", 1280, 900 );
        ok( await ev( "!! document.querySelector('#toolbar[role=toolbar] #langSelect > [role=combobox]')" ), "Text: the language list sits in the format toolbar" );
        await press( fieldOf( "langSelect" ) );
        await pickItem( "langSelect", "text/x-markdown" );
        ok( await val( "langSelect" ) === "text/x-markdown" && await ev( "document.getElementById('previewBtn').getAttribute('aria-disabled') !== 'true'" ), "…Markdown picked: the preview button wakes up" );
        ok( await ev( "! document.querySelector('#langSelect').contains( document.activeElement )" ), "…and the list did not keep the focus" );
        await ev( "( document.getElementById('saveAsBtn').click(), true )" );     // on a PC it sits in the File menu
        ok( await until( "document.getElementById('saveAsBackdrop').open", 3000 ), "Save as" );
        await ev( "( document.getElementById('saveName').value = 'notes.txt', true )" );
        await press( fieldOf( "saveFormat" ) );
        await pickItem( "saveFormat", "py" );
        ok( await ev( "document.getElementById('saveName').value" ) === "notes.py", "…the format Python renames notes.txt to notes.py", await ev( "document.getElementById('saveName').value" ) );
        await ev( "( document.getElementById('saveAsBackdrop').close(), true )" );

    }
    if( want( "write" ) )
    {
        // Write: the toolbar's font list never takes the document's focus
        await open( "write", 1280, 900 );
        await ev( "( ( document.querySelector('#editor [contenteditable=true]') || document.querySelector('#editor') ).focus(), true )" );
        const focus0 = await ev( "document.activeElement && ( document.activeElement.id || document.activeElement.className )" );
        await press( fieldOf( "fontFamilySel" ) );
        ok( await isOpen( "fontFamilySel" ), "Write: the toolbar's font list opens" );
        ok( await ev( "document.activeElement && ( document.activeElement.id || document.activeElement.className )" ) === focus0, "…and the document keeps the focus", [ focus0, await ev( "document.activeElement?.id" ) ] );
        await pickItem( "fontFamilySel", "Georgia" );
        ok( ! await isOpen( "fontFamilySel" ) && await ev( "document.activeElement && ( document.activeElement.id || document.activeElement.className )" ) === focus0, "…a pick closes it, the focus still in the document" );
        ok( await ev( "document.querySelector('#fontSizeSel > [role=combobox]').tagName === 'INPUT'" ), "…the size is a box to type in (a combo box)" );
        await shot( "write-toolbar" );

    }
    if( want( "drive" ) )
    {
        // Drive: a rule's condition
        await open( "drive", 1280, 900 );
        await press( "#searchToggleBtn" );
        await press( "#searchBuilderBtn" );
        ok( await until( "document.getElementById('searchBuilderBackdrop').open", 3000 ), "Drive: the advanced search" );
        const op2 = await ev( "( p => { p.id ||= 'sbOp0'; const o = Ayni.picker( p ).options[ 1 ]; return o.value; } )( document.querySelector('#sbRules .picker') )" );
        await press( fieldOf( "sbOp0" ) );
        await pickItem( "sbOp0", op2 );
        ok( await ev( `document.querySelector('#sbRules .sb-rule > input.input').placeholder === Ayni.t( 'drive.opPh.${op2}' )` ), "…a rule's condition picked changes its hint", op2 );

    }
    if( want( "es" ) )
    {
        // In Spanish
        await ev( "( localStorage.setItem( 'ayni-lang', 'es' ), true )" );
        await open( "calculator", 1280, 900, "?mode=fx&from=EUR&to=USD" );
        await ev( "( f => { f.focus(); f.select(); } )( document.querySelector('#fxTo > [role=combobox]') ), true" );
        await type( "zzz" );
        ok( await ev( "document.querySelector('#fxTo .picker-empty').textContent" ) === "Nada coincide.", "es: Nada coincide.", await ev( "document.querySelector('#fxTo .picker-empty').textContent" ) );
        await ev( "( localStorage.setItem( 'ayni-lang', 'en' ), true )" );

    }
    // LAST: its edit makes the page ask before leaving, and navigation hangs
    if( want( "calc" ) )
    {
        // Calc: number format and font size
        await open( "calc", 1280, 900 );
        await sleep( 1500 );
        await press( "#gridHost td" );
        await press( fieldOf( "fmtNumFormat" ) );
        await pickItem( "fmtNumFormat", "porcentaje" );
        ok( await until( "document.getElementById('numFmtBackdrop').open", 2000 ), "Calc: Percent in the number format opens its dialog" );
        ok( await ev( "!! document.querySelector('#numFmtBackdrop #nfDecimals > [role=combobox]')" ), "…whose decimals are a list picker" );
        await ev( "( document.getElementById('numFmtBackdrop').close(), true )" );
        await press( fieldOf( "fmtNumFormat" ) );
        await pickItem( "fmtNumFormat", "general" );
        await press( fieldOf( "fmtNumFormat" ) );
        await pickItem( "fmtNumFormat", "porcentaje" );
        ok( await until( "document.getElementById('numFmtBackdrop').open", 2000 ), "…picking it again opens it again" );
        await ev( "( document.getElementById('numFmtBackdrop').close(), true )" );
        await typeIn( "fmtFontSize", "abc" );
        ok( await val( "fmtFontSize" ) === "" && await shown( "fmtFontSize" ) === "11", "…the size box refuses \"abc\": the cell's own 11 comes back", [ await val( "fmtFontSize" ), await shown( "fmtFontSize" ) ] );

    }
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
