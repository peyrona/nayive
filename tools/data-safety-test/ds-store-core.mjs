// ds-store-core.mjs - shared/store.js keeps each page's OWN version and never
// saves blind (batch C4a). The real store.js on a bare page (store-lib.mjs),
// two tabs of one browser, and "the phone" over plain HTTP.
//
// A1/A2 (store-core #1, office #1, list-apps #1): two tabs - the second one's
//     save used to carry the first one's version (the shared cache's) and
//     silently replace its work. Now: a merging store merges both, a
//     conflicts store gets the conflict and the first tab's work stays.
// K2 (store-core #2): the browser's storage failing never answers "saved"
//     with nothing sent.
// K3 (store-core #3): another tab's read never replaces this tab's unsent
//     edit in the cache.
// K4 (store-core #4): one transaction for the cache and the outbox; a dirty
//     cache with nothing queued is queued again by a read.
// K5 (office #17, list-apps #29, store side): a save that vanished before it
//     was sent (a sign-out in another tab) is not "saved".
// Needs of earlier batches: store.pending(), store.onSaved(), clearLocal()
//     also empties eMail's files and Chat's typed drafts.
import { server, browser, ok, section, done, onDisk } from "./lib.mjs";
import { stPage, seed, untilNode } from "./store-lib.mjs";

const s = await server();
stPage( s );
const phone = await s.client();
const A = await browser( s );
await A.open( "/nayive/st.html" );
const B = await A.tab();
await B.open( "/nayive/st.html" );

const disk = rel => onDisk( s, rel );
const ids  = rel => { try { return JSON.parse( disk( rel ) ).map( x => x.id ); } catch { return null; } };

