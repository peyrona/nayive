// office-lib.mjs - what the office / image data-safety tests share (not a
// test itself: run.mjs only runs ds-*.mjs).
//
//   xlsx( { a1: "NOW", landscape: true, protect: false } )   a tiny workbook, as a Buffer
//   png( r, g, b )                                           a 2x2 picture, as a Buffer
//   put( s, rel, bytes )                                     a file on disk, an hour old
//   DRAFTS                                                   page expression: the device drafts [{app, name, body}]
//   PW                                                       page helpers: typePassword( pw ), pressConfirm()
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// A stored (uncompressed) zip: enough for the readers, and every byte known.
export function zip( files )
{
    const locals = [], centrals = [];
    let off = 0;
    for( const [ name, text ] of Object.entries( files ) )
    {
        const data = Buffer.from( text );
        const nm   = Buffer.from( name );
        const crc  = zlib.crc32( data );
        const lh = Buffer.alloc( 30 );
        lh.writeUInt32LE( 0x04034b50, 0 ); lh.writeUInt16LE( 20, 4 ); lh.writeUInt16LE( 0, 6 ); lh.writeUInt16LE( 0, 8 );
        lh.writeUInt32LE( 0, 10 ); lh.writeUInt32LE( crc, 14 ); lh.writeUInt32LE( data.length, 18 );
        lh.writeUInt32LE( data.length, 22 ); lh.writeUInt16LE( nm.length, 26 ); lh.writeUInt16LE( 0, 28 );
        const ch = Buffer.alloc( 46 );
        ch.writeUInt32LE( 0x02014b50, 0 ); ch.writeUInt16LE( 20, 4 ); ch.writeUInt16LE( 20, 6 ); ch.writeUInt16LE( 0, 8 );
        ch.writeUInt16LE( 0, 10 ); ch.writeUInt32LE( 0, 12 ); ch.writeUInt32LE( crc, 16 ); ch.writeUInt32LE( data.length, 20 );
        ch.writeUInt32LE( data.length, 24 ); ch.writeUInt16LE( nm.length, 28 ); ch.writeUInt32LE( off, 42 );
        locals.push( lh, nm, data );
        centrals.push( ch, nm );
        off += 30 + nm.length + data.length;
    }
    const cd  = Buffer.concat( centrals );
    const end = Buffer.alloc( 22 );
    end.writeUInt32LE( 0x06054b50, 0 ); end.writeUInt16LE( centrals.length / 2, 8 ); end.writeUInt16LE( centrals.length / 2, 10 );
    end.writeUInt32LE( cd.length, 12 ); end.writeUInt32LE( off, 16 );
    return Buffer.concat( [ ...locals, cd, end ] );
}

// One entry of a zip, as text (stored or deflated); null when it is not there.
export function unzipText( buf, name )
{
    let end = buf.length - 22;
    while( end >= 0 && buf.readUInt32LE( end ) !== 0x06054b50 ) end--;
    if( end < 0 ) return null;
    let at = buf.readUInt32LE( end + 16 );
    const count = buf.readUInt16LE( end + 10 );
    for( let i = 0; i < count; i++ )
    {
        const method = buf.readUInt16LE( at + 10 ), size = buf.readUInt32LE( at + 20 );
        const nl = buf.readUInt16LE( at + 28 ), el = buf.readUInt16LE( at + 30 ), cl = buf.readUInt16LE( at + 32 );
        const local = buf.readUInt32LE( at + 42 );
        if( buf.toString( "utf8", at + 46, at + 46 + nl ) === name )
        {
            const start = local + 30 + buf.readUInt16LE( local + 26 ) + buf.readUInt16LE( local + 28 );
            const data  = buf.subarray( start, start + size );
            return ( method === 8 ? zlib.inflateRawSync( data ) : data ).toString( "utf8" );
        }
        at += 46 + nl + el + cl;
    }
    return null;
}

// The body of the device draft named `name`, as base64 (page expression).
export const DRAFT_B64 = name => `new Promise( function ( res ) {
    var rq = indexedDB.open( 'nayive-drafts', 1 );
    rq.onupgradeneeded = function () { rq.result.createObjectStore( 'drafts', { keyPath: 'app' } ); };
    rq.onerror = function () { res( null ); };
    rq.onsuccess = function () {
        var db = rq.result, g = db.transaction( 'drafts', 'readonly' ).objectStore( 'drafts' ).getAll();
        g.onsuccess = function () {
            var d = g.result.filter( function ( r ) { return r.name === ${JSON.stringify( name )}; } )[ 0 ];
            db.close();
            if( ! d || d.body == null ) { res( null ); return; }
            var b = typeof d.body === 'string' ? new TextEncoder().encode( d.body ) : d.body, s = '';
            for( var i = 0; i < b.length; i++ ) s += String.fromCharCode( b[ i ] );
            res( btoa( s ) );
        };
    } } )`;

const NS = "http://schemas.openxmlformats.org";

