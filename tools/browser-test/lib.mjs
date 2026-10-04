// lib.mjs - what every item-browser check shares: real mouse / keyboard /
// touch input over CDP, on top of the data-safety harness (scratch server,
// signed-in Chromium). See README.md.
import fs from "node:fs";
import path from "node:path";
export { server, browser, ok, section, done, sleep, onDisk } from "../data-safety-test/lib.mjs";
import { sleep } from "../data-safety-test/lib.mjs";

// The centre of the first element matching `sel` (or of the i-th).
export async function where( c, sel, i = 0, dx = null )
{
    return c.evaluate( `( () => { const e = document.querySelectorAll( ${JSON.stringify( sel )} )[ ${i} ]; if( ! e ) return null;
        const b = e.getBoundingClientRect(); return { x: ${dx === null ? "b.left + b.width / 2" : "b.left + " + dx}, y: b.top + b.height / 2 }; } )()` );
}

// A real mouse click. mods: 2 Ctrl, 8 Shift, 4 Meta. button: left / right.
export async function mouse( c, sel, { i = 0, mods = 0, button = "left", count = 1, dx = null } = {} )
{
    const p = typeof sel === "string" ? await where( c, sel, i, dx ) : sel;
    if( ! p ) throw new Error( "mouse: no " + sel );
    await c.send( "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, modifiers: mods } );
    for( let n = 1; n <= count; n++ )
        for( const type of [ "mousePressed", "mouseReleased" ] )
            await c.send( "Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button, buttons: type === "mousePressed" ? ( button === "right" ? 2 : 1 ) : 0, clickCount: n, modifiers: mods } );
    await sleep( 120 );
}

const CODES = { Delete: [ "Delete", 46 ], Escape: [ "Escape", 27 ], Enter: [ "Enter", 13 ], F2: [ "F2", 113 ], ArrowDown: [ "ArrowDown", 40 ],
                ArrowUp: [ "ArrowUp", 38 ], ArrowLeft: [ "ArrowLeft", 37 ], ArrowRight: [ "ArrowRight", 39 ], Tab: [ "Tab", 9 ], " ": [ "Space", 32 ],
                Home: [ "Home", 36 ], End: [ "End", 35 ] };

// One key press on whatever has the focus. key: "a", "Delete", "F2"...
export async function key( c, k, mods = 0 )
{
    const [ code, vk ] = CODES[ k ] || [ "Key" + k.toUpperCase(), k.toUpperCase().charCodeAt( 0 ) ];
    const text = k.length === 1 && ! ( mods & 2 ) && ! ( mods & 4 ) ? k : undefined;
    await c.send( "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, text } );
    await c.send( "Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods } );
    await sleep( 120 );
}

// A finger: a tap, or a press held for `ms`.
export async function finger( c, sel, ms = 60, i = 0 )
{
    const p = typeof sel === "string" ? await where( c, sel, i ) : sel;
    if( ! p ) throw new Error( "finger: no " + sel );
    await c.send( "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ { x: p.x, y: p.y } ] } );
    await sleep( ms );
    await c.send( "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] } );
    await sleep( 250 );
}

// A mouse drag from one element to another, the way the browser starts one.
export async function drag( c, from, to )
{
    return c.evaluate( `( () => {
        const s = document.querySelector( ${JSON.stringify( from )} ), d = document.querySelector( ${JSON.stringify( to )} );
        if( ! s || ! d ) return 'missing';
        const r = d.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const dt = new DataTransfer();
        s.dispatchEvent( new DragEvent( 'dragstart', { bubbles: true, cancelable: true, dataTransfer: dt } ) );
        d.dispatchEvent( new DragEvent( 'dragover',  { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y } ) );
        const lit = d.classList.contains( 'drop-target' );
        d.dispatchEvent( new DragEvent( 'drop',      { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y } ) );
        s.dispatchEvent( new DragEvent( 'dragend',   { bubbles: true, dataTransfer: dt } ) );
        return lit; } )()` );
}

// The menu's rows: [ { act, label, off } ] while it is open, else null.
export async function menuRows( c )
{
    return c.evaluate( `( () => { const m = document.querySelector( '.item-menu' ); if( ! m || m.hidden ) return null;
        return [ ...m.querySelectorAll( '.menu-item' ) ].map( b => ( { act: b.dataset.act || '', label: b.textContent.trim(), off: b.disabled } ) ); } )()` );
}

export function seed( s, files )
{
    for( const [ rel, body ] of Object.entries( files ) )
    {
        const p = path.join( s.home(), rel );
        if( body === null ) { fs.mkdirSync( p, { recursive: true } ); continue; }
        fs.mkdirSync( path.dirname( p ), { recursive: true } );
        fs.writeFileSync( p, body );
    }
}
export const exists = ( s, rel ) => fs.existsSync( path.join( s.home(), rel ) );
