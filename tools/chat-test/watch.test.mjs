/*
 * watch.test.mjs - "Play for everyone" (client/apps/chat/watch.js): reading a
 * YouTube link's video id, no browser: node tools/chat-test/watch.test.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const src  = fs.readFileSync( path.join( here, "../../client/apps/chat/watch.js" ), "utf8" );
const C    = { S: {}, h: function () {}, T: function ( k ) { return k; } };
vm.runInNewContext( src, { window: { NayiveChat: C }, URL } );

let fails = 0, passes = 0;
function check( name, got, want )
{
    if( got === want ) passes++;
    else { fails++; console.log( "FAIL " + name + "\n  got:  " + JSON.stringify( got ) + "\n  want: " + JSON.stringify( want ) ); }
}

const ID = "dQw4w9WgXcQ";
[
    [ "https://www.youtube.com/watch?v=" + ID, ID ],
    [ "https://youtube.com/watch?v=" + ID + "&t=42s", ID ],
    [ "https://m.youtube.com/watch?feature=share&v=" + ID, ID ],
    [ "https://music.youtube.com/watch?v=" + ID + "&list=RD", ID ],
    [ "https://youtu.be/" + ID + "?si=abc", ID ],
    [ "https://www.youtube.com/shorts/" + ID, ID ],
    [ "https://www.youtube.com/live/" + ID + "?feature=x", ID ],
    [ "https://www.youtube.com/embed/" + ID, ID ],
    [ "https://www.youtube-nocookie.com/embed/" + ID, ID ],
    [ "HTTPS://WWW.YOUTUBE.COM/watch?v=" + ID, ID ],
    [ "https://www.youtube.com/watch?v=short", null ],
    [ "https://www.youtube.com/channel/UCabcdefghijk", null ],
    [ "https://www.youtube.com/@someone", null ],
    [ "https://youtube.com.evil.example/watch?v=" + ID, null ],
    [ "https://evil.example/youtu.be/" + ID, null ],
    [ "https://vimeo.com/12345", null ],
    [ "not a url", null ],
].forEach( function ( c ) { check( "ytId " + c[ 0 ], C.ytId( c[ 0 ] ), c[ 1 ] ); } );

[
    [ "mira esto: https://youtu.be/" + ID + ").", ID ],
    [ "https://example.com y luego https://www.youtube.com/watch?v=" + ID, ID ],
    [ "sin enlaces", null ],
    [ "", null ],
].forEach( function ( c ) { check( "ytIn " + c[ 0 ], C.ytIn( c[ 0 ] ), c[ 1 ] ); } );

console.log( ( fails ? "FAILED " + fails : "OK" ) + " - " + passes + " passed" );
process.exit( fails ? 1 : 0 );
