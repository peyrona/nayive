/* state.js - app state, the T/TF string helpers and the static SVG icons. */

//------------------------------------------------------------------------//
// STATE

// Filled in on DOMContentLoaded: shared/ayni/ayni-net.js and shared/ayni/ayni-store.js
// now load deferred, so AyniNet / AyniStore are not defined while this
// script is parsed. Every reader runs later (DCL or an event).
let API_FILES;
let store;             // offline-capable persistence, each trip.json goes through it (see ../shared/ayni/ayni-store.js)
let refresher;         // shared/ui.js wireRefresh handle - the plug's click calls refreshNow()

let trips          = [];
let view           = 'list';   // 'list' | 'detail'
let selectedTripId = null;
let clockTimer     = null;

//------------------------------------------------------------------------//
// ICONS (static markup only - never interpolate user text into these)

// Interface strings: every one of them lives in shared/i18n/*.json.
const T  = k           => Ayni.t( k );
const TF = ( k, vars ) => Ayni.tf( k, vars );

const ICON_TRIP =
    '<use href="#i-trip"/>';
const ICON_PLUS       = '<use href="#i-plus-thin"/>';
// "Go back" - same left arrow the shared dialog buttons use (NayiveUI ICONS.back).
// An arrow, not a chevron: arrows navigate, chevrons only expand or step in
// place (NayiveUI ICONS.back / ICONS.forward).
const ICON_ARROW_L    = '<use href="#i-back"/>';
const ICON_CHEVRON_DOWN = '<use href="#i-chev-down"/>';
// Drag-reorder grip - six dots, filled (not stroked like the svgIcon() icons).
const GRIP_SVG = Ayni.icon( 'grip-dots', '', 15 );
const ICON_PENCIL     = '<use href="#i-pencil"/>';
const ICON_TRASH      = '<use href="#i-trash"/>';
const ICON_CHECK      = '<use href="#i-check-2"/>';
const ICON_X          = '<use href="#i-x-thin"/>';
const ICON_PIN        = '<use href="#i-pin-2"/>';
const ICON_HOUSE      = '<use href="#i-house"/>';
const ICON_CALENDAR   = '<use href="#i-calendar-plain"/>';
const ICON_CLOCK      = '<use href="#i-recent"/>';
const ICON_MAP        = '<use href="#i-map-2"/>';
// "Qué hay aquí" - a compass: what is around this stage, not a search box.
const ICON_COMPASS    = '<use href="#i-compass"/>';
const ICON_ROUTE      = '<use href="#i-route"/>';
const ICON_CALCULATOR = '<use href="#i-calculator"/>';
const ICON_FOLDER   = '<use href="#i-folder-3"/>';
const ICON_FILE     = '<use href="#i-file-3"/>';
const ICON_LINK     = '<use href="#i-link-2"/>';
const ICON_UPLOAD   = '<use href="#i-upload-2"/>';
const ICON_EXPORT   = '<use href="#i-export"/>';
const ICON_EYE      = '<use href="#i-eye"/>';
const ICON_EYE_OFF  = '<use href="#i-eye-off-2"/>';
const ICON_SHARE    = '<use href="#i-share"/>';
const ICON_HELP     = '<use href="#i-help"/>';

// Explains the "Enlazar" / "Subir" choice on every document row. Shown as an
// info dot in the "Documentos" heading row - before the "+", in both the trip
// detail and the stage sheet.


function docsLabelInfoDot()
{
    const dot = document.createElement( 'button' );
    dot.className = 'info-tip';
    dot.setAttribute( 'data-i18n-attr', 'data-help:trips.docsInfo' );
    return dot;
}

const TRANSPORT_ICONS = {
    flight: '<use href="#i-flight"/>',
    train:  '<use href="#i-train"/>',
    car:    '<use href="#i-car"/>',
    bus:    '<use href="#i-bus"/>',
    ship:   '<use href="#i-ship"/>',
    other:  '<use href="#i-other"/>'
};

// Transport picker options + the map colours each mode's route segment is drawn in.
// Colours are all dark/saturated so they read clearly on top of OpenStreetMap's
// pale land, blue water and green parks.
// Built on demand: the names come from the dictionary, which lands after
// this script has been parsed.
const TRANSPORT_OPTIONS = () => [ [ 'bus',    T( 'trips.trBus' )   ], [ 'flight', T( 'trips.trPlane' ) ],
                                  [ 'ship',   T( 'trips.trShip' )  ], [ 'car',    T( 'trips.trCar' )   ],
                                  [ 'train',  T( 'trips.trTrain' ) ], [ 'other',  T( 'trips.trOther' ) ] ];
const TRANSPORT_LABELS  = () => TRANSPORT_OPTIONS().reduce( function( m, o ) { m[ o[0] ] = o[1]; return m; }, {} );
const TRANSPORT_COLORS  = {
    flight: '#d81b60',
    train:  '#ef6c00',
    car:    '#6a1b9a',
    bus:    '#00838f',
    ship:   '#1565c0',
    other:  '#37474f'
};

// table[ key ] only for the table's OWN keys. A shared trip's JSON is someone
// else's text: a transport of "constructor" or "__proto__" would otherwise find
// Object's own members (a function where a label or a colour is expected).
function ownKey( table, key ) { return Object.hasOwn( table, key ) ? table[ key ] : undefined; }

// Weather-forecast glyphs, keyed by the bucket wxBucket() maps a WMO code to.
const WX_ICONS = {
    clear:  '<use href="#i-weather-clear"/>',
    partly: '<use href="#i-weather-partly"/>',
    cloud:  '<use href="#i-weather-cloud"/>',
    fog:    '<use href="#i-weather-fog"/>',
    rain:   '<use href="#i-weather-rain"/>',
    snow:   '<use href="#i-weather-snow"/>',
    storm:  '<use href="#i-weather-storm"/>',
    none:   '<use href="#i-weather-none"/>'
};

function wxBucket( code )
{
    if( code == null )                                    return 'cloud';
    if( code === 0 )                                      return 'clear';
    if( code <= 3 )                                       return 'partly';
    if( code === 45 || code === 48 )                      return 'fog';
    if( code >= 95 )                                      return 'storm';
    if( (code >= 71 && code <= 77) || code === 85 || code === 86 ) return 'snow';
    if( code >= 51 )                                      return 'rain';
    return 'cloud';
}
const WX_LABELS = () => ( { clear: T( 'trips.wxClear' ), partly: T( 'trips.wxPartly' ), cloud: T( 'trips.wxCloud' ),
                           fog: T( 'trips.wxFog' ), rain: T( 'trips.wxRain' ), snow: T( 'trips.wxSnow' ), storm: T( 'trips.wxStorm' ) } );

const DOC_TYPE_LABELS = () => ( { passport: T( 'trips.docPassport' ), visa: T( 'trips.docVisa' ),
                                  ticket: T( 'trips.docTicket' ), hotel: T( 'trips.docHotel' ), other: T( 'trips.docOther' ) } );

const DOC_ICONS = {
    passport: '<use href="#i-doc-passport"/>',
    visa:     '<use href="#i-doc-visa"/>',
    booking:  '<use href="#i-doc-booking"/>',
    other:    '<use href="#i-file-3"/>'
};

function svgIcon( sPathsHtml, nSize, sExtraClass )
{
    const wrap = document.createElement( 'span' );
    wrap.className = 'icon-wrap' + (sExtraClass ? ' ' + sExtraClass : '');
    wrap.style.display = 'inline-flex';
    wrap.innerHTML = '<svg width="' + nSize + '" height="' + nSize + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + sPathsHtml + '</svg>';
    return wrap;
}
