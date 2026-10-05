// email.mjs - eMail on the shared item browser: a mouse picks, a double-click
// opens, one menu, the keys, the tree of trays + labels (its own menus, drop
// on a label / on the Trash), delete with Undo and no question; then a phone:
// tap opens, long-press picks, the tree slides in.
//
// lib.mjs's server() has no mail account, so this starts the eMail test
// server of tools/email-test (TestMailE2EServe in server/go: a whole Nayive,
// user ana/abc, one account on an in-memory IMAP server) - as
// tools/data-safety-test/ds-mail.mjs does. Every data check asks the server.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { browser, ok, section, done, sleep, mouse, key, finger, drag, menuRows, fitState } from "./lib.mjs";
import { client, REPO } from "../data-safety-test/lib.mjs";

const GO = process.env.GO || ( fs.existsSync( os.homedir() + "/sdk/go1.27.1/bin/go" ) ? os.homedir() + "/sdk/go1.27.1/bin/go" : "go" );
const SHOTS = process.env.SHOTS || fs.mkdtempSync( path.join( os.tmpdir(), "bt-email-" ) );

async function mailServer()
{
    const port = await new Promise( res => { const x = net.createServer(); x.listen( 0, "127.0.0.1", () => { const p = x.address().port; x.close( () => res( p ) ); } ); } );
    const tmp  = fs.mkdtempSync( path.join( os.tmpdir(), "bt-mail-" ) );
    const stop = path.join( tmp, "stop" );
    const proc = spawn( GO, [ "test", "-v", "-count=1", "-timeout", "20m", "-run", "^TestMailE2EServe$", "." ],
                        { cwd: path.join( REPO, "server/go" ), stdio: [ "ignore", "pipe", "inherit" ],
                          env: { ...process.env, NAYIVE_MAIL_E2E: "127.0.0.1:" + port, NAYIVE_MAIL_E2E_STOP: stop } } );
    process.on( "exit", () => { try { fs.writeFileSync( stop, "" ); } catch {} try { proc.kill(); } catch {} } );
    await new Promise( ( res, rej ) =>
    {
        let buf = "";
        const t = setTimeout( () => rej( new Error( "the mail test server did not start: " + buf ) ), 300000 );
        proc.stdout.on( "data", d => { buf += d; if( buf.includes( "E2E READY" ) ) { clearTimeout( t ); res(); } } );
        proc.on( "exit", code => rej( new Error( "the mail test server stopped: " + code + " " + buf ) ) );
    } );
    return {
        base: "http://127.0.0.1:" + port, users: { ana: "abc" },
        stop: async () =>
        {
            try { fs.writeFileSync( stop, "" ); } catch {}
            await new Promise( r => { if( proc.exitCode !== null ) r(); else { proc.once( "exit", r ); setTimeout( () => { try { proc.kill(); } catch {} r(); }, 4000 ); } } );
            try { fs.rmSync( tmp, { recursive: true, force: true } ); } catch {}
        }
    };
}

const s = await mailServer();
const phone = await client( s.base, "ana", "abc" );                    // the server's view
const J = async ( m, u, b ) => { const r = await phone.call( m, u, b && JSON.stringify( b ), b ? { "Content-Type": "application/json" } : {} ); return { status: r.status, j: r.text ? JSON.parse( r.text ) : null }; };
const acct = ( await J( "GET", "/api/mail/accounts" ) ).j.accounts[ 0 ].id;
const A = encodeURIComponent( acct );
const tray = async t => ( await J( "GET", `/api/mail/${A}/list?tray=${t}` ) ).j.items || [];
const inTray = async ( t, subj ) => ( await tray( t ) ).find( m => m.subject === subj ) || null;
const work = ( await J( "POST", "/api/mail/labels", { name: "Work" } ) ).j;
ok( work && work.id, "a label 'Work' to drop on", work );

