// ds-listapps-calendar-merge.mjs - Calendar's merge on a 412 (shared/ical.js
// mergeIcs), under Node with the real ical.js. Edits are made through the
// app's own model (icsToCalendar -> change the defs -> calendarToIcs), with a
// fixed clock for DTSTAMP, as calendar/index.html makes them.
//
// H1 (list-apps #11, #12): one event changed on BOTH devices is merged
// property by property against its base copy - a rename on one side and a
// place set on the other both stay; "delete only this one" (EXDATE) and
// "this and all after" (UNTIL) survive a rename of the series made elsewhere;
// two days deleted on two devices both stay deleted. An event that carries a
// LAST-MODIFIED gets it moved on at each edit, so the newer side is known.
import { ok, section, done } from "./lib.mjs";
import { loadIcal } from "./listapps-fns.mjs";

const ical = await loadIcal();
const RealDate = Date;

// Runs fn with "now" fixed at iso (DTSTAMP / LAST-MODIFIED of an edit).
function at( iso, fn )
{
    const t = new RealDate( iso ).getTime();
    globalThis.Date = class extends RealDate { constructor( ...a ) { if( a.length ) super( ...a ); else super( t ); } static now() { return t; } };
    try { return fn(); } finally { globalThis.Date = RealDate; }
}
const VEV = ( uid, sum, start, extra = [] ) => [ "BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:20260901T100000Z",
    "DTSTART;TZID=Europe/Madrid:" + start, "DTEND;TZID=Europe/Madrid:" + start.slice( 0, 9 ) + "235900", "SUMMARY:" + sum, ...extra, "END:VEVENT" ];
const CAL = ( ...evs ) => [ "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:x", ...evs.flat(), "END:VCALENDAR", "" ].join( "\r\n" );
function edit( text, when, fn )
{
    return at( when, () => { const c = ical.icsToCalendar( text ); let defs = c.defs; const r = fn( defs, c ); if( Array.isArray( r ) ) defs = r; return ical.calendarToIcs( c.file, defs ); } );
}
function newDef( when, title, date )
{
    return at( when, () => { const d = ical.makeEventDef(); d.title = title; d.tzid = "Europe/Madrid"; d.start = { date, time: "09:00" }; d.end = { date, time: "10:00" }; return d; } );
}
// The merged file as { bad, ev: key -> def }.
function look( out )
{
    if( out == null ) return null;
    const c = ical.icsToCalendar( out );
    return { bad: c.bad, n: c.defs.length, ev: Object.fromEntries( c.defs.map( d => [ d.key, d ] ) ), text: out };
}
const merge = ( b, m, t ) => look( ical.mergeIcs( b, m, t ) );

const base  = CAL( VEV( "a", "A", "20261001T100000" ), VEV( "b", "B", "20261002T100000" ) );
const sbase = CAL( VEV( "s", "Series", "20261001T100000", [ "RRULE:FREQ=DAILY;COUNT=10" ] ) );

