// lib.mjs - what every tour check shares (the guided tour, NayiveUI.tour in
// shared/ui.js). Each app's file only seeds its data and lists what its own
// steps must light. See README.md.
import fs from "node:fs";
export { server, browser, ok, section, done, sleep, onDisk } from "../data-safety-test/lib.mjs";
export { mouse, key, seed } from "../browser-test/lib.mjs";
import { ok, sleep } from "../data-safety-test/lib.mjs";
import { mouse } from "../browser-test/lib.mjs";

// Screenshots go to $SHOTS/<name>.png when SHOTS is set.
export async function shot( c, name )
{
    if( ! process.env.SHOTS ) return;
    const r = await c.send( "Page.captureScreenshot", { format: "png" } );
    fs.writeFileSync( `${process.env.SHOTS}/${name}.png`, Buffer.from( r.result.data, "base64" ) );
}

// What the tour shows right now, or null when it is not up:
//   n, m     step n of m          text, note, title   the bubble
//   ghost    a dashed ring        centred    nothing to point at
//   tap      the lit button takes the tap      inMenu   the lit thing is a ⋮ row
//   lit      the page element under the ring's centre: id, else class
//   fits     the bubble is wholly on screen
export const state = c => c.evaluate( `( () => { const o = document.querySelector( '.tour-overlay' ); if( ! o ) return null;
    const b = o.querySelector( '.tour-bubble' ), r = o.querySelector( '.tour-ring' ), n = o.querySelector( '.tour-note' );
    const rb = r.getBoundingClientRect(), bb = b.getBoundingClientRect();
    const hit = r.hidden ? null : document.elementsFromPoint( rb.left + rb.width / 2, rb.top + rb.height / 2 ).find( e => ! o.contains( e ) );
    // The lit thing and its parents up to the first button / id: their ids and classes.
    const names = []; for( let e = hit, i = 0; e && i < 5; e = e.parentElement, i++ ) { names.push( e.id || e.getAttribute( 'class' ) || e.tagName ); if( e.id || e.matches( 'button, [aria-selected], .nayive-home-link' ) ) break; }
    const [ a, m ] = o.querySelector( '.tour-count' ).textContent.match( /\\d+/g ).map( Number );
    return { n: a, m, text: b.querySelector( ':scope > p' ).textContent, note: n.hidden ? '' : n.textContent,
             title: o.querySelector( '.tour-head b' ).textContent,
             ghost: r.classList.contains( 'is-ghost' ), centred: r.hidden, tap: o.classList.contains( 'is-tap' ),
             inMenu: !! ( hit && hit.closest( '.item-menu' ) ),
             lit: names.join( ' < ' ),
             fits: bb.left >= 0 && bb.top >= 0 && bb.right <= innerWidth && bb.bottom <= innerHeight && ! b.hidden }; } )()` );

