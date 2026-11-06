/* Ayni library 0.2.0, writing: the marks of a short message, the emoji panel, emoticons that become emoji. Plain JavaScript, no build
   step, evergreen browsers 2024+. Optional, with ayni-compose.css. The clip's panel is Ayni.attachPanel (ayni-dialogs.js).
     Ayni.marks.parse(text), .strip(text), .urls(text): *bold*, _italic_, ~strike~ and lines starting with "- " as a bullet list. Text
       work only, no page. Messages stay plain text; only the screen shows the marks.
     Ayni.emojiPanel(pick): the panel, a node; pick(emoji) runs on a tap.
     Ayni.smileys(textarea): textarea() returns the box. input(event) on each input, undo() on a Backspace (true when it gave the
       emoticon back), tail(text) on Send. */
( function ()
{
    "use strict";

    var URL_RE  = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/gi;
    var TAGS    = { "*": "b", "_": "i", "~": "s" };
    var ITEM_RE = /^[ \t]*- /;
    var WORD_RE = /[\p{L}\p{N}]/u;
    var TAIL_RE = /[*_~.,;:!?)\]'"]/;
    // Only a text's first characters are stripped: the scan is slow on
    // a long text packed with marks and links, and one-line places clip far
    // shorter anyway. A server that strips marks should stop at the same place.
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

    // The links in a text, as written (a "Links" list).
    function urls( text )
    {
        text = String( text || "" );
        return links( text ).map( function ( k ) { return text.slice( k.a, k.b ); } );
    }

    var A = ( window.Ayni = window.Ayni || {} );
    A.marks = { parse: parse, strip: strip, urls: urls, ITEM_RE: ITEM_RE };

    // Emoticons become emoji as you write: ":-) " turns into "🙂 " once the
    // space (or a new line) after it is typed, and a trailing one on Send.
    // Only a whole word counts, so "http://x" or "a:)b" stay as they are.
    // A Backspace right after the swap gives the emoticon back.
    var SMILEYS = { ":)": "🙂", ":-)": "🙂", ":(": "🙁", ":-(": "🙁", ":D": "😃", ":-D": "😃",
                    ";)": "😉", ";-)": "😉", ":P": "😛", ":-P": "😛", ":p": "😛", ":-p": "😛",
                    ":O": "😮", ":-O": "😮", ":o": "😮", ":-o": "😮", ":'(": "😢", ":'-(": "😢",
                    ":*": "😘", ":-*": "😘", ":|": "😐", ":-|": "😐", ":/": "😕", ":-/": "😕",
                    "B-)": "😎", "8-)": "😎", "XD": "😆", "xD": "😆", ">:(": "😠", ">:-(": "😠",
                    "O:)": "😇", "O:-)": "😇", "^^": "😊", "^_^": "😊", "<3": "❤️", "</3": "💔" };
    A.smileys = function ( textarea )
    {
        var lastSwap = null;       // { at: caret after the swap, emoji, word }

        function input( e )
        {
            lastSwap = null;
            if( ! e || ! e.inputType || e.inputType.indexOf( "insert" ) !== 0 || e.inputType === "insertFromPaste" ) return;
            var ta = textarea(), pos = ta.selectionStart;
            if( pos !== ta.selectionEnd || pos < 2 || ! /\s/.test( ta.value.charAt( pos - 1 ) ) ) return;
            var m = /(^|\s)(\S+)$/.exec( ta.value.slice( 0, pos - 1 ) );
            if( ! m || ! SMILEYS[ m[ 2 ] ] ) return;
            var start = pos - 1 - m[ 2 ].length, emoji = SMILEYS[ m[ 2 ] ];
            ta.setRangeText( emoji, start, pos - 1, "end" );
            var at = start + emoji.length + 1;
            ta.setSelectionRange( at, at );
            lastSwap = { at: at, emoji: emoji, word: m[ 2 ] };
        }

        function undo()
        {
            var ta = textarea(), s = lastSwap;
            lastSwap = null;
            if( ! s || ta.selectionStart !== s.at || ta.selectionEnd !== s.at ) return false;
            var from = s.at - 1 - s.emoji.length;
            if( ta.value.slice( from, s.at - 1 ) !== s.emoji ) return false;
            ta.setRangeText( s.word, from, s.at - 1, "end" );
            ta.setSelectionRange( from + s.word.length + 1, from + s.word.length + 1 );
            return true;
        }

        function tail( text )
        {
            var m = /(^|\s)(\S+)$/.exec( text );
            return m && SMILEYS[ m[ 2 ] ] ? text.slice( 0, text.length - m[ 2 ].length ) + SMILEYS[ m[ 2 ] ] : text;
        }

        return { input: input, undo: undo, tail: tail };
    };

    var EMOJIS = ( "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😜 🤪 🤗 🤔 🤐 😐 😏 😒 🙄 😬 😌 😔 😴 😷 🤒 🥳 " +
                   "😎 🤓 😕 😟 😮 😲 😳 🥺 😢 😭 😱 😤 😡 👍 👎 👌 ✌️ 🤞 🤝 🙏 👏 🙌 💪 👋 ❤️ 🧡 💛 💚 💙 💜 " +
                   "🖤 💔 💯 ✨ 🔥 🎉 🎂 🎁 ☀️ 🌧️ ⛄ 🌹 🍷 🍺 ☕ 🍕 🚗 ✈️ 🏠 ⚽ 📷 ⏰ ✅ ❌ ❓ ❗" ).split( " " );

    A.emojiPanel = function ( pick )
    {
        var el = Ayni.h( "div", { class: "emojis" } );
        EMOJIS.forEach( function ( e )
        {
            el.appendChild( Ayni.h( "button", { attrs: { type: "button" }, text: e,
                                                on: { click: function ( ev ) { ev.stopPropagation(); pick( e ); } } } ) );
        } );
        return el;
    };
} )();
