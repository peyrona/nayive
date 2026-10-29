/*
 * page.js - Language: the page. Waits for the dictionary, builds the one
 * Translator (translator.js) with its engines, dictionaries, OCR and voices,
 * then wires the translator view, the dictionary view and Settings (only
 * the downloaded models: the engines and dictionaries are the admin's,
 * admin.js). It only ever talks to the Translator; every third-party text is
 * shown with textContent, never as HTML.
 */

import { Translator, LocalModeError, AllEnginesFailedError } from './translator.js';
import { LANGS, languageName } from './languages.js';
import { MAX_TEXT_LENGTH } from './config.js';
import chromeBuiltin from './engine-chrome.js';
import bergamot from './engine-bergamot.js';
import mymemory from './engine-mymemory.js';
import libretranslate from './engine-libretranslate.js';
import lingva from './engine-lingva.js';
import { wiktionary, tatoeba } from './dictionaries.js';
import { ocr } from './ocr.js';
import { speech } from './speech.js';

await Ayni.i18n.ready;

const T  = ( k ) => Ayni.t( k );
const TF = ( k, v ) => Ayni.tf( k, v );
const $  = ( id ) => document.getElementById( id );
const VIEW_KEY = 'language.view';

// The engines and dictionaries are the admin's (admin.html, Language tab).
// No answer (offline, slow): the copy this browser kept last time.
const shared = await fetch( '/api/translate/config', { credentials: 'same-origin', signal: AbortSignal.timeout( 5000 ) } )
    .then( ( r ) => r.ok ? r.json() : null ).catch( () => null );

const tr = new Translator( {
    adapters: [ chromeBuiltin, bergamot, mymemory, libretranslate, lingva ],
    dictionarySources: { wiktionary, tatoeba },
    ocr, speech, shared
} );

const ui = () => Ayni.i18n.lang();
const langName = ( c ) => languageName( c, ui() );

function el( tag, cls, text )
{
    const e = document.createElement( tag );
    if( cls ) e.className = cls;
    if( text != null ) e.textContent = text;
    return e;
}

function mb( bytes ) { return bytes >= 1e6 ? Math.round( bytes / 1e6 ) + ' MB' : Math.max( 1, Math.round( bytes / 1e3 ) ) + ' KB'; }

//------------------------------------------------------------------------//
// LANGUAGE ROW

let detected = null;                       // the language "auto" found last time

function fillSelects()
{
    const p = tr.getPreferences();
    const from = $( 'from' ), to = $( 'to' );
    from.textContent = ''; to.textContent = '';
    from.appendChild( new Option( detected ? TF( 'language.detectedOpt', { lang: langName( detected ) } ) : T( 'language.detect' ), 'auto' ) );
    for( const c of LANGS ) { from.appendChild( new Option( langName( c ), c ) ); to.appendChild( new Option( langName( c ), c ) ); }
    from.value = p.source;
    to.value = p.target;
}

function savePair()
{
    try { tr.setPreferences( { source: $( 'from' ).value, target: $( 'to' ).value } ); } catch( e ) {}
}

// The pairs no engine can do now get a note, but stay pickable: in Local mode
// the translation then offers the internet once.
let pairsRun = 0;
async function markPairs()
{
    const run = ++pairsRun;
    const pairs = await tr.getSupportedPairs().catch( () => null );
    if( ! pairs || run !== pairsRun ) return;
    const src = $( 'from' ).value === 'auto' ? detected : $( 'from' ).value;
    for( const o of $( 'to' ).options )
    {
        const ok = ! src || src === o.value || pairs.some( ( x ) => x.source === src && x.target === o.value );
        o.textContent = ok ? langName( o.value ) : TF( 'language.noEngineOpt', { lang: langName( o.value ) } );
    }
}

function swapLangs()
{
    const from = $( 'from' ), to = $( 'to' );
    const src = from.value === 'auto' ? detected : from.value;
    if( ! src ) return;
    from.value = to.value;
    to.value = src;
    const out = $( 'out' );
    if( ! out.classList.contains( 'placeholder' ) && out.textContent.trim() )
    {
        $( 'src' ).value = out.textContent;
        setResult( null );
        onSrcInput();
    }
    savePair();
    markPairs();
    voiceCheck();
}

