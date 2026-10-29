/*
 * errors.js - Language: the typed errors every part of the translator throws.
 *
 * A TranslationError carries a `category` (design document, section 7.1); it
 * tells the page what to say and the orchestrator whether to pause an engine.
 */

export const CATEGORIES = [ 'unsupported', 'unavailable', 'network', 'cors', 'timeout', 'quota',
                            'invalid-response', 'aborted', 'invalid-input', 'no-voice', 'internal' ];

export class TranslationError extends Error
{
    constructor( category, message, details )
    {
        super( message || category );
        this.name     = 'TranslationError';
        this.category = CATEGORIES.includes( category ) ? category : 'internal';
        this.details  = details || {};
    }
}

// Every candidate failed: `attempts` says which and why.
export class AllEnginesFailedError extends TranslationError
{
    constructor( attempts )
    {
        super( 'unavailable', 'All engines failed', { attempts } );
        this.name     = 'AllEnginesFailedError';
        this.attempts = attempts || [];
    }
}

// Local mode is on and no engine on this device can do the pair; nothing
// left the device. The page may offer to retry with allowRemote.
export class LocalModeError extends TranslationError
{
    constructor( source, target, remoteEngineIds )
    {
        super( 'unavailable', 'No local engine for ' + source + '>' + target, { source, target } );
        this.name            = 'LocalModeError';
        this.source          = source;
        this.target          = target;
        this.remoteEngineIds = remoteEngineIds || [];
    }
}

// Any thrown thing -> one of the categories.
export function categorize( err, signal )
{
    if( signal && signal.aborted )
    {
        const r = signal.reason;
        return r instanceof TranslationError && r.category === 'timeout' ? 'timeout' : 'aborted';
    }
    if( err instanceof TranslationError ) return err.category;
    if( err && err.name === 'AbortError' ) return 'aborted';
    if( err && err.name === 'NotSupportedError' ) return 'unsupported';
    if( err && err.name === 'NotAllowedError' ) return 'unavailable';
    if( err instanceof TypeError && /fetch|network|load/i.test( err.message ) ) return 'network';
    return 'internal';
}

// The error to throw when `signal` fired: its reason when typed, else "aborted".
export function abortError( signal )
{
    const r = signal && signal.reason;
    return r instanceof TranslationError ? r : new TranslationError( 'aborted', 'Cancelled' );
}