section( "H1 · ONE EVENT, TWO DEVICES, DIFFERENT FIELDS" );
{
    const r = merge( base, edit( base, "2026-10-02T10:00:00Z", d => { d[ 0 ].title = "A mine"; } ),
                           edit( base, "2026-10-02T11:00:00Z", d => { d[ 0 ].location = "Room T"; } ) );
    ok( r && r.ev.a.title === "A mine" && r.ev.a.location === "Room T", "rename here (older) + place there (newer): both kept", r && [ r.ev.a.title, r.ev.a.location ] );
    const r2 = merge( base, edit( base, "2026-10-02T12:00:00Z", d => { d[ 0 ].title = "A mine"; } ),
                            edit( base, "2026-10-02T11:00:00Z", d => { d[ 0 ].location = "Room T"; } ) );
    ok( r2 && r2.ev.a.title === "A mine" && r2.ev.a.location === "Room T", "rename here (newer) + place there (older): both kept", r2 && [ r2.ev.a.title, r2.ev.a.location ] );
    ok( r2 && ! r2.bad && r2.n === 2 && r2.ev.b.title === "B", "the file is whole, the other event untouched" );
    ok( r2 && ( r2.text.match( /DTSTAMP/g ) || [] ).length === 2, "one DTSTAMP per event (the newer one)" );
}
{
    const r = merge( base, edit( base, "2026-10-02T10:00:00Z", d => { d[ 0 ].title = "A mine"; } ),
                           edit( base, "2026-10-02T10:00:00Z", d => { d[ 0 ].title = "A theirs"; } ) );
    ok( r && r.ev.a.title === "A mine", "the same field, the same second: mine (as before)" );
    const r2 = merge( base, edit( base, "2026-10-02T10:00:00Z", d => { d[ 0 ].title = "A mine"; } ),
                            edit( base, "2026-10-02T11:00:00Z", d => { d[ 0 ].title = "A theirs"; d[ 0 ].notes = "N"; } ) );
    ok( r2 && r2.ev.a.title === "A theirs" && r2.ev.a.notes === "N", "the same field: the newer side's" );
    const r3 = merge( base, edit( base, "2026-10-02T10:00:00Z", d => { d[ 0 ].start = { date: "2026-10-01", time: "12:00" }; d[ 0 ].end = { date: "2026-10-01", time: "13:00" }; } ),
                            edit( base, "2026-10-02T11:00:00Z", d => { d[ 0 ].title = "Renamed"; } ) );
    ok( r3 && r3.ev.a.start.time === "12:00" && r3.ev.a.end.time === "13:00" && r3.ev.a.title === "Renamed", "moved here + renamed there: both" );
}

section( "H1 · \"DELETE ONLY THIS ONE\" / \"THIS AND ALL AFTER\" vs A SERIES EDIT" );
{
    const occ = "2026-10-03T10:00";
    const r = merge( sbase, edit( sbase, "2026-10-02T10:00:00Z", d => { ical.excludeOne( d[ 0 ], occ ); } ),
                            edit( sbase, "2026-10-02T11:00:00Z", d => { d[ 0 ].title = "Series renamed"; } ) );
    ok( r && r.ev.s.title === "Series renamed" && r.ev.s.skip.includes( occ ), "the deleted day stays deleted under a newer rename", r && [ r.ev.s.title, r.ev.s.skip ] );
    const r2 = merge( sbase, edit( sbase, "2026-10-02T12:00:00Z", d => { ical.excludeOne( d[ 0 ], occ ); } ),
                             edit( sbase, "2026-10-02T11:00:00Z", d => { d[ 0 ].title = "Series renamed"; } ) );
    ok( r2 && r2.ev.s.title === "Series renamed" && r2.ev.s.skip.includes( occ ), "...and the rename stays under a newer delete", r2 && [ r2.ev.s.title, r2.ev.s.skip ] );
    const r3 = merge( sbase, edit( sbase, "2026-10-02T10:00:00Z", d => { ical.excludeOne( d[ 0 ], "2026-10-03T10:00" ); } ),
                             edit( sbase, "2026-10-02T11:00:00Z", d => { ical.excludeOne( d[ 0 ], "2026-10-04T10:00" ); } ) );
    ok( r3 && r3.ev.s.skip.includes( "2026-10-03T10:00" ) && r3.ev.s.skip.includes( "2026-10-04T10:00" ), "two days deleted on two devices: both stay deleted", r3 && r3.ev.s.skip );
    const r4 = merge( sbase, edit( sbase, "2026-10-02T10:00:00Z", d => { ical.endSeriesBefore( d[ 0 ], "2026-10-05T10:00" ); } ),
                             edit( sbase, "2026-10-02T11:00:00Z", d => { d[ 0 ].title = "Series renamed"; } ) );
    ok( r4 && r4.ev.s.title === "Series renamed" && r4.ev.s.rrule && r4.ev.s.rrule.until === "2026-10-04", "\"this and all after\" keeps its end under a newer rename", r4 && [ r4.ev.s.title, r4.ev.s.rrule ] );
}
{
    // A moved occurrence (RECURRENCE-ID) deleted here while the series is renamed there.
    const obase = CAL( VEV( "s", "Series", "20261001T100000", [ "RRULE:FREQ=DAILY;COUNT=10" ] ),
        [ "BEGIN:VEVENT", "UID:s", "DTSTAMP:20260901T100000Z", "RECURRENCE-ID;TZID=Europe/Madrid:20261003T100000",
          "DTSTART;TZID=Europe/Madrid:20261003T150000", "DTEND;TZID=Europe/Madrid:20261003T160000", "SUMMARY:Moved", "END:VEVENT" ] );
    const r = merge( obase,
        edit( obase, "2026-10-02T10:00:00Z", defs => { const ov = defs.find( d => d.rid ); const m = defs.find( d => ! d.rid ); ical.excludeOccurrence( m, ov ); return defs.filter( d => d !== ov ); } ),
        edit( obase, "2026-10-02T11:00:00Z", defs => { defs.find( d => ! d.rid ).title = "Series renamed"; } ) );
    const master = r && Object.values( r.ev ).find( d => ! d.rid );
    ok( r && master.title === "Series renamed" && master.skip.includes( "2026-10-03T10:00" ) && ! Object.values( r.ev ).some( d => d.rid ),
        "a deleted moved occurrence does not come back at the old time", r && master && [ master.title, master.skip ] );
}

