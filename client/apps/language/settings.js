/*
 * settings.js - Language: the configuration in localStorage (design
 * document, section 9).
 *
 * One key, "translator.config", holding
 *   { schemaVersion, catalogVersion, engines: { <id>: <changed fields> },
 *     custom: [ <user-made engines> ], dictionaries: { <id>: { enabled } },
 *     preferences: {...}, quotaUntil: { <id>: <ISO date> } }
 * Only what differs from the catalog is kept, so a new catalog engine always
 * shows up. Every access is in try/catch: private windows and full storage
 * leave the app on the defaults, never broken. Nothing here is user data on
 * the server - it is this browser's preferences.
 */

import { TranslationError } from './errors.js';
import { LANGS } from './languages.js';

export const SCHEMA_VERSION = 1;

export const DEFAULT_PREFERENCES = {
    source: 'es', target: 'fr', localMode: false, maxTextLength: 5000,
    remoteNoticeShown: [], downloadsAllowed: []
};

// The editable fields of an engine and their rules. Throws "invalid-input"
// naming the field.
export function checkEngineFields( f )
{
    const bad = ( field ) => { throw new TranslationError( 'invalid-input', 'Invalid ' + field, { field } ); };
    if( 'name' in f && ( typeof f.name !== 'string' || ! f.name.trim() || f.name.length > 60 ) ) bad( 'name' );
    if( 'enabled' in f && typeof f.enabled !== 'boolean' ) bad( 'enabled' );
    if( 'score' in f && ( typeof f.score !== 'number' || ! isFinite( f.score ) || f.score < 0 || f.score > 5 ) ) bad( 'score' );
    if( 'timeoutMs' in f && ( ! Number.isInteger( f.timeoutMs ) || f.timeoutMs < 1000 || f.timeoutMs > 120000 ) ) bad( 'timeoutMs' );
    if( 'options' in f && ( ! f.options || typeof f.options !== 'object' || Array.isArray( f.options ) ) ) bad( 'options' );
    if( 'id' in f && ( typeof f.id !== 'string' || ! /^[a-z0-9-]{1,40}$/.test( f.id ) ) ) bad( 'id' );
    if( 'adapter' in f && ( typeof f.adapter !== 'string' || ! f.adapter ) ) bad( 'adapter' );
}

export function checkPreferences( p )
{
    const bad = ( field ) => { throw new TranslationError( 'invalid-input', 'Invalid ' + field, { field } ); };
    if( 'source' in p && p.source !== 'auto' && ! LANGS.includes( p.source ) ) bad( 'source' );
    if( 'target' in p && ! LANGS.includes( p.target ) ) bad( 'target' );
    if( 'localMode' in p && typeof p.localMode !== 'boolean' ) bad( 'localMode' );
    if( 'maxTextLength' in p && ( ! Number.isInteger( p.maxTextLength ) || p.maxTextLength < 1 || p.maxTextLength > 5000 ) ) bad( 'maxTextLength' );
    for( const k of [ 'remoteNoticeShown', 'downloadsAllowed' ] )
        if( k in p && ( ! Array.isArray( p[ k ] ) || p[ k ].some( ( x ) => typeof x !== 'string' ) ) ) bad( k );
}

// The saved object -> a valid one (migrated), or throws "invalid-input".
export function parseSaved( raw )
{
    let o;
    try { o = typeof raw === 'string' ? JSON.parse( raw ) : raw; }
    catch( e ) { throw new TranslationError( 'invalid-input', 'Not JSON' ); }
    if( ! o || typeof o !== 'object' ) throw new TranslationError( 'invalid-input', 'Not an object' );
    if( o.schemaVersion !== SCHEMA_VERSION )               // the first schema: nothing to migrate from yet
        throw new TranslationError( 'invalid-input', 'Unknown schema ' + o.schemaVersion, { field: 'schemaVersion' } );

    const out = { schemaVersion: SCHEMA_VERSION, catalogVersion: Number( o.catalogVersion ) || 0,
                  engines: {}, custom: [], dictionaries: {}, preferences: {}, quotaUntil: {} };
    for( const [ id, f ] of Object.entries( o.engines || {} ) )
    {
        const keep = pick( f, [ 'name', 'enabled', 'score', 'timeoutMs', 'options' ] );
        checkEngineFields( keep );
        out.engines[ id ] = keep;
    }
    for( const e of Array.isArray( o.custom ) ? o.custom : [] )
    {
        const keep = pick( e, [ 'id', 'name', 'adapter', 'enabled', 'score', 'timeoutMs', 'options' ] );
        checkEngineFields( keep );
        if( ! keep.id || ! keep.adapter ) throw new TranslationError( 'invalid-input', 'Engine without id', { field: 'id' } );
        out.custom.push( keep );
    }
    for( const [ id, d ] of Object.entries( o.dictionaries || {} ) )
    {
        if( typeof ( d && d.enabled ) !== 'boolean' ) throw new TranslationError( 'invalid-input', 'Invalid dictionary', { field: id } );
        out.dictionaries[ id ] = { enabled: d.enabled };
    }
    const prefs = pick( o.preferences || {}, Object.keys( DEFAULT_PREFERENCES ) );
    checkPreferences( prefs );
    out.preferences = prefs;
    for( const [ id, iso ] of Object.entries( o.quotaUntil || {} ) )
        if( ! isNaN( Date.parse( iso ) ) ) out.quotaUntil[ id ] = iso;
    return out;
}

function pick( o, keys )
{
    const r = {};
    for( const k of keys ) if( o && Object.prototype.hasOwnProperty.call( o, k ) ) r[ k ] = o[ k ];
    return r;
}

export function emptySaved( catalogVersion )
{
    return { schemaVersion: SCHEMA_VERSION, catalogVersion, engines: {}, custom: [], dictionaries: {},
             preferences: {}, quotaUntil: {} };
}

// Read the saved configuration. { saved, warning } - warning is "unavailable"
// (no storage) or "corrupt" (thrown away), null when all is well.
export function readSaved( storage, key, catalogVersion )
{
    let raw = null;
    try { raw = storage ? storage.getItem( key ) : null; }
    catch( e ) { return { saved: emptySaved( catalogVersion ), warning: 'unavailable' }; }
    if( raw == null ) return { saved: emptySaved( catalogVersion ), warning: storage ? null : 'unavailable' };
    try { return { saved: parseSaved( raw ), warning: null }; }
    catch( e ) { return { saved: emptySaved( catalogVersion ), warning: 'corrupt' }; }
}

// false when it could not be written.
export function writeSaved( storage, key, saved )
{
    try { storage.setItem( key, JSON.stringify( saved ) ); return true; }
    catch( e ) { return false; }
}
