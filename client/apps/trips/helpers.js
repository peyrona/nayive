/* helpers.js - date, time and text helpers. */

//------------------------------------------------------------------------//
// DATE / TIME / TEXT HELPERS

// Dates are stored and shown as ANSI yyyy-mm-dd.
function fmtRange( sStart, sEnd ) { return sStart + ' – ' + sEnd; }

// Combines a date and an optional time into one lexicographically comparable key, so
// a stage's end can be checked against its start even when only the date differs.
function stageDateTimeKey( sDate, sTime ) { return sDate + 'T' + (sTime || '00:00'); }

// A number no other call on this page gave: two rows added in the same
// millisecond (or one apart, with the random part) got ONE id, and the
// uploads then wrote one file name on both rows (storedNames). Still a
// number, as ids always were (persistence.js checks Number.isFinite).
let lastNewId = 0;
function newId()
{
    let id = Date.now() + Math.floor( Math.random() * 1000 );
    if( id <= lastNewId ) id = lastNewId + 1;
    lastNewId = id;
    return id;
}
function round2( n ) { return Math.round( n * 100 ) / 100; }
// The OLD slug (accented letters dropped: "Córdoba" -> "c-rdoba"). Only for a
// legacy document's file name, which was made with it and must still be found.
// Every new name uses NayiveUI.slugify ("cordoba").
function legacySlug( s ) { return (s || '').toLowerCase().trim().replace( /[^a-z0-9]+/g, '-' ).replace( /^-+|-+$/g, '' ) || 'item'; }

// A safe, in-folder file name for an UPLOADED document: the original base name
// slugified, its real extension kept, and a "-2", "-3"... suffix if another doc
// already claims it, or a file of that name is in the folder (aTakenNames), so
// two uploads never overwrite each other. aSiblingDocs must be EVERY document of
// the trip (allTripDocs): the trip's list and every stage's share ONE folder -
// two stages' "ticket.pdf" once became one file (D2, list-apps #4).
function uniqueFileName( sOriginalName, aSiblingDocs, aTakenNames )
{
    const dot  = sOriginalName.lastIndexOf( '.' );
    const ext  = (dot > 0 ? sOriginalName.slice( dot + 1 ) : '').toLowerCase().replace( /[^a-z0-9]/g, '' );
    const base = NayiveUI.slugify( dot > 0 ? sOriginalName.slice( 0, dot ) : sOriginalName, 'item' );
    const make = function( n ) { return base + (n > 1 ? '-' + n : '') + (ext ? '.' + ext : ''); };
    const taken = new Set( (aSiblingDocs || []).map( function( d ) { return d.file; } ).filter( Boolean ).concat( Array.from( aTakenNames || [] ) ) );

    let n = 1;
    while( taken.has( make( n ) ) ) n++;
    return make( n );
}

// Every document of a trip: its own list and every stage's (one folder for all).
function allTripDocs( trip )
{
    if( ! trip ) return [];
    return ( trip.documents || [] ).concat( ...( trip.stages || [] ).map( function( st ) { return st.documents || []; } ) );
}

// Base name only ("destination-year") - resolveNewTripDirName() adds a "-2", "-3"...
// suffix on collision at creation time; an already-saved trip's real folder is
// trip.dirName, never this recomputed straight from its (possibly since-edited) fields.
function dirNameFor( sDestination, sStartDate ) { return NayiveUI.slugify( sDestination, 'item' ) + '-' + (sStartDate ? sStartDate.slice( 0, 4 ) : 'new'); }

// Where a document's bytes live, and the URL that serves them. A document is one of:
//   kind 'link'   -> doc.path points straight into the user's files/ tree (not copied)
//   kind 'upload' -> doc.file sits inside this trip's own folder
//   (legacy, no kind) -> treated as an upload at "<slug(name)>.pdf", the old scheme
// A trip's own folder. Ours live under data/trips/<dirName>; one another
// user shared with us is reached through its "shared/<slug>" path instead
// (see tripBase(), set when the trip is loaded).
function docPath( base, doc )
{
    if( doc && doc.kind === 'link' && doc.path ) return sharedRef( base, doc.path );
    const file = (doc && doc.file) || ( legacySlug( doc && doc.name ) + '.pdf' );
    return base + '/' + file;
}

// A trip somebody shared with us also lends the files it POINTS at outside
// its own folder — its linked documents and its photo folder. They are ours
// to read through "shared/<slug>/~/<the owner's path>" (server/go/shares.go
// ExtraPath). On one of our own trips the path is already ours: unchanged.
function sharedRef( base, ownerPath )
{
    return String( base || '' ).indexOf( 'shared/' ) === 0
         ? base + '/~/' + String( ownerPath || '' ).replace( /^\/+/, '' )
         : ownerPath;
}
function tripBase( trip )  { return trip && trip._base ? trip._base : 'data/trips/' + (trip && trip.dirName); }
function tripIsRO( trip )  { return !! ( trip && trip._ro ); }
function docHref( trip, doc )    { return GumApi.fileUrl( docPath( tripBase( trip ), doc ) ); }
function docIsLink( doc )   { return doc && doc.kind === 'link'; }
function docHasFile( doc )  { return !!( (doc && doc.kind === 'link' && doc.path) || (doc && doc.file) || (doc && doc._pending) ); }

function viewerTz() { return NayiveUI.viewerTz(); }   // impl in shared/ui.js
function localTimeIn( sTz )
{
    try { return new Intl.DateTimeFormat( 'en-GB', { timeZone: sTz, hour: '2-digit', minute: '2-digit', hour12: false } ).format( new Date() ); }
    catch( _ ) { return '--:--'; }
}

function findTrip( id ) { return trips.find( function( t ) { return t.id === id; } ); }

function addDaysIso( sIso, n )
{
    const d = new Date( sIso + 'T00:00:00' );
    d.setDate( d.getDate() + n );
    return d.getFullYear() + '-' + String( d.getMonth() + 1 ).padStart( 2, '0' ) + '-' + String( d.getDate() ).padStart( 2, '0' );
}
