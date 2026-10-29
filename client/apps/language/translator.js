/*
 * translator.js - Language: the Translator facade, the one door the page
 * uses (design document, section 10; full API with JSDoc in
 * docs/language/api/translator.js). It picks the engines, splits the text,
 * falls back to the next engine on a failure, pauses engines that keep
 * failing, and owns the settings, OCR, speech and dictionaries.
 *
 * It knows no HTML, and the page knows no engine.
 *
 * exportConfig() / importConfig() of the documented API are left out
 * (2026-10-28): the admin's settings live on the server, one copy for all.
 *
 * Three additions to the documented API, all optional:
 *   - options.shared: the admin's engines and dictionaries
 *     ({ engines, custom, dictionaries }, from /api/translate/config). They
 *     replace this browser's copy at init(); the copy stays as the offline
 *     fallback. Only the admin changes them (admin.html, "Language" tab).
 *   - CallOptions.confirmDownload( { engineId, engineName, source, target, bytes } )
 *     -> Promise<boolean>: asked before an engine downloads a model the
 *     first time for a pair; the answer is remembered (Preferences.downloadsAllowed).
 *   - lookup( word, { allowRemote: true } ): a lookup past Local mode, once.
 */

import { TranslationError, AllEnginesFailedError, LocalModeError, categorize, abortError } from './errors.js';
import { LANGS, normalizeLanguage, languageName, allPairs } from './languages.js';
import { splitText } from './split.js';
import { CATALOG_VERSION, DEFAULT_ENGINES, DEFAULT_DICTIONARIES, TEST_SENTENCE } from './config.js';
import { DEFAULT_PREFERENCES, SCHEMA_VERSION, checkEngineFields, checkPreferences, parseSaved, readSaved, writeSaved, emptySaved } from './settings.js';

export { TranslationError, AllEnginesFailedError, LocalModeError };

const STORAGE_KEY   = 'translator.config';
const PAUSE_FAILS   = 3;                                // network / timeout / cors in a row...
const PAUSE_MS      = 5 * 60 * 1000;                    // ...pause this long
const SHORT_TEXT    = 20;                               // letters: detection is unreliable below
const MIN_CONFIDENCE = 0.5;

const clone = ( o ) => JSON.parse( JSON.stringify( o ) );

export class Translator
{
    constructor( options = {} )
    {
        this._catalog        = clone( options.catalog || DEFAULT_ENGINES );
        this._catalogVersion = options.catalogVersion || CATALOG_VERSION;
        this._dictCatalog    = clone( options.dictionaries || DEFAULT_DICTIONARIES );
        this._initialAdapters = options.adapters || [];
        this._dictSources    = options.dictionarySources || {};       // id -> { lookup(), pairs }
        this._ocr            = options.ocr || null;                   // { recognize( image, opts ) }
        this._speech         = options.speech || null;                // see speech.js
        this._storage        = 'storage' in options ? options.storage : safeLocalStorage();
        this._key            = options.storageKey || STORAGE_KEY;
        this._shared         = options.shared || null;
        this._adapters       = new Map();
        this._listeners      = new Map();
        this._runtime        = new Map();                             // id -> { fails, lastError, pausedUntil }
        this._current        = null;                                  // the running translation's controller
        this._started        = false;
        this._disposed       = false;
    }

    //------------------------------------------------------------------------//
    // LIFECYCLE

    async init()
    {
        if( this._started ) throw new TranslationError( 'internal', 'init() called twice' );
        this._started = true;
        for( const a of this._initialAdapters ) this.registerAdapter( a );
        const { saved, warning } = readSaved( this._storage, this._key, this._catalogVersion );
        this._saved = saved;
        if( this._shared )
        {
            // A bad answer keeps the copy this browser had.
            try
            {
                const sh = parseSaved( Object.assign( {}, this._shared, { schemaVersion: SCHEMA_VERSION } ) );
                Object.assign( this._saved, { engines: sh.engines, custom: sh.custom, dictionaries: sh.dictionaries } );
                if( this._storage ) writeSaved( this._storage, this._key, this._saved );
            }
            catch( e ) {}
        }
        this._rebuild();
        if( warning ) this._emit( 'storage-error', { reason: warning } );
    }

