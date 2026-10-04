// chat.mjs - the Chat list on the shared item browser (no tree): a mouse
// picks, side by side a click still opens the chat, one menu (pin, mute,
// mark read, delete), the keys, Delete with Undo and no question (the server
// keeps the chat until the Undo is gone); a window as narrow as a phone
// (click picks, double-click opens); then a phone: tap opens, long-press picks.
import { server, browser, ok, section, done, sleep, mouse, key, finger, menuRows } from "./lib.mjs";

const s = await server();
const phone = await s.client();       // the owner on another device: the server's view
const JSON_H = { "Content-Type": "application/json" };
const person = async name => JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name } ), JSON_H ) ).text );
const carmen = await person( "Carmen" ), javi = await person( "Javi" ), luis = await person( "Luis" );
const CA = "d-" + carmen.id, JA = "d-" + javi.id, LU = "d-" + luis.id;
// Carmen writes (by her link, no account): her chat is unread for the owner.
const guestSend = async ( p, text ) => fetch( s.base + "/api/c/" + p.token + "/conv/d-" + p.id + "/messages",
    { method: "POST", headers: JSON_H, body: JSON.stringify( { kind: "text", text, cid: "bt-" + text } ) } );
await guestSend( carmen, "hola" );
await guestSend( carmen, "¿vienes?" );
await phone.post( "/api/chat/conv/" + JA + "/messages", JSON.stringify( { kind: "text", text: "para borrar", cid: "bt-javi" } ), JSON_H );
const conv = async id => ( JSON.parse( ( await phone.call( "GET", "/api/chat" ) ).text ).convs || [] ).find( x => x.id === id ) || {};
const onServer = async id => ( JSON.parse( ( await phone.call( "GET", "/api/chat/conv/" + id + "/messages" ) ).text ).msgs || [] )
                                 .filter( m => ! m.deleted ).map( m => m.text );
const waitFor = async ( fn, ms = 8000 ) => { for( const end = Date.now() + ms; Date.now() < end; await sleep( 100 ) ) if( await fn() ) return true; return false; };