//----------------------------------------------------------------------------//
section( "A2 · ONE LIST IN TWO TABS (MERGING STORE)" );
{
    const F = "data/t/list.json";
    await seed( phone, F, '[{"id":"a"}]' );
    for( const c of [ A, B ] ) await c.evaluate( `SM.read( '${F}' ).then( r => { M.list = JSON.parse( r.body ); return true; } )` );
    const ra = JSON.parse( await A.evaluate( `( M.list.push( { id: 'x-from-A' } ), J( SM.write( '${F}', JSON.stringify( M.list ) ) ) )` ) );
    ok( ra.ok && ids( F ).join() === "a,x-from-A", "tab A's save is on the server", { ra, disk: disk( F ) } );
    const rb = JSON.parse( await B.evaluate( `( M.list.push( { id: 'y-from-B' } ), J( SM.write( '${F}', JSON.stringify( M.list ) ) ) )` ) );
    const got = ids( F ) || [];
    ok( rb.ok && got.includes( "x-from-A" ) && got.includes( "y-from-B" ),
        "tab B's save (made from the older list) keeps tab A's item: both are on the server", { rb, disk: disk( F ) } );
    ok( await B.evaluate( `LOG.some( l => l.put === '${F}' && l.st === 412 )` ), "tab B's first PUT was refused (412): it carried ITS version, not tab A's",
        await B.evaluate( "LOG" ) );
    ok( await B.evaluate( `EV.some( e => e.merged === '${F}' && e.body.indexOf( 'x-from-A' ) !== -1 )` ), "and tab B's app was handed the merged list" );

    // Both offline: tab B's save meets tab A's in the outbox (one per path).
    const G = "data/t/list-off.json";
    await seed( phone, G, '[{"id":"a"}]' );
    for( const c of [ A, B ] ) await c.evaluate( `SM.read( '${G}' ).then( r => { M.off = JSON.parse( r.body ); EV.length = 0; return offline( true ); } )` );
    const qa = JSON.parse( await A.evaluate( `( M.off.push( { id: 'x-offline-A' } ), J( SM.write( '${G}', JSON.stringify( M.off ) ) ) )` ) );
    const qb = JSON.parse( await B.evaluate( `( M.off.push( { id: 'y-offline-B' } ), J( SM.write( '${G}', JSON.stringify( M.off ) ) ) )` ) );
    ok( qa.offline && qb.offline, "both saves wait (offline)", { qa, qb } );
    const box = await B.evaluate( `idb( 'outbox', '${G}' )` );
    ok( box && box.body.indexOf( "x-offline-A" ) !== -1 && box.body.indexOf( "y-offline-B" ) !== -1,
        "tab B's save did not replace tab A's: the outbox holds both", box && box.body );
    ok( await B.evaluate( `EV.some( e => e.merged === '${G}' && e.body.indexOf( 'x-offline-A' ) !== -1 )` ), "and tab B's app shows both" );
    for( const c of [ A, B ] ) await c.evaluate( "offline( false )" );
    await B.evaluate( "SM.flush().then( () => true )" );
    ok( await untilNode( () => { const g = ids( G ) || []; return g.includes( "x-offline-A" ) && g.includes( "y-offline-B" ); } ), "both go up", disk( G ) );
    ok( await A.until( `EV.some( e => e.merged === '${G}' && e.body.indexOf( 'y-offline-B' ) !== -1 )` ),
        "tab A, whose save tab B merged into, is handed the merged list too" );
    // Tab A's own list (this test page does not take the merged one in) saves
    // once more: what tab B merged in must survive it.
    const qa2 = JSON.parse( await A.evaluate( `( M.off.push( { id: 'z-A-again' } ), J( SM.write( '${G}', JSON.stringify( M.off ) ) ) )` ) );
    ok( await untilNode( () => ( ids( G ) || [] ).includes( "z-A-again" ) ) && ( ids( G ) || [] ).includes( "y-offline-B" ),
        "tab A saves again: tab B's item is still in the file", { qa2, disk: disk( G ) } );

    // A phone saves while tab A's save waits; tab B sends and merges it; tab A
    // (its model still the old one) saves again.
    const H = "data/t/list-other.json";
    await seed( phone, H, '[{"id":"a"}]' );
    for( const c of [ A, B ] ) await c.evaluate( `SM.read( '${H}' ).then( r => { M.oth = JSON.parse( r.body ); EV.length = 0; return true; } )` );
    const w1 = JSON.parse( await A.evaluate( `( offline( true ), M.oth.push( { id: 'A1' } ), J( SM.write( '${H}', JSON.stringify( M.oth ) ) ) )` ) );
    ok( w1.offline, "tab A's save waits", w1 );
    await seed( phone, H, '[{"id":"a"},{"id":"P"}]' );
    await A.evaluate( "offline( false )" );
    await B.evaluate( "SM.flush().then( () => true )" );
    ok( await untilNode( () => { const g = ids( H ) || []; return g.length === 3 && g.includes( "A1" ) && g.includes( "P" ); } ), "tab B sends it, merged with the phone's", disk( H ) );
    ok( await A.until( `EV.some( e => e.merged === '${H}' && e.body.indexOf( '"P"' ) !== -1 )` ), "tab A is handed the merged list" );
    const w2 = JSON.parse( await A.evaluate( `( M.oth.push( { id: 'A2' } ), J( SM.write( '${H}', JSON.stringify( M.oth ) ) ) )` ) );
    ok( await untilNode( () => ( ids( H ) || [] ).includes( "A2" ) ) && ( ids( H ) || [] ).includes( "P" ),
        "tab A saves again from its older list: the phone's item is still in the file", { w2, disk: disk( H ) } );
}

