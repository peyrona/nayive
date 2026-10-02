// race.mjs - "another device saved in between": the read -> change -> write
// race of a shared file, made to happen every time (not a ds-*.mjs: run.mjs
// does not run it on its own).
//
//   import { installRace, arm, raced } from "./race.mjs";
//   await installRace( c );                              // once per page load
//   await arm( c, "data/x.json", "t => t.replace( 'a', 'b' )" );
//   ... the app reads data/x.json (any GET of it, by fetch) ...
//   ok( await raced( c ), "the other device's save landed in between" );
//
// The page's fetch is wrapped: the FIRST GET of the armed path after arm()
// gets its answer, then - before the app sees it - the other device's version
// (the change function applied to that answer's text) is PUT to the server.
// The app goes on with the copy it read, which is now one version behind: a
// blind write drops the other device's change; a version-checked one (If-Match)
// gets 412 and must read again. One shot: the next GET is left alone (unless
// armed `always`: then another device saves after every read).

export const RACE = `( () => {
    if( window.__race ) return true;
    window.__race = { arm: null, hits: 0 };
    const f0 = window.fetch;
    window.__race.put = ( p, body ) => f0( '/api/files?file=' + encodeURIComponent( p ), { method: 'PUT', body } );
    window.fetch = async function ( u, o ) {
        const r = await f0.apply( this, arguments );
        const a = window.__race.arm;
        try {
            const url = new URL( String( u && u.url || u ), location.href );
            const get = ! o || ! o.method || String( o.method ).toUpperCase() === 'GET';
            if( a && get && r.ok && url.pathname === '/api/files' && url.searchParams.get( 'file' ) === a.path ) {
                if( ! a.always ) window.__race.arm = null;
                const text = await r.clone().text();
                const w = await window.__race.put( a.path, a.change( text ) );
                window.__race.hits++;
                window.__race.status = w.status;
            }
        } catch( e ) { window.__race.error = String( e ); }
        return r;
    };
    return true; } )()`;

export const installRace = c => c.evaluate( RACE );

// `change`: the SOURCE of a function text -> text (evaluated in the page).
// `always`: every GET of it, not only the next one, until disarm().
export const arm = ( c, path, change, always = false ) =>
    c.evaluate( `( () => { window.__race.arm = { path: ${JSON.stringify( path )}, change: ${change}, always: ${!! always} }; return true; } )()` );
export const disarm = c => c.evaluate( "( () => { if( window.__race ) window.__race.arm = null; return true; } )()" );

// True once the armed race has happened (its PUT answered 200).
export const raced = c => c.until( "window.__race && window.__race.hits > 0 && window.__race.status === 200" );
