// shared.mjs - the tour's shared parts, on Contacts (an item-browser app with
// a search fold and ranked toolbar buttons): the named steps "search",
// "pick", "picked"; a button fitBar moved into the ⋮ is reached through the
// ⋮ with no help from the app; the phone, where the ticks only show while
// picking. The steps are given here, not by Contacts.
import { server, browser, ok, section, done, sleep, onDisk, seed, mouse, key,
         state, runSteps, next, tourGone, walk, errors } from "./lib.mjs";

const F = "data/contacts.vcf";
const card = ( uid, fn ) => [ "BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + fn, "N:" + fn + ";;;;", "END:VCARD" ].join( "\r\n" );
const s = await server();
seed( s, { [ F ]: [ card( "a", "Ana" ), card( "b", "Bruno" ), card( "c", "Carla" ) ].join( "\r\n" ) + "\r\n" } );
const before = onDisk( s, F );
const STEPS = `[ 'search', 'pick', 'picked', { sel: '#dedupBtn', text: 'dedup' } ]`;
const picked = c => c.evaluate( "document.querySelectorAll( '#contactList [aria-selected=\"true\"]' ).length" );
const menuUp = c => c.evaluate( "!! document.querySelector( '.item-menu:not([hidden])' )" );

section( "SHARED STEPS · WIDE (mouse)" );
const c = await browser( s, { mouse: true, lang: "es" } );
await c.front();
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:contact', '1' ); true" );
ok( await c.open( "/nayive/contact/" ) && await c.until( "document.querySelectorAll( '#contactList .contact-row' ).length === 3" ), "Contacts opens" );
ok( await runSteps( c, STEPS ), "NayiveUI.tour( steps ) starts it" );
let st = await state( c );
ok( st.n === 1 && st.m === 6 && /nayive-home-link/.test( st.lit ), "home is added first, «?» last (6 steps)", st );
await next( c ); st = await state( c );
ok( /searchBtn/.test( st.lit ) && st.text.includes( "lupa" ), "«search» lights the magnifier, shared text", st );
await next( c ); st = await state( c );
ok( /pick-tick/.test( st.lit ) && st.tap, "«pick» lights a row's tick and asks for the tap", st );
await mouse( c, ".tour-overlay .tour-lid" ).catch( () => {} );
const tk = await c.evaluate( "( () => { const b = document.querySelector( '.pick-tick' ).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } )()" );
await mouse( c, tk );
await c.until( "document.querySelector( '.tour-count' ).textContent.startsWith( '4' )", 3000 );
st = await state( c );
ok( await picked( c ) === 1 && st.n === 4 && /sel-group|icon-btn/.test( st.lit ), "the user's tap picks the row; «picked» lights the selection group", st );
await next( c );
ok( await picked( c ) === 0, "leaving «picked» lets the row go" );
await key( c, "Escape" ); await tourGone( c );

section( "SHARED STEPS · NARROW (buttons in the ⋮)" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 330, height: 700, deviceScaleFactor: 1, mobile: false } );
await c.until( "document.getElementById( 'dedupBtn' ).classList.contains( 'fit-out' ) || !! document.querySelector( '#dedupBtn' ).closest( '.fit-out' )", 3000 );
ok( await c.evaluate( "!! document.querySelector( '#dedupBtn' ).closest( '.fit-out' )" ), "at 330 px the dedup button is in the ⋮" );
await runSteps( c, STEPS );
const seen = await walk( c, "narrow", {
    5: s => s.inMenu && /dedupBtn|menu-item/.test( s.lit ) && s.note.includes( "⋮" ) || "the ⋮ opens by itself and its row is lit" } );
const help = seen.at( -1 );
ok( await tourGone( c ) && ! await menuUp( c ), "the ⋮ it opened is shut again", help );

section( "SHARED STEPS · PHONE (touch)" );
const p = await browser( s, { lang: "es", width: 390, height: 760 } );
await p.evaluate( "localStorage.setItem( 'balata-intro-dismiss:contact', '1' ); true" );
await p.front();
ok( await p.open( "/nayive/contact/" ) && await p.until( "document.querySelectorAll( '#contactList .contact-row' ).length === 3" ), "Contacts opens on a phone" );
// Contacts' own ⋮ items ask canSave(), which toasts "still reading" until the
// book is in (a Contacts matter, not the tour's): let the load finish first.
await sleep( 2500 );
await p.watchToasts();
await runSteps( p, STEPS );
await walk( p, "phone", {
    3: s => ( s.ghost || /pick-tick/.test( s.lit ) ) || "«pick» rings a row",
    4: s => /sel-group|icon-btn/.test( s.lit ) && ! s.ghost || "«picked» picked a row itself and lights the group" } );
ok( await tourGone( p ) && await picked( p ) === 0, "nothing stays picked" );
ok( ! ( await p.toasts() ).length, "no toast on the way", await p.toasts() );

ok( onDisk( s, F ) === before, "nothing was written" );
ok( ! errors( c, p ).length, "no script errors", errors( c, p ) );
await p.stop();
await done( c, s );