section( "H1 · EVENTS THAT CARRY LAST-MODIFIED (Google / Outlook)" );
{
    const gbase = CAL( VEV( "g", "G", "20261001T100000", [ "LAST-MODIFIED:20250101T000000Z", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:R", "TRIGGER:-PT15M", "END:VALARM" ] ) );
    const mine  = edit( gbase, "2026-10-02T12:00:00Z", d => { d[ 0 ].title = "G mine"; } );
    ok( /LAST-MODIFIED:20261002T120000Z/.test( mine ), "an edit moves its LAST-MODIFIED on" );
    const r = merge( gbase, mine, edit( gbase, "2026-10-02T11:00:00Z", d => { d[ 0 ].location = "Lt"; } ) );
    ok( r && r.ev.g.title === "G mine" && r.ev.g.location === "Lt", "different fields: both" );
    ok( r && ( r.text.match( /BEGIN:VALARM/g ) || [] ).length === 1, "its alarm stays, once" );
    const r2 = merge( gbase, edit( gbase, "2026-10-02T11:00:00Z", d => { d[ 0 ].title = "G mine"; } ),
                             edit( gbase, "2026-10-02T12:00:00Z", d => { d[ 0 ].title = "G theirs"; } ) );
    ok( r2 && r2.ev.g.title === "G theirs", "the same field: the newer side's (not always mine)", r2 && r2.ev.g.title );
}

section( "UNCHANGED RULES" );
{
    const r = merge( base, edit( base, "2026-10-02T10:00:00Z", d => { d.push( newDef( "2026-10-02T10:00:00Z", "Mine new", "2026-10-05" ) ); } ),
                           edit( base, "2026-10-02T11:00:00Z", d => { d.push( newDef( "2026-10-02T11:00:00Z", "Theirs new", "2026-10-06" ) ); } ) );
    ok( r && r.n === 4, "both add: both kept" );
    const r2 = merge( base, edit( base, "2026-10-02T10:00:00Z", d => d.filter( x => x.uid !== "b" ) ), edit( base, "2026-10-02T11:00:00Z", d => { d[ 0 ].title = "A t"; } ) );
    ok( r2 && ! r2.ev.b && r2.ev.a.title === "A t", "deleted here, untouched there: gone" );
    const r3 = merge( base, edit( base, "2026-10-02T10:00:00Z", d => d.filter( x => x.uid !== "b" ) ), edit( base, "2026-10-02T11:00:00Z", d => { d[ 1 ].title = "B renamed"; } ) );
    ok( r3 && r3.ev.b && r3.ev.b.title === "B renamed", "deleted here, changed there: kept as changed" );
    const r4 = merge( null, edit( base, "2026-10-02T10:00:00Z", d => { d[ 0 ].title = "A mine"; } ), edit( base, "2026-10-02T09:00:00Z", d => { d[ 0 ].location = "L"; } ) );
    ok( r4 && r4.ev.a.title === "A mine" && ! r4.ev.a.location, "no base: the whole newer event (as before)" );
    ok( ical.mergeIcs( base, base, base.replace( "END:VEVENT\r\nBEGIN:VEVENT", "END:VEVENT\r\nBEGIN:VEVENT\r\nBEGIN:VALARM" ) ) === null, "a file that does not parse: no merge" );
}

await done();
