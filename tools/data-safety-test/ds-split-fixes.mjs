// ds-split-fixes.mjs - the Split fixes of docs/audit/tools-2026-11-14.md, on the
// app's REAL functions under Node (listapps-fns.mjs): no browser, no server.
//
// S1  "1.234.567" is an amount (thousands only), and a text that is not one says so.
// S6  decimals the currency does not have are refused, never rounded ("12,5" yen).
// S2  the floppy follows store.write()'s answer: green only for a save that is up.
// S3  editing an OLD foreign expense does not bring its old rate back as the remembered one.
// S4  a new currency for an empty group drops the rates kept for the old one.
// S5  removing a person who had an "exact" part: the others' parts add up again.
import { createRequire } from "node:module";
import path from "node:path";
import { ok, section, done, REPO } from "./lib.mjs";
import { appFns } from "./listapps-fns.mjs";

const require = createRequire( import.meta.url );
const M = require( path.join( REPO, "client/apps/split/money.js" ) );
const PAGE = "client/apps/split/index.html";

const T  = ( k ) => k;
const TF = ( k, o ) => k + JSON.stringify( o || {} );
const els = {};
const $ = ( id ) => els[ id ] || ( els[ id ] = { id, dataset: {}, firstChild: null, value: "", textContent: "", hidden: false,
                                                 set innerHTML( v ) { this.firstChild = v; }, setAttribute( k, v ) { this[ k ] = v; } } );
const Ayni = { icon: () => "<svg></svg>", toast() {}, focusFirstError: () => false,
               dates: { pad: ( n ) => String( n ).padStart( 2, "0" ), today: () => "2026-11-14" },
               picker: ( el ) => ( { value: el.value } ) };
const tick = () => new Promise( ( r ) => setTimeout( r, 5 ) );

//------------------------------------------------------------------------//
section( "S1 + S6 · AMOUNTS" );
for( const [ text, code, want ] of [
    [ "1.234.567", "EUR", 123456700 ], [ "1,234,567", "USD", 123456700 ], [ "1.234.567,89", "EUR", 123456789 ],
    [ "1.234", "EUR", 123400 ], [ "12,30", "EUR", 1230 ], [ "1.234.567", "JPY", 1234567 ],
    [ "1,2,3", "EUR", null ], [ "1.23.456", "EUR", null ], [ "0,125", "EUR", null ],
    [ "12,5", "JPY", null ], [ "12,0", "JPY", 12 ], [ "12,3456", "EUR", null ], [ "12,3450", "EUR", null ] ] )
{
    const got = M.parseAmount( text, code );
    ok( got === want, `"${text}" ${code} -> ${want}`, got );
}
{
    const es = { amountText: "1,2,3", currency: "EUR", kind: "expense", paidBy: "m1", mode: "equal", among: [ "m1" ], partText: {} };
    const f = appFns( PAGE, [ "validateEntry" ], { M, T, TF, es, current: { currency: "EUR" }, fmt: String } );
    ok( f.validateEntry().hint === "split.notAmount", "a text that is not an amount says so", f.validateEntry() );
    es.amountText = "";
    ok( f.validateEntry().hint === "", "an empty amount: no hint" );
    es.amountText = "1.234.567";
    ok( f.validateEntry().ok && f.validateEntry().amount === 123456700, "1.234.567 can be saved", f.validateEntry() );
}

//------------------------------------------------------------------------//
section( "S2 · THE FLOPPY FOLLOWS THE STORE'S ANSWER" );
{
    let answer = null;
    const writes = [];
    const store = { write: ( p, body ) => { writes.push( p ); return answer; } };
    const g = { _base: "data/split/a", _ro: false, name: "A" };
    const f = appFns( PAGE, [ "persist", "showSaved", "floppy" ], { $, T, TF, Ayni, store, current: g, FILE: "group.json", saveSeq: 0 } );
    for( const [ r, want ] of [ [ { ok: true }, "saved" ], [ { ok: false, offline: true }, "here" ], [ { ok: false, needsAuth: true }, "here" ],
                                [ { ok: false, pageOnly: true }, "unsaved" ], [ { ok: false, blocked: "x" }, "unsaved" ],
                                [ { ok: false, conflict: true }, "unsaved" ], [ { ok: false, unknown: true }, "unsaved" ] ] )
    {
        answer = Promise.resolve( r );
        f.persist( g );
        const first = $( "savedAt" ).dataset.state;
        await tick();
        ok( first === "saving" && $( "savedAt" ).dataset.state === want, JSON.stringify( r ) + " -> " + want, [ first, $( "savedAt" ).dataset.state ] );
    }
    ok( writes.length === 7 && writes.every( ( p ) => p === "data/split/a/group.json" ), "each persist wrote the group file once", writes );

    // An older answer arriving after a newer save does not paint the floppy.
    let slow;
    answer = new Promise( ( r ) => { slow = r; } );
    f.persist( g );
    answer = Promise.resolve( { ok: true } );
    f.persist( g );
    await tick();
    slow( { ok: false, pageOnly: true } );
    await tick();
    ok( $( "savedAt" ).dataset.state === "saved", "a late answer of an older save is ignored", $( "savedAt" ).dataset.state );

    const ro = { _base: "shared/x", _ro: true };
    const before = writes.length;
    f.persist( ro );
    ok( writes.length === before, "a read-only group is never written" );
}

