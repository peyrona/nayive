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
 *   floating,          // true: wall-clock time follows the VIEWER's current device zone
 *   tzid,              // IANA zone the wall-clock time is anchored to (ignored when floating or allDay)
 *   start: { date:'YYYY-MM-DD', time:'HH:mm'|null },
 *   end:   { date:'YYYY-MM-DD', time:'HH:mm'|null },
 *   rrule: null | { freq:'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval, byweekday:['MO',...]|null, until:'YYYY-MM-DD'|null, count:number|null }
 * }
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
    return { uid: 'ev-' + Date.now() + '-' + Math.random().toString(36).slice(2,8),
             title: '', location: '', notes: '', allDay: false,
             floating: false, tzid: VIEWER_TZ,
             start: { date: null, time: null }, end: { date: null, time: null },
             rrule: null };
}

export function icsToEventDefs( icsText )
{
    let root;
    try { root = ICAL.parse( icsText ); } catch( _ ) { return []; }

    const comp   = new ICAL.Component( root );
    const vevents = comp.getAllSubcomponents( 'vevent' );
    const defs   = [];

    for( const vc of vevents )
    {
        try { defs.push( vEventToDef( new ICAL.Event( vc ) ) ); }
        catch( _ ) { /* skip malformed VEVENT rather than failing the whole file */ }
    }

    return defs;
}

function vEventToDef( ev )
{
    const def = makeEventDef();

    def.uid      = ev.uid || def.uid;
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
    }

    return def;
}

function icalDateToStr( t ) { return t.year + '-' + pad2( t.month ) + '-' + pad2( t.day ); }
function icalTimeToStr( t ) { return pad2( t.hour ) + ':' + pad2( t.minute ); }

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

    if( def.rrule )
    {
        const parts = {};
        if( def.rrule.byweekday && def.rrule.byweekday.length )
            parts.BYDAY = def.rrule.byweekday;

        const recur = new ICAL.Recur( { freq: def.rrule.freq, interval: def.rrule.interval || 1, parts } );

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
