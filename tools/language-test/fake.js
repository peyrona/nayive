// fake.js - a configurable engine for the Language tests (design document,
// section 13.1): return a text, fail with a category, take n ms, return
// empty, return a quota notice inside a 200, or not support a pair.
import { TranslationError } from "../../client/apps/language/errors.js";

export function fakeAdapter( id, behaviour = {} )
{
    const calls = [];
    const a = {
        id, calls,
        location: behaviour.location || "local",
        maxChars: behaviour.maxChars || 1000,
        canDetect: !! behaviour.detect,
        needsDownloadConsent: !! behaviour.consent,
        optionsSchema: [],
        validateOptions( o ) { return o || {}; },
        async availability( { source, target } )
        {
            if( behaviour.unsupported && behaviour.unsupported.includes( source + ">" + target ) ) return "unavailable";
            return behaviour.availability || "available";
        },
        async downloadSize() { return 1234567; },
        async prepare( { onProgress } ) { a.prepared = ( a.prepared || 0 ) + 1; onProgress && onProgress( 1 ); behaviour.availability = "available"; },
        async translate( { text, source, target, signal } )
        {
            calls.push( { text, source, target } );
            if( behaviour.ms ) await new Promise( ( ok, ko ) =>
            {
                const t = setTimeout( ok, behaviour.ms );
                signal && signal.addEventListener( "abort", () => { clearTimeout( t ); ko( signal.reason ); }, { once: true } );
            } );
            if( behaviour.fail ) throw new TranslationError( behaviour.fail, "fake " + behaviour.fail );
            if( behaviour.empty ) return "";
            if( behaviour.raw ) return behaviour.raw;
            return ( "prefix" in behaviour ? behaviour.prefix : "[" + id + "]" ) + text;
        },
        async detect() { return behaviour.detect; }
    };
    return a;
}

// An in-memory Web Storage.
export function memoryStorage( init = {} )
{
    const m = new Map( Object.entries( init ) );
    return {
        getItem: ( k ) => ( m.has( k ) ? m.get( k ) : null ),
        setItem: ( k, v ) => { m.set( k, String( v ) ); },
        removeItem: ( k ) => { m.delete( k ); },
        _map: m
    };
}
