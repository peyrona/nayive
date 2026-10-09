// contacts.mjs - Contacts' tour: ghosts with an empty book; with 35 contacts
// the groups tree, the shared search / ⋮ / pick / picked steps and the A-Z
// rail; a phone (the groups button, the picked row let go); no toast on the
// way (the ⋮ rows once flashed "still reading"), and never a byte written.
import { server, browser, ok, section, done, sleep, onDisk, seed, key,
         state, startTour, next, tourGone, walk, errors } from "./lib.mjs";

const F = "data/contacts.vcf";
const card = ( uid, fn ) => [ "BEGIN:VCARD", "VERSION:3.0", "UID:" + uid, "FN:" + fn, "N:" + fn + ";;;;", "END:VCARD" ].join( "\r\n" );
const NAMES = "Ana Bruno Carla David Elena Fabio Gema Hugo Inés Jorge Karen Luis Marta Nuria Óscar Paula Quique Rosa Sergio Tania Ulises Vera Walter Xavi Yago Zoe Alba Beto Cora Dani Eva Fede Gala Hector Iris".split( " " );
const s = await server();
const picked = c => c.evaluate( "document.querySelectorAll( '#contactList [aria-selected=\"true\"]' ).length" );
async function fresh( c, path, rows )
{
    await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:contact', '1' ); true" );
    const ok1 = await c.open( path ) && await c.until( rows ? `document.querySelectorAll( '#contactList .contact-row' ).length === ${rows}`
                                                            : "getComputedStyle( document.getElementById( 'emptyState' ) ).display !== 'none'" );
    await c.watchToasts();
    return ok1;
}

section( "CONTACTS · EMPTY BOOK (ghosts)" );
const c = await browser( s, { mouse: true, lang: "es" } );
await c.front();
ok( await fresh( c, "/nayive/contact/", 0 ), "Contacts opens empty" );
ok( await startTour( c ), "«Ver el tour» starts it" );
await walk( c, "empty", {
    2: s => /tree/.test( s.lit ) || "wide: lights the groups tree",
    3: s => /searchBtn/.test( s.lit ) || "lights the magnifier",
    6: s => /fit-more/.test( s.lit ) || "lights the ⋮",
    7: s => s.ghost || "open a card: a ghost",
    8: s => s.ghost || "pick: a ghost",
    9: s => s.ghost || "picked: a ghost",
    10: s => s.ghost || "A-Z: a ghost" } );
ok( await tourGone( c ), "it closes" );
ok( ! ( await c.toasts() ).length, "no toast", await c.toasts() );

section( "CONTACTS · 35 CONTACTS (real buttons)" );
seed( s, { [ F ]: NAMES.map( ( n, i ) => card( "u" + i, n ) ).join( "\r\n" ) + "\r\n" } );
const before = onDisk( s, F );
ok( await fresh( c, "/nayive/contact/", 35 ), "Contacts shows 35 contacts" );
await startTour( c );
await walk( c, "full", {
    7:  s => /contact-row/.test( s.lit ) && ! s.ghost || "lights a real row",
    8:  s => /pick-tick/.test( s.lit ) && s.tap || "lights a row's tick",
    9:  s => /sel-group|selActions|icon-btn/.test( s.lit ) && ! s.ghost || "picks a row and lights the selection group",
    10: s => /azRail/.test( s.lit ) || "lights the A-Z rail" } );
ok( await tourGone( c ) && await picked( c ) === 0, "nothing stays picked" );
ok( ! ( await c.toasts() ).length, "no toast", await c.toasts() );

section( "CONTACTS · PHONE" );
const p = await browser( s, { lang: "es", width: 390, height: 760 } );
await p.front();
ok( await fresh( p, "/nayive/contact/", 35 ), "Contacts opens on a phone" );
await startTour( p );
await walk( p, "phone", {
    2: s => /treeBtn/.test( s.lit ) || "phone: lights the groups button",
    9: s => ! s.ghost || "picked: picks a row itself" } );
ok( await tourGone( p ) && await picked( p ) === 0, "nothing stays picked" );
ok( ! ( await p.toasts() ).length, "no toast", await p.toasts() );

section( "CONTACTS · THE ⋮ ROWS WHILE LOADING" );
const q = await browser( s, { lang: "es", width: 390, height: 760 } );
await q.evaluate( "localStorage.setItem( 'balata-intro-dismiss:contact', '1' ); true" );
await q.send( "Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener( 'DOMContentLoaded', () => { const t = document.getElementById( 'toast' ); window.__seen = [];
    new MutationObserver( () => { if( t.classList.contains( 'show' ) ) window.__seen.push( t.textContent ); } ).observe( t, { attributes: true, childList: true, subtree: true } ); } );` } );
await q.open( "/nayive/contact/" );
await q.until( "document.querySelectorAll( '#contactList .contact-row' ).length === 35" );
await sleep( 1500 );
ok( ! ( await q.evaluate( "window.__seen" ) ).length, "no «still reading» toast while the book loads", await q.evaluate( "window.__seen" ) );

ok( onDisk( s, F ) === before, "nothing was written" );
ok( ! errors( c, p, q ).length, "no script errors", errors( c, p, q ) );
await p.stop(); await q.stop();
await done( c, s );
