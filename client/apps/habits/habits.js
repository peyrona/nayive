/* habits.js - the arithmetic of the Habits app: days, streaks and month
 * figures. No DOM, no network: a classic script that leaves ONE global,
 * window.HabitsCore, and also loads under Node (module.exports) so it can be
 * unit-tested from the command line:
 *
 *     node -e "const H = require('./nayive/apps/habits/habits.js'); ..."
 *
 * DATES ARE yyyy-mm-dd STRINGS, always in the device's local day. They are
 * built with the (year, month, day) constructor and stepped by letting the
 * day overflow - never with new Date("yyyy-mm-dd"), which parses as UTC and
 * lands on the wrong day west of Greenwich, and never with .toISOString().
 *
 * WORDS USED
 *   habit     { id, name, icon, color, days, target, created, archived, paused, done, counts }
 *   days      the ISO weekdays it applies to, 1 = Monday .. 7 = Sunday; [] = every day
 *   target    null = a yes/no habit; n >= 2 = counted ("3 glasses"), done at n
 *   created / archived   yyyy-mm-dd; a habit is only DUE between them
 *   paused    [ [ from, to ], ... ] yyyy-mm-dd: the spells it was archived,
 *             from the archive day up to (not including) its restore day -
 *             not due then, so they neither count nor break a streak
 *   done      sorted, unique yyyy-mm-dd of the days fully done - the truth
 *   counts    { "yyyy-mm-dd": n } partial days of a counted habit (0 < n < target)
 *   due       a day the habit applies to (weekday matches, created <= day < archived,
 *             outside every paused spell)
 *   streak    consecutive due days done, ending today or yesterday; days that
 *             are not due neither count nor break it
 */
