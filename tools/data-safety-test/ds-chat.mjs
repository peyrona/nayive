// ds-chat.mjs - Chat: a message sent with no network is never lost
// (data-safety J2), and the words being written in a chat stay with that
// chat (J3). The owner ("test") writes to two people of their own, Carmen and
// Javi (a person needs no account: the owner's side is the one that writes).
import { server, browser, ok, section, done } from "./lib.mjs";

const s = await server();
const phone = await s.client();       // the owner on another device: the server's view
const person = async name => JSON.parse( ( await phone.post( "/api/chat/contacts", JSON.stringify( { name } ),
                                                             { "Content-Type": "application/json" } ) ).text );
const CA = "d-" + ( await person( "Carmen" ) ).id;
const javi = await person( "Javi" );
const JA = "d-" + javi.id;
const onServer = async conv => ( JSON.parse( ( await phone.call( "GET", "/api/chat/conv/" + conv + "/messages" ) ).text ).msgs || [] )
                                   .filter( m => ! m.deleted ).map( m => m.text );

const c = await browser( s, { lang: "es" } );
await c.evaluate( "localStorage.setItem( 'balata-intro-dismiss:chat', '1' ); true" );
// A network that refuses only the sends (POST .../messages), on every load
// while localStorage "ds-fail-send" is "1": a reload with the network still
// failing (offline emulation would stop the page itself from loading).
await c.send( "Page.addScriptToEvaluateOnNewDocument", { source: `( () => { const f = window.fetch; window.fetch = function ( u, o ) {
    try { if( localStorage.getItem( 'ds-fail-send' ) === '1' && o && o.method === 'POST' && /\\/messages$/.test( String( u ) ) )
              return Promise.reject( new TypeError( 'Failed to fetch' ) ); } catch( e ) {}
    return f.apply( this, arguments ); }; } )()` } );

const PAGE = "/nayive/chat/index.html";
const load = async () => { await c.open( PAGE ); return c.until( `document.querySelector( '[data-conv="${CA}"]' )` ); };
const openChat = async id => { await c.evaluate( `document.querySelector( '[data-conv="${id}"]' ).click(); true` );
                               return c.until( `NayiveChat.S.open === ${JSON.stringify( id )} && ! document.getElementById( 'vConv' ).hidden` ); };
const box = () => c.evaluate( "document.querySelector( '#composer textarea' ).value" );
const write = text => c.evaluate( `( () => { const t = document.querySelector( '#composer textarea' ); t.value = ${JSON.stringify( text )};
    t.dispatchEvent( new InputEvent( 'input', { inputType: 'insertText' } ) ); return true; } )()` );
const send = () => c.evaluate( "document.querySelector( '#composer .send' ).click(); true" );
const bubble = text => `[ ...document.querySelectorAll( '#wall .msg.out' ) ].find( b => b.textContent.includes( ${JSON.stringify( text )} ) )`;
const rowText = id => c.evaluate( `( document.querySelector( '[data-conv="${id}"] .prev' ) || {} ).textContent || ''` );
// what waits in the outbox (IndexedDB "nayive-drafts", "chat:<cid>"): the texts
const OUTBOX = `new Promise( r => { const q = indexedDB.open( 'nayive-drafts', 1 );
    q.onupgradeneeded = () => q.result.createObjectStore( 'drafts', { keyPath: 'app' } );
    q.onsuccess = () => { const g = q.result.transaction( 'drafts' ).objectStore( 'drafts' ).getAll();
        g.onsuccess = () => { r( g.result.filter( x => String( x.app ).startsWith( 'chat:' ) ).map( x => x.body && x.body.text ) ); q.result.close(); }; };
    q.onerror = () => r( [ 'idb-error' ] ); } )`;