//----------------------------------------------------------------------------//
section( "A3 · A PLAIN STORE (DRIVE'S IMPORT) BUILDS ON A WAITING SAVE" );
{
    // Tab A (the list's own app) saves offline; tab B (Drive's import, a plain
    // store) reads it - the waiting save - adds to it and saves; it goes up.
    // Tab A, its list never re-read, saves again: the import must stay.
    const F = "data/t/imported.json";
    await seed( phone, F, '[{"id":"a"}]' );
    await A.evaluate( `SM.read( '${F}' ).then( r => { M.imp = JSON.parse( r.body ); EV.length = 0; return true; } )` );
    const qa = JSON.parse( await A.evaluate( `( offline( true ), M.imp.push( { id: 'x-app' } ), J( SM.write( '${F}', JSON.stringify( M.imp ) ) ) )` ) );
    ok( qa.offline, "the app's save waits", qa );
    await A.evaluate( "offline( false )" );
    const rb = await B.evaluate( `SP.read( '${F}' ).then( r => r.body )` );
    ok( String( rb ).indexOf( "x-app" ) !== -1, "the import reads the waiting save", rb );
    await B.evaluate( `SP.write( '${F}', JSON.stringify( JSON.parse( ${JSON.stringify( rb )} ).concat( [ { id: 'imported' } ] ) ) ).then( () => true )` );
    ok( await untilNode( () => ( ids( F ) || [] ).join() === "a,x-app,imported" ), "and its save goes up with it", disk( F ) );
    const wa = JSON.parse( await A.evaluate( `( M.imp.push( { id: 'y-app' } ), J( SM.write( '${F}', JSON.stringify( M.imp ) ) ) )` ) );
    ok( await untilNode( () => ( ids( F ) || [] ).includes( "y-app" ) ) && ( ids( F ) || [] ).includes( "imported" ),
        "the app saves again from its older list: the import is still in the file (checked, merged - not blind)", { wa, disk: disk( F ) } );
}

//----------------------------------------------------------------------------//
section( "A1 · ONE DOCUMENT IN TWO TABS (CONFLICTS STORE)" );
{
    const F = "files/doc.txt";
    await seed( phone, F, "v0\n" );
    for( const c of [ A, B ] ) await c.evaluate( `SC.read( '${F}' ).then( r => { M.doc = r.body; return true; } )` );
    await A.evaluate( "EV.length = 0, true" );
    await B.evaluate( "EV.length = 0, true" );
    const ra = JSON.parse( await A.evaluate( `J( SC.write( '${F}', M.doc + 'typed in tab A\\n' ) )` ) );
    ok( ra.ok && disk( F ) === "v0\ntyped in tab A\n", "tab A's paragraph is saved", { ra, disk: disk( F ) } );
    const rb = JSON.parse( await B.evaluate( `J( SC.write( '${F}', M.doc + 'typed in tab B\\n' ) )` ) );
    ok( rb.conflict === true && ! rb.ok, "tab B's save, made from the older text, is refused as a conflict", rb );
    ok( disk( F ) === "v0\ntyped in tab A\n", "tab A's paragraph is still on the server", disk( F ) );
    ok( await B.evaluate( "EV.some( e => e.conflict )" ) && ! await A.evaluate( "EV.some( e => e.conflict )" ),
        "only tab B is asked about it (onConflict), not tab A" );
    const held = await A.evaluate( `idb( 'outbox', '${F}' )` );
    ok( held && held.conflict && held.body === "v0\ntyped in tab B\n", "tab B's text is kept, held back, in the outbox", held );
    const ra2 = JSON.parse( await A.evaluate( `J( SC.write( '${F}', M.doc + 'typed in tab A\\nmore in tab A\\n' ) )` ) );
    ok( ra2.ok && disk( F ) === "v0\ntyped in tab A\nmore in tab A\n", "tab A goes on saving: tab B's held text does not block it", { ra2, disk: disk( F ) } );
    ok( await A.evaluate( "SC.state !== 'conflict' && SM.state !== 'conflict'" ) && await B.evaluate( "SC.state === 'conflict'" ),
        "only tab B's plug says conflict", { A: await A.evaluate( "SC.state" ), B: await B.evaluate( "SC.state" ) } );
    ok( ! await A.evaluate( `SC.conflicted( '${F}' )` ) && await B.evaluate( `SC.conflicted( '${F}' )` ),
        "conflicted() is tab B's alone" );
    const still = await A.evaluate( `idb( 'outbox', '${F}' )` );
    ok( still && still.body === "v0\ntyped in tab B\n", "and tab B's text is still kept", still );

    // Both offline: tab B's save meets tab A's waiting one.
    const G = "files/doc-off.txt";
    await seed( phone, G, "o0\n" );
    for( const c of [ A, B ] ) await c.evaluate( `SC.read( '${G}' ).then( r => { M.off = r.body; EV.length = 0; return offline( true ); } )` );
    const qa = JSON.parse( await A.evaluate( `J( SC.write( '${G}', M.off + 'offline in tab A\\n' ) )` ) );
    const qb = JSON.parse( await B.evaluate( `J( SC.write( '${G}', M.off + 'offline in tab B\\n' ) )` ) );
    ok( qa.offline, "tab A's save waits in the outbox", qa );
    ok( ! qb.ok && qb.pageOnly && ! qb.offline, "tab B's waits in tab B (NOT \"saved\": it is in that page only)", qb );
    ok( await B.evaluate( "SC.state === 'error'" ), "and tab B's plug says so (not \"offline - saved when you reconnect\")",
        await B.evaluate( "SC.state" ) );
    const box = await B.evaluate( `idb( 'outbox', '${G}' )` );
    ok( box && box.body === "o0\noffline in tab A\n", "tab A's waiting save was not replaced", box && box.body );
    for( const c of [ A, B ] ) await c.evaluate( "offline( false )" );
    await B.evaluate( "SC.flush().then( () => true )" );
    await A.evaluate( "SC.flush().then( () => true )" );
    ok( await untilNode( () => disk( G ) === "o0\noffline in tab B\n" ), "the first to reach the server is saved", disk( G ) );
    ok( await A.until( "EV.some( e => e.conflict )" ) && await A.evaluate( `SC.conflicted( '${G}' )` ),
        "the second gets the conflict question - and keeps its text", await A.evaluate( `idb( 'outbox', '${G}' )` ) );
}

