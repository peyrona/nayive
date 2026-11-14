// ds-contacts-fixes.mjs - the Contacts review fixes of 2026-11-14
// (docs/audit/contacts-bookmarks-2026-11-14.md) that change what reaches the
// address book, under Node with Contacts' REAL inline script and vcard.js.
//
// Q1: an Android (vCard 2.1) card with a long QUOTED-PRINTABLE line, edited
// here (the card becomes 3.0 and the line is re-folded), reads back as it was:
// a fold never lands right after a "=", and a 3.0 card's line that starts with
// a space is always a fold (so a card saved the old way reads right too).
// C5: a URL with an escaped ":" reads as the plain address; the line stays.
// C8: with no base copy, the newer REV wins even when the two REVs are
// written in the two forms ("2026-10-01T11:00:00Z" / "20261001T100000Z").
import { ok, section, done } from "./lib.mjs";
import { appFns, loadStore, loadVcard, read } from "./listapps-fns.mjs";

const V = loadVcard(), S = loadStore();

// Contacts' inline script, its DOM and Ayni stubbed (nothing runs at load but
// the declarations: init waits for Ayni.i18n.ready, which never comes here).
globalThis.window    = globalThis;
globalThis.AyniVCard = V;
globalThis.Ayni      = { i18n: { ready: { then() {} }, lang: () => "es" }, t: k => k, tf: k => k, hash: () => 1, isMac: false,
                         fold: s => String( s ).normalize( "NFD" ).replace( /[̀-ͯ]/g, "" ).toLowerCase() };
