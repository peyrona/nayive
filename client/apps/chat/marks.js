/*
 * marks.js - a message's text marks, WhatsApp's: *bold*, _italic_, ~strike~,
 * and lines starting with "- " as a bullet list. Text work only, no page:
 * conv.js draws it (C.textNodes), C.preview strips it for one-line places.
 * The server strips it the same way for notifications (chat_marks.go).
 * Messages stay plain text; only the screen shows the marks.
 * Test: node tools/chat-test/marks.test.mjs
 */
( function ()
{
    "use strict";

    var URL_RE  = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/gi;
    var TAGS    = { "*": "b", "_": "i", "~": "s" };
    var ITEM_RE = /^[ \t]*- /;
    var WORD_RE = /[\p{L}\p{N}]/u;
    var TAIL_RE = /[*_~.,;:!?)\]'"]/;
    // Only a text's first characters are stripped (SS1): the scan is slow on
    // a long text packed with marks and links, and one-line places clip far
    // shorter anyway. chat_marks.go's marksMax is the same.
    var MAX     = 600;

    function isWord( c )  { return !! c && WORD_RE.test( c ); }
    function isSpace( c ) { return !! c && /\s/.test( c ); }

    // The links of a line, [a, b) each. A link never ends in a mark, so in
    // "*see https://x.com*" the last * still closes the bold.
    function links( s )
    {
        var out = [], m;
        URL_RE.lastIndex = 0;
        while( ( m = URL_RE.exec( s ) ) )
        {
            var end = m.index + m[ 0 ].length;
            while( end > m.index && TAIL_RE.test( s.charAt( end - 1 ) ) ) end--;
            if( end - m.index > 8 ) out.push( { a: m.index, b: end } );
        }
        return out;
    }

    function linkAt( L, i )
    {
        for( var n = 0; n < L.length; n++ ) if( L[ n ].a <= i && i < L[ n ].b ) return L[ n ];
        return null;
    }

    // Where the mark at s[i] closes (before `b`), or -1. A mark opens at a
    // word edge (line start, space or punctuation before it) with no space
    // after it, and closes the same way round, so "file_name_v2", "2*3*4"
    // and "* x *" stay as typed. A doubled mark ("**") is never one.
    function closer( s, i, b, L )
    {
        var c = s.charAt( i ), next = s.charAt( i + 1 );
        if( isWord( s.charAt( i - 1 ) ) || i + 1 >= b || isSpace( next ) || next === c ) return -1;
        for( var j = i + 2; j < b; j++ )
        {
            var k = linkAt( L, j );
            if( k ) { j = k.b - 1; continue; }
            if( s.charAt( j ) !== c ) continue;
            var before = s.charAt( j - 1 );
            if( ! isSpace( before ) && before !== c && ! isWord( s.charAt( j + 1 ) ) ) return j;
        }
        return -1;
    }

    // s[a, b) as runs: { t: "text", a, b } or { t: "b"|"i"|"s", kids }.
    // Marks never open or close inside a link.
    function inline( s, a, b, L )
    {
        var out = [], start = a, i = a;
        while( i < b )
        {
            var k = linkAt( L, i );
            if( k ) { i = k.b; continue; }
            var j = TAGS[ s.charAt( i ) ] ? closer( s, i, b, L ) : -1;
            if( j < 0 ) { i++; continue; }
            if( i > start ) out.push( { t: "text", a: start, b: i } );
            out.push( { t: TAGS[ s.charAt( i ) ], kids: inline( s, i + 1, j, L ) } );
            i = start = j + 1;
        }
        if( b > start ) out.push( { t: "text", a: start, b: b } );
        return out;
    }

    // The text as blocks: lines in a row that are all "- " items make one
    // list; the others stay text. Each line: { s, links, runs }.
    function parse( text )
    {
        var out = [], cur = null;
        String( text || "" ).split( "\n" ).forEach( function ( s )
        {
            var m = ITEM_RE.exec( s ), list = !! m, L = links( s );
            if( ! cur || cur.list !== list ) out.push( cur = { list: list, lines: [] } );
            cur.lines.push( { s: s, links: L, runs: inline( s, m ? m[ 0 ].length : 0, s.length, L ) } );
        } );
        return out;
    }

    function flat( s, runs )
    {
        return runs.map( function ( r ) { return r.t === "text" ? s.slice( r.a, r.b ) : flat( s, r.kids ); } ).join( "" );
    }

    // The words without their marks, for one-line places: "*hi*" -> "hi",
    // "- a" / "- b" -> "• a" / "• b". Only the first MAX characters.
    function strip( text )
    {
        var lines = [];
        text = String( text || "" );
        if( text.length > MAX ) text = Array.from( text ).slice( 0, MAX ).join( "" );
        parse( text ).forEach( function ( bl )
        {
            bl.lines.forEach( function ( ln ) { lines.push( ( bl.list ? "• " : "" ) + flat( ln.s, ln.runs ) ); } );
        } );
        return lines.join( "\n" );
    }

    // The links in a text, as written (the chat's "Links" list).
    function urls( text )
    {
        text = String( text || "" );
        return links( text ).map( function ( k ) { return text.slice( k.a, k.b ); } );
    }

    window.NayiveChatMarks = { parse: parse, strip: strip, urls: urls, ITEM_RE: ITEM_RE };
} )();