    dispose()
    {
        this.cancel();
        this.stopSpeaking();
        for( const a of this._adapters.values() ) try { a.dispose && a.dispose(); } catch( e ) {}
        if( this._ocr && this._ocr.dispose ) this._ocr.dispose();
        this._listeners.clear();
        this._disposed = true;
    }

    // saved + catalog -> this._engines, this._dicts, this._prefs
    _rebuild()
    {
        const s = this._saved;
        const engines = [];
        for( const base of this._catalog )
        {
            const e = Object.assign( clone( base ), clone( s.engines[ base.id ] || {} ), { builtIn: true } );
            engines.push( e );
        }
        for( const c of s.custom )
            if( ! engines.some( ( e ) => e.id === c.id ) ) engines.push( Object.assign( clone( c ), { builtIn: false } ) );
        for( const e of engines )
        {
            const a = this._adapters.get( e.adapter );
            e.location = a ? a.location : 'remote';
            e.missingAdapter = ! a;
            if( ! a ) e.enabled = false;               // kept, disabled, marked "adapter not available"
            else try { e.options = a.validateOptions( e.options || {} ); } catch( err ) { e.enabled = false; }
        }
        this._engines = engines;
        this._dicts = this._dictCatalog.map( ( d ) => Object.assign( clone( d ), s.dictionaries[ d.id ] || {} ) );
        this._prefs = Object.assign( clone( DEFAULT_PREFERENCES ), clone( s.preferences ) );
        for( const [ id, iso ] of Object.entries( s.quotaUntil ) )
        {
            const until = new Date( iso );
            if( until > new Date() ) this._rt( id ).pausedUntil = until;
        }
    }

    _save()
    {
        this._saved.catalogVersion = this._catalogVersion;
        if( this._storage && ! writeSaved( this._storage, this._key, this._saved ) )
            this._emit( 'storage-error', { reason: 'write' } );
        this._emit( 'config-changed' );
    }

    //------------------------------------------------------------------------//
    // LANGUAGES

    getLanguages() { return LANGS.slice(); }

    getLanguageName( code, displayLanguage = 'es' )
    {
        if( ! LANGS.includes( code ) ) throw new TranslationError( 'invalid-input', 'Unknown language', { field: 'code' } );
        return languageName( code, displayLanguage );
    }

    normalizeLanguage( tag ) { return normalizeLanguage( tag ); }

    async getSupportedPairs( options )
    {
        const withDownload = ! options || options.includeDownloadable !== false;
        const out = [];
        for( const [ source, target ] of allPairs() )
        {
            let best = 'unavailable';
            for( const e of this._usable( ! this._prefs.localMode ) )
            {
                const a = await this._availability( e, source, target );
                if( a === 'available' ) { best = a; break; }
                if( a === 'downloadable' ) best = 'downloadable';
            }
            if( best === 'available' || ( withDownload && best === 'downloadable' ) ) out.push( { source, target, availability: best } );
        }
        return out;
    }

    //------------------------------------------------------------------------//
    // TRANSLATION