const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:email', '1' ); true" );
const shot = async name => { const r = await c.send( "Page.captureScreenshot", { format: "png" } ); fs.writeFileSync( path.join( SHOTS, name + ".png" ), Buffer.from( r.result.data, "base64" ) ); };
const openPage = async () => { await c.open( "/nayive/email/index.html" ); return c.until( "document.querySelectorAll( '#list .mail-row' ).length >= 10 && ! NayiveMail.S.loading", 30000 ); };
// the i-th row of a subject (mouse() takes a selector + an index)
const I = subj => c.evaluate( `[ ...document.querySelectorAll( '#list .mail-row' ) ].findIndex( r => r.querySelector( '.subj span' ).textContent === ${JSON.stringify( subj )} )` );
const ROW = '#list .mail-row';
const at = async ( subj, o = {} ) => mouse( c, ROW, { dx: 120, ...o, i: await I( subj ) } );
const picked = () => c.evaluate( "NayiveMail.picked().map( m => m.subject ).join()" );
// a point of the list under its last row
const EMPTY = () => c.evaluate( "( () => { const r = document.getElementById('list').getBoundingClientRect(); return { x: r.left + 60, y: r.bottom - 8 }; } )()" );
const shown = subj => c.evaluate( `[ ...document.querySelectorAll( '#list .mail-row' ) ].some( r => r.querySelector( '.subj span' ).textContent === ${JSON.stringify( subj )} )` );

section( "EMAIL · MOUSE" );
ok( await openPage(), "eMail opens the Inbox", c.logs.slice( -15 ) );
await at( "Hello 1" );
ok( await picked() === "Hello 1", "a click picks one row", await picked() );
ok( await c.evaluate( "! NayiveMail.S.open && document.getElementById('readView').hidden" ), "…it does not open it" );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .sel-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await at( "Hello 3", { mods: 8 } );
ok( await picked() === "Hello 1,Hello 2,Hello 3" || ( await picked() ).split( "," ).sort().join() === "Hello 1,Hello 2,Hello 3", "Shift+click picks the range", await picked() );
await at( "Hello 2", { mods: 2 } );
ok( ( await picked() ).split( "," ).sort().join() === "Hello 1,Hello 3", "Ctrl+click takes one out", await picked() );
ok( await c.evaluate( "document.querySelectorAll('#list .mail-row.is-selected').length === 2" ), "the picked rows are painted" );
await shot( "e01-picked" );
await key( c, "Escape" );
ok( await picked() === "" && await c.evaluate( "document.getElementById('selActions').hidden" ), "Esc clears; the group goes" );
await at( "Hello 1" );
await key( c, "a", 2 );
ok( await c.evaluate( "NayiveMail.picked().length === document.querySelectorAll('#list .mail-row').length" ), "Ctrl+A picks all" );
await mouse( c, await EMPTY() );
ok( await picked() === "", "a click on empty space (under the rows) clears", await picked() );

section( "EMAIL · ONE MENU" );
await at( "Hello 2", { button: "right" } );
let rows = await menuRows( c );
const act = ( id, off = false ) => rows && rows.some( r => r.act === id && r.off === off );
ok( await picked() === "Hello 2" && act( "reply" ) && act( "forward" ) && act( "read" ) && act( "star" ) && act( "label" ) && act( "spam" ) && act( "del" ), "right-click picks that row: reply, forward, read, star, label, spam, delete", rows );
ok( rows && ! rows.some( r => [ "notSpam", "restore", "forget" ].includes( r.act ) ), "…Not spam, Restore, Delete for good are not there (Inbox)" );
ok( await c.evaluate( "[ ...document.querySelectorAll('.item-menu .mi-key') ].map( k => k.textContent ).join() === 'Enter,R,Shift+R,F,U,S,L,Del'" ), "…each with its key",
    await c.evaluate( "[ ...document.querySelectorAll('.item-menu .mi-key') ].map( k => k.textContent ).join()" ) );
await shot( "e02-menu" );
await key( c, "Escape" );
ok( await c.evaluate( "document.querySelector('.item-menu').hidden" ), "Esc closes the menu" );
await at( "Hello 3", { mods: 2 } );
await at( "Hello 3", { button: "right" } );
rows = await menuRows( c );
ok( await picked() === "Hello 2,Hello 3" && act( "reply", true ) && act( "del" ), "two picked, right-click on one: the menu greys Reply, keeps Delete", rows );
await key( c, "Escape" );
ok( await c.evaluate( "! document.querySelector('#list [data-more], #tree [data-more], #selActions [data-sel=menu]')" ), "no row ⋮, no tree ⋮, no ⋮ in the selection group" );
let ft = await fitState( c );
ok( ft.acts.join() === "reply,replyAll,forward,read,star,label,spam,del" && ! ft.out.length && ! ft.more && ! ft.crowded,
    "wide: every action is a button, in menu order (Inbox: no Not spam, Restore, Delete for good); no ⋮", ft );
