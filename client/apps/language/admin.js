/*
 * admin.js - Language: its settings in the admin panel (admin.html,
 * "Language" tab). Only the admin picks the engines and dictionaries; every
 * account uses them. They live on the server (/api/translate/config,
 * config/language.json) and the app reads them when it opens (page.js ->
 * Translator options.shared). A person's own choices (languages, Local mode,
 * downloaded models) stay in their browser.
 *
 * The rows are the ones the app's gear had. The Translator here saves through
 * serverStorage() instead of localStorage, so its setters PUT to the server.
 */

import { Translator } from './translator.js';
import { CATALOG_VERSION } from './config.js';
import { emptySaved } from './settings.js';
import chromeBuiltin from './engine-chrome.js';
import bergamot from './engine-bergamot.js';
import mymemory from './engine-mymemory.js';
import libretranslate from './engine-libretranslate.js';
import lingva from './engine-lingva.js';
import { wiktionary, tatoeba } from './dictionaries.js';

await Ayni.i18n.ready;

const T  = ( k ) => Ayni.t( k );
const TF = ( k, v ) => Ayni.tf( k, v );
const $  = ( id ) => document.getElementById( id );
const URL_CFG = '/api/translate/config';

let tr = null;

function el( tag, cls, text )
{
    const e = document.createElement( tag );
    if( cls ) e.className = cls;
    if( text != null ) e.textContent = text;
    return e;
}

//------------------------------------------------------------------------//
// THE SERVER AS THE TRANSLATOR'S STORAGE

// getItem gives what the server sent; setItem sends the admin's part back,
// one PUT after the other, so the last change always lands last.
function serverStorage( shared )
{
    let last = JSON.stringify( shared );
    let chain = Promise.resolve();
    const put = ( body ) =>
    {
        if( body === last ) return;
        last = body;
        chain = chain.then( async () =>
        {
            const r = await fetch( URL_CFG, { method: 'PUT', credentials: 'same-origin',
                                              headers: { 'Content-Type': 'application/json' }, body } ).catch( () => null );
            if( r && r.status === 401 && NayiveUI.sessionExpired ) NayiveUI.sessionExpired();
            else if( ! r || ! r.ok ) Ayni.toast( 'err', T( 'ui.saveFailed' ) );
        } );
    };
    return {
        getItem: () => JSON.stringify( Object.assign( emptySaved( CATALOG_VERSION ), shared ) ),
        setItem( key, json )
        {
            const o = JSON.parse( json );
            put( JSON.stringify( { engines: o.engines, custom: o.custom, dictionaries: o.dictionaries } ) );
        },
        removeItem() { put( JSON.stringify( { engines: {}, custom: [], dictionaries: {} } ) ); }
    };
}

//------------------------------------------------------------------------//
// ENGINES

function whereText( e )
{
    return T( e.location === 'remote' ? 'language.whereRemote' : 'language.whereLocal' );
}

async function renderEngines()
{
    const list = $( 'engineList' );
    const open = new Set( Array.from( list.querySelectorAll( 'li.open' ), ( li ) => li.dataset.id ) );
    list.textContent = '';
    for( const e of tr.getEngines() )
    {
        const li = el( 'li' );
        li.dataset.id = e.id;
        const row = el( 'div', 'cfg-row' );
        const name = el( 'span', 'cfg-name', e.name );
        const small = el( 'small', null, whereText( e ) + ' · ' + T( 'language.about.' + e.adapter ) );
        name.appendChild( small );
        name.setAttribute( 'role', 'button' );
        name.tabIndex = 0;
        const sw = el( 'span', 'switch' );
        const input = el( 'input' );
        input.type = 'checkbox';
        input.setAttribute( 'role', 'switch' );
        input.checked = e.enabled;
        input.disabled = e.missingAdapter;
        input.setAttribute( 'aria-label', TF( 'language.enable', { name: e.name } ) );
        input.addEventListener( 'change', () =>
        {
            try { tr.setEngineEnabled( e.id, input.checked ); }
            catch( err ) { input.checked = ! input.checked; Ayni.toast( 'warn', T( 'language.needUrl' ) ); }
        } );
        sw.append( input );
        row.append( name, sw );
        li.appendChild( row );
        list.appendChild( li );

        const toggle = () => { li.classList.toggle( 'open' ); if( li.classList.contains( 'open' ) ) engineDetails( li, e ); else li.querySelector( '.cfg-more' ).remove(); };
        name.addEventListener( 'click', toggle );
        name.addEventListener( 'keydown', ( ev ) => { if( ev.key === 'Enter' || ev.key === ' ' ) { ev.preventDefault(); toggle(); } } );
        if( open.has( e.id ) ) { li.classList.add( 'open' ); engineDetails( li, e ); }

        if( e.missingAdapter ) small.textContent = T( 'language.noAdapter' );
    }
}

