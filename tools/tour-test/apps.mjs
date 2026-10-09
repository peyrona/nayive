// apps.mjs - the tour of every app that has no file of its own here, from one
// table: each app is opened with some data (and once with none, where that
// matters), its tour walked from the help card - wide with a mouse, then on a
// touch phone - and the user's whole home compared before and after: a tour
// never writes. App by app the table says what a few steps must light.
//
//   node tools/tour-test/apps.mjs              all of them
//   APPS=split,calendar node tools/tour-test/apps.mjs
import fs from "node:fs";
import path from "node:path";
import { server, browser, ok, section, done, sleep, seed, mouse,
         state, startTour, next, tourGone, walk, errors } from "./lib.mjs";

const today = new Date().toLocaleDateString( "sv" );
// A 64 x 48 orange JPEG, for the apps that show pictures.
const JPEG = Buffer.from( "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCzRRRXzJ9QFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB//9k=", "base64" );

const has = sel => `!! document.querySelector( ${JSON.stringify( sel )} )`;

// path: the app's URL; ready: true once it has drawn; seed: files in the
// home; empty: also walk it with no data; then( c ): get to the screen to
// tour; expect: { step: state => true | "why not" } (wide only); phone: false
// to skip the phone; dismiss: help card key of an app whose card auto-opens;
// settle: ms to wait for the app's own background writes before the tour;
// mouse: false for a wide screen with no mouse (the launcher, which otherwise
// hands a mouse user over to the desktop).
const APPS = {
    calendar: {
        path: "/nayive/calendar/", ready: has( "#calHost .fc, #calHost [class*=fc-]" ), empty: true,
        seed: { "data/calendar.ics": [ "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//t//EN", "BEGIN:VEVENT", "UID:e1",
                "DTSTART:" + today.replace( /-/g, "" ) + "T100000", "DTEND:" + today.replace( /-/g, "" ) + "T110000",
                "SUMMARY:Dentista", "END:VEVENT", "END:VCALENDAR", "" ].join( "\r\n" ) },
        expect: { 2: s => /calHost|fc/.test( s.lit ) || "the calendar itself" }
    },
    planner: {
        path: "/nayive/planner/", ready: "document.querySelectorAll( '#panes iframe[src]' ).length >= 1",
        expect: { 2: s => /calendarPane/.test( s.lit ) || "the Calendar pane" }
    },
    image: {
        path: "/nayive/image/?file=files/foto.jpg", ready: has( ".tui-image-editor-menu" ), seed: { "files/foto.jpg": JPEG },
        expect: { 2: s => /backBtn/.test( s.lit ) || "← first" }
    },
    text: {
        path: "/nayive/text/?file=files/nota.txt", ready: has( ".CodeMirror" ), seed: { "files/nota.txt": "Hola\nmundo\n" },
        expect: { 4: s => s.inMenu === false && /newBtn|menu-item/.test( s.lit ) || "Nuevo: lit inside the open File menu" }
    },
    write: {
        path: "/nayive/write/", ready: has( "#editor .superdoc-page, #editor [class*=page]" ),
        expect: { 2: s => /editor/.test( s.lit ) || "the page" }
    },
    calc: {
        path: "/nayive/calc/", ready: "document.querySelectorAll( '#gridHost .ht_master .htCore tbody tr' ).length > 0",
        expect: { 2: s => /gridHost|ht/.test( s.lit ) || "the sheet" }
    },
    photos: {
        path: "/nayive/photos/?dir=files/fotos", ready: "document.querySelectorAll( '#grid [aria-selected]' ).length >= 2",
        seed: { "files/fotos/a.jpg": JPEG, "files/fotos/b.jpg": JPEG, "files/fotos/viaje/c.jpg": JPEG }
    },
    music: {
        path: "/nayive/music/?dir=files/musica", settle: 4000, ready: has( "#libContent [aria-selected], #libContent .empty-hint" ),
        seed: { "files/musica/Grupo/Disco/01 Uno.mp3": Buffer.alloc( 2048 ), "files/musica/Grupo/Disco/02 Dos.mp3": Buffer.alloc( 2048 ) }
    },
    movies: {
        path: "/nayive/movies/?dir=files/pelis", ready: has( "#libContent [aria-selected], #libContent .empty-hint" ),
        seed: { "files/pelis/Una peli (1999).mp4": Buffer.alloc( 4096 ) }
    },
    bookmarks: {
        path: "/nayive/bookmarks/", ready: "document.querySelectorAll( '#items [aria-selected]' ).length >= 2", empty: true, emptyReady: has( "#app:not([style*='none'])" ),
        dismiss: "bookmarks",
        seed: { "data/bookmarks/bookmarks.json": JSON.stringify( { version: 1, rootId: "root", nodes: {
            root: { id: "root", title: "", type: "folder", parentId: null, children: [ "f_a", "b_1", "b_2" ], createdAt: "2026-01-01T00:00:00Z" },
            f_a:  { id: "f_a", title: "Viajes", type: "folder", parentId: "root", children: [], createdAt: "2026-01-01T00:00:00Z" },
            b_1:  { id: "b_1", title: "Ejemplo", type: "bookmark", parentId: "root", url: "https://example.com/", tags: [], notes: "", favorite: false, createdAt: "2026-01-01T00:00:00Z" },
            b_2:  { id: "b_2", title: "Otro", type: "bookmark", parentId: "root", url: "https://example.org/", tags: [], notes: "", favorite: false, createdAt: "2026-01-01T00:00:00Z" } } } ) }
    },
    trips: {
        path: "/nayive/trips/", ready: has( ".trip-card" ), empty: true, emptyReady: has( "#tripHeader .trip-header-actions" ),
        seed: { "data/trips/osaka/trip.json": JSON.stringify( { id: 9100, destination: "Osaka", dirName: "osaka", startDate: "2026-11-01", endDate: "2026-11-10",
            lat: 34.7, lon: 135.5, documents: [], stages: [ 91, 92 ].map( id => ( { id, location: id === 91 ? "Osaka" : "Kioto", startDate: "2026-11-02", startTime: "",
                endDate: "2026-11-03", endTime: "", transport: "train", tz: "Asia/Tokyo", tzLabel: "Asia/Tokyo", lat: 34.7, lon: 135.5,
                accommodation: "", notes: "", enabled: true, documents: [] } ) ) } ) },
        expect: { 2: s => /trip-card/.test( s.lit ) || "a trip card" },
        group: {
            then: async c => { await c.evaluate( "goToDetail( 9100 ); true" ); return c.until( "!! document.querySelector( '.stage-actions' )" ); },
            expect: { 3: s => /icon-btn/.test( s.lit ) && ! s.ghost || "a real stage button", 4: s => ! s.ghost || "real", 5: s => ! s.ghost || "real",
                      6: s => /stage-drag/.test( s.lit ) || "the grip" }
        }
    },
    drive: {
        path: "/nayive/drive/", ready: "document.querySelectorAll( '#listing [aria-selected]' ).length >= 3", empty: true,
        emptyReady: has( "#listing" ), dismiss: "drive",
        seed: { "files/Fotos/a.jpg": JPEG, "files/nota.txt": "hola\n", "files/lista.txt": "uno\ndos\n" },
        expect: { 3: s => /pick-tick/.test( s.lit ) && s.tap || "a row's tick", 4: s => ! s.ghost || "the selection group" }
    },
    email: {
        path: "/nayive/email/", ready: has( "#noAcct:not([hidden]), #list" ), dismiss: "email"
    },
    chat: {
        path: "/nayive/chat/", ready: has( "#vList #helpBtn" ),
        // The open chat's own card and tour: a group of one, made through the app's API.
        group: {
            then: async c => { await c.evaluate( `( async () => { const C = NayiveChat; const g = await C.api( 'POST', 'groups', { name: 'Prueba', members: [] } ).catch( e => null );
                                    if( g ) { await C.loadSummary(); await C.openConv( 'g-' + g.id ); } else { const r = document.querySelector( '#vList [aria-selected]' ); if( r ) r.click(); } return true; } )()` );
                               return c.until( "!! document.querySelector( '#convHelpBtn' ) && ! document.getElementById( 'vConv' ).hidden" ); }
        }
    },
    desktop: {
        path: "/nayive/desktop/", ready: has( "#bar #helpBtn" ), phone: false, settle: 4000,
        expect: { 1: s => /menuBtn/.test( s.lit ) || "the apps menu" }
    },
    launcher: {
        path: "/nayive/", ready: has( ".grid .tile" ), mouse: false, dismiss: "launcher", settle: 4000,
        expect: { 1: s => /grid|tile/.test( s.lit ) || "the app tiles" }
    },
    split: {
        path: "/nayive/split/", ready: has( "#groupList > .card-row" ), empty: true, emptyReady: "! document.getElementById( 'homeEmpty' ).hidden",
        seed: { "data/split/cena-ab12/group.json": JSON.stringify( { id: "cena-ab12", name: "Cena", currency: "EUR", created: today, archived: false,
                    members: [ { id: "m1", name: "Yo", me: true }, { id: "m2", name: "Ana" } ], rates: {},
                    entries: [ { id: "e1", type: "expense", date: today, amount: 3000, currency: "EUR", rate: 1, created: 1, text: "Pizza",
                                 paidBy: "m1", split: { mode: "equal", among: [ "m1", "m2" ] } } ] } ) },
        expect: { 2: s => /addBtn/.test( s.lit ) || "+ for a new group", 3: s => /card-row/.test( s.lit ) || "a group row" },
        // A second tour inside the group: its own card, its own steps.
        group: {
            then: async c => { await mouse( c, "#groupList > .card-row .row-main" ); return c.until( "! document.getElementById( 'groupView' ).hidden" ); },
            expect: { 1: s => /backBtn/.test( s.lit ) || "← back first (the app name is hidden in a group)" },
            after: c => c.evaluate( "! document.getElementById( 'entriesTab' ).hidden" ).then( v => v || "back on «Gastos» at the end" )
        }
    }
};

