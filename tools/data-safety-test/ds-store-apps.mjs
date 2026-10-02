// ds-store-apps.mjs - the REAL apps, one file open twice on one device
// (batch C4a: shared/store.js keeps each page's own version).
//
// A1 (store-core #1, office #1): Text, one document in two tabs (Drive opens
//     a new tab / desktop window per double-click). Tab B's autosave carried
//     tab A's version and replaced tab A's paragraph, both tabs showing
//     "Saved". Now tab B is asked (changed in another window) and tab A's
//     text stays.
// A2 (list-apps #1): Habits in its own page and in Planner's pane. The pane
//     ticked a habit from its older list and the habit the page had just
//     added was gone. Now the pane's save is refused and merged.
// E6 (list-apps #8): a habit added while a merge waits for a slow network
//     was only in the page's memory: the page closed, it was gone. Now it is
//     in the browser's storage at once.
import fs from "node:fs";
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { put, untilDisk } from "./office-lib.mjs";
import { seed, untilNode } from "./store-lib.mjs";

const s = await server();
const phone = await s.client();

//----------------------------------------------------------------------------//
section( "A1 · TEXT, ONE DOCUMENT IN TWO TABS" );
{
    put( s, "files/a.txt", "base\n" );
    const A = await browser( s );
    await A.evaluate( "localStorage.setItem( 'balata-intro-dismiss:text', '1' ), true" );
    const B = await A.tab();
    const CM  = "document.querySelector('.CodeMirror') && document.querySelector('.CodeMirror').CodeMirror";
    const val = c => c.evaluate( `( ${CM} ) ? ${CM}.getValue() : null` );
    const typeIn = ( c, t ) => c.evaluate( `${CM}.replaceRange( ${JSON.stringify( t )}, { line: 0, ch: 0 } ), true` );
    const conflictAsked = c => c.evaluate( "!! document.querySelector('.sheet-backdrop.open') && document.querySelector('.sheet-backdrop.open').textContent.indexOf( NayiveUI.t( 'ui.conflictTitle' ) ) !== -1" );

    await A.open( "/nayive/text/?file=files/a.txt", "/nayive/text/" );
    await B.open( "/nayive/text/?file=files/a.txt", "/nayive/text/" );
    ok( await A.until( `( ${CM} ) && ${CM}.getValue() === 'base\\n'`, 20000 ) && await B.until( `( ${CM} ) && ${CM}.getValue() === 'base\\n'`, 20000 ),
        "both tabs show the document" );

    // Each save is the app's own autosave (a 7 s timer): the disk is waited for.
    await typeIn( A, "A-line\n" );
    ok( ( await untilDisk( s, "files/a.txt", t => t === "A-line\nbase\n", 20000 ) ) === "A-line\nbase\n", "tab A's line is saved" );

    await typeIn( B, "B-line\n" );
    ok( await B.until( "document.getElementById('syncIndicator').dataset.syncState === 'conflict'", 20000 ),
        "tab B's save (made from the older text) is refused: its plug says so",
        await B.evaluate( "document.getElementById('syncIndicator').dataset.syncState" ) );
    ok( await B.until( "!! document.querySelector('.sheet-backdrop.open')", 5000 ) && await conflictAsked( B ),
        "tab B is asked: changed in another window or device - save yours as a copy?" );
    ok( onDisk( s, "files/a.txt" ) === "A-line\nbase\n", "tab A's line is still in the file", onDisk( s, "files/a.txt" ) );
    ok( ( await val( B ) ) === "B-line\nbase\n", "and tab B's line is still on its screen" );
    ok( ! await conflictAsked( A ), "tab A is not asked anything" );

    await typeIn( A, "A-again\n" );
    ok( ( await untilDisk( s, "files/a.txt", t => t === "A-again\nA-line\nbase\n", 20000 ) ) === "A-again\nA-line\nbase\n",
        "tab A goes on saving" );
    await A.stop();
}

