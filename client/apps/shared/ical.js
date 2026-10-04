// SEALED - a user-data write path (docs/sealed-crud.md): announce a change, keep it minimal, then `node tools/data-safety-test/run.mjs` must be ALL GREEN.
/*
 * ical.js - The .ics event model + DST-safe recurrence engine. Only the
 * Calendar app imports it now (Tasks used to, for its "what's on the calendar
 * today" sync).
 *
 * ES module - import what you need:
 *     import { icsToEventDefs, expandEventDef, eventDefsToIcs } from '../shared/ical.js';
 *
 * Dependencies, all loaded by the app BEFORE its module script:
 *   - luxon  (classic-script global `luxon`)   - all the wall-clock / DST math
 *   - rrule  (classic-script global `rrule`)   - recurrence pattern expansion
 *   - ICAL.js (imported here from ./lib/)      - .ics parse / serialize
 *
 * ---------------------------------------------------------------------------
 * An event-def is the in-memory source of truth for one event or one whole
 * recurring series (whole-series edits only; one occurrence can be deleted -
 * an EXDATE, excludeOne - and a moved one read from a file is its own def):
 *
 * {
 *   uid, title, location, notes, allDay,
 *   rid,               // RECURRENCE-ID ('' for a plain event or a series): an override shares its master's uid
 *   key,               // uid + rid: what the calendar finds, moves and deletes an event by
 *   floating,          // true: wall-clock time follows the VIEWER's current device zone
 *   tzid,              // IANA zone the wall-clock time is anchored to (ignored when floating or allDay)
 *   start: { date:'YYYY-MM-DD', time:'HH:mm'|null },
 *   end:   { date:'YYYY-MM-DD', time:'HH:mm'|null },
 *   rrule: null | { freq:'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval, byweekday:['MO',...]|null, until:'YYYY-MM-DD'|null, count:number|null,
 *                   wkst?,        // ICAL week start, only when the file has one
 *                   custom? }     // true: a rule the sheet cannot show (FREQ=HOURLY, BYDAY=2TU...) - never rewritten (but endSeriesBefore sets its UNTIL)
 * }
 *
 * A def read from a file also carries `_src`: its VEVENT's own lines, so a save
 * changes only what was edited (see THE FILE AS IT CAME below).
 */
import ICAL from './lib/ical_v2.2.1.esm.min.js';

const { DateTime } = luxon;
const RRule        = rrule.RRule;

// The viewer's current device zone - the anchor for floating events.
const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const pad2 = NayiveUI.pad2;   // shared/ui.js (deferred, so loaded before this module)

//------------------------------------------------------------------------//
// ICS  <->  event-def MODEL

export function makeEventDef()
{
    const uid = 'ev-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);

    return { uid, rid: '', key: uid,
             title: '', location: '', notes: '', allDay: false,
             floating: false, tzid: VIEWER_TZ,
             start: { date: null, time: null }, end: { date: null, time: null },
             rrule: null };
}

export function icsToEventDefs( icsText ) { return icsToCalendar( icsText ).defs; }

function vEventToDef( ev )
{
    const def = makeEventDef();

    def.uid      = ev.uid || def.uid;
    const rid    = ev.component.getFirstPropertyValue( 'recurrence-id' );
    def.rid      = rid ? rid.toString() : '';
    def.key      = def.uid + ( def.rid ? '@' + def.rid : '' );
    def.title    = ev.summary || '';
    def.location = ev.location || '';
    def.notes    = ev.description || '';

    const dtstart = ev.startDate;
    def.allDay    = !! dtstart.isDate;

    if( def.allDay )
    {
        def.start = { date: icalDateToStr( dtstart ), time: null };
        const dtend = ev.endDate;
        def.end   = { date: icalDateToStr( dtend.clone().adjust( -1, 0, 0, 0 ) ), time: null };   // ICS all-day DTEND is exclusive
    }
    else
    {
        // Read the TZID straight off the property parameter rather than dtstart.zone.tzid:
        // ICAL.js only resolves .zone to a real Timezone (with .tzid intact) when that zone is
        // already registered in ICAL.TimezoneService — true right after our own writes in the
        // same session, but NOT on a fresh page load parsing a freshly-fetched file (nothing has
        // registered anything yet), where .zone silently falls back to floating. The parameter
        // read works regardless of registration state.
        const dtstartProp = ev.component.getFirstProperty( 'dtstart' );
        const tzidParam    = dtstartProp ? dtstartProp.getParameter( 'tzid' ) : null;
        const isUtc        = dtstart.zone === ICAL.Timezone.utcTimezone;
        const tzid         = ianaZone( tzidParam ) || (isUtc ? 'UTC' : null);

        def.floating = ! tzid;   // a zone no one can place (not IANA, not a known Windows name) shows at its wall clock
        def.tzid     = tzid || VIEWER_TZ;
        def.start    = { date: icalDateToStr( dtstart ), time: icalTimeToStr( dtstart ) };

        const dtend = ev.endDate;
        def.end      = { date: icalDateToStr( dtend ), time: icalTimeToStr( dtend ) };

        // A one-off time in UTC ("...Z", from another app) shows in the VIEWER's
        // zone (apps-2 #56): a 10:00 meeting reads 10:00 here, not 08:00 with a
        // UTC tag. Only the model moves - `was` (fieldsOf) is taken after this,
        // so the file keeps its "Z" line until the time itself is edited. Not a
        // series (its wall clock in another zone would drift an hour at each DST
        // change) nor a moved occurrence of one (it must match its series' UTC).
        if( isUtc && ! tzidParam && ! rid && ! ev.component.getFirstProperty( 'rrule' ) )
        {
            const toViewer = t => DateTime.fromObject( { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute },
                                                       { zone: 'utc' } ).setZone( VIEWER_TZ );
            const s = toViewer( dtstart ), e = toViewer( dtend );
            def.tzid  = VIEWER_TZ;
            def.start = { date: s.toISODate(), time: s.toFormat( 'HH:mm' ) };
            def.end   = { date: e.toISODate(), time: e.toFormat( 'HH:mm' ) };
        }
    }

    const recur = ev.component.getFirstPropertyValue( 'rrule' );

    if( recur )
    {
        def.rrule =
        {
            freq:      recur.freq,
            interval:  recur.interval || 1,
            byweekday: (recur.parts && recur.parts.BYDAY) ? recur.parts.BYDAY.map( d => d.replace(/^[+-]?\d*/, '') ) : null,
            until:     recur.until ? icalDateToStr( recur.until ) : null,
            count:     recur.count || null
        };

        if( recur.wkst && recur.wkst !== ICAL.Time.MONDAY ) def.rrule.wkst = recur.wkst;
        if( ! sheetCanShow( recur, ev.component ) )         def.rrule.custom = true;
        if( def.rrule.custom ) def.rrule.raw = recur.toString();   // expanded as written: BYDAY=2TU, BYMONTHDAY...
    }

    // The occurrences the series does not have: its EXDATEs, and (see
    // icsToCalendar) the ones a RECURRENCE-ID override has moved.
    def.skip = [];
    for( const p of ev.component.getAllProperties( 'exdate' ) )
        for( const t of p.getValues() ) def.skip.push( wallKey( t, def ) );

    if( rid ) def.ridKey = wallKey( rid, def );

    return def;
}

