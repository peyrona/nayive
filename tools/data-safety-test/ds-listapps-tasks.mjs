// ds-listapps-tasks.mjs - Tasks: ids that never repeat, and a sub-task being
// typed that survives a merge. The real app in Chromium; a second "device"
// over plain HTTP. Each case runs in its own browser profile (its own store):
// a save one case left queued must not flush over the next case's file.
//
// H8 (list-apps #25): the birthday and the trip-reminder syncs at boot both
//     wait for tasks-reminded.json and go on in the same tick: their tasks
//     once got the same id (ticking one ticked both, deleting one deleted both).
// E7 (list-apps #26): "+" on a task, a name typed while the previous save is
//     being merged with another device's: Enter still saves it - also when
//     the other device deleted that task meanwhile.
import { server, browser, ok, section, done, onDisk, sleep } from "./lib.mjs";

const s = await server();
const phone = await s.client();
const pages = [];

// The network the test steers, in the page: a GET whose address holds the
// text in window.__hold is held until window.__release() (the hold can be
// armed before the page loads, by localStorage 'ds-hold'). __release(ms)
// also stands the clock still for `ms` (window.__frozen meanwhile; see H8).
const STEER = `( () => {
    const realFetch = window.fetch, realNow = Date.now;
    let waiters = [];
    window.__hold = localStorage.getItem( 'ds-hold' ); localStorage.removeItem( 'ds-hold' );
    window.__held = 0; window.__done = []; window.__frozen = false;
    window.__release = function( ms ) {
        if( ms ) { const t = realNow(); Date.now = () => t; window.__frozen = true;
                   setTimeout( () => { Date.now = realNow; window.__frozen = false; }, ms ); }
        const w = waiters; waiters = []; window.__hold = null; w.forEach( f => f() );
    };
    window.fetch = function( u, o ) {
        const url = String( u && u.url || u ), get = ! o || ! o.method || o.method === 'GET';
        const go  = () => realFetch.call( window, u, o ).then( r => { window.__done.push( url ); return r; } );
        if( get && window.__hold && url.includes( window.__hold ) ) { window.__held++; return new Promise( r => waiters.push( r ) ).then( go ); }
        return go();
    };
} )()`;

const iso = d => d.getFullYear() + "-" + String( d.getMonth() + 1 ).padStart( 2, "0" ) + "-" + String( d.getDate() ).padStart( 2, "0" );
const today = new Date(), tomorrow = new Date( Date.now() + 86400000 ), later = new Date( Date.now() + 3 * 86400000 );

// A fresh browser profile on the tasks app. syncs: false = today's birthday and
// trip syncs count as done already on this device (they stay out of the case).
async function tasksPage( { hold = null, syncs = false } = {} )
{
    const c = await browser( s );
    pages.push( c );
    await c.evaluate( `localStorage.setItem( 'balata-intro-dismiss:tasks', '1' );
        ${ hold ? `localStorage.setItem( 'ds-hold', ${JSON.stringify( hold )} );` : "" }
        ${ syncs ? "" : `localStorage.setItem( 'tasks_birthday_sync_date', ${JSON.stringify( iso( today ) )} );
                         localStorage.setItem( 'tasks_trip_sync_date', ${JSON.stringify( iso( today ) )} );` } true` );
    await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: STEER } );
    await c.open( "/nayive/tasks/" );
    return c;
}
const seed = async ( rel, body ) => { const r = await phone.put( rel, body ); if( r.status !== 200 ) throw new Error( "seed " + rel + ": " + r.status ); };
const json = rel => { try { return JSON.parse( onDisk( s, rel ) ); } catch { return null; } };
async function disk( fn, ms = 15000 )
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( fn() ) return true; } catch {} await sleep( 100 ); }
    return false;
}
const F = "data/tasks.json";
const groups = "[...document.querySelectorAll( '.task-group' )]";

//------------------------------------------------------------------------//
section( "H8 · A BIRTHDAY AND A TRIP REMINDER MADE IN ONE TICK" );
{
    await seed( "data/contacts.vcf", [ "BEGIN:VCARD", "VERSION:3.0", "UID:b1", "FN:Berta Gil", "N:Gil;Berta;;;",
                                       "BDAY:--" + iso( today ).slice( 5 ), "END:VCARD", "" ].join( "\r\n" ) );
    await seed( "data/trips/roma-2026/trip.json", JSON.stringify( { id: 4242, destination: "Roma", dirName: "roma-2026",
        startDate: iso( tomorrow ), endDate: iso( later ), stages: [], documents: [] } ) );

    // Both syncs reach tasks-reminded.json while its GET is held; it is let go
    // once both have read what they need, so both go on in the same tick. The
    // clock stands still for that moment: the race needs both tasks made in
    // one millisecond, and the list is drawn in between.
    const c = await tasksPage( { hold: "tasks-reminded.json", syncs: true } );
    ok( await c.until( "window.__held === 1 && window.__done.some( u => u.includes( 'contacts.vcf' ) ) && window.__done.some( u => u.includes( 'trip.json' ) )" ),
        "both syncs wait for the reminders file" );
    await c.evaluate( "new Promise( r => setTimeout( r, 0 ) )" );   // their last steps after those reads, in this same turn
    await c.evaluate( "window.__release( 400 ); true" );
    ok( await c.until( `${groups}.length === 2` ), "two tasks: the birthday and the trip" );
    const ids = await c.evaluate( `${groups}.map( g => g.dataset.taskId )` );
    ok( ids.length === 2 && ids[ 0 ] !== ids[ 1 ], "...each with its own id on screen", ids );

    // A save once the clock runs again (with it stood still, two saves carry one
    // queue time and the store may settle both with the first PUT - a test
    // artifact): tick the first task. It must tick that one only, and the file
    // must hold two ids.
    await c.until( "! window.__frozen" );
    await c.evaluate( `${groups}[ 0 ].querySelector( '.icon-btn.check' ).click(); true` );
    ok( await disk( () => { const t = json( F ); return t && t.length === 2 && t.some( x => x.done ); } ), "the tick is saved", json( F ) );
    const saved = json( F ) || [];
    ok( new Set( saved.map( t => t.id ) ).size === 2, "...two ids in the file", saved.map( t => t.id ) );
    ok( saved.filter( t => t.done ).length === 1, "...and the tick ticked one task, not both", saved );
    await c.stop();
}

