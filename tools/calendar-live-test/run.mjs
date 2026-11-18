// calendar-live-test - a file saved on another device shows in an open app by
// itself (server/go/api_watch.go + AyniBoot.wireRefresh `watch`).
//
//   node tools/calendar-live-test/run.mjs
//
// A scratch server (tools/compat-test/server.mjs: fresh Go build, its own
// run-root with a COPY of store/homes/test - the real store/ is never touched)
// over HTTPS, as on the VPS, and headless pages nobody clicks or focuses. A
// second session (this script, like the phone) saves; the page must re-read.
//   - Calendar: the event appears; with a dialog open, only once it closes;
//     inside a desktop window too.
//   - Tasks, Contacts, Habits, Bookmarks: their file is saved again (same
//     bytes, new version) and the page reads it again.
//   - Plain HTTP (a dev box): no wait held, a look every 10 s.
import { browser, attach } from "../cdp.mjs";
import { startServer, sleep } from "../compat-test/server.mjs";

let pass = 0, fail = 0;
const ok = ( cond, what, extra ) =>
{
    if( cond ) pass++; else fail++;
    console.log( ( cond ? "  ok   " : "  FAIL " ) + what + ( cond || extra === undefined ? "" : "  -> " + JSON.stringify( extra ).slice( 0, 400 ) ) );
};
const took = ms => ms >= 0 ? " (" + ms + " ms)" : "";

const day = new Date().toISOString().slice( 0, 10 ).replace( /-/g, "" );
const ics = ( ...names ) => "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//live-test//EN\r\n" +
    names.map( ( n, i ) => `BEGIN:VEVENT\r\nUID:live-${i}@test\r\nDTSTAMP:20261117T100000Z\r\n` +
                           `DTSTART;VALUE=DATE:${day}\r\nSUMMARY:${n}\r\nEND:VEVENT\r\n` ).join( "" ) +
    "END:VCALENDAR\r\n";

// One server + one browser tab, signed in on both sides.
async function setUp( b, tls )
{
    const srv = await startServer( { seed: true, tls } );
    const login = await fetch( srv.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
                                                          body: JSON.stringify( { user: "test", password: "test" } ) } );
    const cookie = ( login.headers.get( "set-cookie" ) || "" ).split( ";" )[ 0 ];
    ok( login.status === 200 && cookie, "the phone signed in", login.status );
    const file = p => srv.base + "/api/files?file=" + encodeURIComponent( p );
    const phone = {
        save: async ( p, body ) => ( await fetch( file( p ), { method: "PUT", headers: { Cookie: cookie }, body } ) ).status,
        get:  async p => ( await fetch( file( p ), { headers: { Cookie: cookie } } ) ).text()
    };

    const tab = await b.newTab( "about:blank" );
    const c = await attach( tab.webSocketDebuggerUrl );
    await c.send( "Network.enable" );
    await c.send( "Network.setBypassServiceWorker", { bypass: true } );
    await c.send( "Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false } );
    const ev = s => c.evaluate( s );
    const until = async ( s, ms ) => { const t0 = Date.now(); while( Date.now() - t0 < ms ) { if( await ev( s ).catch( () => false ) ) return Date.now() - t0; await sleep( 100 ); } return -1; };
    const go = async ( url, ready, ms = 12000 ) => { await c.send( "Page.navigate", { url: srv.base + url } ); return until( ready, ms ); };

    await go( "/nayive/login.html", "document.readyState === 'complete'" );
    const st = await ev( `localStorage.setItem('balata-coach-seen','1'); localStorage.setItem('nayive-install-snooze','never');
        localStorage.setItem('ayni-lang','en'); localStorage.setItem('balata-desktop','never'); localStorage.setItem('nayive-sos-tip','1');
        fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'test',password:'test'})}).then(r=>r.status)` );
    ok( st === 200, "the PC signed in", st );
    return { srv, phone, c, ev, until, go };
}

const CAL_READY = "!! document.querySelector('.fc-view-harness') && document.readyState === 'complete'";
const shows = n => `document.body.innerText.includes( ${JSON.stringify( n )} )`;
// How many times the page has read `p` (its GETs of /api/files?file=p).
const reads = p => `performance.getEntriesByType('resource').filter( e => e.initiatorType === 'fetch' &&
                    decodeURIComponent( e.name ).includes( 'file=' + ${JSON.stringify( p )} ) && ! e.name.includes( '/api/watch' ) ).length`;

