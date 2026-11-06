// run.mjs - Ayni's help family in Nayive (Ayni.help, Ayni.tour, Ayni.coach,
// the info "i"), in a real (headless) browser: the rules on every page, then
// what moving onto Ayni changed. The tour step by step, app by app, is
// tools/tour-test; this is the rest.
//
//   node tools/help-test/run.mjs            (SHOTS=/some/dir also saves screenshots)
//
// Same scratch server as tools/lists-test (its own run-root in /tmp, a copy of
// client/apps, a user "test" with a few files); the real store/ is never
// touched. Nothing is saved.
//
// RULES, every app, phone and desktop width: no old help API (NayiveUI.firstRun,
//   showIntro, setIntro, setHelpMenu, tour, applyInfoDots) and no old markup
//   ([data-intro-open], .info-dot, [data-info], .intro-*, .info-popup); Ayni's
//   family is loaded; every info "i" has a text, a name and its icon; no error.
//   At desktop width the "?" opens the card (or the Help menu: Write, Calc,
//   Text), and every row's glyph is a small copy of a round button.
// BEHAVIOURS: the first-visit marks (once for all apps, key balata-coach-seen,
//   9 s count, Esc held, seen when the count ends; never in Chat nor in a
//   Planner frame); the launcher's card (shows by itself until Don't show
//   again, key balata-intro-dismiss:launcher; holdIntro shuts it); the tour
//   starts at the app's name; Write's Help menu (Statistics, Shortcuts, the
//   card, the tour; the card has no tour button there); the info "i" in a
//   dialog (a click opens it inside the dialog, Esc closes only it); an "i"
//   added later gets wired; the install dialog keeps its own look.
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

const RUN  = fs.mkdtempSync( path.join( os.tmpdir(), "help-test-" ) );
const PORT = await new Promise( res => { const s = net.createServer(); s.listen( 0, "127.0.0.1", () => { const p = s.address().port; s.close( () => res( p ) ); } ); } );
const BASE = `http://127.0.0.1:${PORT}`;

const built = spawnSync( GO, [ "build", "-o", path.join( RUN, "nayive" ), "." ], { cwd: path.join( REPO, "server/go" ), stdio: "inherit" } );
if( built.status !== 0 ) { console.log( "server build failed (set GO=/path/to/go?)" ); process.exit( 1 ); }
fs.mkdirSync( `${RUN}/config` );
fs.writeFileSync( `${RUN}/config/server.json`, JSON.stringify( { host: "127.0.0.1", port: PORT, base_dir: ".", admin: { name: "jefe", password: "secreto" } } ) );
fs.mkdirSync( `${RUN}/homes/test/data`, { recursive: true } );
fs.mkdirSync( `${RUN}/homes/test/files/Docs`, { recursive: true } );
fs.writeFileSync( `${RUN}/homes/test/data/config.json`, JSON.stringify( { password: "test" } ) );
for( const n of [ "apple.txt", "banana.txt" ] ) fs.writeFileSync( `${RUN}/homes/test/files/${n}`, n );
for( const a of [ "photos", "music", "movies" ] )
{
    fs.mkdirSync( `${RUN}/homes/test/data/${a}`, { recursive: true } );
    fs.writeFileSync( `${RUN}/homes/test/data/${a}/config.json`, JSON.stringify( { folder: "files" } ) );
}
spawnSync( "cp", [ "-a", path.join( REPO, "client/apps" ), path.join( RUN, "apps" ) ], { stdio: "inherit" } );
const server = spawn( path.join( RUN, "nayive" ), [ "-config", `${RUN}/config/server.json` ], { stdio: "ignore" } );
for( let i = 0; i < 100; i++ ) { try { await fetch( BASE + "/api/whoami" ); break; } catch { await sleep( 100 ); } }

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 500 ) ) );
};
const SHOTS = process.env.SHOTS || "";

