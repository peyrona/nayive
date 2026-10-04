/*
 * serve.mjs - the smoke test page over HTTP.
 *
 *     CORPUS=<folder of .docx> node tools/docx-editor-smoke/serve.mjs
 *
 * then open the printed URL; ?f=<name> opens one file of the folder.
 *
 *   /                      -> the test page (a redirect, so its relative links work)
 *   /engine/<file>         -> the VENDORED engine, write/lib/docx-editor/ - the
 *                             folder tools/build-docx-editor.sh writes and Write loads
 *   /corpus                -> the .docx names in CORPUS, as JSON
 *   /corpus/<name>         -> one of them, read-only
 *   anything else          -> the repo
 *
 * No service worker and no cache: what runs is always the build on disk.
 * PORT=0 picks a free port; the first line printed says which. It listens on
 * 127.0.0.1 only; HOST=0.0.0.0 opens it to the LAN (a real phone, say).
 */
import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import url  from 'node:url';

const ROOT   = path.resolve( path.dirname( url.fileURLToPath( import.meta.url ) ), '..', '..' );
const APPS   = path.join( ROOT, 'client', 'apps' );
const CORPUS = process.env.CORPUS ? path.resolve( process.env.CORPUS ) : null;
const PORT   = process.env.PORT !== undefined ? Number( process.env.PORT ) : 8097;

const ENGINE = path.join( APPS, 'write', 'lib', 'docx-editor' );

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
                '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
                '.png': 'image/png', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

function send( res, file, base )
{
    if( ! file.startsWith( base + path.sep ) ) { res.writeHead( 403 ).end( 'no' ); return; }
    fs.readFile( file, ( err, body ) =>
    {
        if( err ) { res.writeHead( 404 ).end( 'not found' ); return; }
        res.writeHead( 200, { 'content-type': TYPES[ path.extname( file ) ] || 'application/octet-stream',
                              'cache-control': 'no-store' } );
        res.end( body );
    } );
}

const server = http.createServer( ( req, res ) =>
{
    const rel = path.posix.normalize( decodeURIComponent( req.url.split( '?' )[ 0 ] ) );

    // "/" REDIRECTS rather than serving the page, or its relative links
    // (page.js) would resolve against "/" and nothing would run.
    if( rel === '/' ) { res.writeHead( 302, { location: '/tools/docx-editor-smoke/index.html' } ).end(); return; }

    if( rel.startsWith( '/engine/' ) ) return send( res, path.join( ENGINE, rel.slice( 8 ) ), ENGINE );

    if( rel === '/corpus' || rel.startsWith( '/corpus/' ) )
    {
        if( ! CORPUS ) { res.writeHead( 404 ).end( 'no CORPUS folder given' ); return; }
        if( rel === '/corpus' )
        {
            const names = fs.readdirSync( CORPUS ).filter( n => n.toLowerCase().endsWith( '.docx' ) ).sort();
            res.writeHead( 200, { 'content-type': 'application/json' } ).end( JSON.stringify( names ) );
            return;
        }
        return send( res, path.join( CORPUS, rel.slice( 8 ) ), CORPUS );
    }

    // Only the apps and the tools: never store/ (live config, keys) or the rest,
    // even when HOST opens this to the LAN.
    const sub = path.normalize( rel );
    if( ! sub.startsWith( '/client/apps/' ) && ! sub.startsWith( '/tools/' ) ) { res.writeHead( 403 ).end( 'no' ); return; }

    send( res, path.join( ROOT, sub ), ROOT );
} );

server.listen( PORT, process.env.HOST || '127.0.0.1', () =>
    console.log( `docx-editor-smoke: http://localhost:${ server.address().port }/  (engine: ${ path.relative( ROOT, ENGINE ) })` ) );