    async translate( request, options = {} )
    {
        this._alive();
        const req = this._checkRequest( request );

        // One translation at a time: a new one cancels the previous.
        this.cancel();
        const controller = new AbortController();
        this._current = controller;
        const outer = options.signal;
        const onOuter = () => controller.abort( abortError( outer ) );
        if( outer ) { if( outer.aborted ) onOuter(); else outer.addEventListener( 'abort', onOuter, { once: true } ); }
        const signal = controller.signal;
        const emit = ( type, detail ) => { this._emit( type, detail ); if( options.onEvent ) try { options.onEvent( { type, detail } ); } catch( e ) {} };

        try
        {
            let source = req.source, detection = null;
            if( source === 'auto' )
            {
                detection = await this._detect( req.text, signal, emit, req.allowRemote );
                source = detection.language;
                if( source === req.target ) throw new TranslationError( 'invalid-input', 'Same language', { field: 'target', detected: source } );
            }
            const target = req.target;
            const allowRemote = !! req.allowRemote || ! this._prefs.localMode;
            const candidates = await this._candidates( source, target, allowRemote, req.engineIds, signal );
            if( ! candidates.length )
            {
                if( ! allowRemote )
                {
                    const remote = await this._candidates( source, target, true, req.engineIds, signal );
                    throw new LocalModeError( source, target, remote.filter( ( c ) => c.engine.location === 'remote' ).map( ( c ) => c.engine.id ) );
                }
                throw new AllEnginesFailedError( [] );
            }

            const attempts = [];
            for( const [ order, { engine, availability } ] of candidates.entries() )
            {
                const started = now();
                const adapter = this._adapters.get( engine.adapter );
                try
                {
                    if( availability === 'downloadable' )
                    {
                        if( ! await this._consent( engine, source, target, options.confirmDownload, adapter ) )
                            throw new TranslationError( 'unavailable', 'Download declined', { declined: true } );
                        await this._prepare( engine, adapter, source, target, signal, emit );
                    }
                    emit( 'translating', { engineId: engine.id } );
                    const text = await this._translateWith( engine, adapter, req.text, source, target, signal );
                    this._success( engine );
                    attempts.push( { engineId: engine.id, order, ok: true, ms: Math.round( now() - started ) } );
                    const warnings = [];
                    if( req.text.trim().length > 40 && text.trim() === req.text.trim() ) warnings.push( 'unchanged' );
                    return { text, source, detection, target, engineId: engine.id, engineName: engine.name,
                             location: engine.location, attempts, warnings };
                }
                catch( err )
                {
                    if( signal.aborted && ! isTimeout( signal ) ) throw abortError( signal );
                    if( outer && outer.aborted ) throw abortError( outer );
                    const category = err && err.details && err.details.timeout ? 'timeout' : categorize( err );
                    if( category === 'aborted' ) throw err;
                    this._failure( engine, category, err, emit );
                    attempts.push( { engineId: engine.id, order, ok: false, category, ms: Math.round( now() - started ),
                                     declined: !! ( err && err.details && err.details.declined ) } );
                    emit( 'fallback', { from: engine.id, category } );
                }
            }
            // Every local engine failed in Local mode: the internet may still
            // do it - the page asks, like when no local engine could even try.
            if( ! allowRemote )
            {
                const remote = ( await this._candidates( source, target, true, req.engineIds, signal ) )
                    .filter( ( c ) => c.engine.location === 'remote' ).map( ( c ) => c.engine.id );
                if( remote.length ) { const e = new LocalModeError( source, target, remote ); e.attempts = attempts; throw e; }
            }
            throw new AllEnginesFailedError( attempts );
        }
        finally
        {
            if( outer ) outer.removeEventListener( 'abort', onOuter );
            if( this._current === controller ) this._current = null;
        }
    }

    cancel()
    {
        if( this._current ) { this._current.abort( new TranslationError( 'aborted', 'Cancelled' ) ); this._current = null; }
    }

    _checkRequest( r )
    {
        const bad = ( field, msg ) => { throw new TranslationError( 'invalid-input', msg, { field } ); };
        if( ! r || typeof r.text !== 'string' || ! r.text.trim() ) bad( 'text', 'Empty text' );
        if( r.text.length > this._prefs.maxTextLength ) bad( 'text', 'Text too long' );
        if( ! LANGS.includes( r.target ) ) bad( 'target', 'No target language' );
        if( r.source !== 'auto' && ! LANGS.includes( r.source ) ) bad( 'source', 'Unknown source language' );
        if( r.source === r.target ) bad( 'target', 'Same language' );
        return r;
    }

    // Enabled engines, by score (ties: catalog order - sort is stable).
    _usable( allowRemote, ids )
    {
        return this._sorted().filter( ( e ) => e.enabled && ! e.missingAdapter &&
            ( allowRemote || e.location === 'local' ) && ( ! ids || ids.includes( e.id ) ) );
    }

    _sorted()
    {
        return this._engines.map( ( e, i ) => [ e, i ] ).sort( ( a, b ) => b[ 0 ].score - a[ 0 ].score || a[ 1 ] - b[ 1 ] ).map( ( x ) => x[ 0 ] );
    }