ok( await c.evaluate( "document.querySelector('#selActions [data-sel-act=reply]').disabled && ! document.querySelector('#selActions [data-sel-act=del]').disabled" ), "…Reply greyed for two, Delete not" );
await key( c, "Escape" );
await mouse( c, await EMPTY(), { button: "right" } );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === "compose" ) && rows.some( r => r.act === "pick" ) && rows.some( r => r.act === "selectAll" ), "right-click on empty space: Write, Select…, Select all", rows );
await key( c, "Escape" );

section( "EMAIL · KEYS" );
await at( "Hello 2" );
await key( c, "s" );
ok( await c.until( "NayiveMail.picked()[ 0 ] && NayiveMail.picked()[ 0 ].flagged" ) && ( await inTray( "inbox", "Hello 2" ) )?.flagged === true, "S stars it (on the server)" );
await key( c, "s" );
ok( await c.until( "NayiveMail.picked()[ 0 ] && ! NayiveMail.picked()[ 0 ].flagged" ) && ( await inTray( "inbox", "Hello 2" ) )?.flagged === false, "S again: the star goes" );
const seen0 = ( await inTray( "inbox", "Hello 2" ) ).seen;
await key( c, "u" );
ok( await c.until( `NayiveMail.picked()[ 0 ].seen === ${! seen0}` ) && ( await inTray( "inbox", "Hello 2" ) ).seen === ! seen0, "U turns read / not read" );
await key( c, "u" );
await c.until( `NayiveMail.picked()[ 0 ].seen === ${seen0}` );
await key( c, "ArrowDown" );
ok( await picked() === "Hello 1", "↓ moves the pick", await picked() );
await key( c, "Enter" );
ok( await c.until( "NayiveMail.S.open && NayiveMail.S.open.subject === 'Hello 1' && ! document.getElementById('readView').hidden" ), "Enter opens it" );
ok( await c.evaluate( "!document.getElementById('actReply').hidden && !document.getElementById('actDelete').hidden && document.getElementById('actRestore').hidden && document.getElementById('selActions').hidden" ),
    "the reader's own buttons (no Restore in the Inbox); no pick group" );
ft = await fitState( c );
ok( [ "actReply", "actReplyAll", "actForward", "actStar", "actLabel", "actSpam", "actDelete" ].every( b => ft.tools.includes( b ) ) && ! ft.tools.includes( "actRestore" ) && ! ft.more && ! ft.crowded,
    "…all of them buttons when wide, no ⋮", ft );
await key( c, "s" );
ok( await c.until( "NayiveMail.S.open && NayiveMail.S.open.flagged" ) && ( await inTray( "inbox", "Hello 1" ) )?.flagged === true, "S in the reader stars the mail open" );
await key( c, "s" );
await c.until( "NayiveMail.S.open && ! NayiveMail.S.open.flagged" );
await c.evaluate( "document.getElementById('backBtn').click(); true" );
await c.until( "! NayiveMail.S.open" );
await at( "Hello 8", { count: 2 } );
ok( await c.until( "NayiveMail.S.open && NayiveMail.S.open.subject === 'Hello 8'" ), "a double-click opens a mail" );
await c.evaluate( "document.getElementById('backBtn').click(); true" );
await c.until( "! NayiveMail.S.open" );

section( "EMAIL · DELETE: AT ONCE, WITH UNDO" );
await at( "Hello 4" );
await c.evaluate( "window.__toasts = []; true" );
await key( c, "Delete" );
ok( await c.until( "! [ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 4' ) )" ), "Del: the row goes at once" );
ok( await c.evaluate( "! document.querySelector('.sheet-backdrop.open')" ) && await c.until( "!! document.querySelector('#toast .toast-undo')" ), "…no question, an Undo" );
ok( ! await inTray( "inbox", "Hello 4" ) && !! await inTray( "trash", "Hello 4" ), "…on the server: in the Trash" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await c.until( "[ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 4' ) )", 10000 ) && !! await inTray( "inbox", "Hello 4" ) && ! await inTray( "trash", "Hello 4" ), "Undo: back in the Inbox (server too)" );

