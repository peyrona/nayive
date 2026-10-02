/* discover.js - "Qué hay aquí": pick what you are after, then search the web for it.

   Nothing here talks to a server: the query is built in the page and handed to the
   device's own browser, so no key, no cost and no request ever leaves through Nayive.

   The place searched for is the stage's own text, NOT its geocoded st.tzLabel. The
   label would disambiguate a name like "Santiago", but location.js asks Nominatim
   with accept-language=en, so the label comes back English ("Brussels, Belgium")
   and would drag an otherwise Spanish query towards English pages. The user typed
   the name in their own language and would type the same into a search box - and
   the typed text is there even on a stage added offline, so the button always works. */

// What a traveller actually arrives wanting. A function, not a const array, so the
// labels follow a language change - exactly like TRANSPORT_OPTIONS() in state.js.
// The label doubles as the search term (lower-cased when the query is built).
//
// Sorted by label, with the interface language's own collation: twelve unrelated
// choices have no natural order, so alphabetical is the only one a reader can
// predict - and each language sorts its OWN words ("Einkaufen" sits elsewhere in
// German than "Compras" does in Spanish). The source order below is only how it
// reads in the file; sort() decides what is on screen. A fresh array each call,
// so the sort never mutates anything shared.
const DISCOVER_CATS = () => [
    [ 'shopping',    T( 'trips.disc.shopping'    ) ],
    [ 'kids',        T( 'trips.disc.kids'        ) ],
    [ 'concerts',    T( 'trips.disc.concerts'    ) ],
    [ 'exhibitions', T( 'trips.disc.exhibitions' ) ],
    [ 'markets',     T( 'trips.disc.markets'     ) ],
    [ 'monuments',   T( 'trips.disc.monuments'   ) ],
    [ 'museums',     T( 'trips.disc.museums'     ) ],
    [ 'nature',      T( 'trips.disc.nature'      ) ],
    [ 'free',        T( 'trips.disc.free'        ) ],
    [ 'food',        T( 'trips.disc.food'        ) ],
    [ 'nightlife',   T( 'trips.disc.nightlife'   ) ],
    [ 'tours',       T( 'trips.disc.tours'       ) ]
].sort( function( a, b ) { return a[ 1 ].localeCompare( b[ 1 ], NayiveUI.locale() ); } );

// First time only: the three that answer "I just got here, what do I look at?".
const DISCOVER_DEFAULT = [ 'exhibitions', 'museums', 'monuments' ];

let discoverPlace = '';   // the city as the user typed it - the title and the query
let discoverWhen  = '';   // "hoy" / "julio 2026" / "" - appended to the query
let discoverPicks = null; // Set of category keys, ticked in the sheet

//------------------------------------------------------------------------//
// THE TICKS, REMEMBERED

// The next city almost always wants the same things, so the ticks are kept
// across stages and trips. Same shape as the collapsed sections (render.js):
// localStorage, and a bad/absent value just falls back to the default.
function loadDiscoverPicks()
{
    try
    {
        const raw = JSON.parse( localStorage.getItem( 'trip-discover' ) || 'null' );

        if( Array.isArray( raw ) )
            return raw.filter( function( k ) { return typeof k === 'string'; } );
    }
    catch( e ) {}

    return DISCOVER_DEFAULT.slice();
}

function saveDiscoverPicks()
{
    try { localStorage.setItem( 'trip-discover', JSON.stringify( [ ...discoverPicks ] ) ); }
    catch( e ) {}
}

//------------------------------------------------------------------------//
// WHEN

// The date term that goes into the query. "Hoy" while the stage is happening -
// that is when "what is on" means today; otherwise the month it starts in, which
// is what you want while still planning. No dates at all -> nothing is added.
function discoverWhenFor( st )
{
    const start = ( st && st.startDate ) || '';
    const end   = ( st && st.endDate   ) || start;

    if( ! start )
        return '';

    const today = NayiveUI.todayIso();

    if( today >= start && today <= end )
        return T( 'trips.disc.today' );

    try
    {
        return new Date( start + 'T00:00:00' )
               .toLocaleDateString( NayiveUI.locale(), { month: 'long', year: 'numeric' } );
    }
    catch( e ) { return start; }
}

//------------------------------------------------------------------------//
// OPEN / CLOSE