//----------------------------------------------------------------------------//
section( "A1 · TWO SAVES OF ONE TAB WHILE THE FIRST IS STILL ON ITS WAY" );
{
    const F = "files/chain.txt";
    await seed( phone, F, "c0\n" );
    await A.evaluate( `SC.read( '${F}' ).then( () => true )` );
    await A.evaluate( `EV.length = 0, held = 0, hold( 'PUT', 'chain.txt' ), window.w1 = J( SC.write( '${F}', 'c1\\n' ) ), true` );
    ok( await A.until( "held === 1" ), "the first save's PUT is on its way (held)" );
    await A.evaluate( `window.w2 = J( SC.write( '${F}', 'c2\\n' ) ), true` );
    await A.evaluate( "release(), true" );
    const r1 = JSON.parse( await A.evaluate( "w1" ) ), r2 = JSON.parse( await A.evaluate( "w2" ) );
    ok( r1.ok && r2.ok && disk( F ) === "c2\n", "both are saved, the second last (no false conflict)", { r1, r2, disk: disk( F ) } );
    ok( ! await A.evaluate( "EV.some( e => e.conflict )" ), "no conflict was raised" );
}

//----------------------------------------------------------------------------//
section( "A1 · TWO SAVES OF ONE TAB, SENT DIRECTLY (ANOTHER TAB'S SAVE WAITS)" );
{
    // Tab B's save waits in the outbox, so tab A's go up on their own. The
    // answer to tab A's first one arrives just while its second one is being
    // stored: the second must not be refused against the first.
    const F = "files/direct2.txt";
    await seed( phone, F, "v0\n" );
    for( const c of [ A, B ] ) await c.evaluate( `SC.read( '${F}' ).then( () => ( EV.length = 0, LOG.length = 0, true ) )` );
    await B.evaluate( `( offline( true ), SC.write( '${F}', 'v0\\nB\\n' ).then( () => offline( false ) ) )` );
    await A.evaluate( `( () => { const f1 = window.fetch; window.ah = null; window.after = false;
        window.fetch = async function ( u, o ) { const r = await f1.apply( this, arguments );
            if( window.after && o && o.method === 'PUT' ) { window.after = false; await new Promise( res => { window.ah = res; } ); }
            return r; };
        const t0 = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function () { if( window.relOnTx && window.ah ) { window.relOnTx = false; const a = window.ah; window.ah = null; a(); } return t0.apply( this, arguments ); };
        return true; } )()` );
    await A.evaluate( `window.after = true, window.p1 = J( SC.write( '${F}', 'v0\\nA1\\n' ) ), true` );
    ok( await A.until( "!! window.ah" ), "tab A's first save is answered (the answer held)" );
    await A.evaluate( `window.relOnTx = true, window.p2 = J( SC.write( '${F}', 'v0\\nA1\\nA2\\n' ) ), true` );
    const p1 = JSON.parse( await A.evaluate( "p1" ) ), p2 = JSON.parse( await A.evaluate( "p2" ) );
    ok( p1.ok && p2.ok && disk( F ) === "v0\nA1\nA2\n", "both go up, the second last: no conflict against itself", { p1, p2, disk: disk( F ) } );
    ok( ! await A.evaluate( `EV.some( e => e.conflict === '${F}' )` ), "and tab A is asked nothing" );
}