section( "EMAIL · THE TREE" );
const TR = id => `#tree .tree-row[data-id="${id}"]`;
const trows = await c.evaluate( "[ ...document.querySelectorAll('#tree .tree-row') ].map( r => r.dataset.id ).join()" );
ok( trows === `inbox,drafts,sent,spam,trash,labels,l:${work.id}`, "one tree: the five trays, then Labels with its labels", trows );
const srv = ( await J( "GET", `/api/mail/${A}/trays` ) ).j.trays.find( t => t.role === "inbox" );
ok( await c.evaluate( `( document.querySelector( '${TR( "inbox" )} .tree-badge' ) || {} ).textContent === '${srv.unread || ""}' || ( ${srv.unread} === 0 && ! document.querySelector( '${TR( "inbox" )} .tree-badge' ) )` ) &&
    await c.evaluate( `/${srv.total}/.test( document.querySelector( '${TR( "inbox" )}' ).title )` ), "the Inbox's badge: not read (the server's); its tooltip: the total", srv );
ok( await c.evaluate( `document.querySelector( '${TR( "inbox" )}' ).classList.contains('is-active')` ), "the tray on screen is lit" );
await mouse( c, TR( "trash" ), { button: "right", dx: 40 } );
rows = await menuRows( c );
ok( rows && rows.length === 1 && rows[ 0 ].act === "empty", "Trash's own menu: Empty Trash", rows );
await key( c, "Escape" );
await mouse( c, TR( "labels" ), { button: "right", dx: 40 } );
ok( ( await menuRows( c ) )?.some( r => r.act === "newLabel" ), "Labels' menu: New label" );
await key( c, "Escape" );
await mouse( c, TR( "l:" + work.id ), { button: "right", dx: 40 } );
rows = await menuRows( c );
ok( rows && rows.some( r => r.act === "editLabel" ) && rows.some( r => r.act === "deleteLabel" ), "a label's menu: Edit, Delete", rows );
await shot( "e03-tree-menu" );
await key( c, "Escape" );
// drop on a label: it is added
await at( "Hello 5" );
await c.evaluate( "window.__toasts = []; true" );
let lit = await drag( c, `${ROW}.is-selected`, TR( "l:" + work.id ) );
const lab = async () => ( ( await J( "GET", "/api/mail/label/" + encodeURIComponent( work.id ) ) ).j.items || [] ).map( m => m.subject );
let got = false;
for( let i = 0; i < 50 && ! got; i++ ) { got = ( await lab() ).includes( "Hello 5" ); if( ! got ) await sleep( 100 ); }
ok( lit === true && got, "a row dropped on a label (lit): the label is on it (server)", { lit, got: await lab() } );
ok( await c.until( "( window.__toasts || [] ).some( t => /Work/.test( t ) )" ) && await c.until( "[ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 5' ) && r.textContent.includes( 'Work' ) )" ),
    "…its chip shows, a toast says so", await c.evaluate( "window.__toasts" ) );
// drop on the Trash: deleted, with Undo
await at( "Hello 6" );
lit = await drag( c, `${ROW}.is-selected`, TR( "trash" ) );
ok( lit === true && await c.until( "! [ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 6' ) )" ) && !! await inTray( "trash", "Hello 6" ), "a row dropped on Trash: deleted (server)", lit );
ok( await c.until( "!! document.querySelector('#toast .toast-undo')" ), "…with an Undo" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await c.until( "[ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 6' ) )", 10000 ) && !! await inTray( "inbox", "Hello 6" ), "…Undo brings it back" );
ok( await drag( c, ROW, TR( "drafts" ) ) === false, "Drafts takes no drop" );
// a click opens a label's list
await mouse( c, TR( "l:" + work.id ), { dx: 40 } );
ok( await c.until( `NayiveMail.S.label === ${JSON.stringify( work.id )} && ! NayiveMail.S.loading` ) && await c.until( "document.querySelectorAll('#list .mail-row').length === 1" ) && await shown( "Hello 5" ),
    "a click on the label lists its mail" );