// "?" → the help card → "Ver el tour" (Write / Calc / Text: "?" → the Ayuda
// menu → "Ver el tour"). Resolves once the first bubble is up.
export async function startTour( c )
{
    // No "?" at all (the launcher: its card shows by itself until dismissed): the card.
    if( ! await c.evaluate( "!! document.querySelector( '[data-intro-open]' )" ) )
        await c.evaluate( "NayiveUI.showIntro(); true" );
    // A "?" that fitBar moved into the ⋮: the ⋮, then its row.
    else if( await c.evaluate( "! [ ...document.querySelectorAll( '[data-intro-open]' ) ].some( e => e.getClientRects().length && ! e.closest( '.fit-out' ) )" ) )
    {
        await mouse( c, ( await c.evaluate( "( () => { const q = [ ...document.querySelectorAll( '[data-intro-open]' ) ].find( e => e.closest( '.fit-out' ) ); let h = q; while( h && ! h._fitBar ) h = h.parentElement; return !! h; } )()" ) )
            ? await c.evaluate( "( () => { const q = [ ...document.querySelectorAll( '[data-intro-open]' ) ].find( e => e.closest( '.fit-out' ) ); let h = q; while( h && ! h._fitBar ) h = h.parentElement; const b = h._fitBar.button.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } )()" )
            : ".fit-more" );
        await c.until( "!! document.querySelector( '.item-menu:not([hidden]) .menu-item' )" );
        await mouse( c, await c.evaluate( `( () => { const r = [ ...document.querySelectorAll( '.item-menu:not([hidden]) .menu-item' ) ].find( m => { const q = [ ...document.querySelectorAll( '[data-intro-open]' ) ].find( e => e.closest( '.fit-out' ) ); const l = q && ( q.getAttribute( 'aria-label' ) || q.title || '' ).trim(); return !! l && ( m.textContent.trim() === l || l.indexOf( m.textContent.trim() ) === 0 ); } ); if( ! r ) return null; const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } )()` ) );
    }
    else await mouse( c, "[data-intro-open]" );
    const CARD = ".sheet-backdrop.open .intro-tour", MENU = ".top-menu:not([hidden]) [data-menu=\"tourBtn\"]";
    if( ! await c.until( `!! document.querySelector( '${CARD}' ) || !! document.querySelector( '${MENU}' )` ) ) return false;
    await mouse( c, await c.evaluate( `!! document.querySelector( '${CARD}' )` ) ? CARD : MENU );
    const up = await c.until( "!! document.querySelector( '.tour-overlay .tour-bubble:not([hidden])' )" );
    await sleep( 200 );
    return up;
}

// The tour with steps given right here (no help card), for checking the
// shared parts in any app.
export async function runSteps( c, steps )
{
    await c.evaluate( `NayiveUI.tour( ${steps} ); true` );
    const up = await c.until( "!! document.querySelector( '.tour-overlay .tour-bubble:not([hidden])' )" );
    await sleep( 200 );
    return up;
}

// Siguiente (Terminar on the last step), then waits for the next bubble.
export async function next( c )
{
    await mouse( c, ".tour-overlay .tour-row .text-btn:not(.ghost)" );
    await c.until( "! document.querySelector( '.tour-overlay' ) || ! document.querySelector( '.tour-bubble' ).hidden", 3000 );
    await sleep( 120 );
}

export const tourGone = c => c.until( "! document.querySelector( '.tour-overlay' )", 3000 );

// The whole tour, Siguiente after Siguiente, checking what every step must
// do: the bubble fits the screen and the count moves on by one. `expect`
// (optional) is { [n]: fn( state ) -> true | "why not" } for single steps.
// Returns the states, one per step.
export async function walk( c, label, expect = {} )
{
    const seen = [];
    let st = await state( c );
    for( let guard = 0; st && guard < 40; guard++ )
    {
        seen.push( st );
        ok( st.fits, `${label} ${st.n}/${st.m}: the bubble fits the screen`, st );
        ok( ! st.centred, `${label} ${st.n}/${st.m}: it points at something (a missing button needs a ghost)`, st );
        if( expect[ st.n ] ) { const r = expect[ st.n ]( st ); ok( r === true, `${label} ${st.n}/${st.m}: ${typeof r === "string" ? r : "as expected"}`, st ); }
        await shot( c, `${label}-${st.n}` );
        const n = st.n;
        await next( c );
        st = await state( c );
        if( st ) ok( st.n === n + 1, `${label}: Siguiente goes from ${n} to ${n + 1}`, st );
    }
    ok( seen[ 0 ]?.n === 1, `${label}: starts at step 1` );
    ok( seen.length && seen.at( -1 ).n === seen.at( -1 ).m, `${label}: ends on the last step, then closes` );
    return seen;
}

// Script errors seen by any of these tabs.
export const errors = ( ...tabs ) => tabs.flatMap( t => t.logs ).filter( l => /EXCEPTION/.test( l ) );
