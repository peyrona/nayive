// ds-listapps-bugs2.mjs - two list-app fixes of bugs-2, on the apps' REAL
// functions under Node (listapps-fns.mjs): no browser, no server.
//
// AA2 (Split): the People sheet asked "may this one go?" of each person
//     alone, against the entries as they were: B and C, the only two sharing
//     an expense, each showed the bin. Both binned, Save emptied the split,
//     and the balances lost that debt. Now asked against the splits as Save
//     will leave them, and Save refuses an expense shared by nobody.
// AA6 (Tasks): a sub-task id another task already had was renamed on load,
//     but its siblings' "after" links kept the old id, and the next save
//     dropped them.
import { createRequire } from "node:module";
import path from "node:path";
import { ok, section, done, REPO } from "./lib.mjs";
import { appFns } from "./listapps-fns.mjs";

const require = createRequire( import.meta.url );
const M = require( path.join( REPO, "client/apps/split/money.js" ) );

//------------------------------------------------------------------------//
section( "AA2 · SPLIT: THE LAST ONE SHARING AN EXPENSE CANNOT BE BINNED TOO" );
{
    const group = { currency: "EUR", members: [ { id: "a", name: "Ana" }, { id: "b", name: "Beto" }, { id: "c", name: "Carla" } ],
                    entries: [ { id: "e1", type: "expense", date: "2026-10-01", amount: 3000, currency: "EUR", rate: 1, created: 1,
                                 paidBy: "a", split: { mode: "equal", among: [ "b", "c" ] } } ] };
    const before = JSON.stringify( M.balances( group ) );
    const gone = [];
    const f = appFns( "client/apps/split/index.html", [ "withoutGone" ], { msGone: gone } );

    ok( M.sharedOnly( f.withoutGone( group ), "b" ) === 1 && M.sharedOnly( f.withoutGone( group ), "c" ) === 1,
        "nobody binned yet: B and C may each go (their share passes to the other)" );
    gone.push( "b" );                                         // B binned in the sheet
    ok( M.sharedOnly( f.withoutGone( group ), "c" ) === -1, "B binned: C is the last one sharing it - hide, not the bin",
        M.sharedOnly( f.withoutGone( group ), "c" ) );
    const after = f.withoutGone( group );
    ok( JSON.stringify( after.entries[ 0 ].split.among ) === '["c"]' && JSON.stringify( group.entries[ 0 ].split.among ) === '["b","c"]',
        "...asked on a copy: the group itself is untouched until Save" );
    ok( JSON.stringify( M.balances( after ) ) !== "{}" && Object.keys( M.balances( after ) ).length > 1,
        "...and the debt still counts with C alone sharing it", M.balances( after ) );
    gone.push( "c" );
    ok( M.participants( f.withoutGone( group ).entries[ 0 ] ).ids.length === 0 && M.participants( group.entries[ 0 ] ).ids.length === 2,
        "(both binned would leave it shared by nobody: what Save refuses)" );
    ok( JSON.stringify( M.balances( group ) ) === before, "(the balances as they were)" );
}

//------------------------------------------------------------------------//
section( "AA6 · TASKS: A RENAMED DUPLICATE SUB-TASK KEEPS ITS 'AFTER' LINKS" );
{
    const f = appFns( "client/apps/tasks/index.html", [ "uniqueIds", "sanitizePlan" ], { DAYS_MAX: 999 } );
    // Task A has sub-task 5; task B too (two devices, one millisecond), and B's 7 waits on B's 5.
    const list = [ { id: 1, text: "A", done: false, subtasks: [ { id: 5, text: "a5", done: false } ] },
                   { id: 2, text: "B", done: false, subtasks: [ { id: 5, text: "b5", done: false }, { id: 7, text: "b7", done: false, after: [ 5 ] } ] } ];
    // as the app loads it (index.html: uniqueIds( sanitizePlan( ... ) )), then the next save's sanitize
    const loaded = f.sanitizePlan( f.uniqueIds( f.sanitizePlan( list ) ) );
    const [ b5, b7 ] = loaded[ 1 ].subtasks;
    ok( b5.id !== 5 && loaded[ 0 ].subtasks[ 0 ].id === 5, "B's sub-task 5 gets a new id, A's keeps 5", [ loaded[ 0 ].subtasks[ 0 ].id, b5.id ] );
    ok( Array.isArray( b7.after ) && b7.after.length === 1 && b7.after[ 0 ] === b5.id, "B's 7 still waits on it, by its new id", b7.after );

    // Two sub-tasks of ONE task with one id: the link stays on the one that kept it.
    const one = [ { id: 3, text: "C", done: false, subtasks: [ { id: 8, text: "c8", done: false }, { id: 8, text: "c8b", done: false },
                                                               { id: 9, text: "c9", done: false, after: [ 8 ] } ] } ];
    const l2 = f.sanitizePlan( f.uniqueIds( f.sanitizePlan( one ) ) );
    ok( l2[ 0 ].subtasks[ 0 ].id === 8 && l2[ 0 ].subtasks[ 1 ].id !== 8 && JSON.stringify( l2[ 0 ].subtasks[ 2 ].after ) === "[8]",
        "a duplicate within one task: 'after' keeps the id still there", l2[ 0 ].subtasks );
}

await done();
