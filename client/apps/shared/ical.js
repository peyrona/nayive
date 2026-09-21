/*
 * ical.js - The .ics event model + DST-safe recurrence engine, shared by the
 * calendar app and the tasks app's once-a-day "what's on the calendar today" sync.
 *
 * Both used to carry a byte-identical copy of this (~135 lines of fiddly
 * timezone math). This is the single copy. calendar is the reference: tasks gets
 * a strict superset (it ignores the extra `location`/`notes` fields and the
 * serialization exports it never calls).
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
 * recurring series (whole-series edits only - no per-occurrence exceptions):
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
 *                   custom? }     // true: a rule the sheet cannot show (FREQ=HOURLY, BYDAY=2TU...) - never rewritten
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

export function pad2( n ) { return String( n ).padStart( 2, '0' ); }

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
        const tzid         = tzidParam || (isUtc ? 'UTC' : null);

        def.floating = ! tzid;
        def.tzid     = tzid || VIEWER_TZ;
        def.start    = { date: icalDateToStr( dtstart ), time: icalTimeToStr( dtstart ) };

        const dtend = ev.endDate;
        def.end      = { date: icalDateToStr( dtend ), time: icalTimeToStr( dtend ) };
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
    }

    return def;
}

// What the sheet can show AND write back as it came: one RRULE, a plain
// FREQ, BYDAY only as bare weekdays of a weekly rule. Anything else
// (FREQ=HOURLY, BYDAY=2TU, BYMONTHDAY, BYSETPOS, a second RRULE...) is
// `custom`: the calendar never rewrites it, it stays in the file verbatim.
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
    return def._src ? patchEvent( def._src, def, eol )
                    : defToVEventComponent( def ).toString().replace( /\r\n/g, eol ) + eol;
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

    const names = changed.length ? [ 'DTSTAMP' ] : [];
    for( const f of changed ) names.push( ...FIELD_PROPS[ f ] );

    // New EXDATEs go after the event's last EXDATE, or with the other new lines.
    let lastEx = -1;
    src.lines.forEach( function( l, i ) { if( l.name === 'EXDATE' ) lastEx = i; } );

    // The new lines, from a VEVENT built the usual way, by property name.
    const fresh = {};
    for( const l of icsLines( defToVEventComponent( def ).toString() ) )
        if( names.indexOf( l.name ) !== -1 )
            ( fresh[ l.name ] = fresh[ l.name ] || [] ).push( l.raw.replace( /\r?\n$/, '' ).replace( /\r\n/g, eol ) + eol );

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
// SERIALIZATION (calendar only - tasks is read-only and never imports these)

export function eventDefsToIcs( defs )
{
    const comp = new ICAL.Component( [ 'vcalendar', [], [] ] );
    comp.updatePropertyWithValue( 'prodid', '-//Mingle//Personal Calendar//EN' );
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

    if( def.rrule && def.rrule.freq )   // never "RRULE:FREQ=;" - that line empties the whole file on the next read
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
    const opts = { freq: RRule[ def.rrule.freq ], interval: def.rrule.interval || 1, dtstart: dtStartNaive };

    if( def.rrule.byweekday )
        opts.byweekday = def.rrule.byweekday.map( d => RRule[ d ] );
    if( def.rrule.until )
        opts.until = naiveUtc( { date: def.rrule.until, time: def.start.time } );
    if( def.rrule.count )
        opts.count = def.rrule.count;

    const rule = new RRule( opts );

    // Widen the naive window a little: byweekday expansion near range edges can otherwise clip an occurrence.
    const naiveFrom = new Date( rangeStartMs - 8 * 86400000 );
    const naiveTo   = new Date( rangeEndMs + 8 * 86400000 );

    const occurrences = rule.between( naiveFrom, naiveTo, true );

    return occurrences
        .map( d => instantiate( def,
                                 { date: naiveDateStr( d ), time: def.allDay ? null : naiveTimeStr( d ) },
                                 null, zone, durationMs ) )
        .filter( inst => overlaps( inst, rangeStartMs, rangeEndMs ) );
}

export function instantiate( def, start, end, zone, durationMsOverride )
{
    if( def.allDay )
    {
        const startDt = DateTime.fromISO( start.date, { zone: 'utc' } );
        const endDt   = end ? DateTime.fromISO( end.date, { zone: 'utc' } ).plus( { days: 1 } )
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
