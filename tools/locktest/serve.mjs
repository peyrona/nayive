/*
 * serve.mjs - a static server over client/apps, on a port the OS picks.
 *
 * The harness page has to be served from the apps root: it loads shared/ the
 * way a real app does, and window.crypto.subtle only exists in a secure
 * context - which 127.0.0.1 is, and a file:// URL is not.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
                ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
                ".png": "image/png", ".woff2": "font/woff2" };

export function serve( root )
{
    const server = http.createServer( ( req, res ) =>
    {
        // No traversal out of the apps root, even from a test.
        const rel  = decodeURIComponent( req.url.split( "?" )[ 0 ] ).replace( /^\/+/, "" );
        const file = path.resolve( root, rel );

        if( ! file.startsWith( path.resolve( root ) ) ) { res.writeHead( 403 ).end(); return; }

        fs.readFile( file, ( err, body ) =>
        {
            if( err ) { res.writeHead( 404 ).end(); return; }
            res.writeHead( 200, { "Content-Type": TYPES[ path.extname( file ) ] || "application/octet-stream" } );
            res.end( body );
        } );
    } );

    return new Promise( resolve =>
        server.listen( 0, "127.0.0.1", () =>
            resolve( { port: server.address().port, close: () => server.close() } ) ) );
}
