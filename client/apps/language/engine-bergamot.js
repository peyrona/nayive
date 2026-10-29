/*
 * engine-bergamot.js - Language: Bergamot, the engine inside Firefox
 * Translations, compiled to WebAssembly and run here in a Web Worker. On the
 * device, offline once the models are in, in any modern browser - the main
 * engine on phones (design document, section 4.2).
 *
 * MODELS. Most go to or from English, so es>fr is es>en + en>fr (two models,
 * two steps). The list comes from Mozilla's Remote Settings (read directly:
 * it sends CORS headers); the files through /api/translate/model on our own
 * server, because Mozilla's file CDN sends none (api_translate.go). Versions
 * are pinned in config.js (Phase 0: some newer ones crash this engine). Old
 * server without that route, or a pin gone upstream: the old S3 registry,
 * which has es, fr, de and pt but no Chinese.
 *
 * Downloaded files are checked against their SHA-256 and kept in the
 * browser's Cache Storage ("language-bergamot"), so a pair downloads once.
 */

import { TranslationError, abortError } from './errors.js';
import { BERGAMOT } from './config.js';

const CACHE      = 'language-bergamot';
const REG_KEY    = 'language.bergamot.registry';
const REG_DAYS   = 7;
const WORKER_URL = new URL( 'lib/bergamot-translator_v0.4.9/translator-worker.js', import.meta.url );

let registryP = null;                         // Promise<{ "es-en": [file...] }>
let s3P       = null;                         // Promise<{ "es-en": [file...] }>
let proxyDown = false;                        // /api/translate failed this session: S3 only
const usingS3 = new Set();                    // pairs switched to S3

//------------------------------------------------------------------------//
// REGISTRY  -  "es-en" -> [ { type, url, size, hash } ]

const mozCode = ( c ) => BERGAMOT.code[ c ] || c;

function loadMozilla()
{
    try
    {
        const kept = JSON.parse( localStorage.getItem( REG_KEY ) || 'null' );
        if( kept && kept.at > Date.now() - REG_DAYS * 864e5 && kept.files ) return Promise.resolve( kept.files );
    }
    catch( e ) {}
    return fetch( BERGAMOT.records, { credentials: 'omit' } )
        .then( ( r ) => { if( ! r.ok ) throw new Error( 'HTTP ' + r.status ); return r.json(); } )
        .then( ( j ) =>
        {
            const files = {};
            for( const [ pair, ver ] of Object.entries( BERGAMOT.pins ) )
            {
                const [ s, t ] = pair.split( '-' );
                const list = ( j.data || [] ).filter( ( r ) => r.fromLang === mozCode( s ) && r.toLang === mozCode( t ) &&
                                                            r.version === ver && r.attachment );
                if( list.length >= 3 )
                    files[ pair ] = list.map( ( r ) => ( { type: r.fileType, url: BERGAMOT.proxy + encodeURIComponent( r.attachment.location ),
                                                           size: r.attachment.size, hash: r.attachment.hash } ) );
            }
            try { localStorage.setItem( REG_KEY, JSON.stringify( { at: Date.now(), files } ) ); } catch( e ) {}
            return files;
        } );
}

function loadS3()
{
    if( ! s3P )
    {
        s3P = fetch( BERGAMOT.s3, { credentials: 'omit' } ).then( ( r ) => r.json() ).then( ( j ) =>
        {
            const files = {};
            for( const [ key, parts ] of Object.entries( j || {} ) )
            {
                const pair = key.slice( 0, 2 ) + '-' + key.slice( 2, 4 );
                files[ pair ] = Object.entries( parts ).filter( ( [ , f ] ) => f && f.name )
                    .map( ( [ type, f ] ) => ( { type, url: f.name, size: f.size, hash: f.expectedSha256Hash } ) );
            }
            return files;
        } );
        s3P.catch( () => { s3P = null; } );
    }
    return s3P;
}

function registry()
{
    if( ! registryP ) { registryP = loadMozilla().catch( () => ( {} ) ); }
    return registryP;
}

async function filesFor( pair )
{
    if( ! proxyDown && ! usingS3.has( pair ) )
    {
        const moz = await registry();
        if( moz[ pair ] ) return moz[ pair ];
    }
    try { return ( await loadS3() )[ pair ] || null; }
    catch( e ) { return null; }
}

// The models for source>target: one direct, or two through English.
async function route( source, target )
{
    const direct = await filesFor( source + '-' + target );
    if( direct ) return [ { from: source, to: target, files: direct } ];
    if( source === 'en' || target === 'en' ) return null;
    const a = await filesFor( source + '-en' ), b = await filesFor( 'en-' + target );
    return a && b ? [ { from: source, to: 'en', files: a }, { from: 'en', to: target, files: b } ] : null;
}

//------------------------------------------------------------------------//
// FILES  -  download with progress, check the hash, keep in Cache Storage

async function cached( url )
{
    try { const c = await caches.open( CACHE ); return await c.match( url ); }
    catch( e ) { return undefined; }
}