section( "H8 · IDS AN OLDER BUILD REPEATED ARE MADE UNIQUE ON LOAD" );
{
    await seed( F, JSON.stringify( [ { id: 77, text: "One", done: false, subtasks: [] },
                                     { id: 77, text: "Two", done: false, subtasks: [] } ], null, 2 ) );
    const c = await tasksPage();
    ok( await c.until( `${groups}.length === 2` ), "both tasks show" );
    const ids = await c.evaluate( `${groups}.map( g => g.dataset.taskId )` );
    ok( ids[ 0 ] !== ids[ 1 ], "...with two ids now", ids );
    await c.evaluate( `${groups}.find( g => g.textContent.includes( 'One' ) ).querySelector( '.icon-btn.check' ).click(); true` );
    ok( await disk( () => ( json( F ) || [] ).some( x => x.done ) ), "ticking One is saved" );
    const saved = json( F ) || [];
    ok( new Set( saved.map( t => t.id ) ).size === 2 && saved.filter( t => t.done ).map( t => t.text ).join() === "One",
        "...the file has two ids, and only One is ticked", saved );
    await c.stop();
}

//------------------------------------------------------------------------//
// "+" on Alpha while Bravo's tick is being merged with the phone's save (its
// GET held), type the sub-task, let the merge land, Enter. `phoneDo` is what
// the phone did to the list first.
async function typeWhileMerging( phoneDo )
{
    await seed( F, JSON.stringify( [ { id: 1, text: "Alpha", done: false, subtasks: [] }, { id: 2, text: "Bravo", done: false, subtasks: [] } ], null, 2 ) );
    const c = await tasksPage();
    ok( await c.until( `${groups}.length === 2` ), "two tasks" );

    const r = await phone.get( F );
    ok( ( await phone.put( F, JSON.stringify( phoneDo( JSON.parse( r.text ) ), null, 2 ), { "If-Unmodified-Since": r.headers.get( "last-modified" ) } ) ).status === 200,
        "the phone saves its change" );

    // Tick Bravo: its save meets the phone's (412) and the merge's GET is held.
    await c.evaluate( "window.__hold = 'data%2Ftasks.json'; window.__held = 0; true" );
    await c.evaluate( "document.querySelector( '.task-group[data-task-id=\"2\"] .icon-btn.check' ).click(); true" );
    ok( await c.until( "window.__held === 1" ), "the merge is out" );

    await c.evaluate( "document.querySelector( '.task-group[data-task-id=\"1\"] .icon-btn.check' ).nextElementSibling.click(); true" );
    ok( await c.until( "document.activeElement && document.activeElement.classList.contains( 'subtask-edit-input' )" ), "the new sub-task's field is open" );
    await c.send( "Input.insertText", { text: "Milk" } );
    await c.evaluate( "window.__release(); true" );
    return c;
}

section( "E7 · A SUB-TASK TYPED WHILE A MERGE LANDS" );
{
    const c = await typeWhileMerging( t => { t.push( { id: 3, text: "Phone", done: false, subtasks: [] } ); return t; } );
    // Landed = the merged list went up: the phone's task AND this tick in one file.
    ok( await disk( () => { const l = json( F ) || []; return l.some( x => x.id === 3 ) && l.some( x => x.id === 2 && x.done ); } ), "the merge landed (the phone's task + the tick)" );
    await c.evaluate( "document.activeElement.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Enter', bubbles: true } ) ); true" );
    ok( await disk( () => { const a = ( json( F ) || [] ).find( x => x.id === 1 ); return a && ( a.subtasks || [] ).some( x => x.text === "Milk" ); } ),
        "Enter: the typed sub-task is saved", json( F ) );
    const all = json( F ) || [];
    ok( all.some( x => x.id === 3 ) && all.find( x => x.id === 2 ).done === true, "...and the phone's task and the tick are kept" );
    await c.stop();
}

section( "E7 · ...WHEN THE OTHER DEVICE DELETED THAT TASK MEANWHILE" );
{
    const c = await typeWhileMerging( t => t.filter( x => x.id !== 1 ) );
    ok( await disk( () => { const l = json( F ) || []; return ! l.some( x => x.id === 1 ) && l.some( x => x.id === 2 && x.done ); } ), "the merge landed (Alpha gone, the tick in)" );
    await c.evaluate( "document.activeElement.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Enter', bubbles: true } ) ); true" );
    ok( await disk( () => { const a = ( json( F ) || [] ).find( x => x.id === 1 ); return a && ( a.subtasks || [] ).some( x => x.text === "Milk" ); } ),
        "Enter: Alpha comes back with the typed sub-task", json( F ) );
    await c.stop();
}

await done( ...pages, s );