    async _candidates( source, target, allowRemote, ids, signal )
    {
        const out = [];
        for( const engine of this._usable( allowRemote, ids ) )
        {
            if( this._paused( engine.id ) && ! ids ) continue;
            const availability = await this._availability( engine, source, target );
            if( signal && signal.aborted ) throw abortError( signal );
            if( availability !== 'unavailable' ) out.push( { engine, availability } );
        }
        return out;
    }

    async _availability( engine, source, target )
    {
        const a = this._adapters.get( engine.adapter );
        if( ! a ) return 'unavailable';
        try { return await a.availability( { source, target, options: engine.options } ); }
        catch( e ) { return 'unavailable'; }
    }

    async _consent( engine, source, target, confirm, adapter )
    {
        const key = engine.id + ':' + source + '-' + target;
        if( this._prefs.downloadsAllowed.includes( key ) ) return true;
        if( ! adapter.needsDownloadConsent ) return true;
        if( ! confirm ) return false;
        let bytes = 0;
        try { bytes = adapter.downloadSize ? await adapter.downloadSize( { source, target, options: engine.options } ) : 0; } catch( e ) {}
        const yes = await confirm( { engineId: engine.id, engineName: engine.name, source, target, bytes } );
        if( yes ) this.setPreferences( { downloadsAllowed: this._prefs.downloadsAllowed.concat( key ) } );
        return !! yes;
    }

    async _prepare( engine, adapter, source, target, signal, emit )
    {
        emit( 'preparing', { engineId: engine.id, source, target, progress: 0 } );
        await adapter.prepare( { source, target, options: engine.options, signal,
                                 onProgress: ( p ) => emit( 'preparing', { engineId: engine.id, source, target, progress: p } ) } );
    }

    // Split by the adapter's limit, translate piece by piece (in sequence:
    // public services have limits), join. Any failure drops the whole text.
    async _translateWith( engine, adapter, text, source, target, signal )
    {
        const parts = splitText( text, adapter.maxChars || 1000, adapter.measure );
        const out = [];
        for( const part of parts )
        {
            if( ! part.translatable )
            {
                out.push( part.text === ' ' && target === 'zh' ? '' : part.text );
                continue;
            }
            const t = await withTimeout( ( s ) => adapter.translate( { text: part.text, source, target, options: engine.options, signal: s } ),
                                         engine.timeoutMs, signal );
            if( typeof t !== 'string' || ! t.trim() ) throw new TranslationError( 'invalid-response', 'Empty answer' );
            out.push( t.trim() );
        }
        return out.join( '' );
    }

    //------------------------------------------------------------------------//
    // DETECTION  -  Chrome's LanguageDetector, else a remote engine that can

    async detectLanguage( text, options = {} )
    {
        this._alive();
        if( typeof text !== 'string' || ! text.trim() ) throw new TranslationError( 'invalid-input', 'Empty text', { field: 'text' } );
        return this._detect( text, options.signal, () => {}, false, true );
    }

    async _detect( text, signal, emit, allowRemote, raw )
    {
        emit( 'detecting' );
        const remoteOk = allowRemote || ! this._prefs.localMode;
        const detectors = this._usable( remoteOk ).filter( ( e ) =>
        {
            const a = this._adapters.get( e.adapter );
            return a && a.canDetect && a.detect && ( ! a.canDetectHere || a.canDetectHere() );
        } );
        let best = null;
        for( const e of detectors )
        {
            try
            {
                const r = await this._adapters.get( e.adapter ).detect( { text, options: e.options, signal } );
                best = { language: r.language, confidence: r.confidence, detectorId: e.id };
                break;
            }
            catch( err ) { if( signal && signal.aborted ) throw abortError( signal ); }
        }
        if( ! best ) throw new TranslationError( raw ? 'unavailable' : 'unsupported', 'No language detector', { reason: 'no-detector' } );
        const letters = ( text.match( /\p{L}/gu ) || [] ).length;
        best.short = letters < SHORT_TEXT;
        if( raw ) return best;
        if( best.confidence < MIN_CONFIDENCE )
            throw new TranslationError( 'unsupported', 'Language unclear', { reason: 'low-confidence', detection: best } );
        emit( 'detected', best );
        return best;
    }

    //------------------------------------------------------------------------//
    // PAUSES  (design document, section 10.4)

