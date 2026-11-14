// ds-calc-lock.mjs - Calc's locked cells (grid.js LOCKED CELLS, codec.js):
// the lock button locks a cell or a whole column; typing, Delete, removing a
// row and Clear format do not get past it; the file is written as a
// protected sheet (Excel's way: <sheetProtection>, format 0 unlocked, the
// locked cells' format without <protection locked="0">), opens locked
// again, and loses all protection once nothing is locked. A protected sheet
// made by Excel opens with its own locks and goes back with its own tag,
// password included; one with editable ranges still meets the loss gate.
// A protected sheet with nothing locked stays protected, everything unlocked;
// a whole-sheet look equal to the default format writes no <col> per column.
import { server, browser, ok, section, done, click, sleep } from "./lib.mjs";
import { put, xlsx, zip, bytesOnDisk, unzipText, PW } from "./office-lib.mjs";

const NS = "http://schemas.openxmlformats.org";     // the OOXML namespaces' root (office-lib keeps its own)


// An Excel-made protected sheet: every cell locked (format 0) but A2 (format 1), a password.
function excelProtected()
{
    return zip( {
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
        "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SRC</t></is></c></row><row r="2"><c r="A2" s="1" t="inlineStr"><is><t>free</t></is></c></row></sheetData><sheetProtection password="CC3D" sheet="1" objects="1" scenarios="1"/></worksheet>`
    } );
}

// A protected sheet with every cell unlocked (format 0 says locked="0"): a form open to all.
function openProtected()
{
    return zip( {
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
        "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>OPEN</t></is></c></row></sheetData><sheetProtection sheet="1" formatCells="0" insertRows="1"/></worksheet>`
    } );
}

const s = await server();
put( s, "files/lock.xlsx", xlsx( { a1: "SRC" } ) );
put( s, "files/excel.xlsx", excelProtected() );
put( s, "files/open.xlsx", openProtected() );
put( s, "files/plain.xlsx", xlsx( { a1: "PLAIN" } ) );
put( s, "files/ranges.xlsx", xlsx( { a1: "RNG", protect: true } ) );
const c = await browser( s, { mouse: true } );

const G = "( await import('/nayive/calc/grid.js') )";
const A1 = "( function () { var td = document.querySelector('#gridHost .ht_master tbody tr td'); return td ? td.textContent : null; } )()";
const TOLD = key => `( window.__toasts || [] ).some( function ( t ) { return t.indexOf( Ayni.t( '${key}' ) ) !== -1; } )`;
const ev = js => c.evaluate( `( async () => { ${js} } )()` );

async function openSheet( rel, a1 )
{
    await c.open( "/nayive/calc/?file=" + rel, "/nayive/calc/" );
    await c.evaluate( PW + "( window )" );
    const up = await c.until( `document.getElementById('nameBox').value === 'A1' && ${A1} === ${JSON.stringify( a1 )}`, 20000 );
    await ev( `window.__g = ${G}; return true;` );
    await c.watchToasts();
    await c.evaluate( "window.__toasts = [], true" );
    return up;
}
async function savedWhere( rel, before, test, ms = 20000 )
{
    for( let i = 0; i < ms / 200; i++ )
    {
        const now = bytesOnDisk( s, rel );
        if( now && ! now.equals( before ) && test( now ) ) return now;
        await sleep( 200 );
    }
    return null;
}
const sheetXml = b => unzipText( b, "xl/worksheets/sheet1.xml" ) || "";
const stylesXml = b => unzipText( b, "xl/styles.xml" ) || "";
const pressed = () => c.evaluate( "document.getElementById('fmtLockBtn').getAttribute('aria-pressed')" );
const pick = ( r1, c1, r2, c2 ) => c.evaluate( `window.__g.table.selectCell( ${r1}, ${c1}, ${r2}, ${c2} ), true` );
const at = ( r, k ) => c.evaluate( `window.__g.table.getSourceDataAtCell( ${r}, ${k} )` );