function field( label, input, help )
{
    const f = el( 'div', 'field' );
    const l = el( 'label', null, label );
    // Help about the field: Ayni's info "i" next to its label, never a line under it
    if( help ) { const i = el( 'button', 'info-tip' ); i.type = 'button'; i.dataset.help = help; l.append( ' ', i ); }
    const ctl = input.matches( '.input-group' ) ? input.querySelector( 'input' ) : input;   // a number field's group
    ctl.id = 'f' + Math.random().toString( 36 ).slice( 2 );
    l.htmlFor = ctl.id;
    f.append( l, input );
    return f;
}

function engineDetails( li, e )
{
    const more = el( 'div', 'cfg-more' );
    const err = el( 'p', 'form-error' );
    err.hidden = true;
    const save = ( patch ) =>
    {
        try { tr.updateEngine( e.id, patch ); err.hidden = true; return true; }
        catch( x ) { err.textContent = TF( 'language.badField', { field: x.details && x.details.field || '?' } ); err.hidden = false; return false; }
    };

    const rowF = el( 'div', 'field-row' );
    // Number fields (Ayni's): a comma is a decimal mark too; a value that is not a number is not saved
    const num = ( i ) => Number( String( i.value ).trim().replace( ',', '.' ) );
    const spin = ( i ) => { const g = el( 'div', 'input-group spin' ); g.appendChild( i ); return g; };
    const score = el( 'input', 'input' );
    Object.assign( score, { type: 'number', min: 0, max: 5, step: 0.5, value: e.score } );
    score.addEventListener( 'change', () => { const v = num( score ); if( Number.isFinite( v ) && v >= 0 && v <= 5 ) save( { score: v } ); } );
    const secs = el( 'input', 'input' );
    Object.assign( secs, { type: 'number', min: 1, max: 120, step: 1, value: Math.round( e.timeoutMs / 1000 ) } );
    secs.addEventListener( 'change', () => { const v = num( secs ); if( Number.isFinite( v ) && v >= 1 && v <= 120 ) save( { timeoutMs: Math.round( v * 1000 ) } ); } );
    rowF.append( field( T( 'language.score' ), spin( score ) ), field( T( 'language.timeout' ), spin( secs ) ) );
    more.appendChild( rowF );

    const schema = ( tr.getAdapters().find( ( a ) => a.id === e.adapter ) || {} ).optionsSchema || [];
    for( const o of schema )
    {
        const input = el( 'input', 'input' );
        input.type = o.type === 'url' ? 'url' : o.type === 'email' ? 'email' : 'text';
        input.value = e.options[ o.key ] || '';
        input.autocomplete = 'off';
        input.spellcheck = false;
        if( o.type === 'url' ) input.placeholder = 'https://';
        input.addEventListener( 'change', () => save( { options: Object.assign( {}, e.options, { [ o.key ]: input.value } ) } ) );
        more.appendChild( field( T( o.labelKey ), input, o.helpKey ? T( o.helpKey ) : '' ) );
    }
    more.appendChild( err );

    // Test: a sentence through this engine, in this browser.
    const btns = el( 'div', 'cfg-btns' );
    const test = el( 'button', 'btn text bordered', T( 'language.test' ) );
    test.type = 'button';
    const out = el( 'span', 'cfg-test' );
    test.addEventListener( 'click', async () =>
    {
        Ayni.setBusy( test, T( 'ui.wait' ) );
        out.className = 'cfg-test';
        out.textContent = T( 'language.testing' );
        const r = await tr.testEngine( e.id, { source: 'es', target: 'fr',
                                               onProgress: ( p ) => { out.textContent = TF( 'language.downloadingPct', { pct: Math.round( p * 100 ) } ); } } );
        Ayni.setBusy( test, false );
        out.className = 'cfg-test' + ( r.ok ? '' : ' bad' );
        out.textContent = r.ok ? TF( 'language.testOk', { text: r.text, ms: r.ms } ) : T( 'language.err.' + r.category );
    } );
    btns.appendChild( test );
    if( ! e.builtIn )
    {
        const del = el( 'button', 'btn text bordered danger', T( 'ui.delete' ) );
        del.type = 'button';
        del.addEventListener( 'click', () => { tr.removeEngine( e.id ); } );
        btns.appendChild( del );
    }
    more.append( btns, out );
    li.appendChild( more );
}

