/*
 * cdp.mjs - drive a headless Chromium over the DevTools protocol.
 *
 * No dependencies: Node's own WebSocket and fetch are enough. `evaluate` runs
 * an expression in the page and waits for the promise it returns, so a test
 * reads like the thing it is testing.
 *
 * A copy of tools/locktest/cdp.mjs, so this tool stands on its own.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = [ "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser" ];

export async function browser()
{
    const bin = CHROME.find( p => fs.existsSync( p ) );
    if( ! bin ) throw new Error( "no Chromium found (tried " + CHROME.join( ", " ) + ")" );

    const dir  = fs.mkdtempSync( path.join( os.tmpdir(), "nayive-cdp-" ) );
    const proc = spawn( bin, [ "--headless=new", "--remote-debugging-port=0", "--no-sandbox",
                               "--disable-gpu", "--user-data-dir=" + dir, "about:blank" ],
                        { stdio: [ "ignore", "pipe", "pipe" ] } );

    // Chromium prints its DevTools endpoint on stderr once it is listening.
    const port = await new Promise( ( resolve, reject ) =>
    {
        let buf = "";
        const t = setTimeout( () => reject( new Error( "no DevTools port: " + buf ) ), 20000 );
        proc.stderr.on( "data", d =>
        {
            buf += d;
            const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec( buf );
            if( m ) { clearTimeout( t ); resolve( +m[ 1 ] ); }
        } );
    } );

    return {
        port,
        newTab: async url => ( await fetch( `http://127.0.0.1:${port}/json/new?` + encodeURIComponent( url ),
                                            { method: "PUT" } ) ).json(),
        kill: () =>
        {
            proc.kill();
            try { fs.rmSync( dir, { recursive: true, force: true } ); } catch {}
        }
    };
}

export async function attach( wsUrl )
{
    const ws = new WebSocket( wsUrl );
    await new Promise( ( r, j ) => { ws.onopen = r; ws.onerror = j; } );

    let id = 0;
    const waiting = new Map();
    const logs    = [];

    ws.onmessage = e =>
    {
        const m = JSON.parse( e.data );
        if( m.id && waiting.has( m.id ) ) { waiting.get( m.id )( m ); waiting.delete( m.id ); }
        if( m.method === "Runtime.consoleAPICalled" )
            logs.push( m.params.args.map( a => a.value ?? a.description ).join( " " ) );
        if( m.method === "Runtime.exceptionThrown" )
            logs.push( "EXCEPTION " + ( m.params.exceptionDetails.exception?.description ||
                                        m.params.exceptionDetails.text ) );
    };

    const send = ( method, params = {} ) => new Promise( res =>
    {
        const i = ++id;
        waiting.set( i, res );
        ws.send( JSON.stringify( { id: i, method, params } ) );
    } );

    await send( "Runtime.enable" );
    await send( "Page.enable" );

    // The timeout matters: a test that leaves a dialog unanswered would
    // otherwise wait for ever with nothing to say about where it stopped.
    const evaluate = async ( expression, ms = 25000 ) =>
    {
        const r = await Promise.race( [
            send( "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true } ),
            new Promise( ( _, j ) => setTimeout(
                () => j( new Error( "evaluate timed out after " + ms + "ms:\n" + expression.slice( 0, 400 ) ) ), ms ) )
        ] );

        const d = r.result;
        if( d?.exceptionDetails )
            throw new Error( d.exceptionDetails.exception?.description || JSON.stringify( d.exceptionDetails ) );
        return d?.result?.value;
    };

    return { send, evaluate, logs };
}