//------------------------------------------------------------------------//
// TRANSLATOR VIEW

let busy = null;                           // AbortController of the running translation
let lastResult = null;

function onSrcInput()
{
    const n = $( 'src' ).value.length;
    const c = $( 'count' );
    c.textContent = n.toLocaleString( ui() ) + ' / ' + MAX_TEXT_LENGTH.toLocaleString( ui() );
    c.classList.toggle( 'over', n >= MAX_TEXT_LENGTH );
    $( 'clearSrc' ).hidden = ! n;
}

function setResult( text, lang )
{
    const out = $( 'out' );
    lastResult = text;
    out.classList.toggle( 'placeholder', ! text );
    out.textContent = text || T( 'language.resultPh' );
    if( text && lang ) out.lang = lang === 'zh' ? 'zh-Hans' : lang; else out.removeAttribute( 'lang' );
    $( 'copy' ).ariaDisabled = ! text;
    $( 'copy' ).classList.remove( 'done' );
    voiceCheck();
}

function setStatus( parts, cls )
{
    const s = $( 'status' );
    s.textContent = '';
    s.className = 'lang-status' + ( cls ? ' ' + cls : '' );
    for( const p of [].concat( parts || [] ) ) s.appendChild( typeof p === 'string' ? document.createTextNode( p ) : p );
}

function setBusy( on )
{
    $( 'go' ).classList.toggle( 'busy', on );
    const k = on ? 'language.cancel' : 'language.translate';
    $( 'go' ).setAttribute( 'aria-label', T( k ) );
    Ayni.setTip( $( 'go' ), on ? T( 'language.cancel' ) : T( 'language.translateKey' ) );
}

function engineName( id )
{
    try { return tr.getEngine( id ).name; } catch( e ) { return id; }
}

// "On this device · Bergamot · 1 failed before [details]"
function showDone( r )
{
    const where = el( 'span', 'where' );
    const dot = el( 'span', 'dot' + ( r.location === 'remote' ? ' remote' : '' ) );
    where.append( dot, document.createTextNode( TF( r.location === 'remote' ? 'language.byRemote' : 'language.byLocal', { engine: r.engineName } ) ) );
    const parts = [ where ];
    if( r.detection ) parts.push( TF( 'language.detectedAs', { lang: langName( r.detection.language ) } ) + ( r.detection.short ? ' ' + T( 'language.shortText' ) : '' ) );
    if( r.warnings.includes( 'unchanged' ) ) parts.push( T( 'language.unchanged' ) );
    const failed = r.attempts.filter( ( a ) => ! a.ok && ! a.declined );
    if( failed.length ) parts.push( attemptsToggle( failed, TF( failed.length === 1 ? 'language.failedOne' : 'language.failedN', { n: failed.length } ) ) );
    setStatus( parts );
}

function attemptsToggle( attempts, label )
{
    const list = $( 'attempts' );
    list.textContent = '';
    list.hidden = true;
    for( const a of attempts ) list.appendChild( el( 'li', null, engineName( a.engineId ) + ': ' + T( 'language.err.' + ( a.category || 'internal' ) ) ) );
    const b = el( 'button', 'btn text bordered', label );
    b.type = 'button';
    b.addEventListener( 'click', () => { list.hidden = ! list.hidden; } );
    return b;
}

function progressBar( p )
{
    const bar = el( 'progress' );
    bar.max = 1;
    if( p != null ) bar.value = p;
    return bar;
}

function onEvent( e )
{
    const d = e.detail || {};
    if( e.type === 'detecting' ) setStatus( T( 'language.detecting' ) );
    else if( e.type === 'detected' ) { detected = d.language; fillSelects(); }
    else if( e.type === 'preparing' ) setStatus( [ TF( 'language.downloading', { engine: engineName( d.engineId ), pair: d.source + '→' + d.target,
                                                                                pct: Math.round( ( d.progress || 0 ) * 100 ) } ), progressBar( d.progress ) ] );
    else if( e.type === 'translating' ) setStatus( TF( 'language.translatingWith', { engine: engineName( d.engineId ) } ) );
}