let soon = 0;
function renderEnginesSoon() { clearTimeout( soon ); soon = setTimeout( renderEngines, 50 ); }

function openAddEngine()
{
    $( 'addName' ).value = '';
    $( 'addUrl' ).value = '';
    $( 'addError' ).hidden = true;
    document.getElementById( 'addBackdrop' ).showModal();
}

function saveNewEngine()
{
    const kind = $( 'addKind' ).value;
    const name = $( 'addName' ).value.trim() || ( kind === 'lingva' ? 'Lingva' : 'LibreTranslate' );
    let id = kind + '-' + name.toLowerCase().normalize( 'NFD' ).replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' ).slice( 0, 24 );
    const taken = new Set( tr.getEngines().map( ( e ) => e.id ) );
    for( let n = 2; taken.has( id ); n++ ) id = id.replace( /-\d+$/, '' ) + '-' + n;
    try
    {
        tr.addEngine( { id, name, adapter: kind, options: { baseUrl: $( 'addUrl' ).value } } );
        document.getElementById( 'addBackdrop' ).close();
    }
    catch( e )
    {
        $( 'addError' ).textContent = e.details && e.details.field === 'baseUrl' ? T( 'language.badUrl' ) : TF( 'language.badField', { field: e.details && e.details.field || '?' } );
        $( 'addError' ).hidden = false;
    }
}

//------------------------------------------------------------------------//
// DICTIONARIES

function renderDicts()
{
    const list = $( 'dictList' );
    list.textContent = '';
    for( const d of tr.getDictionaries() )
    {
        const li = el( 'li' );
        const row = el( 'label', 'cfg-row' );
        const name = el( 'span', 'cfg-name', d.name );
        name.appendChild( el( 'small', null, whereText( d ) + ' · ' + T( 'language.about.' + d.id ) ) );
        const sw = el( 'span', 'switch' );
        const input = el( 'input' );
        input.type = 'checkbox';
        input.setAttribute( 'role', 'switch' );
        input.checked = d.enabled;
        input.addEventListener( 'change', () => tr.setDictionaryEnabled( d.id, input.checked ) );
        sw.append( input );
        row.append( name, sw );
        li.appendChild( row );
        list.appendChild( li );
    }
}

//------------------------------------------------------------------------//
// RESTORE DEFAULTS

async function resetConfig()
{
    if( ! await Ayni.confirm( { title: T( 'language.reset' ), body: T( 'language.resetAsk' ), confirm: T( 'language.reset' ), danger: true } ) ) return;
    tr.resetConfig();
    Ayni.toast( 'ok', T( 'language.resetDone' ) );
}

//------------------------------------------------------------------------//
// START: only for the admin (anyone else gets no answer to build on).

async function start()
{
    const r = await fetch( URL_CFG, { credentials: 'same-origin' } ).catch( () => null );
    if( ! r || ! r.ok ) return;
    const shared = await r.json().catch( () => ( {} ) );

    tr = new Translator( {
        adapters: [ chromeBuiltin, bergamot, mymemory, libretranslate, lingva ],
        dictionarySources: { wiktionary, tatoeba },
        storage: serverStorage( shared )
    } );
    await tr.init();

    $( 'addEngineBtn' ).addEventListener( 'click', openAddEngine );
    $( 'addSaveBtn' ).addEventListener( 'click', saveNewEngine );
    $( 'resetBtn' ).addEventListener( 'click', resetConfig );
    tr.on( 'config-changed', () => { renderEnginesSoon(); renderDicts(); } );
    renderEngines();
    renderDicts();
}

start();