const b = await browser( [ "--ignore-certificate-errors" ] );
let s = null;
try
{
    console.log( "HTTPS (HTTP/2, as on the VPS)" );
    s = await setUp( b, true );
    const { phone, c, ev, until, go } = s;
    ok( await ev( "performance.getEntriesByType('navigation')[0].nextHopProtocol" ) === "h2", "the page speaks HTTP/2" );

    console.log( "CALENDAR: A SAVE ON THE PHONE, NOBODY TOUCHES THE PC" );
    ok( await go( "/nayive/calendar/index.html", CAL_READY ) >= 0, "Calendar is open" );
    await sleep( 3000 );   // the first watch answer and its one read are done
    ok( await phone.save( "data/calendar.ics", ics( "LIVE-PUSH-1" ) ) === 200, "the phone saved event 1" );
    const t1 = await until( shows( "LIVE-PUSH-1" ), 6000 );
    ok( t1 >= 0, "event 1 shows by itself" + took( t1 ) );

    console.log( "CALENDAR: A DIALOG OPEN - NO REPAINT UNDER IT, THEN THE EVENT" );
    await ev( "document.getElementById('goToBackdrop').show(), true" );
    ok( await phone.save( "data/calendar.ics", ics( "LIVE-PUSH-1", "LIVE-PUSH-2" ) ) === 200, "the phone saved event 2" );
    await sleep( 3500 );
    ok( ! await ev( shows( "LIVE-PUSH-2" ) ), "not shown while the dialog is open" );
    await ev( "document.getElementById('goToBackdrop').close(), true" );
    const t2 = await until( shows( "LIVE-PUSH-2" ), 5000 );
    ok( t2 >= 0, "event 2 shows once it closes" + took( t2 ) );

    console.log( "CALENDAR: ONE WAIT OPEN, NO SPIN" );
    const watches = "performance.getEntriesByType('resource').filter( e => e.name.includes( '/api/watch' ) ).length";
    const n0 = await ev( watches );
    await sleep( 4000 );
    ok( await ev( watches ) - n0 <= 1, "at most one watch request in 4 s while nothing changes" );

    console.log( "THE OTHER APPS: THEIR FILE SAVED ON THE PHONE, READ AGAIN BY ITSELF" );
    for( const [ app, p ] of [ [ "tasks", "data/tasks.json" ], [ "contact", "data/contacts.vcf" ],
                               [ "habits", "data/habits/habits.json" ], [ "bookmarks", "data/bookmarks/bookmarks.json" ] ] )
    {
        if( await go( `/nayive/${app}/index.html`, "document.readyState === 'complete' && " + reads( p ) + " > 0" ) < 0 )
        { ok( false, app + " opened and read " + p ); continue; }
        await sleep( 3000 );
        // The list scrolled part way: a re-read at any moment must not move it.
        const SCROLLER = `[ ...document.querySelectorAll( '*' ) ].filter( e => e.scrollHeight - e.clientHeight > 150 &&
                           /auto|scroll/.test( getComputedStyle( e ).overflowY ) ).sort( ( x, y ) => y.scrollHeight - x.scrollHeight )[ 0 ]`;
        const y0 = await ev( `( () => { const e = ${SCROLLER}; if( ! e ) return -1; e.scrollTop = 120; return e.scrollTop; } )()` );
        const before = await ev( reads( p ) );
        const body = await phone.get( p );
        ok( await phone.save( p, body ) === 200, app + ": the phone saved " + p + " again" );
        const t = await until( reads( p ) + " > " + before, 6000 );
        ok( t >= 0, app + ": the page read it again by itself" + took( t ) );
        await sleep( 600 );
        if( y0 > 0 )
        {
            const y1 = await ev( `( () => { const e = ${SCROLLER}; return e ? e.scrollTop : -1; } )()` );
            ok( y1 === y0, app + ": the list did not jump", { y0, y1 } );
        }
        else console.log( "  --   " + app + ": no scrolling list in the test data" );
    }

    console.log( "TASKS: THE PAGE'S OWN SAVE - NO READ BACK; A SECOND PAGE READS IT ONCE" );
    {
        // Every fetch the pages make, with its method (the store's PUTs too).
        const NET = `( () => { window.__net = []; const f = window.fetch;
            window.fetch = function( u, o ) { window.__net.push( ( ( o && o.method ) || 'GET' ) + ' ' + decodeURIComponent( String( u && u.url || u ) ) ); return f.apply( this, arguments ); }; } )()`;
        const P = "data/tasks.json";
        const count = ( m ) => `window.__net.filter( l => l.startsWith( ${JSON.stringify( m + " " )} ) && l.includes( 'file=' + ${JSON.stringify( P )} ) && ! l.includes( '/api/watch' ) ).length`;
        // Its own WINDOW: headless shows one tab per window, and a hidden page
        // holds no wait (by design).
        const made = await c.send( "Target.createTarget", { url: "about:blank", newWindow: true } );
        const tid  = made.result.targetId;
        const t2   = ( await ( await fetch( `http://127.0.0.1:${b.port}/json` ) ).json() ).find( x => x.id === tid );
        const c2   = await attach( t2.webSocketDebuggerUrl );
        for( const x of [ c, c2 ] )
        {
            await x.send( "Network.enable" );
            await x.send( "Network.setBypassServiceWorker", { bypass: true } );
            await x.send( "Page.addScriptToEvaluateOnNewDocument", { source: NET } );
        }
        const ev2 = x => c2.evaluate( x );
        const until2 = async ( x, ms ) => { const t0 = Date.now(); while( Date.now() - t0 < ms ) { if( await ev2( x ).catch( () => false ) ) return Date.now() - t0; await sleep( 100 ); } return -1; };
        await go( "/nayive/tasks/index.html", "document.readyState === 'complete' && !! window.__net && " + count( "GET" ) + " > 0" );
        await c2.send( "Page.navigate", { url: s.srv.base + "/nayive/tasks/index.html" } );
        await until2( "document.readyState === 'complete' && !! window.__net && " + count( "GET" ) + " > 0", 12000 );
        await sleep( 3000 );
        ok( await ev( "document.visibilityState" ) === "visible" && await ev2( "document.visibilityState" ) === "visible", "both pages are visible" );
        const a0 = { get: await ev( count( "GET" ) ), put: await ev( count( "PUT" ) ) };
        const b0 = { get: await ev2( count( "GET" ) ), put: await ev2( count( "PUT" ) ) };

        await ev( `( () => { const a = document.getElementById( 'addBtn' ); a.click(); const i = document.getElementById( 'newTaskInput' );
                    i.value = 'LIVE-OWN-1'; i.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Enter', bubbles: true } ) ); return true; } )()` );
        ok( await until( count( "PUT" ) + " > " + a0.put, 5000 ) >= 0, "page A saved the new task" );
        const tb = await until2( shows( "LIVE-OWN-1" ), 6000 );
        ok( tb >= 0, "page B shows it by itself" + took( tb ) );
        await sleep( 4000 );
        const a1 = { get: await ev( count( "GET" ) ), put: await ev( count( "PUT" ) ) };
        const b1 = { get: await ev2( count( "GET" ) ), put: await ev2( count( "PUT" ) ) };
        ok( a1.get === a0.get, "page A did not read its own save back", { a0, a1 } );
        ok( a1.put === a0.put + 1, "page A saved once", { a0, a1 } );
        ok( b1.get - b0.get === 1 && b1.put === b0.put, "page B read it once and saved nothing", { b0, b1 } );
        await c.send( "Target.closeTarget", { targetId: tid } );
    }

    console.log( "DESKTOP MODE: A CALENDAR WINDOW NOBODY CLICKS" );
    const wins = [ { url: "/nayive/calendar/index.html", l: "20px", t: "20px", w: "1000px", h: "600px" } ];
    await ev( `localStorage.setItem( 'balata-intro-dismiss:desktop', '1' ); localStorage.removeItem( 'balata-desktop-tile' );
               localStorage.setItem( 'balata-desktop-wins', ${JSON.stringify( JSON.stringify( wins ) )} ); true` );
    const frame = "document.querySelector( '#desk > .win iframe' )";
    const inFrame = x => `( () => { try { const d = ${frame}.contentDocument; return ${x}; } catch( e ) { return false; } } )()`;
    ok( await go( "/nayive/desktop/index.html", inFrame( "!! d.querySelector( '.fc-view-harness' ) && d.readyState === 'complete'" ), 15000 ) >= 0,
        "Calendar window is open on the desk" );
    await sleep( 3000 );
    ok( await phone.save( "data/calendar.ics", ics( "LIVE-PUSH-1", "LIVE-PUSH-2", "LIVE-PUSH-3" ) ) === 200, "the phone saved event 3" );
    const t3 = await until( inFrame( "d.body.innerText.includes( 'LIVE-PUSH-3' )" ), 6000 );
    ok( t3 >= 0, "event 3 shows in the desktop window by itself" + took( t3 ) );

    const errs = c.logs.filter( l => /EXCEPTION|LOG-ERROR/.test( l ) && ! /favicon|status of 40[134]/.test( l ) );
    ok( errs.length === 0, "no page errors", errs );
    s.srv.stop();

    console.log( "PLAIN HTTP (a dev box): NO WAIT HELD, A LOOK EVERY 10 S" );
    s = await setUp( b, false );
    ok( await s.go( "/nayive/calendar/index.html", CAL_READY ) >= 0, "Calendar is open" );
    await sleep( 3000 );
    ok( await s.phone.save( "data/calendar.ics", ics( "LIVE-HTTP" ) ) === 200, "the phone saved an event" );
    const t4 = await s.until( shows( "LIVE-HTTP" ), 13000 );
    ok( t4 >= 0, "it shows within 13 s" + took( t4 ) );
    const held = await s.ev( `performance.getEntriesByType('resource').filter( e => e.name.includes( '/api/watch' ) && e.duration > 2000 ).length` );
    ok( held === 0, "no watch request was held open", held );
}
finally
{
    await b.kill();
    if( s ) s.srv.stop();
}
console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