// The rules, read off the page as it stands.
const RULES = `( () => { const o = [];
    if( window.NayiveUI && [ 'firstRun', 'showIntro', 'setIntro', 'setHelpMenu', 'tour', 'applyInfoDots', 'showCoach' ].some( k => NayiveUI[ k ] ) ) o.push( 'old NayiveUI help API' );
    if( typeof Ayni.help !== 'function' || typeof Ayni.tour !== 'function' || typeof Ayni.coach !== 'function' ) return [ 'no Ayni help family' ];
    const old = document.querySelector( '[data-intro-open], .info-dot, [data-info], .info-popup, [class*="intro-"]' );
    if( old ) o.push( 'old help markup: ' + ( old.id || old.className || old.tagName ) );
    for( const d of document.querySelectorAll( '.info-tip' ) )
    {
        const n = d.id || d.getAttribute( 'data-i18n-attr' ) || d.outerHTML.slice( 0, 60 );
        if( ! ( d.getAttribute( 'data-help' ) || '' ).trim() ) o.push( n + ': an info tip with no text' );
        if( ! d.getAttribute( 'aria-label' ) ) o.push( n + ': an info tip with no name' );
        if( ! d.querySelector( '.icon, svg' ) ) o.push( n + ': an info tip with no icon' );
        if( d.hasAttribute( 'popovertarget' ) ) o.push( n + ': an info tip with popovertarget' );
    }
    return o; } )()`;