const want = ( process.env.APPS || "" ).split( "," ).filter( Boolean );
const names = Object.keys( APPS ).filter( n => ! want.length || want.includes( n ) );

// Every file under the home, with its bytes: a tour must leave it as it was.
function snapshot( s )
{
    const out = {}, root = s.home();
    ( function walkDir( d ) {
        for( const e of fs.readdirSync( d, { withFileTypes: true } ) )
        {
            const p = path.join( d, e.name );
            if( e.isDirectory() ) walkDir( p ); else out[ path.relative( root, p ) ] = fs.readFileSync( p ).toString( "base64" );
        }
    } )( root );
    return JSON.stringify( out );
}

async function tourOnce( c, s, label, cfg, scr )
{
    if( scr.then ) ok( await scr.then( c ), `${label}: gets to the screen` );
    if( cfg.settle ) await sleep( cfg.settle );      // the app's own background writes (a scan cache) first
    const before = snapshot( s );
    ok( await startTour( c ), `${label}: «Ver el tour» starts it` );
    await walk( c, label, scr.expect || {} );
    ok( await tourGone( c ), `${label}: it closes` );
    if( scr.after ) { const r = await scr.after( c ); ok( r === true, `${label}: ${r === true ? "the screen is put back" : r}` ); }
    await sleep( 600 );
    const after = snapshot( s ), b = JSON.parse( before ), a = JSON.parse( after );
    ok( after === before, `${label}: nothing was written`, Object.keys( { ...a, ...b } ).filter( k => a[ k ] !== b[ k ] ) );
}