// An occurrence as the series' own wall clock, "yyyy-mm-dd" (all-day) or
// "yyyy-mm-ddThh:mm": what expandEventDef compares. A UTC time (an EXDATE
// written with Z) is first moved into the series' zone.
function wallKey( t, def )
{
    if( def.allDay || t.isDate ) return icalDateToStr( t );

    if( t.zone === ICAL.Timezone.utcTimezone && ! def.floating && def.tzid !== 'UTC' )
    {
        const d = DateTime.fromObject( { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute },
                                       { zone: 'utc' } ).setZone( def.tzid );
        return d.toISODate() + 'T' + d.toFormat( 'HH:mm' );
    }

    return icalDateToStr( t ) + 'T' + icalTimeToStr( t );
}

// A TZID as a zone Luxon knows: IANA as it is, Outlook's Windows names mapped
// ("Romance Standard Time" -> Europe/Paris); null when there is no telling.
const WINDOWS_ZONES =
{
    'UTC': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
    'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
    'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
    'E. Europe Standard Time': 'Europe/Chisinau', 'GTB Standard Time': 'Europe/Bucharest',
    'FLE Standard Time': 'Europe/Kiev', 'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul',
    'Morocco Standard Time': 'Africa/Casablanca', 'South Africa Standard Time': 'Africa/Johannesburg',
    'Egypt Standard Time': 'Africa/Cairo', 'Israel Standard Time': 'Asia/Jerusalem', 'Arabian Standard Time': 'Asia/Dubai',
    'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
    'Korea Standard Time': 'Asia/Seoul', 'Singapore Standard Time': 'Asia/Singapore',
    'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland',
    'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
    'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
    'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
    'Central Standard Time (Mexico)': 'America/Mexico_City', 'SA Pacific Standard Time': 'America/Bogota',
    'Venezuela Standard Time': 'America/Caracas', 'Pacific SA Standard Time': 'America/Santiago',
    'Argentina Standard Time': 'America/Buenos_Aires', 'E. South America Standard Time': 'America/Sao_Paulo',
    'Canada Central Standard Time': 'America/Regina', 'Newfoundland Standard Time': 'America/St_Johns'
};