// the Trash: Restore and Delete for good, not Delete
await mouse( c, TR( "inbox" ), { dx: 40 } );
await c.until( "NayiveMail.S.tray === 'inbox' && ! NayiveMail.S.label && document.querySelectorAll('#list .mail-row').length >= 10 && ! NayiveMail.S.loading" );
await at( "Hello 7" );
await key( c, "Delete" );
await c.until( "! [ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 7' ) )" );
await c.evaluate( "NayiveUI.undoSettle(); true" );
await mouse( c, TR( "trash" ), { dx: 40 } );
ok( await c.until( "NayiveMail.S.tray === 'trash' && ! NayiveMail.S.loading" ) && await c.until( "[ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 7' ) )" ), "a click on Trash opens it" );
await at( "Hello 7", { button: "right" } );
rows = await menuRows( c );
ok( act( "restore" ) && act( "forget" ) && ! rows.some( r => r.act === "del" || r.act === "spam" ), "in the Trash: Restore, Delete for good; no Delete, no Spam", rows );
await key( c, "Escape" );
await key( c, "Delete", 8 );
ok( await c.until( "! [ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 7' ) )" ) && await c.until( "!! document.querySelector('#toast .toast-undo')" ), "Shift+Del: out of sight at once, with Undo" );
await c.evaluate( "document.querySelector('#toast .toast-undo').click(); true" );
ok( await c.until( "[ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 7' ) )", 8000 ) && !! await inTray( "trash", "Hello 7" ), "…Undo: still in the Trash (server)" );
await at( "Hello 7" );
await c.evaluate( "NayiveMail.browse.run( 'restore' ); true" );
ok( await c.until( "! [ ...document.querySelectorAll('#list .mail-row') ].some( r => r.textContent.includes( 'Hello 7' ) )" ) && await ( async () => { for( let i = 0; i < 50; i++ ) { if( await inTray( "inbox", "Hello 7" ) ) return true; await sleep( 100 ); } return false; } )(),
    "Restore: back in the Inbox (server)" );
await mouse( c, TR( "inbox" ), { dx: 40 } );
await c.until( "NayiveMail.S.tray === 'inbox' && document.querySelectorAll('#list .mail-row').length >= 10 && ! NayiveMail.S.loading" );
await shot( "e04-desktop" );

section( "EMAIL · PICK DIALOG" );
await c.evaluate( "document.getElementById('selectBtn').click(); true" );
ok( await c.until( "document.getElementById('pickSheet').classList.contains('open')" ), "the select button opens the pick dialog" );
await c.evaluate( "document.getElementById('pickFrom').value = 'eve'; document.getElementById('pickGoBtn').click(); true" );
ok( await c.until( "NayiveMail.picked().length === 1 && NayiveMail.picked()[ 0 ].subject === 'Pictures'" ) &&
    await c.evaluate( "[ ...document.querySelectorAll('#list .mail-row') ].filter( r => ! r.hidden ).length === 1" ), "From eve: only her mail, picked and in sight", await picked() );
await key( c, "Escape" );
ok( await c.until( "NayiveMail.picked().length === 0 && [ ...document.querySelectorAll('#list .mail-row') ].every( r => ! r.hidden )" ), "Esc: every row in sight again" );

