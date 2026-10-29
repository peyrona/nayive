/*
 * argon2-worker.js - Passwords: ONE Argon2id derivation, off the page.
 *
 * vault.js starts a fresh module worker for every derivation and terminates
 * it as soon as the answer is in: the library keeps its 64 MiB of WebAssembly
 * memory until its instance dies, and a dead worker takes it all with it.
 *
 *   in:  { password: Uint8Array (transferred, wiped here), salt, m (KiB), t, p }
 *   out: { ok: true, tag: Uint8Array(32) }  or  { ok: false, error }
 *
 * The library is vendored, unchanged, from the npm package argon2id 1.0.1
 * (github.com/openpgpjs/argon2id, MIT, (c) Proton AG - see its LICENSE): the
 * three lib/*.js files and the two WebAssembly builds from its dist/. Its
 * index.js is not: it imports the .wasm through a bundler; this file loads
 * them itself, SIMD first, the plain build where SIMD is missing (Safari).
 * tools/passwords-test checks it against the RFC 9106 test vector and against
 * Node's own Argon2id.
 */
import setupWasm from "./lib/argon2id_v1.0.1/setup.js";

const LIB = new URL( "./lib/argon2id_v1.0.1/", import.meta.url );

function loader( name )
{
    return async function( importObject )
    {
        const r = await fetch( new URL( name, LIB ) );
        if( ! r.ok ) throw new Error( name + ": " + r.status );
        return WebAssembly.instantiate( await r.arrayBuffer(), importObject );
    };
}

self.onmessage = async function( e )
{
    const q = e.data || {};
    try
    {
        const hash = await setupWasm( loader( "simd.wasm" ), loader( "no-simd.wasm" ) );
        const tag  = hash( { password: q.password, salt: q.salt, parallelism: q.p, passes: q.t,
                             memorySize: q.m, tagLength: 32 } );
        self.postMessage( { ok: true, tag: tag }, [ tag.buffer ] );
    }
    catch( err )
    {
        self.postMessage( { ok: false, error: String( ( err && err.message ) || err ) } );
    }
    finally
    {
        if( q.password && q.password.fill ) q.password.fill( 0 );
    }
};
