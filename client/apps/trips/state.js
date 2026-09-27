/* state.js - app state, the T/TF string helpers and the static SVG icons. */

//------------------------------------------------------------------------//
// STATE

// Filled in on DOMContentLoaded: shared/gum-api.js and shared/store.js
// now load deferred, so GumApi / NayiveStore are not defined while this
// script is parsed. Every reader runs later (DCL or an event).
let API_FILES;
let store;             // offline-capable persistence, each trip.json goes through it (see ../shared/store.js)
let refresher;         // shared/ui.js wireRefresh handle - the plug's click calls refreshNow()

let trips          = [];
let view           = 'list';   // 'list' | 'detail'
let selectedTripId = null;
let clockTimer     = null;

//------------------------------------------------------------------------//
// ICONS (static markup only - never interpolate user text into these)

// Interface strings: every one of them lives in shared/i18n/*.json.
const T  = k           => NayiveUI.t( k );
const TF = ( k, vars ) => NayiveUI.tf( k, vars );

const ICON_TRIP =
    '<ellipse cx="5.5" cy="9" rx="2" ry="2.5"></ellipse><ellipse cx="12" cy="6" rx="2.1" ry="2.6"></ellipse><ellipse cx="18.5" cy="9" rx="2" ry="2.5"></ellipse>' +
    '<path d="M12 12c-4.5 0-7.8 2-7.8 4.4 0 2 2.55 3.3 5.4 2.9 1.35-.2 1.5-.7 2.4-.7s1.05.5 2.4.7c2.85.4 5.4-.9 5.4-2.9C19.8 14 16.5 12 12 12z"></path>';
const ICON_PLUS       = '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>';
// "Go back" - same left arrow the shared dialog buttons use (NayiveUI ICONS.back).
// An arrow, not a chevron: arrows navigate, chevrons only expand or step in
// place (NayiveUI ICONS.back / ICONS.forward).
const ICON_ARROW_L    = '<line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>';
const ICON_CHEVRON_DOWN = '<polyline points="6 9 12 15 18 9"></polyline>';
// Drag-reorder grip - six dots, filled (not stroked like the svgIcon() icons).
const GRIP_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle></svg>';
const ICON_PENCIL     = '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>';
const ICON_TRASH      = '<line x1="4" y1="7" x2="20" y2="7"></line><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"></path><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path>';
const ICON_CHECK      = '<polyline points="4 12 9 17 20 6"></polyline>';
const ICON_X          = '<line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line>';
const ICON_PIN        = '<path d="M12 21s-7-6.4-7-11a7 7 0 0 1 14 0c0 4.6-7 11-7 11z"></path><circle cx="12" cy="10" r="2.3"></circle>';
const ICON_HOUSE      = '<path d="M3 11 12 3l9 8"></path><path d="M5 9.5V21h14V9.5"></path><path d="M10 21v-6h4v6"></path>';
const ICON_CALENDAR   = '<rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>';
const ICON_CLOCK      = '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>';
const ICON_MAP        = '<path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2z"></path><line x1="9" y1="3" x2="9" y2="19"></line><line x1="15" y1="5" x2="15" y2="21"></line>';
// "Qué hay aquí" - a compass: what is around this stage, not a search box.
const ICON_COMPASS    = '<circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>';
const ICON_ROUTE      = '<circle cx="6" cy="19" r="2.5"></circle><circle cx="18" cy="5" r="2.5"></circle><path d="M8.5 19H17a3.5 3.5 0 0 0 0-7H7a3.5 3.5 0 0 1 0-7h8.5"></path>';
const ICON_CALCULATOR = '<rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="8" y1="6" x2="16" y2="6"></line>' +
    '<circle cx="8" cy="10.5" r="0.9" fill="currentColor" stroke="none"></circle><circle cx="12" cy="10.5" r="0.9" fill="currentColor" stroke="none"></circle><circle cx="16" cy="10.5" r="0.9" fill="currentColor" stroke="none"></circle>' +
    '<circle cx="8" cy="14.5" r="0.9" fill="currentColor" stroke="none"></circle><circle cx="12" cy="14.5" r="0.9" fill="currentColor" stroke="none"></circle><circle cx="16" cy="14.5" r="0.9" fill="currentColor" stroke="none"></circle>' +
    '<circle cx="8" cy="18.5" r="0.9" fill="currentColor" stroke="none"></circle><circle cx="12" cy="18.5" r="0.9" fill="currentColor" stroke="none"></circle>';
const ICON_FOLDER   = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>';
const ICON_FILE     = '<path d="M13 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><polyline points="13 2 13 8 19 8"></polyline>';
const ICON_LINK     = '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"></path><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"></path>';
const ICON_UPLOAD   = '<path d="M12 16V4"></path><polyline points="7 9 12 4 17 9"></polyline><path d="M5 20h14"></path>';
const ICON_EXPORT   = '<path d="M12 3v13"></path><polyline points="8 7 12 3 16 7"></polyline><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"></path>';
const ICON_EYE      = '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle>';
const ICON_EYE_OFF  = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path>';
const ICON_SHARE    = '<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"></line><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line>';
const ICON_HELP     = '<circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>';

// Explains the "Enlazar" / "Subir" choice on every document row. Shown as an
// info dot in the "Documentos" heading row - before the "+", in both the trip
// detail and the stage sheet.


