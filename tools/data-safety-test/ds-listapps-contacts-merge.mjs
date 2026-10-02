// ds-listapps-contacts-merge.mjs - Contacts' merge on a 412 (mergeBook in
// contact/index.html), under Node with the real store.js and vcard.js.
//
// H2 (list-apps #14, #17): a card changed on BOTH devices is merged field by
// field against its base copy - a phone added here and an e-mail added there
// both stay; the picture Chat put on a card (server-side, REV unchanged)
// survives an edit of that card on a page that had not re-read it; phones /
// e-mails merge by value. With no base copy, the newer REV still wins whole.
import { ok, section, done } from "./lib.mjs";
import { appFns, loadStore, loadVcard } from "./listapps-fns.mjs";

const S = loadStore(), V = loadVcard();
const F = "data/contacts.vcf", META = "data/contacts-meta.json";
const { mergeBook } = appFns( "client/apps/contact/index.html", [ "mergeBook", "mergeCard?", "cardItems?", "revKey" ], {
    NayiveStore: S, META_FILE: META, dismissKey: ( a, b ) => [ a, b ].sort().join( " " ), vcfCards: V.cards,
    contentLines: V.contentLines, splitOnce: V.splitOnce, splitOutsideQuotes: V.splitOutsideQuotes,
    decodeValue: V.decodeValue, parseParams: V.parseParams, unescapeText: V.unescapeText } );

const card = ( uid, fn, extra, rev ) => [ "BEGIN:VCARD", "VERSION:3.0", ...( uid ? [ "UID:" + uid ] : [] ), "FN:" + fn,
                                          ...( extra || [] ), ...( rev ? [ "REV:" + rev ] : [] ), "END:VCARD" ].join( "\r\n" );
const book = ( ...cs ) => cs.join( "\r\n" ) + "\r\n";
// uid -> the card's text, of a merged book.
const cards = r => r == null ? null : Object.fromEntries( ( V.cards( r ) || [] ).map( c => [ c.uid, c.text ] ) );
const has = ( txt, re ) => !! txt && re.test( txt );
const count = ( txt, re ) => ( ( txt || "" ).match( re ) || [] ).length;

