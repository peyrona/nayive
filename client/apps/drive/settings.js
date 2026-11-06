// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * settings.js - Drive: the Settings dialog (the gear) and what it keeps.
 *
 * A close-only dialog: each field is kept the moment it changes.
 *   - Drive's own options: the account's, in data/drive/config.json, so every
 *     device follows them. Read once at start-up; any missing or unreadable
 *     value is the default, which always asks and writes nothing new.
 *   - Special folders: each app's own data/<app>/config.json `folder`, the
 *     same field its crumb changes (NayiveUI.changeLauncherFolder). No files
 *     move: it only says which folder the app shows.
 *   - Days in the bin: the server's (AyniNet.setTrashDays).
 */
"use strict";

const DRIVE_CFG  = 'data/drive/config.json';
const SORT_KEYS  = [ 'name', 'date', 'size', 'type' ];
const SET_APPS   = [ 'photos', 'music', 'movies' ];
const SET_ICONS  = { photos: 'image', music: 'music', movies: 'film' };

let drivePrefs = { sort: 'name', thumbs: true, convert: 'ask', officeTwin: true, clash: 'ask' };

function tidyPrefs( c )
{
    c = ( c && typeof c === 'object' && ! Array.isArray( c ) ) ? c : {};
    return {
        sort:       SORT_KEYS.includes( c.sort ) ? c.sort : 'name',
        thumbs:     c.thumbs !== false,
        convert:    [ 'always', 'never' ].includes( c.convert ) ? c.convert : 'ask',
        officeTwin: c.officeTwin !== false,
        clash:      c.clash === 'keep' ? 'keep' : 'ask'
    };
}

async function loadDrivePrefs()
{
    try { drivePrefs = tidyPrefs( await AyniNet.readJson( DRIVE_CFG ) ); }
    catch( _ ) { /* the defaults */ }
}

// One option, over what the file holds NOW (another device may have saved).
// A file that is not an object is left as it is: the save fails and says so.
async function savePref( key, value )
{
    await AyniNet.updateJson( DRIVE_CFG, function( cur )
    {
        if( cur !== null && ( typeof cur !== 'object' || Array.isArray( cur ) ) ) throw new Error( DRIVE_CFG + ' is not an object' );
        const next = Object.assign( {}, cur );
        next[ key ] = value;
        return next;
    } );
    drivePrefs[ key ] = value;
}

// The listing's order inside folders and inside files; 0 falls back on the name.
function bySortPref( a, b )
{
    switch( drivePrefs.sort )
    {
        case 'date': return ( b.mtime || 0 ) - ( a.mtime || 0 );            // newest first
        case 'size': return ( b.size  || 0 ) - ( a.size  || 0 );            // biggest first
        case 'type': return typeExt( a ).localeCompare( typeExt( b ) );
        default:     return 0;
    }
}

//------------------------------------------------------------------------//
// THE DIALOG

const SET_PICKERS  = { setSort: 'sort', setConvert: 'convert', setClash: 'clash' };
const SET_SWITCHES = { setThumbs: 'thumbs', setTwin: 'officeTwin' };
const setCtls      = {};

function folderOpts( app )
{
    const o = { app: app, title: T( app + '.whereFolder' ) };
    if( app === 'photos' ) { o.allowRoot = true; o.rootLabel = T( 'ui.fp.allFiles' ); }     // as Photos' crumb
    return o;
}

async function paintSetFolder( app )
{
    const el = document.querySelector( '#setFolders [data-app="' + app + '"] .set-path' );
    try
    {
        const cfg = await AyniNet.readJson( 'data/' + app + '/config.json' );
        el.textContent = cfg && cfg.folder ? NayiveMedia.dirLabel( cfg.folder ) : T( 'drive.setNotSet' );
    }
    catch( _ ) { el.textContent = '—'; }
}

async function pickSetFolder( app )
{
    const picked = await NayiveUI.changeLauncherFolder( folderOpts( app ) );
    if( ! picked ) return;
    await paintSetFolder( app );            // what the file says, not what was picked
    loadFolderMarks();                      // the badges move at once
}

async function paintSetDays()
{
    const box   = document.getElementById( 'setDaysField' );
    const input = document.getElementById( 'setDays' );
    try
    {
        const days = String( ( await AyniNet.trashDays() ).days );
        input.value = days;
        setCtls.setDays.saved( days );
        box.hidden = false;
    }
    catch( _ ) { box.hidden = true; }
}

function openSettings()
{
    for( const id in SET_PICKERS )
    {
        const v = drivePrefs[ SET_PICKERS[ id ] ];
        Ayni.picker( document.getElementById( id ) ).set( v );
        setCtls[ id ].saved( v );
    }
    for( const id in SET_SWITCHES )
    {
        const v = drivePrefs[ SET_SWITCHES[ id ] ];
        document.getElementById( id ).checked = v;
        setCtls[ id ].saved( v );
    }
    SET_APPS.forEach( paintSetFolder );
    paintSetDays();
    document.getElementById( 'setMsg' ).hidden = true;
    setBackdrop( 'settingsBackdrop', true );
}

function wireSettings()
{
    const msg = document.getElementById( 'setMsg' );

    document.getElementById( 'settingsBtn'      ).addEventListener( 'click', openSettings );
    document.getElementById( 'settingsCloseBtn' ).addEventListener( 'click', function() { setBackdrop( 'settingsBackdrop', false ); } );

    const box = document.getElementById( 'setFolders' );
    SET_APPS.forEach( function( app )
    {
        const row = document.createElement( 'div' );
        row.className   = 'set-folder';
        row.dataset.app = app;
        row.innerHTML   = '<span class="icon" data-icon="' + SET_ICONS[ app ] + '"></span>' +
                          '<span class="set-text"><span class="set-name"></span><span class="set-path"></span></span>' +
                          '<button class="btn" type="button"><span class="icon" data-icon="edit"></span></button>';
        row.querySelector( '.set-name' ).textContent = T( 'drive.mark' + app.charAt( 0 ).toUpperCase() + app.slice( 1 ) );
        const btn = row.querySelector( 'button' );
        Ayni.setTip( btn, T( 'ui.changeFolder' ) );
        btn.setAttribute( 'aria-label', T( 'ui.changeFolder' ) );
        btn.addEventListener( 'click', function() { pickSetFolder( app ); } );
        box.appendChild( row );
    } );
    Ayni.init( box );

    const fields = Object.assign( {}, SET_PICKERS, SET_SWITCHES );
    for( const id in fields )
    {
        setCtls[ id ] = Ayni.autoSave( document.getElementById( id ), async function( v )
        {
            await savePref( fields[ id ], v );
            if( fields[ id ] === 'sort' || fields[ id ] === 'thumbs' ) render();
        }, { msg: msg } );
    }

    const days = document.getElementById( 'setDays' );
    setCtls.setDays = Ayni.autoSave( days, async function( v )
    {
        const n = parseInt( v, 10 );
        if( ! Number.isFinite( n ) ) throw new Error( 'not a number' );
        const res = await AyniNet.setTrashDays( Math.max( 1, Math.min( 90, n ) ) );
        days.value = String( res.days );
        setCtls.setDays.saved( days.value );
    }, { msg: msg } );
}