//----------------------------------------------------------------------------//
section( "A1 · TWO TABS SEND ONE SAVE AT THE SAME MOMENT" );
{
    const F = "files/both.txt";
    await seed( phone, F, "b0\n" );
    for( const c of [ A, B ] ) await c.evaluate( `SC.read( '${F}' ).then( () => ( EV.length = 0, true ) )` );
    const q = JSON.parse( await A.evaluate( `( offline( true ), J( SC.write( '${F}', 'b0\\nqueued in tab A\\n' ) ).then( r => ( offline( false ), r ) ) )` ) );
    ok( q.offline, "tab A's save waits (offline)", q );
    await Promise.all( [ A.evaluate( "SC.flush().then( () => true )" ), B.evaluate( "SC.flush().then( () => true )" ) ] );
    ok( await untilNode( () => disk( F ) === "b0\nqueued in tab A\n" ), "it is on the server", disk( F ) );
    ok( ! await A.evaluate( `EV.some( e => e.conflict === '${F}' )` ) && ! await B.evaluate( `EV.some( e => e.conflict === '${F}' )` ),
        "and no tab heard a false \"changed on another device\"" );
    const r = JSON.parse( await A.evaluate( `J( SC.write( '${F}', 'b0\\nqueued in tab A\\nnext\\n' ) )` ) );
    ok( r.ok && disk( F ) === "b0\nqueued in tab A\nnext\n", "tab A's next save goes up (its version moved with the save, whoever sent it)", { r, disk: disk( F ) } );
}