globalThis.AyniStore = { hashText: s => String( s.length ) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document  = { getElementById: () => null };
{
    const html = read( "client/apps/contact/index.html" );
    const i    = html.indexOf( "<script>", html.indexOf( 'formats/vcard.js"></script>' ) );
    ( 0, eval )( html.slice( i + 8, html.indexOf( "</script>", i ) ) +
                 "\n;globalThis.__ct = { vcfToContacts, contactToVCard, displayName };" );
}
const { vcfToContacts, contactToVCard, displayName } = globalThis.__ct;

// Android's QP: every byte but plain ASCII letters as =XX, soft breaks at 76.
const qp   = s => { let e = ""; for( const b of new TextEncoder().encode( s ) ) e += ( b < 128 && b !== 61 && b !== 32 && b !== 59 ) ? String.fromCharCode( b ) : "=" + b.toString( 16 ).toUpperCase().padStart( 2, "0" ); return e; };
const soft = ( head, enc ) => { const out = []; let cur = head; for( const ch of enc.match( /=[0-9A-F]{2}|./g ) ) { if( ( cur + ch ).length > 75 ) { out.push( cur + "=" ); cur = ""; } cur += ch; } out.push( cur ); return out; };
const addPhone = c => { c.tels = [ { type: "CELL", value: "600111222" }, { type: "WORK", value: "911222333" } ]; return c; };

section( "Q1 · A 2.1 QUOTED-PRINTABLE CARD, EDITED HERE" );
{
    let broken = 0;
    for( let pad = 0; pad < 24; pad++ )
    {
        const note = "x".repeat( pad ) + "Recoger en la calle Ñandú número 5, junto a la panadería de Begoña y José María";
        const card = [ "BEGIN:VCARD", "VERSION:2.1", "N:Lopez;Ana;;;", "FN:Ana Lopez", "TEL;CELL:600111222",
                       ...soft( "NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:", qp( note ) ), "END:VCARD", "" ].join( "\r\n" );
        const out  = contactToVCard( addPhone( vcfToContacts( card, [] )[ 0 ] ) );
        if( out.split( "\r\n" ).some( l => /=$/.test( l ) ) ) broken++;
        if( vcfToContacts( out + "\r\n", [] )[ 0 ].note !== note ) broken++;
    }
    ok( broken === 0, "a long QP note, a phone added: the note reads back as it was (24 lengths)", broken + " broken" );

    let names = 0;
    for( const name of [ "José María Pérez Martínez", "María José Núñez Álvarez de Toledo", "Begoña Íñiguez Ruiz-Peña",
                         "Ángel Muñoz Sáez del Río", "Inés Gómez-Pardo Ibáñez" ] )
    {
        const card = [ "BEGIN:VCARD", "VERSION:2.1", ...soft( "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:", qp( name ) ),
                       "TEL;CELL:600111222", "END:VCARD", "" ].join( "\r\n" );
        const back = vcfToContacts( contactToVCard( addPhone( vcfToContacts( card, [] )[ 0 ] ) ) + "\r\n", [] )[ 0 ];
        if( displayName( back ) !== name ) names++;
    }
    ok( names === 0, "a long QP name, a phone added: the name reads back as it was", names + " broken" );
}
{
    // A 3.0 card as the old code saved it: RFC-folded right after a "=".
    const enc  = qp( "Calle Ñandú, número 5 — España, " + "ñ".repeat( 30 ) );
    const head = "NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:";
    let   bad  = 0, tried = 0;
    for( let pad = 0; pad < 40; pad++ )
    {
        const text = head + "a".repeat( pad ) + enc;
        const cut  = text.indexOf( "=", 60 ) + 1;                // a fold right after this "="
        const card = [ "BEGIN:VCARD", "VERSION:3.0", text.slice( 0, cut ), " " + text.slice( cut ), "END:VCARD", "" ].join( "\r\n" );
        const cl   = V.contentLines( card ).find( l => /^NOTE/.test( l.text ) );
        tried++;
        if( cl.text !== text ) bad++;
    }
    ok( bad === 0, "a 3.0 card folded right after a \"=\" (saved the old way) reads right", bad + " of " + tried );

    const v21 = V.contentLines( "BEGIN:VCARD\r\nVERSION:2.1\r\nNOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:=C3=91and=\r\n=C3=BA lo=\r\nngo\r\nEND:VCARD" )
                 .find( l => /^NOTE/.test( l.text ) );
    ok( v21 && v21.text === "NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:=C3=91and=C3=BA longo", "a 2.1 card's soft breaks still join", v21 && v21.text );
}

section( "C5 · A URL WITH AN ESCAPED \":\"" );
{
    const src = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u\r\nFN:Web\r\nURL:http\\://www.example.com\r\nEND:VCARD\r\n";
    const c   = vcfToContacts( src, [] )[ 0 ];
    ok( c.urls[ 0 ] && c.urls[ 0 ].value === "http://www.example.com", "read as the plain address", c.urls[ 0 ] && c.urls[ 0 ].value );
    ok( contactToVCard( c ).includes( "URL:http\\://www.example.com" ), "an untouched card keeps its line as it was" );
}

section( "C8 · NO BASE COPY, REVS IN TWO FORMS" );
{
    const { mergeBook } = appFns( "client/apps/contact/index.html", [ "mergeBook", "mergeCard?", "cardItems?", "revKey" ], {
        AyniStore: S, META_FILE: "data/contacts-meta.json", dismissKey: ( a, b ) => [ a, b ].sort().join( " " ), vcfCards: V.cards,
        contentLines: V.contentLines, splitOnce: V.splitOnce, splitOutsideQuotes: V.splitOutsideQuotes,
        decodeValue: V.decodeValue, parseParams: V.parseParams, unescapeText: V.unescapeText } );
    const card = ( tel, rev ) => [ "BEGIN:VCARD", "VERSION:3.0", "UID:a", "FN:Ana", "TEL:" + tel, "REV:" + rev, "END:VCARD" ].join( "\r\n" ) + "\r\n";
    const r1 = mergeBook( "data/contacts.vcf", null, card( 111, "2026-10-01T11:00:00Z" ), card( 222, "20261001T100000Z" ) );
    ok( /TEL:111/.test( r1 ) && ! /TEL:222/.test( r1 ), "mine newer (extended form) wins", r1 );
    const r2 = mergeBook( "data/contacts.vcf", null, card( 111, "2026-10-01T09:00:00Z" ), card( 222, "20261001T100000Z" ) );
    ok( /TEL:222/.test( r2 ) && ! /TEL:111/.test( r2 ), "theirs newer (basic form) wins", r2 );
}

await done();