function ianaZone( tzid )
{
    if( ! tzid ) return null;
    const name = String( tzid ).replace( /^\/[^/]*\/[^/]*\//, '' ).trim();   // "/mozilla.org/20050126_1/Europe/Berlin"
    if( DateTime.local().setZone( name ).isValid ) return name;
    return WINDOWS_ZONES[ name ] || null;
}

// What the sheet can show AND write back as it came: one RRULE, a plain
// FREQ, BYDAY only as bare weekdays of a weekly rule. Anything else
// (FREQ=HOURLY, BYDAY=2TU, BYMONTHDAY, BYSETPOS, a second RRULE...) is
// `custom`: the calendar never rewrites it, it stays in the file verbatim
// (only "delete this and all after" sets its UNTIL, endSeriesBefore).
const SHEET_FREQS = [ 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY' ];

function sheetCanShow( recur, vc )
{
    if( vc.getAllProperties( 'rrule' ).length !== 1 ) return false;
    if( SHEET_FREQS.indexOf( recur.freq ) === -1 )    return false;

    for( const part of Object.keys( recur.parts || {} ) )
    {
        if( part !== 'BYDAY' || recur.freq !== 'WEEKLY' )                                return false;
        if( ! recur.parts.BYDAY.every( d => /^(MO|TU|WE|TH|FR|SA|SU)$/.test( d ) ) ) return false;
    }

    return true;
}

function icalDateToStr( t ) { return t.year + '-' + pad2( t.month ) + '-' + pad2( t.day ); }
function icalTimeToStr( t ) { return pad2( t.hour ) + ':' + pad2( t.minute ); }

//------------------------------------------------------------------------//
// THE FILE AS IT CAME
//
// A save used to rebuild the whole .ics from the event-defs, so the first edit
// stripped all the model does not carry: VALARM, ATTENDEE, EXDATE, CATEGORIES,
// X- properties, VTIMEZONE / VTODO blocks, the RRULE parts the sheet cannot
// show. Now the file is kept as its own lines and only what was edited changes:
//   - anything that is not a top-level VEVENT is copied byte for byte;
//   - a VEVENT whose fields did not change goes back byte for byte;
//   - a changed one keeps every line (alarms, attendees...) except the
//     properties of the fields that changed, written fresh where they stood;
//   - a deleted one leaves; a new one goes in before the last END:VCALENDAR.
//
// icsToCalendar( text ) -> { defs, file, bad }
//   file  what calendarToIcs() needs to write it back (null: no file / empty)
//   bad   the text is not valid iCalendar (a broken line, a block that never
//         ends): the caller must treat the file as READ-ONLY. The events that
//         do parse are still in `defs`, so the calendar does not look empty.

// The fields of an event-def, grouped by the properties that carry them.
const FIELD_PROPS =
{
    title:    [ 'SUMMARY' ],
    location: [ 'LOCATION' ],
    notes:    [ 'DESCRIPTION' ],
    when:     [ 'DTSTART', 'DTEND', 'DURATION' ],
    rrule:    [ 'RRULE' ]
};

function fieldsOf( def )
{
    return { title: def.title, location: def.location, notes: def.notes,
             when:  JSON.stringify( [ def.allDay, def.floating, def.tzid, def.start, def.end ] ),
             rrule: JSON.stringify( def.rrule ) };
}

// The text as LOGICAL lines (a folded line together with its continuation
// lines): `raw` exactly as read, line breaks included; `name` the property
// name (SUMMARY, DTSTART...); `begin` / `end` the component a BEGIN: / END:
// line opens or closes.
function icsLines( text )
{
    const lines = [];

    for( const phys of text.match( /[^\n]*\n|[^\n]+$/g ) || [] )
    {
        if( lines.length && /^[ \t]/.test( phys ) ) lines[ lines.length - 1 ].raw += phys;
        else                                        lines.push( { raw: phys } );
    }

    for( const l of lines )
    {
        const text = l.raw.replace( /^﻿/, '' ).replace( /\r?\n[ \t]/g, '' ).replace( /[\r\n]+$/, '' );   // a BOM stays in `raw` only
        const tag  = /^(BEGIN|END):\s*([^\s;:]+)\s*$/i.exec( text );

        l.name  = /^[^;:]*/.exec( text )[ 0 ].trim().toUpperCase();
        l.begin = ( tag && tag[ 1 ].toUpperCase() === 'BEGIN' ) ? tag[ 2 ].toUpperCase() : null;
        l.end   = ( tag && tag[ 1 ].toUpperCase() === 'END'   ) ? tag[ 2 ].toUpperCase() : null;
    }

    return lines;
}

export function icsToCalendar( icsText )
{
    const text = String( icsText || '' );

    if( ! text.trim() )
        return { defs: [], file: null, bad: false };   // an empty file: the first save writes it fresh

    let bad = false;
    try { ICAL.parse( text.replace( /^﻿/, '' ) ); } catch( _ ) { bad = true; }   // ICAL.js chokes on a BOM (some Outlook exports)

    // parts: strings (copied as they are) and VEVENTs { lines, raw, was }.
    const file  = { parts: [], at: -1, eol: /\r\n/.test( text ) ? '\r\n' : '\n' };
    const defs  = [];
    const seen  = {};
    let   depth = 0, chunk = '', ev = null;

    const addEvent = function( lines )
    {
        const raw = lines.map( l => l.raw ).join( '' );
        let   def = null;

        try { def = vEventToDef( new ICAL.Event( new ICAL.Component( ICAL.parse( raw ) ) ) ); }
        catch( _ ) { /* not understood: it stays in the file as it is, just not shown */ }

        if( ! def ) { file.parts.push( raw ); return; }

        // An event with no UID gets one made from its own text, not a random
        // one: the same event must have the same key on every device and at
        // every read, or a merge (mergeIcs) would take it for two. Written
        // into the file only when the event is edited here.
        if( ! /^UID[;:]/mi.test( raw.replace( /\r?\n[ \t]/g, '' ) ) )
        {
            def.uid = 'ev-h' + textHash( raw.replace( /\r\n/g, '\n' ) );
            def.key = def.uid + ( def.rid ? '@' + def.rid : '' );
        }

        // Two events with the same uid + rid (a copy pasted in twice) must still be two.
        if( seen[ def.key ] ) def.key += '#' + seen[ def.key ]++;
        else                  seen[ def.key ] = 1;

        def._src = { lines, raw, was: fieldsOf( def ) };
        file.parts.push( def._src );
        defs.push( def );
    };

    for( const l of icsLines( text ) )
    {
        if( ev )
        {
            ev.lines.push( l );
            if( l.begin ) ev.depth++;
            if( l.end && --ev.depth === 0 ) { addEvent( ev.lines ); ev = null; }
            continue;
        }

        if( l.begin === 'VEVENT' && depth === 1 )
        {
            file.parts.push( chunk );
            chunk = '';
            ev    = { lines: [ l ], depth: 1 };
            continue;
        }

        if( l.end === 'VCALENDAR' && depth === 1 )
        {
            file.parts.push( chunk );
            chunk   = '';
            file.at = file.parts.length;   // new events go in before the LAST END:VCALENDAR
        }

        if( l.begin ) depth++;
        if( l.end )   depth--;
        if( depth < 0 ) { bad = true; depth = 0; }

        chunk += l.raw;
    }

    if( ev ) { bad = true; chunk = ev.lines.map( l => l.raw ).join( '' ); }   // a VEVENT that never ends
    file.parts.push( chunk );

    if( depth !== 0 || file.at < 0 ) bad = true;

    // A moved occurrence (same uid + RECURRENCE-ID) replaces the series' own:
    // without this both showed, the old time beside the new.
    for( const o of defs )
    {
        if( ! o.ridKey ) continue;
        const master = defs.find( d => d.uid === o.uid && ! d.rid && d.rrule );
        if( master ) master.skip.push( o.ridKey );
    }

    return { defs, file, bad };
}

// The file back, with the events as they are now in `defs` (see above).
// `file` null: there is no file yet - write it fresh.
export function calendarToIcs( file, defs )
{
    if( ! file )
        return eventDefsToIcs( defs );

    const kept  = new Map();
    const fresh = [];

    for( const def of defs )
    {
        if( def._src && file.parts.indexOf( def._src ) !== -1 ) kept.set( def._src, def );
        else                                                    fresh.push( def );
    }

    let out = '';

    file.parts.forEach( function( part, i )
    {
        if( i === file.at )
            for( const def of fresh ) out += eventText( def, file.eol );

        if( typeof part === 'string' ) out += part;
        else if( kept.has( part ) )    out += eventText( kept.get( part ), file.eol );
        // else: that event was deleted
    } );

    if( file.at >= file.parts.length )
        for( const def of fresh ) out += eventText( def, file.eol );

    return out;
}

//------------------------------------------------------------------------//
// MERGE  (apps-2 #51, cross #11: shared/store.js calls it on a 412)
//
// This device's calendar (`mine`) and the server's (`theirs`), both saved
// since `base` (the copy this device last had from the server), merged event
// by event - by uid + RECURRENCE-ID (def.key):
//   - added on either side: kept;
//   - deleted on one side and untouched on the other: deleted;
//   - changed on both: merged property by property against base (mergeEvent);
//     with no base copy of it, the newer by its LAST-MODIFIED, else DTSTAMP,
//     else mine;
//   - changed on one side and deleted on the other: kept, as changed (an edit
//     is never lost to a delete).
// The server's file is the frame (its VTIMEZONEs, to-dos, order); an event of
// mine goes where theirs stood, a new one before its last END:VCALENDAR.
// `base` null (unknown): nothing counts as deleted - both sides' events stay,
// and one they hold differently is the newer, else theirs.
// null back: it cannot be merged safely (a file that does not parse).
export function mergeIcs( base, mine, theirs )
{
    const B = base == null ? null : icsToCalendar( base );
    const M = icsToCalendar( mine );
    const T = icsToCalendar( theirs );

    if( M.bad || T.bad || ( B && B.bad ) ) return null;
    if( ! T.file ) return M.file ? mine : theirs;    // theirs is empty: mine as it is
    if( ! M.file ) return B && B.file ? null : theirs;   // mine emptied a calendar: not a merge

    const byKey = cal => { const m = new Map(); for( const d of cal.defs ) m.set( d.key, d._src.raw ); return m; };
    const b = B ? byKey( B ) : new Map(), m = byKey( M ), t = byKey( T );

    // The raw VEVENT to keep for `key`, or null (deleted).
    const pick = function( key )
    {
        const mv = m.has( key ) ? m.get( key ) : null;
        const tv = t.has( key ) ? t.get( key ) : null;
        const bv = b.has( key ) ? b.get( key ) : null;

        if( mv === tv ) return mv;
        if( B && mv === bv ) return tv;                  // only theirs changed (or deleted it)
        if( B && tv === bv ) return mv;                  // only mine changed (or deleted it)
        if( mv === null ) return tv;                     // deleted here, changed there: kept
        if( tv === null ) return mv;
        // Changed on both, and base had it: property by property, so neither
        // side's edit is dropped whole (H1: a rename here, a place set there).
        if( bv !== null ) return mergeEvent( bv, mv, tv );
        // Added on both (no base copy): the newer; with no stamps, mine - or
        // theirs when base is unknown (store.js mergeLists: this device shows
        // the result at once, the other device's edit would be undone unseen).
        const sm = stampOf( mv ), st = stampOf( tv );
        if( sm !== st ) return st > sm ? tv : mv;
        return B ? mv : tv;
    };

    const eol   = T.file.eol;
    const norm  = raw => raw.replace( /\r?\n/g, eol );
    let   out   = '';
    const done  = new Set();

    T.file.parts.forEach( function( part, i )
    {
        if( i === T.file.at )
            for( const d of M.defs )
                if( ! t.has( d.key ) && ! done.has( d.key ) && pick( d.key ) !== null ) { done.add( d.key ); out += norm( pick( d.key ) ); }

        if( typeof part === 'string' ) { out += part; return; }

        const def = T.defs.find( d => d._src === part );
        if( ! def ) { out += part.raw; return; }
        if( done.has( def.key ) ) return;                // a second copy under the same key
        done.add( def.key );
        const keep = pick( def.key );
        if( keep !== null ) out += keep === part.raw ? keep : norm( keep );
    } );

    return out;
}

// A short stable name for a text: two 32-bit FNV-1a hashes, 16 hex digits.
function textHash( text )
{
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    for( let i = 0; i < text.length; i++ )
    {
        const c = text.charCodeAt( i );
        a = Math.imul( a ^ c, 0x01000193 ) >>> 0;
        b = Math.imul( b ^ c, 0x5bd1e995 ) >>> 0;
    }
    return a.toString( 16 ).padStart( 8, '0' ) + b.toString( 16 ).padStart( 8, '0' );
}

// The event's own last-changed stamp as sortable text ("20260928T101500Z"),
// LAST-MODIFIED first, then DTSTAMP; '' when it has neither.
function stampOf( raw )
{
    const one = n => { const r = new RegExp( '^' + n + '(?:;[^:\r\n]*)?:(\\d{8}T\\d{6}Z?)', 'mi' ).exec( raw ); return r ? r[ 1 ] : ''; };
    return one( 'LAST-MODIFIED' ) || one( 'DTSTAMP' );
}

// ONE EVENT CHANGED ON BOTH SIDES (H1, list-apps #11 / #12). Taking the newer
// VEVENT whole dropped the other side's edit of a DIFFERENT field (the PC's
// rename lost the phone's place), and "delete only this one" competed with any
// other change of its series: the deleted day came back. So the event is
// merged property by property against its base copy:
//   - a property only one side changed takes that side's;
//   - both changed it: the newer event's (stampOf; a tie is mine);
//   - EXDATE / RDATE are sets of lines: one either side added stays, one
//     either side removed goes (two days deleted on two devices both stay
//     deleted, and they survive a rename of the series);
//   - DTSTART / DTEND / DURATION are one "when" (a move sets them together),
//     and the sub-components (VALARMs...) one block.
// The server's VEVENT is the frame: a property whose value is theirs stays
// as its own lines, in its place; one that changes is written where theirs
// stood; one theirs lacks goes before the first sub-component (or the END).
const EVENT_SETS  = [ 'EXDATE', 'RDATE' ];
const EVENT_WHEN  = [ 'DTSTART', 'DTEND', 'DURATION' ];
const EVENT_SUBS  = '#SUB';

// A VEVENT's own lines as units: key -> { set, items: [ { raw, text } ] }, in
// the order met. A set unit (EXDATE, RDATE) has one item per line.
function eventUnits( raw )
{
    const units = new Map();
    let   depth = 0;

    const add = function( key, set, item )
    {
        if( ! units.has( key ) ) units.set( key, { set: set, items: [] } );
        units.get( key ).items.push( item );
    };

    for( const l of icsLines( raw ) )
    {
        const text = l.raw.replace( /^﻿/, '' ).replace( /\r?\n[ \t]/g, '' ).replace( /[\r\n]+$/, '' );
        const d    = depth;
        if( l.begin ) depth++;
        if( l.end )   depth--;

        if( d === 0 || ( d === 1 && l.end ) ) continue;                                   // BEGIN / END:VEVENT
        if( d >= 2 || l.begin ) { add( EVENT_SUBS, false, { raw: l.raw, text: text } ); continue; }
        if( ! text.trim() ) continue;

        const name = l.name;
        if( EVENT_SETS.indexOf( name ) !== -1 )      add( name, true, { raw: l.raw, text: text } );
        else if( EVENT_WHEN.indexOf( name ) !== -1 ) add( 'WHEN', false, { raw: l.raw, text: text } );
        else                                         add( name, false, { raw: l.raw, text: text } );
    }

    return units;
}

function unitKey( name ) { return EVENT_WHEN.indexOf( name ) !== -1 ? 'WHEN' : name; }

function mergeEvent( bv, mv, tv )
{
    const B = eventUnits( bv ), M = eventUnits( mv ), T = eventUnits( tv );
    const newerT = stampOf( tv ) > stampOf( mv );
    const val    = u => u ? u.items.map( i => i.text ).join( '\n' ) : null;

    // key -> the items to write, or 'T' when theirs' own lines stay as they are.
    const result = new Map();
    const keys   = [];
    for( const k of [ ...T.keys(), ...M.keys(), ...B.keys() ] ) if( keys.indexOf( k ) === -1 ) keys.push( k );

    for( const k of keys )
    {
        const b = B.get( k ), m = M.get( k ), t = T.get( k );

        if( ( m || t || b ).set )
        {
            const has = ( u, x ) => !! u && u.items.some( i => i.text === x.text );
            const out = [];
            for( const x of ( t ? t.items : [] ).concat( m ? m.items : [] ) )
            {
                if( out.some( i => i.text === x.text ) ) continue;
                const inM = has( m, x ), inT = has( t, x );
                if( ( inM && inT ) || ! has( b, x ) ) out.push( x );   // on both, or added by one: kept
            }
            result.set( k, val( { items: out } ) === val( t ) ? 'T' : out );
            continue;
        }

        const vb = val( b ), vm = val( m ), vt = val( t );
        let   side;
        if( vm === vt || vm === vb ) side = 'T';
        else if( vt === vb )         side = 'M';
        else                         side = newerT ? 'T' : 'M';

        result.set( k, side === 'T' || vm === vt ? 'T' : ( m ? m.items : [] ) );
    }

    // Written: theirs' lines, each unit that changes at its first line, the
    // ones theirs lacks before its first sub-component (or its END).
    const fresh = keys.filter( k => ! T.has( k ) && result.get( k ) !== 'T' && k !== EVENT_SUBS );
    const items = k => result.get( k ).map( i => i.raw ).join( '' );
    const done  = new Set();
    let   out   = '', depth = 0, placed = false;

    const putFresh = function()
    {
        if( placed ) return '';
        placed = true;
        return fresh.map( items ).join( '' );
    };

    for( const l of icsLines( tv ) )
    {
        const d = depth;
        if( l.begin ) depth++;
        if( l.end )   depth--;

        if( d === 0 ) { out += l.raw; continue; }                                // BEGIN:VEVENT

        if( d === 1 && l.end )                                                   // END:VEVENT
        {
            out += putFresh();
            if( ! T.has( EVENT_SUBS ) && result.get( EVENT_SUBS ) && result.get( EVENT_SUBS ) !== 'T' ) out += items( EVENT_SUBS );
            out += l.raw;
            continue;
        }

        if( d >= 2 || l.begin )                                                  // a sub-component
        {
            out += putFresh();
            if( result.get( EVENT_SUBS ) === 'T' ) out += l.raw;
            else if( ! done.has( EVENT_SUBS ) ) { done.add( EVENT_SUBS ); out += items( EVENT_SUBS ); }
            continue;
        }

        const k = unitKey( l.name );
        if( ! result.has( k ) || result.get( k ) === 'T' ) { out += l.raw; continue; }   // theirs, in its place
        if( done.has( k ) ) continue;
        done.add( k );
        out += items( k );                                                       // empty: the property goes
    }

    return out;
}

// Deleting a moved occurrence (an override: the series' uid + a RECURRENCE-ID)
// must not bring the series' own occurrence back at the old time: the series
// gets an EXDATE for it, built from the override's RECURRENCE-ID line. Only that
// line is added to the series; the rest of it stays as it was (patchEvent).
export function excludeOccurrence( master, override )
{
    const line = master && master._src && override && override._src &&
                 override._src.lines.find( l => l.name === 'RECURRENCE-ID' );
    if( ! line ) return;

    const text = line.raw.replace( /^﻿/, '' ).replace( /\r?\n[ \t]/g, '' ).replace( /[\r\n]+$/, '' );
    const ex   = 'EXDATE' + text.slice( 'RECURRENCE-ID'.length ).replace( /;RANGE=[^;:]*/i, '' );   // EXDATE takes no RANGE

    ( master.exdatesAdded = master.exdatesAdded || [] ).push( ICAL.helpers.foldline( ex ) );
}

function eventText( def, eol )
{
    if( def._src ) return patchEvent( def._src, def, eol );

    // A new event (not read from the file yet) carries its EXDATEs (excludeOne) here.
    let text = defToVEventComponent( def ).toString();
    const at = text.lastIndexOf( 'END:VEVENT' );
    if( def.exdatesAdded && def.exdatesAdded.length && at !== -1 )
        text = text.slice( 0, at ) + def.exdatesAdded.map( x => x + '\r\n' ).join( '' ) + text.slice( at );

    return text.replace( /\r\n/g, eol ) + eol;
}

// "Delete only this one" on a series (apps-2 #54): the series gets an EXDATE
// for the occurrence at `occ` - its wall clock in the series' own zone,
// "yyyy-mm-dd" or "yyyy-mm-ddThh:mm", what expandEventDef compares - written
// the way its own DTSTART is: VALUE=DATE, floating, the file's own TZID=, or
// UTC. It also leaves the screen at once (def.skip). Returns what undo() needs.
export function excludeOne( def, occ )
{
    let line;

    if( def.allDay )
        line = 'EXDATE;VALUE=DATE:' + occ.replace( /-/g, '' );
    else
    {
        const src  = def._src && def._src.lines.find( l => l.name === 'DTSTART' );
        const text = src ? src.raw.replace( /^\uFEFF/, '' ).replace( /\r?\n[ \t]/g, '' ).replace( /[\r\n]+$/, '' ) : '';
        const m    = /^DTSTART((?:;[^:;=]+=(?:"[^"]*"|[^:;]*))*):(.*)$/i.exec( text );
        const tzid = m && /;TZID=("[^"]*"|[^:;]*)/i.exec( m[ 1 ] );
        // The seconds the DTSTART has (10:00:30): the server matches an EXDATE to the second.
        const sec  = ( m && ( /T\d{4}(\d{2})/.exec( m[ 2 ] ) || [] )[ 1 ] ) || '00';
        const wall = occ.replace( /[-:]/g, '' ) + sec;             // yyyymmddThhmmss

        const utc  = m ? /Z\s*$/i.test( m[ 2 ] ) : ( ! def.floating && def.tzid === 'UTC' );

        if( utc )
            line = 'EXDATE:' + DateTime.fromISO( occ + ':' + sec, { zone: def.floating ? VIEWER_TZ : def.tzid } )
                                     .toUTC().toFormat( "yyyyLLdd'T'HHmmss'Z'" );
        else if( tzid )
            line = 'EXDATE;TZID=' + tzid[ 1 ] + ':' + wall;       // the file's own name, Windows or IANA
        else if( ! m && ! def.floating )
            line = 'EXDATE;TZID=' + def.tzid + ':' + wall;
        else
            line = 'EXDATE:' + wall;                               // floating
    }

    const folded = ICAL.helpers.foldline( line );
    ( def.exdatesAdded = def.exdatesAdded || [] ).push( folded );
    ( def.skip = def.skip || [] ).push( occ );

    return function undo()
    {
        const i = def.exdatesAdded.lastIndexOf( folded );
        if( i !== -1 ) def.exdatesAdded.splice( i, 1 );
        const j = def.skip.lastIndexOf( occ );
        if( j !== -1 ) def.skip.splice( j, 1 );
    };
}

// "Delete this one and all after" on a series: the series ends just before the
// occurrence at `occ` (as in excludeOne). A rule the sheet shows gets a
// date-only UNTIL, the day before, as the sheet writes one (one occurrence a
// day at most). A rule it cannot show keeps its text, its COUNT / UNTIL swapped
// for an UNTIL one second before `occ`, in UTC (an HOURLY rule keeps that day's
// earlier ones), or the day before for an all-day one. Returns undo(), or null
// when nothing comes before `occ`: then the whole series is to go.
export function endSeriesBefore( def, occ )
{
    const zone   = def.allDay ? 'utc' : def.floating ? VIEWER_TZ : def.tzid;
    const at     = DateTime.fromISO( occ, { zone } );
    const before = at.minus( { days: 1 } ).toISODate();
    const old    = def.rrule;
    const rule   = Object.assign( {}, old, { until: before, count: null } );

    if( old.raw )
    {
        const parts = old.raw.split( ';' ).filter( p => p && ! /^(UNTIL|COUNT)=/i.test( p ) );
        parts.push( 'UNTIL=' + ( def.allDay ? before.replace( /-/g, '' )
                                            : at.minus( { seconds: 1 } ).toUTC().toFormat( "yyyyLLdd'T'HHmmss'Z'" ) ) );
        rule.raw = parts.join( ';' );
    }

    def.rrule = rule;

    const from = DateTime.fromISO( def.start.date, { zone } ).minus( { days: 2 } ).toMillis();
    if( ! expandEventDef( def, from, at.toMillis() ).some( i => i.startMs < at.toMillis() ) )
    {
        def.rrule = old;
        return null;
    }

    return function undo() { def.rrule = old; };   // the same object: the event goes back byte for byte
}

// One VEVENT back into the file: byte for byte when none of its fields
// changed; otherwise its own lines, with only the properties of the changed
// fields (and DTSTAMP) replaced, each where it stood. One it did not have yet
// goes in before its first sub-component (a VALARM) or its END. Lines inside a
// sub-component are never touched: a VALARM has its own SUMMARY / DESCRIPTION.
function patchEvent( src, def, eol )
{
    const now     = fieldsOf( def );
    const changed = Object.keys( FIELD_PROPS ).filter( f => now[ f ] !== src.was[ f ] );
    const exdates = ( def.exdatesAdded || [] ).map( s => s.replace( /\r\n/g, eol ) + eol );   // see excludeOccurrence

    if( ! changed.length && ! exdates.length )
        return src.raw;

    const names = changed.length || exdates.length ? [ 'DTSTAMP' ] : [];   // the stamp a merge compares (mergeIcs)
    for( const f of changed ) names.push( ...FIELD_PROPS[ f ] );

    // New EXDATEs go after the event's last EXDATE, or with the other new lines.
    let lastEx = -1;
    src.lines.forEach( function( l, i ) { if( l.name === 'EXDATE' ) lastEx = i; } );

    // The new lines, from a VEVENT built the usual way, by property name.
    const fresh = {};
    for( const l of icsLines( defToVEventComponent( def ).toString() ) )
        if( names.indexOf( l.name ) !== -1 )
            ( fresh[ l.name ] = fresh[ l.name ] || [] ).push( l.raw.replace( /\r?\n$/, '' ).replace( /\r\n/g, eol ) + eol );

    // An event that carries a LAST-MODIFIED (Google / Outlook imports) gets it
    // moved on with DTSTAMP: a merge reads it FIRST (stampOf), and left as it
    // came, two edits of it on two devices could never tell the newer (H1).
    if( fresh.DTSTAMP && src.lines.some( l => l.name === 'LAST-MODIFIED' ) )
    {
        names.push( 'LAST-MODIFIED' );
        fresh[ 'LAST-MODIFIED' ] = fresh.DTSTAMP.map( s => s.replace( /^DTSTAMP/, 'LAST-MODIFIED' ) );
    }

    const done = {};
    const put  = function( n )
    {
        if( done[ n ] ) return '';
        done[ n ] = true;
        return ( fresh[ n ] || [] ).join( '' );
    };

    const last = src.lines.length - 1;
    let   out  = '', depth = 0, placed = false;

    src.lines.forEach( function( l, i )
    {
        if( depth === 1 && ! placed && ( l.begin || i === last ) )
        {
            placed = true;
            for( const n of names ) out += put( n );
            if( lastEx === -1 ) out += exdates.join( '' );
        }

        if( l.begin ) depth++;
        if( l.end )   depth--;

        if( depth === 1 && ! l.begin && ! l.end && names.indexOf( l.name ) !== -1 )
        {
            out += put( l.name );   // the old line goes, the new one takes its place
            return;
        }

        out += l.raw;
        if( i === lastEx ) out += exdates.join( '' );
    } );

    return out;
}

//------------------------------------------------------------------------//
// SERIALIZATION

export function eventDefsToIcs( defs )
{
    const comp = new ICAL.Component( [ 'vcalendar', [], [] ] );
    comp.updatePropertyWithValue( 'prodid', '-//Nayive//Personal Calendar//EN' );
    comp.updatePropertyWithValue( 'version', '2.0' );

    for( const def of defs )
        comp.addSubcomponent( defToVEventComponent( def ) );

    return comp.toString();
}

function defToVEventComponent( def )
{
    const vc = new ICAL.Component( 'vevent' );
    const ev = new ICAL.Event( vc );

    ev.uid     = def.uid;
    ev.summary = def.title;
    if( def.location ) vc.updatePropertyWithValue( 'location', def.location );
    if( def.notes )    vc.updatePropertyWithValue( 'description', def.notes );
    vc.updatePropertyWithValue( 'dtstamp', ICAL.Time.fromJSDate( new Date(), true ) );   // true = UTC, per RFC5545

    if( def.allDay )
    {
        ev.startDate = strToIcalDate( def.start.date, true );
        ev.endDate   = strToIcalDate( def.end.date, true ).clone().adjust( 1, 0, 0, 0 );   // DTEND exclusive
    }
    else
    {
        const zone = def.floating ? null : def.tzid;
        ev.startDate = strToIcalDateTime( def.start.date, def.start.time, zone );
        ev.endDate   = strToIcalDateTime( def.end.date, def.end.time, zone );
    }

    if( def.rrule && def.rrule.raw )    // a rule the sheet cannot show, as written (endSeriesBefore may have set its UNTIL)
        vc.updatePropertyWithValue( 'rrule', ICAL.Recur.fromString( def.rrule.raw ) );
    else if( def.rrule && def.rrule.freq )   // never "RRULE:FREQ=;" - that line empties the whole file on the next read
    {
        const parts = {};
        if( def.rrule.byweekday && def.rrule.byweekday.length )
            parts.BYDAY = def.rrule.byweekday;

        const recur = new ICAL.Recur( { freq: def.rrule.freq, interval: def.rrule.interval || 1, parts } );
        if( def.rrule.wkst ) recur.wkst = def.rrule.wkst;

        if( def.rrule.until )
            recur.until = strToIcalDate( def.rrule.until, true );
        else if( def.rrule.count )
            recur.count = def.rrule.count;

        vc.updatePropertyWithValue( 'rrule', recur );
    }

    return vc;
}

function strToIcalDate( sDate, isDateOnly )
{
    const [ y, m, d ] = sDate.split( '-' ).map( Number );
    return new ICAL.Time( { year: y, month: m, day: d, isDate: !! isDateOnly } );
}

function strToIcalDateTime( sDate, sTime, sZone )
{
    const [ y, m, d ]   = sDate.split( '-' ).map( Number );
    const [ hh, mm ]    = (sTime || '00:00').split( ':' ).map( Number );

    if( sZone === 'UTC' )   // "...Z", not ";TZID=UTC:" (a TZID wants its VTIMEZONE block)
        return new ICAL.Time( { year: y, month: m, day: d, hour: hh, minute: mm, second: 0, isDate: false },
                               ICAL.Timezone.utcTimezone );

    if( sZone )
    {
        if( ! ICAL.TimezoneService.has( sZone ) )
            ICAL.TimezoneService.register( sZone, makeIcalTimezone( sZone ) );

        return new ICAL.Time( { year: y, month: m, day: d, hour: hh, minute: mm, second: 0, isDate: false },
                               ICAL.TimezoneService.get( sZone ) );
    }

    return new ICAL.Time( { year: y, month: m, day: d, hour: hh, minute: mm, second: 0, isDate: false } );   // floating
}

// ICAL.js needs a registered ICAL.Timezone to attach a TZID to a Time; we don't need a full
// VTIMEZONE/VTIMEZONE-DST block for round-tripping our own file (all DST math is done ourselves
// via Luxon in expandEventDef() below) — this stub just carries the name through.
function makeIcalTimezone( sZone )
{
    return new ICAL.Timezone( { tzid: sZone, component: 'BEGIN:VTIMEZONE\r\nTZID:' + sZone + '\r\nEND:VTIMEZONE' } );
}

//------------------------------------------------------------------------//
// OCCURRENCE EXPANSION (DST-safe: rrule.js generates the wall-clock pattern in a
// "naive UTC" trick, then Luxon resolves each occurrence's real UTC offset for its
// own IANA zone on ITS OWN date — a fixed weekly 9am meeting stays 9am local across DST).

export function expandEventDef( def, rangeStartMs, rangeEndMs )
{
    const zone = def.floating ? VIEWER_TZ : def.tzid;

    if( ! def.rrule )
    {
        const inst = instantiate( def, def.start, def.end, zone );
        return overlaps( inst, rangeStartMs, rangeEndMs ) ? [ inst ] : [];
    }

    const durationMs = wallDurationMs( def );
    const dtStartNaive = naiveUtc( def.start );
    let   opts = { freq: RRule[ def.rrule.freq ], interval: def.rrule.interval || 1, dtstart: dtStartNaive };

    if( def.rrule.raw )
    {
        // A rule the sheet cannot show, taken whole (BYDAY=2TU is the 2nd Tuesday,
        // not every Tuesday). Its UNTIL is read as a wall clock, like the rest.
        try { opts = Object.assign( RRule.parseString( def.rrule.raw ), { dtstart: dtStartNaive } ); }
        catch( _ ) {}

        // A date-only UNTIL keeps its whole day, as for the sheet's own rules
        // (and the server's reminders, ics.go); rrule.js stops at its midnight.
        // An UNTIL in UTC ("...Z") is an instant: moved onto the series' own
        // wall clock, which is what the naive dates here are.
        const utcUntil = /UNTIL=(\d{8}T\d{6})Z/i.exec( def.rrule.raw );
        if( utcUntil )
        {
            const u = DateTime.fromFormat( utcUntil[ 1 ], "yyyyLLdd'T'HHmmss", { zone: 'utc' } ).setZone( zone );
            if( u.isValid ) opts.until = new Date( Date.UTC( u.year, u.month - 1, u.day, u.hour, u.minute, u.second ) );
        }
        else if( def.rrule.until && /UNTIL=\d{8}(?!T)/i.test( def.rrule.raw ) )
            opts.until = naiveUtc( { date: def.rrule.until, time: def.start.time } );

        // A rule that names no real day (the 31st that is also the first
        // Monday) makes rrule.js walk to the year 9999 - seconds, on every
        // repaint. Asked once per rule: none -> no occurrences.
        if( ! rawRuleMatches( def, opts ) ) return [];
    }
    else
    {
        if( def.rrule.byweekday )
            opts.byweekday = def.rrule.byweekday.map( d => RRule[ d ] );
        if( def.rrule.until )
            opts.until = naiveUtc( { date: def.rrule.until, time: def.start.time } );
        if( def.rrule.count )
            opts.count = def.rrule.count;
    }

    const rule = new RRule( opts );
    const skip = new Set( def.skip || [] );

    // Widen the naive window a little: byweekday expansion near range edges can otherwise clip an occurrence.
    const naiveFrom = new Date( rangeStartMs - 8 * 86400000 );
    const naiveTo   = new Date( rangeEndMs + 8 * 86400000 );

    const occurrences = rule.between( naiveFrom, naiveTo, true );

    return occurrences
        .filter( d => ! skip.has( def.allDay ? naiveDateStr( d ) : naiveDateStr( d ) + 'T' + naiveTimeStr( d ) ) )
        .map( d => instantiate( def,
                                 { date: naiveDateStr( d ), time: def.allDay ? null : naiveTimeStr( d ) },
                                 null, zone, durationMs ) )
        .filter( inst => overlaps( inst, rangeStartMs, rangeEndMs ) );
}

// Does this rule's pattern name any day at all? The calendar repeats every 400
// years (146097 days, weekdays and leap years included), so a pattern that
// matches anywhere matches within any 400 x m years, m keeping the INTERVAL's
// phase. The probe starts one to two such spans before 9999, where rrule.js
// stops, so a pattern that never matches costs one bounded walk (about a
// second for a daily rule, once) instead of ~8000 years on every repaint.
// Remembered on the def, per rule text.
const CYCLE = { [ RRule.YEARLY ]: 400, [ RRule.MONTHLY ]: 4800, [ RRule.WEEKLY ]: 20871, [ RRule.DAILY ]: 146097 };   // periods per 400 years

function rawRuleMatches( def, opts )
{
    if( def._probe && def._probe.raw === def.rrule.raw ) return def._probe.ok;

    let ok = true;
    const k    = Math.max( 1, opts.interval || 1 );
    const per  = CYCLE[ opts.freq ];
    const gcd  = ( a, b ) => b ? gcd( b, a % b ) : a;
    const span = per ? 400 * ( k / gcd( per, k ) ) : 0;               // years that keep the phase
    const d    = opts.dtstart;

    if( span && span <= 1200 )
    {
        const shift = Math.floor( ( 9999 - span - d.getUTCFullYear() ) / span ) * span;
        const at    = new Date( d.getTime() );
        at.setUTCFullYear( d.getUTCFullYear() + Math.max( 0, shift ) );
        const probe = Object.assign( {}, opts, { dtstart: at, until: null, count: 1 } );
        try { ok = new RRule( probe ).all().length > 0; } catch( _ ) { ok = true; }
    }

    def._probe = { raw: def.rrule.raw, ok };
    return ok;
}

export function instantiate( def, start, end, zone, durationMsOverride )
{
    if( def.allDay )
    {
        // A repeat of an all-day event gets no `end`, only the series' length:
        // whole days (a one-day event rounds to 0), plus the exclusive end day.
        const startDt = DateTime.fromISO( start.date, { zone: 'utc' } );
        const endDt   = end ? DateTime.fromISO( end.date, { zone: 'utc' } ).plus( { days: 1 } )
                      : durationMsOverride != null
                          ? startDt.plus( { days: Math.round( durationMsOverride / 86400000 ) + 1 } )
                          : startDt.plus( { days: 1 } );

        return { uid: def.uid, def, allDay: true,
                 start: startDt.toISODate(), end: endDt.toISODate(),
                 startMs: startDt.toMillis(), endMs: endDt.toMillis() };
    }

    const startDt = DateTime.fromObject( wallParts( start ), { zone } );
    let   endDt;

    if( durationMsOverride != null )
        endDt = startDt.plus( { milliseconds: durationMsOverride } );
    else
        endDt = DateTime.fromObject( wallParts( end ), { zone } );

    return { uid: def.uid, def, allDay: false,
              start: startDt.toISO(), end: endDt.toISO(),
              startMs: startDt.toMillis(), endMs: endDt.toMillis() };
}

export function wallParts( wc )
{
    const [ y, m, d ] = wc.date.split( '-' ).map( Number );
    const [ hh, mm ]  = (wc.time || '00:00').split( ':' ).map( Number );
    return { year: y, month: m, day: d, hour: hh, minute: mm };
}

// Represents a wall-clock date+time as a JS Date via its UTC fields — a pure calendar-arithmetic
// stand-in with no real zone attached, which is what rrule.js needs to expand the *pattern* correctly.
function naiveUtc( wc )
{
    const p = wallParts( wc );
    return new Date( Date.UTC( p.year, p.month - 1, p.day, p.hour, p.minute ) );
}

function naiveDateStr( d )
{
    return d.getUTCFullYear() + '-' + pad2( d.getUTCMonth() + 1 ) + '-' + pad2( d.getUTCDate() );
}

function naiveTimeStr( d )
{
    return pad2( d.getUTCHours() ) + ':' + pad2( d.getUTCMinutes() );
}

function wallDurationMs( def )
{
    const s = wallParts( def.start ), e = wallParts( def.end );
    const sMs = Date.UTC( s.year, s.month - 1, s.day, s.hour, s.minute );
    const eMs = Date.UTC( e.year, e.month - 1, e.day, e.hour, e.minute );
    return Math.max( eMs - sMs, 60000 );
}

export function overlaps( inst, rangeStartMs, rangeEndMs )
{
    return inst.startMs < rangeEndMs && inst.endMs > rangeStartMs;
}
