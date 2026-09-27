/*
 * serve.mjs - the spike page over HTTP.
 *
 *     node tools/canvas-spike/serve.mjs          then open the printed URL
 *
 * It serves the REPO ROOT, not this folder, for one reason: the page links
 * client/apps/shared/theme.css and app.css, so the spike wears Nayive's own
 * chrome and the toolbar is the real .icon-btn, not a look-alike. A module
 * script needs http:// anyway - file:// refuses ESM imports.
 *
 * No API is faked and no service worker is registered: the spike lives outside
 * client/apps/, so sw.js never claims it and what you see is always the build
 * you just made.
 *
 * /corpus/<name> is his own .docx folder, read-only, so smoke.mjs can feed the
 * page real files by URL instead of by a megabyte-long eval string. Override
 * the folder with CORPUS=/some/where.
 */
import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import url  from 'node:url';

const ROOT   = path.resolve( path.dirname( url.fileURLToPath( import.meta.url ) ), '..', '..' );
const CORPUS = process.env.CORPUS || path.join( process.env.HOME, 'Downloads', 'Telegram Desktop' );
const PORT = Number( process.env.PORT ) || 8099;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
                '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
                '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

http.createServer( ( req, res ) =>
{
    const rel = decodeURIComponent( req.url.split( '?' )[ 0 ] );

    // "/" REDIRECTS, it does not serve. Serving index.html at the root would
    // leave the page's own relative links (spike.js, lib/...) resolving against
    // "/" - the stylesheets are absolute so the page would come up looking
    // right and do nothing at all, which is a horrible way to spend ten minutes.
    if( rel === '/' )
    {
        res.writeHead( 302, { location: '/tools/canvas-spike/index.html' } ).end();
        return;
    }

    // /corpus/ -> his real documents; everything else -> the repo.
    let base = ROOT, sub = path.normalize( rel );
    if( sub.startsWith( '/corpus/' ) ) { base = CORPUS; sub = sub.slice( '/corpus'.length ); }
    else if( sub === '/corpus' )
    {
        const names = fs.readdirSync( CORPUS ).filter( n => n.toLowerCase().endsWith( '.docx' ) ).sort();
        res.writeHead( 200, { 'content-type': 'application/json' } ).end( JSON.stringify( names ) );
        return;
    }

    // Only the apps and the tools: never store/ (live config, keys) or the rest.
    if( base === ROOT && ! sub.startsWith( '/client/apps/' ) && ! sub.startsWith( '/tools/' ) )
    {
        res.writeHead( 403 ).end( 'no' );
        return;
    }

    const file = path.join( base, sub );
    if( !file.startsWith( base ) ) { res.writeHead( 403 ).end( 'no' ); return; }

    fs.readFile( file, ( err, body ) =>
    {
        if( err ) { res.writeHead( 404 ).end( 'not found: ' + rel ); return; }
        res.writeHead( 200, { 'content-type': TYPES[ path.extname( file ) ] || 'application/octet-stream',
                              'cache-control': 'no-store' } );
        res.end( body );
    } );
} )
.listen( PORT, process.env.HOST || '127.0.0.1', () => console.log( `canvas-spike: http://localhost:${ PORT }/` ) );