try
{
    section( "LOCK, REFUSE, SAVE" );
    ok( await openSheet( "files/lock.xlsx", "SRC" ), "lock.xlsx open" );
    await c.evaluate( "window.__g.table.setDataAtCell( [ [ 1, 1, 'b2' ], [ 2, 2, 'c3' ], [ 4, 3, 'd5' ] ] ), true" );
    await pick( 1, 1, 1, 1 );
    ok( await pressed() === "false", "B2 shows open padlock" );
    await click( c, "#fmtLockBtn" );
    ok( await c.until( "!! ( window.__g.activeSheet.cellStyles.B2 || {} ).locked" ), "B2 locked in the model" );
    ok( await pressed() === "true", "button pressed" );
    await c.evaluate( "window.__g.table.setDataAtCell( 1, 1, 'X' ), true" );
    ok( await at( 1, 1 ) === "b2", "typing into B2 is refused" );
    ok( await c.until( TOLD( "calc.cellLocked" ), 3000 ), "and a toast says so" );
    // A key pressed on it, the way a person types (Handsontable reads the key codes).
    await c.front();
    for( const type of [ "keyDown", "keyUp" ] )
        await c.send( "Input.dispatchKeyEvent", { type, key: "7", text: type === "keyDown" ? "7" : undefined, code: "Digit7", windowsVirtualKeyCode: 55 } );
    await sleep( 300 );
    ok( await c.evaluate( "! window.__g.table.getActiveEditor() || ! window.__g.table.getActiveEditor().isOpened()" ), "a key on B2 opens no editor" );
    for( const type of [ "keyDown", "keyUp" ] )
        await c.send( "Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } );
    await sleep( 300 );
    ok( await at( 1, 1 ) === "b2", "and B2 still holds b2" );
    await c.evaluate( "window.__g.table.setDataAtCell( 2, 2, 'C3!' ), true" );
    ok( await at( 2, 2 ) === "C3!", "C3 still editable" );

    // A whole column (D) from its header.
    await c.evaluate( "window.__g.table.selectColumns( 3 ), true" );
    await sleep( 200 );
    await click( c, "#fmtLockBtn" );
    ok( await c.until( "!! ( window.__g.activeSheet.colStyles[ 3 ] || {} ).locked" ), "column D locked" );
    await c.evaluate( "window.__g.table.setDataAtCell( 4, 3, 'nope' ), true" );
    ok( await at( 4, 3 ) === "d5", "D5 refused" );
    // One cell let free inside the locked column.
    await pick( 5, 3, 5, 3 );
    await click( c, "#fmtLockBtn" );
    await c.evaluate( "window.__g.table.setDataAtCell( 5, 3, 'd6' ), true" );
    ok( await at( 5, 3 ) === "d6" && await pressed() === "false", "D6 unlocked inside the locked column" );
    // Delete key path / sort / remove row.
    await pick( 0, 1, 2, 1 );
    await c.evaluate( "window.__g.table.emptySelectedCells(), true" );
    ok( await at( 1, 1 ) === "b2", "Delete leaves B2" );
    await c.evaluate( "window.__g.table.alter( 'remove_row', 1, 1 ), true" );
    ok( await at( 1, 1 ) === "b2", "removing row 2 refused" );
    // Clear format keeps lock.
    await pick( 1, 1, 1, 1 );
    await click( c, "#fmtBoldBtn" );
    await click( c, "#fmtClearBtn" );
    ok( await c.evaluate( "!! ( window.__g.activeSheet.cellStyles.B2 || {} ).locked && ! window.__g.activeSheet.cellStyles.B2.bold" ), "Clear format kept the lock, dropped bold", await c.evaluate( "JSON.stringify( window.__g.activeSheet.cellStyles.B2 )" ) );
    // Paste over it: the rest of the block lands, B2 does not.
    await c.evaluate( "window.__g.table.populateFromArray( 1, 1, [ [ 'p', 'q' ] ], undefined, undefined, 'CopyPaste.paste' ), true" );
    ok( await at( 1, 1 ) === "b2" && await at( 1, 2 ) === "q", "a paste skips B2, lands on C2" );
    // A sort over its rows is refused.
    await pick( 0, 2, 2, 2 );
    await c.evaluate( "window.__g.sortByColumn( true ), true" );
    ok( await at( 1, 1 ) === "b2" && await at( 2, 2 ) === "C3!" && await at( 1, 2 ) === "q", "a sort over row 2 is refused" );
    // A merge over it is refused, however it is asked for (the context menu's way here).
    await pick( 1, 1, 1, 2 );
    await c.evaluate( "( function () { var t = window.__g.table; t.getPlugin( 'mergeCells' ).toggleMerge( t.getSelectedRangeActive() ); return true; } )()" );
    ok( await c.evaluate( "window.__g.activeSheet.merges.length === 0" ) && await at( 1, 2 ) === "q", "a merge over B2 is refused" );
    // The painter gives B2 a look, not an unlock.
    await pick( 0, 0, 0, 0 );
    await click( c, "#fmtItalicBtn" );
    await click( c, "#fmtPainterBtn" );
    await pick( 1, 1, 1, 1 );
    ok( await c.evaluate( "!! ( window.__g.activeSheet.cellStyles.B2 || {} ).italic && window.__g.activeSheet.cellStyles.B2.locked === true" ), "the painter's look lands on B2, the lock stays", await c.evaluate( "JSON.stringify( window.__g.activeSheet.cellStyles.B2 )" ) );

    const before = bytesOnDisk( s, "files/lock.xlsx" );
    const saved = await savedWhere( "files/lock.xlsx", before, b => /<sheetProtection/.test( sheetXml( b ) ) && /C3!/.test( ( unzipText( b, "xl/sharedStrings.xml" ) || "" ) + sheetXml( b ) ) );
    ok( !! saved, "autosave wrote a protected sheet" );
    const xml  = saved ? sheetXml( saved ) : "";
    const xfs  = saved ? ( ( /<cellXfs[\s\S]*?<\/cellXfs>/.exec( stylesXml( saved ) ) || [ "" ] )[ 0 ].match( /<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g ) || [] ) : [];
    const sOf  = a => { const m = new RegExp( `<c r="${a}"[^>]*\\bs="(\\d+)"` ).exec( xml ); return m ? +m[ 1 ] : 0; };
    const free = n => /<protection locked="0"\/>/.test( xfs[ n ] || "" );
    ok( xfs.length > 1 && free( 0 ), "format 0 is unlocked", xfs[ 0 ] );
    ok( sOf( "B2" ) > 0 && ! free( sOf( "B2" ) ) && sOf( "D5" ) > 0 && ! free( sOf( "D5" ) ), "B2 and D5 carry a locked format", xfs.join( "" ) );
    ok( free( sOf( "C3" ) ), "C3's format is unlocked" );
    ok( /<col min="4" max="4"[^>]*\bstyle="[1-9]/.test( xml ), "column D carries its locked format", xml.slice( 0, 400 ) );

    section( "REOPEN" );
    ok( await openSheet( "files/lock.xlsx", "SRC" ), "reopened" );
    ok( await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 1, 1 )" ), "B2 still locked" );
    ok( await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 400, 3 )" ), "D401 locked (column)" );
    ok( ! await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 2, 2 )" ), "C3 not locked" );
    ok( ! await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 50, 7 )" ), "H51 not locked" );
    ok( ! await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 5, 3 )" ) && await at( 5, 3 ) === "d6", "D6 still free" );

    section( "UNLOCK ALL -> no protection" );
    await pick( 1, 1, 1, 1 ); await click( c, "#fmtLockBtn" );
    await c.evaluate( "window.__g.table.selectColumns( 3 ), true" ); await sleep( 200 ); await click( c, "#fmtLockBtn" );
    ok( ! await c.evaluate( "window.__g.sheetHasLock( window.__g.activeSheet )" ), "no lock left" );
    const b2 = bytesOnDisk( s, "files/lock.xlsx" );
    const s2 = await savedWhere( "files/lock.xlsx", b2, b => ! /<sheetProtection/.test( sheetXml( b ) ) );
    ok( !! s2 && ! /<protection/.test( stylesXml( s2 ) ), "saved without protection", s2 && stylesXml( s2 ) );

    section( "EXCEL-MADE PROTECTED FILE" );
    ok( await openSheet( "files/excel.xlsx", "SRC" ), "excel.xlsx open" );
    ok( ! await c.evaluate( "document.getElementById('lossyBackdrop') && document.getElementById('lossyBackdrop').open" ), "no loss gate" );
    ok( await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 0, 0 )" ), "A1 locked (format 0)" );
    ok( ! await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 1, 0 )" ), "A2 unlocked (its own format)" );
    ok( await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 30, 9 )" ), "J31 locked (empty, format 0)" );
    // A whole row let free in an all-locked sheet.
    await c.evaluate( "window.__g.table.selectRows( 4 ), true" );
    await sleep( 200 );
    await click( c, "#fmtLockBtn" );
    ok( ! await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 4, 9 )" ) && await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 5, 9 )" ), "row 5 unlocked, row 6 still locked" );
    await c.evaluate( "window.__g.table.setDataAtCell( 1, 0, 'free2' ), true" );
    const eb = bytesOnDisk( s, "files/excel.xlsx" );
    const es = await savedWhere( "files/excel.xlsx", eb, b => /free2/.test( ( unzipText( b, "xl/sharedStrings.xml" ) || "" ) + sheetXml( b ) ) );
    ok( !! es && /<sheetProtection password="CC3D" sheet="1" objects="1" scenarios="1"\/>/.test( sheetXml( es ) ), "its own tag (password) kept", es && sheetXml( es ) );
    ok( await openSheet( "files/excel.xlsx", "SRC" ), "reopened" );
    ok( await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 0, 0 ) && ! window.__g.isLocked( window.__g.activeSheet, 1, 0 ) && window.__g.isLocked( window.__g.activeSheet, 30, 9 )" ), "same locks after Calc's save" );
    ok( ! await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 4, 9 )" ) && await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 5, 9 )" ), "row 5 still free, row 6 locked" );

    section( "PROTECTED RANGES -> loss gate" );
    ok( await openSheet( "files/ranges.xlsx", "RNG" ), "ranges.xlsx open" );
    ok( await ev( "return ( await import('/nayive/calc/grid.js') ).doc.lossy.indexOf( 'calc.lossyProtection' ) !== -1;" ), "lossyProtection listed" );

    section( "PROTECTED, NOTHING LOCKED -> stays protected" );
    ok( await openSheet( "files/open.xlsx", "OPEN" ), "open.xlsx open" );
    ok( await c.evaluate( "window.__g.activeSheet.protectKeep === true && ! window.__g.sheetHasLock( window.__g.activeSheet )" ), "read with nothing locked, protection kept in the model" );
    await c.evaluate( "window.__g.table.setDataAtCell( 1, 0, 'typed' ), true" );
    ok( await at( 1, 0 ) === "typed", "A2 can be typed into" );
    const ob = bytesOnDisk( s, "files/open.xlsx" );
    const os = await savedWhere( "files/open.xlsx", ob, b => /typed/.test( ( unzipText( b, "xl/sharedStrings.xml" ) || "" ) + sheetXml( b ) ) );
    const oxf = os ? ( ( /<cellXfs[\s\S]*?<\/cellXfs>/.exec( stylesXml( os ) ) || [ "" ] )[ 0 ].match( /<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g ) || [] ) : [];
    ok( !! os && /<sheetProtection sheet="1" formatCells="0" insertRows="1"\/>/.test( sheetXml( os ) ), "saved with its own tag", os && sheetXml( os ) );
    ok( oxf.length && oxf.every( x => /<protection locked="0"\/>/.test( x ) ), "every format unlocked, format 0 too", oxf.join( "" ) );
    ok( await openSheet( "files/open.xlsx", "OPEN" ), "reopened" );
    ok( ! await c.evaluate( "window.__g.isLocked( window.__g.activeSheet, 0, 0 ) || window.__g.isLocked( window.__g.activeSheet, 1, 0 )" ) && await at( 1, 0 ) === "typed", "still nothing locked" );

    section( "A LINE LOOK = THE DEFAULT FORMAT -> no <col> per column" );
    ok( await openSheet( "files/plain.xlsx", "PLAIN" ), "plain.xlsx open" );
    await c.evaluate( "( function () { var st = { fontFamily: 'Calibri', size: 11 }, cs = window.__g.activeSheet.colStyles; for( var k = 0; k < 16384; k++ ) cs[ k ] = st; return true; } )()" );
    await c.evaluate( "window.__g.table.setDataAtCell( 1, 0, 'look' ), true" );
    const pb = bytesOnDisk( s, "files/plain.xlsx" );
    const ps = await savedWhere( "files/plain.xlsx", pb, b => /look/.test( ( unzipText( b, "xl/sharedStrings.xml" ) || "" ) + sheetXml( b ) ) );
    ok( !! ps && ( sheetXml( ps ).match( /<col /g ) || [] ).length <= 1 && ps.length < 100000, "no column list written for it", ps && [ ps.length, ( sheetXml( ps ).match( /<col /g ) || [] ).length ] );
}
catch( e ) { console.log( e ); ok( false, "threw: " + e.message ); }
finally { await done( c, s ); }