//----------------------------------------------------------------------------//
section( "A2 · HABITS IN ITS PAGE AND IN PLANNER'S PANE" );
{
    const F = "data/habits/habits.json";
    const habit = ( id, name ) => ( { id, name, icon: "star", color: 0, days: [], target: null, created: "2026-09-01", archived: null, paused: [], done: [], counts: {} } );
    await seed( phone, F, JSON.stringify( [ habit( "h_a", "A" ) ], null, 2 ) );
    const names = () => { try { return JSON.parse( onDisk( s, F ) ).map( h => h.name + ( h.done.length ? "(done)" : "" ) ); } catch { return []; } };

    const H = await browser( s );
    await H.evaluate( "[ 'habits', 'planner', 'tasks', 'calendar' ].forEach( a => localStorage.setItem( 'balata-intro-dismiss:' + a, '1' ) ), true" );
    await H.open( "/nayive/habits/", "/nayive/habits/" );
    ok( await H.until( "document.querySelector('#dueList .habit-row')", 20000 ), "Habits is up" );
    const P = await H.tab();
    await P.open( "/nayive/planner/", "/nayive/planner/" );
    const PANE = "document.getElementById('habitsPane').contentDocument";
    ok( await P.until( `${PANE} && ${PANE}.querySelector('#dueList .habit-row')`, 30000 ), "Planner's Habits pane is up" );

    await H.evaluate( "document.getElementById('addBtn').click(), true" );
    await H.until( "document.getElementById('nameInput') && document.getElementById('nameInput').offsetParent !== null", 5000 );
    await H.evaluate( "document.getElementById('nameInput').value = 'B-from-page', document.getElementById('saveBtn').click(), true" );
    ok( await untilNode( () => names().includes( "B-from-page" ) ), "the page adds a habit: saved", names() );

    // The pane, untouched since it loaded, ticks habit A.
    await P.evaluate( `${PANE}.querySelector('#dueList .habit-row .check-btn').click(), true` );
    ok( await untilNode( () => names().includes( "A(done)" ) ), "the pane ticks A: saved", names() );
    ok( names().includes( "B-from-page" ), "and the page's new habit is still in the file", names() );
    ok( await P.until( `[ ...${PANE}.querySelectorAll('.habit-row .row-title') ].some( e => e.textContent === 'B-from-page' )` ),
        "the pane now shows it too (merged)" );

    // Both offline: the page adds a habit (it waits here), the pane ticks one
    // (its save is merged into the page's waiting one); back online, both go
    // up; then the page - which never re-read - adds one more.
    const OFF = "Object.defineProperty( navigator, 'onLine', { get: () => false, configurable: true } ), true";
    const ON  = "( delete navigator.onLine, window.dispatchEvent( new Event( 'online' ) ), true )";
    const PW  = "document.getElementById('habitsPane').contentWindow";
    // The page first re-reads (the plug's refresh): both pages start from the
    // file as it is now, so the pane's save is merged into the page's waiting
    // one and goes up as it is.
    await H.evaluate( "window.nayiveRefresh().then( () => true )" );
    await H.evaluate( OFF );
    await P.evaluate( `${PW}.eval( ${JSON.stringify( OFF )} )` );
    await H.evaluate( "document.getElementById('addBtn').click(), true" );
    await H.until( "document.getElementById('nameInput') && document.getElementById('nameInput').offsetParent !== null", 5000 );
    await H.evaluate( "document.getElementById('nameInput').value = 'D-offline-page', document.getElementById('saveBtn').click(), true" );
    ok( await H.until( `[ ...document.querySelectorAll('.habit-row .row-title') ].some( e => e.textContent === 'D-offline-page' )` ), "offline, the page adds a habit" );
    await P.evaluate( `( [ ...${PANE}.querySelectorAll('#dueList .habit-row') ].find( r => r.querySelector('.row-title').textContent === 'B-from-page' )
                         .querySelector('.check-btn').click(), true )` );
    await H.evaluate( ON );
    await P.evaluate( `${PW}.eval( ${JSON.stringify( ON )} )` );
    ok( await untilNode( () => { const n = names(); return n.includes( "D-offline-page" ) && n.includes( "B-from-page(done)" ) && n.includes( "A(done)" ); }, 20000 ),
        "back online: the page's habit and the pane's tick are both in the file", names() );
    await H.evaluate( "document.getElementById('addBtn').click(), true" );
    await H.until( "document.getElementById('nameInput') && document.getElementById('nameInput').offsetParent !== null", 5000 );
    await H.evaluate( "document.getElementById('nameInput').value = 'E-after', document.getElementById('saveBtn').click(), true" );
    ok( await untilNode( () => names().includes( "E-after" ), 20000 ) && names().includes( "B-from-page(done)" ) && names().includes( "D-offline-page" ),
        "the page saves once more: the pane's tick is still in the file", names() );
    await H.stop();
}