    _rt( id )
    {
        if( ! this._runtime.has( id ) ) this._runtime.set( id, { fails: 0, lastError: null, pausedUntil: null } );
        return this._runtime.get( id );
    }

    _paused( id )
    {
        const r = this._rt( id );
        if( r.pausedUntil && r.pausedUntil > new Date() ) return true;
        r.pausedUntil = null;
        return false;
    }

    _success( engine )
    {
        const r = this._rt( engine.id );
        r.fails = 0; r.lastError = null; r.pausedUntil = null;
        if( this._saved.quotaUntil[ engine.id ] ) { delete this._saved.quotaUntil[ engine.id ]; this._save(); }
    }

    _failure( engine, category, err, emit )
    {
        const r = this._rt( engine.id );
        r.lastError = category;
        if( category === 'unsupported' || category === 'unavailable' ) return;   // that pair is just not offered
        r.fails++;
        let until = null;
        if( category === 'quota' )
        {
            until = ( err && err.details && err.details.retryAfter ) || nextMidnight();
            this._saved.quotaUntil[ engine.id ] = until.toISOString();
            this._save();
        }
        else if( [ 'network', 'timeout', 'cors' ].includes( category ) && r.fails >= PAUSE_FAILS ) until = new Date( Date.now() + PAUSE_MS );
        if( until )
        {
            r.pausedUntil = until;
            emit( 'engine-paused', this._statusOf( engine ) );
        }
    }

    _statusOf( e )
    {
        const r = this._rt( e.id );
        const paused = this._paused( e.id );
        const state = e.missingAdapter ? 'missing-adapter' : ! e.enabled ? 'disabled' : paused ? 'paused' : 'active';
        return { id: e.id, state, pausedUntil: paused ? r.pausedUntil : null, lastError: r.lastError, consecutiveFailures: r.fails };
    }

    //------------------------------------------------------------------------//
    // ENGINES

    getEngines() { return this._sorted().map( ( e ) => publicEngine( e ) ); }

    getEngine( id ) { return publicEngine( this._engine( id ) ); }

    _engine( id )
    {
        const e = this._engines.find( ( x ) => x.id === id );
        if( ! e ) throw new TranslationError( 'invalid-input', 'No such engine', { field: 'id' } );
        return e;
    }

    async getEngineStatus( id )
    {
        const e = this._engine( id );
        const st = this._statusOf( e );
        if( st.state === 'active' )
        {
            const a = this._adapters.get( e.adapter );
            let any = false;
            for( const [ s, t ] of allPairs() )
                if( await a.availability( { source: s, target: t, options: e.options } ).catch( () => 'unavailable' ) !== 'unavailable' ) { any = true; break; }
            if( ! any ) st.state = 'unavailable';
        }
        return st;
    }

    setEngineEnabled( id, enabled ) { this.updateEngine( id, { enabled: !! enabled } ); }

    updateEngine( id, patch )
    {
        const e = this._engine( id );
        const p = {};
        for( const k of [ 'name', 'enabled', 'score', 'timeoutMs', 'options' ] ) if( patch && k in patch ) p[ k ] = patch[ k ];
        checkEngineFields( p );
        if( p.enabled && e.missingAdapter ) throw new TranslationError( 'invalid-input', 'Adapter not available', { field: 'enabled' } );
        if( 'options' in p ) p.options = this._adapters.get( e.adapter ).validateOptions( p.options );
        if( 'name' in p ) p.name = p.name.trim();

        if( e.builtIn )
        {
            const base = this._catalog.find( ( b ) => b.id === id );
            const diff = Object.assign( {}, this._saved.engines[ id ] || {}, clone( p ) );
            for( const k of Object.keys( diff ) ) if( JSON.stringify( diff[ k ] ) === JSON.stringify( base[ k ] ) ) delete diff[ k ];
            if( Object.keys( diff ).length ) this._saved.engines[ id ] = diff; else delete this._saved.engines[ id ];
        }
        else
        {
            const c = this._saved.custom.find( ( x ) => x.id === id );
            Object.assign( c, clone( p ) );
        }
        this._rebuild();
        this._save();
        return this.getEngine( id );
    }

