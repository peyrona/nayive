// targets.mjs - find what is too small for a finger, app by app, at phone size.
//
//   node tools/compat-test/targets.mjs [--min=40] [app ...]
//
// A finger pad is ~10 mm, about 40 CSS px; Apple asks 44, Google 48. For every
// control on the screen this probes four points MIN/2 px left, right, above
// and below its centre with elementFromPoint: a control that does not own all
// four is reported. So it measures what the finger really hits - the invisible
// ::before pads of app.css count. Two kinds:
//   SMALL   - a probe lands on nothing: the tap area itself is too small (fix it);
//   crowded - a probe lands on a neighbouring control: each is big enough, but
//             they sit closer than a finger (dense toolbars of 36 px buttons).
// Text fields are left out (a short one still takes a tap well).
//
// The user starts with a copy of the local store/homes/test/ (server.mjs seed),
// so lists have rows; a few apps get a step deeper (OPEN) to reach the rows
// that carry grips. Only what one screen shows is checked: menus and dialogs
// that are closed are not. Exits non-zero when anything is reported.
import { chromium } from "playwright";
import { startServer, signIn, allApps, sleep } from "./server.mjs";

const args  = process.argv.slice( 2 );
const MIN   = +( ( args.find( a => a.startsWith( "--min=" ) ) || "--min=40" ).slice( 6 ) );
const named = args.filter( a => ! a.startsWith( "--" ) );
const APPS  = named.length ? named : allApps().filter( a => a !== "desktop" );   // desktop: never on a phone

// One step deeper where the first screen has no rows to measure.
const OPEN = {
    trips: async page => { await page.locator( ".trip-card, .trip-item, [data-trip-id]" ).first().click( { timeout: 3000 } ).catch( () => {} ); },
    tasks: async page => { await page.locator( ".task-chevron" ).first().click( { timeout: 3000 } ).catch( () => {} ); },
};

const { base, stop } = await startServer( { seed: true } );
let total = 0;
try
{
    const br   = await chromium.launch();
    const ctx  = await br.newContext( { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
                                        deviceScaleFactor: 2, serviceWorkers: "block", locale: "en-US" } );
    const page = await ctx.newPage();
    if( await signIn( page, base ) !== 200 ) throw new Error( "sign-in failed" );

    for( const app of [ "", ...APPS ] )
    {
        await page.goto( base + `/nayive/${app ? app + "/" : ""}`, { waitUntil: "load" } ).catch( () => {} );
        await sleep( app === "write" ? 7000 : 3000 );
        if( OPEN[ app ] ) { await OPEN[ app ]( page ); await sleep( 1500 ); }

        const found = await page.evaluate( async half =>
        {
            const CLICK = 'button, a[href], input:not([type=hidden]), select, summary, label[for], [role=button], ' +
                          '[role=checkbox], [role=switch], [role=tab], [role=menuitem], [onclick], [draggable=true]';
            const TEXT  = 'textarea, [contenteditable=""], [contenteditable=true], input:not([type]), ' +
                          'input[type=text], input[type=search], input[type=email], input[type=password], ' +
                          'input[type=number], input[type=url], input[type=tel], input[type=date], input[type=time]';
            function clickable( el )
            {
                if( el === document.body || el === document.documentElement ) return false;
                if( el.matches( CLICK ) ) return true;
                const c = getComputedStyle( el ).cursor;
                return c === "pointer" || c === "grab";
            }
            function outermost( el )
            {
                for( let p = el.parentElement; p && p !== document.body; p = p.parentElement )
                    if( clickable( p ) ) return false;
                return true;
            }
            function shown( el )
            {
                const r = el.getBoundingClientRect(), cs = getComputedStyle( el );
                return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.pointerEvents !== "none" &&
                       ! el.closest( "[hidden], [inert], [aria-hidden=true]" );
            }
            // What a probe point lands on: "own" (this control, or one that does the
            // same - the app icon and title both go home), "crowded" (a neighbouring
            // control: the two sit too close), or "miss" (nothing: the area is small).
            function probe( el, x, y )
            {
                if( x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ) return "own";   // the screen edge: nothing else there
                const hit = document.elementFromPoint( x, y );
                if( ! hit ) return "miss";
                if( hit === el || el.contains( hit ) ) return "own";
                const other = [ hit, ...ancestors( hit ) ].find( clickable );
                if( other && el.classList.contains( "nayive-home-link" ) && other.classList.contains( "nayive-home-link" ) ) return "own";
                return other ? "crowded" : "miss";
            }
            function ancestors( e ) { const a = []; for( let p = e.parentElement; p && p !== document.body; p = p.parentElement ) a.push( p ); return a; }
            function sig( el )
            {
                const cls = [ ...el.classList ].filter( c => ! /^(open|on|active|sel|selected|is-|has-)/.test( c ) ).slice( 0, 3 );
                return el.tagName.toLowerCase() + ( el.id && ! cls.length ? "#" + el.id : "" ) + cls.map( c => "." + c ).join( "" );
            }

            const groups = new Map();
            const all = [ ...document.querySelectorAll( "body *" ) ].filter( el => clickable( el ) && ! el.matches( TEXT ) && outermost( el ) && shown( el ) );
            for( const el of all.slice( 0, 600 ) )
            {
                let r = el.getBoundingClientRect();
                if( r.top < 0 || r.bottom > innerHeight ) { el.scrollIntoView( { block: "center", inline: "center" } ); r = el.getBoundingClientRect(); }
                if( r.width >= 2 * half && r.height >= 2 * half ) continue;   // big enough on its own
                const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                if( probe( el, cx, cy ) !== "own" ) continue;   // covered by something else: not reachable here
                const p = [ probe( el, cx - half, cy ), probe( el, cx + half, cy ), probe( el, cx, cy - half ), probe( el, cx, cy + half ) ];
                if( p.every( x => x === "own" ) ) continue;
                const k = ( p.includes( "miss" ) ? "SMALL   " : "crowded " ) + sig( el );
                const g = groups.get( k ) || { sig: k, n: 0, w: Math.round( r.width ), h: Math.round( r.height ),
                                               label: ( el.getAttribute( "aria-label" ) || el.title || el.textContent || "" ).trim().slice( 0, 30 ) };
                g.n++;
                groups.set( k, g );
            }
            return [ ...groups.values() ];
        }, MIN / 2 ).catch( e => [ { sig: "PAGE ERROR " + e.message.split( "\n" )[ 0 ], n: 1, w: 0, h: 0, label: "" } ] );

        console.log( `\n== ${app || "launcher"}: ${found.length ? found.length + " small" : "ok"}` );
        for( const g of found.sort( ( a, b ) => a.sig.localeCompare( b.sig ) || Math.min( a.w, a.h ) - Math.min( b.w, b.h ) ) )
            console.log( `   ${String( g.w ).padStart( 3 )}x${String( g.h ).padEnd( 3 )} ${g.n > 1 ? "x" + g.n + " " : ""}${g.sig}  "${g.label}"` );
        total += found.length;
    }
    await br.close();
}
finally { stop(); }

console.log( total ? `\n${total} kinds of small targets` : "\nNO SMALL TARGETS" );
process.exit( total ? 1 : 0 );