function openDiscover( st )
{
    discoverPlace = ( ( st && st.location ) || '' ).trim();
    discoverWhen  = discoverWhenFor( st );
    discoverPicks = new Set( loadDiscoverPicks() );

    renderDiscoverSheet();
    openSheet( 'discoverSheetBackdrop' );
}

function closeDiscover()
{
    closeSheet( 'discoverSheetBackdrop' );
    discoverPicks = null;
}

//------------------------------------------------------------------------//
// THE SHEET

function renderDiscoverSheet()
{
    const sheet = document.getElementById( 'discoverSheet' );
    sheet.innerHTML = '';

    const h2 = document.createElement( 'h2' );
    h2.textContent = TF( 'trips.disc.title', { place: discoverPlace } );
    sheet.appendChild( h2 );

    const note = document.createElement( 'p' );
    note.className = 'share-note';
    note.textContent = T( 'trips.disc.note' );
    sheet.appendChild( note );

    const grid = document.createElement( 'div' );
    grid.className = 'disc-grid';

    DISCOVER_CATS().forEach( function( c )
    {
        const key   = c[ 0 ];
        const lab   = document.createElement( 'label' );
        lab.className = 'share-add disc-item';

        const box = document.createElement( 'input' );
        box.type    = 'checkbox';
        box.checked = discoverPicks.has( key );
        box.addEventListener( 'change', function()
        {
            if( box.checked ) discoverPicks.add( key ); else discoverPicks.delete( key );
            refreshDiscoverGo();   // never re-render: that would drop the tick you just made
        });

        lab.appendChild( box );
        lab.appendChild( document.createTextNode( c[ 1 ] ) );
        grid.appendChild( lab );
    });

    sheet.appendChild( grid );

    const actions = document.createElement( 'div' );
    actions.className = 'sheet-actions';

    const cancelBtn = document.createElement( 'button' );
    cancelBtn.type = 'button';
    cancelBtn.setAttribute( 'data-act', 'close' );
    cancelBtn.title = NayiveUI.t( 'ui.cancel' );
    cancelBtn.addEventListener( 'click', closeDiscover );

    // The one control that leaves Nayive, so it says where it goes. Kept a plain
    // click handler (no await before window.open) - a popup blocker only trusts a
    // window opened inside the gesture that asked for it.
    const goBtn = document.createElement( 'button' );
    goBtn.type = 'button';
    goBtn.id   = 'discoverGo';
    goBtn.setAttribute( 'data-act', 'primary:search' );
    goBtn.title = T( 'trips.disc.go' );
    goBtn.addEventListener( 'click', runDiscover );

    actions.appendChild( cancelBtn );
    actions.appendChild( goBtn );
    sheet.appendChild( actions );

    // Styles both buttons the shared Nayive way. It only rewrites their class and
    // innerHTML - it does not clone the nodes - so the listeners set above survive.
    NayiveUI.applySheetButtons( sheet );
    refreshDiscoverGo();
}

// Nothing ticked -> nothing to search for. Disabling the button says so without
// a warning line that would jump the dialog's height on every tick.
function refreshDiscoverGo()
{
    const go = document.getElementById( 'discoverGo' );

    if( go )
        go.disabled = discoverPicks.size === 0;
}

//------------------------------------------------------------------------//
// THE SEARCH

// "exposiciones, museos en Dublín hoy". Natural language, not OR operators: it
// reads the same way in all six languages and every engine copes with it. The
// terms follow the on-screen (alphabetical) order, not the order they were ticked
// in, so the same set of ticks always produces the same query.
function discoverQuery()
{
    const order = DISCOVER_CATS().filter( function( c ) { return discoverPicks.has( c[ 0 ] ); } );
    const what  = order.map( function( c ) { return c[ 1 ].toLocaleLowerCase( NayiveUI.locale() ); } ).join( ', ' );
    const base  = TF( 'trips.disc.query', { what: what, place: discoverPlace } );

    return discoverWhen ? base + ' ' + discoverWhen : base;
}

function runDiscover()
{
    if( ! discoverPicks || discoverPicks.size === 0 )
        return;

    saveDiscoverPicks();

    const url = 'https://duckduckgo.com/?q=' + encodeURIComponent( discoverQuery() );

    closeDiscover();

    // _blank leaves Nayive: in a browser tab that is a new tab, and in the
    // installed PWA it hands the query to the device's own browser.
    window.open( url, '_blank', 'noopener' );
}
