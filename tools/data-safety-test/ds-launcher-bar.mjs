// ds-launcher-bar.mjs - the launcher's top bar (shared/launcher-bar.js,
// data/launcher/bar.json), edited in My account › Top bar. Real pages in
// Chromium, a second "device" over plain HTTP.
//
// B1 no file: the default row; opening the launcher and My account writes nothing.
// B2 "+ Add" makes the file; ↑ moves; × removes.
// B3 another device's save meanwhile: kept (one change over the file as it is now), other keys too.
// B4 a damaged file is never written over: the editor is read-only.
import { server, browser, ok, section, done, onDisk, disk, sleep } from "./lib.mjs";

const F = "data/launcher/bar.json";
const s = await server();
const other = await s.client();
const json = () => { try { return JSON.parse( onDisk( s, F ) ); } catch { return null; } };
const has  = pred => disk( () => { const f = json(); return f && pred( f ); }, 30000 );
const same = ( a, b ) => JSON.stringify( a ) === JSON.stringify( b );

const openAccount = c => c.evaluate( "document.getElementById( 'accountBtn' ).click(); document.getElementById( 'barBtn' ).click(); true" );
const listReady   = c => c.until( "document.getElementById( 'barBackdrop' ).open && document.querySelector( '#barList [data-id]' )" );
// pick the icon (tap), then press ← (up), → (down) or × (del) under the row
const press = ( c, act, name ) => c.evaluate( `( () => { const i = [ ...document.querySelectorAll( '#barList [data-id]' ) ].find( x => x.getAttribute( 'aria-label' ) === ${JSON.stringify( name )} );
    if( ! i ) return false; if( i.getAttribute( 'aria-pressed' ) !== 'true' ) i.click();
    const b = document.querySelector( '#barActs [data-bar-act="${act}"]' ); if( ! b || b.disabled || b.hidden ) return false; b.click(); return true; } )()` );
const addApp = async ( c, name ) =>
{
    await c.evaluate( "document.getElementById( 'barAdd' ).click(); true" );
    await c.until( `[ ...document.querySelectorAll( '[role^="menuitem"]' ) ].some( x => x.textContent.includes( ${JSON.stringify( name )} ) )` );
    return c.evaluate( `( () => { const it = [ ...document.querySelectorAll( '[role^="menuitem"]' ) ].find( x => x.textContent.includes( ${JSON.stringify( name )} ) ); it.click(); return true; } )()` );
};

//------------------------------------------------------------------------//
section( "B1 · NO FILE YET" );
const c = await browser( s, { width: 390, height: 844 } );
await c.open( "/nayive/" );
ok( await c.until( "document.querySelector( '#quickBar #notesNewBtn' )" ), "the default row: the new-note button" );
await openAccount( c );
ok( await listReady( c ), "My account shows the list" );
await sleep( 1500 );
ok( onDisk( s, F ) === null, "nothing written by just looking" );

//------------------------------------------------------------------------//
section( "B2 · ADD, MOVE, REMOVE" );
await addApp( c, "Drive" );
ok( await has( f => same( f.items, [ "drive/index.html", "search", "desk", "note", "gear" ] ) ), "+ Add makes the file (new one first)", onDisk( s, F ) );
ok( await c.until( "document.querySelector( '#quickBar a.qb-app[href=\"drive/index.html\"]' )" ), "the row shows it" );
ok( await c.until( "document.querySelectorAll( '#barList [data-id]' ).length === 5" ), "the editor shows the row's five icons" );
ok( await press( c, "down", "Drive" ), "→ pressed" );
ok( await has( f => same( f.items, [ "search", "drive/index.html", "desk", "note", "gear" ] ) ), "→ moves it", onDisk( s, F ) );
ok( ! await press( c, "del", "Search" ) && ! await press( c, "del", "Settings" ), "Search and Settings cannot be removed" );
ok( await press( c, "up", "Settings" ), "← on Settings pressed" );
ok( await has( f => same( f.items, [ "search", "drive/index.html", "desk", "gear", "note" ] ) ), "Settings moves like the rest", onDisk( s, F ) );

//------------------------------------------------------------------------//
section( "B3 · ANOTHER DEVICE SAVED MEANWHILE" );
{
    ok( ( await other.put( F, JSON.stringify( { items: [ "desk", "drive/index.html", "note", "photos/index.html" ], later: 1 }, null, 1 ) ) ).status === 200, "the other device saves" );
    // this page still shows the old list: remove "New note" from it
    ok( await press( c, "del", "New note" ), "× pressed" );
    ok( await has( f => same( f.items, [ "search", "desk", "drive/index.html", "photos/index.html", "gear" ] ) && f.later === 1 ),
        "only the one change; the other device's Photos and its own key are kept", onDisk( s, F ) );
}

//------------------------------------------------------------------------//
section( "B4 · A DAMAGED FILE" );
{
    await other.put( F, "{ broken" );
    const c2 = await browser( s, { width: 390, height: 844 } );
    await c2.open( "/nayive/" );
    await openAccount( c2 );
    await listReady( c2 );
    ok( await c2.until( "! document.getElementById( 'barMsg' ).hidden" ), "it says the bar could not be read" );
    ok( await c2.evaluate( "document.getElementById( 'barAdd' ).disabled && [ ...document.querySelectorAll( '#barActs [data-bar-act]' ) ].every( b => b.disabled )" ),
        "the editor is read-only" );
    await c2.evaluate( "document.getElementById( 'barAdd' ).click(); true" );
    await sleep( 2000 );
    ok( onDisk( s, F ) === "{ broken", "never written over" );
    c2.stop();
}

c.stop();
await done();