section( "H2 · ONE CARD, TWO DEVICES, DIFFERENT FIELDS" );
{
    const A = card( "a", "Ana" );
    const r = cards( mergeBook( F, book( A ), book( card( "a", "Ana", [ "TEL:111" ], "20261001T100000Z" ) ),
                                              book( card( "a", "Ana", [ "EMAIL:x@y.es" ], "20261001T100500Z" ) ) ) );
    ok( has( r && r.a, /TEL:111/ ) && has( r.a, /EMAIL:x@y\.es/ ), "a phone here (older) + an e-mail there (newer): both", r && r.a );
    ok( r && count( r.a, /^REV:/mg ) === 1 && has( r.a, /REV:20261001T100500Z/ ), "one REV, the newer" );
    const r2 = cards( mergeBook( F, book( A ), book( card( "a", "Ana", [ "TEL:111" ], "20261001T101000Z" ) ),
                                               book( card( "a", "Ana", [ "EMAIL:x@y.es" ], "20261001T100500Z" ) ) ) );
    ok( has( r2 && r2.a, /TEL:111/ ) && has( r2.a, /EMAIL:x@y\.es/ ), "a phone here (newer) + an e-mail there (older): both", r2 && r2.a );
}
{
    // What setCardPhoto writes (vcard_photo.go: PHOTO before END, REV untouched) vs the app adding an e-mail.
    const base   = book( "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p1\r\nFN:Pepe\r\nREV:20260901T100000Z\r\nEND:VCARD" );
    const theirs = book( "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p1\r\nFN:Pepe\r\nREV:20260901T100000Z\r\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD\r\nEND:VCARD" );
    const mine   = book( "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p1\r\nFN:Pepe\r\nEMAIL;TYPE=HOME:pepe@x.es\r\nREV:20261002T090000Z\r\nEND:VCARD" );
    const r = cards( mergeBook( F, base, mine, theirs ) );
    ok( has( r && r.p1, /PHOTO;ENCODING=b;TYPE=JPEG:\/9j\// ) && has( r.p1, /EMAIL;TYPE=HOME:pepe@x\.es/ ), "Chat's picture + an e-mail added in Contacts: both", r && r.p1 );
}
{
    const A = card( "a", "Ana", [ "NOTE:old" ] );
    const r = cards( mergeBook( F, book( A ), book( card( "a", "Ana mine", [ "NOTE:old" ], "20261001T100000Z" ) ),
                                              book( card( "a", "Ana theirs", [ "NOTE:new" ], "20261001T110000Z" ) ) ) );
    ok( has( r && r.a, /FN:Ana theirs/ ) && has( r.a, /NOTE:new/ ), "the same field on both: the newer REV's", r && r.a );
    const r2 = cards( mergeBook( F, book( A ), book( card( "a", "Ana mine", [ "NOTE:old" ] ) ), book( card( "a", "Ana theirs", [ "NOTE:new" ] ) ) ) );
    ok( has( r2 && r2.a, /FN:Ana mine/ ) && has( r2.a, /NOTE:new/ ), "...no REV on either: mine for that field, theirs' other edit kept", r2 && r2.a );
}

section( "H2 · PHONES AND E-MAILS BY VALUE" );
{
    const A = card( "a", "Ana", [ "TEL;TYPE=CELL:600 111 222", "EMAIL;TYPE=HOME:a@x.es" ] );
    const r = cards( mergeBook( F, book( A ),
        book( card( "a", "Ana", [ "TEL;TYPE=CELL:600 111 222", "TEL;TYPE=WORK:91 000", "EMAIL;TYPE=HOME:a@x.es" ], "20261001T100000Z" ) ),
        book( card( "a", "Ana", [ "TEL;TYPE=CELL:600 111 222", "TEL;TYPE=HOME:93 000", "EMAIL;TYPE=HOME:a@x.es" ], "20261001T110000Z" ) ) ) );
    ok( count( r && r.a, /^TEL/mg ) === 3, "a phone added on each side: both (three phones)", r && r.a );
    const r2 = cards( mergeBook( F, book( A ),
        book( card( "a", "Ana", [ "TEL;TYPE=CELL:600 111 222", "TEL;TYPE=WORK:91 000", "EMAIL;TYPE=HOME:a@x.es" ], "20261001T100000Z" ) ),
        book( card( "a", "Ana", [ "TEL;TYPE=CELL:600111222", "TEL;TYPE=WORK:91000", "EMAIL;TYPE=HOME:a@x.es" ], "20261001T110000Z" ) ) ) );
    ok( count( r2 && r2.a, /^TEL/mg ) === 2, "the same phone added on both (spaces apart): once", r2 && r2.a );
    const r3 = cards( mergeBook( F, book( A ),
        book( card( "a", "Ana", [ "EMAIL;TYPE=HOME:a@x.es" ], "20261001T100000Z" ) ),
        book( card( "a", "Ana", [ "TEL;TYPE=CELL:600 111 222", "EMAIL;TYPE=WORK:a@x.es", "NOTE:hi" ], "20261001T110000Z" ) ) ) );
    ok( r3 && ! has( r3.a, /^TEL/m ) && has( r3.a, /EMAIL;TYPE=WORK:a@x\.es/ ) && has( r3.a, /NOTE:hi/ ),
        "a phone removed here, the e-mail's type changed there + a note: all three", r3 && r3.a );
}
{
    // An iPhone card: item1.TEL + its label are one item.
    const A = card( "a", "Ana", [ "item1.TEL:600", "item1.X-ABLabel:Casa" ] );
    const r = cards( mergeBook( F, book( A ), book( card( "a", "Ana", [ "item1.TEL:600", "item1.X-ABLabel:Casa", "NOTE:n" ], "20261001T100000Z" ) ),
                                              book( card( "a", "Ana", [ "item1.TEL:600", "item1.X-ABLabel:Piso", "item2.EMAIL:e@x.es", "item2.X-ABLabel:Mío" ], "20261001T110000Z" ) ) ) );
    ok( has( r && r.a, /item1\.X-ABLabel:Piso/ ) && has( r.a, /item2\.EMAIL:e@x\.es/ ) && has( r.a, /NOTE:n/ ) && count( r.a, /X-ABLabel/g ) === 2,
        "a label changed + a labelled e-mail there, a note here: all kept", r && r.a );
    const r2 = cards( mergeBook( F, book( A ), book( card( "a", "Ana", [ "item1.TEL:600", "item1.X-ABLabel:Casa", "item2.URL:http://m.es", "item2.X-ABLabel:web" ], "20261001T100000Z" ) ),
                                               book( card( "a", "Ana", [ "item1.TEL:600", "item1.X-ABLabel:Casa", "item2.EMAIL:e@x.es", "item2.X-ABLabel:Mío" ], "20261001T110000Z" ) ) ) );
    ok( has( r2 && r2.a, /item2\.URL:http:\/\/m\.es/ ) && has( r2.a, /item3\.EMAIL:e@x\.es/ ) && has( r2.a, /item3\.X-ABLabel:Mío/ ),
        "both sides added an \"item2\": theirs is renumbered, no label crosses over", r2 && r2.a );
}

section( "UNCHANGED RULES" );
{
    const A = card( "a", "Ana" ), B = card( "b", "Beto" );
    const r = cards( mergeBook( F, book( A ), book( A, card( "m1", "Mine" ) ), book( A, card( "t1", "Theirs" ) ) ) );
    ok( r && r.m1 && r.t1 && r.a, "both add: both kept" );
    const r2 = cards( mergeBook( F, book( A, B ), book( A ), book( A, B ) ) );
    ok( r2 && ! r2.b, "deleted here, untouched there: gone" );
    const r3 = cards( mergeBook( F, book( A, B ), book( A ), book( A, card( "b", "Beto", [ "TEL:600" ], "20261001T100000Z" ) ) ) );
    ok( has( r3 && r3.b, /TEL:600/ ), "deleted here, changed there: kept" );
    const r4 = cards( mergeBook( F, null, book( card( "a", "Ana", [ "TEL:111" ] ) ), book( card( "a", "Ana", [ "TEL:222" ] ) ) ) );
    ok( has( r4 && r4.a, /TEL:222/ ) && ! has( r4.a, /TEL:111/ ), "no base: theirs whole (as before)" );
    const r5 = cards( mergeBook( F, null, book( card( "a", "Ana", [ "TEL:111" ], "20261001T110000Z" ) ), book( card( "a", "Ana", [ "TEL:222" ], "20261001T100000Z" ) ) ) );
    ok( has( r5 && r5.a, /TEL:111/ ) && ! has( r5.a, /TEL:222/ ), "no base: the newer REV whole (as before)" );
    ok( mergeBook( F, book( A ), book( A ), "hello" ) === null, "theirs is not an address book: no merge" );
    const m = mergeBook( META, JSON.stringify( { notDuplicate: [ [ "a", "b" ] ] } ), JSON.stringify( { notDuplicate: [ [ "a", "b" ], [ "a", "c" ] ] } ),
                               JSON.stringify( { notDuplicate: [ [ "a", "b" ], [ "b", "c" ] ] } ) );
    ok( m && JSON.parse( m ).notDuplicate.length === 3, "\"not duplicates\" marks: a set" );
}

await done();
