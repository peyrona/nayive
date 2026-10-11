// run.mjs - load every app in the three browser engines, PC and phone shape,
// and report any page exception. tools/smoke-test does the same in Chromium
// only; this is the check for "it works here but not in Safari / Firefox".
//
//   cd tools/compat-test && npm install && npx playwright install chromium firefox webkit
//   node tools/compat-test/run.mjs [--engine=chromium|firefox|webkit] [app ...]
//
// Engines: Chromium (Chrome, Edge, Brave, Samsung...), Firefox (Gecko) and
// WebKit (Safari - and every browser on iPhone/iPad). Shapes: "pc" = 1280x800
// with a mouse, "phone" = 390x844 with touch. 3 x 2 = 6 runs per app.
//
// The server is server.mjs's scratch one: the real store/ is never touched.
// Service workers are blocked so the page is always the current code.
// Exits non-zero when any run throws or does not stay on its page.
//
// Dev only: Playwright lives in this folder's node_modules (git-ignored) and
// never reaches the server. WebKit on Linux needs `libavif13` (apt).
import { chromium, firefox, webkit } from "playwright";
import { startServer, signIn, allApps, sleep } from "./server.mjs";

const args    = process.argv.slice( 2 );
const only    = ( args.find( a => a.startsWith( "--engine=" ) ) || "" ).slice( 9 );
const ENGINES = { chromium, firefox, webkit };
const named   = args.filter( a => ! a.startsWith( "--" ) );
const APPS    = named.length ? named : allApps();
const SHAPES  = { pc:    { viewport: { width: 1280, height: 800 } },
                  phone: { viewport: { width: 390,  height: 844 }, hasTouch: true } };

const { base: BASE, stop } = await startServer();

// --- the runs ---------------------------------------------------------------
const failed = [];
try
{
    for( const [ name, engine ] of Object.entries( ENGINES ) )
    {
        if( only && only !== name ) continue;
        let br;
        try { br = await engine.launch(); }
        catch( e ) { console.log( `ERR ${name}: cannot start - ${String( e.message ).split( "\n" )[ 0 ]}` ); failed.push( name ); continue; }

        for( const [ shape, opts ] of Object.entries( SHAPES ) )
        {
            const ctx  = await br.newContext( { ...opts, serviceWorkers: "block", locale: "en-US" } );
            const page = await ctx.newPage();
            let errs = [];
            page.on( "pageerror", e => errs.push( String( e.message || e ).split( "\n" )[ 0 ] ) );

            const st = await signIn( page, BASE );
            if( st !== 200 ) { console.log( `ERR ${name}/${shape}: sign-in failed ${st}` ); failed.push( `${name}/${shape}` ); await ctx.close(); continue; }

            for( const app of [ "", ...APPS ] )
            {
                if( app === "desktop" && shape === "phone" ) continue;   // a phone is sent back to the launcher, by design
                errs = [];
                const want = `/nayive/${app ? app + "/" : ""}`;
                try { await page.goto( BASE + want, { waitUntil: "load", timeout: 20000 } ); }
                catch( e ) { errs.push( "load: " + String( e.message ).split( "\n" )[ 0 ] ); }
                await sleep( app === "write" ? 7000 : 3000 );
                const at   = await page.evaluate( () => location.pathname ).catch( () => "?" );
                const lost = ! at.startsWith( want );
                const tag  = `${name}/${shape} ${app || "launcher"}`;
                if( errs.length || lost ) failed.push( tag );
                console.log( ( errs.length || lost ? "ERR " : "ok  " ) + tag +
                             ( lost ? " @ " + at : "" ) + ( errs.length ? "  " + JSON.stringify( errs ).slice( 0, 400 ) : "" ) );
            }
            await ctx.close();
        }
        await br.close();
    }
}
finally
{
    stop();
}

console.log( failed.length ? `\n${failed.length} FAILED: ${failed.join( ", " )}` : "\nALL ENGINES LOAD CLEAN" );
process.exit( failed.length ? 1 : 0 );