//----------------------------------------------------------------------------//
section( "E6 · A HABIT ADDED WHILE A MERGE WAITS FOR A SLOW NETWORK" );
{
    const F = "data/habits/habits.json";
    const habit = ( id, name ) => ( { id, name, icon: "star", color: 0, days: [], target: null, created: "2026-09-01", archived: null, paused: [], done: [], counts: {} } );
    await seed( phone, F, JSON.stringify( [ habit( "h_a", "A" ) ], null, 2 ) );
    const names = () => { try { return JSON.parse( onDisk( s, F ) ).map( h => h.name + ( h.done.length ? "(done)" : "" ) ); } catch { return []; } };

    const H = await browser( s, { width: 390, height: 800 } );
    await H.evaluate( "localStorage.setItem( 'balata-intro-dismiss:habits', '1' ), true" );
    await H.open( "/nayive/habits/", "/nayive/habits/" );
    ok( await H.until( "document.querySelector('#dueList .habit-row')", 20000 ), "Habits is up" );
    // From here on a GET of the file hangs (a train, a lift).
    await H.evaluate( `( () => { const f0 = window.fetch; window.hang = false; window.hung = 0;
        window.fetch = function ( u, o ) { if( window.hang && String( u ).includes( 'habits.json' ) && ( ! o || ! o.method || o.method === 'GET' ) ) { window.hung++; return new Promise( () => {} ); }
            return f0.apply( this, arguments ); }; } )(), true` );

    // The phone saves a new habit first.
    await seed( phone, F, JSON.stringify( [ habit( "h_a", "A" ), habit( "h_p", "P-from-phone" ) ], null, 2 ) );
    // This page ticks A: 412 -> the merge's GET hangs.
    await H.evaluate( "window.hang = true, document.querySelector('#dueList .habit-row .check-btn').click(), true" );
    ok( await H.until( "window.hung >= 1", 10000 ), "the tick's save met the phone's (412): the merge's GET hangs" );
    await H.evaluate( "document.getElementById('addBtn').click(), true" );
    await H.until( "document.getElementById('nameInput') && document.getElementById('nameInput').offsetParent !== null", 5000 );
    await H.evaluate( "document.getElementById('nameInput').value = 'Typed-while-merging', document.getElementById('saveBtn').click(), true" );
    ok( await H.until( `new Promise( res => { const q = indexedDB.open( 'nube-store' ); q.onsuccess = () => { const db = q.result,
            g = db.transaction( 'outbox' ).objectStore( 'outbox' ).get( '${F}' ); g.onsuccess = () => { db.close(); res( !! g.result && g.result.body.indexOf( 'Typed-while-merging' ) !== -1 ); }; }; } )`, 5000 ),
        "the habit typed meanwhile is in the browser's storage at once" );

    // The page is closed, then opened again.
    await H.send( "Page.navigate", { url: "about:blank" } );
    await H.open( "/nayive/habits/", "/nayive/habits/" );
    ok( await untilNode( () => { const n = names(); return n.includes( "Typed-while-merging" ) && n.includes( "P-from-phone" ) && n.includes( "A(done)" ); }, 20000 ),
        "reopened: the file has the tick, the phone's habit AND the one typed while merging", names() );
    await H.stop();
}

await done( s );