async function confirmDownload( d )
{
    const body = TF( d.bytes ? 'language.dlBody' : 'language.dlBodyNoSize',
                     { from: langName( d.source ), to: langName( d.target ), engine: d.engineName, size: d.bytes ? mb( d.bytes ) : '' } );
    return Ayni.confirm( { title: T( 'language.dlTitle' ), body, confirm: T( 'language.dlYes' ) } );
}

async function translate( allowRemote )
{
    if( busy ) { busy.abort(); return; }
    const text = $( 'src' ).value;
    const source = $( 'from' ).value, target = $( 'to' ).value;
    if( ! text.trim() ) { setStatus( T( 'language.needText' ), 'error' ); $( 'src' ).focus(); return; }
    if( source === target ) { setStatus( T( 'language.sameLangs' ), 'error' ); return; }
    if( text.length > MAX_TEXT_LENGTH ) { setStatus( TF( 'language.tooLong', { n: MAX_TEXT_LENGTH } ), 'error' ); return; }

    $( 'attempts' ).hidden = true;
    const controller = new AbortController();
    busy = controller;
    setBusy( true );
    setStatus( T( 'language.working' ) );
    try
    {
        const r = await tr.translate( { text, source, target, allowRemote: !! allowRemote },
                                      { signal: controller.signal, onEvent, confirmDownload } );
        setResult( r.text, r.target );
        showDone( r );
    }
    catch( err )
    {
        if( busy !== controller ) return;
        await showError( err, allowRemote );
    }
    finally
    {
        if( busy === controller ) { busy = null; setBusy( false ); }
    }
}

async function showError( err, allowRemote )
{
    const c = err && err.category;
    if( c === 'aborted' ) { setStatus( T( 'language.cancelled' ) ); return; }
    if( err instanceof LocalModeError )
    {
        setStatus( TF( 'language.noLocal', { from: langName( err.source ), to: langName( err.target ) } ), 'error' );
        if( ! err.remoteEngineIds.length || allowRemote ) return;
        const names = err.remoteEngineIds.map( engineName ).join( ', ' );
        const yes = await Ayni.confirm( { title: T( 'language.noLocalTitle' ),
                                              body: TF( 'language.noLocalAsk', { from: langName( err.source ), to: langName( err.target ), engines: names } ),
                                              confirm: T( 'language.useOnline' ) } );
        if( yes ) translate( true );
        return;
    }
    if( err instanceof AllEnginesFailedError )
    {
        const tried = err.attempts.filter( ( a ) => ! a.declined );
        if( ! tried.length ) { setStatus( T( err.attempts.length ? 'language.declined' : 'language.noEngine' ), 'error' ); return; }
        setStatus( [ T( 'language.allFailed' ), attemptsToggle( tried, T( 'language.seeWhy' ) ) ], 'error' );
        $( 'attempts' ).hidden = false;
        return;
    }
    const why = err && err.details && err.details.reason;
    if( why === 'no-detector' ) { setStatus( T( 'language.noDetector' ), 'error' ); $( 'from' ).focus(); return; }
    if( why === 'low-confidence' ) { setStatus( T( 'language.unclear' ), 'error' ); $( 'from' ).focus(); return; }
    if( err && err.details && err.details.detected ) { setStatus( TF( 'language.detectedSame', { lang: langName( err.details.detected ) } ), 'error' ); return; }
    setStatus( T( 'language.err.' + ( c || 'internal' ) ), 'error' );
}

async function copyResult()
{
    if( ! lastResult ) return;
    try { await NayiveUI.copyText( lastResult ); $( 'copy' ).classList.add( 'done' ); Ayni.toast( 'ok', T( 'language.copied' ) ); }
    catch( e ) { Ayni.toast( 'err', T( 'language.copyFailed' ) ); }
}