( function ( root )
{
    "use strict";

    //------------------------------------------------------------------------//
    // DATES

    var pad2 = Ayni.dates.pad, toIso = Ayni.dates.iso, todayIso = Ayni.dates.today;

    function isIso( s ) { return /^\d{4}-\d{2}-\d{2}$/.test( String( s || "" ) ); }

    // "yyyy-mm-dd" -> a Date at local midnight (null when malformed).
    function parseIso( iso )
    {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec( String( iso || "" ) );
        return m ? new Date( +m[ 1 ], +m[ 2 ] - 1, +m[ 3 ] ) : null;
    }


    // The day n days after (or before, n < 0) iso. Day overflow keeps it DST-safe.
    function isoAdd( iso, n )
    {
        var d = parseIso( iso );
        return toIso( new Date( d.getFullYear(), d.getMonth(), d.getDate() + n ) );
    }

    // 1 = Monday .. 7 = Sunday (Date.getDay() is 0 = Sunday, hence the shuffle).
    function isoWeekday( iso ) { return ( ( parseIso( iso ).getDay() + 6 ) % 7 ) + 1; }

    function monthOf( iso ) { return String( iso ).slice( 0, 7 ); }

    // "yyyy-mm" n months later (or earlier).
    function monthAdd( ym, n )
    {
        var d = new Date( +ym.slice( 0, 4 ), +ym.slice( 5, 7 ) - 1 + n, 1 );
        return d.getFullYear() + "-" + pad2( d.getMonth() + 1 );
    }

    // Every day of "yyyy-mm" as yyyy-mm-dd. Day 0 of the NEXT month is the last day of this one.
    function daysOfMonth( ym )
    {
        var n = new Date( +ym.slice( 0, 4 ), +ym.slice( 5, 7 ), 0 ).getDate(), out = [];
        for( var i = 1; i <= n; i++ ) out.push( ym + "-" + pad2( i ) );
        return out;
    }

    // Milliseconds from now until the next local midnight (for the day-rollover timer).
    function msToMidnight()
    {
        var now = new Date();
        return new Date( now.getFullYear(), now.getMonth(), now.getDate() + 1 ) - now;
    }

    //------------------------------------------------------------------------//
    // HABITS

    var DAY_PRESETS = { all: [], weekdays: [ 1, 2, 3, 4, 5 ], weekend: [ 6, 7 ] };

    function uniqSorted( arr )
    {
        var seen = {}, out = [];
        for( var i = 0; i < arr.length; i++ ) if( ! seen[ arr[ i ] ] ) { seen[ arr[ i ] ] = true; out.push( arr[ i ] ); }
        return out.sort();
    }

    function newId() { return "h_" + Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 6 ); }

    // A clean copy of one habit as read from the file: defaults for what is
    // missing, junk dropped, `done` sorted and unique. Returns null for an
    // unusable record (no name) so the caller can filter it out.
    function normalise( h )
    {
        if( ! h || typeof h !== "object" ) return null;
        var name = String( h.name || "" ).trim();
        if( ! name ) return null;

        var days = Array.isArray( h.days ) ? h.days.map( Number ).filter( function ( d ) { return d >= 1 && d <= 7; } ) : [];
        days = uniqSorted( days ).map( Number ).sort( function ( a, b ) { return a - b; } );
        if( days.length === 7 ) days = [];

        var target = parseInt( h.target, 10 );
        target = target >= 2 ? target : null;

        var done = uniqSorted( ( Array.isArray( h.done ) ? h.done : [] ).filter( isIso ) );

        var counts = {};
        if( target && h.counts && typeof h.counts === "object" )
        {
            for( var k in h.counts )
            {
                if( ! isIso( k ) ) continue;
                var n = parseInt( h.counts[ k ], 10 );
                if( ! ( n > 0 ) ) continue;
                if( n >= target ) { if( done.indexOf( k ) === -1 ) done.push( k ); }
                else counts[ k ] = n;
            }
            done = uniqSorted( done );
        }

        var color = parseInt( h.color, 10 );

        var paused = ( Array.isArray( h.paused ) ? h.paused : [] ).filter( function ( r )
        {
            return Array.isArray( r ) && isIso( r[ 0 ] ) && isIso( r[ 1 ] ) && r[ 0 ] < r[ 1 ];
        } ).map( function ( r ) { return [ r[ 0 ], r[ 1 ] ]; } );

        return {
            id:       String( h.id || newId() ),
            name:     name,
            icon:     String( h.icon || "star" ),
            color:    ( color >= 0 ? color : 0 ) % 8,
            days:     days,
            target:   target,
            created:  isIso( h.created ) ? h.created : ( done[ 0 ] || todayIso() ),
            archived: isIso( h.archived ) ? h.archived : null,
            paused:   paused,
            done:     done,
            counts:   counts
        };
    }

    // Does the habit apply on that day? Only between created and archived.
    function dueOn( h, iso )
    {
        if( iso < h.created ) return false;
        if( h.archived && iso >= h.archived ) return false;
        if( h.paused ) for( var i = 0; i < h.paused.length; i++ )
            if( iso >= h.paused[ i ][ 0 ] && iso < h.paused[ i ][ 1 ] ) return false;
        if( ! h.days || ! h.days.length ) return true;
        return h.days.indexOf( isoWeekday( iso ) ) !== -1;
    }

    function doneSet( h )
    {
        var s = {};
        for( var i = 0; i < h.done.length; i++ ) s[ h.done[ i ] ] = true;
        return s;
    }

    function isDone( h, iso ) { return h.done.indexOf( iso ) !== -1; }

    // How much of the day is done: the target (or 1) when done, else the partial count.
    function count( h, iso )
    {
        if( isDone( h, iso ) ) return h.target || 1;
        return ( h.counts && h.counts[ iso ] ) || 0;
    }

    // Mark a day done / not done. A partial count for that day is dropped either way.
    function setDone( h, iso, on )
    {
        var i = h.done.indexOf( iso );
        if( on && i === -1 ) { h.done.push( iso ); h.done.sort(); }
        if( ! on && i !== -1 ) h.done.splice( i, 1 );
        if( h.counts ) delete h.counts[ iso ];
    }

    // The check button. Yes/no: toggle. Counted: +1, done on reaching the
    // target; a tap on a done day steps back ONE (never wipes a full day).
    function tap( h, iso )
    {
        if( ! h.target ) { setDone( h, iso, ! isDone( h, iso ) ); return; }
        if( ! h.counts ) h.counts = {};
        if( isDone( h, iso ) )
        {
            setDone( h, iso, false );
            h.counts[ iso ] = h.target - 1;
            return;
        }
        var c = count( h, iso ) + 1;
        if( c >= h.target ) setDone( h, iso, true );
        else h.counts[ iso ] = c;
    }

    // Was yesterday a due day left undone?
    function missedYesterday( h, today )
    {
        var y = isoAdd( today, -1 );
        return dueOn( h, y ) && ! isDone( h, y );
    }

    // Consecutive due days done, walking back from today. Today counts if
    // done and is simply skipped if not (the day is not over); days that are
    // not due are skipped too. Stops at the first missed due day, or at
    // `created`.
    function streak( h, today )
    {
        var set = doneSet( h ), n = 0, iso = today, guard = 0;
        if( dueOn( h, iso ) && set[ iso ] ) n++;
        iso = isoAdd( iso, -1 );
        while( iso >= h.created && guard++ < 40000 )
        {
            if( dueOn( h, iso ) ) { if( set[ iso ] ) n++; else break; }
            iso = isoAdd( iso, -1 );
        }
        return n;
    }

    // The best run ever, from `created` up to today (or the day before it was archived).
    function longestStreak( h, today )
    {
        var set = doneSet( h ), best = 0, cur = 0;
        var end = h.archived && h.archived <= today ? isoAdd( h.archived, -1 ) : today;
        var d   = parseIso( h.created );
        for( var iso = toIso( d ); iso <= end; d.setDate( d.getDate() + 1 ), iso = toIso( d ) )
        {
            if( ! dueOn( h, iso ) ) continue;
            if( set[ iso ] ) { cur++; if( cur > best ) best = cur; }
            else cur = 0;
        }
        return best;
    }

    // Due days of "yyyy-mm" up to today, and how many were done.
    // pct is null when the month has no due day (yet).
    function monthStats( h, ym, today )
    {
        var set = doneSet( h ), due = 0, done = 0, days = daysOfMonth( ym );
        for( var i = 0; i < days.length; i++ )
        {
            var iso = days[ i ];
            if( iso > today ) break;
            if( ! dueOn( h, iso ) ) continue;
            due++;
            if( set[ iso ] ) done++;
        }
        return { due: due, done: done, pct: due ? Math.round( 100 * done / due ) : null };
    }

    //------------------------------------------------------------------------//
    // GLYPHS - the fixed set a habit can pick from. Inner SVG markup of a
    // 24x24 viewBox, drawn with stroke="currentColor" (Feather style), so the
    // same paths serve the rows, the month grid and the picker.

    var ICONS = {
        water: "water",
        walk: "walk",
        run: "run",
        book: "book",
        nosugar: "nosugar",
        sleep: "moon",
        pill: "pill",
        meditate: "meditate",
        write: "pen-line",
        music: "music",
        globe: "globe",
        weights: "weights",
        bike: "bike",
        fruit: "fruit",
        nophone: "nophone",
        star: "star-2"
    };

    // The app's own glyph (a sprout = something you grow), shared with the launcher tile and the PNG icons.
    var APP_GLYPH = "<path d='M12 22V10'/><path d='M12 12C12 8.5 9.2 5.5 5.5 5.5c0 3.5 2.8 6.5 6.5 6.5z'/><path d='M12 14c0-3.2 2.6-5.8 6-5.8 0 3.2-2.6 5.8-6 5.8z'/>";

    function glyph( name )
    {
        return "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>"
             + "<use href='#i-" + ( ICONS[ name ] || ICONS.star ) + "'/></svg>";
    }

    //------------------------------------------------------------------------//

    var api = {
        isIso: isIso, parseIso: parseIso, toIso: toIso, todayIso: todayIso, isoAdd: isoAdd,
        isoWeekday: isoWeekday, monthOf: monthOf, monthAdd: monthAdd, daysOfMonth: daysOfMonth,
        msToMidnight: msToMidnight,
        DAY_PRESETS: DAY_PRESETS, newId: newId, normalise: normalise,
        dueOn: dueOn, isDone: isDone, count: count, setDone: setDone, tap: tap,
        missedYesterday: missedYesterday, streak: streak, longestStreak: longestStreak, monthStats: monthStats,
        ICONS: ICONS, APP_GLYPH: APP_GLYPH, glyph: glyph
    };

    root.HabitsCore = api;
    if( typeof module !== "undefined" && module.exports ) module.exports = api;

} )( typeof window !== "undefined" ? window : this );