function docsLabelInfoDot()
{
    const dot = document.createElement( 'button' );
    dot.className = 'info-dot';
    dot.setAttribute( 'data-i18n-attr', 'data-info:trips.docsInfo' );
    return dot;
}

const TRANSPORT_ICONS = {
    flight: '<path d="M16 10h4a2 2 0 0 1 0 4h-4l-4 7h-3l2 -7h-4l-2 2h-3l2 -4l-2 -4h3l2 2h4l-2 -7h3z"></path>',
    train:  '<rect x="6" y="3" width="12" height="12" rx="4"></rect><line x1="6" y1="9" x2="18" y2="9"></line><line x1="9" y1="15" x2="7.5" y2="19"></line><line x1="15" y1="15" x2="16.5" y2="19"></line>',
    car:    '<path d="M3 13l1.6-5.2A2 2 0 0 1 6.5 6.3h11a2 2 0 0 1 1.9 1.5L21 13"></path><rect x="2" y="13" width="20" height="5" rx="1.5"></rect><circle cx="7" cy="18.3" r="1.6"></circle><circle cx="17" cy="18.3" r="1.6"></circle>',
    bus:    '<rect x="4" y="4" width="16" height="13" rx="2"></rect><line x1="4" y1="10" x2="20" y2="10"></line><line x1="9" y1="17" x2="9" y2="20"></line><line x1="15" y1="17" x2="15" y2="20"></line><circle cx="8" cy="19" r="1.2"></circle><circle cx="16" cy="19" r="1.2"></circle>',
    ship:   '<circle cx="12" cy="4.5" r="2"></circle><line x1="12" y1="6.5" x2="12" y2="20"></line><path d="M5 11.5a7 7 0 0 0 14 0"></path><line x1="4" y1="11.5" x2="8.5" y2="11.5"></line><line x1="15.5" y1="11.5" x2="20" y2="11.5"></line>',
    other:  '<line x1="5" y1="12" x2="19" y2="12"></line><polyline points="13 6 19 12 13 18"></polyline>'
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

// Weather-forecast glyphs, keyed by the bucket wxBucket() maps a WMO code to.
const WX_ICONS = {
    clear:  '<circle cx="12" cy="12" r="4.5"></circle><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5"></path>',
    partly: '<circle cx="8" cy="7.5" r="3"></circle><path d="M8 1.7v1.5M2.3 7.5h1.5M3.8 3.3l1 1"></path><path d="M17.5 20H8a4.2 4.2 0 0 1-.6-8.4 5.5 5.5 0 0 1 10.6 1.5A3.6 3.6 0 0 1 17.5 20z"></path>',
    cloud:  '<path d="M17.5 19H7a4.5 4.5 0 0 1-.9-8.9 6 6 0 0 1 11.6 1.6A3.9 3.9 0 0 1 17.5 19z"></path>',
    fog:    '<path d="M17.5 15H7a4.5 4.5 0 0 1-.9-8.9 6 6 0 0 1 11.6 1.6A3.9 3.9 0 0 1 17.5 15z"></path><path d="M4 19h16M7 22h12"></path>',
    rain:   '<path d="M17.5 16H7a4.5 4.5 0 0 1-.9-8.9 6 6 0 0 1 11.6 1.6A3.9 3.9 0 0 1 17.5 16z"></path><line x1="8" y1="19" x2="7" y2="22"></line><line x1="12" y1="19" x2="11" y2="22"></line><line x1="16" y1="19" x2="15" y2="22"></line>',
    snow:   '<path d="M17.5 16H7a4.5 4.5 0 0 1-.9-8.9 6 6 0 0 1 11.6 1.6A3.9 3.9 0 0 1 17.5 16z"></path><path d="M8 20h.01M12 21h.01M16 20h.01"></path>',
    storm:  '<path d="M17.5 15H7a4.5 4.5 0 0 1-.9-8.9 6 6 0 0 1 11.6 1.6A3.9 3.9 0 0 1 17.5 15z"></path><polyline points="13 15 10 20 13 20 10 24"></polyline>',
    none:   '<path d="M17.5 19H7a4.5 4.5 0 0 1-.9-8.9 6 6 0 0 1 11.6 1.6A3.9 3.9 0 0 1 17.5 19z"></path><line x1="4" y1="4" x2="20" y2="20"></line>'
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
    passport: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><circle cx="8.5" cy="12" r="2"></circle><line x1="13" y1="10" x2="18" y2="10"></line><line x1="13" y1="13" x2="18" y2="13"></line>',
    visa:     '<path d="M12 3l7 3v6c0 4.8-3 8.4-7 9-4-.6-7-4.2-7-9V6l7-3z"></path><polyline points="9 12 11 14 15 10"></polyline>',
    booking:  '<rect x="3" y="6" width="18" height="12" rx="2"></rect><line x1="9" y1="6" x2="9" y2="18" stroke-dasharray="2.5 2.5"></line>',
    other:    '<path d="M13 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><polyline points="13 2 13 8 19 8"></polyline>'
};

function svgIcon( sPathsHtml, nSize, sExtraClass )
{
    const wrap = document.createElement( 'span' );
    wrap.className = 'icon-wrap' + (sExtraClass ? ' ' + sExtraClass : '');
    wrap.style.display = 'inline-flex';
    wrap.innerHTML = '<svg width="' + nSize + '" height="' + nSize + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + sPathsHtml + '</svg>';
    return wrap;
}
