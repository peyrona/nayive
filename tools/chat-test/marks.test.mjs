/*
 * marks.test.mjs - Chat's text marks (client/apps/chat/marks.js) on their
 * own, no browser: node tools/chat-test/marks.test.mjs
 * The strip cases are the same as server/go/chat_marks_test.go's.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const src  = fs.readFileSync( path.join( here, "../../client/apps/chat/marks.js" ), "utf8" );
const ctx  = { window: {} };
vm.runInNewContext( src, ctx );
const M = ctx.window.NayiveChatMarks;

let fails = 0, passes = 0;
function check( name, got, want )
{
    if( got === want ) passes++;
    else { fails++; console.log( "FAIL " + name + "\n  got:  " + JSON.stringify( got ) + "\n  want: " + JSON.stringify( want ) ); }
}

// The bubble as HTML-ish text: what C.textNodes builds.
function show( text )
{
    function runs( ln, rs )
    {
        return rs.map( r =>
        {
            if( r.t !== "text" ) return "<" + r.t + ">" + runs( ln, r.kids ) + "</" + r.t + ">";
            let out = "", at = r.a;
            for( const k of ln.links )
            {
                if( k.a < r.a || k.b > r.b ) continue;
                out += ln.s.slice( at, k.a ) + "<a>" + ln.s.slice( k.a, k.b ) + "</a>";
                at = k.b;
            }
            return out + ln.s.slice( at, r.b );
        } ).join( "" );
    }
    return M.parse( text ).map( bl => bl.list
        ? "<ul>" + bl.lines.map( ln => "<li>" + runs( ln, ln.runs ) + "</li>" ).join( "" ) + "</ul>"
        : bl.lines.map( ln => runs( ln, ln.runs ) ).join( "\n" ) ).join( "" );
}

const SHOW = [
    [ "*bold*",                       "<b>bold</b>" ],
    [ "_it_ and ~gone~",              "<i>it</i> and <s>gone</s>" ],
    [ "a*b*c",                        "a*b*c" ],
    [ "2*3*4",                        "2*3*4" ],
    [ "file_name_v2",                 "file_name_v2" ],
    [ "*bold _both_*",                "<b>bold <i>both</i></b>" ],
    [ "*_both_*",                     "<b><i>both</i></b>" ],
    [ "*open only",                   "*open only" ],
    [ "**",                           "**" ],
    [ "* x *",                        "* x *" ],
    [ "*a\nb*",                       "*a\nb*" ],
    [ "(*hi*)!",                      "(<b>hi</b>)!" ],
    [ "**bold**",                     "*<b>bold</b>*" ],
    [ "*see https://x.com/a_b_*",     "<b>see <a>https://x.com/a_b</a>_</b>" ],
    [ "*see https://x.com*",          "<b>see <a>https://x.com</a></b>" ],
    [ "go https://x.com/_p_/q now",   "go <a>https://x.com/_p_/q</a> now" ],
    [ "*😀*",                         "<b>😀</b>" ],
    [ "*😀 hola*",                    "<b>😀 hola</b>" ],
    [ "- a\n- b\ntext\n- c",          "<ul><li>a</li><li>b</li></ul>text<ul><li>c</li></ul>" ],
    [ "-5 °C",                        "-5 °C" ],
    [ "a - b",                        "a - b" ],
    [ "  - indented",                 "<ul><li>indented</li></ul>" ],
    [ "- *bold item*",                "<ul><li><b>bold item</b></li></ul>" ],
    [ "- one\n- two",                 "<ul><li>one</li><li>two</li></ul>" ],
    [ "Buy:\n- milk\n- eggs\nThanks", "Buy:<ul><li>milk</li><li>eggs</li></ul>Thanks" ],
    [ "\n- after a file",             "<ul><li>after a file</li></ul>" ],
    [ "",                             "" ],
];
for( const [ input, want ] of SHOW ) check( "show " + JSON.stringify( input ), show( input ), want );

const STRIP = JSON.parse( fs.readFileSync( path.join( here, "strip-cases.json" ), "utf8" ) );
for( const [ input, want ] of STRIP ) check( "strip " + JSON.stringify( input ), M.strip( input ), want );

// SS1: a long text packed with marks and links is stripped on its first 600
// characters only (chat_marks.go's marksMax), counted as the server counts:
// an emoji is one.
const LONG = "😀" + " *x".repeat( 800 ) + " http://ab".repeat( 160 );
check( "strip a long text: its first 600", M.strip( LONG ), M.strip( Array.from( LONG ).slice( 0, 600 ).join( "" ) ) );
check( "strip a long text: at most 600", Array.from( M.strip( LONG ) ).length <= 600, true );
check( "strip 600 with an emoji: whole", M.strip( "😀" + "a".repeat( 599 ) ), "😀" + "a".repeat( 599 ) );

console.log( ( fails ? "FAILED " : "ok " ) + passes + " passed, " + fails + " failed" );
process.exit( fails ? 1 : 0 );