const c = await browser( s, { mouse: true } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
const ROW = id => `#rows .row[data-conv="${id}"]`;
const sel = () => c.evaluate( "NayiveChat.browse.ids().join()" );
const opened = () => c.evaluate( "NayiveChat.S.open" );
const order = () => c.evaluate( "[ ...document.querySelectorAll( '#rows .row[data-conv]' ) ].map( e => e.dataset.conv )" );

section( "CHAT · MOUSE, SIDE BY SIDE" );
await c.open( "/nayive/chat/index.html" );
ok( await c.until( `document.querySelectorAll( '#rows .row[data-conv]' ).length === 3 && !! window.NayiveChat.browse` ), "Chat lists the three chats, on the item browser" );
ok( await c.evaluate( "document.querySelector( '#listHead .topbar-actions' ).firstElementChild.id === 'selActions' && document.getElementById( 'selActions' ).hidden" ),
    "the list's header starts with the (hidden) selection group" );
ok( await c.evaluate( `!! document.querySelector( '${ROW( CA )}.unread .badge' )` ), "Carmen's row shows its unread count" );
await mouse( c, ROW( JA ), { dx: 160 } );
ok( await sel() === JA && await c.until( `NayiveChat.S.open === ${JSON.stringify( JA )} && ! document.getElementById( 'vConv' ).hidden` ),
    "side by side, a click picks the chat AND opens it beside the list" );
ok( await c.evaluate( "!document.getElementById('selActions').hidden && document.querySelector('#selActions .sel-count').textContent.trim() === '1'" ), "the header group shows, count 1" );
await mouse( c, ROW( LU ), { dx: 160, mods: 2 } );
ok( await sel() === JA + "," + LU && await opened() === JA, "Ctrl+click adds one, and does not open it", [ await sel(), await opened() ] );
ok( await c.evaluate( "document.querySelectorAll( '#rows .row.is-selected' ).length === 2" ), "the picked rows are painted" );
await key( c, "Escape" );
ok( await sel() === "" && await c.evaluate( "document.getElementById('selActions').hidden" ), "Esc clears; the group goes" );
const all = await order();
await mouse( c, ROW( all[ 0 ] ), { dx: 160 } );
await mouse( c, ROW( all[ 2 ] ), { dx: 160, mods: 8 } );
ok( await sel() === all.join(), "Shift+click picks the range", await sel() );
await key( c, "Escape" );
await mouse( c, ROW( all[ 0 ] ), { dx: 160, mods: 2 } );   // (a plain click opens the chat: its box takes the keys)
await key( c, "a", 2 );
ok( ( await sel() ).split( "," ).length === 3, "Ctrl+A picks all", await sel() );
await mouse( c, "#rows" );
ok( await sel() === "", "a click on empty space clears" );
await mouse( c, ROW( CA ), { dx: 160, mods: 2 } );
await mouse( c, "#vConv", { dx: 200 } );          // the user goes to read the chat beside the list
await key( c, "Escape" );
ok( await sel() === CA, "while reading the chat beside it, the list's keys rest (Esc does not clear it)", await sel() );
await mouse( c, ROW( CA ), { dx: 160, mods: 2 } );
ok( await sel() === "", "(Ctrl+click takes it out again)" );

section( "CHAT · ONE MENU" );
await mouse( c, ROW( CA ), { dx: 160, button: "right" } );
let rows = await menuRows( c );
ok( await sel() === CA && rows && rows.map( r => r.act ).join() === "open,pin,mute,read,del", "right-click picks that row; the menu: Open, Pin, Mute, Mark read, Delete chat", rows );
ok( rows && rows.every( r => ! r.off ), "…all of them on for one unread chat" );
ok( await c.evaluate( "[ ...document.querySelectorAll('.item-menu .mi-key') ].map( k => k.textContent ).join() === 'Enter,Del'" ), "…with their keys beside them" );
ok( await opened() === JA, "(a right-click does not open the chat)" );
await key( c, "Escape" );
ok( await c.evaluate( "document.querySelector('.item-menu').hidden" ), "Esc closes the menu" );
await mouse( c, ROW( CA ) + " [data-more]" );
ok( ( await menuRows( c ) )?.some( r => r.act === "pin" ), "the row ⋮ opens the same menu" );
await key( c, "Escape" );
await mouse( c, "#selActions [data-sel=menu]" );
ok( ( await menuRows( c ) )?.some( r => r.act === "pin" ), "the header ⋮ opens the same menu" );
await key( c, "Escape" );
await mouse( c, "#rows", { button: "right" } );
rows = await menuRows( c );
ok( rows && rows.map( r => r.act ).join() === "newChat,selectAll" && await sel() === "", "right-click on empty space: New chat, Select all", rows );
await c.evaluate( "document.querySelector('.item-menu [data-act=newChat]').click(); true" );
ok( await c.until( "document.getElementById( 'vList' ).hidden && !! document.querySelector( '.side .view .bar' )" ), "…New chat opens its screen" );
await c.evaluate( "NayiveChat.back(); true" );
await c.until( "! document.getElementById( 'vList' ).hidden" );

section( "CHAT · PIN, MUTE, MARK READ (the server's state)" );
await mouse( c, ROW( CA ), { dx: 160, button: "right" } );
await c.evaluate( "document.querySelector('.item-menu [data-act=pin]').click(); true" );
ok( await waitFor( async () => ( await conv( CA ) ).pin === true ), "Pin: the server has it pinned" );
ok( await c.until( `document.querySelector( '#rows .row[data-conv]' ).dataset.conv === ${JSON.stringify( CA )} && !! document.querySelector( '${ROW( CA )} .flag' )` ),
    "…it goes to the top, with the pin mark" );
ok( await c.until( `document.querySelector( '#selActions [data-sel-act=pin]' )?.title.startsWith( 'Unpin' )` ), "the toggle now reads Unpin", await c.evaluate( "document.querySelector( '#selActions [data-sel-act=pin]' )?.title" ) );
await mouse( c, "#selActions [data-sel-act=pin]" );
ok( await waitFor( async () => ! ( await conv( CA ) ).pin ), "the header's Unpin: unpinned on the server" );
await c.until( `NayiveChat.convOf( ${JSON.stringify( CA )} ).pin !== true` );
await mouse( c, "#selActions [data-sel-act=mute]" );
ok( await waitFor( async () => ( await conv( CA ) ).mute === true ), "the header's Mute: muted on the server" );
await c.until( `NayiveChat.convOf( ${JSON.stringify( CA )} ).mute === true` );
await mouse( c, "#selActions [data-sel-act=mute]" );
ok( await waitFor( async () => ! ( await conv( CA ) ).mute ), "…and Unmute" );
ok( ( await conv( CA ) ).unread === 2, "Carmen's chat: 2 unread on the server", ( await conv( CA ) ).unread );
await mouse( c, ROW( CA ), { dx: 160, button: "right" } );
await c.evaluate( "document.querySelector('.item-menu [data-act=read]').click(); true" );
ok( await waitFor( async () => ( await conv( CA ) ).unread === 0 ), "Mark read: read on the server", ( await conv( CA ) ).unread );
ok( await c.until( `! document.querySelector( '${ROW( CA )} .badge' )` ) && await opened() === JA, "…the count leaves the row; the chat was not opened" );
await mouse( c, ROW( CA ), { dx: 160, button: "right" } );
ok( ( await menuRows( c ) )?.find( r => r.act === "read" )?.off === true, "Mark read is greyed for a read chat" );
await key( c, "Escape" );

section( "CHAT · KEYS" );
await mouse( c, ROW( LU ), { dx: 160, mods: 2 } );
ok( await sel() === CA + "," + LU, "two picked" );
await mouse( c, ROW( LU ), { dx: 160, button: "right" } );
rows = await menuRows( c );
ok( rows?.find( r => r.act === "del" )?.off === true && rows?.find( r => r.act === "open" )?.off === true, "Delete chat and Open: one chat at a time (greyed for two)" );
await key( c, "Escape" );
await key( c, "Delete" );
ok( await c.evaluate( `!! document.querySelector( '${ROW( CA )}' ) && !! document.querySelector( '${ROW( LU )}' )` ), "…so Del does nothing with two picked" );
await mouse( c, ROW( CA ), { dx: 160, mods: 2 } );
ok( await sel() === LU, "one left" );
await key( c, "Enter" );
ok( await c.until( `NayiveChat.S.open === ${JSON.stringify( LU )}` ), "Enter opens it" );

section( "CHAT · DELETE: AT ONCE, UNDO, NO QUESTION" );
ok( ( await onServer( JA ) ).includes( "para borrar" ), "Javi's chat has its message on the server" );
await c.evaluate( "NayiveChat.browse.clear(); true" );
await mouse( c, ROW( JA ), { dx: 160, mods: 2 } );
await key( c, "Delete" );
ok( await c.until( `! document.querySelector( '${ROW( JA )}' )` ), "Del: the chat leaves the list at once" );
ok( await opened() === LU && await c.evaluate( "! document.getElementById( 'vConv' ).hidden" ), "…and the chat open beside the list stays open", await opened() );
ok( await c.evaluate( "! document.querySelector( '.sheet-backdrop.open' )" ) && await c.until( "!! document.querySelector( '#toast .toast-undo' )" ), "…no question, an Undo" );
ok( ( await onServer( JA ) ).includes( "para borrar" ), "…the server still has it while the Undo shows" );
await c.evaluate( "document.querySelector( '#toast .toast-undo' ).click(); true" );
ok( await c.until( `!! document.querySelector( '${ROW( JA )}' )` ) && ( await onServer( JA ) ).includes( "para borrar" ), "Undo brings it back, nothing lost" );
await sleep( 300 );
ok( ( await onServer( JA ) ).includes( "para borrar" ) && ! ( await conv( JA ) ).hidden, "…and the server never cleared it" );
await mouse( c, ROW( JA ), { dx: 160, button: "right" } );
await c.evaluate( "document.querySelector('.item-menu [data-act=del]').click(); true" );
ok( await c.until( `! document.querySelector( '${ROW( JA )}' )` ), "the menu's Delete chat: gone from the list" );
await c.until( "!! document.querySelector( '#toast .toast-undo' )" );
await c.evaluate( "NayiveUI.undoSettle(); true" );
ok( await waitFor( async () => ! ( await onServer( JA ) ).includes( "para borrar" ) ), "the Undo gone: cleared on the server (for me only)", await onServer( JA ) );
ok( await waitFor( async () => ( await conv( JA ) ).hidden === true ), "…the chat is hidden for me until somebody writes" );

section( "CHAT · A PERSON'S PAGE (BY LINK): UNCHANGED" );
const g = await c.tab( "/c/" + carmen.token + "/" );
ok( await g.until( `!! document.querySelector( '#rows .row[data-conv="${CA}"]' )` ), "Carmen's page lists her chat" );
ok( await g.evaluate( "! window.NayiveUI.browser && ! window.NayiveChat.browse && ! document.getElementById( 'selActions' )" ), "…without the item browser (no browser.js there)" );
await g.evaluate( "NayiveChat.closeConv && NayiveChat.S.open && NayiveChat.closeConv( true ); true" );
await g.evaluate( `document.querySelector( '#rows .row[data-conv="${CA}"]' ).click(); true` );
ok( await g.until( `NayiveChat.S.open === ${JSON.stringify( CA )} && ! document.getElementById( 'vConv' ).hidden` ), "…a click opens her chat, as before" );
ok( ! g.logs.filter( l => /EXCEPTION/.test( l ) ).length, "…no page exceptions", g.logs.filter( l => /EXCEPTION/.test( l ) ) );
await g.send( "Page.close" ).catch( () => {} );

section( "CHAT · A WINDOW AS NARROW AS A PHONE, WITH A MOUSE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false } );
await c.open( "/nayive/chat/index.html" );
await c.until( "document.querySelectorAll( '#rows .row[data-conv]' ).length === 2 && !! window.NayiveChat.browse" );
await mouse( c, ROW( CA ), { dx: 160 } );
ok( await sel() === CA && ! await opened(), "a click picks, it does not open" );
await mouse( c, ROW( CA ), { dx: 160, count: 2 } );
ok( await c.until( `NayiveChat.S.open === ${JSON.stringify( CA )} && document.getElementById( 'chat' ).classList.contains( 'in-main' )` ), "a double-click opens" );

section( "CHAT · PHONE" );
await c.send( "Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true } );
await c.send( "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 } );
await c.open( "/nayive/chat/index.html" );
await c.until( "document.querySelectorAll( '#rows .row[data-conv]' ).length === 2 && !! window.NayiveChat.browse" );
await finger( c, ROW( LU ) );
ok( await c.until( `NayiveChat.S.open === ${JSON.stringify( LU )} && document.getElementById( 'chat' ).classList.contains( 'in-main' )` ), "a tap opens the chat" );
await c.evaluate( "NayiveChat.back(); true" );
ok( await c.until( "! document.getElementById( 'chat' ).classList.contains( 'in-main' )" ), "back to the list" );
await sleep( 300 );
await finger( c, ROW( CA ), 700 );
ok( await c.until( `NayiveChat.browse.ids().join() === ${JSON.stringify( CA )}` ) && await c.evaluate( "document.getElementById( 'rows' ).classList.contains( 'is-picking' ) && ! document.getElementById( 'chat' ).classList.contains( 'in-main' )" ),
    "a long-press picks (ticks on), it does not open" );
ok( await c.evaluate( "[ ...document.querySelectorAll('#selActions [data-sel-act]') ].map( b => b.dataset.selAct ).join() === 'pin,mute,del' && getComputedStyle( document.querySelector( '#listHead .tb-group:not(.sel-group)' ) ).display === 'none'" ),
    "phone header: × count, Select all, Pin, Mute, Delete, ⋮; the tools step aside",
    await c.evaluate( "[ [ ...document.querySelectorAll('#selActions [data-sel-act]') ].map( b => b.dataset.selAct ).join(), getComputedStyle( document.querySelector( '#listHead .tb-group:not(.sel-group)' ) ).display ]" ) );
await finger( c, ROW( LU ) );
ok( await sel() === CA + "," + LU && ! await opened(), "while picking, a tap adds", await sel() );
await finger( c, "#selActions [data-sel=clear]" );
ok( await c.until( "NayiveChat.browse.ids().length === 0 && ! document.getElementById( 'rows' ).classList.contains( 'is-picking' )" ), "the × stops picking" );

const errs = c.logs.filter( l => /EXCEPTION/.test( l ) );
ok( ! errs.length, "no page exceptions", errs );
await done( c, s );