const b = await browser();
try
{
    const list = await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json();
    const c = await attach( list.find( t => t.type === "page" ).webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    // Less motion, as on his desktop: headless leaves CSS transitions half done.
    await c.send( "Emulation.setEmulatedMedia", { features: [ { name: "prefers-reduced-motion", value: "reduce" } ] } );
    const size = ( w, h = 800 ) => c.send( "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 } );
    const ev = ( s ) => c.evaluate( s );
    const until = async ( s, ms = 4000 ) => { for( let t = 0; t < ms; t += 100 ) { if( await ev( s ).catch( () => false ) ) return true; await sleep( 100 ); } return false; };
    const open = async ( app, w, h, wait ) =>
    {
        await size( w, h );
        await c.send( "Page.navigate", { url: BASE + "/nayive/" + ( app ? app + "/" : "" ) } );
        await until( "window.Ayni && Ayni.ready && document.readyState === 'complete'", 8000 );
        await ev( "Ayni.ready.then( () => true )" );
        await sleep( wait ?? ( app === "write" || app === "calc" ? 4000 : 1500 ) );
    };
    const mouse = async ( type, x, y ) => c.send( "Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, pointerType: "mouse" } );
    const centre = async ( sel ) => JSON.parse( await ev( `( e => { e.scrollIntoView( { block: 'nearest' } ); const r = e.getBoundingClientRect(); return JSON.stringify( [ r.left + r.width / 2, r.top + r.height / 2 ] ); } )( document.querySelector( ${JSON.stringify( sel )} ) )` ) );
    const press = async ( sel ) => { const [ x, y ] = await centre( sel ); await mouse( "mouseMoved", x, y ); await mouse( "mousePressed", x, y ); await mouse( "mouseReleased", x, y ); await sleep( 200 ); };
    const esc = async () => { for( const type of [ "keyDown", "keyUp" ] ) await c.send( "Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } ); await sleep( 150 ); };
    const shot = async ( name ) =>
    {
        if( ! SHOTS ) return;
        await sleep( 300 );
        const r = await c.send( "Page.captureScreenshot", { format: "png" } );
        fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) );
    };
    const errors = () => c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]/.test( l ) );
    const store = ( k, v ) => ev( v == null ? `localStorage.removeItem( '${k}' ); true` : `localStorage.setItem( '${k}', '${v}' ); true` );
    const stored = ( k ) => ev( `localStorage.getItem( '${k}' )` );
    // The "?" a user can see right now (not one fitBar moved into the ⋮).
    const HELP = "[ ...document.querySelectorAll( '[data-help-open]' ) ].find( e => e.getClientRects().length && ! e.closest( '.fit-out' ) && getComputedStyle( e ).visibility !== 'hidden' )";
    const CARD = "dialog.panel.help-card[open]";

    await size( 390 );
    await c.send( "Page.navigate", { url: BASE + "/nayive/login.html" } );
    await sleep( 1500 );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('balata-intro-dismiss:launcher','1'); localStorage.setItem('ayni-lang','en');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "signed in", st );

    console.log( "RULES - every app, phone and desktop; the \"?\" on a desktop" );
    for( const w of [ 390, 1280 ] )
        for( const app of [ "", ...APPS ] )
        {
            if( app === "desktop" && w < 600 ) continue;     // a phone is sent back to the launcher
            c.logs.length = 0;
            await open( app, w );
            const name = ( app || "launcher" ) + " @ " + w;
            const found = await ev( RULES );
            ok( ! found.length, name + ": rules", found );
            if( w > 600 && await ev( `!! ${HELP}` ) )
            {
                await ev( `${HELP}.click(); true` );
                const got = await until( `!! document.querySelector( '${CARD}' ) || !! document.querySelector( '.panel.menu:popover-open [data-act="help-card"]' )`, 3000 );
                if( got && await ev( `! document.querySelector( '${CARD}' )` ) )
                {
                    await ev( "document.querySelector( '.panel.menu:popover-open [data-act=\"help-card\"]' ).click(); true" );
                    await until( `!! document.querySelector( '${CARD}' )`, 3000 );
                }
                const card = await ev( `( d => d && { rows: d.querySelectorAll( '.help-list li' ).length,
                    glyphs: [ ...d.querySelectorAll( '.help-list li > :first-child' ) ].every( g => g.matches( '.btn.help-ico' ) && g.getBoundingClientRect().width === 28 ),
                    names: [ ...d.querySelectorAll( '.help-list li' ) ].every( l => l.querySelector( '.help-t span' ) ) } )( document.querySelector( '${CARD}' ) )` );
                ok( got && card && card.rows > 0 && card.glyphs && card.names, name + ": the \"?\" opens the card; each glyph is a 28 px button copy", card );
                if( app === "drive" ) await shot( "drive-card" );
                await esc();
                await until( `! document.querySelector( '${CARD}' )`, 2000 );
            }
            const errs = errors();
            ok( ! errs.length, name + ": no errors", errs );
        }

    console.log( "SOURCE - the old texts are gone, Ayni's are there" );
    const en = JSON.parse( fs.readFileSync( path.join( REPO, "client/apps/shared/i18n/en.json" ), "utf8" ) );
    const ay = JSON.parse( fs.readFileSync( path.join( REPO, "client/apps/shared/ayni/i18n/en.json" ), "utf8" ) );
    ok( ! Object.keys( en ).some( k => /^ui\.(tour\.|help$|moreInfo$|dontShowAgain$|toolbarButtons$|coach\.wait$)/.test( k ) ), "no ui.tour.* / ui.help / ui.moreInfo / ui.dontShowAgain / ui.toolbarButtons / ui.coach.wait" );
    ok( en[ "ui.coach.home" ] && en[ "ui.coach.help" ] && ay[ "ayni.tour.open" ] && ay[ "ayni.coach.wait" ], "Nayive keeps its two bubble texts; Ayni has the tour's" );

    console.log( "FIRST-VISIT MARKS - once, for every app" );
    c.logs.length = 0;
    await open( "drive", 1280, 800, 300 );
    await store( "balata-coach-seen" );
    await open( "drive", 1280, 800, 300 );
    ok( await until( "document.querySelectorAll( '.coach-overlay .coach-bubble' ).length === 2", 6000 ), "a new user: two bubbles (the app's name, the \"?\")" );
    ok( await ev( "( ( h, r ) => r.left <= h.left && r.right >= h.right )( document.querySelector( 'h1.home-link' ).getBoundingClientRect(), document.querySelector( '.coach-ring' ).getBoundingClientRect() )" ), "…the first ring is round the app's name" );
    ok( await ev( "[ ...document.querySelectorAll( '.coach-close' ) ].every( x => x.getAttribute( 'aria-disabled' ) === 'true' && /^[1-9]$/.test( x.textContent ) )" ), "…their × counts down, dead" );
    await shot( "coach" );
    await esc();
    ok( await ev( "!! document.querySelector( '.coach-overlay' )" ) && await stored( "balata-coach-seen" ) === null, "…Esc is held; not seen yet" );
    ok( await until( "document.querySelector( '.coach-close' ).getAttribute( 'aria-disabled' ) === 'false'", 11000 ) && await stored( "balata-coach-seen" ) === "1", "after the count: the × works, balata-coach-seen = 1" );
    await esc();
    ok( await until( "! document.querySelector( '.coach-overlay' )", 2000 ), "…now Esc closes them" );
    await open( "photos", 1280, 800, 3000 );
    ok( await ev( "! document.querySelector( '.coach-overlay' )" ), "another app: not again" );
    await store( "balata-coach-seen" );
    await open( "chat", 1280, 800, 4000 );
    ok( await ev( "! document.querySelector( '.coach-overlay' )" ) && await stored( "balata-coach-seen" ) === null, "Chat: never (and the flag is left for the next app)" );
    await open( "planner", 1280, 800, 300 );
    await until( "!! document.querySelector( '.coach-overlay' )", 6000 );
    ok( await ev( "[ ...document.querySelectorAll( 'iframe' ) ].every( f => { try { return ! f.contentDocument.querySelector( '.coach-overlay' ); } catch { return true; } } )" ), "Planner: none inside its frames" );
    await store( "balata-coach-seen", "1" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "THE LAUNCHER'S CARD - until Don't show again" );
    c.logs.length = 0;
    await store( "balata-intro-dismiss:launcher" );
    await open( "", 1280, 800, 300 );
    ok( await until( `!! document.querySelector( '${CARD} .help-dismiss' )`, 5000 ), "it shows by itself, with Don't show again" );
    await shot( "launcher-card" );
    await press( `${CARD} .help-dismiss` );
    ok( await until( `! document.querySelector( '${CARD}' )`, 2000 ) && await stored( "balata-intro-dismiss:launcher" ) === "1", "Don't show again: it closes, balata-intro-dismiss:launcher = 1" );
    await open( "", 1280, 800, 2000 );
    ok( await ev( `! document.querySelector( '${CARD}' )` ), "…and stays away" );
    await store( "balata-intro-dismiss:launcher" );
    await open( "", 1280, 800, 300 );
    await until( `!! document.querySelector( '${CARD}' )`, 5000 );
    await ev( "NayiveUI.holdIntro(); Ayni.help.show(); true" );
    ok( await until( `! document.querySelector( '${CARD}' )`, 2000 ), "holdIntro (a password first) shuts it and keeps it shut" );
    await store( "balata-intro-dismiss:launcher", "1" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "THE TOUR - starts at the app's name" );
    c.logs.length = 0;
    await open( "drive", 1280 );
    await ev( `${HELP}.click(); true` );
    await until( `!! document.querySelector( '${CARD} .help-tour' )`, 3000 );
    await press( `${CARD} .help-tour` );
    ok( await until( "!! document.querySelector( '.tour-overlay .tour-bubble:not([hidden])' )", 4000 ), "Take the tour starts it" );
    await sleep( 400 );
    ok( await ev( "( r => [ ...document.querySelectorAll( '.app-icon.home-link, h1.home-link' ) ].some( e => { const h = e.getBoundingClientRect(); return h.width && r.left <= h.left + 1 && r.right >= h.right - 1 && r.top <= h.top + 1 && r.bottom >= h.bottom - 1; } ) )( document.querySelector( '.tour-ring' ).getBoundingClientRect() )" ), "…its first step rings the app's icon / name" );
    ok( await ev( "/^1 of \\d+$/.test( document.querySelector( '.tour-count' ).textContent )" ), "…\"1 of N\"", await ev( "document.querySelector( '.tour-count' )?.textContent" ) );
    await shot( "tour-home" );
    await esc();
    ok( await until( "! document.querySelector( '.tour-overlay' )", 2000 ), "Esc ends it" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "WRITE - the \"?\" is the Help menu" );
    c.logs.length = 0;
    await open( "write", 1280 );
    await press( "#helpBtn" );
    ok( await until( "!! document.querySelector( '#helpMenu:popover-open' )", 3000 ), "the \"?\" opens the Help menu" );
    ok( await ev( "[ ...document.querySelectorAll( '#helpMenu [role=menuitem]' ) ].map( r => r.dataset.act ).join() === 'statsBtn,scBtn,help-card,help-tour'" ), "…Statistics, Shortcuts, the card, the tour",
        await ev( "[ ...document.querySelectorAll( '#helpMenu [role=menuitem]' ) ].map( r => r.dataset.act ).join()" ) );
    ok( await ev( "[ ...document.querySelectorAll( '#helpMenu [role=menuitem]' ) ].every( r => r.querySelector( '.icon svg' ) && r.textContent.trim() )" ), "…every row has its icon and name" );
    ok( await ev( `! document.querySelector( '${CARD}' )` ), "…and no card under it" );
    await shot( "write-help-menu" );
    await press( "#helpMenu [data-act=\"help-card\"]" );
    ok( await until( `!! document.querySelector( '${CARD}' )`, 3000 ) && await ev( `! document.querySelector( '${CARD} .help-tour' )` ), "the card row opens the card, with no tour button (it is in the menu)" );
    await esc();
    await until( `! document.querySelector( '${CARD}' )`, 2000 );
    await press( "#helpBtn" );
    await until( "!! document.querySelector( '#helpMenu:popover-open' )", 3000 );
    await press( "#helpMenu [data-act=\"help-tour\"]" );
    ok( await until( "!! document.querySelector( '.tour-overlay .tour-bubble:not([hidden])' )", 4000 ), "the tour row starts the tour" );
    await esc();
    await until( "! document.querySelector( '.tour-overlay' )", 2000 );
    ok( await ev( "AyniDoc.helpItems().map( i => i.el || i.cmd ).join() === 'statsBtn,scBtn,help-card,help-tour'" ), "the menu bar's Help shows the same rows" );
    ok( ! errors().length, "no errors", errors() );

    console.log( "THE INFO \"i\" - in a dialog, and one added later" );
    c.logs.length = 0;
    await open( "", 1280 );
    await ev( "openAccountDialog(); true" );
    const TIP = "dialog.panel[open] .info-tip[data-i18n-attr*=\"acct.themeAutoInfo\"]";
    await until( `!! document.querySelector( '${TIP}' )`, 3000 );
    ok( await ev( `( d => getComputedStyle( d ).width === '16px' && d.getAttribute( 'aria-label' ) )( document.querySelector( '${TIP}' ) )` ), "Account: a 16 px \"i\" with a name" );
    await press( TIP );
    ok( await until( "!! document.querySelector( '.info-pop:popover-open' )", 2000 ), "a click opens its popup" );
    ok( await ev( `document.querySelector( '.info-pop:popover-open' ).textContent === document.querySelector( '${TIP}' ).dataset.help && !! document.querySelector( '.info-pop:popover-open' ).closest( 'dialog[open]' )` ), "…with its text, inside the dialog" );
    await shot( "info-in-dialog" );
    await esc();
    ok( await until( "! document.querySelector( '.info-pop:popover-open' )", 2000 ) && await ev( "!! document.querySelector( 'dialog.panel[open]' )" ), "Esc closes the popup only; the dialog stays" );
    await esc();
    await until( "! document.querySelector( 'dialog.panel[open]' )", 2000 );
    await ev( "( d => { d.className = 'info-tip'; d.type = 'button'; d.id = 'lateTip'; d.dataset.help = 'Added later.'; document.body.append( d ); } )( document.createElement( 'button' ) ); true" );
    ok( await until( "( d => !! d.querySelector( '.icon, svg' ) && !! d.getAttribute( 'aria-label' ) )( document.getElementById( 'lateTip' ) )", 2000 ), "an \"i\" added later gets its icon and name by itself" );
    await press( "#lateTip" );
    ok( await until( "document.querySelector( '.info-pop:popover-open' )?.textContent === 'Added later.'", 2000 ), "…and opens" );
    await esc();
    ok( ! errors().length, "no errors", errors() );

    console.log( "INSTALL DIALOG - its own look, Ayni's rows (an iPhone: the nudge with its buttons)" );
    c.logs.length = 0;
    await c.send( "Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" } );
    await open( "", 390 );
    await store( "nayive-install-snooze" );
    await ev( "Ayni.pwa.offerInstall(); true" );
    const INST = "dialog.panel.install-sheet[open]";
    ok( await until( `!! document.querySelector( '${INST}' )`, 3000 ), "the install nudge opens its dialog" );
    ok( await ev( `( d => ! d.classList.contains( 'help-card' ) && !! d.querySelector( 'header .install-close' ) && d.querySelectorAll( '.help-list li .install-ico svg, .install-steps li .install-ico svg' ).length >= 3 )( document.querySelector( '${INST}' ) )` ),
        "…not a help card; its ×, its rows with their glyphs" );
    ok( await ev( `( bs => bs.length >= 2 && parseFloat( getComputedStyle( bs[ 0 ] ).minHeight ) === 44 && getComputedStyle( bs[ 0 ] ).borderTopStyle === 'solid' )( document.querySelectorAll( '${INST} .install-btn' ) )` ),
        "…Not now / Don't show again: wide 44 px buttons", await ev( `[ ...document.querySelectorAll( '${INST} .install-btn' ) ].map( b => getComputedStyle( b ).minHeight )` ) );
    await shot( "install" );
    await esc();
    ok( await until( `! document.querySelector( '${INST}' )`, 2000 ), "Esc closes it" );
    await store( "nayive-install-snooze", "never" );
    await c.send( "Emulation.setUserAgentOverride", { userAgent: "" } );
    ok( ! errors().length, "no errors", errors() );
}
finally
{
    await b.kill();
    try { server.kill(); } catch {}
    try { fs.rmSync( RUN, { recursive: true, force: true } ); } catch {}
}
console.log( `${pass} passed, ${fail} failed` );
console.log( fail ? "SOME FAILED" : "ALL GREEN" );
process.exit( fail ? 1 : 0 );