// SPEECH: Play reads the translation; Play again stops it.
async function voiceCheck()
{
    const b = $( 'speak' );
    const lang = $( 'to' ).value;
    const voices = await tr.getVoices( lang ).catch( () => [] );
    const has = voices.length > 0;
    b.ariaDisabled = ! lastResult || ! has;
    Ayni.setTip( b, has ? T( 'language.listen' ) : TF( 'language.noVoice', { lang: langName( lang ) } ) );
}

async function speak()
{
    const b = $( 'speak' );
    if( tr.isSpeaking() ) { tr.stopSpeaking(); b.classList.remove( 'busy' ); return; }
    if( ! lastResult ) return;
    const lang = $( 'out' ).lang ? $( 'out' ).lang.split( '-' )[ 0 ] : $( 'to' ).value;
    b.classList.add( 'busy' );
    try { await tr.speak( lastResult, lang ); }
    catch( e ) { Ayni.toast( ( e.category === 'no-voice' ? 'warn' : 'err' ), e.category === 'no-voice' ? TF( 'language.noVoice', { lang: langName( lang ) } ) : T( 'language.speakFailed' ) ); }
    finally { b.classList.remove( 'busy' ); }
}

// OCR: a photo's text into the box, for the user to check first.
let ocrBusy = null;

async function onImage( file )
{
    if( ! file ) return;
    const st = $( 'ocr-status' ), btn = $( 'ocr-btn' );
    const lang = $( 'from' ).value === 'auto' ? 'es' : $( 'from' ).value;
    const controller = new AbortController();
    ocrBusy = controller;
    btn.setAttribute( 'aria-pressed', true );
    Ayni.setTip( btn, T( 'language.ocrCancel' ) );
    st.hidden = false;
    const bar = progressBar( 0 );
    const label = el( 'span', null, TF( 'language.ocrReading', { name: file.name || '', lang: langName( lang ), pct: 0 } ) );
    st.textContent = '';
    st.append( label, bar );
    try
    {
        const r = await tr.recognizeImage( file, { language: lang, signal: controller.signal, onProgress: ( p ) =>
        {
            bar.value = p;
            label.textContent = TF( 'language.ocrReading', { name: file.name || '', lang: langName( lang ), pct: Math.round( p * 100 ) } );
        } } );
        if( ! r.text.trim() ) { st.textContent = T( 'language.ocrNothing' ); return; }
        const src = $( 'src' );
        src.value = src.value.trim() ? src.value.replace( /\s*$/, '\n\n' ) + r.text : r.text;
        src.value = src.value.slice( 0, MAX_TEXT_LENGTH );
        onSrcInput();
        st.textContent = r.truncated ? T( 'language.ocrTruncated' ) : T( 'language.ocrDone' );
        src.focus();
    }
    catch( e )
    {
        st.textContent = e.category === 'aborted' ? T( 'language.cancelled' )
                       : e.category === 'invalid-input' ? T( 'language.ocrNotImage' )
                       : e.category === 'network' ? T( 'language.ocrNoNet' ) : T( 'language.ocrFailed' );
    }
    finally
    {
        if( ocrBusy === controller ) ocrBusy = null;
        btn.setAttribute( 'aria-pressed', false );
        Ayni.setTip( btn, T( 'language.ocr' ) );
    }
}

//------------------------------------------------------------------------//
// DICTIONARY VIEW

let lookupCtl = null;

function dictHint( text, button )
{
    const box = $( 'entry' );
    box.textContent = '';
    box.appendChild( el( 'p', 'hint', text ) );
    if( button ) box.appendChild( button );
}

async function lookup( allowRemote )
{
    const word = $( 'q' ).value.trim();
    if( ! word ) { $( 'entry' ).textContent = ''; return; }
    const source = $( 'from' ).value === 'auto' ? ( detected || 'es' ) : $( 'from' ).value, target = $( 'to' ).value;
    if( source === target ) { dictHint( T( 'language.sameLangs' ) ); return; }
    if( lookupCtl ) lookupCtl.abort();
    const ctl = new AbortController();
    lookupCtl = ctl;
    dictHint( T( 'language.searching' ) );
    try
    {
        const e = await tr.lookup( word, { source, target, signal: ctl.signal, allowRemote } );
        if( lookupCtl !== ctl ) return;
        if( ! e ) { dictHint( TF( 'language.dictNone', { word } ) ); return; }
        renderEntry( e );
    }
    catch( err )
    {
        if( lookupCtl !== ctl || err.category === 'aborted' ) return;
        if( err instanceof LocalModeError )
        {
            const b = el( 'button', 'btn text primary', T( 'language.searchOnline' ) );
            b.type = 'button';
            b.addEventListener( 'click', () => lookup( true ) );
            dictHint( T( 'language.dictLocal' ), b );
            return;
        }
        dictHint( err.category === 'unavailable' ? T( 'language.dictNoSource' ) : T( 'language.err.' + ( err.category || 'internal' ) ) );
    }
}