    addEngine( config )
    {
        const c = Object.assign( { enabled: true, score: 3, timeoutMs: 15000, options: {} }, clone( config || {} ) );
        checkEngineFields( c );
        if( ! c.id || ! c.name ) throw new TranslationError( 'invalid-input', 'Missing id or name', { field: c.id ? 'name' : 'id' } );
        if( this._engines.some( ( e ) => e.id === c.id ) ) throw new TranslationError( 'invalid-input', 'Id taken', { field: 'id' } );
        const a = this._adapters.get( c.adapter );
        if( ! a ) throw new TranslationError( 'invalid-input', 'No such adapter', { field: 'adapter' } );
        c.options = a.validateOptions( c.options );
        c.name = c.name.trim();
        this._saved.custom.push( { id: c.id, name: c.name, adapter: c.adapter, enabled: c.enabled, score: c.score,
                                   timeoutMs: c.timeoutMs, options: c.options } );
        this._rebuild();
        this._save();
        return this.getEngine( c.id );
    }

    removeEngine( id )
    {
        const e = this._engine( id );
        if( e.builtIn ) throw new TranslationError( 'invalid-input', 'Built-in engines can only be disabled', { field: 'id' } );
        this._saved.custom = this._saved.custom.filter( ( x ) => x.id !== id );
        this._rebuild();
        this._save();
    }

    async getAvailability( id, source, target ) { return this._availability( this._engine( id ), source, target ); }

    async prepareEngine( id, source, target, options = {} )
    {
        const e = this._engine( id );
        const a = this._adapters.get( e.adapter );
        if( ! a ) throw new TranslationError( 'unavailable', 'Adapter not available' );
        if( await this._availability( e, source, target ) === 'unavailable' ) throw new TranslationError( 'unsupported', 'Pair not supported' );
        await a.prepare( { source, target, options: e.options, signal: options.signal, onProgress: options.onProgress } );
    }

    async testEngine( id, options = {} )
    {
        const e = this._engine( id );
        const source = options.source || 'es', target = options.target || 'fr';
        const a = this._adapters.get( e.adapter );
        const started = now();
        try
        {
            if( ! a ) throw new TranslationError( 'unavailable', 'Adapter not available' );
            const av = await this._availability( e, source, target );
            if( av === 'unavailable' ) throw new TranslationError( 'unavailable', 'Not available here' );
            if( av === 'downloadable' ) await a.prepare( { source, target, options: e.options, signal: options.signal, onProgress: options.onProgress } );
            const text = await this._translateWith( e, a, TEST_SENTENCE[ source ], source, target, options.signal || new AbortController().signal );
            this._success( e );
            return { engineId: id, ok: true, text, ms: Math.round( now() - started ) };
        }
        catch( err )
        {
            return { engineId: id, ok: false, category: categorize( err, options.signal ), message: String( err && err.message || err ),
                     ms: Math.round( now() - started ) };
        }
    }

    async getLocalModels()
    {
        const out = [];
        for( const e of this._engines )
        {
            const a = this._adapters.get( e.adapter );
            if( a && a.localModels ) for( const m of await a.localModels() ) out.push( Object.assign( { engineId: e.id }, m ) );
        }
        return out;
    }

    async deleteLocalModel( engineId, source, target )
    {
        const e = this._engine( engineId ), a = e && this._adapters.get( e.adapter );
        if( ! a || ! a.deleteModel ) return 0;
        const freed = await a.deleteModel( { source, target } );
        // Every pair that went through this model (directly or via English)
        // asks again before it downloads.
        const used = ( k ) =>
        {
            if( ! k.startsWith( engineId + ':' ) ) return false;
            const [ s, t ] = k.slice( engineId.length + 1 ).split( '-' );
            return ( s === source || source === 'en' ) && ( t === target || target === 'en' );
        };
        this.setPreferences( { downloadsAllowed: this._prefs.downloadsAllowed.filter( ( k ) => ! used( k ) ) } );
        return freed;
    }