// c.until() takes its expression as a plain value (a promise would count as
// true at once): this one waits for what a promise answers
const settles = async ( expr, ms = 15000 ) =>
{
    const end = Date.now() + ms;
    while( Date.now() < end ) { try { if( await c.evaluate( expr ) ) return true; } catch {} await new Promise( r => setTimeout( r, 100 ) ); }
    return false;
};
const net = offline => c.send( "Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } );

ok( await load(), "Chat opens with the two people" );

section( "J2 - SENT WITH NO NETWORK: KEPT UNTIL THE SERVER HAS IT" );
ok( await openChat( CA ), "Carmen's chat opens" );
await net( true );
await write( "hola sin red" );
await send();
ok( await c.until( bubble( "hola sin red" ) + "?.classList.contains( 'failed' )" ), "no network: the bubble says it failed" );
ok( ( await c.evaluate( OUTBOX ) ).includes( "hola sin red" ), "…and the message waits on this device (outbox)", await c.evaluate( OUTBOX ) );
ok( await openChat( JA ) && await openChat( CA ), "another chat, and back" );
ok( await c.until( bubble( "hola sin red" ), 5000 ), "leaving the chat did not lose it: its bubble is back", await c.evaluate( "document.getElementById( 'wall' ).textContent" ) );
ok( ( await rowText( CA ) ).includes( "hola sin red" ), "the list shows it waiting in Carmen's row", await rowText( CA ) );
// The network comes back. Chrome's emulation may tell the page "online" a
// moment before its requests work again (on a loaded machine), and the try
// the page makes at that moment then fails - a quirk of the emulation, not of
// a real network, and the test failed now and then. So the network comes
// back with the sends still refused (the switch above), and the page hears
// "online" again once they work: the event the app sends by.
await c.evaluate( "localStorage.setItem( 'ds-fail-send', '1' ); true" );
await net( false );
ok( await c.until( "navigator.onLine" ), "the page sees the network back" );
await c.evaluate( "localStorage.removeItem( 'ds-fail-send' ); window.dispatchEvent( new Event( 'online' ) ); true" );
let sent = false;
for( const end = Date.now() + 30000; ! sent && Date.now() < end; ) { sent = ( await onServer( CA ) ).includes( "hola sin red" ); if( ! sent ) await new Promise( r => setTimeout( r, 200 ) ); }
ok( sent, "the network back: it goes by itself", await c.evaluate( OUTBOX ) );
ok( ( await onServer( CA ) ).filter( t => t === "hola sin red" ).length === 1, "…once", await onServer( CA ) );
ok( await c.until( `${bubble( "hola sin red" )} && ! ${bubble( "hola sin red" )}.classList.contains( 'failed' )` ), "…and its bubble is a sent one" );
ok( await settles( OUTBOX + ".then( l => ! l.length )" ), "the outbox is empty" );

section( "J2 - A RELOAD WHILE IT CANNOT GO" );
await c.evaluate( "localStorage.setItem( 'ds-fail-send', '1' ); true" );
await write( "tras recargar" );
await send();
ok( await c.until( bubble( "tras recargar" ) + "?.classList.contains( 'failed' )" ), "the send fails" );
ok( await load(), "the page loads again (the sends still failing)" );
ok( await c.until( `( document.querySelector( '[data-conv="${CA}"] .prev' ) || {} ).textContent?.includes( 'tras recargar' )`, 8000 ),
    "after the reload the list still shows it waiting", await rowText( CA ) );
ok( await openChat( CA ) && await c.until( bubble( "tras recargar" ), 8000 ), "…and so does the chat" );
ok( ! ( await onServer( CA ) ).includes( "tras recargar" ), "(the server does not have it yet)" );
await c.evaluate( "localStorage.removeItem( 'ds-fail-send' ); true" );
ok( await load(), "the next load, the network working" );
sent = false;
for( let i = 0; i < 100 && ! sent; i++ ) { sent = ( await onServer( CA ) ).includes( "tras recargar" ); if( ! sent ) await new Promise( r => setTimeout( r, 100 ) ); }
ok( sent, "that load sends it" );
ok( ( await onServer( CA ) ).filter( t => t === "tras recargar" ).length === 1, "…once", await onServer( CA ) );
ok( await settles( OUTBOX + ".then( l => ! l.length )" ), "the outbox is empty again" );

section( "J2 - ONE THAT CANNOT GO HAS A WAY OUT" );
await c.evaluate( "localStorage.setItem( 'ds-fail-send', '1' ); true" );
ok( await openChat( CA ), "Carmen's chat" );
await write( "para borrar" );
await send();
ok( await c.until( bubble( "para borrar" ) + "?.classList.contains( 'failed' )" ), "a send that fails" );
await c.evaluate( `NayiveChat.openCtx( [ ...NayiveChat.S.msgs.values() ].find( m => m.text === 'para borrar' ) ); true` );
const items = await c.evaluate( "[ ...document.querySelectorAll( '.ctx .menu-item' ) ].map( b => b.textContent.trim() )" );
ok( items.join( "|" ) === "Reintentar|Copiar|Eliminar", "its menu: try again, copy, delete", items );
await c.evaluate( "[ ...document.querySelectorAll( '.ctx .menu-item' ) ].pop().click(); true" );
ok( await c.until( `! ${bubble( "para borrar" )}` ), "Delete takes its bubble away" );
await c.evaluate( "NayiveUI.undoSettle(); true" );
ok( await settles( OUTBOX + ".then( l => ! l.includes( 'para borrar' ) )" ), "…and, the Undo gone, it leaves the outbox" );
await c.evaluate( "localStorage.removeItem( 'ds-fail-send' ); true" );

section( "J3 - THE WORDS BEING WRITTEN STAY WITH THEIR CHAT" );
ok( await openChat( CA ), "Carmen's chat" );
await write( "borrador a medias" );
ok( await openChat( JA ), "Javi's chat opens (a click in the list)" );
ok( await box() === "", "Javi's box is empty", await box() );
ok( await openChat( CA ) && await box() === "borrador a medias", "back in Carmen's: the words are there", await box() );
await c.evaluate( `NayiveChat.openConv( ${JSON.stringify( JA )} ); true` );        // what a notification tapped does (chat.js)
ok( await c.until( `NayiveChat.S.open === ${JSON.stringify( JA )}` ) && await openChat( CA ) && await box() === "borrador a medias",
    "a notification opening another chat keeps them too", await box() );
await c.evaluate( `NayiveChat.S.shared = 'https://youtu.be/x'; NayiveChat.openConv( ${JSON.stringify( CA )} ); true` );   // a shared link (chat.js ?text=)
ok( await c.until( "document.querySelector( '#composer textarea' ).value.includes( 'youtu.be' )" ) &&
    await box() === "borrador a medias https://youtu.be/x", "a shared link goes after them, never over them", await box() );
await write( "borrador a medias" );
ok( await load() && await openChat( CA ) && await c.until( "document.querySelector( '#composer textarea' ).value === 'borrador a medias'", 5000 ),
    "after a reload they come back", await box() );

section( "J3 - AN EDIT IN PROGRESS" );
// a message of the owner's own, from another device (this section does not
// lean on the ones above)
await phone.post( "/api/chat/conv/" + CA + "/messages", JSON.stringify( { kind: "text", text: "para editar", cid: "ds-edit-1" } ),
                  { "Content-Type": "application/json" } );
ok( await load() && await openChat( CA ) && await c.until( bubble( "para editar" ) ), "a message of mine to edit" );
await c.evaluate( "( m => m && NayiveChat.editMsg( m ) )( [ ...NayiveChat.S.msgs.values() ].find( m => m.text === 'para editar' && m.id > 0 ) ); true" );
await write( "ya editado" );
ok( await openChat( JA ) && await openChat( CA ), "another chat, and back" );
const EDITING = "!! NayiveChat.S.editing && NayiveChat.S.editing.text === 'para editar' && document.querySelector( '#composer textarea' ).value === 'ya editado'";
ok( await c.until( EDITING, 5000 ), "still editing that message, with the new words",
    await c.evaluate( "[ NayiveChat.S.editing && NayiveChat.S.editing.text, document.querySelector( '#composer textarea' ).value ]" ) );
ok( await load() && await openChat( CA ) && await c.until( EDITING, 8000 ), "…also after a reload" );
await send();
let edited = false;
for( let i = 0; i < 100 && ! edited; i++ ) { edited = ( await onServer( CA ) ).includes( "ya editado" ); if( ! edited ) await new Promise( r => setTimeout( r, 100 ) ); }
ok( edited, "Send: the message is edited on the server", await onServer( CA ) );
ok( await box() === "", "the box is empty" );
ok( await load() && await openChat( CA ) && ( await box() ) === "", "sent: after a reload nothing comes back", await box() );

section( "J2 - A CHAT THAT IS GONE: ITS WAITING MESSAGE IS KEPT, AND SAID (review round 2)" );
await c.evaluate( "localStorage.setItem( 'ds-fail-send', '1' ); true" );
ok( await openChat( JA ), "Javi's chat" );
await write( "para nadie" );
await send();
ok( await c.until( bubble( "para nadie" ) + "?.classList.contains( 'failed' )" ) && ( await c.evaluate( OUTBOX ) ).includes( "para nadie" ),
    "a message waits in the outbox" );
const gone = await phone.del( "/api/chat/contacts/" + javi.id );
ok( gone.status < 300, "Javi is deleted on another device", gone.status );
await c.evaluate( "localStorage.removeItem( 'ds-fail-send' ); true" );
ok( await load(), "the page loads again" );
ok( await c.until( "( window.__toasts || [] ).concat( document.getElementById( 'toast' ).textContent ).some( t => /chat que ya no está: 1/.test( t ) )", 10000 ),
    "a toast says one waits for a chat that is gone", await c.evaluate( "document.getElementById( 'toast' ).textContent" ) );
await new Promise( r => setTimeout( r, 1500 ) );    // the opening's own work (flush, list) has had its time
ok( ( await c.evaluate( OUTBOX ) ).includes( "para nadie" ), "the message is still kept (never thrown away)", await c.evaluate( OUTBOX ) );

await done( c, s );