//----------------------------------------------------------------------------//
section( "K2 · THE BROWSER'S STORAGE FAILS" );
{
    const F = "data/t/k2.json";
    await seed( phone, F, '[{"id":"a"}]' );
    await A.evaluate( `SM.read( '${F}' ).then( () => true )` );
    const r1 = JSON.parse( await A.evaluate( `( () => { const real = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function () { throw new DOMException( 'Connection to Indexed Database server lost.', 'UnknownError' ); };
        return J( SM.write( '${F}', JSON.stringify( [ { id: 'a' }, { id: 'saved-while-idb-is-broken' } ] ) ) )
               .then( r => { IDBDatabase.prototype.transaction = real; return r; } ); } )()` ) );
    ok( r1.ok && ( ids( F ) || [] ).includes( "saved-while-idb-is-broken" ),
        "storage lost: the save goes up directly (and only then says ok)", { r1, disk: disk( F ) } );

    const r2 = JSON.parse( await A.evaluate( `( () => { const real = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () { throw new DOMException( 'The quota has been exceeded.', 'QuotaExceededError' ); };
        return J( SC.write( 'files/new-doc.txt', 'a new document written when the disk is full' ) )
               .then( r => { IDBObjectStore.prototype.put = real; return r; } ); } )()` ) );
    ok( r2.ok && disk( "files/new-doc.txt" ) === "a new document written when the disk is full",
        "disk full: the new document goes up all the same", { r2, disk: disk( "files/new-doc.txt" ) } );

    const r3 = JSON.parse( await A.evaluate( `( () => { const real = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function () { throw new DOMException( 'Connection to Indexed Database server lost.', 'UnknownError' ); };
        netDown = true;
        return SM.write( '${F}', JSON.stringify( [ { id: 'a' }, { id: 'saved-while-idb-is-broken' }, { id: 'kept-in-the-page' } ] ) )
               .then( r => { const ev = new Event( 'beforeunload', { cancelable: true } ); window.dispatchEvent( ev );
                             r.guard = ev.defaultPrevented; IDBDatabase.prototype.transaction = real; netDown = false; return JSON.stringify( r ); } ); } )()` ) );
    ok( ! r3.ok && r3.pageOnly && ! r3.offline && ! r3.needsAuth,
        "storage AND network down: NOT saved (pageOnly, none of offline / needsAuth - the apps' \"safe here\")", r3 );
    ok( r3.guard === true, "and leaving that page asks first (the edit is only there)", r3 );
    ok( await A.evaluate( `SM.read( '${F}' ).then( r => r.body.indexOf( 'kept-in-the-page' ) !== -1 )` ), "a read in that page still shows the edit" );
    await A.evaluate( "SM.flush().then( () => true )" );   // (a flush already running answers at once: the disk is waited for)
    ok( await untilNode( () => ( ids( F ) || [] ).includes( "kept-in-the-page" ) ), "and it goes up once the network is back", disk( F ) );
    ok( await A.until( "( () => { const ev = new Event( 'beforeunload', { cancelable: true } ); window.dispatchEvent( ev ); return ! ev.defaultPrevented; } )()" ),
        "...after which leaving asks nothing" );
}

//----------------------------------------------------------------------------//
section( "K3 · ANOTHER TAB'S READ AND THIS TAB'S UNSENT EDIT" );
{
    const F = "data/t/k3.json";
    await seed( phone, F, '[{"id":"a"}]' );
    for( const c of [ A, B ] ) await c.evaluate( `SM.read( '${F}' ).then( r => { M.k3 = JSON.parse( r.body ); return true; } )` );
    await A.evaluate( `held = 0, hold( 'GET', 'k3.json' ), window.rd = SM.read( '${F}' ), true` );
    ok( await A.until( "held === 1" ), "tab A's read is out (held)" );
    const w = JSON.parse( await B.evaluate( `( offline( true ), M.k3.push( { id: 'b-unsent' } ), J( SM.write( '${F}', JSON.stringify( M.k3 ) ) ) )` ) );
    ok( w.offline, "tab B's edit waits to go up", w );
    await A.evaluate( "release(), rd.then( () => true )" );
    const doc = await B.evaluate( `idb( 'docs', '${F}' )` );
    ok( doc && doc.body.indexOf( "b-unsent" ) !== -1, "the cached copy still holds tab B's edit after tab A's read", doc && doc.body );
    ok( await B.evaluate( `SM.read( '${F}' ).then( r => r.body.indexOf( 'b-unsent' ) !== -1 )` ), "tab B reading again still shows its edit" );
    await B.evaluate( "offline( false ), SM.flush().then( () => true )" );
    ok( await untilNode( () => ( ids( F ) || [] ).includes( "b-unsent" ) ), "and it goes up", disk( F ) );
}