    registerAdapter( adapter )
    {
        const ok = adapter && typeof adapter.id === 'string' && [ 'local', 'remote' ].includes( adapter.location ) &&
                   typeof adapter.validateOptions === 'function' && typeof adapter.availability === 'function' &&
                   typeof adapter.prepare === 'function' && typeof adapter.translate === 'function' &&
                   ( ! adapter.canDetect || typeof adapter.detect === 'function' );
        if( ! ok ) throw new TranslationError( 'invalid-input', 'Adapter does not fulfil the contract', { field: 'adapter' } );
        if( this._adapters.has( adapter.id ) ) throw new TranslationError( 'invalid-input', 'Adapter id taken', { field: 'id' } );
        this._adapters.set( adapter.id, adapter );
        if( this._saved ) this._rebuild();
    }

    getAdapters()
    {
        return Array.from( this._adapters.values(), ( a ) => ( { id: a.id, location: a.location, maxChars: a.maxChars,
                                                               canDetect: !! a.canDetect, optionsSchema: clone( a.optionsSchema || [] ) } ) );
    }

    //------------------------------------------------------------------------//
    // LOCAL MODE

    isLocalMode() { return this._prefs.localMode; }

    setLocalMode( enabled )
    {
        this.setPreferences( { localMode: !! enabled } );
        this._emit( 'local-mode-changed', { enabled: !! enabled } );
    }

    //------------------------------------------------------------------------//
    // OCR, SPEECH (ocr.js, speech.js do the work)

    async recognizeImage( image, options = {} )
    {
        if( ! this._ocr ) throw new TranslationError( 'unavailable', 'No OCR' );
        const lang = options.language && options.language !== 'auto' ? options.language : 'es';
        return this._ocr.recognize( image, Object.assign( {}, options, { language: lang, maxLength: this._prefs.maxTextLength } ) );
    }

    async getVoices( language )
    {
        if( ! this._speech ) return [];
        return this._speech.voices( language, this._prefs.localMode );
    }

    async speak( text, language, options = {} )
    {
        if( ! this._speech ) throw new TranslationError( 'unavailable', 'No speech synthesis' );
        if( typeof text !== 'string' || ! text.trim() ) throw new TranslationError( 'invalid-input', 'Empty text', { field: 'text' } );
        this._emit( 'speech-start' );
        try { await this._speech.speak( text, language, Object.assign( { localOnly: this._prefs.localMode }, options ) ); }
        finally { this._emit( 'speech-end' ); }
    }

    stopSpeaking() { if( this._speech ) this._speech.stop(); }

    isSpeaking() { return !! ( this._speech && this._speech.speaking() ); }

    //------------------------------------------------------------------------//
    // DICTIONARIES

    async lookup( word, options = {} )
    {
        this._alive();
        const w = String( word || '' ).trim().toLowerCase();
        if( ! w ) throw new TranslationError( 'invalid-input', 'Empty word', { field: 'word' } );
        const { source, target, signal } = options;
        if( ! LANGS.includes( source ) || ! LANGS.includes( target ) || source === target )
            throw new TranslationError( 'invalid-input', 'Bad languages', { field: 'target' } );
        const remoteOk = options.allowRemote || ! this._prefs.localMode;
        const use = this._dicts.filter( ( d ) => d.enabled && this._dictSources[ d.id ] &&
            ( ! options.dictionaryIds || options.dictionaryIds.includes( d.id ) ) );
        const allowed = use.filter( ( d ) => remoteOk || d.location === 'local' );
        if( ! allowed.length )
        {
            if( use.length ) throw new LocalModeError( source, target, [] );
            throw new TranslationError( 'unavailable', 'No dictionary' );
        }
        const entry = { word: w, source, target, category: '', senses: [], examples: [], sources: [] };
        const failures = [];
        await Promise.all( allowed.map( async ( d ) =>
        {
            try
            {
                const r = await this._dictSources[ d.id ].lookup( w, { source, target, signal } );
                if( ! r ) return;
                if( r.word && entry.word === w ) entry.word = r.word;
                if( r.category && ! entry.category ) entry.category = r.category;
                entry.senses.push( ...( r.senses || [] ) );
                entry.examples.push( ...( r.examples || [] ).map( ( x ) => Object.assign( { dictionaryId: d.id }, x ) ) );
                if( ( r.senses && r.senses.length ) || ( r.examples && r.examples.length ) ) entry.sources.push( d.id );
            }
            catch( err ) { failures.push( err ); }
        } ) );
        if( signal && signal.aborted ) throw abortError( signal );
        if( ! entry.sources.length )
        {
            if( failures.length === allowed.length ) throw failures[ 0 ] instanceof TranslationError ? failures[ 0 ] : new TranslationError( 'network', 'Lookup failed' );
            return null;
        }
        return entry;
    }