async function sha256Hex( buf )
{
    const d = new Uint8Array( await crypto.subtle.digest( 'SHA-256', buf ) );
    return Array.from( d, ( b ) => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );
}

async function download( file, signal, onBytes )
{
    let r;
    try { r = await fetch( file.url, { signal, credentials: file.url.startsWith( '/' ) ? 'same-origin' : 'omit' } ); }
    catch( e )
    {
        if( signal && signal.aborted ) throw abortError( signal );
        throw new TranslationError( 'network', 'Model download failed', { cause: e } );
    }
    if( ! r.ok ) throw new TranslationError( 'network', 'Model download: HTTP ' + r.status, { status: r.status } );
    const chunks = [];
    let got = 0;
    const reader = r.body.getReader();
    for( ;; )
    {
        const { done, value } = await reader.read();
        if( done ) break;
        chunks.push( value );
        got += value.length;
        onBytes( got );
    }
    const buf = new Uint8Array( got );
    let at = 0;
    for( const c of chunks ) { buf.set( c, at ); at += c.length; }
    if( file.hash && ( await sha256Hex( buf ) ) !== file.hash.toLowerCase() )
        throw new TranslationError( 'invalid-response', 'Model file damaged' );
    try
    {
        const c = await caches.open( CACHE );
        await c.put( file.url, new Response( buf, { headers: { 'Content-Type': 'application/octet-stream',
                                                               'X-Size': String( got ) } } ) );
    }
    catch( e ) {}                                   // no Cache Storage: works, downloads again next time
    return buf.buffer;
}

async function getFile( file, signal, onBytes )
{
    const hit = await cached( file.url );
    if( hit ) { onBytes( file.size || 0 ); return hit.arrayBuffer(); }
    return download( file, signal, onBytes );
}

//------------------------------------------------------------------------//
// WORKER  -  the vendored translator-worker.js, spoken to directly

let worker = null;
let serial = 0;
const pending = new Map();
const loaded  = new Set();                         // "es-en" models inside the worker

function startWorker()
{
    if( worker ) return worker;
    const w = new Worker( WORKER_URL );
    w.addEventListener( 'message', ( { data: { id, result, error } } ) =>
    {
        const p = pending.get( id );
        if( ! p ) return;
        pending.delete( id );
        if( error !== undefined ) p.reject( new TranslationError( 'internal', String( error && error.message ) ) );
        else p.accept( result );
    } );
    w.addEventListener( 'error', ( e ) => killWorker( String( e.message || 'worker error' ) ) );
    worker = { w, ready: null };
    worker.ready = call( 'initialize', { cacheSize: 0, useNativeIntGemm: false } );
    return worker;
}

function call( name, ...args )
{
    return new Promise( ( accept, reject ) =>
    {
        const id = ++serial;
        pending.set( id, { accept, reject } );
        worker.w.postMessage( { id, name, args } );
    } );
}

// A crash ("Aborted()") leaves the WebAssembly dead: start again next time.
function killWorker( why )
{
    if( ! worker ) return;
    worker.w.terminate();
    worker = null;
    loaded.clear();
    for( const p of pending.values() ) p.reject( new TranslationError( 'internal', why ) );
    pending.clear();
}

async function callSafe( name, ...args )
{
    try { return await call( name, ...args ); }
    catch( e ) { if( /abort/i.test( e.message ) ) killWorker( e.message ); throw e; }
}

function untilAbort( p, signal )
{
    if( ! signal ) return p;
    return new Promise( ( accept, reject ) =>
    {
        if( signal.aborted ) { reject( abortError( signal ) ); return; }
        const on = () => reject( abortError( signal ) );
        signal.addEventListener( 'abort', on, { once: true } );
        p.then( ( v ) => { signal.removeEventListener( 'abort', on ); accept( v ); },
                ( e ) => { signal.removeEventListener( 'abort', on ); reject( e ); } );
    } );
}

async function loadModel( m, buffers )
{
    const key = m.from + '-' + m.to;
    if( loaded.has( key ) ) return;
    startWorker();
    await worker.ready;
    const vocabs = buffers.vocab ? [ buffers.vocab ] : [ buffers.srcvocab, buffers.trgvocab ];
    const config = {};
    if( m.files.some( ( f ) => /intgemm8\.bin/.test( f.url ) ) ) config[ 'gemm-precision' ] = 'int8shiftAll';
    await callSafe( 'loadTranslationModel', { from: m.from, to: m.to },
                    { model: buffers.model, shortlist: buffers.lex, vocabs, config } );
    loaded.add( key );
}

// Every file of a route: from the cache or the network, then into the worker.
async function prepareRoute( models, signal, onProgress )
{
    const total = models.reduce( ( n, m ) => n + m.files.reduce( ( k, f ) => k + ( f.size || 0 ), 0 ), 0 ) || 1;
    const done  = {};
    const tick  = () => onProgress && onProgress( Math.min( 1, Object.values( done ).reduce( ( a, b ) => a + b, 0 ) / total ) );
    for( const m of models )
    {
        if( loaded.has( m.from + '-' + m.to ) ) { m.files.forEach( ( f ) => { done[ f.url ] = f.size || 0; } ); tick(); continue; }
        const buffers = {};
        for( const f of m.files )
        {
            buffers[ f.type ] = await getFile( f, signal, ( n ) => { done[ f.url ] = n; tick(); } );
            if( signal && signal.aborted ) throw abortError( signal );
        }
        await untilAbort( loadModel( m, buffers ), signal );
    }
}