//----------------------------------------------------------------------------//
section( "K4 · THE CACHE AND THE OUTBOX IN ONE STEP" );
{
    const F = "data/t/k4.json";
    await seed( phone, F, '[{"id":"a"}]' );
    await A.evaluate( `SM.read( '${F}' ).then( () => true )` );
    // The outbox step fails, the cache step does not: with two steps, the
    // cache said "dirty" and nothing was queued - and write() answered ok.
    const r = JSON.parse( await A.evaluate( `( () => { const real = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function ( v ) { if( this.name === 'outbox' ) throw new DOMException( 'The quota has been exceeded.', 'QuotaExceededError' ); return real.apply( this, arguments ); };
        return J( SM.write( '${F}', JSON.stringify( [ { id: 'a' }, { id: 'half-stored' } ] ) ) )
               .then( r => { IDBObjectStore.prototype.put = real; return r; } ); } )()` ) );
    ok( r.ok && ( ids( F ) || [] ).includes( "half-stored" ), "half of it failing: the save is not lost (it went up directly)", { r, disk: disk( F ) } );

    // A cached copy left dirty with nothing queued (an older store.js stored a
    // save in two steps, and the tab died in between): queued again on read.
    const G = "data/t/k4b.json";
    const put = await seed( phone, G, '[{"id":"a"}]' );
    const lm  = Date.parse( put.headers.get( "Last-Modified" ) );
    await B.evaluate( `idbPut( 'docs', { path: '${G}', body: JSON.stringify( [ { id: 'a' }, { id: 'kept-across-a-crash' } ] ), mtime: Date.now(),
        cachedAt: Date.now(), dirty: true, srv: ${lm}, base: '[{"id":"a"}]', who: NayiveStore.me } )` );
    const rd = await B.evaluate( `SM.read( '${G}' ).then( r => r.body )` );
    ok( String( rd ).indexOf( "kept-across-a-crash" ) !== -1, "the read shows the edit, not the older server copy", rd );
    await B.evaluate( "SM.flush().then( () => true )" );
    ok( await untilNode( () => ( ids( G ) || [] ).includes( "kept-across-a-crash" ) ), "and sends it", disk( G ) );
}

//----------------------------------------------------------------------------//
section( "K5 · A SAVE CLEARED BEFORE IT WAS SENT" );
{
    const F = "files/k5.txt";
    await seed( phone, F, "k0\n" );
    await A.evaluate( `SC.read( '${F}' ).then( () => true )` );
    await A.evaluate( `held = 0, hold( 'PUT', 'k5.txt' ), window.w1 = J( SC.write( '${F}', 'k1\\n' ) ), true` );
    ok( await A.until( "held === 1" ), "a save is on its way (held)" );
    await A.evaluate( `window.w2 = J( SC.write( '${F}', 'k2\\n' ) ), true` );
    ok( await A.until( `idb( 'outbox', '${F}' ).then( e => !! e && e.body === 'k2\\n' )` ), "the next one waits in the outbox" );
    // A sign-out in another tab counts and clears it (the user said yes).
    await B.evaluate( "NayiveStore.localCount().then( () => NayiveStore.clearLocal() ).then( () => true )" );
    await A.evaluate( "release(), true" );
    const r2 = JSON.parse( await A.evaluate( "w2" ) );
    ok( ! r2.ok && ! r2.offline && ! r2.needsAuth, "the cleared save does not answer \"saved\"", r2 );
}