function renderEntry( e )
{
    const box = $( 'entry' );
    box.textContent = '';
    const head = el( 'div', 'lemma' );
    const w = el( 'b', null, e.word );
    w.lang = e.source;
    head.appendChild( w );
    if( e.category ) head.appendChild( el( 'i', null, e.category ) );
    box.appendChild( head );
    if( e.senses.length )
    {
        const ol = el( 'ol' );
        for( const s of e.senses )
        {
            const li = el( 'li' );
            const t = el( 'span', 'tr', s.translation );
            t.lang = e.target;
            li.appendChild( t );
            if( s.romanization ) li.appendChild( el( 'span', 'gram', ' ' + s.romanization ) );
            if( s.gloss ) li.appendChild( el( 'span', 'gram', ' · ' + s.gloss ) );
            ol.appendChild( li );
        }
        box.appendChild( ol );
    }
    for( const x of e.examples.slice( 0, 2 ) )
    {
        const ex = el( 'div', 'example' );
        ex.appendChild( el( 'span', 'section-label', T( 'language.example' ) ) );
        const a = el( 'span', null, x.source ); a.lang = e.source;
        const b = el( 'span', 't', x.target ); b.lang = e.target;
        ex.append( a, b );
        box.appendChild( ex );
    }
    const names = e.sources.map( ( id ) => ( tr.getDictionaries().find( ( d ) => d.id === id ) || { name: id } ).name );
    box.appendChild( el( 'span', 'dict-src', TF( 'language.sources', { list: names.join( ' · ' ) } ) ) );
}

//------------------------------------------------------------------------//
// VIEWS

function showView( id )
{
    for( const b of document.querySelectorAll( '.tb-modes .view-btn' ) )
    {
        const on = b.dataset.view === id;
        b.setAttribute( 'aria-pressed', on ? 'true' : 'false' );
        $( b.dataset.view ).hidden = ! on;
    }
    try { localStorage.setItem( VIEW_KEY, id ); } catch( e ) {}
}

//------------------------------------------------------------------------//
// SETTINGS

async function renderModels()
{
    const list = $( 'modelList' );
    list.textContent = '';
    const models = await tr.getLocalModels().catch( () => [] );
    if( ! models.length ) list.appendChild( el( 'li', 'empty', T( 'language.noModels' ) ) );
    for( const m of models )
    {
        const li = el( 'li', 'cfg-row' );
        li.appendChild( el( 'span', 'cfg-model', engineName( m.engineId ) + ' · ' + langName( m.source ) + ' → ' +
                                                langName( m.target ) + ( m.bytes ? ' · ' + mb( m.bytes ) : '' ) ) );
        const del = el( 'button', 'btn sm' );
        del.type = 'button';
        Ayni.setTip( del, T( 'ui.delete' ) );
        del.setAttribute( 'aria-label', T( 'ui.delete' ) );
        del.innerHTML = Ayni.icon( 'trash' );
        del.addEventListener( 'click', () => deleteModel( m ) );
        li.appendChild( del );
        list.appendChild( li );
    }
}

function openSettings()
{
    renderModels();
    document.getElementById( 'cfgBackdrop' ).showModal();
}

async function deleteModel( m )
{
    const freed = await tr.deleteLocalModel( m.engineId, m.source, m.target );
    Ayni.toast( 'ok', TF( 'language.freed', { size: mb( freed ) } ) );
    renderModels();
}