async function routeOrThrow( source, target )
{
    const r = await route( source, target );
    if( ! r ) throw new TranslationError( 'unsupported', 'No Bergamot model for ' + source + '>' + target );
    return r;
}

// A failed download through our server: try the same pair from S3 once.
function switchToS3( models )
{
    let any = false;
    for( const m of models )
        if( m.files.some( ( f ) => f.url.startsWith( '/' ) ) ) { usingS3.add( m.from + '-' + m.to ); any = true; }
    return any;
}

export default {
    id: 'bergamot',
    location: 'local',
    maxChars: 1500,
    canDetect: false,
    optionsSchema: [],
    needsDownloadConsent: true,

    validateOptions() { return {}; },

    async availability( { source, target } )
    {
        if( typeof Worker === 'undefined' || typeof WebAssembly === 'undefined' ) return 'unavailable';
        let models;
        try { models = await route( source, target ); }
        catch( e ) { return 'unavailable'; }
        if( ! models ) return 'unavailable';
        for( const m of models )
        {
            if( loaded.has( m.from + '-' + m.to ) ) continue;
            for( const f of m.files ) if( ! await cached( f.url ) ) return 'downloadable';
        }
        return 'available';
    },

    // Bytes still to download for the pair.
    async downloadSize( { source, target } )
    {
        const models = await route( source, target );
        let n = 0;
        for( const m of models || [] ) for( const f of m.files ) if( ! await cached( f.url ) ) n += f.size || 0;
        return n;
    },

    async prepare( { source, target, signal, onProgress } )
    {
        let models = await routeOrThrow( source, target );
        try { await prepareRoute( models, signal, onProgress ); }
        catch( e )
        {
            if( ( signal && signal.aborted ) || e.category !== 'network' || ! switchToS3( models ) ) throw e;
            proxyDown = true;
            models = await routeOrThrow( source, target );
            await prepareRoute( models, signal, onProgress );
        }
    },

    async translate( { text, source, target, signal } )
    {
        const models = await routeOrThrow( source, target );
        if( models.some( ( m ) => ! loaded.has( m.from + '-' + m.to ) ) ) await this.prepare( { source, target, signal } );
        const r = await untilAbort( callSafe( 'translate', {
            models: models.map( ( m ) => ( { from: m.from, to: m.to } ) ),
            texts: [ { text, html: false } ]
        } ), signal );
        return String( r && r[ 0 ] && r[ 0 ].target && r[ 0 ].target.text || '' );
    },

    // What is kept on this device: one row per pair of files.
    async localModels()
    {
        const out = [];
        try
        {
            const c = await caches.open( CACHE );
            const moz = await registry().catch( () => ( {} ) );
            const s3  = await loadS3().catch( () => ( {} ) );
            const urls = new Map();
            for( const req of await c.keys() )
            {
                const res = await c.match( req );
                urls.set( new URL( req.url ).pathname + new URL( req.url ).search, Number( res.headers.get( 'X-Size' ) ) || 0 );
                urls.set( req.url, Number( res.headers.get( 'X-Size' ) ) || 0 );
            }
            const seen = new Set();
            for( const reg of [ moz, s3 ] )
                for( const [ pair, files ] of Object.entries( reg ) )
                {
                    const sizes = files.map( ( f ) => urls.get( f.url ) );
                    if( seen.has( pair ) || sizes.every( ( s ) => s === undefined ) ) continue;
                    seen.add( pair );
                    const [ s, t ] = pair.split( '-' );
                    out.push( { source: s, target: t, bytes: sizes.reduce( ( a, b ) => a + ( b || 0 ), 0 ) } );
                }
        }
        catch( e ) {}
        return out;
    },

    // One pair's files; a file another kept pair also uses stays.
    async deleteModel( { source, target } )
    {
        const pair = source + '-' + target;
        const kept = await this.localModels();
        const mine = kept.find( ( m ) => m.source + '-' + m.target === pair );
        if( ! mine ) return 0;
        const others = new Set( kept.map( ( m ) => m.source + '-' + m.target ).filter( ( p ) => p !== pair ) );
        const drop = new Set(), keep = new Set();
        for( const reg of [ await registry().catch( () => ( {} ) ), await loadS3().catch( () => ( {} ) ) ] )
            for( const [ p, files ] of Object.entries( reg ) )
                for( const f of files )
                    if( p === pair ) drop.add( f.url );
                    else if( others.has( p ) ) keep.add( f.url );
        killWorker( 'model deleted' );
        try
        {
            const c = await caches.open( CACHE );
            for( const url of drop ) if( ! keep.has( url ) ) await c.delete( url );
        }
        catch( e ) {}
        return mine.bytes;
    },

    dispose() { killWorker( 'disposed' ); }
};