//----------------------------------------------------------------------------//
section( "PENDING / ONSAVED / SIGN-OUT CLEARS ALL (needs of earlier batches)" );
{
    const F = "files/p.txt";
    await seed( phone, F, "p0\n" );
    for( const c of [ A, B ] ) await c.evaluate( `SC.read( '${F}' ).then( () => ( EV.length = 0, true ) )` );
    await A.evaluate( `offline( true ), SC.write( '${F}', 'p1\\n' ).then( () => offline( false ) )` );
    const pa = await A.evaluate( `typeof SC.pending === 'function' ? J( SC.pending( '${F}' ) ) : 'none'` );
    const pb = await B.evaluate( `typeof SC.pending === 'function' ? J( SC.pending( '${F}' ) ) : 'none'` );
    ok( pa !== "none" && JSON.parse( pa ).mine === true && JSON.parse( pa ).conflict === false, "pending(): tab A has a save waiting, its own", pa );
    ok( pb !== "none" && JSON.parse( pb ).mine === false, "...and tab B sees it is not its own", pb );
    await A.evaluate( "SC.flush().then( () => true )" );
    ok( await B.until( `EV.some( e => e.saved === '${F}' && e.body === 'p1\\n' && /^"/.test( e.tag ) && e.mine === false )` ),
        "onSaved(): tab B hears the save tab A sent (path, body, tag)", await B.evaluate( "EV" ) );
    ok( await A.evaluate( `EV.some( e => e.saved === '${F}' && e.mine === true )` ), "...and tab A hears it as its own" );
    ok( await A.evaluate( `typeof SC.pending === 'function' && SC.pending( '${F}' ).then( p => p === null )` ), "pending() is null once it went up" );

    await A.evaluate( `new Promise( res => { const q = indexedDB.open( 'nayive-mail-files', 1 );
        q.onupgradeneeded = () => q.result.createObjectStore( 'files', { keyPath: 'key' } );
        q.onsuccess = () => { const db = q.result, tx = db.transaction( 'files', 'readwrite' );
            tx.objectStore( 'files' ).put( { key: 'm1#f1', at: Date.now(), blob: new Blob( [ 'x' ] ) } );
            tx.oncomplete = () => { db.close(); res( true ); }; }; } )` );
    const before = await A.evaluate( "NayiveStore.localCount()" );
    await A.evaluate( "localStorage.setItem( 'nayive-chat-draft:user:test|w|c1', '{\"text\":\"hola\"}' ), localStorage.setItem( 'other-key', 'stays' ), true" );
    const counted = await A.evaluate( "NayiveStore.localCount()" );
    ok( counted === before + 1, "Chat's typed text is counted in the sign-out question", { before, counted } );
    // ...and one typed after the count (while the question is up) is not deleted.
    await A.evaluate( "localStorage.setItem( 'nayive-chat-draft:user:test|w|c2', '{\"text\":\"typed later\"}' ), true" );
    const left = await A.evaluate( "NayiveStore.clearLocal()" );
    const files = await A.evaluate( `new Promise( res => { const q = indexedDB.open( 'nayive-mail-files', 1 );
        q.onupgradeneeded = () => q.result.createObjectStore( 'files', { keyPath: 'key' } );
        q.onsuccess = () => { const db = q.result, g = db.transaction( 'files' ).objectStore( 'files' ).count();
            g.onsuccess = () => { db.close(); res( g.result ); }; }; } )` );
    ok( files === 0, "sign-out's clear empties eMail's files", files );
    ok( await A.evaluate( "localStorage.getItem( 'nayive-chat-draft:user:test|w|c1' ) === null && localStorage.getItem( 'other-key' ) === 'stays'" ),
        "...and the Chat text it counted (nothing else)" );
    ok( left >= 1 && await A.evaluate( "localStorage.getItem( 'nayive-chat-draft:user:test|w|c2' ) !== null" ),
        "the Chat text typed after the count is kept (and said to be left)", left );
}

const errs = A.logs.concat( B.logs ).filter( l => /EXCEPTION/.test( l ) );
ok( errs.length === 0, "no exceptions in the pages", errs.slice( 0, 3 ) );
await done( A, s );