// Local mode switched off: the one-time word about where the text goes.
async function onLocalSwitch()
{
    const on = $( 'local' ).checked;
    tr.setLocalMode( on );
    if( on ) return;
    const p = tr.getPreferences();
    const remote = tr.getEngines().filter( ( e ) => e.enabled && e.location === 'remote' && ! p.remoteNoticeShown.includes( e.id ) );
    if( ! remote.length ) return;
    tr.setPreferences( { remoteNoticeShown: p.remoteNoticeShown.concat( remote.map( ( e ) => e.id ) ) } );
    Ayni.alert( { title: T( 'language.remoteTitle' ), body: TF( 'language.remoteBody', { engines: remote.map( ( e ) => e.name ).join( ', ' ) } ) } );
}

//------------------------------------------------------------------------//
// WIRING

function wire()
{
    $( 'from' ).addEventListener( 'change', () => { savePair(); markPairs(); } );
    $( 'to' ).addEventListener( 'change', () => { savePair(); markPairs(); voiceCheck(); } );
    $( 'swap' ).addEventListener( 'click', swapLangs );
    $( 'src' ).addEventListener( 'input', onSrcInput );
    $( 'src' ).addEventListener( 'keydown', ( e ) => { if( ( e.ctrlKey || e.metaKey ) && e.key === 'Enter' ) { e.preventDefault(); translate(); } } );
    $( 'go' ).addEventListener( 'click', () => translate() );
    $( 'clearSrc' ).addEventListener( 'click', () => { $( 'src' ).value = ''; onSrcInput(); setResult( null ); setStatus( '' ); $( 'src' ).focus(); } );
    $( 'copy' ).addEventListener( 'click', copyResult );
    $( 'speak' ).addEventListener( 'click', speak );
    $( 'ocr-btn' ).addEventListener( 'click', () => { if( ocrBusy ) ocrBusy.abort(); else $( 'ocr-file' ).click(); } );
    $( 'ocr-file' ).addEventListener( 'change', ( e ) => { onImage( e.target.files && e.target.files[ 0 ] ); e.target.value = ''; } );
    $( 'local' ).addEventListener( 'change', onLocalSwitch );
    $( 'q' ).addEventListener( 'keydown', ( e ) => { if( e.key === 'Enter' ) { e.preventDefault(); lookup(); } } );
    $( 'qGo' ).addEventListener( 'click', () => lookup() );
    for( const b of document.querySelectorAll( '.tb-modes .view-btn' ) ) b.addEventListener( 'click', () => showView( b.dataset.view ) );

    $( 'cfgBtn' ).addEventListener( 'click', openSettings );

    tr.on( 'config-changed', () =>
    {
        $( 'local' ).checked = tr.isLocalMode();
        markPairs();
    } );
    tr.on( 'storage-error', ( e ) => { if( e.detail && e.detail.reason === 'corrupt' ) Ayni.toast( 'warn', T( 'language.storageBad' ) ); } );
}

async function start()
{
    await tr.init();
    fillSelects();
    $( 'local' ).checked = tr.isLocalMode();
    onSrcInput();
    setResult( null );
    let view = 'v-tr';
    try { view = localStorage.getItem( VIEW_KEY ) || view; } catch( e ) {}
    showView( view === 'v-dic' ? 'v-dic' : 'v-tr' );
    wire();
    markPairs();
}

NayiveUI.firstRun( {
    app:   'language',
    title: 'Language',
    lead:  T( 'language.introLead' ),
    buttons: [
        { sel: '#tabTr',   text: T( 'language.introTr' ) },
        { sel: '#tabDic',  text: T( 'language.introDic' ) },
        { sel: '#ocr-btn', text: T( 'language.introOcr' ) },
        { sel: '#speak',   text: T( 'language.introSpeak' ) },
        { sel: '#cfgBtn',  text: T( 'language.introCfg' ) },
        { sel: '.local-row', text: T( 'language.tourLocal' ) }
    ],
    tour: [ { sel: '#langbar', text: T( 'language.tourLangs' ) }, 'buttons' ]
} );

await NayiveUI.bootWithStore( null, start );
window.nayiveLanguage = tr;           // the console's handle (and the tests')