const tabs = [];
for( const name of names )
{
    const cfg = APPS[ name ];
    const s = await server();
    const quiet = `localStorage.setItem( 'balata-intro-dismiss:${cfg.dismiss || "none"}', '1' ); true`;

    if( cfg.empty )
    {
        section( name.toUpperCase() + " · NO DATA" );
        const e = await browser( s, { mouse: true, lang: "es" } );
        tabs.push( e );
        await e.front();
        await e.evaluate( quiet );
        ok( await e.open( cfg.path ) && await e.until( cfg.emptyReady || cfg.ready ), `${name}: opens empty` );
        await tourOnce( e, s, name + "-empty", cfg, { expect: {} } );
        await e.stop();
    }

    seed( s, cfg.seed || {} );
    for( const phone of cfg.phone === false ? [ false ] : [ false, true ] )
    {
        section( name.toUpperCase() + ( phone ? " · PHONE" : " · WIDE" ) );
        const c = phone ? await browser( s, { lang: "es", width: 390, height: 760 } ) : await browser( s, { mouse: cfg.mouse !== false, lang: "es" } );
        tabs.push( c );
        await c.front();
        await c.evaluate( quiet );
        ok( await c.open( cfg.path ) && await c.until( cfg.ready ), `${name}: opens with data` );
        const tag = name + ( phone ? "-phone" : "" );
        await tourOnce( c, s, tag, cfg, phone ? { then: cfg.then } : cfg );
        if( cfg.group ) await tourOnce( c, s, tag + "-in", cfg, phone ? { then: cfg.group.then, after: cfg.group.after } : cfg.group );
        await c.stop();
    }
    await s.stop();
}

ok( ! errors( ...tabs ).length, "no script errors", errors( ...tabs ) );
await done();