    getDictionaries() { return clone( this._dicts ); }

    setDictionaryEnabled( id, enabled )
    {
        if( ! this._dicts.some( ( d ) => d.id === id ) ) throw new TranslationError( 'invalid-input', 'No such dictionary', { field: 'id' } );
        const base = this._dictCatalog.find( ( d ) => d.id === id );
        if( !! enabled === base.enabled ) delete this._saved.dictionaries[ id ];
        else this._saved.dictionaries[ id ] = { enabled: !! enabled };
        this._rebuild();
        this._save();
    }

    //------------------------------------------------------------------------//
    // SETTINGS

    getPreferences() { return clone( this._prefs ); }

    setPreferences( patch )
    {
        const p = clone( patch || {} );
        checkPreferences( p );
        const next = Object.assign( {}, this._saved.preferences, p );
        for( const k of Object.keys( next ) ) if( JSON.stringify( next[ k ] ) === JSON.stringify( DEFAULT_PREFERENCES[ k ] ) ) delete next[ k ];
        this._saved.preferences = next;
        this._rebuild();
        this._save();
        return this.getPreferences();
    }

    resetConfig()
    {
        this._saved = emptySaved( this._catalogVersion );
        this._runtime.clear();
        this._rebuild();
        try { this._storage && this._storage.removeItem( this._key ); } catch( e ) {}
        this._emit( 'config-changed' );
    }

    //------------------------------------------------------------------------//
    // EVENTS

    on( type, listener )
    {
        if( ! this._listeners.has( type ) ) this._listeners.set( type, new Set() );
        this._listeners.get( type ).add( listener );
        return () => this.off( type, listener );
    }

    off( type, listener ) { const s = this._listeners.get( type ); if( s ) s.delete( listener ); }

    _emit( type, detail )
    {
        for( const key of [ type, '*' ] )
            for( const fn of Array.from( this._listeners.get( key ) || [] ) )
                try { fn( { type, detail } ); } catch( e ) { setTimeout( () => { throw e; } ); }
    }

    _alive()
    {
        if( this._disposed ) throw new TranslationError( 'internal', 'Disposed' );
        if( ! this._saved ) throw new TranslationError( 'internal', 'Call init() first' );
    }
}

//------------------------------------------------------------------------//
// HELPERS

function publicEngine( e )
{
    return { id: e.id, name: e.name, adapter: e.adapter, enabled: e.enabled, score: e.score, location: e.location,
             timeoutMs: e.timeoutMs, options: clone( e.options || {} ), builtIn: e.builtIn, missingAdapter: !! e.missingAdapter };
}

// A child controller that aborts when the deadline passes or the parent aborts.
function withTimeout( task, ms, parentSignal )
{
    const controller = new AbortController();
    const onAbort = () => controller.abort( parentSignal.reason );
    if( parentSignal.aborted ) onAbort(); else parentSignal.addEventListener( 'abort', onAbort, { once: true } );
    const timer = setTimeout( () => controller.abort( new TranslationError( 'timeout', 'Too slow', { timeout: true } ) ), ms );
    return Promise.race( [
        task( controller.signal ),
        new Promise( ( _, reject ) => controller.signal.addEventListener( 'abort', () => reject( abortError( controller.signal ) ), { once: true } ) )
    ] ).finally( () => { clearTimeout( timer ); parentSignal.removeEventListener( 'abort', onAbort ); } );
}

function isTimeout( signal ) { return signal.reason instanceof TranslationError && signal.reason.category === 'timeout'; }

function nextMidnight() { const d = new Date(); d.setHours( 24, 0, 0, 0 ); return d; }

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

function safeLocalStorage()
{
    try { return typeof localStorage !== 'undefined' ? localStorage : null; }
    catch( e ) { return null; }
}