// One sheet, A1 = a1. landscape / protect: parts Calc cannot write back
// (codec.js detectLossy: calc.lossyPage, calc.lossyProtection).
export function xlsx( { a1 = "X", landscape = false, protect = false } = {} )
{
    return zip( {
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
        "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${a1}</t></is></c></row></sheetData>` +
            ( protect ? `<sheetProtection sheet="1"/>` : "" ) + ( landscape ? `<pageSetup orientation="landscape"/>` : "" ) + `</worksheet>`
    } );
}

// A 2x2 RGB picture.
export function png( r, g, b )
{
    const crc = buf => { const c = Buffer.alloc( 4 ); c.writeUInt32BE( zlib.crc32( buf ) >>> 0 ); return c; };
    const chunk = ( type, data ) =>
    {
        const len = Buffer.alloc( 4 ); len.writeUInt32BE( data.length );
        const td  = Buffer.concat( [ Buffer.from( type ), data ] );
        return Buffer.concat( [ len, td, crc( td ) ] );
    };
    const ihdr = Buffer.alloc( 13 );
    ihdr.writeUInt32BE( 2, 0 ); ihdr.writeUInt32BE( 2, 4 ); ihdr[ 8 ] = 8; ihdr[ 9 ] = 2;
    const row = Buffer.from( [ 0, r, g, b, r, g, b ] );
    return Buffer.concat( [ Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] ), chunk( "IHDR", ihdr ),
                            chunk( "IDAT", zlib.deflateSync( Buffer.concat( [ row, row ] ) ) ), chunk( "IEND", Buffer.alloc( 0 ) ) ] );
}

// A file straight onto the scratch server's disk, an hour old (a save from
// "earlier"): the editors' If-Unmodified-Since then has room either way.
export function put( s, rel, bytes, user )
{
    const p = path.join( s.home( user ), rel );
    fs.mkdirSync( path.dirname( p ), { recursive: true } );
    fs.writeFileSync( p, bytes );
    const old = new Date( Date.now() - 3600e3 );
    fs.utimesSync( p, old, old );
}

export function bytesOnDisk( s, rel, user )
{
    try { return fs.readFileSync( path.join( s.home( user ), rel ) ); } catch { return null; }
}

// The file's text once `cond( text )` holds (or the last one read, after `ms`).
export async function untilDisk( s, rel, cond, ms = 10000 )
{
    const end = Date.now() + ms;
    for( ;; )
    {
        let t = null;
        try { t = fs.readFileSync( path.join( s.home(), rel ), "utf8" ); } catch {}
        if( cond( t ) || Date.now() > end ) return t;
        await new Promise( r => setTimeout( r, 150 ) );
    }
}

// The device drafts this browser keeps (shared/office.js, "nayive-drafts").
export const DRAFTS = `new Promise( function ( res ) {
    var rq = indexedDB.open( 'nayive-drafts', 1 );
    rq.onupgradeneeded = function () { rq.result.createObjectStore( 'drafts', { keyPath: 'app' } ); };
    rq.onerror = function () { res( [] ); };
    rq.onsuccess = function () {
        var db = rq.result, g = db.transaction( 'drafts', 'readonly' ).objectStore( 'drafts' ).getAll();
        g.onsuccess = function () {
            res( g.result.map( function ( r ) { return { app: r.app, name: r.name,
                body: typeof r.body === 'string' ? r.body : ( r.body ? '[' + r.body.length + ' bytes]' : null ) }; } ) );
            db.close(); };
    } } )`;

// Waits for a device draft whose body holds `text` - or, a function, for
// which it says yes (until() cannot wait on a promise: it would take the
// promise itself for "true").
export async function untilDraft( c, text, ms = 20000 )
{
    const end  = Date.now() + ms;
    const want = typeof text === "function" ? text : d => String( d.body ).indexOf( text ) !== -1;
    for( ;; )
    {
        const list = await c.evaluate( DRAFTS ).catch( () => [] );
        if( list.some( want ) ) return true;
        if( Date.now() > end ) return false;
        await new Promise( r => setTimeout( r, 200 ) );
    }
}

// Page helpers for the shared sheets (shared/ui.js): the password box, and
// the confirm button of whatever question is up. In `w` (a window or a frame's).
export const PW = `( function ( w ) {
    w.__sheet = function () { var s = w.document.querySelector( '.sheet-backdrop.open .sheet' ); return s ? s.textContent : ''; };
    w.__typePassword = async function ( pw ) {
        for( var i = 0; i < 120; i++ ) {
            var one = w.document.getElementById( 'askPw1' );
            if( one && one.closest( '.sheet-backdrop.open' ) ) {
                one.value = pw;
                var two = w.document.getElementById( 'askPw2' ); if( two ) two.value = pw;
                one.closest( '.sheet' ).querySelector( '.sheet-actions button:last-child' ).click();
                return true;
            }
            await new Promise( function ( r ) { setTimeout( r, 50 ); } );
        }
        return false;
    };
    w.__pressConfirm = async function () {
        for( var i = 0; i < 120; i++ ) {
            var s = w.document.querySelector( '.sheet-backdrop.open .sheet' );
            var b = s && s.querySelector( '.sheet-actions button:last-child' );
            if( b ) { b.click(); return true; }
            await new Promise( function ( r ) { setTimeout( r, 50 ); } );
        }
        return false;
    };
    return true;
} )`;