//------------------------------------------------------------------------//
section( "S3 · AN OLD EXPENSE DOES NOT BRING BACK ITS OLD RATE" );
{
    const g = { currency: "EUR", rates: { USD: 0.9 }, members: [], entries: [
        { id: "old", type: "expense", date: "2026-11-01", amount: 1000, currency: "USD", rate: 0.8, created: 1, text: "old", paidBy: "m1", split: { mode: "equal", among: [ "m1" ] } },
        { id: "new", type: "expense", date: "2026-11-05", amount: 1000, currency: "USD", rate: 0.9, created: 2, text: "new", paidBy: "m1", split: { mode: "equal", among: [ "m1" ] } } ] };
    const mk = ( id, date, rate ) => ( { id, created: 1, kind: "expense", currency: "USD", amountText: "10", rateText: String( rate ), text: "x", date,
                                          paidBy: "m1", mode: "equal", among: [ "m1" ], partText: {} } );
    let saved = 0;
    const vars = { M, T, TF, $, Ayni, current: g, fmt: String, newId: () => "fresh", persist: () => saved++, closeSheet() {}, renderGroup() {} };
    appFns( PAGE, [ "saveEntry", "validateEntry", "refreshEntryHints" ], Object.assign( {}, vars, { es: mk( "old", "2026-11-01", 0.8 ) } ) ).saveEntry();
    ok( g.rates.USD === 0.9 && saved === 1, "editing the older one keeps the newer rate", g.rates );
    appFns( PAGE, [ "saveEntry", "validateEntry", "refreshEntryHints" ], Object.assign( {}, vars, { es: mk( "new", "2026-11-05", 0.95 ) } ) ).saveEntry();
    ok( g.rates.USD === 0.95 && saved === 2, "editing the newest one remembers its rate", g.rates );
    appFns( PAGE, [ "saveEntry", "validateEntry", "refreshEntryHints" ], Object.assign( {}, vars, { es: mk( null, "2026-11-10", 0.97 ) } ) ).saveEntry();
    ok( g.rates.USD === 0.97 && g.entries.length === 3, "a new, later expense remembers its rate", g.rates );
}

//------------------------------------------------------------------------//
section( "S4 · A NEW CURRENCY FOR AN EMPTY GROUP" );
{
    const g = { name: "A", currency: "EUR", rates: { USD: 0.9 }, entries: [] };
    $( "groupNameInput" ).value = "A";
    $( "groupCurSel" ).value = "GBP";
    let saved = 0;
    const f = appFns( PAGE, [ "saveGroup" ], { $, T, Ayni, gs: { g }, persist: () => saved++, closeSheet() {}, render() {} } );
    f.saveGroup();
    ok( g.currency === "GBP" && JSON.stringify( g.rates ) === "{}" && saved === 1, "currency changed, old rates dropped", g );
    const h = { name: "B", currency: "EUR", rates: { USD: 0.9 }, entries: [ { id: "e" } ] };
    appFns( PAGE, [ "saveGroup" ], { $, T, Ayni, gs: { g: h }, persist() {}, closeSheet() {}, render() {} } ).saveGroup();
    ok( h.currency === "EUR" && h.rates.USD === 0.9, "a group with entries keeps its currency and rates", h );
}

//------------------------------------------------------------------------//
section( "S5 · A REMOVED PERSON'S EXACT PART" );
{
    const g = { _base: "b", _ro: false, currency: "EUR", members: [ { id: "m1", name: "A" }, { id: "m2", name: "B" }, { id: "m3", name: "C" } ], rates: {},
                entries: [ { id: "e1", type: "expense", amount: 3001, currency: "EUR", paidBy: "m1", split: { mode: "exact", parts: { m1: 1000, m2: 1000, m3: 1001 } } },
                           { id: "e2", type: "expense", amount: 900, currency: "EUR", paidBy: "m1", split: { mode: "exact", parts: { m1: 450, m2: 450 } } },
                           { id: "e3", type: "expense", amount: 1000, currency: "EUR", paidBy: "m1", split: { mode: "exact", parts: { m1: 100, m2: 100 } } },
                           { id: "e4", type: "expense", amount: 600, currency: "EUR", paidBy: "m1", split: { mode: "equal", among: [ "m1", "m2", "m3" ] } } ] };
    let saved = 0;
    const f = appFns( PAGE, [ "saveMembers", "withoutGone" ], { M, T, Ayni, current: g, ms: g.members.filter( ( m ) => m.id !== "m3" ), msGone: [ "m3" ],
                                                                persist: () => saved++, closeSheet() {}, renderGroup() {} } );
    f.saveMembers();
    const p1 = g.entries[ 0 ].split.parts;
    ok( ! ( "m3" in p1 ) && p1.m1 + p1.m2 === 3001, "the others' parts add up to the amount again", p1 );
    ok( JSON.stringify( g.entries[ 1 ].split.parts ) === JSON.stringify( { m1: 450, m2: 450 } ), "an expense the person was not in: untouched" );
    ok( JSON.stringify( g.entries[ 2 ].split.parts ) === JSON.stringify( { m1: 100, m2: 100 } ), "an expense that lost nothing is not rewritten", g.entries[ 2 ].split.parts );
    ok( JSON.stringify( g.entries[ 3 ].split.among ) === JSON.stringify( [ "m1", "m2" ] ), "an equal split just loses the person" );
    ok( saved === 1, "saved once" );
    const after = M.balances( g );
    ok( Object.values( after ).reduce( ( a, b ) => a + b, 0 ) === 0, "the balances still sum to zero", after );
}

await done();