section( "EMAIL · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
ok( await openPage(), "eMail on a phone" );
ok( await c.evaluate( "document.documentElement.scrollWidth <= innerWidth && getComputedStyle( document.getElementById('treeBtn') ).display !== 'none'" ), "no side scroll; the tree's button shows" );
await finger( c, ROW, 60, await I( "Hello 1" ) );
ok( await c.until( "NayiveMail.S.open && NayiveMail.S.open.subject === 'Hello 1' && ! document.getElementById('backBtn').hidden" ), "a tap opens the mail" );
await sleep( 200 );
ft = await fitState( c );
const READ_ORDER = [ "actReply", "actReplyAll", "actForward", "actRead", "actUnread", "actStar", "actLabel", "actSpam", "actDelete" ];
ok( ! ft.crowded && ft.more && ft.tools.includes( "actDelete" ) && ! ft.tools.includes( "actReplyAll" ),
    "phone reader: one row; Delete stays, Reply all leaves first, the ⋮ shows", ft );
const rr = ft.rows.filter( b => READ_ORDER.includes( b ) );
ok( rr.join() === ft.rows.slice( 0, rr.length ).join() && rr.join() === READ_ORDER.filter( b => rr.includes( b ) ).join() && rr.includes( "actReplyAll" ),
    "…its ⋮ lists the hidden buttons in toolbar order", ft );
await mouse( c, "#moreBtn" );
const rrows = await menuRows( c );
ok( rrows && rrows.some( r => r.act === "actReplyAll" ), "the ⋮ opens with them", rrows );
await key( c, "Escape" );
await shot( "e05-phone-read" );
await finger( c, "#backBtn" );
await c.until( "! NayiveMail.S.open" );
await finger( c, ROW, 700, await I( "Hello 2" ) );
ok( await c.until( "NayiveMail.picked().map( m => m.subject ).join() === 'Hello 2'" ) && await c.evaluate( "document.getElementById('list').classList.contains('is-picking') && ! NayiveMail.S.open" ), "a long-press picks (ticks on), it does not open" );
await finger( c, ROW, 60, await I( "Hello 3" ) );
ok( await c.until( "NayiveMail.picked().length === 2" ), "a tap then adds one" );
ft = await fitState( c );
ok( ! ft.crowded && ft.more && [ "del", "read" ].every( a => ft.acts.includes( a ) ) && ! ft.tools.includes( "selectBtn" ),
    "phone header: one row; the top ranks stay, the tools leave first, the ⋮ shows", ft );
const ORDER = [ "reply", "replyAll", "forward", "read", "star", "label", "spam", "del" ];
ok( ft.rows.filter( a => ORDER.includes( a ) ).join() === ft.out.join() && ft.out.join() === ORDER.filter( a => ft.out.includes( a ) ).join() && ft.out.includes( "spam" ) &&
    ft.rows.indexOf( ft.out[ ft.out.length - 1 ] ) < ft.rows.indexOf( "searchBtn" ),
    "…its ⋮ lists the hidden actions in toolbar order, then the hidden tools", ft );
await mouse( c, "#moreBtn" );
const mrows = await menuRows( c );
ok( mrows && mrows.some( r => r.act === ft.out[ 0 ] ), "the ⋮ opens with them", mrows );
await key( c, "Escape" );
ok( await c.evaluate( "document.documentElement.scrollWidth <= innerWidth && document.querySelector('.topbar').getBoundingClientRect().right <= innerWidth" ), "…and it fits" );
await shot( "e06-phone-picking" );
await finger( c, "#selActions [data-sel=clear]" );
ok( await c.until( "NayiveMail.picked().length === 0 && ! document.getElementById('list').classList.contains('is-picking')" ), "the × stops picking" );
await finger( c, "#treeBtn" );
ok( await c.until( "document.getElementById('side').classList.contains('open')" ), "the folder button slides the tree in" );
await sleep( 300 );
await shot( "e07-phone-tree" );
await finger( c, TR( "sent" ) );
ok( await c.until( "NayiveMail.S.tray === 'sent' && ! document.getElementById('side').classList.contains('open')" ) && await c.evaluate( "document.getElementById('whereName').textContent === NayiveUI.t('mail.tray.sent')" ), "a tap on Sent opens it and the tree slides away" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false } );
await mouse( c, TR( "inbox" ), { dx: 40 } );
await c.until( "NayiveMail.S.tray === 'inbox' && !! document.querySelector('#list .mail-row') && ! NayiveMail.S.loading" );
await c.evaluate( "NayiveMail.browse.set( [ document.querySelector('#list .mail-row').dataset.id ] ); true" );
await sleep( 200 );
ft = await fitState( c );
ok( ! ft.out.length && ! ft.more && ft.tools.includes( "selectBtn" ) && ! ft.crowded, "back to 1400 px: everything is a button again, no ⋮", ft );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
console.log( "screenshots: " + SHOTS );
await done( c, s );
